import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { MAX_ANSWER_LIST_ITEMS } from "./model.ts";
import * as z from "zod";
import {
  AccessTokenRequestSchema,
  AccessTokenResponseSchema,
  AUTH_ROUTES,
  ChallengeResponseSchema,
  DeviceListResponseSchema,
  GitHubAuthorizeQuerySchema,
  LOOPBACK_CALLBACK_PATH,
  LoopbackCallbackBodySchema,
  RevokeDeviceRequestSchema,
  routePath,
  SignInRequestSchema,
  SignInResponseSchema,
} from "./auth-api.ts";

const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const PUBLIC_KEY =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const b64 = (size: number) => randomBytes(size).toString("base64url");

test("the authentication routes are the table of ADR 0014, frozen", () => {
  const table = Object.values(AUTH_ROUTES).map(
    (route) => `${route.method} ${route.path}`,
  );
  assert.deepEqual(table, [
    "GET /auth/github/authorize",
    "GET /auth/github/callback",
    "POST /auth/github/confirm",
    "POST /auth/github/webhook",
    "POST /auth/sign-in",
    "POST /auth/challenge",
    "POST /auth/access-token",
    "POST /auth/sign-out",
    "GET /devices",
    "POST /devices/:deviceId/revoke",
    "POST /account/registration-lock/lift",
  ]);
  assert.equal(new Set(table).size, table.length);
  assert.equal(Object.isFrozen(AUTH_ROUTES), true);
  for (const route of Object.values(AUTH_ROUTES)) {
    assert.equal(Object.isFrozen(route), true, route.path);
  }
  assert.equal(LOOPBACK_CALLBACK_PATH, "/callback");
});

test("routePath fills ID parameters and refuses anything else", () => {
  assert.equal(
    routePath(AUTH_ROUTES.revokeDevice.path, { deviceId: DEVICE_ID }),
    `/devices/${DEVICE_ID}/revoke`,
  );
  assert.equal(routePath(AUTH_ROUTES.listDevices.path), "/devices");
  for (const [label, params] of [
    ["missing", {}],
    ["not a UUIDv7", { deviceId: "../account" }],
    ["uppercase", { deviceId: DEVICE_ID.toUpperCase() }],
    ["encoded slash", { deviceId: `${DEVICE_ID}%2F` }],
    ["unknown parameter", { deviceId: DEVICE_ID, other: DEVICE_ID }],
  ] as const) {
    assert.throws(
      () =>
        routePath(
          AUTH_ROUTES.revokeDevice.path,
          params as Record<string, string>,
        ),
      TypeError,
      label,
    );
  }
  const inherited = Object.create({ deviceId: DEVICE_ID }) as Record<
    string,
    string
  >;
  assert.throws(
    () => routePath(AUTH_ROUTES.revokeDevice.path, inherited),
    TypeError,
    "inherited",
  );
});

test("the authorize query accepts the desktop's values only", () => {
  const query = {
    code_challenge: b64(32),
    code_challenge_method: "S256",
    redirect_uri: "http://127.0.0.1:49152/callback",
    state: b64(32),
  };
  assert.equal(GitHubAuthorizeQuerySchema.safeParse(query).success, true);
  assert.equal(
    GitHubAuthorizeQuerySchema.safeParse({
      ...query,
      login: "octocat",
      prompt: "select_account",
    }).success,
    true,
  );
  for (const port of [1024, 1099, 9999, 10000, 59999, 65535]) {
    assert.equal(
      GitHubAuthorizeQuerySchema.safeParse({
        ...query,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
      }).success,
      true,
      String(port),
    );
  }
  const rejected: [label: string, value: unknown][] = [
    ["plain method", { ...query, code_challenge_method: "plain" }],
    ["port 1023", { ...query, redirect_uri: "http://127.0.0.1:1023/callback" }],
    ["port 1020", { ...query, redirect_uri: "http://127.0.0.1:1020/callback" }],
    [
      "port 65536",
      { ...query, redirect_uri: "http://127.0.0.1:65536/callback" },
    ],
    [
      "leading zero port",
      { ...query, redirect_uri: "http://127.0.0.1:01024/callback" },
    ],
    [
      "localhost",
      { ...query, redirect_uri: "http://localhost:49152/callback" },
    ],
    [
      "https loopback",
      { ...query, redirect_uri: "https://127.0.0.1:49152/callback" },
    ],
    [
      "IPv6 loopback",
      { ...query, redirect_uri: "http://[::1]:49152/callback" },
    ],
    [
      "other path",
      { ...query, redirect_uri: "http://127.0.0.1:49152/callback/x" },
    ],
    [
      "query in the URI",
      { ...query, redirect_uri: "http://127.0.0.1:49152/callback?x=1" },
    ],
    ["no port", { ...query, redirect_uri: "http://127.0.0.1/callback" }],
    ["short state", { ...query, state: b64(31) }],
    ["long challenge", { ...query, code_challenge: b64(33) }],
    ["bad login", { ...query, login: "octo cat" }],
    ["other prompt", { ...query, prompt: "consent" }],
  ];
  for (const [label, value] of rejected) {
    assert.equal(
      GitHubAuthorizeQuerySchema.safeParse(value).success,
      false,
      label,
    );
  }
});

test("the loopback callback body carries a code or an error, always with the state", () => {
  const state = b64(32);
  assert.equal(
    LoopbackCallbackBodySchema.safeParse({ code: `mmdc_${b64(32)}`, state })
      .success,
    true,
  );
  assert.equal(
    LoopbackCallbackBodySchema.safeParse({ error: "access_denied", state })
      .success,
    true,
  );
  for (const [label, value] of [
    ["no state", { code: `mmdc_${b64(32)}` }],
    ["access token as the code", { code: `mmda_${b64(32)}`, state }],
    ["error with spaces", { error: "access denied", state }],
    ["error with markup", { error: "<b>x</b>", state }],
    ["empty", {}],
  ] as const) {
    assert.equal(
      LoopbackCallbackBodySchema.safeParse(value).success,
      false,
      label,
    );
  }
});

test("sign-in takes a new or an existing device registration", () => {
  const base = {
    code: `mmdc_${b64(32)}`,
    codeVerifier: b64(32),
    redirectUri: "http://127.0.0.1:49152/callback",
  };
  const newDevice = {
    kind: "new",
    publicKey: PUBLIC_KEY,
    keyAlgorithm: "ed25519",
    label: "Work laptop",
    platform: "linux",
    newKeySignature: b64(64),
  };
  const existing = {
    kind: "existing",
    deviceId: DEVICE_ID,
    publicKey: PUBLIC_KEY,
    keyAlgorithm: "ed25519",
    currentKeySignature: b64(64),
    newKeySignature: b64(64),
  };
  assert.equal(
    SignInRequestSchema.safeParse({ ...base, device: newDevice }).success,
    true,
  );
  assert.equal(
    SignInRequestSchema.safeParse({
      ...base,
      device: { ...newDevice, previousDeviceId: DEVICE_ID },
    }).success,
    true,
  );
  assert.equal(
    SignInRequestSchema.safeParse({ ...base, device: existing }).success,
    true,
  );

  const rejected: [label: string, value: unknown][] = [
    [
      "existing without the current key's signature",
      { ...base, device: { ...existing, currentKeySignature: undefined } },
    ],
    [
      "new without a label",
      { ...base, device: { ...newDevice, label: undefined } },
    ],
    ["ES256 key", { ...base, device: { ...newDevice, keyAlgorithm: "es256" } }],
    [
      "unknown kind",
      { ...base, device: { ...newDevice, kind: "replacement" } },
    ],
    [
      "verifier of 44 characters",
      { ...base, codeVerifier: `${b64(32)}A`, device: newDevice },
    ],
    [
      "invitation code as the sign-in code",
      { ...base, code: `mmdi_${b64(32)}`, device: newDevice },
    ],
    [
      "redirect URI with localhost",
      {
        ...base,
        redirectUri: "http://localhost:49152/callback",
        device: newDevice,
      },
    ],
    ["missing device", base],
  ];
  for (const [label, value] of rejected) {
    assert.equal(SignInRequestSchema.safeParse(value).success, false, label);
  }
  const parsed = SignInRequestSchema.parse({
    ...base,
    device: { ...existing, label: "ignored" },
  });
  assert.equal("label" in parsed.device, false, "unknown fields are stripped");
});

test("the sign-in answer carries the account and the expiry, never a credential", () => {
  const answer = {
    userId: DEVICE_ID,
    deviceId: DEVICE_ID,
    displayName: "Ada",
    login: "ada-l",
    signInExpiresAt: "2026-11-28T12:00:00.000Z",
  };
  assert.deepEqual(
    Object.keys(
      SignInResponseSchema.parse({ ...answer, accessToken: `mmda_${b64(32)}` }),
    ).sort(),
    ["deviceId", "displayName", "login", "signInExpiresAt", "userId"],
  );
});

test("challenges, access tokens, and revocations have their formats", () => {
  assert.equal(
    ChallengeResponseSchema.safeParse({
      challengeId: DEVICE_ID,
      nonce: b64(32),
    }).success,
    true,
  );
  assert.equal(
    ChallengeResponseSchema.safeParse({
      challengeId: DEVICE_ID,
      nonce: b64(16),
    }).success,
    false,
  );
  assert.equal(
    AccessTokenRequestSchema.safeParse({
      deviceId: DEVICE_ID,
      challengeId: DEVICE_ID,
      signature: b64(64),
    }).success,
    true,
  );
  assert.equal(
    AccessTokenRequestSchema.safeParse({
      deviceId: DEVICE_ID,
      challengeId: "x",
      signature: b64(64),
    }).success,
    false,
  );
  assert.equal(
    RevokeDeviceRequestSchema.safeParse({ reason: "lost" }).success,
    true,
  );
  assert.equal(
    RevokeDeviceRequestSchema.safeParse({ reason: "removed" }).success,
    true,
  );
  for (const reason of ["replaced", "account_erased", "stolen"]) {
    assert.equal(
      RevokeDeviceRequestSchema.safeParse({ reason }).success,
      false,
      reason,
    );
  }
});

test("the request and response schemas export to JSON Schema for documentation", () => {
  for (const schema of [
    GitHubAuthorizeQuerySchema,
    LoopbackCallbackBodySchema,
    SignInRequestSchema,
    SignInResponseSchema,
    ChallengeResponseSchema,
    AccessTokenRequestSchema,
    AccessTokenResponseSchema,
    DeviceListResponseSchema,
    RevokeDeviceRequestSchema,
  ]) {
    const json = z.toJSONSchema(schema, { io: "input" });
    assert.equal(typeof json, "object");
  }
});

test("the access token and device list answers parse", () => {
  assert.equal(
    AccessTokenResponseSchema.safeParse({
      accessToken: `mmda_${b64(32)}`,
      expiresAt: "2026-10-29T12:15:00.000Z",
    }).success,
    true,
  );
  assert.equal(
    AccessTokenResponseSchema.safeParse({
      accessToken: `mmdc_${b64(32)}`,
      expiresAt: "2026-10-29T12:15:00.000Z",
    }).success,
    false,
  );
  const device = {
    id: DEVICE_ID,
    label: "Work laptop",
    platform: "macos",
    createdAt: "2026-10-29T12:00:00.000Z",
    lastSeenAt: null,
    lastSignInAt: "2026-10-29T12:00:00.000Z",
    signInExpiresAt: "2026-11-28T12:00:00.000Z",
    revokedAt: null,
    current: true,
  };
  assert.equal(
    DeviceListResponseSchema.safeParse({ devices: [device] }).success,
    true,
  );
  assert.equal(
    DeviceListResponseSchema.safeParse({ devices: [] }).success,
    true,
  );
  assert.equal(
    DeviceListResponseSchema.safeParse({
      devices: [{ ...device, platform: "ios" }],
    }).success,
    false,
  );
  assert.equal(DeviceListResponseSchema.safeParse({}).success, false);
});

test("the device list holds at most MAX_ANSWER_LIST_ITEMS devices", () => {
  const device = {
    id: DEVICE_ID,
    label: "Work laptop",
    platform: "windows",
    createdAt: "2026-10-29T12:00:00.000Z",
    lastSeenAt: null,
    lastSignInAt: "2026-10-29T12:00:00.000Z",
    signInExpiresAt: "2026-11-28T12:00:00.000Z",
    revokedAt: "2026-10-29T13:00:00.000Z",
    current: false,
  };
  assert.equal(
    DeviceListResponseSchema.safeParse({
      devices: Array(MAX_ANSWER_LIST_ITEMS).fill(device),
    }).success,
    true,
  );
  assert.equal(
    DeviceListResponseSchema.safeParse({
      devices: Array(MAX_ANSWER_LIST_ITEMS + 1).fill(device),
    }).success,
    false,
  );
});
