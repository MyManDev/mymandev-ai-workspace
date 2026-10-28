import type {
  AgentId,
  Capability,
  CorrelationId,
  DeviceId,
  ProjectId,
  RepositoryId,
  RunId,
  RunState,
  UserId,
} from "@mymandev/protocol";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, nullableTimestamp, updatedAt } from "./columns.ts";
import { devices, users } from "./identity.ts";
import { projects, repositories } from "./workspaces.ts";

/**
 * An agent runs on its host device, where provider credentials stay. The
 * provider kind is deferred to M3.
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().$type<AgentId>(),
    projectId: uuid("project_id")
      .notNull()
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "restrict" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    hostDeviceId: uuid("host_device_id")
      .notNull()
      .$type<DeviceId>()
      .references(() => devices.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    disabledAt: nullableTimestamp("disabled_at"),
  },
  (t) => [
    index("agents_project_id_idx").on(t.projectId),
    index("agents_host_device_id_idx").on(t.hostDeviceId),
    // Targets of composite foreign keys from grants, runs and messages.
    unique("agents_id_project_id_key").on(t.id, t.projectId),
    unique("agents_id_host_device_id_key").on(t.id, t.hostDeviceId),
    unique("agents_id_owner_user_id_key").on(t.id, t.ownerUserId),
    // The host device belongs to the agent's owner.
    foreignKey({
      name: "agents_host_device_owner_fk",
      columns: [t.hostDeviceId, t.ownerUserId],
      foreignColumns: [devices.id, devices.userId],
    }).onDelete("restrict"),
    check("agents_name_length", sql`char_length(${t.name}) between 1 and 64`),
  ],
);

/**
 * One run of an agent. The server creates runs; a retry is a new run linked
 * through `correlation_id`. The transition rules live in the protocol.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().$type<RunId>(),
    agentId: uuid("agent_id")
      .notNull()
      .$type<AgentId>()
      .references(() => agents.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "restrict" }),
    repositoryId: uuid("repository_id")
      .$type<RepositoryId>()
      .references(() => repositories.id, { onDelete: "restrict" }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    correlationId: uuid("correlation_id").$type<CorrelationId>(),
    state: text("state").notNull().$type<RunState>(),
    stateReason: text("state_reason"),
    createdAt: createdAt(),
    startedAt: nullableTimestamp("started_at"),
    finishedAt: nullableTimestamp("finished_at"),
  },
  (t) => [
    index("agent_runs_agent_id_created_at_idx").on(t.agentId, t.createdAt),
    index("agent_runs_project_id_state_idx").on(t.projectId, t.state),
    check(
      "agent_runs_state_check",
      sql`${t.state} in ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled')`,
    ),
    // finished_at is set exactly when the state is terminal.
    check(
      "agent_runs_finished_at_check",
      sql`(${t.state} in ('completed', 'failed', 'cancelled')) = (${t.finishedAt} is not null)`,
    ),
    // A null reason passes the check; a reason that is set has 1 to 500 characters.
    check(
      "agent_runs_state_reason_length",
      sql`char_length(${t.stateReason}) between 1 and 500`,
    ),
    // The run is recorded in the project of its agent.
    foreignKey({
      name: "agent_runs_agent_project_fk",
      columns: [t.agentId, t.projectId],
      foreignColumns: [agents.id, agents.projectId],
    }).onDelete("restrict"),
    // The repository, when set, belongs to the project of the run.
    foreignKey({
      name: "agent_runs_repository_project_fk",
      columns: [t.repositoryId, t.projectId],
      foreignColumns: [repositories.id, repositories.projectId],
    }).onDelete("restrict"),
  ],
);

/**
 * One row grants exactly one capability to one agent, matched exactly. This
 * table is provisional until the capability and permission contract (M1-06)
 * is agreed (P-34). The single definition of an active grant belongs to the
 * permissions package (M1-06), not to this table.
 */
export const permissionGrants = pgTable(
  "permission_grants",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "restrict" }),
    granteeAgentId: uuid("grantee_agent_id")
      .notNull()
      .$type<AgentId>()
      .references(() => agents.id, { onDelete: "restrict" }),
    capability: text("capability").notNull().$type<Capability>(),
    repositoryId: uuid("repository_id")
      .$type<RepositoryId>()
      .references(() => repositories.id, { onDelete: "restrict" }),
    grantedByUserId: uuid("granted_by_user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    expiresAt: nullableTimestamp("expires_at"),
    revokedAt: nullableTimestamp("revoked_at"),
    revokedByUserId: uuid("revoked_by_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("permission_grants_project_id_idx").on(t.projectId),
    check(
      "permission_grants_capability_check",
      sql`${t.capability} in ('repo.read', 'repo.write', 'terminal.execute', 'git.commit', 'git.push', 'provider.use')`,
    ),
    // provider.use is scoped to a provider connection (M1-06), every other capability to a repository.
    check(
      "permission_grants_scope_check",
      sql`(${t.capability} = 'provider.use') = (${t.repositoryId} is null)`,
    ),
    check(
      "permission_grants_revocation_check",
      sql`(${t.revokedAt} is null) = (${t.revokedByUserId} is null)`,
    ),
    check(
      "permission_grants_expiry_check",
      sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.createdAt}`,
    ),
    // One non-revoked grant per agent, capability and repository. An expired
    // grant keeps its slot until it is revoked, because an index predicate
    // cannot use now().
    uniqueIndex("permission_grants_active_repository_key")
      .on(t.granteeAgentId, t.capability, t.repositoryId)
      .where(sql`${t.revokedAt} is null and ${t.repositoryId} is not null`),
    uniqueIndex("permission_grants_active_unscoped_key")
      .on(t.granteeAgentId, t.capability)
      .where(sql`${t.revokedAt} is null and ${t.repositoryId} is null`),
    // The grant is recorded in the project of its agent.
    foreignKey({
      name: "permission_grants_agent_project_fk",
      columns: [t.granteeAgentId, t.projectId],
      foreignColumns: [agents.id, agents.projectId],
    }).onDelete("restrict"),
    // The repository, when set, belongs to the project of the grant.
    foreignKey({
      name: "permission_grants_repository_project_fk",
      columns: [t.repositoryId, t.projectId],
      foreignColumns: [repositories.id, repositories.projectId],
    }).onDelete("restrict"),
    // In v0 only the owner of the agent grants it a capability (P-44).
    foreignKey({
      name: "permission_grants_agent_owner_fk",
      columns: [t.granteeAgentId, t.grantedByUserId],
      foreignColumns: [agents.id, agents.ownerUserId],
    }).onDelete("restrict"),
  ],
);
