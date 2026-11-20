import type { Dispatch, KeyboardEvent } from "react";
import type {
  AgentBridge,
  ProjectRepositoriesBridge,
  RepositoryBridge,
} from "../shared/desktop-bridge.ts";
import { AgentPanel } from "./AgentPanel.tsx";
import {
  useProjectRepositories,
  type ProjectRepositoriesControls,
} from "./ProjectRepositories.tsx";
import { RepositoryPanel, useMountList } from "./RepositoryPanel.tsx";
import type { RepositoryPanelView } from "./repository-view.ts";
import {
  PANEL_IDS,
  PANELS,
  type PanelId,
  type ShellAction,
} from "./screens.ts";

/** The ID of the side panel's content, which every tab controls. */
export const PANEL_CONTENT_ID = "panel-content";

export function panelTabId(panel: PanelId): string {
  return `panel-tab-${panel}`;
}

/**
 * The panel that a key selects in the tab list: the arrow keys move to the
 * next or the previous tab and wrap around, Home and End move to the first or
 * the last. Undefined for every other key.
 */
export function panelForKey(
  current: PanelId,
  key: string,
): PanelId | undefined {
  const index = PANEL_IDS.indexOf(current);
  const last = PANEL_IDS.length - 1;
  switch (key) {
    case "ArrowRight":
      return PANEL_IDS[index === last ? 0 : index + 1];
    case "ArrowLeft":
      return PANEL_IDS[index === 0 ? last : index - 1];
    case "Home":
      return PANEL_IDS[0];
    case "End":
      return PANEL_IDS[last];
    default:
      return undefined;
  }
}

/**
 * The side panel of the open project, beside its screens: its agents or its
 * repositories, chosen with tabs. Only the selected tab is in the tab order;
 * the arrow keys, Home, and End select another tab and move the focus to it.
 * The agents are the open project's agents and runs, read-only. The
 * repositories are the open project's registered repositories, with their
 * links to folders on this device, and the repositories mounted on this
 * device, which every project shows the same.
 *
 * The project's repositories and their actions, and the mount list that
 * they need, are followed here (`useProjectRepositories` and
 * `useMountList`), not in the repository panel, which leaves the page with a
 * switch to the agents tab (#310). So they live while the project is open,
 * whichever tab is shown: an action that runs keeps holding the buttons, its
 * answer still shows its sentence and empties the name field, and the name
 * field keeps what was typed. Another project, a sign-out, and a state of
 * another project still end what belonged to the earlier one
 * (`createProjectRepositoryActions`).
 */
export function ProjectPanel({
  panel,
  projectId,
  dispatch,
  agents,
  repositories,
  projectRepositories,
}: {
  readonly panel: PanelId;
  /** The open project. */
  readonly projectId: string;
  readonly dispatch: Dispatch<ShellAction>;
  /** The agent functions from the preload script; undefined outside Electron. */
  readonly agents?: AgentBridge | undefined;
  /** The repository functions from the preload script; undefined outside Electron. */
  readonly repositories?: RepositoryBridge | undefined;
  /** The project repository functions from the preload script; undefined outside Electron. */
  readonly projectRepositories?: ProjectRepositoriesBridge | undefined;
}) {
  const mounts = useMountList(repositories);
  const project = useProjectRepositories(
    projectRepositories,
    projectId,
    mounts,
  );
  return (
    <ProjectPanelContent
      panel={panel}
      projectId={projectId}
      dispatch={dispatch}
      agents={agents}
      repositories={repositories}
      mounts={mounts}
      project={project}
    />
  );
}

/**
 * The side panel without state: the tabs and the selected tab's panel, with
 * the mount list and the project's repositories that `ProjectPanel` holds.
 */
export function ProjectPanelContent({
  panel,
  projectId,
  dispatch,
  agents,
  repositories,
  mounts,
  project,
}: {
  readonly panel: PanelId;
  /** The open project. */
  readonly projectId: string;
  readonly dispatch: Dispatch<ShellAction>;
  /** The agent functions from the preload script; undefined outside Electron. */
  readonly agents?: AgentBridge | undefined;
  /** The repository functions from the preload script; undefined outside Electron. */
  readonly repositories?: RepositoryBridge | undefined;
  /** This device's mount list (`useMountList`). */
  readonly mounts: RepositoryPanelView;
  /** The project's repositories and their actions (`useProjectRepositories`). */
  readonly project: ProjectRepositoriesControls;
}) {
  const selectWithKey = (event: KeyboardEvent<HTMLElement>) => {
    const next = panelForKey(panel, event.key);
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    dispatch({ type: "show-panel", panel: next });
    event.currentTarget
      .querySelector<HTMLElement>(`#${panelTabId(next)}`)
      ?.focus();
  };

  return (
    <aside className="project-panel" aria-labelledby="panel-title">
      <div
        className="panel-tabs"
        role="tablist"
        aria-label="Side panel"
        onKeyDown={selectWithKey}
      >
        {PANELS.map((item) => {
          const selected = item.id === panel;
          return (
            <button
              type="button"
              role="tab"
              id={panelTabId(item.id)}
              className="panel-tab"
              aria-selected={selected}
              aria-controls={PANEL_CONTENT_ID}
              tabIndex={selected ? 0 : -1}
              key={item.id}
              onClick={() => dispatch({ type: "show-panel", panel: item.id })}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        className="panel-content"
        role="tabpanel"
        id={PANEL_CONTENT_ID}
        aria-labelledby={panelTabId(panel)}
        tabIndex={0}
      >
        {panel === "agents" ? (
          <AgentPanel agents={agents} projectId={projectId} />
        ) : (
          <RepositoryPanel
            repositories={repositories}
            mounts={mounts}
            project={project}
          />
        )}
      </div>
    </aside>
  );
}
