// The sign-in flow of the main process (ADR 0014, "Sign-in", steps 1, 6,
// and 7). It joins the device key store, the device record, the attempt,
// and the loopback listener, opens the system browser, and posts the code
// with the device registration to `POST /auth/sign-in`.
//
// It decides between a new device (no record, or no key) and an existing
// device (a record and a loaded key). It never logs or returns the code, the
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
import type {
  DeviceKeyStore,
  NewDeviceKeyProtection,
  ReplaceDeviceKeyOptions,
} from "../device-key/store.ts";
import type { DeviceRecord, DeviceRecordStore } from "../device-record.ts";
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

/**
 * Shown with the authorize URL when the browser could not be opened (#149):
 * the URL holds the attempt's state, and whoever has it while the attempt is
 * open could sign this device in to another account.
 */
export const SIGN_IN_URL_WARNING =
  "Open this address in your own browser. Do not share it with anyone: while this sign-in is open, someone who has it could sign this device in to their account.";

/** How long the answer of `POST /auth/sign-in` may take before the flow stops waiting. */
export const SIGN_IN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long opening the system browser may take. After that the attempt
 * continues as if the browser did not open: the URL is shown for copying.
 */
export const OPEN_EXTERNAL_TIMEOUT_MS = 10_000;

/** An answer body larger than this many bytes is not read as an answer of the API. */
export const MAX_ANSWER_BYTES = 64 * 1024;

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
 * - `record_unreadable`: the record file cannot be read, or it is corrupt
 *   (for example another version, after a downgrade) while a key file
 *   exists. The key may still be the key of a device that the API knows, so
 *   it is kept; an explicit reset is a later option.
 * - `listener_unavailable`: the loopback listener could not start.
 * - `no_answer`: no answer arrived (a network error, or the request timed
 *   out); a key replacement stays pending.
 * - `server_error`: a `5xx` answer. The API may have committed before it
 *   failed, so it is handled like `no_answer`.
 * - `unexpected_response`: an answer that is not one of the API's; handled
 *   like `no_answer`.
 * - `record_not_saved`: the API registered the device, but the record could
 *   not be written, also when tried a second time.
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
  "record_unreadable",
  "listener_unavailable",
  "no_answer",
  "server_error",
  "unexpected_response",
  "record_not_saved",
] as const);
export type SignInFailureReason = (typeof SIGN_IN_FAILURE_REASONS)[number];

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
 * The result of `start`. When the browser could not be opened, the URL is
 * shown for copying together with `SIGN_IN_URL_WARNING`.
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
}

/** The part of the device key store that the flow uses. */
export type SignInKeyStore = Pick<
  DeviceKeyStore,
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
  /** Opens the URL in the system browser; resolves false when it could not. */
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly fetch: SignInFetch;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** The clock of the listener's 10 minutes and of the request; defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** Passed to the listener; tests pass a shorter one. */
  readonly listenerConnectionTimeoutMs?: number;
  /** Receives a fixed message for an error that the flow handled. */
  readonly onError?: (message: string) => void;
}

export interface SignInFlow {
  /**
   * Starts a sign-in after the person's action: creates the attempt, starts
   * the listener, and opens the browser. Never rejects.
   */
  readonly start: (options?: SignInStartOptions) => Promise<SignInStart>;
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
 * signs in as its account.
 */
type DevicePlan =
  | { readonly kind: "new"; readonly record: DeviceRecord | null }
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
  // Only a 4xx with the API's error body means that nothing was committed.
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

  /** Decides between a new and an existing device, and removes a leftover key. */
  async function planDevice(): Promise<DevicePlan | SignInFailureReason> {
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
    if (read.kind === "record") {
      if (!hasKey) {
        // The key was lost: a new device that names the previous one.
        return { kind: "new", record: read.record };
      }
      const keys = deps.keyStore.keys();
      if (keys === null) {
        return "key_not_loaded";
      }
      if (keys.previous !== null) {
        return "replacement_pending";
      }
      if (keys.current.publicKey !== read.record.publicKey) {
        // Not the key of the record's device: the key of a new device whose
        // registration got no clear answer after that device's key was lost.
        // The API offers no way to learn the new device's ID, so a new device
        // names the record's device again, with a new key.
        try {
          await deps.keyStore.delete();
        } catch {
          return "key_store_failed";
        }
        return { kind: "new", record: read.record };
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
      return { kind: "new", record: null };
    }
    // The key is deleted only when no record exists at all.
    if (hasKey) {
      // A key without a record belongs to no device that this installation
      // knows; a new device needs a new key.
      try {
        await deps.keyStore.delete();
      } catch {
        return "key_store_failed";
      }
    }
    return { kind: "new", record: null };
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
        opened = await new Promise<boolean>((resolve, reject) => {
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
        });
      } catch {
        opened = false;
      }
      if (!opened) {
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
      return failed("key_store_failed");
    }
  }

  /**
   * Undoes the key change of a request that the API refused with a `4xx`
   * error body, so it committed nothing.
   *
   * When whether the API committed is unknown (no answer, a `5xx`, or an
   * answer that is not the API's), nothing is undone:
   * an existing device keeps the replacement pending, and part 3 tries the
   * new key first. A new device keeps its new key and the record of a lost
   * key stays as it was. The next attempt finds a key without a record, or
   * a key that is not the record's device's key, and registers a new device
   * (naming the record's device) with a new key. If the uncertain request
   * did commit, the device it registered has no usable key and expires
   * after 30 days, because the API offers no way to learn its ID.
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
  }

  async function register(input: FinishInput): Promise<SignInOutcome> {
    const { plan, listener, apiOrigin, attempt, abort } = input;
    const result = await listener.wait();
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
        const key = await deps.keyStore.create(
          input.options.newKeyProtection ?? { kind: "system" },
        );
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
      await undoKey(plan);
      return Object.freeze({ kind: "cancelled" });
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
    if (plan.kind === "existing") {
      if (account.deviceId !== plan.record.deviceId) {
        report("The sign-in answer named another device.");
        return failed("unexpected_response");
      }
      try {
        // The answer proves that the API holds the new key.
        await deps.keyStore.confirmReplacement();
      } catch {
        report("The previous device key could not be deleted.");
      }
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
    // installation cannot use it, so a failed write is tried once more.
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
      return failed("record_not_saved");
    }
    return Object.freeze({
      kind: "signed_in",
      account,
      newDevice: plan.kind === "new",
      login: account.login,
    });
  }

  return Object.freeze({ start });
}
