import { useReducer } from "react";
import { PRODUCT_NAME } from "../shared/product.ts";
import {
  createShellState,
  SCREENS,
  shellReducer,
  type ScreenId,
} from "./screens.ts";

export interface AppProps {
  /** The Electron version from the preload script; undefined outside Electron. */
  readonly electronVersion?: string | undefined;
  /** The screen shown first. */
  readonly initialScreen?: ScreenId;
}

export function App({ electronVersion, initialScreen = "home" }: AppProps) {
  const [state, dispatch] = useReducer(
    shellReducer,
    initialScreen,
    createShellState,
  );

  return (
    <div className="shell">
      <header className="shell-header">
        <h1>{PRODUCT_NAME}</h1>
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
