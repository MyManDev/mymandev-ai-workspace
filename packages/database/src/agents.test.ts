import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  AGENT_COUNT_LIMITS,
  type AgentId,
  AgentListItemSchema,
  CreateAgentResponseSchema,
  type DeviceId,
  type EventId,
  type MemberId,
  type MemberRole,
  newId,
  type PermissionGrantId,
  type ProjectId,
  type ProviderConnectionId,
  type RepositoryId,
  type RunId,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import { listProjectAgents } from "./agent-activity.ts";
import {
  createAgent,
  type CreateAgentInput,
  type CreateAgentResult,
  disableAgent,
  type DisableAgentInput,
  type DisableAgentResult,
} from "./agents.ts";
import { disabledAgentsOf } from "./cascade.ts";
import { postChatMessage } from "./chat.ts";
import type { Database } from "./db.ts";
import { revokeDevice } from "./device-revocation.ts";
import { DatabaseError, withDatabaseErrors } from "./errors.ts";
import { grantCapability } from "./grants.ts";
import { activePersonOf, createWorkspace } from "./membership.ts";
import { removeMember } from "./people.ts";
import { createProject } from "./projects.ts";
import { SERVER_ONLY, whileHeld } from "./race-testing.ts";
import { createRun } from "./runs.ts";
import {
  agentRuns,
  agents,
  auditEvents,
  devices,
  permissionGrants,
  projects,
  providerConnections,
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

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-11-23T12:00:00.000Z");
const LATER = new Date("2026-11-23T13:00:00.000Z");
const EARLIER = new Date("2026-11-23T11:00:00.000Z");
const {
  enabledPerProject: ENABLED_PER_PROJECT,
  perProject: PER_PROJECT,
  perDay: PER_DAY,
} = AGENT_COUNT_LIMITS;

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

/** A workspace of a new owner with one project. */
async function setUp() {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectIn(workspaceId, owner);
  return { owner, workspaceId, projectId };
}

function input(
  projectId: ProjectId,
  by: Account,
  name = "Reviewer",
  now: Date = NOW,
): CreateAgentInput {
  return { projectId, userId: by.userId, deviceId: by.deviceId, name, now };
}

function create(
  projectId: ProjectId,
  by: Account,
  name = "Reviewer",
  now: Date = NOW,
): Promise<CreateAgentResult> {
  return createAgent(database(), input(projectId, by, name, now));
}

/** Creates an agent that must be created, and returns its ID. */
async function created(
  projectId: ProjectId,
  by: Account,
  name = "Reviewer",
  now: Date = NOW,
): Promise<AgentId> {
  const result = await create(projectId, by, name, now);
  assert.ok(result.created, JSON.stringify(result));
  return result.agent.id;
}

function disable(
  projectId: ProjectId,
  agentId: AgentId,
  by: Account,
  now: Date = LATER,
): Promise<DisableAgentResult> {
  const request: DisableAgentInput = {
    projectId,
    agentId,
    userId: by.userId,
    now,
  };
  return disableAgent(database(), request);
}

async function agentRow(id: AgentId) {
  const [row] = await database().select().from(agents).where(eq(agents.id, id));
  assert.ok(row !== undefined);
  return row;
}

/** How many agents the project has, disabled ones included. */
async function agentCount(projectId: ProjectId): Promise<number> {
  const rows = await database()
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.projectId, projectId));
  return rows.length;
}

/** Inserts `n` agents of the account directly, created at `createdAt`. */
async function fill(
  projectId: ProjectId,
  by: Account,
  n: number,
  options: Readonly<{ createdAt?: Date; disabledAt?: Date | null }> = {},
): Promise<AgentId[]> {
  const createdAt = options.createdAt ?? new Date(NOW.getTime() - 2 * DAY_MS);
  const rows = Array.from({ length: n }, (_, index) => ({
    id: newId<AgentId>(),
    projectId,
    ownerUserId: by.userId,
    hostDeviceId: by.deviceId,
    name: `Filler ${index}`,
    createdAt,
    disabledAt: options.disabledAt ?? null,
  }));
  await database().insert(agents).values(rows);
  return rows.map((row) => row.id);
}

async function repositoryOf(
  projectId: ProjectId,
  by: Account,
): Promise<RepositoryId> {
  const id = newId<RepositoryId>();
  await database()
    .insert(repositories)
    .values({ id, projectId, name: "web", createdByUserId: by.userId });
  return id;
}

/** A grant of `repo.read` on the repository to the agent, by its owner on its host device. */
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

async function grantRow(id: PermissionGrantId) {
  const [row] = await database()
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, id));
  assert.ok(row !== undefined);
  return row;
}

/** A run of the agent in `state` that `by` asked for. */
async function runOf(
  projectId: ProjectId,
  agentId: AgentId,
  by: Account,
  state: RunState,
): Promise<RunId> {
  const id = newId<RunId>();
  const finished =
    state === "completed" || state === "failed" || state === "cancelled";
  await database()
    .insert(agentRuns)
    .values({
      id,
      agentId,
      projectId,
      requestedByUserId: by.userId,
      state,
      createdAt: EARLIER,
      ...(finished ? { finishedAt: EARLIER, stateReason: "Done" } : {}),
    });
  return id;
}

async function runRow(id: RunId) {
  const [row] = await database()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function auditedActions(workspaceId: WorkspaceId): Promise<string[]> {
  const rows = await database()
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId));
  return rows.map((row) => row.action).sort();
}

async function listed(projectId: ProjectId, who: Account) {
  const result = await listProjectAgents(database(), {
    actorUserId: who.userId,
    projectId,
  });
  assert.ok(result.listed, JSON.stringify(result));
  return result.agents;
}

// Creation.

test("any active member creates an agent, hosted on the calling device and owned by the caller, and nothing is audited", async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const member = await account("Member");
  const memberPerson = await join(workspaceId, member);
  const secondDevice = await addDevice(member.userId);

  const byOwner = await create(projectId, owner, "Reviewer");
  assert.ok(byOwner.created);
  assert.deepEqual(byOwner, {
    created: true,
    workspaceId,
    agent: {
      id: byOwner.agent.id,
      projectId,
      name: "Reviewer",
      ownerMemberId: await personOf(workspaceId, owner),
      disabledAt: null,
    },
  });
  assert.ok(
    CreateAgentResponseSchema.safeParse({ agent: byOwner.agent }).success,
  );

  // A member, from a second device, which becomes the host device.
  const byMember = await createAgent(database(), {
    ...input(projectId, member, "Builder", LATER),
    deviceId: secondDevice,
  });
  assert.ok(byMember.created);
  assert.equal(byMember.agent.ownerMemberId, memberPerson);

  assert.deepEqual(await agentRow(byOwner.agent.id), {
    id: byOwner.agent.id,
    projectId,
    ownerUserId: owner.userId,
    hostDeviceId: owner.deviceId,
    name: "Reviewer",
    createdAt: NOW,
    updatedAt: NOW,
    disabledAt: null,
  });
  const memberRow = await agentRow(byMember.agent.id);
  assert.equal(memberRow.ownerUserId, member.userId);
  assert.equal(memberRow.hostDeviceId, secondDevice);
  assert.deepEqual(memberRow.createdAt, LATER);

  // The answer is the agent as the list shows it to every member; the list
  // adds the host device of the reader's own agents only (#342).
  assert.deepEqual(await listed(projectId, member), [
    byOwner.agent,
    { ...byMember.agent, hostDeviceId: secondDevice },
  ]);
  for (const agent of await listed(projectId, owner)) {
    assert.ok(AgentListItemSchema.safeParse(agent).success);
  }
  // Creating an agent is not an administrative action of ADR 0014.
  assert.deepEqual(await auditedActions(workspaceId), ["workspace.created"]);
});

test("a name is a label: two agents of a project may share it, and it is stored as given", async () => {
  const { owner, projectId } = await setUp();
  const first = await created(projectId, owner, "Reviewer");
  const second = await created(projectId, owner, "Reviewer");
  const spaced = await created(projectId, owner, "  reviewer  ");
  assert.notEqual(first, second);
  assert.equal((await agentRow(second)).name, "Reviewer");
  assert.equal((await agentRow(spaced)).name, "  reviewer  ");
  // The CHECK of the table still holds the length.
  await assert.rejects(
    withDatabaseErrors(() => create(projectId, owner, "a".repeat(65))),
    DatabaseError,
  );
});

test("a project that does not exist, an account that is not a member, and a removed member are not_member, and nothing is written", async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const stranger = await account("Stranger");
  const removed = await account("Removed");
  const removedPerson = await join(workspaceId, removed);
  assert.ok(
    (
      await removeMember(database(), {
        workspaceId,
        ...owner,
        memberId: removedPerson,
        now: NOW,
      })
    ).removed,
  );
  const other = await setUp();

  for (const [label, result] of [
    ["unknown project", await create(newId<ProjectId>(), owner)],
    ["stranger", await create(projectId, stranger)],
    ["removed member", await create(projectId, removed)],
    ["another workspace's project", await create(other.projectId, owner)],
  ] as const) {
    assert.deepEqual(result, { created: false, refusal: "not_member" }, label);
  }
  assert.equal(await agentCount(projectId), 0);
  assert.equal(await agentCount(other.projectId), 0);
});

test("a disabled account, a revoked device, and another account's device are forbidden, before the membership, and nothing is written", async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const member = await account("Member");
  await join(workspaceId, member);
  const stranger = await account("Stranger");

  // Another account's device never becomes the host of the caller's agent.
  assert.deepEqual(
    await createAgent(database(), {
      ...input(projectId, member),
      deviceId: owner.deviceId,
    }),
    { created: false, refusal: "forbidden" },
  );
  assert.deepEqual(
    await createAgent(database(), {
      ...input(projectId, member),
      deviceId: newId<DeviceId>(),
    }),
    { created: false, refusal: "forbidden" },
  );
  // A stranger with another's device is forbidden before not_member.
  assert.deepEqual(
    await createAgent(database(), {
      ...input(projectId, stranger),
      deviceId: owner.deviceId,
    }),
    { created: false, refusal: "forbidden" },
  );

  const revoked = await addDevice(member.userId);
  await database()
    .update(devices)
    .set({ revokedAt: EARLIER, revocationReason: "removed" })
    .where(eq(devices.id, revoked));
  assert.deepEqual(
    await createAgent(database(), {
      ...input(projectId, member),
      deviceId: revoked,
    }),
    { created: false, refusal: "forbidden" },
  );

  await database()
    .update(users)
    .set({ disabledAt: EARLIER })
    .where(eq(users.id, member.userId));
  assert.deepEqual(await create(projectId, member), {
    created: false,
    refusal: "forbidden",
  });
  assert.equal(await agentCount(projectId), 0);
});

test("an archived project and an archived workspace take no new agent, each a conflict after the membership", async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const stranger = await account("Stranger");
  await database()
    .update(projects)
    .set({ archivedAt: EARLIER })
    .where(eq(projects.id, projectId));
  assert.deepEqual(await create(projectId, owner), {
    created: false,
    refusal: "conflict",
  });
  assert.deepEqual(await create(projectId, stranger), {
    created: false,
    refusal: "not_member",
  });

  const other = await setUp();
  await database()
    .update(workspaces)
    .set({ archivedAt: EARLIER })
    .where(eq(workspaces.id, other.workspaceId));
  assert.deepEqual(await create(other.projectId, other.owner), {
    created: false,
    refusal: "conflict",
  });
  assert.equal(await agentCount(projectId), 0);
  assert.equal(await agentCount(other.projectId), 0);
  // An archive leaves the listed agents of a project as they are.
  assert.deepEqual(await auditedActions(workspaceId), ["workspace.created"]);
});

test(`a project holds at most ${ENABLED_PER_PROJECT} enabled agents; the next is refused with agent_limit, a disabled agent frees a place, and another project has its own`, async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const member = await account("Member");
  await join(workspaceId, member);
  const filled = await fill(projectId, owner, ENABLED_PER_PROJECT - 1);
  const last = await created(projectId, member, "Last");
  assert.equal(await agentCount(projectId), ENABLED_PER_PROJECT);

  // Every member, whoever owns the agents.
  for (const who of [owner, member]) {
    assert.deepEqual(await create(projectId, who), {
      created: false,
      refusal: "agent_limit",
    });
  }
  assert.equal(await agentCount(projectId), ENABLED_PER_PROJECT);

  // Another project of the workspace has its own places.
  const otherProject = await projectIn(workspaceId, owner, "Website");
  await created(otherProject, owner);

  // Disabling an agent frees a place, and a disabled agent counts only
  // toward the lifetime limit.
  const [first] = filled;
  assert.ok(first !== undefined);
  assert.ok((await disable(projectId, first, owner)).disabled);
  await created(projectId, owner, "After a disable");
  assert.deepEqual(await create(projectId, owner), {
    created: false,
    refusal: "agent_limit",
  });
  assert.ok((await disable(projectId, last, member)).disabled);
  await created(projectId, member, "After another disable");
});

test(`a project has at most ${PER_PROJECT} agents over its lifetime, disabled ones included; nothing frees a place`, async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const member = await account("Member");
  await join(workspaceId, member);
  await fill(projectId, owner, PER_PROJECT - 1, { disabledAt: EARLIER });
  // One enabled agent: far below the limit of enabled agents.
  const enabled = await created(projectId, member);
  assert.equal(await agentCount(projectId), PER_PROJECT);
  assert.deepEqual(await create(projectId, owner), {
    created: false,
    refusal: "agent_limit",
  });
  // Disabling frees no place of this limit.
  assert.ok((await disable(projectId, enabled, member)).disabled);
  assert.deepEqual(await create(projectId, member), {
    created: false,
    refusal: "agent_limit",
  });
  assert.equal(await agentCount(projectId), PER_PROJECT);
  // The list holds every agent, within MAX_ANSWER_LIST_ITEMS.
  assert.equal((await listed(projectId, owner)).length, PER_PROJECT);
  // Another project has its own.
  await created(await projectIn(workspaceId, owner, "Website"), owner);
});

test(`an account creates at most ${PER_DAY} agents within 24 hours, in all its projects together, disabled ones included, and the window slides`, async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const member = await account("Member");
  await join(workspaceId, member);
  const otherProject = await projectIn(workspaceId, owner, "Website");

  // The oldest created 23 hours before NOW, disabled; the rest across two
  // projects, an hour apart from it.
  const oldestAt = new Date(NOW.getTime() - 23 * HOUR_MS);
  await fill(otherProject, owner, 1, {
    createdAt: oldestAt,
    disabledAt: EARLIER,
  });
  await fill(otherProject, owner, 9, {
    createdAt: new Date(NOW.getTime() - 2 * HOUR_MS),
    disabledAt: EARLIER,
  });
  for (let n = 10; n < PER_DAY; n += 1) {
    if (n % 2 === 0) {
      await created(projectId, owner, `Agent ${n}`);
    } else {
      assert.ok(
        (
          await disable(
            projectId,
            await created(projectId, owner, `Agent ${n}`),
            owner,
            NOW,
          )
        ).disabled,
      );
    }
  }

  const refused = await create(projectId, owner);
  assert.deepEqual(refused, {
    created: false,
    refusal: "rate_limited",
    retryAfterMs: oldestAt.getTime() + DAY_MS - NOW.getTime(),
  });
  assert.equal(
    refused.created === false && "retryAfterMs" in refused
      ? refused.retryAfterMs
      : 0,
    HOUR_MS,
  );
  // Another account has its own limit, in the same project.
  await created(projectId, member);
  // An agent created exactly 24 hours before no longer counts.
  assert.ok(
    (
      await create(
        projectId,
        owner,
        "Next",
        new Date(oldestAt.getTime() + DAY_MS),
      )
    ).created,
  );
});

test("a creation at a project's limit and the account's limit is refused with agent_limit", async () => {
  const { owner, projectId } = await setUp();
  await fill(projectId, owner, ENABLED_PER_PROJECT, { createdAt: EARLIER });
  assert.deepEqual(await create(projectId, owner), {
    created: false,
    refusal: "agent_limit",
  });
});

test("the type checker gives the daily limit a numeric wait and the limits of a project none", () => {
  const waits = (result: CreateAgentResult): number | undefined =>
    !result.created && result.refusal === "rate_limited"
      ? result.retryAfterMs
      : undefined;
  assert.equal(
    waits({ created: false, refusal: "rate_limited", retryAfterMs: 5 }),
    5,
  );
  assert.equal(waits({ created: false, refusal: "agent_limit" }), undefined);
});

// Disabling.

test("the agent's owner, the workspace's owner, and an admin disable an agent; another member is forbidden", async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const alice = await account("Alice");
  const bob = await account("Bob");
  const admin = await account("Admin");
  await join(workspaceId, alice);
  await join(workspaceId, bob);
  await join(workspaceId, admin, "admin");
  const ofAlice = await created(projectId, alice, "A1");
  const second = await created(projectId, alice, "A2");
  const third = await created(projectId, alice, "A3");

  // Another member, also the owner of another agent of the project.
  await created(projectId, bob, "B1");
  assert.deepEqual(await disable(projectId, ofAlice, bob), {
    disabled: false,
    refusal: "forbidden",
  });
  assert.equal((await agentRow(ofAlice)).disabledAt, null);

  // The agent's owner.
  const byOwner = await disable(projectId, ofAlice, alice);
  assert.ok(byOwner.disabled);
  assert.deepEqual(byOwner.agent, {
    id: ofAlice,
    projectId,
    name: "A1",
    ownerMemberId: await personOf(workspaceId, alice),
    disabledAt: LATER.toISOString(),
  });
  assert.equal(byOwner.workspaceId, workspaceId);
  const row = await agentRow(ofAlice);
  assert.deepEqual(row.disabledAt, LATER);
  assert.deepEqual(row.updatedAt, LATER);
  // The workspace's owner and an admin.
  assert.ok((await disable(projectId, second, owner)).disabled);
  assert.ok((await disable(projectId, third, admin)).disabled);
  // The list shows each as disabled, as the result did.
  const list = await listed(projectId, bob);
  assert.deepEqual(
    list.find((agent) => agent.id === ofAlice),
    byOwner.agent,
  );
  // Disabling writes no audit record.
  assert.deepEqual(await auditedActions(workspaceId), ["workspace.created"]);
});

test("the owner disables an agent whatever device it is hosted on: the disable takes no device", async () => {
  const { owner, projectId } = await setUp();
  const secondDevice = await addDevice(owner.userId);
  const result = await createAgent(database(), {
    ...input(projectId, owner),
    deviceId: secondDevice,
  });
  assert.ok(result.created);
  assert.ok((await disable(projectId, result.agent.id, owner)).disabled);
  assert.equal((await agentRow(result.agent.id)).hostDeviceId, secondDevice);
});

test("a non-member is not_member, and an unknown agent or an agent of another project is not_found, before forbidden", async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const member = await account("Member");
  const stranger = await account("Stranger");
  await join(workspaceId, member);
  const agentId = await created(projectId, owner);
  const otherProject = await projectIn(workspaceId, owner, "Website");
  const elsewhere = await created(otherProject, owner);
  const other = await setUp();
  const foreign = await created(other.projectId, other.owner);

  assert.deepEqual(await disable(projectId, agentId, stranger), {
    disabled: false,
    refusal: "not_member",
  });
  assert.deepEqual(await disable(newId<ProjectId>(), agentId, owner), {
    disabled: false,
    refusal: "not_member",
  });
  for (const [label, id] of [
    ["unknown", newId<AgentId>()],
    ["of another project", elsewhere],
    ["of another workspace", foreign],
  ] as const) {
    // Also for a member who could not disable it.
    for (const who of [owner, member]) {
      assert.deepEqual(
        await disable(projectId, id, who),
        { disabled: false, refusal: "not_found" },
        label,
      );
    }
  }
  for (const id of [agentId, elsewhere, foreign]) {
    assert.equal((await agentRow(id)).disabledAt, null);
  }
});

test("disabling is final: a disabled agent is a conflict, so are an archived project and workspace, and forbidden comes first", async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const member = await account("Member");
  await join(workspaceId, member);
  const agentId = await created(projectId, owner);
  assert.ok((await disable(projectId, agentId, owner, LATER)).disabled);
  assert.deepEqual(await disable(projectId, agentId, owner, NOW), {
    disabled: false,
    refusal: "conflict",
  });
  assert.deepEqual(await disable(projectId, agentId, member), {
    disabled: false,
    refusal: "forbidden",
  });
  assert.deepEqual((await agentRow(agentId)).disabledAt, LATER);

  const enabled = await created(projectId, owner);
  await database()
    .update(projects)
    .set({ archivedAt: EARLIER })
    .where(eq(projects.id, projectId));
  assert.deepEqual(await disable(projectId, enabled, owner), {
    disabled: false,
    refusal: "conflict",
  });
  const other = await setUp();
  const inArchived = await created(other.projectId, other.owner);
  await database()
    .update(workspaces)
    .set({ archivedAt: EARLIER })
    .where(eq(workspaces.id, other.workspaceId));
  assert.deepEqual(await disable(other.projectId, inArchived, other.owner), {
    disabled: false,
    refusal: "conflict",
  });
  for (const id of [enabled, inArchived]) {
    assert.equal((await agentRow(id)).disabledAt, null);
  }
});

test("a disable revokes every grant of the agent that is not revoked yet, with the disabler as the revoker, and cancels its unfinished runs with agent_disabled", async () => {
  const db = database();
  const { owner, workspaceId, projectId } = await setUp();
  const alice = await account("Alice");
  const bob = await account("Bob");
  await join(workspaceId, alice);
  await join(workspaceId, bob);
  const repositoryId = await repositoryOf(projectId, owner);
  const agentId = await created(projectId, alice, "Builder");
  const otherAgent = await created(projectId, alice, "Other");

  const active = await grantTo(projectId, repositoryId, agentId, alice);
  const expired = await grantTo(projectId, repositoryId, agentId, alice, {
    capability: "repo.write",
    expiresAt: EARLIER,
  });
  const connectionId = newId<ProviderConnectionId>();
  await db.insert(providerConnections).values({
    id: connectionId,
    hostDeviceId: alice.deviceId,
    kind: "claude",
    label: "Work",
  });
  const onProvider = await grantTo(projectId, null, agentId, alice, {
    capability: "provider.use",
    providerConnectionId: connectionId,
  });
  const revokedBefore = await grantTo(projectId, repositoryId, agentId, alice, {
    capability: "git.commit",
    revokedAt: EARLIER,
    revokedByUserId: alice.userId,
  });
  const ofOtherAgent = await grantTo(
    projectId,
    repositoryId,
    otherAgent,
    alice,
  );

  const queued = await runOf(projectId, agentId, alice, "queued");
  const running = await runOf(projectId, agentId, alice, "running");
  // A run that another member asked for is cancelled too.
  const waiting = await runOf(projectId, agentId, bob, "awaiting_input");
  const completed = await runOf(projectId, agentId, alice, "completed");
  const otherRun = await runOf(projectId, otherAgent, alice, "running");
  const finishedBefore = await runRow(completed);

  // The workspace's owner disables Alice's agent.
  const result = await disable(projectId, agentId, owner, LATER);
  assert.ok(result.disabled);
  const revoked = [active, expired, onProvider].sort();
  assert.deepEqual(result.revokedGrantIds, revoked);
  assert.ok(Object.isFrozen(result.revokedGrantIds));
  for (const id of revoked) {
    const row = await grantRow(id);
    assert.deepEqual(row.revokedAt, LATER, id);
    assert.equal(row.revokedByUserId, owner.userId, id);
  }
  const before = await grantRow(revokedBefore);
  assert.deepEqual(before.revokedAt, EARLIER);
  assert.equal(before.revokedByUserId, alice.userId);
  assert.equal((await grantRow(ofOtherAgent)).revokedAt, null);

  const cancelled = [
    [queued, "queued"],
    [running, "running"],
    [waiting, "awaiting_input"],
  ] as const;
  assert.deepEqual(
    result.cancelledRuns,
    [...cancelled]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([runId, previousState]) => ({
        runId,
        agentId,
        projectId,
        workspaceId,
        repositoryId: null,
        correlationId: null,
        previousState,
        reason: "agent_disabled",
      })),
  );
  assert.ok(Object.isFrozen(result.cancelledRuns));
  for (const [runId] of cancelled) {
    const row = await runRow(runId);
    assert.equal(row.state, "cancelled", runId);
    assert.equal(row.stateReason, "agent_disabled", runId);
    assert.deepEqual(row.finishedAt, LATER, runId);
  }
  assert.deepEqual(await runRow(completed), finishedBefore);
  assert.equal((await runRow(otherRun)).state, "running");
  assert.equal((await agentRow(otherAgent)).disabledAt, null);
});

test("a disabled agent takes no grant, and nothing restores its grants", async () => {
  const { owner, projectId } = await setUp();
  const repositoryId = await repositoryOf(projectId, owner);
  const agentId = await created(projectId, owner);
  const grant = await grantCapability(database(), {
    agentId,
    userId: owner.userId,
    deviceId: owner.deviceId,
    grant: { capability: "repo.read", repositoryId, lifetimeSeconds: null },
    now: NOW,
  });
  assert.ok(grant.granted, JSON.stringify(grant));
  const result = await disable(projectId, agentId, owner);
  assert.ok(result.disabled);
  assert.deepEqual(result.revokedGrantIds, [grant.grant.id]);
  assert.deepEqual(
    await grantCapability(database(), {
      agentId,
      userId: owner.userId,
      deviceId: owner.deviceId,
      grant: { capability: "repo.read", repositoryId, lifetimeSeconds: null },
      now: LATER,
    }),
    { granted: false, refusal: "conflict" },
  );
  // Clearing `disabled_at` by hand never brings the grant back (P-77).
  await database()
    .update(agents)
    .set({ disabledAt: null })
    .where(eq(agents.id, agentId));
  assert.deepEqual((await grantRow(grant.grant.id)).revokedAt, LATER);
});

test("a refused disable revokes and cancels nothing", async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const member = await account("Member");
  await join(workspaceId, member);
  const repositoryId = await repositoryOf(projectId, owner);
  const agentId = await created(projectId, owner);
  const grant = await grantTo(projectId, repositoryId, agentId, owner);
  const run = await runOf(projectId, agentId, owner, "running");
  assert.deepEqual(await disable(projectId, agentId, member), {
    disabled: false,
    refusal: "forbidden",
  });
  assert.equal((await grantRow(grant)).revokedAt, null);
  assert.equal((await runRow(run)).state, "running");
  assert.equal((await agentRow(agentId)).disabledAt, null);
});

test("the disable and its revocations and cancellations are one transaction, and a creation inside another transaction rolls back with it", async () => {
  const db = database();
  const { owner, projectId } = await setUp();
  const repositoryId = await repositoryOf(projectId, owner);
  const agentId = await created(projectId, owner);
  const grant = await grantTo(projectId, repositoryId, agentId, owner);
  const run = await runOf(projectId, agentId, owner, "queued");
  const rollback = new Error("roll back");
  let createdId: AgentId | undefined;
  await assert.rejects(
    db.transaction(async (tx) => {
      const disabled = await disableAgent(tx, {
        projectId,
        agentId,
        userId: owner.userId,
        now: LATER,
      });
      assert.ok(disabled.disabled);
      const made = await createAgent(tx, input(projectId, owner, "Inner"));
      assert.ok(made.created);
      createdId = made.agent.id;
      throw rollback;
    }),
    (error) => error === rollback,
  );
  assert.equal((await agentRow(agentId)).disabledAt, null);
  assert.equal((await grantRow(grant)).revokedAt, null);
  assert.equal((await runRow(run)).state, "queued");
  assert.ok(createdId !== undefined);
  assert.equal(
    (await db.select().from(agents).where(eq(agents.id, createdId))).length,
    0,
  );

  // A refusal inside another transaction lets it go on.
  await db.transaction(async (tx) => {
    const refused = await disableAgent(tx, {
      projectId,
      agentId: newId<AgentId>(),
      userId: owner.userId,
      now: LATER,
    });
    assert.deepEqual(refused, { disabled: false, refusal: "not_found" });
    assert.ok(
      (
        await disableAgent(tx, {
          projectId,
          agentId,
          userId: owner.userId,
          now: LATER,
        })
      ).disabled,
    );
  });
  assert.deepEqual((await agentRow(agentId)).disabledAt, LATER);
});

test("the owner of an agent that left and joined again is shown by the new person, and its agents were disabled by the departure", async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const member = await account("Member");
  const first = await join(workspaceId, member);
  const agentId = await created(projectId, member);
  const removal = await removeMember(database(), {
    workspaceId,
    ...owner,
    memberId: first,
    now: NOW,
  });
  assert.ok(removal.removed);
  // The removal disabled the agent (P-60), so a disable is a conflict.
  assert.deepEqual(await disable(projectId, agentId, owner), {
    disabled: false,
    refusal: "conflict",
  });
  const again = await join(workspaceId, member);
  const result = await create(projectId, member, "Again");
  assert.ok(result.created);
  assert.equal(result.agent.ownerMemberId, again);
  const disabled = await disable(projectId, result.agent.id, member);
  assert.ok(disabled.disabled);
  assert.equal(disabled.agent.ownerMemberId, again);
});

// The disabled agents of a cascade (#326).

test("disabledAgentsOf reads the agents that a device revocation and a removal disabled, each with its workspace and as the agent list shows it, in the order of the IDs", async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const member = await account("Member");
  const memberPerson = await join(workspaceId, member);
  const own = await workspaceOf(member);
  const ownProject = await projectIn(own, member);
  const ownPerson = await personOf(own, member);
  const inTeam = await created(projectId, member, "Team agent");
  const inOwn = await created(ownProject, member, "Own agent");
  const kept = await created(projectId, owner, "Kept");

  // A device revocation disables the device's agents in both workspaces.
  const revoked = await database().transaction(async (tx) => {
    const result = await revokeDevice(tx, {
      deviceId: member.deviceId,
      userId: member.userId,
      reason: "removed",
      now: LATER,
      actorUserId: member.userId,
      actorDeviceId: null,
    });
    assert.ok(result.revoked);
    return disabledAgentsOf(tx, result.disabledAgentIds);
  });
  const expected = [
    {
      workspaceId,
      agent: {
        id: inTeam,
        projectId,
        name: "Team agent",
        ownerMemberId: memberPerson,
        disabledAt: LATER.toISOString(),
      },
    },
    {
      workspaceId: own,
      agent: {
        id: inOwn,
        projectId: ownProject,
        name: "Own agent",
        ownerMemberId: ownPerson,
        disabledAt: LATER.toISOString(),
      },
    },
  ].sort((a, b) => (a.agent.id < b.agent.id ? -1 : 1));
  assert.deepEqual(revoked, expected);
  for (const { agent } of revoked) {
    assert.ok(Object.isFrozen(agent));
    assert.equal(AgentListItemSchema.safeParse(agent).success, true);
  }
  // The same items as the agent list shows them.
  assert.deepEqual(
    (await listed(projectId, owner)).find((agent) => agent.id === inTeam),
    expected.find((item) => item.agent.id === inTeam)?.agent,
  );

  // A removal disables the person's agents; the owner is the removed person.
  const removed = await account("Removed");
  const removedPerson = await join(workspaceId, removed);
  const removedAgent = await created(projectId, removed, "Leaving");
  const ended = await database().transaction(async (tx) => {
    const result = await removeMember(tx, {
      workspaceId,
      ...owner,
      memberId: removedPerson,
      now: LATER,
    });
    assert.ok(result.removed);
    return disabledAgentsOf(tx, result.disabledAgentIds);
  });
  assert.deepEqual(ended, [
    {
      workspaceId,
      agent: {
        id: removedAgent,
        projectId,
        name: "Leaving",
        ownerMemberId: removedPerson,
        disabledAt: LATER.toISOString(),
      },
    },
  ]);
  assert.deepEqual(await disabledAgentsOf(database(), []), []);

  // An ID of no agent, of an enabled agent, or twice breaks the invariant.
  for (const asked of [
    [inTeam, newId<AgentId>()],
    [inTeam, kept],
    [inTeam, inTeam],
  ]) {
    await assert.rejects(
      disabledAgentsOf(database(), asked),
      /^Error: Invariant broken/u,
      JSON.stringify(asked),
    );
  }
});

// Races, on a PostgreSQL server only.

test(
  "of two concurrent creations for the last enabled place of a project, the second waits at the project and is agent_limit",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, projectId } = await setUp();
    const member = await account("Member");
    await join(workspaceId, member);
    await fill(projectId, owner, ENABLED_PER_PROJECT - 1);
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        assert.ok((await createAgent(tx, input(projectId, owner))).created);
      },
      () => create(projectId, member),
    );
    assert.deepEqual(result, { created: false, refusal: "agent_limit" });
    assert.deepEqual(waitedOn, ["projects"]);
    assert.equal(await agentCount(projectId), ENABLED_PER_PROJECT);
  },
);

test(
  "a device revocation waits for a creation on that device and disables the new agent",
  SERVER_ONLY,
  async () => {
    const { owner, projectId } = await setUp();
    let agentId: AgentId | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const made = await createAgent(tx, input(projectId, owner));
        assert.ok(made.created);
        agentId = made.agent.id;
      },
      () =>
        revokeDevice(database(), {
          ...owner,
          reason: "lost",
          now: LATER,
          actorUserId: owner.userId,
          actorDeviceId: owner.deviceId,
        }),
    );
    assert.ok(agentId !== undefined);
    assert.ok(result.revoked);
    assert.deepEqual(result.disabledAgentIds, [agentId]);
    assert.deepEqual(waitedOn, ["devices"]);
  },
);

test(
  "a removal of the creator waits for a creation and disables the new agent",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, projectId } = await setUp();
    const member = await account("Member");
    const person = await join(workspaceId, member);
    let agentId: AgentId | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const made = await createAgent(tx, input(projectId, member));
        assert.ok(made.created);
        agentId = made.agent.id;
      },
      () =>
        removeMember(database(), {
          workspaceId,
          ...owner,
          memberId: person,
          now: LATER,
        }),
    );
    assert.ok(agentId !== undefined);
    assert.ok(result.removed);
    assert.deepEqual(result.disabledAgentIds, [agentId]);
    assert.deepEqual(waitedOn, ["workspace_members"]);
  },
);

test(
  "a grant waits at the agent for a disable and is then a conflict",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, projectId } = await setUp();
    const admin = await account("Admin");
    await join(workspaceId, admin, "admin");
    const repositoryId = await repositoryOf(projectId, owner);
    const agentId = await created(projectId, owner);
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const disabled = await disableAgent(tx, {
          projectId,
          agentId,
          userId: admin.userId,
          now: NOW,
        });
        assert.ok(disabled.disabled);
      },
      () =>
        grantCapability(database(), {
          agentId,
          userId: owner.userId,
          deviceId: owner.deviceId,
          grant: {
            capability: "repo.read",
            repositoryId,
            lifetimeSeconds: null,
          },
          now: LATER,
        }),
    );
    assert.deepEqual(result, { granted: false, refusal: "conflict" });
    assert.deepEqual(waitedOn, ["agents"]);
  },
);

test(
  "a disable waits at the agent for a grant and revokes the new grant",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, projectId } = await setUp();
    const admin = await account("Admin");
    await join(workspaceId, admin, "admin");
    const repositoryId = await repositoryOf(projectId, owner);
    const agentId = await created(projectId, owner);
    let grantId: PermissionGrantId | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const grant = await grantCapability(tx, {
          agentId,
          userId: owner.userId,
          deviceId: owner.deviceId,
          grant: {
            capability: "repo.read",
            repositoryId,
            lifetimeSeconds: null,
          },
          now: NOW,
        });
        assert.ok(grant.granted);
        grantId = grant.grant.id;
      },
      () =>
        disableAgent(database(), {
          projectId,
          agentId,
          userId: admin.userId,
          now: LATER,
        }),
    );
    assert.ok(grantId !== undefined);
    assert.ok(result.disabled);
    assert.deepEqual(result.revokedGrantIds, [grantId]);
    assert.deepEqual(waitedOn, ["agents"]);
  },
);

test(
  "of two concurrent creations of one account in two projects for its last place of the day, the second waits at the account and is rate_limited",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, projectId } = await setUp();
    const otherProject = await projectIn(workspaceId, owner, "Web");
    await fill(projectId, owner, PER_DAY - 1, { createdAt: EARLIER });
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        assert.ok((await createAgent(tx, input(projectId, owner))).created);
      },
      () => create(otherProject, owner),
    );
    // The projects differ, so only the account's lock orders the counts.
    assert.deepEqual(result, {
      created: false,
      refusal: "rate_limited",
      retryAfterMs: EARLIER.getTime() + DAY_MS - NOW.getTime(),
    });
    assert.deepEqual(waitedOn, ["users"]);
    assert.equal(await agentCount(projectId), PER_DAY);
    assert.equal(await agentCount(otherProject), 0);
  },
);

test(
  "a disable waits at the agent for a run creation and cancels the new run",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, projectId } = await setUp();
    const admin = await account("Admin");
    await join(workspaceId, admin, "admin");
    const agentId = await created(projectId, owner);
    const providerConnectionId = newId<ProviderConnectionId>();
    await database().insert(providerConnections).values({
      id: providerConnectionId,
      hostDeviceId: owner.deviceId,
      kind: "claude",
      label: "Work",
    });
    const message = await postChatMessage(database(), {
      actor: { workspaceId, ...owner },
      projectId,
      eventId: newId<EventId>(),
      body: "Add a health check",
      now: NOW,
    });
    assert.ok(message.posted, JSON.stringify(message));
    let runId: RunId | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        const run = await createRun(tx, {
          ...owner,
          projectId,
          agentId,
          providerConnectionId,
          inputMessageId: message.message.id,
          now: NOW,
        });
        assert.ok(run.created, JSON.stringify(run));
        runId = run.run.id;
      },
      () =>
        disableAgent(database(), {
          projectId,
          agentId,
          userId: admin.userId,
          now: LATER,
        }),
    );
    assert.ok(runId !== undefined);
    assert.ok(result.disabled);
    assert.deepEqual(
      result.cancelledRuns.map((run) => run.runId),
      [runId],
    );
    assert.deepEqual(waitedOn, ["agents"]);
    const row = await runRow(runId);
    assert.equal(row.state, "cancelled");
    assert.equal(row.stateReason, "agent_disabled");
  },
);
