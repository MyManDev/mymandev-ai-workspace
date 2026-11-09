// What the account service passes on from the device session (session/;
// part 3 of #94) to the renderer: the device state as a fixed code and a
// failure of the session as a fixed code. Also the native confirmations of
// removing this device, of revoking another device of the account, and of
// lifting the registration lock (#95). The device list reaches the renderer
// through the device list service instead (devices/service.ts,
// device-ipc.ts).
//
// The session's states and failures may carry the account of the record
// and the API's code; only the fixed codes below reach the renderer. The
// session never hands over a token, a signature, or a key.
import type {
  ApiErrorCode,
  DeviceId,
  DevicePlatform,
} from "@mymandev/protocol";
import type {
  DeviceActionFailure,
  DeviceListActionFailure,
  DeviceState,
  OtherDeviceRevocation,
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

/**
 * The fixed code of a failure of a device action of the device list
 * (revoking another device, lifting the registration lock; #95), or
 * `unknown` when the answer does not show whether the API acted: no
 * answer, a `5xx`, or an answer that cannot be read. The revoke route's
 * `not_found` and `conflict` keep their codes; everything else maps as for
 * the other device actions (`deviceActionFailure`).
 */
export function deviceListActionFailure(
  failure: SessionFailure,
): DeviceListActionFailure | "unknown" {
  if (
    failure.reason === "refused" &&
    (failure.code === "not_found" || failure.code === "conflict")
  ) {
    return failure.code;
  }
  const code = deviceActionFailure(failure);
  switch (code) {
    case "no_answer":
    case "server_error":
    case "unexpected_response":
      return "unknown";
    default:
      return code;
  }
}

/**
 * Another device of the account, as the device list of the main process
 * names it (#95): what the native confirmation of a revocation shows.
 */
export interface OtherDevice {
  readonly id: DeviceId;
  /** Text that a person entered; the dialog shows it as plain text. */
  readonly label: string;
  readonly platform: DevicePlatform;
}

/** The name of each platform in the native dialogs. */
const PLATFORM_NAMES: Readonly<Record<DevicePlatform, string>> = Object.freeze({
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
});

/**
 * The native confirmations of revoking another device of the account (#95;
 * ADR 0014, "Revocation, sign-out, and recovery"), one for each reason: a
 * warning with the revoke button first and "Keep" as the default and the
 * cancel button, like "Remove this device". Only the revocation as lost
 * starts the 7-day registration lock, and its detail says so before the
 * person confirms. `revokeDeviceConfirmed` reads the answer.
 */
export const REVOKE_DEVICE_CONFIRMATIONS = Object.freeze({
  removed: Object.freeze({
    type: "warning",
    buttons: Object.freeze(["Remove the device", "Keep"] as const),
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "Remove a device",
    detail:
      "The server revokes the device at once: it can no longer connect, the agents that it hosts are disabled, and their unfinished runs are cancelled. A revoked device never comes back; that computer can sign in with GitHub again as a new device. No registration lock starts.",
  } as const),
  lost: Object.freeze({
    type: "warning",
    buttons: Object.freeze(["Revoke as lost", "Keep"] as const),
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "Revoke a lost device",
    detail:
      "The server revokes the device at once: it can no longer connect, the agents that it hosts are disabled, and their unfinished runs are cancelled. This starts a 7-day registration lock: for 7 days no new device can register on this account, unless you lift the lock on one of your active devices. Devices that are registered already can still sign in.",
  } as const),
} satisfies Record<OtherDeviceRevocation, unknown>);

/**
 * The message of the confirmation: the device's label and platform, and the
 * login of the account.
 */
export function revokeDeviceConfirmationMessage(
  login: string,
  device: Pick<OtherDevice, "label" | "platform">,
  reason: OtherDeviceRevocation,
): string {
  const named = `"${device.label}" (${PLATFORM_NAMES[device.platform]})`;
  return reason === "lost"
    ? `Revoke the device ${named} of the GitHub account ${login} as lost?`
    : `Remove the device ${named} from the GitHub account ${login}?`;
}

/** Whether the person chose the revoke button of a revocation's confirmation. */
export function revokeDeviceConfirmed(result: {
  readonly response: number;
}): boolean {
  return result.response === 0;
}

/**
 * The native confirmation of lifting the registration lock (#95, D5b): a
 * warning with the lift button first and "Keep" as the default and the
 * cancel button. `liftRegistrationLockConfirmed` reads the answer.
 */
export const LIFT_REGISTRATION_LOCK_CONFIRMATION = Object.freeze({
  type: "warning",
  buttons: Object.freeze(["Lift the lock", "Keep"] as const),
  defaultId: 1,
  cancelId: 1,
  noLink: true,
  title: "Lift the registration lock",
  detail:
    "New devices can then register on this account again at once. The lock protects the account after a device was lost: lift it only when you are about to register a new device yourself.",
} as const);

/** The message of the confirmation, with the login of the account. */
export function liftRegistrationLockConfirmationMessage(login: string): string {
  return `Lift the registration lock of the GitHub account ${login}?`;
}

/** Whether the person chose the lift button of `LIFT_REGISTRATION_LOCK_CONFIRMATION`. */
export function liftRegistrationLockConfirmed(result: {
  readonly response: number;
}): boolean {
  return result.response === 0;
}
