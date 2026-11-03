import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  type AgentId,
  AgentListResponseSchema,
  AgentRunListResponseSchema,
  type AgentRunStateChangedEvent,
  canTransition,
  type CorrelationId,
  decodeServerMessage,
  type DeviceId,
  type EventId,
  MAX_ANSWER_LIST_ITEMS,
  type MemberId,
  newId,
  newUuidV7,
  type ProjectId,
  RECENT_FINISHED_RUNS,
  type RepositoryId,
  type RunId,
  RUN_STATES,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import {
  listProjectAgents,
  listProjectRuns,
  recordRunTransition,
  type RecordRunTransitionInput,
  type RecordRunTransitionResult,
} from "./agent-activity.ts";
import type { Database } from "./db.ts";
import { revokeDevice } from "./device-revocation.ts";
import {
  DEV_SEED_AGENT_NAME,
  DEV_SEED_RUNS,
  seedDevAgent,
} from "./dev-seed.ts";
import { DatabaseError } from "./errors.ts";
import { activePersonOf, createWorkspace } from "./membership.ts";
import { leaveWorkspace, removeMember } from "./people.ts";
import { createProject } from "./projects.ts";
import {
  agentRunTransitions,
  agentRuns,
  agents,
  devices,
  projects,
  repositories,
  users,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";
import { SERVER_ONLY, whileHeld } from "./race-testing.ts";
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

const DAY_MS = 24 * 60 * 60_000;
const NOW = new Date("2026-11-03T12:00:00.000Z");
const LATER = new Date("2026-11-03T13:00:00.000Z");
/** The device's clock, informational. */
const OCCURRED = new Date("2026-11-03T11:59:59.123Z");

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

/** A project of the workspace. */
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
  options: Readonly<{
    deviceId?: DeviceId;
    name?: string;
    createdAt?: Date;
  }> = {},
): Promise<AgentId> {
  const id = newId<AgentId>();
  await database()
    .insert(agents)
    .values({
      id,
      projectId,
      ownerUserId: owner.userId,
      hostDeviceId: options.deviceId ?? owner.deviceId,
      name: options.name ?? "Builder",
      createdAt: options.createdAt ?? NOW,
    });
  return id;
}

/** A run of the agent in `state`, `queued` by default. */
async function runOf(
  agentId: AgentId,
  projectId: ProjectId,
  by: Account,
  options: Readonly<{
    state?: RunState;
    repositoryId?: RepositoryId;
    createdAt?: Date;
    finishedAt?: Date;
  }> = {},
): Promise<RunId> {
  const id = newId<RunId>();
  const state = options.state ?? "queued";
  const terminal =
    state === "completed" || state === "failed" || state === "cancelled";
  await database()
    .insert(agentRuns)
    .values({
      id,
      agentId,
      projectId,
      repositoryId: options.repositoryId,
      requestedByUserId: by.userId,
      state,
      createdAt: options.createdAt ?? NOW,
      finishedAt: terminal ? (options.finishedAt ?? NOW) : null,
    });
  return id;
}

/** A workspace with a project, and an agent of its owner with one queued run. */
async function setUp() {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectOf(workspaceId, owner);
  const agentId = await agentOf(projectId, owner);
  const runId = await runOf(agentId, projectId, owner);
  return { owner, workspaceId, projectId, agentId, runId };
}

type Sender = Readonly<{
  workspaceId: WorkspaceId;
  who: Account;
  agentId: AgentId;
}>;

/** The input of a transition from `queued` to `running`, sent by the account's device. */
function transition(
  from: Sender,
  runId: RunId,
  overrides: Partial<RecordRunTransitionInput> = {},
): RecordRunTransitionInput {
  return {
    actor: { workspaceId: from.workspaceId, ...from.who },
    agentId: from.agentId,
    runId,
    eventId: newId<EventId>(),
    previousState: "queued",
    state: "running",
    occurredAt: OCCURRED,
    now: NOW,
    ...overrides,
  };
}

async function send(
  from: Sender,
  runId: RunId,
  overrides: Partial<RecordRunTransitionInput> = {},
  db: Database = database(),
): Promise<RecordRunTransitionResult> {
  return recordRunTransition(db, transition(from, runId, overrides));
}

/** Sends a transition that must be applied as a new one, and returns its relayed event. */
async function applied(
  from: Sender,
  runId: RunId,
  overrides: Partial<RecordRunTransitionInput> = {},
  db: Database = database(),
): Promise<AgentRunStateChangedEvent> {
  const result = await send(from, runId, overrides, db);
  assert.ok(result.recorded && !result.duplicate, JSON.stringify(result));
  return result.event;
}

async function runRow(runId: RunId) {
  const [row] = await database()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  assert.ok(row !== undefined);
  return row;
}

async function logOf(runId: RunId) {
  return database()
    .select()
    .from(agentRunTransitions)
    .where(eq(agentRunTransitions.runId, runId))
    .orderBy(agentRunTransitions.createdAt, agentRunTransitions.id);
}

/** The relayed event decodes as a device decodes what the server sends. */
function assertRelayable(event: AgentRunStateChangedEvent): void {
  const decoded = decodeServerMessage(JSON.parse(JSON.stringify(event)));
  assert.ok(decoded.ok, JSON.stringify(decoded));
}

test("the host device moves a run: the run is updated, the transition is logged, and the relayed event keeps every field but the device", async () => {
  const { owner, workspaceId, projectId, agentId, runId } = await setUp();
  const from = { workspaceId, who: owner, agentId };
  const correlationId = newId<CorrelationId>();
  const causationId = newId<EventId>();
  const eventId = newId<EventId>();
  const event = await applied(from, runId, {
    eventId,
    reason: "Started",
    correlationId,
    causationId,
  });
  assert.deepEqual(event, {
    protocolVersion: 0,
    id: eventId,
    occurredAt: OCCURRED.toISOString(),
    workspaceId,
    actor: { kind: "agent", agentId },
    deviceId: null,
    correlationId,
    causationId,
    type: "agent.run.state_changed",
    payload: {
      runId,
      agentId,
      previousState: "queued",
      state: "running",
      reason: "Started",
    },
  });
  assertRelayable(event);
  const run = await runRow(runId);
  assert.equal(run.state, "running");
  assert.equal(run.stateReason, "Started");
  assert.deepEqual(run.startedAt, NOW);
  assert.equal(run.finishedAt, null);
  assert.equal(run.projectId, projectId);
  const log = await logOf(runId);
  assert.equal(log.length, 1);
  assert.deepEqual(
    { ...log[0], id: undefined },
    {
      id: undefined,
      runId,
      agentId,
      deviceId: owner.deviceId,
      eventId,
      repositoryId: null,
      previousState: "queued",
      state: "running",
      reason: "Started",
      occurredAt: OCCURRED,
      correlationId,
      causationId,
      createdAt: NOW,
    },
  );

  // Back from awaiting_input keeps the first start; a terminal state finishes the run.
  await applied(from, runId, {
    previousState: "running",
    state: "awaiting_input",
    now: LATER,
  });
  const resumed = await applied(from, runId, {
    previousState: "awaiting_input",
    state: "running",
    now: LATER,
  });
  // Optional fields that the device did not send stay absent.
  assert.deepEqual(Object.keys(resumed).sort(), [
    "actor",
    "deviceId",
    "id",
    "occurredAt",
    "payload",
    "protocolVersion",
    "type",
    "workspaceId",
  ]);
  assert.deepEqual(Object.keys(resumed.payload).sort(), [
    "agentId",
    "previousState",
    "runId",
    "state",
  ]);
  const running = await runRow(runId);
  assert.deepEqual(running.startedAt, NOW);
  // A transition without a reason clears the last one.
  assert.equal(running.stateReason, null);
  await applied(from, runId, {
    previousState: "running",
    state: "completed",
    now: LATER,
  });
  const done = await runRow(runId);
  assert.equal(done.state, "completed");
  assert.deepEqual(done.finishedAt, LATER);
  assert.deepEqual(
    (await logOf(runId)).map((row) => [row.previousState, row.state]),
    [
      ["queued", "running"],
      ["running", "awaiting_input"],
      ["awaiting_input", "running"],
      ["running", "completed"],
    ],
  );
});

test("a run with a repository accepts its own repository in the event and relays it, and also an event without one", async () => {
  const { owner, workspaceId, projectId, agentId } = await setUp();
  const repositoryId = await repositoryOf(projectId, owner);
  const runId = await runOf(agentId, projectId, owner, { repositoryId });
  const from = { workspaceId, who: owner, agentId };
  const event = await applied(from, runId, { repositoryId });
  assert.equal(event.payload.repositoryId, repositoryId);
  assertRelayable(event);
  assert.equal((await logOf(runId))[0]?.repositoryId, repositoryId);
  const second = await applied(from, runId, {
    previousState: "running",
    state: "failed",
    reason: "Exit code 1",
  });
  assert.equal("repositoryId" in second.payload, false);
  assert.equal((await logOf(runId))[1]?.repositoryId, null);
  assert.equal((await runRow(runId)).stateReason, "Exit code 1");
});

test("a transition sent again with the same event ID gets the stored event, and nothing is applied twice", async () => {
  const { owner, workspaceId, projectId, agentId, runId } = await setUp();
  const from = { workspaceId, who: owner, agentId };
  const eventId = newId<EventId>();
  const first = await applied(from, runId, {
    eventId,
    reason: "Started",
    correlationId: newId<CorrelationId>(),
  });
  // The same event again, then other contents under the same event ID,
  // after the run moved on, and after the agent was disabled: the stored
  // event every time, checked before the run's state.
  const again = await send(from, runId, { eventId, reason: "Started" });
  assert.deepEqual(again, { recorded: true, duplicate: true, event: first });
  await applied(from, runId, { previousState: "running", state: "completed" });
  const otherRun = await runOf(agentId, projectId, owner);
  for (const overrides of [
    { eventId, previousState: "running", state: "failed" },
    { eventId, runId: otherRun },
    { eventId, occurredAt: LATER, now: LATER },
  ] as const) {
    assert.deepEqual(await send(from, runId, overrides), {
      recorded: true,
      duplicate: true,
      event: first,
    });
  }
  await database()
    .update(agents)
    .set({ disabledAt: LATER })
    .where(eq(agents.id, agentId));
  assert.deepEqual(await send(from, runId, { eventId }), {
    recorded: true,
    duplicate: true,
    event: first,
  });
  assert.equal((await logOf(runId)).length, 2);
  assert.equal((await runRow(runId)).state, "completed");
  assert.equal((await runRow(otherRun)).state, "queued");
});

test("an event ID that the device recorded in another workspace is a conflict, and nothing is written", async () => {
  const { owner, workspaceId, agentId, runId } = await setUp();
  const eventId = newId<EventId>();
  await applied({ workspaceId, who: owner, agentId }, runId, { eventId });
  const elsewhere = await workspaceOf(owner);
  const app = await projectOf(elsewhere, owner);
  const otherAgent = await agentOf(app, owner);
  const otherRun = await runOf(otherAgent, app, owner);
  assert.deepEqual(
    await send(
      { workspaceId: elsewhere, who: owner, agentId: otherAgent },
      otherRun,
      {
        eventId,
      },
    ),
    { recorded: false, refusal: "conflict" },
  );
  assert.equal((await runRow(otherRun)).state, "queued");
  assert.deepEqual(await logOf(otherRun), []);
});

test("an account that is not an active member of the event's workspace is not_member, also for an event ID that it recorded before", async () => {
  const { owner, workspaceId, projectId, runId, agentId } = await setUp();
  const member = await account("Member");
  const person = await join(workspaceId, member);
  const memberAgent = await agentOf(projectId, member);
  const memberRun = await runOf(memberAgent, projectId, member);
  const eventId = newId<EventId>();
  await applied({ workspaceId, who: member, agentId: memberAgent }, memberRun, {
    eventId,
  });
  const stranger = await account("Stranger");
  for (const [from, id] of [
    // An account that never joined.
    [{ workspaceId, who: stranger, agentId }, runId],
    // A workspace that does not exist.
    [{ workspaceId: newId<WorkspaceId>(), who: owner, agentId }, runId],
  ] as const) {
    assert.deepEqual(await send(from, id), {
      recorded: false,
      refusal: "not_member",
    });
  }
  const removed = await removeMember(database(), {
    workspaceId,
    ...owner,
    memberId: person,
    now: LATER,
  });
  assert.ok(removed.removed);
  assert.deepEqual(
    await send({ workspaceId, who: member, agentId: memberAgent }, memberRun, {
      eventId,
    }),
    { recorded: false, refusal: "not_member" },
  );
  assert.equal((await runRow(runId)).state, "queued");
});

test("an unknown agent or run, an agent or run of another workspace, a run of another agent, and a repository that is not the run's are all not_found", async () => {
  const { owner, workspaceId, projectId, agentId, runId } = await setUp();
  const from = { workspaceId, who: owner, agentId };
  const repositoryId = await repositoryOf(projectId, owner);
  const withRepository = await runOf(agentId, projectId, owner, {
    repositoryId,
  });
  const otherRepository = await repositoryOf(projectId, owner);
  // A second agent of the same device, and an agent of the same device in
  // another workspace.
  const sibling = await agentOf(projectId, owner);
  const siblingRun = await runOf(sibling, projectId, owner);
  const elsewhere = await workspaceOf(owner);
  const app = await projectOf(elsewhere, owner);
  const foreignAgent = await agentOf(app, owner);
  const foreignRun = await runOf(foreignAgent, app, owner);
  const cases: readonly (readonly [string, RecordRunTransitionInput])[] = [
    ["an unknown run", transition(from, newId<RunId>())],
    ["a run of another agent", transition(from, siblingRun)],
    ["a run of another workspace", transition(from, foreignRun)],
    [
      "an unknown agent",
      transition({ ...from, agentId: newId<AgentId>() }, runId),
    ],
    [
      "an agent of another workspace",
      transition({ ...from, agentId: foreignAgent }, foreignRun),
    ],
    [
      "a repository for a run without one",
      transition(from, runId, { repositoryId }),
    ],
    [
      "another repository of the project",
      transition(from, withRepository, { repositoryId: otherRepository }),
    ],
    [
      "an unknown repository",
      transition(from, withRepository, { repositoryId: newId<RepositoryId>() }),
    ],
  ];
  for (const [name, input] of cases) {
    assert.deepEqual(
      await recordRunTransition(database(), input),
      { recorded: false, refusal: "not_found" },
      name,
    );
  }
  for (const id of [runId, withRepository, siblingRun, foreignRun]) {
    assert.equal((await runRow(id)).state, "queued");
    assert.deepEqual(await logOf(id), []);
  }
});

test("an agent of the workspace that the sending device does not host is identity_mismatch", async () => {
  const { owner, workspaceId, projectId, agentId, runId } = await setUp();
  const member = await account("Member");
  await join(workspaceId, member);
  // Another account's device, and the owner's second device.
  const secondDevice = await addDevice(owner.userId);
  for (const who of [member, { ...owner, deviceId: secondDevice }]) {
    assert.deepEqual(await send({ workspaceId, who, agentId }, runId), {
      recorded: false,
      refusal: "identity_mismatch",
    });
  }
  // The member's own agent hosted on the owner's device cannot exist: the
  // host device belongs to the owner (agents_host_device_owner_fk).
  await assert.rejects(
    agentOf(projectId, member, { deviceId: owner.deviceId }),
    (error: unknown) =>
      error instanceof Error &&
      (error.cause as { code?: string } | undefined)?.code === "23503",
  );
  assert.equal((await runRow(runId)).state, "queued");
  assert.deepEqual(await logOf(runId), []);
});

test("a disabled agent, an archived project or workspace, a stale previousState, and a refused transition are conflicts, and nothing is written", async () => {
  const { owner, workspaceId, projectId, agentId, runId } = await setUp();
  const from = { workspaceId, who: owner, agentId };
  const assertConflict = async (
    name: string,
    id: RunId,
    overrides: Partial<RecordRunTransitionInput> = {},
  ) => {
    assert.deepEqual(
      await send(from, id, overrides),
      { recorded: false, refusal: "conflict" },
      name,
    );
  };
  await assertConflict("a stale previousState", runId, {
    previousState: "running",
    state: "completed",
  });
  // The protocol refuses these already; the database refuses them too.
  await assertConflict("a skipped state", runId, {
    previousState: "queued",
    state: "completed",
  });
  await assertConflict("a transition to the same state", runId, {
    previousState: "queued",
    state: "queued",
  });
  const done = await runOf(agentId, projectId, owner, { state: "completed" });
  await assertConflict("out of a terminal state", done, {
    previousState: "completed",
    state: "running",
  });

  await database()
    .update(projects)
    .set({ archivedAt: LATER })
    .where(eq(projects.id, projectId));
  await assertConflict("an archived project", runId);
  await database()
    .update(projects)
    .set({ archivedAt: null })
    .where(eq(projects.id, projectId));
  await database()
    .update(workspaces)
    .set({ archivedAt: LATER })
    .where(eq(workspaces.id, workspaceId));
  await assertConflict("an archived workspace", runId);
  await database()
    .update(workspaces)
    .set({ archivedAt: null })
    .where(eq(workspaces.id, workspaceId));
  await database()
    .update(agents)
    .set({ disabledAt: LATER })
    .where(eq(agents.id, agentId));
  await assertConflict("a disabled agent", runId);

  assert.equal((await runRow(runId)).state, "queued");
  assert.deepEqual(await logOf(runId), []);
  assert.deepEqual(await logOf(done), []);
});

test("a device revocation disables the agent, so the next transition is a conflict, and the cancelled run is not moved", async () => {
  const { owner, workspaceId, agentId, runId } = await setUp();
  const from = { workspaceId, who: owner, agentId };
  await applied(from, runId);
  const revoked = await revokeDevice(database(), {
    ...owner,
    reason: "lost",
    now: LATER,
    actorUserId: owner.userId,
    actorDeviceId: owner.deviceId,
  });
  assert.deepEqual(
    revoked.cancelledRuns.map((run) => [run.runId, run.previousState]),
    [[runId, "running"]],
  );
  assert.deepEqual(
    await send(from, runId, { previousState: "running", state: "completed" }),
    { recorded: false, refusal: "conflict" },
  );
  assert.equal((await runRow(runId)).state, "cancelled");
  assert.equal((await logOf(runId)).length, 1);
});

test("inside another transaction, a transition rolls back with it", async () => {
  const { owner, workspaceId, agentId, runId } = await setUp();
  const from = { workspaceId, who: owner, agentId };
  const eventId = newId<EventId>();
  await assert.rejects(
    database().transaction(async (tx) => {
      await applied(from, runId, { eventId }, tx);
      throw new Error("roll back");
    }),
    /roll back/,
  );
  assert.equal((await runRow(runId)).state, "queued");
  assert.deepEqual(await logOf(runId), []);
  await applied(from, runId, { eventId });
});

test("the transition log refuses a second row per device and event ID, a transition that the protocol does not allow, and rows that mix runs, agents, devices, and repositories", async () => {
  const { owner, workspaceId, projectId, agentId, runId } = await setUp();
  const member = await account("Member");
  await join(workspaceId, member);
  const memberAgent = await agentOf(projectId, member);
  const repositoryId = await repositoryOf(projectId, owner);
  const base = {
    runId,
    agentId,
    deviceId: owner.deviceId,
    previousState: "queued",
    state: "running",
    occurredAt: OCCURRED,
  } as const;
  const insert = (values: Partial<typeof agentRunTransitions.$inferInsert>) =>
    database()
      .insert(agentRunTransitions)
      .values({
        ...base,
        id: newUuidV7(),
        eventId: newId<EventId>(),
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
  const eventId = newId<EventId>();
  await insert({ eventId });
  await rejectsWith(
    () => insert({ eventId }),
    "23505",
    "agent_run_transitions_device_event_key",
  );
  // The same event ID from another device is another transition.
  await database()
    .insert(agentRunTransitions)
    .values({
      ...base,
      id: newUuidV7(),
      eventId,
      runId: await runOf(memberAgent, projectId, member),
      agentId: memberAgent,
      deviceId: member.deviceId,
    });
  await rejectsWith(
    () => insert({ previousState: "queued", state: "completed" }),
    "23514",
    "agent_run_transitions_transition_check",
  );
  await rejectsWith(
    () => insert({ reason: "" }),
    "23514",
    "agent_run_transitions_reason_length",
  );
  await rejectsWith(
    () => insert({ agentId: memberAgent, deviceId: member.deviceId }),
    "23503",
    "agent_run_transitions_run_agent_fk",
  );
  await rejectsWith(
    () => insert({ deviceId: member.deviceId }),
    "23503",
    "agent_run_transitions_agent_host_device_fk",
  );
  await rejectsWith(
    () => insert({ repositoryId }),
    "23503",
    "agent_run_transitions_run_repository_fk",
  );
});

test("the transition CHECK holds exactly the transitions of the protocol that a device sends", async () => {
  assert.ok(testDatabase);
  const { rows } = await testDatabase.client.query<{ def: string }>(
    "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'agent_run_transitions_transition_check'",
  );
  const definition = rows[0]?.def;
  assert.ok(definition);
  const pairs = [
    ...definition.matchAll(
      /previous_state = '([a-z_]+)'::text\) AND \(state = '([a-z_]+)'::text/g,
    ),
  ].map((match) => `${match[1]} -> ${match[2]}`);
  const allowed = RUN_STATES.flatMap((from) =>
    RUN_STATES.filter((to) => canTransition(from, to)).map(
      (to) => `${from} -> ${to}`,
    ),
  );
  assert.deepEqual(pairs.toSorted(), allowed.toSorted());
});

test("a project's agents: every agent of the project with its owner's person and no device, the oldest first", async () => {
  const { owner, workspaceId, projectId, agentId } = await setUp();
  const member = await account("Member");
  const memberPerson = await join(workspaceId, member);
  const leaver = await account("Leaver");
  await join(workspaceId, leaver);
  const memberAgent = await agentOf(projectId, member, {
    name: "Reviewer",
    createdAt: LATER,
  });
  const leaverAgent = await agentOf(projectId, leaver, {
    createdAt: new Date(LATER.getTime() + 1),
  });
  // An agent of another project is not listed.
  await agentOf(await projectOf(workspaceId, owner, "Web"), owner);

  // The leaver leaves: its agent is disabled and keeps the removed person.
  const leaverPerson = await personOf(workspaceId, leaver);
  const left = await leaveWorkspace(database(), {
    workspaceId,
    ...leaver,
    now: LATER,
  });
  assert.ok(left.left);
  // The member leaves and joins again: its agent shows the new person.
  assert.ok(
    (await leaveWorkspace(database(), { workspaceId, ...member, now: LATER }))
      .left,
  );
  const rejoined = await join(workspaceId, member);
  assert.notEqual(rejoined, memberPerson);

  const result = await listProjectAgents(database(), {
    actorUserId: owner.userId,
    projectId,
  });
  assert.ok(result.listed);
  assert.deepEqual(result.agents, [
    {
      id: agentId,
      projectId,
      name: "Builder",
      ownerMemberId: await personOf(workspaceId, owner),
      disabledAt: null,
    },
    {
      id: memberAgent,
      projectId,
      name: "Reviewer",
      ownerMemberId: rejoined,
      disabledAt: LATER.toISOString(),
    },
    {
      id: leaverAgent,
      projectId,
      name: "Builder",
      ownerMemberId: leaverPerson,
      disabledAt: LATER.toISOString(),
    },
  ]);
  assert.ok(
    AgentListResponseSchema.safeParse({ agents: result.agents }).success,
  );
  // Any active member reads the list.
  assert.deepEqual(
    await listProjectAgents(database(), {
      actorUserId: member.userId,
      projectId,
    }),
    result,
  );
  // A project without agents.
  const empty = await projectOf(workspaceId, owner, "Empty");
  assert.deepEqual(
    await listProjectAgents(database(), {
      actorUserId: owner.userId,
      projectId: empty,
    }),
    { listed: true, agents: [] },
  );
});

test("a project's runs: every unfinished run, the most recently created first, and the most recently finished runs", async () => {
  const { owner, workspaceId, projectId, agentId, runId } = await setUp();
  const second = await agentOf(projectId, owner);
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
  const queued = await runOf(second, projectId, owner, { createdAt: at(1) });
  const running = await runOf(agentId, projectId, owner, {
    state: "running",
    createdAt: at(2),
  });
  const waiting = await runOf(second, projectId, owner, {
    state: "awaiting_input",
    createdAt: at(3),
  });
  const finished: RunId[] = [];
  for (let index = 0; index < RECENT_FINISHED_RUNS + 2; index += 1) {
    finished.push(
      await runOf(agentId, projectId, owner, {
        state: (["completed", "failed", "cancelled"] as const)[index % 3],
        createdAt: at(-100 - index),
        finishedAt: at(10 + index),
      }),
    );
  }
  // A run of another project is not listed.
  const web = await projectOf(workspaceId, owner, "Web");
  await runOf(await agentOf(web, owner), web, owner);

  const result = await listProjectRuns(database(), {
    actorUserId: owner.userId,
    projectId,
  });
  assert.ok(result.listed);
  assert.deepEqual(
    result.unfinishedRuns.map((run) => run.id),
    [waiting, running, queued, runId],
  );
  assert.deepEqual(
    result.finishedRuns.map((run) => run.id),
    finished.toReversed().slice(0, RECENT_FINISHED_RUNS),
  );
  assert.deepEqual(result.unfinishedRuns[1], {
    id: running,
    agentId,
    projectId,
    repositoryId: null,
    state: "running",
    reason: null,
    createdAt: at(2).toISOString(),
    finishedAt: null,
  });
  assert.ok(
    AgentRunListResponseSchema.safeParse({
      unfinishedRuns: result.unfinishedRuns,
      finishedRuns: result.finishedRuns,
    }).success,
  );

  // A transition shows in the list with its reason and finish time.
  await applied({ workspaceId, who: owner, agentId }, runId, {
    state: "cancelled",
    reason: "Not needed",
    now: at(500),
  });
  const later = await listProjectRuns(database(), {
    actorUserId: owner.userId,
    projectId,
  });
  assert.ok(later.listed);
  assert.deepEqual(later.finishedRuns[0], {
    id: runId,
    agentId,
    projectId,
    repositoryId: null,
    state: "cancelled",
    reason: "Not needed",
    createdAt: NOW.toISOString(),
    finishedAt: at(500).toISOString(),
  });
  assert.equal(
    later.unfinishedRuns.some((run) => run.id === runId),
    false,
  );
  assert.ok(later.unfinishedRuns.length <= MAX_ANSWER_LIST_ITEMS);
});

test("an unknown project, a project of another workspace, and a removed member get the same not_found from both lists; an archived project stays readable", async () => {
  const { owner, workspaceId, projectId } = await setUp();
  const stranger = await account("Stranger");
  await workspaceOf(stranger);
  const member = await account("Member");
  const person = await join(workspaceId, member);
  assert.ok(
    (
      await removeMember(database(), {
        workspaceId,
        ...owner,
        memberId: person,
        now: LATER,
      })
    ).removed,
  );
  for (const [actorUserId, id] of [
    [owner.userId, newId<ProjectId>()],
    [stranger.userId, projectId],
    [member.userId, projectId],
  ] as const) {
    const input = { actorUserId, projectId: id };
    assert.deepEqual(await listProjectAgents(database(), input), {
      listed: false,
      refusal: "not_found",
    });
    assert.deepEqual(await listProjectRuns(database(), input), {
      listed: false,
      refusal: "not_found",
    });
  }
  await database()
    .update(projects)
    .set({ archivedAt: LATER })
    .where(eq(projects.id, projectId));
  const input = { actorUserId: owner.userId, projectId };
  assert.ok((await listProjectAgents(database(), input)).listed);
  assert.ok((await listProjectRuns(database(), input)).listed);
});

test("an agent whose owner has no person in the workspace breaks the invariant, and the list throws", async () => {
  const { projectId, owner } = await setUp();
  const outsider = await account("Outsider");
  await agentOf(projectId, outsider);
  await assert.rejects(
    listProjectAgents(database(), { actorUserId: owner.userId, projectId }),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof DatabaseError) &&
      /^Invariant broken/.test(error.message),
  );
});

test("the development seed creates an agent hosted on the device with queued runs, which the device then moves", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectOf(workspaceId, owner);
  const result = await seedDevAgent(database(), {
    deviceId: owner.deviceId,
    projectId,
    runs: 3,
    now: NOW,
  });
  assert.ok(result.seeded, JSON.stringify(result));
  assert.equal(result.runIds.length, 3);
  const [agent] = await database()
    .select()
    .from(agents)
    .where(eq(agents.id, result.agentId));
  assert.ok(agent !== undefined);
  assert.equal(agent.name, DEV_SEED_AGENT_NAME);
  assert.equal(agent.ownerUserId, owner.userId);
  assert.equal(agent.hostDeviceId, owner.deviceId);
  assert.equal(agent.projectId, projectId);
  const runs = await listProjectRuns(database(), {
    actorUserId: owner.userId,
    projectId,
  });
  assert.ok(runs.listed);
  // The most recently created first.
  assert.deepEqual(
    runs.unfinishedRuns.map((run) => [run.id, run.state, run.agentId]),
    result.runIds.toReversed().map((id) => [id, "queued", result.agentId]),
  );
  assert.deepEqual(runs.finishedRuns, []);
  const [first] = result.runIds;
  assert.ok(first !== undefined);
  await applied({ workspaceId, who: owner, agentId: result.agentId }, first);
  assert.equal((await runRow(first)).state, "running");
});

test("the development seed refuses a missing or revoked device, a missing project, an account that is not a member, an archived project, and a run count out of range, and writes nothing", async () => {
  const owner = await account("Owner");
  const workspaceId = await workspaceOf(owner);
  const projectId = await projectOf(workspaceId, owner);
  const stranger = await account("Stranger");
  const revoked = await account("Revoked");
  await join(workspaceId, revoked);
  assert.ok(
    (
      await revokeDevice(database(), {
        ...revoked,
        reason: "lost",
        now: NOW,
        actorUserId: revoked.userId,
        actorDeviceId: revoked.deviceId,
      })
    ).revoked,
  );
  const archived = await projectOf(workspaceId, owner, "Old");
  await database()
    .update(projects)
    .set({ archivedAt: NOW })
    .where(eq(projects.id, archived));
  const seed = (deviceId: DeviceId, id: ProjectId) =>
    seedDevAgent(database(), { deviceId, projectId: id, runs: 1, now: NOW });
  assert.deepEqual(await seed(newId<DeviceId>(), projectId), {
    seeded: false,
    refusal: "device_not_found",
  });
  assert.deepEqual(await seed(revoked.deviceId, projectId), {
    seeded: false,
    refusal: "device_not_found",
  });
  assert.deepEqual(await seed(owner.deviceId, newId<ProjectId>()), {
    seeded: false,
    refusal: "project_not_found",
  });
  assert.deepEqual(await seed(stranger.deviceId, projectId), {
    seeded: false,
    refusal: "not_member",
  });
  assert.deepEqual(await seed(owner.deviceId, archived), {
    seeded: false,
    refusal: "archived",
  });
  for (const runs of [0, DEV_SEED_RUNS.max + 1, 1.5]) {
    await assert.rejects(
      seedDevAgent(database(), {
        deviceId: owner.deviceId,
        projectId,
        runs,
        now: NOW,
      }),
      RangeError,
    );
  }
  for (const id of [projectId, archived]) {
    const listed = await listProjectAgents(database(), {
      actorUserId: owner.userId,
      projectId: id,
    });
    assert.deepEqual(listed, { listed: true, agents: [] });
  }
});

test(
  "of two concurrent transitions from the same state, the second waits at the run and is a conflict",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, agentId, runId } = await setUp();
    const from = { workspaceId, who: owner, agentId };
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) => applied(from, runId, {}, tx),
      () => send(from, runId, { state: "cancelled" }),
    );
    assert.deepEqual(result, { recorded: false, refusal: "conflict" });
    assert.deepEqual(waitedOn, ["agent_runs"]);
    assert.equal((await runRow(runId)).state, "running");
    assert.deepEqual(
      (await logOf(runId)).map((row) => row.state),
      ["running"],
    );
  },
);

test(
  "a concurrent transition with the same device and event ID waits at the run and gets the stored event, applied once",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, agentId, runId } = await setUp();
    const from = { workspaceId, who: owner, agentId };
    const eventId = newId<EventId>();
    let held: AgentRunStateChangedEvent | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        held = await applied(from, runId, { eventId, reason: "First" }, tx);
      },
      () => send(from, runId, { eventId, reason: "Second" }),
    );
    assert.ok(held !== undefined);
    assert.deepEqual(result, { recorded: true, duplicate: true, event: held });
    assert.deepEqual(waitedOn, ["agent_runs"]);
    assert.equal((await runRow(runId)).stateReason, "First");
    assert.equal((await logOf(runId)).length, 1);
  },
);

test(
  "a concurrent transition of another run with the same device and event ID waits at the unique index, gets the stored event, and leaves its run unchanged",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, projectId, agentId, runId } = await setUp();
    const otherRun = await runOf(agentId, projectId, owner);
    const from = { workspaceId, who: owner, agentId };
    const eventId = newId<EventId>();
    let held: AgentRunStateChangedEvent | undefined;
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      async (tx) => {
        held = await applied(from, runId, { eventId }, tx);
      },
      () => send(from, otherRun, { eventId }),
    );
    assert.ok(held !== undefined);
    assert.deepEqual(result, { recorded: true, duplicate: true, event: held });
    assert.deepEqual(waitedOn, ["transactionid"]);
    // The savepoint rolled the run's update back.
    assert.equal((await runRow(otherRun)).state, "queued");
    assert.deepEqual(await logOf(otherRun), []);
  },
);

test(
  "a transition waits at the agent for a device revocation that cancels its run, and is then a conflict",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, agentId, runId } = await setUp();
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
      () => send({ workspaceId, who: owner, agentId }, runId),
    );
    assert.deepEqual(result, { recorded: false, refusal: "conflict" });
    assert.deepEqual(waitedOn, ["agents"]);
    const run = await runRow(runId);
    assert.equal(run.state, "cancelled");
    assert.equal(run.stateReason, "device_revoked");
    assert.deepEqual(await logOf(runId), []);
  },
);

test(
  "a device revocation waits at the agent for a transition and cancels the run from its new state",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, agentId, runId } = await setUp();
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) => applied({ workspaceId, who: owner, agentId }, runId, {}, tx),
      () =>
        revokeDevice(database(), {
          ...owner,
          reason: "lost",
          now: LATER,
          actorUserId: owner.userId,
          actorDeviceId: owner.deviceId,
        }),
    );
    assert.ok(result.revoked);
    assert.deepEqual(
      result.cancelledRuns.map((run) => [run.runId, run.previousState]),
      [[runId, "running"]],
    );
    assert.deepEqual(waitedOn, ["agents"]);
    assert.equal((await runRow(runId)).state, "cancelled");
    assert.equal((await logOf(runId)).length, 1);
  },
);

test(
  "a transition waits for a concurrent removal of the agent's owner and is then not_member",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, projectId } = await setUp();
    const member = await account("Member");
    const person = await join(workspaceId, member);
    const agentId = await agentOf(projectId, member);
    const runId = await runOf(agentId, projectId, member);
    const { result, waitedOn } = await whileHeld(
      testDatabase,
      (tx) =>
        removeMember(tx, { workspaceId, ...owner, memberId: person, now: NOW }),
      () => send({ workspaceId, who: member, agentId }, runId),
    );
    assert.deepEqual(result, { recorded: false, refusal: "not_member" });
    assert.deepEqual(waitedOn, ["workspace_members"]);
    assert.equal((await runRow(runId)).state, "cancelled");
    assert.deepEqual(await logOf(runId), []);
  },
);
