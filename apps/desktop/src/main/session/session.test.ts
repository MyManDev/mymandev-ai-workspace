import { createPublicKey, randomBytes, verify } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_ERROR_STATUS,
  type ApiErrorCode,
  AUTH_ROUTES,
  type AuthChallengeFrame,
  AuthResponseFrameSchema,
  type ConnectionId,
  deviceAuthInput,
  type DeviceAuthInput,
  type DeviceId,
  newUuidV7,
  PROTOCOL_VERSION,
  type SignInRequest,
  SignInRequestSchema,
  type UserId,
} from "@mymandev/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createDeviceKeyStore,
  CURRENT_KEY_FILE,
  type DeviceKeyStore,
  PREVIOUS_KEY_FILE,
  type SystemKeyProtection,
} from "../device-key/store.ts";
import {
  createDeviceRecordStore,
  DEVICE_RECORD_FILE,
  type DeviceRecord,
  type DeviceRecordStore,
} from "../device-record.ts";
import type { ScheduleTimer } from "../runtime.ts";
import {
  createSignInFlow,
  SIGN_IN_FAILURE_REASONS,
  type SignInOutcome,
  UNCERTAIN_REFUSAL_CODES,
} from "../sign-in/flow.ts";
import { API_REQUEST_TIMEOUT_MS } from "./api-call.ts";
import {
  ACCESS_TOKEN_LIFETIME_MS,
  ACCESS_TOKEN_RENEW_MARGIN_MS,
  createDeviceSession,
  LOST_KEY_WAIT_MS,
  REPLACEMENT_GRACE_MS,
  type DeviceSession,
  type DeviceSessionDependencies,
  type DeviceSessionState,
  type SessionKeyStore,
} from "./session.ts";
import {
  createSessionNotesStore,
  SESSION_NOTES_FILE,
} from "./session-notes.ts";
import {
  createSignOutMarkerStore,
  SIGN_OUT_MARKER_FILE,
  type SignOutMarkerStore,
} from "./sign-out-marker.ts";

const API_ORIGIN = "https://api.mymandev.example";
const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3" as DeviceId;
const USER_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4" as UserId;
const OTHER_DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b7" as DeviceId;
const SIGN_IN_CODE = "mmdc_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
const AUTH_FAILED = Object.freeze({
  ok: false,
  reason: "refused",
  code: "auth_failed",
});
/** A public key that no store holds, so the fake API refuses every signature. */
const FOREIGN_PUBLIC_KEY = "a".repeat(64);
const SPKI_ED25519_PREFIX = "302a300506032b6570032100";

const DEVICE_ITEM = Object.freeze({
  id: DEVICE_ID,
  label: "Mac",
  platform: "macos",
  createdAt: "2026-10-01T10:00:00.000Z",
  lastSeenAt: null,
  lastSignInAt: "2026-11-01T10:00:00.000Z",
  signInExpiresAt: "2026-12-01T10:00:00.000Z",
  revokedAt: null,
  current: true,
});

let root: string;
let folder: string;
/** The wall clock of every session in a test, also across a restart. */
const wall = { now: 0 };

beforeEach(async () => {
  wall.now = Date.parse("2026-11-02T10:00:00.000Z");
  root = await mkdtemp(path.join(tmpdir(), "mymandev-device-session-"));
  folder = path.join(root, "MyManDev");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every plain text that the fake encrypted: the private keys as PKCS#8 in base64. */
const encryptedPlainTexts: string[] = [];

/** A fake `safeStorage` with the asynchronous API; enough for the store on Windows. */
const fakeSafeStorage: SystemKeyProtection = Object.freeze({
  isAsyncEncryptionAvailable: () => Promise.resolve(true),
  getSelectedStorageBackend: () => "unknown",
  encryptStringAsync: (plainText: string) => {
    encryptedPlainTexts.push(plainText);
    return Promise.resolve(Buffer.from(`fake:${plainText}`, "utf8"));
  },
  decryptStringAsync: (encrypted: Buffer) =>
    Promise.resolve({
      shouldReEncrypt: false,
      result: encrypted.toString("utf8").slice("fake:".length),
    }),
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorAnswer(code: ApiErrorCode): Response {
  const statusCode = API_ERROR_STATUS[code];
  return json(statusCode, {
    statusCode,
    error: "Error",
    message: "Refused",
    code,
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function publicKeyObject(publicKey: string) {
  return createPublicKey({
    key: Buffer.from(`${SPKI_ED25519_PREFIX}${publicKey}`, "hex"),
    format: "der",
    type: "spki",
  });
}

function verifies(
  publicKey: string,
  input: DeviceAuthInput,
  signature: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(deviceAuthInput(input), "utf8"),
      publicKeyObject(publicKey),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: Record<string, string> | undefined;
  readonly init: RequestInit;
}

/**
 * A fake API with the rules of `apps/api/src/auth/device-routes.ts`: a
 * single-use challenge, the signature checked first and the device state
 * second, and every other route behind a token that a sign-out or a
 * revocation ends.
 */
interface FakeApi {
  /** The key that the API holds for `DEVICE_ID`. */
  publicKey: string | null;
  deviceState: "ok" | "revoked" | "disabled" | "sign_in_required";
  signedOut: boolean;
  revokedReason: string | null;
  readonly tokens: Set<string>;
  readonly issued: string[];
  readonly signatures: string[];
  readonly nonces: Map<string, string>;
  /** Every challenge that the API issued, by challenge ID. */
  readonly challengeLog: Map<string, string>;
  readonly requests: ApiRequest[];
  /** Called after every request arrived. */
  readonly arrivals: Set<() => void>;
  /** Answers in place of the API when it returns a response; may throw or hang. */
  intercept: ((request: ApiRequest) => Promise<Response> | undefined) | null;
}

function fakeApi(): FakeApi {
  return {
    publicKey: null,
    deviceState: "ok",
    signedOut: false,
    revokedReason: null,
    tokens: new Set(),
    issued: [],
    signatures: [],
    nonces: new Map(),
    challengeLog: new Map(),
    requests: [],
    arrivals: new Set(),
    intercept: null,
  };
}

function answerApi(api: FakeApi, request: ApiRequest): Response {
  const { method, path: route, body } = request;
  if (method === "POST" && route === "/auth/challenge") {
    const challengeId = newUuidV7();
    const nonce = randomBytes(32).toString("base64url");
    api.nonces.set(challengeId, nonce);
    api.challengeLog.set(challengeId, nonce);
    return json(200, { challengeId, nonce });
  }
  if (method === "POST" && route === "/auth/access-token") {
    const challengeId = body?.challengeId ?? "";
    const nonce = api.nonces.get(challengeId);
    api.nonces.delete(challengeId);
    if (
      nonce === undefined ||
      body?.deviceId !== DEVICE_ID ||
      api.publicKey === null ||
      !verifies(
        api.publicKey,
        {
          purpose: "http",
          audience: API_ORIGIN,
          nonce,
          deviceId: DEVICE_ID,
          challengeId,
        },
        body.signature ?? "",
      )
    ) {
      return errorAnswer("auth_failed");
    }
    switch (api.deviceState) {
      case "revoked":
        return errorAnswer("device_revoked");
      case "disabled":
        return errorAnswer("auth_failed");
      case "sign_in_required":
        return errorAnswer("sign_in_required");
      case "ok":
        break;
    }
    if (api.signedOut) {
      return errorAnswer("sign_in_required");
    }
    const accessToken = `mmda_${randomBytes(32).toString("base64url")}`;
    api.tokens.add(accessToken);
    api.issued.push(accessToken);
    return json(200, {
      accessToken,
      expiresAt: new Date(Date.now() + ACCESS_TOKEN_LIFETIME_MS).toISOString(),
    });
  }
  const token = request.authorization?.replace(/^Bearer /u, "") ?? "";
  if (!api.tokens.has(token) || api.deviceState !== "ok" || api.signedOut) {
    return errorAnswer("unauthorized");
  }
  if (method === "POST" && route === "/auth/sign-out") {
    api.signedOut = true;
    api.tokens.clear();
    return noContent();
  }
  if (method === "GET" && route === "/devices") {
    return json(200, { devices: [DEVICE_ITEM] });
  }
  if (method === "POST" && route === `/devices/${DEVICE_ID}/revoke`) {
    api.deviceState = "revoked";
    api.revokedReason = body?.reason ?? null;
    api.tokens.clear();
    return noContent();
  }
  return errorAnswer("not_found");
}

function apiFetch(api: FakeApi): DeviceSessionDependencies["fetch"] {
  return async (url, init) => {
    const parsed = new URL(url);
    expect(parsed.origin).toBe(API_ORIGIN);
    const headers = new Headers(init.headers);
    const request: ApiRequest = {
      method: init.method ?? "GET",
      path: parsed.pathname,
      authorization: headers.get("authorization"),
      body:
        init.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as Record<string, string>),
      init,
    };
    api.requests.push(request);
    if (request.body?.signature !== undefined) {
      api.signatures.push(request.body.signature);
    }
    for (const arrived of [...api.arrivals]) {
      arrived();
    }
    const intercepted = api.intercept?.(request);
    if (intercepted !== undefined) {
      return intercepted;
    }
    return answerApi(api, request);
  };
}

interface Harness {
  readonly api: FakeApi;
  readonly keyStore: DeviceKeyStore;
  /** The record store without the log, for setting up and reading. */
  readonly records: DeviceRecordStore;
  readonly markers: SignOutMarkerStore;
  readonly session: DeviceSession;
  readonly errors: string[];
  readonly timers: { delayMs: number; callback: () => void }[];
  readonly clock: { now: number };
  readonly states: DeviceSessionState[];
  /** The order of state changes, key store changes, and record changes. */
  readonly calls: string[];
  failRecordWrites: boolean;
}

function harness(
  api: FakeApi = fakeApi(),
  overrides: Partial<DeviceSessionDependencies> = {},
): Harness {
  const keyStore = createDeviceKeyStore({
    folder,
    platform: "win32",
    systemProtection: fakeSafeStorage,
  });
  const records = createDeviceRecordStore({ folder, platform: "win32" });
  const markers = createSignOutMarkerStore({ folder, platform: "win32" });
  const timers: Harness["timers"] = [];
  const scheduleTimer: ScheduleTimer = (callback, delayMs) => {
    const timer = { delayMs, callback };
    timers.push(timer);
    return () => {
      const index = timers.indexOf(timer);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    };
  };
  const calls: string[] = [];
  const h = {
    api,
    keyStore,
    records,
    markers,
    errors: [] as string[],
    timers,
    clock: { now: 1_000 },
    states: [] as DeviceSessionState[],
    calls,
    failRecordWrites: false,
    session: undefined as unknown as DeviceSession,
  };
  const loggedKeyStore: SessionKeyStore = {
    hasKey: () => keyStore.hasKey(),
    keys: () => keyStore.keys(),
    confirmReplacement: async () => {
      calls.push("key.confirm");
      await keyStore.confirmReplacement();
    },
    abandonReplacement: async () => {
      calls.push("key.abandon");
      await keyStore.abandonReplacement();
    },
    delete: async () => {
      calls.push("key.delete");
      await keyStore.delete();
    },
  };
  const loggedRecords: DeviceRecordStore = {
    read: () => records.read(),
    write: async (record) => {
      calls.push("record.write");
      if (h.failRecordWrites) {
        throw new Error("disk full");
      }
      await records.write(record);
    },
    delete: async () => {
      calls.push("record.delete");
      await records.delete();
    },
  };
  const session = createDeviceSession({
    apiOrigin: { ok: true, origin: API_ORIGIN },
    keyStore: loggedKeyStore,
    deviceRecords: loggedRecords,
    signOutMarkers: markers,
    sessionNotes: createSessionNotesStore({ folder, platform: "win32" }),
    fetch: apiFetch(api),
    scheduleTimer,
    now: () => h.clock.now,
    wallClock: () => wall.now,
    onError: (message) => h.errors.push(message),
    ...overrides,
  });
  session.onChange((state) => {
    h.states.push(state);
    calls.push(`state:${state.kind}`);
  });
  h.session = session;
  return h;
}

function deviceRecord(publicKey: string): DeviceRecord {
  return {
    deviceId: DEVICE_ID,
    userId: USER_ID,
    login: "octocat",
    displayName: "The Octocat",
    signInExpiresAt: "2026-12-01T10:00:00.000Z",
    publicKey,
  };
}

/** A signed-in device: a key, a record that names it, and the API that holds it. */
async function existingDevice(h: Harness): Promise<string> {
  const key = await h.keyStore.create({ kind: "system" });
  await h.records.write(deviceRecord(key.publicKey));
  h.api.publicKey = key.publicKey;
  await h.session.refresh();
  h.calls.length = 0;
  return key.publicKey;
}

/**
 * A sign-in that replaced the key and got no clear answer: the new key is
 * current, the previous key is kept, and the record names the previous key.
 * The test sets which key the API holds.
 */
async function pendingReplacement(
  h: Harness,
  options: { readonly inGrace?: boolean } = {},
): Promise<{ previous: string; current: string }> {
  const previous = await existingDevice(h);
  const keys = await h.keyStore.replace();
  await h.session.refresh();
  if (options.inGrace !== true) {
    // The sign-in that replaced the key ended long ago.
    wall.now += REPLACEMENT_GRACE_MS;
  }
  h.calls.length = 0;
  return { previous, current: keys.current.publicKey };
}

/** A new session on the same folder, as after a restart: a new store loads the keys. */
async function restart(h: Harness): Promise<Harness> {
  const next = harness(h.api);
  await next.keyStore.load();
  await next.session.refresh();
  next.calls.length = 0;
  return next;
}

function count(h: Harness, method: string, route: string): number {
  return h.api.requests.filter(
    (request) => request.method === method && request.path === route,
  ).length;
}

function mints(h: Harness): number {
  return count(h, "POST", "/auth/access-token");
}

/** The session notes file as JSON, or null when there is none. */
async function notesFile(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(
      await readFile(path.join(folder, SESSION_NOTES_FILE), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function recordKey(h: Harness): Promise<string | null> {
  const read = await h.records.read();
  return read.kind === "record" ? read.record.publicKey : null;
}

async function keyFiles(): Promise<string[]> {
  const names: string[] = [];
  for (const name of [
    CURRENT_KEY_FILE,
    PREVIOUS_KEY_FILE,
    DEVICE_RECORD_FILE,
  ]) {
    try {
      await readFile(path.join(folder, name));
      names.push(name);
    } catch {
      // missing
    }
  }
  return names;
}

/** The keys that the store holds now, as public keys. */
function heldKeys(
  h: Harness,
): { current: string; previous: string | null } | null {
  const keys = h.keyStore.keys();
  return keys === null
    ? null
    : {
        current: keys.current.publicKey,
        previous: keys.previous?.publicKey ?? null,
      };
}

/** The public key, of `candidates`, that signed the access token request. */
function signerOf(
  api: FakeApi,
  request: ApiRequest | undefined,
  candidates: readonly string[],
): string | undefined {
  const challengeId = request?.body?.challengeId ?? "";
  const nonce = api.challengeLog.get(challengeId) ?? "";
  return candidates.find((publicKey) =>
    verifies(
      publicKey,
      {
        purpose: "http",
        audience: API_ORIGIN,
        nonce,
        deviceId: DEVICE_ID,
        challengeId,
      },
      request?.body?.signature ?? "",
    ),
  );
}

function tokenRequests(api: FakeApi): ApiRequest[] {
  return api.requests.filter((r) => r.path === "/auth/access-token");
}

/**
 * Resolves once the fake API has received `number` requests with this
 * method and path. It waits on the arrival of each request, bounded by real
 * time, so a slow runner only makes it wait longer.
 */
function waitForRequest(
  h: Harness,
  method: string,
  route: string,
  number = 1,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (count(h, method, route) >= number) {
        stop();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`No ${method} ${route}`));
    }, 10_000);
    const stop = (): void => {
      clearTimeout(timer);
      h.api.arrivals.delete(check);
    };
    h.api.arrivals.add(check);
    check();
  });
}

/** Posts the sign-in code to the flow's loopback listener, as the API's page does. */
function postCode(redirectUri: string, state: string): Promise<number> {
  const url = new URL(redirectUri);
  const form = new URLSearchParams({ code: SIGN_IN_CODE, state }).toString();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(url.port),
        path: url.pathname,
        method: "POST",
        headers: {
          host: url.host,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(form)),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.on("error", reject);
    outgoing.end(form);
  });
}

/** A promise that never settles until the request is aborted. */
function hang(request: ApiRequest): Promise<Response> {
  return new Promise((_resolve, reject) => {
    request.init.signal?.addEventListener("abort", () =>
      reject(new Error("aborted")),
    );
  });
}

describe("access tokens", () => {
  test("mints a token with a challenge and a signature by the device key over the http input, and caches it", async () => {
    const h = harness();
    const publicKey = await existingDevice(h);

    const first = await h.session.listDevices();
    const second = await h.session.listDevices();

    expect(first).toEqual({ ok: true, value: [DEVICE_ITEM] });
    expect(second).toEqual(first);
    expect(h.api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /auth/challenge",
      "POST /auth/access-token",
      "GET /devices",
      "GET /devices",
    ]);
    const [challenge, tokenRequest, list] = h.api.requests;
    expect(challenge?.body).toBeUndefined();
    expect(challenge?.authorization).toBeNull();
    const body = tokenRequest?.body ?? {};
    expect(Object.keys(body).sort()).toEqual([
      "challengeId",
      "deviceId",
      "signature",
    ]);
    expect(body.deviceId).toBe(DEVICE_ID);
    expect(signerOf(h.api, tokenRequest, [publicKey])).toBe(publicKey);
    expect(h.api.issued).toHaveLength(1);
    expect(list?.authorization).toBe(`Bearer ${h.api.issued[0]}`);
    for (const request of h.api.requests) {
      expect(request.init.redirect).toBe("error");
      expect(request.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(h.session.state()).toMatchObject({
      kind: "signed_in",
      account: { deviceId: DEVICE_ID, login: "octocat" },
    });
  });

  test("the signature covers the http input only, with the API origin as the audience", async () => {
    const h = harness();
    const publicKey = await existingDevice(h);

    expect(await h.session.authenticate()).toMatchObject({
      ok: true,
      value: { deviceId: DEVICE_ID, login: "octocat" },
    });

    const body = tokenRequests(h.api)[0]?.body;
    const challengeId = body?.challengeId ?? "";
    const nonce = h.api.challengeLog.get(challengeId) ?? "";
    const signature = body?.signature ?? "";
    expect(
      verifies(
        publicKey,
        {
          purpose: "http",
          audience: API_ORIGIN,
          nonce,
          deviceId: DEVICE_ID,
          challengeId,
        },
        signature,
      ),
    ).toBe(true);
    expect(
      verifies(
        publicKey,
        {
          purpose: "ws",
          audience: API_ORIGIN,
          nonce,
          deviceId: DEVICE_ID,
          connectionId: challengeId,
        },
        signature,
      ),
    ).toBe(false);
    expect(
      verifies(
        publicKey,
        {
          purpose: "http",
          audience: "https://other.example",
          nonce,
          deviceId: DEVICE_ID,
          challengeId,
        },
        signature,
      ),
    ).toBe(false);
  });

  test("a cached token is used until shortly before it expires, then a new one is minted", async () => {
    const h = harness();
    await existingDevice(h);

    await h.session.listDevices();
    h.clock.now += ACCESS_TOKEN_LIFETIME_MS - ACCESS_TOKEN_RENEW_MARGIN_MS - 1;
    await h.session.listDevices();
    expect(mints(h)).toBe(1);

    h.clock.now += 1;
    await h.session.listDevices();
    expect(mints(h)).toBe(2);
    expect(h.api.requests.at(-1)?.authorization).toBe(
      `Bearer ${h.api.issued[1]}`,
    );
  });

  test("concurrent callers share one mint", async () => {
    const h = harness();
    await existingDevice(h);

    const results = await Promise.all([
      h.session.listDevices(),
      h.session.listDevices(),
      h.session.authenticate(),
      h.session.listDevices(),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(count(h, "POST", "/auth/challenge")).toBe(1);
    expect(mints(h)).toBe(1);
    expect(count(h, "GET", "/devices")).toBe(3);
  });

  test("a 401 is answered by one new token and one retry", async () => {
    const h = harness();
    await existingDevice(h);
    await h.session.listDevices();
    // The API ended the token, for example after its 15 minutes.
    h.api.tokens.clear();

    const result = await h.session.listDevices();

    expect(result.ok).toBe(true);
    expect(mints(h)).toBe(2);
    expect(count(h, "GET", "/devices")).toBe(3);
    expect(h.api.requests.at(-1)?.authorization).toBe(
      `Bearer ${h.api.issued[1]}`,
    );
  });

  test("concurrent 401s share one new token", async () => {
    const h = harness();
    await existingDevice(h);
    await h.session.listDevices();
    h.api.tokens.clear();

    const results = await Promise.all([
      h.session.listDevices(),
      h.session.listDevices(),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(mints(h)).toBe(2);
  });

  test("a second 401 with the new token is reported and not retried again", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    api.intercept = (request) =>
      request.path === "/devices"
        ? Promise.resolve(errorAnswer("unauthorized"))
        : undefined;

    const result = await h.session.listDevices();

    expect(result).toEqual({
      ok: false,
      reason: "refused",
      code: "unauthorized",
    });
    expect(mints(h)).toBe(2);
    expect(count(h, "GET", "/devices")).toBe(2);
  });

  test("the new token's failure reports the reason", async () => {
    const h = harness();
    await existingDevice(h);
    await h.session.listDevices();
    h.api.tokens.clear();
    h.api.deviceState = "sign_in_required";

    const result = await h.session.listDevices();

    expect(result).toEqual({
      ok: false,
      reason: "refused",
      code: "sign_in_required",
    });
    expect(h.session.state().kind).toBe("sign_in_required");
    expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);
  });

  test("a call without a device, without a loaded key, or without an origin asks nothing", async () => {
    const empty = harness();
    await empty.session.refresh();
    expect(empty.session.state()).toEqual({ kind: "no_device" });
    expect(await empty.session.listDevices()).toEqual({
      ok: false,
      reason: "no_device",
    });

    const h = harness();
    await existingDevice(h);
    const locked = harness(h.api);
    await locked.session.refresh();
    expect(locked.session.state()).toMatchObject({ kind: "key_not_loaded" });
    expect(await locked.session.authenticate()).toEqual({
      ok: false,
      reason: "key_not_loaded",
    });

    const unset = harness(h.api, {
      apiOrigin: { ok: false, reason: "api_origin_unset" },
    });
    await unset.keyStore.load();
    expect(await unset.session.listDevices()).toEqual({
      ok: false,
      reason: "api_origin_unset",
    });
    expect(h.api.requests).toEqual([]);
  });

  test("an invalid route parameter is refused before anything is sent", async () => {
    const h = harness();
    await existingDevice(h);
    const result = await h.session.request({
      route: { method: "POST", path: "/devices/:deviceId/revoke" },
      params: { deviceId: "not-an-id" },
      answer: "empty",
    });
    expect(result).toEqual({ ok: false, reason: "invalid_request" });
    expect(h.api.requests).toEqual([]);
  });
});

describe("a pending key replacement", () => {
  test("the new key authenticates: the record is written with the new key first, then the replacement is confirmed", async () => {
    const h = harness();
    const { current } = await pendingReplacement(h);
    h.api.publicKey = current;

    const result = await h.session.listDevices();

    expect(result.ok).toBe(true);
    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([
      "record.write",
      "key.confirm",
    ]);
    expect(await recordKey(h)).toBe(current);
    expect(heldKeys(h)).toEqual({ current, previous: null });
    expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);
    // The new key was tried first, and it was enough.
    expect(mints(h)).toBe(1);
    expect(signerOf(h.api, tokenRequests(h.api)[0], [current])).toBe(current);
    const read = await h.records.read();
    expect(read.kind === "record" && read.record).toEqual({
      ...deviceRecord(current),
    });
  });

  test("a record write that fails keeps the replacement pending", async () => {
    const h = harness();
    const { previous, current } = await pendingReplacement(h);
    h.api.publicKey = current;
    h.failRecordWrites = true;

    const result = await h.session.listDevices();

    expect(result).toEqual({ ok: false, reason: "record_not_saved" });
    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([
      "record.write",
      "record.write",
    ]);
    expect(heldKeys(h)).toEqual({ current, previous });
    expect(await recordKey(h)).toBe(previous);
    expect(h.errors).toContain("The device record could not be written.");
    expect(count(h, "GET", "/devices")).toBe(0);

    // The next attempt writes the record and confirms.
    h.failRecordWrites = false;
    expect((await h.session.listDevices()).ok).toBe(true);
    expect(await recordKey(h)).toBe(current);
    expect(heldKeys(h)).toEqual({ current, previous: null });
  });

  test("the new key gets auth_failed and the previous key works: the replacement is abandoned", async () => {
    const h = harness();
    const { previous, current } = await pendingReplacement(h);
    h.api.publicKey = previous;

    const result = await h.session.listDevices();

    expect(result.ok).toBe(true);
    // The new key first, then the previous one, each with its own challenge.
    const [first, second] = tokenRequests(h.api);
    expect(tokenRequests(h.api)).toHaveLength(2);
    expect(signerOf(h.api, first, [current, previous])).toBe(current);
    expect(signerOf(h.api, second, [current, previous])).toBe(previous);
    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([
      "key.abandon",
    ]);
    expect(heldKeys(h)).toEqual({ current: previous, previous: null });
    expect(await recordKey(h)).toBe(previous);
    expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);
  });

  test("both keys refused, and again in a round at least 10 minutes later: key_lost first, both keys deleted, the record kept, and the next sign-in registers a new device that names this one", async () => {
    const h = harness();
    const { previous, current } = await pendingReplacement(h);
    h.api.publicKey = FOREIGN_PUBLIC_KEY;

    // The first refusal of both keys only notes the time.
    expect(await h.session.authenticate()).toEqual(AUTH_FAILED);
    expect(heldKeys(h)).toEqual({ current, previous });
    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([]);
    expect(h.session.state().kind).toBe("auth_failed");
    expect(await notesFile()).toMatchObject({
      keysRefused: { publicKeys: [current, previous] },
    });
    // Until the wait ends, nothing is asked again on its own.
    const asked = h.api.requests.length;
    expect(await h.session.authenticate()).toEqual(AUTH_FAILED);
    expect(h.api.requests).toHaveLength(asked);
    // A retry that the person asks for runs a round, but deletes nothing.
    wall.now += LOST_KEY_WAIT_MS - 1;
    await h.session.refresh();
    expect(await h.session.authenticate()).toEqual(AUTH_FAILED);
    expect(mints(h)).toBe(4);
    expect(heldKeys(h)).toEqual({ current, previous });

    wall.now += 1;
    h.calls.length = 0;
    const result = await h.session.authenticate();

    expect(result).toEqual({ ok: false, reason: "key_lost" });
    // Three rounds, the new key first in each, every request with its own
    // challenge.
    const requests = tokenRequests(h.api);
    expect(
      requests.map((request) => signerOf(h.api, request, [current, previous])),
    ).toEqual([current, previous, current, previous, current, previous]);
    expect(new Set(requests.map((r) => r.body?.challengeId)).size).toBe(6);
    expect(h.calls).toEqual(["state:key_lost", "key.delete"]);
    expect(await notesFile()).toBeNull();
    expect(h.session.state()).toEqual({
      kind: "key_lost",
      account: {
        deviceId: DEVICE_ID,
        userId: USER_ID,
        login: "octocat",
        displayName: "The Octocat",
        signInExpiresAt: "2026-12-01T10:00:00.000Z",
      },
    });
    expect(await keyFiles()).toEqual([DEVICE_RECORD_FILE]);
    expect(await h.keyStore.hasKey()).toBe(false);
    expect(await recordKey(h)).toBe(previous);
    const before = h.api.requests.length;
    expect(await h.session.listDevices()).toEqual({
      ok: false,
      reason: "key_lost",
    });
    expect(h.api.requests).toHaveLength(before);
    const restarted = await restart(h);
    expect(restarted.session.state().kind).toBe("key_lost");

    // The real sign-in flow now finds a record without a key: a new device
    // that names the record's device.
    const sent: SignInRequest[] = [];
    const opened: string[] = [];
    const flow = createSignInFlow({
      apiOrigin: { ok: true, origin: API_ORIGIN },
      keyStore: h.keyStore,
      deviceRecords: h.records,
      openExternal: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      fetch: (_url, init) => {
        sent.push(SignInRequestSchema.parse(JSON.parse(String(init.body))));
        return Promise.resolve(
          json(200, {
            userId: USER_ID,
            deviceId: OTHER_DEVICE_ID,
            displayName: "The Octocat",
            login: "octocat",
            signInExpiresAt: "2026-12-02T10:00:00.000Z",
          }),
        );
      },
      platform: "win32",
      scheduleTimer: () => () => undefined,
      listenerConnectionTimeoutMs: 2_000,
    });
    h.session.signInStarted();
    const start = await flow.start();
    if (!start.started) {
      throw new Error(`Not started: ${JSON.stringify(start.outcome)}`);
    }
    const params = new URL(opened[0] ?? "").searchParams;
    expect(params.get("login")).toBe("octocat");
    expect(
      await postCode(
        params.get("redirect_uri") ?? "",
        params.get("state") ?? "",
      ),
    ).toBe(200);
    const outcome = await start.outcome;

    expect(outcome.kind).toBe("signed_in");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.device).toMatchObject({
      kind: "new",
      previousDeviceId: DEVICE_ID,
    });
    expect(await h.session.signInFinished(outcome)).toMatchObject({
      kind: "signed_in",
      account: { deviceId: OTHER_DEVICE_ID },
    });
  });

  test.each([
    ["a sign-out marker of the lost keys is deleted", false],
    ["a corrupt sign-out marker stays until a sign-in", true],
  ])("%s", async (_name, corrupt) => {
    const h = harness();
    await existingDevice(h);
    expect(await h.session.signOut()).toEqual({ ok: true, value: "reported" });
    // A sign-in after the sign-out got no clear answer, long ago.
    await h.keyStore.replace();
    h.api.publicKey = FOREIGN_PUBLIC_KEY;
    if (corrupt) {
      await writeFile(path.join(folder, SIGN_OUT_MARKER_FILE), "{");
    }
    await h.session.refresh();
    wall.now += REPLACEMENT_GRACE_MS;
    expect(await h.session.authenticate()).toEqual(AUTH_FAILED);
    wall.now += LOST_KEY_WAIT_MS;

    expect(await h.session.authenticate()).toEqual({
      ok: false,
      reason: "key_lost",
    });

    expect(h.session.state().kind).toBe("key_lost");
    expect(await keyFiles()).toEqual([DEVICE_RECORD_FILE]);
    const marker = await readFile(
      path.join(folder, SIGN_OUT_MARKER_FILE),
      "utf8",
    ).catch(() => null);
    expect(marker !== null).toBe(corrupt);
  });

  test("a refusal of both keys counts across a restart, and a round before the wait ends deletes nothing", async () => {
    const h = harness();
    const { previous, current } = await pendingReplacement(h);
    h.api.publicKey = FOREIGN_PUBLIC_KEY;
    expect(await h.session.authenticate()).toEqual(AUTH_FAILED);

    wall.now += LOST_KEY_WAIT_MS / 2;
    const restarted = await restart(h);
    expect(await restarted.session.authenticate()).toEqual(AUTH_FAILED);
    expect(heldKeys(restarted)).toEqual({ current, previous });

    wall.now += LOST_KEY_WAIT_MS / 2;
    const later = await restart(restarted);
    expect(await later.session.authenticate()).toEqual({
      ok: false,
      reason: "key_lost",
    });
    expect(await keyFiles()).toEqual([DEVICE_RECORD_FILE]);
  });

  test("both keys refused once and the new key accepted in a later round: confirmed, nothing deleted, the note dropped", async () => {
    const h = harness();
    const { current } = await pendingReplacement(h);
    h.api.publicKey = current;
    // The first round only got the answers of a short outage.
    h.api.intercept = (request) =>
      request.path === "/auth/access-token" &&
      count(h, "POST", "/auth/access-token") <= 2
        ? Promise.resolve(errorAnswer("auth_failed"))
        : undefined;
    expect(await h.session.authenticate()).toEqual(AUTH_FAILED);
    expect(heldKeys(h)?.previous).not.toBeNull();

    await h.session.refresh();
    expect((await h.session.authenticate()).ok).toBe(true);

    expect(mints(h)).toBe(3);
    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([
      "record.write",
      "key.confirm",
    ]);
    expect(heldKeys(h)).toEqual({ current, previous: null });
    expect(await recordKey(h)).toBe(current);
    expect(h.session.state().kind).toBe("signed_in");
    expect(await notesFile()).toBeNull();
  });

  test("both keys refused once and the previous key accepted in a later round: abandoned, nothing deleted", async () => {
    const h = harness();
    const { previous } = await pendingReplacement(h);
    h.api.publicKey = previous;
    h.api.intercept = (request) =>
      request.path === "/auth/access-token" &&
      count(h, "POST", "/auth/access-token") === 2
        ? Promise.resolve(errorAnswer("auth_failed"))
        : undefined;
    expect(await h.session.authenticate()).toEqual(AUTH_FAILED);

    await h.session.refresh();
    expect((await h.session.authenticate()).ok).toBe(true);

    expect(mints(h)).toBe(4);
    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([
      "key.abandon",
    ]);
    expect(heldKeys(h)).toEqual({ current: previous, previous: null });
    expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);
  });

  test("sign_in_required and device_revoked in the later round keep their meaning", async () => {
    const required = harness();
    const { current } = await pendingReplacement(required);
    required.api.publicKey = FOREIGN_PUBLIC_KEY;
    expect(await required.session.authenticate()).toEqual(AUTH_FAILED);
    wall.now += LOST_KEY_WAIT_MS;
    required.api.intercept = (request) =>
      request.path === "/auth/access-token" &&
      count(required, "POST", "/auth/access-token") === 3
        ? Promise.resolve(errorAnswer("sign_in_required"))
        : undefined;
    expect(await required.session.authenticate()).toMatchObject({
      code: "sign_in_required",
    });
    expect(required.calls.filter((call) => !call.startsWith("state:"))).toEqual(
      ["record.write", "key.confirm"],
    );
    expect(heldKeys(required)).toEqual({ current, previous: null });
    expect(required.session.state().kind).toBe("sign_in_required");

    await rm(folder, { recursive: true, force: true });
    const revoked = harness();
    await pendingReplacement(revoked);
    revoked.api.publicKey = FOREIGN_PUBLIC_KEY;
    expect(await revoked.session.authenticate()).toEqual(AUTH_FAILED);
    wall.now += LOST_KEY_WAIT_MS;
    revoked.calls.length = 0;
    revoked.api.intercept = (request) =>
      request.path === "/auth/access-token" &&
      count(revoked, "POST", "/auth/access-token") === 4
        ? Promise.resolve(errorAnswer("device_revoked"))
        : undefined;
    expect(await revoked.session.authenticate()).toMatchObject({
      code: "device_revoked",
    });
    expect(revoked.calls).toEqual([
      "state:revoked",
      "key.delete",
      "record.delete",
    ]);
  });

  const uncertainAnswers: [
    string,
    (request: ApiRequest) => Promise<Response>,
  ][] = [
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    [
      "a 5xx with an error body",
      () =>
        Promise.resolve(
          json(500, {
            statusCode: 500,
            error: "Internal Server Error",
            message: "Internal Server Error",
            code: "internal_error",
          }),
        ),
    ],
    ["a 503", () => Promise.resolve(errorAnswer("sign_in_unavailable"))],
    [
      "an answer that is not the API's",
      () =>
        Promise.resolve(
          new Response("<html>Proxy</html>", {
            status: 401,
            headers: { "content-type": "text/html" },
          }),
        ),
    ],
    [
      "an error body whose status does not fit",
      () =>
        Promise.resolve(
          json(401, {
            statusCode: 403,
            error: "Forbidden",
            message: "Forbidden",
            code: "forbidden",
          }),
        ),
    ],
    [
      "a 200 that is not a token",
      () => Promise.resolve(json(200, { accessToken: "nope" })),
    ],
    [
      "a body over the limit",
      () =>
        Promise.resolve(new Response("x".repeat(600 * 1024), { status: 401 })),
    ],
    ["rate_limited", () => Promise.resolve(errorAnswer("rate_limited"))],
  ];

  test.each(uncertainAnswers)(
    "an uncertain answer to the new key changes nothing: %s",
    async (_name, answer) => {
      const h = harness();
      const { previous, current } = await pendingReplacement(h);
      h.api.publicKey = current;
      h.api.intercept = (request) =>
        request.path === "/auth/access-token" ? answer(request) : undefined;

      const result = await h.session.listDevices();

      expect(result.ok).toBe(false);
      // The previous key is not tried after an answer that proves nothing.
      expect(mints(h)).toBe(1);
      expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([]);
      expect(heldKeys(h)).toEqual({ current, previous });
      expect(await recordKey(h)).toBe(previous);
      expect(await keyFiles()).toEqual([
        CURRENT_KEY_FILE,
        PREVIOUS_KEY_FILE,
        DEVICE_RECORD_FILE,
      ]);
      expect(h.session.state().kind).toBe("signed_in");
    },
  );

  test.each(uncertainAnswers)(
    "an uncertain answer to the previous key changes nothing: %s",
    async (_name, answer) => {
      const h = harness();
      const { previous, current } = await pendingReplacement(h);
      h.api.publicKey = previous;
      h.api.intercept = (request) =>
        request.path === "/auth/access-token" &&
        count(h, "POST", "/auth/access-token") === 2
          ? answer(request)
          : undefined;

      const result = await h.session.listDevices();

      expect(result.ok).toBe(false);
      expect(mints(h)).toBe(2);
      expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([]);
      expect(heldKeys(h)).toEqual({ current, previous });
      expect(await recordKey(h)).toBe(previous);
    },
  );

  test.each(
    uncertainAnswers.flatMap(([name, answer]) => [
      [`${name}, to the new key`, 3, answer] as const,
      [`${name}, to the previous key`, 4, answer] as const,
    ]),
  )(
    "an uncertain answer in the round after the wait changes nothing: %s",
    async (_name, number, answer) => {
      const h = harness();
      const { previous, current } = await pendingReplacement(h);
      h.api.publicKey = FOREIGN_PUBLIC_KEY;
      expect(await h.session.authenticate()).toEqual(AUTH_FAILED);
      wall.now += LOST_KEY_WAIT_MS;
      h.calls.length = 0;
      h.api.intercept = (request) =>
        request.path === "/auth/access-token" &&
        count(h, "POST", "/auth/access-token") === number
          ? answer(request)
          : undefined;

      const result = await h.session.authenticate();

      expect(result.ok).toBe(false);
      expect(result).not.toMatchObject({ reason: "key_lost" });
      expect(mints(h)).toBe(number);
      expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([]);
      expect(heldKeys(h)).toEqual({ current, previous });
      expect(await recordKey(h)).toBe(previous);
      expect(await keyFiles()).toEqual([
        CURRENT_KEY_FILE,
        PREVIOUS_KEY_FILE,
        DEVICE_RECORD_FILE,
      ]);
      expect(h.session.state().kind).toBe("auth_failed");
    },
  );

  test("a timeout changes nothing", async () => {
    const h = harness();
    const { previous, current } = await pendingReplacement(h);
    h.api.publicKey = current;
    h.api.intercept = (request) =>
      request.path === "/auth/access-token" ? hang(request) : undefined;

    const pending = h.session.listDevices();
    await waitForRequest(h, "POST", "/auth/access-token");
    const timer = h.timers.find((t) => t.delayMs === API_REQUEST_TIMEOUT_MS);
    expect(timer).toBeDefined();
    timer?.callback();
    const result = await pending;

    expect(result).toEqual({ ok: false, reason: "no_answer" });
    expect(heldKeys(h)).toEqual({ current, previous });
    expect(await recordKey(h)).toBe(previous);
    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([]);
  });

  test("the new key gets sign_in_required: the API holds it, so the record names it and it is confirmed", async () => {
    const h = harness();
    const { current } = await pendingReplacement(h);
    h.api.publicKey = current;
    h.api.deviceState = "sign_in_required";

    const result = await h.session.authenticate();

    expect(result).toEqual({
      ok: false,
      reason: "refused",
      code: "sign_in_required",
    });
    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([
      "record.write",
      "key.confirm",
    ]);
    expect(heldKeys(h)).toEqual({ current, previous: null });
    expect(h.session.state().kind).toBe("sign_in_required");
  });

  test("the previous key gets sign_in_required: the replacement is abandoned", async () => {
    const h = harness();
    const { previous } = await pendingReplacement(h);
    h.api.publicKey = previous;
    h.api.deviceState = "sign_in_required";

    await h.session.authenticate();

    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([
      "key.abandon",
    ]);
    expect(heldKeys(h)).toEqual({ current: previous, previous: null });
  });

  test("a pending replacement is not resolved while a sign-in runs", async () => {
    const h = harness();
    const { previous, current } = await pendingReplacement(h);
    h.api.publicKey = previous;
    h.session.signInStarted();

    expect(await h.session.authenticate()).toEqual({
      ok: false,
      reason: "sign_in_running",
    });
    expect(h.api.requests).toEqual([]);
    expect(heldKeys(h)).toEqual({ current, previous });

    await h.session.signInFinished({ kind: "cancelled" });
    expect((await h.session.authenticate()).ok).toBe(true);
    expect(heldKeys(h)).toEqual({ current: previous, previous: null });
  });

  test("a record that already names the new key is confirmed when read", async () => {
    const h = harness();
    const { current } = await pendingReplacement(h);
    // The application stopped between the record write and the confirmation.
    await h.records.write(deviceRecord(current));

    await h.session.refresh();

    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([
      "key.confirm",
    ]);
    expect(heldKeys(h)).toEqual({ current, previous: null });
  });
});

describe("device states", () => {
  test("device_revoked publishes revoked, then deletes the key, then the record", async () => {
    const h = harness();
    await existingDevice(h);
    h.api.deviceState = "revoked";

    const result = await h.session.listDevices();

    expect(result).toEqual({
      ok: false,
      reason: "refused",
      code: "device_revoked",
    });
    expect(h.calls).toEqual(["state:revoked", "key.delete", "record.delete"]);
    expect(await keyFiles()).toEqual([]);
    expect(h.keyStore.keys()).toBeNull();
    expect(h.session.state()).toEqual({ kind: "revoked" });
    // Nothing more is asked of the API.
    const before = h.api.requests.length;
    expect(await h.session.listDevices()).toEqual({
      ok: false,
      reason: "refused",
      code: "device_revoked",
    });
    expect(h.api.requests).toHaveLength(before);
    // `refresh` keeps it until a sign-in.
    expect((await h.session.refresh()).kind).toBe("revoked");
    expect((await h.session.signInFinished({ kind: "signed_in" })).kind).toBe(
      "no_device",
    );
  });

  test("device_revoked during a pending replacement deletes both keys and the record", async () => {
    const h = harness();
    const { current } = await pendingReplacement(h);
    h.api.publicKey = current;
    h.api.deviceState = "revoked";

    await h.session.authenticate();

    expect(h.calls).toEqual(["state:revoked", "key.delete", "record.delete"]);
    expect(await keyFiles()).toEqual([]);
  });

  test("a key that cannot be deleted keeps the record", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    api.deviceState = "revoked";
    const failing = harness(api, {
      keyStore: {
        hasKey: () => h.keyStore.hasKey(),
        keys: () => h.keyStore.keys(),
        confirmReplacement: () => h.keyStore.confirmReplacement(),
        abandonReplacement: () => h.keyStore.abandonReplacement(),
        delete: () => Promise.reject(new Error("locked")),
      },
    });
    await failing.session.refresh();

    await failing.session.listDevices();

    expect(failing.session.state()).toEqual({ kind: "revoked" });
    expect(await recordKey(h)).not.toBeNull();
    expect(failing.errors).toContain(
      "The device key or record could not be deleted.",
    );
  });

  test("sign_in_required keeps the key and asks nothing more until a refresh", async () => {
    const h = harness();
    await existingDevice(h);
    h.api.deviceState = "sign_in_required";

    await h.session.listDevices();
    expect(h.session.state()).toMatchObject({
      kind: "sign_in_required",
      account: { login: "octocat" },
    });
    expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);
    const before = h.api.requests.length;
    expect(await h.session.listDevices()).toEqual({
      ok: false,
      reason: "refused",
      code: "sign_in_required",
    });
    expect(h.api.requests).toHaveLength(before);
    expect(
      await h.session.signWebSocketChallenge(challengeFrame()),
    ).toMatchObject({ ok: false, code: "sign_in_required" });

    h.api.deviceState = "ok";
    await h.session.refresh();
    expect((await h.session.listDevices()).ok).toBe(true);
    expect(h.session.state().kind).toBe("signed_in");
  });

  test("auth_failed keeps the key", async () => {
    const h = harness();
    await existingDevice(h);
    h.api.deviceState = "disabled";

    expect(await h.session.authenticate()).toMatchObject({
      code: "auth_failed",
    });
    expect(h.session.state().kind).toBe("auth_failed");
    expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);
  });

  test("device_account_mismatch after a sign-in reports the login that the installation holds", async () => {
    const h = harness();
    await existingDevice(h);

    const state = await h.session.signInFinished({
      kind: "refused",
      code: "device_account_mismatch",
    });

    expect(state).toEqual({
      kind: "account_mismatch",
      account: {
        deviceId: DEVICE_ID,
        userId: USER_ID,
        login: "octocat",
        displayName: "The Octocat",
        signInExpiresAt: "2026-12-01T10:00:00.000Z",
      },
    });
    // The device itself is unchanged and can still be removed.
    expect((await h.session.listDevices()).ok).toBe(true);
    expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);
  });

  test("device_account_mismatch from an API call carries the login from the record", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    api.intercept = (request) =>
      request.path === "/devices"
        ? Promise.resolve(errorAnswer("device_account_mismatch"))
        : undefined;

    expect(await h.session.listDevices()).toEqual({
      ok: false,
      reason: "refused",
      code: "device_account_mismatch",
      deviceLogin: "octocat",
    });
    expect(h.session.state().kind).toBe("account_mismatch");
  });

  test("close reasons of the WebSocket apply to the state", async () => {
    const h = harness();
    await existingDevice(h);

    expect(
      (await h.session.deviceRefused("sign_in_required", DEVICE_ID)).kind,
    ).toBe("sign_in_required");
    expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);
    expect(
      (await h.session.deviceRefused("device_revoked", DEVICE_ID)).kind,
    ).toBe("revoked");
    expect(await keyFiles()).toEqual([]);
  });

  test("state listeners get every change, and one that throws changes nothing", async () => {
    const h = harness();
    const seen: string[] = [];
    h.session.onChange(() => {
      throw new Error("listener");
    });
    const stop = h.session.onChange((state) => seen.push(state.kind));
    await h.session.refresh();
    await existingDevice(h);
    stop();
    await h.session.signOut();

    expect(seen).toEqual(["no_device", "signed_in"]);
    expect(h.session.state().kind).toBe("signed_out");
    expect(h.errors).toContain("A device session listener failed.");
  });
});

describe("sign-out", () => {
  test("reports to the API with the valid token, drops it, keeps the key, and does not use it again", async () => {
    const h = harness();
    await existingDevice(h);
    await h.session.listDevices();
    const token = h.api.issued[0];

    const result = await h.session.signOut();

    expect(result).toEqual({ ok: true, value: "reported" });
    expect(h.api.signedOut).toBe(true);
    const signOut = h.api.requests.find((r) => r.path === "/auth/sign-out");
    expect(signOut?.method).toBe("POST");
    expect(signOut?.authorization).toBe(`Bearer ${token}`);
    expect(mints(h)).toBe(1);
    expect(h.session.state()).toMatchObject({
      kind: "signed_out",
      reportPending: false,
    });
    expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);

    const before = h.api.requests.length;
    expect(await h.session.listDevices()).toEqual({
      ok: false,
      reason: "signed_out",
    });
    expect(await h.session.authenticate()).toEqual({
      ok: false,
      reason: "signed_out",
    });
    expect(await h.session.signWebSocketChallenge(challengeFrame())).toEqual({
      ok: false,
      reason: "signed_out",
    });
    expect(await h.session.removeDevice()).toEqual({
      ok: false,
      reason: "signed_out",
    });
    expect(h.api.requests).toHaveLength(before);
  });

  test("without a valid token the sign-out mints one that is used only for the report", async () => {
    const h = harness();
    await existingDevice(h);

    expect(await h.session.signOut()).toEqual({ ok: true, value: "reported" });
    expect(h.api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /auth/challenge",
      "POST /auth/access-token",
      "POST /auth/sign-out",
    ]);
  });

  test("a sign-out while offline holds on the device, survives a restart, and is reported when online", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    api.intercept = () => Promise.reject(new TypeError("offline"));

    expect(await h.session.signOut()).toEqual({ ok: true, value: "pending" });
    expect(h.session.state()).toMatchObject({
      kind: "signed_out",
      reportPending: true,
    });
    expect(api.signedOut).toBe(false);
    expect(await h.session.reportSignOut()).toMatchObject({
      ok: false,
      reason: "no_answer",
    });

    const next = await restart(h);
    expect(next.session.state()).toMatchObject({
      kind: "signed_out",
      reportPending: true,
    });
    const before = api.requests.length;
    expect(await next.session.listDevices()).toEqual({
      ok: false,
      reason: "signed_out",
    });
    expect(api.requests).toHaveLength(before);

    api.intercept = null;
    expect(await next.session.reportSignOut()).toEqual({
      ok: true,
      value: "reported",
    });
    expect(api.signedOut).toBe(true);
    expect(next.session.state()).toMatchObject({
      kind: "signed_out",
      reportPending: false,
    });
    const marker = JSON.parse(
      await readFile(path.join(folder, SIGN_OUT_MARKER_FILE), "utf8"),
    ) as { reported: boolean };
    expect(marker.reported).toBe(true);

    // Reported: the key is used for nothing, also after another restart.
    const later = await restart(next);
    const count = api.requests.length;
    expect(await later.session.reportSignOut()).toEqual({
      ok: true,
      value: "reported",
    });
    expect(await later.session.authenticate()).toEqual({
      ok: false,
      reason: "signed_out",
    });
    expect(api.requests).toHaveLength(count);
  });

  test("a report answered by sign_in_required counts as reported", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    api.intercept = () => Promise.reject(new TypeError("offline"));
    await h.session.signOut();
    api.intercept = null;
    // The API requires a sign-in already, for example after 30 days.
    api.deviceState = "sign_in_required";

    expect(await h.session.reportSignOut()).toEqual({
      ok: true,
      value: "reported",
    });
    expect(h.session.state()).toMatchObject({
      kind: "signed_out",
      reportPending: false,
    });
    expect(count(h, "POST", "/auth/sign-out")).toBe(0);
  });

  test("a report whose token ends at once gets one new token", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    api.intercept = () => Promise.reject(new TypeError("offline"));
    await h.session.signOut();
    let refusedOnce = false;
    api.intercept = (request) => {
      if (request.path === "/auth/sign-out" && !refusedOnce) {
        refusedOnce = true;
        return Promise.resolve(errorAnswer("unauthorized"));
      }
      return undefined;
    };

    expect(await h.session.reportSignOut()).toEqual({
      ok: true,
      value: "reported",
    });
    expect(count(h, "POST", "/auth/sign-out")).toBe(2);
  });

  test("the next GitHub sign-in ends the sign-out", async () => {
    const h = harness();
    await existingDevice(h);
    await h.session.signOut();
    h.session.signInStarted();
    // What the sign-in flow does on a `200`: replace the key, write the
    // record with the new key, then confirm.
    const keys = await h.keyStore.replace();
    await h.records.write(deviceRecord(keys.current.publicKey));
    await h.keyStore.confirmReplacement();
    h.api.publicKey = keys.current.publicKey;
    h.api.signedOut = false;

    const state = await h.session.signInFinished({ kind: "signed_in" });

    expect(state.kind).toBe("signed_in");
    expect((await h.session.listDevices()).ok).toBe(true);
    await expect(
      readFile(path.join(folder, SIGN_OUT_MARKER_FILE)),
    ).rejects.toThrow();
  });

  test("a marker that names none of the keys has ended, also without signInFinished", async () => {
    const h = harness();
    await existingDevice(h);
    await h.session.signOut();
    // A sign-in replaced the key, and the application stopped before the
    // account service learned it.
    const keys = await h.keyStore.replace();
    await h.records.write(deviceRecord(keys.current.publicKey));
    await h.keyStore.confirmReplacement();
    h.api.publicKey = keys.current.publicKey;
    h.api.signedOut = false;

    expect((await h.session.refresh()).kind).toBe("signed_in");
    expect((await h.session.listDevices()).ok).toBe(true);
  });

  test("a sign-in after a sign-out that got no answer: a new key that authenticates ends the sign-out", async () => {
    const h = harness();
    await existingDevice(h);
    await h.session.signOut();
    // The sign-in replaced the key; its answer was lost, but the API
    // committed the new key.
    const keys = await h.keyStore.replace();
    h.api.publicKey = keys.current.publicKey;
    h.api.signedOut = false;
    await h.session.refresh();
    expect(h.session.state().kind).toBe("signed_out");

    expect((await h.session.authenticate()).ok).toBe(true);

    expect(heldKeys(h)).toEqual({
      current: keys.current.publicKey,
      previous: null,
    });
    expect(await recordKey(h)).toBe(keys.current.publicKey);
    expect(h.session.state().kind).toBe("signed_in");
  });

  test("a sign-in after a sign-out that did not commit: the previous key resolves it and the device stays signed out", async () => {
    const h = harness();
    const previous = await existingDevice(h);
    await h.session.signOut();
    // The sign-in replaced the key, and the API did not commit it; its
    // grace period has ended.
    const keys = await h.keyStore.replace();
    await h.session.refresh();
    wall.now += REPLACEMENT_GRACE_MS;

    expect(await h.session.authenticate()).toEqual({
      ok: false,
      reason: "refused",
      code: "sign_in_required",
    });

    expect(heldKeys(h)).toEqual({ current: previous, previous: null });
    expect(h.session.state()).toMatchObject({
      kind: "signed_out",
      reportPending: false,
    });
    // The new key was tried first.
    expect(
      signerOf(h.api, tokenRequests(h.api).at(-2), [keys.current.publicKey]),
    ).toBe(keys.current.publicKey);
  });

  test("a sign-out that was never reported is reported with the token of a resolved replacement", async () => {
    const api = fakeApi();
    const h = harness(api);
    const previous = await existingDevice(h);
    api.intercept = () => Promise.reject(new TypeError("offline"));
    await h.session.signOut();
    api.intercept = null;
    await h.keyStore.replace();
    await h.session.refresh();
    wall.now += REPLACEMENT_GRACE_MS;

    expect(await h.session.authenticate()).toEqual({
      ok: false,
      reason: "signed_out",
    });

    expect(api.signedOut).toBe(true);
    expect(heldKeys(h)).toEqual({ current: previous, previous: null });
    expect(h.session.state()).toMatchObject({
      kind: "signed_out",
      reportPending: false,
    });
    expect(count(h, "GET", "/devices")).toBe(0);
  });

  test("a corrupt marker keeps the device signed out until a sign-in", async () => {
    const h = harness();
    await existingDevice(h);
    await writeFile(path.join(folder, SIGN_OUT_MARKER_FILE), "{not json");

    expect((await h.session.refresh()).kind).toBe("signed_out");
    expect(await h.session.listDevices()).toEqual({
      ok: false,
      reason: "signed_out",
    });

    expect((await h.session.signInFinished({ kind: "signed_in" })).kind).toBe(
      "signed_in",
    );
  });

  test("a marker that cannot be written still holds until the application quits", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    const failing = harness(api, {
      signOutMarkers: {
        read: () => h.markers.read(),
        write: () => Promise.reject(new Error("disk full")),
        delete: () => h.markers.delete(),
      },
    });
    await failing.keyStore.load();
    await failing.session.refresh();
    api.intercept = () => Promise.reject(new TypeError("offline"));

    expect(await failing.session.signOut()).toEqual({
      ok: true,
      value: "pending",
    });
    expect(failing.session.state().kind).toBe("signed_out");
    expect(failing.errors).toContain(
      "The sign-out could not be saved; it holds until the application quits.",
    );
    expect(await failing.session.listDevices()).toEqual({
      ok: false,
      reason: "signed_out",
    });
  });
});

describe("outcomes of the sign-in flow", () => {
  /** A device that signed out, and the API knows it. */
  async function signedOutDevice(h: Harness): Promise<string> {
    const previous = await existingDevice(h);
    expect(await h.session.signOut()).toEqual({ ok: true, value: "reported" });
    h.calls.length = 0;
    return previous;
  }

  /** The content of every file in the key folder, by name. */
  async function files(): Promise<Record<string, string>> {
    const names = [
      CURRENT_KEY_FILE,
      PREVIOUS_KEY_FILE,
      DEVICE_RECORD_FILE,
      SIGN_OUT_MARKER_FILE,
    ];
    const contents: Record<string, string> = {};
    for (const name of names) {
      try {
        contents[name] = await readFile(path.join(folder, name), "utf8");
      } catch {
        // missing
      }
    }
    return contents;
  }

  // Typed as the flow's outcome, so the flow's type stays assignable to
  // `signInFinished`.
  const unchanged: SignInOutcome[] = [
    ...SIGN_IN_FAILURE_REASONS.filter(
      (reason) => reason !== "uncertain_refusal",
    ).map((reason): SignInOutcome => ({ kind: "failed", reason })),
    ...UNCERTAIN_REFUSAL_CODES.map((apiError): SignInOutcome => ({
      kind: "failed",
      reason: "uncertain_refusal",
      apiError,
    })),
    { kind: "failed", reason: "key_store_failed", keyError: "not_loaded" },
    { kind: "cancelled" },
    { kind: "timed_out" },
    { kind: "listener_error", error: "access_denied" },
    { kind: "refused", code: "conflict" },
    { kind: "refused", code: "bad_request" },
    { kind: "refused", code: "device_registration_locked" },
    { kind: "refused", code: "unsupported_account" },
  ];

  test.each(unchanged.map((outcome) => [JSON.stringify(outcome), outcome]))(
    "%s keeps a sign-out and changes no file",
    async (_name, outcome) => {
      const h = harness();
      await signedOutDevice(h);
      h.session.signInStarted();
      const before = await files();

      const state = await h.session.signInFinished(outcome);

      expect(state).toMatchObject({ kind: "signed_out", reportPending: false });
      expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([]);
      expect(await files()).toEqual(before);
      expect(before[SIGN_OUT_MARKER_FILE]).toBeDefined();
    },
  );

  test.each(unchanged.map((outcome) => [JSON.stringify(outcome), outcome]))(
    "%s leaves a signed-in device and a pending replacement as they are",
    async (_name, outcome) => {
      const h = harness();
      const { previous, current } = await pendingReplacement(h);
      h.session.signInStarted();

      const state = await h.session.signInFinished(outcome);

      expect(state.kind).toBe("signed_in");
      expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([]);
      expect(heldKeys(h)).toEqual({ current, previous });
      expect(await recordKey(h)).toBe(previous);
      expect(h.api.requests).toEqual([]);
    },
  );

  const UNCERTAIN_REFUSAL: SignInOutcome = {
    kind: "failed",
    reason: "uncertain_refusal",
    apiError: "auth_failed",
  };

  test("an uncertain refusal of a sign-in that did not commit keeps the device signed out", async () => {
    const h = harness();
    const previous = await signedOutDevice(h);
    h.session.signInStarted();
    // What the flow did: it replaced the key, and the answer was a refusal
    // that may follow a commit. The API did not commit.
    const keys = await h.keyStore.replace();

    expect(await h.session.signInFinished(UNCERTAIN_REFUSAL)).toMatchObject({
      kind: "signed_out",
    });
    expect(heldKeys(h)).toEqual({
      current: keys.current.publicKey,
      previous,
    });

    // During the grace period the API may still commit the sign-in, so
    // both keys stay although the previous key is the API's.
    expect(await h.session.authenticate()).toEqual({
      ok: false,
      reason: "refused",
      code: "sign_in_required",
    });
    expect(heldKeys(h)).toEqual({
      current: keys.current.publicKey,
      previous,
    });

    // After it, learning which key the API holds abandons the new key, and
    // the device stays signed out.
    wall.now += REPLACEMENT_GRACE_MS;
    await h.session.refresh();
    expect(await h.session.authenticate()).toEqual({
      ok: false,
      reason: "refused",
      code: "sign_in_required",
    });
    expect(heldKeys(h)).toEqual({ current: previous, previous: null });
    expect(h.session.state()).toMatchObject({
      kind: "signed_out",
      reportPending: false,
    });
    expect(await files()).toHaveProperty([SIGN_OUT_MARKER_FILE]);
  });

  test("an uncertain refusal of a sign-in that did commit ends the sign-out only when the new key authenticates", async () => {
    const h = harness();
    await signedOutDevice(h);
    h.session.signInStarted();
    // The API committed the sign-in, and only the answer to a resent copy
    // of the request arrived.
    const keys = await h.keyStore.replace();
    h.api.publicKey = keys.current.publicKey;
    h.api.signedOut = false;

    expect(await h.session.signInFinished(UNCERTAIN_REFUSAL)).toMatchObject({
      kind: "signed_out",
    });
    expect(await files()).toHaveProperty([SIGN_OUT_MARKER_FILE]);

    expect((await h.session.authenticate()).ok).toBe(true);
    expect(h.session.state().kind).toBe("signed_in");
    expect(heldKeys(h)).toEqual({
      current: keys.current.publicKey,
      previous: null,
    });
    expect(await recordKey(h)).toBe(keys.current.publicKey);
    expect(await files()).not.toHaveProperty([SIGN_OUT_MARKER_FILE]);
  });
});

describe("the grace period of an uncertain sign-in", () => {
  const NO_ANSWER: SignInOutcome = { kind: "failed", reason: "no_answer" };

  /**
   * What the sign-in flow leaves after an answer that may follow a commit:
   * the new key, the previous key, and the record that names the previous
   * key. The API has not committed (yet).
   */
  async function uncertainSignIn(
    h: Harness,
    outcome: SignInOutcome = NO_ANSWER,
  ): Promise<{ previous: string; current: string }> {
    const previous = await existingDevice(h);
    h.session.signInStarted();
    const keys = await h.keyStore.replace();
    await h.session.signInFinished(outcome);
    h.calls.length = 0;
    return { previous, current: keys.current.publicKey };
  }

  test("during it the previous key's token is used and both keys stay, so a late commit of the new key is confirmed", async () => {
    const h = harness();
    const { previous, current } = await uncertainSignIn(h);
    expect(await notesFile()).toMatchObject({
      uncertainSignIn: {
        publicKey: current,
        at: new Date(wall.now).toISOString(),
      },
    });

    expect((await h.session.listDevices()).ok).toBe(true);
    expect(
      tokenRequests(h.api).map((r) => signerOf(h.api, r, [current, previous])),
    ).toEqual([current, previous]);
    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([]);
    expect(heldKeys(h)).toEqual({ current, previous });
    expect(await recordKey(h)).toBe(previous);
    expect(h.session.state().kind).toBe("signed_in");

    // The API commits the sign-in late, which ends the previous key's
    // tokens; the new key is tried first again.
    wall.now += REPLACEMENT_GRACE_MS - 1;
    h.api.publicKey = current;
    h.api.tokens.clear();
    expect((await h.session.listDevices()).ok).toBe(true);

    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([
      "record.write",
      "key.confirm",
    ]);
    expect(heldKeys(h)).toEqual({ current, previous: null });
    expect(await recordKey(h)).toBe(current);
    expect(await notesFile()).toBeNull();
  });

  test("after it, the previous key abandons the replacement", async () => {
    const h = harness();
    const { previous } = await uncertainSignIn(h);
    wall.now += REPLACEMENT_GRACE_MS;

    expect((await h.session.listDevices()).ok).toBe(true);

    expect(h.calls.filter((call) => !call.startsWith("state:"))).toEqual([
      "key.abandon",
    ]);
    expect(heldKeys(h)).toEqual({ current: previous, previous: null });
  });

  test("it holds across a restart", async () => {
    const h = harness();
    const { previous, current } = await uncertainSignIn(h);

    wall.now += REPLACEMENT_GRACE_MS / 2;
    const restarted = await restart(h);
    expect((await restarted.session.authenticate()).ok).toBe(true);
    expect(heldKeys(restarted)).toEqual({ current, previous });

    wall.now += REPLACEMENT_GRACE_MS / 2;
    const later = await restart(restarted);
    expect((await later.session.authenticate()).ok).toBe(true);
    expect(heldKeys(later)).toEqual({ current: previous, previous: null });
  });

  const mayHaveCommitted: SignInOutcome[] = [
    { kind: "failed", reason: "no_answer" },
    { kind: "failed", reason: "server_error" },
    { kind: "failed", reason: "unexpected_response" },
    { kind: "failed", reason: "record_not_saved" },
    ...UNCERTAIN_REFUSAL_CODES.map((apiError): SignInOutcome => ({
      kind: "failed",
      reason: "uncertain_refusal",
      apiError,
    })),
    { kind: "cancelled" },
    { kind: "timed_out" },
  ];

  test.each(
    mayHaveCommitted.map((outcome) => [JSON.stringify(outcome), outcome]),
  )("%s starts it", async (_name, outcome) => {
    const h = harness();
    const { previous, current } = await uncertainSignIn(h, outcome);

    expect(await notesFile()).toMatchObject({
      uncertainSignIn: {
        publicKey: current,
        at: new Date(wall.now).toISOString(),
      },
    });
    h.api.publicKey = previous;
    expect((await h.session.authenticate()).ok).toBe(true);
    expect(heldKeys(h)).toEqual({ current, previous });
  });

  test("a later outcome of an attempt that sent nothing keeps the first time", async () => {
    const h = harness();
    await uncertainSignIn(h);
    const first = await notesFile();
    wall.now += REPLACEMENT_GRACE_MS / 2;

    h.session.signInStarted();
    const notStarted: SignInOutcome = {
      kind: "failed",
      reason: "replacement_pending",
    };
    await h.session.signInFinished(notStarted);

    expect(await notesFile()).toEqual(first);
  });

  test("a pending replacement seen without an outcome, after a stop during the request, gets it from then", async () => {
    const h = harness();
    const previous = await existingDevice(h);
    const keys = await h.keyStore.replace();

    const restarted = await restart(h);

    expect(await notesFile()).toMatchObject({
      uncertainSignIn: { publicKey: keys.current.publicKey },
    });
    expect((await restarted.session.authenticate()).ok).toBe(true);
    expect(heldKeys(restarted)).toEqual({
      current: keys.current.publicKey,
      previous,
    });
  });
});

describe("tokens, clocks, and late refusals", () => {
  test("a cached token ends by the wall clock too, which runs while the computer sleeps", async () => {
    const h = harness();
    await existingDevice(h);
    await h.session.listDevices();

    wall.now += ACCESS_TOKEN_LIFETIME_MS - ACCESS_TOKEN_RENEW_MARGIN_MS;
    await h.session.listDevices();

    expect(mints(h)).toBe(2);
  });

  test("a refusal for another device, for example a late close of a replaced device's connection, is ignored", async () => {
    const h = harness();
    await existingDevice(h);

    const state = await h.session.deviceRefused(
      "device_revoked",
      OTHER_DEVICE_ID,
    );

    expect(state.kind).toBe("signed_in");
    expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);
    expect(
      (await h.session.deviceRefused("sign_in_required", OTHER_DEVICE_ID)).kind,
    ).toBe("signed_in");
  });

  test("a sign-out made while a sign-in ran holds after that sign-in succeeds", async () => {
    const h = harness();
    await existingDevice(h);
    h.session.signInStarted();
    // The flow got the code and replaced the key; the person signs out.
    const keys = await h.keyStore.replace();
    expect((await h.session.signOut()).ok).toBe(true);
    // The flow's `200`: the record with the new key, then the confirmation.
    await h.records.write(deviceRecord(keys.current.publicKey));
    await h.keyStore.confirmReplacement();

    expect((await h.session.signInFinished({ kind: "signed_in" })).kind).toBe(
      "signed_out",
    );
    expect(
      await readFile(path.join(folder, SIGN_OUT_MARKER_FILE), "utf8"),
    ).toContain(keys.current.publicKey);
  });
});

describe("remove this device", () => {
  test("an offline removal is noted, blocks every other use of the key, holds across a restart, and is retried by refresh", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    await h.session.listDevices();
    const revokePath = `/devices/${DEVICE_ID}/revoke`;
    api.intercept = (request) =>
      request.path === revokePath
        ? Promise.reject(new TypeError("offline"))
        : undefined;

    expect(await h.session.removeDevice()).toEqual({
      ok: true,
      value: "pending",
    });
    expect(await notesFile()).toMatchObject({
      removal: { deviceId: DEVICE_ID },
    });
    expect(h.session.state()).toMatchObject({ kind: "removal_pending" });

    // The key serves only the removal: nothing else reaches the API.
    const asked = api.requests.length;
    const blocked = { ok: false, reason: "removal_pending" };
    expect(await h.session.listDevices()).toEqual(blocked);
    expect(await h.session.authenticate()).toEqual(blocked);
    expect(
      await h.session.request({
        route: AUTH_ROUTES.listDevices,
        answer: "empty",
      }),
    ).toEqual(blocked);
    expect(await h.session.signWebSocketChallenge(challengeFrame())).toEqual(
      blocked,
    );
    expect(api.requests).toHaveLength(asked);

    // A restart keeps it pending, and its refresh retries the removal.
    const restarted = await restart(h);
    expect(count(restarted, "POST", revokePath)).toBe(2);
    expect(restarted.session.state()).toMatchObject({
      kind: "removal_pending",
    });
    expect(await restarted.session.listDevices()).toEqual(blocked);
    expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);

    api.intercept = null;
    expect((await restarted.session.refresh()).kind).toBe("removed");
    expect(api.revokedReason).toBe("removed");
    expect(await keyFiles()).toEqual([]);
    expect(await notesFile()).toBeNull();
  });

  test("a sign-out or a sign-in ends a pending removal", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    api.intercept = (request) =>
      request.path.endsWith("/revoke")
        ? Promise.reject(new TypeError("offline"))
        : undefined;
    expect((await h.session.removeDevice()).ok).toBe(true);

    expect((await h.session.signInFinished({ kind: "signed_in" })).kind).toBe(
      "signed_in",
    );
    expect(await notesFile()).toBeNull();

    expect((await h.session.removeDevice()).ok).toBe(true);
    expect(await notesFile()).not.toBeNull();
    expect((await h.session.signOut()).ok).toBe(true);
    expect(await notesFile()).toBeNull();
    expect(h.session.state().kind).toBe("signed_out");
  });

  test("revokes the device as removed, and deletes the key and the record only after the API confirmed", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    let filesAtRevoke: string[] = [];
    api.intercept = (request) => {
      if (request.path.endsWith("/revoke")) {
        return keyFiles().then((files) => {
          filesAtRevoke = files;
          return answerApi(api, request);
        });
      }
      return undefined;
    };

    const result = await h.session.removeDevice();

    expect(result).toEqual({ ok: true, value: "removed" });
    const revoke = api.requests.find((r) => r.path.endsWith("/revoke"));
    expect(revoke?.method).toBe("POST");
    expect(revoke?.path).toBe(`/devices/${DEVICE_ID}/revoke`);
    expect(revoke?.body).toEqual({ reason: "removed" });
    expect(api.revokedReason).toBe("removed");
    expect(filesAtRevoke).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);
    expect(await keyFiles()).toEqual([]);
    expect(h.calls).toEqual([
      "state:removal_pending",
      "state:removed",
      "key.delete",
      "record.delete",
    ]);
    expect(h.session.state()).toEqual({ kind: "removed" });
  });

  test.each([
    ["a network error", () => Promise.reject(new TypeError("offline"))],
    [
      "a 5xx",
      () =>
        Promise.resolve(json(502, { statusCode: 502, code: "internal_error" })),
    ],
    [
      "an answer that is not the API's",
      () => Promise.resolve(new Response("<html>", { status: 404 })),
    ],
  ])(
    "without a clear answer (%s) the removal is pending and the key stays",
    async (_name, answer) => {
      const api = fakeApi();
      const h = harness(api);
      await existingDevice(h);
      api.intercept = (request) =>
        request.path.endsWith("/revoke") ? answer() : undefined;

      expect(await h.session.removeDevice()).toEqual({
        ok: true,
        value: "pending",
      });
      expect(h.session.state()).toMatchObject({ kind: "removal_pending" });
      expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);
      expect(h.calls).not.toContain("key.delete");

      api.intercept = null;
      expect(await h.session.removeDevice()).toEqual({
        ok: true,
        value: "removed",
      });
      expect(await keyFiles()).toEqual([]);
    },
  );

  test("a refused removal keeps the key and ends the pending removal", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    api.intercept = (request) =>
      request.path.endsWith("/revoke")
        ? Promise.resolve(errorAnswer("conflict"))
        : undefined;

    expect(await h.session.removeDevice()).toEqual({
      ok: false,
      reason: "refused",
      code: "conflict",
    });
    expect(h.session.state().kind).toBe("signed_in");
    expect(await notesFile()).toBeNull();
    expect(await keyFiles()).toEqual([CURRENT_KEY_FILE, DEVICE_RECORD_FILE]);
  });

  test("a removal whose new token reports device_revoked deletes the device", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    await h.session.listDevices();
    // Revoked from another device meanwhile.
    api.deviceState = "revoked";
    api.tokens.clear();

    expect(await h.session.removeDevice()).toEqual({
      ok: false,
      reason: "refused",
      code: "device_revoked",
    });
    expect(h.session.state()).toEqual({ kind: "revoked" });
    expect(await keyFiles()).toEqual([]);
  });
});

describe("device list", () => {
  test("an answer that does not pass the schema is unexpected", async () => {
    const api = fakeApi();
    const h = harness(api);
    await existingDevice(h);
    api.intercept = (request) =>
      request.path === "/devices"
        ? Promise.resolve(json(200, { devices: [{ id: "x" }] }))
        : undefined;

    expect(await h.session.listDevices()).toEqual({
      ok: false,
      reason: "unexpected_response",
    });
  });
});

function challengeFrame(): AuthChallengeFrame {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "auth.challenge",
    nonce: randomBytes(32).toString("base64url"),
    connectionId: newUuidV7() as ConnectionId,
  };
}

describe("WebSocket challenge", () => {
  test("signs the ws input with the current key and returns the auth.response frame", async () => {
    const h = harness();
    const publicKey = await existingDevice(h);
    const challenge = challengeFrame();

    const result = await h.session.signWebSocketChallenge(challenge);

    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(AuthResponseFrameSchema.parse(result.value)).toEqual(result.value);
    expect(result.value.deviceId).toBe(DEVICE_ID);
    expect(
      verifies(
        publicKey,
        {
          purpose: "ws",
          audience: API_ORIGIN,
          nonce: challenge.nonce,
          deviceId: DEVICE_ID,
          connectionId: challenge.connectionId,
        },
        result.value.signature,
      ),
    ).toBe(true);
    expect(h.api.requests).toEqual([]);
  });

  test("is refused while a replacement is pending, until authenticate resolves it", async () => {
    const h = harness();
    const { current } = await pendingReplacement(h);
    h.api.publicKey = current;

    expect(await h.session.signWebSocketChallenge(challengeFrame())).toEqual({
      ok: false,
      reason: "replacement_pending",
    });
    await h.session.authenticate();
    expect((await h.session.signWebSocketChallenge(challengeFrame())).ok).toBe(
      true,
    );
  });

  test("is refused without a device, and for a challenge outside the format", async () => {
    const empty = harness();
    expect(
      await empty.session.signWebSocketChallenge(challengeFrame()),
    ).toEqual({ ok: false, reason: "no_device" });

    const h = harness();
    await existingDevice(h);
    expect(
      await h.session.signWebSocketChallenge({
        ...challengeFrame(),
        nonce: "short",
      }),
    ).toEqual({ ok: false, reason: "invalid_request" });
  });
});

describe("secrets", () => {
  test("no token, signature, or key reaches a result, a state, a message, or the marker", async () => {
    encryptedPlainTexts.length = 0;
    const api = fakeApi();
    const h = harness(api);
    const outputs: unknown[] = [];
    const { previous } = await pendingReplacement(h);
    api.publicKey = previous;
    outputs.push(await h.session.listDevices());
    outputs.push(await h.session.authenticate());
    api.tokens.clear();
    outputs.push(await h.session.listDevices());
    api.intercept = () => Promise.reject(new TypeError("offline"));
    outputs.push(await h.session.signOut());
    outputs.push(await h.session.reportSignOut());
    api.intercept = null;
    outputs.push(await h.session.reportSignOut());
    outputs.push(await h.session.signInFinished({ kind: "signed_in" }));
    api.signedOut = false;
    outputs.push(await h.session.removeDevice());
    api.deviceState = "revoked";
    outputs.push(await h.session.deviceRefused("device_revoked", DEVICE_ID));
    outputs.push(h.session.state());

    expect(api.issued.length).toBeGreaterThan(2);
    expect(api.signatures.length).toBeGreaterThan(2);
    expect(encryptedPlainTexts.length).toBeGreaterThan(0);
    const secrets = [
      ...api.issued,
      ...api.signatures,
      ...encryptedPlainTexts,
      ...encryptedPlainTexts.map((text) =>
        Buffer.from(text, "base64").toString("hex"),
      ),
    ];
    const visible = JSON.stringify([outputs, h.states, h.errors]);
    for (const secret of secrets) {
      expect(visible).not.toContain(secret);
    }
    expect(visible).not.toContain("mmda_");
    expect(visible).not.toMatch(/Bearer/);
  });

  test("the marker file holds public keys only", async () => {
    encryptedPlainTexts.length = 0;
    const h = harness();
    await existingDevice(h);
    await h.session.listDevices();
    await h.session.signOut();

    const text = await readFile(
      path.join(folder, SIGN_OUT_MARKER_FILE),
      "utf8",
    );
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      "publicKeys",
      "reported",
      "version",
    ]);
    for (const secret of [
      ...h.api.issued,
      ...h.api.signatures,
      ...encryptedPlainTexts,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

const moduleFolder = path.dirname(fileURLToPath(import.meta.url));

test("no file of the session logs", () => {
  const names = readdirSync(moduleFolder)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
  expect(names).toEqual([
    "api-call.ts",
    "session-notes.ts",
    "session.ts",
    "sign-out-marker.ts",
    "system.ts",
    "websocket-auth.ts",
  ]);
  for (const name of names) {
    const text = readFileSync(path.join(moduleFolder, name), "utf8");
    expect(text, name).not.toMatch(/\bconsole\./);
  }
});
