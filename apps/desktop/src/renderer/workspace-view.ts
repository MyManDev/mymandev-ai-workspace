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
  signedOut: "Workspaces appear once this device is signed in and ready.",
  loadingWorkspaces: "Loading the workspaces.",
  noWorkspaces: "No workspaces yet.",
  noneSelected: "Select a workspace to see its projects.",
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
 * Switches to another workspace and resolves to the message to show, or
 * undefined. Every switch of the shell goes through here. The main process
 * closes the open project, and its next state brings the new workspace's
 * projects.
 *
 * This is where the person will be asked before a switch while chat
 * messages wait to be sent; it is not built yet. The main process's chat
 * service detects the waiting messages: the chat IPC of a later part makes
 * `select` and `openProject` answer `{ outcome: "waiting", count }`, and an
 * optional `{ discardWaiting: true }` argument repeats the switch.
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

/** The workspace part of the shell, apart from React: see `createWorkspaceSidebar`. */
export interface WorkspaceSidebarController {
  /**
   * Subscribes to the workspace state. Returns the function that ends the
   * subscription and drops the answers that are still open.
   */
  readonly start: () => () => void;
  /**
   * Tells the main process which project is open, or null for none, and
   * drops the answer of the previous report.
   */
  readonly openProjectChanged: (projectId: string | null) => void;
  /** Switches to another workspace through `switchWorkspace`. */
  readonly select: (workspaceId: string) => void;
}

/**
 * The workspace logic of the shell, which `App` drives from its effects.
 *
 * - Every state becomes the view and replaces the shell's projects, also
 *   when the shown view stays the same. A refused subscription makes the
 *   view unavailable.
 * - The main process closes its open project when the page reloads, so the
 *   shell reports its own, or null, at the start and after every change. A
 *   project that the main process does not hold (`not_found`) closes in the
 *   shell too; a failed call changes nothing.
 * - A switch clears the message first and then shows the text of its
 *   answer, if any. Only the answer of the latest switch counts. A newer
 *   workspace state clears the message.
 */
export function createWorkspaceSidebar(
  workspaces: Pick<
    WorkspaceBridge,
    "subscribeState" | "openProject" | "select"
  >,
  dispatch: (action: ShellAction) => void,
  onView: (view: WorkspacePanelView) => void,
  onMessage: (message: string | undefined) => void,
): WorkspaceSidebarController {
  /** The revision of the last state, or -1 before the first one. */
  let revision = -1;
  /** The revision at which the shown message was set, or undefined. */
  let messageRevision: number | undefined;
  /** Each report and switch gets a new token; an older answer is dropped. */
  let reportToken = 0;
  let selectToken = 0;

  const setMessage = (message: string | undefined) => {
    messageRevision = message === undefined ? undefined : revision;
    onMessage(message);
  };

  return Object.freeze({
    start: () => {
      const stop = workspaces.subscribeState(
        (state) => {
          revision = state.revision;
          onView({ kind: "known", state });
          dispatch({ type: "replace-projects", projects: state.projects });
          if (messageRevision !== undefined && revision > messageRevision) {
            setMessage(undefined);
          }
        },
        () => onView({ kind: "unavailable" }),
      );
      return () => {
        stop();
        reportToken += 1;
        selectToken += 1;
      };
    },
    openProjectChanged: (projectId: string | null) => {
      reportToken += 1;
      const token = reportToken;
      workspaces.openProject(projectId).then(
        (result) => {
          if (
            token === reportToken &&
            projectId !== null &&
            result.outcome === "refused" &&
            result.reason === "not_found"
          ) {
            dispatch({ type: "show-screen", screen: "home" });
          }
        },
        () => undefined,
      );
    },
    select: (workspaceId: string) => {
      selectToken += 1;
      const token = selectToken;
      setMessage(undefined);
      void switchWorkspace(workspaces, workspaceId).then((message) => {
        if (token === selectToken) {
          setMessage(message);
        }
      });
    },
  });
}
