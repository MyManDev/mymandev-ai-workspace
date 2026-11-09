import type { Dispatch } from "react";
import { PRODUCT_NAME } from "../shared/product.ts";
import { ACCOUNT_SCREEN_TITLE_ID } from "./AccountScreen.tsx";
import type { ShellAction } from "./screens.ts";
import {
  HOME_SIGN_IN_MESSAGES,
  type HomeSignIn,
  type HomeSignInStartView,
} from "./workspace-view.ts";

/**
 * Shows the account screen and then moves the focus to its title, because
 * the button that asked for it leaves the page with its own screen: "Go to
 * Account", and a sign-in started on the home screen (#219).
 */
export function showAccountScreen(
  dispatch: Dispatch<ShellAction>,
  focusAfterShow: (id: string) => void,
): void {
  focusAfterShow(ACCOUNT_SCREEN_TITLE_ID);
  dispatch({ type: "show-screen", screen: "account" });
}

/**
 * The home screen: a hint to open a project, and while no device is signed
 * in and ready, a fixed sentence about the sign-in and a way to the account
 * screen (`homeSignIn`). While the account panel offers a sign-in that can
 * start now, the screen offers "Sign in with GitHub" too (#219); the
 * sign-in then continues on the account screen.
 */
export function HomeScreen({
  signIn,
  start,
  onStartSignIn,
  dispatch,
  focusAfterShow,
}: {
  /** What the screen says about the sign-in (`homeSignIn`). */
  readonly signIn: HomeSignIn;
  /** The sign-in that the screen started (`createHomeSignInStart`). */
  readonly start: HomeSignInStartView;
  /** Starts the sign-in, and shows the account screen once it runs. */
  readonly onStartSignIn: () => void;
  readonly dispatch: Dispatch<ShellAction>;
  /**
   * Moves the focus to the element with this ID once the shell shows the
   * next view, because "Go to Account" leaves the page with this screen.
   */
  readonly focusAfterShow: (id: string) => void;
}) {
  return (
    <section aria-labelledby="home-title">
      <h2 id="home-title">Home</h2>
      <p>
        Open a project to see its chat, tasks, decisions, and permissions, and
        its agents and repositories.
      </p>
      {signIn === "none" ? null : (
        <>
          <p>{HOME_SIGN_IN_MESSAGES[signIn]}</p>
          <div className="account-actions">
            {signIn === "sign_in" ? (
              <button
                type="button"
                className="panel-action"
                disabled={start.running}
                onClick={onStartSignIn}
              >
                Sign in with GitHub
              </button>
            ) : null}
            <button
              type="button"
              className="panel-action"
              onClick={() => showAccountScreen(dispatch, focusAfterShow)}
            >
              Go to Account
            </button>
          </div>
          {start.message === undefined ? null : (
            <p className="panel-message" role="alert">
              {start.message}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function AboutScreen({
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
