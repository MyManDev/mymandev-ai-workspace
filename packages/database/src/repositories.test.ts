import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  type AgentId,
  type DeviceId,
  type MemberId,
  type MemberRole,
  newId,
  newUuidV7,
  type PermissionGrantId,
  type ProjectId,
  type ProjectRepository,
  ProjectRepositorySchema,
  type ProviderConnectionId,
  REPOSITORY_COUNT_LIMITS,
  type RepositoryId,
  type RunId,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import { eraseAccount } from "./account-erasure.ts";
import type { Database } from "./db.ts";
import { DatabaseError, withDatabaseErrors } from "./errors.ts";
import { activePersonOf, createWorkspace } from "./membership.ts";
import { removeMember } from "./people.ts";
import { createProject } from "./projects.ts";
import { SERVER_ONLY, whileHeld } from "./race-testing.ts";
import {
  listRepositories,
  registerRepository,
  type RegisterRepositoryResult,
  removeRepository,
} from "./repositories.ts";
import {
  agentRuns,
  agents,
  auditEvents,
  devices,
  permissionGrants,
  projects,
  providerConnections,
  repositories,
  userIdentities,
  users,
  workspaceMembers,
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

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-11-14T12:00:00.000Z");
const LATER = new Date("2026-11-14T13:00:00.000Z");
const EARLIER = new Date("2026-11-14T11:00:00.000Z");
const { perProject: PER_PROJECT, perDay: PER_DAY } = REPOSITORY_COUNT_LIMITS;

type Account = Readonly<{ userId: UserId; deviceId: DeviceId }>;

/** An account with one device. */
async function account(name: string): Promise<Account> {
  const db = database();
  const userId = newId<UserId>();
  await db.insert(users).values({ id: userId, displayName: name });
  const deviceId = newId<DeviceId>();
  await db.insert(devices).values({
    id: deviceId,
    userId,
    label: "Laptop",
    platform: "linux",
    publicKey: randomBytes(32).toString("hex"),
    keyAlgorithm: "ed25519",
    lastSignInAt: NOW,
  });
  return { userId, deviceId };
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

/** Adds the account to the workspace as a claimed person, a member by default. */
async function join(
  workspaceId: WorkspaceId,
  who: Account,
  role: MemberRole = "member",
): Promise<MemberId> {
  const id = newId<MemberId>();
  await database().insert(workspaceMembers).values({
    id,
    workspaceId,
    userId: who.userId,
    displayName: "Someone",
    role,
    addedByUserId: who.userId,
    claimedAt: NOW,
  });
  return id;
}

/** The account's active person in the workspace. */
async function personOf(
  workspaceId: WorkspaceId,
  who: Account,
): Promise<MemberId> {
  const person = await activePersonOf(database(), {
    workspaceId,
    userId: who.userId,
  });
  assert.ok(person !== undefined);
  return person.id;
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

/** Registers a repository that must be registered, in `db`. */
async function registeredIn(
  db: Database,
  projectId: ProjectId,
  by: Account,
  name: string,
  now: Date = NOW,
): Promise<ProjectRepository> {
  const result = await registerRepository(db, {
    projectId,
    userId: by.userId,
    name,
    now,
  });
  assert.ok(result.registered, JSON.stringify(result));
  return result.repository;
}

/** Registers a repository that must be registered, and returns it. */
function registered(
  projectId: ProjectId,
  by: Account,
  name: string,
  now: Date = NOW,
): Promise<ProjectRepository> {
  return registeredIn(database(), projectId, by, name, now);
}

function register(
  projectId: ProjectId,
  by: Account,
  name: string,
  now: Date = NOW,
): Promise<RegisterRepositoryResult> {
  return registerRepository(database(), {
    projectId,
    userId: by.userId,
    name,
    now,
  });
}

function remove(
  projectId: ProjectId,
  repositoryId: RepositoryId,
  by: Account,
  now: Date = LATER,
) {
  return removeRepository(database(), {
    projectId,
    repositoryId,
    userId: by.userId,
    now,
  });
}

/** The repositories that the account reads in the project's list. */
async function listed(
  projectId: ProjectId,
  who: Account,
): Promise<ProjectRepository[]> {
  const result = await listRepositories(database(), {
    actorUserId: who.userId,
    projectId,
  });
  assert.ok(result.listed, JSON.stringify(result));
  return result.repositories;
}

async function repositoryRow(id: RepositoryId) {
  const [row] = await database()
    .select()
    .from(repositories)
    .where(eq(repositories.id, id));
  assert.ok(row !== undefined);
  return row;
}

/** How many repositories the project has, removed ones included. */
async function countOf(projectId: ProjectId): Promise<number> {
  const rows = await database()
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.projectId, projectId));
  return rows.length;
}

async function archiveProject(id: ProjectId): Promise<void> {
  await database()
    .update(projects)
    .set({ archivedAt: NOW })
    .where(eq(projects.id, id));
}

/** Inserts `n` repositories of the account directly, registered at `createdAt`. */
async function fill(
  projectId: ProjectId,
  by: Account,
  n: number,
  createdAt: Date = new Date(NOW.getTime() - 2 * DAY_MS),
): Promise<RepositoryId[]> {
  const rows = Array.from({ length: n }, (_, index) => ({
    id: newId<RepositoryId>(),
    projectId,
    name: `Filler ${index}`,
    createdByUserId: by.userId,
    createdAt,
  }));
  await database().insert(repositories).values(rows);
  return rows.map((row) => row.id);
}

/** An agent of the account in the project, on the account's device. */
async function agentOf(projectId: ProjectId, owner: Account): Promise<AgentId> {
  const id = newId<AgentId>();
  await database().insert(agents).values({
    id,
    projectId,
    ownerUserId: owner.userId,
    hostDeviceId: owner.deviceId,
    name: "Builder",
  });
  return id;
}

/** A grant of `repo.read` on the repository to the agent, by its owner. */
async function grantTo(
  projectId: ProjectId,
  repositoryId: RepositoryId | null,
  agentId: AgentId,
  owner: Account,
  values: Partial<typeof permissionGrants.$inferInsert> = {},
): Promise<PermissionGrantId> {
  const id = newId<PermissionGrantId>();
  await database()
    .insert(permissionGrants)
    .values({
      id,
      projectId,
      granteeAgentId: agentId,
      hostDeviceId: owner.deviceId,
      capability: "repo.read",
      repositoryId,
      grantedByUserId: owner.userId,
      createdAt: new Date(NOW.getTime() - 2 * HOUR_MS),
      ...values,
    });
  return id;
}

/** A run of the agent on the repository that the agent's owner asked for. */
async function runOf(
  projectId: ProjectId,
  repositoryId: RepositoryId,
  agentId: AgentId,
  owner: Account,
  state: RunState,
): Promise<void> {
  const finished =
    state === "completed" || state === "failed" || state === "cancelled";
  await database()
    .insert(agentRuns)
    .values({
      id: newId<RunId>(),
      agentId,
      projectId,
      repositoryId,
      requestedByUserId: owner.userId,
      state,
      ...(finished ? { finishedAt: EARLIER } : {}),
    });
}

async function grantRow(id: PermissionGrantId) {
  const [row] = await database()
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function auditedActions(workspaceId: WorkspaceId): Promise<string[]> {
  const audited = await database()
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId));
  return audited.map((record) => record.action);
}

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

test("any active member registers a repository with its project, its name, and the registering account, and nothing is audited", async () => {
  const db = database();
  const owner = await account("Owner");
  const member = await account("Member");
  const workspaceId = await workspaceOf(owner);
  const memberPerson = await join(workspaceId, member);
  const projectId = await projectIn(workspaceId, owner);

  const byOwner = await registerRepository(db, {
    projectId,
    userId: owner.userId,
    name: "App",
    now: NOW,
  });
  assert.ok(byOwner.registered);
  assert.deepEqual(byOwner, {
    registered: true,
    workspaceId,
    repository: {
      id: byOwner.repository.id,
      projectId,
      name: "App",
      createdByMemberId: await personOf(workspaceId, owner),
    },
  });
  assert.ok(ProjectRepositorySchema.safeParse(byOwner.repository).success);
  const byMember = await registered(projectId, member, "Website", LATER);
  assert.equal(byMember.createdByMemberId, memberPerson);
  assert.deepEqual(await listed(projectId, member), [
    byOwner.repository,
    byMember,
  ]);

  const row = await repositoryRow(byOwner.repository.id);
  assert.deepEqual(row, {
    id: byOwner.repository.id,
    projectId,
    name: "App",
    createdByUserId: owner.userId,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  });
  assert.equal(
    (await repositoryRow(byMember.id)).createdByUserId,
    member.userId,
  );

  // Registering a repository is not an administrative action of ADR 0014.
  assert.deepEqual(await auditedActions(workspaceId), ["workspace.created"]);
});

test("the table of repositories has no column for a path or a remote URL", async () => {
  assert.ok(testDatabase);
  const { rows } = await testDatabase.client.query<{ name: string }>(
    `select column_name as name from information_schema.columns
      where table_schema = 'public' and table_name = 'repositories'
      order by ordinal_position`,
  );
  assert.deepEqual(
    rows.map((row) => row.name),
    [
      "id",
      "project_id",
      "name",
      "created_by_user_id",
      "created_at",
      "updated_at",
      "archived_at",
    ],
  );
});

test("the list holds the project's repositories that are not removed, the oldest first, also of an archived project, and a project without one lists none", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectIn(workspaceId, owner);
  const other = await projectIn(workspaceId, owner, "Website");
  const empty = await projectIn(workspaceId, owner, "Docs");
  const first = await registered(projectId, owner, "Zeta", NOW);
  const removed = await registered(projectId, owner, "Old", NOW);
  const second = await registered(projectId, owner, "Alpha", LATER);
  const elsewhere = await registered(other, owner, "Elsewhere", NOW);
  assert.ok((await remove(projectId, removed.id, owner)).removed);

  const createdByMemberId = await personOf(workspaceId, owner);
  assert.deepEqual(await listed(projectId, owner), [
    { id: first.id, projectId, name: "Zeta", createdByMemberId },
    { id: second.id, projectId, name: "Alpha", createdByMemberId },
  ]);
  assert.deepEqual(await listed(other, owner), [elsewhere]);
  assert.deepEqual(
    await listRepositories(database(), {
      actorUserId: owner.userId,
      projectId: empty,
    }),
    { listed: true, repositories: [] },
  );

  // An archived project's repositories stay readable.
  await archiveProject(projectId);
  assert.deepEqual(
    (await listed(projectId, owner)).map((repository) => repository.id),
    [first.id, second.id],
  );
});

test("a non-member, a removed member, and an unknown project are refused as no member and read nothing, and nothing is written", async () => {
  const owner = await account("Owner");
  const outsider = await account("Outsider");
  const former = await account("Former");
  const workspaceId = await workspaceOf(owner);
  const formerPerson = await join(workspaceId, former);
  const projectId = await projectIn(workspaceId, owner);
  // The former member registered it while a member.
  const repository = await registered(projectId, former, "App");
  await database()
    .update(workspaceMembers)
    .set({ removedAt: NOW, removedByUserId: owner.userId })
    .where(eq(workspaceMembers.id, formerPerson));

  for (const [who, project] of [
    [outsider, projectId],
    [former, projectId],
    [owner, newId<ProjectId>()],
  ] as const) {
    assert.deepEqual(await register(project, who, "Website", LATER), {
      registered: false,
      refusal: "not_member",
    });
    assert.deepEqual(await remove(project, repository.id, who), {
      removed: false,
      refusal: "not_member",
    });
    assert.deepEqual(
      await listRepositories(database(), {
        actorUserId: who.userId,
        projectId: project,
      }),
      { listed: false, refusal: "not_found" },
    );
  }
  assert.equal(await countOf(projectId), 1);
  assert.equal((await repositoryRow(repository.id)).archivedAt, null);
  // The former member's repository still names its former person.
  assert.deepEqual(await listed(projectId, owner), [
    { ...repository, createdByMemberId: formerPerson },
  ]);
});

test("a name is a label: two repositories of a project may share it, and it is stored as given", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectIn(workspaceId, owner);
  const first = await registered(projectId, owner, "App");
  const second = await registered(projectId, owner, "App", LATER);
  assert.notEqual(first.id, second.id);
  // Neither normalized nor trimmed: the protocol decides what a name may be.
  const decomposed = " Cafe\u0301 ";
  const third = await registered(projectId, owner, decomposed, LATER);
  assert.equal((await repositoryRow(third.id)).name, decomposed);
  assert.deepEqual(
    (await listed(projectId, owner)).map((repository) => repository.name),
    ["App", "App", decomposed],
  );

  // The length is the database's too, whatever the writer.
  for (const name of ["", "a".repeat(101)]) {
    await rejectsWith(
      () =>
        database().insert(repositories).values({
          id: newId<RepositoryId>(),
          projectId,
          name,
          createdByUserId: owner.userId,
        }),
      "23514",
      "repositories_name_length",
    );
  }
});

test("an archived project takes no registration and no removal, each a conflict, after the other refusals", async () => {
  const owner = await account("Owner");
  const member = await account("Member");
  const workspaceId = await workspaceOf(owner);
  await join(workspaceId, member);
  const projectId = await projectIn(workspaceId, owner);
  const repository = await registered(projectId, owner, "App");
  await archiveProject(projectId);

  assert.deepEqual(await register(projectId, owner, "Website", LATER), {
    registered: false,
    refusal: "conflict",
  });
  assert.deepEqual(await remove(projectId, repository.id, owner), {
    removed: false,
    refusal: "conflict",
  });
  // The order of the refusals: not found, then forbidden, then the conflict.
  assert.deepEqual(await remove(projectId, newId<RepositoryId>(), owner), {
    removed: false,
    refusal: "not_found",
  });
  assert.deepEqual(await remove(projectId, repository.id, member), {
    removed: false,
    refusal: "forbidden",
  });
  assert.equal(await countOf(projectId), 1);
  assert.equal((await repositoryRow(repository.id)).archivedAt, null);
});

test(`a project holds at most ${PER_PROJECT} repositories that are not removed; the next is refused with repository_limit, and a removal frees a place`, async () => {
  const owner = await account("Owner");
  const member = await account("Member");
  const workspaceId = await workspaceOf(owner);
  await join(workspaceId, member);
  const projectId = await projectIn(workspaceId, owner);
  const other = await projectIn(workspaceId, owner, "Website");
  const filled = await fill(projectId, owner, PER_PROJECT - 1);
  await registered(projectId, member, "Last");

  for (const who of [member, owner]) {
    assert.deepEqual(await register(projectId, who, "One more", LATER), {
      registered: false,
      refusal: "repository_limit",
    });
  }
  assert.equal(await countOf(projectId), PER_PROJECT);
  // The limit is the project's: another project of the workspace has room.
  await registered(other, member, "Elsewhere", LATER);

  const [first] = filled;
  assert.ok(first !== undefined);
  assert.ok((await remove(projectId, first, owner)).removed);
  await registered(projectId, member, "One more", LATER);
  assert.equal((await listed(projectId, owner)).length, PER_PROJECT);
  assert.deepEqual(await register(projectId, member, "And another", LATER), {
    registered: false,
    refusal: "repository_limit",
  });
});

test(`an account registers at most ${PER_DAY} repositories within 24 hours, in all its projects together, removed ones included, and the window slides`, async () => {
  const owner = await account("Owner");
  const other = await account("Other");
  const firstWorkspace = await workspaceOf(owner);
  const secondWorkspace = await workspaceOf(owner);
  await join(firstWorkspace, other);
  const first = await projectIn(firstWorkspace, owner);
  const second = await projectIn(secondWorkspace, owner);
  const archived = await projectIn(firstWorkspace, owner, "Old");
  await archiveProject(archived);
  // Another account's repositories and a refused registration do not count.
  await registered(first, other, "Theirs");
  assert.deepEqual(await register(archived, owner, "Refused"), {
    registered: false,
    refusal: "conflict",
  });
  const oldest = await registered(first, owner, "Repository 0", NOW);
  const later = new Date(NOW.getTime() + HOUR_MS);
  for (let index = 1; index < PER_DAY; index += 1) {
    await registered(
      index % 2 === 0 ? first : second,
      owner,
      `Repository ${index}`,
      later,
    );
  }
  // A removed repository still counts: the limit bounds the rows an account
  // adds, not the repositories it keeps.
  assert.ok((await remove(first, oldest.id, owner, later)).removed);

  const asked = new Date(NOW.getTime() + 2 * HOUR_MS);
  // The first leaves the window 24 hours after its registration.
  assert.deepEqual(await register(second, owner, "One more", asked), {
    registered: false,
    refusal: "rate_limited",
    retryAfterMs: DAY_MS - 2 * HOUR_MS,
  });
  // The other account is not limited by it.
  await registered(first, other, "Mine", asked);

  // A registration exactly 24 hours later no longer counts.
  const dayLater = new Date(NOW.getTime() + DAY_MS);
  await registered(second, owner, "One more", dayLater);
  assert.deepEqual(await register(second, owner, "And another", dayLater), {
    registered: false,
    refusal: "rate_limited",
    retryAfterMs: HOUR_MS,
  });
});

test("a registration at both limits is refused with repository_limit, and the account's limit alone with rate_limited", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectIn(workspaceId, owner);
  // The account registered all of them within the last hour.
  const filled = await fill(projectId, owner, PER_PROJECT, EARLIER);
  assert.ok(PER_PROJECT >= PER_DAY, "the project is full at the daily limit");

  assert.deepEqual(await register(projectId, owner, "One more"), {
    registered: false,
    refusal: "repository_limit",
  });
  const [first] = filled;
  assert.ok(first !== undefined);
  assert.ok((await remove(projectId, first, owner, NOW)).removed);
  assert.deepEqual(await register(projectId, owner, "One more"), {
    registered: false,
    refusal: "rate_limited",
    retryAfterMs: DAY_MS - HOUR_MS,
  });
});

test("the type checker gives the daily limit a numeric wait and the limit of a project none", () => {
  const typeOnly = (
    refused: Extract<RegisterRepositoryResult, { registered: false }>,
  ): unknown => {
    if (refused.refusal === "rate_limited") {
      // A wait of null would no longer be a number.
      const wait: number = refused.retryAfterMs;
      return wait;
    }
    if (refused.refusal === "repository_limit") {
      // Narrowed to the variants that can refuse with repository_limit: none
      // of them may have a wait, not even a null one.
      const noWait: "retryAfterMs" extends keyof typeof refused ? never : true =
        true;
      return noWait;
    }
    return undefined;
  };
  assert.equal(typeof typeOnly, "function");
});

test("the registering account, the owner, and an admin remove a repository; another member is forbidden, and an unknown repository or one of another project is not found", async () => {
  const owner = await account("Owner");
  const admin = await account("Admin");
  const registrant = await account("Registrant");
  const member = await account("Member");
  const workspaceId = await workspaceOf(owner);
  await join(workspaceId, admin, "admin");
  await join(workspaceId, registrant);
  await join(workspaceId, member);
  const projectId = await projectIn(workspaceId, owner);
  const other = await projectIn(workspaceId, owner, "Website");
  const mine = await registered(projectId, registrant, "Mine");
  const forOwner = await registered(projectId, registrant, "For the owner");
  const forAdmin = await registered(projectId, registrant, "For the admin");
  const ofOwner = await registered(projectId, owner, "The owner's");
  const foreign = await registered(other, owner, "Foreign");

  // A member removes only what its own account registered.
  for (const [by, repository] of [
    [member, mine],
    [registrant, ofOwner],
  ] as const) {
    assert.deepEqual(await remove(projectId, repository.id, by), {
      removed: false,
      refusal: "forbidden",
    });
    assert.equal((await repositoryRow(repository.id)).archivedAt, null);
  }
  for (const [by, repository] of [
    [registrant, mine],
    [owner, forOwner],
    [admin, forAdmin],
  ] as const) {
    assert.deepEqual(await remove(projectId, repository.id, by), {
      removed: true,
      workspaceId,
      revokedGrantIds: [],
    });
    const row = await repositoryRow(repository.id);
    assert.deepEqual(row.archivedAt, LATER);
    assert.deepEqual(row.updatedAt, LATER);
    assert.deepEqual(row.createdAt, NOW);
    assert.equal(row.name, repository.name);
    assert.equal(row.createdByUserId, registrant.userId);
  }
  assert.deepEqual(await listed(projectId, member), [ofOwner]);

  for (const repositoryId of [newId<RepositoryId>(), foreign.id]) {
    assert.deepEqual(await remove(projectId, repositoryId, owner), {
      removed: false,
      refusal: "not_found",
    });
  }
  assert.equal((await repositoryRow(foreign.id)).archivedAt, null);
  // An unknown repository is not found before any right is checked.
  assert.deepEqual(await remove(projectId, newId<RepositoryId>(), member), {
    removed: false,
    refusal: "not_found",
  });

  // Removing a repository writes no audit record either.
  assert.deepEqual(await auditedActions(workspaceId), ["workspace.created"]);
});

test("the registering account still removes its repository after leaving the workspace and joining again as a new person, which the repository then names", async () => {
  const owner = await account("Owner");
  const registrant = await account("Registrant");
  const workspaceId = await workspaceOf(owner);
  // The account is also active in a workspace of its own, as its owner.
  await workspaceOf(registrant);
  const person = await join(workspaceId, registrant);
  const projectId = await projectIn(workspaceId, owner);
  const repository = await registered(projectId, registrant, "App");
  await database()
    .update(workspaceMembers)
    .set({ removedAt: NOW, removedByUserId: registrant.userId })
    .where(eq(workspaceMembers.id, person));
  // The repository names the account's removed person while it has no other
  // in this workspace, never its person of another workspace.
  assert.deepEqual(
    (await listed(projectId, owner)).map((item) => item.createdByMemberId),
    [person],
  );
  const rejoined = await join(workspaceId, registrant);
  // Then the account's active person, which holds the account's rights.
  assert.deepEqual(
    (await listed(projectId, owner)).map((item) => item.createdByMemberId),
    [rejoined],
  );
  assert.deepEqual(await remove(projectId, repository.id, registrant), {
    removed: true,
    workspaceId,
    revokedGrantIds: [],
  });
});

test("a removed repository keeps its row and its name, is removed only once, and never comes back; registering again gives a new repository", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectIn(workspaceId, owner);
  const repository = await registered(projectId, owner, "App");
  assert.ok((await remove(projectId, repository.id, owner, LATER)).removed);

  const evenLater = new Date(LATER.getTime() + HOUR_MS);
  assert.deepEqual(await remove(projectId, repository.id, owner, evenLater), {
    removed: false,
    refusal: "conflict",
  });
  const row = await repositoryRow(repository.id);
  assert.equal(row.name, "App");
  assert.deepEqual(row.archivedAt, LATER);
  assert.deepEqual(row.updatedAt, LATER);
  assert.deepEqual(await listed(projectId, owner), []);

  const again = await registered(projectId, owner, "App", evenLater);
  assert.notEqual(again.id, repository.id);
  assert.deepEqual(await listed(projectId, owner), [again]);
  assert.equal(await countOf(projectId), 2);
});

test("a removal revokes every grant scoped to the repository that is not revoked yet, with the remover as the revoker, and touches no other grant, no agent, and no run", async () => {
  const db = database();
  const owner = await account("Owner");
  const alice = await account("Alice");
  const bob = await account("Bob");
  const workspaceId = await workspaceOf(owner);
  await join(workspaceId, alice);
  await join(workspaceId, bob);
  const projectId = await projectIn(workspaceId, owner);
  const removed = await registered(projectId, alice, "App");
  const kept = await registered(projectId, alice, "Website");
  const aliceAgent = await agentOf(projectId, alice);
  const bobAgent = await agentOf(projectId, bob);

  // On the removed repository: an active grant, an expired one that was
  // never revoked, another person's agent's, and one revoked before.
  const active = await grantTo(projectId, removed.id, aliceAgent, alice);
  const expired = await grantTo(projectId, removed.id, aliceAgent, alice, {
    capability: "repo.write",
    expiresAt: EARLIER,
  });
  const ofBob = await grantTo(projectId, removed.id, bobAgent, bob, {
    capability: "terminal.execute",
    expiresAt: new Date(NOW.getTime() + DAY_MS),
  });
  const revokedBefore = await grantTo(
    projectId,
    removed.id,
    aliceAgent,
    alice,
    {
      capability: "git.commit",
      revokedAt: EARLIER,
      revokedByUserId: alice.userId,
    },
  );
  // Outside it: a grant on the project's other repository, and a
  // `provider.use` grant, which names no repository.
  const onKept = await grantTo(projectId, kept.id, aliceAgent, alice);
  const connectionId = newId<ProviderConnectionId>();
  await db.insert(providerConnections).values({
    id: connectionId,
    hostDeviceId: alice.deviceId,
    kind: "claude",
    label: "Work",
  });
  const onProvider = await grantTo(projectId, null, aliceAgent, alice, {
    capability: "provider.use",
    providerConnectionId: connectionId,
  });
  // Runs on the removed repository: unfinished in each state, and finished.
  await runOf(projectId, removed.id, aliceAgent, alice, "queued");
  await runOf(projectId, removed.id, aliceAgent, alice, "running");
  await runOf(projectId, removed.id, bobAgent, bob, "awaiting_input");
  await runOf(projectId, removed.id, aliceAgent, alice, "completed");
  const runsBefore = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.projectId, projectId));
  assert.deepEqual(runsBefore.map((run) => run.state).sort(), [
    "awaiting_input",
    "completed",
    "queued",
    "running",
  ]);
  const agentsBefore = await db
    .select()
    .from(agents)
    .where(eq(agents.projectId, projectId));

  const result = await remove(projectId, removed.id, owner, LATER);
  assert.deepEqual(result, {
    removed: true,
    workspaceId,
    revokedGrantIds: [active, expired, ofBob].sort(),
  });
  assert.ok(result.removed && Object.isFrozen(result.revokedGrantIds));
  for (const id of [active, expired, ofBob]) {
    const row = await grantRow(id);
    assert.deepEqual(row.revokedAt, LATER, id);
    assert.equal(row.revokedByUserId, owner.userId, id);
  }
  // A grant revoked before keeps its revoker and its time.
  const before = await grantRow(revokedBefore);
  assert.deepEqual(before.revokedAt, EARLIER);
  assert.equal(before.revokedByUserId, alice.userId);
  for (const id of [onKept, onProvider]) {
    const row = await grantRow(id);
    assert.equal(row.revokedAt, null, id);
    assert.equal(row.revokedByUserId, null, id);
  }
  // P-77 names the grants only: every run and every agent stays as it was.
  assert.deepEqual(
    await db.select().from(agentRuns).where(eq(agentRuns.projectId, projectId)),
    runsBefore,
  );
  assert.deepEqual(
    await db.select().from(agents).where(eq(agents.projectId, projectId)),
    agentsBefore,
  );

  // Nothing restores a revoked grant, also not clearing `archived_at`.
  await db
    .update(repositories)
    .set({ archivedAt: null })
    .where(eq(repositories.id, removed.id));
  for (const id of [active, expired, ofBob]) {
    assert.deepEqual((await grantRow(id)).revokedAt, LATER, id);
  }

  // The registering account's removal revokes other people's grants too,
  // and is then their revoker.
  const ofBobOnKept = await grantTo(projectId, kept.id, bobAgent, bob);
  assert.deepEqual(await remove(projectId, kept.id, alice, LATER), {
    removed: true,
    workspaceId,
    revokedGrantIds: [onKept, ofBobOnKept].sort(),
  });
  assert.equal((await grantRow(ofBobOnKept)).revokedByUserId, alice.userId);
  assert.equal((await grantRow(onProvider)).revokedAt, null);
});

test("a refused removal revokes nothing", async () => {
  const owner = await account("Owner");
  const alice = await account("Alice");
  const member = await account("Member");
  const outsider = await account("Outsider");
  const workspaceId = await workspaceOf(owner);
  await join(workspaceId, alice);
  await join(workspaceId, member);
  const projectId = await projectIn(workspaceId, owner);
  const other = await projectIn(workspaceId, owner, "Website");
  const repository = await registered(projectId, alice, "App");
  const agentId = await agentOf(projectId, alice);
  const grant = await grantTo(projectId, repository.id, agentId, alice);

  assert.deepEqual(await remove(projectId, repository.id, member), {
    removed: false,
    refusal: "forbidden",
  });
  assert.deepEqual(await remove(projectId, repository.id, outsider), {
    removed: false,
    refusal: "not_member",
  });
  // Named through another project of the workspace, it is not found.
  assert.deepEqual(await remove(other, repository.id, owner), {
    removed: false,
    refusal: "not_found",
  });
  assert.equal((await grantRow(grant)).revokedAt, null);
  assert.equal((await repositoryRow(repository.id)).archivedAt, null);
});

test("the removal and its revocations are one transaction, and inside another transaction a refusal changes nothing and lets it go on", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectIn(workspaceId, owner);
  const archived = await projectIn(workspaceId, owner, "Old");
  await archiveProject(archived);
  const repository = await registered(projectId, owner, "App");
  const agentId = await agentOf(projectId, owner);
  const grant = await grantTo(projectId, repository.id, agentId, owner);

  // An outer transaction that fails after the removal undoes both.
  await assert.rejects(
    database().transaction(async (tx) => {
      const result = await removeRepository(tx, {
        projectId,
        repositoryId: repository.id,
        userId: owner.userId,
        now: LATER,
      });
      assert.deepEqual(result, {
        removed: true,
        workspaceId,
        revokedGrantIds: [grant],
      });
      throw new Error("the outer transaction fails");
    }),
    /the outer transaction fails/u,
  );
  assert.equal((await repositoryRow(repository.id)).archivedAt, null);
  assert.equal((await grantRow(grant)).revokedAt, null);

  await database().transaction(async (tx) => {
    assert.deepEqual(
      await registerRepository(tx, {
        projectId: archived,
        userId: owner.userId,
        name: "Refused",
        now: LATER,
      }),
      { registered: false, refusal: "conflict" },
    );
    assert.deepEqual(
      await removeRepository(tx, {
        projectId,
        repositoryId: newId<RepositoryId>(),
        userId: owner.userId,
        now: LATER,
      }),
      { removed: false, refusal: "not_found" },
    );
    // The outer transaction goes on.
    await registeredIn(tx, projectId, owner, "Website", LATER);
    const removed = await removeRepository(tx, {
      projectId,
      repositoryId: repository.id,
      userId: owner.userId,
      now: LATER,
    });
    assert.ok(removed.removed);
  });
  assert.deepEqual(
    (await listed(projectId, owner)).map((item) => item.name),
    ["Website"],
  );
  assert.deepEqual((await grantRow(grant)).revokedAt, LATER);
});

test("a repository whose registering account has no person in the project's workspace fails the whole list", async () => {
  const owner = await account("Owner");
  const outsider = await account("Outsider");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectIn(workspaceId, owner);
  await registered(projectId, owner, "App");
  await fill(projectId, outsider, 1);
  await assert.rejects(
    listRepositories(database(), { actorUserId: owner.userId, projectId }),
    /^Error: Invariant broken: the registering account of a repository has no person in its project's workspace$/u,
  );
});

test(
  `a registration waits at the project row for a concurrent registration by another person that reaches the limit of ${PER_PROJECT}, and is then repository_limit`,
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const member = await account("Member");
    const workspaceId = await workspaceOf(owner);
    await join(workspaceId, member);
    const projectId = await projectIn(workspaceId, owner);
    await fill(projectId, owner, PER_PROJECT - 1);
    // Each registration locks another account and person, so only the
    // project row orders them.
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) => registeredIn(tx, projectId, owner, "Last"),
      () => register(projectId, member, "One more"),
    );
    assert.deepEqual(result, {
      registered: false,
      refusal: "repository_limit",
    });
    assert.deepEqual(waitedOn, ["projects"]);
    assert.equal((await listed(projectId, owner)).length, PER_PROJECT);
  },
);

test(
  `a registration waits at the account's row for a concurrent registration of the same account in another project that reaches its limit of ${PER_DAY} a day, and is then rate_limited`,
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const workspaceId = await workspaceOf(owner);
    const first = await projectIn(workspaceId, owner);
    const second = await projectIn(workspaceId, owner, "Website");
    const third = await projectIn(workspaceId, owner, "Docs");
    // Spread over two projects, so that no project is full.
    for (let index = 0; index < PER_DAY - 1; index += 1) {
      await registered(
        index % 2 === 0 ? first : second,
        owner,
        `Repository ${index}`,
        NOW,
      );
    }
    // The project rows differ, so only the account's row orders them.
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) => registeredIn(tx, third, owner, "Last", LATER),
      () => register(second, owner, "One more", LATER),
    );
    assert.deepEqual(result, {
      registered: false,
      refusal: "rate_limited",
      retryAfterMs: DAY_MS - (LATER.getTime() - NOW.getTime()),
    });
    assert.deepEqual(waitedOn, ["users"]);
    assert.equal((await listed(third, owner)).length, 1);
  },
);

test(
  "a registration waits for a concurrent removal of the registering person and is then refused as no member",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const member = await account("Member");
    const workspaceId = await workspaceOf(owner);
    const person = await join(workspaceId, member);
    const projectId = await projectIn(workspaceId, owner);
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) =>
        removeMember(tx, {
          workspaceId,
          ...owner,
          memberId: person,
          now: NOW,
        }),
      () => register(projectId, member, "App", LATER),
    );
    assert.deepEqual(result, { registered: false, refusal: "not_member" });
    assert.deepEqual(waitedOn, ["workspace_members"]);
    assert.equal(await countOf(projectId), 0);
  },
);

test(
  "a removal waits at the project row for a concurrent removal of the same repository by another person, and is then a conflict",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const admin = await account("Admin");
    const workspaceId = await workspaceOf(owner);
    await join(workspaceId, admin, "admin");
    const projectId = await projectIn(workspaceId, owner);
    const repository = await registered(projectId, owner, "App");
    const agentId = await agentOf(projectId, owner);
    const grant = await grantTo(projectId, repository.id, agentId, owner);
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const removed = await removeRepository(tx, {
          projectId,
          repositoryId: repository.id,
          userId: owner.userId,
          now: NOW,
        });
        assert.ok(removed.removed, JSON.stringify(removed));
      },
      () => remove(projectId, repository.id, admin, LATER),
    );
    assert.deepEqual(result, { removed: false, refusal: "conflict" });
    assert.deepEqual(waitedOn, ["projects"]);
    // The first removal revoked the grant, and the refused one changed nothing.
    const row = await grantRow(grant);
    assert.deepEqual(row.revokedAt, NOW);
    assert.equal(row.revokedByUserId, owner.userId);
    assert.deepEqual((await repositoryRow(repository.id)).archivedAt, NOW);
  },
);

test(
  "a removal waits at the repository row for a writer that holds it FOR SHARE while it inserts a grant, and then revokes that grant",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const alice = await account("Alice");
    const workspaceId = await workspaceOf(owner);
    await join(workspaceId, alice);
    const projectId = await projectIn(workspaceId, owner);
    const repository = await registered(projectId, owner, "App");
    const agentId = await agentOf(projectId, alice);
    const grant = newId<PermissionGrantId>();
    // The rule for a writer of grants: it holds the repository's row
    // `FOR SHARE` until it commits, so a removal never misses its grant.
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const [row] = await tx
          .select({ archivedAt: repositories.archivedAt })
          .from(repositories)
          .where(eq(repositories.id, repository.id))
          .for("share");
        assert.equal(row?.archivedAt, null);
        await tx.insert(permissionGrants).values({
          id: grant,
          projectId,
          granteeAgentId: agentId,
          hostDeviceId: alice.deviceId,
          capability: "repo.read",
          repositoryId: repository.id,
          grantedByUserId: alice.userId,
          createdAt: NOW,
        });
      },
      () => remove(projectId, repository.id, owner, LATER),
    );
    assert.deepEqual(result, {
      removed: true,
      workspaceId,
      revokedGrantIds: [grant],
    });
    assert.deepEqual(waitedOn, ["repositories"]);
    const row = await grantRow(grant);
    assert.deepEqual(row.revokedAt, LATER);
    assert.equal(row.revokedByUserId, owner.userId);
  },
);

test(
  "a registration by the owner waits for a concurrent erasure of the owner's account that archives the workspace, and is then refused as no member",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    await database()
      .insert(userIdentities)
      .values({
        id: newUuidV7(),
        userId: owner.userId,
        identityProvider: "github",
        subject: String(randomBytes(4).readUInt32BE()),
        login: "owner-login",
        accountCreatedAt: NOW,
        lastSignInAt: NOW,
      });
    const workspaceId = await workspaceOf(owner);
    const projectId = await projectIn(workspaceId, owner);
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const erasure = await eraseAccount(tx, {
          userId: owner.userId,
          now: NOW,
        });
        assert.ok(erasure.erased, JSON.stringify(erasure));
      },
      () => register(projectId, owner, "App", LATER),
    );
    assert.deepEqual(result, { registered: false, refusal: "not_member" });
    assert.deepEqual(waitedOn, ["users"]);
    assert.equal(await countOf(projectId), 0);
  },
);
