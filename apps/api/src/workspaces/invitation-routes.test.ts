import {
  auditEvents,
  workspaceInvitations,
  workspaceMembers,
} from "@mymandev/database";
import {
  ApiErrorBodySchema,
  CreateInvitationResponseSchema,
  CreateWorkspaceResponseSchema,
  DefineMemberResponseSchema,
  type InvitationId,
  InvitationListResponseSchema,
  type MemberId,
  type MemberRole,
  newId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import {
  accessToken,
  deviceApp,
  type DeviceAppOptions,
  fakeClock,
  signInDevice,
  type SignedInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";

const database = useTestDatabase();

type App = FastifyInstance;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function invitationApp(
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

function create(session: Session, workspaceId: string, payload: object) {
  return request(
    session,
    "POST",
    `/workspaces/${workspaceId}/invitations`,
    payload,
  );
}

function list(session: Session, workspaceId: string) {
  return request(session, "GET", `/workspaces/${workspaceId}/invitations`);
}

function revoke(session: Session, workspaceId: string, invitationId: string) {
  return request(
    session,
    "POST",
    `/workspaces/${workspaceId}/invitations/${invitationId}/revoke`,
  );
}

async function invited(
  session: Session,
  workspaceId: WorkspaceId,
  memberId: MemberId,
  lifetimeSeconds?: number,
) {
  const response = await create(session, workspaceId, {
    memberId,
    ...(lifetimeSeconds === undefined ? {} : { lifetimeSeconds }),
  });
  assert.equal(response.statusCode, 200, response.body);
  return CreateInvitationResponseSchema.parse(response.json());
}

async function listed(session: Session, workspaceId: WorkspaceId) {
  const response = await list(session, workspaceId);
  assert.equal(response.statusCode, 200, response.body);
  return InvitationListResponseSchema.parse(response.json()).invitations;
}

async function createWorkspace(session: Session) {
  const response = await request(session, "POST", "/workspaces", {
    name: "Research",
    displayName: "Ada at work",
  });
  assert.equal(response.statusCode, 200, response.body);
  return CreateWorkspaceResponseSchema.parse(response.json());
}

/** An unclaimed person defined through the API. */
async function defined(
  session: Session,
  workspaceId: WorkspaceId,
  displayName = "Linus",
): Promise<MemberId> {
  const response = await request(
    session,
    "POST",
    `/workspaces/${workspaceId}/members`,
    { displayName },
  );
  assert.equal(response.statusCode, 200, response.body);
  return DefineMemberResponseSchema.parse(response.json()).member.id;
}

/** Adds the device's account to the workspace as a claimed person; promotion is #93. */
async function addClaimed(
  workspaceId: WorkspaceId,
  device: SignedInDevice,
  addedBy: SignedInDevice,
  role: MemberRole = "member",
): Promise<MemberId> {
  const id = newId<MemberId>();
  await database().insert(workspaceMembers).values({
    id,
    workspaceId,
    userId: device.userId,
    displayName: "Grace",
    role,
    addedByUserId: addedBy.userId,
    claimedAt: new Date(),
  });
  return id;
}

/** Unclaimed people written directly, all at once. */
async function addPeople(
  workspaceId: WorkspaceId,
  addedBy: SignedInDevice,
  n: number,
): Promise<MemberId[]> {
  const ids = Array.from({ length: n }, () => newId<MemberId>());
  await database()
    .insert(workspaceMembers)
    .values(
      ids.map((id) => ({
        id,
        workspaceId,
        displayName: "Someone",
        role: "member" as const,
        addedByUserId: addedBy.userId,
      })),
    );
  return ids;
}

/** Invitation rows written directly, each with its own creation and expiry. */
async function insertInvitations(
  workspaceId: WorkspaceId,
  createdBy: SignedInDevice,
  rows: readonly Readonly<{
    memberId: MemberId;
    createdAt: Date;
    expiresAt: Date;
    revoked?: boolean;
  }>[],
): Promise<void> {
  await database()
    .insert(workspaceInvitations)
    .values(
      rows.map((row) => ({
        id: newId<InvitationId>(),
        workspaceId,
        memberId: row.memberId,
        tokenHash: randomBytes(32).toString("hex"),
        createdByUserId: createdBy.userId,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        ...(row.revoked === true
          ? { revokedAt: row.createdAt, revokedByUserId: createdBy.userId }
          : {}),
      })),
    );
}

async function invitationRow(id: InvitationId) {
  const [row] = await database()
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function auditOf(workspaceId: WorkspaceId) {
  return database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(auditEvents.id);
}

function errorCode(response: { json(): unknown }): unknown {
  return (response.json() as { code?: unknown }).code;
}

const FORBIDDEN = {
  statusCode: 403,
  error: "Forbidden",
  message: "Forbidden",
  code: "forbidden",
};

const CONFLICT = {
  statusCode: 409,
  error: "Conflict",
  message: "Conflict",
  code: "conflict",
};

const RATE_LIMITED = {
  statusCode: 429,
  error: "Too Many Requests",
  message: "Too Many Requests",
  code: "rate_limited",
};

test("the code of a new invitation appears once, in its answer with Cache-Control: no-store, and never in the list, the logs, the audit, or the database", async (t) => {
  const logLines: string[] = [];
  const owner = await signedIn(
    await invitationApp(t, {
      githubId: 3201,
      logLines,
      env: { API_LOG_LEVEL: "trace" },
    }),
  );
  const { workspace, member: ownerPerson } = await createWorkspace(owner);
  const linus = await defined(owner, workspace.id);

  const response = await create(owner, workspace.id, { memberId: linus });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  const { invitation, code } = CreateInvitationResponseSchema.parse(
    response.json(),
  );
  assert.match(code, /^mmdi_[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(invitation, {
    id: invitation.id,
    workspaceId: workspace.id,
    memberId: linus,
    createdByMemberId: ownerPerson.id,
    createdAt: invitation.createdAt,
    expiresAt: new Date(
      Date.parse(invitation.createdAt) + 7 * DAY_MS,
    ).toISOString(),
  });

  const listResponse = await list(owner, workspace.id);
  assert.equal(listResponse.statusCode, 200);
  assert.deepEqual(
    InvitationListResponseSchema.parse(listResponse.json()).invitations,
    [invitation],
  );
  assert.ok(!listResponse.body.includes(code));

  // Only the hash is stored.
  const row = await invitationRow(invitation.id);
  const hash = createHash("sha256").update(code, "utf8").digest("hex");
  assert.equal(row.tokenHash, hash);
  assert.ok(!listResponse.body.includes(hash));
  const secret = code.slice("mmdi_".length);
  assert.ok(!JSON.stringify(row).includes(secret));
  const audit = await auditOf(workspace.id);
  assert.deepEqual(
    audit.map((entry) => [entry.action, entry.subjectId, entry.reason]),
    [
      ["workspace.created", workspace.id, null],
      ["member.defined", linus, null],
      ["invitation.created", invitation.id, null],
    ],
  );
  assert.ok(!JSON.stringify(audit).includes(secret));

  assert.ok(logLines.length > 0, "the API logged at trace level");
  const logs = logLines.join("\n");
  assert.ok(!logs.includes(secret), "no log line holds the code");
  assert.ok(!logs.includes(hash), "nor its hash");

  // Another invitation gets another code; the shortest lifetime is 1 hour.
  const margaret = await defined(owner, workspace.id, "Margaret");
  const short = await invited(owner, workspace.id, margaret, 3_600);
  assert.notEqual(short.code, code);
  assert.equal(
    Date.parse(short.invitation.expiresAt) -
      Date.parse(short.invitation.createdAt),
    HOUR_MS,
  );
});

test("a new invitation for a person revokes the person's previous one with the reason replaced", async (t) => {
  const owner = await signedIn(await invitationApp(t, { githubId: 3202 }));
  const admin = await signedIn(await invitationApp(t, { githubId: 3203 }));
  const { workspace } = await createWorkspace(owner);
  const adminPerson = await addClaimed(
    workspace.id,
    admin.device,
    owner.device,
    "admin",
  );
  const linus = await defined(owner, workspace.id);

  const first = await invited(owner, workspace.id, linus);
  // A lost code is replaced by a new invitation.
  const second = await invited(admin, workspace.id, linus);
  assert.notEqual(second.code, first.code);
  assert.equal(second.invitation.createdByMemberId, adminPerson);
  assert.deepEqual(await listed(owner, workspace.id), [second.invitation]);

  const replaced = await invitationRow(first.invitation.id);
  assert.ok(replaced.revokedAt instanceof Date);
  assert.equal(replaced.revokedByUserId, admin.device.userId);
  assert.equal((await invitationRow(second.invitation.id)).revokedAt, null);
  assert.deepEqual(
    (await auditOf(workspace.id))
      .filter((entry) => entry.action.startsWith("invitation."))
      .map((entry) => [
        entry.action,
        entry.actorUserId,
        entry.actorDeviceId,
        entry.subjectId,
        entry.reason,
      ]),
    [
      [
        "invitation.created",
        owner.device.userId,
        owner.device.deviceId,
        first.invitation.id,
        null,
      ],
      [
        "invitation.revoked",
        admin.device.userId,
        admin.device.deviceId,
        first.invitation.id,
        "replaced",
      ],
      [
        "invitation.created",
        admin.device.userId,
        admin.device.deviceId,
        second.invitation.id,
        null,
      ],
    ],
  );
});

test("a member gets forbidden for listing, creating, and revoking invitations, and nothing changes", async (t) => {
  const owner = await signedIn(await invitationApp(t, { githubId: 3204 }));
  const member = await signedIn(await invitationApp(t, { githubId: 3205 }));
  const { workspace } = await createWorkspace(owner);
  await addClaimed(workspace.id, member.device, owner.device);
  const linus = await defined(owner, workspace.id);
  const margaret = await defined(owner, workspace.id, "Margaret");
  const { invitation } = await invited(owner, workspace.id, linus);

  for (const [label, response] of [
    ["list", await list(member, workspace.id)],
    ["create", await create(member, workspace.id, { memberId: margaret })],
    [
      "create for an invited person",
      await create(member, workspace.id, { memberId: linus }),
    ],
    ["revoke", await revoke(member, workspace.id, invitation.id)],
  ] as const) {
    assert.equal(response.statusCode, 403, label);
    assert.deepEqual(response.json(), FORBIDDEN, label);
    assert.equal(response.headers["cache-control"], undefined, label);
  }
  assert.deepEqual(await listed(owner, workspace.id), [invitation]);
  const rows = await database()
    .select({ id: workspaceInvitations.id })
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.workspaceId, workspace.id));
  assert.deepEqual(rows, [{ id: invitation.id }]);
});

test("a claimed or removed person answers conflict, and a person that the workspace does not have answers not_found", async (t) => {
  const owner = await signedIn(await invitationApp(t, { githubId: 3206 }));
  const member = await signedIn(await invitationApp(t, { githubId: 3207 }));
  const other = await signedIn(await invitationApp(t, { githubId: 3208 }));
  const { workspace, member: ownerPerson } = await createWorkspace(owner);
  const memberPerson = await addClaimed(
    workspace.id,
    member.device,
    owner.device,
  );
  const removed = await defined(owner, workspace.id);
  const removal = await request(
    owner,
    "POST",
    `/workspaces/${workspace.id}/members/${removed}/remove`,
  );
  assert.equal(removal.statusCode, 204);
  const elsewhere = await defined(
    other,
    (await createWorkspace(other)).workspace.id,
  );

  for (const [label, memberId] of [
    ["the owner", ownerPerson.id],
    ["a claimed member", memberPerson],
    ["a removed person", removed],
  ] as const) {
    const response = await create(owner, workspace.id, { memberId });
    assert.equal(response.statusCode, 409, label);
    assert.deepEqual(response.json(), CONFLICT, label);
  }
  for (const [label, memberId] of [
    ["another workspace's person", elsewhere],
    ["an unknown person", newId<MemberId>()],
  ] as const) {
    const response = await create(owner, workspace.id, { memberId });
    assert.equal(response.statusCode, 404, label);
    assert.equal(errorCode(response), "not_found", label);
  }
  assert.deepEqual(await listed(owner, workspace.id), []);
});

test("revoking an invitation answers 204 and audits it, and revoking it again answers conflict", async (t) => {
  const owner = await signedIn(await invitationApp(t, { githubId: 3209 }));
  const admin = await signedIn(await invitationApp(t, { githubId: 3210 }));
  const { workspace } = await createWorkspace(owner);
  await addClaimed(workspace.id, admin.device, owner.device, "admin");
  const linus = await defined(owner, workspace.id);
  const { invitation } = await invited(owner, workspace.id, linus);

  const first = await revoke(admin, workspace.id, invitation.id);
  assert.equal(first.statusCode, 204, first.body);
  assert.equal(first.body, "");
  assert.deepEqual(await listed(owner, workspace.id), []);
  const row = await invitationRow(invitation.id);
  assert.ok(row.revokedAt instanceof Date);
  assert.equal(row.revokedByUserId, admin.device.userId);

  const again = await revoke(owner, workspace.id, invitation.id);
  assert.equal(again.statusCode, 409);
  assert.deepEqual(again.json(), CONFLICT);
  assert.deepEqual(
    (await invitationRow(invitation.id)).revokedAt,
    row.revokedAt,
    "the first revocation stays",
  );
  const unknown = await revoke(owner, workspace.id, newId<InvitationId>());
  assert.equal(unknown.statusCode, 404);
  assert.equal(errorCode(unknown), "not_found");
  const malformed = await revoke(owner, workspace.id, "not-an-id");
  assert.equal(malformed.statusCode, 400);
  assert.equal(errorCode(malformed), "bad_request");

  const revocations = (await auditOf(workspace.id)).filter(
    (entry) => entry.action === "invitation.revoked",
  );
  assert.deepEqual(
    revocations.map((entry) => [
      entry.actorUserId,
      entry.actorDeviceId,
      entry.subjectId,
      entry.reason,
    ]),
    [[admin.device.userId, admin.device.deviceId, invitation.id, null]],
  );

  // The person can be invited again.
  await invited(owner, workspace.id, linus);
});

test("the 51st live invitation answers 429 with rate_limited and Retry-After until the soonest expiry", async (t) => {
  const clock = fakeClock();
  const app = await invitationApp(t, { githubId: 3211, now: clock.now });
  const owner = await signedIn(app);
  const { workspace } = await createWorkspace(owner);
  const people = await addPeople(workspace.id, owner.device, 51);
  const start = clock.now();
  // 50 live invitations; the first expires in 2 hours, the others later.
  await insertInvitations(
    workspace.id,
    owner.device,
    people.slice(0, 50).map((memberId, index) => ({
      memberId,
      createdAt: new Date(start),
      expiresAt: new Date(start + 2 * HOUR_MS + index * MINUTE_MS),
    })),
  );
  const newcomer = people[50];
  assert.ok(newcomer !== undefined);

  const refused = await create(owner, workspace.id, { memberId: newcomer });
  assert.equal(refused.statusCode, 429);
  assert.deepEqual(ApiErrorBodySchema.parse(refused.json()), RATE_LIMITED);
  assert.equal(refused.headers["retry-after"], String((2 * HOUR_MS) / 1000));
  assert.equal(refused.headers["cache-control"], undefined);

  clock.advance(2 * HOUR_MS - MINUTE_MS);
  // An access token lives 15 minutes.
  const later = { ...owner, token: await accessToken(app, owner.device) };
  const still = await create(later, workspace.id, { memberId: newcomer });
  assert.equal(still.statusCode, 429);
  assert.equal(still.headers["retry-after"], "60");

  clock.advance(MINUTE_MS);
  await invited(later, workspace.id, newcomer);
  assert.equal((await listed(later, workspace.id)).length, 50);
});

test("the 101st invitation within 24 hours answers 429 with rate_limited and Retry-After, and the window slides", async (t) => {
  const clock = fakeClock();
  const app = await invitationApp(t, { githubId: 3212, now: clock.now });
  const owner = await signedIn(app);
  const { workspace } = await createWorkspace(owner);
  const linus = await defined(owner, workspace.id);
  const margaret = await defined(owner, workspace.id, "Margaret");
  const start = clock.now();
  // 100 invitations for Margaret, one a minute from 23 hours ago, all replaced.
  await insertInvitations(
    workspace.id,
    owner.device,
    Array.from({ length: 100 }, (_, index) => {
      const createdAt = new Date(start - 23 * HOUR_MS + index * MINUTE_MS);
      return {
        memberId: margaret,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 7 * DAY_MS),
        revoked: true,
      };
    }),
  );

  const refused = await create(owner, workspace.id, { memberId: linus });
  assert.equal(refused.statusCode, 429);
  assert.deepEqual(ApiErrorBodySchema.parse(refused.json()), RATE_LIMITED);
  // The oldest leaves the window in an hour.
  assert.equal(refused.headers["retry-after"], String(HOUR_MS / 1000));

  clock.advance(HOUR_MS);
  const later = { ...owner, token: await accessToken(app, owner.device) };
  await invited(later, workspace.id, linus);
  // The next one leaves the window a minute later.
  const again = await create(later, workspace.id, { memberId: margaret });
  assert.equal(again.statusCode, 429);
  assert.equal(again.headers["retry-after"], "60");
});

test("a body that breaks the protocol answers 400 with bad_request, and a code in the body is ignored", async (t) => {
  const owner = await signedIn(await invitationApp(t, { githubId: 3213 }));
  const { workspace } = await createWorkspace(owner);
  const linus = await defined(owner, workspace.id);
  for (const payload of [
    {},
    { memberId: "not-an-id" },
    { memberId: linus, lifetimeSeconds: 3_599 },
    { memberId: linus, lifetimeSeconds: 604_801 },
    { memberId: linus, lifetimeSeconds: 3_600.5 },
    { memberId: linus, lifetimeSeconds: "3600" },
  ]) {
    const response = await create(owner, workspace.id, payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(errorCode(response), "bad_request");
  }
  assert.deepEqual(await listed(owner, workspace.id), []);

  const chosen = `mmdi_${"A".repeat(43)}`;
  const response = await create(owner, workspace.id, {
    memberId: linus,
    lifetimeSeconds: 604_800,
    code: chosen,
    tokenHash: "0".repeat(64),
  });
  assert.equal(response.statusCode, 200, response.body);
  const { invitation, code } = CreateInvitationResponseSchema.parse(
    response.json(),
  );
  assert.notEqual(code, chosen);
  assert.notEqual(
    (await invitationRow(invitation.id)).tokenHash,
    "0".repeat(64),
  );
});

// The table-driven test in workspace-routes.test.ts covers an outsider on
// every route; a former admin, who could manage invitations before, gets the
// same answer here, with real IDs and whatever the body holds.
test("a removed admin gets the answer for a workspace that does not exist on the invitation routes, and changes nothing", async (t) => {
  const owner = await signedIn(await invitationApp(t, { githubId: 3214 }));
  const removedAdmin = await signedIn(
    await invitationApp(t, { githubId: 3215 }),
  );
  const { workspace } = await createWorkspace(owner);
  const formerPerson = await addClaimed(
    workspace.id,
    removedAdmin.device,
    owner.device,
    "admin",
  );
  const linus = await defined(owner, workspace.id);
  const { invitation } = await invited(owner, workspace.id, linus);
  await database()
    .update(workspaceMembers)
    .set({ removedAt: new Date(), removedByUserId: owner.device.userId })
    .where(eq(workspaceMembers.id, formerPerson));
  const unknown = newId<WorkspaceId>();

  const requests = (workspaceId: string) => [
    list(removedAdmin, workspaceId),
    create(removedAdmin, workspaceId, { memberId: linus }),
    create(removedAdmin, workspaceId, { memberId: "not-an-id" }),
    revoke(removedAdmin, workspaceId, invitation.id),
    revoke(removedAdmin, workspaceId, "not-an-id"),
  ];
  const nonMember = await Promise.all(requests(workspace.id));
  const missing = await Promise.all(requests(unknown));
  for (const [index, response] of nonMember.entries()) {
    const reference = missing[index];
    assert.ok(reference !== undefined);
    assert.equal(response.statusCode, 404, String(index));
    assert.equal(errorCode(response), "not_found");
    assert.equal(response.body, reference.body);
    assert.equal(
      response.headers["content-length"],
      reference.headers["content-length"],
    );
  }
  assert.deepEqual(await listed(owner, workspace.id), [invitation]);
});

test("the invitation routes need a valid access token", async (t) => {
  const owner = await signedIn(await invitationApp(t, { githubId: 3216 }));
  const { workspace } = await createWorkspace(owner);
  const linus = await defined(owner, workspace.id);
  const { invitation } = await invited(owner, workspace.id, linus);
  for (const [method, url, payload] of [
    ["GET", `/workspaces/${workspace.id}/invitations`, undefined],
    ["POST", `/workspaces/${workspace.id}/invitations`, { memberId: linus }],
    [
      "POST",
      `/workspaces/${workspace.id}/invitations/${invitation.id}/revoke`,
      undefined,
    ],
  ] as const) {
    const response = await owner.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(response.statusCode, 401, url);
    assert.equal(errorCode(response), "unauthorized");
  }
  assert.deepEqual(await listed(owner, workspace.id), [invitation]);
});
