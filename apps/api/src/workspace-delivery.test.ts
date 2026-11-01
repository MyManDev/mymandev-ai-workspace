import {
  agentRuns,
  agents,
  type Database,
  projects,
  repositories,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  type AgentId,
  type AgentRunStateChangedEvent,
  type ChatMessageCreatedEvent,
  type ConnectionId,
  type CorrelationId,
  decodeServerMessage,
  type DeviceId,
  DefineMemberResponseSchema,
  type EventId,
  MAX_ANSWER_LIST_ITEMS,
  type MemberId,
  type MemberRole,
  newId,
  type ProjectId,
  type RepositoryId,
  type RunId,
  type RunState,
  type ServerEvent,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { WebSocket } from "ws";
import {
  accessToken,
  deviceApp,
  newKey,
  type SignedInDevice,
  signInDevice,
  useTestDatabase,
} from "./auth/device-test-support.ts";
import {
  type Client,
  closedWith,
  connected,
  interceptingDatabase,
  nextFrame,
  settle,
  signedResponse,
  until,
} from "./gateway-test-support.ts";
import {
  type AuthenticatedConnectionContext,
  CloseCode,
  ConnectionRegistry,
  type EventHandler,
  HEARTBEAT_INTERVAL_MS,
  MAX_BUFFERED_BYTES,
  MAX_SUBSCRIBE_RECHECKS,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  sweepConnections,
  type VerifiedEvent,
} from "./gateway.ts";
import {
  deliverWorkspaceEvent,
  serverEventHeader,
  type WorkspaceEvent,
  type WorkspaceEventHandler,
} from "./workspaces/events.ts";

const database = useTestDatabase();

type Json = Record<string, unknown>;

type Account = Readonly<{ app: FastifyInstance; device: SignedInDevice }>;

/**
 * One API instance: each account signs in through its own app (the fake
 * GitHub of an app knows one account), and every app shares one registry
 * of connections and one database, as one API process does.
 */
async function instance(
  t: TestContext,
  options: Readonly<{ database?: Database; onEvent?: EventHandler }> = {},
) {
  const connections = new ConnectionRegistry();
  const apps = new Map<number, FastifyInstance>();
  const appOf = async (githubId: number) => {
    const known = apps.get(githubId);
    if (known !== undefined) {
      return known;
    }
    const app = await deviceApp(t, {
      database: options.database ?? database(),
      githubId,
      connections,
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    // injectWS never settles unless the app is ready.
    await app.ready();
    apps.set(githubId, app);
    return app;
  };
  const account = async (githubId: number): Promise<Account> => {
    const app = await appOf(githubId);
    return { app, device: await signInDevice(app) };
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

/** Marks a person removed, as a removal of #93 or an operator would. */
async function removeInDatabase(memberId: MemberId, by: SignedInDevice) {
  await database()
    .update(workspaceMembers)
    .set({ removedAt: new Date(), removedByUserId: by.userId })
    .where(eq(workspaceMembers.id, memberId));
}

/** The `workspace.member.removed` event that a removal of the person sends. */
function removedEvent(
  workspaceId: WorkspaceId,
  memberId: MemberId,
): WorkspaceEvent {
  const now = new Date();
  return {
    ...serverEventHeader(workspaceId, now),
    type: "workspace.member.removed",
    payload: { memberId, removedAt: now.toISOString() },
  };
}

function subscribe(workspaceId: WorkspaceId): Json {
  return { protocolVersion: 0, type: "workspace.subscribe", workspaceId };
}

function unsubscribe(workspaceId: WorkspaceId): Json {
  return { protocolVersion: 0, type: "workspace.unsubscribe", workspaceId };
}

function refused(
  workspaceId: WorkspaceId,
  code: "not_found" | "too_many_subscriptions",
): Json {
  return {
    protocolVersion: 0,
    type: "workspace.subscribe_refused",
    workspaceId,
    code,
  };
}

function unsubscribed(
  workspaceId: WorkspaceId,
  reason: "requested" | "membership_ended",
): Json {
  return {
    protocolVersion: 0,
    type: "workspace.unsubscribed",
    workspaceId,
    reason,
  };
}

function presence(
  workspaceId: WorkspaceId,
  memberId: MemberId,
  status: "online" | "offline",
): Json {
  return {
    protocolVersion: 0,
    type: "presence.changed",
    workspaceId,
    memberId,
    status,
  };
}

/** Subscribes and returns the presence snapshot, sorted. */
async function subscribed(
  client: Client,
  workspaceId: WorkspaceId,
): Promise<MemberId[]> {
  client.send(subscribe(workspaceId));
  const frame = await nextFrame(client);
  assert.ok(
    frame.type === "workspace.subscribed" && frame.workspaceId === workspaceId,
    JSON.stringify(frame),
  );
  return [...frame.onlineMemberIds].sort();
}

/** The next message, which must be an event that the device's decoder accepts. */
async function nextEvent(client: Client): Promise<ServerEvent> {
  const decoded = decodeServerMessage(await client.next());
  assert.ok(decoded.ok && decoded.kind === "event", JSON.stringify(decoded));
  return decoded.event;
}

/** Lets pending frames arrive, then checks that none is left unread. */
async function quiet(...clients: Client[]) {
  await settle();
  for (const client of clients) {
    assert.equal(client.unread(), 0);
  }
}

/** A run transition that the agent's host device reports. */
function runEvent(workspaceId: WorkspaceId, deviceId: string): Json {
  const agentId = newId<AgentId>();
  return {
    protocolVersion: 0,
    id: newId<EventId>(),
    type: "agent.run.state_changed",
    occurredAt: "2026-11-01T12:00:00.000Z",
    workspaceId,
    actor: { kind: "agent", agentId },
    deviceId,
    payload: {
      runId: newId<RunId>(),
      agentId,
      previousState: "queued",
      state: "running",
    },
  };
}

test("workspace.subscribe answers workspace.subscribed with the people online, a repeated subscribe answers again with one subscription, and workspace.unsubscribe answers requested, also when not subscribed", async (t) => {
  const { connections, account } = await instance(t);
  const ada = await account(3201);
  const { workspaceId, ownerId } = await workspaceOf(ada.device);
  const { client } = await connected(t, ada.app, ada.device);

  for (let round = 0; round < 2; round += 1) {
    client.send(subscribe(workspaceId));
    assert.deepEqual(await nextFrame(client), {
      protocolVersion: 0,
      type: "workspace.subscribed",
      workspaceId,
      onlineMemberIds: [ownerId],
    });
  }
  assert.equal(connections.subscriptions().length, 1);

  const unknown = newId<WorkspaceId>();
  for (const target of [workspaceId, workspaceId, unknown]) {
    client.send(unsubscribe(target));
    assert.deepEqual(
      await nextFrame(client),
      unsubscribed(target, "requested"),
    );
  }
  assert.equal(connections.subscriptions().length, 0);

  // Each frame is answered in the order it arrived.
  client.send(subscribe(unknown));
  client.send(subscribe(workspaceId));
  client.send(unsubscribe(workspaceId));
  assert.deepEqual(await nextFrame(client), refused(unknown, "not_found"));
  assert.equal((await nextFrame(client)).type, "workspace.subscribed");
  assert.deepEqual(
    await nextFrame(client),
    unsubscribed(workspaceId, "requested"),
  );
  await quiet(client);
});

test("an unknown workspace, another account's workspace, and a workspace that the account was removed from get the same not_found, and the connection stays open", async (t) => {
  const { connections, account } = await instance(t);
  const ada = await account(3211);
  const bob = await account(3212);
  const foreign = await workspaceOf(ada.device);
  const left = await workspaceOf(ada.device, [bob.device]);
  const [bobInLeft] = left.memberIds;
  assert.ok(bobInLeft !== undefined);
  await removeInDatabase(bobInLeft, ada.device);
  const own = await workspaceOf(bob.device);
  const { client } = await connected(t, bob.app, bob.device);

  const answers: string[] = [];
  for (const target of [
    foreign.workspaceId,
    newId<WorkspaceId>(),
    left.workspaceId,
  ]) {
    client.send(subscribe(target));
    const frame = await nextFrame(client);
    assert.deepEqual(frame, refused(target, "not_found"));
    answers.push(JSON.stringify({ ...frame, workspaceId: null }));
  }
  assert.equal(new Set(answers).size, 1, "the answers differ only in the ID");

  assert.deepEqual(await subscribed(client, own.workspaceId), [own.ownerId]);
  assert.deepEqual(
    connections.subscriptions().map((subscription) => subscription.workspaceId),
    [own.workspaceId],
  );
  await quiet(client);
});

test("membership events reach the connections subscribed to their workspace after the commit, and no one else", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3221);
  const bob = await account(3222);
  const cleo = await account(3223);
  const dan = await account(3224);
  const first = await workspaceOf(ada.device, [bob.device]);
  const second = await workspaceOf(cleo.device);

  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  const cleoConnection = await connected(t, cleo.app, cleo.device);
  const danConnection = await connected(t, dan.app, dan.device);
  await subscribed(adaConnection.client, first.workspaceId);
  await subscribed(cleoConnection.client, second.workspaceId);
  // Bob is a member but did not subscribe; Dan is not a member.
  danConnection.client.send(subscribe(first.workspaceId));
  assert.deepEqual(
    await nextFrame(danConnection.client),
    refused(first.workspaceId, "not_found"),
  );

  const token = await accessToken(ada.app, ada.device);
  const post = (url: string, payload?: object) =>
    ada.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });
  const members = `/workspaces/${first.workspaceId}/members`;
  const defined = await post(members, { displayName: "Linus" });
  assert.equal(defined.statusCode, 200, defined.body);
  const { member } = DefineMemberResponseSchema.parse(defined.json());
  const renamed = await post(`${members}/${member.id}/rename`, {
    displayName: "Linus T.",
  });
  assert.equal(renamed.statusCode, 204, renamed.body);
  const removed = await post(`${members}/${member.id}/remove`);
  assert.equal(removed.statusCode, 204, removed.body);

  const received = [
    await nextEvent(adaConnection.client),
    await nextEvent(adaConnection.client),
    await nextEvent(adaConnection.client),
  ];
  assert.deepEqual(
    received.map((event) => event.type),
    [
      "workspace.member.defined",
      "workspace.member.renamed",
      "workspace.member.removed",
    ],
  );
  for (const event of received) {
    assert.equal(event.workspaceId, first.workspaceId);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
  }
  assert.deepEqual(received[0]?.payload, { member });

  // A change in the other workspace reaches only its subscriber.
  const cleoToken = await accessToken(cleo.app, cleo.device);
  const other = await cleo.app.inject({
    method: "POST",
    url: `/workspaces/${second.workspaceId}/members`,
    headers: { authorization: `Bearer ${cleoToken}` },
    payload: { displayName: "Grace" },
  });
  assert.equal(other.statusCode, 200, other.body);
  const event = await nextEvent(cleoConnection.client);
  assert.equal(event.type, "workspace.member.defined");
  assert.equal(event.workspaceId, second.workspaceId);

  await quiet(
    adaConnection.client,
    bobConnection.client,
    cleoConnection.client,
    danConnection.client,
  );
});

test("presence is per person: a snapshot on subscribe, then presence.changed only when a person comes online or goes offline, never for a second device, and never with a device ID", async (t) => {
  const { connections, account } = await instance(t);
  const ada = await account(3231);
  const adaDesktop = await signInDevice(ada.app);
  const bob = await account(3232);
  const {
    workspaceId,
    ownerId: adaId,
    memberIds: [bobId],
  } = await workspaceOf(ada.device, [bob.device]);
  assert.ok(bobId !== undefined);
  /** Every frame that the test reads, to check that none names a device. */
  const seen: unknown[] = [];
  const read = async (client: Client) => {
    const frame = await nextFrame(client);
    seen.push(frame);
    return frame;
  };

  const bobConnection = await connected(t, bob.app, bob.device);
  assert.deepEqual(await subscribed(bobConnection.client, workspaceId), [
    bobId,
  ]);
  const laptop = await connected(t, ada.app, ada.device);
  laptop.client.send(subscribe(workspaceId));
  assert.deepEqual(
    await read(bobConnection.client),
    presence(workspaceId, adaId, "online"),
  );
  const snapshot = await read(laptop.client);
  assert.ok(snapshot.type === "workspace.subscribed");
  assert.deepEqual(snapshot.onlineMemberIds, [adaId, bobId], "own first");

  // A second device of a person who is online changes nothing.
  const desktop = await connected(t, ada.app, adaDesktop);
  assert.deepEqual(
    await subscribed(desktop.client, workspaceId),
    [adaId, bobId].sort(),
  );
  await quiet(bobConnection.client, laptop.client);
  laptop.client.send(unsubscribe(workspaceId));
  assert.deepEqual(
    await read(laptop.client),
    unsubscribed(workspaceId, "requested"),
  );
  await quiet(bobConnection.client, desktop.client);

  // The gateway closes the desktop's connection, Ada's last subscribed one.
  desktop.client.send(Buffer.from([1]));
  assert.equal((await desktop.client.closed).code, CloseCode.unsupportedData);
  assert.deepEqual(
    await read(bobConnection.client),
    presence(workspaceId, adaId, "offline"),
  );

  // Online again, then a newer connection of the laptop replaces the
  // subscribed one, which no longer counts.
  laptop.client.send(subscribe(workspaceId));
  assert.deepEqual(
    await read(bobConnection.client),
    presence(workspaceId, adaId, "online"),
  );
  assert.equal((await read(laptop.client)).type, "workspace.subscribed");
  const replacing = await connected(t, ada.app, ada.device);
  assert.deepEqual(
    await laptop.client.closed,
    closedWith("connection_replaced"),
  );
  assert.deepEqual(
    await read(bobConnection.client),
    presence(workspaceId, adaId, "offline"),
  );
  assert.equal(connections.subscriptions().length, 1, "only Bob's");

  const text = JSON.stringify(seen);
  assert.ok(!text.includes("deviceId"));
  for (const deviceId of [
    ada.device.deviceId,
    adaDesktop.deviceId,
    bob.device.deviceId,
  ]) {
    assert.ok(!text.includes(deviceId), "no frame names a device");
  }
  await quiet(bobConnection.client, replacing.client);
});

test("with real sockets, a subscribed connection that closes drops its subscription, and its person goes offline", async (t) => {
  const { connections, account } = await instance(t);
  const ada = await account(3241);
  const bob = await account(3242);
  const {
    workspaceId,
    ownerId: adaId,
    memberIds: [bobId],
  } = await workspaceOf(ada.device, [bob.device]);
  assert.ok(bobId !== undefined);
  // injectWS sockets never report their close to the server.
  await ada.app.listen({ host: "127.0.0.1", port: 0 });
  const address = ada.app.server.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const open = async (device: SignedInDevice) => {
    const socket = new globalThis.WebSocket(url);
    t.after(() => socket.close());
    const messages: Json[] = [];
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)) as Json);
    });
    await until(() => messages.length === 1, "the challenge");
    const decoded = decodeServerMessage(messages[0]);
    assert.ok(
      decoded.ok &&
        decoded.kind === "frame" &&
        decoded.frame.type === "auth.challenge",
    );
    socket.send(JSON.stringify(signedResponse(device, decoded.frame)));
    await until(() => messages.length === 2, "auth.ok");
    socket.send(JSON.stringify(subscribe(workspaceId)));
    await until(() => messages.length === 3, "workspace.subscribed");
    assert.equal(messages[2]?.type, "workspace.subscribed");
    return { socket, messages };
  };

  const answered = t.mock.method(connections, "answered");
  const bobSocket = await open(bob.device);
  const adaSocket = await open(ada.device);
  await until(() => bobSocket.messages.length === 4, "Ada online");
  assert.deepEqual(
    bobSocket.messages[3],
    presence(workspaceId, adaId, "online"),
  );
  // A standard WebSocket client answers the heartbeat's pings on its own.
  assert.equal(connections.heartbeat(ada.app.log), 0);
  await until(() => answered.mock.callCount() === 2, "both pongs");
  assert.equal(connections.heartbeat(ada.app.log), 0);
  assert.equal(connections.liveCount, 2);
  adaSocket.socket.close();
  await until(() => bobSocket.messages.length === 5, "Ada offline");
  assert.deepEqual(
    bobSocket.messages[4],
    presence(workspaceId, adaId, "offline"),
  );
  assert.deepEqual(
    connections.subscriptions().map((subscription) => subscription.memberId),
    [bobId],
  );
});

test("when a person's membership ends, the subscriptions end with membership_ended: on the removal event, in the sweep, on an event, and on a new subscribe", async (t) => {
  const { connections, account } = await instance(t);
  const ada = await account(3251);
  const bob = await account(3252);
  // One workspace for each way that the membership ends.
  const byEvent = await workspaceOf(ada.device, [bob.device]);
  const bySweep = await workspaceOf(ada.device, [bob.device]);
  const byCheck = await workspaceOf(ada.device, [bob.device]);
  const bySubscribe = await workspaceOf(ada.device, [bob.device]);
  const bobIn = (workspace: { memberIds: MemberId[] }) => {
    const [memberId] = workspace.memberIds;
    assert.ok(memberId !== undefined);
    return memberId;
  };
  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  for (const workspace of [byEvent, bySweep, byCheck, bySubscribe]) {
    await subscribed(adaConnection.client, workspace.workspaceId);
    await subscribed(bobConnection.client, workspace.workspaceId);
    assert.deepEqual(
      await nextFrame(adaConnection.client),
      presence(workspace.workspaceId, bobIn(workspace), "online"),
    );
  }
  const adaClient = adaConnection.client;
  const bobClient = bobConnection.client;

  // The removal event: Bob's subscription ends before the event reaches
  // the other subscribers, and Bob never gets the event.
  await removeInDatabase(bobIn(byEvent), ada.device);
  deliverWorkspaceEvent(
    connections,
    removedEvent(byEvent.workspaceId, bobIn(byEvent)),
    ada.app.log,
  );
  assert.deepEqual(
    await nextFrame(bobClient),
    unsubscribed(byEvent.workspaceId, "membership_ended"),
  );
  assert.deepEqual(
    await nextFrame(adaClient),
    presence(byEvent.workspaceId, bobIn(byEvent), "offline"),
  );
  const removal = await nextEvent(adaClient);
  assert.ok(removal.type === "workspace.member.removed");
  assert.equal(removal.payload.memberId, bobIn(byEvent));
  await quiet(adaClient, bobClient);

  // The sweep; a second sweep finds nothing more.
  await removeInDatabase(bobIn(bySweep), ada.device);
  const sweep = () =>
    sweepConnections({
      connections,
      database: database(),
      now: Date.now,
      log: ada.app.log,
    });
  await sweep();
  assert.deepEqual(
    await nextFrame(bobClient),
    unsubscribed(bySweep.workspaceId, "membership_ended"),
  );
  assert.deepEqual(
    await nextFrame(adaClient),
    presence(bySweep.workspaceId, bobIn(bySweep), "offline"),
  );
  await sweep();
  await quiet(adaClient, bobClient);

  // An event in a subscribed workspace: identity binding finds that Bob is
  // no longer a member, and the connection closes as before; its other
  // subscription ends with it.
  await removeInDatabase(bobIn(byCheck), ada.device);
  bobClient.send(runEvent(byCheck.workspaceId, bob.device.deviceId));
  assert.deepEqual(
    await nextFrame(bobClient),
    unsubscribed(byCheck.workspaceId, "membership_ended"),
  );
  assert.deepEqual(await bobConnection.client.closed, {
    code: CloseCode.policyViolation,
    reason: "not_a_member",
  });
  assert.deepEqual(
    [await nextFrame(adaClient), await nextFrame(adaClient)],
    [
      presence(byCheck.workspaceId, bobIn(byCheck), "offline"),
      presence(bySubscribe.workspaceId, bobIn(bySubscribe), "offline"),
    ],
  );

  // A new subscribe to a workspace that Bob holds after his removal.
  const again = await connected(t, bob.app, bob.device);
  await subscribed(again.client, bySubscribe.workspaceId);
  assert.deepEqual(
    await nextFrame(adaClient),
    presence(bySubscribe.workspaceId, bobIn(bySubscribe), "online"),
  );
  await removeInDatabase(bobIn(bySubscribe), ada.device);
  again.client.send(subscribe(bySubscribe.workspaceId));
  assert.deepEqual(
    await nextFrame(again.client),
    unsubscribed(bySubscribe.workspaceId, "membership_ended"),
  );
  assert.deepEqual(
    await nextFrame(again.client),
    refused(bySubscribe.workspaceId, "not_found"),
  );
  assert.deepEqual(
    await nextFrame(adaClient),
    presence(bySubscribe.workspaceId, bobIn(bySubscribe), "offline"),
  );
  assert.equal(
    connections
      .subscriptions()
      .filter(({ context }) => context.identity.userId === bob.device.userId)
      .length,
    0,
  );
  await quiet(adaClient, again.client);
});

test("a removal that the server processes while a subscribe checks the membership makes the subscribe check again", async (t) => {
  const intercepting = interceptingDatabase(database());
  const { connections, account } = await instance(t, {
    database: intercepting.database,
  });
  const ada = await account(3261);
  const bob = await account(3262);
  const {
    workspaceId,
    memberIds: [bobId],
  } = await workspaceOf(ada.device, [bob.device]);
  assert.ok(bobId !== undefined);
  const { client } = await connected(t, bob.app, bob.device);

  // The first check reads Bob's person before the removal commits; the
  // server processes the removal meanwhile, and the check that follows sees
  // it.
  intercepting.interceptNext("select", workspaceMembers, async () => {
    deliverWorkspaceEvent(
      connections,
      removedEvent(workspaceId, bobId),
      ada.app.log,
    );
    intercepting.interceptNext("select", workspaceMembers, () =>
      removeInDatabase(bobId, ada.device),
    );
  });
  const before = intercepting.started("select", workspaceMembers);
  client.send(subscribe(workspaceId));
  assert.deepEqual(await nextFrame(client), refused(workspaceId, "not_found"));
  assert.equal(
    intercepting.started("select", workspaceMembers) - before,
    2,
    "the subscribe checked twice",
  );
  assert.equal(connections.subscriptions().length, 0);
  await quiet(client);
});

test("a removal processed in another workspace while a subscribe checks the membership causes no second check", async (t) => {
  const intercepting = interceptingDatabase(database());
  const { connections, account } = await instance(t, {
    database: intercepting.database,
  });
  const ada = await account(3263);
  const bob = await account(3264);
  const first = await workspaceOf(ada.device, [bob.device]);
  const other = await workspaceOf(ada.device);
  const { client } = await connected(t, bob.app, bob.device);

  intercepting.interceptNext("select", workspaceMembers, async () => {
    deliverWorkspaceEvent(
      connections,
      removedEvent(other.workspaceId, newId<MemberId>()),
      ada.app.log,
    );
  });
  const before = intercepting.started("select", workspaceMembers);
  assert.deepEqual(
    await subscribed(client, first.workspaceId),
    first.memberIds,
  );
  assert.equal(
    intercepting.started("select", workspaceMembers) - before,
    1,
    "the subscribe checked once",
  );
  await quiet(client);
});

test(`while removals in its workspace keep coming, a subscribe checks at most ${1 + MAX_SUBSCRIBE_RECHECKS} times and then answers not_found`, async (t) => {
  const intercepting = interceptingDatabase(database());
  const { connections, account } = await instance(t, {
    database: intercepting.database,
  });
  const ada = await account(3265);
  const bob = await account(3266);
  const {
    workspaceId,
    memberIds: [bobId],
  } = await workspaceOf(ada.device, [bob.device]);
  assert.ok(bobId !== undefined);
  const { client } = await connected(t, bob.app, bob.device);

  // Every check overlaps the removal of another person of the workspace.
  let remaining = 1 + MAX_SUBSCRIBE_RECHECKS;
  const churn = () => {
    intercepting.interceptNext("select", workspaceMembers, async () => {
      deliverWorkspaceEvent(
        connections,
        removedEvent(workspaceId, newId<MemberId>()),
        ada.app.log,
      );
      remaining -= 1;
      if (remaining > 0) {
        churn();
      }
    });
  };
  churn();
  const before = intercepting.started("select", workspaceMembers);
  client.send(subscribe(workspaceId));
  assert.deepEqual(await nextFrame(client), refused(workspaceId, "not_found"));
  assert.equal(
    intercepting.started("select", workspaceMembers) - before,
    1 + MAX_SUBSCRIBE_RECHECKS,
  );
  assert.equal(connections.subscriptions().length, 0);

  // Once the removals stop, Bob subscribes as before.
  assert.deepEqual(await subscribed(client, workspaceId), [bobId]);
  await quiet(client);
});

/** A project in the workspace, with a repository, written directly. */
async function projectIn(workspaceId: WorkspaceId, by: SignedInDevice) {
  const projectId = newId<ProjectId>();
  await database().insert(projects).values({
    id: projectId,
    workspaceId,
    name: "App",
    createdByUserId: by.userId,
  });
  const repositoryId = newId<RepositoryId>();
  await database().insert(repositories).values({
    id: repositoryId,
    projectId,
    name: "app",
    createdByUserId: by.userId,
  });
  return { projectId, repositoryId };
}

async function agentOn(projectId: ProjectId, host: SignedInDevice) {
  const agentId = newId<AgentId>();
  await database().insert(agents).values({
    id: agentId,
    projectId,
    ownerUserId: host.userId,
    hostDeviceId: host.deviceId,
    name: "Builder",
  });
  return agentId;
}

async function runOf(
  agentId: AgentId,
  projectId: ProjectId,
  state: RunState,
  requestedBy: SignedInDevice,
  fields: Partial<typeof agentRuns.$inferInsert> = {},
): Promise<RunId> {
  const id = newId<RunId>();
  const finished =
    state === "completed" || state === "failed" || state === "cancelled";
  await database()
    .insert(agentRuns)
    .values({
      id,
      agentId,
      projectId,
      requestedByUserId: requestedBy.userId,
      state,
      ...(finished ? { finishedAt: new Date() } : {}),
      ...fields,
    });
  return id;
}

/** Checks a cancelled run's event as the device decodes it. */
function assertCancelled(
  event: ServerEvent,
  expected: Readonly<{
    workspaceId: WorkspaceId;
    runId: RunId;
    agentId: AgentId;
    previousState: RunState;
    repositoryId?: RepositoryId;
    correlationId?: CorrelationId;
  }>,
) {
  assert.ok(event.type === "agent.run.state_changed", event.type);
  const run: AgentRunStateChangedEvent = event;
  assert.equal(run.workspaceId, expected.workspaceId);
  assert.deepEqual(run.actor, { kind: "system" });
  assert.equal(run.deviceId, null);
  assert.equal(run.correlationId, expected.correlationId);
  assert.deepEqual(run.payload, {
    runId: expected.runId,
    agentId: expected.agentId,
    ...(expected.repositoryId === undefined
      ? {}
      : { repositoryId: expected.repositoryId }),
    previousState: expected.previousState,
    state: "cancelled",
    reason: "device_revoked",
  });
}

test("revoking a device sends each run that it cancelled as agent.run.state_changed from the system to the connections subscribed to the run's workspace, and to no one else", async (t) => {
  const { connections, account } = await instance(t);
  const ada = await account(3271);
  const adaDesktop = await signInDevice(ada.app);
  const bob = await account(3272);
  const cleo = await account(3273);
  const dan = await account(3274);
  const first = await workspaceOf(ada.device, [bob.device]);
  const second = await workspaceOf(cleo.device, [ada.device]);
  const one = await projectIn(first.workspaceId, ada.device);
  const two = await projectIn(second.workspaceId, cleo.device);
  // Ada's laptop hosts an agent in each workspace; Bob's device hosts one.
  const laptopAgent = await agentOn(one.projectId, ada.device);
  const otherAgent = await agentOn(two.projectId, ada.device);
  const bobsAgent = await agentOn(one.projectId, bob.device);
  const correlationId = newId<CorrelationId>();
  const queued = await runOf(laptopAgent, one.projectId, "queued", ada.device);
  const running = await runOf(
    laptopAgent,
    one.projectId,
    "running",
    ada.device,
    { repositoryId: one.repositoryId, correlationId },
  );
  const awaiting = await runOf(
    laptopAgent,
    one.projectId,
    "awaiting_input",
    bob.device,
  );
  await runOf(laptopAgent, one.projectId, "completed", ada.device);
  const elsewhere = await runOf(
    otherAgent,
    two.projectId,
    "running",
    cleo.device,
  );
  await runOf(bobsAgent, one.projectId, "running", bob.device);

  const bobConnection = await connected(t, bob.app, bob.device);
  const cleoConnection = await connected(t, cleo.app, cleo.device);
  const danConnection = await connected(t, dan.app, dan.device);
  const desktop = await connected(t, ada.app, adaDesktop);
  const laptop = await connected(t, ada.app, ada.device);
  await subscribed(bobConnection.client, first.workspaceId);
  await subscribed(cleoConnection.client, second.workspaceId);
  await subscribed(desktop.client, first.workspaceId);
  await subscribed(desktop.client, second.workspaceId);
  assert.equal(
    (await nextFrame(bobConnection.client)).type,
    "presence.changed",
  );
  assert.equal(
    (await nextFrame(cleoConnection.client)).type,
    "presence.changed",
  );
  // Ada is online already, so the laptop changes no presence.
  await subscribed(laptop.client, first.workspaceId);
  await subscribed(laptop.client, second.workspaceId);

  const token = await accessToken(ada.app, adaDesktop);
  const response = await ada.app.inject({
    method: "POST",
    url: `/devices/${ada.device.deviceId}/revoke`,
    headers: { authorization: `Bearer ${token}` },
    payload: { reason: "removed" },
  });
  assert.equal(response.statusCode, 204, response.body);
  assert.deepEqual(await laptop.client.closed, closedWith("device_revoked"));

  const inFirst = [
    { runId: queued, previousState: "queued" as const },
    {
      runId: running,
      previousState: "running" as const,
      repositoryId: one.repositoryId,
      correlationId,
    },
    { runId: awaiting, previousState: "awaiting_input" as const },
  ].map((run) => ({
    ...run,
    workspaceId: first.workspaceId,
    agentId: laptopAgent,
  }));
  const inSecond = {
    workspaceId: second.workspaceId,
    runId: elsewhere,
    agentId: otherAgent,
    previousState: "running" as const,
  };
  const bobEvents: ServerEvent[] = [];
  for (const expected of inFirst) {
    const event = await nextEvent(bobConnection.client);
    assertCancelled(event, expected);
    bobEvents.push(event);
  }
  const cleoEvent = await nextEvent(cleoConnection.client);
  assertCancelled(cleoEvent, inSecond);

  // Ada's desktop hears of the revocation, then gets the same events.
  assert.equal(
    (await nextFrame(desktop.client)).type,
    "account.device_revoked",
  );
  const desktopEvents: ServerEvent[] = [];
  for (const expected of [...inFirst, inSecond]) {
    const event = await nextEvent(desktop.client);
    assertCancelled(event, expected);
    desktopEvents.push(event);
  }
  assert.deepEqual(desktopEvents, [...bobEvents, cleoEvent]);
  assert.ok(
    !JSON.stringify(desktopEvents).includes(ada.device.deviceId),
    "no event names the revoked device",
  );
  assert.ok(
    connections
      .subscriptions()
      .every(
        ({ context }) => context.identity.deviceId !== ada.device.deviceId,
      ),
    "the revoked device's subscriptions ended",
  );
  await quiet(
    bobConnection.client,
    cleoConnection.client,
    danConnection.client,
    desktop.client,
  );
});

test("a sign-in that replaces a previous device sends the runs that the revocation cancelled to the workspace's subscribers", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3281);
  const bob = await account(3282);
  const { workspaceId } = await workspaceOf(ada.device, [bob.device]);
  const { projectId } = await projectIn(workspaceId, ada.device);
  const agentId = await agentOn(projectId, ada.device);
  const runId = await runOf(agentId, projectId, "running", ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(bobConnection.client, workspaceId);

  await signInDevice(ada.app, newKey(), ada.device.deviceId);
  assertCancelled(await nextEvent(bobConnection.client), {
    workspaceId,
    runId,
    agentId,
    previousState: "running",
  });
  await quiet(bobConnection.client);
});

test(`a connection holds at most ${MAX_SUBSCRIPTIONS_PER_CONNECTION} subscriptions: the next gets too_many_subscriptions, a held workspace can be subscribed again, and an unsubscribe frees a place`, async (t) => {
  const { connections, account } = await instance(t);
  const ada = await account(3291);
  const ids: WorkspaceId[] = [];
  for (let index = 0; index <= MAX_SUBSCRIPTIONS_PER_CONNECTION; index += 1) {
    ids.push((await workspaceOf(ada.device)).workspaceId);
  }
  const extra = ids.at(-1);
  const [held] = ids;
  assert.ok(extra !== undefined && held !== undefined);
  const { client } = await connected(t, ada.app, ada.device);
  for (const workspaceId of ids.slice(0, -1)) {
    await subscribed(client, workspaceId);
  }
  assert.equal(connections.subscriptions().length, 50);

  client.send(subscribe(extra));
  assert.deepEqual(
    await nextFrame(client),
    refused(extra, "too_many_subscriptions"),
  );
  // The cap is checked first, so an unknown workspace gets the same answer.
  const unknown = newId<WorkspaceId>();
  client.send(subscribe(unknown));
  assert.deepEqual(
    await nextFrame(client),
    refused(unknown, "too_many_subscriptions"),
  );
  await subscribed(client, held);
  client.send(unsubscribe(held));
  assert.deepEqual(await nextFrame(client), unsubscribed(held, "requested"));
  await subscribed(client, extra);
  assert.equal(connections.subscriptions().length, 50);
  await quiet(client);
});

test("chat.message.send passes identity binding to the event handler and is neither relayed to the workspace's subscribers nor answered", async (t) => {
  const received: VerifiedEvent[] = [];
  const { account } = await instance(t, {
    onEvent: (event) => {
      received.push(event);
    },
  });
  const ada = await account(3301);
  const bob = await account(3302);
  const { workspaceId } = await workspaceOf(ada.device, [bob.device]);
  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(adaConnection.client, workspaceId);
  await subscribed(bobConnection.client, workspaceId);
  assert.equal(
    (await nextFrame(adaConnection.client)).type,
    "presence.changed",
  );

  const send = {
    protocolVersion: 0,
    id: newId<EventId>(),
    type: "chat.message.send",
    occurredAt: "2026-11-01T12:00:00.000Z",
    workspaceId,
    actor: { kind: "user", userId: bob.device.userId },
    deviceId: bob.device.deviceId,
    payload: { projectId: newId<ProjectId>(), body: "Hello\nworld" },
  };
  bobConnection.client.send(send);
  await until(() => received.length === 1, "the event handler");
  assert.equal(received[0]?.type, "chat.message.send");
  assert.equal(received[0]?.id, send.id);
  await quiet(adaConnection.client, bobConnection.client);
});

test("the heartbeat pings every 30 seconds and terminates a connection that did not answer the previous ping; its person goes offline at once", async (t) => {
  const connections = new ConnectionRegistry();
  // Bob signs in through his own app, whose intervals stay on the real
  // clock; both devices then connect through Ada's app, whose intervals run
  // on the mocked clock.
  const bobApp = await deviceApp(t, {
    database: database(),
    githubId: 3322,
    connections,
  });
  const bob = await signInDevice(bobApp);
  t.mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => t.mock.timers.reset());
  const app = await deviceApp(t, {
    database: database(),
    githubId: 3321,
    connections,
  });
  await app.ready();
  const ada = await signInDevice(app);
  const answered = t.mock.method(connections, "answered");
  const heartbeat = t.mock.method(connections, "heartbeat");

  const {
    workspaceId,
    ownerId: adaId,
    memberIds: [bobId],
  } = await workspaceOf(ada, [bob]);
  assert.ok(bobId !== undefined);
  const adaConnection = await connected(t, app, ada);
  const bobConnection = await connected(t, app, bob);
  await subscribed(adaConnection.client, workspaceId);
  await subscribed(bobConnection.client, workspaceId);
  assert.deepEqual(
    await nextFrame(adaConnection.client),
    presence(workspaceId, bobId, "online"),
  );
  // Ada's device answers pings, as every standard client does; Bob's device
  // is gone without a close and answers nothing. An injectWS client does
  // not answer pings on its own.
  let adaPings = 0;
  adaConnection.client.ws.on("ping", (data) => {
    adaPings += 1;
    adaConnection.client.ws.pong(data);
  });
  let bobPings = 0;
  bobConnection.client.ws.on("ping", () => {
    bobPings += 1;
  });

  t.mock.timers.tick(HEARTBEAT_INTERVAL_MS - 1);
  await settle();
  assert.deepEqual([adaPings, bobPings], [0, 0]);
  t.mock.timers.tick(1);
  await until(() => answered.mock.callCount() === 1, "Ada's pong");
  assert.deepEqual([adaPings, bobPings], [1, 1]);
  assert.equal(connections.liveCount, 2, "one unanswered ping is allowed");

  t.mock.timers.tick(HEARTBEAT_INTERVAL_MS);
  assert.deepEqual(
    await nextFrame(adaConnection.client),
    presence(workspaceId, bobId, "offline"),
  );
  assert.equal(connections.liveCount, 1);
  assert.deepEqual(
    connections.subscriptions().map((subscription) => subscription.memberId),
    [adaId],
  );
  // The server's socket of Bob's connection is gone.
  await until(
    () => app.websocketServer.clients.size === 1,
    "the terminated socket's close on the server",
  );
  await until(() => answered.mock.callCount() === 2, "Ada's second pong");
  assert.deepEqual([adaPings, bobPings], [2, 1]);

  t.mock.timers.tick(HEARTBEAT_INTERVAL_MS);
  assert.equal(connections.liveCount, 1, "Ada answers and stays");
  await quiet(adaConnection.client);

  // Closing the app clears the heartbeat.
  await app.close();
  const beats = heartbeat.mock.callCount();
  t.mock.timers.tick(2 * HEARTBEAT_INTERVAL_MS);
  assert.equal(heartbeat.mock.callCount(), beats);
});

/** A socket that records what the registry sends and how it ends. */
function fakeSocket(record = true) {
  const sent: Json[] = [];
  const closes: Array<readonly [number, string]> = [];
  const state = { pings: 0, terminated: false };
  const socket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (text: string) => {
      if (record) {
        sent.push(JSON.parse(text) as Json);
      }
    },
    close: (code: number, reason: string) => {
      closes.push([code, reason]);
      socket.readyState = 2;
    },
    ping: () => {
      state.pings += 1;
    },
    terminate: () => {
      state.terminated = true;
      socket.readyState = 3;
    },
  };
  return { socket, ws: socket as unknown as WebSocket, sent, closes, state };
}

/** A live connection with a fake socket, registered and confirmed. */
function fakeConnection(registry: ConnectionRegistry, record = true) {
  const fake = fakeSocket(record);
  const context: AuthenticatedConnectionContext = Object.freeze({
    connectionId: newId<ConnectionId>(),
    identity: Object.freeze({
      userId: newId<UserId>(),
      deviceId: newId<DeviceId>(),
    }),
    signedInAt: 0,
  });
  registry.register(fake.ws, context, 0);
  registry.confirm(context);
  return { ...fake, context, memberId: newId<MemberId>() };
}

test("a connection with more than 1 MiB waiting to be sent closes with 1013 and backpressure instead of queueing more, and its person goes offline", () => {
  const registry = new ConnectionRegistry();
  const workspaceId = newId<WorkspaceId>();
  const fast = fakeConnection(registry);
  const slow = fakeConnection(registry);
  registry.subscribe(fast.context, workspaceId, fast.memberId);
  registry.subscribe(slow.context, workspaceId, slow.memberId);
  assert.deepEqual(fast.sent, [presence(workspaceId, slow.memberId, "online")]);
  fast.sent.length = 0;
  const event = (): ServerEvent => removedEvent(workspaceId, newId<MemberId>());

  // Exactly 1 MiB still gets more.
  slow.socket.bufferedAmount = MAX_BUFFERED_BYTES;
  assert.equal(registry.sendToWorkspace(event()), 2);
  assert.equal(slow.sent.length, 1);

  slow.socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
  const next = event();
  assert.equal(registry.sendToWorkspace(next), 1);
  assert.equal(slow.sent.length, 1, "nothing more is queued");
  assert.deepEqual(slow.closes, [[CloseCode.tryAgainLater, "backpressure"]]);
  assert.equal(registry.connectionOf(slow.context.identity.deviceId), null);
  assert.deepEqual(
    registry.subscriptions().map((subscription) => subscription.memberId),
    [fast.memberId],
  );
  // The fast connection got the event first, then the slow one's close.
  assert.deepEqual(fast.sent.slice(-2), [
    JSON.parse(JSON.stringify(next)),
    presence(workspaceId, slow.memberId, "offline"),
  ]);

  // Account frames and pings check the buffer too.
  fast.socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
  const pinged = fast.state.pings;
  registry.heartbeat(registryLog());
  assert.equal(fast.state.pings, pinged, "no ping is queued");
  assert.deepEqual(fast.closes, [[CloseCode.tryAgainLater, "backpressure"]]);
  assert.equal(registry.liveCount, 0);
});

/** A logger that drops every line. */
function registryLog(): FastifyBaseLogger {
  const log = {
    child: () => log,
    level: "silent",
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    silent: () => undefined,
  };
  return log as unknown as FastifyBaseLogger;
}

test("the heartbeat terminates only a connection that missed a ping, and answered pongs keep the others", () => {
  const registry = new ConnectionRegistry();
  const workspaceId = newId<WorkspaceId>();
  const alive = fakeConnection(registry);
  const silent = fakeConnection(registry);
  registry.subscribe(alive.context, workspaceId, alive.memberId);
  registry.subscribe(silent.context, workspaceId, silent.memberId);
  alive.sent.length = 0;

  assert.equal(registry.heartbeat(registryLog()), 0);
  assert.deepEqual([alive.state.pings, silent.state.pings], [1, 1]);
  registry.answered(alive.context);
  assert.equal(registry.heartbeat(registryLog()), 1);
  assert.equal(silent.state.terminated, true);
  assert.equal(alive.state.terminated, false);
  assert.deepEqual(alive.sent, [
    presence(workspaceId, silent.memberId, "offline"),
  ]);
  assert.equal(alive.state.pings, 2);
  assert.equal(registry.liveCount, 1);
});

test(`workspace.subscribed lists the subscriber's own person first, so a list cut at ${MAX_ANSWER_LIST_ITEMS} keeps it`, () => {
  const registry = new ConnectionRegistry();
  const workspaceId = newId<WorkspaceId>();
  for (let index = 0; index < MAX_ANSWER_LIST_ITEMS; index += 1) {
    const other = fakeConnection(registry, false);
    registry.subscribe(other.context, workspaceId, other.memberId);
  }
  const last = fakeConnection(registry);
  const online = registry.subscribe(last.context, workspaceId, last.memberId);
  assert.ok(online !== null);
  assert.equal(online.length, MAX_ANSWER_LIST_ITEMS);
  assert.equal(online[0], last.memberId);
});

test("the type checker refuses a chat or run event where only membership events are meant", () => {
  const typeOnly = (
    handler: WorkspaceEventHandler,
    created: ChatMessageCreatedEvent,
    run: AgentRunStateChangedEvent,
    removed: Extract<WorkspaceEvent, { type: "workspace.member.removed" }>,
    registry: ConnectionRegistry,
    log: FastifyBaseLogger,
  ) => {
    // @ts-expect-error -- chat.message.created is not a membership event
    void handler(created);
    // @ts-expect-error -- a run event is not a membership event
    void handler(run);
    // @ts-expect-error -- deliverWorkspaceEvent takes only membership events
    deliverWorkspaceEvent(registry, created, log);
    void handler(removed);
    deliverWorkspaceEvent(registry, removed, log);
  };
  assert.equal(typeof typeOnly, "function");
});
