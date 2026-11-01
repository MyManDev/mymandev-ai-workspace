import type {
  AgentId,
  CorrelationId,
  PermissionGrantId,
  ProjectId,
  RepositoryId,
  RunCancelReason,
  RunId,
  UserId,
  WorkspaceId,
} from "@mymandev/protocol";
import {
  and,
  type Column,
  eq,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "./db.ts";
import {
  agentRuns,
  agents,
  permissionGrants,
  projects,
} from "./schema/index.ts";

// The writes that revoking a device and removing a person share (ADR 0014,
// "Revocation, sign-out, and recovery" and "Removal and ownership", P-60;
// ADR 0015, P-77): disabling agents, revoking their active grants, and
// cancelling unfinished runs. Each step reads the rows it changes with
// `FOR NO KEY UPDATE`, the lock that their update takes, in the order of
// their IDs, and updates exactly those rows. Every transaction that uses
// these steps takes them in this order, agents, then grants, then runs, so
// two of them that touch the same rows lock them in the same order and
// cannot deadlock, whatever the plans of their queries. PostgreSQL checks a
// row that changed while it waited for the lock again, so a row that a
// concurrent transaction already changed is neither reported nor changed.

/**
 * `column = any($1::uuid[])`: the IDs travel as one array parameter, so that
 * no list of IDs, however long, reaches PostgreSQL's limit of 65,535
 * parameters per statement. node-postgres and PGlite both send a JavaScript
 * array as one PostgreSQL array value; drizzle's `inArray` would bind one
 * parameter per ID.
 */
export function idIn(column: Column, ids: readonly string[]): SQL {
  return sql`${column} = any(${sql.param(ids)}::uuid[])`;
}

/** Run states that have not finished; a revocation or a removal cancels them (P-60). */
const UNFINISHED_STATES = ["queued", "running", "awaiting_input"] as const;

/** The state of a run that has not finished. */
export type UnfinishedRunState = (typeof UNFINISHED_STATES)[number];

const unfinishedStates: ReadonlySet<string> = new Set(UNFINISHED_STATES);

function isUnfinished(state: string): state is UnfinishedRunState {
  return unfinishedStates.has(state);
}

/**
 * A run that a revocation or a removal cancelled, with what the server's
 * `agent.run.state_changed` event about it needs: the run, its agent, its
 * repository and correlation ID when it has them, the state it had before,
 * the workspace whose members are told, and the reason code stored with it.
 */
export type CancelledRun = Readonly<{
  runId: RunId;
  agentId: AgentId;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  repositoryId: RepositoryId | null;
  correlationId: CorrelationId | null;
  previousState: UnfinishedRunState;
  reason: RunCancelReason;
}>;

/** Disables the agents that `which` selects and that are not disabled yet; returns their IDs in order. */
export async function disableAgents(
  tx: Database,
  which: SQL | undefined,
  now: Date,
): Promise<AgentId[]> {
  const rows = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(which, isNull(agents.disabledAt)))
    .orderBy(agents.id)
    .for("no key update");
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await tx
      .update(agents)
      .set({ disabledAt: now, updatedAt: now })
      .where(idIn(agents.id, ids));
  }
  return ids;
}

/**
 * Revokes the grants that `which` selects and that are not revoked yet, with
 * `revokedBy` as `revoked_by_user_id` (ADR 0015, P-77); returns their IDs in
 * order. An expired grant that was never revoked is revoked too.
 */
export async function revokeGrants(
  tx: Database,
  which: SQL | undefined,
  revokedBy: UserId,
  now: Date,
): Promise<PermissionGrantId[]> {
  const rows = await tx
    .select({ id: permissionGrants.id })
    .from(permissionGrants)
    .where(and(which, isNull(permissionGrants.revokedAt)))
    .orderBy(permissionGrants.id)
    .for("no key update");
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await tx
      .update(permissionGrants)
      .set({ revokedAt: now, revokedByUserId: revokedBy })
      .where(idIn(permissionGrants.id, ids));
  }
  return ids;
}

/**
 * Moves the unfinished runs that `which` selects to `cancelled` with the
 * reason code `reason` and `finished_at` set to `now` (P-60). Each run is
 * read with the state it had and its project's workspace before it is
 * updated, and the result is frozen and in the order of the run IDs. The
 * caller sends the run events after the commit; the server's `system` actor
 * is their author.
 */
export async function cancelRuns(
  tx: Database,
  which: SQL | undefined,
  reason: RunCancelReason,
  now: Date,
): Promise<readonly CancelledRun[]> {
  const unfinished = await tx
    .select({
      runId: agentRuns.id,
      agentId: agentRuns.agentId,
      projectId: agentRuns.projectId,
      workspaceId: projects.workspaceId,
      repositoryId: agentRuns.repositoryId,
      correlationId: agentRuns.correlationId,
      previousState: agentRuns.state,
    })
    .from(agentRuns)
    .innerJoin(projects, eq(projects.id, agentRuns.projectId))
    .where(and(which, inArray(agentRuns.state, [...UNFINISHED_STATES])))
    .orderBy(agentRuns.id)
    .for("no key update", { of: agentRuns });
  const cancelled: CancelledRun[] = [];
  for (const { previousState, ...run } of unfinished) {
    if (isUnfinished(previousState)) {
      cancelled.push(Object.freeze({ ...run, previousState, reason }));
    }
  }
  if (cancelled.length > 0) {
    await tx
      .update(agentRuns)
      .set({ state: "cancelled", stateReason: reason, finishedAt: now })
      .where(
        idIn(
          agentRuns.id,
          cancelled.map((run) => run.runId),
        ),
      );
  }
  return Object.freeze(cancelled);
}
