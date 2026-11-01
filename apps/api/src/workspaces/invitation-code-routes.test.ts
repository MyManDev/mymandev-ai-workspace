import {
  auditEvents,
  workspaceInvitations,
  workspaceMembers,
} from "@mymandev/database";
import {
  AcceptInvitationResponseSchema,
  ApiErrorBodySchema,
  CreateInvitationResponseSchema,
  CreateWorkspaceResponseSchema,
  decodeEvent,
  DefineMemberResponseSchema,
  type InvitationId,
  type MemberId,
  newId,
  PreviewInvitationResponseSchema,
  type WorkspaceId,
  WorkspaceListResponseSchema,
  WorkspaceViewResponseSchema,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  accessToken,
  deviceApp,
  type DeviceAppOptions,
  fakeClock,
  signInDevice,
  type SignedInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";
import type { WorkspaceEvent } from "./events.ts";

const database = useTestDatabase();

type App = FastifyInstance;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function codeApp(
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

function preview(session: Session, code: string) {
  return request(session, "POST", "/invitations/preview", { code });
}

function accept(session: Session, code: string) {
  return request(session, "POST", "/invitations/accept", { code });
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

/** An invitation created through the API, with its code. */
async function invited(
  session: Session,
  workspaceId: WorkspaceId,
  memberId: MemberId,
) {
  const response = await request(
    session,
    "POST",
    `/workspaces/${workspaceId}/invitations`,
    { memberId },
  );
  assert.equal(response.statusCode, 200, response.body);
  return CreateInvitationResponseSchema.parse(response.json());
}

/** A well-formed code that no invitation has. */
function unknownCode(): string {
  return `mmdi_${randomBytes(32).toString("base64url")}`;
}

function sha256(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** An invitation written directly, with a code of the test's choosing. */
async function insertInvitation(
  workspaceId: WorkspaceId,
  memberId: MemberId,
  createdBy: SignedInDevice,
  times: Readonly<{ createdAt: Date; expiresAt: Date }>,
): Promise<{ id: InvitationId; code: string }> {
  const id = newId<InvitationId>();
  const code = unknownCode();
  await database()
    .insert(workspaceInvitations)
    .values({
      id,
      workspaceId,
      memberId,
      tokenHash: sha256(code),
      createdByUserId: createdBy.userId,
      ...times,
    });
  return { id, code };
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

/** Collects the membership events that an app hands to `onWorkspaceEvent`. */
function recorder() {
  const events: WorkspaceEvent[] = [];
  return {
    events,
    onWorkspaceEvent: (event: WorkspaceEvent) => {
      events.push(event);
    },
  };
}

/** The log lines with the message `msg`, parsed. */
function logged(lines: readonly string[], msg: string) {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["msg"] === msg);
}

/** The headers of an answer, without those that change with the time or the connection. */
function stableHeaders(response: { headers: Record<string, unknown> }) {
  return Object.fromEntries(
    Object.entries(response.headers).filter(
      ([name]) => name !== "date" && name !== "connection",
    ),
  );
}

const INVITATION_INVALID = {
  statusCode: 404,
  error: "Not Found",
  message: "Not Found",
  code: "invitation_invalid",
};

const ALREADY_MEMBER = {
  statusCode: 409,
  error: "Conflict",
  message: "Conflict",
  code: "already_member",
};

const RATE_LIMITED = {
  statusCode: 429,
  error: "Too Many Requests",
  message: "Too Many Requests",
  code: "rate_limited",
};

test("a preview shows what the code claims without consuming it; accepting claims the person, is audited, and sends workspace.member.claimed; both answer with no-store", async (t) => {
  const owner = await signedIn(await codeApp(t, { githubId: 3301 }));
  const events = recorder();
  const logLines: string[] = [];
  const guest = await signedIn(
    await codeApp(t, {
      githubId: 3302,
      logLines,
      env: { API_LOG_LEVEL: "trace" },
      onWorkspaceEvent: events.onWorkspaceEvent,
    }),
  );
  const { workspace, member: ownerPerson } = await createWorkspace(owner);
  const linus = await defined(owner, workspace.id);
  const { invitation, code } = await invited(owner, workspace.id, linus);
  assert.ok(ownerPerson.identity !== null);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await preview(guest, code);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    // The inviter is shown by their person in the workspace, with the login.
    assert.deepEqual(PreviewInvitationResponseSchema.parse(response.json()), {
      workspaceName: "Research",
      displayName: "Linus",
      inviter: { displayName: "Ada at work", identity: ownerPerson.identity },
      expiresAt: invitation.expiresAt,
    });
  }
  assert.equal((await invitationRow(invitation.id)).acceptedAt, null);
  assert.deepEqual(
    (await auditOf(workspace.id)).map((entry) => entry.action),
    ["workspace.created", "member.defined", "invitation.created"],
    "a preview writes nothing",
  );

  const response = await accept(guest, code);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  const membership = AcceptInvitationResponseSchema.parse(response.json());
  assert.deepEqual(membership.workspace, workspace);
  assert.deepEqual(membership.member, {
    id: linus,
    workspaceId: workspace.id,
    displayName: "Linus",
    role: "member",
    userId: guest.device.userId,
    identity: {
      provider: "github",
      login: "user-3302",
      verifiedAt: membership.member.identity?.verifiedAt,
    },
    removedAt: null,
  });

  const row = await invitationRow(invitation.id);
  assert.ok(row.acceptedAt instanceof Date);
  assert.equal(row.acceptedByUserId, guest.device.userId);
  assert.equal(row.acceptedDeviceId, guest.device.deviceId);
  const audit = await auditOf(workspace.id);
  assert.deepEqual(
    audit
      .slice(-2)
      .map((entry) => [
        entry.action,
        entry.actorUserId,
        entry.actorDeviceId,
        entry.subjectId,
      ]),
    [
      [
        "invitation.accepted",
        guest.device.userId,
        guest.device.deviceId,
        invitation.id,
      ],
      ["member.claimed", guest.device.userId, guest.device.deviceId, linus],
    ],
  );

  // The account is a member now.
  const list = await request(guest, "GET", "/workspaces");
  assert.deepEqual(WorkspaceListResponseSchema.parse(list.json()).workspaces, [
    membership,
  ]);
  const view = await request(guest, "GET", `/workspaces/${workspace.id}`);
  assert.equal(view.statusCode, 200);
  assert.deepEqual(
    WorkspaceViewResponseSchema.parse(view.json()).members.find(
      (person) => person.id === linus,
    ),
    membership.member,
  );

  // One claimed event, from the system actor, as the protocol decodes it.
  assert.equal(events.events.length, 1);
  const [event] = events.events;
  assert.ok(event?.type === "workspace.member.claimed");
  assert.equal(event.workspaceId, workspace.id);
  assert.deepEqual(event.actor, { kind: "system" });
  assert.equal(event.deviceId, null);
  assert.deepEqual(event.payload.member, membership.member);
  assert.deepEqual(decodeEvent(JSON.parse(JSON.stringify(event))), {
    ok: true,
    event,
  });
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.payload.member));

  // Accepting again: the account is an active member of the workspace.
  for (const again of [await accept(guest, code), await preview(guest, code)]) {
    assert.equal(again.statusCode, 409);
    assert.deepEqual(again.json(), ALREADY_MEMBER);
    assert.equal(again.headers["cache-control"], "no-store");
  }
  assert.equal(events.events.length, 1, "a refusal sends no event");

  // The code is in no log line and no audit record.
  const secret = code.slice("mmdi_".length);
  assert.ok(logLines.length > 0, "the API logged at trace level");
  assert.ok(
    !logLines.join("\n").includes(secret),
    "no log line holds the code",
  );
  assert.ok(!logLines.join("\n").includes(sha256(code)), "nor its hash");
  assert.ok(!JSON.stringify(await auditOf(workspace.id)).includes(secret));
});

test("an unknown, used, expired, or revoked code and a removed person get the same invitation_invalid answer on both routes, and the log names the reason and the invitation, never the code", async (t) => {
  const owner = await signedIn(await codeApp(t, { githubId: 3303 }));
  const first = await signedIn(await codeApp(t, { githubId: 3304 }));
  const previewLog: string[] = [];
  const previewer = await signedIn(
    await codeApp(t, {
      githubId: 3305,
      logLines: previewLog,
      env: { API_LOG_LEVEL: "trace" },
    }),
  );
  const acceptLog: string[] = [];
  const accepter = await signedIn(
    await codeApp(t, {
      githubId: 3306,
      logLines: acceptLog,
      env: { API_LOG_LEVEL: "trace" },
    }),
  );
  const { workspace } = await createWorkspace(owner);

  const used = await invited(
    owner,
    workspace.id,
    await defined(owner, workspace.id),
  );
  assert.equal((await accept(first, used.code)).statusCode, 200);
  const now = Date.now();
  const expired = await insertInvitation(
    workspace.id,
    await defined(owner, workspace.id),
    owner.device,
    {
      createdAt: new Date(now - 2 * HOUR_MS),
      expiresAt: new Date(now - HOUR_MS),
    },
  );
  const revoked = await invited(
    owner,
    workspace.id,
    await defined(owner, workspace.id),
  );
  const revocation = await request(
    owner,
    "POST",
    `/workspaces/${workspace.id}/invitations/${revoked.invitation.id}/revoke`,
  );
  assert.equal(revocation.statusCode, 204);
  const removedPerson = await defined(owner, workspace.id);
  const removed = await invited(owner, workspace.id, removedPerson);
  const removal = await request(
    owner,
    "POST",
    `/workspaces/${workspace.id}/members/${removedPerson}/remove`,
  );
  assert.equal(removal.statusCode, 204);

  const cases = [
    ["an unknown code", unknownCode(), null, "unknown"],
    ["a used code", used.code, used.invitation.id, "used"],
    ["an expired code", expired.code, expired.id, "expired"],
    ["a revoked code", revoked.code, revoked.invitation.id, "revoked"],
    ["a removed person", removed.code, removed.invitation.id, "revoked"],
  ] as const;
  const before = await database()
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.workspaceId, workspace.id))
    .orderBy(workspaceInvitations.id);

  const answers = [];
  for (const [label, code] of cases) {
    for (const response of [
      await preview(previewer, code),
      await accept(accepter, code),
    ]) {
      assert.equal(response.statusCode, 404, label);
      assert.deepEqual(
        ApiErrorBodySchema.parse(response.json()),
        INVITATION_INVALID,
        label,
      );
      answers.push(response);
    }
  }
  const [reference] = answers;
  assert.ok(reference !== undefined);
  for (const response of answers) {
    assert.equal(response.body, reference.body);
    assert.deepEqual(stableHeaders(response), stableHeaders(reference));
  }
  assert.equal(reference.headers["cache-control"], "no-store");
  assert.equal(reference.headers["retry-after"], undefined);

  for (const lines of [previewLog, acceptLog]) {
    assert.deepEqual(
      logged(lines, "invitation code refused").map((entry) => [
        entry["level"],
        entry["invitationId"],
        entry["reason"],
      ]),
      cases.map(([, , invitationId, reason]) => [30, invitationId, reason]),
    );
    const text = lines.join("\n");
    for (const [label, code] of cases) {
      assert.ok(!text.includes(code.slice("mmdi_".length)), label);
      assert.ok(!text.includes(sha256(code)), label);
    }
  }

  // Nothing was consumed or claimed.
  const after = await database()
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.workspaceId, workspace.id))
    .orderBy(workspaceInvitations.id);
  assert.deepEqual(after, before);
  const claims = await database()
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, accepter.device.userId));
  assert.deepEqual(claims, []);
});

test("an active member gets already_member before the code is consumed, and the invited person can still claim it", async (t) => {
  const owner = await signedIn(await codeApp(t, { githubId: 3307 }));
  const guest = await signedIn(await codeApp(t, { githubId: 3308 }));
  const { workspace } = await createWorkspace(owner);
  const linus = await defined(owner, workspace.id);
  const { invitation, code } = await invited(owner, workspace.id, linus);

  for (const response of [
    await preview(owner, code),
    await accept(owner, code),
  ]) {
    assert.equal(response.statusCode, 409);
    assert.deepEqual(ApiErrorBodySchema.parse(response.json()), ALREADY_MEMBER);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const row = await invitationRow(invitation.id);
  assert.equal(row.acceptedAt, null);
  assert.equal(row.revokedAt, null);

  const accepted = await accept(guest, code);
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(
    AcceptInvitationResponseSchema.parse(accepted.json()).member.id,
    linus,
  );
});

test("the 11th failed preview or accept within 15 minutes answers 429 with rate_limited and Retry-After, also for a valid code, and only invitation_invalid counts", async (t) => {
  const clock = fakeClock();
  const owner = await signedIn(
    await codeApp(t, { githubId: 3309, now: clock.now }),
  );
  const proberApp = await codeApp(t, { githubId: 3310, now: clock.now });
  const prober = await signedIn(proberApp);
  const { workspace } = await createWorkspace(owner);
  const linus = await defined(owner, workspace.id);
  const { invitation, code } = await invited(owner, workspace.id, linus);
  // A code of the prober's own workspace answers already_member.
  const own = await createWorkspace(prober);
  const ownCode = (
    await invited(
      prober,
      own.workspace.id,
      await defined(prober, own.workspace.id),
    )
  ).code;

  for (let n = 0; n < 5; n += 1) {
    assert.equal((await preview(prober, unknownCode())).statusCode, 404);
  }
  clock.advance(5 * MINUTE_MS);
  for (let n = 0; n < 4; n += 1) {
    assert.equal((await accept(prober, unknownCode())).statusCode, 404);
  }
  // Neither already_member nor a malformed body counts.
  for (let n = 0; n < 3; n += 1) {
    assert.equal((await preview(prober, ownCode)).statusCode, 409);
    assert.equal((await accept(prober, ownCode)).statusCode, 409);
  }
  const malformed = await request(prober, "POST", "/invitations/accept", {
    code: "mmdi_short",
  });
  assert.equal(malformed.statusCode, 400);
  // The 10th failure.
  assert.equal((await accept(prober, unknownCode())).statusCode, 404);

  for (const response of [
    await preview(prober, unknownCode()),
    await accept(prober, code),
    await preview(prober, ownCode),
  ]) {
    assert.equal(response.statusCode, 429);
    assert.deepEqual(ApiErrorBodySchema.parse(response.json()), RATE_LIMITED);
    // The first five failures leave the window 10 minutes from now.
    assert.equal(response.headers["retry-after"], "600");
    assert.equal(response.headers["cache-control"], "no-store");
  }
  assert.equal(
    (await invitationRow(invitation.id)).acceptedAt,
    null,
    "a refused valid code is not consumed",
  );
  // Another account has its own count.
  assert.equal((await preview(owner, unknownCode())).statusCode, 404);

  clock.advance(10 * MINUTE_MS - 1_000);
  const still = await preview(prober, code);
  assert.equal(still.statusCode, 429);
  assert.equal(still.headers["retry-after"], "1");

  clock.advance(1_000);
  // An access token lives 15 minutes.
  const later = {
    ...prober,
    token: await accessToken(proberApp, prober.device),
  };
  const accepted = await accept(later, code);
  assert.equal(accepted.statusCode, 200, accepted.body);
});

test("of 15 concurrent accepts with unknown codes from one account, exactly 10 fail with invitation_invalid and the rest answer 429", async (t) => {
  const prober = await signedIn(await codeApp(t, { githubId: 3314 }));
  // PGlite answers a query without yielding to other requests, so requests
  // would run one after another. A transaction held open makes every request
  // wait for the database before its handler, as a slow database would, so
  // that all of them start before the first one fails.
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held = database().transaction(async () => {
    holding.resolve();
    await release.promise;
  });
  await holding.promise;
  const answers = Promise.all(
    Array.from({ length: 15 }, () => accept(prober, unknownCode())),
  );
  await delay(100);
  release.resolve();
  await held;
  const responses = await answers;

  const statuses = responses.map((response) => response.statusCode);
  assert.equal(statuses.filter((status) => status === 404).length, 10);
  assert.equal(statuses.filter((status) => status === 429).length, 5);
  for (const response of responses) {
    assert.deepEqual(
      ApiErrorBodySchema.parse(response.json()),
      response.statusCode === 404 ? INVITATION_INVALID : RATE_LIMITED,
    );
    assert.equal(response.headers["cache-control"], "no-store");
  }
  // The limit holds afterwards too.
  assert.equal((await preview(prober, unknownCode())).statusCode, 429);
});

test("an account removed from a workspace rejoins with a new invitation as a new person, and its earlier person stays as a former member", async (t) => {
  const owner = await signedIn(await codeApp(t, { githubId: 3311 }));
  const returning = await signedIn(await codeApp(t, { githubId: 3312 }));
  const { workspace } = await createWorkspace(owner);
  const earlier = await defined(owner, workspace.id, "Grace");
  assert.equal(
    (
      await accept(
        returning,
        (await invited(owner, workspace.id, earlier)).code,
      )
    ).statusCode,
    200,
  );
  const removal = await request(
    owner,
    "POST",
    `/workspaces/${workspace.id}/members/${earlier}/remove`,
  );
  assert.equal(removal.statusCode, 204, removal.body);

  const again = await defined(owner, workspace.id, "Grace");
  const { code } = await invited(owner, workspace.id, again);
  const previewed = await preview(returning, code);
  assert.equal(previewed.statusCode, 200, previewed.body);
  const accepted = await accept(returning, code);
  assert.equal(accepted.statusCode, 200, accepted.body);
  const membership = AcceptInvitationResponseSchema.parse(accepted.json());
  assert.equal(membership.member.id, again);

  const view = WorkspaceViewResponseSchema.parse(
    (await request(owner, "GET", `/workspaces/${workspace.id}`)).json(),
  );
  const people = view.members.filter(
    (person) => person.userId === returning.device.userId,
  );
  assert.deepEqual(
    people.map((person) => [person.id, person.removedAt === null]),
    [
      [again, true],
      [earlier, false],
    ],
  );
});

test("the routes need an access token and take the code only as a well-formed body, and every answer carries no-store", async (t) => {
  const guest = await signedIn(await codeApp(t, { githubId: 3313 }));
  const code = unknownCode();
  for (const url of ["/invitations/preview", "/invitations/accept"]) {
    const unauthenticated = await guest.app.inject({
      method: "POST",
      url,
      payload: { code },
    });
    assert.equal(unauthenticated.statusCode, 401, url);
    assert.equal(unauthenticated.headers["cache-control"], "no-store", url);

    for (const payload of [
      undefined,
      {},
      { code: "mmdi_short" },
      { code: code.toUpperCase() },
      { code: 42 },
    ]) {
      const response = await request(guest, "POST", url, payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal((response.json() as { code?: unknown }).code, "bad_request");
      assert.equal(response.headers["cache-control"], "no-store");
      assert.ok(!response.body.includes("mmdi_"), "the answer quotes no input");
    }

    // A code in the query string is not read.
    const query = await guest.app.inject({
      method: "POST",
      url: `${url}?code=${code}`,
      headers: { authorization: `Bearer ${guest.token}` },
    });
    assert.equal(query.statusCode, 400);
  }
});
