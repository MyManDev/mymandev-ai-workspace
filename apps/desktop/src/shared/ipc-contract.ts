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
 * Limits of the account messages, in UTF-16 code units: a display name as
 * the protocol limits it, the authorize URL, the warning shown with it, and
 * the passphrase. The device key store counts at most 1,024 characters of a
 * passphrase after NFC normalization and refuses a longer one itself; this
 * limit only bounds the message.
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

/** The account that this installation holds, from its device record. */
export const AccountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("signed_out") }),
  z.object({
    kind: z.literal("signed_in"),
    login: LoginSchema,
    displayName: z.string().min(1).max(ACCOUNT_LIMITS.displayName),
    deviceId: z.uuid(),
  }),
]);
export type Account = z.infer<typeof AccountSchema>;

const PairingCodeSchema = z.string().regex(/^[0-9]{6}$/, "Expected six digits");

/**
 * The sign-in of this installation: none (`idle`), one that is starting the
 * listener and the browser (`starting`), one that waits for the browser
 * (`waiting`) with the pairing code that the API's confirmation page shows
 * too, or one whose browser part ended and that now registers the device
 * (`completing`). When the browser did not open, `waiting` also holds the
 * authorize URL to copy and the warning to show with it: the URL must not
 * be shared (#149). No sign-in code, verifier, signature, key, or token is
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

export const SignInOutcomeSchema = z.object({
  code: z.enum(SIGN_IN_OUTCOME_CODES),
  /**
   * With `device_account_mismatch`: the login of the account that this
   * installation holds, which the API's answer does not carry.
   */
  deviceLogin: LoginSchema.optional(),
});
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

/** What the renderer may know about the sign-in of this installation. */
export const AccountStatusSchema = z.object({
  /**
   * Grows by one with every change. A receiver keeps the status with the
   * highest revision, like the runtime status.
   */
  revision: z.int().nonnegative(),
  account: AccountSchema,
  signIn: SignInStateSchema,
  /** How the last sign-in ended; null before the first one and after "This is not me". */
  lastOutcome: SignInOutcomeSchema.nullable(),
  deviceKey: z.enum(DEVICE_KEY_STATES),
  /**
   * Whether the key of the last sign-in is not confirmed yet: the previous
   * key is kept until the new one authenticates once.
   */
  replacementPending: z.boolean(),
  apiOrigin: z.enum(API_ORIGIN_STATES),
});
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

/**
 * Why a sign-in was not started: `busy` while a sign-in is open or the
 * account is being changed, `key_not_ready` while the device key is
 * loading, waits for its passphrase, or cannot be used.
 */
export const START_SIGN_IN_REFUSALS = Object.freeze([
  "busy",
  "key_not_ready",
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

/** A passphrase for the device key. Only the renderer sends one. */
export const PassphraseSchema = z
  .string()
  .min(1)
  .max(ACCOUNT_LIMITS.passphrase);

/**
 * Why a passphrase did not unlock the device key: `not_required` when no
 * key waits for one, `busy` while another unlock or a change of the account
 * runs, `wrong_passphrase`, or `passphrase_invalid` for text that is not
 * well-formed or longer than 1,024 characters.
 */
export const UNLOCK_REFUSALS = Object.freeze([
  "not_required",
  "busy",
  "wrong_passphrase",
  "passphrase_invalid",
] as const);

export const UnlockResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("unlocked") }),
  z.object({ outcome: z.literal("refused"), reason: z.enum(UNLOCK_REFUSALS) }),
  /** The key cannot be used; the status's `deviceKey` says why. */
  z.object({ outcome: z.literal("failed") }),
]);
export type UnlockResult = z.infer<typeof UnlockResultSchema>;

/**
 * Why "This is not me" deleted nothing: `busy` while a sign-in is open or
 * the key is loading or being unlocked, `not_signed_in` when this
 * installation holds no account.
 */
export const FORGET_REFUSALS = Object.freeze([
  "busy",
  "not_signed_in",
] as const);

export const ForgetResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("forgotten") }),
  z.object({ outcome: z.literal("refused"), reason: z.enum(FORGET_REFUSALS) }),
  /** The record or the key could not be deleted. */
  z.object({ outcome: z.literal("failed") }),
]);
export type ForgetResult = z.infer<typeof ForgetResultSchema>;

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
    args: NoArgumentsSchema,
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
});

/** The payload schema of every event channel. */
export const EVENT_CONTRACT = Object.freeze({
  [EVENT_CHANNELS.runtimeStatusChanged]: RuntimeStatusSchema,
  [EVENT_CHANNELS.repositoriesChanged]: RepositoryListSchema,
  [EVENT_CHANNELS.accountStatusChanged]: AccountStatusSchema,
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
