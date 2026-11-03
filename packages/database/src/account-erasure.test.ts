import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentId,
  type DeviceId,
  type InvitationId,
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
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  ARCHIVED_PROJECT_NAME,
  ARCHIVED_REPOSITORY_NAME,
  ARCHIVED_WORKSPACE_NAME,
  ERASED_AGENT_NAME,
  ERASED_DEVICE_LABEL,
  ERASED_DISPLAY_NAME,
  eraseAccount,
} from "./account-erasure.ts";
import { enableAccount } from "./account-status.ts";
import { createDatabase } from "./client.ts";
import type { Database } from "./db.ts";
import {
  acceptInvitation,
  createInvitation,
  previewInvitation,
} from "./invitations.ts";
import {
  approveJoinRequest,
  blockJoinRequest,
  createJoinRequest,
  pauseJoinRequests,
} from "./join-requests.ts";
import { createWorkspace } from "./membership.ts";
import {
  agentRuns,
  agents,
  auditEvents,
  devices,
  permissionGrants,
  projects,
  repositories,
  userIdentities,
  users,
  workspaceInvitations,
  workspaceJoinRequests,
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
const NOW = new Date("2026-11-02T12:00:00.000Z");
const ERASED_AT = new Date("2026-11-02T13:00:00.000Z");
const LATER = new Date("2026-11-02T14:00:00.000Z");
// Each test that reads the audit records of one moment has a moment of its own.
const REFUSED_AT = new Date("2026-11-02T15:00:00.000Z");
const ROLLED_BACK_AT = new Date("2026-11-02T16:00:00.000Z");
const DISABLED_ERASED_AT = new Date("2026-11-02T17:00:00.000Z");
const BLOCKED_ERASED_AT = new Date("2026-11-02T18:00:00.000Z");
const ENABLE_REFUSED_AT = new Date("2026-11-02T19:00:00.000Z");
const ARCHIVED_AT = new Date("2026-11-02T20:00:00.000Z");
const GITHUB_CREATED = new Date("2015-06-01T10:00:00.000Z");

type Account = Readonly<{
  userId: UserId;
  deviceId: DeviceId;
  subject: string;
}>;

let nextSubject = 9_100_000;

/** A device of the account, not revoked unless `values` says so. */
async function deviceOf(
  userId: UserId,
  values: Partial<typeof devices.$inferInsert> = {},
): Promise<DeviceId> {
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
      ...values,
    });
  return id;
}

/** An account with one device and a GitHub identity, as a sign-in creates them. */
async function account(name: string): Promise<Account> {
  const db = database();
  const userId = newId<UserId>();
  await db.insert(users).values({ id: userId, displayName: name });
  nextSubject += 1;
  const subject = String(nextSubject);
  await db.insert(userIdentities).values({
    id: newUuidV7(),
    userId,
    identityProvider: "github",
    subject,
    login: `user-${subject}`,
    accountCreatedAt: GITHUB_CREATED,
    lastSignInAt: NOW,
  });
  return { userId, deviceId: await deviceOf(userId), subject };
}

/** A workspace of `owner`, with the owner's person. */
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

/** Adds a person; claimed by `claimedBy` if given, unclaimed otherwise. */
async function addPerson(
  workspaceId: WorkspaceId,
  addedBy: Account,
  values: Partial<typeof workspaceMembers.$inferInsert> & {
    claimedBy?: Account;
  } = {},
): Promise<MemberId> {
  const { claimedBy, ...rest } = values;
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
      ...(claimedBy === undefined
        ? {}
        : { userId: claimedBy.userId, claimedAt: NOW }),
      ...rest,
    });
  return id;
}

/** An invitation for the person, created at `NOW` and live for 7 days. */
async function invite(
  workspaceId: WorkspaceId,
  memberId: MemberId,
  createdBy: Account,
  tokenHash = randomBytes(32).toString("hex"),
): Promise<InvitationId> {
  const id = newId<InvitationId>();
  await database()
    .insert(workspaceInvitations)
    .values({
      id,
      workspaceId,
      memberId,
      tokenHash,
      createdByUserId: createdBy.userId,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 168 * HOUR_MS),
    });
  return id;
}

/** A pending join request of the account, made with `createJoinRequest`. */
async function requested(
  who: Account,
  workspaceId: WorkspaceId,
): Promise<JoinRequestId> {
  const result = await createJoinRequest(database(), {
    workspaceId,
    userId: who.userId,
    deviceId: who.deviceId,
    displayName: "Erin Example",
    now: NOW,
  });
  assert.ok(result.requested && result.created);
  return result.joinRequest.id;
}

type Project = Readonly<{ projectId: ProjectId; repositoryId: RepositoryId }>;

/**
 * A project of the workspace with one repository. Project names are unique
 * in a workspace, so a second project there needs another `name`.
 */
async function projectIn(
  workspaceId: WorkspaceId,
  by: Account,
  name = "App",
): Promise<Project> {
  const projectId = newId<ProjectId>();
  await database().insert(projects).values({
    id: projectId,
    workspaceId,
    name,
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

/** An agent of the account in the project, on `hostDeviceId` or the account's first device. */
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
    name: "Builder",
  });
  return id;
}

/** A grant of `repo.read` on the project's repository to the agent, by its owner. */
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

/** A run of the agent that `requestedBy` asked for. */
async function runOf(
  project: Project,
  agentId: AgentId,
  state: RunState,
  requestedBy: Account,
): Promise<RunId> {
  const id = newId<RunId>();
  const finished =
    state === "completed" || state === "failed" || state === "cancelled";
  await database()
    .insert(agentRuns)
    .values({
      id,
      agentId,
      projectId: project.projectId,
      requestedByUserId: requestedBy.userId,
      state,
      ...(finished ? { finishedAt: NOW } : {}),
    });
  return id;
}

async function rowOf<T>(rows: Promise<T[]>): Promise<T> {
  const [row] = await rows;
  assert.ok(row !== undefined);
  return row;
}

const userRow = (id: UserId) =>
  rowOf(database().select().from(users).where(eq(users.id, id)));
const identityRow = (userId: UserId) =>
  rowOf(
    database()
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId)),
  );
const personRow = (id: MemberId) =>
  rowOf(
    database()
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, id)),
  );
const deviceRow = (id: DeviceId) =>
  rowOf(database().select().from(devices).where(eq(devices.id, id)));
const requestRow = (id: JoinRequestId) =>
  rowOf(
    database()
      .select()
      .from(workspaceJoinRequests)
      .where(eq(workspaceJoinRequests.id, id)),
  );
const agentRow = (id: AgentId) =>
  rowOf(database().select().from(agents).where(eq(agents.id, id)));
const grantRow = (id: PermissionGrantId) =>
  rowOf(
    database()
      .select()
      .from(permissionGrants)
      .where(eq(permissionGrants.id, id)),
  );
const runRow = (id: RunId) =>
  rowOf(database().select().from(agentRuns).where(eq(agentRuns.id, id)));
const invitationRow = (id: InvitationId) =>
  rowOf(
    database()
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, id)),
  );
const workspaceRow = (id: WorkspaceId) =>
  rowOf(database().select().from(workspaces).where(eq(workspaces.id, id)));

/** The audit records written at `at`, as comparable tuples in a fixed order. */
async function auditAt(at: Date) {
  const rows = await database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.createdAt, at));
  return rows
    .map((row) => [
      row.action,
      row.actorUserId,
      row.actorDeviceId,
      row.workspaceId,
      row.subjectId,
      row.reason,
    ])
    .sort((a, b) => String(a).localeCompare(String(b)));
}

function byId<T extends string>(ids: readonly T[]): T[] {
  return [...ids].sort();
}

test("an account that owns a workspace with another active, claimed person is refused with that workspace only, also when it owns another alone and is a member elsewhere, and nothing changes", async () => {
  const owner = await account("Owner");
  const other = await account("Other owner");
  const mia = await account("Mia");
  const owned = await workspaceOf(owner);
  const alone = await workspaceOf(owner);
  const elsewhere = await workspaceOf(other);
  await addPerson(owned.workspaceId, owner, { claimedBy: mia });
  // Neither an unclaimed nor a removed person can take over ownership.
  const unclaimed = await addPerson(alone.workspaceId, owner);
  await addPerson(alone.workspaceId, owner, {
    claimedBy: mia,
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const person = await addPerson(elsewhere.workspaceId, other, {
    claimedBy: owner,
    displayName: "Olga",
  });

  assert.deepEqual(
    await eraseAccount(database(), { userId: owner.userId, now: REFUSED_AT }),
    {
      erased: false,
      refusal: "owner",
      ownedWorkspaceIds: [owned.workspaceId],
    },
  );
  const identity = await identityRow(owner.userId);
  assert.equal(identity.subject, owner.subject);
  assert.equal(identity.erasedAt, null);
  const user = await userRow(owner.userId);
  assert.equal(user.displayName, "Owner");
  assert.equal(user.disabledAt, null);
  assert.equal((await personRow(person)).removedAt, null);
  assert.equal((await personRow(person)).displayName, "Olga");
  for (const { workspaceId, ownerPerson } of [owned, alone]) {
    const row = await personRow(ownerPerson);
    assert.equal(row.role, "owner");
    assert.equal(row.removedAt, null);
    const workspace = await workspaceRow(workspaceId);
    assert.equal(workspace.archivedAt, null);
    assert.equal(workspace.name, "Team");
  }
  assert.equal((await personRow(unclaimed)).displayName, "Someone");
  const device = await deviceRow(owner.deviceId);
  assert.equal(device.revokedAt, null);
  assert.equal(device.label, "Laptop");
  assert.deepEqual(await auditAt(REFUSED_AT), []);
});

test("an unknown account and an account without a GitHub identity are not_found", async () => {
  assert.deepEqual(
    await eraseAccount(database(), { userId: newId<UserId>(), now: NOW }),
    { erased: false, refusal: "not_found" },
  );
  const userId = newId<UserId>();
  await database()
    .insert(users)
    .values({ id: userId, displayName: "Nameless" });
  assert.deepEqual(await eraseAccount(database(), { userId, now: NOW }), {
    erased: false,
    refusal: "not_found",
  });
  assert.equal((await userRow(userId)).displayName, "Nameless");
});

test("an erasure ends each membership as a removal does, revokes every device with account_erased, ends the join requests, and erases the identity and the names, audited without an actor; a second erasure changes nothing", async () => {
  const db = database();
  const owner = await account("Owner");
  const erased = await account("Erin");
  const other = await account("Mia");
  const first = await workspaceOf(owner);
  const second = await workspaceOf(owner);
  const former = await workspaceOf(owner);
  const asked = await workspaceOf(owner);
  const lapsedIn = await workspaceOf(owner);
  const deniedIn = await workspaceOf(owner);

  // The account is an admin of the first workspace, a member with an
  // ownership offer in the second, and a former member of a third.
  const adminPerson = await addPerson(first.workspaceId, owner, {
    claimedBy: erased,
    role: "admin",
    displayName: "Erin the admin",
  });
  const memberPerson = await addPerson(second.workspaceId, owner, {
    claimedBy: erased,
    displayName: "Erin",
    ownershipOfferedAt: NOW,
  });
  const formerPerson = await addPerson(former.workspaceId, owner, {
    claimedBy: erased,
    displayName: "Erin before",
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const otherPerson = await addPerson(first.workspaceId, owner, {
    claimedBy: other,
    displayName: "Mia",
  });
  // An invitation that the account created, and one that the owner created.
  const invited = await addPerson(first.workspaceId, owner);
  const invitedByErased = await invite(first.workspaceId, invited, erased);
  const stays = await addPerson(first.workspaceId, owner);
  const invitedByOwner = await invite(first.workspaceId, stays, owner);

  // A pending request, one past its expiry without a decision, and a denied
  // one; and another account's pending request.
  const pending = await requested(erased, asked.workspaceId);
  const othersRequest = await requested(other, asked.workspaceId);
  const lapsed = newId<JoinRequestId>();
  const lapsedExpiry = new Date(NOW.getTime() - 2 * HOUR_MS);
  const denied = newId<JoinRequestId>();
  await db.insert(workspaceJoinRequests).values([
    {
      id: lapsed,
      workspaceId: lapsedIn.workspaceId,
      requesterUserId: erased.userId,
      requesterDeviceId: erased.deviceId,
      requestedDisplayName: "Erin Lapsed",
      createdAt: new Date(lapsedExpiry.getTime() - 168 * HOUR_MS),
      expiresAt: lapsedExpiry,
    },
    {
      id: denied,
      workspaceId: deniedIn.workspaceId,
      requesterUserId: erased.userId,
      requesterDeviceId: erased.deviceId,
      requestedDisplayName: "Erin Denied",
      createdAt: new Date(NOW.getTime() - 3 * HOUR_MS),
      expiresAt: new Date(NOW.getTime() + 165 * HOUR_MS),
      decision: "denied",
      decidedAt: new Date(NOW.getTime() - HOUR_MS),
      decidedByUserId: owner.userId,
    },
  ]);

  // Agents, grants, and runs in the first workspace.
  const project = await projectIn(first.workspaceId, owner);
  const erasedAgent = await agentOf(project, erased);
  const erasedGrant = await grantTo(project, erasedAgent, erased);
  const ownerAgent = await agentOf(project, owner);
  const ownerGrant = await grantTo(project, ownerAgent, owner);
  const onErasedAgent = await runOf(project, erasedAgent, "queued", owner);
  const requestedByErased = await runOf(project, ownerAgent, "running", erased);
  const finished = await runOf(project, erasedAgent, "completed", owner);
  const ownersRun = await runOf(project, ownerAgent, "running", owner);

  // A second device hosts an agent in the former workspace that no removal
  // reaches, which only data written outside these functions has, and a
  // third device was revoked before.
  const secondDevice = await deviceOf(erased.userId);
  const revokedBefore = await deviceOf(erased.userId, {
    revokedAt: NOW,
    revocationReason: "removed",
  });
  const formerProject = await projectIn(former.workspaceId, owner);
  const strayAgent = await agentOf(formerProject, erased, secondDevice);
  const strayGrant = await grantTo(
    formerProject,
    strayAgent,
    erased,
    secondDevice,
  );
  const strayRun = await runOf(
    formerProject,
    strayAgent,
    "awaiting_input",
    erased,
  );

  const result = await eraseAccount(db, {
    userId: erased.userId,
    now: ERASED_AT,
  });
  assert.ok(result.erased);

  // The memberships end as removals with the account as the remover.
  assert.deepEqual(
    result.endedMemberships.map((end) => end.memberId),
    byId([adminPerson, memberPerson]),
  );
  const [adminEnd] = result.endedMemberships.filter(
    (end) => end.memberId === adminPerson,
  );
  assert.ok(adminEnd);
  assert.equal(adminEnd.userId, erased.userId);
  assert.deepEqual(adminEnd.revokedInvitationIds, [invitedByErased]);
  assert.deepEqual(adminEnd.disabledAgentIds, [erasedAgent]);
  assert.deepEqual(adminEnd.revokedGrantIds, [erasedGrant]);
  assert.deepEqual(
    adminEnd.cancelledRuns.map((run) => [
      run.runId,
      run.previousState,
      run.reason,
    ]),
    [
      [onErasedAgent, "queued", "member_removed"],
      [requestedByErased, "running", "member_removed"],
    ].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
  );
  for (const id of [adminPerson, memberPerson]) {
    const row = await personRow(id);
    assert.deepEqual(row.removedAt, ERASED_AT);
    assert.equal(row.removedByUserId, erased.userId);
    assert.equal(row.ownershipOfferedAt, null);
  }
  // The ownership offer to the erased person ends as a removal ends it: the
  // second workspace keeps its owner and has no offer left.
  const offers = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, second.workspaceId),
        isNotNull(workspaceMembers.ownershipOfferedAt),
      ),
    );
  assert.deepEqual(offers, []);
  const secondOwner = await personRow(second.ownerPerson);
  assert.equal(secondOwner.role, "owner");
  assert.equal(secondOwner.removedAt, null);
  const formerRow = await personRow(formerPerson);
  assert.deepEqual(formerRow.removedAt, NOW, "an earlier removal stays");
  assert.equal(formerRow.removedByUserId, owner.userId);
  for (const id of [adminPerson, memberPerson, formerPerson]) {
    assert.equal((await personRow(id)).displayName, ERASED_DISPLAY_NAME);
  }
  const revokedInvitation = await invitationRow(invitedByErased);
  assert.deepEqual(revokedInvitation.revokedAt, ERASED_AT);
  assert.equal(revokedInvitation.revokedByUserId, erased.userId);
  assert.equal((await grantRow(erasedGrant)).revokedByUserId, erased.userId);
  assert.equal((await runRow(onErasedAgent)).stateReason, "member_removed");

  // Every device that was not revoked is revoked with account_erased; the
  // second one also ends what no removal reached, with device_revoked.
  assert.deepEqual(
    result.revokedDevices.map((device) => device.deviceId),
    byId([erased.deviceId, secondDevice]),
  );
  const [secondEnd] = result.revokedDevices.filter(
    (device) => device.deviceId === secondDevice,
  );
  assert.deepEqual(secondEnd, {
    deviceId: secondDevice,
    disabledAgentIds: [strayAgent],
    revokedGrantIds: [strayGrant],
    cancelledRuns: [
      {
        runId: strayRun,
        agentId: strayAgent,
        projectId: formerProject.projectId,
        workspaceId: former.workspaceId,
        repositoryId: null,
        correlationId: null,
        previousState: "awaiting_input",
        reason: "device_revoked",
      },
    ],
  });
  for (const id of [erased.deviceId, secondDevice]) {
    const row = await deviceRow(id);
    assert.deepEqual(row.revokedAt, ERASED_AT);
    assert.equal(row.revocationReason, "account_erased");
  }
  const before = await deviceRow(revokedBefore);
  assert.deepEqual(before.revokedAt, NOW);
  assert.equal(before.revocationReason, "removed");

  // The labels of every device of the account, the one revoked before too,
  // and the names of every agent that it owns, which can hold personal data,
  // are replaced.
  for (const id of [erased.deviceId, secondDevice, revokedBefore]) {
    const row = await deviceRow(id);
    assert.equal(row.label, ERASED_DEVICE_LABEL);
    assert.deepEqual(row.updatedAt, ERASED_AT);
  }
  for (const id of [erasedAgent, strayAgent]) {
    const row = await agentRow(id);
    assert.equal(row.name, ERASED_AGENT_NAME);
    assert.deepEqual(row.updatedAt, ERASED_AT);
  }
  assert.deepEqual(result.archivedWorkspaces, []);

  // The join requests: the pending one withdrawn by the account, the lapsed
  // one marked expired, the denied one kept; every name replaced.
  assert.deepEqual(result.withdrawnJoinRequestIds, [pending]);
  const withdrawn = await requestRow(pending);
  assert.equal(withdrawn.decision, "withdrawn");
  assert.deepEqual(withdrawn.decidedAt, ERASED_AT);
  assert.equal(withdrawn.decidedByUserId, erased.userId);
  const expired = await requestRow(lapsed);
  assert.equal(expired.decision, "expired");
  assert.deepEqual(expired.decidedAt, lapsedExpiry);
  assert.equal(expired.decidedByUserId, null);
  const deniedRow = await requestRow(denied);
  assert.equal(deniedRow.decision, "denied");
  assert.equal(deniedRow.decidedByUserId, owner.userId);
  for (const id of [pending, lapsed, denied]) {
    assert.equal(
      (await requestRow(id)).requestedDisplayName,
      ERASED_DISPLAY_NAME,
    );
  }
  // An erased account's request can no longer be approved.
  assert.deepEqual(
    await approveJoinRequest(db, {
      workspaceId: asked.workspaceId,
      joinRequestId: pending,
      ...owner,
      now: LATER,
    }),
    { approved: false, refusal: "conflict" },
  );

  // The identity and the account.
  const identity = await identityRow(erased.userId);
  assert.equal(identity.subject, null);
  assert.equal(identity.login, null);
  assert.equal(identity.accountCreatedAt, null);
  assert.deepEqual(identity.erasedAt, ERASED_AT);
  const user = await userRow(erased.userId);
  assert.equal(user.displayName, ERASED_DISPLAY_NAME);
  assert.deepEqual(user.disabledAt, ERASED_AT);

  // Every audit record of the erasure has no actor.
  assert.deepEqual(
    await auditAt(ERASED_AT),
    [
      ["account.erased", null, null, null, erased.userId, null],
      ["device.revoked", null, null, null, erased.deviceId, "account_erased"],
      ["device.revoked", null, null, null, secondDevice, "account_erased"],
      [
        "invitation.revoked",
        null,
        null,
        first.workspaceId,
        invitedByErased,
        "member_removed",
      ],
      [
        "join_request.withdrawn",
        null,
        null,
        asked.workspaceId,
        pending,
        "account_erased",
      ],
      [
        "member.removed",
        null,
        null,
        first.workspaceId,
        adminPerson,
        "account_erased",
      ],
      [
        "member.removed",
        null,
        null,
        second.workspaceId,
        memberPerson,
        "account_erased",
      ],
    ].sort((a, b) => String(a).localeCompare(String(b))),
  );

  // Nothing outside the account changed.
  const ownerIdentity = await identityRow(owner.userId);
  assert.equal(ownerIdentity.subject, owner.subject);
  assert.equal(ownerIdentity.erasedAt, null);
  assert.equal((await userRow(other.userId)).displayName, "Mia");
  for (const who of [owner, other]) {
    assert.equal((await deviceRow(who.deviceId)).revokedAt, null);
  }
  const otherRow = await personRow(otherPerson);
  assert.equal(otherRow.removedAt, null);
  assert.equal(otherRow.displayName, "Mia");
  assert.equal((await invitationRow(invitedByOwner)).revokedAt, null);
  assert.equal((await requestRow(othersRequest)).decision, null);
  assert.equal(
    (await requestRow(othersRequest)).requestedDisplayName,
    "Erin Example",
  );
  assert.equal((await agentRow(ownerAgent)).disabledAt, null);
  assert.equal((await agentRow(ownerAgent)).name, "Builder");
  assert.equal((await deviceRow(owner.deviceId)).label, "Laptop");
  assert.equal((await grantRow(ownerGrant)).revokedAt, null);
  assert.equal((await runRow(ownersRun)).state, "running");
  assert.equal((await runRow(finished)).state, "completed");
  assert.equal((await personRow(first.ownerPerson)).removedAt, null);

  // A second erasure changes nothing and writes nothing.
  assert.deepEqual(
    await eraseAccount(db, { userId: erased.userId, now: LATER }),
    { erased: false, refusal: "already_erased" },
  );
  assert.deepEqual(await auditAt(LATER), []);
  assert.deepEqual((await userRow(erased.userId)).updatedAt, ERASED_AT);
  assert.deepEqual((await identityRow(erased.userId)).erasedAt, ERASED_AT);
});

test("the owner of workspaces without another active, claimed person is erased: each is archived, its open invitations revoked, the pending requests of other accounts denied, and the owner made a member and removed, audited with account_erased", async () => {
  const db = database();
  const erased = await account("Ayla");
  const guest = await account("Gus");
  const asker = await account("Ari");
  const lapsedAsker = await account("Lou");
  const other = await account("Mia");
  const team = await workspaceOf(erased);
  const solo = await workspaceOf(erased);
  const elsewhere = await workspaceOf(other);

  // The team keeps an unclaimed person with a live invitation, another with
  // an invitation past its expiry that nobody revoked, and a former member.
  const unclaimed = await addPerson(team.workspaceId, erased);
  const tokenHash = randomBytes(32).toString("hex");
  const live = await invite(team.workspaceId, unclaimed, erased, tokenHash);
  const lapsedPerson = await addPerson(team.workspaceId, erased);
  const expiredInvitation = newId<InvitationId>();
  await db.insert(workspaceInvitations).values({
    id: expiredInvitation,
    workspaceId: team.workspaceId,
    memberId: lapsedPerson,
    tokenHash: randomBytes(32).toString("hex"),
    createdByUserId: erased.userId,
    createdAt: new Date(NOW.getTime() - 200 * HOUR_MS),
    expiresAt: new Date(NOW.getTime() - 32 * HOUR_MS),
  });
  const former = await addPerson(team.workspaceId, erased, {
    claimedBy: other,
    displayName: "Mia",
    removedAt: NOW,
    removedByUserId: erased.userId,
  });
  // A removed unclaimed person, named after someone by the owner.
  const removedUnclaimed = await addPerson(team.workspaceId, erased, {
    displayName: "Ayla's cousin",
    removedAt: NOW,
    removedByUserId: erased.userId,
  });
  // A pending request of another account, and one past its expiry.
  const asked = await requested(asker, team.workspaceId);
  const lapsedRequest = newId<JoinRequestId>();
  await db.insert(workspaceJoinRequests).values({
    id: lapsedRequest,
    workspaceId: team.workspaceId,
    requesterUserId: lapsedAsker.userId,
    requesterDeviceId: lapsedAsker.deviceId,
    requestedDisplayName: "Lou",
    createdAt: new Date(NOW.getTime() - 170 * HOUR_MS),
    expiresAt: new Date(NOW.getTime() - 2 * HOUR_MS),
  });
  // The account is a member elsewhere too.
  const elsewherePerson = await addPerson(elsewhere.workspaceId, other, {
    claimedBy: erased,
  });
  // Its agent in the team, named after the person, with a grant and a run.
  await db
    .update(devices)
    .set({ label: "Ayla's work laptop" })
    .where(eq(devices.id, erased.deviceId));
  const project = await projectIn(team.workspaceId, erased);
  const agent = await agentOf(project, erased);
  await db
    .update(agents)
    .set({ name: "Ayla's builder" })
    .where(eq(agents.id, agent));
  const grant = await grantTo(project, agent, erased);
  const run = await runOf(project, agent, "queued", erased);
  // A second project of the team, and a project elsewhere that stays.
  const soloProject = await projectIn(solo.workspaceId, erased);
  const elsewhereProject = await projectIn(elsewhere.workspaceId, other);
  // Two more projects of the team, one archived before: every project of an
  // archived workspace gets the same placeholder name (#155).
  const teamProject = await projectIn(team.workspaceId, erased, "Website");
  const archivedProject = await projectIn(team.workspaceId, erased, "Old");
  await db
    .update(projects)
    .set({ archivedAt: NOW })
    .where(eq(projects.id, archivedProject.projectId));

  const result = await eraseAccount(db, {
    userId: erased.userId,
    now: ARCHIVED_AT,
  });
  assert.ok(result.erased);
  assert.deepEqual(
    result.archivedWorkspaces,
    [
      {
        workspaceId: team.workspaceId,
        revokedInvitationIds: byId([live, expiredInvitation]),
        deniedJoinRequestIds: [asked],
      },
      {
        workspaceId: solo.workspaceId,
        revokedInvitationIds: [],
        deniedJoinRequestIds: [],
      },
    ].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
  );

  // The workspaces are archived, and nothing is deleted. The names that the
  // owner wrote in them are replaced; the rows and their links stay.
  for (const { workspaceId } of [team, solo]) {
    const row = await workspaceRow(workspaceId);
    assert.deepEqual(row.archivedAt, ARCHIVED_AT);
    assert.deepEqual(row.updatedAt, ARCHIVED_AT);
    assert.equal(row.name, ARCHIVED_WORKSPACE_NAME);
  }
  for (const { projectId, repositoryId } of [
    project,
    soloProject,
    teamProject,
    archivedProject,
  ]) {
    const projectRow = await rowOf(
      db.select().from(projects).where(eq(projects.id, projectId)),
    );
    assert.equal(projectRow.name, ARCHIVED_PROJECT_NAME);
    assert.deepEqual(projectRow.updatedAt, ARCHIVED_AT);
    // The projects are archived with their workspace, an earlier archive kept.
    assert.deepEqual(
      projectRow.archivedAt,
      projectId === archivedProject.projectId ? NOW : ARCHIVED_AT,
    );
    const repositoryRow = await rowOf(
      db.select().from(repositories).where(eq(repositories.id, repositoryId)),
    );
    assert.equal(repositoryRow.name, ARCHIVED_REPOSITORY_NAME);
    assert.equal(repositoryRow.projectId, projectId);
    assert.deepEqual(repositoryRow.updatedAt, ARCHIVED_AT);
  }
  for (const id of [unclaimed, lapsedPerson, removedUnclaimed]) {
    const row = await personRow(id);
    assert.equal(row.displayName, ERASED_DISPLAY_NAME);
    assert.equal(row.workspaceId, team.workspaceId);
    assert.deepEqual(row.updatedAt, ARCHIVED_AT);
  }
  assert.deepEqual((await personRow(removedUnclaimed)).removedAt, NOW);
  // A former member keeps the name of its own account.
  assert.equal((await personRow(former)).displayName, "Mia");
  const elsewhereRow = await workspaceRow(elsewhere.workspaceId);
  assert.equal(elsewhereRow.archivedAt, null);
  assert.equal(elsewhereRow.name, "Team");
  const elsewhereProjectRow = await rowOf(
    db
      .select()
      .from(projects)
      .where(eq(projects.id, elsewhereProject.projectId)),
  );
  assert.equal(elsewhereProjectRow.name, "App");
  assert.equal(elsewhereProjectRow.archivedAt, null);

  // The owner's people are members now, removed as a removal does; an
  // archived workspace has no owner.
  for (const { ownerPerson } of [team, solo]) {
    const row = await personRow(ownerPerson);
    assert.equal(row.role, "member");
    assert.deepEqual(row.removedAt, ARCHIVED_AT);
    assert.equal(row.removedByUserId, erased.userId);
    assert.equal(row.displayName, ERASED_DISPLAY_NAME);
  }
  const owners = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        inArray(workspaceMembers.workspaceId, [
          team.workspaceId,
          solo.workspaceId,
        ]),
        eq(workspaceMembers.role, "owner"),
      ),
    );
  assert.deepEqual(owners, []);
  assert.deepEqual(
    result.endedMemberships.map((end) => end.memberId),
    byId([team.ownerPerson, solo.ownerPerson, elsewherePerson]),
  );
  const [teamEnd] = result.endedMemberships.filter(
    (end) => end.memberId === team.ownerPerson,
  );
  assert.ok(teamEnd);
  // The archive revoked the invitations before the removal.
  assert.deepEqual(teamEnd.revokedInvitationIds, []);
  assert.deepEqual(teamEnd.disabledAgentIds, [agent]);
  assert.deepEqual(teamEnd.revokedGrantIds, [grant]);
  assert.deepEqual(
    teamEnd.cancelledRuns.map((cancelled) => [
      cancelled.runId,
      cancelled.reason,
    ]),
    [[run, "member_removed"]],
  );
  // The unclaimed people and the former member stay as they were.
  for (const id of [unclaimed, lapsedPerson]) {
    const row = await personRow(id);
    assert.equal(row.removedAt, null);
    assert.equal(row.userId, null);
  }
  assert.deepEqual((await personRow(former)).removedAt, NOW);

  for (const id of [live, expiredInvitation]) {
    const row = await invitationRow(id);
    assert.deepEqual(row.revokedAt, ARCHIVED_AT);
    assert.equal(row.revokedByUserId, erased.userId);
  }
  const denied = await requestRow(asked);
  assert.equal(denied.decision, "denied");
  assert.deepEqual(denied.decidedAt, ARCHIVED_AT);
  assert.equal(denied.decidedByUserId, erased.userId);
  assert.equal(denied.requestedDisplayName, "Erin Example");
  const lapsed = await requestRow(lapsedRequest);
  assert.equal(lapsed.decision, null, "a request past its expiry stays");

  assert.equal((await deviceRow(erased.deviceId)).label, ERASED_DEVICE_LABEL);
  assert.equal((await agentRow(agent)).name, ERASED_AGENT_NAME);

  assert.deepEqual(
    await auditAt(ARCHIVED_AT),
    [
      ["account.erased", null, null, null, erased.userId, null],
      ["device.revoked", null, null, null, erased.deviceId, "account_erased"],
      ...[team, solo].map(({ workspaceId }) => [
        "workspace.archived",
        null,
        null,
        workspaceId,
        workspaceId,
        "account_erased",
      ]),
      ...[live, expiredInvitation].map((id) => [
        "invitation.revoked",
        null,
        null,
        team.workspaceId,
        id,
        "account_erased",
      ]),
      [
        "join_request.denied",
        null,
        null,
        team.workspaceId,
        asked,
        "account_erased",
      ],
      ...[
        [team.workspaceId, team.ownerPerson],
        [solo.workspaceId, solo.ownerPerson],
        [elsewhere.workspaceId, elsewherePerson],
      ].map(([workspaceId, personId]) => [
        "member.removed",
        null,
        null,
        workspaceId,
        personId,
        "account_erased",
      ]),
    ].sort((a, b) => String(a).localeCompare(String(b))),
  );

  // An archived workspace refuses an invitation code as an invalid one, and
  // a join request as an unknown workspace.
  const refusal = {
    refusal: "invitation_invalid",
    reason: "workspace_archived",
    invitationId: live,
  };
  assert.deepEqual(
    await previewInvitation(db, {
      tokenHash,
      userId: guest.userId,
      now: LATER,
    }),
    { previewed: false, ...refusal },
  );
  assert.deepEqual(
    await acceptInvitation(db, { tokenHash, ...guest, now: LATER }),
    { accepted: false, ...refusal },
  );
  assert.equal((await personRow(unclaimed)).userId, null);
  assert.deepEqual(
    await createJoinRequest(db, {
      workspaceId: team.workspaceId,
      userId: guest.userId,
      deviceId: guest.deviceId,
      displayName: "Gus",
      now: LATER,
    }),
    { requested: false, refusal: "workspace_not_found" },
  );
});

test("an earlier disable keeps its time, and the former GitHub ID matches nothing, so a sign-in with it can store a new account", async () => {
  const db = database();
  const erased = await account("Erin");
  await db
    .update(users)
    .set({ disabledAt: NOW })
    .where(eq(users.id, erased.userId));
  const result = await eraseAccount(db, {
    userId: erased.userId,
    now: DISABLED_ERASED_AT,
  });
  assert.deepEqual(result, {
    erased: true,
    endedMemberships: [],
    revokedDevices: [
      {
        deviceId: erased.deviceId,
        disabledAgentIds: [],
        revokedGrantIds: [],
        cancelledRuns: [],
      },
    ],
    withdrawnJoinRequestIds: [],
    archivedWorkspaces: [],
  });
  assert.deepEqual((await userRow(erased.userId)).disabledAt, NOW);

  // The lookup of the API's sign-in, by the GitHub ID, finds nothing.
  const found = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.identityProvider, "github"),
        eq(userIdentities.subject, erased.subject),
      ),
    );
  assert.deepEqual(found, []);
  // The sign-in then creates a new account with the same GitHub ID.
  const newUser = newId<UserId>();
  await db.insert(users).values({ id: newUser, displayName: "Erin" });
  await db.insert(userIdentities).values({
    id: newUuidV7(),
    userId: newUser,
    identityProvider: "github",
    subject: erased.subject,
    login: "erin-again",
    accountCreatedAt: GITHUB_CREATED,
    lastSignInAt: LATER,
  });
  const identities = await db
    .select({
      userId: userIdentities.userId,
      subject: userIdentities.subject,
    })
    .from(userIdentities)
    .where(inArray(userIdentities.userId, [erased.userId, newUser]));
  assert.deepEqual(
    identities.sort((a, b) => a.userId.localeCompare(b.userId)),
    [
      { userId: erased.userId, subject: null },
      { userId: newUser, subject: erased.subject },
    ].sort((a, b) => a.userId.localeCompare(b.userId)),
  );
});

test("a blocked request stays blocked, and a pending request in a paused workspace is withdrawn while the pause stays", async () => {
  const db = database();
  const owner = await account("Owner");
  const erased = await account("Erin");
  const blockedIn = await workspaceOf(owner);
  const pausedIn = await workspaceOf(owner);
  const blocked = await requested(erased, blockedIn.workspaceId);
  const blocking = await blockJoinRequest(db, {
    workspaceId: blockedIn.workspaceId,
    joinRequestId: blocked,
    userId: owner.userId,
    deviceId: owner.deviceId,
    now: NOW,
  });
  assert.equal(blocking.blocked, true);
  const pending = await requested(erased, pausedIn.workspaceId);
  const pausing = await pauseJoinRequests(db, {
    workspaceId: pausedIn.workspaceId,
    userId: owner.userId,
    deviceId: owner.deviceId,
    now: NOW,
  });
  assert.deepEqual(pausing, { paused: true, changed: true });

  const result = await eraseAccount(db, {
    userId: erased.userId,
    now: BLOCKED_ERASED_AT,
  });
  assert.ok(result.erased);
  assert.deepEqual(result.withdrawnJoinRequestIds, [pending]);

  const block = await requestRow(blocked);
  assert.equal(block.decision, "blocked");
  assert.deepEqual(block.decidedAt, NOW);
  assert.equal(block.decidedByUserId, owner.userId);
  assert.equal(block.unblockedAt, null);
  assert.equal(block.requestedDisplayName, ERASED_DISPLAY_NAME);
  const withdrawn = await requestRow(pending);
  assert.equal(withdrawn.decision, "withdrawn");
  assert.equal(withdrawn.decidedByUserId, erased.userId);
  assert.equal(withdrawn.requestedDisplayName, ERASED_DISPLAY_NAME);
  const [paused] = await db
    .select({ pausedAt: workspaces.joinRequestsPausedAt })
    .from(workspaces)
    .where(eq(workspaces.id, pausedIn.workspaceId));
  assert.deepEqual(paused?.pausedAt, NOW, "the pause stays");
  assert.deepEqual(await auditAt(BLOCKED_ERASED_AT), [
    ["account.erased", null, null, null, erased.userId, null],
    ["device.revoked", null, null, null, erased.deviceId, "account_erased"],
    [
      "join_request.withdrawn",
      null,
      null,
      pausedIn.workspaceId,
      pending,
      "account_erased",
    ],
  ]);
});

test("enabling an erased account is refused: it stays disabled, and nothing is audited", async () => {
  const db = database();
  const erased = await account("Erin");
  const result = await eraseAccount(db, {
    userId: erased.userId,
    now: ERASED_AT,
  });
  assert.ok(result.erased);
  assert.deepEqual(
    await enableAccount(db, { userId: erased.userId, now: ENABLE_REFUSED_AT }),
    { changed: false, erased: true },
  );
  const user = await userRow(erased.userId);
  assert.deepEqual(user.disabledAt, ERASED_AT);
  assert.deepEqual(user.updatedAt, ERASED_AT);
  assert.deepEqual(await auditAt(ENABLE_REFUSED_AT), []);
});

test("inside a transaction that rolls back, an erasure leaves nothing behind", async () => {
  const db = database();
  const owner = await account("Owner");
  const erased = await account("Erin");
  const { workspaceId } = await workspaceOf(owner);
  const person = await addPerson(workspaceId, owner, { claimedBy: erased });
  await assert.rejects(
    db.transaction(async (tx) => {
      const result = await eraseAccount(tx, {
        userId: erased.userId,
        now: ROLLED_BACK_AT,
      });
      assert.ok(result.erased);
      throw new Error("roll back");
    }),
    /roll back/,
  );
  assert.equal((await identityRow(erased.userId)).subject, erased.subject);
  assert.equal((await personRow(person)).removedAt, null);
  assert.equal((await deviceRow(erased.deviceId)).revokedAt, null);
  assert.deepEqual(await auditAt(ROLLED_BACK_AT), []);
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
 * lock, such as `advisory`.
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
 * Waits until a session of the test database waits for a lock, while
 * `running` has not settled, and returns what it waits for (`lockWaits`);
 * empty when `running` settled without waiting.
 */
async function untilWaiting(running: Promise<unknown>): Promise<string[]> {
  let settled = false;
  running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    if (await waitsForLock()) {
      return lockWaits();
    }
    await delay(10);
  }
  return [];
}

/**
 * Runs `first` in a transaction of a second session and keeps it open while
 * `action` starts in this session. Returns the action's result after the
 * held transaction committed, whether the action waited for a lock, and what
 * it waited for (`lockWaits`).
 */
async function whileHeld<T>(
  first: (tx: Database) => Promise<unknown>,
  action: () => Promise<T>,
): Promise<
  Readonly<{ result: T; waited: boolean; waitedOn: readonly string[] }>
> {
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
    return { result: await running, waited, waitedOn };
  } finally {
    release.resolve();
    await held.catch(() => undefined);
    await other.close();
  }
}

/** The lookup of the API's sign-in (`upsertAccount`): the identity by the GitHub ID, locked. */
function signInLookup(tx: Database, subject: string) {
  return tx
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.identityProvider, "github"),
        eq(userIdentities.subject, subject),
      ),
    )
    .for("update");
}

/** What `lockActor` in the API checks first: the account, locked, and not disabled. */
async function accountUsable(tx: Database, userId: UserId): Promise<boolean> {
  const [row] = await tx
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId))
    .for("no key update");
  return row !== undefined && row.disabledAt === null;
}

test(
  "an erasure waits for a sign-in that holds the account's identity and then revokes the device that the sign-in registered",
  SERVER_ONLY,
  async () => {
    const erased = await account("Erin");
    const registered = newId<DeviceId>();
    const { result, waited, waitedOn } = await whileHeld(
      async (tx) => {
        // The sign-in's locks: the identity, then the account; then a new device.
        const [found] = await signInLookup(tx, erased.subject);
        assert.equal(found?.userId, erased.userId);
        assert.equal(await accountUsable(tx, erased.userId), true);
        await tx.insert(devices).values({
          id: registered,
          userId: erased.userId,
          label: "Desktop",
          platform: "macos",
          publicKey: randomBytes(32).toString("hex"),
          keyAlgorithm: "ed25519",
          lastSignInAt: NOW,
        });
      },
      () => eraseAccount(database(), { userId: erased.userId, now: ERASED_AT }),
    );
    assert.equal(waited, true, "the erasure waits for the identity");
    assert.deepEqual(waitedOn, ["user_identities"]);
    assert.ok(result.erased);
    assert.deepEqual(
      result.revokedDevices.map((device) => device.deviceId),
      byId([erased.deviceId, registered]),
    );
    assert.equal(
      (await deviceRow(registered)).revocationReason,
      "account_erased",
    );
  },
);

test(
  "a sign-in that waits for an erasure no longer finds the identity",
  SERVER_ONLY,
  async () => {
    const erased = await account("Erin");
    const { result, waited, waitedOn } = await whileHeld(
      async (tx) => {
        const erasure = await eraseAccount(tx, {
          userId: erased.userId,
          now: ERASED_AT,
        });
        assert.ok(erasure.erased);
      },
      () => database().transaction((tx) => signInLookup(tx, erased.subject)),
    );
    assert.equal(waited, true, "the sign-in waits for the identity");
    assert.deepEqual(waitedOn, ["user_identities"]);
    assert.deepEqual(result, [], "the sign-in then creates a new account");
  },
);

test(
  "an erasure waits for an invitation accept of the account, which checks the account as the API does, and then removes the person that it claimed",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const erased = await account("Erin");
    const { workspaceId } = await workspaceOf(owner);
    const invited = await addPerson(workspaceId, owner);
    const tokenHash = randomBytes(32).toString("hex");
    await invite(workspaceId, invited, owner, tokenHash);
    const { result, waited, waitedOn } = await whileHeld(
      async (tx) => {
        assert.equal(await accountUsable(tx, erased.userId), true);
        const accepted = await acceptInvitation(tx, {
          tokenHash,
          userId: erased.userId,
          deviceId: erased.deviceId,
          now: NOW,
        });
        assert.equal(accepted.accepted, true);
      },
      () => eraseAccount(database(), { userId: erased.userId, now: ERASED_AT }),
    );
    assert.equal(waited, true, "the erasure waits for the account");
    assert.deepEqual(waitedOn, ["users"]);
    assert.ok(result.erased);
    assert.deepEqual(
      result.endedMemberships.map((end) => end.memberId),
      [invited],
    );
    const row = await personRow(invited);
    assert.equal(row.userId, erased.userId);
    assert.deepEqual(row.removedAt, ERASED_AT);
    assert.equal(row.displayName, ERASED_DISPLAY_NAME);
  },
);

test(
  "an invitation accept that waits for an erasure of its account finds the account disabled, as the API's check does",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const erased = await account("Erin");
    const { workspaceId } = await workspaceOf(owner);
    const invited = await addPerson(workspaceId, owner);
    const tokenHash = randomBytes(32).toString("hex");
    await invite(workspaceId, invited, owner, tokenHash);
    const { result, waited, waitedOn } = await whileHeld(
      async (tx) => {
        const erasure = await eraseAccount(tx, {
          userId: erased.userId,
          now: ERASED_AT,
        });
        assert.ok(erasure.erased);
      },
      () =>
        database().transaction(async (tx) =>
          (await accountUsable(tx, erased.userId))
            ? acceptInvitation(tx, {
                tokenHash,
                userId: erased.userId,
                deviceId: erased.deviceId,
                now: LATER,
              })
            : "unauthorized",
        ),
    );
    assert.equal(waited, true, "the accept waits for the account");
    assert.deepEqual(waitedOn, ["users"]);
    assert.equal(result, "unauthorized");
    assert.equal((await personRow(invited)).userId, null);
  },
);

test(
  "an erasure waits for an approval of the account's join request and removes the person that it created; an approval that waits for an erasure is a conflict",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const erased = await account("Erin");
    const later = await account("Lee");
    const { workspaceId } = await workspaceOf(owner);
    const first = await requested(erased, workspaceId);
    let approvedPerson: MemberId | undefined;
    const approval = await whileHeld(
      async (tx) => {
        const approved = await approveJoinRequest(tx, {
          workspaceId,
          joinRequestId: first,
          ...owner,
          now: NOW,
        });
        assert.ok(approved.approved);
        approvedPerson = approved.member.id;
      },
      () => eraseAccount(database(), { userId: erased.userId, now: ERASED_AT }),
    );
    assert.equal(approval.waited, true, "the erasure waits for the request");
    assert.deepEqual(approval.waitedOn, ["workspace_join_requests"]);
    assert.ok(approval.result.erased);
    assert.ok(approvedPerson);
    assert.deepEqual(
      approval.result.endedMemberships.map((end) => end.memberId),
      [approvedPerson],
    );
    assert.deepEqual(approval.result.withdrawnJoinRequestIds, []);
    assert.equal((await requestRow(first)).decision, "approved");

    const second = await requested(later, workspaceId);
    const erasure = await whileHeld(
      async (tx) => {
        const done = await eraseAccount(tx, {
          userId: later.userId,
          now: ERASED_AT,
        });
        assert.ok(done.erased);
      },
      () =>
        approveJoinRequest(database(), {
          workspaceId,
          joinRequestId: second,
          ...owner,
          now: LATER,
        }),
    );
    assert.equal(erasure.waited, true, "the approval waits for the request");
    assert.deepEqual(erasure.waitedOn, ["workspace_join_requests"]);
    assert.deepEqual(erasure.result, { approved: false, refusal: "conflict" });
    assert.equal((await requestRow(second)).decision, "withdrawn");
    const people = await database()
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, later.userId));
    assert.deepEqual(people, []);
  },
);

test(
  "two erasures of different accounts run one after another, through the advisory lock",
  SERVER_ONLY,
  async () => {
    const first = await account("Erin");
    const second = await account("Lee");
    const { result, waited, waitedOn } = await whileHeld(
      async (tx) => {
        const erasure = await eraseAccount(tx, {
          userId: first.userId,
          now: ERASED_AT,
        });
        assert.ok(erasure.erased);
      },
      () => eraseAccount(database(), { userId: second.userId, now: ERASED_AT }),
    );
    assert.equal(waited, true, "the second erasure waits for the first");
    assert.deepEqual(waitedOn, ["advisory"]);
    assert.ok(result.erased);
    assert.equal((await identityRow(second.userId)).subject, null);
  },
);

/** An owner's workspace whose only other person is an unclaimed one. */
async function soleOwner(name: string) {
  const owner = await account(name);
  const workspace = await workspaceOf(owner);
  const unclaimed = await addPerson(workspace.workspaceId, owner);
  return { owner, ...workspace, unclaimed };
}

test(
  "an erasure waits for an invitation that the owner creates in a workspace without another claimed person, then archives the workspace and revokes the invitation",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, unclaimed } = await soleOwner("Ayla");
    let created: InvitationId | undefined;
    const { result, waited, waitedOn } = await whileHeld(
      async (tx) => {
        const invitation = await createInvitation(tx, {
          workspaceId,
          ...owner,
          memberId: unclaimed,
          tokenHash: randomBytes(32).toString("hex"),
          now: NOW,
        });
        assert.ok(invitation.created);
        created = invitation.invitation.id;
      },
      () => eraseAccount(database(), { userId: owner.userId, now: ERASED_AT }),
    );
    assert.equal(waited, true, "the erasure waits for the owner's person");
    assert.deepEqual(waitedOn, ["workspace_members"]);
    assert.ok(result.erased);
    assert.ok(created);
    assert.deepEqual(result.archivedWorkspaces, [
      {
        workspaceId,
        revokedInvitationIds: [created],
        deniedJoinRequestIds: [],
      },
    ]);
    assert.deepEqual((await invitationRow(created)).revokedAt, ERASED_AT);
  },
);

test(
  "an invitation that the owner creates while an erasure archives the workspace waits for it and is refused as not_member",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, unclaimed } = await soleOwner("Ayla");
    const { result, waited, waitedOn } = await whileHeld(
      async (tx) => {
        const erasure = await eraseAccount(tx, {
          userId: owner.userId,
          now: ERASED_AT,
        });
        assert.ok(erasure.erased);
        assert.equal(erasure.archivedWorkspaces.length, 1);
      },
      () =>
        createInvitation(database(), {
          workspaceId,
          ...owner,
          memberId: unclaimed,
          tokenHash: randomBytes(32).toString("hex"),
          now: LATER,
        }),
    );
    assert.equal(waited, true, "the invitation waits for the owner's person");
    assert.deepEqual(waitedOn, ["workspace_members"]);
    assert.deepEqual(result, { created: false, refusal: "not_member" });
    const invitations = await database()
      .select({ id: workspaceInvitations.id })
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.workspaceId, workspaceId));
    assert.deepEqual(invitations, []);
  },
);

test(
  "an erasure waits for an acceptance in a workspace without another claimed person and then refuses, because the new member can take over ownership",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, ownerPerson, unclaimed } =
      await soleOwner("Ayla");
    const guest = await account("Gus");
    const tokenHash = randomBytes(32).toString("hex");
    await invite(workspaceId, unclaimed, owner, tokenHash);
    const { result, waited, waitedOn } = await whileHeld(
      async (tx) => {
        const accepted = await acceptInvitation(tx, {
          tokenHash,
          userId: guest.userId,
          deviceId: guest.deviceId,
          now: NOW,
        });
        assert.equal(accepted.accepted, true);
      },
      () => eraseAccount(database(), { userId: owner.userId, now: ERASED_AT }),
    );
    assert.equal(
      waited,
      true,
      "the erasure waits for the person that the acceptance claims",
    );
    assert.deepEqual(waitedOn, ["workspace_members"]);
    assert.deepEqual(result, {
      erased: false,
      refusal: "owner",
      ownedWorkspaceIds: [workspaceId],
    });
    assert.equal((await workspaceRow(workspaceId)).archivedAt, null);
    const row = await personRow(ownerPerson);
    assert.equal(row.role, "owner");
    assert.equal(row.removedAt, null);
    assert.equal((await identityRow(owner.userId)).erasedAt, null);
    assert.equal((await personRow(unclaimed)).userId, guest.userId);
  },
);

test(
  "an acceptance that waits for an erasure that archives the workspace finds its invitation revoked",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId, unclaimed } = await soleOwner("Ayla");
    const guest = await account("Gus");
    const tokenHash = randomBytes(32).toString("hex");
    const invitationId = await invite(workspaceId, unclaimed, owner, tokenHash);
    const { result, waited, waitedOn } = await whileHeld(
      async (tx) => {
        const erasure = await eraseAccount(tx, {
          userId: owner.userId,
          now: ERASED_AT,
        });
        assert.ok(erasure.erased);
      },
      () =>
        acceptInvitation(database(), {
          tokenHash,
          userId: guest.userId,
          deviceId: guest.deviceId,
          now: LATER,
        }),
    );
    assert.equal(waited, true, "the acceptance waits for its person");
    assert.deepEqual(waitedOn, ["workspace_members"]);
    assert.deepEqual(result, {
      accepted: false,
      refusal: "invitation_invalid",
      reason: "revoked",
      invitationId,
    });
    assert.equal((await personRow(unclaimed)).userId, null);
  },
);

test(
  "an erasure waits for a join request that holds the workspace row and then denies it with the archive",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId } = await soleOwner("Ayla");
    const asker = await account("Ari");
    let asked: JoinRequestId | undefined;
    const { result, waited, waitedOn } = await whileHeld(
      async (tx) => {
        const request = await createJoinRequest(tx, {
          workspaceId,
          userId: asker.userId,
          deviceId: asker.deviceId,
          displayName: "Ari",
          now: NOW,
        });
        assert.ok(request.requested && request.created);
        asked = request.joinRequest.id;
      },
      () => eraseAccount(database(), { userId: owner.userId, now: ERASED_AT }),
    );
    assert.equal(waited, true, "the erasure waits for the workspace row");
    assert.deepEqual(waitedOn, ["workspaces"]);
    assert.ok(result.erased);
    assert.ok(asked);
    assert.deepEqual(result.archivedWorkspaces, [
      { workspaceId, revokedInvitationIds: [], deniedJoinRequestIds: [asked] },
    ]);
    const request = await requestRow(asked);
    assert.equal(request.decision, "denied");
    assert.equal(request.decidedByUserId, owner.userId);
  },
);

test(
  "a join request that waits for an erasure that archives the workspace finds it archived",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId } = await soleOwner("Ayla");
    const asker = await account("Ari");
    const { result, waited, waitedOn } = await whileHeld(
      async (tx) => {
        const erasure = await eraseAccount(tx, {
          userId: owner.userId,
          now: ERASED_AT,
        });
        assert.ok(erasure.erased);
      },
      () =>
        createJoinRequest(database(), {
          workspaceId,
          userId: asker.userId,
          deviceId: asker.deviceId,
          displayName: "Ari",
          now: LATER,
        }),
    );
    assert.equal(waited, true, "the request waits for the workspace row");
    assert.deepEqual(waitedOn, ["workspaces"]);
    assert.deepEqual(result, {
      requested: false,
      refusal: "workspace_not_found",
    });
    const requests = await database()
      .select({ id: workspaceJoinRequests.id })
      .from(workspaceJoinRequests)
      .where(eq(workspaceJoinRequests.workspaceId, workspaceId));
    assert.deepEqual(requests, []);
  },
);

test(
  "a requester whose clock counts its request as expired holds it while an erasure with an earlier now counts it as pending; the erasure waits for it before the workspace row, so neither deadlocks",
  SERVER_ONLY,
  async () => {
    const { owner, workspaceId } = await soleOwner("Ayla");
    const asker = await account("Ari");
    const expiresAt = new Date("2026-11-03T12:00:00.000Z");
    // `account-cli.ts` takes `now` before the erasure waits for its locks.
    const erasureNow = new Date(expiresAt.getTime() - HOUR_MS);
    const requesterNow = new Date(expiresAt.getTime() + HOUR_MS);
    const stale = newId<JoinRequestId>();
    await database()
      .insert(workspaceJoinRequests)
      .values({
        id: stale,
        workspaceId,
        requesterUserId: asker.userId,
        requesterDeviceId: asker.deviceId,
        requestedDisplayName: "Ari",
        createdAt: new Date(expiresAt.getTime() - 168 * HOUR_MS),
        expiresAt,
      });

    const url = testDatabase?.url;
    assert.ok(url, "the test database is on a server");
    const other = createDatabase(url, { max: 1 });
    const holding = Promise.withResolvers<void>();
    const go = Promise.withResolvers<void>();
    // The requester takes the first locks of `createJoinRequest`, its account
    // and its open request, and holds them; then it runs the whole request,
    // which locks the workspace row next.
    const requesting = other.db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, asker.userId))
        .for("no key update");
      await tx
        .select({ id: workspaceJoinRequests.id })
        .from(workspaceJoinRequests)
        .where(eq(workspaceJoinRequests.id, stale))
        .for("no key update");
      holding.resolve();
      await go.promise;
      return createJoinRequest(tx, {
        workspaceId,
        userId: asker.userId,
        deviceId: asker.deviceId,
        displayName: "Ari",
        now: requesterNow,
      });
    });
    try {
      await Promise.race([
        holding.promise,
        requesting.then(() => {
          throw new Error("the requester ended early");
        }),
      ]);
      const erasing = eraseAccount(database(), {
        userId: owner.userId,
        now: erasureNow,
      });
      assert.deepEqual(
        await untilWaiting(erasing),
        ["workspace_join_requests"],
        "the erasure waits for the request, before the workspace row",
      );
      go.resolve();
      // Neither fails with a deadlock (40P01).
      const request = await requesting;
      const erasure = await erasing;
      assert.ok(request.requested && request.created);
      assert.ok(erasure.erased);
      assert.deepEqual(erasure.archivedWorkspaces, [
        {
          workspaceId,
          revokedInvitationIds: [],
          deniedJoinRequestIds: [request.joinRequest.id],
        },
      ]);
      const marked = await requestRow(stale);
      assert.equal(marked.decision, "expired");
      assert.deepEqual(marked.decidedAt, expiresAt);
      const denied = await requestRow(request.joinRequest.id);
      assert.equal(denied.decision, "denied");
      assert.equal(denied.decidedByUserId, owner.userId);
    } finally {
      go.resolve();
      await requesting.catch(() => undefined);
      await other.close();
    }
  },
);
