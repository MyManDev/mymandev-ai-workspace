// The account of this installation in the main process (ADR 0014, "Sign-in",
// "Revocation, sign-out, and recovery", and "Storage and transport on the
// device"; parts 2c and 3 of #94). It loads the device key once at startup,
// reads the device record to learn whether the installation holds an
// account, creates the device session and refreshes it, starts and cancels
// the sign-in flow on the person's action, unlocks a key that a passphrase
// protects, signs out, removes this device, lists the account's devices, and
// forgets the account for "This is not me" (#149).
//
// The renderer gets a narrow status only: the account's login, display name,
// and device ID, the pairing code, the authorize URL when the browser did not
// open, the device list, and fixed codes. The sign-in code, the verifier,
// signatures, keys, tokens, and the passphrase never reach the status, a
// result, or a message.
import type { ApiErrorCode } from "@mymandev/protocol";
import type {
  Account,
  AccountStatus,
  ApiOriginState,
  DeviceKeyState,
  DeviceState,
  ForgetResult,
  ListDevicesResult,
  RemoveDeviceResult,
  SignInOutcomeCode,
  SignInOutcomeView,
  SignInState,
  SignOutResult,
  StartSignInResult,
  UnlockResult,
} from "../shared/ipc-contract.ts";
import {
  deviceActionFailure,
  deviceStateOf,
  deviceViewOf,
} from "./account-session.ts";
import type { ApiOrigin } from "./api-origin.ts";
import { isDeviceKeyError } from "./device-key/errors.ts";
import type { DeviceKeyStore } from "./device-key/store.ts";
import type { DeviceRecordStore } from "./device-record.ts";
import type {
  SignedInAccount,
  SignInFailureReason,
  SignInFlow,
  SignInOutcome,
  SignInStart,
} from "./sign-in/flow.ts";
import type { SignInListenerError } from "./sign-in/listener.ts";
import type {
  DeviceSession,
  DeviceSessionState,
  SessionFailure,
} from "./session/session.ts";

/** The part of the device session that the service uses. */
export type AccountSession = Pick<
  DeviceSession,
  | "state"
  | "onChange"
  | "refresh"
  | "signInStarted"
  | "signInFinished"
  | "authenticate"
  | "listDevices"
  | "signOut"
  | "reportSignOut"
  | "removeDevice"
>;

/** What the service uses once the application is ready. */
export interface AccountSystem {
  readonly keyStore: Pick<DeviceKeyStore, "load" | "status" | "delete">;
  /** The record store over the file that the flow writes. */
  readonly deviceRecords: Pick<DeviceRecordStore, "read" | "delete">;
  /**
   * Creates the sign-in flow over the same key store and record store.
   * Called once, before the first sign-in, after the key is loaded.
   */
  readonly createFlow: () => Pick<SignInFlow, "start" | "reset">;
  /**
   * Creates the device session over the same key store and record store.
   * Called once, after the key's load settled, also when the key waits for
   * its passphrase.
   */
  readonly createSession: () => AccountSession;
}

export interface AccountServiceOptions {
  /** From `resolveApiOrigin`; only whether it is set reaches the renderer. */
  readonly apiOrigin: ApiOrigin;
  /**
   * Creates the key store and the record store. `initialize` calls it once,
   * after the application is ready, in the instance that holds the
   * single-instance lock. It may throw, for example a `DeviceKeyError`
   * `local_data_folder_missing` on Windows.
   */
  readonly openSystem: () => AccountSystem;
  /**
   * Brings the main window to the front once the browser posted to the
   * sign-in listener (ADR 0014, "Sign-in", step 6).
   */
  readonly focusWindow: () => void;
  /**
   * Asks the person, in a native dialog of the main process, whether to
   * remove the account with this login from the installation ("This is not
   * me"). Resolves to true only for the remove button
   * (`FORGET_CONFIRMATION` and `forgetConfirmed`).
   */
  readonly confirmForget: (login: string) => Promise<boolean>;
  /**
   * Asks the person, in a native dialog of the main process, whether to
   * remove this device from the account with this login. Resolves to true
   * only for the remove button (`REMOVE_DEVICE_CONFIRMATION` and
   * `removeDeviceConfirmed`).
   */
  readonly confirmRemoveDevice: (login: string) => Promise<boolean>;
  /**
   * Stops local execution after the API revoked this device (ADR 0014:
   * after `device_revoked` the desktop "stops local execution"). Called
   * each time the device state moves to `revoked`, after the session
   * published it and before it deletes the key. An error that it throws is
   * reported.
   */
  readonly stopLocalExecution?: () => void;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /** Receives a fixed message, never a value. An error that it throws is ignored. */
  readonly onError?: (message: string) => void;
}

export interface AccountService {
  /** The current status. */
  readonly status: () => AccountStatus;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onStatusChange: (
    listener: (status: AccountStatus) => void,
  ) => () => void;
  /**
   * Opens the key store, loads the device key, reads the device record,
   * creates the device session, and refreshes it, which retries a pending
   * removal; a sign-out that the API has not learned yet is then reported.
   * Runs once; a later call resolves with the first one. Never rejects.
   */
  readonly initialize: () => Promise<void>;
  /**
   * Starts a sign-in after the person's action: one at a time, only with a
   * key that is ready, and not within `SIGN_IN_START_COOLDOWN_MS` of the
   * last start that opened the browser. Resolves once the browser opened or
   * the URL is ready to copy; the outcome arrives later in the status.
   * Never rejects.
   */
  readonly startSignIn: () => Promise<StartSignInResult>;
  /** Ends the open or starting sign-in; false when there is none. */
  readonly cancelSignIn: () => boolean;
  /**
   * Loads a key that a passphrase protects. The passphrase goes to the key
   * store only; it is never kept, returned, or reported. After a wrong
   * passphrase the next attempt waits (`unlockDelayMs`). Never rejects.
   */
  readonly unlockDeviceKey: (passphrase: string) => Promise<UnlockResult>;
  /**
   * "This is not me": asks the person with `confirmForget`, removes the
   * device at the API through the session where it can, then deletes the
   * device record and the device key of this installation and resets what
   * the flow keeps in memory, whatever the API answered. Never rejects.
   */
  readonly forgetAccount: () => Promise<ForgetResult>;
  /**
   * Signs out (P-65): the device, its key, and its record stay, and the key
   * is not used until the next GitHub sign-in. Resolves with `pending` when
   * the API learns it later; a second call while the report is pending
   * retries it. Never rejects.
   */
  readonly signOut: () => Promise<SignOutResult>;
  /**
   * Removes this device: asks the person with `confirmRemoveDevice`, then
   * revokes the device at the API with the reason `removed`. The key and the
   * record are deleted only after the API confirmed it; without a clear
   * answer the removal stays pending, and a later call or the next start
   * retries it. Never rejects.
   */
  readonly removeDevice: () => Promise<RemoveDeviceResult>;
  /** The account's devices, without anything secret. Never rejects. */
  readonly listDevices: () => Promise<ListDevicesResult>;
}

/**
 * How long after a start that opened the browser the next start is refused
 * (`too_soon`), so that even a renderer that misbehaves cannot open the
 * browser in a loop.
 */
export const SIGN_IN_START_COOLDOWN_MS = 3_000;

/**
 * How long after a device list was asked for the next one is refused
 * (`too_soon`), so that even a renderer that misbehaves cannot ask the API
 * for the list in a loop.
 */
export const LIST_DEVICES_COOLDOWN_MS = 2_000;

/** The delay after the first wrong passphrase; it doubles with each one after. */
export const UNLOCK_DELAY_FIRST_MS = 1_000;

/** The longest delay after wrong passphrases. */
export const UNLOCK_DELAY_MAX_MS = 30_000;

/**
 * How long an unlock is refused (`too_soon`) after this many wrong
 * passphrases in a row: 1 second after the first, doubling, at most 30
 * seconds. A success starts again from none.
 */
export function unlockDelayMs(failures: number): number {
  if (failures <= 0) {
    return 0;
  }
  return Math.min(
    UNLOCK_DELAY_MAX_MS,
    UNLOCK_DELAY_FIRST_MS * 2 ** Math.min(failures - 1, 16),
  );
}

/**
 * The native confirmation of "This is not me" (#149): a warning with the
 * remove button first and "Keep" as the default and the cancel button, like
 * the folder dialog of the repositories. `forgetConfirmed` reads its answer.
 */
export const FORGET_CONFIRMATION = Object.freeze({
  type: "warning",
  buttons: Object.freeze(["Remove from this installation", "Keep"] as const),
  defaultId: 1,
  cancelId: 1,
  noLink: true,
  title: "This is not me",
  detail:
    "The device key and the account are deleted on this computer. When this device is signed in with a usable key and the server can be reached, it is first removed from that account; otherwise it stays listed there, without a key, until its sign-in ends or the account removes it. You can then sign in with your own GitHub account.",
} as const);

/** The message of the confirmation, with the login of the account. */
export function forgetConfirmationMessage(login: string): string {
  return `Remove the GitHub account ${login} from this installation?`;
}

/** Whether the person chose the remove button of `FORGET_CONFIRMATION`. */
export function forgetConfirmed(result: {
  readonly response: number;
}): boolean {
  return result.response === 0;
}

const SIGNED_OUT: Account = Object.freeze({ kind: "signed_out" });
const IDLE: SignInState = Object.freeze({ kind: "idle" });
const STARTING: SignInState = Object.freeze({ kind: "starting" });
const COMPLETING: SignInState = Object.freeze({ kind: "completing" });

/** The outcome code of each error that the API's page posts. */
const LISTENER_ERROR_CODES: Readonly<
  Partial<Record<SignInListenerError, SignInOutcomeCode>>
> = Object.freeze({
  access_denied: "access_denied",
  sign_in_failed: "sign_in_failed",
  unsupported_account: "unsupported_account",
  sign_in_unavailable: "sign_in_unavailable",
});

/**
 * The outcome code of each API error code that `POST /auth/sign-in`
 * answers with. Every other code is `refused`. The flow reports a code of
 * `UNCERTAIN_REFUSAL_CODES` as the failure `uncertain_refusal`, never as a
 * refusal.
 */
const REFUSAL_CODES: Readonly<
  Partial<Record<ApiErrorCode, SignInOutcomeCode>>
> = Object.freeze({
  sign_in_required: "sign_in_required",
  device_account_mismatch: "device_account_mismatch",
  device_revoked: "device_revoked",
  device_registration_locked: "device_registration_locked",
  unsupported_account: "unsupported_account",
  sign_in_unavailable: "sign_in_unavailable",
});

/**
 * The outcome code of each failure reason of the flow. `unexpected` is the
 * generic `failed`. `label_invalid` and `already_running` cannot happen
 * here (the service passes no label and runs one attempt at a time), so
 * they are `failed` too, like a reason that a later flow adds. The API's
 * code of `uncertain_refusal` is not passed on.
 */
const FAILURE_CODES: Readonly<
  Partial<Record<SignInFailureReason, SignInOutcomeCode>>
> = Object.freeze({
  api_origin_unset: "api_origin_unset",
  api_origin_invalid: "api_origin_invalid",
  unsupported_platform: "unsupported_platform",
  key_not_loaded: "key_not_loaded",
  replacement_pending: "replacement_pending",
  key_store_failed: "key_store_failed",
  system_protection_unavailable: "system_protection_unavailable",
  record_unreadable: "record_unreadable",
  listener_unavailable: "listener_unavailable",
  no_answer: "no_answer",
  server_error: "server_error",
  unexpected_response: "unexpected_response",
  unexpected: "failed",
  uncertain_refusal: "uncertain_refusal",
  key_changed: "key_changed",
  record_not_saved: "record_not_saved",
});

/** The code of `key` in `table`, or `fallback` for a key that it does not hold. */
function codeOf(
  table: Readonly<Partial<Record<string, SignInOutcomeCode>>>,
  key: unknown,
  fallback: SignInOutcomeCode,
): SignInOutcomeCode {
  return typeof key === "string" && Object.hasOwn(table, key)
    ? (table[key] ?? fallback)
    : fallback;
}

/**
 * The outcome of the flow as the renderer may see it: a fixed code, and the
 * login of the installation's account after `device_account_mismatch`.
 */
export function signInOutcomeView(outcome: SignInOutcome): SignInOutcomeView {
  switch (outcome.kind) {
    case "signed_in":
    case "cancelled":
    case "timed_out":
      return Object.freeze({ code: outcome.kind });
    case "listener_error":
      return Object.freeze({
        code: codeOf(LISTENER_ERROR_CODES, outcome.error, "sign_in_failed"),
      });
    case "refused": {
      const code = codeOf(REFUSAL_CODES, outcome.code, "refused");
      return Object.freeze(
        code === "device_account_mismatch" && outcome.deviceLogin !== undefined
          ? { code, deviceLogin: outcome.deviceLogin }
          : { code },
      );
    }
    case "failed":
      return Object.freeze({
        code:
          outcome.reason === "key_store_failed" &&
          outcome.keyError === "system_protection_unavailable"
            ? "system_protection_unavailable"
            : codeOf(FAILURE_CODES, outcome.reason, "failed"),
      });
    default:
      // An outcome that a later flow adds.
      return Object.freeze({ code: "failed" });
  }
}

/** Only the parts of the account that the renderer may see. */
function signedIn(
  account: Pick<SignedInAccount, "login" | "displayName" | "deviceId">,
): Account {
  return Object.freeze({
    kind: "signed_in",
    login: account.login,
    displayName: account.displayName,
    deviceId: account.deviceId,
  });
}

/** The state of the key after `load` rejected with `error`. */
function keyStateAfter(error: unknown): DeviceKeyState {
  if (!isDeviceKeyError(error)) {
    return "failed";
  }
  switch (error.code) {
    case "passphrase_required":
    case "unreadable":
    case "corrupt":
    case "newer_format":
    case "local_data_folder_missing":
      return error.code;
    default:
      return "failed";
  }
}

function apiOriginState(origin: ApiOrigin): ApiOriginState {
  if (origin.ok) {
    return "set";
  }
  return origin.reason === "api_origin_unset" ? "unset" : "invalid";
}

/** An open sign-in: only its cancel function stays in the service. */
interface OpenAttempt {
  readonly cancel: () => void;
}

/** What the session hears of a flow that could not be created or did not answer. */
const UNEXPECTED_OUTCOME: SignInOutcome = Object.freeze({
  kind: "failed",
  reason: "unexpected",
});

/** Whether the flow did not start because a key replacement is pending. */
function replacementPendingOutcome(outcome: SignInOutcome): boolean {
  return outcome.kind === "failed" && outcome.reason === "replacement_pending";
}

/** The result of a session action that failed, as a fixed code. */
function actionFailed(failure: SessionFailure) {
  return Object.freeze({
    outcome: "failed" as const,
    reason: deviceActionFailure(failure),
  });
}

const ACTION_FAILED = Object.freeze({
  outcome: "failed" as const,
  reason: "failed" as const,
});
const ACTION_BUSY = Object.freeze({
  outcome: "refused" as const,
  reason: "busy" as const,
});
const ACTION_NOT_SIGNED_IN = Object.freeze({
  outcome: "refused" as const,
  reason: "not_signed_in" as const,
});

export function createAccountService(
  options: AccountServiceOptions,
): AccountService {
  const report = (message: string): void => {
    try {
      options.onError?.(message);
    } catch {
      // A failing report changes nothing.
    }
  };
  const apiOrigin = apiOriginState(options.apiOrigin);
  const now = options.now ?? (() => performance.now());
  const listeners = new Set<(status: AccountStatus) => void>();

  let system: AccountSystem | null = null;
  let flow: Pick<SignInFlow, "start" | "reset"> | null = null;
  let session: AccountSession | null = null;
  let initializing: Promise<void> | null = null;
  /** The action that runs; at most one at a time, besides an open attempt. */
  let operation:
    | "starting"
    | "unlocking"
    | "forgetting"
    | "signing_out"
    | "removing"
    | "listing"
    | null = null;
  /**
   * The work that runs in the background: the startup (from the key's load
   * until its session refresh has ended) and the refresh after an unlock.
   * A refresh may report a sign-out or retry a removal, which use the key
   * and may write the record, so every action of the person waits until
   * none runs (`backgroundSettled`). Each run never rejects.
   */
  const background = new Set<Promise<void>>();
  /** When the last device list was asked for, or null. */
  let lastList: number | null = null;
  let attempt: OpenAttempt | null = null;
  let cancelRequested = false;
  /** Counts the attempts, so that a late callback of an old one changes nothing. */
  let generation = 0;
  /** Whether the browser of the current attempt posted to the listener. */
  let callbackArrived = false;
  /** When the last start that opened the browser returned, or null. */
  let lastBrowserStart: number | null = null;
  /** Wrong passphrases in a row, and when the next unlock may run. */
  let wrongPassphrases = 0;
  let unlockAllowedAt = 0;

  let account: Account = SIGNED_OUT;
  let signIn: SignInState = IDLE;
  let lastOutcome: SignInOutcomeView | null = null;
  let deviceKey: DeviceKeyState = "loading";
  let replacementPending = false;
  let device: DeviceState = "starting";
  /**
   * Counts the reads of the account that may publish it, so that a read
   * that a later one overtook changes nothing.
   */
  let accountReads = 0;
  let revision = 0;
  let current = snapshot();

  function snapshot(): AccountStatus {
    return Object.freeze({
      revision,
      account,
      signIn,
      lastOutcome,
      deviceKey,
      replacementPending,
      apiOrigin,
      device,
    });
  }

  function publish(): void {
    revision += 1;
    current = snapshot();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        report("An account status listener failed.");
      }
    }
  }

  async function readAccount(opened: AccountSystem): Promise<Account> {
    try {
      const read = await opened.deviceRecords.read();
      // A corrupt record holds no account that can be shown; a sign-in
      // then decides with the flow's own rules.
      return read.kind === "record" ? signedIn(read.record) : SIGNED_OUT;
    } catch {
      report("The device record could not be read.");
      return SIGNED_OUT;
    }
  }

  async function readReplacementPending(
    opened: AccountSystem,
  ): Promise<boolean> {
    try {
      const keyStatus = await opened.keyStore.status();
      return keyStatus.protection !== "none" && keyStatus.replacementPending;
    } catch {
      return false;
    }
  }

  /**
   * Forgets what the flow keeps of a device that is gone (an unsaved record
   * and an account mismatch), so that its next attempt does not bring the
   * device back. A flow that refuses, because an attempt runs, is dropped,
   * and the next sign-in creates a new one.
   */
  function resetFlow(): void {
    if (flow !== null && !flow.reset()) {
      flow = null;
    }
  }

  /**
   * Reads the record and the key's replacement again, after the session
   * changed them, and publishes them when they changed.
   */
  async function refreshAccount(): Promise<void> {
    const opened = system;
    if (opened === null) {
      return;
    }
    accountReads += 1;
    const read = accountReads;
    const next = await readAccount(opened);
    const pending = await readReplacementPending(opened);
    if (read !== accountReads) {
      return;
    }
    if (
      JSON.stringify(next) === JSON.stringify(account) &&
      pending === replacementPending
    ) {
      return;
    }
    account = next;
    replacementPending = pending;
    publish();
  }

  /** Follows the state of the device session. */
  function sessionChanged(state: DeviceSessionState): void {
    const next = deviceStateOf(state);
    if (next === device) {
      return;
    }
    device = next;
    if (next === "revoked") {
      // ADR 0014: a revoked device stops local execution. The session
      // publishes `revoked` before it deletes the key.
      try {
        options.stopLocalExecution?.();
      } catch {
        report("The local execution could not be stopped.");
      }
    }
    if (next === "revoked" || next === "removed") {
      // The device is gone at the API for good. The session publishes this
      // before it deletes the key and the record, so the account is not
      // read now but signed out at once, and what the flow keeps of it is
      // forgotten.
      accountReads += 1;
      account = SIGNED_OUT;
      replacementPending = false;
      resetFlow();
      publish();
      return;
    }
    publish();
    // A confirmed or abandoned replacement changed the key, and a lost key
    // deleted it.
    void refreshAccount().catch(() => {
      report("The account could not be read.");
    });
  }

  /**
   * Refreshes the device session: at startup, after a passphrase, and after
   * "This is not me". It retries a pending removal, and a sign-out that the
   * API has not learned yet is then reported.
   */
  async function refreshSession(): Promise<void> {
    await inBackground(refreshSessionNow());
  }

  /** Counts `run` as background work until it has settled. */
  function inBackground(run: Promise<void>): Promise<void> {
    background.add(run);
    void run.finally(() => {
      background.delete(run);
    });
    return run;
  }

  /**
   * Waits until no background refresh runs. Every action of the person
   * takes the `operation` lock first and then waits here, so that it never
   * overlaps a sign-out report or a removal that the refresh retries: the
   * action is delayed, not refused, because the refresh is not the person's
   * doing and the first click after a start would otherwise fail for as
   * long as an offline request takes. While it waits, other actions answer
   * `busy`.
   */
  async function backgroundSettled(): Promise<void> {
    while (background.size > 0) {
      await Promise.all(background);
    }
  }

  async function refreshSessionNow(): Promise<void> {
    const held = session;
    if (held === null) {
      return;
    }
    try {
      const state = await held.refresh();
      sessionChanged(state);
      if (state.kind === "signed_out" && state.reportPending) {
        await held.reportSignOut();
      }
    } catch {
      report("The device session could not be refreshed.");
    }
  }

  async function initialize(): Promise<void> {
    let opened: AccountSystem;
    try {
      opened = options.openSystem();
    } catch (error) {
      deviceKey = isDeviceKeyError(error, "local_data_folder_missing")
        ? "local_data_folder_missing"
        : "failed";
      // Without the key store there is no device session either.
      device = "unavailable";
      report("The device key store could not be opened.");
      publish();
      return;
    }
    system = opened;
    // ADR 0014: the key is decrypted once at startup, before any connection
    // to the API opens, so that no prompt of the operating system runs
    // inside the WebSocket handshake.
    try {
      await opened.keyStore.load();
      deviceKey = "ready";
    } catch (error) {
      deviceKey = keyStateAfter(error);
      if (deviceKey !== "passphrase_required") {
        report("The device key could not be loaded.");
      }
    }
    // The session needs the key's load to have settled; with a key that
    // waits for its passphrase it reports `key_not_loaded` until then.
    try {
      const created = opened.createSession();
      session = created;
      created.onChange(sessionChanged);
      device = deviceStateOf(created.state());
    } catch {
      device = "unavailable";
      report("The device session could not be created.");
    }
    accountReads += 1;
    replacementPending = await readReplacementPending(opened);
    account = await readAccount(opened);
    publish();
    await refreshSession();
  }

  /**
   * The browser posted to the listener (ADR 0014, "Sign-in", step 6): the
   * status says that the sign-in completes, and the window comes to the
   * front before `POST /auth/sign-in` answers.
   */
  function callback(current: number): void {
    if (current !== generation || callbackArrived) {
      return;
    }
    callbackArrived = true;
    if (signIn.kind === "waiting") {
      signIn = COMPLETING;
      publish();
    }
    try {
      options.focusWindow();
    } catch {
      report("The window could not be brought to the front.");
    }
  }

  /** Tells the session how a sign-in ended, also one that did not start. */
  async function sessionSignInFinished(
    held: AccountSession | null,
    outcome: SignInOutcome,
  ): Promise<void> {
    if (held === null) {
      return;
    }
    try {
      sessionChanged(await held.signInFinished(outcome));
    } catch {
      report("The device session could not record the sign-in.");
    }
  }

  /**
   * Starts the flow, with `signInStarted` before it, so that the session
   * does not resolve a pending replacement while the sign-in may still
   * register the new key, and `signInFinished` when it did not start.
   */
  async function startFlow(
    opened: AccountSystem,
    held: AccountSession | null,
    current: number,
  ): Promise<SignInStart | null> {
    try {
      held?.signInStarted();
    } catch {
      report("The device session could not record the sign-in.");
    }
    let started: SignInStart | null = null;
    try {
      flow ??= opened.createFlow();
      started = await flow.start({ onCallback: () => callback(current) });
    } catch {
      // `start` never rejects; a flow that cannot be created ends here.
      report("The sign-in could not start.");
    }
    if (started === null || !started.started) {
      await sessionSignInFinished(
        held,
        started === null ? UNEXPECTED_OUTCOME : started.outcome,
      );
    }
    return started;
  }

  /**
   * After the flow answered `replacement_pending`: authenticates, which
   * resolves the pending replacement as far as the API's answers allow (the
   * new key confirmed, the replacement abandoned after the grace period, or
   * both keys deleted as lost), and tells whether the key store still holds
   * a replacement. Every failure counts as unresolved.
   */
  async function replacementResolved(
    opened: AccountSystem,
    held: AccountSession,
  ): Promise<boolean> {
    try {
      await held.authenticate();
      const keyStatus = await opened.keyStore.status();
      return keyStatus.protection === "none" || !keyStatus.replacementPending;
    } catch {
      report("The pending key replacement could not be resolved.");
      return false;
    }
  }

  /** Records how a started sign-in ended. */
  async function finish(
    opened: AccountSystem,
    held: AccountSession | null,
    outcome: SignInOutcome,
  ): Promise<void> {
    await sessionSignInFinished(held, outcome);
    accountReads += 1;
    const view = signInOutcomeView(outcome);
    // The flow may have written or deleted the record and the key, for
    // example after `device_revoked`.
    const next =
      outcome.kind === "signed_in"
        ? signedIn(outcome.account)
        : await readAccount(opened);
    replacementPending = await readReplacementPending(opened);
    account = next;
    attempt = null;
    signIn = IDLE;
    lastOutcome = view;
    publish();
  }

  async function startSignIn(): Promise<StartSignInResult> {
    if (operation !== null || attempt !== null) {
      return Object.freeze({ outcome: "refused", reason: "busy" });
    }
    const opened = system;
    if (opened === null || deviceKey !== "ready") {
      return Object.freeze({ outcome: "refused", reason: "key_not_ready" });
    }
    if (
      lastBrowserStart !== null &&
      now() - lastBrowserStart < SIGN_IN_START_COOLDOWN_MS
    ) {
      return Object.freeze({ outcome: "refused", reason: "too_soon" });
    }
    operation = "starting";
    cancelRequested = false;
    generation += 1;
    callbackArrived = false;
    const current = generation;
    signIn = STARTING;
    lastOutcome = null;
    publish();
    const held = session;
    try {
      await backgroundSettled();
      if (cancelRequested) {
        // Cancelled while it waited: the browser is never opened.
        signIn = IDLE;
        lastOutcome = Object.freeze({ code: "cancelled" });
        publish();
        return Object.freeze({ outcome: "failed", code: "cancelled" });
      }
      let started = await startFlow(opened, held, current);
      // The flow does not replace a key while a replacement is pending, and
      // only an authentication learns which key the API holds. When it
      // resolves the replacement, the flow starts once more, at most once
      // per action of the person: a second answer, whatever it is, is shown
      // as it is, so the service never loops. A replacement that the
      // authentication could not resolve (no answer, the grace period of an
      // uncertain sign-in, a first refusal of both keys) is reported as
      // `replacement_pending` without a second start.
      if (
        held !== null &&
        started !== null &&
        !started.started &&
        replacementPendingOutcome(started.outcome) &&
        !cancelRequested &&
        (await replacementResolved(opened, held)) &&
        !cancelRequested
      ) {
        started = await startFlow(opened, held, current);
      }
      if (started === null || !started.started) {
        const view =
          started === null
            ? Object.freeze({ code: "failed" as const })
            : signInOutcomeView(started.outcome);
        // A start that failed may have written a record that the flow kept
        // or deleted a leftover key.
        accountReads += 1;
        account = await readAccount(opened);
        replacementPending = await readReplacementPending(opened);
        signIn = IDLE;
        lastOutcome = view;
        publish();
        return Object.freeze({ outcome: "failed", code: view.code });
      }
      // The flow opened the browser, or tried to and offers the URL.
      lastBrowserStart = now();
      attempt = Object.freeze({ cancel: started.cancel });
      // The browser can post before `start` returns here.
      signIn = callbackArrived
        ? COMPLETING
        : Object.freeze(
            started.opened
              ? {
                  kind: "waiting",
                  pairingCode: started.pairingCode,
                  opened: true,
                }
              : {
                  kind: "waiting",
                  pairingCode: started.pairingCode,
                  opened: false,
                  authorizeUrl: started.authorizeUrl,
                  warning: started.warning,
                },
          );
      publish();
      const { outcome } = started;
      void outcome
        .catch((): SignInOutcome => ({ kind: "failed", reason: "unexpected" }))
        .then((value) => finish(opened, held, value))
        .catch(() => report("The sign-in outcome could not be recorded."));
      if (cancelRequested) {
        started.cancel();
      }
      return Object.freeze({ outcome: "started" });
    } finally {
      operation = null;
    }
  }

  function cancelSignIn(): boolean {
    if (attempt !== null) {
      attempt.cancel();
      return true;
    }
    if (operation === "starting") {
      // The attempt is cancelled as soon as `start` returns it.
      cancelRequested = true;
      return true;
    }
    return false;
  }

  async function unlockDeviceKey(passphrase: string): Promise<UnlockResult> {
    if (operation !== null || attempt !== null || deviceKey === "loading") {
      return Object.freeze({ outcome: "refused", reason: "busy" });
    }
    const opened = system;
    if (opened === null || deviceKey !== "passphrase_required") {
      return Object.freeze({ outcome: "refused", reason: "not_required" });
    }
    if (now() < unlockAllowedAt) {
      return Object.freeze({ outcome: "refused", reason: "too_soon" });
    }
    operation = "unlocking";
    try {
      await opened.keyStore.load({ passphrase });
      wrongPassphrases = 0;
      unlockAllowedAt = 0;
      deviceKey = "ready";
      replacementPending = await readReplacementPending(opened);
      publish();
      // The session reads the loaded key; a pending removal or sign-out
      // report is retried. The unlock does not wait for the API.
      void refreshSession();
      return Object.freeze({ outcome: "unlocked" });
    } catch (error) {
      // Nothing about the passphrase is reported: the store's errors are
      // fixed per code, and only the code is read here.
      if (isDeviceKeyError(error, "wrong_passphrase")) {
        // Each wrong passphrase makes the next attempt wait longer.
        wrongPassphrases += 1;
        unlockAllowedAt = now() + unlockDelayMs(wrongPassphrases);
        return Object.freeze({
          outcome: "refused",
          reason: "wrong_passphrase",
        });
      }
      if (isDeviceKeyError(error, "passphrase_invalid")) {
        return Object.freeze({
          outcome: "refused",
          reason: "passphrase_invalid",
        });
      }
      const next = keyStateAfter(error);
      if (next !== deviceKey) {
        deviceKey = next;
        publish();
      }
      report("The device key could not be loaded.");
      return Object.freeze({ outcome: "failed" });
    } finally {
      operation = null;
    }
  }

  async function forgetAccount(): Promise<ForgetResult> {
    if (operation !== null || attempt !== null || deviceKey === "loading") {
      return Object.freeze({ outcome: "refused", reason: "busy" });
    }
    const opened = system;
    if (opened === null || account.kind !== "signed_in") {
      return Object.freeze({ outcome: "refused", reason: "not_signed_in" });
    }
    operation = "forgetting";
    try {
      // A background refresh may still use the key, for example to report a
      // sign-out, and write the record once the API answers: the forget
      // waits for it, so that nothing writes the account back afterwards.
      await backgroundSettled();
      if (account.kind !== "signed_in") {
        return Object.freeze({ outcome: "refused", reason: "not_signed_in" });
      }
      const { login } = account;
      // The confirmation runs in the main process, so that a renderer that
      // misbehaves cannot delete the key without the person.
      let confirmed: boolean;
      try {
        confirmed = await options.confirmForget(login);
      } catch {
        report("The confirmation could not be shown.");
        return Object.freeze({ outcome: "failed" });
      }
      if (!confirmed) {
        return Object.freeze({ outcome: "cancelled" });
      }
      // The device is removed at the API first, and then forgotten here
      // whatever the API answered. The removal needs the key, which signs
      // the access token request, and the record, which names the device,
      // so it can only come before they are deleted. Its failure (offline,
      // signed out, a key that waits for its passphrase, a refusal) never
      // stops the local part, so the account never stays on the
      // installation because the API could not be reached; the device then
      // stays registered to that account at the API, without a key that can
      // use it, until its 30-day sign-in ends or the account removes it
      // from another device. The removal itself only deletes files after the
      // API confirmed it, so it can never bring the account back either.
      let removedAtServer = false;
      if (session !== null) {
        try {
          const removal = await session.removeDevice();
          removedAtServer = removal.ok && removal.value === "removed";
        } catch {
          report("The device could not be removed at the server.");
        }
      }
      // The record goes first: a key without a record is deleted by the next
      // sign-in, while a record without a key would make the next sign-in
      // name this device as its previous device, for the other account.
      accountReads += 1;
      await opened.deviceRecords.delete();
      // Once the record is gone, the flow keeps nothing of this account in
      // memory: no unsaved record, which its next attempt would write back,
      // and no account mismatch. This comes before the key, so that a key
      // that cannot be deleted does not bring the account back. No attempt
      // runs during "This is not me", so the reset applies; a flow that
      // refused it anyway is dropped, and the next sign-in creates a new one.
      if (flow !== null && !flow.reset()) {
        flow = null;
      }
      await opened.keyStore.delete();
      account = SIGNED_OUT;
      deviceKey = "ready";
      replacementPending = false;
      lastOutcome = null;
      publish();
      // The session reads the files again; a removal that it noted for the
      // deleted device ends with them.
      await refreshSession();
      return Object.freeze({ outcome: "forgotten", removedAtServer });
    } catch {
      report("The account could not be forgotten on this device.");
      accountReads += 1;
      account = await readAccount(opened);
      replacementPending = await readReplacementPending(opened);
      publish();
      await refreshSession();
      return Object.freeze({ outcome: "failed" });
    } finally {
      operation = null;
    }
  }

  type ActionRefusal = typeof ACTION_BUSY | typeof ACTION_NOT_SIGNED_IN;

  /**
   * Starts an action of the device session: refuses it as `busy` while a
   * sign-in is open, the key is loading, or another action runs; takes the
   * `operation` lock; waits for a background refresh (`backgroundSettled`);
   * and then refuses it as `not_signed_in` without an account or a session.
   * The caller releases the lock with `endAction` in `finally`, also after a
   * refusal here.
   */
  async function beginAction(
    kind: "signing_out" | "removing" | "listing",
  ): Promise<AccountSession | ActionRefusal> {
    if (operation !== null || attempt !== null || deviceKey === "loading") {
      return ACTION_BUSY;
    }
    operation = kind;
    await backgroundSettled();
    if (system === null || session === null || account.kind !== "signed_in") {
      return ACTION_NOT_SIGNED_IN;
    }
    return session;
  }

  function isRefusal(
    value: AccountSession | ActionRefusal,
  ): value is ActionRefusal {
    return "outcome" in value;
  }

  /** Releases the lock that `beginAction` took; `busy` took none. */
  function endAction(value: AccountSession | ActionRefusal): void {
    if (value !== ACTION_BUSY) {
      operation = null;
    }
  }

  async function signOut(): Promise<SignOutResult> {
    const held = await beginAction("signing_out");
    try {
      if (isRefusal(held)) {
        return held;
      }
      if (device === "removal_pending") {
        // A sign-out would end the removal that the person confirmed; it is
        // retried at the next start or by removing the device again.
        return Object.freeze({ outcome: "failed", reason: "removal_pending" });
      }
      // P-65: the session keeps the device, its key, and its record; the
      // sign-out holds on the device at once, and the API learns it now or
      // later.
      const result = await held.signOut();
      if (!result.ok) {
        return actionFailed(result);
      }
      return result.value === "reported"
        ? Object.freeze({ outcome: "signed_out" })
        : Object.freeze({ outcome: "pending" });
    } catch {
      report("The sign-out failed.");
      return ACTION_FAILED;
    } finally {
      endAction(held);
    }
  }

  async function removeDevice(): Promise<RemoveDeviceResult> {
    const held = await beginAction("removing");
    try {
      if (isRefusal(held)) {
        return held;
      }
      if (account.kind !== "signed_in") {
        return ACTION_NOT_SIGNED_IN;
      }
      // The person is not asked for a removal that cannot happen: the API
      // takes no request of a signed-out device (they sign in first), and a
      // key that waits for its passphrase cannot sign.
      if (device === "signed_out" || device === "sign_out_report_pending") {
        return Object.freeze({ outcome: "failed", reason: "signed_out" });
      }
      if (device === "key_not_loaded" || deviceKey !== "ready") {
        return Object.freeze({ outcome: "failed", reason: "key_not_loaded" });
      }
      const { login } = account;
      // The confirmation runs in the main process, so that a renderer that
      // misbehaves cannot remove the device without the person.
      let confirmed: boolean;
      try {
        confirmed = await options.confirmRemoveDevice(login);
      } catch {
        report("The confirmation could not be shown.");
        return ACTION_FAILED;
      }
      if (!confirmed) {
        return Object.freeze({ outcome: "cancelled" });
      }
      // The session notes the removal, so that it holds across a restart,
      // and deletes the key and the record only after the API confirmed it.
      const result = await held.removeDevice();
      if (!result.ok) {
        return actionFailed(result);
      }
      if (result.value === "pending") {
        // The key stays, and the next start or another removal retries it.
        return Object.freeze({ outcome: "pending" });
      }
      resetFlow();
      return Object.freeze({ outcome: "removed" });
    } catch {
      report("The device could not be removed.");
      return ACTION_FAILED;
    } finally {
      endAction(held);
    }
  }

  async function listDevices(): Promise<ListDevicesResult> {
    const held = await beginAction("listing");
    try {
      if (isRefusal(held)) {
        return held;
      }
      if (account.kind !== "signed_in") {
        return ACTION_NOT_SIGNED_IN;
      }
      if (lastList !== null && now() - lastList < LIST_DEVICES_COOLDOWN_MS) {
        return Object.freeze({ outcome: "refused", reason: "too_soon" });
      }
      const deviceId = account.deviceId;
      lastList = now();
      const result = await held.listDevices();
      // The list belongs to the device that asked: when the account changed
      // meanwhile (for example the session found the device revoked), it is
      // dropped.
      if (account.kind !== "signed_in" || account.deviceId !== deviceId) {
        return ACTION_NOT_SIGNED_IN;
      }
      if (!result.ok) {
        return actionFailed(result);
      }
      return Object.freeze({
        outcome: "listed",
        devices: result.value.map(deviceViewOf),
      });
    } catch {
      report("The device list could not be read.");
      return ACTION_FAILED;
    } finally {
      endAction(held);
    }
  }

  return Object.freeze({
    status: () => current,
    onStatusChange: (listener: (status: AccountStatus) => void) => {
      const entry = (next: AccountStatus) => listener(next);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    initialize: () => {
      // The whole startup counts as background work: from the key's load,
      // the key is ready before the startup refresh begins, and a sign-in or
      // another action in that gap must wait for the refresh as well.
      initializing ??= inBackground(
        initialize().catch(() => {
          report("The account could not be read.");
        }),
      );
      return initializing;
    },
    startSignIn,
    cancelSignIn,
    unlockDeviceKey,
    forgetAccount,
    signOut,
    removeDevice,
    listDevices,
  });
}
