import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  OWN_JOIN_REQUEST_LIMITS,
  type OwnJoinRequestLoadResult,
  type OwnJoinRequestStatusView,
  type OwnJoinRequestsView,
  type OwnJoinRequestView,
} from "../shared/ipc-contract.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import {
  requestAsOf,
  type OwnJoinRequestListState,
  type OwnJoinRequestListStatus,
  type OwnJoinRequestService,
  type OwnJoinRequestState,
} from "./own-join-requests/service.ts";
import type { ScheduleTimer } from "./runtime.ts";

/**
 * The shortest time between two publishes of the own join requests. A
 * burst of changes sends the latest view once at the end of it.
 */
export const OWN_JOIN_REQUEST_PUBLISH_INTERVAL_MS = 50;

/**
 * Each status of the service and its status in the contract. `satisfies`
 * checks the fresh literal, so the record fails to compile when the service
 * gains or loses a status.
 */
const STATUS_VIEWS = {
  signed_out: "signed_out",
  loading: "loading",
  ready: "ready",
  unavailable: "unavailable",
} satisfies Record<OwnJoinRequestListStatus, OwnJoinRequestStatusView>;
Object.freeze(STATUS_VIEWS);

/** `text`, cut to `maxLength` characters (code points), as zod counts them. */
function cut(text: string, maxLength: number): string {
  const characters = Array.from(text);
  return characters.length > maxLength
    ? characters.slice(0, maxLength).join("")
    : text;
}

function requestView(request: OwnJoinRequestState): OwnJoinRequestView {
  return Object.freeze({
    joinRequestId: request.id,
    workspaceId: request.workspaceId,
    requestedName: cut(
      request.requestedDisplayName,
      OWN_JOIN_REQUEST_LIMITS.displayName,
    ),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    decision: request.decision,
    decidedAt: request.decidedAt,
  });
}

/**
 * The frozen copy of the service's state that crosses IPC, with `revision`
 * as its revision. Each request crosses with its ID, the ID of the
 * workspace that it asks to join, the requested display name, its times,
 * and how it ended, or null twice while it is pending. A pending request
 * past its `expiresAt` at `now` (milliseconds since the epoch) crosses as
 * `expired`, decided at its expiry, also before the service's expiry timer
 * marks it. The list holds at most
 * `OWN_JOIN_REQUEST_LIMITS.requests`, the most recent first, and a longer
 * name is cut. No user ID crosses.
 */
export function ownJoinRequestsView(
  state: OwnJoinRequestListState,
  revision: number,
  now: number,
): OwnJoinRequestsView {
  const fields = {
    revision,
    requests: Object.freeze(
      state.requests
        .slice(0, OWN_JOIN_REQUEST_LIMITS.requests)
        .map((request) => requestView(requestAsOf(request, now))),
    ),
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

export interface OwnJoinRequestIpcOptions {
  readonly ownJoinRequests: Pick<
    OwnJoinRequestService,
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

export interface OwnJoinRequestIpc {
  /** Stops listening and cancels a publish that waits, for the quit. */
  readonly close: () => void;
}

/**
 * Registers the handlers of the own join request state channels and sends
 * the account's own join requests to the frames that subscribed (#95,
 * decision D3). The channels take no argument; the create and the
 * withdrawal have their own channels (`own-join-request-actions-ipc.ts`).
 * Every handler checks the sender and the arguments first
 * (`createInvokeHandler`) and answers with a value parsed by the contract,
 * so only IDs, names, decisions, times, and fixed codes reach the renderer,
 * never a user ID.
 *
 * A change of the service raises the view's revision at once and publishes
 * the latest view after `OWN_JOIN_REQUEST_PUBLISH_INTERVAL_MS`, so at most
 * one view goes out in each interval and the last change of a burst is
 * always sent. Call it before the first window loads.
 */
export function registerOwnJoinRequestIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: OwnJoinRequestIpcOptions,
): OwnJoinRequestIpc {
  const { ownJoinRequests } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? Date.now;
  const onError =
    options.onError ?? ((message: string) => console.error(message));
  const publisher = createEventPublisher(
    EVENT_CHANNELS.ownJoinRequestStateChanged,
    appUrl,
  );

  let closed = false;
  let revision = 0;
  let cancelPublish: (() => void) | null = null;

  function view(): OwnJoinRequestsView {
    return ownJoinRequestsView(ownJoinRequests.state(), revision, now());
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
      onError("Sending the own join requests failed.");
    }
  }

  function changed(): void {
    if (closed) {
      return;
    }
    revision += 1;
    // A publish that waits sends the latest view when its time comes.
    cancelPublish ??= schedule(publish, OWN_JOIN_REQUEST_PUBLISH_INTERVAL_MS);
  }

  ipc.handle(
    INVOKE_CHANNELS.getOwnJoinRequestState,
    createInvokeHandler(INVOKE_CHANNELS.getOwnJoinRequestState, appUrl, () =>
      view(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeOwnJoinRequestState,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeOwnJoinRequestState,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return view();
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.loadOwnJoinRequests,
    createInvokeHandler(
      INVOKE_CHANNELS.loadOwnJoinRequests,
      appUrl,
      (): OwnJoinRequestLoadResult => ownJoinRequests.load(),
    ),
  );
  const remove = ownJoinRequests.onChange(changed);

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
