import type { Dispatch } from "react";
import type { WorkspaceView } from "../shared/ipc-contract.ts";
import { CLAIM_MARK_MESSAGES } from "./claim-marks-view.ts";
import { CLAIM_MESSAGES } from "./claims-view.ts";
import {
  CreateButton,
  CreatedOpenButton,
  CreateStatus,
  PROJECTS_HEADING_ID,
  WORKSPACES_HEADING_ID,
  type CreationControls,
} from "./Creation.tsx";
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

const NO_MARKED_WORKSPACES: ReadonlySet<string> = new Set();

/**
 * The sidebar: the workspace screens, the account's workspaces, and the
 * selected workspace's projects. The shown screen is marked with
 * `aria-current="page"`, the selected workspace and the open project with
 * `aria-current="true"`. Names are text that people entered, so each one
 * takes its direction from its own content (`dir="auto"`). Below each list,
 * "New workspace" and "New project" open the dialog that asks for the name
 * (#95, D7), and a status paragraph says how the last create there went,
 * followed by "Open this workspace" or "Open this project" while its
 * sentence offers it. While the selected workspace has a claim that the
 * account has not seen (#95, D8), the people item carries a dot, which is
 * hidden from assistive technologies, and its accessible name says so
 * ("People, new claims"), so that the marker is not only a color. Each
 * workspace of the list that holds such a claim (#271) carries the same
 * dot, and its accessible name is its name followed by ", new claims".
 */
export function WorkspaceNav({
  state,
  dispatch,
  workspaces,
  creation,
  unseenClaims = false,
  markedWorkspaces = NO_MARKED_WORKSPACES,
}: {
  readonly state: ShellState;
  readonly dispatch: Dispatch<ShellAction>;
  readonly workspaces: WorkspaceSidebar;
  /** The creates; undefined without the bridge. */
  readonly creation?: CreationControls | undefined;
  /** Whether the selected workspace has a claim that the account has not seen. */
  readonly unseenClaims?: boolean | undefined;
  /**
   * The workspaces of the list that hold a claim that the account has not
   * seen (`markedWorkspaces`): the selected one by its own claims, the
   * others by the main process's marks.
   */
  readonly markedWorkspaces?: ReadonlySet<string> | undefined;
}) {
  const { view } = state;
  return (
    <nav className="shell-nav" aria-label="Workspace">
      <ul className="nav-list">
        {WORKSPACE_SCREENS.map((screen) => {
          const marked = unseenClaims && screen.id === "people";
          return (
            <li key={screen.id}>
              <button
                type="button"
                className="nav-item"
                aria-current={screen.id === view.screen ? "page" : undefined}
                aria-label={
                  marked ? CLAIM_MESSAGES.peopleWithNewClaims : undefined
                }
                onClick={() =>
                  dispatch({ type: "show-screen", screen: screen.id })
                }
              >
                {screen.label}
                {marked ? (
                  <span className="nav-marker" aria-hidden="true" />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <h2 className="nav-heading" id={WORKSPACES_HEADING_ID} tabIndex={-1}>
        Workspaces
      </h2>
      <WorkspaceList {...workspaces} marked={markedWorkspaces} />
      {creation === undefined ? null : (
        <>
          {creation.offer.workspace ? (
            <CreateButton
              place="workspaces"
              running={creation.view.running}
              onOpen={creation.onOpen}
            />
          ) : null}
          <CreateStatus
            place="workspaces"
            message={creation.view.message}
            created={creation.created}
            className="nav-empty nav-status"
          />
          <CreatedOpenButton
            place="workspaces"
            created={creation.created}
            running={creation.view.running}
            onOpen={creation.onOpenCreated}
            className="nav-create"
          />
        </>
      )}
      <SelectedWorkspace
        view={workspaces.view}
        state={state}
        dispatch={dispatch}
        creation={creation}
      />
    </nav>
  );
}

/**
 * The workspaces with the selected one marked, or a fixed text for the
 * state, and below them why the workspaces are unavailable or why the last
 * switch was refused. The status paragraph is always rendered, empty when
 * there is nothing to say, so that a screen reader announces a new text.
 * Selecting the selected workspace does nothing.
 */
function WorkspaceList({
  view,
  message,
  onSelect,
  marked,
}: WorkspaceSidebar & { readonly marked: ReadonlySet<string> }) {
  const status = view.kind === "known" ? view.state.status : undefined;
  const notices = [
    view.kind === "known" && view.state.status === "unavailable"
      ? WORKSPACE_PROBLEM_MESSAGES[view.state.problem]
      : undefined,
    // A switch message means nothing once the device is no longer ready.
    status === "signed_out" ? undefined : message,
  ].filter((notice) => notice !== undefined);
  return (
    <>
      <WorkspaceItems view={view} onSelect={onSelect} marked={marked} />
      <p className="nav-empty nav-status" role="status">
        {notices.join(" ")}
      </p>
    </>
  );
}

/**
 * The selected workspace's projects, or a fixed text when workspaces are
 * listed but none is selected. Nothing before the first state and while the
 * device is not ready.
 */
function SelectedWorkspace({
  view,
  state,
  dispatch,
  creation,
}: {
  readonly view: WorkspacePanelView;
  readonly state: ShellState;
  readonly dispatch: Dispatch<ShellAction>;
  readonly creation: CreationControls | undefined;
}) {
  if (view.kind !== "known" || view.state.status === "signed_out") {
    return null;
  }
  if (view.state.selectedWorkspaceId === null) {
    return view.state.workspaces.length === 0 ? null : (
      <p className="nav-empty">{WORKSPACE_MESSAGES.noneSelected}</p>
    );
  }
  return (
    <ProjectList
      state={state}
      dispatch={dispatch}
      status={view.state.status}
      creation={creation}
    />
  );
}

function WorkspaceItems({
  view,
  onSelect,
  marked,
}: Pick<WorkspaceSidebar, "view" | "onSelect"> & {
  readonly marked: ReadonlySet<string>;
}) {
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
        const hasNewClaims = marked.has(workspace.id);
        return (
          <li key={workspace.id}>
            <button
              type="button"
              className="nav-item"
              dir="auto"
              aria-current={selected ? "true" : undefined}
              aria-label={
                hasNewClaims
                  ? CLAIM_MARK_MESSAGES.workspaceWithNewClaims(workspace.name)
                  : undefined
              }
              onClick={selected ? undefined : () => onSelect(workspace.id)}
            >
              {workspace.name}
              {hasNewClaims ? (
                <span className="nav-marker" aria-hidden="true" />
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The selected workspace's projects, with the open one marked, and "New
 * project", which every active member of the workspace may use. The
 * heading takes the focus without a tab stop when "Open this project"
 * leaves the page (`focusAfterOpenLeaves`).
 */
function ProjectList({
  state,
  dispatch,
  status,
  creation,
}: {
  readonly state: ShellState;
  readonly dispatch: Dispatch<ShellAction>;
  readonly status: WorkspaceView["status"];
  readonly creation: CreationControls | undefined;
}) {
  const { view } = state;
  const openProjectId = isProjectView(view) ? view.projectId : undefined;
  return (
    <>
      <h2 className="nav-heading" id={PROJECTS_HEADING_ID} tabIndex={-1}>
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
        <ul className="nav-list" aria-labelledby={PROJECTS_HEADING_ID}>
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
      {creation === undefined ? null : (
        <>
          {creation.offer.projectIn === null ? null : (
            <CreateButton
              place="projects"
              running={creation.view.running}
              onOpen={creation.onOpen}
            />
          )}
          <CreateStatus
            place="projects"
            message={creation.view.message}
            created={creation.created}
            className="nav-empty nav-status"
          />
          <CreatedOpenButton
            place="projects"
            created={creation.created}
            running={creation.view.running}
            onOpen={creation.onOpenCreated}
            className="nav-create"
          />
        </>
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
