import {
  type CreateJoinRequestResponse,
  type JoinRequestId,
  JoinRequestIdSchema,
  type WorkspaceId,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  OWN_JOIN_REQUEST_LIMITS,
  type CreateJoinRequestResult,
  type OwnJoinRequestActionRefusal,
  type WithdrawJoinRequestResult,
} from "../shared/ipc-contract.ts";
import type { AccountService } from "./account.ts";
import type {
  WorkspaceActionFailure,
  WorkspaceActionResult,
} from "./api-actions.ts";
import { createInvokeHandler, type IpcRegistry } from "./ipc.ts";
import type { OwnJoinRequestService } from "./own-join-requests/service.ts";

/**
 * Each failure of a create and what the join screen gets. `satisfies`
 * checks the fresh literal, so the record fails to compile when the
 * allowlist gains or loses a failure. The API answers a create
 * (`MEMBERSHIP_ROUTE_ERRORS`) with `workspace_not_found`,
 * `join_requests_closed`, and `already_member` beyond the common codes.
 * The codes of a workspace's people, invitations, and requests, and
 * `device_too_new`, which the protocol does not list for a create (the
 * Project Manager's decision of 2026-11-12), would be refusals that the
 * desktop does not expect, `failed`.
 */
const CREATE_OUTCOMES = {
  invalid: "invalid",
  too_soon: "too_soon",
  not_signed_in: "not_signed_in",
  unavailable: "unavailable",
  forbidden: "failed",
  not_found: "failed",
  conflict: "failed",
  already_member: "already_member",
  invitation_invalid: "failed",
  join_requests_closed: "join_requests_closed",
  workspace_not_found: "workspace_not_found",
  device_too_new: "failed",
  unclaimed_limit: "failed",
  project_limit: "failed",
  rate_limited: "rate_limited",
  unknown: "unknown",
  failed: "failed",
} satisfies Record<
  WorkspaceActionFailure,
  OwnJoinRequestActionRefusal | "unknown"
>;
Object.freeze(CREATE_OUTCOMES);

/**
 * Each failure of a withdrawal and what the join screen gets. The API
 * answers a withdrawal with `not_found` and `conflict` beyond the common
 * codes; the others would be refusals that the desktop does not expect,
 * `failed`.
 */
const WITHDRAW_OUTCOMES = {
  invalid: "invalid",
  too_soon: "too_soon",
  not_signed_in: "not_signed_in",
  unavailable: "unavailable",
  forbidden: "failed",
  not_found: "not_found",
  conflict: "conflict",
  already_member: "failed",
  invitation_invalid: "failed",
  join_requests_closed: "failed",
  workspace_not_found: "failed",
  device_too_new: "failed",
  unclaimed_limit: "failed",
  project_limit: "failed",
  rate_limited: "rate_limited",
  unknown: "unknown",
  failed: "failed",
} satisfies Record<
  WorkspaceActionFailure,
  OwnJoinRequestActionRefusal | "unknown"
>;
Object.freeze(WITHDRAW_OUTCOMES);

const UNKNOWN = Object.freeze({ outcome: "unknown" } as const);
const OK = Object.freeze({ outcome: "ok" } as const);

type Refused = {
  readonly outcome: "refused";
  readonly reason: OwnJoinRequestActionRefusal;
  readonly retryAfterMs: number | null;
};

function refused(
  reason: OwnJoinRequestActionRefusal,
  retryAfterMs: number | null = null,
): Refused {
  return Object.freeze({ outcome: "refused", reason, retryAfterMs });
}

/** The result of a failed write by `outcomes`, with the wait of a wait. */
function failedResult(
  outcomes: Readonly<
    Record<WorkspaceActionFailure, OwnJoinRequestActionRefusal | "unknown">
  >,
  result: Extract<WorkspaceActionResult<unknown>, { ok: false }>,
): Refused | typeof UNKNOWN {
  const outcome = outcomes[result.reason];
  if (outcome === "unknown") {
    return UNKNOWN;
  }
  return "retryAfterMs" in result
    ? refused(outcome, result.retryAfterMs)
    : refused(outcome);
}

/** `text`, cut to `maxLength` characters (code points), as zod counts them. */
function cut(text: string, maxLength: number): string {
  const characters = Array.from(text);
  return characters.length > maxLength
    ? characters.slice(0, maxLength).join("")
    : text;
}

/**
 * Whether the own join requests are read again after a create or a
 * withdrawal with `result` (D3: after an action): after `ok`, after a
 * withdrawal whose answer says that the shown list is out of date
 * (`not_found`, `conflict`), and when the answer does not say what
 * happened (`unknown`). Nothing changed after any other refusal.
 */
function reloadsAfter(
  result: CreateJoinRequestResult | WithdrawJoinRequestResult,
): boolean {
  switch (result.outcome) {
    case "ok":
    case "unknown":
      return true;
    case "refused":
      return result.reason === "not_found" || result.reason === "conflict";
  }
}

/** The renderer's own join request actions, in the main process. Each never rejects. */
export interface OwnJoinRequestActions {
  readonly create: (
    workspaceId: string,
    displayName: string | null,
  ) => Promise<CreateJoinRequestResult>;
  readonly withdraw: (
    joinRequestId: string,
  ) => Promise<WithdrawJoinRequestResult>;
}

export interface OwnJoinRequestActionsOptions {
  readonly account: Pick<AccountService, "status" | "sendWorkspaceAction">;
  readonly ownJoinRequests: Pick<OwnJoinRequestService, "reload">;
  /**
   * Receives a fixed message when a write throws, which the account
   * service never does. Defaults to `console.error`.
   */
  readonly onError?: (message: string) => void;
}

/**
 * The two actions of the requester (#95, decision D1; ADR 0014, "Join
 * requests"), each one write of the allowlist (`api-actions.ts`) through
 * the account service's `sendWorkspaceAction`: a create, which asks to join
 * a workspace by its ID with a requested display name, and the withdrawal
 * of an own pending request. Each checks its ID with the protocol's ID
 * schemas, after the contract's own check, before anything is sent. A
 * create's display name defaults to the account's (`users.display_name`,
 * from the device record that the account status shows). The status holds
 * that name, at least one character, whenever an account is signed in, so
 * a create without a name while none is answers `not_signed_in`, as the
 * account service would. The account service checks the name with
 * the protocol's request schema. A write is sent once and never again on
 * its own: an uncertain answer is `unknown`. The account service's
 * refusals come through as they are, `too_soon` and `rate_limited` with
 * their wait.
 *
 * Neither action is tied to the selected workspace, because the person is
 * not a member of the workspace that a request names. After an action, the
 * own join requests load again (`reloadsAfter`). A confirmed create answers
 * the pending request, also one that was pending already, and only when it
 * names the workspace that was asked; the API's answer holds no user ID.
 */
export function createOwnJoinRequestActions(
  options: OwnJoinRequestActionsOptions,
): OwnJoinRequestActions {
  const { account, ownJoinRequests } = options;
  const onError =
    options.onError ?? ((message: string) => console.error(message));

  /**
   * The account's display name from its status, or null while no account
   * is signed in. A signed-in status always has one: it comes from the
   * device record, which holds it by the protocol's rule (1 to 64
   * characters, not blank), and the contract requires it as well.
   */
  function accountDisplayName(): string | null {
    const shown = account.status().account;
    return shown.kind === "signed_in" ? shown.displayName : null;
  }

  /**
   * Sends one write and maps its answer with `ok` and its failure with
   * `outcomes`. A write that throws is `unknown`, reported with `report`.
   */
  async function send<T, O>(
    write: () => Promise<WorkspaceActionResult<T>>,
    ok: (value: T) => O | typeof UNKNOWN,
    outcomes: Readonly<
      Record<WorkspaceActionFailure, OwnJoinRequestActionRefusal | "unknown">
    >,
    report: string,
  ): Promise<O | Refused | typeof UNKNOWN> {
    try {
      const answer = await write();
      return answer.ok ? ok(answer.value) : failedResult(outcomes, answer);
    } catch {
      // A fixed message: never the error, which might hold the body.
      onError(report);
      return UNKNOWN;
    }
  }

  /** Reads the own join requests again when `reloadsAfter` holds. */
  function settled<
    R extends CreateJoinRequestResult | WithdrawJoinRequestResult,
  >(result: R): R {
    if (reloadsAfter(result)) {
      ownJoinRequests.reload();
    }
    return result;
  }

  return Object.freeze({
    create: async (
      workspaceValue: string,
      displayName: string | null,
    ): Promise<CreateJoinRequestResult> => {
      const parsed = WorkspaceIdSchema.safeParse(workspaceValue);
      if (!parsed.success) {
        return refused("invalid");
      }
      const workspaceId: WorkspaceId = parsed.data;
      const name = displayName ?? accountDisplayName();
      if (name === null) {
        // Only an account that is signed in has a name.
        return refused("not_signed_in");
      }
      const result = await send(
        () =>
          account.sendWorkspaceAction(
            "createJoinRequest",
            {},
            { workspaceId, displayName: name },
          ),
        (answer: CreateJoinRequestResponse): CreateJoinRequestResult => {
          // A request for another workspace is not this write's answer.
          const { joinRequest } = answer;
          return joinRequest.workspaceId === workspaceId
            ? Object.freeze({
                outcome: "ok",
                joinRequestId: joinRequest.id,
                workspaceId: joinRequest.workspaceId,
                requestedName: cut(
                  joinRequest.requestedDisplayName,
                  OWN_JOIN_REQUEST_LIMITS.displayName,
                ),
                createdAt: joinRequest.createdAt,
                expiresAt: joinRequest.expiresAt,
              })
            : UNKNOWN;
        },
        CREATE_OUTCOMES,
        "A join request could not be created.",
      );
      return settled(result);
    },
    withdraw: async (
      joinRequestValue: string,
    ): Promise<WithdrawJoinRequestResult> => {
      const parsed = JoinRequestIdSchema.safeParse(joinRequestValue);
      if (!parsed.success) {
        return refused("invalid");
      }
      const joinRequestId: JoinRequestId = parsed.data;
      const result = await send(
        () =>
          account.sendWorkspaceAction("withdrawJoinRequest", { joinRequestId }),
        (): WithdrawJoinRequestResult => OK,
        WITHDRAW_OUTCOMES,
        "A join request could not be withdrawn.",
      );
      return settled(result);
    },
  });
}

/**
 * Registers the handlers of the two own join request action channels (#95,
 * D1). Every handler checks the sender and the arguments first
 * (`createInvokeHandler`): IDs as lowercase UUIDv7s, and a display name of
 * 1 to 64 characters or null, with no extra argument. No refusal repeats an
 * argument. The result is parsed by the contract, so only fixed codes, a
 * wait, and the pending request's IDs, name, and times reach the renderer.
 * Call it before the first window loads.
 */
export function registerOwnJoinRequestActionsIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: OwnJoinRequestActionsOptions,
): void {
  const actions = createOwnJoinRequestActions(options);
  ipc.handle(
    INVOKE_CHANNELS.createJoinRequest,
    createInvokeHandler(
      INVOKE_CHANNELS.createJoinRequest,
      appUrl,
      (_event, [workspaceId, displayName]) =>
        actions.create(workspaceId, displayName),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.withdrawJoinRequest,
    createInvokeHandler(
      INVOKE_CHANNELS.withdrawJoinRequest,
      appUrl,
      (_event, [joinRequestId]) => actions.withdraw(joinRequestId),
    ),
  );
}
