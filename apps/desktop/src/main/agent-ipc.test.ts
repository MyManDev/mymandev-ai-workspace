import {
  AgentListItemSchema,
  AgentRunListItemSchema,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  RECENT_FINISHED_RUNS,
  RUN_STATES,
  type AgentListItem,
  type AgentRunListItem,
  type MemberId,
  type ProjectId,
  type RunState,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  AGENT_ACTIVITY_PROBLEMS,
  AGENT_ACTIVITY_STATUSES,
  AGENT_LIMITS,
  AGENT_RUN_STATES,
  type AgentActivityView,
} from "../shared/ipc-contract.ts";
import {
  AGENT_PUBLISH_INTERVAL_MS,
  agentActivityView,
  registerAgentIpc,
} from "./agent-ipc.ts";
import type {
  AgentActivityState,
  AgentActivityStatus,
} from "./agents/service.ts";
import { WORKSPACE_READ_FAILURES } from "./api-reads.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import {
  UNKNOWN_MEMBER_NAME,
  type WorkspaceState,
} from "./workspace/service.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const PROJECT = id(0xe1) as ProjectId;
const OWNER = id(0xc1);
const OTHER_OWNER = id(0xc2);
const FORMER_OWNER = id(0xc3);
const DEVICE = id(0xd1);
const AGENT_1 = id(0xf1);
const AGENT_2 = id(0xf2);
const AT = "2026-11-05T10:00:00.000Z";
const LATER = "2026-11-05T11:00:00.000Z";

function agent(
  agentId: string,
  name: string,
  ownerMemberId: string,
  disabledAt: string | null = null,
): AgentListItem {
  return Object.freeze(
    AgentListItemSchema.parse({
      id: agentId,
      projectId: PROJECT,
      name,
      ownerMemberId,
      disabledAt,
    }),
  );
}

function run(
  n: number,
  state: RunState = "running",
  reason: string | null = null,
): AgentRunListItem {
  const finished = ["completed", "failed", "cancelled"].includes(state);
  return Object.freeze(
    AgentRunListItemSchema.parse({
      id: id(0x1000 + n),
      agentId: AGENT_1,
      projectId: PROJECT,
      repositoryId: id(0x2000),
      state,
      reason,
      createdAt: AT,
      finishedAt: finished ? LATER : null,
    }),
  );
}

function runs(
  count: number,
  state: RunState = "running",
): readonly AgentRunListItem[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => run(index, state)),
  );
}

function activity(
  overrides: Partial<AgentActivityState> = {},
): AgentActivityState {
  return Object.freeze({
    revision: 1,
    status: "ready",
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    agents: Object.freeze([
      agent(AGENT_1, "Agent Alpha", OWNER),
      agent(AGENT_2, "Agent Beta", FORMER_OWNER, AT),
    ]),
    unfinishedRuns: Object.freeze([run(1, "awaiting_input", "Needs a key")]),
    finishedRuns: Object.freeze([run(2, "failed", "Out of memory")]),
    ...overrides,
  } as AgentActivityState);
}

const NO_PROJECT: AgentActivityState = Object.freeze({
  revision: 0,
  status: "no_project",
  workspaceId: null,
  projectId: null,
  agents: Object.freeze([]),
  unfinishedRuns: Object.freeze([]),
  finishedRuns: Object.freeze([]),
});

interface Timer {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

/** The agent and workspace services, with listeners the test calls. */
function fakeServices(initial: AgentActivityState = activity()) {
  let state = initial;
  const names = new Map<string, string>([
    [OWNER, "Ada Lovelace"],
    [OTHER_OWNER, "Grace Hopper"],
    [FORMER_OWNER, "Alan Turing"],
  ]);
  const agentListeners = new Set<(state: AgentActivityState) => void>();
  const workspaceListeners = new Set<(state: WorkspaceState) => void>();
  let workspaceRevision = 0;
  const timers: Timer[] = [];
  const errors: string[] = [];
  let stateCalls = 0;
  return {
    timers,
    errors,
    stateCalls: () => stateCalls,
    agentListeners,
    workspaceListeners,
    /** The timers that were neither cancelled nor fired. */
    waiting: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
    setState(next: AgentActivityState) {
      state = next;
      for (const listener of [...agentListeners]) {
        listener(next);
      }
    },
    rename(memberId: string, name: string | null) {
      if (name === null) {
        names.delete(memberId);
      } else {
        names.set(memberId, name);
      }
      // The IPC reads only `memberName`, not the workspace state.
      workspaceRevision += 1;
      const workspaceState = {
        revision: workspaceRevision,
      } as WorkspaceState;
      for (const listener of [...workspaceListeners]) {
        listener(workspaceState);
      }
    },
    /** Fires every waiting timer once. */
    fire() {
      for (const timer of [...timers]) {
        if (!timer.cancelled && !timer.fired) {
          timer.fired = true;
          timer.callback();
        }
      }
    },
    options: {
      agents: {
        state: () => {
          stateCalls += 1;
          return state;
        },
        onChange: (listener: (state: AgentActivityState) => void) => {
          agentListeners.add(listener);
          return () => {
            agentListeners.delete(listener);
          };
        },
      },
      workspaces: {
        memberName: (memberId: MemberId) =>
          names.get(memberId) ?? UNKNOWN_MEMBER_NAME,
        onChange: (listener: (state: WorkspaceState) => void) => {
          workspaceListeners.add(listener);
          return () => {
            workspaceListeners.delete(listener);
          };
        },
      },
      scheduleTimer: (callback: () => void, delayMs: number) => {
        const timer: Timer = {
          callback,
          delayMs,
          cancelled: false,
          fired: false,
        };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      onError: (message: string) => {
        errors.push(message);
      },
    },
  };
}

function frame(url: string, parent: IpcFrame | null = null): IpcFrame {
  return { url, parent, detached: false, isDestroyed: () => false };
}

function receiver(url: string = DEV_URL) {
  const sent: unknown[][] = [];
  const value: StatusReceiver & { sent: unknown[][] } = {
    mainFrame: frame(url),
    sent,
    isDestroyed: () => false,
    send: (channel, ...args) => {
      sent.push([channel, ...args]);
    },
    once: () => undefined,
  };
  return value;
}

function event(
  senderFrame: IpcFrame | null,
  sender: StatusReceiver = receiver(),
): IpcInvokeEvent {
  return { senderFrame, sender };
}

function register(
  fake: ReturnType<typeof fakeServices>,
  appUrl: string = DEV_URL,
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const agentIpc = registerAgentIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    fake.options,
  );
  const call = (channel: string, sender: StatusReceiver = receiver()) => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}.`);
    }
    return handler(event(frame(appUrl), sender)) as AgentActivityView;
  };
  /** Subscribes a frame and returns the payloads that it receives. */
  const subscribe = () => {
    const subscriber = receiver(appUrl);
    const first = call(INVOKE_CHANNELS.subscribeAgentState, subscriber);
    return {
      first,
      payloads: () =>
        subscriber.sent.map(([channel, payload]) => {
          expect(channel).toBe(EVENT_CHANNELS.agentStateChanged);
          return payload as AgentActivityView;
        }),
    };
  };
  return { handlers, agentIpc, call, subscribe };
}

test("the agent channels are registered, read-only, and nothing else", () => {
  const { handlers } = register(fakeServices());
  expect([...handlers.keys()].sort()).toEqual(
    [INVOKE_CHANNELS.getAgentState, INVOKE_CHANNELS.subscribeAgentState].sort(),
  );
});

test("every handler refuses a foreign sender and any argument, before the service is asked", () => {
  const fake = fakeServices();
  const { handlers } = register(fake, APP_ENTRY_URL);
  for (const [channel, handler] of handlers) {
    for (const sender of [
      null,
      frame("https://example.invalid/"),
      frame(APP_ENTRY_URL, frame(APP_ENTRY_URL)),
      frame(DEV_URL),
    ]) {
      expect(() => handler(event(sender)), channel).toThrow(
        `The call on ${channel} was refused: the sender is not the application.`,
      );
    }
    expect(
      () => handler(event(frame(APP_ENTRY_URL)), AGENT_1),
      channel,
    ).toThrow(
      `The call on ${channel} was refused: the arguments do not match the contract.`,
    );
  }
  expect(fake.stateCalls()).toBe(0);
});

test("the view holds the owners' names, an unknown person's included, and the model's agents, states, and reasons", () => {
  const fake = fakeServices(
    activity({
      agents: Object.freeze([
        agent(AGENT_1, "Agent Alpha", OWNER),
        agent(AGENT_2, "Agent Beta", id(0xc9), AT),
      ]),
    }),
  );
  const { call } = register(fake);

  expect(call(INVOKE_CHANNELS.getAgentState)).toEqual({
    status: "ready",
    revision: 0,
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    agents: [
      {
        id: AGENT_1,
        name: "Agent Alpha",
        ownerName: "Ada Lovelace",
        disabledAt: null,
      },
      {
        id: AGENT_2,
        name: "Agent Beta",
        ownerName: UNKNOWN_MEMBER_NAME,
        disabledAt: AT,
      },
    ],
    unfinishedRuns: [
      {
        id: id(0x1001),
        agentId: AGENT_1,
        state: "awaiting_input",
        reason: "Needs a key",
        createdAt: AT,
        finishedAt: null,
      },
    ],
    moreUnfinishedRuns: 0,
    finishedRuns: [
      {
        id: id(0x1002),
        agentId: AGENT_1,
        state: "failed",
        reason: "Out of memory",
        createdAt: AT,
        finishedAt: LATER,
      },
    ],
  });
});

test("no member ID, device ID, repository ID, or other key of the model crosses", () => {
  const leaky = {
    ...agent(AGENT_1, "Agent Alpha", OWNER),
    hostDeviceId: DEVICE,
    deviceId: DEVICE,
  } as AgentListItem;
  const leakyRun = {
    ...run(1),
    hostDeviceId: DEVICE,
    ownerMemberId: OTHER_OWNER,
  } as AgentRunListItem;
  const fake = fakeServices(
    activity({
      agents: Object.freeze([leaky]),
      unfinishedRuns: Object.freeze([leakyRun]),
      finishedRuns: Object.freeze([run(2, "completed")]),
    }),
  );
  const { call, subscribe } = register(fake);
  const { payloads } = subscribe();
  fake.rename(OWNER, "Ada King");
  fake.fire();

  const views = [
    agentActivityView(fake.options.agents.state(), 0, (memberId) =>
      fake.options.workspaces.memberName(memberId),
    ),
    call(INVOKE_CHANNELS.getAgentState),
    ...payloads(),
  ];
  expect(views).toHaveLength(3);
  for (const view of views) {
    const text = JSON.stringify(view);
    for (const hidden of [OWNER, OTHER_OWNER, DEVICE, id(0x2000)]) {
      expect(text).not.toContain(hidden);
    }
    expect(Object.keys(view.agents[0] ?? {}).sort()).toEqual([
      "disabledAt",
      "id",
      "name",
      "ownerName",
    ]);
    for (const item of [...view.unfinishedRuns, ...view.finishedRuns]) {
      expect(Object.keys(item).sort()).toEqual([
        "agentId",
        "createdAt",
        "finishedAt",
        "id",
        "reason",
        "state",
      ]);
    }
  }
});

test("the view keeps the 200 newest unfinished runs with a count of the rest, and the 50 most recently finished, in the model's order", () => {
  const unfinished = runs(250);
  const finished = Object.freeze(
    Array.from({ length: 60 }, (_, index) => run(500 + index, "completed")),
  );
  const fake = fakeServices(
    activity({ unfinishedRuns: unfinished, finishedRuns: finished }),
  );
  const { call } = register(fake);
  const view = call(INVOKE_CHANNELS.getAgentState);

  expect(view.unfinishedRuns.map((item) => item.id)).toEqual(
    unfinished.slice(0, AGENT_LIMITS.unfinishedRuns).map((item) => item.id),
  );
  expect(view.moreUnfinishedRuns).toBe(50);
  expect(view.finishedRuns.map((item) => item.id)).toEqual(
    finished.slice(0, AGENT_LIMITS.finishedRuns).map((item) => item.id),
  );

  // At the limit, nothing is left out.
  fake.setState(
    activity({
      unfinishedRuns: runs(200),
      finishedRuns: finished.slice(0, 50),
    }),
  );
  const atLimit = call(INVOKE_CHANNELS.getAgentState);
  expect(atLimit.unfinishedRuns).toHaveLength(200);
  expect(atLimit.moreUnfinishedRuns).toBe(0);
  expect(atLimit.finishedRuns).toHaveLength(50);
});

test("names and reasons are cut to their limits in characters, and the agents to the most an answer holds", () => {
  const face = "\u{1F600}";
  const longAgent = {
    ...agent(AGENT_1, "Agent Alpha", OWNER),
    name: face.repeat(AGENT_LIMITS.agentName + 6),
  } as AgentListItem;
  const longRun = {
    ...run(1, "failed", "x"),
    reason: "y".repeat(AGENT_LIMITS.runReason + 1),
  } as AgentRunListItem;
  const manyAgents = Array.from({ length: AGENT_LIMITS.agents + 5 }, (_, n) =>
    agent(id(0x5000 + n), `Agent ${n}`, OWNER),
  );
  const fake = fakeServices(
    activity({
      agents: Object.freeze([longAgent, ...manyAgents]),
      unfinishedRuns: Object.freeze([]),
      finishedRuns: Object.freeze([longRun]),
    }),
  );
  fake.rename(OWNER, "z".repeat(AGENT_LIMITS.ownerName * 2));
  const { call } = register(fake);
  const view = call(INVOKE_CHANNELS.getAgentState);

  expect(view.agents).toHaveLength(AGENT_LIMITS.agents);
  expect(view.agents[0]?.name).toBe(face.repeat(AGENT_LIMITS.agentName));
  expect(view.agents[0]?.ownerName).toBe("z".repeat(AGENT_LIMITS.ownerName));
  expect(view.finishedRuns[0]?.reason).toBe("y".repeat(AGENT_LIMITS.runReason));
});

test("the view is a frozen copy that shares no object with the service's state", () => {
  const state = activity();
  const view = agentActivityView(state, 7, () => "Ada Lovelace");

  expect(view.revision).toBe(7);
  expect(Object.isFrozen(view)).toBe(true);
  for (const list of [view.agents, view.unfinishedRuns, view.finishedRuns]) {
    expect(Object.isFrozen(list)).toBe(true);
    for (const item of list) {
      expect(Object.isFrozen(item)).toBe(true);
    }
  }
  expect(view.agents[0]).not.toBe(state.agents[0]);
  expect(view.unfinishedRuns).not.toBe(state.unfinishedRuns);
  expect(view.unfinishedRuns[0]).not.toBe(state.unfinishedRuns[0]);
  expect(view.finishedRuns[0]).not.toBe(state.finishedRuns[0]);
});

test("a burst of changes publishes once, after the interval, with the last state", () => {
  const fake = fakeServices(NO_PROJECT);
  const { subscribe, call } = register(fake);
  const { first, payloads } = subscribe();
  expect(first.status).toBe("no_project");
  expect(first.revision).toBe(0);

  fake.setState(activity({ status: "loading", agents: [] }));
  expect(fake.timers).toHaveLength(1);
  const [timer] = fake.timers;
  expect(timer?.delayMs).toBe(AGENT_PUBLISH_INTERVAL_MS);
  // The later changes of the burst neither cancel the timer nor add one:
  // the first change sets when the view goes out.
  fake.setState(activity({ unfinishedRuns: runs(3) }));
  fake.rename(OWNER, "Ada King");
  fake.setState(activity({ unfinishedRuns: runs(5) }));
  expect(payloads()).toEqual([]);
  expect(fake.timers).toEqual([timer]);
  expect(timer?.cancelled).toBe(false);
  // A call meanwhile already answers with the latest view.
  expect(call(INVOKE_CHANNELS.getAgentState).revision).toBe(4);

  fake.fire();
  expect(timer?.cancelled).toBe(false);
  expect(payloads()).toHaveLength(1);
  const [sent] = payloads();
  expect(sent?.revision).toBe(4);
  expect(sent?.unfinishedRuns).toHaveLength(5);
  expect(sent?.agents[0]?.ownerName).toBe("Ada King");

  // The next change waits for its own interval.
  fake.setState(activity({ unfinishedRuns: runs(1) }));
  expect(fake.waiting()).toHaveLength(1);
  fake.fire();
  expect(payloads().map((view) => view.revision)).toEqual([4, 5]);
  expect(payloads()[1]?.unfinishedRuns).toHaveLength(1);
  expect(fake.errors).toEqual([]);
});

test("a new name of an owner publishes the view again", () => {
  const fake = fakeServices();
  const { subscribe } = register(fake);
  const { first, payloads } = subscribe();
  expect(first.agents.map((item) => item.ownerName)).toEqual([
    "Ada Lovelace",
    "Alan Turing",
  ]);

  fake.rename(FORMER_OWNER, null);
  fake.fire();
  expect(payloads()).toHaveLength(1);
  expect(payloads()[0]?.revision).toBe(1);
  expect(payloads()[0]?.agents.map((item) => item.ownerName)).toEqual([
    "Ada Lovelace",
    UNKNOWN_MEMBER_NAME,
  ]);
});

test("close cancels the waiting publish and stops listening", () => {
  const fake = fakeServices();
  const { subscribe, agentIpc } = register(fake);
  const { payloads } = subscribe();
  fake.setState(activity({ unfinishedRuns: runs(2) }));
  const [timer] = fake.waiting();

  agentIpc.close();
  expect(timer?.cancelled).toBe(true);
  expect(fake.agentListeners.size).toBe(0);
  expect(fake.workspaceListeners.size).toBe(0);
  timer?.callback();
  fake.fire();
  expect(payloads()).toEqual([]);
  agentIpc.close();
});

test("a view that the contract refuses is reported, not sent", () => {
  const fake = fakeServices();
  const { subscribe } = register(fake);
  const { payloads } = subscribe();
  fake.setState(
    activity({
      agents: Object.freeze([
        { ...agent(AGENT_1, "Agent Alpha", OWNER), id: "not-an-id" },
      ]) as unknown as readonly AgentListItem[],
    }),
  );
  fake.fire();

  expect(payloads()).toEqual([]);
  expect(fake.errors).toEqual(["Sending the agent activity failed."]);

  // The next change is scheduled and sent again.
  fake.setState(activity());
  expect(fake.waiting()).toHaveLength(1);
  fake.fire();
  expect(payloads().map((view) => view.revision)).toEqual([2]);
  expect(fake.errors).toHaveLength(1);
});

test("getState answers without subscribing the caller", () => {
  const fake = fakeServices();
  const { call } = register(fake);
  const caller = receiver();

  expect(call(INVOKE_CHANNELS.getAgentState, caller).revision).toBe(0);
  fake.setState(activity({ unfinishedRuns: runs(2) }));
  fake.fire();

  expect(caller.sent).toEqual([]);
});

test("an unavailable activity crosses with its problem", () => {
  const fake = fakeServices(
    activity({ status: "unavailable", problem: "rate_limited" }),
  );
  const { call } = register(fake);
  const view = call(INVOKE_CHANNELS.getAgentState);
  expect(view.status).toBe("unavailable");
  expect(view.status === "unavailable" && view.problem).toBe("rate_limited");
});

test("the contract's statuses, problems, run states, and limits match the service and the protocol", () => {
  // The record fails to compile when the service's statuses change.
  const statuses: Readonly<Record<AgentActivityStatus, true>> = {
    no_project: true,
    loading: true,
    ready: true,
    unavailable: true,
  };
  expect(Object.keys(statuses).sort()).toEqual(
    [...AGENT_ACTIVITY_STATUSES].sort(),
  );
  for (const status of AGENT_ACTIVITY_STATUSES) {
    const problem = status === "unavailable" ? { problem: "failed" } : {};
    const view = agentActivityView(
      activity({ status, ...problem } as Partial<AgentActivityState>),
      0,
      () => "Ada Lovelace",
    );
    expect(view.status).toBe(status);
  }
  expect([...AGENT_ACTIVITY_PROBLEMS]).toEqual([...WORKSPACE_READ_FAILURES]);
  expect([...AGENT_RUN_STATES]).toEqual([...RUN_STATES]);
  expect(AGENT_LIMITS.agents).toBe(MAX_ANSWER_LIST_ITEMS);
  expect(AGENT_LIMITS.finishedRuns).toBe(RECENT_FINISHED_RUNS);
  expect(AGENT_LIMITS.unfinishedRuns).toBeLessThan(MAX_ANSWER_LIST_ITEMS);
  expect(AGENT_LIMITS.agentName).toBe(LIMITS.agentName);
  expect(AGENT_LIMITS.ownerName).toBe(LIMITS.displayName);
  expect(AGENT_LIMITS.ownerName).toBeGreaterThanOrEqual(
    UNKNOWN_MEMBER_NAME.length,
  );
  expect(AGENT_LIMITS.runReason).toBe(LIMITS.runReason);
});
