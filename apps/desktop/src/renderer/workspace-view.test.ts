import { expect, test } from "vitest";
import type { WorkspaceBridge } from "../shared/desktop-bridge.ts";
import type {
  WorkspaceActionResult,
  WorkspaceView,
} from "../shared/ipc-contract.ts";
import {
  createShellState,
  shellReducer,
  type ShellAction,
  type ShellState,
} from "./screens.ts";
import {
  followWorkspaceState,
  initialWorkspacePanelView,
  reportOpenProject,
  SELECT_REFUSAL_MESSAGES,
  switchWorkspace,
  WORKSPACE_MESSAGES,
  type WorkspacePanelView,
} from "./workspace-view.ts";

const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const PROJECT_A = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1";
const PROJECT_B = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b2";

const READY: WorkspaceView = {
  revision: 3,
  status: "ready",
  workspaces: [{ id: WORKSPACE_ID, name: "Workspace" }],
  selectedWorkspaceId: WORKSPACE_ID,
  projects: [
    { id: PROJECT_A, name: "Project A" },
    { id: PROJECT_B, name: "Project B" },
  ],
  openProjectId: null,
};

/** A subscription that the test feeds, with the count of ended ones. */
function fakeSubscription() {
  const fake = {
    listener: undefined as ((state: WorkspaceView) => void) | undefined,
    onError: undefined as (() => void) | undefined,
    ended: 0,
    bridge: {
      subscribeState: (
        listener: (state: WorkspaceView) => void,
        onError?: () => void,
      ) => {
        fake.listener = listener;
        fake.onError = onError;
        return () => {
          fake.ended += 1;
        };
      },
    } satisfies Pick<WorkspaceBridge, "subscribeState">,
  };
  return fake;
}

/** A shell that runs every dispatched action through the reducer. */
function shell(initial: ShellState) {
  const fake = {
    state: initial,
    actions: [] as ShellAction[],
    dispatch: (action: ShellAction) => {
      fake.actions.push(action);
      fake.state = shellReducer(fake.state, action);
    },
  };
  return fake;
}

/** Waits until every pending promise callback has run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("before the first state, the view waits with the bridge and is unavailable without it", () => {
  expect(initialWorkspacePanelView(true)).toEqual({ kind: "pending" });
  expect(initialWorkspacePanelView(false)).toEqual({ kind: "unavailable" });
});

test("every state becomes the view and replaces the shell's projects, also when the view stays", () => {
  const subscription = fakeSubscription();
  const views: WorkspacePanelView[] = [];
  const app = shell(createShellState([]));
  followWorkspaceState(
    subscription.bridge,
    (view) => views.push(view),
    app.dispatch,
  );

  subscription.listener?.(READY);
  expect(app.state.projects).toBe(READY.projects);
  app.dispatch({ type: "open-project", projectId: PROJECT_B });
  const openView = app.state.view;

  // A rename changes only the projects; the open project stays shown.
  const renamed: WorkspaceView = {
    ...READY,
    revision: 4,
    projects: [
      { id: PROJECT_A, name: "Project A" },
      { id: PROJECT_B, name: "Project B, renamed" },
    ],
  };
  subscription.listener?.(renamed);
  expect(app.state.projects).toBe(renamed.projects);
  expect(app.state.view).toBe(openView);

  // A state that no longer lists the open project shows the home screen.
  const removed: WorkspaceView = {
    ...renamed,
    revision: 5,
    projects: [{ id: PROJECT_A, name: "Project A" }],
  };
  subscription.listener?.(removed);
  expect(app.state).toEqual({
    projects: removed.projects,
    view: { screen: "home" },
  });

  expect(views).toEqual([
    { kind: "known", state: READY },
    { kind: "known", state: renamed },
    { kind: "known", state: removed },
  ]);
  expect(
    app.actions.filter((action) => action.type === "replace-projects"),
  ).toEqual([
    { type: "replace-projects", projects: READY.projects },
    { type: "replace-projects", projects: renamed.projects },
    { type: "replace-projects", projects: removed.projects },
  ]);
});

test("a refused subscription makes the view unavailable, and the returned function ends the subscription", () => {
  const subscription = fakeSubscription();
  const views: WorkspacePanelView[] = [];
  const stop = followWorkspaceState(
    subscription.bridge,
    (view) => views.push(view),
    () => undefined,
  );

  subscription.onError?.();
  expect(views).toEqual([{ kind: "unavailable" }]);
  expect(subscription.ended).toBe(0);
  stop();
  expect(subscription.ended).toBe(1);
});

/** A bridge whose `openProject` answers with `answer` and records its calls. */
function fakeOpenProject(answer: () => Promise<WorkspaceActionResult>) {
  const calls: (string | null)[] = [];
  const bridge: Pick<WorkspaceBridge, "openProject"> = {
    openProject: (projectId) => {
      calls.push(projectId);
      return answer();
    },
  };
  return { calls, bridge };
}

test("the open project is reported, and no open project as null", async () => {
  const { calls, bridge } = fakeOpenProject(() =>
    Promise.resolve({ outcome: "ok" }),
  );
  const app = shell(createShellState(READY.projects));

  // At the start, the shell sends that no project is open.
  reportOpenProject(bridge, null, app.dispatch);
  app.dispatch({ type: "open-project", projectId: PROJECT_A });
  reportOpenProject(bridge, PROJECT_A, app.dispatch);
  await settle();

  expect(calls).toEqual([null, PROJECT_A]);
  expect(app.actions).toEqual([{ type: "open-project", projectId: PROJECT_A }]);
});

test("a project that the main process does not hold closes in the shell", async () => {
  const { bridge } = fakeOpenProject(() =>
    Promise.resolve({ outcome: "refused", reason: "not_found" }),
  );
  const app = shell(
    createShellState(READY.projects, {
      screen: "tasks",
      projectId: PROJECT_A,
      panel: "agents",
    }),
  );

  reportOpenProject(bridge, PROJECT_A, app.dispatch);
  await settle();

  expect(app.state.view).toEqual({ screen: "home" });
});

test("too_soon, a failed call, a refused null, and a replaced report keep the shown project", async () => {
  for (const answer of [
    () => Promise.resolve({ outcome: "refused", reason: "too_soon" } as const),
    () => Promise.reject(new Error("The main process did not answer.")),
  ]) {
    const { bridge } = fakeOpenProject(answer);
    const actions: ShellAction[] = [];
    reportOpenProject(bridge, PROJECT_A, (action) => actions.push(action));
    await settle();
    expect(actions).toEqual([]);
  }

  const { bridge } = fakeOpenProject(() =>
    Promise.resolve({ outcome: "refused", reason: "not_found" } as const),
  );
  const actions: ShellAction[] = [];
  reportOpenProject(bridge, null, (action) => actions.push(action));
  const drop = reportOpenProject(bridge, PROJECT_A, (action) =>
    actions.push(action),
  );
  drop();
  await settle();
  expect(actions).toEqual([]);
});

test("a switch resolves to no message, or to a calm fixed text when refused or failed", async () => {
  const calls: string[] = [];
  const answers: (() => Promise<WorkspaceActionResult>)[] = [
    () => Promise.resolve({ outcome: "ok" }),
    () => Promise.resolve({ outcome: "refused", reason: "too_soon" }),
    () => Promise.resolve({ outcome: "refused", reason: "not_found" }),
    () => Promise.reject(new Error("The main process did not answer.")),
  ];
  const messages: (string | undefined)[] = [];
  for (const answer of answers) {
    messages.push(
      await switchWorkspace(
        {
          select: (workspaceId) => {
            calls.push(workspaceId);
            return answer();
          },
        },
        WORKSPACE_ID,
      ),
    );
  }

  expect(calls).toEqual([
    WORKSPACE_ID,
    WORKSPACE_ID,
    WORKSPACE_ID,
    WORKSPACE_ID,
  ]);
  expect(messages).toEqual([
    undefined,
    "Wait a moment before switching again.",
    SELECT_REFUSAL_MESSAGES.not_found,
    WORKSPACE_MESSAGES.switchFailed,
  ]);
});
