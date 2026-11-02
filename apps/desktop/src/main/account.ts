// The account of this installation in the main process (ADR 0014, "Sign-in"
// and "Storage and transport on the device"; part 2c of #94). It loads the
// device key once at startup, reads the device record to learn whether the
// installation holds an account, starts and cancels the sign-in flow on the
// person's action, unlocks a key that a passphrase protects, and forgets the
// account for "This is not me" (#149).
//
// The renderer gets a narrow status only: the account's login, display name,
// and device ID, the pairing code, the authorize URL when the browser did not
// open, and fixed codes. The sign-in code, the verifier, signatures, keys,
// tokens, and the passphrase never reach the status, a result, or a message.
import type { ApiErrorCode } from "@mymandev/protocol";
import type {
  Account,
  AccountStatus,
  ApiOriginState,
  DeviceKeyState,
  ForgetResult,
  SignInOutcomeCode,
  SignInOutcomeView,
  SignInState,
  StartSignInResult,
  UnlockResult,
} from "../shared/ipc-contract.ts";
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

/** What the service uses once the application is ready. */
export interface AccountSystem {
  readonly keyStore: Pick<DeviceKeyStore, "load" | "status" | "delete">;
  /** The record store over the file that the flow writes. */
  readonly deviceRecords: Pick<DeviceRecordStore, "read" | "delete">;
  /**
   * Creates the sign-in flow over the same key store. Called before the
   * first sign-in, after the key is loaded, and again after "This is not
   * me", so that nothing that the previous flow kept in memory remains.
   */
  readonly createFlow: () => Pick<SignInFlow, "start">;
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
  /** Brings the main window to the front (ADR 0014, "Sign-in", step 6). */
  readonly focusWindow: () => void;
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
   * Opens the key store, loads the device key, and reads the device record.
   * Runs once; a later call resolves with the first one. Never rejects.
   */
  readonly initialize: () => Promise<void>;
  /**
   * Starts a sign-in after the person's action: one at a time, and only
   * with a key that is ready. Resolves once the browser opened or the URL
   * is ready to copy; the outcome arrives later in the status. Never
   * rejects.
   */
  readonly startSignIn: () => Promise<StartSignInResult>;
  /** Ends the open or starting sign-in; false when there is none. */
  readonly cancelSignIn: () => boolean;
  /**
   * Loads a key that a passphrase protects. The passphrase goes to the key
   * store only; it is never kept, returned, or reported. Never rejects.
   */
  readonly unlockDeviceKey: (passphrase: string) => Promise<UnlockResult>;
  /**
   * "This is not me": deletes the device record and the device key of this
   * installation. The renderer asks the person to confirm first; this asks
   * nothing. Never rejects.
   */
  readonly forgetAccount: () => Promise<ForgetResult>;
}

const SIGNED_OUT: Account = Object.freeze({ kind: "signed_out" });
const IDLE: SignInState = Object.freeze({ kind: "idle" });
const STARTING: SignInState = Object.freeze({ kind: "starting" });

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
 * answers with. Every other code is `refused`.
 */
const REFUSAL_CODES: Readonly<
  Partial<Record<ApiErrorCode, SignInOutcomeCode>>
> = Object.freeze({
  auth_failed: "auth_failed",
  sign_in_required: "sign_in_required",
  device_account_mismatch: "device_account_mismatch",
  device_revoked: "device_revoked",
  device_registration_locked: "device_registration_locked",
  unsupported_account: "unsupported_account",
  rate_limited: "rate_limited",
  sign_in_unavailable: "sign_in_unavailable",
});

/**
 * The outcome code of each failure reason of the flow. `label_invalid` and
 * `already_running` cannot happen here (the service passes no label and
 * runs one attempt at a time), so they are `failed`, like a reason that a
 * later flow adds.
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
  record_unreadable: "record_unreadable",
  listener_unavailable: "listener_unavailable",
  no_answer: "no_answer",
  server_error: "server_error",
  unexpected_response: "unexpected_response",
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

/**
 * Whether the listener received the valid request before the outcome: the
 * API's page posted a code or an error. Every `failed` outcome of a started
 * attempt comes after a code. Only then does the window come to the front.
 * The flow resolves its outcome only after `POST /auth/sign-in` answered,
 * so this is the earliest moment the service learns of the request.
 */
export function followsCallback(outcome: SignInOutcome): boolean {
  switch (outcome.kind) {
    case "signed_in":
    case "refused":
    case "failed":
    case "listener_error":
      return true;
    default:
      return false;
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
  const listeners = new Set<(status: AccountStatus) => void>();

  let system: AccountSystem | null = null;
  let flow: Pick<SignInFlow, "start"> | null = null;
  let initializing: Promise<void> | null = null;
  /** The action that runs; at most one at a time, besides an open attempt. */
  let operation: "starting" | "unlocking" | "forgetting" | null = null;
  let attempt: OpenAttempt | null = null;
  let cancelRequested = false;

  let account: Account = SIGNED_OUT;
  let signIn: SignInState = IDLE;
  let lastOutcome: SignInOutcomeView | null = null;
  let deviceKey: DeviceKeyState = "loading";
  let replacementPending = false;
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

  async function initialize(): Promise<void> {
    let opened: AccountSystem;
    try {
      opened = options.openSystem();
    } catch (error) {
      deviceKey = isDeviceKeyError(error, "local_data_folder_missing")
        ? "local_data_folder_missing"
        : "failed";
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
    replacementPending = await readReplacementPending(opened);
    account = await readAccount(opened);
    publish();
  }

  /** Records how a started sign-in ended and brings the window up after a callback. */
  async function finish(
    opened: AccountSystem,
    outcome: SignInOutcome,
  ): Promise<void> {
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
    if (followsCallback(outcome)) {
      try {
        options.focusWindow();
      } catch {
        report("The window could not be brought to the front.");
      }
    }
  }

  async function startSignIn(): Promise<StartSignInResult> {
    if (operation !== null || attempt !== null) {
      return Object.freeze({ outcome: "refused", reason: "busy" });
    }
    const opened = system;
    if (opened === null || deviceKey !== "ready") {
      return Object.freeze({ outcome: "refused", reason: "key_not_ready" });
    }
    operation = "starting";
    cancelRequested = false;
    signIn = STARTING;
    lastOutcome = null;
    publish();
    try {
      let started: SignInStart | null = null;
      try {
        flow ??= opened.createFlow();
        started = await flow.start();
      } catch {
        // `start` never rejects; a flow that cannot be created ends here.
        report("The sign-in could not start.");
      }
      if (started === null || !started.started) {
        const view =
          started === null
            ? Object.freeze({ code: "failed" as const })
            : signInOutcomeView(started.outcome);
        // A start that failed may have written a record that the flow kept
        // or deleted a leftover key.
        account = await readAccount(opened);
        replacementPending = await readReplacementPending(opened);
        signIn = IDLE;
        lastOutcome = view;
        publish();
        return Object.freeze({ outcome: "failed", code: view.code });
      }
      attempt = Object.freeze({ cancel: started.cancel });
      signIn = Object.freeze(
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
        .catch((): SignInOutcome => ({ kind: "failed", reason: "no_answer" }))
        .then((value) => finish(opened, value))
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
    operation = "unlocking";
    try {
      await opened.keyStore.load({ passphrase });
      deviceKey = "ready";
      replacementPending = await readReplacementPending(opened);
      publish();
      return Object.freeze({ outcome: "unlocked" });
    } catch (error) {
      // Nothing about the passphrase is reported: the store's errors are
      // fixed per code, and only the code is read here.
      if (isDeviceKeyError(error, "wrong_passphrase")) {
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
      // Local only, in this part of #94. ADR 0014 removes a device at the
      // API first and deletes its key only after the server confirmed; that
      // needs an access token, which part 3 adds, and part 3 then tells the
      // API to remove the device here. Until then the device stays
      // registered to that account at the API, without a key that can use
      // it, until its 30-day sign-in ends or the account removes it.
      //
      // The record goes first: a key without a record is deleted by the next
      // sign-in, while a record without a key would make the next sign-in
      // name this device as its previous device, for the other account.
      await opened.deviceRecords.delete();
      await opened.keyStore.delete();
      // A new flow keeps nothing of this account in memory: no unsaved
      // record and no account mismatch.
      flow = null;
      account = SIGNED_OUT;
      deviceKey = "ready";
      replacementPending = false;
      lastOutcome = null;
      publish();
      return Object.freeze({ outcome: "forgotten" });
    } catch {
      report("The account could not be forgotten on this device.");
      account = await readAccount(opened);
      replacementPending = await readReplacementPending(opened);
      publish();
      return Object.freeze({ outcome: "failed" });
    } finally {
      operation = null;
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
      initializing ??= initialize().catch(() => {
        report("The account could not be read.");
      });
      return initializing;
    },
    startSignIn,
    cancelSignIn,
    unlockDeviceKey,
    forgetAccount,
  });
}
