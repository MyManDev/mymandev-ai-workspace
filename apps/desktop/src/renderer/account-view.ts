import type { AccountBridge } from "../shared/desktop-bridge.ts";
import { SIGN_IN_START_COOLDOWN_MS } from "../shared/sign-in-timing.ts";
import type {
  AccountStatus,
  ApiOriginState,
  StartSignInResult,
  DeviceActionFailure,
  DeviceKeyState,
  DeviceState,
  ForgetResult,
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
  device_limit:
    "This account already has as many active devices as it allows, so this device cannot be added. On another of your devices, remove a device that you no longer use in the Devices section of the Account screen, then sign in here again.",
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

/** The options of `signInTimeFormat`; the tests fix them. */
export interface SignInTimeFormatOptions {
  /** Defaults to the person's locale. */
  readonly locale?: string;
  /** An IANA time zone such as "Europe/Istanbul"; defaults to the system's. */
  readonly timeZone?: string;
}

/**
 * The format of the time after which a new sign-in can start (#199): the
 * local time of day, for example "14:32" or "2:32 PM". The panel makes a
 * new one for each render, so that a changed time zone of the system shows
 * at the next change.
 */
export function signInTimeFormat(
  options: SignInTimeFormatOptions = {},
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(options.locale, {
    timeStyle: "short",
    timeZone: options.timeZone,
  });
}

/**
 * When a start that was refused as `replacement_pending` during the grace
 * period of an uncertain sign-in can be tried again, in milliseconds
 * (#199): the outcome's `retryAfter`, while no sign-in runs and the status
 * still reports the pending replacement; otherwise undefined, also when
 * the replacement was resolved before that time. The main process computed
 * the time when it refused the start.
 */
export function signInRetryAt(status: AccountStatus): number | undefined {
  const outcome = status.lastOutcome;
  if (
    status.signIn.kind !== "idle" ||
    !status.replacementPending ||
    outcome?.code !== "replacement_pending" ||
    outcome.retryAfter === undefined
  ) {
    return undefined;
  }
  const at = Date.parse(outcome.retryAfter);
  return Number.isNaN(at) ? undefined : at;
}

/**
 * The note next to that refusal (#199): the local time after which a new
 * sign-in can start, rounded up to the minute so that a start at the shown
 * time is not refused, or undefined once that time has come (`now`, in
 * milliseconds) or without one.
 */
export function signInRetryNote(
  status: AccountStatus,
  now: number,
  format: Intl.DateTimeFormat,
): string | undefined {
  const at = signInRetryAt(status);
  if (at === undefined || now >= at) {
    return undefined;
  }
  const shown = new Date(Math.ceil(at / 60_000) * 60_000);
  return `A new sign-in can start after ${format.format(shown)}. Try again then.`;
}

/** The clock and the timer of `watchSignInRetry`; the tests replace them. */
export interface SignInRetryClock {
  /** The time in milliseconds, as `Date.now()` reads it. */
  readonly now: () => number;
  /** Runs `run` once after `delayMs`; the returned function stops it. */
  readonly setTimer: (run: () => void, delayMs: number) => () => void;
}

/** The renderer's clock and `setTimeout`. */
export const SYSTEM_RETRY_CLOCK: SignInRetryClock = Object.freeze({
  now: () => Date.now(),
  setTimer: (run: () => void, delayMs: number) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
});

/** The panel's clock reading, and the time of the note that it was read for. */
export interface SignInRetryReading {
  /** The time of the note (`signInRetryAt`) when the clock was read. */
  readonly retryAt: number | undefined;
  /** The clock's reading in milliseconds. */
  readonly now: number;
}

/**
 * The clock reading that the panel compares with the time of the note
 * (#204): `held` while it was read for the same `retryAt`, and a new
 * reading of the clock once `retryAt` changed, or without one. Otherwise
 * only `watchSignInRetry` reads the clock, when a note ends, so after the
 * clock was set back, a later note whose time lies before that reading
 * would never show.
 */
export function signInRetryReading(
  held: SignInRetryReading | undefined,
  retryAt: number | undefined,
  clock: Pick<SignInRetryClock, "now"> = SYSTEM_RETRY_CLOCK,
): SignInRetryReading {
  return held !== undefined && held.retryAt === retryAt
    ? held
    : Object.freeze({ retryAt, now: clock.now() });
}

/**
 * The longest delay of `setTimeout`, which runs a longer one at once
 * (a 32-bit signed integer).
 */
const LONGEST_TIMER_MS = 2_147_483_647;

/**
 * Reads the clock again when the note of `signInRetryNote` ends (#199), so
 * that the panel removes it: while the note shows at `now`, a timer runs
 * until `retryAt` (`signInRetryAt`), by the clock's reading. When it fires,
 * the clock is read again. A time at or after `retryAt` goes to `onTime`.
 * A clock that still reads earlier, because it was set back or trails the
 * timer, gets the timer again for the rest, so the note does not stay. No
 * timer runs once `now` is at or after `retryAt`, so the time that
 * `onTime` passed on arms no timer of no delay again and again. The
 * returned function stops the timer that runs; the panel calls it when
 * `retryAt` or `now` changes and when the panel is no longer shown.
 */
export function watchSignInRetry(
  retryAt: number | undefined,
  now: number,
  onTime: (now: number) => void,
  clock: SignInRetryClock = SYSTEM_RETRY_CLOCK,
): () => void {
  if (retryAt === undefined || now >= retryAt) {
    return () => undefined;
  }
  let stop: () => void = () => undefined;
  const arm = (read: number): void => {
    stop = clock.setTimer(
      () => {
        const later = clock.now();
        if (later >= retryAt) {
          onTime(later);
        } else {
          arm(later);
        }
      },
      Math.min(Math.max(0, retryAt - read), LONGEST_TIMER_MS),
    );
  };
  arm(clock.now());
  return () => stop();
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

/**
 * Whether the panel offers a GitHub sign-in that can start now: no sign-in
 * runs, the panel offers one (`offersSignIn`), the device key is ready, and
 * the build has a usable server address. Otherwise the panel shows no
 * sign-in button or a disabled one. The home screen offers its "Sign in
 * with GitHub" only then (#219).
 */
export function canStartSignIn(status: AccountStatus): boolean {
  return (
    status.signIn.kind === "idle" &&
    offersSignIn(status) &&
    status.deviceKey === "ready" &&
    apiOriginProblem(status.apiOrigin) === undefined
  );
}

/**
 * Whether this installation's device is signed in: the status names its
 * account, and the device session holds the device as signed in. The
 * connection header offers the actions after `connection_replaced` only
 * then.
 */
export function deviceSignedIn(status: AccountStatus): boolean {
  return status.account.kind === "signed_in" && status.device === "signed_in";
}

/**
 * How long before the end of the device's sign-in the panel asks the person
 * to renew it (D4 on #95): from day 25 of the 30 days (ADR 0014,
 * "Lifetimes"). Day 25 begins after 24 days, so 6 days before the end (the
 * Project Manager's decision of 2026-11-09).
 */
export const SIGN_IN_RENEWAL_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;

/** The label of the action that renews the sign-in (D4 on #95). */
export const RENEW_SIGN_IN_LABEL = "Renew the sign-in";

/**
 * The fixed sentences that ask the person to renew the sign-in: from 6 days
 * before its end (`due`), and after the end by the renderer's clock while
 * the server still accepts the device (`ended`; an open connection may go
 * on for up to 24 hours). Once the server refuses the device, its state
 * becomes `sign_in_required`, and the panel asks for a GitHub sign-in
 * instead.
 */
export const SIGN_IN_RENEWAL_MESSAGES = Object.freeze({
  due: "The sign-in of this device ends soon. Renew it to keep using this device.",
  ended:
    "The sign-in of this device has ended. Renew it to keep using this device.",
});

/** The end of the device's sign-in as the panel shows it (D4 on #95). */
export interface SignInExpiry {
  /** The end in UTC, as the status names it. */
  readonly endsAt: string;
  /** The sentence that asks to renew it, or undefined before day 25. */
  readonly prompt: string | undefined;
}

/**
 * The account and the end of its sign-in in milliseconds, while this
 * installation's device is signed in (`deviceSignedIn`); otherwise
 * undefined, also while the status hides the account (#195).
 */
function signedInExpiry(
  status: AccountStatus,
): { readonly endsAt: string; readonly end: number } | undefined {
  if (status.account.kind !== "signed_in" || status.device !== "signed_in") {
    return undefined;
  }
  const endsAt = status.account.signInExpiresAt;
  const end = Date.parse(endsAt);
  return Number.isNaN(end) ? undefined : { endsAt, end };
}

/**
 * When the sign-in of this device ends, and whether the panel asks to renew
 * it by the clock `now` in milliseconds: from `SIGN_IN_RENEWAL_WINDOW_MS`
 * before the end. Only while the device is signed in: in every other state
 * the panel says what the device needs, for example a GitHub sign-in after
 * `sign_in_required`.
 */
export function describeSignInExpiry(
  status: AccountStatus,
  now: number,
): SignInExpiry | undefined {
  const expiry = signedInExpiry(status);
  if (expiry === undefined) {
    return undefined;
  }
  let prompt: string | undefined;
  if (now >= expiry.end) {
    prompt = SIGN_IN_RENEWAL_MESSAGES.ended;
  } else if (now >= expiry.end - SIGN_IN_RENEWAL_WINDOW_MS) {
    prompt = SIGN_IN_RENEWAL_MESSAGES.due;
  }
  return { endsAt: expiry.endsAt, prompt };
}

/**
 * The next time after `now`, in milliseconds, at which
 * `describeSignInExpiry` says something else by the clock alone: the start
 * of day 25, or the end. Undefined when nothing changes.
 */
export function nextSignInExpiryChange(
  status: AccountStatus,
  now: number,
): number | undefined {
  const expiry = signedInExpiry(status);
  if (expiry === undefined) {
    return undefined;
  }
  return [expiry.end - SIGN_IN_RENEWAL_WINDOW_MS, expiry.end].find(
    (time) => time > now,
  );
}

/**
 * Whether the panel offers "Renew the sign-in" (D4 on #95): at any time
 * while this device is signed in, no sign-in runs, the device key is ready,
 * and the build has a usable server address. A renewal is the GitHub
 * sign-in of the device that is signed in: the main process starts it like
 * any other, replaces the device's key, and the API answers a new end 30
 * days later.
 */
export function offersRenewal(status: AccountStatus): boolean {
  return (
    status.signIn.kind === "idle" &&
    deviceSignedIn(status) &&
    status.deviceKey === "ready" &&
    apiOriginProblem(status.apiOrigin) === undefined
  );
}

/**
 * The format of the end of the sign-in: the date and the time of day, for
 * example "9 December 2026 at 10:00", in the person's locale and time zone
 * (the Project Manager's decision of 2026-11-09). The panel makes a new one
 * for each render, like `signInTimeFormat`.
 */
export function signInEndFormat(
  options: SignInTimeFormatOptions = {},
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: options.timeZone,
  });
}

/**
 * Whether the panel offers "This is not me": whenever the installation holds
 * an account, also while its device is signed out and the status names no
 * account (`hidden`, #195). The main process confirms it with the login.
 */
export function offersForget(status: AccountStatus): boolean {
  return status.account.kind !== "signed_out";
}

/**
 * The fixed note that recommends two-factor authentication on the GitHub
 * account that the person signs in with (decision D6 on #95). The account
 * has no password of its own: the GitHub sign-in is its only protection.
 * Plain text without a link, because D6 asks for none and the renderer
 * opens no address.
 */
export const TWO_FACTOR_NOTE =
  "Turn on two-factor authentication for the GitHub account that you sign in with. MyManDev has no password of its own: whoever can sign in to that GitHub account can use your MyManDev account.";

/**
 * Whether the panel shows `TWO_FACTOR_NOTE` (D6 on #95): while no sign-in
 * runs, and the panel offers a GitHub sign-in or this device is signed in.
 * So the person reads it before choosing the GitHub account to sign in
 * with and while using it, but not next to the pairing code of a running
 * sign-in, nor while the device of an account that the installation holds
 * is checked, waits for its passphrase, or waits for its removal, when the
 * panel asks for something else.
 */
export function showsTwoFactorNote(status: AccountStatus): boolean {
  return (
    status.signIn.kind === "idle" &&
    (offersSignIn(status) || deviceSignedIn(status))
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
 * Follows the account status for the panel: each status becomes the view
 * and goes to the idle waits, and the end of the subscription, by an error
 * or by the returned function, ends every wait.
 */
export function followAccountStatus(
  account: Pick<AccountBridge, "subscribeStatus">,
  idleWaits: IdleWaits,
  onView: (view: AccountView) => void,
): () => void {
  const stop = account.subscribeStatus(
    (status) => {
      onView({ kind: "known", status });
      idleWaits.status(status);
    },
    () => {
      onView({ kind: "unavailable" });
      idleWaits.end();
    },
  );
  return () => {
    stop();
    idleWaits.end();
  };
}

/** The pairing code of the sign-in that waits for the browser, or undefined. */
export function waitingPairingCode(view: AccountView): string | undefined {
  return view.kind === "known" && view.status.signIn.kind === "waiting"
    ? view.status.signIn.pairingCode
    : undefined;
}

/**
 * How long after the panel saw a sign-in wait in the browser it offers
 * "Use another browser" for it. That replaces the sign-in with a cancel and
 * a new start, and the main process refuses a start within its cooldown,
 * `SIGN_IN_START_COOLDOWN_MS` (`src/shared/sign-in-timing.ts`), of the start
 * that opened the browser. Without this delay, a cancel in that time would
 * end the waiting sign-in, and the new start would be refused as too soon.
 */
export const ANOTHER_BROWSER_DELAY_MS = SIGN_IN_START_COOLDOWN_MS;

/**
 * "Use another browser" (#175): a sign-in that opens no browser and offers
 * its address for copying into a browser of the person's choice. A sign-in
 * that waits in the default browser is cancelled first, because the API
 * binds its address to the browser that opened it; the new one starts only
 * after that sign-in ended as cancelled. When it ended otherwise, for
 * example because the browser posted meanwhile, nothing starts and the
 * result is undefined. The main process applies its rules to the start as
 * to any other: the cooldown, `busy`, and the key; the panel offers it for
 * a waiting sign-in only after `ANOTHER_BROWSER_DELAY_MS`.
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

/** The message for each failure of a sign-out or a removal. */
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
  signOutFailed: "The sign-out could not be completed. Try again.",
  removeFailed: "The device could not be removed. Try again.",
  forgottenAtServer:
    "The account was removed from this installation, and the server removed this device from it.",
  forgottenLocally:
    'The account was removed from this installation only. The server did not remove this device, so it stays listed for that GitHub account, without a key. Whoever owns that account can remove it from another of their devices, with "Remove" in the device list on the Account screen.',
});

/** The message for a device action that did not succeed, or none. */
function deviceActionMessage(
  result:
    | {
        readonly outcome: "refused";
        readonly reason: "busy" | "not_signed_in";
      }
    | { readonly outcome: "failed"; readonly reason: DeviceActionFailure },
): string {
  if (result.outcome === "refused") {
    switch (result.reason) {
      case "busy":
        return DEVICE_ACTION_MESSAGES.busy;
      case "not_signed_in":
        return DEVICE_ACTION_MESSAGES.notSignedIn;
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

/**
 * The message after "This is not me": whether the server removed the device
 * or it stays listed for that account (#198), or why nothing was deleted.
 */
export function forgetMessage(result: ForgetResult): string | undefined {
  switch (result.outcome) {
    case "forgotten":
      return result.removedAtServer
        ? DEVICE_ACTION_MESSAGES.forgottenAtServer
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
