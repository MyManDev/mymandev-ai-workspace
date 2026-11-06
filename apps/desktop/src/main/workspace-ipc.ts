import { ProjectIdSchema, WorkspaceIdSchema } from "@mymandev/protocol";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  MAX_WAITING_CHAT_MESSAGES,
  WORKSPACE_LIMITS,
  type WorkspaceActionResult,
  type WorkspaceSwitchOptions,
  type WorkspaceView,
} from "../shared/ipc-contract.ts";
import type {
  ChatService,
  ChatSwitchOptions,
  ChatSwitchResult,
} from "./chat/service.ts";
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
const KEEP_WAITING: ChatSwitchOptions = Object.freeze({
  discardWaiting: false,
});
const DISCARD_WAITING: ChatSwitchOptions = Object.freeze({
  discardWaiting: true,
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
  readonly selectWorkspace: (
    workspaceId: string,
    options?: WorkspaceSwitchOptions,
  ) => WorkspaceActionResult;
  readonly openProject: (
    projectId: string | null,
    options?: WorkspaceSwitchOptions,
  ) => WorkspaceActionResult;
}

/**
 * The chat service's switch wrappers (chat/service.ts). While chat messages
 * wait to be sent, they answer `waiting` with the count and change nothing,
 * unless `discardWaiting` drops the messages first; otherwise they call the
 * workspace service's `select` or `openProject`.
 */
export type WorkspaceSwitcher = Pick<
  ChatService,
  "selectWorkspace" | "switchProject"
>;

function switchResult(result: ChatSwitchResult): WorkspaceActionResult {
  switch (result.kind) {
    case "switched":
      return OK;
    case "waiting":
      return Object.freeze({
        outcome: "waiting",
        count: Math.min(result.count, MAX_WAITING_CHAT_MESSAGES),
      });
    case "refused":
      return NOT_FOUND;
  }
}

/**
 * The renderer's two actions, in one place. Each checks its ID with the
 * protocol's ID schema, after the contract's own check, and refuses
 * anything else before anything is asked. A switch to another workspace
 * also counts against `WORKSPACE_SWITCH_BUDGET`, before the question, so a
 * switch beyond the budget never drops a waiting message. Every switch then
 * goes through the chat service's wrappers (`switcher`), which answer
 * `waiting` while chat messages wait to be sent, unless the option
 * `discardWaiting` says that the person chose to discard them (the Project
 * Manager's decision of 2026-11-05 on #27). Only a switch that happened
 * counts against the budget. `now` is a monotonic clock in milliseconds.
 */
export function createWorkspaceActions(
  service: Pick<WorkspaceService, "state" | "selectedWorkspaceId">,
  switcher: WorkspaceSwitcher,
  now: () => number = () => performance.now(),
): WorkspaceActions {
  /** When the switches within the budget's window were accepted, oldest first. */
  const switches: number[] = [];

  return Object.freeze({
    selectWorkspace: (value: string, options?: WorkspaceSwitchOptions) => {
      const workspaceId = WorkspaceIdSchema.safeParse(value);
      if (!workspaceId.success) {
        return NOT_FOUND;
      }
      const switchOptions =
        options?.discardWaiting === true ? DISCARD_WAITING : KEEP_WAITING;
      if (workspaceId.data === service.selectedWorkspaceId()) {
        return switchResult(
          switcher.selectWorkspace(workspaceId.data, switchOptions),
        );
      }
      // A workspace that the list does not hold is refused as not found
      // before the budget, which counts switches only.
      const listed = service
        .state()
        .workspaces.some((workspace) => workspace.id === workspaceId.data);
      if (!listed) {
        return NOT_FOUND;
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
      const result = switcher.selectWorkspace(workspaceId.data, switchOptions);
      if (result.kind === "switched") {
        switches.push(at);
      }
      return switchResult(result);
    },
    openProject: (value: string | null, options?: WorkspaceSwitchOptions) => {
      const switchOptions =
        options?.discardWaiting === true ? DISCARD_WAITING : KEEP_WAITING;
      if (value === null) {
        return switchResult(switcher.switchProject(null, switchOptions));
      }
      const projectId = ProjectIdSchema.safeParse(value);
      return projectId.success
        ? switchResult(switcher.switchProject(projectId.data, switchOptions))
        : NOT_FOUND;
    },
  });
}

/**
 * Registers the handlers of the workspace channels and sends each change of
 * the workspace state to the frames that subscribed. Every handler checks
 * the sender and the arguments first (`createInvokeHandler`): `select` takes
 * one workspace ID and `openProject` one project ID or null, each a
 * lowercase UUIDv7, and each may take the switch option `{ discardWaiting
 * }` as well. The actions check the ID with the protocol, a switch counts
 * against the budget, and every switch goes through the chat service's
 * wrappers (`switcher`), which answer `waiting` while chat messages wait to
 * be sent. Only IDs, names, counts, and fixed codes reach the renderer.
 * Call it before the first window loads. `now` is the budget's monotonic
 * clock.
 */
export function registerWorkspaceIpc(
  ipc: IpcRegistry,
  appUrl: string,
  service: Pick<WorkspaceService, "state" | "onChange" | "selectedWorkspaceId">,
  switcher: WorkspaceSwitcher,
  onError: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
  now?: () => number,
): void {
  const publisher = createEventPublisher(
    EVENT_CHANNELS.workspaceStateChanged,
    appUrl,
  );
  const actions = createWorkspaceActions(service, switcher, now);

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
      (_event, args) =>
        actions.selectWorkspace(
          args[0],
          args.length === 2 ? args[1] : undefined,
        ),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.openProject,
    createInvokeHandler(INVOKE_CHANNELS.openProject, appUrl, (_event, args) =>
      actions.openProject(args[0], args.length === 2 ? args[1] : undefined),
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
 * (`did-fail-load`; a load aborted after the commit, such as by
 * `window.stop()`, leaves the page, and a blocked navigation never reaches
 * this event), the render process is gone, or the window closes. A
 * project then never stays open in the main process without a screen that
 * shows it. The start of a load alone changes nothing, because a dropped
 * file or a blocked link starts one that is then cancelled. The workspace
 * selection stays. It calls the service directly, without the renderer's
 * actions, because no screen is left to ask the person, so chat messages
 * that wait to be sent are dropped. Before the window closes, the person
 * was asked about them (`askBeforeClosingWithWaitingMessages`).
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

/**
 * The native confirmation before the window closes while chat messages wait
 * to be sent (the Project Manager's decision of 2026-11-06 on #27): "Close"
 * is the default, and "Keep", also for Escape, keeps the window open.
 * `closeWithWaitingConfirmed` reads its answer.
 */
export const CLOSE_WITH_WAITING_CONFIRMATION = Object.freeze({
  type: "warning",
  buttons: Object.freeze(["Close", "Keep"] as const),
  defaultId: 0,
  cancelId: 1,
  noLink: true,
  title: "Messages not sent",
  detail:
    "Messages that wait to be sent are kept in memory only, so closing the window discards them. Keep the window open to send them later.",
} as const);

/** The message of the confirmation, with the count of waiting messages. */
export function closeWithWaitingMessage(count: number): string {
  return count === 1
    ? "1 message has not been sent yet. Close the window and discard it?"
    : `${count} messages have not been sent yet. Close the window and discard them?`;
}

/** Whether the person chose "Close" in `CLOSE_WITH_WAITING_CONFIRMATION`. */
export function closeWithWaitingConfirmed(result: {
  readonly response: number;
}): boolean {
  return result.response === 0;
}

/** The part of Electron's `BrowserWindow` that `askBeforeClosingWithWaitingMessages` uses. */
export interface ClosingWindow {
  on(
    event: "close",
    listener: (event: { preventDefault(): void }) => void,
  ): unknown;
  close(): void;
  isDestroyed(): boolean;
}

/**
 * Asks the person before the window closes while chat messages wait to be
 * sent. Without waiting messages, the window closes at once. With them, the
 * close is held and `confirm` asks, once at a time, with their count; a
 * further close meanwhile is held without a second question. When the
 * person chooses to close, the window closes without asking again, and the
 * open project closes with it (`closeProjectWithPage`), which drops the
 * messages; when the person keeps them, the window stays open and the next
 * close asks again. A failed question is reported and the window closes, so
 * that it can always be closed.
 *
 * Only closing the window can be asked about: when the page reloads, fails
 * to load, or its render process ends, no page is left to ask through, and
 * the waiting messages are dropped without a question.
 */
export function askBeforeClosingWithWaitingMessages(
  window: ClosingWindow,
  waitingCount: () => number,
  confirm: (count: number) => Promise<boolean>,
  onError: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): void {
  let asking = false;
  let confirmed = false;
  const close = () => {
    confirmed = true;
    if (!window.isDestroyed()) {
      window.close();
    }
  };
  window.on("close", (event) => {
    if (confirmed) {
      return;
    }
    if (asking) {
      event.preventDefault();
      return;
    }
    const count = waitingCount();
    if (count === 0) {
      return;
    }
    event.preventDefault();
    asking = true;
    confirm(count).then(
      (closing) => {
        asking = false;
        if (closing) {
          close();
        }
      },
      (error: unknown) => {
        asking = false;
        onError("Asking before closing the window failed.", error);
        close();
      },
    );
  });
}
