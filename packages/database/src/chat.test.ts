import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  type AgentId,
  CHAT_HISTORY_PAGE,
  type ChatMessage,
  ChatHistoryResponseSchema,
  ChatMessageSchema,
  type DeviceId,
  type EventId,
  type MemberId,
  type MessageId,
  newId,
  type ProjectId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq, sql } from "drizzle-orm";
import {
  listChatMessages,
  postChatMessage,
  type PostChatMessageResult,
} from "./chat.ts";
import type { Database } from "./db.ts";
import { activePersonOf, createWorkspace } from "./membership.ts";
import { leaveWorkspace, removeMember } from "./people.ts";
import { createProject } from "./projects.ts";
import {
  agents,
  conversations,
  devices,
  messages,
  projects,
  users,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";
import { SERVER_ONLY, whileHeld } from "./race-testing.ts";
import { createTestDatabase } from "./testing.ts";

let testDatabase: Awaited<ReturnType<typeof createTestDatabase>> | undefined;

function database(): Database {
  assert.ok(testDatabase, "the test database is created in before()");
  return testDatabase.db;
}

before(async () => {
  testDatabase = await createTestDatabase();
});

after(async () => {
  await testDatabase?.close();
});

const DAY_MS = 24 * 60 * 60_000;
const NOW = new Date("2026-11-03T12:00:00.000Z");
const LATER = new Date("2026-11-03T13:00:00.000Z");

type Account = Readonly<{ userId: UserId; deviceId: DeviceId }>;

/** A device of the account. */
async function addDevice(userId: UserId): Promise<DeviceId> {
  const deviceId = newId<DeviceId>();
  await database()
    .insert(devices)
    .values({
      id: deviceId,
      userId,
      label: "Laptop",
      platform: "linux",
      publicKey: randomBytes(32).toString("hex"),
      keyAlgorithm: "ed25519",
      lastSignInAt: NOW,
    });
  return deviceId;
}

/** An account with one device. */
async function account(name: string): Promise<Account> {
  const userId = newId<UserId>();
  await database().insert(users).values({ id: userId, displayName: name });
  return { userId, deviceId: await addDevice(userId) };
}

/** A workspace of `owner`, created a day before `NOW`, with the owner's person. */
async function workspaceOf(owner: Account): Promise<WorkspaceId> {
  const result = await createWorkspace(database(), {
    ...owner,
    name: "Team",
    displayName: "Owner",
    now: new Date(NOW.getTime() - DAY_MS),
  });
  assert.ok(result.created);
  return result.membership.workspace.id;
}

/** Adds the account to the workspace as a claimed member. */
async function join(workspaceId: WorkspaceId, who: Account): Promise<MemberId> {
  const id = newId<MemberId>();
  await database().insert(workspaceMembers).values({
    id,
    workspaceId,
    userId: who.userId,
    displayName: "Someone",
    role: "member",
    addedByUserId: who.userId,
    claimedAt: NOW,
  });
  return id;
}

/** The account's active person in the workspace. */
async function personOf(
  workspaceId: WorkspaceId,
  who: Account,
): Promise<MemberId> {
  const person = await activePersonOf(database(), {
    workspaceId,
    userId: who.userId,
  });
  assert.ok(person !== undefined);
  return person.id;
}

/** A project of the workspace, with its chat. */
async function projectOf(
  workspaceId: WorkspaceId,
  by: Account,
  name = "App",
): Promise<ProjectId> {
  const result = await createProject(database(), {
    workspaceId,
    userId: by.userId,
    name,
    now: NOW,
  });
  assert.ok(result.created, JSON.stringify(result));
  return result.project.id;
}

/** The project's chat. */
async function chatOf(projectId: ProjectId) {
  const [row] = await database()
    .select()
    .from(conversations)
    .where(eq(conversations.projectId, projectId));
  assert.ok(row !== undefined);
  return row;
}

/** The stored rows of the project's chat, in the order of their numbers. */
async function rowsOf(projectId: ProjectId) {
  const chat = await chatOf(projectId);
  return database()
    .select()
    .from(messages)
    .where(eq(messages.conversationId, chat.id))
    .orderBy(messages.seq);
}

async function post(
  db: Database,
  workspaceId: WorkspaceId,
  who: Account,
  projectId: ProjectId,
  body: string,
  eventId: EventId = newId<EventId>(),
  now: Date = NOW,
): Promise<PostChatMessageResult> {
  return postChatMessage(db, {
    actor: { workspaceId, ...who },
    projectId,
    eventId,
    body,
    now,
  });
}

/** Posts a message that must be stored as a new one, and returns it. */
async function posted(
  workspaceId: WorkspaceId,
  who: Account,
  projectId: ProjectId,
  body: string,
  eventId?: EventId,
): Promise<ChatMessage> {
  const result = await post(
    database(),
    workspaceId,
    who,
    projectId,
    body,
    eventId,
  );
  assert.ok(result.posted && !result.duplicate, JSON.stringify(result));
  return result.message;
}

/** The whole history of the project, as the account reads it in one page. */
async function historyOf(who: Account, projectId: ProjectId) {
  const result = await listChatMessages(database(), {
    actorUserId: who.userId,
    projectId,
    limit: CHAT_HISTORY_PAGE.max,
  });
  assert.ok(result.listed, JSON.stringify(result));
  return result.messages;
}

async function archiveProject(projectId: ProjectId): Promise<void> {
  await database()
    .update(projects)
    .set({ archivedAt: LATER })
    .where(eq(projects.id, projectId));
}

async function archiveWorkspace(workspaceId: WorkspaceId): Promise<void> {
  await database()
    .update(workspaces)
    .set({ archivedAt: LATER })
    .where(eq(workspaces.id, workspaceId));
}

test("an active member posts to a project's chat: numbered from 1 in each chat, stored with the account, the person, the device, and the event ID", async () => {
  const owner = await account("Owner");
  const member = await account("Member");
  const workspaceId = await workspaceOf(owner);
  const memberPerson = await join(workspaceId, member);
  const app = await projectOf(workspaceId, owner, "App");
  const web = await projectOf(workspaceId, owner, "Web");

  const eventId = newId<EventId>();
  const result = await post(
    database(),
    workspaceId,
    member,
    app,
    "Hello",
    eventId,
  );
  assert.ok(result.posted);
  assert.equal(result.duplicate, false);
  assert.deepEqual(result.message, {
    id: result.message.id,
    projectId: app,
    seq: 1,
    author: { kind: "member", memberId: memberPerson },
    body: "Hello",
    createdAt: NOW.toISOString(),
  });
  assert.ok(ChatMessageSchema.safeParse(result.message).success);

  const second = await posted(workspaceId, owner, app, "Hi");
  assert.equal(second.seq, 2);
  assert.deepEqual(second.author, {
    kind: "member",
    memberId: await personOf(workspaceId, owner),
  });
  // Another chat has numbers of its own.
  assert.equal((await posted(workspaceId, owner, web, "Elsewhere")).seq, 1);

  const chat = await chatOf(app);
  assert.equal(chat.lastSeq, 2);
  const rows = await rowsOf(app);
  assert.deepEqual(rows[0], {
    id: result.message.id,
    conversationId: chat.id,
    seq: 1,
    authorUserId: member.userId,
    authorMemberId: memberPerson,
    authorAgentId: null,
    senderDeviceId: member.deviceId,
    clientEventId: eventId,
    body: "Hello",
    createdAt: NOW,
    deletedAt: null,
  });
  assert.equal(rows.length, 2);
});

test("a resent event ID returns the stored message without a new number, also with another body and after the project or the workspace was archived", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const app = await projectOf(workspaceId, owner, "App");
  const eventId = newId<EventId>();
  const first = await posted(workspaceId, owner, app, "Hello", eventId);

  const again = await post(
    database(),
    workspaceId,
    owner,
    app,
    "Another body",
    eventId,
    LATER,
  );
  assert.deepEqual(again, { posted: true, duplicate: true, message: first });

  // The key is per device: another device of the account, and another
  // account, store their own messages with the same event ID.
  const laptop = { ...owner, deviceId: await addDevice(owner.userId) };
  assert.equal((await posted(workspaceId, laptop, app, "Hi", eventId)).seq, 2);
  const member = await account("Member");
  await join(workspaceId, member);
  assert.equal((await posted(workspaceId, member, app, "Hey", eventId)).seq, 3);

  // The stored message is answered before the state of the project.
  await archiveProject(app);
  assert.deepEqual(
    await post(database(), workspaceId, owner, app, "Late", eventId),
    { posted: true, duplicate: true, message: first },
  );
  await archiveWorkspace(workspaceId);
  assert.deepEqual(
    await post(database(), workspaceId, owner, app, "Later", eventId),
    { posted: true, duplicate: true, message: first },
  );
  assert.equal((await chatOf(app)).lastSeq, 3);
  assert.deepEqual(
    (await rowsOf(app)).map((row) => row.body),
    ["Hello", "Hi", "Hey"],
  );
});

test("an archived project or workspace refuses a new message with conflict, and nothing is written", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const app = await projectOf(workspaceId, owner, "App");
  const web = await projectOf(workspaceId, owner, "Web");
  await archiveProject(app);
  assert.deepEqual(await post(database(), workspaceId, owner, app, "Hello"), {
    posted: false,
    refusal: "conflict",
  });
  // Only the workspace is archived.
  await archiveWorkspace(workspaceId);
  assert.deepEqual(await post(database(), workspaceId, owner, web, "Hello"), {
    posted: false,
    refusal: "conflict",
  });
  for (const project of [app, web]) {
    assert.equal((await chatOf(project)).lastSeq, 0);
    assert.deepEqual(await rowsOf(project), []);
  }
});

test("an unknown project and a project of another workspace are both not_found; an account that is not an active member is not_member; nothing is written", async () => {
  const owner = await account("Owner");
  const other = await account("Other");
  const workspaceId = await workspaceOf(owner);
  const app = await projectOf(workspaceId, owner);
  // The owner is a member of the other workspace too.
  const otherWorkspace = await workspaceOf(other);
  await join(otherWorkspace, owner);
  const foreign = await projectOf(otherWorkspace, other);

  const unknown = await post(
    database(),
    workspaceId,
    owner,
    newId<ProjectId>(),
    "Hello",
  );
  const elsewhere = await post(database(), workspaceId, owner, foreign, "Hi");
  assert.deepEqual(unknown, { posted: false, refusal: "not_found" });
  assert.deepEqual(elsewhere, unknown);

  const notMember = { posted: false, refusal: "not_member" };
  // An account without a person in the workspace, even for its project.
  assert.deepEqual(
    await post(database(), workspaceId, other, app, "Hello"),
    notMember,
  );
  // A workspace that does not exist.
  assert.deepEqual(
    await post(database(), newId<WorkspaceId>(), owner, app, "Hello"),
    notMember,
  );
  // A removed member.
  const member = await account("Member");
  const person = await join(workspaceId, member);
  const removal = await removeMember(database(), {
    workspaceId,
    ...owner,
    memberId: person,
    now: NOW,
  });
  assert.ok(removal.removed);
  assert.deepEqual(
    await post(database(), workspaceId, member, app, "Hello"),
    notMember,
  );
  for (const project of [app, foreign]) {
    assert.equal((await chatOf(project)).lastSeq, 0);
    assert.deepEqual(await rowsOf(project), []);
  }
});

test("a removed member is refused even for an event ID that it stored before", async () => {
  const owner = await account("Owner");
  const member = await account("Member");
  const workspaceId = await workspaceOf(owner);
  const person = await join(workspaceId, member);
  const app = await projectOf(workspaceId, owner);
  const eventId = newId<EventId>();
  await posted(workspaceId, member, app, "Hello", eventId);
  await removeMember(database(), {
    workspaceId,
    ...owner,
    memberId: person,
    now: LATER,
  });
  assert.deepEqual(
    await post(database(), workspaceId, member, app, "Hello", eventId),
    { posted: false, refusal: "not_member" },
  );
});

test("an event ID that the device stored in another workspace is a conflict, and nothing is written", async () => {
  const owner = await account("Owner");
  const first = await workspaceOf(owner);
  const second = await workspaceOf(owner);
  const app = await projectOf(first, owner);
  const web = await projectOf(second, owner);
  const eventId = newId<EventId>();
  await posted(first, owner, app, "Hello", eventId);
  assert.deepEqual(
    await post(database(), second, owner, web, "Hello", eventId),
    { posted: false, refusal: "conflict" },
  );
  assert.equal((await chatOf(web)).lastSeq, 0);
  // Another project of the same workspace answers the stored message: the
  // event ID is the key, whatever the event names.
  const other = await projectOf(first, owner, "Other");
  const again = await post(database(), first, owner, other, "Hi", eventId);
  assert.ok(again.posted && again.duplicate);
  assert.equal(again.message.projectId, app);
});

test("an agent's message of the device with the same event ID is never answered as the person's duplicate: a conflict, and nothing is written", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const app = await projectOf(workspaceId, owner);
  const eventId = newId<EventId>();
  const { id } = await agentMessage(app, owner, "Done", eventId);
  assert.deepEqual(
    await post(database(), workspaceId, owner, app, "Hello", eventId),
    { posted: false, refusal: "conflict" },
  );
  assert.equal((await chatOf(app)).lastSeq, 1);
  assert.deepEqual(
    (await rowsOf(app)).map((row) => [row.id, row.authorUserId]),
    [[id, null]],
  );
});

test("an account that leaves and joins again posts as its new person, and its earlier messages keep the earlier person", async () => {
  const owner = await account("Owner");
  const member = await account("Member");
  const workspaceId = await workspaceOf(owner);
  const before = await join(workspaceId, member);
  const app = await projectOf(workspaceId, owner);
  await posted(workspaceId, member, app, "Before");
  const left = await leaveWorkspace(database(), {
    workspaceId,
    ...member,
    now: NOW,
  });
  assert.ok(left.left);
  const after = await join(workspaceId, member);
  await posted(workspaceId, member, app, "After");
  assert.deepEqual(
    (await historyOf(member, app)).map((message) => [
      message.body,
      message.author,
    ]),
    [
      ["After", { kind: "member", memberId: after }],
      ["Before", { kind: "member", memberId: before }],
    ],
  );
});

test("the history holds the project's messages, the newest first, before beforeSeq, at most limit", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const app = await projectOf(workspaceId, owner, "App");
  const web = await projectOf(workspaceId, owner, "Web");
  const sent: ChatMessage[] = [];
  for (let index = 1; index <= 5; index += 1) {
    sent.push(await posted(workspaceId, owner, app, `Message ${index}`));
  }
  await posted(workspaceId, owner, web, "Elsewhere");

  const page = async (limit: number, beforeSeq?: number) => {
    const result = await listChatMessages(database(), {
      actorUserId: owner.userId,
      projectId: app,
      limit,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
    assert.ok(result.listed);
    assert.ok(ChatHistoryResponseSchema.safeParse(result).success);
    return result.messages.map((message) => message.seq);
  };
  const all = await listChatMessages(database(), {
    actorUserId: owner.userId,
    projectId: app,
    limit: CHAT_HISTORY_PAGE.default,
  });
  assert.deepEqual(all, { listed: true, messages: sent.toReversed() });
  assert.deepEqual(await page(2), [5, 4]);
  assert.deepEqual(await page(2, 4), [3, 2]);
  assert.deepEqual(await page(2, 2), [1]);
  assert.deepEqual(await page(2, 1), []);
  assert.deepEqual(await page(1, 100), [5]);
  assert.deepEqual(await page(CHAT_HISTORY_PAGE.max), [5, 4, 3, 2, 1]);
  assert.deepEqual(
    (await historyOf(owner, web)).map((message) => message.body),
    ["Elsewhere"],
  );

  // Outside the protocol's bounds, the caller's mistake.
  for (const limit of [0, CHAT_HISTORY_PAGE.max + 1, 1.5, Number.NaN]) {
    await assert.rejects(
      listChatMessages(database(), {
        actorUserId: owner.userId,
        projectId: app,
        limit,
      }),
      RangeError,
    );
  }
  for (const beforeSeq of [0, -1, 1.5]) {
    await assert.rejects(
      listChatMessages(database(), {
        actorUserId: owner.userId,
        projectId: app,
        beforeSeq,
        limit: 1,
      }),
      RangeError,
    );
  }
});

test("an unknown project, a project of another workspace, and a removed member all get the same not_found; an archived project's history stays readable", async () => {
  const owner = await account("Owner");
  const member = await account("Member");
  const other = await account("Other");
  const workspaceId = await workspaceOf(owner);
  const person = await join(workspaceId, member);
  const app = await projectOf(workspaceId, owner);
  const message = await posted(workspaceId, member, app, "Hello");
  await workspaceOf(other);

  const read = (who: Account, projectId: ProjectId) =>
    listChatMessages(database(), {
      actorUserId: who.userId,
      projectId,
      limit: 10,
    });
  const notFound = { listed: false, refusal: "not_found" };
  assert.deepEqual(await read(owner, newId<ProjectId>()), notFound);
  assert.deepEqual(await read(other, app), notFound);

  await archiveProject(app);
  assert.deepEqual(await read(member, app), {
    listed: true,
    messages: [message],
  });
  await removeMember(database(), {
    workspaceId,
    ...owner,
    memberId: person,
    now: LATER,
  });
  assert.deepEqual(await read(member, app), notFound);
  // The removed author is still shown through its person.
  assert.deepEqual(await read(owner, app), {
    listed: true,
    messages: [message],
  });
});

/**
 * Stores a message of a new agent of `owner`, hosted on the owner's device,
 * numbered as a post numbers it. No writer stores agent messages yet (M4).
 */
async function agentMessage(
  projectId: ProjectId,
  owner: Account,
  body: string,
  clientEventId?: EventId,
): Promise<Readonly<{ id: MessageId; agentId: AgentId }>> {
  const agentId = newId<AgentId>();
  await database().insert(agents).values({
    id: agentId,
    projectId,
    ownerUserId: owner.userId,
    hostDeviceId: owner.deviceId,
    name: "Builder",
  });
  const chat = await chatOf(projectId);
  const id = newId<MessageId>();
  await database().transaction(async (tx) => {
    const [row] = await tx
      .update(conversations)
      .set({ lastSeq: sql`${conversations.lastSeq} + 1` })
      .where(eq(conversations.id, chat.id))
      .returning({ seq: conversations.lastSeq });
    assert.ok(row !== undefined);
    await tx.insert(messages).values({
      id,
      conversationId: chat.id,
      seq: row.seq,
      authorAgentId: agentId,
      senderDeviceId: owner.deviceId,
      clientEventId,
      body,
      createdAt: LATER,
    });
  });
  return { id, agentId };
}

test("the history shows an agent's message with the agent as its author", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const app = await projectOf(workspaceId, owner);
  await posted(workspaceId, owner, app, "Hello");
  const { id, agentId } = await agentMessage(app, owner, "Done");
  const [newest] = await historyOf(owner, app);
  assert.deepEqual(newest, {
    id,
    projectId: app,
    seq: 2,
    author: { kind: "agent", agentId },
    body: "Done",
    createdAt: LATER.toISOString(),
  });
  assert.ok(ChatMessageSchema.safeParse(newest).success);
});

test("inside another transaction, a post rolls back with it", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const app = await projectOf(workspaceId, owner);
  await assert.rejects(
    database().transaction(async (tx) => {
      const result = await post(tx, workspaceId, owner, app, "Hello");
      assert.ok(result.posted);
      throw new Error("roll back");
    }),
    /roll back/,
  );
  assert.equal((await chatOf(app)).lastSeq, 0);
  assert.deepEqual(await rowsOf(app), []);
  assert.equal((await posted(workspaceId, owner, app, "Again")).seq, 1);
});

/** Posts in `tx` a message that must be stored as a new one, and returns it. */
async function postedIn(
  tx: Database,
  workspaceId: WorkspaceId,
  who: Account,
  projectId: ProjectId,
  body: string,
  eventId?: EventId,
): Promise<ChatMessage> {
  const result = await post(tx, workspaceId, who, projectId, body, eventId);
  assert.ok(result.posted && !result.duplicate, JSON.stringify(result));
  return result.message;
}

test(
  "a post waits at the chat for a concurrent post to it and gets the next number",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const member = await account("Member");
    const workspaceId = await workspaceOf(owner);
    await join(workspaceId, member);
    const app = await projectOf(workspaceId, owner);
    await posted(workspaceId, owner, app, "One");
    await posted(workspaceId, owner, app, "Two");
    let held: ChatMessage | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        held = await postedIn(tx, workspaceId, owner, app, "Three");
      },
      () => post(database(), workspaceId, member, app, "Four"),
    );
    assert.equal(held?.seq, 3);
    assert.ok(result.posted && !result.duplicate);
    assert.equal(result.message.seq, 4);
    assert.deepEqual(waitedOn, ["conversations"]);
    assert.equal((await chatOf(app)).lastSeq, 4);
  },
);

test(
  "concurrent posts of several people to one chat get the numbers 1 to n, each once",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const workspaceId = await workspaceOf(owner);
    const people = [owner];
    for (let index = 0; index < 3; index += 1) {
      const member = await account(`Member ${index}`);
      await join(workspaceId, member);
      people.push(member);
    }
    const app = await projectOf(workspaceId, owner);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        post(
          database(),
          workspaceId,
          people[index % people.length] as Account,
          app,
          `Message ${index}`,
        ),
      ),
    );
    const seqs = results.map((result) => {
      assert.ok(result.posted && !result.duplicate, JSON.stringify(result));
      return result.message.seq;
    });
    assert.deepEqual(
      seqs.toSorted((a, b) => a - b),
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    assert.equal((await chatOf(app)).lastSeq, 20);
    assert.deepEqual(
      (await rowsOf(app)).map((row) => row.seq),
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  },
);

test(
  "a concurrent post of the same device and event ID waits at the chat and gets the stored message, and no number is lost",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const workspaceId = await workspaceOf(owner);
    const app = await projectOf(workspaceId, owner);
    const eventId = newId<EventId>();
    let held: ChatMessage | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        held = await postedIn(tx, workspaceId, owner, app, "First", eventId);
      },
      () => post(database(), workspaceId, owner, app, "Second", eventId),
    );
    assert.ok(held !== undefined);
    assert.deepEqual(result, { posted: true, duplicate: true, message: held });
    assert.deepEqual(waitedOn, ["conversations"]);
    assert.deepEqual(
      (await rowsOf(app)).map((row) => row.body),
      ["First"],
    );
    // The savepoint gave the number back.
    assert.equal((await chatOf(app)).lastSeq, 1);
    assert.equal((await posted(workspaceId, owner, app, "Next")).seq, 2);
  },
);

test(
  "a concurrent post of the same device and event ID to another project waits at the unique index and gets the stored message, and no number is lost",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const workspaceId = await workspaceOf(owner);
    const app = await projectOf(workspaceId, owner, "App");
    const web = await projectOf(workspaceId, owner, "Web");
    const eventId = newId<EventId>();
    let held: ChatMessage | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        held = await postedIn(tx, workspaceId, owner, app, "First", eventId);
      },
      () => post(database(), workspaceId, owner, web, "Second", eventId),
    );
    assert.ok(held !== undefined);
    assert.deepEqual(result, { posted: true, duplicate: true, message: held });
    assert.deepEqual(waitedOn, ["transactionid"]);
    assert.deepEqual(await rowsOf(web), []);
    assert.equal((await chatOf(web)).lastSeq, 0);
  },
);

test(
  "a post waits for a concurrent removal of its author and is then refused as no member",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const member = await account("Member");
    const workspaceId = await workspaceOf(owner);
    const person = await join(workspaceId, member);
    const app = await projectOf(workspaceId, owner);
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) =>
        removeMember(tx, {
          workspaceId,
          ...owner,
          memberId: person,
          now: NOW,
        }),
      () =>
        post(database(), workspaceId, member, app, "Hello", undefined, LATER),
    );
    assert.deepEqual(result, { posted: false, refusal: "not_member" });
    assert.deepEqual(waitedOn, ["workspace_members"]);
    assert.deepEqual(await rowsOf(app), []);
    assert.equal((await chatOf(app)).lastSeq, 0);
  },
);

test(
  "a removal waits for a concurrent post of the removed person, which is stored first",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const member = await account("Member");
    const workspaceId = await workspaceOf(owner);
    const person = await join(workspaceId, member);
    const app = await projectOf(workspaceId, owner);
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) => postedIn(tx, workspaceId, member, app, "Hello"),
      () =>
        removeMember(database(), {
          workspaceId,
          ...owner,
          memberId: person,
          now: LATER,
        }),
    );
    assert.ok(result.removed);
    assert.deepEqual(waitedOn, ["workspace_members"]);
    assert.deepEqual(
      (await rowsOf(app)).map((row) => [row.body, row.authorMemberId]),
      [["Hello", person]],
    );
  },
);
