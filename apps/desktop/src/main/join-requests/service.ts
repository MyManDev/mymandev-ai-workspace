// The join request service (#95; decisions D1 and D3 of 2026-11-06, and the
// decisions of 2026-11-09 on #210 and #227): the join requests of the
// workspace service's selected workspace, as its owner and admins see them,
// in the main process, read with the account service's `readWorkspaceData`
// (`GET /workspaces/:workspaceId/join-requests`) and kept current with the
// join request events.
//
// - Only the owner and the admins of a workspace may list its join requests,
//   so nothing loads, nothing is held, and the join request events are
//   ignored while the account's own person in the selected workspace is a
//   member, or while its role is not known yet because the workspace's
//   people have not loaded. A demotion drops what was held at once, also
//   when its `workspace.member.role_changed` arrives before the workspace
//   service shows it, for example while that service's resync gate holds
//   the event during a reload; a promotion, or the role once it is known,
//   loads. A load waits until the workspace service's gate is live
//   (`gateLive`), so that it never reads with a role that a reload of the
//   workspace is about to change.
// - Nothing loads until the screen asked (`load`), when it opens and on the
//   person's refresh. From then on, while the application runs, the requests
//   load again after each `workspace.subscribed` of the selected workspace,
//   on each `workspace.member.claimed` of it (a requester who joins with an
//   invitation leaves the list without an event), on each
//   `workspace.member.removed` of another person (the decision of
//   2026-11-09 on #210), and after a decision that answers `ok`, `unknown`,
//   `not_found`, `conflict`, or `already_member` (`reload`). The screen's
//   request is refused within `JOIN_REQUEST_LOAD_COOLDOWN_MS` of the last
//   one that loaded, so that a renderer that misbehaves cannot read the API
//   in a loop.
// - The events of the selected workspace apply to the held list at once:
//   `workspace.join_request.created` adds a pending request,
//   `workspace.join_request.resolved` ends one (and `blocked` makes it a
//   block, blocked at the event's time), and
//   `workspace.join_request.unblocked` ends a block. A resolved and an
//   unblocked request ID is remembered for `JOIN_REQUEST_MEMORY_MS` from
//   its arrival, also before the first load answered, so that a late
//   `created`, or a late `resolved` with `blocked`, does not bring the
//   request or the block back. A `created` that does not fit beside
//   `MAX_HELD_JOIN_REQUESTS` held requests loads the list again, so that the
//   server decides which requests it shows. The events that arrive while a load is
//   on its way apply again on top of its answer, so that an answer read
//   before them does not undo them; an event that the answer already holds
//   changes nothing.
// - Expiry has no event: a pending request leaves the list at its
//   `expiresAt` by the system clock, and a `created` past it adds nothing.
//   A load's answer is not filtered by the system clock, because the server
//   left out the requests past their expiry by its own; the expiry timer
//   then follows the system clock.
// - Reloads are merged like the invitation service's: while a load is on its
//   way, one more follows its answer, which is dropped, however many
//   triggers came; while a retry waits out its backoff, the retry reads the
//   change. A failed load is retried with the workspace service's backoff
//   while connected; offline, the next `workspace.subscribed` loads.
// - Another selected workspace, a sign-out, or another device drops the
//   requests, the remembered IDs, and the answers on their way.
//
// The time when new requests were paused comes from the workspace service's
// view (`joinRequestsPausedAt`), only for the owner and the admins. The
// state holds IDs, names, logins, and times only, never a user ID; the logs
// are fixed text with a failure code at most.
import type {
  JoinRequest,
  JoinRequestId,
  JoinRequestListResponse,
  MemberId,
  ReceivedServerEvent,
  WorkspaceId,
} from "@mymandev/protocol";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { ConnectionClient, ServerMessage } from "../connection/client.ts";
import type { ScheduleTimer } from "../runtime.ts";
import {
  workspaceRetryDelayMs,
  type WorkspaceAccount,
  type WorkspaceService,
} from "../workspace/service.ts";

/**
 * How long after the screen's last request for the join requests the next
 * one is refused (`too_soon`).
 */
export const JOIN_REQUEST_LOAD_COOLDOWN_MS = 2_000;

/**
 * How long the ID of a resolved or an unblocked request is remembered. The
 * server sends each event after its own commit, so a `created` can arrive
 * after its `resolved`, and a `resolved` with `blocked` after its
 * `unblocked`, when the two changes commit at almost the same moment; five
 * minutes is far longer than that, and than the API's request timeout of
 * 30 seconds. A request ID never becomes pending again, and a lifted block
 * never comes back, so a longer memory would only cost memory.
 */
export const JOIN_REQUEST_MEMORY_MS = 5 * 60_000;

/**
 * At most this many IDs of each kind are remembered; the oldest go first.
 * It is the most that one answer of the API holds (`MAX_ANSWER_LIST_ITEMS`).
 */
export const JOIN_REQUEST_MEMORY_LIMIT = 1_000;

/**
 * At most this many requests are held, pending and blocked together, the
 * most that one answer of the API holds. A `created` event beyond it adds
 * nothing; the next load reads the list.
 */
export const MAX_HELD_JOIN_REQUESTS = 1_000;

/**
 * At most this many events wait to apply again on top of a load's answer.
 * Beyond it they are dropped, and one more load follows that answer.
 */
export const MAX_REPLAYED_JOIN_REQUEST_EVENTS = 1_000;

/**
 * The longest wait of the expiry timer; a later expiry is checked again
 * after it.
 */
export const JOIN_REQUEST_EXPIRY_CHECK_MAX_MS = 86_400_000;

/**
 * - `signed_out`: no signed-in device; the state is empty.
 * - `no_workspace`: no workspace is selected.
 * - `not_allowed`: the account's own person in the selected workspace is
 *   not the owner or an admin; the state is empty.
 * - `loading`: the requests have not loaded yet for the selected workspace,
 *   also while the role is not known.
 * - `ready`: they loaded. It stays `ready` during later loads.
 * - `unavailable`: the last load failed; `problem` holds the failure until
 *   a load succeeds. What was loaded before stays.
 */
export type JoinRequestListStatus =
  | "signed_out"
  | "no_workspace"
  | "not_allowed"
  | "loading"
  | "ready"
  | "unavailable";

/** The GitHub account behind a request, as the service keeps it. */
export interface JoinRequesterState {
  readonly login: string;
  /** When the login was last verified, an ISO 8601 time in UTC. */
  readonly verifiedAt: string;
  /** When the GitHub account was created, an ISO 8601 time in UTC. */
  readonly accountCreatedAt: string;
}

/** A pending request as the service keeps it: never a user ID. */
export interface PendingJoinRequestState {
  readonly id: JoinRequestId;
  readonly requestedDisplayName: string;
  readonly requester: JoinRequesterState;
  /** An ISO 8601 time in UTC. */
  readonly createdAt: string;
  /** An ISO 8601 time in UTC. */
  readonly expiresAt: string;
}

/** A block in force as the service keeps it. */
export interface BlockedJoinRequestState {
  readonly id: JoinRequestId;
  readonly requestedDisplayName: string;
  /** Null only after the account's data was erased. */
  readonly requester: JoinRequesterState | null;
  /** An ISO 8601 time in UTC. */
  readonly createdAt: string;
  /** When the request was blocked, an ISO 8601 time in UTC. */
  readonly blockedAt: string;
}

/** The service's state. Every value is frozen. */
export interface JoinRequestListState {
  /** Grows by one with every change. */
  readonly revision: number;
  readonly status: JoinRequestListStatus;
  /** Only with `unavailable`. */
  readonly problem?: WorkspaceReadFailure;
  /** The selected workspace, or null. */
  readonly workspaceId: WorkspaceId | null;
  /** The pending requests, in the API's order with the new ones at the end. */
  readonly pending: readonly PendingJoinRequestState[];
  /** The blocks in force, in the API's order with the new ones at the end. */
  readonly blocked: readonly BlockedJoinRequestState[];
  /**
   * When new requests were paused, from the workspace service's last
   * reload; null while they are accepted, and for anyone but the owner and
   * the admins.
   */
  readonly pausedAt: string | null;
}

/** The answer to the screen's request for the join requests. */
export type JoinRequestLoadOutcome =
  | { readonly outcome: "loading" }
  | {
      readonly outcome: "refused";
      readonly reason:
        "not_signed_in" | "no_workspace" | "not_allowed" | "too_soon";
    };

/** The part of the connection client that the service uses: no way to send. */
export type JoinRequestConnection = Pick<
  ConnectionClient,
  "status" | "onStatusChange" | "onMessage"
>;

export interface JoinRequestServiceOptions {
  readonly account: Pick<WorkspaceAccount, "readWorkspaceData">;
  readonly connection: JoinRequestConnection;
  readonly workspaces: Pick<
    WorkspaceService,
    | "state"
    | "onChange"
    | "people"
    | "ownMemberId"
    | "joinRequestsPausedAt"
    | "gateLive"
  >;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /**
   * The current time in milliseconds since the epoch, for the expiry of a
   * request. Defaults to `Date.now`.
   */
  readonly clock?: () => number;
  /**
   * Receives fixed messages with a failure code at most, never a name, a
   * login, or an ID. An error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface JoinRequestService {
  /** The current state. */
  readonly state: () => JoinRequestListState;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onChange: (
    listener: (state: JoinRequestListState) => void,
  ) => () => void;
  /**
   * The screen asks for the join requests: they load now, and from then on
   * after every trigger. It still counts as the screen's request when it is
   * refused as `not_signed_in`, `no_workspace`, or `not_allowed`, which
   * start no cooldown, so the requests load once they may. While the role
   * is not known yet, it answers `loading`, and they load once it is. It is
   * refused as `too_soon` within `JOIN_REQUEST_LOAD_COOLDOWN_MS` of the last
   * request that was not refused.
   */
  readonly load: () => JoinRequestLoadOutcome;
  /**
   * Loads the join requests of `workspaceId` again after a join request
   * action, merged with the other triggers. True when they are read again,
   * or a load or a retry on its way reads them; false, with nothing read,
   * for a workspace that is not the selected one, without the owner's or
   * an admin's role, or before the screen asked.
   */
  readonly reload: (workspaceId: WorkspaceId) => boolean;
  /** Stops listening and cancels the timers, for the quit. */
  readonly close: () => void;
}

const JOIN_REQUEST_EVENT_TYPES = Object.freeze([
  "workspace.join_request.created",
  "workspace.join_request.resolved",
  "workspace.join_request.unblocked",
] as const);
const joinRequestEventTypes: ReadonlySet<string> = new Set(
  JOIN_REQUEST_EVENT_TYPES,
);

/** The events that this service applies. */
export type JoinRequestEvent = Extract<
  ReceivedServerEvent,
  { type: (typeof JOIN_REQUEST_EVENT_TYPES)[number] }
>;

function isJoinRequestEvent(
  event: ReceivedServerEvent,
): event is JoinRequestEvent {
  return joinRequestEventTypes.has(event.type);
}

const LOADING: JoinRequestLoadOutcome = Object.freeze({ outcome: "loading" });

function refusedLoad(
  reason: "not_signed_in" | "no_workspace" | "not_allowed" | "too_soon",
): JoinRequestLoadOutcome {
  return Object.freeze({ outcome: "refused", reason });
}

const NO_PENDING: readonly PendingJoinRequestState[] = Object.freeze([]);
const NO_BLOCKS: readonly BlockedJoinRequestState[] = Object.freeze([]);

/**
 * Whether the account's own person may list the selected workspace's join
 * requests: `allowed` for the owner and an admin, `not_allowed` for a
 * member, and `unknown` while the workspace's people have not loaded.
 */
type Access = "allowed" | "not_allowed" | "unknown";

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

function requesterState(
  requester: NonNullable<JoinRequest["requester"]>,
): JoinRequesterState {
  return Object.freeze({
    login: requester.login,
    verifiedAt: requester.verifiedAt,
    accountCreatedAt: requester.accountCreatedAt,
  });
}

/** A pending request of the protocol, or null without its requester. */
function pendingState(request: JoinRequest): PendingJoinRequestState | null {
  if (request.requester === null) {
    return null;
  }
  return Object.freeze({
    id: request.id,
    requestedDisplayName: request.requestedDisplayName,
    requester: requesterState(request.requester),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  });
}

export function createJoinRequestService(
  options: JoinRequestServiceOptions,
): JoinRequestService {
  const { account, connection, workspaces } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? (() => performance.now());
  const clock = options.clock ?? Date.now;

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  let connected = false;
  let signedIn = false;
  let selected: WorkspaceId | null = null;
  let access: Access = "unknown";
  /**
   * The account's own person in the selected workspace was demoted to
   * `member` by an event that the workspace service's people do not show
   * yet: its access stays `not_allowed` until they show it, the workspace
   * service's gate is live again, or an event promotes the person again.
   */
  let demoted = false;
  /**
   * A load waits until the workspace service's gate of the selected
   * workspace is live, so that the role it reads with is current.
   */
  let gateWait = false;
  /**
   * Changes whenever what was loaded no longer applies: another workspace,
   * a sign-out, another device, or a role without access. An answer for an
   * earlier epoch is dropped.
   */
  let epoch = 0;
  /**
   * Whether the screen asked for the join requests since the application
   * started. Until then nothing loads, and the events are ignored.
   */
  let requested = false;
  /** When the screen's last request was accepted, or null. */
  let lastRequest: number | null = null;

  /** The pending requests, in their order. */
  let pending = new Map<JoinRequestId, PendingJoinRequestState>();
  /** The blocks in force, in their order. */
  let blocked = new Map<JoinRequestId, BlockedJoinRequestState>();
  /** The frozen lists of the state, or null after a change. */
  let pendingList: readonly PendingJoinRequestState[] | null = NO_PENDING;
  let blockedList: readonly BlockedJoinRequestState[] | null = NO_BLOCKS;
  let pausedAt: string | null = null;
  /** Until when each resolved request's ID is remembered (`now`). */
  const resolvedIds = new Map<JoinRequestId, number>();
  /** Until when each unblocked request's ID is remembered (`now`). */
  const unblockedIds = new Map<JoinRequestId, number>();
  /** The events since the load on its way was sent, to apply on its answer. */
  let replay: JoinRequestEvent[] = [];

  let loaded = false;
  let problem: WorkspaceReadFailure | null = null;
  let inFlight = false;
  /** A trigger came while a load was on its way: its answer is dropped. */
  let again = false;
  /** The failed loads in a row, for the backoff. */
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;
  /** The expiry that the expiry timer waits for (`clock`), or null. */
  let expiryAt: number | null = null;
  let cancelExpiry: (() => void) | null = null;

  let revision = 0;
  let dirty = false;
  let current = buildState();
  const listeners = new Set<(state: JoinRequestListState) => void>();

  function status(): JoinRequestListStatus {
    if (!signedIn) {
      return "signed_out";
    }
    if (selected === null) {
      return "no_workspace";
    }
    if (access === "not_allowed") {
      return "not_allowed";
    }
    if (problem !== null) {
      return "unavailable";
    }
    return loaded ? "ready" : "loading";
  }

  function buildState(): JoinRequestListState {
    pendingList ??= Object.freeze([...pending.values()]);
    blockedList ??= Object.freeze([...blocked.values()]);
    const base = {
      revision,
      workspaceId: selected,
      pending: pendingList,
      blocked: blockedList,
      pausedAt,
    };
    const shown = status();
    return shown === "unavailable" && problem !== null
      ? Object.freeze({ ...base, status: shown, problem })
      : Object.freeze({ ...base, status: shown });
  }

  function touch(): void {
    dirty = true;
  }

  function changedPending(): void {
    pendingList = null;
    touch();
  }

  function changedBlocks(): void {
    blockedList = null;
    touch();
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
        log("A join request state listener failed.");
      }
    }
  }

  /** Runs one entry point, follows the expiries, and publishes the change. */
  function run<T>(action: () => T): T {
    try {
      return action();
    } finally {
      followExpiry();
      flush();
    }
  }

  function stopRetry(): void {
    cancelRetry?.();
    cancelRetry = null;
  }

  function stopExpiry(): void {
    cancelExpiry?.();
    cancelExpiry = null;
    expiryAt = null;
  }

  /** Drops what was loaded, the remembered IDs, and the answers on their way. */
  function drop(): void {
    epoch += 1;
    inFlight = false;
    again = false;
    gateWait = false;
    stopRetry();
    attempt = 0;
    replay = [];
    resolvedIds.clear();
    unblockedIds.clear();
    if (pending.size > 0) {
      pending = new Map();
      changedPending();
    }
    if (blocked.size > 0) {
      blocked = new Map();
      changedBlocks();
    }
    loaded = false;
    problem = null;
    touch();
  }

  // The remembered IDs.

  function remember(
    memory: Map<JoinRequestId, number>,
    joinRequestId: JoinRequestId,
  ): void {
    const at = now();
    // Every entry lives as long, so the oldest come first.
    for (const [held, until] of memory) {
      if (until > at) {
        break;
      }
      memory.delete(held);
    }
    memory.delete(joinRequestId);
    memory.set(joinRequestId, at + JOIN_REQUEST_MEMORY_MS);
    for (const held of memory.keys()) {
      if (memory.size <= JOIN_REQUEST_MEMORY_LIMIT) {
        break;
      }
      memory.delete(held);
    }
  }

  function remembered(
    memory: Map<JoinRequestId, number>,
    joinRequestId: JoinRequestId,
  ): boolean {
    const until = memory.get(joinRequestId);
    if (until === undefined) {
      return false;
    }
    if (until <= now()) {
      memory.delete(joinRequestId);
      return false;
    }
    return true;
  }

  // The expiry.

  function expired(expiresAt: string): boolean {
    return Date.parse(expiresAt) <= clock();
  }

  /** Drops the pending requests whose expiry has passed. */
  function dropExpired(): void {
    let changed = false;
    for (const [joinRequestId, request] of pending) {
      if (expired(request.expiresAt)) {
        pending.delete(joinRequestId);
        changed = true;
      }
    }
    if (changed) {
      changedPending();
    }
  }

  /** Keeps one timer for the soonest expiry of the pending requests. */
  function followExpiry(): void {
    if (closed) {
      return;
    }
    let soonest: number | null = null;
    for (const request of pending.values()) {
      const at = Date.parse(request.expiresAt);
      if (soonest === null || at < soonest) {
        soonest = at;
      }
    }
    if (soonest === expiryAt && (soonest === null || cancelExpiry !== null)) {
      return;
    }
    stopExpiry();
    if (soonest === null) {
      return;
    }
    expiryAt = soonest;
    const delayMs = Math.min(
      Math.max(0, soonest - clock()),
      JOIN_REQUEST_EXPIRY_CHECK_MAX_MS,
    );
    cancelExpiry = schedule(() => {
      run(() => {
        cancelExpiry = null;
        expiryAt = null;
        dropExpired();
      });
    }, delayMs);
  }

  // The events.

  /**
   * Applies one event to the held requests. Every event sets the state that
   * it reports, so applying one again changes nothing; an event for a
   * request that is not held changes nothing either. True when the list
   * must load again: a new request that does not fit beside
   * `MAX_HELD_JOIN_REQUESTS` held ones.
   */
  function applyEvent(event: JoinRequestEvent): boolean {
    switch (event.type) {
      case "workspace.join_request.created": {
        const request = pendingState(event.payload.joinRequest);
        if (
          request === null ||
          remembered(resolvedIds, request.id) ||
          pending.has(request.id) ||
          blocked.has(request.id) ||
          expired(request.expiresAt)
        ) {
          return false;
        }
        if (pending.size + blocked.size >= MAX_HELD_JOIN_REQUESTS) {
          // The server decides which requests one answer holds.
          return true;
        }
        pending.set(request.id, request);
        changedPending();
        return false;
      }
      case "workspace.join_request.resolved": {
        const { joinRequestId, outcome } = event.payload;
        const held = pending.get(joinRequestId);
        if (held === undefined) {
          return false;
        }
        pending.delete(joinRequestId);
        changedPending();
        if (outcome === "blocked" && !remembered(unblockedIds, joinRequestId)) {
          // The event's time is the time that the server stores as the
          // block's `decidedAt`.
          blocked.set(
            joinRequestId,
            Object.freeze({
              id: held.id,
              requestedDisplayName: held.requestedDisplayName,
              requester: held.requester,
              createdAt: held.createdAt,
              blockedAt: event.occurredAt,
            }),
          );
          changedBlocks();
        }
        return false;
      }
      case "workspace.join_request.unblocked": {
        if (blocked.delete(event.payload.joinRequestId)) {
          changedBlocks();
        }
        return false;
      }
    }
  }

  /** An event of the selected workspace, for the owner or an admin. */
  function joinRequestEvent(event: JoinRequestEvent): void {
    // Remembered on arrival, also when nothing is held yet or the load on
    // its way fails, so that a late event or answer brings nothing back.
    if (event.type === "workspace.join_request.resolved") {
      remember(resolvedIds, event.payload.joinRequestId);
    } else if (event.type === "workspace.join_request.unblocked") {
      remember(unblockedIds, event.payload.joinRequestId);
    }
    if (inFlight) {
      if (replay.length >= MAX_REPLAYED_JOIN_REQUEST_EVENTS) {
        // The answer cannot be completed without the dropped events.
        replay = [];
        again = true;
      } else {
        replay.push(event);
      }
    }
    if (loaded && applyEvent(event)) {
      reloadSelected();
    }
  }

  // The loads.

  /** The access of the account's own person in `workspaceId`. */
  function accessIn(workspaceId: WorkspaceId): Access {
    const own = workspaces.ownMemberId(workspaceId);
    const person =
      own === null
        ? undefined
        : workspaces.people().find((entry) => entry.id === own);
    if (person === undefined) {
      // The selected workspace's people have not loaded yet.
      return "unknown";
    }
    return person.removedAt === null &&
      (person.role === "owner" || person.role === "admin")
      ? "allowed"
      : "not_allowed";
  }

  /** Whether the join request events and the triggers count now. */
  function live(): boolean {
    return !closed && requested && selected !== null && access === "allowed";
  }

  /**
   * Loads the selected workspace's join requests, once the screen asked and
   * while the role allows it. While a load is on its way, its answer is
   * dropped and they load again after it; while a retry waits, the retry
   * reads them.
   */
  function reloadSelected(): boolean {
    if (!live()) {
      return false;
    }
    if (inFlight) {
      again = true;
      return true;
    }
    if (cancelRetry !== null) {
      // A failed load waits out its backoff, also the wait after
      // `rate_limited`; the retry reads everything.
      return true;
    }
    if (selected !== null && !workspaces.gateLive(selected)) {
      // The workspace reloads, and its people may change the role: the
      // load follows once the gate is live (`follow`).
      gateWait = true;
      return true;
    }
    send();
    return true;
  }

  function send(): void {
    const workspaceId = selected;
    if (workspaceId === null) {
      return;
    }
    inFlight = true;
    again = false;
    // Every event so far is part of what this load reads.
    replay = [];
    const sent = epoch;
    void account
      .readWorkspaceData("listJoinRequests", { workspaceId })
      .catch((): WorkspaceReadResult<never> => ({
        ok: false,
        reason: "unavailable",
      }))
      .then((result) => run(() => answered(sent, workspaceId, result)));
  }

  function answered(
    sent: number,
    workspaceId: WorkspaceId,
    result: WorkspaceReadResult<JoinRequestListResponse>,
  ): void {
    if (closed || sent !== epoch || workspaceId !== selected) {
      return;
    }
    inFlight = false;
    const events = replay;
    replay = [];
    if (again && (result.ok || result.reason !== "rate_limited")) {
      // A trigger came after this load was sent: only a newer answer
      // counts. After `rate_limited`, the retry at the end of the wait
      // reads it instead.
      reloadSelected();
      return;
    }
    again = false;
    if (
      !result.ok ||
      result.value.joinRequests.some(
        (request) => request.workspaceId !== workspaceId,
      )
    ) {
      loadFailed(result.ok ? "failed" : result.reason);
      return;
    }
    pending = new Map();
    blocked = new Map();
    for (const request of result.value.joinRequests) {
      if (request.decision === null) {
        // The server left out the requests past their expiry by its own
        // clock; the expiry timer follows the system clock from here on.
        const state = pendingState(request);
        if (state !== null) {
          pending.set(state.id, state);
        }
      } else if (request.decision === "blocked" && request.decidedAt !== null) {
        blocked.set(
          request.id,
          Object.freeze({
            id: request.id,
            requestedDisplayName: request.requestedDisplayName,
            requester:
              request.requester === null
                ? null
                : requesterState(request.requester),
            createdAt: request.createdAt,
            blockedAt: request.decidedAt,
          }),
        );
      }
      // The API lists no other decision; one would be left out.
    }
    changedPending();
    changedBlocks();
    // The events that arrived after the load was sent may be newer than
    // the answer.
    let full = false;
    for (const event of events) {
      full = applyEvent(event) || full;
    }
    // Then nothing that was resolved or unblocked comes back: a resolved
    // request is no longer pending, and a lifted block no longer in force.
    for (const joinRequestId of [...pending.keys()]) {
      if (remembered(resolvedIds, joinRequestId)) {
        pending.delete(joinRequestId);
      }
    }
    for (const joinRequestId of [...blocked.keys()]) {
      if (remembered(unblockedIds, joinRequestId)) {
        blocked.delete(joinRequestId);
      }
    }
    loaded = true;
    problem = null;
    attempt = 0;
    touch();
    if (full) {
      reloadSelected();
    }
  }

  function loadFailed(reason: WorkspaceReadFailure): void {
    problem = reason;
    touch();
    log(`The join requests did not load (${reason}).`);
    if (connected) {
      // Offline, the next `workspace.subscribed` loads anyway.
      const delayMs = workspaceRetryDelayMs(attempt, reason);
      cancelRetry = schedule(() => {
        run(() => {
          cancelRetry = null;
          reloadSelected();
        });
      }, delayMs);
    }
    attempt += 1;
  }

  /**
   * Follows the workspace service: the device, the selection, the role of
   * the account's own person in the selected workspace, and the pause.
   */
  function follow(): void {
    const state = workspaces.state();
    const nextSignedIn = state.status !== "signed_out";
    const nextSelected = nextSignedIn ? state.selectedWorkspaceId : null;
    if (nextSignedIn !== signedIn || nextSelected !== selected) {
      signedIn = nextSignedIn;
      selected = nextSelected;
      access = "unknown";
      demoted = false;
      drop();
    }
    let nextAccess: Access = selected === null ? "unknown" : accessIn(selected);
    if (
      demoted &&
      (nextAccess !== "allowed" ||
        (selected !== null && workspaces.gateLive(selected)))
    ) {
      // The people show the demotion, or the workspace reloaded with every
      // event applied, so they hold the current role.
      demoted = false;
    }
    if (demoted) {
      // The people do not show the demotion yet.
      nextAccess = "not_allowed";
    }
    changeAccess(nextAccess);
    const nextPausedAt =
      access === "allowed" ? workspaces.joinRequestsPausedAt() : null;
    if (nextPausedAt !== pausedAt) {
      pausedAt = nextPausedAt;
      touch();
    }
    if (gateWait && selected !== null && workspaces.gateLive(selected)) {
      gateWait = false;
      reloadSelected();
    }
  }

  function changeAccess(nextAccess: Access): void {
    if (nextAccess !== access) {
      access = nextAccess;
      touch();
      if (access === "allowed") {
        reloadSelected();
      } else if (access === "not_allowed") {
        // A demotion: what was loaded is no longer the person's to see.
        drop();
      }
    }
  }

  /**
   * A role change of the account's own person in the selected workspace,
   * at once, also while the workspace service's gate holds the event: a
   * demotion to `member` drops what was held, and a promotion after it
   * lets the people decide again.
   */
  function ownRoleChanged(role: string): void {
    if (role === "member") {
      // `follow` ends it once the people show the role or the workspace
      // service's gate is live, when they show every event.
      demoted = true;
      changeAccess("not_allowed");
      pausedAt = null;
      touch();
    } else if (demoted) {
      demoted = false;
      follow();
    }
  }

  function isOwnPerson(memberId: MemberId): boolean {
    return selected !== null && workspaces.ownMemberId(selected) === memberId;
  }

  function messageReceived(message: ServerMessage): void {
    if (selected === null) {
      return;
    }
    if (message.kind === "frame") {
      if (
        message.frame.type === "workspace.subscribed" &&
        message.frame.workspaceId === selected
      ) {
        reloadSelected();
      }
      return;
    }
    const event = message.event;
    if (
      event.workspaceId === selected &&
      event.type === "workspace.member.role_changed" &&
      isOwnPerson(event.payload.memberId)
    ) {
      ownRoleChanged(event.payload.role);
      return;
    }
    if (event.workspaceId !== selected || !live()) {
      // The role filter: a member's device ignores these events, and so
      // does a device whose role is not known yet.
      return;
    }
    if (isJoinRequestEvent(event)) {
      joinRequestEvent(event);
      return;
    }
    switch (event.type) {
      case "workspace.member.claimed":
        // A requester who joins with an invitation leaves the list without
        // a join request event.
        reloadSelected();
        return;
      case "workspace.member.removed":
        // The decision of 2026-11-09 on #210. A removal of the account's
        // own person ends the membership, so nothing is read for it.
        if (!isOwnPerson(event.payload.memberId)) {
          reloadSelected();
        }
        return;
      default:
        return;
    }
  }

  function connectionChanged(state: string): void {
    const isConnected = state === "connected";
    if (isConnected === connected) {
      return;
    }
    connected = isConnected;
    if (!isConnected) {
      // The next `workspace.subscribed` loads; a retry offline would fail.
      stopRetry();
    }
  }

  function load(): JoinRequestLoadOutcome {
    if (closed) {
      return refusedLoad("not_signed_in");
    }
    // The screen asked, also when it opened before it may see the
    // requests: they then load once it may. A refusal sends nothing and
    // starts no cooldown.
    requested = true;
    if (!signedIn) {
      return refusedLoad("not_signed_in");
    }
    if (selected === null) {
      return refusedLoad("no_workspace");
    }
    if (access === "not_allowed") {
      return refusedLoad("not_allowed");
    }
    const at = now();
    if (
      lastRequest !== null &&
      at - lastRequest < JOIN_REQUEST_LOAD_COOLDOWN_MS
    ) {
      return refusedLoad("too_soon");
    }
    lastRequest = at;
    reloadSelected();
    return LOADING;
  }

  const removers = [
    connection.onStatusChange((next) =>
      run(() => connectionChanged(next.state)),
    ),
    connection.onMessage((message) => run(() => messageReceived(message))),
    workspaces.onChange(() => run(() => follow())),
  ];
  connectionChanged(connection.status().state);
  follow();
  // The first state is revision 0.
  current = buildState();
  dirty = false;

  return Object.freeze({
    state: () => current,
    onChange: (listener: (state: JoinRequestListState) => void) => {
      const entry = (state: JoinRequestListState) => listener(state);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    load: () => run(load),
    reload: (workspaceId: WorkspaceId) =>
      run(() => workspaceId === selected && reloadSelected()),
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
      stopExpiry();
    },
  });
}
