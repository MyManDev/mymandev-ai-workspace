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
// - A removal drops every link of the repository at once, whoever made it:
//   the removal of this device, a removed event, and a reload of the project
//   that no longer lists it. A dropped link is never resolved again.
// - The path never leaves the main process: no state, log, or request holds
//   it. The renderer gets a mount ID for a linked folder while it is
//   mounted.
//
// The logs are fixed text with a failure code at most, never a name, an ID,
// or a path.
import {
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
import type { RepositoryService } from "../repositories.ts";
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
 * - `folder_missing`: the folder is no longer a folder.
 * - `changed`: the link or the mount changed while the folder was checked.
 */
export const REPOSITORY_FOLDER_FAILURES = Object.freeze([
  "invalid",
  "unavailable",
  "not_linked",
  "not_mounted",
  "folder_missing",
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
  /** Whether `folder` is a folder now (`isDirectory`). */
  readonly isFolder: (folder: string) => Promise<boolean>;
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
   * mount, for the signed-in account. The link applies once it is written.
   * Never rejects.
   */
  readonly link: (
    repositoryId: string,
    mountId: string,
  ) => Promise<LinkRepositoryResult>;
  /** Drops the signed-in account's link of a repository. Never rejects. */
  readonly unlink: (repositoryId: string) => Promise<UnlinkRepositoryResult>;
  /**
   * The folder of a repository for the enforcement point's callers: the
   * signed-in account's link, while its folder is mounted and still a
   * folder. It fails closed and never rejects. Call it for each action,
   * after the check allowed it, with the repository of the allowed request;
   * never keep the folder.
   */
  readonly resolveFolder: (
    repositoryId: unknown,
  ) => Promise<RepositoryFolderResolution>;
  /** Stops listening and cancels the timers, for the quit. */
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

function linkRefused(
  reason: Extract<LinkRepositoryResult, { outcome: "refused" }>["reason"],
): LinkRepositoryResult {
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

/**
 * A link as the service holds it: `seq` grows with every link made in this
 * run, and is 0 for one read from the file. A reload drops only the links
 * made before it was sent, so that an answer older than a registration
 * never drops that registration's new link.
 */
interface HeldLink {
  readonly link: RepositoryLink;
  readonly seq: number;
}

/** One reload that was sent, with what it was sent for. */
interface ReloadRequest {
  readonly epoch: number;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly generation: ResyncGeneration;
  /** The newest link `seq` when it was sent. */
  readonly linkSeq: number;
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

  // The links of every account on this device.
  let linkState: RepositoryLinkState = "loading";
  let links: readonly HeldLink[] = Object.freeze([]);
  let linkSeq = 0;
  /** Repositories removed while the file was read; dropped once it is. */
  const removedWhileLoading = new Set<RepositoryId>();
  /** The writes, one at a time, in the order they were asked for. */
  let writes: Promise<unknown> = Promise.resolve();

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
  function ownLinkOf(repositoryId: RepositoryId): HeldLink | undefined {
    if (linkState !== "ready") {
      return undefined;
    }
    return links.find(
      (held) => held.link.repositoryId === repositoryId && ownLink(held.link),
    );
  }

  function mountOf(folder: string): string | null {
    try {
      return mounts.mountOf(folder) ?? null;
    } catch {
      return null;
    }
  }

  function buildState(): ProjectRepositoryState {
    const entries =
      repositories === null
        ? NO_ENTRIES
        : Object.freeze(
            repositories.map((repository) => {
              const held = ownLinkOf(repository.id);
              return Object.freeze({
                repositoryId: repository.id,
                name: repository.name,
                linked: held !== undefined,
                mountId: held === undefined ? null : mountOf(held.link.folder),
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

  /**
   * Writes the links as they are when the write starts, after the writes
   * asked for before it, or what `snapshot` builds from them then. So a
   * write never puts back a link that a removal dropped while it waited.
   * Resolves true once written. Nothing is written unless the file was read
   * and is this build's.
   */
  function write(
    snapshot: () => readonly RepositoryLink[] = () =>
      links.map((held) => held.link),
  ): Promise<boolean> {
    const next = writes.then(async () => {
      // No caller writes before the links are ready; this keeps a later one
      // from writing over a file that was not read.
      if (linkState !== "ready") {
        return false;
      }
      try {
        await store.write(snapshot());
        return true;
      } catch {
        log("The repository links could not be written.");
        return false;
      }
    });
    writes = next;
    return next;
  }

  /**
   * Drops every link, of any account, that `drop` names, and writes the
   * rest. The links stop resolving at once, also when the write fails.
   */
  function dropLinks(drop: (held: HeldLink) => boolean): void {
    const kept = links.filter((held) => !drop(held));
    if (kept.length === links.length) {
      return;
    }
    links = Object.freeze(kept);
    touch();
    void write();
  }

  /** A repository was removed: every link of it goes, whoever made it. */
  function repositoryRemoved(repositoryId: RepositoryId): void {
    if (linkState === "loading") {
      removedWhileLoading.add(repositoryId);
      return;
    }
    dropLinks((held) => held.link.repositoryId === repositoryId);
  }

  /**
   * Drops the links of `forProject` made before `seq` whose repository the
   * project's list no longer holds: it was removed meanwhile.
   */
  function reconcile(
    forProject: ProjectId,
    listed: readonly ProjectRepository[],
    seq: number,
  ): void {
    if (linkState !== "ready") {
      return;
    }
    const ids = new Set<string>(listed.map((repository) => repository.id));
    dropLinks(
      (held) =>
        held.link.projectId === forProject &&
        held.seq <= seq &&
        !ids.has(held.link.repositoryId),
    );
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
      removedWhileLoading.clear();
      touch();
      return;
    }
    if (result.kind === "corrupt") {
      log("The repository links file is not valid; it is replaced.");
    }
    const read = result.kind === "links" ? result.links : [];
    linkState = "ready";
    links = Object.freeze(
      read
        .filter((link) => !removedWhileLoading.has(link.repositoryId))
        .map((link) => Object.freeze({ link, seq: 0 })),
    );
    const dropped =
      removedWhileLoading.size > 0 && links.length !== read.length;
    removedWhileLoading.clear();
    touch();
    if (dropped) {
      void write();
    }
    if (projectId !== null && repositories !== null) {
      reconcile(projectId, repositories, 0);
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
      linkSeq,
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
    repositories = Object.freeze([...listed]);
    problem = null;
    attempt = 0;
    touch();
    reconcile(request.projectId, listed, request.linkSeq);
    applyEvents(events);
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
      if (repositories === null) {
        return;
      }
      if (event.type === "workspace.repository.registered") {
        const { repository } = event.payload;
        if (
          repository.projectId === projectId &&
          !repositories.some((held) => held.id === repository.id)
        ) {
          repositories = Object.freeze([...repositories, repository]);
          touch();
        }
        continue;
      }
      const { projectId: removedFrom, repositoryId } = event.payload;
      if (
        removedFrom === projectId &&
        repositories.some((held) => held.id === repositoryId)
      ) {
        repositories = Object.freeze(
          repositories.filter((held) => held.id !== repositoryId),
        );
        touch();
      }
    }
  }

  function eventReceived(event: ReceivedServerEvent): void {
    if (!isRepositoryEvent(event) || event.workspaceId !== workspaceId) {
      return;
    }
    if (event.type === "workspace.repository.removed") {
      // The links go at once, of every project of the workspace.
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
      return failedResult(REMOVE_OUTCOMES, answer);
    }
    run(() => {
      repositoryRemoved(repository.data);
      if (projectId === target && repositories !== null) {
        const kept = repositories.filter((held) => held.id !== repository.data);
        if (kept.length !== repositories.length) {
          repositories = Object.freeze(kept);
          touch();
        }
      }
    });
    return Object.freeze({ outcome: "ok" });
  }

  /**
   * The link that `link` would add, or why it is refused. It replaces the
   * account's earlier link of the repository, if any.
   */
  function proposedLink(
    repositoryId: RepositoryId,
    mountId: string,
  ):
    | { readonly link: RepositoryLink; readonly replaces: HeldLink | undefined }
    | Extract<LinkRepositoryResult, { outcome: "refused" }>["reason"] {
    if (closed || device === null || linkState !== "ready") {
      return "unavailable";
    }
    if (
      workspaceId === null ||
      projectId === null ||
      repositories === null ||
      !repositories.some((repository) => repository.id === repositoryId)
    ) {
      return "not_registered";
    }
    let ownMemberId;
    try {
      ownMemberId = workspaces.ownMemberId(workspaceId);
    } catch {
      ownMemberId = null;
    }
    if (ownMemberId === null) {
      return "unavailable";
    }
    let folder: string | undefined;
    try {
      folder = mounts.folderOf(mountId);
    } catch {
      folder = undefined;
    }
    if (folder === undefined) {
      return "not_mounted";
    }
    const replaces = ownLinkOf(repositoryId);
    const elsewhere = links.some(
      (held) =>
        held !== replaces &&
        ownLink(held.link) &&
        mountOf(held.link.folder) === mountId,
    );
    if (elsewhere) {
      return "folder_linked";
    }
    if (replaces === undefined && links.length >= MAX_REPOSITORY_LINKS) {
      return "limit";
    }
    return {
      link: Object.freeze({
        workspaceId,
        ownMemberId,
        projectId,
        repositoryId,
        folder,
      }),
      replaces,
    };
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
    const proposed = proposedLink(repository.data, mount.data);
    if (typeof proposed === "string") {
      return linkRefused(proposed);
    }
    // The links when the write starts, without the account's earlier link
    // of the repository, and the new one last.
    const written = await write(() => [
      ...links
        .filter(
          (held) =>
            !(
              held.link.repositoryId === proposed.link.repositoryId &&
              held.link.workspaceId === proposed.link.workspaceId &&
              held.link.ownMemberId === proposed.link.ownMemberId
            ),
        )
        .map((held) => held.link),
      proposed.link,
    ]);
    if (!written) {
      // The file keeps what it held; a later write puts the links in it.
      return linkRefused("failed");
    }
    return run(() => {
      // Checked again: a removal, a sign-out, or another link may have come
      // while the link was written. The file is then written again without
      // it.
      const again = proposedLink(repository.data, mount.data);
      if (
        typeof again === "string" ||
        again.link.folder !== proposed.link.folder ||
        again.link.ownMemberId !== proposed.link.ownMemberId ||
        again.link.projectId !== proposed.link.projectId
      ) {
        void write();
        return linkRefused(typeof again === "string" ? again : "failed");
      }
      linkSeq += 1;
      links = Object.freeze([
        ...links.filter((held) => held !== again.replaces),
        Object.freeze({ link: again.link, seq: linkSeq }),
      ]);
      touch();
      return Object.freeze({ outcome: "linked" } as const);
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
        // It stops resolving at once, also when the write fails.
        dropLinks((entry) => entry === held);
        return Object.freeze({ outcome: "unlinked" } as const);
      }),
    );
  }

  /** The account's link of a repository and the mount of its folder now. */
  function located(repositoryId: RepositoryId):
    | {
        readonly held: HeldLink;
        readonly mountId: string;
        readonly folder: string;
      }
    | RepositoryFolderFailure {
    if (closed || device === null || linkState !== "ready") {
      return "unavailable";
    }
    const held = ownLinkOf(repositoryId);
    if (held === undefined) {
      return "not_linked";
    }
    const mountId = mountOf(held.link.folder);
    if (mountId === null) {
      return "not_mounted";
    }
    let folder: string | undefined;
    try {
      folder = mounts.folderOf(mountId);
    } catch {
      folder = undefined;
    }
    return folder === undefined ? "not_mounted" : { held, mountId, folder };
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
    let exists: boolean;
    try {
      exists = (await options.isFolder(first.folder)) === true;
    } catch {
      exists = false;
    }
    // Checked again: the link, the account, or the mount may have changed
    // while the folder was checked.
    const second = located(parsed.data);
    if (typeof second === "string") {
      return resolutionFailed(second);
    }
    if (
      second.held !== first.held ||
      second.mountId !== first.mountId ||
      second.folder !== first.folder
    ) {
      return resolutionFailed("changed");
    }
    if (!exists) {
      return resolutionFailed("folder_missing");
    }
    return Object.freeze({
      ok: true,
      repositoryId: parsed.data,
      folder: second.folder,
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
      gate.end();
    },
  });
}
