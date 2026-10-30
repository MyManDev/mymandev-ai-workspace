import {
  agentRuns,
  agents,
  auditEvents,
  devices,
  permissionGrants,
  projects,
  repositories,
  users,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  createTestDatabase,
  type TestDatabase,
} from "@mymandev/database/testing";
import {
  type AgentId,
  ChallengeResponseSchema,
  deviceAuthInput,
  type DeviceAuthInput,
  type DeviceId,
  DeviceListResponseSchema,
  type MemberId,
  newId,
  type PermissionGrantId,
  type ProjectId,
  type RepositoryId,
  type RunId,
  SignInResponseSchema,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { after, before, test, type TestContext } from "node:test";
import { buildApp } from "../app.ts";
import { loadConfig } from "../config.ts";
import { ApiError } from "../errors.ts";
import { Secret } from "../secret.ts";
import { lockActor } from "./device-routes.ts";
import { createGitHubApi } from "./github-api.ts";
import {
  callback,
  confirm,
  fakeGitHub,
  listenerForm,
  REDIRECT_URI,
  startAttempt,
} from "./github-test-support.ts";

const ORIGIN = "https://api.example";
const CLIENT_ID = "Iv23liExampleClient1";
const CLIENT_SECRET = "0123456789abcdef0123456789abcdef01234567";

let testDatabase: TestDatabase | undefined;

before(async () => {
  testDatabase = await createTestDatabase();
});

after(async () => {
  await testDatabase?.close();
});

function database() {
  assert.ok(testDatabase, "the test database is created in before()");
  return testDatabase.db;
}

type Key = Readonly<{ privateKey: KeyObject; publicKey: string }>;

function newKey(): Key {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .subarray(12)
    .toString("hex");
  return { privateKey, publicKey };
}

function signInput(key: Key, input: DeviceAuthInput): string {
  return sign(
    null,
    Buffer.from(deviceAuthInput(input), "utf8"),
    key.privateKey,
  ).toString("base64url");
}

type App = Awaited<ReturnType<typeof buildApp>>;

async function tokenApp(
  t: TestContext,
  options: Readonly<{
    githubId: number;
    now?: () => number;
    logLines?: string[];
  }>,
): Promise<App> {
  const github = fakeGitHub({
    user: {
      id: options.githubId,
      login: `user-${options.githubId}`,
      name: null,
      created_at: "2015-06-01T10:00:00Z",
    },
  });
  const app = await buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      API_PUBLIC_ORIGIN: ORIGIN,
      API_GITHUB_CLIENT_ID: CLIENT_ID,
      API_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    }),
    version: "1.2.3",
    logger:
      options.logLines === undefined
        ? false
        : { stream: { write: (line: string) => options.logLines?.push(line) } },
    shutdownGraceMs: 50,
    github: createGitHubApi({
      clientId: CLIENT_ID,
      clientSecret: new Secret(CLIENT_SECRET),
      fetch: github.fetch,
    }),
    database: database(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  t.after(() => app.close());
  return app;
}

/** A sign-in code and its verifier from the browser flow. */
async function signInCode(app: App) {
  const attempt = await startAttempt(app);
  await callback(app, attempt, {
    code: "github-code",
    state: attempt.apiState,
  });
  const code =
    listenerForm((await confirm(app, attempt, "continue")).body)?.fields.code ??
    "";
  return { code, codeVerifier: attempt.codeVerifier };
}

/**
 * Signs in a new device through the browser flow and POST /auth/sign-in;
 * with `previousDeviceId`, the new device replaces that one.
 */
async function signInDevice(
  app: App,
  key: Key = newKey(),
  previousDeviceId?: string,
) {
  const { code, codeVerifier } = await signInCode(app);
  const response = await app.inject({
    method: "POST",
    url: "/auth/sign-in",
    payload: {
      code,
      codeVerifier,
      redirectUri: REDIRECT_URI,
      device: {
        kind: "new",
        publicKey: key.publicKey,
        keyAlgorithm: "ed25519",
        label: "Laptop",
        platform: "macos",
        newKeySignature: signInput(key, {
          purpose: "sign-in",
          audience: ORIGIN,
          signInCode: code,
          deviceId: null,
          newPublicKey: key.publicKey,
        }),
        ...(previousDeviceId === undefined ? {} : { previousDeviceId }),
      },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const answer = SignInResponseSchema.parse(response.json());
  return { userId: answer.userId, deviceId: answer.deviceId, key };
}

type SignedInDevice = Awaited<ReturnType<typeof signInDevice>>;

/** Signs an existing device in again with a new key, as the desktop does to replace its key. */
async function signInAgain(
  app: App,
  device: SignedInDevice,
  next: Key = newKey(),
): Promise<SignedInDevice> {
  const { code, codeVerifier } = await signInCode(app);
  const input = {
    purpose: "sign-in",
    audience: ORIGIN,
    signInCode: code,
    deviceId: device.deviceId,
    newPublicKey: next.publicKey,
  } as const;
  const response = await app.inject({
    method: "POST",
    url: "/auth/sign-in",
    payload: {
      code,
      codeVerifier,
      redirectUri: REDIRECT_URI,
      device: {
        kind: "existing",
        deviceId: device.deviceId,
        publicKey: next.publicKey,
        keyAlgorithm: "ed25519",
        currentKeySignature: signInput(device.key, input),
        newKeySignature: signInput(next, input),
      },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return { ...device, key: next };
}

async function challenge(app: App) {
  return ChallengeResponseSchema.parse(
    (await app.inject({ method: "POST", url: "/auth/challenge" })).json(),
  );
}

/** Asks for an access token; `signWith` changes how the input is signed. */
async function requestToken(
  app: App,
  device: Readonly<{ deviceId: string; key: Key }>,
  signWith: (input: DeviceAuthInput & { purpose: "http" }) => string = (
    input,
  ) => signInput(device.key, input),
) {
  const { challengeId, nonce } = await challenge(app);
  const input = {
    purpose: "http",
    audience: ORIGIN,
    nonce,
    deviceId: device.deviceId,
    challengeId,
  } as const;
  return app.inject({
    method: "POST",
    url: "/auth/access-token",
    payload: {
      deviceId: device.deviceId,
      challengeId,
      signature: signWith(input),
    },
  });
}

async function token(
  app: App,
  device: Readonly<{ deviceId: string; key: Key }>,
): Promise<string> {
  const response = await requestToken(app, device);
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { accessToken: string }).accessToken;
}

function get(app: App, url: string, accessToken: string | null) {
  return app.inject({
    method: "GET",
    url,
    headers:
      accessToken === null ? {} : { authorization: `Bearer ${accessToken}` },
  });
}

function post(app: App, url: string, accessToken: string, payload?: object) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${accessToken}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

const UNAUTHORIZED = {
  statusCode: 401,
  error: "Unauthorized",
  message: "Unauthorized",
  code: "unauthorized",
};

function codeOf(response: { json(): unknown }): string {
  return (response.json() as { code: string }).code;
}

test("an access token works for 15 minutes and is then refused with unauthorized", async (t) => {
  let clock = Date.now();
  const app = await tokenApp(t, { githubId: 2001, now: () => clock });
  const device = await signInDevice(app);
  const challenged = await app.inject({
    method: "POST",
    url: "/auth/challenge",
  });
  assert.equal(challenged.headers["cache-control"], "no-store");
  const minted = await requestToken(app, device);
  assert.equal(minted.statusCode, 200);
  assert.equal(minted.headers["cache-control"], "no-store");
  const body = minted.json() as { accessToken: string; expiresAt: string };
  assert.match(body.accessToken, /^mmda_[A-Za-z0-9_-]{43}$/u);
  assert.equal(Date.parse(body.expiresAt) - clock, 15 * 60_000);

  const list = await get(app, "/devices", body.accessToken);
  assert.equal(list.statusCode, 200);
  clock += 15 * 60_000 - 1;
  assert.equal((await get(app, "/devices", body.accessToken)).statusCode, 200);
  clock += 1;
  const expired = await get(app, "/devices", body.accessToken);
  assert.equal(expired.statusCode, 401);
  assert.deepEqual(expired.json(), UNAUTHORIZED);
});

test("a missing, malformed, or unknown token gets the same 401", async (t) => {
  const app = await tokenApp(t, { githubId: 2002 });
  for (const header of [
    null,
    "mmda_x",
    `Bearer mmda_${"A".repeat(43)}`,
    "Basic abc",
    `bearer ${"x"}`,
  ]) {
    const response = await app.inject({
      method: "GET",
      url: "/devices",
      headers: header === null ? {} : { authorization: header },
    });
    assert.equal(response.statusCode, 401, String(header));
    assert.deepEqual(response.json(), UNAUTHORIZED);
  }
  const invalidBody = await app.inject({
    method: "POST",
    url: "/devices/x/revoke",
    payload: { reason: "x" },
  });
  assert.deepEqual(
    invalidBody.json(),
    UNAUTHORIZED,
    "authentication comes before validation",
  );
});

test("a token stops working when its device is revoked or signed out, or its account is disabled", async (t) => {
  const app = await tokenApp(t, { githubId: 2003 });
  const cases: [
    label: string,
    change: (
      device: Awaited<ReturnType<typeof signInDevice>>,
    ) => Promise<unknown>,
  ][] = [
    [
      "revoked",
      (d) =>
        database()
          .update(devices)
          .set({ revokedAt: new Date(), revocationReason: "removed" })
          .where(eq(devices.id, d.deviceId)),
    ],
    [
      "signed out",
      (d) =>
        database()
          .update(devices)
          .set({ signedOutAt: new Date() })
          .where(eq(devices.id, d.deviceId)),
    ],
    [
      "GitHub revocation",
      (d) =>
        database()
          .update(users)
          .set({ signInRequiredAt: new Date(Date.now() + 1_000) })
          .where(eq(users.id, d.userId)),
    ],
    [
      "disabled",
      (d) =>
        database()
          .update(users)
          .set({ disabledAt: new Date() })
          .where(eq(users.id, d.userId)),
    ],
  ];
  for (const [label, change] of cases) {
    const device = await signInDevice(app);
    const accessToken = await token(app, device);
    assert.equal(
      (await get(app, "/devices", accessToken)).statusCode,
      200,
      label,
    );
    await change(device);
    const refused = await get(app, "/devices", accessToken);
    assert.deepEqual(refused.json(), UNAUTHORIZED, label);
    // Reset the account for the next case.
    await database()
      .update(users)
      .set({ disabledAt: null, signInRequiredAt: null })
      .where(eq(users.id, device.userId));
  }
});

test("a reused or expired challenge, the ws purpose, and another audience fail with auth_failed", async (t) => {
  let clock = Date.now();
  const app = await tokenApp(t, { githubId: 2004, now: () => clock });
  const device = await signInDevice(app);

  const { challengeId, nonce } = await challenge(app);
  const signature = signInput(device.key, {
    purpose: "http",
    audience: ORIGIN,
    nonce,
    deviceId: device.deviceId,
    challengeId,
  });
  const payload = { deviceId: device.deviceId, challengeId, signature };
  assert.equal(
    (await app.inject({ method: "POST", url: "/auth/access-token", payload }))
      .statusCode,
    200,
  );
  assert.equal(
    codeOf(
      await app.inject({ method: "POST", url: "/auth/access-token", payload }),
    ),
    "auth_failed",
    "reused",
  );

  const late = await challenge(app);
  clock += 60_000;
  const lateSignature = signInput(device.key, {
    purpose: "http",
    audience: ORIGIN,
    nonce: late.nonce,
    deviceId: device.deviceId,
    challengeId: late.challengeId,
  });
  assert.equal(
    codeOf(
      await app.inject({
        method: "POST",
        url: "/auth/access-token",
        payload: {
          deviceId: device.deviceId,
          challengeId: late.challengeId,
          signature: lateSignature,
        },
      }),
    ),
    "auth_failed",
    "expired",
  );

  const ws = await requestToken(app, device, (input) =>
    signInput(device.key, {
      purpose: "ws",
      audience: ORIGIN,
      nonce: input.nonce,
      deviceId: input.deviceId,
      connectionId: input.challengeId,
    }),
  );
  assert.equal(codeOf(ws), "auth_failed", "ws purpose");
  const otherAudience = await requestToken(app, device, (input) =>
    signInput(device.key, { ...input, audience: "https://other.example" }),
  );
  assert.equal(codeOf(otherAudience), "auth_failed", "another audience");
  const otherKey = await requestToken(app, device, (input) =>
    signInput(newKey(), input),
  );
  assert.equal(codeOf(otherKey), "auth_failed", "another key");
  const unknown = await requestToken(app, {
    deviceId: newId<DeviceId>(),
    key: device.key,
  });
  assert.equal(codeOf(unknown), "auth_failed", "unknown device");
});

test("device_revoked and sign_in_required come only after a valid signature", async (t) => {
  const clock = Date.now();
  const app = await tokenApp(t, { githubId: 2005, now: () => clock });
  const states: [
    label: string,
    expected: string,
    change: (
      device: Awaited<ReturnType<typeof signInDevice>>,
    ) => Promise<unknown>,
  ][] = [
    [
      "revoked",
      "device_revoked",
      (d) =>
        database()
          .update(devices)
          .set({ revokedAt: new Date(), revocationReason: "lost" })
          .where(eq(devices.id, d.deviceId)),
    ],
    [
      "signed out",
      "sign_in_required",
      (d) =>
        database()
          .update(devices)
          .set({ signedOutAt: new Date() })
          .where(eq(devices.id, d.deviceId)),
    ],
    [
      "sign-in older than 30 days",
      "sign_in_required",
      (d) =>
        database()
          .update(devices)
          .set({ lastSignInAt: new Date(clock - 30 * 24 * 60 * 60_000) })
          .where(eq(devices.id, d.deviceId)),
    ],
    [
      "GitHub revocation",
      "sign_in_required",
      (d) =>
        database()
          .update(users)
          .set({ signInRequiredAt: new Date(clock + 1_000) })
          .where(eq(users.id, d.userId)),
    ],
    [
      "disabled account",
      "auth_failed",
      (d) =>
        database()
          .update(users)
          .set({ disabledAt: new Date() })
          .where(eq(users.id, d.userId)),
    ],
  ];
  for (const [label, expected, change] of states) {
    const device = await signInDevice(app);
    await change(device);
    const valid = await requestToken(app, device);
    assert.equal(codeOf(valid), expected, label);
    const forged = await requestToken(app, device, (input) =>
      signInput(newKey(), input),
    );
    assert.equal(
      codeOf(forged),
      "auth_failed",
      `${label} with a bad signature`,
    );
    await database()
      .update(users)
      .set({ disabledAt: null, signInRequiredAt: null })
      .where(eq(users.id, device.userId));
  }
});

test("the device list shows the person's own devices with the expiry and the current flag", async (t) => {
  const app = await tokenApp(t, { githubId: 2006 });
  const first = await signInDevice(app);
  const second = await signInDevice(app);
  const other = await tokenApp(t, { githubId: 2007 });
  await signInDevice(other);
  const answer = DeviceListResponseSchema.parse(
    (await get(app, "/devices", await token(app, second))).json(),
  );
  assert.deepEqual(
    answer.devices.map((item) => item.id).sort(),
    [first.deviceId, second.deviceId].sort(),
  );
  assert.deepEqual(
    answer.devices.filter((item) => item.current).map((item) => item.id),
    [second.deviceId],
  );
  for (const item of answer.devices) {
    assert.equal(
      Date.parse(item.signInExpiresAt) - Date.parse(item.lastSignInAt),
      30 * 24 * 60 * 60_000,
    );
  }
});

/** A workspace where `owner` is the owner and `member` a member, with an agent, a grant, and a run on the member's device. */
async function sharedWorkspace(
  owner: UserId,
  member: UserId,
  memberDevice: DeviceId,
) {
  const db = database();
  const workspace = newId<WorkspaceId>();
  await db
    .insert(workspaces)
    .values({ id: workspace, name: "Team", createdByUserId: owner });
  await db.insert(workspaceMembers).values([
    {
      id: newId<MemberId>(),
      workspaceId: workspace,
      userId: owner,
      displayName: "Owner",
      role: "owner",
      addedByUserId: owner,
      claimedAt: new Date(),
    },
    {
      id: newId<MemberId>(),
      workspaceId: workspace,
      userId: member,
      displayName: "Member",
      role: "member",
      addedByUserId: owner,
      claimedAt: new Date(),
    },
  ]);
  const project = newId<ProjectId>();
  await db.insert(projects).values({
    id: project,
    workspaceId: workspace,
    name: "App",
    createdByUserId: owner,
  });
  const repository = newId<RepositoryId>();
  await db.insert(repositories).values({
    id: repository,
    projectId: project,
    name: "app",
    createdByUserId: owner,
  });
  const agent = newId<AgentId>();
  await db.insert(agents).values({
    id: agent,
    projectId: project,
    ownerUserId: member,
    hostDeviceId: memberDevice,
    name: "Builder",
  });
  const grant = newId<PermissionGrantId>();
  await db.insert(permissionGrants).values({
    id: grant,
    projectId: project,
    granteeAgentId: agent,
    hostDeviceId: memberDevice,
    grantedByUserId: member,
    capability: "repo.read",
    repositoryId: repository,
  });
  const run = newId<RunId>();
  await db.insert(agentRuns).values({
    id: run,
    agentId: agent,
    projectId: project,
    requestedByUserId: member,
    state: "running",
  });
  return { agent, grant, run };
}

test("a person cannot revoke another person's device, also as the owner of a shared workspace", async (t) => {
  const ownerApp = await tokenApp(t, { githubId: 2008 });
  const owner = await signInDevice(ownerApp);
  const memberApp = await tokenApp(t, { githubId: 2009 });
  const member = await signInDevice(memberApp);
  await sharedWorkspace(owner.userId, member.userId, member.deviceId);
  const response = await post(
    ownerApp,
    `/devices/${member.deviceId}/revoke`,
    await token(ownerApp, owner),
    { reason: "removed" },
  );
  assert.equal(response.statusCode, 404);
  assert.equal(codeOf(response), "not_found");
  const [device] = await database()
    .select()
    .from(devices)
    .where(eq(devices.id, member.deviceId));
  assert.equal(device?.revokedAt, null);
});

test("sign-out keeps the device, its agents, and their grants, and ends the device's tokens", async (t) => {
  const ownerApp = await tokenApp(t, { githubId: 2010 });
  const owner = await signInDevice(ownerApp);
  const app = await tokenApp(t, { githubId: 2011 });
  const device = await signInDevice(app);
  const { agent, grant, run } = await sharedWorkspace(
    owner.userId,
    device.userId,
    device.deviceId,
  );
  const accessToken = await token(app, device);
  const response = await post(app, "/auth/sign-out", accessToken);
  assert.equal(response.statusCode, 204);

  const [row] = await database()
    .select()
    .from(devices)
    .where(eq(devices.id, device.deviceId));
  assert.notEqual(row?.signedOutAt, null);
  assert.equal(row?.revokedAt, null);
  assert.equal(
    (await database().select().from(agents).where(eq(agents.id, agent)))[0]
      ?.disabledAt,
    null,
  );
  assert.equal(
    (
      await database()
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.id, grant))
    )[0]?.revokedAt,
    null,
  );
  assert.equal(
    (await database().select().from(agentRuns).where(eq(agentRuns.id, run)))[0]
      ?.state,
    "running",
  );
  assert.deepEqual(
    (await get(app, "/devices", accessToken)).json(),
    UNAUTHORIZED,
  );
  assert.equal(codeOf(await requestToken(app, device)), "sign_in_required");
  const audit = await database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.subjectId, device.deviceId));
  assert.ok(audit.some((entry) => entry.action === "device.signed_out"));
});

test("revoking a device disables its agents, revokes their grants, cancels their runs, and ends its tokens", async (t) => {
  const ownerApp = await tokenApp(t, { githubId: 2012 });
  const owner = await signInDevice(ownerApp);
  const app = await tokenApp(t, { githubId: 2013 });
  const lost = await signInDevice(app);
  const current = await signInDevice(app);
  const { agent, grant, run } = await sharedWorkspace(
    owner.userId,
    lost.userId,
    lost.deviceId,
  );
  const lostToken = await token(app, lost);
  const response = await post(
    app,
    `/devices/${lost.deviceId}/revoke`,
    await token(app, current),
    { reason: "removed" },
  );
  assert.equal(response.statusCode, 204);
  assert.notEqual(
    (await database().select().from(agents).where(eq(agents.id, agent)))[0]
      ?.disabledAt,
    null,
  );
  assert.notEqual(
    (
      await database()
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.id, grant))
    )[0]?.revokedAt,
    null,
  );
  assert.equal(
    (await database().select().from(agentRuns).where(eq(agentRuns.id, run)))[0]
      ?.state,
    "cancelled",
  );
  assert.deepEqual(
    (await get(app, "/devices", lostToken)).json(),
    UNAUTHORIZED,
  );
  const again = await post(
    app,
    `/devices/${lost.deviceId}/revoke`,
    await token(app, current),
    { reason: "removed" },
  );
  assert.equal(codeOf(again), "conflict", "a revoked device never comes back");
  const badReason = await post(
    app,
    `/devices/${current.deviceId}/revoke`,
    await token(app, current),
    { reason: "replaced" },
  );
  assert.equal(codeOf(badReason), "bad_request");
});

test("a lost device locks new registrations for 7 days, existing devices keep working, and lifting ends the lock", async (t) => {
  const app = await tokenApp(t, { githubId: 2014 });
  const lost = await signInDevice(app);
  const current = await signInDevice(app);
  const accessToken = await token(app, current);
  assert.equal(
    (
      await post(app, `/devices/${lost.deviceId}/revoke`, accessToken, {
        reason: "lost",
      })
    ).statusCode,
    204,
  );
  const [user] = await database()
    .select()
    .from(users)
    .where(eq(users.id, current.userId));
  const lockedFor =
    (user?.deviceRegistrationLockedUntil?.getTime() ?? 0) - Date.now();
  assert.ok(
    lockedFor > 7 * 24 * 60 * 60_000 - 60_000 &&
      lockedFor <= 7 * 24 * 60 * 60_000,
    String(lockedFor),
  );

  const { code, codeVerifier } = await signInCode(app);
  const key = newKey();
  const refused = await app.inject({
    method: "POST",
    url: "/auth/sign-in",
    payload: {
      code,
      codeVerifier,
      redirectUri: REDIRECT_URI,
      device: {
        kind: "new",
        publicKey: key.publicKey,
        keyAlgorithm: "ed25519",
        label: "New",
        platform: "linux",
        newKeySignature: signInput(key, {
          purpose: "sign-in",
          audience: ORIGIN,
          signInCode: code,
          deviceId: null,
          newPublicKey: key.publicKey,
        }),
      },
    },
  });
  assert.equal(codeOf(refused), "device_registration_locked");
  // A token of an existing device still works during the lock, and so does
  // a repeated sign-in of that device.
  assert.equal((await get(app, "/devices", accessToken)).statusCode, 200);
  const signedInAgain = await signInAgain(app, current);

  assert.equal(
    (
      await post(
        app,
        "/account/registration-lock/lift",
        await token(app, signedInAgain),
      )
    ).statusCode,
    204,
  );
  await signInDevice(app);
  const audit = await database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.subjectId, current.userId));
  assert.deepEqual(
    audit
      .map((entry) => entry.action)
      .filter((action) => action.startsWith("account.registration"))
      .sort(),
    ["account.registration_lock_lifted", "account.registration_locked"],
  );
});

test("access tokens are limited per device, with Retry-After", async (t) => {
  const app = await tokenApp(t, { githubId: 2015 });
  const device = await signInDevice(app);
  for (let index = 0; index < 30; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      remoteAddress: `10.0.0.${index}`,
    });
    const { challengeId, nonce } = ChallengeResponseSchema.parse(
      response.json(),
    );
    const signature = signInput(device.key, {
      purpose: "http",
      audience: ORIGIN,
      nonce,
      deviceId: device.deviceId,
      challengeId,
    });
    const minted = await app.inject({
      method: "POST",
      url: "/auth/access-token",
      remoteAddress: `10.0.0.${index}`,
      payload: { deviceId: device.deviceId, challengeId, signature },
    });
    assert.equal(minted.statusCode, 200, String(index));
  }
  const limited = await requestToken(app, device);
  assert.equal(limited.statusCode, 429);
  assert.equal(codeOf(limited), "rate_limited");
  assert.match(String(limited.headers["retry-after"]), /^[0-9]+$/u);
});

test("no Authorization header, token, nonce, or signature reaches the logs", async (t) => {
  const logLines: string[] = [];
  const app = await tokenApp(t, { githubId: 2016, logLines });
  const device = await signInDevice(app);
  const { challengeId, nonce } = await challenge(app);
  const signature = signInput(device.key, {
    purpose: "http",
    audience: ORIGIN,
    nonce,
    deviceId: device.deviceId,
    challengeId,
  });
  const minted = await app.inject({
    method: "POST",
    url: "/auth/access-token",
    payload: { deviceId: device.deviceId, challengeId, signature },
  });
  const accessToken = (minted.json() as { accessToken: string }).accessToken;
  await get(app, "/devices", accessToken);
  await get(app, "/devices", `mmda_${"B".repeat(43)}`);
  const logs = logLines.join("");
  assert.ok(logs.length > 0);
  for (const secret of [accessToken, nonce, signature, "Bearer"]) {
    assert.equal(logs.includes(secret), false, secret);
  }
});

test("the global cap of 1,000 open challenges answers 429 with Retry-After", async (t) => {
  const app = await tokenApp(t, { githubId: 2017 });
  for (let index = 0; index < 1_000; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      remoteAddress: `10.${Math.floor(index / 250)}.${index % 250}.1`,
    });
    assert.equal(response.statusCode, 200, String(index));
  }
  const capped = await app.inject({
    method: "POST",
    url: "/auth/challenge",
    remoteAddress: "10.9.9.9",
  });
  assert.equal(capped.statusCode, 429);
  assert.equal(codeOf(capped), "rate_limited");
  assert.equal(capped.headers["retry-after"], "60");
});

test("authenticated requests are limited per account", async (t) => {
  const app = await tokenApp(t, { githubId: 2018 });
  const device = await signInDevice(app);
  const accessToken = await token(app, device);
  for (let index = 0; index < 300; index += 1) {
    assert.equal(
      (await get(app, "/devices", accessToken)).statusCode,
      200,
      String(index),
    );
  }
  const limited = await get(app, "/devices", accessToken);
  assert.equal(limited.statusCode, 429);
  assert.equal(codeOf(limited), "rate_limited");
  assert.match(String(limited.headers["retry-after"]), /^[0-9]+$/u);
});

test("the Bearer scheme ignores case", async (t) => {
  const app = await tokenApp(t, { githubId: 2019 });
  const accessToken = await token(app, await signInDevice(app));
  for (const scheme of ["Bearer", "bearer", "BEARER"]) {
    const response = await app.inject({
      method: "GET",
      url: "/devices",
      headers: { authorization: `${scheme} ${accessToken}` },
    });
    assert.equal(response.statusCode, 200, scheme);
  }
});

test("a new sign-in of a device ends the tokens of its earlier sign-in", async (t) => {
  let clock = Date.now();
  const app = await tokenApp(t, { githubId: 2020, now: () => clock });
  const device = await signInDevice(app);
  const first = await token(app, device);
  clock += 1_000;
  const replaced = await signInAgain(app, device);
  assert.deepEqual(
    (await get(app, "/devices", first)).json(),
    UNAUTHORIZED,
    "after the key was replaced",
  );
  assert.equal(
    codeOf(await requestToken(app, device)),
    "auth_failed",
    "the old key no longer signs",
  );

  // A GitHub revocation, then a new sign-in: the earlier token stays refused.
  const second = await token(app, replaced);
  await database()
    .update(users)
    .set({ signInRequiredAt: new Date(clock + 500) })
    .where(eq(users.id, device.userId));
  assert.deepEqual((await get(app, "/devices", second)).json(), UNAUTHORIZED);
  clock += 1_000;
  const again = await signInAgain(app, replaced);
  assert.deepEqual(
    (await get(app, "/devices", second)).json(),
    UNAUTHORIZED,
    "after the new sign-in",
  );
  assert.equal(
    (await get(app, "/devices", await token(app, again))).statusCode,
    200,
  );
});

test("a token is refused once its device's sign-in is 30 days old", async (t) => {
  let clock = Date.now();
  const app = await tokenApp(t, { githubId: 2021, now: () => clock });
  const device = await signInDevice(app);
  clock += 30 * 24 * 60 * 60_000 - 60_000;
  const accessToken = await token(app, device);
  assert.equal((await get(app, "/devices", accessToken)).statusCode, 200);
  clock += 60_000;
  assert.deepEqual(
    (await get(app, "/devices", accessToken)).json(),
    UNAUTHORIZED,
  );
});

test("a request whose body arrives after its device was revoked is refused", async (t) => {
  const app = await tokenApp(t, { githubId: 2022 });
  const stolen = await signInDevice(app);
  const stolenToken = await token(app, stolen);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  const crlf = String.fromCharCode(13, 10);
  const socket = connect(address.port, "127.0.0.1");
  await once(socket, "connect");
  let raw = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    raw += chunk;
  });
  socket.on("error", () => {
    // An early answer may close the connection before the rest of the body.
  });
  const closed = once(socket, "close");
  // The headers and half of the body, while the token is still valid.
  socket.write(
    [
      "POST /account/registration-lock/lift HTTP/1.1",
      "Host: 127.0.0.1",
      `Authorization: Bearer ${stolenToken}`,
      "Content-Type: application/json",
      "Content-Length: 2",
      "Connection: close",
      "",
      "{",
    ].join(crlf),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The device is revoked as lost, which locks new devices. The change goes
  // straight to the database, so the token stays in the API's memory and the
  // refusal must come from the checks after the body.
  const lockedUntil = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  await database()
    .update(devices)
    .set({ revokedAt: new Date(), revocationReason: "lost" })
    .where(eq(devices.id, stolen.deviceId));
  await database()
    .update(users)
    .set({ deviceRegistrationLockedUntil: lockedUntil })
    .where(eq(users.id, stolen.userId));
  socket.write("}");
  await closed;
  assert.ok(raw.startsWith("HTTP/1.1 401 "), raw);
  const [user] = await database()
    .select()
    .from(users)
    .where(eq(users.id, stolen.userId));
  assert.equal(
    user?.deviceRegistrationLockedUntil?.getTime(),
    lockedUntil.getTime(),
    "the lock stays",
  );
});

test("inside a transaction, lockActor refuses a device or an account that changed after authentication", async (t) => {
  let clock = Date.now();
  const app = await tokenApp(t, { githubId: 2026, now: () => clock });
  const unauthorized = (error: unknown) =>
    error instanceof ApiError && error.code === "unauthorized";
  const changes: [
    label: string,
    change: (device: SignedInDevice) => Promise<unknown>,
  ][] = [
    [
      "a new sign-in",
      async (d) => {
        clock += 1_000;
        await signInAgain(app, d);
      },
    ],
    [
      "revoked",
      (d) =>
        database()
          .update(devices)
          .set({ revokedAt: new Date(clock), revocationReason: "removed" })
          .where(eq(devices.id, d.deviceId)),
    ],
    [
      "signed out",
      (d) =>
        database()
          .update(devices)
          .set({ signedOutAt: new Date(clock) })
          .where(eq(devices.id, d.deviceId)),
    ],
    [
      "disabled",
      (d) =>
        database()
          .update(users)
          .set({ disabledAt: new Date(clock) })
          .where(eq(users.id, d.userId)),
    ],
  ];
  for (const [label, change] of changes) {
    const device = await signInDevice(app);
    const [row] = await database()
      .select({ lastSignInAt: devices.lastSignInAt })
      .from(devices)
      .where(eq(devices.id, device.deviceId));
    assert.ok(row !== undefined);
    const auth = {
      userId: device.userId,
      deviceId: device.deviceId,
      signedInAt: row.lastSignInAt.getTime(),
    };
    await database().transaction((tx) => lockActor(tx, auth, clock));
    await change(device);
    await assert.rejects(
      database().transaction((tx) => lockActor(tx, auth, clock)),
      unauthorized,
      label,
    );
  }
});

test("tokens ended by a new sign-in or a replacement do not use up the account's request limit", async (t) => {
  let clock = Date.now();
  const app = await tokenApp(t, { githubId: 2027, now: () => clock });
  const device = await signInDevice(app);
  const beforeSignIn = await token(app, device);
  const replaced = await signInDevice(app);
  const ofReplaced = await token(app, replaced);
  clock += 1_000;
  const again = await signInAgain(app, device);
  await signInDevice(app, newKey(), replaced.deviceId);
  for (let index = 0; index < 301; index += 1) {
    for (const stale of [beforeSignIn, ofReplaced]) {
      assert.equal(
        (await get(app, "/devices", stale)).statusCode,
        401,
        String(index),
      );
    }
  }
  assert.equal(
    (await get(app, "/devices", await token(app, again))).statusCode,
    200,
  );
});

test("forged signatures do not use the device's token budget", async (t) => {
  const app = await tokenApp(t, { githubId: 2023 });
  const device = await signInDevice(app);
  for (let index = 0; index < 31; index += 1) {
    const remoteAddress = `10.1.0.${index}`;
    const { challengeId, nonce } = ChallengeResponseSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: "/auth/challenge",
          remoteAddress,
        })
      ).json(),
    );
    const forged = await app.inject({
      method: "POST",
      url: "/auth/access-token",
      remoteAddress,
      payload: {
        deviceId: device.deviceId,
        challengeId,
        signature: signInput(newKey(), {
          purpose: "http",
          audience: ORIGIN,
          nonce,
          deviceId: device.deviceId,
          challengeId,
        }),
      },
    });
    assert.equal(codeOf(forged), "auth_failed", String(index));
  }
  assert.equal((await requestToken(app, device)).statusCode, 200);
});

test("a device keeps at most three live tokens; a fourth ends the oldest", async (t) => {
  const app = await tokenApp(t, { githubId: 2024 });
  const device = await signInDevice(app);
  const [oldest, ...live] = [
    await token(app, device),
    await token(app, device),
    await token(app, device),
    await token(app, device),
  ];
  assert.ok(oldest !== undefined);
  assert.deepEqual((await get(app, "/devices", oldest)).json(), UNAUTHORIZED);
  for (const accessToken of live) {
    assert.equal((await get(app, "/devices", accessToken)).statusCode, 200);
  }
});

test("a device cannot revoke itself as lost, but can remove itself", async (t) => {
  const app = await tokenApp(t, { githubId: 2025 });
  const device = await signInDevice(app);
  const accessToken = await token(app, device);
  const lost = await post(
    app,
    `/devices/${device.deviceId}/revoke`,
    accessToken,
    { reason: "lost" },
  );
  assert.equal(lost.statusCode, 409);
  assert.equal(codeOf(lost), "conflict");
  const [user] = await database()
    .select()
    .from(users)
    .where(eq(users.id, device.userId));
  assert.equal(user?.deviceRegistrationLockedUntil, null);
  const removed = await post(
    app,
    `/devices/${device.deviceId}/revoke`,
    accessToken,
    { reason: "removed" },
  );
  assert.equal(removed.statusCode, 204);
  assert.deepEqual(
    (await get(app, "/devices", accessToken)).json(),
    UNAUTHORIZED,
  );
});
