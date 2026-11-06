import type { Dispatch } from "react";
import { PRODUCT_NAME } from "../shared/product.ts";
import { ACCOUNT_SCREEN_TITLE_ID } from "./AccountScreen.tsx";
import type { ShellAction } from "./screens.ts";
import { HOME_SIGN_IN_MESSAGES, type HomeSignIn } from "./workspace-view.ts";

/**
 * The home screen: a hint to open a project, and while no device is signed
 * in and ready, a fixed sentence about the sign-in and a way to the account
 * screen, where the person signs in (`homeSignIn`).
 */
export function HomeScreen({
  signIn,
  dispatch,
  focusAfterShow,
}: {
  /** What the screen says about the sign-in (`homeSignIn`). */
  readonly signIn: HomeSignIn;
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
          <p>
            <button
              type="button"
              className="panel-action"
              onClick={() => {
                focusAfterShow(ACCOUNT_SCREEN_TITLE_ID);
                dispatch({ type: "show-screen", screen: "account" });
              }}
            >
              Go to Account
            </button>
          </p>
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
