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
  DEVICE_ACTION_MESSAGES,
  DEVICE_STATE_MESSAGES,
  removeDeviceMessage,
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

const OFFLINE_DETAILS: Readonly<Record<ConnectionOfflineReason, string>> = {
  not_signed_in: "Sign in with GitHub to connect.",
  no_api_origin: "This build has no server address.",
};

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

/** The text, the tone, and the actions of the connection indicator in the shell. */
export function describeConnectionView(
  view: ConnectionView,
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
        detail:
          status.reason === undefined ? null : OFFLINE_DETAILS[status.reason],
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
        actions:
          status.reason === "connection_replaced"
            ? REPLACED_ACTIONS
            : status.reason === "protocol_violation"
              ? RETRY_ACTIONS
              : NO_ACTIONS,
      };
    default:
      return { tone: status.state, label, detail: null, actions: NO_ACTIONS };
  }
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
 * person starts it from the account panel.
 */
export const REGISTER_AGAIN_MESSAGE =
  'This device was removed from its account, and its key was deleted. Choose "Sign in with GitHub" to register this computer again as a new device.';

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
  /** Passes the connection on: once it is connected, the message goes. */
  readonly connectionChanged: (view: ConnectionView) => void;
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
    connectionChanged: (view: ConnectionView) => {
      if (
        !running &&
        message !== undefined &&
        view.kind === "known" &&
        view.status.state === "connected"
      ) {
        message = undefined;
        show();
      }
    },
  });
}
