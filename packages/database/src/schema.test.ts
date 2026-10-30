import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  CAPABILITIES,
  DEVICE_KEY_ALGORITHMS,
  DEVICE_PLATFORMS,
  DEVICE_PUBLIC_KEY_PATTERN,
  DEVICE_REVOCATION_REASONS,
  GITHUB_LOGIN_PATTERN,
  IDENTITY_PROVIDERS,
  JOIN_REQUEST_DECISIONS,
  MEMBER_ROLES,
  newId,
  newUuidV7,
  RUN_STATES,
  TERMINAL_RUN_STATES,
  type AgentId,
  type Capability,
  type DeviceId,
  type DeviceKeyAlgorithm,
  type DeviceRevocationReason,
  type EventId,
  type IdentityProvider,
  type InvitationId,
  type JoinRequestDecision,
  type JoinRequestId,
  type MemberId,
  type MemberRole,
  type PermissionGrantId,
  type ProjectId,
  type ProviderConnectionId,
  type RepositoryId,
  type RunId,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  AUDIT_ACTIONS,
  AUDIT_REASONS,
  type AuditAction,
  type AuditReason,
} from "./audit-vocabulary.ts";
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
  auditEvents,
  conversations,
  devices,
  messages,
  permissionGrants,
  projects,
  providerConnections,
  repositories,
  userIdentities,
  users,
  workspaceInvitations,
  workspaceJoinRequests,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";
import { createTestDatabase } from "./testing.ts";

// One test database for this file: PGlite, or a database on the server in
// DATABASE_TEST_URL. The role test always creates its own PGlite instance.
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

/** A public key of the size of an Ed25519 key, as lowercase hexadecimal. */
function publicKey(): string {
  return randomBytes(32).toString("hex");
}

/** The values of a new, signed-in device of the user. */
function newDevice(
  userId: UserId,
  overrides: Partial<typeof devices.$inferInsert> = {},
): typeof devices.$inferInsert {
  return {
    id: newId<DeviceId>(),
    userId,
    label: "Laptop",
    platform: "macos",
    publicKey: publicKey(),
    keyAlgorithm: "ed25519",
    lastSignInAt: new Date(),
    ...overrides,
  };
}

/** The values of a person in the workspace who is claimed by the user. */
function claimedMember(
  workspaceId: WorkspaceId,
  userId: UserId,
  overrides: Partial<typeof workspaceMembers.$inferInsert> = {},
): typeof workspaceMembers.$inferInsert {
  return {
    id: newId<MemberId>(),
    workspaceId,
    userId,
    displayName: "Person",
    role: "member",
    addedByUserId: userId,
    claimedAt: new Date(),
    ...overrides,
  };
}

/** Two users with one device each, sharing a workspace with two projects. */
type World = {
  alice: UserId;
  bob: UserId;
  aliceDevice: DeviceId;
  bobDevice: DeviceId;
  /** On Alice's device. */
  aliceConnection: ProviderConnectionId;
  /** On Bob's device. */
  bobConnection: ProviderConnectionId;
  workspace: WorkspaceId;
  /** Alice is the owner of `workspace`, Bob a member. */
  aliceMember: MemberId;
  bobMember: MemberId;
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
  await db
    .insert(devices)
    .values([
      newDevice(alice, { id: aliceDevice, platform: "windows" }),
      newDevice(bob, { id: bobDevice, label: "Desktop", platform: "linux" }),
    ]);
  const aliceConnection = newId<ProviderConnectionId>();
  const bobConnection = newId<ProviderConnectionId>();
  await db.insert(providerConnections).values([
    { id: aliceConnection, hostDeviceId: aliceDevice },
    { id: bobConnection, hostDeviceId: bobDevice },
  ]);
  const workspace = newId<WorkspaceId>();
  await db
    .insert(workspaces)
    .values({ id: workspace, name: "Team", createdByUserId: alice });
  const aliceMember = newId<MemberId>();
  const bobMember = newId<MemberId>();
  await db.insert(workspaceMembers).values([
    claimedMember(workspace, alice, {
      id: aliceMember,
      displayName: "Alice",
      role: "owner",
    }),
    claimedMember(workspace, bob, {
      id: bobMember,
      displayName: "Bob",
      addedByUserId: alice,
    }),
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
    aliceConnection,
    bobConnection,
    workspace,
    aliceMember,
    bobMember,
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

async function insertGrant(values: NewGrant): Promise<PermissionGrantId> {
  const id = newId<PermissionGrantId>();
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
  assert.deepEqual(
    sorted(await checkValues("devices_key_algorithm_check")),
    sorted(DEVICE_KEY_ALGORITHMS),
  );
  assert.deepEqual(
    sorted(await checkValues("devices_revocation_reason_check")),
    sorted(DEVICE_REVOCATION_REASONS),
  );
  assert.deepEqual(
    sorted(await checkValues("workspace_members_role_check")),
    sorted(MEMBER_ROLES),
  );
  assert.deepEqual(
    sorted(await checkValues("workspace_join_requests_decision_check")),
    sorted(JOIN_REQUEST_DECISIONS),
  );
  assert.deepEqual(
    sorted(await checkValues("user_identities_identity_provider_check")),
    sorted(IDENTITY_PROVIDERS),
  );
  // The server-only vocabularies of packages/database.
  assert.deepEqual(
    sorted(await checkValues("audit_events_action_check")),
    sorted(AUDIT_ACTIONS),
  );
  assert.deepEqual(
    sorted(await checkValues("audit_events_reason_check")),
    sorted(AUDIT_REASONS),
  );
  // A device revocation is audited with its reason.
  for (const reason of DEVICE_REVOCATION_REASONS) {
    assert.ok(AUDIT_REASONS.includes(reason), reason);
  }
  // The GitHub login and the public key CHECKs use the protocol's patterns.
  assert.deepEqual(await checkValues("user_identities_github_login_check"), [
    "github",
    GITHUB_LOGIN_PATTERN.source,
  ]);
  assert.deepEqual(await checkValues("devices_public_key_check"), [
    "ed25519",
    DEVICE_PUBLIC_KEY_PATTERN.source,
  ]);
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
    hostDeviceId: world.aliceDevice,
    grantedByUserId: world.alice,
  };
  const grantIds = new Map<Capability, PermissionGrantId>();
  for (const capability of CAPABILITIES) {
    const scope =
      capability === "provider.use"
        ? { providerConnectionId: world.aliceConnection }
        : { repositoryId: world.repository };
    grantIds.set(
      capability,
      await insertGrant({ ...byAlice, capability, ...scope }),
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
    () =>
      insertGrant({
        ...byAlice,
        capability: "provider.use",
        providerConnectionId: world.aliceConnection,
      }),
    "23505",
    "permission_grants_active_provider_connection_key",
  );
  // Another connection on the same device is a separate scope.
  const secondConnection = newId<ProviderConnectionId>();
  await db
    .insert(providerConnections)
    .values({ id: secondConnection, hostDeviceId: world.aliceDevice });
  await insertGrant({
    ...byAlice,
    capability: "provider.use",
    providerConnectionId: secondConnection,
  });

  // Exactly one scope, and the provider connection exactly for provider.use.
  const scopeCases: [string, Partial<NewGrant>][] = [
    ["repo.read without a scope", { capability: "repo.read" }],
    ["provider.use without a scope", { capability: "provider.use" }],
    [
      "provider.use on a repository",
      { capability: "provider.use", repositoryId: world.repository },
    ],
    [
      "repo.read on a provider connection",
      { capability: "repo.read", providerConnectionId: world.aliceConnection },
    ],
    [
      "provider.use with both scopes",
      {
        capability: "provider.use",
        repositoryId: world.repository,
        providerConnectionId: world.aliceConnection,
      },
    ],
    [
      "repo.read with both scopes",
      {
        capability: "repo.read",
        repositoryId: world.repository,
        providerConnectionId: world.aliceConnection,
      },
    ],
  ];
  assert.equal(scopeCases.length, 6);
  for (const [label, values] of scopeCases) {
    await rejectsWith(
      () => insertGrant({ ...byAlice, capability: "repo.read", ...values }),
      "23514",
      "permission_grants_scope_check",
    ).catch((error: unknown) => {
      throw new Error(label, { cause: error });
    });
  }
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
    hostDeviceId: world.bobDevice,
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
          hostDeviceId: world.aliceDevice,
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
          hostDeviceId: world.aliceDevice,
          grantedByUserId: world.alice,
          capability: "provider.use",
          providerConnectionId: world.aliceConnection,
        }),
    ],
    [
      "permission_grants_agent_owner_fk",
      // Alice grants a capability to Bob's agent (P-44).
      () =>
        insertGrant({
          projectId: world.project,
          granteeAgentId: world.bobAgent,
          hostDeviceId: world.bobDevice,
          grantedByUserId: world.alice,
          capability: "provider.use",
          providerConnectionId: world.bobConnection,
        }),
    ],
    [
      "permission_grants_agent_host_device_fk",
      // A grant that names another host device than the agent's.
      () =>
        insertGrant({
          projectId: world.project,
          granteeAgentId: world.aliceAgent,
          hostDeviceId: world.bobDevice,
          grantedByUserId: world.alice,
          capability: "repo.read",
          repositoryId: world.repository,
        }),
    ],
    [
      "permission_grants_provider_connection_device_fk",
      // provider.use for Alice's agent on a connection of Bob's device (P-82).
      () =>
        insertGrant({
          projectId: world.project,
          granteeAgentId: world.aliceAgent,
          hostDeviceId: world.aliceDevice,
          grantedByUserId: world.alice,
          capability: "provider.use",
          providerConnectionId: world.bobConnection,
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
  assert.equal(cases.length, 10);
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
    hostDeviceId: world.bobDevice,
    grantedByUserId: world.bob,
    capability: "provider.use",
    providerConnectionId: world.bobConnection,
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
      db
        .insert(devices)
        .values(newDevice(newId<UserId>(), { label: "Orphan" })),
    "23503",
    "devices_user_id_users_id_fk",
  );
  const userId = newId<UserId>();
  await db.insert(users).values({ id: userId, displayName: "Carol" });
  await db
    .insert(devices)
    .values(newDevice(userId, { label: "Tablet", platform: "linux" }));
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
    publicKey: publicKey(),
    keyAlgorithm: "ed25519",
    lastSignInAt: new Date(),
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
      revoke all on database postgres from public;
      grant connect on database postgres to mymandev_app;
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
      sql`create temporary table app_temporary (id integer)`,
      sql`drop table users`,
      sql`select * from drizzle.__drizzle_migrations`,
    ];
    for (const statement of forbidden) {
      await rejectsWith(() => db.execute(statement), "42501");
    }
    // No table, including the account tables of ADR 0014, allows deleting rows.
    const tables = await client.query<{ name: string; deletable: boolean }>(
      `select tablename as name,
         has_table_privilege('mymandev_app', format('public.%I', tablename), 'DELETE')
           or has_table_privilege('mymandev_app', format('public.%I', tablename), 'TRUNCATE') as deletable
       from pg_tables where schemaname = 'public' order by tablename`,
    );
    assert.ok(tables.rows.some((row) => row.name === "audit_events"));
    assert.ok(
      tables.rows.some((row) => row.name === "workspace_join_requests"),
    );
    assert.deepEqual(
      tables.rows.filter((row) => row.deletable).map((row) => row.name),
      [],
    );
  } finally {
    await client.close();
  }
});

// The account, device key, membership and audit tables of ADR 0014 (#86).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A GitHub identity of the user with a fresh numeric account ID. */
function githubIdentity(
  userId: UserId,
  overrides: Partial<typeof userIdentities.$inferInsert> = {},
): typeof userIdentities.$inferInsert {
  return {
    id: newUuidV7(),
    userId,
    identityProvider: "github",
    subject: String(randomInt(1, 2 ** 47)),
    login: "octocat",
    accountCreatedAt: new Date("2015-01-01T00:00:00Z"),
    lastSignInAt: new Date(),
    ...overrides,
  };
}

/** A person in the workspace whom no account has claimed yet. */
function unclaimedMember(
  workspaceId: WorkspaceId,
  addedByUserId: UserId,
  overrides: Partial<typeof workspaceMembers.$inferInsert> = {},
): typeof workspaceMembers.$inferInsert {
  return {
    id: newId<MemberId>(),
    workspaceId,
    displayName: "Guest",
    role: "member",
    addedByUserId,
    ...overrides,
  };
}

/** An invitation for the person, created now and valid for 7 days. */
function invitation(
  workspaceId: WorkspaceId,
  memberId: MemberId,
  createdByUserId: UserId,
  overrides: Partial<typeof workspaceInvitations.$inferInsert> = {},
): typeof workspaceInvitations.$inferInsert {
  const createdAt = new Date();
  return {
    id: newId<InvitationId>(),
    workspaceId,
    memberId,
    tokenHash: randomBytes(32).toString("hex"),
    createdByUserId,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 7 * DAY),
    ...overrides,
  };
}

/** A pending join request of the account from its device. */
function joinRequest(
  workspaceId: WorkspaceId,
  requesterUserId: UserId,
  requesterDeviceId: DeviceId,
  overrides: Partial<typeof workspaceJoinRequests.$inferInsert> = {},
): typeof workspaceJoinRequests.$inferInsert {
  return {
    id: newId<JoinRequestId>(),
    workspaceId,
    requesterUserId,
    requesterDeviceId,
    requestedDisplayName: "Carol",
    expiresAt: new Date(Date.now() + 7 * DAY),
    ...overrides,
  };
}

/** A user who is in no workspace yet, with one device. */
async function outsider(
  name: string,
): Promise<{ user: UserId; device: DeviceId }> {
  const db = database();
  const user = newId<UserId>();
  await db.insert(users).values({ id: user, displayName: name });
  const device = newId<DeviceId>();
  await db.insert(devices).values(newDevice(user, { id: device }));
  return { user, device };
}

/** Another workspace of Alice with one unclaimed person. */
async function otherWorkspace(
  world: World,
): Promise<{ workspace: WorkspaceId; member: MemberId }> {
  const db = database();
  const workspace = newId<WorkspaceId>();
  await db
    .insert(workspaces)
    .values({ id: workspace, name: "Other", createdByUserId: world.alice });
  const member = newId<MemberId>();
  await db
    .insert(workspaceMembers)
    .values(unclaimedMember(workspace, world.alice, { id: member }));
  return { workspace, member };
}

type Case = [
  code: string,
  constraint: string,
  operation: () => Promise<unknown>,
];

async function rejectsAll(cases: Case[]): Promise<void> {
  for (const [code, constraint, operation] of cases) {
    await rejectsWith(operation, code, constraint);
  }
}

test("user identities: one per account and provider, GitHub formats, and erasure", async () => {
  const db = database();
  const world = await seed();
  const identity = githubIdentity(world.alice);
  await db.insert(userIdentities).values(identity);
  const ofAlice = eq(userIdentities.id, identity.id);
  await rejectsAll([
    [
      "23505",
      "user_identities_identity_provider_subject_key",
      () =>
        db
          .insert(userIdentities)
          .values(githubIdentity(world.bob, { subject: identity.subject })),
    ],
    [
      "23505",
      "user_identities_user_id_identity_provider_key",
      () => db.insert(userIdentities).values(githubIdentity(world.alice)),
    ],
    [
      "23514",
      "user_identities_identity_provider_check",
      () =>
        db.insert(userIdentities).values(
          githubIdentity(world.bob, {
            identityProvider: "gitlab" as string as IdentityProvider,
          }),
        ),
    ],
    [
      "23514",
      "user_identities_github_subject_check",
      () =>
        db
          .insert(userIdentities)
          .values(githubIdentity(world.bob, { subject: "0123" })),
    ],
    [
      "23514",
      "user_identities_github_subject_check",
      () =>
        db
          .insert(userIdentities)
          .values(githubIdentity(world.bob, { subject: "1".repeat(20) })),
    ],
    [
      "23514",
      "user_identities_github_login_check",
      () =>
        db
          .insert(userIdentities)
          .values(githubIdentity(world.bob, { login: "not a login" })),
    ],
    // An erased identity that keeps its login.
    [
      "23514",
      "user_identities_erasure_check",
      () =>
        db
          .update(userIdentities)
          .set({ erasedAt: new Date(), subject: null, accountCreatedAt: null })
          .where(ofAlice),
    ],
    // A cleared subject without erased_at.
    [
      "23514",
      "user_identities_erasure_check",
      () => db.update(userIdentities).set({ subject: null }).where(ofAlice),
    ],
  ]);

  // Erasure clears every identifying column. The GitHub account can then sign
  // in again as a new account, because no synthetic subject was written.
  await db
    .update(userIdentities)
    .set({
      erasedAt: new Date(),
      subject: null,
      login: null,
      accountCreatedAt: null,
    })
    .where(ofAlice);
  await db
    .insert(userIdentities)
    .values(githubIdentity(world.bob, { subject: identity.subject }));
});

test("devices: lowercase hexadecimal public keys, unique, and a reason for every revocation", async () => {
  const db = database();
  const world = await seed();
  const [aliceDevice] = await db
    .select({ publicKey: devices.publicKey })
    .from(devices)
    .where(eq(devices.id, world.aliceDevice));
  assert.ok(aliceDevice);
  const ofBob = eq(devices.id, world.bobDevice);
  await rejectsAll([
    [
      "23514",
      "devices_public_key_check",
      () =>
        db
          .insert(devices)
          .values(
            newDevice(world.alice, { publicKey: publicKey().toUpperCase() }),
          ),
    ],
    [
      "23514",
      "devices_public_key_check",
      () =>
        db.insert(devices).values(newDevice(world.alice, { publicKey: "ab" })),
    ],
    [
      "23505",
      "devices_public_key_key",
      () =>
        db
          .insert(devices)
          .values(newDevice(world.bob, { publicKey: aliceDevice.publicKey })),
    ],
    [
      "23514",
      "devices_key_algorithm_check",
      () =>
        db.insert(devices).values(
          newDevice(world.alice, {
            keyAlgorithm: "rsa" as string as DeviceKeyAlgorithm,
          }),
        ),
    ],
    [
      "23514",
      "devices_revocation_check",
      () => db.update(devices).set({ revokedAt: new Date() }).where(ofBob),
    ],
    [
      "23514",
      "devices_revocation_check",
      () => db.update(devices).set({ revocationReason: "lost" }).where(ofBob),
    ],
    [
      "23514",
      "devices_revocation_reason_check",
      () =>
        db
          .update(devices)
          .set({
            revokedAt: new Date(),
            revocationReason: "stolen" as string as DeviceRevocationReason,
          })
          .where(ofBob),
    ],
  ]);
  await db
    .update(devices)
    .set({ revokedAt: new Date(), revocationReason: "lost" })
    .where(ofBob);
});

test("workspace members: claimed people, one active owner, one ownership offer", async () => {
  const db = database();
  const world = await seed();
  const carol = await outsider("Carol");
  const ofBob = eq(workspaceMembers.id, world.bobMember);
  await rejectsAll([
    // An unclaimed admin.
    [
      "23514",
      "workspace_members_unclaimed_role_check",
      () =>
        db
          .insert(workspaceMembers)
          .values(
            unclaimedMember(world.workspace, world.alice, { role: "admin" }),
          ),
    ],
    [
      "23514",
      "workspace_members_claim_check",
      () =>
        db
          .insert(workspaceMembers)
          .values(
            claimedMember(world.workspace, carol.user, { claimedAt: null }),
          ),
    ],
    [
      "23514",
      "workspace_members_role_check",
      () =>
        db.insert(workspaceMembers).values(
          claimedMember(world.workspace, carol.user, {
            role: "superadmin" as string as MemberRole,
          }),
        ),
    ],
    [
      "23514",
      "workspace_members_display_name_length",
      () =>
        db.insert(workspaceMembers).values(
          unclaimedMember(world.workspace, world.alice, {
            displayName: "x".repeat(65),
          }),
        ),
    ],
    // A second active owner.
    [
      "23505",
      "workspace_members_active_owner_key",
      () =>
        db
          .insert(workspaceMembers)
          .values(
            claimedMember(world.workspace, carol.user, { role: "owner" }),
          ),
    ],
    // A second active person for the same account.
    [
      "23505",
      "workspace_members_active_user_key",
      () =>
        db
          .insert(workspaceMembers)
          .values(claimedMember(world.workspace, world.alice)),
    ],
    // An ownership offer to the owner, and to an unclaimed person.
    [
      "23514",
      "workspace_members_ownership_offer_check",
      () =>
        db
          .update(workspaceMembers)
          .set({ ownershipOfferedAt: new Date() })
          .where(eq(workspaceMembers.id, world.aliceMember)),
    ],
    [
      "23514",
      "workspace_members_ownership_offer_check",
      () =>
        db.insert(workspaceMembers).values(
          unclaimedMember(world.workspace, world.alice, {
            ownershipOfferedAt: new Date(),
          }),
        ),
    ],
    [
      "23514",
      "workspace_members_removal_check",
      () =>
        db.update(workspaceMembers).set({ removedAt: new Date() }).where(ofBob),
    ],
  ]);

  // One offer per workspace.
  await db
    .update(workspaceMembers)
    .set({ ownershipOfferedAt: new Date() })
    .where(ofBob);
  const carolMember = newId<MemberId>();
  await db.insert(workspaceMembers).values(
    claimedMember(world.workspace, carol.user, {
      id: carolMember,
      role: "admin",
      addedByUserId: world.alice,
    }),
  );
  await rejectsAll([
    [
      "23505",
      "workspace_members_ownership_offer_key",
      () =>
        db
          .update(workspaceMembers)
          .set({ ownershipOfferedAt: new Date() })
          .where(eq(workspaceMembers.id, carolMember)),
    ],
    // A removed person keeps no offer.
    [
      "23514",
      "workspace_members_ownership_offer_check",
      () =>
        db
          .update(workspaceMembers)
          .set({ removedAt: new Date(), removedByUserId: world.alice })
          .where(ofBob),
    ],
  ]);

  // Ownership moves only by transfer (the owner is never removed). The owner
  // is demoted in a statement of its own first, because the partial unique
  // index is checked row by row; then the offered person becomes the owner and
  // the offer is cleared.
  await db.transaction(async (tx) => {
    await tx
      .update(workspaceMembers)
      .set({ role: "admin" })
      .where(eq(workspaceMembers.id, world.aliceMember));
    await tx
      .update(workspaceMembers)
      .set({ role: "owner", ownershipOfferedAt: null })
      .where(ofBob);
  });
  await rejectsWith(
    () =>
      db
        .update(workspaceMembers)
        .set({ role: "owner" })
        .where(eq(workspaceMembers.id, carolMember)),
    "23505",
    "workspace_members_active_owner_key",
  );

  // After removal, the account can be claimed again.
  await db
    .update(workspaceMembers)
    .set({ removedAt: new Date(), removedByUserId: world.bob })
    .where(eq(workspaceMembers.id, carolMember));
  await db
    .insert(workspaceMembers)
    .values(
      claimedMember(world.workspace, carol.user, { addedByUserId: world.bob }),
    );
});

test("workspace invitations: 1 hour to 7 days, one live invitation per person, accepted or revoked", async () => {
  const db = database();
  const world = await seed();
  const guest = newId<MemberId>();
  const otherGuest = newId<MemberId>();
  await db
    .insert(workspaceMembers)
    .values([
      unclaimedMember(world.workspace, world.alice, { id: guest }),
      unclaimedMember(world.workspace, world.alice, { id: otherGuest }),
    ]);
  const other = await otherWorkspace(world);
  const createdAt = new Date();
  const forGuest = (
    overrides: Partial<typeof workspaceInvitations.$inferInsert> = {},
  ) => invitation(world.workspace, guest, world.alice, overrides);
  await rejectsAll([
    [
      "23514",
      "workspace_invitations_expiry_check",
      () =>
        db.insert(workspaceInvitations).values(
          forGuest({
            createdAt,
            expiresAt: new Date(createdAt.getTime() + HOUR - 1),
          }),
        ),
    ],
    [
      "23514",
      "workspace_invitations_expiry_check",
      () =>
        db.insert(workspaceInvitations).values(
          forGuest({
            createdAt,
            expiresAt: new Date(createdAt.getTime() + 7 * DAY + 1),
          }),
        ),
    ],
    [
      "23514",
      "workspace_invitations_token_hash_check",
      () =>
        db.insert(workspaceInvitations).values(
          forGuest({
            tokenHash: randomBytes(32).toString("hex").toUpperCase(),
          }),
        ),
    ],
    // A person of another workspace.
    [
      "23503",
      "workspace_invitations_member_workspace_fk",
      () =>
        db
          .insert(workspaceInvitations)
          .values(invitation(world.workspace, other.member, world.alice)),
    ],
  ]);

  // The bounds themselves are allowed.
  const first = forGuest({
    createdAt,
    expiresAt: new Date(createdAt.getTime() + HOUR),
  });
  await db.insert(workspaceInvitations).values(first);
  const ofFirst = eq(workspaceInvitations.id, first.id);
  await rejectsAll([
    [
      "23505",
      "workspace_invitations_live_member_key",
      () => db.insert(workspaceInvitations).values(forGuest()),
    ],
    [
      "23505",
      "workspace_invitations_token_hash_key",
      () =>
        db.insert(workspaceInvitations).values(
          invitation(world.workspace, otherGuest, world.alice, {
            tokenHash: first.tokenHash,
          }),
        ),
    ],
    [
      "23514",
      "workspace_invitations_acceptance_check",
      () =>
        db
          .update(workspaceInvitations)
          .set({ acceptedAt: new Date() })
          .where(ofFirst),
    ],
    // Accepted with a device of another account.
    [
      "23503",
      "workspace_invitations_accepted_device_user_fk",
      () =>
        db
          .update(workspaceInvitations)
          .set({
            acceptedAt: new Date(),
            acceptedByUserId: world.bob,
            acceptedDeviceId: world.aliceDevice,
          })
          .where(ofFirst),
    ],
    [
      "23514",
      "workspace_invitations_revocation_check",
      () =>
        db
          .update(workspaceInvitations)
          .set({ revokedAt: new Date() })
          .where(ofFirst),
    ],
    // Both accepted and revoked.
    [
      "23514",
      "workspace_invitations_accepted_or_revoked_check",
      () =>
        db
          .update(workspaceInvitations)
          .set({
            acceptedAt: new Date(),
            acceptedByUserId: world.bob,
            acceptedDeviceId: world.bobDevice,
            revokedAt: new Date(),
            revokedByUserId: world.alice,
          })
          .where(ofFirst),
    ],
  ]);

  // A revoked invitation frees the person for a new one, at the 7-day bound.
  await db
    .update(workspaceInvitations)
    .set({ revokedAt: new Date(), revokedByUserId: world.alice })
    .where(ofFirst);
  await db.insert(workspaceInvitations).values(
    forGuest({
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 7 * DAY),
    }),
  );

  // An accepted invitation frees the person too.
  const accepted = invitation(world.workspace, otherGuest, world.alice);
  await db.insert(workspaceInvitations).values(accepted);
  await db
    .update(workspaceInvitations)
    .set({
      acceptedAt: new Date(),
      acceptedByUserId: world.bob,
      acceptedDeviceId: world.bobDevice,
    })
    .where(eq(workspaceInvitations.id, accepted.id));
  await db
    .insert(workspaceInvitations)
    .values(invitation(world.workspace, otherGuest, world.alice));
});

test("an invitation of exactly 7 days is valid across a daylight saving change", async () => {
  const world = await seed();
  const guest = newId<MemberId>();
  await database()
    .insert(workspaceMembers)
    .values(unclaimedMember(world.workspace, world.alice, { id: guest }));
  // New York moves its clocks forward on 2027-03-14, so 7 calendar days from
  // 2027-03-10 are 167 hours there. The CHECK counts 168 hours in every zone.
  const createdAt = new Date("2027-03-10T12:00:00Z");
  await database().transaction(async (tx) => {
    await tx.execute(sql`set local timezone = 'America/New_York'`);
    // node-postgres and PGlite both return the rows in `rows`.
    const days = (await tx.execute(
      sql`select extract(epoch from (${createdAt.toISOString()}::timestamptz + interval '7 days') - ${createdAt.toISOString()}::timestamptz) / 3600 as hours`,
    )) as unknown as { rows: { hours: string | number }[] };
    assert.equal(Number(days.rows[0]?.hours), 167);
    await tx.insert(workspaceInvitations).values(
      invitation(world.workspace, guest, world.alice, {
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 7 * DAY),
      }),
    );
  });
});

test("workspace join requests: one pending request, decisions, approval and unblocking", async () => {
  const db = database();
  const world = await seed();
  const carol = await outsider("Carol");
  const other = await otherWorkspace(world);
  const fromCarol = (
    overrides: Partial<typeof workspaceJoinRequests.$inferInsert> = {},
  ) => joinRequest(world.workspace, carol.user, carol.device, overrides);
  const decided = (
    decision: JoinRequestDecision,
    decidedByUserId: UserId | null = world.alice,
  ) => ({ decision, decidedAt: new Date(), decidedByUserId });
  await rejectsAll([
    // A device of another account.
    [
      "23503",
      "workspace_join_requests_requester_device_fk",
      () =>
        db
          .insert(workspaceJoinRequests)
          .values(fromCarol({ requesterDeviceId: world.aliceDevice })),
    ],
    [
      "23514",
      "workspace_join_requests_requested_display_name_length",
      () =>
        db
          .insert(workspaceJoinRequests)
          .values(fromCarol({ requestedDisplayName: "" })),
    ],
    [
      "23514",
      "workspace_join_requests_requested_display_name_length",
      () =>
        db
          .insert(workspaceJoinRequests)
          .values(fromCarol({ requestedDisplayName: "x".repeat(65) })),
    ],
    [
      "23514",
      "workspace_join_requests_decision_check",
      () =>
        db
          .insert(workspaceJoinRequests)
          .values(
            fromCarol(decided("accepted" as string as JoinRequestDecision)),
          ),
    ],
    [
      "23514",
      "workspace_join_requests_decided_check",
      () =>
        db
          .insert(workspaceJoinRequests)
          .values(
            fromCarol({ decision: "denied", decidedByUserId: world.alice }),
          ),
    ],
    // An approved request without the person it created.
    [
      "23514",
      "workspace_join_requests_member_check",
      () =>
        db.insert(workspaceJoinRequests).values(fromCarol(decided("approved"))),
    ],
    [
      "23514",
      "workspace_join_requests_member_check",
      () =>
        db
          .insert(workspaceJoinRequests)
          .values(
            fromCarol({ ...decided("denied"), memberId: world.bobMember }),
          ),
    ],
    [
      "23514",
      "workspace_join_requests_decided_by_check",
      () =>
        db
          .insert(workspaceJoinRequests)
          .values(fromCarol(decided("denied", null))),
    ],
    [
      "23514",
      "workspace_join_requests_decided_by_check",
      () =>
        db.insert(workspaceJoinRequests).values(fromCarol(decided("expired"))),
    ],
    // An approved person of another workspace.
    [
      "23503",
      "workspace_join_requests_member_workspace_fk",
      () =>
        db
          .insert(workspaceJoinRequests)
          .values(
            fromCarol({ ...decided("approved"), memberId: other.member }),
          ),
    ],
    // An unblock on a pending request.
    [
      "23514",
      "workspace_join_requests_unblocked_check",
      () =>
        db.insert(workspaceJoinRequests).values(
          fromCarol({
            unblockedAt: new Date(),
            unblockedByUserId: world.alice,
          }),
        ),
    ],
  ]);

  const first = fromCarol();
  await db.insert(workspaceJoinRequests).values(first);
  const ofFirst = eq(workspaceJoinRequests.id, first.id);
  await rejectsWith(
    () => db.insert(workspaceJoinRequests).values(fromCarol()),
    "23505",
    "workspace_join_requests_pending_key",
  );

  // A decided request frees the slot. An expired request has no decider.
  await db
    .update(workspaceJoinRequests)
    .set(decided("expired", null))
    .where(ofFirst);
  await rejectsWith(
    () =>
      db
        .update(workspaceJoinRequests)
        .set({ unblockedAt: new Date(), unblockedByUserId: world.alice })
        .where(ofFirst),
    "23514",
    "workspace_join_requests_unblocked_check",
  );
  const blocked = fromCarol(decided("blocked"));
  await db.insert(workspaceJoinRequests).values(blocked);
  await rejectsWith(
    () =>
      db
        .update(workspaceJoinRequests)
        .set({ unblockedAt: new Date() })
        .where(eq(workspaceJoinRequests.id, blocked.id)),
    "23514",
    "workspace_join_requests_unblocked_check",
  );
  await db
    .update(workspaceJoinRequests)
    .set({ unblockedAt: new Date(), unblockedByUserId: world.alice })
    .where(eq(workspaceJoinRequests.id, blocked.id));

  // An approval records the person it created.
  const carolMember = newId<MemberId>();
  await db.insert(workspaceMembers).values(
    claimedMember(world.workspace, carol.user, {
      id: carolMember,
      addedByUserId: world.alice,
    }),
  );
  await db
    .insert(workspaceJoinRequests)
    .values(fromCarol({ ...decided("approved"), memberId: carolMember }));
});

test("audit events: closed vocabularies, the actor's own device, one record per webhook delivery", async () => {
  const db = database();
  const world = await seed();
  const record = (
    overrides: Partial<typeof auditEvents.$inferInsert> = {},
  ): typeof auditEvents.$inferInsert => ({
    id: newUuidV7(),
    action: "device.revoked",
    actorUserId: world.alice,
    actorDeviceId: world.aliceDevice,
    workspaceId: world.workspace,
    subjectId: world.bobDevice,
    reason: "lost",
    ...overrides,
  });
  await db.insert(auditEvents).values(record());
  // An action of the server has no actor.
  const delivery = record({
    action: "github.authorization_revoked",
    actorUserId: null,
    actorDeviceId: null,
    workspaceId: null,
    subjectId: world.bob,
    reason: null,
    githubDeliveryId: newUuidV7(),
  });
  await db.insert(auditEvents).values(delivery);
  await rejectsAll([
    [
      "23514",
      "audit_events_action_check",
      () =>
        db
          .insert(auditEvents)
          .values(record({ action: "device.stolen" as string as AuditAction })),
    ],
    [
      "23514",
      "audit_events_reason_check",
      () =>
        db
          .insert(auditEvents)
          .values(record({ reason: "because" as string as AuditReason })),
    ],
    // A device without its account.
    [
      "23514",
      "audit_events_actor_device_check",
      () => db.insert(auditEvents).values(record({ actorUserId: null })),
    ],
    // A device of another account.
    [
      "23503",
      "audit_events_actor_device_user_fk",
      () => db.insert(auditEvents).values(record({ actorUserId: world.bob })),
    ],
    // A redelivered webhook.
    [
      "23505",
      "audit_events_github_delivery_id_key",
      () => db.insert(auditEvents).values({ ...delivery, id: newUuidV7() }),
    ],
  ]);
});

/**
 * The innermost cause of an error: the database's own error. The outer Drizzle
 * error repeats the SQL text, which would match any sentence of the migration.
 */
function rootCause(error: unknown): { code?: unknown; message?: unknown } {
  let current: unknown = error;
  while (
    typeof current === "object" &&
    current !== null &&
    "cause" in current &&
    current.cause !== undefined
  ) {
    current = current.cause;
  }
  return typeof current === "object" && current !== null ? current : {};
}

/** A copy of the migrations folder with only the first `count` migrations. */
async function firstMigrations(count: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "mymandev-migrations-"));
  await mkdir(join(folder, "meta"));
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(0, count);
  for (const { tag } of journal.entries) {
    await copyFile(
      join(migrationsFolder, `${tag}.sql`),
      join(folder, `${tag}.sql`),
    );
  }
  await writeFile(
    join(folder, "meta", "_journal.json"),
    JSON.stringify(journal),
  );
  return folder;
}

/** Applies 0000 and 0001, runs `prepare`, then applies the remaining migrations. */
async function upgradeFromProviderConnections(
  prepare: (client: PGlite) => Promise<void>,
  check: (upgrade: Promise<void>, client: PGlite) => Promise<void>,
): Promise<void> {
  const folder = await firstMigrations(2);
  const client = await PGlite.create();
  try {
    const db = drizzle({ client, schema });
    await migrate(db, { migrationsFolder: folder });
    await prepare(client);
    await check(migrate(db, { migrationsFolder }), client);
  } finally {
    await client.close();
    await rm(folder, { recursive: true, force: true });
  }
}

async function appliedMigrations(client: PGlite): Promise<number> {
  const result = await client.query<{ count: number }>(
    "select count(*)::int as count from drizzle.__drizzle_migrations",
  );
  return result.rows[0]?.count ?? 0;
}

async function tableExists(client: PGlite, name: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    "select to_regclass($1) is not null as exists",
    [`public.${name}`],
  );
  return result.rows[0]?.exists ?? false;
}

// One row in the table, in the shape of migration 0001.
const guardedRows: [table: string, insert: string][] = [
  ["users", "insert into users (id, display_name) values ($1, 'Existing')"],
  [
    "devices",
    "insert into devices (id, user_id, label, platform) values ($1, $1, 'Laptop', 'macos')",
  ],
  [
    "workspace_members",
    "insert into workspace_members (workspace_id, user_id, added_by_user_id) values ($1, $1, $1)",
  ],
];

for (const [table, insert] of guardedRows) {
  test(`the account tables migrations stop on a database with a row in ${table}`, async () => {
    await upgradeFromProviderConnections(
      async (client) => {
        // A device or a person always comes with a user. The foreign keys are
        // switched off for this row, so each condition of the guard is tested alone.
        await client.exec("set session_replication_role = replica");
        await client.query(insert, [newUuidV7()]);
        await client.exec("set session_replication_role = default");
      },
      async (upgrade, client) => {
        await assert.rejects(upgrade, (error: unknown) => {
          const cause = rootCause(error);
          // P0001: raise_exception, raised by the guard itself.
          assert.equal(cause.code, "P0001");
          assert.match(
            String(cause.message),
            /need a database without users, devices, or workspace members/,
          );
          return true;
        });
        // The guard and the account tables migrations ran in one transaction.
        assert.equal(await appliedMigrations(client), 2);
        assert.equal(await tableExists(client, "user_identities"), false);
      },
    );
  });
}

test("the account tables migration upgrades an empty database", async () => {
  await upgradeFromProviderConnections(
    async () => {},
    async (upgrade, client) => {
      await upgrade;
      const journal = JSON.parse(
        await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
      ) as { entries: unknown[] };
      assert.equal(await appliedMigrations(client), journal.entries.length);
      assert.equal(await tableExists(client, "user_identities"), true);
      assert.equal(await tableExists(client, "audit_events"), true);
    },
  );
});
