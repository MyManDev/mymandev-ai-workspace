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
const NOT_FOUND: WorkspaceActionResult = Object.freeze({
  outcome: "refused",
  reason: "not_found",
});
const TOO_SOON: WorkspaceActionResult = Object.freeze({
  outcome: "refused",
  reason: "too_soon",
});

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

/**
 * At most this many switches to another workspace within
 * `WORKSPACE_SWITCH_WINDOW_MS`; more are refused (`too_soon`). Each switch
 * sends an unsubscribe and a subscribe frame, and each subscription makes
 * two reads of the API, so a renderer that selects in a loop makes at most
 * 40 reads a minute. A person who clicks through a few workspaces quickly
 * stays far below it. Selecting the selected workspace sends nothing and
 * is not counted. It works like the reconnect budget of the connection
 * client, without its cooldown, so that a few quick clicks all pass.
 */
export const WORKSPACE_SWITCH_BUDGET = 20;
export const WORKSPACE_SWITCH_WINDOW_MS = 60_000;

/** The renderer's actions on the workspace service. */
export interface WorkspaceActions {
  readonly selectWorkspace: (workspaceId: string) => WorkspaceActionResult;
  readonly openProject: (projectId: string | null) => WorkspaceActionResult;
}

/**
 * The renderer's two actions, in one place. Each checks its ID with the
 * protocol's ID schema, after the contract's own check, and refuses
 * anything else before the service is asked. A switch to another workspace
 * also counts against `WORKSPACE_SWITCH_BUDGET`. The chat service (a later
 * part) routes these actions through its own wrappers, which ask the person
 * before a switch while chat messages wait to be sent, and so keeps the
 * checks and the budget. `now` is a monotonic clock in milliseconds.
 */
export function createWorkspaceActions(
  service: Pick<
    WorkspaceService,
    "select" | "openProject" | "selectedWorkspaceId"
  >,
  now: () => number = () => performance.now(),
): WorkspaceActions {
  /** When the switches within the budget's window were accepted, oldest first. */
  const switches: number[] = [];

  return Object.freeze({
    selectWorkspace: (value: string) => {
      const workspaceId = WorkspaceIdSchema.safeParse(value);
      if (!workspaceId.success) {
        return NOT_FOUND;
      }
      if (workspaceId.data === service.selectedWorkspaceId()) {
        return service.select(workspaceId.data) ? OK : NOT_FOUND;
      }
      const at = now();
      while (
        switches.length > 0 &&
        at - (switches[0] ?? at) >= WORKSPACE_SWITCH_WINDOW_MS
      ) {
        switches.shift();
      }
      if (switches.length >= WORKSPACE_SWITCH_BUDGET) {
        return TOO_SOON;
      }
      if (!service.select(workspaceId.data)) {
        return NOT_FOUND;
      }
      switches.push(at);
      return OK;
    },
    openProject: (value: string | null) => {
      if (value === null) {
        return service.openProject(null) ? OK : NOT_FOUND;
      }
      const projectId = ProjectIdSchema.safeParse(value);
      return projectId.success && service.openProject(projectId.data)
        ? OK
        : NOT_FOUND;
    },
  });
}

/**
 * Registers the handlers of the workspace channels and sends each change of
 * the workspace state to the frames that subscribed. Every handler checks
 * the sender and the arguments first (`createInvokeHandler`): `select` takes
 * exactly one workspace ID and `openProject` exactly one project ID or
 * null, each a lowercase UUIDv7, and the actions check the ID with the
 * protocol as well, and a switch counts against the budget. Only IDs,
 * names, and fixed codes reach the renderer. Call it before the first
 * window loads. `now` is the budget's monotonic clock.
 */
export function registerWorkspaceIpc(
  ipc: IpcRegistry,
  appUrl: string,
  service: Pick<
    WorkspaceService,
    "state" | "onChange" | "select" | "openProject" | "selectedWorkspaceId"
  >,
  onError: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
  now?: () => number,
): void {
  const publisher = createEventPublisher(
    EVENT_CHANNELS.workspaceStateChanged,
    appUrl,
  );
  const actions = createWorkspaceActions(service, now);

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

/**
 * Chromium's `ERR_ABORTED`: a navigation that was cancelled or blocked, for
 * example by the navigation guard, after which the page stays.
 */
export const NAVIGATION_ABORTED = -3;

/** The part of Electron's `WebContents` that `closeProjectWithPage` uses. */
export interface WorkspacePageContents {
  on(event: "did-navigate", listener: () => void): unknown;
  on(
    event: "did-fail-load",
    listener: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ) => void,
  ): unknown;
  on(event: "render-process-gone", listener: () => void): unknown;
}

/** The part of Electron's `BrowserWindow` that `closeProjectWithPage` uses. */
export interface WorkspacePageWindow {
  readonly webContents: WorkspacePageContents;
  on(event: "closed", listener: () => void): unknown;
}

/**
 * Closes the open project when the page that may have opened it is gone: a
 * new document commits in the main frame (`did-navigate`, also on a
 * reload), a load of the main frame fails other than by being aborted
 * (`did-fail-load`; an aborted or blocked navigation leaves the page, so
 * it changes nothing), the render process is gone, or the window closes. A
 * project then never stays open in the main process without a screen that
 * shows it. The start of a load alone changes nothing, because a dropped
 * file or a blocked link starts one that is then cancelled. The workspace
 * selection stays. It calls the service directly, without the renderer's
 * actions, because no screen is left to ask the person.
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
  contents.on("did-navigate", close);
  contents.on(
    "did-fail-load",
    (_event, errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      if (isMainFrame && errorCode !== NAVIGATION_ABORTED) {
        close();
      }
    },
  );
  contents.on("render-process-gone", close);
  window.on("closed", close);
}
