import {
  type AcceptInvitationResponse,
  type CreateInvitationResponse,
  InvitationCodeSchema,
  type InvitationId,
  InvitationIdSchema,
  type MemberId,
  MemberIdSchema,
  type PreviewInvitationResponse,
  type WorkspaceId,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  INVITATION_LIMITS,
  type AcceptInvitationResult,
  type CreateInvitationResult,
  type InvitationActionRefusal,
  type JoinInvitationRefusal,
  type PreviewInvitationResult,
  type RevokeInvitationResult,
} from "../shared/ipc-contract.ts";
import type { AccountService } from "./account.ts";
import type {
  WorkspaceActionFailure,
  WorkspaceActionResult,
} from "./api-actions.ts";
import type { InvitationService } from "./invitations/service.ts";
import { createInvokeHandler, type IpcRegistry } from "./ipc.ts";
import type { WorkspaceService } from "./workspace/service.ts";

/**
 * Each failure of a create or a revocation and what the screen gets.
 * `satisfies` checks the fresh literal, so the record fails to compile when
 * the allowlist gains or loses a failure. The API answers the invitation
 * routes of a workspace (`MEMBERSHIP_ROUTE_ERRORS`) with `forbidden`,
 * `not_found`, and `conflict` beyond the common codes; the codes of a
 * pasted code, join requests, unknown workspaces, young devices, and the
 * limits of unclaimed people and of projects would be refusals that the
 * desktop does not expect, `failed`.
 */
const MANAGE_OUTCOMES = {
  invalid: "invalid",
  too_soon: "too_soon",
  not_signed_in: "not_signed_in",
  unavailable: "unavailable",
  forbidden: "not_allowed",
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
} satisfies Record<WorkspaceActionFailure, InvitationActionRefusal | "unknown">;
Object.freeze(MANAGE_OUTCOMES);

/**
 * Each failure of a preview or an accept and what the join screen gets.
 * The API answers them with `invitation_invalid` and `already_member`
 * beyond the common codes; the others would be refusals that the desktop
 * does not expect, `failed`.
 */
const JOIN_OUTCOMES = {
  invalid: "invalid",
  too_soon: "too_soon",
  not_signed_in: "not_signed_in",
  unavailable: "unavailable",
  forbidden: "failed",
  not_found: "failed",
  conflict: "failed",
  already_member: "already_member",
  invitation_invalid: "invitation_invalid",
  join_requests_closed: "failed",
  workspace_not_found: "failed",
  device_too_new: "failed",
  unclaimed_limit: "failed",
  project_limit: "failed",
  rate_limited: "rate_limited",
  unknown: "unknown",
  failed: "failed",
} satisfies Record<WorkspaceActionFailure, JoinInvitationRefusal | "unknown">;
Object.freeze(JOIN_OUTCOMES);

const UNKNOWN = Object.freeze({ outcome: "unknown" } as const);
const OK = Object.freeze({ outcome: "ok" } as const);

type Refused<R extends string> = {
  readonly outcome: "refused";
  readonly reason: R;
  readonly retryAfterMs: number | null;
};
type Failed<R extends string> = Refused<R> | typeof UNKNOWN;

function refused<R extends string>(
  reason: R,
  retryAfterMs: number | null = null,
): Refused<R> {
  return Object.freeze({ outcome: "refused", reason, retryAfterMs });
}

/** The result of a failed write by `outcomes`, with the wait of a wait. */
function failedResult<R extends string>(
  outcomes: Readonly<Record<WorkspaceActionFailure, R | "unknown">>,
  result: Extract<WorkspaceActionResult<unknown>, { ok: false }>,
): Failed<R> {
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
 * Whether the live invitations are read again after a create or a
 * revocation with `result` (D3: after an action): after `ok`, and when the
 * answer says that the shown list is out of date (`not_found`, `conflict`)
 * or does not say what happened (`unknown`). Nothing changed after any
 * other refusal.
 */
function reloadsAfter(
  result: CreateInvitationResult | RevokeInvitationResult,
): boolean {
  switch (result.outcome) {
    case "ok":
    case "unknown":
      return true;
    case "refused":
      return result.reason === "not_found" || result.reason === "conflict";
  }
}

/** The renderer's invitation actions, in the main process. Each never rejects. */
export interface InvitationActions {
  readonly create: (
    workspaceId: string,
    memberId: string,
    lifetimeSeconds: number | null,
  ) => Promise<CreateInvitationResult>;
  readonly revoke: (
    workspaceId: string,
    invitationId: string,
  ) => Promise<RevokeInvitationResult>;
  readonly preview: (code: string) => Promise<PreviewInvitationResult>;
  readonly accept: (code: string) => Promise<AcceptInvitationResult>;
}

export interface InvitationActionsOptions {
  readonly account: Pick<AccountService, "sendWorkspaceAction">;
  readonly workspaces: Pick<
    WorkspaceService,
    "selectedWorkspaceId" | "reloadList"
  >;
  readonly invitations: Pick<InvitationService, "reload">;
  /**
   * Receives a fixed message when a write throws, which the account
   * service never does. Defaults to `console.error`.
   */
  readonly onError?: (message: string) => void;
}

/**
 * The four invitation actions of #95 (decision D1), each one write of the
 * allowlist (`api-actions.ts`) through the account service's
 * `sendWorkspaceAction`, sent once and never again on its own: an uncertain
 * answer is `unknown`, because a second create would revoke the first
 * invitation and lose its code. The account service's refusals come
 * through as they are, `too_soon` and `rate_limited` with their wait.
 *
 * - A create and a revocation check their IDs with the protocol's ID
 *   schemas, after the contract's own check, and refuse a workspace that is
 *   not the selected one as `not_selected`, before anything is sent. The
 *   live invitations reload after them (`reloadsAfter`).
 * - A preview and an accept are not tied to the selected workspace, because
 *   the person is joining one. They check the pasted text with the
 *   protocol's `InvitationCodeSchema` exactly, without trimming it. After an
 *   accept that the API confirmed, or whose answer is `unknown`, the
 *   workspace list loads again, so that the joined workspace appears in it.
 *
 * The code (D2) crosses into the main process only in a preview's or an
 * accept's argument and goes on in the body of its write, and comes back
 * once in the answer of a create, which is passed on to the renderer as it
 * is: nothing here keeps it, logs it, or puts it in a state, and an error
 * is reported with a fixed message only.
 */
export function createInvitationActions(
  options: InvitationActionsOptions,
): InvitationActions {
  const { account, workspaces, invitations } = options;
  const onError =
    options.onError ?? ((message: string) => console.error(message));

  /** The workspace ID as the protocol's ID, or null. */
  function workspaceIdOf(value: string): WorkspaceId | null {
    const parsed = WorkspaceIdSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  /** The pasted text as the protocol's invitation code, or null. */
  function codeOf(value: string): string | null {
    const parsed = InvitationCodeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  /**
   * Sends one write and maps its answer with `ok` and its failure with
   * `outcomes`. A write that throws is `unknown`, reported with `report`.
   */
  async function send<T, R extends string, O>(
    write: () => Promise<WorkspaceActionResult<T>>,
    ok: (value: T) => O | typeof UNKNOWN,
    outcomes: Readonly<Record<WorkspaceActionFailure, R | "unknown">>,
    report: string,
  ): Promise<O | Failed<R>> {
    try {
      const answer = await write();
      return answer.ok ? ok(answer.value) : failedResult(outcomes, answer);
    } catch {
      // A fixed message: never the error, which might hold the body.
      onError(report);
      return UNKNOWN;
    }
  }

  /** A write for the selected workspace, which reloads the list after it. */
  async function manage<
    R extends CreateInvitationResult | RevokeInvitationResult,
  >(
    workspaceId: WorkspaceId,
    write: () => Promise<R>,
  ): Promise<R | Refused<InvitationActionRefusal>> {
    if (workspaceId !== workspaces.selectedWorkspaceId()) {
      return refused("not_selected");
    }
    const result = await write();
    if (reloadsAfter(result)) {
      invitations.reload(workspaceId);
    }
    return result;
  }

  return Object.freeze({
    create: async (
      workspaceValue: string,
      memberValue: string,
      lifetimeSeconds: number | null,
    ): Promise<CreateInvitationResult> => {
      const workspaceId = workspaceIdOf(workspaceValue);
      const memberId = MemberIdSchema.safeParse(memberValue);
      if (workspaceId === null || !memberId.success) {
        return refused("invalid");
      }
      const target: MemberId = memberId.data;
      return manage(workspaceId, () =>
        send(
          () =>
            account.sendWorkspaceAction(
              "createInvitation",
              { workspaceId },
              lifetimeSeconds === null
                ? { memberId: target }
                : { memberId: target, lifetimeSeconds },
            ),
          (value: CreateInvitationResponse): CreateInvitationResult => {
            // The code goes to the renderer once, with the invitation's ID
            // and expiry. An invitation of another workspace or person is
            // not this write's answer, and its code is dropped.
            const { invitation, code } = value;
            return invitation.workspaceId === workspaceId &&
              invitation.memberId === target
              ? Object.freeze({
                  outcome: "ok",
                  invitationId: invitation.id,
                  code,
                  expiresAt: invitation.expiresAt,
                })
              : UNKNOWN;
          },
          MANAGE_OUTCOMES,
          "An invitation could not be created.",
        ),
      );
    },
    revoke: async (
      workspaceValue: string,
      invitationValue: string,
    ): Promise<RevokeInvitationResult> => {
      const workspaceId = workspaceIdOf(workspaceValue);
      const invitationId = InvitationIdSchema.safeParse(invitationValue);
      if (workspaceId === null || !invitationId.success) {
        return refused("invalid");
      }
      const target: InvitationId = invitationId.data;
      return manage(workspaceId, () =>
        send(
          () =>
            account.sendWorkspaceAction("revokeInvitation", {
              workspaceId,
              invitationId: target,
            }),
          (): RevokeInvitationResult => OK,
          MANAGE_OUTCOMES,
          "An invitation could not be revoked.",
        ),
      );
    },
    preview: async (value: string): Promise<PreviewInvitationResult> => {
      const code = codeOf(value);
      if (code === null) {
        return refused("invalid");
      }
      return send(
        () => account.sendWorkspaceAction("previewInvitation", {}, { code }),
        (answer: PreviewInvitationResponse): PreviewInvitationResult =>
          Object.freeze({
            outcome: "ok",
            workspaceName: cut(
              answer.workspaceName,
              INVITATION_LIMITS.workspaceName,
            ),
            displayName: cut(answer.displayName, INVITATION_LIMITS.displayName),
            inviterName: cut(
              answer.inviter.displayName,
              INVITATION_LIMITS.displayName,
            ),
            inviterLogin: answer.inviter.identity.login,
            inviterVerifiedAt: answer.inviter.identity.verifiedAt,
            expiresAt: answer.expiresAt,
          }),
        JOIN_OUTCOMES,
        "An invitation could not be previewed.",
      );
    },
    accept: async (value: string): Promise<AcceptInvitationResult> => {
      const code = codeOf(value);
      if (code === null) {
        return refused("invalid");
      }
      const result = await send(
        () => account.sendWorkspaceAction("acceptInvitation", {}, { code }),
        (answer: AcceptInvitationResponse): AcceptInvitationResult =>
          // Only the workspace crosses: never the person's user ID.
          Object.freeze({
            outcome: "ok",
            workspaceId: answer.workspace.id,
            workspaceName: cut(
              answer.workspace.name,
              INVITATION_LIMITS.workspaceName,
            ),
          }),
        JOIN_OUTCOMES,
        "An invitation could not be accepted.",
      );
      if (result.outcome === "ok" || result.outcome === "unknown") {
        // No account frame reports the new membership.
        workspaces.reloadList();
      }
      return result;
    },
  });
}

/**
 * Registers the handlers of the four invitation action channels (#95, D1).
 * Every handler checks the sender and the arguments first
 * (`createInvokeHandler`): IDs as lowercase UUIDv7s, a lifetime of 1 hour
 * to 7 days or null, and a pasted text in the exact form of an invitation
 * code, with no extra argument. No refusal repeats an argument. The result
 * is parsed by the contract, so only fixed codes, a wait, IDs, names,
 * times, and the code of a new invitation, once, reach the renderer. Call
 * it before the first window loads.
 */
export function registerInvitationActionsIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: InvitationActionsOptions,
): void {
  const actions = createInvitationActions(options);
  ipc.handle(
    INVOKE_CHANNELS.createInvitation,
    createInvokeHandler(
      INVOKE_CHANNELS.createInvitation,
      appUrl,
      (_event, [workspaceId, memberId, lifetimeSeconds]) =>
        actions.create(workspaceId, memberId, lifetimeSeconds),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.revokeInvitation,
    createInvokeHandler(
      INVOKE_CHANNELS.revokeInvitation,
      appUrl,
      (_event, [workspaceId, invitationId]) =>
        actions.revoke(workspaceId, invitationId),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.previewInvitation,
    createInvokeHandler(
      INVOKE_CHANNELS.previewInvitation,
      appUrl,
      (_event, [code]) => actions.preview(code),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.acceptInvitation,
    createInvokeHandler(
      INVOKE_CHANNELS.acceptInvitation,
      appUrl,
      (_event, [code]) => actions.accept(code),
    ),
  );
}
