import {
  auditEvents,
  devices,
  recordGitHubRevocation,
  userIdentities,
  users,
} from "@mymandev/database";
import {
  createTestDatabase,
  type TestDatabase,
} from "@mymandev/database/testing";
import {
  deviceAuthInput,
  type DeviceAuthInput,
  type DeviceId,
  newId,
  SignInResponseSchema,
  type UserId,
} from "@mymandev/protocol";
import { and, eq } from "drizzle-orm";
import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
} from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
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
import {
  deviceApp,
  fakeClock,
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

test("an account has at most 20 active devices and 10 new devices in 24 hours, with Retry-After", async (t) => {
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
  const twentyFirst = await signInNew();
  assert.equal(codeOf(twentyFirst), "rate_limited");
  assert.equal(twentyFirst.headers["retry-after"], String(24 * 3600));

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
  const withForeign = await postSignIn(
    app,
    newDeviceRequest(await signInCode(app), newKey(), {
      previousDeviceId: foreign.deviceId,
    }),
  );
  assert.equal(withForeign.statusCode, 429, "a foreign device frees no place");
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
