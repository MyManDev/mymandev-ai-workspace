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
//   it again resumes it; a sign-out pauses it the same way.
// - It sends through the model of a hosted run (`host-run.ts`, #35), one
//   model for the run that it walks: one transition at a time, each waiting
//   for its acknowledgement, the relayed transition with the same event ID
//   (D4). The run states come from the activity and from the
//   acknowledgements, never from what was sent. Without an acknowledgement
//   within `DEV_SWITCH_ACK_TIMEOUT_MS` while the connection stays open, it
//   sends the same event once more, which the server never applies twice,
//   and then stops.
// - It stops for good at the first refusal and at the first close or loss of
//   the open connection (decided on 2026-11-05: "It stops at the first
//   refusal or close"), and a reconnect does not resume it, so nothing is
//   sent again after a close. Only the client's own close for the account,
//   `offline` after a sign-out, pauses it, unless a transition waits for its
//   acknowledgement.
// - At most one send every `DEV_SWITCH_STEP_MS`, resends included, and at
//   most `DEV_SWITCH_HOURLY_SENDS` in any hour, well below the account's
//   transition limits that the Project Manager approved on 2026-11-05 (30 in
//   any 10 seconds and 1,800 in an hour).
//
// Every send goes through the connection client's `sendAs` with the agent
// actor, from the model. It has no IPC channel, so a packaged build sends nothing. The logs
// are fixed text with a code at most, never an ID.
import {
  AgentIdSchema,
  DeviceIdSchema,
  isTerminalRunState,
  newId,
  type AgentId,
  type DeviceId,
  type EventId,
  type RunId,
  type RunState,
  type WorkspaceId,
} from "@mymandev/protocol";
import type {
  AccountStatus,
  ConnectionStatus,
} from "../../shared/ipc-contract.ts";
import type { AccountService } from "../account.ts";
import type { ConnectionClient } from "../connection/client.ts";
import type { ScheduleTimer } from "../runtime.ts";
import type { WorkspaceService } from "../workspace/service.ts";
import {
  createHostRun,
  HOST_RUN_ACK_TIMEOUT_MS,
  type HostRun,
  type HostRunSendResult,
  type HostRunState,
} from "./host-run.ts";
import type { AgentActivityService, AgentActivityState } from "./service.ts";

/** Holds the agent ID that `db:dev-seed` printed. */
export const DEV_AGENT_SWITCH_VARIABLE = "MYMANDEV_DEV_AGENT_SWITCH";
/** Holds the device ID that was passed to `db:dev-seed`: the host device. */
export const DEV_AGENT_DEVICE_VARIABLE = "MYMANDEV_DEV_AGENT_DEVICE";

/** The shortest time between two sends, resends included. */
export const DEV_SWITCH_STEP_MS = 2_000;
/** How long a send waits for its acknowledgement. */
export const DEV_SWITCH_ACK_TIMEOUT_MS = HOST_RUN_ACK_TIMEOUT_MS;
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
  "sendAs" | "onMessage" | "status" | "onStatusChange"
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

/** The next transition of the walk. */
interface Step {
  readonly runId: RunId;
  readonly previousState: RunState;
  readonly state: RunState;
}

/** Why the switch does not send now. */
type Notice =
  | "moving"
  | "waiting"
  | "not_signed_in"
  | "not_listed"
  | "no_runs"
  | "not_host"
  | "not_owner"
  | "disabled";

const NOTICES = Object.freeze({
  moving: "The development agent switch moves the agent's runs.",
  waiting:
    "The development agent switch waits for the agent's project to open and load.",
  not_signed_in:
    "The development agent switch waits: this device is not signed in and ready.",
  not_listed:
    "The development agent switch waits: the open project does not list the agent.",
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
  /** The model of the run that the switch walks, and its workspace. */
  let current: {
    readonly run: HostRun;
    readonly workspaceId: WorkspaceId;
  } | null = null;
  /** The run states that the acknowledgements reported. */
  const acknowledged = new Map<RunId, RunState>();
  /** The runs that an acknowledgement showed in `awaiting_input`. */
  const awaited = new Set<RunId>();
  /** The monotonic times of the sends of the last hour, the oldest first. */
  const sendTimes: number[] = [];
  let cancelStep: (() => void) | null = null;
  let lastNotice: Notice | null = null;
  /** Whether the connection's last status was `connected`. */
  let connected = connection.status().state === "connected";

  function notice(next: Notice): void {
    if (next !== lastNotice) {
      lastNotice = next;
      log(NOTICES[next]);
    }
  }

  /** The phase of the current run's model, or null without one. */
  function phase(): HostRunState["phase"] | null {
    return current?.run.state().phase ?? null;
  }

  /** Whether a sent transition waits for its acknowledgement. */
  function waitsForAcknowledgement(): boolean {
    const at = phase();
    return at === "awaiting_ack" || at === "resend_due";
  }

  function releaseRun(): void {
    current?.run.close();
    current = null;
  }

  function stopTimers(): void {
    cancelStep?.();
    cancelStep = null;
  }

  function stop(message: string): void {
    stopped = true;
    releaseRun();
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
      return "not_signed_in";
    }
    if (device !== hostDeviceId) {
      return "not_host";
    }
    const state = agents.state();
    const { workspaceId } = state;
    if (state.status !== "ready" || workspaceId === null) {
      return "waiting";
    }
    const agent = state.agents.find((item) => item.id === agentId);
    if (agent === undefined) {
      return "not_listed";
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
  function nextStep(state: AgentActivityState): Step | null {
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
      return { runId: run.id, previousState, state: next };
    }
    return null;
  }

  /**
   * The model for the step's run: the current one while it is idle in the
   * step's workspace with the step's state, otherwise a new one.
   */
  function runFor(workspaceId: WorkspaceId, step: Step): HostRun {
    if (
      current !== null &&
      current.workspaceId === workspaceId &&
      current.run.runId === step.runId
    ) {
      const state = current.run.state();
      if (state.phase === "idle" && state.runState === step.previousState) {
        return current.run;
      }
    }
    releaseRun();
    const run: HostRun = createHostRun({
      workspaceId,
      agentId,
      hostDeviceId,
      runId: step.runId,
      runState: step.previousState,
      connection,
      ackTimeoutMs: DEV_SWITCH_ACK_TIMEOUT_MS,
      scheduleTimer: schedule,
      wallClock,
      newEventId,
      onChange: (state) => runChanged(run, state),
    });
    current = { run, workspaceId };
    return run;
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

  /** Counts a send, or stops the switch for one that the model refused. */
  function sendResult(result: HostRunSendResult): void {
    if (result === "sent") {
      sendTimes.push(now());
    } else if (result !== "stopped") {
      // The walk only asks for allowed transitions without a reason, so
      // this does not happen; the model's own stop has its report.
      stop(
        `The development agent switch stopped: a transition was not sent (${result}).`,
      );
    }
  }

  /** Sends what is due, or waits for a guard, the pace, or the budget. */
  function evaluate(): void {
    if (closed || stopped) {
      return;
    }
    const due = phase();
    if (due === "awaiting_ack") {
      // It waits for the acknowledgement.
      return;
    }
    const target = guard();
    if (typeof target === "string") {
      notice(target);
      return;
    }
    if (due === "resend_due" && current !== null) {
      notice("moving");
      if (mustWait()) {
        return;
      }
      sendResult(current.run.resend());
      return;
    }
    const step = nextStep(target.state);
    if (step === null) {
      notice("no_runs");
      return;
    }
    notice("moving");
    if (mustWait()) {
      return;
    }
    sendResult(runFor(target.workspaceId, step).transition(step.state));
  }

  /** What the model of the walked run reported. */
  function runChanged(run: HostRun, state: HostRunState): void {
    if (closed || stopped || current?.run !== run) {
      return;
    }
    switch (state.phase) {
      case "idle": {
        // The acknowledgement: its payload is the run's state from now on.
        acknowledged.set(run.runId, state.runState);
        if (state.runState === "awaiting_input") {
          awaited.add(run.runId);
        } else if (isTerminalRunState(state.runState)) {
          awaited.delete(run.runId);
        }
        evaluate();
        return;
      }
      case "resend_due":
        log(
          "A transition got no acknowledgement; the development agent switch sends it once more.",
        );
        evaluate();
        return;
      case "stopped":
        runStopped(state);
        return;
      case "awaiting_ack":
      case "closed":
        return;
    }
  }

  function runStopped(state: HostRunState): void {
    const reason = state.stop;
    if (reason === null) {
      return;
    }
    switch (reason.cause) {
      case "refused":
        stop(
          `The development agent switch stopped: a transition was refused (${reason.code}).`,
        );
        return;
      case "no_acknowledgement":
        stop(
          "The development agent switch stopped: a transition got no acknowledgement.",
        );
        return;
      case "not_sent":
        stop(
          `The development agent switch stopped: a transition was not sent (${reason.code}).`,
        );
        return;
      case "signed_out":
        if (state.unacknowledged === null) {
          // A sign-out with nothing waiting pauses the switch; the walk
          // goes on with a new model once the guards hold again.
          current = null;
          return;
        }
        stop(
          `The development agent switch stopped: the connection closed (${reason.code}).`,
        );
        return;
      case "connection_closed":
        stop(
          `The development agent switch stopped: the connection closed (${reason.code}).`,
        );
        return;
    }
  }

  /**
   * Any close or loss of the open connection stops the switch for good
   * (decided on 2026-11-05: "It stops at the first refusal or close"),
   * whether a transition waits or not: a close of the server, which the
   * client reports as `waiting` or `stopped` with any reason, and the
   * client's own close and reopen, which it reports as `connecting`. A
   * transition that waited may have been applied, and it is never sent
   * again after a close. Only the client's close for the account, `offline`
   * after a sign-out, a removal, or a key that is not ready, pauses the
   * switch like the account guard, unless a transition waits. A connection
   * that was not open yet, such as a first attempt that fails, changes
   * nothing. The run's model stops on the same closes; whichever hears of
   * a close first, the switch stops once.
   */
  function connectionChanged(status: ConnectionStatus): void {
    const wasConnected = connected;
    connected = status.state === "connected";
    if (closed || stopped || !wasConnected || connected) {
      return;
    }
    if (status.state === "offline" && !waitsForAcknowledgement()) {
      return;
    }
    const code =
      "reason" in status && status.reason !== undefined
        ? status.reason
        : status.state;
    stop(
      `The development agent switch stopped: the connection closed (${code}).`,
    );
  }

  const removers = [
    account.onStatusChange(() => evaluate()),
    connection.onStatusChange((status) => connectionChanged(status)),
    workspaces.onChange(() => evaluate()),
    agents.onChange(() => evaluate()),
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
      releaseRun();
      stopTimers();
      removeListeners();
    },
  });
}
