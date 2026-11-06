// The device session of the main process (ADR 0014, "Device key and
// authentication", "Revocation, sign-out, and recovery", and "Storage and
// transport on the device"). It is part 3 of #94: access tokens, the
// pending key replacement, the device states, sign-out, removing this
// device, the device list, and the signature of the WebSocket challenge.
//
// It joins the device key store, the device record, and the sign-out
// marker. Access tokens stay in this module's memory: no function returns
// one, and nothing is logged. A message for `onError` is fixed text. The
// only value that carries a signature is the `auth.response` frame of
// `signWebSocketChallenge`, which the WebSocket client sends.
import {
  AccessTokenResponseSchema,
  type ApiErrorCode,
  type ApiRoute,
  type AuthChallengeFrame,
  type AuthResponseFrame,
  AUTH_ROUTES,
  ChallengeResponseSchema,
  type DeviceId,
  type DeviceListItem,
  DeviceListResponseSchema,
  type RevokeDeviceRequest,
  routePath,
  type UserId,
} from "@mymandev/protocol";
import type * as z from "zod";
import type { ApiOrigin } from "../api-origin.ts";
import {
  type DeviceKeyErrorCode,
  isDeviceKeyError,
} from "../device-key/errors.ts";
import type { DeviceKey } from "../device-key/signing-key.ts";
import type { DeviceKeys, DeviceKeyStore } from "../device-key/store.ts";
import type {
  DeviceRecord,
  DeviceRecordRead,
  DeviceRecordStore,
} from "../device-record.ts";
import type { ScheduleTimer } from "../runtime.ts";
import { type ApiAnswer, type ApiFetch, callApi } from "./api-call.ts";
import {
  NO_SESSION_NOTES,
  type SessionNotes,
  type SessionNotesStore,
} from "./session-notes.ts";
import type { SignOutMarker, SignOutMarkerStore } from "./sign-out-marker.ts";
import { webSocketAuthResponse } from "./websocket-auth.ts";

/** ADR 0014, "Lifetimes": an access token is valid for 15 minutes and never extended. */
export const ACCESS_TOKEN_LIFETIME_MS = 15 * 60_000;

/**
 * A cached token is used until this long before it expires. The lifetime is
 * counted on this device's clock from before the request that minted it, so
 * a difference between the clocks of the device and the API does not
 * matter.
 */
export const ACCESS_TOKEN_RENEW_MARGIN_MS = 60_000;

/**
 * After a sign-in whose outcome is unknown, the API may still commit it, so
 * for this long the new key is not discarded although the previous key
 * authenticates.
 */
export const REPLACEMENT_GRACE_MS = 10 * 60_000;

/**
 * When the API first refuses both keys of a pending replacement, they count
 * as lost only if a round at least this much later refuses both again, so
 * that a short outage of the API (for example its challenges lost in a
 * deploy) never deletes a key that it holds.
 */
export const LOST_KEY_WAIT_MS = 10 * 60_000;

/**
 * A first refusal of both keys counts for this long. An older one says
 * nothing about the API now, so the next refusal starts the wait again: the
 * keys count as lost only after two refusals between `LOST_KEY_WAIT_MS` and
 * a day apart, with no authentication between them.
 */
export const KEYS_REFUSED_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Why a call of the session failed:
 *
 * - `api_origin_unset`, `api_origin_invalid`: see `resolveApiOrigin`.
 * - `no_device`: no device that this installation can use: no record, or
 *   a device that was revoked or removed in this session. A GitHub sign-in
 *   registers one.
 * - `key_lost`: a record without its device's key: the key file is gone,
 *   the loaded key is not the record's device's key, or both keys of a
 *   pending replacement were refused (see `mint`). The record is kept, and
 *   the next GitHub sign-in registers a new device that names the record's
 *   device, which the API revokes as `replaced`.
 * - `key_not_loaded`: a record and a key file, but the key is not loaded
 *   (for example its passphrase was not entered yet).
 * - `record_unreadable`: the record cannot be read, or it is corrupt while a
 *   key file exists.
 * - `key_store_failed`: the key store failed; with `keyError` when it raised
 *   a `DeviceKeyError`.
 * - `signed_out`: the person signed out; the key is not used until the next
 *   GitHub sign-in.
 * - `sign_in_running`: a pending key replacement is not resolved while a
 *   sign-in runs, because the sign-in may still register the new key.
 * - `replacement_pending`: the WebSocket challenge is not signed while a key
 *   replacement is pending; `authenticate` resolves it first.
 * - `removal_pending`: the person removed this device, and the API has not
 *   confirmed it yet; the key is used only for the removal.
 * - `refused`: the API answered with an error body; `code` names it. With
 *   `device_account_mismatch`, `deviceLogin` is the login of the account
 *   that this installation holds.
 * - `record_not_saved`: the new key authenticated, but the record could not
 *   be written with it, also when tried a second time; the replacement stays
 *   pending.
 * - `invalid_request`: a value of the call is outside the protocol's format.
 * - `no_answer`, `server_error`, `unexpected_response`: whether the API
 *   acted is unknown, so nothing changed on the device.
 */
export const SESSION_FAILURE_REASONS = Object.freeze([
  "api_origin_unset",
  "api_origin_invalid",
  "no_device",
  "key_lost",
  "key_not_loaded",
  "record_unreadable",
  "key_store_failed",
  "signed_out",
  "sign_in_running",
  "replacement_pending",
  "removal_pending",
  "refused",
  "record_not_saved",
  "invalid_request",
  "no_answer",
  "server_error",
  "unexpected_response",
] as const);
export type SessionFailureReason = (typeof SESSION_FAILURE_REASONS)[number];

/** A failed call. Holds no token, signature, or key. */
export interface SessionFailure {
  readonly ok: false;
  readonly reason: SessionFailureReason;
  /** With `refused`: the API's error code. */
  readonly code?: ApiErrorCode;
  /** With `refused` and `device_account_mismatch`: the login that this installation holds. */
  readonly deviceLogin?: string;
  /** With `key_store_failed`: the code of the store's `DeviceKeyError`. */
  readonly keyError?: DeviceKeyErrorCode;
}

export type SessionResult<T> =
  { readonly ok: true; readonly value: T } | SessionFailure;

/** The account and the device of this installation, from the device record. */
export interface SessionAccount {
  readonly deviceId: DeviceId;
  readonly userId: UserId;
  readonly login: string;
  readonly displayName: string;
  /** As the last sign-in that this installation saw answered it. */
  readonly signInExpiresAt: string;
}

/**
 * The state of the device, for the account service and the screens:
 *
 * - `starting`: before the first `refresh`.
 * - `no_device`: no device that this installation can use; a GitHub sign-in
 *   registers one.
 * - `key_lost`: the record's device has no usable key on this installation
 *   (see the failure `key_lost`). The record and its account are kept; the
 *   next GitHub sign-in registers a new device that names this one.
 * - `unavailable`: the record cannot be read or the key store failed.
 * - `key_not_loaded`: the key needs its passphrase.
 * - `signed_in`: a record and a loaded key; the API is asked as needed.
 * - `signed_out`: the person signed out (P-65); `reportPending` while the
 *   API has not confirmed it.
 * - `sign_in_required`: the API asks for a GitHub sign-in. The key is kept.
 * - `auth_failed`: the API refused the key (an unknown device, a bad
 *   signature, or a disabled account). The key is kept.
 * - `account_mismatch`: a sign-in with another GitHub account was refused;
 *   the person may sign in as `account.login`, and then remove this device.
 * - `removal_pending`: the person removed this device, and the API has not
 *   confirmed it yet; it holds across a restart, and `refresh` retries it.
 * - `removed`: the API confirmed the removal; the key and the record are
 *   deleted.
 * - `revoked`: the API answered `device_revoked`. The caller stops local
 *   execution; the key and the record are deleted.
 *
 * `key_lost`, `unavailable`, `key_not_loaded`, and `account_mismatch` come
 * before `signed_out`; they carry `signedOut: true` while a sign-out marker
 * exists (P-65), so that the caller still knows that the person signed out
 * (#195). Without the keys, a marker that exists counts, also one that
 * cannot be read.
 */
export type DeviceSessionState =
  | { readonly kind: "starting" }
  | { readonly kind: "no_device" }
  | {
      readonly kind: "key_lost";
      readonly account: SessionAccount;
      readonly signedOut?: true;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "record_unreadable" | "key_store_failed";
      readonly signedOut?: true;
    }
  | {
      readonly kind: "key_not_loaded";
      readonly account: SessionAccount;
      readonly signedOut?: true;
    }
  | { readonly kind: "signed_in"; readonly account: SessionAccount }
  | {
      readonly kind: "signed_out";
      readonly account: SessionAccount;
      readonly reportPending: boolean;
    }
  | { readonly kind: "sign_in_required"; readonly account: SessionAccount }
  | { readonly kind: "auth_failed"; readonly account: SessionAccount }
  | {
      readonly kind: "account_mismatch";
      readonly account: SessionAccount;
      readonly signedOut?: true;
    }
  | { readonly kind: "removal_pending"; readonly account: SessionAccount }
  | { readonly kind: "removed" }
  | { readonly kind: "revoked" };

/** A request to a route that needs an access token. */
export interface AuthorizedRequest<T> {
  readonly route: ApiRoute;
  /** The `:name` parameters of the route path; every one is an ID. */
  readonly params?: Readonly<Record<string, string>>;
  /**
   * The query, encoded with `URLSearchParams` after the filled path, which
   * stays on the API origin. Without it, or when it is empty, the URL has no
   * query.
   */
  readonly query?: Readonly<Record<string, string>>;
  /** Sent as JSON. */
  readonly body?: unknown;
  /**
   * The cap of the answer body in bytes, for a read whose answer can be
   * larger than `MAX_API_ANSWER_BYTES`, the default.
   */
  readonly maxAnswerBytes?: number;
  /** The schema of a `2xx` answer's body, or `empty` for an answer without one (`204`). */
  readonly answer: z.ZodType<T> | "empty";
}

/** The part of the sign-in flow's outcome that the session reads. */
export interface FinishedSignIn {
  readonly kind: string;
  readonly code?: ApiErrorCode;
}

/** The part of the device key store that the session uses. */
export type SessionKeyStore = Pick<
  DeviceKeyStore,
  "hasKey" | "keys" | "confirmReplacement" | "abandonReplacement" | "delete"
>;

export interface DeviceSessionDependencies {
  /** From `resolveApiOrigin`. */
  readonly apiOrigin: ApiOrigin;
  readonly keyStore: SessionKeyStore;
  readonly deviceRecords: DeviceRecordStore;
  readonly signOutMarkers: SignOutMarkerStore;
  readonly sessionNotes: SessionNotesStore;
  /** Production passes Electron's `net.fetch`. */
  readonly fetch: ApiFetch;
  /** The clock of the request timeouts; defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /**
   * The wall clock in milliseconds; defaults to `Date.now`. It times the
   * notes that survive a restart, and with `now` the token cache, because
   * the monotonic clock may stop while the computer sleeps.
   */
  readonly wallClock?: () => number;
  /** Receives a fixed message for an error that the session handled. */
  readonly onError?: (message: string) => void;
}

export interface DeviceSession {
  /** The current state. */
  readonly state: () => DeviceSessionState;
  /**
   * Calls `listener` with every new state; returns a function that ends the
   * subscription. An error that the listener throws is ignored.
   */
  readonly onChange: (
    listener: (state: DeviceSessionState) => void,
  ) => () => void;
  /**
   * Reads the record, the keys, and the sign-out marker again, and forgets
   * the tokens and the API's last refusal (`sign_in_required`,
   * `auth_failed`) and `account_mismatch`. Call it at startup after the key
   * store's `load`, after a passphrase was entered, and when the person
   * asks to try again. `revoked` and `removed` stay until a sign-in. While
   * a removal is pending, it also retries the removal, so it may take as
   * long as a request.
   */
  readonly refresh: () => Promise<DeviceSessionState>;
  /**
   * Call before `start` of the sign-in flow. Until `signInFinished`, a
   * pending key replacement is not resolved, because the sign-in may still
   * register the new key.
   */
  readonly signInStarted: () => void;
  /**
   * Call with every outcome of the sign-in flow, also one that did not
   * start. `signed_in` ends a sign-out; `refused` with
   * `device_account_mismatch` moves to `account_mismatch`; `refused` with
   * `device_revoked` moves to `revoked`. After every other outcome, for
   * example `failed` with `uncertain_refusal`, `no_answer`, or
   * `record_not_saved`, whether the sign-in committed is unknown: a pending
   * replacement then starts its grace period (`REPLACEMENT_GRACE_MS`), and a
   * sign-out ends only when the new key authenticates.
   */
  readonly signInFinished: (
    outcome: FinishedSignIn,
  ) => Promise<DeviceSessionState>;
  /**
   * Makes sure that a valid access token is held, minting one if needed,
   * which resolves a pending key replacement. Resolves with the account.
   * Refused while a removal is pending.
   */
  readonly authenticate: () => Promise<SessionResult<SessionAccount>>;
  /**
   * Sends a request with an access token. A `401` is answered by minting
   * one new token and sending the request once more; when the new token
   * cannot be minted, the failure names the reason. Refused while a removal
   * is pending.
   */
  readonly request: <T>(
    request: AuthorizedRequest<T>,
  ) => Promise<SessionResult<T | null>>;
  /** `GET /devices`: the person's own devices. */
  readonly listDevices: () => Promise<SessionResult<readonly DeviceListItem[]>>;
  /**
   * Signs out (P-65): the device and its key stay, the tokens are dropped,
   * and the key is not used until the next GitHub sign-in. The sign-out
   * holds on the device at once and across restarts; the API learns it now
   * (`reported`) or by `reportSignOut` later (`pending`).
   */
  readonly signOut: () => Promise<SessionResult<"reported" | "pending">>;
  /** Reports a sign-out that the API has not confirmed yet. */
  readonly reportSignOut: () => Promise<SessionResult<"reported" | "pending">>;
  /**
   * Remove this device: notes the removal, so that it holds across a
   * restart, and revokes the device with the reason `removed`; the key and
   * the record are deleted only after the API confirmed it. Without a clear
   * answer it resolves with `pending`, and `refresh` or another call
   * retries it.
   */
  readonly removeDevice: () => Promise<SessionResult<"removed" | "pending">>;
  /**
   * While the grace period of an uncertain sign-in protects the new key of
   * a pending replacement (`REPLACEMENT_GRACE_MS`): when it ends, in UTC,
   * by this device's wall clock; null otherwise. Until then the sign-in
   * flow's `replacement_pending` cannot be resolved, so a new sign-in
   * cannot start (#199). Null also while a first refusal of both keys is
   * noted: the replacement then stays pending until the wait for a second
   * round ends (`LOST_KEY_WAIT_MS`), which can be later. It sends no
   * request and changes no rule of the grace period. Never rejects.
   */
  readonly replacementGraceEnd: () => Promise<string | null>;
  /**
   * Signs the WebSocket `auth.challenge` with the purpose `ws` and the
   * current key, and returns the `auth.response` frame for #26. It sends no
   * request. Refused while signed out, while a removal is pending, while
   * the API's last answer refused the key, and while a key replacement is
   * pending (`authenticate` first).
   */
  readonly signWebSocketChallenge: (
    challenge: AuthChallengeFrame,
  ) => Promise<SessionResult<AuthResponseFrame>>;
  /**
   * Applies a refusal that arrived another way, for example the close
   * reason of the WebSocket (#26), for the device that the connection
   * authenticated as. A refusal for another device, for example a late close
   * of a connection of the device that this one replaced, is ignored.
   */
  readonly deviceRefused: (
    code: "auth_failed" | "device_revoked" | "sign_in_required",
    deviceId: DeviceId,
  ) => Promise<DeviceSessionState>;
}

/** The marker as it applies to the keys now; `publicKeys` is null for a corrupt marker, which names every key. */
interface AppliedMarker {
  readonly publicKeys: readonly string[] | null;
  readonly reported: boolean;
}

/** What the files and the key store hold now. */
type Facts =
  | {
      readonly kind: "missing";
      readonly reason: "no_device" | "record_unreadable" | "key_store_failed";
      readonly keyError?: DeviceKeyErrorCode;
      /** Whether a sign-out marker exists (`signOutMarked`). */
      readonly signedOut?: boolean;
    }
  | {
      readonly kind: "key_not_loaded";
      readonly record: DeviceRecord;
      readonly signedOut: boolean;
    }
  | {
      readonly kind: "key_lost";
      readonly record: DeviceRecord;
      readonly signedOut: boolean;
    }
  | {
      readonly kind: "ready";
      readonly record: DeviceRecord;
      readonly keys: DeviceKeys;
      readonly marker: AppliedMarker | null;
    };
type ReadyFacts = Extract<Facts, { kind: "ready" }>;

/** What one key got from the API. */
type KeyAnswer =
  | { readonly kind: "token"; readonly token: string }
  | {
      readonly kind: "refused";
      readonly code: ApiErrorCode;
      /** Whether the refusal answered the signature (the access token request). */
      readonly signed: boolean;
    }
  | { readonly kind: "failure"; readonly failure: SessionFailure };

type MintResult =
  | {
      readonly kind: "token";
      readonly token: string;
      readonly validUntil: number;
      readonly validUntilWall: number;
      /** Whether the sign-out marker names the key that minted it. */
      readonly marked: boolean;
    }
  | { readonly kind: "failure"; readonly failure: SessionFailure };

type TokenResult =
  { readonly ok: true; readonly token: string } | SessionFailure;

const scheduleWithSetTimeout: ScheduleTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

function failure(
  reason: SessionFailureReason,
  extra: Omit<SessionFailure, "ok" | "reason"> = {},
): SessionFailure {
  return Object.freeze({ ok: false, reason, ...extra });
}

function refused(code: ApiErrorCode): SessionFailure {
  return failure("refused", { code });
}

function succeeded<T>(value: T): SessionResult<T> {
  return Object.freeze({ ok: true, value });
}

function accountOf(record: DeviceRecord): SessionAccount {
  return Object.freeze({
    deviceId: record.deviceId,
    userId: record.userId,
    login: record.login,
    displayName: record.displayName,
    signInExpiresAt: record.signInExpiresAt,
  });
}

function keyStoreFailure(error: unknown): SessionFailure {
  return isDeviceKeyError(error)
    ? failure("key_store_failed", { keyError: error.code })
    : failure("key_store_failed");
}

/** A failure for an answer that is neither a success nor the API's error body. */
function uncertain(answer: ApiAnswer): SessionFailure {
  switch (answer.kind) {
    case "server_error":
      return failure("server_error");
    case "no_answer":
      return failure("no_answer");
    default:
      return failure("unexpected_response");
  }
}

/** Whether the marker names the key; a corrupt marker names every key. */
function markerNames(marker: AppliedMarker, key: DeviceKey): boolean {
  return (
    marker.publicKeys === null || marker.publicKeys.includes(key.publicKey)
  );
}

/** Whether the record names the previous key, so the API may hold either key. */
function replacementToResolve(facts: ReadyFacts): boolean {
  return (
    facts.keys.previous !== null &&
    facts.record.publicKey === facts.keys.previous.publicKey
  );
}

/** `signedOut: true` for a state that comes before `signed_out`, or nothing. */
function signedOutFlag(signedOut: boolean | undefined): {
  readonly signedOut?: true;
} {
  return signedOut === true ? { signedOut: true } : {};
}

function sameState(a: DeviceSessionState, b: DeviceSessionState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createDeviceSession(
  deps: DeviceSessionDependencies,
): DeviceSession {
  const scheduleTimer = deps.scheduleTimer ?? scheduleWithSetTimeout;
  const now = deps.now ?? (() => performance.now());
  const wallClock = deps.wallClock ?? (() => Date.now());
  const wallIso = (): string => new Date(wallClock()).toISOString();
  const report = (message: string): void => {
    try {
      deps.onError?.(message);
    } catch {
      // A failing report never changes the session.
    }
  };

  let current: DeviceSessionState = Object.freeze({ kind: "starting" });
  const listeners = new Set<(state: DeviceSessionState) => void>();
  let lastFacts: Facts | null = null;
  let settleSequence = 0;
  let publishedSequence = 0;

  /** The cached token; never leaves this closure. */
  let cached: {
    readonly token: string;
    readonly validUntil: number;
    readonly validUntilWall: number;
  } | null = null;
  /** The mint that concurrent callers share. */
  let minting: Promise<TokenResult> | null = null;
  /** Grows when tokens must be forgotten, so a mint that ends later is not cached. */
  let epoch = 0;
  /** Every use of the key runs after the one before it has settled. */
  let keyQueue: Promise<unknown> = Promise.resolve();

  /** The API's last refusal of the key; cleared by a token, a sign-in, or `refresh`. */
  let refusal: "sign_in_required" | "auth_failed" | null = null;
  let accountMismatch = false;
  /**
   * The session notes, read once: this process holds the single-instance
   * lock, so only it writes them. Null until read.
   */
  let notes: SessionNotes | null = null;
  let notesWrite: Promise<void> = Promise.resolve();
  /**
   * For each note time, the monotonic clock and the note's wall-clock age
   * when this process first saw it.
   */
  const notesSeen = new Map<string, { mono: number; wallAge: number }>();
  /** Set after `device_revoked` or a confirmed removal, until a sign-in. */
  let gone: "revoked" | "removed" | null = null;
  let signInsRunning = 0;
  /** A marker that could not be written; it holds until the process ends. */
  let unsavedMarker: SignOutMarker | null = null;

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = keyQueue.then(operation);
    keyQueue = result.catch(() => undefined);
    return result;
  }

  function forgetTokens(): void {
    epoch += 1;
    cached = null;
  }

  /** The cached token while both clocks say that it is valid. */
  function cachedToken(): string | null {
    if (
      cached !== null &&
      now() < cached.validUntil &&
      wallClock() < cached.validUntilWall
    ) {
      return cached.token;
    }
    cached = null;
    return null;
  }

  // ---- Notes ---------------------------------------------------------------

  async function loadNotes(): Promise<SessionNotes> {
    if (notes !== null) {
      return notes;
    }
    let loaded: SessionNotes = NO_SESSION_NOTES;
    try {
      const read = await deps.sessionNotes.read();
      if (read.kind === "notes") {
        loaded = read.notes;
      } else if (read.kind === "corrupt") {
        report("The session notes are corrupt and are not used.");
      }
    } catch {
      report("The session notes could not be read.");
    }
    notes ??= loaded;
    return notes;
  }

  /** Changes the notes in memory at once and writes them in order. */
  function setNotes(next: SessionNotes): Promise<void> {
    notes = next;
    const write = notesWrite.then(async () => {
      if (notes !== next) {
        // A later change writes the newer notes.
        return;
      }
      try {
        await deps.sessionNotes.write(next);
      } catch {
        report(
          "The session notes could not be saved; they hold until the application quits.",
        );
      }
    });
    notesWrite = write;
    return write;
  }

  async function changeNotes(
    change: (held: SessionNotes) => SessionNotes,
  ): Promise<void> {
    const held = await loadNotes();
    const next = change(held);
    if (JSON.stringify(next) !== JSON.stringify(held)) {
      await setNotes(Object.freeze(next));
    }
  }

  function removalNoted(record: DeviceRecord): boolean {
    return notes?.removal?.deviceId === record.deviceId;
  }

  /**
   * How long ago a note's time was, by two clocks: the wall clock, the only
   * one that survives a restart, and, while this process runs, the note's
   * wall-clock age when the process first saw it plus the monotonic time
   * since. `least` is the smaller age: a wait ends only when both clocks
   * say so, so a wall clock that jumps forward ends no wait early. `most` is
   * the larger: a note is too old as soon as either clock says so, because
   * the monotonic clock may stop while the computer sleeps. A time in the
   * future counts as now (`tidyNotes` rewrites it).
   */
  function noteAge(
    kind: "grace" | "refused",
    at: string,
    bound: "least" | "most",
  ): number {
    const wallAge = Math.max(0, wallClock() - Date.parse(at));
    const key = `${kind}:${at}`;
    let seen = notesSeen.get(key);
    if (seen === undefined) {
      seen = { mono: now(), wallAge };
      notesSeen.set(key, seen);
    }
    const runningAge = seen.wallAge + Math.max(0, now() - seen.mono);
    return bound === "least"
      ? Math.min(wallAge, runningAge)
      : Math.max(wallAge, runningAge);
  }

  /** The time of a new note, which this process sees from now on. */
  function noteTime(kind: "grace" | "refused"): string {
    const at = wallIso();
    notesSeen.set(`${kind}:${at}`, { mono: now(), wallAge: 0 });
    return at;
  }

  /** A note time that is later than now becomes now. */
  function notLater(kind: "grace" | "refused", at: string): string {
    return Date.parse(at) > wallClock() ? noteTime(kind) : at;
  }

  /** Whether the grace period of an uncertain sign-in protects the new key. */
  function graceActive(facts: ReadyFacts, held: SessionNotes): boolean {
    const note = held.uncertainSignIn;
    return (
      note !== null &&
      note.publicKey === facts.keys.current.publicKey &&
      noteAge("grace", note.at, "least") < REPLACEMENT_GRACE_MS
    );
  }

  /** The first refusal of both keys of the pending replacement, if noted. */
  function keysRefusedNote(
    facts: ReadyFacts,
    held: SessionNotes,
  ): SessionNotes["keysRefused"] {
    const note = held.keysRefused;
    return note !== null &&
      note.publicKeys[0] === facts.keys.current.publicKey &&
      note.publicKeys[1] === facts.keys.previous?.publicKey
      ? note
      : null;
  }

  /**
   * Keeps only the notes about the device and the keys that the
   * installation holds, and notes the grace period of a pending replacement
   * that has none, for example after a stop before `signInFinished`.
   */
  async function tidyNotes(facts: Facts): Promise<void> {
    await changeNotes((held) => {
      switch (facts.kind) {
        case "missing":
          return facts.reason === "no_device" ? NO_SESSION_NOTES : held;
        case "key_lost":
          return NO_SESSION_NOTES;
        case "key_not_loaded":
          return {
            ...held,
            removal: removalOf(held, facts.record),
          };
        case "ready": {
          const pending = replacementToResolve(facts);
          const uncertain =
            held.uncertainSignIn?.publicKey === facts.keys.current.publicKey
              ? {
                  ...held.uncertainSignIn,
                  at: notLater("grace", held.uncertainSignIn.at),
                }
              : null;
          const refused = pending ? keysRefusedNote(facts, held) : null;
          return {
            removal: removalOf(held, facts.record),
            uncertainSignIn: !pending
              ? null
              : (uncertain ??
                (signInsRunning > 0
                  ? null
                  : {
                      publicKey: facts.keys.current.publicKey,
                      at: noteTime("grace"),
                    })),
            keysRefused:
              refused === null
                ? null
                : { ...refused, at: notLater("refused", refused.at) },
          };
        }
      }
    });
  }

  function removalOf(
    held: SessionNotes,
    record: DeviceRecord,
  ): SessionNotes["removal"] {
    return held.removal?.deviceId === record.deviceId ? held.removal : null;
  }

  function originOrFailure(): string | SessionFailure {
    return deps.apiOrigin.ok
      ? deps.apiOrigin.origin
      : failure(deps.apiOrigin.reason);
  }

  // ---- State -------------------------------------------------------------

  function stateFrom(facts: Facts | null): DeviceSessionState {
    if (gone !== null) {
      return { kind: gone };
    }
    if (facts === null) {
      return { kind: "starting" };
    }
    switch (facts.kind) {
      case "missing":
        return facts.reason === "no_device"
          ? { kind: "no_device" }
          : {
              kind: "unavailable",
              reason: facts.reason,
              ...signedOutFlag(facts.signedOut),
            };
      case "key_not_loaded":
        return {
          kind: "key_not_loaded",
          account: accountOf(facts.record),
          ...signedOutFlag(facts.signedOut),
        };
      case "key_lost":
        return {
          kind: "key_lost",
          account: accountOf(facts.record),
          ...signedOutFlag(facts.signedOut),
        };
      case "ready":
        break;
    }
    const account = accountOf(facts.record);
    if (accountMismatch) {
      return {
        kind: "account_mismatch",
        account,
        ...signedOutFlag(facts.marker !== null),
      };
    }
    if (facts.marker !== null) {
      return {
        kind: "signed_out",
        account,
        reportPending: !facts.marker.reported,
      };
    }
    if (refusal !== null) {
      return { kind: refusal, account };
    }
    if (removalNoted(facts.record)) {
      return { kind: "removal_pending", account };
    }
    return { kind: "signed_in", account };
  }

  function publish(): DeviceSessionState {
    const next = stateFrom(lastFacts);
    if (sameState(next, current)) {
      return current;
    }
    current = Object.freeze(next);
    for (const listener of [...listeners]) {
      try {
        listener(current);
      } catch {
        report("A device session listener failed.");
      }
    }
    return current;
  }

  /** Reads the facts again and publishes the state they give. */
  async function settle(): Promise<DeviceSessionState> {
    const sequence = ++settleSequence;
    let facts: Facts;
    try {
      facts = await readFacts();
    } catch {
      facts = {
        kind: "missing",
        reason: "key_store_failed",
        signedOut: await signOutMarked(),
      };
    }
    // A later read was published already; this one is older.
    if (sequence < publishedSequence) {
      return current;
    }
    publishedSequence = sequence;
    lastFacts = facts;
    return publish();
  }

  // ---- Files and keys ----------------------------------------------------

  async function readMarker(keys: DeviceKeys): Promise<AppliedMarker | null> {
    let marker: SignOutMarker | null;
    try {
      const read = await deps.signOutMarkers.read();
      if (read.kind === "corrupt") {
        // The person signed out, but the keys are unknown: it names every
        // key until a sign-in ends it (fail closed).
        return { publicKeys: null, reported: false };
      }
      marker = read.kind === "marker" ? read.marker : unsavedMarker;
    } catch {
      return { publicKeys: null, reported: false };
    }
    if (marker === null) {
      return null;
    }
    const named = marker.publicKeys;
    if (
      named.includes(keys.current.publicKey) ||
      (keys.previous !== null && named.includes(keys.previous.publicKey))
    ) {
      return marker;
    }
    // Every GitHub sign-in stores a new key: a sign-in after the sign-out
    // made these keys, so the sign-out has ended.
    await dropMarker();
    return null;
  }

  async function dropMarker(): Promise<void> {
    unsavedMarker = null;
    try {
      await deps.signOutMarkers.delete();
    } catch {
      report("The sign-out marker could not be deleted.");
    }
  }

  /** Reads the record, the keys, the marker, and the notes. */
  async function readFacts(): Promise<Facts> {
    const facts = await readFactsOnly();
    await tidyNotes(facts);
    return facts;
  }

  async function readFactsOnly(): Promise<Facts> {
    let read;
    try {
      read = await deps.deviceRecords.read();
    } catch {
      return { kind: "missing", reason: "record_unreadable" };
    }
    if (read.kind !== "record") {
      if (read.kind === "corrupt") {
        let hasKey: boolean;
        try {
          hasKey = await deps.keyStore.hasKey();
        } catch (error) {
          return { kind: "missing", ...keyFailureFacts(error) };
        }
        if (hasKey) {
          // The key may still be the key of a device that the API knows.
          return { kind: "missing", reason: "record_unreadable" };
        }
      }
      if (unsavedMarker !== null || (await markerFileExists())) {
        // A marker without a record belongs to no device.
        await dropMarker();
      }
      return { kind: "missing", reason: "no_device" };
    }
    const record = read.record;
    let keys = deps.keyStore.keys();
    if (keys === null) {
      let hasKey: boolean;
      try {
        hasKey = await deps.keyStore.hasKey();
      } catch (error) {
        return {
          kind: "missing",
          ...keyFailureFacts(error),
          signedOut: await signOutMarked(),
        };
      }
      // Without a key file the key is lost: the next sign-in registers a new
      // device that names the record's device.
      const signedOut = await signOutMarked();
      return hasKey
        ? { kind: "key_not_loaded", record, signedOut }
        : { kind: "key_lost", record, signedOut };
    }
    if (
      keys.previous !== null &&
      keys.current.publicKey === record.publicKey &&
      signInsRunning === 0
    ) {
      // The record names the new key, and it is written only after the API
      // proved that it holds that key: the application stopped between the
      // record write and the confirmation (the same rule as the sign-in).
      // While a sign-in runs, the flow confirms it itself.
      try {
        await deps.keyStore.confirmReplacement();
      } catch {
        report("The previous device key could not be deleted.");
      }
      keys = deps.keyStore.keys();
      if (keys === null) {
        return { kind: "key_lost", record, signedOut: await signOutMarked() };
      }
    }
    const named =
      keys.current.publicKey === record.publicKey ||
      keys.previous?.publicKey === record.publicKey;
    if (!named) {
      // Not the key of the record's device: a lost key too, so the next
      // sign-in registers a new device that names the record's device.
      return { kind: "key_lost", record, signedOut: await signOutMarked() };
    }
    const marker = await readMarker(keys);
    return { kind: "ready", record, keys, marker };
  }

  function keyFailureFacts(error: unknown): {
    reason: "key_store_failed";
    keyError?: DeviceKeyErrorCode;
  } {
    return isDeviceKeyError(error)
      ? { reason: "key_store_failed", keyError: error.code }
      : { reason: "key_store_failed" };
  }

  async function markerFileExists(): Promise<boolean> {
    try {
      return (await deps.signOutMarkers.read()).kind !== "none";
    } catch {
      return false;
    }
  }

  /**
   * Whether the person signed out, for facts that cannot apply the marker
   * to the keys (#195): a marker exists, in the file or in memory. A marker
   * that cannot be read counts, like a corrupt one.
   */
  async function signOutMarked(): Promise<boolean> {
    if (unsavedMarker !== null) {
      return true;
    }
    try {
      return (await deps.signOutMarkers.read()).kind !== "none";
    } catch {
      return true;
    }
  }

  function factsFailure(facts: Exclude<Facts, ReadyFacts>): SessionFailure {
    if (facts.kind === "key_not_loaded" || facts.kind === "key_lost") {
      return failure(facts.kind);
    }
    return facts.keyError === undefined
      ? failure(facts.reason)
      : failure(facts.reason, { keyError: facts.keyError });
  }

  /** Writes the record, a second time if the first write fails. */
  async function writeRecord(record: DeviceRecord): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await deps.deviceRecords.write(record);
        return true;
      } catch {
        report("The device record could not be written.");
      }
    }
    return false;
  }

  /**
   * The API verified a signature by `key`, so it holds that key: resolves a
   * pending replacement. The new key is confirmed only after the record
   * names it, so a confirmed key never sits next to a record that names the
   * previous key; if the record cannot be written, the replacement stays
   * pending. A sign-out marker that does not name the key has ended.
   *
   * The answer may arrive long after `facts` were read: the record is read
   * again, and nothing is written or changed when it is gone, names another
   * device, or the key store no longer holds these keys, for example after
   * "This is not me" deleted the record and the key meanwhile. Writing the
   * record from `facts` then would bring that account back.
   */
  async function keyHeld(
    facts: ReadyFacts,
    key: DeviceKey,
    keepBoth = false,
  ): Promise<SessionFailure | null> {
    const { keys } = facts;
    let read: DeviceRecordRead;
    try {
      read = await deps.deviceRecords.read();
    } catch {
      return failure("record_unreadable");
    }
    const held = deps.keyStore.keys();
    if (
      read.kind !== "record" ||
      read.record.deviceId !== facts.record.deviceId ||
      held === null ||
      held.current.publicKey !== keys.current.publicKey ||
      held.previous?.publicKey !== keys.previous?.publicKey
    ) {
      return failure("no_device");
    }
    const record = read.record;
    // The API holds a key, so an earlier refusal of both keys was not about
    // them: the wait starts again at the next refusal.
    await changeNotes((notes) => ({ ...notes, keysRefused: null }));
    if (key === keys.current) {
      if (record.publicKey !== key.publicKey) {
        if (!(await writeRecord({ ...record, publicKey: key.publicKey }))) {
          return failure("record_not_saved");
        }
      }
      if (keys.previous !== null && signInsRunning === 0) {
        try {
          await deps.keyStore.confirmReplacement();
        } catch {
          // The next read confirms it: the record names the new key.
          report("The previous device key could not be deleted.");
        }
      }
    } else if (!keepBoth) {
      try {
        // The API holds the previous key, so it never registered the new one.
        await deps.keyStore.abandonReplacement();
      } catch {
        report("The new device key could not be discarded.");
      }
    }
    if (facts.marker !== null && !markerNames(facts.marker, key)) {
      await dropMarker();
    }
    return null;
  }

  /**
   * Stops the device: publishes `revoked` or `removed` first, so the caller
   * stops local execution, then deletes the key, then the record, then the
   * sign-out marker. The record stays when the key could not be deleted.
   */
  async function deviceGone(kind: "revoked" | "removed"): Promise<void> {
    gone = kind;
    forgetTokens();
    refusal = null;
    accountMismatch = false;
    publish();
    try {
      await deps.keyStore.delete();
      await deps.deviceRecords.delete();
    } catch {
      report("The device key or record could not be deleted.");
    }
    await dropMarker();
    await setNotes(NO_SESSION_NOTES);
  }

  // ---- Access tokens -----------------------------------------------------

  /** Asks for a challenge and signs it with `key`. */
  async function tokenFor(
    key: DeviceKey,
    deviceId: DeviceId,
    origin: string,
  ): Promise<KeyAnswer> {
    const challenge = await callApi({
      fetch: deps.fetch,
      scheduleTimer,
      origin,
      route: AUTH_ROUTES.challenge,
    });
    if (challenge.kind === "error") {
      return { kind: "refused", code: challenge.code, signed: false };
    }
    if (challenge.kind !== "ok") {
      return { kind: "failure", failure: uncertain(challenge) };
    }
    const parsedChallenge = ChallengeResponseSchema.safeParse(challenge.value);
    if (challenge.status !== 200 || !parsedChallenge.success) {
      return { kind: "failure", failure: failure("unexpected_response") };
    }
    let signature: string;
    try {
      signature = key.sign({
        purpose: "http",
        audience: origin,
        nonce: parsedChallenge.data.nonce,
        deviceId,
        challengeId: parsedChallenge.data.challengeId,
      });
    } catch (error) {
      return { kind: "failure", failure: keyStoreFailure(error) };
    }
    const minted = await callApi({
      fetch: deps.fetch,
      scheduleTimer,
      origin,
      route: AUTH_ROUTES.accessToken,
      body: {
        deviceId,
        challengeId: parsedChallenge.data.challengeId,
        signature,
      },
    });
    if (minted.kind === "error") {
      return { kind: "refused", code: minted.code, signed: true };
    }
    if (minted.kind !== "ok") {
      return { kind: "failure", failure: uncertain(minted) };
    }
    const parsed = AccessTokenResponseSchema.safeParse(minted.value);
    if (minted.status !== 200 || !parsed.success) {
      return { kind: "failure", failure: failure("unexpected_response") };
    }
    return { kind: "token", token: parsed.data.accessToken };
  }

  /**
   * Tries `candidates` in order, each with a new challenge, and applies a
   * certain answer: a token or `sign_in_required` proves that the API holds
   * the key that signed (`keyHeld`), `device_revoked` deletes the device,
   * and `auth_failed` moves on to the next candidate. Resolves with
   * `all_refused` when every candidate got `auth_failed`. An answer that is
   * not certain (no answer, a `5xx`, an answer that is not the API's, or a
   * refused challenge) changes nothing.
   */
  async function tryKeys(
    facts: ReadyFacts,
    origin: string,
    candidates: readonly DeviceKey[],
    keepBoth: boolean,
  ): Promise<MintResult | { readonly kind: "all_refused" }> {
    for (const key of candidates) {
      const startedAt = now();
      const startedAtWall = wallClock();
      const answer = await tokenFor(key, facts.record.deviceId, origin);
      if (answer.kind === "failure") {
        return answer;
      }
      if (answer.kind === "token") {
        const notHeld = await keyHeld(facts, key, keepBoth);
        if (notHeld !== null) {
          return { kind: "failure", failure: notHeld };
        }
        return {
          kind: "token",
          token: answer.token,
          validUntil:
            startedAt + ACCESS_TOKEN_LIFETIME_MS - ACCESS_TOKEN_RENEW_MARGIN_MS,
          validUntilWall:
            startedAtWall +
            ACCESS_TOKEN_LIFETIME_MS -
            ACCESS_TOKEN_RENEW_MARGIN_MS,
          marked: facts.marker !== null && markerNames(facts.marker, key),
        };
      }
      if (!answer.signed) {
        // The challenge was refused, for example `rate_limited`: nothing is
        // known about the key.
        return { kind: "failure", failure: refused(answer.code) };
      }
      switch (answer.code) {
        case "auth_failed":
          // The API does not hold this key, or this was the answer to a
          // resent copy of a request that it already answered.
          continue;
        case "device_revoked":
          await deviceGone("revoked");
          return { kind: "failure", failure: refused("device_revoked") };
        case "sign_in_required": {
          // The signature was verified first, so the API holds this key.
          const notHeld = await keyHeld(facts, key, keepBoth);
          if (notHeld !== null) {
            report("The device needs a sign-in, and its record was not saved.");
          }
          if (
            facts.marker !== null &&
            markerNames(facts.marker, key) &&
            !facts.marker.reported
          ) {
            // The API takes this key only after a new sign-in: the sign-out
            // holds there too.
            await markReported(facts);
          }
          refusal = "sign_in_required";
          return { kind: "failure", failure: refused("sign_in_required") };
        }
        default:
          // For example `rate_limited`: nothing is known about the key.
          return { kind: "failure", failure: refused(answer.code) };
      }
    }
    return { kind: "all_refused" };
  }

  /**
   * Mints an access token. With a pending replacement the new key is tried
   * first and the previous key only after the new key got `auth_failed`.
   * During the grace period of an uncertain sign-in, a token of the previous
   * key is used but both keys are kept. When both keys are refused, the
   * time is noted and both are kept; only a round at least
   * `LOST_KEY_WAIT_MS` and less than `KEYS_REFUSED_MAX_AGE_MS` later that
   * refuses both again, after the grace period and with no key
   * authenticated in between (`keyHeld` ends the note), treats them as lost
   * (`keysLost`). A key is deleted otherwise
   * only after `device_revoked`; an answer that is not certain changes
   * nothing. Runs inside `exclusive`.
   */
  async function mint(facts: ReadyFacts, origin: string): Promise<MintResult> {
    const { keys } = facts;
    if (!replacementToResolve(facts) || keys.previous === null) {
      const result = await tryKeys(facts, origin, [keys.current], false);
      if (result.kind !== "all_refused") {
        return result;
      }
      // The key is kept, and the state reports the refusal.
      refusal = "auth_failed";
      return { kind: "failure", failure: refused("auth_failed") };
    }
    const held = await loadNotes();
    const keepBoth = graceActive(facts, held);
    const result = await tryKeys(
      facts,
      origin,
      [keys.current, keys.previous],
      keepBoth,
    );
    if (result.kind !== "all_refused") {
      return result;
    }
    refusal = "auth_failed";
    // The API answers `auth_failed` also for a challenge that it lost, for
    // example in a deploy, and to a resent copy of a request that it already
    // answered, so one round proves nothing.
    const first = keysRefusedNote(facts, held);
    // Too old as soon as either clock says so; the wait ends only when both
    // say so.
    if (
      first === null ||
      noteAge("refused", first.at, "most") >= KEYS_REFUSED_MAX_AGE_MS
    ) {
      const previous = keys.previous.publicKey;
      await changeNotes((current) => ({
        ...current,
        keysRefused: {
          publicKeys: [keys.current.publicKey, previous],
          at: noteTime("refused"),
        },
      }));
      return { kind: "failure", failure: refused("auth_failed") };
    }
    if (keepBoth || noteAge("refused", first.at, "least") < LOST_KEY_WAIT_MS) {
      return { kind: "failure", failure: refused("auth_failed") };
    }
    return { kind: "failure", failure: await keysLost(facts) };
  }

  /**
   * Both keys of a pending replacement were refused in two rounds, at least
   * `LOST_KEY_WAIT_MS` apart: the installation treats them as lost (decided
   * on #94). It publishes
   * `key_lost` first, deletes both keys, and keeps the record, so that the
   * next sign-in registers a new device that names the record's device. A
   * sign-out marker names only keys that are gone then, so it is deleted; a
   * corrupt one stays until a sign-in.
   */
  async function keysLost(facts: ReadyFacts): Promise<SessionFailure> {
    const held = deps.keyStore.keys();
    if (
      signInsRunning > 0 ||
      held === null ||
      held.current.publicKey !== facts.keys.current.publicKey ||
      held.previous?.publicKey !== facts.keys.previous?.publicKey
    ) {
      // The keys changed meanwhile: nothing is deleted.
      refusal = "auth_failed";
      return refused("auth_failed");
    }
    forgetTokens();
    refusal = null;
    accountMismatch = false;
    lastFacts = {
      kind: "key_lost",
      record: facts.record,
      signedOut: facts.marker !== null,
    };
    publish();
    try {
      await deps.keyStore.delete();
    } catch {
      report("The device keys could not be deleted.");
      refusal = "auth_failed";
      return refused("auth_failed");
    }
    if (facts.marker !== null && facts.marker.publicKeys !== null) {
      await dropMarker();
    }
    return failure("key_lost");
  }

  async function mintForSession(started: number): Promise<TokenResult> {
    try {
      const origin = originOrFailure();
      if (typeof origin !== "string") {
        return origin;
      }
      if (gone !== null) {
        return gone === "revoked"
          ? refused("device_revoked")
          : failure("no_device");
      }
      const facts = await readFacts();
      if (facts.kind !== "ready") {
        return factsFailure(facts);
      }
      const resolving = replacementToResolve(facts);
      if (resolving && signInsRunning > 0) {
        return failure("sign_in_running");
      }
      // A pending replacement is resolved also while signed out or refused,
      // because the next sign-in cannot start before it is.
      if (facts.marker !== null && !resolving) {
        return failure("signed_out");
      }
      if (refusal !== null && !resolving) {
        return refused(refusal);
      }
      if (resolving && refusal === "auth_failed") {
        // Both keys were refused: the next round runs only after the wait,
        // or after `refresh` when the person asks to try again.
        const first = keysRefusedNote(facts, await loadNotes());
        if (
          first !== null &&
          noteAge("refused", first.at, "least") < LOST_KEY_WAIT_MS
        ) {
          return refused("auth_failed");
        }
      }
      const result = await mint(facts, origin);
      if (result.kind === "failure") {
        return result.failure;
      }
      if (result.marked) {
        // Signed out, and the API still took the key: the token only
        // reports the sign-out.
        if ((await sendSignOut(result.token, origin)) === "reported") {
          const after = await readFacts();
          if (after.kind === "ready" && after.marker !== null) {
            await markReported(after);
          }
        }
        return failure("signed_out");
      }
      refusal = null;
      if (epoch === started) {
        cached = {
          token: result.token,
          validUntil: result.validUntil,
          validUntilWall: result.validUntilWall,
        };
      }
      return { ok: true, token: result.token };
    } catch {
      report("The device session failed unexpectedly.");
      return failure("key_store_failed");
    } finally {
      await settle();
    }
  }

  /** A valid token: the cached one, or one new mint that concurrent callers share. */
  function sessionToken(): Promise<TokenResult> {
    const token = cachedToken();
    if (token !== null) {
      return Promise.resolve({ ok: true, token });
    }
    if (minting !== null) {
      return minting;
    }
    const started = epoch;
    const run = exclusive(() => mintForSession(started));
    minting = run;
    void run.finally(() => {
      if (minting === run) {
        minting = null;
      }
    });
    return run;
  }

  function dropToken(token: string): void {
    if (cached?.token === token) {
      cached = null;
    }
  }

  function isUnauthorized(answer: ApiAnswer): boolean {
    return answer.kind === "error" && answer.status === 401;
  }

  async function refusedWithLogin(code: ApiErrorCode): Promise<SessionFailure> {
    if (code !== "device_account_mismatch") {
      return refused(code);
    }
    accountMismatch = true;
    let login: string | undefined;
    try {
      const read = await deps.deviceRecords.read();
      login = read.kind === "record" ? read.record.login : undefined;
    } catch {
      login = undefined;
    }
    await settle();
    return login === undefined
      ? refused(code)
      : failure("refused", { code, deviceLogin: login });
  }

  /** A failure while a removal is pending: the key serves only the removal. */
  async function removalBlock(): Promise<SessionFailure | null> {
    if (lastFacts === null) {
      await settle();
    }
    const held = await loadNotes();
    return held.removal !== null && gone === null
      ? failure("removal_pending")
      : null;
  }

  async function request<T>(
    call: AuthorizedRequest<T>,
  ): Promise<SessionResult<T | null>> {
    const blocked = await removalBlock();
    return blocked ?? sendAuthorized(call, removalBlock);
  }

  /**
   * Sends `call` with a token, and once more with a new token after a `401`.
   * `blockedBeforeRetry`, when given, is asked again before that new token is
   * minted: a removal noted while the first request was on its way then
   * stops the retry, as it stops every other use of the key.
   */
  async function sendAuthorized<T>(
    call: AuthorizedRequest<T>,
    blockedBeforeRetry?: () => Promise<SessionFailure | null>,
  ): Promise<SessionResult<T | null>> {
    const origin = originOrFailure();
    if (typeof origin !== "string") {
      return origin;
    }
    let path: string;
    try {
      path = routePath(call.route.path, call.params);
    } catch {
      return failure("invalid_request");
    }
    const query = new URLSearchParams(call.query).toString();
    if (query !== "") {
      path = `${path}?${query}`;
    }
    const send = (token: string): Promise<ApiAnswer> =>
      callApi({
        fetch: deps.fetch,
        scheduleTimer,
        origin,
        route: call.route,
        path,
        accessToken: token,
        ...(call.body === undefined ? {} : { body: call.body }),
        ...(call.maxAnswerBytes === undefined
          ? {}
          : { maxAnswerBytes: call.maxAnswerBytes }),
      });
    const first = await sessionToken();
    if (!first.ok) {
      return first;
    }
    let answer = await send(first.token);
    if (isUnauthorized(answer)) {
      // The token ended (expired, a sign-out, a new sign-in, or a revoked
      // device): one new token, which reports the reason if it fails.
      dropToken(first.token);
      const blocked = (await blockedBeforeRetry?.()) ?? null;
      if (blocked !== null) {
        return blocked;
      }
      const second = await sessionToken();
      if (!second.ok) {
        return second;
      }
      answer = await send(second.token);
      if (isUnauthorized(answer)) {
        dropToken(second.token);
        return refused("unauthorized");
      }
    }
    switch (answer.kind) {
      case "ok": {
        if (call.answer === "empty") {
          return answer.value === null
            ? succeeded(null)
            : failure("unexpected_response");
        }
        const parsed = call.answer.safeParse(answer.value);
        return parsed.success
          ? succeeded(parsed.data)
          : failure("unexpected_response");
      }
      case "error":
        return refusedWithLogin(answer.code);
      case "invalid_request":
        return failure("invalid_request");
      default:
        return uncertain(answer);
    }
  }

  // ---- Sign-out ----------------------------------------------------------

  /** Sends `POST /auth/sign-out` with `token`. */
  async function sendSignOut(
    token: string,
    origin: string,
  ): Promise<"reported" | "unauthorized" | SessionFailure> {
    const answer = await callApi({
      fetch: deps.fetch,
      scheduleTimer,
      origin,
      route: AUTH_ROUTES.signOut,
      accessToken: token,
    });
    if (answer.kind === "ok") {
      return "reported";
    }
    if (isUnauthorized(answer)) {
      return "unauthorized";
    }
    return answer.kind === "error" ? refused(answer.code) : uncertain(answer);
  }

  /** The keys that a sign-out marker names now. */
  function markedKeys(facts: ReadyFacts): string[] {
    return [
      ...new Set(
        [
          facts.keys.current.publicKey,
          facts.keys.previous?.publicKey,
          facts.record.publicKey,
        ].filter((key): key is string => key !== undefined),
      ),
    ];
  }

  async function markReported(facts: ReadyFacts): Promise<void> {
    const marker: SignOutMarker = {
      publicKeys: facts.marker?.publicKeys ?? markedKeys(facts),
      reported: true,
    };
    try {
      await deps.signOutMarkers.write(marker);
      unsavedMarker = null;
    } catch {
      // The file still says that the report is pending; the next report
      // finds the sign-out on the API and marks it again.
      report("The sign-out marker could not be written.");
      if (unsavedMarker !== null) {
        unsavedMarker = marker;
      }
    }
  }

  /**
   * Sends the sign-out with `firstToken`, a token minted before the
   * sign-out, or else with a new token that is used for nothing else. A
   * `401` gets one new token.
   */
  async function reportSignOutNow(
    firstToken: string | null,
  ): Promise<SessionResult<"reported" | "pending">> {
    try {
      const facts = await readFacts();
      if (facts.kind !== "ready") {
        return factsFailure(facts);
      }
      if (facts.marker === null || facts.marker.reported) {
        return succeeded("reported");
      }
      const origin = originOrFailure();
      if (typeof origin !== "string") {
        return origin;
      }
      let token = firstToken;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (token === null) {
          const ready = await readFacts();
          if (ready.kind !== "ready") {
            return factsFailure(ready);
          }
          if (ready.marker === null) {
            // A sign-in after the sign-out registered the key that answered.
            return succeeded("reported");
          }
          if (replacementToResolve(ready) && signInsRunning > 0) {
            return failure("sign_in_running");
          }
          const result = await mint(ready, origin);
          if (result.kind === "failure") {
            // After `sign_in_required`, `mint` marked the sign-out reported:
            // the API takes the key only after a new sign-in.
            return result.failure.code === "sign_in_required"
              ? succeeded("reported")
              : result.failure;
          }
          if (!result.marked) {
            return succeeded("reported");
          }
          token = result.token;
        }
        const sent = await sendSignOut(token, origin);
        if (sent === "reported") {
          const after = await readFacts();
          if (after.kind === "ready" && after.marker !== null) {
            await markReported(after);
          }
          return succeeded("reported");
        }
        if (sent !== "unauthorized") {
          return sent;
        }
        // The token ended: one new token.
        token = null;
      }
      return refused("unauthorized");
    } catch {
      report("The device session failed unexpectedly.");
      return failure("key_store_failed");
    } finally {
      await settle();
    }
  }

  function reportSignOut(): Promise<SessionResult<"reported" | "pending">> {
    return exclusive(() => reportSignOutNow(null));
  }

  async function signOut(): Promise<SessionResult<"reported" | "pending">> {
    let validToken: string | null = null;
    const marked = await exclusive(async (): Promise<SessionFailure | null> => {
      if (gone !== null) {
        return failure("no_device");
      }
      const facts = await readFacts();
      if (facts.kind !== "ready") {
        return factsFailure(facts);
      }
      // The tokens are dropped first: from now on the key is not used for
      // anything but the report, which uses a token that is still valid.
      validToken = facts.marker === null ? cachedToken() : null;
      forgetTokens();
      accountMismatch = false;
      // The key is not used after a sign-out, so a pending removal ends.
      await changeNotes((held) => ({ ...held, removal: null }));
      if (facts.marker === null) {
        const marker: SignOutMarker = {
          publicKeys: markedKeys(facts),
          reported: false,
        };
        try {
          await deps.signOutMarkers.write(marker);
        } catch {
          report(
            "The sign-out could not be saved; it holds until the application quits.",
          );
          unsavedMarker = marker;
        }
      }
      await settle();
      return null;
    });
    if (marked !== null) {
      return marked;
    }
    const firstToken: string | null = validToken;
    const reported = await exclusive(() => reportSignOutNow(firstToken));
    if (reported.ok || gone !== null) {
      return reported;
    }
    // The device is signed out already; the API learns it by
    // `reportSignOut`, and the state shows the pending report.
    return succeeded("pending");
  }

  // ---- Removal and the device list ---------------------------------------

  async function removeDevice(): Promise<SessionResult<"removed" | "pending">> {
    // In the key queue, so that the removal starts only after a mint or a
    // sign-out report that runs, and reads what that left behind.
    const noted = await exclusive(
      async (): Promise<DeviceId | SessionFailure> => {
        if (gone !== null) {
          return failure("no_device");
        }
        let facts: Facts;
        try {
          facts = await readFacts();
        } catch {
          return failure("key_store_failed");
        }
        if (facts.kind !== "ready") {
          return factsFailure(facts);
        }
        if (facts.marker !== null) {
          // The API takes no request of a signed-out device: sign in first.
          return failure("signed_out");
        }
        const deviceId = facts.record.deviceId;
        // Noted first, so that the removal holds across a restart.
        await changeNotes((held) => ({ ...held, removal: { deviceId } }));
        await settle();
        return deviceId;
      },
    );
    if (typeof noted !== "string") {
      return noted;
    }
    // Outside the queue: the request mints its token in the queue itself.
    return attemptRemoval(noted);
  }

  /**
   * Refusals that leave a removal pending: the API did not answer the
   * revoke itself, or it may take it later.
   */
  const REMOVAL_KEPT_CODES: readonly ApiErrorCode[] = Object.freeze([
    "auth_failed",
    "sign_in_required",
    "rate_limited",
    "unauthorized",
  ]);

  async function attemptRemoval(
    deviceId: DeviceId,
  ): Promise<SessionResult<"removed" | "pending">> {
    const body: RevokeDeviceRequest = { reason: "removed" };
    const result = await sendAuthorized({
      route: AUTH_ROUTES.revokeDevice,
      params: { deviceId },
      body,
      answer: "empty",
    });
    if (result.ok) {
      // The API confirmed: only now are the key and the record deleted.
      await deviceGone("removed");
      return succeeded("removed");
    }
    if (gone !== null) {
      // `device_revoked`: the device is gone already.
      return result;
    }
    switch (result.reason) {
      case "no_answer":
      case "server_error":
      case "unexpected_response":
        // Whether the API revoked the device is unknown: the key stays, and
        // the removal stays pending until a retry gets an answer.
        return succeeded("pending");
      case "refused":
        if (
          result.code !== undefined &&
          REMOVAL_KEPT_CODES.includes(result.code)
        ) {
          return result;
        }
        break;
      case "signed_out":
      case "no_device":
      case "key_lost":
        break;
      default:
        // For example a key that is not loaded yet: retried later.
        return result;
    }
    // The API refused the revoke, for example `conflict`: the removal ends.
    await changeNotes((held) => ({ ...held, removal: null }));
    await settle();
    return result;
  }

  async function listDevices(): Promise<
    SessionResult<readonly DeviceListItem[]>
  > {
    const result = await request({
      route: AUTH_ROUTES.listDevices,
      answer: DeviceListResponseSchema,
    });
    if (!result.ok) {
      return result;
    }
    return result.value === null
      ? failure("unexpected_response")
      : succeeded(Object.freeze(result.value.devices));
  }

  async function replacementGraceEnd(): Promise<string | null> {
    try {
      return await exclusive(async () => {
        if (gone !== null) {
          return null;
        }
        const facts = await readFacts();
        if (facts.kind !== "ready" || !replacementToResolve(facts)) {
          return null;
        }
        const held = await loadNotes();
        const note = held.uncertainSignIn;
        if (
          note === null ||
          !graceActive(facts, held) ||
          // After a first refusal of both keys, the replacement stays
          // pending after the grace period too, until the wait for a second
          // round (`LOST_KEY_WAIT_MS`) ends, so the end of the grace period
          // is not when a new sign-in can start.
          keysRefusedNote(facts, held) !== null
        ) {
          return null;
        }
        // The grace period ends when both clocks say so (`noteAge` with
        // `least`), so what is left of it counts from the smaller age. The
        // monotonic clock counts fractions of a millisecond, so the end is
        // rounded up: never before the grace period ends.
        const left = REPLACEMENT_GRACE_MS - noteAge("grace", note.at, "least");
        return new Date(Math.ceil(wallClock() + left)).toISOString();
      });
    } catch {
      return null;
    }
  }

  // ---- WebSocket ---------------------------------------------------------

  async function signWebSocketChallenge(
    challenge: AuthChallengeFrame,
  ): Promise<SessionResult<AuthResponseFrame>> {
    const origin = originOrFailure();
    if (typeof origin !== "string") {
      return origin;
    }
    if (gone !== null) {
      return gone === "revoked"
        ? refused("device_revoked")
        : failure("no_device");
    }
    let facts: Facts;
    try {
      facts = await readFacts();
    } catch {
      return failure("key_store_failed");
    }
    if (facts.kind !== "ready") {
      return factsFailure(facts);
    }
    if (facts.marker !== null) {
      return failure("signed_out");
    }
    if (removalNoted(facts.record)) {
      return failure("removal_pending");
    }
    if (refusal !== null) {
      return refused(refusal);
    }
    if (facts.keys.previous !== null) {
      return failure("replacement_pending");
    }
    try {
      return succeeded(
        webSocketAuthResponse(facts.keys.current, {
          audience: origin,
          deviceId: facts.record.deviceId,
          challenge,
        }),
      );
    } catch (error) {
      return isDeviceKeyError(error)
        ? keyStoreFailure(error)
        : failure("invalid_request");
    }
  }

  // ---- Lifecycle ---------------------------------------------------------

  async function authenticate(): Promise<SessionResult<SessionAccount>> {
    const blocked = await removalBlock();
    if (blocked !== null) {
      return blocked;
    }
    const token = await sessionToken();
    if (!token.ok) {
      return token;
    }
    const facts = lastFacts;
    return facts?.kind === "ready"
      ? succeeded(accountOf(facts.record))
      : failure("no_device");
  }

  async function refresh(): Promise<DeviceSessionState> {
    forgetTokens();
    refusal = null;
    accountMismatch = false;
    const state = await settle();
    const facts = lastFacts;
    if (
      gone === null &&
      facts?.kind === "ready" &&
      facts.marker === null &&
      removalNoted(facts.record)
    ) {
      // A removal that the API has not confirmed yet is retried.
      await attemptRemoval(facts.record.deviceId);
      return current;
    }
    return state;
  }

  function signInStarted(): void {
    signInsRunning += 1;
  }

  async function signInFinished(
    outcome: FinishedSignIn,
  ): Promise<DeviceSessionState> {
    signInsRunning = Math.max(0, signInsRunning - 1);
    forgetTokens();
    if (outcome.kind === "signed_in") {
      // A GitHub sign-in ends a refusal, a pending removal, and a removed or
      // revoked device. A sign-out ends by the rule that a marker naming no
      // held key has ended, so a sign-out made while this sign-in ran
      // holds; only a corrupt marker, which names every key, ends here.
      gone = null;
      refusal = null;
      accountMismatch = false;
      await changeNotes((held) => ({ ...held, removal: null }));
      try {
        if ((await deps.signOutMarkers.read()).kind === "corrupt") {
          await dropMarker();
        }
      } catch {
        // An unreadable marker stays: it fails closed.
      }
    } else if (outcome.kind === "refused") {
      if (outcome.code === "device_account_mismatch") {
        accountMismatch = true;
      } else if (outcome.code === "device_revoked") {
        // The flow deleted the key and the record already.
        await deviceGone("revoked");
      }
    }
    // Any other outcome, for example `failed` with `uncertain_refusal`,
    // proves nothing: the API may still commit the sign-in. A pending
    // replacement gets its grace period from now (`tidyNotes`), and the
    // sign-out marker still names the previous key.
    return settle();
  }

  async function deviceRefused(
    code: "auth_failed" | "device_revoked" | "sign_in_required",
    deviceId: DeviceId,
  ): Promise<DeviceSessionState> {
    const facts = await readFacts();
    if (
      (facts.kind !== "ready" && facts.kind !== "key_not_loaded") ||
      facts.record.deviceId !== deviceId
    ) {
      // Not this installation's device: a late close of a connection of a
      // device that it no longer holds.
      return current;
    }
    forgetTokens();
    if (code === "device_revoked") {
      await deviceGone("revoked");
    } else {
      refusal = code;
    }
    return settle();
  }

  return Object.freeze({
    state: () => current,
    onChange: (listener: (state: DeviceSessionState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    signInStarted,
    signInFinished,
    authenticate,
    request,
    listDevices,
    signOut,
    reportSignOut,
    removeDevice,
    replacementGraceEnd,
    signWebSocketChallenge,
    deviceRefused,
  });
}
