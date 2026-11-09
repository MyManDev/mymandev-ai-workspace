// The account of this installation in the main process (ADR 0014, "Sign-in",
// "Revocation, sign-out, and recovery", and "Storage and transport on the
// device"; parts 2c and 3 of #94). It loads the device key once at startup,
// reads the device record to learn whether the installation holds an
// account, creates the device session and refreshes it, starts and cancels
// the sign-in flow on the person's action, unlocks a key that a passphrase
// protects, signs out, removes this device, forgets the account for "This
// is not me" (#149), and, for the device list of #95, revokes another
// device of the account and lifts the registration lock. It also lends the
// device session to the connection client of #26 in the main process: the
// signature of the WebSocket challenge and the close reasons that refuse
// the device. And it
// sends the reads of workspace, chat, and agent data of #27 and #28, of
// invitations and join requests of #95 (`api-reads.ts`), and of the account's
// devices for the device list service (`devices/service.ts`, #95), and the
// writes of the screens of #95 (`api-actions.ts`), for the main process only.
//
// The renderer gets a narrow status only: the account's login, display name,
// and device ID (none of them while the person is signed out or the device
// is not read yet, #195), the pairing code, the authorize URL when the
// browser did not open, and fixed codes. The sign-in code, the verifier,
// signatures, keys, tokens, and the passphrase never reach the status, a
// result, or a message.
import type {
  ApiErrorCode,
  AuthChallengeFrame,
  AuthResponseFrame,
  DeviceId,
} from "@mymandev/protocol";
import type {
  Account,
  AccountStatus,
  ApiOriginState,
  DeviceKeyState,
  DeviceState,
  ForgetResult,
  LiftRegistrationLockResult,
  OtherDeviceRevocation,
  RemoveDeviceResult,
  RevokeOtherDeviceResult,
  SignInOutcomeCode,
  SignInOutcomeView,
  SignInState,
  SignOutResult,
  StartSignInOptions,
  StartSignInResult,
  UnlockResult,
} from "../shared/ipc-contract.ts";
import {
  deviceActionFailure,
  deviceListActionFailure,
  deviceStateOf,
  type OtherDevice,
  signedOutOf,
} from "./account-session.ts";
import { SIGN_IN_START_COOLDOWN_MS } from "../shared/sign-in-timing.ts";
import {
  WORKSPACE_ACTION_BUDGET,
  type WorkspaceActionAnswer,
  type WorkspaceActionBodyArgument,
  type WorkspaceActionName,
  type WorkspaceActionParams,
  type WorkspaceActionResult,
  workspaceActionFailed,
  workspaceActionFailedFor,
  workspaceActionRequest,
} from "./api-actions.ts";
import type { ApiOrigin } from "./api-origin.ts";
import {
  type WorkspaceReadAnswer,
  type WorkspaceReadName,
  type WorkspaceReadParams,
  type WorkspaceReadQuery,
  type WorkspaceReadResult,
  workspaceReadFailed,
  workspaceReadFailureOf,
  workspaceReadRequest,
} from "./api-reads.ts";
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
import type { RegistrationMarkerStore } from "./sign-in/registration-marker.ts";
import type {
  DeviceList,
  DeviceSession,
  DeviceSessionState,
  SessionFailure,
  SessionResult,
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
  | "revokeOtherDevice"
  | "liftRegistrationLock"
  | "signOut"
  | "reportSignOut"
  | "removeDevice"
  | "removalAsksApi"
  | "replacementGraceEnd"
  | "signWebSocketChallenge"
  | "deviceRefused"
  | "request"
>;

/**
 * The answer to the WebSocket `auth.challenge`: the signed `auth.response`
 * frame, or nothing. The frame carries a signature: send it, and never log
 * it.
 */
export type ChallengeAnswer =
  | { readonly ok: true; readonly frame: AuthResponseFrame }
  | { readonly ok: false };

/** The close reasons of the WebSocket that refuse the device (ADR 0014). */
export type DeviceRefusalCode =
  "auth_failed" | "device_revoked" | "sign_in_required";

/** What the service uses once the application is ready. */
export interface AccountSystem {
  readonly keyStore: Pick<DeviceKeyStore, "load" | "status" | "delete">;
  /** The record store over the file that the flow writes. */
  readonly deviceRecords: Pick<DeviceRecordStore, "read" | "delete">;
  /**
   * The registration marker store over the file that the flow writes
   * (#153); "This is not me" deletes the marker.
   */
  readonly registrationMarkers: Pick<RegistrationMarkerStore, "delete">;
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
   * me"), and says what happens to the device at the server (`removal`,
   * `forgetConfirmationDetail`). Resolves to true only for the remove button
   * (`FORGET_CONFIRMATION` and `forgetConfirmed`).
   */
  readonly confirmForget: (
    login: string,
    removal: ForgetRemoval,
  ) => Promise<boolean>;
  /**
   * Asks the person, in a native dialog of the main process, whether to
   * remove this device from the account with this login. Resolves to true
   * only for the remove button (`REMOVE_DEVICE_CONFIRMATION` and
   * `removeDeviceConfirmed`).
   */
  readonly confirmRemoveDevice: (login: string) => Promise<boolean>;
  /**
   * Asks the person, in a native dialog of the main process, whether to
   * revoke another device of the account with this login, as removed or as
   * lost; the dialog names the device's label and platform, and says that a
   * revocation as lost starts the 7-day registration lock. Resolves to true
   * only for the revoke button (`REVOKE_DEVICE_CONFIRMATIONS` and
   * `revokeDeviceConfirmed`).
   */
  readonly confirmRevokeDevice: (
    login: string,
    device: OtherDevice,
    reason: OtherDeviceRevocation,
  ) => Promise<boolean>;
  /**
   * Asks the person, in a native dialog of the main process, whether to lift
   * the registration lock of the account with this login, which the device
   * list reported to end at `lockedUntil` (UTC); the dialog names that time.
   * Resolves to true only for the lift button
   * (`LIFT_REGISTRATION_LOCK_CONFIRMATION` and
   * `liftRegistrationLockConfirmed`).
   */
  readonly confirmLiftRegistrationLock: (
    login: string,
    lockedUntil: string,
  ) => Promise<boolean>;
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
   * last start that opened the browser or offered its URL. With
   * `{ browser: "other" }` the default browser is not opened, and the URL is
   * offered for copying into another browser (#175). Resolves once the
   * browser opened or the URL is ready to copy; the outcome arrives later in
   * the status. Never rejects.
   */
  readonly startSignIn: (
    options?: StartSignInOptions,
  ) => Promise<StartSignInResult>;
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
  /**
   * Revokes another device of the account (#95, D1), for the device list
   * service of the main process, which passes only an active device of its
   * list. It is an action of the person, like a removal: while a sign-in, a
   * sign-out, a removal, "This is not me", an unlock, or another device
   * action runs, or the key loads, it answers `unavailable`; otherwise it
   * takes the `operation` lock, so those answer `busy` meanwhile, and waits
   * for a background refresh. It needs a signed-in device with a ready key
   * (`not_signed_in` otherwise) and refuses this installation's own device
   * (`current_device`). It asks the person with `confirmRevokeDevice`, then
   * the session's `revokeOtherDevice`, once: an uncertain answer is
   * `unknown`, and nothing is sent again on its own. Never rejects.
   */
  readonly revokeOtherDevice: (
    device: OtherDevice,
    reason: OtherDeviceRevocation,
  ) => Promise<RevokeOtherDeviceResult>;
  /**
   * Lifts the account's registration lock (#95, D1 and D5b), for the device
   * list service, which asks only while its last list reported a lock,
   * ending at `lockedUntil`. It follows the rules of `revokeOtherDevice`,
   * with the confirmation `confirmLiftRegistrationLock`, which names that
   * time, and the session's `liftRegistrationLock`. Never rejects.
   */
  readonly liftRegistrationLock: (
    lockedUntil: string,
  ) => Promise<LiftRegistrationLockResult>;
  /**
   * Calls `listener` after a device action of the person ended that may
   * have changed the account's devices: a sign-out, a removal of this
   * device, "This is not me", a revocation of another device, or a lift of
   * the registration lock, with any result but a refusal before it began
   * (`refused`) or a kept confirmation (`cancelled`). The device list
   * service reloads then (#95). The result removes the listener.
   */
  readonly onDeviceAction: (listener: () => void) => () => void;
  /**
   * Signs the WebSocket `auth.challenge` with the device session, for the
   * connection client of the main process (#26); never for the renderer.
   * While a key replacement is pending, it authenticates once first, which
   * resolves the replacement, and signs again. Never rejects.
   */
  readonly signWebSocketChallenge: (
    challenge: AuthChallengeFrame,
  ) => Promise<ChallengeAnswer>;
  /**
   * Applies a close reason of the WebSocket to the device session, for the
   * device that the connection authenticated as (#26): `device_revoked`
   * deletes the key and stops local execution, and `sign_in_required` and
   * `auth_failed` keep the key until a sign-in. A refusal for a device that
   * the installation no longer holds is ignored. Never rejects.
   */
  readonly deviceRefused: (
    code: DeviceRefusalCode,
    deviceId: DeviceId,
  ) => Promise<void>;
  /**
   * Sends one read of the allowlist in `api-reads.ts` with the device
   * session, for the main process only (#27, #28); never for the renderer.
   * The answer is parsed with the protocol's response schema and its size
   * is capped. It takes no `operation` lock: while a sign-in, a sign-out,
   * "This is not me", a device removal, or an unlock runs, it answers
   * `unavailable` (also while a revocation of another device or a lift of
   * the registration lock holds the lock), and the caller tries again
   * later. A renewal (D4 on #95) pauses it only during its start and from
   * its code on: while the browser is open, and after a cancel or the
   * timeout there, reads go on (#233). It waits for the startup refresh
   * and a background refresh to end, like an action, but actions do not
   * wait for a read on its way.
   * Its answer is dropped as
   * `not_signed_in` when no device is signed in any more, and as
   * `unavailable` when another device is. Data is also dropped as
   * `unavailable` when such an action began while it was on its way, also
   * one that has ended since, or the code of a renewal arrived, or when
   * the account or the device changed
   * meanwhile; a failure carries no data and is answered as it is, also when
   * its own refusal changed the device. Never rejects.
   */
  readonly readWorkspaceData: <N extends WorkspaceReadName>(
    name: N,
    params: WorkspaceReadParams[N],
    query?: WorkspaceReadQuery[N],
  ) => Promise<WorkspaceReadResult<WorkspaceReadAnswer[N]>>;
  /**
   * Reads the account's devices and the end of a registration lock in force
   * (`GET /devices`, the session's `listDevices`; D4 and D5b of #95), for
   * the device list service of the main process only; never for the
   * renderer. It is a read like `readWorkspaceData`, with the same rules:
   * no `operation` lock, `unavailable` while an action of the person or a
   * sign-in runs or began while it was on its way (but not during the
   * browser part of a renewal), a wait for a background refresh, and an
   * answer dropped when the account or the device changed.
   * Never rejects.
   */
  readonly readDeviceList: () => Promise<WorkspaceReadResult<DeviceList>>;
  /**
   * Sends one write of the allowlist in `api-actions.ts` with the device
   * session, for the main process only (#95, D1); never for the renderer.
   * The path parameters and the body are checked with the entry's schemas
   * first, and the answer is parsed with its schema. It takes no
   * `operation` lock and answers `unavailable` while a sign-in, a
   * sign-out, "This is not me", a device removal, or an unlock runs (also
   * while a device action of the device list holds the lock), but not
   * during the browser part of a renewal (#233), as a read; and it waits
   * for the startup refresh and a background refresh, as a read does.
   * It is sent once: an uncertain answer is never sent again and answers
   * `unknown`, as does a successful answer when the account or the device
   * changed while it was on its way, or when such an action or the code of
   * a renewal came meanwhile. Writes beyond `WORKSPACE_ACTION_BUDGET`
   * answer `too_soon` without a request. An invitation code in the body or
   * the answer is never kept, logged, or published (D2). The body is
   * required for a write with one and not allowed for one without. Never
   * rejects.
   */
  readonly sendWorkspaceAction: <N extends WorkspaceActionName>(
    name: N,
    params: WorkspaceActionParams[N],
    ...body: WorkspaceActionBodyArgument<N>
  ) => Promise<WorkspaceActionResult<WorkspaceActionAnswer[N]>>;
}

// The cooldown lives in a shared module, so that the renderer's delay for
// "Use another browser" follows it.
export { SIGN_IN_START_COOLDOWN_MS };

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
 * the folder dialog of the repositories. Its detail depends on the case
 * (`forgetConfirmationDetail`). `forgetConfirmed` reads its answer.
 */
export const FORGET_CONFIRMATION = Object.freeze({
  type: "warning",
  buttons: Object.freeze(["Remove from this installation", "Keep"] as const),
  defaultId: 1,
  cancelId: 1,
  noLink: true,
  title: "This is not me",
} as const);

/**
 * What "This is not me" does to the device at the server, as the main
 * process knows it before the person confirms (#198), from the session's
 * `removalAsksApi`:
 * - `server_first`: the session's `removeDevice` asks the API to remove
 *   the device first. When the API cannot be reached or does not remove it,
 *   the device is forgotten on this installation only, as below.
 * - `local_only`: the device cannot ask the API: it is signed out, its key
 *   waits for its passphrase or cannot be used, the API asks for a sign-in
 *   or refused the key (also behind a refused sign-in with another GitHub
 *   account), or there is no session. The device is forgotten on this
 *   installation only and stays listed for its account at the API, without
 *   a key (ADR 0014, update of 2026-11-06).
 */
export type ForgetRemoval = "server_first" | "local_only";

/** The detail of the confirmation for each case of `ForgetRemoval`. */
export const FORGET_CONFIRMATION_DETAILS: Readonly<
  Record<ForgetRemoval, string>
> = Object.freeze({
  server_first:
    "This device is signed in, so it is first removed from that GitHub account on the server. If the server cannot be reached or does not remove it, the device stays listed for that account, without a key. Either way, the device key and the account are then deleted on this computer, and you can sign in with your own GitHub account.",
  local_only:
    'This device cannot use its key with the server now, so the server cannot remove it from that GitHub account: it stays listed for that account, without a key. To remove it there, choose Keep; whoever owns the account then enters the passphrase of the device key or signs in with that account on this device, as the panel asks, and chooses "Remove this device". Otherwise, the device key and the account are deleted on this computer only, and you can sign in with your own GitHub account. Either way, whoever owns the account can also remove this device from another of their devices, with "Remove" in the device list on the Account screen.',
});

/** The detail of the confirmation for the case. */
export function forgetConfirmationDetail(removal: ForgetRemoval): string {
  return FORGET_CONFIRMATION_DETAILS[removal];
}

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
const HIDDEN: Account = Object.freeze({ kind: "hidden" });
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

/**
 * Only the parts of the account that the renderer may see. The sign-in
 * expiry comes from the device record or from the sign-in's answer, which
 * both hold it only in the protocol's form (`UtcTimestampSchema`): the record
 * store reads a record with any other value as corrupt, and the flow does
 * not accept such an answer. So it reaches the status only when it is valid
 * (D4 on #95), and the contract checks it again.
 */
function signedIn(
  account: Pick<
    SignedInAccount,
    "login" | "displayName" | "deviceId" | "signInExpiresAt"
  >,
): Account {
  return Object.freeze({
    kind: "signed_in",
    login: account.login,
    displayName: account.displayName,
    deviceId: account.deviceId,
    signInExpiresAt: account.signInExpiresAt,
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
const LIST_ACTION_FAILED = Object.freeze({
  outcome: "failed" as const,
  reason: "failed" as const,
});
const LIST_ACTION_UNKNOWN = Object.freeze({ outcome: "unknown" as const });

const CHALLENGE_NOT_SIGNED: ChallengeAnswer = Object.freeze({ ok: false });

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
  const deviceActionListeners = new Set<() => void>();

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
    | "revoking"
    | "lifting"
    | null = null;
  /**
   * The work that runs in the background: the startup (from the key's load
   * until its session refresh has ended) and the refresh after an unlock.
   * A refresh may report a sign-out or retry a removal, which use the key
   * and may write the record, so every action of the person waits until
   * none runs (`backgroundSettled`). Each run never rejects.
   */
  const background = new Set<Promise<void>>();
  let attempt: OpenAttempt | null = null;
  let cancelRequested = false;
  /** Counts the attempts, so that a late callback of an old one changes nothing. */
  let generation = 0;
  /** Whether the browser of the current attempt posted to the listener. */
  let callbackArrived = false;
  /**
   * Whether reads and writes go on while the attempt is open (#233): during
   * the browser part of a renewal, the sign-in of a device that is signed
   * in, until the browser posts the code. The flow changes the key and the
   * record only after that (`pauseReadsOfAttempt`).
   */
  let attemptKeepsReads = false;
  /**
   * When the last start that opened the browser or offered its URL
   * returned, or null.
   */
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
   * Whether the person signed out on this device (P-65, `signedOutOf`), also
   * while the device state names something else first, for example a key
   * that waits for its passphrase or a refused sign-in with another account.
   */
  let deviceSignedOut = false;
  /**
   * Counts the reads of the account that may publish it, so that a read
   * that a later one overtook changes nothing.
   */
  let accountReads = 0;
  /**
   * Counts the changes that may end what a workspace read is for: every
   * action of the person that may change the account or the device (a
   * sign-in, a sign-out, "This is not me", a device removal, an unlock)
   * when it begins, the code of a renewal whose reads went on until then
   * (`pauseReadsOfAttempt`), and every published change of the account,
   * the key's state, or the device, except a device that becomes signed
   * in. A read takes it before its request and drops the answer when it
   * changed, also when the action that changed it has ended meanwhile.
   */
  let accountChanges = 0;
  let revision = 0;
  /** The account behind the last status, also while the status hides it. */
  let publishedAccount = account;
  let current = snapshot();

  /**
   * Whether the status hides the account (#195): while the person is signed
   * out on this device, where the record and the key stay (P-65), and while
   * that is not known yet, before the session has read the device or when
   * there is no session. After a refused sign-in with another account, the
   * outcome's `deviceLogin` still names the login, and only the login.
   * "This is not me" reads the login from `account`, in the main process.
   */
  function accountHidden(): boolean {
    return deviceSignedOut || device === "starting" || session === null;
  }

  function snapshot(): AccountStatus {
    return Object.freeze({
      revision,
      account:
        account.kind === "signed_in" && accountHidden() ? HIDDEN : account,
      signIn,
      lastOutcome,
      deviceKey,
      replacementPending,
      apiOrigin,
      device,
    });
  }

  function publish(): void {
    const previous = current;
    const previousAccount = publishedAccount;
    revision += 1;
    current = snapshot();
    publishedAccount = account;
    // The account itself counts, not whether the status hides it, which
    // follows the device and the sign-out (`accountHidden`).
    if (
      JSON.stringify(previousAccount) !== JSON.stringify(account) ||
      previous.deviceKey !== current.deviceKey ||
      (previous.device !== current.device && current.device !== "signed_in")
    ) {
      accountChanges += 1;
    }
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

  function stopLocalExecution(): void {
    try {
      options.stopLocalExecution?.();
    } catch {
      report("The local execution could not be stopped.");
    }
  }

  /** Follows the state of the device session. */
  function sessionChanged(state: DeviceSessionState): void {
    const next = deviceStateOf(state);
    const nextSignedOut = signedOutOf(state);
    if (next === device && nextSignedOut === deviceSignedOut) {
      return;
    }
    if (nextSignedOut && !deviceSignedOut) {
      // #195: the outcome of the last sign-in ("now signed in to GitHub
      // as") ends with the sign-out. It is kept in memory only, so it does
      // not come back after a restart either.
      lastOutcome = null;
    }
    const changed = next !== device;
    deviceSignedOut = nextSignedOut;
    device = next;
    if (changed && next === "revoked") {
      // ADR 0014: a revoked device stops local execution. The session
      // publishes `revoked` before it deletes the key.
      stopLocalExecution();
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
      const state = created.state();
      device = deviceStateOf(state);
      deviceSignedOut = signedOutOf(state);
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
    // The flow calls this before it replaces the key.
    pauseReadsOfAttempt();
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

  /**
   * Whether a sign-in whose attempt opens now renews the sign-in of the
   * device that is signed in (D4 on #95): a signed-in account and device, a
   * ready key, and no pending key replacement.
   */
  function renewing(): boolean {
    return (
      account.kind === "signed_in" &&
      device === "signed_in" &&
      deviceKey === "ready" &&
      !replacementPending
    );
  }

  /**
   * Ends the reads and writes of the open attempt (#233), because the key
   * and the record may change from now on: a later one answers
   * `unavailable` until the outcome, and the answer of one on its way is
   * dropped (`accountChanges`).
   */
  function pauseReadsOfAttempt(): void {
    if (attemptKeepsReads) {
      attemptKeepsReads = false;
      accountChanges += 1;
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
    openBrowser: boolean,
  ): Promise<SignInStart | null> {
    try {
      held?.signInStarted();
    } catch {
      report("The device session could not record the sign-in.");
    }
    let started: SignInStart | null = null;
    try {
      flow ??= opened.createFlow();
      started = await flow.start({
        onCallback: () => callback(current),
        openBrowser,
      });
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

  /**
   * The case of "This is not me": `server_first` only when the session's
   * `removeDevice` would ask the API now (`removalAsksApi`), and
   * `local_only` without a session or when the session fails.
   */
  async function forgetRemovalOf(
    held: AccountSession | null,
  ): Promise<ForgetRemoval> {
    if (held === null) {
      return "local_only";
    }
    try {
      return (await held.removalAsksApi()) ? "server_first" : "local_only";
    } catch {
      return "local_only";
    }
  }

  /**
   * A `replacement_pending` view with the end of the grace period of an
   * uncertain sign-in as `retryAfter`, while it runs (#199); the view as it
   * is otherwise, also when the session fails.
   */
  async function withRetryAfter(
    view: SignInOutcomeView,
    held: AccountSession,
  ): Promise<SignInOutcomeView> {
    let end: string | null;
    try {
      end = await held.replacementGraceEnd();
    } catch {
      end = null;
    }
    return end === null ? view : Object.freeze({ ...view, retryAfter: end });
  }

  /** Records how a started sign-in ended. */
  async function finish(
    opened: AccountSystem,
    held: AccountSession | null,
    outcome: SignInOutcome,
  ): Promise<void> {
    // A cancel or the timeout of the browser part changed neither the key
    // nor the record, so a renewal's reads go on; every other outcome
    // pauses them, also one that came without the code (`callback`).
    if (outcome.kind !== "cancelled" && outcome.kind !== "timed_out") {
      pauseReadsOfAttempt();
    }
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
    attemptKeepsReads = false;
    signIn = IDLE;
    lastOutcome = view;
    publish();
  }

  async function startSignIn(
    options?: StartSignInOptions,
  ): Promise<StartSignInResult> {
    // The default browser opens unless the person asked for the address.
    const openBrowser = options?.browser !== "other";
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
    accountChanges += 1;
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
      let started = await startFlow(opened, held, current, openBrowser);
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
        started = await startFlow(opened, held, current, openBrowser);
      }
      if (started === null || !started.started) {
        const refusedView =
          started === null
            ? Object.freeze({ code: "failed" as const })
            : signInOutcomeView(started.outcome);
        // #199: a start refused during the grace period of an uncertain
        // sign-in says when a new sign-in can start.
        const view =
          refusedView.code === "replacement_pending" && held !== null
            ? await withRetryAfter(refusedView, held)
            : refusedView;
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
      // The flow opened the browser, or offers the URL: it could not open
      // it, or the person asked for the URL.
      lastBrowserStart = now();
      attempt = Object.freeze({ cancel: started.cancel });
      // #233: the reads and writes of a renewal go on while the browser is
      // open, until the code arrives (`callback`), which can be before
      // `start` returns. Every other sign-in, for example the first of a
      // new device or one after a sign-out, pauses them until its outcome.
      attemptKeepsReads = !callbackArrived && renewing();
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
                  // Why the URL is offered, so that the panel words it
                  // also after it was shown again.
                  browser: openBrowser ? "default" : "other",
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
    accountChanges += 1;
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

  /**
   * Tells the listeners of `onDeviceAction` that a device action of the
   * person ended that may have changed the account's devices: every result
   * but a refusal before it began and a kept confirmation. It runs after the
   * action released its lock, so that a read that a listener starts is not
   * answered `unavailable` for the action itself.
   */
  function deviceActionEnded(outcome: string): void {
    if (outcome === "refused" || outcome === "cancelled") {
      return;
    }
    for (const listener of [...deviceActionListeners]) {
      try {
        listener();
      } catch {
        report("A device action listener failed.");
      }
    }
  }

  async function forgetAccount(): Promise<ForgetResult> {
    const result = await forgetAccountNow();
    deviceActionEnded(result.outcome);
    return result;
  }

  async function forgetAccountNow(): Promise<ForgetResult> {
    if (operation !== null || attempt !== null || deviceKey === "loading") {
      return Object.freeze({ outcome: "refused", reason: "busy" });
    }
    const opened = system;
    if (opened === null || account.kind !== "signed_in") {
      return Object.freeze({ outcome: "refused", reason: "not_signed_in" });
    }
    operation = "forgetting";
    accountChanges += 1;
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
      // misbehaves cannot delete the key without the person. It says
      // whether the server removes the device first (#198).
      const removal = await forgetRemovalOf(session);
      let confirmed: boolean;
      try {
        confirmed = await options.confirmForget(login, removal);
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
      // use it, and nothing revokes it on its own (ADR 0014, update of
      // 2026-11-06). The removal itself only deletes files after the API
      // confirmed it, so it can never bring the account back either.
      let removedAtServer = false;
      if (session !== null) {
        try {
          const removal = await session.removeDevice();
          removedAtServer = removal.ok && removal.value === "removed";
        } catch {
          report("The device could not be removed at the server.");
        }
      }
      // The record goes first: a record without a key would make the next
      // sign-in name this device as its previous device, for the other
      // account. A key without a record is deleted by the next sign-in
      // unless the registration marker names it, so the marker goes right
      // after the record: otherwise the next sign-in would send this
      // account's key again (#153). A marker that cannot be deleted does not
      // stop the rest; once the key is gone, it names no key.
      accountReads += 1;
      await opened.deviceRecords.delete();
      try {
        await opened.registrationMarkers.delete();
      } catch {
        report("The registration marker could not be deleted.");
      }
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
    kind: "signing_out" | "removing",
  ): Promise<AccountSession | ActionRefusal> {
    if (operation !== null || attempt !== null || deviceKey === "loading") {
      return ACTION_BUSY;
    }
    operation = kind;
    accountChanges += 1;
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
    const result = await signOutNow();
    deviceActionEnded(result.outcome);
    return result;
  }

  async function signOutNow(): Promise<SignOutResult> {
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
    const result = await removeDeviceNow();
    deviceActionEnded(result.outcome);
    return result;
  }

  async function removeDeviceNow(): Promise<RemoveDeviceResult> {
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
      // key that waits for its passphrase cannot sign. A signed-out device
      // may name a refused sign-in first (`account_mismatch`, #195).
      if (deviceSignedOut) {
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

  // ---- The account's other devices (#95, D1) -----------------------------

  /** The signed-in device that a device action of the device list acts from. */
  interface SignedInDevice {
    readonly held: AccountSession;
    readonly login: string;
    readonly deviceId: string;
  }

  /**
   * Starts a device action of the device list (`revokeOtherDevice`,
   * `liftRegistrationLock`): `unavailable` while an action of the person or
   * a sign-in runs or the key loads, and otherwise the `operation` lock, a
   * wait for a background refresh, and `not_signed_in` unless a signed-in
   * device with a ready key acts. The caller releases the lock in `finally`
   * when the answer is not `unavailable`.
   */
  async function beginDeviceListAction(
    kind: "revoking" | "lifting",
  ): Promise<SignedInDevice | "unavailable" | "not_signed_in"> {
    if (operation !== null || attempt !== null || deviceKey === "loading") {
      return "unavailable";
    }
    operation = kind;
    await backgroundSettled();
    // These actions change no device of this installation and no account,
    // so they do not count as changes for the reads (`accountChanges`); a
    // read or a write meanwhile answers `unavailable` while the lock holds.
    // A device that is `signed_in` is never signed out: the device state and
    // the sign-out flag come from the same state of the session, and that
    // state carries no `signedOut`. The key's state comes from the key
    // store's load instead, so it is checked on its own.
    if (
      system === null ||
      session === null ||
      account.kind !== "signed_in" ||
      device !== "signed_in" ||
      deviceKey !== "ready"
    ) {
      return "not_signed_in";
    }
    return {
      held: session,
      login: account.login,
      deviceId: account.deviceId,
    };
  }

  async function revokeOtherDevice(
    target: OtherDevice,
    reason: OtherDeviceRevocation,
  ): Promise<RevokeOtherDeviceResult> {
    const result = await revokeOtherDeviceNow(target, reason);
    deviceActionEnded(result.outcome);
    return result;
  }

  async function revokeOtherDeviceNow(
    target: OtherDevice,
    reason: OtherDeviceRevocation,
  ): Promise<RevokeOtherDeviceResult> {
    const begun = await beginDeviceListAction("revoking");
    if (begun === "unavailable") {
      return Object.freeze({ outcome: "refused", reason: "unavailable" });
    }
    let sent = false;
    try {
      if (begun === "not_signed_in") {
        return Object.freeze({ outcome: "refused", reason: "not_signed_in" });
      }
      // "Remove this device" removes this installation's own device; a
      // revocation here would leave its key and record behind.
      if (target.id === begun.deviceId) {
        return Object.freeze({ outcome: "refused", reason: "current_device" });
      }
      // The confirmation runs in the main process, so that a renderer that
      // misbehaves cannot revoke a device without the person.
      let confirmed: boolean;
      try {
        confirmed = await options.confirmRevokeDevice(
          begun.login,
          target,
          reason,
        );
      } catch {
        report("The confirmation could not be shown.");
        return LIST_ACTION_FAILED;
      }
      if (!confirmed) {
        return Object.freeze({ outcome: "cancelled" });
      }
      // Sent once: an uncertain answer is never sent again on its own.
      sent = true;
      const result = await begun.held.revokeOtherDevice(target.id, reason);
      if (result.ok) {
        return Object.freeze({ outcome: "revoked", reason });
      }
      const failure = deviceListActionFailure(result);
      return failure === "unknown"
        ? LIST_ACTION_UNKNOWN
        : Object.freeze({ outcome: "failed", reason: failure });
    } catch {
      report("The device could not be revoked.");
      return sent ? LIST_ACTION_UNKNOWN : LIST_ACTION_FAILED;
    } finally {
      operation = null;
    }
  }

  async function liftRegistrationLock(
    lockedUntil: string,
  ): Promise<LiftRegistrationLockResult> {
    const result = await liftRegistrationLockNow(lockedUntil);
    deviceActionEnded(result.outcome);
    return result;
  }

  async function liftRegistrationLockNow(
    lockedUntil: string,
  ): Promise<LiftRegistrationLockResult> {
    const begun = await beginDeviceListAction("lifting");
    if (begun === "unavailable") {
      return Object.freeze({ outcome: "refused", reason: "unavailable" });
    }
    let sent = false;
    try {
      if (begun === "not_signed_in") {
        return Object.freeze({ outcome: "refused", reason: "not_signed_in" });
      }
      let confirmed: boolean;
      try {
        confirmed = await options.confirmLiftRegistrationLock(
          begun.login,
          lockedUntil,
        );
      } catch {
        report("The confirmation could not be shown.");
        return LIST_ACTION_FAILED;
      }
      if (!confirmed) {
        return Object.freeze({ outcome: "cancelled" });
      }
      sent = true;
      const result = await begun.held.liftRegistrationLock();
      if (result.ok) {
        return Object.freeze({ outcome: "lifted" });
      }
      const failure = deviceListActionFailure(result);
      return failure === "unknown"
        ? LIST_ACTION_UNKNOWN
        : Object.freeze({ outcome: "failed", reason: failure });
    } catch {
      report("The registration lock could not be lifted.");
      return sent ? LIST_ACTION_UNKNOWN : LIST_ACTION_FAILED;
    } finally {
      operation = null;
    }
  }

  async function signWebSocketChallenge(
    challenge: AuthChallengeFrame,
  ): Promise<ChallengeAnswer> {
    const held = session;
    if (held === null) {
      return CHALLENGE_NOT_SIGNED;
    }
    try {
      let signed = await held.signWebSocketChallenge(challenge);
      // The connection is not the person's action, so it takes no
      // `operation` lock and never makes an action answer `busy`. Signing
      // sends no request; the authentication below does, so it is left out
      // while an action, a sign-in, or a background refresh uses the key,
      // and the connection backs off and tries again.
      if (
        !signed.ok &&
        signed.reason === "replacement_pending" &&
        operation === null &&
        attempt === null &&
        background.size === 0
      ) {
        // Only an authentication learns which key the API holds; a token
        // confirms or abandons the replacement as far as the API's answers
        // allow.
        const authenticated = await held.authenticate();
        void refreshAccount().catch(() => {
          report("The account could not be read.");
        });
        if (authenticated.ok) {
          signed = await held.signWebSocketChallenge(challenge);
        }
      }
      return signed.ok
        ? Object.freeze({ ok: true, frame: signed.value })
        : CHALLENGE_NOT_SIGNED;
    } catch {
      report("The connection's challenge could not be signed.");
      return CHALLENGE_NOT_SIGNED;
    }
  }

  /**
   * Whether an action of the person or a sign-in runs that may change or end
   * the account: a read is then left out. The browser part of a renewal
   * changes neither, so its reads go on (#233, `attemptKeepsReads`); its
   * start still pauses them, because the flow may finish an earlier key
   * replacement or write a record that it kept.
   */
  function readsPaused(): boolean {
    return operation !== null || (attempt !== null && !attemptKeepsReads);
  }

  /**
   * Sends one read with the device session, by the rules of
   * `readWorkspaceData`, which `readDeviceList` shares. It may reject when
   * the session throws; each caller reports that with its own message.
   */
  async function readWith<T>(
    send: (held: AccountSession) => Promise<SessionResult<T | null>>,
  ): Promise<WorkspaceReadResult<T>> {
    // Reads are not the person's actions: they take no `operation` lock
    // and never make an action answer `busy`. They wait for a background
    // refresh, which may report a sign-out or retry a removal with the
    // key, so that they never overlap it.
    if (readsPaused()) {
      return workspaceReadFailed("unavailable");
    }
    await backgroundSettled();
    if (readsPaused() || deviceKey === "loading") {
      return workspaceReadFailed("unavailable");
    }
    const held = session;
    if (system === null || held === null || account.kind !== "signed_in") {
      return workspaceReadFailed("not_signed_in");
    }
    const deviceId = account.deviceId;
    const changes = accountChanges;
    const replacementWasPending = replacementPending;
    const result = await send(held);
    if (replacementWasPending) {
      // A token may have confirmed or abandoned the key's replacement.
      void refreshAccount().catch(() => {
        report("The account could not be read.");
      });
    }
    // The answer belongs to the device that asked: when no device or
    // another one is signed in now, it is dropped.
    if (account.kind !== "signed_in") {
      return workspaceReadFailed("not_signed_in");
    }
    if (account.deviceId !== deviceId) {
      return workspaceReadFailed("unavailable");
    }
    // A failure carries no data, so it is answered as it is, also when
    // the request's own refusal (for example `sign_in_required`) changed
    // the device meanwhile.
    if (!result.ok) {
      return workspaceReadFailed(workspaceReadFailureOf(result));
    }
    // Data is dropped when the account or the device changed meanwhile,
    // or an action that may change them began, also one that has ended
    // since (`accountChanges`). Actions do not wait for a read on its
    // way; this check makes its answer harmless instead.
    if (accountChanges !== changes) {
      return workspaceReadFailed("unavailable");
    }
    if (result.value === null) {
      return workspaceReadFailed("failed");
    }
    return Object.freeze({ ok: true, value: result.value });
  }

  async function readWorkspaceData<N extends WorkspaceReadName>(
    name: N,
    params: WorkspaceReadParams[N],
    query?: WorkspaceReadQuery[N],
  ): Promise<WorkspaceReadResult<WorkspaceReadAnswer[N]>> {
    try {
      const call = workspaceReadRequest(name, params, query);
      if (call === null) {
        return workspaceReadFailed("failed");
      }
      return await readWith((held) => held.request(call));
    } catch {
      report("The workspace data could not be read.");
      return workspaceReadFailed("unavailable");
    }
  }

  async function readDeviceList(): Promise<WorkspaceReadResult<DeviceList>> {
    try {
      return await readWith((held) => held.listDevices());
    } catch {
      report("The device list could not be read.");
      return workspaceReadFailed("unavailable");
    }
  }

  async function deviceRefused(
    code: DeviceRefusalCode,
    deviceId: DeviceId,
  ): Promise<void> {
    const held = session;
    if (held === null) {
      return;
    }
    try {
      sessionChanged(await held.deviceRefused(code, deviceId));
    } catch {
      report("The device session could not apply the connection's refusal.");
      // ADR 0014: a revoked device stops local execution, also when the
      // session failed to delete the key.
      if (code === "device_revoked" && device !== "revoked") {
        stopLocalExecution();
      }
    }
  }

  // ---- Workspace actions (#95, D1 and D2) --------------------------------

  /** When each write within the budget's window was sent, the oldest first. */
  const sentWrites: number[] = [];

  /** How long until the budget allows one more write; 0 when it does now. */
  function writeBudgetWait(at: number): number {
    const { writes, windowMs } = WORKSPACE_ACTION_BUDGET;
    while (
      sentWrites.length > 0 &&
      at - (sentWrites[0] as number) >= windowMs
    ) {
      sentWrites.shift();
    }
    return sentWrites.length < writes
      ? 0
      : (sentWrites[0] as number) + windowMs - at;
  }

  async function sendWorkspaceAction<N extends WorkspaceActionName>(
    name: N,
    params: WorkspaceActionParams[N],
    ...body: WorkspaceActionBodyArgument<N>
  ): Promise<WorkspaceActionResult<WorkspaceActionAnswer[N]>> {
    let sent = false;
    try {
      // The types do not hold at runtime: the body is checked with the
      // entry's schema, and a body for a write without one is refused.
      const call = workspaceActionRequest(
        name,
        params,
        (body as readonly unknown[])[0],
      );
      if (call === null) {
        return workspaceActionFailed("invalid");
      }
      // As a read: no `operation` lock, no request while an action of the
      // person or a sign-in may change the account, and none during a
      // background refresh that uses the key.
      if (readsPaused()) {
        return workspaceActionFailed("unavailable");
      }
      await backgroundSettled();
      if (readsPaused() || deviceKey === "loading") {
        return workspaceActionFailed("unavailable");
      }
      const held = session;
      if (system === null || held === null || account.kind !== "signed_in") {
        return workspaceActionFailed("not_signed_in");
      }
      const at = now();
      const wait = writeBudgetWait(at);
      if (wait > 0) {
        return workspaceActionFailed("too_soon", wait);
      }
      // Counted before the request, so that writes started together count
      // at once, and also when the session sends nothing: the budget limits
      // the token requests too.
      sentWrites.push(at);
      const deviceId = account.deviceId;
      const changes = accountChanges;
      const replacementWasPending = replacementPending;
      sent = true;
      // Sent once. An uncertain answer is never sent again on its own: a
      // second invitation, for example, would revoke the first one and
      // lose its code.
      const result = await held.request(call);
      if (replacementWasPending) {
        // A token may have confirmed or abandoned the key's replacement.
        void refreshAccount().catch(() => {
          report("The account could not be read.");
        });
      }
      // A failure carries no data, so it is answered as it is.
      if (!result.ok) {
        return workspaceActionFailedFor(result);
      }
      // The answer belongs to the account and the device that sent it: when
      // they changed meanwhile, or an action that may change them began, it
      // is not passed on, and the write's effect is not known to the caller.
      if (
        account.kind !== "signed_in" ||
        account.deviceId !== deviceId ||
        accountChanges !== changes
      ) {
        return workspaceActionFailed("unknown");
      }
      if (call.answer !== "empty" && result.value === null) {
        return workspaceActionFailed("unknown");
      }
      return Object.freeze({
        ok: true,
        value: result.value as WorkspaceActionAnswer[N],
      });
    } catch {
      // A fixed message: never the error, which might hold the body. Before
      // the request, only a value that throws when it is read can fail.
      report("A workspace action could not be sent.");
      return workspaceActionFailed(sent ? "unknown" : "invalid");
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
    revokeOtherDevice,
    liftRegistrationLock,
    onDeviceAction: (listener: () => void) => {
      const entry = () => listener();
      deviceActionListeners.add(entry);
      return () => {
        deviceActionListeners.delete(entry);
      };
    },
    signWebSocketChallenge,
    deviceRefused,
    readWorkspaceData,
    readDeviceList,
    sendWorkspaceAction,
  });
}
