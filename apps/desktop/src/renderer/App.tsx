import { useEffect, useReducer, useState } from "react";
import type { RuntimeBridge } from "../shared/desktop-bridge.ts";
import { PRODUCT_NAME } from "../shared/product.ts";
import {
  describeRuntimeView,
  initialRuntimeView,
  type RuntimeView,
} from "./runtime-status.ts";
import {
  createShellState,
  SCREENS,
  shellReducer,
  type ScreenId,
} from "./screens.ts";

export interface AppProps {
  /** The Electron version from the preload script; undefined outside Electron. */
  readonly electronVersion?: string | undefined;
  /** The local runtime from the preload script; undefined outside Electron. */
  readonly runtime?: RuntimeBridge | undefined;
  /** The screen shown first. */
  readonly initialScreen?: ScreenId;
}

export function App({
  electronVersion,
  runtime,
  initialScreen = "home",
}: AppProps) {
  const [state, dispatch] = useReducer(
    shellReducer,
    initialScreen,
    createShellState,
  );
  const runtimeView = useRuntimeView(runtime);

  return (
    <div className="shell">
      <header className="shell-header">
        <h1>{PRODUCT_NAME}</h1>
        <RuntimeStatusIndicator view={runtimeView} />
      </header>
      <nav className="shell-nav" aria-label="Screens">
        <ul>
          {SCREENS.map((screen) => (
            <li key={screen.id}>
              <button
                type="button"
                aria-current={screen.id === state.screen ? "page" : undefined}
                onClick={() =>
                  dispatch({ type: "show-screen", screen: screen.id })
                }
              >
                {screen.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="shell-main">
        {state.screen === "home" ? (
          <HomeScreen />
        ) : (
          <AboutScreen electronVersion={electronVersion} />
        )}
      </main>
    </div>
  );
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

function HomeScreen() {
  return (
    <section aria-labelledby="home-title">
      <h2 id="home-title">Home</h2>
      <p>Projects, chat, agents, and repositories will appear here.</p>
    </section>
  );
}

function AboutScreen({
  electronVersion,
}: {
  readonly electronVersion: string | undefined;
}) {
  return (
    <section aria-labelledby="about-title">
      <h2 id="about-title">About</h2>
      <p>{PRODUCT_NAME}</p>
      <p>
        {electronVersion === undefined
          ? "Electron version unknown"
          : `Electron ${electronVersion}`}
      </p>
    </section>
  );
}
