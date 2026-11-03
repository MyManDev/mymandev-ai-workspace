import {
  auditEvents,
  devices,
  userIdentities,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  ApiErrorBodySchema,
  CHAT_ROUTES,
  CreateProjectResponseSchema,
  CreateWorkspaceResponseSchema,
  DefineMemberResponseSchema,
  MEMBERSHIP_ROUTES,
  type MemberId,
  type MemberRole,
  newId,
  newUuidV7,
  PROJECT_ROUTES,
  type ProjectId,
  type WorkspaceId,
  WorkspaceListResponseSchema,
  WorkspaceViewResponseSchema,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { buildApp } from "../app.ts";
import {
  accessToken,
  CLIENT_ID,
  CLIENT_SECRET,
  deviceApp,
  fakeClock,
  ORIGIN,
  signInDevice,
  type SignedInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";
import { loadConfig } from "../config.ts";

const database = useTestDatabase();

type App = FastifyInstance;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function workspaceApp(
  t: TestContext,
  options: Readonly<{ githubId: number; now?: () => number }>,
): Promise<App> {
  return deviceApp(t, { database: database(), ...options });
}

/** A signed-in device of the app's account and an access token for it. */
async function signedIn(app: App) {
  const device = await signInDevice(app);
  return { device, token: await accessToken(app, device) };
}

function get(app: App, url: string, token: string | null) {
  return app.inject({
    method: "GET",
    url,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

function post(app: App, url: string, token: string | null, payload: object) {
  return app.inject({
    method: "POST",
    url,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload,
  });
}

async function createWorkspace(
  app: App,
  token: string,
  name = "Research",
  displayName = "Ada at work",
) {
  const response = await post(app, "/workspaces", token, {
    name,
    displayName,
  });
  assert.equal(response.statusCode, 200, response.body);
  return CreateWorkspaceResponseSchema.parse(response.json());
}

/** Adds the device's account to the workspace as a claimed person, a member by default. */
async function addMember(
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

const UNAUTHORIZED = {
  statusCode: 401,
  error: "Unauthorized",
  message: "Unauthorized",
  code: "unauthorized",
};

const NOT_FOUND = {
  statusCode: 404,
  error: "Not Found",
  message: "Not Found",
  code: "not_found",
};

test("creating a workspace makes the creator its claimed owner with the given name, and the list and the view show it", async (t) => {
  const app = await workspaceApp(t, { githubId: 3001 });
  const { device, token } = await signedIn(app);
  const created = await createWorkspace(app, token, "Research", "Ada at work");
  const [identity] = await database()
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.userId, device.userId));
  assert.ok(identity !== undefined);
  assert.deepEqual(created.workspace.name, "Research");
  assert.deepEqual(created.member, {
    id: created.member.id,
    workspaceId: created.workspace.id,
    displayName: "Ada at work",
    role: "owner",
    userId: device.userId,
    identity: {
      provider: "github",
      login: "user-3001",
      verifiedAt: identity.lastSignInAt.toISOString(),
    },
    removedAt: null,
  });

  const list = await get(app, "/workspaces", token);
  assert.equal(list.statusCode, 200);
  assert.deepEqual(WorkspaceListResponseSchema.parse(list.json()), {
    workspaces: [created],
  });

  const view = await get(app, `/workspaces/${created.workspace.id}`, token);
  assert.equal(view.statusCode, 200);
  assert.deepEqual(WorkspaceViewResponseSchema.parse(view.json()), {
    workspace: created.workspace,
    members: [created.member],
    joinRequestsPausedAt: null,
    maxUnclaimedMembers: 500,
    ownershipOffer: null,
  });
});

test("the login's verification time comes from the identity's last sign-in", async (t) => {
  const app = await workspaceApp(t, { githubId: 3002 });
  const { device, token } = await signedIn(app);
  const { workspace } = await createWorkspace(app, token);
  const verified = new Date("2026-10-20T07:45:00.000Z");
  await database()
    .update(userIdentities)
    .set({ login: "renamed-3002", lastSignInAt: verified })
    .where(eq(userIdentities.userId, device.userId));
  const view = WorkspaceViewResponseSchema.parse(
    (await get(app, `/workspaces/${workspace.id}`, token)).json(),
  );
  assert.deepEqual(view.members[0]?.identity, {
    provider: "github",
    login: "renamed-3002",
    verifiedAt: verified.toISOString(),
  });
});

test("the 11th workspace within 24 hours answers 429 with rate_limited and Retry-After, and the window slides", async (t) => {
  const clock = fakeClock();
  const app = await workspaceApp(t, { githubId: 3003, now: clock.now });
  const device = await signInDevice(app);
  let token = await accessToken(app, device);
  await createWorkspace(app, token, "First");
  clock.advance(HOUR_MS);
  // An access token lives 15 minutes.
  token = await accessToken(app, device);
  for (let index = 2; index <= 10; index += 1) {
    await createWorkspace(app, token, `Workspace ${index}`);
  }

  const refused = await post(app, "/workspaces", token, {
    name: "Eleventh",
    displayName: "Ada",
  });
  assert.equal(refused.statusCode, 429);
  assert.deepEqual(ApiErrorBodySchema.parse(refused.json()), {
    statusCode: 429,
    error: "Too Many Requests",
    message: "Too Many Requests",
    code: "rate_limited",
  });
  // The first workspace leaves the window 23 hours from now.
  assert.equal(
    refused.headers["retry-after"],
    String((DAY_MS - HOUR_MS) / 1000),
  );

  clock.advance(DAY_MS - HOUR_MS);
  token = await accessToken(app, device);
  await createWorkspace(app, token, "Eleventh");
  // The next one leaves the window in an hour.
  const again = await post(app, "/workspaces", token, {
    name: "Twelfth",
    displayName: "Ada",
  });
  assert.equal(again.statusCode, 429);
  assert.equal(again.headers["retry-after"], String(HOUR_MS / 1000));

  const list = WorkspaceListResponseSchema.parse(
    (await get(app, "/workspaces", token)).json(),
  );
  assert.equal(list.workspaces.length, 11);
});

test("a non-member and an unknown workspace get byte-identical 404 answers", async (t) => {
  const ownerApp = await workspaceApp(t, { githubId: 3004 });
  const owner = await signedIn(ownerApp);
  const { workspace } = await createWorkspace(ownerApp, owner.token);
  const outsiderApp = await workspaceApp(t, { githubId: 3005 });
  const outsider = await signedIn(outsiderApp);
  // The outsider is a member of another workspace, never of this one.
  await createWorkspace(outsiderApp, outsider.token, "Elsewhere");

  const member = await get(
    ownerApp,
    `/workspaces/${workspace.id}`,
    owner.token,
  );
  assert.equal(member.statusCode, 200);
  const nonMember = await get(
    outsiderApp,
    `/workspaces/${workspace.id}`,
    outsider.token,
  );
  const unknown = await get(
    outsiderApp,
    `/workspaces/${newId<WorkspaceId>()}`,
    outsider.token,
  );
  assert.equal(nonMember.statusCode, 404);
  assert.deepEqual(nonMember.json(), NOT_FOUND);
  assert.equal(unknown.statusCode, 404);
  assert.equal(nonMember.body, unknown.body);
  assert.equal(
    nonMember.headers["content-type"],
    unknown.headers["content-type"],
  );
  assert.equal(
    nonMember.headers["content-length"],
    unknown.headers["content-length"],
  );

  const listed = WorkspaceListResponseSchema.parse(
    (await get(outsiderApp, "/workspaces", outsider.token)).json(),
  );
  assert.deepEqual(
    listed.workspaces.map((item) => item.workspace.name),
    ["Elsewhere"],
  );

  // A malformed ID names no workspace: the same 404 for members and others.
  for (const [app, token] of [
    [ownerApp, owner.token],
    [outsiderApp, outsider.token],
  ] as const) {
    const malformed = await get(app, "/workspaces/not-an-id", token);
    assert.equal(malformed.body, unknown.body);
  }
});

test("on every route under /workspaces/:workspaceId, a non-member gets the answer for a workspace that does not exist", async (t) => {
  const ownerApp = await workspaceApp(t, { githubId: 3012 });
  const owner = await signedIn(ownerApp);
  const { workspace } = await createWorkspace(ownerApp, owner.token);
  const outsiderApp = await workspaceApp(t, { githubId: 3013 });
  const outsider = await signedIn(outsiderApp);

  // Every registered route, also those of later changes. The check runs
  // before validation, so a request without a body answers 404 too; a route
  // outside the membership scope answers something else for a non-member.
  const covered: string[] = [];
  for (const [name, route] of Object.entries({
    ...MEMBERSHIP_ROUTES,
    ...PROJECT_ROUTES,
  })) {
    const { method, path } = route;
    if (
      !path.startsWith("/workspaces/:workspaceId/") &&
      path !== "/workspaces/:workspaceId"
    ) {
      continue;
    }
    if (!outsiderApp.hasRoute({ method, url: path })) {
      continue;
    }
    covered.push(name);
    // Every other path parameter is an ID.
    const template = path.replace(/:(?!workspaceId\b)[A-Za-z]+/gu, () =>
      newUuidV7(),
    );
    const ask = (workspaceId: string) =>
      outsiderApp.inject({
        method,
        url: template.replace(":workspaceId", workspaceId),
        headers: { authorization: `Bearer ${outsider.token}` },
      });
    const nonMember = await ask(workspace.id);
    const unknown = await ask(newId<WorkspaceId>());
    assert.equal(nonMember.statusCode, 404, name);
    assert.deepEqual(nonMember.json(), NOT_FOUND, name);
    assert.equal(nonMember.body, unknown.body, name);
    assert.equal(
      nonMember.headers["content-type"],
      unknown.headers["content-type"],
      name,
    );
  }
  for (const name of [
    "getWorkspace",
    "setUnclaimedMemberLimit",
    "defineMember",
    "renameMember",
    "removeMember",
    "promoteMember",
    "demoteMember",
    "listInvitations",
    "createInvitation",
    "revokeInvitation",
    "listJoinRequests",
    "approveJoinRequest",
    "denyJoinRequest",
    "listProjects",
    "createProject",
    "renameProject",
  ]) {
    assert.ok(covered.includes(name), `${name}: ${covered.join(", ")}`);
  }
});

test("on every route under /projects/:projectId, a non-member's project, an unknown project, and a malformed project ID get the same 404", async (t) => {
  const ownerApp = await workspaceApp(t, { githubId: 3018 });
  const owner = await signedIn(ownerApp);
  const { workspace } = await createWorkspace(ownerApp, owner.token);
  const created = await post(
    ownerApp,
    `/workspaces/${workspace.id}/projects`,
    owner.token,
    { name: "App" },
  );
  assert.equal(created.statusCode, 200, created.body);
  const project = CreateProjectResponseSchema.parse(created.json()).project;
  const outsiderApp = await workspaceApp(t, { githubId: 3019 });
  const outsider = await signedIn(outsiderApp);

  // Every registered route, also those of later changes (#28). The check
  // runs before validation, so a malformed query answers 404 too.
  const covered: string[] = [];
  for (const [name, route] of Object.entries(CHAT_ROUTES)) {
    const { method, path } = route;
    if (
      !path.startsWith("/projects/:projectId/") ||
      !outsiderApp.hasRoute({ method, url: path })
    ) {
      continue;
    }
    covered.push(name);
    const ask = (app: App, token: string, projectId: string) =>
      app.inject({
        method,
        url: `${path.replace(":projectId", projectId)}?limit=0`,
        headers: { authorization: `Bearer ${token}` },
      });
    const nonMember = await ask(outsiderApp, outsider.token, project.id);
    assert.equal(nonMember.statusCode, 404, name);
    assert.deepEqual(nonMember.json(), NOT_FOUND, name);
    for (const other of [
      await ask(outsiderApp, outsider.token, newId<ProjectId>()),
      await ask(outsiderApp, outsider.token, "not-an-id"),
      await ask(ownerApp, owner.token, newId<ProjectId>()),
      await ask(ownerApp, owner.token, "not-an-id"),
    ]) {
      assert.equal(other.body, nonMember.body, name);
      assert.equal(
        other.headers["content-type"],
        nonMember.headers["content-type"],
        name,
      );
    }
  }
  assert.deepEqual(covered, ["listMessages"]);
});

test("former members are shown as former, and a removed member gets the same 404 as an outsider", async (t) => {
  const ownerApp = await workspaceApp(t, { githubId: 3006 });
  const owner = await signedIn(ownerApp);
  const { workspace, member: ownerPerson } = await createWorkspace(
    ownerApp,
    owner.token,
  );
  const memberApp = await workspaceApp(t, { githubId: 3007 });
  const member = await signedIn(memberApp);
  const memberPerson = await addMember(
    workspace.id,
    member.device,
    owner.device,
  );

  const seen = await get(
    memberApp,
    `/workspaces/${workspace.id}`,
    member.token,
  );
  assert.equal(seen.statusCode, 200);
  assert.deepEqual(
    WorkspaceListResponseSchema.parse(
      (await get(memberApp, "/workspaces", member.token)).json(),
    ).workspaces.map((item) => item.member.id),
    [memberPerson],
  );

  const removedAt = new Date("2026-10-31T16:00:00.000Z");
  await database()
    .update(workspaceMembers)
    .set({ removedAt, removedByUserId: owner.device.userId })
    .where(eq(workspaceMembers.id, memberPerson));

  const view = WorkspaceViewResponseSchema.parse(
    (await get(ownerApp, `/workspaces/${workspace.id}`, owner.token)).json(),
  );
  assert.deepEqual(
    view.members.map((person) => [person.id, person.removedAt]),
    [
      [ownerPerson.id, null],
      [memberPerson, removedAt.toISOString()],
    ],
  );
  assert.equal(view.members[1]?.identity?.login, "user-3007");

  const removed = await get(
    memberApp,
    `/workspaces/${workspace.id}`,
    member.token,
  );
  assert.equal(removed.statusCode, 404);
  assert.equal(
    removed.body,
    (await get(memberApp, `/workspaces/${newId<WorkspaceId>()}`, member.token))
      .body,
  );
  assert.deepEqual(
    WorkspaceListResponseSchema.parse(
      (await get(memberApp, "/workspaces", member.token)).json(),
    ),
    { workspaces: [] },
  );
});

test("every workspace route needs a valid access token, checked before the body and the path", async (t) => {
  const app = await workspaceApp(t, { githubId: 3008 });
  const { device, token } = await signedIn(app);
  const { workspace } = await createWorkspace(app, token);
  const requests = (bearer: string | null) => [
    get(app, "/workspaces", bearer),
    post(app, "/workspaces", bearer, { name: "", displayName: 7 }),
    get(app, `/workspaces/${workspace.id}`, bearer),
    get(app, "/workspaces/not-an-id", bearer),
  ];
  for (const bearer of [null, `mmda_${"A".repeat(43)}`]) {
    for (const response of await Promise.all(requests(bearer))) {
      assert.equal(response.statusCode, 401, String(bearer));
      assert.deepEqual(response.json(), UNAUTHORIZED);
    }
  }

  await database()
    .update(devices)
    .set({ revokedAt: new Date(), revocationReason: "removed" })
    .where(eq(devices.id, device.deviceId));
  for (const response of await Promise.all(requests(token))) {
    assert.deepEqual(response.json(), UNAUTHORIZED, "a revoked device");
  }
  const created = await database()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.createdByUserId, device.userId));
  assert.equal(created.length, 1);
});

test("a body that breaks the protocol answers 400 with bad_request and creates nothing", async (t) => {
  const app = await workspaceApp(t, { githubId: 3009 });
  const { device, token } = await signedIn(app);
  for (const payload of [
    {},
    { name: "Team" },
    { name: "", displayName: "Ada" },
    { name: "x".repeat(101), displayName: "Ada" },
    { name: "Team", displayName: "x".repeat(65) },
    { name: "Team", displayName: " " },
    { name: "Team", displayName: "Ada\u202e" },
  ]) {
    const response = await post(app, "/workspaces", token, payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal((response.json() as { code: string }).code, "bad_request");
  }
  const created = await database()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.createdByUserId, device.userId));
  assert.equal(created.length, 0);
});

test("the workspace routes, the project routes, and the device routes share the account's request limit", async (t) => {
  const app = await workspaceApp(t, { githubId: 3010 });
  const { token } = await signedIn(app);
  for (let index = 0; index < 150; index += 1) {
    assert.equal((await get(app, "/devices", token)).statusCode, 200);
    assert.equal((await get(app, "/workspaces", token)).statusCode, 200);
  }
  for (const url of [
    `/workspaces/${newId<WorkspaceId>()}`,
    `/projects/${newId<ProjectId>()}/messages`,
  ]) {
    const limited = await get(app, url, token);
    assert.equal(limited.statusCode, 429, url);
    assert.equal((limited.json() as { code: string }).code, "rate_limited");
    assert.match(String(limited.headers["retry-after"]), /^[0-9]+$/u);
  }
});

test("without a database, the workspace routes answer the generic 404", async (t) => {
  const app = await buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      API_PUBLIC_ORIGIN: ORIGIN,
      API_GITHUB_CLIENT_ID: CLIENT_ID,
      API_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    }),
    version: "1.2.3",
    logger: false,
  });
  t.after(() => app.close());
  for (const response of [
    await get(app, "/workspaces", null),
    await post(app, "/workspaces", null, { name: "Team", displayName: "Ada" }),
    await get(app, `/workspaces/${newId<WorkspaceId>()}`, null),
  ]) {
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), NOT_FOUND);
  }
});

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

async function viewOf(app: App, token: string, workspaceId: WorkspaceId) {
  const response = await get(app, `/workspaces/${workspaceId}`, token);
  assert.equal(response.statusCode, 200, response.body);
  return WorkspaceViewResponseSchema.parse(response.json());
}

function setLimit(
  app: App,
  token: string,
  workspaceId: WorkspaceId,
  payload: object,
) {
  return post(
    app,
    `/workspaces/${workspaceId}/unclaimed-member-limit`,
    token,
    payload,
  );
}

async function defineUnclaimed(
  app: App,
  token: string,
  workspaceId: WorkspaceId,
  displayName: string,
) {
  const response = await post(
    app,
    `/workspaces/${workspaceId}/members`,
    token,
    {
      displayName,
    },
  );
  assert.equal(response.statusCode, 200, response.body);
  return DefineMemberResponseSchema.parse(response.json()).member.id;
}

test("a workspace gets the limit of unclaimed people that its creator sends, 500 without one, and a limit outside 1 to 500 answers 400", async (t) => {
  const app = await workspaceApp(t, { githubId: 3014 });
  const { device, token } = await signedIn(app);

  const standard = await createWorkspace(app, token, "Standard");
  assert.equal(
    (await viewOf(app, token, standard.workspace.id)).maxUnclaimedMembers,
    500,
  );
  for (const maxUnclaimedMembers of [1, 500]) {
    const response = await post(app, "/workspaces", token, {
      name: `Limit ${maxUnclaimedMembers}`,
      displayName: "Ada",
      maxUnclaimedMembers,
    });
    assert.equal(response.statusCode, 200, response.body);
    const { workspace } = CreateWorkspaceResponseSchema.parse(response.json());
    assert.equal(
      (await viewOf(app, token, workspace.id)).maxUnclaimedMembers,
      maxUnclaimedMembers,
    );
  }

  for (const maxUnclaimedMembers of [0, 501, 2.5, "20", null]) {
    const response = await post(app, "/workspaces", token, {
      name: "Out of range",
      displayName: "Ada",
      maxUnclaimedMembers,
    });
    assert.equal(response.statusCode, 400, String(maxUnclaimedMembers));
    assert.equal((response.json() as { code: string }).code, "bad_request");
  }
  const created = await database()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.createdByUserId, device.userId));
  assert.equal(created.length, 3);
});

test("only the owner changes the limit of unclaimed people, never below their number, and the view shows it", async (t) => {
  const ownerApp = await workspaceApp(t, { githubId: 3015 });
  const owner = await signedIn(ownerApp);
  const adminApp = await workspaceApp(t, { githubId: 3016 });
  const admin = await signedIn(adminApp);
  const memberApp = await workspaceApp(t, { githubId: 3017 });
  const member = await signedIn(memberApp);
  const { workspace } = await createWorkspace(ownerApp, owner.token);
  await addMember(workspace.id, admin.device, owner.device, "admin");
  await addMember(workspace.id, member.device, owner.device);
  await defineUnclaimed(ownerApp, owner.token, workspace.id, "Linus");
  await defineUnclaimed(adminApp, admin.token, workspace.id, "Margaret");

  for (const [label, app, token] of [
    ["an admin", adminApp, admin.token],
    ["a member", memberApp, member.token],
  ] as const) {
    const refused = await setLimit(app, token, workspace.id, {
      maxUnclaimedMembers: 10,
    });
    assert.equal(refused.statusCode, 403, label);
    assert.deepEqual(refused.json(), FORBIDDEN, label);
  }
  const below = await setLimit(ownerApp, owner.token, workspace.id, {
    maxUnclaimedMembers: 1,
  });
  assert.equal(below.statusCode, 409);
  assert.deepEqual(below.json(), CONFLICT);
  for (const payload of [
    {},
    { maxUnclaimedMembers: 0 },
    { maxUnclaimedMembers: 501 },
    { maxUnclaimedMembers: 1.5 },
    { maxUnclaimedMembers: "2" },
  ]) {
    const malformed = await setLimit(
      ownerApp,
      owner.token,
      workspace.id,
      payload,
    );
    assert.equal(malformed.statusCode, 400, JSON.stringify(payload));
    assert.equal((malformed.json() as { code: string }).code, "bad_request");
  }
  assert.equal(
    (await viewOf(ownerApp, owner.token, workspace.id)).maxUnclaimedMembers,
    500,
    "a refusal changes nothing",
  );

  // Exactly the number of active unclaimed people is allowed.
  for (const maxUnclaimedMembers of [2, 2]) {
    const response = await setLimit(ownerApp, owner.token, workspace.id, {
      maxUnclaimedMembers,
    });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(response.body, "");
  }
  for (const [app, token] of [
    [ownerApp, owner.token],
    [memberApp, member.token],
  ] as const) {
    assert.equal(
      (await viewOf(app, token, workspace.id)).maxUnclaimedMembers,
      2,
      "every member sees the limit",
    );
  }
  const audited = await database()
    .select({
      action: auditEvents.action,
      actorUserId: auditEvents.actorUserId,
      actorDeviceId: auditEvents.actorDeviceId,
      subjectId: auditEvents.subjectId,
    })
    .from(auditEvents)
    .where(eq(auditEvents.action, "workspace.unclaimed_member_limit_changed"));
  assert.deepEqual(
    audited,
    [
      {
        action: "workspace.unclaimed_member_limit_changed",
        actorUserId: owner.device.userId,
        actorDeviceId: owner.device.deviceId,
        subjectId: workspace.id,
      },
    ],
    "setting the limit in force again writes nothing",
  );
});
