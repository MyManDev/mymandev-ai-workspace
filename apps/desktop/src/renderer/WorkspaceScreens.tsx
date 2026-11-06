import type { Dispatch } from "react";
import { PRODUCT_NAME } from "../shared/product.ts";
import type { ShellAction } from "./screens.ts";

/**
 * The home screen: a hint to open a project, and while no device is signed
 * in and ready, a way to the account screen, where the person signs in.
 */
export function HomeScreen({
  signedOut,
  dispatch,
}: {
  /** True while no device is signed in and ready (`noDeviceSignedIn`). */
  readonly signedOut: boolean;
  readonly dispatch: Dispatch<ShellAction>;
}) {
  return (
    <section aria-labelledby="home-title">
      <h2 id="home-title">Home</h2>
      <p>
        Open a project to see its chat, tasks, decisions, and permissions, and
        its agents and repositories.
      </p>
      {signedOut ? (
        <>
          <p>
            Sign in with GitHub on the Account screen to see your workspaces.
          </p>
          <p>
            <button
              type="button"
              className="panel-action"
              onClick={() =>
                dispatch({ type: "show-screen", screen: "account" })
              }
            >
              Go to Account
            </button>
          </p>
        </>
      ) : null}
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
