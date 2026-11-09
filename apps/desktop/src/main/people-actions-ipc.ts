import {
  type DefineMemberResponse,
  type MemberId,
  MemberIdSchema,
  type WorkspaceId,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type {
  DefinePersonResult,
  PersonActionRefusal,
  PersonActionResult,
} from "../shared/ipc-contract.ts";
import type { AccountService } from "./account.ts";
import type {
  WorkspaceActionFailure,
  WorkspaceActionName,
  WorkspaceActionResult,
} from "./api-actions.ts";
import { createInvokeHandler, type IpcRegistry } from "./ipc.ts";
import type { WorkspaceService } from "./workspace/service.ts";

/**
 * Each failure of a write and what the people screen gets. `satisfies`
 * checks the fresh literal, so the record fails to compile when the
 * allowlist gains or loses a failure. The API answers the person routes
 * (`MEMBERSHIP_ROUTE_ERRORS`) with `forbidden`, `not_found`, `conflict`,
 * and `device_too_new` beyond the common codes; the codes of invitations,
 * join requests, and unknown workspaces would be refusals that the desktop
 * does not expect, `failed`.
 */
const OUTCOMES = {
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
  device_too_new: "device_too_new",
  rate_limited: "rate_limited",
  unknown: "unknown",
  failed: "failed",
} satisfies Record<WorkspaceActionFailure, PersonActionRefusal | "unknown">;
Object.freeze(OUTCOMES);

const UNKNOWN = Object.freeze({ outcome: "unknown" } as const);
const OK = Object.freeze({ outcome: "ok" } as const);

function refused(
  reason: PersonActionRefusal,
  retryAfterMs: number | null = null,
): PersonActionResult & { readonly outcome: "refused" } {
  return Object.freeze({ outcome: "refused", reason, retryAfterMs });
}

/** The result of a failed write, with its wait for `too_soon` and `rate_limited`. */
function failedResult(
  result: Extract<WorkspaceActionResult<unknown>, { ok: false }>,
): Exclude<PersonActionResult, { readonly outcome: "ok" }> {
  const outcome = OUTCOMES[result.reason];
  if (outcome === "unknown") {
    return UNKNOWN;
  }
  return "retryAfterMs" in result
    ? refused(outcome, result.retryAfterMs)
    : refused(outcome);
}

/**
 * The actions after which the shown ownership offer may be out of date,
 * because no workspace event reports an offer or its withdrawal.
 */
const OFFER_ACTIONS: ReadonlySet<WorkspaceActionName> = new Set([
  "offerOwnership",
  "withdrawOwnershipOffer",
  "acceptOwnershipOffer",
]);

/**
 * Whether the selected workspace is read again after an offer action with
 * `result`: after an offer or a withdrawal that the API confirmed, which no
 * event reports to the owner (an accepted offer comes as the transfer
 * event), and after any of the three when the answer says that the shown
 * offer is out of date (`not_found`, `conflict`) or does not say what
 * happened (`unknown`).
 */
function reloadsAfter(
  name: WorkspaceActionName,
  result: PersonActionResult | DefinePersonResult,
): boolean {
  if (!OFFER_ACTIONS.has(name)) {
    return false;
  }
  switch (result.outcome) {
    case "ok":
      return name !== "acceptOwnershipOffer";
    case "unknown":
      return true;
    case "refused":
      return result.reason === "not_found" || result.reason === "conflict";
  }
}

/** The renderer's people actions, in the main process. Each never rejects. */
export interface PeopleActions {
  readonly define: (
    workspaceId: string,
    displayName: string,
  ) => Promise<DefinePersonResult>;
  readonly rename: (
    workspaceId: string,
    memberId: string,
    displayName: string,
  ) => Promise<PersonActionResult>;
  readonly remove: (
    workspaceId: string,
    memberId: string,
  ) => Promise<PersonActionResult>;
  readonly promote: (
    workspaceId: string,
    memberId: string,
  ) => Promise<PersonActionResult>;
  readonly demote: (
    workspaceId: string,
    memberId: string,
  ) => Promise<PersonActionResult>;
  readonly leave: (workspaceId: string) => Promise<PersonActionResult>;
  readonly offerOwnership: (
    workspaceId: string,
    memberId: string,
  ) => Promise<PersonActionResult>;
  readonly withdrawOwnershipOffer: (
    workspaceId: string,
  ) => Promise<PersonActionResult>;
  readonly acceptOwnershipOffer: (
    workspaceId: string,
  ) => Promise<PersonActionResult>;
}

export interface PeopleActionsOptions {
  readonly account: Pick<AccountService, "sendWorkspaceAction">;
  readonly workspaces: Pick<WorkspaceService, "selectedWorkspaceId" | "reload">;
  /**
   * Receives a fixed message when a write throws, which the account
   * service never does. Defaults to `console.error`.
   */
  readonly onError?: (message: string) => void;
}

/**
 * The nine people actions of #95 (decision D1), each one write of the
 * allowlist (`api-actions.ts`) through the account service's
 * `sendWorkspaceAction`. Each checks its IDs with the protocol's ID schemas,
 * after the contract's own check, and refuses a workspace that is not the
 * selected one as `not_selected`, before anything is sent; the account
 * service checks the name with the protocol's request schema. A write is
 * sent once and never again on its own: an uncertain answer is `unknown`.
 * The account service's refusals come through as they are, `too_soon` and
 * `rate_limited` with their wait.
 *
 * Nothing changes the people here. The API sends the membership event of
 * each confirmed action to every connection subscribed to the workspace,
 * this one included, and the workspace service applies it, so an answer and
 * its event never both change the people. A confirmed definition answers
 * the new person's member ID only, never its user ID. Only the ownership
 * offer has no workspace event for the owner: the selected workspace is
 * read again after the offer actions (`reloadsAfter`).
 */
export function createPeopleActions(
  options: PeopleActionsOptions,
): PeopleActions {
  const { account, workspaces } = options;
  const onError =
    options.onError ?? ((message: string) => console.error(message));

  /**
   * The workspace ID and the member ID as the protocol's IDs, or null; the
   * contract checked them already.
   */
  function ids(
    workspaceValue: string,
    memberValue?: string,
  ): {
    readonly workspaceId: WorkspaceId;
    readonly memberId: MemberId | null;
  } | null {
    const workspaceId = WorkspaceIdSchema.safeParse(workspaceValue);
    if (!workspaceId.success) {
      return null;
    }
    if (memberValue === undefined) {
      return { workspaceId: workspaceId.data, memberId: null };
    }
    const memberId = MemberIdSchema.safeParse(memberValue);
    return memberId.success
      ? { workspaceId: workspaceId.data, memberId: memberId.data }
      : null;
  }

  /**
   * Sends one write for the selected workspace and maps its result with
   * `ok`, which turns a confirmed answer into the result for the screen.
   */
  async function act<R extends PersonActionResult | DefinePersonResult>(
    name: WorkspaceActionName,
    workspaceId: WorkspaceId,
    send: () => Promise<WorkspaceActionResult<unknown>>,
    ok: (value: unknown) => R,
  ): Promise<R | Exclude<PersonActionResult, { readonly outcome: "ok" }>> {
    if (workspaceId !== workspaces.selectedWorkspaceId()) {
      return refused("not_selected");
    }
    let result: R | Exclude<PersonActionResult, { readonly outcome: "ok" }>;
    try {
      const answer = await send();
      result = answer.ok ? ok(answer.value) : failedResult(answer);
    } catch {
      // A fixed message: never the error, which might hold the name.
      onError("A people action could not be sent.");
      result = UNKNOWN;
    }
    if (reloadsAfter(name, result)) {
      workspaces.reload(workspaceId);
    }
    return result;
  }

  /** A write of one person without a body. */
  function personAction(
    name: "removeMember" | "promoteMember" | "demoteMember",
  ): (workspaceId: string, memberId: string) => Promise<PersonActionResult> {
    return async (workspaceValue, memberValue) => {
      const checked = ids(workspaceValue, memberValue);
      if (checked === null || checked.memberId === null) {
        return refused("invalid");
      }
      const { workspaceId, memberId } = checked;
      return act(
        name,
        workspaceId,
        () => account.sendWorkspaceAction(name, { workspaceId, memberId }),
        () => OK,
      );
    };
  }

  /** A write of the workspace without a body. */
  function workspaceAction(
    name: "leaveWorkspace" | "withdrawOwnershipOffer" | "acceptOwnershipOffer",
  ): (workspaceId: string) => Promise<PersonActionResult> {
    return async (workspaceValue) => {
      const checked = ids(workspaceValue);
      if (checked === null) {
        return refused("invalid");
      }
      const { workspaceId } = checked;
      return act(
        name,
        workspaceId,
        () => account.sendWorkspaceAction(name, { workspaceId }),
        () => OK,
      );
    };
  }

  return Object.freeze({
    define: async (workspaceValue: string, displayName: string) => {
      const checked = ids(workspaceValue);
      if (checked === null) {
        return refused("invalid");
      }
      const { workspaceId } = checked;
      return act(
        "defineMember",
        workspaceId,
        () =>
          account.sendWorkspaceAction(
            "defineMember",
            { workspaceId },
            { displayName },
          ),
        (value): DefinePersonResult => {
          // Only the member ID crosses; a person of another workspace means
          // that the answer is not this write's.
          const { member } = value as DefineMemberResponse;
          return member.workspaceId === workspaceId
            ? Object.freeze({ outcome: "ok", memberId: member.id })
            : UNKNOWN;
        },
      );
    },
    rename: async (
      workspaceValue: string,
      memberValue: string,
      displayName: string,
    ) => {
      const checked = ids(workspaceValue, memberValue);
      if (checked === null || checked.memberId === null) {
        return refused("invalid");
      }
      const { workspaceId, memberId } = checked;
      return act(
        "renameMember",
        workspaceId,
        () =>
          account.sendWorkspaceAction(
            "renameMember",
            { workspaceId, memberId },
            { displayName },
          ),
        () => OK,
      );
    },
    remove: personAction("removeMember"),
    promote: personAction("promoteMember"),
    demote: personAction("demoteMember"),
    leave: workspaceAction("leaveWorkspace"),
    offerOwnership: async (workspaceValue: string, memberValue: string) => {
      const checked = ids(workspaceValue, memberValue);
      if (checked === null || checked.memberId === null) {
        return refused("invalid");
      }
      const { workspaceId, memberId } = checked;
      return act(
        "offerOwnership",
        workspaceId,
        () =>
          account.sendWorkspaceAction(
            "offerOwnership",
            { workspaceId },
            { memberId },
          ),
        () => OK,
      );
    },
    withdrawOwnershipOffer: workspaceAction("withdrawOwnershipOffer"),
    acceptOwnershipOffer: workspaceAction("acceptOwnershipOffer"),
  });
}

/**
 * Registers the handlers of the nine people action channels (#95, D1). Every
 * handler checks the sender and the arguments first (`createInvokeHandler`):
 * IDs as lowercase UUIDv7s and display names of 1 to 64 characters, with
 * no extra argument. The result is parsed by the contract, so only fixed
 * codes, a wait, and a new person's member ID reach the renderer. Call it
 * before the first window loads.
 */
export function registerPeopleActionsIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: PeopleActionsOptions,
): void {
  const actions = createPeopleActions(options);
  ipc.handle(
    INVOKE_CHANNELS.definePerson,
    createInvokeHandler(
      INVOKE_CHANNELS.definePerson,
      appUrl,
      (_event, [workspaceId, displayName]) =>
        actions.define(workspaceId, displayName),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.renamePerson,
    createInvokeHandler(
      INVOKE_CHANNELS.renamePerson,
      appUrl,
      (_event, [workspaceId, memberId, displayName]) =>
        actions.rename(workspaceId, memberId, displayName),
    ),
  );
  const ofPerson = [
    [INVOKE_CHANNELS.removePerson, actions.remove],
    [INVOKE_CHANNELS.promotePerson, actions.promote],
    [INVOKE_CHANNELS.demotePerson, actions.demote],
    [INVOKE_CHANNELS.offerOwnership, actions.offerOwnership],
  ] as const;
  for (const [channel, action] of ofPerson) {
    ipc.handle(
      channel,
      createInvokeHandler(channel, appUrl, (_event, [workspaceId, memberId]) =>
        action(workspaceId, memberId),
      ),
    );
  }
  const ofWorkspace = [
    [INVOKE_CHANNELS.leaveWorkspace, actions.leave],
    [INVOKE_CHANNELS.withdrawOwnershipOffer, actions.withdrawOwnershipOffer],
    [INVOKE_CHANNELS.acceptOwnershipOffer, actions.acceptOwnershipOffer],
  ] as const;
  for (const [channel, action] of ofWorkspace) {
    ipc.handle(
      channel,
      createInvokeHandler(channel, appUrl, (_event, [workspaceId]) =>
        action(workspaceId),
      ),
    );
  }
}
