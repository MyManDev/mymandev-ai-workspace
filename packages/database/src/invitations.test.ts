import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  AcceptInvitationResponseSchema,
  type DeviceId,
  type InvitationId,
  InvitationListResponseSchema,
  InvitationSchema,
  type MemberId,
  newId,
  newUuidV7,
  PreviewInvitationResponseSchema,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createDatabase } from "./client.ts";
import type { Database } from "./db.ts";
import {
  acceptInvitation,
  type AcceptInvitationResult,
  createInvitation,
  type CreateInvitationInput,
  type CreateInvitationResult,
  listInvitations,
  previewInvitation,
  revokeInvitation,
} from "./invitations.ts";
import { createWorkspace } from "./membership.ts";
import { removeMember } from "./people.ts";
import {
  auditEvents,
  devices,
  userIdentities,
  users,
  workspaceInvitations,
  workspaceMembers,
} from "./schema/index.ts";
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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-11-01T12:00:00.000Z");
const LATER = new Date("2026-11-01T13:00:00.000Z");

function at(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

type Account = Readonly<{ userId: UserId; deviceId: DeviceId }>;

/** An account with one device. */
async function account(name: string): Promise<Account> {
  const db = database();
  const userId = newId<UserId>();
  await db.insert(users).values({ id: userId, displayName: name });
  const deviceId = newId<DeviceId>();
  await db.insert(devices).values({
    id: deviceId,
    userId,
    label: "Laptop",
    platform: "linux",
    publicKey: randomBytes(32).toString("hex"),
    keyAlgorithm: "ed25519",
    lastSignInAt: NOW,
  });
  return { userId, deviceId };
}

/** A workspace of `owner`, with the owner's person. */
async function workspaceOf(owner: Account) {
  const result = await createWorkspace(database(), {
    ...owner,
    name: "Team",
    displayName: "Owner",
    now: NOW,
  });
  assert.ok(result.created);
  return {
    workspaceId: result.membership.workspace.id,
    ownerPerson: result.membership.member.id,
  };
}

/** Adds a person; claimed by `claimedBy` if given, unclaimed otherwise. */
async function addPerson(
  workspaceId: WorkspaceId,
  addedBy: Account,
  values: Partial<typeof workspaceMembers.$inferInsert> & {
    claimedBy?: Account;
  } = {},
): Promise<MemberId> {
  const { claimedBy, ...rest } = values;
  const id = newId<MemberId>();
  await database()
    .insert(workspaceMembers)
    .values({
      id,
      workspaceId,
      displayName: "Someone",
      role: "member",
      addedByUserId: addedBy.userId,
      createdAt: NOW,
      ...(claimedBy === undefined
        ? {}
        : { userId: claimedBy.userId, claimedAt: NOW }),
      ...rest,
    });
  return id;
}

/** Unclaimed people, all at once. */
async function addPeople(
  workspaceId: WorkspaceId,
  addedBy: Account,
  n: number,
): Promise<MemberId[]> {
  const ids = Array.from({ length: n }, () => newId<MemberId>());
  await database()
    .insert(workspaceMembers)
    .values(
      ids.map((id) => ({
        id,
        workspaceId,
        displayName: "Someone",
        role: "member" as const,
        addedByUserId: addedBy.userId,
        createdAt: NOW,
      })),
    );
  return ids;
}

type InvitationRow = typeof workspaceInvitations.$inferInsert;

/** Invitation rows written directly, by default created at `NOW` and live for 7 days. */
async function insertInvitations(
  workspaceId: WorkspaceId,
  createdBy: Account,
  rows: readonly (Partial<InvitationRow> & { memberId: MemberId })[],
): Promise<InvitationId[]> {
  const values = rows.map((row) => {
    const createdAt = row.createdAt ?? NOW;
    return {
      id: newId<InvitationId>(),
      workspaceId,
      tokenHash: randomBytes(32).toString("hex"),
      createdByUserId: createdBy.userId,
      expiresAt: new Date(createdAt.getTime() + 168 * HOUR_MS),
      ...row,
      createdAt,
    };
  });
  await database().insert(workspaceInvitations).values(values);
  return values.map((value) => value.id);
}

async function invitationRow(id: InvitationId) {
  const [row] = await database()
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function auditOf(workspaceId: WorkspaceId) {
  const rows = await database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(auditEvents.id);
  return rows
    .filter((row) => row.action !== "workspace.created")
    .map((row) => ({
      action: row.action,
      actorUserId: row.actorUserId,
      actorDeviceId: row.actorDeviceId,
      subjectId: row.subjectId,
      reason: row.reason,
      createdAt: row.createdAt,
    }));
}

function hash(): string {
  return randomBytes(32).toString("hex");
}

/** Creates an invitation and expects it to be created. */
async function created(input: CreateInvitationInput) {
  const result = await createInvitation(database(), input);
  assert.ok(result.created, JSON.stringify(result));
  return result;
}

test("the owner and an admin create invitations that store only the given hash, with a lifetime of 7 days by default", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const { workspaceId, ownerPerson } = await workspaceOf(owner);
  const adminPerson = await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
  });
  const [linus, margaret] = await addPeople(workspaceId, owner, 2);
  assert.ok(linus !== undefined && margaret !== undefined);

  const ownerHash = hash();
  const byOwner = await created({
    workspaceId,
    ...owner,
    memberId: linus,
    tokenHash: ownerHash,
    now: NOW,
  });
  assert.deepEqual(byOwner.invitation, {
    id: byOwner.invitation.id,
    workspaceId,
    memberId: linus,
    createdByMemberId: ownerPerson,
    createdAt: NOW.toISOString(),
    expiresAt: at(168 * HOUR_MS).toISOString(),
  });
  assert.deepEqual(
    InvitationSchema.parse(byOwner.invitation),
    byOwner.invitation,
  );
  assert.equal(byOwner.replacedInvitationId, null);
  assert.deepEqual(await invitationRow(byOwner.invitation.id), {
    id: byOwner.invitation.id,
    workspaceId,
    memberId: linus,
    tokenHash: ownerHash,
    createdByUserId: owner.userId,
    createdAt: NOW,
    expiresAt: at(168 * HOUR_MS),
    acceptedAt: null,
    acceptedByUserId: null,
    acceptedDeviceId: null,
    revokedAt: null,
    revokedByUserId: null,
  });

  // The shortest lifetime, by an admin.
  const byAdmin = await created({
    workspaceId,
    ...admin,
    memberId: margaret,
    tokenHash: hash(),
    lifetimeSeconds: 3_600,
    now: LATER,
  });
  assert.equal(byAdmin.invitation.createdByMemberId, adminPerson);
  assert.equal(byAdmin.invitation.createdAt, LATER.toISOString());
  assert.equal(
    byAdmin.invitation.expiresAt,
    new Date(LATER.getTime() + HOUR_MS).toISOString(),
  );
  assert.equal(
    (await invitationRow(byAdmin.invitation.id)).createdByUserId,
    admin.userId,
  );

  assert.deepEqual(await auditOf(workspaceId), [
    {
      action: "invitation.created",
      actorUserId: owner.userId,
      actorDeviceId: owner.deviceId,
      subjectId: byOwner.invitation.id,
      reason: null,
      createdAt: NOW,
    },
    {
      action: "invitation.created",
      actorUserId: admin.userId,
      actorDeviceId: admin.deviceId,
      subjectId: byAdmin.invitation.id,
      reason: null,
      createdAt: LATER,
    },
  ]);

  // A hash is unique, and a lifetime outside 1 hour to 7 days breaks the CHECK.
  for (const [label, values, code] of [
    ["a reused hash", { tokenHash: ownerHash }, "23505"],
    ["59 minutes", { lifetimeSeconds: 3_540 }, "23514"],
    ["7 days and a second", { lifetimeSeconds: 604_801 }, "23514"],
  ] as const) {
    await assert.rejects(
      createInvitation(db, {
        workspaceId,
        ...owner,
        memberId: margaret,
        tokenHash: hash(),
        now: LATER,
        ...values,
      }),
      { name: "DatabaseError", code },
      label,
    );
  }
  assert.equal(
    (await invitationRow(byAdmin.invitation.id)).revokedAt,
    null,
    "a failed creation revokes nothing",
  );
});

test("a new invitation revokes the person's earlier invitation with replaced, in the same transaction", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const { workspaceId } = await workspaceOf(owner);
  await addPerson(workspaceId, owner, { claimedBy: admin, role: "admin" });
  const [invited, other, lapsed] = await addPeople(workspaceId, owner, 3);
  assert.ok(invited && other && lapsed);
  const [othersInvitation, expired] = await insertInvitations(
    workspaceId,
    owner,
    [
      { memberId: other },
      // Expired, but neither accepted nor revoked.
      {
        memberId: lapsed,
        createdAt: at(-2 * DAY_MS),
        expiresAt: at(-DAY_MS),
      },
    ],
  );
  assert.ok(othersInvitation && expired);

  const first = await created({
    workspaceId,
    ...owner,
    memberId: invited,
    tokenHash: hash(),
    now: NOW,
  });
  const second = await created({
    workspaceId,
    ...admin,
    memberId: invited,
    tokenHash: hash(),
    now: LATER,
  });
  assert.equal(second.replacedInvitationId, first.invitation.id);
  const replaced = await invitationRow(first.invitation.id);
  assert.deepEqual(replaced.revokedAt, LATER);
  assert.equal(replaced.revokedByUserId, admin.userId);
  assert.equal((await invitationRow(second.invitation.id)).revokedAt, null);
  assert.equal(
    (await invitationRow(othersInvitation)).revokedAt,
    null,
    "another person's invitation stays",
  );

  // An expired invitation is revoked too, so that the person has one invitation.
  const renewed = await created({
    workspaceId,
    ...owner,
    memberId: lapsed,
    tokenHash: hash(),
    now: LATER,
  });
  assert.equal(renewed.replacedInvitationId, expired);
  assert.deepEqual((await invitationRow(expired)).revokedAt, LATER);

  assert.deepEqual(
    (await auditOf(workspaceId)).map((row) => [
      row.action,
      row.actorUserId,
      row.subjectId,
      row.reason,
    ]),
    [
      ["invitation.created", owner.userId, first.invitation.id, null],
      ["invitation.revoked", admin.userId, first.invitation.id, "replaced"],
      ["invitation.created", admin.userId, second.invitation.id, null],
      ["invitation.revoked", owner.userId, expired, "replaced"],
      ["invitation.created", owner.userId, renewed.invitation.id, null],
    ],
  );
  const open = await db
    .select({ id: workspaceInvitations.id })
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.memberId, invited),
        isNull(workspaceInvitations.revokedAt),
      ),
    );
  assert.deepEqual(open, [{ id: second.invitation.id }]);
});

test("a member cannot create, list, or revoke invitations, a claimed or removed person is a conflict, and an account that is no active member is refused as one", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const member = await account("Member");
  const former = await account("Former");
  const outsider = await account("Outsider");
  const { workspaceId, ownerPerson } = await workspaceOf(owner);
  const adminPerson = await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
  });
  const memberPerson = await addPerson(workspaceId, owner, {
    claimedBy: member,
  });
  await addPerson(workspaceId, owner, {
    claimedBy: former,
    role: "admin",
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const unclaimed = await addPerson(workspaceId, owner);
  const removed = await addPerson(workspaceId, owner, {
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const elsewhere = await addPerson(
    (await workspaceOf(outsider)).workspaceId,
    outsider,
  );
  const [live] = await insertInvitations(workspaceId, owner, [
    { memberId: unclaimed },
  ]);
  assert.ok(live !== undefined);

  for (const [label, actor, memberId, refusal] of [
    ["a member", member, unclaimed, "forbidden"],
    ["the owner, the owner", owner, ownerPerson, "conflict"],
    ["the owner, an admin", owner, adminPerson, "conflict"],
    ["an admin, a claimed member", admin, memberPerson, "conflict"],
    ["the owner, a removed person", owner, removed, "conflict"],
    ["the owner, another workspace's person", owner, elsewhere, "not_found"],
    ["the owner, an unknown person", owner, newId<MemberId>(), "not_found"],
    ["a removed admin", former, unclaimed, "not_member"],
    ["an outsider", outsider, unclaimed, "not_member"],
  ] as const) {
    assert.deepEqual(
      await createInvitation(db, {
        workspaceId,
        ...actor,
        memberId,
        tokenHash: hash(),
        now: LATER,
      }),
      { created: false, refusal },
      label,
    );
  }

  for (const [label, actor, refusal] of [
    ["a member", member, "forbidden"],
    ["a removed admin", former, "not_member"],
    ["an outsider", outsider, "not_member"],
  ] as const) {
    assert.deepEqual(
      await listInvitations(db, { workspaceId, ...actor, now: LATER }),
      { listed: false, refusal },
      label,
    );
    assert.deepEqual(
      await revokeInvitation(db, {
        workspaceId,
        ...actor,
        invitationId: live,
        now: LATER,
      }),
      { revoked: false, refusal },
      label,
    );
  }
  assert.deepEqual(
    await listInvitations(db, {
      workspaceId: newId<WorkspaceId>(),
      ...owner,
      now: LATER,
    }),
    { listed: false, refusal: "not_member" },
    "a workspace that does not exist",
  );

  const rows = await db
    .select({ id: workspaceInvitations.id })
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.workspaceId, workspaceId));
  assert.deepEqual(rows, [{ id: live }], "a refusal creates nothing");
  assert.equal(
    (await invitationRow(live)).revokedAt,
    null,
    "nor revokes an invitation",
  );
  assert.deepEqual(await auditOf(workspaceId), [], "and audits nothing");
});

test("the 51st live invitation is refused until the soonest expiry, and replacing a live invitation or ended ones do not count", async () => {
  const db = database();
  const owner = await account("Owner");
  const claimer = await account("Claimer");
  const { workspaceId } = await workspaceOf(owner);
  const people = await addPeople(workspaceId, owner, 54);
  const holders = people.slice(0, 50);
  const [newcomer, revokedPerson, acceptedPerson, expiredPerson] =
    people.slice(50);
  assert.ok(newcomer && revokedPerson && acceptedPerson && expiredPerson);
  // 50 live invitations; the first expires 2 hours after NOW, the others later.
  const live = await insertInvitations(
    workspaceId,
    owner,
    holders.map((memberId, index) => ({
      memberId,
      createdAt: at(-DAY_MS - HOUR_MS),
      expiresAt: at(2 * HOUR_MS + index * MINUTE_MS),
    })),
  );
  // Ended invitations do not count.
  await insertInvitations(workspaceId, owner, [
    {
      memberId: revokedPerson,
      revokedAt: NOW,
      revokedByUserId: owner.userId,
    },
    {
      memberId: acceptedPerson,
      acceptedAt: NOW,
      acceptedByUserId: claimer.userId,
      acceptedDeviceId: claimer.deviceId,
    },
    { memberId: expiredPerson, createdAt: at(-DAY_MS), expiresAt: NOW },
  ]);

  const refused = await createInvitation(db, {
    workspaceId,
    ...owner,
    memberId: newcomer,
    tokenHash: hash(),
    now: NOW,
  });
  assert.deepEqual(refused, {
    created: false,
    refusal: "rate_limited",
    retryAfterMs: 2 * HOUR_MS,
  });
  assert.deepEqual(await auditOf(workspaceId), [], "a refusal writes nothing");

  // A new invitation for a person with a live one keeps the count at 50.
  const holder = holders[10];
  assert.ok(holder !== undefined);
  const replacement = await created({
    workspaceId,
    ...owner,
    memberId: holder,
    tokenHash: hash(),
    now: NOW,
  });
  assert.equal(replacement.replacedInvitationId, live[10]);

  assert.deepEqual(
    await createInvitation(db, {
      workspaceId,
      ...owner,
      memberId: newcomer,
      tokenHash: hash(),
      now: at(2 * HOUR_MS - 1),
    }),
    { created: false, refusal: "rate_limited", retryAfterMs: 1 },
  );
  // At its expiry the first invitation is no longer live.
  await created({
    workspaceId,
    ...owner,
    memberId: newcomer,
    tokenHash: hash(),
    now: at(2 * HOUR_MS),
  });
  const listed = await listInvitations(db, {
    workspaceId,
    ...owner,
    now: at(2 * HOUR_MS),
  });
  assert.ok(listed.listed);
  assert.equal(listed.invitations.length, 50);
});

test("the 101st invitation within 24 hours is refused, also as a replacement, and the window slides", async () => {
  const db = database();
  const owner = await account("Owner");
  const { workspaceId } = await workspaceOf(owner);
  const [person, other] = await addPeople(workspaceId, owner, 2);
  assert.ok(person && other);
  // 100 earlier invitations for one person, one a minute from 23 hours before
  // NOW, each replaced by the next; the last one is live.
  await insertInvitations(
    workspaceId,
    owner,
    Array.from({ length: 100 }, (_, index) => ({
      memberId: person,
      createdAt: at(-23 * HOUR_MS + index * MINUTE_MS),
      ...(index < 99 ? { revokedAt: NOW, revokedByUserId: owner.userId } : {}),
    })),
  );

  for (const memberId of [other, person]) {
    assert.deepEqual(
      await createInvitation(db, {
        workspaceId,
        ...owner,
        memberId,
        tokenHash: hash(),
        now: NOW,
      }),
      { created: false, refusal: "rate_limited", retryAfterMs: HOUR_MS },
    );
  }
  assert.deepEqual(
    await createInvitation(db, {
      workspaceId,
      ...owner,
      memberId: other,
      tokenHash: hash(),
      now: at(HOUR_MS - 1),
    }),
    { created: false, refusal: "rate_limited", retryAfterMs: 1 },
  );

  // An hour later the first leaves the window; the next follows a minute later.
  await created({
    workspaceId,
    ...owner,
    memberId: other,
    tokenHash: hash(),
    now: at(HOUR_MS),
  });
  assert.deepEqual(
    await createInvitation(db, {
      workspaceId,
      ...owner,
      memberId: person,
      tokenHash: hash(),
      now: at(HOUR_MS),
    }),
    { created: false, refusal: "rate_limited", retryAfterMs: MINUTE_MS },
  );
  const count = await db
    .select({ id: workspaceInvitations.id })
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.workspaceId, workspaceId));
  assert.equal(count.length, 101);
});

test("with both limits reached, a new invitation waits for the later of the two", async () => {
  const db = database();
  const owner = await account("Owner");
  const { workspaceId } = await workspaceOf(owner);
  const people = await addPeople(workspaceId, owner, 52);
  const holders = people.slice(0, 50);
  const [replaced, newcomer] = people.slice(50);
  assert.ok(replaced && newcomer);
  // 50 live invitations from 20 hours ago; the first expires 2 hours after NOW.
  await insertInvitations(
    workspaceId,
    owner,
    holders.map((memberId, index) => ({
      memberId,
      createdAt: at(-20 * HOUR_MS),
      expiresAt: at(2 * HOUR_MS + index * MINUTE_MS),
    })),
  );
  // 50 more within 24 hours, all replaced, so 100 in the window.
  await insertInvitations(
    workspaceId,
    owner,
    Array.from({ length: 50 }, (_, index) => ({
      memberId: replaced,
      createdAt: at(-19 * HOUR_MS + index * MINUTE_MS),
      revokedAt: NOW,
      revokedByUserId: owner.userId,
    })),
  );

  // The oldest leaves the window in 4 hours, after the first live one expires.
  assert.deepEqual(
    await createInvitation(db, {
      workspaceId,
      ...owner,
      memberId: newcomer,
      tokenHash: hash(),
      now: NOW,
    }),
    { created: false, refusal: "rate_limited", retryAfterMs: 4 * HOUR_MS },
  );
  // Once the first live one has expired, only the window still waits.
  assert.deepEqual(
    await createInvitation(db, {
      workspaceId,
      ...owner,
      memberId: newcomer,
      tokenHash: hash(),
      now: at(3 * HOUR_MS),
    }),
    { created: false, refusal: "rate_limited", retryAfterMs: HOUR_MS },
  );
  await created({
    workspaceId,
    ...owner,
    memberId: newcomer,
    tokenHash: hash(),
    now: at(4 * HOUR_MS),
  });
});

test("the list holds the live invitations with their creators' people, the most recent first, and no hash", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const claimer = await account("Claimer");
  const other = await account("Other");
  const { workspaceId, ownerPerson } = await workspaceOf(owner);
  const adminPerson = await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
  });
  const [first, second, revokedPerson, acceptedPerson, expiredPerson] =
    await addPeople(workspaceId, owner, 5);
  assert.ok(
    first && second && revokedPerson && acceptedPerson && expiredPerson,
  );
  const byOwner = await created({
    workspaceId,
    ...owner,
    memberId: first,
    tokenHash: hash(),
    now: NOW,
  });
  const byAdmin = await created({
    workspaceId,
    ...admin,
    memberId: second,
    tokenHash: hash(),
    lifetimeSeconds: 7_200,
    now: LATER,
  });
  await insertInvitations(workspaceId, owner, [
    {
      memberId: revokedPerson,
      revokedAt: NOW,
      revokedByUserId: owner.userId,
    },
    {
      memberId: acceptedPerson,
      acceptedAt: NOW,
      acceptedByUserId: claimer.userId,
      acceptedDeviceId: claimer.deviceId,
    },
    {
      memberId: expiredPerson,
      createdAt: at(-2 * HOUR_MS),
      expiresAt: at(2 * HOUR_MS),
    },
  ]);
  // Another workspace's invitation.
  const elsewhere = await workspaceOf(other);
  await insertInvitations(elsewhere.workspaceId, other, [
    { memberId: await addPerson(elsewhere.workspaceId, other) },
  ]);

  const listed = await listInvitations(db, {
    workspaceId,
    ...admin,
    now: at(2 * HOUR_MS),
  });
  assert.ok(listed.listed);
  assert.deepEqual(
    InvitationListResponseSchema.parse({ invitations: listed.invitations }),
    { invitations: listed.invitations },
  );
  assert.deepEqual(listed.invitations, [
    byAdmin.invitation,
    byOwner.invitation,
  ]);
  for (const invitation of listed.invitations) {
    assert.deepEqual(Object.keys(invitation).sort(), [
      "createdAt",
      "createdByMemberId",
      "expiresAt",
      "id",
      "memberId",
      "workspaceId",
    ]);
  }

  // The admin's invitation ends at LATER plus 2 hours.
  const afterExpiry = await listInvitations(db, {
    workspaceId,
    ...owner,
    now: new Date(LATER.getTime() + 2 * HOUR_MS),
  });
  assert.deepEqual(afterExpiry, {
    listed: true,
    invitations: [byOwner.invitation],
  });

  // Should a creator have no active person, their latest person is shown.
  await db
    .update(workspaceMembers)
    .set({ removedAt: LATER, removedByUserId: owner.userId })
    .where(eq(workspaceMembers.id, adminPerson));
  const formerCreator = await listInvitations(db, {
    workspaceId,
    ...owner,
    now: at(2 * HOUR_MS),
  });
  assert.ok(formerCreator.listed);
  assert.deepEqual(
    formerCreator.invitations.map((invitation) => [
      invitation.id,
      invitation.createdByMemberId,
    ]),
    [
      [byAdmin.invitation.id, adminPerson],
      [byOwner.invitation.id, ownerPerson],
    ],
  );
});

test("revoking a live invitation sets revoked_at and revoked_by_user_id and is audited, and revoking it again is a conflict", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const claimer = await account("Claimer");
  const other = await account("Other");
  const { workspaceId } = await workspaceOf(owner);
  await addPerson(workspaceId, owner, { claimedBy: admin, role: "admin" });
  const [invited, acceptedPerson, expiredPerson] = await addPeople(
    workspaceId,
    owner,
    3,
  );
  assert.ok(invited && acceptedPerson && expiredPerson);
  const live = await created({
    workspaceId,
    ...owner,
    memberId: invited,
    tokenHash: hash(),
    now: NOW,
  });
  const [accepted, expired] = await insertInvitations(workspaceId, owner, [
    {
      memberId: acceptedPerson,
      acceptedAt: NOW,
      acceptedByUserId: claimer.userId,
      acceptedDeviceId: claimer.deviceId,
    },
    { memberId: expiredPerson, createdAt: at(-DAY_MS), expiresAt: NOW },
  ]);
  assert.ok(accepted && expired);
  const elsewhere = await workspaceOf(other);
  const [foreign] = await insertInvitations(elsewhere.workspaceId, other, [
    { memberId: await addPerson(elsewhere.workspaceId, other) },
  ]);
  assert.ok(foreign !== undefined);

  assert.deepEqual(
    await revokeInvitation(db, {
      workspaceId,
      ...admin,
      invitationId: live.invitation.id,
      now: LATER,
    }),
    { revoked: true },
  );
  const row = await invitationRow(live.invitation.id);
  assert.deepEqual(row.revokedAt, LATER);
  assert.equal(row.revokedByUserId, admin.userId);

  for (const [label, invitationId, refusal] of [
    ["the same invitation again", live.invitation.id, "conflict"],
    ["an accepted invitation", accepted, "conflict"],
    ["an expired invitation", expired, "conflict"],
    ["another workspace's invitation", foreign, "not_found"],
    ["an unknown invitation", newId<InvitationId>(), "not_found"],
  ] as const) {
    assert.deepEqual(
      await revokeInvitation(db, {
        workspaceId,
        ...owner,
        invitationId,
        now: at(2 * HOUR_MS),
      }),
      { revoked: false, refusal },
      label,
    );
  }
  assert.deepEqual(
    (await invitationRow(live.invitation.id)).revokedAt,
    LATER,
    "the first revocation stays",
  );
  for (const id of [accepted, expired, foreign]) {
    assert.equal((await invitationRow(id)).revokedAt, null);
  }

  assert.deepEqual(
    (await auditOf(workspaceId)).map((entry) => [
      entry.action,
      entry.actorUserId,
      entry.actorDeviceId,
      entry.subjectId,
      entry.reason,
    ]),
    [
      [
        "invitation.created",
        owner.userId,
        owner.deviceId,
        live.invitation.id,
        null,
      ],
      [
        "invitation.revoked",
        admin.userId,
        admin.deviceId,
        live.invitation.id,
        null,
      ],
    ],
  );
  // The person can be invited again.
  const again = await created({
    workspaceId,
    ...owner,
    memberId: invited,
    tokenHash: hash(),
    now: at(2 * HOUR_MS),
  });
  assert.equal(again.replacedInvitationId, null);
});

const SERVER_ONLY = {
  skip:
    process.env["DATABASE_TEST_URL"] === undefined &&
    "needs DATABASE_TEST_URL; PGlite has a single session",
};

/** Whether a session of the test database waits for a lock. */
async function waitsForLock(): Promise<boolean> {
  assert.ok(testDatabase);
  const { rows } = await testDatabase.client.query<{ waiting: number }>(
    "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
  );
  return (rows[0]?.waiting ?? 0) > 0;
}

test(
  "of three concurrent creations at the limit of 50 live invitations, by three people for three others, exactly one succeeds",
  SERVER_ONLY,
  async () => {
    const db = database();
    const owner = await account("Owner");
    const admins = [await account("Admin 1"), await account("Admin 2")];
    const { workspaceId } = await workspaceOf(owner);
    for (const admin of admins) {
      await addPerson(workspaceId, owner, { claimedBy: admin, role: "admin" });
    }
    const people = await addPeople(workspaceId, owner, 52);
    await insertInvitations(
      workspaceId,
      owner,
      people.slice(0, 49).map((memberId) => ({ memberId })),
    );
    // Each creation locks other people, so only the workspace row orders them.
    const results = await Promise.all(
      [owner, ...admins].map((actor, index) => {
        const memberId = people[49 + index];
        assert.ok(memberId !== undefined);
        return createInvitation(db, {
          workspaceId,
          ...actor,
          memberId,
          tokenHash: hash(),
          now: NOW,
        });
      }),
    );
    assert.deepEqual(results.map((result) => result.created).sort(), [
      false,
      false,
      true,
    ]);
    for (const result of results) {
      if (!result.created) {
        assert.equal(result.refusal, "rate_limited");
      }
    }
    const live = await db
      .select({ id: workspaceInvitations.id })
      .from(workspaceInvitations)
      .where(
        and(
          inArray(workspaceInvitations.memberId, people),
          isNull(workspaceInvitations.revokedAt),
        ),
      );
    assert.equal(live.length, 50);
  },
);

test(
  "a creation for another person waits for an open creation in the workspace and then counts it",
  SERVER_ONLY,
  async () => {
    const url = testDatabase?.url;
    assert.ok(url, "the test database is on a server");
    const owner = await account("Owner");
    const admin = await account("Admin");
    const { workspaceId } = await workspaceOf(owner);
    await addPerson(workspaceId, owner, { claimedBy: admin, role: "admin" });
    const people = await addPeople(workspaceId, owner, 51);
    const [first, second] = people.slice(49);
    assert.ok(first && second);
    await insertInvitations(
      workspaceId,
      owner,
      people.slice(0, 49).map((memberId) => ({ memberId })),
    );
    // A second session creates the 50th live invitation and keeps its
    // transaction open. The two creations lock different people, so only the
    // workspace row can make the second one wait.
    const other = createDatabase(url, { max: 1 });
    const holding = Promise.withResolvers<CreateInvitationResult>();
    const release = Promise.withResolvers<void>();
    const firstCreation = other.db.transaction(async (tx) => {
      holding.resolve(
        await createInvitation(tx, {
          workspaceId,
          ...admin,
          memberId: first,
          tokenHash: hash(),
          now: NOW,
        }),
      );
      await release.promise;
    });
    try {
      const fiftieth = await Promise.race([
        holding.promise,
        firstCreation.then(() => {
          throw new Error("the first transaction ended early");
        }),
      ]);
      assert.equal(fiftieth.created, true);
      const secondCreation = createInvitation(database(), {
        workspaceId,
        ...owner,
        memberId: second,
        tokenHash: hash(),
        now: NOW,
      });
      let settled = false;
      secondCreation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // Without the lock of the workspace row, the second creation would not
      // wait: it would count 49 live invitations and create a 51st.
      let waited = false;
      while (!settled && !waited) {
        waited = await waitsForLock();
        if (!waited) {
          await delay(10);
        }
      }
      assert.equal(waited, true, "the second creation waits for a lock");
      release.resolve();
      await firstCreation;
      assert.deepEqual(await secondCreation, {
        created: false,
        refusal: "rate_limited",
        retryAfterMs: 168 * HOUR_MS,
      });
    } finally {
      release.resolve();
      await firstCreation.catch(() => undefined);
      await other.close();
    }
    const live = await database()
      .select({ id: workspaceInvitations.id })
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, workspaceId),
          isNull(workspaceInvitations.revokedAt),
        ),
      );
    assert.equal(live.length, 50);
  },
);

// Previewing and accepting an invitation code.

let nextSubject = 7_000_000;

/** Gives an account its GitHub identity, last verified at `NOW`, as a sign-in does. */
async function identify(who: Account, login: string): Promise<void> {
  nextSubject += 1;
  await database()
    .insert(userIdentities)
    .values({
      id: newUuidV7(),
      userId: who.userId,
      identityProvider: "github",
      subject: String(nextSubject),
      login,
      accountCreatedAt: new Date("2015-06-01T10:00:00.000Z"),
      lastSignInAt: NOW,
    });
}

async function personRow(id: MemberId) {
  const [row] = await database()
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.id, id));
  assert.ok(row !== undefined);
  return row;
}

/** Every row that a preview or an acceptance in the workspace could change. */
async function snapshot(workspaceId: WorkspaceId) {
  const db = database();
  return {
    invitations: await db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.workspaceId, workspaceId))
      .orderBy(workspaceInvitations.id),
    people: await db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(workspaceMembers.id),
    audit: await auditOf(workspaceId),
  };
}

test("a preview shows the workspace, the person, the inviter's person with the GitHub login, and the expiry, and consumes nothing", async () => {
  const owner = await account("Owner account");
  const admin = await account("Admin account");
  const guest = await account("Guest");
  await identify(admin, "grace-h");
  const { workspaceId } = await workspaceOf(owner);
  await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
    displayName: "Grace",
  });
  const linus = await addPerson(workspaceId, owner, { displayName: "Linus" });
  const tokenHash = hash();
  const { invitation } = await created({
    workspaceId,
    ...admin,
    memberId: linus,
    tokenHash,
    lifetimeSeconds: 2 * 3_600,
    now: NOW,
  });
  const before = await snapshot(workspaceId);

  const input = { tokenHash, userId: guest.userId, now: LATER };
  const first = await previewInvitation(database(), input);
  // The inviter is shown by their person in the workspace, not by the
  // account's display name.
  assert.deepEqual(first, {
    previewed: true,
    invitationId: invitation.id,
    preview: {
      workspaceName: "Team",
      displayName: "Linus",
      inviter: {
        displayName: "Grace",
        identity: {
          provider: "github",
          login: "grace-h",
          verifiedAt: NOW.toISOString(),
        },
      },
      expiresAt: at(2 * HOUR_MS).toISOString(),
    },
  });
  assert.ok(first.previewed);
  PreviewInvitationResponseSchema.parse(first.preview);
  assert.deepEqual(await previewInvitation(database(), input), first);
  assert.deepEqual(await snapshot(workspaceId), before, "nothing changed");

  // The code still claims the person.
  const accepted = await acceptInvitation(database(), {
    tokenHash,
    ...guest,
    now: LATER,
  });
  assert.ok(accepted.accepted);
  assert.equal(accepted.membership.member.id, linus);
});

test("a preview refuses an invitation whose creator has no person or no GitHub identity in the workspace as inviter_unknown", async () => {
  const owner = await account("Owner");
  const stranger = await account("Stranger");
  const guest = await account("Guest");
  await identify(stranger, "stranger-login");
  const { workspaceId } = await workspaceOf(owner);
  const preview = (tokenHash: string) =>
    previewInvitation(database(), {
      tokenHash,
      userId: guest.userId,
      now: LATER,
    });

  // The owner of this test never signed in with GitHub.
  const noIdentity = hash();
  const { invitation } = await created({
    workspaceId,
    ...owner,
    memberId: await addPerson(workspaceId, owner),
    tokenHash: noIdentity,
    now: NOW,
  });
  assert.deepEqual(await preview(noIdentity), {
    previewed: false,
    refusal: "invitation_invalid",
    reason: "inviter_unknown",
    invitationId: invitation.id,
  });

  // An account with an identity but no person in the workspace, as only
  // data written outside these functions can be.
  const noPerson = hash();
  const [written] = await insertInvitations(workspaceId, stranger, [
    { memberId: await addPerson(workspaceId, owner), tokenHash: noPerson },
  ]);
  assert.ok(written !== undefined);
  assert.deepEqual(await preview(noPerson), {
    previewed: false,
    refusal: "invitation_invalid",
    reason: "inviter_unknown",
    invitationId: written,
  });
});

test("the inviter of a preview is the creator's active person, or else its most recently removed person", async () => {
  const owner = await account("Owner");
  const admin = await account("Admin");
  const guest = await account("Guest");
  await identify(admin, "grace-h");
  const { workspaceId } = await workspaceOf(owner);
  // The person removed last has the smaller ID, so that only the removal
  // time can pick it.
  const removedLast = newId<MemberId>();
  const removedFirst = newId<MemberId>();
  await addPerson(workspaceId, owner, {
    id: removedFirst,
    claimedBy: admin,
    role: "admin",
    displayName: "Grace before",
    removedAt: at(-2 * HOUR_MS),
    removedByUserId: owner.userId,
  });
  await addPerson(workspaceId, owner, {
    id: removedLast,
    claimedBy: admin,
    role: "admin",
    displayName: "Grace",
  });
  const tokenHash = hash();
  await created({
    workspaceId,
    ...admin,
    memberId: await addPerson(workspaceId, owner),
    tokenHash,
    now: NOW,
  });
  const inviter = async () => {
    const result = await previewInvitation(database(), {
      tokenHash,
      userId: guest.userId,
      now: LATER,
    });
    assert.ok(result.previewed, JSON.stringify(result));
    return result.preview.inviter;
  };
  const identity = {
    provider: "github",
    login: "grace-h",
    verifiedAt: NOW.toISOString(),
  };

  assert.deepEqual(await inviter(), { displayName: "Grace", identity });

  // As only data written outside these functions can be: removing a person
  // revokes the invitations that the person created.
  await database()
    .update(workspaceMembers)
    .set({ removedAt: at(30 * MINUTE_MS), removedByUserId: owner.userId })
    .where(eq(workspaceMembers.id, removedLast));
  assert.deepEqual(await inviter(), { displayName: "Grace", identity });
});

test("accepting claims the person, records the account and the device, and is audited; a second acceptance of the code claims nothing", async () => {
  const owner = await account("Owner");
  const first = await account("First");
  const second = await account("Second");
  await identify(first, "first-login");
  const { workspaceId } = await workspaceOf(owner);
  const linus = await addPerson(workspaceId, owner, { displayName: "Linus" });
  const tokenHash = hash();
  const { invitation } = await created({
    workspaceId,
    ...owner,
    memberId: linus,
    tokenHash,
    now: NOW,
  });

  const accepted = await acceptInvitation(database(), {
    tokenHash,
    ...first,
    now: LATER,
  });
  assert.deepEqual(accepted, {
    accepted: true,
    invitationId: invitation.id,
    membership: {
      workspace: { id: workspaceId, name: "Team" },
      member: {
        id: linus,
        workspaceId,
        displayName: "Linus",
        role: "member",
        userId: first.userId,
        identity: {
          provider: "github",
          login: "first-login",
          verifiedAt: NOW.toISOString(),
        },
        removedAt: null,
      },
    },
  });
  assert.ok(accepted.accepted);
  AcceptInvitationResponseSchema.parse(accepted.membership);
  const consumed = await invitationRow(invitation.id);
  assert.deepEqual(
    [
      consumed.acceptedAt,
      consumed.acceptedByUserId,
      consumed.acceptedDeviceId,
      consumed.revokedAt,
    ],
    [LATER, first.userId, first.deviceId, null],
  );
  const claimed = await personRow(linus);
  assert.deepEqual(
    [claimed.userId, claimed.claimedAt, claimed.role, claimed.removedAt],
    [first.userId, LATER, "member", null],
  );
  const after = await snapshot(workspaceId);

  // Only the first acceptance claims the person.
  assert.deepEqual(
    await acceptInvitation(database(), { tokenHash, ...second, now: LATER }),
    {
      accepted: false,
      refusal: "invitation_invalid",
      reason: "used",
      invitationId: invitation.id,
    },
  );
  // The account that claimed the person is an active member now.
  assert.deepEqual(
    await acceptInvitation(database(), { tokenHash, ...first, now: LATER }),
    {
      accepted: false,
      refusal: "already_member",
      invitationId: invitation.id,
    },
  );
  assert.deepEqual(await snapshot(workspaceId), after, "nothing changed");
  assert.deepEqual(
    after.audit.map((entry) => [
      entry.action,
      entry.actorUserId,
      entry.actorDeviceId,
      entry.subjectId,
      entry.reason,
      entry.createdAt,
    ]),
    [
      [
        "invitation.created",
        owner.userId,
        owner.deviceId,
        invitation.id,
        null,
        NOW,
      ],
      [
        "invitation.accepted",
        first.userId,
        first.deviceId,
        invitation.id,
        null,
        LATER,
      ],
      ["member.claimed", first.userId, first.deviceId, linus, null, LATER],
    ],
  );
  const recorded = await database()
    .select({ workspaceId: auditEvents.workspaceId })
    .from(auditEvents)
    .where(eq(auditEvents.subjectId, linus));
  assert.ok(recorded.every((entry) => entry.workspaceId === workspaceId));
});

test("an unknown, used, expired, or revoked code and a removed or claimed person are refused as invitation_invalid with their reason, and nothing is written", async () => {
  const owner = await account("Owner");
  const first = await account("First");
  const guest = await account("Guest");
  const bystander = await account("Bystander");
  await identify(owner, "owner-login");
  const { workspaceId } = await workspaceOf(owner);
  const invite = async (
    memberId: MemberId,
    lifetimeSeconds?: number,
  ): Promise<{ id: InvitationId; tokenHash: string }> => {
    const tokenHash = hash();
    const { invitation } = await created({
      workspaceId,
      ...owner,
      memberId,
      tokenHash,
      lifetimeSeconds,
      now: NOW,
    });
    return { id: invitation.id, tokenHash };
  };

  const used = await invite(await addPerson(workspaceId, owner));
  const usedBy = await acceptInvitation(database(), {
    tokenHash: used.tokenHash,
    ...first,
    now: NOW,
  });
  assert.ok(usedBy.accepted);
  // It expires at LATER, exactly.
  const expired = await invite(await addPerson(workspaceId, owner), 3_600);
  const revoked = await invite(await addPerson(workspaceId, owner));
  const revocation = await revokeInvitation(database(), {
    workspaceId,
    ...owner,
    invitationId: revoked.id,
    now: NOW,
  });
  assert.deepEqual(revocation, { revoked: true });
  // Removing a person revokes its invitation.
  const removedPerson = await addPerson(workspaceId, owner);
  const removedWithInvitation = await invite(removedPerson);
  const removal = await removeMember(database(), {
    workspaceId,
    ...owner,
    memberId: removedPerson,
    now: NOW,
  });
  assert.ok(removal.removed);
  // A person removed or claimed while its invitation stayed live, as only
  // data written outside these functions can be.
  const removedLive = await addPerson(workspaceId, owner);
  const removedLiveInvitation = await invite(removedLive);
  await database()
    .update(workspaceMembers)
    .set({ removedAt: NOW, removedByUserId: owner.userId })
    .where(eq(workspaceMembers.id, removedLive));
  const claimedLive = await addPerson(workspaceId, owner);
  const claimedLiveInvitation = await invite(claimedLive);
  await database()
    .update(workspaceMembers)
    .set({ userId: bystander.userId, claimedAt: NOW })
    .where(eq(workspaceMembers.id, claimedLive));
  const before = await snapshot(workspaceId);

  for (const [label, tokenHash, invitationId, reason] of [
    ["an unknown code", hash(), null, "unknown"],
    ["a used code", used.tokenHash, used.id, "used"],
    ["an expired code", expired.tokenHash, expired.id, "expired"],
    ["a revoked code", revoked.tokenHash, revoked.id, "revoked"],
    [
      "the code of a removed person",
      removedWithInvitation.tokenHash,
      removedWithInvitation.id,
      "revoked",
    ],
    [
      "a live code of a removed person",
      removedLiveInvitation.tokenHash,
      removedLiveInvitation.id,
      "member_removed",
    ],
    [
      "a live code of a claimed person",
      claimedLiveInvitation.tokenHash,
      claimedLiveInvitation.id,
      "member_claimed",
    ],
  ] as const) {
    const refusal = { refusal: "invitation_invalid", reason, invitationId };
    assert.deepEqual(
      await previewInvitation(database(), {
        tokenHash,
        userId: guest.userId,
        now: LATER,
      }),
      { previewed: false, ...refusal },
      label,
    );
    assert.deepEqual(
      await acceptInvitation(database(), { tokenHash, ...guest, now: LATER }),
      { accepted: false, ...refusal },
      label,
    );
  }
  // A consumed invitation whose person cannot be claimed was rolled back.
  assert.deepEqual(await snapshot(workspaceId), before, "nothing changed");
  const [membership] = await database()
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, guest.userId));
  assert.equal(membership, undefined);

  // One millisecond earlier, the expired code was still live.
  const lastMoment = await acceptInvitation(database(), {
    tokenHash: expired.tokenHash,
    ...guest,
    now: new Date(LATER.getTime() - 1),
  });
  assert.ok(lastMoment.accepted);
});

test("an active member of the workspace gets already_member before anything is consumed, whatever the invitation's state", async () => {
  const owner = await account("Owner");
  const member = await account("Member");
  const guest = await account("Guest");
  await identify(owner, "owner-login");
  const { workspaceId } = await workspaceOf(owner);
  await addPerson(workspaceId, owner, { claimedBy: member });
  const linus = await addPerson(workspaceId, owner);
  const live = hash();
  const { invitation } = await created({
    workspaceId,
    ...owner,
    memberId: linus,
    tokenHash: live,
    now: NOW,
  });
  const margaret = await addPerson(workspaceId, owner);
  const revokedHash = hash();
  const revoked = await created({
    workspaceId,
    ...owner,
    memberId: margaret,
    tokenHash: revokedHash,
    now: NOW,
  });
  await revokeInvitation(database(), {
    workspaceId,
    ...owner,
    invitationId: revoked.invitation.id,
    now: NOW,
  });
  const before = await snapshot(workspaceId);

  for (const [who, tokenHash, invitationId] of [
    [owner, live, invitation.id],
    [member, live, invitation.id],
    [member, revokedHash, revoked.invitation.id],
  ] as const) {
    const refusal = { refusal: "already_member", invitationId };
    assert.deepEqual(
      await previewInvitation(database(), {
        tokenHash,
        userId: who.userId,
        now: LATER,
      }),
      { previewed: false, ...refusal },
    );
    assert.deepEqual(
      await acceptInvitation(database(), { tokenHash, ...who, now: LATER }),
      { accepted: false, ...refusal },
    );
  }
  assert.deepEqual(await snapshot(workspaceId), before, "nothing changed");

  // The invitation was not consumed: the person it names can still claim it.
  const accepted = await acceptInvitation(database(), {
    tokenHash: live,
    ...guest,
    now: LATER,
  });
  assert.ok(accepted.accepted);
  assert.equal(accepted.membership.member.id, linus);
});

test("an account removed from a workspace rejoins as a new person, and its earlier person stays in the history", async () => {
  const owner = await account("Owner");
  const returning = await account("Returning");
  await identify(returning, "returning-login");
  const { workspaceId } = await workspaceOf(owner);
  const earlier = await addPerson(workspaceId, owner, {
    claimedBy: returning,
    displayName: "Ada",
  });
  const removal = await removeMember(database(), {
    workspaceId,
    ...owner,
    memberId: earlier,
    now: NOW,
  });
  assert.ok(removal.removed);
  const earlierRow = await personRow(earlier);
  const again = await addPerson(workspaceId, owner, { displayName: "Ada" });
  const tokenHash = hash();
  await created({
    workspaceId,
    ...owner,
    memberId: again,
    tokenHash,
    now: NOW,
  });

  const accepted = await acceptInvitation(database(), {
    tokenHash,
    ...returning,
    now: LATER,
  });
  assert.ok(accepted.accepted);
  assert.equal(accepted.membership.member.id, again);
  assert.notEqual(again, earlier);
  assert.deepEqual(
    await personRow(earlier),
    earlierRow,
    "the former person stays",
  );
  const people = await database()
    .select({
      id: workspaceMembers.id,
      removedAt: workspaceMembers.removedAt,
    })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, returning.userId),
      ),
    )
    .orderBy(workspaceMembers.id);
  assert.deepEqual(people, [
    { id: earlier, removedAt: NOW },
    { id: again, removedAt: null },
  ]);
});

/**
 * Runs `first` in a second session and keeps its transaction open, starts
 * `action`, and once the action waits for a lock, runs `then` in that
 * session and commits. Returns the action's result. The second session's
 * transaction must commit; a deadlock between the two fails the test.
 */
async function whileHeld<T>(
  first: (tx: Database) => Promise<unknown>,
  then: (tx: Database) => Promise<unknown>,
  action: () => Promise<T>,
): Promise<T> {
  const url = testDatabase?.url;
  assert.ok(url, "the test database is on a server");
  const other = createDatabase(url, { max: 1 });
  const holding = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const changing = other.db.transaction(async (tx) => {
    await first(tx);
    holding.resolve();
    await proceed.promise;
    await then(tx);
  });
  try {
    await Promise.race([
      holding.promise,
      changing.then(() => {
        throw new Error("the change ended early");
      }),
    ]);
    const result = action();
    let settled = false;
    result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled && !(await waitsForLock())) {
      await delay(10);
    }
    proceed.resolve();
    await changing;
    return await result;
  } finally {
    proceed.resolve();
    await changing.catch(() => undefined);
    await other.close();
  }
}

test(
  "of two concurrent acceptances of one code, exactly one claims the person",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const first = await account("First");
    const second = await account("Second");
    const { workspaceId } = await workspaceOf(owner);
    const linus = await addPerson(workspaceId, owner);
    const tokenHash = hash();
    const { invitation } = await created({
      workspaceId,
      ...owner,
      memberId: linus,
      tokenHash,
      now: NOW,
    });

    // The first acceptance holds its transaction open while the second starts.
    let firstResult: AcceptInvitationResult | undefined;
    const secondResult = await whileHeld(
      async (tx) => {
        firstResult = await acceptInvitation(tx, {
          tokenHash,
          ...first,
          now: LATER,
        });
      },
      async () => undefined,
      () => acceptInvitation(database(), { tokenHash, ...second, now: LATER }),
    );
    assert.equal(firstResult?.accepted, true);
    assert.deepEqual(secondResult, {
      accepted: false,
      refusal: "invitation_invalid",
      reason: "used",
      invitationId: invitation.id,
    });

    // And both at once, without a held transaction.
    const third = await account("Third");
    const fourth = await account("Fourth");
    const margaret = await addPerson(workspaceId, owner);
    const raced = hash();
    await created({
      workspaceId,
      ...owner,
      memberId: margaret,
      tokenHash: raced,
      now: NOW,
    });
    const results = await Promise.all(
      [third, fourth].map((who) =>
        acceptInvitation(database(), { tokenHash: raced, ...who, now: LATER }),
      ),
    );
    assert.deepEqual(results.map((result) => result.accepted).sort(), [
      false,
      true,
    ]);

    for (const [memberId, winner] of [
      [linus, first],
      [margaret, results[0]?.accepted === true ? third : fourth],
    ] as const) {
      assert.equal((await personRow(memberId)).userId, winner.userId);
    }
    const claims = (await auditOf(workspaceId)).filter(
      (entry) =>
        entry.action === "invitation.accepted" ||
        entry.action === "member.claimed",
    );
    assert.equal(claims.length, 4);
  },
);

test(
  "an acceptance locks the person before it consumes the invitation, so it waits for a removal that holds the person and does not deadlock with it",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const guest = await account("Guest");
    const { workspaceId } = await workspaceOf(owner);
    const linus = await addPerson(workspaceId, owner);
    const tokenHash = hash();
    const { invitation } = await created({
      workspaceId,
      ...owner,
      memberId: linus,
      tokenHash,
      now: NOW,
    });

    // As `removeMember`: the person first, then the person's invitation.
    const result = await whileHeld(
      (tx) =>
        tx
          .select({ id: workspaceMembers.id })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.id, linus))
          .for("no key update"),
      async (tx) => {
        await tx
          .update(workspaceMembers)
          .set({ removedAt: NOW, removedByUserId: owner.userId })
          .where(eq(workspaceMembers.id, linus));
        await tx
          .update(workspaceInvitations)
          .set({ revokedAt: NOW, revokedByUserId: owner.userId })
          .where(eq(workspaceInvitations.id, invitation.id));
      },
      () => acceptInvitation(database(), { tokenHash, ...guest, now: LATER }),
    );
    assert.deepEqual(result, {
      accepted: false,
      refusal: "invitation_invalid",
      reason: "revoked",
      invitationId: invitation.id,
    });
    const row = await invitationRow(invitation.id);
    assert.equal(row.acceptedAt, null);
    assert.ok(row.revokedAt instanceof Date);
    const person = await personRow(linus);
    assert.equal(person.userId, null);
    assert.ok(person.removedAt instanceof Date);
  },
);

test(
  "an account that claims another person of the workspace while its acceptance runs gets already_member, and the invitation stays live",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const guest = await account("Guest");
    const { workspaceId } = await workspaceOf(owner);
    const linus = await addPerson(workspaceId, owner);
    const margaret = await addPerson(workspaceId, owner);
    const tokenHash = hash();
    const { invitation } = await created({
      workspaceId,
      ...owner,
      memberId: linus,
      tokenHash,
      now: NOW,
    });

    // As a concurrent acceptance of Margaret's invitation by the same account.
    const result = await whileHeld(
      (tx) =>
        tx
          .update(workspaceMembers)
          .set({ userId: guest.userId, claimedAt: NOW })
          .where(eq(workspaceMembers.id, margaret)),
      async () => undefined,
      () => acceptInvitation(database(), { tokenHash, ...guest, now: LATER }),
    );
    assert.deepEqual(result, {
      accepted: false,
      refusal: "already_member",
      invitationId: invitation.id,
    });
    const row = await invitationRow(invitation.id);
    assert.equal(row.acceptedAt, null);
    assert.equal(row.revokedAt, null);
    assert.equal((await personRow(linus)).userId, null);
    assert.equal((await personRow(margaret)).userId, guest.userId);
  },
);
