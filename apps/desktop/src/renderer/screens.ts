// The screen structure of the shell: a typed state and a reducer instead of a
// router library (ADR 0016). A workspace contains projects (ADR 0005). The
// workspace screens stand on their own; the project screens belong to the open
// project, which also shows a side panel with its agents or its repositories.

/** The screens outside a project. */
export const WORKSPACE_SCREEN_IDS = ["home", "about"] as const;

/** The screens of the open project. */
export const PROJECT_SCREEN_IDS = [
  "chat",
  "tasks",
  "decisions",
  "permissions",
] as const;

export const SCREEN_IDS = [
  ...WORKSPACE_SCREEN_IDS,
  ...PROJECT_SCREEN_IDS,
] as const;

/** The side panels of the open project. */
export const PANEL_IDS = ["agents", "repositories"] as const;

export type WorkspaceScreenId = (typeof WORKSPACE_SCREEN_IDS)[number];
export type ProjectScreenId = (typeof PROJECT_SCREEN_IDS)[number];
export type ScreenId = (typeof SCREEN_IDS)[number];
export type PanelId = (typeof PANEL_IDS)[number];

export interface NavigationItem<Id extends string> {
  readonly id: Id;
  /** The label in the navigation. */
  readonly label: string;
}

/** The workspace screens in navigation order. */
export const WORKSPACE_SCREENS: readonly NavigationItem<WorkspaceScreenId>[] = [
  { id: "home", label: "Home" },
  { id: "about", label: "About" },
];

/** The project screens in navigation order. */
export const PROJECT_SCREENS: readonly NavigationItem<ProjectScreenId>[] = [
  { id: "chat", label: "Chat" },
  { id: "tasks", label: "Tasks" },
  { id: "decisions", label: "Decisions" },
  { id: "permissions", label: "Permissions" },
];

/** The side panels in the order of their switch. */
export const PANELS: readonly NavigationItem<PanelId>[] = [
  { id: "agents", label: "Agents" },
  { id: "repositories", label: "Repositories" },
];

/** The side panel of a project opened while no project was open. */
export const DEFAULT_PANEL: PanelId = "agents";

/** A project in the navigation. Its name is human-entered text (ADR 0005). */
export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
}

export interface WorkspaceView {
  readonly screen: WorkspaceScreenId;
}

export interface ProjectView {
  readonly screen: ProjectScreenId;
  readonly projectId: string;
  readonly panel: PanelId;
}

/** What the shell shows. */
export type ShellView = WorkspaceView | ProjectView;

export interface ShellState {
  /** The workspace's projects, in navigation order. */
  readonly projects: readonly ProjectSummary[];
  readonly view: ShellView;
}

export type ShellAction =
  /**
   * Shows a workspace screen, which closes the open project, or another
   * screen of the open project. A project screen without an open project is
   * refused.
   */
  | { readonly type: "show-screen"; readonly screen: ScreenId }
  /**
   * Opens a project of the workspace on its chat. The side panel stays as it
   * is. An unknown project is refused.
   */
  | { readonly type: "open-project"; readonly projectId: string }
  /** Switches the side panel of the open project. */
  | { readonly type: "show-panel"; readonly panel: PanelId };

export const HOME_VIEW: WorkspaceView = Object.freeze({ screen: "home" });

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

export function isProjectView(view: ShellView): view is ProjectView {
  return isOneOf(PROJECT_SCREEN_IDS, view.screen);
}

function hasProject(
  projects: readonly ProjectSummary[],
  projectId: unknown,
): boolean {
  return projects.some((project) => project.id === projectId);
}

/**
 * A copy of the view with only its own fields, or undefined when it is not a
 * valid view for these projects.
 */
function validView(
  projects: readonly ProjectSummary[],
  view: ShellView,
): ShellView | undefined {
  if (isOneOf(WORKSPACE_SCREEN_IDS, view.screen)) {
    return { screen: view.screen };
  }
  if (
    isProjectView(view) &&
    hasProject(projects, view.projectId) &&
    isOneOf(PANEL_IDS, view.panel)
  ) {
    return {
      screen: view.screen,
      projectId: view.projectId,
      panel: view.panel,
    };
  }
  return undefined;
}

/**
 * The first state of the shell. A view that is not valid for these projects,
 * for example one whose project does not exist, shows the home screen instead.
 *
 * Throws when two projects have the same ID, because the navigation and the
 * view name a project only by its ID. The projects are fixed for now; a later
 * action that replaces them, for example when the cloud API delivers them,
 * must refuse duplicate IDs in the same way and validate the shown view
 * again, so that a view whose project is gone shows the home screen.
 */
export function createShellState(
  projects: readonly ProjectSummary[],
  view: ShellView = HOME_VIEW,
): ShellState {
  const ids = new Set(projects.map((project) => project.id));
  if (ids.size !== projects.length) {
    throw new Error("Two projects in the shell state have the same ID.");
  }
  return { projects, view: validView(projects, view) ?? HOME_VIEW };
}

export interface OpenProject {
  readonly project: ProjectSummary;
  readonly view: ProjectView;
}

/** The open project and its view, or undefined on a workspace screen. */
export function openProject(state: ShellState): OpenProject | undefined {
  const { view } = state;
  if (!isProjectView(view)) {
    return undefined;
  }
  const project = state.projects.find(({ id }) => id === view.projectId);
  return project === undefined ? undefined : { project, view };
}

function sameView(a: ShellView, b: ShellView): boolean {
  if (isProjectView(a) && isProjectView(b)) {
    return (
      a.screen === b.screen &&
      a.projectId === b.projectId &&
      a.panel === b.panel
    );
  }
  return a.screen === b.screen;
}

/** The view that an action leads to, or undefined when it is refused. */
function nextView(
  state: ShellState,
  action: ShellAction,
): ShellView | undefined {
  const current = state.view;
  switch (action.type) {
    case "show-screen":
      if (isOneOf(WORKSPACE_SCREEN_IDS, action.screen)) {
        return { screen: action.screen };
      }
      if (
        isOneOf(PROJECT_SCREEN_IDS, action.screen) &&
        isProjectView(current)
      ) {
        return { ...current, screen: action.screen };
      }
      return undefined;
    case "open-project":
      if (!hasProject(state.projects, action.projectId)) {
        return undefined;
      }
      return {
        screen: "chat",
        projectId: action.projectId,
        panel: isProjectView(current) ? current.panel : DEFAULT_PANEL,
      };
    case "show-panel":
      return isOneOf(PANEL_IDS, action.panel) && isProjectView(current)
        ? { ...current, panel: action.panel }
        : undefined;
    default:
      // An action from outside the type, for example a malformed one.
      return undefined;
  }
}

/**
 * Switches what the shell shows. A refused action and an action that changes
 * nothing return the same state object, so React skips the render.
 */
export function shellReducer(
  state: ShellState,
  action: ShellAction,
): ShellState {
  const view = nextView(state, action);
  return view === undefined || sameView(view, state.view)
    ? state
    : { ...state, view };
}
