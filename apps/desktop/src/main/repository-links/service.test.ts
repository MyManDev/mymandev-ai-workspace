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
import {
  MAX_REPOSITORY_LINKS,
  type RepositoryLink,
  type RepositoryLinkRead,
} from "./link-store.ts";
import {
  createProjectRepositoryService,
  type ProjectRepositoryAccount,
  type ProjectRepositoryService,
  type ProjectRepositoryState,
} from "./service.ts";

const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const WS_A = "0192f0a0-7b3c-7d4e-8f50-0000000000a1" as WorkspaceId;
const WS_B = "0192f0a0-7b3c-7d4e-8f50-0000000000a2" as WorkspaceId;
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

function accountStatus(signedIn = true): AccountStatus {
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
    deviceKey: "ready",
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
  for (let index = 0; index < 20; index += 1) {
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
  readonly folders = new Set<string>([FOLDER_1, FOLDER_2]);
  readonly accountListeners = new Set<(status: AccountStatus) => void>();
  readonly connectionListeners = new Set<(status: ConnectionStatus) => void>();
  readonly messageListeners = new Set<(message: ServerMessage) => void>();
  readonly workspaceListeners = new Set<(state: WorkspaceState) => void>();
  readonly mountListeners = new Set<() => void>();
  readonly reads: Read[] = [];
  readonly writes: Write[] = [];
  /** Each snapshot that the store wrote. */
  readonly written: (readonly RepositoryLink[])[] = [];
  failWrites = 0;
  /** Makes the account service's next write throw. */
  throwOnAction = false;
  holdWrite: Deferred<void> | null = null;
  holdFolderCheck: Deferred<void> | null = null;
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
        folderOf: (mountId) => this.mounts.get(mountId),
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
        },
      },
      isFolder: async (folder) => {
        if (this.holdFolderCheck !== null) {
          await this.holdFolderCheck.promise;
        }
        return this.folders.has(folder);
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

// Linking.

test("link keeps the folder of the mount on this device for the account, and the state shows the mount, never the path", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);

  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "linked",
  });
  expect(harness.written).toEqual([[linkOf(REPO_1, FOLDER_1)]]);
  expect(harness.state.repositories).toEqual([
    { repositoryId: REPO_1, name: "web app", linked: true, mountId: MOUNT_1 },
  ]);
  expect(JSON.stringify(harness.states)).not.toContain(FOLDER_1);

  // Unmounted, it stays linked without a mount; mounted again, it shows.
  harness.unmount(MOUNT_1);
  expect(harness.state.repositories[0]).toMatchObject({
    linked: true,
    mountId: null,
  });
  harness.mount(MOUNT_2, FOLDER_1);
  expect(harness.state.repositories[0]).toMatchObject({ mountId: MOUNT_2 });

  // Linking it to another folder replaces the link.
  harness.mount(MOUNT_1, FOLDER_2);
  await harness.service.link(REPO_1, MOUNT_1);
  expect(harness.lastWritten()).toEqual([linkOf(REPO_1, FOLDER_2)]);
  expect(harness.state.repositories[0]).toMatchObject({ mountId: MOUNT_1 });
});

test("link refuses a repository that the open project does not list, a mount that does not exist, a folder linked to another repository, and invalid IDs, without writing", async () => {
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
});

test("where folders ignore case, a folder in another case is the same folder", async () => {
  const harness = new Harness({ caseInsensitive: true });
  await harness.ready(repository(REPO_1), repository(REPO_2));
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

test("no more links than the limit are kept on this device", async () => {
  const many = Array.from({ length: MAX_REPOSITORY_LINKS }, (_, index) =>
    linkOf(
      `0192f0a0-7b3c-7d4e-8f50-${(0x10000 + index).toString(16).padStart(12, "0")}`,
      `/home/other/${index}`,
      { ownMemberId: OTHER_OWN as never, projectId: PROJECT_2 },
    ),
  );
  const harness = new Harness({
    read: () => Promise.resolve({ kind: "links", links: many }),
  });
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);

  await expect(harness.service.link(REPO_1, MOUNT_1)).resolves.toEqual({
    outcome: "refused",
    reason: "limit",
  });
});

test("a removal while a link is written leaves it out, and the file is written again without it", async () => {
  const harness = new Harness();
  await harness.ready(repository(REPO_1));
  harness.mount(MOUNT_1, FOLDER_1);
  harness.holdWrite = deferred();
  const hold = harness.holdWrite;

  const answer = harness.service.link(REPO_1, MOUNT_1);
  await settle();
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

test("a reload that no longer lists a repository drops its links, but not a link made after the reload was sent", async () => {
  const stored = [linkOf(REPO_1, FOLDER_1), linkOf(REPO_3, "/home/x/old")];
  const harness = new Harness({
    read: () => Promise.resolve({ kind: "links", links: stored }),
  });
  await harness.ready(repository(REPO_1), repository(REPO_3));
  harness.deliver(registeredEvent(repository(REPO_2)));
  harness.mount(MOUNT_2, FOLDER_2);

  // A reload is sent, and REPO_2 is linked after it was sent.
  harness.deliver(subscribed());
  await harness.service.link(REPO_2, MOUNT_2);
  // Its answer no longer lists REPO_3, removed while offline, and does not
  // list REPO_2.
  await harness.answerRead({ ok: true, value: list(repository(REPO_1)) });

  expect(harness.lastWritten()).toEqual([
    linkOf(REPO_1, FOLDER_1),
    linkOf(REPO_2, FOLDER_2),
  ]);
  await expect(harness.service.resolveFolder(REPO_2)).resolves.toMatchObject({
    ok: true,
  });
  // The next reload that does not list REPO_2 drops it as well.
  harness.deliver(subscribed());
  await harness.answerRead({ ok: true, value: list(repository(REPO_1)) });
  expect(harness.lastWritten()).toEqual([linkOf(REPO_1, FOLDER_1)]);
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

test("a corrupt file counts as no link and is replaced by the next write; a newer one or one that cannot be read leaves the links unavailable and is never written", async () => {
  const corrupt = new Harness({
    read: () => Promise.resolve({ kind: "corrupt" }),
  });
  await corrupt.ready(repository(REPO_1));
  expect(corrupt.state.links).toBe("ready");
  expect(corrupt.written).toEqual([]);
  corrupt.mount(MOUNT_1, FOLDER_1);
  await corrupt.service.link(REPO_1, MOUNT_1);
  expect(corrupt.written).toEqual([[linkOf(REPO_1, FOLDER_1)]]);

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
