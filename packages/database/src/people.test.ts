import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  DefineMemberResponseSchema,
  type DeviceId,
  type InvitationId,
  type MemberId,
  newId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "./client.ts";
import type { Database } from "./db.ts";
import { createWorkspace } from "./membership.ts";
import { defineMember, removeMember, renameMember } from "./people.ts";
import {
  auditEvents,
  devices,
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

const HOUR_MS = 60 * 60_000;
const NOW = new Date("2026-11-01T12:00:00.000Z");
const LATER = new Date("2026-11-01T13:00:00.000Z");

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

/** An invitation for the person, created at `NOW` and live for 7 days. */
async function invite(
  workspaceId: WorkspaceId,
  memberId: MemberId,
  createdBy: Account,
  values: Partial<typeof workspaceInvitations.$inferInsert> = {},
): Promise<InvitationId> {
  const id = newId<InvitationId>();
  await database()
    .insert(workspaceInvitations)
    .values({
      id,
      workspaceId,
      memberId,
      tokenHash: randomBytes(32).toString("hex"),
      createdByUserId: createdBy.userId,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 168 * HOUR_MS),
      ...values,
    });
  return id;
}

async function person(id: MemberId) {
  const [row] = await database()
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.id, id));
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

test("the owner and an admin define unclaimed members, each audited", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const { workspaceId } = await workspaceOf(owner);
  await addPerson(workspaceId, owner, { claimedBy: admin, role: "admin" });

  const byOwner = await defineMember(db, {
    workspaceId,
    ...owner,
    displayName: "Linus",
    now: NOW,
  });
  assert.ok(byOwner.defined);
  assert.deepEqual(
    DefineMemberResponseSchema.parse({ member: byOwner.member }),
    { member: byOwner.member },
  );
  assert.deepEqual(byOwner.member, {
    id: byOwner.member.id,
    workspaceId,
    displayName: "Linus",
    role: "member",
    userId: null,
    identity: null,
    removedAt: null,
  });
  const row = await person(byOwner.member.id);
  assert.equal(row.addedByUserId, owner.userId);
  assert.equal(row.userId, null);
  assert.equal(row.claimedAt, null);
  assert.deepEqual(row.createdAt, NOW);
  assert.deepEqual(row.updatedAt, NOW);

  const byAdmin = await defineMember(db, {
    workspaceId,
    ...admin,
    displayName: "Margaret",
    now: LATER,
  });
  assert.ok(byAdmin.defined);
  assert.equal(byAdmin.member.role, "member");
  assert.equal((await person(byAdmin.member.id)).addedByUserId, admin.userId);

  assert.deepEqual(await auditOf(workspaceId), [
    {
      action: "member.defined",
      actorUserId: owner.userId,
      actorDeviceId: owner.deviceId,
      subjectId: byOwner.member.id,
      reason: null,
      createdAt: NOW,
    },
    {
      action: "member.defined",
      actorUserId: admin.userId,
      actorDeviceId: admin.deviceId,
      subjectId: byAdmin.member.id,
      reason: null,
      createdAt: LATER,
    },
  ]);
});

test("a member cannot define a person, and an account that is no active member is refused as one", async () => {
  const db = database();
  const owner = await account("Owner");
  const member = await account("Member");
  const former = await account("Former");
  const outsider = await account("Outsider");
  const { workspaceId } = await workspaceOf(owner);
  await addPerson(workspaceId, owner, { claimedBy: member });
  await addPerson(workspaceId, owner, {
    claimedBy: former,
    role: "admin",
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const people = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  for (const [label, actor, inWorkspace, refusal] of [
    ["a member", member, workspaceId, "forbidden"],
    ["a removed admin", former, workspaceId, "not_member"],
    ["an outsider", outsider, workspaceId, "not_member"],
    ["the owner elsewhere", owner, newId<WorkspaceId>(), "not_member"],
  ] as const) {
    assert.deepEqual(
      await defineMember(db, {
        workspaceId: inWorkspace,
        ...actor,
        displayName: "Linus",
        now: NOW,
      }),
      { defined: false, refusal },
      label,
    );
  }
  const after = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  assert.equal(after.length, people.length, "a refusal defines nobody");
  assert.deepEqual(await auditOf(workspaceId), [], "and audits nothing");
});

test("every member renames their own person, and the owner or an admin an unclaimed one", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const member = await account("Member");
  const { workspaceId, ownerPerson } = await workspaceOf(owner);
  const adminPerson = await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
  });
  const memberPerson = await addPerson(workspaceId, owner, {
    claimedBy: member,
  });
  const unclaimed = await addPerson(workspaceId, owner);

  for (const [actor, memberId, displayName] of [
    [member, memberPerson, "Grace H."],
    [admin, adminPerson, "Admin A."],
    [owner, ownerPerson, "Owner O."],
    [owner, unclaimed, "By the owner"],
    [admin, unclaimed, "By an admin"],
  ] as const) {
    assert.deepEqual(
      await renameMember(db, {
        workspaceId,
        ...actor,
        memberId,
        displayName,
        now: LATER,
      }),
      { renamed: true },
    );
    const row = await person(memberId);
    assert.equal(row.displayName, displayName);
    assert.deepEqual(row.updatedAt, LATER);
  }
  assert.equal((await person(memberPerson)).role, "member");
  assert.deepEqual(
    (await auditOf(workspaceId)).map((row) => [
      row.action,
      row.actorUserId,
      row.actorDeviceId,
      row.subjectId,
    ]),
    [
      ["member.renamed", member.userId, member.deviceId, memberPerson],
      ["member.renamed", admin.userId, admin.deviceId, adminPerson],
      ["member.renamed", owner.userId, owner.deviceId, ownerPerson],
      ["member.renamed", owner.userId, owner.deviceId, unclaimed],
      ["member.renamed", admin.userId, admin.deviceId, unclaimed],
    ],
  );
});

test("nobody renames another claimed person, a member no unclaimed one, and a removed person is a conflict", async () => {
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
  const unclaimed = await addPerson(workspaceId, owner);
  const removedUnclaimed = await addPerson(workspaceId, owner, {
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const formerPerson = await addPerson(workspaceId, owner, {
    claimedBy: former,
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const elsewhere = await addPerson(
    (await workspaceOf(outsider)).workspaceId,
    outsider,
  );

  for (const [label, actor, memberId, refusal] of [
    ["the owner, an admin", owner, adminPerson, "forbidden"],
    ["the owner, a member", owner, memberPerson, "forbidden"],
    ["an admin, the owner", admin, ownerPerson, "forbidden"],
    ["an admin, a member", admin, memberPerson, "forbidden"],
    ["a member, the owner", member, ownerPerson, "forbidden"],
    ["a member, an unclaimed person", member, unclaimed, "forbidden"],
    [
      "a member, a removed unclaimed person",
      member,
      removedUnclaimed,
      "forbidden",
    ],
    ["the owner, a former member", owner, formerPerson, "forbidden"],
    [
      "the owner, a removed unclaimed person",
      owner,
      removedUnclaimed,
      "conflict",
    ],
    [
      "an admin, a removed unclaimed person",
      admin,
      removedUnclaimed,
      "conflict",
    ],
    ["the owner, another workspace's person", owner, elsewhere, "not_found"],
    ["the owner, an unknown person", owner, newId<MemberId>(), "not_found"],
    [
      "a former member, their former person",
      former,
      formerPerson,
      "not_member",
    ],
  ] as const) {
    assert.deepEqual(
      await renameMember(db, {
        workspaceId,
        ...actor,
        memberId,
        displayName: "Renamed",
        now: LATER,
      }),
      { renamed: false, refusal },
      label,
    );
  }
  const renamed = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.displayName, "Renamed"));
  assert.deepEqual(renamed, [], "a refusal renames nobody");
  assert.deepEqual(await auditOf(workspaceId), [], "and audits nothing");
});

test("removing an unclaimed person sets removed_at and removed_by_user_id and revokes its live invitation with member_removed", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const { workspaceId } = await workspaceOf(owner);
  await addPerson(workspaceId, owner, { claimedBy: admin, role: "admin" });
  const invited = await addPerson(workspaceId, owner);
  const other = await addPerson(workspaceId, owner);
  const plain = await addPerson(workspaceId, owner);
  const earlier = await invite(workspaceId, invited, owner, {
    revokedAt: NOW,
    revokedByUserId: owner.userId,
  });
  const live = await invite(workspaceId, invited, owner);
  const othersInvitation = await invite(workspaceId, other, owner);

  const removed = await removeMember(db, {
    workspaceId,
    ...admin,
    memberId: invited,
    now: LATER,
  });
  assert.deepEqual(removed, { removed: true, revokedInvitationId: live });
  const row = await person(invited);
  assert.deepEqual(row.removedAt, LATER);
  assert.equal(row.removedByUserId, admin.userId);
  assert.deepEqual(row.updatedAt, LATER);
  assert.equal(row.userId, null, "the person stays unclaimed");

  const invitations = new Map(
    (
      await db
        .select()
        .from(workspaceInvitations)
        .where(
          inArray(workspaceInvitations.id, [earlier, live, othersInvitation]),
        )
    ).map((invitation) => [invitation.id, invitation]),
  );
  assert.deepEqual(invitations.get(live)?.revokedAt, LATER);
  assert.equal(invitations.get(live)?.revokedByUserId, admin.userId);
  assert.deepEqual(
    invitations.get(earlier)?.revokedAt,
    NOW,
    "an earlier revocation stays",
  );
  assert.equal(invitations.get(earlier)?.revokedByUserId, owner.userId);
  assert.equal(invitations.get(othersInvitation)?.revokedAt, null);

  // A person without an invitation is removed alone.
  assert.deepEqual(
    await removeMember(db, {
      workspaceId,
      ...owner,
      memberId: plain,
      now: LATER,
    }),
    { removed: true, revokedInvitationId: null },
  );

  assert.deepEqual(await auditOf(workspaceId), [
    {
      action: "member.removed",
      actorUserId: admin.userId,
      actorDeviceId: admin.deviceId,
      subjectId: invited,
      reason: null,
      createdAt: LATER,
    },
    {
      action: "invitation.revoked",
      actorUserId: admin.userId,
      actorDeviceId: admin.deviceId,
      subjectId: live,
      reason: "member_removed",
      createdAt: LATER,
    },
    {
      action: "member.removed",
      actorUserId: owner.userId,
      actorDeviceId: owner.deviceId,
      subjectId: plain,
      reason: null,
      createdAt: LATER,
    },
  ]);
});

test("a member cannot remove a person, and a claimed or removed person is a conflict", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const member = await account("Member");
  const outsider = await account("Outsider");
  const { workspaceId, ownerPerson } = await workspaceOf(owner);
  const adminPerson = await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
  });
  const memberPerson = await addPerson(workspaceId, owner, {
    claimedBy: member,
  });
  const unclaimed = await addPerson(workspaceId, owner);
  const invitation = await invite(workspaceId, unclaimed, owner);
  const removedUnclaimed = await addPerson(workspaceId, owner, {
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const elsewhere = await addPerson(
    (await workspaceOf(outsider)).workspaceId,
    outsider,
  );

  for (const [label, actor, memberId, refusal] of [
    ["a member, an unclaimed person", member, unclaimed, "forbidden"],
    ["a member, themselves", member, memberPerson, "forbidden"],
    // Removing claimed people comes with #93.
    ["the owner, a claimed member", owner, memberPerson, "conflict"],
    ["the owner, an admin", owner, adminPerson, "conflict"],
    ["an admin, a claimed member", admin, memberPerson, "conflict"],
    ["the owner, themselves", owner, ownerPerson, "conflict"],
    ["the owner, a removed person", owner, removedUnclaimed, "conflict"],
    ["the owner, another workspace's person", owner, elsewhere, "not_found"],
    ["the owner, an unknown person", owner, newId<MemberId>(), "not_found"],
    ["an outsider", outsider, unclaimed, "not_member"],
  ] as const) {
    assert.deepEqual(
      await removeMember(db, { workspaceId, ...actor, memberId, now: LATER }),
      { removed: false, refusal },
      label,
    );
  }
  const active = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      inArray(workspaceMembers.id, [
        ownerPerson,
        adminPerson,
        memberPerson,
        unclaimed,
      ]),
    );
  assert.equal(active.length, 4);
  for (const { id } of active) {
    assert.equal(
      (await person(id)).removedAt,
      null,
      "a refusal removes nobody",
    );
  }
  const [live] = await db
    .select({ revokedAt: workspaceInvitations.revokedAt })
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, invitation));
  assert.equal(live?.revokedAt, null, "nor revokes an invitation");
  assert.deepEqual(await auditOf(workspaceId), [], "and audits nothing");
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

/**
 * Starts `action` while a second session holds `change` uncommitted, lets the
 * change commit once the action waits for a lock, and returns the action's
 * result. An action that does not lock what the change holds decides on the
 * state before the change.
 */
async function afterConcurrentChange<T>(
  change: (tx: Database) => Promise<unknown>,
  action: () => Promise<T>,
): Promise<T> {
  const url = testDatabase?.url;
  assert.ok(url, "the test database is on a server");
  const other = createDatabase(url, { max: 1 });
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const changing = other.db.transaction(async (tx) => {
    await change(tx);
    holding.resolve();
    await release.promise;
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
    release.resolve();
    await changing;
    return await result;
  } finally {
    release.resolve();
    await changing.catch(() => undefined);
    await other.close();
  }
}

test(
  "a removal waits for a concurrent claim of the person and then answers conflict",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const claimer = await account("Claimer");
    const { workspaceId } = await workspaceOf(owner);
    const unclaimed = await addPerson(workspaceId, owner);
    // As accepting an invitation claims the person.
    const removal = await afterConcurrentChange(
      (tx) =>
        tx
          .update(workspaceMembers)
          .set({ userId: claimer.userId, claimedAt: NOW })
          .where(eq(workspaceMembers.id, unclaimed)),
      () =>
        removeMember(database(), {
          workspaceId,
          ...owner,
          memberId: unclaimed,
          now: LATER,
        }),
    );
    assert.deepEqual(removal, { removed: false, refusal: "conflict" });
    const row = await person(unclaimed);
    assert.equal(row.userId, claimer.userId);
    assert.equal(row.removedAt, null);
  },
);

test(
  "an admin demoted while their definition waits is refused with forbidden",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const admin = await account("Admin");
    const { workspaceId } = await workspaceOf(owner);
    const adminPerson = await addPerson(workspaceId, owner, {
      claimedBy: admin,
      role: "admin",
    });
    // As a demotion (#93) changes the admin's own person.
    const definition = await afterConcurrentChange(
      (tx) =>
        tx
          .update(workspaceMembers)
          .set({ role: "member" })
          .where(eq(workspaceMembers.id, adminPerson)),
      () =>
        defineMember(database(), {
          workspaceId,
          ...admin,
          displayName: "Linus",
          now: LATER,
        }),
    );
    assert.deepEqual(definition, { defined: false, refusal: "forbidden" });
    const defined = await database()
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.addedByUserId, admin.userId));
    assert.deepEqual(defined, []);
  },
);

test(
  "an admin removed while their removal of a person waits is refused as no longer a member",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const admin = await account("Admin");
    const { workspaceId } = await workspaceOf(owner);
    const adminPerson = await addPerson(workspaceId, owner, {
      claimedBy: admin,
      role: "admin",
    });
    const unclaimed = await addPerson(workspaceId, owner);
    const removal = await afterConcurrentChange(
      (tx) =>
        tx
          .update(workspaceMembers)
          .set({ removedAt: NOW, removedByUserId: owner.userId })
          .where(eq(workspaceMembers.id, adminPerson)),
      () =>
        removeMember(database(), {
          workspaceId,
          ...admin,
          memberId: unclaimed,
          now: LATER,
        }),
    );
    assert.deepEqual(removal, { removed: false, refusal: "not_member" });
    assert.equal((await person(unclaimed)).removedAt, null);
  },
);
