import type { Dispatch } from "react";
import {
  isProjectView,
  PROJECT_SCREENS,
  WORKSPACE_SCREENS,
  type ProjectScreenId,
  type ProjectSummary,
  type ShellAction,
  type ShellState,
} from "./screens.ts";

/**
 * The sidebar: the workspace screens and the workspace's projects. The shown
 * screen is marked with `aria-current="page"`, the open project with
 * `aria-current="true"`.
 */
export function WorkspaceNav({
  state,
  dispatch,
}: {
  readonly state: ShellState;
  readonly dispatch: Dispatch<ShellAction>;
}) {
  const { view } = state;
  const openProjectId = isProjectView(view) ? view.projectId : undefined;
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
      <h2 className="nav-heading" id="projects-heading">
        Projects
      </h2>
      {state.projects.length === 0 ? (
        <p className="nav-empty">No projects yet.</p>
      ) : (
        <ul className="nav-list" aria-labelledby="projects-heading">
          {state.projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className="nav-item"
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
    </nav>
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
      <p className="project-nav-name">{project.name}</p>
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
