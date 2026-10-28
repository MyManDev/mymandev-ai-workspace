import * as z from "zod";
import {
  actorAllowed,
  envelopeHeaderShape,
  EVENT_TYPES,
  ProtocolEventSchema,
  type ProtocolEvent,
} from "./envelope.ts";
import { EVENT_TYPE_PATTERN, LIMITS, PROTOCOL_VERSION } from "./model.ts";

/** Stage 1: an object whose `protocolVersion` is a non-negative integer. */
const VersionProbeSchema = z.object({
  protocolVersion: z.int().nonnegative(),
});

/**
 * Stage 3: every header field, with a well-formed but not yet known `type`.
 * A `type` over the limit stops validation before the pattern runs (see
 * `displayText`).
 */
const EnvelopeHeaderSchema = z.object({
  ...envelopeHeaderShape,
  type: z
    .string()
    .max(LIMITS.eventType, { abort: true })
    .regex(EVENT_TYPE_PATTERN),
});

const knownTypes: ReadonlySet<string> = new Set(EVENT_TYPES);

export type DecodeErrorCode =
  | "malformed"
  | "unsupported_version"
  | "unknown_type"
  | "invalid_payload"
  | "invalid_actor";

export type DecodeResult =
  { ok: true; event: ProtocolEvent } | { ok: false; code: DecodeErrorCode };

/**
 * Decodes untrusted input in stages. Unknown fields are stripped at every
 * level; the input is never returned or mutated. A device uses it for events
 * that the server sends. The server uses `decodeClientEvent` instead.
 */
export function decodeEvent(input: unknown): DecodeResult {
  const probe = VersionProbeSchema.safeParse(input);
  if (!probe.success) {
    return { ok: false, code: "malformed" };
  }
  if (probe.data.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, code: "unsupported_version" };
  }
  const header = EnvelopeHeaderSchema.safeParse(input);
  if (!header.success) {
    return { ok: false, code: "malformed" };
  }
  if (!knownTypes.has(header.data.type)) {
    return { ok: false, code: "unknown_type" };
  }
  const event = ProtocolEventSchema.safeParse(input);
  if (!event.success) {
    return { ok: false, code: "invalid_payload" };
  }
  if (!actorAllowed(event.data)) {
    return { ok: false, code: "invalid_actor" };
  }
  return { ok: true, event: event.data };
}

declare const unverified: unique symbol;

/**
 * An event that a device sent. It is well-formed, but its actor, device and
 * referenced IDs are not yet bound to the authenticated connection. Only the
 * server's identity binding (M2) produces an event that may be relayed or
 * stored. Never cast it to `ProtocolEvent` or to a verified type.
 */
export type UnverifiedEvent = ProtocolEvent & { readonly [unverified]: true };

export type ClientDecodeErrorCode = DecodeErrorCode | "not_allowed_from_device";

export type ClientDecodeResult =
  | { ok: true; event: UnverifiedEvent }
  | { ok: false; code: ClientDecodeErrorCode };

/** Decodes an event that a device sent. Rejects what only the server may originate. */
export function decodeClientEvent(input: unknown): ClientDecodeResult {
  const result = decodeEvent(input);
  if (!result.ok) {
    return result;
  }
  const { event } = result;
  if (event.actor.kind === "system" || event.deviceId === null) {
    return { ok: false, code: "not_allowed_from_device" };
  }
  // Creating a run is a server command (M2); a device never sends null -> queued.
  if (
    event.type === "agent.run.state_changed" &&
    event.payload.previousState === null
  ) {
    return { ok: false, code: "not_allowed_from_device" };
  }
  return { ok: true, event: event as UnverifiedEvent };
}

/**
 * Sets zod's `jitless` option. It does not affect the protocol schemas: zod
 * reads the option when a schema is created, not when it parses, and this
 * package creates all of its schemas when it is evaluated, before a consumer
 * can call this function. To validate the protocol schemas without code
 * generation, for example in a renderer under a strict Content Security
 * Policy, set `z.config({ jitless: true })` before this package is evaluated,
 * as the package README describes. Whether this function stays is open
 * (ADR 0003).
 */
export function enableJitlessValidation(): void {
  z.config({ jitless: true });
}
