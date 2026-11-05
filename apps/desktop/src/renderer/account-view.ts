import type { AccountBridge } from "../shared/desktop-bridge.ts";
import type {
  AccountStatus,
  ApiOriginState,
  StartSignInResult,
  DeviceActionFailure,
  DeviceKeyState,
  DeviceState,
  DeviceView,
  ForgetResult,
  ListDevicesResult,
  RemoveDeviceResult,
  SignInOutcomeCode,
  SignInOutcomeView,
  SignOutResult,
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
  sign_in_required:
    "GitHub reported a change to this account's access during the sign-in. Start it again.",
  device_account_mismatch:
    "This installation belongs to another GitHub account. Sign in with that account.",
  device_revoked:
    "This device was removed from its account, and its key was deleted. Sign in again to add it as a new device.",
  device_registration_locked:
    "No new device can be added to this account right now, because one of its devices was reported lost. Lift the lock from another of your devices.",
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
    "The system cannot protect the device key, so the sign-in did not start. On Windows and macOS, make the system's key storage available, for example by unlocking the keychain. On Linux, a secret service such as GNOME Keyring or KDE Wallet is needed for now.",
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
  uncertain_refusal:
    "The server's answer does not show whether the sign-in was completed. It is safe to start it again.",
  key_changed:
    "The device key changed during the sign-in, so it was stopped. Start it again.",
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
  startFailed: "The sign-in could not start.",
  cancelFailed: "The sign-in could not be cancelled.",
  unlockNotRequired: "The device key does not need a passphrase now.",
  unlockBusy: "The device key is busy. Try again.",
  wrongPassphrase: "The passphrase does not open the device key.",
  unlockTooSoon:
    "Wait a few seconds after a wrong passphrase before you try again.",
  passphraseInvalid:
    "The passphrase must be 1 to 1,024 characters of well-formed text.",
  unlockFailed: "The device key could not be unlocked.",
  forgetBusy: "Wait until the sign-in or the device key is finished.",
  notSignedIn: "This installation holds no account.",
  forgetFailed:
    "The account could not be removed from this installation. Try again.",
});

/** The message for a sign-in that the main process did not start. */
export const START_REFUSAL_MESSAGES: Readonly<
  Record<Extract<StartSignInResult, { outcome: "refused" }>["reason"], string>
> = Object.freeze({
  busy: "A sign-in is already open.",
  key_not_ready: "The device key is not ready.",
  too_soon: "Wait a few seconds before you start the sign-in again.",
});

/**
 * The message for each state of the device, or none where the panel shows
 * the state otherwise (signed in, no device yet, or the passphrase form).
 */
export const DEVICE_STATE_MESSAGES: Readonly<
  Record<DeviceState, string | undefined>
> = Object.freeze({
  starting: "Checking this device.",
  no_device: undefined,
  signed_in: undefined,
  signed_out:
    "You signed out on this device. Sign in with GitHub to use it again.",
  sign_out_report_pending:
    "You signed out on this device. The server learns it as soon as it can be reached.",
  sign_in_required: "The server asks for a new GitHub sign-in on this device.",
  auth_failed:
    "The server did not accept this device's key. Sign in with GitHub again.",
  account_mismatch:
    "This installation belongs to another GitHub account. Sign in with that account, then remove this device so that another account can use it.",
  key_lost:
    "This device's key is missing. Sign in with GitHub to add this computer as a new device, which replaces the old one.",
  key_not_loaded: undefined,
  unavailable:
    "The device record or the device key of this installation cannot be read.",
  removal_pending:
    "The removal of this device waits for the server. It is tried again when the application starts, or when you remove the device again.",
  removed:
    "This device was removed from its account, and its key was deleted. Sign in with GitHub to add it again as a new device.",
  revoked:
    "The server revoked this device, for example because it was removed from another device, and its key was deleted. Sign in with GitHub to add it again as a new device.",
});

/** States of the device that the panel announces at once. */
const DEVICE_STATE_ALERTS: ReadonlySet<DeviceState> = new Set<DeviceState>([
  "auth_failed",
  "account_mismatch",
  "key_lost",
  "unavailable",
  "revoked",
]);

/** The message for the state of the device, or none. */
export function describeDeviceState(
  state: DeviceState,
): OutcomeMessage | undefined {
  const text = DEVICE_STATE_MESSAGES[state];
  return text === undefined
    ? undefined
    : { role: DEVICE_STATE_ALERTS.has(state) ? "alert" : "status", text };
}

/** The device states in which the panel offers "Sign in with GitHub". */
const SIGN_IN_STATES: ReadonlySet<DeviceState> = new Set<DeviceState>([
  "no_device",
  "signed_out",
  "sign_out_report_pending",
  "sign_in_required",
  "auth_failed",
  "account_mismatch",
  "key_lost",
  "removed",
  "revoked",
]);

/**
 * Whether the panel offers a GitHub sign-in: without an account, or when
 * the device needs one (after a sign-out, a refusal of the API, a lost key,
 * or a removal).
 */
export function offersSignIn(status: AccountStatus): boolean {
  return (
    status.account.kind === "signed_out" || SIGN_IN_STATES.has(status.device)
  );
}

/** The message for a start that the main process refused, or none. */
export function startMessage(
  result: StartSignInResult | undefined,
): string | undefined {
  return result?.outcome === "refused"
    ? START_REFUSAL_MESSAGES[result.reason]
    : undefined;
}

/** A wait for the sign-in of the account status to become idle. */
export interface IdleWait {
  /**
   * Resolves with the next status whose sign-in is idle, or with undefined
   * when the wait was stopped or the status is no longer followed.
   */
  readonly idle: Promise<AccountStatus | undefined>;
  /** Ends the wait; `idle` then resolves with undefined. */
  readonly stop: () => void;
}

/** The waits of the panel for an idle sign-in, fed with each status. */
export interface IdleWaits {
  readonly wait: () => IdleWait;
  /** Passes a status on: an idle one ends every wait with it. */
  readonly status: (status: AccountStatus) => void;
  /** Ends every wait with undefined, when the status is no longer followed. */
  readonly end: () => void;
}

export function createIdleWaits(): IdleWaits {
  const waiters = new Set<(status: AccountStatus | undefined) => void>();
  const endAll = (status: AccountStatus | undefined) => {
    for (const waiter of [...waiters]) {
      waiter(status);
    }
  };
  return Object.freeze({
    wait: (): IdleWait => {
      let stop: (status: AccountStatus | undefined) => void = () => undefined;
      const idle = new Promise<AccountStatus | undefined>((resolve) => {
        stop = (status) => {
          waiters.delete(stop);
          resolve(status);
        };
      });
      waiters.add(stop);
      return Object.freeze({ idle, stop: () => stop(undefined) });
    },
    status: (status: AccountStatus) => {
      if (status.signIn.kind === "idle") {
        endAll(status);
      }
    },
    end: () => endAll(undefined),
  });
}

/**
 * "Use another browser" (#175): a sign-in that opens no browser and offers
 * its address for copying into a browser of the person's choice. A sign-in
 * that waits in the default browser is cancelled first, because the API
 * binds its address to the browser that opened it; the new one starts only
 * after that sign-in ended as cancelled. When it ended otherwise, for
 * example because the browser posted meanwhile, nothing starts and the
 * result is undefined. The main process applies its rules to the start as
 * to any other: the cooldown, `busy`, and the key.
 */
export async function startInAnotherBrowser(
  account: Pick<AccountBridge, "startSignIn" | "cancelSignIn">,
  waiting: boolean,
  waitForIdle: () => IdleWait,
): Promise<StartSignInResult | undefined> {
  if (waiting) {
    // The wait begins before the cancel, so that its outcome is not missed.
    const wait = waitForIdle();
    let cancelled: boolean;
    try {
      cancelled = await account.cancelSignIn();
    } catch (error) {
      wait.stop();
      throw error;
    }
    if (!cancelled) {
      // The sign-in had already ended on its own.
      wait.stop();
      return undefined;
    }
    const ended = await wait.idle;
    if (ended?.lastOutcome?.code !== "cancelled") {
      return undefined;
    }
  }
  return account.startSignIn({ browser: "other" });
}

/** The message for each failure of a sign-out, a removal, or the device list. */
export const DEVICE_ACTION_FAILURE_MESSAGES: Readonly<
  Record<DeviceActionFailure, string>
> = Object.freeze({
  api_origin_unset: SIGN_IN_OUTCOME_MESSAGES.api_origin_unset,
  api_origin_invalid: SIGN_IN_OUTCOME_MESSAGES.api_origin_invalid,
  no_device: "This installation holds no device that can be used.",
  key_lost: "This device's key is missing. Sign in with GitHub first.",
  key_not_loaded: "The device key is not loaded. Enter its passphrase first.",
  record_unreadable: "The device record of this installation cannot be read.",
  key_store_failed: "The device key could not be used.",
  signed_out: "This device is signed out. Sign in with GitHub first.",
  sign_in_running: "Wait until the sign-in is finished.",
  replacement_pending:
    "The device key of the last sign-in is not confirmed yet. Try again in a few minutes.",
  removal_pending: "The removal of this device waits for the server.",
  record_not_saved:
    "The device record of this installation could not be saved. Try again.",
  no_answer: "The server did not answer. Check the connection and try again.",
  server_error: "The server failed. Try again later.",
  unexpected_response: "The server's answer could not be read. Try again.",
  sign_in_required: "The server asks for a new GitHub sign-in on this device.",
  auth_failed: "The server did not accept this device's key.",
  device_revoked: "This device was removed from its account.",
  device_account_mismatch:
    "This installation belongs to another GitHub account.",
  rate_limited: "Too many requests. Wait a minute and try again.",
  refused: "The server refused the request.",
  failed: "The request failed.",
});

/** The messages of the device actions that the main process refused or that need a note. */
export const DEVICE_ACTION_MESSAGES = Object.freeze({
  busy: "Wait until the sign-in or the current change of the account is finished.",
  notSignedIn: "This installation holds no account.",
  tooSoon: "Wait a few seconds before you ask for the devices again.",
  signOutFailed: "The sign-out could not be completed. Try again.",
  removeFailed: "The device could not be removed. Try again.",
  listFailed: "The devices could not be listed. Try again.",
  forgottenLocally:
    "The account was removed from this installation, but the server could not remove this device from it. The device stays listed in that account, without a key, until its sign-in ends after 30 days or it is removed from another device.",
});

/** The message for a device action that did not succeed, or none. */
function deviceActionMessage(
  result:
    | {
        readonly outcome: "refused";
        readonly reason: "busy" | "not_signed_in" | "too_soon";
      }
    | { readonly outcome: "failed"; readonly reason: DeviceActionFailure },
): string {
  if (result.outcome === "refused") {
    switch (result.reason) {
      case "busy":
        return DEVICE_ACTION_MESSAGES.busy;
      case "not_signed_in":
        return DEVICE_ACTION_MESSAGES.notSignedIn;
      case "too_soon":
        return DEVICE_ACTION_MESSAGES.tooSoon;
    }
  }
  return DEVICE_ACTION_FAILURE_MESSAGES[result.reason];
}

/** The message after a sign-out; the device state shows a success. */
export function signOutMessage(result: SignOutResult): string | undefined {
  switch (result.outcome) {
    case "signed_out":
    case "pending":
      return undefined;
    default:
      return deviceActionMessage(result);
  }
}

/** The message after a removal; the device state shows a removal or a pending one. */
export function removeDeviceMessage(
  result: RemoveDeviceResult,
): string | undefined {
  switch (result.outcome) {
    case "removed":
    case "pending":
    case "cancelled":
      return undefined;
    default:
      return deviceActionMessage(result);
  }
}

/** The message after the device list was asked for; the list shows itself. */
export function listDevicesMessage(
  result: ListDevicesResult,
): string | undefined {
  return result.outcome === "listed" ? undefined : deviceActionMessage(result);
}

/** The message after "This is not me". */
export function forgetMessage(result: ForgetResult): string | undefined {
  switch (result.outcome) {
    case "forgotten":
      return result.removedAtServer
        ? undefined
        : DEVICE_ACTION_MESSAGES.forgottenLocally;
    case "cancelled":
      return undefined;
    case "refused":
      return result.reason === "busy"
        ? ACTION_MESSAGES.forgetBusy
        : ACTION_MESSAGES.notSignedIn;
    case "failed":
      return ACTION_MESSAGES.forgetFailed;
  }
}

const PLATFORM_NAMES: Readonly<Record<DeviceView["platform"], string>> =
  Object.freeze({
    windows: "Windows",
    macos: "macOS",
    linux: "Linux",
  });

/** One line of detail for a device of the list: its platform and its state. */
export function deviceDetail(device: DeviceView): string {
  const platform = PLATFORM_NAMES[device.platform];
  if (device.revokedAt !== null) {
    return `${platform}, removed on ${device.revokedAt.slice(0, 10)}`;
  }
  return device.lastSeenAt === null
    ? `${platform}, not connected yet`
    : `${platform}, last seen on ${device.lastSeenAt.slice(0, 10)}`;
}
