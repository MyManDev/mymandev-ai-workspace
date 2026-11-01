import { useEffect, useReducer, useState } from "react";
import type {
  RepositoryBridge,
  RuntimeBridge,
} from "../shared/desktop-bridge.ts";
import { PRODUCT_NAME } from "../shared/product.ts";
import { ProjectNav, WorkspaceNav } from "./Navigation.tsx";
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
  openProject,
  shellReducer,
  type ProjectSummary,
  type ShellView,
} from "./screens.ts";
import { AboutScreen, HomeScreen } from "./WorkspaceScreens.tsx";

export interface AppProps {
  /** The Electron version from the preload script; undefined outside Electron. */
  readonly electronVersion?: string | undefined;
  /** The local runtime from the preload script; undefined outside Electron. */
  readonly runtime?: RuntimeBridge | undefined;
  /** The mounted repositories from the preload script; undefined outside Electron. */
  readonly repositories?: RepositoryBridge | undefined;
  /** The workspace's projects, in navigation order, read when the shell mounts. */
  readonly projects: readonly ProjectSummary[];
  /** The view shown first. An invalid view shows the home screen. */
  readonly initialView?: ShellView;
}

export function App({
  electronVersion,
  runtime,
  repositories,
  projects,
  initialView = HOME_VIEW,
}: AppProps) {
  const [state, dispatch] = useReducer(shellReducer, initialView, (view) =>
    createShellState(projects, view),
  );
  const runtimeView = useRuntimeView(runtime);
  const open = openProject(state);

  return (
    <div className={open === undefined ? "shell" : "shell shell-project"}>
      <header className="shell-header">
        <h1>{PRODUCT_NAME}</h1>
        <RuntimeStatusIndicator view={runtimeView} />
      </header>
      <WorkspaceNav state={state} dispatch={dispatch} />
      {open === undefined ? null : (
        <ProjectNav
          project={open.project}
          screen={open.view.screen}
          dispatch={dispatch}
        />
      )}
      <main className="shell-main">
        <ScreenContent view={state.view} electronVersion={electronVersion} />
      </main>
      {open === undefined ? null : (
        <ProjectPanel
          panel={open.view.panel}
          dispatch={dispatch}
          repositories={repositories}
        />
      )}
    </div>
  );
}

function ScreenContent({
  view,
  electronVersion,
}: {
  readonly view: ShellView;
  readonly electronVersion: string | undefined;
}) {
  switch (view.screen) {
    case "home":
      return <HomeScreen />;
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
