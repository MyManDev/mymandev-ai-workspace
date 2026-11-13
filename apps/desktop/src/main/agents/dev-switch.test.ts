import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentListResponseSchema,
  AgentRunListResponseSchema,
  decodeClientMessage,
  decodeServerMessage,
  type AgentId,
  type AgentRunStateChangedEvent,
  type DeviceId,
  type EventId,
  type MemberId,
  type ProjectId,
  type ReceivedServerEvent,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  CONNECTION_STOP_REASONS,
  CONNECTION_WAITING_REASONS,
  type AccountStatus,
  type ConnectionStatus,
  type ConnectionWaitingReason,
} from "../../shared/ipc-contract.ts";
import type {
  BuildClientEvent,
  SendOutcome,
  ServerMessage,
} from "../connection/client.ts";
import type { WorkspaceState } from "../workspace/service.ts";
import {
  createDevAgentSwitch,
  DEV_SWITCH_ACK_TIMEOUT_MS,
  DEV_SWITCH_HOURLY_SENDS,
  DEV_SWITCH_STEP_MS,
  devAgentSwitchSettings,
  type DevAgentSwitch,
  type DevAgentSwitchSettings,
  type DevSwitchAccount,
  type DevSwitchAgents,
  type DevSwitchConnection,
  type DevSwitchWorkspaces,
} from "./dev-switch.ts";
import type { AgentActivityState } from "./service.ts";

const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004" as DeviceId;
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000014" as DeviceId;
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009" as UserId;
const WS_A = "0192f0a0-7b3c-7d4e-8f50-0000000000a1" as WorkspaceId;
const WS_B = "0192f0a0-7b3c-7d4e-8f50-0000000000a2" as WorkspaceId;
const OWNER = "0192f0a0-7b3c-7d4e-8f50-0000000000c1" as MemberId;
const MEMBER = "0192f0a0-7b3c-7d4e-8f50-0000000000c2" as MemberId;
const PROJECT_1 = "0192f0a0-7b3c-7d4e-8f50-0000000000e1" as ProjectId;
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000f1" as AgentId;
const OTHER_AGENT = "0192f0a0-7b3c-7d4e-8f50-0000000000f2" as AgentId;
const AT = "2026-11-05T10:00:00.000Z";
/** The wall clock at the harness's time 0. */
const WALL_START = Date.parse("2026-11-05T12:00:00.000Z");

const SETTINGS: DevAgentSwitchSettings = Object.freeze({
  agentId: AGENT_ID,
  hostDeviceId: DEVICE_ID,
});

function accountStatus(deviceId: string = DEVICE_ID): AccountStatus {
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
  }) as AccountStatus;
}

const SIGNED_OUT = Object.freeze({
  ...accountStatus(),
  account: Object.freeze({ kind: "signed_out" }),
  device: "signed_out",
}) as AccountStatus;

function runId(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-0000000b${n.toString(16).padStart(4, "0")}`;
}

function eventId(n: number): EventId {
  return `0192f0a0-7b3c-7d4e-8f50-0000000e${n.toString(16).padStart(4, "0")}` as EventId;
}

interface ActivityOptions {
  /** The unfinished runs of the agent, the oldest first. */
  readonly runs?: readonly (readonly [number, RunState])[];
  readonly owner?: MemberId;
  readonly disabled?: boolean;
}

/**
 * The agent activity of the open project: the agent and another agent of
 * the project, and the agent's unfinished runs, the most recently created
 * first as the server sends them.
 */
function activity(options: ActivityOptions = {}): AgentActivityState {
  const runs = options.runs ?? [
    [1, "queued"],
    [2, "queued"],
  ];
  const agents = AgentListResponseSchema.parse({
    agents: [
      {
        id: AGENT_ID,
        projectId: PROJECT_1,
        name: "Test agent",
        ownerMemberId: options.owner ?? OWNER,
        disabledAt: options.disabled === true ? AT : null,
      },
      {
        id: OTHER_AGENT,
        projectId: PROJECT_1,
        name: "Other agent",
        ownerMemberId: OWNER,
        disabledAt: null,
      },
    ],
  }).agents;
  const unfinished = [
    ...runs.map(([n, state]) => ({ n, state, agentId: AGENT_ID })),
    // A run of the other agent, which the switch never moves.
    { n: 0xff00, state: "queued" as RunState, agentId: OTHER_AGENT },
  ]
    .reverse()
    .map(({ n, state, agentId }) => ({
      id: runId(n),
      agentId,
      projectId: PROJECT_1,
      repositoryId: null,
      state,
      reason: null,
      createdAt: AT,
      finishedAt: null,
    }));
  const list = AgentRunListResponseSchema.parse({
    unfinishedRuns: unfinished,
    finishedRuns: [],
  });
  return Object.freeze({
    revision: 1,
    status: "ready",
    workspaceId: WS_A,
    projectId: PROJECT_1,
    agents,
    unfinishedRuns: list.unfinishedRuns,
    finishedRuns: list.finishedRuns,
  });
}

const NO_PROJECT: AgentActivityState = Object.freeze({
  revision: 1,
  status: "no_project",
  workspaceId: null,
  projectId: null,
  agents: [],
  unfinishedRuns: [],
  finishedRuns: [],
});

interface Timer {
  readonly at: number;
  readonly callback: () => void;
  cancelled: boolean;
}

/** Every log line of every harness, for the check that no log holds an ID. */
const allLogs: string[] = [];

interface HarnessOptions {
  readonly account?: AccountStatus;
  readonly activity?: AgentActivityState;
  readonly agentsLive?: boolean;
  readonly workspaceLive?: boolean;
  readonly ownMember?: MemberId | null;
  /** The connection's status when the switch starts; `connected` by default. */
  readonly connection?: ConnectionStatus;
  /** Replaces the harness's log, which keeps the lines. */
  readonly log?: (message: string) => void;
}

/** The client backs off: the connection failed, or it closed or was lost. */
function waiting(reason: ConnectionWaitingReason): ConnectionStatus {
  return {
    state: "waiting",
    reason,
    retryAt: "2026-11-05T12:00:30.000Z",
    revision: 2,
  };
}

const CONNECTING: ConnectionStatus = { state: "connecting", revision: 2 };
const CONNECTED: ConnectionStatus = { state: "connected", revision: 3 };
/** The client closed the socket because the device signed out. */
const SIGNED_OUT_CONNECTION: ConnectionStatus = {
  state: "offline",
  reason: "not_signed_in",
  revision: 4,
};

class Harness {
  /** The monotonic time in milliseconds. */
  time = 0;
  accountStatus: AccountStatus;
  /** The identity of the connection's socket. */
  identity: { userId: UserId; deviceId: DeviceId } | null = {
    userId: USER_ID,
    deviceId: DEVICE_ID,
  };
  /** What `sendAs` answers instead of sending, when set. */
  failSend: SendOutcome | null = null;
  agentState: AgentActivityState;
  agentsLive: boolean;
  workspaceLive: boolean;
  ownMember: MemberId | null;
  connectionStatus: ConnectionStatus;
  readonly sent: AgentRunStateChangedEvent[] = [];
  readonly sentAt: number[] = [];
  readonly timers: Timer[] = [];
  readonly logs: string[] = [];
  readonly accountListeners = new Set<(status: AccountStatus) => void>();
  readonly messageListeners = new Set<(message: ServerMessage) => void>();
  readonly connectionListeners = new Set<(status: ConnectionStatus) => void>();
  readonly workspaceListeners = new Set<(state: WorkspaceState) => void>();
  readonly agentListeners = new Set<(state: AgentActivityState) => void>();
  readonly devSwitch: DevAgentSwitch;
  #nextEvent = 0;

  constructor(options: HarnessOptions = {}) {
    this.accountStatus = options.account ?? accountStatus();
    this.agentState = options.activity ?? activity();
    this.agentsLive = options.agentsLive ?? true;
    this.workspaceLive = options.workspaceLive ?? true;
    this.ownMember =
      options.ownMember === undefined ? OWNER : options.ownMember;
    this.connectionStatus = options.connection ?? CONNECTED;
    const account: DevSwitchAccount = {
      status: () => this.accountStatus,
      onStatusChange: (listener) => {
        this.accountListeners.add(listener);
        return () => this.accountListeners.delete(listener);
      },
    };
    const connection: DevSwitchConnection = {
      sendAs: (build: BuildClientEvent) => this.sendAs(build),
      onMessage: (listener) => {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
      },
      status: () => this.connectionStatus,
      onStatusChange: (listener) => {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
      },
    };
    const workspaces: DevSwitchWorkspaces = {
      onChange: (listener) => {
        this.workspaceListeners.add(listener);
        return () => {
          this.workspaceListeners.delete(listener);
        };
      },
      gateLive: (workspaceId) => this.workspaceLive && workspaceId === WS_A,
      ownMemberId: (workspaceId) =>
        workspaceId === WS_A ? this.ownMember : null,
    };
    const agents: DevSwitchAgents = {
      state: () => this.agentState,
      onChange: (listener) => {
        this.agentListeners.add(listener);
        return () => {
          this.agentListeners.delete(listener);
        };
      },
      gateLive: () => this.agentsLive,
    };
    this.devSwitch = createDevAgentSwitch({
      settings: SETTINGS,
      account,
      connection,
      workspaces,
      agents,
      scheduleTimer: (callback, delayMs) => {
        const timer: Timer = {
          at: this.time + delayMs,
          callback,
          cancelled: false,
        };
        this.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      now: () => this.time,
      wallClock: () => WALL_START + this.time,
      newEventId: () => {
        this.#nextEvent += 1;
        return eventId(this.#nextEvent);
      },
      log:
        options.log ??
        ((message) => {
          this.logs.push(message);
          allLogs.push(message);
        }),
    });
  }

  /** Like the connection client: builds from the identity, checks, sends. */
  sendAs(build: BuildClientEvent): SendOutcome {
    if (this.identity === null) {
      return "not_connected";
    }
    let event;
    try {
      event = build(this.identity);
    } catch {
      return "invalid";
    }
    const checked = decodeClientMessage(
      JSON.parse(JSON.stringify(event)) as unknown,
    );
    if (
      !checked.ok ||
      checked.kind !== "event" ||
      checked.event.type !== "agent.run.state_changed" ||
      checked.event.deviceId !== this.identity.deviceId
    ) {
      return "invalid";
    }
    if (this.failSend !== null) {
      return this.failSend;
    }
    this.sent.push(checked.event);
    this.sentAt.push(this.time);
    return "sent";
  }

  get last(): AgentRunStateChangedEvent {
    const event = this.sent.at(-1);
    if (event === undefined) {
      throw new Error("Nothing was sent");
    }
    return event;
  }

  /** The sent transitions as `run previous>next`. */
  walk(): string[] {
    return this.sent.map(
      (event) =>
        `${event.payload.runId.slice(-2)} ${String(event.payload.previousState)}>${event.payload.state}`,
    );
  }

  receive(message: ServerMessage): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  /**
   * The server relays `event` (by default the last one sent) with
   * `deviceId: null`, which is its acknowledgement; `payload` replaces
   * fields of its payload.
   */
  ack(
    event: AgentRunStateChangedEvent = this.last,
    payload: Record<string, unknown> = {},
  ): void {
    const decoded = decodeServerMessage({
      ...event,
      deviceId: null,
      payload: { ...event.payload, ...payload },
    });
    if (!decoded.ok || decoded.kind !== "event") {
      throw new Error("The relayed transition does not decode");
    }
    this.receive({ kind: "event", event: decoded.event });
  }

  refuse(code: string, id: string = this.last.id): void {
    const decoded = decodeServerMessage({
      protocolVersion: 0,
      type: "event.refused",
      eventId: id,
      code,
    });
    if (!decoded.ok || decoded.kind !== "frame") {
      throw new Error("The refusal does not decode");
    }
    this.receive({ kind: "frame", frame: decoded.frame });
  }

  setActivity(state: AgentActivityState): void {
    this.agentState = state;
    for (const listener of [...this.agentListeners]) {
      listener(state);
    }
  }

  /** The workspace service tells its listeners, for example of `gateLive`. */
  workspaceChanged(): void {
    for (const listener of [...this.workspaceListeners]) {
      listener({} as WorkspaceState);
    }
  }

  setConnection(status: ConnectionStatus): void {
    this.connectionStatus = status;
    for (const listener of [...this.connectionListeners]) {
      listener(status);
    }
  }

  setAccount(status: AccountStatus): void {
    this.accountStatus = status;
    for (const listener of [...this.accountListeners]) {
      listener(status);
    }
  }

  openTimers(): Timer[] {
    return this.timers.filter((timer) => !timer.cancelled);
  }

  /** Moves the clock forward by `ms`, firing the timers that come due. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = this.openTimers()
        .filter((timer) => timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) {
        break;
      }
      due.cancelled = true;
      this.time = due.at;
      due.callback();
    }
    this.time = end;
  }

  /** Acknowledges every send at once and moves on until nothing is sent. */
  runToEnd(limit = 100): void {
    for (let step = 0; step < limit; step += 1) {
      const count = this.sent.length;
      this.ack();
      this.advance(DEV_SWITCH_STEP_MS);
      if (this.sent.length === count) {
        return;
      }
    }
  }
}

// The settings.

test("the settings: off in a packaged build, without the variable, and with an invalid one", () => {
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  const env = {
    MYMANDEV_DEV_AGENT_SWITCH: AGENT_ID,
    MYMANDEV_DEV_AGENT_DEVICE: DEVICE_ID,
  };
  expect(devAgentSwitchSettings(false, env, log)).toEqual({
    agentId: AGENT_ID,
    hostDeviceId: DEVICE_ID,
  });
  expect(logs).toEqual([]);

  // A packaged build never reads the variables.
  expect(devAgentSwitchSettings(true, env, log)).toBeNull();
  expect(
    devAgentSwitchSettings(true, { MYMANDEV_DEV_AGENT_SWITCH: "x" }, log),
  ).toBeNull();
  // Unset or empty: off, without a word.
  expect(devAgentSwitchSettings(false, {}, log)).toBeNull();
  expect(
    devAgentSwitchSettings(false, { MYMANDEV_DEV_AGENT_SWITCH: "" }, log),
  ).toBeNull();
  expect(logs).toEqual([]);

  // Not an agent ID, or no host device: off, with a fixed text.
  for (const value of ["yes", ` ${AGENT_ID}`, AGENT_ID.toUpperCase(), "0"]) {
    expect(
      devAgentSwitchSettings(
        false,
        { ...env, MYMANDEV_DEV_AGENT_SWITCH: value },
        log,
      ),
    ).toBeNull();
  }
  // A UUIDv4 is not an agent ID.
  expect(
    devAgentSwitchSettings(
      false,
      {
        ...env,
        MYMANDEV_DEV_AGENT_SWITCH: "3f1c2b4a-8d6e-4f70-9a1b-2c3d4e5f6a7b",
      },
      log,
    ),
  ).toBeNull();
  for (const device of [undefined, "", "this one"]) {
    expect(
      devAgentSwitchSettings(
        false,
        {
          MYMANDEV_DEV_AGENT_SWITCH: AGENT_ID,
          MYMANDEV_DEV_AGENT_DEVICE: device,
        },
        log,
      ),
    ).toBeNull();
  }
  expect(logs).toEqual([
    ...Array<string>(5).fill(
      "The development agent switch is off: MYMANDEV_DEV_AGENT_SWITCH does not hold an agent ID.",
    ),
    ...Array<string>(3).fill(
      "The development agent switch is off: MYMANDEV_DEV_AGENT_DEVICE does not hold a device ID.",
    ),
  ]);
});

// The guards.

test("it sends nothing on a device that does not host the agent", () => {
  const h = new Harness({ account: accountStatus(OTHER_DEVICE_ID) });
  h.advance(60_000);
  expect(h.sent).toEqual([]);
  expect(h.logs).toEqual([
    "The development agent switch waits: this device does not host the agent.",
  ]);
  // Signed out, it waits as well.
  h.setAccount(SIGNED_OUT);
  expect(h.sent).toEqual([]);
  // The host device signs in: it sends.
  h.setAccount(accountStatus());
  expect(h.walk()).toEqual(["01 queued>running"]);
  expect(h.last.actor).toEqual({ kind: "agent", agentId: AGENT_ID });
  expect(h.last.deviceId).toBe(DEVICE_ID);

  // The socket's identity is checked too: an identity of another device
  // gets nothing, and the switch stops.
  const g = new Harness();
  expect(g.sent).toHaveLength(1);
  g.ack();
  g.identity = { userId: USER_ID, deviceId: OTHER_DEVICE_ID };
  g.advance(DEV_SWITCH_STEP_MS);
  expect(g.sent).toHaveLength(1);
  expect(g.logs.at(-1)).toBe(
    "The development agent switch stopped: a transition was not sent (invalid).",
  );
  g.identity = { userId: USER_ID, deviceId: DEVICE_ID };
  g.setActivity(activity());
  g.advance(60_000);
  expect(g.sent).toHaveLength(1);
});

test("it sends nothing for an agent that the signed-in person does not own", () => {
  const h = new Harness({ ownMember: MEMBER });
  h.advance(60_000);
  expect(h.sent).toEqual([]);
  expect(h.logs).toEqual([
    "The development agent switch waits: the signed-in person does not own the agent.",
  ]);
  // Without the person's own member, it waits too.
  h.ownMember = null;
  h.workspaceChanged();
  expect(h.sent).toEqual([]);
  // Another owner in the agent list: the same.
  h.ownMember = OWNER;
  h.setActivity(activity({ owner: MEMBER }));
  expect(h.sent).toEqual([]);
  h.setActivity(activity());
  expect(h.walk()).toEqual(["01 queued>running"]);
});

test("it sends nothing for a disabled agent", () => {
  const h = new Harness({ activity: activity({ disabled: true }) });
  h.advance(60_000);
  expect(h.sent).toEqual([]);
  expect(h.logs).toEqual([
    "The development agent switch waits: the agent is disabled.",
  ]);
  // Disabled after a transition: nothing more is sent.
  const g = new Harness();
  g.ack();
  g.setActivity(activity({ disabled: true }));
  g.advance(60_000);
  expect(g.sent).toHaveLength(1);
});

test("it sends nothing while either gate is not live", () => {
  const h = new Harness({ agentsLive: false });
  h.advance(60_000);
  expect(h.sent).toEqual([]);
  h.agentsLive = true;
  h.workspaceLive = false;
  h.setActivity(activity());
  h.advance(60_000);
  expect(h.sent).toEqual([]);
  expect(h.logs).toEqual([
    "The development agent switch waits for the agent's project to open and load.",
  ]);
  h.workspaceLive = true;
  h.workspaceChanged();
  expect(h.walk()).toEqual(["01 queued>running"]);

  // A gate that goes down between two transitions holds the next one.
  h.ack();
  h.agentsLive = false;
  h.advance(60_000);
  expect(h.sent).toHaveLength(1);
  h.agentsLive = true;
  h.setActivity(activity());
  expect(h.walk()).toEqual(["01 queued>running", "01 running>awaiting_input"]);

  // A resend waits for the gates as well.
  h.workspaceLive = false;
  h.advance(DEV_SWITCH_ACK_TIMEOUT_MS);
  expect(h.sent).toHaveLength(2);
  h.workspaceLive = true;
  h.workspaceChanged();
  expect(h.sent).toHaveLength(3);
  expect(h.sent[2]).toEqual(h.sent[1]);
});

// The walk.

test("it walks the oldest run through allowed transitions, one every 2 seconds, then the next run", () => {
  const h = new Harness();
  // The first transition goes out at once.
  expect(h.sentAt).toEqual([0]);
  h.runToEnd();
  expect(h.walk()).toEqual([
    "01 queued>running",
    "01 running>awaiting_input",
    "01 awaiting_input>running",
    "01 running>completed",
    "02 queued>running",
    "02 running>awaiting_input",
    "02 awaiting_input>running",
    "02 running>completed",
  ]);
  expect(h.sentAt).toEqual([
    0, 2_000, 4_000, 6_000, 8_000, 10_000, 12_000, 14_000,
  ]);
  // Every event is the agent's, from this device, in the workspace.
  for (const [index, event] of h.sent.entries()) {
    expect(event).toEqual({
      protocolVersion: 0,
      id: eventId(index + 1),
      type: "agent.run.state_changed",
      occurredAt: new Date(WALL_START + (h.sentAt[index] ?? 0)).toISOString(),
      workspaceId: WS_A,
      actor: { kind: "agent", agentId: AGENT_ID },
      deviceId: DEVICE_ID,
      payload: {
        runId: event.payload.runId,
        agentId: AGENT_ID,
        previousState: event.payload.previousState,
        state: event.payload.state,
      },
    });
  }
  expect(h.logs).toEqual([
    "The development agent switch moves the agent's runs.",
    "The development agent switch has no unfinished run to move.",
  ]);
  expect(h.openTimers()).toEqual([]);

  // Runs that the activity already shows further on continue from there.
  const g = new Harness({
    activity: activity({
      runs: [
        [3, "awaiting_input"],
        [4, "running"],
      ],
    }),
  });
  g.runToEnd();
  expect(g.walk()).toEqual([
    "03 awaiting_input>running",
    "03 running>awaiting_input",
    "03 awaiting_input>running",
    "03 running>completed",
    "04 running>awaiting_input",
    "04 awaiting_input>running",
    "04 running>completed",
  ]);
});

test("the next transition waits 2 seconds after the last send, also after a late acknowledgement", () => {
  const h = new Harness();
  h.ack();
  h.advance(DEV_SWITCH_STEP_MS - 1);
  expect(h.sent).toHaveLength(1);
  h.advance(1);
  expect(h.sentAt).toEqual([0, 2_000]);
  // An acknowledgement after 3 seconds sends the next at once.
  h.advance(3_000);
  expect(h.sent).toHaveLength(2);
  h.ack();
  expect(h.sentAt).toEqual([0, 2_000, 5_000]);
});

test("it waits for each acknowledgement", () => {
  const h = new Harness();
  h.advance(DEV_SWITCH_ACK_TIMEOUT_MS - 1);
  expect(h.sent).toHaveLength(1);
  // A relay of another event, of another agent, or of another run is no
  // acknowledgement.
  const other = { ...h.last, id: eventId(77) };
  h.ack(other);
  h.ack(
    { ...h.last, actor: { kind: "agent", agentId: OTHER_AGENT } },
    {
      agentId: OTHER_AGENT,
    },
  );
  h.ack(h.last, { runId: runId(2) });
  h.ack({ ...h.last, workspaceId: WS_B });
  // Built without the decoder, because no other event type carries an
  // agent actor.
  h.receive({
    kind: "event",
    event: {
      ...h.last,
      deviceId: null,
      type: "workspace.project.renamed",
    } as unknown as ReceivedServerEvent,
  });
  h.refuse("conflict", eventId(77));
  expect(h.sent).toHaveLength(1);
  expect(h.logs).not.toContain(
    "The development agent switch stopped: a transition was refused (conflict).",
  );
  // The activity's changes send nothing either.
  h.setActivity(activity());
  expect(h.sent).toHaveLength(1);
  // Its acknowledgement lets the next transition go.
  h.ack();
  expect(h.walk()).toEqual(["01 queued>running", "01 running>awaiting_input"]);
  expect(h.sentAt).toEqual([0, DEV_SWITCH_ACK_TIMEOUT_MS - 1]);
});

test("without an acknowledgement it sends the same event once more, and then stops", () => {
  const h = new Harness();
  const first = h.last;
  h.advance(DEV_SWITCH_ACK_TIMEOUT_MS);
  expect(h.sent).toHaveLength(2);
  expect(h.sent[1]).toEqual(first);
  expect(h.sentAt).toEqual([0, DEV_SWITCH_ACK_TIMEOUT_MS]);
  h.advance(DEV_SWITCH_ACK_TIMEOUT_MS);
  expect(h.sent).toHaveLength(2);
  expect(h.logs.slice(-2)).toEqual([
    "A transition got no acknowledgement; the development agent switch sends it once more.",
    "The development agent switch stopped: a transition got no acknowledgement.",
  ]);
  // A late acknowledgement and later changes send nothing.
  h.ack(first);
  h.setActivity(activity());
  h.advance(60_000);
  expect(h.sent).toHaveLength(2);
  expect(h.openTimers()).toEqual([]);

  // An acknowledgement of the resend continues the walk.
  const g = new Harness();
  g.advance(DEV_SWITCH_ACK_TIMEOUT_MS);
  g.ack();
  g.advance(DEV_SWITCH_STEP_MS);
  expect(g.walk()).toEqual([
    "01 queued>running",
    "01 queued>running",
    "01 running>awaiting_input",
  ]);
});

test("it stops at the first refusal", () => {
  for (const code of ["conflict", "not_found", "rate_limited"]) {
    const h = new Harness();
    h.ack();
    h.advance(DEV_SWITCH_STEP_MS);
    h.refuse(code);
    expect(h.logs.at(-1)).toBe(
      `The development agent switch stopped: a transition was refused (${code}).`,
    );
    h.ack();
    h.setActivity(activity());
    h.advance(60_000);
    expect(h.sent).toHaveLength(2);
    expect(h.openTimers()).toEqual([]);
    expect(h.messageListeners.size).toBe(0);
  }
});

test("it pauses when the project closes and resumes when it opens again", () => {
  const h = new Harness();
  h.ack();
  h.setActivity(NO_PROJECT);
  h.advance(60_000);
  expect(h.sent).toHaveLength(1);
  // Another project that does not list the agent.
  h.setActivity({
    ...activity(),
    projectId: "0192f0a0-7b3c-7d4e-8f50-0000000000e2" as ProjectId,
    agents: [],
    unfinishedRuns: [],
  });
  h.advance(60_000);
  expect(h.sent).toHaveLength(1);
  // The project opens and loads again.
  h.setActivity({
    ...NO_PROJECT,
    status: "loading",
    workspaceId: WS_A,
    projectId: PROJECT_1,
  });
  expect(h.sent).toHaveLength(1);
  h.setActivity(activity());
  expect(h.walk()).toEqual(["01 queued>running", "01 running>awaiting_input"]);

  // An acknowledgement that arrives while the project is closed still counts.
  h.setActivity(NO_PROJECT);
  h.ack();
  h.advance(60_000);
  expect(h.sent).toHaveLength(2);
  h.setActivity(activity());
  expect(h.walk()).toEqual([
    "01 queued>running",
    "01 running>awaiting_input",
    "01 awaiting_input>running",
  ]);
  expect(h.logs).toEqual([
    "The development agent switch moves the agent's runs.",
    "The development agent switch waits for the agent's project to open and load.",
    "The development agent switch waits: the open project does not list the agent.",
    "The development agent switch waits for the agent's project to open and load.",
    "The development agent switch moves the agent's runs.",
    "The development agent switch waits for the agent's project to open and load.",
    "The development agent switch moves the agent's runs.",
  ]);
});

test("each reason to wait logs its own fixed line, once per change of reason", () => {
  const h = new Harness({ account: SIGNED_OUT });
  // The same reason again, also for another cause, logs nothing more.
  h.setAccount({ ...accountStatus(), deviceKey: "loading" } as AccountStatus);
  h.setAccount({ ...accountStatus(), apiOrigin: "unset" } as AccountStatus);
  h.advance(60_000);
  h.setActivity(NO_PROJECT);
  // The host device without an open project, then another project that does
  // not list the agent, twice.
  h.setAccount(accountStatus());
  const otherProject: AgentActivityState = {
    ...activity(),
    projectId: "0192f0a0-7b3c-7d4e-8f50-0000000000e2" as ProjectId,
    agents: [],
    unfinishedRuns: [],
  };
  h.setActivity(otherProject);
  h.setActivity({ ...otherProject, revision: 2 });
  h.workspaceChanged();
  h.setAccount(SIGNED_OUT);
  h.setAccount(accountStatus());
  expect(h.sent).toEqual([]);
  h.setActivity(activity());
  expect(h.walk()).toEqual(["01 queued>running"]);
  expect(h.logs).toEqual([
    "The development agent switch waits: this device is not signed in and ready.",
    "The development agent switch waits for the agent's project to open and load.",
    "The development agent switch waits: the open project does not list the agent.",
    "The development agent switch waits: this device is not signed in and ready.",
    "The development agent switch waits: the open project does not list the agent.",
    "The development agent switch moves the agent's runs.",
  ]);
});

test("the run states come from the acknowledgements' payloads, not from what was sent", () => {
  // The activity still shows both runs queued, as it would while its own
  // reload holds the relayed events back.
  const h = new Harness();
  h.ack();
  h.advance(DEV_SWITCH_STEP_MS);
  expect(h.walk()).toEqual(["01 queued>running", "01 running>awaiting_input"]);
  // The acknowledgement reports a finished run: the walk goes on with the
  // next run, although the activity still shows it queued.
  h.ack(h.last, { previousState: "running", state: "failed" });
  h.advance(DEV_SWITCH_STEP_MS);
  expect(h.walk()).toEqual([
    "01 queued>running",
    "01 running>awaiting_input",
    "02 queued>running",
  ]);
  // Nothing is assumed before an acknowledgement: a refusal leaves the
  // state where the last acknowledgement put it, and nothing follows.
  h.refuse("conflict");
  h.advance(60_000);
  expect(h.sent).toHaveLength(3);
});

test("it never sends more than the account's transition limit allows", () => {
  const runs = Array.from(
    { length: Math.ceil(DEV_SWITCH_HOURLY_SENDS / 4) + 10 },
    (_, index) => [index + 1, "queued"] as const,
  );
  const h = new Harness({ activity: activity({ runs }) });
  // Acknowledged at once, so only the pace and the budget hold it back.
  for (
    let step = 0;
    step < 2_000 && h.sent.length <= DEV_SWITCH_HOURLY_SENDS + 5;
    step += 1
  ) {
    if (
      h
        .openTimers()
        .some((timer) => timer.at - h.time > DEV_SWITCH_ACK_TIMEOUT_MS)
    ) {
      // The budget's wait: move to its end.
      h.advance(Math.min(...h.openTimers().map((timer) => timer.at)) - h.time);
      continue;
    }
    h.ack();
    h.advance(DEV_SWITCH_STEP_MS);
  }
  expect(h.sent.length).toBeGreaterThan(DEV_SWITCH_HOURLY_SENDS);
  const times = h.sentAt;
  for (const [index, at] of times.entries()) {
    // The server's limits: 30 in any 10 seconds, 1,800 in an hour.
    expect(
      times.filter((t) => t >= at && t < at + 10_000).length,
    ).toBeLessThanOrEqual(5);
    expect(
      times.filter((t) => t >= at && t < at + 3_600_000).length,
    ).toBeLessThanOrEqual(DEV_SWITCH_HOURLY_SENDS);
    if (index > 0) {
      expect(at - (times[index - 1] ?? 0)).toBeGreaterThanOrEqual(
        DEV_SWITCH_STEP_MS,
      );
    }
  }
  // The send after the budget waits until the first one left the hour.
  expect(times[DEV_SWITCH_HOURLY_SENDS]).toBe(3_600_000);
});

/** Every close or loss of an open connection, as the client reports it. */
const CLOSES: readonly ConnectionStatus[] = [
  // A close of the server or a lost socket, after which the client backs
  // off: 1006 and 1001 (`connection_lost`), 1011 (`server_error`), 1013
  // (`server_busy`), 1008 such as `identity_mismatch` (`message_refused`),
  // and the others.
  ...CONNECTION_WAITING_REASONS.map(waiting),
  // A close after which the client does not reconnect on its own, such as
  // 4409 `connection_replaced`.
  ...CONNECTION_STOP_REASONS.map((reason): ConnectionStatus => ({
    state: "stopped",
    reason,
    revision: 2,
  })),
  // The client closed the socket and opens another one, as after the system
  // resumed.
  CONNECTING,
];

function closeCode(status: ConnectionStatus): string {
  return "reason" in status && status.reason !== undefined
    ? status.reason
    : status.state;
}

/** The connection opens again, and the workspace and the project reload. */
function reconnect(h: Harness): void {
  h.setConnection(CONNECTING);
  h.setConnection({ state: "authenticating", revision: 5 });
  h.setConnection(CONNECTED);
  h.setAccount(accountStatus());
  h.workspaceChanged();
  h.setActivity(activity());
}

test("every close or loss of the open connection stops the switch for good, and a reconnect does not resume it", () => {
  for (const close of CLOSES) {
    // While a transition waits for its acknowledgement, and between two
    // transitions.
    for (const waits of [true, false]) {
      const h = new Harness();
      if (!waits) {
        h.ack();
      }
      h.setConnection(close);
      expect(h.logs.at(-1)).toBe(
        `The development agent switch stopped: the connection closed (${closeCode(close)}).`,
      );
      expect(h.openTimers()).toEqual([]);
      expect(h.connectionListeners.size).toBe(0);
      expect(h.messageListeners.size).toBe(0);
      expect(h.accountListeners.size).toBe(0);
      // No resend and no next transition: not after the reconnect, not
      // after a late acknowledgement, and not after the acknowledgement's
      // timeout.
      reconnect(h);
      h.ack();
      h.advance(2 * DEV_SWITCH_ACK_TIMEOUT_MS + 60_000);
      expect(h.sent).toHaveLength(1);
    }
  }
});

test("a close also stops a paused switch and a resend that waits for the guards", () => {
  // Paused with the project closed.
  const h = new Harness();
  h.ack();
  h.setActivity(NO_PROJECT);
  h.setConnection(waiting("connection_lost"));
  expect(h.logs.at(-1)).toBe(
    "The development agent switch stopped: the connection closed (connection_lost).",
  );
  reconnect(h);
  h.advance(60_000);
  expect(h.sent).toHaveLength(1);

  // The acknowledgement timed out and the resend waits for a gate.
  const g = new Harness();
  g.workspaceLive = false;
  g.advance(DEV_SWITCH_ACK_TIMEOUT_MS);
  expect(g.sent).toHaveLength(1);
  g.setConnection(waiting("server_error"));
  g.workspaceLive = true;
  reconnect(g);
  g.advance(60_000);
  expect(g.sent).toHaveLength(1);
  expect(g.logs.at(-1)).toBe(
    "The development agent switch stopped: the connection closed (server_error).",
  );

  // Paused before its first send, while no run's model listens yet.
  const f = new Harness({ activity: NO_PROJECT });
  f.setConnection(waiting("connection_lost"));
  expect(f.logs.at(-1)).toBe(
    "The development agent switch stopped: the connection closed (connection_lost).",
  );
  reconnect(f);
  f.advance(60_000);
  expect(f.sent).toEqual([]);
});

test("a sign-out pauses the switch, unless a transition waits for its acknowledgement", () => {
  const h = new Harness();
  h.ack();
  // The sign-out: the client closes the socket, and the gates go down.
  const signOut = () => {
    h.agentsLive = false;
    h.workspaceLive = false;
    h.setConnection(SIGNED_OUT_CONNECTION);
    h.setAccount(SIGNED_OUT);
  };
  signOut();
  h.advance(60_000);
  expect(h.sent).toHaveLength(1);
  expect(h.logs.at(-1)).toBe(
    "The development agent switch waits: this device is not signed in and ready.",
  );
  // The host device signs in again, connects, and reloads: the walk goes on.
  h.agentsLive = true;
  h.workspaceLive = true;
  reconnect(h);
  expect(h.walk()).toEqual(["01 queued>running", "01 running>awaiting_input"]);

  // A sign-out while that transition waits stops the switch: it is never
  // sent again after a close.
  signOut();
  expect(h.logs.at(-1)).toBe(
    "The development agent switch stopped: the connection closed (not_signed_in).",
  );
  h.agentsLive = true;
  h.workspaceLive = true;
  reconnect(h);
  h.ack();
  h.advance(60_000);
  expect(h.sent).toHaveLength(2);
});

test("a connection that was not open yet changes nothing", () => {
  // The first attempt fails before the switch could send.
  const h = new Harness({ connection: CONNECTING, agentsLive: false });
  h.setConnection(waiting("connection_failed"));
  h.setConnection(CONNECTING);
  h.setConnection(CONNECTED);
  h.agentsLive = true;
  h.setActivity(activity());
  expect(h.walk()).toEqual(["01 queued>running"]);
  // Once it was open, its loss stops the switch.
  h.ack();
  h.setConnection(waiting("connection_lost"));
  reconnect(h);
  h.advance(60_000);
  expect(h.sent).toHaveLength(1);

  // Signed out at the start: the first connection after the sign-in is the
  // one that counts.
  const g = new Harness({
    account: SIGNED_OUT,
    connection: SIGNED_OUT_CONNECTION,
  });
  g.setConnection(CONNECTING);
  g.setConnection(waiting("connection_failed"));
  reconnect(g);
  expect(g.walk()).toEqual(["01 queued>running"]);
  g.setConnection({ state: "stopped", reason: "device_revoked", revision: 6 });
  expect(g.logs.at(-1)).toBe(
    "The development agent switch stopped: the connection closed (device_revoked).",
  );
});

test("a resend waits for the hourly budget too", () => {
  const runs = Array.from(
    { length: Math.ceil(DEV_SWITCH_HOURLY_SENDS / 4) + 1 },
    (_, index) => [index + 1, "queued"] as const,
  );
  const h = new Harness({ activity: activity({ runs }) });
  while (h.sent.length < DEV_SWITCH_HOURLY_SENDS) {
    h.ack();
    h.advance(DEV_SWITCH_STEP_MS);
  }
  // The last send waits for its acknowledgement, which does not come.
  const last = h.last;
  expect(h.sentAt.at(-1)).toBe(
    (DEV_SWITCH_HOURLY_SENDS - 1) * DEV_SWITCH_STEP_MS,
  );
  h.advance(DEV_SWITCH_ACK_TIMEOUT_MS);
  expect(h.sent).toHaveLength(DEV_SWITCH_HOURLY_SENDS);
  h.advance(3_600_000 - h.time - 1);
  expect(h.sent).toHaveLength(DEV_SWITCH_HOURLY_SENDS);
  h.advance(1);
  expect(h.sent).toHaveLength(DEV_SWITCH_HOURLY_SENDS + 1);
  expect(h.last).toEqual(last);
  expect(h.sentAt.at(-1)).toBe(3_600_000);
});

test("a key that is not ready, no API origin, or a device that is not signed in holds the walk", () => {
  const h = new Harness();
  for (const status of [
    { ...accountStatus(), deviceKey: "loading" },
    { ...accountStatus(), apiOrigin: "unset" },
    { ...accountStatus(), device: "signed_out" },
  ]) {
    const count = h.sent.length;
    h.setAccount(status as AccountStatus);
    h.ack();
    h.advance(60_000);
    expect(h.sent).toHaveLength(count);
    // The gates stay live; the status alone holds it back.
    h.setAccount(accountStatus());
    expect(h.sent).toHaveLength(count + 1);
  }
  expect(h.walk()).toEqual([
    "01 queued>running",
    "01 running>awaiting_input",
    "01 awaiting_input>running",
    "01 running>completed",
  ]);
});

test("a log that throws changes nothing", () => {
  const scenario = (h: Harness) => {
    h.ack();
    h.advance(DEV_SWITCH_STEP_MS);
    h.ack();
    h.advance(DEV_SWITCH_STEP_MS);
    // A resend, and then a refusal.
    h.advance(DEV_SWITCH_ACK_TIMEOUT_MS);
    h.refuse("conflict");
    h.advance(60_000);
    return { walk: h.walk(), sentAt: h.sentAt, timers: h.openTimers() };
  };
  const quiet = scenario(new Harness());
  const loud = scenario(
    new Harness({
      log: () => {
        throw new Error("The log failed.");
      },
    }),
  );
  expect(loud).toEqual(quiet);
  expect(loud.walk).toHaveLength(4);
  expect(loud.timers).toEqual([]);
});

test("a send that the connection refuses stops the switch", () => {
  for (const outcome of [
    "not_connected",
    "backpressure",
    "too_large",
  ] as const) {
    const h = new Harness();
    h.ack();
    h.failSend = outcome;
    h.advance(DEV_SWITCH_STEP_MS);
    expect(h.logs.at(-1)).toBe(
      `The development agent switch stopped: a transition was not sent (${outcome}).`,
    );
    h.failSend = null;
    h.setActivity(activity());
    h.advance(60_000);
    expect(h.sent).toHaveLength(1);
  }
});

test("close stops listening and cancels the timers", () => {
  const h = new Harness();
  h.ack();
  expect(h.openTimers()).toHaveLength(1);
  h.devSwitch.close();
  expect(h.openTimers()).toEqual([]);
  expect(h.accountListeners.size).toBe(0);
  expect(h.workspaceListeners.size).toBe(0);
  expect(h.agentListeners.size).toBe(0);
  expect(h.messageListeners.size).toBe(0);
  expect(h.connectionListeners.size).toBe(0);
  h.setActivity(activity());
  h.advance(60_000);
  expect(h.sent).toHaveLength(1);
  h.devSwitch.close();

  // Close while an acknowledgement waits.
  const g = new Harness();
  g.devSwitch.close();
  g.ack();
  g.advance(60_000);
  expect(g.sent).toHaveLength(1);
});

const moduleFolder = path.dirname(fileURLToPath(import.meta.url));

test("no log holds an ID or a name, the file never logs with console, and only index.ts starts the switch", () => {
  // A run with every outcome, for the logs.
  const h = new Harness({ account: accountStatus(OTHER_DEVICE_ID) });
  h.setAccount(accountStatus());
  h.runToEnd();
  const g = new Harness();
  g.advance(2 * DEV_SWITCH_ACK_TIMEOUT_MS);
  const f = new Harness();
  f.refuse("not_found");
  expect(allLogs.length).toBeGreaterThan(10);
  const text = allLogs.join("\n");
  for (const value of [
    DEVICE_ID,
    OTHER_DEVICE_ID,
    USER_ID,
    WS_A,
    OWNER,
    MEMBER,
    PROJECT_1,
    AGENT_ID,
    OTHER_AGENT,
    runId(1),
    eventId(1),
    "octocat",
    "Test agent",
  ]) {
    expect(text).not.toContain(value);
  }
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);

  const source = readFileSync(path.join(moduleFolder, "dev-switch.ts"), "utf8");
  expect(source).not.toMatch(/\bconsole\./);
  // No IPC channel: only the main process's entry point imports the switch.
  const mainFolder = path.dirname(moduleFolder);
  const importers: string[] = [];
  const visit = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !entry.name.endsWith(".test.ts") &&
        readFileSync(full, "utf8").includes("dev-switch")
      ) {
        importers.push(path.relative(mainFolder, full));
      }
    }
  };
  visit(path.dirname(mainFolder));
  expect(importers).toEqual(["index.ts"]);
});
