import type { Dispatch } from "react";
import { PRODUCT_NAME } from "../shared/product.ts";
import { ACCOUNT_SCREEN_TITLE_ID } from "./AccountScreen.tsx";
import {
  CreateStatus,
  HOME_TITLE_ID,
  HomeCreateWorkspace,
  type CreationControls,
} from "./Creation.tsx";
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
 * sign-in then continues on the account screen. While its start runs, the
 * button stays focusable and does nothing (`aria-disabled`), like the
 * buttons of the connection indicator, so that the focus stays on it when
 * the start is refused or fails.
 *
 * While a device is signed in and the account has no workspace, the screen
 * offers to create one with a name field (#95, D7), and its status
 * paragraph says how the last create there went. The form leaves the page
 * once the new workspace is listed, so the title takes the focus without a
 * tab stop (`tabIndex={-1}`).
 */
export function HomeScreen({
  signIn,
  start,
  onStartSignIn,
  dispatch,
  focusAfterShow,
  creation,
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
  /** The creates; undefined without the bridge. */
  readonly creation?: CreationControls | undefined;
}) {
  return (
    <section aria-labelledby={HOME_TITLE_ID}>
      <h2 id={HOME_TITLE_ID} tabIndex={-1}>
        Home
      </h2>
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
                aria-disabled={start.running ? "true" : undefined}
                onClick={start.running ? undefined : onStartSignIn}
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
      {creation === undefined ? null : (
        <>
          {creation.offer.home ? (
            <HomeCreateWorkspace
              draft={creation.view.homeDraft}
              problem={creation.view.homeProblem}
              running={creation.view.running}
              onDraft={creation.onHomeDraft}
              onCreate={creation.onCreateFromHome}
            />
          ) : null}
          <CreateStatus
            place="home"
            message={creation.view.message}
            className="account-message"
          />
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
