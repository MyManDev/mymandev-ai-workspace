import type {
  AccountStatus,
  ApiOriginState,
  DeviceKeyState,
  SignInOutcomeCode,
  SignInOutcomeView,
} from "../shared/ipc-contract.ts";

/** What the account panel knows about the sign-in of this installation. */
export type AccountView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first status. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly status: AccountStatus };

export function initialAccountView(bridgeAvailable: boolean): AccountView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/** The message for each outcome of a sign-in. */
export const SIGN_IN_OUTCOME_MESSAGES: Readonly<
  Record<SignInOutcomeCode, string>
> = Object.freeze({
  signed_in: "Signed in.",
  cancelled: "The sign-in was cancelled.",
  timed_out:
    "The sign-in was not finished within 10 minutes and has ended. Start it again.",
  access_denied: "The sign-in was declined in the browser.",
  sign_in_failed: "GitHub did not confirm the sign-in. Start it again.",
  unsupported_account:
    "This GitHub account cannot be used, because its login is not supported.",
  sign_in_unavailable:
    "Sign-in with GitHub is not available right now. Try again later.",
  auth_failed:
    "The server did not accept the sign-in, for example because it took too long. Start it again.",
  sign_in_required:
    "GitHub reported a change to this account's access during the sign-in. Start it again.",
  device_account_mismatch:
    "This installation belongs to another GitHub account. Sign in with that account.",
  device_revoked:
    "This device was removed from its account, and its key was deleted. Sign in again to add it as a new device.",
  device_registration_locked:
    "No new device can be added to this account right now, because one of its devices was reported lost. Lift the lock from another of your devices.",
  rate_limited:
    "This account has too many devices or new devices. Try again later.",
  refused: "The server refused the sign-in.",
  api_origin_unset:
    "Sign-in is not available in this build, because no server address is set.",
  api_origin_invalid:
    "Sign-in is not available in this build, because its server address is not valid.",
  unsupported_platform: "Sign-in is not available on this operating system.",
  key_not_loaded: "The device key is not loaded. Enter its passphrase first.",
  replacement_pending:
    "The device key of the last sign-in is not confirmed yet, so a new sign-in cannot start.",
  system_protection_unavailable:
    "The system cannot protect the device key. Make the system's key storage available, for example by unlocking the keychain, and try again.",
  key_store_failed: "The device key could not be created or changed.",
  record_unreadable:
    "The device record of this installation cannot be read, so the sign-in was stopped and the device key is kept.",
  listener_unavailable:
    "The sign-in could not start, because the application could not wait for the browser's answer.",
  no_answer:
    "The server did not answer. Check the connection and start the sign-in again.",
  server_error: "The server failed during the sign-in. Start it again.",
  unexpected_response:
    "The server's answer could not be read. Start the sign-in again.",
  record_not_saved:
    "The server accepted the sign-in, but this installation could not save it. Start the sign-in again.",
  failed: "The sign-in failed.",
});

export interface OutcomeMessage {
  /** `status` is announced politely; `alert` at once. */
  readonly role: "status" | "alert";
  readonly text: string;
}

/** The message for the last outcome; the installation's login after an account mismatch. */
export function describeOutcome(outcome: SignInOutcomeView): OutcomeMessage {
  const text =
    outcome.code === "device_account_mismatch" &&
    outcome.deviceLogin !== undefined
      ? `This installation belongs to the GitHub account ${outcome.deviceLogin}. Sign in with that account.`
      : SIGN_IN_OUTCOME_MESSAGES[outcome.code];
  return {
    role:
      outcome.code === "signed_in" || outcome.code === "cancelled"
        ? "status"
        : "alert",
    text,
  };
}

/** The message for a device key that cannot be used. */
export const DEVICE_KEY_PROBLEM_MESSAGES: Readonly<
  Record<
    Exclude<DeviceKeyState, "loading" | "ready" | "passphrase_required">,
    string
  >
> = Object.freeze({
  unreadable:
    "The system could not decrypt the device key. Restart the application to try again.",
  corrupt: "The device key file is damaged.",
  newer_format:
    "A newer version of the application stored the device key. Update the application to use it.",
  local_data_folder_missing:
    "The device key cannot be stored, because the local application data folder of this system is not set.",
  failed: "The device key could not be read.",
});

/** Why the sign-in button is disabled, for a build without a usable server address. */
export function apiOriginProblem(state: ApiOriginState): string | undefined {
  switch (state) {
    case "set":
      return undefined;
    case "unset":
      return SIGN_IN_OUTCOME_MESSAGES.api_origin_unset;
    case "invalid":
      return SIGN_IN_OUTCOME_MESSAGES.api_origin_invalid;
  }
}

/** The messages for an action of the panel that the main process refused. */
export const ACTION_MESSAGES = Object.freeze({
  startBusy: "A sign-in is already open.",
  keyNotReady: "The device key is not ready.",
  startFailed: "The sign-in could not start.",
  cancelFailed: "The sign-in could not be cancelled.",
  unlockNotRequired: "The device key does not need a passphrase now.",
  unlockBusy: "The device key is busy. Try again.",
  wrongPassphrase: "The passphrase does not open the device key.",
  passphraseInvalid:
    "The passphrase must be 1 to 1,024 characters of well-formed text.",
  unlockFailed: "The device key could not be unlocked.",
  forgetBusy: "Wait until the sign-in or the device key is finished.",
  notSignedIn: "This installation holds no account.",
  forgetFailed:
    "The account could not be removed from this installation. Try again.",
});
