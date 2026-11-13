import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  type DeviceId,
  type MemberId,
  type MemberRole,
  newId,
  newUuidV7,
  type ProjectId,
  type UserId,
  type WorkspaceId,
  WorkspaceProjectSchema,
} from "@mymandev/protocol";
import { and, eq, isNull } from "drizzle-orm";
import { createDatabase } from "./client.ts";
import { eraseAccount } from "./account-erasure.ts";
import type { Database } from "./db.ts";
import { DatabaseError, withDatabaseErrors } from "./errors.ts";
import { migrationsFolder } from "./migrate.ts";
import { activePersonOf, createWorkspace } from "./membership.ts";
import { removeMember } from "./people.ts";
import {
  createProject,
  type CreateProjectResult,
  listProjects,
  MAX_ACTIVE_PROJECTS_PER_WORKSPACE,
  MAX_NEW_PROJECTS_PER_DAY,
  renameProject,
} from "./projects.ts";
import {
  auditEvents,
  conversations,
  devices,
  projects,
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
const NOW = new Date("2026-11-02T12:00:00.000Z");
const LATER = new Date("2026-11-02T13:00:00.000Z");

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

/** A workspace of `owner`, created a day before `NOW`, with the owner's person. */
async function workspaceOf(owner: Account): Promise<WorkspaceId> {
  const result = await createWorkspace(database(), {
    ...owner,
    name: "Team",
    displayName: "Owner",
    now: new Date(NOW.getTime() - DAY_MS),
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

/** Creates a project that must be created, and returns its ID. */
async function created(
  workspaceId: WorkspaceId,
  by: Account,
  name: string,
  now: Date = NOW,
): Promise<ProjectId> {
  const result = await createProject(database(), {
    workspaceId,
    userId: by.userId,
    name,
    now,
  });
  assert.ok(result.created, JSON.stringify(result));
  return result.project.id;
}

async function projectRow(id: ProjectId) {
  const [row] = await database()
    .select()
    .from(projects)
    .where(eq(projects.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function archive(id: ProjectId): Promise<void> {
  await database()
    .update(projects)
    .set({ archivedAt: NOW })
    .where(eq(projects.id, id));
}

async function conversationsOf(projectId: ProjectId) {
  return database()
    .select()
    .from(conversations)
    .where(eq(conversations.projectId, projectId));
}

/**
 * The names of the workspace's projects that are not archived, sorted by
 * code unit, not by the server's collation.
 */
async function activeNames(workspaceId: WorkspaceId): Promise<string[]> {
  const rows = await database()
    .select({ name: projects.name })
    .from(projects)
    .where(
      and(eq(projects.workspaceId, workspaceId), isNull(projects.archivedAt)),
    );
  return rows.map((row) => row.name).sort();
}

/** How many projects and conversations the workspace has, archived ones included. */
async function countsOf(workspaceId: WorkspaceId) {
  const rows = await database()
    .select({ project: projects.id, conversation: conversations.id })
    .from(projects)
    .leftJoin(conversations, eq(conversations.projectId, projects.id))
    .where(eq(projects.workspaceId, workspaceId));
  return {
    projects: new Set(rows.map((row) => row.project)).size,
    conversations: rows.filter((row) => row.conversation !== null).length,
  };
}

/** Inserts `n` projects of another account directly, created a day before `NOW`. */
async function fill(
  workspaceId: WorkspaceId,
  by: Account,
  n: number,
): Promise<ProjectId[]> {
  const rows = Array.from({ length: n }, (_, index) => ({
    id: newId<ProjectId>(),
    workspaceId,
    name: `Filler ${index}`,
    createdByUserId: by.userId,
    createdAt: new Date(NOW.getTime() - DAY_MS),
  }));
  await database().insert(projects).values(rows);
  return rows.map((row) => row.id);
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

test("any active member creates a project with its project conversation, and nothing is audited", async () => {
  const db = database();
  const owner = await account("Owner");
  const member = await account("Member");
  const workspaceId = await workspaceOf(owner);
  const memberPerson = await join(workspaceId, member);

  const byOwner = await createProject(db, {
    workspaceId,
    userId: owner.userId,
    name: "App",
    now: NOW,
  });
  assert.ok(byOwner.created);
  assert.deepEqual(byOwner.project, {
    id: byOwner.project.id,
    workspaceId,
    name: "App",
    createdByMemberId: await personOf(workspaceId, owner),
  });
  assert.ok(WorkspaceProjectSchema.safeParse(byOwner.project).success);
  const byMember = await created(workspaceId, member, "Website", LATER);
  assert.deepEqual(
    (await listProjects(db, workspaceId)).map((project) => [
      project.id,
      project.createdByMemberId,
    ]),
    [
      [byOwner.project.id, byOwner.project.createdByMemberId],
      [byMember, memberPerson],
    ],
  );

  const row = await projectRow(byOwner.project.id);
  assert.equal(row.workspaceId, workspaceId);
  assert.equal(row.createdByUserId, owner.userId);
  assert.deepEqual(row.createdAt, NOW);
  assert.deepEqual(row.updatedAt, NOW);
  assert.equal(row.archivedAt, null);
  assert.equal((await projectRow(byMember)).createdByUserId, member.userId);

  // Exactly one `project` conversation each, the project's chat.
  for (const [projectId, by, at] of [
    [byOwner.project.id, owner, NOW],
    [byMember, member, LATER],
  ] as const) {
    const rows = await conversationsOf(projectId);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      id: rows[0]?.id,
      projectId,
      kind: "project",
      title: null,
      createdByUserId: by.userId,
      lastSeq: 0,
      createdAt: at,
    });
  }

  // Creating a project is not an administrative action of ADR 0014.
  const audited = await db
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId));
  assert.deepEqual(
    audited.map((record) => record.action),
    ["workspace.created"],
  );
});

test("the list holds the workspace's projects that are not archived, the oldest first", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const other = await workspaceOf(owner);
  const first = await created(workspaceId, owner, "Zeta", NOW);
  const archived = await created(workspaceId, owner, "Old", NOW);
  const second = await created(workspaceId, owner, "Alpha", LATER);
  await created(other, owner, "Elsewhere", NOW);
  await archive(archived);
  // A rename keeps a project's place.
  const renamed = await renameProject(database(), {
    workspaceId,
    projectId: first,
    userId: owner.userId,
    name: "Omega",
    now: LATER,
  });
  assert.deepEqual(renamed, { renamed: true, changed: true });

  const createdByMemberId = await personOf(workspaceId, owner);
  assert.deepEqual(await listProjects(database(), workspaceId), [
    { id: first, workspaceId, name: "Omega", createdByMemberId },
    { id: second, workspaceId, name: "Alpha", createdByMemberId },
  ]);
  assert.deepEqual(await listProjects(database(), newId<WorkspaceId>()), []);
});

test("a non-member, a removed member, and an unknown workspace are refused as no member, and nothing is written", async () => {
  const owner = await account("Owner");
  const outsider = await account("Outsider");
  const former = await account("Former");
  const workspaceId = await workspaceOf(owner);
  const formerPerson = await join(workspaceId, former);
  await database()
    .update(workspaceMembers)
    .set({ removedAt: NOW, removedByUserId: owner.userId })
    .where(eq(workspaceMembers.id, formerPerson));
  const project = await created(workspaceId, owner, "App");

  for (const [who, workspace] of [
    [outsider, workspaceId],
    [former, workspaceId],
    [owner, newId<WorkspaceId>()],
  ] as const) {
    assert.deepEqual(
      await createProject(database(), {
        workspaceId: workspace,
        userId: who.userId,
        name: "Website",
        now: LATER,
      }),
      { created: false, refusal: "not_member" },
    );
    assert.deepEqual(
      await renameProject(database(), {
        workspaceId: workspace,
        projectId: project,
        userId: who.userId,
        name: "Website",
        now: LATER,
      }),
      { renamed: false, refusal: "not_member" },
    );
  }
  assert.deepEqual(await countsOf(workspaceId), {
    projects: 1,
    conversations: 1,
  });
  assert.equal((await projectRow(project)).name, "App");
});

test("a name that an active project of the workspace has, in any case, is a conflict; an archived project's name and another workspace's are free", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const other = await workspaceOf(owner);
  const app = await created(workspaceId, owner, "App");
  await created(workspaceId, owner, "\u00C4rger");

  for (const name of ["App", "app", "APP", "\u00E4RGER", "\u00C4RGER"]) {
    assert.deepEqual(
      await createProject(database(), {
        workspaceId,
        userId: owner.userId,
        name,
        now: LATER,
      }),
      { created: false, refusal: "conflict" },
      name,
    );
  }
  // The refused creations wrote nothing, a conversation neither.
  assert.deepEqual(await countsOf(workspaceId), {
    projects: 2,
    conversations: 2,
  });
  // Unicode's simple lowercase mapping: the sharp s (U+00DF) is not "ss", and a space counts.
  await created(workspaceId, owner, "Stra\u00DFe");
  await created(workspaceId, owner, "STRASSE");
  await created(workspaceId, owner, "App ");
  // Another workspace has its own names.
  await created(other, owner, "app");
  // An archived project leaves its name to a new one.
  await archive(app);
  const again = await created(workspaceId, owner, "app");
  assert.deepEqual(await activeNames(workspaceId), [
    "App ",
    "STRASSE",
    "Stra\u00DFe",
    "app",
    "\u00C4rger",
  ]);
  assert.equal((await conversationsOf(again)).length, 1);
});

test("inside another transaction, a refused creation or rename rolls back only its own savepoint", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  await created(workspaceId, owner, "App");
  const web = await created(workspaceId, owner, "Web");
  await database().transaction(async (tx) => {
    assert.deepEqual(
      await createProject(tx, {
        workspaceId,
        userId: owner.userId,
        name: "app",
        now: LATER,
      }),
      { created: false, refusal: "conflict" },
    );
    assert.deepEqual(
      await renameProject(tx, {
        workspaceId,
        projectId: web,
        userId: owner.userId,
        name: "APP",
        now: LATER,
      }),
      { renamed: false, refusal: "conflict" },
    );
    // The outer transaction goes on.
    const result = await createProject(tx, {
      workspaceId,
      userId: owner.userId,
      name: "Docs",
      now: LATER,
    });
    assert.ok(result.created);
  });
  assert.deepEqual(await activeNames(workspaceId), ["App", "Docs", "Web"]);
});

test(`a workspace holds at most ${MAX_ACTIVE_PROJECTS_PER_WORKSPACE} projects that are not archived; the next is refused with project_limit, and an archived project frees a place`, async () => {
  const owner = await account("Owner");
  const member = await account("Member");
  const workspaceId = await workspaceOf(owner);
  await join(workspaceId, member);
  const filled = await fill(
    workspaceId,
    owner,
    MAX_ACTIVE_PROJECTS_PER_WORKSPACE - 1,
  );
  await created(workspaceId, member, "Last");

  const refused = await createProject(database(), {
    workspaceId,
    userId: member.userId,
    name: "One more",
    now: LATER,
  });
  assert.deepEqual(refused, { created: false, refusal: "project_limit" });
  // The limit comes before the name: a clashing name is project_limit too.
  assert.deepEqual(
    await createProject(database(), {
      workspaceId,
      userId: owner.userId,
      name: "last",
      now: LATER,
    }),
    { created: false, refusal: "project_limit" },
  );

  const [first] = filled;
  assert.ok(first !== undefined);
  await archive(first);
  await created(workspaceId, member, "One more", LATER);
  assert.equal(
    (await listProjects(database(), workspaceId)).length,
    MAX_ACTIVE_PROJECTS_PER_WORKSPACE,
  );
});

test(`an account creates at most ${MAX_NEW_PROJECTS_PER_DAY} projects within 24 hours, in all its workspaces together, and the window slides`, async () => {
  const owner = await account("Owner");
  const other = await account("Other");
  const first = await workspaceOf(owner);
  const second = await workspaceOf(owner);
  await join(first, other);
  // Another account's projects and a refused creation do not count.
  await created(first, other, "Theirs");
  assert.deepEqual(
    await createProject(database(), {
      workspaceId: first,
      userId: owner.userId,
      name: "theirs",
      now: NOW,
    }),
    { created: false, refusal: "conflict" },
  );
  await created(first, owner, "Project 0", NOW);
  const later = new Date(NOW.getTime() + HOUR_MS);
  for (let index = 1; index < MAX_NEW_PROJECTS_PER_DAY; index += 1) {
    await created(
      index % 2 === 0 ? first : second,
      owner,
      `Project ${index}`,
      later,
    );
  }

  const asked = new Date(NOW.getTime() + 2 * HOUR_MS);
  const refused = await createProject(database(), {
    workspaceId: second,
    userId: owner.userId,
    name: "One more",
    now: asked,
  });
  // The first leaves the window 24 hours after its creation.
  assert.deepEqual(refused, {
    created: false,
    refusal: "rate_limited",
    retryAfterMs: DAY_MS - 2 * HOUR_MS,
  });
  // The other account is not limited by it.
  await created(first, other, "Mine", asked);

  // A creation exactly 24 hours later no longer counts.
  await created(second, owner, "One more", new Date(NOW.getTime() + DAY_MS));
  const next = await createProject(database(), {
    workspaceId: second,
    userId: owner.userId,
    name: "And another",
    now: new Date(NOW.getTime() + DAY_MS),
  });
  assert.deepEqual(next, {
    created: false,
    refusal: "rate_limited",
    retryAfterMs: HOUR_MS,
  });
});

test("the type checker gives the daily limit a numeric wait and the limit of a workspace none (#268)", () => {
  const typeOnly = (
    refused: Extract<CreateProjectResult, { created: false }>,
  ): number => {
    if (refused.refusal === "rate_limited") {
      // A wait of null would no longer be a number.
      const wait: number = refused.retryAfterMs;
      return wait;
    }
    // @ts-expect-error -- only rate_limited has a wait
    return refused.retryAfterMs;
  };
  assert.equal(typeof typeOnly, "function");
});

test("the creator, the owner, and an admin rename a project; another member is forbidden, and an unknown project or one of another workspace is not found", async () => {
  const owner = await account("Owner");
  const admin = await account("Admin");
  const creator = await account("Creator");
  const member = await account("Member");
  const workspaceId = await workspaceOf(owner);
  const other = await workspaceOf(owner);
  await join(workspaceId, admin, "admin");
  await join(workspaceId, creator);
  await join(workspaceId, member);
  const project = await created(workspaceId, creator, "App");
  const foreign = await created(other, owner, "Foreign");

  const rename = (by: Account, name: string, projectId = project) =>
    renameProject(database(), {
      workspaceId,
      projectId,
      userId: by.userId,
      name,
      now: LATER,
    });
  assert.deepEqual(await rename(member, "Mine"), {
    renamed: false,
    refusal: "forbidden",
  });
  for (const [by, name] of [
    [creator, "App 2"],
    [owner, "App 3"],
    [admin, "App 4"],
  ] as const) {
    assert.deepEqual(await rename(by, name), { renamed: true, changed: true });
    assert.equal((await projectRow(project)).name, name);
  }
  const row = await projectRow(project);
  assert.deepEqual(row.updatedAt, LATER);
  assert.deepEqual(row.createdAt, NOW);
  assert.equal(row.createdByUserId, creator.userId);

  for (const projectId of [newId<ProjectId>(), foreign]) {
    assert.deepEqual(await rename(owner, "Taken", projectId), {
      renamed: false,
      refusal: "not_found",
    });
  }
  assert.equal((await projectRow(foreign)).name, "Foreign");
  // An unknown project is not found before any right is checked.
  assert.deepEqual(await rename(member, "Taken", newId<ProjectId>()), {
    renamed: false,
    refusal: "not_found",
  });

  // Renaming writes no audit record either.
  const audited = await database()
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId));
  assert.deepEqual(
    audited.map((record) => record.action),
    ["workspace.created"],
  );
});

test("the creator still renames the project after leaving the workspace and joining again as a new person, which the project then names as its creator", async () => {
  const owner = await account("Owner");
  const creator = await account("Creator");
  const workspaceId = await workspaceOf(owner);
  const person = await join(workspaceId, creator);
  const project = await created(workspaceId, creator, "App");
  await database()
    .update(workspaceMembers)
    .set({ removedAt: NOW, removedByUserId: creator.userId })
    .where(eq(workspaceMembers.id, person));
  // The project names the account's removed person while it has no other.
  assert.deepEqual(
    (await listProjects(database(), workspaceId)).map(
      (item) => item.createdByMemberId,
    ),
    [person],
  );
  const rejoined = await join(workspaceId, creator);
  // Then the account's active person, which holds the account's rights.
  assert.deepEqual(
    (await listProjects(database(), workspaceId)).map(
      (item) => item.createdByMemberId,
    ),
    [rejoined],
  );
  assert.deepEqual(
    await renameProject(database(), {
      workspaceId,
      projectId: project,
      userId: creator.userId,
      name: "Renamed",
      now: LATER,
    }),
    { renamed: true, changed: true },
  );
});

test("the name in force changes nothing, a change of case alone renames, a clash and an archived project are conflicts", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const app = await created(workspaceId, owner, "App");
  const web = await created(workspaceId, owner, "Web");
  const old = await created(workspaceId, owner, "Old");
  await archive(old);
  const rename = (projectId: ProjectId, name: string) =>
    renameProject(database(), {
      workspaceId,
      projectId,
      userId: owner.userId,
      name,
      now: LATER,
    });

  assert.deepEqual(await rename(app, "App"), { renamed: true, changed: false });
  assert.deepEqual((await projectRow(app)).updatedAt, NOW);
  assert.deepEqual(await rename(app, "APP"), { renamed: true, changed: true });
  assert.equal((await projectRow(app)).name, "APP");
  assert.deepEqual(await rename(web, "app"), {
    renamed: false,
    refusal: "conflict",
  });
  assert.equal((await projectRow(web)).name, "Web");
  assert.deepEqual((await projectRow(web)).updatedAt, NOW);
  // An archived project is not renamed, and its name is free.
  assert.deepEqual(await rename(old, "Older"), {
    renamed: false,
    refusal: "conflict",
  });
  assert.deepEqual(await rename(web, "old"), { renamed: true, changed: true });
  assert.deepEqual(await activeNames(workspaceId), ["APP", "old"]);
});

test("the database keeps one project conversation per project, the name keys, and names in NFC, with an index for the count of an account's creations", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const project = await created(workspaceId, owner, "App");
  await rejectsWith(
    () =>
      database().insert(conversations).values({
        id: newUuidV7(),
        projectId: project,
        kind: "project",
        createdByUserId: owner.userId,
      }),
    "23505",
    "conversations_project_kind_key",
  );
  // Whatever the writer: a direct insert with another case fails too.
  await rejectsWith(
    () =>
      database().insert(projects).values({
        id: newId<ProjectId>(),
        workspaceId,
        name: "aPP",
        createdByUserId: owner.userId,
      }),
    "23505",
    "projects_active_name_key",
  );
  // A name that is not in NFC fails the CHECK, whatever the writer.
  await rejectsWith(
    () =>
      database().insert(projects).values({
        id: newId<ProjectId>(),
        workspaceId,
        name: "Cafe\u0301",
        createdByUserId: owner.userId,
      }),
    "23514",
    "projects_name_nfc_check",
  );
  await created(workspaceId, owner, "Caf\u00E9");

  assert.ok(testDatabase);
  const result = await testDatabase.client.query<{
    name: string;
    definition: string;
  }>(
    `select indexname as name, indexdef as definition from pg_indexes
     where schemaname = 'public' and indexname in (
       'conversations_project_kind_key',
       'projects_active_name_key',
       'projects_created_by_user_id_created_at_idx'
     ) order by indexname`,
  );
  assert.deepEqual(
    result.rows.map((row) => [row.name, row.definition.split(" USING ")[1]]),
    [
      [
        "conversations_project_kind_key",
        "btree (project_id) WHERE (kind = 'project'::text)",
      ],
      [
        "projects_active_name_key",
        "btree (workspace_id, lower((name COLLATE pg_c_utf8))) WHERE (archived_at IS NULL)",
      ],
      [
        "projects_created_by_user_id_created_at_idx",
        "btree (created_by_user_id, created_at)",
      ],
    ],
  );
});

test("migration 0009 archives the projects of a workspace that an earlier erasure archived, before it adds the unique index of names", async () => {
  // A database migrated to 0008, with the rows that an erasure left before
  // #155: an archived workspace whose projects all have the placeholder name
  // and no `archived_at`.
  const client = await PGlite.create();
  try {
    const journal = JSON.parse(
      readFileSync(joinPath(migrationsFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const tags = journal.entries.map((entry) => entry.tag);
    const next = tags.indexOf("0009_project_keys");
    assert.ok(next > 0);
    const apply = async (tag: string) => {
      const text = readFileSync(
        joinPath(migrationsFolder, `${tag}.sql`),
        "utf8",
      );
      for (const statement of text.split("--> statement-breakpoint")) {
        if (statement.trim() !== "") {
          await client.exec(statement);
        }
      }
    };
    for (const tag of tags.slice(0, next)) {
      await apply(tag);
    }

    const userId = newId<UserId>();
    const archived = newId<WorkspaceId>();
    const active = newId<WorkspaceId>();
    const earlier = "2026-10-01T00:00:00.000Z";
    const archivedAt = "2026-11-01T00:00:00.000Z";
    await client.query(
      "insert into users (id, display_name) values ($1, 'Former user')",
      [userId],
    );
    await client.query(
      `insert into workspaces (id, name, created_by_user_id, archived_at)
       values ($1, 'Archived workspace', $3, $4), ($2, 'Team', $3, null)`,
      [archived, active, userId, archivedAt],
    );
    const placeholders = [newId<ProjectId>(), newId<ProjectId>()];
    const archivedBefore = newId<ProjectId>();
    const kept = newId<ProjectId>();
    await client.query(
      `insert into projects (id, workspace_id, name, created_by_user_id, archived_at)
       values ($1, $5, 'Archived project', $7, null),
              ($2, $5, 'Archived project', $7, null),
              ($3, $5, 'Archived project', $7, $8),
              ($4, $6, 'App', $7, null)`,
      [
        ...placeholders,
        archivedBefore,
        kept,
        archived,
        active,
        userId,
        earlier,
      ],
    );

    for (const tag of tags.slice(next)) {
      await apply(tag);
    }
    const { rows } = await client.query<{
      id: string;
      archivedAt: Date | null;
    }>('select id, archived_at as "archivedAt" from projects');
    const archivedAtOf = new Map(
      rows.map((row) => [row.id, row.archivedAt?.toISOString() ?? null]),
    );
    assert.deepEqual(
      Object.fromEntries(archivedAtOf),
      Object.fromEntries([
        [placeholders[0], archivedAt],
        [placeholders[1], archivedAt],
        [archivedBefore, earlier],
        [kept, null],
      ]),
    );
  } finally {
    await client.close();
  }
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

/**
 * What the sessions of the test database that wait for a lock wait for: the
 * table of the row, through the tuple lock that a session holds or waits for
 * while it waits for the transaction that holds the row, or else the kind of
 * lock, such as `transactionid` for an entry of a unique index.
 */
async function lockWaits(): Promise<string[]> {
  assert.ok(testDatabase);
  const { rows } = await testDatabase.client.query<{ waitedOn: string }>(
    `select distinct coalesce(c.relname, w.locktype) as "waitedOn"
       from pg_locks w
       left join pg_locks t on t.pid = w.pid and t.locktype = 'tuple'
       left join pg_class c on c.oid = t.relation
      where not w.granted
        and (select oid from pg_database where datname = current_database())
            in (w.database, t.database)`,
  );
  return rows.map((row) => row.waitedOn).sort();
}

/**
 * Runs `first` in a transaction of a second session and keeps it open while
 * `action` starts in this session. Returns the action's result after the
 * held transaction committed, and what the action waited for (`lockWaits`),
 * empty when it did not wait.
 */
async function whileHeld<T>(
  first: (tx: Database) => Promise<unknown>,
  action: () => Promise<T>,
): Promise<Readonly<{ result: T; waitedOn: readonly string[] }>> {
  const url = testDatabase?.url;
  assert.ok(url, "the test database is on a server");
  const other = createDatabase(url, { max: 1 });
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held = other.db.transaction(async (tx) => {
    await first(tx);
    holding.resolve();
    await release.promise;
  });
  try {
    await Promise.race([
      holding.promise,
      held.then(() => {
        throw new Error("the held transaction ended early");
      }),
    ]);
    const running = action();
    let settled = false;
    running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let waited = false;
    while (!settled && !waited) {
      waited = await waitsForLock();
      if (!waited) {
        await delay(10);
      }
    }
    // The action waits until the held transaction is released.
    const waitedOn = waited ? await lockWaits() : [];
    release.resolve();
    await held;
    return { result: await running, waitedOn };
  } finally {
    release.resolve();
    await held.catch(() => undefined);
    await other.close();
  }
}

/** Creates a project in `tx`, which must be created. */
async function createdIn(
  tx: Database,
  workspaceId: WorkspaceId,
  by: Account,
  name: string,
  now: Date = NOW,
): Promise<void> {
  const result = await createProject(tx, {
    workspaceId,
    userId: by.userId,
    name,
    now,
  });
  assert.ok(result.created, JSON.stringify(result));
}

test(
  "a creation waits at the workspace row for a concurrent creation of the same name, in another case, by another person, and is then a conflict",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const member = await account("Member");
    const workspaceId = await workspaceOf(owner);
    await join(workspaceId, member);
    const { result, waitedOn } = await whileHeld(
      (tx) => createdIn(tx, workspaceId, member, "Launch"),
      () =>
        createProject(database(), {
          workspaceId,
          userId: owner.userId,
          name: "launch",
          now: NOW,
        }),
    );
    assert.deepEqual(result, { created: false, refusal: "conflict" });
    assert.deepEqual(waitedOn, ["workspaces"]);
    assert.deepEqual(await countsOf(workspaceId), {
      projects: 1,
      conversations: 1,
    });
  },
);

test(
  `a creation waits at the workspace row for a concurrent creation by another person that reaches the limit of ${MAX_ACTIVE_PROJECTS_PER_WORKSPACE}, and is then project_limit`,
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const member = await account("Member");
    const workspaceId = await workspaceOf(owner);
    await join(workspaceId, member);
    await fill(workspaceId, owner, MAX_ACTIVE_PROJECTS_PER_WORKSPACE - 1);
    // Each creation locks another account and person, so only the workspace
    // row orders them.
    const { result, waitedOn } = await whileHeld(
      (tx) => createdIn(tx, workspaceId, owner, "Last"),
      () =>
        createProject(database(), {
          workspaceId,
          userId: member.userId,
          name: "One more",
          now: NOW,
        }),
    );
    assert.deepEqual(result, { created: false, refusal: "project_limit" });
    assert.deepEqual(waitedOn, ["workspaces"]);
    assert.equal(
      (await listProjects(database(), workspaceId)).length,
      MAX_ACTIVE_PROJECTS_PER_WORKSPACE,
    );
  },
);

test(
  `a creation waits at the account's row for a concurrent creation of the same account in another workspace that reaches its limit of ${MAX_NEW_PROJECTS_PER_DAY} a day, and is then rate_limited`,
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const first = await workspaceOf(owner);
    const second = await workspaceOf(owner);
    for (let index = 0; index < MAX_NEW_PROJECTS_PER_DAY - 1; index += 1) {
      await created(first, owner, `Project ${index}`, NOW);
    }
    // The workspace rows differ, so only the account's row orders them.
    const { result, waitedOn } = await whileHeld(
      (tx) => createdIn(tx, first, owner, "Last", LATER),
      () =>
        createProject(database(), {
          workspaceId: second,
          userId: owner.userId,
          name: "One more",
          now: LATER,
        }),
    );
    assert.deepEqual(result, {
      created: false,
      refusal: "rate_limited",
      retryAfterMs: DAY_MS - (LATER.getTime() - NOW.getTime()),
    });
    assert.deepEqual(waitedOn, ["users"]);
    assert.deepEqual(await listProjects(database(), second), []);
  },
);

test(
  "a rename waits at the workspace row for a concurrent creation of the same name and is then a conflict",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const member = await account("Member");
    const workspaceId = await workspaceOf(owner);
    await join(workspaceId, member);
    const project = await created(workspaceId, owner, "App");
    const { result, waitedOn } = await whileHeld(
      (tx) => createdIn(tx, workspaceId, member, "Web"),
      () =>
        renameProject(database(), {
          workspaceId,
          projectId: project,
          userId: owner.userId,
          name: "WEB",
          now: LATER,
        }),
    );
    assert.deepEqual(result, { renamed: false, refusal: "conflict" });
    assert.deepEqual(waitedOn, ["workspaces"]);
    assert.deepEqual(await activeNames(workspaceId), ["App", "Web"]);
  },
);

test(
  "a rename waits at the workspace row for a concurrent rename in the workspace and then sees its new name",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const admin = await account("Admin");
    const workspaceId = await workspaceOf(owner);
    await join(workspaceId, admin, "admin");
    const alpha = await created(workspaceId, owner, "Alpha");
    const beta = await created(workspaceId, owner, "Beta");
    // Without the workspace row the second rename would wait only for the
    // first one's entry of "beta" in the unique index of names; two renames
    // that swap two names then each wait for the other, a deadlock.
    const { result, waitedOn } = await whileHeld(
      (tx) =>
        renameProject(tx, {
          workspaceId,
          projectId: beta,
          userId: admin.userId,
          name: "Gamma",
          now: NOW,
        }),
      () =>
        renameProject(database(), {
          workspaceId,
          projectId: alpha,
          userId: owner.userId,
          name: "beta",
          now: LATER,
        }),
    );
    assert.deepEqual(result, { renamed: true, changed: true });
    assert.deepEqual(waitedOn, ["workspaces"]);
    assert.deepEqual(await activeNames(workspaceId), ["Gamma", "beta"]);
  },
);

test(
  "two concurrent renames that swap two names never deadlock: each is a conflict, and the names stay",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const admin = await account("Admin");
    const workspaceId = await workspaceOf(owner);
    await join(workspaceId, admin, "admin");
    const alpha = await created(workspaceId, owner, "Alpha");
    const beta = await created(workspaceId, owner, "Beta");
    // A swap of names by renames can never succeed, because each name is
    // taken while the other project holds it; it must not fail with an error.
    for (let round = 0; round < 20; round += 1) {
      const results = await Promise.all(
        (
          [
            [owner, alpha, "Beta"],
            [admin, beta, "Alpha"],
          ] as const
        ).map(([by, projectId, name]) =>
          renameProject(database(), {
            workspaceId,
            projectId,
            userId: by.userId,
            name,
            now: LATER,
          }),
        ),
      );
      assert.deepEqual(results, [
        { renamed: false, refusal: "conflict" },
        { renamed: false, refusal: "conflict" },
      ]);
    }
    assert.deepEqual(await activeNames(workspaceId), ["Alpha", "Beta"]);
  },
);

test(
  "a creation waits for a concurrent removal of the creating person and is then refused as no member",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const member = await account("Member");
    const workspaceId = await workspaceOf(owner);
    const person = await join(workspaceId, member);
    const { result, waitedOn } = await whileHeld(
      (tx) =>
        removeMember(tx, {
          workspaceId,
          ...owner,
          memberId: person,
          now: NOW,
        }),
      () =>
        createProject(database(), {
          workspaceId,
          userId: member.userId,
          name: "App",
          now: LATER,
        }),
    );
    assert.deepEqual(result, { created: false, refusal: "not_member" });
    assert.deepEqual(waitedOn, ["workspace_members"]);
    assert.deepEqual(await countsOf(workspaceId), {
      projects: 0,
      conversations: 0,
    });
  },
);

test(
  "a creation by the owner waits for a concurrent erasure of the owner's account that archives the workspace, and is then refused as no member",
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
    const { result, waitedOn } = await whileHeld(
      async (tx) => {
        const erasure = await eraseAccount(tx, {
          userId: owner.userId,
          now: NOW,
        });
        assert.ok(erasure.erased, JSON.stringify(erasure));
      },
      () =>
        createProject(database(), {
          workspaceId,
          userId: owner.userId,
          name: "App",
          now: LATER,
        }),
    );
    assert.deepEqual(result, { created: false, refusal: "not_member" });
    assert.deepEqual(waitedOn, ["users"]);
    assert.deepEqual(await countsOf(workspaceId), {
      projects: 0,
      conversations: 0,
    });
  },
);
