import type {
  AgentId,
  DeviceId,
  EventId,
  ProjectId,
  UserId,
} from "@mymandev/protocol";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.ts";
import { createdAt, nullableTimestamp } from "./columns.ts";
import { devices, users } from "./identity.ts";
import { projects } from "./workspaces.ts";

/** A conversation in a project. Only project chat exists in M1. */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .$type<ProjectId>()
      .references(() => projects.id, { onDelete: "restrict" }),
    kind: text("kind").notNull().$type<"project">(),
    title: text("title"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    /**
     * The last message sequence number allocated in this conversation. The
     * message writer increments it in the insert transaction, which also
     * serializes concurrent writers to one conversation.
     */
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("conversations_project_id_idx").on(t.projectId),
    check("conversations_kind_check", sql`${t.kind} in ('project')`),
    // A null title passes the check; a title that is set has 1 to 200 characters.
    check(
      "conversations_title_length",
      sql`char_length(${t.title}) between 1 and 200`,
    ),
    check("conversations_last_seq_check", sql`${t.lastSeq} >= 0`),
  ],
);

/**
 * A chat message. Exactly one author: a user, or an agent. The server orders
 * messages by `seq` within the conversation, never by client time.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    /** Per-conversation server order, allocated from conversations.last_seq. Never supplied by clients. */
    seq: bigint("seq", { mode: "number" }).notNull(),
    authorUserId: uuid("author_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    authorAgentId: uuid("author_agent_id")
      .$type<AgentId>()
      .references(() => agents.id, { onDelete: "restrict" }),
    senderDeviceId: uuid("sender_device_id")
      .notNull()
      .$type<DeviceId>()
      .references(() => devices.id, { onDelete: "restrict" }),
    /** Idempotency key: the event ID the sending device generated. */
    clientEventId: uuid("client_event_id").$type<EventId>(),
    body: text("body").notNull(),
    createdAt: createdAt(),
    deletedAt: nullableTimestamp("deleted_at"),
  },
  (t) => [
    unique("messages_conversation_id_seq_key").on(t.conversationId, t.seq),
    // A device retry of the same message fails instead of creating a duplicate.
    uniqueIndex("messages_sender_device_client_event_key")
      .on(t.senderDeviceId, t.clientEventId)
      .where(sql`${t.clientEventId} is not null`),
    check(
      "messages_author_check",
      sql`num_nonnulls(${t.authorUserId}, ${t.authorAgentId}) = 1`,
    ),
    check("messages_seq_check", sql`${t.seq} >= 1`),
    check(
      "messages_body_length",
      sql`char_length(${t.body}) between 1 and 16000`,
    ),
    // A message of a user comes from one of that user's devices.
    foreignKey({
      name: "messages_sender_device_user_fk",
      columns: [t.senderDeviceId, t.authorUserId],
      foreignColumns: [devices.id, devices.userId],
    }).onDelete("restrict"),
    // A message of an agent comes from the host device of that agent.
    foreignKey({
      name: "messages_agent_host_device_fk",
      columns: [t.authorAgentId, t.senderDeviceId],
      foreignColumns: [agents.id, agents.hostDeviceId],
    }).onDelete("restrict"),
  ],
);
