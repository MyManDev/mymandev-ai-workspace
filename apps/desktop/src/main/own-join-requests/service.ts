// The own join request service (#95; decisions D1 and D3 of 2026-11-06,
// and the decisions of 2026-11-01 on #92): the account's own join
// requests, as their requester sees them, in the main process, read with
// the account service's `readWorkspaceData` (`GET /join-requests`).
//
// - Each request names the workspace that it asks to join by its ID only.
//   The API shows the requester nothing about the workspace before an
//   approval (ADR 0014, "Join requests"), so no workspace name is held.
// - A request is pending, or ended with `approved`, `denied`,
//   `withdrawn`, or `expired`; a block shows as `denied` (#92). A request
//   past its expiry stays, as `expired` with its expiry as `decidedAt`, as
//   the API lists it (the Project Manager's decision of 2026-11-12): a
//   pending request becomes `expired` at its `expiresAt` by the system
//   clock, through one timer for the soonest expiry, also before the API
//   marks it. The approvers' list drops an expired request instead (#210).
// - Nothing loads until the screen asked (`load`), when it opens and on the
//   person's refresh. From then on, while the application runs, the
//   requests load again when a device becomes signed in, when the
//   connection reaches `connected`, because account frames sent while it
//   was offline are lost, on each `account.join_request_decided`, and after
//   a create or a withdrawal (`reload`). The frame is not applied to the
//   held requests: the reload reads the decision, as the workspace service
//   reads the view again after an ownership frame, so that an older answer
//   can never undo it. The screen's request is refused within
//   `OWN_JOIN_REQUEST_LOAD_COOLDOWN_MS` of the last one that loaded, so
//   that a renderer that misbehaves cannot read the API in a loop.
// - The account's own `workspace.member.claimed` is no trigger: a device
//   receives it only for a workspace that it is subscribed to, where the
//   account is already an active member, and no claim ends a request. An
//   approval reaches the requester as `account.join_request_decided`.
// - Loads are merged and backed off like the device list service's, which
//   also follows the account rather than a workspace: one load at a time,
//   and none while a sign-in runs; a trigger during a load drops its answer
//   and loads again; a failed load is retried with the workspace service's
//   backoff while connected, and offline the next `connected` loads; after
//   `rate_limited`, nothing loads until its wait has ended.
// - A sign-out, another account, or another device drops the requests and
//   the answers on their way.
//
// The state holds IDs, the requested display names, decisions, and times
// only: the API's answer holds no user ID. The logs are fixed text with a
// failure code at most, never a name or an ID.
import type {
  JoinRequestId,
  OwnJoinRequestListItem,
  OwnJoinRequestListResponse,
  WorkspaceId,
} from "@mymandev/protocol";
import type { AccountStatus } from "../../shared/ipc-contract.ts";
import type { AccountService } from "../account.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { ConnectionClient, ServerMessage } from "../connection/client.ts";
import type { ScheduleTimer } from "../runtime.ts";
import { workspaceRetryDelayMs } from "../workspace/service.ts";

/**
 * How long after the screen's last request for the own join requests the
 * next one is refused (`too_soon`).
 */
export const OWN_JOIN_REQUEST_LOAD_COOLDOWN_MS = 2_000;

/**
 * The longest wait of the expiry timer; a later expiry is checked again
 * after it.
 */
export const OWN_JOIN_REQUEST_EXPIRY_CHECK_MAX_MS = 86_400_000;

/**
 * - `signed_out`: no signed-in device with a ready key; the state is empty.
 * - `loading`: the requests have not loaded yet for this device. The screen
 *   asks for them when it opens.
 * - `ready`: they loaded. It stays `ready` during later loads.
 * - `unavailable`: the last load failed; `problem` holds the failure until a
 *   load succeeds. What was loaded before stays.
 */
export type OwnJoinRequestListStatus =
  "signed_out" | "loading" | "ready" | "unavailable";

/**
 * How a request ended, as its requester sees it: the protocol's
 * `OWN_JOIN_REQUEST_DECISIONS`.
 */
export type OwnJoinRequestOutcome = Exclude<
  OwnJoinRequestListItem["decision"],
  null
>;

/** One of the account's own requests as the service keeps it. */
export interface OwnJoinRequestState {
  readonly id: JoinRequestId;
  /** The workspace that the request asks to join. */
  readonly workspaceId: WorkspaceId;
  readonly requestedDisplayName: string;
  /** An ISO 8601 time in UTC. */
  readonly createdAt: string;
  /** An ISO 8601 time in UTC. */
  readonly expiresAt: string;
  /** Null while the request is pending. */
  readonly decision: OwnJoinRequestOutcome | null;
  /** When it ended, an ISO 8601 time in UTC; null while it is pending. */
  readonly decidedAt: string | null;
}

/** The service's state. Every value is frozen. */
export interface OwnJoinRequestListState {
  /** Grows by one with every change. */
  readonly revision: number;
  readonly status: OwnJoinRequestListStatus;
  /** Only with `unavailable`. */
  readonly problem?: WorkspaceReadFailure;
  /**
   * The requests in the API's order, the most recently created first, with
   * a pending one past its expiry as `expired`.
   */
  readonly requests: readonly OwnJoinRequestState[];
}

/** The answer to the screen's request for the own join requests. */
export type OwnJoinRequestLoadOutcome =
  | { readonly outcome: "loading" }
  | {
      readonly outcome: "refused";
      readonly reason: "not_signed_in" | "too_soon";
    };

/** The part of the account service that the service uses. */
export type OwnJoinRequestAccount = Pick<
  AccountService,
  "status" | "onStatusChange" | "readWorkspaceData"
>;

/** The part of the connection client that the service uses: no way to send. */
export type OwnJoinRequestConnection = Pick<
  ConnectionClient,
  "status" | "onStatusChange" | "onMessage"
>;

export interface OwnJoinRequestServiceOptions {
  readonly account: OwnJoinRequestAccount;
  readonly connection: OwnJoinRequestConnection;
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
   * Receives fixed messages with a failure code at most, never a name or an
   * ID. An error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface OwnJoinRequestService {
  /** The current state. */
  readonly state: () => OwnJoinRequestListState;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onChange: (
    listener: (state: OwnJoinRequestListState) => void,
  ) => () => void;
  /**
   * The screen asks for the own join requests: they load now, and from then
   * on after every trigger. Without a signed-in device it is refused as
   * `not_signed_in`, but it still counts as the screen's request, so they
   * load once a device is signed in; such a refusal starts no cooldown.
   * With a device, it is refused as `too_soon` within
   * `OWN_JOIN_REQUEST_LOAD_COOLDOWN_MS` of the last request that loaded.
   */
  readonly load: () => OwnJoinRequestLoadOutcome;
  /**
   * Loads the own join requests again after a create or a withdrawal,
   * merged with the other triggers. True when they are read again, or a
   * load or a wait on its way reads them; false, with nothing read, without
   * a signed-in device or before the screen asked.
   */
  readonly reload: () => boolean;
  /** Stops listening and cancels the timers, for the quit. */
  readonly close: () => void;
}

const LOADING: OwnJoinRequestLoadOutcome = Object.freeze({
  outcome: "loading",
});
const NOT_SIGNED_IN: OwnJoinRequestLoadOutcome = Object.freeze({
  outcome: "refused",
  reason: "not_signed_in",
});
const TOO_SOON: OwnJoinRequestLoadOutcome = Object.freeze({
  outcome: "refused",
  reason: "too_soon",
});
const NO_REQUESTS: readonly OwnJoinRequestState[] = Object.freeze([]);

/**
 * The signed-in device, or null, under the same condition as the workspace
 * and device list services. The device ID is only compared; it never
 * reaches a log.
 */
function signedInDevice(status: AccountStatus): string | null {
  if (
    status.apiOrigin === "set" &&
    status.device === "signed_in" &&
    status.deviceKey === "ready" &&
    status.account.kind === "signed_in"
  ) {
    return status.account.deviceId;
  }
  return null;
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

/**
 * `request` as of `now` (milliseconds since the epoch): a pending request
 * whose `expiresAt` has passed is `expired`, decided at its expiry, as the
 * API lists it once it is past; any other request is `request` itself.
 */
export function requestAsOf(
  request: OwnJoinRequestState,
  now: number,
): OwnJoinRequestState {
  if (request.decision !== null || Date.parse(request.expiresAt) > now) {
    return request;
  }
  return Object.freeze({
    ...request,
    decision: "expired",
    decidedAt: request.expiresAt,
  });
}

/** A request of the API's answer as the service keeps it. */
function requestState(request: OwnJoinRequestListItem): OwnJoinRequestState {
  return Object.freeze({
    id: request.id,
    workspaceId: request.workspaceId,
    requestedDisplayName: request.requestedDisplayName,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    decision: request.decision,
    decidedAt: request.decidedAt,
  });
}

export function createOwnJoinRequestService(
  options: OwnJoinRequestServiceOptions,
): OwnJoinRequestService {
  const { account, connection } = options;
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
  /** The signed-in device, compared only; see `signedInDevice`. */
  let device: string | null = null;
  /** Changes with every reset, so that an answer for an earlier device is dropped. */
  let epoch = 0;
  let connected = false;
  /**
   * Whether the account status shows a sign-in that runs. The account
   * service answers reads `unavailable` for most of it, and it may show the
   * device signed in before it ended, so a load waits for it.
   */
  let signInRunning = false;
  /** A load waits for the sign-in that runs to end. */
  let loadWaiting = false;
  /**
   * Whether the screen asked for the own join requests since the
   * application started. Until then nothing loads.
   */
  let requested = false;
  /** When the screen's last request was accepted, or null. */
  let lastRequest: number | null = null;

  let requests: readonly OwnJoinRequestState[] = NO_REQUESTS;
  let loaded = false;
  let problem: WorkspaceReadFailure | null = null;
  let inFlight = false;
  /** A load was asked for while one was on its way: its answer is dropped. */
  let again = false;
  /** The failed loads in a row, for the backoff. */
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;
  /**
   * When the wait after `rate_limited` ends, on the monotonic clock, or
   * null. Until then nothing loads; a trigger loads at its end.
   */
  let rateLimitedUntil: number | null = null;
  /** The expiry that the expiry timer waits for (`clock`), or null. */
  let expiryAt: number | null = null;
  let cancelExpiry: (() => void) | null = null;

  let revision = 0;
  let dirty = false;
  let current = buildState();
  const listeners = new Set<(state: OwnJoinRequestListState) => void>();

  function buildState(): OwnJoinRequestListState {
    const base = { revision, requests };
    if (device === null) {
      return Object.freeze({ ...base, status: "signed_out" });
    }
    if (problem !== null) {
      return Object.freeze({ ...base, status: "unavailable", problem });
    }
    return Object.freeze({ ...base, status: loaded ? "ready" : "loading" });
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
        log("An own join request state listener failed.");
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

  /** Forgets everything: a sign-out, another account, or another device. */
  function reset(): void {
    epoch += 1;
    // The answer on its way is dropped by the epoch, so the next load need
    // not wait for it.
    inFlight = false;
    again = false;
    loadWaiting = false;
    stopRetry();
    requests = NO_REQUESTS;
    loaded = false;
    problem = null;
    attempt = 0;
    rateLimitedUntil = null;
    touch();
  }

  // The expiry.

  /** Makes the pending requests whose expiry has passed `expired`. */
  function expireDue(): void {
    const at = clock();
    const next = requests.map((request) => requestAsOf(request, at));
    if (next.some((request, index) => request !== requests[index])) {
      requests = Object.freeze(next);
      touch();
    }
  }

  /** Keeps one timer for the soonest expiry of the pending requests. */
  function followExpiry(): void {
    if (closed) {
      return;
    }
    let soonest: number | null = null;
    for (const request of requests) {
      if (request.decision !== null) {
        continue;
      }
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
      OWN_JOIN_REQUEST_EXPIRY_CHECK_MAX_MS,
    );
    cancelExpiry = schedule(() => {
      run(() => {
        cancelExpiry = null;
        expiryAt = null;
        expireDue();
      });
    }, delayMs);
  }

  // The loads.

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
   * Loads the own join requests, once the screen asked for them, for the
   * device that is signed in. During the wait after `rate_limited`, the
   * load goes when the wait ends. While a sign-in runs, the load waits for
   * it to end. While a load is on its way, its answer is dropped and they
   * load again after it. True when they are read now or later.
   */
  function reload(): boolean {
    if (closed || device === null || !requested) {
      return false;
    }
    const wait = rateLimitWait();
    if (wait > 0) {
      // The server asked to wait: the retry at the end of the wait loads,
      // after every trigger that came meanwhile.
      if (cancelRetry === null) {
        scheduleRetry(wait);
      }
      return true;
    }
    stopRetry();
    if (signInRunning) {
      loadWaiting = true;
      return true;
    }
    if (inFlight) {
      again = true;
      return true;
    }
    send();
    return true;
  }

  function send(): void {
    inFlight = true;
    again = false;
    const sent = epoch;
    void account
      .readWorkspaceData("listOwnJoinRequests", {})
      .catch((): WorkspaceReadResult<never> => ({
        ok: false,
        reason: "unavailable",
      }))
      .then((result) => run(() => answered(sent, result)));
  }

  function answered(
    sent: number,
    result: WorkspaceReadResult<OwnJoinRequestListResponse>,
  ): void {
    if (closed || sent !== epoch) {
      // The reset already let the next load go.
      return;
    }
    inFlight = false;
    if (again) {
      // A trigger came after this load was sent: only a newer answer counts.
      // The server's wait after `rate_limited` still holds for this account
      // and device, so the newer load goes at its end.
      again = false;
      if (!result.ok && result.reason === "rate_limited") {
        rateLimitedUntil =
          now() + workspaceRetryDelayMs(attempt, "rate_limited");
        if (!loaded) {
          // Nothing is loaded yet, so without the problem the screen would
          // say for the whole wait that the requests load.
          problem = "rate_limited";
          touch();
        }
      }
      reload();
      return;
    }
    if (!result.ok) {
      loadFailed(result.reason);
      return;
    }
    const at = clock();
    requests = Object.freeze(
      result.value.joinRequests.map((request) =>
        requestAsOf(requestState(request), at),
      ),
    );
    loaded = true;
    problem = null;
    attempt = 0;
    rateLimitedUntil = null;
    touch();
  }

  function loadFailed(reason: WorkspaceReadFailure): void {
    problem = reason;
    touch();
    log(`The own join requests did not load (${reason}).`);
    const delayMs = workspaceRetryDelayMs(attempt, reason);
    if (reason === "rate_limited") {
      rateLimitedUntil = now() + delayMs;
    }
    // Offline, the next `connected` loads anyway, once a wait after
    // `rate_limited` has ended.
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
        // The only retry that runs during a wait after `rate_limited` is
        // the one at its end; a timer that fires a moment early on the
        // monotonic clock must not wait again.
        rateLimitedUntil = null;
        reload();
      });
    }, delayMs);
  }

  function messageReceived(message: ServerMessage): void {
    if (
      device !== null &&
      message.kind === "frame" &&
      message.frame.type === "account.join_request_decided"
    ) {
      // The reload reads the decision; see the top of this file.
      reload();
    }
  }

  function accountChanged(status: AccountStatus): void {
    const next = signedInDevice(status);
    if (next !== device) {
      if (device !== null) {
        reset();
      }
      device = next;
      touch();
      // The new device's requests load once no sign-in runs.
      loadWaiting = next !== null;
    }
    signInRunning = status.signIn.kind !== "idle";
    if (loadWaiting && !signInRunning) {
      loadWaiting = false;
      reload();
    }
  }

  function connectionChanged(state: string): void {
    const isConnected = state === "connected";
    if (isConnected === connected) {
      return;
    }
    connected = isConnected;
    if (isConnected) {
      // Account frames sent while the device was offline are lost.
      reload();
      return;
    }
    // The next `connected` loads; a retry offline would wait for it anyway.
    stopRetry();
  }

  function load(): OwnJoinRequestLoadOutcome {
    if (closed) {
      return NOT_SIGNED_IN;
    }
    // The screen asked, also when it opened before a device was signed in:
    // the requests then load once a device is. The refusal sends nothing
    // and starts no cooldown.
    requested = true;
    if (device === null) {
      return NOT_SIGNED_IN;
    }
    const at = now();
    if (
      lastRequest !== null &&
      at - lastRequest < OWN_JOIN_REQUEST_LOAD_COOLDOWN_MS
    ) {
      return TOO_SOON;
    }
    lastRequest = at;
    reload();
    return LOADING;
  }

  const removers = [
    account.onStatusChange((status) => run(() => accountChanged(status))),
    connection.onStatusChange((status) =>
      run(() => connectionChanged(status.state)),
    ),
    connection.onMessage((message) => run(() => messageReceived(message))),
  ];
  accountChanged(account.status());
  connectionChanged(connection.status().state);
  // The first state is revision 0.
  current = buildState();
  dirty = false;

  return Object.freeze({
    state: () => current,
    onChange: (listener: (state: OwnJoinRequestListState) => void) => {
      const entry = (state: OwnJoinRequestListState) => listener(state);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    load: () => run(load),
    reload: () => run(reload),
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
