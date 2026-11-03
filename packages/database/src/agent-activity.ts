import {
  type AgentId,
  type AgentListItem,
  type AgentRunListItem,
  type AgentRunStateChangedEvent,
  canTransition,
  type CorrelationId,
  type DeviceId,
  type EventId,
  isTerminalRunState,
  MAX_ANSWER_LIST_ITEMS,
  type MemberId,
  newUuidV7,
  type ProjectId,
  PROTOCOL_VERSION,
  RECENT_FINISHED_RUNS,
  type RepositoryId,
  type RunId,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "./db.ts";
import { toDatabaseError, withDatabaseErrors } from "./errors.ts";
import {
  agentRunTransitions,
  agentRuns,
  agents,
  projects,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";

// A project's agent activity (#28; Project Manager decisions of 2026-11-02):
// recording a run transition that an agent's host device sent, and the two
// reads that the desktop reloads after every `workspace.subscribed`, a
// project's agents and its unfinished and recent runs. Any active member of
// the project's workspace reads them. Only the agent's host device moves a
// run; the server's own transitions, a run's creation and its cancellations
// (`src/cascade.ts`), are not recorded here.
//
// Every accepted transition is stored in `agent_run_transitions`, unique by
// the sending device and the event ID (`agent_run_transitions_device_event_key`),
// together with what the relayed event carries, so that a transition sent
// again gets exactly the event that was relayed and is never applied twice.
//
// Lock order: the acting person (`workspace_members`), then the agent
// (`agents`), then the run (`agent_runs`), after the account and the device
// that `lockActor` in the API locks first. A transition locks the person
// `FOR SHARE`, as `src/people.ts` asks of a writer that depends on a person:
// a removal holds the person `FOR NO KEY UPDATE`, so either the removal
// commits first and the transition finds the person removed, or the
// transition commits first and the removal cancels the run from its new
// state. It locks the agent `FOR SHARE` too: a device revocation and a
// removal disable the agent and cancel its runs, locking the agents before
// the runs `FOR NO KEY UPDATE` (`src/cascade.ts`), so either one commits
// first and the transition finds the agent disabled, or the transition
// commits first and the cancellation starts from its new state. The
// transitions of one agent do not wait for each other at the agent. It reads
// the run `FOR NO KEY UPDATE`, the lock that its update takes, before it
// decides on the run's state, so of two concurrent transitions of one run
// the second waits until the first commits and then decides on the state
// that the first left: `conflict`, or the stored event when both have the
// same device and event ID.

/** The unique index of one accepted transition per device and event ID. */
const EVENT_KEY = "agent_run_transitions_device_event_key";

/** Whether a failure is the unique index of event IDs. */
function isEventClash(error: unknown): boolean {
  const failure = toDatabaseError(error);
  return failure.code === "23505" && failure.constraint === EVENT_KEY;
}

/** What the relayed event of a transition carries. */
type TransitionRow = Readonly<{
  eventId: EventId;
  occurredAt: Date;
  workspaceId: WorkspaceId;
  runId: RunId;
  agentId: AgentId;
  repositoryId: RepositoryId | null;
  previousState: RunState;
  state: RunState;
  reason: string | null;
  correlationId: CorrelationId | null;
  causationId: EventId | null;
}>;

/**
 * The relayed event of a transition: every field as the device sent it,
 * except `deviceId`, which is null (ADR 0006, update of 2026-11-02). An
 * optional field that the device did not send stays absent.
 */
function toRelayedEvent(row: TransitionRow): AgentRunStateChangedEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: row.eventId,
    occurredAt: row.occurredAt.toISOString(),
    workspaceId: row.workspaceId,
    actor: { kind: "agent", agentId: row.agentId },
    deviceId: null,
    ...(row.correlationId === null ? {} : { correlationId: row.correlationId }),
    ...(row.causationId === null ? {} : { causationId: row.causationId }),
    type: "agent.run.state_changed",
    payload: {
      runId: row.runId,
      agentId: row.agentId,
      ...(row.repositoryId === null ? {} : { repositoryId: row.repositoryId }),
      previousState: row.previousState,
      state: row.state,
      ...(row.reason === null ? {} : { reason: row.reason }),
    },
  };
}

/** The transition that the device recorded with this event ID, with its run's workspace. */
async function storedTransition(
  tx: Database,
  deviceId: DeviceId,
  eventId: EventId,
): Promise<TransitionRow | undefined> {
  const [row] = await tx
    .select({
      eventId: agentRunTransitions.eventId,
      occurredAt: agentRunTransitions.occurredAt,
      workspaceId: projects.workspaceId,
      runId: agentRunTransitions.runId,
      agentId: agentRunTransitions.agentId,
      repositoryId: agentRunTransitions.repositoryId,
      previousState: agentRunTransitions.previousState,
      state: agentRunTransitions.state,
      reason: agentRunTransitions.reason,
      correlationId: agentRunTransitions.correlationId,
      causationId: agentRunTransitions.causationId,
    })
    .from(agentRunTransitions)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunTransitions.runId))
    .innerJoin(projects, eq(projects.id, agentRuns.projectId))
    .where(
      and(
        eq(agentRunTransitions.deviceId, deviceId),
        eq(agentRunTransitions.eventId, eventId),
      ),
    );
  return row;
}

export type RecordRunTransitionInput = Readonly<{
  /**
   * Who sends: the connection's account and device, and the event's
   * workspace. The account's active person in the workspace must exist, and
   * the device must host the agent.
   */
  actor: Readonly<{
    workspaceId: WorkspaceId;
    userId: UserId;
    deviceId: DeviceId;
  }>;
  /** The payload's `agentId`, which the protocol requires to be the actor's. */
  agentId: AgentId;
  runId: RunId;
  /** The payload's `repositoryId`; undefined when the event has none. */
  repositoryId?: RepositoryId | undefined;
  /** The event's ID: the idempotency key per sending device. */
  eventId: EventId;
  /** Never null: a device never sends a run's creation (`decodeClientEvent`). */
  previousState: RunState;
  state: RunState;
  /** The payload's `reason`, from 1 to 500 characters; undefined when the event has none. */
  reason?: string | undefined;
  /** The event's `occurredAt`, as `new Date(event.occurredAt)`. */
  occurredAt: Date;
  correlationId?: CorrelationId | undefined;
  causationId?: EventId | undefined;
  /** The server's time, for the run's `started_at` and `finished_at` and the log's `created_at`. */
  now: Date;
}>;

/** Why a transition was refused. Nothing was written. */
export type RunTransitionRefusal =
  /** The account is not an active member of the actor's workspace, also when the workspace does not exist. */
  | "not_member"
  /** The agent is in the actor's workspace, but the sending device does not host it. */
  | "identity_mismatch"
  /**
   * The agent does not exist or is not in the actor's workspace; the run
   * does not exist or is a run of another agent, also of another
   * workspace; or the event names a repository that is not the run's.
   */
  | "not_found"
  /**
   * The agent is disabled; its project or workspace is archived; the
   * transition is not allowed; the run is no longer in `previousState`; or
   * the device recorded this event ID in another workspace.
   */
  | "conflict";

export type RecordRunTransitionResult =
  | Readonly<{
      recorded: true;
      /**
       * true when the device had already recorded a transition with this
       * event ID: `event` is that transition's relayed event, and nothing
       * was written. The API sends it to the sending connection only.
       */
      duplicate: boolean;
      /** The relayed `agent.run.state_changed`, with `deviceId: null`. */
      event: AgentRunStateChangedEvent;
    }>
  | Readonly<{ recorded: false; refusal: RunTransitionRefusal }>;

/**
 * Records a run transition that an agent's host device sent, in one
 * transaction (#28), and returns the event that the server relays. It
 * decides in this order:
 *
 * 1. It locks the account's active person in the actor's workspace
 *    `FOR SHARE`; without one, `not_member`.
 * 2. A transition that the device already recorded with this event ID is
 *    answered with its relayed event as it was stored, with
 *    `duplicate: true`, before any state of the agent or the run, also when
 *    the event sent again differs or the run moved on since; one recorded in
 *    another workspace is `conflict`.
 * 3. It locks the agent `FOR SHARE`. An agent that does not exist or is not
 *    in the actor's workspace is `not_found`; an agent of the workspace that
 *    the device does not host, or that another account owns, is
 *    `identity_mismatch`, a protocol violation on which the API closes the
 *    connection and writes an audit record.
 * 4. It locks the run `FOR NO KEY UPDATE`. A run that does not exist or is
 *    not the agent's, and a `repositoryId` that is not the run's
 *    repository, are `not_found`.
 * 5. A disabled agent, an archived project or workspace, a transition that
 *    `canTransition` refuses, and a run whose stored state is not
 *    `previousState` are `conflict`; a run that a concurrent transition of
 *    the same device and event ID moved while this one waited for its lock
 *    is answered as in step 2.
 *
 * It then sets the run's `state`, `state_reason` (the reason, or null),
 * `started_at` (`now`, when it first becomes `running`), and `finished_at`
 * (`now` for a terminal state) with one `UPDATE ... WHERE id = runId AND
 * state = previousState`, and inserts the transition into the log with the
 * device, the event ID, and `now` as `created_at`. These two statements run
 * as a savepoint: when a concurrent transition of the same device and event
 * ID on another run committed first, the insert fails the unique index, the
 * savepoint rolls the run's update back, and the result is the stored event,
 * as in step 2. Inside another transaction it runs as a savepoint.
 *
 * The device's revocation is the API's check (`lockActor`); a revocation
 * disables the device's agents in its own transaction, so a transition that
 * waits for one ends at step 5.
 */
export async function recordRunTransition(
  db: Database,
  input: RecordRunTransitionInput,
): Promise<RecordRunTransitionResult> {
  const { actor } = input;
  const refused = (
    refusal: RunTransitionRefusal,
  ): RecordRunTransitionResult => ({
    recorded: false,
    refusal,
  });
  // A transition that the device already recorded with this event ID.
  const answerTo = (stored: TransitionRow): RecordRunTransitionResult =>
    stored.workspaceId === actor.workspaceId
      ? { recorded: true, duplicate: true, event: toRelayedEvent(stored) }
      : refused("conflict");
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<RecordRunTransitionResult> => {
      const [person] = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, actor.workspaceId),
            eq(workspaceMembers.userId, actor.userId),
            isNull(workspaceMembers.removedAt),
          ),
        )
        .for("share");
      if (person === undefined) {
        return refused("not_member");
      }

      const stored = await storedTransition(tx, actor.deviceId, input.eventId);
      if (stored !== undefined) {
        return answerTo(stored);
      }

      const [agent] = await tx
        .select({
          workspaceId: projects.workspaceId,
          hostDeviceId: agents.hostDeviceId,
          ownerUserId: agents.ownerUserId,
          disabledAt: agents.disabledAt,
          projectArchivedAt: projects.archivedAt,
          workspaceArchivedAt: workspaces.archivedAt,
        })
        .from(agents)
        .innerJoin(projects, eq(projects.id, agents.projectId))
        .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
        .where(eq(agents.id, input.agentId))
        .for("share", { of: agents });
      if (agent === undefined || agent.workspaceId !== actor.workspaceId) {
        return refused("not_found");
      }
      if (
        agent.hostDeviceId !== actor.deviceId ||
        agent.ownerUserId !== actor.userId
      ) {
        return refused("identity_mismatch");
      }

      const [run] = await tx
        .select({
          state: agentRuns.state,
          repositoryId: agentRuns.repositoryId,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.agentId, input.agentId),
          ),
        )
        .for("no key update");
      if (
        run === undefined ||
        (input.repositoryId !== undefined &&
          input.repositoryId !== run.repositoryId)
      ) {
        return refused("not_found");
      }

      if (
        agent.disabledAt !== null ||
        agent.projectArchivedAt !== null ||
        agent.workspaceArchivedAt !== null ||
        !canTransition(input.previousState, input.state)
      ) {
        return refused("conflict");
      }
      if (run.state !== input.previousState) {
        // The lock may have waited for a concurrent transition of the same
        // device and event ID, which this statement's snapshot now sees.
        const raced = await storedTransition(tx, actor.deviceId, input.eventId);
        return raced === undefined ? refused("conflict") : answerTo(raced);
      }

      const row: TransitionRow = {
        eventId: input.eventId,
        occurredAt: input.occurredAt,
        workspaceId: actor.workspaceId,
        runId: input.runId,
        agentId: input.agentId,
        repositoryId: input.repositoryId ?? null,
        previousState: input.previousState,
        state: input.state,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? null,
        causationId: input.causationId ?? null,
      };
      try {
        await tx.transaction(async (savepoint) => {
          const updated = await savepoint
            .update(agentRuns)
            .set({
              state: row.state,
              stateReason: row.reason,
              finishedAt: isTerminalRunState(row.state) ? input.now : null,
              ...(row.state === "running"
                ? {
                    startedAt: sql`coalesce(${agentRuns.startedAt}, ${sql.param(input.now, agentRuns.startedAt)})`,
                  }
                : {}),
            })
            .where(
              and(
                eq(agentRuns.id, row.runId),
                eq(agentRuns.state, row.previousState),
              ),
            )
            .returning({ id: agentRuns.id });
          if (updated.length === 0) {
            throw new Error("The locked run left previousState");
          }
          await savepoint.insert(agentRunTransitions).values({
            id: newUuidV7(),
            runId: row.runId,
            agentId: row.agentId,
            deviceId: actor.deviceId,
            eventId: row.eventId,
            repositoryId: row.repositoryId,
            previousState: row.previousState,
            state: row.state,
            reason: row.reason,
            occurredAt: row.occurredAt,
            correlationId: row.correlationId,
            causationId: row.causationId,
            createdAt: input.now,
          });
        });
        return {
          recorded: true,
          duplicate: false,
          event: toRelayedEvent(row),
        };
      } catch (error) {
        if (!isEventClash(error)) {
          throw error;
        }
      }
      // A concurrent transition of the same device and event ID on another
      // run committed first.
      const raced = await storedTransition(tx, actor.deviceId, input.eventId);
      return raced === undefined ? refused("conflict") : answerTo(raced);
    }),
  );
}

export type ProjectActivityInput = Readonly<{
  /** The reading account; it must be an active member of the project's workspace. */
  actorUserId: UserId;
  projectId: ProjectId;
}>;

/**
 * The project does not exist, or the account is not an active member of its
 * workspace: the same answer, so that an ID cannot be probed.
 */
type NotFound = Readonly<{ listed: false; refusal: "not_found" }>;

const NOT_FOUND: NotFound = Object.freeze({
  listed: false,
  refusal: "not_found",
});

/**
 * Runs the statements of a read in one read-only `REPEATABLE READ`
 * transaction, so that they see one snapshot: the membership check and the
 * rows, and both run lists. Inside another transaction they run in that
 * transaction's isolation.
 */
async function inSnapshot<T>(
  db: Database,
  read: (tx: Database) => Promise<T>,
): Promise<T> {
  return withDatabaseErrors(() =>
    db.transaction(read, {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    }),
  );
}

/** Whether the project exists and the account is an active member of its workspace. */
async function readable(
  db: Database,
  input: ProjectActivityInput,
): Promise<boolean> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, projects.workspaceId),
        eq(workspaceMembers.userId, input.actorUserId),
        isNull(workspaceMembers.removedAt),
      ),
    )
    .where(eq(projects.id, input.projectId));
  return project !== undefined;
}

export type ListProjectAgentsResult =
  Readonly<{ listed: true; agents: AgentListItem[] }> | NotFound;

const owner = alias(workspaceMembers, "owner");

/**
 * The project's agents, disabled ones included: the answer of
 * `GET /projects/:projectId/agents`. The oldest first, at most
 * `MAX_ANSWER_LIST_ITEMS`. Any active member of the project's workspace
 * reads them, also of an archived project; a project that does not exist and
 * a project of a workspace that the account is not an active member of,
 * removed members included, give the same `not_found`. An agent names no
 * device: the host device is device data, which only its own account sees.
 *
 * The table records the owning account; the protocol shows the owner's
 * person, `ownerMemberId`, as `listProjects` shows a project's creator: the
 * account's active person in the project's workspace, or else its most
 * recently removed one, whose ID stays valid because person rows are never
 * deleted. Invariant: the owner of every agent has a person in its project's
 * workspace, because a writer of agents attaches the agent to its owner's
 * active person (`src/people.ts`), and nothing deletes a person. An agent
 * written otherwise makes the whole list throw ("Invariant broken: ...").
 * The membership check and the list are read in one read-only `REPEATABLE
 * READ` transaction, from one snapshot, as `listProjectRuns` reads.
 */
export async function listProjectAgents(
  db: Database,
  input: ProjectActivityInput,
): Promise<ListProjectAgentsResult> {
  const rows = await inSnapshot(db, async (db) => {
    if (!(await readable(db, input))) {
      return undefined;
    }
    const ownerPerson = db
      .select({ id: owner.id })
      .from(owner)
      .where(
        and(
          eq(owner.workspaceId, projects.workspaceId),
          eq(owner.userId, agents.ownerUserId),
        ),
      )
      .orderBy(sql`${owner.removedAt} desc nulls first`, desc(owner.id))
      .limit(1);
    return db
      .select({
        id: agents.id,
        projectId: agents.projectId,
        name: agents.name,
        ownerMemberId: sql<MemberId | null>`(${ownerPerson})`,
        disabledAt: agents.disabledAt,
      })
      .from(agents)
      .innerJoin(projects, eq(projects.id, agents.projectId))
      .where(eq(agents.projectId, input.projectId))
      .orderBy(asc(agents.createdAt), asc(agents.id))
      .limit(MAX_ANSWER_LIST_ITEMS);
  });
  if (rows === undefined) {
    return NOT_FOUND;
  }
  // Outside `withDatabaseErrors`, so that the message reaches the log; it
  // holds no data of the row.
  return {
    listed: true,
    agents: rows.map(({ ownerMemberId, disabledAt, ...agent }) => {
      if (ownerMemberId === null) {
        throw new Error(
          "Invariant broken: the owner of an agent has no person in its project's workspace",
        );
      }
      return {
        ...agent,
        ownerMemberId,
        disabledAt: disabledAt === null ? null : disabledAt.toISOString(),
      };
    }),
  };
}

export type ListProjectRunsResult =
  | Readonly<{
      listed: true;
      /** Every unfinished run, up to `MAX_ANSWER_LIST_ITEMS`, the most recently created first. */
      unfinishedRuns: AgentRunListItem[];
      /** The `RECENT_FINISHED_RUNS` most recently finished runs, the most recently finished first. */
      finishedRuns: AgentRunListItem[];
    }>
  | NotFound;

const runColumns = {
  id: agentRuns.id,
  agentId: agentRuns.agentId,
  projectId: agentRuns.projectId,
  repositoryId: agentRuns.repositoryId,
  state: agentRuns.state,
  reason: agentRuns.stateReason,
  createdAt: agentRuns.createdAt,
  finishedAt: agentRuns.finishedAt,
};

type RunRow = Readonly<{
  id: RunId;
  agentId: AgentId;
  projectId: ProjectId;
  repositoryId: RepositoryId | null;
  state: RunState;
  reason: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}>;

function toRunListItem(row: RunRow): AgentRunListItem {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
  };
}

/**
 * The project's unfinished runs and its most recently finished runs: the
 * answer of `GET /projects/:projectId/runs`. `unfinishedRuns` holds every run
 * in `queued`, `running`, or `awaiting_input`, the most recently created
 * first, at most `MAX_ANSWER_LIST_ITEMS`; `finishedRuns` holds the
 * `RECENT_FINISHED_RUNS` (50) runs with the latest `finished_at`, the most
 * recently finished first. Ties go to the higher run ID, so a run is listed
 * once and in a fixed place. `reason` is the run's `state_reason`, the reason
 * given with its last state change. The same reader and the same `not_found`
 * as `listProjectAgents`. The membership check and both lists are read in
 * one read-only `REPEATABLE READ` transaction, from one snapshot, so that a
 * run that finishes while they are read is listed once, as the protocol's
 * answer requires.
 */
export async function listProjectRuns(
  db: Database,
  input: ProjectActivityInput,
): Promise<ListProjectRunsResult> {
  return inSnapshot(db, listRunsIn(input));
}

function listRunsIn(input: ProjectActivityInput) {
  return async (db: Database): Promise<ListProjectRunsResult> => {
    if (!(await readable(db, input))) {
      return NOT_FOUND;
    }
    const unfinished = await db
      .select(runColumns)
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.projectId, input.projectId),
          isNull(agentRuns.finishedAt),
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(MAX_ANSWER_LIST_ITEMS);
    const finished = await db
      .select(runColumns)
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.projectId, input.projectId),
          isNotNull(agentRuns.finishedAt),
        ),
      )
      .orderBy(desc(agentRuns.finishedAt), desc(agentRuns.id))
      .limit(RECENT_FINISHED_RUNS);
    return {
      listed: true,
      unfinishedRuns: unfinished.map(toRunListItem),
      finishedRuns: finished.map(toRunListItem),
    };
  };
}
