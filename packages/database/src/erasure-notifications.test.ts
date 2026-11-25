import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentId,
  type CorrelationId,
  type DeviceId,
  type JoinRequestId,
  type MemberId,
  newId,
  newUuidV7,
  type PermissionGrantId,
  type ProjectId,
  type RepositoryId,
  type RunId,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq, sql } from "drizzle-orm";
import { eraseAccount } from "./account-erasure.ts";
import type { Database } from "./db.ts";
import { checkErasureNotification } from "./erasure-check.ts";
import {
  APPROVERS_PER_NOTIFICATION,
  encodeErasureNotification,
  ERASURE_NOTIFICATION_CHANNEL,
  type ErasureNotification,
  erasureNotifications,
  MAX_NOTIFICATION_PAYLOAD_BYTES,
} from "./erasure-notifications.ts";
import { createWorkspace } from "./membership.ts";
import {
  checkChannel,
  LISTENER_APPLICATION_NAME,
  type NotificationSession,
  pgNotificationSessions,
} from "./notification-session.ts";
import {
  agentRuns,
  agents,
  devices,
  permissionGrants,
  projects,
  repositories,
  userIdentities,
  users,
  workspaceJoinRequests,
  workspaceMembers,
} from "./schema/index.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

// The notifications that an erasure sends for the API's live events (#341):
// their content and order, only at the commit, none after a rollback or a
// refusal, nothing about an archived workspace, and the payload bound.

let testDatabase: TestDatabase | undefined;
let session: NotificationSession | undefined;
/** Every payload received on the erasure's channel, in the order of delivery. */
const received: string[] = [];
/** Whether the session that listens for the whole file was lost; it never is. */
let sessionLost = false;

function database(): Database {
  assert.ok(testDatabase, "the test database is created in before()");
  return testDatabase.db;
}

before(async () => {
  testDatabase = await createTestDatabase();
  session = await testDatabase.notificationSessions();
  await session.listen(ERASURE_NOTIFICATION_CHANNEL, {
    onPayload: (payload) => received.push(payload),
    onLost: () => {
      sessionLost = true;
    },
  });
});

after(async () => {
  await session?.close();
  await testDatabase?.close();
});

const NOW = new Date("2026-11-25T09:00:00.000Z");
const ERASED_AT = new Date("2026-11-25T10:00:00.000Z");
const ROLLED_BACK_AT = new Date("2026-11-25T11:00:00.000Z");
const HOUR_MS = 60 * 60_000;

/** A marker sent on the channel after a change; everything before it was delivered first. */
let markers = 0;

/**
 * The payloads that arrive after the previous call, up to a marker that this
 * call sends on the channel in a transaction of its own and that a server
 * delivers after everything committed before it.
 */
async function drained(): Promise<ErasureNotification[]> {
  assert.equal(sessionLost, false, "the listening session was lost");
  markers += 1;
  const marker = `marker-${markers}`;
  await database().execute(
    sql`select pg_notify(${ERASURE_NOTIFICATION_CHANNEL}, ${marker})`,
  );
  const deadline = Date.now() + 5_000;
  while (!received.includes(marker)) {
    assert.ok(Date.now() < deadline, "the marker never arrived");
    await delay(5);
  }
  const taken = received.splice(0, received.indexOf(marker) + 1);
  return taken
    .slice(0, -1)
    .map((payload) => JSON.parse(payload) as ErasureNotification);
}

type Account = Readonly<{ userId: UserId; deviceId: DeviceId }>;

let nextSubject = 9_400_000;

async function deviceOf(userId: UserId): Promise<DeviceId> {
  const id = newId<DeviceId>();
  await database()
    .insert(devices)
    .values({
      id,
      userId,
      label: "Laptop",
      platform: "linux",
      publicKey: randomBytes(32).toString("hex"),
      keyAlgorithm: "ed25519",
      lastSignInAt: NOW,
    });
  return id;
}

async function account(name: string): Promise<Account> {
  const userId = newId<UserId>();
  await database().insert(users).values({ id: userId, displayName: name });
  nextSubject += 1;
  await database()
    .insert(userIdentities)
    .values({
      id: newUuidV7(),
      userId,
      identityProvider: "github",
      subject: String(nextSubject),
      login: `user-${nextSubject}`,
      accountCreatedAt: NOW,
      lastSignInAt: NOW,
    });
  return { userId, deviceId: await deviceOf(userId) };
}

async function workspaceOf(owner: Account) {
  const result = await createWorkspace(database(), {
    ...owner,
    name: "Team",
    displayName: "Owner",
    now: NOW,
  });
  assert.ok(result.created);
  return {
    workspaceId: result.membership.workspace.id,
    ownerPerson: result.membership.member.id,
  };
}

async function addPerson(
  workspaceId: WorkspaceId,
  addedBy: Account,
  claimedBy: Account | null,
  values: Partial<typeof workspaceMembers.$inferInsert> = {},
): Promise<MemberId> {
  const id = newId<MemberId>();
  await database()
    .insert(workspaceMembers)
    .values({
      id,
      workspaceId,
      displayName: "Someone",
      role: "member",
      addedByUserId: addedBy.userId,
      createdAt: NOW,
      ...(claimedBy === null
        ? {}
        : { userId: claimedBy.userId, claimedAt: NOW }),
      ...values,
    });
  return id;
}

type Project = Readonly<{ projectId: ProjectId; repositoryId: RepositoryId }>;

async function projectIn(
  workspaceId: WorkspaceId,
  by: Account,
): Promise<Project> {
  const projectId = newId<ProjectId>();
  await database().insert(projects).values({
    id: projectId,
    workspaceId,
    name: "App",
    createdByUserId: by.userId,
  });
  const repositoryId = newId<RepositoryId>();
  await database().insert(repositories).values({
    id: repositoryId,
    projectId,
    name: "app",
    createdByUserId: by.userId,
  });
  return { projectId, repositoryId };
}

async function agentOf(
  project: Project,
  owner: Account,
  hostDeviceId: DeviceId = owner.deviceId,
): Promise<AgentId> {
  const id = newId<AgentId>();
  await database().insert(agents).values({
    id,
    projectId: project.projectId,
    ownerUserId: owner.userId,
    hostDeviceId,
    name: "Erin's builder",
  });
  return id;
}

async function grantTo(
  project: Project,
  agentId: AgentId,
  owner: Account,
  hostDeviceId: DeviceId = owner.deviceId,
): Promise<PermissionGrantId> {
  const id = newId<PermissionGrantId>();
  await database().insert(permissionGrants).values({
    id,
    projectId: project.projectId,
    granteeAgentId: agentId,
    hostDeviceId,
    capability: "repo.read",
    repositoryId: project.repositoryId,
    grantedByUserId: owner.userId,
    createdAt: NOW,
  });
  return id;
}

async function runOf(
  project: Project,
  agentId: AgentId,
  state: RunState,
  requestedBy: Account,
  values: Partial<typeof agentRuns.$inferInsert> = {},
): Promise<RunId> {
  const id = newId<RunId>();
  await database()
    .insert(agentRuns)
    .values({
      id,
      agentId,
      projectId: project.projectId,
      requestedByUserId: requestedBy.userId,
      state,
      ...values,
    });
  return id;
}

/** A pending join request of `who`, written directly. */
async function pendingRequest(
  who: Account,
  workspaceId: WorkspaceId,
): Promise<JoinRequestId> {
  const id = newId<JoinRequestId>();
  await database()
    .insert(workspaceJoinRequests)
    .values({
      id,
      workspaceId,
      requesterUserId: who.userId,
      requesterDeviceId: who.deviceId,
      requestedDisplayName: "Erin Example",
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 168 * HOUR_MS),
    });
  return id;
}

function inOrder<T extends string>(...ids: T[]): T[] {
  return [...ids].sort();
}

const header = (kind: ErasureNotification["kind"], userId: UserId) => ({
  v: 1,
  kind,
  at: ERASED_AT.toISOString(),
  userId,
});

test("an erasure notifies at its commit, in the order of the routes: the account, each ended membership with its agents, grants, and runs, each revoked device's, and each withdrawn join request with its approvers; nothing about an archived workspace, and no name", async () => {
  const db = database();
  const owner = await account("Olga");
  const erin = await account("Erin");
  const mia = await account("Mia");
  const gus = await account("Gus");

  // Erin is an admin of the first workspace and a member of the second.
  const first = await workspaceOf(owner);
  const second = await workspaceOf(owner);
  const erinInFirst = await addPerson(first.workspaceId, owner, erin, {
    role: "admin",
    displayName: "Erin the admin",
  });
  const erinInSecond = await addPerson(second.workspaceId, owner, erin);
  await addPerson(first.workspaceId, owner, mia);
  const project = await projectIn(first.workspaceId, owner);
  const erinsAgent = await agentOf(project, erin);
  const erinsGrant = await grantTo(project, erinsAgent, erin);
  const ownersAgent = await agentOf(project, owner);
  const correlationId = newId<CorrelationId>();
  const onErinsAgent = await runOf(project, erinsAgent, "queued", owner, {
    repositoryId: project.repositoryId,
    correlationId,
  });
  const requestedByErin = await runOf(project, ownersAgent, "running", erin);

  // A former workspace, where a second device of Erin's hosts an agent that
  // no removal reaches, which only data written outside the functions has.
  const former = await workspaceOf(owner);
  const erinBefore = await addPerson(former.workspaceId, owner, erin, {
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const secondDevice = await deviceOf(erin.userId);
  const formerProject = await projectIn(former.workspaceId, owner);
  const strayAgent = await agentOf(formerProject, erin, secondDevice);
  const strayGrant = await grantTo(
    formerProject,
    strayAgent,
    erin,
    secondDevice,
  );
  const strayRun = await runOf(formerProject, strayAgent, "running", erin);

  // A pending request to a workspace with an owner and an admin.
  const asked = await workspaceOf(owner);
  const miaAdmin = await addPerson(asked.workspaceId, owner, mia, {
    role: "admin",
  });
  const toAsked = await pendingRequest(erin, asked.workspaceId);

  // A workspace that Erin owns alone, with an unclaimed person: it is
  // archived, and nothing about it is sent, also not Erin's agent, grant,
  // and run there, her own pending request there, or Gus's denied request.
  const alone = await workspaceOf(erin);
  await addPerson(alone.workspaceId, erin, null);
  const aloneProject = await projectIn(alone.workspaceId, erin);
  const aloneAgent = await agentOf(aloneProject, erin);
  await grantTo(aloneProject, aloneAgent, erin);
  await runOf(aloneProject, aloneAgent, "queued", erin);
  await pendingRequest(gus, alone.workspaceId);
  await pendingRequest(erin, alone.workspaceId);

  await drained();
  const result = await db.transaction(async (tx) => {
    const erased = await eraseAccount(tx, {
      userId: erin.userId,
      now: ERASED_AT,
    });
    // Nothing is delivered before the commit.
    await delay(20);
    assert.deepEqual(received, []);
    return erased;
  });
  assert.ok(result.erased);
  assert.deepEqual(
    result.archivedWorkspaces.map((archive) => archive.workspaceId),
    [alone.workspaceId],
  );
  const notified = await drained();

  const at = ERASED_AT.toISOString();
  const firstMembership = [
    {
      ...header("membership_ended", erin.userId),
      workspaceId: first.workspaceId,
      memberId: erinInFirst,
    },
    {
      ...header("agent_disabled", erin.userId),
      workspaceId: first.workspaceId,
      agentId: erinsAgent,
      projectId: project.projectId,
      ownerMemberId: erinInFirst,
      disabledAt: at,
    },
    {
      ...header("grant_revoked", erin.userId),
      workspaceId: first.workspaceId,
      grantId: erinsGrant,
      granteeAgentId: erinsAgent,
      revokedAt: at,
    },
    ...[
      {
        ...header("run_cancelled", erin.userId),
        workspaceId: first.workspaceId,
        runId: onErinsAgent,
        agentId: erinsAgent,
        projectId: project.projectId,
        repositoryId: project.repositoryId,
        correlationId,
        previousState: "queued",
        reason: "member_removed",
      },
      {
        ...header("run_cancelled", erin.userId),
        workspaceId: first.workspaceId,
        runId: requestedByErin,
        agentId: ownersAgent,
        projectId: project.projectId,
        repositoryId: null,
        correlationId: null,
        previousState: "running",
        reason: "member_removed",
      },
    ].sort((a, b) => (a.runId < b.runId ? -1 : 1)),
  ];
  const secondMembership = [
    {
      ...header("membership_ended", erin.userId),
      workspaceId: second.workspaceId,
      memberId: erinInSecond,
    },
  ];
  // The people of the account in the order of their IDs.
  const memberships =
    erinInFirst < erinInSecond
      ? [...firstMembership, ...secondMembership]
      : [...secondMembership, ...firstMembership];
  assert.deepEqual(notified, [
    header("account_erased", erin.userId),
    ...memberships,
    // The second device's cascade, in the former workspace.
    {
      ...header("agent_disabled", erin.userId),
      workspaceId: former.workspaceId,
      agentId: strayAgent,
      projectId: formerProject.projectId,
      ownerMemberId: erinBefore,
      disabledAt: at,
    },
    {
      ...header("grant_revoked", erin.userId),
      workspaceId: former.workspaceId,
      grantId: strayGrant,
      granteeAgentId: strayAgent,
      revokedAt: at,
    },
    {
      ...header("run_cancelled", erin.userId),
      workspaceId: former.workspaceId,
      runId: strayRun,
      agentId: strayAgent,
      projectId: formerProject.projectId,
      repositoryId: null,
      correlationId: null,
      previousState: "running",
      reason: "device_revoked",
    },
    {
      ...header("join_request_withdrawn", erin.userId),
      workspaceId: asked.workspaceId,
      joinRequestId: toAsked,
      approvers: inOrder(asked.ownerPerson, miaAdmin),
    },
  ]);
  // No name, label, or login travels: the agents' names stay out too.
  const text = JSON.stringify(notified);
  for (const name of ["Erin", "Olga", "Mia", "builder", "Laptop", "Team"]) {
    assert.equal(text.includes(name), false, name);
  }

  // A second erasure changes nothing and sends nothing.
  const again = await eraseAccount(db, { userId: erin.userId, now: ERASED_AT });
  assert.deepEqual(again, { erased: false, refusal: "already_erased" });
  assert.deepEqual(await drained(), []);
});

test("an erasure that rolls back, as a transaction or as a savepoint, and a refused erasure send nothing", async () => {
  const db = database();
  const owner = await account("Olga");
  const erin = await account("Erin");
  const mia = await account("Mia");
  const team = await workspaceOf(owner);
  await addPerson(team.workspaceId, owner, erin);
  await drained();

  await assert.rejects(
    db.transaction(async (tx) => {
      const result = await eraseAccount(tx, {
        userId: erin.userId,
        now: ROLLED_BACK_AT,
      });
      assert.ok(result.erased);
      throw new Error("roll back");
    }),
    /roll back/,
  );
  assert.deepEqual(await drained(), []);

  // The savepoint rolls back while the transaction around it commits.
  await db.transaction(async (tx) => {
    await assert.rejects(
      tx.transaction(async (savepoint) => {
        const result = await eraseAccount(savepoint, {
          userId: erin.userId,
          now: ROLLED_BACK_AT,
        });
        assert.ok(result.erased);
        throw new Error("roll back the savepoint");
      }),
      /roll back the savepoint/,
    );
  });
  assert.deepEqual(await drained(), []);

  // An owner with another active, claimed person is refused.
  const owned = await workspaceOf(erin);
  await addPerson(owned.workspaceId, erin, mia);
  const refused = await eraseAccount(db, {
    userId: erin.userId,
    now: ROLLED_BACK_AT,
  });
  assert.equal(refused.erased, false);
  assert.deepEqual(await drained(), []);
});

test("the approvers of a withdrawn request are read after the removals, so the erased account's own admin person is not one of them", async () => {
  const owner = await account("Olga");
  const erin = await account("Erin");
  const team = await workspaceOf(owner);
  // A request made before Erin became an admin there, written directly.
  const request = await pendingRequest(erin, team.workspaceId);
  const erinAdmin = await addPerson(team.workspaceId, owner, erin, {
    role: "admin",
  });
  await drained();
  const result = await eraseAccount(database(), {
    userId: erin.userId,
    now: ERASED_AT,
  });
  assert.ok(result.erased);
  const notified = await drained();
  assert.deepEqual(
    notified.map((notification) => notification.kind),
    ["account_erased", "membership_ended", "join_request_withdrawn"],
  );
  assert.deepEqual(notified[1], {
    ...header("membership_ended", erin.userId),
    workspaceId: team.workspaceId,
    memberId: erinAdmin,
  });
  assert.deepEqual(notified[2], {
    ...header("join_request_withdrawn", erin.userId),
    workspaceId: team.workspaceId,
    joinRequestId: request,
    approvers: [team.ownerPerson],
  });
});

test("a withdrawal in a workspace with more approvers than one payload holds is split, each approver named once, and every payload stays within the bound that PostgreSQL enforces", async () => {
  const db = database();
  const owner = await account("Olga");
  const erin = await account("Erin");
  const team = await workspaceOf(owner);
  // 150 admins with accounts, written in one statement each.
  const admins = Array.from({ length: 150 }, () => newId<UserId>());
  await db
    .insert(users)
    .values(admins.map((id) => ({ id, displayName: "Admin" })));
  const people = admins.map((userId) => ({
    id: newId<MemberId>(),
    workspaceId: team.workspaceId,
    userId,
    displayName: "Admin",
    role: "admin" as const,
    addedByUserId: owner.userId,
    claimedAt: NOW,
  }));
  await db.insert(workspaceMembers).values(people);
  const request = await pendingRequest(erin, team.workspaceId);
  await drained();

  const result = await eraseAccount(db, {
    userId: erin.userId,
    now: ERASED_AT,
  });
  assert.ok(result.erased);
  const notified = await drained();
  const withdrawals = notified.filter(
    (notification) => notification.kind === "join_request_withdrawn",
  );
  assert.deepEqual(
    withdrawals.map((notification) => notification.approvers.length),
    [APPROVERS_PER_NOTIFICATION, 51],
  );
  assert.deepEqual(
    withdrawals.flatMap((notification) => notification.approvers),
    inOrder(team.ownerPerson, ...people.map((person) => person.id)),
  );
  for (const notification of withdrawals) {
    assert.equal(notification.joinRequestId, request);
    assert.ok(
      Buffer.byteLength(JSON.stringify(notification)) <=
        MAX_NOTIFICATION_PAYLOAD_BYTES,
    );
  }

  // The bound is PostgreSQL's: one byte more is refused.
  const longest = "x".repeat(MAX_NOTIFICATION_PAYLOAD_BYTES);
  await db.execute(sql`select pg_notify('mymandev_bound_check', ${longest})`);
  await assert.rejects(
    db.execute(sql`select pg_notify('mymandev_bound_check', ${`${longest}x`})`),
  );
});

test("the largest notification of each kind stays within the bound, and one over it throws instead of being sent", () => {
  const at = new Date("2026-11-25T23:59:59.999Z");
  const approvers = Array.from({ length: 250 }, () => newId<MemberId>());
  const workspaceId = newId<WorkspaceId>();
  const notifications = erasureNotifications({
    userId: newId<UserId>(),
    now: at,
    endedMemberships: [
      {
        workspaceId,
        memberId: newId<MemberId>(),
        disabledAgents: [
          {
            workspaceId,
            agent: {
              id: newId<AgentId>(),
              projectId: newId<ProjectId>(),
              name: "A name that never travels",
              ownerMemberId: newId<MemberId>(),
              disabledAt: at.toISOString(),
            },
          },
        ],
        revokedGrants: [
          {
            grantId: newId<PermissionGrantId>(),
            granteeAgentId: newId<AgentId>(),
            workspaceId,
            revokedAt: at,
          },
        ],
        cancelledRuns: [
          {
            runId: newId<RunId>(),
            agentId: newId<AgentId>(),
            projectId: newId<ProjectId>(),
            workspaceId,
            repositoryId: newId<RepositoryId>(),
            correlationId: newId<CorrelationId>(),
            previousState: "awaiting_input",
            reason: "member_removed",
          },
        ],
      },
    ],
    revokedDevices: [],
    withdrawnJoinRequests: [
      {
        workspaceId: newId<WorkspaceId>(),
        joinRequestId: newId<JoinRequestId>(),
        approvers,
      },
    ],
    archivedWorkspaceIds: [newId<WorkspaceId>()],
  });
  assert.deepEqual(
    notifications.map((notification) => notification.kind),
    [
      "account_erased",
      "membership_ended",
      "agent_disabled",
      "grant_revoked",
      "run_cancelled",
      "join_request_withdrawn",
      "join_request_withdrawn",
      "join_request_withdrawn",
    ],
  );
  const withdrawals = notifications.flatMap((notification) =>
    notification.kind === "join_request_withdrawn"
      ? [notification.approvers]
      : [],
  );
  assert.deepEqual(
    withdrawals.map((chunk) => chunk.length),
    [100, 100, 50],
  );
  assert.deepEqual(withdrawals.flat(), approvers);
  for (const notification of notifications) {
    const payload = encodeErasureNotification(notification);
    assert.ok(
      Buffer.byteLength(payload) <= 4_200,
      `${notification.kind}: ${Buffer.byteLength(payload)} bytes`,
    );
    assert.equal(payload.includes("A name that never travels"), false);
  }
  assert.throws(
    () =>
      encodeErasureNotification({
        v: 1,
        kind: "join_request_withdrawn",
        at: at.toISOString(),
        userId: newId<UserId>(),
        workspaceId: newId<WorkspaceId>(),
        joinRequestId: newId<JoinRequestId>(),
        approvers: Array.from({ length: 250 }, () => newId<MemberId>()),
      }),
    /over 7999 bytes/,
  );
});

// The API's check of a notification against the database
// (`src/erasure-check.ts`; Project Manager decision of 2026-11-25): any role
// that can connect can send on the channel, so only what the database
// confirms is replayed.

test("the database confirms every notification of a real erasure, with the account's revoked devices and the current approvers; it confirms none for an account that is not erased, none for an item of another account, and none with another workspace", async () => {
  const db = database();
  const owner = await account("Olga");
  const erin = await account("Erin");
  const bob = await account("Bob");
  const mia = await account("Mia");
  const team = await workspaceOf(owner);
  const other = await workspaceOf(owner);
  const asked = await workspaceOf(owner);
  const erinInTeam = await addPerson(team.workspaceId, owner, erin);
  const bobInTeam = await addPerson(team.workspaceId, owner, bob);
  const miaAdmin = await addPerson(asked.workspaceId, owner, mia, {
    role: "admin",
  });
  const plainMember = await addPerson(asked.workspaceId, owner, bob);
  const project = await projectIn(team.workspaceId, owner);
  const erinsAgent = await agentOf(project, erin);
  await grantTo(project, erinsAgent, erin);
  await runOf(project, erinsAgent, "queued", owner);
  const bobsAgent = await agentOf(project, bob);
  await runOf(project, bobsAgent, "queued", erin);
  await pendingRequest(erin, asked.workspaceId);

  // Bob's items in the states that an erasure leaves, written directly:
  // they belong to no erasure, as Bob is not erased.
  const bobGone = await addPerson(other.workspaceId, owner, bob, {
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const bobsOldAgent = await agentOf(project, bob);
  await db
    .update(agents)
    .set({ disabledAt: NOW })
    .where(eq(agents.id, bobsOldAgent));
  const bobsOldGrant = await grantTo(project, bobsOldAgent, bob);
  await db
    .update(permissionGrants)
    .set({ revokedAt: NOW, revokedByUserId: bob.userId })
    .where(eq(permissionGrants.id, bobsOldGrant));
  const bobsCancelledRun = await runOf(
    project,
    bobsOldAgent,
    "cancelled",
    bob,
    {
      finishedAt: NOW,
    },
  );
  const bobsRequest = await pendingRequest(bob, asked.workspaceId);
  await db
    .update(workspaceJoinRequests)
    .set({ decision: "withdrawn", decidedAt: NOW, decidedByUserId: bob.userId })
    .where(eq(workspaceJoinRequests.id, bobsRequest));

  await drained();
  const result = await eraseAccount(db, {
    userId: erin.userId,
    now: ERASED_AT,
  });
  assert.ok(result.erased);
  const notified = await drained();
  assert.deepEqual(
    notified.map((notification) => notification.kind),
    [
      "account_erased",
      "membership_ended",
      "agent_disabled",
      "grant_revoked",
      "run_cancelled",
      "run_cancelled",
      "join_request_withdrawn",
    ],
  );

  // Every notification of the erasure is confirmed.
  for (const notification of notified) {
    const check = await checkErasureNotification(db, notification);
    assert.equal(check.confirmed, true, notification.kind);
    assert.deepEqual(
      check.revokedDeviceIds,
      notification.kind === "account_erased" ? [erin.deviceId] : [],
    );
    assert.deepEqual(check.disabledAccountDeviceIds, []);
    assert.deepEqual(
      check.approvers,
      notification.kind === "join_request_withdrawn"
        ? inOrder(asked.ownerPerson, miaAdmin)
        : [],
    );
  }

  // The same notifications naming Bob, who is not erased, or an account
  // that does not exist, are confirmed by none, also when Bob has a revoked
  // device.
  const bobsRevoked = await deviceOf(bob.userId);
  await db
    .update(devices)
    .set({ revokedAt: NOW, revocationReason: "removed" })
    .where(eq(devices.id, bobsRevoked));
  for (const userId of [bob.userId, newId<UserId>()]) {
    for (const notification of notified) {
      const check = await checkErasureNotification(db, {
        ...notification,
        userId,
      });
      assert.deepEqual(
        check,
        {
          confirmed: false,
          revokedDeviceIds: [],
          disabledAccountDeviceIds: [],
          approvers: [],
        },
        `${notification.kind} naming another account`,
      );
    }
  }

  // Notifications that name Erin, whose erasure is real, but an item that
  // is not hers are confirmed by none: Bob's items in the erasure's states,
  // and Erin's agent with another owner's person or in another workspace.
  // Each of Erin's real notifications with another workspace is confirmed
  // by none either.
  const at = ERASED_AT.toISOString();
  const forged: ErasureNotification[] = [
    {
      ...header("membership_ended", erin.userId),
      workspaceId: other.workspaceId,
      memberId: bobGone,
    },
    {
      ...header("agent_disabled", erin.userId),
      workspaceId: team.workspaceId,
      agentId: bobsOldAgent,
      projectId: project.projectId,
      ownerMemberId: bobInTeam,
      disabledAt: at,
    },
    {
      ...header("agent_disabled", erin.userId),
      workspaceId: team.workspaceId,
      agentId: erinsAgent,
      projectId: project.projectId,
      ownerMemberId: bobInTeam,
      disabledAt: at,
    },
    {
      ...header("agent_disabled", erin.userId),
      workspaceId: other.workspaceId,
      agentId: erinsAgent,
      projectId: project.projectId,
      ownerMemberId: erinInTeam,
      disabledAt: at,
    },
    {
      ...header("grant_revoked", erin.userId),
      workspaceId: team.workspaceId,
      grantId: bobsOldGrant,
      granteeAgentId: bobsOldAgent,
      revokedAt: at,
    },
    {
      ...header("run_cancelled", erin.userId),
      workspaceId: team.workspaceId,
      runId: bobsCancelledRun,
      agentId: bobsOldAgent,
      projectId: project.projectId,
      repositoryId: null,
      correlationId: null,
      previousState: "queued",
      reason: "member_removed",
    },
    {
      ...header("join_request_withdrawn", erin.userId),
      workspaceId: asked.workspaceId,
      joinRequestId: bobsRequest,
      approvers: [asked.ownerPerson],
    },
    ...notified
      .filter(
        (notification) =>
          notification.kind !== "account_erased" &&
          notification.kind !== "agent_disabled",
      )
      .map((notification) => ({
        ...notification,
        workspaceId: other.workspaceId,
      })),
  ] as ErasureNotification[];
  assert.deepEqual(
    forged.slice(-5).map((notification) => notification.kind),
    [
      "membership_ended",
      "grant_revoked",
      "run_cancelled",
      "run_cancelled",
      "join_request_withdrawn",
    ],
  );
  for (const notification of forged) {
    assert.deepEqual(
      await checkErasureNotification(db, notification),
      {
        confirmed: false,
        revokedDeviceIds: [],
        disabledAccountDeviceIds: [],
        approvers: [],
      },
      notification.kind,
    );
  }

  // A real withdrawal sends only to the named people who are an active
  // owner or admin of its workspace now.
  const withdrawal = notified.at(-1);
  assert.ok(withdrawal?.kind === "join_request_withdrawn");
  await db
    .update(workspaceMembers)
    .set({ removedAt: NOW, removedByUserId: owner.userId })
    .where(eq(workspaceMembers.id, miaAdmin));
  const narrowed = await checkErasureNotification(db, {
    ...withdrawal,
    approvers: [miaAdmin, plainMember, bobInTeam, asked.ownerPerson],
  });
  assert.equal(narrowed.confirmed, true);
  assert.deepEqual(narrowed.approvers, [asked.ownerPerson]);

  // A device of Erin's that is not revoked, which only data written outside
  // the functions has, is never one to close.
  await deviceOf(erin.userId);
  const erased = notified[0];
  assert.ok(erased !== undefined);
  const accountCheck = await checkErasureNotification(db, erased);
  assert.deepEqual(accountCheck.revokedDeviceIds, [erin.deviceId]);
});

// The session that listens (`src/notification-session.ts`): what it
// delivers, that `close` ends it, and, on a server, that a session that the
// server ends reports its loss once.

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await delay(5);
  }
}

async function notify(channel: string, payload: string): Promise<void> {
  assert.ok(testDatabase);
  await testDatabase.client.query("select pg_notify($1, $2)", [
    channel,
    payload,
  ]);
}

test("a session delivers the payloads of its channel in order, none of another channel, and none after close", async () => {
  assert.ok(testDatabase);
  const session = await testDatabase.notificationSessions();
  const received: string[] = [];
  let lost = 0;
  await session.listen("mymandev_session_test", {
    onPayload: (payload) => received.push(payload),
    onLost: () => {
      lost += 1;
    },
  });
  await notify("mymandev_session_test", "one");
  await notify("mymandev_other_channel", "elsewhere");
  await notify("mymandev_session_test", "two");
  await until(() => received.length === 2, "two payloads");
  await session.close();
  await notify("mymandev_session_test", "after close");
  await delay(50);
  assert.deepEqual(received, ["one", "two"]);
  assert.equal(lost, 0);
});

test("a channel that is not a lowercase SQL identifier is refused before it reaches LISTEN", () => {
  for (const channel of ["", "Upper", "1st", "a b", "x;drop", "a".repeat(64)]) {
    assert.throws(() => checkChannel(channel), /lowercase SQL identifier/);
  }
  checkChannel("mymandev_account_erasure");
});

const SERVER_ONLY = {
  skip:
    process.env["DATABASE_TEST_URL"] === undefined &&
    "needs DATABASE_TEST_URL; a PGlite session is never lost",
};

test(
  "a server session that the server ends reports its loss once and refuses to listen again; one that closes reports nothing; one that cannot connect rejects",
  SERVER_ONLY,
  async () => {
    assert.ok(testDatabase?.url);
    const sessions = pgNotificationSessions(testDatabase.url);
    const session = await sessions();
    let lost = 0;
    const received: string[] = [];
    await session.listen("mymandev_session_test", {
      onPayload: (payload) => received.push(payload),
      onLost: () => {
        lost += 1;
      },
    });
    await notify("mymandev_session_test", "before");
    await until(() => received.length === 1, "the payload");
    const { rows } = await testDatabase.client.query<{ ended: boolean }>(
      "select pg_terminate_backend(pid) as ended from pg_stat_activity where datname = current_database() and application_name = $1 and query = $2",
      [LISTENER_APPLICATION_NAME, "listen mymandev_session_test"],
    );
    assert.deepEqual(rows, [{ ended: true }]);
    await until(() => lost === 1, "the loss");
    await assert.rejects(
      session.listen("mymandev_session_test", {
        onPayload: () => undefined,
        onLost: () => undefined,
      }),
    );
    await session.close();
    await delay(50);
    assert.equal(lost, 1);

    const closing = await sessions();
    let closedLost = 0;
    await closing.listen("mymandev_session_test", {
      onPayload: () => undefined,
      onLost: () => {
        closedLost += 1;
      },
    });
    await closing.close();
    await delay(50);
    assert.equal(closedLost, 0);
    const open = await testDatabase.client.query<{ sessions: number }>(
      "select count(*)::int as sessions from pg_stat_activity where datname = current_database() and application_name = $1 and query = $2",
      [LISTENER_APPLICATION_NAME, "listen mymandev_session_test"],
    );
    assert.deepEqual(open.rows, [{ sessions: 0 }]);

    const url = new URL(testDatabase.url);
    url.port = "1";
    await assert.rejects(pgNotificationSessions(url.href)());
  },
);
