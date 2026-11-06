import type { AccountBridge } from "../shared/desktop-bridge.ts";
import type {
  ConnectionOfflineReason,
  ConnectionState,
  ConnectionStatus,
  ConnectionStopReason,
  ConnectionWaitingReason,
  RemoveDeviceResult,
} from "../shared/ipc-contract.ts";
import {
  canStartSignIn,
  DEVICE_ACTION_MESSAGES,
  DEVICE_STATE_MESSAGES,
  deviceSignedIn,
  removeDeviceMessage,
  type AccountView,
} from "./account-view.ts";

/** What the renderer knows about the connection to the cloud API. */
export type ConnectionView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first status. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly status: ConnectionStatus };

export function initialConnectionView(
  bridgeAvailable: boolean,
): ConnectionView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

const STATE_LABELS: Readonly<Record<ConnectionState, string>> = {
  offline: "Offline",
  connecting: "Connecting",
  authenticating: "Authenticating",
  connected: "Connected",
  waiting: "Waiting to reconnect",
  stopped: "Stopped",
};

/**
 * The sentences of `offline`. The one of `not_signed_in` holds in every
 * case, also while the account panel offers no sign-in that can start now:
 * while a sign-in runs, a removal waits for the server, or the device key
 * is not ready. Otherwise `OFFLINE_SIGN_IN_DETAIL` replaces it.
 */
const OFFLINE_DETAILS: Readonly<Record<ConnectionOfflineReason, string>> = {
  not_signed_in: "This device connects once it is signed in and ready.",
  no_api_origin: "This build has no server address.",
};

/**
 * The sentence of `offline` with `not_signed_in` while the account panel
 * offers a GitHub sign-in that can start now (`canStartSignIn`), which
 * lives on the Account screen.
 */
export const OFFLINE_SIGN_IN_DETAIL =
  "Sign in with GitHub on the Account screen to connect.";

const WAITING_DETAILS: Readonly<Record<ConnectionWaitingReason, string>> = {
  connection_failed: "The server could not be reached.",
  connection_lost: "The connection was lost.",
  timeout: "The server did not answer in time.",
  server_error: "The server had an error.",
  server_busy: "The server is busy.",
  message_refused: "The server refused a message of this application.",
  invalid_message:
    "The server sent a message that this application does not accept.",
  signature_failed: "This device could not answer the server's challenge.",
  key_replaced: "The device key was replaced again.",
};

const STOP_DETAILS: Readonly<Record<ConnectionStopReason, string>> = {
  auth_failed:
    "The server did not accept the device key. Sign in with GitHub again.",
  device_revoked:
    "This device was removed from the account. Sign in with GitHub to add it again.",
  sign_in_required:
    "Sign in with GitHub on the Account screen to connect again.",
  connection_replaced:
    "Another installation connected with this device's key. The key is in use there. Reconnect here once, or remove this device and register this computer again as a new device.",
  protocol_violation:
    "The server refused this application's messages. Install an update if one is available.",
  update_required:
    "This version is too old for the server. Install the latest version.",
};

/**
 * The actions that the indicator offers: "Retry now" while waiting (and
 * after `protocol_violation`); "Reconnect here once" and "Remove this
 * device and register again" after another installation took over the
 * device's connection (ADR 0014, #95).
 */
export type ConnectionAction =
  "retry_now" | "reconnect_here" | "remove_and_register";

export const CONNECTION_ACTION_LABELS: Readonly<
  Record<ConnectionAction, string>
> = {
  retry_now: "Retry now",
  reconnect_here: "Reconnect here once",
  remove_and_register: "Remove this device and register again",
};

const NO_ACTIONS: readonly ConnectionAction[] = Object.freeze([]);
const RETRY_ACTIONS: readonly ConnectionAction[] = Object.freeze(["retry_now"]);
const REPLACED_ACTIONS: readonly ConnectionAction[] = Object.freeze([
  "reconnect_here",
  "remove_and_register",
]);

export interface ConnectionIndicator {
  /** The state for styling: a connection state, or "unknown". */
  readonly tone: ConnectionState | "unknown";
  readonly label: string;
  /** A fixed sentence about the reason, or null. */
  readonly detail: string | null;
  /** The actions in the order of their buttons; empty when there is none. */
  readonly actions: readonly ConnectionAction[];
}

/**
 * The text, the tone, and the actions of the connection indicator in the
 * shell. The account status decides what the connection status cannot:
 * whether `offline` with `not_signed_in` asks for a sign-in, and whether
 * the actions after `connection_replaced` are offered.
 */
export function describeConnectionView(
  view: ConnectionView,
  account: AccountView,
): ConnectionIndicator {
  switch (view.kind) {
    case "unavailable":
      return {
        tone: "unknown",
        label: "Cloud: Unavailable",
        detail: null,
        actions: NO_ACTIONS,
      };
    case "pending":
      return {
        tone: "unknown",
        label: "Cloud: Checking",
        detail: null,
        actions: NO_ACTIONS,
      };
    case "known":
      break;
  }
  const { status } = view;
  const label = `Cloud: ${STATE_LABELS[status.state]}`;
  switch (status.state) {
    case "offline":
      return {
        tone: status.state,
        label,
        detail: offlineDetail(status.reason, account),
        actions: NO_ACTIONS,
      };
    case "waiting":
      return {
        tone: status.state,
        label,
        detail: WAITING_DETAILS[status.reason],
        actions: RETRY_ACTIONS,
      };
    case "stopped":
      return {
        tone: status.state,
        label,
        detail: STOP_DETAILS[status.reason],
        actions: stopActions(status.reason, account),
      };
    default:
      return { tone: status.state, label, detail: null, actions: NO_ACTIONS };
  }
}

/**
 * The sentence of `offline`: the sign-in only while the account panel
 * offers one that can start now (`canStartSignIn`), so the header never
 * asks for a sign-in that the panel does not offer.
 */
function offlineDetail(
  reason: ConnectionOfflineReason | undefined,
  account: AccountView,
): string | null {
  if (reason === undefined) {
    return null;
  }
  return reason === "not_signed_in" &&
    account.kind === "known" &&
    canStartSignIn(account.status)
    ? OFFLINE_SIGN_IN_DETAIL
    : OFFLINE_DETAILS[reason];
}

/**
 * The actions after a stop. Those of `connection_replaced` hold for the
 * connection of the signed-in device only (`deviceSignedIn`): the client
 * ends that stop once no device is signed in any more (#215), and the
 * account status may show that first. Without a known account status,
 * nothing is offered.
 */
function stopActions(
  reason: ConnectionStopReason,
  account: AccountView,
): readonly ConnectionAction[] {
  switch (reason) {
    case "connection_replaced":
      return account.kind === "known" && deviceSignedIn(account.status)
        ? REPLACED_ACTIONS
        : NO_ACTIONS;
    case "protocol_violation":
      return RETRY_ACTIONS;
    default:
      return NO_ACTIONS;
  }
}

/**
 * The ID of the indicator's status paragraph. It takes the focus when the
 * focused button went away with its action (`focusesStatus`);
 * `tabIndex={-1}` lets it take the focus without putting it in the tab
 * order.
 */
export const CONNECTION_STATUS_TEXT_ID = "connection-status-text";

/**
 * Whether the focus moves to the indicator's status paragraph after its
 * actions changed: an action went away with its button, and the focus fell
 * to the page, as it does when the focused element is removed. For
 * example, once a removal is confirmed, the status becomes `offline` and
 * both buttons of `connection_replaced` go. A focus elsewhere stays where
 * it is.
 */
export function focusesStatus(
  before: readonly ConnectionAction[],
  after: readonly ConnectionAction[],
  focusOnPage: boolean,
): boolean {
  return focusOnPage && before.some((action) => !after.includes(action));
}

/**
 * What the indicator shows of "Remove this device and register again"
 * after `connection_replaced`.
 */
export interface DeviceRemovalView {
  /**
   * True while the main process asks the person to confirm in its native
   * dialog and removes the device.
   */
  readonly running: boolean;
  /** A fixed sentence about the last removal, or undefined. */
  readonly message: string | undefined;
}

export const IDLE_DEVICE_REMOVAL: DeviceRemovalView = Object.freeze({
  running: false,
  message: undefined,
});

/**
 * After the removal: the indicator never starts a sign-in on its own; the
 * person starts it from the account panel on the Account screen.
 */
export const REGISTER_AGAIN_MESSAGE =
  "This device was removed from its account, and its key was deleted. Sign in with GitHub on the Account screen to register this computer again as a new device.";

/**
 * The indicator's message after a removal: the way to register again after
 * `removed`, the device state's message while the removal waits for the
 * server, and the account panel's messages otherwise, none after a cancel.
 */
export function deviceRemovalMessage(
  result: RemoveDeviceResult,
): string | undefined {
  switch (result.outcome) {
    case "removed":
      return REGISTER_AGAIN_MESSAGE;
    case "pending":
      return DEVICE_STATE_MESSAGES.removal_pending;
    default:
      return removeDeviceMessage(result);
  }
}

export interface DeviceRemoval {
  /**
   * "Remove this device and register again": calls `removeDevice` once;
   * a click while a removal runs changes nothing. The main process asks
   * the person to confirm in its native dialog.
   */
  readonly remove: () => void;
  /**
   * Passes the account status on: once a GitHub sign-in runs, the message
   * of the last removal goes. Otherwise it stays until the next removal,
   * also when the device connects again after a refused removal.
   */
  readonly accountChanged: (view: AccountView) => void;
}

/**
 * The removal of the indicator, through the account bridge's existing
 * `removeDevice`; `onView` gets every change of what it shows.
 */
export function createDeviceRemoval(
  account: Pick<AccountBridge, "removeDevice">,
  onView: (view: DeviceRemovalView) => void,
): DeviceRemoval {
  let running = false;
  let message: string | undefined;
  const show = () => onView(Object.freeze({ running, message }));
  const finish = (next: string | undefined) => {
    running = false;
    message = next;
    show();
  };
  return Object.freeze({
    remove: () => {
      if (running) {
        return;
      }
      running = true;
      message = undefined;
      show();
      void account
        .removeDevice()
        .then(deviceRemovalMessage, () => DEVICE_ACTION_MESSAGES.removeFailed)
        .then(finish);
    },
    accountChanged: (view: AccountView) => {
      if (
        !running &&
        message !== undefined &&
        view.kind === "known" &&
        view.status.signIn.kind !== "idle"
      ) {
        message = undefined;
        show();
      }
    },
  });
}
