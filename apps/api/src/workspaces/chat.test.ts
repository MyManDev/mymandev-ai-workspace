import {
  conversations,
  createProject,
  devices,
  messages,
  postChatMessage,
  projects,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  type ChatMessage,
  ChatHistoryResponseSchema,
  type ConnectionId,
  type DeviceId,
  decodeClientEvent,
  decodeServerMessage,
  type EventId,
  type MemberId,
  type MemberRole,
  newId,
  type ProjectId,
  type ServerEvent,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  accessToken,
  deviceApp,
  type FakeClock,
  fakeClock,
  type SignedInDevice,
  signInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";
import {
  type AuthenticatedConnectionContext,
  AuditThrottle,
  bindIdentity,
  CloseCode,
  CONNECTION_AUDIT_WINDOW_MS,
  ConnectionRegistry,
  type EventHandler,
} from "../gateway.ts";
import {
  type Client,
  closedWith,
  connected,
  nextFrame,
  settle,
} from "../gateway-test-support.ts";
import { CHAT_SEND_LIMIT, chatSendHandler } from "./chat-events.ts";
import { AccountSendLimit } from "./send-limit.ts";

const database = useTestDatabase();

type Json = Record<string, unknown>;

type Account = Readonly<{
  app: FastifyInstance;
  device: SignedInDevice;
  token: string;
}>;

/**
 * One API instance: each account signs in through its own app (the fake
 * GitHub of an app knows one account), and every app shares one registry
 * of connections, one database, and one clock, as one API process does.
 */
async function instance(
  t: TestContext,
  options: Readonly<{ clock?: FakeClock; onEvent?: EventHandler }> = {},
) {
  const connections = new ConnectionRegistry();
  const account = async (githubId: number): Promise<Account> => {
    const app = await deviceApp(t, {
      database: database(),
      githubId,
      connections,
      ...(options.clock === undefined ? {} : { now: options.clock.now }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    // injectWS never settles unless the app is ready.
    await app.ready();
    const device = await signInDevice(app);
    return { app, device, token: await accessToken(app, device) };
  };
  return { connections, account };
}

/** A workspace that `owner` owns, with `members` as claimed members, written directly. */
async function workspaceOf(
  owner: SignedInDevice,
  members: readonly SignedInDevice[] = [],
) {
  const workspaceId = newId<WorkspaceId>();
  await database()
    .insert(workspaces)
    .values({ id: workspaceId, name: "Team", createdByUserId: owner.userId });
  const person = async (userId: UserId, role: MemberRole) => {
    const id = newId<MemberId>();
    await database()
      .insert(workspaceMembers)
      .values({
        id,
        workspaceId,
        userId,
        displayName: role === "owner" ? "Ada" : "Bob",
        role,
        addedByUserId: owner.userId,
        claimedAt: new Date(),
      });
    return id;
  };
  const ownerId = await person(owner.userId, "owner");
  const memberIds: MemberId[] = [];
  for (const member of members) {
    memberIds.push(await person(member.userId, "member"));
  }
  return { workspaceId, ownerId, memberIds };
}

/** A project of the workspace, with its chat, as `POST .../projects` creates it. */
async function projectIn(
  workspaceId: WorkspaceId,
  creator: SignedInDevice,
  name = "App",
): Promise<ProjectId> {
  const result = await createProject(database(), {
    workspaceId,
    userId: creator.userId,
    name,
    now: new Date(),
  });
  assert.ok(result.created, JSON.stringify(result));
  return result.project.id;
}

async function removeInDatabase(memberId: MemberId, by: SignedInDevice) {
  await database()
    .update(workspaceMembers)
    .set({ removedAt: new Date(), removedByUserId: by.userId })
    .where(eq(workspaceMembers.id, memberId));
}

/** A `chat.message.send` of the device, as the desktop sends it. */
function sendOf(
  device: SignedInDevice,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  body: string,
  id: EventId = newId<EventId>(),
) {
  return {
    protocolVersion: 0,
    id,
    type: "chat.message.send",
    occurredAt: "2026-11-03T09:00:00.000Z",
    workspaceId,
    actor: { kind: "user", userId: device.userId },
    deviceId: device.deviceId,
    payload: { projectId, body },
  } as const;
}

function subscribe(workspaceId: WorkspaceId): Json {
  return { protocolVersion: 0, type: "workspace.subscribe", workspaceId };
}

async function subscribed(client: Client, workspaceId: WorkspaceId) {
  client.send(subscribe(workspaceId));
  const frame = await nextFrame(client);
  assert.ok(
    frame.type === "workspace.subscribed" && frame.workspaceId === workspaceId,
    JSON.stringify(frame),
  );
}

/** The next message, which must be an event that the device's decoder accepts. */
async function nextEvent(client: Client): Promise<ServerEvent> {
  const decoded = decodeServerMessage(await client.next());
  assert.ok(decoded.ok && decoded.kind === "event", JSON.stringify(decoded));
  return decoded.event;
}

/** The next message, which must be the `chat.message.created` of `send`. */
async function nextCreated(
  client: Client,
  send: ReturnType<typeof sendOf>,
): Promise<ChatMessage> {
  const event = await nextEvent(client);
  assert.ok(event.type === "chat.message.created", JSON.stringify(event));
  assert.equal(event.workspaceId, send.workspaceId);
  assert.deepEqual(event.actor, { kind: "system" });
  assert.equal(event.deviceId, null);
  assert.equal(event.causationId, send.id);
  assert.equal(event.correlationId, undefined);
  assert.notEqual(event.id, send.id);
  assert.equal(event.occurredAt, event.payload.message.createdAt);
  return event.payload.message;
}

/** The next message, which must be `event.refused` for `eventId`. */
async function nextRefused(client: Client, eventId: EventId, code: string) {
  assert.deepEqual(await nextFrame(client), {
    protocolVersion: 0,
    type: "event.refused",
    eventId,
    code,
  });
}

/** Lets pending frames arrive, then checks that none is left unread. */
async function quiet(...clients: Client[]) {
  await settle();
  for (const client of clients) {
    assert.equal(client.unread(), 0);
  }
}

function isOpen(client: Client): boolean {
  return client.ws.readyState === client.ws.OPEN;
}

/** The stored messages of a project's chat, by `seq`. */
async function storedOf(projectId: ProjectId) {
  return database()
    .select({ seq: messages.seq, body: messages.body })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(conversations.projectId, projectId))
    .orderBy(messages.seq);
}

function history(account: Account, projectId: string, query = "") {
  return account.app.inject({
    method: "GET",
    url: `/projects/${projectId}/messages${query}`,
    headers: { authorization: `Bearer ${account.token}` },
  });
}

const NOT_FOUND = {
  statusCode: 404,
  error: "Not Found",
  message: "Not Found",
  code: "not_found",
};

test("two members' sends are stored and both subscribed connections receive chat.message.created from the system, with seq, author, and causation", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3701);
  const bob = await account(3702);
  const { workspaceId, ownerId, memberIds } = await workspaceOf(ada.device, [
    bob.device,
  ]);
  const projectId = await projectIn(workspaceId, ada.device);
  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(adaConnection.client, workspaceId);
  await subscribed(bobConnection.client, workspaceId);
  assert.equal(
    (await nextFrame(adaConnection.client)).type,
    "presence.changed",
  );

  const fromBob = sendOf(bob.device, workspaceId, projectId, "Hello\nworld");
  bobConnection.client.send(fromBob);
  const seenByAda = await nextCreated(adaConnection.client, fromBob);
  const seenByBob = await nextCreated(bobConnection.client, fromBob);
  assert.deepEqual(seenByAda, seenByBob);
  assert.deepEqual(seenByAda, {
    id: seenByAda.id,
    projectId,
    seq: 1,
    author: { kind: "member", memberId: memberIds[0] },
    body: "Hello\nworld",
    createdAt: seenByAda.createdAt,
  });

  const fromAda = sendOf(ada.device, workspaceId, projectId, "Hi Bob");
  adaConnection.client.send(fromAda);
  const second = await nextCreated(bobConnection.client, fromAda);
  assert.deepEqual(await nextCreated(adaConnection.client, fromAda), second);
  assert.equal(second.seq, 2);
  assert.deepEqual(second.author, { kind: "member", memberId: ownerId });
  await quiet(adaConnection.client, bobConnection.client);

  const response = await history(bob, projectId);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(ChatHistoryResponseSchema.parse(response.json()), {
    messages: [second, seenByAda],
  });
});

test("the sender receives its message also when it is not subscribed, and a resent event ID gets the stored message on the sending connection only", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3711);
  const bob = await account(3712);
  const { workspaceId } = await workspaceOf(ada.device, [bob.device]);
  const projectId = await projectIn(workspaceId, ada.device);
  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(adaConnection.client, workspaceId);

  const send = sendOf(bob.device, workspaceId, projectId, "First");
  bobConnection.client.send(send);
  const message = await nextCreated(bobConnection.client, send);
  assert.deepEqual(await nextCreated(adaConnection.client, send), message);

  // The event ID is the idempotency key: another body changes nothing.
  const resent = { ...send, payload: { projectId, body: "Changed" } };
  bobConnection.client.send(resent);
  assert.deepEqual(await nextCreated(bobConnection.client, send), message);
  await quiet(adaConnection.client, bobConnection.client);

  // Subscribed, the sender still gets a resent event ID alone.
  await subscribed(bobConnection.client, workspaceId);
  assert.equal(
    (await nextFrame(adaConnection.client)).type,
    "presence.changed",
  );
  bobConnection.client.send(resent);
  assert.deepEqual(await nextCreated(bobConnection.client, send), message);
  await quiet(adaConnection.client, bobConnection.client);
  assert.deepEqual(await storedOf(projectId), [{ seq: 1, body: "First" }]);
});

test("an unknown project, a project of another workspace, an archived project or workspace, and an event ID used in another workspace get event.refused on the sending connection only, which stays open", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3721);
  const bob = await account(3722);
  const carol = await account(3723);
  const team = await workspaceOf(ada.device, [bob.device]);
  const projectId = await projectIn(team.workspaceId, ada.device);
  // Bob is a member of a second workspace too, and not of a third.
  const shared = await workspaceOf(carol.device, [bob.device]);
  const sharedProject = await projectIn(shared.workspaceId, carol.device);
  const foreign = await workspaceOf(carol.device);
  const foreignProject = await projectIn(foreign.workspaceId, carol.device);
  const archived = await projectIn(team.workspaceId, ada.device, "Old");
  await database()
    .update(projects)
    .set({ archivedAt: new Date() })
    .where(eq(projects.id, archived));
  const closed = await workspaceOf(ada.device, [bob.device]);
  const closedProject = await projectIn(closed.workspaceId, ada.device);
  await database()
    .update(workspaces)
    .set({ archivedAt: new Date() })
    .where(eq(workspaces.id, closed.workspaceId));

  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(adaConnection.client, team.workspaceId);

  // Bob stores a message in the shared workspace, whose event ID he then
  // reuses in the team.
  const elsewhere = sendOf(bob.device, shared.workspaceId, sharedProject, "x");
  bobConnection.client.send(elsewhere);
  await nextCreated(bobConnection.client, elsewhere);

  const cases = [
    [team.workspaceId, newId<ProjectId>(), "not_found"],
    // The reference binding: a project that the sender may post to, but
    // in another workspace than the event's.
    [team.workspaceId, sharedProject, "not_found"],
    [team.workspaceId, foreignProject, "not_found"],
    [team.workspaceId, archived, "conflict"],
    [closed.workspaceId, closedProject, "conflict"],
  ] as const;
  for (const [workspaceId, target, code] of cases) {
    const send = sendOf(bob.device, workspaceId, target, "Refused");
    bobConnection.client.send(send);
    await nextRefused(bobConnection.client, send.id, code);
  }
  const reused = sendOf(
    bob.device,
    team.workspaceId,
    projectId,
    "Reused",
    elsewhere.id,
  );
  bobConnection.client.send(reused);
  await nextRefused(bobConnection.client, reused.id, "conflict");
  await quiet(adaConnection.client, bobConnection.client);
  for (const target of [projectId, foreignProject, archived, closedProject]) {
    assert.deepEqual(await storedOf(target), [], target);
  }
  assert.deepEqual(await storedOf(sharedProject), [{ seq: 1, body: "x" }]);

  // The connection stayed open and still posts.
  assert.ok(isOpen(bobConnection.client));
  const accepted = sendOf(bob.device, team.workspaceId, projectId, "Fine");
  bobConnection.client.send(accepted);
  assert.equal((await nextCreated(bobConnection.client, accepted)).seq, 1);
  assert.equal((await nextCreated(adaConnection.client, accepted)).seq, 1);
});

test(`an account's sends above ${CHAT_SEND_LIMIT.burst.max} in ${CHAT_SEND_LIMIT.burst.windowMs / 1000} seconds, from any of its devices, get event.refused with rate_limited, and the connection stays open`, async (t) => {
  const clock = fakeClock();
  const { account } = await instance(t, { clock });
  const ada = await account(3731);
  const bob = await account(3732);
  const { workspaceId } = await workspaceOf(ada.device, [bob.device]);
  const projectId = await projectIn(workspaceId, ada.device);
  // Signed in first, so that its account frame reaches no connection.
  const bobDesktop = await signInDevice(bob.app);
  const bobLaptop = await connected(t, bob.app, bob.device);
  const bobSecond = await connected(t, bob.app, bobDesktop);
  const adaConnection = await connected(t, ada.app, ada.device);

  for (let index = 0; index < CHAT_SEND_LIMIT.burst.max; index += 1) {
    const send = sendOf(bob.device, workspaceId, projectId, `Line ${index}`);
    bobLaptop.client.send(send);
    await nextCreated(bobLaptop.client, send);
    clock.advance(100);
  }
  const fromLaptop = sendOf(bob.device, workspaceId, projectId, "Too many");
  bobLaptop.client.send(fromLaptop);
  await nextRefused(bobLaptop.client, fromLaptop.id, "rate_limited");
  const fromDesktop = sendOf(bobDesktop, workspaceId, projectId, "Too many");
  bobSecond.client.send(fromDesktop);
  await nextRefused(bobSecond.client, fromDesktop.id, "rate_limited");

  // Another account has its own limit.
  const fromAda = sendOf(ada.device, workspaceId, projectId, "Mine");
  adaConnection.client.send(fromAda);
  await nextCreated(adaConnection.client, fromAda);

  // The burst slides: the oldest send leaves it 10 seconds after it was sent.
  clock.advance(
    CHAT_SEND_LIMIT.burst.windowMs - 100 * CHAT_SEND_LIMIT.burst.max,
  );
  bobSecond.client.send(fromDesktop);
  await nextCreated(bobSecond.client, fromDesktop);
  bobLaptop.client.send(fromLaptop);
  await nextRefused(bobLaptop.client, fromLaptop.id, "rate_limited");
  assert.ok(isOpen(bobLaptop.client) && isOpen(bobSecond.client));
  await quiet(bobLaptop.client, bobSecond.client, adaConnection.client);
  assert.equal(
    (await storedOf(projectId)).length,
    CHAT_SEND_LIMIT.burst.max + 2,
  );
});

test("the send limit slides over the burst, counts a fixed hourly window, never counts a refused send, and forgets an account after its window", () => {
  const clock = fakeClock(0);
  const limit = new AccountSendLimit(clock.now, CHAT_SEND_LIMIT);
  const ada = newId<UserId>();
  const bob = newId<UserId>();
  const { burst, window } = CHAT_SEND_LIMIT;

  for (let index = 0; index < burst.max; index += 1) {
    assert.ok(limit.take(ada));
  }
  assert.equal(limit.take(ada), false);
  assert.ok(limit.take(bob));
  clock.advance(burst.windowMs - 1);
  assert.equal(limit.take(ada), false);
  clock.advance(1);
  assert.ok(limit.take(ada));

  // Up to the hourly maximum, in bursts; the refused sends above are not counted.
  let taken = burst.max + 1;
  while (taken < window.max) {
    clock.advance(burst.windowMs);
    for (let index = 0; index < burst.max && taken < window.max; index += 1) {
      assert.ok(limit.take(ada), `send ${taken + 1}`);
      taken += 1;
    }
  }
  clock.advance(burst.windowMs);
  assert.equal(limit.take(ada), false);
  assert.equal(limit.size, 2);
  clock.advance(window.windowMs - clock.now());
  limit.sweep();
  assert.equal(limit.size, 0);
  assert.ok(limit.take(ada));
});

test("the hourly window restarts with an accepted send only, not with a send that the burst refuses, and the sweep keeps an account whose burst is full", () => {
  const clock = fakeClock(0);
  const limit = new AccountSendLimit(clock.now, CHAT_SEND_LIMIT);
  const ada = newId<UserId>();
  const { burst, window } = CHAT_SEND_LIMIT;

  assert.ok(limit.take(ada));
  clock.advance(window.windowMs - burst.windowMs / 2);
  for (let index = 0; index < burst.max; index += 1) {
    assert.ok(limit.take(ada));
  }
  // The window ended, but the burst is full: refused, and no window starts.
  clock.advance(burst.windowMs / 2);
  assert.equal(limit.take(ada), false);
  limit.sweep();
  assert.equal(limit.size, 1, "the full burst is kept");

  clock.advance(burst.windowMs / 2);
  const restart = clock.now();
  let taken = 0;
  while (taken < window.max) {
    for (let index = 0; index < burst.max && taken < window.max; index += 1) {
      assert.ok(limit.take(ada), `send ${taken + 1}`);
      taken += 1;
    }
    clock.advance(burst.windowMs);
  }
  // The new window started with the accepted send at `restart`.
  clock.advance(restart + window.windowMs - 1 - clock.now());
  assert.equal(limit.take(ada), false);
  clock.advance(1);
  assert.ok(limit.take(ada));
});

test("a removed member's send, also a resent event ID of a stored message, closes the connection with not_a_member, ends its subscription, and stores nothing", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3741);
  const bob = await account(3742);
  const { workspaceId, memberIds } = await workspaceOf(ada.device, [
    bob.device,
  ]);
  const projectId = await projectIn(workspaceId, ada.device);
  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(adaConnection.client, workspaceId);
  await subscribed(bobConnection.client, workspaceId);
  assert.equal(
    (await nextFrame(adaConnection.client)).type,
    "presence.changed",
  );
  const before = sendOf(bob.device, workspaceId, projectId, "Before");
  bobConnection.client.send(before);
  const stored = await nextCreated(bobConnection.client, before);
  assert.deepEqual(await nextCreated(adaConnection.client, before), stored);
  const bobPerson = memberIds[0];
  assert.ok(bobPerson !== undefined);
  await removeInDatabase(bobPerson, ada.device);

  // The stored message is not sent again to a removed member.
  bobConnection.client.send(before);
  assert.deepEqual(await bobConnection.client.closed, {
    code: CloseCode.policyViolation,
    reason: "not_a_member",
  });
  assert.deepEqual(await nextFrame(adaConnection.client), {
    protocolVersion: 0,
    type: "presence.changed",
    workspaceId,
    memberId: bobPerson,
    status: "offline",
  });
  const again = await connected(t, bob.app, bob.device);
  again.client.send(sendOf(bob.device, workspaceId, projectId, "Still here?"));
  assert.deepEqual(await again.client.closed, {
    code: CloseCode.policyViolation,
    reason: "not_a_member",
  });
  await quiet(adaConnection.client);
  assert.equal(again.client.unread(), 0);
  assert.deepEqual(await storedOf(projectId), [{ seq: 1, body: "Before" }]);
});

test("after identity binding, the send handler refuses a removed member and a revoked device inside its transaction, and the gateway closes for its rejection", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3751);
  const bob = await account(3752);
  const { workspaceId, memberIds } = await workspaceOf(ada.device, [
    bob.device,
  ]);
  const projectId = await projectIn(workspaceId, ada.device);
  const bobPerson = memberIds[0];
  assert.ok(bobPerson !== undefined);
  const [device] = await database()
    .select({ lastSignInAt: devices.lastSignInAt })
    .from(devices)
    .where(eq(devices.id, bob.device.deviceId as DeviceId));
  assert.ok(device !== undefined);
  const context: AuthenticatedConnectionContext = Object.freeze({
    connectionId: newId<ConnectionId>(),
    identity: Object.freeze({
      userId: bob.device.userId,
      deviceId: bob.device.deviceId as DeviceId,
    }),
    signedInAt: device.lastSignInAt.getTime(),
  });
  // The handler registers its sweep on an app that has not started.
  const host = Fastify();
  t.after(() => host.close());
  const handle = chatSendHandler(host, {
    database: database(),
    now: Date.now,
    connections: new ConnectionRegistry(),
    log: bob.app.log,
  });
  /** A send that passed identity binding while the account was a member. */
  async function verified(body: string) {
    const decoded = decodeClientEvent(
      sendOf(bob.device, workspaceId, projectId, body),
    );
    assert.ok(decoded.ok);
    const bound = await bindIdentity(decoded.event, context, {
      database: database(),
      now: Date.now,
      mismatchAudits: new AuditThrottle(CONNECTION_AUDIT_WINDOW_MS, Date.now),
      log: bob.app.log,
    });
    assert.ok(bound.ok && bound.event.type === "chat.message.send");
    return bound.event;
  }

  const removedLater = await verified("Removed");
  await removeInDatabase(bobPerson, ada.device);
  assert.deepEqual(await handle(removedLater, context), {
    rejected: "not_a_member",
  });
  await database()
    .update(workspaceMembers)
    .set({ removedAt: null, removedByUserId: null })
    .where(eq(workspaceMembers.id, bobPerson));
  const revokedLater = await verified("Revoked");
  await database()
    .update(devices)
    .set({ revokedAt: new Date(), revocationReason: "lost" })
    .where(eq(devices.id, context.identity.deviceId));
  assert.deepEqual(await handle(revokedLater, context), {
    rejected: "device_revoked",
  });
  assert.deepEqual(await storedOf(projectId), []);

  // The gateway closes for a rejection as it does after identity binding.
  const rejecting = await instance(t, {
    onEvent: (event) =>
      event.type === "chat.message.send" &&
      event.payload.body === "device_revoked"
        ? { rejected: "device_revoked" }
        : { rejected: "not_a_member" },
  });
  const carol = await rejecting.account(3753);
  const dave = await rejecting.account(3754);
  const pair = await workspaceOf(carol.device, [dave.device]);
  const pairProject = await projectIn(pair.workspaceId, carol.device);
  const carolConnection = await connected(t, carol.app, carol.device);
  const daveConnection = await connected(t, dave.app, dave.device);
  await subscribed(carolConnection.client, pair.workspaceId);
  await subscribed(daveConnection.client, pair.workspaceId);
  assert.equal(
    (await nextFrame(carolConnection.client)).type,
    "presence.changed",
  );
  daveConnection.client.send(
    sendOf(dave.device, pair.workspaceId, pairProject, "Hello"),
  );
  assert.deepEqual(await daveConnection.client.closed, {
    code: CloseCode.policyViolation,
    reason: "not_a_member",
  });
  assert.equal(
    (await nextFrame(carolConnection.client)).type,
    "presence.changed",
  );
  carolConnection.client.send(
    sendOf(carol.device, pair.workspaceId, pairProject, "device_revoked"),
  );
  assert.deepEqual(
    await carolConnection.client.closed,
    closedWith("device_revoked"),
  );
});

test("the history pages the newest messages first, also of an archived project, and a malformed query answers 400 to a member", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3761);
  const bob = await account(3762);
  const { workspaceId } = await workspaceOf(ada.device, [bob.device]);
  const projectId = await projectIn(workspaceId, ada.device);
  const posted: ChatMessage[] = [];
  for (let index = 1; index <= 5; index += 1) {
    const result = await postChatMessage(database(), {
      actor: {
        workspaceId,
        userId: ada.device.userId,
        deviceId: ada.device.deviceId as DeviceId,
      },
      projectId,
      eventId: newId<EventId>(),
      body: `Message ${index}`,
      now: new Date(),
    });
    assert.ok(result.posted);
    posted.push(result.message);
  }
  const page = async (query: string) => {
    const response = await history(bob, projectId, query);
    assert.equal(response.statusCode, 200, response.body);
    return ChatHistoryResponseSchema.parse(response.json()).messages;
  };
  const newestFirst = [...posted].reverse();
  assert.deepEqual(await page(""), newestFirst);
  assert.deepEqual(await page("?limit=2"), newestFirst.slice(0, 2));
  assert.deepEqual(await page("?beforeSeq=4&limit=2"), newestFirst.slice(2, 4));
  assert.deepEqual(await page("?limit=2&beforeSeq=2"), newestFirst.slice(4));
  assert.deepEqual(await page("?beforeSeq=1"), []);
  assert.deepEqual(await page("?limit=100&unknown=1"), newestFirst);

  await database()
    .update(projects)
    .set({ archivedAt: new Date() })
    .where(eq(projects.id, projectId));
  assert.deepEqual(await page("?limit=1"), newestFirst.slice(0, 1));

  for (const query of [
    "?limit=0",
    "?limit=101",
    "?limit=01",
    "?limit=2.0",
    "?limit=abc",
    "?limit=1&limit=2",
    "?beforeSeq=0",
    "?beforeSeq=-1",
    "?beforeSeq=1e3",
    "?beforeSeq=",
  ]) {
    const response = await history(bob, projectId, query);
    assert.equal(response.statusCode, 400, query);
    assert.equal((response.json() as { code: string }).code, "bad_request");
  }
});

test("an unknown project, a project of another workspace, a malformed project ID, and a removed member get the same 404 from the history, whatever the query, and from the agent and run routes", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3771);
  const bob = await account(3772);
  const outsider = await account(3773);
  const { workspaceId, memberIds } = await workspaceOf(ada.device, [
    bob.device,
  ]);
  const projectId = await projectIn(workspaceId, ada.device);
  // The outsider is an active member of another workspace, with a project.
  const elsewhere = await workspaceOf(outsider.device);
  const ownProject = await projectIn(elsewhere.workspaceId, outsider.device);
  assert.equal((await history(outsider, ownProject)).statusCode, 200);
  assert.equal((await history(bob, projectId)).statusCode, 200);
  const bobPerson = memberIds[0];
  assert.ok(bobPerson !== undefined);
  await removeInDatabase(bobPerson, ada.device);

  // The agent and run routes lie in the same scope (#28).
  const read = (account: Account, id: string, route: string) =>
    account.app.inject({
      method: "GET",
      url: `/projects/${id}/${route}`,
      headers: { authorization: `Bearer ${account.token}` },
    });
  for (const route of ["agents", "runs"]) {
    assert.equal((await read(outsider, ownProject, route)).statusCode, 200);
  }
  const answers = [];
  for (const route of [
    "messages",
    "messages?limit=0",
    "messages?beforeSeq=x",
    "agents",
    "runs",
  ]) {
    answers.push(
      await read(outsider, projectId, route),
      await read(bob, projectId, route),
      await read(ada, newId<ProjectId>(), route),
      await read(ada, "not-an-id", route),
      await read(outsider, newId<ProjectId>(), route),
    );
  }
  for (const response of answers) {
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), NOT_FOUND);
    assert.equal(response.body, answers[0]?.body);
    assert.equal(
      response.headers["content-type"],
      answers[0]?.headers["content-type"],
    );
  }
  assert.equal((await history(ada, projectId)).statusCode, 200);
  for (const route of ["agents", "runs"]) {
    assert.equal((await read(ada, projectId, route)).statusCode, 200);
  }
});
