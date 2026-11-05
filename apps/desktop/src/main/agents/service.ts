// The agent activity service (#28): the agents and runs of the workspace
// service's open project, in the main process. It reads them over HTTP with
// the account service's `readWorkspaceData`, holds them in the pure model of
// `activity.ts`, and keeps them current with the run events of the selected
// workspace.
//
// - The service owns its own resync gate. After each `workspace.subscribed`
//   of the selected workspace, and whenever another project opens, it
//   reloads the open project: first its runs, then its agents, so that the
//   agent list is never older than the runs. The events that arrived
//   meanwhile apply after the reload, in order.
// - A server cancellation that disabled agents (the model's `agentsStale`),
//   `workspace.member.removed`, and `account.device_revoked` reload the
//   agent list alone. An event for
//   a run of a listed agent that the activity does not hold (`unknown_run`)
//   reloads everything, at most once for each reload, so that data that
//   stays inconsistent does not reload in a loop. Both wait a moment, so
//   that a burst of events reloads once.
// - One reload runs at a time. A failed reload is retried with the
//   workspace service's backoff.
// - A sign-out, another device, another workspace, or another project clears
//   the activity and drops the answers on their way.
//
// The service never sends an event. Its state holds no person's name, only
// member IDs, which the IPC resolves with the workspace service's
// `memberName`. The logs are fixed text with a failure code at most, never a
// name or an ID.
import type {
  AgentListItem,
  AgentListResponse,
  AgentRunListItem,
  AgentRunListResponse,
  ProjectId,
  ReceivedServerEvent,
  WorkspaceId,
} from "@mymandev/protocol";
import type { AccountStatus } from "../../shared/ipc-contract.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { ConnectionClient, ServerMessage } from "../connection/client.ts";
import type { ScheduleTimer } from "../runtime.ts";
import {
  createResyncGate,
  type ResyncGeneration,
  type ResyncReload,
  type ResyncScope,
} from "../workspace/resync.ts";
import {
  workspaceRetryDelayMs,
  type WorkspaceAccount,
  type WorkspaceService,
  type WorkspaceState,
} from "../workspace/service.ts";
import {
  activityFromSnapshot,
  applyRunEvent,
  replaceAgents,
  type ActivitySnapshotResult,
  type ProjectActivity,
} from "./activity.ts";

/**
 * How long a reload that events asked for waits, so that a burst of them,
 * such as the cancellations of a removed person's runs, reloads once.
 */
export const AGENT_FOLLOW_UP_DELAY_MS = 1_000;

/**
 * - `no_project`: no project is open, or no device is signed in; the state
 *   is empty.
 * - `loading`: the open project's activity has not loaded yet.
 * - `ready`: it loaded. It stays `ready` during later reloads.
 * - `unavailable`: the last reload failed; `problem` holds the failure
 *   until a reload succeeds (a retry waits, or the next
 *   `workspace.subscribed` reloads). What was loaded before stays.
 */
export type AgentActivityStatus =
  "no_project" | "loading" | "ready" | "unavailable";

/** The service's state. Every value is frozen. */
export interface AgentActivityState {
  /** Grows by one with every change. */
  readonly revision: number;
  readonly status: AgentActivityStatus;
  /** Only with `unavailable`. */
  readonly problem?: WorkspaceReadFailure;
  /** The selected workspace while a project is open, else null. */
  readonly workspaceId: WorkspaceId | null;
  readonly projectId: ProjectId | null;
  /**
   * The open project's agents, disabled ones included, in the server's
   * order. An agent's owner is a member ID, never a name.
   */
  readonly agents: readonly AgentListItem[];
  /** The unfinished runs, the most recently created first. */
  readonly unfinishedRuns: readonly AgentRunListItem[];
  /** The recently finished runs, the most recently finished first. */
  readonly finishedRuns: readonly AgentRunListItem[];
}

/**
 * The part of the connection client that the agent service uses. It holds
 * no way to send.
 */
export type AgentConnection = Pick<
  ConnectionClient,
  "status" | "onStatusChange" | "onMessage"
>;

/** The part of the workspace service that the agent service uses. */
export type AgentWorkspaces = Pick<WorkspaceService, "state" | "onChange">;

export interface AgentActivityServiceOptions {
  readonly account: WorkspaceAccount;
  readonly connection: AgentConnection;
  readonly workspaces: AgentWorkspaces;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /**
   * Receives fixed messages with a failure code at most, never a name or an
   * ID. An error that it throws is ignored.
   */
  readonly log?: (message: string) => void;
}

export interface AgentActivityService {
  /** The current state. */
  readonly state: () => AgentActivityState;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onChange: (
    listener: (state: AgentActivityState) => void,
  ) => () => void;
  /** Stops listening and cancels the timers, for the quit. */
  readonly close: () => void;
}

/** The events that this service passes through its gate. */
export type AgentEvent = Extract<
  ReceivedServerEvent,
  { type: "agent.run.state_changed" | "workspace.member.removed" }
>;

function isAgentEvent(event: ReceivedServerEvent): event is AgentEvent {
  return (
    event.type === "agent.run.state_changed" ||
    event.type === "workspace.member.removed"
  );
}

/**
 * The signed-in device, or null, under the same condition as the workspace
 * service. The device ID is only compared; it never reaches the state or a
 * log.
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

/** One reload that was sent, with what it was sent for. */
interface ReloadRequest {
  readonly epoch: number;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly generation: ResyncGeneration;
  readonly scope: ResyncScope;
}

const NO_AGENTS: readonly AgentListItem[] = Object.freeze([]);
const NO_RUNS: readonly AgentRunListItem[] = Object.freeze([]);

export function createAgentActivityService(
  options: AgentActivityServiceOptions,
): AgentActivityService {
  const { account, connection, workspaces } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;

  function log(message: string): void {
    try {
      options.log?.(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  let closed = false;
  /** The signed-in device, compared only; see `signedInDevice`. */
  let device: string | null = null;
  /** Changes with every reset, so that an answer for an earlier device is dropped. */
  let epoch = 0;
  let connected = false;

  let workspaceId: WorkspaceId | null = null;
  let projectId: ProjectId | null = null;
  const gate = createResyncGate<AgentEvent>({
    sizeOf: (event) => Buffer.byteLength(JSON.stringify(event), "utf8"),
  });
  let activity: ProjectActivity | null = null;
  let problem: WorkspaceReadFailure | null = null;
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;

  /** A reload that began and waits for the one in flight. */
  let wanted: ResyncReload | null = null;
  let inFlight = false;
  /** The generation of the last reload that applied. */
  let applied: ResyncGeneration | null = null;
  /** The generation of the last reload that an `unknown_run` began. */
  let unknownRunReload: ResyncGeneration | null = null;

  /**
   * Whether the waiting follow-up reloads everything rather than the agents
   * alone; see `AGENT_FOLLOW_UP_DELAY_MS`.
   */
  let followUpAll = false;
  let cancelFollowUp: (() => void) | null = null;

  let revision = 0;
  let dirty = false;
  let current = buildState();
  const listeners = new Set<(state: AgentActivityState) => void>();

  function buildState(): AgentActivityState {
    const base = {
      revision,
      workspaceId: projectId === null ? null : workspaceId,
      projectId,
      agents: activity?.agents ?? NO_AGENTS,
      unfinishedRuns: activity?.unfinishedRuns ?? NO_RUNS,
      finishedRuns: activity?.finishedRuns ?? NO_RUNS,
    };
    if (projectId === null) {
      return Object.freeze({ ...base, status: "no_project" });
    }
    if (problem !== null) {
      return Object.freeze({ ...base, status: "unavailable", problem });
    }
    return Object.freeze({
      ...base,
      status: activity === null ? "loading" : "ready",
    });
  }

  function touch(): void {
    dirty = true;
  }

  function flush(): void {
    if (!dirty || closed) {
      return;
    }
    dirty = false;
    revision += 1;
    const state = buildState();
    current = state;
    for (const listener of [...listeners]) {
      // A listener that changed the state again has notified everyone of
      // the newer state already.
      if (current !== state) {
        return;
      }
      try {
        listener(state);
      } catch {
        log("An agent activity state listener failed.");
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

  function stopRetry(): void {
    cancelRetry?.();
    cancelRetry = null;
  }

  function stopFollowUp(): void {
    cancelFollowUp?.();
    cancelFollowUp = null;
    followUpAll = false;
  }

  /** Forgets the open project's activity and every reload of it. */
  function clearProject(): void {
    if (projectId !== null) {
      touch();
    }
    stopRetry();
    stopFollowUp();
    activity = null;
    problem = null;
    attempt = 0;
    wanted = null;
    applied = null;
    unknownRunReload = null;
  }

  /** Forgets everything: a sign-out, or another device. */
  function reset(): void {
    epoch += 1;
    // The answer of the reload in flight is dropped by the epoch, so the
    // next reload need not wait for it.
    inFlight = false;
    gate.end();
    clearProject();
    workspaceId = null;
    projectId = null;
  }

  /** Follows the workspace service's selected workspace and open project. */
  function follow(state: WorkspaceState): void {
    const nextWorkspace = device === null ? null : state.selectedWorkspaceId;
    const nextProject = nextWorkspace === null ? null : state.openProjectId;
    if (nextWorkspace !== workspaceId) {
      // The subscription, if any, belonged to the previous workspace.
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
        reload("all");
      }
    }
  }

  // The reloads.

  /**
   * Begins a reload of `scope` and sends it once no other reload is in
   * flight. A reload that began and was not sent yet covers every later
   * reason of the same or a smaller scope, since its request goes out after
   * them. The gate may widen the scope to `all`.
   */
  function reload(scope: ResyncScope): ResyncReload | null {
    if (closed || projectId === null) {
      return null;
    }
    stopRetry();
    if (
      wanted !== null &&
      wanted.generation === gate.generation() &&
      (scope === "part" || wanted.scope === "all")
    ) {
      return wanted;
    }
    const begun = gate.begin(scope);
    wanted = begun;
    if (begun.scope === "all") {
      // It reads everything that a waiting follow-up would.
      stopFollowUp();
    }
    sendWanted();
    return begun;
  }

  function sendWanted(): void {
    if (inFlight || wanted === null) {
      return;
    }
    const reload = wanted;
    wanted = null;
    if (
      reload.generation !== gate.generation() ||
      workspaceId === null ||
      projectId === null
    ) {
      // Stale: an overflow or the end of the subscription came after it.
      return;
    }
    inFlight = true;
    send({
      epoch,
      workspaceId,
      projectId,
      generation: reload.generation,
      // A part reload replaces the agents of the activity that it holds.
      scope: activity === null ? "all" : reload.scope,
    });
  }

  function read<T>(
    request: Promise<WorkspaceReadResult<T>>,
  ): Promise<WorkspaceReadResult<T>> {
    return request.catch(() => ({ ok: false, reason: "unavailable" }) as const);
  }

  /** Whether the open project is still the one `request` was sent for. */
  function stillOpen(request: ReloadRequest): boolean {
    return (
      !closed &&
      request.epoch === epoch &&
      request.workspaceId === workspaceId &&
      request.projectId === projectId
    );
  }

  function send(request: ReloadRequest): void {
    const params = { projectId: request.projectId };
    if (request.scope === "part") {
      void read(account.readWorkspaceData("listAgents", params)).then(
        (agents) => run(() => reloadAnswered(request, null, agents)),
      );
      return;
    }
    // The runs first: every agent of a run that they list already exists
    // when the agents are read afterwards.
    void read(account.readWorkspaceData("listRuns", params)).then((runs) =>
      run(() => {
        if (
          runs.ok &&
          stillOpen(request) &&
          request.generation === gate.generation()
        ) {
          void read(account.readWorkspaceData("listAgents", params)).then(
            (agents) => run(() => reloadAnswered(request, runs, agents)),
          );
          return;
        }
        reloadAnswered(request, runs, null);
      }),
    );
  }

  /**
   * The reload of `request` answered. `runs` is null for a part reload, and
   * `agents` is null when the agents were not read: the runs failed, or the
   * reload became stale.
   */
  function reloadAnswered(
    request: ReloadRequest,
    runs: WorkspaceReadResult<AgentRunListResponse> | null,
    agents: WorkspaceReadResult<AgentListResponse> | null,
  ): void {
    if (closed || request.epoch !== epoch) {
      // The reset already let the next reload go.
      return;
    }
    inFlight = false;
    try {
      if (stillOpen(request)) {
        applyAnswer(request, runs, agents);
      }
    } finally {
      sendWanted();
    }
  }

  function applyAnswer(
    request: ReloadRequest,
    runs: WorkspaceReadResult<AgentRunListResponse> | null,
    agents: WorkspaceReadResult<AgentListResponse> | null,
  ): void {
    if (runs !== null && !runs.ok) {
      reloadFailed(request.generation, runs.reason);
      return;
    }
    if (agents === null) {
      // The runs answered for a stale reload: the newer one is waiting.
      return;
    }
    if (!agents.ok) {
      reloadFailed(request.generation, agents.reason);
      return;
    }
    let result: ActivitySnapshotResult;
    if (runs !== null) {
      result = activityFromSnapshot(
        request.projectId,
        agents.value,
        runs.value,
      );
    } else if (activity !== null) {
      result = replaceAgents(activity, agents.value);
    } else {
      result = { ok: false, reason: "wrong_project" };
    }
    if (!result.ok) {
      // The answer holds another project's agents or runs.
      reloadFailed(request.generation, "failed");
      return;
    }
    const events = gate.reloaded(request.generation);
    if (events === null) {
      return;
    }
    activity = result.activity;
    applied = request.generation;
    problem = null;
    attempt = 0;
    touch();
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
    log(`The agent activity did not load (${reason}).`);
    scheduleRetry(workspaceRetryDelayMs(attempt, reason));
    attempt += 1;
  }

  /** Reloads everything after `delayMs`, unless something else reloads first. */
  function scheduleRetry(delayMs: number): void {
    stopRetry();
    cancelRetry = schedule(() => {
      run(() => {
        cancelRetry = null;
        reload("all");
      });
    }, delayMs);
  }

  /** Asks for a reload after `AGENT_FOLLOW_UP_DELAY_MS`. */
  function followUp(scope: ResyncScope): void {
    followUpAll ||= scope === "all";
    if (cancelFollowUp !== null) {
      return;
    }
    cancelFollowUp = schedule(() => {
      run(() => {
        cancelFollowUp = null;
        const all = followUpAll;
        followUpAll = false;
        const begun = reload(all ? "all" : "part");
        if (all && begun !== null) {
          unknownRunReload = begun.generation;
        }
      });
    }, AGENT_FOLLOW_UP_DELAY_MS);
  }

  // The events.

  /** Applies events in order and asks for the reloads that they need. */
  function applyEvents(events: readonly AgentEvent[]): void {
    let agentsStale = false;
    let unknownRun = false;
    for (const event of events) {
      if (event.type === "workspace.member.removed") {
        // The removal disabled the person's agents, and no event reports it.
        agentsStale = true;
        continue;
      }
      if (activity === null) {
        continue;
      }
      const outcome = applyRunEvent(activity, event);
      agentsStale ||= outcome.agentsStale;
      switch (outcome.kind) {
        case "applied":
          activity = outcome.activity;
          touch();
          break;
        case "unknown_run":
          unknownRun = true;
          break;
        case "unchanged":
        case "unknown_agent":
          // Most often a run of another project: the event names none.
          break;
      }
    }
    // A reload that an `unknown_run` began does not begin another one, so
    // that data that stays inconsistent does not reload in a loop.
    if (unknownRun && applied !== unknownRunReload) {
      followUp("all");
    }
    if (agentsStale) {
      followUp("part");
    }
  }

  function eventReceived(event: ReceivedServerEvent): void {
    if (
      !isAgentEvent(event) ||
      event.workspaceId !== workspaceId ||
      projectId === null
    ) {
      return;
    }
    switch (gate.push(event)) {
      case "apply":
        applyEvents([event]);
        return;
      case "overflowed":
        log("Too many agent events waited; the agent activity reloads.");
        wanted = null;
        stopFollowUp();
        scheduleRetry(workspaceRetryDelayMs(attempt, "unavailable"));
        attempt += 1;
        return;
      case "buffered":
      case "dropped":
      case "ignored":
        return;
    }
  }

  // The frames, the account, the connection, and the workspace service.

  /** The subscription ended: the next `workspace.subscribed` reloads. */
  function endSubscription(): void {
    gate.end();
    wanted = null;
    stopRetry();
    stopFollowUp();
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
          stopFollowUp();
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
      case "account.device_revoked":
        // The revocation disabled the device's agents. Only its unfinished
        // runs are cancelled with an event, so without one, nothing else
        // reports it. A reload that waits or runs reads the agents anyway,
        // and the backoff of a failed one stays.
        if (projectId !== null && gate.state() === "live") {
          followUp("part");
        }
        return;
      default:
        // The workspace service follows the membership and the selection.
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
    follow(workspaces.state());
  }

  function connectionChanged(state: string): void {
    const now = state === "connected";
    if (now === connected) {
      return;
    }
    connected = now;
    if (!now) {
      // A lost connection ends the subscription; the next
      // `workspace.subscribed` reloads.
      endSubscription();
    }
  }

  const removers = [
    account.onStatusChange((status) => run(() => accountChanged(status))),
    connection.onStatusChange((status) =>
      run(() => connectionChanged(status.state)),
    ),
    connection.onMessage((message) => run(() => messageReceived(message))),
    workspaces.onChange((state) => run(() => follow(state))),
  ];
  accountChanged(account.status());
  connectionChanged(connection.status().state);
  // The first state is revision 0.
  current = buildState();
  dirty = false;

  return Object.freeze({
    state: () => current,
    onChange: (listener: (state: AgentActivityState) => void) => {
      const entry = (state: AgentActivityState) => listener(state);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
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
      stopFollowUp();
      gate.end();
    },
  });
}
