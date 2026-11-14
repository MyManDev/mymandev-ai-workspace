import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  type AgentId,
  AgentRunListResponseSchema,
  CreateRunResponseSchema,
  type DeviceId,
  type EventId,
  type MemberId,
  type MessageId,
  newId,
  newUuidV7,
  type ProjectId,
  type ProviderConnectionId,
  type RepositoryId,
  type RunId,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { count, eq } from "drizzle-orm";
import { listProjectRuns, recordRunTransition } from "./agent-activity.ts";
import { postChatMessage } from "./chat.ts";
import type { Database } from "./db.ts";
import { revokeDevice } from "./device-revocation.ts";
import { createWorkspace } from "./membership.ts";
import { removeMember } from "./people.ts";
import { createProject } from "./projects.ts";
import { SERVER_ONLY, whileHeld } from "./race-testing.ts";
import {
  createRun,
  type CreateRunInput,
  type CreateRunResult,
  MAX_NEW_RUNS_PER_AGENT_PER_DAY,
  MAX_UNFINISHED_RUNS_PER_AGENT,
} from "./runs.ts";
import {
  agentRuns,
  agents,
  devices,
  messages,
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
const NOW = new Date("2026-11-14T12:00:00.000Z");
const LATER = new Date("2026-11-14T13:00:00.000Z");

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

/** Adds the account to the workspace as a claimed member. */
async function join(workspaceId: WorkspaceId, who: Account): Promise<MemberId> {
  const id = newId<MemberId>();
  await database().insert(workspaceMembers).values({
    id,
    workspaceId,
    userId: who.userId,
    displayName: "Someone",
    role: "member",
    addedByUserId: who.userId,
    claimedAt: NOW,
  });
  return id;
}

/** A project of the workspace, with its chat. */
async function projectOf(
  workspaceId: WorkspaceId,
  by: Account,
  name = "App",
): Promise<ProjectId> {
  const result = await createProject(database(), {
    workspaceId,
    userId: by.userId,
    name,
    now: NOW,
  });
  assert.ok(result.created, JSON.stringify(result));
  return result.project.id;
}

/** A repository of the project. */
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

/** An agent in the project, owned by the account and hosted on `deviceId`. */
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
    createdAt: NOW,
  });
  return id;
}

/** A provider connection of the device. */
async function connectionOf(deviceId: DeviceId): Promise<ProviderConnectionId> {
  const id = newId<ProviderConnectionId>();
  await database()
    .insert(providerConnections)
    .values({ id, hostDeviceId: deviceId });
  return id;
}

/** A message that the account posted to the project's chat. */
async function messageOf(
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  by: Account,
): Promise<MessageId> {
  const result = await postChatMessage(database(), {
    actor: { workspaceId, ...by },
    projectId,
    eventId: newId<EventId>(),
    body: "Add a health check",
    now: NOW,
  });
  assert.ok(result.posted, JSON.stringify(result));
  return result.message.id;
}

/** A run of the agent written directly, as the development seed writes it. */
async function seededRun(
  agentId: AgentId,
  projectId: ProjectId,
  by: Account,
  options: Readonly<{ state?: RunState; createdAt?: Date }> = {},
): Promise<RunId> {
  const id = newId<RunId>();
  const state = options.state ?? "queued";
  const terminal =
    state === "completed" || state === "failed" || state === "cancelled";
  const createdAt = options.createdAt ?? NOW;
  await database()
    .insert(agentRuns)
    .values({
      id,
      agentId,
      projectId,
      requestedByUserId: by.userId,
      state,
      createdAt,
      finishedAt: terminal ? createdAt : null,
    });
  return id;
}

/**
 * A workspace with a project, an agent of its owner hosted on the owner's
 * device, a provider connection of that device, and a message of the owner
 * in the project's chat: everything a run needs.
 */
async function setUp() {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectOf(workspaceId, owner);
  const agentId = await agentOf(projectId, owner);
  const providerConnectionId = await connectionOf(owner.deviceId);
  const inputMessageId = await messageOf(workspaceId, projectId, owner);
  const request: CreateRunInput = {
    userId: owner.userId,
    projectId,
    agentId,
    providerConnectionId,
    inputMessageId,
    now: NOW,
  };
  return {
    owner,
    workspaceId,
    projectId,
    agentId,
    providerConnectionId,
    inputMessageId,
    request,
  };
}

async function runRow(runId: RunId) {
  const [row] = await database()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  assert.ok(row !== undefined);
  return row;
}

async function runCount(agentId: AgentId): Promise<number> {
  const [row] = await database()
    .select({ n: count() })
    .from(agentRuns)
    .where(eq(agentRuns.agentId, agentId));
  return row?.n ?? 0;
}

/** The run of a creation that must have succeeded. */
function created(result: CreateRunResult) {
  assert.ok(result.created, JSON.stringify(result));
  return result;
}

function refusal(result: CreateRunResult): string {
  assert.ok(!result.created, JSON.stringify(result));
  return result.refusal;
}

/** Moves a run from `queued` to `running` as its agent's host device. */
async function start(
  workspaceId: WorkspaceId,
  host: Account,
  agentId: AgentId,
  runId: RunId,
  db: Database = database(),
) {
  const result = await recordRunTransition(db, {
    actor: { workspaceId, ...host },
    agentId,
    runId,
    eventId: newId<EventId>(),
    previousState: "queued",
    state: "running",
    occurredAt: NOW,
    now: LATER,
  });
  assert.ok(result.recorded && !result.duplicate, JSON.stringify(result));
}

/** Finishes a queued run as its agent's host device. */
async function cancel(
  workspaceId: WorkspaceId,
  host: Account,
  agentId: AgentId,
  runId: RunId,
) {
  const result = await recordRunTransition(database(), {
    actor: { workspaceId, ...host },
    agentId,
    runId,
    eventId: newId<EventId>(),
    previousState: "queued",
    state: "cancelled",
    occurredAt: NOW,
    now: LATER,
  });
  assert.ok(result.recorded && !result.duplicate, JSON.stringify(result));
}

test("the owner of an agent creates a run: it is queued, requested by the owner, and names its provider connection, its agent's host device, and its input message", async () => {
  const { owner, workspaceId, projectId, agentId, request } = await setUp();
  const result = created(await createRun(database(), request));
  assert.equal(result.workspaceId, workspaceId);
  assert.deepEqual(result.run, {
    id: result.run.id,
    agentId,
    projectId,
    repositoryId: null,
    state: "queued",
    reason: null,
    createdAt: NOW.toISOString(),
    finishedAt: null,
    inputMessageId: request.inputMessageId,
    providerConnectionId: request.providerConnectionId,
  });
  // The answer of the route is this run.
  assert.deepEqual(CreateRunResponseSchema.parse({ run: result.run }), {
    run: result.run,
  });
  assert.deepEqual(await runRow(result.run.id), {
    id: result.run.id,
    agentId,
    projectId,
    repositoryId: null,
    requestedByUserId: owner.userId,
    correlationId: null,
    state: "queued",
    stateReason: null,
    createdAt: NOW,
    startedAt: null,
    finishedAt: null,
    providerConnectionId: request.providerConnectionId,
    hostDeviceId: owner.deviceId,
    inputMessageId: request.inputMessageId,
  });
});

test("a run with a repository of the project keeps it, and each creation is a new run", async () => {
  const { owner, projectId, request } = await setUp();
  const repositoryId = await repositoryOf(projectId, owner);
  const first = created(
    await createRun(database(), { ...request, repositoryId }),
  );
  assert.equal(first.run.repositoryId, repositoryId);
  assert.equal((await runRow(first.run.id)).repositoryId, repositoryId);
  // The same request again is a second run: there is no idempotency key.
  const second = created(
    await createRun(database(), { ...request, repositoryId }),
  );
  assert.notEqual(second.run.id, first.run.id);
  assert.equal(await runCount(request.agentId), 2);
});

test("the input message may be another member's: any message of the project's chat that the owner can read", async () => {
  const { workspaceId, projectId, request } = await setUp();
  const member = await account("Member");
  await join(workspaceId, member);
  const inputMessageId = await messageOf(workspaceId, projectId, member);
  const result = created(
    await createRun(database(), { ...request, inputMessageId }),
  );
  assert.equal(result.run.inputMessageId, inputMessageId);
});

test("a project that does not exist, an account that is not a member, and a removed member are not_member, and nothing is written", async () => {
  const { owner, workspaceId, projectId, agentId, request } = await setUp();
  assert.equal(
    refusal(
      await createRun(database(), {
        ...request,
        projectId: newId<ProjectId>(),
      }),
    ),
    "not_member",
  );
  const stranger = await account("Stranger");
  assert.equal(
    refusal(
      await createRun(database(), { ...request, userId: stranger.userId }),
    ),
    "not_member",
  );

  // A member with an agent of their own, removed: the person is gone.
  const member = await account("Member");
  const person = await join(workspaceId, member);
  const memberAgent = await agentOf(projectId, member);
  const memberRequest: CreateRunInput = {
    ...request,
    userId: member.userId,
    agentId: memberAgent,
    providerConnectionId: await connectionOf(member.deviceId),
  };
  created(await createRun(database(), memberRequest));
  const removed = await removeMember(database(), {
    workspaceId,
    ...owner,
    memberId: person,
    now: LATER,
  });
  assert.ok(removed.removed);
  assert.equal(
    refusal(await createRun(database(), memberRequest)),
    "not_member",
  );
  assert.equal(await runCount(agentId), 0);
  assert.equal(await runCount(memberAgent), 1);
});

test("an agent that the project does not have is not_found: unknown, of another project, or of another workspace", async () => {
  const { owner, workspaceId, request } = await setUp();
  assert.equal(
    refusal(
      await createRun(database(), { ...request, agentId: newId<AgentId>() }),
    ),
    "not_found",
  );
  // The owner's own agent in another project of the same workspace.
  const otherProject = await projectOf(workspaceId, owner, "Site");
  const elsewhere = await agentOf(otherProject, owner);
  assert.equal(
    refusal(await createRun(database(), { ...request, agentId: elsewhere })),
    "not_found",
  );
  // The owner's own agent in another workspace.
  const otherWorkspace = await workspaceOf(owner);
  const foreignProject = await projectOf(otherWorkspace, owner);
  const foreign = await agentOf(foreignProject, owner);
  assert.equal(
    refusal(await createRun(database(), { ...request, agentId: foreign })),
    "not_found",
  );
  assert.equal(await runCount(elsewhere), 0);
  assert.equal(await runCount(foreign), 0);
});

test("only the agent's owner creates its runs: another member, also the workspace's owner, is forbidden, before anything else about the request is read", async () => {
  const { workspaceId, projectId, agentId, request } = await setUp();
  const member = await account("Member");
  await join(workspaceId, member);
  // A member asks for the owner's agent.
  assert.equal(
    refusal(await createRun(database(), { ...request, userId: member.userId })),
    "forbidden",
  );
  // The workspace's owner asks for a member's agent: a role gives no right.
  const memberAgent = await agentOf(projectId, member);
  const memberConnection = await connectionOf(member.deviceId);
  assert.equal(
    refusal(
      await createRun(database(), {
        ...request,
        agentId: memberAgent,
        providerConnectionId: memberConnection,
      }),
    ),
    "forbidden",
  );
  // A member who is not the owner learns nothing about the other IDs: an
  // unknown repository, connection, and message still answer forbidden.
  assert.equal(
    refusal(
      await createRun(database(), {
        ...request,
        userId: member.userId,
        repositoryId: newId<RepositoryId>(),
        providerConnectionId: newId<ProviderConnectionId>(),
        inputMessageId: newId<MessageId>(),
      }),
    ),
    "forbidden",
  );
  assert.equal(await runCount(agentId), 0);
  assert.equal(await runCount(memberAgent), 0);
  // The member's own agent, with the member's own connection, is theirs.
  const own = created(
    await createRun(database(), {
      ...request,
      userId: member.userId,
      agentId: memberAgent,
      providerConnectionId: memberConnection,
    }),
  );
  assert.equal((await runRow(own.run.id)).requestedByUserId, member.userId);
});

test("a repository that the project does not have is not_found, and an archived one is a conflict", async () => {
  const { owner, workspaceId, projectId, agentId, request } = await setUp();
  assert.equal(
    refusal(
      await createRun(database(), {
        ...request,
        repositoryId: newId<RepositoryId>(),
      }),
    ),
    "not_found",
  );
  const otherProject = await projectOf(workspaceId, owner, "Site");
  const elsewhere = await repositoryOf(otherProject, owner);
  assert.equal(
    refusal(
      await createRun(database(), { ...request, repositoryId: elsewhere }),
    ),
    "not_found",
  );
  const repositoryId = await repositoryOf(projectId, owner);
  await database()
    .update(repositories)
    .set({ archivedAt: NOW })
    .where(eq(repositories.id, repositoryId));
  assert.equal(
    refusal(await createRun(database(), { ...request, repositoryId })),
    "conflict",
  );
  assert.equal(await runCount(agentId), 0);
  await database()
    .update(repositories)
    .set({ archivedAt: null })
    .where(eq(repositories.id, repositoryId));
  created(await createRun(database(), { ...request, repositoryId }));
});

test("a provider connection that the agent's host device does not have is not_found, whoever's it is, and a removed one is a conflict", async () => {
  const { owner, workspaceId, agentId, providerConnectionId, request } =
    await setUp();
  assert.equal(
    refusal(
      await createRun(database(), {
        ...request,
        providerConnectionId: newId<ProviderConnectionId>(),
      }),
    ),
    "not_found",
  );
  // A connection of another device of the same account.
  const secondDevice = await addDevice(owner.userId);
  assert.equal(
    refusal(
      await createRun(database(), {
        ...request,
        providerConnectionId: await connectionOf(secondDevice),
      }),
    ),
    "not_found",
  );
  // A connection of another member's device.
  const member = await account("Member");
  await join(workspaceId, member);
  assert.equal(
    refusal(
      await createRun(database(), {
        ...request,
        providerConnectionId: await connectionOf(member.deviceId),
      }),
    ),
    "not_found",
  );
  await database()
    .update(providerConnections)
    .set({ removedAt: NOW })
    .where(eq(providerConnections.id, providerConnectionId));
  assert.equal(refusal(await createRun(database(), request)), "conflict");
  assert.equal(await runCount(agentId), 0);
});

test("an agent on the owner's second device takes a connection of that device, not of the device that asks", async () => {
  const { owner, projectId, providerConnectionId, request } = await setUp();
  const secondDevice = await addDevice(owner.userId);
  const agentId = await agentOf(projectId, owner, secondDevice);
  // The connection of the first device is not on this agent's host device.
  assert.equal(
    refusal(await createRun(database(), { ...request, agentId })),
    "not_found",
  );
  const result = created(
    await createRun(database(), {
      ...request,
      agentId,
      providerConnectionId: await connectionOf(secondDevice),
    }),
  );
  const row = await runRow(result.run.id);
  assert.equal(row.hostDeviceId, secondDevice);
  assert.notEqual(row.providerConnectionId, providerConnectionId);
});

test("a message that the project's chat does not have is not_found: unknown, of another project, of another workspace, or deleted", async () => {
  const { owner, workspaceId, agentId, inputMessageId, request } =
    await setUp();
  assert.equal(
    refusal(
      await createRun(database(), {
        ...request,
        inputMessageId: newId<MessageId>(),
      }),
    ),
    "not_found",
  );
  const otherProject = await projectOf(workspaceId, owner, "Site");
  assert.equal(
    refusal(
      await createRun(database(), {
        ...request,
        inputMessageId: await messageOf(workspaceId, otherProject, owner),
      }),
    ),
    "not_found",
  );
  const otherWorkspace = await workspaceOf(owner);
  const foreignProject = await projectOf(otherWorkspace, owner);
  assert.equal(
    refusal(
      await createRun(database(), {
        ...request,
        inputMessageId: await messageOf(otherWorkspace, foreignProject, owner),
      }),
    ),
    "not_found",
  );
  await database()
    .update(messages)
    .set({ deletedAt: NOW })
    .where(eq(messages.id, inputMessageId));
  assert.equal(refusal(await createRun(database(), request)), "not_found");
  assert.equal(await runCount(agentId), 0);
});

test("a message of a conversation of the project that is not its chat is not_found", async () => {
  const { owner, projectId, agentId, request } = await setUp();
  assert.ok(testDatabase);
  const { client } = testDatabase;
  // No writer creates another kind of conversation yet, and the CHECK
  // refuses one, so the test lifts the CHECK for one conversation.
  const conversationId = newUuidV7();
  const inputMessageId = newId<MessageId>();
  await client.query(
    "alter table conversations drop constraint conversations_kind_check",
  );
  try {
    await client.query(
      "insert into conversations (id, project_id, kind, created_by_user_id) values ($1, $2, 'thread', $3)",
      [conversationId, projectId, owner.userId],
    );
    const [person] = await database()
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, owner.userId));
    assert.ok(person !== undefined);
    await database().insert(messages).values({
      id: inputMessageId,
      conversationId,
      seq: 1,
      authorUserId: owner.userId,
      authorMemberId: person.id,
      senderDeviceId: owner.deviceId,
      body: "Elsewhere",
    });
    assert.equal(
      refusal(await createRun(database(), { ...request, inputMessageId })),
      "not_found",
    );
    assert.equal(await runCount(agentId), 0);
  } finally {
    // A run that a broken rule created names the message.
    await client.query("delete from agent_runs where input_message_id = $1", [
      inputMessageId,
    ]);
    await client.query("delete from messages where id = $1", [inputMessageId]);
    await client.query("delete from conversations where id = $1", [
      conversationId,
    ]);
    await client.query(
      "alter table conversations add constraint conversations_kind_check check (kind in ('project'))",
    );
  }
});

test("a disabled agent, an archived project, and an archived workspace are conflicts, and nothing is written", async () => {
  const { workspaceId, projectId, agentId, request } = await setUp();
  await database()
    .update(agents)
    .set({ disabledAt: NOW })
    .where(eq(agents.id, agentId));
  assert.equal(refusal(await createRun(database(), request)), "conflict");
  await database()
    .update(agents)
    .set({ disabledAt: null })
    .where(eq(agents.id, agentId));

  await database()
    .update(projects)
    .set({ archivedAt: NOW })
    .where(eq(projects.id, projectId));
  assert.equal(refusal(await createRun(database(), request)), "conflict");
  await database()
    .update(projects)
    .set({ archivedAt: null })
    .where(eq(projects.id, projectId));

  await database()
    .update(workspaces)
    .set({ archivedAt: NOW })
    .where(eq(workspaces.id, workspaceId));
  assert.equal(refusal(await createRun(database(), request)), "conflict");
  await database()
    .update(workspaces)
    .set({ archivedAt: null })
    .where(eq(workspaces.id, workspaceId));

  assert.equal(await runCount(agentId), 0);
  created(await createRun(database(), request));
});

test("a revoked host device disables the agent, so a creation is a conflict, and the revocation cancels the runs that were created", async () => {
  const { owner, agentId, request } = await setUp();
  const run = created(await createRun(database(), request)).run;
  const revoked = await revokeDevice(database(), {
    ...owner,
    reason: "lost",
    now: LATER,
    actorUserId: owner.userId,
    actorDeviceId: owner.deviceId,
  });
  assert.deepEqual(
    revoked.cancelledRuns.map((cancelled) => cancelled.runId),
    [run.id],
  );
  assert.equal(refusal(await createRun(database(), request)), "conflict");
  assert.equal(await runCount(agentId), 1);
});

test("the refusals are decided in order: the membership, the agent, its owner, the IDs, the states, and then the limits", async () => {
  const { owner, workspaceId, projectId, agentId, request } = await setUp();
  const member = await account("Member");
  await join(workspaceId, member);
  const stranger = await account("Stranger");
  // Everything is wrong at once: the agent is disabled and at both limits,
  // and the request names an unknown message.
  await database()
    .update(agents)
    .set({ disabledAt: NOW })
    .where(eq(agents.id, agentId));
  await database()
    .insert(agentRuns)
    .values(
      Array.from({ length: MAX_NEW_RUNS_PER_AGENT_PER_DAY }, (_, index) => ({
        id: newId<RunId>(),
        agentId,
        projectId,
        requestedByUserId: owner.userId,
        state: "queued" as const,
        createdAt: new Date(NOW.getTime() - index),
      })),
    );
  const unknownMessage = { ...request, inputMessageId: newId<MessageId>() };
  assert.equal(
    refusal(
      await createRun(database(), {
        ...unknownMessage,
        userId: stranger.userId,
      }),
    ),
    "not_member",
  );
  assert.equal(
    refusal(
      await createRun(database(), {
        ...unknownMessage,
        userId: member.userId,
        agentId: newId<AgentId>(),
      }),
    ),
    "not_found",
  );
  assert.equal(
    refusal(
      await createRun(database(), {
        ...unknownMessage,
        userId: member.userId,
      }),
    ),
    "forbidden",
  );
  // The unknown message comes before the disabled agent.
  assert.equal(
    refusal(await createRun(database(), unknownMessage)),
    "not_found",
  );
  // The disabled agent comes before the limits.
  assert.equal(refusal(await createRun(database(), request)), "conflict");
  await database()
    .update(agents)
    .set({ disabledAt: null })
    .where(eq(agents.id, agentId));
  // The limit of unfinished runs comes before the daily limit.
  assert.equal(refusal(await createRun(database(), request)), "run_limit");
  await database()
    .update(agentRuns)
    .set({ state: "failed", finishedAt: NOW })
    .where(eq(agentRuns.agentId, agentId));
  assert.equal(
    refusal(await createRun(database(), request)),
    "run_daily_limit",
  );
});

test("an agent has at most 10 unfinished runs, the seeded ones included; a run that finishes frees a place, and another agent has its own", async () => {
  assert.equal(MAX_UNFINISHED_RUNS_PER_AGENT, 10);
  const { owner, workspaceId, projectId, agentId, request } = await setUp();
  // One run of the development seed, and one that already runs.
  await seededRun(agentId, projectId, owner);
  const running = await seededRun(agentId, projectId, owner);
  await start(workspaceId, owner, agentId, running);
  const made: RunId[] = [];
  for (let n = 2; n < MAX_UNFINISHED_RUNS_PER_AGENT; n += 1) {
    made.push(created(await createRun(database(), request)).run.id);
  }
  assert.equal(await runCount(agentId), MAX_UNFINISHED_RUNS_PER_AGENT);
  assert.deepEqual(await createRun(database(), request), {
    created: false,
    refusal: "run_limit",
  });
  assert.equal(await runCount(agentId), MAX_UNFINISHED_RUNS_PER_AGENT);
  // Time frees nothing: a day later the answer is the same.
  assert.deepEqual(
    await createRun(database(), {
      ...request,
      now: new Date(NOW.getTime() + 2 * DAY_MS),
    }),
    { created: false, refusal: "run_limit" },
  );

  // Another agent of the same owner in the same project has its own places.
  const second = await agentOf(projectId, owner);
  created(await createRun(database(), { ...request, agentId: second }));

  // A run that finishes frees one place, and only one.
  const [first] = made;
  assert.ok(first !== undefined);
  await cancel(workspaceId, owner, agentId, first);
  created(await createRun(database(), request));
  assert.equal(refusal(await createRun(database(), request)), "run_limit");
});

test("an agent gets at most 100 runs within 24 hours, however they ended; the refusal says when the oldest leaves, and another agent has its own", async () => {
  assert.equal(MAX_NEW_RUNS_PER_AGENT_PER_DAY, 100);
  const { owner, projectId, agentId, request } = await setUp();
  // 99 finished runs within the last 24 hours, the oldest 23 hours ago, and
  // one that is exactly 24 hours old, which is outside.
  const oldest = new Date(NOW.getTime() - 23 * HOUR_MS);
  await database()
    .insert(agentRuns)
    .values(
      Array.from({ length: MAX_NEW_RUNS_PER_AGENT_PER_DAY - 1 }, (_, index) => {
        const createdAt = new Date(oldest.getTime() + index * 1_000);
        return {
          id: newId<RunId>(),
          agentId,
          projectId,
          requestedByUserId: owner.userId,
          state: "completed" as const,
          createdAt,
          finishedAt: createdAt,
        };
      }),
    );
  await seededRun(agentId, projectId, owner, {
    state: "failed",
    createdAt: new Date(NOW.getTime() - DAY_MS),
  });
  // The hundredth run of the 24 hours.
  created(await createRun(database(), request));
  assert.deepEqual(await createRun(database(), request), {
    created: false,
    refusal: "run_daily_limit",
    retryAfterMs: HOUR_MS,
  });
  assert.equal(await runCount(agentId), MAX_NEW_RUNS_PER_AGENT_PER_DAY + 1);
  // Another agent of the same owner is not limited by this one.
  const second = await agentOf(projectId, owner);
  created(await createRun(database(), { ...request, agentId: second }));
  // One millisecond before the oldest leaves, still refused; then allowed.
  assert.deepEqual(
    await createRun(database(), {
      ...request,
      now: new Date(NOW.getTime() + HOUR_MS - 1),
    }),
    { created: false, refusal: "run_daily_limit", retryAfterMs: 1 },
  );
  created(
    await createRun(database(), {
      ...request,
      now: new Date(NOW.getTime() + HOUR_MS),
    }),
  );
});

test("of many creations for one agent started together, exactly as many as there are places succeed", async () => {
  const { agentId, request } = await setUp();
  const results = await Promise.all(
    Array.from({ length: MAX_UNFINISHED_RUNS_PER_AGENT + 5 }, () =>
      createRun(database(), request),
    ),
  );
  assert.equal(
    results.filter((result) => result.created).length,
    MAX_UNFINISHED_RUNS_PER_AGENT,
  );
  assert.deepEqual(
    results.filter((result) => !result.created),
    Array.from({ length: 5 }, () => ({ created: false, refusal: "run_limit" })),
  );
  assert.equal(await runCount(agentId), MAX_UNFINISHED_RUNS_PER_AGENT);
});

test("inside another transaction, a creation rolls back with it", async () => {
  const { agentId, request } = await setUp();
  await assert.rejects(
    database().transaction(async (tx) => {
      created(await createRun(tx, request));
      throw new Error("roll back");
    }),
    /roll back/,
  );
  assert.equal(await runCount(agentId), 0);
  created(await createRun(database(), request));
});

test("a run's provider connection, host device, and input message never change: a transition, a removal, and a revocation leave them", async () => {
  const { owner, workspaceId, projectId, request } = await setUp();
  const member = await account("Member");
  const person = await join(workspaceId, member);
  const memberAgent = await agentOf(projectId, member);
  const memberRequest: CreateRunInput = {
    ...request,
    userId: member.userId,
    agentId: memberAgent,
    providerConnectionId: await connectionOf(member.deviceId),
  };
  const moved = created(await createRun(database(), request)).run;
  const cancelled = created(await createRun(database(), memberRequest)).run;
  const kept = async (runId: RunId) => {
    const row = await runRow(runId);
    return [row.providerConnectionId, row.hostDeviceId, row.inputMessageId];
  };
  const before = [await kept(moved.id), await kept(cancelled.id)];
  assert.deepEqual(before, [
    [request.providerConnectionId, owner.deviceId, request.inputMessageId],
    [
      memberRequest.providerConnectionId,
      member.deviceId,
      request.inputMessageId,
    ],
  ]);

  await start(workspaceId, owner, request.agentId, moved.id);
  const removed = await removeMember(database(), {
    workspaceId,
    ...owner,
    memberId: person,
    now: LATER,
  });
  assert.ok(removed.removed);
  assert.equal((await runRow(cancelled.id)).state, "cancelled");
  assert.equal((await runRow(cancelled.id)).stateReason, "member_removed");
  await revokeDevice(database(), {
    ...owner,
    reason: "lost",
    now: LATER,
    actorUserId: owner.userId,
    actorDeviceId: owner.deviceId,
  });
  assert.equal((await runRow(moved.id)).stateReason, "device_revoked");
  assert.deepEqual([await kept(moved.id), await kept(cancelled.id)], before);
});

test("the table keeps a run's provider connection on its agent's host device, and refuses a host device without a connection and an unknown message", async () => {
  const { owner, projectId, agentId, request } = await setUp();
  const member = await account("Member");
  const memberConnection = await connectionOf(member.deviceId);
  const secondDevice = await addDevice(owner.userId);
  const secondConnection = await connectionOf(secondDevice);
  const insert = (values: Partial<typeof agentRuns.$inferInsert>) =>
    database()
      .insert(agentRuns)
      .values({
        id: newId<RunId>(),
        agentId,
        projectId,
        requestedByUserId: owner.userId,
        state: "queued",
        ...values,
      });
  const rejectsWith = async (
    write: () => Promise<unknown>,
    code: string,
    constraint: string,
  ) => {
    await assert.rejects(write(), (error: unknown) => {
      assert.ok(error instanceof Error);
      const cause = error.cause as
        { code?: string; constraint?: string } | undefined;
      assert.equal(cause?.code, code);
      assert.equal(cause?.constraint, constraint);
      return true;
    });
  };
  // A run without a connection and without a message, as the seed writes it.
  await insert({});
  // A connection of the agent's host device, with that device.
  await insert({
    providerConnectionId: request.providerConnectionId,
    hostDeviceId: owner.deviceId,
    inputMessageId: request.inputMessageId,
  });
  // A connection of another account's device, named with the agent's host.
  await rejectsWith(
    () =>
      insert({
        providerConnectionId: memberConnection,
        hostDeviceId: owner.deviceId,
      }),
    "23503",
    "agent_runs_provider_connection_device_fk",
  );
  // The connection's own device, which does not host the agent: another
  // account's, and another device of the same account.
  await rejectsWith(
    () =>
      insert({
        providerConnectionId: memberConnection,
        hostDeviceId: member.deviceId,
      }),
    "23503",
    "agent_runs_agent_host_device_fk",
  );
  await rejectsWith(
    () =>
      insert({
        providerConnectionId: secondConnection,
        hostDeviceId: secondDevice,
      }),
    "23503",
    "agent_runs_agent_host_device_fk",
  );
  // A connection without the host device would escape both foreign keys.
  await rejectsWith(
    () => insert({ providerConnectionId: memberConnection }),
    "23514",
    "agent_runs_provider_connection_check",
  );
  await rejectsWith(
    () => insert({ hostDeviceId: owner.deviceId }),
    "23514",
    "agent_runs_provider_connection_check",
  );
  await rejectsWith(
    () =>
      insert({
        providerConnectionId: newId<ProviderConnectionId>(),
        hostDeviceId: owner.deviceId,
      }),
    "23503",
    "agent_runs_provider_connection_id_provider_connections_id_fk",
  );
  await rejectsWith(
    () => insert({ inputMessageId: newId<MessageId>() }),
    "23503",
    "agent_runs_input_message_id_messages_id_fk",
  );
});

test("the run list shows a run's input message to every member, and its provider connection only to the account that owns its agent", async () => {
  const { owner, workspaceId, projectId, agentId, request } = await setUp();
  const member = await account("Member");
  await join(workspaceId, member);
  const memberAgent = await agentOf(projectId, member);
  const memberConnection = await connectionOf(member.deviceId);
  const seeded = await seededRun(agentId, projectId, owner, {
    createdAt: new Date(NOW.getTime() - 3),
  });
  const ownersRun = created(
    await createRun(database(), {
      ...request,
      now: new Date(NOW.getTime() - 2),
    }),
  ).run;
  const membersRun = created(
    await createRun(database(), {
      ...request,
      userId: member.userId,
      agentId: memberAgent,
      providerConnectionId: memberConnection,
      now: new Date(NOW.getTime() - 1),
    }),
  ).run;
  // One of the owner's runs finishes, so that both lists hold a run.
  const finished = created(await createRun(database(), request)).run;
  await cancel(workspaceId, owner, agentId, finished.id);

  const read = async (who: Account) => {
    const list = await listProjectRuns(database(), {
      actorUserId: who.userId,
      projectId,
    });
    assert.ok(list.listed);
    assert.deepEqual(
      AgentRunListResponseSchema.parse({
        unfinishedRuns: list.unfinishedRuns,
        finishedRuns: list.finishedRuns,
      }),
      {
        unfinishedRuns: list.unfinishedRuns,
        finishedRuns: list.finishedRuns,
      },
    );
    return list;
  };
  const withoutConnection = (run: typeof ownersRun) => {
    const { providerConnectionId, ...rest } = run;
    assert.ok(providerConnectionId !== undefined);
    return rest;
  };
  const seededItem = {
    id: seeded,
    agentId,
    projectId,
    repositoryId: null,
    state: "queued",
    reason: null,
    createdAt: new Date(NOW.getTime() - 3).toISOString(),
    finishedAt: null,
  };
  const finishedItem: typeof finished = {
    ...finished,
    state: "cancelled",
    finishedAt: LATER.toISOString(),
  };

  // The owner of the first agent: the connection of their own runs only.
  const forOwner = await read(owner);
  assert.deepEqual(forOwner.unfinishedRuns, [
    withoutConnection(membersRun),
    ownersRun,
    seededItem,
  ]);
  assert.deepEqual(forOwner.finishedRuns, [finishedItem]);

  // The member: the connection of their own run only.
  const forMember = await read(member);
  assert.deepEqual(forMember.unfinishedRuns, [
    membersRun,
    withoutConnection(ownersRun),
    seededItem,
  ]);
  assert.deepEqual(forMember.finishedRuns, [withoutConnection(finishedItem)]);

  // A member who owns no agent: no connection at all, and every input.
  const reader = await account("Reader");
  await join(workspaceId, reader);
  const forReader = await read(reader);
  assert.deepEqual(forReader.unfinishedRuns, [
    withoutConnection(membersRun),
    withoutConnection(ownersRun),
    seededItem,
  ]);
  assert.deepEqual(forReader.finishedRuns, [withoutConnection(finishedItem)]);
  for (const run of [...forReader.unfinishedRuns, ...forReader.finishedRuns]) {
    assert.equal("providerConnectionId" in run, false);
  }
});

test(
  "of two concurrent creations for the last place of an agent, the second waits at the agent and is run_limit",
  SERVER_ONLY,
  async () => {
    const { owner, projectId, agentId, request } = await setUp();
    for (let n = 1; n < MAX_UNFINISHED_RUNS_PER_AGENT; n += 1) {
      await seededRun(agentId, projectId, owner);
    }
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        created(await createRun(tx, request));
      },
      () => createRun(database(), request),
    );
    assert.deepEqual(result, { created: false, refusal: "run_limit" });
    assert.deepEqual(waitedOn, ["agents"]);
    assert.equal(await runCount(agentId), MAX_UNFINISHED_RUNS_PER_AGENT);
  },
);

test(
  "a creation waits at the agent for a device revocation and is then a conflict",
  SERVER_ONLY,
  async () => {
    const { owner, agentId, request } = await setUp();
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) =>
        revokeDevice(tx, {
          ...owner,
          reason: "lost",
          now: NOW,
          actorUserId: owner.userId,
          actorDeviceId: owner.deviceId,
        }),
      () => createRun(database(), request),
    );
    assert.deepEqual(result, { created: false, refusal: "conflict" });
    assert.deepEqual(waitedOn, ["agents"]);
    assert.equal(await runCount(agentId), 0);
  },
);

test(
  "a device revocation waits at the agent for a creation and cancels the new run",
  SERVER_ONLY,
  async () => {
    const { owner, request } = await setUp();
    let runId: RunId | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        runId = created(await createRun(tx, request)).run.id;
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
    assert.ok(runId !== undefined);
    assert.ok(result.revoked);
    assert.deepEqual(
      result.cancelledRuns.map((run) => [run.runId, run.previousState]),
      [[runId, "queued"]],
    );
    assert.deepEqual(waitedOn, ["agents"]);
    assert.equal((await runRow(runId)).state, "cancelled");
  },
);

test(
  "a creation waits for a concurrent removal of the agent's owner and is then not_member",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, projectId, request } = await setUp();
    const member = await account("Member");
    const person = await join(workspaceId, member);
    const agentId = await agentOf(projectId, member);
    const memberRequest: CreateRunInput = {
      ...request,
      userId: member.userId,
      agentId,
      providerConnectionId: await connectionOf(member.deviceId),
    };
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) =>
        removeMember(tx, { workspaceId, ...owner, memberId: person, now: NOW }),
      () => createRun(database(), memberRequest),
    );
    assert.deepEqual(result, { created: false, refusal: "not_member" });
    assert.deepEqual(waitedOn, ["workspace_members"]);
    assert.equal(await runCount(agentId), 0);
  },
);

test(
  "a removal of the agent's owner waits for a creation and cancels the new run",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, projectId, request } = await setUp();
    const member = await account("Member");
    const person = await join(workspaceId, member);
    const agentId = await agentOf(projectId, member);
    const memberRequest: CreateRunInput = {
      ...request,
      userId: member.userId,
      agentId,
      providerConnectionId: await connectionOf(member.deviceId),
    };
    let runId: RunId | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        runId = created(await createRun(tx, memberRequest)).run.id;
      },
      () =>
        removeMember(database(), {
          workspaceId,
          ...owner,
          memberId: person,
          now: LATER,
        }),
    );
    assert.ok(runId !== undefined);
    assert.ok(result.removed);
    assert.deepEqual(waitedOn, ["workspace_members"]);
    const run = await runRow(runId);
    assert.equal(run.state, "cancelled");
    assert.equal(run.stateReason, "member_removed");
  },
);

test(
  "a creation waits at the agent for a transition of one of the agent's runs, and both are applied",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, projectId, agentId, request } = await setUp();
    const running = await seededRun(agentId, projectId, owner);
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) => start(workspaceId, owner, agentId, running, tx),
      () => createRun(database(), request),
    );
    assert.ok(result.created, JSON.stringify(result));
    assert.deepEqual(waitedOn, ["agents"]);
    assert.equal((await runRow(running)).state, "running");
    assert.equal(await runCount(agentId), 2);
  },
);
