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

export const SignInOutcomeSchema = z
  .object({
    code: z.enum(SIGN_IN_OUTCOME_CODES),
    /**
     * With `device_account_mismatch`: the login of the account that this
     * installation holds, which the API's answer does not carry.
     */
    deviceLogin: LoginSchema.optional(),
    /**
     * With `replacement_pending` only, while the grace period of an
     * uncertain sign-in runs (#199): when it ends, in UTC. A new sign-in is
     * not refused for it after this time. It names no key and no ID.
     */
    retryAfter: TimestampSchema.optional(),
  })
  .refine(
    (outcome) =>
      outcome.retryAfter === undefined ||
      outcome.code === "replacement_pending",
    { message: "retryAfter belongs to replacement_pending only" },
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
 * IDs of the workspaces of the list, other than the selected one, that hold
 * a claim that the account has not seen, in the list's order, at most
 * `WORKSPACE_LIMITS.workspaces`. Only whether a workspace has unseen claims
 * crosses: no claim, member ID, login, time, or user ID. The selected
 * workspace's mark follows its claims (`ClaimsViewSchema`).
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
 * ID, and nothing names a device.
 */
export const AgentViewSchema = z.object({
  id: ProtocolIdSchema,
  name: z.string().min(1).max(AGENT_LIMITS.agentName),
  ownerName: z.string().min(1).max(AGENT_LIMITS.ownerName),
  /** When the agent was disabled; null while it is enabled. */
  disabledAt: TimestampSchema.nullable(),
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
});

/** The payload schema of every event channel. */
export const EVENT_CONTRACT = Object.freeze({
  [EVENT_CHANNELS.runtimeStatusChanged]: RuntimeStatusSchema,
  [EVENT_CHANNELS.repositoriesChanged]: RepositoryListSchema,
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
  [EVENT_CHANNELS.chatStateChanged]: ChatViewSchema,
  [EVENT_CHANNELS.deviceListChanged]: DeviceListViewSchema,
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
