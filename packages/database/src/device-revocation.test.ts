import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentId,
  type CorrelationId,
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
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "./client.ts";
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
  workspace: WorkspaceId;
  project: ProjectId;
  repository: RepositoryId;
  correlation: CorrelationId;
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
  const run = async (
    label: string,
    agentId: AgentId,
    state: RunState,
    fields: Partial<typeof agentRuns.$inferInsert> = {},
  ) => {
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
      ...fields,
    });
    runs[label] = id;
  };
  const correlation = newId<CorrelationId>();
  await run("queued", aliceAgent, "queued");
  await run("running", aliceAgent, "running", {
    repositoryId: repository,
    correlationId: correlation,
  });
  await run("awaiting", aliceSecondAgent, "awaiting_input");
  await run("completed", aliceAgent, "completed");
  await run("bobRunning", bobAgent, "running");

  return {
    workspace,
    project,
    repository,
    correlation,
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
  // In the order of their IDs, as they were locked.
  assert.deepEqual(
    result.disabledAgentIds,
    [world.aliceAgent, world.aliceSecondAgent].sort(),
  );
  assert.deepEqual(result.revokedGrantIds, [world.grants.onAliceDevice]);
  // Each cancelled run with what its event needs, in the order of the run IDs.
  const cancelled = (
    label: string,
    agentId: AgentId,
    previousState: string,
    fields: Partial<{
      repositoryId: RepositoryId;
      correlationId: CorrelationId;
    }> = {},
  ) => ({
    runId: world.runs[label],
    agentId,
    projectId: world.project,
    workspaceId: world.workspace,
    repositoryId: fields.repositoryId ?? null,
    correlationId: fields.correlationId ?? null,
    previousState,
    reason: "device_revoked",
  });
  assert.deepEqual(
    result.cancelledRuns,
    [
      cancelled("queued", world.aliceAgent, "queued"),
      cancelled("running", world.aliceAgent, "running", {
        repositoryId: world.repository,
        correlationId: world.correlation,
      }),
      cancelled("awaiting", world.aliceSecondAgent, "awaiting_input"),
    ].sort((a, b) => String(a.runId).localeCompare(String(b.runId))),
  );
  assert.ok(Object.isFrozen(result.cancelledRuns[0]));

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
    cancelledRuns: [],
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

/** More rows than PostgreSQL's 65,535 parameters of one statement. */
const MANY = 66_000;

test(`a revocation disables, revokes, and cancels more than 65,535 agents, grants, and runs, because each step binds its IDs as one array`, async () => {
  const db = database();
  const world = await seed();
  await db.execute(sql`
    insert into agents (id, project_id, owner_user_id, host_device_id, name)
    select gen_random_uuid(), ${world.project}, ${world.alice}, ${world.aliceDevice}, 'Bulk'
    from generate_series(1, ${MANY})`);
  await db.execute(sql`
    insert into permission_grants (id, project_id, grantee_agent_id, host_device_id, capability, repository_id, granted_by_user_id)
    select gen_random_uuid(), project_id, id, host_device_id, 'repo.read', ${world.repository}, owner_user_id
    from agents where host_device_id = ${world.aliceDevice} and name = 'Bulk'`);
  await db.execute(sql`
    insert into agent_runs (id, agent_id, project_id, requested_by_user_id, state)
    select gen_random_uuid(), id, project_id, owner_user_id, 'queued'
    from agents where host_device_id = ${world.aliceDevice} and name = 'Bulk'`);

  const result = await revokeDevice(db, {
    deviceId: world.aliceDevice,
    userId: world.alice,
    reason: "removed",
    now: NOW,
    actorUserId: world.alice,
    actorDeviceId: world.aliceOtherDevice,
  });
  // The seed adds two agents, one active grant, and three unfinished runs.
  assert.equal(result.disabledAgentIds.length, MANY + 2);
  assert.equal(result.revokedGrantIds.length, MANY + 1);
  assert.equal(result.cancelledRuns.length, MANY + 3);
  const hosted = db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.hostDeviceId, world.aliceDevice));
  const [left] = await db
    .select({ n: count() })
    .from(agentRuns)
    .where(
      and(inArray(agentRuns.agentId, hosted), eq(agentRuns.state, "queued")),
    );
  assert.equal(left?.n, 0);
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
  "a run that another transaction finishes while the revocation waits for its lock is neither reported nor cancelled",
  SERVER_ONLY,
  async () => {
    const url = testDatabase?.url;
    assert.ok(url, "the test database is on a server");
    const world = await seed();
    const running = world.runs.running;
    assert.ok(running !== undefined);
    // A second session completes the running run and keeps its transaction
    // open, so it holds the run's row.
    const other = createDatabase(url, { max: 1 });
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = other.db.transaction(async (tx) => {
      await tx
        .update(agentRuns)
        .set({ state: "completed", finishedAt: NOW })
        .where(eq(agentRuns.id, running));
      holding.resolve();
      await release.promise;
    });
    try {
      await Promise.race([
        holding.promise,
        first.then(() => {
          throw new Error("the first transaction ended early");
        }),
      ]);
      const revocation = revokeDevice(database(), {
        deviceId: world.aliceDevice,
        userId: world.alice,
        reason: "removed",
        now: NOW,
        actorUserId: world.alice,
        actorDeviceId: world.aliceOtherDevice,
      });
      let settled = false;
      revocation.then(
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
      assert.equal(settled, false, "the revocation waits for the run");
      release.resolve();
      await first;
      // PostgreSQL checks the run again after the lock: it is no longer
      // unfinished, so the revocation neither reports nor cancels it.
      const result = await revocation;
      assert.deepEqual(
        result.cancelledRuns.map((run) => run.runId).sort(),
        [world.runs.queued, world.runs.awaiting].sort(),
      );
      const [row] = await database()
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, running));
      assert.equal(row?.state, "completed");
      assert.equal(row?.stateReason, null);
      assert.deepEqual(row?.finishedAt, NOW);
    } finally {
      release.resolve();
      await first.catch(() => undefined);
      await other.close();
    }
  },
);
