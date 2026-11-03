import type {
  AgentId,
  Capability,
  CorrelationId,
  DeviceId,
  EventId,
  PermissionGrantId,
  ProjectId,
  ProviderConnectionId,
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
import { providerConnections } from "./providers.ts";
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
    // The most recently finished runs of a project (#28).
    index("agent_runs_project_id_finished_at_idx")
      .on(t.projectId, t.finishedAt, t.id)
      .where(sql`${t.finishedAt} is not null`),
    // Targets of composite foreign keys from the transition log (#28).
    unique("agent_runs_id_agent_id_key").on(t.id, t.agentId),
    unique("agent_runs_id_repository_id_key").on(t.id, t.repositoryId),
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
 * The log of accepted run transitions (#28): one row for each
 * `agent.run.state_changed` that an agent's host device sent and the server
 * applied, written in the transaction of the run's update. It holds what the
 * relayed event carries besides the run's workspace, which the run's project
 * names, so that a transition sent again with the same device and event ID
 * gets exactly the event that was relayed, and is never applied twice. The
 * server's own transitions (a run's creation, its cancellations) have no row.
 */
export const agentRunTransitions = pgTable(
  "agent_run_transitions",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .$type<RunId>()
      .references(() => agentRuns.id, { onDelete: "restrict" }),
    agentId: uuid("agent_id")
      .notNull()
      .$type<AgentId>()
      .references(() => agents.id, { onDelete: "restrict" }),
    /** The sending device: the authenticated connection's, never the event's `deviceId` field. */
    deviceId: uuid("device_id")
      .notNull()
      .$type<DeviceId>()
      .references(() => devices.id, { onDelete: "restrict" }),
    /** The event's ID, chosen by the device; unique per device only. */
    eventId: uuid("event_id").notNull().$type<EventId>(),
    /** The payload's `repositoryId` as sent: null when the event had none. */
    repositoryId: uuid("repository_id").$type<RepositoryId>(),
    previousState: text("previous_state").notNull().$type<RunState>(),
    state: text("state").notNull().$type<RunState>(),
    /** The payload's `reason` as sent: null when the event had none. */
    reason: text("reason"),
    /** The event's `occurredAt`, informational, with millisecond precision as the protocol has it. */
    occurredAt: nullableTimestamp("occurred_at").notNull(),
    /** Labels chosen by the device, relayed as sent and never used for lookups. */
    correlationId: uuid("correlation_id").$type<CorrelationId>(),
    causationId: uuid("causation_id").$type<EventId>(),
    /** When the server applied the transition. */
    createdAt: createdAt(),
  },
  (t) => [
    // The idempotency key: one accepted transition per device and event ID.
    unique("agent_run_transitions_device_event_key").on(t.deviceId, t.eventId),
    index("agent_run_transitions_run_id_idx").on(t.runId),
    check(
      "agent_run_transitions_previous_state_check",
      sql`${t.previousState} in ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "agent_run_transitions_state_check",
      sql`${t.state} in ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled')`,
    ),
    // Only the transitions that the protocol allows (ADR 0007); a device
    // never sends a run's creation.
    check(
      "agent_run_transitions_transition_check",
      sql`(${t.previousState}, ${t.state}) in (('queued', 'running'), ('queued', 'failed'), ('queued', 'cancelled'), ('running', 'awaiting_input'), ('running', 'completed'), ('running', 'failed'), ('running', 'cancelled'), ('awaiting_input', 'running'), ('awaiting_input', 'failed'), ('awaiting_input', 'cancelled'))`,
    ),
    // A null reason passes the check; a reason that is set has 1 to 500 characters.
    check(
      "agent_run_transitions_reason_length",
      sql`char_length(${t.reason}) between 1 and 500`,
    ),
    // The run is a run of the agent.
    foreignKey({
      name: "agent_run_transitions_run_agent_fk",
      columns: [t.runId, t.agentId],
      foreignColumns: [agentRuns.id, agentRuns.agentId],
    }).onDelete("restrict"),
    // The sending device hosts the agent.
    foreignKey({
      name: "agent_run_transitions_agent_host_device_fk",
      columns: [t.agentId, t.deviceId],
      foreignColumns: [agents.id, agents.hostDeviceId],
    }).onDelete("restrict"),
    // The repository, when sent, is the run's repository.
    foreignKey({
      name: "agent_run_transitions_run_repository_fk",
      columns: [t.runId, t.repositoryId],
      foreignColumns: [agentRuns.id, agentRuns.repositoryId],
    }).onDelete("restrict"),
  ],
);

/**
 * One row grants exactly one capability to one agent on exactly one scope,
 * matched exactly (ADR 0015). The single definition of an active grant
 * belongs to the permissions package, not to this table.
 */
export const permissionGrants = pgTable(
  "permission_grants",
  {
    id: uuid("id").primaryKey().$type<PermissionGrantId>(),
    projectId: uuid("project_id")
      .notNull()
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "restrict" }),
    granteeAgentId: uuid("grantee_agent_id")
      .notNull()
      .$type<AgentId>()
      .references(() => agents.id, { onDelete: "restrict" }),
    /** The host device of the grantee agent, recorded for composite foreign keys. */
    hostDeviceId: uuid("host_device_id").notNull().$type<DeviceId>(),
    capability: text("capability").notNull().$type<Capability>(),
    repositoryId: uuid("repository_id")
      .$type<RepositoryId>()
      .references(() => repositories.id, { onDelete: "restrict" }),
    providerConnectionId: uuid("provider_connection_id")
      .$type<ProviderConnectionId>()
      .references(() => providerConnections.id, { onDelete: "restrict" }),
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
    // Exactly one scope: provider.use is scoped to a provider connection, every
    // other capability to a repository (ADR 0015).
    check(
      "permission_grants_scope_check",
      sql`num_nonnulls(${t.repositoryId}, ${t.providerConnectionId}) = 1 and (${t.capability} = 'provider.use') = (${t.providerConnectionId} is not null)`,
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
    uniqueIndex("permission_grants_active_provider_connection_key")
      .on(t.granteeAgentId, t.capability, t.providerConnectionId)
      .where(
        sql`${t.revokedAt} is null and ${t.providerConnectionId} is not null`,
      ),
    // The grant is recorded in the project of its agent.
    foreignKey({
      name: "permission_grants_agent_project_fk",
      columns: [t.granteeAgentId, t.projectId],
      foreignColumns: [agents.id, agents.projectId],
    }).onDelete("restrict"),
    // host_device_id is the host device of the grantee agent.
    foreignKey({
      name: "permission_grants_agent_host_device_fk",
      columns: [t.granteeAgentId, t.hostDeviceId],
      foreignColumns: [agents.id, agents.hostDeviceId],
    }).onDelete("restrict"),
    // The provider connection, when set, is on the agent's host device (P-82).
    foreignKey({
      name: "permission_grants_provider_connection_device_fk",
      columns: [t.providerConnectionId, t.hostDeviceId],
      foreignColumns: [
        providerConnections.id,
        providerConnections.hostDeviceId,
      ],
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
