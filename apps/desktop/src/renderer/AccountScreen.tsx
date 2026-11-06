import type { AccountBridge } from "../shared/desktop-bridge.ts";
import { AccountPanel } from "./AccountPanel.tsx";

/**
 * The account screen: the sign-in of this installation and its device,
 * through the account panel. The device list, the sign-in renewal, and the
 * other account screens of #95 follow here.
 */
export function AccountScreen({
  account,
}: {
  /** The account functions from the preload script; undefined outside Electron. */
  readonly account?: AccountBridge | undefined;
}) {
  return (
    <section aria-labelledby="account-screen-title">
      <h2 id="account-screen-title">Account</h2>
      <p>
        Sign in this device with GitHub, and manage the device and its sign-in.
      </p>
      <AccountPanel account={account} />
    </section>
  );
}
