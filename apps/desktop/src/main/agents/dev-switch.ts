// The development agent switch (#28, D2, D4, and D5, and the Project
// Manager's decisions of 2026-11-05): the test source of the agent activity
// until #35 lets agents run. In an unpackaged development build only, it
// moves the unfinished runs of the agent that `db:dev-seed` created through
// allowed transitions, as that agent, over the real connection.
//
// - It runs only when `devAgentSwitchSettings` finds the agent ID in
//   `MYMANDEV_DEV_AGENT_SWITCH` and the ID of the agent's host device, the
//   one passed to `db:dev-seed`, in `MYMANDEV_DEV_AGENT_DEVICE`. The agent
//   list never shows the host device, so the second variable is how the
//   switch knows it.
// - Before every send, it checks that the signed-in device is the host
//   device, that the open project lists the agent, that the agent is not
//   disabled, that its owner is the account's own person in the workspace,
//   and that the workspace service's and the agent activity service's gates
//   are live. Otherwise it waits: closing the project pauses it, and opening
//   it again resumes it.
// - It sends one transition at a time and waits for its acknowledgement, the
//   relayed transition with the same event ID (D4). The run states come from
//   the activity and from the acknowledgements, never from what was sent.
//   Without an acknowledgement within `DEV_SWITCH_ACK_TIMEOUT_MS`, it sends
//   the same event once more, which the server never applies twice, and then
//   stops. It stops at the first refusal, and on close.
// - At most one send every `DEV_SWITCH_STEP_MS`, resends included, and at
//   most `DEV_SWITCH_HOURLY_SENDS` in any hour, well below the account's
//   transition limit (D5).
//
// Every send goes through the connection client's `sendAs` with the agent
// actor. It has no IPC channel, so a packaged build sends nothing. The logs
// are fixed text with a code at most, never an ID.
import {
  AgentIdSchema,
  DeviceIdSchema,
  isTerminalRunState,
  newId,
  PROTOCOL_VERSION,
  type AgentId,
  type AgentRunStateChangedEvent,
  type DeviceId,
  type EventId,
  type RunId,
  type RunState,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { AccountStatus } from "../../shared/ipc-contract.ts";
import type { AccountService } from "../account.ts";
import type { ConnectionClient, ServerMessage } from "../connection/client.ts";
import type { ScheduleTimer } from "../runtime.ts";
import type { WorkspaceService } from "../workspace/service.ts";
import type { AgentActivityService, AgentActivityState } from "./service.ts";

/** Holds the agent ID that `db:dev-seed` printed. */
export const DEV_AGENT_SWITCH_VARIABLE = "MYMANDEV_DEV_AGENT_SWITCH";
/** Holds the device ID that was passed to `db:dev-seed`: the host device. */
export const DEV_AGENT_DEVICE_VARIABLE = "MYMANDEV_DEV_AGENT_DEVICE";

/** The shortest time between two sends, resends included. */
export const DEV_SWITCH_STEP_MS = 2_000;
/** How long a send waits for its acknowledgement. */
export const DEV_SWITCH_ACK_TIMEOUT_MS = 10_000;
/**
 * The most sends in any hour: half of the account's 1,800, so that its
 * other devices keep room. One send every 2 seconds is at most 5 in any 10
 * seconds, against the account's 30.
 */
export const DEV_SWITCH_HOURLY_SENDS = 900;
const HOUR_MS = 60 * 60_000;

export interface DevAgentSwitchSettings {
  readonly agentId: AgentId;
  readonly hostDeviceId: DeviceId;
}

/**
 * The switch's settings, or null when it stays off: in a packaged build,
 * without `MYMANDEV_DEV_AGENT_SWITCH` (unset or empty), and, with a fixed
 * message to `log`, when a variable does not hold an ID of its kind.
 */
export function devAgentSwitchSettings(
  isPackaged: boolean,
  env: Readonly<Record<string, string | undefined>>,
  log: (message: string) => void,
): DevAgentSwitchSettings | null {
  if (isPackaged) {
    return null;
  }
  const agent = env[DEV_AGENT_SWITCH_VARIABLE];
  if (agent === undefined || agent === "") {
    return null;
  }
  const agentId = AgentIdSchema.safeParse(agent);
  if (!agentId.success) {
    log(
      `The development agent switch is off: ${DEV_AGENT_SWITCH_VARIABLE} does not hold an agent ID.`,
    );
    return null;
  }
  const hostDeviceId = DeviceIdSchema.safeParse(env[DEV_AGENT_DEVICE_VARIABLE]);
  if (!hostDeviceId.success) {
    log(
      `The development agent switch is off: ${DEV_AGENT_DEVICE_VARIABLE} does not hold a device ID.`,
    );
    return null;
  }
  return Object.freeze({
    agentId: agentId.data,
    hostDeviceId: hostDeviceId.data,
  });
}

/** The part of the account service that the switch uses. */
export type DevSwitchAccount = Pick<
  AccountService,
  "status" | "onStatusChange"
>;
/** The part of the connection client that the switch uses. */
export type DevSwitchConnection = Pick<
  ConnectionClient,
  "sendAs" | "onMessage"
>;
/** The part of the workspace service that the switch uses. */
export type DevSwitchWorkspaces = Pick<
  WorkspaceService,
  "onChange" | "gateLive" | "ownMemberId"
>;
/** The part of the agent activity service that the switch uses. */
export type DevSwitchAgents = Pick<
  AgentActivityService,
  "state" | "onChange" | "gateLive"
>;

export interface DevAgentSwitchOptions {
  readonly settings: DevAgentSwitchSettings;
  readonly account: DevSwitchAccount;
  readonly connection: DevSwitchConnection;
  readonly workspaces: DevSwitchWorkspaces;
  readonly agents: DevSwitchAgents;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** A monotonic clock in milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  /** The wall clock in milliseconds, for `occurredAt`; defaults to `Date.now`. */
  readonly wallClock?: () => number;
  /** Defaults to a new UUIDv7. */
  readonly newEventId?: () => EventId;
  /**
   * Receives fixed messages with a code at most, never an ID. An error that
   * it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface DevAgentSwitch {
  /** Stops listening and cancels the timers, for the quit. */
  readonly close: () => void;
}

/** A transition that the agent's host device sends. */
type Transition = Omit<AgentRunStateChangedEvent, "deviceId">;

/** A sent transition that waits for its acknowledgement. */
interface Pending {
  readonly transition: Transition;
  /** Whether it was sent a second time. */
  resent: boolean;
  /** Its acknowledgement timed out, and the resend waits for the guards. */
  resendDue: boolean;
}

/** Why the switch does not send now. */
type Notice =
  "moving" | "waiting" | "no_runs" | "not_host" | "not_owner" | "disabled";

const NOTICES = Object.freeze({
  moving: "The development agent switch moves the agent's runs.",
  waiting:
    "The development agent switch waits for the agent's project to open and load.",
  no_runs: "The development agent switch has no unfinished run to move.",
  not_host:
    "The development agent switch waits: this device does not host the agent.",
  not_owner:
    "The development agent switch waits: the signed-in person does not own the agent.",
  disabled: "The development agent switch waits: the agent is disabled.",
} satisfies Record<Notice, string>);

/** The signed-in device, or null, under the same condition as the services. */
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

/**
 * The walk of a run: `queued`, `running`, `awaiting_input`, `running`, and
 * `completed`. `awaited` tells whether an acknowledgement already showed the
 * run in `awaiting_input`. Null for a finished run.
 */
function nextState(state: RunState, awaited: boolean): RunState | null {
  switch (state) {
    case "queued":
      return "running";
    case "running":
      return awaited ? "completed" : "awaiting_input";
    case "awaiting_input":
      return "running";
    case "completed":
    case "failed":
    case "cancelled":
      return null;
  }
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export function createDevAgentSwitch(
  options: DevAgentSwitchOptions,
): DevAgentSwitch {
  const { account, connection, workspaces, agents } = options;
  const { agentId, hostDeviceId } = options.settings;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const now = options.now ?? (() => performance.now());
  const wallClock = options.wallClock ?? (() => Date.now());
  const newEventId = options.newEventId ?? (() => newId<EventId>());

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  let stopped = false;
  let pending: Pending | null = null;
  /** The run states that the acknowledgements reported. */
  const acknowledged = new Map<RunId, RunState>();
  /** The runs that an acknowledgement showed in `awaiting_input`. */
  const awaited = new Set<RunId>();
  /** The monotonic times of the sends of the last hour, the oldest first. */
  const sendTimes: number[] = [];
  let cancelStep: (() => void) | null = null;
  let cancelAck: (() => void) | null = null;
  let lastNotice: Notice | null = null;

  function notice(next: Notice): void {
    if (next !== lastNotice) {
      lastNotice = next;
      log(NOTICES[next]);
    }
  }

  function stopTimers(): void {
    cancelStep?.();
    cancelStep = null;
    cancelAck?.();
    cancelAck = null;
  }

  function stop(message: string): void {
    stopped = true;
    pending = null;
    stopTimers();
    removeListeners();
    log(message);
  }

  /**
   * The open project's activity and workspace when every guard holds, or
   * why not.
   */
  function guard():
    | { readonly workspaceId: WorkspaceId; readonly state: AgentActivityState }
    | Notice {
    const device = signedInDevice(account.status());
    if (device === null) {
      return "waiting";
    }
    if (device !== hostDeviceId) {
      return "not_host";
    }
    const state = agents.state();
    const { workspaceId } = state;
    const agent = state.agents.find((item) => item.id === agentId);
    if (
      state.status !== "ready" ||
      workspaceId === null ||
      agent === undefined
    ) {
      return "waiting";
    }
    if (agent.disabledAt !== null) {
      return "disabled";
    }
    if (workspaces.ownMemberId(workspaceId) !== agent.ownerMemberId) {
      return "not_owner";
    }
    if (!agents.gateLive() || !workspaces.gateLive(workspaceId)) {
      return "waiting";
    }
    return { workspaceId, state };
  }

  /** The next step of the agent's oldest unfinished run, or null. */
  function nextStep(state: AgentActivityState): Transition["payload"] | null {
    // The unfinished runs come the most recently created first.
    const runs = state.unfinishedRuns.filter((run) => run.agentId === agentId);
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index];
      if (run === undefined) {
        continue;
      }
      const previousState = acknowledged.get(run.id) ?? run.state;
      const next = nextState(previousState, awaited.has(run.id));
      if (next === null) {
        continue;
      }
      return Object.freeze({
        runId: run.id,
        agentId,
        previousState,
        state: next,
      });
    }
    return null;
  }

  /** How long the next send must wait for the pace and the hourly budget. */
  function sendDelay(at: number): number {
    while (sendTimes.length > 0 && at - (sendTimes[0] ?? at) >= HOUR_MS) {
      sendTimes.shift();
    }
    const last = sendTimes.at(-1);
    let delay = last === undefined ? 0 : last + DEV_SWITCH_STEP_MS - at;
    if (sendTimes.length >= DEV_SWITCH_HOURLY_SENDS) {
      delay = Math.max(delay, (sendTimes[0] ?? at) + HOUR_MS - at);
    }
    return Math.max(0, delay);
  }

  /**
   * Whether the next send must wait for the pace or the hourly budget; the
   * wait is then scheduled.
   */
  function mustWait(): boolean {
    const delay = sendDelay(now());
    if (delay <= 0) {
      return false;
    }
    cancelStep ??= schedule(() => {
      cancelStep = null;
      evaluate();
    }, delay);
    return true;
  }

  /** Sends what is due, or waits for a guard, the pace, or the budget. */
  function evaluate(): void {
    if (closed || stopped) {
      return;
    }
    if (pending !== null && !pending.resendDue) {
      // It waits for the acknowledgement.
      return;
    }
    const target = guard();
    if (typeof target === "string") {
      notice(target);
      return;
    }
    if (pending === null) {
      const step = nextStep(target.state);
      if (step === null) {
        notice("no_runs");
        return;
      }
      notice("moving");
      if (mustWait()) {
        return;
      }
      // The event gets its ID and its time only when it is sent.
      pending = {
        transition: Object.freeze({
          protocolVersion: PROTOCOL_VERSION,
          id: newEventId(),
          type: "agent.run.state_changed",
          occurredAt: new Date(wallClock()).toISOString(),
          workspaceId: target.workspaceId,
          actor: Object.freeze({ kind: "agent", agentId }),
          payload: step,
        }),
        resent: false,
        resendDue: false,
      };
    } else {
      notice("moving");
      if (mustWait()) {
        return;
      }
      pending.resent = true;
      pending.resendDue = false;
    }
    transmit(pending.transition);
  }

  function transmit(transition: Transition): void {
    const outcome = connection.sendAs((identity) => {
      // The server closes the connection for an agent that another device
      // hosts, so the identity of the socket is checked as well.
      if (identity.deviceId !== hostDeviceId) {
        throw new Error("This device does not host the agent.");
      }
      return { ...transition, deviceId: identity.deviceId };
    });
    if (outcome !== "sent") {
      stop(
        `The development agent switch stopped: a transition was not sent (${outcome}).`,
      );
      return;
    }
    sendTimes.push(now());
    cancelAck = schedule(() => {
      cancelAck = null;
      acknowledgementTimedOut();
    }, DEV_SWITCH_ACK_TIMEOUT_MS);
  }

  function acknowledgementTimedOut(): void {
    if (pending === null) {
      return;
    }
    if (pending.resent) {
      stop(
        "The development agent switch stopped: a transition got no acknowledgement.",
      );
      return;
    }
    log(
      "A transition got no acknowledgement; the development agent switch sends it once more.",
    );
    pending.resendDue = true;
    evaluate();
  }

  function messageReceived(message: ServerMessage): void {
    if (closed || stopped || pending === null) {
      return;
    }
    const sent = pending.transition;
    if (message.kind === "frame") {
      if (
        message.frame.type === "event.refused" &&
        message.frame.eventId === sent.id
      ) {
        stop(
          `The development agent switch stopped: a transition was refused (${message.frame.code}).`,
        );
      }
      return;
    }
    const event = message.event;
    if (
      event.type !== "agent.run.state_changed" ||
      event.id !== sent.id ||
      event.workspaceId !== sent.workspaceId ||
      event.actor.kind !== "agent" ||
      event.actor.agentId !== agentId ||
      event.payload.runId !== sent.payload.runId
    ) {
      return;
    }
    // The acknowledgement: its payload is the run's state from now on.
    const { runId, state } = event.payload;
    acknowledged.set(runId, state);
    if (state === "awaiting_input") {
      awaited.add(runId);
    } else if (isTerminalRunState(state)) {
      awaited.delete(runId);
    }
    pending = null;
    cancelAck?.();
    cancelAck = null;
    evaluate();
  }

  const removers = [
    account.onStatusChange(() => evaluate()),
    workspaces.onChange(() => evaluate()),
    agents.onChange(() => evaluate()),
    connection.onMessage((message) => messageReceived(message)),
  ];

  function removeListeners(): void {
    for (const remove of removers.splice(0)) {
      remove();
    }
  }

  evaluate();

  return Object.freeze({
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      pending = null;
      stopTimers();
      removeListeners();
    },
  });
}
