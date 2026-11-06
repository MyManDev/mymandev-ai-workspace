import type {
  ConnectionOfflineReason,
  ConnectionState,
  ConnectionStatus,
  ConnectionStopReason,
  ConnectionWaitingReason,
} from "../shared/ipc-contract.ts";

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
    "Another installation connected with this device's key. The key is in use there.",
  protocol_violation:
    "The server refused this application's messages. Install an update if one is available.",
  update_required:
    "This version is too old for the server. Install the latest version.",
};

/**
 * The action that the indicator offers: "Retry now" while waiting (and
 * after `protocol_violation`), "Reconnect here once" after another
 * installation took over the device's connection.
 */
export type ConnectionAction = "retry_now" | "reconnect_here";

export const CONNECTION_ACTION_LABELS: Readonly<
  Record<ConnectionAction, string>
> = {
  retry_now: "Retry now",
  reconnect_here: "Reconnect here once",
};

export interface ConnectionIndicator {
  /** The state for styling: a connection state, or "unknown". */
  readonly tone: ConnectionState | "unknown";
  readonly label: string;
  /** A fixed sentence about the reason, or null. */
  readonly detail: string | null;
  readonly action: ConnectionAction | null;
}

/** The text, the tone, and the action of the connection indicator in the shell. */
export function describeConnectionView(
  view: ConnectionView,
): ConnectionIndicator {
  switch (view.kind) {
    case "unavailable":
      return {
        tone: "unknown",
        label: "Cloud: Unavailable",
        detail: null,
        action: null,
      };
    case "pending":
      return {
        tone: "unknown",
        label: "Cloud: Checking",
        detail: null,
        action: null,
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
        action: null,
      };
    case "waiting":
      return {
        tone: status.state,
        label,
        detail: WAITING_DETAILS[status.reason],
        action: "retry_now",
      };
    case "stopped":
      return {
        tone: status.state,
        label,
        detail: STOP_DETAILS[status.reason],
        action:
          status.reason === "connection_replaced"
            ? "reconnect_here"
            : status.reason === "protocol_violation"
              ? "retry_now"
              : null,
      };
    default:
      return { tone: status.state, label, detail: null, action: null };
  }
}
