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
 * The account that this installation holds, from its device record:
 * `signed_out` without one, and `hidden` while the person is signed out on
 * this device (P-65, #195), also when the device state names something else
 * first, and while that is not known yet. The record is then kept, but the
 * status names no login, display name, or device ID; after a refused
 * sign-in with another account, `lastOutcome.deviceLogin` names the login.
 */
export const AccountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("signed_out") }),
  z.object({
    kind: z.literal("signed_in"),
    login: LoginSchema,
    displayName: z.string().min(1).max(ACCOUNT_LIMITS.displayName),
    deviceId: z.uuid(),
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

// The people of the selected workspace (#95, decision D3).

/**
 * Limits of the people message: the number of people, the most that one
 * answer of the API holds (the protocol's `MAX_ANSWER_LIST_ITEMS`), and the
 * length of a display name in characters (code points; the protocol's
 * `LIMITS.displayName`). The main process sends the active people first,
 * then the former members, within the limit, and cuts a longer name. The
 * shared contract does not import the protocol package, so the main
 * process's tests check that the values match.
 */
export const PEOPLE_LIMITS = Object.freeze({
  people: 1_000,
  displayName: 64,
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
  /** The account's own person in the selected workspace, or null. */
  ownMemberId: ProtocolIdSchema.nullable(),
  /**
   * The active people in the main process's order, which is the server's,
   * then the former members.
   */
  people: z.array(PersonViewSchema).max(PEOPLE_LIMITS.people).readonly(),
  /** How many people `people` leaves out beyond the limit. */
  morePeople: z.int().nonnegative(),
};

/**
 * What the renderer may know of the selected workspace's people:
 * `{ revision, status, problem?, workspaceId, ownMemberId, people,
 * morePeople }`, with a problem only while `unavailable`. It holds member
 * IDs, names, roles, logins, and times only: no user ID and nothing secret.
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
 *   holds at most about 1 MB of text. The waiting messages come first, in
 *   order, then the newest held messages; what does not fit is left out and
 *   counted.
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
 * a typed string, because the later device actions name the device by it
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
};

/**
 * What the renderer may know of the device list service's state:
 * `{ revision, status, problem?, devices, registrationLockedUntil,
 * newDevices }`, with a problem only while `unavailable`. It holds device
 * IDs, labels, platforms, and times only: no user ID and nothing secret.
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
  [INVOKE_CHANNELS.getPeopleState]: Object.freeze({
    args: NoArgumentsSchema,
    result: PeopleViewSchema,
  }),
  [INVOKE_CHANNELS.subscribePeopleState]: Object.freeze({
    args: NoArgumentsSchema,
    result: PeopleViewSchema,
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
});

/** The payload schema of every event channel. */
export const EVENT_CONTRACT = Object.freeze({
  [EVENT_CHANNELS.runtimeStatusChanged]: RuntimeStatusSchema,
  [EVENT_CHANNELS.repositoriesChanged]: RepositoryListSchema,
  [EVENT_CHANNELS.accountStatusChanged]: AccountStatusSchema,
  [EVENT_CHANNELS.connectionStatusChanged]: ConnectionStatusSchema,
  [EVENT_CHANNELS.workspaceStateChanged]: WorkspaceViewSchema,
  [EVENT_CHANNELS.peopleStateChanged]: PeopleViewSchema,
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
