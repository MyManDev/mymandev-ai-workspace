import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  CAPABILITIES,
  DEVICE_PLATFORMS,
  newId,
  newUuidV7,
  RUN_STATES,
  TERMINAL_RUN_STATES,
  type AgentId,
  type Capability,
  type DeviceId,
  type EventId,
  type ProjectId,
  type RepositoryId,
  type RunId,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Database } from "./db.ts";
import {
  DatabaseError,
  toDatabaseError,
  withDatabaseErrors,
} from "./errors.ts";
import { migrationsFolder } from "./migrate.ts";
import * as schema from "./schema/index.ts";
import {
  agentRuns,
  agents,
  conversations,
  devices,
  messages,
  permissionGrants,
  projects,
  repositories,
  users,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";
import { createTestDatabase } from "./testing.ts";

// One PGlite instance for this file; the role test creates its own.
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

/** Runs the operation and asserts that it fails with this SQLSTATE and constraint. */
async function rejectsWith(
  operation: () => Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  await assert.rejects(withDatabaseErrors(operation), (error: unknown) => {
    assert.ok(error instanceof DatabaseError);
    assert.equal(error.code, code);
    if (constraint !== undefined) {
      assert.equal(error.constraint, constraint);
    }
    return true;
  });
}

/** Two users with one device each, sharing a workspace with two projects. */
type World = {
  alice: UserId;
  bob: UserId;
  aliceDevice: DeviceId;
  bobDevice: DeviceId;
  workspace: WorkspaceId;
  project: ProjectId;
  otherProject: ProjectId;
  /** In `project`. */
  repository: RepositoryId;
  /** In `otherProject`. */
  otherRepository: RepositoryId;
  /** In `project`, owned by Alice, hosted on Alice's device. */
  aliceAgent: AgentId;
  /** In `project`, owned by Bob, hosted on Bob's device. */
  bobAgent: AgentId;
  /** In `project`. */
  conversation: string;
};

async function seed(): Promise<World> {
  const db = database();
  const alice = newId<UserId>();
  const bob = newId<UserId>();
  await db.insert(users).values([
    { id: alice, displayName: "Alice" },
    { id: bob, displayName: "Bob" },
  ]);
  const aliceDevice = newId<DeviceId>();
  const bobDevice = newId<DeviceId>();
  await db.insert(devices).values([
    { id: aliceDevice, userId: alice, label: "Laptop", platform: "windows" },
    { id: bobDevice, userId: bob, label: "Desktop", platform: "linux" },
  ]);
  const workspace = newId<WorkspaceId>();
  await db
    .insert(workspaces)
    .values({ id: workspace, name: "Team", createdByUserId: alice });
  await db.insert(workspaceMembers).values([
    { workspaceId: workspace, userId: alice, addedByUserId: alice },
    { workspaceId: workspace, userId: bob, addedByUserId: alice },
  ]);
  const project = newId<ProjectId>();
  const otherProject = newId<ProjectId>();
  await db.insert(projects).values([
    {
      id: project,
      workspaceId: workspace,
      name: "App",
      createdByUserId: alice,
    },
    {
      id: otherProject,
      workspaceId: workspace,
      name: "Website",
      createdByUserId: alice,
    },
  ]);
  const repository = newId<RepositoryId>();
  const otherRepository = newId<RepositoryId>();
  await db.insert(repositories).values([
    { id: repository, projectId: project, name: "app", createdByUserId: alice },
    {
      id: otherRepository,
      projectId: otherProject,
      name: "website",
      createdByUserId: alice,
    },
  ]);
  const aliceAgent = newId<AgentId>();
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
      id: bobAgent,
      projectId: project,
      ownerUserId: bob,
      hostDeviceId: bobDevice,
      name: "Reviewer",
    },
  ]);
  const conversation = await addConversation(project, alice);
  return {
    alice,
    bob,
    aliceDevice,
    bobDevice,
    workspace,
    project,
    otherProject,
    repository,
    otherRepository,
    aliceAgent,
    bobAgent,
    conversation,
  };
}

async function addConversation(
  projectId: ProjectId,
  userId: UserId,
): Promise<string> {
  const id = newUuidV7();
  await database()
    .insert(conversations)
    .values({ id, projectId, kind: "project", createdByUserId: userId });
  return id;
}

type NewMessage = Omit<typeof messages.$inferInsert, "id" | "seq">;

/**
 * Inserts a message with the next sequence number of its conversation,
 * allocated from conversations.last_seq in the insert transaction (ADR 0013).
 * Test helper only; the first message writer (M2-03) adds the package function.
 */
async function insertMessage(values: NewMessage): Promise<number> {
  return database().transaction(async (tx) => {
    const [row] = await tx
      .update(conversations)
      .set({ lastSeq: sql`${conversations.lastSeq} + 1` })
      .where(eq(conversations.id, values.conversationId))
      .returning({ seq: conversations.lastSeq });
    assert.ok(row, "the conversation exists");
    await tx
      .insert(messages)
      .values({ ...values, id: newUuidV7(), seq: row.seq });
    return row.seq;
  });
}

type NewGrant = Omit<typeof permissionGrants.$inferInsert, "id">;

async function insertGrant(values: NewGrant): Promise<string> {
  const id = newUuidV7();
  await database()
    .insert(permissionGrants)
    .values({ ...values, id });
  return id;
}

type NewRun = Omit<typeof agentRuns.$inferInsert, "id">;

async function insertRun(values: NewRun): Promise<RunId> {
  const id = newId<RunId>();
  await database()
    .insert(agentRuns)
    .values({ ...values, id });
  return id;
}

/** The quoted values of a CHECK constraint such as `x in ('a', 'b')`. */
async function checkValues(constraint: string): Promise<string[]> {
  assert.ok(testDatabase);
  const result = await testDatabase.client.query<{ def: string }>(
    "select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1",
    [constraint],
  );
  const definition = result.rows[0]?.def;
  assert.ok(definition, `${constraint} exists`);
  return [...definition.matchAll(/'([^']+)'::text/g)].map(
    (match) => match[1] ?? "",
  );
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

test("the test database runs PostgreSQL 18", async () => {
  assert.ok(testDatabase);
  const result = await testDatabase.client.query<{ version: string }>(
    "select current_setting('server_version_num') as version",
  );
  assert.match(result.rows[0]?.version ?? "", /^18\d{4}$/);
});

test("the CHECK vocabularies equal the protocol constants", async () => {
  // Sorted arrays compare both directions and catch duplicates.
  assert.deepEqual(
    sorted(await checkValues("permission_grants_capability_check")),
    sorted(CAPABILITIES),
  );
  assert.deepEqual(
    sorted(await checkValues("agent_runs_state_check")),
    sorted(RUN_STATES),
  );
  assert.deepEqual(
    sorted(await checkValues("agent_runs_finished_at_check")),
    sorted(TERMINAL_RUN_STATES),
  );
  assert.deepEqual(
    sorted(await checkValues("devices_platform_check")),
    sorted(DEVICE_PLATFORMS),
  );
});

test("message sequence numbers are allocated per conversation", async () => {
  const db = database();
  const world = await seed();
  const second = await addConversation(world.project, world.alice);
  const fromAlice = {
    authorUserId: world.alice,
    senderDeviceId: world.aliceDevice,
  };
  assert.equal(
    await insertMessage({
      ...fromAlice,
      conversationId: world.conversation,
      body: "one",
    }),
    1,
  );
  assert.equal(
    await insertMessage({
      ...fromAlice,
      conversationId: world.conversation,
      body: "two",
    }),
    2,
  );
  assert.equal(
    await insertMessage({ ...fromAlice, conversationId: second, body: "one" }),
    1,
  );
  const lastSeqs = await db
    .select({ id: conversations.id, lastSeq: conversations.lastSeq })
    .from(conversations)
    .where(eq(conversations.projectId, world.project));
  assert.deepEqual(
    new Map(lastSeqs.map((row) => [row.id, row.lastSeq])),
    new Map([
      [world.conversation, 2],
      [second, 1],
    ]),
  );
  const duplicate = {
    ...fromAlice,
    id: newUuidV7(),
    conversationId: world.conversation,
    body: "again",
  };
  await rejectsWith(
    () => db.insert(messages).values({ ...duplicate, seq: 1 }),
    "23505",
    "messages_conversation_id_seq_key",
  );
  await rejectsWith(
    () => db.insert(messages).values({ ...duplicate, seq: 0 }),
    "23514",
    "messages_seq_check",
  );
});

test("messages are idempotent per device and have exactly one author", async () => {
  const world = await seed();
  const clientEventId = newId<EventId>();
  const fromAlice = {
    conversationId: world.conversation,
    authorUserId: world.alice,
    senderDeviceId: world.aliceDevice,
  };
  await insertMessage({ ...fromAlice, clientEventId, body: "hello" });
  // A device retry of the same event fails instead of creating a duplicate.
  await rejectsWith(
    () => insertMessage({ ...fromAlice, clientEventId, body: "hello" }),
    "23505",
    "messages_sender_device_client_event_key",
  );
  // The key is per sending device, and messages without a client event ID never collide.
  await insertMessage({
    conversationId: world.conversation,
    authorUserId: world.bob,
    senderDeviceId: world.bobDevice,
    clientEventId,
    body: "hello",
  });
  await insertMessage({ ...fromAlice, body: "no event ID" });
  await insertMessage({ ...fromAlice, body: "no event ID" });

  await rejectsWith(
    () =>
      insertMessage({
        ...fromAlice,
        authorAgentId: world.aliceAgent,
        body: "two authors",
      }),
    "23514",
    "messages_author_check",
  );
  await rejectsWith(
    () =>
      insertMessage({
        conversationId: world.conversation,
        senderDeviceId: world.aliceDevice,
        body: "no author",
      }),
    "23514",
    "messages_author_check",
  );
  await rejectsWith(
    () => insertMessage({ ...fromAlice, body: "" }),
    "23514",
    "messages_body_length",
  );
  await rejectsWith(
    () => insertMessage({ ...fromAlice, body: "x".repeat(16_001) }),
    "23514",
    "messages_body_length",
  );
  await insertMessage({ ...fromAlice, body: "x".repeat(16_000) });
});

test("permission grants: one capability per row, scoped, unique while active", async () => {
  const db = database();
  const world = await seed();
  const byAlice = {
    projectId: world.project,
    granteeAgentId: world.aliceAgent,
    grantedByUserId: world.alice,
  };
  const grantIds = new Map<Capability, string>();
  for (const capability of CAPABILITIES) {
    const repositoryId =
      capability === "provider.use" ? undefined : world.repository;
    grantIds.set(
      capability,
      await insertGrant({ ...byAlice, capability, repositoryId }),
    );
  }

  await rejectsWith(
    () =>
      insertGrant({
        ...byAlice,
        capability: "repo.read",
        repositoryId: world.repository,
      }),
    "23505",
    "permission_grants_active_repository_key",
  );
  await rejectsWith(
    () => insertGrant({ ...byAlice, capability: "provider.use" }),
    "23505",
    "permission_grants_active_unscoped_key",
  );
  await rejectsWith(
    () => insertGrant({ ...byAlice, capability: "repo.read" }),
    "23514",
    "permission_grants_scope_check",
  );
  await rejectsWith(
    () =>
      insertGrant({
        ...byAlice,
        capability: "provider.use",
        repositoryId: world.repository,
      }),
    "23514",
    "permission_grants_scope_check",
  );
  for (const capability of ["repo.*", "REPO.READ", "repo.admin"]) {
    await rejectsWith(
      () =>
        insertGrant({
          ...byAlice,
          capability: capability as Capability,
          repositoryId: world.repository,
        }),
      "23514",
      "permission_grants_capability_check",
    );
  }

  // Revoke git.push, then grant it again.
  const gitPush = grantIds.get("git.push");
  assert.ok(gitPush);
  await rejectsWith(
    () =>
      db
        .update(permissionGrants)
        .set({ revokedAt: new Date() })
        .where(eq(permissionGrants.id, gitPush)),
    "23514",
    "permission_grants_revocation_check",
  );
  await db
    .update(permissionGrants)
    .set({ revokedAt: new Date(), revokedByUserId: world.alice })
    .where(eq(permissionGrants.id, gitPush));
  await insertGrant({
    ...byAlice,
    capability: "git.push",
    repositoryId: world.repository,
  });

  // expires_at must be after created_at.
  const createdAt = new Date("2026-10-27T12:00:00.000Z");
  const byBob = {
    projectId: world.project,
    granteeAgentId: world.bobAgent,
    grantedByUserId: world.bob,
    capability: "repo.read" as const,
    repositoryId: world.repository,
    createdAt,
  };
  for (const expiresAt of [createdAt, new Date(createdAt.getTime() - 1)]) {
    await rejectsWith(
      () => insertGrant({ ...byBob, expiresAt }),
      "23514",
      "permission_grants_expiry_check",
    );
  }
  await insertGrant({
    ...byBob,
    expiresAt: new Date(createdAt.getTime() + 60_000),
  });
});

test("composite foreign keys reject rows that mix owners, devices and projects", async () => {
  const world = await seed();
  const db = database();
  const cases: [string, () => Promise<unknown>][] = [
    [
      "agents_host_device_owner_fk",
      // An agent of Alice on Bob's device.
      () =>
        db.insert(agents).values({
          id: newId<AgentId>(),
          projectId: world.project,
          ownerUserId: world.alice,
          hostDeviceId: world.bobDevice,
          name: "Intruder",
        }),
    ],
    [
      "permission_grants_repository_project_fk",
      // A grant on a repository of another project.
      () =>
        insertGrant({
          projectId: world.project,
          granteeAgentId: world.aliceAgent,
          grantedByUserId: world.alice,
          capability: "repo.read",
          repositoryId: world.otherRepository,
        }),
    ],
    [
      "permission_grants_agent_project_fk",
      // A grant recorded in another project than the agent's.
      () =>
        insertGrant({
          projectId: world.otherProject,
          granteeAgentId: world.aliceAgent,
          grantedByUserId: world.alice,
          capability: "provider.use",
        }),
    ],
    [
      "permission_grants_agent_owner_fk",
      // Alice grants a capability to Bob's agent (P-44).
      () =>
        insertGrant({
          projectId: world.project,
          granteeAgentId: world.bobAgent,
          grantedByUserId: world.alice,
          capability: "provider.use",
        }),
    ],
    [
      "messages_sender_device_user_fk",
      // A message of Alice sent from Bob's device.
      () =>
        insertMessage({
          conversationId: world.conversation,
          authorUserId: world.alice,
          senderDeviceId: world.bobDevice,
          body: "spoofed",
        }),
    ],
    [
      "messages_agent_host_device_fk",
      // A message of Bob's agent sent from Alice's device.
      () =>
        insertMessage({
          conversationId: world.conversation,
          authorAgentId: world.bobAgent,
          senderDeviceId: world.aliceDevice,
          body: "spoofed",
        }),
    ],
    [
      "agent_runs_agent_project_fk",
      // A run recorded in another project than the agent's.
      () =>
        insertRun({
          agentId: world.aliceAgent,
          projectId: world.otherProject,
          requestedByUserId: world.alice,
          state: "queued",
        }),
    ],
    [
      "agent_runs_repository_project_fk",
      // A run on a repository of another project.
      () =>
        insertRun({
          agentId: world.aliceAgent,
          projectId: world.project,
          repositoryId: world.otherRepository,
          requestedByUserId: world.alice,
          state: "queued",
        }),
    ],
  ];
  assert.equal(cases.length, 8);
  for (const [constraint, operation] of cases) {
    await rejectsWith(operation, "23503", constraint);
  }

  // Consistent rows, including null optional columns, are accepted.
  await insertRun({
    agentId: world.aliceAgent,
    projectId: world.project,
    requestedByUserId: world.alice,
    state: "queued",
  });
  await insertRun({
    agentId: world.bobAgent,
    projectId: world.project,
    repositoryId: world.repository,
    requestedByUserId: world.alice,
    state: "queued",
  });
  await insertGrant({
    projectId: world.project,
    granteeAgentId: world.bobAgent,
    grantedByUserId: world.bob,
    capability: "provider.use",
  });
  await insertMessage({
    conversationId: world.conversation,
    authorUserId: world.bob,
    senderDeviceId: world.bobDevice,
    body: "from Bob",
  });
  await insertMessage({
    conversationId: world.conversation,
    authorAgentId: world.aliceAgent,
    senderDeviceId: world.aliceDevice,
    body: "from Alice's agent",
  });
});

test("finished_at is set exactly when a run is terminal", async () => {
  const world = await seed();
  const run = {
    agentId: world.aliceAgent,
    projectId: world.project,
    requestedByUserId: world.alice,
  };
  const finishedAt = new Date();
  for (const state of RUN_STATES) {
    const terminal = (TERMINAL_RUN_STATES as readonly RunState[]).includes(
      state,
    );
    await insertRun({
      ...run,
      state,
      finishedAt: terminal ? finishedAt : undefined,
    });
    await rejectsWith(
      () =>
        insertRun({
          ...run,
          state,
          finishedAt: terminal ? undefined : finishedAt,
        }),
      "23514",
      "agent_runs_finished_at_check",
    );
  }
  await rejectsWith(
    () => insertRun({ ...run, state: "paused" as RunState }),
    "23514",
    "agent_runs_state_check",
  );
  await rejectsWith(
    () => insertRun({ ...run, state: "failed", finishedAt, stateReason: "" }),
    "23514",
    "agent_runs_state_reason_length",
  );
});

test("a missing parent fails with 23503 and deleting a referenced row with 23001", async () => {
  const db = database();
  await rejectsWith(
    () =>
      db.insert(devices).values({
        id: newId<DeviceId>(),
        userId: newId<UserId>(),
        label: "Orphan",
        platform: "macos",
      }),
    "23503",
    "devices_user_id_users_id_fk",
  );
  const userId = newId<UserId>();
  await db.insert(users).values({ id: userId, displayName: "Carol" });
  await db.insert(devices).values({
    id: newId<DeviceId>(),
    userId,
    label: "Tablet",
    platform: "linux",
  });
  await rejectsWith(
    () => db.delete(users).where(eq(users.id, userId)),
    "23001",
    "devices_user_id_users_id_fk",
  );
});

test("updated_at increases when a row is updated", async () => {
  const db = database();
  const world = await seed();
  const [original] = await db
    .select({ createdAt: projects.createdAt, updatedAt: projects.updatedAt })
    .from(projects)
    .where(eq(projects.id, world.project));
  assert.ok(original);
  // The data layer sets updated_at with millisecond precision, the database
  // default with microseconds, so the update waits for a later millisecond.
  await sleep(5);
  const [updated] = await db
    .update(projects)
    .set({ name: "Renamed" })
    .where(eq(projects.id, world.project))
    .returning({
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    });
  assert.ok(updated);
  assert.ok(updated.updatedAt > original.updatedAt);
  assert.equal(updated.createdAt.getTime(), original.createdAt.getTime());
});

test("a DeviceId is not assignable to a UserId column (checked by tsc)", () => {
  const deviceId = newId<DeviceId>();
  const values = {
    id: newId<DeviceId>(),
    // @ts-expect-error A DeviceId is not a UserId.
    userId: deviceId,
    label: "Laptop",
    platform: "macos",
  } satisfies typeof devices.$inferInsert;
  assert.equal(values.userId, deviceId);
});

test("database errors never carry query data out of the package", async () => {
  const world = await seed();
  const secret = `SECRET_TOKEN_MATERIAL_${newUuidV7()}`;
  const clientEventId = newId<EventId>();
  const message = {
    conversationId: world.conversation,
    authorUserId: world.alice,
    senderDeviceId: world.aliceDevice,
    clientEventId,
  };
  await insertMessage({ ...message, body: `first ${secret}` });

  let raw: unknown;
  try {
    await insertMessage({ ...message, body: `retry ${secret}` });
  } catch (error) {
    raw = error;
  }
  // The raw Drizzle error repeats the SQL and every parameter: this is the risk.
  assert.ok(raw instanceof Error);
  assert.ok(raw.message.includes(secret));

  const converted = toDatabaseError(raw);
  assert.equal(converted.code, "23505");
  assert.equal(converted.constraint, "messages_sender_device_client_event_key");
  for (const text of [
    converted.message,
    converted.stack ?? "",
    JSON.stringify(converted),
  ]) {
    assert.equal(text.includes(secret), false);
    // The driver's detail repeats key values; they are dropped too.
    assert.equal(text.includes(clientEventId), false);
  }
  assert.equal(converted.cause, undefined);

  await assert.rejects(
    withDatabaseErrors(() =>
      insertMessage({ ...message, body: `again ${secret}` }),
    ),
    (error: unknown) =>
      error instanceof DatabaseError &&
      error.code === "23505" &&
      !error.message.includes(secret),
  );
});

test("the application role can insert and update but not delete or change the schema", async () => {
  // A fresh instance: roles and ownership are set before the first migration.
  const client = await PGlite.create();
  try {
    await client.exec(`
      create role mymandev_migrator;
      create role mymandev_app;
      alter database postgres owner to mymandev_migrator;
      revoke create on schema public from public;
      alter default privileges for role mymandev_migrator in schema public
        grant select, insert, update on tables to mymandev_app;
    `);
    const db = drizzle({ client, schema });
    await client.exec("set role mymandev_migrator");
    await migrate(db, { migrationsFolder });
    const owners = await client.query<{ owner: string }>(
      "select distinct tableowner as owner from pg_tables where schemaname in ('public', 'drizzle')",
    );
    assert.deepEqual(
      owners.rows.map((row) => row.owner),
      ["mymandev_migrator"],
    );

    await client.exec("set role mymandev_app");
    const userId = newId<UserId>();
    await db.insert(users).values({ id: userId, displayName: "App" });
    await db
      .update(users)
      .set({ displayName: "App user" })
      .where(eq(users.id, userId));
    const forbidden: SQL[] = [
      sql`delete from users`,
      sql`truncate users`,
      sql`create table app_owned (id integer)`,
      sql`drop table users`,
      sql`select * from drizzle.__drizzle_migrations`,
    ];
    for (const statement of forbidden) {
      await rejectsWith(() => db.execute(statement), "42501");
    }
  } finally {
    await client.close();
  }
});
