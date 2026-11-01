// The navigation components use no hooks, so the tests call them as functions
// with a fake dispatch, walk the returned elements, and invoke their event
// handlers: every navigation item must send exactly its own action.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { expect, test } from "vitest";
import { ProjectNav, WorkspaceNav } from "./Navigation.tsx";
import { ProjectPanel } from "./ProjectPanel.tsx";
import {
  createShellState,
  PANEL_IDS,
  type PanelId,
  type ProjectSummary,
  type ShellAction,
} from "./screens.ts";

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

/** The element and every element below it, without rendering components. */
function elementsOf(node: ReactNode): ReactElement<HostProps>[] {
  if (Array.isArray(node)) {
    return node.flatMap((child: ReactNode) => elementsOf(child));
  }
  if (!isValidElement<HostProps>(node)) {
    return [];
  }
  return [node, ...elementsOf(node.props.children)];
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
    ["About", [{ type: "show-screen", screen: "about" }]],
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
    expect(clickEveryButton(WorkspaceNav({ state, dispatch }), take)).toEqual(
      expected,
    );
  }
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
    expect(clickEveryButton(ProjectPanel({ panel, dispatch }), take)).toEqual([
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
  const tablist = elementsOf(ProjectPanel({ panel, dispatch })).find(
    (element) => element.props.role === "tablist",
  );
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
