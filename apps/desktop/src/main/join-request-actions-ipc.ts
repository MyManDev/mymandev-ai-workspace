import {
  type ApproveJoinRequestResponse,
  type JoinRequestId,
  JoinRequestIdSchema,
  type WorkspaceId,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type {
  ApproveJoinRequestResult,
  JoinRequestActionRefusal,
  JoinRequestActionResult,
} from "../shared/ipc-contract.ts";
import type { AccountService } from "./account.ts";
import type {
  WorkspaceActionFailure,
  WorkspaceActionResult,
} from "./api-actions.ts";
import { createInvokeHandler, type IpcRegistry } from "./ipc.ts";
import type { JoinRequestService } from "./join-requests/service.ts";
import type { WorkspaceService } from "./workspace/service.ts";

/**
 * Each failure of a write and what the join requests screen gets.
 * `satisfies` checks the fresh literal, so the record fails to compile when
 * the allowlist gains or loses a failure. The API answers the join request
 * routes of a workspace (`MEMBERSHIP_ROUTE_ERRORS`) with `forbidden`,
 * `not_found`, `conflict`, and, for an approval, `already_member` beyond
 * the common codes; the codes of invitations, of a request to join, of
 * young devices, and of the limit of unclaimed people would be refusals
 * that the desktop does not expect, `failed`.
 */
const OUTCOMES = {
  invalid: "invalid",
  too_soon: "too_soon",
  not_signed_in: "not_signed_in",
  unavailable: "unavailable",
  forbidden: "not_allowed",
  not_found: "not_found",
  conflict: "conflict",
  already_member: "already_member",
  invitation_invalid: "failed",
  join_requests_closed: "failed",
  workspace_not_found: "failed",
  device_too_new: "failed",
  unclaimed_limit: "failed",
  rate_limited: "rate_limited",
  unknown: "unknown",
  failed: "failed",
} satisfies Record<
  WorkspaceActionFailure,
  JoinRequestActionRefusal | "unknown"
>;
Object.freeze(OUTCOMES);

const UNKNOWN = Object.freeze({ outcome: "unknown" } as const);
const OK = Object.freeze({ outcome: "ok" } as const);

type Refused = {
  readonly outcome: "refused";
  readonly reason: JoinRequestActionRefusal;
  readonly retryAfterMs: number | null;
};

function refused(
  reason: JoinRequestActionRefusal,
  retryAfterMs: number | null = null,
): Refused {
  return Object.freeze({ outcome: "refused", reason, retryAfterMs });
}

/** The result of a failed write, with its wait for `too_soon` and `rate_limited`. */
function failedResult(
  result: Extract<WorkspaceActionResult<unknown>, { ok: false }>,
): Refused | typeof UNKNOWN {
  const outcome = OUTCOMES[result.reason];
  if (outcome === "unknown") {
    return UNKNOWN;
  }
  return "retryAfterMs" in result
    ? refused(outcome, result.retryAfterMs)
    : refused(outcome);
}

/**
 * Whether what an action changes is read again after `result` (D3: after an
 * action): after `ok`, and when the answer says that the shown list is out
 * of date (`not_found`, `conflict`, `already_member`; the decision of
 * 2026-11-09 on #210) or does not say what happened (`unknown`). Nothing
 * changed after any other refusal.
 */
function reloadsAfter(
  result: ApproveJoinRequestResult | JoinRequestActionResult,
): boolean {
  switch (result.outcome) {
    case "ok":
    case "unknown":
      return true;
    case "refused":
      return (
        result.reason === "not_found" ||
        result.reason === "conflict" ||
        result.reason === "already_member"
      );
  }
}

/** The renderer's join request actions, in the main process. Each never rejects. */
export interface JoinRequestActions {
  readonly approve: (
    workspaceId: string,
    joinRequestId: string,
    displayName: string | null,
  ) => Promise<ApproveJoinRequestResult>;
  readonly deny: (
    workspaceId: string,
    joinRequestId: string,
  ) => Promise<JoinRequestActionResult>;
  readonly denyAll: (workspaceId: string) => Promise<JoinRequestActionResult>;
  readonly block: (
    workspaceId: string,
    joinRequestId: string,
  ) => Promise<JoinRequestActionResult>;
  readonly unblock: (
    workspaceId: string,
    joinRequestId: string,
  ) => Promise<JoinRequestActionResult>;
  readonly pause: (workspaceId: string) => Promise<JoinRequestActionResult>;
  readonly resume: (workspaceId: string) => Promise<JoinRequestActionResult>;
}

export interface JoinRequestActionsOptions {
  readonly account: Pick<AccountService, "sendWorkspaceAction">;
  readonly workspaces: Pick<WorkspaceService, "selectedWorkspaceId" | "reload">;
  readonly joinRequests: Pick<JoinRequestService, "reload">;
  /**
   * Receives a fixed message when a write throws, which the account
   * service never does. Defaults to `console.error`.
   */
  readonly onError?: (message: string) => void;
}

/**
 * The seven join request actions of the owner and the admins (#95,
 * decision D1; ADR 0014, "Join requests"), each one write of the allowlist
 * (`api-actions.ts`) through the account service's `sendWorkspaceAction`:
 * approve, with an optional display name that replaces the requested one;
 * deny; deny all; block; unblock; pause; and resume. Each checks its IDs
 * with the protocol's ID schemas, after the contract's own check, and
 * refuses a workspace that is not the selected one as `not_selected`,
 * before anything is sent; the account service checks the display name
 * with the protocol's request schema. A write is sent once and never again
 * on its own: an uncertain answer is `unknown`. The account service's
 * refusals come through as they are, `too_soon` and `rate_limited` with
 * their wait.
 *
 * Nothing changes the held requests here: the join request events do. After
 * a decision (approve, deny, deny all, block, unblock), the join requests
 * load again (`reloadsAfter`). A pause and a resume have no event, so the
 * selected workspace's view, which holds the pause, loads again after them
 * instead. A confirmed approval answers the new person's member ID only,
 * never its user ID.
 */
export function createJoinRequestActions(
  options: JoinRequestActionsOptions,
): JoinRequestActions {
  const { account, workspaces, joinRequests } = options;
  const onError =
    options.onError ?? ((message: string) => console.error(message));

  /** The workspace ID as the protocol's ID, or null. */
  function workspaceIdOf(value: string): WorkspaceId | null {
    const parsed = WorkspaceIdSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  /** The request ID as the protocol's ID, or null. */
  function joinRequestIdOf(value: string): JoinRequestId | null {
    const parsed = JoinRequestIdSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Sends one write and maps its answer with `ok` and its failure with
   * `OUTCOMES`. A write that throws is `unknown`, reported with `report`.
   */
  async function send<T, O>(
    write: () => Promise<WorkspaceActionResult<T>>,
    ok: (value: T) => O | typeof UNKNOWN,
    report: string,
  ): Promise<O | Refused | typeof UNKNOWN> {
    try {
      const answer = await write();
      return answer.ok ? ok(answer.value) : failedResult(answer);
    } catch {
      // A fixed message: never the error, which might hold the body.
      onError(report);
      return UNKNOWN;
    }
  }

  /**
   * A write for the selected workspace, after which `reload` reads again
   * what it changes when `reloadsAfter` holds.
   */
  async function act<
    R extends ApproveJoinRequestResult | JoinRequestActionResult,
  >(
    workspaceId: WorkspaceId,
    write: () => Promise<R>,
    reload: (workspaceId: WorkspaceId) => boolean,
  ): Promise<R | Refused> {
    if (workspaceId !== workspaces.selectedWorkspaceId()) {
      return refused("not_selected");
    }
    const result = await write();
    if (reloadsAfter(result)) {
      reload(workspaceId);
    }
    return result;
  }

  /** A decision on one request: deny, block, or unblock. */
  function decide(
    name: "denyJoinRequest" | "blockJoinRequest" | "unblockJoinRequest",
    report: string,
  ) {
    return async (
      workspaceValue: string,
      joinRequestValue: string,
    ): Promise<JoinRequestActionResult> => {
      const workspaceId = workspaceIdOf(workspaceValue);
      const joinRequestId = joinRequestIdOf(joinRequestValue);
      if (workspaceId === null || joinRequestId === null) {
        return refused("invalid");
      }
      return act(
        workspaceId,
        () =>
          send(
            () =>
              account.sendWorkspaceAction(name, { workspaceId, joinRequestId }),
            (): JoinRequestActionResult => OK,
            report,
          ),
        joinRequests.reload,
      );
    };
  }

  /** An action on the whole workspace: deny all, pause, or resume. */
  function ofWorkspace(
    name: "denyAllJoinRequests" | "pauseJoinRequests" | "resumeJoinRequests",
    reload: (workspaceId: WorkspaceId) => boolean,
    report: string,
  ) {
    return async (workspaceValue: string): Promise<JoinRequestActionResult> => {
      const workspaceId = workspaceIdOf(workspaceValue);
      if (workspaceId === null) {
        return refused("invalid");
      }
      return act(
        workspaceId,
        () =>
          send(
            () => account.sendWorkspaceAction(name, { workspaceId }),
            (): JoinRequestActionResult => OK,
            report,
          ),
        reload,
      );
    };
  }

  return Object.freeze({
    approve: async (
      workspaceValue: string,
      joinRequestValue: string,
      displayName: string | null,
    ): Promise<ApproveJoinRequestResult> => {
      const workspaceId = workspaceIdOf(workspaceValue);
      const joinRequestId = joinRequestIdOf(joinRequestValue);
      if (workspaceId === null || joinRequestId === null) {
        return refused("invalid");
      }
      return act(
        workspaceId,
        () =>
          send(
            () =>
              account.sendWorkspaceAction(
                "approveJoinRequest",
                { workspaceId, joinRequestId },
                displayName === null ? {} : { displayName },
              ),
            (answer: ApproveJoinRequestResponse): ApproveJoinRequestResult =>
              // Only the new person's member ID crosses: never its user ID.
              // A person of another workspace is not this write's answer.
              answer.member.workspaceId === workspaceId
                ? Object.freeze({ outcome: "ok", memberId: answer.member.id })
                : UNKNOWN,
            "A join request could not be approved.",
          ),
        joinRequests.reload,
      );
    },
    deny: decide("denyJoinRequest", "A join request could not be denied."),
    denyAll: ofWorkspace(
      "denyAllJoinRequests",
      joinRequests.reload,
      "The join requests could not be denied.",
    ),
    block: decide("blockJoinRequest", "A join request could not be blocked."),
    unblock: decide(
      "unblockJoinRequest",
      "A join request could not be unblocked.",
    ),
    // No event reports a pause or its end: the view that holds it loads
    // again.
    pause: ofWorkspace(
      "pauseJoinRequests",
      workspaces.reload,
      "The join requests could not be paused.",
    ),
    resume: ofWorkspace(
      "resumeJoinRequests",
      workspaces.reload,
      "The join requests could not be resumed.",
    ),
  });
}

/**
 * Registers the handlers of the seven join request action channels (#95,
 * D1). Every handler checks the sender and the arguments first
 * (`createInvokeHandler`): IDs as lowercase UUIDv7s, a display name of 1 to
 * 64 characters or null, with no extra argument. No refusal repeats an
 * argument. The result is parsed by the contract, so only fixed codes, a
 * wait, and a member ID reach the renderer. Call it before the first
 * window loads.
 */
export function registerJoinRequestActionsIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: JoinRequestActionsOptions,
): void {
  const actions = createJoinRequestActions(options);
  ipc.handle(
    INVOKE_CHANNELS.approveJoinRequest,
    createInvokeHandler(
      INVOKE_CHANNELS.approveJoinRequest,
      appUrl,
      (_event, [workspaceId, joinRequestId, displayName]) =>
        actions.approve(workspaceId, joinRequestId, displayName),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.denyJoinRequest,
    createInvokeHandler(
      INVOKE_CHANNELS.denyJoinRequest,
      appUrl,
      (_event, [workspaceId, joinRequestId]) =>
        actions.deny(workspaceId, joinRequestId),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.denyAllJoinRequests,
    createInvokeHandler(
      INVOKE_CHANNELS.denyAllJoinRequests,
      appUrl,
      (_event, [workspaceId]) => actions.denyAll(workspaceId),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.blockJoinRequest,
    createInvokeHandler(
      INVOKE_CHANNELS.blockJoinRequest,
      appUrl,
      (_event, [workspaceId, joinRequestId]) =>
        actions.block(workspaceId, joinRequestId),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.unblockJoinRequest,
    createInvokeHandler(
      INVOKE_CHANNELS.unblockJoinRequest,
      appUrl,
      (_event, [workspaceId, joinRequestId]) =>
        actions.unblock(workspaceId, joinRequestId),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.pauseJoinRequests,
    createInvokeHandler(
      INVOKE_CHANNELS.pauseJoinRequests,
      appUrl,
      (_event, [workspaceId]) => actions.pause(workspaceId),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.resumeJoinRequests,
    createInvokeHandler(
      INVOKE_CHANNELS.resumeJoinRequests,
      appUrl,
      (_event, [workspaceId]) => actions.resume(workspaceId),
    ),
  );
}
