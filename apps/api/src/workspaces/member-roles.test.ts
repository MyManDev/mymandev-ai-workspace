import {
  auditEvents,
  DEVICE_TOO_NEW_MS,
  devices,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  CreateInvitationResponseSchema,
  decodeEvent,
  decodeServerMessage,
  type MemberId,
  type MemberRole,
  newId,
  type ServerEvent,
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

// Promoting and demoting admins (ADR 0014, "People and roles"; #93): only
// the owner, a promotion only from a device older than 72 hours, a demotion
// revokes the invitations that the admin created, and each change reaches
// the workspace's subscribers as `workspace.member.role_changed`.

const database = useTestDatabase();

type Account = Readonly<{
  app: FastifyInstance;
  device: SignedInDevice;
  token: string;
}>;

/**
 * One API instance: each account signs in through its own app, and every app
 * shares one registry of connections, one database, and the list of
 * membership events that went out.
 */
async function instance(t: TestContext) {
  const connections = new ConnectionRegistry();
  const events: WorkspaceEvent[] = [];
  const account = async (githubId: number): Promise<Account> => {
    const app = await deviceApp(t, {
      database: database(),
      githubId,
      connections,
      onWorkspaceEvent: (event) => {
        events.push(event);
      },
    });
    // injectWS never settles unless the app is ready.
    await app.ready();
    const device = await signInDevice(app);
    return { app, device, token: await accessToken(app, device) };
  };
  return { connections, events, account };
}

/** Moves the device's registration back, so that it is older than 72 hours. */
async function established(device: SignedInDevice) {
  await database()
    .update(devices)
    .set({ createdAt: new Date(Date.now() - DEVICE_TOO_NEW_MS - 60_000) })
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

function promote(account: Account, workspaceId: string, memberId: string) {
  return post(
    account,
    `/workspaces/${workspaceId}/members/${memberId}/promote`,
  );
}

function demote(account: Account, workspaceId: string, memberId: string) {
  return post(account, `/workspaces/${workspaceId}/members/${memberId}/demote`);
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

/** The audit records of the workspace after its creation, in order. */
async function auditOf(workspaceId: WorkspaceId) {
  return database()
    .select({
      action: auditEvents.action,
      actorUserId: auditEvents.actorUserId,
      actorDeviceId: auditEvents.actorDeviceId,
      subjectId: auditEvents.subjectId,
      reason: auditEvents.reason,
    })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(auditEvents.id);
}

function errorCode(response: { json(): unknown }): unknown {
  return (response.json() as { code?: unknown }).code;
}

test("the owner promotes a claimed member and demotes an admin with 204, each audited and sent as workspace.member.role_changed from the system", async (t) => {
  const { events, account } = await instance(t);
  const ada = await account(3501);
  const bob = await account(3502);
  const cleo = await account(3503);
  await established(ada.device);
  const team = await workspaceOf(ada.device, [
    [bob.device, "member"],
    [cleo.device, "admin"],
  ]);
  const [bobInTeam, cleoInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined && cleoInTeam !== undefined);

  const promoted = await promote(ada, team.workspaceId, bobInTeam);
  assert.equal(promoted.statusCode, 204, promoted.body);
  assert.equal(promoted.body, "");
  const demoted = await demote(ada, team.workspaceId, cleoInTeam);
  assert.equal(demoted.statusCode, 204, demoted.body);
  assert.equal(demoted.body, "");

  const after = await roles(bob, team.workspaceId);
  assert.equal(after.get(bobInTeam), "admin");
  assert.equal(after.get(cleoInTeam), "member");
  assert.equal(after.get(team.ownerId), "owner");
  // The promoted admin may now define people, and the demoted one no more.
  const byBob = await post(bob, `/workspaces/${team.workspaceId}/members`, {
    displayName: "Linus",
  });
  assert.equal(byBob.statusCode, 200, byBob.body);
  const byCleo = await post(cleo, `/workspaces/${team.workspaceId}/members`, {
    displayName: "Eve",
  });
  assert.equal(byCleo.statusCode, 403);
  assert.equal(errorCode(byCleo), "forbidden");

  const actor = {
    actorUserId: ada.device.userId,
    actorDeviceId: ada.device.deviceId,
    reason: null,
  };
  assert.deepEqual((await auditOf(team.workspaceId)).slice(0, 2), [
    { action: "member.promoted", subjectId: bobInTeam, ...actor },
    { action: "member.demoted", subjectId: cleoInTeam, ...actor },
  ]);

  const changes = events.filter(
    (event) => event.type === "workspace.member.role_changed",
  );
  assert.deepEqual(
    changes.map((event) => event.payload),
    [
      { memberId: bobInTeam, role: "admin" },
      { memberId: cleoInTeam, role: "member" },
    ],
  );
  for (const event of changes) {
    assert.equal(event.workspaceId, team.workspaceId);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.payload));
    assert.deepEqual(decodeEvent(JSON.parse(JSON.stringify(event))), {
      ok: true,
      event,
    });
  }
});

test("demoting an admin revokes the invitations the admin created with creator_demoted, so their codes no longer work; a promotion revokes none", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3511);
  const bob = await account(3512);
  const cleo = await account(3513);
  const outsider = await account(3514);
  await established(ada.device);
  const team = await workspaceOf(ada.device, [
    [bob.device, "admin"],
    [cleo.device, "member"],
  ]);
  const [bobInTeam, cleoInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined && cleoInTeam !== undefined);
  const invite = async (by: Account) => {
    const defined = await post(by, `/workspaces/${team.workspaceId}/members`, {
      displayName: "Linus",
    });
    assert.equal(defined.statusCode, 200, defined.body);
    const { member } = defined.json() as { member: { id: MemberId } };
    const created = await post(
      by,
      `/workspaces/${team.workspaceId}/invitations`,
      { memberId: member.id },
    );
    assert.equal(created.statusCode, 200, created.body);
    return CreateInvitationResponseSchema.parse(created.json());
  };
  const listed = async () => {
    const response = await ada.app.inject({
      method: "GET",
      url: `/workspaces/${team.workspaceId}/invitations`,
      headers: { authorization: `Bearer ${ada.token}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    return (response.json() as { invitations: { id: string }[] }).invitations
      .map((invitation) => invitation.id)
      .sort();
  };
  const bobs = [await invite(bob), await invite(bob)];
  const adas = await invite(ada);
  const all = [...bobs, adas].map((created) => created.invitation.id).sort();
  assert.deepEqual(await listed(), all);

  const promoted = await promote(ada, team.workspaceId, cleoInTeam);
  assert.equal(promoted.statusCode, 204, promoted.body);
  assert.deepEqual(await listed(), all, "a promotion revokes nothing");

  const demoted = await demote(ada, team.workspaceId, bobInTeam);
  assert.equal(demoted.statusCode, 204, demoted.body);
  assert.deepEqual(await listed(), [adas.invitation.id]);
  const revoked = (await auditOf(team.workspaceId)).filter(
    (record) => record.reason === "creator_demoted",
  );
  assert.deepEqual(
    revoked,
    bobs
      .map((created) => created.invitation.id)
      .sort()
      .map((subjectId) => ({
        action: "invitation.revoked",
        actorUserId: ada.device.userId,
        actorDeviceId: ada.device.deviceId,
        subjectId,
        reason: "creator_demoted",
      })),
  );
  for (const { code } of bobs) {
    const preview = await post(outsider, "/invitations/preview", { code });
    assert.equal(preview.statusCode, 404, preview.body);
    assert.equal(errorCode(preview), "invitation_invalid");
  }
  const stillLive = await post(outsider, "/invitations/preview", {
    code: adas.code,
  });
  assert.equal(stillLive.statusCode, 200, stillLive.body);
});

test("only the owner changes a role, never their own, and only of an active, claimed person in the right role; a refusal changes nothing and sends nothing", async (t) => {
  const { events, account } = await instance(t);
  const ada = await account(3521);
  const bob = await account(3522);
  const cleo = await account(3523);
  const dan = await account(3524);
  const former = await account(3525);
  const outsider = await account(3526);
  for (const each of [ada, bob, cleo, dan, former, outsider]) {
    await established(each.device);
  }
  const team = await workspaceOf(ada.device, [
    [bob.device, "admin"],
    [cleo.device, "admin"],
    [dan.device, "member"],
    [former.device, "admin"],
  ]);
  const [bobInTeam, cleoInTeam, danInTeam, formerInTeam] = team.memberIds;
  assert.ok(
    bobInTeam !== undefined &&
      cleoInTeam !== undefined &&
      danInTeam !== undefined &&
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
  const before = await view(ada, team.workspaceId);
  events.length = 0;

  const { workspaceId } = team;
  for (const [label, response, status, code] of [
    [
      "an admin promotes a member",
      await promote(bob, workspaceId, danInTeam),
      403,
      "forbidden",
    ],
    [
      "an admin demotes another admin",
      await demote(bob, workspaceId, cleoInTeam),
      403,
      "forbidden",
    ],
    [
      "an admin demotes themselves",
      await demote(bob, workspaceId, bobInTeam),
      403,
      "forbidden",
    ],
    [
      "an admin demotes the owner",
      await demote(bob, workspaceId, team.ownerId),
      403,
      "forbidden",
    ],
    [
      "a member promotes themselves",
      await promote(dan, workspaceId, danInTeam),
      403,
      "forbidden",
    ],
    [
      "a member demotes an admin",
      await demote(dan, workspaceId, bobInTeam),
      403,
      "forbidden",
    ],
    [
      "the owner promotes themselves",
      await promote(ada, workspaceId, team.ownerId),
      403,
      "forbidden",
    ],
    [
      "the owner demotes themselves",
      await demote(ada, workspaceId, team.ownerId),
      403,
      "forbidden",
    ],
    [
      "the owner promotes an admin",
      await promote(ada, workspaceId, bobInTeam),
      409,
      "conflict",
    ],
    [
      "the owner demotes a member",
      await demote(ada, workspaceId, danInTeam),
      409,
      "conflict",
    ],
    [
      "the owner promotes an unclaimed person",
      await promote(ada, workspaceId, unclaimed),
      409,
      "conflict",
    ],
    [
      "the owner demotes an unclaimed person",
      await demote(ada, workspaceId, unclaimed),
      409,
      "conflict",
    ],
    [
      "the owner demotes a former admin",
      await demote(ada, workspaceId, formerInTeam),
      409,
      "conflict",
    ],
    [
      "the owner promotes an unknown person",
      await promote(ada, workspaceId, newId<MemberId>()),
      404,
      "not_found",
    ],
    [
      "the owner demotes an unknown person",
      await demote(ada, workspaceId, newId<MemberId>()),
      404,
      "not_found",
    ],
    [
      "the owner promotes a malformed ID",
      await promote(ada, workspaceId, "not-an-id"),
      400,
      "bad_request",
    ],
    [
      "a former admin promotes",
      await promote(former, workspaceId, danInTeam),
      404,
      "not_found",
    ],
    [
      "a former admin demotes",
      await demote(former, workspaceId, bobInTeam),
      404,
      "not_found",
    ],
    [
      "an outsider demotes",
      await demote(outsider, workspaceId, bobInTeam),
      404,
      "not_found",
    ],
  ] as const) {
    assert.equal(response.statusCode, status, `${label}: ${response.body}`);
    assert.equal(errorCode(response), code, label);
  }
  assert.deepEqual(await view(ada, team.workspaceId), before);
  assert.deepEqual(
    (await auditOf(team.workspaceId)).map((record) => record.action),
    ["member.defined"],
  );
  await settle();
  assert.deepEqual(events, [], "a refusal sends no event");
});

test("a device not older than 72 hours cannot promote, and nothing changes, while any device of the owner demotes", async (t) => {
  const { events, account } = await instance(t);
  const ada = await account(3531);
  const bob = await account(3532);
  const cleo = await account(3533);
  const team = await workspaceOf(ada.device, [
    [bob.device, "member"],
    [cleo.device, "admin"],
  ]);
  const [bobInTeam, cleoInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined && cleoInTeam !== undefined);

  const refused = await promote(ada, team.workspaceId, bobInTeam);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.deepEqual(refused.json(), {
    statusCode: 403,
    error: "Forbidden",
    message: "Forbidden",
    code: "device_too_new",
  });
  assert.equal((await roles(ada, team.workspaceId)).get(bobInTeam), "member");
  assert.equal(events.length, 0);

  const demoted = await demote(ada, team.workspaceId, cleoInTeam);
  assert.equal(demoted.statusCode, 204, demoted.body);
  assert.equal((await roles(ada, team.workspaceId)).get(cleoInTeam), "member");

  await established(ada.device);
  const promoted = await promote(ada, team.workspaceId, bobInTeam);
  assert.equal(promoted.statusCode, 204, promoted.body);
  assert.equal((await roles(ada, team.workspaceId)).get(bobInTeam), "admin");
  assert.deepEqual(
    events.map((event) => [event.type, event.payload]),
    [
      [
        "workspace.member.role_changed",
        { memberId: cleoInTeam, role: "member" },
      ],
      ["workspace.member.role_changed", { memberId: bobInTeam, role: "admin" }],
    ],
  );
});

/** Subscribes and checks the answer. */
async function subscribe(client: Client, workspaceId: WorkspaceId) {
  client.send({ protocolVersion: 0, type: "workspace.subscribe", workspaceId });
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

/** Lets pending frames arrive, then checks that none is left unread. */
async function quiet(...clients: Client[]) {
  await settle();
  for (const client of clients) {
    assert.equal(client.unread(), 0);
  }
}

test("a role change reaches only the subscribers of its workspace, the person included, as an event that the device's decoder accepts", async (t) => {
  const { connections, account } = await instance(t);
  const ada = await account(3541);
  const bob = await account(3542);
  const cleo = await account(3543);
  await established(ada.device);
  const team = await workspaceOf(ada.device, [[bob.device, "member"]]);
  const [bobInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined);
  // Bob is in Cleo's workspace too, where nothing changes.
  const other = await workspaceOf(cleo.device, [[bob.device, "member"]]);

  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  await subscribe(adaClient, team.workspaceId);
  await subscribe(bobClient, team.workspaceId);
  await subscribe(cleoClient, other.workspaceId);
  await subscribe(bobClient, other.workspaceId);
  await settle();
  // Drain the presence frames of the subscriptions.
  for (const client of [adaClient, cleoClient]) {
    while (client.unread() > 0) {
      assert.equal((await nextFrame(client)).type, "presence.changed");
    }
  }
  await quiet(adaClient, bobClient, cleoClient);

  for (const [action, role] of [
    ["promote", "admin"],
    ["demote", "member"],
  ] as const) {
    const response = await post(
      ada,
      `/workspaces/${team.workspaceId}/members/${bobInTeam}/${action}`,
    );
    assert.equal(response.statusCode, 204, response.body);
    for (const client of [adaClient, bobClient]) {
      const event = await nextEvent(client);
      assert.ok(event.type === "workspace.member.role_changed", event.type);
      assert.equal(event.workspaceId, team.workspaceId);
      assert.deepEqual(event.actor, { kind: "system" });
      assert.equal(event.deviceId, null);
      assert.deepEqual(event.payload, { memberId: bobInTeam, role });
    }
    await quiet(adaClient, bobClient, cleoClient);
  }
  // A role change ends no subscription.
  assert.equal(
    connections
      .subscriptions()
      .filter(({ context }) => context.identity.userId === bob.device.userId)
      .length,
    2,
  );
});
