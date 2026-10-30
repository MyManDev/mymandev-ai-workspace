import {
  auditEvents,
  devices,
  userIdentities,
  users,
} from "@mymandev/database";
import {
  createTestDatabase,
  type TestDatabase,
} from "@mymandev/database/testing";
import {
  deviceAuthInput,
  type DeviceId,
  newId,
  SignInResponseSchema,
  type UserId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
import { buildApp } from "../app.ts";
import { loadConfig } from "../config.ts";
import { Secret } from "../secret.ts";
import { createGitHubApi } from "./github-api.ts";
import {
  callback,
  confirm,
  fakeGitHub,
  type FakeGitHubScenario,
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

async function signInApp(
  t: TestContext,
  options: Readonly<{
    user?: FakeGitHubScenario["user"];
    now?: () => number;
    logLines?: string[];
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
    database: database(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  t.after(() => app.close());
  return app;
}

/** Runs the browser part of a sign-in and returns the code that reached the listener. */
async function signInCode(app: Awaited<ReturnType<typeof signInApp>>) {
  const attempt = await startAttempt(app);
  await callback(app, attempt, {
    code: "github-code",
    state: attempt.apiState,
  });
  const done = await confirm(app, attempt, "continue");
  const code = listenerForm(done.body)?.fields.code;
  assert.ok(code !== undefined);
  return { code, codeVerifier: attempt.codeVerifier };
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
  const reused = await postSignIn(app, newDeviceRequest(grant, newKey()));
  assert.equal(reused.statusCode, 401);
  assert.equal(codeOf(reused), "auth_failed");

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
  // A refused request still consumed its code.
  assert.equal(
    (await postSignIn(app, newDeviceRequest(wrongVerifier, newKey())))
      .statusCode,
    401,
  );
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

test("bad signatures are refused, and an existing device needs its current key", async (t) => {
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
  assert.equal(codeOf(await postSignIn(app, forged)), "auth_failed");

  const wrongAudience = newDeviceRequest(await signInCode(app), key);
  const otherKey = newKey();
  wrongAudience.device.publicKey = otherKey.publicKey;
  assert.equal(
    codeOf(await postSignIn(app, wrongAudience)),
    "auth_failed",
    "the signature covers the new key",
  );

  const stranger = newKey();
  const noCurrentKey = existingDeviceRequest(
    await signInCode(app),
    created.deviceId,
    stranger,
    newKey(),
  );
  assert.equal(codeOf(await postSignIn(app, noCurrentKey)), "auth_failed");
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
  const revoked = await postSignIn(
    owner,
    existingDeviceRequest(
      await signInCode(owner),
      created.deviceId,
      key,
      newKey(),
    ),
  );
  assert.equal(codeOf(revoked), "device_revoked");

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

test("an account has at most 20 active devices and 10 new devices in 24 hours", async (t) => {
  const app = await signInApp(t, { user: githubUser(1009, "many-devices") });
  const created = SignInResponseSchema.parse(
    (
      await postSignIn(app, newDeviceRequest(await signInCode(app), newKey()))
    ).json(),
  );
  const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
  const add = async (n: number, createdAt: Date) => {
    for (let index = 0; index < n; index += 1) {
      await database()
        .insert(devices)
        .values({
          id: newId<DeviceId>(),
          userId: created.userId as UserId,
          label: "Extra",
          platform: "linux",
          publicKey: newKey().publicKey,
          keyAlgorithm: "ed25519",
          createdAt,
          lastSignInAt: createdAt,
        });
    }
  };
  // 1 recent + 9 recent = 10 new devices in 24 hours.
  await add(9, new Date());
  const tooManyNew = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), newKey()),
  );
  assert.equal(tooManyNew.statusCode, 429);
  assert.equal(codeOf(tooManyNew), "rate_limited");

  // Older devices up to 20 active.
  await database()
    .update(devices)
    .set({ createdAt: old })
    .where(eq(devices.userId, created.userId as UserId));
  await add(10, old);
  const tooManyActive = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), newKey()),
  );
  assert.equal(codeOf(tooManyActive), "rate_limited");
});

test("naming a previous device of the same account revokes it as replaced; another account's device stays", async (t) => {
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

  const replacement = SignInResponseSchema.parse(
    (
      await postSignIn(
        app,
        newDeviceRequest(await signInCode(app), newKey(), {
          previousDeviceId: lost.deviceId,
        }),
      )
    ).json(),
  );
  const [revoked] = await database()
    .select()
    .from(devices)
    .where(eq(devices.id, lost.deviceId));
  assert.equal(revoked?.revocationReason, "replaced");
  const [audit] = await database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.subjectId, lost.deviceId))
    .orderBy(auditEvents.createdAt);
  assert.ok(audit !== undefined);

  await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), newKey(), {
      previousDeviceId: foreign.deviceId,
    }),
  );
  const [kept] = await database()
    .select()
    .from(devices)
    .where(eq(devices.id, foreign.deviceId));
  assert.equal(kept?.revokedAt, null);
  assert.notEqual(replacement.deviceId, lost.deviceId);
});

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
