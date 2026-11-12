import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  JOIN_REQUEST_LIMITS,
  type BlockedJoinRequestView,
  type JoinRequestLoadResult,
  type JoinRequestStatusView,
  type JoinRequestsView,
  type PendingJoinRequestView,
} from "../shared/ipc-contract.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type {
  BlockedJoinRequestState,
  JoinRequestListState,
  JoinRequestListStatus,
  JoinRequestService,
  PendingJoinRequestState,
} from "./join-requests/service.ts";
import type { ScheduleTimer } from "./runtime.ts";

/**
 * The shortest time between two publishes of the join requests. A burst of
 * changes sends the latest view once at the end of it.
 */
export const JOIN_REQUEST_PUBLISH_INTERVAL_MS = 50;

/**
 * Each status of the service and its status in the contract. `satisfies`
 * checks the fresh literal, so the record fails to compile when the service
 * gains or loses a status.
 */
const STATUS_VIEWS = {
  signed_out: "signed_out",
  no_workspace: "no_workspace",
  not_allowed: "not_allowed",
  loading: "loading",
  ready: "ready",
  unavailable: "unavailable",
} satisfies Record<JoinRequestListStatus, JoinRequestStatusView>;
Object.freeze(STATUS_VIEWS);

/** `text`, cut to `maxLength` characters (code points), as zod counts them. */
function cut(text: string, maxLength: number): string {
  const characters = Array.from(text);
  return characters.length > maxLength
    ? characters.slice(0, maxLength).join("")
    : text;
}

function pendingView(request: PendingJoinRequestState): PendingJoinRequestView {
  return Object.freeze({
    joinRequestId: request.id,
    requestedName: cut(
      request.requestedDisplayName,
      JOIN_REQUEST_LIMITS.displayName,
    ),
    login: request.requester.login,
    verifiedAt: request.requester.verifiedAt,
    accountCreatedAt: request.requester.accountCreatedAt,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  });
}

function blockedView(request: BlockedJoinRequestState): BlockedJoinRequestView {
  return Object.freeze({
    joinRequestId: request.id,
    requestedName: cut(
      request.requestedDisplayName,
      JOIN_REQUEST_LIMITS.displayName,
    ),
    login: request.requester?.login ?? null,
    verifiedAt: request.requester?.verifiedAt ?? null,
    accountCreatedAt: request.requester?.accountCreatedAt ?? null,
    createdAt: request.createdAt,
    blockedAt: request.blockedAt,
  });
}

/**
 * The frozen copy of the service's state that crosses IPC, with `revision`
 * as its revision. Each pending request crosses with its ID, the requested
 * display name, the requester's GitHub login with its verification time and
 * the creation date of that GitHub account, and its times; each block with
 * the same and when it was blocked. A pending request past its `expiresAt`
 * at `now` (milliseconds since the epoch) is left out, also before the
 * service's expiry timer drops it. Each list holds at most
 * `JOIN_REQUEST_LIMITS.requests`, and a longer name is cut. The service
 * holds the requests and the pause only while the account's own person is
 * the owner or an admin of the selected workspace, so for anyone else both
 * lists are empty and `pausedAt` is null. No user ID crosses.
 */
export function joinRequestsView(
  state: JoinRequestListState,
  revision: number,
  now: number,
): JoinRequestsView {
  const fields = {
    revision,
    workspaceId: state.workspaceId,
    pending: Object.freeze(
      state.pending
        .filter((request) => Date.parse(request.expiresAt) > now)
        .slice(0, JOIN_REQUEST_LIMITS.requests)
        .map(pendingView),
    ),
    blocked: Object.freeze(
      state.blocked.slice(0, JOIN_REQUEST_LIMITS.requests).map(blockedView),
    ),
    pausedAt: state.pausedAt,
  };
  const status = STATUS_VIEWS[state.status];
  if (status === "unavailable") {
    return Object.freeze({
      status,
      problem: state.problem ?? "failed",
      ...fields,
    });
  }
  return Object.freeze({ status, ...fields });
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export interface JoinRequestIpcOptions {
  readonly joinRequests: Pick<
    JoinRequestService,
    "state" | "onChange" | "load"
  >;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /**
   * The current time in milliseconds since the epoch, for the expiry of a
   * request. Defaults to `Date.now`.
   */
  readonly now?: () => number;
  /**
   * Receives a fixed message when a publish fails, never the error, so that
   * nothing that the error holds reaches a log. Defaults to
   * `console.error`.
   */
  readonly onError?: (message: string) => void;
}

export interface JoinRequestIpc {
  /** Stops listening and cancels a publish that waits, for the quit. */
  readonly close: () => void;
}

/**
 * Registers the handlers of the join request state channels and sends the
 * selected workspace's join requests to the frames that subscribed (#95,
 * decision D3). The channels take no argument; the actions have their own
 * channels (`join-request-actions-ipc.ts`). Every handler checks the sender
 * and the arguments first (`createInvokeHandler`) and answers with a value
 * parsed by the contract, so only IDs, names, logins, times, and fixed
 * codes reach the renderer, never a user ID.
 *
 * A change of the service raises the view's revision at once and publishes
 * the latest view after `JOIN_REQUEST_PUBLISH_INTERVAL_MS`, so at most one
 * view goes out in each interval and the last change of a burst is always
 * sent. Call it before the first window loads.
 */
export function registerJoinRequestIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: JoinRequestIpcOptions,
): JoinRequestIpc {
  const { joinRequests } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? Date.now;
  const onError =
    options.onError ?? ((message: string) => console.error(message));
  const publisher = createEventPublisher(
    EVENT_CHANNELS.joinRequestStateChanged,
    appUrl,
  );

  let closed = false;
  let revision = 0;
  let cancelPublish: (() => void) | null = null;

  function view(): JoinRequestsView {
    return joinRequestsView(joinRequests.state(), revision, now());
  }

  function publish(): void {
    cancelPublish = null;
    if (closed) {
      return;
    }
    try {
      publisher.publish(view());
    } catch {
      // A fixed message: the error is not logged, whatever it holds.
      onError("Sending the join requests failed.");
    }
  }

  function changed(): void {
    if (closed) {
      return;
    }
    revision += 1;
    // A publish that waits sends the latest view when its time comes.
    cancelPublish ??= schedule(publish, JOIN_REQUEST_PUBLISH_INTERVAL_MS);
  }

  ipc.handle(
    INVOKE_CHANNELS.getJoinRequestState,
    createInvokeHandler(INVOKE_CHANNELS.getJoinRequestState, appUrl, () =>
      view(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeJoinRequestState,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeJoinRequestState,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return view();
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.loadJoinRequests,
    createInvokeHandler(
      INVOKE_CHANNELS.loadJoinRequests,
      appUrl,
      (): JoinRequestLoadResult => joinRequests.load(),
    ),
  );
  const remove = joinRequests.onChange(changed);

  return Object.freeze({
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      remove();
      cancelPublish?.();
      cancelPublish = null;
    },
  });
}
