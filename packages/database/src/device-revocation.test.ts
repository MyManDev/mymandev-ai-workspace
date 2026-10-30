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
  type RunId,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "./db.ts";
import { revokeDevice } from "./device-revocation.ts";
import {
  agentRuns,
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
const EARLIER = new Date("2026-10-29T12:00:00.000Z");

type World = Readonly<{
  alice: UserId;
  bob: UserId;
  aliceDevice: DeviceId;
  aliceOtherDevice: DeviceId;
  bobDevice: DeviceId;
  aliceAgent: AgentId;
  aliceSecondAgent: AgentId;
  bobAgent: AgentId;
  grants: Readonly<{
    onAliceDevice: PermissionGrantId;
    alreadyRevoked: PermissionGrantId;
    onBobDevice: PermissionGrantId;
  }>;
  runs: Readonly<Record<string, RunId>>;
}>;

/** Two users in one workspace; Alice has two devices, and her device hosts two agents. */
async function seed(): Promise<World> {
  const db = database();
  const alice = newId<UserId>();
  const bob = newId<UserId>();
  await db.insert(users).values([
    { id: alice, displayName: "Alice" },
    { id: bob, displayName: "Bob" },
  ]);
  const device = (id: DeviceId, userId: UserId) => ({
    id,
    userId,
    label: "Laptop",
    platform: "linux" as const,
    publicKey: randomBytes(32).toString("hex"),
    keyAlgorithm: "ed25519" as const,
    lastSignInAt: EARLIER,
  });
  const aliceDevice = newId<DeviceId>();
  const aliceOtherDevice = newId<DeviceId>();
  const bobDevice = newId<DeviceId>();
  await db
    .insert(devices)
    .values([
      device(aliceDevice, alice),
      device(aliceOtherDevice, alice),
      device(bobDevice, bob),
    ]);
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
      claimedAt: EARLIER,
    },
    {
      id: newId<MemberId>(),
      workspaceId: workspace,
      userId: bob,
      displayName: "Bob",
      role: "member",
      addedByUserId: alice,
      claimedAt: EARLIER,
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
  const aliceSecondAgent = newId<AgentId>();
  const bobAgent = newId<AgentId>();
  await db.insert(agents).values([
    {
      id: aliceAgent,
      projectId: project,
      ownerUserId: alice,
      hostDeviceId: aliceDevice,
      name: "Builder",
    },
    {
      id: aliceSecondAgent,
      projectId: project,
      ownerUserId: alice,
      hostDeviceId: aliceDevice,
      name: "Tester",
    },
    {
      id: bobAgent,
      projectId: project,
      ownerUserId: bob,
      hostDeviceId: bobDevice,
      name: "Reviewer",
    },
  ]);

  const grant = async (
    values: Partial<typeof permissionGrants.$inferInsert> & {
      granteeAgentId: AgentId;
      hostDeviceId: DeviceId;
      grantedByUserId: UserId;
    },
  ) => {
    const id = newId<PermissionGrantId>();
    await db.insert(permissionGrants).values({
      id,
      projectId: project,
      capability: "repo.read",
      repositoryId: repository,
      ...values,
    });
    return id;
  };
  const onAliceDevice = await grant({
    granteeAgentId: aliceAgent,
    hostDeviceId: aliceDevice,
    grantedByUserId: alice,
  });
  const alreadyRevoked = await grant({
    granteeAgentId: aliceSecondAgent,
    hostDeviceId: aliceDevice,
    grantedByUserId: alice,
    revokedAt: EARLIER,
    revokedByUserId: alice,
  });
  const onBobDevice = await grant({
    granteeAgentId: bobAgent,
    hostDeviceId: bobDevice,
    grantedByUserId: bob,
  });

  const runs: Record<string, RunId> = {};
  const run = async (label: string, agentId: AgentId, state: RunState) => {
    const id = newId<RunId>();
    const finished =
      state === "completed" || state === "failed" || state === "cancelled";
    await db.insert(agentRuns).values({
      id,
      agentId,
      projectId: project,
      requestedByUserId: alice,
      state,
      ...(finished ? { finishedAt: EARLIER } : {}),
    });
    runs[label] = id;
  };
  await run("queued", aliceAgent, "queued");
  await run("running", aliceAgent, "running");
  await run("awaiting", aliceSecondAgent, "awaiting_input");
  await run("completed", aliceAgent, "completed");
  await run("bobRunning", bobAgent, "running");

  return {
    alice,
    bob,
    aliceDevice,
    aliceOtherDevice,
    bobDevice,
    aliceAgent,
    aliceSecondAgent,
    bobAgent,
    grants: { onAliceDevice, alreadyRevoked, onBobDevice },
    runs,
  };
}

test("revoking a device disables its agents, revokes its grants, cancels their unfinished runs, and audits it", async () => {
  const db = database();
  const world = await seed();
  const result = await revokeDevice(db, {
    deviceId: world.aliceDevice,
    userId: world.alice,
    reason: "lost",
    now: NOW,
    actorUserId: world.alice,
    actorDeviceId: world.aliceOtherDevice,
  });
  assert.equal(result.revoked, true);
  assert.deepEqual(
    [...result.disabledAgentIds].sort(),
    [world.aliceAgent, world.aliceSecondAgent].sort(),
  );
  assert.deepEqual(result.revokedGrantIds, [world.grants.onAliceDevice]);
  assert.deepEqual(
    [...result.cancelledRunIds].sort(),
    [world.runs.queued, world.runs.running, world.runs.awaiting].sort(),
  );

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, world.aliceDevice));
  assert.deepEqual(device?.revokedAt, NOW);
  assert.equal(device?.revocationReason, "lost");

  const agentRows = await db
    .select()
    .from(agents)
    .where(
      inArray(agents.id, [
        world.aliceAgent,
        world.aliceSecondAgent,
        world.bobAgent,
      ]),
    );
  const disabled = new Map(agentRows.map((row) => [row.id, row.disabledAt]));
  assert.deepEqual(disabled.get(world.aliceAgent), NOW);
  assert.deepEqual(disabled.get(world.aliceSecondAgent), NOW);
  assert.equal(disabled.get(world.bobAgent), null);

  const grantRows = await db.select().from(permissionGrants);
  const byId = new Map(grantRows.map((row) => [row.id, row]));
  assert.deepEqual(byId.get(world.grants.onAliceDevice)?.revokedAt, NOW);
  assert.equal(
    byId.get(world.grants.onAliceDevice)?.revokedByUserId,
    world.alice,
  );
  assert.deepEqual(
    byId.get(world.grants.alreadyRevoked)?.revokedAt,
    EARLIER,
    "an earlier revocation stays",
  );
  assert.equal(byId.get(world.grants.onBobDevice)?.revokedAt, null);

  const runRows = await db
    .select()
    .from(agentRuns)
    .where(inArray(agentRuns.id, Object.values(world.runs)));
  const runs = new Map(runRows.map((row) => [row.id, row]));
  for (const label of ["queued", "running", "awaiting"]) {
    const row = runs.get(world.runs[label] ?? newId<RunId>());
    assert.equal(row?.state, "cancelled", label);
    assert.equal(row?.stateReason, "device_revoked", label);
    assert.deepEqual(row?.finishedAt, NOW, label);
  }
  assert.equal(
    runs.get(world.runs.completed ?? newId<RunId>())?.state,
    "completed",
  );
  assert.deepEqual(
    runs.get(world.runs.completed ?? newId<RunId>())?.finishedAt,
    EARLIER,
  );
  assert.equal(
    runs.get(world.runs.bobRunning ?? newId<RunId>())?.state,
    "running",
  );

  const audit = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.subjectId, world.aliceDevice));
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.action, "device.revoked");
  assert.equal(audit[0]?.reason, "lost");
  assert.equal(audit[0]?.actorUserId, world.alice);
  assert.equal(audit[0]?.actorDeviceId, world.aliceOtherDevice);
});

test("a revoked device never comes back, and another account cannot revoke a device", async () => {
  const db = database();
  const world = await seed();
  const input = {
    deviceId: world.aliceDevice,
    userId: world.alice,
    reason: "removed" as const,
    now: NOW,
    actorUserId: world.alice,
    actorDeviceId: null,
  };
  assert.equal((await revokeDevice(db, input)).revoked, true);
  const again = await revokeDevice(db, {
    ...input,
    reason: "lost",
    now: new Date("2026-10-31T00:00:00.000Z"),
  });
  assert.deepEqual(again, {
    revoked: false,
    disabledAgentIds: [],
    revokedGrantIds: [],
    cancelledRunIds: [],
  });
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, world.aliceDevice));
  assert.equal(device?.revocationReason, "removed", "the first reason stays");
  assert.equal(
    (
      await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.subjectId, world.aliceDevice))
    ).length,
    1,
  );

  const foreign = await revokeDevice(db, {
    ...input,
    deviceId: world.bobDevice,
  });
  assert.equal(foreign.revoked, false);
  const [bobDevice] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, world.bobDevice));
  assert.equal(bobDevice?.revokedAt, null);
});

test("inside a transaction that rolls back, a revocation leaves nothing behind", async () => {
  const db = database();
  const world = await seed();
  await assert.rejects(
    db.transaction(async (tx) => {
      const result = await revokeDevice(tx, {
        deviceId: world.aliceDevice,
        userId: world.alice,
        reason: "replaced",
        now: NOW,
        actorUserId: world.alice,
        actorDeviceId: world.aliceOtherDevice,
      });
      assert.equal(result.revoked, true);
      throw new Error("roll back");
    }),
    /roll back/u,
  );
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, world.aliceDevice));
  assert.equal(device?.revokedAt, null);
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, world.aliceAgent));
  assert.equal(agent?.disabledAt, null);
  const [grant] = await db
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, world.grants.onAliceDevice));
  assert.equal(grant?.revokedAt, null);
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, world.runs.running ?? newId<RunId>()));
  assert.equal(run?.state, "running");
  assert.equal(
    (
      await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.subjectId, world.aliceDevice))
    ).length,
    0,
  );
});

test("an operator's revocation records no actor", async () => {
  const db = database();
  const world = await seed();
  await revokeDevice(db, {
    deviceId: world.bobDevice,
    userId: world.bob,
    reason: "account_erased",
    now: NOW,
    actorUserId: null,
    actorDeviceId: null,
  });
  const [audit] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.subjectId, world.bobDevice));
  assert.equal(audit?.actorUserId, null);
  assert.equal(audit?.actorDeviceId, null);
  assert.equal(audit?.reason, "account_erased");
});
