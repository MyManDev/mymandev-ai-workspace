// The typed IPC contract between the renderer and the main process: a zod
// schema for the arguments and the result of every invoke channel, and for
// the payload of every event channel. The main process validates the
// arguments of every call and parses every value it sends, so unknown keys
// never reach the renderer (ADR 0003, ADR 0014). The preload script and the
// renderer import the types only, so zod is bundled into the main process
// alone and the renderer needs no `jitless` setting.
import * as z from "zod";
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type InvokeChannel,
} from "./ipc-channels.ts";

/** The states of the local runtime. */
export const RUNTIME_STATES = Object.freeze([
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
] as const);

export const RuntimeStateSchema = z.enum(RUNTIME_STATES);
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const RuntimeStatusSchema = z.object({
  state: RuntimeStateSchema,
  /**
   * Starts at 0 and grows by one with every change of the state. A receiver
   * keeps the status with the highest revision, because the answer to a call
   * and a later event can arrive in either order.
   */
  revision: z.int().nonnegative(),
});
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

/** The arguments of a channel that takes none. Extra arguments are refused. */
const NoArgumentsSchema = z.tuple([]);

/**
 * Limits of the repository messages: the number of mounted repositories and
 * of remotes per repository, and the length of strings in UTF-16 code units.
 * The main process refuses a folder whose path is longer than `path` and
 * shortens longer names, branches, and URLs before it sends them.
 */
export const REPOSITORY_LIMITS = Object.freeze({
  mounted: 16,
  remotes: 32,
  path: 4096,
  name: 255,
  ref: 1024,
  remoteName: 255,
  url: 2048,
});

/**
 * The handle of a mounted repository on this device. The main process
 * creates it when the repository is mounted; it is not stored, never leaves
 * the device, and is not a protocol `RepositoryId`.
 */
export const MountIdSchema = z.uuid();
export type MountId = z.infer<typeof MountIdSchema>;

/** A remote of a repository. Credentials in a URL are removed before it is sent. */
export const GitRemoteSchema = z.object({
  name: z.string().min(1).max(REPOSITORY_LIMITS.remoteName),
  fetchUrl: z.string().min(1).max(REPOSITORY_LIMITS.url).nullable(),
  pushUrl: z.string().min(1).max(REPOSITORY_LIMITS.url).nullable(),
});
export type GitRemote = z.infer<typeof GitRemoteSchema>;

const CommitIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "Expected a commit ID");
const CountSchema = z.int().nonnegative();

/** HEAD of a repository and its upstream. */
export const GitBranchSchema = z.object({
  /** The checked-out branch, or null when HEAD is detached. */
  name: z.string().min(1).max(REPOSITORY_LIMITS.ref).nullable(),
  /** The commit of HEAD, or null before the first commit. */
  commit: CommitIdSchema.nullable(),
  /** The upstream branch, for example "origin/main", or null without one. */
  upstream: z.string().min(1).max(REPOSITORY_LIMITS.ref).nullable(),
  /** Commits ahead of the upstream; null when Git did not count them. */
  ahead: CountSchema.nullable(),
  /** Commits behind the upstream; null when Git did not count them. */
  behind: CountSchema.nullable(),
});
export type GitBranch = z.infer<typeof GitBranchSchema>;

/**
 * The number of changed paths. A path can be staged and not staged at once.
 * An untracked folder counts once.
 */
export const GitChangeSummarySchema = z.object({
  staged: CountSchema,
  unstaged: CountSchema,
  untracked: CountSchema,
  conflicted: CountSchema,
});
export type GitChangeSummary = z.infer<typeof GitChangeSummarySchema>;

/** Why the state of a mounted repository cannot be shown. */
export const REPOSITORY_PROBLEMS = Object.freeze([
  "missing",
  "untrusted",
  "git-missing",
  "git-unsupported",
  "timeout",
  "too-large",
  "unsupported-config",
  "failed",
] as const);
export type RepositoryProblem = (typeof REPOSITORY_PROBLEMS)[number];

export const RepositoryStateSchema = z.discriminatedUnion("kind", [
  /** Read for the first time. */
  z.object({ kind: z.literal("loading") }),
  z.object({
    kind: z.literal("ready"),
    branch: GitBranchSchema,
    changes: GitChangeSummarySchema,
    remotes: z.array(GitRemoteSchema).max(REPOSITORY_LIMITS.remotes),
  }),
  z.object({
    kind: z.literal("unavailable"),
    problem: z.enum(REPOSITORY_PROBLEMS),
  }),
]);
export type RepositoryState = z.infer<typeof RepositoryStateSchema>;

/**
 * A repository mounted on this device. Its path stays on the device: the
 * renderer shows it, and nothing sends it to the cloud (ADR 0013).
 */
export const MountedRepositorySchema = z.object({
  mountId: MountIdSchema,
  /** The name of the repository's top-level folder. */
  name: z.string().min(1).max(REPOSITORY_LIMITS.name),
  /** The absolute path of the repository's top-level folder. */
  path: z.string().min(1).max(REPOSITORY_LIMITS.path),
  /** True while file changes refresh the state. */
  watching: z.boolean(),
  state: RepositoryStateSchema,
});
export type MountedRepository = z.infer<typeof MountedRepositorySchema>;

export const RepositoryListSchema = z.object({
  /**
   * Grows by one with every change. A receiver keeps the list with the
   * highest revision, like the runtime status.
   */
  revision: z.int().nonnegative(),
  /** In the order they were mounted. */
  repositories: z.array(MountedRepositorySchema).max(REPOSITORY_LIMITS.mounted),
});
export type RepositoryList = z.infer<typeof RepositoryListSchema>;

/** Why a selected folder was not mounted. */
export const MOUNT_REFUSALS = Object.freeze([
  "busy",
  "not-a-repository",
  "not-top-level",
  "no-work-tree",
  "untrusted",
  "already-mounted",
  "limit",
  "git-missing",
  "git-unsupported",
  "unsupported-path",
  "failed",
] as const);
export type MountRefusal = (typeof MOUNT_REFUSALS)[number];

export const MountResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("mounted"), mountId: MountIdSchema }),
  /** The dialog was closed without a folder. */
  z.object({ outcome: z.literal("cancelled") }),
  z.object({ outcome: z.literal("refused"), reason: z.enum(MOUNT_REFUSALS) }),
]);
export type MountResult = z.infer<typeof MountResultSchema>;

/**
 * Limits of the account messages: a display name as the protocol limits it
 * (in characters, which zod counts as code points), and the authorize URL,
 * the warning shown with it, and the passphrase. The device key store counts
 * at most 1,024 characters of a passphrase after NFC normalization and
 * refuses a longer one itself; this limit only bounds the message. The
 * device list has its own limits (`DEVICE_LIST_LIMITS`).
 */
export const ACCOUNT_LIMITS = Object.freeze({
  displayName: 64,
  authorizeUrl: 4096,
  warning: 512,
  passphrase: 4096,
});

/**
 * A GitHub login, by the protocol's login rule (at most 39 characters).
 * Display data only.
 */
const LoginSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,39}$/, "Expected a GitHub login");

/**
 * The end of the device's sign-in (ADR 0014, "Lifetimes": 30 days after the
 * last GitHub sign-in), in UTC with milliseconds, as the protocol writes it
 * and the device record keeps it (D4 on #95). The fixed form bounds its
 * length.
 */
const SignInExpirySchema = z.iso.datetime({ precision: 3 });

/**
 * The account that this installation holds, from its device record:
 * `signed_out` without one, and `hidden` while the person is signed out on
 * this device (P-65, #195), also when the device state names something else
 * first, and while that is not known yet. The record is then kept, but the
 * status names no login, display name, device ID, or sign-in expiry; after
 * a refused sign-in with another account, `lastOutcome.deviceLogin` names
 * the login.
 */
export const AccountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("signed_out") }),
  z.object({
    kind: z.literal("signed_in"),
    login: LoginSchema,
    displayName: z.string().min(1).max(ACCOUNT_LIMITS.displayName),
    deviceId: z.uuid(),
    /**
     * The end of the device's sign-in, as the last GitHub sign-in that this
     * installation saw answered it (D4 on #95). The Account screen asks the
     * person to renew it from day 25 of the 30 days, 6 days before.
     */
    signInExpiresAt: SignInExpirySchema,
  }),
  z.object({ kind: z.literal("hidden") }),
]);
export type Account = z.infer<typeof AccountSchema>;

const PairingCodeSchema = z.string().regex(/^[0-9]{6}$/, "Expected six digits");

/**
 * Where the person completes a sign-in (#175): `default` opens the system's
 * default browser, and `other` opens none and offers the start address for
 * copying into a browser of the person's choice, with the same warning as
 * when the browser does not open. The main process decides what it opens.
 */
export const SIGN_IN_BROWSERS = Object.freeze(["default", "other"] as const);
export type SignInBrowser = (typeof SIGN_IN_BROWSERS)[number];

/**
 * The sign-in of this installation: none (`idle`), one that is starting the
 * listener and the browser (`starting`), one that waits for the browser
 * (`waiting`) with the pairing code that the API's confirmation page shows
 * too, or one whose browser part ended and that now registers the device
 * (`completing`). When the browser did not open, `waiting` also holds the
 * authorize URL to copy and the warning to show with it: the URL must not
 * be shared (#149). Its `browser` says why: `default` when the default
 * browser could not be opened, `other` when the person asked for the
 * address (#175). No sign-in code, verifier, signature, key, or token is
 * ever part of it.
 */
export const SignInStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("starting") }),
  z.object({ kind: z.literal("completing") }),
  z.discriminatedUnion("opened", [
    z.object({
      kind: z.literal("waiting"),
      pairingCode: PairingCodeSchema,
      opened: z.literal(true),
    }),
    z.object({
      kind: z.literal("waiting"),
      pairingCode: PairingCodeSchema,
      opened: z.literal(false),
      authorizeUrl: z
        .url({ protocol: /^https?$/ })
        .max(ACCOUNT_LIMITS.authorizeUrl),
      warning: z.string().min(1).max(ACCOUNT_LIMITS.warning),
      browser: z.enum(SIGN_IN_BROWSERS),
    }),
  ]),
]);
export type SignInState = z.infer<typeof SignInStateSchema>;

/**
 * How the last sign-in ended, as a fixed code. The main process maps the
 * outcomes of the sign-in flow to these codes (account.ts); a reason that it
 * does not know maps to `failed`, and an API error code without its own
 * entry to `refused`.
 */
export const SIGN_IN_OUTCOME_CODES = Object.freeze([
  "signed_in",
  "cancelled",
  "timed_out",
  "access_denied",
  "sign_in_failed",
  "unsupported_account",
  "sign_in_unavailable",
  "sign_in_required",
  "device_account_mismatch",
  "device_revoked",
  "device_registration_locked",
  "device_limit",
  "device_daily_limit",
  "refused",
  "api_origin_unset",
  "api_origin_invalid",
  "unsupported_platform",
  "key_not_loaded",
  "replacement_pending",
  "system_protection_unavailable",
  "key_store_failed",
  "record_unreadable",
  "listener_unavailable",
  "no_answer",
  "server_error",
  "unexpected_response",
  "uncertain_refusal",
  "key_changed",
  "record_not_saved",
  "failed",
] as const);
export type SignInOutcomeCode = (typeof SIGN_IN_OUTCOME_CODES)[number];

/** A time in UTC, as `Date.prototype.toISOString` writes it. */
const TimestampSchema = z.iso.datetime();

/** The outcome codes that can carry `retryAfter`; every other code cannot. */
export const SIGN_IN_RETRY_CODES = Object.freeze([
  "replacement_pending",
  "device_daily_limit",
  "uncertain_refusal",
] as const satisfies readonly SignInOutcomeCode[]);

export const SignInOutcomeSchema = z
  .object({
    code: z.enum(SIGN_IN_OUTCOME_CODES),
    /**
     * With `device_account_mismatch`: the login of the account that this
     * installation holds, which the API's answer does not carry.
     */
    deviceLogin: LoginSchema.optional(),
    /**
     * A time in UTC after which the sign-in can be tried again, with the
     * codes of `SIGN_IN_RETRY_CODES` only. It is a time, not a duration, so
     * the renderer computes what is left of the wait from its own clock
     * while the outcome stays on screen. It names no key and no ID.
     *
     * - `replacement_pending`, while the grace period of an uncertain
     *   sign-in runs (#199): when it ends. A new sign-in is not refused for
     *   it after this time. While the server refused both keys of the
     *   pending replacement once (#303): when the wait before they may be
     *   treated as lost ends, as `lostKeyWaitEnd` in the status.
     * - `device_daily_limit` (#269): when the wait of the account's daily
     *   limit of new devices ends, from the API's `Retry-After`. The
     *   refusal is certain: nothing was registered.
     * - `uncertain_refusal`, when the API answered `rate_limited` with a
     *   usable `Retry-After` (#269): when the wait of its limit of requests
     *   ends. Whether the sign-in was completed stays unknown.
     */
    retryAfter: TimestampSchema.optional(),
  })
  .refine(
    (outcome) =>
      outcome.retryAfter === undefined ||
      (SIGN_IN_RETRY_CODES as readonly string[]).includes(outcome.code),
    { message: "retryAfter belongs to the codes of SIGN_IN_RETRY_CODES only" },
  );
export type SignInOutcomeView = z.infer<typeof SignInOutcomeSchema>;

/**
 * The state of the device key in the main process: `loading` until the
 * startup load has settled, `ready` when the key is loaded or none is
 * stored, `passphrase_required` while a key that a passphrase protects waits
 * for it (Linux), or why the key cannot be used: the system could not
 * decrypt it (`unreadable`), its file is damaged (`corrupt`) or from a newer
 * version (`newer_format`), Windows has no local data folder
 * (`local_data_folder_missing`), or another error (`failed`).
 */
export const DEVICE_KEY_STATES = Object.freeze([
  "loading",
  "ready",
  "passphrase_required",
  "unreadable",
  "corrupt",
  "newer_format",
  "local_data_folder_missing",
  "failed",
] as const);
export type DeviceKeyState = (typeof DEVICE_KEY_STATES)[number];

/** Whether this build has an API origin to sign in with (api-origin.ts). */
export const API_ORIGIN_STATES = Object.freeze([
  "set",
  "unset",
  "invalid",
] as const);
export type ApiOriginState = (typeof API_ORIGIN_STATES)[number];

/**
 * The state of this installation's device in the device session (ADR 0014,
 * "Revocation, sign-out, and recovery"), as a fixed code:
 *
 * - `starting`: the device session has not read the device yet.
 * - `no_device`: no device that this installation can use; a GitHub sign-in
 *   registers one.
 * - `signed_in`: a device and a loaded key that the API is asked with.
 * - `signed_out`: the person signed out (P-65); the key stays, and the next
 *   GitHub sign-in is needed. `sign_out_report_pending` while the API has
 *   not learned it yet.
 * - `sign_in_required`: the API asks for a GitHub sign-in.
 * - `auth_failed`: the API refused the device key.
 * - `account_mismatch`: a sign-in with another GitHub account was refused.
 * - `key_lost`: the device has no usable key on this installation; the next
 *   sign-in registers a new device that replaces it.
 * - `key_not_loaded`: the key waits for its passphrase.
 * - `unavailable`: the device record or the key store cannot be read.
 * - `removal_pending`: the person removed this device, and the API has not
 *   confirmed it yet.
 * - `removed`: the API confirmed the removal; the key is deleted.
 * - `revoked`: the API revoked the device; the key is deleted.
 */
export const DEVICE_STATES = Object.freeze([
  "starting",
  "no_device",
  "signed_in",
  "signed_out",
  "sign_out_report_pending",
  "sign_in_required",
  "auth_failed",
  "account_mismatch",
  "key_lost",
  "key_not_loaded",
  "unavailable",
  "removal_pending",
  "removed",
  "revoked",
] as const);
export type DeviceState = (typeof DEVICE_STATES)[number];

/** What the renderer may know about the sign-in of this installation. */
export const AccountStatusSchema = z.object({
  /**
   * Grows by one with every change. A receiver keeps the status with the
   * highest revision, like the runtime status.
   */
  revision: z.int().nonnegative(),
  account: AccountSchema,
  signIn: SignInStateSchema,
  /**
   * How the last sign-in ended; null before the first one, after "This is
   * not me", and once the device signs out (#195).
   */
  lastOutcome: SignInOutcomeSchema.nullable(),
  deviceKey: z.enum(DEVICE_KEY_STATES),
  /**
   * Whether the key of the last sign-in is not confirmed yet: the previous
   * key is kept until the new one authenticates once.
   */
  replacementPending: z.boolean(),
  /**
   * While the server refused both keys of the pending replacement once and
   * the main process waits before it may treat them as lost (#303): a time
   * in UTC, by this device's clock, after which a new sign-in can start.
   * Before it, the replacement stays pending and a start is refused as
   * `replacement_pending`. Absent otherwise. It is the time of the last read
   * of the device session, so it can lie in the past; the renderer compares
   * it with its own clock. It names no key and no ID.
   */
  lostKeyWaitEnd: TimestampSchema.optional(),
  apiOrigin: z.enum(API_ORIGIN_STATES),
  /** The state of the device in the device session. */
  device: z.enum(DEVICE_STATES),
});
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

/**
 * Why a sign-in was not started: `busy` while a sign-in is open or the
 * account is being changed, `key_not_ready` while the device key is
 * loading, waits for its passphrase, or cannot be used, and `too_soon`
 * within a few seconds of the last start that opened the browser or offered
 * its address.
 */
export const START_SIGN_IN_REFUSALS = Object.freeze([
  "busy",
  "key_not_ready",
  "too_soon",
] as const);

export const StartSignInResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("started") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(START_SIGN_IN_REFUSALS),
  }),
  /** The sign-in flow did not start; the status's `lastOutcome` holds the code too. */
  z.object({
    outcome: z.literal("failed"),
    code: z.enum(SIGN_IN_OUTCOME_CODES),
  }),
]);
export type StartSignInResult = z.infer<typeof StartSignInResultSchema>;

/**
 * The option of a sign-in start. It comes from the renderer, so an unknown
 * key is refused rather than stripped.
 */
export const StartSignInOptionsSchema = z.strictObject({
  browser: z.enum(SIGN_IN_BROWSERS),
});
export type StartSignInOptions = z.infer<typeof StartSignInOptionsSchema>;

/** A passphrase for the device key. Only the renderer sends one. */
export const PassphraseSchema = z
  .string()
  .min(1)
  .max(ACCOUNT_LIMITS.passphrase);

/**
 * Why a passphrase did not unlock the device key: `not_required` when no
 * key waits for one, `busy` while another unlock or a change of the account
 * runs, `wrong_passphrase`, `passphrase_invalid` for text that is not
 * well-formed or longer than 1,024 characters, or `too_soon` while the delay
 * after a wrong passphrase runs.
 */
export const UNLOCK_REFUSALS = Object.freeze([
  "not_required",
  "busy",
  "wrong_passphrase",
  "passphrase_invalid",
  "too_soon",
] as const);

export const UnlockResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("unlocked") }),
  z.object({ outcome: z.literal("refused"), reason: z.enum(UNLOCK_REFUSALS) }),
  /** The key cannot be used; the status's `deviceKey` says why. */
  z.object({ outcome: z.literal("failed") }),
]);
export type UnlockResult = z.infer<typeof UnlockResultSchema>;

/**
 * Why "This is not me" deleted nothing: `busy` while a sign-in is open, the
 * key is loading or being unlocked, or the confirmation is open,
 * `not_signed_in` when this installation holds no account.
 */
export const FORGET_REFUSALS = Object.freeze([
  "busy",
  "not_signed_in",
] as const);

export const ForgetResultSchema = z.discriminatedUnion("outcome", [
  /**
   * The record and the key are deleted on this installation.
   * `removedAtServer` is true when the API confirmed the removal of the
   * device first; otherwise the device stays registered to that account at
   * the API, without a usable key, and nothing removes it on its own (#198).
   */
  z.object({ outcome: z.literal("forgotten"), removedAtServer: z.boolean() }),
  /** The person kept the account in the confirmation of the main process. */
  z.object({ outcome: z.literal("cancelled") }),
  z.object({ outcome: z.literal("refused"), reason: z.enum(FORGET_REFUSALS) }),
  /** The record or the key could not be deleted. */
  z.object({ outcome: z.literal("failed") }),
]);
export type ForgetResult = z.infer<typeof ForgetResultSchema>;

/**
 * Why an action of the device session (sign-out, removing this device) was
 * not taken: `busy` while a sign-in is open, the key is loading or being
 * unlocked, or another change of the account runs, and `not_signed_in` when
 * this installation holds no account.
 */
export const DEVICE_ACTION_REFUSALS = Object.freeze([
  "busy",
  "not_signed_in",
] as const);

/**
 * Why an action of the device session failed, as a fixed code. The main
 * process maps the session's failures to these codes (account-session.ts):
 * the reasons of the session one to one, the API's codes that the screens
 * explain on their own, `refused` for another API code, and `failed` for
 * anything else.
 */
export const DEVICE_ACTION_FAILURES = Object.freeze([
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
  "record_not_saved",
  "no_answer",
  "server_error",
  "unexpected_response",
  "sign_in_required",
  "auth_failed",
  "device_revoked",
  "device_account_mismatch",
  "rate_limited",
  "refused",
  "failed",
] as const);
export type DeviceActionFailure = (typeof DEVICE_ACTION_FAILURES)[number];

const DeviceActionRefusedSchema = z.object({
  outcome: z.literal("refused"),
  reason: z.enum(DEVICE_ACTION_REFUSALS),
});

const DeviceActionFailedSchema = z.object({
  outcome: z.literal("failed"),
  reason: z.enum(DEVICE_ACTION_FAILURES),
});

/**
 * The result of a sign-out: `signed_out` when the API confirmed it,
 * `pending` when the device is signed out and the API learns it later.
 */
export const SignOutResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("signed_out") }),
  z.object({ outcome: z.literal("pending") }),
  DeviceActionRefusedSchema,
  DeviceActionFailedSchema,
]);
export type SignOutResult = z.infer<typeof SignOutResultSchema>;

/**
 * The result of removing this device: `removed` when the API confirmed it
 * and the key is deleted, `pending` while the API has not answered clearly
 * (the key stays, and the removal is retried), or `cancelled` when the
 * person kept the device in the native confirmation.
 */
export const RemoveDeviceResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("removed") }),
  z.object({ outcome: z.literal("pending") }),
  z.object({ outcome: z.literal("cancelled") }),
  DeviceActionRefusedSchema,
  DeviceActionFailedSchema,
]);
export type RemoveDeviceResult = z.infer<typeof RemoveDeviceResultSchema>;

/**
 * The states of the connection to the cloud API (#26):
 *
 * - `offline`: no connection is wanted, because no device is signed in with
 *   a loaded key, the API origin is not set, or the application quits.
 * - `connecting`: the opening handshake runs.
 * - `authenticating`: the socket is open, and the device answers the
 *   server's challenge.
 * - `connected`: the server confirmed the device (`auth.ok`).
 * - `waiting`: the connection ended, and the next attempt starts at
 *   `retryAt`.
 * - `stopped`: the connection ended for a reason that needs the person, and
 *   it does not reconnect on its own.
 */
export const CONNECTION_STATES = Object.freeze([
  "offline",
  "connecting",
  "authenticating",
  "connected",
  "waiting",
  "stopped",
] as const);
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** Why the connection is `offline`. */
export const CONNECTION_OFFLINE_REASONS = Object.freeze([
  "not_signed_in",
  "no_api_origin",
] as const);

/**
 * Why the connection is `waiting`: the handshake failed
 * (`connection_failed`) or an open connection dropped (`connection_lost`);
 * a timer of the client or the server ended (`timeout`); the server failed
 * (`server_error`) or was busy (`server_busy`); the server refused a message
 * after authentication (`message_refused`); the client refused a message of
 * the server (`invalid_message`); the challenge could not be signed
 * (`signature_failed`); or the server replaced the key again soon after the
 * reconnect that the last replacement caused (`key_replaced`).
 */
export const CONNECTION_WAITING_REASONS = Object.freeze([
  "connection_failed",
  "connection_lost",
  "timeout",
  "server_error",
  "server_busy",
  "message_refused",
  "invalid_message",
  "signature_failed",
  "key_replaced",
] as const);

/**
 * Why the connection is `stopped`: the close reasons of the server after
 * which the client does not reconnect on its own (ADR 0014, "Device key and
 * authentication"), and `update_required` when the server speaks another
 * protocol version.
 */
export const CONNECTION_STOP_REASONS = Object.freeze([
  "auth_failed",
  "device_revoked",
  "sign_in_required",
  "connection_replaced",
  "protocol_violation",
  "update_required",
] as const);
export type ConnectionOfflineReason =
  (typeof CONNECTION_OFFLINE_REASONS)[number];
export type ConnectionWaitingReason =
  (typeof CONNECTION_WAITING_REASONS)[number];
export type ConnectionStopReason = (typeof CONNECTION_STOP_REASONS)[number];

/**
 * The status of the connection to the cloud API: `{ state, reason?,
 * retryAt?, revision }`, with a reason only where the state has one. It
 * holds fixed codes and a time only, never a frame, a nonce, a signature, or
 * a key.
 */
export const ConnectionStatusSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("offline"),
    reason: z.enum(CONNECTION_OFFLINE_REASONS).optional(),
    revision: z.int().nonnegative(),
  }),
  z.object({
    state: z.enum(["connecting", "authenticating", "connected"]),
    revision: z.int().nonnegative(),
  }),
  z.object({
    state: z.literal("waiting"),
    reason: z.enum(CONNECTION_WAITING_REASONS),
    /** When the next attempt starts, in UTC. */
    retryAt: TimestampSchema,
    revision: z.int().nonnegative(),
  }),
  z.object({
    state: z.literal("stopped"),
    reason: z.enum(CONNECTION_STOP_REASONS),
    revision: z.int().nonnegative(),
  }),
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

/**
 * Why a reconnect was refused: `not_signed_in` without a signed-in device
 * with a loaded key, and after the server refused the device (`auth_failed`,
 * `device_revoked`, `sign_in_required`), which only a GitHub sign-in ends;
 * `update_required` while the server speaks another protocol version;
 * `already_open` while a connection is open or opening; and `too_soon`
 * within a few seconds of the last reconnect, or after too many reconnects
 * in 10 minutes.
 */
export const RECONNECT_REFUSALS = Object.freeze([
  "not_signed_in",
  "update_required",
  "already_open",
  "too_soon",
] as const);

export const ReconnectResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("reconnecting") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(RECONNECT_REFUSALS),
  }),
]);
export type ReconnectResult = z.infer<typeof ReconnectResultSchema>;

/**
 * Limits of the workspace messages: the number of workspaces and of
 * projects, the most that one answer of the API holds (the protocol's
 * `MAX_ANSWER_LIST_ITEMS`), and the length of a name in characters (the
 * protocol's `LIMITS.name`; zod counts code points, like the protocol). The
 * main process sends at most this many workspaces and projects and shortens
 * a longer name. The shared contract does not import the protocol package,
 * so the main process's tests check that the values match.
 */
export const WORKSPACE_LIMITS = Object.freeze({
  workspaces: 1_000,
  projects: 1_000,
  name: 100,
});

/** A UUIDv7 in canonical lowercase form, like the protocol's `UUIDV7_PATTERN`. */
const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A protocol ID, such as a workspace or a project ID, that crosses IPC
 * (Project Manager decision of 2026-11-05): a lowercase UUIDv7. A longer
 * string is refused before the pattern runs. The main process checks every
 * ID from the renderer with the protocol's own ID schema as well.
 */
export const ProtocolIdSchema = z
  .string()
  .max(36, { abort: true })
  .regex(UUIDV7_PATTERN, "Expected a lowercase UUIDv7");

const WorkspaceNameSchema = z.string().min(1).max(WORKSPACE_LIMITS.name);

/** A workspace of the account. */
export const WorkspaceSummarySchema = z.object({
  id: ProtocolIdSchema,
  name: WorkspaceNameSchema,
});
export type WorkspaceSummaryView = z.infer<typeof WorkspaceSummarySchema>;

/** A project of the selected workspace. Its creator does not cross IPC. */
export const ProjectSummarySchema = z.object({
  id: ProtocolIdSchema,
  name: WorkspaceNameSchema,
});
export type ProjectSummaryView = z.infer<typeof ProjectSummarySchema>;

/**
 * The states of the workspace service: `signed_out` without a signed-in
 * device with a ready key, `loading` until the list and the selected
 * workspace loaded once, `ready`, and `unavailable` while a retry of a
 * failed load waits.
 */
export const WORKSPACE_STATUSES = Object.freeze([
  "signed_out",
  "loading",
  "ready",
  "unavailable",
] as const);

/** Why the workspaces are `unavailable`: the failure of the last read. */
export const WORKSPACE_PROBLEMS = Object.freeze([
  "not_signed_in",
  "not_found",
  "rate_limited",
  "unavailable",
  "failed",
] as const);
export type WorkspaceProblem = (typeof WORKSPACE_PROBLEMS)[number];

const WorkspaceViewFields = {
  /**
   * Grows by one with every change. A receiver keeps the state with the
   * highest revision, like the runtime status.
   */
  revision: z.int().nonnegative(),
  /** In the server's order, the most recently claimed first. */
  workspaces: z
    .array(WorkspaceSummarySchema)
    .max(WORKSPACE_LIMITS.workspaces)
    .readonly(),
  selectedWorkspaceId: ProtocolIdSchema.nullable(),
  /** The selected workspace's projects, the oldest first. */
  projects: z
    .array(ProjectSummarySchema)
    .max(WORKSPACE_LIMITS.projects)
    .readonly(),
  openProjectId: ProtocolIdSchema.nullable(),
};

/**
 * What the renderer may know of the workspace service's state: `{ revision,
 * status, problem?, workspaces, selectedWorkspaceId, projects,
 * openProjectId }`, with a problem only while `unavailable`. It holds IDs
 * and names only, no member ID, user ID, or anything secret.
 */
export const WorkspaceViewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["signed_out", "loading", "ready"]),
    ...WorkspaceViewFields,
  }),
  z.object({
    status: z.literal("unavailable"),
    problem: z.enum(WORKSPACE_PROBLEMS),
    ...WorkspaceViewFields,
  }),
]);
export type WorkspaceView = z.infer<typeof WorkspaceViewSchema>;

/**
 * Why a workspace action was refused: `not_found` for a workspace that the
 * list does not hold, a project that the selected workspace does not hold,
 * or no signed-in device, and `too_soon` for a switch to another workspace
 * beyond the budget of switches in the main process.
 */
export const WORKSPACE_ACTION_REFUSALS = Object.freeze([
  "not_found",
  "too_soon",
] as const);
export type WorkspaceActionRefusal = (typeof WORKSPACE_ACTION_REFUSALS)[number];

/**
 * The most chat messages that wait to be sent at once, as the chat service
 * holds them (`MAX_PENDING_CHAT_MESSAGES`): the largest count of a
 * `waiting` switch.
 */
export const MAX_WAITING_CHAT_MESSAGES = 50;

/**
 * The option of a switch: `discardWaiting: true` drops the chat messages
 * that wait to be sent and switches, after the person chose to discard
 * them (the Project Manager's decision of 2026-11-05 on #27). It comes from
 * the renderer, so an unknown key is refused rather than stripped.
 */
export const WorkspaceSwitchOptionsSchema = z.strictObject({
  discardWaiting: z.boolean(),
});
export type WorkspaceSwitchOptions = z.infer<
  typeof WorkspaceSwitchOptionsSchema
>;

/**
 * The result of selecting a workspace or opening a project: `ok`, `waiting`
 * when `count` chat messages wait to be sent and nothing changed, so that
 * the renderer can ask the person and repeat the switch with
 * `discardWaiting`, or `refused`.
 */
export const WorkspaceActionResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok") }),
  z.object({
    outcome: z.literal("waiting"),
    count: z.int().min(1).max(MAX_WAITING_CHAT_MESSAGES),
  }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(WORKSPACE_ACTION_REFUSALS),
  }),
]);
export type WorkspaceActionResult = z.infer<typeof WorkspaceActionResultSchema>;

// Creating a workspace and a project (#95, decisions D1 and D7): one strict
// channel each.

/**
 * The name of a new workspace or project that the renderer sends: 1 to
 * `WORKSPACE_LIMITS.name` (100) characters, counted as the protocol counts
 * them (code points). A longer string is refused before anything else runs.
 * The renderer trims it, and normalizes a project's name to NFC first, as
 * the protocol does, so that it counts the characters that the protocol
 * counts. The main process checks it with the protocol's request schema as
 * well, which also refuses a blank name and control, format, and invisible
 * characters.
 */
export const NewNameSchema = z
  .string()
  .min(1)
  .max(WORKSPACE_LIMITS.name, { abort: true });

/**
 * Why creating a workspace was refused. Only the outcome `unknown` leaves
 * open whether the API acted; after a refusal it did not.
 *
 * - `invalid`: the name is outside the protocol's rule. Nothing was sent.
 * - `not_signed_in`: no device of this installation is signed in, or the API
 *   refused its key or token.
 * - `unavailable`: a sign-in, a sign-out, "This is not me", a device
 *   removal, or an unlock runs, or the device cannot send now. Nothing was
 *   sent.
 * - `too_soon`: the installation's budget of writes is spent; nothing was
 *   sent. `retryAfterMs` says when the next write may go.
 * - `rate_limited`: the API's limit, with `retryAfterMs` from its answer,
 *   also its limit of 10 new workspaces per account in 24 hours.
 * - `failed`: the API refused it otherwise.
 */
export const CREATE_WORKSPACE_REFUSALS = Object.freeze([
  "invalid",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "failed",
] as const);
export type CreateWorkspaceRefusal = (typeof CREATE_WORKSPACE_REFUSALS)[number];

/**
 * Why creating a project was refused, as for a workspace, and:
 *
 * - `not_selected`: the workspace is not the selected one, for example after
 *   a switch. Nothing was sent.
 * - `rate_limited`: also the limit of 20 new projects per account in 24
 *   hours, with the time until the oldest of them leaves the window.
 * - `project_limit`: the workspace holds 100 projects that are not archived
 *   (#255). It carries no wait: only archiving a project frees a place.
 * - `not_found`: the API does not know the workspace for this account.
 * - `conflict`: a project of the workspace that is not archived has the
 *   name, compared without regard to case.
 */
export const CREATE_PROJECT_REFUSALS = Object.freeze([
  "invalid",
  "not_selected",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "project_limit",
  "not_found",
  "conflict",
  "failed",
] as const);
export type CreateProjectRefusal = (typeof CREATE_PROJECT_REFUSALS)[number];

/** The refusals of a create that say when the next write may go. */
const CREATE_WAITS: ReadonlySet<string> = new Set(["too_soon", "rate_limited"]);

/** A refusal of one of `reasons`, with `retryAfterMs` for a wait only. */
function createRefusedSchema<const T extends readonly string[]>(reasons: T) {
  return z
    .object({
      outcome: z.literal("refused"),
      reason: z.enum(reasons),
      /**
       * How long to wait before the next try, in milliseconds, for
       * `too_soon` and `rate_limited` only; null otherwise.
       */
      retryAfterMs: z.int().positive().nullable(),
    })
    .refine(
      (value) =>
        CREATE_WAITS.has(value.reason) === (value.retryAfterMs !== null),
      { message: "Only a wait has a retry time", path: ["retryAfterMs"] },
    );
}

/**
 * `unknown`: whether the API acted is not known. The create is never sent
 * again on its own; the screen asks the person to check the list.
 */
const CreateUnknownSchema = z.object({ outcome: z.literal("unknown") });

/**
 * The result of creating a workspace: `ok` with the new workspace's ID and
 * whether the main process selected it, `refused`, or `unknown`. The
 * account's own person in it, the owner, stays in the main process, and no
 * user ID crosses. It is not selected when chat messages wait to be sent or
 * when another workspace was selected while the create was on its way.
 */
export const CreateWorkspaceResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ok"),
    workspaceId: ProtocolIdSchema,
    selected: z.boolean(),
  }),
  createRefusedSchema(CREATE_WORKSPACE_REFUSALS),
  CreateUnknownSchema,
]);
export type CreateWorkspaceResult = z.infer<typeof CreateWorkspaceResultSchema>;

/**
 * The result of creating a project: `ok` with the new project's ID,
 * `refused`, or `unknown`. The project list shows the project once its
 * server event arrives, or after the next reload of the workspace.
 */
export const CreateProjectResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), projectId: ProtocolIdSchema }),
  createRefusedSchema(CREATE_PROJECT_REFUSALS),
  CreateUnknownSchema,
]);
export type CreateProjectResult = z.infer<typeof CreateProjectResultSchema>;

// The registered repositories of the open project, and their links to the
// folders mounted on this device (#286).

/**
 * Limits of the project repositories message: the repositories of one
 * project, the most that one answer of the API holds (the protocol's
 * `MAX_ANSWER_LIST_ITEMS`), and the length of a name in characters (code
 * points; the protocol's `LIMITS.name`). The shared contract does not import
 * the protocol package, so the main process's tests check that the values
 * match.
 */
export const PROJECT_REPOSITORY_LIMITS = Object.freeze({
  repositories: 1_000,
  name: 100,
});

/** Why the open project's repositories did not load, as for the agents. */
export const PROJECT_REPOSITORY_PROBLEMS = Object.freeze([
  "not_signed_in",
  "not_found",
  "rate_limited",
  "unavailable",
  "failed",
] as const);
export type ProjectRepositoryProblem =
  (typeof PROJECT_REPOSITORY_PROBLEMS)[number];

/**
 * The state of this device's repository links: `loading` until the file was
 * read once, `ready`, and `unavailable` when the file could not be read or
 * its folder is not known; nothing is then linked, and nothing is written.
 */
export const REPOSITORY_LINK_STATES = Object.freeze([
  "loading",
  "ready",
  "unavailable",
] as const);
export type RepositoryLinkState = (typeof REPOSITORY_LINK_STATES)[number];

/**
 * A registered repository of the open project as the renderer may know it:
 * its ID and name, whether the signed-in account linked it to a folder on
 * this device (`linked`), the mount of that folder while it is mounted
 * (`mountId`), else null, and whether the account may remove it
 * (`removable`, #309): the main process works it out from who registered
 * it and the account's own person and role, so no member ID crosses, and
 * the server still decides each removal. No path crosses here: the mount
 * list shows the folder of a mount, and a linked folder that is not mounted
 * is not named.
 */
export const ProjectRepositoryViewSchema = z
  .object({
    repositoryId: ProtocolIdSchema,
    name: z.string().min(1).max(PROJECT_REPOSITORY_LIMITS.name),
    linked: z.boolean(),
    mountId: MountIdSchema.nullable(),
    removable: z.boolean(),
  })
  .refine((value) => value.linked || value.mountId === null, {
    message: "Only a linked repository names a mount",
    path: ["mountId"],
  });
export type ProjectRepositoryView = z.infer<typeof ProjectRepositoryViewSchema>;

const ProjectRepositoriesViewFields = {
  /**
   * Grows by one with every change of the repositories, the links, the
   * mounts, the account, or what the account may remove. A receiver keeps
   * the view with the highest revision, like the runtime status.
   */
  revision: z.int().nonnegative(),
  /** The selected workspace while a project is open, else null. */
  workspaceId: ProtocolIdSchema.nullable(),
  projectId: ProtocolIdSchema.nullable(),
  links: z.enum(REPOSITORY_LINK_STATES),
  /** The open project's repositories that are not removed, the oldest first. */
  repositories: z
    .array(ProjectRepositoryViewSchema)
    .max(PROJECT_REPOSITORY_LIMITS.repositories)
    .readonly(),
};

/**
 * What the renderer may know of the open project's registered repositories:
 * `{ revision, status, problem?, workspaceId, projectId, links,
 * repositories }`, with a problem only while `unavailable`. The status is
 * the agents' status: `no_project`, `loading`, `ready`, or `unavailable`.
 * It holds IDs, names, mount IDs, and flags only: no path, no member ID,
 * and no user ID.
 */
export const ProjectRepositoriesViewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["no_project", "loading", "ready"]),
    ...ProjectRepositoriesViewFields,
  }),
  z.object({
    status: z.literal("unavailable"),
    problem: z.enum(PROJECT_REPOSITORY_PROBLEMS),
    ...ProjectRepositoriesViewFields,
  }),
]);
export type ProjectRepositoriesView = z.infer<
  typeof ProjectRepositoriesViewSchema
>;

/**
 * Why registering a repository was refused, as for a project, and:
 *
 * - `not_open`: the project is not the open one. Nothing was sent.
 * - `busy`: another registration of the same project is still waiting for
 *   its answer, perhaps one sent before the project was closed and opened
 *   again (#317). Nothing was sent: the server does not keep names unique.
 * - `repository_limit`: the project holds as many repositories as it may
 *   (the Project Manager's decision of 2026-11-14 on #286). It carries no
 *   wait: only removing a repository frees a place.
 * - `rate_limited`: also the account's limit of registrations in 24 hours.
 * - `not_found`: the API does not know the project for this account.
 * - `conflict`: the project is archived.
 */
export const REGISTER_REPOSITORY_REFUSALS = Object.freeze([
  "invalid",
  "not_open",
  "busy",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "repository_limit",
  "not_found",
  "conflict",
  "failed",
] as const);
export type RegisterRepositoryRefusal =
  (typeof REGISTER_REPOSITORY_REFUSALS)[number];

/**
 * The result of registering a repository: `ok` with its ID, `refused`, or
 * `unknown`. The list shows it once its server event arrives, or after the
 * next reload.
 */
export const RegisterRepositoryResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), repositoryId: ProtocolIdSchema }),
  createRefusedSchema(REGISTER_REPOSITORY_REFUSALS),
  CreateUnknownSchema,
]);
export type RegisterRepositoryResult = z.infer<
  typeof RegisterRepositoryResultSchema
>;

/**
 * Why removing a repository was refused, as for registering one, and:
 *
 * - `forbidden`: the account neither registered it nor is the workspace's
 *   owner or an admin (decision of 2026-11-14).
 * - `not_found`: the project does not hold the repository for this account.
 * - `conflict`: the repository is already removed, or the project is
 *   archived.
 */
export const REMOVE_REPOSITORY_REFUSALS = Object.freeze([
  "invalid",
  "not_open",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "forbidden",
  "not_found",
  "conflict",
  "failed",
] as const);
export type RemoveRepositoryRefusal =
  (typeof REMOVE_REPOSITORY_REFUSALS)[number];

/**
 * The result of removing a repository: `ok`, `refused`, or `unknown`. After
 * `ok`, its link on this device is dropped at once; every device drops its
 * own when the server event arrives, or at the next reload of the project.
 * After `conflict` or `not_found`, the main process reads the project's
 * repositories again, which drops one that is removed already.
 */
export const RemoveRepositoryResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok") }),
  createRefusedSchema(REMOVE_REPOSITORY_REFUSALS),
  CreateUnknownSchema,
]);
export type RemoveRepositoryResult = z.infer<
  typeof RemoveRepositoryResultSchema
>;

/**
 * Why linking a repository to a mounted folder was refused. The main
 * process asks the person to confirm each link in a native dialog that
 * names the repository and the folder (the Project Manager's decision of
 * 2026-11-17), so the renderer alone never links a folder.
 *
 * - `invalid`: an ID is outside its format.
 * - `not_registered`: the open project's repositories, as loaded, do not
 *   hold the repository, or it was removed.
 * - `not_mounted`: nothing is mounted with the mount ID.
 * - `folder_linked`: the account linked the folder to another repository;
 *   unlink it first.
 * - `nested_link`: the folder is inside, or contains, a folder that the
 *   account linked to another repository on this device, of any project;
 *   unlink that repository first (#302).
 * - `symbolic_link`: the folder or its common Git folder is a symbolic link
 *   or, on Windows, a junction, which cannot be linked.
 * - `folder_missing`: the folder or its common Git folder could not be read
 *   as a folder.
 * - `busy`: the confirmation of another link is open; one at a time. Also
 *   for a few seconds after a link answered `cancelled`.
 * - `cancelled`: the person did not confirm the link, or the dialog was
 *   closed because the main window closed or the device signed out or
 *   changed; nothing changed.
 * - `limit`: this device holds as many links as it keeps, and all of them
 *   are the account's own. A link of another account or a former person
 *   makes room first, the oldest first.
 * - `unavailable`: no account is signed in, the account's workspace list
 *   has not loaded yet, the account's own person in the workspace is not
 *   known, or the links are not `ready`.
 * - `failed`: the confirmation could not be shown, what was confirmed
 *   changed before the write (also the folder's identity while the dialog
 *   was open), or the link could not be written; nothing changed.
 */
export const LINK_REPOSITORY_REFUSALS = Object.freeze([
  "invalid",
  "not_registered",
  "not_mounted",
  "folder_linked",
  "nested_link",
  "symbolic_link",
  "folder_missing",
  "busy",
  "cancelled",
  "limit",
  "unavailable",
  "failed",
] as const);
export type LinkRepositoryRefusal = (typeof LINK_REPOSITORY_REFUSALS)[number];

/** The result of linking a repository to the folder of a mount. */
export const LinkRepositoryResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("linked") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(LINK_REPOSITORY_REFUSALS),
  }),
]);
export type LinkRepositoryResult = z.infer<typeof LinkRepositoryResultSchema>;

/**
 * Why unlinking a repository was refused: `invalid`, an ID outside its
 * format; `not_linked`, the account holds no link of it; `unavailable`, as
 * for linking.
 */
export const UNLINK_REPOSITORY_REFUSALS = Object.freeze([
  "invalid",
  "not_linked",
  "unavailable",
] as const);
export type UnlinkRepositoryRefusal =
  (typeof UNLINK_REPOSITORY_REFUSALS)[number];

/** The result of unlinking a repository from its folder. */
export const UnlinkRepositoryResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("unlinked") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(UNLINK_REPOSITORY_REFUSALS),
  }),
]);
export type UnlinkRepositoryResult = z.infer<
  typeof UnlinkRepositoryResultSchema
>;

// Copying the workspace ID (#95; the Project Manager's decision of
// 2026-11-13): one strict channel, so that a member can pass the ID on to
// someone who asks to join with it.

/**
 * Why copying a workspace ID was refused. Nothing was copied.
 *
 * - `invalid`: the ID is not one of the protocol's.
 * - `not_found`: the account's workspace list does not hold the workspace,
 *   also without a signed-in device, whose list is empty.
 */
export const COPY_WORKSPACE_ID_REFUSALS = Object.freeze([
  "invalid",
  "not_found",
] as const);
export type CopyWorkspaceIdRefusal =
  (typeof COPY_WORKSPACE_ID_REFUSALS)[number];

/**
 * The result of copying a workspace ID: `ok` once the system clipboard took
 * the ID (Electron's `clipboard.writeText` returns a promise, and the
 * answer waits for it), `refused` before anything was written, or `failed`
 * when the system refused the write: the write threw or its promise
 * rejected. The main process reports a failed write with a fixed message
 * that names no ID.
 */
export const CopyWorkspaceIdResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(COPY_WORKSPACE_ID_REFUSALS),
  }),
  z.object({ outcome: z.literal("failed") }),
]);
export type CopyWorkspaceIdResult = z.infer<typeof CopyWorkspaceIdResultSchema>;

// The people of the selected workspace (#95, decision D3).

/**
 * Limits of the people message: the number of people, the most that one
 * answer of the API holds (the protocol's `MAX_ANSWER_LIST_ITEMS`), the
 * length of a display name in characters (code points; the protocol's
 * `LIMITS.displayName`), and the highest limit of unclaimed people (the
 * protocol's `UNCLAIMED_MEMBER_LIMIT.max`). The main process sends the
 * active people first, then the former members, within the limit, and cuts
 * a longer name. The shared contract does not import the protocol package,
 * so the main process's tests check that the values match.
 */
export const PEOPLE_LIMITS = Object.freeze({
  people: 1_000,
  displayName: 64,
  maxUnclaimedMembers: 500,
});

/** The roles of a person, like the protocol's `MEMBER_ROLES`. */
export const PERSON_ROLES = Object.freeze([
  "owner",
  "admin",
  "member",
] as const);
export type PersonRoleView = (typeof PERSON_ROLES)[number];

/**
 * A person of the selected workspace (ADR 0014, "People and roles"). Its
 * member ID crosses, because the actions of the people screen will name
 * it; the user ID of the account that claimed it never does.
 */
export const PersonViewSchema = z.object({
  memberId: ProtocolIdSchema,
  displayName: z.string().min(1).max(PEOPLE_LIMITS.displayName),
  role: z.enum(PERSON_ROLES),
  /** Whether an account claimed the person. */
  claimed: z.boolean(),
  /**
   * The GitHub login of the account that claimed the person, and when it
   * was last verified; both null while the person is unclaimed, and for a
   * former member whose account's data was erased.
   */
  login: LoginSchema.nullable(),
  verifiedAt: TimestampSchema.nullable(),
  /** Whether the person was removed or left: a former member. */
  former: z.boolean(),
});
export type PersonView = z.infer<typeof PersonViewSchema>;

/**
 * The states of the people: `signed_out` without a signed-in device with a
 * ready key, `no_workspace` when the list loaded and no workspace is
 * selected, `loading` until the list and the selected workspace's people
 * loaded once, `ready`, and `unavailable` while a retry of a failed load of
 * the workspaces waits. They follow the workspace state.
 */
export const PEOPLE_STATUSES = Object.freeze([
  "signed_out",
  "no_workspace",
  "loading",
  "ready",
  "unavailable",
] as const);
export type PeopleStatusView = (typeof PEOPLE_STATUSES)[number];

const PeopleViewFields = {
  /**
   * Grows with every change. A receiver keeps the state with the highest
   * revision, like the runtime status.
   */
  revision: z.int().nonnegative(),
  /** The selected workspace, or null. */
  workspaceId: ProtocolIdSchema.nullable(),
  /**
   * The selected workspace's name from the workspace list, the same as the
   * sidebar's, cut to `WORKSPACE_LIMITS.name`; null without a selection.
   */
  workspaceName: WorkspaceNameSchema.nullable(),
  /** The account's own person in the selected workspace, or null. */
  ownMemberId: ProtocolIdSchema.nullable(),
  /**
   * The active people in the main process's order, which is the server's,
   * then the former members.
   */
  people: z.array(PersonViewSchema).max(PEOPLE_LIMITS.people).readonly(),
  /** How many people `people` leaves out beyond the limit. */
  morePeople: z.int().nonnegative(),
  /**
   * The workspace's live ownership offer, only for the owner, who made it,
   * and for its target, who may accept it: the target's member ID and when
   * the offer expires. Null for everyone else, without an offer, and once
   * it expired; the screen hides it past `expiresAt` as well.
   */
  ownershipOffer: z
    .object({ memberId: ProtocolIdSchema, expiresAt: TimestampSchema })
    .nullable(),
  /**
   * How many active unclaimed people the workspace may hold, from its last
   * reload, only for the owner and the admins, who define them; null for a
   * member and until the workspace loaded. No event reports a change of the
   * limit, so it can be out of date until the next reload.
   */
  maxUnclaimedMembers: z
    .int()
    .min(1)
    .max(PEOPLE_LIMITS.maxUnclaimedMembers)
    .nullable(),
};

/**
 * What the renderer may know of the selected workspace's people:
 * `{ revision, status, problem?, workspaceId, workspaceName, ownMemberId,
 * people, morePeople, ownershipOffer, maxUnclaimedMembers }`, with a problem
 * only while `unavailable`. It holds member IDs, names, roles, logins,
 * times, and a count only: no user ID and nothing secret.
 */
export const PeopleViewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["signed_out", "no_workspace", "loading", "ready"]),
    ...PeopleViewFields,
  }),
  z.object({
    status: z.literal("unavailable"),
    problem: z.enum(WORKSPACE_PROBLEMS),
    ...PeopleViewFields,
  }),
]);
export type PeopleView = z.infer<typeof PeopleViewSchema>;

// The people actions (#95, decisions D1 and D3): one strict channel each.

/**
 * A display name that the renderer sends for a person: 1 to 64 characters
 * (`PEOPLE_LIMITS.displayName`), counted as the protocol counts them. A
 * longer string is refused before anything else runs. The main process
 * checks it with the protocol's request schema as well, which also refuses
 * a blank name and control, format, and invisible characters.
 */
export const PersonNameSchema = z
  .string()
  .min(1)
  .max(PEOPLE_LIMITS.displayName, { abort: true });

/**
 * Why a people action was refused. Only the outcome `unknown` leaves open
 * whether the API acted; after a refusal it did not.
 *
 * - `invalid`: an ID is not one of the protocol's, or the name is outside
 *   the protocol's rule. Nothing was sent.
 * - `not_selected`: the workspace is not the selected one, for example
 *   after a switch. Nothing was sent.
 * - `not_signed_in`: no device of this installation is signed in, or the
 *   API refused its key or token.
 * - `unavailable`: a sign-in, a sign-out, "This is not me", a device
 *   removal, or an unlock runs, or the device cannot send now. Nothing was
 *   sent.
 * - `too_soon`: the installation's budget of writes is spent; nothing was
 *   sent. `retryAfterMs` says when the next write may go.
 * - `rate_limited`: the API's limit, with `retryAfterMs` from its answer.
 * - `unclaimed_limit`: a definition in a workspace that holds as many active
 *   unclaimed people as its limit (#242). It carries no wait: only removing
 *   an unclaimed person, or a claim of one, frees a place.
 * - `not_allowed`: the account's role does not allow the action
 *   (`forbidden`), for example the owner leaving.
 * - `not_found`: the API does not know the workspace or the person for
 *   this account.
 * - `conflict`: the person or the offer is not in the state that the action
 *   needs, for example a removed person, a second offer, or no live offer
 *   to withdraw or accept.
 * - `device_too_new`: a promotion or an offer from a device younger than
 *   72 hours.
 * - `failed`: the API refused it otherwise.
 */
export const PERSON_ACTION_REFUSALS = Object.freeze([
  "invalid",
  "not_selected",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "unclaimed_limit",
  "not_allowed",
  "not_found",
  "conflict",
  "device_too_new",
  "failed",
] as const);
export type PersonActionRefusal = (typeof PERSON_ACTION_REFUSALS)[number];

/** The refusals that say when the next write may go. */
const PERSON_ACTION_WAITS: ReadonlySet<PersonActionRefusal> = new Set([
  "too_soon",
  "rate_limited",
]);

const PersonActionRefusedSchema = z
  .object({
    outcome: z.literal("refused"),
    reason: z.enum(PERSON_ACTION_REFUSALS),
    /**
     * How long to wait before the next try, in milliseconds, for
     * `too_soon` and `rate_limited` only; null otherwise.
     */
    retryAfterMs: z.int().positive().nullable(),
  })
  .refine(
    (value) =>
      PERSON_ACTION_WAITS.has(value.reason) === (value.retryAfterMs !== null),
    { message: "Only a wait has a retry time", path: ["retryAfterMs"] },
  );

/**
 * `unknown`: whether the API acted is not known. The action is never sent
 * again on its own; the screen asks the person to check the list.
 */
const PersonActionUnknownSchema = z.object({ outcome: z.literal("unknown") });

/**
 * The result of a people action other than a definition: `ok` when the API
 * confirmed it, `refused` with a reason, or `unknown`. The people view
 * shows the change once its event arrives.
 */
export const PersonActionResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok") }),
  PersonActionRefusedSchema,
  PersonActionUnknownSchema,
]);
export type PersonActionResult = z.infer<typeof PersonActionResultSchema>;

/**
 * The result of defining a person: `ok` with the new person's member ID,
 * `refused`, or `unknown`, as for the other actions.
 */
export const DefinePersonResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), memberId: ProtocolIdSchema }),
  PersonActionRefusedSchema,
  PersonActionUnknownSchema,
]);
export type DefinePersonResult = z.infer<typeof DefinePersonResultSchema>;

// The invitations (#95, decisions D1 to D3): the live invitations of the
// selected workspace, and one strict channel for each invitation action.

/**
 * Limits of the invitation messages: the number of live invitations, the
 * most that one answer of the API holds (the protocol's
 * `MAX_ANSWER_LIST_ITEMS`); the length of a person's display name and of a
 * workspace name in characters (code points; the protocol's `LIMITS`); and
 * the lifetime of a new invitation in seconds (the protocol's
 * `INVITATION_LIFETIME_SECONDS`). The main process cuts a longer name. The
 * shared contract does not import the protocol package, so the main
 * process's tests check that the values match.
 */
export const INVITATION_LIMITS = Object.freeze({
  invitations: 1_000,
  displayName: 64,
  workspaceName: 100,
  minLifetimeSeconds: 3_600,
  maxLifetimeSeconds: 604_800,
});

/** An invitation code, like the protocol's `INVITATION_CODE_PATTERN`. */
const INVITATION_CODE_PATTERN = /^mmdi_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

/**
 * An invitation code (`mmdi_`), a credential (D2), in exactly the
 * protocol's form. It crosses IPC in two places only: from the renderer as
 * the text that the person pasted, for a preview and an accept, and from
 * the main process once, in the answer of a create. A longer string is
 * refused before the pattern runs, and no error repeats the text. Trimming
 * a pasted text is the join screen's job, so text with white space around
 * the code is refused.
 */
export const InvitationCodeTextSchema = z
  .string()
  .max(48, { abort: true })
  .regex(INVITATION_CODE_PATTERN, "Expected an invitation code");

/**
 * The lifetime of a new invitation in seconds, from 1 hour to 7 days; the
 * create channel takes null for the API's default of 7 days.
 */
export const InvitationLifetimeSchema = z
  .int()
  .min(INVITATION_LIMITS.minLifetimeSeconds)
  .max(INVITATION_LIMITS.maxLifetimeSeconds);

/**
 * A live invitation of the selected workspace (ADR 0014, "Invitations"):
 * its ID, the member ID of the unclaimed person that it claims, its
 * creator's display name, and its times. It never holds the code, which
 * the API shows once, in the answer of the create, or a user ID.
 */
export const InvitationViewSchema = z.object({
  invitationId: ProtocolIdSchema,
  memberId: ProtocolIdSchema,
  /** The creator's display name in the workspace, cut to its limit. */
  creatorName: z.string().min(1).max(INVITATION_LIMITS.displayName),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
export type InvitationView = z.infer<typeof InvitationViewSchema>;

/**
 * The states of the live invitations: `signed_out` without a signed-in
 * device with a ready key, `no_workspace` without a selected workspace,
 * `not_allowed` when the account's own person is not the owner or an admin
 * of it, `loading` until they loaded once for the selected workspace,
 * `ready`, and `unavailable` after a failed load, until a load succeeds.
 */
export const INVITATION_STATUSES = Object.freeze([
  "signed_out",
  "no_workspace",
  "not_allowed",
  "loading",
  "ready",
  "unavailable",
] as const);
export type InvitationStatusView = (typeof INVITATION_STATUSES)[number];

const InvitationsViewFields = {
  /**
   * Grows with every change. A receiver keeps the state with the highest
   * revision, like the runtime status.
   */
  revision: z.int().nonnegative(),
  /** The selected workspace, or null. */
  workspaceId: ProtocolIdSchema.nullable(),
  /**
   * The live invitations in the API's order, without the ones past their
   * `expiresAt`; empty unless the status is `ready` or `unavailable`.
   */
  invitations: z
    .array(InvitationViewSchema)
    .max(INVITATION_LIMITS.invitations)
    .readonly(),
};

/**
 * What the renderer may know of the selected workspace's live invitations:
 * `{ revision, status, problem?, workspaceId, invitations }`, with a
 * problem only while `unavailable`. It holds IDs, names, and times only:
 * no invitation code and no user ID.
 */
export const InvitationsViewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum([
      "signed_out",
      "no_workspace",
      "not_allowed",
      "loading",
      "ready",
    ]),
    ...InvitationsViewFields,
  }),
  z.object({
    status: z.literal("unavailable"),
    problem: z.enum(WORKSPACE_PROBLEMS),
    ...InvitationsViewFields,
  }),
]);
export type InvitationsView = z.infer<typeof InvitationsViewSchema>;

/**
 * Why a request to load the live invitations was refused: `not_signed_in`,
 * `no_workspace`, `not_allowed` as for the statuses, and `too_soon` within
 * a few seconds of the last request that loaded.
 */
export const INVITATION_LOAD_REFUSALS = Object.freeze([
  "not_signed_in",
  "no_workspace",
  "not_allowed",
  "too_soon",
] as const);

/**
 * The answer to a request to load the live invitations: `loading`, also
 * while the workspace's people load and the role is not known yet, or
 * `refused` with a reason.
 */
export const InvitationLoadResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("loading") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(INVITATION_LOAD_REFUSALS),
  }),
]);
export type InvitationLoadResult = z.infer<typeof InvitationLoadResultSchema>;

/**
 * Why a create or a revocation was refused. Only the outcome `unknown`
 * leaves open whether the API acted; after a refusal it did not.
 *
 * - `invalid`, `not_selected`, `not_signed_in`, `unavailable`, `too_soon`,
 *   `not_allowed`, and `not_found` as for the people actions.
 * - `rate_limited`: the API's limit, with `retryAfterMs` from its answer,
 *   also the workspace's limits of 50 live invitations and 100 new
 *   invitations in 24 hours.
 * - `conflict`: the person or the invitation is not in the state that the
 *   action needs, for example a claimed or removed person, or an
 *   invitation that is no longer live.
 * - `failed`: the API refused it otherwise.
 */
export const INVITATION_ACTION_REFUSALS = Object.freeze([
  "invalid",
  "not_selected",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "not_allowed",
  "not_found",
  "conflict",
  "failed",
] as const);
export type InvitationActionRefusal =
  (typeof INVITATION_ACTION_REFUSALS)[number];

/**
 * Why a preview or an accept of a pasted code was refused.
 *
 * - `invalid`: the text is not an invitation code. Nothing was sent.
 * - `not_signed_in`, `unavailable`, `too_soon` as for the other actions.
 * - `rate_limited`: the API's limit, with `retryAfterMs`, also its limit of
 *   10 failed previews or accepts in 15 minutes.
 * - `invitation_invalid`: the code is unknown, used, expired, or revoked,
 *   or its person was removed; the API does not say which.
 * - `already_member`: the account is already an active member of the
 *   workspace.
 * - `failed`: the API refused it otherwise.
 */
export const JOIN_INVITATION_REFUSALS = Object.freeze([
  "invalid",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "invitation_invalid",
  "already_member",
  "failed",
] as const);
export type JoinInvitationRefusal = (typeof JOIN_INVITATION_REFUSALS)[number];

/**
 * The refusals of an invitation or a join request action that say when the
 * next write may go.
 */
const ACTION_WAITS: ReadonlySet<string> = new Set(["too_soon", "rate_limited"]);

/** A refusal of one of `reasons`, with `retryAfterMs` for a wait only. */
function invitationRefusedSchema<const T extends readonly string[]>(
  reasons: T,
) {
  return z
    .object({
      outcome: z.literal("refused"),
      reason: z.enum(reasons),
      /**
       * How long to wait before the next try, in milliseconds, for
       * `too_soon` and `rate_limited` only; null otherwise.
       */
      retryAfterMs: z.int().positive().nullable(),
    })
    .refine(
      (value) =>
        ACTION_WAITS.has(value.reason) === (value.retryAfterMs !== null),
      { message: "Only a wait has a retry time", path: ["retryAfterMs"] },
    );
}

const InvitationActionRefusedSchema = invitationRefusedSchema(
  INVITATION_ACTION_REFUSALS,
);
const JoinInvitationRefusedSchema = invitationRefusedSchema(
  JOIN_INVITATION_REFUSALS,
);

/**
 * `unknown`: whether the API acted is not known. The action is never sent
 * again on its own; the screen asks the person to check the list. For a
 * preview, which changes nothing, it may still count as a failed one.
 */
const InvitationUnknownSchema = z.object({ outcome: z.literal("unknown") });

/**
 * The result of a create: `ok` with the new invitation's ID, its code, and
 * when it expires, `refused`, or `unknown`. The answer is the only place
 * where the main process sends a code (D2): it keeps none, and no channel
 * sends it again. A new invitation for the same person revokes the
 * previous one.
 */
export const CreateInvitationResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ok"),
    invitationId: ProtocolIdSchema,
    code: InvitationCodeTextSchema,
    expiresAt: TimestampSchema,
  }),
  InvitationActionRefusedSchema,
  InvitationUnknownSchema,
]);
export type CreateInvitationResult = z.infer<
  typeof CreateInvitationResultSchema
>;

/** The result of a revocation: `ok`, `refused`, or `unknown`. */
export const RevokeInvitationResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok") }),
  InvitationActionRefusedSchema,
  InvitationUnknownSchema,
]);
export type RevokeInvitationResult = z.infer<
  typeof RevokeInvitationResultSchema
>;

/**
 * The result of a preview (ADR 0014, "Invitations"): `ok` with the
 * workspace's name, the display name of the person that the code claims,
 * the inviter's display name and GitHub login with the time it was last
 * verified, and when the invitation expires; `refused`, or `unknown`. It
 * never repeats the code.
 */
export const PreviewInvitationResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ok"),
    workspaceName: z.string().min(1).max(INVITATION_LIMITS.workspaceName),
    displayName: z.string().min(1).max(INVITATION_LIMITS.displayName),
    inviterName: z.string().min(1).max(INVITATION_LIMITS.displayName),
    inviterLogin: LoginSchema,
    inviterVerifiedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  }),
  JoinInvitationRefusedSchema,
  InvitationUnknownSchema,
]);
export type PreviewInvitationResult = z.infer<
  typeof PreviewInvitationResultSchema
>;

/**
 * The result of an accept: `ok` with the joined workspace's ID and name,
 * `refused`, or `unknown`. The main process loads the workspace list again
 * after `ok` and `unknown`, so that the joined workspace appears in it.
 */
export const AcceptInvitationResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ok"),
    workspaceId: ProtocolIdSchema,
    workspaceName: z.string().min(1).max(INVITATION_LIMITS.workspaceName),
  }),
  JoinInvitationRefusedSchema,
  InvitationUnknownSchema,
]);
export type AcceptInvitationResult = z.infer<
  typeof AcceptInvitationResultSchema
>;

// The join requests of the selected workspace, for its owner and admins
// (#95, decisions D1 and D3; ADR 0014, "Join requests").

/**
 * Limits of the join request messages: the number of pending requests and
 * of blocks, each at most what one answer of the API holds (the protocol's
 * `MAX_ANSWER_LIST_ITEMS`), and the length of a requested display name in
 * characters (code points; the protocol's `LIMITS.displayName`). The main
 * process cuts a longer name. The shared contract does not import the
 * protocol package, so the main process's tests check that the values
 * match.
 */
export const JOIN_REQUEST_LIMITS = Object.freeze({
  requests: 1_000,
  displayName: 64,
});

const RequestedNameSchema = z
  .string()
  .min(1)
  .max(JOIN_REQUEST_LIMITS.displayName);

/**
 * A pending join request (ADR 0014, "Join requests"): its ID, the requested
 * display name, the requester's GitHub login with the time it was last
 * verified and the creation date of that GitHub account, which approvers
 * always see next to the requested name, and when the request was created
 * and expires. Never the requester's user ID.
 */
export const PendingJoinRequestViewSchema = z.object({
  joinRequestId: ProtocolIdSchema,
  requestedName: RequestedNameSchema,
  login: LoginSchema,
  verifiedAt: TimestampSchema,
  accountCreatedAt: TimestampSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
export type PendingJoinRequestView = z.infer<
  typeof PendingJoinRequestViewSchema
>;

/**
 * A block in force: the blocked request with when it was blocked. The
 * login, its verification time, and the account's creation date are null
 * only after the account's data was erased.
 */
export const BlockedJoinRequestViewSchema = z.object({
  joinRequestId: ProtocolIdSchema,
  requestedName: RequestedNameSchema,
  login: LoginSchema.nullable(),
  verifiedAt: TimestampSchema.nullable(),
  accountCreatedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  blockedAt: TimestampSchema,
});
export type BlockedJoinRequestView = z.infer<
  typeof BlockedJoinRequestViewSchema
>;

/**
 * The states of the join requests, as for the live invitations:
 * `signed_out`, `no_workspace`, `not_allowed` when the account's own person
 * is not the owner or an admin of the selected workspace, `loading` until
 * they loaded once for it, `ready`, and `unavailable` after a failed load,
 * until a load succeeds.
 */
export const JOIN_REQUEST_STATUSES = Object.freeze([
  "signed_out",
  "no_workspace",
  "not_allowed",
  "loading",
  "ready",
  "unavailable",
] as const);
export type JoinRequestStatusView = (typeof JOIN_REQUEST_STATUSES)[number];

const JoinRequestsViewFields = {
  /**
   * Grows with every change. A receiver keeps the state with the highest
   * revision, like the runtime status.
   */
  revision: z.int().nonnegative(),
  /** The selected workspace, or null. */
  workspaceId: ProtocolIdSchema.nullable(),
  /**
   * The pending requests, in the API's order with the new ones at the end,
   * without the ones past their `expiresAt`; empty unless the status is
   * `ready` or `unavailable`.
   */
  pending: z
    .array(PendingJoinRequestViewSchema)
    .max(JOIN_REQUEST_LIMITS.requests)
    .readonly(),
  /** The blocks in force, in the API's order with the new ones at the end. */
  blocked: z
    .array(BlockedJoinRequestViewSchema)
    .max(JOIN_REQUEST_LIMITS.requests)
    .readonly(),
  /**
   * When new requests were paused, from the workspace's last reload, or
   * null while they are accepted. Null as well for anyone but the owner and
   * the admins.
   */
  pausedAt: TimestampSchema.nullable(),
};

/**
 * What the renderer may know of the selected workspace's join requests:
 * `{ revision, status, problem?, workspaceId, pending, blocked, pausedAt }`,
 * with a problem only while `unavailable`. It holds IDs, names, logins, and
 * times only: no user ID.
 */
export const JoinRequestsViewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum([
      "signed_out",
      "no_workspace",
      "not_allowed",
      "loading",
      "ready",
    ]),
    ...JoinRequestsViewFields,
  }),
  z.object({
    status: z.literal("unavailable"),
    problem: z.enum(WORKSPACE_PROBLEMS),
    ...JoinRequestsViewFields,
  }),
]);
export type JoinRequestsView = z.infer<typeof JoinRequestsViewSchema>;

/**
 * Why a request to load the join requests was refused, as for the live
 * invitations: `not_signed_in`, `no_workspace`, `not_allowed`, and
 * `too_soon` within a few seconds of the last request that loaded.
 */
export const JOIN_REQUEST_LOAD_REFUSALS = Object.freeze([
  "not_signed_in",
  "no_workspace",
  "not_allowed",
  "too_soon",
] as const);

/**
 * The answer to a request to load the join requests: `loading`, also while
 * the workspace's people load and the role is not known yet, or `refused`
 * with a reason.
 */
export const JoinRequestLoadResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("loading") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(JOIN_REQUEST_LOAD_REFUSALS),
  }),
]);
export type JoinRequestLoadResult = z.infer<typeof JoinRequestLoadResultSchema>;

/**
 * Why a join request action was refused. Only the outcome `unknown` leaves
 * open whether the API acted; after a refusal it did not.
 *
 * - `invalid`, `not_selected`, `not_signed_in`, `unavailable`, `too_soon`,
 *   `rate_limited`, and `not_allowed` as for the people actions.
 * - `not_found`: the API does not know the workspace or the request for
 *   this account.
 * - `conflict`: the request is not in the state that the action needs, for
 *   example a request that is no longer pending, also one past its expiry,
 *   or a block that was lifted.
 * - `already_member`: an approval of a request whose account is already an
 *   active member, for example after it joined with an invitation.
 * - `failed`: the API refused it otherwise.
 */
export const JOIN_REQUEST_ACTION_REFUSALS = Object.freeze([
  "invalid",
  "not_selected",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "not_allowed",
  "not_found",
  "conflict",
  "already_member",
  "failed",
] as const);
export type JoinRequestActionRefusal =
  (typeof JOIN_REQUEST_ACTION_REFUSALS)[number];

const JoinRequestActionRefusedSchema = z
  .object({
    outcome: z.literal("refused"),
    reason: z.enum(JOIN_REQUEST_ACTION_REFUSALS),
    /**
     * How long to wait before the next try, in milliseconds, for
     * `too_soon` and `rate_limited` only; null otherwise.
     */
    retryAfterMs: z.int().positive().nullable(),
  })
  .refine(
    (value) => ACTION_WAITS.has(value.reason) === (value.retryAfterMs !== null),
    { message: "Only a wait has a retry time", path: ["retryAfterMs"] },
  );

/**
 * `unknown`: whether the API acted is not known. The action is never sent
 * again on its own; the screen asks the person to check the list.
 */
const JoinRequestActionUnknownSchema = z.object({
  outcome: z.literal("unknown"),
});

/**
 * The result of an approval: `ok` with the new person's member ID, never
 * its user ID, `refused`, or `unknown`. The people view shows the person
 * once `workspace.member.claimed` arrives.
 */
export const ApproveJoinRequestResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), memberId: ProtocolIdSchema }),
  JoinRequestActionRefusedSchema,
  JoinRequestActionUnknownSchema,
]);
export type ApproveJoinRequestResult = z.infer<
  typeof ApproveJoinRequestResultSchema
>;

/**
 * The result of a denial, denying all, a block, an unblock, a pause, and a
 * resume: `ok`, `refused`, or `unknown`.
 */
export const JoinRequestActionResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok") }),
  JoinRequestActionRefusedSchema,
  JoinRequestActionUnknownSchema,
]);
export type JoinRequestActionResult = z.infer<
  typeof JoinRequestActionResultSchema
>;

// The account's own join requests, as their requester sees them (#95,
// decisions D1 and D3; ADR 0014, "Join requests").

/**
 * Limits of the own join request messages: the number of requests, the
 * most that one answer of the API holds (the protocol's
 * `MAX_ANSWER_LIST_ITEMS`), and the length of a requested display name in
 * characters (code points; the protocol's `LIMITS.displayName`). The main
 * process cuts a longer name. The shared contract does not import the
 * protocol package, so the main process's tests check that the values
 * match.
 */
export const OWN_JOIN_REQUEST_LIMITS = Object.freeze({
  requests: 1_000,
  displayName: 64,
});

/**
 * How one of the account's own requests ended, as its requester sees it:
 * the protocol's `OWN_JOIN_REQUEST_DECISIONS`. A block shows as `denied`
 * (#92), and a request past its expiry as `expired`, with its expiry as
 * the time of the decision, also before the API marked it.
 */
export const OWN_JOIN_REQUEST_OUTCOMES = Object.freeze([
  "approved",
  "denied",
  "withdrawn",
  "expired",
] as const);
export type OwnJoinRequestOutcomeView =
  (typeof OWN_JOIN_REQUEST_OUTCOMES)[number];

const OwnRequestedNameSchema = z
  .string()
  .min(1)
  .max(OWN_JOIN_REQUEST_LIMITS.displayName);

/**
 * One of the account's own join requests: its ID, the ID of the workspace
 * that it asks to join, the requested display name, and its times, with
 * `decision` and `decidedAt` both null while it is pending. Nothing else
 * about the workspace, which the API shows the requester only after an
 * approval, and never a user ID.
 */
export const OwnJoinRequestViewSchema = z
  .object({
    joinRequestId: ProtocolIdSchema,
    workspaceId: ProtocolIdSchema,
    requestedName: OwnRequestedNameSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    decision: z.enum(OWN_JOIN_REQUEST_OUTCOMES).nullable(),
    decidedAt: TimestampSchema.nullable(),
  })
  .refine((value) => (value.decision === null) === (value.decidedAt === null), {
    message: "A decision has a time, and only a decision",
    path: ["decidedAt"],
  });
export type OwnJoinRequestView = z.infer<typeof OwnJoinRequestViewSchema>;

/**
 * The states of the own join requests, as for the device list:
 * `signed_out` without a signed-in device with a ready key, `loading` until
 * they loaded once for the device, `ready`, and `unavailable` after a
 * failed load, until a load succeeds.
 */
export const OWN_JOIN_REQUEST_STATUSES = Object.freeze([
  "signed_out",
  "loading",
  "ready",
  "unavailable",
] as const);
export type OwnJoinRequestStatusView =
  (typeof OWN_JOIN_REQUEST_STATUSES)[number];

const OwnJoinRequestsViewFields = {
  /**
   * Grows with every change. A receiver keeps the state with the highest
   * revision, like the runtime status.
   */
  revision: z.int().nonnegative(),
  /**
   * The requests in the API's order, the most recently created first,
   * with a pending one past its expiry shown as `expired`; empty unless the
   * status is `ready` or `unavailable`.
   */
  requests: z
    .array(OwnJoinRequestViewSchema)
    .max(OWN_JOIN_REQUEST_LIMITS.requests)
    .readonly(),
};

/**
 * What the renderer may know of the account's own join requests:
 * `{ revision, status, problem?, requests }`, with a problem only while
 * `unavailable`. It holds IDs, names, decisions, and times only: no user
 * ID.
 */
export const OwnJoinRequestsViewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["signed_out", "loading", "ready"]),
    ...OwnJoinRequestsViewFields,
  }),
  z.object({
    status: z.literal("unavailable"),
    problem: z.enum(WORKSPACE_PROBLEMS),
    ...OwnJoinRequestsViewFields,
  }),
]);
export type OwnJoinRequestsView = z.infer<typeof OwnJoinRequestsViewSchema>;

/**
 * Why a request to load the own join requests was refused, as for the
 * device list: `not_signed_in`, and `too_soon` within a few seconds of the
 * last request that loaded.
 */
export const OWN_JOIN_REQUEST_LOAD_REFUSALS = Object.freeze([
  "not_signed_in",
  "too_soon",
] as const);

/** The answer to a request to load the own join requests. */
export const OwnJoinRequestLoadResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("loading") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(OWN_JOIN_REQUEST_LOAD_REFUSALS),
  }),
]);
export type OwnJoinRequestLoadResult = z.infer<
  typeof OwnJoinRequestLoadResultSchema
>;

/**
 * Why a create or a withdrawal of an own join request was refused. Only
 * the outcome `unknown` leaves open whether the API acted; after a refusal
 * it did not.
 *
 * - `invalid`, `not_signed_in`, `unavailable`, `too_soon`, and
 *   `rate_limited` as for the people actions. `rate_limited` also covers
 *   the limits of ADR 0014: at most 5 pending requests and 10 new requests
 *   in 24 hours per account, 50 pending requests per workspace, and a wait
 *   of 24 hours after a denial; `retryAfterMs` says how long. A create
 *   without a display name, while no account is signed in, whose display
 *   name would be the default, is `not_signed_in`, and nothing is sent.
 * - `already_member`: the account is already an active member of the
 *   workspace.
 * - `workspace_not_found`: no workspace has the ID, or it is archived.
 * - `join_requests_closed`: the workspace pauses new requests, or it
 *   blocks the account; the API does not say which.
 * - `not_found`: a withdrawal of a request that the account does not have.
 * - `conflict`: a withdrawal of a request that is no longer pending, also
 *   one past its expiry.
 * - `failed`: the API refused it otherwise.
 */
export const OWN_JOIN_REQUEST_ACTION_REFUSALS = Object.freeze([
  "invalid",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "already_member",
  "workspace_not_found",
  "join_requests_closed",
  "not_found",
  "conflict",
  "failed",
] as const);
export type OwnJoinRequestActionRefusal =
  (typeof OWN_JOIN_REQUEST_ACTION_REFUSALS)[number];

const OwnJoinRequestActionRefusedSchema = invitationRefusedSchema(
  OWN_JOIN_REQUEST_ACTION_REFUSALS,
);

/**
 * `unknown`: whether the API acted is not known. The action is never sent
 * again on its own; the screen asks the person to check the list.
 */
const OwnJoinRequestUnknownSchema = z.object({ outcome: z.literal("unknown") });

/**
 * The result of a create: `ok` with the pending request, `refused`, or
 * `unknown`. While the account has a pending request for the workspace,
 * the API answers with that request instead of creating another, so its
 * requested name may differ from the one sent.
 */
export const CreateJoinRequestResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ok"),
    joinRequestId: ProtocolIdSchema,
    workspaceId: ProtocolIdSchema,
    requestedName: OwnRequestedNameSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
  }),
  OwnJoinRequestActionRefusedSchema,
  OwnJoinRequestUnknownSchema,
]);
export type CreateJoinRequestResult = z.infer<
  typeof CreateJoinRequestResultSchema
>;

/** The result of a withdrawal: `ok`, `refused`, or `unknown`. */
export const WithdrawJoinRequestResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok") }),
  OwnJoinRequestActionRefusedSchema,
  OwnJoinRequestUnknownSchema,
]);
export type WithdrawJoinRequestResult = z.infer<
  typeof WithdrawJoinRequestResultSchema
>;

// The recent claims of the selected workspace, for its owner and admins
// (#95, decision D8 of 2026-11-13; ADR 0014, "Invitations").

/**
 * Limits of the claim messages: the number of claims, at most what one
 * answer of the API holds (the protocol's `MAX_ANSWER_LIST_ITEMS`; the
 * server sends its 50 most recent, `RECENT_CLAIMS`). The shared contract
 * does not import the protocol package, so the main process's tests check
 * that the value matches.
 */
export const CLAIM_LIMITS = Object.freeze({
  claims: 1_000,
});

/**
 * How the account claimed the person, the protocol's `CLAIM_VIAS`:
 * `invitation` when it accepted an invitation code, which nobody vetted the
 * account for, and `join_request` when an owner or admin approved its join
 * request.
 */
export const CLAIM_VIAS_VIEW = Object.freeze([
  "invitation",
  "join_request",
] as const);
export type ClaimViaView = (typeof CLAIM_VIAS_VIEW)[number];

/**
 * The time of a claim, in UTC with milliseconds, as the protocol writes it.
 * The fixed form bounds its length.
 */
const ClaimTimeSchema = z.iso.datetime({ precision: 3 });

/**
 * The member IDs of the claims that the screen showed: 1 to
 * `CLAIM_LIMITS.claims` lowercase UUIDv7s, the most that a list holds. A
 * longer array is refused before its items are checked.
 */
const ShownClaimsSchema = z
  .array(ProtocolIdSchema)
  .min(1)
  .max(CLAIM_LIMITS.claims, { abort: true });

/**
 * A claim (ADR 0014, "Invitations"): the member ID of the person that was
 * claimed, the claimer's GitHub login with the time it was last verified
 * and the creation date of that GitHub account, how the person was claimed,
 * when, and whether the account has not seen it yet. The login and its two
 * times are null together, only after the account's data was erased. Never
 * a user ID.
 */
export const ClaimViewSchema = z
  .object({
    memberId: ProtocolIdSchema,
    login: LoginSchema.nullable(),
    verifiedAt: TimestampSchema.nullable(),
    accountCreatedAt: TimestampSchema.nullable(),
    via: z.enum(CLAIM_VIAS_VIEW),
    claimedAt: ClaimTimeSchema,
    unseen: z.boolean(),
  })
  .refine(
    (claim) =>
      (claim.login === null) === (claim.verifiedAt === null) &&
      (claim.login === null) === (claim.accountCreatedAt === null),
    { message: "The login and its times come together", path: ["login"] },
  );
export type ClaimView = z.infer<typeof ClaimViewSchema>;

/**
 * The states of the claims, as for the join requests: `signed_out`,
 * `no_workspace`, `not_allowed` when the account's own person is not the
 * owner or an admin of the selected workspace, `loading` until they loaded
 * once for it, `ready`, and `unavailable` after a failed load, until a load
 * succeeds.
 */
export const CLAIM_STATUSES = Object.freeze([
  "signed_out",
  "no_workspace",
  "not_allowed",
  "loading",
  "ready",
  "unavailable",
] as const);
export type ClaimStatusView = (typeof CLAIM_STATUSES)[number];

const ClaimsViewFields = {
  /**
   * Grows with every change. A receiver keeps the state with the highest
   * revision, like the runtime status.
   */
  revision: z.int().nonnegative(),
  /** The selected workspace, or null. */
  workspaceId: ProtocolIdSchema.nullable(),
  /**
   * The claims, in the API's order, the most recent first; empty unless the
   * status is `ready` or `unavailable`.
   */
  claims: z.array(ClaimViewSchema).max(CLAIM_LIMITS.claims).readonly(),
};

/**
 * What the renderer may know of the selected workspace's recent claims:
 * `{ revision, status, problem?, workspaceId, claims }`, with a problem only
 * while `unavailable`. It holds member IDs, logins, and times only: no user
 * ID. Any claim with `unseen` marks the people item of the sidebar.
 */
export const ClaimsViewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum([
      "signed_out",
      "no_workspace",
      "not_allowed",
      "loading",
      "ready",
    ]),
    ...ClaimsViewFields,
  }),
  z.object({
    status: z.literal("unavailable"),
    problem: z.enum(WORKSPACE_PROBLEMS),
    ...ClaimsViewFields,
  }),
]);
export type ClaimsView = z.infer<typeof ClaimsViewSchema>;

/**
 * Why a request to load the claims was refused, as for the join requests:
 * `not_signed_in`, `no_workspace`, `not_allowed`, and `too_soon` within a
 * few seconds of the last request that loaded.
 */
export const CLAIM_LOAD_REFUSALS = Object.freeze([
  "not_signed_in",
  "no_workspace",
  "not_allowed",
  "too_soon",
] as const);

/**
 * The answer to a request to load the claims: `loading`, also while the
 * workspace's people load and the role is not known yet, or `refused` with
 * a reason.
 */
export const ClaimLoadResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("loading") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(CLAIM_LOAD_REFUSALS),
  }),
]);
export type ClaimLoadResult = z.infer<typeof ClaimLoadResultSchema>;

/**
 * Why the report of the claims that the screen showed was refused:
 *
 * - `invalid`: the protocol's schemas refuse the workspace ID or a member
 *   ID.
 * - `not_selected`: the workspace is not the selected one.
 * - `not_allowed`: the account's own person is not the owner or an admin.
 * - `not_listed`: no claim that the main process holds has any of the
 *   member IDs. When some do, the others are ignored.
 */
export const CLAIM_MARK_SEEN_REFUSALS = Object.freeze([
  "invalid",
  "not_selected",
  "not_allowed",
  "not_listed",
] as const);

/**
 * The answer to the report of the claims that the screen showed: `ok`, also
 * when they were all seen already, or `refused` with a reason.
 */
export const ClaimMarkSeenResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(CLAIM_MARK_SEEN_REFUSALS),
  }),
]);
export type ClaimMarkSeenResult = z.infer<typeof ClaimMarkSeenResultSchema>;

/**
 * What the renderer may know of the other workspaces' claims (#271): the
 * IDs of the workspaces of the list that hold a claim that the account has
 * not seen, in the list's order, at most `WORKSPACE_LIMITS.workspaces`.
 * Only whether a workspace has unseen claims crosses: no claim, member ID,
 * login, time, or user ID. The selected workspace is named only while the
 * claim service loads it; once its claims (`ClaimsViewSchema`) are `ready`
 * or `unavailable`, its mark follows them.
 */
export const ClaimMarksViewSchema = z.object({
  /**
   * Grows with every change. A receiver keeps the state with the highest
   * revision, like the runtime status.
   */
  revision: z.int().nonnegative(),
  workspaceIds: z
    .array(ProtocolIdSchema)
    .max(WORKSPACE_LIMITS.workspaces)
    .readonly(),
});
export type ClaimMarksView = z.infer<typeof ClaimMarksViewSchema>;

// The agent activity of the open project (#28).

/**
 * Limits of the agent activity message: the number of agents, the most
 * that one answer of the API holds (the protocol's `MAX_ANSWER_LIST_ITEMS`);
 * the number of unfinished and of finished runs that the main process
 * sends (the protocol's `RECENT_FINISHED_RUNS` for the finished ones); and
 * the length of an agent's name, its owner's name, and a run's reason in
 * characters (code points; zod counts them like the protocol's `LIMITS`).
 * The main process sends the newest runs within these limits and cuts a
 * longer name or reason. The shared contract does not import the protocol
 * package, so the main process's tests check that the values match.
 */
export const AGENT_LIMITS = Object.freeze({
  agents: 1_000,
  unfinishedRuns: 200,
  finishedRuns: 50,
  agentName: 64,
  ownerName: 64,
  runReason: 500,
});

/**
 * The states of the agent activity service: `no_project` while no project
 * is open, `loading` until the open project's activity loaded once,
 * `ready`, and `unavailable` after a failed reload, until a reload
 * succeeds.
 */
export const AGENT_ACTIVITY_STATUSES = Object.freeze([
  "no_project",
  "loading",
  "ready",
  "unavailable",
] as const);
export type AgentActivityStatusView = (typeof AGENT_ACTIVITY_STATUSES)[number];

/** Why the agent activity is `unavailable`: the failure of the last reload. */
export const AGENT_ACTIVITY_PROBLEMS = Object.freeze([
  "not_signed_in",
  "not_found",
  "rate_limited",
  "unavailable",
  "failed",
] as const);
export type AgentActivityProblem = (typeof AGENT_ACTIVITY_PROBLEMS)[number];

/** The six run states, like the protocol's `RUN_STATES`. */
export const AGENT_RUN_STATES = Object.freeze([
  "queued",
  "running",
  "awaiting_input",
  "completed",
  "failed",
  "cancelled",
] as const);
export type AgentRunStateView = (typeof AGENT_RUN_STATES)[number];

/**
 * An agent of the open project, disabled ones included. Its owner crosses
 * as the display name that the main process resolved, never as a member
 * ID, and nothing names a device: the main process compares the agent's
 * host device, which only the agent's own account reads (#342), with its
 * own and sends the answer as a flag.
 */
export const AgentViewSchema = z.object({
  id: ProtocolIdSchema,
  name: z.string().min(1).max(AGENT_LIMITS.agentName),
  ownerName: z.string().min(1).max(AGENT_LIMITS.ownerName),
  /** When the agent was disabled; null while it is enabled. */
  disabledAt: TimestampSchema.nullable(),
  /**
   * Whether the signed-in account's own person owns the agent (#342): it
   * may revoke the agent's grants.
   */
  ownedByMe: z.boolean(),
  /**
   * Whether this device may grant the agent capabilities (#342): the agent
   * is enabled, the account owns it, and this device is its host device.
   * The server still decides each grant.
   */
  grantableHere: z.boolean(),
  /**
   * Whether the agent is one of the account's enabled agents that another
   * device is known to host (#345): the permission screen offers it after
   * the agents grantable here, with its grants to revoke and without the
   * form. An agent whose host is not known, from a server that does not
   * send it or before this device's key is ready, is neither, because it
   * may be this device's own.
   */
  hostedElsewhere: z.boolean(),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

/** A run of an agent of the open project. */
export const AgentRunViewSchema = z.object({
  id: ProtocolIdSchema,
  agentId: ProtocolIdSchema,
  state: z.enum(AGENT_RUN_STATES),
  /** The reason given with the last state change; null without one. */
  reason: z.string().min(1).max(AGENT_LIMITS.runReason).nullable(),
  createdAt: TimestampSchema,
  /** Set exactly when the run is finished. */
  finishedAt: TimestampSchema.nullable(),
});
export type AgentRunView = z.infer<typeof AgentRunViewSchema>;

const AgentActivityViewFields = {
  /**
   * Grows by one with every change, also when only an owner's name
   * changed. A receiver keeps the view with the highest revision, like the
   * runtime status.
   */
  revision: z.int().nonnegative(),
  /** The selected workspace while a project is open, else null. */
  workspaceId: ProtocolIdSchema.nullable(),
  projectId: ProtocolIdSchema.nullable(),
  /** The open project's agents, in the server's order. */
  agents: z.array(AgentViewSchema).max(AGENT_LIMITS.agents).readonly(),
  /** The newest unfinished runs, the most recently created first. */
  unfinishedRuns: z
    .array(AgentRunViewSchema)
    .max(AGENT_LIMITS.unfinishedRuns)
    .readonly(),
  /** How many older unfinished runs `unfinishedRuns` leaves out. */
  moreUnfinishedRuns: z.int().nonnegative(),
  /** The most recently finished runs, the most recently finished first. */
  finishedRuns: z
    .array(AgentRunViewSchema)
    .max(AGENT_LIMITS.finishedRuns)
    .readonly(),
};

/**
 * What the renderer may know of the open project's agent activity:
 * `{ revision, status, problem?, workspaceId, projectId, agents,
 * unfinishedRuns, moreUnfinishedRuns, finishedRuns }`, with a problem only
 * while `unavailable`. It holds IDs, names, states, reasons, and times
 * only: no member ID, no device ID, and nothing secret.
 */
export const AgentActivityViewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["no_project", "loading", "ready"]),
    ...AgentActivityViewFields,
  }),
  z.object({
    status: z.literal("unavailable"),
    problem: z.enum(AGENT_ACTIVITY_PROBLEMS),
    ...AgentActivityViewFields,
  }),
]);
export type AgentActivityView = z.infer<typeof AgentActivityViewSchema>;

// Granting and revoking an agent's capabilities (#342).

/**
 * The capability names, as `CAPABILITY_RISK` of `@mymandev/permissions`
 * lists them. The shared contract imports no package, so the main
 * process's tests check that the values match.
 */
export const GRANT_CAPABILITIES = Object.freeze([
  "repo.read",
  "repo.write",
  "terminal.execute",
  "git.commit",
  "git.push",
  "provider.use",
] as const);
export type GrantCapabilityName = (typeof GRANT_CAPABILITIES)[number];

/**
 * The provider kinds, as `PROVIDER_KINDS` of the protocol lists them; the
 * main process's tests check that the values match.
 */
export const PROVIDER_KIND_VIEWS = Object.freeze(["claude", "codex"] as const);

/**
 * Limits of the grant messages: the grants of the open project's agents
 * that one view holds, the most that the grant records hold
 * (`MAX_ANSWER_LIST_ITEMS`); this device's provider connections, the most
 * that one answer holds; a connection's label in characters, the
 * protocol's `LIMITS.providerConnectionLabel`; and the grants of one agent
 * that another device hosts, the most that an agent holds
 * (`GRANT_COUNT_LIMITS.perAgent`). The main process's tests check that the
 * values match.
 */
export const GRANT_LIMITS = Object.freeze({
  grants: 1_000,
  providerConnections: 1_000,
  providerConnectionLabel: 64,
  agentGrants: 100,
});

/**
 * A grant of an agent of the open project, as this device's grant records
 * hold it: its ID, its agent, its capability, its scope (a repository of
 * the project, or for `provider.use` a provider connection of this
 * device), when it was created and expires, and whether it has expired by
 * this device's clock. It names no account and no host device. Only the
 * agent's host device holds such records, so an agent that another device
 * hosts has none in the grant state; its owner reads its grants with
 * `listAgentGrants` instead, in the same form (#345), where a provider
 * connection is one of the host device.
 */
export const GrantViewSchema = z
  .object({
    id: ProtocolIdSchema,
    agentId: ProtocolIdSchema,
    capability: z.enum(GRANT_CAPABILITIES),
    repositoryId: ProtocolIdSchema.nullable(),
    providerConnectionId: ProtocolIdSchema.nullable(),
    createdAt: TimestampSchema,
    /** null for a grant without an expiry. */
    expiresAt: TimestampSchema.nullable(),
    expired: z.boolean(),
  })
  .refine(
    (grant) =>
      (grant.capability === "provider.use") ===
        (grant.providerConnectionId !== null) &&
      (grant.repositoryId === null) === (grant.providerConnectionId !== null),
    { message: "A grant names exactly the scope of its capability" },
  );
export type GrantView = z.infer<typeof GrantViewSchema>;

/**
 * What the renderer may know of the grants of the open project's agents:
 * `{ revision, projectId, usable, grants }`. `usable` is false while the
 * grant store holds no usable answer of `GET /grant-records`, for example
 * before the first read after `workspace.subscribed`; `grants` is then
 * empty, and the screen says that the grants cannot be shown.
 */
export const GrantsViewSchema = z.object({
  /** Grows by one with every change. The highest revision wins. */
  revision: z.int().nonnegative(),
  /** The open project, else null. */
  projectId: ProtocolIdSchema.nullable(),
  usable: z.boolean(),
  grants: z.array(GrantViewSchema).max(GRANT_LIMITS.grants).readonly(),
});
export type GrantsView = z.infer<typeof GrantsViewSchema>;

/** A provider connection of this device: never a credential. */
export const ProviderConnectionViewSchema = z.object({
  id: ProtocolIdSchema,
  kind: z.enum(PROVIDER_KIND_VIEWS),
  label: z.string().min(1).max(GRANT_LIMITS.providerConnectionLabel),
});
export type ProviderConnectionView = z.infer<
  typeof ProviderConnectionViewSchema
>;

/** Why this device's provider connections could not be read. */
export const PROVIDER_CONNECTION_READ_PROBLEMS = Object.freeze([
  "not_signed_in",
  "rate_limited",
  "unavailable",
  "failed",
] as const);
export type ProviderConnectionReadProblem =
  (typeof PROVIDER_CONNECTION_READ_PROBLEMS)[number];

/**
 * The result of reading this device's provider connections, the oldest
 * first: `ok` with them, or `refused` with a problem.
 */
export const ProviderConnectionsResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ok"),
    connections: z
      .array(ProviderConnectionViewSchema)
      .max(GRANT_LIMITS.providerConnections)
      .readonly(),
  }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(PROVIDER_CONNECTION_READ_PROBLEMS),
  }),
]);
export type ProviderConnectionsResult = z.infer<
  typeof ProviderConnectionsResultSchema
>;

/**
 * What the renderer asks to grant: one capability on one scope, the ID of a
 * repository of the open project or, for `provider.use`, of a provider
 * connection of this device, and a lifetime in seconds or null for none.
 * The main process builds the protocol's request from it and checks it
 * with `GrantCapabilityRequestSchema`.
 *
 * `confirmedHighestRisk` is `true` when the person confirmed a
 * highest-risk capability, `terminal.execute`, in the separate step of the
 * permission screen (ADR 0015, #77), and absent otherwise. The main process
 * refuses a highest-risk capability without it, and a standard one with
 * it, as `invalid`; it is never sent to the API.
 */
export const GrantRequestViewSchema = z.object({
  capability: z.enum(GRANT_CAPABILITIES),
  scopeId: ProtocolIdSchema,
  lifetimeSeconds: z.int().positive().nullable(),
  confirmedHighestRisk: z.literal(true).optional(),
});
export type GrantRequestView = z.infer<typeof GrantRequestViewSchema>;

/**
 * Why a grant was refused:
 *
 * - `invalid`: the scope or the lifetime is outside the protocol's format,
 *   or `confirmedHighestRisk` does not match the capability: a
 *   highest-risk capability without the person's confirmation, or a
 *   standard one with it. Nothing was sent.
 * - `not_open`: the agent is not one of the open project's agents. Nothing
 *   was sent.
 * - `not_grantable`: the account does not own the agent, the agent is
 *   disabled, or this device is not its host device. Nothing was sent.
 * - `busy`: another grant is still waiting for its answer. Nothing was
 *   sent, so that a second press never sends a second grant.
 * - `not_signed_in`, `unavailable`, `too_soon`, `rate_limited`: as for the
 *   other writes; `rate_limited` is also the account's limit of grants in
 *   24 hours, with the server's `Retry-After`.
 * - `forbidden`: the API found that the account does not own the agent or
 *   that this device is not its host device.
 * - `not_found`: the API does not know the agent, the repository in its
 *   project, or the provider connection on its host device.
 * - `conflict`: the agent is disabled, the repository, project, or
 *   workspace archived, the connection removed, or the same capability on
 *   the same scope is granted already and neither revoked nor expired.
 * - `grant_limit`: the agent or this device holds as many grants as it
 *   may; only revoking one frees a place. No wait.
 * - `failed`: the API refused it otherwise.
 */
export const GRANT_CAPABILITY_REFUSALS = Object.freeze([
  "invalid",
  "not_open",
  "not_grantable",
  "busy",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "forbidden",
  "not_found",
  "conflict",
  "grant_limit",
  "failed",
] as const);
export type GrantCapabilityRefusal = (typeof GRANT_CAPABILITY_REFUSALS)[number];

/**
 * The result of a grant: `ok` with the new grant's ID, `refused`, or
 * `unknown` when whether the API granted is not known (no answer, a
 * timeout, or an answer outside its schema). After every request that it
 * sent, whatever the answer, the main process reads its grant records
 * again, so the list shows a grant that was stored.
 */
export const GrantCapabilityResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), grantId: ProtocolIdSchema }),
  createRefusedSchema(GRANT_CAPABILITY_REFUSALS),
  CreateUnknownSchema,
]);
export type GrantCapabilityResult = z.infer<typeof GrantCapabilityResultSchema>;

/**
 * Why a revocation was refused, as for a grant, and:
 *
 * - `not_owner`: the account does not own the agent. Nothing was sent.
 * - `forbidden`: the API found that the account does not own the agent.
 * - `not_found`: the agent does not have the grant.
 * - `conflict`: the grant is already revoked.
 */
export const REVOKE_GRANT_REFUSALS = Object.freeze([
  "invalid",
  "not_open",
  "not_owner",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "forbidden",
  "not_found",
  "conflict",
  "failed",
] as const);
export type RevokeGrantRefusal = (typeof REVOKE_GRANT_REFUSALS)[number];

/** The result of a revocation: `ok`, `refused`, or `unknown`. */
export const RevokeGrantResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok") }),
  createRefusedSchema(REVOKE_GRANT_REFUSALS),
  CreateUnknownSchema,
]);
export type RevokeGrantResult = z.infer<typeof RevokeGrantResultSchema>;

/**
 * Why the grants of an agent that another device hosts could not be read
 * (#345):
 *
 * - `invalid`: the agent ID is not one. Nothing was sent.
 * - `not_open`: the agent is not one of the open project's agents. Nothing
 *   was sent.
 * - `not_owner`: the account does not own the agent. Nothing was sent.
 * - `hosted_here`: this device hosts the agent, so its grants come with
 *   the grant state. Nothing was sent.
 * - `host_unknown`: it is not known which device hosts the agent, because
 *   the server does not send it or this device's key is not ready, so the
 *   agent may be this device's own. Nothing was sent.
 * - `disabled`: the agent is disabled. Nothing was sent.
 * - `not_signed_in`, `unavailable`, `rate_limited`: as for the other reads.
 * - `not_found`: the API does not know the agent, or the account is no
 *   longer a member of its workspace.
 * - `failed`: the API refused it otherwise, for example as `forbidden` for
 *   an account that does not own the agent, or the answer did not fit.
 */
export const AGENT_GRANTS_READ_PROBLEMS = Object.freeze([
  "invalid",
  "not_open",
  "not_owner",
  "hosted_here",
  "host_unknown",
  "disabled",
  "not_signed_in",
  "not_found",
  "rate_limited",
  "unavailable",
  "failed",
] as const);
export type AgentGrantsReadProblem =
  (typeof AGENT_GRANTS_READ_PROBLEMS)[number];

/**
 * The result of reading the grants of an agent that another device hosts:
 * `ok` with the agent's ID and its grants that are not revoked, an expired
 * one included, in the server's order, or `refused` with a problem. Each
 * grant is a `GrantView` of that agent: no account and no host device.
 */
export const AgentGrantsResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ok"),
      agentId: ProtocolIdSchema,
      grants: z.array(GrantViewSchema).max(GRANT_LIMITS.agentGrants).readonly(),
    })
    .refine(
      (result) =>
        result.grants.every((grant) => grant.agentId === result.agentId),
      { message: "Every grant is one of the agent" },
    ),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(AGENT_GRANTS_READ_PROBLEMS),
  }),
]);
export type AgentGrantsResult = z.infer<typeof AgentGrantsResultSchema>;

// Requesting a run of an agent from the project chat (#35).

/**
 * What the renderer asks for a run (#35; the Project Manager's decisions
 * of 2026-11-14 and 2026-11-25): the project that the chat screen shows,
 * one of its agents, a provider connection of this device, and one of the
 * person's own messages of the project's chat as the run's input. IDs
 * only, and no other key: a text, a repository, a state, or a retry key
 * is refused by the contract before the main process sees it. The run has
 * no repository yet; the main process checks every ID against what it
 * holds before anything is sent.
 */
export const RunRequestViewSchema = z.strictObject({
  projectId: ProtocolIdSchema,
  agentId: ProtocolIdSchema,
  providerConnectionId: ProtocolIdSchema,
  inputMessageId: ProtocolIdSchema,
});
export type RunRequestView = z.infer<typeof RunRequestViewSchema>;

/**
 * Why a run request was refused. The first ones are the main process's own
 * checks, and nothing was sent:
 *
 * - `invalid`: an ID is not one, or the request is outside the protocol's
 *   format.
 * - `not_open`: the project is not the open one, or the agent is not one of
 *   its agents.
 * - `not_owner`: the account does not own the agent; only its owner asks
 *   for a run (decision of 2026-11-14).
 * - `not_hosted_here`: this device is not the agent's host device, or it is
 *   not known which device hosts it; only the host device asks (decision
 *   of 2026-11-25).
 * - `disabled`: the agent is disabled.
 * - `message_not_found`: the chat that this device holds for the open
 *   project has no such message.
 * - `not_own_message`: the message is another person's or an agent's; only
 *   the requester's own message is a run's input (decision of
 *   2026-11-25).
 * - `connection_not_here`: the provider connection is not one of this
 *   device's connections as its list holds them now.
 * - `busy`: another run request is still waiting for its answer, so that a
 *   second press never sends a second request.
 *
 * Then the answers of the server, as for the other writes:
 *
 * - `not_signed_in`, `unavailable`, `too_soon`, `rate_limited`: as for the
 *   other writes; `rate_limited` is the account's limit of requests.
 * - `forbidden`: the server found that the account does not own the agent
 *   or that this device is not its host device.
 * - `not_found`: the server does not know the project for the account
 *   (the account is not, or no longer, a member of its workspace, or the
 *   project does not exist), the agent in the project, the connection on
 *   the agent's host device, or the message as the account's own and not
 *   deleted.
 * - `conflict`: the project or its workspace is archived, the agent is
 *   disabled, or the connection is removed.
 * - `run_limit`: the agent has as many unfinished runs as the server
 *   allows (10). No wait: only a run of the agent that finishes frees a
 *   place.
 * - `run_daily_limit`: the agent got as many new runs within 24 hours as
 *   the server allows (100); `retryAfterMs` says when the next may go.
 * - `failed`: the server refused it otherwise.
 */
export const RUN_REQUEST_REFUSALS = Object.freeze([
  "invalid",
  "not_open",
  "not_owner",
  "not_hosted_here",
  "disabled",
  "message_not_found",
  "not_own_message",
  "connection_not_here",
  "busy",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "forbidden",
  "not_found",
  "conflict",
  "run_limit",
  "run_daily_limit",
  "failed",
] as const);
export type RunRequestRefusal = (typeof RUN_REQUEST_REFUSALS)[number];

/**
 * The refusals of a run request that the main process gives from its own
 * checks, before anything is sent. The main process keeps the outcome of
 * every other request (`RunRequestOutcomeSchema`).
 */
export const RUN_REQUEST_LOCAL_REFUSALS: ReadonlySet<RunRequestRefusal> =
  new Set<RunRequestRefusal>([
    "invalid",
    "not_open",
    "not_owner",
    "not_hosted_here",
    "disabled",
    "message_not_found",
    "not_own_message",
    "connection_not_here",
    "busy",
  ]);

/** The refusals of a run request that say when the next request may go. */
const RUN_REQUEST_WAITS: ReadonlySet<string> = new Set([
  "too_soon",
  "rate_limited",
  "run_daily_limit",
]);

/**
 * The result of a run request: `ok` with the new run's ID, which the agent
 * activity shows from then on in `queued`; `refused` with a reason, and
 * `retryAfterMs` for a wait only, null otherwise; or `unknown` when
 * whether the server created the run is not known (no answer, a timeout,
 * or an answer outside its schema or for another request). A request is
 * never sent again on its own: the same request sent again would create a
 * second run.
 */
const RunRequestRefusedSchema = z
  .object({
    outcome: z.literal("refused"),
    reason: z.enum(RUN_REQUEST_REFUSALS),
    retryAfterMs: z.int().positive().nullable(),
  })
  .refine(
    (value) =>
      RUN_REQUEST_WAITS.has(value.reason) === (value.retryAfterMs !== null),
    { message: "Only a wait has a retry time", path: ["retryAfterMs"] },
  );

export const RunRequestResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok"), runId: ProtocolIdSchema }),
  RunRequestRefusedSchema,
  CreateUnknownSchema,
]);
export type RunRequestResult = z.infer<typeof RunRequestResultSchema>;

/**
 * The outcome of a project's last run request as the main process keeps it
 * (#35): what the screen said after the answer, without the run's ID, so
 * that a chat screen opened later says it once. `ok` without an ID, a
 * refusal with its wait counted from the answer and at least 1 ms, or
 * `unknown`. Only a request that passed the main process's own checks is
 * kept (`RUN_REQUEST_LOCAL_REFUSALS`).
 */
export const RunRequestOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("ok") }),
  RunRequestRefusedSchema,
  CreateUnknownSchema,
]);
export type RunRequestOutcome = z.infer<typeof RunRequestOutcomeSchema>;

// The chat of the open project (#27).

/**
 * Limits of the chat messages:
 *
 * - `messages` and `pending`: the number of held messages and of waiting
 *   messages in one view. `pending` is the chat service's
 *   `MAX_PENDING_CHAT_MESSAGES`.
 * - `body` and `authorName`: the length of a message body and of an
 *   author's name in characters (code points), the protocol's
 *   `LIMITS.messageBody` and `LIMITS.displayName`.
 * - `text`: the budget of body text in one view, in UTF-16 code units, the
 *   unit that IPC carries a string in (at most two bytes each), so one view
 *   holds at most about 1 MB of body text, whatever waits. The newest held
 *   messages may take up to half of it first, then the waiting messages,
 *   in order, which keep at least the other half, then more held messages;
 *   so the newest held message and the first waiting message always show.
 *   What does not fit is left out and counted.
 * - `sendText`: the length of a text that the renderer sends, in
 *   characters. The main process prepares the body with the protocol's
 *   rules and answers `too_long` above `body`; this limit only bounds the
 *   message.
 *
 * The shared contract does not import the protocol package, so the main
 * process's tests check that the values match.
 */
export const CHAT_LIMITS = Object.freeze({
  messages: 1_000,
  pending: MAX_WAITING_CHAT_MESSAGES,
  body: 16_000,
  authorName: 64,
  text: 500_000,
  sendText: 64_000,
});

/**
 * The states of the chat service: `no_project` while no project is open,
 * `loading` until the open project's newest page loaded, `ready`, and
 * `unavailable` after the last load of the newest page failed, until a
 * reload succeeds.
 */
export const CHAT_STATUSES = Object.freeze([
  "no_project",
  "loading",
  "ready",
  "unavailable",
] as const);
export type ChatStatusView = (typeof CHAT_STATUSES)[number];

/** Why the chat or an older page did not load: the failure of the read. */
export const CHAT_PROBLEMS = Object.freeze([
  "not_signed_in",
  "not_found",
  "rate_limited",
  "unavailable",
  "failed",
] as const);
export type ChatProblem = (typeof CHAT_PROBLEMS)[number];

/** Who wrote a message: a person of the workspace, or an agent. */
export const CHAT_AUTHOR_KINDS = Object.freeze(["member", "agent"] as const);

/**
 * Why a message shows as not sent: the code of the server's refusal, or
 * `not_sendable` when the connection client refused to send it.
 */
export const CHAT_NOT_SENT_REASONS = Object.freeze([
  "not_found",
  "conflict",
  "rate_limited",
  "not_sendable",
] as const);
export type ChatNotSentReasonView = (typeof CHAT_NOT_SENT_REASONS)[number];

/**
 * A message body that crosses IPC. The main process checked every body with
 * the protocol's rules before it held it, so the schema bounds its length
 * only, and no pattern runs over every body on every publish. zod counts
 * code points only for a string longer than the limit in UTF-16 code
 * units, so the check is cheap.
 */
const ChatBodySchema = z.string().min(1).max(CHAT_LIMITS.body);

/**
 * A message of the open project's chat. Its author crosses as the kind and
 * the display name that the main process resolved, never as a member ID or
 * an agent ID.
 */
export const ChatMessageViewSchema = z.object({
  id: ProtocolIdSchema,
  /** The message's number in the project's chat, from 1. */
  seq: z.int().positive(),
  authorKind: z.enum(CHAT_AUTHOR_KINDS),
  authorName: z.string().min(1).max(CHAT_LIMITS.authorName),
  /**
   * Whether the signed-in account's own person wrote the message (#35):
   * only such a message can be the input of a run that the account asks
   * for. The main process compares the author with the account's person
   * and sends the answer as a flag, never the member ID.
   */
  writtenByMe: z.boolean(),
  body: ChatBodySchema,
  createdAt: TimestampSchema,
});
export type ChatMessageView = z.infer<typeof ChatMessageViewSchema>;

/**
 * One of the person's messages that the server has not stored yet, by the
 * event ID that `retry` and `discard` take: `waiting` for the connection or
 * for its next try, `sending`, or `not_sent` with a reason.
 */
export const ChatPendingViewSchema = z.discriminatedUnion("status", [
  z.object({
    eventId: ProtocolIdSchema,
    body: ChatBodySchema,
    status: z.enum(["waiting", "sending"]),
  }),
  z.object({
    eventId: ProtocolIdSchema,
    body: ChatBodySchema,
    status: z.literal("not_sent"),
    reason: z.enum(CHAT_NOT_SENT_REASONS),
  }),
]);
export type ChatPendingView = z.infer<typeof ChatPendingViewSchema>;

/**
 * Whether older messages can be shown: `none` when the view shows the whole
 * chat, `available` when `loadOlder` can load the page before the held
 * messages, `loading` while one is on its way, and `not_shown` when older
 * messages exist but the view is full, so that loading more would show
 * nothing more.
 */
export const CHAT_OLDER_STATES = Object.freeze([
  "none",
  "available",
  "loading",
  "not_shown",
] as const);
export type ChatOlderState = (typeof CHAT_OLDER_STATES)[number];

const ChatViewFields = {
  /**
   * Grows by one with every change, also when only an author's name
   * changed. A receiver keeps the view with the highest revision, like the
   * runtime status.
   */
  revision: z.int().nonnegative(),
  /** The selected workspace while a project is open, else null. */
  workspaceId: ProtocolIdSchema.nullable(),
  projectId: ProtocolIdSchema.nullable(),
  /** The newest held messages that fit the view, the oldest first. */
  messages: z.array(ChatMessageViewSchema).max(CHAT_LIMITS.messages).readonly(),
  /** How many older held messages `messages` leaves out. */
  moreMessages: z.int().nonnegative(),
  older: z.enum(CHAT_OLDER_STATES),
  /** Why the last older page did not load, until the next one is asked for. */
  olderProblem: z.enum(CHAT_PROBLEMS).optional(),
  /** The first of the person's waiting messages, in the order written. */
  pending: z.array(ChatPendingViewSchema).max(CHAT_LIMITS.pending).readonly(),
  /** How many later waiting messages `pending` leaves out. */
  morePending: z.int().nonnegative(),
};

/**
 * What the renderer may know of the open project's chat: `{ revision,
 * status, problem?, workspaceId, projectId, messages, moreMessages, older,
 * olderProblem?, pending, morePending }`, with a problem only while
 * `unavailable`. It holds IDs, names, bodies, and times only: no member ID,
 * user ID, device ID, or anything secret. `pending.length + morePending` is
 * the number of messages that a switch would discard.
 */
export const ChatViewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["no_project", "loading", "ready"]),
    ...ChatViewFields,
  }),
  z.object({
    status: z.literal("unavailable"),
    problem: z.enum(CHAT_PROBLEMS),
    ...ChatViewFields,
  }),
]);
export type ChatView = z.infer<typeof ChatViewSchema>;

/** A text that the renderer sends as a message. */
export const ChatSendTextSchema = z.string().max(CHAT_LIMITS.sendText);

/**
 * Why a message was not accepted: `blank`, `too_long`, or
 * `invalid_characters` for a body that the protocol refuses,
 * `too_many_pending` while `CHAT_LIMITS.pending` messages wait, and
 * `no_project` without an open project or a signed-in device.
 */
export const CHAT_SEND_REFUSALS = Object.freeze([
  "blank",
  "too_long",
  "invalid_characters",
  "too_many_pending",
  "no_project",
] as const);
export type ChatSendRefusal = (typeof CHAT_SEND_REFUSALS)[number];

/**
 * The result of a send: `accepted` with the event ID under which the
 * message waits in `pending` until the server stores it, or `refused`, and
 * nothing is kept.
 */
export const ChatSendResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted"), eventId: ProtocolIdSchema }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(CHAT_SEND_REFUSALS),
  }),
]);
export type ChatSendResultView = z.infer<typeof ChatSendResultSchema>;

/**
 * The result of `loadOlder`: `started`, `busy` while a page is on its way,
 * `none` when nothing older can be loaded and shown, or `too_soon` within
 * the backoff after an older page did not load.
 */
export const CHAT_LOAD_OLDER_RESULTS = Object.freeze([
  "started",
  "busy",
  "none",
  "too_soon",
] as const);
export const ChatLoadOlderResultSchema = z.enum(CHAT_LOAD_OLDER_RESULTS);
export type ChatLoadOlderResultView = z.infer<typeof ChatLoadOlderResultSchema>;

// The account's devices (#95, decisions D4 and D5b of 2026-11-06).

/**
 * Limits of the device list message: the number of devices, the most that
 * one answer of the API holds (the protocol's `MAX_ANSWER_LIST_ITEMS`); the
 * length of a device label in characters (code points, which zod counts
 * like the protocol's `LIMITS.deviceLabel`); and the number of notices of
 * new devices, the most new devices that an account registers in 24 hours.
 * The main process sends no more than these and cuts a longer label. The
 * shared contract does not import the protocol package, so the main
 * process's tests check that the values match.
 */
export const DEVICE_LIST_LIMITS = Object.freeze({
  devices: 1_000,
  label: 64,
  newDevices: 10,
});

/**
 * The states of the device list service: `signed_out` without a signed-in
 * device with a ready key, `loading` until the list loaded once for this
 * device, `ready`, and `unavailable` after a failed load, until a load
 * succeeds.
 */
export const DEVICE_LIST_STATUSES = Object.freeze([
  "signed_out",
  "loading",
  "ready",
  "unavailable",
] as const);
export type DeviceListStatusView = (typeof DEVICE_LIST_STATUSES)[number];

/** Why the device list is `unavailable`: the failure of the last load. */
export const DEVICE_LIST_PROBLEMS = Object.freeze([
  "not_signed_in",
  "rate_limited",
  "unavailable",
  "failed",
] as const);
export type DeviceListProblem = (typeof DEVICE_LIST_PROBLEMS)[number];

/** The platforms of a device, like the protocol's `DEVICE_PLATFORMS`. */
export const DEVICE_PLATFORMS = Object.freeze([
  "windows",
  "macos",
  "linux",
] as const);
export type DevicePlatformView = (typeof DEVICE_PLATFORMS)[number];

const DeviceLabelSchema = z.string().min(1).max(DEVICE_LIST_LIMITS.label);

/**
 * One device of the account, as the device list shows it. Its ID crosses as
 * a typed string, because the device actions name the device by it
 * (D1). `current` marks the device of this installation. It holds no user
 * ID, key, or token.
 */
export const DeviceViewSchema = z.object({
  id: ProtocolIdSchema,
  label: DeviceLabelSchema,
  platform: z.enum(DEVICE_PLATFORMS),
  createdAt: TimestampSchema,
  /** null until the device first connects. */
  lastSeenAt: TimestampSchema.nullable(),
  lastSignInAt: TimestampSchema,
  /** 30 days after the last sign-in. */
  signInExpiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
  current: z.boolean(),
});
export type DeviceView = z.infer<typeof DeviceViewSchema>;

/**
 * A new device of the account, from the live `account.device_registered`
 * frame (D4), until the person dismisses the notice.
 */
export const NewDeviceNoticeSchema = z.object({
  id: ProtocolIdSchema,
  label: DeviceLabelSchema,
  platform: z.enum(DEVICE_PLATFORMS),
  createdAt: TimestampSchema,
});
export type NewDeviceNoticeView = z.infer<typeof NewDeviceNoticeSchema>;

const DeviceListViewFields = {
  /**
   * Grows by one with every change. A receiver keeps the state with the
   * highest revision, like the runtime status.
   */
  revision: z.int().nonnegative(),
  /** In the server's order, the most recently created first. */
  devices: z.array(DeviceViewSchema).max(DEVICE_LIST_LIMITS.devices).readonly(),
  /**
   * The end of the account's registration lock while the last list said it
   * was in force (D5b), in UTC; otherwise null.
   */
  registrationLockedUntil: TimestampSchema.nullable(),
  /** The notices of new devices, the oldest first. */
  newDevices: z
    .array(NewDeviceNoticeSchema)
    .max(DEVICE_LIST_LIMITS.newDevices)
    .readonly(),
  /**
   * Whether the advice after a revocation as lost shows (ADR 0014; the
   * Project Manager's decision of 2026-11-09): from such a revocation of
   * this device's account until the person dismisses it, a sign-out, or
   * another account or device.
   */
  lostDeviceAdvice: z.boolean(),
};

/**
 * What the renderer may know of the device list service's state:
 * `{ revision, status, problem?, devices, registrationLockedUntil,
 * newDevices, lostDeviceAdvice }`, with a problem only while `unavailable`.
 * It holds device IDs, labels, platforms, times, and a flag only: no user
 * ID and nothing secret.
 */
export const DeviceListViewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["signed_out", "loading", "ready"]),
    ...DeviceListViewFields,
  }),
  z.object({
    status: z.literal("unavailable"),
    problem: z.enum(DEVICE_LIST_PROBLEMS),
    ...DeviceListViewFields,
  }),
]);
export type DeviceListView = z.infer<typeof DeviceListViewSchema>;

/**
 * Why the device list was not loaded on the renderer's request:
 * `not_signed_in` without a signed-in device with a ready key, and
 * `too_soon` within a few seconds of the last request.
 */
export const DEVICE_LIST_LOAD_REFUSALS = Object.freeze([
  "not_signed_in",
  "too_soon",
] as const);

/**
 * The devices whose notices the renderer showed and the person dismissed
 * (the Project Manager's decision of 2026-11-09): 1 to `newDevices` device
 * IDs, each a lowercase UUIDv7. A notice that arrived after the last state
 * that the renderer showed is not named, so it stays.
 */
export const DismissedDevicesSchema = z
  .array(ProtocolIdSchema)
  .min(1)
  .max(DEVICE_LIST_LIMITS.newDevices);

/** The result of `devices:load`: `loading`, or `refused` with a reason. */
export const DeviceListLoadResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("loading") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(DEVICE_LIST_LOAD_REFUSALS),
  }),
]);
export type DeviceListLoadResult = z.infer<typeof DeviceListLoadResultSchema>;

/**
 * How the person revokes another device of the account (#95; ADR 0014,
 * "Revocation, sign-out, and recovery"): `removed`, which starts no lock, or
 * `lost`, which starts the account's 7-day registration lock. The API's
 * revoke route takes both for another device; `replaced` and
 * `account_erased` are the server's own reasons.
 */
export const OTHER_DEVICE_REVOCATIONS = Object.freeze([
  "removed",
  "lost",
] as const);
export type OtherDeviceRevocation = (typeof OTHER_DEVICE_REVOCATIONS)[number];

/**
 * Why a revocation of another device was not taken, before the person was
 * asked:
 *
 * - `unavailable`: a sign-in, a sign-out, a removal of this device, "This is
 *   not me", an unlock, or another device action runs, or the key loads;
 * - `not_signed_in`: no device of this installation is signed in;
 * - `current_device`: the device is this installation's own, which "Remove
 *   this device" removes;
 * - `not_listed`: the device is not an active device of the list that the
 *   main process holds.
 */
export const REVOKE_DEVICE_REFUSALS = Object.freeze([
  "unavailable",
  "not_signed_in",
  "current_device",
  "not_listed",
] as const);

/**
 * Why lifting the registration lock was not taken, before the person was
 * asked: `unavailable` and `not_signed_in` as for a revocation, and
 * `no_lock` when the last list that the main process holds reported no
 * lock.
 */
export const LIFT_REGISTRATION_LOCK_REFUSALS = Object.freeze([
  "unavailable",
  "not_signed_in",
  "no_lock",
] as const);

/**
 * Why a device action of the device list failed after the person confirmed
 * it, as a fixed code: the codes of `DEVICE_ACTION_FAILURES` without the
 * uncertain answers, and the revoke route's `not_found` and `conflict`. An
 * uncertain answer (no answer, a `5xx`, or an answer that cannot be read) is
 * the outcome `unknown` instead, because whether the server acted is not
 * known; it is never sent again on its own.
 */
export const DEVICE_LIST_ACTION_FAILURES = Object.freeze([
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
  "record_not_saved",
  "sign_in_required",
  "auth_failed",
  "device_revoked",
  "device_account_mismatch",
  "rate_limited",
  "not_found",
  "conflict",
  "refused",
  "failed",
] as const);
export type DeviceListActionFailure =
  (typeof DEVICE_LIST_ACTION_FAILURES)[number];

const DeviceListActionFailedSchema = z.object({
  outcome: z.literal("failed"),
  reason: z.enum(DEVICE_LIST_ACTION_FAILURES),
});

/**
 * The result of revoking another device: `revoked` with the reason when the
 * API confirmed it, `cancelled` when the person kept the device in the
 * native confirmation, `unknown` when the answer does not show whether the
 * API revoked it, or `refused` or `failed` with a code.
 */
export const RevokeOtherDeviceResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("revoked"),
    reason: z.enum(OTHER_DEVICE_REVOCATIONS),
  }),
  z.object({ outcome: z.literal("cancelled") }),
  z.object({ outcome: z.literal("unknown") }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(REVOKE_DEVICE_REFUSALS),
  }),
  DeviceListActionFailedSchema,
]);
export type RevokeOtherDeviceResult = z.infer<
  typeof RevokeOtherDeviceResultSchema
>;

/**
 * The result of lifting the registration lock: `lifted` when the API
 * confirmed it, `cancelled`, `unknown`, `refused`, or `failed`, as for a
 * revocation.
 */
export const LiftRegistrationLockResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("lifted") }),
    z.object({ outcome: z.literal("cancelled") }),
    z.object({ outcome: z.literal("unknown") }),
    z.object({
      outcome: z.literal("refused"),
      reason: z.enum(LIFT_REGISTRATION_LOCK_REFUSALS),
    }),
    DeviceListActionFailedSchema,
  ],
);
export type LiftRegistrationLockResult = z.infer<
  typeof LiftRegistrationLockResultSchema
>;

// This device's AI provider connections (#32; #295 and the Project
// Manager's decisions of 2026-11-20 and 2026-11-23): their metadata and a
// status, never a credential.

/**
 * Limits of the provider connection messages: the connections of one view,
 * the most that one answer of the API holds (the protocol's
 * `MAX_ANSWER_LIST_ITEMS`; a device holds at most 10), and a label in
 * characters (code points), the protocol's `LIMITS.providerConnectionLabel`.
 * The main process's tests check that the values match.
 */
export const PROVIDER_CONNECTION_LIMITS = Object.freeze({
  connections: 1_000,
  label: 64,
});

/**
 * The status of one connection, which the main process computes from a
 * closed list (a default until the Project Manager decides, 2026-11-24):
 *
 * - `registered`: the server lists the connection, and this device checks
 *   no local credential yet (#33);
 * - `unknown`: this device is offline, or the last read of the list
 *   failed, so the connection is shown as it was last read.
 *
 * The local credential check of #33 adds its own statuses here, such as
 * `credential_missing`, `ready`, and `check_failed`. A status check is the
 * person acting on their own device: it is never a `provider.use` action
 * and needs no grant.
 */
export const PROVIDER_CONNECTION_STATUSES = Object.freeze([
  "registered",
  "unknown",
] as const);
export type ProviderConnectionStatusView =
  (typeof PROVIDER_CONNECTION_STATUSES)[number];

/**
 * The states of the provider connection list: `signed_out` without a
 * signed-in device with a ready key, `loading` until the list loaded once
 * for this device, `ready`, and `unavailable` after a failed read, until a
 * read succeeds.
 */
export const PROVIDER_CONNECTION_LIST_STATUSES = Object.freeze([
  "signed_out",
  "loading",
  "ready",
  "unavailable",
] as const);
export type ProviderConnectionListStatusView =
  (typeof PROVIDER_CONNECTION_LIST_STATUSES)[number];

/** Why the provider connection list is `unavailable`: the failed read. */
export const PROVIDER_CONNECTION_LIST_PROBLEMS = Object.freeze([
  "not_signed_in",
  "rate_limited",
  "unavailable",
  "failed",
] as const);
export type ProviderConnectionListProblem =
  (typeof PROVIDER_CONNECTION_LIST_PROBLEMS)[number];

const ProviderConnectionLabelSchema = z
  .string()
  .min(1)
  .max(PROVIDER_CONNECTION_LIMITS.label);

/**
 * One connection of this device as the Account screen shows it: its ID,
 * kind, label, when it was registered, and its status. Nothing else
 * crosses: no device, no account, and no credential.
 */
export const ProviderConnectionItemSchema = z.object({
  id: ProtocolIdSchema,
  kind: z.enum(PROVIDER_KIND_VIEWS),
  label: ProviderConnectionLabelSchema,
  createdAt: TimestampSchema,
  status: z.enum(PROVIDER_CONNECTION_STATUSES),
});
export type ProviderConnectionItemView = z.infer<
  typeof ProviderConnectionItemSchema
>;

const ProviderConnectionListFields = {
  /** Grows by one with every change. The highest revision wins. */
  revision: z.int().nonnegative(),
  /** In the server's order, the oldest first. */
  connections: z
    .array(ProviderConnectionItemSchema)
    .max(PROVIDER_CONNECTION_LIMITS.connections)
    .readonly(),
};

/**
 * What the renderer may know of this device's provider connections:
 * `{ revision, status, problem?, connections }`, with a problem only while
 * `unavailable`. What was read before stays while a read fails, each
 * connection then `unknown`.
 */
export const ProviderConnectionListViewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["signed_out", "loading", "ready"]),
    ...ProviderConnectionListFields,
  }),
  z.object({
    status: z.literal("unavailable"),
    problem: z.enum(PROVIDER_CONNECTION_LIST_PROBLEMS),
    ...ProviderConnectionListFields,
  }),
]);
export type ProviderConnectionListView = z.infer<
  typeof ProviderConnectionListViewSchema
>;

/**
 * What the renderer asks to register: a kind and a label, and no other
 * key, so that nothing such as a credential travels beside them. The main
 * process checks the label with the protocol's rules before it sends it.
 */
export const RegisterProviderConnectionViewSchema = z.strictObject({
  kind: z.enum(PROVIDER_KIND_VIEWS),
  label: ProviderConnectionLabelSchema,
});
export type RegisterProviderConnectionView = z.infer<
  typeof RegisterProviderConnectionViewSchema
>;

/**
 * Why a registration was refused:
 *
 * - `invalid`: the label is outside the protocol's text rule, for example
 *   blank or with a line break. Nothing was sent.
 * - `busy`: another registration or removal is still waiting for its
 *   answer. Nothing was sent, so that a second press never sends a second
 *   write.
 * - `not_signed_in`, `unavailable`, `too_soon`, `rate_limited`: as for the
 *   other writes; `rate_limited` is also the account's limit of
 *   registrations in 24 hours, with the server's `Retry-After`.
 * - `provider_connection_limit`: this device holds as many connections as
 *   it may; only removing one frees a place. No wait.
 * - `failed`: the API refused it otherwise.
 */
export const REGISTER_PROVIDER_CONNECTION_REFUSALS = Object.freeze([
  "invalid",
  "busy",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "provider_connection_limit",
  "failed",
] as const);
export type RegisterProviderConnectionRefusal =
  (typeof REGISTER_PROVIDER_CONNECTION_REFUSALS)[number];

/**
 * The result of a registration: `ok`, `refused`, or `unknown` when whether
 * the API registered it is not known. After every request that it sent,
 * whatever the answer, the main process reads the list again.
 */
export const RegisterProviderConnectionResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("ok") }),
    createRefusedSchema(REGISTER_PROVIDER_CONNECTION_REFUSALS),
    CreateUnknownSchema,
  ],
);
export type RegisterProviderConnectionResult = z.infer<
  typeof RegisterProviderConnectionResultSchema
>;

/**
 * Why a removal was refused, as for a registration, and:
 *
 * - `not_listed`: the connection is not in the list that the main process
 *   holds. Nothing was sent.
 * - `not_found`: the server does not know the connection on this device.
 * - `conflict`: the connection is already removed.
 */
export const REMOVE_PROVIDER_CONNECTION_REFUSALS = Object.freeze([
  "invalid",
  "busy",
  "not_listed",
  "not_signed_in",
  "unavailable",
  "too_soon",
  "rate_limited",
  "not_found",
  "conflict",
  "failed",
] as const);
export type RemoveProviderConnectionRefusal =
  (typeof REMOVE_PROVIDER_CONNECTION_REFUSALS)[number];

/**
 * The result of a removal: `ok`, `refused`, or `unknown`. The server
 * revokes the connection's `provider.use` grants with it.
 */
export const RemoveProviderConnectionResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("ok") }),
    createRefusedSchema(REMOVE_PROVIDER_CONNECTION_REFUSALS),
    CreateUnknownSchema,
  ],
);
export type RemoveProviderConnectionResult = z.infer<
  typeof RemoveProviderConnectionResultSchema
>;

/** The schemas of every invoke channel. */
export const INVOKE_CONTRACT = Object.freeze({
  [INVOKE_CHANNELS.getRuntimeStatus]: Object.freeze({
    args: NoArgumentsSchema,
    result: RuntimeStatusSchema,
  }),
  [INVOKE_CHANNELS.subscribeRuntimeStatus]: Object.freeze({
    args: NoArgumentsSchema,
    result: RuntimeStatusSchema,
  }),
  [INVOKE_CHANNELS.listRepositories]: Object.freeze({
    args: NoArgumentsSchema,
    result: RepositoryListSchema,
  }),
  [INVOKE_CHANNELS.subscribeRepositories]: Object.freeze({
    args: NoArgumentsSchema,
    result: RepositoryListSchema,
  }),
  [INVOKE_CHANNELS.mountRepository]: Object.freeze({
    args: NoArgumentsSchema,
    result: MountResultSchema,
  }),
  [INVOKE_CHANNELS.unmountRepository]: Object.freeze({
    args: z.tuple([MountIdSchema]),
    /** True when the repository was mounted. */
    result: z.boolean(),
  }),
  [INVOKE_CHANNELS.getProjectRepositoryState]: Object.freeze({
    args: NoArgumentsSchema,
    result: ProjectRepositoriesViewSchema,
  }),
  [INVOKE_CHANNELS.subscribeProjectRepositoryState]: Object.freeze({
    args: NoArgumentsSchema,
    result: ProjectRepositoriesViewSchema,
  }),
  [INVOKE_CHANNELS.registerRepository]: Object.freeze({
    /**
     * The open project's ID and the name, 1 to 100 characters; the main
     * process checks it with the protocol's rules, which refuse a slash and
     * a backslash.
     */
    args: z.tuple([ProtocolIdSchema, NewNameSchema]),
    result: RegisterRepositoryResultSchema,
  }),
  [INVOKE_CHANNELS.removeRepository]: Object.freeze({
    /** The open project's ID and the repository's ID. */
    args: z.tuple([ProtocolIdSchema, ProtocolIdSchema]),
    result: RemoveRepositoryResultSchema,
  }),
  [INVOKE_CHANNELS.linkRepository]: Object.freeze({
    /**
     * The repository's ID and the mount ID; never a path. The main process
     * asks the person to confirm before it links anything.
     */
    args: z.tuple([ProtocolIdSchema, MountIdSchema]),
    result: LinkRepositoryResultSchema,
  }),
  [INVOKE_CHANNELS.unlinkRepository]: Object.freeze({
    /** The repository's ID. */
    args: z.tuple([ProtocolIdSchema]),
    result: UnlinkRepositoryResultSchema,
  }),
  [INVOKE_CHANNELS.getAccountStatus]: Object.freeze({
    args: NoArgumentsSchema,
    result: AccountStatusSchema,
  }),
  [INVOKE_CHANNELS.subscribeAccountStatus]: Object.freeze({
    args: NoArgumentsSchema,
    result: AccountStatusSchema,
  }),
  [INVOKE_CHANNELS.startSignIn]: Object.freeze({
    /** None, which opens the default browser, or the option of the start. */
    args: z.union([NoArgumentsSchema, z.tuple([StartSignInOptionsSchema])]),
    result: StartSignInResultSchema,
  }),
  [INVOKE_CHANNELS.cancelSignIn]: Object.freeze({
    args: NoArgumentsSchema,
    /** True when a sign-in was open or starting. */
    result: z.boolean(),
  }),
  [INVOKE_CHANNELS.unlockDeviceKey]: Object.freeze({
    args: z.tuple([PassphraseSchema]),
    result: UnlockResultSchema,
  }),
  [INVOKE_CHANNELS.forgetAccount]: Object.freeze({
    args: NoArgumentsSchema,
    result: ForgetResultSchema,
  }),
  [INVOKE_CHANNELS.signOut]: Object.freeze({
    args: NoArgumentsSchema,
    result: SignOutResultSchema,
  }),
  [INVOKE_CHANNELS.removeDevice]: Object.freeze({
    args: NoArgumentsSchema,
    result: RemoveDeviceResultSchema,
  }),
  [INVOKE_CHANNELS.getConnectionStatus]: Object.freeze({
    args: NoArgumentsSchema,
    result: ConnectionStatusSchema,
  }),
  [INVOKE_CHANNELS.subscribeConnectionStatus]: Object.freeze({
    args: NoArgumentsSchema,
    result: ConnectionStatusSchema,
  }),
  [INVOKE_CHANNELS.reconnect]: Object.freeze({
    args: NoArgumentsSchema,
    result: ReconnectResultSchema,
  }),
  [INVOKE_CHANNELS.getWorkspaceState]: Object.freeze({
    args: NoArgumentsSchema,
    result: WorkspaceViewSchema,
  }),
  [INVOKE_CHANNELS.subscribeWorkspaceState]: Object.freeze({
    args: NoArgumentsSchema,
    result: WorkspaceViewSchema,
  }),
  [INVOKE_CHANNELS.selectWorkspace]: Object.freeze({
    /** A workspace ID, and the option of the switch. */
    args: z.union([
      z.tuple([ProtocolIdSchema]),
      z.tuple([ProtocolIdSchema, WorkspaceSwitchOptionsSchema]),
    ]),
    result: WorkspaceActionResultSchema,
  }),
  [INVOKE_CHANNELS.openProject]: Object.freeze({
    /** A project ID, or null to close the open project, and the option. */
    args: z.union([
      z.tuple([ProtocolIdSchema.nullable()]),
      z.tuple([ProtocolIdSchema.nullable(), WorkspaceSwitchOptionsSchema]),
    ]),
    result: WorkspaceActionResultSchema,
  }),
  [INVOKE_CHANNELS.createWorkspace]: Object.freeze({
    /** The new workspace's name. */
    args: z.tuple([NewNameSchema]),
    result: CreateWorkspaceResultSchema,
  }),
  [INVOKE_CHANNELS.createProject]: Object.freeze({
    /** The selected workspace's ID and the new project's name. */
    args: z.tuple([ProtocolIdSchema, NewNameSchema]),
    result: CreateProjectResultSchema,
  }),
  [INVOKE_CHANNELS.copyWorkspaceId]: Object.freeze({
    /** The ID of a workspace of the account's list. */
    args: z.tuple([ProtocolIdSchema]),
    result: CopyWorkspaceIdResultSchema,
  }),
  [INVOKE_CHANNELS.getPeopleState]: Object.freeze({
    args: NoArgumentsSchema,
    result: PeopleViewSchema,
  }),
  [INVOKE_CHANNELS.subscribePeopleState]: Object.freeze({
    args: NoArgumentsSchema,
    result: PeopleViewSchema,
  }),
  [INVOKE_CHANNELS.definePerson]: Object.freeze({
    /** The selected workspace's ID and the new person's display name. */
    args: z.tuple([ProtocolIdSchema, PersonNameSchema]),
    result: DefinePersonResultSchema,
  }),
  [INVOKE_CHANNELS.renamePerson]: Object.freeze({
    /** The workspace ID, the person's member ID, and the new name. */
    args: z.tuple([ProtocolIdSchema, ProtocolIdSchema, PersonNameSchema]),
    result: PersonActionResultSchema,
  }),
  [INVOKE_CHANNELS.removePerson]: Object.freeze({
    /** The workspace ID and the person's member ID. */
    args: z.tuple([ProtocolIdSchema, ProtocolIdSchema]),
    result: PersonActionResultSchema,
  }),
  [INVOKE_CHANNELS.promotePerson]: Object.freeze({
    args: z.tuple([ProtocolIdSchema, ProtocolIdSchema]),
    result: PersonActionResultSchema,
  }),
  [INVOKE_CHANNELS.demotePerson]: Object.freeze({
    args: z.tuple([ProtocolIdSchema, ProtocolIdSchema]),
    result: PersonActionResultSchema,
  }),
  [INVOKE_CHANNELS.leaveWorkspace]: Object.freeze({
    /** The workspace ID. */
    args: z.tuple([ProtocolIdSchema]),
    result: PersonActionResultSchema,
  }),
  [INVOKE_CHANNELS.offerOwnership]: Object.freeze({
    /** The workspace ID and the target's member ID. */
    args: z.tuple([ProtocolIdSchema, ProtocolIdSchema]),
    result: PersonActionResultSchema,
  }),
  [INVOKE_CHANNELS.withdrawOwnershipOffer]: Object.freeze({
    args: z.tuple([ProtocolIdSchema]),
    result: PersonActionResultSchema,
  }),
  [INVOKE_CHANNELS.acceptOwnershipOffer]: Object.freeze({
    args: z.tuple([ProtocolIdSchema]),
    result: PersonActionResultSchema,
  }),
  [INVOKE_CHANNELS.getInvitationState]: Object.freeze({
    args: NoArgumentsSchema,
    result: InvitationsViewSchema,
  }),
  [INVOKE_CHANNELS.subscribeInvitationState]: Object.freeze({
    args: NoArgumentsSchema,
    result: InvitationsViewSchema,
  }),
  [INVOKE_CHANNELS.loadInvitations]: Object.freeze({
    args: NoArgumentsSchema,
    result: InvitationLoadResultSchema,
  }),
  [INVOKE_CHANNELS.createInvitation]: Object.freeze({
    /**
     * The selected workspace's ID, the unclaimed person's member ID, and
     * the lifetime in seconds, or null for the API's default.
     */
    args: z.tuple([
      ProtocolIdSchema,
      ProtocolIdSchema,
      InvitationLifetimeSchema.nullable(),
    ]),
    result: CreateInvitationResultSchema,
  }),
  [INVOKE_CHANNELS.revokeInvitation]: Object.freeze({
    /** The selected workspace's ID and the invitation's ID. */
    args: z.tuple([ProtocolIdSchema, ProtocolIdSchema]),
    result: RevokeInvitationResultSchema,
  }),
  [INVOKE_CHANNELS.previewInvitation]: Object.freeze({
    /** The pasted code. */
    args: z.tuple([InvitationCodeTextSchema]),
    result: PreviewInvitationResultSchema,
  }),
  [INVOKE_CHANNELS.acceptInvitation]: Object.freeze({
    /** The pasted code. */
    args: z.tuple([InvitationCodeTextSchema]),
    result: AcceptInvitationResultSchema,
  }),
  [INVOKE_CHANNELS.getJoinRequestState]: Object.freeze({
    args: NoArgumentsSchema,
    result: JoinRequestsViewSchema,
  }),
  [INVOKE_CHANNELS.subscribeJoinRequestState]: Object.freeze({
    args: NoArgumentsSchema,
    result: JoinRequestsViewSchema,
  }),
  [INVOKE_CHANNELS.loadJoinRequests]: Object.freeze({
    args: NoArgumentsSchema,
    result: JoinRequestLoadResultSchema,
  }),
  [INVOKE_CHANNELS.approveJoinRequest]: Object.freeze({
    /**
     * The selected workspace's ID, the request's ID, and the display name
     * of the new person, or null for the requested one.
     */
    args: z.tuple([
      ProtocolIdSchema,
      ProtocolIdSchema,
      PersonNameSchema.nullable(),
    ]),
    result: ApproveJoinRequestResultSchema,
  }),
  [INVOKE_CHANNELS.denyJoinRequest]: Object.freeze({
    /** The selected workspace's ID and the request's ID. */
    args: z.tuple([ProtocolIdSchema, ProtocolIdSchema]),
    result: JoinRequestActionResultSchema,
  }),
  [INVOKE_CHANNELS.denyAllJoinRequests]: Object.freeze({
    /** The selected workspace's ID. */
    args: z.tuple([ProtocolIdSchema]),
    result: JoinRequestActionResultSchema,
  }),
  [INVOKE_CHANNELS.blockJoinRequest]: Object.freeze({
    args: z.tuple([ProtocolIdSchema, ProtocolIdSchema]),
    result: JoinRequestActionResultSchema,
  }),
  [INVOKE_CHANNELS.unblockJoinRequest]: Object.freeze({
    args: z.tuple([ProtocolIdSchema, ProtocolIdSchema]),
    result: JoinRequestActionResultSchema,
  }),
  [INVOKE_CHANNELS.pauseJoinRequests]: Object.freeze({
    args: z.tuple([ProtocolIdSchema]),
    result: JoinRequestActionResultSchema,
  }),
  [INVOKE_CHANNELS.resumeJoinRequests]: Object.freeze({
    args: z.tuple([ProtocolIdSchema]),
    result: JoinRequestActionResultSchema,
  }),
  [INVOKE_CHANNELS.getOwnJoinRequestState]: Object.freeze({
    args: NoArgumentsSchema,
    result: OwnJoinRequestsViewSchema,
  }),
  [INVOKE_CHANNELS.subscribeOwnJoinRequestState]: Object.freeze({
    args: NoArgumentsSchema,
    result: OwnJoinRequestsViewSchema,
  }),
  [INVOKE_CHANNELS.loadOwnJoinRequests]: Object.freeze({
    args: NoArgumentsSchema,
    result: OwnJoinRequestLoadResultSchema,
  }),
  [INVOKE_CHANNELS.createJoinRequest]: Object.freeze({
    /**
     * The workspace's ID, as the person typed it, and the requested display
     * name, or null for the account's display name.
     */
    args: z.tuple([ProtocolIdSchema, PersonNameSchema.nullable()]),
    result: CreateJoinRequestResultSchema,
  }),
  [INVOKE_CHANNELS.withdrawJoinRequest]: Object.freeze({
    /** The ID of the account's own pending request. */
    args: z.tuple([ProtocolIdSchema]),
    result: WithdrawJoinRequestResultSchema,
  }),
  [INVOKE_CHANNELS.getClaimState]: Object.freeze({
    args: NoArgumentsSchema,
    result: ClaimsViewSchema,
  }),
  [INVOKE_CHANNELS.subscribeClaimState]: Object.freeze({
    args: NoArgumentsSchema,
    result: ClaimsViewSchema,
  }),
  [INVOKE_CHANNELS.loadClaims]: Object.freeze({
    args: NoArgumentsSchema,
    result: ClaimLoadResultSchema,
  }),
  [INVOKE_CHANNELS.markClaimsSeen]: Object.freeze({
    /**
     * The selected workspace's ID and the member IDs of the claims that the
     * screen showed.
     */
    args: z.tuple([ProtocolIdSchema, ShownClaimsSchema]),
    result: ClaimMarkSeenResultSchema,
  }),
  [INVOKE_CHANNELS.getClaimMarks]: Object.freeze({
    args: NoArgumentsSchema,
    result: ClaimMarksViewSchema,
  }),
  [INVOKE_CHANNELS.subscribeClaimMarks]: Object.freeze({
    args: NoArgumentsSchema,
    result: ClaimMarksViewSchema,
  }),
  [INVOKE_CHANNELS.getAgentState]: Object.freeze({
    args: NoArgumentsSchema,
    result: AgentActivityViewSchema,
  }),
  [INVOKE_CHANNELS.subscribeAgentState]: Object.freeze({
    args: NoArgumentsSchema,
    result: AgentActivityViewSchema,
  }),
  [INVOKE_CHANNELS.requestRun]: Object.freeze({
    /** The project, the agent, the connection, and the input message. */
    args: z.tuple([RunRequestViewSchema]),
    result: RunRequestResultSchema,
  }),
  [INVOKE_CHANNELS.takeRunRequestOutcome]: Object.freeze({
    /** The project whose chat screen opens. */
    args: z.tuple([ProtocolIdSchema]),
    /** Null when nothing is kept for it. */
    result: RunRequestOutcomeSchema.nullable(),
  }),
  [INVOKE_CHANNELS.getGrantState]: Object.freeze({
    args: NoArgumentsSchema,
    result: GrantsViewSchema,
  }),
  [INVOKE_CHANNELS.subscribeGrantState]: Object.freeze({
    args: NoArgumentsSchema,
    result: GrantsViewSchema,
  }),
  [INVOKE_CHANNELS.listProviderConnections]: Object.freeze({
    args: NoArgumentsSchema,
    result: ProviderConnectionsResultSchema,
  }),
  [INVOKE_CHANNELS.grantCapability]: Object.freeze({
    /** The agent's ID and what to grant. */
    args: z.tuple([ProtocolIdSchema, GrantRequestViewSchema]),
    result: GrantCapabilityResultSchema,
  }),
  [INVOKE_CHANNELS.revokeGrant]: Object.freeze({
    /** The agent's ID and the grant's ID. */
    args: z.tuple([ProtocolIdSchema, ProtocolIdSchema]),
    result: RevokeGrantResultSchema,
  }),
  [INVOKE_CHANNELS.listAgentGrants]: Object.freeze({
    /** The agent's ID. */
    args: z.tuple([ProtocolIdSchema]),
    result: AgentGrantsResultSchema,
  }),
  [INVOKE_CHANNELS.getChatState]: Object.freeze({
    args: NoArgumentsSchema,
    result: ChatViewSchema,
  }),
  [INVOKE_CHANNELS.subscribeChatState]: Object.freeze({
    args: NoArgumentsSchema,
    result: ChatViewSchema,
  }),
  [INVOKE_CHANNELS.sendChatMessage]: Object.freeze({
    args: z.tuple([ChatSendTextSchema]),
    result: ChatSendResultSchema,
  }),
  [INVOKE_CHANNELS.retryChatMessage]: Object.freeze({
    /** The event ID of a message that shows as not sent. */
    args: z.tuple([ProtocolIdSchema]),
    /** True when the message is tried again. */
    result: z.boolean(),
  }),
  [INVOKE_CHANNELS.discardChatMessage]: Object.freeze({
    /** The event ID of a message that waits or shows as not sent. */
    args: z.tuple([ProtocolIdSchema]),
    /** True when the message was dropped. */
    result: z.boolean(),
  }),
  [INVOKE_CHANNELS.loadOlderChatMessages]: Object.freeze({
    args: NoArgumentsSchema,
    result: ChatLoadOlderResultSchema,
  }),
  [INVOKE_CHANNELS.getDeviceList]: Object.freeze({
    args: NoArgumentsSchema,
    result: DeviceListViewSchema,
  }),
  [INVOKE_CHANNELS.subscribeDeviceList]: Object.freeze({
    args: NoArgumentsSchema,
    result: DeviceListViewSchema,
  }),
  [INVOKE_CHANNELS.loadDeviceList]: Object.freeze({
    args: NoArgumentsSchema,
    result: DeviceListLoadResultSchema,
  }),
  [INVOKE_CHANNELS.dismissNewDevices]: Object.freeze({
    /** The device IDs of the notices that the renderer showed. */
    args: z.tuple([DismissedDevicesSchema]),
    /** True when a notice of them was held and ended. */
    result: z.boolean(),
  }),
  [INVOKE_CHANNELS.revokeDevice]: Object.freeze({
    /** The device ID of an active device of the list, and the reason. */
    args: z.tuple([ProtocolIdSchema, z.enum(OTHER_DEVICE_REVOCATIONS)]),
    result: RevokeOtherDeviceResultSchema,
  }),
  [INVOKE_CHANNELS.liftRegistrationLock]: Object.freeze({
    args: NoArgumentsSchema,
    result: LiftRegistrationLockResultSchema,
  }),
  [INVOKE_CHANNELS.dismissLostDeviceAdvice]: Object.freeze({
    args: NoArgumentsSchema,
    /** True when the advice showed and ended. */
    result: z.boolean(),
  }),
  [INVOKE_CHANNELS.getProviderConnections]: Object.freeze({
    args: NoArgumentsSchema,
    result: ProviderConnectionListViewSchema,
  }),
  [INVOKE_CHANNELS.subscribeProviderConnections]: Object.freeze({
    args: NoArgumentsSchema,
    result: ProviderConnectionListViewSchema,
  }),
  [INVOKE_CHANNELS.registerProviderConnection]: Object.freeze({
    /** A kind and a label, and no other key. */
    args: z.tuple([RegisterProviderConnectionViewSchema]),
    result: RegisterProviderConnectionResultSchema,
  }),
  [INVOKE_CHANNELS.removeProviderConnection]: Object.freeze({
    /** The ID of a connection of the list. */
    args: z.tuple([ProtocolIdSchema]),
    result: RemoveProviderConnectionResultSchema,
  }),
});

/** The payload schema of every event channel. */
export const EVENT_CONTRACT = Object.freeze({
  [EVENT_CHANNELS.runtimeStatusChanged]: RuntimeStatusSchema,
  [EVENT_CHANNELS.repositoriesChanged]: RepositoryListSchema,
  [EVENT_CHANNELS.projectRepositoriesChanged]: ProjectRepositoriesViewSchema,
  [EVENT_CHANNELS.accountStatusChanged]: AccountStatusSchema,
  [EVENT_CHANNELS.connectionStatusChanged]: ConnectionStatusSchema,
  [EVENT_CHANNELS.workspaceStateChanged]: WorkspaceViewSchema,
  [EVENT_CHANNELS.peopleStateChanged]: PeopleViewSchema,
  [EVENT_CHANNELS.invitationStateChanged]: InvitationsViewSchema,
  [EVENT_CHANNELS.joinRequestStateChanged]: JoinRequestsViewSchema,
  [EVENT_CHANNELS.ownJoinRequestStateChanged]: OwnJoinRequestsViewSchema,
  [EVENT_CHANNELS.claimStateChanged]: ClaimsViewSchema,
  [EVENT_CHANNELS.claimMarksChanged]: ClaimMarksViewSchema,
  [EVENT_CHANNELS.agentStateChanged]: AgentActivityViewSchema,
  [EVENT_CHANNELS.grantStateChanged]: GrantsViewSchema,
  [EVENT_CHANNELS.chatStateChanged]: ChatViewSchema,
  [EVENT_CHANNELS.deviceListChanged]: DeviceListViewSchema,
  [EVENT_CHANNELS.providerConnectionsChanged]: ProviderConnectionListViewSchema,
});

export type InvokeArgs<C extends InvokeChannel> = z.infer<
  (typeof INVOKE_CONTRACT)[C]["args"]
>;

export type InvokeResult<C extends InvokeChannel> = z.infer<
  (typeof INVOKE_CONTRACT)[C]["result"]
>;

export type EventPayload<C extends EventChannel> = z.infer<
  (typeof EVENT_CONTRACT)[C]
>;
