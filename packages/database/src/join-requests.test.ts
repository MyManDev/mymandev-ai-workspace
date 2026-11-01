import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  ApproveJoinRequestResponseSchema,
  CreateJoinRequestResponseSchema,
  type DeviceId,
  type JoinRequestId,
  JoinRequestListResponseSchema,
  type MemberId,
  newId,
  newUuidV7,
  OwnJoinRequestListResponseSchema,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import { createDatabase } from "./client.ts";
import type { Database } from "./db.ts";
import { acceptInvitation, createInvitation } from "./invitations.ts";
import {
  approveJoinRequest,
  type ApproveJoinRequestResult,
  blockJoinRequest,
  createJoinRequest,
  type CreateJoinRequestResult,
  denyAllJoinRequests,
  type DenyAllJoinRequestsResult,
  denyJoinRequest,
  listJoinRequests,
  listOwnJoinRequests,
  pauseJoinRequests,
  type PauseJoinRequestsResult,
  resumeJoinRequests,
  unblockJoinRequest,
  withdrawJoinRequest,
} from "./join-requests.ts";
import { createWorkspace, workspaceView } from "./membership.ts";
import { defineMember } from "./people.ts";
import {
  auditEvents,
  devices,
  userIdentities,
  users,
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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const LIFETIME_MS = 168 * HOUR_MS;
const NOW = new Date("2026-11-01T12:00:00.000Z");
const LATER = new Date("2026-11-01T13:00:00.000Z");
const GITHUB_CREATED = new Date("2015-06-01T10:00:00.000Z");

function at(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

type Account = Readonly<{ userId: UserId; deviceId: DeviceId }>;

let nextSubject = 8_000_000;

/** Accounts with one device each and a GitHub identity, all at once. */
async function accounts(n: number): Promise<Account[]> {
  const db = database();
  const created = Array.from({ length: n }, () => ({
    userId: newId<UserId>(),
    deviceId: newId<DeviceId>(),
  }));
  await db
    .insert(users)
    .values(created.map(({ userId }) => ({ id: userId, displayName: "Ada" })));
  await db.insert(devices).values(
    created.map(({ userId, deviceId }) => ({
      id: deviceId,
      userId,
      label: "Laptop",
      platform: "linux" as const,
      publicKey: randomBytes(32).toString("hex"),
      keyAlgorithm: "ed25519" as const,
      lastSignInAt: NOW,
    })),
  );
  await db.insert(userIdentities).values(
    created.map(({ userId }) => {
      nextSubject += 1;
      return {
        id: newUuidV7(),
        userId,
        identityProvider: "github" as const,
        subject: String(nextSubject),
        login: `user-${nextSubject}`,
        accountCreatedAt: GITHUB_CREATED,
        lastSignInAt: NOW,
      };
    }),
  );
  return created;
}

async function loginOf(who: Account): Promise<string> {
  const [row] = await database()
    .select({ login: userIdentities.login })
    .from(userIdentities)
    .where(eq(userIdentities.userId, who.userId));
  assert.ok(row?.login);
  return row.login;
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

/** Workspaces without people, for requests that only need a workspace row. */
async function bareWorkspaces(
  owner: Account,
  n: number,
): Promise<WorkspaceId[]> {
  const ids = Array.from({ length: n }, () => newId<WorkspaceId>());
  await database()
    .insert(workspaces)
    .values(
      ids.map((id) => ({ id, name: "Team", createdByUserId: owner.userId })),
    );
  return ids;
}

/** Adds the account as a claimed person of the workspace. */
async function addClaimed(
  workspaceId: WorkspaceId,
  who: Account,
  addedBy: Account,
  role: "admin" | "member" = "member",
): Promise<MemberId> {
  const id = newId<MemberId>();
  await database().insert(workspaceMembers).values({
    id,
    workspaceId,
    userId: who.userId,
    displayName: "Grace",
    role,
    addedByUserId: addedBy.userId,
    createdAt: NOW,
    claimedAt: NOW,
  });
  return id;
}

type RequestRow = typeof workspaceJoinRequests.$inferInsert;

/** Request rows written directly, by default pending, created an hour before `NOW`. */
async function insertRequests(
  rows: readonly (Partial<RequestRow> & {
    workspaceId: WorkspaceId;
    requester: Account;
  })[],
): Promise<JoinRequestId[]> {
  const values = rows.map(({ requester, ...row }) => {
    const createdAt = row.createdAt ?? at(-HOUR_MS);
    return {
      id: newId<JoinRequestId>(),
      requesterUserId: requester.userId,
      requesterDeviceId: requester.deviceId,
      requestedDisplayName: "Someone",
      expiresAt: new Date(createdAt.getTime() + LIFETIME_MS),
      ...row,
      createdAt,
    };
  });
  await database().insert(workspaceJoinRequests).values(values);
  return values.map((value) => value.id);
}

async function requestRow(id: JoinRequestId) {
  const [row] = await database()
    .select()
    .from(workspaceJoinRequests)
    .where(eq(workspaceJoinRequests.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function requestsOf(workspaceId: WorkspaceId) {
  return database()
    .select()
    .from(workspaceJoinRequests)
    .where(eq(workspaceJoinRequests.workspaceId, workspaceId))
    .orderBy(workspaceJoinRequests.id);
}

async function auditOf(workspaceId: WorkspaceId) {
  const rows = await database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(auditEvents.id);
  return rows
    .filter((row) => row.action !== "workspace.created")
    .map((row) => [
      row.action,
      row.actorUserId,
      row.actorDeviceId,
      row.subjectId,
      row.createdAt.toISOString(),
    ]);
}

function ask(
  who: Account,
  workspaceId: WorkspaceId,
  now: Date = NOW,
  displayName = "Ada",
) {
  return createJoinRequest(database(), {
    workspaceId,
    ...who,
    displayName,
    now,
  });
}

/** Asks and expects a new request. */
async function requested(
  who: Account,
  workspaceId: WorkspaceId,
  now: Date = NOW,
  displayName = "Ada",
) {
  const result = await ask(who, workspaceId, now, displayName);
  assert.ok(result.requested && result.created, JSON.stringify(result));
  return result.joinRequest;
}

function decision(
  actor: Account,
  workspaceId: WorkspaceId,
  joinRequestId: JoinRequestId,
  now: Date = LATER,
) {
  return { workspaceId, ...actor, joinRequestId, now };
}

test("a request stores the requested name and the device, expires after 7 days, and is audited; a second request while it is pending returns it unchanged", async () => {
  const [owner, guest] = await accounts(2);
  assert.ok(owner && guest);
  const { workspaceId } = await workspaceOf(owner);

  const first = await ask(guest, workspaceId);
  assert.ok(first.requested);
  assert.equal(first.created, true);
  const { joinRequest } = first;
  assert.deepEqual(CreateJoinRequestResponseSchema.parse({ joinRequest }), {
    joinRequest,
  });
  assert.deepEqual(joinRequest, {
    id: joinRequest.id,
    workspaceId,
    requestedDisplayName: "Ada",
    createdAt: NOW.toISOString(),
    expiresAt: at(LIFETIME_MS).toISOString(),
  });
  const row = await requestRow(joinRequest.id);
  assert.equal(row.requesterUserId, guest.userId);
  assert.equal(row.requesterDeviceId, guest.deviceId);
  assert.equal(row.decision, null);
  assert.equal(row.memberId, null);

  // Asking again, under another name, returns the pending request.
  const second = await ask(guest, workspaceId, LATER, "Someone else");
  assert.deepEqual(second, { requested: true, created: false, joinRequest });
  assert.equal((await requestsOf(workspaceId)).length, 1);
  assert.deepEqual(await auditOf(workspaceId), [
    [
      "join_request.created",
      guest.userId,
      guest.deviceId,
      joinRequest.id,
      NOW.toISOString(),
    ],
  ]);

  const own = await listOwnJoinRequests(database(), {
    userId: guest.userId,
    now: LATER,
  });
  assert.deepEqual(
    OwnJoinRequestListResponseSchema.parse({ joinRequests: own }).joinRequests,
    [{ ...joinRequest, decision: null, decidedAt: null }],
  );
  assert.deepEqual(
    await listOwnJoinRequests(database(), { userId: owner.userId, now: LATER }),
    [],
  );
});

test("an unknown or archived workspace is workspace_not_found and an active member already_member, and nothing is written", async () => {
  const [owner, guest] = await accounts(2);
  assert.ok(owner && guest);
  const { workspaceId } = await workspaceOf(owner);
  const [archived] = await bareWorkspaces(owner, 1);
  assert.ok(archived);
  await database()
    .update(workspaces)
    .set({ archivedAt: NOW })
    .where(eq(workspaces.id, archived));

  assert.deepEqual(await ask(guest, newId<WorkspaceId>()), {
    requested: false,
    refusal: "workspace_not_found",
  });
  assert.deepEqual(await ask(guest, archived), {
    requested: false,
    refusal: "workspace_not_found",
  });
  assert.deepEqual(await ask(owner, workspaceId), {
    requested: false,
    refusal: "already_member",
  });
  assert.deepEqual(await requestsOf(workspaceId), []);
  assert.deepEqual(await requestsOf(archived), []);
  assert.deepEqual(await auditOf(workspaceId), []);
});

test("a paused workspace and a block in force are join_requests_closed, a pending request stays and is returned, and a lifted block lets the account ask", async () => {
  const [owner, waiting, late, blocked] = await accounts(4);
  assert.ok(owner && waiting && late && blocked);
  const { workspaceId } = await workspaceOf(owner);
  const pending = await requested(waiting, workspaceId);

  await database()
    .update(workspaces)
    .set({ joinRequestsPausedAt: NOW })
    .where(eq(workspaces.id, workspaceId));
  assert.deepEqual(await ask(waiting, workspaceId, LATER), {
    requested: true,
    created: false,
    joinRequest: pending,
  });
  assert.deepEqual(await ask(late, workspaceId, LATER), {
    requested: false,
    refusal: "join_requests_closed",
  });
  await database()
    .update(workspaces)
    .set({ joinRequestsPausedAt: null })
    .where(eq(workspaces.id, workspaceId));

  const [block] = await insertRequests([
    {
      workspaceId,
      requester: blocked,
      decision: "blocked",
      decidedAt: at(-MINUTE_MS),
      decidedByUserId: owner.userId,
    },
  ]);
  assert.ok(block);
  const before = await requestsOf(workspaceId);
  assert.deepEqual(await ask(blocked, workspaceId, LATER), {
    requested: false,
    refusal: "join_requests_closed",
  });
  assert.deepEqual(await requestsOf(workspaceId), before);

  await database()
    .update(workspaceJoinRequests)
    .set({ unblockedAt: NOW, unblockedByUserId: owner.userId })
    .where(eq(workspaceJoinRequests.id, block));
  await requested(blocked, workspaceId, LATER);
  await requested(late, workspaceId, LATER);
});

test("the 6th pending request of an account is rate_limited until its first pending request expires; ended and expired requests do not count", async () => {
  const [owner, guest] = await accounts(2);
  assert.ok(owner && guest);
  const ids = await bareWorkspaces(owner, 8);
  const [w1, w2, w3, w4, w5, w6, w7, w8] = ids;
  assert.ok(w1 && w2 && w3 && w4 && w5 && w6 && w7 && w8);
  // Older than 24 hours, so that only the pending limit applies.
  const old = at(-2 * DAY_MS);
  await insertRequests([
    ...[w1, w2, w3, w4].map((workspaceId, index) => ({
      workspaceId,
      requester: guest,
      createdAt: new Date(old.getTime() + index * MINUTE_MS),
    })),
    {
      workspaceId: w5,
      requester: guest,
      createdAt: at(-8 * DAY_MS),
    },
    {
      workspaceId: w6,
      requester: guest,
      createdAt: old,
      decision: "withdrawn",
      decidedAt: old,
      decidedByUserId: guest.userId,
    },
  ]);

  await requested(guest, w5);
  const sixth = await ask(guest, w7);
  assert.deepEqual(sixth, {
    requested: false,
    refusal: "rate_limited",
    // The first pending request expires 7 days after it was created.
    retryAfterMs: old.getTime() + LIFETIME_MS - NOW.getTime(),
  });
  assert.deepEqual(await requestsOf(w7), []);
  // A pending request ends at the latest at its expiry.
  await requested(guest, w7, new Date(old.getTime() + LIFETIME_MS));
  const after = await ask(guest, w8, new Date(old.getTime() + LIFETIME_MS));
  assert.equal(after.requested, false);
});

test("the 11th request of an account within 24 hours is rate_limited until the oldest leaves the window", async () => {
  const [owner, guest] = await accounts(2);
  assert.ok(owner && guest);
  const ids = await bareWorkspaces(owner, 11);
  const target = ids[10];
  assert.ok(target);
  const oldest = at(-23 * HOUR_MS);
  await insertRequests(
    ids.slice(0, 10).map((workspaceId, index) => {
      const createdAt = new Date(oldest.getTime() + index * MINUTE_MS);
      return {
        workspaceId,
        requester: guest,
        createdAt,
        decision: "withdrawn" as const,
        decidedAt: createdAt,
        decidedByUserId: guest.userId,
      };
    }),
  );
  assert.deepEqual(await ask(guest, target), {
    requested: false,
    refusal: "rate_limited",
    retryAfterMs: HOUR_MS,
  });
  assert.deepEqual(await ask(guest, target, at(HOUR_MS - 1)), {
    requested: false,
    refusal: "rate_limited",
    retryAfterMs: 1,
  });
  await requested(guest, target, at(HOUR_MS));
});

test("the 51st pending request of a workspace is rate_limited until the first of them expires, rounded up to a full hour, and expired requests do not count", async () => {
  const [owner, first, second] = await accounts(3);
  assert.ok(owner && first && second);
  const { workspaceId } = await workspaceOf(owner);
  const others = await accounts(50);
  const created = at(-HOUR_MS);
  await insertRequests(
    others.map((requester, index) => ({
      workspaceId,
      requester,
      createdAt:
        index === 0
          ? at(-8 * DAY_MS)
          : new Date(created.getTime() + index * MINUTE_MS + 7_000),
    })),
  );
  // 49 pending and one past its expiry.
  await requested(first, workspaceId);
  const soonest = created.getTime() + MINUTE_MS + 7_000 + LIFETIME_MS;
  // The exact wait, 167 hours, 1 minute, and 7 seconds, would tell when
  // another account asked; the answer says 168 hours.
  assert.equal(soonest - NOW.getTime(), 167 * HOUR_MS + MINUTE_MS + 7_000);
  assert.deepEqual(await ask(second, workspaceId), {
    requested: false,
    refusal: "rate_limited",
    retryAfterMs: 168 * HOUR_MS,
  });
  // A wait that is a full number of hours stays as it is.
  assert.deepEqual(
    await ask(second, workspaceId, new Date(soonest - HOUR_MS)),
    {
      requested: false,
      refusal: "rate_limited",
      retryAfterMs: HOUR_MS,
    },
  );
  assert.deepEqual(await ask(second, workspaceId, new Date(soonest - 1)), {
    requested: false,
    refusal: "rate_limited",
    retryAfterMs: HOUR_MS,
  });
  await requested(second, workspaceId, new Date(soonest));
});

test("a denied account asks the same workspace again after 24 hours, and another workspace at once", async () => {
  const [owner, guest] = await accounts(2);
  assert.ok(owner && guest);
  const { workspaceId } = await workspaceOf(owner);
  const other = await workspaceOf(owner);
  const pending = await requested(guest, workspaceId);
  assert.deepEqual(
    await denyJoinRequest(
      database(),
      decision(owner, workspaceId, pending.id, NOW),
    ),
    { denied: true, requesterUserId: guest.userId },
  );

  assert.deepEqual(await ask(guest, workspaceId, at(HOUR_MS)), {
    requested: false,
    refusal: "rate_limited",
    retryAfterMs: 23 * HOUR_MS,
  });
  await requested(guest, other.workspaceId, at(HOUR_MS));
  await requested(guest, workspaceId, at(DAY_MS));
});

test("a pending request past its expiry is not pending: it is listed as expired, cannot be decided or withdrawn, and a new request marks it expired before it is stored", async () => {
  const [owner, guest] = await accounts(2);
  assert.ok(owner && guest);
  const { workspaceId } = await workspaceOf(owner);
  const old = await requested(guest, workspaceId);
  const expiry = at(LIFETIME_MS);
  const expired = {
    ...old,
    decision: "expired",
    decidedAt: old.expiresAt,
  } as const;

  assert.deepEqual(
    await listOwnJoinRequests(database(), {
      userId: guest.userId,
      now: expiry,
    }),
    [expired],
  );
  const listed = await listJoinRequests(database(), {
    workspaceId,
    userId: owner.userId,
    now: expiry,
  });
  assert.deepEqual(listed, { listed: true, joinRequests: [] });
  for (const result of [
    await approveJoinRequest(
      database(),
      decision(owner, workspaceId, old.id, expiry),
    ),
    await denyJoinRequest(
      database(),
      decision(owner, workspaceId, old.id, expiry),
    ),
    await withdrawJoinRequest(database(), {
      joinRequestId: old.id,
      ...guest,
      now: expiry,
    }),
  ]) {
    assert.equal("refusal" in result && result.refusal, "conflict");
  }
  assert.equal((await requestRow(old.id)).decision, null);

  const later = at(LIFETIME_MS + HOUR_MS);
  const fresh = await requested(guest, workspaceId, later, "Ada again");
  const marked = await requestRow(old.id);
  assert.equal(marked.decision, "expired");
  assert.deepEqual(marked.decidedAt, expiry);
  assert.equal(marked.decidedByUserId, null);
  assert.deepEqual(
    (await auditOf(workspaceId)).map(([action, , , subject]) => [
      action,
      subject,
    ]),
    [
      ["join_request.created", old.id],
      ["join_request.created", fresh.id],
    ],
    "an expiry writes no audit record",
  );
  assert.deepEqual(
    await listOwnJoinRequests(database(), {
      userId: guest.userId,
      now: later,
    }),
    [{ ...fresh, decision: null, decidedAt: null }, expired],
  );
});

test("the requester withdraws a pending request; another account's request and an unknown one are not_found, and a second withdrawal is a conflict", async () => {
  const [owner, guest, stranger] = await accounts(3);
  assert.ok(owner && guest && stranger);
  const { workspaceId } = await workspaceOf(owner);
  const pending = await requested(guest, workspaceId);

  for (const [who, joinRequestId] of [
    [stranger, pending.id],
    [owner, pending.id],
    [guest, newId<JoinRequestId>()],
  ] as const) {
    assert.deepEqual(
      await withdrawJoinRequest(database(), {
        joinRequestId,
        ...who,
        now: LATER,
      }),
      { withdrawn: false, refusal: "not_found" },
    );
  }
  assert.deepEqual(
    await withdrawJoinRequest(database(), {
      joinRequestId: pending.id,
      ...guest,
      now: LATER,
    }),
    { withdrawn: true, workspaceId },
  );
  const row = await requestRow(pending.id);
  assert.equal(row.decision, "withdrawn");
  assert.deepEqual(row.decidedAt, LATER);
  assert.equal(row.decidedByUserId, guest.userId);
  assert.deepEqual((await auditOf(workspaceId)).at(-1), [
    "join_request.withdrawn",
    guest.userId,
    guest.deviceId,
    pending.id,
    LATER.toISOString(),
  ]);

  assert.deepEqual(
    await withdrawJoinRequest(database(), {
      joinRequestId: pending.id,
      ...guest,
      now: LATER,
    }),
    { withdrawn: false, refusal: "conflict" },
  );
  assert.deepEqual(
    await approveJoinRequest(
      database(),
      decision(owner, workspaceId, pending.id),
    ),
    { approved: false, refusal: "conflict" },
  );
  assert.deepEqual(
    await listOwnJoinRequests(database(), {
      userId: guest.userId,
      now: LATER,
    }),
    [{ ...pending, decision: "withdrawn", decidedAt: LATER.toISOString() }],
  );
  // A withdrawal is no denial: the account may ask again at once.
  await requested(guest, workspaceId, LATER);
});

test("approving creates a claimed member with the requested or the approver's name, records the decision, and is audited", async () => {
  const [owner, admin, ada, bob] = await accounts(4);
  assert.ok(owner && admin && ada && bob);
  const { workspaceId } = await workspaceOf(owner);
  await addClaimed(workspaceId, admin, owner, "admin");
  const adaRequest = await requested(ada, workspaceId, NOW, "Ada");
  const bobRequest = await requested(bob, workspaceId, NOW, "Bob");

  const first = await approveJoinRequest(
    database(),
    decision(owner, workspaceId, adaRequest.id),
  );
  assert.ok(first.approved, JSON.stringify(first));
  assert.equal(first.requesterUserId, ada.userId);
  assert.deepEqual(
    ApproveJoinRequestResponseSchema.parse({ member: first.member }).member,
    {
      id: first.member.id,
      workspaceId,
      displayName: "Ada",
      role: "member",
      userId: ada.userId,
      identity: {
        provider: "github",
        login: await loginOf(ada),
        verifiedAt: NOW.toISOString(),
      },
      removedAt: null,
    },
  );
  const second = await approveJoinRequest(database(), {
    ...decision(admin, workspaceId, bobRequest.id),
    displayName: "Robert",
  });
  assert.ok(second.approved);
  assert.equal(second.member.displayName, "Robert");

  const row = await requestRow(adaRequest.id);
  assert.equal(row.decision, "approved");
  assert.deepEqual(row.decidedAt, LATER);
  assert.equal(row.decidedByUserId, owner.userId);
  assert.equal(row.memberId, first.member.id);
  const [person] = await database()
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.id, first.member.id));
  assert.equal(person?.addedByUserId, owner.userId);
  assert.deepEqual(person?.claimedAt, LATER);
  assert.deepEqual(person?.createdAt, LATER);

  assert.deepEqual((await auditOf(workspaceId)).slice(-4), [
    [
      "join_request.approved",
      owner.userId,
      owner.deviceId,
      adaRequest.id,
      LATER.toISOString(),
    ],
    [
      "member.claimed",
      owner.userId,
      owner.deviceId,
      first.member.id,
      LATER.toISOString(),
    ],
    [
      "join_request.approved",
      admin.userId,
      admin.deviceId,
      bobRequest.id,
      LATER.toISOString(),
    ],
    [
      "member.claimed",
      admin.userId,
      admin.deviceId,
      second.member.id,
      LATER.toISOString(),
    ],
  ]);
  const view = await workspaceView(database(), { workspaceId, now: LATER });
  assert.ok(view?.members.some((member) => member.id === first.member.id));
  assert.deepEqual(
    await listOwnJoinRequests(database(), { userId: ada.userId, now: LATER }),
    [{ ...adaRequest, decision: "approved", decidedAt: LATER.toISOString() }],
  );
  // The new member asks no more.
  assert.deepEqual(await ask(ada, workspaceId, LATER), {
    requested: false,
    refusal: "already_member",
  });
});

test("denying records the decision and is audited, and a second decision is a conflict", async () => {
  const [owner, guest] = await accounts(2);
  assert.ok(owner && guest);
  const { workspaceId } = await workspaceOf(owner);
  const pending = await requested(guest, workspaceId);
  assert.deepEqual(
    await denyJoinRequest(database(), decision(owner, workspaceId, pending.id)),
    { denied: true, requesterUserId: guest.userId },
  );
  const row = await requestRow(pending.id);
  assert.equal(row.decision, "denied");
  assert.deepEqual(row.decidedAt, LATER);
  assert.equal(row.decidedByUserId, owner.userId);
  assert.equal(row.memberId, null);
  assert.deepEqual((await auditOf(workspaceId)).at(-1), [
    "join_request.denied",
    owner.userId,
    owner.deviceId,
    pending.id,
    LATER.toISOString(),
  ]);
  for (const result of [
    await denyJoinRequest(database(), decision(owner, workspaceId, pending.id)),
    await approveJoinRequest(
      database(),
      decision(owner, workspaceId, pending.id),
    ),
  ]) {
    assert.equal("refusal" in result && result.refusal, "conflict");
  }
});

test("a member cannot list, approve, or deny; an account without an active person is not_member; a request of another workspace is not_found; nothing changes", async () => {
  const [owner, member, outsider, guest] = await accounts(4);
  assert.ok(owner && member && outsider && guest);
  const { workspaceId } = await workspaceOf(owner);
  const elsewhere = await workspaceOf(owner);
  await addClaimed(workspaceId, member, owner);
  const pending = await requested(guest, workspaceId);
  const before = await requestsOf(workspaceId);
  const audited = await auditOf(workspaceId);

  const cases: [Account, WorkspaceId, string][] = [
    [member, workspaceId, "forbidden"],
    [outsider, workspaceId, "not_member"],
    // The owner of another workspace names this request there.
    [owner, elsewhere.workspaceId, "not_found"],
  ];
  for (const [who, where, refusal] of cases) {
    const input = decision(who, where, pending.id);
    assert.deepEqual(await approveJoinRequest(database(), input), {
      approved: false,
      refusal,
    });
    assert.deepEqual(await denyJoinRequest(database(), input), {
      denied: false,
      refusal,
    });
  }
  assert.deepEqual(
    await listJoinRequests(database(), {
      workspaceId,
      userId: member.userId,
      now: LATER,
    }),
    { listed: false, refusal: "forbidden" },
  );
  assert.deepEqual(
    await listJoinRequests(database(), {
      workspaceId,
      userId: outsider.userId,
      now: LATER,
    }),
    { listed: false, refusal: "not_member" },
  );
  assert.deepEqual(await requestsOf(workspaceId), before);
  assert.deepEqual(await auditOf(workspaceId), audited);
});

test("a requester who became an active member is already_member and the request stays pending; a requester who was removed rejoins as a new person", async () => {
  const [owner, guest] = await accounts(2);
  assert.ok(owner && guest);
  const { workspaceId } = await workspaceOf(owner);
  const pending = await requested(guest, workspaceId);
  // As if the account had claimed an invitation meanwhile.
  const earlier = await addClaimed(workspaceId, guest, owner);
  assert.deepEqual(
    await approveJoinRequest(
      database(),
      decision(owner, workspaceId, pending.id),
    ),
    { approved: false, refusal: "already_member" },
  );
  assert.equal((await requestRow(pending.id)).decision, null);

  await database()
    .update(workspaceMembers)
    .set({ removedAt: NOW, removedByUserId: owner.userId })
    .where(eq(workspaceMembers.id, earlier));
  const result = await approveJoinRequest(
    database(),
    decision(owner, workspaceId, pending.id),
  );
  assert.ok(result.approved);
  assert.notEqual(result.member.id, earlier);
  const people = await database()
    .select({
      id: workspaceMembers.id,
      removedAt: workspaceMembers.removedAt,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, guest.userId))
    .orderBy(workspaceMembers.id);
  assert.deepEqual(people, [
    { id: earlier, removedAt: NOW },
    { id: result.member.id, removedAt: null },
  ]);
});

test("the approvers' list shows the pending requests with the GitHub login and the account's creation date, then the blocks in force, without the requests of active members or erased accounts; the requester sees a block as a denial", async () => {
  const [owner, ada, bob, expired, denied, blocked, lifted, erased, joined] =
    await accounts(9);
  assert.ok(
    owner &&
      ada &&
      bob &&
      expired &&
      denied &&
      blocked &&
      lifted &&
      erased &&
      joined,
  );
  const { workspaceId } = await workspaceOf(owner);
  const decided = {
    decidedAt: at(-MINUTE_MS),
    decidedByUserId: owner.userId,
  };
  const [adaId, bobId, , , blockId, , erasedBlockId, erasedPendingId] =
    await insertRequests([
      { workspaceId, requester: ada, createdAt: at(-2 * HOUR_MS) },
      { workspaceId, requester: bob, createdAt: at(-HOUR_MS) },
      { workspaceId, requester: expired, createdAt: at(-8 * DAY_MS) },
      { workspaceId, requester: denied, decision: "denied", ...decided },
      { workspaceId, requester: blocked, decision: "blocked", ...decided },
      {
        workspaceId,
        requester: lifted,
        decision: "blocked",
        ...decided,
        unblockedAt: NOW,
        unblockedByUserId: owner.userId,
      },
      {
        workspaceId,
        requester: erased,
        decision: "blocked",
        ...decided,
        createdAt: at(-3 * HOUR_MS),
      },
      { workspaceId, requester: erased, createdAt: at(-MINUTE_MS) },
      { workspaceId, requester: joined, createdAt: at(-MINUTE_MS) },
    ]);
  assert.ok(adaId && bobId && blockId && erasedBlockId && erasedPendingId);
  // An account that joined meanwhile, as by an invitation, has nothing left
  // to approve.
  await addClaimed(workspaceId, joined, owner);
  await database()
    .update(userIdentities)
    .set({
      erasedAt: NOW,
      subject: null,
      login: null,
      accountCreatedAt: null,
    })
    .where(eq(userIdentities.userId, erased.userId));

  const result = await listJoinRequests(database(), {
    workspaceId,
    userId: owner.userId,
    now: NOW,
  });
  assert.ok(result.listed);
  const parsed = JoinRequestListResponseSchema.parse({
    joinRequests: result.joinRequests,
  });
  const identity = async (who: Account) => ({
    provider: "github",
    login: await loginOf(who),
    verifiedAt: NOW.toISOString(),
    accountCreatedAt: GITHUB_CREATED.toISOString(),
  });
  assert.deepEqual(
    parsed.joinRequests.map((request) => [
      request.id,
      request.decision,
      request.requester,
    ]),
    [
      [bobId, null, await identity(bob)],
      [adaId, null, await identity(ada)],
      [blockId, "blocked", await identity(blocked)],
      // An erased account's block stays, without a requester; its pending
      // request is left out, and so is the request of an active member.
      [erasedBlockId, "blocked", null],
    ],
  );

  assert.deepEqual(
    (
      await listOwnJoinRequests(database(), {
        userId: blocked.userId,
        now: NOW,
      })
    ).map((request) => [request.decision, request.decidedAt]),
    [["denied", decided.decidedAt.toISOString()]],
  );
});

/** The actor of an action on the join requests of a whole workspace. */
function workspaceAction(
  actor: Account,
  workspaceId: WorkspaceId,
  now: Date = LATER,
) {
  return { workspaceId, ...actor, now };
}

async function workspaceRow(workspaceId: WorkspaceId) {
  const [row] = await database()
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  assert.ok(row !== undefined);
  return row;
}

test("the owner or an admin blocks a pending request: the requester sees a denial and asks in vain until the owner or an admin lifts the block, and then asks again at once", async () => {
  const [owner, admin, guest] = await accounts(3);
  assert.ok(owner && admin && guest);
  const { workspaceId } = await workspaceOf(owner);
  await addClaimed(workspaceId, admin, owner, "admin");
  let pending = await requested(guest, workspaceId);
  const blocks: JoinRequestId[] = [];

  for (const [blocker, lifter, when] of [
    [owner, admin, LATER],
    [admin, owner, at(2 * HOUR_MS)],
  ] as const) {
    blocks.push(pending.id);
    assert.deepEqual(
      await blockJoinRequest(
        database(),
        decision(blocker, workspaceId, pending.id, when),
      ),
      { blocked: true, requesterUserId: guest.userId },
    );
    const row = await requestRow(pending.id);
    assert.equal(row.decision, "blocked");
    assert.deepEqual(row.decidedAt, when);
    assert.equal(row.decidedByUserId, blocker.userId);
    assert.equal(row.unblockedAt, null);

    // The requester sees a denial and cannot ask again.
    const [own] = await listOwnJoinRequests(database(), {
      userId: guest.userId,
      now: when,
    });
    assert.deepEqual(
      [own?.id, own?.decision, own?.decidedAt],
      [pending.id, "denied", when.toISOString()],
    );
    assert.deepEqual(await ask(guest, workspaceId, when), {
      requested: false,
      refusal: "join_requests_closed",
    });
    // The approvers see the block in force.
    const listed = await listJoinRequests(database(), {
      workspaceId,
      userId: lifter.userId,
      now: when,
    });
    assert.ok(listed.listed);
    assert.deepEqual(
      listed.joinRequests.map((request) => [request.id, request.decision]),
      [[pending.id, "blocked"]],
    );
    // A blocked request is no longer pending.
    for (const result of [
      await blockJoinRequest(
        database(),
        decision(lifter, workspaceId, pending.id, when),
      ),
      await denyJoinRequest(
        database(),
        decision(lifter, workspaceId, pending.id, when),
      ),
      await approveJoinRequest(
        database(),
        decision(lifter, workspaceId, pending.id, when),
      ),
    ]) {
      assert.equal("refusal" in result && result.refusal, "conflict");
    }

    assert.deepEqual(
      await unblockJoinRequest(
        database(),
        decision(lifter, workspaceId, pending.id, when),
      ),
      { unblocked: true },
    );
    const lifted = await requestRow(pending.id);
    assert.equal(lifted.decision, "blocked");
    assert.deepEqual(lifted.unblockedAt, when);
    assert.equal(lifted.unblockedByUserId, lifter.userId);
    assert.deepEqual(
      await unblockJoinRequest(
        database(),
        decision(blocker, workspaceId, pending.id, when),
      ),
      { unblocked: false, refusal: "conflict" },
    );
    // The requester still sees a denial, but a lifted block starts no
    // 24-hour wait: the account asks again at once.
    const [still] = await listOwnJoinRequests(database(), {
      userId: guest.userId,
      now: when,
    });
    assert.equal(still?.decision, "denied");
    pending = await requested(guest, workspaceId, when);
  }

  const [first, second] = blocks;
  assert.ok(first && second);
  assert.deepEqual(
    (await auditOf(workspaceId)).filter(
      ([action]) => action !== "join_request.created",
    ),
    [
      [
        "join_request.blocked",
        owner.userId,
        owner.deviceId,
        first,
        LATER.toISOString(),
      ],
      [
        "join_request.unblocked",
        admin.userId,
        admin.deviceId,
        first,
        LATER.toISOString(),
      ],
      [
        "join_request.blocked",
        admin.userId,
        admin.deviceId,
        second,
        at(2 * HOUR_MS).toISOString(),
      ],
      [
        "join_request.unblocked",
        owner.userId,
        owner.deviceId,
        second,
        at(2 * HOUR_MS).toISOString(),
      ],
    ],
  );
});

test("a member cannot block, unblock, deny all, pause, or resume; an account without an active person is not_member; a request of another workspace or an unknown one is not_found; a request in the wrong state is a conflict; nothing changes", async () => {
  const [owner, member, outsider, guest, blocked, denied] = await accounts(6);
  assert.ok(owner && member && outsider && guest && blocked && denied);
  const { workspaceId } = await workspaceOf(owner);
  const elsewhere = await workspaceOf(owner);
  await addClaimed(workspaceId, member, owner);
  const pending = await requested(guest, workspaceId);
  const decided = { decidedAt: at(-MINUTE_MS), decidedByUserId: owner.userId };
  const [block, denial, expired] = await insertRequests([
    { workspaceId, requester: blocked, decision: "blocked", ...decided },
    { workspaceId, requester: denied, decision: "denied", ...decided },
    { workspaceId, requester: denied, createdAt: at(-8 * DAY_MS) },
  ]);
  assert.ok(block && denial && expired);
  const before = await requestsOf(workspaceId);
  const audited = await auditOf(workspaceId);

  const cases: [Account, WorkspaceId, JoinRequestId, string][] = [
    [member, workspaceId, pending.id, "forbidden"],
    [outsider, workspaceId, pending.id, "not_member"],
    // The owner of another workspace names this request there.
    [owner, elsewhere.workspaceId, pending.id, "not_found"],
    [owner, workspaceId, newId<JoinRequestId>(), "not_found"],
    // Only a pending request can be blocked.
    [owner, workspaceId, denial, "conflict"],
    [owner, workspaceId, expired, "conflict"],
  ];
  for (const [who, where, joinRequestId, refusal] of cases) {
    assert.deepEqual(
      await blockJoinRequest(database(), decision(who, where, joinRequestId)),
      { blocked: false, refusal },
      `block: ${refusal}`,
    );
  }
  const unblockCases: [Account, WorkspaceId, JoinRequestId, string][] = [
    [member, workspaceId, block, "forbidden"],
    [outsider, workspaceId, block, "not_member"],
    [owner, elsewhere.workspaceId, block, "not_found"],
    [owner, workspaceId, newId<JoinRequestId>(), "not_found"],
    // Only a block in force can be lifted.
    [owner, workspaceId, pending.id, "conflict"],
    [owner, workspaceId, denial, "conflict"],
  ];
  for (const [who, where, joinRequestId, refusal] of unblockCases) {
    assert.deepEqual(
      await unblockJoinRequest(database(), decision(who, where, joinRequestId)),
      { unblocked: false, refusal },
      `unblock: ${refusal}`,
    );
  }

  for (const [who, refusal] of [
    [member, "forbidden"],
    [outsider, "not_member"],
  ] as const) {
    const input = workspaceAction(who, workspaceId);
    assert.deepEqual(await denyAllJoinRequests(database(), input), {
      denied: false,
      refusal,
    });
    assert.deepEqual(await pauseJoinRequests(database(), input), {
      paused: false,
      refusal,
    });
  }
  assert.equal((await workspaceRow(workspaceId)).joinRequestsPausedAt, null);
  // Resuming is refused too, also while the workspace is paused.
  await database()
    .update(workspaces)
    .set({ joinRequestsPausedAt: NOW })
    .where(eq(workspaces.id, workspaceId));
  for (const [who, refusal] of [
    [member, "forbidden"],
    [outsider, "not_member"],
  ] as const) {
    assert.deepEqual(
      await resumeJoinRequests(database(), workspaceAction(who, workspaceId)),
      { resumed: false, refusal },
    );
  }
  assert.deepEqual((await workspaceRow(workspaceId)).joinRequestsPausedAt, NOW);
  assert.deepEqual(await requestsOf(workspaceId), before);
  assert.deepEqual(await auditOf(workspaceId), audited);
});

test("denying all denies every pending request of the workspace with one audit record each, in the order of their IDs, also those that the approvers' list leaves out, and leaves ended, expired, and other workspaces' requests as they are", async () => {
  const [
    owner,
    admin,
    ada,
    bob,
    eve,
    joined,
    erased,
    expired,
    denied,
    blocked,
    other,
  ] = await accounts(11);
  assert.ok(
    owner &&
      admin &&
      ada &&
      bob &&
      eve &&
      joined &&
      erased &&
      expired &&
      denied &&
      blocked &&
      other,
  );
  const { workspaceId } = await workspaceOf(owner);
  const elsewhere = await workspaceOf(owner);
  await addClaimed(workspaceId, admin, owner, "admin");
  // IDs made in ascending order and stored in descending order, so that
  // the order of the rows on disk is not the order of their IDs.
  const pendingIds = Array.from({ length: 5 }, () => newId<JoinRequestId>());
  const pendingOf = [ada, bob, eve, joined, erased] as const;
  const stored = pendingOf.map((requester, index) => {
    const id = pendingIds[pendingIds.length - 1 - index];
    assert.ok(id);
    return { id, requester };
  });
  await insertRequests(
    stored.map(({ id, requester }) => ({ id, workspaceId, requester })),
  );
  const decided = { decidedAt: at(-MINUTE_MS), decidedByUserId: owner.userId };
  const [expiredId, deniedId, blockedId, otherId] = await insertRequests([
    { workspaceId, requester: expired, createdAt: at(-8 * DAY_MS) },
    { workspaceId, requester: denied, decision: "denied", ...decided },
    { workspaceId, requester: blocked, decision: "blocked", ...decided },
    { workspaceId: elsewhere.workspaceId, requester: other },
  ]);
  assert.ok(expiredId && deniedId && blockedId && otherId);
  // The approvers' list leaves out an active member's request and that of
  // an erased account; denying all denies them too.
  await addClaimed(workspaceId, joined, owner);
  await database()
    .update(userIdentities)
    .set({
      erasedAt: NOW,
      subject: null,
      login: null,
      accountCreatedAt: null,
    })
    .where(eq(userIdentities.userId, erased.userId));
  const listed = await listJoinRequests(database(), {
    workspaceId,
    userId: admin.userId,
    now: LATER,
  });
  assert.ok(listed.listed);
  assert.equal(listed.joinRequests.length, 4, "three pending and one block");
  const untouched = await Promise.all(
    [expiredId, deniedId, blockedId, otherId].map(requestRow),
  );
  const expected = [...stored].reverse().map(({ id, requester }) => ({
    joinRequestId: id,
    requesterUserId: requester.userId,
  }));
  assert.deepEqual(
    expected.map(({ joinRequestId }) => joinRequestId),
    pendingIds,
  );

  assert.deepEqual(
    await denyAllJoinRequests(database(), workspaceAction(admin, workspaceId)),
    { denied: true, joinRequests: expected },
  );
  for (const { joinRequestId } of expected) {
    const row = await requestRow(joinRequestId);
    assert.equal(row.decision, "denied");
    assert.deepEqual(row.decidedAt, LATER);
    assert.equal(row.decidedByUserId, admin.userId);
  }
  assert.deepEqual(
    await Promise.all(
      [expiredId, deniedId, blockedId, otherId].map(requestRow),
    ),
    untouched,
  );
  assert.deepEqual(
    await auditOf(workspaceId),
    expected.map(({ joinRequestId }) => [
      "join_request.denied",
      admin.userId,
      admin.deviceId,
      joinRequestId,
      LATER.toISOString(),
    ]),
  );
  assert.deepEqual(await auditOf(elsewhere.workspaceId), []);
  // As after a denial, the requester sees `denied` and waits 24 hours.
  const [own] = await listOwnJoinRequests(database(), {
    userId: ada.userId,
    now: LATER,
  });
  assert.deepEqual(
    [own?.decision, own?.decidedAt],
    ["denied", LATER.toISOString()],
  );
  assert.deepEqual(await ask(ada, workspaceId, LATER), {
    requested: false,
    refusal: "rate_limited",
    retryAfterMs: DAY_MS,
  });

  // The owner denies all too; with nothing pending, nothing is written.
  const late = await requested(other, workspaceId, LATER);
  const third = at(2 * HOUR_MS);
  assert.deepEqual(
    await denyAllJoinRequests(
      database(),
      workspaceAction(owner, workspaceId, third),
    ),
    {
      denied: true,
      joinRequests: [{ joinRequestId: late.id, requesterUserId: other.userId }],
    },
  );
  const audited = await auditOf(workspaceId);
  assert.deepEqual(audited.at(-1), [
    "join_request.denied",
    owner.userId,
    owner.deviceId,
    late.id,
    third.toISOString(),
  ]);
  assert.deepEqual(
    await denyAllJoinRequests(
      database(),
      workspaceAction(owner, workspaceId, third),
    ),
    { denied: true, joinRequests: [] },
  );
  assert.deepEqual(await auditOf(workspaceId), audited);
});

test("the owner or an admin pauses: pending requests stay and can be decided, a new request is join_requests_closed, until the owner or an admin resumes; pausing a paused and resuming an open workspace change nothing", async () => {
  const [owner, admin, waiting, approved, late] = await accounts(5);
  assert.ok(owner && admin && waiting && approved && late);
  const { workspaceId } = await workspaceOf(owner);
  await addClaimed(workspaceId, admin, owner, "admin");
  const pending = await requested(waiting, workspaceId);
  const toApprove = await requested(approved, workspaceId);
  const view = async () =>
    (await workspaceView(database(), { workspaceId, now: LATER }))
      ?.joinRequestsPausedAt;

  const rounds = [
    [owner, admin, LATER, at(3 * HOUR_MS)],
    [admin, owner, at(4 * HOUR_MS), at(5 * HOUR_MS)],
  ] as const;
  for (const [pauser, resumer, pausedAt, resumedAt] of rounds) {
    assert.deepEqual(
      await pauseJoinRequests(
        database(),
        workspaceAction(pauser, workspaceId, pausedAt),
      ),
      { paused: true, changed: true },
    );
    assert.equal(await view(), pausedAt.toISOString());
    assert.deepEqual((await workspaceRow(workspaceId)).updatedAt, pausedAt);
    // Pausing again keeps the first pause.
    assert.deepEqual(
      await pauseJoinRequests(
        database(),
        workspaceAction(
          resumer,
          workspaceId,
          new Date(pausedAt.getTime() + MINUTE_MS),
        ),
      ),
      { paused: true, changed: false },
    );
    assert.equal(await view(), pausedAt.toISOString());

    // A new request is closed; the pending request stays and is returned.
    assert.deepEqual(await ask(late, workspaceId, pausedAt), {
      requested: false,
      refusal: "join_requests_closed",
    });
    assert.deepEqual(await ask(waiting, workspaceId, pausedAt), {
      requested: true,
      created: false,
      joinRequest: pending,
    });

    assert.deepEqual(
      await resumeJoinRequests(
        database(),
        workspaceAction(resumer, workspaceId, resumedAt),
      ),
      { resumed: true, changed: true },
    );
    assert.equal(await view(), null);
    assert.deepEqual((await workspaceRow(workspaceId)).updatedAt, resumedAt);
    assert.deepEqual(
      await resumeJoinRequests(
        database(),
        workspaceAction(pauser, workspaceId, resumedAt),
      ),
      { resumed: true, changed: false },
    );
  }

  // A pending request can be decided while requests are paused.
  await pauseJoinRequests(
    database(),
    workspaceAction(owner, workspaceId, at(6 * HOUR_MS)),
  );
  const approval = await approveJoinRequest(
    database(),
    decision(admin, workspaceId, toApprove.id, at(6 * HOUR_MS)),
  );
  assert.equal(approval.approved, true);
  assert.equal((await requestRow(pending.id)).decision, null);
  await resumeJoinRequests(
    database(),
    workspaceAction(owner, workspaceId, at(7 * HOUR_MS)),
  );
  await requested(late, workspaceId, at(7 * HOUR_MS));

  assert.deepEqual(
    (await auditOf(workspaceId))
      .filter(([action]) => String(action).startsWith("join_requests."))
      .map(([action, actor, , subject, createdAt]) => [
        action,
        actor,
        subject,
        createdAt,
      ]),
    [
      ["join_requests.paused", owner.userId, workspaceId, LATER.toISOString()],
      [
        "join_requests.resumed",
        admin.userId,
        workspaceId,
        at(3 * HOUR_MS).toISOString(),
      ],
      [
        "join_requests.paused",
        admin.userId,
        workspaceId,
        at(4 * HOUR_MS).toISOString(),
      ],
      [
        "join_requests.resumed",
        owner.userId,
        workspaceId,
        at(5 * HOUR_MS).toISOString(),
      ],
      [
        "join_requests.paused",
        owner.userId,
        workspaceId,
        at(6 * HOUR_MS).toISOString(),
      ],
      [
        "join_requests.resumed",
        owner.userId,
        workspaceId,
        at(7 * HOUR_MS).toISOString(),
      ],
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

test(
  "of two concurrent approvals of one request, by the owner and an admin, exactly one creates a person",
  SERVER_ONLY,
  async () => {
    const [owner, admin, guest] = await accounts(3);
    assert.ok(owner && admin && guest);
    const { workspaceId } = await workspaceOf(owner);
    await addClaimed(workspaceId, admin, owner, "admin");
    const pending = await requested(guest, workspaceId);

    const results = await Promise.all(
      [owner, admin].map((who) =>
        approveJoinRequest(database(), decision(who, workspaceId, pending.id)),
      ),
    );
    assert.deepEqual(results.map((result) => result.approved).sort(), [
      false,
      true,
    ]);
    const refused = results.find((result) => !result.approved);
    assert.deepEqual(refused, { approved: false, refusal: "conflict" });
    const people = await database()
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, guest.userId));
    assert.equal(people.length, 1);
    assert.equal(
      (await auditOf(workspaceId)).filter(
        ([action]) => action === "join_request.approved",
      ).length,
      1,
    );
  },
);

test(
  "a withdrawal waits for an approval that holds the request, and is then a conflict",
  SERVER_ONLY,
  async () => {
    const url = testDatabase?.url;
    assert.ok(url, "the test database is on a server");
    const [owner, guest] = await accounts(2);
    assert.ok(owner && guest);
    const { workspaceId } = await workspaceOf(owner);
    const pending = await requested(guest, workspaceId);

    // A second session approves and keeps its transaction open.
    const other = createDatabase(url, { max: 1 });
    const holding = Promise.withResolvers<ApproveJoinRequestResult>();
    const release = Promise.withResolvers<void>();
    const approving = other.db.transaction(async (tx) => {
      holding.resolve(
        await approveJoinRequest(tx, decision(owner, workspaceId, pending.id)),
      );
      await release.promise;
    });
    try {
      const approval = await Promise.race([
        holding.promise,
        approving.then(() => {
          throw new Error("the approval ended early");
        }),
      ]);
      assert.equal(approval.approved, true);
      const withdrawal = withdrawJoinRequest(database(), {
        joinRequestId: pending.id,
        ...guest,
        now: LATER,
      });
      let settled = false;
      withdrawal.then(
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
      assert.equal(waited, true, "the withdrawal waits for the request's lock");
      release.resolve();
      await approving;
      assert.deepEqual(await withdrawal, {
        withdrawn: false,
        refusal: "conflict",
      });
    } finally {
      release.resolve();
      await approving.catch(() => undefined);
      await other.close();
    }
    const row = await requestRow(pending.id);
    assert.equal(row.decision, "approved");
    assert.ok(row.memberId !== null);
  },
);

/**
 * Runs `first` in a transaction of a second session and keeps it open while
 * `action` starts in this session. Returns the action's result after the
 * held transaction committed, and whether the action waited for a lock.
 */
async function whileHeld<T>(
  first: (tx: Database) => Promise<unknown>,
  action: () => Promise<T>,
): Promise<Readonly<{ result: T; waited: boolean }>> {
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
    release.resolve();
    await held;
    return { result: await running, waited };
  } finally {
    release.resolve();
    await held.catch(() => undefined);
    await other.close();
  }
}

test(
  "a second request of one account waits for the first, which holds the account's row, and returns the request that the first stored",
  SERVER_ONLY,
  async () => {
    const [owner, guest] = await accounts(2);
    assert.ok(owner && guest);
    const { workspaceId } = await workspaceOf(owner);
    let first: CreateJoinRequestResult | undefined;
    const { result, waited } = await whileHeld(
      async (tx) => {
        first = await createJoinRequest(tx, {
          workspaceId,
          ...guest,
          displayName: "Ada",
          now: NOW,
        });
      },
      () => ask(guest, workspaceId, NOW, "Ada again"),
    );
    assert.equal(waited, true, "the second request waits for a lock");
    assert.ok(first?.requested && first.created);
    assert.deepEqual(result, {
      requested: true,
      created: false,
      joinRequest: first.joinRequest,
    });
    assert.equal((await requestsOf(workspaceId)).length, 1);
  },
);

test(
  "at the limit of 50 pending requests, a request of another account waits for an open request in the workspace and then counts it",
  SERVER_ONLY,
  async () => {
    const [owner, first, second] = await accounts(3);
    assert.ok(owner && first && second);
    const { workspaceId } = await workspaceOf(owner);
    const others = await accounts(49);
    await insertRequests(
      others.map((requester, index) => ({
        workspaceId,
        requester,
        createdAt: new Date(at(-HOUR_MS).getTime() + index * MINUTE_MS),
      })),
    );
    // The two requests lock different accounts and different request rows,
    // so only the workspace row can make the second one wait. Without that
    // lock it would count 49 pending requests and store a 51st.
    let fiftieth: CreateJoinRequestResult | undefined;
    const { result, waited } = await whileHeld(
      async (tx) => {
        fiftieth = await createJoinRequest(tx, {
          workspaceId,
          ...first,
          displayName: "Ada",
          now: NOW,
        });
      },
      () => ask(second, workspaceId),
    );
    assert.ok(fiftieth?.requested && fiftieth.created);
    assert.equal(waited, true, "the second request waits for a lock");
    assert.deepEqual(result, {
      requested: false,
      refusal: "rate_limited",
      retryAfterMs: 167 * HOUR_MS,
    });
    const pending = (await requestsOf(workspaceId)).filter(
      (row) => row.decision === null,
    );
    assert.equal(pending.length, 50);
  },
);

test(
  "a request waits for an approval that holds the account's pending request, and then answers already_member",
  SERVER_ONLY,
  async () => {
    const [owner, guest] = await accounts(2);
    assert.ok(owner && guest);
    const { workspaceId } = await workspaceOf(owner);
    const pending = await requested(guest, workspaceId);
    let approval: ApproveJoinRequestResult | undefined;
    const { result, waited } = await whileHeld(
      async (tx) => {
        approval = await approveJoinRequest(
          tx,
          decision(owner, workspaceId, pending.id),
        );
      },
      () => ask(guest, workspaceId, LATER),
    );
    assert.equal(approval?.approved, true);
    assert.equal(waited, true, "the request waits for the request row");
    assert.deepEqual(result, {
      requested: false,
      refusal: "already_member",
    });
    const rows = await requestsOf(workspaceId);
    assert.deepEqual(
      rows.map((row) => [row.id, row.decision]),
      [[pending.id, "approved"]],
    );
  },
);

test(
  "an approval that runs while the requester claims an invitation of the workspace waits for the claim and answers already_member; the request stays pending",
  SERVER_ONLY,
  async () => {
    const [owner, guest] = await accounts(2);
    assert.ok(owner && guest);
    const { workspaceId } = await workspaceOf(owner);
    const pending = await requested(guest, workspaceId);
    const defined = await defineMember(database(), {
      workspaceId,
      ...owner,
      displayName: "Linus",
      now: NOW,
    });
    assert.ok(defined.defined);
    const tokenHash = randomBytes(32).toString("hex");
    const invitation = await createInvitation(database(), {
      workspaceId,
      ...owner,
      memberId: defined.member.id,
      tokenHash,
      now: NOW,
    });
    assert.ok(invitation.created);

    // The approval does not see the uncommitted claim, so the unique index
    // of one active person per account and workspace makes it wait and then
    // refuses its new person.
    const { result, waited } = await whileHeld(
      async (tx) => {
        const accepted = await acceptInvitation(tx, {
          tokenHash,
          ...guest,
          now: LATER,
        });
        assert.equal(accepted.accepted, true);
      },
      () =>
        approveJoinRequest(
          database(),
          decision(owner, workspaceId, pending.id),
        ),
    );
    assert.equal(waited, true, "the approval waits for the claim");
    assert.deepEqual(result, { approved: false, refusal: "already_member" });
    const row = await requestRow(pending.id);
    assert.equal(row.decision, null);
    assert.equal(row.memberId, null);
    const people = await database()
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, guest.userId));
    assert.deepEqual(people, [{ id: defined.member.id }]);
  },
);

test(
  "denying all waits for an approval that holds one of the requests, and then denies only the others",
  SERVER_ONLY,
  async () => {
    const [owner, admin, ada, bob, eve] = await accounts(5);
    assert.ok(owner && admin && ada && bob && eve);
    const { workspaceId } = await workspaceOf(owner);
    await addClaimed(workspaceId, admin, owner, "admin");
    const [adaId, bobId, eveId] = await insertRequests(
      [ada, bob, eve].map((requester) => ({ workspaceId, requester })),
    );
    assert.ok(adaId && bobId && eveId);

    // The approval holds the middle request, so denying all, which locks
    // the requests in the order of their IDs, waits there.
    let approval: ApproveJoinRequestResult | undefined;
    const { result, waited } = await whileHeld(
      async (tx) => {
        approval = await approveJoinRequest(
          tx,
          decision(admin, workspaceId, bobId),
        );
      },
      () =>
        denyAllJoinRequests(database(), workspaceAction(owner, workspaceId)),
    );
    assert.equal(approval?.approved, true);
    assert.equal(waited, true, "denying all waits for the request's lock");
    assert.deepEqual(result, {
      denied: true,
      joinRequests: [
        { joinRequestId: adaId, requesterUserId: ada.userId },
        { joinRequestId: eveId, requesterUserId: eve.userId },
      ],
    });
    assert.deepEqual(
      (await requestsOf(workspaceId)).map((row) => [row.id, row.decision]),
      [
        [adaId, "denied"],
        [bobId, "approved"],
        [eveId, "denied"],
      ],
    );
    assert.deepEqual(
      (await auditOf(workspaceId))
        .filter(([action]) => String(action).startsWith("join_request."))
        .map(([action, , , subject]) => [action, subject]),
      [
        ["join_request.approved", bobId],
        ["join_request.denied", adaId],
        ["join_request.denied", eveId],
      ],
    );
  },
);

test(
  "an approval waits for denying all, which holds the request, and is then a conflict",
  SERVER_ONLY,
  async () => {
    const [owner, admin, guest] = await accounts(3);
    assert.ok(owner && admin && guest);
    const { workspaceId } = await workspaceOf(owner);
    await addClaimed(workspaceId, admin, owner, "admin");
    const pending = await requested(guest, workspaceId);

    let denial: DenyAllJoinRequestsResult | undefined;
    const { result, waited } = await whileHeld(
      async (tx) => {
        denial = await denyAllJoinRequests(
          tx,
          workspaceAction(owner, workspaceId),
        );
      },
      () =>
        approveJoinRequest(
          database(),
          decision(admin, workspaceId, pending.id),
        ),
    );
    assert.deepEqual(denial, {
      denied: true,
      joinRequests: [
        { joinRequestId: pending.id, requesterUserId: guest.userId },
      ],
    });
    assert.equal(waited, true, "the approval waits for the request's lock");
    assert.deepEqual(result, { approved: false, refusal: "conflict" });
    assert.equal((await requestRow(pending.id)).decision, "denied");
    const people = await database()
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, guest.userId));
    assert.deepEqual(people, []);
  },
);

test(
  "a request of an account whose pending request denying all holds waits, and then answers rate_limited with the 24-hour wait of a denial",
  SERVER_ONLY,
  async () => {
    const [owner, guest] = await accounts(2);
    assert.ok(owner && guest);
    const { workspaceId } = await workspaceOf(owner);
    const pending = await requested(guest, workspaceId);

    let denial: DenyAllJoinRequestsResult | undefined;
    const { result, waited } = await whileHeld(
      async (tx) => {
        denial = await denyAllJoinRequests(
          tx,
          workspaceAction(owner, workspaceId),
        );
      },
      () => ask(guest, workspaceId, LATER),
    );
    assert.equal(denial?.denied, true);
    assert.equal(waited, true, "the request waits for the request row");
    // Without the wait it would return the pending request that is denied
    // a moment later.
    assert.deepEqual(result, {
      requested: false,
      refusal: "rate_limited",
      retryAfterMs: DAY_MS,
    });
    assert.deepEqual(
      (await requestsOf(workspaceId)).map((row) => [row.id, row.decision]),
      [[pending.id, "denied"]],
    );
  },
);

test(
  "a request waits for a pause that holds the workspace row, and then answers join_requests_closed",
  SERVER_ONLY,
  async () => {
    const [owner, guest] = await accounts(2);
    assert.ok(owner && guest);
    const { workspaceId } = await workspaceOf(owner);

    let pause: PauseJoinRequestsResult | undefined;
    const { result, waited } = await whileHeld(
      async (tx) => {
        pause = await pauseJoinRequests(
          tx,
          workspaceAction(owner, workspaceId, NOW),
        );
      },
      () => ask(guest, workspaceId),
    );
    assert.deepEqual(pause, { paused: true, changed: true });
    assert.equal(waited, true, "the request waits for the workspace row");
    assert.deepEqual(result, {
      requested: false,
      refusal: "join_requests_closed",
    });
    assert.deepEqual(await requestsOf(workspaceId), []);
  },
);
