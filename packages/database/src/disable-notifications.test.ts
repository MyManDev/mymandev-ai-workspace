import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentId,
  type DeviceId,
  type MemberId,
  newId,
  type PermissionGrantId,
  type ProjectId,
  type RepositoryId,
  type RunId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq, sql } from "drizzle-orm";
import { disableAccount, enableAccount } from "./account-status.ts";
import type { Database } from "./db.ts";
import {
  type DisableNotification,
  disableNotifications,
} from "./disable-notifications.ts";
import { checkErasureNotification } from "./erasure-check.ts";
import {
  encodeErasureNotification,
  ERASURE_NOTIFICATION_CHANNEL,
  type OperatorNotification,
} from "./erasure-notifications.ts";
import type { NotificationSession } from "./notification-session.ts";
import {
  agentRuns,
  agents,
  devices,
  permissionGrants,
  projects,
  repositories,
  users,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

// The notifications that an operator's account disable sends for the API's
// live events (#350), on the erasure's channel: their content and order,
// only at the commit, none after a rollback or a disable that changes
// nothing, the payload bound, and the API's check of each kind against the
// database.

let testDatabase: TestDatabase | undefined;
let session: NotificationSession | undefined;
/** Every payload received on the channel, in the order of delivery. */
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
const DISABLED_AT = new Date("2026-11-25T10:00:00.000Z");
const ROLLED_BACK_AT = new Date("2026-11-25T11:00:00.000Z");
const DISABLED_AGAIN_AT = new Date("2026-11-25T12:00:00.000Z");

/** A marker sent on the channel after a change; everything before it was delivered first. */
let markers = 0;

/**
 * The payloads that arrive after the previous call, up to a marker that this
 * call sends on the channel in a transaction of its own and that a server
 * delivers after everything committed before it.
 */
async function drainedPayloads(): Promise<string[]> {
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
  return received.splice(0, received.indexOf(marker) + 1).slice(0, -1);
}

async function drained(): Promise<DisableNotification[]> {
  return (await drainedPayloads()).map(
    (payload) => JSON.parse(payload) as DisableNotification,
  );
}

type Account = Readonly<{ userId: UserId; deviceId: DeviceId }>;

async function deviceOf(userId: UserId, revokedAt?: Date): Promise<DeviceId> {
  const id = newId<DeviceId>();
  await database()
    .insert(devices)
    .values({
      id,
      userId,
      label: "Erin's laptop",
      platform: "linux",
      publicKey: randomBytes(32).toString("hex"),
      keyAlgorithm: "ed25519",
      lastSignInAt: NOW,
      ...(revokedAt === undefined
        ? {}
        : { revokedAt, revocationReason: "lost" as const }),
    });
  return id;
}

async function account(name: string): Promise<Account> {
  const userId = newId<UserId>();
  await database().insert(users).values({ id: userId, displayName: name });
  return { userId, deviceId: await deviceOf(userId) };
}

async function workspaceOf(
  owner: Account,
  people: readonly Account[],
): Promise<WorkspaceId> {
  const workspaceId = newId<WorkspaceId>();
  await database()
    .insert(workspaces)
    .values({ id: workspaceId, name: "Team", createdByUserId: owner.userId });
  for (const [index, person] of [owner, ...people].entries()) {
    await database()
      .insert(workspaceMembers)
      .values({
        id: newId<MemberId>(),
        workspaceId,
        userId: person.userId,
        displayName: "Erin Example",
        role: index === 0 ? "owner" : "member",
        addedByUserId: owner.userId,
        claimedAt: NOW,
      });
  }
  return workspaceId;
}

type Project = Readonly<{
  workspaceId: WorkspaceId;
  projectId: ProjectId;
  repositoryId: RepositoryId;
}>;

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
  return { workspaceId, projectId, repositoryId };
}

async function agentOf(project: Project, owner: Account): Promise<AgentId> {
  const id = newId<AgentId>();
  await database().insert(agents).values({
    id,
    projectId: project.projectId,
    ownerUserId: owner.userId,
    hostDeviceId: owner.deviceId,
    name: "Erin's builder",
  });
  return id;
}

async function grantTo(
  project: Project,
  agentId: AgentId,
  owner: Account,
  revoked?: Readonly<{ at: Date; by: UserId }>,
  capability: "repo.read" | "repo.write" | "git.commit" = "repo.read",
): Promise<PermissionGrantId> {
  const id = newId<PermissionGrantId>();
  await database()
    .insert(permissionGrants)
    .values({
      id,
      projectId: project.projectId,
      granteeAgentId: agentId,
      hostDeviceId: owner.deviceId,
      capability,
      repositoryId: project.repositoryId,
      grantedByUserId: owner.userId,
      createdAt: NOW,
      ...(revoked === undefined
        ? {}
        : { revokedAt: revoked.at, revokedByUserId: revoked.by }),
    });
  return id;
}

function inOrder<T extends string>(...ids: T[]): T[] {
  return [...ids].sort();
}

const header = <Kind extends DisableNotification["kind"]>(
  kind: Kind,
  userId: UserId,
  at: Date = DISABLED_AT,
) => ({ v: 1 as const, kind, at: at.toISOString(), userId });

test("a disable notifies at its commit, in the order of the routes: the account, then each grant that it revoked in the order of their IDs, with IDs, times, and codes only; a disable that changes nothing notifies nothing", async () => {
  const db = database();
  const olga = await account("Olga");
  const erin = await account("Erin");
  const bob = await account("Bob");
  const team = await workspaceOf(olga, [erin, bob]);
  const other = await workspaceOf(olga, [erin]);
  const inTeam = await projectIn(team, olga);
  const inOther = await projectIn(other, olga);
  const builder = await agentOf(inTeam, erin);
  const reviewer = await agentOf(inOther, erin);
  const first = await grantTo(inTeam, builder, erin);
  const second = await grantTo(inTeam, builder, erin, undefined, "repo.write");
  const third = await grantTo(inOther, reviewer, erin);
  // Revoked before the disable: the disable does not revoke it again.
  await grantTo(inTeam, builder, erin, { at: NOW, by: erin.userId });
  // Bob's grant stays.
  const bobsAgent = await agentOf(inTeam, bob);
  const bobsGrant = await grantTo(inTeam, bobsAgent, bob);
  const run = newId<RunId>();
  await db.insert(agentRuns).values({
    id: run,
    agentId: builder,
    projectId: inTeam.projectId,
    requestedByUserId: erin.userId,
    state: "queued",
  });
  await drained();

  const result = await disableAccount(db, {
    userId: erin.userId,
    now: DISABLED_AT,
  });
  assert.ok(result.changed);
  const payloads = await drainedPayloads();
  const notified = payloads.map(
    (payload) => JSON.parse(payload) as DisableNotification,
  );
  const grantOf = new Map<
    PermissionGrantId,
    Readonly<{ workspaceId: WorkspaceId; agentId: AgentId }>
  >([
    [first, { workspaceId: team, agentId: builder }],
    [second, { workspaceId: team, agentId: builder }],
    [third, { workspaceId: other, agentId: reviewer }],
  ]);
  assert.deepEqual(notified, [
    header("account_disabled", erin.userId),
    ...inOrder(first, second, third).map((grantId) => ({
      ...header("disable_grant_revoked", erin.userId),
      workspaceId: grantOf.get(grantId)?.workspaceId,
      grantId,
      granteeAgentId: grantOf.get(grantId)?.agentId,
      revokedAt: DISABLED_AT.toISOString(),
    })),
  ]);
  assert.deepEqual(result.revokedGrantIds, inOrder(first, second, third));
  for (const payload of payloads) {
    for (const name of ["Erin", "Olga", "builder", "laptop"]) {
      assert.equal(payload.includes(name), false, payload);
    }
  }
  // A disable disables no agent and cancels no run, so nothing else is sent.
  const [agent] = await db
    .select({ disabledAt: agents.disabledAt })
    .from(agents)
    .where(eq(agents.id, builder));
  assert.equal(agent?.disabledAt, null);
  const [queued] = await db
    .select({ state: agentRuns.state })
    .from(agentRuns)
    .where(eq(agentRuns.id, run));
  assert.equal(queued?.state, "queued");
  const [kept] = await db
    .select({ revokedAt: permissionGrants.revokedAt })
    .from(permissionGrants)
    .where(eq(permissionGrants.id, bobsGrant));
  assert.equal(kept?.revokedAt, null);

  // A second disable and an unknown account change nothing and send nothing.
  for (const userId of [erin.userId, newId<UserId>()]) {
    const again = await disableAccount(db, {
      userId,
      now: DISABLED_AGAIN_AT,
    });
    assert.equal(again.changed, false);
  }
  assert.deepEqual(await drained(), []);

  // A disable of an account without agents sends the account alone.
  const mia = await account("Mia");
  assert.ok(
    (await disableAccount(db, { userId: mia.userId, now: DISABLED_AT }))
      .changed,
  );
  assert.deepEqual(await drained(), [header("account_disabled", mia.userId)]);
});

test("a disable that rolls back, as a transaction or as a savepoint, sends nothing", async () => {
  const db = database();
  const olga = await account("Olga");
  const erin = await account("Erin");
  const team = await workspaceOf(olga, [erin]);
  const project = await projectIn(team, olga);
  await grantTo(project, await agentOf(project, erin), erin);
  await drained();

  await assert.rejects(
    db.transaction(async (tx) => {
      const result = await disableAccount(tx, {
        userId: erin.userId,
        now: ROLLED_BACK_AT,
      });
      assert.ok(result.changed);
      throw new Error("roll back");
    }),
    /roll back/,
  );
  assert.deepEqual(await drained(), []);

  // The savepoint rolls back while the transaction around it commits.
  await db.transaction(async (tx) => {
    await assert.rejects(
      tx.transaction(async (savepoint) => {
        const result = await disableAccount(savepoint, {
          userId: erin.userId,
          now: ROLLED_BACK_AT,
        });
        assert.ok(result.changed);
        throw new Error("roll back the savepoint");
      }),
      /roll back the savepoint/,
    );
  });
  assert.deepEqual(await drained(), []);
  const [kept] = await db
    .select({ disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, erin.userId));
  assert.equal(kept?.disabledAt, null);
});

test("every notification of a disable stays far within the bound, and one over it throws instead of being sent", () => {
  const at = new Date("2026-11-25T23:59:59.999Z");
  const notifications = disableNotifications({
    userId: newId<UserId>(),
    now: at,
    revokedGrants: [
      {
        grantId: newId<PermissionGrantId>(),
        granteeAgentId: newId<AgentId>(),
        workspaceId: newId<WorkspaceId>(),
        revokedAt: at,
      },
    ],
  });
  assert.deepEqual(
    notifications.map((notification) => notification.kind),
    ["account_disabled", "disable_grant_revoked"],
  );
  for (const notification of notifications) {
    const payload = encodeErasureNotification(notification);
    assert.ok(
      Buffer.byteLength(payload) <= 400,
      `${notification.kind}: ${Buffer.byteLength(payload)} bytes`,
    );
  }
  const [, grant] = notifications;
  assert.ok(grant?.kind === "disable_grant_revoked");
  assert.throws(
    () =>
      encodeErasureNotification({
        ...grant,
        workspaceId: "w".repeat(8_000) as WorkspaceId,
      }),
    /a disable_grant_revoked notification is over 7999 bytes/,
  );
});

// The API's check of a disable's notification against the database
// (`src/erasure-check.ts`; #350): any role that can connect can send on the
// channel, so only what the database confirms is replayed.

const NOT_CONFIRMED = {
  confirmed: false,
  revokedDeviceIds: [],
  disabledAccountDeviceIds: [],
  approvers: [],
};

test("the database confirms every notification of a real disable, with the account's devices that are not revoked; it confirms none for an account that is not disabled, none for a grant of another account or another workspace, and none for a grant that the disable did not revoke", async () => {
  const db = database();
  const olga = await account("Olga");
  const erin = await account("Erin");
  const bob = await account("Bob");
  await deviceOf(erin.userId, NOW);
  const erinsDesktop = await deviceOf(erin.userId);
  const team = await workspaceOf(olga, [erin, bob]);
  const other = await workspaceOf(olga, [erin]);
  const inTeam = await projectIn(team, olga);
  const builder = await agentOf(inTeam, erin);
  const tester = await agentOf(inTeam, erin);
  await grantTo(inTeam, builder, erin);
  const bobsAgent = await agentOf(inTeam, bob);

  // Grants in the state that a disable leaves, or close to it, written
  // directly: none of them was revoked by Erin's disable.
  const erinsEarlier = await grantTo(inTeam, tester, erin, {
    at: NOW,
    by: erin.userId,
  });
  const erinsByOlga = await grantTo(inTeam, tester, erin, {
    at: DISABLED_AT,
    by: olga.userId,
  });
  const bobsByErin = await grantTo(inTeam, bobsAgent, bob, {
    at: DISABLED_AT,
    by: erin.userId,
  });
  const bobsOwn = await grantTo(inTeam, bobsAgent, bob, {
    at: DISABLED_AT,
    by: bob.userId,
  });

  await drained();
  const result = await disableAccount(db, {
    userId: erin.userId,
    now: DISABLED_AT,
  });
  assert.ok(result.changed);
  const notified = await drained();
  assert.deepEqual(
    notified.map((notification) => notification.kind),
    ["account_disabled", "disable_grant_revoked"],
  );

  // Every notification of the disable is confirmed; for the account, with
  // the devices that are not revoked.
  for (const notification of notified) {
    assert.deepEqual(
      await checkErasureNotification(db, notification),
      {
        ...NOT_CONFIRMED,
        confirmed: true,
        disabledAccountDeviceIds:
          notification.kind === "account_disabled"
            ? inOrder(erin.deviceId, erinsDesktop)
            : [],
      },
      notification.kind,
    );
  }

  // The same notifications naming Bob, who is not disabled, or an account
  // that does not exist, are confirmed by none.
  for (const userId of [bob.userId, newId<UserId>()]) {
    for (const notification of notified) {
      assert.deepEqual(
        await checkErasureNotification(db, { ...notification, userId }),
        NOT_CONFIRMED,
        `${notification.kind} naming another account`,
      );
    }
  }

  // Notifications that name Erin, whose disable is real, but a grant that
  // her disable did not revoke are confirmed by none: a grant of hers that
  // ended earlier or by someone else, Bob's grants, her real grant with
  // another agent of hers or in another workspace. Nor does her disable
  // confirm an erasure's notification about her.
  const [, real] = notified;
  assert.ok(real?.kind === "disable_grant_revoked");
  const grant = (
    grantId: PermissionGrantId,
    granteeAgentId: AgentId,
  ): OperatorNotification => ({
    ...header("disable_grant_revoked", erin.userId),
    workspaceId: team,
    grantId,
    granteeAgentId,
    revokedAt: DISABLED_AT.toISOString(),
  });
  const forged: OperatorNotification[] = [
    grant(erinsEarlier, tester),
    grant(erinsByOlga, tester),
    grant(bobsByErin, bobsAgent),
    grant(bobsOwn, bobsAgent),
    { ...real, granteeAgentId: tester },
    { ...real, workspaceId: other },
    {
      v: 1,
      kind: "account_erased",
      at: DISABLED_AT.toISOString(),
      userId: erin.userId,
    },
    {
      v: 1,
      kind: "grant_revoked",
      at: DISABLED_AT.toISOString(),
      userId: erin.userId,
      workspaceId: real.workspaceId,
      grantId: real.grantId,
      granteeAgentId: real.granteeAgentId,
      revokedAt: real.revokedAt,
    },
  ];
  for (const notification of forged) {
    assert.deepEqual(
      await checkErasureNotification(db, notification),
      NOT_CONFIRMED,
      notification.kind,
    );
  }

  // Once Erin is enabled, nothing of her disable is confirmed; disabled
  // again, only the new account notification is, as the earlier grant ended
  // at the earlier disable.
  assert.ok(
    (await enableAccount(db, { userId: erin.userId, now: DISABLED_AGAIN_AT }))
      .changed,
  );
  for (const notification of notified) {
    assert.deepEqual(
      await checkErasureNotification(db, notification),
      NOT_CONFIRMED,
      `${notification.kind} after the enable`,
    );
  }
  assert.ok(
    (
      await disableAccount(db, {
        userId: erin.userId,
        now: DISABLED_AGAIN_AT,
      })
    ).changed,
  );
  assert.deepEqual(await drained(), [
    header("account_disabled", erin.userId, DISABLED_AGAIN_AT),
  ]);
  assert.deepEqual(await checkErasureNotification(db, real), NOT_CONFIRMED);
});
