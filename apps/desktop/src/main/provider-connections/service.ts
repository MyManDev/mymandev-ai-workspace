// This device's AI provider connections (#32; #295 and the Project
// Manager's decisions of 2026-11-20 and 2026-11-23), in the main process:
// the list that the server holds for this device (`GET
// /provider-connections`, read with the account service's
// `readWorkspaceData`, the same read as the permission screen's), a status
// for each connection, and the two writes, registering and removing a
// connection, sent with `sendWorkspaceAction`.
//
// - Metadata only. A connection is its ID, its kind, its label, and when it
//   was registered. No credential is read, kept, or sent here: a
//   registration sends the kind and the label only, and the local
//   credential waits for #33 and the Project Manager's decision on how the
//   adapters reach the providers.
// - Status (a default until the Project Manager decides, 2026-11-24). The
//   status of each connection is computed here from a closed list
//   (`providerConnectionStatus`): `registered` while the server lists it
//   and this device is online with a list read that succeeded, and
//   `unknown` while it is offline or the last read failed. A status check
//   is the person acting on their own device, not a `provider.use` action,
//   so it asks the permission enforcement point nothing.
// - Reads. The list loads once a device is signed in with a ready key, and
//   again when the device or the account changes, when the connection
//   reaches `connected`, and after every write that may have reached the
//   API, whatever its answer. A read waits for a sign-in that runs; at the
//   end of a sign-in the list is read only when a read waited for it: the
//   device changed, or a trigger came during the sign-in. One read runs at
//   a time: a read asked for while one is on its way drops that answer and
//   reads again. A `connected` asks for none while one is on its way,
//   because the status of each connection follows the connection when the
//   state is built. A failed read is retried with the workspace service's
//   backoff while connected; after `rate_limited`, also as the answer of a
//   dropped read, nothing reads until its wait ended. A read that the
//   account service held back (`heldBack`) waits for `onReadsResumed`.
// - Writes. One at a time: a second registration or removal while the
//   first waits is refused as `busy` and never sent. A removal is accepted
//   only for a connection of the list held now (`not_listed`). Every write
//   failure maps to a fixed refusal, with the wait of `too_soon` and
//   `rate_limited`. After a removal that may have reached the API, the
//   grant store reads its records again (`ownGrantAnswered`), because the
//   server revokes the connection's `provider.use` grants with it and their
//   events may be lost.
// - A sign-out, another account, or another device drops the list and the
//   answers on their way.
//
// The state holds no device ID, user ID, or token. The logs are fixed text
// with a failure code at most, never a label or an ID.
import {
  type ProviderConnection,
  ProviderConnectionIdSchema,
  type ProviderConnectionListResponse,
  RegisterProviderConnectionRequestSchema,
  type RegisterProviderConnectionResponse,
} from "@mymandev/protocol";
import type {
  AccountStatus,
  ProviderConnectionStatusView,
  RegisterProviderConnectionRefusal,
  RegisterProviderConnectionResult,
  RemoveProviderConnectionRefusal,
  RemoveProviderConnectionResult,
} from "../../shared/ipc-contract.ts";
import type { AccountService } from "../account.ts";
import {
  type WorkspaceActionFailure,
  type WorkspaceActionResult,
  workspaceActionMayHaveSent,
} from "../api-actions.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { ConnectionClient } from "../connection/client.ts";
import {
  type GrantStoreService,
  signedInDevice,
} from "../permissions/grant-store.ts";
import type { ScheduleTimer } from "../runtime.ts";
import { workspaceRetryDelayMs } from "../workspace/service.ts";

/**
 * The status of one connection; see `PROVIDER_CONNECTION_STATUSES` of the
 * contract. The local credential check of #33 adds its statuses there and
 * its facts to `ProviderConnectionFacts`.
 */
export type ProviderConnectionStatus = ProviderConnectionStatusView;

/** What the main process knows of a connection, the input of its status. */
export interface ProviderConnectionFacts {
  /**
   * The server listed the connection in the last read, that read
   * succeeded, and this device is connected.
   */
  readonly listCurrent: boolean;
}

/**
 * The status of a connection from its facts, from a closed list (a default
 * until the Project Manager decides, 2026-11-24): `registered` while the
 * list is current, else `unknown`. It reads no credential and asks no
 * permission: it is the person's own device describing itself.
 */
export function providerConnectionStatus(
  facts: ProviderConnectionFacts,
): ProviderConnectionStatus {
  return facts.listCurrent ? "registered" : "unknown";
}

/**
 * - `signed_out`: no signed-in device with a ready key; the list is empty.
 * - `loading`: the list has not loaded yet for this device.
 * - `ready`: it loaded. It stays `ready` during later reads.
 * - `unavailable`: the last read failed; `problem` holds the failure until
 *   a read succeeds. What was read before stays, each connection `unknown`.
 */
export type ProviderConnectionListStatus =
  "signed_out" | "loading" | "ready" | "unavailable";

/** A connection of this device with its status. Every value is frozen. */
export interface ProviderConnectionEntry {
  readonly id: ProviderConnection["id"];
  readonly kind: ProviderConnection["kind"];
  readonly label: string;
  readonly createdAt: string;
  readonly status: ProviderConnectionStatus;
}

/** The service's state. Every value is frozen. */
export interface ProviderConnectionsState {
  /** Grows by one with every change. */
  readonly revision: number;
  readonly status: ProviderConnectionListStatus;
  /** Only with `unavailable`. */
  readonly problem?: WorkspaceReadFailure;
  /** The server's list, in its order: the oldest first. */
  readonly connections: readonly ProviderConnectionEntry[];
}

/** The part of the account service that the service uses. */
export type ProviderConnectionAccount = Pick<
  AccountService,
  | "status"
  | "onStatusChange"
  | "readWorkspaceData"
  | "onReadsResumed"
  | "sendWorkspaceAction"
>;

/** The part of the connection client that the service uses; no way to send. */
export type ProviderConnectionConnection = Pick<
  ConnectionClient,
  "status" | "onStatusChange"
>;

export interface ProviderConnectionServiceOptions {
  readonly account: ProviderConnectionAccount;
  readonly connection: ProviderConnectionConnection;
  /**
   * The grant store, told after a removal that may have reached the API,
   * which revokes the connection's `provider.use` grants. Optional for
   * tests.
   */
  readonly grants?: Pick<GrantStoreService, "ownGrantAnswered">;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /**
   * Receives fixed messages with a failure code at most, never a label or
   * an ID. An error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface ProviderConnectionService {
  /** The current state. */
  readonly state: () => ProviderConnectionsState;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onChange: (
    listener: (state: ProviderConnectionsState) => void,
  ) => () => void;
  /**
   * Registers a connection of this device with its kind and label, checked
   * with the protocol's request schema first. Never rejects.
   */
  readonly register: (
    kind: string,
    label: string,
  ) => Promise<RegisterProviderConnectionResult>;
  /** Removes a connection of the list held now by its ID. Never rejects. */
  readonly remove: (
    providerConnectionId: string,
  ) => Promise<RemoveProviderConnectionResult>;
  /** Stops listening and cancels the retry, for the quit. */
  readonly close: () => void;
}

/**
 * Each failure of a write and what a registration answers: every code of
 * `PROVIDER_CONNECTION_ROUTE_ERRORS.registerProviderConnection` beyond the
 * common ones has its own refusal; `bad_request` is `failed`,
 * `unauthorized` `not_signed_in`, and `internal_error` `unknown`, as for
 * every write.
 */
const REGISTER_OUTCOMES = {
  invalid: "invalid",
  too_soon: "too_soon",
  not_signed_in: "not_signed_in",
  unavailable: "unavailable",
  forbidden: "failed",
  not_found: "failed",
  conflict: "failed",
  already_member: "failed",
  invitation_invalid: "failed",
  join_requests_closed: "failed",
  workspace_not_found: "failed",
  device_too_new: "failed",
  unclaimed_limit: "failed",
  project_limit: "failed",
  repository_limit: "failed",
  grant_limit: "failed",
  provider_connection_limit: "provider_connection_limit",
  rate_limited: "rate_limited",
  unknown: "unknown",
  failed: "failed",
} satisfies Record<
  WorkspaceActionFailure,
  RegisterProviderConnectionRefusal | "unknown"
>;
Object.freeze(REGISTER_OUTCOMES);

/**
 * Each failure of a write and what a removal answers, after
 * `PROVIDER_CONNECTION_ROUTE_ERRORS.removeProviderConnection`.
 */
const REMOVE_OUTCOMES = {
  ...REGISTER_OUTCOMES,
  not_found: "not_found",
  conflict: "conflict",
  provider_connection_limit: "failed",
} satisfies Record<
  WorkspaceActionFailure,
  RemoveProviderConnectionRefusal | "unknown"
>;
Object.freeze(REMOVE_OUTCOMES);

const UNKNOWN = Object.freeze({ outcome: "unknown" } as const);
const OK = Object.freeze({ outcome: "ok" } as const);
const NO_CONNECTIONS: readonly ProviderConnectionEntry[] = Object.freeze([]);

type Refused<R extends string> = {
  readonly outcome: "refused";
  readonly reason: R;
  readonly retryAfterMs: number | null;
};

function refused<R extends string>(
  reason: R,
  retryAfterMs: number | null = null,
): Refused<R> {
  return Object.freeze({ outcome: "refused", reason, retryAfterMs });
}

/** The result of a failed write, with its wait for `too_soon` and `rate_limited`. */
function failedResult<R extends string>(
  outcomes: Readonly<Record<WorkspaceActionFailure, R | "unknown">>,
  result: Extract<WorkspaceActionResult<unknown>, { ok: false }>,
): Refused<R> | typeof UNKNOWN {
  const outcome = outcomes[result.reason];
  if (outcome === "unknown") {
    return UNKNOWN;
  }
  return "retryAfterMs" in result
    ? refused(outcome, result.retryAfterMs)
    : refused(outcome);
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export function createProviderConnectionService(
  options: ProviderConnectionServiceOptions,
): ProviderConnectionService {
  const { account, connection, grants } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? (() => performance.now());

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  /** The signed-in device, only compared; it never reaches the state or a log. */
  let device: string | null = null;
  /** Changes with every reset, so that an answer for an earlier device is dropped. */
  let epoch = 0;
  let connected = false;
  /** A sign-in runs: reads answer `unavailable` meanwhile, so a read waits. */
  let signInRunning = false;
  /** A read waits for the sign-in that runs to end. */
  let readWaiting = false;
  /** A read was held back by the account service and waits for `onReadsResumed`. */
  let heldBack = false;

  let list: readonly ProviderConnection[] | null = null;
  let problem: WorkspaceReadFailure | null = null;
  let inFlight = false;
  /** A read was asked for while one was on its way: its answer is dropped. */
  let again = false;
  /** The failed reads in a row, for the backoff. */
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;
  /** When the wait after `rate_limited` ends, on the monotonic clock, or null. */
  let rateLimitedUntil: number | null = null;
  /** A write is waiting for its answer. */
  let writing = false;

  let revision = 0;
  let dirty = false;
  let current = buildState();
  const listeners = new Set<(state: ProviderConnectionsState) => void>();

  function buildState(): ProviderConnectionsState {
    if (device === null) {
      return Object.freeze({
        revision,
        status: "signed_out",
        connections: NO_CONNECTIONS,
      });
    }
    const listCurrent = problem === null && connected;
    const status = providerConnectionStatus({ listCurrent });
    const connections =
      list === null
        ? NO_CONNECTIONS
        : Object.freeze(
            list.map((item) =>
              Object.freeze({
                id: item.id,
                kind: item.kind,
                label: item.label,
                createdAt: item.createdAt,
                status,
              }),
            ),
          );
    if (problem !== null) {
      return Object.freeze({
        revision,
        status: "unavailable",
        problem,
        connections,
      });
    }
    return Object.freeze({
      revision,
      status: list === null ? "loading" : "ready",
      connections,
    });
  }

  function touch(): void {
    dirty = true;
  }

  function flush(): void {
    if (!dirty || closed) {
      return;
    }
    dirty = false;
    revision += 1;
    const state = buildState();
    current = state;
    for (const listener of [...listeners]) {
      // A listener that changed the state again has notified everyone of
      // the newer state already.
      if (current !== state) {
        return;
      }
      try {
        listener(state);
      } catch {
        log("A provider connection state listener failed.");
      }
    }
  }

  /** Runs one entry point and then publishes what it changed. */
  function run<T>(action: () => T): T {
    try {
      return action();
    } finally {
      flush();
    }
  }

  function stopRetry(): void {
    cancelRetry?.();
    cancelRetry = null;
  }

  /** Forgets everything: a sign-out, another account, or another device. */
  function reset(): void {
    epoch += 1;
    inFlight = false;
    again = false;
    readWaiting = false;
    heldBack = false;
    stopRetry();
    list = null;
    problem = null;
    attempt = 0;
    rateLimitedUntil = null;
    touch();
  }

  /** How long the wait after `rate_limited` still runs; 0 when it ended. */
  function rateLimitWait(): number {
    if (rateLimitedUntil === null) {
      return 0;
    }
    const left = rateLimitedUntil - now();
    if (left <= 0) {
      rateLimitedUntil = null;
      return 0;
    }
    return left;
  }

  /**
   * Reads the list for the device that is signed in: at the end of a wait
   * after `rate_limited`, after a sign-in that runs, or after the read on
   * its way, whose answer is then dropped.
   */
  function reload(): void {
    if (closed || device === null) {
      return;
    }
    const wait = rateLimitWait();
    if (wait > 0) {
      if (cancelRetry === null) {
        scheduleRetry(wait);
      }
      return;
    }
    stopRetry();
    if (signInRunning) {
      readWaiting = true;
      return;
    }
    if (inFlight) {
      again = true;
      return;
    }
    send();
  }

  function send(): void {
    inFlight = true;
    again = false;
    heldBack = false;
    const sent = epoch;
    void account
      .readWorkspaceData("listProviderConnections", {})
      .catch((): WorkspaceReadResult<never> => {
        log("The provider connections could not be read.");
        return Object.freeze({ ok: false, reason: "unavailable" });
      })
      .then((result) => run(() => answered(sent, result)));
  }

  function answered(
    sent: number,
    result: WorkspaceReadResult<ProviderConnectionListResponse>,
  ): void {
    if (closed || sent !== epoch) {
      return;
    }
    inFlight = false;
    if (again) {
      // A trigger came after this read was sent: only a newer answer counts.
      again = false;
      if (!result.ok && result.reason === "rate_limited") {
        // Shown as any failed read: nothing reads until its wait ended,
        // and the read asked for goes then.
        readFailed(result.reason);
        return;
      }
      reload();
      return;
    }
    if (!result.ok && result.heldBack === true) {
      // Never sent: not a failed read. It goes once reads go on.
      heldBack = true;
      return;
    }
    if (!result.ok) {
      readFailed(result.reason);
      return;
    }
    list = Object.freeze([...result.value.providerConnections]);
    problem = null;
    attempt = 0;
    rateLimitedUntil = null;
    touch();
  }

  function readFailed(reason: WorkspaceReadFailure): void {
    problem = reason;
    touch();
    log(`The provider connections did not load (${reason}).`);
    const delayMs = workspaceRetryDelayMs(attempt, reason);
    if (reason === "rate_limited") {
      rateLimitedUntil = now() + delayMs;
    }
    // Offline, the next `connected` reads anyway.
    if (connected) {
      scheduleRetry(delayMs);
    }
    attempt += 1;
  }

  function scheduleRetry(delayMs: number): void {
    stopRetry();
    cancelRetry = schedule(() => {
      run(() => {
        cancelRetry = null;
        rateLimitedUntil = null;
        reload();
      });
    }, delayMs);
  }

  function accountChanged(status: AccountStatus): void {
    const next = signedInDevice(status);
    if (next !== device) {
      if (device !== null) {
        reset();
      }
      device = next;
      touch();
      // The new device's list loads once no sign-in runs.
      readWaiting = next !== null;
    }
    signInRunning = status.signIn.kind !== "idle";
    if (readWaiting && !signInRunning) {
      readWaiting = false;
      reload();
    }
  }

  function connectionChanged(state: string): void {
    const isConnected = state === "connected";
    if (isConnected === connected) {
      return;
    }
    connected = isConnected;
    // The status of every connection follows the connection.
    touch();
    if (isConnected) {
      // A read on its way is good enough: the status of each connection
      // comes from `connected` when the state is built, not from the read.
      if (!inFlight) {
        reload();
      }
      return;
    }
    stopRetry();
  }

  function readsResumed(): void {
    if (heldBack) {
      heldBack = false;
      reload();
    }
  }

  /**
   * Runs one write: one at a time, never sent again, and the list read
   * again after it whenever it may have reached the API.
   */
  async function write<T>(
    call: () => Promise<WorkspaceActionResult<T>>,
    after: () => void,
  ): Promise<WorkspaceActionResult<T> | null> {
    writing = true;
    const started = epoch;
    let answer: WorkspaceActionResult<T> | null;
    try {
      answer = await call();
    } catch {
      log("A provider connection write could not be sent.");
      answer = null;
    } finally {
      writing = false;
    }
    if (answer === null || workspaceActionMayHaveSent(answer)) {
      after();
      // A reset meanwhile reads the new device's list by itself.
      if (started === epoch) {
        run(() => reload());
      }
    }
    return answer;
  }

  async function register(
    kind: string,
    label: string,
  ): Promise<RegisterProviderConnectionResult> {
    const body = RegisterProviderConnectionRequestSchema.safeParse({
      kind,
      label,
    });
    if (!body.success) {
      return refused("invalid");
    }
    if (closed) {
      return refused("unavailable");
    }
    if (device === null) {
      return refused("not_signed_in");
    }
    // One at a time: a second press while the first waits is refused, never
    // queued, because a queued one would still reach the server.
    if (writing) {
      return refused("busy");
    }
    const sent = body.data;
    const answer = await write<RegisterProviderConnectionResponse>(
      () => account.sendWorkspaceAction("registerProviderConnection", {}, sent),
      () => undefined,
    );
    if (answer === null) {
      return UNKNOWN;
    }
    if (!answer.ok) {
      return failedResult(REGISTER_OUTCOMES, answer);
    }
    const { providerConnection } = answer.value;
    // A connection of another kind or label is not this write's answer.
    return providerConnection.kind === sent.kind &&
      providerConnection.label === sent.label
      ? OK
      : UNKNOWN;
  }

  async function remove(
    value: string,
  ): Promise<RemoveProviderConnectionResult> {
    const parsed = ProviderConnectionIdSchema.safeParse(value);
    if (!parsed.success) {
      return refused("invalid");
    }
    if (closed) {
      return refused("unavailable");
    }
    if (device === null) {
      return refused("not_signed_in");
    }
    const providerConnectionId = parsed.data;
    if (list?.some((item) => item.id === providerConnectionId) !== true) {
      return refused("not_listed");
    }
    if (writing) {
      return refused("busy");
    }
    const answer = await write<null>(
      () =>
        account.sendWorkspaceAction("removeProviderConnection", {
          providerConnectionId,
        }),
      () => {
        // The server revokes the connection's `provider.use` grants in the
        // same transaction; their events may be lost.
        try {
          grants?.ownGrantAnswered();
        } catch {
          log("The grant records could not be read again.");
        }
      },
    );
    if (answer === null) {
      return UNKNOWN;
    }
    return answer.ok ? OK : failedResult(REMOVE_OUTCOMES, answer);
  }

  const removers = [
    account.onStatusChange((status) => run(() => accountChanged(status))),
    account.onReadsResumed(() => run(readsResumed)),
    connection.onStatusChange((status) =>
      run(() => connectionChanged(status.state)),
    ),
  ];
  connected = connection.status().state === "connected";
  accountChanged(account.status());
  // The first state is revision 0.
  current = buildState();
  dirty = false;

  return Object.freeze({
    state: () => current,
    onChange: (listener: (state: ProviderConnectionsState) => void) => {
      const entry = (state: ProviderConnectionsState) => listener(state);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    register,
    remove,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const remover of removers) {
        remover();
      }
      listeners.clear();
      stopRetry();
    },
  });
}
