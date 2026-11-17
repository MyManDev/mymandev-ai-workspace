import {
  decodeServerMessage,
  type ProjectId,
  REPOSITORY_ROUTE_ERRORS,
  RepositoryListResponseSchema,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import type {
  AccountStatus,
  ConnectionStatus,
} from "../../shared/ipc-contract.ts";
import {
  WORKSPACE_ACTION_FAILURES,
  workspaceActionFailed,
  type WorkspaceActionFailure,
  workspaceActionFailureOf,
} from "../api-actions.ts";
import type { WorkspaceReadResult } from "../api-reads.ts";
import type { ServerMessage } from "../connection/client.ts";
import type { WorkspaceState } from "../workspace/service.ts";
import type { LinkConfirmationRequest } from "./confirmation.ts";
import type { RepositoryFolderIdentity } from "./identity.ts";
import {
  MAX_REPOSITORY_LINKS,
  type RepositoryLink,
  type RepositoryLinkRead,
} from "./link-store.ts";
import {
  createProjectRepositoryService,
  LINK_CANCEL_PAUSE_MS,
  LINK_WRITE_RETRY_FIRST_MS,
  LINK_WRITE_RETRY_MAX_MS,
  linkWriteRetryDelayMs,
  type ProjectRepositoryAccount,
  type ProjectRepositoryService,
  type ProjectRepositoryState,
} from "./service.ts";

const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const WS_A = "0192f0a0-7b3c-7d4e-8f50-0000000000a1" as WorkspaceId;
const WS_B = "0192f0a0-7b3c-7d4e-8f50-0000000000a2" as WorkspaceId;
const WS_GONE = "0192f0a0-7b3c-7d4e-8f50-0000000000a3" as WorkspaceId;
const OWN = "0192f0a0-7b3c-7d4e-8f50-0000000000c1";
const OTHER_OWN = "0192f0a0-7b3c-7d4e-8f50-0000000000c2";
const PROJECT_1 = "0192f0a0-7b3c-7d4e-8f50-0000000000e1" as ProjectId;
const PROJECT_2 = "0192f0a0-7b3c-7d4e-8f50-0000000000e2" as ProjectId;
const REPO_1 = "0192f0a0-7b3c-7d4e-8f50-0000000000f1";
const REPO_2 = "0192f0a0-7b3c-7d4e-8f50-0000000000f2";
const REPO_3 = "0192f0a0-7b3c-7d4e-8f50-0000000000f3";
const MOUNT_1 = "0b9e2f7c-5d0a-4c8e-9f3b-000000000001";
const MOUNT_2 = "0b9e2f7c-5d0a-4c8e-9f3b-000000000002";
const FOLDER_1 = "/home/octocat/secret-web";
const FOLDER_2 = "/home/octocat/secret-api";
const AT = "2026-11-17T10:00:00.000Z";

/** Every value that no log may hold. */
const SECRETS = [
  "secret",
  "octocat",
  "web app",
  REPO_1,
  REPO_2,
  PROJECT_1,
  WS_A,
  OWN,
];

function accountStatus(
  signedIn = true,
  deviceKey: AccountStatus["deviceKey"] = "ready",
): AccountStatus {
  return Object.freeze({
    revision: 1,
    account: signedIn
      ? Object.freeze({
          kind: "signed_in",
          login: "octocat",
          displayName: "The Octocat",
          deviceId: DEVICE_ID,
          signInExpiresAt: "2026-12-17T10:00:00.000Z",
        })
      : Object.freeze({ kind: "signed_out" }),
    signIn: Object.freeze({ kind: "idle" }),
    lastOutcome: null,
    deviceKey,
    replacementPending: false,
    apiOrigin: "set",
    device: signedIn ? "signed_in" : "signed_out",
  }) as AccountStatus;
}

function repository(
  id: string,
  projectId: ProjectId = PROJECT_1,
  name = "web app",
) {
  return { id, projectId, name, createdByMemberId: OWN };
}

function list(...repositories: ReturnType<typeof repository>[]) {
  return RepositoryListResponseSchema.parse({ repositories });
}

/** The identity of a folder in the fake file system, until a test changes it. */
function identityOf(folder: string, generation = 0): RepositoryFolderIdentity {
  const ino = [...folder].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return {
    folder: { dev: "2049", ino: String(ino * 10 + generation) },
    commonDir: { dev: "2049", ino: String(ino * 10 + generation + 5) },
  };
}

function linkOf(
  repositoryId: string,
  folder: string,
  overrides: Partial<RepositoryLink> = {},
): RepositoryLink {
  return {
    workspaceId: WS_A,
    ownMemberId: OWN,
    projectId: PROJECT_1,
    repositoryId,
    folder,
    identity: identityOf(folder),
    ...overrides,
  } as RepositoryLink;
}

function frame(input: Record<string, unknown>): ServerMessage {
  const decoded = decodeServerMessage({ protocolVersion: 0, ...input });
  if (!decoded.ok || decoded.kind !== "frame") {
    throw new Error("The test frame does not decode");
  }
  return { kind: "frame", frame: decoded.frame };
}

function subscribed(workspaceId: WorkspaceId = WS_A): ServerMessage {
  return frame({
    type: "workspace.subscribed",
    workspaceId,
    onlineMemberIds: [OWN],
  });
}

let eventCount = 0;

function event(
  type: string,
  payload: Record<string, unknown>,
  workspaceId: WorkspaceId = WS_A,
): ServerMessage {
  eventCount += 1;
  const decoded = decodeServerMessage({
    protocolVersion: 0,
    id: `0192f0a0-7b3c-7d4e-8f50-${eventCount.toString(16).padStart(12, "0")}`,
    occurredAt: AT,
    workspaceId,
    actor: { kind: "system" },
    deviceId: null,
    type,
    payload,
  });
  if (!decoded.ok || decoded.kind !== "event") {
    throw new Error("The test event does not decode");
  }
  return { kind: "event", event: decoded.event };
}

function registeredEvent(repo: ReturnType<typeof repository>): ServerMessage {
  return event("workspace.repository.registered", { repository: repo });
}

function removedEvent(
  repositoryId: string,
  projectId: ProjectId = PROJECT_1,
  workspaceId: WorkspaceId = WS_A,
): ServerMessage {
  return event(
    "workspace.repository.removed",
    { projectId, repositoryId },
    workspaceId,
  );
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve();
  }
}

interface Read {
  readonly name: string;
  readonly params: unknown;
  readonly answer: (result: WorkspaceReadResult<unknown>) => void;
}

interface Write {
  readonly name: string;
  readonly params: unknown;
  readonly body: unknown[];
  readonly answer: (result: unknown) => void;
}

interface HarnessOptions {
  readonly read?: () => Promise<RepositoryLinkRead>;
  readonly caseInsensitive?: boolean;
}

class Harness {
  accountStatus = accountStatus();
  connectionStatus: ConnectionStatus = { state: "offline", revision: 0 };
  workspaceState: WorkspaceState = Object.freeze({
    revision: 0,
    status: "ready",
    workspaces: [],
    selectedWorkspaceId: null,
    projects: [],
    openProjectId: null,
  });
  readonly ownMembers = new Map<string, string>([
    [WS_A, OWN],
    [WS_B, OWN],
  ]);
  readonly mounts = new Map<string, string>();
  /** Mounts whose state is `unavailable`. */
  readonly unavailableMounts = new Set<string>();
  /** The folders that exist; each top-level folder's `.git` with it. */
  readonly folders = new Set<string>([FOLDER_1, FOLDER_2]);
  /** Identities that a test changed, or a folder that became a link. */
  readonly identities = new Map<string, RepositoryFolderIdentity | "link">();
  readonly accountListeners = new Set<(status: AccountStatus) => void>();
  readonly connectionListeners = new Set<(status: ConnectionStatus) => void>();
  readonly messageListeners = new Set<(message: ServerMessage) => void>();
  readonly workspaceListeners = new Set<(state: WorkspaceState) => void>();
  readonly mountListeners = new Set<() => void>();
  readonly reads: Read[] = [];
  readonly writes: Write[] = [];
  /** Each snapshot that the store was asked to write, also a failed one. */
  readonly written: (readonly RepositoryLink[])[] = [];
  /** What the file holds: the last snapshot that was written. */
  stored: readonly RepositoryLink[] | null = null;
  failWrites = 0;
  /** Makes the account service's next write throw. */
  throwOnAction = false;
  holdWrite: Deferred<void> | null = null;
  holdFolderCheck: Deferred<void> | null = null;
  /** Each confirmation that the service asked for. */
  readonly confirmations: LinkConfirmationRequest[] = [];
  /** The signal that the service passed with each confirmation. */
  readonly confirmSignals: AbortSignal[] = [];
  confirmAnswer = true;
  holdConfirm: Deferred<boolean> | null = null;
  throwOnConfirm = false;
  readonly timers: { callback: () => void; delayMs: number }[] = [];
  readonly logs: string[] = [];
  readonly states: ProjectRepositoryState[] = [];
  readonly service: ProjectRepositoryService;

  constructor(options: HarnessOptions = {}) {
    const key = (folder: string) =>
      options.caseInsensitive === true ? folder.toLowerCase() : folder;
    const account = {
      status: () => this.accountStatus,
      onStatusChange: (listener: (status: AccountStatus) => void) => {
        this.accountListeners.add(listener);
        return () => this.accountListeners.delete(listener);
      },
      readWorkspaceData: (name: string, params: unknown) =>
        new Promise((resolve) => {
          this.reads.push({ name, params, answer: resolve });
        }),
      sendWorkspaceAction: (
        name: string,
        params: unknown,
        ...body: unknown[]
      ) =>
        this.throwOnAction
          ? Promise.reject(new Error(`web app ${FOLDER_1}`))
          : new Promise((resolve) => {
              this.writes.push({ name, params, body, answer: resolve });
            }),
    } as unknown as ProjectRepositoryAccount;
    this.service = createProjectRepositoryService({
      account,
      connection: {
        status: () => this.connectionStatus,
        onStatusChange: (listener) => {
          this.connectionListeners.add(listener);
          return () => this.connectionListeners.delete(listener);
        },
        onMessage: (listener) => {
          this.messageListeners.add(listener);
          return () => this.messageListeners.delete(listener);
        },
      },
      workspaces: {
        state: () => this.workspaceState,
        onChange: (listener) => {
          this.workspaceListeners.add(listener);
          return () => this.workspaceListeners.delete(listener);
        },
        ownMemberId: (workspaceId) =>
          (this.ownMembers.get(workspaceId) ?? null) as never,
      },
      mounts: {
        folderOf: (mountId) => {
          const folder = this.mounts.get(mountId);
          return folder === undefined
            ? undefined
            : {
                topLevel: folder,
                commonDir: `${folder}/.git`,
                available: !this.unavailableMounts.has(mountId),
              };
        },
        mountOf: (folder) => {
          for (const [mountId, mounted] of this.mounts) {
            if (key(mounted) === key(folder)) {
              return mountId;
            }
          }
          return undefined;
        },
        onChange: (listener) => {
          const entry = () => listener({ revision: 0, repositories: [] });
          this.mountListeners.add(entry);
          return () => this.mountListeners.delete(entry);
        },
      },
      store: {
        read: options.read ?? (() => Promise.resolve({ kind: "none" })),
        write: async (links) => {
          this.written.push(links);
          if (this.holdWrite !== null) {
            await this.holdWrite.promise;
          }
          if (this.failWrites > 0) {
            this.failWrites -= 1;
            throw new Error(`write failed ${JSON.stringify(links)}`);
          }
          this.stored = links;
        },
      },
      identify: async ({ topLevel, commonDir }) => {
        if (this.holdFolderCheck !== null) {
          await this.holdFolderCheck.promise;
        }
        expect(commonDir).toBe(`${topLevel}/.git`);
        if (!this.folders.has(topLevel)) {
          return { ok: false, reason: "folder_missing" };
        }
        const identity = this.identities.get(topLevel) ?? identityOf(topLevel);
        return identity === "link"
          ? { ok: false, reason: "symbolic_link" }
          : { ok: true, identity };
      },
      confirmLink: async (request, signal) => {
        this.confirmations.push(request);
        this.confirmSignals.push(signal);
        if (this.throwOnConfirm) {
          throw new Error(`web app ${FOLDER_1}`);
        }
        if (this.holdConfirm !== null) {
          return this.holdConfirm.promise;
        }
        return this.confirmAnswer;
      },
      scheduleTimer: (callback, delayMs) => {
        const timer = { callback, delayMs };
        this.timers.push(timer);
        return () => {
          const index = this.timers.indexOf(timer);
          if (index >= 0) {
            this.timers.splice(index, 1);
          }
        };
      },
      log: (message) => this.logs.push(message),
    });
    this.service.onChange((state) => this.states.push(state));
  }

  get state(): ProjectRepositoryState {
    return this.service.state();
  }

  setAccount(status: AccountStatus): void {
    this.accountStatus = status;
    for (const listener of [...this.accountListeners]) {
      listener(status);
    }
  }

  open(workspaceId: WorkspaceId | null, projectId: ProjectId | null): void {
    this.workspaceState = Object.freeze({
      ...this.workspaceState,
      revision: this.workspaceState.revision + 1,
      selectedWorkspaceId: workspaceId,
      openProjectId: projectId,
    });
    for (const listener of [...this.workspaceListeners]) {
      listener(this.workspaceState);
    }
  }

  connect(): void {
    this.connectionStatus = { state: "connected", revision: 1 };
    for (const listener of [...this.connectionListeners]) {
      listener(this.connectionStatus);
    }
  }

  disconnect(): void {
    this.connectionStatus = { state: "offline", revision: 2 };
    for (const listener of [...this.connectionListeners]) {
      listener(this.connectionStatus);
    }
  }

  deliver(message: ServerMessage): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  mount(mountId: string, folder: string): void {
    this.mounts.set(mountId, folder);
    for (const listener of [...this.mountListeners]) {
      listener();
    }
  }

  unmount(mountId: string): void {
    this.mounts.delete(mountId);
    for (const listener of [...this.mountListeners]) {
      listener();
    }
  }

  /** Answers the latest read. */
  async answerRead(result: WorkspaceReadResult<unknown>): Promise<void> {
    const read = this.reads.at(-1);
    if (read === undefined) {
      throw new Error("No read waits");
    }
    read.answer(result);
    await settle();
  }

  /** Opens PROJECT_1 of WS_A, connected, with its repositories loaded. */
  async ready(...repositories: ReturnType<typeof repository>[]): Promise<void> {
    await settle();
    this.connect();
    this.open(WS_A, null);
    this.deliver(subscribed());
    this.open(WS_A, PROJECT_1);
    await this.answerRead({ ok: true, value: list(...repositories) });
  }

  /** The last links written. */
  lastWritten(): readonly RepositoryLink[] | undefined {
    return this.written.at(-1);
  }

  /** Runs the timers that wait now, the earliest first. */
  runTimers(): void {
    const due = [...this.timers].sort((a, b) => a.delayMs - b.delayMs);
    this.timers.length = 0;
    for (const timer of due) {
      timer.callback();
    }
  }
}

function expectNoSecretInLogs(harness: Harness): void {
  const text = harness.logs.join("\n");
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
  }
}

// Loading the open project's repositories.

test("the open project's repositories load when it opens and after each workspace.subscribed, with no path in the state", async () => {
  const harness = new Harness();
  await settle();
  expect(harness.state).toMatchObject({
    status: "no_project",
    projectId: null,
    links: "ready",
    repositories: [],
  });
  expect(harness.reads).toHaveLength(0);

  harness.connect();
  harness.open(WS_A, PROJECT_1);
  expect(harness.state.status).toBe("loading");
  expect(harness.reads).toEqual([
    expect.objectContaining({
      name: "listRepositories",
      params: { projectId: PROJECT_1 },
    }),
  ]);
  await harness.answerRead({ ok: true, value: list(repository(REPO_1)) });
  expect(harness.state).toMatchObject({
    status: "ready",
    workspaceId: WS_A,
    projectId: PROJECT_1,
    repositories: [
      { repositoryId: REPO_1, name: "web app", linked: false, mountId: null },
    ],
  });

  harness.deliver(subscribed());
  expect(harness.reads).toHaveLength(2);
  await harness.answerRead({
    ok: true,
    value: list(repository(REPO_1), repository(REPO_2)),
  });
  expect(harness.state.repositories.map((entry) => entry.repositoryId)).toEqual(
    [REPO_1, REPO_2],
  );
  expect(Object.isFrozen(harness.state)).toBe(true);
  expect(JSON.stringify(harness.states)).not.toContain("secret");
});

test("a failed load shows its problem, keeps what was loaded, and is retried; an answer for another project fails", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));

  harness.deliver(subscribed());
  await harness.answerRead({ ok: false, reason: "unavailable" });
  expect(harness.state).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
    repositories: [{ repositoryId: REPO_1 }],
  });
  expect(harness.timers).toHaveLength(1);
  harness.timers[0]?.callback();
  expect(harness.reads).toHaveLength(3);
  await harness.answerRead({
    ok: true,
    value: list(repository(REPO_2, PROJECT_2)),
  });
  expect(harness.state).toMatchObject({
    status: "unavailable",
    problem: "failed",
  });
  expectNoSecretInLogs(harness);
});

test("a registered event adds the repository and a removed event drops it, after the reload when they arrive during it", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));

  harness.deliver(registeredEvent(repository(REPO_2)));
  // Another project's repository is not listed.
  harness.deliver(registeredEvent(repository(REPO_3, PROJECT_2)));
  await settle();
  expect(harness.state.repositories.map((entry) => entry.repositoryId)).toEqual(
    [REPO_1, REPO_2],
  );

  harness.deliver(subscribed());
  harness.deliver(removedEvent(REPO_1));
  // Buffered until the reload answers.
  expect(harness.state.repositories).toHaveLength(2);
  await harness.answerRead({
    ok: true,
    value: list(repository(REPO_1), repository(REPO_2)),
  });
  expect(harness.state.repositories.map((entry) => entry.repositoryId)).toEqual(
    [REPO_2],
  );
});

test("a sign-out, another workspace, or another project clears the repositories and drops the answers on their way", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));

  harness.open(WS_A, PROJECT_2);
  expect(harness.state).toMatchObject({
    status: "loading",
    projectId: PROJECT_2,
    repositories: [],
  });
  harness.open(WS_A, PROJECT_1);
  // The answer for PROJECT_2 is dropped.
  harness.reads[1]?.answer({ ok: true, value: list() });
  await settle();
  expect(harness.state.status).toBe("loading");

  harness.setAccount(accountStatus(false));
  expect(harness.state).toMatchObject({
    status: "no_project",
    projectId: null,
    repositories: [],
  });
  harness.reads[2]?.answer({ ok: true, value: list(repository(REPO_1)) });
  await settle();
  expect(harness.state.repositories).toEqual([]);
});

test("a device counts as signed in only with its key ready: until then nothing loads, links, or resolves", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);
  const reads = harness.reads.length;

  for (const deviceKey of [
    "loading",
    "passphrase_required",
    "unreadable",
    "failed",
  ] as const) {
    harness.setAccount(accountStatus(true, deviceKey));
    expect(harness.state, deviceKey).toMatchObject({
      status: "no_project",
      projectId: null,
      repositories: [],
    });
    await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
      outcome: "refused",
      reason: "unavailable",
    });
    await expect(harness.service.unlink(REPO_1)).resolves.toEqual({
      outcome: "refused",
      reason: "unavailable",
    });
  }
  expect(harness.reads).toHaveLength(reads);

  // With the key ready again, the project loads and the link resolves.
  harness.setAccount(accountStatus(true, "ready"));
  expect(harness.reads).toHaveLength(reads + 1);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toMatchObject({
    ok: true,
  });
});

// Registering and removing.

test("register sends only the name to the open project and maps every outcome; it never adds to the list itself", async () => {
  const harness = new Harness();
  await harness.ready();

  const answer = harness.service.register(PROJECT_1, "web app");
  expect(harness.writes).toEqual([
    expect.objectContaining({
      name: "registerRepository",
      params: { projectId: PROJECT_1 },
      body: [{ name: "web app" }],
    }),
  ]);
  harness.writes[0]?.answer({
    ok: true,
    value: { repository: repository(REPO_1) },
  });
  await expect(answer).resolves.toEqual({
    outcome: "ok",
    repositoryId: REPO_1,
  });
  expect(harness.state.repositories).toEqual([]);
  harness.deliver(registeredEvent(repository(REPO_1)));
  expect(harness.state.repositories).toHaveLength(1);

  // An answer for another project is not this write's.
  const other = harness.service.register(PROJECT_1, "web app");
  harness.writes[1]?.answer({
    ok: true,
    value: { repository: repository(REPO_2, PROJECT_2) },
  });
  await expect(other).resolves.toEqual({ outcome: "unknown" });

  // Refused before anything is sent.
  await expect(harness.service.register(PROJECT_2, "web")).resolves.toEqual({
    outcome: "refused",
    reason: "not_open",
    retryAfterMs: null,
  });
  await expect(harness.service.register("project", "web")).resolves.toEqual({
    outcome: "refused",
    reason: "invalid",
    retryAfterMs: null,
  });
  expect(harness.writes).toHaveLength(2);
});

test("every failure of register and remove maps to a fixed refusal, repository_limit without a wait, and every code of their routes to its own", async () => {
  const expectedRegister: Record<WorkspaceActionFailure, string> = {
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
  };
  const expectedRemove: Record<WorkspaceActionFailure, string> = {
    ...expectedRegister,
    forbidden: "forbidden",
    repository_limit: "failed",
  };
  const harness = new Harness();
  await harness.ready(repository(REPO_1));

  for (const reason of WORKSPACE_ACTION_FAILURES) {
    const failure =
      reason === "too_soon" || reason === "rate_limited"
        ? workspaceActionFailed(reason, 2_000)
        : workspaceActionFailed(reason);
    const wait =
      reason === "too_soon" || reason === "rate_limited" ? 2_000 : null;
    for (const [call, expected] of [
      [() => harness.service.register(PROJECT_1, "web"), expectedRegister],
      [() => harness.service.remove(PROJECT_1, REPO_1), expectedRemove],
    ] as const) {
      const answer = call();
      harness.writes.at(-1)?.answer(failure);
      const outcome = expected[reason];
      await expect(answer, reason).resolves.toEqual(
        outcome === "unknown"
          ? { outcome: "unknown" }
          : { outcome: "refused", reason: outcome, retryAfterMs: wait },
      );
    }
  }
  for (const [route, expected] of [
    ["registerRepository", expectedRegister],
    ["removeRepository", expectedRemove],
  ] as const) {
    for (const code of REPOSITORY_ROUTE_ERRORS[route]) {
      if (code !== "bad_request" && code !== "internal_error") {
        const failure = workspaceActionFailureOf({
          ok: false,
          reason: "refused",
          code,
        });
        expect(expected[failure], `${route} ${code}`).not.toBe("failed");
      }
    }
  }
  // Nothing that failed changed the list or the links.
  expect(harness.state.repositories).toHaveLength(1);

  // A write that throws is unknown, with a fixed log.
  harness.throwOnAction = true;
  await expect(harness.service.register(PROJECT_1, "web app")).resolves.toEqual(
    { outcome: "unknown" },
  );
  await expect(harness.service.remove(PROJECT_1, REPO_1)).resolves.toEqual({
    outcome: "unknown",
  });
  expect(harness.logs).toEqual([
    "Registering a repository could not be sent.",
    "Removing a repository could not be sent.",
  ]);
  expectNoSecretInLogs(harness);
});

test("remove drops the repository and every link of it at once, and writes the links", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1), repository(REPO_2));
  harness.mount(MOUNT_1, FOLDER_1);
  harness.mount(MOUNT_2, FOLDER_2);
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "linked",
  });
  await harness.service.link(REPO_2, MOUNT_2);

  const answer = harness.service.remove(PROJECT_1, REPO_1);
  expect(harness.writes.at(-1)).toMatchObject({
    name: "removeRepository",
    params: { projectId: PROJECT_1, repositoryId: REPO_1 },
    body: [],
  });
  harness.writes.at(-1)?.answer({ ok: true, value: null });
  await expect(answer).resolves.toEqual({ outcome: "ok" });
  await settle();

  expect(harness.state.repositories.map((entry) => entry.repositoryId)).toEqual(
    [REPO_2],
  );
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });
  expect(harness.lastWritten()).toEqual([linkOf(REPO_2, FOLDER_2)]);
  await expect(harness.service.remove(PROJECT_2, REPO_2)).resolves.toEqual({
    outcome: "refused",
    reason: "not_open",
    retryAfterMs: null,
  });
  await expect(harness.service.remove(PROJECT_1, "r")).resolves.toEqual({
    outcome: "refused",
    reason: "invalid",
    retryAfterMs: null,
  });
});

test("a removal answered conflict or not_found reads the list again, which drops a repository that is gone and its links; other refusals do not", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1), repository(REPO_2));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);

  for (const reason of ["forbidden", "unavailable", "failed"] as const) {
    const reads = harness.reads.length;
    const answer = harness.service.remove(PROJECT_1, REPO_1);
    harness.writes.at(-1)?.answer(workspaceActionFailed(reason));
    await answer;
    await settle();
    expect(harness.reads, reason).toHaveLength(reads);
  }

  for (const reason of ["conflict", "not_found"] as const) {
    const reads = harness.reads.length;
    const answer = harness.service.remove(PROJECT_1, REPO_2);
    harness.writes.at(-1)?.answer(workspaceActionFailed(reason));
    await expect(answer).resolves.toMatchObject({ reason });
    await settle();
    expect(harness.reads, reason).toHaveLength(reads + 1);
    expect(harness.reads.at(-1)).toMatchObject({
      name: "listRepositories",
      params: { projectId: PROJECT_1 },
    });
    await harness.answerRead({
      ok: true,
      value: list(repository(REPO_1), repository(REPO_2)),
    });
  }

  // Removed by someone else: the list no longer holds REPO_1.
  const answer = harness.service.remove(PROJECT_1, REPO_1);
  harness.writes.at(-1)?.answer(workspaceActionFailed("conflict"));
  await answer;
  await harness.answerRead({ ok: true, value: list(repository(REPO_2)) });
  expect(harness.state.repositories.map((entry) => entry.repositoryId)).toEqual(
    [REPO_2],
  );
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });
  expect(harness.lastWritten()).toEqual([]);
});

// Linking.

test("link asks the person in the main process's dialog, naming the repository and the folder, and keeps the folder and its identity for the account; the state shows the mount, never the path", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);

  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "linked",
  });
  expect(harness.confirmations).toEqual([
    { name: "web app", folder: FOLDER_1 },
  ]);
  expect(harness.written).toEqual([[linkOf(REPO_1, FOLDER_1)]]);
  expect(harness.lastWritten()?.[0]?.identity).toEqual(identityOf(FOLDER_1));
  expect(harness.state.repositories).toEqual([
    { repositoryId: REPO_1, name: "web app", linked: true, mountId: MOUNT_1 },
  ]);
  expect(JSON.stringify(harness.states)).not.toContain(FOLDER_1);
  expect(JSON.stringify(harness.states)).not.toContain(
    identityOf(FOLDER_1).folder.ino,
  );

  // Unmounted, it stays linked without a mount; mounted again, it shows.
  harness.unmount(MOUNT_1);
  expect(harness.state.repositories[0]).toMatchObject({
    linked: true,
    mountId: null,
  });
  harness.mount(MOUNT_2, FOLDER_1);
  expect(harness.state.repositories[0]).toMatchObject({ mountId: MOUNT_2 });

  // Linking it to another folder replaces the link, after another question.
  harness.mount(MOUNT_1, FOLDER_2);
  await harness.service.link(REPO_1, MOUNT_1);
  expect(harness.confirmations.at(-1)).toEqual({
    name: "web app",
    folder: FOLDER_2,
  });
  expect(harness.lastWritten()).toEqual([linkOf(REPO_1, FOLDER_2)]);
  expect(harness.state.repositories[0]).toMatchObject({ mountId: MOUNT_1 });
});

test("a link that the person cancels, or whose dialog fails, links and writes nothing", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);

  harness.confirmAnswer = false;
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "cancelled",
  });
  // The pause after the cancel ends.
  harness.runTimers();
  harness.confirmAnswer = true;
  harness.throwOnConfirm = true;
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "failed",
  });
  expect(harness.confirmations).toHaveLength(2);
  expect(harness.written).toEqual([]);
  expect(harness.state.repositories[0]).toMatchObject({ linked: false });
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });
  expect(harness.logs).toEqual(["The link confirmation could not be shown."]);
  expectNoSecretInLogs(harness);
});

test("one link is confirmed at a time: another link while the dialog is open is busy", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1), repository(REPO_2));
  harness.mount(MOUNT_1, FOLDER_1);
  harness.mount(MOUNT_2, FOLDER_2);
  harness.holdConfirm = deferred();
  const hold = harness.holdConfirm;

  const first = harness.service.link(REPO_1, MOUNT_1);
  await settle();
  await expect(harness.service.link(REPO_2, MOUNT_2)).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  expect(harness.confirmations).toHaveLength(1);
  harness.holdConfirm = null;
  hold.resolve(true);
  await expect(first).resolves.toEqual({ outcome: "linked" });
  await expect(harness.service.link(REPO_2, MOUNT_2)).resolves.toEqual({
    outcome: "linked",
  });
});

test("a folder that is a symbolic link or a junction, or that cannot be read, is refused before the person is asked", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);

  harness.identities.set(FOLDER_1, "link");
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "symbolic_link",
  });
  harness.identities.delete(FOLDER_1);
  harness.folders.delete(FOLDER_1);
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "folder_missing",
  });
  expect(harness.confirmations).toEqual([]);
  expect(harness.written).toEqual([]);
});

test("what the person confirmed must still hold when the link is written: another account or a removal during the dialog, or a sign-out after it, links nothing", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1), repository(REPO_2));
  harness.mount(MOUNT_1, FOLDER_1);

  // Another account's person in the workspace while the dialog is open.
  harness.holdConfirm = deferred();
  let hold = harness.holdConfirm;
  let answer = harness.service.link(REPO_1, MOUNT_1);
  await settle();
  harness.ownMembers.set(WS_A, OTHER_OWN);
  harness.holdConfirm = null;
  hold.resolve(true);
  await expect(answer).resolves.toEqual({
    outcome: "refused",
    reason: "failed",
  });
  harness.ownMembers.set(WS_A, OWN);

  // A removal while the dialog is open.
  harness.holdConfirm = deferred();
  hold = harness.holdConfirm;
  answer = harness.service.link(REPO_1, MOUNT_1);
  await settle();
  harness.deliver(removedEvent(REPO_1));
  harness.holdConfirm = null;
  hold.resolve(true);
  await expect(answer).resolves.toEqual({
    outcome: "refused",
    reason: "not_registered",
  });

  // A sign-out after the person confirmed, while the folder is read again.
  // (A sign-out while the dialog is open ends it as a Cancel; see below.)
  harness.holdConfirm = deferred();
  hold = harness.holdConfirm;
  harness.mount(MOUNT_2, FOLDER_2);
  answer = harness.service.link(REPO_2, MOUNT_2);
  await settle();
  const check = deferred<void>();
  harness.holdFolderCheck = check;
  harness.holdConfirm = null;
  hold.resolve(true);
  await settle();
  harness.setAccount(accountStatus(false));
  harness.holdFolderCheck = null;
  check.resolve();
  await expect(answer).resolves.toEqual({
    outcome: "refused",
    reason: "unavailable",
  });
  expect(harness.written).toEqual([]);
});

test("a dialog that never settles ends as a Cancel when the main window closes, the device signs out or changes, or the service closes, and does not hold the next link", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1), repository(REPO_2));
  harness.mount(MOUNT_1, FOLDER_1);
  harness.mount(MOUNT_2, FOLDER_2);
  const outcomes: unknown[] = [];
  /** Starts a link whose dialog never settles unless the test settles it. */
  const startLink = async (repositoryId: string, mountId: string) => {
    const hold = deferred<boolean>();
    harness.holdConfirm = hold;
    void harness.service
      .link(repositoryId, mountId)
      .then((outcome) => outcomes.push(outcome));
    await settle();
    harness.holdConfirm = null;
    expect(harness.confirmSignals.at(-1)?.aborted).toBe(false);
    return hold;
  };
  const cancelled = { outcome: "refused", reason: "cancelled" };

  // The main window closes.
  const late = await startLink(REPO_1, MOUNT_1);
  harness.service.cancelConfirmation();
  await settle();
  expect(outcomes).toEqual([cancelled]);
  expect(harness.confirmSignals.at(-1)?.aborted).toBe(true);
  // The dialog answering Link after it was closed links nothing.
  late.resolve(true);
  await settle();
  expect(outcomes).toEqual([cancelled]);
  expect(harness.written).toEqual([]);
  // The next link is not held, once the pause after the cancel ended.
  harness.runTimers();
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "linked",
  });
  // Without an open confirmation, the window's close changes nothing.
  harness.service.cancelConfirmation();
  expect(harness.timers).toEqual([]);
  // Closed while the folder is read, before the dialog: no dialog shows.
  const check = deferred<void>();
  harness.holdFolderCheck = check;
  const asked = harness.confirmations.length;
  const whileRead = harness.service.link(REPO_1, MOUNT_1);
  await settle();
  harness.service.cancelConfirmation();
  harness.holdFolderCheck = null;
  check.resolve();
  await expect(whileRead).resolves.toEqual(cancelled);
  expect(harness.confirmations).toHaveLength(asked);
  harness.runTimers();

  // A sign-out.
  await startLink(REPO_2, MOUNT_2);
  harness.setAccount(accountStatus(false));
  await settle();
  expect(outcomes.at(-1)).toEqual(cancelled);
  expect(harness.confirmSignals.at(-1)?.aborted).toBe(true);
  harness.runTimers();
  harness.setAccount(accountStatus());
  await harness.answerRead({
    ok: true,
    value: list(repository(REPO_1), repository(REPO_2)),
  });

  // Another device.
  await startLink(REPO_2, MOUNT_2);
  const other = accountStatus();
  harness.setAccount({
    ...other,
    account: {
      ...other.account,
      deviceId: "0192f0a0-7b3c-7d4e-8f50-000000000005",
    },
  } as AccountStatus);
  await settle();
  expect(outcomes.at(-1)).toEqual(cancelled);
  expect(harness.confirmSignals.at(-1)?.aborted).toBe(true);
  harness.runTimers();
  await harness.answerRead({
    ok: true,
    value: list(repository(REPO_1), repository(REPO_2)),
  });

  // The service's close, which schedules no pause.
  await startLink(REPO_2, MOUNT_2);
  harness.service.close();
  await settle();
  expect(outcomes.at(-1)).toEqual(cancelled);
  expect(harness.confirmSignals.at(-1)?.aborted).toBe(true);
  expect(harness.timers).toEqual([]);
  expect(harness.written).toHaveLength(1);
});

test("after a cancel, another link answers busy without asking until the pause ends; a dialog that fails or a refusal before it starts no pause", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);

  harness.confirmAnswer = false;
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "cancelled",
  });
  expect(harness.timers.map((timer) => timer.delayMs)).toEqual([
    LINK_CANCEL_PAUSE_MS,
  ]);
  expect(LINK_CANCEL_PAUSE_MS).toBe(3_000);
  harness.confirmAnswer = true;
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  expect(harness.confirmations).toHaveLength(1);
  harness.runTimers();
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "linked",
  });
  expect(harness.confirmations).toHaveLength(2);

  // A dialog that fails, and a folder refused before the dialog.
  harness.throwOnConfirm = true;
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "failed",
  });
  harness.throwOnConfirm = false;
  harness.identities.set(FOLDER_1, "link");
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "symbolic_link",
  });
  expect(harness.timers).toEqual([]);

  // The close ends a pause that runs.
  harness.identities.delete(FOLDER_1);
  harness.confirmAnswer = false;
  await harness.service.link(REPO_1, MOUNT_1);
  expect(harness.timers).toHaveLength(1);
  harness.service.close();
  expect(harness.timers).toEqual([]);
});

test("a folder replaced, turned into a link, or gone while the dialog is open is read again after the person confirmed, and links nothing", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  const cases: [RepositoryFolderIdentity | "link" | "missing", string][] = [
    [identityOf(FOLDER_1, 1), "failed"],
    [
      {
        folder: identityOf(FOLDER_1).folder,
        commonDir: identityOf(FOLDER_1, 1).commonDir,
      },
      "failed",
    ],
    ["link", "symbolic_link"],
    ["missing", "folder_missing"],
  ];
  for (const [change, reason] of cases) {
    const hold = deferred<boolean>();
    harness.holdConfirm = hold;
    const answer = harness.service.link(REPO_1, MOUNT_1);
    await settle();
    harness.holdConfirm = null;
    if (change === "missing") {
      harness.folders.delete(FOLDER_1);
    } else {
      harness.identities.set(FOLDER_1, change);
    }
    hold.resolve(true);
    await expect(answer, reason).resolves.toEqual({
      outcome: "refused",
      reason,
    });
    harness.folders.add(FOLDER_1);
    harness.identities.delete(FOLDER_1);
  }
  expect(harness.confirmations).toHaveLength(cases.length);
  expect(harness.written).toEqual([]);
  expect(harness.state.repositories[0]).toMatchObject({ linked: false });
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });
  // A folder that stayed the same links, with the identity it was read with.
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "linked",
  });
  expect(harness.lastWritten()).toEqual([linkOf(REPO_1, FOLDER_1)]);
});

test("link refuses a repository that the open project does not list, a mount that does not exist, a folder linked to another repository, and invalid IDs, without asking or writing", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1), repository(REPO_2));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);
  const writes = harness.written.length;

  const cases: [string, string, string][] = [
    [REPO_3, MOUNT_1, "not_registered"],
    [REPO_2, MOUNT_2, "not_mounted"],
    [REPO_2, MOUNT_1, "folder_linked"],
    ["repo", MOUNT_1, "invalid"],
    [REPO_2, FOLDER_2, "invalid"],
  ];
  for (const [repositoryId, mountId, reason] of cases) {
    await expect(
      harness.service.link(repositoryId, mountId),
      reason,
    ).resolves.toEqual({ outcome: "refused", reason });
  }
  expect(harness.written).toHaveLength(writes);
  expect(harness.confirmations).toHaveLength(1);
});

test("where folders ignore case, a folder in another case is the same folder", async () => {
  const harness = new Harness({ caseInsensitive: true });
  await harness.ready(repository(REPO_1), repository(REPO_2));
  harness.folders.add("C:\\Users\\octocat\\Web");
  harness.mount(MOUNT_1, "C:\\Users\\octocat\\Web");
  await harness.service.link(REPO_1, MOUNT_1);
  harness.unmount(MOUNT_1);
  harness.mount(MOUNT_2, "c:\\users\\octocat\\web");

  expect(harness.state.repositories[0]).toMatchObject({ mountId: MOUNT_2 });
  await expect(harness.service.link(REPO_2, MOUNT_2)).resolves.toEqual({
    outcome: "refused",
    reason: "folder_linked",
  });
});

test("link is unavailable while the links load, without the account's person, and signed out; a failed write links nothing", async () => {
  const read = deferred<RepositoryLinkRead>();
  const harness = new Harness({ read: () => read.promise });
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  expect(harness.state.links).toBe("loading");
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "unavailable",
  });
  read.resolve({ kind: "none" });
  await settle();
  expect(harness.state.links).toBe("ready");

  harness.failWrites = 1;
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "failed",
  });
  expect(harness.state.repositories[0]).toMatchObject({ linked: false });
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });

  harness.ownMembers.delete(WS_A);
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "unavailable",
  });
  harness.ownMembers.set(WS_A, OWN);
  harness.setAccount(accountStatus(false));
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "unavailable",
  });
  await expect(harness.service.unlink(REPO_1)).resolves.toEqual({
    outcome: "refused",
    reason: "unavailable",
  });
  expectNoSecretInLogs(harness);
});

/** `count` links of OTHER_OWN in PROJECT_2, the oldest first. */
function manyLinks(
  count: number,
  overrides: Partial<RepositoryLink> = {},
): RepositoryLink[] {
  return Array.from({ length: count }, (_, index) =>
    linkOf(
      `0192f0a0-7b3c-7d4e-8f50-${(0x10000 + index).toString(16).padStart(12, "0")}`,
      `/home/other/${index}`,
      { ownMemberId: OTHER_OWN as never, projectId: PROJECT_2, ...overrides },
    ),
  );
}

test("at the limit, a new link takes the place of the oldest link of another account or a former person, never of the account's own", async () => {
  // A former person's link (a workspace that the list no longer holds)
  // first, then other accounts' links.
  const former = linkOf(REPO_3, "/home/former/web", {
    workspaceId: WS_GONE,
    projectId: PROJECT_2,
  });
  const others = manyLinks(MAX_REPOSITORY_LINKS - 1);
  const harness = new Harness({
    read: () => Promise.resolve({ kind: "links", links: [former, ...others] }),
  });
  await harness.ready(repository(REPO_1), repository(REPO_2));
  harness.mount(MOUNT_1, FOLDER_1);
  harness.mount(MOUNT_2, FOLDER_2);

  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "linked",
  });
  expect(harness.lastWritten()).toEqual([...others, linkOf(REPO_1, FOLDER_1)]);
  await expect(harness.service.link(REPO_2, MOUNT_2)).resolves.toEqual({
    outcome: "linked",
  });
  expect(harness.lastWritten()).toEqual([
    ...others.slice(1),
    linkOf(REPO_1, FOLDER_1),
    linkOf(REPO_2, FOLDER_2),
  ]);
  expect(harness.lastWritten()).toHaveLength(MAX_REPOSITORY_LINKS);
  // Replacing the account's own link needs no room.
  harness.unmount(MOUNT_2);
  harness.mount(MOUNT_2, "/home/octocat/secret-api-2");
  harness.folders.add("/home/octocat/secret-api-2");
  await harness.service.link(REPO_2, MOUNT_2);
  expect(harness.lastWritten()?.[0]).toEqual(others[1]);
});

test("when the link that makes room changes while the link is written, the file is written again with the links as they are", async () => {
  // The account's own link in WS_B is the oldest; the next is another
  // account's.
  const ownInB = linkOf(REPO_3, "/home/octocat/secret-b", {
    workspaceId: WS_B,
    projectId: PROJECT_2,
  });
  const others = manyLinks(MAX_REPOSITORY_LINKS - 1);
  const harness = new Harness({
    read: () => Promise.resolve({ kind: "links", links: [ownInB, ...others] }),
  });
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  harness.holdWrite = deferred();
  const hold = harness.holdWrite;

  const answer = harness.service.link(REPO_1, MOUNT_1);
  await settle();
  expect(harness.written[0]).toEqual([
    ownInB,
    ...others.slice(1),
    linkOf(REPO_1, FOLDER_1),
  ]);
  // WS_B leaves the account's list: its link is a former person's now, and
  // the oldest one that makes room.
  harness.ownMembers.delete(WS_B);
  harness.holdWrite = null;
  hold.resolve();
  await expect(answer).resolves.toEqual({ outcome: "linked" });
  await settle();
  expect(harness.lastWritten()).toEqual([...others, linkOf(REPO_1, FOLDER_1)]);
  expect(harness.stored).toEqual(harness.lastWritten());
});

test("at the limit with only the account's own links, a new link is refused and nothing is dropped", async () => {
  const own = manyLinks(MAX_REPOSITORY_LINKS, {
    ownMemberId: OWN as never,
    workspaceId: WS_B,
  });
  const harness = new Harness({
    read: () => Promise.resolve({ kind: "links", links: own }),
  });
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);

  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "limit",
  });
  expect(harness.confirmations).toEqual([]);
  expect(harness.written).toEqual([]);
});

test("a removal while a link is written leaves it out, and the file is written again without it", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  harness.holdWrite = deferred();
  const hold = harness.holdWrite;

  const answer = harness.service.link(REPO_1, MOUNT_1);
  await settle();
  expect(harness.written).toHaveLength(1);
  harness.deliver(removedEvent(REPO_1));
  harness.holdWrite = null;
  hold.resolve();

  await expect(answer).resolves.toEqual({
    outcome: "refused",
    reason: "not_registered",
  });
  await settle();
  expect(harness.lastWritten()).toEqual([]);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });
});

test("a write waiting behind another one never puts back a link that a removal dropped meanwhile", async () => {
  const stored = [
    linkOf(REPO_2, FOLDER_2, { projectId: PROJECT_2 }),
    linkOf(REPO_3, "/home/octocat/secret-old", { projectId: PROJECT_2 }),
  ];
  const harness = new Harness({
    read: () => Promise.resolve({ kind: "links", links: stored }),
  });
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  harness.holdWrite = deferred();
  const hold = harness.holdWrite;

  // The unlink's write waits; the link's write queues behind it, and then
  // REPO_3 is removed.
  await harness.service.unlink(REPO_2);
  const answer = harness.service.link(REPO_1, MOUNT_1);
  await settle();
  harness.deliver(removedEvent(REPO_3, PROJECT_2));
  harness.holdWrite = null;
  hold.resolve();
  await expect(answer).resolves.toEqual({ outcome: "linked" });
  await settle();

  expect(harness.written[1]).toEqual([linkOf(REPO_1, FOLDER_1)]);
  expect(harness.lastWritten()).toEqual([linkOf(REPO_1, FOLDER_1)]);
});

test("unlink drops the account's link at once and writes the rest; another link stays", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1), repository(REPO_2));
  harness.mount(MOUNT_1, FOLDER_1);
  harness.mount(MOUNT_2, FOLDER_2);
  await harness.service.link(REPO_1, MOUNT_1);
  await harness.service.link(REPO_2, MOUNT_2);

  harness.failWrites = 1;
  await expect(harness.service.unlink(REPO_1)).resolves.toEqual({
    outcome: "unlinked",
  });
  // Dropped also when the write failed.
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });
  await expect(harness.service.unlink(REPO_1)).resolves.toEqual({
    outcome: "refused",
    reason: "not_linked",
  });
  await expect(harness.service.unlink("r")).resolves.toEqual({
    outcome: "refused",
    reason: "invalid",
  });
  await harness.service.unlink(REPO_2);
  await settle();
  expect(harness.lastWritten()).toEqual([]);
  expect(harness.logs).toContain("The repository links could not be written.");
  expectNoSecretInLogs(harness);
});

test("unlink drops only the account's own link: another account's link of the same repository stays", async () => {
  const stored = [
    linkOf(REPO_1, FOLDER_2, { ownMemberId: OTHER_OWN as never }),
    linkOf(REPO_1, FOLDER_1),
  ];
  const harness = new Harness({
    read: () => Promise.resolve({ kind: "links", links: stored }),
  });
  await harness.ready(repository(REPO_1));

  await expect(harness.service.unlink(REPO_1)).resolves.toEqual({
    outcome: "unlinked",
  });
  await settle();
  expect(harness.lastWritten()).toEqual([stored[0]]);

  // The other account still finds its link.
  harness.ownMembers.set(WS_A, OTHER_OWN);
  harness.mount(MOUNT_2, FOLDER_2);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: true,
    repositoryId: REPO_1,
    folder: FOLDER_2,
  });
});

// Writing the links again after a failure.

test("a failed write of the links is tried again with a growing wait until it is written, so a dropped link does not come back after a restart", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);
  expect(harness.stored).toEqual([linkOf(REPO_1, FOLDER_1)]);

  harness.failWrites = 3;
  await harness.service.unlink(REPO_1);
  await settle();
  // The file still holds the link: after a restart it would come back.
  expect(harness.stored).toEqual([linkOf(REPO_1, FOLDER_1)]);
  const delays: number[] = [];
  while (harness.timers.length > 0) {
    delays.push(...harness.timers.map((timer) => timer.delayMs));
    harness.runTimers();
    await settle();
  }
  expect(delays).toEqual([1_000, 2_000, 4_000]);
  expect(harness.stored).toEqual([]);
  expect(harness.written.slice(-4)).toEqual([[], [], [], []]);
  expect(harness.timers).toEqual([]);
});

test("the wait before the next try doubles from one second up to one minute", () => {
  expect(LINK_WRITE_RETRY_FIRST_MS).toBe(1_000);
  expect(LINK_WRITE_RETRY_MAX_MS).toBe(60_000);
  expect(
    [0, 1, 2, 3, 4, 5, 6, 7, 1_000].map((attempt) =>
      linkWriteRetryDelayMs(attempt),
    ),
  ).toEqual([
    1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
  ]);
});

test("a removal's failed save is tried again too, and the next change writes at once instead of waiting", async () => {
  const stored = [
    linkOf(REPO_2, FOLDER_2, { projectId: PROJECT_2 }),
    linkOf(REPO_1, FOLDER_1),
  ];
  const harness = new Harness({
    read: () => Promise.resolve({ kind: "links", links: stored }),
  });
  await harness.ready(repository(REPO_1));

  harness.failWrites = 1;
  harness.deliver(removedEvent(REPO_2, PROJECT_2));
  await settle();
  expect(harness.stored).toBeNull();
  expect(harness.timers.map((timer) => timer.delayMs)).toEqual([1_000]);

  // The next change does not wait for the timer: it writes every link as it
  // is now, and the timer is cancelled.
  await harness.service.unlink(REPO_1);
  await settle();
  expect(harness.stored).toEqual([]);
  expect(harness.timers).toEqual([]);
});

test("close tries a failed save once more, and schedules nothing after", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);

  harness.failWrites = 1;
  await harness.service.unlink(REPO_1);
  await settle();
  expect(harness.stored).toEqual([linkOf(REPO_1, FOLDER_1)]);
  expect(harness.timers).toHaveLength(1);

  harness.service.close();
  expect(harness.timers).toEqual([]);
  await settle();
  expect(harness.stored).toEqual([]);
  expect(harness.timers).toEqual([]);

  // Nothing to write: close writes nothing.
  const quiet = new Harness();
  await quiet.ready(repository(REPO_1));
  quiet.service.close();
  await settle();
  expect(quiet.written).toEqual([]);
});

// Resolving.

test("a linked repository resolves to its folder while the folder is mounted and a folder; otherwise it fails closed", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);

  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: true,
    repositoryId: REPO_1,
    folder: FOLDER_1,
  });
  // The open project does not matter: the run names the repository.
  harness.open(WS_B, null);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toMatchObject({
    ok: true,
  });

  await expect(harness.service.resolveFolder(REPO_2)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });
  for (const value of ["repo", 7, null, undefined, { repositoryId: REPO_1 }]) {
    await expect(harness.service.resolveFolder(value)).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  }
  harness.folders.delete(FOLDER_1);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "folder_missing",
  });
  harness.folders.add(FOLDER_1);
  harness.unmount(MOUNT_1);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_mounted",
  });
  harness.mount(MOUNT_2, FOLDER_1);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toMatchObject({
    ok: true,
    folder: FOLDER_1,
  });
  harness.setAccount(accountStatus(false));
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "unavailable",
  });
});

test("a folder replaced at the same path, or turned into a symbolic link, fails closed with changed_folder until it is linked again", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);

  const linked = identityOf(FOLDER_1);
  for (const identity of [
    identityOf(FOLDER_1, 1),
    { ...linked, folder: { ...linked.folder, dev: "2050" } },
    { ...linked, commonDir: { ...linked.commonDir, ino: "7" } },
    "link" as const,
  ]) {
    harness.identities.set(FOLDER_1, identity);
    await expect(
      harness.service.resolveFolder(REPO_1),
      JSON.stringify(identity),
    ).resolves.toEqual({ ok: false, reason: "changed_folder" });
  }

  // Linked again, the new folder resolves, and the old one no longer would.
  harness.identities.set(FOLDER_1, identityOf(FOLDER_1, 1));
  await harness.service.link(REPO_1, MOUNT_1);
  expect(harness.lastWritten()).toEqual([
    linkOf(REPO_1, FOLDER_1, { identity: identityOf(FOLDER_1, 1) }),
  ]);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toMatchObject({
    ok: true,
  });
  harness.identities.delete(FOLDER_1);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "changed_folder",
  });
});

test("a mount whose state is unavailable does not resolve, and resolves again once it is available", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);

  harness.unavailableMounts.add(MOUNT_1);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "mount_unavailable",
  });
  harness.unavailableMounts.delete(MOUNT_1);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toMatchObject({
    ok: true,
  });
});

test("a link or mount that changes while the folder is checked fails the resolution", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);

  harness.holdFolderCheck = deferred();
  let hold = harness.holdFolderCheck;
  let answer = harness.service.resolveFolder(REPO_1);
  await settle();
  harness.unmount(MOUNT_1);
  harness.mount(MOUNT_2, FOLDER_1);
  hold.resolve();
  await expect(answer).resolves.toEqual({ ok: false, reason: "changed" });

  harness.holdFolderCheck = deferred();
  hold = harness.holdFolderCheck;
  answer = harness.service.resolveFolder(REPO_1);
  await settle();
  await harness.service.unlink(REPO_1);
  hold.resolve();
  await expect(answer).resolves.toEqual({ ok: false, reason: "not_linked" });
});

test("a folder check that throws fails closed", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);
  harness.holdFolderCheck = deferred();
  const hold = harness.holdFolderCheck;

  const answer = harness.service.resolveFolder(REPO_1);
  hold.reject(new Error(FOLDER_1));
  await expect(answer).resolves.toEqual({
    ok: false,
    reason: "folder_missing",
  });
});

// Accounts.

test("another account on this device sees and resolves none of the links of an earlier one, and keeps its own", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);

  // Another account: the workspace service names another own person.
  harness.setAccount(accountStatus(false));
  harness.ownMembers.set(WS_A, OTHER_OWN);
  harness.setAccount(accountStatus(true));
  await harness.answerRead({ ok: true, value: list(repository(REPO_1)) });

  expect(harness.state.repositories[0]).toMatchObject({
    linked: false,
    mountId: null,
  });
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });
  await expect(harness.service.unlink(REPO_1)).resolves.toEqual({
    outcome: "refused",
    reason: "not_linked",
  });
  // It links the repository itself, to the same folder.
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "linked",
  });
  expect(harness.lastWritten()).toEqual([
    linkOf(REPO_1, FOLDER_1),
    linkOf(REPO_1, FOLDER_1, { ownMemberId: OTHER_OWN as never }),
  ]);

  // The first account finds its link again.
  harness.ownMembers.set(WS_A, OWN);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toMatchObject({
    ok: true,
  });
});

test("a workspace that the account's list no longer holds resolves none of its links", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);

  harness.ownMembers.delete(WS_A);
  harness.open(null, null);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });
});

// Removals.

test("a removed event drops every link of the repository, of any project and any account, also without an open project", async () => {
  const stored = [
    linkOf(REPO_2, FOLDER_2, { projectId: PROJECT_2 }),
    linkOf(REPO_2, FOLDER_2, {
      projectId: PROJECT_2,
      ownMemberId: OTHER_OWN as never,
    }),
    linkOf(REPO_1, FOLDER_1),
  ];
  const harness = new Harness({
    read: () => Promise.resolve({ kind: "links", links: stored }),
  });
  await harness.ready(repository(REPO_1));
  harness.open(WS_A, null);

  harness.deliver(removedEvent(REPO_2, PROJECT_2));
  await settle();
  expect(harness.lastWritten()).toEqual([linkOf(REPO_1, FOLDER_1)]);
  // An event of a workspace that is not selected changes nothing.
  const writes = harness.written.length;
  harness.deliver(removedEvent(REPO_1, PROJECT_1, WS_B));
  await settle();
  expect(harness.written).toHaveLength(writes);
  await expect(harness.service.unlink(REPO_1)).resolves.toEqual({
    outcome: "unlinked",
  });
});

test("a repository removed while its event waits for a reload cannot be linked, also once the reload answers, and nothing of it resolves", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1), repository(REPO_2));
  harness.mount(MOUNT_1, FOLDER_1);

  // A reload after workspace.subscribed; the removed event waits in the gate,
  // so the list still holds REPO_1.
  harness.deliver(subscribed());
  harness.deliver(removedEvent(REPO_1));
  expect(harness.state.repositories.map((entry) => entry.repositoryId)).toEqual(
    [REPO_1, REPO_2],
  );
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "not_registered",
  });

  // The answer was read before the removal and still lists it; the event
  // that waited drops it.
  await harness.answerRead({
    ok: true,
    value: list(repository(REPO_1), repository(REPO_2)),
  });
  expect(harness.state.repositories.map((entry) => entry.repositoryId)).toEqual(
    [REPO_2],
  );
  // A late registered event and a later answer never bring it back.
  harness.deliver(registeredEvent(repository(REPO_1)));
  harness.deliver(subscribed());
  await harness.answerRead({
    ok: true,
    value: list(repository(REPO_1), repository(REPO_2)),
  });
  expect(harness.state.repositories.map((entry) => entry.repositoryId)).toEqual(
    [REPO_2],
  );
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "not_registered",
  });
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });
  expect(harness.written).toEqual([]);
});

test("a repository removed while offline and linked during the reconnect reload loses the link once the reload no longer lists it", async () => {
  const harness = new Harness();
  await harness.ready(
    repository(REPO_1),
    repository(REPO_2),
    repository(REPO_3),
  );
  harness.mount(MOUNT_1, FOLDER_1);
  harness.mount(MOUNT_2, FOLDER_2);
  await harness.service.link(REPO_2, MOUNT_2);

  // Offline, REPO_1 is removed; no event arrives. Back online, a reload is
  // sent, and REPO_1, still listed, is linked meanwhile.
  harness.disconnect();
  harness.connect();
  harness.deliver(subscribed());
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "linked",
  });
  await harness.answerRead({ ok: true, value: list(repository(REPO_2)) });

  expect(harness.state.repositories.map((entry) => entry.repositoryId)).toEqual(
    [REPO_2],
  );
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });
  expect(harness.lastWritten()).toEqual([linkOf(REPO_2, FOLDER_2)]);
  // Neither comes back, also with a stale event: REPO_3, removed while
  // offline as well, had no link.
  harness.deliver(registeredEvent(repository(REPO_1)));
  harness.deliver(registeredEvent(repository(REPO_3)));
  expect(harness.state.repositories).toHaveLength(1);
  await expect(harness.service.link(REPO_3, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "not_registered",
  });
});

test("a removal whose event waits for a reload while a link is written leaves the link out, although the list still holds the repository", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  harness.deliver(subscribed());
  harness.holdWrite = deferred();
  const hold = harness.holdWrite;

  const answer = harness.service.link(REPO_1, MOUNT_1);
  await settle();
  expect(harness.written).toHaveLength(1);
  harness.deliver(removedEvent(REPO_1));
  expect(harness.state.repositories).toHaveLength(1);
  harness.holdWrite = null;
  hold.resolve();

  await expect(answer).resolves.toEqual({
    outcome: "refused",
    reason: "not_registered",
  });
  await settle();
  expect(harness.lastWritten()).toEqual([]);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "not_linked",
  });
});

test("a repository registered during a reload is kept, although the reload's answer does not list it", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);

  harness.deliver(subscribed());
  harness.deliver(registeredEvent(repository(REPO_2)));
  await harness.answerRead({ ok: true, value: list(repository(REPO_1)) });
  expect(harness.state.repositories.map((entry) => entry.repositoryId)).toEqual(
    [REPO_1, REPO_2],
  );
  await expect(harness.service.link(REPO_2, MOUNT_1)).resolves.toEqual({
    outcome: "linked",
  });
  // The next reload lists it, and the link stays.
  harness.deliver(subscribed());
  await harness.answerRead({
    ok: true,
    value: list(repository(REPO_1), repository(REPO_2)),
  });
  await expect(harness.service.resolveFolder(REPO_2)).resolves.toMatchObject({
    ok: true,
  });
});

test("an answer read before this device's own removal does not list the repository again", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1), repository(REPO_2));

  harness.deliver(subscribed());
  const answer = harness.service.remove(PROJECT_1, REPO_1);
  harness.writes.at(-1)?.answer({ ok: true, value: null });
  await answer;
  await harness.answerRead({
    ok: true,
    value: list(repository(REPO_1), repository(REPO_2)),
  });
  expect(harness.state.repositories.map((entry) => entry.repositoryId)).toEqual(
    [REPO_2],
  );
});

test("a reload that no longer lists a repository drops the links of it from the file, of every account, and only of that project", async () => {
  const stored = [
    linkOf(REPO_1, FOLDER_1),
    linkOf(REPO_3, "/home/x/old"),
    linkOf(REPO_3, "/home/x/old", { ownMemberId: OTHER_OWN as never }),
    linkOf(REPO_2, FOLDER_2, { projectId: PROJECT_2 }),
  ];
  const harness = new Harness({
    read: () => Promise.resolve({ kind: "links", links: stored }),
  });
  await harness.ready(repository(REPO_1), repository(REPO_3));
  expect(harness.written).toEqual([]);

  harness.deliver(subscribed());
  await harness.answerRead({ ok: true, value: list(repository(REPO_1)) });
  expect(harness.lastWritten()).toEqual([stored[0], stored[3]]);
});

test("links read after the open project's list loaded are checked against it: a link of a repository that it does not list goes", async () => {
  const read = deferred<RepositoryLinkRead>();
  const harness = new Harness({ read: () => read.promise });
  await harness.ready(repository(REPO_1));
  expect(harness.state.links).toBe("loading");

  const stored = [
    linkOf(REPO_1, FOLDER_1),
    linkOf(REPO_3, "/home/x/old"),
    // Another project's link is checked when that project loads.
    linkOf(REPO_2, FOLDER_2, { projectId: PROJECT_2 }),
  ];
  read.resolve({ kind: "links", links: stored });
  await settle();
  expect(harness.state.links).toBe("ready");
  expect(harness.lastWritten()).toEqual([stored[0], stored[2]]);
  harness.mount(MOUNT_1, FOLDER_1);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toMatchObject({
    ok: true,
  });
});

test("a removal that comes while the links are read drops the link once they are read", async () => {
  const read = deferred<RepositoryLinkRead>();
  const harness = new Harness({ read: () => read.promise });
  await harness.ready();
  harness.deliver(removedEvent(REPO_2, PROJECT_2));

  read.resolve({
    kind: "links",
    links: [linkOf(REPO_2, FOLDER_2, { projectId: PROJECT_2 })],
  });
  await settle();
  expect(harness.lastWritten()).toEqual([]);
});

// The link file.

test("a corrupt file or one of an earlier version counts as no link and is replaced by the next write; a newer one or one that cannot be read leaves the links unavailable and is never written", async () => {
  for (const kind of ["corrupt", "older"] as const) {
    const harness = new Harness({
      read: () => Promise.resolve({ kind }),
    });
    await harness.ready(repository(REPO_1));
    expect(harness.state.links).toBe("ready");
    expect(harness.written).toEqual([]);
    harness.mount(MOUNT_1, FOLDER_1);
    await harness.service.link(REPO_1, MOUNT_1);
    expect(harness.written).toEqual([[linkOf(REPO_1, FOLDER_1)]]);
    expect(harness.logs).toEqual([
      kind === "corrupt"
        ? "The repository links file is not valid; it is replaced."
        : "The repository links are of an earlier version and are not used; they are replaced.",
    ]);
  }

  for (const read of [
    () => Promise.resolve({ kind: "newer" } as const),
    () => Promise.reject(new Error(FOLDER_1)),
  ]) {
    const harness = new Harness({ read });
    await harness.ready(repository(REPO_1));
    harness.mount(MOUNT_1, FOLDER_1);
    expect(harness.state.links).toBe("unavailable");
    await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
      outcome: "refused",
      reason: "unavailable",
    });
    await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    harness.deliver(removedEvent(REPO_1));
    await settle();
    harness.service.close();
    await settle();
    expect(harness.written).toEqual([]);
    expectNoSecretInLogs(harness);
  }
});

test("a change of a mount's status alone publishes nothing", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  const count = harness.states.length;

  for (const listener of [...harness.mountListeners]) {
    listener();
  }
  expect(harness.states).toHaveLength(count);
});

test("close stops listening and resolves nothing more", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  await harness.service.link(REPO_1, MOUNT_1);

  harness.service.close();
  expect(harness.accountListeners.size).toBe(0);
  expect(harness.messageListeners.size).toBe(0);
  expect(harness.workspaceListeners.size).toBe(0);
  expect(harness.mountListeners.size).toBe(0);
  await expect(harness.service.resolveFolder(REPO_1)).resolves.toEqual({
    ok: false,
    reason: "unavailable",
  });
  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "unavailable",
  });
});
