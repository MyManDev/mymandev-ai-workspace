import {
  type Database,
  isActiveMember,
  markDeviceSeen,
  writeConnectionAudit,
} from "@mymandev/database";
import {
  type AuthChallengeFrame,
  type AuthOkFrame,
  type AuthResponseFrame,
  type ConnectionId,
  decodeClientEvent,
  decodeClientFrame,
  type DeviceId,
  MAX_AUTH_FRAME_BYTES,
  newId,
  PROTOCOL_VERSION,
  type ProtocolEvent,
  type ServerOnlyEventType,
  SIGN_IN_LIFETIME_MS,
  type UnverifiedEvent,
  type UserId,
  WS_AUTH_TIMEOUT_MS,
  WS_CLOSE_CODES,
  type WsCloseReason,
} from "@mymandev/protocol";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preValidationHookHandler,
} from "fastify";
import type { RawData, WebSocket } from "ws";
import { randomToken } from "./auth/attempts.ts";
import { verifyDeviceSignature } from "./auth/device-keys.ts";
import { ADDRESS_LIMIT } from "./auth/device-routes.ts";
import { type DeviceRow, deviceRow, stateOf } from "./auth/device-state.ts";
import { WindowLimiter } from "./auth/tokens.ts";
import { ApiError } from "./errors.ts";

/**
 * WebSocket close codes of RFC 6455 (section 7.4.1) that the gateway uses
 * after authentication. The codes of authentication come from
 * `WS_CLOSE_CODES` of the protocol.
 */
export const CloseCode = {
  /** The server is shutting down. Reason `server_shutdown`. */
  goingAway: 1001,
  /** A binary frame. Reason `binary_not_supported`. */
  unsupportedData: 1003,
  /** A text frame that is not JSON. Reason `invalid_json`. */
  invalidFramePayload: 1007,
  /**
   * A frame that is not a valid event from a device, or an event that
   * identity binding refused. The reason is the decode or rejection code.
   */
  policyViolation: 1008,
  /** A frame over the size limit. Sent by the WebSocket library. */
  messageTooBig: 1009,
  /** The server failed, for example the database. Reason `internal_error`. */
  internalError: 1011,
} as const;

/** The only path that accepts a WebSocket upgrade. */
export const GATEWAY_PATH = "/ws";

/** At most this many connections wait for authentication at once (ADR 0014, "Limits"). */
export const MAX_UNAUTHENTICATED_CONNECTIONS = 200;

/**
 * How long a connection that is refused before authentication, or that timed
 * out, may take for the closing handshake before its socket is terminated.
 * Without it, the WebSocket library waits up to 30 seconds and the
 * connection keeps its place among the unauthenticated ones.
 */
export const REFUSED_CLOSE_GRACE_MS = 1_000;

/**
 * The longest time an unauthenticated connection holds its place: the
 * authentication timeout and the closing grace. The 429 above the cap sends
 * it as `Retry-After`.
 */
export const UNAUTHENTICATED_PLACE_SECONDS = Math.ceil(
  (WS_AUTH_TIMEOUT_MS + REFUSED_CLOSE_GRACE_MS) / 1000,
);

/** At most one audit record of each kind per device in this time (ADR 0014). */
export const CONNECTION_AUDIT_WINDOW_MS = 60 * 60_000;

/** The user and the device that a connection's key proved. */
export type ConnectionIdentity = Readonly<{
  userId: UserId;
  deviceId: DeviceId;
}>;

/**
 * The context of a connection after `auth.ok`. Its identity is never null,
 * and only this type reaches `bindIdentity` and the event handler (ADR 0014,
 * "Device key and authentication"). The gateway freezes it.
 */
export type AuthenticatedConnectionContext = Readonly<{
  /** Sent in `auth.challenge` and signed by the device; identifies the connection in logs. */
  connectionId: ConnectionId;
  identity: ConnectionIdentity;
  /**
   * The device's last GitHub sign-in when the connection authenticated, in
   * milliseconds since the epoch. A newer sign-in replaces the key that
   * signed, and the connection stops being accepted.
   */
  signedInAt: number;
}>;

declare const verified: unique symbol;

/**
 * An event that `bindIdentity` bound to its authenticated connection: its
 * device and its user are the connection's, the device and the account may
 * still act, and the user is an active member of the event's workspace. A
 * second brand next to `UnverifiedEvent`, defined here and never in the
 * protocol (ADR 0006). Only `bindIdentity` creates it; never cast to it
 * anywhere else.
 * The reference binding of an agent actor, its run, and its project (ADR
 * 0006) arrives with #27 and #28, before anything relays a VerifiedEvent.
 */
export type VerifiedEvent = Exclude<
  ProtocolEvent,
  { type: ServerOnlyEventType }
> & { readonly [verified]: true };

/**
 * Receives every event that passed identity binding, with its authenticated
 * connection. The gateway awaits it before the connection's next event; a
 * failure closes the connection with 1011.
 */
export type EventHandler = (
  event: VerifiedEvent,
  context: AuthenticatedConnectionContext,
) => void | Promise<void>;

/**
 * Why a device row no longer accepts a connection, as its close reason: a
 * revoked device; a newer sign-in, whose new key replaced the key that
 * signed; a disabled account; a sign-out or a GitHub revocation after the
 * sign-in.
 */
export type ConnectionRefusal = Extract<
  WsCloseReason,
  "device_revoked" | "key_replaced" | "auth_failed" | "sign_in_required"
>;

/**
 * Why the device's current row refuses a connection that authenticated with
 * the key of the sign-in at `signedInAt`, or null when it may act. The
 * server rejects the previous key from the commit of a new sign-in on (ADR
 * 0014). With `now`, the 30-day sign-in counts too, as at authentication.
 * Without it, as for every event, the expiry is left to the sweep, which
 * allows an open connection 24 hours more: `stateOf` is then evaluated at
 * the sign-in itself, where the sign-in has not expired.
 */
export function refusalOf(
  row: DeviceRow | undefined,
  signedInAt: number,
  now: number | null,
): ConnectionRefusal | null {
  if (row === undefined || row.revokedAt !== null) {
    return "device_revoked";
  }
  if (row.lastSignInAt.getTime() !== signedInAt) {
    return "key_replaced";
  }
  const state = stateOf(row, now ?? signedInAt);
  switch (state.state) {
    case "revoked":
      return "device_revoked";
    case "disabled":
      return "auth_failed";
    case "sign_in_required":
      return "sign_in_required";
    case "ok":
      return null;
  }
}

/**
 * Allows one audit record per device per window and counts the occurrences
 * in the same window that are only logged (ADR 0014: a replaced connection
 * is audited at most once per device per hour). A device's count is dropped
 * when its window ends.
 */
export class AuditThrottle {
  readonly #limiter: WindowLimiter;
  readonly #windows = new Map<DeviceId, { start: number; unaudited: number }>();
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(windowMs: number, now: () => number) {
    this.#limiter = new WindowLimiter(1, windowMs, now);
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Devices whose window is open. */
  get size(): number {
    return this.#windows.size;
  }

  /**
   * Counts one occurrence. Returns 0 when it is the first of its window and
   * is audited; otherwise the number of occurrences in this window that were
   * not audited, this one included.
   */
  take(deviceId: DeviceId): number {
    this.sweep();
    if (this.#limiter.hit(deviceId) === 0) {
      this.#windows.set(deviceId, { start: this.#now(), unaudited: 0 });
      return 0;
    }
    const window = this.#windows.get(deviceId) ?? {
      start: this.#now(),
      unaudited: 0,
    };
    window.unaudited += 1;
    this.#windows.set(deviceId, window);
    return window.unaudited;
  }

  /** Drops the windows that ended, with their counts. */
  sweep(): void {
    const now = this.#now();
    this.#limiter.sweep();
    for (const [deviceId, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) {
        this.#windows.delete(deviceId);
      }
    }
  }
}

/** Why `bindIdentity` refused an event. */
export type IdentityRejectionCode =
  /** The event names another device, or a `user` actor names another user. Audited. */
  | "identity_mismatch"
  /** The connection's user is not an active member of the event's workspace. */
  | "not_a_member"
  /** The device or the account may no longer act; the code is the close reason. */
  | ConnectionRefusal;

export type BindIdentityResult =
  | { ok: true; event: VerifiedEvent }
  | { ok: false; code: IdentityRejectionCode };

export type BindIdentityDependencies = Readonly<{
  database: Database;
  now: () => number;
  /** Limits the `event.identity_mismatch` audit records per device. */
  mismatchAudits: AuditThrottle;
  log: FastifyBaseLogger;
}>;

/**
 * Binds an event that a device sent to its authenticated connection (ADR
 * 0006, identity binding; ADR 0014). `deviceId`, and for a `user` actor
 * `actor.userId`, must be the connection's: a mismatch is refused and
 * audited as `event.identity_mismatch`, at most once per device per hour,
 * and never overwritten. Every event also needs a device row that still
 * accepts the connection (`refusalOf`, without the 30-day expiry) and a user
 * who is an active member of `event.workspaceId` at this moment. The audit
 * record names the event ID as its subject and no workspace, because the
 * event's workspace is unverified.
 */
export async function bindIdentity(
  event: UnverifiedEvent,
  context: AuthenticatedConnectionContext,
  dependencies: BindIdentityDependencies,
): Promise<BindIdentityResult> {
  const { userId, deviceId } = context.identity;
  if (
    event.deviceId !== deviceId ||
    (event.actor.kind === "user" && event.actor.userId !== userId)
  ) {
    const unaudited = dependencies.mismatchAudits.take(deviceId);
    dependencies.log.info(
      unaudited === 0 ? {} : { unauditedMismatches: unaudited },
      "identity mismatch",
    );
    if (unaudited === 0) {
      await writeConnectionAudit(dependencies.database, {
        action: "event.identity_mismatch",
        userId,
        deviceId,
        subjectId: event.id,
        now: new Date(dependencies.now()),
      });
    }
    return { ok: false, code: "identity_mismatch" };
  }
  const device = await deviceRow(dependencies.database, deviceId);
  const refusal = refusalOf(device, context.signedInAt, null);
  if (refusal !== null) {
    return { ok: false, code: refusal };
  }
  const member = await isActiveMember(dependencies.database, {
    workspaceId: event.workspaceId,
    userId,
  });
  if (!member) {
    return { ok: false, code: "not_a_member" };
  }
  // The one place that turns an event into a VerifiedEvent (ADR 0006).
  return { ok: true, event: event as unknown as VerifiedEvent };
}

/** Closes a socket with a close code of the protocol; the reason is the code's key. */
function closeWith(socket: WebSocket, reason: WsCloseReason): void {
  socket.close(WS_CLOSE_CODES[reason], reason);
}

type LiveConnection = Readonly<{
  socket: WebSocket;
  context: AuthenticatedConnectionContext;
}>;

/**
 * The open connections of this API instance (ADR 0014, "Revocation,
 * sign-out, and recovery"): the unauthenticated ones, counted for their cap,
 * and one live connection per device.
 */
export class ConnectionRegistry {
  readonly #pending = new Set<WebSocket>();
  readonly #live = new Map<DeviceId, LiveConnection>();
  readonly #ids = new WeakMap<WebSocket, ConnectionId>();

  /** Connections that have not authenticated yet. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Authenticated connections, at most one per device. */
  get liveCount(): number {
    return this.#live.size;
  }

  /** Counts a new connection until it authenticates or closes. */
  addPending(socket: WebSocket, connectionId: ConnectionId): void {
    this.#pending.add(socket);
    this.#ids.set(socket, connectionId);
  }

  /** The connection ID of a socket of the gateway, for its logs. */
  connectionIdOf(socket: WebSocket): ConnectionId | null {
    return this.#ids.get(socket) ?? null;
  }

  /**
   * Makes a connection that just authenticated the live connection of its
   * device. An older connection of the device closes with
   * `connection_replaced`; its context is returned.
   */
  register(
    socket: WebSocket,
    context: AuthenticatedConnectionContext,
  ): AuthenticatedConnectionContext | null {
    this.#pending.delete(socket);
    const deviceId = context.identity.deviceId;
    const previous = this.#live.get(deviceId);
    this.#live.set(deviceId, Object.freeze({ socket, context }));
    if (previous === undefined) {
      return null;
    }
    closeWith(previous.socket, "connection_replaced");
    return previous.context;
  }

  /**
   * Forgets a connection that closed or was refused. A connection that a
   * newer one replaced is already gone, so the newer one stays.
   */
  remove(
    socket: WebSocket,
    context: AuthenticatedConnectionContext | null,
  ): void {
    this.#pending.delete(socket);
    if (
      context !== null &&
      this.#live.get(context.identity.deviceId)?.socket === socket
    ) {
      this.#live.delete(context.identity.deviceId);
    }
  }

  /** The live connection of a device, or null. */
  connectionOf(deviceId: DeviceId): AuthenticatedConnectionContext | null {
    return this.#live.get(deviceId)?.context ?? null;
  }

  /**
   * Closes the live connection of a device with a close reason of the
   * protocol, for example `device_revoked` after a revocation commits or
   * `sign_in_required` after a sign-out. Returns whether one was open.
   */
  closeDevice(deviceId: DeviceId, reason: WsCloseReason): boolean {
    const live = this.#live.get(deviceId);
    if (live === undefined) {
      return false;
    }
    this.#live.delete(deviceId);
    closeWith(live.socket, reason);
    return true;
  }

  /**
   * Closes the live connections of every device of an account, for example
   * with `sign_in_required` after GitHub reported a revocation. Returns how
   * many were open.
   */
  closeUser(userId: UserId, reason: WsCloseReason): number {
    let closed = 0;
    for (const [deviceId, live] of this.#live) {
      if (live.context.identity.userId === userId) {
        this.#live.delete(deviceId);
        closeWith(live.socket, reason);
        closed += 1;
      }
    }
    return closed;
  }
}

/** Error codes of what a client did on its socket, not failures of the server. */
const CLIENT_SOCKET_ERROR = /^(?:WS_ERR_[A-Z_]+|ECONNRESET|EPIPE)$/u;

/**
 * The error handler of the WebSocket plugin. The WebSocket library reports
 * what a client sent wrong, for example a frame over the size limit, as an
 * error after it has sent its close frame; that is logged at debug level,
 * anything else at error level, both with the connection ID. The socket is
 * terminated, as the plugin's default does.
 */
export function socketErrorHandler(connections: ConnectionRegistry) {
  return (error: Error, socket: WebSocket, request: FastifyRequest): void => {
    const code = (error as Error & { code?: unknown }).code;
    const fields = {
      err: error,
      connectionId: connections.connectionIdOf(socket) ?? undefined,
    };
    if (typeof code === "string" && CLIENT_SOCKET_ERROR.test(code)) {
      request.log.debug(fields, "connection error");
    } else {
      request.log.error(fields, "connection error");
    }
    socket.terminate();
  };
}

/**
 * Refuses a WebSocket handshake from a browser origin that is not listed.
 * Browsers send Origin on every WebSocket handshake and apply no same-origin
 * rule to WebSocket; Node and the Electron main process send no Origin.
 */
export function originGuard(allowedOrigins: readonly string[]) {
  const allowed: ReadonlySet<string> = new Set(allowedOrigins);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) {
      return reply.code(403).send({
        statusCode: 403,
        error: "Forbidden",
        message: "Forbidden",
        code: "forbidden",
      });
    }
  };
}

/**
 * Refuses a handshake with 429 `rate_limited` while the cap of
 * unauthenticated connections is reached, before the upgrade: no socket,
 * timer, or nonce is created. A place frees up at most 11 seconds later
 * (`UNAUTHENTICATED_PLACE_SECONDS`): a waiting connection authenticates, or
 * times out after 10 seconds and is terminated 1 second after its close
 * frame. This is a callback hook, not an async one: after `done()`, Fastify
 * runs the upgrade and the handler that counts the new connection in the
 * same synchronous step, so two handshakes can never both take the last
 * place.
 */
function capGuard(connections: ConnectionRegistry): preValidationHookHandler {
  return (request, _reply, done) => {
    if (
      request.ws &&
      connections.pendingCount >= MAX_UNAUTHENTICATED_CONNECTIONS
    ) {
      done(
        new ApiError("rate_limited", {
          retryAfterSeconds: UNAUTHENTICATED_PLACE_SECONDS,
        }),
      );
      return;
    }
    done();
  };
}

/** The size of a frame as it arrived, before it is decoded. */
function frameBytes(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, part) => total + part.length, 0);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  return data.length;
}

function frameToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

export type GatewayOptions = Readonly<{
  allowedOrigins: readonly string[];
  /** The API's public origin: the audience of the `ws` signature. */
  publicOrigin: string;
  database: Database;
  now: () => number;
  connections: ConnectionRegistry;
  onEvent: EventHandler;
}>;

/**
 * Registers the WebSocket gateway on `GET /ws` (ADR 0009, ADR 0014). A
 * connection first authenticates with its device key: the server sends
 * `auth.challenge`, the device answers with exactly one `auth.response`, and
 * the server sends `auth.ok`. Before that, no frame reaches the event
 * decoder or `onEvent`. Afterwards every text frame must be one JSON event
 * that `decodeClientEvent` accepts and `bindIdentity` binds to the
 * connection; events go to `onEvent` one after another, in the order they
 * arrived. Anything else closes the connection. No authentication frame,
 * nonce, or signature is logged.
 */
export function registerGateway(
  app: FastifyInstance,
  options: GatewayOptions,
): void {
  const { connections, database, now, publicOrigin } = options;
  const replacementAudits = new AuditThrottle(CONNECTION_AUDIT_WINDOW_MS, now);
  const mismatchAudits = new AuditThrottle(CONNECTION_AUDIT_WINDOW_MS, now);

  /** Audits a replacement at most once per device per hour and logs the rest with a count. */
  async function recordReplacement(
    context: AuthenticatedConnectionContext,
    replaced: AuthenticatedConnectionContext,
    log: FastifyBaseLogger,
  ): Promise<void> {
    const { userId, deviceId } = context.identity;
    const unaudited = replacementAudits.take(deviceId);
    log.info(
      {
        replacedConnectionId: replaced.connectionId,
        ...(unaudited === 0 ? {} : { unauditedReplacements: unaudited }),
      },
      "connection replaced",
    );
    if (unaudited > 0) {
      return;
    }
    try {
      await writeConnectionAudit(database, {
        action: "connection.replaced",
        userId,
        deviceId,
        subjectId: deviceId,
        now: new Date(now()),
      });
    } catch (error) {
      log.error({ err: error }, "audit record failed");
    }
  }

  app.get(
    GATEWAY_PATH,
    {
      websocket: true,
      // The HEAD route that Fastify adds for every GET route would call this
      // handler with (request, reply) and fail with a 500.
      exposeHeadRoute: false,
      // The same per-address limit as the other routes before a verified
      // signature (P-63).
      config: { rateLimit: ADDRESS_LIMIT },
      preValidation: [
        originGuard(options.allowedOrigins),
        capGuard(connections),
      ],
    },
    (socket: WebSocket, request) => {
      const connectionId = newId<ConnectionId>();
      const log = request.log.child({ connectionId });
      /**
       * `challenged` until the one frame before authentication arrives,
       * `verifying` while its signature and device are checked, and
       * `authenticated` from `auth.ok` on.
       */
      let phase: "challenged" | "verifying" | "authenticated" = "challenged";
      const challengeNonce = randomToken();
      /** The challenge's nonce, until `auth.response` takes it: it is used once. */
      let nonce: string | null = challengeNonce;
      /** Set when the connection registers, just before `auth.ok`. */
      let context: AuthenticatedConnectionContext | null = null;
      /** Events are handled one after another, in the order they arrived. */
      let queue: Promise<void> = Promise.resolve();
      let queued = 0;
      let terminateTimer: ReturnType<typeof setTimeout> | undefined;

      const open = () => socket.readyState === socket.OPEN;

      /**
       * Ends the closing handshake of an unauthenticated connection after a
       * short grace, so that it frees its place among the unauthenticated
       * ones within seconds instead of the library's 30.
       */
      function terminateSoon(): void {
        if (terminateTimer === undefined) {
          terminateTimer = setTimeout(
            () => socket.terminate(),
            REFUSED_CLOSE_GRACE_MS,
          );
          terminateTimer.unref();
        }
      }

      /** Closes before authentication succeeded and logs only the code. */
      function refuse(reason: WsCloseReason, detail?: string): void {
        if (reason === "protocol_violation") {
          log.debug({ code: reason, detail }, "connection refused");
        } else {
          log.info({ code: reason }, "connection refused");
        }
        closeWith(socket, reason);
        terminateSoon();
      }

      /** A failure of the server, for example of the database or the event handler. */
      function fail(error: unknown): void {
        log.error({ err: error }, "connection failed");
        if (open()) {
          socket.close(CloseCode.internalError, "internal_error");
          if (phase !== "authenticated") {
            terminateSoon();
          }
        }
      }

      connections.addPending(socket, connectionId);
      const timer = setTimeout(() => {
        if (context === null && open()) {
          refuse("auth_timeout");
        }
      }, WS_AUTH_TIMEOUT_MS);

      socket.on("close", () => {
        clearTimeout(timer);
        clearTimeout(terminateTimer);
        nonce = null;
        connections.remove(socket, context);
      });

      /**
       * Verifies the signature first and the device state second, registers
       * the connection, and checks the device again before `auth.ok`.
       */
      async function authenticate(frame: AuthResponseFrame): Promise<void> {
        const challenge = nonce;
        nonce = null;
        if (challenge === null) {
          return;
        }
        const deviceId = frame.deviceId;
        const row = await deviceRow(database, deviceId);
        if (!open()) {
          return;
        }
        if (
          row === undefined ||
          !verifyDeviceSignature(
            row.publicKey,
            {
              purpose: "ws",
              audience: publicOrigin,
              nonce: challenge,
              deviceId,
              connectionId,
            },
            frame.signature,
          )
        ) {
          refuse("auth_failed");
          return;
        }
        const signedInAt = row.lastSignInAt.getTime();
        const at = now();
        const refusal = refusalOf(row, signedInAt, at);
        if (refusal !== null) {
          refuse(refusal);
          return;
        }
        await markDeviceSeen(database, { deviceId, now: new Date(at) });
        if (!open()) {
          return;
        }
        clearTimeout(timer);
        const authenticated: AuthenticatedConnectionContext = Object.freeze({
          connectionId,
          identity: Object.freeze({ userId: row.userId, deviceId }),
          signedInAt,
        });
        context = authenticated;
        const replaced = connections.register(socket, authenticated);
        if (replaced !== null) {
          await recordReplacement(authenticated, replaced, log);
        }
        // A revocation, sign-out, new sign-in, or disable that committed
        // before the registration shows here; one that commits later finds
        // the connection in the registry.
        const current = await deviceRow(database, deviceId);
        if (!open()) {
          return;
        }
        const late = refusalOf(current, signedInAt, now());
        if (late !== null) {
          connections.remove(socket, authenticated);
          context = null;
          refuse(late);
          return;
        }
        phase = "authenticated";
        const ok: AuthOkFrame = {
          protocolVersion: PROTOCOL_VERSION,
          type: "auth.ok",
          userId: row.userId,
          deviceId,
          signInExpiresAt: new Date(
            signedInAt + SIGN_IN_LIFETIME_MS,
          ).toISOString(),
        };
        socket.send(JSON.stringify(ok));
        log.info({ userId: row.userId, deviceId }, "connection authenticated");
      }

      /** The one frame before authentication: exactly one `auth.response`. */
      function onFirstFrame(data: RawData, isBinary: boolean): void {
        if (isBinary) {
          refuse("protocol_violation", "binary");
          return;
        }
        // Measured on the raw frame, before the JSON is parsed.
        if (frameBytes(data) > MAX_AUTH_FRAME_BYTES) {
          refuse("protocol_violation", "too_large");
          return;
        }
        let input: unknown;
        try {
          input = JSON.parse(frameToText(data));
        } catch {
          refuse("protocol_violation", "invalid_json");
          return;
        }
        const decoded = decodeClientFrame(input);
        if (!decoded.ok) {
          refuse("protocol_violation", decoded.code);
          return;
        }
        if (decoded.frame.type !== "auth.response") {
          refuse("protocol_violation", "unexpected_frame");
          return;
        }
        phase = "verifying";
        void authenticate(decoded.frame).catch(fail);
      }

      /** One frame after `auth.ok`: an event from the device. */
      async function onEventFrame(
        data: RawData,
        isBinary: boolean,
      ): Promise<void> {
        const current = context;
        if (!open() || current === null) {
          return;
        }
        if (isBinary) {
          socket.close(CloseCode.unsupportedData, "binary_not_supported");
          return;
        }
        let input: unknown;
        try {
          input = JSON.parse(frameToText(data));
        } catch {
          socket.close(CloseCode.invalidFramePayload, "invalid_json");
          return;
        }
        const decoded = decodeClientEvent(input);
        if (!decoded.ok) {
          log.debug({ code: decoded.code }, "event rejected");
          socket.close(CloseCode.policyViolation, decoded.code);
          return;
        }
        const bound = await bindIdentity(decoded.event, current, {
          database,
          now,
          mismatchAudits,
          log,
        });
        // A connection that closed or was replaced meanwhile delivers nothing.
        if (!open()) {
          return;
        }
        if (!bound.ok) {
          log.debug({ code: bound.code }, "event rejected");
          switch (bound.code) {
            case "identity_mismatch":
            case "not_a_member":
              socket.close(CloseCode.policyViolation, bound.code);
              return;
            default:
              closeWith(socket, bound.code);
              return;
          }
        }
        await options.onEvent(bound.event, current);
      }

      socket.on("message", (data, isBinary) => {
        // After a close was requested, ignore frames that arrived in the same read.
        if (!open()) {
          return;
        }
        switch (phase) {
          case "challenged":
            onFirstFrame(data, isBinary);
            return;
          case "verifying":
            refuse("protocol_violation", "second_frame");
            return;
          case "authenticated":
            // Reading pauses while events wait, so a fast sender cannot
            // queue without bound.
            queued += 1;
            socket.pause();
            queue = queue
              .then(() => onEventFrame(data, isBinary))
              .catch(fail)
              .finally(() => {
                queued -= 1;
                if (queued === 0) {
                  socket.resume();
                }
              });
            return;
        }
      });

      const challenge: AuthChallengeFrame = {
        protocolVersion: PROTOCOL_VERSION,
        type: "auth.challenge",
        nonce: challengeNonce,
        connectionId,
      };
      socket.send(JSON.stringify(challenge));
    },
  );
}
