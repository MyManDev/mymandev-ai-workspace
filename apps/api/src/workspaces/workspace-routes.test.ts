import {
  devices,
  userIdentities,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  ApiErrorBodySchema,
  CreateWorkspaceResponseSchema,
  MEMBERSHIP_ROUTES,
  type MemberId,
  newId,
  newUuidV7,
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

/** Adds the device's account to the workspace as a claimed member. */
async function addMember(
  workspaceId: WorkspaceId,
  device: SignedInDevice,
  addedBy: SignedInDevice,
): Promise<MemberId> {
  const id = newId<MemberId>();
  await database().insert(workspaceMembers).values({
    id,
    workspaceId,
    userId: device.userId,
    displayName: "Grace",
    role: "member",
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
  for (const [name, route] of Object.entries(MEMBERSHIP_ROUTES)) {
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
  ]) {
    assert.ok(covered.includes(name), `${name}: ${covered.join(", ")}`);
  }
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

test("the workspace routes and the device routes share the account's request limit", async (t) => {
  const app = await workspaceApp(t, { githubId: 3010 });
  const { token } = await signedIn(app);
  for (let index = 0; index < 150; index += 1) {
    assert.equal((await get(app, "/devices", token)).statusCode, 200);
    assert.equal((await get(app, "/workspaces", token)).statusCode, 200);
  }
  const limited = await get(app, `/workspaces/${newId<WorkspaceId>()}`, token);
  assert.equal(limited.statusCode, 429);
  assert.equal((limited.json() as { code: string }).code, "rate_limited");
  assert.match(String(limited.headers["retry-after"]), /^[0-9]+$/u);
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
