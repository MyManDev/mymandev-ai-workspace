import {
  activePeopleOf,
  activePersonOf,
  type Database,
  deviceRow,
  deviceRows,
  isActiveMember,
  markDeviceSeen,
  markDevicesSeen,
  writeConnectionAudit,
} from "@mymandev/database";
import {
  type AuthChallengeFrame,
  type AuthenticatedClientFrame,
  type AuthOkFrame,
  type AuthResponseFrame,
  type ConnectionId,
  decodeClientFrame,
  decodeClientMessage,
  type DeviceId,
  MAX_ANSWER_LIST_ITEMS,
  MAX_AUTH_FRAME_BYTES,
  type MemberId,
  newId,
  type PresenceChangedFrame,
  type PresenceStatus,
  PROTOCOL_VERSION,
  type ProtocolEvent,
  type ServerEvent,
  type ServerFrame,
  type ServerOnlyEventType,
  SIGN_IN_GRACE_MS,
  SIGN_IN_LIFETIME_MS,
  type UnverifiedEvent,
  type UserId,
  type WorkspaceId,
  type WorkspaceSubscribeRefusalCode,
  type WorkspaceUnsubscribedFrame,
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
import { lockDeviceRow } from "./auth/authenticate.ts";
import { verifyDeviceSignature } from "./auth/device-keys.ts";
import { ADDRESS_LIMIT } from "./auth/device-routes.ts";
import { type DeviceRow, stateOf } from "./auth/device-state.ts";
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
   * A frame that is not a valid event or frame from a device, or an event
   * that identity binding refused. The reason is the decode or rejection
   * code.
   */
  policyViolation: 1008,
  /** A frame over the size limit. Sent by the WebSocket library. */
  messageTooBig: 1009,
  /**
   * More than `MAX_BUFFERED_BYTES` wait to be sent to the connection, so it
   * reads too slowly. Reason `backpressure`; the device reconnects later.
   */
  tryAgainLater: 1013,
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

/** How often the sweep re-checks the devices of the live connections (ADR 0014). */
export const CONNECTION_SWEEP_INTERVAL_MS = 60_000;

/**
 * The sweep writes `devices.last_seen_at` of an open connection's device at
 * most this often; `auth.ok` writes it first.
 */
export const LAST_SEEN_INTERVAL_MS = 5 * 60_000;

/**
 * At most this many workspace subscriptions per connection (#110); the next
 * `workspace.subscribe` gets `too_many_subscriptions`. The protocol leaves
 * the cap to the server, which tunes it with use (P-64). An account creates
 * at most 10 workspaces a day, and a desktop subscribes to the workspaces it
 * shows, so 50 leaves room without letting one connection fan out without
 * bound.
 */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 50;

/**
 * How often a subscribe checks the membership again when a removal in the
 * same workspace was processed during its check (#110). After the last
 * check is stale too, the subscribe is refused with `not_found`; the device
 * may subscribe again.
 */
export const MAX_SUBSCRIBE_RECHECKS = 3;

/**
 * The gateway pings every authenticated connection this often, and
 * terminates one that did not answer the previous ping with a pong, so that
 * a half-open connection ends within two intervals and its person goes
 * offline.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * A connection with more than this many bytes waiting to be sent reads too
 * slowly: instead of queueing more, the server closes it with 1013 and
 * `backpressure`.
 */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

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
 * The reference binding of what an event names (ADR 0006) belongs to the
 * handler of its type, inside the transaction that stores it: a
 * `chat.message.send` stores nothing unless its project is in the event's
 * workspace (#27, `postChatMessage`). The binding of an agent actor, its
 * run, and its project arrives with #28.
 */
export type VerifiedEvent = Exclude<
  ProtocolEvent,
  { type: ServerOnlyEventType }
> & { readonly [verified]: true };

/**
 * What an event handler returns when it found, inside the transaction that
 * would have stored the event, what identity binding refuses: the account is
 * no longer an active member of the event's workspace, or the device or the
 * account may no longer act. The gateway then closes the connection as it
 * does after `bindIdentity`. An identity mismatch is never found there,
 * because identity binding checks it first and audits it.
 */
export type EventRejection = Readonly<{
  rejected: Exclude<IdentityRejectionCode, "identity_mismatch">;
}>;

/**
 * Receives every event that passed identity binding, with its authenticated
 * connection. The gateway awaits it before the connection's next event; a
 * returned `EventRejection` closes the connection, and a failure closes it
 * with 1011.
 */
export type EventHandler = (
  event: VerifiedEvent,
  context: AuthenticatedConnectionContext,
) => void | EventRejection | Promise<void | EventRejection>;

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
 * 0014). With `now`, the 30-day sign-in counts too, as at authentication;
 * the sweep passes the time 24 hours ago (`SIGN_IN_GRACE_MS`), which allows
 * an open connection 24 hours more. Without it, as for every event, the
 * expiry is left to the sweep: `stateOf` is then evaluated at the sign-in
 * itself, where the sign-in has not expired.
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

/**
 * Locks the account and the device of a connection until the transaction
 * ends (`lockDeviceRow`, in the order of `lockActor`) and returns why they
 * no longer accept the connection, or null, as `bindIdentity` checks them:
 * without the 30-day expiry, which the sweep checks. A handler that stores
 * an event calls it first in its transaction, so that a revocation, a
 * sign-out, a new sign-in, or a disable that commits after identity binding
 * stores nothing.
 */
export async function lockConnection(
  tx: Database,
  context: AuthenticatedConnectionContext,
): Promise<ConnectionRefusal | null> {
  return refusalOf(
    await lockDeviceRow(tx, context.identity),
    context.signedInAt,
    null,
  );
}

/** Closes a socket with a close code of the protocol; the reason is the code's key. */
function closeWith(socket: WebSocket, reason: WsCloseReason): void {
  socket.close(WS_CLOSE_CODES[reason], reason);
}

/**
 * The frames that go to an account's own connections (ADR 0014). They never
 * use the event envelope and never reach another account.
 */
export type AccountFrame = Extract<ServerFrame, { type: `account.${string}` }>;

/**
 * A connection's subscription to a workspace (#110): the connection, the
 * workspace, and the account's active person there when it subscribed. The
 * registry keeps one frozen record per connection and workspace and replaces
 * it on every new subscribe, so a check that read the database before the
 * newest subscribe ends nothing (`endSubscription`).
 */
export type Subscription = Readonly<{
  context: AuthenticatedConnectionContext;
  workspaceId: WorkspaceId;
  memberId: MemberId;
}>;

type LiveConnection = {
  readonly socket: WebSocket;
  readonly context: AuthenticatedConnectionContext;
  /** When `devices.last_seen_at` was last written for it: at `auth.ok`, then by the sweep. */
  seenAt: number;
  /** Whether it got `auth.ok`; only then does it receive account frames. */
  confirmed: boolean;
  /** Its workspace subscriptions, at most `MAX_SUBSCRIPTIONS_PER_CONNECTION`. */
  readonly subscriptions: Map<WorkspaceId, Subscription>;
  /** Whether it answered the last ping with a pong, or got none yet. */
  answered: boolean;
};

function isOpen(live: LiveConnection): boolean {
  return live.socket.readyState === live.socket.OPEN;
}

/**
 * A subscribe's membership check of a workspace while it runs.
 * `endMembership` marks the checks of its own workspace stale, so that only
 * they check again.
 */
export type MembershipCheck = {
  readonly workspaceId: WorkspaceId;
  stale: boolean;
};

export type ConnectionRegistryOptions = Readonly<{
  /** Logs the connections that the registry closes on its own, for backpressure. */
  log?: FastifyBaseLogger;
}>;

/** A live connection as `ConnectionRegistry.live` lists it, without its socket. */
export type LiveConnectionView = Readonly<{
  context: AuthenticatedConnectionContext;
  /** When `devices.last_seen_at` was last written for it. */
  seenAt: number;
}>;

/**
 * The open connections of this API instance (ADR 0014, "Revocation,
 * sign-out, and recovery"): the unauthenticated ones, counted for their cap,
 * and one live connection per device, which the sweep re-checks and the
 * account frames reach. It also holds the workspace subscriptions of the
 * live connections and the presence that follows from them (#110): a person
 * is online in a workspace while at least one live connection of the account
 * is subscribed to it as that person. Presence is never stored. A connection
 * that closes, is replaced, or that the gateway or a route closes loses its
 * subscriptions at once.
 */
export class ConnectionRegistry {
  readonly #pending = new Set<WebSocket>();
  readonly #live = new Map<DeviceId, LiveConnection>();
  readonly #ids = new WeakMap<WebSocket, ConnectionId>();
  /** The subscribed live connections of each workspace, by the person they subscribed as. */
  readonly #workspaces = new Map<
    WorkspaceId,
    Map<MemberId, Set<LiveConnection>>
  >();
  /** The membership checks of subscribes in flight, by workspace. */
  readonly #checks = new Map<WorkspaceId, Set<MembershipCheck>>();
  readonly #log: FastifyBaseLogger | null;

  constructor(options: ConnectionRegistryOptions = {}) {
    this.#log = options.log ?? null;
  }

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
   * device; `seenAt` is when it wrote `devices.last_seen_at`. An older
   * connection of the device loses its subscriptions and closes with
   * `connection_replaced`; its context is returned.
   */
  register(
    socket: WebSocket,
    context: AuthenticatedConnectionContext,
    seenAt: number,
  ): AuthenticatedConnectionContext | null {
    this.#pending.delete(socket);
    const deviceId = context.identity.deviceId;
    const previous = this.#live.get(deviceId);
    this.#live.set(deviceId, {
      socket,
      context,
      seenAt,
      confirmed: false,
      subscriptions: new Map(),
      answered: true,
    });
    if (previous === undefined) {
      return null;
    }
    this.#dropAll(previous);
    closeWith(previous.socket, "connection_replaced");
    return previous.context;
  }

  /**
   * Records that a live connection got `auth.ok`. Account frames reach it
   * only from then on, so that none arrives before `auth.ok`.
   */
  confirm(context: AuthenticatedConnectionContext): void {
    const live = this.#liveWith(
      context.identity.deviceId,
      context.connectionId,
    );
    if (live !== undefined) {
      live.confirmed = true;
    }
  }

  /**
   * Forgets a connection that closed or was refused, with its
   * subscriptions. A connection that a newer one replaced is already gone,
   * so the newer one stays.
   */
  remove(
    socket: WebSocket,
    context: AuthenticatedConnectionContext | null,
  ): void {
    this.#pending.delete(socket);
    if (context === null) {
      return;
    }
    const live = this.#live.get(context.identity.deviceId);
    if (live?.socket === socket) {
      this.#live.delete(context.identity.deviceId);
      this.#dropAll(live);
    }
  }

  /** The live connection of a device, or null. */
  connectionOf(deviceId: DeviceId): AuthenticatedConnectionContext | null {
    return this.#live.get(deviceId)?.context ?? null;
  }

  /** The live connections at this moment, without their sockets. */
  live(): LiveConnectionView[] {
    return Array.from(this.#live.values(), ({ context, seenAt }) =>
      Object.freeze({ context, seenAt }),
    );
  }

  /** Records when `devices.last_seen_at` was written for a connection that is still live. */
  markSeen(context: AuthenticatedConnectionContext, seenAt: number): void {
    const live = this.#liveWith(
      context.identity.deviceId,
      context.connectionId,
    );
    if (live !== undefined) {
      live.seenAt = seenAt;
    }
  }

  /**
   * Closes the live connection of a device with a close reason of the
   * protocol, but only while it is the connection with this ID: a newer
   * connection of the device that registered meanwhile, for example while
   * the sweep read the device, stays open. Returns whether it closed.
   */
  closeConnection(
    deviceId: DeviceId,
    connectionId: ConnectionId,
    reason: WsCloseReason,
    log: FastifyBaseLogger,
  ): boolean {
    const live = this.#liveWith(deviceId, connectionId);
    if (live === undefined) {
      return false;
    }
    this.#close(deviceId, live, reason, log);
    return true;
  }

  /**
   * Closes the live connection of a device with a close reason of the
   * protocol, for example `device_revoked` after a revocation commits or
   * `sign_in_required` after a sign-out. Returns whether one was open.
   */
  closeDevice(
    deviceId: DeviceId,
    reason: WsCloseReason,
    log: FastifyBaseLogger,
  ): boolean {
    const live = this.#live.get(deviceId);
    if (live === undefined) {
      return false;
    }
    this.#close(deviceId, live, reason, log);
    return true;
  }

  /**
   * Closes the live connections of every device of an account, for example
   * with `sign_in_required` after GitHub reported a revocation. Returns how
   * many were open.
   */
  closeUser(
    userId: UserId,
    reason: WsCloseReason,
    log: FastifyBaseLogger,
  ): number {
    let closed = 0;
    for (const [deviceId, live] of this.#live) {
      if (live.context.identity.userId === userId) {
        this.#close(deviceId, live, reason, log);
        closed += 1;
      }
    }
    return closed;
  }

  /**
   * Sends an account frame to the live connections of an account that got
   * `auth.ok` and are still open, except the connection of `exceptDeviceId`,
   * for example the device that the frame reports as revoked. Returns how
   * many connections it was sent to.
   */
  sendToUser(
    userId: UserId,
    frame: AccountFrame,
    exceptDeviceId?: DeviceId,
  ): number {
    const text = JSON.stringify(frame);
    let sent = 0;
    for (const [deviceId, live] of Array.from(this.#live)) {
      if (
        live.context.identity.userId === userId &&
        deviceId !== exceptDeviceId &&
        live.confirmed &&
        this.#send(live, text)
      ) {
        sent += 1;
      }
    }
    return sent;
  }

  /**
   * Sends a frame of the server to a live connection, for example the
   * answer to a subscribe. Returns whether it was sent: not to a connection
   * that is no longer live or open, and not to one that reads too slowly,
   * which closes instead.
   */
  sendFrame(
    context: AuthenticatedConnectionContext,
    frame: ServerFrame,
  ): boolean {
    const live = this.#liveWith(
      context.identity.deviceId,
      context.connectionId,
    );
    return live !== undefined && this.#send(live, JSON.stringify(frame));
  }

  /** Records that a live connection answered a ping with a pong. */
  answered(context: AuthenticatedConnectionContext): void {
    const live = this.#liveWith(
      context.identity.deviceId,
      context.connectionId,
    );
    if (live !== undefined) {
      live.answered = true;
    }
  }

  /**
   * One heartbeat: terminates each live connection that did not answer the
   * previous ping with a pong, with its subscriptions, so that its person
   * goes offline at once, and pings every other open one. A half-open
   * connection, whose peer is gone without a close, therefore ends within
   * two heartbeats. Returns how many connections it terminated.
   */
  heartbeat(log: FastifyBaseLogger): number {
    let terminated = 0;
    for (const [deviceId, live] of Array.from(this.#live)) {
      if (this.#live.get(deviceId) !== live) {
        continue;
      }
      if (!live.answered) {
        this.#live.delete(deviceId);
        this.#dropAll(live);
        live.socket.terminate();
        log.info(
          { connectionId: live.context.connectionId, reason: "no_pong" },
          "connection terminated",
        );
        terminated += 1;
        continue;
      }
      live.answered = false;
      if (isOpen(live) && !this.#tooSlow(live)) {
        live.socket.ping();
      }
    }
    return terminated;
  }

  /**
   * Starts a subscribe's membership check of a workspace. Pass it to
   * `endMembershipCheck` when the check ended.
   */
  beginMembershipCheck(workspaceId: WorkspaceId): MembershipCheck {
    const check: MembershipCheck = { workspaceId, stale: false };
    const checks = this.#checks.get(workspaceId) ?? new Set<MembershipCheck>();
    checks.add(check);
    this.#checks.set(workspaceId, checks);
    return check;
  }

  /**
   * Ends a membership check. Returns whether `endMembership` processed a
   * removal in the check's workspace meanwhile, so that its result may be
   * stale and the subscribe checks again. A removal in another workspace
   * changes nothing.
   */
  endMembershipCheck(check: MembershipCheck): boolean {
    const checks = this.#checks.get(check.workspaceId);
    if (checks !== undefined && checks.delete(check) && checks.size === 0) {
      this.#checks.delete(check.workspaceId);
    }
    return check.stale;
  }

  /** The subscription of a live connection to a workspace, or null. */
  subscriptionOf(
    context: AuthenticatedConnectionContext,
    workspaceId: WorkspaceId,
  ): Subscription | null {
    return (
      this.#liveWith(
        context.identity.deviceId,
        context.connectionId,
      )?.subscriptions.get(workspaceId) ?? null
    );
  }

  /** How many workspaces a live connection is subscribed to. */
  subscriptionCount(context: AuthenticatedConnectionContext): number {
    return (
      this.#liveWith(context.identity.deviceId, context.connectionId)
        ?.subscriptions.size ?? 0
    );
  }

  /**
   * Subscribes a live connection to a workspace as the account's active
   * person there, which the caller checked; subscribing again keeps one
   * subscription. When the person was offline, the workspace's other
   * subscribed connections get `presence.changed` with `online`. Returns
   * the people who are online in the workspace, the person included, for
   * `workspace.subscribed`, or null when the connection is no longer live,
   * for example because it closed or was replaced during the check.
   */
  subscribe(
    context: AuthenticatedConnectionContext,
    workspaceId: WorkspaceId,
    memberId: MemberId,
  ): MemberId[] | null {
    const live = this.#liveWith(
      context.identity.deviceId,
      context.connectionId,
    );
    if (live === undefined) {
      return null;
    }
    const previous = live.subscriptions.get(workspaceId);
    if (previous !== undefined && previous.memberId !== memberId) {
      // The account rejoined as another person meanwhile.
      this.#drop(live, previous);
    }
    live.subscriptions.set(
      workspaceId,
      Object.freeze({ context, workspaceId, memberId }),
    );
    const people =
      this.#workspaces.get(workspaceId) ??
      new Map<MemberId, Set<LiveConnection>>();
    this.#workspaces.set(workspaceId, people);
    const connections = people.get(memberId) ?? new Set<LiveConnection>();
    const wasOnline = connections.size > 0;
    connections.add(live);
    people.set(memberId, connections);
    if (!wasOnline) {
      this.#sendPresence(workspaceId, memberId, "online", live);
    }
    // The subscriber's own person first, so that a cut list keeps it.
    return [
      memberId,
      ...Array.from(people.keys()).filter((id) => id !== memberId),
    ].slice(0, MAX_ANSWER_LIST_ITEMS);
  }

  /**
   * Ends a live connection's subscription to a workspace, because the
   * device asked. When it was the person's last subscribed connection, the
   * workspace's other subscribed connections get `presence.changed` with
   * `offline`. Returns whether the connection was subscribed.
   */
  unsubscribe(
    context: AuthenticatedConnectionContext,
    workspaceId: WorkspaceId,
  ): boolean {
    const live = this.#liveWith(
      context.identity.deviceId,
      context.connectionId,
    );
    const subscription = live?.subscriptions.get(workspaceId);
    if (live === undefined || subscription === undefined) {
      return false;
    }
    this.#drop(live, subscription);
    return true;
  }

  /**
   * Drops every subscription of a live connection that the gateway is
   * closing, with the presence changes that follow, so that a closing
   * connection gets nothing more and its person goes offline at once.
   */
  dropSubscriptions(context: AuthenticatedConnectionContext): void {
    const live = this.#liveWith(
      context.identity.deviceId,
      context.connectionId,
    );
    if (live !== undefined) {
      this.#dropAll(live);
    }
  }

  /** Every subscription of the live connections at this moment. */
  subscriptions(): Subscription[] {
    return Array.from(this.#live.values(), (live) =>
      Array.from(live.subscriptions.values()),
    ).flat();
  }

  /**
   * Ends a subscription because the account is no longer an active member
   * as that person, which the sweep or the per-event check found, but only
   * while it is still this record: a newer subscribe of the connection keeps
   * its own. The connection gets `workspace.unsubscribed` with
   * `membership_ended`. Returns whether it ended.
   */
  endSubscription(subscription: Subscription): boolean {
    const { context, workspaceId } = subscription;
    const live = this.#liveWith(
      context.identity.deviceId,
      context.connectionId,
    );
    if (
      live === undefined ||
      live.subscriptions.get(workspaceId) !== subscription
    ) {
      return false;
    }
    this.#drop(live, subscription);
    this.#sendUnsubscribed(live, workspaceId);
    return true;
  }

  /**
   * Ends every subscription to a workspace as a person who was removed or
   * left (ADR 0014, "Removal and ownership"). Each of its connections gets
   * `workspace.unsubscribed` with `membership_ended`, and the workspace's
   * other subscribed connections get `presence.changed` with `offline`.
   * Returns how many subscriptions ended.
   */
  endMembership(workspaceId: WorkspaceId, memberId: MemberId): number {
    for (const check of this.#checks.get(workspaceId) ?? []) {
      check.stale = true;
    }
    const connections = this.#workspaces.get(workspaceId)?.get(memberId);
    if (connections === undefined) {
      return 0;
    }
    let ended = 0;
    for (const live of Array.from(connections)) {
      const subscription = live.subscriptions.get(workspaceId);
      if (subscription !== undefined) {
        this.#drop(live, subscription);
        this.#sendUnsubscribed(live, workspaceId);
        ended += 1;
      }
    }
    return ended;
  }

  /**
   * Sends an event to every connection that is subscribed to the event's
   * workspace and still open; a connection that the server is closing is
   * skipped. A connection that is not subscribed never gets it, so neither
   * does an account that is not an active member. The one exception is
   * `sender`: the live connection whose event the server just accepted, as
   * an active member of the workspace, gets it too, once, also when it is not
   * subscribed (#27, #28). A connection that reads too slowly closes
   * instead. Returns how many connections it was sent to.
   */
  sendToWorkspace(
    event: ServerEvent,
    sender?: AuthenticatedConnectionContext,
  ): number {
    const text = JSON.stringify(event);
    const targets = new Set(this.#subscribersOf(event.workspaceId));
    if (sender !== undefined) {
      const live = this.#liveWith(
        sender.identity.deviceId,
        sender.connectionId,
      );
      if (live !== undefined) {
        targets.add(live);
      }
    }
    let sent = 0;
    for (const live of targets) {
      if (this.#send(live, text)) {
        sent += 1;
      }
    }
    return sent;
  }

  /**
   * Sends an event to one live connection only, whether or not it is
   * subscribed to the event's workspace: the answer to an event that the
   * connection sent, such as the stored `chat.message.created` for a
   * resent `chat.message.send` (#27). Returns whether it was sent.
   */
  sendEvent(
    context: AuthenticatedConnectionContext,
    event: ServerEvent,
  ): boolean {
    const live = this.#liveWith(
      context.identity.deviceId,
      context.connectionId,
    );
    return live !== undefined && this.#send(live, JSON.stringify(event));
  }

  /** The subscribed live connections of a workspace at this moment. */
  #subscribersOf(workspaceId: WorkspaceId): LiveConnection[] {
    const people = this.#workspaces.get(workspaceId);
    return people === undefined
      ? []
      : Array.from(people.values(), (connections) =>
          Array.from(connections),
        ).flat();
  }

  /**
   * Sends text to a live connection that is open. One with more than
   * `MAX_BUFFERED_BYTES` waiting to be sent is closed instead. Returns
   * whether it was sent.
   */
  #send(live: LiveConnection, text: string): boolean {
    if (!isOpen(live) || this.#tooSlow(live)) {
      return false;
    }
    live.socket.send(text);
    return true;
  }

  /**
   * Whether a connection reads too slowly; if so, it leaves the registry
   * with its subscriptions and closes with 1013 and `backpressure`, so that
   * nothing more is queued for it.
   */
  #tooSlow(live: LiveConnection): boolean {
    if (live.socket.bufferedAmount <= MAX_BUFFERED_BYTES) {
      return false;
    }
    const { deviceId } = live.context.identity;
    if (this.#live.get(deviceId) === live) {
      this.#live.delete(deviceId);
    }
    this.#dropAll(live);
    live.socket.close(CloseCode.tryAgainLater, "backpressure");
    this.#log?.info(
      { connectionId: live.context.connectionId, code: "backpressure" },
      "connection closed",
    );
    return true;
  }

  /** Drops one subscription and sends `offline` when it was the person's last one. */
  #drop(live: LiveConnection, subscription: Subscription): void {
    const { workspaceId, memberId } = subscription;
    if (live.subscriptions.get(workspaceId) === subscription) {
      live.subscriptions.delete(workspaceId);
    }
    const people = this.#workspaces.get(workspaceId);
    const connections = people?.get(memberId);
    if (
      people === undefined ||
      connections === undefined ||
      !connections.delete(live) ||
      connections.size > 0
    ) {
      return;
    }
    people.delete(memberId);
    if (people.size === 0) {
      this.#workspaces.delete(workspaceId);
    }
    this.#sendPresence(workspaceId, memberId, "offline");
  }

  #dropAll(live: LiveConnection): void {
    for (const subscription of Array.from(live.subscriptions.values())) {
      this.#drop(live, subscription);
    }
  }

  /**
   * Sends a person's new status to the workspace's subscribed connections
   * that are open, except `except`. The frame names the person, never a
   * device.
   */
  #sendPresence(
    workspaceId: WorkspaceId,
    memberId: MemberId,
    status: PresenceStatus,
    except?: LiveConnection,
  ): void {
    const frame: PresenceChangedFrame = {
      protocolVersion: PROTOCOL_VERSION,
      type: "presence.changed",
      workspaceId,
      memberId,
      status,
    };
    const text = JSON.stringify(frame);
    for (const live of this.#subscribersOf(workspaceId)) {
      if (live !== except) {
        this.#send(live, text);
      }
    }
  }

  #sendUnsubscribed(live: LiveConnection, workspaceId: WorkspaceId): void {
    const frame: WorkspaceUnsubscribedFrame = {
      protocolVersion: PROTOCOL_VERSION,
      type: "workspace.unsubscribed",
      workspaceId,
      reason: "membership_ended",
    };
    this.#send(live, JSON.stringify(frame));
  }

  /**
   * Ends a live connection that a change closed, by a route or by the sweep,
   * with its subscriptions, and logs it with its connection ID and the close
   * reason.
   */
  #close(
    deviceId: DeviceId,
    live: LiveConnection,
    reason: WsCloseReason,
    log: FastifyBaseLogger,
  ): void {
    this.#live.delete(deviceId);
    this.#dropAll(live);
    closeWith(live.socket, reason);
    log.info(
      { connectionId: live.context.connectionId, code: reason },
      "connection closed",
    );
  }

  /** The live connection of a device while it is the connection with this ID. */
  #liveWith(
    deviceId: DeviceId,
    connectionId: ConnectionId,
  ): LiveConnection | undefined {
    const live = this.#live.get(deviceId);
    return live?.context.connectionId === connectionId ? live : undefined;
  }
}

export type ConnectionSweepDependencies = Readonly<{
  connections: ConnectionRegistry;
  database: Database;
  now: () => number;
  log: FastifyBaseLogger;
}>;

/**
 * Re-checks the devices of every live connection with one batched query
 * (ADR 0014, "Revocation, sign-out, and recovery") and closes each
 * connection that its device's row no longer accepts, with the reason of
 * `refusalOf`: a revocation, a newer sign-in, a disabled account, a
 * sign-out, or a GitHub revocation after the sign-in. The 30-day sign-in
 * counts 24 hours late (`SIGN_IN_GRACE_MS`). A newer connection that
 * registered meanwhile stays open. Then one update writes
 * `devices.last_seen_at` for the open connections whose last write is 5
 * minutes old or more. Last, one batched query re-checks the workspace
 * subscriptions of the connections that stay open (`activePeopleOf`) and
 * ends each one whose account is no longer an active member as that person,
 * with `workspace.unsubscribed` and `membership_ended` (#110). A failure of
 * the database is logged, and the next sweep tries again.
 */
export async function sweepConnections(
  dependencies: ConnectionSweepDependencies,
): Promise<void> {
  const { connections, database, now, log } = dependencies;
  const live = connections.live();
  if (live.length === 0) {
    return;
  }
  try {
    const rows = await deviceRows(
      database,
      live.map(({ context }) => context.identity.deviceId),
    );
    const at = now();
    const seen: AuthenticatedConnectionContext[] = [];
    for (const { context, seenAt } of live) {
      const { deviceId } = context.identity;
      // Only the 30-day sign-in depends on the time.
      const refusal = refusalOf(
        rows.get(deviceId),
        context.signedInAt,
        at - SIGN_IN_GRACE_MS,
      );
      if (refusal !== null) {
        connections.closeConnection(
          deviceId,
          context.connectionId,
          refusal,
          log,
        );
      } else if (at - seenAt >= LAST_SEEN_INTERVAL_MS) {
        seen.push(context);
      }
    }
    if (seen.length > 0) {
      await markDevicesSeen(database, {
        deviceIds: seen.map((context) => context.identity.deviceId),
        now: new Date(at),
      });
      for (const context of seen) {
        connections.markSeen(context, at);
      }
    }
    const subscriptions = connections.subscriptions();
    if (subscriptions.length > 0) {
      const people = await activePeopleOf(
        database,
        subscriptions.map(({ context, workspaceId }) => ({
          workspaceId,
          userId: context.identity.userId,
        })),
      );
      for (const subscription of subscriptions) {
        const { context, workspaceId, memberId } = subscription;
        if (
          people.get(workspaceId)?.get(context.identity.userId) !== memberId &&
          connections.endSubscription(subscription)
        ) {
          log.info(
            { connectionId: context.connectionId, workspaceId },
            "subscription ended",
          );
        }
      }
    }
  } catch (error) {
    log.error({ err: error }, "connection sweep failed");
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
 * rule to WebSocket; Node sends no Origin. Origins are compared as exact
 * strings, in the serialized form that browsers send and that the
 * configuration requires.
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

/** Why `subscriptionAccess` refused a subscribe. */
export type SubscriptionRefusal =
  | Extract<WorkspaceSubscribeRefusalCode, "not_found">
  /** The device or the account may no longer act; the code is the close reason. */
  | ConnectionRefusal;

/**
 * Whether a connection may subscribe to a workspace now (ADR 0014, "What a
 * workspace ID allows"): its device row must still accept the connection,
 * as for every event (`refusalOf`, without the 30-day expiry), and its
 * account must have an active person in the workspace, whose ID it returns.
 * A workspace that does not exist and one without the account give the same
 * `not_found`.
 */
export async function subscriptionAccess(
  database: Database,
  context: AuthenticatedConnectionContext,
  workspaceId: WorkspaceId,
): Promise<
  { ok: true; memberId: MemberId } | { ok: false; code: SubscriptionRefusal }
> {
  const { userId, deviceId } = context.identity;
  const device = await deviceRow(database, deviceId);
  const refusal = refusalOf(device, context.signedInAt, null);
  if (refusal !== null) {
    return { ok: false, code: refusal };
  }
  const person = await activePersonOf(database, { workspaceId, userId });
  return person === undefined
    ? { ok: false, code: "not_found" }
    : { ok: true, memberId: person.id };
}

export type GatewayOptions = Readonly<{
  allowedOrigins: readonly string[];
  /**
   * The API's public origin: the audience of the `ws` signature, and an
   * origin that may open the gateway besides `allowedOrigins`.
   */
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
 * decoder or `onEvent`. Afterwards every text frame must be one JSON message
 * that `decodeClientMessage` accepts: an event, which `bindIdentity` binds to
 * the connection and which then goes to `onEvent`, or a workspace
 * subscription frame, which the gateway answers (#110). Messages are handled
 * one after another, in the order they arrived. Anything else closes the
 * connection. No authentication frame, nonce, or signature is logged. Every
 * 60 seconds `sweepConnections` re-checks the live connections; a tick while
 * the previous sweep still runs is skipped. Every 30 seconds the heartbeat
 * pings the live connections and terminates one that did not answer the
 * previous ping.
 */
export function registerGateway(
  app: FastifyInstance,
  options: GatewayOptions,
): void {
  const { connections, database, now, publicOrigin } = options;
  const replacementAudits = new AuditThrottle(CONNECTION_AUDIT_WINDOW_MS, now);
  const mismatchAudits = new AuditThrottle(CONNECTION_AUDIT_WINDOW_MS, now);

  /** The sweep that runs, if any. */
  let sweeping: Promise<void> | null = null;
  const sweeper = setInterval(() => {
    if (sweeping === null) {
      sweeping = sweepConnections({
        connections,
        database,
        now,
        log: app.log,
      }).finally(() => {
        sweeping = null;
      });
    }
  }, CONNECTION_SWEEP_INTERVAL_MS);
  sweeper.unref();
  const heartbeat = setInterval(() => {
    connections.heartbeat(app.log);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweeper);
    clearInterval(heartbeat);
    // The database closes after this hook, so a running sweep ends first.
    await sweeping;
  });

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
        // The API's own origin may connect too: Electron's net.WebSocket, the
        // desktop's client, sends by default the http(s) form of the
        // WebSocket URL's origin, which is the API's origin (#154). The
        // socket carries no cookie or other ambient credential; the device
        // signature authenticates the connection.
        originGuard([...options.allowedOrigins, publicOrigin]),
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
          if (context !== null) {
            connections.dropSubscriptions(context);
          }
          socket.close(CloseCode.internalError, "internal_error");
          if (phase !== "authenticated") {
            terminateSoon();
          }
        }
      }

      /**
       * Closes an authenticated connection from the gateway. Its
       * subscriptions end first, so that it gets nothing more and its person
       * goes offline at once.
       */
      function end(
        current: AuthenticatedConnectionContext,
        close: () => void,
      ): void {
        connections.dropSubscriptions(current);
        close();
      }

      /**
       * Sends a frame of the server to the authenticated connection while it
       * is live and open; one that reads too slowly closes instead.
       */
      function sendFrame(
        current: AuthenticatedConnectionContext,
        frame: ServerFrame,
      ): void {
        connections.sendFrame(current, frame);
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

      // The heartbeat terminates a connection that did not answer its ping.
      socket.on("pong", () => {
        if (context !== null) {
          connections.answered(context);
        }
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
        const replaced = connections.register(socket, authenticated, at);
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
        connections.confirm(authenticated);
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

      /**
       * `workspace.subscribe` (#110): checks the cap, then the device and the
       * active membership, records the subscription, and answers with the
       * people online. A removal that `endMembership` processed during the
       * check makes it check again.
       */
      async function subscribe(
        current: AuthenticatedConnectionContext,
        workspaceId: WorkspaceId,
      ): Promise<void> {
        if (
          connections.subscriptionOf(current, workspaceId) === null &&
          connections.subscriptionCount(current) >=
            MAX_SUBSCRIPTIONS_PER_CONNECTION
        ) {
          log.debug(
            { workspaceId, code: "too_many_subscriptions" },
            "subscription refused",
          );
          sendFrame(current, {
            protocolVersion: PROTOCOL_VERSION,
            type: "workspace.subscribe_refused",
            workspaceId,
            code: "too_many_subscriptions",
          });
          return;
        }
        let access: Awaited<ReturnType<typeof subscriptionAccess>>;
        for (let rechecks = 0; ; rechecks += 1) {
          const check = connections.beginMembershipCheck(workspaceId);
          let stale: boolean;
          try {
            access = await subscriptionAccess(database, current, workspaceId);
          } finally {
            stale = connections.endMembershipCheck(check);
          }
          // A connection that closed or was replaced meanwhile gets nothing.
          if (!open()) {
            return;
          }
          if (!access.ok || !stale) {
            break;
          }
          if (rechecks >= MAX_SUBSCRIBE_RECHECKS) {
            // Removals in this workspace keep coming: refuse rather than
            // record a subscription that may be stale. A held subscription
            // ends with it, so the answer stays true; the device may
            // subscribe again.
            connections.unsubscribe(current, workspaceId);
            log.info(
              { workspaceId, code: "not_found", rechecks },
              "subscription refused",
            );
            sendFrame(current, {
              protocolVersion: PROTOCOL_VERSION,
              type: "workspace.subscribe_refused",
              workspaceId,
              code: "not_found",
            });
            return;
          }
        }
        if (!access.ok) {
          const { code } = access;
          if (code !== "not_found") {
            end(current, () => closeWith(socket, code));
            return;
          }
          // A subscription that the connection holds ended with the membership.
          const held = connections.subscriptionOf(current, workspaceId);
          if (held !== null) {
            connections.endSubscription(held);
          }
          log.debug({ workspaceId, code }, "subscription refused");
          sendFrame(current, {
            protocolVersion: PROTOCOL_VERSION,
            type: "workspace.subscribe_refused",
            workspaceId,
            code,
          });
          return;
        }
        const online = connections.subscribe(
          current,
          workspaceId,
          access.memberId,
        );
        if (online === null) {
          return;
        }
        log.debug({ workspaceId }, "subscribed");
        sendFrame(current, {
          protocolVersion: PROTOCOL_VERSION,
          type: "workspace.subscribed",
          workspaceId,
          onlineMemberIds: online,
        });
      }

      /** A frame after `auth.ok`: a subscribe or an unsubscribe, answered in order. */
      async function onClientFrame(
        current: AuthenticatedConnectionContext,
        frame: AuthenticatedClientFrame,
      ): Promise<void> {
        switch (frame.type) {
          case "workspace.subscribe":
            await subscribe(current, frame.workspaceId);
            return;
          case "workspace.unsubscribe":
            // Answered also when the connection was not subscribed, so the
            // answer says nothing about the workspace.
            connections.unsubscribe(current, frame.workspaceId);
            log.debug({ workspaceId: frame.workspaceId }, "unsubscribed");
            sendFrame(current, {
              protocolVersion: PROTOCOL_VERSION,
              type: "workspace.unsubscribed",
              workspaceId: frame.workspaceId,
              reason: "requested",
            });
            return;
        }
      }

      /** One message after `auth.ok`: an event or a frame from the device. */
      async function onMessageFrame(
        data: RawData,
        isBinary: boolean,
      ): Promise<void> {
        const current = context;
        if (!open() || current === null) {
          return;
        }
        if (isBinary) {
          end(current, () =>
            socket.close(CloseCode.unsupportedData, "binary_not_supported"),
          );
          return;
        }
        let input: unknown;
        try {
          input = JSON.parse(frameToText(data));
        } catch {
          end(current, () =>
            socket.close(CloseCode.invalidFramePayload, "invalid_json"),
          );
          return;
        }
        const decoded = decodeClientMessage(input);
        if (!decoded.ok) {
          log.debug({ code: decoded.code }, "message rejected");
          end(current, () =>
            socket.close(CloseCode.policyViolation, decoded.code),
          );
          return;
        }
        if (decoded.kind === "frame") {
          await onClientFrame(current, decoded.frame);
          return;
        }
        const { event } = decoded;
        const bound = await bindIdentity(event, current, {
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
          reject(current, event.workspaceId, bound.code);
          return;
        }
        const outcome = await options.onEvent(bound.event, current);
        if (outcome !== undefined && open()) {
          reject(current, event.workspaceId, outcome.rejected);
        }
      }

      /**
       * Closes the connection for an event that identity binding, or the
       * event handler after it, refused.
       */
      function reject(
        current: AuthenticatedConnectionContext,
        workspaceId: WorkspaceId,
        code: IdentityRejectionCode,
      ): void {
        log.debug({ code }, "event rejected");
        switch (code) {
          case "not_a_member": {
            // The account's membership of a workspace that the connection
            // is subscribed to ended, and the server had not seen it yet.
            const held = connections.subscriptionOf(current, workspaceId);
            if (held !== null) {
              connections.endSubscription(held);
            }
            end(current, () => socket.close(CloseCode.policyViolation, code));
            return;
          }
          case "identity_mismatch":
            end(current, () => socket.close(CloseCode.policyViolation, code));
            return;
          default:
            end(current, () => closeWith(socket, code));
            return;
        }
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
              .then(() => onMessageFrame(data, isBinary))
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
