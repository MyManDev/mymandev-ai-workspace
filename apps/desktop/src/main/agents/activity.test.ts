import {
  AgentListResponseSchema,
  AgentRunListResponseSchema,
  decodeServerMessage,
  isTerminalRunState,
  ProjectIdSchema,
  RECENT_FINISHED_RUNS,
  type AgentListResponse,
  type AgentRunListResponse,
  type RunState,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  activityFromSnapshot,
  applyRunEvent,
  replaceAgents,
  type ProjectActivity,
  type RunEventInput,
  type RunEventOutcome,
} from "./activity.ts";

const PROJECT_ID = ProjectIdSchema.parse(
  "0192f0a0-7b3c-7d4e-8f50-0000000000e1",
);
const OTHER_PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000e2";
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000f1";
const EVENT_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000ee";
const MEMBER_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000c1";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000a1";
const OTHER_AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000a2";
/** An agent that the project's agent list does not hold. */
const UNLISTED_AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000a3";
const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000d1";
const OTHER_REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000d2";
const START = Date.parse("2026-11-05T10:00:00.000Z");

function runId(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-0000000b${n.toString(16).padStart(4, "0")}`;
}

/** A timestamp `seconds` after the start, with milliseconds. */
function at(seconds: number): string {
  return new Date(START + seconds * 1000).toISOString();
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return true;
  }
  return (
    Object.isFrozen(value) &&
    Object.values(value).every((child) => isDeepFrozen(child))
  );
}

function agent(
  id: string,
  projectId: string = PROJECT_ID,
  disabledAt: string | null = null,
) {
  return {
    id,
    projectId,
    name: `Agent ${id.slice(-2)}`,
    ownerMemberId: MEMBER_ID,
    disabledAt,
  };
}

function agentList(...agents: ReturnType<typeof agent>[]): AgentListResponse {
  return deepFreeze(AgentListResponseSchema.parse({ agents }));
}

interface RunOptions {
  readonly agentId?: string;
  readonly projectId?: string;
  readonly repositoryId?: string | null;
  readonly reason?: string | null;
  /** Seconds after the start; a finished run finishes 3,600 seconds later. */
  readonly createdAt?: number;
}

function run(n: number, state: RunState, options: RunOptions = {}) {
  const created = options.createdAt ?? n;
  return {
    id: runId(n),
    agentId: options.agentId ?? AGENT_ID,
    projectId: options.projectId ?? PROJECT_ID,
    repositoryId: options.repositoryId ?? null,
    state,
    reason: options.reason ?? null,
    createdAt: at(created),
    finishedAt: isTerminalRunState(state) ? at(created + 3600) : null,
  };
}

function runList(
  unfinishedRuns: readonly ReturnType<typeof run>[],
  finishedRuns: readonly ReturnType<typeof run>[] = [],
): AgentRunListResponse {
  return deepFreeze(
    AgentRunListResponseSchema.parse({ unfinishedRuns, finishedRuns }),
  );
}

const AGENTS = agentList(agent(AGENT_ID), agent(OTHER_AGENT_ID));

function snapshot(
  unfinishedRuns: readonly ReturnType<typeof run>[],
  finishedRuns: readonly ReturnType<typeof run>[] = [],
): ProjectActivity {
  const result = activityFromSnapshot(
    PROJECT_ID,
    AGENTS,
    runList(unfinishedRuns, finishedRuns),
  );
  if (!result.ok) {
    throw new Error(`The snapshot was refused: ${result.reason}`);
  }
  return result.activity;
}

interface EventOptions {
  readonly actor?: "agent" | "system";
  readonly agentId?: string;
  readonly repositoryId?: string;
  readonly reason?: string;
  readonly occurredAt?: string;
}

/**
 * A run event as the connection client receives it: decoded with
 * `decodeServerMessage`, which also checks the actor and the null device.
 */
function runEvent(
  n: number,
  previousState: RunState | null,
  state: RunState,
  options: EventOptions = {},
): RunEventInput {
  const agentId = options.agentId ?? AGENT_ID;
  const actor = options.actor ?? (previousState === null ? "system" : "agent");
  const decoded = decodeServerMessage({
    protocolVersion: 0,
    id: EVENT_ID,
    occurredAt: options.occurredAt ?? at(10_000),
    workspaceId: WORKSPACE_ID,
    actor: actor === "agent" ? { kind: "agent", agentId } : { kind: "system" },
    deviceId: null,
    type: "agent.run.state_changed",
    payload: {
      runId: runId(n),
      agentId,
      ...(options.repositoryId === undefined
        ? {}
        : { repositoryId: options.repositoryId }),
      previousState,
      state,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    },
  });
  if (
    !decoded.ok ||
    decoded.kind !== "event" ||
    decoded.event.type !== "agent.run.state_changed"
  ) {
    throw new Error("The test event does not decode");
  }
  return deepFreeze(decoded.event);
}

function applied(outcome: RunEventOutcome): ProjectActivity {
  if (outcome.kind !== "applied") {
    throw new Error(`Expected the event to apply, got ${outcome.kind}`);
  }
  return outcome.activity;
}

function ids(runs: readonly { readonly id: string }[]): string[] {
  return runs.map((item) => item.id);
}

test("a snapshot of the path's project is accepted in the server's order and frozen", () => {
  const agents = agentList(agent(OTHER_AGENT_ID), agent(AGENT_ID));
  // Not in the order of the creation times, which the model never sorts by.
  const runs = runList(
    [run(1, "running", { createdAt: 5 }), run(2, "queued", { createdAt: 9 })],
    [run(3, "completed"), run(4, "failed", { reason: "Out of memory" })],
  );

  const result = activityFromSnapshot(PROJECT_ID, agents, runs);

  expect(result).toEqual({
    ok: true,
    activity: {
      projectId: PROJECT_ID,
      agents: agents.agents,
      unfinishedRuns: runs.unfinishedRuns,
      finishedRuns: runs.finishedRuns,
      finishedLimit: RECENT_FINISHED_RUNS,
    },
  });
  expect(RECENT_FINISHED_RUNS).toBe(50);
  expect(isDeepFrozen(result)).toBe(true);
});

test("a snapshot and a new agent list are copied and frozen, and the answers are not changed", () => {
  // Parsed and not frozen, as the service passes them.
  const agents = AgentListResponseSchema.parse({ agents: [agent(AGENT_ID)] });
  const runs = AgentRunListResponseSchema.parse({
    unfinishedRuns: [run(1, "running")],
    finishedRuns: [run(2, "completed")],
  });
  const newAgents = AgentListResponseSchema.parse({
    agents: [agent(OTHER_AGENT_ID)],
  });

  const result = activityFromSnapshot(PROJECT_ID, agents, runs);
  if (!result.ok) {
    throw new Error(`The snapshot was refused: ${result.reason}`);
  }
  const replaced = replaceAgents(result.activity, newAgents);
  if (!replaced.ok) {
    throw new Error(`The agents were refused: ${replaced.reason}`);
  }

  const { activity } = result;
  expect(isDeepFrozen(result)).toBe(true);
  expect(isDeepFrozen(replaced)).toBe(true);
  for (const [copy, answer] of [
    [activity.agents, agents.agents],
    [activity.unfinishedRuns, runs.unfinishedRuns],
    [activity.finishedRuns, runs.finishedRuns],
    [replaced.activity.agents, newAgents.agents],
  ] as const) {
    expect(copy).toEqual(answer);
    expect(copy).not.toBe(answer);
    expect(copy[0]).not.toBe(answer[0]);
    expect(Object.isFrozen(answer)).toBe(false);
    expect(Object.isFrozen(answer[0])).toBe(false);
  }
});

test("the finished limit is the snapshot's count when the server sent more than 50", () => {
  const finished = Array.from({ length: 60 }, (_, index) =>
    run(100 + index, "completed"),
  );
  const activity = snapshot([run(1, "running")], finished);
  expect(activity.finishedLimit).toBe(60);

  const next = applied(
    applyRunEvent(activity, runEvent(1, "running", "failed")),
  );

  expect(next.finishedRuns).toHaveLength(60);
  expect(next.finishedRuns[0]?.id).toBe(runId(1));
  expect(ids(next.finishedRuns.slice(1))).toEqual(ids(finished.slice(0, 59)));
});

test("an agent or a run of another project is refused as wrong_project", () => {
  const ownAgents = agentList(agent(AGENT_ID));
  const ownRuns = runList([run(1, "queued")], [run(2, "completed")]);
  const foreignAgents = agentList(agent(AGENT_ID, OTHER_PROJECT_ID));
  const foreignUnfinished = runList([
    run(1, "queued", { projectId: OTHER_PROJECT_ID }),
  ]);
  const foreignFinished = runList(
    [],
    [run(2, "completed", { projectId: OTHER_PROJECT_ID })],
  );

  for (const [agents, runs] of [
    [foreignAgents, ownRuns],
    [ownAgents, foreignUnfinished],
    [ownAgents, foreignFinished],
  ] as const) {
    expect(activityFromSnapshot(PROJECT_ID, agents, runs)).toEqual({
      ok: false,
      reason: "wrong_project",
    });
  }
});

test("empty lists are accepted", () => {
  const result = activityFromSnapshot(PROJECT_ID, agentList(), runList([], []));

  expect(result).toEqual({
    ok: true,
    activity: {
      projectId: PROJECT_ID,
      agents: [],
      unfinishedRuns: [],
      finishedRuns: [],
      finishedLimit: RECENT_FINISHED_RUNS,
    },
  });
  expect(isDeepFrozen(result)).toBe(true);
});

test("queued to running updates the run in place and leaves the input unchanged", () => {
  const activity = snapshot(
    [run(3, "running"), run(1, "queued"), run(2, "queued")],
    [run(9, "completed")],
  );
  const before = structuredClone(activity);

  const outcome = applyRunEvent(activity, runEvent(1, "queued", "running"));
  const next = applied(outcome);

  expect(outcome).toMatchObject({ kind: "applied", agentsStale: false });
  expect(ids(next.unfinishedRuns)).toEqual([runId(3), runId(1), runId(2)]);
  expect(next.unfinishedRuns[1]).toEqual({
    ...run(1, "queued"),
    state: "running",
  });
  expect(next).not.toBe(activity);
  expect(next.agents).toBe(activity.agents);
  expect(next.finishedRuns).toBe(activity.finishedRuns);
  expect(activity).toEqual(before);
  expect(isDeepFrozen(outcome)).toBe(true);
});

test("an event without a reason clears an earlier reason", () => {
  const activity = snapshot([
    run(1, "awaiting_input", { reason: "Waiting for the review" }),
  ]);

  const next = applied(
    applyRunEvent(activity, runEvent(1, "awaiting_input", "running")),
  );

  expect(next.unfinishedRuns[0]).toMatchObject({
    state: "running",
    reason: null,
  });
});

test("an event in the same state with another reason replaces the reason", () => {
  // The reload shows the run waiting with one reason; a later buffered
  // event reports the same state with another reason, or with none.
  const activity = snapshot([
    run(1, "awaiting_input", { reason: "Waiting for the review" }),
  ]);

  const changed = applied(
    applyRunEvent(
      activity,
      runEvent(1, "running", "awaiting_input", { reason: "Needs an answer" }),
    ),
  );
  const cleared = applied(
    applyRunEvent(changed, runEvent(1, "running", "awaiting_input")),
  );

  expect(changed.unfinishedRuns[0]).toMatchObject({
    state: "awaiting_input",
    reason: "Needs an answer",
  });
  expect(cleared.unfinishedRuns[0]).toMatchObject({
    state: "awaiting_input",
    reason: null,
  });
});

test("running to completed moves the run to the front of the finished runs", () => {
  const activity = snapshot(
    [run(2, "queued"), run(1, "running"), run(3, "running")],
    [run(8, "completed"), run(7, "cancelled")],
  );
  // Earlier than the finish times of the finished runs: the order of the
  // events counts, and the model never sorts by time.
  const occurredAt = at(2);

  const next = applied(
    applyRunEvent(
      activity,
      runEvent(1, "running", "completed", { occurredAt }),
    ),
  );

  expect(ids(next.unfinishedRuns)).toEqual([runId(2), runId(3)]);
  expect(ids(next.finishedRuns)).toEqual([runId(1), runId(8), runId(7)]);
  expect(next.finishedRuns[0]).toEqual({
    ...run(1, "running"),
    state: "completed",
    finishedAt: occurredAt,
  });
  expect(isDeepFrozen(next)).toBe(true);
});

test("with 50 finished runs, one more finished run drops the oldest", () => {
  const finished = Array.from({ length: RECENT_FINISHED_RUNS }, (_, index) =>
    run(100 + index, "completed"),
  );
  const activity = snapshot([run(1, "running")], finished);
  expect(activity.finishedLimit).toBe(RECENT_FINISHED_RUNS);

  const next = applied(
    applyRunEvent(
      activity,
      runEvent(1, "running", "cancelled", { reason: "Stopped by the owner" }),
    ),
  );

  expect(next.finishedRuns).toHaveLength(RECENT_FINISHED_RUNS);
  expect(next.finishedRuns[0]).toMatchObject({
    id: runId(1),
    state: "cancelled",
    reason: "Stopped by the owner",
  });
  expect(ids(next.finishedRuns.slice(1))).toEqual(ids(finished.slice(0, -1)));
  expect(next.unfinishedRuns).toEqual([]);
});

test("an event for a run that is already finished changes nothing", () => {
  const activity = snapshot([], [run(1, "completed")]);

  for (const event of [
    runEvent(1, "running", "completed"),
    runEvent(1, "running", "failed"),
    runEvent(1, "queued", "running"),
    runEvent(1, null, "queued"),
  ]) {
    expect(applyRunEvent(activity, event)).toEqual({
      kind: "unchanged",
      agentsStale: false,
    });
  }
});

test("buffered events over a newer snapshot end in the last event's state", () => {
  // The reload already shows awaiting_input; the two events that led there
  // were buffered and are applied afterwards, in order.
  const activity = snapshot([run(1, "awaiting_input")]);

  const first = applied(
    applyRunEvent(activity, runEvent(1, "queued", "running")),
  );
  expect(first.unfinishedRuns[0]?.state).toBe("running");
  const second = applied(
    applyRunEvent(first, runEvent(1, "running", "awaiting_input")),
  );

  expect(second.unfinishedRuns).toEqual([run(1, "awaiting_input")]);
});

test("an unknown agent and an unknown run are reported", () => {
  const activity = snapshot([run(1, "running")]);

  for (const event of [
    runEvent(2, "running", "completed", { agentId: UNLISTED_AGENT_ID }),
    runEvent(2, null, "queued", { agentId: UNLISTED_AGENT_ID }),
  ]) {
    expect(applyRunEvent(activity, event)).toEqual({
      kind: "unknown_agent",
      agentsStale: false,
    });
  }
  expect(applyRunEvent(activity, runEvent(2, "running", "completed"))).toEqual({
    kind: "unknown_run",
    agentsStale: false,
  });
});

test("a held run of another agent is reported as unknown_run", () => {
  const activity = snapshot([run(1, "running")], [run(2, "completed")]);

  for (const n of [1, 2]) {
    for (const agentId of [OTHER_AGENT_ID, UNLISTED_AGENT_ID]) {
      expect(
        applyRunEvent(activity, runEvent(n, "running", "failed", { agentId })),
      ).toEqual({ kind: "unknown_run", agentsStale: false });
    }
  }
});

test("a run of an agent that is not in the agent list is kept, and its events apply", () => {
  // The agent was created between the two reads of the snapshot.
  const activity = snapshot(
    [run(1, "queued", { agentId: UNLISTED_AGENT_ID }), run(2, "queued")],
    [run(3, "completed", { agentId: UNLISTED_AGENT_ID })],
  );
  const occurredAt = at(700);

  expect(ids(activity.unfinishedRuns)).toEqual([runId(1), runId(2)]);
  const started = applied(
    applyRunEvent(
      activity,
      runEvent(1, "queued", "running", { agentId: UNLISTED_AGENT_ID }),
    ),
  );
  expect(started.unfinishedRuns[0]).toEqual({
    ...run(1, "queued", { agentId: UNLISTED_AGENT_ID }),
    state: "running",
  });
  const done = applied(
    applyRunEvent(
      started,
      runEvent(1, "running", "completed", {
        agentId: UNLISTED_AGENT_ID,
        occurredAt,
      }),
    ),
  );

  expect(ids(done.unfinishedRuns)).toEqual([runId(2)]);
  expect(ids(done.finishedRuns)).toEqual([runId(1), runId(3)]);
  expect(done.finishedRuns[0]).toMatchObject({
    state: "completed",
    finishedAt: occurredAt,
  });
  expect(done.agents).toBe(activity.agents);
  expect(
    applyRunEvent(
      done,
      runEvent(3, "running", "failed", { agentId: UNLISTED_AGENT_ID }),
    ),
  ).toEqual({ kind: "unchanged", agentsStale: false });
});

test("a system creation of an unknown run is inserted at the front", () => {
  const activity = snapshot([run(1, "running")], [run(2, "completed")]);
  const occurredAt = at(500);
  const creation = runEvent(3, null, "queued", {
    repositoryId: REPOSITORY_ID,
    occurredAt,
  });

  const next = applied(applyRunEvent(activity, creation));

  expect(ids(next.unfinishedRuns)).toEqual([runId(3), runId(1)]);
  expect(next.unfinishedRuns[0]).toEqual({
    id: runId(3),
    agentId: AGENT_ID,
    projectId: PROJECT_ID,
    repositoryId: REPOSITORY_ID,
    state: "queued",
    reason: null,
    createdAt: occurredAt,
    finishedAt: null,
  });
  expect(next.finishedRuns).toBe(activity.finishedRuns);
  expect(isDeepFrozen(next)).toBe(true);
  expect(applyRunEvent(next, creation)).toEqual({
    kind: "unchanged",
    agentsStale: false,
  });
});

test("a created run without a repository has a null repository", () => {
  const next = applied(
    applyRunEvent(snapshot([]), runEvent(1, null, "queued")),
  );

  expect(next.unfinishedRuns[0]?.repositoryId).toBeNull();
});

test("a created run carries the event's reason", () => {
  const next = applied(
    applyRunEvent(
      snapshot([]),
      runEvent(1, null, "queued", { reason: "Waiting for a device" }),
    ),
  );

  expect(next.unfinishedRuns[0]).toMatchObject({
    id: runId(1),
    state: "queued",
    reason: "Waiting for a device",
  });
});

test("a server cancellation with a known code marks the agents stale", () => {
  const activity = snapshot([run(1, "running"), run(2, "queued")]);

  for (const reason of ["device_revoked", "member_removed"]) {
    const outcome = applyRunEvent(
      activity,
      runEvent(1, "running", "cancelled", { actor: "system", reason }),
    );
    expect(outcome).toMatchObject({ kind: "applied", agentsStale: true });
    expect(applied(outcome).finishedRuns[0]).toMatchObject({
      id: runId(1),
      state: "cancelled",
      reason,
    });
  }
  for (const event of [
    runEvent(1, "running", "cancelled", {
      actor: "agent",
      reason: "device_revoked",
    }),
    runEvent(1, "running", "cancelled", { actor: "system" }),
    runEvent(1, "running", "cancelled", {
      actor: "system",
      reason: "Stopped by the owner",
    }),
    runEvent(1, "running", "failed", {
      actor: "system",
      reason: "device_revoked",
    }),
  ]) {
    expect(applyRunEvent(activity, event)).toMatchObject({
      kind: "applied",
      agentsStale: false,
    });
  }
});

test("a server cancellation marks the agents stale also when the runs already show it", () => {
  const event = runEvent(1, "queued", "cancelled", {
    actor: "system",
    reason: "member_removed",
  });

  expect(
    applyRunEvent(
      snapshot([], [run(1, "cancelled", { reason: "member_removed" })]),
      event,
    ),
  ).toEqual({ kind: "unchanged", agentsStale: true });
  // A run of another project: its agent is not in this project's list.
  expect(
    applyRunEvent(
      snapshot([]),
      runEvent(1, "queued", "cancelled", {
        actor: "system",
        reason: "device_revoked",
        agentId: UNLISTED_AGENT_ID,
      }),
    ),
  ).toEqual({ kind: "unknown_agent", agentsStale: true });
});

test("a repository in the event never changes the run's repository", () => {
  const activity = snapshot([
    run(1, "queued", { repositoryId: REPOSITORY_ID }),
    run(2, "running"),
  ]);

  const started = applied(
    applyRunEvent(
      activity,
      runEvent(1, "queued", "running", { repositoryId: OTHER_REPOSITORY_ID }),
    ),
  );
  const finished = applied(
    applyRunEvent(
      started,
      runEvent(2, "running", "completed", {
        repositoryId: OTHER_REPOSITORY_ID,
      }),
    ),
  );

  expect(finished.unfinishedRuns[0]).toMatchObject({
    id: runId(1),
    state: "running",
    repositoryId: REPOSITORY_ID,
  });
  expect(finished.finishedRuns[0]).toMatchObject({
    id: runId(2),
    state: "completed",
    repositoryId: null,
  });
});

test("the same relayed event applied twice changes the run once", () => {
  const activity = snapshot([run(1, "running")]);
  const event = runEvent(1, "running", "awaiting_input", {
    reason: "Needs an answer",
  });

  const next = applied(applyRunEvent(activity, event));

  expect(next.unfinishedRuns[0]).toMatchObject({
    state: "awaiting_input",
    reason: "Needs an answer",
  });
  expect(applyRunEvent(next, event)).toEqual({
    kind: "unchanged",
    agentsStale: false,
  });
});

test("replacing the agents keeps the runs and checks the project", () => {
  const finished = Array.from({ length: 60 }, (_, index) =>
    run(100 + index, "completed"),
  );
  const activity = snapshot([run(1, "running")], finished);
  const before = structuredClone(activity);
  const agents = agentList(
    agent(AGENT_ID, PROJECT_ID, at(20)),
    agent(UNLISTED_AGENT_ID),
  );

  const result = replaceAgents(activity, agents);

  expect(result).toEqual({
    ok: true,
    activity: { ...activity, agents: agents.agents },
  });
  if (result.ok) {
    expect(result.activity.unfinishedRuns).toBe(activity.unfinishedRuns);
    expect(result.activity.finishedRuns).toBe(activity.finishedRuns);
    expect(result.activity.finishedLimit).toBe(60);
  }
  expect(isDeepFrozen(result)).toBe(true);
  expect(activity).toEqual(before);
  expect(
    replaceAgents(activity, agentList(agent(AGENT_ID, OTHER_PROJECT_ID))),
  ).toEqual({ ok: false, reason: "wrong_project" });
});
