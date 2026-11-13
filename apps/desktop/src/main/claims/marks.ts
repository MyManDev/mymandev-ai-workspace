// The claim marks of the other workspaces (#271; decision D8 of 2026-11-13
// on #95, and its update of the same day): which workspaces of the list
// hold a claim that the account has not seen, so that the sidebar can mark
// them. The claim service (`service.ts`) holds the selected workspace's
// claims; this service holds only the member IDs of the most recent claims
// of the others, and publishes only their workspace IDs.
//
// - The role comes from the workspace list: `GET /workspaces` names the
//   account's own person in each workspace with its role
//   (`WorkspaceService.ownRole`), so no workspace needs a subscription or a
//   read of its people. Only a workspace where that person is the owner or
//   an admin is read; a member's workspace never is.
// - Each answer of the list (`listGeneration`), which comes on every
//   `connected` of a signed-in device and after a membership changes, reads
//   the recent claims (`GET /workspaces/:workspaceId/claims`) once for each
//   such workspace, one read at a time, in the list's order. The selected
//   workspace is skipped: the claim service reads it. A newer answer of the
//   list starts again with its own workspaces.
// - The reads are paced: a read starts at least `CLAIM_MARK_READ_INTERVAL_MS`
//   (1 second) after the start of the one before it, also across answers
//   of the list, so the reads use at most 60 requests a minute of the
//   account's shared limit on the API (300 a minute per user, across all
//   its devices), however many workspaces it owns or administers and
//   however often it reconnects. A newer answer of the list during the wait
//   only replaces the workspaces still to read.
// - A read that fails with `unavailable` or `rate_limited` is retried with
//   the workspace service's backoff (`workspaceRetryDelayMs`, 60 seconds
//   after `rate_limited`) while connected, and the reads after it wait for
//   it; offline, the next answer of the list reads again. Any other failure
//   (`failed`, which a member's `forbidden` gives after a demotion that the
//   list did not show yet, `not_found`, or `not_signed_in`) drops what was
//   held for the workspace and is not retried until the list loads again.
//   A successful read starts the backoff again. A waiting retry holds back
//   the reads of a newer answer of the list as well. An answer of any kind
//   for a workspace that was selected while its read was on its way is
//   ignored: the claim service holds that workspace's claims.
// - While a workspace is selected, the claim service's claims of it replace
//   what was held, so that the mark that it has once it is no longer
//   selected follows the claims as they were last loaded; its `not_allowed`
//   drops them. The selected workspace keeps the mark that was held for it
//   until the claim service's state of it is `ready` or `unavailable`, so
//   that its mark does not go out and come back while the claim service
//   loads it, or stay out while it cannot load offline; from then on the
//   renderer marks it by the claim service's claims, as the people item.
// - A workspace is marked while one of the claims held for it is unseen, by
//   the claim service's rule: one of its `MAX_SEEN_CLAIMS_PER_ENTRY` most
//   recent claims, not the claim of the account's own person, and not among
//   the claims that this person has seen in the workspace (`seenMemberIds`,
//   the seen claims file of #270). Nothing is marked until that file was
//   read.
// - A workspace that the list no longer holds, and one with another own
//   person, are never marked; a newer list without the owner's or an
//   admin's role drops what was held for it. A sign-out and another device
//   reset the workspace service, whose list is then empty, so everything is
//   dropped at once, with the answers on their way and a waiting retry.
//
// Only member IDs are held, never a login, a time, or a user ID; the state
// holds workspace IDs only. The logs are fixed text with a failure code at
// most.
import type {
  ClaimListResponse,
  MemberId,
  WorkspaceId,
} from "@mymandev/protocol";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { ConnectionClient } from "../connection/client.ts";
import type { ScheduleTimer } from "../runtime.ts";
import {
  workspaceRetryDelayMs,
  type WorkspaceAccount,
  type WorkspaceService,
} from "../workspace/service.ts";
import { MAX_SEEN_CLAIMS_PER_ENTRY } from "./seen-store.ts";
import type { ClaimService } from "./service.ts";

/**
 * The shortest time between the starts of two reads of the claims of the
 * other workspaces, so that they use at most 60 requests a minute.
 */
export const CLAIM_MARK_READ_INTERVAL_MS = 1_000;

/** The service's state. Every value is frozen. */
export interface ClaimMarkState {
  /** Grows by one with every change. */
  readonly revision: number;
  /**
   * The workspaces of the list that hold a claim that the account has not
   * seen, in the list's order: the other workspaces, and the selected one
   * by what was held for it only until the claim service's state of it is
   * `ready` or `unavailable`.
   */
  readonly workspaceIds: readonly WorkspaceId[];
}

export interface ClaimMarkServiceOptions {
  readonly account: Pick<WorkspaceAccount, "readWorkspaceData">;
  readonly connection: Pick<ConnectionClient, "status" | "onStatusChange">;
  readonly workspaces: Pick<
    WorkspaceService,
    "state" | "onChange" | "ownMemberId" | "ownRole" | "listGeneration"
  >;
  readonly claims: Pick<ClaimService, "state" | "onChange" | "seenMemberIds">;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /** Defaults to `CLAIM_MARK_READ_INTERVAL_MS`; tests set another one. */
  readonly readIntervalMs?: number;
  /**
   * Receives fixed messages with a failure code at most, never a login or
   * an ID. An error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface ClaimMarkService {
  /** The current state. */
  readonly state: () => ClaimMarkState;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onChange: (listener: (state: ClaimMarkState) => void) => () => void;
  /** Stops listening and cancels the timers, for the quit. */
  readonly close: () => void;
}

/** What is held for a workspace: never a login, a time, or a user ID. */
interface HeldClaims {
  /** The account's own person in the workspace when the claims loaded. */
  readonly ownMemberId: MemberId;
  /**
   * The member IDs of the `MAX_SEEN_CLAIMS_PER_ENTRY` most recent claims,
   * the most recent first.
   */
  readonly recent: readonly MemberId[];
}

/** The failures after which the read of a workspace is retried. */
const RETRIED: ReadonlySet<WorkspaceReadFailure> = new Set([
  "unavailable",
  "rate_limited",
]);

const NO_MARKS: readonly WorkspaceId[] = Object.freeze([]);

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function createClaimMarkService(
  options: ClaimMarkServiceOptions,
): ClaimMarkService {
  const { account, connection, workspaces, claims } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? (() => performance.now());
  const readIntervalMs = options.readIntervalMs ?? CLAIM_MARK_READ_INTERVAL_MS;

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  let connected = false;
  /** The selected workspace, or null; also null while signed out. */
  let selected: WorkspaceId | null = null;
  /** The list's answer that the reads follow; see `listGeneration`. */
  let generation: number | null = null;
  /**
   * Changes with every answer of the list, so that an answer read for an
   * earlier one is dropped.
   */
  let epoch = 0;
  /** The workspaces still to read for the list's last answer, in order. */
  let queue: WorkspaceId[] = [];
  /** The workspace whose read is on its way, or null. */
  let inFlight: WorkspaceId | null = null;
  /** The failed reads in a row, for the backoff. */
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;
  /** When the last read started, for the pace, or null. */
  let lastStart: number | null = null;
  /** The wait for the pace before the next read, or null. */
  let cancelPace: (() => void) | null = null;
  const held = new Map<WorkspaceId, HeldClaims>();

  let marked = NO_MARKS;
  let revision = 0;
  let dirty = false;
  let current = buildState();
  const listeners = new Set<(state: ClaimMarkState) => void>();

  function buildState(): ClaimMarkState {
    return Object.freeze({ revision, workspaceIds: marked });
  }

  /** Works out the marks again and publishes them when they changed. */
  function flush(): void {
    if (closed) {
      return;
    }
    const next = marks();
    if (!sameIds(next, marked)) {
      marked = Object.freeze(next);
      dirty = true;
    }
    if (!dirty) {
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
        log("A claim mark listener failed.");
      }
    }
  }

  /** Runs one entry point and publishes the change. */
  function run<T>(action: () => T): T {
    try {
      return action();
    } finally {
      flush();
    }
  }

  /**
   * Whether the claim service has loaded the selected workspace, or failed
   * to: its mark then follows the claim service's claims.
   */
  function selectedLoaded(): boolean {
    const state = claims.state();
    return (
      state.workspaceId === selected &&
      (state.status === "ready" || state.status === "unavailable")
    );
  }

  /** The workspaces with an unseen claim; see `ClaimMarkState`. */
  function marks(): WorkspaceId[] {
    const result: WorkspaceId[] = [];
    if (held.size === 0) {
      return result;
    }
    for (const { id } of workspaces.state().workspaces) {
      const claimsOf = held.get(id);
      if (
        (id === selected && selectedLoaded()) ||
        claimsOf === undefined ||
        workspaces.ownMemberId(id) !== claimsOf.ownMemberId
      ) {
        continue;
      }
      const seen = claims.seenMemberIds(id, claimsOf.ownMemberId);
      if (
        seen !== null &&
        claimsOf.recent.some(
          (memberId) =>
            memberId !== claimsOf.ownMemberId && !seen.has(memberId),
        )
      ) {
        result.push(id);
      }
    }
    return result;
  }

  /**
   * Whether the list names the account's own person in `workspaceId` as the
   * owner or an admin: only then are its claims read.
   */
  function mayRead(workspaceId: WorkspaceId): boolean {
    const role = workspaces.ownRole(workspaceId);
    return (
      workspaces.ownMemberId(workspaceId) !== null &&
      (role === "owner" || role === "admin")
    );
  }

  function hold(
    workspaceId: WorkspaceId,
    ownMemberId: MemberId,
    memberIds: readonly MemberId[],
  ): void {
    const recent = memberIds.slice(0, MAX_SEEN_CLAIMS_PER_ENTRY);
    const before = held.get(workspaceId);
    if (
      before !== undefined &&
      before.ownMemberId === ownMemberId &&
      sameIds(before.recent, recent)
    ) {
      return;
    }
    held.set(
      workspaceId,
      Object.freeze({ ownMemberId, recent: Object.freeze(recent) }),
    );
  }

  function stopRetry(): void {
    cancelRetry?.();
    cancelRetry = null;
  }

  // The reads.

  /**
   * Reads the next workspace of the queue, one read at a time, and not
   * before `readIntervalMs` after the start of the last read.
   */
  function pump(): void {
    if (
      closed ||
      inFlight !== null ||
      cancelRetry !== null ||
      cancelPace !== null
    ) {
      return;
    }
    let next = queue[0];
    // The claim service reads the selected workspace.
    while (next !== undefined && (next === selected || !mayRead(next))) {
      queue.shift();
      next = queue[0];
    }
    if (next === undefined) {
      return;
    }
    const wait = lastStart === null ? 0 : lastStart + readIntervalMs - now();
    if (wait > 0) {
      // A newer answer of the list during the wait replaces the queue; the
      // pace stays.
      cancelPace = schedule(() => {
        run(() => {
          cancelPace = null;
          pump();
        });
      }, wait);
      return;
    }
    queue.shift();
    send(next);
  }

  function stopPace(): void {
    cancelPace?.();
    cancelPace = null;
  }

  function send(workspaceId: WorkspaceId): void {
    const ownMemberId = workspaces.ownMemberId(workspaceId);
    if (ownMemberId === null) {
      return;
    }
    inFlight = workspaceId;
    lastStart = now();
    const sent = epoch;
    void account
      .readWorkspaceData("listClaims", { workspaceId })
      .catch((): WorkspaceReadResult<never> => ({
        ok: false,
        reason: "unavailable",
      }))
      .then((result) =>
        run(() => answered(sent, workspaceId, ownMemberId, result)),
      );
  }

  function answered(
    sent: number,
    workspaceId: WorkspaceId,
    ownMemberId: MemberId,
    result: WorkspaceReadResult<ClaimListResponse>,
  ): void {
    if (closed) {
      return;
    }
    inFlight = null;
    if (sent !== epoch || workspaceId === selected) {
      // A newer answer of the list came meanwhile, and its own reads
      // follow; or the workspace was selected meanwhile, and the claim
      // service holds its claims: nothing is held, dropped, or retried.
      pump();
      return;
    }
    if (
      !result.ok ||
      result.value.claims.some((claim) => claim.workspaceId !== workspaceId)
    ) {
      readFailed(workspaceId, result.ok ? "failed" : result.reason);
      return;
    }
    attempt = 0;
    if (workspaces.ownMemberId(workspaceId) === ownMemberId) {
      hold(
        workspaceId,
        ownMemberId,
        result.value.claims.map((claim) => claim.memberId),
      );
    }
    pump();
  }

  function readFailed(
    workspaceId: WorkspaceId,
    reason: WorkspaceReadFailure,
  ): void {
    log(`The claims of another workspace did not load (${reason}).`);
    if (!RETRIED.has(reason)) {
      // Not read again until the list loads again; a member's `forbidden`
      // after a demotion ends here.
      held.delete(workspaceId);
      pump();
      return;
    }
    // What was held stays, and the retry reads it first.
    queue.unshift(workspaceId);
    if (connected) {
      // Offline, the next answer of the list reads again.
      cancelRetry = schedule(
        () => {
          run(() => {
            cancelRetry = null;
            pump();
          });
        },
        workspaceRetryDelayMs(attempt, reason),
      );
    }
    attempt += 1;
  }

  // Following the workspace service and the claim service.

  /** A new answer of the list, or a sign-out or another device. */
  function listLoaded(): void {
    epoch += 1;
    // The roles of the new list decide what may stay; a sign-out and
    // another device empty the list, so nothing does.
    for (const workspaceId of [...held.keys()]) {
      if (!mayRead(workspaceId)) {
        held.delete(workspaceId);
      }
    }
    queue = workspaces
      .state()
      .workspaces.map(({ id }) => id)
      .filter(mayRead);
    if (queue.length === 0) {
      // Nothing to read, for example after a sign-out: the backoff ends.
      stopRetry();
      attempt = 0;
    }
    pump();
  }

  function followWorkspaces(): void {
    const state = workspaces.state();
    selected = state.status === "signed_out" ? null : state.selectedWorkspaceId;
    const next = workspaces.listGeneration();
    if (next !== generation) {
      generation = next;
      listLoaded();
    }
    followClaims();
  }

  /**
   * The claim service's claims of the selected workspace replace what was
   * held for it, so that its mark follows them once it is no longer
   * selected; `not_allowed` drops them.
   */
  function followClaims(): void {
    const state = claims.state();
    if (selected === null || state.workspaceId !== selected) {
      return;
    }
    const ownMemberId = workspaces.ownMemberId(selected);
    if (state.status === "not_allowed" || ownMemberId === null) {
      held.delete(selected);
    } else if (state.status === "ready") {
      hold(
        selected,
        ownMemberId,
        state.claims.map((claim) => claim.memberId),
      );
    }
  }

  function connectionChanged(state: string): void {
    const isConnected = state === "connected";
    if (isConnected === connected) {
      return;
    }
    connected = isConnected;
    if (!isConnected) {
      // The list loads again once connected, and its reads follow.
      stopRetry();
    }
  }

  const removers = [
    connection.onStatusChange((next) =>
      run(() => connectionChanged(next.state)),
    ),
    workspaces.onChange(() => run(() => followWorkspaces())),
    claims.onChange(() => run(() => followClaims())),
  ];
  connectionChanged(connection.status().state);
  run(() => followWorkspaces());
  // The first state is revision 0.
  revision = 0;
  current = buildState();
  dirty = false;

  return Object.freeze({
    state: () => current,
    onChange: (listener: (state: ClaimMarkState) => void) => {
      const entry = (state: ClaimMarkState) => listener(state);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const remove of removers) {
        remove();
      }
      listeners.clear();
      stopRetry();
      stopPace();
    },
  });
}
