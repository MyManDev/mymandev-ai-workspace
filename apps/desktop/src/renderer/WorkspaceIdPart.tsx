import { useCallback, useMemo, useState } from "react";
import type { WorkspaceBridge } from "../shared/desktop-bridge.ts";
import type { PeopleScreenView } from "./people-view.ts";
import {
  createWorkspaceIdCopy,
  describeWorkspaceId,
  describeWorkspaceIdCopy,
  IDLE_WORKSPACE_ID_COPY,
  WORKSPACE_ID_MESSAGES,
  type WorkspaceIdCopyView,
} from "./workspace-id-view.ts";

/** The element ID of the line with the workspace ID, which describes "Copy". */
export const WORKSPACE_ID_LINE_ID = "workspace-id-line";

/** The element ID of the status paragraph of the copy. */
export const WORKSPACE_ID_MESSAGE_ID = "workspace-id-message";

/** What the people screen needs to offer the copy of the workspace ID. */
export interface WorkspaceIdCopyControls {
  readonly view: WorkspaceIdCopyView;
  readonly onCopy: (workspaceId: string) => void;
}

/**
 * The selected workspace's ID near the top of the people screen, for every
 * active member of the workspace (`describeWorkspaceId`; #95, the Project
 * Manager's decision of 2026-11-13): "Workspace ID:" and the ID as text in
 * the monospace font, so that similar characters stay apart, left to right
 * and never translated, which the person can also select; the sentence
 * that says what the ID allows; and "Copy", which asks the main process to
 * copy it (`workspaces.copyId`). "Copy" stays on the page and keeps the
 * focus, and while a copy runs it stays focusable and does nothing
 * (`aria-disabled`), as the people actions' buttons do. The sentence of the
 * last copy sits in its own status paragraph, always rendered, empty when
 * there is nothing to say, so that a screen reader announces it politely.
 */
export function WorkspaceIdPart({
  view,
  copy,
}: {
  readonly view: PeopleScreenView;
  readonly copy: WorkspaceIdCopyControls;
}) {
  const workspaceId = describeWorkspaceId(view);
  const running = copy.view.running;
  return (
    <>
      {workspaceId === null ? null : (
        <div className="people-offer">
          <p id={WORKSPACE_ID_LINE_ID}>
            {WORKSPACE_ID_MESSAGES.label}
            <span className="workspace-id" dir="ltr" translate="no">
              {workspaceId}
            </span>
          </p>
          <p>{WORKSPACE_ID_MESSAGES.hint}</p>
          <div className="account-actions">
            <button
              type="button"
              className="panel-action"
              aria-describedby={WORKSPACE_ID_LINE_ID}
              aria-disabled={running ? "true" : undefined}
              onClick={running ? undefined : () => copy.onCopy(workspaceId)}
            >
              {WORKSPACE_ID_MESSAGES.copy}
            </button>
          </div>
        </div>
      )}
      <p className="people-status" id={WORKSPACE_ID_MESSAGE_ID} role="status">
        {describeWorkspaceIdCopy(copy.view, workspaceId)}
      </p>
    </>
  );
}

/**
 * The copy of the workspace ID through the bridge, while the people screen
 * is shown; undefined without the bridge, so that the screen shows no part
 * of it. The logic is in `createWorkspaceIdCopy`.
 */
export function useWorkspaceIdCopy(
  bridge: Pick<WorkspaceBridge, "copyId"> | undefined,
): WorkspaceIdCopyControls | undefined {
  const [view, setView] = useState(IDLE_WORKSPACE_ID_COPY);
  const controller = useMemo(
    () =>
      bridge === undefined ? undefined : createWorkspaceIdCopy(bridge, setView),
    [bridge],
  );
  const onCopy = useCallback(
    (workspaceId: string) => {
      void controller?.copy(workspaceId);
    },
    [controller],
  );
  return controller === undefined ? undefined : { view, onCopy };
}
