import type { WorkspaceBridge } from "../shared/desktop-bridge.ts";
import type {
  WorkspaceActionRefusal,
  WorkspaceProblem,
  WorkspaceView,
} from "../shared/ipc-contract.ts";
import type { ShellAction } from "./screens.ts";

/** What the sidebar knows about the account's workspaces. */
export type WorkspacePanelView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first state. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly state: WorkspaceView };

export function initialWorkspacePanelView(
  bridgeAvailable: boolean,
): WorkspacePanelView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/** The fixed texts of the sidebar for each workspace state. */
export const WORKSPACE_MESSAGES = Object.freeze({
  unavailable: "Workspaces are not available.",
  pending: "Checking the workspaces.",
  signedOut:
    "Not signed in. Sign in on the home screen to see your workspaces.",
  loadingWorkspaces: "Loading the workspaces.",
  noWorkspaces: "No workspaces yet.",
  loadingProjects: "Loading the projects.",
  noProjects: "No projects yet.",
  switchFailed: "The workspace could not be switched.",
});

/**
 * Why the workspaces are `unavailable`. What was loaded before stays shown,
 * and the main process loads again by itself.
 */
export const WORKSPACE_PROBLEM_MESSAGES: Readonly<
  Record<WorkspaceProblem, string>
> = Object.freeze({
  not_signed_in: "The server did not accept this device's sign-in.",
  not_found: "The server did not find the selected workspace.",
  rate_limited: "The server asked to wait. Trying again in a minute.",
  unavailable: "The server could not be reached. Trying again later.",
  failed: "The workspaces could not be loaded. Trying again later.",
});

/** Why a switch to another workspace was refused. */
export const SELECT_REFUSAL_MESSAGES: Readonly<
  Record<WorkspaceActionRefusal, string>
> = Object.freeze({
  not_found: "This workspace is no longer in the list.",
  too_soon: "Wait a moment before switching again.",
});

/**
 * Follows the workspace state for the shell: each state becomes the view,
 * and its projects replace the shell's projects, also when the shown view
 * stays the same. A refused subscription makes the view unavailable. The
 * returned function ends the subscription.
 */
export function followWorkspaceState(
  workspaces: Pick<WorkspaceBridge, "subscribeState">,
  onView: (view: WorkspacePanelView) => void,
  dispatch: (action: ShellAction) => void,
): () => void {
  return workspaces.subscribeState(
    (state) => {
      onView({ kind: "known", state });
      dispatch({ type: "replace-projects", projects: state.projects });
    },
    () => onView({ kind: "unavailable" }),
  );
}

/**
 * Tells the main process which project is open, or null for none. The main
 * process closes its open project when the page reloads, so the shell sends
 * its own at the start as well. A project that the main process does not
 * hold (`not_found`) is closed in the shell too; `too_soon` keeps it, and a
 * failed call changes nothing. The returned function drops the answer, for
 * a report that a newer one replaced.
 */
export function reportOpenProject(
  workspaces: Pick<WorkspaceBridge, "openProject">,
  projectId: string | null,
  dispatch: (action: ShellAction) => void,
): () => void {
  let current = true;
  workspaces.openProject(projectId).then(
    (result) => {
      if (
        current &&
        projectId !== null &&
        result.outcome === "refused" &&
        result.reason === "not_found"
      ) {
        dispatch({ type: "show-screen", screen: "home" });
      }
    },
    () => undefined,
  );
  return () => {
    current = false;
  };
}

/**
 * Switches to another workspace and resolves to the message to show, or
 * undefined. Every switch of the shell goes through here, so the question
 * before a switch while chat messages wait to be sent (#27) belongs here.
 * The main process closes the open project, and its next state brings the
 * new workspace's projects.
 */
export async function switchWorkspace(
  workspaces: Pick<WorkspaceBridge, "select">,
  workspaceId: string,
): Promise<string | undefined> {
  try {
    const result = await workspaces.select(workspaceId);
    return result.outcome === "refused"
      ? SELECT_REFUSAL_MESSAGES[result.reason]
      : undefined;
  } catch {
    return WORKSPACE_MESSAGES.switchFailed;
  }
}
