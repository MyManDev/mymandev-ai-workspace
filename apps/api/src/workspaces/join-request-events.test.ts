import {
  createDatabase,
  type Database,
  workspaceJoinRequests,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  createTestDatabase,
  type TestDatabase,
} from "@mymandev/database/testing";
import {
  type AgentRunStateChangedEvent,
  CreateJoinRequestResponseSchema,
  decodeServerMessage,
  type JoinRequestId,
  JoinRequestListResponseSchema,
  type MemberId,
  type MemberRole,
  newId,
  type OwnJoinRequest,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  accessToken,
  deviceApp,
  failingCommits,
  type SignedInDevice,
  signInDevice,
} from "../auth/device-test-support.ts";
import { type Client, connected, settle } from "../gateway-test-support.ts";
import {
  type AuthenticatedConnectionContext,
  ConnectionRegistry,
} from "../gateway.ts";
import {
  type ApproverEvent,
  type ApproverEventHandler,
  deliverWorkspaceEvent,
  type WorkspaceEvent,
  type WorkspaceEventHandler,
} from "./events.ts";

// The join request events (#210, #227): a new request reaches the subscribed
// connections of the workspace's owner and admins as
// `workspace.join_request.created`, every way a pending request ends but an
// expiry as `workspace.join_request.resolved`, and a lifted block as
// `workspace.join_request.unblocked`. A member, the requester, and another
// workspace's connections never get them. The relay reads the owner and
// admins inside the transaction of each change, so a role change counts from
// the next change on.

let testDatabase: TestDatabase | undefined;

before(async () => {
  testDatabase = await createTestDatabase();
});

after(async () => {
  await testDatabase?.close();
});

function database(): Database {
  assert.ok(testDatabase, "the test database is created in before()");
  return testDatabase.db;
}

type Account = Readonly<{
  app: FastifyInstance;
  device: SignedInDevice;
  token: string;
}>;

type Delivered = Readonly<{
  event: ApproverEvent;
  approvers: readonly MemberId[];
}>;

/**
 * One API instance: each account signs in through its own app, and every app
 * shares one registry of connections and one database, whose next commit can
 * be made to fail. The join request events that went out are recorded with
 * the owner and admins they went to.
 */
async function instance(t: TestContext) {
  const connections = new ConnectionRegistry();
  const commits = failingCommits(database());
  const delivered: Delivered[] = [];
  const onApproverEvent: ApproverEventHandler = (event, approvers) => {
    delivered.push({ event, approvers });
  };
  const account = async (githubId: number): Promise<Account> => {
    const app = await deviceApp(t, {
      database: commits.database,
      githubId,
      connections,
      onApproverEvent,
    });
    // injectWS never settles unless the app is ready.
    await app.ready();
    const device = await signInDevice(app);
    return { app, device, token: await accessToken(app, device) };
  };
  return {
    connections,
    delivered,
    account,
    failNextCommit: commits.failNextCommit,
    failedCommits: commits.failedCommits,
  };
}

/** A workspace, written directly, with an owner and claimed people of the given roles. */
async function workspaceOf(
  owner: Account,
  people: readonly (readonly [Account, MemberRole])[] = [],
) {
  const workspaceId = newId<WorkspaceId>();
  await database().insert(workspaces).values({
    id: workspaceId,
    name: "Team",
    createdByUserId: owner.device.userId,
  });
  const person = async (userId: UserId, role: MemberRole) => {
    const id = newId<MemberId>();
    await database().insert(workspaceMembers).values({
      id,
      workspaceId,
      userId,
      displayName: "Someone",
      role,
      addedByUserId: owner.device.userId,
      claimedAt: new Date(),
    });
    return id;
  };
  const ownerId = await person(owner.device.userId, "owner");
  const memberIds: MemberId[] = [];
  for (const [account, role] of people) {
    memberIds.push(await person(account.device.userId, role));
  }
  return { workspaceId, ownerId, memberIds };
}

function post(account: Account, url: string, payload?: object) {
  return account.app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${account.token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Asks to join and expects the request. */
async function asked(
  account: Account,
  workspaceId: WorkspaceId,
): Promise<OwnJoinRequest> {
  const response = await post(account, "/join-requests", {
    workspaceId,
    displayName: "Guest",
  });
  assert.equal(response.statusCode, 200, response.body);
  return CreateJoinRequestResponseSchema.parse(response.json()).joinRequest;
}

/** The approvers' list of the workspace, as the owner or an admin reads it. */
async function approversList(account: Account, workspaceId: WorkspaceId) {
  const response = await account.app.inject({
    method: "GET",
    url: `/workspaces/${workspaceId}/join-requests`,
    headers: { authorization: `Bearer ${account.token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  return JoinRequestListResponseSchema.parse(response.json()).joinRequests;
}

/** A route of the approvers on one request, such as `deny`. */
function decide(
  account: Account,
  workspaceId: WorkspaceId,
  joinRequestId: JoinRequestId,
  action: "approve" | "deny" | "block" | "unblock",
) {
  return post(
    account,
    `/workspaces/${workspaceId}/join-requests/${joinRequestId}/${action}`,
    // An approval takes an optional display name in its body.
    action === "approve" ? {} : undefined,
  );
}

/** A route of the approvers on all requests of the workspace. */
function onAll(
  account: Account,
  workspaceId: WorkspaceId,
  action: "deny-all" | "pause" | "resume",
) {
  return post(account, `/workspaces/${workspaceId}/join-requests/${action}`);
}

/** How long a test waits for a message that the server sends at once. */
const MESSAGE_TIMEOUT_MS = 2_000;

/** The next message, which the device's decoder accepts, or a failure after `MESSAGE_TIMEOUT_MS`. */
async function nextMessage(client: Client) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no message within ${MESSAGE_TIMEOUT_MS} ms`));
    }, MESSAGE_TIMEOUT_MS);
  });
  try {
    const decoded = decodeServerMessage(
      await Promise.race([client.next(), timeout]),
    );
    assert.ok(decoded.ok, JSON.stringify(decoded));
    return decoded;
  } finally {
    clearTimeout(timer);
  }
}

async function nextEvent(client: Client) {
  const message = await nextMessage(client);
  assert.ok(message.kind === "event", JSON.stringify(message));
  return message.event;
}

/** Subscribes, skipping the presence frames of other subscribers. */
async function subscribed(client: Client, workspaceId: WorkspaceId) {
  client.send({ protocolVersion: 0, type: "workspace.subscribe", workspaceId });
  for (;;) {
    const message = await nextMessage(client);
    assert.ok(message.kind === "frame", JSON.stringify(message));
    if (message.frame.type === "workspace.subscribed") {
      assert.equal(message.frame.workspaceId, workspaceId);
      return;
    }
    assert.equal(message.frame.type, "presence.changed");
  }
}

/** Lets pending messages arrive, then returns the types of all unread ones. */
async function drained(client: Client): Promise<string[]> {
  await settle();
  const types: string[] = [];
  while (client.unread() > 0) {
    const message = await nextMessage(client);
    types.push(
      message.kind === "event" ? message.event.type : message.frame.type,
    );
  }
  return types;
}

/** Lets pending messages arrive, then checks that none is left unread. */
async function quiet(...clients: Client[]) {
  await settle();
  for (const client of clients) {
    assert.equal(client.unread(), 0);
  }
}

/** Reads the presence frames that the subscriptions caused. */
async function drainPresence(...clients: Client[]) {
  for (const client of clients) {
    for (const type of await drained(client)) {
      assert.equal(type, "presence.changed");
    }
  }
}

test("a new join request reaches every connection subscribed as the owner or an admin as workspace.join_request.created, and no member, requester, unsubscribed connection, or other workspace", async (t) => {
  const { account, delivered } = await instance(t);
  const ada = await account(3601);
  // The second devices sign in before any device connects.
  const adaPhone = await signInDevice(ada.app);
  const bob = await account(3602);
  const bobPhone = await signInDevice(bob.app);
  const cleo = await account(3603);
  const dan = await account(3604);
  const eve = await account(3605);
  const team = await workspaceOf(ada, [
    [bob, "admin"],
    [cleo, "member"],
  ]);
  const [bobInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined);
  // The requester owns another workspace, with Eve as its admin.
  const other = await workspaceOf(dan, [[eve, "admin"]]);

  const adaLaptop = (await connected(t, ada.app, ada.device)).client;
  const adaPhoneClient = (await connected(t, ada.app, adaPhone)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  const bobPhoneClient = (await connected(t, bob.app, bobPhone)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const danClient = (await connected(t, dan.app, dan.device)).client;
  const eveClient = (await connected(t, eve.app, eve.device)).client;
  const everyone = [
    adaLaptop,
    adaPhoneClient,
    bobClient,
    bobPhoneClient,
    cleoClient,
    danClient,
    eveClient,
  ];
  // Both of the owner's connections subscribe; the admin's phone does not.
  await subscribed(adaLaptop, team.workspaceId);
  await subscribed(adaPhoneClient, team.workspaceId);
  await subscribed(bobClient, team.workspaceId);
  await subscribed(cleoClient, team.workspaceId);
  await subscribed(danClient, other.workspaceId);
  await subscribed(eveClient, other.workspaceId);
  await drainPresence(...everyone);

  const joinRequest = await asked(dan, team.workspaceId);
  const [shown] = await approversList(ada, team.workspaceId);
  assert.ok(shown !== undefined);
  assert.equal(shown.id, joinRequest.id);
  assert.ok(shown.requester !== null);
  assert.equal(shown.requester.login, "user-3604");
  assert.equal(shown.requester.accountCreatedAt, "2015-06-01T10:00:00.000Z");
  for (const client of [adaLaptop, adaPhoneClient, bobClient]) {
    const event = await nextEvent(client);
    assert.ok(event.type === "workspace.join_request.created", event.type);
    assert.equal(event.workspaceId, team.workspaceId);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    assert.equal(event.occurredAt, joinRequest.createdAt);
    // What the approvers' list shows, and nothing more.
    assert.deepEqual(event.payload, { joinRequest: shown });
  }
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0]?.approvers, [team.ownerId, bobInTeam].sort());
  // The admin's phone did not subscribe, Cleo is a member, Dan asked, and
  // Eve is an admin of another workspace.
  await quiet(...everyone);

  // Asking again returns the pending request and sends nothing.
  assert.deepEqual(await asked(dan, team.workspaceId), joinRequest);
  await quiet(...everyone);
  assert.equal(delivered.length, 1);
});

test("approving, denying, blocking, withdrawing, and denying all reach the owner and admins as workspace.join_request.resolved, one event per request, and the requester only as its account frame", async (t) => {
  const { account, delivered } = await instance(t);
  const ada = await account(3611);
  const bob = await account(3612);
  const cleo = await account(3613);
  const guests = [
    await account(3614),
    await account(3615),
    await account(3616),
    await account(3617),
    await account(3618),
    await account(3619),
  ];
  const [gus, hal, ivy, jo, kim, lee] = guests;
  assert.ok(gus && hal && ivy && jo && kim && lee);
  const team = await workspaceOf(ada, [
    [bob, "admin"],
    [cleo, "member"],
  ]);
  // The requests come before anyone subscribes, so their created events
  // reach no connection.
  const requests = new Map<Account, OwnJoinRequest>();
  for (const guest of guests) {
    requests.set(guest, await asked(guest, team.workspaceId));
  }
  const requestOf = (guest: Account) => {
    const found = requests.get(guest);
    assert.ok(found !== undefined);
    return found.id;
  };
  assert.deepEqual(
    delivered.splice(0).map(({ event }) => event.type),
    guests.map(() => "workspace.join_request.created"),
  );

  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const guestClients = new Map<Account, Client>();
  for (const guest of guests) {
    guestClients.set(
      guest,
      (await connected(t, guest.app, guest.device)).client,
    );
  }
  const clientOf = (guest: Account) => {
    const client = guestClients.get(guest);
    assert.ok(client !== undefined);
    return client;
  };
  const everyone = [adaClient, bobClient, cleoClient, ...guestClients.values()];
  await subscribed(adaClient, team.workspaceId);
  await subscribed(bobClient, team.workspaceId);
  await subscribed(cleoClient, team.workspaceId);
  await drainPresence(...everyone);

  /** The resolved event that the owner and the admin each get next. */
  const expectResolved = async (
    joinRequestId: JoinRequestId,
    outcome: string,
  ) => {
    for (const client of [adaClient, bobClient]) {
      const event = await nextEvent(client);
      assert.ok(event.type === "workspace.join_request.resolved", event.type);
      assert.equal(event.workspaceId, team.workspaceId);
      assert.deepEqual(event.actor, { kind: "system" });
      assert.equal(event.deviceId, null);
      assert.deepEqual(event.payload, { joinRequestId, outcome });
    }
  };
  /** The account frame that the requester gets next. */
  const expectDecided = async (guest: Account, decision: string) => {
    const message = await nextMessage(clientOf(guest));
    assert.ok(
      message.kind === "frame" &&
        message.frame.type === "account.join_request_decided",
      JSON.stringify(message),
    );
    assert.equal(message.frame.joinRequestId, requestOf(guest));
    assert.equal(message.frame.decision, decision);
  };

  // An approval: everyone subscribed gets the new person, then the owner
  // and the admin get the outcome.
  const approved = await decide(
    bob,
    team.workspaceId,
    requestOf(gus),
    "approve",
  );
  assert.equal(approved.statusCode, 200, approved.body);
  for (const client of [adaClient, bobClient, cleoClient]) {
    assert.equal((await nextEvent(client)).type, "workspace.member.claimed");
  }
  await expectResolved(requestOf(gus), "approved");
  await expectDecided(gus, "approved");
  await quiet(...everyone);

  const denied = await decide(ada, team.workspaceId, requestOf(hal), "deny");
  assert.equal(denied.statusCode, 204, denied.body);
  await expectResolved(requestOf(hal), "denied");
  await expectDecided(hal, "denied");
  await quiet(...everyone);

  // The approvers see a block; the requester sees a denial.
  const blocked = await decide(bob, team.workspaceId, requestOf(ivy), "block");
  assert.equal(blocked.statusCode, 204, blocked.body);
  await expectResolved(requestOf(ivy), "blocked");
  await expectDecided(ivy, "denied");
  await quiet(...everyone);
  // The event's time is the decision's time that the list shows.
  const block = (await approversList(ada, team.workspaceId)).find(
    (shown) => shown.id === requestOf(ivy),
  );
  assert.equal(block?.decision, "blocked");
  assert.equal(block.decidedAt, delivered.at(-1)?.event.occurredAt);

  // A withdrawal tells the approvers and sends the requester nothing.
  const withdrawn = await post(jo, `/join-requests/${requestOf(jo)}/withdraw`);
  assert.equal(withdrawn.statusCode, 204, withdrawn.body);
  await expectResolved(requestOf(jo), "withdrawn");
  await quiet(...everyone);

  // Denying all: one event for each request, in the order of their IDs.
  const all = await onAll(ada, team.workspaceId, "deny-all");
  assert.equal(all.statusCode, 204, all.body);
  for (const guest of [kim, lee].sort((one, two) =>
    requestOf(one) < requestOf(two) ? -1 : 1,
  )) {
    await expectResolved(requestOf(guest), "denied");
  }
  await expectDecided(kim, "denied");
  await expectDecided(lee, "denied");
  await quiet(...everyone);

  // Nothing pending, a pause, and a resume send nothing. A lifted block has
  // its own event, tested below.
  for (const response of [
    await onAll(bob, team.workspaceId, "deny-all"),
    await onAll(ada, team.workspaceId, "pause"),
    await onAll(ada, team.workspaceId, "resume"),
  ]) {
    assert.equal(response.statusCode, 204, response.body);
  }
  await quiet(...everyone);

  assert.deepEqual(
    delivered.map(({ event }) =>
      event.type === "workspace.join_request.resolved"
        ? event.payload.outcome
        : event.type,
    ),
    ["approved", "denied", "blocked", "withdrawn", "denied", "denied"],
  );
  assert.equal(
    new Set(delivered.map(({ event }) => event.id)).size,
    delivered.length,
    "every event has its own ID",
  );
  for (const { approvers } of delivered) {
    assert.deepEqual(approvers, [team.ownerId, team.memberIds[0]].sort());
  }
});

test("the relay reads the owner and admins for each change: a demoted or removed admin gets the next join request event no more, and a new admin gets it at once", async (t) => {
  const { account, connections } = await instance(t);
  const ada = await account(3621);
  const bob = await account(3622);
  const cleo = await account(3623);
  const dan = await account(3624);
  const guests = [
    await account(3625),
    await account(3626),
    await account(3627),
  ];
  const team = await workspaceOf(ada, [
    [bob, "admin"],
    [cleo, "admin"],
    [dan, "member"],
  ]);
  const [bobInTeam, cleoInTeam, danInTeam] = team.memberIds;
  assert.ok(bobInTeam && cleoInTeam && danInTeam);

  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const danClient = (await connected(t, dan.app, dan.device)).client;
  const named = [
    ["ada", adaClient],
    ["bob", bobClient],
    ["cleo", cleoClient],
    ["dan", danClient],
  ] as const;
  const everyone = named.map(([, client]) => client);
  for (const client of everyone) {
    await subscribed(client, team.workspaceId);
  }
  await drainPresence(...everyone);

  /** Who of the subscribed people gets the created event of a new request. */
  const createdReaches = async (guest: Account | undefined) => {
    assert.ok(guest !== undefined);
    await asked(guest, team.workspaceId);
    const reached: string[] = [];
    for (const [name, client] of named) {
      const types = await drained(client);
      if (types.includes("workspace.join_request.created")) {
        assert.deepEqual(types, ["workspace.join_request.created"], name);
        reached.push(name);
      } else {
        assert.deepEqual(types, [], name);
      }
    }
    return reached;
  };

  assert.deepEqual(await createdReaches(guests[0]), ["ada", "bob", "cleo"]);

  // The owner demotes Bob, who stays subscribed as a member.
  const demoted = await post(
    ada,
    `/workspaces/${team.workspaceId}/members/${bobInTeam}/demote`,
  );
  assert.equal(demoted.statusCode, 204, demoted.body);
  for (const client of everyone) {
    assert.deepEqual(await drained(client), ["workspace.member.role_changed"]);
  }
  assert.ok(
    connections
      .subscriptions()
      .some(({ context }) => context.identity.userId === bob.device.userId),
  );
  assert.deepEqual(await createdReaches(guests[1]), ["ada", "cleo"]);

  // The owner removes Cleo, whose subscription ends.
  const removed = await post(
    ada,
    `/workspaces/${team.workspaceId}/members/${cleoInTeam}/remove`,
  );
  assert.equal(removed.statusCode, 204, removed.body);
  for (const client of everyone) {
    const types = await drained(client);
    assert.ok(
      types.every((type) => !type.startsWith("workspace.join_request.")),
      JSON.stringify(types),
    );
  }
  // Dan becomes an admin without an event: the relay reads the role anyway.
  await database()
    .update(workspaceMembers)
    .set({ role: "admin" })
    .where(eq(workspaceMembers.id, danInTeam));
  assert.deepEqual(await createdReaches(guests[2]), ["ada", "dan"]);

  // A decision goes to the same people.
  const [oldest] = (await approversList(ada, team.workspaceId)).slice(-1);
  assert.ok(oldest !== undefined);
  const denied = await decide(ada, team.workspaceId, oldest.id, "deny");
  assert.equal(denied.statusCode, 204, denied.body);
  for (const client of [adaClient, danClient]) {
    const event = await nextEvent(client);
    assert.ok(event.type === "workspace.join_request.resolved", event.type);
    assert.deepEqual(event.payload, {
      joinRequestId: oldest.id,
      outcome: "denied",
    });
  }
  await quiet(...everyone);
});

test("a refused or rolled-back change sends no join request event, and the same change sends one once it commits", async (t) => {
  const { account, delivered, failNextCommit, failedCommits } =
    await instance(t);
  const ada = await account(3631);
  const cleo = await account(3632);
  const gus = await account(3633);
  const hal = await account(3634);
  const team = await workspaceOf(ada, [[cleo, "member"]]);
  const pending = await asked(gus, team.workspaceId);
  // Its created event went out before anyone subscribed.
  assert.equal(delivered.splice(0).length, 1);

  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const gusClient = (await connected(t, gus.app, gus.device)).client;
  const halClient = (await connected(t, hal.app, hal.device)).client;
  const everyone = [adaClient, cleoClient, gusClient, halClient];
  await subscribed(adaClient, team.workspaceId);
  await subscribed(cleoClient, team.workspaceId);
  await drainPresence(...everyone);
  const before = await approversList(ada, team.workspaceId);
  const people = async () =>
    database()
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, team.workspaceId));
  const peopleBefore = await people();

  // Refused: a member decides, another account withdraws, an unknown
  // request, and a request while requests are paused.
  for (const [response, status] of [
    [await decide(cleo, team.workspaceId, pending.id, "approve"), 403],
    [await decide(cleo, team.workspaceId, pending.id, "deny"), 403],
    [await decide(cleo, team.workspaceId, pending.id, "block"), 403],
    [await onAll(cleo, team.workspaceId, "deny-all"), 403],
    [await post(hal, `/join-requests/${pending.id}/withdraw`), 404],
    [await decide(ada, team.workspaceId, newId<JoinRequestId>(), "deny"), 404],
  ] as const) {
    assert.equal(response.statusCode, status, response.body);
  }
  assert.equal((await onAll(ada, team.workspaceId, "pause")).statusCode, 204);
  const closed = await post(hal, "/join-requests", {
    workspaceId: team.workspaceId,
    displayName: "Hal",
  });
  assert.equal(closed.statusCode, 403, closed.body);
  assert.equal((await onAll(ada, team.workspaceId, "resume")).statusCode, 204);
  await quiet(...everyone);

  // Rolled back: each change ran to its end, and its commit failed.
  const rolledBack = [
    () => decide(ada, team.workspaceId, pending.id, "approve"),
    () => decide(ada, team.workspaceId, pending.id, "deny"),
    () => decide(ada, team.workspaceId, pending.id, "block"),
    () => onAll(ada, team.workspaceId, "deny-all"),
    () => post(gus, `/join-requests/${pending.id}/withdraw`),
    () =>
      post(hal, "/join-requests", {
        workspaceId: team.workspaceId,
        displayName: "Hal",
      }),
  ];
  for (const change of rolledBack) {
    failNextCommit();
    const response = await change();
    assert.equal(response.statusCode, 500, response.body);
  }
  // Each route's own transaction failed, not one that ran before it.
  assert.deepEqual(
    failedCommits(),
    Array(rolledBack.length).fill("join-request-routes.ts"),
  );
  assert.deepEqual(await approversList(ada, team.workspaceId), before);
  assert.deepEqual(await people(), peopleBefore);
  const halRequests = await database()
    .select()
    .from(workspaceJoinRequests)
    .where(eq(workspaceJoinRequests.requesterUserId, hal.device.userId));
  assert.deepEqual(halRequests, []);
  await quiet(...everyone);
  assert.deepEqual(delivered, []);

  // Committed, the same changes send their events.
  const denied = await decide(ada, team.workspaceId, pending.id, "deny");
  assert.equal(denied.statusCode, 204, denied.body);
  const resolved = await nextEvent(adaClient);
  assert.ok(resolved.type === "workspace.join_request.resolved");
  assert.deepEqual(resolved.payload, {
    joinRequestId: pending.id,
    outcome: "denied",
  });
  await asked(hal, team.workspaceId);
  assert.equal(
    (await nextEvent(adaClient)).type,
    "workspace.join_request.created",
  );
  assert.equal(
    (await nextMessage(gusClient)).kind === "frame",
    true,
    "the requester's decision",
  );
  await quiet(...everyone);
});

test("lifting a block reaches every connection subscribed as the owner or an admin as workspace.join_request.unblocked, and no member, blocked account, demoted admin, or other workspace; a refused or rolled-back unblock sends nothing", async (t) => {
  const { account, delivered, failNextCommit, failedCommits } =
    await instance(t);
  const ada = await account(3651);
  // The second devices sign in before any device connects.
  const adaPhone = await signInDevice(ada.app);
  const bob = await account(3652);
  const bobPhone = await signInDevice(bob.app);
  const cleo = await account(3653);
  const dan = await account(3654);
  const ivy = await account(3655);
  const jo = await account(3656);
  const kim = await account(3657);
  const eve = await account(3658);
  const team = await workspaceOf(ada, [
    [bob, "admin"],
    [cleo, "member"],
    [dan, "admin"],
  ]);
  const [bobInTeam, , danInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined && danInTeam !== undefined);
  // The blocked account owns another workspace, with Eve as its admin.
  const other = await workspaceOf(ivy, [[eve, "admin"]]);

  // Before anyone connects, Ivy and Jo are blocked, and Kim's request stays
  // pending.
  const ivyRequest = await asked(ivy, team.workspaceId);
  const joRequest = await asked(jo, team.workspaceId);
  const kimRequest = await asked(kim, team.workspaceId);
  for (const { id } of [ivyRequest, joRequest]) {
    const blocked = await decide(ada, team.workspaceId, id, "block");
    assert.equal(blocked.statusCode, 204, blocked.body);
  }
  delivered.splice(0);

  const adaLaptop = (await connected(t, ada.app, ada.device)).client;
  const adaPhoneClient = (await connected(t, ada.app, adaPhone)).client;
  const bobLaptop = (await connected(t, bob.app, bob.device)).client;
  const bobPhoneClient = (await connected(t, bob.app, bobPhone)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const danClient = (await connected(t, dan.app, dan.device)).client;
  const ivyClient = (await connected(t, ivy.app, ivy.device)).client;
  const eveClient = (await connected(t, eve.app, eve.device)).client;
  const inTeam = [
    adaLaptop,
    adaPhoneClient,
    bobLaptop,
    bobPhoneClient,
    cleoClient,
    danClient,
  ];
  const everyone = [...inTeam, ivyClient, eveClient];
  for (const client of inTeam) {
    await subscribed(client, team.workspaceId);
  }
  await subscribed(ivyClient, other.workspaceId);
  await subscribed(eveClient, other.workspaceId);
  await drainPresence(...everyone);

  /** The blocks in force that the approvers' list shows. */
  const blocksShown = async () =>
    (await approversList(ada, team.workspaceId))
      .filter((shown) => shown.decision === "blocked")
      .map((shown) => shown.id)
      .sort();
  const unblockedAt = async (joinRequestId: JoinRequestId) => {
    const [row] = await database()
      .select({ unblockedAt: workspaceJoinRequests.unblockedAt })
      .from(workspaceJoinRequests)
      .where(eq(workspaceJoinRequests.id, joinRequestId));
    assert.ok(row !== undefined);
    return row.unblockedAt;
  };
  /** The unblocked event that each of `clients` gets next. */
  const expectUnblocked = async (
    joinRequestId: JoinRequestId,
    clients: readonly Client[],
  ) => {
    const at = await unblockedAt(joinRequestId);
    assert.ok(at !== null);
    for (const client of clients) {
      const event = await nextEvent(client);
      assert.ok(event.type === "workspace.join_request.unblocked", event.type);
      assert.equal(event.workspaceId, team.workspaceId);
      assert.deepEqual(event.actor, { kind: "system" });
      assert.equal(event.deviceId, null);
      // The time that the server stored as `unblocked_at`.
      assert.equal(event.occurredAt, at.toISOString());
      assert.deepEqual(event.payload, { joinRequestId });
    }
  };
  const bothBlocks = [ivyRequest.id, joRequest.id].sort();
  assert.deepEqual(await blocksShown(), bothBlocks);

  // Refused: a member, a pending request, an unknown request, a non-member,
  // and the owner of another workspace, which does not have the request.
  for (const [response, status] of [
    [await decide(cleo, team.workspaceId, ivyRequest.id, "unblock"), 403],
    [await decide(ada, team.workspaceId, kimRequest.id, "unblock"), 409],
    [
      await decide(ada, team.workspaceId, newId<JoinRequestId>(), "unblock"),
      404,
    ],
    [await decide(eve, team.workspaceId, ivyRequest.id, "unblock"), 404],
    [await decide(ivy, other.workspaceId, ivyRequest.id, "unblock"), 404],
  ] as const) {
    assert.equal(response.statusCode, status, response.body);
  }
  await quiet(...everyone);
  assert.equal(delivered.length, 0);

  // Rolled back: the unblock ran to its end, and its commit failed.
  failNextCommit();
  const rolledBack = await decide(
    bob,
    team.workspaceId,
    ivyRequest.id,
    "unblock",
  );
  assert.equal(rolledBack.statusCode, 500, rolledBack.body);
  assert.deepEqual(failedCommits(), ["join-request-routes.ts"]);
  assert.equal(await unblockedAt(ivyRequest.id), null);
  assert.deepEqual(await blocksShown(), bothBlocks);
  await quiet(...everyone);
  assert.equal(delivered.length, 0);

  // Committed: the admin lifts Ivy's block. Both connections of the owner
  // and of the admin, and the other admin, get it.
  const lifted = await decide(bob, team.workspaceId, ivyRequest.id, "unblock");
  assert.equal(lifted.statusCode, 204, lifted.body);
  await expectUnblocked(ivyRequest.id, [
    adaLaptop,
    adaPhoneClient,
    bobLaptop,
    bobPhoneClient,
    danClient,
  ]);
  // Cleo is a member, Ivy is the blocked account and is told nothing, and
  // Eve is an admin of another workspace.
  await quiet(...everyone);
  assert.equal(delivered.length, 1);
  assert.deepEqual(
    delivered[0]?.approvers,
    [team.ownerId, bobInTeam, danInTeam].sort(),
  );
  // The approvers' list no longer shows the block.
  assert.deepEqual(await blocksShown(), [joRequest.id]);
  // Lifting it again is refused and sends nothing.
  const again = await decide(ada, team.workspaceId, ivyRequest.id, "unblock");
  assert.equal(again.statusCode, 409, again.body);
  await quiet(...everyone);
  assert.equal(delivered.length, 1);

  // The owner demotes Dan, who stays subscribed as a member.
  const demoted = await post(
    ada,
    `/workspaces/${team.workspaceId}/members/${danInTeam}/demote`,
  );
  assert.equal(demoted.statusCode, 204, demoted.body);
  for (const client of inTeam) {
    assert.deepEqual(await drained(client), ["workspace.member.role_changed"]);
  }
  await quiet(...everyone);
  delivered.splice(0);
  const liftedAgain = await decide(
    ada,
    team.workspaceId,
    joRequest.id,
    "unblock",
  );
  assert.equal(liftedAgain.statusCode, 204, liftedAgain.body);
  await expectUnblocked(joRequest.id, [
    adaLaptop,
    adaPhoneClient,
    bobLaptop,
    bobPhoneClient,
  ]);
  await quiet(...everyone);
  assert.deepEqual(
    delivered.map(({ approvers }) => approvers),
    [[team.ownerId, bobInTeam].sort()],
  );
  assert.deepEqual(await blocksShown(), []);
});

const SERVER_ONLY = {
  skip:
    process.env["DATABASE_TEST_URL"] === undefined &&
    "needs DATABASE_TEST_URL; PGlite has a single session",
};

/** How many sessions of the test database wait for a lock. */
async function lockWaiters(): Promise<number> {
  assert.ok(testDatabase);
  const { rows } = await testDatabase.client.query<{ waiting: number }>(
    "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
  );
  return rows[0]?.waiting ?? 0;
}

test(
  "every change reads the owner and admins after it waited for its locks: a demotion that commits while a new request, a withdrawal, an approval, a denial, a block, an unblock, or denying all waits leaves the demoted admin out of its event",
  SERVER_ONLY,
  async (t) => {
    const url = testDatabase?.url;
    assert.ok(url, "the test database is on a server");
    const { account, delivered } = await instance(t);
    const ada = await account(3641);
    const bob = await account(3642);
    const gus = await account(3643);
    const ivy = await account(3644);
    const jo = await account(3645);
    const kim = await account(3646);
    const lee = await account(3647);
    const mei = await account(3648);
    const team = await workspaceOf(ada, [[bob, "admin"]]);
    const [bobInTeam] = team.memberIds;
    assert.ok(bobInTeam !== undefined);
    // The requests that the decisions need, before anyone subscribes.
    const ivyRequest = await asked(ivy, team.workspaceId);
    const joRequest = await asked(jo, team.workspaceId);
    const kimRequest = await asked(kim, team.workspaceId);
    const leeRequest = await asked(lee, team.workspaceId);
    // The block that the unblock lifts.
    const meiRequest = await asked(mei, team.workspaceId);
    const meiBlocked = await decide(
      ada,
      team.workspaceId,
      meiRequest.id,
      "block",
    );
    assert.equal(meiBlocked.statusCode, 204, meiBlocked.body);
    const adaClient = (await connected(t, ada.app, ada.device)).client;
    const bobClient = (await connected(t, bob.app, bob.device)).client;
    await subscribed(adaClient, team.workspaceId);
    await subscribed(bobClient, team.workspaceId);
    await drainPresence(adaClient, bobClient);

    const other = createDatabase(url, { max: 1 });
    t.after(() => other.close());

    /**
     * Runs `change` while a second session has demoted Bob and holds what
     * `hold` locks, so that the change waits inside its transaction until
     * the demotion commits.
     */
    const whileDemoting = async (
      hold: (tx: Database) => Promise<unknown>,
      change: () => Promise<{ statusCode: number; body: string }>,
    ) => {
      const holding = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const held = other.db.transaction(async (tx) => {
        await tx
          .update(workspaceMembers)
          .set({ role: "member" })
          .where(eq(workspaceMembers.id, bobInTeam));
        await hold(tx);
        holding.resolve();
        await release.promise;
      });
      try {
        await Promise.race([
          holding.promise,
          held.then(() => {
            throw new Error("the holding transaction ended early");
          }),
        ]);
        const running = change();
        const deadline = Date.now() + 5_000;
        while ((await lockWaiters()) < 1) {
          assert.ok(Date.now() < deadline, "the change never waited");
          await delay(10);
        }
        release.resolve();
        await held;
        return await running;
      } finally {
        release.resolve();
        await held.catch(() => undefined);
      }
    };

    const holdRequest = (id: JoinRequestId) => (tx: Database) =>
      tx
        .select({ id: workspaceJoinRequests.id })
        .from(workspaceJoinRequests)
        .where(eq(workspaceJoinRequests.id, id))
        .for("update");
    let gusRequest: JoinRequestId | undefined;
    const cases = [
      {
        name: "a new request waits for the workspace row",
        hold: (tx: Database) =>
          tx
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, team.workspaceId))
            .for("update"),
        change: async () => {
          const response = await post(gus, "/join-requests", {
            workspaceId: team.workspaceId,
            displayName: "Gus",
          });
          gusRequest = CreateJoinRequestResponseSchema.parse(response.json())
            .joinRequest.id;
          return response;
        },
        expected: "created",
      },
      {
        name: "a withdrawal waits for the request",
        hold: (tx: Database) => {
          assert.ok(gusRequest !== undefined);
          return holdRequest(gusRequest)(tx);
        },
        change: () => {
          assert.ok(gusRequest !== undefined);
          return post(gus, `/join-requests/${gusRequest}/withdraw`);
        },
        expected: "withdrawn",
      },
      {
        name: "an approval waits for the request",
        hold: holdRequest(ivyRequest.id),
        change: () => decide(ada, team.workspaceId, ivyRequest.id, "approve"),
        expected: "approved",
      },
      {
        name: "a denial waits for the request",
        hold: holdRequest(joRequest.id),
        change: () => decide(ada, team.workspaceId, joRequest.id, "deny"),
        expected: "denied",
      },
      {
        name: "a block waits for the request",
        hold: holdRequest(kimRequest.id),
        change: () => decide(ada, team.workspaceId, kimRequest.id, "block"),
        expected: "blocked",
      },
      {
        name: "an unblock waits for the request",
        hold: holdRequest(meiRequest.id),
        change: () => decide(ada, team.workspaceId, meiRequest.id, "unblock"),
        expected: "unblocked",
      },
      {
        name: "denying all waits for the pending request",
        hold: holdRequest(leeRequest.id),
        change: () => onAll(ada, team.workspaceId, "deny-all"),
        expected: "denied",
      },
    ];
    for (const { name, hold, change, expected } of cases) {
      await t.test(name, async () => {
        // Bob is an admin again before each change.
        await database()
          .update(workspaceMembers)
          .set({ role: "admin" })
          .where(eq(workspaceMembers.id, bobInTeam));
        delivered.splice(0);
        const response = await whileDemoting(hold, change);
        assert.ok(
          response.statusCode === 200 || response.statusCode === 204,
          response.body,
        );
        assert.deepEqual(
          delivered.map(({ event, approvers }) => [
            event.type === "workspace.join_request.resolved"
              ? event.payload.outcome
              : event.type.slice("workspace.join_request.".length),
            approvers,
          ]),
          [[expected, [team.ownerId]]],
        );
        const joinRequestEvents = (types: string[]) =>
          types.filter((type) => type.startsWith("workspace.join_request."));
        assert.equal(joinRequestEvents(await drained(adaClient)).length, 1);
        assert.deepEqual(joinRequestEvents(await drained(bobClient)), []);
      });
    }
  },
);

test("the type checker refuses a join request event where an event for every member is meant", () => {
  const typeOnly = (
    handler: WorkspaceEventHandler,
    approverHandler: ApproverEventHandler,
    created: Extract<ApproverEvent, { type: "workspace.join_request.created" }>,
    resolved: Extract<
      ApproverEvent,
      { type: "workspace.join_request.resolved" }
    >,
    unblocked: Extract<
      ApproverEvent,
      { type: "workspace.join_request.unblocked" }
    >,
    removed: Extract<WorkspaceEvent, { type: "workspace.member.removed" }>,
    run: AgentRunStateChangedEvent,
    registry: ConnectionRegistry,
    context: AuthenticatedConnectionContext,
    log: FastifyBaseLogger,
  ) => {
    // @ts-expect-error -- sendToWorkspace sends to every subscriber
    registry.sendToWorkspace(created);
    // @ts-expect-error -- sendEvent ignores the person's role
    registry.sendEvent(context, resolved);
    // @ts-expect-error -- sendToWorkspace sends to every subscriber
    registry.sendToWorkspace(unblocked);
    // @ts-expect-error -- sendEvent ignores the person's role
    registry.sendEvent(context, unblocked);
    registry.sendToPeople(created, []);
    registry.sendToPeople(unblocked, []);
    registry.sendToWorkspace(removed);
    registry.sendEvent(context, run);
    // @ts-expect-error -- a join request event goes to the owner and admins only
    void handler(created);
    // @ts-expect-error -- a join request event goes to the owner and admins only
    void handler(resolved);
    // @ts-expect-error -- a join request event goes to the owner and admins only
    void handler(unblocked);
    // @ts-expect-error -- deliverWorkspaceEvent sends to every subscriber
    deliverWorkspaceEvent(registry, resolved, log);
    // @ts-expect-error -- deliverWorkspaceEvent sends to every subscriber
    deliverWorkspaceEvent(registry, unblocked, log);
    // @ts-expect-error -- a membership event is not a join request event
    void approverHandler(removed, []);
    // @ts-expect-error -- a run event is not a join request event
    void approverHandler(run, []);
    void approverHandler(created, []);
    void approverHandler(resolved, []);
    void approverHandler(unblocked, []);
    void handler(removed);
  };
  assert.equal(typeof typeOnly, "function");
});
