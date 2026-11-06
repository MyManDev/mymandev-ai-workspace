// What the account service passes on from the device session (session/;
// part 3 of #94) to the renderer: the device state as a fixed code, a
// failure of the session as a fixed code, and the device list without
// anything secret. Also the native confirmation of removing this device.
//
// The session's states and failures may carry the account of the record
// and the API's code; only the fixed codes below reach the renderer. The
// session never hands over a token, a signature, or a key.
import type { ApiErrorCode, DeviceListItem } from "@mymandev/protocol";
import type {
  DeviceActionFailure,
  DeviceState,
  DeviceView,
} from "../shared/ipc-contract.ts";
import type { DeviceSessionState, SessionFailure } from "./session/session.ts";

/** The device state code of each state of the device session. */
export function deviceStateOf(state: DeviceSessionState): DeviceState {
  switch (state.kind) {
    case "signed_out":
      return state.reportPending ? "sign_out_report_pending" : "signed_out";
    case "starting":
    case "no_device":
    case "key_lost":
    case "unavailable":
    case "key_not_loaded":
    case "signed_in":
    case "sign_in_required":
    case "auth_failed":
    case "account_mismatch":
    case "removal_pending":
    case "removed":
    case "revoked":
      return state.kind;
    default:
      // A state that a later session adds.
      return "unavailable";
  }
}

/**
 * Whether the person signed out on this device (P-65): `signed_out`, and
 * the states that come before it while a sign-out marker exists (#195).
 */
export function signedOutOf(state: DeviceSessionState): boolean {
  return (
    state.kind === "signed_out" ||
    ("signedOut" in state && state.signedOut === true)
  );
}

/** The API's codes that the screens explain on their own. */
const API_CODES: Readonly<Partial<Record<ApiErrorCode, DeviceActionFailure>>> =
  Object.freeze({
    sign_in_required: "sign_in_required",
    auth_failed: "auth_failed",
    device_revoked: "device_revoked",
    device_account_mismatch: "device_account_mismatch",
    rate_limited: "rate_limited",
  });

/**
 * The fixed code of a failure of the device session. Its reasons map one to
 * one, except `invalid_request`, which cannot happen for the actions of the
 * account service and is `failed`; a refusal maps to the API's code when the
 * screens explain it, and to `refused` otherwise.
 */
export function deviceActionFailure(
  failure: SessionFailure,
): DeviceActionFailure {
  switch (failure.reason) {
    case "refused": {
      const code = failure.code;
      return code !== undefined && Object.hasOwn(API_CODES, code)
        ? (API_CODES[code] ?? "refused")
        : "refused";
    }
    case "api_origin_unset":
    case "api_origin_invalid":
    case "no_device":
    case "key_lost":
    case "key_not_loaded":
    case "record_unreadable":
    case "key_store_failed":
    case "signed_out":
    case "sign_in_running":
    case "replacement_pending":
    case "removal_pending":
    case "record_not_saved":
    case "no_answer":
    case "server_error":
    case "unexpected_response":
      return failure.reason;
    default:
      // `invalid_request`, or a reason that a later session adds.
      return "failed";
  }
}

/**
 * One device of the list as the renderer may see it: its ID, label,
 * platform, when it was last seen, when its sign-in ends, when it was
 * revoked, and whether it is the device that asked. A field that the
 * protocol adds later does not reach the renderer.
 */
export function deviceViewOf(item: DeviceListItem): DeviceView {
  return Object.freeze({
    id: item.id,
    label: item.label,
    platform: item.platform,
    lastSeenAt: item.lastSeenAt,
    signInExpiresAt: item.signInExpiresAt,
    revokedAt: item.revokedAt,
    current: item.current,
  });
}

/**
 * The native confirmation of removing this device (ADR 0014, "Revocation,
 * sign-out, and recovery"): a warning with the remove button first and
 * "Keep" as the default and the cancel button, like "This is not me".
 * `removeDeviceConfirmed` reads its answer.
 */
export const REMOVE_DEVICE_CONFIRMATION = Object.freeze({
  type: "warning",
  buttons: Object.freeze(["Remove this device", "Keep"] as const),
  defaultId: 1,
  cancelId: 1,
  noLink: true,
  title: "Remove this device",
  detail:
    "The device is removed from the account, and its device key is deleted on this computer once the server confirms. While offline, the removal waits. Sign in with GitHub again to add this computer as a new device.",
} as const);

/** The message of the confirmation, with the login of the account. */
export function removeDeviceConfirmationMessage(login: string): string {
  return `Remove this device from the GitHub account ${login}?`;
}

/** Whether the person chose the remove button of `REMOVE_DEVICE_CONFIRMATION`. */
export function removeDeviceConfirmed(result: {
  readonly response: number;
}): boolean {
  return result.response === 0;
}
