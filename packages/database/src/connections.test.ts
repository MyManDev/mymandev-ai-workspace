import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  type DeviceId,
  type EventId,
  type MemberId,
  newId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import { createDatabase } from "./client.ts";
import { migrationsFolder } from "./migrate.ts";
import {
  activePeopleOf,
  deviceRow,
  deviceRows,
  isActiveMember,
  markDeviceAuthenticated,
  markDeviceSeen,
  markDevicesSeen,
  writeConnectionAudit,
} from "./connections.ts";
import type { Database } from "./db.ts";
import { DatabaseError } from "./errors.ts";
import {
  auditEvents,
  devices,
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

const NOW = new Date("2026-10-31T12:00:00.000Z");
const LATER = new Date("2026-10-31T12:05:00.000Z");

async function user(name: string): Promise<UserId> {
  const id = newId<UserId>();
  await database().insert(users).values({ id, displayName: name });
  return id;
}

async function device(userId: UserId): Promise<DeviceId> {
  const id = newId<DeviceId>();
  await database()
    .insert(devices)
    .values({
      id,
      userId,
      label: "Laptop",
      platform: "linux",
      publicKey: randomBytes(32).toString("hex"),
      keyAlgorithm: "ed25519",
      lastSignInAt: NOW,
    });
  return id;
}

test("only a claimed person whose removed_at is empty makes an active member", async () => {
  const db = database();
  const owner = await user("Owner");
  const removed = await user("Removed");
  const outsider = await user("Outsider");
  const workspace = newId<WorkspaceId>();
  const other = newId<WorkspaceId>();
  await db.insert(workspaces).values([
    { id: workspace, name: "Team", createdByUserId: owner },
    { id: other, name: "Other", createdByUserId: outsider },
  ]);
  await db.insert(workspaceMembers).values([
    {
      id: newId<MemberId>(),
      workspaceId: workspace,
      userId: owner,
      displayName: "Owner",
      role: "owner",
      addedByUserId: owner,
      claimedAt: NOW,
    },
    {
      id: newId<MemberId>(),
      workspaceId: workspace,
      userId: removed,
      displayName: "Removed",
      role: "member",
      addedByUserId: owner,
      claimedAt: NOW,
      removedAt: LATER,
      removedByUserId: owner,
    },
    // An unclaimed person matches no account.
    {
      id: newId<MemberId>(),
      workspaceId: workspace,
      displayName: "Unclaimed",
      role: "member",
      addedByUserId: owner,
    },
    {
      id: newId<MemberId>(),
      workspaceId: other,
      userId: outsider,
      displayName: "Outsider",
      role: "owner",
      addedByUserId: outsider,
      claimedAt: NOW,
    },
  ]);

  const cases: [label: string, workspaceId: WorkspaceId, userId: UserId][] = [
    ["the owner", workspace, owner],
    ["a removed person", workspace, removed],
    ["a member of another workspace", workspace, outsider],
    ["a workspace that does not exist", newId<WorkspaceId>(), owner],
    ["the other workspace's owner", other, outsider],
  ];
  const expected = [true, false, false, false, true];
  for (const [index, [label, workspaceId, userId]] of cases.entries()) {
    assert.equal(
      await isActiveMember(db, { workspaceId, userId }),
      expected[index],
      label,
    );
  }

  // Rejoining after a removal creates a new, active person.
  await db.insert(workspaceMembers).values({
    id: newId<MemberId>(),
    workspaceId: workspace,
    userId: removed,
    displayName: "Back",
    role: "member",
    addedByUserId: owner,
    claimedAt: LATER,
  });
  assert.equal(
    await isActiveMember(db, { workspaceId: workspace, userId: removed }),
    true,
  );
});

test("activePeopleOf finds the active person of each workspace and account pair, in slices of 500 pairs", async () => {
  const db = database();
  const owner = await user("People owner");
  const member = await user("People member");
  const removed = await user("People removed");
  const workspace = newId<WorkspaceId>();
  const other = newId<WorkspaceId>();
  await db.insert(workspaces).values([
    { id: workspace, name: "Team", createdByUserId: owner },
    { id: other, name: "Other", createdByUserId: member },
  ]);
  const person = async (
    workspaceId: WorkspaceId,
    userId: UserId | null,
    fields: Partial<typeof workspaceMembers.$inferInsert> = {},
  ): Promise<MemberId> => {
    const id = newId<MemberId>();
    await db.insert(workspaceMembers).values({
      id,
      workspaceId,
      userId,
      displayName: "Person",
      role: "member",
      addedByUserId: owner,
      claimedAt: userId === null ? null : NOW,
      ...fields,
    });
    return id;
  };
  const ownerPerson = await person(workspace, owner, { role: "owner" });
  const memberPerson = await person(workspace, member);
  await person(workspace, removed, {
    removedAt: LATER,
    removedByUserId: owner,
  });
  await person(workspace, null);
  const otherOwner = await person(other, member, { role: "owner" });

  // Unknown pairs fill the slices; the known ones sit at the start of each.
  const pairs = Array.from({ length: 1_001 }, () => ({
    workspaceId: newId<WorkspaceId>(),
    userId: newId<UserId>(),
  }));
  pairs[0] = { workspaceId: workspace, userId: owner };
  pairs[500] = { workspaceId: workspace, userId: removed };
  pairs[1_000] = { workspaceId: other, userId: member };
  pairs.push({ workspaceId: workspace, userId: member });
  // Another workspace's account is not this workspace's member.
  pairs.push({ workspaceId: other, userId: owner });

  const people = await activePeopleOf(db, pairs);
  assert.deepEqual([...people.keys()].sort(), [workspace, other].sort());
  assert.deepEqual(
    new Map(people.get(workspace)),
    new Map([
      [owner, ownerPerson],
      [member, memberPerson],
    ]),
  );
  assert.deepEqual(new Map(people.get(other)), new Map([[member, otherOwner]]));
  assert.equal((await activePeopleOf(db, [])).size, 0);
});

test("markDeviceSeen sets last_seen_at of that device only", async () => {
  const db = database();
  const owner = await user("Seen");
  const seen = await device(owner);
  const unseen = await device(owner);
  await markDeviceSeen(db, { deviceId: seen, now: LATER });
  const rows = await db
    .select({ id: devices.id, lastSeenAt: devices.lastSeenAt })
    .from(devices)
    .where(eq(devices.userId, owner));
  assert.deepEqual(
    new Map(rows.map((row) => [row.id, row.lastSeenAt?.getTime() ?? null])),
    new Map([
      [seen, LATER.getTime()],
      [unseen, null],
    ]),
  );
  // An unknown device changes nothing and does not fail.
  await markDeviceSeen(db, { deviceId: newId<DeviceId>(), now: LATER });
});

test("the first WebSocket authentication or access token sets first_authenticated_at once (#153)", async () => {
  const db = database();
  const owner = await user("First authenticated");
  const viaSocket = await device(owner);
  const viaToken = await device(owner);
  const never = await device(owner);
  const first = async () =>
    new Map(
      (
        await db
          .select({
            id: devices.id,
            at: devices.firstAuthenticatedAt,
          })
          .from(devices)
          .where(eq(devices.userId, owner))
      ).map((row) => [row.id, row.at?.getTime() ?? null]),
    );
  assert.deepEqual(
    await first(),
    new Map([
      [viaSocket, null],
      [viaToken, null],
      [never, null],
    ]),
    "a new device never authenticated",
  );
  await markDeviceSeen(db, { deviceId: viaSocket, now: NOW });
  await markDeviceAuthenticated(db, { deviceId: viaToken, now: NOW });
  // Later authentications keep the first time.
  await markDeviceSeen(db, { deviceId: viaSocket, now: LATER });
  await markDeviceAuthenticated(db, { deviceId: viaToken, now: LATER });
  await markDeviceSeen(db, { deviceId: viaToken, now: LATER });
  assert.deepEqual(
    await first(),
    new Map([
      [viaSocket, NOW.getTime()],
      [viaToken, NOW.getTime()],
      [never, null],
    ]),
  );
  await markDeviceAuthenticated(db, {
    deviceId: newId<DeviceId>(),
    now: LATER,
  });
});

test("the migration device_first_authenticated counts every device that existed before it as authenticated at its creation (#153)", async () => {
  const client = await PGlite.create();
  try {
    const journal = JSON.parse(
      readFileSync(joinPath(migrationsFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const tags = journal.entries.map((entry) => entry.tag);
    // Found by its name, so that a new number does not change the test.
    const next = tags.findIndex((tag) =>
      /^\d{4}_device_first_authenticated$/u.test(tag),
    );
    assert.ok(next > 0);
    const apply = async (tag: string) => {
      const text = readFileSync(
        joinPath(migrationsFolder, `${tag}.sql`),
        "utf8",
      );
      for (const statement of text.split("--> statement-breakpoint")) {
        if (statement.trim() !== "") {
          await client.exec(statement);
        }
      }
    };
    for (const tag of tags.slice(0, next)) {
      await apply(tag);
    }
    const userId = newId<UserId>();
    const deviceId = newId<DeviceId>();
    const createdAt = "2026-10-01T00:00:00.000Z";
    await client.query(
      "insert into users (id, display_name) values ($1, 'Before')",
      [userId],
    );
    await client.query(
      `insert into devices (id, user_id, label, platform, public_key, key_algorithm, created_at, last_sign_in_at)
       values ($1, $2, 'Laptop', 'linux', $3, 'ed25519', $4, $4)`,
      [deviceId, userId, randomBytes(32).toString("hex"), createdAt],
    );
    for (const tag of tags.slice(next)) {
      await apply(tag);
    }
    const { rows } = await client.query<{ at: Date | null }>(
      'select first_authenticated_at as "at" from devices where id = $1',
      [deviceId],
    );
    // No record says whether it was used, so it never repeats its
    // registration.
    assert.equal(rows[0]?.at?.toISOString(), createdAt);
  } finally {
    await client.close();
  }
});

/** 1,001 IDs that do not exist, with `known` at the start of each slice of 500. */
function idsAround(known: readonly DeviceId[]): DeviceId[] {
  const ids = Array.from({ length: 1_001 }, () => newId<DeviceId>());
  for (const [index, id] of known.entries()) {
    ids[index * 500] = id;
  }
  return ids;
}

test("deviceRow and deviceRows read a device with its key and its account's state; deviceRows reads them in slices of 500 IDs", async () => {
  const db = database();
  const owner = await user("Rows");
  const first = await device(owner);
  const second = await device(owner);
  const third = await device(owner);
  const other = await user("Other");
  const othersDevice = await device(other);
  await db
    .update(users)
    .set({ disabledAt: LATER, signInRequiredAt: NOW })
    .where(eq(users.id, owner));
  await db
    .update(devices)
    .set({ revokedAt: LATER, revocationReason: "removed", signedOutAt: NOW })
    .where(eq(devices.id, second));
  const keyOf = async (id: DeviceId) =>
    (
      await db
        .select({ publicKey: devices.publicKey })
        .from(devices)
        .where(eq(devices.id, id))
    )[0]?.publicKey;
  const expected = {
    userId: owner,
    publicKey: await keyOf(first),
    revokedAt: null,
    signedOutAt: null,
    lastSignInAt: NOW,
    disabledAt: LATER,
    signInRequiredAt: NOW,
  };
  assert.deepEqual(await deviceRow(db, first), expected);
  assert.deepEqual(await deviceRow(db, second), {
    ...expected,
    publicKey: await keyOf(second),
    revokedAt: LATER,
    signedOutAt: NOW,
  });
  assert.equal(await deviceRow(db, newId<DeviceId>()), undefined);

  const rows = await deviceRows(db, idsAround([first, second, third]));
  assert.deepEqual(
    [...rows.keys()].sort(),
    [first, second, third].sort(),
    "every slice is read; unknown devices are missing",
  );
  for (const id of [first, second, third]) {
    assert.deepEqual(rows.get(id), await deviceRow(db, id));
  }
  assert.equal(
    (await deviceRows(db, [othersDevice])).get(othersDevice)?.userId,
    other,
  );
  assert.equal((await deviceRows(db, [])).size, 0);
});

test("markDevicesSeen sets last_seen_at of the given devices that are not revoked, in slices of 500 IDs", async () => {
  const db = database();
  const owner = await user("Many");
  const first = await device(owner);
  const second = await device(owner);
  const revoked = await device(owner);
  const unseen = await device(owner);
  // Revoked after the sweep read it: the write leaves it unchanged.
  await db
    .update(devices)
    .set({ revokedAt: NOW, revocationReason: "removed", updatedAt: NOW })
    .where(eq(devices.id, revoked));
  await markDevicesSeen(db, {
    deviceIds: idsAround([first, second, revoked]),
    now: LATER,
  });
  const rows = await db
    .select({
      id: devices.id,
      lastSeenAt: devices.lastSeenAt,
      updatedAt: devices.updatedAt,
    })
    .from(devices)
    .where(eq(devices.userId, owner));
  assert.deepEqual(
    new Map(rows.map((row) => [row.id, row.lastSeenAt?.getTime() ?? null])),
    new Map([
      [first, LATER.getTime()],
      [second, LATER.getTime()],
      [revoked, null],
      [unseen, null],
    ]),
  );
  assert.deepEqual(
    new Map(
      rows
        .filter((row) => row.id !== unseen)
        .map((row) => [row.id, row.updatedAt.getTime()]),
    ),
    new Map([
      [first, LATER.getTime()],
      [second, LATER.getTime()],
      [revoked, NOW.getTime()],
    ]),
  );
  // No IDs change nothing and do not fail.
  await markDevicesSeen(db, { deviceIds: [], now: LATER });
});

test(
  "markDevicesSeen does not wait for a device row that another transaction holds and leaves that row unchanged",
  {
    skip:
      process.env["DATABASE_TEST_URL"] === undefined &&
      "needs DATABASE_TEST_URL; PGlite has a single session",
  },
  async () => {
    const url = testDatabase?.url;
    assert.ok(url, "the test database is on a server");
    const owner = await user("Locked");
    const locked = await device(owner);
    const free = await device(owner);
    // A second session holds the row as a sign-in or a revocation does.
    const other = createDatabase(url, { max: 1 });
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transaction = other.db.transaction(async (tx) => {
      await tx
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.id, locked))
        .for("no key update");
      holding.resolve();
      await release.promise;
    });
    try {
      await Promise.race([holding.promise, transaction]);
      const outcome = await Promise.race([
        markDevicesSeen(database(), {
          deviceIds: [locked, free],
          now: LATER,
        }).then(() => "returned"),
        delay(5_000, "waited", { ref: false }),
      ]);
      assert.equal(outcome, "returned");
      const rows = await database()
        .select({ id: devices.id, lastSeenAt: devices.lastSeenAt })
        .from(devices)
        .where(eq(devices.userId, owner));
      assert.deepEqual(
        new Map(rows.map((row) => [row.id, row.lastSeenAt?.getTime() ?? null])),
        new Map([
          [locked, null],
          [free, LATER.getTime()],
        ]),
      );
    } finally {
      release.resolve();
      await transaction;
      await other.close();
    }
  },
);

test("writeConnectionAudit records the connection's account and device and no workspace", async () => {
  const db = database();
  const owner = await user("Audited");
  const ownDevice = await device(owner);
  const eventId = newId<EventId>();
  await writeConnectionAudit(db, {
    action: "connection.replaced",
    userId: owner,
    deviceId: ownDevice,
    subjectId: ownDevice,
    now: NOW,
  });
  await writeConnectionAudit(db, {
    action: "event.identity_mismatch",
    userId: owner,
    deviceId: ownDevice,
    subjectId: eventId,
    now: LATER,
  });
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.actorUserId, owner));
  assert.deepEqual(
    rows
      .map((row) => ({
        action: row.action,
        actorDeviceId: row.actorDeviceId,
        workspaceId: row.workspaceId,
        subjectId: row.subjectId,
        reason: row.reason,
        createdAt: row.createdAt.getTime(),
      }))
      .sort((a, b) => a.createdAt - b.createdAt),
    [
      {
        action: "connection.replaced",
        actorDeviceId: ownDevice,
        workspaceId: null,
        subjectId: ownDevice,
        reason: null,
        createdAt: NOW.getTime(),
      },
      {
        action: "event.identity_mismatch",
        actorDeviceId: ownDevice,
        workspaceId: null,
        subjectId: eventId,
        reason: null,
        createdAt: LATER.getTime(),
      },
    ],
  );

  // The device must belong to the account; the error carries no query data.
  const stranger = await user("Stranger");
  await assert.rejects(
    writeConnectionAudit(db, {
      action: "connection.replaced",
      userId: stranger,
      deviceId: ownDevice,
      subjectId: ownDevice,
      now: NOW,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.code, "23503");
      assert.equal(error.message.includes(ownDevice), false);
      return true;
    },
  );
});
