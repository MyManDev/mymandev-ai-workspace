import * as z from "zod";
import {
  Base64Url32BytesSchema,
  DeviceListItemSchema,
  DeviceRevocationReasonSchema,
  DeviceSignatureSchema,
  OwnershipOfferEndReasonSchema,
} from "./account.ts";
import {
  decodeClientEvent,
  decodeEvent,
  type ClientDecodeErrorCode,
  type DecodeErrorCode,
  type UnverifiedEvent,
} from "./decode.ts";
import { UtcTimestampSchema } from "./entities.ts";
import {
  CLIENT_ONLY_EVENT_TYPES,
  type ClientOnlyEventType,
  type ProtocolEvent,
} from "./envelope.ts";
import {
  ConnectionIdSchema,
  DeviceIdSchema,
  MemberIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "./ids.ts";
import { OwnershipOfferSchema } from "./membership-api.ts";
import {
  EVENT_TYPE_PATTERN,
  FRAME_TYPE_PATTERN,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  PRESENCE_STATUSES,
  PROTOCOL_VERSION,
  WORKSPACE_SUBSCRIBE_REFUSAL_CODES,
  WORKSPACE_UNSUBSCRIBE_REASONS,
} from "./model.ts";
import { privatePattern } from "./private-pattern.ts";

// The frame layer (ADR 0014, "Protocol"): WebSocket messages that are not
// events. A frame has a two-part `type`, an event a three-part one, so one
// field tells them apart. Frames are never stored, and the server never
// relays a frame that a device sent; it sends only frames of its own.

/**
 * Before authentication succeeds, a frame over this size closes the
 * connection with `protocol_violation`. The server measures the raw frame,
 * before it parses the JSON; the decoders below see parsed values and cannot
 * check it.
 */
export const MAX_AUTH_FRAME_BYTES = 1024;

/**
 * After authentication, the largest frame that the server accepts: 64 KiB,
 * measured on the raw frame. The WebSocket library closes the connection
 * with 1009 above it. The largest `chat.message.send` that `JSON.stringify`
 * writes stays below it (see the README).
 */
export const MAX_FRAME_BYTES = 64 * 1024;

/**
 * The time from the upgrade to `auth.response` (ADR 0014, "Lifetimes"). A
 * connection that has not authenticated by then closes with `auth_timeout`.
 */
export const WS_AUTH_TIMEOUT_MS = 10_000;

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

// Workspace subscriptions and presence (#110). After `auth.ok` a connection
// receives a workspace's events and presence only while it is subscribed to
// that workspace, and only while its account is an active member of it. The
// server answers each `workspace.subscribe` and `workspace.unsubscribe` in
// the order they arrived. No frame names a device: presence is per person.

export const PresenceStatusSchema = z.enum(PRESENCE_STATUSES);
export const WorkspaceSubscribeRefusalCodeSchema = z.enum(
  WORKSPACE_SUBSCRIBE_REFUSAL_CODES,
);
export const WorkspaceUnsubscribeReasonSchema = z.enum(
  WORKSPACE_UNSUBSCRIBE_REASONS,
);

/**
 * The device asks for a workspace's events and presence. Subscribing again
 * keeps one subscription and gets a fresh `workspace.subscribed`, also when
 * the connection holds as many subscriptions as the server allows.
 */
export const WorkspaceSubscribeFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("workspace.subscribe"),
  workspaceId: WorkspaceIdSchema,
});
export type WorkspaceSubscribeFrame = z.infer<
  typeof WorkspaceSubscribeFrameSchema
>;

/**
 * The device no longer wants a workspace's events. The server answers with
 * `workspace.unsubscribed` also when the connection was not subscribed, so
 * the answer says nothing about the workspace.
 */
export const WorkspaceUnsubscribeFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("workspace.unsubscribe"),
  workspaceId: WorkspaceIdSchema,
});
export type WorkspaceUnsubscribeFrame = z.infer<
  typeof WorkspaceUnsubscribeFrameSchema
>;

/**
 * The subscription is live. `onlineMemberIds` is the presence snapshot: the
 * people who are online, the subscriber's own person included; everyone
 * else is offline. `presence.changed` reports every later change.
 * Events are not replayed. After this frame the device reloads the workspace
 * over HTTP and buffers the workspace's events until the reload answers,
 * then applies the buffered events in order on top of the reloaded state.
 * An event that the reloaded state already contains changes nothing,
 * because every event sets the state it reports and chat messages are
 * deduplicated by message ID. Applying the reloaded state over events that
 * arrived first would lose them, because the HTTP answer carries no event
 * IDs. Presence comes only over the connection and applies at once.
 */
export const WorkspaceSubscribedFrameSchema = z
  .object({
    ...frameHeaderShape,
    type: z.literal("workspace.subscribed"),
    workspaceId: WorkspaceIdSchema,
    onlineMemberIds: z.array(MemberIdSchema).max(MAX_ANSWER_LIST_ITEMS),
  })
  .superRefine((frame, ctx) => {
    if (new Set(frame.onlineMemberIds).size !== frame.onlineMemberIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "A person is listed once",
        path: ["onlineMemberIds"],
      });
    }
  });
export type WorkspaceSubscribedFrame = z.infer<
  typeof WorkspaceSubscribedFrameSchema
>;

/**
 * The server refused `workspace.subscribe`. An unknown workspace and one
 * that the account is not an active member of get the same `not_found`.
 */
export const WorkspaceSubscribeRefusedFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("workspace.subscribe_refused"),
  workspaceId: WorkspaceIdSchema,
  code: WorkspaceSubscribeRefusalCodeSchema,
});
export type WorkspaceSubscribeRefusedFrame = z.infer<
  typeof WorkspaceSubscribeRefusedFrameSchema
>;

/**
 * The subscription ended: the device asked (`requested`), or the account's
 * person was removed or left (`membership_ended`), in which case
 * `account.removed_from_workspace` also reaches the account.
 */
export const WorkspaceUnsubscribedFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("workspace.unsubscribed"),
  workspaceId: WorkspaceIdSchema,
  reason: WorkspaceUnsubscribeReasonSchema,
});
export type WorkspaceUnsubscribedFrame = z.infer<
  typeof WorkspaceUnsubscribedFrameSchema
>;

/**
 * A person of a subscribed workspace came online or went offline. Sent only
 * when the person's status changes, not for each of their devices.
 */
export const PresenceChangedFrameSchema = z.object({
  ...frameHeaderShape,
  type: z.literal("presence.changed"),
  workspaceId: WorkspaceIdSchema,
  memberId: MemberIdSchema,
  status: PresenceStatusSchema,
});
export type PresenceChangedFrame = z.infer<typeof PresenceChangedFrameSchema>;

/** Every frame that the server sends. */
export const ServerFrameSchema = z.discriminatedUnion("type", [
  AuthChallengeFrameSchema,
  AuthOkFrameSchema,
  AccountDeviceRegisteredFrameSchema,
  AccountDeviceRevokedFrameSchema,
  AccountRemovedFromWorkspaceFrameSchema,
  AccountOwnershipOfferedFrameSchema,
  AccountOwnershipOfferEndedFrameSchema,
  WorkspaceSubscribedFrameSchema,
  WorkspaceSubscribeRefusedFrameSchema,
  WorkspaceUnsubscribedFrameSchema,
  PresenceChangedFrameSchema,
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/**
 * The frames that a device sends after `auth.ok`. Before it, `auth.response`
 * is the only frame a device may send.
 */
export const AuthenticatedClientFrameSchema = z.discriminatedUnion("type", [
  WorkspaceSubscribeFrameSchema,
  WorkspaceUnsubscribeFrameSchema,
]);
export type AuthenticatedClientFrame = z.infer<
  typeof AuthenticatedClientFrameSchema
>;

/** Every frame that a device sends. */
export const ClientFrameSchema = z.discriminatedUnion("type", [
  AuthResponseFrameSchema,
  ...AuthenticatedClientFrameSchema.options,
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

/**
 * The checks of a client frame's `type` that hold in both phases: a frame
 * type, not one that only the server sends, and a known one.
 */
function clientFrameType(
  type: string,
): { ok: true } | { ok: false; code: ClientFrameDecodeErrorCode } {
  if (!framePattern.test(type)) {
    return { ok: false, code: "malformed" };
  }
  if (serverFrameTypes.has(type)) {
    return { ok: false, code: "not_allowed_from_device" };
  }
  if (!clientFrameTypes.has(type)) {
    return { ok: false, code: "unknown_type" };
  }
  return { ok: true };
}

/**
 * `unexpected_frame`: a frame that a device may send, but not now. Before
 * `auth.ok` that is every frame other than `auth.response`; after it,
 * `auth.response`.
 */
export type ClientFrameDecodeErrorCode =
  | Exclude<DecodeErrorCode, "invalid_actor">
  | "not_allowed_from_device"
  | "unexpected_frame";

export type ClientFrameDecodeResult =
  | { ok: true; frame: AuthResponseFrame }
  | { ok: false; code: ClientFrameDecodeErrorCode };

/**
 * Decodes the frame that a device sends before authentication succeeds:
 * `auth.response`, and nothing else. An event, or any other message, is not
 * a client frame. Unknown fields are stripped; the input is never returned
 * or mutated.
 */
export function decodeClientFrame(input: unknown): ClientFrameDecodeResult {
  const header = probe(input);
  if (!header.ok) {
    return header;
  }
  const known = clientFrameType(header.type);
  if (!known.ok) {
    return known;
  }
  if (header.type !== "auth.response") {
    return { ok: false, code: "unexpected_frame" };
  }
  const frame = AuthResponseFrameSchema.safeParse(input);
  if (!frame.success) {
    return { ok: false, code: "invalid_payload" };
  }
  return { ok: true, frame: frame.data };
}

export type ClientMessageDecodeErrorCode =
  ClientDecodeErrorCode | "unexpected_frame";

export type ClientMessageDecodeResult =
  | { ok: true; kind: "event"; event: UnverifiedEvent }
  | { ok: true; kind: "frame"; frame: AuthenticatedClientFrame }
  | { ok: false; code: ClientMessageDecodeErrorCode };

/**
 * Decodes a message that a device sends after `auth.ok`: an event, with the
 * rules of `decodeClientEvent`, or a frame other than `auth.response`. The
 * event stays an `UnverifiedEvent` until the server's identity binding has
 * bound it to the connection. Unknown fields are stripped; the input is
 * never returned or mutated.
 */
export function decodeClientMessage(input: unknown): ClientMessageDecodeResult {
  const header = probe(input);
  if (!header.ok) {
    return header;
  }
  if (eventPattern.test(header.type)) {
    const result = decodeClientEvent(input);
    return result.ok
      ? { ok: true, kind: "event", event: result.event }
      : result;
  }
  const known = clientFrameType(header.type);
  if (!known.ok) {
    return known;
  }
  if (header.type === "auth.response") {
    return { ok: false, code: "unexpected_frame" };
  }
  const frame = AuthenticatedClientFrameSchema.safeParse(input);
  if (!frame.success) {
    return { ok: false, code: "invalid_payload" };
  }
  return { ok: true, kind: "frame", frame: frame.data };
}

const clientOnlyEventTypes: ReadonlySet<string> = new Set(
  CLIENT_ONLY_EVENT_TYPES,
);

function isClientOnlyEvent(
  event: ProtocolEvent,
): event is Extract<ProtocolEvent, { type: ClientOnlyEventType }> {
  return clientOnlyEventTypes.has(event.type);
}

/** An event that the server sends: never one of `CLIENT_ONLY_EVENT_TYPES`. */
export type ServerEvent = Exclude<ProtocolEvent, { type: ClientOnlyEventType }>;

export type ServerMessageDecodeResult =
  | { ok: true; kind: "event"; event: ServerEvent }
  | { ok: true; kind: "frame"; frame: ServerFrame }
  | { ok: false; code: DecodeErrorCode };

/**
 * Decodes a message that the server sent: an event or a server frame. A
 * device uses it; the server decodes with `decodeClientFrame` before
 * authentication and with `decodeClientMessage` after it. An event or a
 * frame that only a device sends, such as `chat.message.send` or
 * `auth.response`, is `unknown_type` here.
 */
export function decodeServerMessage(input: unknown): ServerMessageDecodeResult {
  const header = probe(input);
  if (!header.ok) {
    return header;
  }
  if (eventPattern.test(header.type)) {
    // Refused by its type, before its fields are checked, as a frame is.
    if (clientOnlyEventTypes.has(header.type)) {
      return { ok: false, code: "unknown_type" };
    }
    const result = decodeEvent(input);
    if (!result.ok) {
      return result;
    }
    // Never true after the check above; it narrows the type.
    if (isClientOnlyEvent(result.event)) {
      return { ok: false, code: "unknown_type" };
    }
    return { ok: true, kind: "event", event: result.event };
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
