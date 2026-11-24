import type {
  AgentId,
  AgentListItem,
  CorrelationId,
  MemberId,
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
  desc,
  eq,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "./db.ts";
import {
  agentRuns,
  agents,
  permissionGrants,
  projects,
  workspaceMembers,
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
// An erasure (`src/account-erasure.ts`) takes these steps once per removal
// and per device revocation in one transaction. It locks every agent of the
// account before all of them, so no agent comes after a grant or a run, but
// the grants and runs of one removal come after the runs of the one before.
// Every other transaction that changes those rows locks the erased account,
// or one of its people, first, where it waits for the erasure.

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
 * An agent that a change disabled, with what the server's
 * `workspace.agent.disabled` about it needs (#326): the workspace of its
 * project, whose members are told, and the agent as the agent list shows it
 * (`listProjectAgents`), with `disabledAt` as the change stored it. It
 * names no host device, which is device data (#110).
 */
export type DisabledAgent = Readonly<{
  workspaceId: WorkspaceId;
  agent: AgentListItem;
}>;

const owner = alias(workspaceMembers, "owner");

/**
 * The agents with these IDs that are disabled, each with what its
 * `workspace.agent.disabled` needs, in the order of their IDs (#326). A
 * change that disabled agents through `disableAgents`, a device revocation
 * or a removal of a person, reads them with this inside its own transaction,
 * after the disabling, so that the API sends one event per agent after the
 * commit to the members of the agent's own workspace: a device revocation
 * can disable agents in several workspaces. An agent's project, owner, and
 * name never change, and its `disabled_at` is set once, so the read gives
 * what the change wrote. The owner's person is the account's active person
 * in the workspace, or else its most recently removed one, as
 * `listProjectAgents` shows it, so after a removal it is the removed person.
 * It locks nothing; the change holds the agents' locks already. An ID that
 * names no agent, an agent that is not disabled, or an owner without a
 * person in the workspace breaks that invariant and throws, rather than
 * leave a disabling without its event.
 */
export async function disabledAgentsOf(
  tx: Database,
  ids: readonly AgentId[],
): Promise<readonly DisabledAgent[]> {
  if (ids.length === 0) {
    return Object.freeze([]);
  }
  const ownerPerson = tx
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
  const rows = await tx
    .select({
      id: agents.id,
      projectId: agents.projectId,
      workspaceId: projects.workspaceId,
      name: agents.name,
      ownerMemberId: sql<MemberId | null>`(${ownerPerson})`,
      disabledAt: agents.disabledAt,
    })
    .from(agents)
    .innerJoin(projects, eq(projects.id, agents.projectId))
    .where(idIn(agents.id, ids))
    .orderBy(agents.id);
  const disabled = rows.flatMap(
    ({ workspaceId, ownerMemberId, disabledAt, ...agent }) =>
      ownerMemberId === null || disabledAt === null
        ? []
        : [
            Object.freeze({
              workspaceId,
              agent: Object.freeze({
                ...agent,
                ownerMemberId,
                disabledAt: disabledAt.toISOString(),
              }),
            }),
          ],
  );
  if (disabled.length !== ids.length) {
    throw new Error(
      `Invariant broken: ${ids.length} disabled agents were asked for, ${disabled.length} were found`,
    );
  }
  return Object.freeze(disabled);
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
 * A grant that a change revoked, with what the server's `agent.grant.revoked`
 * about it needs (#75): the grant, its agent, the workspace of its project,
 * whose members are told, and the time stored as `revoked_at`.
 */
export type RevokedGrant = Readonly<{
  grantId: PermissionGrantId;
  granteeAgentId: AgentId;
  workspaceId: WorkspaceId;
  revokedAt: Date;
}>;

/**
 * The grants with these IDs that are revoked, each with what its
 * `agent.grant.revoked` needs, in the order of their IDs (#75). A change that
 * revoked grants through `revokeGrants` reads them with this inside its own
 * transaction, after the revocation, so that the API sends one event per
 * grant after the commit (ADR 0015, update of 2026-11-14) to the members of
 * the grant's own workspace: a device revocation can revoke grants in
 * several workspaces. A grant's agent and project never change, and its
 * `revoked_at` is set once, so the read gives what the change wrote. It
 * locks nothing; the change holds the grants' locks already. An ID that
 * names no grant, or a grant that is not revoked, breaks that invariant and
 * throws, rather than leave a revocation without its event.
 */
export async function revokedGrantsOf(
  tx: Database,
  ids: readonly PermissionGrantId[],
): Promise<readonly RevokedGrant[]> {
  if (ids.length === 0) {
    return Object.freeze([]);
  }
  const rows = await tx
    .select({
      grantId: permissionGrants.id,
      granteeAgentId: permissionGrants.granteeAgentId,
      workspaceId: projects.workspaceId,
      revokedAt: permissionGrants.revokedAt,
    })
    .from(permissionGrants)
    .innerJoin(projects, eq(projects.id, permissionGrants.projectId))
    .where(idIn(permissionGrants.id, ids))
    .orderBy(permissionGrants.id);
  const revoked = rows.flatMap(({ revokedAt, ...grant }) =>
    revokedAt === null ? [] : [Object.freeze({ ...grant, revokedAt })],
  );
  if (revoked.length !== ids.length) {
    throw new Error(
      `Invariant broken: ${ids.length} revoked grants were asked for, ${revoked.length} were found`,
    );
  }
  return Object.freeze(revoked);
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
