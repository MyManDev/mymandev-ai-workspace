import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  API_ERROR_STATUS,
  type ApiErrorCode,
  deviceAuthInput,
  type DeviceId,
  type SignInRequest,
  SignInRequestSchema,
  type UserId,
} from "@mymandev/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createDeviceKeyStore,
  type DeviceKeyStore,
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
  SIGN_IN_REQUEST_TIMEOUT_MS,
  SIGN_IN_URL_WARNING,
  type SignInFlowDependencies,
  type SignInOutcome,
  type SignInStart,
  suggestedDeviceLabel,
} from "./flow.ts";
import { SIGN_IN_LISTENER_TIMEOUT_MS } from "./listener.ts";

const API_ORIGIN = "https://api.mymandev.example";
const SIGN_IN_URL = `${API_ORIGIN}/auth/sign-in`;
const SIGN_IN_CODE = "mmdc_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3" as DeviceId;
const OTHER_DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b7" as DeviceId;
const USER_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4" as UserId;
const SPKI_ED25519_PREFIX = "302a300506032b6570032100";

const ANSWER = Object.freeze({
  userId: USER_ID,
  deviceId: DEVICE_ID,
  displayName: "The Octocat",
  login: "octocat",
  signInExpiresAt: "2026-12-02T10:00:00.000Z",
});

let root: string;
let folder: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mymandev-sign-in-flow-"));
  folder = path.join(root, "MyManDev");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A fake `safeStorage` with the asynchronous API: it "encrypts" by adding a
 * prefix, which is enough for the store on Windows.
 */
const fakeSafeStorage: SystemKeyProtection = Object.freeze({
  isAsyncEncryptionAvailable: () => Promise.resolve(true),
  getSelectedStorageBackend: () => "unknown",
  encryptStringAsync: (plainText: string) =>
    Promise.resolve(Buffer.from(`fake:${plainText}`, "utf8")),
  decryptStringAsync: (encrypted: Buffer) =>
    Promise.resolve({
      shouldReEncrypt: false,
      result: encrypted.toString("utf8").slice("fake:".length),
    }),
});

type FetchHandler = (body: SignInRequest) => Response | Promise<Response>;

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

interface Harness {
  readonly keyStore: DeviceKeyStore;
  readonly records: DeviceRecordStore;
  readonly opened: string[];
  readonly requests: { url: string; init: RequestInit; body: SignInRequest }[];
  readonly errors: string[];
  readonly timers: { delayMs: number; callback: () => void }[];
  readonly flow: ReturnType<typeof createSignInFlow>;
  answer: FetchHandler;
  openResult: () => Promise<boolean>;
}

function harness(overrides: Partial<SignInFlowDependencies> = {}): Harness {
  const keyStore = createDeviceKeyStore({
    folder,
    platform: "win32",
    systemProtection: fakeSafeStorage,
  });
  const records = createDeviceRecordStore({ folder, platform: "win32" });
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
  const state: Harness = {
    keyStore,
    records,
    opened: [],
    requests: [],
    errors: [],
    timers,
    answer: () => json(200, ANSWER),
    openResult: () => Promise.resolve(true),
    flow: undefined as unknown as Harness["flow"],
  };
  const flow = createSignInFlow({
    apiOrigin: { ok: true, origin: API_ORIGIN },
    keyStore,
    deviceRecords: records,
    openExternal: (url) => {
      state.opened.push(url);
      return state.openResult();
    },
    fetch: async (url, init) => {
      const body = SignInRequestSchema.parse(JSON.parse(String(init.body)));
      state.requests.push({ url, init, body });
      return state.answer(body);
    },
    platform: "win32",
    scheduleTimer,
    listenerConnectionTimeoutMs: 2_000,
    onError: (message) => state.errors.push(message),
    ...overrides,
  });
  (state as { flow: Harness["flow"] }).flow = flow;
  return state;
}

/** Posts a form body to the listener, as the API's page does. */
function postForm(redirectUri: string, form: string): Promise<number> {
  const url = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const outgoing = request(
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

function authorizeParams(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

function started(start: SignInStart) {
  if (!start.started) {
    throw new Error(`Not started: ${JSON.stringify(start.outcome)}`);
  }
  return start;
}

/** Starts a sign-in, delivers the code through the real listener, and returns the outcome. */
async function signIn(h: Harness): Promise<{
  outcome: SignInOutcome;
  start: SignInStart;
  authorizeUrl: string;
}> {
  const start = started(await h.flow.start());
  const authorizeUrl = h.opened.at(-1) ?? "";
  const params = authorizeParams(authorizeUrl);
  const form = new URLSearchParams({
    code: SIGN_IN_CODE,
    state: params.get("state") ?? "",
  }).toString();
  expect(await postForm(params.get("redirect_uri") ?? "", form)).toBe(200);
  return { outcome: await start.outcome, start, authorizeUrl };
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
  input: Parameters<typeof deviceAuthInput>[0],
  signature: string,
): boolean {
  return verify(
    null,
    Buffer.from(deviceAuthInput(input), "utf8"),
    publicKeyObject(publicKey),
    Buffer.from(signature, "base64url"),
  );
}

const RECORD: DeviceRecord = Object.freeze({
  deviceId: DEVICE_ID,
  userId: USER_ID,
  login: "octocat",
  displayName: "The Octocat",
  signInExpiresAt: "2026-11-30T10:00:00.000Z",
});

/** A device that signed in before: a record and a loaded key. */
async function existingDevice(h: Harness): Promise<string> {
  const key = await h.keyStore.create({ kind: "system" });
  await h.records.write(RECORD);
  return key.publicKey;
}

describe("a new device", () => {
  test("registers a new key with a platform label and writes the record", async () => {
    const h = harness();
    const { outcome, start, authorizeUrl } = await signIn(h);

    expect(start).toMatchObject({ started: true, opened: true });
    expect(started(start).pairingCode).toMatch(/^[0-9]{6}$/u);
    const params = authorizeParams(authorizeUrl);
    expect(
      authorizeUrl.startsWith(`${API_ORIGIN}/auth/github/authorize?`),
    ).toBe(true);
    expect(params.get("prompt")).toBe("select_account");
    expect(params.has("login")).toBe(false);

    expect(h.requests).toHaveLength(1);
    const [sent] = h.requests;
    expect(sent?.url).toBe(SIGN_IN_URL);
    expect(sent?.init.method).toBe("POST");
    expect(sent?.init.redirect).toBe("error");
    expect(sent?.init.headers).toMatchObject({
      "content-type": "application/json",
    });
    const body = sent?.body as SignInRequest;
    expect(body.code).toBe(SIGN_IN_CODE);
    expect(body.redirectUri).toBe(params.get("redirect_uri"));
    expect(body.device.kind).toBe("new");
    if (body.device.kind !== "new") {
      throw new Error("expected a new device");
    }
    expect(body.device.label).toBe("Windows computer");
    expect(body.device.platform).toBe("windows");
    expect(body.device.keyAlgorithm).toBe("ed25519");
    expect(body.device.previousDeviceId).toBeUndefined();
    expect(body.device.publicKey).toBe(h.keyStore.keys()?.current.publicKey);
    expect(
      verifies(
        body.device.publicKey,
        {
          purpose: "sign-in",
          audience: API_ORIGIN,
          signInCode: SIGN_IN_CODE,
          deviceId: null,
          newPublicKey: body.device.publicKey,
        },
        body.device.newKeySignature,
      ),
    ).toBe(true);

    expect(outcome).toEqual({
      kind: "signed_in",
      account: ANSWER,
      newDevice: true,
      login: "octocat",
    });
    expect(await h.records.read()).toEqual({
      kind: "record",
      record: ANSWER,
    });
  }, 20_000);

  test("suggests a label from the platform only", () => {
    expect(suggestedDeviceLabel("windows")).toBe("Windows computer");
    expect(suggestedDeviceLabel("macos")).toBe("Mac");
    expect(suggestedDeviceLabel("linux")).toBe("Linux computer");
  });

  test("names the previous device when the key was lost", async () => {
    const h = harness();
    await h.records.write(RECORD);
    h.answer = () => json(200, { ...ANSWER, deviceId: OTHER_DEVICE_ID });
    const { outcome, authorizeUrl } = await signIn(h);

    const device = h.requests[0]?.body.device;
    expect(device).toMatchObject({
      kind: "new",
      previousDeviceId: DEVICE_ID,
    });
    // The record holds the login, so this is a repeated sign-in.
    expect(authorizeParams(authorizeUrl).get("login")).toBe("octocat");
    expect(authorizeParams(authorizeUrl).has("prompt")).toBe(false);
    expect(outcome).toMatchObject({ kind: "signed_in", newDevice: true });
    expect(await h.records.read()).toMatchObject({
      record: { deviceId: OTHER_DEVICE_ID },
    });
  }, 20_000);

  test("deletes a leftover key without a record first", async () => {
    const h = harness();
    const leftover = await h.keyStore.create({ kind: "system" });
    const { outcome } = await signIn(h);

    const device = h.requests[0]?.body.device;
    expect(device?.kind).toBe("new");
    expect(device?.publicKey).not.toBe(leftover.publicKey);
    expect(h.keyStore.keys()?.current.publicKey).toBe(device?.publicKey);
    expect(outcome).toMatchObject({ kind: "signed_in", newDevice: true });
  }, 20_000);

  test("does not trust a corrupt record", async () => {
    const h = harness();
    await h.keyStore.create({ kind: "system" });
    await h.records.write(RECORD);
    await writeFile(path.join(folder, DEVICE_RECORD_FILE), "{");
    const { outcome } = await signIn(h);

    expect(h.requests[0]?.body.device).toMatchObject({ kind: "new" });
    expect(h.requests[0]?.body.device).not.toHaveProperty("previousDeviceId");
    expect(h.errors).toContain("The device record is corrupt and is not used.");
    expect(outcome).toMatchObject({ kind: "signed_in" });
  }, 20_000);
});

describe("an existing device", () => {
  test("replaces the key with two signatures over the same input, and confirms it", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    const { outcome, authorizeUrl } = await signIn(h);

    const params = authorizeParams(authorizeUrl);
    expect(params.get("login")).toBe("octocat");
    expect(params.has("prompt")).toBe(false);

    const device = h.requests[0]?.body.device;
    if (device?.kind !== "existing") {
      throw new Error("expected an existing device");
    }
    expect(device.deviceId).toBe(DEVICE_ID);
    expect(device.publicKey).not.toBe(previousKey);
    const input = {
      purpose: "sign-in",
      audience: API_ORIGIN,
      signInCode: SIGN_IN_CODE,
      deviceId: DEVICE_ID,
      newPublicKey: device.publicKey,
    } as const;
    expect(verifies(previousKey, input, device.currentKeySignature)).toBe(true);
    expect(verifies(device.publicKey, input, device.newKeySignature)).toBe(
      true,
    );

    expect(outcome).toEqual({
      kind: "signed_in",
      account: ANSWER,
      newDevice: false,
      login: "octocat",
    });
    // Confirmed: the previous key is gone, and the new key is current.
    const keys = h.keyStore.keys();
    expect(keys?.previous).toBeNull();
    expect(keys?.current.publicKey).toBe(device.publicKey);
    expect(await h.records.read()).toEqual({ kind: "record", record: ANSWER });
  }, 20_000);

  test("refuses to start while a key is not loaded", async () => {
    const h = harness();
    await existingDevice(h);
    const fresh = harness();
    expect(await fresh.flow.start()).toEqual({
      started: false,
      outcome: { kind: "failed", reason: "key_not_loaded" },
    });
    expect(fresh.opened).toEqual([]);
  });

  test("refuses to start while a replacement is pending", async () => {
    const h = harness();
    await existingDevice(h);
    await h.keyStore.replace();
    expect(await h.flow.start()).toEqual({
      started: false,
      outcome: { kind: "failed", reason: "replacement_pending" },
    });
  });
});

describe("answers of the API", () => {
  test("abandons the replacement on a 4xx answer", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    h.answer = () => errorAnswer("auth_failed");
    const { outcome } = await signIn(h);

    expect(outcome).toEqual({ kind: "refused", code: "auth_failed" });
    const keys = h.keyStore.keys();
    expect(keys?.current.publicKey).toBe(previousKey);
    expect(keys?.previous).toBeNull();
    expect(await h.records.read()).toEqual({ kind: "record", record: RECORD });
  }, 20_000);

  test("abandons the replacement on a 5xx answer with an error body", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    h.answer = () =>
      json(503, {
        statusCode: 503,
        error: "Service Unavailable",
        message: "Service Unavailable",
        code: "internal_error",
      });
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({ kind: "refused", code: "internal_error" });
    expect(h.keyStore.keys()?.current.publicKey).toBe(previousKey);
  }, 20_000);

  test("keeps the replacement pending when no answer arrives", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    h.answer = () => {
      throw new TypeError("fetch failed");
    };
    const { outcome } = await signIn(h);

    expect(outcome).toEqual({ kind: "failed", reason: "no_answer" });
    const keys = h.keyStore.keys();
    expect(keys?.previous?.publicKey).toBe(previousKey);
    expect(keys?.current.publicKey).toBe(h.requests[0]?.body.device.publicKey);
    expect(await h.records.read()).toEqual({ kind: "record", record: RECORD });
  }, 20_000);

  test("keeps the replacement pending for an answer that is not the API's", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    h.answer = () => new Response("<html>Bad Gateway</html>", { status: 502 });
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({ kind: "failed", reason: "unexpected_response" });
    expect(h.keyStore.keys()?.previous?.publicKey).toBe(previousKey);
  }, 20_000);

  test("gives up waiting for the answer after the request timeout", async () => {
    const h = harness();
    await existingDevice(h);
    h.answer = () =>
      new Promise<Response>((_resolve, reject) => {
        const signal = h.requests[0]?.init.signal;
        signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        const timer = h.timers.find(
          (entry) => entry.delayMs === SIGN_IN_REQUEST_TIMEOUT_MS,
        );
        timer?.callback();
      });
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({ kind: "failed", reason: "no_answer" });
    expect(h.keyStore.keys()?.previous).not.toBeNull();
  }, 20_000);

  test("deletes the key and the record on device_revoked", async () => {
    const h = harness();
    await existingDevice(h);
    h.answer = () => errorAnswer("device_revoked");
    const { outcome } = await signIn(h);

    expect(outcome).toEqual({ kind: "refused", code: "device_revoked" });
    expect(await h.keyStore.hasKey()).toBe(false);
    expect(h.keyStore.keys()).toBeNull();
    expect(await h.records.read()).toEqual({ kind: "none" });
  }, 20_000);

  test("asks for the account after device_account_mismatch", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    h.answer = () => errorAnswer("device_account_mismatch");
    const first = await signIn(h);

    expect(first.outcome).toEqual({
      kind: "refused",
      code: "device_account_mismatch",
      deviceLogin: "octocat",
    });
    expect(h.keyStore.keys()?.current.publicKey).toBe(previousKey);

    h.answer = () => json(200, ANSWER);
    const second = await signIn(h);
    const params = authorizeParams(second.authorizeUrl);
    expect(params.get("prompt")).toBe("select_account");
    expect(params.get("login")).toBe("octocat");
    expect(second.outcome).toMatchObject({ kind: "signed_in" });

    // A successful sign-in ends the mismatch: the next one is a plain repeat.
    const third = await signIn(h);
    expect(authorizeParams(third.authorizeUrl).has("prompt")).toBe(false);
  }, 30_000);

  test("deletes a new device's key when the API refused it", async () => {
    const h = harness();
    h.answer = () => errorAnswer("rate_limited");
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({ kind: "refused", code: "rate_limited" });
    expect(await h.keyStore.hasKey()).toBe(false);
    expect(await h.records.read()).toEqual({ kind: "none" });
  }, 20_000);

  test("does not trust a 200 answer outside the format", async () => {
    const h = harness();
    await existingDevice(h);
    h.answer = () => json(200, { ...ANSWER, login: "octo cat" });
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({ kind: "failed", reason: "unexpected_response" });
    expect(h.keyStore.keys()?.previous).not.toBeNull();
    expect(await h.records.read()).toEqual({ kind: "record", record: RECORD });
  }, 20_000);
});

describe("the browser and the listener", () => {
  test("shows the authorize URL with the warning when the browser does not open", async () => {
    const h = harness();
    h.openResult = () => Promise.resolve(false);
    const start = started(await h.flow.start());
    expect(start.opened).toBe(false);
    if (start.opened) {
      throw new Error("expected opened: false");
    }
    expect(start.authorizeUrl).toBe(h.opened[0]);
    expect(start.warning).toBe(SIGN_IN_URL_WARNING);
    expect(SIGN_IN_URL_WARNING).toContain("Do not share it");
    start.cancel();
    expect(await start.outcome).toEqual({ kind: "cancelled" });
  });

  test("treats a rejected openExternal as not opened", async () => {
    const h = harness();
    h.openResult = () => Promise.reject(new Error("no browser"));
    const start = started(await h.flow.start());
    expect(start.opened).toBe(false);
    start.cancel();
    await start.outcome;
  });

  test("cancels an open attempt", async () => {
    const h = harness();
    const start = started(await h.flow.start());
    start.cancel();
    expect(await start.outcome).toEqual({ kind: "cancelled" });
    expect(h.requests).toEqual([]);
    expect(h.keyStore.keys()).toBeNull();
    // The flow can start again.
    const again = started(await h.flow.start());
    again.cancel();
    await again.outcome;
  });

  test("allows one attempt at a time", async () => {
    const h = harness();
    const start = started(await h.flow.start());
    expect(await h.flow.start()).toEqual({
      started: false,
      outcome: { kind: "failed", reason: "already_running" },
    });
    start.cancel();
    await start.outcome;
  });

  test("times out after the listener's 10 minutes", async () => {
    const h = harness();
    const start = started(await h.flow.start());
    const timer = h.timers.find(
      (entry) => entry.delayMs === SIGN_IN_LISTENER_TIMEOUT_MS,
    );
    expect(timer).toBeDefined();
    timer?.callback();
    expect(await start.outcome).toEqual({ kind: "timed_out" });
  });

  test("reports an error that the API's page posted", async () => {
    const h = harness();
    const start = started(await h.flow.start());
    const params = authorizeParams(h.opened[0] ?? "");
    const form = new URLSearchParams({
      error: "access_denied",
      state: params.get("state") ?? "",
    }).toString();
    expect(await postForm(params.get("redirect_uri") ?? "", form)).toBe(200);
    expect(await start.outcome).toEqual({
      kind: "listener_error",
      error: "access_denied",
    });
  }, 20_000);
});

describe("the key store", () => {
  test("reports the store's error code when a new key cannot be created", async () => {
    const h = harness({
      keyStore: {
        ...createDeviceKeyStore({
          folder,
          platform: "win32",
          systemProtection: {
            ...fakeSafeStorage,
            isAsyncEncryptionAvailable: () => Promise.resolve(false),
          },
        }),
      },
    });
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({
      kind: "failed",
      reason: "key_store_failed",
      keyError: "system_protection_unavailable",
    });
    expect(h.requests).toEqual([]);
  }, 20_000);
});

describe("configuration", () => {
  test.each(["api_origin_unset", "api_origin_invalid"] as const)(
    "answers %s without opening the browser",
    async (reason) => {
      const h = harness({ apiOrigin: { ok: false, reason } });
      expect(await h.flow.start()).toEqual({
        started: false,
        outcome: { kind: "failed", reason },
      });
      expect(h.opened).toEqual([]);
    },
  );

  test("refuses another platform", async () => {
    const h = harness({ platform: "freebsd" });
    expect(await h.flow.start()).toEqual({
      started: false,
      outcome: { kind: "failed", reason: "unsupported_platform" },
    });
  });
});

describe("secrets", () => {
  test("no code, verifier, signature, or private key reaches a log or an outcome", async () => {
    const h = harness();
    await existingDevice(h);
    const results: unknown[] = [];
    const answers: (() => Response)[] = [
      () => json(200, ANSWER),
      () => errorAnswer("auth_failed"),
      () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const answer of answers) {
      h.answer = answer;
      const { outcome, start } = await signIn(h);
      results.push(outcome, start);
      if (h.keyStore.keys()?.previous !== null) {
        await h.keyStore.confirmReplacement();
      }
    }
    const secrets = h.requests.flatMap(({ body }) => [
      body.code,
      body.codeVerifier,
      body.device.newKeySignature,
      ...(body.device.kind === "existing"
        ? [body.device.currentKeySignature]
        : []),
    ]);
    expect(secrets.length).toBeGreaterThan(0);
    const shown = [
      ...results.map((value) => JSON.stringify(value)),
      ...h.errors,
    ].join("\n");
    for (const secret of secrets) {
      expect(shown).not.toContain(secret);
    }
    expect(shown).not.toContain("mmdc_");
  }, 40_000);
});
