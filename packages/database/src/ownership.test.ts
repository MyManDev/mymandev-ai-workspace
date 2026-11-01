import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type DeviceId,
  type MemberId,
  newId,
  newUuidV7,
  type UserId,
  type WorkspaceId,
  WorkspaceViewResponseSchema,
} from "@mymandev/protocol";
import { and, eq, isNull } from "drizzle-orm";
import { createDatabase } from "./client.ts";
import type { Database } from "./db.ts";
import { DatabaseError, withDatabaseErrors } from "./errors.ts";
import {
  createWorkspace,
  OWNERSHIP_OFFER_LIFETIME_MS,
  workspaceView,
} from "./membership.ts";
import {
  acceptOwnershipOffer,
  type AcceptOwnershipOfferResult,
  offerOwnership,
  type OfferOwnershipResult,
  withdrawOwnershipOffer,
} from "./ownership.ts";
import {
  demoteMember,
  DEVICE_TOO_NEW_MS,
  leaveWorkspace,
  promoteMember,
  removeMember,
} from "./people.ts";
import {
  auditEvents,
  devices,
  userIdentities,
  users,
  workspaceMembers,
} from "./schema/index.ts";
import { createTestDatabase } from "./testing.ts";

// Ownership offers, their acceptance, and their withdrawal (ADR 0014,
// "People and roles", "Removal and ownership", and "Lifetimes"; #93).

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
const NOW = new Date("2026-11-01T12:00:00.000Z");
const LATER = new Date("2026-11-01T13:00:00.000Z");
/** The moment at which an offer made at `LATER` stops being an offer. */
const EXPIRY = new Date(LATER.getTime() + OWNERSHIP_OFFER_LIFETIME_MS);

type Account = Readonly<{ userId: UserId; deviceId: DeviceId }>;

let nextSubject = 2000;

/**
 * An account with a GitHub identity and one device, registered 30 days
 * before `NOW`, so old enough to offer.
 */
async function account(name: string): Promise<Account> {
  const db = database();
  const userId = newId<UserId>();
  await db.insert(users).values({ id: userId, displayName: name });
  nextSubject += 1;
  await db.insert(userIdentities).values({
    id: newUuidV7(),
    userId,
    identityProvider: "github",
    subject: String(nextSubject),
    login: `user-${nextSubject}`,
    accountCreatedAt: new Date("2015-06-01T10:00:00.000Z"),
    lastSignInAt: NOW,
  });
  const deviceId = newId<DeviceId>();
  await db.insert(devices).values({
    id: deviceId,
    userId,
    label: "Laptop",
    platform: "linux",
    publicKey: randomBytes(32).toString("hex"),
    keyAlgorithm: "ed25519",
    createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
    lastSignInAt: NOW,
  });
  return { userId, deviceId };
}

/** Another device of the account, registered `age` before `LATER`. */
async function deviceOf(owner: Account, age: number): Promise<DeviceId> {
  const deviceId = newId<DeviceId>();
  await database()
    .insert(devices)
    .values({
      id: deviceId,
      userId: owner.userId,
      label: "Desktop",
      platform: "linux",
      publicKey: randomBytes(32).toString("hex"),
      keyAlgorithm: "ed25519",
      createdAt: new Date(LATER.getTime() - age),
      lastSignInAt: NOW,
    });
  return deviceId;
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

async function person(id: MemberId) {
  const [row] = await database()
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.id, id));
  assert.ok(row !== undefined);
  return row;
}

/** The person that holds the workspace's offer, with the time it was made, or undefined. */
async function offerOf(workspaceId: WorkspaceId) {
  const rows = await database()
    .select({
      id: workspaceMembers.id,
      offeredAt: workspaceMembers.ownershipOfferedAt,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  const offered = rows.filter((row) => row.offeredAt !== null);
  assert.ok(offered.length <= 1, "at most one offer per workspace");
  return offered[0];
}

/** The active people of the workspace with the role `owner`. */
async function ownersOf(workspaceId: WorkspaceId) {
  const rows = await database()
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.role, "owner"),
        isNull(workspaceMembers.removedAt),
      ),
    );
  return rows.map((row) => row.id);
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

/** The view's offer at `now`, after the protocol's own checks of the view. */
async function viewOffer(workspaceId: WorkspaceId, now: Date) {
  const view = await workspaceView(database(), { workspaceId, now });
  assert.ok(view !== undefined);
  return WorkspaceViewResponseSchema.parse(view).ownershipOffer;
}

/** A workspace with an owner, an admin, and a member, each claimed. */
async function team() {
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
  return {
    owner,
    admin,
    member,
    workspaceId,
    ownerPerson,
    adminPerson,
    memberPerson,
  };
}

test("the owner offers ownership to a member or an admin; the offer is audited and shown in the view until 7 days after it was made", async () => {
  const db = database();
  const { owner, member, workspaceId, adminPerson, memberPerson } =
    await team();

  assert.deepEqual(
    await offerOwnership(db, {
      workspaceId,
      ...owner,
      memberId: memberPerson,
      now: LATER,
    }),
    {
      offered: true,
      offer: {
        memberId: memberPerson,
        offeredAt: LATER.toISOString(),
        expiresAt: EXPIRY.toISOString(),
      },
      userId: member.userId,
      ended: null,
    },
  );
  const row = await person(memberPerson);
  assert.deepEqual(row.ownershipOfferedAt, LATER);
  assert.deepEqual(row.updatedAt, LATER);
  assert.equal(row.role, "member", "an offer changes no role");
  const offer = {
    memberId: memberPerson,
    offeredAt: LATER.toISOString(),
    expiresAt: EXPIRY.toISOString(),
  };
  assert.deepEqual(await viewOffer(workspaceId, LATER), offer);
  assert.deepEqual(
    await viewOffer(workspaceId, new Date(EXPIRY.getTime() - 1)),
    offer,
  );
  assert.equal(await viewOffer(workspaceId, EXPIRY), null);

  assert.deepEqual(
    (await withdrawOwnershipOffer(db, { workspaceId, ...owner, now: LATER }))
      .withdrawn,
    true,
  );
  const toAdmin = await offerOwnership(db, {
    workspaceId,
    ...owner,
    memberId: adminPerson,
    now: LATER,
  });
  assert.ok(toAdmin.offered, JSON.stringify(toAdmin));
  assert.deepEqual((await offerOf(workspaceId))?.id, adminPerson);

  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => [
      record.action,
      record.actorUserId,
      record.actorDeviceId,
      record.subjectId,
      record.reason,
      record.createdAt,
    ]),
    [
      [
        "ownership.offered",
        owner.userId,
        owner.deviceId,
        memberPerson,
        null,
        LATER,
      ],
      [
        "ownership.offer_withdrawn",
        owner.userId,
        owner.deviceId,
        memberPerson,
        null,
        LATER,
      ],
      [
        "ownership.offered",
        owner.userId,
        owner.deviceId,
        adminPerson,
        null,
        LATER,
      ],
    ],
  );
});

test("only the owner offers, never to themselves, only to an active, claimed person, and from a device older than 72 hours; a refusal changes nothing", async () => {
  const db = database();
  const { owner, admin, member, workspaceId, ownerPerson, memberPerson } =
    await team();
  const outsider = await account("Outsider");
  const former = await account("Former");
  const unclaimed = await addPerson(workspaceId, owner);
  const formerPerson = await addPerson(workspaceId, owner, {
    claimedBy: former,
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const young = await deviceOf(owner, DEVICE_TOO_NEW_MS - 1);
  const exactly = await deviceOf(owner, DEVICE_TOO_NEW_MS);
  const oldEnough = await deviceOf(owner, DEVICE_TOO_NEW_MS + 1);
  const adminsYoung = await deviceOf(admin, DEVICE_TOO_NEW_MS - 1);

  for (const [label, actor, memberId, refusal] of [
    ["an admin offers", admin, memberPerson, "forbidden"],
    [
      "an admin offers from a young device",
      { ...admin, deviceId: adminsYoung },
      memberPerson,
      "forbidden",
    ],
    ["a member offers to themselves", member, memberPerson, "forbidden"],
    ["the owner offers to themselves", owner, ownerPerson, "forbidden"],
    [
      "the owner offers from a device younger than 72 hours",
      { ...owner, deviceId: young },
      memberPerson,
      "device_too_new",
    ],
    [
      "the owner offers from a device exactly 72 hours old",
      { ...owner, deviceId: exactly },
      memberPerson,
      "device_too_new",
    ],
    [
      "the owner offers from another account's device",
      { ...owner, deviceId: member.deviceId },
      memberPerson,
      "device_too_new",
    ],
    [
      "the device age is decided before the person's state",
      { ...owner, deviceId: young },
      unclaimed,
      "device_too_new",
    ],
    ["the owner offers to an unclaimed person", owner, unclaimed, "conflict"],
    ["the owner offers to a former member", owner, formerPerson, "conflict"],
    [
      "the owner offers to an unknown person",
      owner,
      newId<MemberId>(),
      "not_found",
    ],
    ["a former member offers", former, memberPerson, "not_member"],
    ["an outsider offers", outsider, memberPerson, "not_member"],
  ] as const) {
    assert.deepEqual(
      await offerOwnership(db, { workspaceId, ...actor, memberId, now: LATER }),
      { offered: false, refusal },
      label,
    );
  }
  assert.equal(await offerOf(workspaceId), undefined);
  assert.deepEqual(await auditOf(workspaceId), []);

  // A millisecond older than 72 hours is old enough.
  const offered = await offerOwnership(db, {
    workspaceId,
    ...owner,
    deviceId: oldEnough,
    memberId: memberPerson,
    now: LATER,
  });
  assert.ok(offered.offered, JSON.stringify(offered));
  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => record.actorDeviceId),
    [oldEnough],
  );
});

test("a workspace has one live offer: a second offer is a conflict, and the database refuses a second one too", async () => {
  const db = database();
  const { owner, workspaceId, adminPerson, memberPerson } = await team();
  const offer = (memberId: MemberId) =>
    offerOwnership(db, { workspaceId, ...owner, memberId, now: LATER });

  assert.ok((await offer(memberPerson)).offered);
  for (const memberId of [memberPerson, adminPerson]) {
    assert.deepEqual(await offer(memberId), {
      offered: false,
      refusal: "conflict",
    });
  }
  assert.deepEqual(await offerOf(workspaceId), {
    id: memberPerson,
    offeredAt: LATER,
  });

  await assert.rejects(
    withDatabaseErrors(() =>
      database()
        .update(workspaceMembers)
        .set({ ownershipOfferedAt: LATER })
        .where(eq(workspaceMembers.id, adminPerson)),
    ),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.code, "23505");
      assert.equal(error.constraint, "workspace_members_ownership_offer_key");
      return true;
    },
  );

  // Another workspace has its own offer.
  const other = await account("Other owner");
  const otherTeam = await workspaceOf(other);
  const otherPerson = await addPerson(otherTeam.workspaceId, other, {
    claimedBy: await account("Other member"),
  });
  const otherOffer = await offerOwnership(db, {
    workspaceId: otherTeam.workspaceId,
    ...other,
    memberId: otherPerson,
    now: LATER,
  });
  assert.ok(otherOffer.offered, JSON.stringify(otherOffer));
});

test("an offer 7 days old is no offer: a new offer clears it, reports it as expired at its expiry, and audits only the new one", async () => {
  const db = database();
  const { owner, admin, member, workspaceId, adminPerson, memberPerson } =
    await team();
  assert.ok(
    (
      await offerOwnership(db, {
        workspaceId,
        ...owner,
        memberId: memberPerson,
        now: LATER,
      })
    ).offered,
  );
  const justBefore = new Date(EXPIRY.getTime() - 1);
  assert.deepEqual(
    await offerOwnership(db, {
      workspaceId,
      ...owner,
      memberId: adminPerson,
      now: justBefore,
    }),
    { offered: false, refusal: "conflict" },
  );

  const later = new Date(EXPIRY.getTime() + DAY_MS);
  const replaced = await offerOwnership(db, {
    workspaceId,
    ...owner,
    memberId: adminPerson,
    now: later,
  });
  assert.deepEqual(replaced, {
    offered: true,
    offer: {
      memberId: adminPerson,
      offeredAt: later.toISOString(),
      expiresAt: new Date(
        later.getTime() + OWNERSHIP_OFFER_LIFETIME_MS,
      ).toISOString(),
    },
    userId: admin.userId,
    ended: {
      memberId: memberPerson,
      userId: member.userId,
      reason: "expired",
      endedAt: EXPIRY,
    },
  });
  const cleared = await person(memberPerson);
  assert.equal(cleared.ownershipOfferedAt, null);
  assert.deepEqual(cleared.updatedAt, later);
  assert.deepEqual(await offerOf(workspaceId), {
    id: adminPerson,
    offeredAt: later,
  });

  // An expired offer to the same person is replaced by a new one to it.
  const again = new Date(later.getTime() + OWNERSHIP_OFFER_LIFETIME_MS);
  const renewed = await offerOwnership(db, {
    workspaceId,
    ...owner,
    memberId: adminPerson,
    now: again,
  });
  assert.ok(renewed.offered, JSON.stringify(renewed));
  assert.deepEqual(renewed.ended, {
    memberId: adminPerson,
    userId: admin.userId,
    reason: "expired",
    endedAt: again,
  });
  assert.deepEqual(await offerOf(workspaceId), {
    id: adminPerson,
    offeredAt: again,
  });

  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => [
      record.action,
      record.subjectId,
    ]),
    [
      ["ownership.offered", memberPerson],
      ["ownership.offered", adminPerson],
      ["ownership.offered", adminPerson],
    ],
  );
});

test("the target accepts from any device: the owner becomes an admin and the target the owner in one transaction, the offer ends, and the transfer is audited", async () => {
  const db = database();
  const { owner, member, workspaceId, ownerPerson, memberPerson } =
    await team();
  assert.ok(
    (
      await offerOwnership(db, {
        workspaceId,
        ...owner,
        memberId: memberPerson,
        now: NOW,
      })
    ).offered,
  );
  // An acceptance needs no device age.
  const young = await deviceOf(member, 0);
  const justBefore = new Date(NOW.getTime() + OWNERSHIP_OFFER_LIFETIME_MS - 1);
  assert.deepEqual(
    await acceptOwnershipOffer(db, {
      workspaceId,
      ...member,
      deviceId: young,
      now: justBefore,
    }),
    {
      accepted: true,
      previousOwnerMemberId: ownerPerson,
      ownerMemberId: memberPerson,
    },
  );

  const previous = await person(ownerPerson);
  const next = await person(memberPerson);
  assert.equal(previous.role, "admin");
  assert.equal(next.role, "owner");
  assert.deepEqual(previous.updatedAt, justBefore);
  assert.deepEqual(next.updatedAt, justBefore);
  assert.equal(next.ownershipOfferedAt, null);
  assert.equal(await offerOf(workspaceId), undefined);
  assert.deepEqual(await ownersOf(workspaceId), [memberPerson]);
  const view = await workspaceView(db, { workspaceId, now: justBefore });
  assert.ok(view !== undefined);
  assert.equal(WorkspaceViewResponseSchema.parse(view).ownershipOffer, null);
  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => [
      record.action,
      record.actorUserId,
      record.actorDeviceId,
      record.subjectId,
    ]),
    [
      ["ownership.offered", owner.userId, owner.deviceId, memberPerson],
      ["ownership.transferred", member.userId, young, memberPerson],
    ],
  );

  // The new owner cannot be removed, and the CHECK still holds; the former
  // owner, an admin now, can be.
  await assert.rejects(
    withDatabaseErrors(() =>
      database()
        .update(workspaceMembers)
        .set({ removedAt: LATER, removedByUserId: owner.userId })
        .where(eq(workspaceMembers.id, memberPerson)),
    ),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.constraint, "workspace_members_owner_removal_check");
      return true;
    },
  );
  assert.deepEqual(
    await removeMember(db, {
      workspaceId,
      ...owner,
      memberId: memberPerson,
      now: justBefore,
    }),
    { removed: false, refusal: "forbidden" },
  );
  assert.deepEqual(
    await leaveWorkspace(db, { workspaceId, ...member, now: justBefore }),
    { left: false, refusal: "forbidden" },
    "the new owner cannot leave",
  );
  const removed = await removeMember(db, {
    workspaceId,
    ...member,
    memberId: ownerPerson,
    now: justBefore,
  });
  assert.ok(removed.removed, JSON.stringify(removed));
  assert.deepEqual(await ownersOf(workspaceId), [memberPerson]);
});

test("only the target accepts a live offer: the owner and everyone else are forbidden, and without a live offer it is a conflict", async () => {
  const db = database();
  const { owner, admin, member, workspaceId, ownerPerson, memberPerson } =
    await team();
  const outsider = await account("Outsider");
  const accept = (actor: Account, now: Date = LATER) =>
    acceptOwnershipOffer(db, { workspaceId, ...actor, now });
  const refused = (
    refusal: "not_member" | "forbidden" | "conflict",
  ): unknown => ({ accepted: false, refusal, ended: null });

  assert.deepEqual(await accept(member), refused("conflict"), "no offer");
  assert.deepEqual(await accept(owner), refused("forbidden"), "no offer");

  assert.ok(
    (
      await offerOwnership(db, {
        workspaceId,
        ...owner,
        memberId: memberPerson,
        now: LATER,
      })
    ).offered,
  );
  for (const [label, actor, refusal] of [
    ["the owner", owner, "forbidden"],
    ["an admin who is not the target", admin, "forbidden"],
    ["an outsider", outsider, "not_member"],
  ] as const) {
    assert.deepEqual(await accept(actor), refused(refusal), label);
  }
  assert.deepEqual(await offerOf(workspaceId), {
    id: memberPerson,
    offeredAt: LATER,
  });

  // A withdrawn offer cannot be accepted.
  assert.ok(
    (await withdrawOwnershipOffer(db, { workspaceId, ...owner, now: LATER }))
      .withdrawn,
  );
  assert.deepEqual(await accept(member), refused("conflict"), "withdrawn");
  assert.deepEqual(await ownersOf(workspaceId), [ownerPerson]);
  assert.equal((await person(memberPerson)).role, "member");
  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => record.action),
    ["ownership.offered", "ownership.offer_withdrawn"],
  );
});

test("an accept of an offer 7 days old is a conflict: another person's leaves it, and the target's clears it and reports it as expired", async () => {
  const db = database();
  const { owner, admin, member, workspaceId, ownerPerson, memberPerson } =
    await team();
  assert.ok(
    (
      await offerOwnership(db, {
        workspaceId,
        ...owner,
        memberId: memberPerson,
        now: LATER,
      })
    ).offered,
  );

  assert.deepEqual(
    await acceptOwnershipOffer(db, { workspaceId, ...admin, now: EXPIRY }),
    { accepted: false, refusal: "conflict", ended: null },
  );
  assert.deepEqual(await offerOf(workspaceId), {
    id: memberPerson,
    offeredAt: LATER,
  });

  const later = new Date(EXPIRY.getTime() + DAY_MS);
  assert.deepEqual(
    await acceptOwnershipOffer(db, { workspaceId, ...member, now: later }),
    {
      accepted: false,
      refusal: "conflict",
      ended: {
        memberId: memberPerson,
        userId: member.userId,
        reason: "expired",
        endedAt: EXPIRY,
      },
    },
  );
  const row = await person(memberPerson);
  assert.equal(row.ownershipOfferedAt, null);
  assert.equal(row.role, "member");
  assert.deepEqual(row.updatedAt, later);
  assert.deepEqual(await ownersOf(workspaceId), [ownerPerson]);
  // Clearing an expired offer writes no audit record.
  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => record.action),
    ["ownership.offered"],
  );
  assert.deepEqual(
    await acceptOwnershipOffer(db, { workspaceId, ...member, now: later }),
    { accepted: false, refusal: "conflict", ended: null },
    "the offer is gone",
  );
});

test("the owner withdraws a live offer from any device; anyone else is forbidden, and without a live offer it is a conflict that clears an expired one", async () => {
  const db = database();
  const { owner, admin, member, workspaceId, memberPerson } = await team();
  const outsider = await account("Outsider");
  const withdraw = (actor: Account, now: Date = LATER) =>
    withdrawOwnershipOffer(db, { workspaceId, ...actor, now });

  assert.deepEqual(await withdraw(owner), {
    withdrawn: false,
    refusal: "conflict",
    ended: null,
  });
  const offer = async (now: Date) =>
    assert.ok(
      (
        await offerOwnership(db, {
          workspaceId,
          ...owner,
          memberId: memberPerson,
          now,
        })
      ).offered,
    );
  await offer(LATER);
  for (const [label, actor, refusal] of [
    ["the target", member, "forbidden"],
    ["an admin", admin, "forbidden"],
    ["an outsider", outsider, "not_member"],
  ] as const) {
    assert.deepEqual(
      await withdraw(actor),
      { withdrawn: false, refusal, ended: null },
      label,
    );
  }
  assert.equal((await offerOf(workspaceId))?.id, memberPerson);

  // A withdrawal needs no device age.
  const young = await deviceOf(owner, 0);
  assert.deepEqual(await withdraw({ ...owner, deviceId: young }), {
    withdrawn: true,
    ended: {
      memberId: memberPerson,
      userId: member.userId,
      reason: "withdrawn",
      endedAt: LATER,
    },
  });
  assert.equal(await offerOf(workspaceId), undefined);
  assert.deepEqual((await person(memberPerson)).updatedAt, LATER);
  assert.deepEqual(await withdraw(owner), {
    withdrawn: false,
    refusal: "conflict",
    ended: null,
  });

  await offer(LATER);
  assert.deepEqual(await withdraw(owner, EXPIRY), {
    withdrawn: false,
    refusal: "conflict",
    ended: {
      memberId: memberPerson,
      userId: member.userId,
      reason: "expired",
      endedAt: EXPIRY,
    },
  });
  assert.equal(await offerOf(workspaceId), undefined);
  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => [
      record.action,
      record.actorDeviceId,
      record.subjectId,
    ]),
    [
      ["ownership.offered", owner.deviceId, memberPerson],
      ["ownership.offer_withdrawn", young, memberPerson],
      ["ownership.offered", owner.deviceId, memberPerson],
    ],
  );
});

test("removing the target or the target's departure ends the offer, and a demotion of the target keeps it", async () => {
  const db = database();
  const { owner, admin, member, workspaceId, adminPerson, memberPerson } =
    await team();
  const offerTo = async (memberId: MemberId) => {
    const result = await offerOwnership(db, {
      workspaceId,
      ...owner,
      memberId,
      now: LATER,
    });
    assert.ok(result.offered, JSON.stringify(result));
  };

  // The ADR allows an offer to a member, so a demoted admin keeps it.
  await offerTo(adminPerson);
  const demoted = await demoteMember(db, {
    workspaceId,
    ...owner,
    memberId: adminPerson,
    now: LATER,
  });
  assert.ok(demoted.demoted, JSON.stringify(demoted));
  assert.equal((await viewOffer(workspaceId, LATER))?.memberId, adminPerson);

  const left = await leaveWorkspace(db, { workspaceId, ...admin, now: LATER });
  assert.ok(left.left, JSON.stringify(left));
  assert.equal(await offerOf(workspaceId), undefined);
  assert.equal(await viewOffer(workspaceId, LATER), null);
  assert.deepEqual(
    await acceptOwnershipOffer(db, { workspaceId, ...admin, now: LATER }),
    { accepted: false, refusal: "not_member", ended: null },
  );

  await offerTo(memberPerson);
  const removed = await removeMember(db, {
    workspaceId,
    ...owner,
    memberId: memberPerson,
    now: LATER,
  });
  assert.ok(removed.removed, JSON.stringify(removed));
  assert.equal(await offerOf(workspaceId), undefined);
  assert.deepEqual(
    await acceptOwnershipOffer(db, { workspaceId, ...member, now: LATER }),
    { accepted: false, refusal: "not_member", ended: null },
  );
});

test("inside a transaction that rolls back, an acceptance leaves nothing behind", async () => {
  const db = database();
  const { owner, member, workspaceId, ownerPerson, memberPerson } =
    await team();
  assert.ok(
    (
      await offerOwnership(db, {
        workspaceId,
        ...owner,
        memberId: memberPerson,
        now: LATER,
      })
    ).offered,
  );
  const rollback = new Error("rollback");
  await assert.rejects(
    db.transaction(async (tx) => {
      const result = await acceptOwnershipOffer(tx, {
        workspaceId,
        ...member,
        now: LATER,
      });
      assert.ok(result.accepted);
      throw rollback;
    }),
    rollback,
  );
  assert.deepEqual(await ownersOf(workspaceId), [ownerPerson]);
  assert.deepEqual(await offerOf(workspaceId), {
    id: memberPerson,
    offeredAt: LATER,
  });
  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => record.action),
    ["ownership.offered"],
  );
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

/** A team whose owner offered ownership to the member at `NOW`. */
async function offeredTeam() {
  const people = await team();
  const offered = await offerOwnership(database(), {
    workspaceId: people.workspaceId,
    ...people.owner,
    memberId: people.memberPerson,
    now: NOW,
  });
  assert.ok(offered.offered, JSON.stringify(offered));
  return people;
}

test(
  "an acceptance waits for a concurrent withdrawal and is then a conflict",
  SERVER_ONLY,
  async () => {
    const { owner, member, workspaceId, ownerPerson, memberPerson } =
      await offeredTeam();
    const accepted = await afterConcurrentChange(
      (tx) => withdrawOwnershipOffer(tx, { workspaceId, ...owner, now: NOW }),
      () =>
        acceptOwnershipOffer(database(), {
          workspaceId,
          ...member,
          now: LATER,
        }),
    );
    assert.deepEqual(accepted, {
      accepted: false,
      refusal: "conflict",
      ended: null,
    });
    assert.deepEqual(await ownersOf(workspaceId), [ownerPerson]);
    assert.equal((await person(memberPerson)).role, "member");
    assert.equal(await offerOf(workspaceId), undefined);
  },
);

test(
  "a withdrawal waits for a concurrent acceptance and is then forbidden, because the former owner is an admin",
  SERVER_ONLY,
  async () => {
    const { owner, member, workspaceId, ownerPerson, memberPerson } =
      await offeredTeam();
    const withdrawn = await afterConcurrentChange(
      (tx) => acceptOwnershipOffer(tx, { workspaceId, ...member, now: NOW }),
      () =>
        withdrawOwnershipOffer(database(), {
          workspaceId,
          ...owner,
          now: LATER,
        }),
    );
    assert.deepEqual(withdrawn, {
      withdrawn: false,
      refusal: "forbidden",
      ended: null,
    });
    assert.deepEqual(await ownersOf(workspaceId), [memberPerson]);
    assert.equal((await person(ownerPerson)).role, "admin");
    assert.deepEqual(
      (await auditOf(workspaceId)).map((record) => record.action),
      ["ownership.offered", "ownership.transferred"],
    );
  },
);

test(
  "an acceptance waits for a concurrent removal of the target, who is then no member",
  SERVER_ONLY,
  async () => {
    const { admin, member, workspaceId, ownerPerson, memberPerson } =
      await offeredTeam();
    // An admin removes the member, under the locks of the two of them only.
    const accepted = await afterConcurrentChange(
      (tx) =>
        removeMember(tx, {
          workspaceId,
          ...admin,
          memberId: memberPerson,
          now: NOW,
        }),
      () =>
        acceptOwnershipOffer(database(), {
          workspaceId,
          ...member,
          now: LATER,
        }),
    );
    assert.deepEqual(accepted, {
      accepted: false,
      refusal: "not_member",
      ended: null,
    });
    assert.deepEqual(await ownersOf(workspaceId), [ownerPerson]);
    const row = await person(memberPerson);
    assert.deepEqual(row.removedAt, NOW);
    assert.equal(row.ownershipOfferedAt, null);
    assert.equal(row.role, "member");
    assert.equal((await person(ownerPerson)).role, "owner");
    assert.deepEqual(
      (await auditOf(workspaceId)).map((record) => record.action),
      ["ownership.offered", "member.removed"],
    );
  },
);

test(
  "a removal of the target by the owner or an admin waits for a concurrent acceptance and is then forbidden, so the new owner stays",
  SERVER_ONLY,
  async () => {
    for (const remover of ["owner", "admin"] as const) {
      const people = await offeredTeam();
      const { workspaceId, ownerPerson, memberPerson } = people;
      const removal = await afterConcurrentChange(
        (tx) =>
          acceptOwnershipOffer(tx, { workspaceId, ...people.member, now: NOW }),
        () =>
          removeMember(database(), {
            workspaceId,
            ...people[remover],
            memberId: memberPerson,
            now: LATER,
          }),
      );
      assert.deepEqual(
        removal,
        { removed: false, refusal: "forbidden" },
        remover,
      );
      assert.deepEqual(await ownersOf(workspaceId), [memberPerson]);
      assert.equal((await person(ownerPerson)).role, "admin");
      assert.equal((await person(memberPerson)).removedAt, null);
    }
  },
);

test(
  "an offer waits for a concurrent offer to another person from the owner's other device and is then a conflict",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, adminPerson, memberPerson } = await team();
    const desktop = await deviceOf(owner, 30 * DAY_MS);
    const offered = await afterConcurrentChange(
      (tx) =>
        offerOwnership(tx, {
          workspaceId,
          ...owner,
          deviceId: desktop,
          memberId: memberPerson,
          now: NOW,
        }),
      () =>
        offerOwnership(database(), {
          workspaceId,
          ...owner,
          memberId: adminPerson,
          now: LATER,
        }),
    );
    assert.deepEqual(offered, { offered: false, refusal: "conflict" });
    assert.deepEqual(await offerOf(workspaceId), {
      id: memberPerson,
      offeredAt: NOW,
    });
  },
);

test(
  "a withdrawal waits for a concurrent offer from the owner's other device and is then a conflict, as if it came first; the offer stays",
  SERVER_ONLY,
  async () => {
    const { owner, member, workspaceId, memberPerson } = await team();
    const desktop = await deviceOf(owner, 30 * DAY_MS);
    const withdrawn = await afterConcurrentChange(
      (tx) =>
        offerOwnership(tx, {
          workspaceId,
          ...owner,
          deviceId: desktop,
          memberId: memberPerson,
          now: NOW,
        }),
      () =>
        withdrawOwnershipOffer(database(), {
          workspaceId,
          ...owner,
          now: LATER,
        }),
    );
    assert.deepEqual(withdrawn, {
      withdrawn: false,
      refusal: "conflict",
      ended: null,
    });
    assert.deepEqual(await offerOf(workspaceId), {
      id: memberPerson,
      offeredAt: NOW,
    });
    // The next withdrawal finds it.
    const again = await withdrawOwnershipOffer(database(), {
      workspaceId,
      ...owner,
      now: LATER,
    });
    assert.deepEqual(again, {
      withdrawn: true,
      ended: {
        memberId: memberPerson,
        userId: member.userId,
        reason: "withdrawn",
        endedAt: LATER,
      },
    });
  },
);

test(
  "an acceptance waits for a concurrent demotion or promotion of the target, which keeps the offer, and then transfers",
  SERVER_ONLY,
  async () => {
    for (const change of ["demote", "promote"] as const) {
      const people = await team();
      const { owner, workspaceId, ownerPerson } = people;
      // The admin is demoted, or the member promoted, while the target.
      const target = change === "demote" ? people.admin : people.member;
      const targetPerson =
        change === "demote" ? people.adminPerson : people.memberPerson;
      const offered = await offerOwnership(database(), {
        workspaceId,
        ...owner,
        memberId: targetPerson,
        now: NOW,
      });
      assert.ok(offered.offered, JSON.stringify(offered));
      const roleChange = { workspaceId, ...owner, memberId: targetPerson };
      const accepted = await afterConcurrentChange(
        (tx) =>
          change === "demote"
            ? demoteMember(tx, { ...roleChange, now: NOW })
            : promoteMember(tx, { ...roleChange, now: NOW }),
        () =>
          acceptOwnershipOffer(database(), {
            workspaceId,
            ...target,
            now: LATER,
          }),
      );
      assert.deepEqual(
        accepted,
        {
          accepted: true,
          previousOwnerMemberId: ownerPerson,
          ownerMemberId: targetPerson,
        },
        change,
      );
      assert.deepEqual(await ownersOf(workspaceId), [targetPerson]);
      assert.equal((await person(ownerPerson)).role, "admin");
      assert.deepEqual(
        (await auditOf(workspaceId)).map((record) => record.action),
        [
          "ownership.offered",
          change === "demote" ? "member.demoted" : "member.promoted",
          "ownership.transferred",
        ],
      );
    }
  },
);

test(
  "a demotion or a promotion of the target waits for a concurrent acceptance and is then forbidden, because the former owner is an admin",
  SERVER_ONLY,
  async () => {
    for (const change of ["demote", "promote"] as const) {
      const people = await team();
      const { owner, workspaceId, ownerPerson } = people;
      const target = change === "demote" ? people.admin : people.member;
      const targetPerson =
        change === "demote" ? people.adminPerson : people.memberPerson;
      const offered = await offerOwnership(database(), {
        workspaceId,
        ...owner,
        memberId: targetPerson,
        now: NOW,
      });
      assert.ok(offered.offered, JSON.stringify(offered));
      const roleChange = {
        workspaceId,
        ...owner,
        memberId: targetPerson,
        now: LATER,
      };
      const refused = await afterConcurrentChange(
        (tx) => acceptOwnershipOffer(tx, { workspaceId, ...target, now: NOW }),
        async (): Promise<unknown> =>
          change === "demote"
            ? demoteMember(database(), roleChange)
            : promoteMember(database(), roleChange),
      );
      assert.deepEqual(
        refused,
        change === "demote"
          ? { demoted: false, refusal: "forbidden" }
          : { promoted: false, refusal: "forbidden" },
        change,
      );
      assert.deepEqual(await ownersOf(workspaceId), [targetPerson]);
      assert.equal((await person(ownerPerson)).role, "admin");
    }
  },
);

test(
  "of two acceptances from two of the target's devices, one transfers and the other waits and is then forbidden",
  SERVER_ONLY,
  async () => {
    const { owner, member, workspaceId, ownerPerson, memberPerson } =
      await offeredTeam();
    const desktop = await deviceOf(member, 0);
    let first: unknown;
    const second = await afterConcurrentChange(
      async (tx) => {
        first = await acceptOwnershipOffer(tx, {
          workspaceId,
          ...member,
          deviceId: desktop,
          now: NOW,
        });
      },
      () =>
        acceptOwnershipOffer(database(), {
          workspaceId,
          ...member,
          now: LATER,
        }),
    );
    assert.deepEqual(first, {
      accepted: true,
      previousOwnerMemberId: ownerPerson,
      ownerMemberId: memberPerson,
    });
    assert.deepEqual(second, {
      accepted: false,
      refusal: "forbidden",
      ended: null,
    });
    assert.deepEqual(await ownersOf(workspaceId), [memberPerson]);
    assert.equal((await person(ownerPerson)).role, "admin");
    assert.deepEqual(
      (await auditOf(workspaceId)).map((record) => [
        record.action,
        record.actorDeviceId,
      ]),
      [
        ["ownership.offered", owner.deviceId],
        ["ownership.transferred", desktop],
      ],
    );
  },
);

test(
  "an acceptance of an expired offer and a new offer that clears it wait for each other, and exactly one of them reports it as expired",
  SERVER_ONLY,
  async () => {
    for (const first of ["offer", "accept"] as const) {
      const people = await team();
      const { owner, member, workspaceId, ownerPerson } = people;
      const { adminPerson, memberPerson } = people;
      // Made 8 days before `NOW`, so expired at `NOW`.
      const madeAt = new Date(NOW.getTime() - 8 * DAY_MS);
      const old = await offerOwnership(database(), {
        workspaceId,
        ...owner,
        memberId: memberPerson,
        now: madeAt,
      });
      assert.ok(old.offered, JSON.stringify(old));
      const expired = {
        memberId: memberPerson,
        userId: member.userId,
        reason: "expired",
        endedAt: new Date(madeAt.getTime() + OWNERSHIP_OFFER_LIFETIME_MS),
      };
      let offered: OfferOwnershipResult | undefined;
      let accepted: AcceptOwnershipOfferResult | undefined;
      const runOffer = async (db: Database, now: Date) => {
        offered = await offerOwnership(db, {
          workspaceId,
          ...owner,
          memberId: adminPerson,
          now,
        });
      };
      const runAccept = async (db: Database, now: Date) => {
        accepted = await acceptOwnershipOffer(db, {
          workspaceId,
          ...member,
          now,
        });
      };
      await afterConcurrentChange(
        (tx) => (first === "offer" ? runOffer(tx, NOW) : runAccept(tx, NOW)),
        () =>
          first === "offer"
            ? runAccept(database(), LATER)
            : runOffer(database(), LATER),
      );
      assert.ok(offered?.offered === true, JSON.stringify(offered));
      assert.ok(accepted?.accepted === false, JSON.stringify(accepted));
      assert.equal(accepted.refusal, "conflict", first);
      assert.deepEqual(
        [offered.ended, accepted.ended].filter((ended) => ended !== null),
        [expired],
        first,
      );
      assert.deepEqual(await ownersOf(workspaceId), [ownerPerson]);
      assert.equal((await offerOf(workspaceId))?.id, adminPerson);
    }
  },
);
