import {
  type AgentId,
  CHAT_HISTORY_PAGE,
  type ChatMessage,
  type DeviceId,
  type EventId,
  type MemberId,
  type MessageId,
  newId,
  type ProjectId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "./db.ts";
import { toDatabaseError, withDatabaseErrors } from "./errors.ts";
import {
  conversations,
  messages,
  projects,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";

// A project's chat (#27; Project Manager decisions of 2026-11-02): posting a
// message and reading the history. A project has one chat, its `project`
// conversation, which creating the project creates (`src/projects.ts`). Any
// active member of the project's workspace posts and reads; posting to an
// archived project or workspace is refused, and the history of an archived
// project stays readable. A message is numbered in its conversation from
// `conversations.last_seq` (ADR 0013), and the sending device's event ID is
// its idempotency key: unique per device, `messages_sender_device_client_event_key`.
//
// Lock order, the order of `src/people.ts` and `src/projects.ts`: the
// acting person (`workspace_members`), then the project (`projects`), then
// the conversation (`conversations`). A post locks the person `FOR SHARE`,
// as `src/people.ts` asks of a writer that attaches a row to a person: a
// removal holds the person `FOR NO KEY UPDATE`, so either the removal
// commits first and the post finds the person removed, or the post commits
// first and the removal comes after the message. Posts of one person do not
// wait for each other there. It locks the project `FOR SHARE` too, so that
// an erasure that archives the project, which locks it `FOR NO KEY UPDATE`
// after the people and the workspace rows, either waits for the post or is
// seen by it. The `UPDATE` of `last_seq` locks the conversation until the
// transaction ends, so the posts of one conversation get their numbers one
// after another, without a gap and without a number twice.

/** The unique index of one message per sending device and event ID. */
const EVENT_KEY = "messages_sender_device_client_event_key";

/** Whether a failure is the unique index of event IDs. */
function isEventClash(error: unknown): boolean {
  const failure = toDatabaseError(error);
  return failure.code === "23505" && failure.constraint === EVENT_KEY;
}

/** The columns of a stored message, with its project and workspace. */
const messageColumns = {
  id: messages.id,
  projectId: conversations.projectId,
  workspaceId: projects.workspaceId,
  seq: messages.seq,
  authorMemberId: messages.authorMemberId,
  authorAgentId: messages.authorAgentId,
  body: messages.body,
  createdAt: messages.createdAt,
};

type MessageRow = Readonly<{
  id: MessageId;
  projectId: ProjectId;
  seq: number;
  authorMemberId: MemberId | null;
  authorAgentId: AgentId | null;
  body: string;
  createdAt: Date;
}>;

/**
 * A stored message in the protocol's form. The CHECKs of the table give it
 * exactly one author: a person, named with its account, or an agent.
 */
function toChatMessage(row: MessageRow): ChatMessage {
  const author: ChatMessage["author"] | undefined =
    row.authorMemberId !== null
      ? { kind: "member", memberId: row.authorMemberId }
      : row.authorAgentId !== null
        ? { kind: "agent", agentId: row.authorAgentId }
        : undefined;
  if (author === undefined) {
    throw new Error("Invariant broken: a chat message has no author");
  }
  return {
    id: row.id,
    projectId: row.projectId,
    seq: row.seq,
    author,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The message that the device stored with this event ID, with its workspace
 * and its author's account. The key is unique per device, whoever the
 * author: a device also sends its agents' messages (M4).
 */
async function storedMessage(
  tx: Database,
  deviceId: DeviceId,
  eventId: EventId,
) {
  const [row] = await tx
    .select({ ...messageColumns, authorUserId: messages.authorUserId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(projects, eq(projects.id, conversations.projectId))
    .where(
      and(
        eq(messages.senderDeviceId, deviceId),
        eq(messages.clientEventId, eventId),
      ),
    );
  return row;
}

export type PostChatMessageInput = Readonly<{
  /**
   * Who posts: the connection's account and device, and the event's
   * workspace. The account's active person in the workspace is the author.
   */
  actor: Readonly<{
    workspaceId: WorkspaceId;
    userId: UserId;
    deviceId: DeviceId;
  }>;
  projectId: ProjectId;
  /** The ID of the device's `chat.message.send`: the idempotency key. */
  eventId: EventId;
  /** As the protocol accepted it, from 1 to 16,000 characters; outside, the CHECK fails. */
  body: string;
  now: Date;
}>;

export type PostChatMessageResult =
  | Readonly<{
      posted: true;
      /**
       * true when the device had already stored a message with this event
       * ID: `message` is that stored message, and nothing was written. The
       * API sends it to the sending connection only (#27, D3).
       */
      duplicate: boolean;
      message: ChatMessage;
    }>
  | Readonly<{
      posted: false;
      /**
       * `not_member`: the account is not an active member of the actor's
       * workspace, also when the workspace does not exist; `not_found`: the
       * workspace has no project with this ID, also when it is a project of
       * another workspace; `conflict`: the project or the workspace is
       * archived, or the device stored a message with this event ID in
       * another workspace or as an agent's message.
       */
      refusal: "not_member" | "not_found" | "conflict";
    }>;

/**
 * Posts a message to a project's chat in one transaction (#27). It locks the
 * account's active person in the actor's workspace `FOR SHARE`, and without
 * one refuses with `not_member`. Then, before any state of the project, it
 * looks for a message that the device already stored with this event ID: the
 * account's own message in the workspace is returned as it is stored, with
 * `duplicate: true`, even when its body differs or its project was archived
 * since; one in another workspace, or an agent's message of the device, is a
 * `conflict`. Then it locks the project `FOR SHARE` and
 * refuses a project that the workspace does not have with `not_found`, and
 * an archived project or workspace with `conflict`. It numbers the message
 * with `UPDATE conversations SET last_seq = last_seq + 1 ... RETURNING` and
 * inserts it with the account as `author_user_id`, the person as
 * `author_member_id`, the device as `sender_device_id`, the event ID as
 * `client_event_id`, and `now` as `created_at`. These two statements run as
 * a savepoint: when a concurrent post of the same device and event ID
 * committed first, the insert fails the unique index, the savepoint rolls
 * back the number too, and the result is the stored message, as above.
 * Inside another transaction it runs as a savepoint.
 */
export async function postChatMessage(
  db: Database,
  input: PostChatMessageInput,
): Promise<PostChatMessageResult> {
  const { actor } = input;
  const refused = (
    refusal: "not_member" | "not_found" | "conflict",
  ): PostChatMessageResult => ({ posted: false, refusal });
  // A message that the device already stored with this event ID. Only a
  // message of the account's person in the actor's workspace is its
  // duplicate; an agent's message with the same key, or one in another
  // workspace, is a conflict.
  const answerTo = (
    stored: MessageRow &
      Readonly<{ workspaceId: WorkspaceId; authorUserId: UserId | null }>,
  ): PostChatMessageResult =>
    stored.workspaceId === actor.workspaceId &&
    stored.authorUserId === actor.userId &&
    stored.authorMemberId !== null
      ? { posted: true, duplicate: true, message: toChatMessage(stored) }
      : refused("conflict");
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<PostChatMessageResult> => {
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

      const stored = await storedMessage(tx, actor.deviceId, input.eventId);
      if (stored !== undefined) {
        return answerTo(stored);
      }

      const [target] = await tx
        .select({
          conversationId: conversations.id,
          projectArchivedAt: projects.archivedAt,
          workspaceArchivedAt: workspaces.archivedAt,
        })
        .from(projects)
        .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
        .leftJoin(
          conversations,
          and(
            eq(conversations.projectId, projects.id),
            eq(conversations.kind, "project"),
          ),
        )
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.workspaceId, actor.workspaceId),
          ),
        )
        .for("share", { of: projects });
      if (target === undefined) {
        return refused("not_found");
      }
      if (
        target.projectArchivedAt !== null ||
        target.workspaceArchivedAt !== null
      ) {
        return refused("conflict");
      }
      const { conversationId } = target;
      if (conversationId === null) {
        // Creating a project creates its chat in the same transaction.
        throw new Error("Invariant broken: a project has no chat");
      }

      try {
        const message = await tx.transaction(async (savepoint) => {
          const [numbered] = await savepoint
            .update(conversations)
            .set({ lastSeq: sql`${conversations.lastSeq} + 1` })
            .where(eq(conversations.id, conversationId))
            .returning({ seq: conversations.lastSeq });
          if (numbered === undefined) {
            throw new Error("The locked project's chat is missing");
          }
          const row: MessageRow = {
            id: newId<MessageId>(),
            projectId: input.projectId,
            seq: numbered.seq,
            authorMemberId: person.id,
            authorAgentId: null,
            body: input.body,
            createdAt: input.now,
          };
          await savepoint.insert(messages).values({
            id: row.id,
            conversationId,
            seq: row.seq,
            authorUserId: actor.userId,
            authorMemberId: person.id,
            senderDeviceId: actor.deviceId,
            clientEventId: input.eventId,
            body: row.body,
            createdAt: row.createdAt,
          });
          return row;
        });
        return {
          posted: true,
          duplicate: false,
          message: toChatMessage(message),
        };
      } catch (error) {
        if (!isEventClash(error)) {
          throw error;
        }
      }
      // A concurrent post of the same device and event ID committed first.
      const raced = await storedMessage(tx, actor.deviceId, input.eventId);
      if (raced === undefined) {
        throw new Error("The message of a clashing event ID is missing");
      }
      return answerTo(raced);
    }),
  );
}

export type ListChatMessagesInput = Readonly<{
  /** The reading account; it must be an active member of the project's workspace. */
  actorUserId: UserId;
  projectId: ProjectId;
  /** Only messages with a lower `seq`; without it, the newest messages. */
  beforeSeq?: number;
  /** From 1 to `CHAT_HISTORY_PAGE.max`; outside, a RangeError. */
  limit: number;
}>;

export type ListChatMessagesResult =
  | Readonly<{ listed: true; messages: ChatMessage[] }>
  | Readonly<{
      listed: false;
      /**
       * The project does not exist, or the account is not an active member
       * of its workspace: the same answer, so that an ID cannot be probed.
       */
      refusal: "not_found";
    }>;

/**
 * One page of a project's chat history (#27, D5): the answer of
 * `GET /projects/:projectId/messages`. The newest first, by `seq`; with
 * `beforeSeq`, only messages with a lower `seq`; at most `limit`. Any active
 * member of the project's workspace reads it, also the history of an
 * archived project. It checks membership and reads the page in one
 * read-only transaction at `REPEATABLE READ`, so both see one snapshot;
 * inside another transaction it runs as a savepoint, at that transaction's
 * isolation level. A message keeps its author's person after the person
 * was removed. It does not filter on `deleted_at`: no writer sets it yet,
 * and the writer that does decides how the history shows a deleted message,
 * so that a page still holds `limit` messages unless it is the oldest.
 */
export async function listChatMessages(
  db: Database,
  input: ListChatMessagesInput,
): Promise<ListChatMessagesResult> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > CHAT_HISTORY_PAGE.max
  ) {
    throw new RangeError(
      `The limit of a chat history page is from 1 to ${CHAT_HISTORY_PAGE.max}`,
    );
  }
  if (
    input.beforeSeq !== undefined &&
    (!Number.isSafeInteger(input.beforeSeq) || input.beforeSeq < 1)
  ) {
    throw new RangeError("beforeSeq is a positive integer");
  }
  // One snapshot for the membership check and the page: a removal that
  // commits in between is seen by both statements or by neither.
  const rows = await withDatabaseErrors(() =>
    db.transaction(
      async (tx) => {
        const [chat] = await tx
          .select({ id: conversations.id })
          .from(projects)
          .innerJoin(
            workspaceMembers,
            and(
              eq(workspaceMembers.workspaceId, projects.workspaceId),
              eq(workspaceMembers.userId, input.actorUserId),
              isNull(workspaceMembers.removedAt),
            ),
          )
          .leftJoin(
            conversations,
            and(
              eq(conversations.projectId, projects.id),
              eq(conversations.kind, "project"),
            ),
          )
          .where(eq(projects.id, input.projectId));
        if (chat === undefined) {
          return undefined;
        }
        const chatId = chat.id;
        if (chatId === null) {
          return null;
        }
        return tx
          .select(messageColumns)
          .from(messages)
          .innerJoin(
            conversations,
            eq(conversations.id, messages.conversationId),
          )
          .innerJoin(projects, eq(projects.id, conversations.projectId))
          .where(
            and(
              eq(messages.conversationId, chatId),
              input.beforeSeq === undefined
                ? undefined
                : lt(messages.seq, input.beforeSeq),
            ),
          )
          .orderBy(desc(messages.seq))
          .limit(input.limit);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ),
  );
  if (rows === undefined) {
    return { listed: false, refusal: "not_found" };
  }
  if (rows === null) {
    // Outside `withDatabaseErrors`, so that the message reaches the log.
    throw new Error("Invariant broken: a project has no chat");
  }
  return { listed: true, messages: rows.map(toChatMessage) };
}
