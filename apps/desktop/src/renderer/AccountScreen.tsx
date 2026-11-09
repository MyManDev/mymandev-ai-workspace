import type {
  AccountBridge,
  DeviceListBridge,
} from "../shared/desktop-bridge.ts";
import { AccountPanel } from "./AccountPanel.tsx";
import { DevicesSection } from "./DevicesSection.tsx";

/**
 * The ID of the account screen's title. "Go to Account" on the home screen
 * moves the focus there, because the button leaves the page with the home
 * screen; `tabIndex={-1}` lets the title take the focus without putting it
 * in the tab order.
 */
export const ACCOUNT_SCREEN_TITLE_ID = "account-screen-title";

/**
 * The account screen: the sign-in of this installation and its device,
 * through the account panel, and the account's devices beside it. The
 * device actions, the sign-in renewal, and the other account screens of #95
 * follow here.
 */
export function AccountScreen({
  account,
  devices,
}: {
  /** The account functions from the preload script; undefined outside Electron. */
  readonly account?: AccountBridge | undefined;
  /** The device list functions from the preload script; undefined outside Electron. */
  readonly devices?: DeviceListBridge | undefined;
}) {
  return (
    <section aria-labelledby={ACCOUNT_SCREEN_TITLE_ID}>
      <h2 id={ACCOUNT_SCREEN_TITLE_ID} tabIndex={-1}>
        Account
      </h2>
      <p>
        Sign in this device with GitHub, manage the device and its sign-in, and
        see every device of the account.
      </p>
      <AccountPanel account={account} />
      <DevicesSection devices={devices} />
    </section>
  );
}
