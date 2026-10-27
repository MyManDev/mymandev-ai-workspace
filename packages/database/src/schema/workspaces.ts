import type {
  ProjectId,
  RepositoryId,
  UserId,
  WorkspaceId,
} from "@mymandev/protocol";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, nullableTimestamp, updatedAt } from "./columns.ts";
import { users } from "./identity.ts";

/**
 * The membership, security and routing boundary. A workspace ID is not a join
 * secret: joining needs an invitation token and a membership check (#14).
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
  },
  (t) => [
    check(
      "workspaces_name_length",
      sql`char_length(${t.name}) between 1 and 100`,
    ),
  ],
);

/** Membership grants visibility only, never a capability. */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .$type<WorkspaceId>()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    addedByUserId: uuid("added_by_user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    removedAt: nullableTimestamp("removed_at"),
  },
  (t) => [
    primaryKey({
      name: "workspace_members_pkey",
      columns: [t.workspaceId, t.userId],
    }),
    index("workspace_members_user_id_idx").on(t.userId),
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
