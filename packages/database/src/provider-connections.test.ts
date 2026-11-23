import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  type AgentId,
  type DeviceId,
  type GrantCapabilityRequest,
  newId,
  type PermissionGrantId,
  PROVIDER_CONNECTION_COUNT_LIMITS,
  PROVIDER_KINDS,
  type ProjectId,
  type ProviderConnectionId,
  ProviderConnectionListResponseSchema,
  type RepositoryId,
  type RunId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { Database } from "./db.ts";
import { revokeDevice } from "./device-revocation.ts";
import { DatabaseError, withDatabaseErrors } from "./errors.ts";
import { grantCapability } from "./grants.ts";
import { createWorkspace } from "./membership.ts";
import { createProject } from "./projects.ts";
import {
  listProviderConnections,
  registerProviderConnection,
  type RegisterProviderConnectionInput,
  type RegisterProviderConnectionResult,
  removeProviderConnection,
  type RemoveProviderConnectionResult,
} from "./provider-connections.ts";
import { SERVER_ONLY, whileHeld } from "./race-testing.ts";
import {
  agentRuns,
  agents,
  auditEvents,
  devices,
  permissionGrants,
  providerConnections,
  repositories,
  users,
} from "./schema/index.ts";
import { createTestDatabase } from "./testing.ts";

// The provider connections of a host device (#295): registering, listing,
// and removing them, each only by the host device itself; the limits of a
// device and of an account; and a removal that revokes the connection's
// provider.use grants in its own transaction and cancels no run.

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
const NOW = new Date("2026-11-23T12:00:00.000Z");
const LATER = new Date("2026-11-23T13:00:00.000Z");
const EARLIER = new Date("2026-11-23T11:00:00.000Z");
const { activePerDevice: PER_DEVICE, perDay: PER_DAY } =
  PROVIDER_CONNECTION_COUNT_LIMITS;

type Account = Readonly<{ userId: UserId; deviceId: DeviceId }>;

/** A device of the account. */
async function addDevice(userId: UserId): Promise<DeviceId> {
  const deviceId = newId<DeviceId>();
  await database()
    .insert(devices)
    .values({
      id: deviceId,
      userId,
      label: "Laptop",
      platform: "linux",
      publicKey: randomBytes(32).toString("hex"),
      keyAlgorithm: "ed25519",
      lastSignInAt: NOW,
    });
  return deviceId;
}

/** An account with one device. */
async function account(name: string): Promise<Account> {
  const userId = newId<UserId>();
  await database().insert(users).values({ id: userId, displayName: name });
  return { userId, deviceId: await addDevice(userId) };
}

function input(
  by: Account,
  label = "Work",
  now: Date = NOW,
  kind: RegisterProviderConnectionInput["kind"] = "claude",
): RegisterProviderConnectionInput {
  return { userId: by.userId, deviceId: by.deviceId, kind, label, now };
}

function register(
  by: Account,
  label = "Work",
  now: Date = NOW,
): Promise<RegisterProviderConnectionResult> {
  return registerProviderConnection(database(), input(by, label, now));
}

/** Registers a connection that must be registered, and returns its ID. */
async function registered(
  by: Account,
  label = "Work",
  now: Date = NOW,
): Promise<ProviderConnectionId> {
  const result = await register(by, label, now);
  assert.ok(result.registered, JSON.stringify(result));
  return result.providerConnection.id;
}

function remove(
  by: Account,
  providerConnectionId: ProviderConnectionId,
  now: Date = LATER,
  db: Database = database(),
): Promise<RemoveProviderConnectionResult> {
  return removeProviderConnection(db, {
    userId: by.userId,
    deviceId: by.deviceId,
    providerConnectionId,
    now,
  });
}

/** Inserts `n` connections of the device directly, created at `createdAt`. */
async function fill(
  deviceId: DeviceId,
  n: number,
  createdAt: Date,
  removedAt: Date | null = null,
): Promise<ProviderConnectionId[]> {
  const rows = Array.from({ length: n }, (_, index) => ({
    id: newId<ProviderConnectionId>(),
    hostDeviceId: deviceId,
    kind: "claude" as const,
    label: `Filler ${index}`,
    createdAt,
    removedAt,
  }));
  await database().insert(providerConnections).values(rows);
  return rows.map((row) => row.id);
}

async function connectionRow(id: ProviderConnectionId) {
  const [row] = await database()
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function connectionsOn(deviceId: DeviceId) {
  return database()
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.hostDeviceId, deviceId));
}

/** A workspace and a project of the account, and an agent of it on its device. */
async function agentSetUp(owner: Account) {
  const workspace = await createWorkspace(database(), {
    ...owner,
    name: "Team",
    displayName: "Owner",
    now: new Date(NOW.getTime() - 2 * DAY_MS),
  });
  assert.ok(workspace.created);
  const workspaceId: WorkspaceId = workspace.membership.workspace.id;
  const project = await createProject(database(), {
    workspaceId,
    userId: owner.userId,
    name: "App",
    now: new Date(NOW.getTime() - 2 * DAY_MS),
  });
  assert.ok(project.created);
  const projectId = project.project.id;
  const agentId = newId<AgentId>();
  await database().insert(agents).values({
    id: agentId,
    projectId,
    ownerUserId: owner.userId,
    hostDeviceId: owner.deviceId,
    name: "Builder",
  });
  const repositoryId = newId<RepositoryId>();
  await database().insert(repositories).values({
    id: repositoryId,
    projectId,
    name: "Repository",
    createdByUserId: owner.userId,
  });
  return { workspaceId, projectId, agentId, repositoryId };
}

/** A grant to the agent, inserted directly; `provider.use` on the connection by default. */
async function grantTo(
  projectId: ProjectId,
  agentId: AgentId,
  owner: Account,
  values: Partial<typeof permissionGrants.$inferInsert>,
): Promise<PermissionGrantId> {
  const id = newId<PermissionGrantId>();
  await database()
    .insert(permissionGrants)
    .values({
      id,
      projectId,
      granteeAgentId: agentId,
      hostDeviceId: owner.deviceId,
      capability: "provider.use",
      grantedByUserId: owner.userId,
      createdAt: new Date(NOW.getTime() - 2 * HOUR_MS),
      ...values,
    });
  return id;
}

async function grantRow(id: PermissionGrantId) {
  const [row] = await database()
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, id));
  assert.ok(row !== undefined);
  return row;
}

function useConnection(
  providerConnectionId: ProviderConnectionId,
): GrantCapabilityRequest {
  return {
    capability: "provider.use",
    providerConnectionId,
    lifetimeSeconds: null,
  };
}

/** Runs the operation and asserts that it fails with this SQLSTATE and constraint. */
async function rejectsWith(
  operation: () => Promise<unknown>,
  code: string,
  constraint: string,
): Promise<void> {
  await assert.rejects(withDatabaseErrors(operation), (error: unknown) => {
    assert.ok(error instanceof DatabaseError);
    assert.equal(error.code, code);
    assert.equal(error.constraint, constraint);
    return true;
  });
}

test("the table of provider connections has no column for a credential or a provider account", async () => {
  assert.ok(testDatabase);
  const { rows } = await testDatabase.client.query<{ name: string }>(
    `select column_name as name from information_schema.columns
      where table_schema = 'public' and table_name = 'provider_connections'
      order by ordinal_position`,
  );
  assert.deepEqual(
    rows.map((row) => row.name),
    ["id", "host_device_id", "created_at", "removed_at", "kind", "label"],
  );
});

test("the kind is a closed list and the label has 1 to 64 characters, held by CHECKs", async () => {
  const db = database();
  const owner = await account("Owner");
  const row = {
    hostDeviceId: owner.deviceId,
    kind: "claude" as const,
    label: "Work",
  };
  for (const kind of PROVIDER_KINDS) {
    await db
      .insert(providerConnections)
      .values({ ...row, id: newId<ProviderConnectionId>(), kind });
  }
  for (const kind of ["gemini", "Claude", "claude ", ""]) {
    await rejectsWith(
      () =>
        db.insert(providerConnections).values({
          ...row,
          id: newId<ProviderConnectionId>(),
          // A value that the type does not allow, as raw SQL could write it.
          kind: kind as "claude",
        }),
      "23514",
      "provider_connections_kind_check",
    );
  }
  for (const label of ["", "a".repeat(65)]) {
    await rejectsWith(
      () =>
        db
          .insert(providerConnections)
          .values({ ...row, id: newId<ProviderConnectionId>(), label }),
      "23514",
      "provider_connections_label_length",
    );
  }
  await db.insert(providerConnections).values({
    ...row,
    id: newId<ProviderConnectionId>(),
    label: "a".repeat(64),
  });
});

test("a device registers a connection that it hosts, with the kind and the label as given, and the list shows it", async () => {
  const owner = await account("Owner");
  const result = await registerProviderConnection(
    database(),
    input(owner, "  Personal  ", NOW, "codex"),
  );
  assert.ok(result.registered);
  const { providerConnection } = result;
  assert.deepEqual(providerConnection, {
    id: providerConnection.id,
    kind: "codex",
    label: "  Personal  ",
    createdAt: NOW.toISOString(),
  });
  const row = await connectionRow(providerConnection.id);
  assert.deepEqual(row, {
    id: providerConnection.id,
    hostDeviceId: owner.deviceId,
    kind: "codex",
    label: "  Personal  ",
    createdAt: NOW,
    removedAt: null,
  });
  // A label is not unique: a second account of the same provider.
  const again = await registered(owner, "  Personal  ", LATER);
  assert.notEqual(again, providerConnection.id);
  const listed = await listProviderConnections(database(), owner);
  assert.deepEqual(
    listed.map((connection) => connection.id),
    [providerConnection.id, again],
  );
  assert.deepEqual(listed[0], providerConnection);
  assert.ok(
    ProviderConnectionListResponseSchema.safeParse({
      providerConnections: listed,
    }).success,
  );
  // Registering a connection is not an administrative action of ADR 0014.
  const audited = await database()
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.actorUserId, owner.userId));
  assert.deepEqual(audited, []);
});

test("a disabled account, a revoked device, and a device of another account register nothing", async () => {
  const owner = await account("Owner");
  const other = await account("Other");
  assert.deepEqual(
    await registerProviderConnection(database(), {
      ...input(owner),
      deviceId: other.deviceId,
    }),
    { registered: false, refusal: "forbidden" },
  );
  assert.deepEqual(
    await registerProviderConnection(database(), {
      ...input(owner),
      deviceId: newId<DeviceId>(),
    }),
    { registered: false, refusal: "forbidden" },
  );
  await database()
    .update(devices)
    .set({ revokedAt: EARLIER, revocationReason: "removed" })
    .where(eq(devices.id, other.deviceId));
  assert.deepEqual(await register(other), {
    registered: false,
    refusal: "forbidden",
  });
  await database()
    .update(users)
    .set({ disabledAt: EARLIER })
    .where(eq(users.id, owner.userId));
  assert.deepEqual(await register(owner), {
    registered: false,
    refusal: "forbidden",
  });
  assert.deepEqual(await connectionsOn(owner.deviceId), []);
  assert.deepEqual(await connectionsOn(other.deviceId), []);
});

test(`a device holds at most ${PER_DEVICE} connections that are not removed; the next is provider_connection_limit, a removal frees a place, and another device of the account has its own`, async () => {
  const owner = await account("Owner");
  const removedBefore = await fill(owner.deviceId, 3, EARLIER, EARLIER);
  assert.equal(removedBefore.length, 3);
  const ids = await fill(owner.deviceId, PER_DEVICE - 1, EARLIER);
  // Removed connections do not count.
  await registered(owner);
  assert.deepEqual(await register(owner, "Eleventh"), {
    registered: false,
    refusal: "provider_connection_limit",
  });
  assert.equal((await connectionsOn(owner.deviceId)).length, PER_DEVICE + 3);

  // Another device of the same account has its own limit.
  const second = { ...owner, deviceId: await addDevice(owner.userId) };
  await registered(second);

  const [first] = ids;
  assert.ok(first);
  assert.ok((await remove(owner, first)).removed);
  await registered(owner, "Again");
  assert.deepEqual(await register(owner, "Over"), {
    registered: false,
    refusal: "provider_connection_limit",
  });
});

test(`an account registers at most ${PER_DAY} connections within 24 hours, on all its devices and removed ones included; the next is rate_limited until the oldest is 24 hours old`, async () => {
  const owner = await account("Owner");
  const second = { ...owner, deviceId: await addDevice(owner.userId) };
  const third = { ...owner, deviceId: await addDevice(owner.userId) };
  // Older than 24 hours: not counted.
  await fill(owner.deviceId, 5, new Date(NOW.getTime() - DAY_MS), NOW);
  const oldest = new Date(NOW.getTime() - 20 * HOUR_MS);
  await fill(owner.deviceId, 5, oldest, EARLIER);
  await fill(second.deviceId, PER_DEVICE, EARLIER);
  await fill(third.deviceId, PER_DAY - 5 - PER_DEVICE - 1, EARLIER);
  await registered(third);
  const refused = await register(third, "One more");
  assert.deepEqual(refused, {
    registered: false,
    refusal: "rate_limited",
    retryAfterMs: oldest.getTime() + DAY_MS - NOW.getTime(),
  });
  // Another account has its own count.
  await registered(await account("Other"));
  // Once the oldest is 24 hours old, a place is free.
  const freed = new Date(oldest.getTime() + DAY_MS + 1);
  await registered(third, "Later", freed);
});

test("a registration at the device's limit and the account's limit answers provider_connection_limit", async () => {
  const owner = await account("Owner");
  const second = { ...owner, deviceId: await addDevice(owner.userId) };
  await fill(owner.deviceId, PER_DEVICE, EARLIER);
  await fill(second.deviceId, PER_DAY - PER_DEVICE, EARLIER, EARLIER);
  assert.deepEqual(await register(owner), {
    registered: false,
    refusal: "provider_connection_limit",
  });
  // The account's limit alone answers rate_limited.
  const result = await register(second);
  assert.equal(result.registered, false);
  assert.equal(!result.registered && result.refusal, "rate_limited");
});

test("the list holds the calling device's connections that are not removed, the oldest first, and nothing of another device or account", async () => {
  const owner = await account("Owner");
  const second = { ...owner, deviceId: await addDevice(owner.userId) };
  const other = await account("Other");
  const later = await registered(owner, "Later", LATER);
  const earlier = await registered(owner, "Earlier", EARLIER);
  const gone = await registered(owner, "Gone", NOW);
  assert.ok((await remove(owner, gone)).removed);
  await registered(second, "Second");
  await registered(other, "Other");
  const listed = await listProviderConnections(database(), owner);
  assert.deepEqual(
    listed.map((connection) => [connection.id, connection.label]),
    [
      [earlier, "Earlier"],
      [later, "Later"],
    ],
  );
  // A device of another account lists nothing, also with its own device.
  assert.deepEqual(
    await listProviderConnections(database(), {
      userId: other.userId,
      deviceId: owner.deviceId,
    }),
    [],
  );
  assert.deepEqual(
    await listProviderConnections(database(), {
      ...owner,
      deviceId: newId<DeviceId>(),
    }),
    [],
  );
});

test("a removal sets the removal time, revokes the connection's provider.use grants that are not revoked yet with the remover as the revoker, and cancels no run", async () => {
  const owner = await account("Owner");
  const { projectId, agentId, repositoryId } = await agentSetUp(owner);
  const connectionId = await registered(owner);
  const otherConnection = await registered(owner, "Other");
  const active = await grantTo(projectId, agentId, owner, {
    providerConnectionId: connectionId,
  });
  // An expired grant that was never revoked is revoked too.
  const secondAgent = newId<AgentId>();
  await database().insert(agents).values({
    id: secondAgent,
    projectId,
    ownerUserId: owner.userId,
    hostDeviceId: owner.deviceId,
    name: "Second",
  });
  const expired = await grantTo(projectId, secondAgent, owner, {
    providerConnectionId: connectionId,
    expiresAt: EARLIER,
  });
  const revokedBefore = await grantTo(projectId, secondAgent, owner, {
    providerConnectionId: otherConnection,
    revokedAt: EARLIER,
    revokedByUserId: owner.userId,
  });
  const onOther = await grantTo(projectId, agentId, owner, {
    providerConnectionId: otherConnection,
  });
  const onRepository = await grantTo(projectId, agentId, owner, {
    capability: "repo.read",
    repositoryId,
  });
  const runId = newId<RunId>();
  await database().insert(agentRuns).values({
    id: runId,
    agentId,
    projectId,
    requestedByUserId: owner.userId,
    state: "running",
    providerConnectionId: connectionId,
    hostDeviceId: owner.deviceId,
    createdAt: EARLIER,
  });

  const result = await remove(owner, connectionId, LATER);
  assert.ok(result.removed);
  const revoked = [active, expired].sort();
  assert.deepEqual(result.revokedGrantIds, revoked);
  assert.ok(Object.isFrozen(result.revokedGrantIds));
  for (const id of revoked) {
    const row = await grantRow(id);
    assert.deepEqual(row.revokedAt, LATER, id);
    assert.equal(row.revokedByUserId, owner.userId, id);
  }
  assert.deepEqual((await connectionRow(connectionId)).removedAt, LATER);
  // Nothing else changed.
  assert.deepEqual((await grantRow(revokedBefore)).revokedAt, EARLIER);
  assert.equal((await grantRow(onOther)).revokedAt, null);
  assert.equal((await grantRow(onRepository)).revokedAt, null);
  assert.equal((await connectionRow(otherConnection)).removedAt, null);
  const [run] = await database()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  assert.equal(run?.state, "running");
  assert.equal(run?.finishedAt, null);
  const [agent] = await database()
    .select()
    .from(agents)
    .where(eq(agents.id, agentId));
  assert.equal(agent?.disabledAt, null);
  // Nothing is deleted, and nothing is audited.
  assert.equal((await connectionsOn(owner.deviceId)).length, 2);
  const audited = await database()
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.actorUserId, owner.userId));
  assert.deepEqual(
    audited.map((record) => record.action),
    ["workspace.created"],
  );
  // A grant on the removed connection is refused.
  assert.deepEqual(
    await grantCapability(database(), {
      agentId,
      userId: owner.userId,
      deviceId: owner.deviceId,
      grant: useConnection(connectionId),
      now: LATER,
    }),
    { granted: false, refusal: "conflict" },
  );
});

test("only the host device removes a connection: another device of the account and another account get not_found, a removed one conflict, and a revoked device or a disabled account forbidden", async () => {
  const owner = await account("Owner");
  const second = { ...owner, deviceId: await addDevice(owner.userId) };
  const other = await account("Other");
  const connectionId = await registered(owner);

  assert.deepEqual(await remove(second, connectionId), {
    removed: false,
    refusal: "not_found",
  });
  assert.deepEqual(await remove(other, connectionId), {
    removed: false,
    refusal: "not_found",
  });
  // Even with the host device's ID, another account removes nothing.
  assert.deepEqual(
    await removeProviderConnection(database(), {
      userId: other.userId,
      deviceId: owner.deviceId,
      providerConnectionId: connectionId,
      now: LATER,
    }),
    { removed: false, refusal: "forbidden" },
  );
  assert.deepEqual(await remove(owner, newId<ProviderConnectionId>()), {
    removed: false,
    refusal: "not_found",
  });
  assert.equal((await connectionRow(connectionId)).removedAt, null);

  // A device revocation does not mark its connections removed.
  const revocation = await revokeDevice(database(), {
    ...owner,
    reason: "removed",
    now: EARLIER,
    actorUserId: owner.userId,
    actorDeviceId: second.deviceId,
  });
  assert.ok(revocation.revoked);
  assert.equal((await connectionRow(connectionId)).removedAt, null);
  assert.deepEqual(await remove(owner, connectionId), {
    removed: false,
    refusal: "forbidden",
  });
  assert.equal((await connectionRow(connectionId)).removedAt, null);

  const onSecond = await registered(second);
  assert.ok((await remove(second, onSecond, NOW)).removed);
  assert.deepEqual(await remove(second, onSecond, LATER), {
    removed: false,
    refusal: "conflict",
  });
  assert.deepEqual((await connectionRow(onSecond)).removedAt, NOW);

  const kept = await registered(second, "Kept");
  await database()
    .update(users)
    .set({ disabledAt: EARLIER })
    .where(eq(users.id, owner.userId));
  assert.deepEqual(await remove(second, kept), {
    removed: false,
    refusal: "forbidden",
  });
  assert.equal((await connectionRow(kept)).removedAt, null);
});

test("the removal and the revocation of its grants are one transaction: a failed revocation removes nothing, and a removal inside another transaction rolls back with it", async () => {
  assert.ok(testDatabase);
  const owner = await account("Owner");
  const { projectId, agentId } = await agentSetUp(owner);
  const connectionId = await registered(owner);
  const grant = await grantTo(projectId, agentId, owner, {
    providerConnectionId: connectionId,
  });

  // A trigger of this test refuses the revocation of the grant.
  const client = testDatabase.client;
  await client.query(
    `create function r295_refuse_revocation() returns trigger language plpgsql as $$
     begin raise exception 'refused by the test'; end $$`,
  );
  await client.query(
    `create trigger r295_refuse_revocation before update on permission_grants
       for each row when (old.id = '${grant}') execute function r295_refuse_revocation()`,
  );
  try {
    await assert.rejects(remove(owner, connectionId));
  } finally {
    await client.query(
      "drop trigger r295_refuse_revocation on permission_grants",
    );
    await client.query("drop function r295_refuse_revocation()");
  }
  assert.equal((await connectionRow(connectionId)).removedAt, null);
  assert.equal((await grantRow(grant)).revokedAt, null);

  const rollback = new Error("roll back");
  await assert.rejects(
    database().transaction(async (tx) => {
      const removed = await remove(owner, connectionId, LATER, tx);
      assert.ok(removed.removed);
      assert.deepEqual(removed.revokedGrantIds, [grant]);
      const made = await registerProviderConnection(tx, input(owner, "Inner"));
      assert.ok(made.registered);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  assert.equal((await connectionRow(connectionId)).removedAt, null);
  assert.equal((await grantRow(grant)).revokedAt, null);
  assert.equal((await connectionsOn(owner.deviceId)).length, 1);

  // A refusal inside another transaction lets it go on.
  await database().transaction(async (tx) => {
    assert.deepEqual(
      await remove(owner, newId<ProviderConnectionId>(), LATER, tx),
      { removed: false, refusal: "not_found" },
    );
    assert.ok((await remove(owner, connectionId, LATER, tx)).removed);
  });
  assert.deepEqual((await connectionRow(connectionId)).removedAt, LATER);
  assert.deepEqual((await grantRow(grant)).revokedAt, LATER);
});

// Races, on a PostgreSQL server only.

test(
  "of two concurrent registrations for the last place of a device, the second waits at the account and is provider_connection_limit",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    await fill(owner.deviceId, PER_DEVICE - 1, EARLIER);
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        assert.ok(
          (await registerProviderConnection(tx, input(owner, "First")))
            .registered,
        );
      },
      () => register(owner, "Second"),
    );
    assert.deepEqual(result, {
      registered: false,
      refusal: "provider_connection_limit",
    });
    assert.deepEqual(waitedOn, ["users"]);
    assert.equal((await connectionsOn(owner.deviceId)).length, PER_DEVICE);
  },
);

test(
  "a grant of provider.use waits at the device for a removal of its connection and is conflict",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const { agentId } = await agentSetUp(owner);
    const connectionId = await registered(owner);
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        assert.ok((await remove(owner, connectionId, LATER, tx)).removed);
      },
      () =>
        grantCapability(database(), {
          agentId,
          userId: owner.userId,
          deviceId: owner.deviceId,
          grant: useConnection(connectionId),
          now: LATER,
        }),
    );
    assert.deepEqual(result, { granted: false, refusal: "conflict" });
    assert.deepEqual(waitedOn, ["devices"]);
  },
);

test(
  "a removal waits at the device for a grant on its connection and revokes the new grant",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const { agentId } = await agentSetUp(owner);
    const connectionId = await registered(owner);
    let grantId: PermissionGrantId | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const made = await grantCapability(tx, {
          agentId,
          userId: owner.userId,
          deviceId: owner.deviceId,
          grant: useConnection(connectionId),
          now: NOW,
        });
        assert.ok(made.granted);
        grantId = made.grant.id;
      },
      () => remove(owner, connectionId, LATER),
    );
    assert.ok(grantId !== undefined);
    assert.deepEqual(result, { removed: true, revokedGrantIds: [grantId] });
    assert.deepEqual(waitedOn, ["devices"]);
    assert.deepEqual((await grantRow(grantId)).revokedAt, LATER);
  },
);
