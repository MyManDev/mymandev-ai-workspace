import {
  auditEvents,
  createDatabase,
  type Database,
  devices,
  eraseAccount,
  recordGitHubRevocation,
  userIdentities,
  users,
} from "@mymandev/database";
import {
  createTestDatabase,
  type TestDatabase,
} from "@mymandev/database/testing";
import {
  ApiErrorBodySchema,
  deviceAuthInput,
  type DeviceAuthInput,
  type DeviceId,
  newId,
  SignInResponseSchema,
  type UserId,
} from "@mymandev/protocol";
import { and, eq, inArray } from "drizzle-orm";
import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
} from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildApp } from "../app.ts";
import { loadConfig } from "../config.ts";
import {
  closedWith,
  connected,
  loggedCloses,
  nextFrame,
  settle,
} from "../gateway-test-support.ts";
import { ConnectionRegistry } from "../gateway.ts";
import { Secret } from "../secret.ts";
import { randomToken, SIGN_IN_CODE_PREFIX } from "./attempts.ts";
import {
  accessToken,
  deviceApp,
  fakeClock,
  postNewDevice,
  signInAgain,
  signInDevice,
} from "./device-test-support.ts";
import { createGitHubApi } from "./github-api.ts";
import {
  callback,
  confirm,
  fakeGitHub,
  type FakeGitHubScenario,
  listenerForm,
  REDIRECT_URI,
  type StartedAttempt,
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

function signFor(
  key: Key,
  code: string,
  deviceId: string | null,
  newPublicKey: string,
): string {
  const input = deviceAuthInput({
    purpose: "sign-in",
    audience: ORIGIN,
    signInCode: code,
    deviceId,
    newPublicKey,
  });
  return sign(null, Buffer.from(input, "utf8"), key.privateKey).toString(
    "base64url",
  );
}

function signInput(key: Key, input: DeviceAuthInput): string {
  return sign(
    null,
    Buffer.from(deviceAuthInput(input), "utf8"),
    key.privateKey,
  ).toString("base64url");
}

async function signInApp(
  t: TestContext,
  options: Readonly<{
    user?: FakeGitHubScenario["user"];
    now?: () => number;
    logLines?: string[];
    database?: Database;
  }> = {},
) {
  const github = fakeGitHub(
    options.user === undefined ? {} : { user: options.user },
  );
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
    database: options.database ?? database(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  t.after(() => app.close());
  return app;
}

/**
 * Runs GitHub's callback of an attempt, a new one by default, where the API
 * reads the GitHub identity. The returned function confirms the attempt,
 * maybe later, and returns the code that reached the listener.
 */
async function identified(
  app: Awaited<ReturnType<typeof signInApp>>,
  started?: StartedAttempt,
) {
  const attempt = started ?? (await startAttempt(app));
  await callback(app, attempt, {
    code: "github-code",
    state: attempt.apiState,
  });
  return async () => {
    const done = await confirm(app, attempt, "continue");
    const code = listenerForm(done.body)?.fields.code;
    assert.ok(code !== undefined);
    return { code, codeVerifier: attempt.codeVerifier };
  };
}

/** Runs the browser part of a sign-in and returns the code that reached the listener. */
async function signInCode(app: Awaited<ReturnType<typeof signInApp>>) {
  return (await identified(app))();
}

function postSignIn(
  app: Awaited<ReturnType<typeof signInApp>>,
  payload: unknown,
) {
  return app.inject({
    method: "POST",
    url: "/auth/sign-in",
    payload: payload as object,
  });
}

/** A new device's sign-in request for a code. */
function newDeviceRequest(
  grant: { code: string; codeVerifier: string },
  key: Key,
  extra: Readonly<Record<string, unknown>> = {},
) {
  return {
    code: grant.code,
    codeVerifier: grant.codeVerifier,
    redirectUri: REDIRECT_URI,
    device: {
      kind: "new",
      publicKey: key.publicKey,
      keyAlgorithm: "ed25519",
      label: "Work laptop",
      platform: "windows",
      newKeySignature: signFor(key, grant.code, null, key.publicKey),
      ...extra,
    },
  };
}

function existingDeviceRequest(
  grant: { code: string; codeVerifier: string },
  deviceId: string,
  current: Key,
  next: Key,
) {
  return {
    code: grant.code,
    codeVerifier: grant.codeVerifier,
    redirectUri: REDIRECT_URI,
    device: {
      kind: "existing",
      deviceId,
      publicKey: next.publicKey,
      keyAlgorithm: "ed25519",
      currentKeySignature: signFor(
        current,
        grant.code,
        deviceId,
        next.publicKey,
      ),
      newKeySignature: signFor(next, grant.code, deviceId, next.publicKey),
    },
  };
}

function githubUser(id: number, login: string, name: string | null = null) {
  return { id, login, name, created_at: "2015-06-01T10:00:00Z" };
}

function codeOf(response: { json(): unknown }): string {
  return (response.json() as { code: string }).code;
}

/** GitHub's revocation of the account's authorization, recorded now as the webhook does. */
async function revokeOnGitHub(githubId: number, now: number) {
  await recordGitHubRevocation(database(), {
    subject: String(githubId),
    deliveryId: randomUUID(),
    now: new Date(now),
  });
}

/** Everything of the account that a sign-in writes, to show that a refused one wrote nothing. */
async function accountRows(userId: UserId) {
  const db = database();
  return {
    users: await db.select().from(users).where(eq(users.id, userId)),
    identities: await db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId)),
    devices: await db
      .select()
      .from(devices)
      .where(eq(devices.userId, userId))
      .orderBy(devices.id),
    audit: await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorUserId, userId))
      .orderBy(auditEvents.id),
  };
}

test("a new device signs in: the account, its GitHub identity, the device, and audit records are stored", async (t) => {
  const app = await signInApp(t, {
    user: githubUser(1001, "ada-l", "Ada Lovelace"),
  });
  const key = newKey();
  const response = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), key),
  );
  assert.equal(response.statusCode, 200);
  const answer = SignInResponseSchema.parse(response.json());
  assert.equal(answer.displayName, "Ada Lovelace");
  assert.equal(answer.login, "ada-l");
  assert.equal(
    JSON.stringify(response.json()).includes("mmd"),
    false,
    "no credential in the answer",
  );

  const db = database();
  const [identity] = await db
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.subject, "1001"));
  assert.equal(identity?.userId, answer.userId);
  assert.equal(identity?.login, "ada-l");
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, answer.deviceId));
  assert.equal(device?.publicKey, key.publicKey);
  assert.equal(device?.label, "Work laptop");
  const audit = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.actorUserId, answer.userId));
  assert.deepEqual(audit.map((row) => row.action).sort(), [
    "account.signed_in",
    "device.registered",
  ]);
  const expiry =
    Date.parse(answer.signInExpiresAt) -
    Date.parse(String(device?.lastSignInAt.toISOString()));
  assert.equal(expiry, 30 * 24 * 60 * 60_000);
});

test("a repeated sign-in replaces the key, keeps the device ID, and refreshes the login", async (t) => {
  const first = await signInApp(t, {
    user: githubUser(1002, "grace-h", "Grace"),
  });
  const key = newKey();
  const created = SignInResponseSchema.parse(
    (
      await postSignIn(first, newDeviceRequest(await signInCode(first), key))
    ).json(),
  );
  await database()
    .update(devices)
    .set({ signedOutAt: new Date() })
    .where(eq(devices.id, created.deviceId));

  const renamed = await signInApp(t, {
    user: githubUser(1002, "grace-hopper", "Grace"),
  });
  const next = newKey();
  const response = await postSignIn(
    renamed,
    existingDeviceRequest(
      await signInCode(renamed),
      created.deviceId,
      key,
      next,
    ),
  );
  assert.equal(response.statusCode, 200);
  const answer = SignInResponseSchema.parse(response.json());
  assert.equal(answer.deviceId, created.deviceId);
  assert.equal(answer.userId, created.userId);
  assert.equal(answer.login, "grace-hopper");

  const [device] = await database()
    .select()
    .from(devices)
    .where(eq(devices.id, created.deviceId));
  assert.equal(device?.publicKey, next.publicKey);
  assert.equal(device?.signedOutAt, null);
  const [identity] = await database()
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.subject, "1002"));
  assert.equal(identity?.login, "grace-hopper");
  const audit = await database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.subjectId, created.deviceId));
  assert.equal(
    audit.filter((row) => row.action === "device.key_replaced").length,
    1,
  );
});

test("the sign-in code is single use and bound to the verifier and the redirect URI", async (t) => {
  const app = await signInApp(t, { user: githubUser(1003, "linus") });
  const key = newKey();
  const grant = await signInCode(app);
  assert.equal(
    (await postSignIn(app, newDeviceRequest(grant, key))).statusCode,
    200,
  );
  // The same verifier and redirect URI: a repeated request (#152).
  const reused = await postSignIn(app, newDeviceRequest(grant, newKey()));
  assert.equal(reused.statusCode, 409);
  assert.equal(codeOf(reused), "sign_in_code_used");

  const wrongVerifier = await signInCode(app);
  const other = await signInCode(app);
  const cases = [
    {
      ...newDeviceRequest(wrongVerifier, newKey()),
      codeVerifier: other.codeVerifier,
    },
    {
      ...newDeviceRequest(await signInCode(app), newKey()),
      redirectUri: "http://127.0.0.1:50000/callback",
    },
  ];
  for (const request of cases) {
    const response = await postSignIn(app, request);
    assert.equal(response.statusCode, 401);
    assert.equal(codeOf(response), "auth_failed");
  }
  // A refused request still consumed its code, and left no record of use
  // (#152).
  const afterRefusal = await postSignIn(
    app,
    newDeviceRequest(wrongVerifier, newKey()),
  );
  assert.equal(afterRefusal.statusCode, 401);
  assert.equal(codeOf(afterRefusal), "auth_failed");
});

test("a sign-in code expires after 60 seconds", async (t) => {
  let clock = Date.parse("2026-10-30T12:00:00.000Z");
  const app = await signInApp(t, {
    user: githubUser(1004, "barbara"),
    now: () => clock,
  });
  const grant = await signInCode(app);
  clock += 60_000;
  const response = await postSignIn(app, newDeviceRequest(grant, newKey()));
  assert.equal(codeOf(response), "auth_failed");
});

test("the same sign-in request sent twice: the first commits, and the second answers 409 with sign_in_code_used and changes nothing (#152)", async (t) => {
  const app = await signInApp(t, { user: githubUser(1017, "repeated") });
  const key = newKey();
  const register = newDeviceRequest(await signInCode(app), key);
  const first = await postSignIn(app, register);
  assert.equal(first.statusCode, 200);
  const created = SignInResponseSchema.parse(first.json());
  const registered = await accountRows(created.userId);
  const second = await postSignIn(app, register);
  assert.equal(second.statusCode, 409);
  assert.deepEqual(second.json(), {
    statusCode: 409,
    error: "Conflict",
    message: "Conflict",
    code: "sign_in_code_used",
  });
  assert.deepEqual(await accountRows(created.userId), registered);

  // An existing device: the first copy replaced the key, so the second must
  // not read as "nothing was committed".
  const next = newKey();
  const replace = existingDeviceRequest(
    await signInCode(app),
    created.deviceId,
    key,
    next,
  );
  assert.equal((await postSignIn(app, replace)).statusCode, 200);
  const replaced = await accountRows(created.userId);
  assert.equal(replaced.devices[0]?.publicKey, next.publicKey);
  const again = await postSignIn(app, replace);
  assert.equal(again.statusCode, 409);
  assert.equal(codeOf(again), "sign_in_code_used");
  assert.deepEqual(await accountRows(created.userId), replaced);
});

test("a used code with another verifier or redirect URI, and an unknown code, still answer 401 with auth_failed (#152)", async (t) => {
  const app = await signInApp(t, { user: githubUser(1018, "prober") });
  const request = newDeviceRequest(await signInCode(app), newKey());
  assert.equal((await postSignIn(app, request)).statusCode, 200);
  const other = await signInCode(app);
  for (const [label, probe] of [
    ["another verifier", { ...request, codeVerifier: other.codeVerifier }],
    [
      "another redirect URI",
      { ...request, redirectUri: "http://127.0.0.1:50000/callback" },
    ],
    [
      "an unknown code",
      { ...request, code: `${SIGN_IN_CODE_PREFIX}${randomToken()}` },
    ],
  ] as const) {
    const response = await postSignIn(app, probe);
    assert.equal(response.statusCode, 401, label);
    assert.equal(codeOf(response), "auth_failed", label);
  }
  // The probes left the record of the used code.
  assert.equal(codeOf(await postSignIn(app, request)), "sign_in_code_used");
});

test("a used code answers sign_in_code_used for one code lifetime after the request that took it ended, and an expired code answers auth_failed (#152)", async (t) => {
  let clock = Date.parse("2026-11-02T12:00:00.000Z");
  const app = await signInApp(t, {
    user: githubUser(1019, "clocked"),
    now: () => clock,
  });
  const request = newDeviceRequest(await signInCode(app), newKey());
  // Taken just before the code itself expires.
  clock += 59_000;
  assert.equal((await postSignIn(app, request)).statusCode, 200);
  clock += 59_999;
  assert.equal(
    codeOf(await postSignIn(app, request)),
    "sign_in_code_used",
    "past the code's own expiry",
  );
  clock += 1;
  const late = await postSignIn(app, request);
  assert.equal(late.statusCode, 401);
  assert.equal(codeOf(late), "auth_failed");

  // A code that expired before any request took it leaves no record.
  const expired = newDeviceRequest(await signInCode(app), newKey());
  clock += 60_000;
  for (const copy of ["first", "second"]) {
    const response = await postSignIn(app, expired);
    assert.equal(response.statusCode, 401, copy);
    assert.equal(codeOf(response), "auth_failed", copy);
  }
});

test("a slow request leaves its copies the full code lifetime after it ended (#152)", async (t) => {
  let clock = Date.parse("2026-11-02T12:00:00.000Z");
  const db = database();
  // The transaction takes 50 seconds of the injected clock.
  const transaction: typeof db.transaction = (run, config) => {
    clock += 50_000;
    return db.transaction(run, config);
  };
  const slow = new Proxy(db, {
    get: (target, property, receiver) =>
      property === "transaction"
        ? transaction
        : Reflect.get(target, property, receiver),
  });
  const app = await signInApp(t, {
    user: githubUser(1020, "slow"),
    now: () => clock,
    database: slow,
  });
  const request = newDeviceRequest(await signInCode(app), newKey());
  assert.equal((await postSignIn(app, request)).statusCode, 200);
  // The request ended 50 seconds after it took the code.
  clock += 59_999;
  assert.equal(codeOf(await postSignIn(app, request)), "sign_in_code_used");
  clock += 1;
  assert.equal(codeOf(await postSignIn(app, request)), "auth_failed");
});

test("a code that a request without the attempt's verifier or redirect URI burned answers auth_failed to the attempt's own request, which changes nothing (#152)", async (t) => {
  const app = await signInApp(t, { user: githubUser(1021, "burned") });
  const key = newKey();
  const created = SignInResponseSchema.parse(
    (
      await postSignIn(app, newDeviceRequest(await signInCode(app), key))
    ).json(),
  );
  const before = await accountRows(created.userId);
  const other = await signInCode(app);
  for (const [label, burn] of [
    ["another verifier", { codeVerifier: other.codeVerifier }],
    [
      "another redirect URI",
      { redirectUri: "http://127.0.0.1:50000/callback" },
    ],
  ] as const) {
    const request = existingDeviceRequest(
      await signInCode(app),
      created.deviceId,
      key,
      newKey(),
    );
    const burned = await postSignIn(app, { ...request, ...burn });
    assert.equal(burned.statusCode, 401, label);
    assert.equal(codeOf(burned), "auth_failed", label);
    // Nothing was committed, so the attempt's own request must not read as
    // a copy of one that may have committed.
    for (const copy of ["first", "second"]) {
      const response = await postSignIn(app, request);
      assert.equal(response.statusCode, 401, `${label}, ${copy}`);
      assert.equal(codeOf(response), "auth_failed", `${label}, ${copy}`);
    }
  }
  assert.deepEqual(await accountRows(created.userId), before);
});

test("bad signatures are refused, and an existing device needs its current key and a new one", async (t) => {
  const app = await signInApp(t, { user: githubUser(1005, "margaret") });
  const key = newKey();
  const created = SignInResponseSchema.parse(
    (
      await postSignIn(app, newDeviceRequest(await signInCode(app), key))
    ).json(),
  );

  const forged = newDeviceRequest(await signInCode(app), newKey());
  forged.device.newKeySignature = signFor(
    newKey(),
    forged.code,
    null,
    forged.device.publicKey,
  );
  assert.equal(
    codeOf(await postSignIn(app, forged)),
    "auth_failed",
    "another key signed",
  );

  const swapped = newDeviceRequest(await signInCode(app), key);
  swapped.device.publicKey = newKey().publicKey;
  assert.equal(
    codeOf(await postSignIn(app, swapped)),
    "auth_failed",
    "the signature covers the new key",
  );

  // A signature over a different line of the input never counts.
  const variants: [
    label: string,
    input: (code: string, publicKey: string) => DeviceAuthInput,
  ][] = [
    [
      "audience",
      (code, publicKey) => ({
        purpose: "sign-in",
        audience: "https://other.example",
        signInCode: code,
        deviceId: null,
        newPublicKey: publicKey,
      }),
    ],
    [
      "device line",
      (code, publicKey) => ({
        purpose: "sign-in",
        audience: ORIGIN,
        signInCode: code,
        deviceId: created.deviceId,
        newPublicKey: publicKey,
      }),
    ],
  ];
  for (const [label, input] of variants) {
    const fresh = newKey();
    const request = newDeviceRequest(await signInCode(app), fresh);
    request.device.newKeySignature = signInput(
      fresh,
      input(request.code, fresh.publicKey),
    );
    assert.equal(codeOf(await postSignIn(app, request)), "auth_failed", label);
  }

  const stranger = newKey();
  const noCurrentKey = existingDeviceRequest(
    await signInCode(app),
    created.deviceId,
    stranger,
    newKey(),
  );
  assert.equal(
    codeOf(await postSignIn(app, noCurrentKey)),
    "auth_failed",
    "a stranger's key",
  );

  const sameKey = existingDeviceRequest(
    await signInCode(app),
    created.deviceId,
    key,
    key,
  );
  assert.equal(
    codeOf(await postSignIn(app, sameKey)),
    "auth_failed",
    "the key is never kept",
  );

  const [device] = await database()
    .select()
    .from(devices)
    .where(eq(devices.id, created.deviceId));
  assert.equal(device?.publicKey, key.publicKey, "the key is unchanged");
});

test("another account, a revoked device, and a disabled account are refused with their codes", async (t) => {
  const owner = await signInApp(t, { user: githubUser(1006, "owner-account") });
  const key = newKey();
  const created = SignInResponseSchema.parse(
    (
      await postSignIn(owner, newDeviceRequest(await signInCode(owner), key))
    ).json(),
  );

  const other = await signInApp(t, { user: githubUser(1007, "other-account") });
  const mismatch = await postSignIn(
    other,
    existingDeviceRequest(
      await signInCode(other),
      created.deviceId,
      key,
      newKey(),
    ),
  );
  assert.equal(mismatch.statusCode, 409);
  assert.equal(codeOf(mismatch), "device_account_mismatch");
  assert.equal(
    mismatch.body.includes("owner-account"),
    false,
    "the body carries no login",
  );

  await database()
    .update(devices)
    .set({ revokedAt: new Date(), revocationReason: "removed" })
    .where(eq(devices.id, created.deviceId));
  for (const app of [owner, other]) {
    const revoked = await postSignIn(
      app,
      existingDeviceRequest(
        await signInCode(app),
        created.deviceId,
        key,
        newKey(),
      ),
    );
    assert.equal(
      codeOf(revoked),
      "device_revoked",
      "whatever account signs in",
    );
  }

  await database()
    .update(users)
    .set({ disabledAt: new Date() })
    .where(eq(users.id, created.userId));
  const disabled = await postSignIn(
    owner,
    newDeviceRequest(await signInCode(owner), newKey()),
  );
  assert.equal(codeOf(disabled), "auth_failed");
});

test("after an operator erases an account, its device answers device_revoked and a sign-in with the same GitHub ID creates a new account", async (t) => {
  const app = await signInApp(t, { user: githubUser(1101, "erin-e", "Erin") });
  const key = newKey();
  const erased = SignInResponseSchema.parse(
    (
      await postSignIn(app, newDeviceRequest(await signInCode(app), key))
    ).json(),
  );
  const erasure = await eraseAccount(database(), {
    userId: erased.userId,
    now: new Date(),
  });
  assert.equal(erasure.erased, true);

  const revoked = await postSignIn(
    app,
    existingDeviceRequest(
      await signInCode(app),
      erased.deviceId,
      key,
      newKey(),
    ),
  );
  assert.equal(codeOf(revoked), "device_revoked");

  const again = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), newKey()),
  );
  assert.equal(again.statusCode, 200);
  const created = SignInResponseSchema.parse(again.json());
  assert.notEqual(created.userId, erased.userId);
  assert.equal(created.displayName, "Erin");
  const identities = await database()
    .select({
      userId: userIdentities.userId,
      subject: userIdentities.subject,
    })
    .from(userIdentities)
    .where(inArray(userIdentities.userId, [erased.userId, created.userId]));
  assert.deepEqual(
    new Map(identities.map((row) => [row.userId, row.subject])),
    new Map([
      [erased.userId, null],
      [created.userId, "1101"],
    ]),
  );
});

test("the registration lock refuses a new device but not a repeated sign-in", async (t) => {
  const app = await signInApp(t, { user: githubUser(1008, "locked-account") });
  const key = newKey();
  const created = SignInResponseSchema.parse(
    (
      await postSignIn(app, newDeviceRequest(await signInCode(app), key))
    ).json(),
  );
  await database()
    .update(users)
    .set({
      deviceRegistrationLockedUntil: new Date(
        Date.now() + 7 * 24 * 60 * 60_000,
      ),
    })
    .where(eq(users.id, created.userId));

  const locked = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), newKey()),
  );
  assert.equal(locked.statusCode, 403);
  assert.equal(codeOf(locked), "device_registration_locked");
  const repeated = await postSignIn(
    app,
    existingDeviceRequest(
      await signInCode(app),
      created.deviceId,
      key,
      newKey(),
    ),
  );
  assert.equal(repeated.statusCode, 200);
});

test("a sign-in whose GitHub identity was read before a recorded revocation answers sign_in_required and registers or replaces nothing", async (t) => {
  const clock = fakeClock();
  const app = await deviceApp(t, {
    database: database(),
    githubId: 1019,
    now: clock.now,
  });
  const laptop = await signInDevice(app);
  // Two sign-ins wait on the confirmation page while the person revokes the
  // app's authorization on GitHub; they continue after the webhook arrived.
  const forNewDevice = await identified(app);
  const forLaptop = await identified(app);
  clock.advance(5 * 60_000);
  await revokeOnGitHub(1019, clock.now());
  clock.advance(1_000);
  const before = await accountRows(laptop.userId);

  const requests = [
    ["a new device", newDeviceRequest(await forNewDevice(), newKey())],
    [
      "an existing device",
      existingDeviceRequest(
        await forLaptop(),
        laptop.deviceId,
        laptop.key,
        newKey(),
      ),
    ],
  ] as const;
  for (const [label, request] of requests) {
    const response = await postSignIn(app, request);
    assert.equal(response.statusCode, 401, label);
    assert.equal(codeOf(response), "sign_in_required", label);
  }
  assert.deepEqual(
    await accountRows(laptop.userId),
    before,
    "no device, key, login, or audit record changed",
  );
});

test("a sign-in whose GitHub identity was read after a recorded revocation, or at the same moment, works", async (t) => {
  const clock = fakeClock();
  const app = await deviceApp(t, {
    database: database(),
    githubId: 1020,
    now: clock.now,
  });
  const laptop = await signInDevice(app);
  // The attempt starts before the revocation; GitHub's callback comes after.
  const attempt = await startAttempt(app);
  clock.advance(60_000);
  await revokeOnGitHub(1020, clock.now());

  // Only a later revocation refuses, as for a device's last sign-in.
  const atRevocation = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), newKey()),
  );
  assert.equal(atRevocation.statusCode, 200, atRevocation.body);

  clock.advance(1_000);
  const forLaptop = await identified(app, attempt);
  const next = newKey();
  const afterRevocation = await postSignIn(
    app,
    existingDeviceRequest(await forLaptop(), laptop.deviceId, laptop.key, next),
  );
  assert.equal(afterRevocation.statusCode, 200, afterRevocation.body);
  const [device] = await database()
    .select()
    .from(devices)
    .where(eq(devices.id, laptop.deviceId));
  assert.equal(device?.publicKey, next.publicKey);
});

test("without a recorded revocation, a sign-in works although its GitHub identity was read minutes before", async (t) => {
  const clock = fakeClock();
  const app = await deviceApp(t, {
    database: database(),
    githubId: 1021,
    now: clock.now,
  });
  const laptop = await signInDevice(app);
  const forNewDevice = await identified(app);
  const forLaptop = await identified(app);
  clock.advance(9 * 60_000);

  const requests = [
    ["a new device", newDeviceRequest(await forNewDevice(), newKey())],
    [
      "an existing device",
      existingDeviceRequest(
        await forLaptop(),
        laptop.deviceId,
        laptop.key,
        newKey(),
      ),
    ],
  ] as const;
  for (const [label, request] of requests) {
    const response = await postSignIn(app, request);
    assert.equal(response.statusCode, 200, label);
  }
  const [user] = await database()
    .select({ signInRequiredAt: users.signInRequiredAt })
    .from(users)
    .where(eq(users.id, laptop.userId));
  assert.equal(user?.signInRequiredAt, null);
});

test("an account has at most 20 active devices, answered with device_limit and no Retry-After, and 10 new devices in 24 hours, answered with rate_limited and Retry-After", async (t) => {
  const app = await signInApp(t, { user: githubUser(1009, "many-devices") });
  const firstKey = newKey();
  const first = SignInResponseSchema.parse(
    (
      await postSignIn(app, newDeviceRequest(await signInCode(app), firstKey))
    ).json(),
  );
  const userId = first.userId;
  const add = async (n: number, createdAt: Date) => {
    for (let index = 0; index < n; index += 1) {
      await database().insert(devices).values({
        id: newId<DeviceId>(),
        userId,
        label: "Extra",
        platform: "linux",
        publicKey: newKey().publicKey,
        keyAlgorithm: "ed25519",
        createdAt,
        lastSignInAt: createdAt,
      });
    }
  };
  const signInNew = async () =>
    postSignIn(app, newDeviceRequest(await signInCode(app), newKey()));

  // 1 + 8 new devices: the 10th in 24 hours is allowed, the 11th is not.
  await add(8, new Date());
  assert.equal((await signInNew()).statusCode, 200, "the 10th new device");
  const eleventh = await signInNew();
  assert.equal(eleventh.statusCode, 429);
  assert.equal(codeOf(eleventh), "rate_limited");
  const wait = Number(eleventh.headers["retry-after"]);
  assert.ok(wait > 23 * 3600 && wait <= 24 * 3600, String(wait));

  // Make every device old: 10 active, 0 new in 24 hours. Up to 20 active.
  const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
  await database()
    .update(devices)
    .set({ createdAt: old })
    .where(eq(devices.userId, userId));
  await add(9, old);
  assert.equal((await signInNew()).statusCode, 200, "the 20th active device");
  await database()
    .update(devices)
    .set({ createdAt: old })
    .where(eq(devices.userId, userId));
  const before = await accountRows(userId);
  const twentyFirst = await signInNew();
  // Its own code, not `rate_limited`: only revoking a device frees a place,
  // so waiting does not help (#255).
  assert.equal(twentyFirst.statusCode, 409);
  assert.deepEqual(twentyFirst.json(), {
    statusCode: 409,
    error: "Conflict",
    message: "Conflict",
    code: "device_limit",
  });
  assert.equal(ApiErrorBodySchema.safeParse(twentyFirst.json()).success, true);
  assert.equal(twentyFirst.headers["retry-after"], undefined);
  assert.deepEqual(
    await accountRows(userId),
    before,
    "the refusal registered nothing",
  );

  // A repeated sign-in is not limited, and a revoked device frees a place.
  const repeated = await postSignIn(
    app,
    existingDeviceRequest(
      await signInCode(app),
      first.deviceId,
      firstKey,
      newKey(),
    ),
  );
  assert.equal(repeated.statusCode, 200, "a repeated sign-in at the limit");
  const [extra] = await database()
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.userId, userId), eq(devices.label, "Extra")));
  assert.ok(extra !== undefined);
  await database()
    .update(devices)
    .set({ revokedAt: new Date(), revocationReason: "removed" })
    .where(eq(devices.id, extra.id));
  assert.equal(
    (await signInNew()).statusCode,
    200,
    "a revoked device does not count",
  );
});

test("a new device at both device limits answers device_limit, not rate_limited: the limit of active devices is decided first (#255)", async (t) => {
  const app = await signInApp(t, { user: githubUser(1022, "both-limits") });
  const first = SignInResponseSchema.parse(
    (
      await postSignIn(app, newDeviceRequest(await signInCode(app), newKey()))
    ).json(),
  );
  const add = async (n: number, createdAt: Date) => {
    for (let index = 0; index < n; index += 1) {
      await database().insert(devices).values({
        id: newId<DeviceId>(),
        userId: first.userId,
        label: "Extra",
        platform: "linux",
        publicKey: newKey().publicKey,
        keyAlgorithm: "ed25519",
        createdAt,
        lastSignInAt: createdAt,
      });
    }
  };
  // 20 active devices: the first and 9 more within the last 24 hours, which
  // reach the limit of 10 new devices, and 10 created long ago.
  await add(9, new Date());
  await add(10, new Date(Date.now() - 3 * 24 * 60 * 60_000));
  const before = await accountRows(first.userId);
  assert.equal(before.devices.length, 20);

  const refused = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), newKey()),
  );
  // A wait would not free a place, and the desktop would take `rate_limited`
  // as an uncertain refusal.
  assert.equal(refused.statusCode, 409);
  assert.deepEqual(refused.json(), {
    statusCode: 409,
    error: "Conflict",
    message: "Conflict",
    code: "device_limit",
  });
  assert.equal(refused.headers["retry-after"], undefined);
  assert.deepEqual(
    await accountRows(first.userId),
    before,
    "the refusal registered nothing",
  );
});

test("the limit of 10 new devices in 24 hours refuses with rate_limited and Retry-After before anything is committed: no device, no key, no revocation, and no frame (#269)", async (t) => {
  const connections = new ConnectionRegistry();
  const app = await deviceApp(t, {
    database: database(),
    githubId: 1023,
    connections,
  });
  const laptop = await signInDevice(app);
  const laptopSocket = await connected(t, app, laptop);
  // The laptop and 9 more devices within the last 24 hours reach the limit.
  const now = new Date();
  for (let index = 0; index < 9; index += 1) {
    await database().insert(devices).values({
      id: newId<DeviceId>(),
      userId: laptop.userId,
      label: "Extra",
      platform: "linux",
      publicKey: newKey().publicKey,
      keyAlgorithm: "ed25519",
      createdAt: now,
      lastSignInAt: now,
    });
  }
  const before = await accountRows(laptop.userId);
  const key = newKey();

  // Naming the laptop as the previous device shows that its revocation
  // does not happen either.
  const refused = await postNewDevice(
    app,
    await signInCode(app),
    key,
    laptop.deviceId,
  );
  assert.equal(refused.statusCode, 429);
  assert.deepEqual(refused.json(), {
    statusCode: 429,
    error: "Too Many Requests",
    message: "Too Many Requests",
    code: "rate_limited",
  });
  const wait = Number(refused.headers["retry-after"]);
  assert.ok(wait > 23 * 3600 && wait <= 24 * 3600, String(wait));
  // The transaction refreshed the login before the limit refused; it was
  // rolled back with the rest.
  assert.deepEqual(
    await accountRows(laptop.userId),
    before,
    "the refusal registered, revoked, and refreshed nothing",
  );
  assert.deepEqual(
    await database()
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.publicKey, key.publicKey)),
    [],
    "no device holds the new key",
  );
  await settle();
  assert.equal(laptopSocket.client.unread(), 0, "no frame");
  assert.equal(
    laptopSocket.client.ws.readyState,
    laptopSocket.client.ws.OPEN,
    "the named previous device stays connected",
  );
});

test("the route's limit of 30 requests per address in 10 minutes answers rate_limited with a Retry-After of at most 10 minutes, also to a resent copy of a request that committed, so the desktop cannot take that answer as certain (#269)", async (t) => {
  const app = await signInApp(t, { user: githubUser(1024, "busy-address") });
  // The limit counts every request before its body is checked, so 29
  // malformed requests leave the address one request.
  for (let index = 0; index < 29; index += 1) {
    assert.equal((await postSignIn(app, {})).statusCode, 400);
  }
  const key = newKey();
  const request = newDeviceRequest(await signInCode(app), key);
  const committed = await postSignIn(app, request);
  assert.equal(committed.statusCode, 200, committed.body);

  // A copy of the same request, as `net.fetch` or a proxy can send it after
  // the connection broke (#152), gets the route's limit before the API
  // looks at the code, so it does not get sign_in_code_used.
  const copy = await postSignIn(app, request);
  assert.equal(copy.statusCode, 429);
  assert.equal(codeOf(copy), "rate_limited");
  const wait = Number(copy.headers["retry-after"]);
  assert.ok(wait >= 1 && wait <= 600, String(wait));
  assert.equal(
    (
      await database()
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.publicKey, key.publicKey))
    ).length,
    1,
    "the first copy registered the key",
  );
});

test("naming a previous device of the same account revokes it as replaced, also at the device limit; another account's device stays", async (t) => {
  const app = await signInApp(t, { user: githubUser(1010, "replacing") });
  const lost = SignInResponseSchema.parse(
    (
      await postSignIn(app, newDeviceRequest(await signInCode(app), newKey()))
    ).json(),
  );
  const other = await signInApp(t, { user: githubUser(1011, "bystander") });
  const foreign = SignInResponseSchema.parse(
    (
      await postSignIn(
        other,
        newDeviceRequest(await signInCode(other), newKey()),
      )
    ).json(),
  );
  // Fill the account to 20 active devices, created long ago.
  const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
  await database()
    .update(devices)
    .set({ createdAt: old })
    .where(eq(devices.userId, lost.userId));
  for (let index = 0; index < 19; index += 1) {
    await database().insert(devices).values({
      id: newId<DeviceId>(),
      userId: lost.userId,
      label: "Extra",
      platform: "linux",
      publicKey: newKey().publicKey,
      keyAlgorithm: "ed25519",
      createdAt: old,
      lastSignInAt: old,
    });
  }

  const response = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), newKey(), {
      previousDeviceId: lost.deviceId,
    }),
  );
  assert.equal(
    response.statusCode,
    200,
    "recovery keeps the number of active devices",
  );
  const replacement = SignInResponseSchema.parse(response.json());
  const [revoked] = await database()
    .select()
    .from(devices)
    .where(eq(devices.id, lost.deviceId));
  assert.equal(revoked?.revocationReason, "replaced");
  const [audit] = await database()
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.subjectId, lost.deviceId),
        eq(auditEvents.action, "device.revoked"),
      ),
    );
  assert.equal(audit?.reason, "replaced");
  assert.equal(audit?.actorUserId, lost.userId);
  assert.equal(audit?.actorDeviceId, replacement.deviceId);

  await database()
    .update(devices)
    .set({ createdAt: old })
    .where(eq(devices.userId, lost.userId));
  const before = {
    own: await accountRows(lost.userId),
    other: await accountRows(foreign.userId),
  };
  const withForeign = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), newKey(), {
      previousDeviceId: foreign.deviceId,
    }),
  );
  assert.equal(withForeign.statusCode, 409, "a foreign device frees no place");
  assert.equal(codeOf(withForeign), "device_limit");
  assert.deepEqual(
    {
      own: await accountRows(lost.userId),
      other: await accountRows(foreign.userId),
    },
    before,
    "the refusal changed neither account",
  );
  await database()
    .update(devices)
    .set({ revokedAt: new Date(), revocationReason: "removed" })
    .where(and(eq(devices.userId, lost.userId), eq(devices.label, "Extra")));
  const allowed = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), newKey(), {
      previousDeviceId: foreign.deviceId,
    }),
  );
  assert.equal(allowed.statusCode, 200);
  const [kept] = await database()
    .select()
    .from(devices)
    .where(eq(devices.id, foreign.deviceId));
  assert.equal(
    kept?.revokedAt,
    null,
    "another account's device is never revoked",
  );
});

test("after a sign-in commits, the connection with the replaced key closes with key_replaced, a replaced device closes with device_revoked, and only the account's other connections hear of the new device", async (t) => {
  const connections = new ConnectionRegistry();
  const logLines: string[] = [];
  const app = await deviceApp(t, {
    database: database(),
    githubId: 1017,
    connections,
    logLines,
  });
  const strangerApp = await deviceApp(t, {
    database: database(),
    githubId: 1018,
    connections,
  });
  const laptop = await signInDevice(app);
  const desktop = await signInDevice(app);
  const stranger = await signInDevice(strangerApp);
  const laptopSocket = await connected(t, app, laptop);
  const desktopSocket = await connected(t, app, desktop);
  const strangerSocket = await connected(t, strangerApp, stranger);

  // A repeated sign-in replaces the laptop's key; it reconnects with the new one.
  const renewed = await signInAgain(app, laptop);
  assert.equal(
    connections.connectionOf(laptop.deviceId),
    null,
    "closed before the answer",
  );
  assert.deepEqual(
    await laptopSocket.client.closed,
    closedWith("key_replaced"),
  );
  const laptopAgain = await connected(t, app, renewed);

  // A new device registers and replaces the desktop.
  const tablet = await signInDevice(app, undefined, desktop.deviceId);
  assert.deepEqual(
    await desktopSocket.client.closed,
    closedWith("device_revoked"),
  );
  const [registered] = await database()
    .select()
    .from(devices)
    .where(eq(devices.id, tablet.deviceId));
  const [replaced] = await database()
    .select({ revokedAt: devices.revokedAt })
    .from(devices)
    .where(eq(devices.id, desktop.deviceId));
  assert.ok(registered && replaced?.revokedAt);
  assert.deepEqual(await nextFrame(laptopAgain.client), {
    protocolVersion: 0,
    type: "account.device_registered",
    device: {
      id: tablet.deviceId,
      label: "Laptop",
      platform: "macos",
      createdAt: registered.createdAt.toISOString(),
      lastSeenAt: null,
      lastSignInAt: registered.lastSignInAt.toISOString(),
      signInExpiresAt: new Date(
        registered.lastSignInAt.getTime() + 30 * 24 * 60 * 60_000,
      ).toISOString(),
      revokedAt: null,
      current: false,
    },
  });
  assert.deepEqual(await nextFrame(laptopAgain.client), {
    protocolVersion: 0,
    type: "account.device_revoked",
    deviceId: desktop.deviceId,
    reason: "replaced",
    revokedAt: replaced.revokedAt.toISOString(),
  });
  assert.deepEqual(loggedCloses(logLines), [
    { connectionId: laptopSocket.connectionId, code: "key_replaced" },
    { connectionId: desktopSocket.connectionId, code: "device_revoked" },
  ]);
  await settle();
  assert.equal(laptopAgain.client.unread(), 0);
  assert.equal(
    desktopSocket.client.unread(),
    0,
    "the replaced device, which also heard nothing of the key replacement",
  );
  assert.equal(strangerSocket.client.unread(), 0, "another account");
  assert.equal(
    strangerSocket.client.ws.readyState,
    strangerSocket.client.ws.OPEN,
  );
});

test("a new device sent again with the same key after a lost answer gets the same device and a renewed sign-in, and adds no device (#153)", async (t) => {
  let clock = Date.parse("2026-11-03T09:00:00.000Z");
  const app = await signInApp(t, {
    user: githubUser(1201, "lost-answer"),
    now: () => clock,
  });
  const key = newKey();
  const first = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), key),
  );
  assert.equal(first.statusCode, 200);
  // The desktop never read this answer.
  const lost = SignInResponseSchema.parse(first.json());
  await database()
    .update(devices)
    .set({ signedOutAt: new Date(clock) })
    .where(eq(devices.id, lost.deviceId));

  clock += 60 * 60_000;
  const repeat = newDeviceRequest(await signInCode(app), key, {
    label: "Another label",
    platform: "linux",
  });
  const response = await postSignIn(app, repeat);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(SignInResponseSchema.parse(response.json()), {
    ...lost,
    signInExpiresAt: new Date(clock + 30 * 24 * 60 * 60_000).toISOString(),
  });

  const rows = await accountRows(lost.userId);
  assert.equal(rows.devices.length, 1, "no second device");
  const [device] = rows.devices;
  assert.equal(device?.id, lost.deviceId);
  assert.equal(device?.publicKey, key.publicKey);
  assert.equal(device?.label, "Work laptop", "the label stays");
  assert.equal(device?.platform, "windows", "the platform stays");
  assert.equal(device?.lastSignInAt.getTime(), clock, "a sign-in like any");
  assert.equal(device?.signedOutAt, null);
  assert.equal(device?.revokedAt, null);
  assert.deepEqual(
    rows.audit.map((row) => row.action).sort(),
    ["account.signed_in", "account.signed_in", "device.registered"],
    "registered once, signed in twice",
  );

  // The repeat consumed its code as usual.
  const copy = await postSignIn(app, repeat);
  assert.equal(copy.statusCode, 409);
  assert.equal(codeOf(copy), "sign_in_code_used");
  assert.deepEqual(await accountRows(lost.userId), rows);
});

test("the registration lock and the device limits do not refuse a repeated registration, which adds no device (#153)", async (t) => {
  const app = await signInApp(t, { user: githubUser(1202, "full-account") });
  const key = newKey();
  const lost = SignInResponseSchema.parse(
    (
      await postSignIn(app, newDeviceRequest(await signInCode(app), key))
    ).json(),
  );
  // 20 active devices, all of them new in the last 24 hours, and the lock.
  const now = new Date();
  for (let index = 0; index < 19; index += 1) {
    await database().insert(devices).values({
      id: newId<DeviceId>(),
      userId: lost.userId,
      label: "Extra",
      platform: "linux",
      publicKey: newKey().publicKey,
      keyAlgorithm: "ed25519",
      createdAt: now,
      lastSignInAt: now,
    });
  }
  await database()
    .update(users)
    .set({
      deviceRegistrationLockedUntil: new Date(
        Date.now() + 7 * 24 * 60 * 60_000,
      ),
    })
    .where(eq(users.id, lost.userId));

  const fresh = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), newKey()),
  );
  assert.equal(codeOf(fresh), "device_registration_locked");
  const repeated = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), key),
  );
  assert.equal(repeated.statusCode, 200);
  assert.equal(
    SignInResponseSchema.parse(repeated.json()).deviceId,
    lost.deviceId,
  );
  assert.equal((await accountRows(lost.userId)).devices.length, 20);
});

test("a key of a revoked device or of another account's device still answers 409 with conflict, and a device never replaces itself (#153)", async (t) => {
  const owner = await signInApp(t, { user: githubUser(1203, "key-owner") });
  const key = newKey();
  const created = SignInResponseSchema.parse(
    (
      await postSignIn(owner, newDeviceRequest(await signInCode(owner), key))
    ).json(),
  );
  const other = await signInApp(t, { user: githubUser(1204, "key-stranger") });
  const otherAccount = SignInResponseSchema.parse(
    (
      await postSignIn(
        other,
        newDeviceRequest(await signInCode(other), newKey()),
      )
    ).json(),
  );
  const before = {
    owner: await accountRows(created.userId),
    other: await accountRows(otherAccount.userId),
  };

  const foreign = await postSignIn(
    other,
    newDeviceRequest(await signInCode(other), key),
  );
  assert.equal(foreign.statusCode, 409);
  assert.deepEqual(foreign.json(), {
    statusCode: 409,
    error: "Conflict",
    message: "Conflict",
    code: "conflict",
  });

  const itself = await postSignIn(
    owner,
    newDeviceRequest(await signInCode(owner), key, {
      previousDeviceId: created.deviceId,
    }),
  );
  assert.equal(codeOf(itself), "conflict", "a device never replaces itself");
  assert.deepEqual(
    {
      owner: await accountRows(created.userId),
      other: await accountRows(otherAccount.userId),
    },
    before,
    "nothing changed",
  );

  await database()
    .update(devices)
    .set({ revokedAt: new Date(), revocationReason: "removed" })
    .where(eq(devices.id, created.deviceId));
  const revoked = await accountRows(created.userId);
  for (const app of [owner, other]) {
    const response = await postSignIn(
      app,
      newDeviceRequest(await signInCode(app), key),
    );
    assert.equal(response.statusCode, 409);
    assert.equal(codeOf(response), "conflict", "a revoked device's key");
  }
  assert.deepEqual(await accountRows(created.userId), revoked);
  assert.deepEqual(await accountRows(otherAccount.userId), before.other);
});

test("a repeated registration that names the previous device leaves it as the first commit revoked it (#153)", async (t) => {
  const connections = new ConnectionRegistry();
  const app = await deviceApp(t, {
    database: database(),
    githubId: 1205,
    connections,
  });
  const watcher = await signInDevice(app);
  const previous = await signInDevice(app);
  const watching = await connected(t, app, watcher);

  // The key of the previous device was lost: a new device names it.
  const key = newKey();
  const grant = await signInCode(app);
  const first = await postNewDevice(app, grant, key, previous.deviceId);
  assert.equal(first.statusCode, 200);
  const lost = SignInResponseSchema.parse(first.json());
  assert.equal(
    ((await nextFrame(watching.client)) as { type: string }).type,
    "account.device_registered",
  );
  assert.equal(
    ((await nextFrame(watching.client)) as { type: string }).type,
    "account.device_revoked",
  );
  const committed = await accountRows(lost.userId);
  const [revoked] = committed.devices.filter(
    (row) => row.id === previous.deviceId,
  );
  assert.equal(revoked?.revocationReason, "replaced");

  const response = await postNewDevice(
    app,
    await signInCode(app),
    key,
    previous.deviceId,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(
    SignInResponseSchema.parse(response.json()).deviceId,
    lost.deviceId,
  );
  const repeated = await accountRows(lost.userId);
  assert.deepEqual(
    repeated.devices.find((row) => row.id === previous.deviceId),
    revoked,
    "the previous device is unchanged",
  );
  assert.equal(repeated.devices.length, committed.devices.length);
  assert.deepEqual(
    repeated.audit.slice(committed.audit.length).map((row) => row.action),
    ["account.signed_in"],
    "no second registration and no second revocation",
  );
  await settle();
  assert.equal(watching.client.unread(), 0, "no alert and no revocation");
});

test("a repeated registration ignores the previous device that it names, also another active device of the account (#153)", async (t) => {
  const connections = new ConnectionRegistry();
  const app = await deviceApp(t, {
    database: database(),
    githubId: 1206,
    connections,
  });
  const watcher = await signInDevice(app);
  const key = newKey();
  const lost = await signInDevice(app, key);
  const other = await signInDevice(app);
  const watching = await connected(t, app, watcher);
  const otherSocket = await connected(t, app, other);
  const before = await accountRows(lost.userId);

  const response = await postNewDevice(
    app,
    await signInCode(app),
    key,
    other.deviceId,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(
    SignInResponseSchema.parse(response.json()).deviceId,
    lost.deviceId,
  );
  const after = await accountRows(lost.userId);
  assert.deepEqual(
    after.devices.find((row) => row.id === other.deviceId),
    before.devices.find((row) => row.id === other.deviceId),
    "the named device is unchanged",
  );
  assert.deepEqual(
    after.audit.slice(before.audit.length).map((row) => row.action),
    ["account.signed_in"],
    "no revocation",
  );
  await settle();
  assert.equal(watching.client.unread(), 0, "no alert and no revocation");
  assert.equal(otherSocket.client.ws.readyState, otherSocket.client.ws.OPEN);
});

test("a device that minted an access token, authenticated a WebSocket, replaced its key, or is 7 days old does not repeat its registration: a copied key cannot renew itself (#153)", async (t) => {
  const clock = fakeClock(Date.parse("2026-11-03T09:00:00.000Z"));
  const connections = new ConnectionRegistry();
  const app = await deviceApp(t, {
    database: database(),
    githubId: 1210,
    connections,
    now: clock.now,
  });
  const repeat = async (key: Key) =>
    postNewDevice(app, await signInCode(app), key);
  const rowOf = async (deviceId: string) =>
    (
      await database()
        .select()
        .from(devices)
        .where(eq(devices.id, deviceId as DeviceId))
    )[0];

  // An access token: the desktop knew the device ID. A copied key of it
  // stays refused at every later sign-in, also each 29 days later.
  const tokened = await signInDevice(app);
  await accessToken(app, tokened);
  const used = await rowOf(tokened.deviceId);
  assert.equal(used?.firstAuthenticatedAt?.getTime(), clock.now());
  for (let round = 0; round < 6; round += 1) {
    const response = await repeat(tokened.key);
    assert.equal(response.statusCode, 409, `round ${round}`);
    assert.equal(codeOf(response), "conflict");
    clock.advance(29 * 24 * 60 * 60_000);
  }
  assert.deepEqual(
    await rowOf(tokened.deviceId),
    used,
    "neither the key nor the sign-in was renewed",
  );

  // A WebSocket authentication.
  const socketed = await signInDevice(app);
  await connected(t, app, socketed);
  assert.equal(codeOf(await repeat(socketed.key)), "conflict");

  // A sign-in that replaced the key: the new key was never registered.
  const replaced = await signInAgain(app, await signInDevice(app));
  assert.equal(codeOf(await repeat(replaced.key)), "conflict");

  // A device that never authenticated repeats until 7 days after its
  // registration, and not from then on.
  const fresh = await signInDevice(app);
  clock.advance(7 * 24 * 60 * 60_000 - 1);
  const inTime = await repeat(fresh.key);
  assert.equal(inTime.statusCode, 200);
  assert.equal(
    SignInResponseSchema.parse(inTime.json()).deviceId,
    fresh.deviceId,
  );
  clock.advance(1);
  const late = await repeat(fresh.key);
  assert.equal(late.statusCode, 409);
  assert.equal(codeOf(late), "conflict");
  assert.equal((await rowOf(fresh.deviceId))?.firstAuthenticatedAt, null);
});

/** The test database, whose first `failures` transactions fail with a unique violation before they start. */
function databaseFailingWithUniqueViolation(failures: number) {
  const db = database();
  let calls = 0;
  const failing = Object.create(db) as Database;
  Object.defineProperty(failing, "transaction", {
    value: (...args: Parameters<Database["transaction"]>) => {
      calls += 1;
      if (calls <= failures) {
        // The answer of a concurrent sign-in that created the account first.
        return Promise.reject(
          Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint: "user_identities_provider_subject_key",
          }),
        );
      }
      return db.transaction(...args);
    },
  });
  return { failing, calls: () => calls };
}

test("a sign-in that lost the creation of its account to a concurrent one runs once more and gets the account and the device; a second unique violation answers conflict (#153)", async (t) => {
  const key = newKey();
  const once = databaseFailingWithUniqueViolation(1);
  const app = await signInApp(t, {
    user: githubUser(1211, "retried"),
    database: once.failing,
  });
  const response = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), key),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(once.calls(), 2);
  const answer = SignInResponseSchema.parse(response.json());
  assert.equal((await accountRows(answer.userId)).devices.length, 1);

  const twice = databaseFailingWithUniqueViolation(2);
  const other = await signInApp(t, {
    user: githubUser(1212, "twice"),
    database: twice.failing,
  });
  const refused = await postSignIn(
    other,
    newDeviceRequest(await signInCode(other), newKey()),
  );
  assert.equal(refused.statusCode, 409);
  assert.equal(codeOf(refused), "conflict");
  assert.equal(twice.calls(), 2, "one retry only");
});

test("two registrations with the same key at once leave one device: the identity row orders them, so the later one finds the device (#153)", async (t) => {
  const app = await signInApp(t, { user: githubUser(1207, "both-at-once") });
  // The account exists, so both sign-ins lock its identity row.
  await postSignIn(app, newDeviceRequest(await signInCode(app), newKey()));
  const key = newKey();
  const grants = [await signInCode(app), await signInCode(app)];
  const responses = await Promise.all(
    grants.map((grant) => postSignIn(app, newDeviceRequest(grant, key))),
  );
  assert.deepEqual(
    responses.map((response) => response.statusCode),
    [200, 200],
  );
  const [one, two] = responses.map((response) =>
    SignInResponseSchema.parse(response.json()),
  );
  assert.equal(one?.deviceId, two?.deviceId);
  const held = await database()
    .select()
    .from(devices)
    .where(eq(devices.publicKey, key.publicKey));
  assert.equal(held.length, 1);
  const registered = await database()
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.subjectId, one?.deviceId ?? ""),
        eq(auditEvents.action, "device.registered"),
      ),
    );
  assert.equal(registered.length, 1);
});

test("two first sign-ins of a new account with the same key at once leave one account and one device, and both answer with it (#153)", async (t) => {
  const app = await signInApp(t, { user: githubUser(1208, "brand-new") });
  const key = newKey();
  const grants = [await signInCode(app), await signInCode(app)];
  const responses = await Promise.all(
    grants.map((grant) => postSignIn(app, newDeviceRequest(grant, key))),
  );
  // PGlite runs one transaction at a time, so the later one finds the
  // device. On a server the later one fails on the account's identity,
  // which the earlier one created, and runs once more.
  assert.deepEqual(
    responses.map((response) => response.statusCode),
    [200, 200],
  );
  const held = await database()
    .select()
    .from(devices)
    .where(eq(devices.publicKey, key.publicKey));
  assert.equal(held.length, 1);
  assert.deepEqual(
    responses.map(
      (response) => SignInResponseSchema.parse(response.json()).deviceId,
    ),
    [held[0]?.id, held[0]?.id],
  );
  const identities = await database()
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.subject, "1208"));
  assert.equal(identities.length, 1);
});

const SERVER_ONLY = {
  skip:
    process.env["DATABASE_TEST_URL"] === undefined &&
    "needs DATABASE_TEST_URL; PGlite has a single session",
};

/** How many sessions of the test database wait for a lock. */
async function lockWaiters(): Promise<number> {
  assert.ok(testDatabase);
  const { rows } = await testDatabase.client.query<{ waiting: number }>(
    "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
  );
  return rows[0]?.waiting ?? 0;
}

test(
  "two registrations with the same key that run at the same time: the later one waits at the identity row, then answers with the device that the earlier one committed (#153)",
  SERVER_ONLY,
  async (t) => {
    const url = testDatabase?.url;
    assert.ok(url, "the test database is on a server");
    const app = await signInApp(t, { user: githubUser(1209, "racing") });
    const existing = SignInResponseSchema.parse(
      (
        await postSignIn(app, newDeviceRequest(await signInCode(app), newKey()))
      ).json(),
    );
    const key = newKey();
    const grants = [await signInCode(app), await signInCode(app)];
    // A second session holds the account's identity row, so both sign-ins
    // are inside their transactions before either can register the key.
    const other = createDatabase(url, { max: 1 });
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = other.db.transaction(async (tx) => {
      await tx
        .select()
        .from(userIdentities)
        .where(eq(userIdentities.userId, existing.userId))
        .for("update");
      holding.resolve();
      await release.promise;
    });
    try {
      await Promise.race([
        holding.promise,
        held.then(() => {
          throw new Error("the holding transaction ended early");
        }),
      ]);
      const racing = grants.map((grant) =>
        postSignIn(app, newDeviceRequest(grant, key)),
      );
      while ((await lockWaiters()) < 2) {
        await delay(10);
      }
      release.resolve();
      await held;
      const responses = await Promise.all(racing);
      assert.deepEqual(
        responses.map((response) => response.statusCode),
        [200, 200],
      );
      const [one, two] = responses.map((response) =>
        SignInResponseSchema.parse(response.json()),
      );
      assert.equal(one?.deviceId, two?.deviceId);
      const rows = await accountRows(existing.userId);
      assert.equal(rows.devices.length, 2);
      assert.equal(
        rows.audit.filter((row) => row.action === "device.registered").length,
        2,
        "the first device and the raced one, once",
      );
    } finally {
      release.resolve();
      await held.catch(() => undefined);
      await other.close();
    }
  },
);

test("the first display name falls back to the login when the GitHub name is not usable", async (t) => {
  for (const [id, name] of [
    [1012, `Name${String.fromCharCode(0x202e)}`],
    [1013, "n".repeat(65)],
    [1014, null],
  ] as const) {
    const app = await signInApp(t, {
      user: githubUser(id, `fallback-${id}`, name),
    });
    const answer = SignInResponseSchema.parse(
      (
        await postSignIn(app, newDeviceRequest(await signInCode(app), newKey()))
      ).json(),
    );
    assert.equal(answer.displayName, `fallback-${id}`);
  }
});

test("a malformed request answers 400 with bad_request and consumes nothing", async (t) => {
  const app = await signInApp(t, { user: githubUser(1015, "malformed") });
  const grant = await signInCode(app);
  const request = newDeviceRequest(grant, newKey());
  const broken = {
    ...request,
    device: { ...request.device, keyAlgorithm: "es256" },
  };
  const response = await postSignIn(app, broken);
  assert.equal(response.statusCode, 400);
  assert.equal(codeOf(response), "bad_request");
  assert.equal(
    (await postSignIn(app, request)).statusCode,
    200,
    "the code was not consumed",
  );
});

test("without a database, the sign-in route answers the generic 404", async (t) => {
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
  const response = await app.inject({
    method: "POST",
    url: "/auth/sign-in",
    payload: {},
  });
  assert.equal(response.statusCode, 404);
  assert.equal(codeOf(response), "not_found");
});

test("no sign-in code, verifier, or signature reaches the logs, also for a refused sign-in", async (t) => {
  const logLines: string[] = [];
  const app = await signInApp(t, {
    user: githubUser(1016, "logged"),
    logLines,
  });
  const ok = newDeviceRequest(await signInCode(app), newKey());
  assert.equal((await postSignIn(app, ok)).statusCode, 200);
  const refused = newDeviceRequest(await signInCode(app), newKey());
  refused.device.newKeySignature = ok.device.newKeySignature;
  assert.equal((await postSignIn(app, refused)).statusCode, 401);
  const logs = logLines.join("");
  assert.ok(logs.length > 0);
  for (const secret of [
    ok.code,
    ok.codeVerifier,
    ok.device.newKeySignature,
    refused.code,
    refused.codeVerifier,
  ]) {
    assert.equal(logs.includes(secret), false, secret);
  }
});
