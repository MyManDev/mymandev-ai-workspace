// The grant store of this device (#55; ADR 0015, P-76; the Project
// Manager's decisions of 2026-11-19, and of 2026-11-20 on #318): the
// `GrantStore` of the enforcement core (`enforcement.ts`). It holds the
// last answer of `GET /grant-records`, read with the account service's
// `readWorkspaceData`, and it is the only source of the records that the
// core checks.
//
// - Freshness. A read is usable only while the selected workspace's
//   connection is live and the records were read again since its last
//   `workspace.subscribed`: a read sent before that frame does not count.
//   A lost or closed connection (#316 bounds how long a silently lost one
//   stays connected), a sign-out, another device, another selected
//   workspace, the end or refusal of its subscription, a failed or refused
//   read, and a list that the schema or the identity check refuses make the
//   store unusable at once, so every check denies. Two exceptions keep the
//   held answer for at most `GRANT_READ_GRACE_MS` each (#318): a read that
//   the account service held back without sending it (`heldBack`) is not a
//   failed read, and the store reads again once its `onReadsResumed`
//   tells, counted from the first held-back read until a read is answered;
//   and a transient failure of a reread of the interval (`unavailable`,
//   such as the 30-second timeout or a server error, or `rate_limited`)
//   keeps it until the retry answers, counted from the failure. Each bound
//   ends by its timer or, should the timer be late, by the wall clock in
//   `read()`. A first read after the subscription still has to succeed.
// - Reads. After each `workspace.subscribed` of the selected workspace;
//   every `GRANT_REREAD_INTERVAL_MS` while it stays live, for revocations
//   that send no event and for missed events; on `agent.grant.created` (the
//   event names no device, and only the agent's host device grants, so the
//   store cannot tell a grant of this device from another's) and on
//   `agent.grant.revoked` for an agent that the held records name, or while
//   a read is on its way; and on the changes that revoke grants in their own
//   transaction (P-77): `workspace.member.removed`, a server cancellation
//   that disabled agents (`agent.run.state_changed` with a code of
//   `RUN_CANCEL_REASONS`; no event reports a disabled agent), the account
//   frame `account.device_revoked`, and `workspace.repository.removed`.
//   Reads are merged like the claim service's: while one is on its way, one
//   more follows its answer; a failed read is retried with the workspace
//   service's backoff while connected, and a held-back one when reads go
//   on.
// - Revocations. `agent.grant.revoked` leaves its grant out of `read()` at
//   once, until a read sent after the event answers (decision 1 of
//   2026-11-19 on #315). An event never adds or changes a record.
// - One answer. `read()` gives the records of one answer without the grants
//   revoked since, frozen, or not usable. Only records of the selected
//   workspace are kept, because only its events reach this device; the
//   answer must name this device and the account of the connection, or it is
//   refused.
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
import type { AccountService } from "../account.ts";
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
  type WorkspaceService,
} from "../workspace/service.ts";
import type { GrantStore, GrantStoreRead } from "./enforcement.ts";

/**
 * The longest delay of one timer: Node fires a longer one at once. A grant
 * of `terminal.execute` may live 30 days, so the expiry timer waits in
 * steps.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * How long a live store waits after sending a read before it reads again
 * (decision 3 of 2026-11-19 on #315).
 */
export const GRANT_REREAD_INTERVAL_MS = 5 * 60_000;

/**
 * How long the held answer stays usable, at most, after a transient failure
 * of a reread of the interval (until the retry answers; decision 2 of
 * 2026-11-20 on #318), and after the first of a run of reads that the
 * account service held back (until a read is answered; the Project
 * Manager's decision of 2026-11-20 on the review of #324).
 */
export const GRANT_READ_GRACE_MS = 60_000;

/**
 * Why a read is sent: `reread` only for the interval, `other` for
 * everything else (a subscription, an event, a retry). Merged reads take
 * `other` when any of their triggers was one.
 */
type ReadCause = "reread" | "other";

function mergeCause(
  a: ReadCause | null,
  b: ReadCause | null,
): ReadCause | null {
  return a === "other" || b === "other" ? "other" : (a ?? b);
}

/** A bound of the held answer (#318). */
interface Bound {
  cancel: (() => void) | null;
  endsAt: number | null;
  /** The log when it ends. */
  readonly message: string;
}

/** The failures of a sent read that may pass, with a held answer (#318). */
function isTransient(reason: WorkspaceReadFailure): boolean {
  return reason === "unavailable" || reason === "rate_limited";
}

/** The part of the connection client that the store uses: no way to send. */
export type GrantStoreConnection = Pick<
  ConnectionClient,
  "status" | "onStatusChange" | "onMessage" | "identity"
>;

export interface GrantStoreOptions {
  readonly account: Pick<
    AccountService,
    "status" | "onStatusChange" | "readWorkspaceData" | "onReadsResumed"
  >;
  readonly connection: GrantStoreConnection;
  readonly workspaces: Pick<WorkspaceService, "state" | "onChange">;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** Defaults to `GRANT_REREAD_INTERVAL_MS`. */
  readonly rereadIntervalMs?: number;
  /**
   * The wall clock in milliseconds, for the expiry signal and the end of
   * `GRANT_READ_GRACE_MS`; defaults to `Date.now`.
   */
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
 * The ID of the signed-in device with a ready key, or null. The login is left
 * out: a changed login of the same device keeps the records, whose account is
 * checked against the connection's `userId`.
 */
function signedInDevice(status: AccountStatus): string | null {
  return status.apiOrigin === "set" &&
    status.device === "signed_in" &&
    status.deviceKey === "ready" &&
    status.account.kind === "signed_in"
    ? status.account.deviceId
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
  const rereadIntervalMs = options.rereadIntervalMs ?? GRANT_REREAD_INTERVAL_MS;

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  /** The ID of the signed-in device, or null. */
  let device: string | null = null;
  let connected = false;
  let selected: WorkspaceId | null = null;
  /** Whether `workspace.subscribed` of `selected` came on this connection. */
  let subscribed = false;
  /** Changes at every drop; an answer of an earlier epoch is dropped. */
  let epoch = 0;
  let inFlight = false;
  /**
   * A trigger came while a read was on its way: one more read follows it,
   * for this cause. Null without one.
   */
  let next: ReadCause | null = null;
  /**
   * A read that the account service held back waits for `onReadsResumed`,
   * for this cause; null when none waits (#318).
   */
  let waiting: ReadCause | null = null;
  /** The reads sent so far; the number of each read. */
  let sentReads = 0;
  /** The failed reads in a row, for the backoff. */
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;
  let cancelReread: (() => void) | null = null;
  let cancelExpiry: (() => void) | null = null;
  /**
   * The bound of the held answer after a transient failure of a reread
   * (`grace`), and after the first of a run of held-back reads (`hold`):
   * the timer's cancel and the end on `wallClock`, both null while none
   * runs (#318).
   */
  const grace: Bound = {
    cancel: null,
    endsAt: null,
    message: "The grant records were not read again in time.",
  };
  const hold: Bound = {
    cancel: null,
    endsAt: null,
    message: "The grant records waited too long for the account.",
  };

  /** The selected workspace's records of the held answer, or null while unusable. */
  let held: readonly GrantRecord[] | null = null;
  /**
   * The grants of `agent.grant.revoked` events not yet covered by an answer,
   * each with `sentReads` at its event: only a later read's answer covers it.
   */
  const revoked = new Map<string, number>();
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
    held = null;
    current = UNUSABLE;
    currentKey = null;
  }

  /** Sets `current` to the held records without the revoked grants. */
  function setCurrent(): void {
    if (held === null) {
      return;
    }
    const records = held.filter((record) => !revoked.has(record.grant.id));
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

  function endBound(bound: Bound): void {
    bound.cancel?.();
    bound.cancel = null;
    bound.endsAt = null;
  }

  /**
   * Keeps the held answer for at most `GRANT_READ_GRACE_MS` from now (#318),
   * and not past `until` when one is given; a bound that would end by then
   * ends at once.
   */
  function startBound(bound: Bound, until: number | null = null): void {
    const now = wallClock();
    const endsAt = Math.min(now + GRANT_READ_GRACE_MS, until ?? Infinity);
    if (endsAt <= now) {
      expire(bound);
      return;
    }
    bound.endsAt = endsAt;
    bound.cancel = schedule(
      () =>
        run(() => {
          bound.cancel = null;
          expire(bound);
        }),
      endsAt - now,
    );
  }

  /** Ends `bound`: the store is unusable until a read succeeds. */
  function expire(bound: Bound): void {
    endBound(bound);
    log(bound.message);
    setUnusable();
  }

  /**
   * Ends each bound whose end has passed on the wall clock, also before its
   * timer fires. True when one did.
   */
  function expireLate(): boolean {
    let late = false;
    for (const bound of [grace, hold]) {
      if (bound.endsAt !== null && wallClock() >= bound.endsAt) {
        expire(bound);
        late = true;
      }
    }
    return late;
  }

  /**
   * Drops the records, the revoked grants, and the answers on their way:
   * unusable at once.
   */
  function drop(): void {
    epoch += 1;
    inFlight = false;
    next = null;
    waiting = null;
    attempt = 0;
    stopRetry();
    endBound(grace);
    endBound(hold);
    cancelReread?.();
    cancelReread = null;
    revoked.clear();
    setUnusable();
  }

  /** Whether a read may be sent now. */
  function mayRead(): boolean {
    return (
      !closed && device !== null && connected && selected !== null && subscribed
    );
  }

  /**
   * Reads the records. While a read is on its way, they are read again after
   * its answer; while a retry waits, the retry reads them.
   */
  function request(cause: ReadCause): void {
    if (!mayRead()) {
      return;
    }
    if (inFlight) {
      next = mergeCause(next, cause);
      return;
    }
    if (cancelRetry !== null) {
      return;
    }
    send(cause);
  }

  function send(given: ReadCause): void {
    // A held-back read that waits is sent with this one.
    const cause = mergeCause(given, waiting) ?? given;
    inFlight = true;
    next = null;
    waiting = null;
    sentReads += 1;
    const number = sentReads;
    const sent = epoch;
    const identity = connection.identity();
    cancelReread?.();
    cancelReread = schedule(
      () =>
        run(() => {
          cancelReread = null;
          request("reread");
        }),
      rereadIntervalMs,
    );
    void account
      .readWorkspaceData("listGrantRecords", {})
      .catch((): WorkspaceReadResult<never> => ({
        ok: false,
        reason: "unavailable",
      }))
      .then((result) =>
        run(() => answered(sent, number, identity, cause, result)),
      );
  }

  function answered(
    sent: number,
    number: number,
    sentIdentity: ConnectionIdentity | null,
    cause: ReadCause,
    result: WorkspaceReadResult<GrantRecordListResponse>,
  ): void {
    if (closed || sent !== epoch) {
      return;
    }
    inFlight = false;
    if (!result.ok && result.heldBack === true) {
      // Never sent (decision 1 of 2026-11-20 on #318): not a failed read.
      // The held answer stays, for at most `GRANT_READ_GRACE_MS` from the
      // first held-back read of a run of them, and the read waits for
      // `onReadsResumed`.
      log("The grant records wait for the account.");
      if (held !== null && hold.cancel === null) {
        startBound(hold);
      }
      waiting = mergeCause(waiting, cause);
      if (next !== null) {
        request(next);
      }
      return;
    }
    // An answer, also a failure, ends a run of held-back reads. A grace that
    // follows such a run ends no later than the run's bound: without a read
    // that succeeds, the held answer stays at most `GRANT_READ_GRACE_MS` from
    // the first held-back read (the Project Manager's decision of 2026-11-23
    // on #324).
    const holdEndsAt = hold.endsAt;
    endBound(hold);
    const failure = accept(number, sentIdentity, result);
    if (failure === null) {
      endBound(grace);
    } else if (
      cause === "reread" &&
      isTransient(failure) &&
      held !== null &&
      // A grace is never extended: a reread that fails during one, such as
      // one that the interval queued while the first was on its way, ends it.
      grace.cancel === null
    ) {
      // Decision 2 of 2026-11-20 on #318: the held answer stays until the
      // retry answers, for at most `GRANT_READ_GRACE_MS`.
      startBound(grace, holdEndsAt);
    } else {
      endBound(grace);
      setUnusable();
    }
    if (next !== null && failure !== "rate_limited") {
      // A trigger came after this read was sent: one more read follows. An
      // accepted answer is held meanwhile, because it is newer than the one
      // held before.
      request(next);
      return;
    }
    next = null;
    if (failure !== null) {
      readFailed(failure);
    }
  }

  /**
   * Holds the answer of read `number`, or gives the reason why it is not
   * held; the caller decides what a failure does to the held answer.
   */
  function accept(
    number: number,
    sentIdentity: ConnectionIdentity | null,
    result: WorkspaceReadResult<GrantRecordListResponse>,
  ): WorkspaceReadFailure | null {
    if (!result.ok) {
      return result.reason;
    }
    const identity = connection.identity();
    if (
      identity === null ||
      identity.deviceId !== device ||
      !sameIdentity(identity, sentIdentity) ||
      !namesIdentity(result.value.records, identity)
    ) {
      // The answer names another device or account than the connection.
      return "failed";
    }
    attempt = 0;
    for (const [grantId, readsAtEvent] of revoked) {
      if (readsAtEvent < number) {
        // This read was sent after the event.
        revoked.delete(grantId);
      }
    }
    held = result.value.records.filter(
      (record) => record.facts.project.workspaceId === selected,
    );
    setCurrent();
    return null;
  }

  function readFailed(reason: WorkspaceReadFailure): void {
    log(`The grant records did not load (${reason}).`);
    if (connected) {
      // Offline, the next `workspace.subscribed` reads anyway.
      cancelRetry = schedule(
        () => {
          run(() => {
            cancelRetry = null;
            request("other");
          });
        },
        workspaceRetryDelayMs(attempt, reason),
      );
    }
    attempt += 1;
  }

  /**
   * Reads go on at the account service: a held-back read is sent now. One on
   * its way may have been held back before the lock ended, so one more read
   * follows it; that one is not a read of the interval alone.
   */
  function readsResumed(): void {
    if (inFlight) {
      next = mergeCause(next, "other");
    } else if (waiting !== null) {
      request(waiting);
    }
  }

  function accountChanged(status: AccountStatus): void {
    const next = signedInDevice(status);
    if (next !== device) {
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
            request("other");
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
          request("other");
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
        request("other");
        return;
      case "agent.grant.revoked":
        // The grant is left out at once, also of an answer on its way.
        revoked.set(event.payload.grantId, sentReads);
        setCurrent();
        if (
          inFlight ||
          (held ?? []).some(
            (record) =>
              record.grant.granteeAgentId === event.payload.granteeAgentId,
          )
        ) {
          request("other");
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
          request("other");
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
    account.onReadsResumed(() => run(readsResumed)),
  ];
  device = signedInDevice(account.status());
  connected = connection.status().state === "connected";
  workspacesChanged();

  return Object.freeze({
    read: () => {
      // A bound ends on the wall clock as well, should its timer be late;
      // the listeners hear of it once, after this read.
      if (expireLate()) {
        queueMicrotask(flush);
      }
      return current;
    },
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
