import * as z from "zod";
import {
  Base64Url32BytesSchema,
  DeviceListItemSchema,
  DeviceRevocationReasonSchema,
  DeviceSignatureSchema,
  OwnershipOfferEndReasonSchema,
} from "./account.ts";
import { decodeEvent, type DecodeErrorCode } from "./decode.ts";
import { UtcTimestampSchema } from "./entities.ts";
import type { ProtocolEvent } from "./envelope.ts";
import {
  ConnectionIdSchema,
  DeviceIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "./ids.ts";
import { OwnershipOfferSchema } from "./membership-api.ts";
import {
  EVENT_TYPE_PATTERN,
  FRAME_TYPE_PATTERN,
  LIMITS,
  PROTOCOL_VERSION,
} from "./model.ts";
import { privatePattern } from "./private-pattern.ts";

// The frame layer (ADR 0014, "Protocol"): WebSocket messages that are not
// events. A frame has a two-part `type`, an event a three-part one, so one
// field tells them apart. Frames are never stored or relayed to other
// accounts.

/**
 * Before authentication succeeds, a frame over this size closes the
 * connection. The server measures the raw frame, before it parses the JSON;
 * the decoders below see parsed values and cannot check it. Which close code
 * a refused frame gets is decided with the gateway (#89).
 */
export const MAX_AUTH_FRAME_BYTES = 1024;

const frameHeaderShape = Object.freeze({
  protocolVersion: z.literal(PROTOCOL_VERSION),
});

/**
 * The server's first frame on a new connection. The device signs the nonce
 * and the connection ID with the purpose `ws` (see `deviceAuthInput`).
 */
export const AuthChallengeFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("auth.challenge"),
  nonce: Base64Url32BytesSchema,
  connectionId: ConnectionIdSchema,
});
export type AuthChallengeFrame = z.infer<typeof AuthChallengeFrameSchema>;

/** The device's only frame, sent once, before authentication succeeds. */
export const AuthResponseFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("auth.response"),
  deviceId: DeviceIdSchema,
  signature: DeviceSignatureSchema,
});
export type AuthResponseFrame = z.infer<typeof AuthResponseFrameSchema>;

/** Authentication succeeded; events may flow from now on. */
export const AuthOkFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("auth.ok"),
  userId: UserIdSchema,
  deviceId: DeviceIdSchema,
  /** 30 days after the device's last sign-in. */
  signInExpiresAt: UtcTimestampSchema,
});
export type AuthOkFrame = z.infer<typeof AuthOkFrameSchema>;

// Account frames go only to the connections of the account they concern. A
// device belongs to an account, not to a workspace, so they never use the
// event envelope and never reach other members. They reach only open
// connections, so after `auth.ok` the desktop reads its devices and
// workspaces over HTTP and never relies on a frame it may have missed.

/** Another device of the account registered. */
export const AccountDeviceRegisteredFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("account.device_registered"),
  /** Never the receiving device. */
  device: DeviceListItemSchema.extend({
    revokedAt: z.null(),
    current: z.literal(false),
  }),
});
export type AccountDeviceRegisteredFrame = z.infer<
  typeof AccountDeviceRegisteredFrameSchema
>;

/**
 * A device of the account was revoked. The revoked device itself is not told
 * with this frame: its connection closes with `device_revoked`.
 */
export const AccountDeviceRevokedFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("account.device_revoked"),
  deviceId: DeviceIdSchema,
  reason: DeviceRevocationReasonSchema,
  revokedAt: UtcTimestampSchema,
});
export type AccountDeviceRevokedFrame = z.infer<
  typeof AccountDeviceRevokedFrameSchema
>;

/**
 * The account's person was removed from a workspace, or left it. The desktop
 * stops the local execution of that workspace's agents.
 */
export const AccountRemovedFromWorkspaceFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("account.removed_from_workspace"),
  workspaceId: WorkspaceIdSchema,
  removedAt: UtcTimestampSchema,
});
export type AccountRemovedFromWorkspaceFrame = z.infer<
  typeof AccountRemovedFromWorkspaceFrameSchema
>;

/** The owner of a workspace offered its ownership to the account's person. */
export const AccountOwnershipOfferedFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("account.ownership_offered"),
  workspaceId: WorkspaceIdSchema,
  offer: OwnershipOfferSchema,
});
export type AccountOwnershipOfferedFrame = z.infer<
  typeof AccountOwnershipOfferedFrameSchema
>;

/**
 * The ownership offer to the account's person ended without a transfer, so
 * the desktop stops showing it. A transfer is reported by the
 * `workspace.ownership.transferred` event instead.
 */
export const AccountOwnershipOfferEndedFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("account.ownership_offer_ended"),
  workspaceId: WorkspaceIdSchema,
  reason: OwnershipOfferEndReasonSchema,
  endedAt: UtcTimestampSchema,
});
export type AccountOwnershipOfferEndedFrame = z.infer<
  typeof AccountOwnershipOfferEndedFrameSchema
>;

/** Every frame that the server sends. */
export const ServerFrameSchema = z.discriminatedUnion("type", [
  AuthChallengeFrameSchema,
  AuthOkFrameSchema,
  AccountDeviceRegisteredFrameSchema,
  AccountDeviceRevokedFrameSchema,
  AccountRemovedFromWorkspaceFrameSchema,
  AccountOwnershipOfferedFrameSchema,
  AccountOwnershipOfferEndedFrameSchema,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/** Every frame that a device sends: only `auth.response`. */
export const ClientFrameSchema = z.discriminatedUnion("type", [
  AuthResponseFrameSchema,
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export type FrameType = ServerFrame["type"] | ClientFrame["type"];

export const SERVER_FRAME_TYPES: readonly ServerFrame["type"][] = Object.freeze(
  ServerFrameSchema.options.map((schema) => schema.shape.type.value),
);

export const CLIENT_FRAME_TYPES: readonly ClientFrame["type"][] = Object.freeze(
  ClientFrameSchema.options.map((schema) => schema.shape.type.value),
);

const serverFrameTypes: ReadonlySet<string> = new Set(SERVER_FRAME_TYPES);
const clientFrameTypes: ReadonlySet<string> = new Set(CLIENT_FRAME_TYPES);
const framePattern = privatePattern(FRAME_TYPE_PATTERN);
const eventPattern = privatePattern(EVENT_TYPE_PATTERN);

const VersionProbeSchema = z.object({
  protocolVersion: z.int().nonnegative(),
});

/** A `type` over the limit stops validation before a pattern runs. */
const TypeProbeSchema = z.object({
  type: z.string().max(LIMITS.eventType, { abort: true }),
});

/** The `type` of a message of this protocol version, or a decode error. */
function probe(
  input: unknown,
):
  | { ok: true; type: string }
  | { ok: false; code: "malformed" | "unsupported_version" } {
  const version = VersionProbeSchema.safeParse(input);
  if (!version.success) {
    return { ok: false, code: "malformed" };
  }
  if (version.data.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, code: "unsupported_version" };
  }
  const type = TypeProbeSchema.safeParse(input);
  if (!type.success) {
    return { ok: false, code: "malformed" };
  }
  return { ok: true, type: type.data.type };
}

export type ClientFrameDecodeErrorCode =
  Exclude<DecodeErrorCode, "invalid_actor"> | "not_allowed_from_device";

export type ClientFrameDecodeResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; code: ClientFrameDecodeErrorCode };

/**
 * Decodes the frame that a device sends before authentication succeeds. An
 * event, or any other message, is not a client frame. Unknown fields are
 * stripped; the input is never returned or mutated.
 */
export function decodeClientFrame(input: unknown): ClientFrameDecodeResult {
  const header = probe(input);
  if (!header.ok) {
    return header;
  }
  if (!framePattern.test(header.type)) {
    return { ok: false, code: "malformed" };
  }
  if (serverFrameTypes.has(header.type)) {
    return { ok: false, code: "not_allowed_from_device" };
  }
  if (!clientFrameTypes.has(header.type)) {
    return { ok: false, code: "unknown_type" };
  }
  const frame = ClientFrameSchema.safeParse(input);
  if (!frame.success) {
    return { ok: false, code: "invalid_payload" };
  }
  return { ok: true, frame: frame.data };
}

export type ServerMessageDecodeResult =
  | { ok: true; kind: "event"; event: ProtocolEvent }
  | { ok: true; kind: "frame"; frame: ServerFrame }
  | { ok: false; code: DecodeErrorCode };

/**
 * Decodes a message that the server sent: an event or a server frame. A
 * device uses it; the server decodes with `decodeClientFrame` before
 * authentication and with `decodeClientEvent` after it.
 */
export function decodeServerMessage(input: unknown): ServerMessageDecodeResult {
  const header = probe(input);
  if (!header.ok) {
    return header;
  }
  if (eventPattern.test(header.type)) {
    const result = decodeEvent(input);
    return result.ok
      ? { ok: true, kind: "event", event: result.event }
      : result;
  }
  if (!framePattern.test(header.type)) {
    return { ok: false, code: "malformed" };
  }
  if (!serverFrameTypes.has(header.type)) {
    return { ok: false, code: "unknown_type" };
  }
  const frame = ServerFrameSchema.safeParse(input);
  if (!frame.success) {
    return { ok: false, code: "invalid_payload" };
  }
  return { ok: true, kind: "frame", frame: frame.data };
}
