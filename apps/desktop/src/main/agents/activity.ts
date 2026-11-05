// The agent activity of one project in the main process (#28): the project's
// agents and its unfinished and recently finished runs, read from
// `GET /projects/:projectId/agents` and `GET /projects/:projectId/runs`, and
// kept current with `agent.run.state_changed` events. It is a pure model: no
// timers, no I/O, and no logging. Every function returns new frozen objects
// and never changes its arguments. Nothing uses it yet: the agent service,
// the agent panel, and the development switch follow (#28).

import {
  isTerminalRunState,
  RECENT_FINISHED_RUNS,
  RUN_CANCEL_REASONS,
  type AgentListItem,
  type AgentListResponse,
  type AgentRunListItem,
  type AgentRunListResponse,
  type AgentRunStateChangedEvent,
  type ProjectId,
} from "@mymandev/protocol";

/** One project's agents and runs. Every object and array is frozen. */
export interface ProjectActivity {
  readonly projectId: ProjectId;
  /** The project's agents, disabled ones included, in the server's order. */
  readonly agents: readonly AgentListItem[];
  /** The unfinished runs, the most recently created first. */
  readonly unfinishedRuns: readonly AgentRunListItem[];
  /** The recently finished runs, the most recently finished first. */
  readonly finishedRuns: readonly AgentRunListItem[];
  /**
   * How many finished runs the model keeps: `RECENT_FINISHED_RUNS`, or the
   * snapshot's count when the server sent more.
   */
  readonly finishedLimit: number;
}

/**
 * The result of reading a snapshot. `wrong_project`: an agent or a run of the
 * answer belongs to another project than the one in the path. The answer's
 * schema checks that the list holds one project, but it cannot know the path.
 */
export type ActivitySnapshotResult =
  | { readonly ok: true; readonly activity: ProjectActivity }
  | { readonly ok: false; readonly reason: "wrong_project" };

/** The fields of a received `agent.run.state_changed` event that the model reads. */
export type RunEventInput = Pick<
  AgentRunStateChangedEvent,
  "occurredAt" | "actor" | "payload"
>;

/**
 * What applying a run event did. Every outcome carries `agentsStale`: true
 * when the server cancelled the run because a device was revoked or a person
 * was removed (a `system` actor and a code of `RUN_CANCEL_REASONS`). Both
 * also disable agents, in every project of the workspace, and no event
 * reports that, so the caller reloads the agents. Agents and runs are two
 * separate reads, so this holds also when the runs already show the
 * cancellation, and for a run of another project.
 *
 * - `applied`: the event changed the activity; `activity` is the new one.
 * - `unchanged`: the activity already holds what the event reports, or the
 *   run is already finished, so the event is older than the snapshot.
 * - `unknown_agent`: the activity does not hold the event's run, and no agent
 *   of this project has the event's agent ID. Most often the run belongs to
 *   another project of the same workspace, because the event names no
 *   project; the caller does not reload for it. It can also be an agent
 *   created after the snapshot, or one beyond the agent list's limit; the
 *   caller decides. A held run is never `unknown_agent`: the snapshot showed
 *   that it belongs to this project.
 * - `unknown_run`: the event changes a run of a listed agent that the
 *   activity does not hold, or a held run belongs to another agent. The data
 *   is inconsistent, so the caller reloads.
 */
export type RunEventOutcome =
  | {
      readonly kind: "applied";
      readonly activity: ProjectActivity;
      readonly agentsStale: boolean;
    }
  | { readonly kind: "unchanged"; readonly agentsStale: boolean }
  | { readonly kind: "unknown_agent"; readonly agentsStale: boolean }
  | { readonly kind: "unknown_run"; readonly agentsStale: boolean };

function frozenCopies<T extends object>(items: readonly T[]): readonly T[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

function allInProject(
  projectId: ProjectId,
  items: readonly { readonly projectId: ProjectId }[],
): boolean {
  return items.every((item) => item.projectId === projectId);
}

function activityOf(fields: ProjectActivity): ProjectActivity {
  return Object.freeze({
    projectId: fields.projectId,
    agents: fields.agents,
    unfinishedRuns: fields.unfinishedRuns,
    finishedRuns: fields.finishedRuns,
    finishedLimit: fields.finishedLimit,
  });
}

/**
 * The activity of the project in the path, from the answers of its two read
 * routes. It keeps the server's order and never sorts.
 */
export function activityFromSnapshot(
  projectId: ProjectId,
  agents: AgentListResponse,
  runs: AgentRunListResponse,
): ActivitySnapshotResult {
  if (
    !allInProject(projectId, agents.agents) ||
    !allInProject(projectId, runs.unfinishedRuns) ||
    !allInProject(projectId, runs.finishedRuns)
  ) {
    return Object.freeze({ ok: false, reason: "wrong_project" });
  }
  const activity = activityOf({
    projectId,
    agents: frozenCopies(agents.agents),
    unfinishedRuns: frozenCopies(runs.unfinishedRuns),
    finishedRuns: frozenCopies(runs.finishedRuns),
    finishedLimit: Math.max(RECENT_FINISHED_RUNS, runs.finishedRuns.length),
  });
  return Object.freeze({ ok: true, activity });
}

/**
 * The activity with the agents of a new answer of the agent route, and its
 * runs unchanged, for a reload of the agents alone.
 */
export function replaceAgents(
  activity: ProjectActivity,
  agents: AgentListResponse,
): ActivitySnapshotResult {
  if (!allInProject(activity.projectId, agents.agents)) {
    return Object.freeze({ ok: false, reason: "wrong_project" });
  }
  return Object.freeze({
    ok: true,
    activity: activityOf({ ...activity, agents: frozenCopies(agents.agents) }),
  });
}

function cancelsAgents(event: RunEventInput): boolean {
  const reasons: readonly string[] = RUN_CANCEL_REASONS;
  return (
    event.actor.kind === "system" &&
    event.payload.state === "cancelled" &&
    event.payload.reason !== undefined &&
    reasons.includes(event.payload.reason)
  );
}

/**
 * Applies one `agent.run.state_changed` event. Every event sets the state
 * that it reports, and the last event wins: the device applies the events
 * buffered after `workspace.subscribed` on top of a reload that can be newer
 * than some of them, so the event's `previousState` is never compared with
 * the held state. A finished run never changes. A run that reaches a
 * terminal state moves to the front of the finished runs with the event's
 * `occurredAt` as its finish time; that time is provisional, and the next
 * reload replaces it with the server's. A `repositoryId` in the event never
 * changes the run's repository. An event for a held run applies also when
 * the agent list does not hold the run's agent, for example an agent created
 * between the two reads of the snapshot: the run belongs to this project.
 */
export function applyRunEvent(
  activity: ProjectActivity,
  event: RunEventInput,
): RunEventOutcome {
  const { payload } = event;
  const agentsStale = cancelsAgents(event);
  const unfinished = activity.unfinishedRuns.find(
    (run) => run.id === payload.runId,
  );
  const finished =
    unfinished === undefined
      ? activity.finishedRuns.find((run) => run.id === payload.runId)
      : undefined;
  const held = unfinished ?? finished;
  if (
    held === undefined &&
    !activity.agents.some((agent) => agent.id === payload.agentId)
  ) {
    return Object.freeze({ kind: "unknown_agent", agentsStale });
  }
  if (held !== undefined && held.agentId !== payload.agentId) {
    return Object.freeze({ kind: "unknown_run", agentsStale });
  }
  if (finished !== undefined) {
    return Object.freeze({ kind: "unchanged", agentsStale });
  }
  if (unfinished === undefined) {
    if (payload.previousState !== null) {
      return Object.freeze({ kind: "unknown_run", agentsStale });
    }
    const created: AgentRunListItem = Object.freeze({
      id: payload.runId,
      agentId: payload.agentId,
      projectId: activity.projectId,
      repositoryId: payload.repositoryId ?? null,
      state: payload.state,
      reason: payload.reason ?? null,
      createdAt: event.occurredAt,
      finishedAt: null,
    });
    return Object.freeze({
      kind: "applied",
      activity: activityOf({
        ...activity,
        unfinishedRuns: Object.freeze([created, ...activity.unfinishedRuns]),
      }),
      agentsStale,
    });
  }
  const reason = payload.reason ?? null;
  if (unfinished.state === payload.state && unfinished.reason === reason) {
    return Object.freeze({ kind: "unchanged", agentsStale });
  }
  if (isTerminalRunState(payload.state)) {
    const done: AgentRunListItem = Object.freeze({
      ...unfinished,
      state: payload.state,
      reason,
      finishedAt: event.occurredAt,
    });
    return Object.freeze({
      kind: "applied",
      activity: activityOf({
        ...activity,
        unfinishedRuns: Object.freeze(
          activity.unfinishedRuns.filter((run) => run !== unfinished),
        ),
        finishedRuns: Object.freeze(
          [done, ...activity.finishedRuns].slice(0, activity.finishedLimit),
        ),
      }),
      agentsStale,
    });
  }
  const next: AgentRunListItem = Object.freeze({
    ...unfinished,
    state: payload.state,
    reason,
  });
  return Object.freeze({
    kind: "applied",
    activity: activityOf({
      ...activity,
      unfinishedRuns: Object.freeze(
        activity.unfinishedRuns.map((run) => (run === unfinished ? next : run)),
      ),
    }),
    agentsStale,
  });
}
