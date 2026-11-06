import {
  userIdentities,
  workspaceInvitations,
  workspaceMembers,
} from "@mymandev/database";
import {
  AcceptInvitationResponseSchema,
  ApproveJoinRequestResponseSchema,
  type Claim,
  ClaimListResponseSchema,
  CreateInvitationResponseSchema,
  CreateJoinRequestResponseSchema,
  CreateWorkspaceResponseSchema,
  DefineMemberResponseSchema,
  type InvitationId,
  type MemberId,
  newId,
  RECENT_CLAIMS,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import {
  accessToken,
  deviceApp,
  type DeviceAppOptions,
  fakeClock,
  signInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";

const database = useTestDatabase();

type App = FastifyInstance;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A GitHub account made the day before it claims a person. */
const FRESH_GITHUB_CREATED = "2026-11-05T09:30:00.000Z";

function claimApp(
  t: TestContext,
  options: Omit<DeviceAppOptions, "database">,
): Promise<App> {
  return deviceApp(t, { database: database(), ...options });
}

/** A signed-in device of the app's account and an access token for it. */
async function signedIn(app: App) {
  const device = await signInDevice(app);
  return { app, device, token: await accessToken(app, device) };
}

type Session = Awaited<ReturnType<typeof signedIn>>;

function request(
  session: Session,
  method: "GET" | "POST",
  url: string,
  payload?: object,
) {
  return session.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${session.token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

function listClaims(session: Session, workspaceId: string) {
  return request(session, "GET", `/workspaces/${workspaceId}/claims`);
}

/** The claims that the session reads, checked against the protocol's answer schema. */
async function claimsOf(
  session: Session,
  workspaceId: WorkspaceId,
): Promise<Claim[]> {
  const response = await listClaims(session, workspaceId);
  assert.equal(response.statusCode, 200, response.body);
  return ClaimListResponseSchema.parse(response.json()).claims;
}

async function createWorkspace(session: Session, name = "Research") {
  const response = await request(session, "POST", "/workspaces", {
    name,
    displayName: "Grace",
  });
  assert.equal(response.statusCode, 200, response.body);
  return CreateWorkspaceResponseSchema.parse(response.json());
}

/** `who` claims a new person of the workspace with an invitation from `by`. */
async function claimedByInvitation(
  by: Session,
  workspaceId: WorkspaceId,
  who: Session,
): Promise<MemberId> {
  const definedResponse = await request(
    by,
    "POST",
    `/workspaces/${workspaceId}/members`,
    { displayName: "Linus" },
  );
  assert.equal(definedResponse.statusCode, 200, definedResponse.body);
  const memberId = DefineMemberResponseSchema.parse(definedResponse.json())
    .member.id;
  const invitedResponse = await request(
    by,
    "POST",
    `/workspaces/${workspaceId}/invitations`,
    { memberId },
  );
  assert.equal(invitedResponse.statusCode, 200, invitedResponse.body);
  const { code } = CreateInvitationResponseSchema.parse(invitedResponse.json());
  const accepted = await request(who, "POST", "/invitations/accept", { code });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(
    AcceptInvitationResponseSchema.parse(accepted.json()).member.id,
    memberId,
  );
  return memberId;
}

/** `who` asks to join the workspace, and `by` approves. */
async function claimedByRequest(
  by: Session,
  workspaceId: WorkspaceId,
  who: Session,
  advance: () => void = () => {},
): Promise<MemberId> {
  const asked = await request(who, "POST", "/join-requests", {
    workspaceId,
    displayName: "Bob",
  });
  assert.equal(asked.statusCode, 200, asked.body);
  const { joinRequest } = CreateJoinRequestResponseSchema.parse(asked.json());
  advance();
  const approved = await request(
    by,
    "POST",
    `/workspaces/${workspaceId}/join-requests/${joinRequest.id}/approve`,
    {},
  );
  assert.equal(approved.statusCode, 200, approved.body);
  return ApproveJoinRequestResponseSchema.parse(approved.json()).member.id;
}

/** The account's GitHub identity as a claim shows it. */
async function identityOf(userId: UserId) {
  const [row] = await database()
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId));
  assert.ok(row?.login && row.accountCreatedAt);
  return {
    provider: row.identityProvider,
    login: row.login,
    verifiedAt: row.lastSignInAt.toISOString(),
    accountCreatedAt: row.accountCreatedAt.toISOString(),
  };
}

async function setRole(memberId: MemberId, role: "admin" | "member") {
  await database()
    .update(workspaceMembers)
    .set({ role })
    .where(eq(workspaceMembers.id, memberId));
}

const FORBIDDEN = {
  statusCode: 403,
  error: "Forbidden",
  message: "Forbidden",
  code: "forbidden",
};

const NOT_FOUND = {
  statusCode: 404,
  error: "Not Found",
  message: "Not Found",
  code: "not_found",
};

/** What a caller can tell from an answer: its status, its type, and its body. */
function answer(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}) {
  return [response.statusCode, response.headers["content-type"], response.body];
}

test("the owner and an admin read the recent claims, the most recent first, with the GitHub login, the creation date of that GitHub account, and the claim time", async (t) => {
  const clock = fakeClock();
  const owner = await signedIn(
    await claimApp(t, { githubId: 3601, now: clock.now }),
  );
  const ada = await signedIn(
    await claimApp(t, { githubId: 3602, now: clock.now }),
  );
  const bob = await signedIn(
    await claimApp(t, { githubId: 3603, now: clock.now }),
  );
  const { workspace } = await createWorkspace(owner);
  // Ada's GitHub account is a day old; Bob's is years old.
  await database()
    .update(userIdentities)
    .set({ accountCreatedAt: new Date(FRESH_GITHUB_CREATED) })
    .where(eq(userIdentities.userId, ada.device.userId));

  // The creator's own person is no claim.
  assert.deepEqual(await claimsOf(owner, workspace.id), []);

  clock.advance(MINUTE_MS);
  const adaClaimedAt = new Date(clock.now()).toISOString();
  const adaPerson = await claimedByInvitation(owner, workspace.id, ada);
  clock.advance(MINUTE_MS);
  const bobPerson = await claimedByRequest(owner, workspace.id, bob, () => {
    clock.advance(MINUTE_MS);
  });
  const bobClaimedAt = new Date(clock.now()).toISOString();

  const adaIdentity = await identityOf(ada.device.userId);
  assert.equal(adaIdentity.login, "user-3602");
  assert.equal(adaIdentity.accountCreatedAt, FRESH_GITHUB_CREATED);
  const expected = [
    {
      workspaceId: workspace.id,
      memberId: bobPerson,
      claimer: await identityOf(bob.device.userId),
      claimedAt: bobClaimedAt,
    },
    {
      workspaceId: workspace.id,
      memberId: adaPerson,
      claimer: adaIdentity,
      claimedAt: adaClaimedAt,
    },
  ];
  const response = await listClaims(owner, workspace.id);
  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers["content-type"]), /^application\/json/u);
  assert.deepEqual(response.json(), { claims: expected });
  assert.deepEqual(
    Object.keys((response.json() as { claims: object[] }).claims[0] ?? {}),
    ["workspaceId", "memberId", "claimer", "claimedAt"],
    "no user ID, display name, or invitation leaves the API",
  );

  // An admin reads the same list, its own claim included.
  await setRole(adaPerson, "admin");
  const asAdmin = await listClaims(ada, workspace.id);
  assert.equal(asAdmin.statusCode, 200, asAdmin.body);
  assert.equal(asAdmin.body, response.body);
});

test("a member gets 403 with forbidden, and a non-member and a former member the 404 of a workspace that does not exist, as on the other routes of the owner and admins", async (t) => {
  const owner = await signedIn(await claimApp(t, { githubId: 3611 }));
  const ada = await signedIn(await claimApp(t, { githubId: 3612 }));
  const outsider = await signedIn(await claimApp(t, { githubId: 3613 }));
  const { workspace } = await createWorkspace(owner);
  const adaPerson = await claimedByInvitation(owner, workspace.id, ada);
  const adminOnly = (session: Session, workspaceId: string) =>
    Promise.all(
      ["invitations", "join-requests"].map((path) =>
        request(session, "GET", `/workspaces/${workspaceId}/${path}`),
      ),
    );

  // A member.
  const member = await listClaims(ada, workspace.id);
  assert.equal(member.statusCode, 403);
  assert.deepEqual(member.json(), FORBIDDEN);
  for (const other of await adminOnly(ada, workspace.id)) {
    assert.deepEqual(answer(member), answer(other));
  }

  // A non-member, an unknown workspace, and a malformed ID.
  const unknown = await listClaims(owner, newId<WorkspaceId>());
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), NOT_FOUND);
  for (const other of [
    await listClaims(outsider, workspace.id),
    await listClaims(outsider, "not-an-id"),
    ...(await adminOnly(outsider, workspace.id)),
  ]) {
    assert.deepEqual(answer(other), answer(unknown));
  }

  // A former member, after the owner removed Ada as an admin.
  await setRole(adaPerson, "admin");
  assert.equal((await listClaims(ada, workspace.id)).statusCode, 200);
  const removed = await request(
    owner,
    "POST",
    `/workspaces/${workspace.id}/members/${adaPerson}/remove`,
  );
  assert.equal(removed.statusCode, 204, removed.body);
  const former = await listClaims(ada, workspace.id);
  assert.deepEqual(answer(former), answer(unknown));
  for (const other of await adminOnly(ada, workspace.id)) {
    assert.deepEqual(answer(other), answer(unknown));
  }
  // The claim of the removed person stays listed for the owner.
  assert.deepEqual(
    (await claimsOf(owner, workspace.id)).map((item) => item.memberId),
    [adaPerson],
  );
});

test("the answer holds the workspace's RECENT_CLAIMS most recent claims, never another workspace's, and an erased account's claim without a claimer", async (t) => {
  const clock = fakeClock();
  const session = async (githubId: number) =>
    signedIn(await claimApp(t, { githubId, now: clock.now }));
  const owner = await session(3621);
  const otherOwner = await session(3622);
  const ada = await session(3623);
  const erased = await session(3624);
  const { workspace } = await createWorkspace(owner);
  const other = (await createWorkspace(otherOwner, "Elsewhere")).workspace;

  // Claims in the other workspace, through the API, after every claim below.
  const adaElsewhere = await claimedByInvitation(otherOwner, other.id, ada);
  clock.advance(MINUTE_MS);
  const erasedElsewhere = await claimedByRequest(otherOwner, other.id, erased);

  // 51 claims in the owner's workspace, written directly, each person with an
  // accepted invitation: the oldest of Ada's 50 earlier people, each removed
  // after its claim, is cut, and the erased account's active person is the
  // most recent.
  const base = clock.now() - 2 * DAY_MS;
  const people = Array.from({ length: RECENT_CLAIMS + 1 }, (_, index) => ({
    id: newId<MemberId>(),
    claimer: index === RECENT_CLAIMS ? erased : ada,
    claimedAt: new Date(base + index * MINUTE_MS),
    removed: index < RECENT_CLAIMS,
  }));
  await database()
    .insert(workspaceMembers)
    .values(
      people.map((person) => ({
        id: person.id,
        workspaceId: workspace.id,
        userId: person.claimer.device.userId,
        displayName: "Ada",
        role: "member" as const,
        addedByUserId: owner.device.userId,
        createdAt: new Date(person.claimedAt.getTime() - HOUR_MS),
        claimedAt: person.claimedAt,
        ...(person.removed
          ? {
              removedAt: person.claimedAt,
              removedByUserId: owner.device.userId,
            }
          : {}),
      })),
    );
  await database()
    .insert(workspaceInvitations)
    .values(
      people.map((person) => ({
        id: newId<InvitationId>(),
        workspaceId: workspace.id,
        memberId: person.id,
        tokenHash: randomBytes(32).toString("hex"),
        createdByUserId: owner.device.userId,
        createdAt: new Date(person.claimedAt.getTime() - HOUR_MS),
        expiresAt: new Date(person.claimedAt.getTime() + DAY_MS),
        acceptedAt: person.claimedAt,
        acceptedByUserId: person.claimer.device.userId,
        acceptedDeviceId: person.claimer.device.deviceId,
      })),
    );
  // What an erasure leaves of the identity (P-62).
  await database()
    .update(userIdentities)
    .set({
      erasedAt: new Date(clock.now()),
      subject: null,
      login: null,
      accountCreatedAt: null,
    })
    .where(eq(userIdentities.userId, erased.device.userId));

  const claims = await claimsOf(owner, workspace.id);
  assert.equal(claims.length, RECENT_CLAIMS);
  const adaIdentity = await identityOf(ada.device.userId);
  assert.deepEqual(
    claims,
    people
      .slice(1)
      .reverse()
      .map((person) => ({
        workspaceId: workspace.id,
        memberId: person.id,
        claimer: person.claimer === erased ? null : adaIdentity,
        claimedAt: person.claimedAt.toISOString(),
      })),
  );

  assert.deepEqual(
    (await claimsOf(otherOwner, other.id)).map((item) => [
      item.workspaceId,
      item.memberId,
      item.claimer?.login ?? null,
    ]),
    [
      [other.id, erasedElsewhere, null],
      [other.id, adaElsewhere, adaIdentity.login],
    ],
  );
});
