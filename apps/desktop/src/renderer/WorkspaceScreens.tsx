import type { AccountBridge } from "../shared/desktop-bridge.ts";
import { PRODUCT_NAME } from "../shared/product.ts";
import { AccountPanel } from "./AccountPanel.tsx";

export function HomeScreen({
  account,
}: {
  /** The account functions from the preload script; undefined outside Electron. */
  readonly account?: AccountBridge | undefined;
}) {
  return (
    <section aria-labelledby="home-title">
      <h2 id="home-title">Home</h2>
      <p>
        Open a project to see its chat, tasks, decisions, and permissions, and
        its agents and repositories.
      </p>
      <AccountPanel account={account} />
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
