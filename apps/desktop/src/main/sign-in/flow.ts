// The sign-in flow of the main process (ADR 0014, "Sign-in", steps 1, 6,
// and 7). It joins the device key store, the device record, the attempt,
// and the loopback listener, opens the system browser, and posts the code
// with the device registration to `POST /auth/sign-in`.
//
// It decides between a new device (no record, or no key) and an existing
// device (a record and a loaded key). A new device whose registration got no
// clear answer sends the same key again at the next attempt
// (`registration-marker.ts`, #153). It never logs or returns the code, the
// verifier, a signature, or a key; a message for `onError` is fixed text.
import {
  type ApiErrorCode,
  ApiErrorBodySchema,
  AUTH_ROUTES,
  type DeviceAuthInput,
  type DeviceId,
  type DevicePlatform,
  type DeviceRegistration,
  displayText,
  LIMITS,
  type SignInRequest,
  SignInResponseSchema,
  type UserId,
} from "@mymandev/protocol";
import type { ApiOrigin } from "../api-origin.ts";
import {
  type DeviceKeyErrorCode,
  isDeviceKeyError,
} from "../device-key/errors.ts";
import type { DeviceKey } from "../device-key/signing-key.ts";
import type {
  DeviceKeyStore,
  NewDeviceKeyProtection,
  ReplaceDeviceKeyOptions,
} from "../device-key/store.ts";
import type {
  DeviceRecord,
  DeviceRecordRead,
  DeviceRecordStore,
} from "../device-record.ts";
import type { ScheduleTimer } from "../runtime.ts";
import {
  type AuthorizeSignInKind,
  authorizeUrl,
  createSignInAttempt,
} from "./attempt.ts";
import {
  type SignInListener,
  type SignInListenerError,
  type SignInListenerOptions,
  startSignInListener,
} from "./listener.ts";
import type {
  RegistrationMarker,
  RegistrationMarkerStore,
} from "./registration-marker.ts";

/**
 * Shown with the authorize URL when the browser could not be opened (#149),
 * or when the person asked for the address instead of the default browser
 * (#175): the URL holds the attempt's state, and whoever has it while the
 * attempt is open could sign this device in to another account.
 */
export const SIGN_IN_URL_WARNING =
  "Open this address in your own browser. Do not share it with anyone: while this sign-in is open, someone who has it could sign this device in to their account.";

/**
 * How long the answer of `POST /auth/sign-in` may take before the flow stops
 * waiting. It must not exceed the API's request timeout of 30 seconds (see
 * `UNCERTAIN_REFUSAL_CODES`).
 */
export const SIGN_IN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long opening the system browser may take. After that the attempt
 * continues as if the browser did not open: the URL is shown for copying.
 */
export const OPEN_EXTERNAL_TIMEOUT_MS = 10_000;

/** An answer body larger than this many bytes is not read as an answer of the API. */
export const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * How long after its first attempt the key of a new device's uncertain
 * registration is sent again (#153). The next attempt that the person
 * starts settles it, usually within minutes; seven days also cover an
 * outage of the API or a person who comes back after a week away. After
 * that, a key that never had a clear answer is not kept: it is deleted, and
 * a new device registers with a new key, as before #153. A key that the API
 * registered then stays a device that nobody can use, until the person
 * removes it from another device.
 */
export const REGISTRATION_RESEND_MS = 7 * 24 * 60 * 60_000;

/**
 * Why a sign-in failed without an answer of the API that names a code:
 *
 * - `api_origin_unset`, `api_origin_invalid`: see `resolveApiOrigin`.
 * - `unsupported_platform`: not Windows, macOS, or Linux.
 * - `label_invalid`: a device label outside the protocol's format.
 * - `already_running`: another attempt of this flow is open.
 * - `key_not_loaded`: a record and a key file exist, but the key is not
 *   loaded (for example, its passphrase was not entered yet).
 * - `replacement_pending`: a previous key is still kept; an authentication
 *   must first learn which key the API holds.
 * - `key_store_failed`: the key store refused or failed to read, create,
 *   replace, or delete a key.
 * - `system_protection_unavailable`: before the browser opens, the system
 *   cannot protect the key that this attempt would create: a new device's
 *   key with the system's protection, or the replacement of a key that the
 *   system protects (see `systemProtection` of the key store). On Windows
 *   and macOS the person must make the system's protection available; on
 *   Linux a secret service is needed until the passphrase choice exists.
 * - `record_unreadable`: the record file cannot be read, or it is corrupt
 *   (for example another version, after a downgrade) while a key file
 *   exists, or the registration marker cannot be read while a key that no
 *   record names would be deleted (#153). The key may still be the key of a
 *   device that the API knows, so it is kept; an explicit reset is a later
 *   option.
 * - `listener_unavailable`: the loopback listener could not start.
 * - `no_answer`: no answer arrived (a network error, or the request timed
 *   out); a key replacement stays pending.
 * - `server_error`: a `5xx` answer. The API may have committed before it
 *   failed, so it is handled like `no_answer`.
 * - `unexpected_response`: an answer that is not one of the API's, or a new
 *   device's `200` that names the device whose key was lost; handled like
 *   `no_answer`.
 * - `unexpected`: an error that the flow did not expect after the attempt
 *   started, not a failure of the key store; nothing is undone.
 * - `uncertain_refusal`: the API answered with a code of
 *   `UNCERTAIN_REFUSAL_CODES`, which `apiError` carries. A resent copy of a
 *   request that committed gets that answer too, so it is handled like
 *   `no_answer`.
 * - `key_changed`: after the key replacement, the previous key is not the
 *   key that the record names, or the key that a new device sends again is
 *   no longer the key held, so the key store changed during the attempt. A
 *   replacement is abandoned, and nothing is signed or sent.
 * - `record_not_saved`: the API registered the device, but the record could
 *   not be written, also when tried a second time. An existing device keeps
 *   the replacement pending. The flow keeps the record in memory, and the
 *   next attempt writes it before anything else (and answers
 *   `record_not_saved` again while it still cannot).
 */
export const SIGN_IN_FAILURE_REASONS = Object.freeze([
  "api_origin_unset",
  "api_origin_invalid",
  "unsupported_platform",
  "label_invalid",
  "already_running",
  "key_not_loaded",
  "replacement_pending",
  "key_store_failed",
  "system_protection_unavailable",
  "record_unreadable",
  "listener_unavailable",
  "no_answer",
  "server_error",
  "unexpected_response",
  "unexpected",
  "uncertain_refusal",
  "key_changed",
  "record_not_saved",
] as const);
export type SignInFailureReason = (typeof SIGN_IN_FAILURE_REASONS)[number];

/**
 * The refusals of the API that do not prove that nothing was committed. When
 * the connection fails after the API committed, `net.fetch` or a proxy can
 * send the same request again, and only the answer to that copy arrives.
 * `POST /auth/sign-in` answers such a copy with `sign_in_code_used` while it
 * keeps its record of the code, for a minute after the first copy ended
 * (#152). That record lives in API memory only: a copy that reaches a
 * restarted API gets `auth_failed`, because the API takes the sign-in code
 * before every other check. The route's limit can refuse a copy with
 * `rate_limited` before that. A copy of a request that committed cannot get
 * any other refusal: those answer a request that the API refused before its
 * transaction committed. The API's request timeout answers `408` with
 * `bad_request`, but only after 30 seconds, when the flow has stopped waiting
 * (`SIGN_IN_REQUEST_TIMEOUT_MS` must not exceed the API's request timeout).
 * `auth_failed` stays in this list for the restarted API; whether it can
 * leave is a separate decision.
 */
export const UNCERTAIN_REFUSAL_CODES = Object.freeze([
  "auth_failed",
  "rate_limited",
  "sign_in_code_used",
] as const satisfies readonly ApiErrorCode[]);
export type UncertainRefusalCode = (typeof UNCERTAIN_REFUSAL_CODES)[number];

function isUncertainRefusal(code: ApiErrorCode): code is UncertainRefusalCode {
  return (UNCERTAIN_REFUSAL_CODES as readonly ApiErrorCode[]).includes(code);
}

/** The account that the device is signed in to. */
export interface SignedInAccount {
  readonly userId: UserId;
  readonly login: string;
  readonly displayName: string;
  readonly deviceId: DeviceId;
  readonly signInExpiresAt: string;
}

/** How a started sign-in ended. Holds no code, verifier, signature, or key. */
export type SignInOutcome =
  | {
      readonly kind: "signed_in";
      readonly account: SignedInAccount;
      /** Whether this sign-in registered a new device. */
      readonly newDevice: boolean;
      /**
       * The GitHub login to show after the sign-in, with the path for "this
       * is not me" (#149).
       */
      readonly login: string;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timed_out" }
  | { readonly kind: "listener_error"; readonly error: SignInListenerError }
  | {
      readonly kind: "refused";
      /** Never a code of `UNCERTAIN_REFUSAL_CODES`. */
      readonly code: ApiErrorCode;
      /**
       * With `device_account_mismatch`: the login of the account that this
       * installation holds, which the error body does not carry.
       */
      readonly deviceLogin?: string;
    }
  | {
      readonly kind: "failed";
      readonly reason: SignInFailureReason;
      /**
       * With `key_store_failed`: the code of the store's `DeviceKeyError`,
       * for example `system_protection_unavailable`, when it raised one.
       */
      readonly keyError?: DeviceKeyErrorCode;
      /** With `uncertain_refusal`: the API's error code. */
      readonly apiError?: UncertainRefusalCode;
    };

interface StartedSignInBase {
  readonly started: true;
  /** Six digits that the API's confirmation page shows too. */
  readonly pairingCode: string;
  /** Ends the attempt; `outcome` then resolves with `cancelled`. */
  readonly cancel: () => void;
  /** Resolves once; never rejects. */
  readonly outcome: Promise<SignInOutcome>;
}

/**
 * The result of `start`. When the browser could not be opened, or the
 * caller asked not to open it (`openBrowser: false`), the URL is shown for
 * copying together with `SIGN_IN_URL_WARNING`.
 */
export type SignInStart =
  | { readonly started: false; readonly outcome: SignInOutcome }
  | (StartedSignInBase & { readonly opened: true })
  | (StartedSignInBase & {
      readonly opened: false;
      readonly authorizeUrl: string;
      readonly warning: typeof SIGN_IN_URL_WARNING;
    });

export interface SignInStartOptions {
  /**
   * How a new device's key is protected. Defaults to the system's
   * protection; the passphrase and unprotected keys exist on Linux only.
   */
  readonly newKeyProtection?: NewDeviceKeyProtection;
  /** Passed to `replace` for an existing device. */
  readonly replaceOptions?: ReplaceDeviceKeyOptions;
  /** A device label that the person chose; defaults to `suggestedDeviceLabel`. */
  readonly label?: string;
  /**
   * False when the person completes the sign-in in a browser of their
   * choice (#175): the attempt starts as usual, but the default browser is
   * not opened, and the result offers the URL with `SIGN_IN_URL_WARNING`
   * as when the browser did not open. The attempt is bound to the browser
   * that opens the URL first. Defaults to true.
   */
  readonly openBrowser?: boolean;
  /**
   * Called once, right after the listener accepted the valid request (the
   * API's page posted a code or an error), before the key changes and before
   * `POST /auth/sign-in`: ADR 0014, "Sign-in", step 6, brings the window to
   * the front then. Not called after a cancel or the timeout. An error that
   * it throws is ignored.
   */
  readonly onCallback?: () => void;
}

/** The part of the device key store that the flow uses. */
export type SignInKeyStore = Pick<
  DeviceKeyStore,
  | "systemProtection"
  | "status"
  | "hasKey"
  | "keys"
  | "create"
  | "replace"
  | "confirmReplacement"
  | "abandonReplacement"
  | "delete"
>;

/** The `fetch` that the flow uses; production passes Electron's `net.fetch`. */
export type SignInFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SignInFlowDependencies {
  /** From `resolveApiOrigin`. */
  readonly apiOrigin: ApiOrigin;
  readonly keyStore: SignInKeyStore;
  readonly deviceRecords: DeviceRecordStore;
  /** The marker of a new device's key whose registration got no clear answer. */
  readonly registrationMarkers: RegistrationMarkerStore;
  /** Opens the URL in the system browser; resolves false when it could not. */
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly fetch: SignInFetch;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** The clock of the listener's 10 minutes and of the request; defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /**
   * The wall clock of the registration marker, in milliseconds since the
   * epoch; defaults to `Date.now`.
   */
  readonly wallClock?: () => number;
  /** Passed to the listener; tests pass a shorter one. */
  readonly listenerConnectionTimeoutMs?: number;
  /** Receives a fixed message for an error that the flow handled. */
  readonly onError?: (message: string) => void;
}

export interface SignInFlow {
  /**
   * Starts a sign-in after the person's action: creates the attempt, starts
   * the listener, and opens the browser, unless `openBrowser` is false.
   * Never rejects.
   */
  readonly start: (options?: SignInStartOptions) => Promise<SignInStart>;
  /**
   * Forgets what the flow keeps between attempts: a record that could not be
   * written, and the account mismatch that adds `prompt`. Called when the
   * installation forgets its account ("This is not me", #149), so that
   * nothing of that account carries over to the next attempt. Returns false
   * and changes nothing while an attempt runs.
   */
  readonly reset: () => boolean;
}

const DEVICE_PLATFORMS_BY_NODE: Readonly<
  Partial<Record<NodeJS.Platform, DevicePlatform>>
> = Object.freeze({ win32: "windows", darwin: "macos", linux: "linux" });

const SUGGESTED_LABELS: Readonly<Record<DevicePlatform, string>> =
  Object.freeze({
    windows: "Windows computer",
    macos: "Mac",
    linux: "Linux computer",
  });

/** The device platform of a Node.js platform, or null for another system. */
export function devicePlatform(
  platform: NodeJS.Platform,
): DevicePlatform | null {
  return DEVICE_PLATFORMS_BY_NODE[platform] ?? null;
}

/** A device label from the platform only, never from the host name. */
export function suggestedDeviceLabel(platform: DevicePlatform): string {
  return SUGGESTED_LABELS[platform];
}

const labelSchema = displayText(LIMITS.deviceLabel);

const scheduleWithSetTimeout: ScheduleTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

function failed(reason: SignInFailureReason): SignInOutcome {
  return Object.freeze({ kind: "failed", reason });
}

function notStarted(reason: SignInFailureReason): SignInStart {
  return Object.freeze({ started: false, outcome: failed(reason) });
}

/**
 * The device as the flow found it at the start of an attempt. A new device
 * keeps the record of a device whose key was lost: it names that device and
 * signs in as its account. `resend` is the key of an earlier registration
 * that got no clear answer, which this attempt sends again instead of a new
 * key (#153).
 */
type DevicePlan =
  | {
      readonly kind: "new";
      readonly record: DeviceRecord | null;
      readonly resend: DeviceKey | null;
    }
  | { readonly kind: "existing"; readonly record: DeviceRecord };

/** What the API answered, read without trusting it. */
type Answer =
  | { readonly kind: "signed_in"; readonly body: SignedInAccount }
  | { readonly kind: "error"; readonly code: ApiErrorCode }
  | { readonly kind: "server_error" }
  | { readonly kind: "unexpected" };

/**
 * Reads the body as UTF-8 text, at most `MAX_ANSWER_BYTES`: a larger
 * `Content-Length` is refused before reading, and the stream is cancelled
 * once it passes the limit. Null for a body that is too large or not UTF-8.
 * Rejects when the body cannot be read, like a request without an answer.
 */
async function readBodyText(response: Response): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_ANSWER_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = response.body;
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    return null;
  }
}

async function readAnswer(response: Response): Promise<Answer> {
  if (response.status >= 500 && response.status <= 599) {
    // The API may have committed before it failed: after the transaction
    // it still drops tokens and closes connections, and a lost commit
    // acknowledgement ends as a 500 too.
    await response.body?.cancel().catch(() => undefined);
    return { kind: "server_error" };
  }
  const text = await readBodyText(response);
  if (text === null) {
    return { kind: "unexpected" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { kind: "unexpected" };
  }
  if (response.status === 200) {
    const parsed = SignInResponseSchema.safeParse(value);
    return parsed.success
      ? {
          kind: "signed_in",
          body: Object.freeze({
            userId: parsed.data.userId,
            login: parsed.data.login,
            displayName: parsed.data.displayName,
            deviceId: parsed.data.deviceId,
            signInExpiresAt: parsed.data.signInExpiresAt,
          }),
        }
      : { kind: "unexpected" };
  }
  // Only a 4xx with the API's error body is a refusal of the API; whether it
  // proves that nothing was committed depends on its code (see
  // `UNCERTAIN_REFUSAL_CODES`).
  if (response.status >= 400 && response.status <= 499) {
    const parsed = ApiErrorBodySchema.safeParse(value);
    if (parsed.success && parsed.data.statusCode === response.status) {
      return { kind: "error", code: parsed.data.code };
    }
  }
  return { kind: "unexpected" };
}

export function createSignInFlow(deps: SignInFlowDependencies): SignInFlow {
  const scheduleTimer = deps.scheduleTimer ?? scheduleWithSetTimeout;
  const wallClock = deps.wallClock ?? (() => Date.now());
  const report = (message: string): void => {
    try {
      deps.onError?.(message);
    } catch {
      // A failing report never changes the sign-in.
    }
  };
  let running = false;
  /** Set by `device_account_mismatch`; the next attempt adds `prompt`. */
  let afterAccountMismatch = false;
  /**
   * A record that the API answered with `200` but that could not be
   * written, kept in memory so that the next attempt writes it first and
   * never treats the registered key as a leftover.
   */
  let unsavedRecord: DeviceRecord | null = null;

  /**
   * Reads the registration marker; a corrupt one names no key and is
   * dropped. `unreadable` when the file exists but cannot be read: whether
   * it names the key is then unknown.
   */
  async function readRegistrationMarker(): Promise<
    RegistrationMarker | "unreadable" | null
  > {
    let read;
    try {
      read = await deps.registrationMarkers.read();
    } catch {
      report("The registration marker could not be read.");
      return "unreadable";
    }
    if (read.kind === "corrupt") {
      report("The registration marker is corrupt and is not used.");
      await dropRegistrationMarker();
      return null;
    }
    return read.kind === "marker" ? read.marker : null;
  }

  async function dropRegistrationMarker(): Promise<void> {
    try {
      await deps.registrationMarkers.delete();
    } catch {
      report("The registration marker could not be deleted.");
    }
  }

  /**
   * The key that this attempt sends again (#153): the loaded key that the
   * marker names, when no record names it, no replacement is pending, and
   * the marker's first attempt is less than `REGISTRATION_RESEND_MS` ago. A
   * time in the future means that the clock went back, so the age is
   * unknown and the key is not sent again. A key that is not loaded cannot
   * sign, so it is not sent again either.
   */
  function resendOf(
    marker: RegistrationMarker | null,
    recordKey: string | null,
  ): DeviceKey | null {
    // The callers ask only when no record names the loaded key and no
    // replacement is pending, so the record's key and `previous` cannot
    // match here; both checks stay as defense in depth, so that the key
    // of a record's device is never sent as a new device.
    if (marker === null || marker.publicKey === recordKey) {
      return null;
    }
    const keys = deps.keyStore.keys();
    if (
      keys === null ||
      keys.previous !== null ||
      keys.current.publicKey !== marker.publicKey
    ) {
      return null;
    }
    const age = wallClock() - Date.parse(marker.at);
    return age >= 0 && age < REGISTRATION_RESEND_MS ? keys.current : null;
  }

  /**
   * Decides between a new and an existing device, and removes a leftover
   * key. A marker that this attempt does not send again is dropped.
   */
  async function planDevice(): Promise<DevicePlan | SignInFailureReason> {
    if (unsavedRecord !== null) {
      try {
        await deps.deviceRecords.write(unsavedRecord);
        unsavedRecord = null;
      } catch {
        report("The device record could not be written.");
        return "record_not_saved";
      }
    }
    let read;
    try {
      read = await deps.deviceRecords.read();
    } catch {
      return "record_unreadable";
    }
    let hasKey: boolean;
    try {
      hasKey = await deps.keyStore.hasKey();
    } catch {
      return "key_store_failed";
    }
    const marker = await readRegistrationMarker();
    const plan = await planFrom(read, hasKey, marker);
    if (
      marker !== null &&
      marker !== "unreadable" &&
      typeof plan !== "string" &&
      (plan.kind === "existing" || plan.resend === null)
    ) {
      // An expired marker, or one whose key a record names or that is gone.
      await dropRegistrationMarker();
    }
    return plan;
  }

  async function planFrom(
    read: DeviceRecordRead,
    hasKey: boolean,
    marker: RegistrationMarker | "unreadable" | null,
  ): Promise<DevicePlan | SignInFailureReason> {
    /**
     * The key to send again, or `record_unreadable` when the marker cannot
     * be read: the key may be one that the API holds, so it is kept.
     */
    const resendOrStop = (
      recordKey: string | null,
    ): DeviceKey | null | "record_unreadable" => {
      if (marker === "unreadable") {
        report(
          "The registration marker could not be read; the device key is kept.",
        );
        return "record_unreadable";
      }
      return resendOf(marker, recordKey);
    };
    if (read.kind === "record") {
      if (!hasKey) {
        // The key was lost: a new device that names the previous one.
        return { kind: "new", record: read.record, resend: null };
      }
      const keys = deps.keyStore.keys();
      if (keys === null) {
        return "key_not_loaded";
      }
      if (keys.previous !== null) {
        if (keys.current.publicKey === read.record.publicKey) {
          // The record names the new key, and the flow writes it only after
          // a `200` proved that the API holds that key: the application
          // stopped between the record write and the confirmation.
          try {
            await deps.keyStore.confirmReplacement();
          } catch {
            return "key_store_failed";
          }
          return { kind: "existing", record: read.record };
        }
        // The record still names the previous key: whether the API holds
        // the new one is unknown, and an authentication must learn it first
        // (part 3). Neither key is ever deleted here.
        return "replacement_pending";
      }
      if (keys.current.publicKey !== read.record.publicKey) {
        // Not the key of the record's device, and no replacement pending: a
        // confirmed key always sits next to a record that names it, so this
        // is the key of a new device whose registration got no clear answer
        // after that device's key was lost. Within the marker's time it is
        // sent again, as a new device that names the record's device again
        // (#153); it is never used with the record's device ID.
        const resend = resendOrStop(read.record.publicKey);
        if (resend === "record_unreadable") {
          return resend;
        }
        if (resend !== null) {
          return { kind: "new", record: read.record, resend };
        }
        // Otherwise the API offers no way to learn the new device's ID, so
        // a new device names the record's device again, with a new key.
        try {
          await deps.keyStore.delete();
        } catch {
          return "key_store_failed";
        }
        return { kind: "new", record: read.record, resend: null };
      }
      return { kind: "existing", record: read.record };
    }
    if (read.kind === "corrupt") {
      if (hasKey) {
        // The key may still be the key of a device that the API knows, for
        // example after a downgrade that cannot read a newer record. It is
        // kept; an explicit reset is a later option.
        report("The device record is corrupt; the device key is kept.");
        return "record_unreadable";
      }
      report("The device record is corrupt and is not used.");
      return { kind: "new", record: null, resend: null };
    }
    // The key is deleted only when no record exists at all.
    if (hasKey) {
      // The key of a first registration that got no clear answer is sent
      // again within the marker's time (#153).
      const resend = resendOrStop(null);
      if (resend === "record_unreadable") {
        return resend;
      }
      if (resend !== null) {
        return { kind: "new", record: null, resend };
      }
      // Any other key without a record belongs to no device that this
      // installation knows; a new device needs a new key.
      try {
        await deps.keyStore.delete();
      } catch {
        return "key_store_failed";
      }
    }
    return { kind: "new", record: null, resend: null };
  }

  /**
   * Whether the key that this attempt would store cannot be stored now: a
   * new device's key with the system's protection, or the replacement of a
   * key that the system protects, needs the system's protection (see
   * `replace` of the key store). Checked before the browser opens, so that
   * the person does not finish the browser's part only for the key to fail.
   * A key that a passphrase protects, or an unprotected one, is left to the
   * store's own rules.
   */
  async function protectionProblem(
    plan: DevicePlan,
    options: SignInStartOptions,
  ): Promise<SignInFailureReason | null> {
    try {
      const needsSystem =
        plan.kind === "new"
          ? (options.newKeyProtection ?? { kind: "system" }).kind === "system"
          : (await deps.keyStore.status()).protection === "system";
      if (!needsSystem) {
        return null;
      }
      return (await deps.keyStore.systemProtection()).available
        ? null
        : "system_protection_unavailable";
    } catch {
      return "key_store_failed";
    }
  }

  function signInKind(plan: DevicePlan): AuthorizeSignInKind {
    const login = plan.record?.login;
    if (afterAccountMismatch) {
      return login === undefined
        ? { kind: "after_account_mismatch" }
        : { kind: "after_account_mismatch", login };
    }
    return login === undefined
      ? { kind: "first" }
      : { kind: "repeated", login };
  }

  async function start(options: SignInStartOptions = {}): Promise<SignInStart> {
    if (!deps.apiOrigin.ok) {
      return notStarted(deps.apiOrigin.reason);
    }
    const apiOrigin = deps.apiOrigin.origin;
    const platform = devicePlatform(deps.platform);
    if (platform === null) {
      return notStarted("unsupported_platform");
    }
    const label = options.label ?? suggestedDeviceLabel(platform);
    if (!labelSchema.safeParse(label).success) {
      return notStarted("label_invalid");
    }
    if (running) {
      return notStarted("already_running");
    }
    running = true;
    let handedOff = false;
    try {
      const plan = await planDevice();
      if (typeof plan === "string") {
        return notStarted(plan);
      }
      const protection = await protectionProblem(plan, options);
      if (protection !== null) {
        return notStarted(protection);
      }
      const attempt = createSignInAttempt();
      let listener: SignInListener;
      try {
        const listenerOptions: SignInListenerOptions = {
          state: attempt.state,
          scheduleTimer,
          onError: report,
          ...(deps.listenerConnectionTimeoutMs === undefined
            ? {}
            : { connectionTimeoutMs: deps.listenerConnectionTimeoutMs }),
        };
        listener = await startSignInListener(listenerOptions);
      } catch {
        report("The sign-in listener could not start.");
        return notStarted("listener_unavailable");
      }
      let url: string;
      try {
        url = authorizeUrl({
          apiOrigin,
          codeChallenge: attempt.codeChallenge,
          redirectUri: listener.redirectUri,
          state: attempt.state,
          signIn: signInKind(plan),
        });
      } catch {
        // The origin and the record's login were checked already, so this
        // does not happen; the listener still closes.
        listener.cancel();
        return notStarted("api_origin_invalid");
      }

      const abort = new AbortController();
      let cancelled = false;
      const cancel = (): void => {
        cancelled = true;
        listener.cancel();
        abort.abort();
      };

      let opened = false;
      try {
        // Without `openBrowser`, the person opens the URL in a browser of
        // their choice; nothing is launched.
        opened =
          options.openBrowser !== false &&
          (await new Promise<boolean>((resolve, reject) => {
            // A browser launch that never returns must not hold back the
            // attempt: after the timeout the URL is shown for copying.
            const cancelTimer = scheduleTimer(
              () => resolve(false),
              OPEN_EXTERNAL_TIMEOUT_MS,
            );
            Promise.resolve()
              .then(() => deps.openExternal(url))
              .then(
                (value) => {
                  cancelTimer();
                  resolve(value === true);
                },
                (error: unknown) => {
                  cancelTimer();
                  reject(error instanceof Error ? error : new Error("failed"));
                },
              );
          }));
      } catch {
        opened = false;
      }
      if (!opened && options.openBrowser !== false) {
        report("The system browser could not be opened.");
      }

      const outcome = finish({
        plan,
        listener,
        apiOrigin,
        platform,
        label,
        attempt,
        abort,
        isCancelled: () => cancelled,
        options,
      }).finally(() => {
        running = false;
      });
      handedOff = true;
      const base = {
        started: true as const,
        pairingCode: attempt.pairingCode,
        cancel,
        outcome,
      };
      return Object.freeze(
        opened
          ? { ...base, opened: true as const }
          : {
              ...base,
              opened: false as const,
              authorizeUrl: url,
              warning: SIGN_IN_URL_WARNING,
            },
      );
    } finally {
      if (!handedOff) {
        running = false;
      }
    }
  }

  interface FinishInput {
    readonly plan: DevicePlan;
    readonly listener: SignInListener;
    readonly apiOrigin: string;
    readonly platform: DevicePlatform;
    readonly label: string;
    readonly attempt: ReturnType<typeof createSignInAttempt>;
    readonly abort: AbortController;
    readonly isCancelled: () => boolean;
    readonly options: SignInStartOptions;
  }

  /** Waits for the listener, registers the device, and never rejects. */
  async function finish(input: FinishInput): Promise<SignInOutcome> {
    try {
      return await register(input);
    } catch {
      report("The sign-in failed unexpectedly.");
      return failed("unexpected");
    }
  }

  /**
   * Undoes the key change of a request that the API refused with a `4xx`
   * error body whose code is not in `UNCERTAIN_REFUSAL_CODES`, so it
   * committed nothing. A new device's key is deleted, also a key sent again,
   * and so is its registration marker: the refusal is certain, so the next
   * attempt registers a new device with a new key, as before #153.
   *
   * When whether the API committed is unknown (no answer, a `5xx`, an answer
   * that is not the API's, or an uncertain refusal), nothing is undone: an
   * existing device keeps the replacement pending, and part 3 tries the new
   * key first. A new device keeps its new key and its registration marker,
   * and the record of a lost key stays as it was. The next attempt, within
   * `REGISTRATION_RESEND_MS` of the first, sends the same key again, as a
   * new device that names the record's device if there is one (#153). If
   * the earlier request committed, the API answers with the device that it
   * registered then, without a second device and without a second alert to
   * the account's other devices; otherwise it registers the key now.
   *
   * Without the marker, after that time, or when the key is not loaded, the
   * next attempt deletes the key and registers a new device with a new key.
   * If an uncertain request did commit, that device stays: it is never
   * revoked on its own, and after its sign-in expiry it only requires a new
   * sign-in, which nothing can sign. Until the person removes it from
   * another device, it is listed among the account's devices and counts
   * toward the account's 20 active devices; it also counted toward the 10
   * new devices per 24 hours, and the account's other devices were told of
   * it as a new device.
   */
  async function undoKey(plan: DevicePlan): Promise<void> {
    try {
      if (plan.kind === "existing") {
        await deps.keyStore.abandonReplacement();
      } else {
        await deps.keyStore.delete();
      }
    } catch {
      report("The new device key could not be discarded.");
    }
    if (plan.kind === "new") {
      await dropRegistrationMarker();
    }
  }

  async function register(input: FinishInput): Promise<SignInOutcome> {
    const { plan, listener, apiOrigin, attempt, abort } = input;
    const result = await listener.wait();
    if (result.kind === "code" || result.kind === "error") {
      // The valid request arrived: the window comes to the front now, not
      // after the answer of `POST /auth/sign-in`.
      try {
        input.options.onCallback?.();
      } catch {
        // A failing callback never changes the sign-in.
      }
    }
    switch (result.kind) {
      case "cancelled":
        return Object.freeze({ kind: "cancelled" });
      case "timed_out":
        return Object.freeze({ kind: "timed_out" });
      case "error":
        return Object.freeze({ kind: "listener_error", error: result.error });
      case "code":
        break;
    }
    const code = result.code;

    // The key changes only now that a code arrived.
    let device: DeviceRegistration;
    try {
      if (plan.kind === "existing") {
        const keys = await deps.keyStore.replace(input.options.replaceOptions);
        if (keys.previous === null) {
          throw new Error("No previous key after a replacement.");
        }
        if (keys.previous.publicKey !== plan.record.publicKey) {
          // The key store changed since the attempt started: the previous
          // key is not the key of the record's device, so it never signs
          // for that device ID.
          report("The device key changed during the sign-in.");
          try {
            await deps.keyStore.abandonReplacement();
          } catch {
            report("The new device key could not be discarded.");
          }
          return failed("key_changed");
        }
        const signed: DeviceAuthInput = {
          purpose: "sign-in",
          audience: apiOrigin,
          signInCode: code,
          deviceId: plan.record.deviceId,
          newPublicKey: keys.current.publicKey,
        };
        device = {
          kind: "existing",
          deviceId: plan.record.deviceId,
          publicKey: keys.current.publicKey,
          keyAlgorithm: "ed25519",
          currentKeySignature: keys.previous.sign(signed),
          newKeySignature: keys.current.sign(signed),
        };
      } else {
        let key: DeviceKey;
        if (plan.resend === null) {
          key = await deps.keyStore.create(
            input.options.newKeyProtection ?? { kind: "system" },
          );
        } else {
          const keys = deps.keyStore.keys();
          if (
            keys === null ||
            keys.previous !== null ||
            keys.current.publicKey !== plan.resend.publicKey
          ) {
            // The key store changed since the attempt started: the key to
            // send again is no longer the key held. Nothing is deleted.
            report("The device key changed during the sign-in.");
            return failed("key_changed");
          }
          key = keys.current;
        }
        const signed: DeviceAuthInput = {
          purpose: "sign-in",
          audience: apiOrigin,
          signInCode: code,
          deviceId: null,
          newPublicKey: key.publicKey,
        };
        device = {
          kind: "new",
          publicKey: key.publicKey,
          keyAlgorithm: "ed25519",
          label: input.label,
          platform: input.platform,
          newKeySignature: key.sign(signed),
          ...(plan.record === null
            ? {}
            : { previousDeviceId: plan.record.deviceId }),
        };
      }
    } catch (error) {
      report("The device key could not be prepared for the sign-in.");
      return Object.freeze(
        isDeviceKeyError(error)
          ? { kind: "failed", reason: "key_store_failed", keyError: error.code }
          : { kind: "failed", reason: "key_store_failed" },
      );
    }

    if (input.isCancelled()) {
      // Nothing was sent. A key sent before stays for the next attempt,
      // because the API may hold it (#153).
      if (plan.kind === "existing" || plan.resend === null) {
        await undoKey(plan);
      }
      return Object.freeze({ kind: "cancelled" });
    }

    if (plan.kind === "new" && plan.resend === null) {
      // Written before the request, so that a stop of the application while
      // it runs keeps the key too (#153). Without the marker, the next
      // attempt deletes the key, as before #153.
      try {
        await deps.registrationMarkers.write({
          publicKey: device.publicKey,
          at: new Date(wallClock()).toISOString(),
        });
      } catch {
        report("The registration marker could not be saved.");
      }
    }

    const request: SignInRequest = {
      code,
      codeVerifier: attempt.codeVerifier,
      redirectUri: listener.redirectUri,
      device,
    };
    const cancelTimeout = scheduleTimer(
      () => abort.abort(),
      SIGN_IN_REQUEST_TIMEOUT_MS,
    );
    let answer: Answer;
    try {
      const response = await deps.fetch(
        new URL(AUTH_ROUTES.signIn.path, apiOrigin).href,
        {
          method: AUTH_ROUTES.signIn.method,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(request),
          redirect: "error",
          signal: abort.signal,
        },
      );
      answer = await readAnswer(response);
    } catch {
      // No answer arrived: the API may hold the new key or not. Nothing is
      // undone (see `undoKey`).
      if (input.isCancelled()) {
        return Object.freeze({ kind: "cancelled" });
      }
      report("The sign-in request got no answer.");
      return failed("no_answer");
    } finally {
      cancelTimeout();
    }

    if (answer.kind === "server_error" || answer.kind === "unexpected") {
      // Whether the API committed is unknown; nothing is undone.
      report(
        answer.kind === "server_error"
          ? "The sign-in request got a server error."
          : "The sign-in request got an unexpected answer.",
      );
      return failed(
        answer.kind === "server_error" ? "server_error" : "unexpected_response",
      );
    }

    if (answer.kind === "error" && isUncertainRefusal(answer.code)) {
      // A resent copy of a request that committed gets this answer too;
      // nothing is undone (see `undoKey`).
      report("The sign-in request got a refusal that may follow a commit.");
      return Object.freeze({
        kind: "failed",
        reason: "uncertain_refusal",
        apiError: answer.code,
      });
    }

    if (answer.kind === "error") {
      // The API did not commit: the previous key is still the device's key.
      await undoKey(plan);
      if (answer.code === "device_account_mismatch") {
        // Until a sign-in succeeds, each attempt asks for the account.
        afterAccountMismatch = true;
      }
      if (answer.code === "device_revoked") {
        try {
          await deps.keyStore.delete();
          await deps.deviceRecords.delete();
        } catch {
          report("The revoked device's key or record could not be deleted.");
        }
      }
      return Object.freeze(
        answer.code === "device_account_mismatch" && plan.record !== null
          ? {
              kind: "refused",
              code: answer.code,
              deviceLogin: plan.record.login,
            }
          : { kind: "refused", code: answer.code },
      );
    }

    const account = answer.body;
    if (plan.kind === "existing" && account.deviceId !== plan.record.deviceId) {
      report("The sign-in answer named another device.");
      return failed("unexpected_response");
    }
    if (plan.kind === "new" && account.deviceId === plan.record?.deviceId) {
      // The new key never belongs to the device whose key was lost, which
      // the API revokes; nothing is written with that device ID.
      report("The sign-in answer named the replaced device.");
      return failed("unexpected_response");
    }
    afterAccountMismatch = false;
    const record: DeviceRecord = {
      deviceId: account.deviceId,
      userId: account.userId,
      login: account.login,
      displayName: account.displayName,
      signInExpiresAt: account.signInExpiresAt,
      publicKey: device.publicKey,
    };
    // The API registered the key under this ID; without the record the
    // installation cannot use it, so a failed write is tried once more. The
    // record is written before the replacement is confirmed, so a confirmed
    // key never sits next to a record that names the previous key.
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
      try {
        await deps.deviceRecords.write(record);
        saved = true;
      } catch {
        report("The device record could not be written.");
      }
    }
    if (!saved) {
      // An existing device keeps the replacement pending: the record on
      // disk still names the previous key, which stays next to the new one.
      // A new device keeps its registration marker, so that after a restart
      // the next attempt sends the key again and gets this device (#153).
      unsavedRecord = record;
      return failed("record_not_saved");
    }
    if (plan.kind === "new") {
      // The record names the key now.
      await dropRegistrationMarker();
    }
    if (plan.kind === "existing") {
      try {
        // The answer proves that the API holds the new key, and the record
        // now names it.
        await deps.keyStore.confirmReplacement();
      } catch {
        // The next start confirms it: the record names the new key.
        report("The previous device key could not be deleted.");
      }
    }
    return Object.freeze({
      kind: "signed_in",
      account,
      newDevice: plan.kind === "new",
      login: account.login,
    });
  }

  function reset(): boolean {
    if (running) {
      return false;
    }
    unsavedRecord = null;
    afterAccountMismatch = false;
    return true;
  }

  return Object.freeze({ start, reset });
}
