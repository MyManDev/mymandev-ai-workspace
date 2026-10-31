import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  type DeviceId,
  type EventId,
  type MemberId,
  newId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import {
  isActiveMember,
  markDeviceSeen,
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
