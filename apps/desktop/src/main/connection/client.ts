// The connection to the cloud API (#26; ADR 0014, "Device key and
// authentication" and "Storage and transport on the device"; P-56). The
// main process keeps one WebSocket to the gateway while the account service
// reports a signed-in device with a loaded key, and never two at once. The
// socket comes from an injected factory: production passes Electron's
// `net.WebSocket` (system.ts), the tests a fake.
//
// The client waits for `auth.challenge`, sends the one `auth.response` that
// the device session signs, and waits for `auth.ok`. It then sends the
// workspace subscriptions again, and passes decoded server messages on to
// other code of the main process. It keeps the account and device of that
// `auth.ok` for the socket's lifetime, and sends events only through
// `sendAs`, which builds each event from the identity that the server binds
// it to. It acts on each close reason as ADR 0014's table says, and backs off
// between attempts.
//
// The renderer gets the status only: fixed codes and a time. No frame,
// nonce, signature, key, or user ID is logged or reaches the renderer. The
// signed frame and the events of `sendAs` go only to the socket. `sendAs`
// passes the identity, user ID included, to the caller's `build`, and
// `identity()` returns it to main-process code that keys its data by the
// account and the device, such as the chat service, so it leaves this module
// but stays in the main process.
import {
  decodeClientMessage,
  decodeServerMessage,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  WS_CLOSE_CODES,
  type AuthChallengeFrame,
  type DeviceId,
  type ProtocolEvent,
  type ReceivedServerEvent,
  type ServerFrame,
  type ServerOnlyEventType,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import type {
  AccountStatus,
  ConnectionOfflineReason,
  ConnectionStatus,
  ConnectionStopReason,
  ConnectionWaitingReason,
  ReconnectResult,
} from "../../shared/ipc-contract.ts";
import type { AccountService } from "../account.ts";
import type { ApiOrigin } from "../api-origin.ts";
import type { ScheduleTimer } from "../runtime.ts";

/** The gateway's path on the API origin; a desktop constant for now (D5). */
export const GATEWAY_PATH = "/ws";

/**
 * The largest message that the client accepts from the server: 1 MiB,
 * measured in UTF-8 bytes after receipt, because `net.WebSocket` has no
 * limit of its own (D2). `MAX_FRAME_BYTES` is the server's limit for the
 * client's frames.
 */
export const RECEIVE_LIMIT_BYTES = 1024 * 1024;

/** A send is refused while more than this waits to go out (`bufferedAmount`). */
export const MAX_BUFFERED_SEND_BYTES = 1024 * 1024;

/** How long the opening handshake may take. */
export const HANDSHAKE_TIMEOUT_MS = 15_000;

/** How long the client waits from the open socket to `auth.ok`. */
export const AUTH_OK_TIMEOUT_MS = 15_000;

/** The first delay of the backoff, and its largest. */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

/** After this long connected, the backoff starts again from its first delay. */
export const STABLE_CONNECTION_MS = 60_000;

/** A reconnect within this time of the last one is refused (`too_soon`). */
export const RECONNECT_COOLDOWN_MS = 3_000;

/**
 * At most this many reconnects within `RECONNECT_BUDGET_WINDOW_MS`; more are
 * refused (`too_soon`). The API allows 60 handshakes per address in 10
 * minutes. The backoff makes at most 25 in that time, when every wait is
 * the shortest (0.5, 1, 2, 4, 8, and 16 seconds, then 30), so with these 10
 * the client makes at most 35 and leaves room for other devices behind the
 * same address. A renderer that calls the reconnect in a loop gets no more.
 */
export const RECONNECT_BUDGET = 10;
export const RECONNECT_BUDGET_WINDOW_MS = 10 * 60_000;

/**
 * The stop reasons after which a reconnect may be asked for. They hold for
 * the connection of the signed-in device only, so they also end when no
 * device is signed in any more (`accountChanged`).
 */
const RECONNECTABLE_STOPS: ReadonlySet<ConnectionStopReason> = new Set([
  "connection_replaced",
  "protocol_violation",
]);

/**
 * How long the client waits for the close event of a socket that it closed
 * before it opens the next one, so that two sockets are never open at once.
 */
export const CLOSE_WAIT_MS = 5_000;

/** The close code that the client uses: a normal closure. */
const NORMAL_CLOSURE = 1000;

/**
 * The delay before attempt `attempt` (from 0): min(60 s, 1 s x 2^attempt).
 * The client waits a random time between half of it and all of it.
 */
export function backoffDelayMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
}

/** The gateway URL of an API origin: `ws:` for `http:`, `wss:` for `https:`. */
export function gatewayUrl(origin: string): string {
  return `${origin.replace(/^http/u, "ws")}${GATEWAY_PATH}`;
}

/** What the socket reports; the factory wires them to the socket's events. */
export interface SocketEvents {
  readonly open: () => void;
  /** A text message is a string; a binary message is anything else. */
  readonly message: (data: unknown) => void;
  readonly close: (code: number, reason: string) => void;
}

/** The part of a WHATWG WebSocket that the client uses. */
export interface ConnectionSocket {
  /** The bytes that `send` queued and that have not gone out yet. */
  readonly bufferedAmount: () => number;
  readonly send: (data: string) => void;
  readonly close: (code: number) => void;
}

/** Opens a socket to `url`. It may throw, for example for a refused URL. */
export type OpenSocket = (
  url: string,
  events: SocketEvents,
) => ConnectionSocket;

/** The part of the account service that the client uses. */
export type ConnectionAccount = Pick<
  AccountService,
  "status" | "onStatusChange" | "signWebSocketChallenge" | "deviceRefused"
>;

/** An event that a device sends: never one that only the server sends. */
export type ClientEvent = Exclude<ProtocolEvent, { type: ServerOnlyEventType }>;

/** A message of the server after `auth.ok`, decoded with `decodeServerMessage`. */
export type ServerMessage =
  | { readonly kind: "event"; readonly event: ReceivedServerEvent }
  | { readonly kind: "frame"; readonly frame: ServerFrame };

/**
 * The outcome of a send: `sent`; `not_connected` before `auth.ok`;
 * `backpressure` while more than `MAX_BUFFERED_SEND_BYTES` wait to go out;
 * `too_large` above the server's `MAX_FRAME_BYTES`; `invalid` for a message
 * that `decodeClientMessage` refuses.
 */
export type SendOutcome =
  "sent" | "not_connected" | "backpressure" | "too_large" | "invalid";

/**
 * Who the current socket's `auth.ok` authenticated: the account and the
 * device that the server binds every event of the connection to (ADR 0006,
 * identity binding). An event with another `deviceId`, or with a `user`
 * actor of another account, closes the connection (1008
 * `identity_mismatch`). Main process only: it never reaches the renderer or
 * a log.
 */
export interface ConnectionIdentity {
  readonly userId: UserId;
  readonly deviceId: DeviceId;
}

/** Builds a client event from the identity of the current socket. */
export type BuildClientEvent = (identity: ConnectionIdentity) => ClientEvent;

export interface ConnectionClientOptions {
  /** From `resolveApiOrigin`. */
  readonly apiOrigin: ApiOrigin;
  readonly account: ConnectionAccount;
  /** Production passes Electron's `net.WebSocket` (system.ts). */
  readonly openSocket: OpenSocket;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /** The wall clock in milliseconds, for `retryAt`; defaults to `Date.now`. */
  readonly wallClock?: () => number;
  /** A number from 0 to below 1; defaults to `Math.random`. */
  readonly random?: () => number;
  /**
   * Receives fixed messages with a close code at most, never a frame, a
   * nonce, a signature, or a key. An error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface ConnectionClient {
  /** The current status. */
  readonly status: () => ConnectionStatus;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onStatusChange: (
    listener: (status: ConnectionStatus) => void,
  ) => () => void;
  /**
   * Connects again at once after the person's action: "Retry now" while
   * waiting, or "Reconnect here once" after `connection_replaced` (and
   * "Retry now" after `protocol_violation`). Refused as `not_signed_in`
   * without a signed-in device and after the server refused the device
   * (`auth_failed`, `device_revoked`, `sign_in_required`), which only a
   * GitHub sign-in ends; as `update_required` while an update is required;
   * as `already_open` while a socket is open or opening; and as `too_soon`
   * within `RECONNECT_COOLDOWN_MS` of the last reconnect or beyond
   * `RECONNECT_BUDGET` reconnects in `RECONNECT_BUDGET_WINDOW_MS`.
   */
  readonly reconnect: () => ReconnectResult;
  /**
   * The system woke up (`powerMonitor` `resume`): a connection that waits
   * starts at once, and an open one is replaced, because it may have died
   * unnoticed while the computer slept.
   */
  readonly systemResumed: () => void;
  /**
   * Asks for a workspace's events; kept until `unsubscribeWorkspace`, and
   * sent again after each `auth.ok`.
   */
  readonly subscribeWorkspace: (workspaceId: WorkspaceId) => void;
  readonly unsubscribeWorkspace: (workspaceId: WorkspaceId) => void;
  /** The workspaces asked for, in the order they were asked for. */
  readonly workspaces: () => readonly WorkspaceId[];
  /**
   * The only way to send a client event. Builds it from the identity of the
   * current socket's `auth.ok` and sends it on that socket in the same call,
   * so that no other socket, and no other identity, can come between the
   * two. Without an authenticated socket the result is `not_connected`, and
   * `build` is not called. `build` is called at most once; if it throws, the
   * result is `invalid`, and if it closed the socket, `not_connected`. An
   * event whose `deviceId`, or whose `user` actor's `userId`, is not the
   * identity's is refused as `invalid` instead of being sent, because the
   * server would close the connection for it. The other refusals of
   * `SendOutcome` apply as well, and only the decoded copy is sent.
   */
  readonly sendAs: (build: BuildClientEvent) => SendOutcome;
  /**
   * The identity of the current socket's `auth.ok`, or null without an
   * authenticated socket. Main process only, for code that keys its data by
   * the account and the device, such as the chat service's waiting
   * messages; events are still sent only through `sendAs`.
   */
  readonly identity: () => ConnectionIdentity | null;
  /**
   * Calls `listener` with every decoded message of the server after
   * `auth.ok`. The result removes the listener. Main process only.
   */
  readonly onMessage: (
    listener: (message: ServerMessage) => void,
  ) => () => void;
  /** Closes the socket (1000) and stops for good, for the quit. */
  readonly close: () => void;
}

/** One socket and how far its authentication got. */
interface Live {
  socket: ConnectionSocket | null;
  /**
   * `opening` until the socket opens, `challenge` until `auth.challenge`,
   * `signing` while the session signs, `auth_ok` until `auth.ok`, and
   * `open` after it.
   */
  phase: "opening" | "challenge" | "signing" | "auth_ok" | "open";
  /** The device of the signed `auth.response`, once it was sent. */
  deviceId: DeviceId | null;
  /**
   * The account and device of `auth.ok`: null before it, and again once
   * the socket closed or the client closed it.
   */
  identity: ConnectionIdentity | null;
  cancelTimer: (() => void) | null;
}

const scheduleWithSetTimeout: ScheduleTimer = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

/** The device that the connection authenticates as, or why there is none. */
function eligibleDevice(
  status: AccountStatus,
):
  | { readonly deviceId: DeviceId }
  | { readonly reason: ConnectionOfflineReason | undefined } {
  if (status.apiOrigin !== "set") {
    return { reason: "no_api_origin" };
  }
  if (
    status.device === "signed_in" &&
    status.deviceKey === "ready" &&
    status.account.kind === "signed_in"
  ) {
    return { deviceId: status.account.deviceId as DeviceId };
  }
  // While the device session starts, nothing is known yet.
  return { reason: status.device === "starting" ? undefined : "not_signed_in" };
}

/** The size of a string in UTF-8 bytes. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function reasonOf(status: object): unknown {
  return "reason" in status ? status.reason : undefined;
}

function retryAtOf(status: object): unknown {
  return "retryAt" in status ? status.retryAt : undefined;
}

/** Whether the server binds `event` to `identity` without a mismatch. */
function boundTo(event: ProtocolEvent, identity: ConnectionIdentity): boolean {
  return (
    event.deviceId === identity.deviceId &&
    (event.actor.kind !== "user" || event.actor.userId === identity.userId)
  );
}

export function createConnectionClient(
  options: ConnectionClientOptions,
): ConnectionClient {
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? (() => performance.now());
  const wallClock = options.wallClock ?? (() => Date.now());
  const random = options.random ?? (() => Math.random());
  const origin = options.apiOrigin.ok ? options.apiOrigin.origin : null;
  const account = options.account;
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  const messageListeners = new Set<(message: ServerMessage) => void>();
  const workspaces = new Set<WorkspaceId>();

  const log = (message: string): void => {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  };

  /** The device to connect as, or null. */
  let target: DeviceId | null = null;
  let offlineReason: ConnectionOfflineReason | undefined;
  /** Why the client stopped; it does not reconnect on its own meanwhile. */
  let latch: ConnectionStopReason | null = null;
  let live: Live | null = null;
  /** A socket that the client closed, until its close event arrives. */
  let draining: Live | null = null;
  let cancelDrain: (() => void) | null = null;
  let cancelRetry: (() => void) | null = null;
  let cancelStable: (() => void) | null = null;
  /** Counts the attempts since the last stable connection. */
  let attempt = 0;
  /** Whether the reconnect after `key_replaced` was used since the last stable connection. */
  let keyReplacedReconnectUsed = false;
  /** When the reconnects within the budget's window were accepted, oldest first. */
  const reconnects: number[] = [];
  let closed = false;
  let revision = 0;
  let current: ConnectionStatus = Object.freeze({
    state: "offline",
    revision,
  });

  // ---- Status --------------------------------------------------------------

  type StatusValue =
    | { readonly state: "offline"; readonly reason?: ConnectionOfflineReason }
    | { readonly state: "connecting" | "authenticating" | "connected" }
    | {
        readonly state: "waiting";
        readonly reason: ConnectionWaitingReason;
        readonly retryAt: string;
      }
    | { readonly state: "stopped"; readonly reason: ConnectionStopReason };

  function setStatus(value: StatusValue): void {
    if (
      current.state === value.state &&
      reasonOf(current) === reasonOf(value) &&
      retryAtOf(current) === retryAtOf(value)
    ) {
      return;
    }
    revision += 1;
    current = Object.freeze({ ...value, revision }) as ConnectionStatus;
    for (const listener of [...statusListeners]) {
      try {
        listener(current);
      } catch {
        log("A connection status listener failed.");
      }
    }
  }

  /** The status while no socket is wanted. */
  function idleStatus(): StatusValue {
    if (latch !== null) {
      return { state: "stopped", reason: latch };
    }
    return offlineReason === undefined
      ? { state: "offline" }
      : { state: "offline", reason: offlineReason };
  }

  // ---- Timers and sockets ---------------------------------------------------

  function stopRetry(): void {
    cancelRetry?.();
    cancelRetry = null;
  }

  function stopStable(): void {
    cancelStable?.();
    cancelStable = null;
  }

  function stopTimer(record: Live): void {
    record.cancelTimer?.();
    record.cancelTimer = null;
  }

  function wanted(): boolean {
    return !closed && origin !== null && target !== null && latch === null;
  }

  /**
   * Closes the live socket with 1000 and keeps it as `draining` until its
   * close event, so that the next socket opens only after it closed.
   */
  function closeLive(record: Live): void {
    if (live === record) {
      live = null;
    }
    record.identity = null;
    stopTimer(record);
    stopStable();
    const socket = record.socket;
    if (socket === null) {
      return;
    }
    drained();
    draining = record;
    cancelDrain = schedule(() => {
      if (draining === record) {
        drained();
        pump();
      }
    }, CLOSE_WAIT_MS);
    try {
      socket.close(NORMAL_CLOSURE);
    } catch {
      // A socket that cannot close is already closed.
    }
  }

  function drained(): void {
    cancelDrain?.();
    cancelDrain = null;
    draining = null;
  }

  /**
   * Brings the sockets in line with what is wanted: none without a target
   * or while stopped; otherwise one, unless one is open or waits.
   */
  function pump(): void {
    if (closed) {
      return;
    }
    if (!wanted()) {
      stopRetry();
      if (live !== null) {
        closeLive(live);
      }
      setStatus(idleStatus());
      return;
    }
    if (live !== null || cancelRetry !== null) {
      return;
    }
    if (draining !== null) {
      // The next socket opens when the closed one has gone.
      setStatus({ state: "connecting" });
      return;
    }
    connect();
  }

  function connect(): void {
    if (origin === null) {
      return;
    }
    const record: Live = {
      socket: null,
      phase: "opening",
      deviceId: null,
      identity: null,
      cancelTimer: null,
    };
    live = record;
    setStatus({ state: "connecting" });
    let socket: ConnectionSocket;
    try {
      socket = options.openSocket(gatewayUrl(origin), {
        open: () => opened(record),
        message: (data) => received(record, data),
        close: (code, reason) => socketClosed(record, code, reason),
      });
    } catch {
      if (live === record) {
        live = null;
        log("The connection to the API could not be opened.");
        backOff("connection_failed");
      }
      return;
    }
    record.socket = socket;
    if (live !== record) {
      // The factory reported a close already.
      return;
    }
    record.cancelTimer = schedule(() => timedOut(record), HANDSHAKE_TIMEOUT_MS);
  }

  /** Waits before the next attempt: min(60 s, 1 s x 2^n), between half and all of it. */
  function backOff(reason: ConnectionWaitingReason): void {
    stopRetry();
    if (!wanted()) {
      pump();
      return;
    }
    const delay = backoffDelayMs(attempt);
    if (delay < BACKOFF_MAX_MS) {
      attempt += 1;
    }
    const wait = Math.round(delay / 2 + random() * (delay / 2));
    cancelRetry = schedule(() => {
      cancelRetry = null;
      pump();
    }, wait);
    setStatus({
      state: "waiting",
      reason,
      retryAt: new Date(wallClock() + wait).toISOString(),
    });
  }

  /** Stops without reconnecting until the person acts or the device changes. */
  function stopWith(reason: ConnectionStopReason): void {
    latch = reason;
    pump();
  }

  // ---- Socket events ------------------------------------------------------

  function opened(record: Live): void {
    if (live !== record || record.phase !== "opening") {
      return;
    }
    stopTimer(record);
    record.phase = "challenge";
    setStatus({ state: "authenticating" });
    record.cancelTimer = schedule(() => timedOut(record), AUTH_OK_TIMEOUT_MS);
  }

  function timedOut(record: Live): void {
    if (live !== record) {
      return;
    }
    log("The connection to the API timed out.");
    closeLive(record);
    backOff("timeout");
  }

  /** Closes after a message that the client does not accept, and backs off. */
  function refuseMessage(record: Live): void {
    log("The connection to the API received a message that it refuses.");
    closeLive(record);
    backOff("invalid_message");
  }

  function received(record: Live, data: unknown): void {
    if (live !== record) {
      return;
    }
    // Only text frames; a binary message is anything but a string.
    if (typeof data !== "string") {
      refuseMessage(record);
      return;
    }
    // A UTF-8 byte is at least one UTF-16 code unit, so the length is a
    // quick lower bound.
    if (
      data.length > RECEIVE_LIMIT_BYTES ||
      utf8Bytes(data) > RECEIVE_LIMIT_BYTES
    ) {
      refuseMessage(record);
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(data);
    } catch {
      refuseMessage(record);
      return;
    }
    const decoded = decodeServerMessage(input);
    if (!decoded.ok) {
      if (
        decoded.code === "unsupported_version" &&
        record.phase === "challenge"
      ) {
        // The server's challenge speaks another protocol version.
        log("The API speaks another protocol version; an update is required.");
        closeLive(record);
        stopWith("update_required");
        return;
      }
      refuseMessage(record);
      return;
    }
    switch (record.phase) {
      case "challenge":
        if (
          decoded.kind === "frame" &&
          decoded.frame.type === "auth.challenge"
        ) {
          record.phase = "signing";
          void answerChallenge(record, decoded.frame);
          return;
        }
        refuseMessage(record);
        return;
      case "auth_ok":
        if (
          decoded.kind === "frame" &&
          decoded.frame.type === "auth.ok" &&
          decoded.frame.deviceId === record.deviceId
        ) {
          authenticated(record, {
            userId: decoded.frame.userId,
            deviceId: decoded.frame.deviceId,
          });
          return;
        }
        refuseMessage(record);
        return;
      case "open":
        if (
          decoded.kind === "frame" &&
          (decoded.frame.type === "auth.challenge" ||
            decoded.frame.type === "auth.ok")
        ) {
          refuseMessage(record);
          return;
        }
        deliver(
          decoded.kind === "event"
            ? Object.freeze({ kind: "event", event: decoded.event })
            : Object.freeze({ kind: "frame", frame: decoded.frame }),
        );
        return;
      default:
        // Nothing may arrive before the open socket or while signing.
        refuseMessage(record);
    }
  }

  async function answerChallenge(
    record: Live,
    challenge: AuthChallengeFrame,
  ): Promise<void> {
    const answer = await account.signWebSocketChallenge(challenge);
    if (live !== record || record.phase !== "signing") {
      return;
    }
    if (!answer.ok) {
      log("The connection's challenge could not be signed.");
      closeLive(record);
      backOff("signature_failed");
      return;
    }
    record.deviceId = answer.frame.deviceId;
    record.phase = "auth_ok";
    try {
      // The only frame before `auth.ok`. It carries a signature: it is
      // sent, never logged.
      record.socket?.send(JSON.stringify(answer.frame));
    } catch {
      closeLive(record);
      backOff("connection_lost");
    }
  }

  function authenticated(record: Live, identity: ConnectionIdentity): void {
    stopTimer(record);
    record.phase = "open";
    record.identity = Object.freeze({ ...identity });
    log("The connection to the API is authenticated.");
    setStatus({ state: "connected" });
    cancelStable = schedule(() => {
      cancelStable = null;
      attempt = 0;
      keyReplacedReconnectUsed = false;
    }, STABLE_CONNECTION_MS);
    for (const workspaceId of workspaces) {
      transmit({
        protocolVersion: PROTOCOL_VERSION,
        type: "workspace.subscribe",
        workspaceId,
      });
    }
  }

  function deliver(message: ServerMessage): void {
    for (const listener of [...messageListeners]) {
      try {
        listener(message);
      } catch {
        log("A connection message listener failed.");
      }
    }
  }

  function socketClosed(record: Live, code: number, reason: string): void {
    if (draining === record) {
      drained();
      pump();
      return;
    }
    if (live !== record) {
      return;
    }
    live = null;
    record.identity = null;
    stopTimer(record);
    stopStable();
    log(`The connection to the API closed with code ${String(code)}.`);
    const deviceId = record.deviceId;
    const refuse = (
      refusal: "auth_failed" | "device_revoked" | "sign_in_required",
    ): void => {
      if (deviceId !== null) {
        // The session applies it for the device that the connection
        // authenticated as; `device_revoked` deletes the key and stops
        // local execution.
        void account.deviceRefused(refusal, deviceId);
      }
    };
    switch (code) {
      case WS_CLOSE_CODES.auth_failed:
        stopWith("auth_failed");
        refuse("auth_failed");
        return;
      case WS_CLOSE_CODES.device_revoked:
        stopWith("device_revoked");
        refuse("device_revoked");
        return;
      case WS_CLOSE_CODES.sign_in_required:
        stopWith("sign_in_required");
        refuse("sign_in_required");
        return;
      case WS_CLOSE_CODES.connection_replaced:
        stopWith("connection_replaced");
        return;
      case WS_CLOSE_CODES.protocol_violation:
        stopWith("protocol_violation");
        return;
      case WS_CLOSE_CODES.key_replaced:
        if (!keyReplacedReconnectUsed) {
          // The server holds a newer key of this device: reconnect at once,
          // one time, with it.
          keyReplacedReconnectUsed = true;
          stopRetry();
          pump();
          return;
        }
        backOff("key_replaced");
        return;
      case WS_CLOSE_CODES.auth_timeout:
        backOff("timeout");
        return;
      case 1011:
        backOff("server_error");
        return;
      case 1013:
        backOff("server_busy");
        return;
      case 1008:
        if (reason === "unsupported_version") {
          stopWith("update_required");
          return;
        }
        backOff("message_refused");
        return;
      case 1003:
      case 1007:
      case 1009:
        backOff("message_refused");
        return;
      default:
        // 1001, 1006, and any other code.
        backOff(
          record.phase === "opening" ? "connection_failed" : "connection_lost",
        );
    }
  }

  // ---- Sending ------------------------------------------------------------

  /**
   * Sends on the live socket after `auth.ok`: without `bound`, only a client
   * frame; with it, only an event that the server binds to that identity.
   * Anything else is refused as `invalid`.
   */
  function transmit(
    message: ClientEvent | Record<string, unknown>,
    bound: ConnectionIdentity | null = null,
  ): SendOutcome {
    const record = live;
    if (record === null || record.phase !== "open" || record.socket === null) {
      return "not_connected";
    }
    let text: string;
    try {
      // `undefined`, a function, or a symbol serializes to nothing.
      const serialized: string | undefined = JSON.stringify(message);
      if (serialized === undefined) {
        return "invalid";
      }
      text = serialized;
    } catch {
      return "invalid";
    }
    // The server closes with 1009 above it.
    if (utf8Bytes(text) > MAX_FRAME_BYTES) {
      return "too_large";
    }
    // Only what the server accepts after `auth.ok`: an authenticated client
    // frame, or a client event. The decoded copy is sent, so a field that
    // the protocol does not know never leaves.
    const checked = decodeClientMessage(JSON.parse(text) as unknown);
    if (!checked.ok) {
      return "invalid";
    }
    const allowed =
      bound === null
        ? checked.kind === "frame"
        : checked.kind === "event" && boundTo(checked.event, bound);
    if (!allowed) {
      return "invalid";
    }
    text = JSON.stringify(
      checked.kind === "event" ? checked.event : checked.frame,
    );
    if (record.socket.bufferedAmount() > MAX_BUFFERED_SEND_BYTES) {
      return "backpressure";
    }
    try {
      record.socket.send(text);
    } catch {
      return "not_connected";
    }
    return "sent";
  }

  function sendAs(build: BuildClientEvent): SendOutcome {
    const record = live;
    const identity = record?.phase === "open" ? record.identity : null;
    if (record === null || identity === null) {
      return "not_connected";
    }
    let event: ClientEvent;
    try {
      event = build(identity);
    } catch {
      return "invalid";
    }
    // `build` runs synchronously, so no socket event comes between. If it
    // closed the socket itself, `transmit` finds no live socket; any other
    // socket would be refused unless it has the same identity.
    return transmit(event, identity);
  }

  // ---- Account ------------------------------------------------------------

  function accountChanged(status: AccountStatus): void {
    if (closed) {
      return;
    }
    const eligible = eligibleDevice(status);
    const next = "deviceId" in eligible ? eligible.deviceId : null;
    offlineReason = "reason" in eligible ? eligible.reason : undefined;
    const previous = target;
    target = next;
    if (next !== null && next !== previous) {
      // A device that is newly signed in, or another device: whatever
      // stopped the previous one does not hold for it, except an update.
      if (latch !== "update_required") {
        latch = null;
      }
      attempt = 0;
      keyReplacedReconnectUsed = false;
      stopRetry();
      if (live !== null) {
        closeLive(live);
      }
    }
    if (next === null && latch !== null && RECONNECTABLE_STOPS.has(latch)) {
      // No device to connect as: a sign-out, "This is not me", a removal
      // (also one that waits for the API), or a key that is not ready.
      // `connection_replaced` and `protocol_violation` held for the
      // connection of the previous device, and their reconnect would now be
      // refused, so the status becomes the one of no device. A refusal of
      // the server (`auth_failed`, `device_revoked`, `sign_in_required`)
      // stays: the session moves the device to the refused state right after
      // it, which makes it ineligible, and only a GitHub sign-in ends it, as
      // its sentence says. `update_required` stays as well: the server's
      // protocol version does not change with a sign-out, nor with a new
      // device.
      latch = null;
    }
    pump();
  }

  const stopFollowing = account.onStatusChange(accountChanged);
  if (origin === null) {
    offlineReason = "no_api_origin";
    setStatus(idleStatus());
  } else {
    accountChanged(account.status());
  }

  // ---- Public functions ---------------------------------------------------

  function reconnect(): ReconnectResult {
    if (closed || origin === null || target === null) {
      return Object.freeze({ outcome: "refused", reason: "not_signed_in" });
    }
    if (latch === "update_required") {
      return Object.freeze({ outcome: "refused", reason: "update_required" });
    }
    if (latch !== null && !RECONNECTABLE_STOPS.has(latch)) {
      // The server refused the device: the same key would be refused again,
      // and only a GitHub sign-in, which the account panel starts, ends it.
      return Object.freeze({ outcome: "refused", reason: "not_signed_in" });
    }
    if (
      live !== null ||
      draining !== null ||
      (latch === null && cancelRetry === null)
    ) {
      // A socket is open, opening, or about to open.
      return Object.freeze({ outcome: "refused", reason: "already_open" });
    }
    const at = now();
    while (
      reconnects.length > 0 &&
      at - (reconnects[0] ?? at) >= RECONNECT_BUDGET_WINDOW_MS
    ) {
      reconnects.shift();
    }
    const last = reconnects.at(-1);
    if (
      (last !== undefined && at - last < RECONNECT_COOLDOWN_MS) ||
      reconnects.length >= RECONNECT_BUDGET
    ) {
      return Object.freeze({ outcome: "refused", reason: "too_soon" });
    }
    reconnects.push(at);
    latch = null;
    stopRetry();
    pump();
    return Object.freeze({ outcome: "reconnecting" });
  }

  function systemResumed(): void {
    if (!wanted()) {
      return;
    }
    log("The system resumed; the connection to the API starts again.");
    if (live !== null) {
      closeLive(live);
    }
    stopRetry();
    pump();
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    stopFollowing();
    stopRetry();
    stopStable();
    const record = live;
    live = null;
    if (record !== null) {
      record.identity = null;
      stopTimer(record);
      try {
        record.socket?.close(NORMAL_CLOSURE);
      } catch {
        // Already closed.
      }
    }
    drained();
    setStatus({ state: "offline" });
  }

  return Object.freeze({
    status: () => current,
    onStatusChange: (listener: (status: ConnectionStatus) => void) => {
      const entry = (status: ConnectionStatus) => listener(status);
      statusListeners.add(entry);
      return () => {
        statusListeners.delete(entry);
      };
    },
    reconnect,
    systemResumed,
    subscribeWorkspace: (workspaceId: WorkspaceId) => {
      if (workspaces.has(workspaceId)) {
        return;
      }
      workspaces.add(workspaceId);
      transmit({
        protocolVersion: PROTOCOL_VERSION,
        type: "workspace.subscribe",
        workspaceId,
      });
    },
    unsubscribeWorkspace: (workspaceId: WorkspaceId) => {
      if (!workspaces.delete(workspaceId)) {
        return;
      }
      transmit({
        protocolVersion: PROTOCOL_VERSION,
        type: "workspace.unsubscribe",
        workspaceId,
      });
    },
    workspaces: () => Object.freeze([...workspaces]),
    sendAs,
    identity: () => (live?.phase === "open" ? live.identity : null),
    onMessage: (listener: (message: ServerMessage) => void) => {
      const entry = (message: ServerMessage) => listener(message);
      messageListeners.add(entry);
      return () => {
        messageListeners.delete(entry);
      };
    },
    close,
  });
}
