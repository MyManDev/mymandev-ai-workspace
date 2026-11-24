import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentListResponseSchema,
  AgentRunListItemSchema,
  AgentRunStateChangedPayloadSchema,
  canTransition,
  decodeClientMessage,
  decodeServerMessage,
  isTerminalRunState,
  ProviderConnectionListResponseSchema,
  RUN_CANCEL_REASONS,
  runReasonAllowed,
  type AgentId,
  type AgentListItem,
  type AgentRunListItem,
  type AgentRunStateChangedEvent,
  type DeviceId,
  type EventId,
  type ProjectId,
  type ProviderConnection,
  type ProviderConnectionId,
  type ProviderKind,
  type RepositoryId,
  type RunId,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { PermissionRequest } from "@mymandev/permissions";
import { expect, test } from "vitest";
import type {
  AccountStatus,
  ConnectionStatus,
} from "../../shared/ipc-contract.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { BuildClientEvent, ServerMessage } from "../connection/client.ts";
import {
  ENFORCEMENT_DENIAL_REASONS,
  type EnforcementDecision,
  type EnforcementDenialReason,
  type HeldRun,
} from "../permissions/enforcement.ts";
import { HOST_RUN_ACK_TIMEOUT_MS } from "./host-run.ts";
import {
  createRunExecutorRegistry,
  PRODUCTION_RUN_EXECUTORS,
  type RunExecution,
  type RunExecutionOutcome,
  type RunExecutor,
} from "./run-executor.ts";
import {
  createRunSupervisor,
  HOST_RUN_REASONS,
  SIGN_IN_TIMER_STEP_MS,
  RUN_SUPERVISOR_RELOAD_DELAY_MS,
  RUN_SUPERVISOR_RELOAD_MAX_MS,
  RUN_SUPERVISOR_RETRY_DELAY_MS,
  RUN_SUPERVISOR_RETRY_MAX_MS,
  RUN_SUPERVISOR_SEND_INTERVAL_MS,
  type RunStartDecision,
  type RunSupervisor,
  type RunSupervisorAccount,
} from "./run-supervisor.ts";
import type { AgentActivityState } from "./service.ts";

const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004" as DeviceId;
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000014" as DeviceId;
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009" as UserId;
const WS_A = "0192f0a0-7b3c-7d4e-8f50-0000000000a1" as WorkspaceId;
const OWNER = "0192f0a0-7b3c-7d4e-8f50-0000000000c1";
const PROJECT_1 = "0192f0a0-7b3c-7d4e-8f50-0000000000e1" as ProjectId;
const PROJECT_2 = "0192f0a0-7b3c-7d4e-8f50-0000000000e2" as ProjectId;
const AGENT_A = "0192f0a0-7b3c-7d4e-8f50-0000000000f1" as AgentId;
const AGENT_B = "0192f0a0-7b3c-7d4e-8f50-0000000000f2" as AgentId;
const AGENT_FOREIGN = "0192f0a0-7b3c-7d4e-8f50-0000000000f3" as AgentId;
const AGENT_DISABLED = "0192f0a0-7b3c-7d4e-8f50-0000000000f4" as AgentId;
const AGENT_UNKNOWN_HOST = "0192f0a0-7b3c-7d4e-8f50-0000000000f5" as AgentId;
const AGENT_OTHER_PROJECT = "0192f0a0-7b3c-7d4e-8f50-0000000000f6" as AgentId;
const CLAUDE_CONNECTION =
  "0192f0a0-7b3c-7d4e-8f50-0000000000d1" as ProviderConnectionId;
const CODEX_CONNECTION =
  "0192f0a0-7b3c-7d4e-8f50-0000000000d2" as ProviderConnectionId;
const GONE_CONNECTION =
  "0192f0a0-7b3c-7d4e-8f50-0000000000d3" as ProviderConnectionId;
const REPOSITORY = "0192f0a0-7b3c-7d4e-8f50-0000000000b1" as RepositoryId;
const INPUT_MESSAGE = "0192f0a0-7b3c-7d4e-8f50-0000000000b2";
const AT = Date.parse("2026-11-24T10:00:00.000Z");
const WALL_START = Date.parse("2026-11-24T12:00:00.000Z");
const STEP = RUN_SUPERVISOR_SEND_INTERVAL_MS;

function runId(n: number): RunId {
  return `0192f0a0-7b3c-7d4e-8f50-0000000b${n.toString(16).padStart(4, "0")}` as RunId;
}

function eventId(n: number): EventId {
  return `0192f0a0-7b3c-7d4e-8f50-0000000e${n.toString(16).padStart(4, "0")}` as EventId;
}

/** The end of the sign-in by default: 30 days after the test's start. */
const SIGN_IN_END = WALL_START + 30 * 24 * 60 * 60_000;

function accountStatus(
  deviceId: string = DEVICE_ID,
  signInEnd: number = SIGN_IN_END,
): AccountStatus {
  return Object.freeze({
    revision: 1,
    account: Object.freeze({
      kind: "signed_in",
      login: "octocat",
      displayName: "The Octocat",
      deviceId,
      signInExpiresAt: new Date(signInEnd).toISOString(),
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

const CONNECTED: ConnectionStatus = { state: "connected", revision: 1 };
const LOST: ConnectionStatus = {
  state: "waiting",
  reason: "connection_lost",
  retryAt: "2026-11-24T12:00:30.000Z",
  revision: 2,
};
const OFFLINE: ConnectionStatus = {
  state: "offline",
  reason: "not_signed_in",
  revision: 3,
};

/** The agents of the open project, as the owner's account reads them. */
function agentList(projectId: ProjectId = PROJECT_1): AgentListItem[] {
  const agent = (
    id: AgentId,
    extra: { hostDeviceId?: DeviceId; disabledAt?: string } = {},
  ) => ({
    id,
    projectId,
    name: "Test agent",
    ownerMemberId: OWNER,
    disabledAt: extra.disabledAt ?? null,
    ...(extra.hostDeviceId === undefined
      ? {}
      : { hostDeviceId: extra.hostDeviceId }),
  });
  const agents =
    projectId === PROJECT_1
      ? [
          agent(AGENT_A, { hostDeviceId: DEVICE_ID }),
          agent(AGENT_B, { hostDeviceId: DEVICE_ID }),
          agent(AGENT_FOREIGN, { hostDeviceId: OTHER_DEVICE_ID }),
          agent(AGENT_DISABLED, {
            hostDeviceId: DEVICE_ID,
            disabledAt: "2026-11-24T09:00:00.000Z",
          }),
          agent(AGENT_UNKNOWN_HOST),
        ]
      : [agent(AGENT_OTHER_PROJECT, { hostDeviceId: DEVICE_ID })];
  return AgentListResponseSchema.parse({ agents }).agents;
}

interface RunOptions {
  readonly agent?: AgentId;
  /** Seconds after `AT`; defaults to `n`. */
  readonly createdAfter?: number;
  /** Null for a run without a provider connection. */
  readonly connection?: ProviderConnectionId | null;
  readonly project?: ProjectId;
}

function run(
  n: number,
  state: RunState,
  options: RunOptions = {},
): AgentRunListItem {
  const connection =
    options.connection === undefined ? CLAUDE_CONNECTION : options.connection;
  return AgentRunListItemSchema.parse({
    id: runId(n),
    agentId: options.agent ?? AGENT_A,
    projectId: options.project ?? PROJECT_1,
    repositoryId: REPOSITORY,
    state,
    reason: null,
    createdAt: new Date(AT + (options.createdAfter ?? n) * 1_000).toISOString(),
    finishedAt: isTerminalRunState(state) ? new Date(AT).toISOString() : null,
    inputMessageId: INPUT_MESSAGE,
    ...(connection === null ? {} : { providerConnectionId: connection }),
  });
}

function providerConnections(
  ...items: readonly [ProviderConnectionId, ProviderKind][]
): ProviderConnection[] {
  return ProviderConnectionListResponseSchema.parse({
    providerConnections: items.map(([id, kind]) => ({
      id,
      kind,
      label: "Connection",
      createdAt: new Date(AT).toISOString(),
    })),
  }).providerConnections;
}

const BOTH_CONNECTIONS = providerConnections(
  [CLAUDE_CONNECTION, "claude"],
  [CODEX_CONNECTION, "codex"],
);

interface Call {
  readonly execution: RunExecution;
  readonly resolve: (outcome: RunExecutionOutcome) => void;
  readonly reject: (error: unknown) => void;
}

/** An executor whose runs the test ends. */
class FakeExecutor implements RunExecutor {
  readonly calls: Call[] = [];
  /** Throws from `start` instead of answering, when set. */
  throwOnStart = false;

  readonly start = (execution: RunExecution): Promise<RunExecutionOutcome> => {
    if (this.throwOnStart) {
      throw new Error("The executor broke.");
    }
    return new Promise((resolve, reject) => {
      this.calls.push({ execution, resolve, reject });
    });
  };

  get last(): Call {
    const call = this.calls.at(-1);
    if (call === undefined) {
      throw new Error("Nothing was started");
    }
    return call;
  }
}

interface Timer {
  readonly at: number;
  readonly callback: () => void;
  cancelled: boolean;
}

/** Every log line of every harness, for the check that no log holds an ID. */
const allLogs: string[] = [];

interface HarnessOptions {
  readonly runs?: readonly AgentRunListItem[];
  readonly accountStatus?: AccountStatus;
  /** The executors by kind; a Claude executor by default. */
  readonly executors?: Partial<Record<ProviderKind, FakeExecutor>>;
  readonly reserved?: readonly AgentId[];
  readonly beforeStart?: (run: HeldRun) => RunStartDecision;
  readonly withoutEnforcement?: boolean;
  /** Whether the activity is ready and live at the start; true by default. */
  readonly live?: boolean;
  readonly projectId?: ProjectId | null;
}

class Harness {
  time = 0;
  accountStatus: AccountStatus = accountStatus();
  connectionStatus: ConnectionStatus = CONNECTED;
  /** Every run that the server holds, of every project. */
  runs: AgentRunListItem[];
  projectId: ProjectId | null;
  live: boolean;
  reloads = 1;
  /**
   * Finished runs that the activity's list of recently finished runs no
   * longer holds, as beyond its limit.
   */
  readonly unlistedFinished = new Set<RunId>();
  /**
   * Runs that the activity holds as their creation event built them, without
   * a provider connection or an input message, until the next reload.
   */
  readonly createdByEvent = new Set<RunId>();
  /** The unfinished runs that the last reload of the runs read. */
  snapshot: readonly AgentRunListItem[] = [];
  /** When the supervisor asked for a reload, on the test's clock. */
  readonly reloadRequests: number[] = [];
  revision = 1;
  readonly claude: FakeExecutor;
  readonly codex: FakeExecutor;
  readonly sent: AgentRunStateChangedEvent[] = [];
  /** Sends whose previous state was not the run's state on the server. */
  readonly violations: string[] = [];
  readonly providerReads: ((
    result: WorkspaceReadResult<{ providerConnections: ProviderConnection[] }>,
  ) => void)[] = [];
  /** What the fake enforcement point answers. */
  enforcementAnswer: EnforcementDenialReason | null = null;
  readonly enforcementCalls: {
    run: HeldRun;
    request: unknown;
    purpose: "check" | "recheck";
  }[] = [];
  readonly timers: Timer[] = [];
  readonly logs: string[] = [];
  readonly accountListeners = new Set<(status: AccountStatus) => void>();
  readonly connectionListeners = new Set<(status: ConnectionStatus) => void>();
  readonly messageListeners = new Set<(message: ServerMessage) => void>();
  readonly agentListeners = new Set<(state: AgentActivityState) => void>();
  readonly grantListeners = new Set<() => void>();
  readonly supervisor: RunSupervisor;
  #nextEvent = 0;

  constructor(options: HarnessOptions = {}) {
    this.runs = [...(options.runs ?? [])];
    this.accountStatus = options.accountStatus ?? this.accountStatus;
    this.projectId =
      options.projectId === undefined ? PROJECT_1 : options.projectId;
    this.live = options.live ?? true;
    const executors = options.executors ?? { claude: new FakeExecutor() };
    this.claude = executors.claude ?? new FakeExecutor();
    this.codex = executors.codex ?? new FakeExecutor();
    this.snapshot = this.unfinishedOnServer();
    const readWorkspaceData = ((name: string) => {
      if (name !== "listProviderConnections") {
        throw new Error(`Unexpected read ${name}`);
      }
      return new Promise((resolve) => {
        this.providerReads.push(resolve);
      });
    }) as unknown as RunSupervisorAccount["readWorkspaceData"];
    this.supervisor = createRunSupervisor({
      account: {
        status: () => this.accountStatus,
        onStatusChange: (listener) => {
          this.accountListeners.add(listener);
          return () => this.accountListeners.delete(listener);
        },
        readWorkspaceData,
      },
      connection: {
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
      },
      agents: {
        state: () => this.state(),
        onChange: (listener) => {
          this.agentListeners.add(listener);
          return () => {
            this.agentListeners.delete(listener);
          };
        },
        gateLive: () => this.live && this.projectId !== null,
        runsReloaded: () => this.reloads,
        reloadedRuns: () => this.snapshot,
        requestReload: () => {
          this.reloadRequests.push(this.time);
        },
      },
      grants: {
        onGrantsChanged: (listener) => {
          this.grantListeners.add(listener);
          return () => {
            this.grantListeners.delete(listener);
          };
        },
      },
      executors: createRunExecutorRegistry(executors),
      ...(options.withoutEnforcement === true
        ? {}
        : {
            enforcement: {
              check: (held: HeldRun, request: unknown) =>
                this.decide(held, request, "check"),
              recheck: (held: HeldRun, request: unknown) =>
                this.decide(held, request, "recheck"),
            },
          }),
      ...(options.beforeStart === undefined
        ? {}
        : { beforeStart: options.beforeStart }),
      reservedAgentIds: options.reserved ?? [],
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
      log: (message) => {
        this.logs.push(message);
        allLogs.push(message);
      },
    });
  }

  /** The fake enforcement point: it answers `enforcementAnswer`. */
  decide(
    held: HeldRun,
    request: unknown,
    purpose: "check" | "recheck",
  ): EnforcementDecision {
    this.enforcementCalls.push({ run: held, request, purpose });
    return this.enforcementAnswer === null
      ? { allowed: true, request: request as PermissionRequest }
      : { allowed: false, reason: this.enforcementAnswer };
  }

  /** The open project's unfinished runs on the server, newest first. */
  unfinishedOnServer(): AgentRunListItem[] {
    if (this.projectId === null) {
      return [];
    }
    return this.runs
      .filter(
        (item) =>
          item.projectId === this.projectId && !isTerminalRunState(item.state),
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  /** The agent activity of the open project, as the service gives it. */
  state(): AgentActivityState {
    if (this.projectId === null) {
      return Object.freeze({
        revision: this.revision,
        status: "no_project",
        workspaceId: null,
        projectId: null,
        agents: [],
        unfinishedRuns: [],
        finishedRuns: [],
      });
    }
    const project = this.runs
      .filter((item) => item.projectId === this.projectId)
      .map((item): AgentRunListItem => {
        if (!this.createdByEvent.has(item.id)) {
          return item;
        }
        // Built from the event's payload: neither field is in it.
        const copy: Record<string, unknown> = { ...item };
        delete copy.providerConnectionId;
        delete copy.inputMessageId;
        return Object.freeze(copy) as AgentRunListItem;
      });
    const newestFirst = (a: AgentRunListItem, b: AgentRunListItem) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return Object.freeze({
      revision: this.revision,
      status: "ready",
      workspaceId: WS_A,
      projectId: this.projectId,
      agents: agentList(this.projectId),
      unfinishedRuns: project
        .filter((item) => !isTerminalRunState(item.state))
        .sort(newestFirst),
      finishedRuns: project.filter(
        (item) =>
          isTerminalRunState(item.state) && !this.unlistedFinished.has(item.id),
      ),
    });
  }

  /** The agent activity service tells its listeners. */
  changed(): void {
    this.revision += 1;
    const state = this.state();
    for (const listener of [...this.agentListeners]) {
      listener(state);
    }
  }

  runState(n: number): RunState | undefined {
    return this.runs.find((item) => item.id === runId(n))?.state;
  }

  /** The server sets a run's state, as an applied transition does. */
  setRun(id: RunId, state: RunState): void {
    this.runs = this.runs.map((item) =>
      item.id === id
        ? AgentRunListItemSchema.parse({
            ...item,
            state,
            finishedAt: isTerminalRunState(state)
              ? new Date(AT).toISOString()
              : null,
          })
        : item,
    );
  }

  /** Like the connection client: builds from the identity, checks, sends. */
  sendAs(build: BuildClientEvent) {
    if (this.connectionStatus.state !== "connected") {
      return "not_connected" as const;
    }
    let event;
    try {
      event = build({ userId: USER_ID, deviceId: DEVICE_ID });
    } catch {
      return "invalid" as const;
    }
    const checked = decodeClientMessage(
      JSON.parse(JSON.stringify(event)) as unknown,
    );
    if (
      !checked.ok ||
      checked.kind !== "event" ||
      checked.event.type !== "agent.run.state_changed"
    ) {
      return "invalid" as const;
    }
    const { payload } = checked.event;
    const onServer = this.runs.find((item) => item.id === payload.runId);
    if (
      onServer?.state !== payload.previousState ||
      payload.previousState === null ||
      !canTransition(payload.previousState, payload.state)
    ) {
      this.violations.push(
        `${String(payload.previousState)}>${payload.state} on ${String(onServer?.state)}`,
      );
    }
    this.sent.push(checked.event);
    return "sent" as const;
  }

  get last(): AgentRunStateChangedEvent {
    const event = this.sent.at(-1);
    if (event === undefined) {
      throw new Error("Nothing was sent");
    }
    return event;
  }

  /** The sent transitions as `run previous>next reason`. */
  walk(): string[] {
    return this.sent.map(
      (event) =>
        `${Number.parseInt(event.payload.runId.slice(-4), 16)} ${String(event.payload.previousState)}>${event.payload.state}${event.payload.reason === undefined ? "" : ` ${event.payload.reason}`}`,
    );
  }

  receive(message: ServerMessage): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  /**
   * The server applies `event` (the last one sent by default) and relays
   * it: the agent activity follows first, as its service hears the relay
   * before the run's model does, and then the acknowledgement arrives.
   */
  ack(event: AgentRunStateChangedEvent = this.last): void {
    this.setRun(event.payload.runId, event.payload.state);
    this.changed();
    const decoded = decodeServerMessage({ ...event, deviceId: null });
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

  /** Answers the oldest read of the provider connections. */
  async answerProviders(
    connections: ProviderConnection[] = BOTH_CONNECTIONS,
  ): Promise<void> {
    const resolve = this.providerReads.shift();
    if (resolve === undefined) {
      throw new Error("No read of the provider connections waits");
    }
    resolve({ ok: true, value: { providerConnections: connections } });
    await settle();
  }

  async failProviders(reason: WorkspaceReadFailure): Promise<void> {
    const resolve = this.providerReads.shift();
    if (resolve === undefined) {
      throw new Error("No read of the provider connections waits");
    }
    resolve({ ok: false, reason });
    await settle();
  }

  setAccount(status: AccountStatus): void {
    this.accountStatus = status;
    for (const listener of [...this.accountListeners]) {
      listener(status);
    }
  }

  setConnection(status: ConnectionStatus): void {
    this.connectionStatus = status;
    if (status.state !== "connected") {
      // The agent activity service ends its gate without a change.
      this.live = false;
    }
    for (const listener of [...this.connectionListeners]) {
      listener(status);
    }
  }

  /** A reload of the runs applied, as after `workspace.subscribed`. */
  reload(): void {
    this.live = true;
    this.reloads += 1;
    this.createdByEvent.clear();
    this.snapshot = this.unfinishedOnServer();
    this.changed();
  }

  /**
   * The server creates `item`, and the activity applies its creation event
   * live: the activity holds the run without a provider connection or an
   * input message until the next reload.
   */
  createByEvent(item: AgentRunListItem): void {
    this.runs.push(item);
    this.createdByEvent.add(item.id);
    this.changed();
  }

  /** The connection comes back and the open project reloads. */
  reconnect(): void {
    this.setConnection(CONNECTED);
    this.reload();
  }

  openProject(projectId: ProjectId | null): void {
    this.projectId = projectId;
    this.live = false;
    this.snapshot = [];
    this.changed();
    if (projectId !== null) {
      this.reload();
    }
  }

  grantsChanged(): void {
    for (const listener of [...this.grantListeners]) {
      listener();
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

  /** Acknowledges the last send and waits out the pace. */
  ackAndStep(): void {
    this.ack();
    this.advance(STEP);
  }
}

/** Lets the promises of the reads and the executors settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

/** A harness with one queued run of agent A that runs on the Claude executor. */
async function started(runs: readonly AgentRunListItem[] = [run(1, "queued")]) {
  const h = new Harness({ runs });
  await h.answerProviders();
  expect(h.walk()).toEqual(["1 queued>running"]);
  h.ack();
  expect(h.claude.calls).toHaveLength(1);
  return h;
}

// The host reasons.

test("every host reason is a plain reason that an agent may give, and none is the server's", () => {
  const reserved: readonly string[] = RUN_CANCEL_REASONS;
  for (const reason of Object.values(HOST_RUN_REASONS)) {
    expect(reserved).not.toContain(reason);
    for (const state of ["failed", "cancelled"] as const) {
      const payload = {
        runId: runId(1),
        agentId: AGENT_A,
        previousState: "running" as const,
        state,
        reason,
      };
      expect(AgentRunStateChangedPayloadSchema.safeParse(payload).success).toBe(
        true,
      );
      expect(
        runReasonAllowed({
          actor: { kind: "agent", agentId: AGENT_A },
          payload,
        }),
      ).toBe(true);
    }
  }
  expect(Object.isFrozen(HOST_RUN_REASONS)).toBe(true);
});

// Adoption and the happy path.

test("a queued run of an agent that this device hosts runs on its executor and completes", async () => {
  const h = new Harness({ runs: [run(1, "queued")] });
  // It reads this device's provider connections before anything is sent.
  expect(h.providerReads).toHaveLength(1);
  expect(h.sent).toEqual([]);
  await h.answerProviders();
  expect(h.walk()).toEqual(["1 queued>running"]);
  expect(h.last.actor).toEqual({ kind: "agent", agentId: AGENT_A });
  expect(h.last.workspaceId).toBe(WS_A);
  // The executor starts only after the acknowledgement.
  expect(h.claude.calls).toEqual([]);
  h.ack();
  expect(h.claude.calls).toHaveLength(1);
  const { execution } = h.claude.last;
  expect(execution.run).toEqual({
    runId: runId(1),
    agentId: AGENT_A,
    hostDeviceId: DEVICE_ID,
    repositoryId: REPOSITORY,
    providerConnectionId: CLAUDE_CONNECTION,
  });
  expect(execution.workspaceId).toBe(WS_A);
  expect(execution.projectId).toBe(PROJECT_1);
  expect(execution.inputMessageId).toBe(INPUT_MESSAGE);
  expect(execution.providerKind).toBe("claude");
  expect(execution.signal.aborted).toBe(false);
  expect(Object.isFrozen(execution)).toBe(true);
  expect(Object.isFrozen(execution.run)).toBe(true);
  // No `provider.use` check before the start: the enforcement point was
  // not called (the seam `beforeStart` waits for the Project Manager).
  expect(h.enforcementCalls).toEqual([]);

  h.claude.last.resolve({ outcome: "completed" });
  await settle();
  // The pace holds the next send.
  expect(h.sent).toHaveLength(1);
  h.advance(STEP);
  expect(h.walk()).toEqual(["1 queued>running", "1 running>completed"]);
  h.ack();
  h.advance(10 * STEP);
  expect(h.sent).toHaveLength(2);
  expect(h.runState(1)).toBe("completed");
  expect(h.violations).toEqual([]);
});

test("one run of an agent at a time, the oldest first, while each agent has its own", async () => {
  // Created in the order 3, 1, 2; run 3 is the oldest.
  const h = new Harness({
    runs: [
      run(1, "queued", { createdAfter: 20 }),
      run(2, "queued", { createdAfter: 30 }),
      run(3, "queued", { createdAfter: 10 }),
      run(4, "queued", { agent: AGENT_B, createdAfter: 40 }),
    ],
  });
  await h.answerProviders();
  expect(h.walk()).toEqual(["3 queued>running"]);
  h.ackAndStep();
  // Agent B's run goes too, while agent A's oldest runs.
  expect(h.walk()).toEqual(["3 queued>running", "4 queued>running"]);
  h.ackAndStep();
  expect(h.claude.calls.map((call) => call.execution.run.runId)).toEqual([
    runId(3),
    runId(4),
  ]);
  // Nothing more while both run.
  h.advance(10 * STEP);
  expect(h.providerReads).toEqual([]);
  expect(h.sent).toHaveLength(2);

  h.claude.calls[0]?.resolve({ outcome: "completed" });
  await settle();
  h.advance(STEP);
  expect(h.walk().at(-1)).toBe("3 running>completed");
  h.ackAndStep();
  // Agent A's next run is the next oldest: 1, after a new read.
  expect(h.providerReads).toHaveLength(1);
  await h.answerProviders();
  expect(h.walk().at(-1)).toBe("1 queued>running");
  h.ackAndStep();
  h.claude.last.resolve({ outcome: "completed" });
  await settle();
  h.advance(STEP);
  h.ackAndStep();
  await h.answerProviders();
  expect(h.walk().at(-1)).toBe("2 queued>running");
  expect(h.violations).toEqual([]);
});

// A queued run that cannot run here.

test("a queued run fails at once without an executor for its kind or without a provider connection of this device", async () => {
  const h = new Harness({
    runs: [
      // A Codex connection, without a Codex executor.
      run(1, "queued", { connection: CODEX_CONNECTION }),
      // A connection that is not in this device's list.
      run(2, "queued", { agent: AGENT_B, connection: GONE_CONNECTION }),
    ],
  });
  await h.answerProviders();
  expect(h.walk()).toEqual([`1 queued>failed ${HOST_RUN_REASONS.noExecutor}`]);
  h.ackAndStep();
  expect(h.walk()).toEqual([
    `1 queued>failed ${HOST_RUN_REASONS.noExecutor}`,
    `2 queued>failed ${HOST_RUN_REASONS.providerConnectionMissing}`,
  ]);
  h.ackAndStep();
  expect(h.claude.calls).toEqual([]);
  expect(h.codex.calls).toEqual([]);

  expect(h.violations).toEqual([]);
});

test("a queued run that a reload lists without a provider connection is left queued, and the agent's next run goes", async () => {
  // Only the development seed creates such runs.
  const h = new Harness({
    runs: [
      run(1, "queued", { connection: null }),
      run(2, "queued", { connection: null, agent: AGENT_B }),
    ],
  });
  h.reload();
  h.advance(60_000);
  expect(h.providerReads).toEqual([]);
  expect(h.sent).toEqual([]);

  // A newer run of agent A with a connection goes past the seeded one.
  h.runs.push(run(3, "queued"));
  h.reload();
  await h.answerProviders();
  expect(h.walk()).toEqual(["3 queued>running"]);
  expect(h.violations).toEqual([]);
});

test("a failed read of the provider connections sends nothing and is retried with the backoff", async () => {
  const h = new Harness({ runs: [run(1, "queued")] });
  await h.failProviders("unavailable");
  expect(h.sent).toEqual([]);
  expect(h.providerReads).toEqual([]);
  h.changed();
  expect(h.providerReads).toEqual([]);
  h.advance(2_000);
  expect(h.providerReads).toHaveLength(1);
  await h.answerProviders();
  expect(h.walk()).toEqual(["1 queued>running"]);
});

test("with an empty executor registry, every queued run with a provider connection fails at once, and the seeded ones stay queued", async () => {
  expect(PRODUCTION_RUN_EXECUTORS.kinds()).toEqual([]);
  const h = new Harness({
    runs: [
      run(1, "queued"),
      run(2, "queued", { connection: GONE_CONNECTION, agent: AGENT_B }),
      run(3, "queued", { connection: null, agent: AGENT_B, createdAfter: 0 }),
    ],
    executors: {},
  });
  expect(h.providerReads).toHaveLength(1);
  await h.answerProviders();
  expect(h.walk()).toEqual([`1 queued>failed ${HOST_RUN_REASONS.noExecutor}`]);
  h.ackAndStep();
  expect(h.walk()).toEqual([
    `1 queued>failed ${HOST_RUN_REASONS.noExecutor}`,
    `2 queued>failed ${HOST_RUN_REASONS.providerConnectionMissing}`,
  ]);
  h.ackAndStep();
  h.reload();
  h.advance(60_000);
  expect(h.providerReads).toEqual([]);
  expect(h.sent).toHaveLength(2);
  expect(h.runState(3)).toBe("queued");
  expect(h.violations).toEqual([]);
});

test("a run created live waits for the reload that lists it, and then runs with its provider connection and input message", async () => {
  const h = new Harness();
  // The creation event alone: the activity holds the run without its
  // provider connection, so nothing is decided.
  h.createByEvent(run(1, "queued"));
  expect(h.state().unfinishedRuns[0]?.providerConnectionId).toBeUndefined();
  h.advance(60_000);
  expect(h.providerReads).toEqual([]);
  expect(h.sent).toEqual([]);

  // The reload that the creation asked for lists it.
  h.reload();
  await h.answerProviders();
  expect(h.walk()).toEqual(["1 queued>running"]);
  h.ack();
  const { execution } = h.claude.last;
  expect(execution.run.providerConnectionId).toBe(CLAUDE_CONNECTION);
  expect(execution.inputMessageId).toBe(INPUT_MESSAGE);

  // A run created live behind a listed one: the listed one goes first, and
  // the new one waits for its own reload.
  const g = new Harness({ runs: [run(1, "queued", { agent: AGENT_B })] });
  g.createByEvent(run(2, "queued"));
  await g.answerProviders();
  g.ack();
  g.advance(60_000);
  expect(g.walk()).toEqual(["1 queued>running"]);
  expect(g.providerReads).toEqual([]);
  g.reload();
  await g.answerProviders();
  expect(g.walk()).toEqual(["1 queued>running", "2 queued>running"]);
  expect(g.violations).toEqual([]);
});

// The executor's outcome.

test("an executor's failure becomes failed with its code, or executor_failed", async () => {
  const outcomes: [string, (call: Call) => void, string][] = [
    [
      "a code",
      (call) => call.resolve({ outcome: "failed", reason: "provider_quota" }),
      "provider_quota",
    ],
    [
      "a message",
      (call) =>
        call.resolve({
          outcome: "failed",
          reason: "Quota of C:\\Users exceeded",
        }),
      HOST_RUN_REASONS.executorFailed,
    ],
    [
      "a server code",
      (call) => call.resolve({ outcome: "failed", reason: "agent_disabled" }),
      // Fits the pattern, but only the server gives it.
      HOST_RUN_REASONS.executorFailed,
    ],
    ...Object.values(HOST_RUN_REASONS).map(
      (reason): [string, (call: Call) => void, string] => [
        `the host code ${reason}`,
        (call) => call.resolve({ outcome: "failed", reason }),
        // Fits the pattern, but only the supervisor gives it.
        HOST_RUN_REASONS.executorFailed,
      ],
    ),
    [
      "a rejection",
      (call) => call.reject(new Error("boom")),
      HOST_RUN_REASONS.executorFailed,
    ],
    [
      "a malformed outcome",
      (call) =>
        call.resolve({ outcome: "done" } as unknown as RunExecutionOutcome),
      HOST_RUN_REASONS.executorFailed,
    ],
  ];
  for (const [label, end, reason] of outcomes) {
    const h = await started();
    end(h.claude.last);
    await settle();
    h.advance(STEP);
    expect(h.walk().at(-1), label).toBe(`1 running>failed ${reason}`);
    expect(h.violations, label).toEqual([]);
  }

  // An executor that throws at its start.
  const h = new Harness({ runs: [run(1, "queued")] });
  h.claude.throwOnStart = true;
  await h.answerProviders();
  h.ack();
  await settle();
  h.advance(STEP);
  expect(h.walk().at(-1)).toBe(
    `1 running>failed ${HOST_RUN_REASONS.executorFailed}`,
  );
});

// Stops: grants and the sign-in.

test("a lost grant aborts the run and reports it cancelled; an ended action is not checked again", async () => {
  const h = await started();
  const { execution } = h.claude.last;
  const request = { capability: "provider.use", agentId: AGENT_A };
  const check = execution.check(request);
  expect(check.allowed).toBe(true);
  expect(h.enforcementCalls).toHaveLength(1);
  expect(h.enforcementCalls[0]?.run).toBe(execution.run);

  // A change that keeps the grant changes nothing. The action runs
  // already, so it is checked again with `recheck`, which records no start.
  h.grantsChanged();
  expect(execution.signal.aborted).toBe(false);
  expect(h.enforcementCalls.map((call) => call.purpose)).toEqual([
    "check",
    "recheck",
  ]);
  expect(h.enforcementCalls[1]?.run).toBe(execution.run);

  h.enforcementAnswer = "no_grant";
  h.grantsChanged();
  expect(execution.signal.aborted).toBe(true);
  h.advance(STEP);
  expect(h.walk().at(-1)).toBe(
    `1 running>cancelled ${HOST_RUN_REASONS.grantInactive}`,
  );
  // Every check after the abort denies, and the late outcome is ignored.
  h.enforcementAnswer = null;
  expect(execution.check(request)).toEqual({
    allowed: false,
    reason: "check_failed",
  });
  h.ackAndStep();
  h.claude.last.resolve({ outcome: "completed" });
  await settle();
  h.advance(10 * STEP);
  expect(h.sent).toHaveLength(2);

  // An action that ended is not checked again.
  const g = await started();
  const ended = g.claude.last.execution.check(request);
  if (!ended.allowed) {
    throw new Error("The check was denied");
  }
  ended.end();
  g.enforcementAnswer = "no_grant";
  g.grantsChanged();
  expect(g.claude.last.execution.signal.aborted).toBe(false);
  expect(g.sent).toHaveLength(1);

  // A denial of the sign-in reports signed_out.
  const f = await started();
  f.claude.last.execution.check(request);
  f.enforcementAnswer = "sign_in_invalid";
  f.grantsChanged();
  f.advance(STEP);
  expect(f.walk().at(-1)).toBe(
    `1 running>cancelled ${HOST_RUN_REASONS.signedOut}`,
  );
  expect(f.violations).toEqual([]);
});

test("a held terminal.execute is checked again with recheck only, and each denial while connected maps to its report", async () => {
  // A held shell: every re-check uses recheck, never check, so the
  // enforcement point records no false shell start.
  const h = await started();
  const shell = {
    capability: "terminal.execute",
    agentId: AGENT_A,
    repositoryId: REPOSITORY,
  };
  expect(h.claude.last.execution.check(shell).allowed).toBe(true);
  for (let round = 0; round < 3; round += 1) {
    h.grantsChanged();
  }
  expect(h.enforcementCalls.map((call) => call.purpose)).toEqual([
    "check",
    "recheck",
    "recheck",
    "recheck",
  ]);

  const cases: [EnforcementDenialReason, string][] = [
    ["no_grant", `cancelled ${HOST_RUN_REASONS.grantInactive}`],
    ["signed_out", `cancelled ${HOST_RUN_REASONS.signedOut}`],
    ["sign_in_invalid", `cancelled ${HOST_RUN_REASONS.signedOut}`],
    ["device_unknown", `cancelled ${HOST_RUN_REASONS.signedOut}`],
    ["not_this_device", `cancelled ${HOST_RUN_REASONS.signedOut}`],
    ["store_unusable", `failed ${HOST_RUN_REASONS.grantCheckUnavailable}`],
    ["clock_invalid", `failed ${HOST_RUN_REASONS.grantCheckUnavailable}`],
    ["record_failed", `failed ${HOST_RUN_REASONS.grantCheckUnavailable}`],
    ["check_failed", `failed ${HOST_RUN_REASONS.grantCheckUnavailable}`],
    ["run_invalid", `failed ${HOST_RUN_REASONS.grantCheckUnavailable}`],
    ["request_invalid", `failed ${HOST_RUN_REASONS.grantCheckUnavailable}`],
    ["no_scope", `failed ${HOST_RUN_REASONS.grantCheckUnavailable}`],
    ["request_mismatch", `failed ${HOST_RUN_REASONS.grantCheckUnavailable}`],
  ];
  expect(new Set(cases.map(([reason]) => reason))).toEqual(
    new Set(ENFORCEMENT_DENIAL_REASONS),
  );
  for (const [reason, report] of cases) {
    const g = await started();
    g.claude.last.execution.check(shell);
    g.enforcementAnswer = reason;
    g.grantsChanged();
    expect(g.claude.last.execution.signal.aborted, reason).toBe(true);
    g.advance(STEP);
    expect(g.walk().at(-1), reason).toBe(`1 running>${report}`);
    expect(g.violations, reason).toEqual([]);
  }
});

test("without an enforcement point, every check of an executor denies", async () => {
  const h = new Harness({ runs: [run(1, "queued")], withoutEnforcement: true });
  await h.answerProviders();
  h.ack();
  expect(h.claude.last.execution.check({ capability: "provider.use" })).toEqual(
    { allowed: false, reason: "check_failed" },
  );
});

test("a sign-out aborts the run at once and reports it cancelled after the next sign-in and reload", async () => {
  const h = await started();
  const { execution } = h.claude.last;
  h.setAccount(SIGNED_OUT);
  expect(execution.signal.aborted).toBe(true);
  h.setConnection(OFFLINE);
  h.advance(60_000);
  expect(h.sent).toHaveLength(1);

  // The agent's next run waits for the aborted executor to settle.
  h.runs.push(run(2, "queued", { createdAfter: 60 }));
  h.setAccount(accountStatus());
  h.reconnect();
  h.advance(STEP);
  expect(h.walk()).toEqual([
    "1 queued>running",
    `1 running>cancelled ${HOST_RUN_REASONS.signedOut}`,
  ]);
  // A fresh model: a new event.
  expect(h.last.id).toBe(eventId(2));
  h.ackAndStep();
  expect(h.providerReads).toEqual([]);
  h.claude.calls[0]?.resolve({ outcome: "completed" });
  await settle();
  expect(h.providerReads).toHaveLength(1);
  await h.answerProviders();
  expect(h.walk().at(-1)).toBe("2 queued>running");
  expect(h.violations).toEqual([]);
});

test("a sign-out whose run the server already finished sends nothing after the reload", async () => {
  const h = await started();
  h.setAccount(SIGNED_OUT);
  h.setConnection(OFFLINE);
  // The server cancelled the run meanwhile (for example, a removal).
  h.setRun(runId(1), "cancelled");
  h.setAccount(accountStatus());
  h.reconnect();
  h.advance(10 * STEP);
  expect(h.sent).toHaveLength(1);
});

test("the end of the sign-in stops every run, reported cancelled, and nothing starts until a new sign-in moves it", async () => {
  // The sign-in ends one minute after the start, while the connection
  // stays open (the server's grace).
  const end = WALL_START + 60_000;
  const h = new Harness({
    runs: [run(1, "queued"), run(2, "queued", { agent: AGENT_B })],
    accountStatus: accountStatus(DEVICE_ID, end),
  });
  await h.answerProviders();
  h.ackAndStep();
  h.ack();
  expect(h.claude.calls).toHaveLength(2);
  h.advance(60_000 - h.time - 1);
  expect(h.claude.calls[0]?.execution.signal.aborted).toBe(false);
  h.advance(1);
  expect(h.claude.calls[0]?.execution.signal.aborted).toBe(true);
  expect(h.claude.calls[1]?.execution.signal.aborted).toBe(true);
  h.advance(STEP);
  h.ackAndStep();
  h.ackAndStep();
  expect(h.walk().slice(2).sort()).toEqual([
    `1 running>cancelled ${HOST_RUN_REASONS.signedOut}`,
    `2 running>cancelled ${HOST_RUN_REASONS.signedOut}`,
  ]);
  for (const call of h.claude.calls) {
    call.resolve({ outcome: "completed" });
  }
  await settle();

  // A queued run waits while the sign-in is over.
  h.runs.push(run(3, "queued", { createdAfter: 60 }));
  h.reload();
  h.advance(60_000);
  expect(h.providerReads).toEqual([]);
  // A new sign-in moves the end: the run goes.
  h.setAccount(accountStatus(DEVICE_ID, WALL_START + h.time + 60 * 60_000));
  expect(h.providerReads).toHaveLength(1);
  await h.answerProviders();
  expect(h.walk().at(-1)).toBe("3 queued>running");
  expect(h.violations).toEqual([]);
});

test("the timer of the end of the sign-in follows the account, waits in steps, and a start acknowledged after the end does not start", async () => {
  // A renewal before the end moves the timer.
  const h = await started();
  h.setAccount(accountStatus(DEVICE_ID, WALL_START + h.time + 1_000));
  h.setAccount(accountStatus(DEVICE_ID, WALL_START + h.time + 5_000));
  h.advance(4_999);
  expect(h.claude.last.execution.signal.aborted).toBe(false);
  h.advance(1);
  expect(h.claude.last.execution.signal.aborted).toBe(true);

  // An end far ahead waits in steps that read the account again.
  const g = await started();
  expect(
    g.openTimers().every((timer) => timer.at - g.time <= SIGN_IN_TIMER_STEP_MS),
  ).toBe(true);
  g.advance(SIGN_IN_TIMER_STEP_MS);
  expect(g.claude.last.execution.signal.aborted).toBe(false);
  g.advance(SIGN_IN_END - WALL_START - g.time);
  expect(g.claude.last.execution.signal.aborted).toBe(true);

  // A start that the sign-in's end overtook is reported, not started.
  const f = new Harness({
    runs: [run(1, "queued")],
    accountStatus: accountStatus(DEVICE_ID, WALL_START + 100),
  });
  await f.answerProviders();
  expect(f.walk()).toEqual(["1 queued>running"]);
  f.advance(100);
  f.ack();
  expect(f.claude.calls).toEqual([]);
  f.advance(STEP);
  expect(f.walk().at(-1)).toBe(
    `1 running>cancelled ${HOST_RUN_REASONS.signedOut}`,
  );
  expect(f.violations).toEqual([]);

  // An end that has passed, or cannot be read, starts nothing.
  const unreadable = accountStatus();
  for (const status of [
    accountStatus(DEVICE_ID, WALL_START - 1),
    Object.freeze({
      ...unreadable,
      account: Object.freeze({
        ...unreadable.account,
        signInExpiresAt: "not a time",
      }),
    }) as AccountStatus,
  ]) {
    const e = new Harness({ runs: [run(1, "queued")], accountStatus: status });
    e.advance(60_000);
    expect(e.providerReads).toEqual([]);
    expect(e.sent).toEqual([]);
  }

  // Close cancels the timer.
  const d = await started();
  d.supervisor.close();
  expect(d.openTimers()).toEqual([]);
});

test("another device drops every run without a report", async () => {
  const h = await started();
  h.setAccount(accountStatus(OTHER_DEVICE_ID));
  expect(h.claude.last.execution.signal.aborted).toBe(true);
  h.setAccount(accountStatus());
  h.reload();
  h.advance(STEP);
  // Back on this device, the run is only an interrupted one.
  expect(h.walk().at(-1)).toBe(
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  );
});

test("the server finishing a run aborts its execution and sends nothing", async () => {
  const h = await started();
  h.setRun(runId(1), "cancelled");
  h.changed();
  expect(h.claude.last.execution.signal.aborted).toBe(true);
  h.claude.last.resolve({ outcome: "completed" });
  await settle();
  h.advance(10 * STEP);
  expect(h.sent).toHaveLength(1);
});

// Interrupted runs.

test("after a reload, the running and awaiting runs that this process does not hold are reported failed", async () => {
  const h = new Harness({
    runs: [
      run(1, "running"),
      run(2, "awaiting_input", { agent: AGENT_B }),
      run(3, "queued"),
    ],
    executors: {},
  });
  expect(h.walk()).toEqual([
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  ]);
  h.ackAndStep();
  expect(h.walk()).toEqual([
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
    `2 awaiting_input>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  ]);
  h.ackAndStep();
  // The queued run waits: no executor is registered.
  h.reload();
  h.advance(10 * STEP);
  expect(h.sent).toHaveLength(2);
  expect(h.violations).toEqual([]);
});

test("an interrupted run is looked for only after a reload, and a run that the supervisor holds is none", async () => {
  const h = await started();
  h.reload();
  h.advance(10 * STEP);
  expect(h.sent).toHaveLength(1);
  expect(h.claude.last.execution.signal.aborted).toBe(false);
});

// Refusals.

test("a start refused with conflict is dropped, never retried, and the agent waits for the next reload", async () => {
  const h = new Harness({
    runs: [run(1, "queued"), run(2, "queued")],
  });
  await h.answerProviders();
  h.refuse("conflict");
  h.changed();
  h.advance(60_000);
  expect(h.walk()).toEqual(["1 queued>running"]);
  expect(h.providerReads).toEqual([]);
  expect(h.claude.calls).toEqual([]);
  // It asked for that reload.
  expect(h.reloadRequests).toEqual([RUN_SUPERVISOR_RELOAD_DELAY_MS]);

  // The reload brings the truth: still queued, so it is adopted again.
  h.reload();
  await h.answerProviders();
  expect(h.walk()).toEqual(["1 queued>running", "1 queued>running"]);
  expect(h.sent[1]?.id).not.toBe(h.sent[0]?.id);
  expect(h.violations).toEqual([]);
});

test("a start refused with rate_limited is sent again with a new event after the backoff", async () => {
  const h = new Harness({ runs: [run(1, "queued")] });
  await h.answerProviders();
  h.refuse("rate_limited");
  h.advance(RUN_SUPERVISOR_RETRY_DELAY_MS - 1);
  expect(h.sent).toHaveLength(1);
  h.advance(1);
  expect(h.walk()).toEqual(["1 queued>running", "1 queued>running"]);
  expect(h.sent[1]?.id).not.toBe(h.sent[0]?.id);
  h.ack();
  expect(h.claude.calls).toHaveLength(1);
  expect(h.violations).toEqual([]);

  // Each further rate_limited doubles the wait, up to its bound, until an
  // acknowledgement.
  const g = new Harness({ runs: [run(1, "queued")] });
  await g.answerProviders();
  const waits: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    const before = g.sent.length;
    const at = g.time;
    g.refuse("rate_limited");
    while (g.sent.length === before) {
      g.advance(1_000);
    }
    waits.push(g.time - at);
  }
  expect(waits).toEqual([
    RUN_SUPERVISOR_RETRY_DELAY_MS,
    2 * RUN_SUPERVISOR_RETRY_DELAY_MS,
    4 * RUN_SUPERVISOR_RETRY_DELAY_MS,
    RUN_SUPERVISOR_RETRY_MAX_MS,
    RUN_SUPERVISOR_RETRY_MAX_MS,
  ]);
  g.ack();
  expect(g.claude.calls).toHaveLength(1);

  // A run that the server moved on meanwhile is not sent again.
  const f = new Harness({ runs: [run(1, "queued")] });
  await f.answerProviders();
  f.refuse("rate_limited");
  f.setRun(runId(1), "cancelled");
  f.changed();
  f.advance(RUN_SUPERVISOR_RETRY_MAX_MS);
  expect(f.sent).toHaveLength(1);
  expect(f.violations).toEqual([]);
});

test("a completion refused with rate_limited is sent again later and never reported interrupted, and owed transitions survive it", async () => {
  const h = await started();
  h.claude.last.resolve({ outcome: "completed" });
  await settle();
  h.advance(STEP);
  expect(h.walk().at(-1)).toBe("1 running>completed");
  const first = h.last.id;
  h.refuse("rate_limited");
  // A reload during the backoff does not report the run as interrupted.
  h.reload();
  h.advance(RUN_SUPERVISOR_RETRY_DELAY_MS - 1);
  expect(h.sent).toHaveLength(2);
  h.advance(1);
  expect(h.walk()).toEqual([
    "1 queued>running",
    "1 running>completed",
    "1 running>completed",
  ]);
  expect(h.last.id).not.toBe(first);
  h.ackAndStep();
  h.reload();
  h.advance(60_000);
  expect(h.sent).toHaveLength(3);
  expect(h.runState(1)).toBe("completed");
  expect(h.violations).toEqual([]);

  // Two owed reports after a lost connection: the first is limited, the
  // second goes, and the first follows after the backoff.
  const g = new Harness({
    runs: [run(1, "queued"), run(2, "queued", { agent: AGENT_B })],
  });
  await g.answerProviders();
  g.ackAndStep();
  g.ack();
  expect(g.claude.calls).toHaveLength(2);
  g.setConnection(LOST);
  g.reconnect();
  g.advance(STEP);
  expect(g.walk().at(-1)).toBe(
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  );
  g.refuse("rate_limited");
  g.advance(STEP);
  expect(g.walk().at(-1)).toBe(
    `2 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  );
  g.ackAndStep();
  g.reload();
  g.advance(RUN_SUPERVISOR_RETRY_DELAY_MS);
  expect(g.walk().slice(2)).toEqual([
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
    `2 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  ]);
  g.ackAndStep();
  expect(g.runState(1)).toBe("failed");
  expect(g.runState(2)).toBe("failed");
  expect(g.violations).toEqual([]);
});

test("a run that waits for a reload while the connection stays open asks for one, after a backoff that doubles up to its bound", async () => {
  // No acknowledgement, twice: the start owes a report.
  const h = new Harness({ runs: [run(1, "queued")] });
  await h.answerProviders();
  h.advance(2 * HOST_RUN_ACK_TIMEOUT_MS);
  expect(h.sent).toHaveLength(2);
  const stoppedAt = h.time;
  h.advance(RUN_SUPERVISOR_RELOAD_DELAY_MS - 1);
  expect(h.reloadRequests).toEqual([]);
  h.advance(1);
  expect(h.reloadRequests).toEqual([
    stoppedAt + RUN_SUPERVISOR_RELOAD_DELAY_MS,
  ]);
  // One request, however long nothing else happens.
  h.advance(10 * RUN_SUPERVISOR_RELOAD_MAX_MS);
  expect(h.reloadRequests).toHaveLength(1);
  // The reload shows the start was not applied: the run goes again.
  h.reload();
  await h.answerProviders();
  expect(h.walk()).toEqual([
    "1 queued>running",
    "1 queued>running",
    "1 queued>running",
  ]);

  // A dropped run: the waits double with each request, up to the bound.
  const g = new Harness({ runs: [run(1, "queued")] });
  await g.answerProviders();
  const waits: number[] = [];
  for (let round = 0; round < 6; round += 1) {
    const at = g.time;
    g.refuse("conflict");
    g.advance(RUN_SUPERVISOR_RELOAD_MAX_MS);
    waits.push((g.reloadRequests.at(-1) ?? 0) - at);
    expect(g.reloadRequests).toHaveLength(round + 1);
    g.reload();
    await g.answerProviders();
  }
  expect(waits).toEqual([
    RUN_SUPERVISOR_RELOAD_DELAY_MS,
    2 * RUN_SUPERVISOR_RELOAD_DELAY_MS,
    4 * RUN_SUPERVISOR_RELOAD_DELAY_MS,
    8 * RUN_SUPERVISOR_RELOAD_DELAY_MS,
    RUN_SUPERVISOR_RELOAD_MAX_MS,
    RUN_SUPERVISOR_RELOAD_MAX_MS,
  ]);
  // An acknowledgement starts the backoff again.
  g.ackAndStep();
  g.claude.last.resolve({ outcome: "failed", reason: "provider_quota" });
  await settle();
  g.advance(STEP);
  const at = g.time;
  g.refuse("conflict");
  g.advance(RUN_SUPERVISOR_RELOAD_MAX_MS);
  expect(g.reloadRequests.at(-1)).toBe(at + RUN_SUPERVISOR_RELOAD_DELAY_MS);

  // A reload that comes first cancels the request.
  const f = new Harness({ runs: [run(1, "queued")] });
  await f.answerProviders();
  f.refuse("not_found");
  f.advance(RUN_SUPERVISOR_RELOAD_DELAY_MS - 1);
  f.reload();
  f.advance(RUN_SUPERVISOR_RELOAD_MAX_MS);
  expect(f.reloadRequests).toEqual([]);
  expect(h.violations).toEqual([]);
  expect(g.violations).toEqual([]);
  expect(f.violations).toEqual([]);
});

test("a refused completion is dropped; the reload reports the run as interrupted", async () => {
  const h = await started();
  h.claude.last.resolve({ outcome: "completed" });
  await settle();
  h.advance(STEP);
  h.refuse("conflict");
  h.advance(60_000);
  expect(h.sent).toHaveLength(2);
  h.reload();
  h.advance(STEP);
  expect(h.walk().at(-1)).toBe(
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  );
  expect(h.violations).toEqual([]);
});

test("a transition without an acknowledgement is sent once more, and held after that", async () => {
  const h = new Harness({ runs: [run(1, "queued")] });
  await h.answerProviders();
  h.advance(HOST_RUN_ACK_TIMEOUT_MS);
  expect(h.sent).toHaveLength(2);
  expect(h.sent[1]?.id).toBe(h.sent[0]?.id);
  h.advance(HOST_RUN_ACK_TIMEOUT_MS);
  expect(h.sent).toHaveLength(2);
  expect(h.claude.calls).toEqual([]);
  // The server did apply it: after the reload, the run is reported.
  h.setRun(runId(1), "running");
  h.reload();
  h.advance(STEP);
  expect(h.walk().at(-1)).toBe(
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  );
});

// The connection.

test("a lost connection aborts the run, and the report waits for the reconnect and the reload", async () => {
  const h = await started();
  h.setConnection(LOST);
  expect(h.claude.last.execution.signal.aborted).toBe(true);
  h.advance(60_000);
  expect(h.sent).toHaveLength(1);
  // Connected again, but not reloaded yet.
  h.setConnection(CONNECTED);
  h.changed();
  h.advance(60_000);
  expect(h.sent).toHaveLength(1);
  h.reload();
  h.advance(STEP);
  expect(h.walk().at(-1)).toBe(
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  );
  expect(h.violations).toEqual([]);
});

test("an outcome during a lost connection is owed and sent after the reload", async () => {
  const h = await started();
  h.setConnection(LOST);
  h.claude.last.resolve({ outcome: "completed" });
  await settle();
  // The abort came first: the run is reported interrupted.
  h.reconnect();
  h.advance(STEP);
  expect(h.walk().at(-1)).toBe(
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  );

  // A completion that waits for the pace when the connection is lost.
  const g = await started();
  g.claude.last.resolve({ outcome: "completed" });
  await settle();
  g.setConnection(LOST);
  g.reconnect();
  g.advance(STEP);
  expect(g.walk()).toEqual(["1 queued>running", "1 running>completed"]);
  expect(g.violations).toEqual([]);
});

test("a completion in flight when the connection is lost is sent again with a new event, only if the server did not apply it", async () => {
  const h = await started();
  h.claude.last.resolve({ outcome: "completed" });
  await settle();
  h.advance(STEP);
  expect(h.walk().at(-1)).toBe("1 running>completed");
  h.setConnection(LOST);
  h.reconnect();
  h.advance(STEP);
  expect(h.walk()).toEqual([
    "1 queued>running",
    "1 running>completed",
    "1 running>completed",
  ]);
  expect(h.sent[2]?.id).not.toBe(h.sent[1]?.id);

  // Applied before the loss: nothing more.
  const g = await started();
  g.claude.last.resolve({ outcome: "completed" });
  await settle();
  g.advance(STEP);
  g.setRun(runId(1), "completed");
  g.setConnection(LOST);
  g.reconnect();
  g.advance(10 * STEP);
  expect(g.sent).toHaveLength(2);
  expect(g.violations).toEqual([]);
});

test("a start in flight when the connection is lost: an applied one is reported, one not applied is adopted again", async () => {
  const h = new Harness({ runs: [run(1, "queued")] });
  await h.answerProviders();
  h.setRun(runId(1), "running");
  h.setConnection(LOST);
  h.reconnect();
  h.advance(STEP);
  expect(h.walk()).toEqual([
    "1 queued>running",
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  ]);
  expect(h.claude.calls).toEqual([]);

  const g = new Harness({ runs: [run(1, "queued")] });
  await g.answerProviders();
  g.setConnection(LOST);
  g.reconnect();
  await g.answerProviders();
  g.advance(STEP);
  expect(g.walk()).toEqual(["1 queued>running", "1 queued>running"]);
  expect(g.violations).toEqual([]);
});

// What the supervisor leaves alone.

test("no run of another device's agent, a disabled agent, or an agent whose host is unknown is adopted or reported", async () => {
  const h = new Harness({
    runs: [
      run(1, "queued", { agent: AGENT_FOREIGN }),
      run(2, "running", { agent: AGENT_FOREIGN }),
      run(3, "queued", { agent: AGENT_DISABLED }),
      run(4, "running", { agent: AGENT_DISABLED }),
      run(5, "queued", { agent: AGENT_UNKNOWN_HOST }),
      run(6, "awaiting_input", { agent: AGENT_UNKNOWN_HOST }),
    ],
  });
  h.reload();
  h.advance(60_000);
  expect(h.providerReads).toEqual([]);
  expect(h.sent).toEqual([]);
});

test("nothing happens outside the open project, and an owed transition waits for its own project", async () => {
  const none = new Harness({
    runs: [run(1, "queued"), run(2, "running", { agent: AGENT_B })],
    projectId: null,
  });
  none.advance(60_000);
  expect(none.providerReads).toEqual([]);
  expect(none.sent).toEqual([]);
  // Opening the project picks its runs up.
  none.openProject(PROJECT_1);
  none.advance(STEP);
  expect(none.walk()).toEqual([
    `2 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  ]);

  const h = await started();
  h.runs.push(
    run(9, "queued", { agent: AGENT_OTHER_PROJECT, project: PROJECT_2 }),
  );
  h.setConnection(LOST);
  h.setConnection(CONNECTED);
  h.openProject(PROJECT_2);
  // Project 2's own run is adopted; project 1's owed report waits.
  await h.answerProviders();
  h.advance(STEP);
  expect(h.walk()).toEqual(["1 queued>running", "9 queued>running"]);
  h.ackAndStep();
  h.openProject(PROJECT_1);
  h.advance(STEP);
  expect(h.walk().at(-1)).toBe(
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  );
  expect(h.violations).toEqual([]);
});

test("the development switch's agent is left alone, while the other agents run", async () => {
  const h = new Harness({
    runs: [
      run(1, "queued"),
      run(2, "running"),
      run(3, "queued", { agent: AGENT_B }),
    ],
    reserved: [AGENT_A],
  });
  await h.answerProviders();
  h.ack();
  h.reload();
  h.advance(60_000);
  expect(h.walk()).toEqual(["3 queued>running"]);
});

test("a sent transition always starts from the run's state on the server", async () => {
  // An interrupted run that the server cancels while the report waits for
  // the pace is not reported.
  const h = new Harness({
    runs: [run(1, "running"), run(2, "running", { agent: AGENT_B })],
    executors: {},
  });
  expect(h.walk()).toEqual([
    `1 running>failed ${HOST_RUN_REASONS.hostInterrupted}`,
  ]);
  h.ack();
  h.setRun(runId(2), "cancelled");
  h.changed();
  h.advance(10 * STEP);
  expect(h.sent).toHaveLength(1);

  // The same, when the list of finished runs does not show it: it only
  // left the unfinished runs.
  const f = new Harness({
    runs: [run(1, "running"), run(2, "running", { agent: AGENT_B })],
    executors: {},
  });
  f.ack();
  f.setRun(runId(2), "cancelled");
  f.unlistedFinished.add(runId(2));
  f.changed();
  f.advance(10 * STEP);
  expect(f.sent).toHaveLength(1);
  expect(f.violations).toEqual([]);

  // A queued run that the server cancelled after the read was asked for.
  const g = new Harness({ runs: [run(1, "queued")] });
  g.setRun(runId(1), "cancelled");
  await g.answerProviders();
  g.advance(10 * STEP);
  expect(g.sent).toEqual([]);
  expect(h.violations).toEqual([]);
  expect(g.violations).toEqual([]);
});

// The seam before a start.

test("beforeStart is asked with the held run immediately before each start, and may end the run instead", async () => {
  const asked: [RunId, number][] = [];
  let h: Harness | null = null;
  h = new Harness({
    runs: [run(1, "queued"), run(2, "queued", { agent: AGENT_B })],
    beforeStart: (held) => {
      asked.push([held.runId, h?.time ?? -1]);
      return held.agentId === AGENT_A
        ? { start: true }
        : { start: false, state: "cancelled", reason: "provider_use_denied" };
    },
  });
  await h.answerProviders();
  // Agent B's start waits behind agent A's for the pace: its hook is asked
  // only when it goes, not when it was decided.
  expect(asked).toEqual([[runId(1), 0]]);
  h.ackAndStep();
  expect(asked).toEqual([
    [runId(1), 0],
    [runId(2), STEP],
  ]);
  expect(h.walk()).toEqual([
    "1 queued>running",
    "2 queued>cancelled provider_use_denied",
  ]);

  // A start limited by the server asks the hook again before it goes.
  const times: number[] = [];
  let e: Harness | null = null;
  e = new Harness({
    runs: [run(1, "queued")],
    beforeStart: () => {
      times.push(e?.time ?? -1);
      return { start: true };
    },
  });
  await e.answerProviders();
  e.refuse("rate_limited");
  e.advance(RUN_SUPERVISOR_RETRY_DELAY_MS);
  expect(times).toEqual([0, RUN_SUPERVISOR_RETRY_DELAY_MS]);
  expect(e.walk()).toEqual(["1 queued>running", "1 queued>running"]);

  // A hook that throws sends nothing; the run waits for the next reload.
  const g = new Harness({
    runs: [run(1, "queued")],
    beforeStart: () => {
      throw new Error("broken");
    },
  });
  await g.answerProviders();
  g.advance(60_000);
  expect(g.sent).toEqual([]);
  expect(g.providerReads).toEqual([]);
  // It asked for the reload that the run waits for.
  expect(g.reloadRequests).toHaveLength(1);
});

test("an answer of beforeStart that is not a decision makes the run wait, and never crashes", async () => {
  const answers: unknown[] = [
    null,
    undefined,
    "start",
    1,
    true,
    { start: "true" },
    { start: false },
    { start: false, state: "completed", reason: "done" },
    new Proxy(
      {},
      {
        get: () => {
          throw new Error("trap");
        },
      },
    ),
  ];
  for (const [index, answer] of answers.entries()) {
    const label = `answer ${String(index)}`;
    const h = new Harness({
      runs: [run(1, "queued")],
      beforeStart: () => answer as RunStartDecision,
    });
    await h.answerProviders();
    h.advance(60_000);
    expect(h.sent, label).toEqual([]);
    expect(h.claude.calls, label).toEqual([]);
    expect(h.reloadRequests, label).toHaveLength(1);
  }
});

test("the reason of beforeStart is sent only when it is a code that the server does not give", async () => {
  const cases: [string, string | null][] = [
    ["provider_use_denied", "provider_use_denied"],
    // A host reason may be given before a start.
    [HOST_RUN_REASONS.grantInactive, HOST_RUN_REASONS.grantInactive],
    ["Denied for C:\\Users\\octocat", null],
    ["", null],
    ["x".repeat(65), null],
    ["agent_disabled", null],
    ["member_removed", null],
  ];
  for (const [reason, sent] of cases) {
    const h = new Harness({
      runs: [run(1, "queued")],
      beforeStart: () => ({ start: false, state: "failed", reason }),
    });
    await h.answerProviders();
    if (h.sent.length > 0) {
      h.ack();
    }
    h.advance(60_000);
    expect(h.walk(), reason).toEqual(
      sent === null ? [] : [`1 queued>failed ${sent}`],
    );
    expect(h.violations, reason).toEqual([]);
  }
});

// Close.

test("close aborts every execution, sends nothing more, and stops listening", async () => {
  const h = await started();
  h.supervisor.close();
  expect(h.claude.last.execution.signal.aborted).toBe(true);
  h.claude.last.resolve({ outcome: "completed" });
  await settle();
  h.reload();
  h.setConnection(LOST);
  h.reconnect();
  h.advance(60_000);
  expect(h.sent).toHaveLength(1);
  expect(h.agentListeners.size).toBe(0);
  expect(h.grantListeners.size).toBe(0);
  expect(h.accountListeners.size).toBe(0);
});

const moduleFolder = path.dirname(fileURLToPath(import.meta.url));

test("no log holds an ID or a name, and the files never log with console", () => {
  expect(allLogs.length).toBeGreaterThan(10);
  const text = allLogs.join("\n");
  for (const value of [
    DEVICE_ID,
    USER_ID,
    WS_A,
    AGENT_A,
    runId(1),
    "octocat",
  ]) {
    expect(text).not.toContain(value);
  }
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  for (const file of ["run-supervisor.ts", "run-executor.ts"]) {
    const source = readFileSync(path.join(moduleFolder, file), "utf8");
    expect(source).not.toMatch(/\bconsole\./);
  }
});
