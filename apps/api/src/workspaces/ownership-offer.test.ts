import {
  auditEvents,
  DEVICE_TOO_NEW_MS,
  devices,
  OWNERSHIP_OFFER_LIFETIME_MS,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  decodeEvent,
  decodeServerMessage,
  type MemberId,
  type MemberRole,
  newId,
  type ServerEvent,
  type ServerFrame,
  type UserId,
  type WorkspaceId,
  WorkspaceViewResponseSchema,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  accessToken,
  deviceApp,
  failingCommits,
  fakeClock,
  type FakeClock,
  type SignedInDevice,
  signInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";
import {
  type Client,
  connected,
  nextFrame,
  settle,
} from "../gateway-test-support.ts";
import { ConnectionRegistry } from "../gateway.ts";
import type { WorkspaceEvent } from "./events.ts";

// Ownership offers (ADR 0014, "People and roles" and "Removal and
// ownership"; #93): only the owner offers, from a device older than 72
// hours, to an active, claimed person; the target accepts within 7 days, or
// the owner withdraws. The target's account and the owner's account (#241)
// get `account.ownership_offered` and `account.ownership_offer_ended`, and no
// other member is told; a transfer reaches the workspace's subscribers as
// `workspace.ownership.transferred` and both accounts, the previous and the
// new owner's, as `account.ownership_transferred`. Every message is decoded
// with the desktop's decoder.

const database = useTestDatabase();

const SECOND_MS = 1_000;

type Account = Readonly<{
  app: FastifyInstance;
  device: SignedInDevice;
  token: string;
}>;

/**
 * One API instance on a fake clock: each account signs in through its own
 * app, and every app shares the clock, one registry of connections, one
 * database, whose next commit can be made to fail, and the list of
 * membership events that went out.
 */
async function instance(t: TestContext) {
  const clock = fakeClock();
  const connections = new ConnectionRegistry();
  const commits = failingCommits(database());
  const events: WorkspaceEvent[] = [];
  const account = async (githubId: number): Promise<Account> => {
    const app = await deviceApp(t, {
      database: commits.database,
      githubId,
      connections,
      now: clock.now,
      onWorkspaceEvent: (event) => {
        events.push(event);
      },
    });
    // injectWS never settles unless the app is ready.
    await app.ready();
    const device = await signInDevice(app);
    return { app, device, token: await accessToken(app, device) };
  };
  return {
    clock,
    connections,
    events,
    account,
    failNextCommit: commits.failNextCommit,
    failedCommits: commits.failedCommits,
  };
}

/** The account with a fresh access token, which lives 15 minutes. */
async function refreshed(account: Account): Promise<Account> {
  return { ...account, token: await accessToken(account.app, account.device) };
}

/** Moves the device's registration back, so that it is older than 72 hours. */
async function established(clock: FakeClock, device: SignedInDevice) {
  await database()
    .update(devices)
    .set({ createdAt: new Date(clock.now() - DEVICE_TOO_NEW_MS - 60_000) })
    .where(eq(devices.id, device.deviceId));
}

/** A workspace, written directly, with an owner and claimed people of the given roles. */
async function workspaceOf(
  owner: SignedInDevice,
  people: readonly (readonly [SignedInDevice, MemberRole])[] = [],
) {
  const workspaceId = newId<WorkspaceId>();
  await database()
    .insert(workspaces)
    .values({ id: workspaceId, name: "Team", createdByUserId: owner.userId });
  const person = async (userId: UserId, role: MemberRole) => {
    const id = newId<MemberId>();
    await database().insert(workspaceMembers).values({
      id,
      workspaceId,
      userId,
      displayName: "Someone",
      role,
      addedByUserId: owner.userId,
      claimedAt: new Date(),
    });
    return id;
  };
  const ownerId = await person(owner.userId, "owner");
  const memberIds: MemberId[] = [];
  for (const [device, role] of people) {
    memberIds.push(await person(device.userId, role));
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

function offer(account: Account, workspaceId: WorkspaceId, memberId: string) {
  return post(account, `/workspaces/${workspaceId}/ownership-offer`, {
    memberId,
  });
}

function accept(account: Account, workspaceId: WorkspaceId) {
  return post(account, `/workspaces/${workspaceId}/ownership-offer/accept`);
}

function withdraw(account: Account, workspaceId: WorkspaceId) {
  return post(account, `/workspaces/${workspaceId}/ownership-offer/withdraw`);
}

async function view(account: Account, workspaceId: WorkspaceId) {
  const response = await account.app.inject({
    method: "GET",
    url: `/workspaces/${workspaceId}`,
    headers: { authorization: `Bearer ${account.token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  return WorkspaceViewResponseSchema.parse(response.json());
}

/** The role of each person in the workspace view. */
async function roles(account: Account, workspaceId: WorkspaceId) {
  return new Map(
    (await view(account, workspaceId)).members.map((person) => [
      person.id,
      person.role,
    ]),
  );
}

/** The audit records of the workspace, in order. */
async function auditOf(workspaceId: WorkspaceId) {
  return database()
    .select({
      action: auditEvents.action,
      actorUserId: auditEvents.actorUserId,
      actorDeviceId: auditEvents.actorDeviceId,
      subjectId: auditEvents.subjectId,
    })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(auditEvents.id);
}

function errorCode(response: { json(): unknown }): unknown {
  return (response.json() as { code?: unknown }).code;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Subscribes and checks the answer. */
async function subscribe(client: Client, workspaceId: WorkspaceId) {
  client.send({ protocolVersion: 0, type: "workspace.subscribe", workspaceId });
  const frame = await nextFrame(client);
  assert.ok(
    frame.type === "workspace.subscribed" && frame.workspaceId === workspaceId,
    JSON.stringify(frame),
  );
}

/** Reads the presence frames that subscriptions caused, and checks that nothing else is left. */
async function drainPresence(...clients: Client[]) {
  await settle();
  for (const client of clients) {
    while (client.unread() > 0) {
      assert.equal((await nextFrame(client)).type, "presence.changed");
    }
  }
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

function offered(
  workspaceId: WorkspaceId,
  memberId: MemberId,
  offeredAt: number,
): ServerFrame {
  return {
    protocolVersion: 0,
    type: "account.ownership_offered",
    workspaceId,
    offer: {
      memberId,
      offeredAt: iso(offeredAt),
      expiresAt: iso(offeredAt + OWNERSHIP_OFFER_LIFETIME_MS),
    },
  };
}

function offerEnded(
  workspaceId: WorkspaceId,
  reason: "withdrawn" | "expired",
  endedAt: number,
): ServerFrame {
  return {
    protocolVersion: 0,
    type: "account.ownership_offer_ended",
    workspaceId,
    reason,
    endedAt: iso(endedAt),
  };
}

function ownershipTransferred(
  workspaceId: WorkspaceId,
  previousOwnerMemberId: MemberId,
  ownerMemberId: MemberId,
  transferredAt: number,
): ServerFrame {
  return {
    protocolVersion: 0,
    type: "account.ownership_transferred",
    workspaceId,
    previousOwnerMemberId,
    ownerMemberId,
    transferredAt: iso(transferredAt),
  };
}

test("the owner offers ownership with 204; every connection of the target's and the owner's accounts gets account.ownership_offered, no other member's, and the view shows the offer", async (t) => {
  const { clock, events, account } = await instance(t);
  const ada = await account(3601);
  const adasDesktop = await signInDevice(ada.app);
  const bob = await account(3602);
  const bobsDesktop = await signInDevice(bob.app);
  const cleo = await account(3603);
  const dan = await account(3604);
  const eve = await account(3605);
  await established(clock, ada.device);
  const team = await workspaceOf(ada.device, [
    [bob.device, "member"],
    [cleo.device, "admin"],
    [eve.device, "member"],
  ]);
  const [bobInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined);
  // Dan owns another workspace, which Bob shares, where nothing changes.
  await workspaceOf(dan.device, [[bob.device, "member"]]);

  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const adasDesktopClient = (await connected(t, ada.app, adasDesktop)).client;
  const laptop = (await connected(t, bob.app, bob.device)).client;
  const desktop = (await connected(t, bob.app, bobsDesktop)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const eveClient = (await connected(t, eve.app, eve.device)).client;
  const danClient = (await connected(t, dan.app, dan.device)).client;
  const all = [
    adaClient,
    adasDesktopClient,
    laptop,
    desktop,
    cleoClient,
    eveClient,
    danClient,
  ];
  await subscribe(adaClient, team.workspaceId);
  await subscribe(laptop, team.workspaceId);
  await subscribe(cleoClient, team.workspaceId);
  await subscribe(eveClient, team.workspaceId);
  await drainPresence(adaClient, laptop, cleoClient, eveClient);

  const start = clock.now();
  const response = await offer(ada, team.workspaceId, bobInTeam);
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(response.body, "");

  // Both of Bob's connections and both of Ada's (#241), also the ones that
  // subscribed to nothing, among them Ada's other device. The admin, the
  // other member, and the other workspace's owner get nothing.
  const frame = offered(team.workspaceId, bobInTeam, start);
  for (const client of [laptop, desktop, adaClient, adasDesktopClient]) {
    assert.deepEqual(await nextFrame(client), frame);
  }
  await quiet(...all);
  assert.deepEqual(events, [], "an offer is no membership event");

  assert.equal(frame.type, "account.ownership_offered");
  assert.deepEqual(
    (await view(cleo, team.workspaceId)).ownershipOffer,
    frame.offer,
  );
  assert.deepEqual(await auditOf(team.workspaceId), [
    {
      action: "ownership.offered",
      actorUserId: ada.device.userId,
      actorDeviceId: ada.device.deviceId,
      subjectId: bobInTeam,
    },
  ]);
  // An offer changes no role.
  assert.equal((await roles(bob, team.workspaceId)).get(bobInTeam), "member");
});

test("only the owner offers, never to themselves, to an active, claimed person, from a device older than 72 hours, and once; a refusal changes nothing and sends nothing", async (t) => {
  const { clock, events, account } = await instance(t);
  const ada = await account(3611);
  const bob = await account(3612);
  const cleo = await account(3613);
  const former = await account(3614);
  const outsider = await account(3615);
  for (const each of [bob, cleo, former, outsider]) {
    await established(clock, each.device);
  }
  const team = await workspaceOf(ada.device, [
    [bob.device, "member"],
    [cleo.device, "admin"],
    [former.device, "member"],
  ]);
  const [bobInTeam, cleoInTeam, formerInTeam] = team.memberIds;
  assert.ok(
    bobInTeam !== undefined &&
      cleoInTeam !== undefined &&
      formerInTeam !== undefined,
  );
  await database()
    .update(workspaceMembers)
    .set({ removedAt: new Date(), removedByUserId: ada.device.userId })
    .where(eq(workspaceMembers.id, formerInTeam));
  const defined = await post(ada, `/workspaces/${team.workspaceId}/members`, {
    displayName: "Linus",
  });
  assert.equal(defined.statusCode, 200, defined.body);
  const unclaimed = (defined.json() as { member: { id: MemberId } }).member.id;
  const clients = [
    (await connected(t, ada.app, ada.device)).client,
    (await connected(t, bob.app, bob.device)).client,
    (await connected(t, cleo.app, cleo.device)).client,
  ];
  events.length = 0;

  // Ada's device is younger than 72 hours: refused before the person's state.
  const young = await offer(ada, team.workspaceId, bobInTeam);
  assert.equal(young.statusCode, 403, young.body);
  assert.deepEqual(young.json(), {
    statusCode: 403,
    error: "Forbidden",
    message: "Forbidden",
    code: "device_too_new",
  });
  const youngUnclaimed = await offer(ada, team.workspaceId, unclaimed);
  assert.equal(errorCode(youngUnclaimed), "device_too_new");

  await established(clock, ada.device);
  const { workspaceId } = team;
  for (const [label, response, status, code] of [
    [
      "an admin offers",
      await offer(cleo, workspaceId, bobInTeam),
      403,
      "forbidden",
    ],
    [
      "a member offers to themselves",
      await offer(bob, workspaceId, bobInTeam),
      403,
      "forbidden",
    ],
    [
      "the owner offers to themselves",
      await offer(ada, workspaceId, team.ownerId),
      403,
      "forbidden",
    ],
    [
      "the owner offers to an unclaimed person",
      await offer(ada, workspaceId, unclaimed),
      409,
      "conflict",
    ],
    [
      "the owner offers to a former member",
      await offer(ada, workspaceId, formerInTeam),
      409,
      "conflict",
    ],
    [
      "the owner offers to an unknown person",
      await offer(ada, workspaceId, newId<MemberId>()),
      404,
      "not_found",
    ],
    [
      "the owner offers to a malformed ID",
      await offer(ada, workspaceId, "not-an-id"),
      400,
      "bad_request",
    ],
    [
      "the owner offers without a person",
      await post(ada, `/workspaces/${workspaceId}/ownership-offer`, {}),
      400,
      "bad_request",
    ],
    [
      "a former member offers",
      await offer(former, workspaceId, bobInTeam),
      404,
      "not_found",
    ],
    [
      "an outsider offers",
      await offer(outsider, workspaceId, bobInTeam),
      404,
      "not_found",
    ],
  ] as const) {
    assert.equal(response.statusCode, status, `${label}: ${response.body}`);
    assert.equal(errorCode(response), code, label);
  }
  assert.equal((await view(ada, workspaceId)).ownershipOffer, null);
  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => record.action),
    ["member.defined"],
  );
  await quiet(...clients);

  // One live offer per workspace: a second one, to anyone, is a conflict.
  const first = await offer(ada, workspaceId, bobInTeam);
  assert.equal(first.statusCode, 204, first.body);
  const [adaClient, bobClient] = clients;
  assert.ok(adaClient !== undefined && bobClient !== undefined);
  assert.equal((await nextFrame(bobClient)).type, "account.ownership_offered");
  assert.equal((await nextFrame(adaClient)).type, "account.ownership_offered");
  for (const memberId of [bobInTeam, cleoInTeam]) {
    const second = await offer(ada, workspaceId, memberId);
    assert.equal(second.statusCode, 409, second.body);
    assert.equal(errorCode(second), "conflict");
  }
  assert.equal(
    (await view(ada, workspaceId)).ownershipOffer?.memberId,
    bobInTeam,
  );
  await quiet(...clients);
  await settle();
  assert.deepEqual(events, [], "a refusal sends no event");
});

test("the target accepts with 204: the owner becomes an admin and the target the owner, the workspace's subscribers get workspace.ownership.transferred from the system, and then every connection of both accounts gets account.ownership_transferred", async (t) => {
  const { clock, connections, events, account } = await instance(t);
  const ada = await account(3621);
  const adasDesktop = await signInDevice(ada.app);
  const bob = await account(3622);
  const bobsDesktop = await signInDevice(bob.app);
  const cleo = await account(3623);
  const dan = await account(3624);
  await established(clock, ada.device);
  const team = await workspaceOf(ada.device, [
    [bob.device, "admin"],
    [cleo.device, "member"],
  ]);
  const [bobInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined);
  const other = await workspaceOf(dan.device, [[bob.device, "member"]]);

  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const adasDesktopClient = (await connected(t, ada.app, adasDesktop)).client;
  const laptop = (await connected(t, bob.app, bob.device)).client;
  const desktop = (await connected(t, bob.app, bobsDesktop)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const danClient = (await connected(t, dan.app, dan.device)).client;
  const all = [
    adaClient,
    adasDesktopClient,
    laptop,
    desktop,
    cleoClient,
    danClient,
  ];
  await subscribe(danClient, other.workspaceId);
  await subscribe(laptop, other.workspaceId);
  await subscribe(adaClient, team.workspaceId);
  await subscribe(laptop, team.workspaceId);
  await subscribe(cleoClient, team.workspaceId);
  await drainPresence(adaClient, laptop, cleoClient, danClient);

  const offeredResponse = await offer(ada, team.workspaceId, bobInTeam);
  assert.equal(offeredResponse.statusCode, 204, offeredResponse.body);
  for (const client of [laptop, desktop, adaClient, adasDesktopClient]) {
    assert.equal((await nextFrame(client)).type, "account.ownership_offered");
  }
  await quiet(...all);

  // From Bob's desktop, a device that is not 72 hours old: an acceptance
  // needs no device age.
  clock.advance(SECOND_MS);
  const acceptedAt = clock.now();
  const fromDesktop = {
    ...bob,
    device: bobsDesktop,
    token: await accessToken(bob.app, bobsDesktop),
  };
  const response = await accept(fromDesktop, team.workspaceId);
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(response.body, "");

  for (const client of [adaClient, laptop, cleoClient]) {
    const event = await nextEvent(client);
    assert.ok(event.type === "workspace.ownership.transferred", event.type);
    assert.equal(event.workspaceId, team.workspaceId);
    assert.equal(event.occurredAt, iso(acceptedAt));
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    assert.deepEqual(event.payload, {
      previousOwnerMemberId: team.ownerId,
      ownerMemberId: bobInTeam,
    });
  }
  // After the event, every connection of the previous and the new owner's
  // accounts, also the desktops that subscribed to nothing.
  const frame = ownershipTransferred(
    team.workspaceId,
    team.ownerId,
    bobInTeam,
    acceptedAt,
  );
  for (const client of [adaClient, adasDesktopClient, laptop, desktop]) {
    assert.deepEqual(await nextFrame(client), frame);
  }
  // No offer frame after a transfer, to either account, and nothing for
  // Cleo's or Dan's account.
  await quiet(...all);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.ok(event !== undefined);
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.payload));
  assert.deepEqual(decodeEvent(JSON.parse(JSON.stringify(event))), {
    ok: true,
    event,
  });

  const after = await view(cleo, team.workspaceId);
  assert.equal(after.ownershipOffer, null);
  const roleOf = new Map(after.members.map((each) => [each.id, each.role]));
  assert.equal(roleOf.get(team.ownerId), "admin");
  assert.equal(roleOf.get(bobInTeam), "owner");
  assert.deepEqual(
    (await auditOf(team.workspaceId)).map((record) => [
      record.action,
      record.actorUserId,
      record.actorDeviceId,
      record.subjectId,
    ]),
    [
      ["ownership.offered", ada.device.userId, ada.device.deviceId, bobInTeam],
      [
        "ownership.transferred",
        bob.device.userId,
        bobsDesktop.deviceId,
        bobInTeam,
      ],
    ],
  );
  // A transfer ends no subscription.
  assert.equal(connections.subscriptions().length, 5);

  // The former owner is an admin now: it cannot remove the new owner, and
  // the new owner cannot leave.
  const removal = await post(
    ada,
    `/workspaces/${team.workspaceId}/members/${bobInTeam}/remove`,
  );
  assert.equal(removal.statusCode, 403, removal.body);
  const leave = await post(bob, `/workspaces/${team.workspaceId}/leave`);
  assert.equal(leave.statusCode, 403, leave.body);
  const offerBack = await offer(ada, team.workspaceId, team.ownerId);
  assert.equal(errorCode(offerBack), "forbidden");
  await quiet(...all);
});

test("only the target accepts a live offer, and nobody accepts a withdrawn one; a refusal sends nothing", async (t) => {
  const { clock, events, account } = await instance(t);
  const ada = await account(3631);
  const bob = await account(3632);
  const cleo = await account(3633);
  const outsider = await account(3634);
  await established(clock, ada.device);
  const team = await workspaceOf(ada.device, [
    [bob.device, "member"],
    [cleo.device, "admin"],
  ]);
  const [bobInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined);
  const clients = [
    (await connected(t, ada.app, ada.device)).client,
    (await connected(t, bob.app, bob.device)).client,
    (await connected(t, cleo.app, cleo.device)).client,
  ];
  const { workspaceId } = team;

  const none = await accept(bob, workspaceId);
  assert.equal(none.statusCode, 409, none.body);
  assert.equal(errorCode(none), "conflict");

  assert.equal((await offer(ada, workspaceId, bobInTeam)).statusCode, 204);
  const [adaClient, bobClient] = clients;
  assert.ok(adaClient !== undefined && bobClient !== undefined);
  for (const client of [bobClient, adaClient]) {
    assert.equal((await nextFrame(client)).type, "account.ownership_offered");
  }
  for (const [label, response, status, code] of [
    ["the owner accepts", await accept(ada, workspaceId), 403, "forbidden"],
    [
      "an admin who is not the target accepts",
      await accept(cleo, workspaceId),
      403,
      "forbidden",
    ],
    [
      "an outsider accepts",
      await accept(outsider, workspaceId),
      404,
      "not_found",
    ],
  ] as const) {
    assert.equal(response.statusCode, status, `${label}: ${response.body}`);
    assert.equal(errorCode(response), code, label);
  }
  await quiet(...clients);

  const withdrawn = await withdraw(ada, workspaceId);
  assert.equal(withdrawn.statusCode, 204, withdrawn.body);
  for (const client of [bobClient, adaClient]) {
    assert.equal(
      (await nextFrame(client)).type,
      "account.ownership_offer_ended",
    );
  }
  const late = await accept(bob, workspaceId);
  assert.equal(late.statusCode, 409, late.body);
  assert.equal(errorCode(late), "conflict");
  const roleOf = await roles(ada, workspaceId);
  assert.equal(roleOf.get(team.ownerId), "owner");
  assert.equal(roleOf.get(bobInTeam), "member");
  await quiet(...clients);
  assert.deepEqual(events, []);
});

test("the owner withdraws with 204 from any device and every connection of the target's and the owner's accounts gets account.ownership_offer_ended with withdrawn, no other member's; anyone else is forbidden", async (t) => {
  const { clock, events, account } = await instance(t);
  const ada = await account(3641);
  const adasDesktop = await signInDevice(ada.app);
  const bob = await account(3642);
  const bobsDesktop = await signInDevice(bob.app);
  const cleo = await account(3643);
  const dan = await account(3644);
  await established(clock, ada.device);
  const team = await workspaceOf(ada.device, [
    [bob.device, "member"],
    [cleo.device, "admin"],
    [dan.device, "member"],
  ]);
  const [bobInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined);
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const adasDesktopClient = (await connected(t, ada.app, adasDesktop)).client;
  const laptop = (await connected(t, bob.app, bob.device)).client;
  const desktop = (await connected(t, bob.app, bobsDesktop)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const danClient = (await connected(t, dan.app, dan.device)).client;
  const all = [
    adaClient,
    adasDesktopClient,
    laptop,
    desktop,
    cleoClient,
    danClient,
  ];
  // Every connection of the target's account and of the owner's account.
  const told = [laptop, desktop, adaClient, adasDesktopClient];
  await subscribe(adaClient, team.workspaceId);
  await subscribe(cleoClient, team.workspaceId);
  await subscribe(danClient, team.workspaceId);
  await drainPresence(adaClient, cleoClient, danClient);
  const { workspaceId } = team;

  const none = await withdraw(ada, workspaceId);
  assert.equal(none.statusCode, 409, none.body);
  assert.equal(errorCode(none), "conflict");
  await quiet(...all);
  assert.equal((await offer(ada, workspaceId, bobInTeam)).statusCode, 204);
  for (const client of told) {
    assert.equal((await nextFrame(client)).type, "account.ownership_offered");
  }

  for (const [label, response] of [
    ["the target", await withdraw(bob, workspaceId)],
    ["an admin", await withdraw(cleo, workspaceId)],
    ["a member", await withdraw(dan, workspaceId)],
  ] as const) {
    assert.equal(response.statusCode, 403, `${label}: ${response.body}`);
    assert.equal(errorCode(response), "forbidden", label);
  }
  await quiet(...all);

  // Ada's desktop is not 72 hours old; a withdrawal needs no device age.
  clock.advance(SECOND_MS);
  const response = await withdraw(
    {
      ...ada,
      device: adasDesktop,
      token: await accessToken(ada.app, adasDesktop),
    },
    workspaceId,
  );
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(response.body, "");
  // Both of Bob's connections and both of Ada's (#241), the withdrawing
  // desktop, which subscribed to nothing, too. Cleo and Dan get nothing.
  const frame = offerEnded(workspaceId, "withdrawn", clock.now());
  for (const client of told) {
    assert.deepEqual(await nextFrame(client), frame);
  }
  await quiet(...all);
  assert.equal((await view(ada, workspaceId)).ownershipOffer, null);
  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => [
      record.action,
      record.actorDeviceId,
      record.subjectId,
    ]),
    [
      ["ownership.offered", ada.device.deviceId, bobInTeam],
      ["ownership.offer_withdrawn", adasDesktop.deviceId, bobInTeam],
    ],
  );

  const again = await withdraw(ada, workspaceId);
  assert.equal(again.statusCode, 409, again.body);
  await quiet(...all);
  assert.deepEqual(events, []);
});

test("an offer 7 days old is no offer: the view hides it, and the next offer, acceptance, or withdrawal clears it and tells its target and the owner with expired", async (t) => {
  const { clock, account } = await instance(t);
  let ada = await account(3651);
  let bob = await account(3652);
  let cleo = await account(3653);
  await established(clock, ada.device);
  const team = await workspaceOf(ada.device, [
    [bob.device, "member"],
    [cleo.device, "admin"],
  ]);
  const [bobInTeam, cleoInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined && cleoInTeam !== undefined);
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const all = [adaClient, bobClient, cleoClient];
  const { workspaceId } = team;

  // An offer to Bob; a second before its expiry the view still shows it.
  const first = clock.now();
  assert.equal((await offer(ada, workspaceId, bobInTeam)).statusCode, 204);
  for (const client of [bobClient, adaClient]) {
    assert.deepEqual(
      await nextFrame(client),
      offered(workspaceId, bobInTeam, first),
    );
  }
  clock.advance(OWNERSHIP_OFFER_LIFETIME_MS - SECOND_MS);
  ada = await refreshed(ada);
  bob = await refreshed(bob);
  assert.equal(
    (await view(bob, workspaceId)).ownershipOffer?.memberId,
    bobInTeam,
  );
  const early = await offer(ada, workspaceId, cleoInTeam);
  assert.equal(early.statusCode, 409, early.body);
  clock.advance(SECOND_MS);
  assert.equal((await view(bob, workspaceId)).ownershipOffer, null);
  await quiet(...all);

  // A new offer to Cleo replaces it: Bob learns that his offer expired, at
  // its expiry, before Cleo gets hers, and Ada learns both in this order.
  clock.advance(SECOND_MS);
  const second = clock.now();
  const replaced = await offer(ada, workspaceId, cleoInTeam);
  assert.equal(replaced.statusCode, 204, replaced.body);
  const firstEnded = offerEnded(
    workspaceId,
    "expired",
    first + OWNERSHIP_OFFER_LIFETIME_MS,
  );
  const toCleo = offered(workspaceId, cleoInTeam, second);
  assert.deepEqual(await nextFrame(bobClient), firstEnded);
  assert.deepEqual(await nextFrame(cleoClient), toCleo);
  assert.deepEqual(await nextFrame(adaClient), firstEnded);
  assert.deepEqual(await nextFrame(adaClient), toCleo);
  await quiet(...all);

  // Cleo's offer expires; the owner's withdrawal is a conflict that clears it.
  clock.advance(OWNERSHIP_OFFER_LIFETIME_MS);
  ada = await refreshed(ada);
  const withdrawn = await withdraw(ada, workspaceId);
  assert.equal(withdrawn.statusCode, 409, withdrawn.body);
  assert.equal(errorCode(withdrawn), "conflict");
  for (const client of [cleoClient, adaClient]) {
    assert.deepEqual(
      await nextFrame(client),
      offerEnded(workspaceId, "expired", second + OWNERSHIP_OFFER_LIFETIME_MS),
    );
  }
  await quiet(...all);

  // A new offer to Bob expires too; his acceptance is a conflict that clears it.
  const third = clock.now();
  assert.equal((await offer(ada, workspaceId, bobInTeam)).statusCode, 204);
  for (const client of [bobClient, adaClient]) {
    assert.deepEqual(
      await nextFrame(client),
      offered(workspaceId, bobInTeam, third),
    );
  }
  clock.advance(OWNERSHIP_OFFER_LIFETIME_MS);
  ada = await refreshed(ada);
  bob = await refreshed(bob);
  cleo = await refreshed(cleo);
  // Another person's acceptance clears nothing.
  const byCleo = await accept(cleo, workspaceId);
  assert.equal(byCleo.statusCode, 409, byCleo.body);
  await quiet(...all);
  const accepted = await accept(bob, workspaceId);
  assert.equal(accepted.statusCode, 409, accepted.body);
  assert.equal(errorCode(accepted), "conflict");
  // The target acted, and the owner's account is told as well.
  for (const client of [bobClient, adaClient]) {
    assert.deepEqual(
      await nextFrame(client),
      offerEnded(workspaceId, "expired", third + OWNERSHIP_OFFER_LIFETIME_MS),
    );
  }
  const repeated = await accept(bob, workspaceId);
  assert.equal(repeated.statusCode, 409, repeated.body);
  await quiet(...all);

  const roleOf = await roles(ada, workspaceId);
  assert.equal(roleOf.get(team.ownerId), "owner");
  assert.equal(roleOf.get(bobInTeam), "member");
  // Clearing an expired offer writes no audit record.
  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => [
      record.action,
      record.subjectId,
    ]),
    [
      ["ownership.offered", bobInTeam],
      ["ownership.offered", cleoInTeam],
      ["ownership.offered", bobInTeam],
    ],
  );
});

test("removing the target ends the offer with account.removed_from_workspace and no offer frame to either account", async (t) => {
  const { clock, account } = await instance(t);
  const ada = await account(3661);
  const bob = await account(3662);
  await established(clock, ada.device);
  const team = await workspaceOf(ada.device, [[bob.device, "member"]]);
  const [bobInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined);
  // Ada's connection subscribed to nothing, so it gets no membership event.
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  assert.equal((await offer(ada, team.workspaceId, bobInTeam)).statusCode, 204);
  for (const client of [bobClient, adaClient]) {
    assert.equal((await nextFrame(client)).type, "account.ownership_offered");
  }

  const removed = await post(
    ada,
    `/workspaces/${team.workspaceId}/members/${bobInTeam}/remove`,
  );
  assert.equal(removed.statusCode, 204, removed.body);
  assert.equal(
    (await nextFrame(bobClient)).type,
    "account.removed_from_workspace",
  );
  await quiet(adaClient, bobClient);
  assert.equal((await view(ada, team.workspaceId)).ownershipOffer, null);
  const withdrawn = await withdraw(ada, team.workspaceId);
  assert.equal(withdrawn.statusCode, 409, withdrawn.body);
  await quiet(adaClient, bobClient);
});

test("a refused or rolled-back offer action sends no offer frame, and the same action, once it commits, reaches every connection of the target's and the owner's accounts and no other member's", async (t) => {
  const { clock, events, account, failNextCommit, failedCommits } =
    await instance(t);
  const ada = await account(3671);
  const adasDesktop = await signInDevice(ada.app);
  let bob = await account(3672);
  const cleo = await account(3673);
  const dan = await account(3674);
  await established(clock, ada.device);
  const team = await workspaceOf(ada.device, [
    [bob.device, "member"],
    [cleo.device, "admin"],
    [dan.device, "member"],
  ]);
  const [bobInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined);
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const adasDesktopClient = (await connected(t, ada.app, adasDesktop)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const danClient = (await connected(t, dan.app, dan.device)).client;
  const all = [adaClient, adasDesktopClient, bobClient, cleoClient, danClient];
  // Every connection of the target's account and of the owner's account.
  const told = [bobClient, adaClient, adasDesktopClient];
  for (const client of [adaClient, bobClient, cleoClient, danClient]) {
    await subscribe(client, team.workspaceId);
  }
  await drainPresence(adaClient, bobClient, cleoClient, danClient);
  const { workspaceId } = team;
  const fromAdasDesktop = async () => ({
    ...ada,
    device: adasDesktop,
    token: await accessToken(ada.app, adasDesktop),
  });

  // Refused: each writes nothing and sends nothing.
  for (const [label, response, code] of [
    [
      "an offer from the owner's young device",
      await offer(await fromAdasDesktop(), workspaceId, bobInTeam),
      "device_too_new",
    ],
    [
      "an admin's offer",
      await offer(cleo, workspaceId, bobInTeam),
      "forbidden",
    ],
    [
      "a withdrawal without an offer",
      await withdraw(ada, workspaceId),
      "conflict",
    ],
    [
      "an acceptance without an offer",
      await accept(bob, workspaceId),
      "conflict",
    ],
  ] as const) {
    assert.equal(errorCode(response), code, `${label}: ${response.body}`);
  }
  await quiet(...all);

  // Rolled back: the offer ran to its end, and its commit failed.
  failNextCommit();
  const offerRolledBack = await offer(ada, workspaceId, bobInTeam);
  assert.equal(offerRolledBack.statusCode, 500, offerRolledBack.body);
  // The route's own transaction failed, not one that ran before it.
  assert.deepEqual(failedCommits(), ["ownership-routes.ts"]);
  assert.equal((await view(ada, workspaceId)).ownershipOffer, null);
  await quiet(...all);

  // Committed, the same offer.
  const offeredAt = clock.now();
  const committed = await offer(ada, workspaceId, bobInTeam);
  assert.equal(committed.statusCode, 204, committed.body);
  for (const client of told) {
    assert.deepEqual(
      await nextFrame(client),
      offered(workspaceId, bobInTeam, offeredAt),
    );
  }
  await quiet(...all);

  // A withdrawal that rolls back keeps the offer; committed, it ends it.
  failNextCommit();
  const withdrawRolledBack = await withdraw(
    await fromAdasDesktop(),
    workspaceId,
  );
  assert.equal(withdrawRolledBack.statusCode, 500, withdrawRolledBack.body);
  assert.deepEqual(failedCommits(), Array(2).fill("ownership-routes.ts"));
  assert.equal(
    (await view(ada, workspaceId)).ownershipOffer?.memberId,
    bobInTeam,
  );
  await quiet(...all);
  clock.advance(SECOND_MS);
  const withdrawnAt = clock.now();
  const withdrawn = await withdraw(await fromAdasDesktop(), workspaceId);
  assert.equal(withdrawn.statusCode, 204, withdrawn.body);
  for (const client of told) {
    assert.deepEqual(
      await nextFrame(client),
      offerEnded(workspaceId, "withdrawn", withdrawnAt),
    );
  }
  await quiet(...all);

  // The target's acceptance of an expired offer is a refusal that commits
  // the clearing: rolled back, it sends nothing; committed, the expiry
  // reaches both accounts once.
  const againAt = clock.now();
  assert.equal((await offer(ada, workspaceId, bobInTeam)).statusCode, 204);
  for (const client of told) {
    assert.deepEqual(
      await nextFrame(client),
      offered(workspaceId, bobInTeam, againAt),
    );
  }
  clock.advance(OWNERSHIP_OFFER_LIFETIME_MS);
  bob = await refreshed(bob);
  failNextCommit();
  const acceptRolledBack = await accept(bob, workspaceId);
  assert.equal(acceptRolledBack.statusCode, 500, acceptRolledBack.body);
  assert.deepEqual(failedCommits(), Array(3).fill("ownership-routes.ts"));
  await quiet(...all);
  const expired = await accept(bob, workspaceId);
  assert.equal(errorCode(expired), "conflict", expired.body);
  for (const client of told) {
    assert.deepEqual(
      await nextFrame(client),
      offerEnded(workspaceId, "expired", againAt + OWNERSHIP_OFFER_LIFETIME_MS),
    );
  }
  const repeated = await accept(bob, workspaceId);
  assert.equal(errorCode(repeated), "conflict", repeated.body);
  await quiet(...all);
  await settle();
  assert.deepEqual(events, [], "no offer action is a membership event");
});
