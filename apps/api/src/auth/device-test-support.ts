// Test support for device keys: Ed25519 keys and signatures, a fake clock,
// the test database, and an app with GitHub sign-in that signs devices in
// through the browser flow and POST /auth/sign-in, as the desktop does.
import type { Database } from "@mymandev/database";
import {
  createTestDatabase,
  type TestDatabase,
} from "@mymandev/database/testing";
import {
  deviceAuthInput,
  type DeviceAuthInput,
  SignInResponseSchema,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { after, before, type TestContext } from "node:test";
import { buildApp, type BuildAppOptions } from "../app.ts";
import { loadConfig } from "../config.ts";
import { Secret } from "../secret.ts";
import { createGitHubApi } from "./github-api.ts";
import {
  callback,
  confirm,
  fakeGitHub,
  listenerForm,
  REDIRECT_URI,
  startAttempt,
} from "./github-test-support.ts";

/** The API's public origin in tests: GitHub's callback origin and the audience of signatures. */
export const ORIGIN = "https://api.example";
export const CLIENT_ID = "Iv23liExampleClient1";
export const CLIENT_SECRET = "0123456789abcdef0123456789abcdef01234567";

/**
 * Creates one test database for the test file in `before` and closes it in
 * `after`; call it once at the top of the file. The returned function gives
 * the database inside a test.
 */
export function useTestDatabase(): () => Database {
  let testDatabase: TestDatabase | undefined;
  before(async () => {
    testDatabase = await createTestDatabase();
  });
  after(async () => {
    await testDatabase?.close();
  });
  return () => {
    assert.ok(testDatabase, "the test database is created in before()");
    return testDatabase.db;
  };
}

export type FakeClock = Readonly<{
  /** The current time, in milliseconds since the epoch. */
  now: () => number;
  /** Moves the clock forward. */
  advance: (ms: number) => void;
}>;

/** A clock that moves only when the test moves it; it starts at the real time. */
export function fakeClock(start: number = Date.now()): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

export type Key = Readonly<{ privateKey: KeyObject; publicKey: string }>;

/** A new Ed25519 key pair, with the public key as 64 hexadecimal characters. */
export function newKey(): Key {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .subarray(12)
    .toString("hex");
  return { privateKey, publicKey };
}

/** Signs the input the way the desktop does, as base64url. */
export function signInput(key: Key, input: DeviceAuthInput): string {
  return sign(
    null,
    Buffer.from(deviceAuthInput(input), "utf8"),
    key.privateKey,
  ).toString("base64url");
}

export type DeviceAppOptions = Readonly<{
  database: Database;
  /** GitHub's numeric ID of the account that every sign-in of this app gets. */
  githubId: number;
  /** Receives the JSON log lines; without it, logging is off. */
  logLines?: string[];
  /** More environment variables for the configuration. */
  env?: Readonly<Record<string, string>>;
}> &
  Partial<
    Omit<
      BuildAppOptions,
      "config" | "version" | "logger" | "github" | "database"
    >
  >;

/**
 * Builds an app with GitHub sign-in against a fake GitHub and the test
 * database. The test closes it when it ends.
 */
export async function deviceApp(
  t: TestContext,
  options: DeviceAppOptions,
): Promise<FastifyInstance> {
  const { database, githubId, logLines, env, ...rest } = options;
  const github = fakeGitHub({
    user: {
      id: githubId,
      login: `user-${githubId}`,
      name: null,
      created_at: "2015-06-01T10:00:00Z",
    },
  });
  const app = await buildApp({
    shutdownGraceMs: 50,
    ...rest,
    config: loadConfig({
      NODE_ENV: "test",
      API_PUBLIC_ORIGIN: ORIGIN,
      API_GITHUB_CLIENT_ID: CLIENT_ID,
      API_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
      ...env,
    }),
    version: "1.2.3",
    logger:
      logLines === undefined
        ? false
        : { stream: { write: (line: string) => logLines.push(line) } },
    github: createGitHubApi({
      clientId: CLIENT_ID,
      clientSecret: new Secret(CLIENT_SECRET),
      fetch: github.fetch,
    }),
    database,
  });
  t.after(() => app.close());
  return app;
}

/** A sign-in code and its verifier from the browser flow. */
export async function signInCode(app: FastifyInstance) {
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
export async function signInDevice(
  app: FastifyInstance,
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

export type SignedInDevice = Awaited<ReturnType<typeof signInDevice>>;

/** Signs an existing device in again with a new key, as the desktop does to replace its key. */
export async function signInAgain(
  app: FastifyInstance,
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
