import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentId,
  type CorrelationId,
  DefineMemberResponseSchema,
  type DeviceId,
  type InvitationId,
  type MemberId,
  newId,
  type PermissionGrantId,
  type ProjectId,
  type RepositoryId,
  type RunId,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "./client.ts";
import type { Database } from "./db.ts";
import { revokeDevice } from "./device-revocation.ts";
import { DatabaseError, withDatabaseErrors } from "./errors.ts";
import { createInvitation } from "./invitations.ts";
import { activePersonOf, createWorkspace } from "./membership.ts";
import {
  defineMember,
  demoteMember,
  DEVICE_TOO_NEW_MS,
  leaveWorkspace,
  promoteMember,
  removeMember,
  renameMember,
} from "./people.ts";
import {
  agentRuns,
  agents,
  auditEvents,
  devices,
  permissionGrants,
  projects,
  repositories,
  users,
  workspaceInvitations,
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
const NOW = new Date("2026-11-01T12:00:00.000Z");
const LATER = new Date("2026-11-01T13:00:00.000Z");

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
  values: Partial<typeof workspaceInvitations.$inferInsert> = {},
): Promise<InvitationId> {
  const id = newId<InvitationId>();
  await database()
    .insert(workspaceInvitations)
    .values({
      id,
      workspaceId,
      memberId,
      tokenHash: randomBytes(32).toString("hex"),
      createdByUserId: createdBy.userId,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 168 * HOUR_MS),
      ...values,
    });
  return id;
}

async function person(id: MemberId) {
  const [row] = await database()
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function auditOf(workspaceId: WorkspaceId) {
  const rows = await database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(auditEvents.id);
  return rows
    .filter((row) => row.action !== "workspace.created")
    .map((row) => ({
      action: row.action,
      actorUserId: row.actorUserId,
      actorDeviceId: row.actorDeviceId,
      subjectId: row.subjectId,
      reason: row.reason,
      createdAt: row.createdAt,
    }));
}

test("the owner and an admin define unclaimed members, each audited", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const { workspaceId } = await workspaceOf(owner);
  await addPerson(workspaceId, owner, { claimedBy: admin, role: "admin" });

  const byOwner = await defineMember(db, {
    workspaceId,
    ...owner,
    displayName: "Linus",
    now: NOW,
  });
  assert.ok(byOwner.defined);
  assert.deepEqual(
    DefineMemberResponseSchema.parse({ member: byOwner.member }),
    { member: byOwner.member },
  );
  assert.deepEqual(byOwner.member, {
    id: byOwner.member.id,
    workspaceId,
    displayName: "Linus",
    role: "member",
    userId: null,
    identity: null,
    removedAt: null,
  });
  const row = await person(byOwner.member.id);
  assert.equal(row.addedByUserId, owner.userId);
  assert.equal(row.userId, null);
  assert.equal(row.claimedAt, null);
  assert.deepEqual(row.createdAt, NOW);
  assert.deepEqual(row.updatedAt, NOW);

  const byAdmin = await defineMember(db, {
    workspaceId,
    ...admin,
    displayName: "Margaret",
    now: LATER,
  });
  assert.ok(byAdmin.defined);
  assert.equal(byAdmin.member.role, "member");
  assert.equal((await person(byAdmin.member.id)).addedByUserId, admin.userId);

  assert.deepEqual(await auditOf(workspaceId), [
    {
      action: "member.defined",
      actorUserId: owner.userId,
      actorDeviceId: owner.deviceId,
      subjectId: byOwner.member.id,
      reason: null,
      createdAt: NOW,
    },
    {
      action: "member.defined",
      actorUserId: admin.userId,
      actorDeviceId: admin.deviceId,
      subjectId: byAdmin.member.id,
      reason: null,
      createdAt: LATER,
    },
  ]);
});

test("a member cannot define a person, and an account that is no active member is refused as one", async () => {
  const db = database();
  const owner = await account("Owner");
  const member = await account("Member");
  const former = await account("Former");
  const outsider = await account("Outsider");
  const { workspaceId } = await workspaceOf(owner);
  await addPerson(workspaceId, owner, { claimedBy: member });
  await addPerson(workspaceId, owner, {
    claimedBy: former,
    role: "admin",
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const people = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  for (const [label, actor, inWorkspace, refusal] of [
    ["a member", member, workspaceId, "forbidden"],
    ["a removed admin", former, workspaceId, "not_member"],
    ["an outsider", outsider, workspaceId, "not_member"],
    ["the owner elsewhere", owner, newId<WorkspaceId>(), "not_member"],
  ] as const) {
    assert.deepEqual(
      await defineMember(db, {
        workspaceId: inWorkspace,
        ...actor,
        displayName: "Linus",
        now: NOW,
      }),
      { defined: false, refusal },
      label,
    );
  }
  const after = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  assert.equal(after.length, people.length, "a refusal defines nobody");
  assert.deepEqual(await auditOf(workspaceId), [], "and audits nothing");
});

test("every member renames their own person, and the owner or an admin an unclaimed one", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const member = await account("Member");
  const { workspaceId, ownerPerson } = await workspaceOf(owner);
  const adminPerson = await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
  });
  const memberPerson = await addPerson(workspaceId, owner, {
    claimedBy: member,
  });
  const unclaimed = await addPerson(workspaceId, owner);

  for (const [actor, memberId, displayName] of [
    [member, memberPerson, "Grace H."],
    [admin, adminPerson, "Admin A."],
    [owner, ownerPerson, "Owner O."],
    [owner, unclaimed, "By the owner"],
    [admin, unclaimed, "By an admin"],
  ] as const) {
    assert.deepEqual(
      await renameMember(db, {
        workspaceId,
        ...actor,
        memberId,
        displayName,
        now: LATER,
      }),
      { renamed: true },
    );
    const row = await person(memberId);
    assert.equal(row.displayName, displayName);
    assert.deepEqual(row.updatedAt, LATER);
  }
  assert.equal((await person(memberPerson)).role, "member");
  assert.deepEqual(
    (await auditOf(workspaceId)).map((row) => [
      row.action,
      row.actorUserId,
      row.actorDeviceId,
      row.subjectId,
    ]),
    [
      ["member.renamed", member.userId, member.deviceId, memberPerson],
      ["member.renamed", admin.userId, admin.deviceId, adminPerson],
      ["member.renamed", owner.userId, owner.deviceId, ownerPerson],
      ["member.renamed", owner.userId, owner.deviceId, unclaimed],
      ["member.renamed", admin.userId, admin.deviceId, unclaimed],
    ],
  );
});

test("nobody renames another claimed person, a member no unclaimed one, and a removed person is a conflict", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const member = await account("Member");
  const former = await account("Former");
  const outsider = await account("Outsider");
  const { workspaceId, ownerPerson } = await workspaceOf(owner);
  const adminPerson = await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
  });
  const memberPerson = await addPerson(workspaceId, owner, {
    claimedBy: member,
  });
  const unclaimed = await addPerson(workspaceId, owner);
  const removedUnclaimed = await addPerson(workspaceId, owner, {
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const formerPerson = await addPerson(workspaceId, owner, {
    claimedBy: former,
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const elsewhere = await addPerson(
    (await workspaceOf(outsider)).workspaceId,
    outsider,
  );

  for (const [label, actor, memberId, refusal] of [
    ["the owner, an admin", owner, adminPerson, "forbidden"],
    ["the owner, a member", owner, memberPerson, "forbidden"],
    ["an admin, the owner", admin, ownerPerson, "forbidden"],
    ["an admin, a member", admin, memberPerson, "forbidden"],
    ["a member, the owner", member, ownerPerson, "forbidden"],
    ["a member, an unclaimed person", member, unclaimed, "forbidden"],
    [
      "a member, a removed unclaimed person",
      member,
      removedUnclaimed,
      "forbidden",
    ],
    ["the owner, a former member", owner, formerPerson, "forbidden"],
    [
      "the owner, a removed unclaimed person",
      owner,
      removedUnclaimed,
      "conflict",
    ],
    [
      "an admin, a removed unclaimed person",
      admin,
      removedUnclaimed,
      "conflict",
    ],
    ["the owner, another workspace's person", owner, elsewhere, "not_found"],
    ["the owner, an unknown person", owner, newId<MemberId>(), "not_found"],
    [
      "a former member, their former person",
      former,
      formerPerson,
      "not_member",
    ],
  ] as const) {
    assert.deepEqual(
      await renameMember(db, {
        workspaceId,
        ...actor,
        memberId,
        displayName: "Renamed",
        now: LATER,
      }),
      { renamed: false, refusal },
      label,
    );
  }
  const renamed = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.displayName, "Renamed"));
  assert.deepEqual(renamed, [], "a refusal renames nobody");
  assert.deepEqual(await auditOf(workspaceId), [], "and audits nothing");
});

test("removing an unclaimed person sets removed_at and removed_by_user_id and revokes its live invitation with member_removed", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const { workspaceId } = await workspaceOf(owner);
  await addPerson(workspaceId, owner, { claimedBy: admin, role: "admin" });
  const invited = await addPerson(workspaceId, owner);
  const other = await addPerson(workspaceId, owner);
  const plain = await addPerson(workspaceId, owner);
  const earlier = await invite(workspaceId, invited, owner, {
    revokedAt: NOW,
    revokedByUserId: owner.userId,
  });
  const live = await invite(workspaceId, invited, owner);
  const othersInvitation = await invite(workspaceId, other, owner);

  const removed = await removeMember(db, {
    workspaceId,
    ...admin,
    memberId: invited,
    now: LATER,
  });
  assert.deepEqual(removed, {
    removed: true,
    memberId: invited,
    userId: null,
    revokedInvitationIds: [live],
    disabledAgentIds: [],
    revokedGrantIds: [],
    cancelledRuns: [],
  });
  const row = await person(invited);
  assert.deepEqual(row.removedAt, LATER);
  assert.equal(row.removedByUserId, admin.userId);
  assert.deepEqual(row.updatedAt, LATER);
  assert.equal(row.userId, null, "the person stays unclaimed");

  const invitations = new Map(
    (
      await db
        .select()
        .from(workspaceInvitations)
        .where(
          inArray(workspaceInvitations.id, [earlier, live, othersInvitation]),
        )
    ).map((invitation) => [invitation.id, invitation]),
  );
  assert.deepEqual(invitations.get(live)?.revokedAt, LATER);
  assert.equal(invitations.get(live)?.revokedByUserId, admin.userId);
  assert.deepEqual(
    invitations.get(earlier)?.revokedAt,
    NOW,
    "an earlier revocation stays",
  );
  assert.equal(invitations.get(earlier)?.revokedByUserId, owner.userId);
  assert.equal(invitations.get(othersInvitation)?.revokedAt, null);

  // A person without an invitation is removed alone.
  assert.deepEqual(
    await removeMember(db, {
      workspaceId,
      ...owner,
      memberId: plain,
      now: LATER,
    }),
    {
      removed: true,
      memberId: plain,
      userId: null,
      revokedInvitationIds: [],
      disabledAgentIds: [],
      revokedGrantIds: [],
      cancelledRuns: [],
    },
  );

  assert.deepEqual(await auditOf(workspaceId), [
    {
      action: "member.removed",
      actorUserId: admin.userId,
      actorDeviceId: admin.deviceId,
      subjectId: invited,
      reason: null,
      createdAt: LATER,
    },
    {
      action: "invitation.revoked",
      actorUserId: admin.userId,
      actorDeviceId: admin.deviceId,
      subjectId: live,
      reason: "member_removed",
      createdAt: LATER,
    },
    {
      action: "member.removed",
      actorUserId: owner.userId,
      actorDeviceId: owner.deviceId,
      subjectId: plain,
      reason: null,
      createdAt: LATER,
    },
  ]);
});

test("the roles decide who removes whom: a member removes nobody, an admin neither the owner nor an admin, nobody their own person, and a refusal changes nothing", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const otherAdmin = await account("Other admin");
  const member = await account("Member");
  const outsider = await account("Outsider");
  const { workspaceId, ownerPerson } = await workspaceOf(owner);
  const adminPerson = await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
  });
  const otherAdminPerson = await addPerson(workspaceId, owner, {
    claimedBy: otherAdmin,
    role: "admin",
  });
  const memberPerson = await addPerson(workspaceId, owner, {
    claimedBy: member,
  });
  const unclaimed = await addPerson(workspaceId, owner);
  const invitation = await invite(workspaceId, unclaimed, owner);
  const removedUnclaimed = await addPerson(workspaceId, owner, {
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const former = await account("Former");
  const formerPerson = await addPerson(workspaceId, owner, {
    claimedBy: former,
    role: "admin",
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const elsewhere = await addPerson(
    (await workspaceOf(outsider)).workspaceId,
    outsider,
  );

  for (const [label, actor, memberId, refusal] of [
    ["a member, an unclaimed person", member, unclaimed, "forbidden"],
    ["a member, a member", member, memberPerson, "forbidden"],
    ["a member, an admin", member, adminPerson, "forbidden"],
    ["a member, the owner", member, ownerPerson, "forbidden"],
    ["an admin, the owner", admin, ownerPerson, "forbidden"],
    ["an admin, another admin", admin, otherAdminPerson, "forbidden"],
    ["an admin, themselves", admin, adminPerson, "forbidden"],
    ["the owner, themselves", owner, ownerPerson, "forbidden"],
    ["the owner, a removed person", owner, removedUnclaimed, "conflict"],
    ["the owner, a former admin", owner, formerPerson, "conflict"],
    ["an admin, a removed person", admin, removedUnclaimed, "conflict"],
    ["the owner, another workspace's person", owner, elsewhere, "not_found"],
    ["the owner, an unknown person", owner, newId<MemberId>(), "not_found"],
    ["an outsider", outsider, unclaimed, "not_member"],
    ["a former admin", former, unclaimed, "not_member"],
  ] as const) {
    assert.deepEqual(
      await removeMember(db, { workspaceId, ...actor, memberId, now: LATER }),
      { removed: false, refusal },
      label,
    );
  }
  for (const id of [
    ownerPerson,
    adminPerson,
    otherAdminPerson,
    memberPerson,
    unclaimed,
  ]) {
    assert.equal(
      (await person(id)).removedAt,
      null,
      "a refusal removes nobody",
    );
  }
  const [live] = await db
    .select({ revokedAt: workspaceInvitations.revokedAt })
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, invitation));
  assert.equal(live?.revokedAt, null, "nor revokes an invitation");
  assert.deepEqual(await auditOf(workspaceId), [], "and audits nothing");
});

test("the owner removes admins and members, and an admin removes members and unclaimed people", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const removedAdmin = await account("Removed admin");
  const first = await account("First member");
  const second = await account("Second member");
  const { workspaceId } = await workspaceOf(owner);
  await addPerson(workspaceId, owner, { claimedBy: admin, role: "admin" });
  const removedAdminPerson = await addPerson(workspaceId, owner, {
    claimedBy: removedAdmin,
    role: "admin",
  });
  const firstPerson = await addPerson(workspaceId, owner, { claimedBy: first });
  const secondPerson = await addPerson(workspaceId, owner, {
    claimedBy: second,
  });
  const unclaimed = await addPerson(workspaceId, owner);

  for (const [actor, memberId, userId] of [
    [owner, removedAdminPerson, removedAdmin.userId],
    [owner, firstPerson, first.userId],
    [admin, secondPerson, second.userId],
    [admin, unclaimed, null],
  ] as const) {
    const result = await removeMember(db, {
      workspaceId,
      ...actor,
      memberId,
      now: LATER,
    });
    assert.ok(result.removed, JSON.stringify(result));
    assert.equal(result.memberId, memberId);
    assert.equal(result.userId, userId);
    const row = await person(memberId);
    assert.deepEqual(row.removedAt, LATER);
    assert.equal(row.removedByUserId, actor.userId);
    assert.equal(row.userId, userId, "the person keeps its account");
  }
  assert.deepEqual(
    (await auditOf(workspaceId)).map((row) => [
      row.action,
      row.actorUserId,
      row.actorDeviceId,
      row.subjectId,
      row.reason,
    ]),
    [
      [
        "member.removed",
        owner.userId,
        owner.deviceId,
        removedAdminPerson,
        null,
      ],
      ["member.removed", owner.userId, owner.deviceId, firstPerson, null],
      ["member.removed", admin.userId, admin.deviceId, secondPerson, null],
      ["member.removed", admin.userId, admin.deviceId, unclaimed, null],
    ],
  );
  for (const removed of [removedAdmin, first, second]) {
    assert.equal(
      await activePersonOf(db, { workspaceId, userId: removed.userId }),
      undefined,
      "a removed account is no active member",
    );
  }
});

test("an admin and a member leave, the owner cannot leave, and a former member is no member", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const member = await account("Member");
  const outsider = await account("Outsider");
  const { workspaceId, ownerPerson } = await workspaceOf(owner);
  const adminPerson = await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
  });
  const memberPerson = await addPerson(workspaceId, owner, {
    claimedBy: member,
  });

  for (const [label, actor, refusal] of [
    ["the owner", owner, "forbidden"],
    ["an outsider", outsider, "not_member"],
  ] as const) {
    assert.deepEqual(
      await leaveWorkspace(db, { workspaceId, ...actor, now: LATER }),
      { left: false, refusal },
      label,
    );
  }
  assert.equal((await person(ownerPerson)).removedAt, null);

  for (const [actor, memberId] of [
    [admin, adminPerson],
    [member, memberPerson],
  ] as const) {
    assert.deepEqual(
      await leaveWorkspace(db, { workspaceId, ...actor, now: LATER }),
      {
        left: true,
        memberId,
        userId: actor.userId,
        revokedInvitationIds: [],
        disabledAgentIds: [],
        revokedGrantIds: [],
        cancelledRuns: [],
      },
    );
    const row = await person(memberId);
    assert.deepEqual(row.removedAt, LATER);
    assert.equal(
      row.removedByUserId,
      actor.userId,
      "the account removed itself",
    );
  }
  assert.deepEqual(
    await leaveWorkspace(db, { workspaceId, ...member, now: LATER }),
    { left: false, refusal: "not_member" },
    "leaving twice",
  );
  assert.deepEqual(
    (await auditOf(workspaceId)).map((row) => [
      row.action,
      row.actorUserId,
      row.actorDeviceId,
      row.subjectId,
    ]),
    [
      ["member.left", admin.userId, admin.deviceId, adminPerson],
      ["member.left", member.userId, member.deviceId, memberPerson],
    ],
  );
});

test("the database refuses to remove the owner, whatever the application checks", async () => {
  const owner = await account("Owner");
  const { workspaceId, ownerPerson } = await workspaceOf(owner);
  await assert.rejects(
    withDatabaseErrors(() =>
      database()
        .update(workspaceMembers)
        .set({ removedAt: LATER, removedByUserId: owner.userId })
        .where(eq(workspaceMembers.id, ownerPerson)),
    ),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseError);
      assert.equal(error.code, "23514");
      assert.equal(error.constraint, "workspace_members_owner_removal_check");
      return true;
    },
  );
  assert.equal((await person(ownerPerson)).removedAt, null);
  assert.deepEqual(
    (await activePersonOf(database(), { workspaceId, userId: owner.userId }))
      ?.role,
    "owner",
  );
});

type Project = Readonly<{ projectId: ProjectId; repositoryId: RepositoryId }>;

/** A project of the workspace with one repository. */
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

/** Another device of the account. */
async function secondDevice(owner: Account): Promise<DeviceId> {
  const deviceId = newId<DeviceId>();
  await database()
    .insert(devices)
    .values({
      id: deviceId,
      userId: owner.userId,
      label: "Desktop",
      platform: "linux",
      publicKey: randomBytes(32).toString("hex"),
      keyAlgorithm: "ed25519",
      lastSignInAt: NOW,
    });
  return deviceId;
}

/** An agent of the account in the project, on one of the account's devices. */
async function agentOf(
  project: Project,
  owner: Account,
  values: Partial<typeof agents.$inferInsert> = {},
): Promise<AgentId> {
  const id = newId<AgentId>();
  await database()
    .insert(agents)
    .values({
      id,
      projectId: project.projectId,
      ownerUserId: owner.userId,
      hostDeviceId: owner.deviceId,
      name: "Builder",
      ...values,
    });
  return id;
}

/** A grant of `repo.read` on the project's repository to the agent, by its owner. */
async function grantTo(
  project: Project,
  agentId: AgentId,
  owner: Account,
  values: Partial<typeof permissionGrants.$inferInsert> = {},
): Promise<PermissionGrantId> {
  const id = newId<PermissionGrantId>();
  await database()
    .insert(permissionGrants)
    .values({
      id,
      projectId: project.projectId,
      granteeAgentId: agentId,
      hostDeviceId: owner.deviceId,
      capability: "repo.read",
      repositoryId: project.repositoryId,
      grantedByUserId: owner.userId,
      createdAt: NOW,
      ...values,
    });
  return id;
}

/** A run of the agent that `requestedBy` asked for. */
async function runOf(
  project: Project,
  agentId: AgentId,
  state: RunState,
  requestedBy: Account,
  values: Partial<typeof agentRuns.$inferInsert> = {},
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
      ...values,
    });
  return id;
}

async function agentRow(id: AgentId) {
  const [row] = await database().select().from(agents).where(eq(agents.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function grantRow(id: PermissionGrantId) {
  const [row] = await database()
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function runRow(id: RunId) {
  const [row] = await database()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function invitationRow(id: InvitationId) {
  const [row] = await database()
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, id));
  assert.ok(row !== undefined);
  return row;
}

function byId<T extends string>(ids: readonly T[]): T[] {
  return [...ids].sort();
}

test("a removal disables the person's agents in the workspace, revokes their grants and the invitations the person created, and cancels both kinds of unfinished runs with member_removed, and touches nothing outside the workspace", async () => {
  const db = database();
  const owner = await account("Owner");
  const removed = await account("Removed admin");
  const bob = await account("Bob");
  const cleo = await account("Cleo");
  const { workspaceId } = await workspaceOf(owner);
  const removedPerson = await addPerson(workspaceId, owner, {
    claimedBy: removed,
    role: "admin",
    // The target of the workspace's ownership offer.
    ownershipOfferedAt: NOW,
  });
  await addPerson(workspaceId, owner, { claimedBy: bob });
  const first = await projectIn(workspaceId, owner);
  const second = await projectIn(workspaceId, owner);
  const desktop = await secondDevice(removed);

  // The removed admin's agents: one per project and device, and one that
  // was disabled before.
  const laptopAgent = await agentOf(first, removed);
  const desktopAgent = await agentOf(second, removed, {
    hostDeviceId: desktop,
  });
  const disabledAgent = await agentOf(first, removed, { disabledAt: NOW });
  const bobsAgent = await agentOf(first, bob);
  const onDesktop = { ...removed, deviceId: desktop };
  const grants = {
    laptop: await grantTo(first, laptopAgent, removed),
    desktop: await grantTo(second, desktopAgent, onDesktop),
    // Expired but never revoked: revoked too, as a device revocation does.
    expired: await grantTo(second, desktopAgent, onDesktop, {
      capability: "repo.write",
      expiresAt: new Date(NOW.getTime() + HOUR_MS / 2),
    }),
    revokedBefore: await grantTo(first, laptopAgent, removed, {
      capability: "git.commit",
      revokedAt: NOW,
      revokedByUserId: removed.userId,
    }),
    bobs: await grantTo(first, bobsAgent, bob),
  };
  const correlationId = newId<CorrelationId>();
  const runs = {
    queued: await runOf(first, laptopAgent, "queued", removed),
    running: await runOf(first, laptopAgent, "running", owner, {
      repositoryId: first.repositoryId,
      correlationId,
    }),
    awaiting: await runOf(second, desktopAgent, "awaiting_input", bob),
    completed: await runOf(first, laptopAgent, "completed", removed),
    // Runs that the removed admin requested on Bob's agent.
    requested: await runOf(first, bobsAgent, "running", removed),
    requestedFinished: await runOf(first, bobsAgent, "failed", removed),
    // Bob's own run on his agent.
    bobs: await runOf(first, bobsAgent, "queued", bob),
  };

  // Invitations that the removed admin created, in every state, and one of
  // the owner.
  const invited = async () => addPerson(workspaceId, owner);
  const invitations = {
    live: await invite(workspaceId, await invited(), removed),
    expired: await invite(workspaceId, await invited(), removed, {
      expiresAt: new Date(NOW.getTime() + HOUR_MS),
    }),
    accepted: await invite(workspaceId, await invited(), removed, {
      acceptedAt: NOW,
      acceptedByUserId: cleo.userId,
      acceptedDeviceId: cleo.deviceId,
    }),
    revokedBefore: await invite(workspaceId, await invited(), removed, {
      revokedAt: NOW,
      revokedByUserId: owner.userId,
    }),
    owners: await invite(workspaceId, await invited(), owner),
  };

  // Cleo's workspace, where the removed admin is an admin too.
  const other = await workspaceOf(cleo);
  await addPerson(other.workspaceId, cleo, {
    claimedBy: removed,
    role: "admin",
  });
  const elsewhere = await projectIn(other.workspaceId, cleo);
  const agentElsewhere = await agentOf(elsewhere, removed);
  const grantElsewhere = await grantTo(elsewhere, agentElsewhere, removed);
  const cleosAgent = await agentOf(elsewhere, cleo);
  const runElsewhere = await runOf(elsewhere, agentElsewhere, "running", cleo);
  const requestedElsewhere = await runOf(
    elsewhere,
    cleosAgent,
    "running",
    removed,
  );
  const invitationElsewhere = await invite(
    other.workspaceId,
    await addPerson(other.workspaceId, cleo),
    removed,
  );

  const result = await removeMember(db, {
    workspaceId,
    ...owner,
    memberId: removedPerson,
    now: LATER,
  });
  const cancelled = (
    runId: RunId,
    agentId: AgentId,
    project: Project,
    previousState: string,
    fields: Partial<{
      repositoryId: RepositoryId;
      correlationId: CorrelationId;
    }> = {},
  ) => ({
    runId,
    agentId,
    projectId: project.projectId,
    workspaceId,
    repositoryId: fields.repositoryId ?? null,
    correlationId: fields.correlationId ?? null,
    previousState,
    reason: "member_removed",
  });
  assert.deepEqual(result, {
    removed: true,
    memberId: removedPerson,
    userId: removed.userId,
    revokedInvitationIds: byId([invitations.live, invitations.expired]),
    disabledAgentIds: byId([laptopAgent, desktopAgent]),
    revokedGrantIds: byId([grants.laptop, grants.desktop, grants.expired]),
    cancelledRuns: [
      cancelled(runs.queued, laptopAgent, first, "queued"),
      cancelled(runs.running, laptopAgent, first, "running", {
        repositoryId: first.repositoryId,
        correlationId,
      }),
      cancelled(runs.awaiting, desktopAgent, second, "awaiting_input"),
      cancelled(runs.requested, bobsAgent, first, "running"),
    ].sort((a, b) => (a.runId < b.runId ? -1 : 1)),
  });
  assert.ok(result.removed && Object.isFrozen(result.cancelledRuns[0]));

  const row = await person(removedPerson);
  assert.deepEqual(row.removedAt, LATER);
  assert.equal(row.removedByUserId, owner.userId);
  assert.equal(row.ownershipOfferedAt, null, "the offer to the person ends");
  assert.deepEqual(row.updatedAt, LATER);

  for (const id of [laptopAgent, desktopAgent]) {
    assert.deepEqual((await agentRow(id)).disabledAt, LATER);
  }
  assert.deepEqual(
    (await agentRow(disabledAgent)).disabledAt,
    NOW,
    "an earlier disable stays",
  );
  for (const id of [bobsAgent, agentElsewhere, cleosAgent]) {
    assert.equal((await agentRow(id)).disabledAt, null);
  }

  for (const id of [grants.laptop, grants.desktop, grants.expired]) {
    const grant = await grantRow(id);
    assert.deepEqual(grant.revokedAt, LATER);
    assert.equal(grant.revokedByUserId, owner.userId, "the remover revokes");
  }
  const before = await grantRow(grants.revokedBefore);
  assert.deepEqual(before.revokedAt, NOW, "an earlier revocation stays");
  assert.equal(before.revokedByUserId, removed.userId);
  for (const id of [grants.bobs, grantElsewhere]) {
    assert.equal((await grantRow(id)).revokedAt, null);
  }

  for (const id of [runs.queued, runs.running, runs.awaiting, runs.requested]) {
    const run = await runRow(id);
    assert.equal(run.state, "cancelled");
    assert.equal(run.stateReason, "member_removed");
    assert.deepEqual(run.finishedAt, LATER);
  }
  for (const [id, state] of [
    [runs.completed, "completed"],
    [runs.requestedFinished, "failed"],
    [runs.bobs, "queued"],
    [runElsewhere, "running"],
    [requestedElsewhere, "running"],
  ] as const) {
    const run = await runRow(id);
    assert.equal(run.state, state);
    assert.equal(run.stateReason, null);
  }

  for (const id of [invitations.live, invitations.expired]) {
    const invitation = await invitationRow(id);
    assert.deepEqual(invitation.revokedAt, LATER);
    assert.equal(invitation.revokedByUserId, owner.userId);
  }
  assert.equal((await invitationRow(invitations.accepted)).revokedAt, null);
  assert.deepEqual(
    (await invitationRow(invitations.revokedBefore)).revokedAt,
    NOW,
  );
  for (const id of [invitations.owners, invitationElsewhere]) {
    assert.equal((await invitationRow(id)).revokedAt, null);
  }

  // The grant revocations write no audit record: the audit vocabulary has
  // no grant action (P-61; grant events are P-80).
  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => [
      record.action,
      record.actorUserId,
      record.actorDeviceId,
      record.subjectId,
      record.reason,
      record.createdAt,
    ]),
    [
      [
        "member.removed",
        owner.userId,
        owner.deviceId,
        removedPerson,
        null,
        LATER,
      ],
      ...byId([invitations.live, invitations.expired]).map((id) => [
        "invitation.revoked",
        owner.userId,
        owner.deviceId,
        id,
        "member_removed",
        LATER,
      ]),
    ],
  );
  assert.deepEqual(await auditOf(other.workspaceId), []);
  assert.ok(
    await activePersonOf(db, {
      workspaceId: other.workspaceId,
      userId: removed.userId,
    }),
    "the membership elsewhere stays",
  );
});

test("leaving ends the membership the same way, with the leaving account as the remover", async () => {
  const db = database();
  const owner = await account("Owner");
  const leaver = await account("Leaver");
  const { workspaceId } = await workspaceOf(owner);
  const leaverPerson = await addPerson(workspaceId, owner, {
    claimedBy: leaver,
    role: "admin",
  });
  const project = await projectIn(workspaceId, owner);
  const agentId = await agentOf(project, leaver);
  const grantId = await grantTo(project, agentId, leaver);
  const ownersAgent = await agentOf(project, owner);
  const ownRun = await runOf(project, agentId, "running", leaver);
  const requested = await runOf(project, ownersAgent, "queued", leaver);
  const invitation = await invite(
    workspaceId,
    await addPerson(workspaceId, owner),
    leaver,
  );

  const result = await leaveWorkspace(db, {
    workspaceId,
    ...leaver,
    now: LATER,
  });
  assert.ok(result.left, JSON.stringify(result));
  assert.deepEqual(result.revokedInvitationIds, [invitation]);
  assert.deepEqual(result.disabledAgentIds, [agentId]);
  assert.deepEqual(result.revokedGrantIds, [grantId]);
  assert.deepEqual(
    result.cancelledRuns.map((run) => [run.runId, run.reason]),
    byId([ownRun, requested]).map((id) => [id, "member_removed"]),
  );
  assert.equal((await grantRow(grantId)).revokedByUserId, leaver.userId);
  assert.equal(
    (await invitationRow(invitation)).revokedByUserId,
    leaver.userId,
  );
  assert.equal((await person(leaverPerson)).removedByUserId, leaver.userId);
  assert.equal((await agentRow(ownersAgent)).disabledAt, null);
  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => [
      record.action,
      record.actorUserId,
      record.actorDeviceId,
      record.subjectId,
      record.reason,
    ]),
    [
      ["member.left", leaver.userId, leaver.deviceId, leaverPerson, null],
      [
        "invitation.revoked",
        leaver.userId,
        leaver.deviceId,
        invitation,
        "member_removed",
      ],
    ],
  );
});

test("inside a transaction that rolls back, a removal leaves nothing behind", async () => {
  const db = database();
  const owner = await account("Owner");
  const member = await account("Member");
  const { workspaceId } = await workspaceOf(owner);
  const memberPerson = await addPerson(workspaceId, owner, {
    claimedBy: member,
  });
  const project = await projectIn(workspaceId, owner);
  const agentId = await agentOf(project, member);
  const grantId = await grantTo(project, agentId, member);
  const runId = await runOf(project, agentId, "running", member);
  await assert.rejects(
    db.transaction(async (tx) => {
      const result = await removeMember(tx, {
        workspaceId,
        ...owner,
        memberId: memberPerson,
        now: LATER,
      });
      assert.ok(result.removed);
      throw new Error("roll back");
    }),
    /roll back/u,
  );
  assert.equal((await person(memberPerson)).removedAt, null);
  assert.equal((await agentRow(agentId)).disabledAt, null);
  assert.equal((await grantRow(grantId)).revokedAt, null);
  assert.equal((await runRow(runId)).state, "running");
  assert.deepEqual(await auditOf(workspaceId), []);
});

/** Sets the account's device's registration to `age` before `LATER`; by default the least age that promotes. */
async function deviceAged(owner: Account, age: number = DEVICE_TOO_NEW_MS + 1) {
  await database()
    .update(devices)
    .set({ createdAt: new Date(LATER.getTime() - age) })
    .where(eq(devices.id, owner.deviceId));
}

async function roleOf(id: MemberId) {
  return (await person(id)).role;
}

test("the owner promotes a claimed member and demotes an admin, each audited, and only a demotion revokes the open invitations that the admin created, with creator_demoted", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const member = await account("Member");
  await deviceAged(owner);
  const { workspaceId } = await workspaceOf(owner);
  const adminPerson = await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
  });
  const memberPerson = await addPerson(workspaceId, owner, {
    claimedBy: member,
  });
  const [first, second, third, fourth] = [
    await addPerson(workspaceId, owner),
    await addPerson(workspaceId, owner),
    await addPerson(workspaceId, owner),
    await addPerson(workspaceId, owner),
  ];
  assert.ok(
    first !== undefined &&
      second !== undefined &&
      third !== undefined &&
      fourth !== undefined,
  );
  const live = await invite(workspaceId, first, admin);
  // Expired and never revoked, as in the unique index of one live invitation.
  const expired = await invite(workspaceId, second, admin, {
    createdAt: new Date(NOW.getTime() - 2 * HOUR_MS),
    expiresAt: new Date(NOW.getTime() - HOUR_MS),
  });
  const revoked = await invite(workspaceId, third, admin, {
    revokedAt: NOW,
    revokedByUserId: owner.userId,
  });
  const ownersInvitation = await invite(workspaceId, fourth, owner);
  // The admin's invitation in another workspace stays.
  const elsewhereOwner = await account("Elsewhere");
  const elsewhere = (await workspaceOf(elsewhereOwner)).workspaceId;
  await addPerson(elsewhere, elsewhereOwner, {
    claimedBy: admin,
    role: "admin",
  });
  const elsewhereInvitation = await invite(
    elsewhere,
    await addPerson(elsewhere, elsewhereOwner),
    admin,
  );
  const untouched = [live, expired, ownersInvitation, elsewhereInvitation];
  const revokedAtOf = async (ids: readonly InvitationId[]) =>
    Promise.all(ids.map(async (id) => (await invitationRow(id)).revokedAt));

  assert.deepEqual(
    await promoteMember(db, {
      workspaceId,
      ...owner,
      memberId: memberPerson,
      now: LATER,
    }),
    { promoted: true },
  );
  const promoted = await person(memberPerson);
  assert.equal(promoted.role, "admin");
  assert.deepEqual(promoted.updatedAt, LATER);
  assert.deepEqual(
    await revokedAtOf(untouched),
    [null, null, null, null],
    "a promotion revokes no invitation",
  );

  const demotion = await demoteMember(db, {
    workspaceId,
    ...owner,
    memberId: adminPerson,
    now: LATER,
  });
  assert.deepEqual(demotion, {
    demoted: true,
    revokedInvitationIds: byId([live, expired]),
  });
  const demoted = await person(adminPerson);
  assert.equal(demoted.role, "member");
  assert.deepEqual(demoted.updatedAt, LATER);
  assert.equal(demoted.removedAt, null, "a demoted admin stays a member");
  for (const id of [live, expired]) {
    const row = await invitationRow(id);
    assert.deepEqual(row.revokedAt, LATER);
    assert.equal(row.revokedByUserId, owner.userId);
  }
  assert.deepEqual(
    (await invitationRow(revoked)).revokedAt,
    NOW,
    "an earlier revocation stays",
  );
  assert.deepEqual(await revokedAtOf([ownersInvitation, elsewhereInvitation]), [
    null,
    null,
  ]);

  // The promoted member is demoted again and created no invitation.
  assert.deepEqual(
    await demoteMember(db, {
      workspaceId,
      ...owner,
      memberId: memberPerson,
      now: LATER,
    }),
    { demoted: true, revokedInvitationIds: [] },
  );
  assert.equal(await roleOf(memberPerson), "member");

  const actor = {
    actorUserId: owner.userId,
    actorDeviceId: owner.deviceId,
    createdAt: LATER,
  };
  assert.deepEqual(await auditOf(workspaceId), [
    {
      action: "member.promoted",
      subjectId: memberPerson,
      reason: null,
      ...actor,
    },
    {
      action: "member.demoted",
      subjectId: adminPerson,
      reason: null,
      ...actor,
    },
    ...byId([live, expired]).map((subjectId) => ({
      action: "invitation.revoked" as const,
      subjectId,
      reason: "creator_demoted" as const,
      ...actor,
    })),
    {
      action: "member.demoted",
      subjectId: memberPerson,
      reason: null,
      ...actor,
    },
  ]);
  assert.deepEqual(await auditOf(elsewhere), []);
});

test("only the owner changes a role, never their own, and only of an active, claimed person in the right role; a refusal changes nothing", async () => {
  const db = database();
  const owner = await account("Owner");
  const admin = await account("Admin");
  const otherAdmin = await account("Other admin");
  const member = await account("Member");
  const otherMember = await account("Other member");
  const outsider = await account("Outsider");
  const former = await account("Former");
  // Old enough, so that each refusal is about the role or the person.
  for (const each of [owner, admin, otherAdmin, member, outsider, former]) {
    await deviceAged(each);
  }
  const { workspaceId, ownerPerson } = await workspaceOf(owner);
  const adminPerson = await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
  });
  const otherAdminPerson = await addPerson(workspaceId, owner, {
    claimedBy: otherAdmin,
    role: "admin",
  });
  const memberPerson = await addPerson(workspaceId, owner, {
    claimedBy: member,
  });
  const otherMemberPerson = await addPerson(workspaceId, owner, {
    claimedBy: otherMember,
  });
  const unclaimed = await addPerson(workspaceId, owner);
  const formerPerson = await addPerson(workspaceId, owner, {
    claimedBy: former,
    role: "admin",
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const formerMember = await addPerson(workspaceId, owner, {
    claimedBy: await account("Former member"),
    removedAt: NOW,
    removedByUserId: owner.userId,
  });
  const elsewhere = await addPerson(
    (await workspaceOf(outsider)).workspaceId,
    outsider,
    { claimedBy: otherMember },
  );
  const invitation = await invite(workspaceId, unclaimed, admin);

  for (const [label, actor, memberId, refusal] of [
    ["an admin, a member", admin, memberPerson, "forbidden"],
    ["an admin, themselves", admin, adminPerson, "forbidden"],
    ["a member, another member", member, otherMemberPerson, "forbidden"],
    ["a member, themselves", member, memberPerson, "forbidden"],
    ["the owner, themselves", owner, ownerPerson, "forbidden"],
    ["the owner, an admin", owner, adminPerson, "conflict"],
    ["the owner, an unclaimed person", owner, unclaimed, "conflict"],
    ["the owner, a former member", owner, formerMember, "conflict"],
    ["the owner, another workspace's person", owner, elsewhere, "not_found"],
    ["the owner, an unknown person", owner, newId<MemberId>(), "not_found"],
    ["an outsider", outsider, memberPerson, "not_member"],
    ["a former admin", former, memberPerson, "not_member"],
  ] as const) {
    assert.deepEqual(
      await promoteMember(db, { workspaceId, ...actor, memberId, now: LATER }),
      { promoted: false, refusal },
      `promote: ${label}`,
    );
  }
  for (const [label, actor, memberId, refusal] of [
    ["an admin, another admin", admin, otherAdminPerson, "forbidden"],
    ["an admin, themselves", admin, adminPerson, "forbidden"],
    ["an admin, the owner", admin, ownerPerson, "forbidden"],
    ["a member, an admin", member, adminPerson, "forbidden"],
    ["the owner, themselves", owner, ownerPerson, "forbidden"],
    ["the owner, a member", owner, memberPerson, "conflict"],
    ["the owner, an unclaimed person", owner, unclaimed, "conflict"],
    ["the owner, a former admin", owner, formerPerson, "conflict"],
    ["the owner, another workspace's person", owner, elsewhere, "not_found"],
    ["the owner, an unknown person", owner, newId<MemberId>(), "not_found"],
    ["an outsider", outsider, adminPerson, "not_member"],
    ["a former admin", former, adminPerson, "not_member"],
  ] as const) {
    assert.deepEqual(
      await demoteMember(db, { workspaceId, ...actor, memberId, now: LATER }),
      { demoted: false, refusal },
      `demote: ${label}`,
    );
  }
  for (const [id, role] of [
    [ownerPerson, "owner"],
    [adminPerson, "admin"],
    [otherAdminPerson, "admin"],
    [memberPerson, "member"],
    [otherMemberPerson, "member"],
    [unclaimed, "member"],
    [formerPerson, "admin"],
    [formerMember, "member"],
  ] as const) {
    assert.equal(await roleOf(id), role, "a refusal changes no role");
  }
  assert.equal(
    (await invitationRow(invitation)).revokedAt,
    null,
    "nor revokes an invitation",
  );
  assert.deepEqual(await auditOf(workspaceId), [], "and audits nothing");
});

test("a device exactly 72 hours old is too new to promote, and one a millisecond older promotes", async () => {
  const db = database();
  const owner = await account("Owner");
  const member = await account("Member");
  const { workspaceId } = await workspaceOf(owner);
  const memberPerson = await addPerson(workspaceId, owner, {
    claimedBy: member,
  });
  const promote = () =>
    promoteMember(db, {
      workspaceId,
      ...owner,
      memberId: memberPerson,
      now: LATER,
    });

  await deviceAged(owner, DEVICE_TOO_NEW_MS);
  assert.deepEqual(await promote(), {
    promoted: false,
    refusal: "device_too_new",
  });
  assert.equal(await roleOf(memberPerson), "member");
  await deviceAged(owner, DEVICE_TOO_NEW_MS + 1);
  assert.deepEqual(await promote(), { promoted: true });
  assert.equal(await roleOf(memberPerson), "admin");
});

test("only a device older than 72 hours promotes, and any device of the owner demotes", async () => {
  const db = database();
  assert.equal(DEVICE_TOO_NEW_MS, 72 * HOUR_MS);
  const owner = await account("Owner");
  const admin = await account("Admin");
  const member = await account("Member");
  const { workspaceId } = await workspaceOf(owner);
  const adminPerson = await addPerson(workspaceId, owner, {
    claimedBy: admin,
    role: "admin",
  });
  const memberPerson = await addPerson(workspaceId, owner, {
    claimedBy: member,
  });
  const promote = (by: Account, memberId: MemberId) =>
    promoteMember(db, { workspaceId, ...by, memberId, now: LATER });
  const tooNew = { promoted: false, refusal: "device_too_new" };

  await deviceAged(owner, 0);
  assert.deepEqual(await promote(owner, memberPerson), tooNew);
  await deviceAged(owner, DEVICE_TOO_NEW_MS - 1);
  assert.deepEqual(await promote(owner, memberPerson), tooNew);
  await deviceAged(owner, DEVICE_TOO_NEW_MS);
  assert.deepEqual(await promote(owner, memberPerson), tooNew);
  // A device that is too new is refused before the target's state is
  // decided, and after the role: an admin is forbidden on any device.
  assert.deepEqual(await promote(owner, adminPerson), tooNew);
  assert.deepEqual(await promote(admin, memberPerson), {
    promoted: false,
    refusal: "forbidden",
  });
  // Another account's device is no device of the owner.
  await deviceAged(member);
  assert.deepEqual(
    await promote({ ...owner, deviceId: member.deviceId }, memberPerson),
    tooNew,
  );
  assert.equal(await roleOf(memberPerson), "member");
  assert.deepEqual(await auditOf(workspaceId), []);

  await deviceAged(owner);
  assert.deepEqual(await promote(owner, memberPerson), { promoted: true });
  assert.equal(await roleOf(memberPerson), "admin");

  // A demotion needs no device age.
  const desktop = await secondDevice(owner);
  assert.deepEqual(
    await demoteMember(db, {
      workspaceId,
      userId: owner.userId,
      deviceId: desktop,
      memberId: adminPerson,
      now: LATER,
    }),
    { demoted: true, revokedInvitationIds: [] },
  );
  assert.equal(await roleOf(adminPerson), "member");
  assert.deepEqual(
    (await auditOf(workspaceId)).map((record) => [
      record.action,
      record.actorDeviceId,
      record.subjectId,
    ]),
    [
      ["member.promoted", owner.deviceId, memberPerson],
      ["member.demoted", desktop, adminPerson],
    ],
  );
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
 * Starts `action` while a second session holds `change` uncommitted, lets the
 * change commit once the action waits for a lock, and returns the action's
 * result. An action that does not lock what the change holds decides on the
 * state before the change.
 */
async function afterConcurrentChange<T>(
  change: (tx: Database) => Promise<unknown>,
  action: () => Promise<T>,
): Promise<T> {
  const url = testDatabase?.url;
  assert.ok(url, "the test database is on a server");
  const other = createDatabase(url, { max: 1 });
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const changing = other.db.transaction(async (tx) => {
    await change(tx);
    holding.resolve();
    await release.promise;
  });
  try {
    await Promise.race([
      holding.promise,
      changing.then(() => {
        throw new Error("the change ended early");
      }),
    ]);
    const result = action();
    let settled = false;
    result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled && !(await waitsForLock())) {
      await delay(10);
    }
    release.resolve();
    await changing;
    return await result;
  } finally {
    release.resolve();
    await changing.catch(() => undefined);
    await other.close();
  }
}

test(
  "a removal waits for a concurrent claim of the person and then removes it as the claimed person of that account",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const claimer = await account("Claimer");
    const { workspaceId } = await workspaceOf(owner);
    const unclaimed = await addPerson(workspaceId, owner);
    // As accepting an invitation claims the person.
    const removal = await afterConcurrentChange(
      (tx) =>
        tx
          .update(workspaceMembers)
          .set({ userId: claimer.userId, claimedAt: NOW })
          .where(eq(workspaceMembers.id, unclaimed)),
      () =>
        removeMember(database(), {
          workspaceId,
          ...owner,
          memberId: unclaimed,
          now: LATER,
        }),
    );
    // The removal decides on the claimed person, so the claimer's account is
    // the one whose connections the server tells.
    assert.ok(removal.removed, JSON.stringify(removal));
    assert.equal(removal.userId, claimer.userId);
    const row = await person(unclaimed);
    assert.equal(row.userId, claimer.userId);
    assert.deepEqual(row.removedAt, LATER);
  },
);

test(
  "an admin demoted while their definition waits is refused with forbidden",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const admin = await account("Admin");
    const { workspaceId } = await workspaceOf(owner);
    const adminPerson = await addPerson(workspaceId, owner, {
      claimedBy: admin,
      role: "admin",
    });
    // As a demotion (#93) changes the admin's own person.
    const definition = await afterConcurrentChange(
      (tx) =>
        tx
          .update(workspaceMembers)
          .set({ role: "member" })
          .where(eq(workspaceMembers.id, adminPerson)),
      () =>
        defineMember(database(), {
          workspaceId,
          ...admin,
          displayName: "Linus",
          now: LATER,
        }),
    );
    assert.deepEqual(definition, { defined: false, refusal: "forbidden" });
    const defined = await database()
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.addedByUserId, admin.userId));
    assert.deepEqual(defined, []);
  },
);

test(
  "an admin removed while their removal of a person waits is refused as no longer a member",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const admin = await account("Admin");
    const { workspaceId } = await workspaceOf(owner);
    const adminPerson = await addPerson(workspaceId, owner, {
      claimedBy: admin,
      role: "admin",
    });
    const unclaimed = await addPerson(workspaceId, owner);
    const removal = await afterConcurrentChange(
      (tx) =>
        tx
          .update(workspaceMembers)
          .set({ removedAt: NOW, removedByUserId: owner.userId })
          .where(eq(workspaceMembers.id, adminPerson)),
      () =>
        removeMember(database(), {
          workspaceId,
          ...admin,
          memberId: unclaimed,
          now: LATER,
        }),
    );
    assert.deepEqual(removal, { removed: false, refusal: "not_member" });
    assert.equal((await person(unclaimed)).removedAt, null);
  },
);

test(
  "a removal waits for a concurrent revocation of the person's device and then changes only what the revocation left",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const removed = await account("Removed");
    const bob = await account("Bob");
    const { workspaceId } = await workspaceOf(owner);
    const removedPerson = await addPerson(workspaceId, owner, {
      claimedBy: removed,
    });
    await addPerson(workspaceId, owner, { claimedBy: bob });
    const project = await projectIn(workspaceId, owner);
    const desktop = await secondDevice(removed);
    const laptopAgent = await agentOf(project, removed);
    const desktopAgent = await agentOf(project, removed, {
      hostDeviceId: desktop,
    });
    const bobsAgent = await agentOf(project, bob);
    const laptopGrant = await grantTo(project, laptopAgent, removed);
    const desktopGrant = await grantTo(project, desktopAgent, {
      ...removed,
      deviceId: desktop,
    });
    const onLaptop = await runOf(project, laptopAgent, "running", removed);
    const onDesktop = await runOf(project, desktopAgent, "queued", removed);
    const requested = await runOf(project, bobsAgent, "running", removed);

    // The revocation holds the laptop's agent, grant, and run.
    const removal = await afterConcurrentChange(
      (tx) =>
        revokeDevice(tx, {
          deviceId: removed.deviceId,
          userId: removed.userId,
          reason: "lost",
          now: NOW,
          actorUserId: removed.userId,
          actorDeviceId: desktop,
        }),
      () =>
        removeMember(database(), {
          workspaceId,
          ...owner,
          memberId: removedPerson,
          now: LATER,
        }),
    );
    assert.ok(removal.removed, JSON.stringify(removal));
    assert.deepEqual(removal.disabledAgentIds, [desktopAgent]);
    assert.deepEqual(removal.revokedGrantIds, [desktopGrant]);
    assert.deepEqual(
      removal.cancelledRuns.map((run) => run.runId),
      byId([onDesktop, requested]),
    );
    assert.deepEqual((await agentRow(laptopAgent)).disabledAt, NOW);
    assert.equal((await grantRow(laptopGrant)).revokedByUserId, removed.userId);
    const laptopRun = await runRow(onLaptop);
    assert.equal(laptopRun.stateReason, "device_revoked");
    assert.deepEqual(laptopRun.finishedAt, NOW);
    for (const id of [onDesktop, requested]) {
      assert.equal((await runRow(id)).stateReason, "member_removed");
    }
  },
);

test(
  "leaving waits for a concurrent removal of the same person and is then refused as no longer a member",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const member = await account("Member");
    const { workspaceId } = await workspaceOf(owner);
    const memberPerson = await addPerson(workspaceId, owner, {
      claimedBy: member,
    });
    const departure = await afterConcurrentChange(
      (tx) =>
        removeMember(tx, {
          workspaceId,
          ...owner,
          memberId: memberPerson,
          now: NOW,
        }),
      () => leaveWorkspace(database(), { workspaceId, ...member, now: LATER }),
    );
    assert.deepEqual(departure, { left: false, refusal: "not_member" });
    const row = await person(memberPerson);
    assert.equal(row.removedByUserId, owner.userId);
    assert.deepEqual(row.removedAt, NOW);
    assert.deepEqual(
      (await auditOf(workspaceId)).map((record) => record.action),
      ["member.removed"],
    );
  },
);

test(
  "a removal waits for an invitation that the person creates meanwhile and revokes it too",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const admin = await account("Admin");
    const { workspaceId } = await workspaceOf(owner);
    const adminPerson = await addPerson(workspaceId, owner, {
      claimedBy: admin,
      role: "admin",
    });
    const unclaimed = await addPerson(workspaceId, owner);
    const created: { id: InvitationId | null } = { id: null };
    const removal = await afterConcurrentChange(
      async (tx) => {
        const result = await createInvitation(tx, {
          workspaceId,
          ...admin,
          memberId: unclaimed,
          tokenHash: randomBytes(32).toString("hex"),
          now: NOW,
        });
        assert.ok(result.created);
        created.id = result.invitation.id;
      },
      () =>
        removeMember(database(), {
          workspaceId,
          ...owner,
          memberId: adminPerson,
          now: LATER,
        }),
    );
    assert.ok(created.id !== null);
    assert.ok(removal.removed, JSON.stringify(removal));
    assert.deepEqual(removal.revokedInvitationIds, [created.id]);
    const invitation = await invitationRow(created.id);
    assert.deepEqual(invitation.revokedAt, LATER);
    assert.equal(invitation.revokedByUserId, owner.userId);
  },
);

test(
  "a demotion waits for an invitation that the admin creates meanwhile and revokes it with creator_demoted",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const admin = await account("Admin");
    const { workspaceId } = await workspaceOf(owner);
    const adminPerson = await addPerson(workspaceId, owner, {
      claimedBy: admin,
      role: "admin",
    });
    const unclaimed = await addPerson(workspaceId, owner);
    const created: { id: InvitationId | null } = { id: null };
    const demotion = await afterConcurrentChange(
      async (tx) => {
        const result = await createInvitation(tx, {
          workspaceId,
          ...admin,
          memberId: unclaimed,
          tokenHash: randomBytes(32).toString("hex"),
          now: NOW,
        });
        assert.ok(result.created);
        created.id = result.invitation.id;
      },
      () =>
        demoteMember(database(), {
          workspaceId,
          ...owner,
          memberId: adminPerson,
          now: LATER,
        }),
    );
    assert.ok(created.id !== null);
    assert.deepEqual(demotion, {
      demoted: true,
      revokedInvitationIds: [created.id],
    });
    const invitation = await invitationRow(created.id);
    assert.deepEqual(invitation.revokedAt, LATER);
    assert.equal(invitation.revokedByUserId, owner.userId);
    assert.deepEqual(
      (await auditOf(workspaceId)).map((record) => [
        record.action,
        record.reason,
      ]),
      [
        ["invitation.created", null],
        ["member.demoted", null],
        ["invitation.revoked", "creator_demoted"],
      ],
    );
  },
);

test(
  "an invitation and a removal by an admin wait for the admin's demotion and are then refused with forbidden",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const admin = await account("Admin");
    const member = await account("Member");
    const { workspaceId } = await workspaceOf(owner);
    const adminPerson = await addPerson(workspaceId, owner, {
      claimedBy: admin,
      role: "admin",
    });
    const memberPerson = await addPerson(workspaceId, owner, {
      claimedBy: member,
    });
    const unclaimed = await addPerson(workspaceId, owner);
    const demote = (tx: Database) =>
      demoteMember(tx, {
        workspaceId,
        ...owner,
        memberId: adminPerson,
        now: NOW,
      });

    const invitation = await afterConcurrentChange(demote, () =>
      createInvitation(database(), {
        workspaceId,
        ...admin,
        memberId: unclaimed,
        tokenHash: randomBytes(32).toString("hex"),
        now: LATER,
      }),
    );
    assert.deepEqual(invitation, { created: false, refusal: "forbidden" });
    const created = await database()
      .select({ id: workspaceInvitations.id })
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.createdByUserId, admin.userId));
    assert.deepEqual(created, []);

    // Promoted again, as the owner would, and demoted while the removal waits.
    await database()
      .update(workspaceMembers)
      .set({ role: "admin" })
      .where(eq(workspaceMembers.id, adminPerson));
    const removal = await afterConcurrentChange(demote, () =>
      removeMember(database(), {
        workspaceId,
        ...admin,
        memberId: memberPerson,
        now: LATER,
      }),
    );
    assert.deepEqual(removal, { removed: false, refusal: "forbidden" });
    assert.equal((await person(memberPerson)).removedAt, null);
    assert.equal(await roleOf(adminPerson), "member");
  },
);

test(
  "a demotion waits for a concurrent removal of the admin and is then a conflict",
  SERVER_ONLY,
  async () => {
    const owner = await account("Owner");
    const admin = await account("Admin");
    const { workspaceId } = await workspaceOf(owner);
    const adminPerson = await addPerson(workspaceId, owner, {
      claimedBy: admin,
      role: "admin",
    });
    const demotion = await afterConcurrentChange(
      (tx) =>
        removeMember(tx, {
          workspaceId,
          ...owner,
          memberId: adminPerson,
          now: NOW,
        }),
      () =>
        demoteMember(database(), {
          workspaceId,
          ...owner,
          memberId: adminPerson,
          now: LATER,
        }),
    );
    assert.deepEqual(demotion, { demoted: false, refusal: "conflict" });
    const row = await person(adminPerson);
    assert.deepEqual(row.removedAt, NOW);
    assert.equal(row.role, "admin", "a former admin keeps the role it had");
    assert.deepEqual(
      (await auditOf(workspaceId)).map((record) => record.action),
      ["member.removed"],
    );
  },
);
