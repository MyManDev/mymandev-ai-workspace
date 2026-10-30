import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  type AgentId,
  type DeviceId,
  type MemberId,
  newId,
  type PermissionGrantId,
  type ProjectId,
  type RepositoryId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import { disableAccount, enableAccount } from "./account-status.ts";
import type { Database } from "./db.ts";
import {
  agents,
  auditEvents,
  devices,
  permissionGrants,
  projects,
  repositories,
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

const NOW = new Date("2026-10-30T12:00:00.000Z");
const LATER = new Date("2026-10-31T12:00:00.000Z");

/** Alice and Bob in one workspace; each owns an agent with one active grant. */
async function seed() {
  const db = database();
  const alice = newId<UserId>();
  const bob = newId<UserId>();
  await db.insert(users).values([
    { id: alice, displayName: "Alice" },
    { id: bob, displayName: "Bob" },
  ]);
  const device = (userId: UserId) => ({
    id: newId<DeviceId>(),
    userId,
    label: "Laptop",
    platform: "linux" as const,
    publicKey: randomBytes(32).toString("hex"),
    keyAlgorithm: "ed25519" as const,
    lastSignInAt: NOW,
  });
  const aliceDevice = device(alice);
  const bobDevice = device(bob);
  await db.insert(devices).values([aliceDevice, bobDevice]);
  const workspace = newId<WorkspaceId>();
  await db
    .insert(workspaces)
    .values({ id: workspace, name: "Team", createdByUserId: alice });
  await db.insert(workspaceMembers).values([
    {
      id: newId<MemberId>(),
      workspaceId: workspace,
      userId: alice,
      displayName: "Alice",
      role: "owner",
      addedByUserId: alice,
      claimedAt: NOW,
    },
    {
      id: newId<MemberId>(),
      workspaceId: workspace,
      userId: bob,
      displayName: "Bob",
      role: "member",
      addedByUserId: alice,
      claimedAt: NOW,
    },
  ]);
  const project = newId<ProjectId>();
  await db.insert(projects).values({
    id: project,
    workspaceId: workspace,
    name: "App",
    createdByUserId: alice,
  });
  const repository = newId<RepositoryId>();
  await db.insert(repositories).values({
    id: repository,
    projectId: project,
    name: "app",
    createdByUserId: alice,
  });
  const aliceAgent = newId<AgentId>();
  const bobAgent = newId<AgentId>();
  await db.insert(agents).values([
    {
      id: aliceAgent,
      projectId: project,
      ownerUserId: alice,
      hostDeviceId: aliceDevice.id,
      name: "Builder",
    },
    {
      id: bobAgent,
      projectId: project,
      ownerUserId: bob,
      hostDeviceId: bobDevice.id,
      name: "Reviewer",
    },
  ]);
  const grant = async (
    agent: AgentId,
    hostDeviceId: DeviceId,
    grantedBy: UserId,
  ) => {
    const id = newId<PermissionGrantId>();
    await db.insert(permissionGrants).values({
      id,
      projectId: project,
      granteeAgentId: agent,
      hostDeviceId,
      grantedByUserId: grantedBy,
      capability: "repo.read",
      repositoryId: repository,
    });
    return id;
  };
  return {
    alice,
    bob,
    aliceGrant: await grant(aliceAgent, aliceDevice.id, alice),
    bobGrant: await grant(bobAgent, bobDevice.id, bob),
  };
}

test("disabling an account revokes its agents' grants in the same transaction and audits it", async () => {
  const db = database();
  const world = await seed();
  const result = await disableAccount(db, { userId: world.alice, now: NOW });
  assert.deepEqual(result, {
    changed: true,
    revokedGrantIds: [world.aliceGrant],
  });
  const [alice] = await db
    .select()
    .from(users)
    .where(eq(users.id, world.alice));
  assert.deepEqual(alice?.disabledAt, NOW);
  const [aliceGrant] = await db
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, world.aliceGrant));
  assert.deepEqual(aliceGrant?.revokedAt, NOW);
  assert.equal(aliceGrant?.revokedByUserId, world.alice);
  const [bobGrant] = await db
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, world.bobGrant));
  assert.equal(bobGrant?.revokedAt, null, "another account's grant stays");
  const audit = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.subjectId, world.alice));
  assert.deepEqual(
    audit.map((row) => [row.action, row.actorUserId]),
    [["account.disabled", null]],
  );

  assert.deepEqual(
    await disableAccount(db, { userId: world.alice, now: LATER }),
    { changed: false, revokedGrantIds: [] },
  );
  const [still] = await db
    .select()
    .from(users)
    .where(eq(users.id, world.alice));
  assert.deepEqual(still?.disabledAt, NOW, "the first time stays");
});

test("enabling an account restores no grant and audits it", async () => {
  const db = database();
  const world = await seed();
  assert.deepEqual(await enableAccount(db, { userId: world.alice, now: NOW }), {
    changed: false,
  });
  await disableAccount(db, { userId: world.alice, now: NOW });
  assert.deepEqual(
    await enableAccount(db, { userId: world.alice, now: LATER }),
    { changed: true },
  );
  const [alice] = await db
    .select()
    .from(users)
    .where(eq(users.id, world.alice));
  assert.equal(alice?.disabledAt, null);
  const [grant] = await db
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, world.aliceGrant));
  assert.deepEqual(grant?.revokedAt, NOW, "the grant stays revoked");
  const audit = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.subjectId, world.alice));
  assert.deepEqual(audit.map((row) => row.action).sort(), [
    "account.disabled",
    "account.enabled",
  ]);
});

test("an unknown account changes nothing", async () => {
  const db = database();
  assert.deepEqual(
    await disableAccount(db, { userId: newId<UserId>(), now: NOW }),
    { changed: false, revokedGrantIds: [] },
  );
  assert.deepEqual(
    await enableAccount(db, { userId: newId<UserId>(), now: NOW }),
    { changed: false },
  );
});
