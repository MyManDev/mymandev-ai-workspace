// The grant store of this device (#55; ADR 0015, P-76; the Project
// Manager's decisions of 2026-11-19): the `GrantStore` of the enforcement
// core (`enforcement.ts`). It holds the last answer of `GET /grant-records`,
// read with the account service's `readWorkspaceData`, and it is the only
// source of the records that the core checks.
//
// - Freshness. A read is usable only while the selected workspace's
//   connection is live and the records were read again since its last
//   `workspace.subscribed`: a read sent before that frame does not count.
//   A lost or closed connection, a sign-out, another device or account,
//   another selected workspace, the end or refusal of its subscription, a
//   failed or refused read, and a list that the schema or the identity
//   check refuses make the store unusable at once, so every check denies.
// - Reads. After each `workspace.subscribed` of the selected workspace; on
//   `agent.grant.created` (the event names no device, and only the agent's
//   host device grants, so the store cannot tell a grant of this device
//   from another's) and on `agent.grant.revoked` for an agent that the held
//   records name, or while a read is on its way; and on the changes that
//   revoke grants in their own transaction (P-77): `workspace.member.removed`,
//   a server cancellation that disabled agents (`agent.run.state_changed`
//   with a code of `RUN_CANCEL_REASONS`; no event reports a disabled agent),
//   `account.device_revoked`, and `workspace.repository.removed`. Reads are
//   merged like the claim service's: while one is on its way, one more
//   follows its answer, which is dropped; a failed read is retried with the
//   workspace service's backoff while connected. An event never changes a
//   record; it only starts a read (P-76).
// - One answer. `read()` gives the records of one answer, frozen, or not
//   usable. Only records of the selected workspace are kept, because only
//   its events reach this device; the answer must name this device and the
//   account of the connection, or it is refused.
// - The change signal. `onGrantsChanged` calls its listeners whenever the
//   records change, the store becomes unusable, or a held grant reaches its
//   `expiresAt`. The future runtime re-checks its running work with the
//   enforcement point on each call and stops what is denied.
//
// The logs are fixed text with a failure code at most, never an ID.
import {
  type DeviceId,
  type GrantRecordListResponse,
  RUN_CANCEL_REASONS,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { GrantRecord } from "@mymandev/permissions";
import type { AccountStatus } from "../../shared/ipc-contract.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type {
  ConnectionClient,
  ConnectionIdentity,
  ServerMessage,
} from "../connection/client.ts";
import type { ScheduleTimer } from "../runtime.ts";
import {
  workspaceRetryDelayMs,
  type WorkspaceAccount,
  type WorkspaceService,
} from "../workspace/service.ts";
import type { GrantStore, GrantStoreRead } from "./enforcement.ts";

/**
 * The longest delay of one timer: Node fires a longer one at once. A grant
 * of `terminal.execute` may live 30 days, so the expiry timer waits in
 * steps.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The part of the connection client that the store uses: no way to send. */
export type GrantStoreConnection = Pick<
  ConnectionClient,
  "status" | "onStatusChange" | "onMessage" | "identity"
>;

export interface GrantStoreOptions {
  readonly account: Pick<
    WorkspaceAccount,
    "status" | "onStatusChange" | "readWorkspaceData"
  >;
  readonly connection: GrantStoreConnection;
  readonly workspaces: Pick<WorkspaceService, "state" | "onChange">;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** The wall clock in milliseconds, for the expiry signal; defaults to `Date.now`. */
  readonly wallClock?: () => number;
  /**
   * Receives fixed messages with a failure code at most, never an ID. An
   * error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface GrantStoreService extends GrantStore {
  /**
   * One consistent read: the frozen records of one answer while the store
   * is usable, or `usable: false` without records. It never reads the API.
   */
  readonly read: () => GrantStoreRead;
  /**
   * Calls `listener`, without arguments, after every change of the records,
   * when the store becomes unusable, and when a held grant reaches its
   * `expiresAt`. The result removes the listener. A listener that throws is
   * logged and changes nothing.
   *
   * The future runtime uses it to stop work that is no longer allowed
   * (decision of 2026-11-19): on each call it checks every running action
   * and process again with the enforcement point's `check`, for the run
   * that it holds, and kills the process tree and aborts the provider calls
   * of each one that is denied, reporting the run as cancelled. It never
   * takes records from the signal, and it never keeps a decision.
   */
  readonly onGrantsChanged: (listener: () => void) => () => void;
  /** Stops listening and cancels the timers, for the quit. Unusable from then on. */
  readonly close: () => void;
}

const UNUSABLE: GrantStoreRead = Object.freeze({
  usable: false,
  records: Object.freeze([]),
});

const scheduleWithSetTimeout: ScheduleTimer = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

/** A frozen copy of a record; every field below the facts is a value. */
function frozenRecord(record: GrantRecord): GrantRecord {
  const { agent, hostDevice, project, grantorMembership, providerConnection } =
    record.facts;
  return Object.freeze({
    grant: Object.freeze({ ...record.grant }),
    facts: Object.freeze({
      agent: Object.freeze({ ...agent }),
      hostDevice: Object.freeze({ ...hostDevice }),
      project: Object.freeze({ ...project }),
      grantorMembership:
        grantorMembership === null
          ? null
          : Object.freeze({ ...grantorMembership }),
      providerConnection:
        providerConnection === null
          ? null
          : Object.freeze({ ...providerConnection }),
    }),
  }) as GrantRecord;
}

/**
 * The signed-in device with a ready key, as its ID and its account's login,
 * or null.
 */
function signedInDevice(
  status: AccountStatus,
): { readonly deviceId: string; readonly key: string } | null {
  return status.apiOrigin === "set" &&
    status.device === "signed_in" &&
    status.deviceKey === "ready" &&
    status.account.kind === "signed_in"
    ? {
        deviceId: status.account.deviceId,
        key: `${status.account.deviceId} ${status.account.login}`,
      }
    : null;
}

function sameIdentity(
  a: ConnectionIdentity | null,
  b: ConnectionIdentity | null,
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.userId === b.userId &&
    a.deviceId === b.deviceId
  );
}

/** Whether every record names the device and the account of `identity`. */
function namesIdentity(
  records: readonly GrantRecord[],
  identity: ConnectionIdentity,
): boolean {
  const deviceId: DeviceId = identity.deviceId;
  return records.every(
    ({ grant, facts }) =>
      grant.grantedByUserId === identity.userId &&
      facts.agent.hostDeviceId === deviceId &&
      facts.hostDevice.id === deviceId &&
      (facts.providerConnection === null ||
        facts.providerConnection.hostDeviceId === deviceId),
  );
}

export function createGrantStore(
  options: GrantStoreOptions,
): GrantStoreService {
  const { account, connection, workspaces } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const wallClock = options.wallClock ?? (() => Date.now());

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  /** The signed-in device, or null. */
  let device: ReturnType<typeof signedInDevice> = null;
  let connected = false;
  let selected: WorkspaceId | null = null;
  /** Whether `workspace.subscribed` of `selected` came on this connection. */
  let subscribed = false;
  /** Changes at every drop; an answer of an earlier epoch is dropped. */
  let epoch = 0;
  let inFlight = false;
  /** A trigger came while a read was on its way: its answer is dropped. */
  let again = false;
  /** The failed reads in a row, for the backoff. */
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;
  let cancelExpiry: (() => void) | null = null;

  /** The read that `read()` gives. */
  let current: GrantStoreRead = UNUSABLE;
  /** The records of `current` as JSON, or null while unusable. */
  let currentKey: string | null = null;
  /** `currentKey` when the listeners were last told. */
  let publishedKey: string | null = null;
  /** A held grant reached its expiry since the listeners were last told. */
  let expired = false;
  const listeners = new Set<() => void>();

  function setUnusable(): void {
    current = UNUSABLE;
    currentKey = null;
  }

  function setRecords(records: readonly GrantRecord[]): void {
    const key = JSON.stringify(records);
    if (key === currentKey) {
      return;
    }
    current = Object.freeze({
      usable: true,
      records: Object.freeze(records.map(frozenRecord)),
    });
    currentKey = key;
  }

  /** Tells the listeners about a change since the last time. */
  function flush(): void {
    if (currentKey === publishedKey && !expired) {
      return;
    }
    publishedKey = currentKey;
    expired = false;
    scheduleExpiry();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        log("A grant change listener failed.");
      }
    }
  }

  /** Runs one entry point and publishes the change. */
  function run(action: () => void): void {
    try {
      action();
    } finally {
      flush();
    }
  }

  /**
   * Schedules the signal at the earliest `expiresAt` of the held grants that
   * lies ahead.
   */
  function scheduleExpiry(): void {
    cancelExpiry?.();
    cancelExpiry = null;
    if (closed || !current.usable) {
      return;
    }
    const nowMs = wallClock();
    let next = Number.POSITIVE_INFINITY;
    for (const { grant } of current.records) {
      const at =
        grant.expiresAt === null ? Number.NaN : Date.parse(grant.expiresAt);
      if (at > nowMs && at < next) {
        next = at;
      }
    }
    if (next === Number.POSITIVE_INFINITY) {
      return;
    }
    cancelExpiry = schedule(
      () =>
        run(() => {
          cancelExpiry = null;
          if (wallClock() >= next) {
            expired = true;
          } else {
            // A step of a long wait, or a timer that fired early.
            scheduleExpiry();
          }
        }),
      Math.min(next - nowMs, MAX_TIMER_MS),
    );
  }

  function stopRetry(): void {
    cancelRetry?.();
    cancelRetry = null;
  }

  /** Drops the records and the answers on their way: unusable at once. */
  function drop(): void {
    epoch += 1;
    inFlight = false;
    again = false;
    attempt = 0;
    stopRetry();
    setUnusable();
  }

  /** Whether a read may be sent now. */
  function mayRead(): boolean {
    return (
      !closed && device !== null && connected && selected !== null && subscribed
    );
  }

  /**
   * Reads the records. While a read is on its way, its answer is dropped and
   * they are read again after it; while a retry waits, the retry reads them.
   */
  function request(): void {
    if (!mayRead()) {
      return;
    }
    if (inFlight) {
      again = true;
      return;
    }
    if (cancelRetry !== null) {
      return;
    }
    send();
  }

  function send(): void {
    inFlight = true;
    again = false;
    const sent = epoch;
    const identity = connection.identity();
    void account
      .readWorkspaceData("listGrantRecords", {})
      .catch((): WorkspaceReadResult<never> => ({
        ok: false,
        reason: "unavailable",
      }))
      .then((result) => run(() => answered(sent, identity, result)));
  }

  function answered(
    sent: number,
    sentIdentity: ConnectionIdentity | null,
    result: WorkspaceReadResult<GrantRecordListResponse>,
  ): void {
    if (closed || sent !== epoch) {
      return;
    }
    inFlight = false;
    if (!result.ok) {
      // A failed read is not a usable read, also when a newer one follows.
      setUnusable();
    }
    if (again && (result.ok || result.reason !== "rate_limited")) {
      // A trigger came after this read was sent: only a newer answer counts.
      request();
      return;
    }
    again = false;
    if (!result.ok) {
      readFailed(result.reason);
      return;
    }
    const identity = connection.identity();
    if (
      identity === null ||
      identity.deviceId !== device?.deviceId ||
      !sameIdentity(identity, sentIdentity) ||
      !namesIdentity(result.value.records, identity)
    ) {
      // The answer names another device or account than the connection.
      setUnusable();
      readFailed("failed");
      return;
    }
    attempt = 0;
    setRecords(
      result.value.records.filter(
        (record) => record.facts.project.workspaceId === selected,
      ),
    );
  }

  function readFailed(reason: WorkspaceReadFailure): void {
    log(`The grant records did not load (${reason}).`);
    if (connected) {
      // Offline, the next `workspace.subscribed` reads anyway.
      cancelRetry = schedule(
        () => {
          run(() => {
            cancelRetry = null;
            request();
          });
        },
        workspaceRetryDelayMs(attempt, reason),
      );
    }
    attempt += 1;
  }

  function accountChanged(status: AccountStatus): void {
    const next = signedInDevice(status);
    if (next?.key !== device?.key) {
      device = next;
      subscribed = false;
      drop();
    }
  }

  function connectionChanged(state: string): void {
    const next = state === "connected";
    if (next === connected) {
      return;
    }
    connected = next;
    // A new connection is live for the selected workspace only after its
    // `workspace.subscribed`.
    subscribed = false;
    drop();
  }

  function workspacesChanged(): void {
    const state = workspaces.state();
    const next =
      state.status === "signed_out" ? null : state.selectedWorkspaceId;
    if (next !== selected) {
      selected = next;
      subscribed = false;
      drop();
    }
  }

  function messageReceived(message: ServerMessage): void {
    if (selected === null) {
      return;
    }
    if (message.kind === "frame") {
      const frame = message.frame;
      switch (frame.type) {
        case "workspace.subscribed":
          if (frame.workspaceId === selected) {
            // Only a read sent after this frame counts.
            subscribed = true;
            drop();
            request();
          }
          return;
        case "workspace.unsubscribed":
        case "workspace.subscribe_refused":
          if (frame.workspaceId === selected) {
            subscribed = false;
            drop();
          }
          return;
        case "account.device_revoked":
          request();
          return;
        default:
          return;
      }
    }
    const event = message.event;
    if (event.workspaceId !== selected) {
      return;
    }
    switch (event.type) {
      case "agent.grant.created":
      case "workspace.member.removed":
      case "workspace.repository.removed":
        request();
        return;
      case "agent.grant.revoked":
        if (
          inFlight ||
          current.records.some(
            (record) =>
              record.grant.granteeAgentId === event.payload.granteeAgentId,
          )
        ) {
          request();
        }
        return;
      case "agent.run.state_changed": {
        const reasons: readonly string[] = RUN_CANCEL_REASONS;
        if (
          event.actor.kind === "system" &&
          event.payload.state === "cancelled" &&
          event.payload.reason !== undefined &&
          reasons.includes(event.payload.reason)
        ) {
          // The server disabled agents of a revoked device or a removed
          // person, which revokes their grants.
          request();
        }
        return;
      }
      default:
        return;
    }
  }

  const removers = [
    account.onStatusChange((status) => run(() => accountChanged(status))),
    connection.onStatusChange((status) =>
      run(() => connectionChanged(status.state)),
    ),
    workspaces.onChange(() => run(workspacesChanged)),
    connection.onMessage((message) => run(() => messageReceived(message))),
  ];
  device = signedInDevice(account.status());
  connected = connection.status().state === "connected";
  workspacesChanged();

  return Object.freeze({
    read: () => current,
    onGrantsChanged: (listener: () => void) => {
      const entry = () => listener();
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    close: () => {
      if (closed) {
        return;
      }
      run(() => {
        closed = true;
        for (const remove of removers) {
          remove();
        }
        drop();
      });
      cancelExpiry?.();
      cancelExpiry = null;
      listeners.clear();
    },
  });
}
