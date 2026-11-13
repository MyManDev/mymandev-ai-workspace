import { UtcTimestampSchema, WorkspaceIdSchema } from "@mymandev/protocol";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  CLAIM_LIMITS,
  type ClaimLoadResult,
  type ClaimMarkSeenResult,
  type ClaimStatusView,
  type ClaimsView,
  type ClaimView,
} from "../shared/ipc-contract.ts";
import type {
  ClaimListState,
  ClaimListStatus,
  ClaimService,
  ClaimState,
} from "./claims/service.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type { ScheduleTimer } from "./runtime.ts";

/**
 * The shortest time between two publishes of the claims. A burst of changes
 * sends the latest view once at the end of it.
 */
export const CLAIM_PUBLISH_INTERVAL_MS = 50;

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
} satisfies Record<ClaimListStatus, ClaimStatusView>;
Object.freeze(STATUS_VIEWS);

const INVALID: ClaimMarkSeenResult = Object.freeze({
  outcome: "refused",
  reason: "invalid",
});

function claimView(claim: ClaimState): ClaimView {
  return Object.freeze({
    memberId: claim.memberId,
    login: claim.claimer?.login ?? null,
    verifiedAt: claim.claimer?.verifiedAt ?? null,
    accountCreatedAt: claim.claimer?.accountCreatedAt ?? null,
    via: claim.via,
    claimedAt: claim.claimedAt,
    unseen: claim.unseen,
  });
}

/**
 * The frozen copy of the service's state that crosses IPC, with `revision`
 * as its revision. Each claim crosses with the claimed person's member ID,
 * the claimer's GitHub login with its verification time and the creation
 * date of that GitHub account, how and when the person was claimed, and
 * whether the account has not seen it yet. The list holds at most
 * `CLAIM_LIMITS.claims`. The service holds the claims only while the
 * account's own person is the owner or an admin of the selected workspace,
 * so for anyone else the list is empty. No user ID crosses.
 */
export function claimsView(
  state: ClaimListState,
  revision: number,
): ClaimsView {
  const fields = {
    revision,
    workspaceId: state.workspaceId,
    claims: Object.freeze(
      state.claims.slice(0, CLAIM_LIMITS.claims).map(claimView),
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

/**
 * The screen's report that it showed the claims of `workspaceId` up to
 * `claimedAt`, after the contract's check: the protocol's own schemas check
 * the workspace ID and the time again, as the API checks them, and refuse
 * them as `invalid` before the service is asked; the service then accepts
 * only the time of a held claim of the selected workspace.
 */
export function markClaimsSeen(
  claims: Pick<ClaimService, "markSeen">,
  workspaceId: string,
  claimedAt: string,
): ClaimMarkSeenResult {
  const workspace = WorkspaceIdSchema.safeParse(workspaceId);
  const time = UtcTimestampSchema.safeParse(claimedAt);
  if (!workspace.success || !time.success) {
    return INVALID;
  }
  return claims.markSeen(workspace.data, time.data);
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export interface ClaimIpcOptions {
  readonly claims: Pick<
    ClaimService,
    "state" | "onChange" | "load" | "markSeen"
  >;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /**
   * Receives a fixed message when a publish fails, never the error, so that
   * nothing that the error holds reaches a log. Defaults to
   * `console.error`.
   */
  readonly onError?: (message: string) => void;
}

export interface ClaimIpc {
  /** Stops listening and cancels a publish that waits, for the quit. */
  readonly close: () => void;
}

/**
 * Registers the handlers of the claim channels and sends the selected
 * workspace's recent claims to the frames that subscribed (#95, decision
 * D8). The state channels and the load take no argument; the report of the
 * claims that the screen showed takes the workspace ID and a time, which
 * the protocol's schemas check again before the service is asked. Every
 * handler checks the sender and the arguments first (`createInvokeHandler`)
 * and answers with a value parsed by the contract, so only member IDs,
 * logins, times, and fixed codes reach the renderer, never a user ID.
 *
 * A change of the service raises the view's revision at once and publishes
 * the latest view after `CLAIM_PUBLISH_INTERVAL_MS`, so at most one view
 * goes out in each interval and the last change of a burst is always sent.
 * Call it before the first window loads.
 */
export function registerClaimIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: ClaimIpcOptions,
): ClaimIpc {
  const { claims } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const onError =
    options.onError ?? ((message: string) => console.error(message));
  const publisher = createEventPublisher(
    EVENT_CHANNELS.claimStateChanged,
    appUrl,
  );

  let closed = false;
  let revision = 0;
  let cancelPublish: (() => void) | null = null;

  function view(): ClaimsView {
    return claimsView(claims.state(), revision);
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
      onError("Sending the claims failed.");
    }
  }

  function changed(): void {
    if (closed) {
      return;
    }
    revision += 1;
    // A publish that waits sends the latest view when its time comes.
    cancelPublish ??= schedule(publish, CLAIM_PUBLISH_INTERVAL_MS);
  }

  ipc.handle(
    INVOKE_CHANNELS.getClaimState,
    createInvokeHandler(INVOKE_CHANNELS.getClaimState, appUrl, () => view()),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeClaimState,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeClaimState,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return view();
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.loadClaims,
    createInvokeHandler(
      INVOKE_CHANNELS.loadClaims,
      appUrl,
      (): ClaimLoadResult => claims.load(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.markClaimsSeen,
    createInvokeHandler(
      INVOKE_CHANNELS.markClaimsSeen,
      appUrl,
      (_event, [workspaceId, claimedAt]): ClaimMarkSeenResult =>
        markClaimsSeen(claims, workspaceId, claimedAt),
    ),
  );
  const remove = claims.onChange(changed);

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
