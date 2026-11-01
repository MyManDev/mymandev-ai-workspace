import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type DeviceId,
  newId,
  newUuidV7,
  type UserId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import { createDatabase } from "./client.ts";
import { deviceRow } from "./connections.ts";
import type { Database } from "./db.ts";
import { recordGitHubRevocation, requireSignIn } from "./github-revocation.ts";
import { auditEvents, devices, userIdentities, users } from "./schema/index.ts";
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

const EARLIER = new Date("2026-10-29T12:00:00.000Z");
const NOW = new Date("2026-10-30T12:00:00.000Z");
const LATER = new Date("2026-10-31T12:00:00.000Z");

/** An account with a GitHub identity, one active and one revoked device. */
async function seed(subject: string, login: string = `user-${subject}`) {
  const db = database();
  const userId = newId<UserId>();
  await db
    .insert(users)
    .values({ id: userId, displayName: "Alice", updatedAt: EARLIER });
  await db.insert(userIdentities).values({
    id: newUuidV7(),
    userId,
    identityProvider: "github",
    subject,
    login,
    accountCreatedAt: EARLIER,
    lastSignInAt: EARLIER,
  });
  const device = () => ({
    id: newId<DeviceId>(),
    userId,
    label: "Laptop",
    platform: "linux" as const,
    publicKey: randomBytes(32).toString("hex"),
    keyAlgorithm: "ed25519" as const,
    lastSignInAt: EARLIER,
  });
  const active = device();
  const revoked = {
    ...device(),
    revokedAt: EARLIER,
    revocationReason: "removed" as const,
  };
  await db.insert(devices).values([active, revoked]);
  return { userId, activeDevice: active.id, revokedDevice: revoked.id };
}

async function userOf(userId: UserId) {
  const [row] = await database()
    .select()
    .from(users)
    .where(eq(users.id, userId));
  assert.ok(row);
  return row;
}

function auditsOf(deliveryId: string) {
  return database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.githubDeliveryId, deliveryId));
}

test("a revocation sets sign_in_required_at, keeps the devices, and writes one audit record with the delivery ID", async () => {
  const db = database();
  const alice = await seed("1001");
  const bob = await seed("1002");
  const deliveryId = randomUUID();

  assert.deepEqual(
    await recordGitHubRevocation(db, { subject: "1001", deliveryId, now: NOW }),
    { changed: true, userId: alice.userId, deviceIds: [alice.activeDevice] },
  );
  const user = await userOf(alice.userId);
  assert.deepEqual(user.signInRequiredAt, NOW);
  assert.deepEqual(user.updatedAt, NOW);
  assert.equal((await userOf(bob.userId)).signInRequiredAt, null);
  const rows = await db
    .select({ revokedAt: devices.revokedAt, signedOutAt: devices.signedOutAt })
    .from(devices)
    .where(eq(devices.userId, alice.userId));
  assert.deepEqual(
    rows.map((row) => row.signedOutAt),
    [null, null],
  );
  assert.equal(rows.filter((row) => row.revokedAt === null).length, 1);

  const audits = await auditsOf(deliveryId);
  assert.equal(audits.length, 1);
  assert.deepEqual(
    {
      action: audits[0]?.action,
      actorUserId: audits[0]?.actorUserId,
      actorDeviceId: audits[0]?.actorDeviceId,
      workspaceId: audits[0]?.workspaceId,
      subjectId: audits[0]?.subjectId,
      reason: audits[0]?.reason,
      createdAt: audits[0]?.createdAt,
    },
    {
      action: "github.authorization_revoked",
      actorUserId: null,
      actorDeviceId: null,
      workspaceId: null,
      subjectId: alice.userId,
      reason: null,
      createdAt: NOW,
    },
  );
});

test("a delivery ID that was already recorded changes nothing", async () => {
  const db = database();
  const alice = await seed("1003");
  const deliveryId = randomUUID();
  await recordGitHubRevocation(db, { subject: "1003", deliveryId, now: NOW });

  assert.deepEqual(
    await recordGitHubRevocation(db, {
      subject: "1003",
      deliveryId,
      now: LATER,
    }),
    { changed: false, userId: null, deviceIds: [] },
  );
  assert.deepEqual((await userOf(alice.userId)).signInRequiredAt, NOW);
  assert.equal((await auditsOf(deliveryId)).length, 1);
});

test("two concurrent deliveries with the same ID change the account once", async () => {
  const db = database();
  const alice = await seed("1009");
  const deliveryId = randomUUID();
  const results = await Promise.all([
    recordGitHubRevocation(db, { subject: "1009", deliveryId, now: NOW }),
    recordGitHubRevocation(db, { subject: "1009", deliveryId, now: NOW }),
  ]);
  assert.deepEqual(results.map((result) => result.changed).sort(), [
    false,
    true,
  ]);
  assert.equal(results.find((result) => result.changed)?.userId, alice.userId);
  assert.equal((await auditsOf(deliveryId)).length, 1);
  assert.deepEqual((await userOf(alice.userId)).signInRequiredAt, NOW);
});

test("sign_in_required_at never moves backward", async () => {
  const db = database();
  const alice = await seed("1004");
  await recordGitHubRevocation(db, {
    subject: "1004",
    deliveryId: randomUUID(),
    now: NOW,
  });
  const earlier = await recordGitHubRevocation(db, {
    subject: "1004",
    deliveryId: randomUUID(),
    now: EARLIER,
  });
  assert.equal(earlier.changed, true);
  assert.deepEqual((await userOf(alice.userId)).signInRequiredAt, NOW);
  await recordGitHubRevocation(db, {
    subject: "1004",
    deliveryId: randomUUID(),
    now: LATER,
  });
  assert.deepEqual((await userOf(alice.userId)).signInRequiredAt, LATER);
});

test("a device whose sign-in committed before the revocation must sign in again, also when its last sign-in is later than the revocation's time", async () => {
  const db = database();
  const alice = await seed("1010");
  // The race of #115: the sign-in's request took its time 3 ms after the
  // webhook's, but its transaction committed first. A revoked device's
  // sign-in does not count.
  const signedIn = new Date(NOW.getTime() + 3);
  await db
    .update(devices)
    .set({ lastSignInAt: signedIn })
    .where(eq(devices.id, alice.activeDevice));
  await db
    .update(devices)
    .set({ lastSignInAt: LATER })
    .where(eq(devices.id, alice.revokedDevice));

  await recordGitHubRevocation(db, {
    subject: "1010",
    deliveryId: randomUUID(),
    now: NOW,
  });
  const row = await deviceRow(db, alice.activeDevice);
  assert.ok(row?.signInRequiredAt);
  assert.ok(
    row.signInRequiredAt > row.lastSignInAt,
    "the device must sign in again",
  );
  assert.deepEqual(row.signInRequiredAt, new Date(signedIn.getTime() + 1));
  assert.deepEqual((await userOf(alice.userId)).updatedAt, NOW);
});

test("a last sign-in in the future moves sign_in_required_at at most 60 seconds past the revocation's time", async () => {
  const db = database();
  const alice = await seed("1012");
  // After a jump of the clock, a device's last sign-in lies a day ahead.
  await db
    .update(devices)
    .set({ lastSignInAt: new Date(NOW.getTime() + 24 * 60 * 60_000) })
    .where(eq(devices.id, alice.activeDevice));
  await recordGitHubRevocation(db, {
    subject: "1012",
    deliveryId: randomUUID(),
    now: NOW,
  });
  assert.deepEqual(
    (await userOf(alice.userId)).signInRequiredAt,
    new Date(NOW.getTime() + 60_000),
  );
});

test("requireSignIn requires the account's devices to sign in again as a revocation does, without an audit record", async () => {
  const db = database();
  const alice = await seed("1013");
  const signedIn = new Date(NOW.getTime() + 3);
  await db
    .update(devices)
    .set({ lastSignInAt: signedIn })
    .where(eq(devices.id, alice.activeDevice));

  assert.deepEqual(
    await requireSignIn(db, { userId: alice.userId, now: NOW }),
    [alice.activeDevice],
  );
  const user = await userOf(alice.userId);
  assert.deepEqual(user.signInRequiredAt, new Date(signedIn.getTime() + 1));
  assert.deepEqual(user.updatedAt, NOW);
  const audits = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.subjectId, alice.userId));
  assert.equal(audits.length, 0);

  // Like a revocation, it never moves the time backward.
  await requireSignIn(db, { userId: alice.userId, now: EARLIER });
  assert.deepEqual(
    (await userOf(alice.userId)).signInRequiredAt,
    new Date(signedIn.getTime() + 1),
  );
});

test(
  "a revocation waits for a sign-in that holds the account's row, then requires that sign-in's device to sign in again",
  {
    skip:
      process.env["DATABASE_TEST_URL"] === undefined &&
      "needs DATABASE_TEST_URL; PGlite has a single session",
  },
  async () => {
    const url = testDatabase?.url;
    assert.ok(url, "the test database is on a server");
    const alice = await seed("1011");
    // A second session holds the row as a sign-in does, and its device's
    // last sign-in is 3 ms later than the revocation's time.
    const other = createDatabase(url, { max: 1 });
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const signIn = other.db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, alice.userId))
        .for("no key update");
      holding.resolve();
      await release.promise;
      await tx
        .update(devices)
        .set({ lastSignInAt: new Date(NOW.getTime() + 3) })
        .where(eq(devices.id, alice.activeDevice));
    });
    let revocation: Promise<unknown> | undefined;
    try {
      await Promise.race([holding.promise, signIn]);
      revocation = recordGitHubRevocation(database(), {
        subject: "1011",
        deliveryId: randomUUID(),
        now: NOW,
      });
      const outcome = await Promise.race([
        revocation.then(() => "returned"),
        delay(500, "waited", { ref: false }),
      ]);
      assert.equal(outcome, "waited");
      release.resolve();
      await signIn;
      await revocation;
      const row = await deviceRow(database(), alice.activeDevice);
      assert.ok(row?.signInRequiredAt);
      assert.ok(
        row.signInRequiredAt > row.lastSignInAt,
        "the device must sign in again",
      );
    } finally {
      // Settling quietly keeps the first failure as the test's error.
      release.resolve();
      await signIn.catch(() => undefined);
      await revocation?.catch(() => undefined);
      await other.close();
    }
  },
);

test("the account is matched by the GitHub ID, never by the login", async () => {
  const db = database();
  const alice = await seed("1005", "1006");
  const result = await recordGitHubRevocation(db, {
    subject: "1006",
    deliveryId: randomUUID(),
    now: NOW,
  });
  assert.equal(result.userId, null);
  assert.equal((await userOf(alice.userId)).signInRequiredAt, null);
});

test("a sender without an account, or with an erased identity, gets one audit record without a person", async () => {
  const db = database();
  const deliveryId = randomUUID();
  assert.deepEqual(
    await recordGitHubRevocation(db, { subject: "1007", deliveryId, now: NOW }),
    { changed: true, userId: null, deviceIds: [] },
  );
  assert.deepEqual(
    await recordGitHubRevocation(db, {
      subject: "1007",
      deliveryId,
      now: LATER,
    }),
    { changed: false, userId: null, deviceIds: [] },
  );
  const audits = await auditsOf(deliveryId);
  assert.deepEqual(
    audits.map((row) => [
      row.action,
      row.actorUserId,
      row.actorDeviceId,
      row.subjectId,
    ]),
    [["github.authorization_revoked", null, null, null]],
  );

  // Erasing clears the subject, so the former GitHub ID matches nothing.
  const erased = await seed("1008");
  await db
    .update(userIdentities)
    .set({ subject: null, login: null, accountCreatedAt: null, erasedAt: NOW })
    .where(eq(userIdentities.userId, erased.userId));
  const result = await recordGitHubRevocation(db, {
    subject: "1008",
    deliveryId: randomUUID(),
    now: NOW,
  });
  assert.deepEqual(result, { changed: true, userId: null, deviceIds: [] });
  assert.equal((await userOf(erased.userId)).signInRequiredAt, null);
});
