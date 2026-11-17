// The project repository service (#286): the registered repositories of the
// workspace service's open project, the account's links from them to the
// folders mounted on this device, and the resolution of a `RepositoryId` to
// its folder for the callers of the permission enforcement point.
//
// - The repositories are read over HTTP with `listRepositories` and kept
//   current with `workspace.repository.registered` and
//   `workspace.repository.removed` of the selected workspace, through the
//   service's own resync gate, as the agent service does. The service
//   registers and removes them with the allowlisted writes. A registration
//   reaches the list through its server event, as a new project does.
// - The links live in the link store, a file in the local data folder
//   (link-store.ts). A link names the account's own person in the workspace,
//   so the service shows and resolves only the links whose person is the
//   workspace service's own person in that workspace: another account, a
//   sign-out, and a workspace that the list no longer holds see none.
// - A link is made only after the person confirmed it in a native dialog of
//   the main process (the Project Manager's decision of 2026-11-17), so the
//   renderer alone can never link a folder. It records the identity of the
//   folder and of its common Git folder (identity.ts), and a resolution
//   fails closed when they changed.
// - A removed repository never comes back. This run keeps the ID of every
//   repository that it saw removed: this device's removal, a removed event,
//   and a reload of the project that no longer lists it. Every link of it
//   goes at once, whoever made it, and none can be made again.
// - A failed write of the links is tried again with a backoff and with the
//   next change, and once more when the service closes, so that a dropped
//   link does not come back after a restart.
// - The path never leaves the main process: no state, log, or request holds
//   it. The renderer gets a mount ID for a linked folder while it is
//   mounted.
//
// The logs are fixed text with a failure code at most, never a name, an ID,
// or a path.
import {
  type MemberId,
  type ProjectId,
  ProjectIdSchema,
  type ProjectRepository,
  type ReceivedServerEvent,
  type RegisterRepositoryResponse,
  type RepositoryId,
  RepositoryIdSchema,
  type WorkspaceId,
} from "@mymandev/protocol";
import {
  type AccountStatus,
  type LinkRepositoryRefusal,
  type LinkRepositoryResult,
  MountIdSchema,
  type RegisterRepositoryRefusal,
  type RegisterRepositoryResult,
  type RemoveRepositoryRefusal,
  type RemoveRepositoryResult,
  type RepositoryLinkState,
  type UnlinkRepositoryResult,
} from "../../shared/ipc-contract.ts";
import type { AccountService } from "../account.ts";
import type {
  WorkspaceActionFailure,
  WorkspaceActionResult,
} from "../api-actions.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { ConnectionClient, ServerMessage } from "../connection/client.ts";
import type { MountedFolder, RepositoryService } from "../repositories.ts";
import type { ScheduleTimer } from "../runtime.ts";
import {
  createResyncGate,
  type ResyncGeneration,
  type ResyncReload,
} from "../workspace/resync.ts";
import {
  workspaceRetryDelayMs,
  type WorkspaceService,
  type WorkspaceState,
} from "../workspace/service.ts";
import type { LinkConfirmationRequest } from "./confirmation.ts";
import {
  type FolderIdentityResult,
  type RepositoryFolders,
  sameFolderIdentity,
} from "./identity.ts";
import {
  MAX_REPOSITORY_LINKS,
  type RepositoryLink,
  type RepositoryLinkStore,
} from "./link-store.ts";

/**
 * - `no_project`: no project is open, or no device is signed in.
 * - `loading`: the open project's repositories have not loaded yet.
 * - `ready`: they loaded. It stays `ready` during later reloads.
 * - `unavailable`: the last reload failed; `problem` holds the failure
 *   until a reload succeeds. What was loaded before stays.
 */
export type ProjectRepositoryStatus =
  "no_project" | "loading" | "ready" | "unavailable";

/** A registered repository of the open project, with the account's link. */
export interface ProjectRepositoryEntry {
  readonly repositoryId: RepositoryId;
  readonly name: string;
  /** Whether the signed-in account linked it to a folder on this device. */
  readonly linked: boolean;
  /** The mount of the linked folder while it is mounted, else null. */
  readonly mountId: string | null;
}

/** The service's state. Every value is frozen; it holds no path. */
export interface ProjectRepositoryState {
  /** Grows by one with every change. */
  readonly revision: number;
  readonly status: ProjectRepositoryStatus;
  /** Only with `unavailable`. */
  readonly problem?: WorkspaceReadFailure;
  /** The selected workspace while a project is open, else null. */
  readonly workspaceId: WorkspaceId | null;
  readonly projectId: ProjectId | null;
  readonly links: RepositoryLinkState;
  /** The open project's repositories, the oldest first. */
  readonly repositories: readonly ProjectRepositoryEntry[];
}

/**
 * Why a repository did not resolve to a folder, a closed set. Every one
 * means: act on nothing.
 *
 * - `invalid`: the value is not a `RepositoryId`.
 * - `unavailable`: no device is signed in, the links are not `ready`, or
 *   the service is closed.
 * - `not_linked`: the signed-in account holds no link of the repository on
 *   this device, also when another account does, and after a removal.
 * - `not_mounted`: the linked folder is not mounted now.
 * - `mount_unavailable`: the mount's state is `unavailable`: its last read
 *   failed.
 * - `folder_missing`: the folder or its common Git folder is no longer a
 *   folder.
 * - `changed_folder`: the folder or its common Git folder is not the one
 *   that was linked (its device or file number changed, or it became a
 *   symbolic link or a junction); the person links it again.
 * - `changed`: the link or the mount changed while the folder was checked.
 */
export const REPOSITORY_FOLDER_FAILURES = Object.freeze([
  "invalid",
  "unavailable",
  "not_linked",
  "not_mounted",
  "mount_unavailable",
  "folder_missing",
  "changed_folder",
  "changed",
] as const);
export type RepositoryFolderFailure =
  (typeof REPOSITORY_FOLDER_FAILURES)[number];

export type RepositoryFolderResolution =
  | {
      readonly ok: true;
      readonly repositoryId: RepositoryId;
      /** The repository's top-level folder, as Git reported it. */
      readonly folder: string;
    }
  | { readonly ok: false; readonly reason: RepositoryFolderFailure };

/**
 * The first wait before a failed write of the links is tried again. It
 * doubles with each failure, up to `LINK_WRITE_RETRY_MAX_MS`.
 */
export const LINK_WRITE_RETRY_FIRST_MS = 1_000;
export const LINK_WRITE_RETRY_MAX_MS = 60_000;

/** The wait before the next try after `attempt` failed tries, from 0. */
export function linkWriteRetryDelayMs(attempt: number): number {
  return Math.min(
    LINK_WRITE_RETRY_MAX_MS,
    LINK_WRITE_RETRY_FIRST_MS * 2 ** Math.min(Math.max(attempt, 0), 30),
  );
}

/** The part of the account service that this service uses. */
export type ProjectRepositoryAccount = Pick<
  AccountService,
  "status" | "onStatusChange" | "readWorkspaceData" | "sendWorkspaceAction"
>;

/** The part of the connection client that this service uses; it cannot send. */
export type ProjectRepositoryConnection = Pick<
  ConnectionClient,
  "status" | "onStatusChange" | "onMessage"
>;

/** The part of the workspace service that this service uses. */
export type ProjectRepositoryWorkspaces = Pick<
  WorkspaceService,
  "state" | "onChange" | "ownMemberId"
>;

/** The part of the repository (mount) service that this service uses. */
export type ProjectRepositoryMounts = Pick<
  RepositoryService,
  "folderOf" | "mountOf" | "onChange"
>;

export interface ProjectRepositoryServiceOptions {
  readonly account: ProjectRepositoryAccount;
  readonly connection: ProjectRepositoryConnection;
  readonly workspaces: ProjectRepositoryWorkspaces;
  readonly mounts: ProjectRepositoryMounts;
  readonly store: RepositoryLinkStore;
  /**
   * Reads the identity of a mounted repository's top-level folder and
   * common Git folder (`readFolderIdentity` with the system's `lstat`). A
   * rejection counts as `folder_missing`.
   */
  readonly identify: (
    folders: RepositoryFolders,
  ) => Promise<FolderIdentityResult>;
  /**
   * Asks the person, in a native dialog of the main process on the main
   * window, whether to link the named repository to the folder. Resolves to
   * true only for the link button (`LINK_CONFIRMATION` and
   * `linkConfirmed`). A rejection links nothing (`failed`).
   */
  readonly confirmLink: (request: LinkConfirmationRequest) => Promise<boolean>;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /**
   * Receives fixed messages with a failure code at most, never a name, an
   * ID, or a path. An error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface ProjectRepositoryService {
  readonly state: () => ProjectRepositoryState;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onChange: (
    listener: (state: ProjectRepositoryState) => void,
  ) => () => void;
  /** Registers a repository in the open project by its name. Never rejects. */
  readonly register: (
    projectId: string,
    name: string,
  ) => Promise<RegisterRepositoryResult>;
  /** Removes a repository of the open project. Never rejects. */
  readonly remove: (
    projectId: string,
    repositoryId: string,
  ) => Promise<RemoveRepositoryResult>;
  /**
   * Links a registered repository of the open project to the folder of a
   * mount, for the signed-in account, once the person confirmed it in the
   * main process's dialog. The link applies once it is written. Never
   * rejects.
   */
  readonly link: (
    repositoryId: string,
    mountId: string,
  ) => Promise<LinkRepositoryResult>;
  /** Drops the signed-in account's link of a repository. Never rejects. */
  readonly unlink: (repositoryId: string) => Promise<UnlinkRepositoryResult>;
  /**
   * The folder of a repository for the enforcement point's callers: the
   * signed-in account's link, while its folder is mounted, its mount is not
   * `unavailable`, and the folder and its common Git folder are still the
   * ones that were linked. It fails closed and never rejects. Call it for
   * each action, after the check allowed it, with the repository of the
   * allowed request; never keep the folder.
   */
  readonly resolveFolder: (
    repositoryId: unknown,
  ) => Promise<RepositoryFolderResolution>;
  /**
   * Stops listening and cancels the timers, for the quit. A write of the
   * links that failed is tried once more, without waiting for it.
   */
  readonly close: () => void;
}

/**
 * Each failure of a write and what the screen gets when it registers a
 * repository. `REPOSITORY_ROUTE_ERRORS.registerRepository` answers
 * `not_found`, `conflict`, and `repository_limit` beyond the common codes.
 */
const REGISTER_OUTCOMES = {
  invalid: "invalid",
  too_soon: "too_soon",
  not_signed_in: "not_signed_in",
  unavailable: "unavailable",
  forbidden: "failed",
  not_found: "not_found",
  conflict: "conflict",
  already_member: "failed",
  invitation_invalid: "failed",
  join_requests_closed: "failed",
  workspace_not_found: "failed",
  device_too_new: "failed",
  unclaimed_limit: "failed",
  project_limit: "failed",
  repository_limit: "repository_limit",
  rate_limited: "rate_limited",
  unknown: "unknown",
  failed: "failed",
} satisfies Record<
  WorkspaceActionFailure,
  RegisterRepositoryRefusal | "unknown"
>;
Object.freeze(REGISTER_OUTCOMES);

/**
 * Each failure of a write and what the screen gets when it removes a
 * repository. `REPOSITORY_ROUTE_ERRORS.removeRepository` answers
 * `not_found`, `forbidden`, and `conflict` beyond the common codes.
 */
const REMOVE_OUTCOMES = {
  invalid: "invalid",
  too_soon: "too_soon",
  not_signed_in: "not_signed_in",
  unavailable: "unavailable",
  forbidden: "forbidden",
  not_found: "not_found",
  conflict: "conflict",
  already_member: "failed",
  invitation_invalid: "failed",
  join_requests_closed: "failed",
  workspace_not_found: "failed",
  device_too_new: "failed",
  unclaimed_limit: "failed",
  project_limit: "failed",
  repository_limit: "failed",
  rate_limited: "rate_limited",
  unknown: "unknown",
  failed: "failed",
} satisfies Record<WorkspaceActionFailure, RemoveRepositoryRefusal | "unknown">;
Object.freeze(REMOVE_OUTCOMES);

const UNKNOWN = Object.freeze({ outcome: "unknown" } as const);
const LINKED = Object.freeze({ outcome: "linked" } as const);

type Refused<R extends string> = {
  readonly outcome: "refused";
  readonly reason: R;
  readonly retryAfterMs: number | null;
};

function refused<R extends string>(
  reason: R,
  retryAfterMs: number | null = null,
): Refused<R> {
  return Object.freeze({ outcome: "refused", reason, retryAfterMs });
}

/** The result of a failed write, with its wait for `too_soon` and `rate_limited`. */
function failedResult<R extends string>(
  outcomes: Readonly<Record<WorkspaceActionFailure, R | "unknown">>,
  result: Extract<WorkspaceActionResult<unknown>, { ok: false }>,
): Refused<R> | typeof UNKNOWN {
  const outcome = outcomes[result.reason];
  if (outcome === "unknown") {
    return UNKNOWN;
  }
  return "retryAfterMs" in result
    ? refused(outcome, result.retryAfterMs)
    : refused(outcome);
}

function linkRefused(reason: LinkRepositoryRefusal): LinkRepositoryResult {
  return Object.freeze({ outcome: "refused", reason });
}

function unlinkRefused(
  reason: Extract<UnlinkRepositoryResult, { outcome: "refused" }>["reason"],
): UnlinkRepositoryResult {
  return Object.freeze({ outcome: "refused", reason });
}

function resolutionFailed(
  reason: RepositoryFolderFailure,
): RepositoryFolderResolution {
  return Object.freeze({ ok: false, reason });
}

/** The events that this service passes through its gate. */
type RepositoryEvent = Extract<
  ReceivedServerEvent,
  {
    type: "workspace.repository.registered" | "workspace.repository.removed";
  }
>;

function isRepositoryEvent(
  event: ReceivedServerEvent,
): event is RepositoryEvent {
  return (
    event.type === "workspace.repository.registered" ||
    event.type === "workspace.repository.removed"
  );
}

/**
 * The signed-in device, or null, under the same condition as the workspace
 * service. The device ID is only compared.
 */
function signedInDevice(status: AccountStatus): string | null {
  if (
    status.apiOrigin === "set" &&
    status.device === "signed_in" &&
    status.deviceKey === "ready" &&
    status.account.kind === "signed_in"
  ) {
    return status.account.deviceId;
  }
  return null;
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

/** One reload that was sent, with what it was sent for. */
interface ReloadRequest {
  readonly epoch: number;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly generation: ResyncGeneration;
}

/** A link that `link` would make, before its identity is read. */
interface ProposedLink {
  readonly workspaceId: WorkspaceId;
  readonly ownMemberId: MemberId;
  readonly projectId: ProjectId;
  readonly repositoryId: RepositoryId;
  /** The registered repository's name, for the confirmation only. */
  readonly name: string;
  readonly mounted: MountedFolder;
  /** The account's earlier link of the repository, which the new one replaces. */
  readonly replaces: RepositoryLink | undefined;
  /**
   * At the limit, the oldest link of another account or a former person,
   * whose place the new one takes.
   */
  readonly evicts: RepositoryLink | undefined;
}

/** Whether two proposals link the same account's repository to the same folders. */
function sameProposal(a: ProposedLink, b: ProposedLink): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.ownMemberId === b.ownMemberId &&
    a.projectId === b.projectId &&
    a.repositoryId === b.repositoryId &&
    a.mounted.topLevel === b.mounted.topLevel &&
    a.mounted.commonDir === b.mounted.commonDir
  );
}

function sameLinks(
  a: readonly RepositoryLink[],
  b: readonly RepositoryLink[],
): boolean {
  return a.length === b.length && a.every((link, index) => link === b[index]);
}

function frozenLink(link: RepositoryLink): RepositoryLink {
  return Object.freeze({
    workspaceId: link.workspaceId,
    ownMemberId: link.ownMemberId,
    projectId: link.projectId,
    repositoryId: link.repositoryId,
    folder: link.folder,
    identity: Object.freeze({
      folder: Object.freeze({
        dev: link.identity.folder.dev,
        ino: link.identity.folder.ino,
      }),
      commonDir: Object.freeze({
        dev: link.identity.commonDir.dev,
        ino: link.identity.commonDir.ino,
      }),
    }),
  });
}

const NO_ENTRIES: readonly ProjectRepositoryEntry[] = Object.freeze([]);

export function createProjectRepositoryService(
  options: ProjectRepositoryServiceOptions,
): ProjectRepositoryService {
  const { account, connection, workspaces, mounts, store } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  let device: string | null = null;
  /** Changes with every reset, so that an answer for an earlier device is dropped. */
  let epoch = 0;
  let connected = false;

  let workspaceId: WorkspaceId | null = null;
  let projectId: ProjectId | null = null;
  const gate = createResyncGate<RepositoryEvent>({
    sizeOf: (event) => Buffer.byteLength(JSON.stringify(event), "utf8"),
  });
  /** The open project's repositories, or null until they loaded. */
  let repositories: readonly ProjectRepository[] | null = null;
  let problem: WorkspaceReadFailure | null = null;
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;
  let wanted: ResyncReload | null = null;
  let inFlight = false;
  /**
   * Every repository that this run saw removed, of any workspace and any
   * account. A removed repository never comes back, so none of them is
   * listed, linked, or resolved again.
   */
  const removed = new Set<RepositoryId>();

  // The links of every account on this device, the oldest first.
  let linkState: RepositoryLinkState = "loading";
  let links: readonly RepositoryLink[] = Object.freeze([]);
  /** The writes, one at a time, in the order they were asked for. */
  let writes: Promise<unknown> = Promise.resolve();
  /** Whether the file may not hold the links as they are: a save waits or failed. */
  let writePending = false;
  let saveCount = 0;
  let writeAttempt = 0;
  let cancelWriteRetry: (() => void) | null = null;
  /** Whether a link's identity read or confirmation runs; one at a time. */
  let confirming = false;

  let revision = 0;
  let dirty = false;
  let current = buildState();
  const listeners = new Set<(state: ProjectRepositoryState) => void>();

  // The account's links.

  /**
   * Whether `link` is the signed-in account's: its person is the workspace
   * service's own person in its workspace.
   */
  function ownLink(link: RepositoryLink): boolean {
    // Every entry point checks the device first; this keeps a later caller
    // closed as well.
    if (device === null) {
      return false;
    }
    try {
      return workspaces.ownMemberId(link.workspaceId) === link.ownMemberId;
    } catch {
      return false;
    }
  }

  /** The signed-in account's link of a repository, or undefined. */
  function ownLinkOf(repositoryId: RepositoryId): RepositoryLink | undefined {
    if (linkState !== "ready") {
      return undefined;
    }
    return links.find(
      (link) => link.repositoryId === repositoryId && ownLink(link),
    );
  }

  function mountOf(folder: string): string | null {
    try {
      return mounts.mountOf(folder) ?? null;
    } catch {
      return null;
    }
  }

  function mountedFolder(mountId: string): MountedFolder | undefined {
    try {
      return mounts.folderOf(mountId) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async function identify(
    folders: MountedFolder,
  ): Promise<FolderIdentityResult> {
    try {
      const result = await options.identify({
        topLevel: folders.topLevel,
        commonDir: folders.commonDir,
      });
      return result.ok || result.reason === "symbolic_link"
        ? result
        : { ok: false, reason: "folder_missing" };
    } catch {
      return { ok: false, reason: "folder_missing" };
    }
  }

  function buildState(): ProjectRepositoryState {
    const entries =
      repositories === null
        ? NO_ENTRIES
        : Object.freeze(
            repositories.map((repository) => {
              const link = ownLinkOf(repository.id);
              return Object.freeze({
                repositoryId: repository.id,
                name: repository.name,
                linked: link !== undefined,
                mountId: link === undefined ? null : mountOf(link.folder),
              });
            }),
          );
    const base = {
      revision,
      workspaceId: projectId === null ? null : workspaceId,
      projectId,
      links: linkState,
      repositories: entries,
    };
    if (projectId === null) {
      return Object.freeze({ ...base, status: "no_project" });
    }
    if (problem !== null) {
      return Object.freeze({ ...base, status: "unavailable", problem });
    }
    return Object.freeze({
      ...base,
      status: repositories === null ? "loading" : "ready",
    });
  }

  /** The state without its revision, to tell whether anything changed. */
  function fingerprint(state: ProjectRepositoryState): string {
    return JSON.stringify({ ...state, revision: 0 });
  }

  function touch(): void {
    dirty = true;
  }

  function flush(): void {
    if (!dirty || closed) {
      return;
    }
    dirty = false;
    const next = buildState();
    // A change of a mount's status changes nothing here.
    if (fingerprint(next) === fingerprint(current)) {
      return;
    }
    revision += 1;
    const state = Object.freeze({ ...next, revision });
    current = state;
    for (const listener of [...listeners]) {
      if (current !== state) {
        return;
      }
      try {
        listener(state);
      } catch {
        log("A project repository state listener failed.");
      }
    }
  }

  /** Runs one entry point and then publishes what it changed. */
  function run<T>(action: () => T): T {
    try {
      return action();
    } finally {
      flush();
    }
  }

  // The writes of the link file.

  /** Runs `task` after the writes asked for before it. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = writes.then(task);
    writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Writes the links as they are when the write starts. */
  async function writeCurrent(): Promise<boolean> {
    try {
      await store.write(links);
      return true;
    } catch {
      log("The repository links could not be written.");
      return false;
    }
  }

  function stopWriteRetry(): void {
    cancelWriteRetry?.();
    cancelWriteRetry = null;
  }

  /**
   * Writes the links as they are when the write starts, after the writes
   * asked for before it, so a write never puts back a link that a removal
   * dropped while it waited. A failed save is tried again with a backoff,
   * and with the next save, until one is written.
   */
  function saveLinks(): void {
    // No caller saves before the links are ready; this keeps a later one
    // from writing over a file that was not read.
    if (linkState !== "ready") {
      return;
    }
    stopWriteRetry();
    writePending = true;
    saveCount += 1;
    const count = saveCount;
    void enqueue(writeCurrent).then((written) =>
      run(() => saved(count, written)),
    );
  }

  function saved(count: number, written: boolean): void {
    // A later save is on its way, with the later links: it decides.
    if (count !== saveCount) {
      return;
    }
    if (written) {
      writePending = false;
      writeAttempt = 0;
      return;
    }
    if (closed) {
      return;
    }
    const delayMs = linkWriteRetryDelayMs(writeAttempt);
    writeAttempt += 1;
    stopWriteRetry();
    cancelWriteRetry = schedule(() => {
      run(() => {
        cancelWriteRetry = null;
        if (!closed) {
          saveLinks();
        }
      });
    }, delayMs);
  }

  /**
   * Drops every link, of any account, that `drop` names, and saves the
   * rest. The links stop resolving at once, also when the write fails.
   */
  function dropLinks(drop: (link: RepositoryLink) => boolean): void {
    const kept = links.filter((link) => !drop(link));
    if (kept.length === links.length) {
      return;
    }
    links = Object.freeze(kept);
    touch();
    saveLinks();
  }

  /**
   * A repository was removed: every link of it goes at once, whoever made
   * it, and it is never listed or linked again in this run. While the file
   * is read, the read leaves its links out. The list drops it with its event
   * through the gate, or at once for this device's own removal.
   */
  function repositoryRemoved(repositoryId: RepositoryId): void {
    removed.add(repositoryId);
    if (linkState === "ready") {
      dropLinks((link) => link.repositoryId === repositoryId);
    }
  }

  /** Drops a repository from the open project's list. */
  function unlisted(repositoryId: RepositoryId): void {
    if (
      repositories !== null &&
      repositories.some((repository) => repository.id === repositoryId)
    ) {
      repositories = Object.freeze(
        repositories.filter((repository) => repository.id !== repositoryId),
      );
      touch();
    }
  }

  /**
   * The list of `forProject` is now its whole list: every repository that
   * it held before (`before`) or that a link of the project names, and that
   * it no longer holds, was removed. A repository that a link names was
   * listed when the link was made, so the server's list holds it unless it
   * was removed.
   */
  function settleProject(
    forProject: ProjectId,
    before: readonly ProjectRepository[] | null,
  ): void {
    if (repositories === null) {
      return;
    }
    const listed = new Set<string>(
      repositories.map((repository) => repository.id),
    );
    const gone = new Set<RepositoryId>();
    for (const repository of before ?? []) {
      if (!listed.has(repository.id)) {
        gone.add(repository.id);
      }
    }
    for (const link of links) {
      if (link.projectId === forProject && !listed.has(link.repositoryId)) {
        gone.add(link.repositoryId);
      }
    }
    for (const repositoryId of gone) {
      repositoryRemoved(repositoryId);
    }
  }

  function linksRead(
    result: Awaited<ReturnType<RepositoryLinkStore["read"]>> | null,
  ): void {
    if (closed) {
      return;
    }
    if (result === null || result.kind === "newer") {
      // Not read, or written by a later build: neither used nor overwritten.
      log(
        result === null
          ? "The repository links could not be read."
          : "The repository links are of a later version and are not used.",
      );
      linkState = "unavailable";
      touch();
      return;
    }
    if (result.kind === "corrupt") {
      log("The repository links file is not valid; it is replaced.");
    }
    if (result.kind === "older") {
      // Version 1 holds no identity of the folders: each repository is
      // linked again.
      log(
        "The repository links are of an earlier version and are not used; they are replaced.",
      );
    }
    const read = result.kind === "links" ? result.links : [];
    linkState = "ready";
    // The links of repositories removed while the file was read go.
    links = Object.freeze(
      read
        .filter((link) => !removed.has(link.repositoryId))
        .map((link) => frozenLink(link)),
    );
    touch();
    if (links.length !== read.length) {
      saveLinks();
    }
    // The open project's list may have loaded first.
    if (projectId !== null) {
      settleProject(projectId, null);
    }
  }

  // The open project.

  function stopRetry(): void {
    cancelRetry?.();
    cancelRetry = null;
  }

  function clearProject(): void {
    if (projectId !== null) {
      touch();
    }
    stopRetry();
    repositories = null;
    problem = null;
    attempt = 0;
    wanted = null;
  }

  /** Forgets the project: a sign-out, or another device. */
  function reset(): void {
    epoch += 1;
    inFlight = false;
    gate.end();
    clearProject();
    workspaceId = null;
    projectId = null;
    touch();
  }

  function follow(state: WorkspaceState): void {
    const nextWorkspace = device === null ? null : state.selectedWorkspaceId;
    const nextProject = nextWorkspace === null ? null : state.openProjectId;
    if (nextWorkspace !== workspaceId) {
      gate.end();
      clearProject();
      workspaceId = nextWorkspace;
      projectId = null;
    }
    if (nextProject !== projectId) {
      clearProject();
      projectId = nextProject;
      touch();
      if (nextProject !== null) {
        reload();
      }
    }
    // The own person of a workspace may have changed with the list.
    touch();
  }

  function reload(): void {
    if (closed || projectId === null) {
      return;
    }
    stopRetry();
    if (wanted !== null && wanted.generation === gate.generation()) {
      return;
    }
    wanted = gate.begin("all");
    sendWanted();
  }

  function sendWanted(): void {
    if (inFlight || wanted === null) {
      return;
    }
    const begun = wanted;
    wanted = null;
    if (
      begun.generation !== gate.generation() ||
      workspaceId === null ||
      projectId === null
    ) {
      return;
    }
    inFlight = true;
    const request: ReloadRequest = {
      epoch,
      workspaceId,
      projectId,
      generation: begun.generation,
    };
    void account
      .readWorkspaceData("listRepositories", { projectId: request.projectId })
      .catch(() => ({ ok: false, reason: "unavailable" }) as const)
      .then((answer) => run(() => reloadAnswered(request, answer)));
  }

  function reloadAnswered(
    request: ReloadRequest,
    answer: WorkspaceReadResult<{
      readonly repositories: readonly ProjectRepository[];
    }>,
  ): void {
    if (closed || request.epoch !== epoch) {
      return;
    }
    inFlight = false;
    try {
      if (
        request.workspaceId === workspaceId &&
        request.projectId === projectId
      ) {
        applyAnswer(request, answer);
      }
    } finally {
      sendWanted();
    }
  }

  function applyAnswer(
    request: ReloadRequest,
    answer: WorkspaceReadResult<{
      readonly repositories: readonly ProjectRepository[];
    }>,
  ): void {
    if (!answer.ok) {
      reloadFailed(request.generation, answer.reason);
      return;
    }
    const listed = answer.value.repositories;
    if (
      listed.some((repository) => repository.projectId !== request.projectId)
    ) {
      // The answer holds another project's repositories.
      reloadFailed(request.generation, "failed");
      return;
    }
    const events = gate.reloaded(request.generation);
    if (events === null) {
      return;
    }
    const before = repositories;
    // An answer read before a removal that this run saw still lists it.
    repositories = Object.freeze(
      listed.filter((repository) => !removed.has(repository.id)),
    );
    problem = null;
    attempt = 0;
    touch();
    applyEvents(events);
    // Checked against the final list, with the events that waited applied.
    settleProject(request.projectId, before);
  }

  function reloadFailed(
    generation: ResyncGeneration,
    reason: WorkspaceReadFailure,
  ): void {
    if (!gate.reloadFailed(generation)) {
      return;
    }
    problem = reason;
    touch();
    log(`The project repositories did not load (${reason}).`);
    scheduleRetry(workspaceRetryDelayMs(attempt, reason));
    attempt += 1;
  }

  function scheduleRetry(delayMs: number): void {
    stopRetry();
    cancelRetry = schedule(() => {
      run(() => {
        cancelRetry = null;
        reload();
      });
    }, delayMs);
  }

  // The events.

  function applyEvents(events: readonly RepositoryEvent[]): void {
    for (const event of events) {
      if (event.type === "workspace.repository.registered") {
        const { repository } = event.payload;
        if (
          repositories !== null &&
          repository.projectId === projectId &&
          !removed.has(repository.id) &&
          !repositories.some((held) => held.id === repository.id)
        ) {
          repositories = Object.freeze([...repositories, repository]);
          touch();
        }
        continue;
      }
      const { projectId: removedFrom, repositoryId } = event.payload;
      if (removedFrom === projectId) {
        unlisted(repositoryId);
      }
      // Its links went when the event arrived; this keeps them out in any
      // case.
      repositoryRemoved(repositoryId);
    }
  }

  function eventReceived(event: ReceivedServerEvent): void {
    if (!isRepositoryEvent(event) || event.workspaceId !== workspaceId) {
      return;
    }
    if (event.type === "workspace.repository.removed") {
      // The links go at once, of every project of the workspace, also while
      // the event waits for a reload: a removed repository never comes back.
      repositoryRemoved(event.payload.repositoryId);
    }
    if (projectId === null) {
      return;
    }
    switch (gate.push(event)) {
      case "apply":
        applyEvents([event]);
        return;
      case "overflowed":
        log("Too many repository events waited; the repositories reload.");
        wanted = null;
        scheduleRetry(workspaceRetryDelayMs(attempt, "unavailable"));
        attempt += 1;
        return;
      case "buffered":
      case "dropped":
      case "ignored":
        return;
    }
  }

  function endSubscription(): void {
    gate.end();
    wanted = null;
    stopRetry();
  }

  function messageReceived(message: ServerMessage): void {
    if (device === null) {
      return;
    }
    if (message.kind === "event") {
      eventReceived(message.event);
      return;
    }
    const frame = message.frame;
    switch (frame.type) {
      case "workspace.subscribed":
        if (frame.workspaceId === workspaceId) {
          const generation = gate.subscribed();
          if (projectId !== null) {
            wanted = { generation, scope: "all" };
            stopRetry();
            sendWanted();
          }
        }
        return;
      case "workspace.subscribe_refused":
      case "workspace.unsubscribed":
        if (frame.workspaceId === workspaceId) {
          endSubscription();
        }
        return;
      default:
        return;
    }
  }

  function accountChanged(status: AccountStatus): void {
    const next = signedInDevice(status);
    if (next === device) {
      return;
    }
    if (device !== null) {
      reset();
    }
    device = next;
    touch();
    follow(workspaces.state());
  }

  function connectionChanged(state: string): void {
    const now = state === "connected";
    if (now === connected) {
      return;
    }
    connected = now;
    if (!now) {
      endSubscription();
    }
  }

  // The actions.

  /** The open project, when `value` names it and a device is signed in. */
  function openProject(
    value: string,
  ):
    | { readonly ok: true; readonly projectId: ProjectId }
    | { readonly ok: false; readonly reason: "invalid" | "not_open" } {
    const parsed = ProjectIdSchema.safeParse(value);
    if (!parsed.success) {
      return { ok: false, reason: "invalid" };
    }
    return !closed && device !== null && parsed.data === projectId
      ? { ok: true, projectId: parsed.data }
      : { ok: false, reason: "not_open" };
  }

  async function register(
    projectValue: string,
    name: string,
  ): Promise<RegisterRepositoryResult> {
    const open = openProject(projectValue);
    if (!open.ok) {
      return refused(open.reason);
    }
    const target = open.projectId;
    let answer: WorkspaceActionResult<RegisterRepositoryResponse>;
    try {
      answer = await account.sendWorkspaceAction(
        "registerRepository",
        { projectId: target },
        { name },
      );
    } catch {
      // A fixed message: never the error, which might hold the name.
      log("Registering a repository could not be sent.");
      return UNKNOWN;
    }
    if (!answer.ok) {
      return failedResult(REGISTER_OUTCOMES, answer);
    }
    // A repository of another project means that the answer is not this
    // write's. The list shows it once its event arrives.
    const { repository } = answer.value;
    return repository.projectId === target
      ? Object.freeze({ outcome: "ok", repositoryId: repository.id })
      : UNKNOWN;
  }

  async function remove(
    projectValue: string,
    repositoryValue: string,
  ): Promise<RemoveRepositoryResult> {
    const open = openProject(projectValue);
    const repository = RepositoryIdSchema.safeParse(repositoryValue);
    if (!repository.success) {
      return refused("invalid");
    }
    if (!open.ok) {
      return refused(open.reason);
    }
    const target = open.projectId;
    let answer: WorkspaceActionResult<null>;
    try {
      answer = await account.sendWorkspaceAction("removeRepository", {
        projectId: target,
        repositoryId: repository.data,
      });
    } catch {
      log("Removing a repository could not be sent.");
      return UNKNOWN;
    }
    if (!answer.ok) {
      if (answer.reason === "conflict" || answer.reason === "not_found") {
        // The repository may be removed already: the list is read again,
        // and drops it and its links if so.
        run(() => {
          if (projectId === target) {
            reload();
          }
        });
      }
      return failedResult(REMOVE_OUTCOMES, answer);
    }
    run(() => {
      repositoryRemoved(repository.data);
      if (projectId === target) {
        unlisted(repository.data);
      }
    });
    return Object.freeze({ outcome: "ok" });
  }

  /**
   * The link that `link` would make, or why it is refused. It replaces the
   * account's earlier link of the repository, if any, and at the limit it
   * takes the place of the oldest link of another account or a former
   * person.
   */
  function proposedLink(
    repositoryId: RepositoryId,
    mountId: string,
  ): ProposedLink | LinkRepositoryRefusal {
    if (closed || device === null || linkState !== "ready") {
      return "unavailable";
    }
    const listed = repositories?.find(
      (repository) => repository.id === repositoryId,
    );
    if (
      workspaceId === null ||
      projectId === null ||
      listed === undefined ||
      removed.has(repositoryId)
    ) {
      // A repository removed while its event waits for a reload is still
      // listed until the reload answers.
      return "not_registered";
    }
    let ownMemberId: MemberId | null;
    try {
      ownMemberId = workspaces.ownMemberId(workspaceId);
    } catch {
      ownMemberId = null;
    }
    if (ownMemberId === null) {
      return "unavailable";
    }
    const mounted = mountedFolder(mountId);
    if (mounted === undefined) {
      return "not_mounted";
    }
    const replaces = ownLinkOf(repositoryId);
    const elsewhere = links.some(
      (link) =>
        link !== replaces && ownLink(link) && mountOf(link.folder) === mountId,
    );
    if (elsewhere) {
      return "folder_linked";
    }
    let evicts: RepositoryLink | undefined;
    if (replaces === undefined && links.length >= MAX_REPOSITORY_LINKS) {
      // Another account's or a former person's oldest link makes room; the
      // account's own links are never dropped for a new one.
      evicts = links.find((link) => !ownLink(link));
      if (evicts === undefined) {
        return "limit";
      }
    }
    return Object.freeze({
      workspaceId,
      ownMemberId,
      projectId,
      repositoryId,
      name: listed.name,
      mounted,
      replaces,
      evicts,
    });
  }

  async function link(
    repositoryValue: string,
    mountValue: string,
  ): Promise<LinkRepositoryResult> {
    const repository = RepositoryIdSchema.safeParse(repositoryValue);
    const mount = MountIdSchema.safeParse(mountValue);
    if (!repository.success || !mount.success) {
      return linkRefused("invalid");
    }
    const first = proposedLink(repository.data, mount.data);
    if (typeof first === "string") {
      return linkRefused(first);
    }
    // One confirmation at a time: a renderer cannot stack dialogs.
    if (confirming) {
      return linkRefused("busy");
    }
    confirming = true;
    let added: RepositoryLink;
    try {
      // A folder that cannot be identified is refused before the person is
      // asked.
      const identity = await identify(first.mounted);
      if (!identity.ok) {
        return linkRefused(identity.reason);
      }
      // The confirmation runs in the main process, so that the renderer
      // alone cannot link a folder.
      let confirmed: boolean;
      try {
        confirmed =
          (await options.confirmLink(
            Object.freeze({
              name: first.name,
              folder: first.mounted.topLevel,
            }),
          )) === true;
      } catch {
        log("The link confirmation could not be shown.");
        return linkRefused("failed");
      }
      if (!confirmed) {
        return linkRefused("cancelled");
      }
      added = frozenLink({
        workspaceId: first.workspaceId,
        ownMemberId: first.ownMemberId,
        projectId: first.projectId,
        repositoryId: first.repositoryId,
        folder: first.mounted.topLevel,
        identity: identity.identity,
      });
    } finally {
      confirming = false;
    }
    // Written with the links as they are when the write starts, without the
    // account's earlier link of the repository and the evicted one, and the
    // new one last. Checked first: a removal, a sign-out, another account,
    // or another link may have come while the person was asked.
    const outcome = await enqueue(
      async (): Promise<
        LinkRepositoryRefusal | { readonly next: readonly RepositoryLink[] }
      > => {
        const now = proposedLink(repository.data, mount.data);
        if (typeof now === "string") {
          return now;
        }
        if (!sameProposal(now, first)) {
          return "failed";
        }
        const next = Object.freeze([
          ...links.filter(
            (link) => link !== now.replaces && link !== now.evicts,
          ),
          added,
        ]);
        try {
          await store.write(next);
        } catch {
          log("The repository links could not be written.");
          return "failed";
        }
        return { next };
      },
    );
    if (typeof outcome === "string") {
      // The file keeps what it held; the links did not change.
      return linkRefused(outcome);
    }
    return run(() => {
      // Checked again: a removal, a sign-out, or another account may have
      // come while the link was written. The file is then written again
      // without it.
      const again = proposedLink(repository.data, mount.data);
      if (typeof again === "string" || !sameProposal(again, first)) {
        saveLinks();
        return linkRefused(typeof again === "string" ? again : "failed");
      }
      links = Object.freeze([
        ...links.filter(
          (link) => link !== again.replaces && link !== again.evicts,
        ),
        added,
      ]);
      touch();
      // Another change during the write is saved after it.
      if (!sameLinks(links, outcome.next)) {
        saveLinks();
      }
      return LINKED;
    });
  }

  function unlink(repositoryValue: string): Promise<UnlinkRepositoryResult> {
    const repository = RepositoryIdSchema.safeParse(repositoryValue);
    if (!repository.success) {
      return Promise.resolve(unlinkRefused("invalid"));
    }
    return Promise.resolve(
      run(() => {
        if (closed || device === null || linkState !== "ready") {
          return unlinkRefused("unavailable");
        }
        const held = ownLinkOf(repository.data);
        if (held === undefined) {
          return unlinkRefused("not_linked");
        }
        // It stops resolving at once, also when the write fails; another
        // account's link of the repository stays.
        dropLinks((entry) => entry === held);
        return Object.freeze({ outcome: "unlinked" } as const);
      }),
    );
  }

  /** The account's link of a repository and the mount of its folder now. */
  function located(repositoryId: RepositoryId):
    | {
        readonly link: RepositoryLink;
        readonly mountId: string;
        readonly mounted: MountedFolder;
      }
    | RepositoryFolderFailure {
    if (closed || device === null || linkState !== "ready") {
      return "unavailable";
    }
    const link = ownLinkOf(repositoryId);
    if (link === undefined) {
      return "not_linked";
    }
    const mountId = mountOf(link.folder);
    if (mountId === null) {
      return "not_mounted";
    }
    const mounted = mountedFolder(mountId);
    if (mounted === undefined) {
      return "not_mounted";
    }
    if (mounted.available !== true) {
      return "mount_unavailable";
    }
    return { link, mountId, mounted };
  }

  async function resolveFolder(
    value: unknown,
  ): Promise<RepositoryFolderResolution> {
    const parsed = RepositoryIdSchema.safeParse(value);
    if (!parsed.success) {
      return resolutionFailed("invalid");
    }
    const first = located(parsed.data);
    if (typeof first === "string") {
      return resolutionFailed(first);
    }
    const read = await identify(first.mounted);
    // Checked again: the link, the account, or the mount may have changed
    // while the folders were read.
    const second = located(parsed.data);
    if (typeof second === "string") {
      return resolutionFailed(second);
    }
    if (
      second.link !== first.link ||
      second.mountId !== first.mountId ||
      second.mounted.topLevel !== first.mounted.topLevel ||
      second.mounted.commonDir !== first.mounted.commonDir
    ) {
      return resolutionFailed("changed");
    }
    if (!read.ok) {
      // A folder that became a symbolic link or a junction was replaced.
      return resolutionFailed(
        read.reason === "symbolic_link" ? "changed_folder" : "folder_missing",
      );
    }
    if (!sameFolderIdentity(read.identity, second.link.identity)) {
      return resolutionFailed("changed_folder");
    }
    return Object.freeze({
      ok: true,
      repositoryId: parsed.data,
      folder: second.mounted.topLevel,
    });
  }

  const removers = [
    account.onStatusChange((status) => run(() => accountChanged(status))),
    connection.onStatusChange((status) =>
      run(() => connectionChanged(status.state)),
    ),
    connection.onMessage((message) => run(() => messageReceived(message))),
    workspaces.onChange((state) => run(() => follow(state))),
    mounts.onChange(() => run(touch)),
  ];
  accountChanged(account.status());
  connectionChanged(connection.status().state);
  // The first state is revision 0.
  dirty = false;
  current = buildState();

  void store.read().then(
    (result) => run(() => linksRead(result)),
    () => run(() => linksRead(null)),
  );

  return Object.freeze({
    state: () => current,
    onChange: (listener: (state: ProjectRepositoryState) => void) => {
      const entry = (state: ProjectRepositoryState) => listener(state);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    register: (projectValue: string, name: string) =>
      register(projectValue, name),
    remove: (projectValue: string, repositoryValue: string) =>
      remove(projectValue, repositoryValue),
    link: (repositoryValue: string, mountValue: string) =>
      link(repositoryValue, mountValue),
    unlink: (repositoryValue: string) => unlink(repositoryValue),
    resolveFolder: (value: unknown) => resolveFolder(value),
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const remove of removers) {
        remove();
      }
      listeners.clear();
      stopRetry();
      stopWriteRetry();
      gate.end();
      // A save that waits or failed is tried once more, after the writes on
      // their way; the quit does not wait for it.
      if (writePending && linkState === "ready") {
        void enqueue(writeCurrent);
      }
    },
  });
}
