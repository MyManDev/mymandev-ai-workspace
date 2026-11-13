import {
  type CreateProjectResponse,
  type CreateWorkspaceResponse,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type {
  CreateProjectRefusal,
  CreateProjectResult,
  CreateWorkspaceRefusal,
  CreateWorkspaceResult,
} from "../shared/ipc-contract.ts";
import type { AccountService } from "./account.ts";
import type {
  WorkspaceActionFailure,
  WorkspaceActionResult,
} from "./api-actions.ts";
import type { ChatService, ChatSwitchOptions } from "./chat/service.ts";
import { createInvokeHandler, type IpcRegistry } from "./ipc.ts";
import type { WorkspaceService } from "./workspace/service.ts";

/**
 * Each failure of a write and what the screen gets when it creates a
 * workspace. `satisfies` checks the fresh literal, so the record fails to
 * compile when the allowlist gains or loses a failure. The API answers
 * `POST /workspaces` with the common codes only (`MEMBERSHIP_ROUTE_ERRORS`),
 * so every other code of the API would be a refusal that the desktop does
 * not expect, `failed`.
 */
const WORKSPACE_OUTCOMES = {
  invalid: "invalid",
  too_soon: "too_soon",
  not_signed_in: "not_signed_in",
  unavailable: "unavailable",
  forbidden: "failed",
  not_found: "failed",
  conflict: "failed",
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
} satisfies Record<WorkspaceActionFailure, CreateWorkspaceRefusal | "unknown">;
Object.freeze(WORKSPACE_OUTCOMES);

/**
 * Each failure of a write and what the screen gets when it creates a
 * project. The API answers `POST /workspaces/:workspaceId/projects` with
 * `not_found`, `conflict`, and `project_limit` beyond the common codes
 * (`PROJECT_ROUTE_ERRORS`), and they pass through as they are:
 * `project_limit`, without a wait, for a workspace that holds 100 projects
 * that are not archived, and `rate_limited`, with its wait, for an account
 * that created 20 projects in 24 hours (#255).
 */
const PROJECT_OUTCOMES = {
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
  project_limit: "project_limit",
  rate_limited: "rate_limited",
  unknown: "unknown",
  failed: "failed",
} satisfies Record<WorkspaceActionFailure, CreateProjectRefusal | "unknown">;
Object.freeze(PROJECT_OUTCOMES);

const UNKNOWN = Object.freeze({ outcome: "unknown" } as const);

/** A switch to the new workspace never drops chat messages that wait. */
const KEEP_WAITING: ChatSwitchOptions = Object.freeze({
  discardWaiting: false,
});

type Refused<R extends string> = {
  readonly outcome: "refused";
  readonly reason: R;
  readonly retryAfterMs: number | null;
};

function refused<R extends string>(
  reason: R,
  retryAfterMs: number | null = null,
): Refused<R> {
  return Object.freeze({ outcome: "refused", reason, retryAfterMs });
}

/** The result of a failed write, with its wait for `too_soon` and `rate_limited`. */
function failedResult<R extends string>(
  outcomes: Readonly<Record<WorkspaceActionFailure, R | "unknown">>,
  result: Extract<WorkspaceActionResult<unknown>, { ok: false }>,
): Refused<R> | typeof UNKNOWN {
  const outcome = outcomes[result.reason];
  if (outcome === "unknown") {
    return UNKNOWN;
  }
  return "retryAfterMs" in result
    ? refused(outcome, result.retryAfterMs)
    : refused(outcome);
}

/** The renderer's two create actions, in the main process. Each never rejects. */
export interface CreationActions {
  readonly createWorkspace: (name: string) => Promise<CreateWorkspaceResult>;
  readonly createProject: (
    workspaceId: string,
    name: string,
  ) => Promise<CreateProjectResult>;
}

export interface CreationActionsOptions {
  readonly account: Pick<AccountService, "status" | "sendWorkspaceAction">;
  readonly workspaces: Pick<
    WorkspaceService,
    "selectedWorkspaceId" | "addWorkspace"
  >;
  /**
   * The chat service's switch wrapper (chat/service.ts): it selects the new
   * workspace unless chat messages wait to be sent.
   */
  readonly switcher: Pick<ChatService, "selectWorkspace">;
  /**
   * Receives a fixed message when a write throws, which the account
   * service never does. Defaults to `console.error`.
   */
  readonly onError?: (message: string) => void;
}

/**
 * Creating a workspace and a project (#95, decisions D1 and D7), each one
 * write of the allowlist (`api-actions.ts`) through the account service's
 * `sendWorkspaceAction`, which checks the name with the protocol's request
 * schema. A write is sent once and never again on its own: an uncertain
 * answer is `unknown`. The account service's refusals come through as they
 * are, `too_soon` and `rate_limited` with their wait.
 *
 * - A workspace takes the account's display name from the account status
 *   as the creator's person, which becomes its owner (ADR 0014); without a
 *   signed-in account nothing is sent. No account frame or workspace event
 *   reports a new workspace, so a confirmed create adds it to the workspace
 *   service's list at once and loads the list again (`addWorkspace`). It
 *   then selects it through the chat service's switch, which subscribes to
 *   it and loads its people and projects, but only while the selection is
 *   the one that the create began with and no chat message waits to be
 *   sent: a workspace that the person selected meanwhile stays selected,
 *   and a waiting message is never dropped. Only the new workspace's ID and
 *   whether it was selected cross IPC; the account's person and its user ID
 *   stay here.
 * - A project goes only to the selected workspace, by the ID that the
 *   screen showed; another workspace is refused as `not_selected` before
 *   anything is sent. Nothing changes the projects here: the API sends
 *   `workspace.project.created` to every connection subscribed to the
 *   workspace, this one included, and the workspace service adds the
 *   project; a connection that missed it reloads the workspace at its next
 *   `workspace.subscribed`. Only the new project's ID crosses IPC.
 */
export function createCreationActions(
  options: CreationActionsOptions,
): CreationActions {
  const { account, workspaces, switcher } = options;
  const onError =
    options.onError ?? ((message: string) => console.error(message));

  return Object.freeze({
    createWorkspace: async (name: string): Promise<CreateWorkspaceResult> => {
      const status = account.status();
      if (status.account.kind !== "signed_in") {
        return refused("not_signed_in");
      }
      const displayName = status.account.displayName;
      const selectedBefore = workspaces.selectedWorkspaceId();
      let answer: WorkspaceActionResult<CreateWorkspaceResponse>;
      try {
        answer = await account.sendWorkspaceAction(
          "createWorkspace",
          {},
          { name, displayName },
        );
      } catch {
        // A fixed message: never the error, which might hold the name.
        onError("Creating a workspace could not be sent.");
        return UNKNOWN;
      }
      if (!answer.ok) {
        return failedResult(WORKSPACE_OUTCOMES, answer);
      }
      const { workspace, member } = answer.value;
      const added = workspaces.addWorkspace(
        { id: workspace.id, name: workspace.name },
        member.id,
      );
      const selected =
        added &&
        workspaces.selectedWorkspaceId() === selectedBefore &&
        switcher.selectWorkspace(workspace.id, KEEP_WAITING).kind ===
          "switched";
      return Object.freeze({
        outcome: "ok",
        workspaceId: workspace.id,
        selected,
      });
    },
    createProject: async (
      workspaceValue: string,
      name: string,
    ): Promise<CreateProjectResult> => {
      // The contract checked the ID already.
      const parsed = WorkspaceIdSchema.safeParse(workspaceValue);
      if (!parsed.success) {
        return refused("invalid");
      }
      const workspaceId = parsed.data;
      if (workspaceId !== workspaces.selectedWorkspaceId()) {
        return refused("not_selected");
      }
      let answer: WorkspaceActionResult<CreateProjectResponse>;
      try {
        answer = await account.sendWorkspaceAction(
          "createProject",
          { workspaceId },
          { name },
        );
      } catch {
        onError("Creating a project could not be sent.");
        return UNKNOWN;
      }
      if (!answer.ok) {
        return failedResult(PROJECT_OUTCOMES, answer);
      }
      // A project of another workspace means that the answer is not this
      // write's.
      const { project } = answer.value;
      return project.workspaceId === workspaceId
        ? Object.freeze({ outcome: "ok", projectId: project.id })
        : UNKNOWN;
    },
  });
}

/**
 * Registers the handlers of the two create channels (#95, D1 and D7). Every
 * handler checks the sender and the arguments first (`createInvokeHandler`):
 * a name of 1 to 100 characters, and for a project the workspace ID as a
 * lowercase UUIDv7, with no extra argument. The result is parsed by the
 * contract, so only fixed codes, a wait, the new workspace's or project's
 * ID, and whether the workspace was selected reach the renderer. Call it
 * before the first window loads.
 */
export function registerCreationIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: CreationActionsOptions,
): void {
  const actions = createCreationActions(options);
  ipc.handle(
    INVOKE_CHANNELS.createWorkspace,
    createInvokeHandler(
      INVOKE_CHANNELS.createWorkspace,
      appUrl,
      (_event, [name]) => actions.createWorkspace(name),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.createProject,
    createInvokeHandler(
      INVOKE_CHANNELS.createProject,
      appUrl,
      (_event, [workspaceId, name]) => actions.createProject(workspaceId, name),
    ),
  );
}
