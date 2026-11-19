import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  type AgentId,
  type DeviceId,
  GRANT_COUNT_LIMITS,
  type GrantCapabilityRequest,
  GrantCapabilityResponseSchema,
  GrantRecordListResponseSchema,
  type MemberId,
  newId,
  newUuidV7,
  type PermissionGrantId,
  type ProjectId,
  type ProviderConnectionId,
  type RepositoryId,
  SHELL_GRANT_MAX_LIFETIME_SECONDS,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import { eraseAccount } from "./account-erasure.ts";
import { disableAccount, enableAccount } from "./account-status.ts";
import { revokeGrants } from "./cascade.ts";
import type { Database } from "./db.ts";
import { revokeDevice } from "./device-revocation.ts";
import { DatabaseError, withDatabaseErrors } from "./errors.ts";
import {
  grantCapability,
  type GrantCapabilityResult,
  listGrantRecords,
  revokeGrant,
} from "./grants.ts";
import { createWorkspace } from "./membership.ts";
import { removeMember } from "./people.ts";
import { createProject } from "./projects.ts";
import { SERVER_ONLY, whileHeld } from "./race-testing.ts";
import { removeRepository } from "./repositories.ts";
import {
  agents,
  devices,
  permissionGrants,
  projects,
  providerConnections,
  repositories,
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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-11-14T12:00:00.000Z");
const LATER = new Date("2026-11-14T13:00:00.000Z");
const EARLIER = new Date("2026-11-14T11:00:00.000Z");
const { perAgent: PER_AGENT, perHostDevice: PER_DEVICE } = GRANT_COUNT_LIMITS;

type Account = Readonly<{ userId: UserId; deviceId: DeviceId }>;

/** A device of the account. */
async function deviceOf(userId: UserId): Promise<DeviceId> {
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
  return { userId, deviceId: await deviceOf(userId) };
}

/** A workspace of `owner`, created two days before `NOW`, with the owner's person. */
async function workspaceOf(owner: Account): Promise<WorkspaceId> {
  const result = await createWorkspace(database(), {
    ...owner,
    name: "Team",
    displayName: "Owner",
    now: new Date(NOW.getTime() - 2 * DAY_MS),
  });
  assert.ok(result.created);
  return result.membership.workspace.id;
}

/** Adds the account to the workspace as a claimed member, removed at `removedAt` if given. */
async function join(
  workspaceId: WorkspaceId,
  who: Account,
  removedAt: Date | null = null,
): Promise<MemberId> {
  const id = newId<MemberId>();
  await database()
    .insert(workspaceMembers)
    .values({
      id,
      workspaceId,
      userId: who.userId,
      displayName: "Someone",
      role: "member",
      addedByUserId: who.userId,
      claimedAt: EARLIER,
      ...(removedAt === null ? {} : { removedAt, removedByUserId: who.userId }),
    });
  return id;
}

/** A project of the workspace, created two days before `NOW`. */
async function projectIn(
  workspaceId: WorkspaceId,
  by: Account,
  name = "App",
): Promise<ProjectId> {
  const result = await createProject(database(), {
    workspaceId,
    userId: by.userId,
    name,
    now: new Date(NOW.getTime() - 2 * DAY_MS),
  });
  assert.ok(result.created, JSON.stringify(result));
  return result.project.id;
}

/** `n` repositories of the project, inserted directly. */
async function repositoriesIn(
  projectId: ProjectId,
  by: Account,
  n = 1,
): Promise<RepositoryId[]> {
  const rows = Array.from({ length: n }, (_, index) => ({
    id: newId<RepositoryId>(),
    projectId,
    name: `Repository ${index}`,
    createdByUserId: by.userId,
  }));
  await database().insert(repositories).values(rows);
  return rows.map((row) => row.id);
}

/** An agent of the account in the project, hosted on `deviceId` (the account's first device by default). */
async function agentOf(
  projectId: ProjectId,
  owner: Account,
  deviceId: DeviceId = owner.deviceId,
): Promise<AgentId> {
  const id = newId<AgentId>();
  await database().insert(agents).values({
    id,
    projectId,
    ownerUserId: owner.userId,
    hostDeviceId: deviceId,
    name: "Builder",
  });
  return id;
}

async function connectionOn(deviceId: DeviceId): Promise<ProviderConnectionId> {
  const id = newId<ProviderConnectionId>();
  await database()
    .insert(providerConnections)
    .values({ id, hostDeviceId: deviceId });
  return id;
}

/** A workspace of `owner` with a project, a repository, and an agent of `owner`. */
async function world() {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectIn(workspaceId, owner);
  const [repositoryId] = await repositoriesIn(projectId, owner);
  assert.ok(repositoryId);
  const agentId = await agentOf(projectId, owner);
  return { owner, workspaceId, projectId, repositoryId, agentId };
}

function readRepository(
  repositoryId: RepositoryId,
  lifetimeSeconds: number | null = HOUR_MS / 1000,
): GrantCapabilityRequest {
  return { capability: "repo.read", repositoryId, lifetimeSeconds };
}

function grant(
  agentId: AgentId,
  by: Account,
  request: GrantCapabilityRequest,
  now: Date = NOW,
  db: Database = database(),
): Promise<GrantCapabilityResult> {
  return grantCapability(db, {
    agentId,
    userId: by.userId,
    deviceId: by.deviceId,
    grant: request,
    now,
  });
}

/** Grants and returns the new grant's ID. */
async function granted(
  agentId: AgentId,
  by: Account,
  request: GrantCapabilityRequest,
  now: Date = NOW,
): Promise<PermissionGrantId> {
  const result = await grant(agentId, by, request, now);
  assert.ok(result.granted, JSON.stringify(result));
  return result.grant.id;
}

async function grantRow(id: PermissionGrantId) {
  const [row] = await database()
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function grantRowsOf(agentId: AgentId) {
  return database()
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.granteeAgentId, agentId))
    .orderBy(permissionGrants.id);
}

async function grantCount(): Promise<number> {
  return (
    await database().select({ id: permissionGrants.id }).from(permissionGrants)
  ).length;
}

/**
 * `n` grants of the agent that are not revoked, inserted directly: four
 * capabilities on each repository, `n / 4` repositories.
 */
async function fill(
  projectId: ProjectId,
  agentId: AgentId,
  owner: Account,
  n: number,
): Promise<PermissionGrantId[]> {
  const capabilities = [
    "repo.read",
    "repo.write",
    "git.commit",
    "git.push",
  ] as const;
  const scopes = await repositoriesIn(projectId, owner, Math.ceil(n / 4));
  const rows = Array.from({ length: n }, (_, index) => ({
    id: newId<PermissionGrantId>(),
    projectId,
    granteeAgentId: agentId,
    hostDeviceId: owner.deviceId,
    capability: capabilities[index % 4] ?? "repo.read",
    repositoryId: scopes[Math.floor(index / 4)] ?? null,
    grantedByUserId: owner.userId,
    createdAt: EARLIER,
  }));
  await database().insert(permissionGrants).values(rows);
  return rows.map((row) => row.id);
}

function listOf(who: Account) {
  return listGrantRecords(database(), who);
}

test("the owner grants a capability from the agent's host device and gets the whole new grant, its expiry from now, and the workspace", async () => {
  const { owner, workspaceId, projectId, repositoryId, agentId } =
    await world();
  const connectionId = await connectionOn(owner.deviceId);

  const read = await grant(agentId, owner, readRepository(repositoryId, 3600));
  assert.ok(read.granted, JSON.stringify(read));
  assert.equal(read.workspaceId, workspaceId);
  assert.equal(read.replaced, null);
  assert.deepEqual(read.grant, {
    id: read.grant.id,
    projectId,
    granteeAgentId: agentId,
    grantedByUserId: owner.userId,
    createdAt: NOW.toISOString(),
    expiresAt: LATER.toISOString(),
    revokedAt: null,
    revokedByUserId: null,
    capability: "repo.read",
    repositoryId,
  });
  assert.equal(
    GrantCapabilityResponseSchema.safeParse({ grant: read.grant }).success,
    true,
  );
  const row = await grantRow(read.grant.id);
  assert.equal(row.hostDeviceId, owner.deviceId);
  assert.deepEqual(row.createdAt, NOW);
  assert.deepEqual(row.expiresAt, LATER);
  assert.equal(row.providerConnectionId, null);

  // No expiry, and a scope of the host device's provider connection.
  const provider = await grant(agentId, owner, {
    capability: "provider.use",
    providerConnectionId: connectionId,
    lifetimeSeconds: null,
  });
  assert.ok(provider.granted, JSON.stringify(provider));
  assert.equal(provider.grant.expiresAt, null);
  assert.equal(
    "providerConnectionId" in provider.grant &&
      provider.grant.providerConnectionId,
    connectionId,
  );
  // A shell grant at its longest lifetime.
  const shell = await grant(agentId, owner, {
    capability: "terminal.execute",
    repositoryId,
    lifetimeSeconds: SHELL_GRANT_MAX_LIFETIME_SECONDS,
  });
  assert.ok(shell.granted, JSON.stringify(shell));
  assert.equal(
    shell.grant.expiresAt,
    new Date(NOW.getTime() + 30 * DAY_MS).toISOString(),
  );
});

test("a grant is refused in order: not_found for the agent or the person, forbidden for another account or device, not_found for the scope, and nothing is written", async () => {
  const { owner, workspaceId, repositoryId, agentId } = await world();
  const member = await account("Member");
  await join(workspaceId, member);
  const outsider = await account("Outsider");
  const former = await account("Former");
  await join(workspaceId, former, EARLIER);
  const secondDevice: Account = {
    userId: owner.userId,
    deviceId: await deviceOf(owner.userId),
  };
  const elsewhere = await world();
  const [otherProjectRepository] = await repositoriesIn(
    await projectIn(workspaceId, owner, "Website"),
    owner,
  );
  assert.ok(otherProjectRepository);
  const otherDeviceConnection = await connectionOn(secondDevice.deviceId);
  const unknownRepository = newId<RepositoryId>();
  const before = await grantCount();

  const cases: [string, () => Promise<GrantCapabilityResult>, string][] = [
    [
      "an unknown agent",
      () => grant(newId<AgentId>(), owner, readRepository(repositoryId)),
      "not_found",
    ],
    [
      "an account that is no member",
      () => grant(agentId, outsider, readRepository(repositoryId)),
      "not_found",
    ],
    [
      "a removed member",
      () => grant(agentId, former, readRepository(repositoryId)),
      "not_found",
    ],
    [
      "an agent of another workspace",
      () =>
        grant(elsewhere.agentId, owner, readRepository(elsewhere.repositoryId)),
      "not_found",
    ],
    // Before the scope: an account that may not grant learns nothing of it.
    [
      "a member who does not own the agent",
      () => grant(agentId, member, readRepository(unknownRepository)),
      "forbidden",
    ],
    [
      "a member who names the host device",
      () =>
        grant(
          agentId,
          { userId: member.userId, deviceId: owner.deviceId },
          readRepository(unknownRepository),
        ),
      "forbidden",
    ],
    [
      "the owner on another of its devices",
      () => grant(agentId, secondDevice, readRepository(unknownRepository)),
      "forbidden",
    ],
    [
      "an unknown repository",
      () => grant(agentId, owner, readRepository(unknownRepository)),
      "not_found",
    ],
    [
      "a repository of another project",
      () => grant(agentId, owner, readRepository(otherProjectRepository)),
      "not_found",
    ],
    [
      "a provider connection of another device",
      () =>
        grant(agentId, owner, {
          capability: "provider.use",
          providerConnectionId: otherDeviceConnection,
          lifetimeSeconds: null,
        }),
      "not_found",
    ],
    [
      "an unknown provider connection",
      () =>
        grant(agentId, owner, {
          capability: "provider.use",
          providerConnectionId: newId<ProviderConnectionId>(),
          lifetimeSeconds: null,
        }),
      "not_found",
    ],
  ];
  for (const [label, attempt, refusal] of cases) {
    assert.deepEqual(await attempt(), { granted: false, refusal }, label);
  }
  assert.equal(await grantCount(), before);
  assert.deepEqual(await grantRowsOf(agentId), []);
});

test("a disabled account is forbidden before every other refusal, also without the API, and nothing is written; enabled again, it grants", async () => {
  const { owner, repositoryId, agentId } = await world();
  const first = await granted(agentId, owner, readRepository(repositoryId));
  const disabled = await disableAccount(database(), {
    userId: owner.userId,
    now: NOW,
  });
  assert.deepEqual(disabled, { changed: true, revokedGrantIds: [first] });
  const before = await grantCount();
  const agentIds = [
    ["its own agent", agentId],
    ["an unknown agent", newId<AgentId>()],
  ] as const;
  for (const [label, agent] of agentIds) {
    assert.deepEqual(
      await grant(agent, owner, readRepository(repositoryId), LATER),
      { granted: false, refusal: "forbidden" },
      label,
    );
  }
  assert.equal(await grantCount(), before);

  const enabled = await enableAccount(database(), {
    userId: owner.userId,
    now: LATER,
  });
  assert.ok(enabled.changed);
  const again = await grant(
    agentId,
    owner,
    readRepository(repositoryId),
    LATER,
  );
  assert.ok(again.granted, JSON.stringify(again));
});

test("a disabled agent, an archived workspace or project, and a removed repository or provider connection are each a conflict, after the refusals of the scope", async () => {
  const { owner, workspaceId, projectId, repositoryId, agentId } =
    await world();
  const connectionId = await connectionOn(owner.deviceId);
  const db = database();
  const ends: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
    [
      "a disabled agent",
      () =>
        db
          .update(agents)
          .set({ disabledAt: EARLIER })
          .where(eq(agents.id, agentId)),
      () =>
        db
          .update(agents)
          .set({ disabledAt: null })
          .where(eq(agents.id, agentId)),
    ],
    [
      "an archived workspace",
      () =>
        db
          .update(workspaces)
          .set({ archivedAt: EARLIER })
          .where(eq(workspaces.id, workspaceId)),
      () =>
        db
          .update(workspaces)
          .set({ archivedAt: null })
          .where(eq(workspaces.id, workspaceId)),
    ],
    [
      "an archived project",
      () =>
        db
          .update(projects)
          .set({ archivedAt: EARLIER })
          .where(eq(projects.id, projectId)),
      () =>
        db
          .update(projects)
          .set({ archivedAt: null })
          .where(eq(projects.id, projectId)),
    ],
  ];
  for (const [label, end, restore] of ends) {
    await end();
    assert.deepEqual(
      await grant(agentId, owner, readRepository(repositoryId)),
      { granted: false, refusal: "conflict" },
      label,
    );
    // The scope is decided first.
    assert.deepEqual(
      await grant(agentId, owner, readRepository(newId<RepositoryId>())),
      { granted: false, refusal: "not_found" },
      label,
    );
    await restore();
  }
  await db
    .update(repositories)
    .set({ archivedAt: EARLIER })
    .where(eq(repositories.id, repositoryId));
  assert.deepEqual(await grant(agentId, owner, readRepository(repositoryId)), {
    granted: false,
    refusal: "conflict",
  });
  await db
    .update(providerConnections)
    .set({ removedAt: EARLIER })
    .where(eq(providerConnections.id, connectionId));
  assert.deepEqual(
    await grant(agentId, owner, {
      capability: "provider.use",
      providerConnectionId: connectionId,
      lifetimeSeconds: null,
    }),
    { granted: false, refusal: "conflict" },
  );
  assert.deepEqual(await grantRowsOf(agentId), []);
});

test("a grant of the same capability on the same scope that is neither revoked nor expired is a conflict; another capability or scope, or a revoked grant, is not", async () => {
  const { owner, projectId, repositoryId, agentId } = await world();
  const [otherRepository] = await repositoriesIn(projectId, owner);
  assert.ok(otherRepository);
  const connectionId = await connectionOn(owner.deviceId);
  const first = await granted(
    agentId,
    owner,
    readRepository(repositoryId, null),
  );
  assert.deepEqual(
    await grant(agentId, owner, readRepository(repositoryId), LATER),
    { granted: false, refusal: "conflict" },
  );
  const provider = {
    capability: "provider.use",
    providerConnectionId: connectionId,
    lifetimeSeconds: null,
  } as const;
  await granted(agentId, owner, provider);
  assert.deepEqual(await grant(agentId, owner, provider), {
    granted: false,
    refusal: "conflict",
  });
  // An active grant one millisecond before its expiry is still a conflict.
  const writing = await granted(agentId, owner, {
    capability: "repo.write",
    repositoryId,
    lifetimeSeconds: 60,
  });
  assert.deepEqual(
    await grant(
      agentId,
      owner,
      { capability: "repo.write", repositoryId, lifetimeSeconds: 60 },
      new Date(NOW.getTime() + MINUTE_MS - 1),
    ),
    { granted: false, refusal: "conflict" },
  );
  await granted(agentId, owner, readRepository(otherRepository));
  const revoked = await revokeGrant(database(), {
    agentId,
    grantId: first,
    userId: owner.userId,
    now: LATER,
  });
  assert.ok(revoked.revoked);
  const again = await grant(
    agentId,
    owner,
    readRepository(repositoryId),
    LATER,
  );
  assert.ok(again.granted, JSON.stringify(again));
  // A revoked grant is not replaced: it already is.
  assert.equal(again.replaced, null);
  assert.equal((await grantRow(writing)).revokedAt, null);
});

test("an expired grant of the same capability on the same scope is revoked and replaced in one transaction; its row keeps every other column, and its expiry is never extended", async () => {
  const { owner, repositoryId, agentId } = await world();
  const expired = await granted(
    agentId,
    owner,
    readRepository(repositoryId, 60),
  );
  const before = await grantRow(expired);
  // Expiry is half-open: at its expiry a grant has expired.
  const renewedAt = new Date(NOW.getTime() + MINUTE_MS);
  const renewal = await grant(
    agentId,
    owner,
    readRepository(repositoryId, 3600),
    renewedAt,
  );
  assert.ok(renewal.granted, JSON.stringify(renewal));
  assert.notEqual(renewal.grant.id, expired);
  assert.equal(
    renewal.grant.expiresAt,
    new Date(renewedAt.getTime() + HOUR_MS).toISOString(),
  );
  assert.deepEqual(renewal.replaced, {
    id: expired,
    projectId: before.projectId,
    granteeAgentId: agentId,
    grantedByUserId: owner.userId,
    createdAt: NOW.toISOString(),
    expiresAt: renewedAt.toISOString(),
    revokedAt: renewedAt.toISOString(),
    revokedByUserId: owner.userId,
    capability: "repo.read",
    repositoryId,
  });
  assert.deepEqual(await grantRow(expired), {
    ...before,
    revokedAt: renewedAt,
    revokedByUserId: owner.userId,
  });
  assert.equal((await grantRowsOf(agentId)).length, 2);
});

test(`an agent holds at most ${PER_AGENT} grants that are not revoked, an expired one included; the next is grant_limit, after a conflict, and a revocation or the renewal of an expired one frees a place`, async () => {
  const { owner, projectId, repositoryId, agentId } = await world();
  const filled = await fill(projectId, agentId, owner, PER_AGENT - 1);
  const expired = await granted(
    agentId,
    owner,
    readRepository(repositoryId, 60),
  );
  const before = await grantCount();
  const [fresh] = await repositoriesIn(projectId, owner);
  assert.ok(fresh);
  assert.deepEqual(await grant(agentId, owner, readRepository(fresh), LATER), {
    granted: false,
    refusal: "grant_limit",
  });
  // An active duplicate is a conflict first.
  const duplicate = filled[0];
  assert.ok(duplicate);
  const { repositoryId: filledScope } = await grantRow(duplicate);
  assert.ok(filledScope);
  assert.deepEqual(
    await grant(agentId, owner, readRepository(filledScope), LATER),
    { granted: false, refusal: "conflict" },
  );
  assert.equal(await grantCount(), before);
  // The renewal of the expired grant replaces it and needs no place.
  const renewal = await grant(
    agentId,
    owner,
    readRepository(repositoryId),
    LATER,
  );
  assert.ok(renewal.granted, JSON.stringify(renewal));
  assert.equal(renewal.replaced?.id, expired);
  // A revocation frees a place.
  assert.ok(
    (
      await revokeGrant(database(), {
        agentId,
        grantId: duplicate,
        userId: owner.userId,
        now: LATER,
      })
    ).revoked,
  );
  assert.ok(
    (await grant(agentId, owner, readRepository(fresh), LATER)).granted,
  );
});

test(`the agents of a host device hold at most ${PER_DEVICE} grants that are not revoked; another device of the account counts apart, and the record list holds every one of them`, async () => {
  const { owner, projectId, repositoryId } = await world();
  const filledAgents: AgentId[] = [];
  for (let index = 0; index < PER_DEVICE / PER_AGENT; index += 1) {
    const agentId = await agentOf(projectId, owner);
    filledAgents.push(agentId);
    await fill(projectId, agentId, owner, PER_AGENT);
  }
  const fresh = await agentOf(projectId, owner);
  assert.deepEqual(await grant(fresh, owner, readRepository(repositoryId)), {
    granted: false,
    refusal: "grant_limit",
  });
  assert.deepEqual(await grantRowsOf(fresh), []);
  const secondDevice: Account = {
    userId: owner.userId,
    deviceId: await deviceOf(owner.userId),
  };
  const elsewhere = await agentOf(projectId, owner, secondDevice.deviceId);
  assert.ok(
    (await grant(elsewhere, secondDevice, readRepository(repositoryId)))
      .granted,
  );

  const records = await listOf(owner);
  assert.equal(records.length, PER_DEVICE);
  assert.equal(
    GrantRecordListResponseSchema.safeParse({ records }).success,
    true,
  );
  // The list is never cut: one record more than an answer holds breaks the
  // invariant that the limit keeps.
  await fill(projectId, fresh, owner, 1);
  await assert.rejects(listOf(owner), /Invariant broken/u);
  assert.equal(filledAgents.length, PER_DEVICE / PER_AGENT);
});

test("the database refuses a shell grant without an expiry or beyond 30 days, also from the writer", async () => {
  const { owner, repositoryId, agentId } = await world();
  for (const lifetimeSeconds of [null, SHELL_GRANT_MAX_LIFETIME_SECONDS + 1]) {
    await assert.rejects(
      grant(agentId, owner, {
        capability: "terminal.execute",
        repositoryId,
        lifetimeSeconds,
      } as GrantCapabilityRequest),
      (error: unknown) =>
        error instanceof DatabaseError &&
        error.code === "23514" &&
        error.constraint === "permission_grants_shell_expiry_check",
    );
  }
  assert.deepEqual(await grantRowsOf(agentId), []);
});

test("the owner revokes a grant from any of its devices, also an expired one; only the two revocation columns change, once", async () => {
  const { owner, workspaceId, repositoryId, agentId } = await world();
  const grantId = await granted(
    agentId,
    owner,
    readRepository(repositoryId, 60),
  );
  const before = await grantRow(grantId);
  // Expired by now, and the owner's other device revokes it: revoking needs
  // no device.
  const result = await revokeGrant(database(), {
    agentId,
    grantId,
    userId: owner.userId,
    now: LATER,
  });
  assert.deepEqual(result, {
    revoked: true,
    workspaceId,
    grant: {
      id: grantId,
      projectId: before.projectId,
      granteeAgentId: agentId,
      grantedByUserId: owner.userId,
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + MINUTE_MS).toISOString(),
      revokedAt: LATER.toISOString(),
      revokedByUserId: owner.userId,
      capability: "repo.read",
      repositoryId,
    },
  });
  const revoked = await grantRow(grantId);
  assert.deepEqual(revoked, {
    ...before,
    revokedAt: LATER,
    revokedByUserId: owner.userId,
  });
  // One-way: a second revocation is a conflict and changes nothing.
  assert.deepEqual(
    await revokeGrant(database(), {
      agentId,
      grantId,
      userId: owner.userId,
      now: new Date(LATER.getTime() + HOUR_MS),
    }),
    { revoked: false, refusal: "conflict" },
  );
  assert.deepEqual(await grantRow(grantId), revoked);
});

test("the database lets a grant change only by its revocation, once and whole (P-77); revokeGrant and the cascade still revoke", async () => {
  const { owner, projectId, repositoryId, agentId } = await world();
  const other = await account("Other");
  const secondRepositoryId = newId<RepositoryId>();
  await database().insert(repositories).values({
    id: secondRepositoryId,
    projectId,
    name: "Second",
    createdByUserId: owner.userId,
  });
  const refused = async (
    grantId: PermissionGrantId,
    values: Partial<typeof permissionGrants.$inferInsert>,
    constraint: string,
  ) => {
    const before = await grantRow(grantId);
    await assert.rejects(
      withDatabaseErrors(() =>
        database()
          .update(permissionGrants)
          .set(values)
          .where(eq(permissionGrants.id, grantId)),
      ),
      (error: unknown) =>
        error instanceof DatabaseError &&
        error.code === "23000" &&
        error.constraint === constraint,
      `${JSON.stringify(values)} is refused by ${constraint}`,
    );
    assert.deepEqual(await grantRow(grantId), before);
  };

  const active = await granted(agentId, owner, readRepository(repositoryId));
  // Every column other than the two revocation columns, alone or together
  // with a whole revocation.
  const otherColumns: Partial<typeof permissionGrants.$inferInsert>[] = [
    { id: newId<PermissionGrantId>() },
    { projectId: newId<ProjectId>() },
    { granteeAgentId: newId<AgentId>() },
    { hostDeviceId: other.deviceId },
    { capability: "repo.write" },
    { repositoryId: secondRepositoryId },
    { providerConnectionId: newId<ProviderConnectionId>() },
    { grantedByUserId: other.userId },
    { createdAt: EARLIER },
    { expiresAt: new Date(NOW.getTime() + DAY_MS) },
    { expiresAt: null },
  ];
  for (const values of otherColumns) {
    await refused(active, values, "permission_grants_immutable_columns");
    await refused(
      active,
      { ...values, revokedAt: LATER, revokedByUserId: owner.userId },
      "permission_grants_immutable_columns",
    );
  }
  // Half a revocation.
  await refused(
    active,
    { revokedAt: LATER },
    "permission_grants_revocation_pair",
  );
  await refused(
    active,
    { revokedByUserId: owner.userId },
    "permission_grants_revocation_pair",
  );

  // revokeGrant sets both columns.
  const result = await revokeGrant(database(), {
    agentId,
    grantId: active,
    userId: owner.userId,
    now: LATER,
  });
  assert.equal(result.revoked, true);
  const revoked = await grantRow(active);
  assert.deepEqual(
    [revoked.revokedAt, revoked.revokedByUserId],
    [LATER, owner.userId],
  );
  // A revocation is one-way and final.
  const revocationChanges: Partial<typeof permissionGrants.$inferInsert>[] = [
    { revokedAt: null, revokedByUserId: null },
    { revokedAt: null },
    { revokedByUserId: null },
    { revokedAt: new Date(LATER.getTime() + HOUR_MS) },
    { revokedByUserId: other.userId },
  ];
  for (const values of revocationChanges) {
    await refused(active, values, "permission_grants_revocation_final");
  }
  // Writing the same values again changes nothing and is allowed.
  await database()
    .update(permissionGrants)
    .set({ revokedAt: LATER, revokedByUserId: owner.userId })
    .where(eq(permissionGrants.id, active));
  assert.deepEqual(await grantRow(active), revoked);

  // The cascade (`revokeGrants`, which a removal or a device revocation
  // runs) revokes as well, an expired grant included.
  const expired = await granted(
    agentId,
    owner,
    readRepository(secondRepositoryId, 60),
  );
  const beforeCascade = await grantRow(expired);
  const ids = await database().transaction((tx) =>
    revokeGrants(
      tx,
      eq(permissionGrants.granteeAgentId, agentId),
      owner.userId,
      LATER,
    ),
  );
  assert.deepEqual(ids, [expired]);
  assert.deepEqual(await grantRow(expired), {
    ...beforeCascade,
    revokedAt: LATER,
    revokedByUserId: owner.userId,
  });
  await refused(
    expired,
    { revokedAt: null, revokedByUserId: null },
    "permission_grants_revocation_final",
  );
});

test("a revocation is refused in order: not_found for the agent or the person, forbidden for another account, then not_found for a grant of another agent, and nothing is written", async () => {
  const { owner, workspaceId, projectId, repositoryId, agentId } =
    await world();
  const member = await account("Member");
  await join(workspaceId, member);
  const outsider = await account("Outsider");
  const otherAgent = await agentOf(projectId, owner);
  const grantId = await granted(agentId, owner, readRepository(repositoryId));
  const ofOther = await granted(
    otherAgent,
    owner,
    readRepository(repositoryId),
  );
  const revoke = (who: Account, agent: AgentId, id: PermissionGrantId) =>
    revokeGrant(database(), {
      agentId: agent,
      grantId: id,
      userId: who.userId,
      now: LATER,
    });
  assert.deepEqual(await revoke(owner, newId<AgentId>(), grantId), {
    revoked: false,
    refusal: "not_found",
  });
  assert.deepEqual(await revoke(outsider, agentId, grantId), {
    revoked: false,
    refusal: "not_found",
  });
  assert.deepEqual(await revoke(member, agentId, newId<PermissionGrantId>()), {
    revoked: false,
    refusal: "forbidden",
  });
  assert.deepEqual(await revoke(owner, agentId, newId<PermissionGrantId>()), {
    revoked: false,
    refusal: "not_found",
  });
  assert.deepEqual(await revoke(owner, agentId, ofOther), {
    revoked: false,
    refusal: "not_found",
  });
  for (const id of [grantId, ofOther]) {
    assert.equal((await grantRow(id)).revokedAt, null);
  }
});

test("the record list holds every grant of the calling device's agents that is not revoked, each once with its facts, and nothing of other devices or accounts", async () => {
  const { owner, workspaceId, projectId, repositoryId, agentId } =
    await world();
  const connectionId = await connectionOn(owner.deviceId);
  const other = await account("Other");
  await join(workspaceId, other);
  const secondDevice: Account = {
    userId: owner.userId,
    deviceId: await deviceOf(owner.userId),
  };
  const read = await granted(agentId, owner, readRepository(repositoryId, 60));
  const provider = await granted(agentId, owner, {
    capability: "provider.use",
    providerConnectionId: connectionId,
    lifetimeSeconds: null,
  });
  const revoked = await granted(agentId, owner, {
    capability: "repo.write",
    repositoryId,
    lifetimeSeconds: null,
  });
  assert.ok(
    (
      await revokeGrant(database(), {
        agentId,
        grantId: revoked,
        userId: owner.userId,
        now: NOW,
      })
    ).revoked,
  );
  // A disabled agent's grant is listed with the fact that disables it.
  const disabledAgent = await agentOf(projectId, owner);
  const ofDisabled = await granted(
    disabledAgent,
    owner,
    readRepository(repositoryId),
  );
  await database()
    .update(agents)
    .set({ disabledAt: LATER })
    .where(eq(agents.id, disabledAgent));
  // Agents of the account's other device, and of another account.
  await granted(
    await agentOf(projectId, owner, secondDevice.deviceId),
    secondDevice,
    readRepository(repositoryId),
  );
  await granted(
    await agentOf(projectId, other),
    other,
    readRepository(repositoryId),
  );

  const records = await listOf(owner);
  assert.equal(
    GrantRecordListResponseSchema.safeParse({ records }).success,
    true,
  );
  // In the order of the grant IDs; the expired grant stays listed.
  assert.deepEqual(
    records.map((record) => record.grant.id),
    [read, provider, ofDisabled].sort(),
  );
  const facts = (
    agent: AgentId,
    disabledAt: Date | null,
    connection: boolean,
  ) => ({
    agent: {
      id: agent,
      hostDeviceId: owner.deviceId,
      disabledAt: disabledAt?.toISOString() ?? null,
    },
    hostDevice: { id: owner.deviceId, revokedAt: null },
    project: { id: projectId, workspaceId },
    grantorMembership: { workspaceId, userId: owner.userId, removedAt: null },
    providerConnection: connection
      ? { id: connectionId, hostDeviceId: owner.deviceId, removedAt: null }
      : null,
  });
  const byId = new Map(records.map((record) => [record.grant.id, record]));
  assert.deepEqual(byId.get(read)?.facts, facts(agentId, null, false));
  assert.deepEqual(byId.get(provider)?.facts, facts(agentId, null, true));
  assert.deepEqual(
    byId.get(ofDisabled)?.facts,
    facts(disabledAgent, LATER, false),
  );
  assert.equal(
    byId.get(read)?.grant.expiresAt,
    new Date(NOW.getTime() + MINUTE_MS).toISOString(),
  );

  assert.equal((await listOf(secondDevice)).length, 1);
  assert.equal((await listOf(other)).length, 1);
  // A device of another account, and a device without agents, get nothing.
  assert.deepEqual(
    await listOf({ userId: other.userId, deviceId: owner.deviceId }),
    [],
  );
  assert.deepEqual(
    await listOf({
      userId: owner.userId,
      deviceId: await deviceOf(owner.userId),
    }),
    [],
  );
});

test("a person who left and joined again has each grant listed once, with the active person as the fact; without one, the most recently removed person", async () => {
  const owner = await account("Owner");
  const alice = await account("Alice");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectIn(workspaceId, owner);
  const [repositoryId] = await repositoriesIn(projectId, owner);
  assert.ok(repositoryId);
  const first = await join(workspaceId, alice);
  const oldAgent = await agentOf(projectId, alice);
  const old = await granted(oldAgent, alice, readRepository(repositoryId));
  const removal = await removeMember(database(), {
    workspaceId,
    ...owner,
    memberId: first,
    now: NOW,
  });
  assert.ok(removal.removed, JSON.stringify(removal));
  await join(workspaceId, alice);
  const newAgent = await agentOf(projectId, alice);
  const renewed = await granted(
    newAgent,
    alice,
    readRepository(repositoryId),
    LATER,
  );

  const records = await listOf(alice);
  assert.equal(
    GrantRecordListResponseSchema.safeParse({ records }).success,
    true,
  );
  // The removal revoked the old grant, and the new one is listed once.
  assert.equal((await grantRow(old)).revokedAt?.getTime(), NOW.getTime());
  assert.deepEqual(
    records.map((record) => record.grant.id),
    [renewed],
  );
  assert.deepEqual(records[0]?.facts.grantorMembership, {
    workspaceId,
    userId: alice.userId,
    removedAt: null,
  });

  // In another workspace, Alice was removed twice, and a grant that no
  // writer revoked names her: its fact is her most recently removed person.
  const ownerElsewhere = await account("Owner elsewhere");
  const otherWorkspace = await workspaceOf(ownerElsewhere);
  const otherProject = await projectIn(otherWorkspace, ownerElsewhere);
  const [otherRepository] = await repositoriesIn(otherProject, ownerElsewhere);
  assert.ok(otherRepository);
  await join(otherWorkspace, alice, new Date(EARLIER.getTime() - HOUR_MS));
  await join(otherWorkspace, alice, EARLIER);
  const stale = newId<PermissionGrantId>();
  await database()
    .insert(permissionGrants)
    .values({
      id: stale,
      projectId: otherProject,
      granteeAgentId: await agentOf(otherProject, alice),
      hostDeviceId: alice.deviceId,
      capability: "repo.read",
      repositoryId: otherRepository,
      grantedByUserId: alice.userId,
      createdAt: EARLIER,
    });
  const both = await listOf(alice);
  assert.equal(both.length, 2);
  assert.deepEqual(
    both.find((record) => record.grant.id === stale)?.facts.grantorMembership,
    {
      workspaceId: otherWorkspace,
      userId: alice.userId,
      removedAt: EARLIER.toISOString(),
    },
  );
  assert.equal(
    GrantRecordListResponseSchema.safeParse({ records: both }).success,
    true,
  );
});

// Concurrent transactions, on a PostgreSQL server only.

test(
  `a grant waits at the host device's row for a concurrent grant on another agent of the device that reaches its limit of ${PER_DEVICE}, and is then grant_limit`,
  SERVER_ONLY,
  async () => {
    const { owner, projectId, repositoryId, agentId: first } = await world();
    // One place left on the device, on the agent `first`.
    await fill(projectId, first, owner, PER_AGENT - 1);
    for (let index = 1; index < PER_DEVICE / PER_AGENT; index += 1) {
      await fill(projectId, await agentOf(projectId, owner), owner, PER_AGENT);
    }
    const fresh = await agentOf(projectId, owner);
    // The two agents differ, so only the device's row orders them.
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const last = await grant(
          first,
          owner,
          readRepository(repositoryId),
          NOW,
          tx,
        );
        assert.ok(last.granted, JSON.stringify(last));
      },
      () => grant(fresh, owner, readRepository(repositoryId)),
    );
    assert.deepEqual(result, { granted: false, refusal: "grant_limit" });
    assert.deepEqual(waitedOn, ["devices"]);
    assert.equal((await listOf(owner)).length, PER_DEVICE);
  },
);

test(
  "a grant waits for a concurrent revocation of its host device and is then a conflict, because the agent is disabled",
  SERVER_ONLY,
  async () => {
    const { owner, repositoryId, agentId } = await world();
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) =>
        revokeDevice(tx, {
          deviceId: owner.deviceId,
          userId: owner.userId,
          reason: "lost",
          now: NOW,
          actorUserId: owner.userId,
          actorDeviceId: owner.deviceId,
        }),
      () => grant(agentId, owner, readRepository(repositoryId), LATER),
    );
    assert.deepEqual(result, { granted: false, refusal: "conflict" });
    assert.deepEqual(waitedOn, ["devices"]);
    assert.deepEqual(await grantRowsOf(agentId), []);
  },
);

test(
  "a device revocation waits for a grant that holds the host device's row, and then revokes the new grant",
  SERVER_ONLY,
  async () => {
    const { owner, repositoryId, agentId } = await world();
    let grantId: PermissionGrantId | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const created = await grant(
          agentId,
          owner,
          readRepository(repositoryId),
          NOW,
          tx,
        );
        assert.ok(created.granted, JSON.stringify(created));
        grantId = created.grant.id;
      },
      () =>
        revokeDevice(database(), {
          deviceId: owner.deviceId,
          userId: owner.userId,
          reason: "lost",
          now: LATER,
          actorUserId: owner.userId,
          actorDeviceId: owner.deviceId,
        }),
    );
    assert.ok(grantId);
    assert.deepEqual(result.revokedGrantIds, [grantId]);
    assert.deepEqual(waitedOn, ["devices"]);
  },
);

test(
  "a grant waits for a concurrent removal of the agent's owner and is then not_found",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const alice = await account("Alice");
    const workspaceId = await workspaceOf(owner);
    const person = await join(workspaceId, alice);
    const projectId = await projectIn(workspaceId, owner);
    const [repositoryId] = await repositoriesIn(projectId, owner);
    assert.ok(repositoryId);
    const agentId = await agentOf(projectId, alice);
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) =>
        removeMember(tx, { workspaceId, ...owner, memberId: person, now: NOW }),
      () => grant(agentId, alice, readRepository(repositoryId), LATER),
    );
    assert.deepEqual(result, { granted: false, refusal: "not_found" });
    assert.deepEqual(waitedOn, ["workspace_members"]);
    assert.deepEqual(await grantRowsOf(agentId), []);
  },
);

test(
  "a removal of the agent's owner waits at the person for a grant that holds it, and then revokes the new grant",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const alice = await account("Alice");
    const workspaceId = await workspaceOf(owner);
    const person = await join(workspaceId, alice);
    const projectId = await projectIn(workspaceId, owner);
    const [repositoryId] = await repositoriesIn(projectId, owner);
    assert.ok(repositoryId);
    const agentId = await agentOf(projectId, alice);
    let grantId: PermissionGrantId | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const created = await grant(
          agentId,
          alice,
          readRepository(repositoryId),
          NOW,
          tx,
        );
        assert.ok(created.granted, JSON.stringify(created));
        grantId = created.grant.id;
      },
      () =>
        removeMember(database(), {
          workspaceId,
          ...owner,
          memberId: person,
          now: LATER,
        }),
    );
    assert.ok(grantId);
    assert.ok(result.removed, JSON.stringify(result));
    assert.deepEqual(result.revokedGrantIds, [grantId]);
    assert.deepEqual(waitedOn, ["workspace_members"]);
  },
);

test(
  "a grant waits for a concurrent disable of its account and is then forbidden; a disable waits for a grant that holds the account's row, and then revokes the new grant",
  SERVER_ONLY,
  async () => {
    const first = await world();
    const refused = await whileHeld(
      testDatabase,
      (tx) => disableAccount(tx, { userId: first.owner.userId, now: NOW }),
      () =>
        grant(
          first.agentId,
          first.owner,
          readRepository(first.repositoryId),
          LATER,
        ),
    );
    assert.deepEqual(refused.result, { granted: false, refusal: "forbidden" });
    assert.deepEqual(refused.waitedOn, ["users"]);
    assert.deepEqual(await grantRowsOf(first.agentId), []);

    const { owner, repositoryId, agentId } = await world();
    let grantId: PermissionGrantId | undefined;
    const disable = await whileHeld(
      testDatabase,
      async (tx) => {
        const created = await grant(
          agentId,
          owner,
          readRepository(repositoryId),
          NOW,
          tx,
        );
        assert.ok(created.granted, JSON.stringify(created));
        grantId = created.grant.id;
      },
      () => disableAccount(database(), { userId: owner.userId, now: LATER }),
    );
    assert.ok(grantId);
    assert.deepEqual(disable.result, {
      changed: true,
      revokedGrantIds: [grantId],
    });
    assert.deepEqual(disable.waitedOn, ["users"]);
  },
);

test(
  "an erasure of the agent's owner waits at the account for a grant that holds it, and then revokes the new grant",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const alice = await account("Alice");
    await database()
      .insert(userIdentities)
      .values({
        id: newUuidV7(),
        userId: alice.userId,
        identityProvider: "github",
        // A GitHub subject is a decimal ID without a leading zero.
        subject: String(BigInt(`0x${randomBytes(6).toString("hex")}`) + 1n),
        login: "alice",
        accountCreatedAt: EARLIER,
        lastSignInAt: EARLIER,
      });
    const workspaceId = await workspaceOf(owner);
    await join(workspaceId, alice);
    const projectId = await projectIn(workspaceId, owner);
    const [repositoryId] = await repositoriesIn(projectId, owner);
    assert.ok(repositoryId);
    const agentId = await agentOf(projectId, alice);
    let grantId: PermissionGrantId | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const created = await grant(
          agentId,
          alice,
          readRepository(repositoryId),
          NOW,
          tx,
        );
        assert.ok(created.granted, JSON.stringify(created));
        grantId = created.grant.id;
      },
      () => eraseAccount(database(), { userId: alice.userId, now: LATER }),
    );
    assert.ok(grantId);
    assert.ok(result.erased, JSON.stringify(result));
    assert.deepEqual(
      [
        ...result.endedMemberships.flatMap((ended) => ended.revokedGrantIds),
        ...result.revokedDevices.flatMap((device) => device.revokedGrantIds),
      ],
      [grantId],
    );
    assert.deepEqual(waitedOn, ["users"]);
    const row = await grantRow(grantId);
    assert.deepEqual(row.revokedAt, LATER);
    assert.equal(row.revokedByUserId, alice.userId);
  },
);

test(
  "a repository removal waits at the project row for a grant on the repository, and then revokes the new grant; a grant that waits for a removal is a conflict",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, projectId, repositoryId } = await world();
    // The agent's owner is not the remover, whose person the grant would
    // otherwise hold first.
    const alice = await account("Alice");
    await join(workspaceId, alice);
    const agentId = await agentOf(projectId, alice);
    let grantId: PermissionGrantId | undefined;
    const removal = await whileHeld(
      testDatabase,
      async (tx) => {
        const created = await grant(
          agentId,
          alice,
          readRepository(repositoryId),
          NOW,
          tx,
        );
        assert.ok(created.granted, JSON.stringify(created));
        grantId = created.grant.id;
      },
      () =>
        removeRepository(database(), {
          projectId,
          repositoryId,
          userId: owner.userId,
          now: LATER,
        }),
    );
    assert.ok(grantId);
    assert.ok(removal.result.removed, JSON.stringify(removal.result));
    assert.deepEqual(removal.result.revokedGrantIds, [grantId]);
    assert.deepEqual(removal.waitedOn, ["projects"]);

    const [second] = await repositoriesIn(projectId, owner);
    assert.ok(second);
    const refused = await whileHeld(
      testDatabase,
      (tx) =>
        removeRepository(tx, {
          projectId,
          repositoryId: second,
          userId: owner.userId,
          now: LATER,
        }),
      () => grant(agentId, alice, readRepository(second), LATER),
    );
    assert.deepEqual(refused.result, { granted: false, refusal: "conflict" });
    assert.deepEqual(refused.waitedOn, ["projects"]);
  },
);

test(
  "a revocation waits for a concurrent revocation of the same grant and is then a conflict",
  SERVER_ONLY,
  async () => {
    const { owner, repositoryId, agentId } = await world();
    const grantId = await granted(agentId, owner, readRepository(repositoryId));
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) =>
        revokeGrant(tx, { agentId, grantId, userId: owner.userId, now: NOW }),
      () =>
        revokeGrant(database(), {
          agentId,
          grantId,
          userId: owner.userId,
          now: LATER,
        }),
    );
    assert.deepEqual(result, { revoked: false, refusal: "conflict" });
    assert.deepEqual(waitedOn, ["permission_grants"]);
    assert.deepEqual((await grantRow(grantId)).revokedAt, NOW);
  },
);

test(
  "the record list does not wait for a grant that is not committed, and does not see it",
  SERVER_ONLY,
  async () => {
    const { owner, repositoryId, agentId } = await world();
    const listed = await granted(agentId, owner, {
      capability: "repo.write",
      repositoryId,
      lifetimeSeconds: null,
    });
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        assert.ok(
          (await grant(agentId, owner, readRepository(repositoryId), NOW, tx))
            .granted,
        );
      },
      () => listOf(owner),
    );
    assert.deepEqual(waitedOn, []);
    assert.deepEqual(
      result.map((record) => record.grant.id),
      [listed],
    );
  },
);
