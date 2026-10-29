import type {
  DeviceId,
  InvitationId,
  JoinRequestDecision,
  JoinRequestId,
  MemberId,
  MemberRole,
  ProjectId,
  RepositoryId,
  UserId,
  WorkspaceId,
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

/**
 * The membership, security and routing boundary. A workspace ID is not a join
 * secret: joining needs an invitation code or an approved join request, and
 * every action checks membership (ADR 0014).
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().$type<WorkspaceId>(),
    name: text("name").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: nullableTimestamp("archived_at"),
    /** New join requests are refused until an admin resumes them. */
    joinRequestsPausedAt: nullableTimestamp("join_requests_paused_at"),
  },
  (t) => [
    check(
      "workspaces_name_length",
      sql`char_length(${t.name}) between 1 and 100`,
    ),
  ],
);

/**
 * A person in a workspace (P-57). The workspace defines its people; an account
 * claims a person through an invitation or an approved join request. An
 * unclaimed person has no account and is always a `member`. Membership grants
 * visibility only, never a capability.
 */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().$type<MemberId>(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .$type<WorkspaceId>()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    /** Empty until the person is claimed. */
    userId: uuid("user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    displayName: text("display_name").notNull(),
    role: text("role").notNull().$type<MemberRole>(),
    addedByUserId: uuid("added_by_user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    claimedAt: nullableTimestamp("claimed_at"),
    ownershipOfferedAt: nullableTimestamp("ownership_offered_at"),
    removedAt: nullableTimestamp("removed_at"),
    removedByUserId: uuid("removed_by_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("workspace_members_workspace_id_idx").on(t.workspaceId),
    index("workspace_members_user_id_idx").on(t.userId),
    // Target of composite foreign keys that require a person of a given workspace.
    unique("workspace_members_id_workspace_id_key").on(t.id, t.workspaceId),
    // One active person per account and workspace.
    uniqueIndex("workspace_members_active_user_key")
      .on(t.workspaceId, t.userId)
      .where(sql`${t.userId} is not null and ${t.removedAt} is null`),
    // Exactly one owner among the active people; "at least one" is the writer's rule.
    uniqueIndex("workspace_members_active_owner_key")
      .on(t.workspaceId)
      .where(sql`${t.role} = 'owner' and ${t.removedAt} is null`),
    uniqueIndex("workspace_members_ownership_offer_key")
      .on(t.workspaceId)
      .where(sql`${t.ownershipOfferedAt} is not null`),
    check(
      "workspace_members_display_name_length",
      sql`char_length(${t.displayName}) between 1 and 64`,
    ),
    check(
      "workspace_members_role_check",
      sql`${t.role} in ('owner', 'admin', 'member')`,
    ),
    check(
      "workspace_members_claim_check",
      sql`(${t.userId} is null) = (${t.claimedAt} is null)`,
    ),
    // An unclaimed person is always a member.
    check(
      "workspace_members_unclaimed_role_check",
      sql`${t.userId} is not null or ${t.role} = 'member'`,
    ),
    check(
      "workspace_members_removal_check",
      sql`(${t.removedAt} is null) = (${t.removedByUserId} is null)`,
    ),
    // An ownership offer goes only to a claimed, active person who is not the owner.
    check(
      "workspace_members_ownership_offer_check",
      sql`${t.ownershipOfferedAt} is null or (${t.userId} is not null and ${t.removedAt} is null and ${t.role} <> 'owner')`,
    ),
  ],
);

/**
 * An invitation to claim one person. Only the SHA-256 hash of the code is
 * stored. Used and expired invitations stay, because nothing is deleted (P-62).
 * The writer sets `created_at` and `expires_at` from the same instant: the
 * default `now()` is the start of the transaction, not the application's clock.
 */
export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: uuid("id").primaryKey().$type<InvitationId>(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .$type<WorkspaceId>()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    memberId: uuid("member_id").notNull().$type<MemberId>(),
    /** Lowercase hexadecimal SHA-256 of the invitation code. */
    tokenHash: text("token_hash").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    expiresAt: nullableTimestamp("expires_at").notNull(),
    acceptedAt: nullableTimestamp("accepted_at"),
    acceptedByUserId: uuid("accepted_by_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    acceptedDeviceId: uuid("accepted_device_id").$type<DeviceId>(),
    revokedAt: nullableTimestamp("revoked_at"),
    revokedByUserId: uuid("revoked_by_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("workspace_invitations_workspace_id_idx").on(t.workspaceId),
    unique("workspace_invitations_token_hash_key").on(t.tokenHash),
    // At most one live invitation per person.
    uniqueIndex("workspace_invitations_live_member_key")
      .on(t.memberId)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    check(
      "workspace_invitations_token_hash_check",
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    // 1 hour to 7 days. '168 hours', not '7 days': adding days follows the
    // session time zone, which makes a day across a daylight saving change 23 hours.
    check(
      "workspace_invitations_expiry_check",
      sql`${t.expiresAt} >= ${t.createdAt} + interval '1 hour' and ${t.expiresAt} <= ${t.createdAt} + interval '168 hours'`,
    ),
    check(
      "workspace_invitations_acceptance_check",
      sql`num_nonnulls(${t.acceptedAt}, ${t.acceptedByUserId}, ${t.acceptedDeviceId}) in (0, 3)`,
    ),
    check(
      "workspace_invitations_revocation_check",
      sql`(${t.revokedAt} is null) = (${t.revokedByUserId} is null)`,
    ),
    check(
      "workspace_invitations_accepted_or_revoked_check",
      sql`${t.acceptedAt} is null or ${t.revokedAt} is null`,
    ),
    // The person belongs to the invitation's workspace.
    foreignKey({
      name: "workspace_invitations_member_workspace_fk",
      columns: [t.memberId, t.workspaceId],
      foreignColumns: [workspaceMembers.id, workspaceMembers.workspaceId],
    }).onDelete("restrict"),
    // The accepting device belongs to the accepting account.
    foreignKey({
      name: "workspace_invitations_accepted_device_user_fk",
      columns: [t.acceptedDeviceId, t.acceptedByUserId],
      foreignColumns: [devices.id, devices.userId],
    }).onDelete("restrict"),
  ],
);

/**
 * A request of an account to join a workspace by its ID. A request without a
 * decision is pending; an expired pending request is marked `expired` before
 * a new one is stored.
 */
export const workspaceJoinRequests = pgTable(
  "workspace_join_requests",
  {
    id: uuid("id").primaryKey().$type<JoinRequestId>(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .$type<WorkspaceId>()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    requesterUserId: uuid("requester_user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    requesterDeviceId: uuid("requester_device_id").notNull().$type<DeviceId>(),
    requestedDisplayName: text("requested_display_name").notNull(),
    createdAt: createdAt(),
    expiresAt: nullableTimestamp("expires_at").notNull(),
    decision: text("decision").$type<JoinRequestDecision>(),
    decidedAt: nullableTimestamp("decided_at"),
    decidedByUserId: uuid("decided_by_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    /** The person created for an approved request. */
    memberId: uuid("member_id").$type<MemberId>(),
    unblockedAt: nullableTimestamp("unblocked_at"),
    unblockedByUserId: uuid("unblocked_by_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("workspace_join_requests_workspace_id_idx").on(t.workspaceId),
    // One pending request per account and workspace.
    uniqueIndex("workspace_join_requests_pending_key")
      .on(t.workspaceId, t.requesterUserId)
      .where(sql`${t.decision} is null`),
    check(
      "workspace_join_requests_requested_display_name_length",
      sql`char_length(${t.requestedDisplayName}) between 1 and 64`,
    ),
    check(
      "workspace_join_requests_decision_check",
      sql`${t.decision} in ('approved', 'denied', 'blocked', 'withdrawn', 'expired')`,
    ),
    check(
      "workspace_join_requests_decided_check",
      sql`(${t.decision} is null) = (${t.decidedAt} is null)`,
    ),
    // Every decision except expiry is made by an account.
    check(
      "workspace_join_requests_decided_by_check",
      sql`(${t.decidedByUserId} is not null) = (${t.decision} is not null and ${t.decision} <> 'expired')`,
    ),
    check(
      "workspace_join_requests_member_check",
      sql`(${t.memberId} is not null) = (${t.decision} is not distinct from 'approved')`,
    ),
    check(
      "workspace_join_requests_unblocked_check",
      sql`(${t.unblockedAt} is null) = (${t.unblockedByUserId} is null) and (${t.unblockedAt} is null or ${t.decision} is not distinct from 'blocked')`,
    ),
    // The requesting device belongs to the requesting account.
    foreignKey({
      name: "workspace_join_requests_requester_device_fk",
      columns: [t.requesterDeviceId, t.requesterUserId],
      foreignColumns: [devices.id, devices.userId],
    }).onDelete("restrict"),
    // The approved person belongs to the request's workspace.
    foreignKey({
      name: "workspace_join_requests_member_workspace_fk",
      columns: [t.memberId, t.workspaceId],
      foreignColumns: [workspaceMembers.id, workspaceMembers.workspaceId],
    }).onDelete("restrict"),
  ],
);

/** Holds repositories, agents, conversations and runs. */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().$type<ProjectId>(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .$type<WorkspaceId>()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: nullableTimestamp("archived_at"),
  },
  (t) => [
    index("projects_workspace_id_idx").on(t.workspaceId),
    check(
      "projects_name_length",
      sql`char_length(${t.name}) between 1 and 100`,
    ),
  ],
);

/**
 * A logical repository registered in a project. The local path never leaves the
 * device; the remote URL is deferred to the M1-05 coordination.
 */
export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().$type<RepositoryId>(),
    projectId: uuid("project_id")
      .notNull()
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: nullableTimestamp("archived_at"),
  },
  (t) => [
    index("repositories_project_id_idx").on(t.projectId),
    // Target of composite foreign keys that require a repository of a given project.
    unique("repositories_id_project_id_key").on(t.id, t.projectId),
    check(
      "repositories_name_length",
      sql`char_length(${t.name}) between 1 and 100`,
    ),
  ],
);
