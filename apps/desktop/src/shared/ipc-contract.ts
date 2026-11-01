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
});

/** The payload schema of every event channel. */
export const EVENT_CONTRACT = Object.freeze({
  [EVENT_CHANNELS.runtimeStatusChanged]: RuntimeStatusSchema,
  [EVENT_CHANNELS.repositoriesChanged]: RepositoryListSchema,
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
