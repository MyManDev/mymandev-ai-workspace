// The navigation components use no hooks, so the tests call them as functions
// with a fake dispatch, walk the returned elements, and invoke their event
// handlers: every navigation item must send exactly its own action.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { expect, test } from "vitest";
import type { WorkspaceView } from "../shared/ipc-contract.ts";
import { ACCOUNT_SCREEN_TITLE_ID } from "./AccountScreen.tsx";
import {
  ProjectNav,
  WorkspaceNav,
  type WorkspaceSidebar,
} from "./Navigation.tsx";
import { ProjectPanel } from "./ProjectPanel.tsx";
import {
  createShellState,
  PANEL_IDS,
  shellReducer,
  type PanelId,
  type ProjectSummary,
  type ShellAction,
} from "./screens.ts";
import { IDLE_HOME_SIGN_IN_START } from "./workspace-view.ts";
import { HomeScreen, showAccountScreen } from "./WorkspaceScreens.tsx";

interface HostProps {
  readonly children?: ReactNode;
  readonly role?: string;
  readonly onClick?: () => void;
  readonly onKeyDown?: (event: FakeKeyEvent) => void;
}

interface FakeKeyEvent {
  readonly key: string;
  readonly preventDefault: () => void;
  readonly currentTarget: {
    readonly querySelector: (selector: string) => { focus: () => void };
  };
}

const PROJECTS: readonly ProjectSummary[] = [
  { id: "project-a", name: "Project A" },
  { id: "project-b", name: "Project B" },
];

/**
 * The element and every element below it. A component without hooks is
 * called to reach its elements; one with hooks cannot run outside React and
 * stays a leaf.
 */
function elementsOf(node: ReactNode): ReactElement<HostProps>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (!isValidElement<HostProps>(node)) {
    return [];
  }
  if (typeof node.type === "function") {
    try {
      return elementsOf(
        (node.type as (props: HostProps) => ReactNode)(node.props),
      );
    } catch {
      return [node];
    }
  }
  return [node, ...elementsOf(node.props.children)];
}

const WORKSPACE_STATE: WorkspaceView = {
  revision: 1,
  status: "ready",
  workspaces: [
    { id: "workspace-a", name: "Workspace A" },
    { id: "workspace-b", name: "Workspace B" },
  ],
  selectedWorkspaceId: "workspace-a",
  projects: [],
  openProjectId: null,
};

/** The workspace part of the sidebar, recording each switch in `selected`. */
function sidebar(selected: string[] = []): WorkspaceSidebar {
  return {
    view: { kind: "known", state: WORKSPACE_STATE },
    message: undefined,
    onSelect: (workspaceId) => {
      selected.push(workspaceId);
    },
  };
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child: ReactNode) => textOf(child)).join("");
  }
  return isValidElement<HostProps>(node) ? textOf(node.props.children) : "";
}

function recorder(): {
  readonly dispatch: (action: ShellAction) => void;
  readonly take: () => ShellAction[];
} {
  let actions: ShellAction[] = [];
  return {
    dispatch: (action) => {
      actions.push(action);
    },
    take: () => {
      const taken = actions;
      actions = [];
      return taken;
    },
  };
}

/** Clicks every button and returns its label with the actions it sent. */
function clickEveryButton(
  root: ReactNode,
  take: () => ShellAction[],
): [string, ShellAction[]][] {
  return elementsOf(root)
    .filter((element) => element.type === "button")
    .map((button): [string, ShellAction[]] => {
      take();
      button.props.onClick?.();
      return [textOf(button.props.children), take()];
    });
}

test("each sidebar item shows its workspace screen or opens its project", () => {
  const { dispatch, take } = recorder();
  const expected = [
    ["Home", [{ type: "show-screen", screen: "home" }]],
    ["Account", [{ type: "show-screen", screen: "account" }]],
    ["People", [{ type: "show-screen", screen: "people" }]],
    ["Join", [{ type: "show-screen", screen: "join" }]],
    ["About", [{ type: "show-screen", screen: "about" }]],
    ["Workspace A", []],
    ["Workspace B", []],
    ["Project A", [{ type: "open-project", projectId: "project-a" }]],
    ["Project B", [{ type: "open-project", projectId: "project-b" }]],
  ];

  for (const state of [
    createShellState(PROJECTS),
    createShellState(PROJECTS, {
      screen: "decisions",
      projectId: "project-b",
      panel: "repositories",
    }),
  ]) {
    expect(
      clickEveryButton(
        WorkspaceNav({ state, dispatch, workspaces: sidebar() }),
        take,
      ),
    ).toEqual(expected);
  }
});

test("each workspace item switches to its workspace, and the selected one does nothing", () => {
  const { dispatch, take } = recorder();
  const selected: string[] = [];
  const buttons = elementsOf(
    WorkspaceNav({
      state: createShellState(PROJECTS),
      dispatch,
      workspaces: sidebar(selected),
    }),
  ).filter(
    (element) =>
      element.type === "button" &&
      textOf(element.props.children).startsWith("Workspace"),
  );

  expect(buttons.map((button) => textOf(button.props.children))).toEqual([
    "Workspace A",
    "Workspace B",
  ]);
  buttons[0]?.props.onClick?.();
  expect(selected).toEqual([]);
  buttons[1]?.props.onClick?.();
  expect(selected).toEqual(["workspace-b"]);
  expect(take()).toEqual([]);
});

test("each project navigation item shows its project screen", () => {
  const { dispatch, take } = recorder();

  for (const screen of ["chat", "permissions"] as const) {
    expect(
      clickEveryButton(
        ProjectNav({
          project: PROJECTS[1] as ProjectSummary,
          screen,
          dispatch,
        }),
        take,
      ),
    ).toEqual([
      ["Chat", [{ type: "show-screen", screen: "chat" }]],
      ["Tasks", [{ type: "show-screen", screen: "tasks" }]],
      ["Decisions", [{ type: "show-screen", screen: "decisions" }]],
      ["Permissions", [{ type: "show-screen", screen: "permissions" }]],
    ]);
  }
});

test("each side panel tab selects its panel", () => {
  const { dispatch, take } = recorder();

  for (const panel of PANEL_IDS) {
    expect(
      clickEveryButton(
        ProjectPanel({ panel, projectId: "project-a", dispatch }),
        take,
      ),
    ).toEqual([
      ["Agents", [{ type: "show-panel", panel: "agents" }]],
      ["Repositories", [{ type: "show-panel", panel: "repositories" }]],
    ]);
  }
});

function pressKey(
  panel: PanelId,
  key: string,
): { actions: ShellAction[]; focused: string[]; prevented: boolean } {
  const { dispatch, take } = recorder();
  const tablist = elementsOf(
    ProjectPanel({ panel, projectId: "project-a", dispatch }),
  ).find((element) => element.props.role === "tablist");
  const focused: string[] = [];
  let prevented = false;
  tablist?.props.onKeyDown?.({
    key,
    preventDefault: () => {
      prevented = true;
    },
    currentTarget: {
      querySelector: (selector) => ({
        focus: () => {
          focused.push(selector);
        },
      }),
    },
  });
  return { actions: take(), focused, prevented };
}

test("the arrow keys, Home, and End select a tab and move the focus to it", () => {
  const cases: [PanelId, string, PanelId][] = [
    ["agents", "ArrowRight", "repositories"],
    ["agents", "ArrowLeft", "repositories"],
    ["agents", "End", "repositories"],
    ["agents", "Home", "agents"],
    ["repositories", "ArrowRight", "agents"],
    ["repositories", "ArrowLeft", "agents"],
    ["repositories", "Home", "agents"],
    ["repositories", "End", "repositories"],
  ];

  for (const [panel, key, next] of cases) {
    expect(pressKey(panel, key)).toEqual({
      actions: [{ type: "show-panel", panel: next }],
      focused: [`#panel-tab-${next}`],
      prevented: true,
    });
  }
});

test("other keys in the tab list do nothing", () => {
  for (const key of ["Enter", " ", "Tab", "ArrowDown", "ArrowUp", "a"]) {
    expect(pressKey("agents", key)).toEqual({
      actions: [],
      focused: [],
      prevented: false,
    });
  }
});

test("Go to Account on the home screen shows the account screen and moves the focus to its title, and it is offered only while no device is signed in", () => {
  for (const signIn of ["sign_in", "not_ready"] as const) {
    const { dispatch, take } = recorder();
    const steps: string[] = [];
    const home = HomeScreen({
      signIn,
      start: IDLE_HOME_SIGN_IN_START,
      onStartSignIn: () => {
        steps.push("start");
      },
      dispatch: (action) => {
        steps.push(`dispatch ${action.type}`);
        dispatch(action);
      },
      focusAfterShow: (id) => {
        steps.push(`focus #${id}`);
      },
    });
    const goToAccount: [string, ShellAction[]] = [
      "Go to Account",
      [{ type: "show-screen", screen: "account" }],
    ];
    // "Sign in with GitHub" starts the sign-in and leaves the switch to
    // the start (`createHomeSignInStart`).
    expect(clickEveryButton(home, take), signIn).toEqual(
      signIn === "sign_in"
        ? [["Sign in with GitHub", []], goToAccount]
        : [goToAccount],
    );
    // The focus is asked for before the view changes, and goes to the
    // title that the account screen renders with this ID.
    expect(steps, signIn).toEqual([
      ...(signIn === "sign_in" ? ["start"] : []),
      `focus #${ACCOUNT_SCREEN_TITLE_ID}`,
      "dispatch show-screen",
    ]);
  }
  expect(ACCOUNT_SCREEN_TITLE_ID).toBe("account-screen-title");
  const { dispatch, take } = recorder();
  const focused: string[] = [];
  expect(
    clickEveryButton(
      HomeScreen({
        signIn: "none",
        start: IDLE_HOME_SIGN_IN_START,
        onStartSignIn: () => focused.push("start"),
        dispatch,
        focusAfterShow: (id) => focused.push(id),
      }),
      take,
    ),
  ).toEqual([]);
  expect(focused).toEqual([]);
});

test("while its start runs, Sign in with GitHub on the home screen stays focusable and does nothing", () => {
  const { dispatch, take } = recorder();
  const started: string[] = [];
  const home = HomeScreen({
    signIn: "sign_in",
    start: { running: true, message: undefined },
    onStartSignIn: () => started.push("start"),
    dispatch,
    focusAfterShow: () => undefined,
  });
  const button = elementsOf(home).find(
    (element) => textOf(element.props.children) === "Sign in with GitHub",
  );
  expect(button?.props).toMatchObject({ "aria-disabled": "true" });
  expect(button?.props).not.toHaveProperty("disabled");
  expect(clickEveryButton(home, take)).toEqual([
    ["Sign in with GitHub", []],
    ["Go to Account", [{ type: "show-screen", screen: "account" }]],
  ]);
  expect(started).toEqual([]);
});

test("the shell switch of a sign-in started on the home screen asks for the focus on the account screen's title first, and shows the account screen from the home screen", () => {
  const steps: string[] = [];
  let state = createShellState(PROJECTS);
  showAccountScreen(
    (action) => {
      steps.push(`dispatch ${action.type}`);
      state = shellReducer(state, action);
    },
    (id) => steps.push(`focus #${id}`),
  );
  expect(steps).toEqual([
    `focus #${ACCOUNT_SCREEN_TITLE_ID}`,
    "dispatch show-screen",
  ]);
  expect(state.view).toEqual({ screen: "account" });
});
