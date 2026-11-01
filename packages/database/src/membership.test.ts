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
  WorkspaceListResponseSchema,
  WorkspaceMembershipSchema,
  WorkspaceViewResponseSchema,
} from "@mymandev/protocol";
import { and, eq } from "drizzle-orm";
import { createDatabase } from "./client.ts";
import type { Database } from "./db.ts";
import {
  activePersonOf,
  createWorkspace,
  type CreateWorkspaceResult,
  listWorkspaces,
  workspaceView,
} from "./membership.ts";
import {
  auditEvents,
  devices,
  userIdentities,
  users,
  workspaceMembers,
  workspaces,
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
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-11-01T12:00:00.000Z");
const SIGNED_IN = new Date("2026-10-28T09:30:00.000Z");

let nextSubject = 1000;

type Account = Readonly<{ userId: UserId; deviceId: DeviceId; login: string }>;

/** An account with a GitHub identity, last signed in at `SIGNED_IN`, and one device. */
async function account(login: string): Promise<Account> {
  const db = database();
  const userId = newId<UserId>();
  await db.insert(users).values({ id: userId, displayName: login });
  nextSubject += 1;
  await db.insert(userIdentities).values({
    id: newUuidV7(),
    userId,
    identityProvider: "github",
    subject: String(nextSubject),
    login,
    accountCreatedAt: new Date("2015-06-01T10:00:00.000Z"),
    lastSignInAt: SIGNED_IN,
  });
  const deviceId = newId<DeviceId>();
  await db.insert(devices).values({
    id: deviceId,
    userId,
    label: "Laptop",
    platform: "linux",
    publicKey: randomBytes(32).toString("hex"),
    keyAlgorithm: "ed25519",
    lastSignInAt: SIGNED_IN,
  });
  return { userId, deviceId, login };
}

async function create(
  creator: Account,
  now: Date,
  name = "Team",
): Promise<CreateWorkspaceResult> {
  return createWorkspace(database(), {
    userId: creator.userId,
    deviceId: creator.deviceId,
    name,
    displayName: "Ada at work",
    now,
  });
}

async function created(creator: Account, now: Date, name = "Team") {
  const result = await create(creator, now, name);
  assert.ok(result.created, "the workspace was created");
  return result.membership;
}

/** Adds a claimed person of `account` to the workspace. */
async function addClaimed(
  workspaceId: WorkspaceId,
  member: Account,
  values: Partial<typeof workspaceMembers.$inferInsert> = {},
): Promise<MemberId> {
  const id = newId<MemberId>();
  await database()
    .insert(workspaceMembers)
    .values({
      id,
      workspaceId,
      userId: member.userId,
      displayName: `${member.login} here`,
      role: "member",
      addedByUserId: member.userId,
      claimedAt: NOW,
      ...values,
    });
  return id;
}

test("creating a workspace makes the creator its claimed owner with the given name and audits it", async () => {
  const db = database();
  const ada = await account("ada");
  const membership = await created(ada, NOW, "Research");
  assert.deepEqual(WorkspaceMembershipSchema.parse(membership), membership);
  assert.equal(membership.workspace.name, "Research");
  assert.deepEqual(membership.member, {
    id: membership.member.id,
    workspaceId: membership.workspace.id,
    displayName: "Ada at work",
    role: "owner",
    userId: ada.userId,
    identity: {
      provider: "github",
      login: "ada",
      verifiedAt: SIGNED_IN.toISOString(),
    },
    removedAt: null,
  });

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, membership.workspace.id));
  assert.equal(workspace?.createdByUserId, ada.userId);
  assert.deepEqual(workspace?.createdAt, NOW);
  const [person] = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.id, membership.member.id));
  assert.equal(person?.addedByUserId, ada.userId);
  assert.deepEqual(person?.claimedAt, NOW);
  assert.deepEqual(person?.createdAt, NOW);

  const audit = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, membership.workspace.id));
  assert.deepEqual(
    audit.map((row) => ({
      action: row.action,
      actorUserId: row.actorUserId,
      actorDeviceId: row.actorDeviceId,
      subjectId: row.subjectId,
      createdAt: row.createdAt,
    })),
    [
      {
        action: "workspace.created",
        actorUserId: ada.userId,
        actorDeviceId: ada.deviceId,
        subjectId: membership.workspace.id,
        createdAt: NOW,
      },
    ],
  );
});

test("the 11th workspace within 24 hours is refused, and the window slides", async () => {
  const db = database();
  const grace = await account("grace");
  for (let hour = 0; hour < 10; hour += 1) {
    await created(grace, new Date(NOW.getTime() + hour * HOUR_MS));
  }
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  // The first workspace leaves the window 24 hours after NOW.
  assert.deepEqual(await create(grace, at(10 * HOUR_MS)), {
    created: false,
    retryAfterMs: 14 * HOUR_MS,
  });
  assert.deepEqual(await create(grace, at(DAY_MS - 1)), {
    created: false,
    retryAfterMs: 1,
  });
  const owned = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.createdByUserId, grace.userId));
  assert.equal(owned.length, 10, "a refusal creates nothing");
  const audited = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorUserId, grace.userId),
        eq(auditEvents.action, "workspace.created"),
      ),
    );
  assert.equal(audited.length, 10, "and audits nothing");

  await created(grace, at(DAY_MS));
  // Now the second, an hour younger, is the oldest in the window.
  assert.deepEqual(await create(grace, at(DAY_MS)), {
    created: false,
    retryAfterMs: HOUR_MS,
  });

  const other = await account("other");
  await created(other, at(DAY_MS));
});

test("the workspace list holds the account's active memberships, each with its own person", async () => {
  const db = database();
  const ada = await account("lister");
  const bob = await account("bob");
  const own = await created(ada, NOW, "Own");
  const shared = (await created(bob, NOW, "Shared")).workspace.id;
  const sharedPerson = await addClaimed(shared, ada, {
    claimedAt: new Date(NOW.getTime() + HOUR_MS),
  });
  const left = (await created(bob, NOW, "Left")).workspace.id;
  await addClaimed(left, ada, {
    removedAt: NOW,
    removedByUserId: bob.userId,
  });
  // An unclaimed person of Bob's workspace belongs to nobody.
  await db.insert(workspaceMembers).values({
    id: newId<MemberId>(),
    workspaceId: left,
    displayName: "Someone",
    role: "member",
    addedByUserId: bob.userId,
  });

  const list = await listWorkspaces(db, ada.userId);
  assert.deepEqual(WorkspaceListResponseSchema.parse({ workspaces: list }), {
    workspaces: list,
  });
  assert.deepEqual(
    list.map((item) => [item.workspace.name, item.member.id]),
    [
      ["Shared", sharedPerson],
      ["Own", own.member.id],
    ],
    "the most recently claimed first",
  );
  const [first] = list;
  assert.equal(first?.member.displayName, "lister here");
  assert.equal(first?.member.role, "member");
  assert.equal(first?.member.identity?.login, "lister");
  assert.deepEqual(await listWorkspaces(db, newId<UserId>()), []);
});

test("the workspace view shows every person, former ones as former, with the login verified at the last sign-in", async () => {
  const db = database();
  const owner = await account("viewer");
  const admin = await account("admin");
  const member = await account("member");
  const former = await account("former");
  const erased = await account("erased");
  const { workspace, member: ownerPerson } = await created(owner, NOW, "View");
  const unclaimed = newId<MemberId>();
  await db.insert(workspaceMembers).values({
    id: unclaimed,
    workspaceId: workspace.id,
    displayName: "Not yet here",
    role: "member",
    addedByUserId: owner.userId,
    createdAt: NOW,
  });
  const adminPerson = await addClaimed(workspace.id, admin, {
    role: "admin",
    createdAt: new Date(NOW.getTime() + 1),
  });
  // Older than the unclaimed person, but claimed people come first.
  const memberPerson = await addClaimed(workspace.id, member, {
    createdAt: new Date(NOW.getTime() - 1),
  });
  const formerPerson = await addClaimed(workspace.id, former, {
    removedAt: new Date(NOW.getTime() + HOUR_MS),
    removedByUserId: owner.userId,
  });
  const erasedPerson = await addClaimed(workspace.id, erased, {
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  // Erasure clears the identity (P-62).
  await db
    .update(userIdentities)
    .set({ subject: null, login: null, accountCreatedAt: null, erasedAt: NOW })
    .where(eq(userIdentities.userId, erased.userId));
  // A sign-in refreshes the login and its time.
  const refreshed = new Date("2026-10-31T08:00:00.000Z");
  await db
    .update(userIdentities)
    .set({ login: "admin-renamed", lastSignInAt: refreshed })
    .where(eq(userIdentities.userId, admin.userId));
  const paused = new Date("2026-10-30T10:00:00.000Z");
  await db
    .update(workspaces)
    .set({ joinRequestsPausedAt: paused })
    .where(eq(workspaces.id, workspace.id));
  const offered = new Date(NOW.getTime() - DAY_MS);
  await db
    .update(workspaceMembers)
    .set({ ownershipOfferedAt: offered })
    .where(eq(workspaceMembers.id, adminPerson));

  const view = await workspaceView(db, { workspaceId: workspace.id, now: NOW });
  assert.ok(view !== undefined);
  assert.deepEqual(WorkspaceViewResponseSchema.parse(view), view);
  assert.deepEqual(view.workspace, { id: workspace.id, name: "View" });
  assert.equal(view.joinRequestsPausedAt, paused.toISOString());
  assert.deepEqual(view.ownershipOffer, {
    memberId: adminPerson,
    offeredAt: offered.toISOString(),
    expiresAt: new Date(offered.getTime() + 7 * DAY_MS).toISOString(),
  });
  assert.deepEqual(
    view.members.map((member) => member.id),
    [
      ownerPerson.id,
      adminPerson,
      memberPerson,
      unclaimed,
      formerPerson,
      erasedPerson,
    ],
    "the owner, the offer's target, the other claimed people, the unclaimed people, then former members, the most recently removed first",
  );
  const byId = new Map(view.members.map((member) => [member.id, member]));
  assert.deepEqual(byId.get(ownerPerson.id), ownerPerson);
  assert.deepEqual(byId.get(adminPerson)?.identity, {
    provider: "github",
    login: "admin-renamed",
    verifiedAt: refreshed.toISOString(),
  });
  assert.deepEqual(byId.get(unclaimed), {
    id: unclaimed,
    workspaceId: workspace.id,
    displayName: "Not yet here",
    role: "member",
    userId: null,
    identity: null,
    removedAt: null,
  });
  assert.deepEqual(byId.get(formerPerson), {
    id: formerPerson,
    workspaceId: workspace.id,
    displayName: "former here",
    role: "member",
    userId: former.userId,
    identity: {
      provider: "github",
      login: "former",
      verifiedAt: SIGNED_IN.toISOString(),
    },
    removedAt: new Date(NOW.getTime() + HOUR_MS).toISOString(),
  });
  assert.equal(byId.get(erasedPerson)?.identity, null);
  assert.equal(byId.get(erasedPerson)?.userId, erased.userId);

  // 7 days after the offer, it is over and not shown.
  const expired = await workspaceView(db, {
    workspaceId: workspace.id,
    now: new Date(offered.getTime() + 7 * DAY_MS),
  });
  assert.equal(expired?.ownershipOffer, null);

  assert.equal(
    await workspaceView(db, { workspaceId: newId<WorkspaceId>(), now: NOW }),
    undefined,
  );
});

test("the active person is only the account's claimed person whose removed_at is empty", async () => {
  const db = database();
  const owner = await account("person-owner");
  const removed = await account("person-removed");
  const outsider = await account("person-outsider");
  const { workspace, member } = await created(owner, NOW);
  const removedPerson = await addClaimed(workspace.id, removed, {
    removedAt: NOW,
    removedByUserId: owner.userId,
  });

  assert.deepEqual(
    await activePersonOf(db, {
      workspaceId: workspace.id,
      userId: owner.userId,
    }),
    { id: member.id, role: "owner" },
  );
  for (const [label, workspaceId, userId] of [
    ["a removed person", workspace.id, removed.userId],
    ["an account without a person", workspace.id, outsider.userId],
    ["a workspace that does not exist", newId<WorkspaceId>(), owner.userId],
  ] as const) {
    assert.equal(
      await activePersonOf(db, { workspaceId, userId }),
      undefined,
      label,
    );
  }

  // Rejoining claims a new person; the earlier one stays former.
  const rejoined = await addClaimed(workspace.id, removed);
  assert.notEqual(rejoined, removedPerson);
  assert.deepEqual(
    await activePersonOf(db, {
      workspaceId: workspace.id,
      userId: removed.userId,
    }),
    { id: rejoined, role: "member" },
  );
});

test("the list and the view keep their most recent 1,000 items, the people that the view's rules name, and the claimed people before unclaimed ones", async () => {
  const db = database();
  const many = await account("many");
  const ids = Array.from({ length: 1_001 }, () => newId<WorkspaceId>());
  await db.insert(workspaces).values(
    ids.map((id) => ({
      id,
      name: "Many",
      createdByUserId: many.userId,
      createdAt: NOW,
    })),
  );
  await db.insert(workspaceMembers).values(
    ids.map((workspaceId, index) => ({
      id: newId<MemberId>(),
      workspaceId,
      userId: many.userId,
      displayName: "Many",
      role: "owner" as const,
      addedByUserId: many.userId,
      claimedAt: new Date(NOW.getTime() + index * 1_000),
    })),
  );
  const list = await listWorkspaces(db, many.userId);
  assert.equal(list.length, 1_000);
  WorkspaceListResponseSchema.parse({ workspaces: list });
  assert.equal(list[0]?.workspace.id, ids[1_000]);
  assert.equal(
    list.at(-1)?.workspace.id,
    ids[1],
    "the earliest claimed is cut",
  );

  // The owner, the offer's target, and a claimed member are older than every
  // unclaimed person, so only their place in the order keeps them: 1,000
  // unclaimed people never push a claimed one out.
  const crowded = await account("crowded");
  const target = await account("crowd-target");
  const claimed = await account("crowd-claimed");
  const former = await account("crowd-former");
  const { workspace, member: owner } = await created(
    crowded,
    new Date(NOW.getTime() - 3 * HOUR_MS),
    "Crowded",
  );
  const targetPerson = await addClaimed(workspace.id, target, {
    role: "admin",
    createdAt: new Date(NOW.getTime() - 2 * HOUR_MS),
    ownershipOfferedAt: NOW,
  });
  const claimedPerson = await addClaimed(workspace.id, claimed, {
    createdAt: new Date(NOW.getTime() - 2 * HOUR_MS + 1),
  });
  const unclaimed = Array.from({ length: 1_000 }, () => newId<MemberId>());
  await db.insert(workspaceMembers).values(
    unclaimed.map((id, index) => ({
      id,
      workspaceId: workspace.id,
      displayName: "Unclaimed",
      role: "member" as const,
      addedByUserId: crowded.userId,
      createdAt: new Date(NOW.getTime() - HOUR_MS + index),
    })),
  );
  const formerPerson = await addClaimed(workspace.id, former, {
    removedAt: NOW,
    removedByUserId: crowded.userId,
  });

  const view = await workspaceView(db, { workspaceId: workspace.id, now: NOW });
  assert.ok(view !== undefined);
  WorkspaceViewResponseSchema.parse(view);
  assert.equal(view.members.length, 1_000);
  assert.deepEqual(
    view.members.slice(0, 4).map((member) => member.id),
    [owner.id, targetPerson, claimedPerson, unclaimed[999]],
  );
  assert.equal(view.members.at(-1)?.id, unclaimed[3]);
  assert.equal(view.ownershipOffer?.memberId, targetPerson);
  const shown = new Set(view.members.map((member) => member.id));
  for (const cut of [unclaimed[0], unclaimed[1], unclaimed[2], formerPerson]) {
    assert.ok(cut !== undefined && !shown.has(cut));
  }
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
  "of three concurrent creations of an account's 10th workspace, exactly one succeeds",
  SERVER_ONLY,
  async () => {
    const db = database();
    const racer = await account("racer");
    for (let index = 0; index < 9; index += 1) {
      await created(racer, NOW);
    }
    const results = await Promise.all([
      create(racer, NOW),
      create(racer, NOW),
      create(racer, NOW),
    ]);
    assert.deepEqual(results.map((result) => result.created).sort(), [
      false,
      false,
      true,
    ]);
    const owned = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.createdByUserId, racer.userId));
    assert.equal(owned.length, 10);
  },
);

test(
  "a creation waits for the account's open creation and then counts it",
  SERVER_ONLY,
  async () => {
    const url = testDatabase?.url;
    assert.ok(url, "the test database is on a server");
    const holder = await account("holder");
    for (let index = 0; index < 9; index += 1) {
      await created(holder, NOW);
    }
    // A second session creates the 10th workspace and keeps its transaction open.
    const other = createDatabase(url, { max: 1 });
    const holding = Promise.withResolvers<CreateWorkspaceResult>();
    const release = Promise.withResolvers<void>();
    const first = other.db.transaction(async (tx) => {
      holding.resolve(
        await createWorkspace(tx, {
          userId: holder.userId,
          deviceId: holder.deviceId,
          name: "Tenth",
          displayName: "Ada",
          now: NOW,
        }),
      );
      await release.promise;
    });
    try {
      const tenth = await Promise.race([
        holding.promise,
        first.then(() => {
          throw new Error("the first transaction ended early");
        }),
      ]);
      assert.equal(tenth.created, true);
      const second = create(holder, NOW);
      let settled = false;
      second.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // Without the row lock the second creation would not wait: it would
      // count 9 and create an 11th workspace before the first one commits.
      while (!settled && !(await waitsForLock())) {
        await delay(10);
      }
      release.resolve();
      await first;
      assert.deepEqual(await second, { created: false, retryAfterMs: DAY_MS });
    } finally {
      release.resolve();
      await first.catch(() => undefined);
      await other.close();
    }
    const owned = await database()
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.createdByUserId, holder.userId));
    assert.equal(owned.length, 10);
  },
);
