import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeServerMessage,
  ProjectListResponseSchema,
  WorkspaceListResponseSchema,
  WorkspaceViewResponseSchema,
  type MemberId,
  type ProjectId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import type {
  AccountStatus,
  ConnectionStatus,
} from "../../shared/ipc-contract.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadName,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { ServerMessage } from "../connection/client.ts";
import { MAX_BUFFERED_EVENTS } from "./resync.ts";
import {
  createWorkspaceService,
  RATE_LIMITED_RETRY_MS,
  UNKNOWN_MEMBER_NAME,
  WORKSPACE_RETRY_BASE_MS,
  WORKSPACE_RETRY_MAX_MS,
  workspaceRetryDelayMs,
  type WorkspaceAccount,
  type WorkspaceConnection,
  type WorkspaceService,
  type WorkspaceState,
} from "./service.ts";

const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000014";
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009";
const OTHER_USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000019";
const WS_A = "0192f0a0-7b3c-7d4e-8f50-0000000000a1" as WorkspaceId;
const WS_B = "0192f0a0-7b3c-7d4e-8f50-0000000000a2" as WorkspaceId;
const WS_C = "0192f0a0-7b3c-7d4e-8f50-0000000000a3" as WorkspaceId;
const OWNER = "0192f0a0-7b3c-7d4e-8f50-0000000000c1" as MemberId;
const MEMBER = "0192f0a0-7b3c-7d4e-8f50-0000000000c2" as MemberId;
const NEW_MEMBER = "0192f0a0-7b3c-7d4e-8f50-0000000000c3" as MemberId;
const UNKNOWN_MEMBER = "0192f0a0-7b3c-7d4e-8f50-0000000000c9" as MemberId;
const PROJECT_1 = "0192f0a0-7b3c-7d4e-8f50-0000000000e1" as ProjectId;
const PROJECT_2 = "0192f0a0-7b3c-7d4e-8f50-0000000000e2" as ProjectId;
const PROJECT_3 = "0192f0a0-7b3c-7d4e-8f50-0000000000e3" as ProjectId;
const UNKNOWN_PROJECT = "0192f0a0-7b3c-7d4e-8f50-0000000000e9" as ProjectId;
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000f1";
const RUN_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000f2";
const JOIN_REQUEST_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000f3";
const AT = "2026-11-05T10:00:00.000Z";

/** Every name that the fixtures use, which no log may hold. */
const NAMES = [
  "Workspace Alpha",
  "Workspace Beta",
  "Workspace Gamma",
  "Ada Owner",
  "Grace Member",
  "Linus Newcomer",
  "Grace Renamed",
  "Project One",
  "Project Two",
  "Project Three",
  "Project One Renamed",
  "octocat",
];
const WORKSPACE_NAMES: Readonly<Record<string, string>> = {
  [WS_A]: "Workspace Alpha",
  [WS_B]: "Workspace Beta",
  [WS_C]: "Workspace Gamma",
};

function accountStatus(
  overrides: Partial<AccountStatus> = {},
  deviceId: string = DEVICE_ID,
): AccountStatus {
  return Object.freeze({
    revision: 1,
    account: Object.freeze({
      kind: "signed_in",
      login: "octocat",
      displayName: "The Octocat",
      deviceId,
    }),
    signIn: Object.freeze({ kind: "idle" }),
    lastOutcome: null,
    deviceKey: "ready",
    replacementPending: false,
    apiOrigin: "set",
    device: "signed_in",
    ...overrides,
  }) as AccountStatus;
}

const SIGNED_OUT = accountStatus({
  account: Object.freeze({ kind: "signed_out" }),
  device: "signed_out",
});

function memberOf(
  workspaceId: string,
  id: string,
  displayName: string,
  role: "owner" | "admin" | "member",
  userId: string | null = OTHER_USER_ID,
) {
  return {
    id,
    workspaceId,
    displayName,
    role,
    userId,
    identity:
      userId === null
        ? null
        : { provider: "github", login: "octocat", verifiedAt: AT },
    removedAt: null,
  };
}

function workspaceList(...ids: readonly WorkspaceId[]) {
  return WorkspaceListResponseSchema.parse({
    workspaces: ids.map((id) => ({
      workspace: { id, name: WORKSPACE_NAMES[id] },
      member: memberOf(id, OWNER, "Ada Owner", "owner", USER_ID),
    })),
  });
}

function workspaceView(workspaceId: WorkspaceId = WS_A) {
  return WorkspaceViewResponseSchema.parse({
    workspace: { id: workspaceId, name: WORKSPACE_NAMES[workspaceId] },
    members: [
      memberOf(workspaceId, OWNER, "Ada Owner", "owner", USER_ID),
      memberOf(workspaceId, MEMBER, "Grace Member", "member"),
    ],
    joinRequestsPausedAt: null,
    maxUnclaimedMembers: 500,
    ownershipOffer: null,
  });
}

const PROJECT_NAMES: Readonly<Record<string, string>> = {
  [PROJECT_1]: "Project One",
  [PROJECT_2]: "Project Two",
  [PROJECT_3]: "Project Three",
};

function project(id: ProjectId, workspaceId: WorkspaceId = WS_A) {
  return {
    id,
    workspaceId,
    name: PROJECT_NAMES[id] ?? "Project One",
    createdByMemberId: OWNER,
  };
}

function projectList(
  ids: readonly ProjectId[],
  workspaceId: WorkspaceId = WS_A,
) {
  return ProjectListResponseSchema.parse({
    projects: ids.map((id) => project(id, workspaceId)),
  });
}

function ok<T>(value: T): WorkspaceReadResult<T> {
  return { ok: true, value };
}

function failure(reason: WorkspaceReadFailure): WorkspaceReadResult<never> {
  return { ok: false, reason };
}

/** A server frame, decoded as the connection client receives it. */
function frame(input: Record<string, unknown>): ServerMessage {
  const decoded = decodeServerMessage({ protocolVersion: 0, ...input });
  if (!decoded.ok || decoded.kind !== "frame") {
    throw new Error("The test frame does not decode");
  }
  return { kind: "frame", frame: decoded.frame };
}

let eventCount = 0;

/** A server event of `workspaceId`, decoded as the connection client receives it. */
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
    actor:
      type === "agent.run.state_changed"
        ? { kind: "agent", agentId: AGENT_ID }
        : { kind: "system" },
    deviceId: null,
    type,
    payload,
  });
  if (!decoded.ok || decoded.kind !== "event") {
    throw new Error("The test event does not decode");
  }
  return { kind: "event", event: decoded.event };
}

function subscribed(workspaceId: WorkspaceId = WS_A): ServerMessage {
  return frame({
    type: "workspace.subscribed",
    workspaceId,
    onlineMemberIds: [OWNER],
  });
}

interface Read {
  readonly name: WorkspaceReadName;
  readonly params: unknown;
  readonly answer: (result: WorkspaceReadResult<unknown>) => void;
}

interface Timer {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

class Harness {
  accountStatus: AccountStatus;
  connectionStatus: ConnectionStatus = { state: "offline", revision: 0 };
  readonly accountListeners = new Set<(status: AccountStatus) => void>();
  readonly connectionListeners = new Set<(status: ConnectionStatus) => void>();
  readonly messageListeners = new Set<(message: ServerMessage) => void>();
  /** The connection client's set of requested workspaces. */
  readonly requested = new Set<WorkspaceId>();
  /** The workspace frames that the connection client would send. */
  readonly frames: string[] = [];
  reads: Read[] = [];
  readonly timers: Timer[] = [];
  readonly logs: string[] = [];
  readonly states: WorkspaceState[] = [];
  readonly service: WorkspaceService;

  constructor(
    status: AccountStatus = accountStatus(),
    connectionState: "connected" | "offline" = "offline",
  ) {
    this.accountStatus = status;
    this.connectionStatus = { state: connectionState, revision: 0 };
    const account: WorkspaceAccount = {
      status: () => this.accountStatus,
      onStatusChange: (listener) => {
        this.accountListeners.add(listener);
        return () => this.accountListeners.delete(listener);
      },
      readWorkspaceData: (name, params) =>
        new Promise((resolve) => {
          this.reads.push({
            name,
            params,
            answer: resolve as (result: WorkspaceReadResult<unknown>) => void,
          });
        }),
    };
    const connection: WorkspaceConnection = {
      status: () => this.connectionStatus,
      onStatusChange: (listener) => {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
      },
      onMessage: (listener) => {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
      },
      // Like the connection client: the set changes only on request, and a
      // frame goes out only when it changed.
      subscribeWorkspace: (workspaceId) => {
        if (!this.requested.has(workspaceId)) {
          this.requested.add(workspaceId);
          this.frames.push(`subscribe ${workspaceId}`);
        }
      },
      unsubscribeWorkspace: (workspaceId) => {
        if (this.requested.delete(workspaceId)) {
          this.frames.push(`unsubscribe ${workspaceId}`);
        }
      },
    };
    this.service = createWorkspaceService({
      account,
      connection,
      scheduleTimer: (callback, delayMs) => {
        const timer: Timer = { callback, delayMs, cancelled: false };
        this.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      log: (message) => this.logs.push(message),
    });
    this.service.onChange((state) => this.states.push(state));
  }

  setAccount(status: AccountStatus): void {
    this.accountStatus = status;
    for (const listener of [...this.accountListeners]) {
      listener(status);
    }
  }

  setConnection(state: "connected" | "connecting" | "offline"): void {
    this.connectionStatus = {
      state,
      revision: this.connectionStatus.revision + 1,
    } as ConnectionStatus;
    for (const listener of [...this.connectionListeners]) {
      listener(this.connectionStatus);
    }
  }

  receive(message: ServerMessage): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  get state(): WorkspaceState {
    return this.service.state();
  }

  readNames(): string[] {
    return this.reads.map((read) => read.name);
  }

  /** Takes the oldest open read of `name`. */
  take(name: WorkspaceReadName): Read {
    const index = this.reads.findIndex((read) => read.name === name);
    if (index < 0) {
      throw new Error(`No open read of ${name}`);
    }
    const [read] = this.reads.splice(index, 1);
    return read as Read;
  }

  async answer(
    name: WorkspaceReadName,
    result: WorkspaceReadResult<unknown>,
  ): Promise<void> {
    this.take(name).answer(result);
    await settle();
  }

  /** Answers the reload of the selected workspace. */
  async answerReload(
    view: WorkspaceReadResult<unknown> = ok(workspaceView()),
    projects: WorkspaceReadResult<unknown> = ok(projectList([PROJECT_1])),
  ): Promise<void> {
    this.take("getWorkspace").answer(view);
    this.take("listProjects").answer(projects);
    await settle();
  }

  openTimers(): Timer[] {
    return this.timers.filter((timer) => !timer.cancelled);
  }

  /** Fires the only open timer, which must wait `delayMs`. */
  fire(delayMs: number): void {
    const open = this.openTimers();
    expect(open.map((timer) => timer.delayMs)).toEqual([delayMs]);
    const timer = open[0] as Timer;
    timer.cancelled = true;
    timer.callback();
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Signed in and connected, the list of `ids` loaded, nothing subscribed yet. */
async function withList(
  ids: readonly WorkspaceId[] = [WS_A, WS_B],
): Promise<Harness> {
  const h = new Harness();
  h.setConnection("connected");
  await h.answer("listWorkspaces", ok(workspaceList(...ids)));
  return h;
}

/** As `withList`, with the first workspace subscribed and reloaded. */
async function withLiveWorkspace(
  ids: readonly WorkspaceId[] = [WS_A, WS_B],
): Promise<Harness> {
  const h = await withList(ids);
  h.receive(subscribed());
  await h.answerReload();
  expect(h.service.gateLive(WS_A)).toBe(true);
  return h;
}

test("the list loads when a signed-in device's connection reaches connected, and the first workspace is selected and subscribed", async () => {
  const h = new Harness();
  expect(h.state).toEqual({
    revision: 0,
    status: "loading",
    workspaces: [],
    selectedWorkspaceId: null,
    projects: [],
    openProjectId: null,
  });
  h.setConnection("connecting");
  expect(h.reads).toEqual([]);
  h.setConnection("connected");
  expect(h.readNames()).toEqual(["listWorkspaces"]);
  expect(h.reads[0]?.params).toEqual({});
  await h.answer("listWorkspaces", ok(workspaceList(WS_A, WS_B)));
  expect(h.state).toMatchObject({
    status: "loading",
    workspaces: [
      { id: WS_A, name: "Workspace Alpha" },
      { id: WS_B, name: "Workspace Beta" },
    ],
    selectedWorkspaceId: WS_A,
  });
  expect(h.service.selectedWorkspaceId()).toBe(WS_A);
  expect([...h.requested]).toEqual([WS_A]);
  expect(h.frames).toEqual([`subscribe ${WS_A}`]);
  expect(Object.isFrozen(h.state)).toBe(true);
  expect(Object.isFrozen(h.state.workspaces)).toBe(true);
  // The workspace loads only after `workspace.subscribed`.
  expect(h.reads).toEqual([]);
  // Each listener call got a newer revision.
  const revisions = h.states.map((state) => state.revision);
  expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
  expect(h.states.at(-1)).toBe(h.state);
});

test("nothing loads without a signed-in device with a ready key", async () => {
  for (const status of [
    SIGNED_OUT,
    accountStatus({ deviceKey: "passphrase_required" }),
    accountStatus({ apiOrigin: "unset" }),
    accountStatus({ device: "starting" }),
  ]) {
    const h = new Harness(status);
    h.setConnection("connected");
    expect(h.reads).toEqual([]);
    expect(h.state.status).toBe("signed_out");
    h.receive(subscribed());
    expect(h.reads).toEqual([]);
  }
});

test("a sign-in while connected loads the list", async () => {
  const h = new Harness(SIGNED_OUT);
  h.setConnection("connected");
  h.setAccount(accountStatus());
  expect(h.readNames()).toEqual(["listWorkspaces"]);
});

test("selecting a workspace keeps exactly one subscription", async () => {
  const h = await withList([WS_A, WS_B, WS_C]);
  expect(h.service.select(WS_B)).toBe(true);
  expect(h.state.selectedWorkspaceId).toBe(WS_B);
  expect([...h.requested]).toEqual([WS_B]);
  expect(h.service.select(WS_C)).toBe(true);
  expect([...h.requested]).toEqual([WS_C]);
  expect(h.frames).toEqual([
    `subscribe ${WS_A}`,
    `unsubscribe ${WS_A}`,
    `subscribe ${WS_B}`,
    `unsubscribe ${WS_B}`,
    `subscribe ${WS_C}`,
  ]);
  // The selected one again changes nothing.
  const revision = h.state.revision;
  expect(h.service.select(WS_C)).toBe(true);
  expect(h.state.revision).toBe(revision);
  // A workspace that the list does not hold is refused.
  expect(
    h.service.select("0192f0a0-7b3c-7d4e-8f50-0000000000a9" as WorkspaceId),
  ).toBe(false);
  expect([...h.requested]).toEqual([WS_C]);
  // A late answer for an earlier selection starts no reload.
  h.receive(subscribed(WS_A));
  expect(h.reads).toEqual([]);
});

test("every workspace.subscribed reloads the view and the projects, and gateLive holds only after the reload", async () => {
  const h = await withList();
  expect(h.service.gateLive(WS_A)).toBe(false);
  h.receive(subscribed());
  expect(h.readNames()).toEqual(["getWorkspace", "listProjects"]);
  expect(h.reads.map((read) => read.params)).toEqual([
    { workspaceId: WS_A },
    { workspaceId: WS_A },
  ]);
  expect(h.service.gateLive(WS_A)).toBe(false);
  expect(h.state.status).toBe("loading");
  await h.answerReload();
  expect(h.service.gateLive(WS_A)).toBe(true);
  expect(h.service.gateLive(WS_B)).toBe(false);
  expect(h.state).toMatchObject({
    status: "ready",
    projects: [
      { id: PROJECT_1, name: "Project One", createdByMemberId: OWNER },
    ],
  });
  expect(h.service.memberName(MEMBER)).toBe("Grace Member");

  // A fresh `workspace.subscribed` reloads again; the state stays ready.
  const revision = h.state.revision;
  h.receive(subscribed());
  expect(h.state.revision).toBeGreaterThan(revision);
  expect(h.service.gateLive(WS_A)).toBe(false);
  expect(h.state.status).toBe("ready");
  await h.answerReload(
    ok(workspaceView()),
    ok(projectList([PROJECT_1, PROJECT_2])),
  );
  expect(h.service.gateLive(WS_A)).toBe(true);
  expect(h.state.projects.map((p) => p.id)).toEqual([PROJECT_1, PROJECT_2]);

  // A lost connection ends the subscription; the next connect reloads the
  // list, and the client's resubscription brings another reload.
  h.setConnection("connecting");
  expect(h.service.gateLive(WS_A)).toBe(false);
  h.setConnection("connected");
  expect(h.readNames()).toEqual(["listWorkspaces"]);
  await h.answer("listWorkspaces", ok(workspaceList(WS_A, WS_B)));
  expect(h.state.selectedWorkspaceId).toBe(WS_A);
  expect([...h.requested]).toEqual([WS_A]);
  h.receive(subscribed());
  expect(h.readNames()).toEqual(["getWorkspace", "listProjects"]);
});

test("a lost connection notifies the listeners that the gate went down", async () => {
  const h = await withLiveWorkspace();
  const revision = h.state.revision;
  const seen = h.states.length;
  h.setConnection("connecting");
  expect(h.service.gateLive(WS_A)).toBe(false);
  expect(h.state.revision).toBeGreaterThan(revision);
  expect(h.states.slice(seen)).toEqual([h.state]);
});

test("an answer of an earlier reload is dropped", async () => {
  const h = await withList();
  h.receive(subscribed());
  const [view, projects] = [h.take("getWorkspace"), h.take("listProjects")];
  h.receive(subscribed());
  view.answer(ok(workspaceView()));
  projects.answer(ok(projectList([PROJECT_2])));
  await settle();
  expect(h.state.projects).toEqual([]);
  expect(h.service.gateLive(WS_A)).toBe(false);
  await h.answerReload();
  expect(h.state.projects.map((p) => p.id)).toEqual([PROJECT_1]);
});

test("events that arrive during the reload wait and apply after it", async () => {
  const h = await withList();
  h.receive(subscribed());
  h.receive(
    event("workspace.project.created", { project: project(PROJECT_2) }),
  );
  h.receive(
    event("workspace.member.renamed", {
      memberId: MEMBER,
      displayName: "Grace Renamed",
    }),
  );
  h.receive(
    event("workspace.project.renamed", {
      projectId: PROJECT_1,
      name: "Project One Renamed",
    }),
  );
  // Events that name a project and a person that the reload will not hold.
  h.receive(
    event("workspace.project.renamed", {
      projectId: UNKNOWN_PROJECT,
      name: "Project Three",
    }),
  );
  h.receive(
    event("workspace.member.renamed", {
      memberId: UNKNOWN_MEMBER,
      displayName: "Linus Newcomer",
    }),
  );
  // Nothing applies before the reload.
  expect(h.state.projects).toEqual([]);
  expect(h.service.memberName(MEMBER)).toBe(UNKNOWN_MEMBER_NAME);
  // The reload's answer is older than the events.
  await h.answerReload();
  expect(h.state.projects).toEqual([
    { id: PROJECT_1, name: "Project One Renamed", createdByMemberId: OWNER },
    { id: PROJECT_2, name: "Project Two", createdByMemberId: OWNER },
  ]);
  expect(h.service.memberName(MEMBER)).toBe("Grace Renamed");
  expect(h.service.memberName(UNKNOWN_MEMBER)).toBe(UNKNOWN_MEMBER_NAME);
  // The buffered events that name an unknown project or person are skipped
  // and start no other reload.
  await settle();
  expect(h.reads).toEqual([]);
  expect(h.service.gateLive(WS_A)).toBe(true);
});

test("project and member events apply while live", async () => {
  const h = await withLiveWorkspace();
  const before = h.state.revision;
  h.receive(
    event("workspace.project.created", { project: project(PROJECT_2) }),
  );
  expect(h.state.projects.map((p) => p.id)).toEqual([PROJECT_1, PROJECT_2]);
  expect(h.state.revision).toBeGreaterThan(before);
  // The same event again changes nothing, not even the revision.
  const afterCreated = h.state.revision;
  h.receive(
    event("workspace.project.created", { project: project(PROJECT_2) }),
  );
  expect(h.state.projects.map((p) => p.id)).toEqual([PROJECT_1, PROJECT_2]);
  expect(h.state.revision).toBe(afterCreated);
  h.receive(
    event("workspace.project.renamed", {
      projectId: PROJECT_1,
      name: "Project One Renamed",
    }),
  );
  expect(h.state.projects[0]?.name).toBe("Project One Renamed");
  expect(Object.isFrozen(h.state.projects[0])).toBe(true);

  h.receive(
    event("workspace.member.defined", {
      member: memberOf(WS_A, NEW_MEMBER, "Linus Newcomer", "member", null),
    }),
  );
  expect(h.service.memberName(NEW_MEMBER)).toBe("Linus Newcomer");
  h.receive(
    event("workspace.member.claimed", {
      member: memberOf(WS_A, NEW_MEMBER, "Linus Newcomer", "member"),
    }),
  );
  h.receive(
    event("workspace.member.renamed", {
      memberId: MEMBER,
      displayName: "Grace Renamed",
    }),
  );
  expect(h.service.memberName(MEMBER)).toBe("Grace Renamed");
  // A role, an owner, or a removal changes nothing that the service keeps,
  // and neither does a name or a project name that is already held.
  const afterNames = h.state.revision;
  const published = h.states.length;
  h.receive(
    event("workspace.member.renamed", {
      memberId: MEMBER,
      displayName: "Grace Renamed",
    }),
  );
  h.receive(
    event("workspace.project.renamed", {
      projectId: PROJECT_1,
      name: "Project One Renamed",
    }),
  );
  h.receive(
    event("workspace.member.role_changed", { memberId: MEMBER, role: "admin" }),
  );
  h.receive(
    event("workspace.ownership.transferred", {
      previousOwnerMemberId: OWNER,
      ownerMemberId: MEMBER,
    }),
  );
  // A former member keeps their name for the chat history.
  h.receive(
    event("workspace.member.removed", { memberId: MEMBER, removedAt: AT }),
  );
  expect(h.service.memberName(MEMBER)).toBe("Grace Renamed");
  expect(h.service.memberName(UNKNOWN_MEMBER)).toBe(UNKNOWN_MEMBER_NAME);
  expect(h.state.revision).toBe(afterNames);
  expect(h.states).toHaveLength(published);
  expect(h.reads).toEqual([]);

  // Events of another workspace, chat messages, runs, and presence change
  // nothing here.
  const revision = h.state.revision;
  h.receive(
    event(
      "workspace.project.created",
      { project: project(PROJECT_3, WS_B) },
      WS_B,
    ),
  );
  h.receive(
    event("agent.run.state_changed", {
      runId: RUN_ID,
      agentId: AGENT_ID,
      previousState: "queued",
      state: "running",
    }),
  );
  h.receive(
    frame({
      type: "presence.changed",
      workspaceId: WS_A,
      memberId: MEMBER,
      status: "offline",
    }),
  );
  expect(h.state.revision).toBe(revision);
  expect(h.reads).toEqual([]);
});

test("a live event that names an unknown person or project reloads the workspace", async () => {
  for (const unknown of [
    event("workspace.project.renamed", {
      projectId: UNKNOWN_PROJECT,
      name: "Project Three",
    }),
    event("workspace.member.renamed", {
      memberId: UNKNOWN_MEMBER,
      displayName: "Linus Newcomer",
    }),
    event("workspace.member.removed", {
      memberId: UNKNOWN_MEMBER,
      removedAt: AT,
    }),
    event("workspace.member.role_changed", {
      memberId: UNKNOWN_MEMBER,
      role: "admin",
    }),
    event("workspace.ownership.transferred", {
      previousOwnerMemberId: OWNER,
      ownerMemberId: UNKNOWN_MEMBER,
    }),
  ]) {
    const h = await withLiveWorkspace();
    h.receive(unknown);
    expect(h.readNames()).toEqual(["getWorkspace", "listProjects"]);
    expect(h.service.gateLive(WS_A)).toBe(false);
    await h.answerReload();
    expect(h.service.gateLive(WS_A)).toBe(true);
  }
});

test("a refused subscription leaves the client's set, the next workspace is selected, and the list reloads", async () => {
  const h = await withList([WS_A, WS_B]);
  h.receive(
    frame({
      type: "workspace.subscribe_refused",
      workspaceId: WS_A,
      code: "not_found",
    }),
  );
  expect([...h.requested]).toEqual([WS_B]);
  expect(h.state.selectedWorkspaceId).toBe(WS_B);
  expect(h.state.workspaces.map((w) => w.id)).toEqual([WS_B]);
  expect(h.readNames()).toEqual(["listWorkspaces"]);
  // A list that still holds the refused workspace does not select it again.
  await h.answer("listWorkspaces", ok(workspaceList(WS_A, WS_B)));
  expect(h.state.selectedWorkspaceId).toBe(WS_B);
  expect([...h.requested]).toEqual([WS_B]);
  // The person can still select it.
  expect(h.service.select(WS_A)).toBe(true);
  expect([...h.requested]).toEqual([WS_A]);
  // A refusal for a workspace that is no longer selected changes nothing.
  h.receive(
    frame({
      type: "workspace.subscribe_refused",
      workspaceId: WS_B,
      code: "not_found",
    }),
  );
  expect(h.state.selectedWorkspaceId).toBe(WS_A);
  expect([...h.requested]).toEqual([WS_A]);
  expect(h.reads).toEqual([]);
});

test("a refusal of the only workspace leaves none selected and does not loop", async () => {
  const h = await withList([WS_A]);
  h.receive(
    frame({
      type: "workspace.subscribe_refused",
      workspaceId: WS_A,
      code: "too_many_subscriptions",
    }),
  );
  expect(h.state.selectedWorkspaceId).toBeNull();
  expect([...h.requested]).toEqual([]);
  await h.answer("listWorkspaces", ok(workspaceList(WS_A)));
  expect(h.state.selectedWorkspaceId).toBeNull();
  expect([...h.requested]).toEqual([]);
  expect(h.reads).toEqual([]);
  expect(h.state.status).toBe("ready");
  // Later lists that still hold it do not subscribe to it either.
  h.setConnection("connecting");
  h.setConnection("connected");
  await h.answer("listWorkspaces", ok(workspaceList(WS_A)));
  expect(h.state.selectedWorkspaceId).toBeNull();
  expect([...h.requested]).toEqual([]);
  expect(h.frames).toEqual([`subscribe ${WS_A}`, `unsubscribe ${WS_A}`]);
  // An approved join request for it counts as a new membership.
  h.receive(
    frame({
      type: "account.join_request_decided",
      joinRequestId: JOIN_REQUEST_ID,
      workspaceId: WS_A,
      decision: "approved",
      decidedAt: AT,
    }),
  );
  await h.answer("listWorkspaces", ok(workspaceList(WS_A)));
  expect(h.state.selectedWorkspaceId).toBe(WS_A);
  expect([...h.requested]).toEqual([WS_A]);
});

test("a refused workspace that a list no longer holds is selected by default again when it is listed later", async () => {
  const h = await withList([WS_A, WS_B]);
  h.receive(
    frame({
      type: "workspace.subscribe_refused",
      workspaceId: WS_A,
      code: "not_found",
    }),
  );
  expect(h.state.selectedWorkspaceId).toBe(WS_B);
  await h.answer("listWorkspaces", ok(workspaceList(WS_B)));
  // The person rejoined, for example on another device: the next list
  // holds it first, and the removal of the selected one selects it.
  h.receive(
    frame({
      type: "account.removed_from_workspace",
      workspaceId: WS_B,
      removedAt: AT,
    }),
  );
  await h.answer("listWorkspaces", ok(workspaceList(WS_A)));
  expect(h.state.selectedWorkspaceId).toBe(WS_A);
  expect([...h.requested]).toEqual([WS_A]);
});

test("workspace.unsubscribed with membership_ended unsubscribes, selects the next workspace, and reloads the list", async () => {
  const h = await withLiveWorkspace([WS_A, WS_B]);
  expect(h.service.openProject(PROJECT_1)).toBe(true);
  h.receive(
    frame({
      type: "workspace.unsubscribed",
      workspaceId: WS_A,
      reason: "membership_ended",
    }),
  );
  expect([...h.requested]).toEqual([WS_B]);
  expect(h.service.gateLive(WS_A)).toBe(false);
  expect(h.state).toMatchObject({
    selectedWorkspaceId: WS_B,
    workspaces: [{ id: WS_B }],
    projects: [],
    openProjectId: null,
    status: "loading",
  });
  expect(h.readNames()).toEqual(["listWorkspaces"]);
  await h.answer("listWorkspaces", ok(workspaceList(WS_B)));
  expect(h.state.selectedWorkspaceId).toBe(WS_B);
  // The membership of the last workspace ends: none is selected.
  h.receive(
    frame({
      type: "workspace.unsubscribed",
      workspaceId: WS_B,
      reason: "membership_ended",
    }),
  );
  expect([...h.requested]).toEqual([]);
  expect(h.state.selectedWorkspaceId).toBeNull();
  await h.answer("listWorkspaces", ok(workspaceList()));
  expect(h.state).toMatchObject({
    status: "ready",
    workspaces: [],
    selectedWorkspaceId: null,
  });
});

test("workspace.unsubscribed after a request ends the subscription until the next workspace.subscribed", async () => {
  const h = await withLiveWorkspace();
  // The answer for another workspace changes nothing.
  const revision = h.state.revision;
  h.receive(
    frame({
      type: "workspace.unsubscribed",
      workspaceId: WS_B,
      reason: "requested",
    }),
  );
  expect(h.service.gateLive(WS_A)).toBe(true);
  expect(h.state.revision).toBe(revision);
  const seen = h.states.length;
  h.receive(
    frame({
      type: "workspace.unsubscribed",
      workspaceId: WS_A,
      reason: "requested",
    }),
  );
  expect(h.service.gateLive(WS_A)).toBe(false);
  // The listeners learn that the gate went down.
  expect(h.state.revision).toBeGreaterThan(revision);
  expect(h.states.slice(seen)).toEqual([h.state]);
  expect([...h.requested]).toEqual([WS_A]);
  expect(h.reads).toEqual([]);
  h.receive(subscribed());
  await h.answerReload();
  expect(h.service.gateLive(WS_A)).toBe(true);
});

test("account.removed_from_workspace drops the workspace and reloads the list", async () => {
  const h = await withLiveWorkspace([WS_A, WS_B, WS_C]);
  // Another workspace: the selection stays.
  h.receive(
    frame({
      type: "account.removed_from_workspace",
      workspaceId: WS_B,
      removedAt: AT,
    }),
  );
  expect(h.state.selectedWorkspaceId).toBe(WS_A);
  expect(h.state.workspaces.map((w) => w.id)).toEqual([WS_A, WS_C]);
  expect(h.service.gateLive(WS_A)).toBe(true);
  expect(h.readNames()).toEqual(["listWorkspaces"]);
  await h.answer("listWorkspaces", ok(workspaceList(WS_A, WS_C)));
  // The selected workspace.
  h.receive(
    frame({
      type: "account.removed_from_workspace",
      workspaceId: WS_A,
      removedAt: AT,
    }),
  );
  expect([...h.requested]).toEqual([WS_C]);
  expect(h.state.selectedWorkspaceId).toBe(WS_C);
  expect(h.readNames()).toEqual(["listWorkspaces"]);
});

test("a trigger during a list load drops its answer and loads again", async () => {
  const h = await withList([WS_A, WS_B]);
  h.receive(
    frame({
      type: "account.removed_from_workspace",
      workspaceId: WS_B,
      removedAt: AT,
    }),
  );
  h.receive(
    frame({
      type: "account.join_request_decided",
      joinRequestId: JOIN_REQUEST_ID,
      workspaceId: WS_C,
      decision: "approved",
      decidedAt: AT,
    }),
  );
  // One load at a time.
  expect(h.readNames()).toEqual(["listWorkspaces"]);
  await h.answer("listWorkspaces", ok(workspaceList(WS_A, WS_B)));
  expect(h.state.workspaces.map((w) => w.id)).toEqual([WS_A]);
  expect(h.readNames()).toEqual(["listWorkspaces"]);
  await h.answer("listWorkspaces", ok(workspaceList(WS_C, WS_A)));
  expect(h.state.workspaces.map((w) => w.id)).toEqual([WS_C, WS_A]);
  // The selection stays while it is listed.
  expect(h.state.selectedWorkspaceId).toBe(WS_A);
});

test("an approved join request reloads the list; a denied one does not", async () => {
  const h = await withList([]);
  expect(h.state).toMatchObject({ status: "ready", selectedWorkspaceId: null });
  h.receive(
    frame({
      type: "account.join_request_decided",
      joinRequestId: JOIN_REQUEST_ID,
      workspaceId: WS_A,
      decision: "denied",
      decidedAt: AT,
    }),
  );
  expect(h.reads).toEqual([]);
  h.receive(
    frame({
      type: "account.join_request_decided",
      joinRequestId: JOIN_REQUEST_ID,
      workspaceId: WS_A,
      decision: "approved",
      decidedAt: AT,
    }),
  );
  expect(h.readNames()).toEqual(["listWorkspaces"]);
  await h.answer("listWorkspaces", ok(workspaceList(WS_A)));
  expect(h.state.selectedWorkspaceId).toBe(WS_A);
  expect([...h.requested]).toEqual([WS_A]);
});

test("the retry delays", () => {
  expect(
    [0, 1, 2, 3, 4, 5, 6, 40].map((n) => workspaceRetryDelayMs(n, "failed")),
  ).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  expect(workspaceRetryDelayMs(0, "rate_limited")).toBe(RATE_LIMITED_RETRY_MS);
  expect(RATE_LIMITED_RETRY_MS).toBe(60_000);
  expect(WORKSPACE_RETRY_BASE_MS).toBe(2_000);
  expect(WORKSPACE_RETRY_MAX_MS).toBe(60_000);
});

test("a failed list load is retried with a backoff, and after 60 seconds after rate_limited", async () => {
  const h = new Harness();
  h.setConnection("connected");
  await h.answer("listWorkspaces", failure("unavailable"));
  expect(h.state).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
  });
  expect(h.reads).toEqual([]);
  h.fire(2_000);
  await h.answer("listWorkspaces", failure("failed"));
  expect(h.state.problem).toBe("failed");
  h.fire(4_000);
  await h.answer("listWorkspaces", failure("rate_limited"));
  expect(h.state.problem).toBe("rate_limited");
  h.fire(60_000);
  await h.answer("listWorkspaces", failure("unavailable"));
  h.fire(16_000);
  await h.answer("listWorkspaces", ok(workspaceList(WS_A)));
  expect(h.state).toMatchObject({
    status: "loading",
    selectedWorkspaceId: WS_A,
  });
  expect(h.state).not.toHaveProperty("problem");
  // The count starts again after a success.
  h.setConnection("offline");
  h.setConnection("connected");
  await h.answer("listWorkspaces", failure("unavailable"));
  h.fire(2_000);
  expect(h.readNames()).toEqual(["listWorkspaces"]);
});

test("a list load that fails after the connection was lost schedules no retry", async () => {
  const h = new Harness();
  h.setConnection("connected");
  h.setConnection("connecting");
  await h.answer("listWorkspaces", failure("unavailable"));
  expect(h.state).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
  });
  expect(h.timers).toEqual([]);
  h.setConnection("connected");
  expect(h.readNames()).toEqual(["listWorkspaces"]);
});

test("a lost connection cancels the list retry; the next connect loads at once", async () => {
  const h = new Harness();
  h.setConnection("connected");
  await h.answer("listWorkspaces", failure("unavailable"));
  expect(h.openTimers()).toHaveLength(1);
  h.setConnection("connecting");
  expect(h.openTimers()).toHaveLength(0);
  h.setConnection("connected");
  expect(h.readNames()).toEqual(["listWorkspaces"]);
});

test("a failed reload of the workspace is retried with a backoff; events keep waiting", async () => {
  const h = await withList();
  h.receive(subscribed());
  await h.answerReload(failure("unavailable"), ok(projectList([PROJECT_1])));
  expect(h.state).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
  });
  expect(h.service.gateLive(WS_A)).toBe(false);
  h.receive(
    event("workspace.project.created", { project: project(PROJECT_2) }),
  );
  h.fire(2_000);
  await h.answerReload(ok(workspaceView()), failure("rate_limited"));
  expect(h.state.problem).toBe("rate_limited");
  h.fire(60_000);
  // An answer for another workspace is refused.
  await h.answerReload(ok(workspaceView(WS_B)), ok(projectList([PROJECT_1])));
  expect(h.state.problem).toBe("failed");
  h.fire(8_000);
  await h.answerReload();
  expect(h.state).toMatchObject({ status: "ready" });
  expect(h.state.projects.map((p) => p.id)).toEqual([PROJECT_1, PROJECT_2]);
  expect(h.service.gateLive(WS_A)).toBe(true);
  expect(h.openTimers()).toEqual([]);
  // The backoff starts again after a success.
  h.receive(subscribed());
  await h.answerReload(failure("unavailable"), ok(projectList([PROJECT_1])));
  h.fire(2_000);
  expect(h.readNames()).toEqual(["getWorkspace", "listProjects"]);
});

test("projects of another workspace are refused", async () => {
  const h = await withList();
  h.receive(subscribed());
  await h.answerReload(ok(workspaceView()), ok(projectList([PROJECT_3], WS_B)));
  expect(h.state).toMatchObject({
    status: "unavailable",
    problem: "failed",
    projects: [],
  });
  expect(h.service.gateLive(WS_A)).toBe(false);
  expect(h.service.openProject(PROJECT_3)).toBe(false);
  expect(h.state.openProjectId).toBeNull();
});

test("not_found for the workspace reloads the list too", async () => {
  const h = await withList();
  h.receive(subscribed());
  await h.answerReload(failure("not_found"), failure("not_found"));
  expect(h.readNames()).toEqual(["listWorkspaces"]);
  await h.answer("listWorkspaces", ok(workspaceList(WS_B)));
  expect(h.state.selectedWorkspaceId).toBe(WS_B);
  // The retry of the previous workspace was cancelled with the selection.
  expect(h.openTimers()).toEqual([]);
});

test("too many waiting events reload the workspace after a backoff", async () => {
  const h = await withList();
  h.receive(subscribed());
  for (let n = 0; n <= MAX_BUFFERED_EVENTS; n += 1) {
    h.receive(
      event("workspace.project.renamed", {
        projectId: PROJECT_1,
        name: "Project One Renamed",
      }),
    );
  }
  expect(h.logs).toContain(
    "Too many workspace events waited; the workspace reloads.",
  );
  // The open reload is stale.
  await h.answerReload();
  expect(h.service.gateLive(WS_A)).toBe(false);
  expect(h.state.projects).toEqual([]);
  h.fire(2_000);
  expect(h.readNames()).toEqual(["getWorkspace", "listProjects"]);
  await h.answerReload();
  expect(h.service.gateLive(WS_A)).toBe(true);
});

test("a sign-out resets everything and drops the answers on their way", async () => {
  const h = await withLiveWorkspace();
  h.service.openProject(PROJECT_1);
  h.receive(subscribed());
  h.setConnection("offline");
  h.setAccount(SIGNED_OUT);
  expect(h.state).toEqual({
    revision: h.state.revision,
    status: "signed_out",
    workspaces: [],
    selectedWorkspaceId: null,
    projects: [],
    openProjectId: null,
  });
  expect([...h.requested]).toEqual([]);
  expect(h.service.memberName(MEMBER)).toBe(UNKNOWN_MEMBER_NAME);
  expect(h.service.gateLive(WS_A)).toBe(false);
  expect(h.service.select(WS_A)).toBe(false);
  const revision = h.state.revision;
  await h.answerReload();
  expect(h.state.revision).toBe(revision);
  expect(h.state.projects).toEqual([]);

  // A pending list load and a retry are dropped as well.
  const g = new Harness();
  g.setConnection("connected");
  await g.answer("listWorkspaces", failure("unavailable"));
  g.fire(2_000);
  g.setAccount(SIGNED_OUT);
  await g.answer("listWorkspaces", ok(workspaceList(WS_A)));
  expect(g.state.workspaces).toEqual([]);
  expect(g.openTimers()).toEqual([]);
  expect([...g.requested]).toEqual([]);
});

test("another device resets the state and loads again once connected", async () => {
  const h = await withLiveWorkspace();
  h.setConnection("connecting");
  h.setAccount(accountStatus({}, OTHER_DEVICE_ID));
  expect(h.state).toMatchObject({
    status: "loading",
    workspaces: [],
    selectedWorkspaceId: null,
  });
  expect([...h.requested]).toEqual([]);
  expect(h.reads).toEqual([]);
  h.setConnection("connected");
  expect(h.readNames()).toEqual(["listWorkspaces"]);
  // A change that keeps the device changes nothing.
  const revision = h.state.revision;
  h.setAccount(accountStatus({ revision: 7 }, OTHER_DEVICE_ID));
  expect(h.state.revision).toBe(revision);
});

test("another device while a list load is open and connected loads a fresh list for it", async () => {
  const h = new Harness();
  h.setConnection("connected");
  const earlier = h.take("listWorkspaces");
  h.setAccount(accountStatus({}, OTHER_DEVICE_ID));
  expect(h.readNames()).toEqual(["listWorkspaces"]);
  earlier.answer(ok(workspaceList(WS_B)));
  await settle();
  expect(h.state.workspaces).toEqual([]);
  await h.answer("listWorkspaces", ok(workspaceList(WS_A)));
  expect(h.state).toMatchObject({
    workspaces: [{ id: WS_A }],
    selectedWorkspaceId: WS_A,
  });
  expect([...h.requested]).toEqual([WS_A]);
});

test("only a project of the selected workspace opens, and a vanished one closes", async () => {
  const h = await withList();
  expect(h.service.openProject(PROJECT_1)).toBe(false);
  h.receive(subscribed());
  await h.answerReload(
    ok(workspaceView()),
    ok(projectList([PROJECT_1, PROJECT_2])),
  );
  expect(h.service.openProject(UNKNOWN_PROJECT)).toBe(false);
  expect(h.state.openProjectId).toBeNull();
  expect(h.service.openProject(PROJECT_2)).toBe(true);
  expect(h.state.openProjectId).toBe(PROJECT_2);
  // The project is gone after a reload.
  h.receive(subscribed());
  await h.answerReload(ok(workspaceView()), ok(projectList([PROJECT_1])));
  expect(h.state.openProjectId).toBeNull();
  expect(h.service.openProject(PROJECT_1)).toBe(true);
  expect(h.service.openProject(null)).toBe(true);
  expect(h.state.openProjectId).toBeNull();
  expect(h.service.openProject(PROJECT_1)).toBe(true);
  // Another workspace closes it.
  h.service.select(WS_B);
  expect(h.state).toMatchObject({ openProjectId: null, projects: [] });
  expect(h.service.openProject(PROJECT_1)).toBe(false);
});

test("a listener that throws is logged, and the others still get the state", async () => {
  const h = new Harness();
  const seen: number[] = [];
  h.service.onChange(() => {
    throw new Error("listener");
  });
  const remove = h.service.onChange((state) => seen.push(state.revision));
  h.setConnection("connected");
  await h.answer("listWorkspaces", ok(workspaceList(WS_A)));
  expect(seen.length).toBeGreaterThan(0);
  expect(h.logs).toContain("A workspace state listener failed.");
  remove();
  const count = seen.length;
  h.service.select(WS_A);
  h.receive(subscribed());
  expect(seen).toHaveLength(count);
});

test("a service created while the client is connected loads the list", () => {
  const h = new Harness(accountStatus(), "connected");
  expect(h.readNames()).toEqual(["listWorkspaces"]);
});

test("a listener that selects another workspace never lets a later listener see an older state", async () => {
  const h = await withList([WS_A, WS_B]);
  const order: number[] = [];
  let selectedOnce = false;
  h.service.onChange((state) => {
    if (!selectedOnce && state.selectedWorkspaceId === WS_A) {
      selectedOnce = true;
      h.service.select(WS_B);
    }
  });
  h.service.onChange((state) => order.push(state.revision));
  h.receive(subscribed());
  expect(selectedOnce).toBe(true);
  expect(order.length).toBeGreaterThan(0);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(order.at(-1)).toBe(h.state.revision);
  expect(h.state.selectedWorkspaceId).toBe(WS_B);
});

test("a list answer after close subscribes nothing", async () => {
  const h = new Harness();
  h.setConnection("connected");
  h.service.close();
  await h.answer("listWorkspaces", ok(workspaceList(WS_A)));
  expect([...h.requested]).toEqual([]);
  expect(h.frames).toEqual([]);
  expect(h.service.selectedWorkspaceId()).toBeNull();
});

test("close stops listening and cancels the timers", async () => {
  const h = new Harness();
  h.setConnection("connected");
  await h.answer("listWorkspaces", failure("unavailable"));
  h.service.close();
  expect(h.openTimers()).toEqual([]);
  expect(h.accountListeners.size).toBe(0);
  expect(h.connectionListeners.size).toBe(0);
  expect(h.messageListeners.size).toBe(0);
  expect(h.service.select(WS_A)).toBe(false);
  h.service.close();
});

const moduleFolder = path.dirname(fileURLToPath(import.meta.url));

test("no log holds a name or an ID, and the service never logs with console", async () => {
  const h = await withList([WS_A, WS_B]);
  h.receive(subscribed());
  await h.answerReload(failure("not_found"), ok(projectList([PROJECT_1])));
  await h.answer("listWorkspaces", failure("rate_limited"));
  h.receive(
    frame({
      type: "workspace.subscribe_refused",
      workspaceId: WS_A,
      code: "not_found",
    }),
  );
  h.service.onChange(() => {
    throw new Error("Workspace Alpha");
  });
  await h.answer("listWorkspaces", ok(workspaceList(WS_A, WS_B)));
  expect(h.logs).toHaveLength(4);
  const text = h.logs.join("\n");
  for (const value of [
    ...NAMES,
    DEVICE_ID,
    USER_ID,
    OTHER_USER_ID,
    WS_A,
    WS_B,
    OWNER,
    MEMBER,
    PROJECT_1,
  ]) {
    expect(text).not.toContain(value);
  }
  const source = readFileSync(path.join(moduleFolder, "service.ts"), "utf8");
  expect(source).not.toMatch(/\bconsole\./);
  // The state holds no user ID either.
  expect(JSON.stringify(h.state)).not.toContain(USER_ID);
});
