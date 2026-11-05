import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentListResponseSchema,
  AgentRunListResponseSchema,
  decodeServerMessage,
  isTerminalRunState,
  type ProjectId,
  type RunState,
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
import { MAX_BUFFERED_EVENTS } from "../workspace/resync.ts";
import type { WorkspaceAccount, WorkspaceState } from "../workspace/service.ts";
import {
  AGENT_FOLLOW_UP_DELAY_MS,
  createAgentActivityService,
  type AgentActivityService,
  type AgentActivityState,
  type AgentConnection,
  type AgentWorkspaces,
} from "./service.ts";

const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000014";
const WS_A = "0192f0a0-7b3c-7d4e-8f50-0000000000a1" as WorkspaceId;
const WS_B = "0192f0a0-7b3c-7d4e-8f50-0000000000a2" as WorkspaceId;
const OWNER = "0192f0a0-7b3c-7d4e-8f50-0000000000c1";
const MEMBER = "0192f0a0-7b3c-7d4e-8f50-0000000000c2";
const PROJECT_1 = "0192f0a0-7b3c-7d4e-8f50-0000000000e1" as ProjectId;
const PROJECT_2 = "0192f0a0-7b3c-7d4e-8f50-0000000000e2" as ProjectId;
const AGENT_1 = "0192f0a0-7b3c-7d4e-8f50-0000000000f1";
const AGENT_2 = "0192f0a0-7b3c-7d4e-8f50-0000000000f2";
/** An agent of another project, which no agent list of these tests holds. */
const OTHER_AGENT = "0192f0a0-7b3c-7d4e-8f50-0000000000f9";
const AT = "2026-11-05T10:00:00.000Z";
const LATER = "2026-11-05T11:00:00.000Z";

/** Every name that the fixtures use, which no log may hold. */
const NAMES = ["Agent Alpha", "Agent Beta", "Out of memory", "octocat"];
const AGENT_NAMES: Readonly<Record<string, string>> = {
  [AGENT_1]: "Agent Alpha",
  [AGENT_2]: "Agent Beta",
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

function runId(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-0000000b${n.toString(16).padStart(4, "0")}`;
}

function agentList(
  ids: readonly string[],
  projectId: ProjectId = PROJECT_1,
  disabled: readonly string[] = [],
) {
  return AgentListResponseSchema.parse({
    agents: ids.map((id) => ({
      id,
      projectId,
      name: AGENT_NAMES[id] ?? "Agent Alpha",
      ownerMemberId: id === AGENT_1 ? OWNER : MEMBER,
      disabledAt: disabled.includes(id) ? LATER : null,
    })),
  });
}

function run(
  n: number,
  state: RunState,
  agentId: string = AGENT_1,
  projectId: ProjectId = PROJECT_1,
) {
  return {
    id: runId(n),
    agentId,
    projectId,
    repositoryId: null,
    state,
    reason: null as string | null,
    createdAt: AT,
    finishedAt: isTerminalRunState(state) ? LATER : null,
  };
}

function runList(
  unfinishedRuns: readonly ReturnType<typeof run>[],
  finishedRuns: readonly ReturnType<typeof run>[] = [],
) {
  return AgentRunListResponseSchema.parse({ unfinishedRuns, finishedRuns });
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

function subscribed(workspaceId: WorkspaceId = WS_A): ServerMessage {
  return frame({
    type: "workspace.subscribed",
    workspaceId,
    onlineMemberIds: [OWNER],
  });
}

let eventCount = 0;

/** A server event, decoded as the connection client receives it. */
function event(
  type: string,
  payload: Record<string, unknown>,
  actor: Record<string, unknown>,
  workspaceId: WorkspaceId = WS_A,
): ServerMessage {
  eventCount += 1;
  const decoded = decodeServerMessage({
    protocolVersion: 0,
    id: `0192f0a0-7b3c-7d4e-8f50-${eventCount.toString(16).padStart(12, "0")}`,
    occurredAt: LATER,
    workspaceId,
    actor,
    deviceId: null,
    type,
    payload,
  });
  if (!decoded.ok || decoded.kind !== "event") {
    throw new Error("The test event does not decode");
  }
  return { kind: "event", event: decoded.event };
}

interface RunEventOptions {
  readonly agentId?: string;
  /** A server cancellation with this code. */
  readonly cancelledFor?: string;
  readonly workspaceId?: WorkspaceId;
}

/** `agent.run.state_changed`: the server creates, the agent changes. */
function runEvent(
  n: number,
  previousState: RunState | null,
  state: RunState,
  options: RunEventOptions = {},
): ServerMessage {
  const agentId = options.agentId ?? AGENT_1;
  const system = previousState === null || options.cancelledFor !== undefined;
  return event(
    "agent.run.state_changed",
    {
      runId: runId(n),
      agentId,
      previousState,
      state,
      ...(options.cancelledFor === undefined
        ? {}
        : { reason: options.cancelledFor }),
    },
    system ? { kind: "system" } : { kind: "agent", agentId },
    options.workspaceId,
  );
}

function memberRemoved(workspaceId: WorkspaceId = WS_A): ServerMessage {
  return event(
    "workspace.member.removed",
    { memberId: MEMBER, removedAt: LATER },
    { kind: "system" },
    workspaceId,
  );
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
  workspaceState: WorkspaceState = Object.freeze({
    revision: 0,
    status: "loading",
    workspaces: [],
    selectedWorkspaceId: null,
    projects: [],
    openProjectId: null,
  });
  readonly accountListeners = new Set<(status: AccountStatus) => void>();
  readonly connectionListeners = new Set<(status: ConnectionStatus) => void>();
  readonly messageListeners = new Set<(message: ServerMessage) => void>();
  readonly workspaceListeners = new Set<(state: WorkspaceState) => void>();
  reads: Read[] = [];
  readonly timers: Timer[] = [];
  readonly logs: string[] = [];
  readonly states: AgentActivityState[] = [];
  readonly service: AgentActivityService;

  constructor(status: AccountStatus = accountStatus()) {
    this.accountStatus = status;
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
    const connection: AgentConnection = {
      status: () => this.connectionStatus,
      onStatusChange: (listener) => {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
      },
      onMessage: (listener) => {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
      },
    };
    const workspaces: AgentWorkspaces = {
      state: () => this.workspaceState,
      onChange: (listener) => {
        this.workspaceListeners.add(listener);
        return () => {
          this.workspaceListeners.delete(listener);
        };
      },
    };
    this.service = createAgentActivityService({
      account,
      connection,
      workspaces,
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

  /** The workspace service selects `workspaceId` and opens `projectId`. */
  setWorkspace(
    workspaceId: WorkspaceId | null,
    projectId: ProjectId | null = null,
  ): void {
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

  receive(message: ServerMessage): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  get state(): AgentActivityState {
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

  /** Answers a full reload: the runs, and then the agents that it reads. */
  async answerReload(
    runs: WorkspaceReadResult<unknown> = ok(runList([run(1, "running")])),
    agents: WorkspaceReadResult<unknown> = ok(agentList([AGENT_1, AGENT_2])),
  ): Promise<void> {
    await this.answer("listRuns", runs);
    await this.answer("listAgents", agents);
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

/** Signed in, connected, and the workspace subscribed, with no project open. */
function subscribedHarness(): Harness {
  const h = new Harness();
  h.setConnection("connected");
  h.setWorkspace(WS_A);
  h.receive(subscribed());
  return h;
}

/**
 * As `subscribedHarness`, with the first project open and reloaded: run 1
 * of agent 1 runs, and agents 1 and 2 are listed.
 */
async function liveHarness(): Promise<Harness> {
  const h = subscribedHarness();
  h.setWorkspace(WS_A, PROJECT_1);
  await h.answerReload();
  expect(h.state.status).toBe("ready");
  expect(h.reads).toEqual([]);
  return h;
}

function runStates(state: AgentActivityState): string[] {
  return [...state.unfinishedRuns, ...state.finishedRuns].map(
    (item) => `${item.id.slice(-2)} ${item.state}`,
  );
}

test("opening a project reads its runs first and then its agents", async () => {
  const h = subscribedHarness();
  expect(h.state).toEqual({
    revision: 0,
    status: "no_project",
    workspaceId: null,
    projectId: null,
    agents: [],
    unfinishedRuns: [],
    finishedRuns: [],
  });
  expect(h.reads).toEqual([]);
  h.setWorkspace(WS_A, PROJECT_1);
  expect(h.state).toMatchObject({
    status: "loading",
    workspaceId: WS_A,
    projectId: PROJECT_1,
  });
  // The agents are read only after the runs answered.
  expect(h.readNames()).toEqual(["listRuns"]);
  expect(h.reads[0]?.params).toEqual({ projectId: PROJECT_1 });
  await h.answer("listRuns", ok(runList([run(1, "running")])));
  expect(h.readNames()).toEqual(["listAgents"]);
  expect(h.reads[0]?.params).toEqual({ projectId: PROJECT_1 });
  expect(h.state.status).toBe("loading");
  await h.answer("listAgents", ok(agentList([AGENT_1, AGENT_2])));
  expect(h.state).toMatchObject({
    status: "ready",
    workspaceId: WS_A,
    projectId: PROJECT_1,
    agents: [
      { id: AGENT_1, ownerMemberId: OWNER, disabledAt: null },
      { id: AGENT_2, ownerMemberId: MEMBER, disabledAt: null },
    ],
    unfinishedRuns: [{ id: runId(1), state: "running" }],
    finishedRuns: [],
  });
  expect(h.state).not.toHaveProperty("problem");
  expect(Object.isFrozen(h.state)).toBe(true);
  expect(Object.isFrozen(h.state.agents)).toBe(true);
  expect(Object.isFrozen(h.state.agents[0])).toBe(true);
  expect(Object.isFrozen(h.state.unfinishedRuns[0])).toBe(true);
  // Each listener call got a newer revision.
  const revisions = h.states.map((state) => state.revision);
  expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
  expect(new Set(revisions).size).toBe(revisions.length);
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
    h.setWorkspace(WS_A, PROJECT_1);
    h.receive(subscribed());
    expect(h.reads).toEqual([]);
    expect(h.state.status).toBe("no_project");
    // A sign-in follows the open project.
    h.setAccount(accountStatus());
    expect(h.readNames()).toEqual(["listRuns"]);
  }
});

test("a follow-up reload waits one second", () => {
  expect(AGENT_FOLLOW_UP_DELAY_MS).toBe(1_000);
});

test("every workspace.subscribed of the selected workspace reloads the open project", async () => {
  const h = await liveHarness();
  const revision = h.state.revision;
  h.receive(subscribed(WS_B));
  expect(h.reads).toEqual([]);
  h.receive(subscribed());
  expect(h.readNames()).toEqual(["listRuns"]);
  // The state stays ready during the reload, and beginning it changes nothing.
  expect(h.state).toMatchObject({ status: "ready", revision });
  await h.answerReload(
    ok(runList([run(2, "queued")], [run(1, "completed")])),
    ok(agentList([AGENT_1])),
  );
  expect(runStates(h.state)).toEqual(["02 queued", "01 completed"]);
  expect(h.state.agents.map((agent) => agent.id)).toEqual([AGENT_1]);
});

test("workspace.subscribed with no open project reads nothing until a project opens", async () => {
  const h = subscribedHarness();
  expect(h.reads).toEqual([]);
  // Events wait for nothing while no project is open.
  h.receive(runEvent(1, "running", "completed"));
  h.setWorkspace(WS_A, PROJECT_1);
  await h.answerReload();
  expect(runStates(h.state)).toEqual(["01 running"]);
});

test("events during the reload wait and apply after it, in order", async () => {
  const h = subscribedHarness();
  h.setWorkspace(WS_A, PROJECT_1);
  h.receive(runEvent(2, null, "queued"));
  h.receive(runEvent(2, "queued", "running"));
  await h.answer("listRuns", ok(runList([run(1, "running")])));
  h.receive(runEvent(1, "running", "completed"));
  expect(h.state.status).toBe("loading");
  await h.answer("listAgents", ok(agentList([AGENT_1, AGENT_2])));
  expect(runStates(h.state)).toEqual(["02 running", "01 completed"]);
  // Live now: an event applies at once.
  h.receive(runEvent(2, "running", "awaiting_input"));
  expect(runStates(h.state)).toEqual(["02 awaiting_input", "01 completed"]);
  expect(h.reads).toEqual([]);
  expect(h.openTimers()).toEqual([]);
});

test("one reload runs at a time, and the answer of an earlier reload is dropped", async () => {
  const h = subscribedHarness();
  h.setWorkspace(WS_A, PROJECT_1);
  h.receive(subscribed());
  // The second reload waits for the first.
  expect(h.readNames()).toEqual(["listRuns"]);
  // The stale reload stops after its runs, without reading the agents.
  await h.answer("listRuns", ok(runList([run(9, "running")])));
  expect(h.readNames()).toEqual(["listRuns"]);
  expect(h.state.status).toBe("loading");
  await h.answer("listRuns", ok(runList([run(1, "running")])));
  // A newer reload begins while the agents are read: their answer is dropped.
  h.receive(subscribed());
  await h.answer("listAgents", ok(agentList([AGENT_1, AGENT_2])));
  expect(h.state.status).toBe("loading");
  expect(h.state.unfinishedRuns).toEqual([]);
  expect(h.readNames()).toEqual(["listRuns"]);
  await h.answerReload(ok(runList([run(3, "queued")])));
  expect(h.state.status).toBe("ready");
  expect(runStates(h.state)).toEqual(["03 queued"]);
  expect(h.reads).toEqual([]);
});

test("an answer for the previous project or workspace is dropped, and another project reloads", async () => {
  const h = await liveHarness();
  h.setWorkspace(WS_A, PROJECT_2);
  expect(h.state).toMatchObject({
    status: "loading",
    projectId: PROJECT_2,
    agents: [],
    unfinishedRuns: [],
  });
  expect(h.reads[0]?.params).toEqual({ projectId: PROJECT_2 });
  // Back to the first project while the second one's read is on its way.
  h.setWorkspace(WS_A, PROJECT_1);
  expect(h.reads).toHaveLength(1);
  await h.answer(
    "listRuns",
    ok(runList([run(5, "running", AGENT_2, PROJECT_2)])),
  );
  expect(h.readNames()).toEqual(["listRuns"]);
  expect(h.reads[0]?.params).toEqual({ projectId: PROJECT_1 });
  await h.answerReload();
  expect(h.state).toMatchObject({ status: "ready", projectId: PROJECT_1 });
  expect(runStates(h.state)).toEqual(["01 running"]);

  // The project closes while its agents are read.
  h.receive(subscribed());
  await h.answer("listRuns", ok(runList([], [run(1, "completed")])));
  h.setWorkspace(WS_A);
  await h.answer("listAgents", ok(agentList([AGENT_1])));
  expect(h.state).toMatchObject({
    status: "no_project",
    projectId: null,
    workspaceId: null,
    agents: [],
    unfinishedRuns: [],
    finishedRuns: [],
  });

  // Another workspace: the read for the previous one is dropped.
  h.setWorkspace(WS_A, PROJECT_1);
  h.setWorkspace(WS_B, PROJECT_2);
  expect(h.state).toMatchObject({ workspaceId: WS_B, projectId: PROJECT_2 });
  await h.answer("listRuns", ok(runList([run(1, "running")])));
  expect(h.reads[0]?.params).toEqual({ projectId: PROJECT_2 });
  await h.answerReload(
    ok(runList([run(5, "running", AGENT_2, PROJECT_2)])),
    ok(agentList([AGENT_2], PROJECT_2)),
  );
  expect(h.state).toMatchObject({ status: "ready", projectId: PROJECT_2 });
  expect(runStates(h.state)).toEqual(["05 running"]);
  // The subscription belonged to the previous workspace: events of the new
  // one are ignored until its workspace.subscribed.
  h.receive(runEvent(5, "running", "completed", { agentId: AGENT_2 }));
  h.receive(
    runEvent(5, "running", "completed", {
      agentId: AGENT_2,
      workspaceId: WS_B,
    }),
  );
  expect(runStates(h.state)).toEqual(["05 running"]);
  expect(h.openTimers()).toEqual([]);
  h.receive(subscribed(WS_B));
  await h.answerReload(
    ok(runList([run(5, "running", AGENT_2, PROJECT_2)])),
    ok(agentList([AGENT_2], PROJECT_2)),
  );
  h.receive(
    runEvent(5, "running", "completed", {
      agentId: AGENT_2,
      workspaceId: WS_B,
    }),
  );
  expect(runStates(h.state)).toEqual(["05 completed"]);
});

test("another workspace with no open project clears the state and tells the listeners", async () => {
  const h = await liveHarness();
  const count = h.states.length;
  h.setWorkspace(WS_B);
  expect(h.state).toEqual({
    revision: h.state.revision,
    status: "no_project",
    workspaceId: null,
    projectId: null,
    agents: [],
    unfinishedRuns: [],
    finishedRuns: [],
  });
  expect(h.states).toHaveLength(count + 1);
  expect(h.states.at(-1)).toBe(h.state);
});

test("a live event for an agent of another project is ignored and reloads nothing", async () => {
  const h = await liveHarness();
  const revision = h.state.revision;
  h.receive(runEvent(7, null, "queued", { agentId: OTHER_AGENT }));
  h.receive(runEvent(7, "queued", "running", { agentId: OTHER_AGENT }));
  expect(h.state.revision).toBe(revision);
  expect(h.reads).toEqual([]);
  expect(h.openTimers()).toEqual([]);
  // Events of another workspace and other event types are ignored as well.
  h.receive(runEvent(1, "running", "completed", { workspaceId: WS_B }));
  h.receive(
    event(
      "workspace.member.renamed",
      { memberId: MEMBER, displayName: "Grace Renamed" },
      { kind: "system" },
    ),
  );
  expect(h.state.revision).toBe(revision);
  expect(h.openTimers()).toEqual([]);
});

test("unknown_run reloads everything after a pause, at most once for each reload", async () => {
  const h = await liveHarness();
  // A run of a listed agent that the activity does not hold changes.
  h.receive(runEvent(8, "queued", "running"));
  h.receive(runEvent(9, "queued", "running", { agentId: AGENT_2 }));
  expect(h.reads).toEqual([]);
  // One pause for both.
  h.fire(AGENT_FOLLOW_UP_DELAY_MS);
  expect(h.readNames()).toEqual(["listRuns"]);
  // The server still does not list run 8, for example beyond its limit.
  await h.answerReload();
  h.receive(runEvent(8, "running", "completed"));
  // No loop: the reload that unknown_run began does not begin another one.
  expect(h.openTimers()).toEqual([]);
  expect(h.reads).toEqual([]);
  // After another reload, unknown_run reloads once again.
  h.receive(subscribed());
  await h.answerReload();
  h.receive(runEvent(8, "running", "completed"));
  h.fire(AGENT_FOLLOW_UP_DELAY_MS);
  expect(h.readNames()).toEqual(["listRuns"]);
  await h.answerReload();
  h.receive(runEvent(8, "running", "completed"));
  expect(h.openTimers()).toEqual([]);
});

test("an unknown_run that waited for the reload that unknown_run began reloads nothing more", async () => {
  const h = await liveHarness();
  h.receive(runEvent(8, "queued", "running"));
  h.fire(AGENT_FOLLOW_UP_DELAY_MS);
  await h.answer("listRuns", ok(runList([run(1, "running")])));
  // Buffered between the two reads, applied right after the reload.
  h.receive(runEvent(8, "running", "completed"));
  await h.answer("listAgents", ok(agentList([AGENT_1, AGENT_2])));
  expect(h.openTimers()).toEqual([]);
  expect(h.reads).toEqual([]);
});

test("a full follow-up stays full when a part reload is asked for within the delay", async () => {
  const h = await liveHarness();
  h.receive(runEvent(8, "queued", "running"));
  h.receive(memberRemoved());
  h.receive(
    runEvent(1, "running", "cancelled", { cancelledFor: "member_removed" }),
  );
  h.fire(AGENT_FOLLOW_UP_DELAY_MS);
  expect(h.readNames()).toEqual(["listRuns"]);
});

test("account.device_revoked reloads the agent list alone", async () => {
  const revoked = frame({
    type: "account.device_revoked",
    deviceId: OTHER_DEVICE_ID,
    reason: "removed",
    revokedAt: LATER,
  });
  const idle = subscribedHarness();
  idle.receive(revoked);
  expect(idle.openTimers()).toEqual([]);

  // No run of the revoked device was unfinished, so no cancellation reports
  // that its agents were disabled.
  const h = await liveHarness();
  h.receive(revoked);
  expect(h.reads).toEqual([]);
  h.fire(AGENT_FOLLOW_UP_DELAY_MS);
  expect(h.readNames()).toEqual(["listAgents"]);
  await h.answer(
    "listAgents",
    ok(agentList([AGENT_1, AGENT_2], PROJECT_1, [AGENT_1])),
  );
  expect(h.state.agents[0]?.disabledAt).toBe(LATER);
  expect(runStates(h.state)).toEqual(["01 running"]);

  // While a failed reload waits for its retry, the frame keeps the backoff.
  h.receive(subscribed());
  await h.answer("listRuns", failure("rate_limited"));
  expect(h.openTimers()).toHaveLength(1);
  h.receive(revoked);
  expect(h.openTimers()).toHaveLength(1);
  expect(h.reads).toEqual([]);
});

test("a server cancellation that disables agents reloads the agent list alone", async () => {
  const h = await liveHarness();
  h.receive(subscribed());
  await h.answerReload(
    ok(runList([run(1, "running"), run(2, "queued", AGENT_2)])),
  );
  h.receive(
    runEvent(1, "running", "cancelled", { cancelledFor: "member_removed" }),
  );
  h.receive(
    runEvent(2, "queued", "cancelled", {
      agentId: AGENT_2,
      cancelledFor: "member_removed",
    }),
  );
  expect(runStates(h.state)).toEqual(["02 cancelled", "01 cancelled"]);
  expect(h.reads).toEqual([]);
  // One pause for the burst, then the agents alone.
  h.fire(AGENT_FOLLOW_UP_DELAY_MS);
  expect(h.readNames()).toEqual(["listAgents"]);
  expect(h.reads[0]?.params).toEqual({ projectId: PROJECT_1 });
  // Events during the part reload wait for it.
  h.receive(runEvent(3, null, "queued"));
  expect(runStates(h.state)).toEqual(["02 cancelled", "01 cancelled"]);
  await h.answer(
    "listAgents",
    ok(agentList([AGENT_1, AGENT_2], PROJECT_1, [AGENT_2])),
  );
  expect(h.state.agents.map((agent) => agent.disabledAt)).toEqual([
    null,
    LATER,
  ]);
  // The runs stay, with the event that waited on top.
  expect(runStates(h.state)).toEqual([
    "03 queued",
    "02 cancelled",
    "01 cancelled",
  ]);
  expect(h.reads).toEqual([]);
  expect(h.openTimers()).toEqual([]);

  // A cancellation of another project's run disables agents too.
  h.receive(
    runEvent(7, "running", "cancelled", {
      agentId: OTHER_AGENT,
      cancelledFor: "device_revoked",
    }),
  );
  h.fire(AGENT_FOLLOW_UP_DELAY_MS);
  expect(h.readNames()).toEqual(["listAgents"]);
});

test("workspace.member.removed reloads the agent list alone, also when it waited for a reload", async () => {
  const h = await liveHarness();
  h.receive(memberRemoved(WS_B));
  expect(h.openTimers()).toEqual([]);
  h.receive(memberRemoved());
  h.receive(memberRemoved());
  h.fire(AGENT_FOLLOW_UP_DELAY_MS);
  expect(h.readNames()).toEqual(["listAgents"]);
  await h.answer("listAgents", ok(agentList([AGENT_1], PROJECT_1)));
  expect(h.state.agents.map((agent) => agent.id)).toEqual([AGENT_1]);
  expect(runStates(h.state)).toEqual(["01 running"]);

  // The removal arrives during a full reload, which may have read the
  // agents before it: the agents reload once more.
  h.receive(subscribed());
  await h.answer("listRuns", ok(runList([run(1, "running")])));
  h.receive(memberRemoved());
  await h.answer("listAgents", ok(agentList([AGENT_1, AGENT_2])));
  h.fire(AGENT_FOLLOW_UP_DELAY_MS);
  expect(h.readNames()).toEqual(["listAgents"]);
  await h.answer(
    "listAgents",
    ok(agentList([AGENT_1, AGENT_2], PROJECT_1, [AGENT_2])),
  );
  expect(h.state.agents[1]?.disabledAt).toBe(LATER);
});

test("a full reload replaces a waiting reload of the agents", async () => {
  const h = await liveHarness();
  h.receive(memberRemoved());
  expect(h.openTimers()).toHaveLength(1);
  h.receive(subscribed());
  expect(h.openTimers()).toEqual([]);
  await h.answerReload();
  expect(h.reads).toEqual([]);
});

test("a failed reload is retried with the workspace service's backoff; events keep waiting", async () => {
  const h = subscribedHarness();
  h.setWorkspace(WS_A, PROJECT_1);
  await h.answer("listRuns", failure("unavailable"));
  // The agents are not read after the runs failed.
  expect(h.reads).toEqual([]);
  expect(h.state).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
  });
  h.receive(runEvent(2, null, "queued"));
  h.fire(2_000);
  await h.answerReload(
    ok(runList([run(1, "running")])),
    failure("rate_limited"),
  );
  expect(h.state.problem).toBe("rate_limited");
  h.fire(60_000);
  // An answer that holds another project's runs is refused.
  await h.answerReload(ok(runList([run(5, "running", AGENT_2, PROJECT_2)])));
  expect(h.state.problem).toBe("failed");
  h.fire(8_000);
  // A read that throws counts as unavailable.
  h.take("listRuns").answer(
    Promise.reject(
      new Error("read"),
    ) as unknown as WorkspaceReadResult<unknown>,
  );
  await settle();
  expect(h.state.problem).toBe("unavailable");
  h.fire(16_000);
  // Another trigger during a retry's read waits for it.
  h.receive(subscribed());
  expect(h.readNames()).toEqual(["listRuns"]);
  await h.answer("listRuns", ok(runList([run(1, "running")])));
  expect(h.readNames()).toEqual(["listRuns"]);
  await h.answerReload();
  expect(h.state).toMatchObject({ status: "ready" });
  expect(h.state).not.toHaveProperty("problem");
  expect(runStates(h.state)).toEqual(["02 queued", "01 running"]);
  expect(h.openTimers()).toEqual([]);

  // The count starts again after a success; a failed part reload is
  // retried as a full one.
  h.receive(memberRemoved());
  h.fire(AGENT_FOLLOW_UP_DELAY_MS);
  await h.answer("listAgents", failure("failed"));
  expect(h.state).toMatchObject({ status: "unavailable", problem: "failed" });
  expect(runStates(h.state)).toEqual(["02 queued", "01 running"]);
  h.fire(2_000);
  expect(h.readNames()).toEqual(["listRuns"]);
});

test("too many waiting events reload the activity after a backoff", async () => {
  const h = subscribedHarness();
  h.setWorkspace(WS_A, PROJECT_1);
  for (let n = 0; n <= MAX_BUFFERED_EVENTS; n += 1) {
    h.receive(runEvent(7, null, "queued", { agentId: OTHER_AGENT }));
  }
  expect(h.logs).toContain(
    "Too many agent events waited; the agent activity reloads.",
  );
  // The open reload is stale.
  await h.answer("listRuns", ok(runList([run(1, "running")])));
  expect(h.reads).toEqual([]);
  expect(h.state.status).toBe("loading");
  h.fire(2_000);
  await h.answerReload();
  expect(h.state.status).toBe("ready");
  h.receive(runEvent(1, "running", "completed"));
  expect(runStates(h.state)).toEqual(["01 completed"]);
});

test("a lost connection ends the gate until the next workspace.subscribed", async () => {
  const h = await liveHarness();
  h.receive(subscribed());
  h.setConnection("offline");
  // The open reload is stale, and events are ignored.
  await h.answer("listRuns", ok(runList([], [run(1, "completed")])));
  expect(h.reads).toEqual([]);
  h.receive(runEvent(1, "running", "completed"));
  expect(runStates(h.state)).toEqual(["01 running"]);
  // What was loaded stays.
  expect(h.state.status).toBe("ready");
  h.setConnection("connecting");
  h.setConnection("connected");
  expect(h.reads).toEqual([]);
  h.receive(subscribed());
  await h.answerReload(ok(runList([], [run(1, "completed")])));
  expect(runStates(h.state)).toEqual(["01 completed"]);

  // A lost connection also cancels a retry and a waiting reload of the agents.
  h.receive(memberRemoved());
  h.setConnection("offline");
  expect(h.openTimers()).toEqual([]);
  h.setConnection("connected");
  h.receive(subscribed());
  await h.answer("listRuns", failure("unavailable"));
  expect(h.openTimers()).toHaveLength(1);
  h.setConnection("offline");
  expect(h.openTimers()).toEqual([]);
});

test("a refused or ended subscription ends the gate", async () => {
  for (const ending of [
    frame({
      type: "workspace.unsubscribed",
      workspaceId: WS_A,
      reason: "requested",
    }),
    frame({
      type: "workspace.subscribe_refused",
      workspaceId: WS_A,
      code: "not_found",
    }),
  ]) {
    const h = await liveHarness();
    h.receive(ending);
    h.receive(runEvent(1, "running", "completed"));
    expect(runStates(h.state)).toEqual(["01 running"]);
    expect(h.reads).toEqual([]);
  }
});

test("an ended or refused subscription of another workspace leaves the gate alone", async () => {
  const h = await liveHarness();
  h.receive(
    frame({
      type: "workspace.unsubscribed",
      workspaceId: WS_B,
      reason: "requested",
    }),
  );
  h.receive(
    frame({
      type: "workspace.subscribe_refused",
      workspaceId: WS_B,
      code: "not_found",
    }),
  );
  h.receive(runEvent(1, "running", "completed"));
  expect(runStates(h.state)).toEqual(["01 completed"]);
});

test("workspace.subscribed cancels a waiting retry and reloads at once", async () => {
  const h = subscribedHarness();
  h.setWorkspace(WS_A, PROJECT_1);
  await h.answer("listRuns", failure("unavailable"));
  expect(h.openTimers()).toHaveLength(1);
  h.receive(subscribed());
  expect(h.openTimers()).toEqual([]);
  expect(h.readNames()).toEqual(["listRuns"]);
});

test("another project starts the backoff again", async () => {
  const h = subscribedHarness();
  h.setWorkspace(WS_A, PROJECT_1);
  await h.answer("listRuns", failure("unavailable"));
  h.fire(2_000);
  await h.answer("listRuns", failure("unavailable"));
  h.setWorkspace(WS_A, PROJECT_2);
  expect(h.openTimers()).toEqual([]);
  await h.answer("listRuns", failure("unavailable"));
  h.fire(2_000);
});

test("a project opened before the subscription loads, and applies events only once subscribed", async () => {
  const h = new Harness();
  h.setWorkspace(WS_A, PROJECT_1);
  expect(h.readNames()).toEqual(["listRuns"]);
  await h.answerReload();
  expect(h.state.status).toBe("ready");
  h.receive(runEvent(1, "running", "completed"));
  expect(runStates(h.state)).toEqual(["01 running"]);
  h.setConnection("connected");
  h.receive(subscribed());
  await h.answerReload();
  h.receive(runEvent(1, "running", "completed"));
  expect(runStates(h.state)).toEqual(["01 completed"]);
});

test("a sign-out clears everything and drops the answers on their way", async () => {
  const h = await liveHarness();
  h.receive(subscribed());
  h.receive(runEvent(1, "running", "completed"));
  h.setAccount(SIGNED_OUT);
  expect(h.state).toEqual({
    revision: h.state.revision,
    status: "no_project",
    workspaceId: null,
    projectId: null,
    agents: [],
    unfinishedRuns: [],
    finishedRuns: [],
  });
  const revision = h.state.revision;
  // The reload of the previous device stops after its runs.
  await h.answer("listRuns", ok(runList([], [run(1, "completed")])));
  expect(h.reads).toEqual([]);
  expect(h.state.revision).toBe(revision);
  // Frames and events change nothing while signed out.
  h.receive(subscribed());
  h.receive(runEvent(1, "running", "completed"));
  expect(h.reads).toEqual([]);
  expect(h.state.revision).toBe(revision);

  // A retry and a waiting reload of the agents are dropped as well.
  const g = await liveHarness();
  g.receive(memberRemoved());
  g.setAccount(SIGNED_OUT);
  expect(g.openTimers()).toEqual([]);
  const f = subscribedHarness();
  f.setWorkspace(WS_A, PROJECT_1);
  await f.answer("listRuns", failure("unavailable"));
  f.setAccount(SIGNED_OUT);
  expect(f.openTimers()).toEqual([]);
});

test("another device clears everything, and its reload does not wait for the dropped one", async () => {
  const h = await liveHarness();
  h.receive(subscribed());
  h.setAccount(accountStatus({}, OTHER_DEVICE_ID));
  // The fake workspace service still shows the project, so it loads again
  // for the new device at once.
  expect(h.state).toMatchObject({
    status: "loading",
    agents: [],
    unfinishedRuns: [],
  });
  expect(h.readNames()).toEqual(["listRuns", "listRuns"]);
  // The gate ended with the device: this event is ignored, not buffered.
  h.receive(runEvent(1, "running", "completed"));
  // The first read was for the previous device: its answer is dropped, and
  // it does not let a second reload go while the new device's is on its way.
  await h.answer("listRuns", ok(runList([run(9, "running")])));
  expect(h.readNames()).toEqual(["listRuns"]);
  h.receive(subscribed());
  expect(h.readNames()).toEqual(["listRuns"]);
  // That reload is stale now and stops after its runs.
  await h.answer("listRuns", ok(runList([run(9, "running")])));
  expect(h.readNames()).toEqual(["listRuns"]);
  await h.answerReload();
  expect(runStates(h.state)).toEqual(["01 running"]);
  // A change that keeps the device changes nothing.
  const revision = h.state.revision;
  h.setAccount(accountStatus({ revision: 7 }, OTHER_DEVICE_ID));
  expect(h.state.revision).toBe(revision);
  expect(h.reads).toEqual([]);
});

test("a listener that throws is logged, and the others still get the state", async () => {
  const h = subscribedHarness();
  const seen: number[] = [];
  h.service.onChange(() => {
    throw new Error("listener");
  });
  const remove = h.service.onChange((state) => seen.push(state.revision));
  h.setWorkspace(WS_A, PROJECT_1);
  expect(seen.length).toBeGreaterThan(0);
  expect(h.logs).toContain("An agent activity state listener failed.");
  remove();
  const count = seen.length;
  await h.answerReload();
  expect(seen).toHaveLength(count);
});

test("a listener that changes the state again never lets a later listener see an older state", async () => {
  const h = await liveHarness();
  let nested = false;
  h.service.onChange((state) => {
    if (!nested && state.projectId === PROJECT_2) {
      nested = true;
      h.setWorkspace(WS_A, PROJECT_1);
    }
  });
  const seen: number[] = [];
  h.service.onChange((state) => seen.push(state.revision));
  h.setWorkspace(WS_A, PROJECT_2);
  expect(nested).toBe(true);
  expect(seen).toEqual([h.state.revision]);
  expect(h.state.projectId).toBe(PROJECT_1);
});

test("close stops listening and cancels the timers", async () => {
  const h = await liveHarness();
  h.receive(memberRemoved());
  h.service.close();
  expect(h.openTimers()).toEqual([]);
  expect(h.accountListeners.size).toBe(0);
  expect(h.connectionListeners.size).toBe(0);
  expect(h.messageListeners.size).toBe(0);
  expect(h.workspaceListeners.size).toBe(0);
  h.service.close();
});

const moduleFolder = path.dirname(fileURLToPath(import.meta.url));

test("no log holds a name or an ID, the state holds no person, and the service never sends", async () => {
  const h = subscribedHarness();
  h.setWorkspace(WS_A, PROJECT_1);
  for (let n = 0; n <= MAX_BUFFERED_EVENTS; n += 1) {
    h.receive(runEvent(7, null, "queued", { agentId: OTHER_AGENT }));
  }
  h.fire(2_000);
  // The stale read stops after its runs; the retry's read follows.
  await h.answer("listRuns", ok(runList([run(1, "running")])));
  await h.answer("listRuns", failure("rate_limited"));
  h.fire(60_000);
  await h.answerReload(ok(runList([run(5, "running", AGENT_2, PROJECT_2)])));
  h.service.onChange(() => {
    throw new Error("Agent Alpha");
  });
  h.fire(8_000);
  await h.answerReload(
    ok(runList([], [{ ...run(1, "failed"), reason: "Out of memory" }])),
  );
  expect(h.state.status).toBe("ready");
  expect(h.logs).toHaveLength(4);
  const text = h.logs.join("\n");
  for (const value of [
    ...NAMES,
    DEVICE_ID,
    WS_A,
    PROJECT_1,
    PROJECT_2,
    AGENT_1,
    AGENT_2,
    OWNER,
    MEMBER,
    runId(1),
  ]) {
    expect(text).not.toContain(value);
  }
  // The state names people by member ID only.
  const state = JSON.stringify(h.state);
  expect(state).not.toContain("octocat");
  expect(state).not.toContain("The Octocat");
  const source = readFileSync(path.join(moduleFolder, "service.ts"), "utf8");
  expect(source).not.toMatch(/\bconsole\./);
  expect(source).not.toMatch(/\.(sendAs|send|subscribeWorkspace)\(/);
});
