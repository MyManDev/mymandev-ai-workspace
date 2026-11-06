import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type Dispatch,
} from "react";
import type {
  AccountBridge,
  AgentBridge,
  ConnectionBridge,
  RepositoryBridge,
  RuntimeBridge,
  WorkspaceBridge,
} from "../shared/desktop-bridge.ts";
import type { WorkspaceView } from "../shared/ipc-contract.ts";
import { PRODUCT_NAME } from "../shared/product.ts";
import {
  CONNECTION_ACTION_LABELS,
  describeConnectionView,
  initialConnectionView,
  type ConnectionView,
} from "./connection-status.ts";
import {
  ProjectNav,
  WorkspaceNav,
  type WorkspaceSidebar,
} from "./Navigation.tsx";
import { ProjectPanel } from "./ProjectPanel.tsx";
import {
  ChatScreen,
  DecisionsScreen,
  PermissionsScreen,
  TasksScreen,
} from "./ProjectScreens.tsx";
import {
  describeRuntimeView,
  initialRuntimeView,
  type RuntimeView,
} from "./runtime-status.ts";
import {
  createShellState,
  HOME_VIEW,
  isProjectView,
  openProject,
  shellReducer,
  type ShellAction,
  type ShellView,
} from "./screens.ts";
import {
  createWorkspaceSidebar,
  initialWorkspacePanelView,
} from "./workspace-view.ts";
import { AboutScreen, HomeScreen } from "./WorkspaceScreens.tsx";

export interface AppProps {
  /** The Electron version from the preload script; undefined outside Electron. */
  readonly electronVersion?: string | undefined;
  /** The local runtime from the preload script; undefined outside Electron. */
  readonly runtime?: RuntimeBridge | undefined;
  /** The mounted repositories from the preload script; undefined outside Electron. */
  readonly repositories?: RepositoryBridge | undefined;
  /** The sign-in of this installation from the preload script; undefined outside Electron. */
  readonly account?: AccountBridge | undefined;
  /** The connection to the cloud API from the preload script; undefined outside Electron. */
  readonly connection?: ConnectionBridge | undefined;
  /** The account's workspaces from the preload script; undefined outside Electron. */
  readonly workspaces?: WorkspaceBridge | undefined;
  /** The open project's agent activity from the preload script; undefined outside Electron. */
  readonly agents?: AgentBridge | undefined;
  /**
   * The workspace state shown until the bridge delivers one, for tests and
   * previews. Without it, the shell starts without projects.
   */
  readonly initialWorkspaceState?: WorkspaceView | undefined;
  /** The view shown first. An invalid view shows the home screen. */
  readonly initialView?: ShellView;
}

export function App({
  electronVersion,
  runtime,
  repositories,
  account,
  connection,
  workspaces,
  agents,
  initialWorkspaceState,
  initialView = HOME_VIEW,
}: AppProps) {
  const [state, dispatch] = useReducer(shellReducer, initialView, (view) =>
    createShellState(initialWorkspaceState?.projects ?? [], view),
  );
  const workspaceSidebar = useWorkspaces(
    workspaces,
    initialWorkspaceState,
    dispatch,
    isProjectView(state.view) ? state.view.projectId : null,
  );
  const runtimeView = useRuntimeView(runtime);
  const connectionView = useConnectionView(connection);
  const open = openProject(state);

  return (
    <div className={open === undefined ? "shell" : "shell shell-project"}>
      <header className="shell-header">
        <h1>{PRODUCT_NAME}</h1>
        <div className="shell-status">
          <ConnectionStatusIndicator
            view={connectionView}
            onReconnect={
              connection === undefined
                ? undefined
                : () => {
                    // The status shows what follows; a refusal changes nothing.
                    connection.reconnect().catch(() => undefined);
                  }
            }
          />
          <RuntimeStatusIndicator view={runtimeView} />
        </div>
      </header>
      <WorkspaceNav
        state={state}
        dispatch={dispatch}
        workspaces={workspaceSidebar}
      />
      {open === undefined ? null : (
        <ProjectNav
          project={open.project}
          screen={open.view.screen}
          dispatch={dispatch}
        />
      )}
      <main className="shell-main">
        <ScreenContent
          view={state.view}
          electronVersion={electronVersion}
          account={account}
        />
      </main>
      {open === undefined ? null : (
        <ProjectPanel
          panel={open.view.panel}
          projectId={open.project.id}
          dispatch={dispatch}
          agents={agents}
          repositories={repositories}
        />
      )}
    </div>
  );
}

function ScreenContent({
  view,
  electronVersion,
  account,
}: {
  readonly view: ShellView;
  readonly electronVersion: string | undefined;
  readonly account: AccountBridge | undefined;
}) {
  switch (view.screen) {
    case "home":
      return <HomeScreen account={account} />;
    case "about":
      return <AboutScreen electronVersion={electronVersion} />;
    case "chat":
      return <ChatScreen />;
    case "tasks":
      return <TasksScreen />;
    case "decisions":
      return <DecisionsScreen />;
    case "permissions":
      return <PermissionsScreen />;
  }
}

/**
 * Follows the workspace state while the shell is mounted, reports the open
 * project to the main process at the start and after every change, and
 * switches workspaces. The logic is in `createWorkspaceSidebar`.
 */
function useWorkspaces(
  workspaces: WorkspaceBridge | undefined,
  initialState: WorkspaceView | undefined,
  dispatch: Dispatch<ShellAction>,
  openProjectId: string | null,
): WorkspaceSidebar {
  const [view, setView] = useState(() =>
    initialState === undefined
      ? initialWorkspacePanelView(workspaces !== undefined)
      : { kind: "known" as const, state: initialState },
  );
  const [message, setMessage] = useState<string | undefined>(undefined);
  const controller = useMemo(
    () =>
      workspaces === undefined
        ? undefined
        : createWorkspaceSidebar(workspaces, dispatch, setView, setMessage),
    [workspaces, dispatch],
  );

  useEffect(() => controller?.start(), [controller]);
  useEffect(
    () => controller?.openProjectChanged(openProjectId),
    [controller, openProjectId],
  );
  const onSelect = useCallback(
    (workspaceId: string) => controller?.select(workspaceId),
    [controller],
  );

  return { view, message, onSelect };
}

/** Follows the status of the local runtime while the shell is mounted. */
function useRuntimeView(runtime: RuntimeBridge | undefined): RuntimeView {
  const [view, setView] = useState(() =>
    initialRuntimeView(runtime !== undefined),
  );
  useEffect(() => {
    if (runtime === undefined) {
      return undefined;
    }
    return runtime.subscribeStatus(
      (status) => setView({ kind: "known", status }),
      () => setView({ kind: "unavailable" }),
    );
  }, [runtime]);
  return view;
}

export function RuntimeStatusIndicator({
  view,
}: {
  readonly view: RuntimeView;
}) {
  const { tone, label } = describeRuntimeView(view);
  return (
    <p className="runtime-status" role="status" data-state={tone}>
      <span className="runtime-status-dot" aria-hidden="true" />
      {label}
    </p>
  );
}

/** Follows the status of the connection to the cloud API while the shell is mounted. */
function useConnectionView(
  connection: ConnectionBridge | undefined,
): ConnectionView {
  const [view, setView] = useState(() =>
    initialConnectionView(connection !== undefined),
  );
  useEffect(() => {
    if (connection === undefined) {
      return undefined;
    }
    return connection.subscribeStatus(
      (status) => setView({ kind: "known", status }),
      () => setView({ kind: "unavailable" }),
    );
  }, [connection]);
  return view;
}

/**
 * The connection status in the header: the state, a fixed sentence about
 * the reason, and "Retry now" or "Reconnect here once" where the person can
 * act. A sign-in starts only from the account panel, on the person's click.
 */
export function ConnectionStatusIndicator({
  view,
  onReconnect,
}: {
  readonly view: ConnectionView;
  readonly onReconnect?: (() => void) | undefined;
}) {
  const { tone, label, detail, action } = describeConnectionView(view);
  return (
    <div className="connection-status" data-state={tone}>
      <p className="connection-status-text" role="status">
        <span className="connection-status-dot" aria-hidden="true" />
        {label}
        {detail === null ? null : (
          <span className="connection-status-detail">{detail}</span>
        )}
      </p>
      {action === null || onReconnect === undefined ? null : (
        <button type="button" onClick={onReconnect}>
          {CONNECTION_ACTION_LABELS[action]}
        </button>
      )}
    </div>
  );
}
