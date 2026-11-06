import { expect, test } from "vitest";
import {
  createShellState,
  DEFAULT_PANEL,
  HOME_VIEW,
  openProject,
  PANEL_IDS,
  PANELS,
  PROJECT_SCREEN_IDS,
  PROJECT_SCREENS,
  SCREEN_IDS,
  shellReducer,
  WORKSPACE_SCREEN_IDS,
  WORKSPACE_SCREENS,
  type ProjectSummary,
  type ShellAction,
  type ShellState,
  type ShellView,
} from "./screens.ts";

const PROJECTS: readonly ProjectSummary[] = Object.freeze([
  Object.freeze({ id: "project-a", name: "Project A" }),
  Object.freeze({ id: "project-b", name: "Project B" }),
]);

/** A state whose objects are frozen, so a reducer that mutates it throws. */
function frozen(state: ShellState): ShellState {
  return Object.freeze({ ...state, view: Object.freeze({ ...state.view }) });
}

function run(state: ShellState, ...actions: ShellAction[]): ShellState {
  return actions.reduce(
    (current, action) => shellReducer(frozen(current), action),
    state,
  );
}

const home = frozen(createShellState(PROJECTS));
const chatA = run(home, { type: "open-project", projectId: "project-a" });

test("the shell starts on the home screen unless a valid view is given", () => {
  expect(createShellState(PROJECTS)).toEqual({
    projects: PROJECTS,
    view: { screen: "home" },
  });
  expect(createShellState(PROJECTS, { screen: "about" }).view).toEqual({
    screen: "about",
  });
  for (const screen of ["account", "people", "join"] as const) {
    expect(createShellState(PROJECTS, { screen }).view).toEqual({ screen });
  }
  expect(
    createShellState(PROJECTS, {
      screen: "tasks",
      projectId: "project-b",
      panel: "repositories",
    }).view,
  ).toEqual({ screen: "tasks", projectId: "project-b", panel: "repositories" });
});

test("an invalid first view shows the home screen", () => {
  const invalid: unknown[] = [
    { screen: "chat", projectId: "missing", panel: "agents" },
    { screen: "chat", panel: "agents" },
    { screen: "chat", projectId: "project-a", panel: "settings" },
    { screen: "chat", projectId: "project-a" },
    { screen: "settings" },
    {},
  ];
  for (const view of invalid) {
    expect(createShellState(PROJECTS, view as ShellView).view).toEqual(
      HOME_VIEW,
    );
  }
  expect(
    createShellState([], {
      screen: "permissions",
      projectId: "project-a",
      panel: "agents",
    }).view,
  ).toEqual(HOME_VIEW);
});

test("a first view keeps only its own fields", () => {
  const about: unknown = { screen: "about", projectId: "project-a" };
  const chat: unknown = {
    screen: "chat",
    projectId: "project-a",
    panel: "agents",
    extra: true,
  };

  expect(createShellState(PROJECTS, about as ShellView).view).toStrictEqual({
    screen: "about",
  });
  expect(createShellState(PROJECTS, chat as ShellView).view).toStrictEqual({
    screen: "chat",
    projectId: "project-a",
    panel: "agents",
  });
});

test("every workspace screen is reachable from every view", () => {
  for (const start of [home, chatA]) {
    for (const screen of WORKSPACE_SCREEN_IDS) {
      expect(run(start, { type: "show-screen", screen }).view).toEqual({
        screen,
      });
    }
  }
});

test("every project screen of every project is reachable from the home screen", () => {
  for (const project of PROJECTS) {
    for (const screen of PROJECT_SCREEN_IDS) {
      const state = run(
        home,
        { type: "open-project", projectId: project.id },
        { type: "show-screen", screen },
      );
      expect(state.view).toEqual({
        screen,
        projectId: project.id,
        panel: DEFAULT_PANEL,
      });
      expect(openProject(state)?.project).toBe(project);
    }
  }
});

test("every panel is reachable on every project screen", () => {
  for (const screen of PROJECT_SCREEN_IDS) {
    for (const panel of PANEL_IDS) {
      expect(
        run(
          chatA,
          { type: "show-screen", screen },
          { type: "show-panel", panel },
        ).view,
      ).toEqual({ screen, projectId: "project-a", panel });
    }
  }
});

test("opening a project shows its chat and keeps the panel", () => {
  const tasksA = run(
    chatA,
    { type: "show-panel", panel: "repositories" },
    { type: "show-screen", screen: "tasks" },
  );

  expect(
    run(tasksA, { type: "open-project", projectId: "project-b" }).view,
  ).toEqual({
    screen: "chat",
    projectId: "project-b",
    panel: "repositories",
  });
  expect(
    run(tasksA, { type: "open-project", projectId: "project-a" }).view,
  ).toEqual({
    screen: "chat",
    projectId: "project-a",
    panel: "repositories",
  });
});

test("a workspace screen closes the open project", () => {
  const about = run(chatA, { type: "show-screen", screen: "about" });

  expect(about.view).toEqual({ screen: "about" });
  expect(openProject(about)).toBeUndefined();
  expect(openProject(home)).toBeUndefined();
});

test("a transition does not change the previous state", () => {
  const before = createShellState(PROJECTS);
  const after = shellReducer(before, {
    type: "open-project",
    projectId: "project-a",
  });

  expect(after).not.toBe(before);
  expect(before.view).toEqual({ screen: "home" });
  expect(after.projects).toBe(before.projects);
});

test("invalid transitions are refused and return the same state object", () => {
  const refusedOnHome: unknown[] = [
    { type: "show-screen", screen: "chat" },
    { type: "show-screen", screen: "permissions" },
    { type: "show-panel", panel: "repositories" },
    { type: "open-project", projectId: "missing" },
    { type: "open-project", projectId: "" },
  ];
  for (const action of refusedOnHome) {
    expect(shellReducer(home, action as ShellAction)).toBe(home);
  }

  const refusedEverywhere: unknown[] = [
    { type: "show-screen", screen: "settings" },
    { type: "show-screen" },
    { type: "show-panel", panel: "terminal" },
    { type: "show-panel" },
    { type: "open-project" },
    { type: "open-project", projectId: { toString: () => "project-a" } },
    { type: "navigate", screen: "about" },
    { type: "replace-projects" },
    { type: "replace-projects", projects: "project-a" },
    {
      type: "replace-projects",
      projects: [
        { id: "project-a", name: "Project A" },
        { id: "project-a", name: "Another project A" },
      ],
    },
    {},
  ];
  for (const state of [home, chatA]) {
    for (const action of refusedEverywhere) {
      expect(shellReducer(state, action as ShellAction)).toBe(state);
    }
  }
});

test("a project screen of a project that is not in the list is never shown", () => {
  const without = frozen(createShellState([PROJECTS[1] as ProjectSummary]));

  expect(
    shellReducer(without, { type: "open-project", projectId: "project-a" }),
  ).toBe(without);
});

test("two projects with the same ID are refused", () => {
  expect(() =>
    createShellState([
      { id: "project-a", name: "Project A" },
      { id: "project-b", name: "Project B" },
      { id: "project-a", name: "Another project A" },
    ]),
  ).toThrow("Two projects in the shell state have the same ID.");
  expect(createShellState([]).projects).toEqual([]);
});

test("replacing the projects keeps the shown view while its project stays", () => {
  const tasksB = run(
    home,
    { type: "open-project", projectId: "project-b" },
    { type: "show-screen", screen: "tasks" },
    { type: "show-panel", panel: "repositories" },
  );
  const renamed: readonly ProjectSummary[] = [
    { id: "project-b", name: "Project B, renamed" },
    { id: "project-c", name: "Project C" },
  ];

  const after = run(tasksB, { type: "replace-projects", projects: renamed });

  expect(after.projects).toBe(renamed);
  expect(after.view).toEqual(tasksB.view);
  expect(openProject(after)?.project.name).toBe("Project B, renamed");
});

test("replacing the projects shows the home screen when the open project is gone", () => {
  const remaining: readonly ProjectSummary[] = [
    { id: "project-b", name: "Project B" },
  ];

  const after = run(chatA, { type: "replace-projects", projects: remaining });

  expect(after).toEqual({ projects: remaining, view: HOME_VIEW });
  expect(run(after, { type: "replace-projects", projects: [] })).toEqual({
    projects: [],
    view: HOME_VIEW,
  });
});

test("replacing the projects with the same ones returns the same state object", () => {
  const copy = PROJECTS.map((project) => ({ ...project }));

  expect(
    shellReducer(chatA, { type: "replace-projects", projects: copy }),
  ).toBe(chatA);
  expect(
    shellReducer(home, { type: "replace-projects", projects: copy.slice(1) }),
  ).not.toBe(home);
});

test("a transition to the current view returns the same state object", () => {
  expect(shellReducer(home, { type: "show-screen", screen: "home" })).toBe(
    home,
  );
  expect(
    shellReducer(chatA, { type: "open-project", projectId: "project-a" }),
  ).toBe(chatA);
  expect(shellReducer(chatA, { type: "show-screen", screen: "chat" })).toBe(
    chatA,
  );
  expect(shellReducer(chatA, { type: "show-panel", panel: "agents" })).toBe(
    chatA,
  );
});

test("the navigation lists every screen and every panel once", () => {
  expect(WORKSPACE_SCREENS.map((screen) => screen.id)).toEqual([
    ...WORKSPACE_SCREEN_IDS,
  ]);
  expect(PROJECT_SCREENS.map((screen) => screen.id)).toEqual([
    ...PROJECT_SCREEN_IDS,
  ]);
  expect(new Set(SCREEN_IDS).size).toBe(SCREEN_IDS.length);
  expect([...WORKSPACE_SCREEN_IDS, ...PROJECT_SCREEN_IDS]).toEqual([
    ...SCREEN_IDS,
  ]);
  expect(PANELS.map((panel) => panel.id)).toEqual([...PANEL_IDS]);
});

test("the workspace screens are home, account, people, join, and about, in this order", () => {
  expect(WORKSPACE_SCREENS).toEqual([
    { id: "home", label: "Home" },
    { id: "account", label: "Account" },
    { id: "people", label: "People" },
    { id: "join", label: "Join" },
    { id: "about", label: "About" },
  ]);
  // A workspace screen closes the open project, also the new ones.
  for (const screen of ["account", "people", "join"] as const) {
    const state = run(chatA, { type: "show-screen", screen });
    expect(state.view).toEqual({ screen });
    expect(openProject(state)).toBeUndefined();
  }
});
