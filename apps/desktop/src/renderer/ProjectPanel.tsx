import type { Dispatch, KeyboardEvent } from "react";
import type { RepositoryBridge } from "../shared/desktop-bridge.ts";
import { RepositoryPanel } from "./RepositoryPanel.tsx";
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
 * The agents are placeholder content: agent execution comes in a later
 * milestone. The repositories are the ones mounted on this device; a mount
 * is not linked to a project yet, so every project shows the same ones.
 */
export function ProjectPanel({
  panel,
  dispatch,
  repositories,
}: {
  readonly panel: PanelId;
  readonly dispatch: Dispatch<ShellAction>;
  /** The repository functions from the preload script; undefined outside Electron. */
  readonly repositories?: RepositoryBridge | undefined;
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
          <AgentPanel />
        ) : (
          <RepositoryPanel repositories={repositories} />
        )}
      </div>
    </aside>
  );
}

function AgentPanel() {
  return (
    <>
      <h2 id="panel-title">Agents</h2>
      <p>No agents yet.</p>
      <p className="placeholder-note">
        The agents of this project, with their owner, their device, and what
        they are working on, appear here.
      </p>
    </>
  );
}
