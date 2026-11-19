import {
  type AgentId,
  type DeviceId,
  GRANT_COUNT_LIMITS,
  type GrantCapabilityRequest,
  type GrantRecord,
  MAX_ANSWER_LIST_ITEMS,
  type MemberId,
  newId,
  type PermissionGrant,
  type PermissionGrantId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, eq, isNull, ne, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { revokeGrants } from "./cascade.ts";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import {
  agents,
  devices,
  permissionGrants,
  projects,
  providerConnections,
  repositories,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";

// The grants of an agent: granting a capability, revoking a grant, and the
// grant records of the agents that a device hosts (#75; ADR 0015, P-74 to
// P-80; Project Manager decisions of 2026-11-02 and 2026-11-14). The routes
// and their codes are the protocol's `GRANT_ROUTES` and `GRANT_ROUTE_ERRORS`.
// Only the agent's owner grants and revokes (P-44), and only from the agent's
// host device it grants. A grant of `terminal.execute` expires within 30 days,
// which the CHECK `permission_grants_shell_expiry_check` holds as well.
//
// Rules for code that writes grants (P-77), which these functions follow: a
// row never changes after its insert, except that `revoked_at` and
// `revoked_by_user_id` are set once, through `revokeGrants` of
// `src/cascade.ts`; an expired grant is renewed by revoking it and inserting
// a new row in the same transaction, and `expires_at` is never extended. The
// trigger `permission_grants_immutable` of migration
// `0017_grant_immutability` refuses any other update, for every role.
//
// Lock order, the order of `src/people.ts` and `src/repositories.ts`
// extended: the account (`users`) and then the device (`devices`), as
// `lockActor` in the API does; then the agent's owner's person
// (`workspace_members`); then the project; then the repository or the
// provider connection; then the agent; then the grant. A grant locks the
// calling device `FOR NO KEY UPDATE` itself, which the API's `lockActor`
// already holds, so that the grants of one host device are counted one
// after another (`GRANT_COUNT_LIMITS`); it is the only device that may
// grant to the agents it hosts. A device revocation locks the device first
// too, and then the agents and the grants (`src/cascade.ts`), so either the
// revocation commits first and the grant finds the agent disabled, or the
// grant commits first and the revocation revokes it. An erasure locks the
// account's devices before its people as well. Then the grant locks the
// owner's person, the project, the repository or the provider connection,
// and the agent `FOR SHARE`, as `src/people.ts` and `src/repositories.ts`
// ask of a writer that inserts a grant, and checks each: a removal of the
// person, of the repository, or of the agent's host device holds its row
// `FOR NO KEY UPDATE`, so it either commits first and the grant is refused,
// or waits and then revokes the new grant. The workspace row is read with
// the project, not locked: only an erasure archives a workspace. An erasure
// of the owner's account locks its devices first, where it meets the grant,
// and an erasure of another account archives no workspace in which another
// active, claimed person remains, as the owner's person that the grant holds
// is. A revocation locks the owner's person `FOR SHARE` and
// then the grant `FOR NO KEY UPDATE`, the order of a removal, which locks the
// person, the agents, and then their grants.
//
// A disabled account is the API's check: `lockActor` locks the account
// first and refuses a disabled one, and `disableAccount` updates the
// account's row before it revokes the grants of its agents, so the two run
// one after another.
//
// Provisional (#75): who revokes (the owner only, from any of its devices,
// recommendation 4), the count limits, the order of the refusals, and the
// order of the records (by grant ID) are settled here with the conservative
// option and await the Project Manager's confirmation.

/** Why a grant or a revocation was refused. Nothing was written. */
export type GrantRefusal = "not_found" | "forbidden" | "conflict";

type GrantRow = typeof permissionGrants.$inferSelect;

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * A row as the protocol's `PermissionGrant`. The scope CHECK gives every row
 * exactly the scope of its capability; a row without it breaks that
 * invariant and throws.
 */
function grantOf(row: GrantRow): PermissionGrant {
  const header = {
    id: row.id,
    projectId: row.projectId,
    granteeAgentId: row.granteeAgentId,
    grantedByUserId: row.grantedByUserId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: isoOrNull(row.expiresAt),
    revokedAt: isoOrNull(row.revokedAt),
    revokedByUserId: row.revokedByUserId,
  };
  if (row.capability === "provider.use") {
    if (row.providerConnectionId === null) {
      throw new Error(
        "Invariant broken: a provider.use grant names no provider connection",
      );
    }
    return {
      ...header,
      capability: row.capability,
      providerConnectionId: row.providerConnectionId,
    };
  }
  if (row.repositoryId === null) {
    throw new Error("Invariant broken: a repository grant names no repository");
  }
  return {
    ...header,
    capability: row.capability,
    repositoryId: row.repositoryId,
  };
}

/** Whether a grant has expired at `now`: half-open, as `isGrantActive` judges it (P-73). */
function hasExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}

type LockedOwner = Readonly<{
  workspaceId: WorkspaceId;
  projectId: GrantRow["projectId"];
  ownerUserId: UserId;
  hostDeviceId: DeviceId;
}>;

/**
 * Reads the agent with its project's workspace, then locks the account's
 * active person in that workspace `FOR SHARE`. An agent's project, owner, and
 * host device never change, so they are read before the lock. undefined when
 * the agent does not exist or the account has no active person in its
 * workspace: the same `not_found`, so that an agent ID cannot be probed.
 */
async function lockPersonOfAgent(
  tx: Database,
  input: Readonly<{ agentId: AgentId; userId: UserId }>,
): Promise<LockedOwner | undefined> {
  const [agent] = await tx
    .select({
      workspaceId: projects.workspaceId,
      projectId: agents.projectId,
      ownerUserId: agents.ownerUserId,
      hostDeviceId: agents.hostDeviceId,
    })
    .from(agents)
    .innerJoin(projects, eq(projects.id, agents.projectId))
    .where(eq(agents.id, input.agentId));
  if (agent === undefined) {
    return undefined;
  }
  const [person] = await tx
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, agent.workspaceId),
        eq(workspaceMembers.userId, input.userId),
        isNull(workspaceMembers.removedAt),
      ),
    )
    .for("share");
  return person === undefined ? undefined : agent;
}

export type GrantCapabilityInput = Readonly<{
  agentId: AgentId;
  /** The acting account; it must be the agent's owner. */
  userId: UserId;
  /** The calling device; it must be the agent's host device. */
  deviceId: DeviceId;
  /** The parsed request of `POST /agents/:agentId/grants`. */
  grant: GrantCapabilityRequest;
  now: Date;
}>;

export type GrantCapabilityResult =
  | Readonly<{
      granted: true;
      /** The agent's workspace, whose subscribers the caller tells. */
      workspaceId: WorkspaceId;
      /** The new grant, not revoked. */
      grant: PermissionGrant;
      /**
       * The expired grant of the same capability on the same scope that the
       * new grant replaced, now revoked at `now` by the acting account, or
       * null. The caller sends its `agent.grant.revoked` before the new
       * grant's `agent.grant.created`.
       */
      replaced: PermissionGrant | null;
    }>
  | Readonly<{
      granted: false;
      /**
       * `not_found`: the agent does not exist or is in a workspace that the
       * account is not an active member of, or the scope is not a repository
       * of the agent's project or a provider connection of the agent's host
       * device; `forbidden`: the account is not the agent's owner, or the
       * calling device is not the agent's host device; `conflict`: a disabled
       * agent, an archived workspace, project, or repository, a removed
       * provider connection, or a grant of the same capability on the same
       * scope that is neither revoked nor expired; `grant_limit`: a count
       * limit of `GRANT_COUNT_LIMITS`, which no time frees.
       */
      refusal: GrantRefusal | "grant_limit";
    }>;

/**
 * The grant of the same capability on the same scope to the agent that is
 * not revoked: at most one, by the partial unique indexes.
 */
function sameScope(
  agentId: AgentId,
  request: GrantCapabilityRequest,
): SQL | undefined {
  return and(
    eq(permissionGrants.granteeAgentId, agentId),
    eq(permissionGrants.capability, request.capability),
    "repositoryId" in request
      ? eq(permissionGrants.repositoryId, request.repositoryId)
      : eq(permissionGrants.providerConnectionId, request.providerConnectionId),
    isNull(permissionGrants.revokedAt),
  );
}

/**
 * Grants one capability on one scope to an agent in one transaction (#75):
 * only the agent's owner, from the agent's host device. It locks the calling
 * device `FOR NO KEY UPDATE`, then the owner's active person, the project,
 * the repository or the provider connection, and the agent, each `FOR
 * SHARE`, as the lock order above says, and decides in this order:
 * `not_found` for an unknown agent or an account without an active person in
 * its workspace; `forbidden` for an account that is not the agent's owner,
 * then for a calling device that is not its host device; `not_found` for a
 * scope that is not the agent's project's repository or its host device's
 * provider connection; `conflict` for a disabled agent, an archived workspace
 * or project, a removed repository or provider connection, and then for a
 * grant of the same capability on the same scope that is neither revoked nor
 * expired; and `grant_limit` when the agent holds `GRANT_COUNT_LIMITS.perAgent`
 * grants that are not revoked, or the agents of the host device hold
 * `GRANT_COUNT_LIMITS.perHostDevice`, an expired grant included until it is
 * revoked. An expired grant of the same capability on the same scope does
 * not count: it is revoked, with the account as the revoker, and replaced in
 * the same transaction (P-77). The new grant gets `created_at` `now` and
 * `expires_at` `now` plus `lifetimeSeconds`, or null. Inside another
 * transaction it runs as a savepoint.
 */
export async function grantCapability(
  db: Database,
  input: GrantCapabilityInput,
): Promise<GrantCapabilityResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<GrantCapabilityResult> => {
      const refuse = (refusal: GrantRefusal | "grant_limit") =>
        ({ granted: false, refusal }) as const;
      await tx
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.id, input.deviceId))
        .for("no key update");
      const owner = await lockPersonOfAgent(tx, input);
      if (owner === undefined) {
        return refuse("not_found");
      }
      if (owner.ownerUserId !== input.userId) {
        return refuse("forbidden");
      }
      if (owner.hostDeviceId !== input.deviceId) {
        return refuse("forbidden");
      }
      // Projects are never deleted, so the agent's project is there.
      const [project] = await tx
        .select({
          archivedAt: projects.archivedAt,
          workspaceArchivedAt: workspaces.archivedAt,
        })
        .from(projects)
        .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
        .where(eq(projects.id, owner.projectId))
        .for("share", { of: projects });
      const request = input.grant;
      const [scope] =
        "repositoryId" in request
          ? await tx
              .select({ endedAt: repositories.archivedAt })
              .from(repositories)
              .where(
                and(
                  eq(repositories.id, request.repositoryId),
                  eq(repositories.projectId, owner.projectId),
                ),
              )
              .for("share")
          : await tx
              .select({ endedAt: providerConnections.removedAt })
              .from(providerConnections)
              .where(
                and(
                  eq(providerConnections.id, request.providerConnectionId),
                  eq(providerConnections.hostDeviceId, owner.hostDeviceId),
                ),
              )
              .for("share");
      if (scope === undefined) {
        return refuse("not_found");
      }
      const [agent] = await tx
        .select({ disabledAt: agents.disabledAt })
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .for("share");
      if (
        agent?.disabledAt !== null ||
        project?.workspaceArchivedAt !== null ||
        project.archivedAt !== null ||
        scope.endedAt !== null
      ) {
        return refuse("conflict");
      }

      const [same] = await tx
        .select({
          id: permissionGrants.id,
          expiresAt: permissionGrants.expiresAt,
        })
        .from(permissionGrants)
        .where(sameScope(input.agentId, request))
        .for("no key update");
      if (same !== undefined && !hasExpired(same.expiresAt, input.now)) {
        return refuse("conflict");
      }
      // The grants that are not revoked, except an expired one that this
      // grant replaces.
      const [held] = await tx
        .select({
          ofAgent: sql<number>`count(*) filter (where ${eq(permissionGrants.granteeAgentId, input.agentId)})::int`,
          ofDevice: sql<number>`count(*)::int`,
        })
        .from(permissionGrants)
        .where(
          and(
            eq(permissionGrants.hostDeviceId, owner.hostDeviceId),
            isNull(permissionGrants.revokedAt),
            same === undefined ? undefined : ne(permissionGrants.id, same.id),
          ),
        );
      if (
        (held?.ofAgent ?? 0) >= GRANT_COUNT_LIMITS.perAgent ||
        (held?.ofDevice ?? 0) >= GRANT_COUNT_LIMITS.perHostDevice
      ) {
        return refuse("grant_limit");
      }

      let replaced: PermissionGrant | null = null;
      if (same !== undefined) {
        await revokeGrants(
          tx,
          eq(permissionGrants.id, same.id),
          input.userId,
          input.now,
        );
        const [row] = await tx
          .select()
          .from(permissionGrants)
          .where(eq(permissionGrants.id, same.id));
        replaced = row === undefined ? null : grantOf(row);
      }
      const [inserted] = await tx
        .insert(permissionGrants)
        .values({
          id: newId<PermissionGrantId>(),
          projectId: owner.projectId,
          granteeAgentId: input.agentId,
          hostDeviceId: owner.hostDeviceId,
          capability: request.capability,
          repositoryId: "repositoryId" in request ? request.repositoryId : null,
          providerConnectionId:
            "providerConnectionId" in request
              ? request.providerConnectionId
              : null,
          grantedByUserId: input.userId,
          createdAt: input.now,
          expiresAt:
            request.lifetimeSeconds === null
              ? null
              : new Date(input.now.getTime() + request.lifetimeSeconds * 1000),
        })
        .returning();
      if (inserted === undefined) {
        throw new Error("The insert of a grant returned no row");
      }
      return {
        granted: true,
        workspaceId: owner.workspaceId,
        grant: grantOf(inserted),
        replaced,
      };
    }),
  );
}

export type RevokeGrantInput = Readonly<{
  agentId: AgentId;
  grantId: PermissionGrantId;
  /** The acting account; it must be the agent's owner, on any of its devices. */
  userId: UserId;
  now: Date;
}>;

export type RevokeGrantResult =
  | Readonly<{
      revoked: true;
      /** The agent's workspace, whose subscribers the caller tells. */
      workspaceId: WorkspaceId;
      /** The grant as it is now: revoked at `now` by the acting account. */
      grant: PermissionGrant;
    }>
  | Readonly<{
      revoked: false;
      /**
       * `not_found`: the agent does not exist or is in a workspace that the
       * account is not an active member of, or the agent has no grant with
       * this ID; `forbidden`: the account is not the agent's owner;
       * `conflict`: the grant is already revoked.
       */
      refusal: GrantRefusal;
    }>;

/**
 * Revokes a grant of an agent in one transaction (#75): only the agent's
 * owner, from any of its devices, also a grant that has expired. It locks
 * the account's active person `FOR SHARE`, then the grant `FOR NO KEY
 * UPDATE`, and decides in this order: `not_found` for an unknown agent or an
 * account without an active person in its workspace, `forbidden` for an
 * account that is not the agent's owner, `not_found` for a grant that the
 * agent does not have, and `conflict` for a grant that is already revoked.
 * It sets only `revoked_at` to `now` and `revoked_by_user_id` to the account
 * (`revokeGrants`); revocation is one-way (P-77). Inside another transaction
 * it runs as a savepoint.
 */
export async function revokeGrant(
  db: Database,
  input: RevokeGrantInput,
): Promise<RevokeGrantResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<RevokeGrantResult> => {
      const refuse = (refusal: GrantRefusal) =>
        ({ revoked: false, refusal }) as const;
      const owner = await lockPersonOfAgent(tx, input);
      if (owner === undefined) {
        return refuse("not_found");
      }
      if (owner.ownerUserId !== input.userId) {
        return refuse("forbidden");
      }
      const ofAgent = and(
        eq(permissionGrants.id, input.grantId),
        eq(permissionGrants.granteeAgentId, input.agentId),
      );
      const [grant] = await tx
        .select({ revokedAt: permissionGrants.revokedAt })
        .from(permissionGrants)
        .where(ofAgent)
        .for("no key update");
      if (grant === undefined) {
        return refuse("not_found");
      }
      if (grant.revokedAt !== null) {
        return refuse("conflict");
      }
      await revokeGrants(tx, ofAgent, input.userId, input.now);
      const [row] = await tx
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.id, input.grantId));
      if (row === undefined) {
        throw new Error("A revoked grant was not found again");
      }
      return {
        revoked: true,
        workspaceId: owner.workspaceId,
        grant: grantOf(row),
      };
    }),
  );
}

export type ListGrantRecordsInput = Readonly<{
  /** The reading account; the calling device must be its own. */
  userId: UserId;
  /** The calling device, whose hosted agents' grants are listed. */
  deviceId: DeviceId;
}>;

const grantor = alias(workspaceMembers, "grantor");
const grantorFact = alias(workspaceMembers, "grantor_fact");

/**
 * The grant records of the agents that the calling device hosts, the answer
 * of `GET /grant-records` (#75; ADR 0015, P-74, P-76): every grant of those
 * agents that is not revoked, an expired one included, each with the facts
 * that `isGrantActive` judges it on, in the order of the grant IDs. A device
 * of another account, and a device that hosts no agent, get none. The list
 * leaves revoked grants out (Project Manager decision of 2026-11-14, the
 * stated exception to P-74); it selects by no other lifecycle column.
 *
 * It is one statement, so every record comes from one snapshot, even under
 * READ COMMITTED, without a REPEATABLE READ transaction and its extra round
 * trips. The membership fact is the granting account's person in the
 * workspace of the grant's project: its active person, or else its most
 * recently removed one, as P-74 asks and `listRepositories` finds a
 * registrant. It is chosen by one subquery, so a person who left and joined
 * again, and so has several rows, gives each grant once.
 *
 * The count limit of a host device keeps the list within
 * `MAX_ANSWER_LIST_ITEMS`, and the list is never cut, because a record left
 * out would deny a check: a list over it breaks that invariant and throws.
 */
export async function listGrantRecords(
  db: Database,
  input: ListGrantRecordsInput,
): Promise<GrantRecord[]> {
  const rows = await withDatabaseErrors(() => {
    const chosenPerson = db
      .select({ id: grantor.id })
      .from(grantor)
      .where(
        and(
          eq(grantor.workspaceId, projects.workspaceId),
          eq(grantor.userId, permissionGrants.grantedByUserId),
        ),
      )
      .orderBy(
        sql`${grantor.removedAt} desc nulls first`,
        sql`${grantor.id} desc`,
      )
      .limit(1);
    return db
      .select({
        grant: permissionGrants,
        agent: {
          id: agents.id,
          hostDeviceId: agents.hostDeviceId,
          disabledAt: agents.disabledAt,
        },
        hostDevice: { id: devices.id, revokedAt: devices.revokedAt },
        project: { id: projects.id, workspaceId: projects.workspaceId },
        grantorMembership: {
          workspaceId: grantorFact.workspaceId,
          userId: grantorFact.userId,
          removedAt: grantorFact.removedAt,
        },
        providerConnection: {
          id: providerConnections.id,
          hostDeviceId: providerConnections.hostDeviceId,
          removedAt: providerConnections.removedAt,
        },
      })
      .from(permissionGrants)
      .innerJoin(agents, eq(agents.id, permissionGrants.granteeAgentId))
      .innerJoin(devices, eq(devices.id, agents.hostDeviceId))
      .innerJoin(projects, eq(projects.id, permissionGrants.projectId))
      .leftJoin(
        grantorFact,
        eq(grantorFact.id, sql<MemberId>`(${chosenPerson})`),
      )
      .leftJoin(
        providerConnections,
        eq(providerConnections.id, permissionGrants.providerConnectionId),
      )
      .where(
        and(
          eq(permissionGrants.hostDeviceId, input.deviceId),
          eq(agents.hostDeviceId, input.deviceId),
          eq(devices.userId, input.userId),
          isNull(permissionGrants.revokedAt),
        ),
      )
      .orderBy(permissionGrants.id)
      .limit(MAX_ANSWER_LIST_ITEMS + 1);
  });
  // Outside `withDatabaseErrors`, so that the message reaches the log; it
  // holds no data of a row.
  if (rows.length > MAX_ANSWER_LIST_ITEMS) {
    throw new Error(
      "Invariant broken: a host device has more grant records than one answer holds",
    );
  }
  return rows.map((row) => ({
    grant: grantOf(row.grant),
    facts: {
      agent: { ...row.agent, disabledAt: isoOrNull(row.agent.disabledAt) },
      hostDevice: {
        ...row.hostDevice,
        revokedAt: isoOrNull(row.hostDevice.revokedAt),
      },
      project: row.project,
      grantorMembership:
        row.grantorMembership === null || row.grantorMembership.userId === null
          ? null
          : {
              workspaceId: row.grantorMembership.workspaceId,
              userId: row.grantorMembership.userId,
              removedAt: isoOrNull(row.grantorMembership.removedAt),
            },
      providerConnection:
        row.providerConnection === null
          ? null
          : {
              ...row.providerConnection,
              removedAt: isoOrNull(row.providerConnection.removedAt),
            },
    },
  }));
}
