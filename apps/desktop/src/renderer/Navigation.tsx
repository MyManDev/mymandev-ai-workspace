import type { Dispatch } from "react";
import type { WorkspaceView } from "../shared/ipc-contract.ts";
import {
  isProjectView,
  PROJECT_SCREENS,
  WORKSPACE_SCREENS,
  type ProjectScreenId,
  type ProjectSummary,
  type ShellAction,
  type ShellState,
} from "./screens.ts";
import {
  WORKSPACE_MESSAGES,
  WORKSPACE_PROBLEM_MESSAGES,
  type WorkspacePanelView,
} from "./workspace-view.ts";

/** The workspace part of the sidebar, which `App` follows from the bridge. */
export interface WorkspaceSidebar {
  readonly view: WorkspacePanelView;
  /** Why the last switch was refused or failed, or undefined. */
  readonly message: string | undefined;
  /** Switches to another workspace. */
  readonly onSelect: (workspaceId: string) => void;
}

/**
 * The sidebar: the workspace screens, the account's workspaces, and the
 * selected workspace's projects. The shown screen is marked with
 * `aria-current="page"`, the selected workspace and the open project with
 * `aria-current="true"`. Names are text that people entered, so each one
 * takes its direction from its own content (`dir="auto"`).
 */
export function WorkspaceNav({
  state,
  dispatch,
  workspaces,
}: {
  readonly state: ShellState;
  readonly dispatch: Dispatch<ShellAction>;
  readonly workspaces: WorkspaceSidebar;
}) {
  const { view } = state;
  return (
    <nav className="shell-nav" aria-label="Workspace">
      <ul className="nav-list">
        {WORKSPACE_SCREENS.map((screen) => (
          <li key={screen.id}>
            <button
              type="button"
              className="nav-item"
              aria-current={screen.id === view.screen ? "page" : undefined}
              onClick={() =>
                dispatch({ type: "show-screen", screen: screen.id })
              }
            >
              {screen.label}
            </button>
          </li>
        ))}
      </ul>
      <h2 className="nav-heading" id="workspaces-heading">
        Workspaces
      </h2>
      <WorkspaceList {...workspaces} />
      {workspaces.view.kind === "known" &&
      workspaces.view.state.status !== "signed_out" &&
      workspaces.view.state.selectedWorkspaceId !== null ? (
        <ProjectList
          state={state}
          dispatch={dispatch}
          status={workspaces.view.state.status}
        />
      ) : null}
    </nav>
  );
}

/**
 * The workspaces with the selected one marked, or a fixed text for the
 * state, and below them why the workspaces are unavailable or why the last
 * switch was refused. Selecting the selected workspace does nothing.
 */
function WorkspaceList({ view, message, onSelect }: WorkspaceSidebar) {
  const notices = [
    view.kind === "known" && view.state.status === "unavailable"
      ? WORKSPACE_PROBLEM_MESSAGES[view.state.problem]
      : undefined,
    message,
  ].filter((notice) => notice !== undefined);
  return (
    <>
      <WorkspaceItems view={view} onSelect={onSelect} />
      {notices.length === 0 ? null : (
        <p className="nav-empty" role="status">
          {notices.join(" ")}
        </p>
      )}
    </>
  );
}

function WorkspaceItems({
  view,
  onSelect,
}: Pick<WorkspaceSidebar, "view" | "onSelect">) {
  switch (view.kind) {
    case "unavailable":
      return <p className="nav-empty">{WORKSPACE_MESSAGES.unavailable}</p>;
    case "pending":
      return <p className="nav-empty">{WORKSPACE_MESSAGES.pending}</p>;
    case "known":
      break;
  }
  const { status, workspaces, selectedWorkspaceId } = view.state;
  if (status === "signed_out") {
    return <p className="nav-empty">{WORKSPACE_MESSAGES.signedOut}</p>;
  }
  if (workspaces.length === 0) {
    return status === "loading" ? (
      <p className="nav-empty">{WORKSPACE_MESSAGES.loadingWorkspaces}</p>
    ) : status === "ready" ? (
      <p className="nav-empty">{WORKSPACE_MESSAGES.noWorkspaces}</p>
    ) : null;
  }
  return (
    <ul className="nav-list" aria-labelledby="workspaces-heading">
      {workspaces.map((workspace) => {
        const selected = workspace.id === selectedWorkspaceId;
        return (
          <li key={workspace.id}>
            <button
              type="button"
              className="nav-item"
              dir="auto"
              aria-current={selected ? "true" : undefined}
              onClick={selected ? undefined : () => onSelect(workspace.id)}
            >
              {workspace.name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The selected workspace's projects, with the open one marked. */
function ProjectList({
  state,
  dispatch,
  status,
}: {
  readonly state: ShellState;
  readonly dispatch: Dispatch<ShellAction>;
  readonly status: WorkspaceView["status"];
}) {
  const { view } = state;
  const openProjectId = isProjectView(view) ? view.projectId : undefined;
  return (
    <>
      <h2 className="nav-heading" id="projects-heading">
        Projects
      </h2>
      {state.projects.length === 0 ? (
        // While unavailable, the problem above says why nothing is listed.
        status === "unavailable" ? null : (
          <p className="nav-empty">
            {status === "loading"
              ? WORKSPACE_MESSAGES.loadingProjects
              : WORKSPACE_MESSAGES.noProjects}
          </p>
        )
      ) : (
        <ul className="nav-list" aria-labelledby="projects-heading">
          {state.projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className="nav-item"
                dir="auto"
                aria-current={project.id === openProjectId ? "true" : undefined}
                onClick={() =>
                  dispatch({ type: "open-project", projectId: project.id })
                }
              >
                {project.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The screens of the open project: chat, tasks, decisions, and permissions. */
export function ProjectNav({
  project,
  screen,
  dispatch,
}: {
  readonly project: ProjectSummary;
  readonly screen: ProjectScreenId;
  readonly dispatch: Dispatch<ShellAction>;
}) {
  return (
    <nav className="project-nav" aria-label="Project">
      <p className="project-nav-name" dir="auto">
        {project.name}
      </p>
      <ul className="project-nav-list">
        {PROJECT_SCREENS.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="nav-item"
              aria-current={item.id === screen ? "page" : undefined}
              onClick={() => dispatch({ type: "show-screen", screen: item.id })}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
