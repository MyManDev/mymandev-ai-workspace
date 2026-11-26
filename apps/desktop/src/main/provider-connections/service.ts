// This device's AI provider connections (#32; #295 and the Project
// Manager's decisions of 2026-11-20 and 2026-11-23), in the main process:
// the list that the server holds for this device (`GET
// /provider-connections`, read with the account service's
// `readWorkspaceData`, the same read as the permission screen's), a status
// for each connection, and the two writes, registering and removing a
// connection, sent with `sendWorkspaceAction`.
//
// - Metadata to the server. A connection is its ID, its kind, its label,
//   and when it was registered. A registration sends the kind and the label
//   only; no key ever leaves the device.
// - The API key of a connection (#33, the Project Manager's decisions of
//   2026-11-25) stays on this device, in the provider key store
//   (provider-keys/store.ts), encrypted with the system's protection and
//   bound to this device's ID and the connection's ID. `saveKey` takes it
//   from the renderer once and stores it; `removeKey` deletes it. No state,
//   result, or log holds a key, and nothing here sends one anywhere.
// - Key actions. One at a time, and none while a registration or a removal
//   runs, including the removal's deletion of the key file: such a key
//   action is refused as `busy` and never reaches the store. A key action
//   is accepted only for a connection of the list held now that no
//   confirmed removal named (`not_listed`), so that no key is stored for a
//   connection that the server removed while the list still shows it.
// - A key stored while the device signs out stays: it is bound to this
//   device's ID, which the next sign-in opens again, and every enforcement
//   check is denied while signed out (D4). A key stored while the device
//   changes, or while its device key is deleted (the device was removed or
//   revoked, "This is not me", a lost key), is deleted again, because no
//   later device can open it.
// - Status. The status of each connection is computed here from a closed
//   list (`providerConnectionStatus`): `unknown` while this device is
//   offline or the last list read failed; otherwise `ready` when the key
//   file of the connection exists and decrypts for this device and this
//   connection, `credential_missing` when there is none or it is damaged or
//   bound elsewhere, and `unknown` while it was not checked yet or could
//   not be checked. `ready` does not say that the provider accepts the key:
//   no provider is called. Each listed connection is checked once after a
//   list read lists it, and again after its key was stored or removed. A
//   status check is the person acting on their own device, not a
//   `provider.use` action, so it asks the permission enforcement point
//   nothing.
// - Removal. A connection's key file is deleted only after the server
//   confirmed its removal (`ok`); every other answer keeps it. From that
//   answer on, until the next reset, every key action for the connection is
//   refused as `not_listed`, also while the list read after it waits.
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
// The state holds no device ID, user ID, token, or key. The logs are fixed
// text with a failure code at most, never a label, an ID, or a key.
import {
  type ProviderConnection,
  type ProviderConnectionId,
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
  RemoveProviderKeyResult,
  SaveProviderKeyRefusal,
  SaveProviderKeyResult,
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
import { isProviderKeyError } from "../provider-keys/errors.ts";
import { isProviderKeyShape } from "../provider-keys/key-file.ts";
import type { ProviderKeyStore } from "../provider-keys/store.ts";
import type { ScheduleTimer } from "../runtime.ts";
import { workspaceRetryDelayMs } from "../workspace/service.ts";

/**
 * The status of one connection; see `PROVIDER_CONNECTION_STATUSES` of the
 * contract.
 */
export type ProviderConnectionStatus = ProviderConnectionStatusView;

/**
 * What the last check of a connection's key on this device found: `ready`
 * (a key file exists and decrypts for this device and this connection),
 * `missing` (no usable key: no file, a damaged one, or one bound to another
 * device or connection), or `unknown` (not checked yet, or the check
 * failed otherwise, for example when the system could not decrypt it).
 */
export type ProviderKeyState = "ready" | "missing" | "unknown";

/** What the main process knows of a connection, the input of its status. */
export interface ProviderConnectionFacts {
  /**
   * The server listed the connection in the last read, that read
   * succeeded, and this device is connected.
   */
  readonly listCurrent: boolean;
  /** What the last check of the connection's key found. */
  readonly key: ProviderKeyState;
}

/**
 * The status of a connection from its facts, from a closed list (#33):
 * `unknown` while the list is not current; otherwise `ready` for a key
 * that is `ready`, `credential_missing` for a `missing` one, and `unknown`
 * for a key that was not checked or could not be checked. It asks no
 * permission and calls no provider: it is the person's own device
 * describing itself.
 */
export function providerConnectionStatus(
  facts: ProviderConnectionFacts,
): ProviderConnectionStatus {
  if (!facts.listCurrent) {
    return "unknown";
  }
  switch (facts.key) {
    case "ready":
      return "ready";
    case "missing":
      return "credential_missing";
    case "unknown":
      return "unknown";
  }
}

/**
 * The key state after a check that failed: `missing` for a file that can
 * never open here (`corrupt`, `bound_elsewhere`), so the person is asked
 * for a key, and `unknown` for everything else, which may pass later (the
 * system could not decrypt it, the folder or the file could not be read, or
 * a newer version wrote it).
 */
export function providerKeyStateAfterFailure(error: unknown): ProviderKeyState {
  return isProviderKeyError(error, "corrupt") ||
    isProviderKeyError(error, "bound_elsewhere")
    ? "missing"
    : "unknown";
}

/** The fixed code of a key store failure for a log line, never a value. */
function failureCode(error: unknown): string {
  return isProviderKeyError(error) ? error.code : "unexpected";
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

/** The part of the provider key store that the service uses; no way to read a key. */
export type ProviderConnectionKeys = Pick<
  ProviderKeyStore,
  "save" | "check" | "remove"
>;

export interface ProviderConnectionServiceOptions {
  readonly account: ProviderConnectionAccount;
  readonly connection: ProviderConnectionConnection;
  /**
   * The provider key store (#33). Without it, as in tests of the list
   * alone, every listed connection is `credential_missing`, and storing or
   * removing a key is refused as `failed`.
   */
  readonly keys?: ProviderConnectionKeys;
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
  /**
   * Removes a connection of the list held now by its ID, and deletes its
   * key file once the server confirmed the removal. Never rejects.
   */
  readonly remove: (
    providerConnectionId: string,
  ) => Promise<RemoveProviderConnectionResult>;
  /**
   * Stores the API key of a connection of the list held now, bound to this
   * device and that connection, over any key stored before. The key is
   * checked for its shape only and never returned, kept, or logged. Refused
   * as `busy` while another key action, a registration, or a removal runs,
   * and as `not_listed` after the server confirmed the connection's
   * removal. A sign-out meanwhile keeps the stored key (`ok`); another
   * device or a deleted device key deletes it again (`not_signed_in`).
   * Never rejects.
   */
  readonly saveKey: (
    providerConnectionId: string,
    key: string,
  ) => Promise<SaveProviderKeyResult>;
  /**
   * Deletes the stored key of a connection of the list held now; `ok` also
   * when none was stored. Refused as `saveKey` is. Never rejects.
   */
  readonly removeKey: (
    providerConnectionId: string,
  ) => Promise<RemoveProviderKeyResult>;
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

/**
 * The device states in which this installation's device key is deleted or
 * replaced (see `DEVICE_STATES` of the contract): no usable device, a lost
 * key, a removal that the API confirmed, and a revocation. A plain sign-out
 * (`signed_out`, `sign_out_report_pending`) keeps the key.
 */
const DEVICE_KEY_ENDED_STATES: ReadonlySet<AccountStatus["device"]> = new Set([
  "no_device",
  "key_lost",
  "removed",
  "revoked",
]);

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
  const { account, connection, grants, keys } = options;
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
  /** A removal runs, from its write to the end of its key deletion. */
  let removing = false;
  /** A key action (`saveKey`, `removeKey`) runs. */
  let keyAction = false;
  /**
   * The connections whose removal the server confirmed since the last
   * reset: no key action names them, also while the list still holds them.
   */
  const removedConnections = new Set<string>();
  /** The last signed-in device, kept across a sign-out; only compared. */
  let lastDevice: string | null = null;
  /**
   * Grows whenever the signed-in device changes to another one, or the
   * device key ends (`DEVICE_KEY_ENDED_STATES`); a plain sign-out keeps it.
   */
  let deviceGeneration = 0;
  /** What the last check of each listed connection's key found. */
  const keyStates = new Map<string, ProviderKeyState>();
  /** The token of the check of each connection on its way; a newer one wins. */
  const keyChecks = new Map<string, number>();
  let lastKeyCheck = 0;

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
                status: providerConnectionStatus({
                  listCurrent,
                  key:
                    keys === undefined
                      ? "missing"
                      : (keyStates.get(item.id) ?? "unknown"),
                }),
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
    keyStates.clear();
    keyChecks.clear();
    removedConnections.clear();
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
    checkNewKeys();
  }

  /**
   * Forgets the key state of connections that the list no longer holds, and
   * checks the key of each listed connection that was not checked yet.
   */
  function checkNewKeys(): void {
    const listed = new Set<string>(list?.map((item) => item.id) ?? []);
    for (const id of [...keyStates.keys()]) {
      if (!listed.has(id)) {
        keyStates.delete(id);
      }
    }
    for (const id of listed) {
      if (!keyStates.has(id) && !keyChecks.has(id)) {
        checkKey(id);
      }
    }
  }

  /**
   * Checks the key of one connection for the device signed in now. The
   * answer applies only when no newer check of that connection started and
   * the device is the same. The plaintext never reaches the service.
   */
  function checkKey(id: string): void {
    if (keys === undefined || device === null || closed) {
      return;
    }
    lastKeyCheck += 1;
    const token = lastKeyCheck;
    const started = epoch;
    keyChecks.set(id, token);
    void keys
      .check({ deviceId: device, providerConnectionId: id })
      .then(
        (found): ProviderKeyState => (found === "ready" ? "ready" : "missing"),
        (error: unknown): ProviderKeyState => {
          log(`A provider key could not be checked (${failureCode(error)}).`);
          return providerKeyStateAfterFailure(error);
        },
      )
      .then((state) =>
        run(() => {
          if (closed || started !== epoch || keyChecks.get(id) !== token) {
            return;
          }
          keyChecks.delete(id);
          if (list?.some((item) => item.id === id) === true) {
            keyStates.set(id, state);
            touch();
          }
        }),
      );
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
    if (next !== null && lastDevice !== null && next !== lastDevice) {
      deviceGeneration += 1;
    }
    if (next !== null) {
      lastDevice = next;
    }
    // Without a device record (`signed_out`, as after "This is not me") or
    // in a state that deletes the device key, a key bound to the device
    // can no longer be opened by any later device.
    if (
      status.account.kind === "signed_out" ||
      DEVICE_KEY_ENDED_STATES.has(status.device)
    ) {
      deviceGeneration += 1;
    }
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
    // No key action starts until the key file of a confirmed removal is
    // deleted.
    removing = true;
    try {
      return await removeListed(providerConnectionId);
    } finally {
      removing = false;
    }
  }

  async function removeListed(
    providerConnectionId: ProviderConnectionId,
  ): Promise<RemoveProviderConnectionResult> {
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
    if (!answer.ok) {
      return failedResult(REMOVE_OUTCOMES, answer);
    }
    // The connection is gone at the server: from now on no key action
    // names it, although the list holds it until the next read answers.
    removedConnections.add(providerConnectionId);
    // The server confirmed the removal: only now is the key file deleted
    // (D4). A failure is logged; the file stays bound to a connection that
    // no longer exists, and the device's removal deletes it.
    if (keys !== undefined) {
      try {
        await keys.remove(providerConnectionId);
      } catch (error) {
        log(
          `The provider key of a removed connection could not be deleted (${failureCode(error)}).`,
        );
      }
    }
    return OK;
  }

  /**
   * The ID of a connection of the list held now for a key action, with
   * the device signed in now, or the refusal of the action: `not_listed`
   * also for a connection whose removal the server confirmed, and `busy`
   * while another key action, a registration, or a removal runs.
   */
  function keyTarget(
    value: string,
  ):
    | { readonly id: ProviderConnectionId; readonly deviceId: string }
    | Refused<"invalid" | "not_signed_in" | "not_listed" | "busy" | "failed"> {
    const parsed = ProviderConnectionIdSchema.safeParse(value);
    if (!parsed.success) {
      return refused("invalid");
    }
    if (closed || keys === undefined) {
      return refused("failed");
    }
    if (device === null) {
      return refused("not_signed_in");
    }
    const id = parsed.data;
    if (
      list?.some((item) => item.id === id) !== true ||
      removedConnections.has(id)
    ) {
      return refused("not_listed");
    }
    if (keyAction || writing || removing) {
      return refused("busy");
    }
    return { id, deviceId: device };
  }

  /** The refusal of a key store failure while storing a key. */
  function saveRefusal(error: unknown): SaveProviderKeyRefusal {
    if (isProviderKeyError(error, "system_protection_unavailable")) {
      return "protection_unavailable";
    }
    return isProviderKeyError(error, "invalid_key") ? "invalid" : "failed";
  }

  async function saveKey(
    value: string,
    key: string,
  ): Promise<SaveProviderKeyResult> {
    // The shape first, so that nothing else runs with a key that is not one.
    if (!isProviderKeyShape(key)) {
      return refused("invalid");
    }
    const target = keyTarget(value);
    if ("outcome" in target) {
      return target;
    }
    keyAction = true;
    try {
      return await storeKey(target, key);
    } finally {
      keyAction = false;
    }
  }

  async function storeKey(
    target: { readonly id: ProviderConnectionId; readonly deviceId: string },
    key: string,
  ): Promise<SaveProviderKeyResult> {
    const generation = deviceGeneration;
    try {
      await keys?.save(
        { deviceId: target.deviceId, providerConnectionId: target.id },
        key,
      );
    } catch (error) {
      log(`A provider key was not stored (${failureCode(error)}).`);
      return refused(saveRefusal(error));
    }
    if (generation !== deviceGeneration) {
      // Another device signed in, or the device key was deleted, while the
      // key was written: the file is bound to a device that no later
      // device can be, so it is deleted again.
      try {
        await keys?.remove(target.id);
      } catch (error) {
        log(
          `A provider key of a device that left could not be deleted (${failureCode(error)}).`,
        );
      }
      return refused("not_signed_in");
    }
    // A sign-out meanwhile keeps the key (D4): it is bound to this device,
    // and the next sign-in of this device checks it with the list.
    if (device === target.deviceId) {
      run(() => checkKey(target.id));
    }
    return OK;
  }

  async function removeKey(value: string): Promise<RemoveProviderKeyResult> {
    const target = keyTarget(value);
    if ("outcome" in target) {
      return target;
    }
    keyAction = true;
    const started = epoch;
    let result: RemoveProviderKeyResult = OK;
    try {
      await keys?.remove(target.id);
    } catch (error) {
      log(`A provider key could not be deleted (${failureCode(error)}).`);
      result = refused("failed");
    } finally {
      keyAction = false;
    }
    if (started === epoch) {
      run(() => checkKey(target.id));
    }
    return result;
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
    saveKey,
    removeKey,
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
