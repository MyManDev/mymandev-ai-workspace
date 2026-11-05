import { ProjectIdSchema, WorkspaceIdSchema } from "@mymandev/protocol";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  WORKSPACE_LIMITS,
  type WorkspaceActionResult,
  type WorkspaceView,
} from "../shared/ipc-contract.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type { WorkspaceService, WorkspaceState } from "./workspace/service.ts";

const OK: WorkspaceActionResult = Object.freeze({ outcome: "ok" });
const REFUSED: WorkspaceActionResult = Object.freeze({ outcome: "refused" });

/** `name`, cut to `WORKSPACE_LIMITS.name` characters (code points). */
function shortName(name: string): string {
  const characters = Array.from(name);
  return characters.length > WORKSPACE_LIMITS.name
    ? characters.slice(0, WORKSPACE_LIMITS.name).join("")
    : name;
}

/**
 * The frozen copy of the service's state that crosses IPC: IDs and names
 * only, at most `WORKSPACE_LIMITS` workspaces and projects, and names cut to
 * the limit. A project's `createdByMemberId` stays in the main process,
 * because no screen needs a member ID.
 */
export function workspaceView(state: WorkspaceState): WorkspaceView {
  const fields = {
    revision: state.revision,
    workspaces: Object.freeze(
      state.workspaces
        .slice(0, WORKSPACE_LIMITS.workspaces)
        .map(({ id, name }) => Object.freeze({ id, name: shortName(name) })),
    ),
    selectedWorkspaceId: state.selectedWorkspaceId,
    projects: Object.freeze(
      state.projects
        .slice(0, WORKSPACE_LIMITS.projects)
        .map(({ id, name }) => Object.freeze({ id, name: shortName(name) })),
    ),
    openProjectId: state.openProjectId,
  };
  if (state.status === "unavailable") {
    return Object.freeze({
      status: "unavailable",
      problem: state.problem ?? "failed",
      ...fields,
    });
  }
  return Object.freeze({ status: state.status, ...fields });
}

/** The renderer's actions on the workspace service. */
export interface WorkspaceActions {
  readonly selectWorkspace: (workspaceId: string) => WorkspaceActionResult;
  readonly openProject: (projectId: string | null) => WorkspaceActionResult;
}

/**
 * The renderer's two actions, in one place. Each checks its ID with the
 * protocol's ID schema, after the contract's own check, and refuses
 * anything else before the service is asked. The chat service (a later
 * part) routes them through its own wrappers, which ask the person before a
 * switch while chat messages wait to be sent.
 */
export function createWorkspaceActions(
  service: Pick<WorkspaceService, "select" | "openProject">,
): WorkspaceActions {
  return Object.freeze({
    selectWorkspace: (value: string) => {
      const workspaceId = WorkspaceIdSchema.safeParse(value);
      return workspaceId.success && service.select(workspaceId.data)
        ? OK
        : REFUSED;
    },
    openProject: (value: string | null) => {
      if (value === null) {
        return service.openProject(null) ? OK : REFUSED;
      }
      const projectId = ProjectIdSchema.safeParse(value);
      return projectId.success && service.openProject(projectId.data)
        ? OK
        : REFUSED;
    },
  });
}

/**
 * Registers the handlers of the workspace channels and sends each change of
 * the workspace state to the frames that subscribed. Every handler checks
 * the sender and the arguments first (`createInvokeHandler`): `select` takes
 * exactly one workspace ID and `openProject` exactly one project ID or
 * null, each a lowercase UUIDv7, and the actions check the ID with the
 * protocol as well. Only IDs, names, and fixed codes reach the renderer.
 * Call it before the first window loads.
 */
export function registerWorkspaceIpc(
  ipc: IpcRegistry,
  appUrl: string,
  service: Pick<
    WorkspaceService,
    "state" | "onChange" | "select" | "openProject"
  >,
  onError: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): void {
  const publisher = createEventPublisher(
    EVENT_CHANNELS.workspaceStateChanged,
    appUrl,
  );
  const actions = createWorkspaceActions(service);

  ipc.handle(
    INVOKE_CHANNELS.getWorkspaceState,
    createInvokeHandler(INVOKE_CHANNELS.getWorkspaceState, appUrl, () =>
      workspaceView(service.state()),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeWorkspaceState,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeWorkspaceState,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return workspaceView(service.state());
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.selectWorkspace,
    createInvokeHandler(
      INVOKE_CHANNELS.selectWorkspace,
      appUrl,
      (_event, [workspaceId]) => actions.selectWorkspace(workspaceId),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.openProject,
    createInvokeHandler(
      INVOKE_CHANNELS.openProject,
      appUrl,
      (_event, [projectId]) => actions.openProject(projectId),
    ),
  );
  service.onChange((state) => {
    try {
      publisher.publish(workspaceView(state));
    } catch (error) {
      onError("Sending the workspace state failed.", error);
    }
  });
}

/** The part of Electron's `WebContents` that `closeProjectWithPage` uses. */
export interface WorkspacePageContents {
  on(event: "did-start-loading", listener: () => void): unknown;
  on(event: "render-process-gone", listener: () => void): unknown;
}

/** The part of Electron's `BrowserWindow` that `closeProjectWithPage` uses. */
export interface WorkspacePageWindow {
  readonly webContents: WorkspacePageContents;
  on(event: "closed", listener: () => void): unknown;
}

/**
 * Closes the open project when the page that may have opened it is gone:
 * the window closes, its renderer starts loading a page (a reload, also of
 * a subframe, which the application has none of), or its render process
 * crashes. A project then never stays open in the main process without a
 * screen that shows it. The workspace selection stays. It calls the service
 * directly, without the renderer's actions, because no screen is left to
 * ask the person.
 */
export function closeProjectWithPage(
  window: WorkspacePageWindow,
  service: Pick<WorkspaceService, "openProject">,
  onError: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): void {
  const close = () => {
    try {
      service.openProject(null);
    } catch (error) {
      onError("Closing the open project failed.", error);
    }
  };
  // Read before "closed": a destroyed window no longer has web contents.
  const contents = window.webContents;
  contents.on("did-start-loading", close);
  contents.on("render-process-gone", close);
  window.on("closed", close);
}
