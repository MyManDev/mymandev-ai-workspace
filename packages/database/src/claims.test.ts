import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  type Claim,
  ClaimListResponseSchema,
  type ClaimVia,
  type DeviceId,
  type InvitationId,
  type JoinRequestId,
  type MemberId,
  newId,
  newUuidV7,
  RECENT_CLAIMS,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import { listClaims } from "./claims.ts";
import type { Database } from "./db.ts";
import { DatabaseError } from "./errors.ts";
import {
  acceptInvitation,
  createInvitation,
  revokeInvitation,
} from "./invitations.ts";
import {
  approveJoinRequest,
  createJoinRequest,
  denyJoinRequest,
} from "./join-requests.ts";
import { createWorkspace } from "./membership.ts";
import { defineMember, removeMember } from "./people.ts";
import {
  devices,
  userIdentities,
  users,
  workspaceInvitations,
  workspaceJoinRequests,
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

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-11-06T12:00:00.000Z");
const GITHUB_CREATED = new Date("2015-06-01T10:00:00.000Z");
/** A GitHub account made the day before it claims a person. */
const FRESH_GITHUB_CREATED = new Date("2026-11-05T09:30:00.000Z");

function at(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

type Account = Readonly<{ userId: UserId; deviceId: DeviceId; login: string }>;

let nextSubject = 9_000_000;

/** Accounts with one device each and a GitHub identity, all at once. */
async function accounts(n: number): Promise<Account[]> {
  const db = database();
  const created = Array.from({ length: n }, () => {
    nextSubject += 1;
    return {
      userId: newId<UserId>(),
      deviceId: newId<DeviceId>(),
      subject: String(nextSubject),
      login: `user-${nextSubject}`,
    };
  });
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
    created.map(({ userId, subject, login }) => ({
      id: newUuidV7(),
      userId,
      identityProvider: "github" as const,
      subject,
      login,
      accountCreatedAt: GITHUB_CREATED,
      lastSignInAt: NOW,
    })),
  );
  return created.map(({ userId, deviceId, login }) => ({
    userId,
    deviceId,
    login,
  }));
}

/** A workspace of `owner`, created at `NOW`, with the owner's person. */
async function workspaceOf(owner: Account) {
  const result = await createWorkspace(database(), {
    userId: owner.userId,
    deviceId: owner.deviceId,
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

function actor(who: Account, workspaceId: WorkspaceId, now: Date) {
  return { workspaceId, userId: who.userId, deviceId: who.deviceId, now };
}

/** An unclaimed person that `by` defines at `now`. */
async function defined(
  by: Account,
  workspaceId: WorkspaceId,
  now: Date,
): Promise<MemberId> {
  const result = await defineMember(database(), {
    ...actor(by, workspaceId, now),
    displayName: "Linus",
  });
  assert.ok(result.defined);
  return result.member.id;
}

/** An invitation that `by` creates for the person at `now`, with its code's hash. */
async function invited(
  by: Account,
  workspaceId: WorkspaceId,
  memberId: MemberId,
  now: Date,
) {
  const tokenHash = randomBytes(32).toString("hex");
  const result = await createInvitation(database(), {
    ...actor(by, workspaceId, now),
    memberId,
    tokenHash,
  });
  assert.ok(result.created);
  return { invitationId: result.invitation.id, tokenHash };
}

/** `who` claims a new person of the workspace with an invitation from `by` at `now`. */
async function claimedByInvitation(
  by: Account,
  workspaceId: WorkspaceId,
  who: Account,
  now: Date,
): Promise<MemberId> {
  const memberId = await defined(by, workspaceId, at(-HOUR_MS));
  const { tokenHash } = await invited(by, workspaceId, memberId, at(-HOUR_MS));
  const result = await acceptInvitation(database(), {
    tokenHash,
    userId: who.userId,
    deviceId: who.deviceId,
    now,
  });
  assert.ok(result.accepted, JSON.stringify(result));
  return memberId;
}

/** `who` asks to join and `by` approves at `now`. */
async function claimedByRequest(
  by: Account,
  workspaceId: WorkspaceId,
  who: Account,
  now: Date,
): Promise<MemberId> {
  const asked = await createJoinRequest(database(), {
    workspaceId,
    userId: who.userId,
    deviceId: who.deviceId,
    displayName: "Bob",
    now: at(-HOUR_MS),
  });
  assert.ok(asked.requested);
  const result = await approveJoinRequest(database(), {
    ...actor(by, workspaceId, now),
    joinRequestId: asked.joinRequest.id,
  });
  assert.ok(result.approved, JSON.stringify(result));
  return result.member.id;
}

function list(workspaceId: WorkspaceId, who: Account) {
  return listClaims(database(), { workspaceId, userId: who.userId });
}

/** The claims that `who` reads, checked against the protocol's answer schema. */
async function claimsOf(
  workspaceId: WorkspaceId,
  who: Account,
): Promise<Claim[]> {
  const result = await list(workspaceId, who);
  assert.ok(result.listed, JSON.stringify(result));
  return ClaimListResponseSchema.parse({ claims: result.claims }).claims;
}

function claim(
  workspaceId: WorkspaceId,
  memberId: MemberId,
  who: Account | null,
  via: ClaimVia,
  claimedAt: Date,
  accountCreatedAt: Date = GITHUB_CREATED,
): Claim {
  return {
    workspaceId,
    memberId,
    claimer:
      who === null
        ? null
        : {
            provider: "github",
            login: who.login,
            verifiedAt: NOW.toISOString(),
            accountCreatedAt: accountCreatedAt.toISOString(),
          },
    via,
    claimedAt: claimedAt.toISOString(),
  };
}

async function setRole(memberId: MemberId, role: "admin" | "member") {
  await database()
    .update(workspaceMembers)
    .set({ role })
    .where(eq(workspaceMembers.id, memberId));
}

test("the owner and admins list the accepted invitations and approved join requests, the most recent first, with the claimer's GitHub login, the creation date of that GitHub account, and how each person was claimed", async () => {
  const [owner, ada, bob, carol, dave] = await accounts(5);
  assert.ok(owner && ada && bob && carol && dave);
  const { workspaceId } = await workspaceOf(owner);
  await database()
    .update(userIdentities)
    .set({ accountCreatedAt: FRESH_GITHUB_CREATED })
    .where(eq(userIdentities.userId, ada.userId));

  const adaPerson = await claimedByInvitation(
    owner,
    workspaceId,
    ada,
    at(HOUR_MS),
  );
  const bobPerson = await claimedByRequest(
    owner,
    workspaceId,
    bob,
    at(2 * HOUR_MS),
  );

  // No claims: an unclaimed person, a live and a revoked invitation, and a
  // pending and a denied join request.
  await defined(owner, workspaceId, NOW);
  await invited(
    owner,
    workspaceId,
    await defined(owner, workspaceId, NOW),
    NOW,
  );
  const revoked = await invited(
    owner,
    workspaceId,
    await defined(owner, workspaceId, NOW),
    NOW,
  );
  const revocation = await revokeInvitation(database(), {
    ...actor(owner, workspaceId, NOW),
    invitationId: revoked.invitationId,
  });
  assert.ok(revocation.revoked);
  const pending = await createJoinRequest(database(), {
    workspaceId,
    userId: carol.userId,
    deviceId: carol.deviceId,
    displayName: "Carol",
    now: NOW,
  });
  assert.ok(pending.requested);
  const denied = await createJoinRequest(database(), {
    workspaceId,
    userId: dave.userId,
    deviceId: dave.deviceId,
    displayName: "Dave",
    now: NOW,
  });
  assert.ok(denied.requested);
  const denial = await denyJoinRequest(database(), {
    ...actor(owner, workspaceId, NOW),
    joinRequestId: denied.joinRequest.id,
  });
  assert.ok(denial.denied);
  // A claimed person whose only invitation was revoked, written directly,
  // because no function writes such a person: only an accepted invitation
  // or an approved join request makes a claim.
  const direct = newId<MemberId>();
  await database()
    .insert(workspaceMembers)
    .values({
      id: direct,
      workspaceId,
      userId: dave.userId,
      displayName: "Dave",
      role: "member",
      addedByUserId: owner.userId,
      createdAt: NOW,
      claimedAt: at(3 * HOUR_MS),
    });
  await database()
    .insert(workspaceInvitations)
    .values({
      id: newId<InvitationId>(),
      workspaceId,
      memberId: direct,
      tokenHash: randomBytes(32).toString("hex"),
      createdByUserId: owner.userId,
      createdAt: NOW,
      expiresAt: at(DAY_MS),
      revokedAt: at(HOUR_MS),
      revokedByUserId: owner.userId,
    });

  // The owner's own person, which the workspace's creation claimed, is no
  // claim either.
  const expected = [
    claim(workspaceId, bobPerson, bob, "join_request", at(2 * HOUR_MS)),
    claim(
      workspaceId,
      adaPerson,
      ada,
      "invitation",
      at(HOUR_MS),
      FRESH_GITHUB_CREATED,
    ),
  ];
  assert.deepEqual(await claimsOf(workspaceId, owner), expected);

  // An admin reads the same list, its own claim included.
  await setRole(adaPerson, "admin");
  assert.deepEqual(await claimsOf(workspaceId, ada), expected);
});

test("a member is forbidden, and an account without an active person in the workspace is not_member", async () => {
  const [owner, ada, bob, stranger] = await accounts(4);
  assert.ok(owner && ada && bob && stranger);
  const { workspaceId } = await workspaceOf(owner);
  await claimedByInvitation(owner, workspaceId, ada, at(HOUR_MS));
  const bobPerson = await claimedByRequest(
    owner,
    workspaceId,
    bob,
    at(2 * HOUR_MS),
  );

  assert.deepEqual(await list(workspaceId, ada), {
    listed: false,
    refusal: "forbidden",
  });
  assert.deepEqual(await list(workspaceId, stranger), {
    listed: false,
    refusal: "not_member",
  });
  assert.deepEqual(await list(newId<WorkspaceId>(), owner), {
    listed: false,
    refusal: "not_member",
  });

  // A removed admin is no longer an active member.
  await setRole(bobPerson, "admin");
  assert.equal((await claimsOf(workspaceId, bob)).length, 2);
  const removal = await removeMember(database(), {
    ...actor(owner, workspaceId, at(3 * HOUR_MS)),
    memberId: bobPerson,
  });
  assert.ok(removal.removed);
  assert.deepEqual(await list(workspaceId, bob), {
    listed: false,
    refusal: "not_member",
  });
  // And a demoted admin is a member again.
  const adaPerson = (await claimsOf(workspaceId, owner)).find(
    (item) => item.claimer?.login === ada.login,
  )?.memberId;
  assert.ok(adaPerson);
  await setRole(adaPerson, "admin");
  assert.equal((await list(workspaceId, ada)).listed, true);
  await setRole(adaPerson, "member");
  assert.deepEqual(await list(workspaceId, ada), {
    listed: false,
    refusal: "forbidden",
  });
});

test("a removed person's claim stays listed, an erased account's claim has no claimer, and another workspace's claims never show", async () => {
  const [owner, otherOwner, ada, bob, erased] = await accounts(5);
  assert.ok(owner && otherOwner && ada && bob && erased);
  const { workspaceId } = await workspaceOf(owner);
  const other = await workspaceOf(otherOwner);

  const adaPerson = await claimedByInvitation(
    owner,
    workspaceId,
    ada,
    at(HOUR_MS),
  );
  const erasedPerson = await claimedByRequest(
    owner,
    workspaceId,
    erased,
    at(2 * HOUR_MS),
  );
  // Ada and Bob claim people of the other workspace too, later.
  const adaElsewhere = await claimedByRequest(
    otherOwner,
    other.workspaceId,
    ada,
    at(3 * HOUR_MS),
  );
  const bobElsewhere = await claimedByInvitation(
    otherOwner,
    other.workspaceId,
    bob,
    at(4 * HOUR_MS),
  );

  const removal = await removeMember(database(), {
    ...actor(owner, workspaceId, at(5 * HOUR_MS)),
    memberId: adaPerson,
  });
  assert.ok(removal.removed);
  // What an erasure leaves of the identity (P-62).
  await database()
    .update(userIdentities)
    .set({
      erasedAt: at(5 * HOUR_MS),
      subject: null,
      login: null,
      accountCreatedAt: null,
    })
    .where(eq(userIdentities.userId, erased.userId));

  assert.deepEqual(await claimsOf(workspaceId, owner), [
    claim(workspaceId, erasedPerson, null, "join_request", at(2 * HOUR_MS)),
    claim(workspaceId, adaPerson, ada, "invitation", at(HOUR_MS)),
  ]);
  assert.deepEqual(await claimsOf(other.workspaceId, otherOwner), [
    claim(other.workspaceId, bobElsewhere, bob, "invitation", at(4 * HOUR_MS)),
    claim(
      other.workspaceId,
      adaElsewhere,
      ada,
      "join_request",
      at(3 * HOUR_MS),
    ),
  ]);
});

test("the list holds the RECENT_CLAIMS most recent claims, whatever their age, ties to the higher person ID", async () => {
  assert.equal(RECENT_CLAIMS, 50);
  const [owner, ada] = await accounts(2);
  assert.ok(owner && ada);
  const { workspaceId } = await workspaceOf(owner);

  // 51 claims of one account, written directly: 50 earlier people, each
  // removed after its claim, and its active person. Each has an accepted
  // invitation. The two oldest are about a year old.
  const people = Array.from({ length: RECENT_CLAIMS + 1 }, (_, index) => ({
    id: newId<MemberId>(),
    claimedAt: index < 2 ? at((index - 365) * DAY_MS) : at(index * MINUTE_MS),
    removed: index < RECENT_CLAIMS,
  }));
  // Two groups of four claims share a time each. Their person IDs, which grow
  // in the order they were made, are handed out of order, so that neither the
  // order in which the rows are written nor its reverse is the order by ID.
  const ties = [
    [10, [2, 0, 3, 1]],
    [30, [1, 3, 0, 2]],
  ] as const;
  const tiedGroups: Readonly<{ claimedAt: Date; ids: MemberId[] }>[] = [];
  for (const [start, order] of ties) {
    const group = people.slice(start, start + order.length);
    const ids = group.map((person) => person.id).sort();
    const claimedAt = group[0]?.claimedAt;
    assert.ok(claimedAt);
    order.forEach((rank, offset) => {
      const id = ids[rank];
      assert.ok(id);
      people[start + offset] = { id, claimedAt, removed: true };
    });
    tiedGroups.push({ claimedAt, ids });
  }
  await database()
    .insert(workspaceMembers)
    .values(
      people.map((person) => ({
        id: person.id,
        workspaceId,
        userId: ada.userId,
        displayName: "Ada",
        role: "member" as const,
        addedByUserId: owner.userId,
        createdAt: new Date(person.claimedAt.getTime() - HOUR_MS),
        claimedAt: person.claimedAt,
        ...(person.removed
          ? { removedAt: person.claimedAt, removedByUserId: owner.userId }
          : {}),
      })),
    );
  await database()
    .insert(workspaceInvitations)
    .values(
      people.map((person) => ({
        id: newId<InvitationId>(),
        workspaceId,
        memberId: person.id,
        tokenHash: randomBytes(32).toString("hex"),
        createdByUserId: owner.userId,
        createdAt: new Date(person.claimedAt.getTime() - HOUR_MS),
        expiresAt: new Date(person.claimedAt.getTime() + DAY_MS),
        acceptedAt: person.claimedAt,
        acceptedByUserId: ada.userId,
        acceptedDeviceId: ada.deviceId,
      })),
    );

  const claims = await claimsOf(workspaceId, owner);
  assert.equal(claims.length, RECENT_CLAIMS);
  const newestFirst = [...people].sort(
    (a, b) =>
      b.claimedAt.getTime() - a.claimedAt.getTime() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  assert.deepEqual(
    claims.map((item) => [item.memberId, item.claimedAt]),
    newestFirst
      .slice(0, RECENT_CLAIMS)
      .map((person) => [person.id, person.claimedAt.toISOString()]),
  );
  // Within each tie, the higher person ID comes first, and all are listed.
  for (const { claimedAt, ids } of tiedGroups) {
    assert.deepEqual(
      claims
        .filter((item) => item.claimedAt === claimedAt.toISOString())
        .map((item) => item.memberId),
      [...ids].reverse(),
    );
  }
  assert.ok(claims.every((item) => item.via === "invitation"));
  // Of the two claims of about a year ago, the newer one is still listed,
  // last, and only the oldest claim is cut.
  assert.equal(claims.at(-1)?.memberId, people[1]?.id);
  assert.equal(
    claims.some((item) => item.memberId === people[0]?.id),
    false,
  );
});

test("a person claimed both by an invitation and through an approved join request breaks the invariant, and the list throws", async () => {
  const [owner, ada] = await accounts(2);
  assert.ok(owner && ada);
  const { workspaceId } = await workspaceOf(owner);
  const adaPerson = await claimedByInvitation(
    owner,
    workspaceId,
    ada,
    at(HOUR_MS),
  );
  assert.deepEqual(await claimsOf(workspaceId, owner), [
    claim(workspaceId, adaPerson, ada, "invitation", at(HOUR_MS)),
  ]);

  // An approved join request for the same person, written directly, because
  // no function writes one: an approved request creates a new person, and an
  // invitation is only for an unclaimed one.
  await database()
    .insert(workspaceJoinRequests)
    .values({
      id: newId<JoinRequestId>(),
      workspaceId,
      requesterUserId: ada.userId,
      requesterDeviceId: ada.deviceId,
      requestedDisplayName: "Ada",
      createdAt: NOW,
      expiresAt: at(7 * DAY_MS),
      decision: "approved",
      decidedAt: at(HOUR_MS),
      decidedByUserId: owner.userId,
      memberId: adaPerson,
    });

  await assert.rejects(
    list(workspaceId, owner),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof DatabaseError) &&
      /^Invariant broken: a person is claimed by both/.test(error.message),
  );
});
