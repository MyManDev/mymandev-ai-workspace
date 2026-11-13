import type { WorkspaceBridge } from "../shared/desktop-bridge.ts";
import type { CopyWorkspaceIdResult } from "../shared/ipc-contract.ts";
import type { PeopleScreenView } from "./people-view.ts";

/** The fixed texts of the workspace ID on the people screen. */
export const WORKSPACE_ID_MESSAGES = Object.freeze({
  /** Before the ID. */
  label: "Workspace ID: ",
  /**
   * What the ID allows (ADR 0014, "What a workspace ID allows"): a request
   * only creates something that an approver must accept.
   */
  hint: "Someone who is not in this workspace can ask to join it with this ID. The owner or an admin decides.",
  copy: "Copy",
  copied: "The workspace ID was copied.",
  notCopied:
    "The workspace ID could not be copied. Select it and copy it instead.",
});

/**
 * The selected workspace's ID, which the people screen shows to every
 * active member of the workspace, whatever the role (#95; the Project
 * Manager's decision of 2026-11-13), or null: only while the people are
 * `ready` and the account's own active person is listed, as for the people
 * actions. It is not a secret (ADR 0014): someone who is not in the
 * workspace can only ask to join with it, and the owner or an admin
 * decides.
 */
export function describeWorkspaceId(view: PeopleScreenView): string | null {
  if (view.kind !== "known" || view.state.status !== "ready") {
    return null;
  }
  const { state } = view;
  const member = state.people.some(
    (person) => !person.former && person.memberId === state.ownMemberId,
  );
  return member ? state.workspaceId : null;
}

/** What the screen shows of the copy of the workspace ID. */
export interface WorkspaceIdCopyView {
  /** True while a copy is on its way; "Copy" then does nothing. */
  readonly running: boolean;
  /**
   * How the last copy ended, with the ID that it copied, so that its
   * sentence shows only while the screen shows that ID; undefined before
   * the first copy and while one runs.
   */
  readonly last:
    { readonly workspaceId: string; readonly copied: boolean } | undefined;
}

export const IDLE_WORKSPACE_ID_COPY: WorkspaceIdCopyView = Object.freeze({
  running: false,
  last: undefined,
});

const RUNNING: WorkspaceIdCopyView = Object.freeze({
  running: true,
  last: undefined,
});

/**
 * The sentence of the last copy for the ID that the screen shows, or ""
 * when there is nothing to say: also after a switch to a workspace whose ID
 * was not copied, so that the sentence never speaks of another ID.
 */
export function describeWorkspaceIdCopy(
  view: WorkspaceIdCopyView,
  workspaceId: string | null,
): string {
  const { last } = view;
  if (last === undefined || last.workspaceId !== workspaceId) {
    return "";
  }
  return last.copied
    ? WORKSPACE_ID_MESSAGES.copied
    : WORKSPACE_ID_MESSAGES.notCopied;
}

export interface WorkspaceIdCopy {
  /**
   * Asks the main process to copy `workspaceId`, unless a copy runs.
   * Resolves once the view shows how it ended.
   */
  readonly copy: (workspaceId: string) => Promise<void>;
}

/**
 * Copies the workspace ID through the bridge's `copyId`, the only way to the
 * clipboard: the renderer itself never uses it, because the session denies
 * its clipboard permissions. One copy runs at a time. Its start empties the
 * sentence, so that a screen reader announces the next one even when it is
 * the same; its end reports `copied` for `ok` only, and not copied for a
 * refusal, a failure, and a call that rejects. `onView` gets every view.
 */
export function createWorkspaceIdCopy(
  bridge: Pick<WorkspaceBridge, "copyId">,
  onView: (view: WorkspaceIdCopyView) => void,
): WorkspaceIdCopy {
  let running = false;
  return Object.freeze({
    copy: (workspaceId: string) => {
      if (running) {
        return Promise.resolve();
      }
      running = true;
      onView(RUNNING);
      // A bridge that throws at once counts as a call that rejects.
      return new Promise<CopyWorkspaceIdResult>((resolve) => {
        resolve(bridge.copyId(workspaceId));
      })
        .then(
          (result) => result.outcome === "ok",
          () => false,
        )
        .then((copied) => {
          running = false;
          onView(
            Object.freeze({
              running: false,
              last: Object.freeze({ workspaceId, copied }),
            }),
          );
        });
    },
  });
}
