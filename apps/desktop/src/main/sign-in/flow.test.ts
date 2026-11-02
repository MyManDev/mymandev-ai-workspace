import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  MAX_ANSWER_BYTES,
  OPEN_EXTERNAL_TIMEOUT_MS,
  SIGN_IN_REQUEST_TIMEOUT_MS,
  SIGN_IN_URL_WARNING,
  type SignInFlowDependencies,
  type SignInOutcome,
  type SignInStart,
  suggestedDeviceLabel,
  UNCERTAIN_REFUSAL_CODES,
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
/** Every plain text that the fake encrypted: the private keys as PKCS#8 in base64. */
const encryptedPlainTexts: string[] = [];

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

/** Delivers the code through the real listener of the attempt that opened this URL. */
async function deliverCode(authorizeUrl: string): Promise<void> {
  const params = authorizeParams(authorizeUrl);
  const form = new URLSearchParams({
    code: SIGN_IN_CODE,
    state: params.get("state") ?? "",
  }).toString();
  expect(await postForm(params.get("redirect_uri") ?? "", form)).toBe(200);
}

/** Starts a sign-in, delivers the code through the real listener, and returns the outcome. */
async function signIn(h: Harness): Promise<{
  outcome: SignInOutcome;
  start: SignInStart;
  authorizeUrl: string;
}> {
  const start = started(await h.flow.start());
  const authorizeUrl = h.opened.at(-1) ?? "";
  await deliverCode(authorizeUrl);
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

/** A raw Ed25519 public key as 64 hexadecimal characters, held by no store. */
function randomPublicKey(): string {
  const { x } = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  });
  return Buffer.from(x ?? "", "base64url").toString("hex");
}

/** Waits until the flow scheduled a timer with this delay. */
async function waitForTimer(h: Harness, delayMs: number) {
  for (let round = 0; round < 500; round += 1) {
    const timer = h.timers.find((entry) => entry.delayMs === delayMs);
    if (timer !== undefined) {
      return timer;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The timer was not scheduled.");
}

const RECORD: DeviceRecord = Object.freeze({
  deviceId: DEVICE_ID,
  userId: USER_ID,
  login: "octocat",
  displayName: "The Octocat",
  signInExpiresAt: "2026-11-30T10:00:00.000Z",
  publicKey: randomPublicKey(),
});

/** A device that signed in before: a record and a loaded key. */
async function existingDevice(h: Harness): Promise<string> {
  const key = await h.keyStore.create({ kind: "system" });
  await h.records.write({ ...RECORD, publicKey: key.publicKey });
  return key.publicKey;
}

const SERVER_ERROR = Object.freeze({
  statusCode: 500,
  error: "Internal Server Error",
  message: "Internal Server Error",
  code: "internal_error",
});

interface FakeApi {
  /** The public key that the API holds for the device of `RECORD`. */
  readonly publicKey: () => string;
  /** How many requests committed. */
  readonly commits: () => number;
  readonly handle: (body: SignInRequest) => Response;
  /** Drops the records of used codes, as a restart of the API does. */
  readonly restart: () => void;
}

/**
 * A fake of `POST /auth/sign-in` for the device of `RECORD`, in the API's
 * order: it takes the single-use code before every other check, verifies
 * both signatures against the key that it holds, and then holds the new key.
 * Like the API (#152), it keeps the verifier and redirect URI of the request
 * that took a code, in memory only, and answers a copy with both
 * `sign_in_code_used`. Unlike the API, it binds no challenge: it records the
 * verifier of whichever request took the code, which is the desktop's own in
 * every test here.
 */
function fakeApi(publicKey: string): FakeApi {
  const codes = new Set([SIGN_IN_CODE]);
  const used = new Map<string, { codeVerifier: string; redirectUri: string }>();
  let held = publicKey;
  let commits = 0;
  return {
    publicKey: () => held,
    commits: () => commits,
    restart: () => {
      used.clear();
    },
    handle: (body) => {
      if (!codes.delete(body.code)) {
        const taken = used.get(body.code);
        return errorAnswer(
          taken?.codeVerifier === body.codeVerifier &&
            taken.redirectUri === body.redirectUri
            ? "sign_in_code_used"
            : "auth_failed",
        );
      }
      used.set(body.code, {
        codeVerifier: body.codeVerifier,
        redirectUri: body.redirectUri,
      });
      const { device } = body;
      if (device.kind !== "existing" || device.deviceId !== DEVICE_ID) {
        return errorAnswer("auth_failed");
      }
      const input = {
        purpose: "sign-in",
        audience: API_ORIGIN,
        signInCode: body.code,
        deviceId: device.deviceId,
        newPublicKey: device.publicKey,
      } as const;
      if (
        device.publicKey === held ||
        !verifies(held, input, device.currentKeySignature) ||
        !verifies(device.publicKey, input, device.newKeySignature)
      ) {
        return errorAnswer("auth_failed");
      }
      held = device.publicKey;
      commits += 1;
      return json(200, ANSWER);
    },
  };
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
      record: { ...ANSWER, publicKey: body.device.publicKey },
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

  test("refuses to start when a corrupt record sits next to a key, and keeps the key", async () => {
    const h = harness();
    const key = await h.keyStore.create({ kind: "system" });
    await h.records.write({ ...RECORD, publicKey: key.publicKey });
    await writeFile(path.join(folder, DEVICE_RECORD_FILE), "{");
    expect(await h.flow.start()).toEqual({
      started: false,
      outcome: { kind: "failed", reason: "record_unreadable" },
    });
    expect(await h.keyStore.hasKey()).toBe(true);
    expect(h.keyStore.keys()?.current.publicKey).toBe(key.publicKey);
    expect(h.opened).toEqual([]);
    expect(h.errors).toContain(
      "The device record is corrupt; the device key is kept.",
    );
  });

  test("keeps the key next to a record of another version", async () => {
    const h = harness();
    const key = await h.keyStore.create({ kind: "system" });
    await h.records.write({ ...RECORD, publicKey: key.publicKey });
    await writeFile(
      path.join(folder, DEVICE_RECORD_FILE),
      JSON.stringify({ version: 2, ...RECORD, publicKey: key.publicKey }),
    );
    expect(await h.flow.start()).toEqual({
      started: false,
      outcome: { kind: "failed", reason: "record_unreadable" },
    });
    expect(h.keyStore.keys()?.current.publicKey).toBe(key.publicKey);
  });

  test("registers a new device when a corrupt record has no key next to it", async () => {
    const h = harness();
    await h.records.write(RECORD);
    await writeFile(path.join(folder, DEVICE_RECORD_FILE), "{");
    const { outcome } = await signIn(h);

    expect(h.requests[0]?.body.device).toMatchObject({ kind: "new" });
    expect(h.requests[0]?.body.device).not.toHaveProperty("previousDeviceId");
    expect(h.errors).toContain("The device record is corrupt and is not used.");
    expect(outcome).toMatchObject({ kind: "signed_in" });
  }, 20_000);

  test("keeps a new device's key and the old record on a 5xx answer, and registers again next time", async () => {
    const h = harness();
    // The key of the recorded device was lost.
    await h.records.write(RECORD);
    h.answer = () => json(500, SERVER_ERROR);
    const first = await signIn(h);

    expect(first.outcome).toEqual({ kind: "failed", reason: "server_error" });
    const kept = h.requests[0]?.body.device.publicKey;
    expect(h.keyStore.keys()?.current.publicKey).toBe(kept);
    expect(await h.keyStore.hasKey()).toBe(true);
    expect(await h.records.read()).toEqual({ kind: "record", record: RECORD });

    // The kept key is not the record's device's key, so it is never used
    // with that device ID: the next attempt registers a new device again.
    h.answer = () => json(200, { ...ANSWER, deviceId: OTHER_DEVICE_ID });
    const second = await signIn(h);
    const device = h.requests[1]?.body.device;
    expect(device).toMatchObject({ kind: "new", previousDeviceId: DEVICE_ID });
    expect(device?.publicKey).not.toBe(kept);
    expect(second.outcome).toMatchObject({
      kind: "signed_in",
      newDevice: true,
    });
    expect(await h.records.read()).toMatchObject({
      record: { deviceId: OTHER_DEVICE_ID, publicKey: device?.publicKey },
    });
  }, 30_000);

  test("keeps a first sign-in's key when no answer arrives", async () => {
    const h = harness();
    h.answer = () => {
      throw new TypeError("fetch failed");
    };
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({ kind: "failed", reason: "no_answer" });
    expect(h.keyStore.keys()?.current.publicKey).toBe(
      h.requests[0]?.body.device.publicKey,
    );
    expect(await h.records.read()).toEqual({ kind: "none" });
  }, 20_000);

  test("keeps a first sign-in's key on 409 with sign_in_code_used (#152)", async () => {
    const h = harness();
    expect(errorAnswer("sign_in_code_used").status).toBe(409);
    h.answer = () => errorAnswer("sign_in_code_used");
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({
      kind: "failed",
      reason: "uncertain_refusal",
      apiError: "sign_in_code_used",
    });
    expect(h.keyStore.keys()?.current.publicKey).toBe(
      h.requests[0]?.body.device.publicKey,
    );
    expect(await h.records.read()).toEqual({ kind: "none" });
  }, 20_000);

  test.each(UNCERTAIN_REFUSAL_CODES)(
    "keeps a new device's key and the old record on %s",
    async (code) => {
      const h = harness();
      // The key of the recorded device was lost.
      await h.records.write(RECORD);
      h.answer = () => errorAnswer(code);
      const { outcome } = await signIn(h);

      expect(outcome).toEqual({
        kind: "failed",
        reason: "uncertain_refusal",
        apiError: code,
      });
      expect(h.keyStore.keys()?.current.publicKey).toBe(
        h.requests[0]?.body.device.publicKey,
      );
      expect(await h.records.read()).toEqual({
        kind: "record",
        record: RECORD,
      });
      expect(h.errors).toContain(
        "The sign-in request got a refusal that may follow a commit.",
      );
    },
    20_000,
  );

  test("writes the record a second time when the first write fails", async () => {
    const records = createDeviceRecordStore({ folder, platform: "win32" });
    let writes = 0;
    const h = harness({
      deviceRecords: {
        read: records.read,
        delete: records.delete,
        write: async (record) => {
          writes += 1;
          if (writes === 1) {
            throw new Error("disk full");
          }
          await records.write(record);
        },
      },
    });
    const { outcome } = await signIn(h);
    expect(outcome).toMatchObject({ kind: "signed_in" });
    expect(writes).toBe(2);
    expect(h.errors).toContain("The device record could not be written.");
    expect(await records.read()).toMatchObject({ kind: "record" });
  }, 20_000);

  test("keeps an unsaved record and writes it before the next attempt", async () => {
    const records = createDeviceRecordStore({ folder, platform: "win32" });
    let failing = true;
    const h = harness({
      deviceRecords: {
        read: records.read,
        delete: records.delete,
        write: (record) =>
          failing
            ? Promise.reject(new Error("disk full"))
            : records.write(record),
      },
    });
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({ kind: "failed", reason: "record_not_saved" });
    const registered = h.requests[0]?.body.device.publicKey;

    // While the record still cannot be written, nothing else happens.
    expect(await h.flow.start()).toEqual({
      started: false,
      outcome: { kind: "failed", reason: "record_not_saved" },
    });
    expect(h.keyStore.keys()?.current.publicKey).toBe(registered);

    // Then the record is written first, and the key is the device's key.
    failing = false;
    const next = started(await h.flow.start());
    expect(await records.read()).toEqual({
      kind: "record",
      record: { ...ANSWER, publicKey: registered },
    });
    expect(authorizeParams(h.opened.at(-1) ?? "").get("login")).toBe("octocat");
    next.cancel();
    await next.outcome;
    expect(h.keyStore.keys()?.current.publicKey).toBe(registered);
  }, 20_000);
});

describe("an existing device", () => {
  test("keeps the replacement pending when the record cannot be written after a 200", async () => {
    const records = createDeviceRecordStore({ folder, platform: "win32" });
    let failing = true;
    const h = harness({
      deviceRecords: {
        read: records.read,
        delete: records.delete,
        write: (record) =>
          failing
            ? Promise.reject(new Error("locked by another program"))
            : records.write(record),
      },
    });
    const previousKey = await existingDevice(h);
    const { outcome } = await signIn(h);
    const newKey = h.requests[0]?.body.device.publicKey;

    expect(outcome).toEqual({ kind: "failed", reason: "record_not_saved" });
    // Not confirmed: both keys are kept, and the record names the previous one.
    expect(h.keyStore.keys()?.current.publicKey).toBe(newKey);
    expect(h.keyStore.keys()?.previous?.publicKey).toBe(previousKey);
    expect(await records.read()).toEqual({
      kind: "record",
      record: { ...RECORD, publicKey: previousKey },
    });

    // In the same run, the next start writes the record first and then
    // confirms the replacement.
    failing = false;
    const next = started(await h.flow.start());
    expect(await records.read()).toEqual({
      kind: "record",
      record: { ...ANSWER, publicKey: newKey },
    });
    expect(h.keyStore.keys()?.previous).toBeNull();
    expect(h.keyStore.keys()?.current.publicKey).toBe(newKey);
    expect(authorizeParams(h.opened.at(-1) ?? "").get("login")).toBe("octocat");
    next.cancel();
    await next.outcome;
  }, 20_000);

  test("after a restart without the record write, keeps both keys and sends nothing", async () => {
    const records = createDeviceRecordStore({ folder, platform: "win32" });
    const h = harness({
      deviceRecords: {
        read: records.read,
        delete: records.delete,
        write: () => Promise.reject(new Error("locked by another program")),
      },
    });
    const previousKey = await existingDevice(h);
    await signIn(h);
    const newKey = h.requests[0]?.body.device.publicKey;

    // A restart: a new store loads the keys from disk, and the record in
    // memory is gone.
    const restarted = harness();
    await restarted.keyStore.load();
    expect(await restarted.flow.start()).toEqual({
      started: false,
      outcome: { kind: "failed", reason: "replacement_pending" },
    });
    expect(restarted.opened).toEqual([]);
    expect(restarted.requests).toEqual([]);
    expect(await restarted.keyStore.hasKey()).toBe(true);
    expect(restarted.keyStore.keys()?.current.publicKey).toBe(newKey);
    expect(restarted.keyStore.keys()?.previous?.publicKey).toBe(previousKey);
  }, 20_000);

  test("after a stop between the record write and the confirmation, confirms and signs in as the same device", async () => {
    const h = harness();
    await existingDevice(h);
    // The flow wrote the record with the new key after a 200 and stopped
    // before it confirmed the replacement.
    const keys = await h.keyStore.replace();
    await h.records.write({ ...ANSWER, publicKey: keys.current.publicKey });

    const restarted = harness();
    await restarted.keyStore.load();
    expect(restarted.keyStore.keys()?.previous).not.toBeNull();
    const { outcome, authorizeUrl } = await signIn(restarted);

    expect(authorizeParams(authorizeUrl).get("login")).toBe("octocat");
    const device = restarted.requests[0]?.body.device;
    if (device?.kind !== "existing") {
      throw new Error("expected an existing device");
    }
    expect(device.deviceId).toBe(DEVICE_ID);
    expect(device).not.toHaveProperty("previousDeviceId");
    // The confirmed key signed as the device's current key.
    expect(
      verifies(
        keys.current.publicKey,
        {
          purpose: "sign-in",
          audience: API_ORIGIN,
          signInCode: SIGN_IN_CODE,
          deviceId: DEVICE_ID,
          newPublicKey: device.publicKey,
        },
        device.currentKeySignature,
      ),
    ).toBe(true);
    expect(outcome).toMatchObject({ kind: "signed_in", newDevice: false });
    expect(restarted.keyStore.keys()?.previous).toBeNull();
  }, 20_000);

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
    expect(await h.records.read()).toEqual({
      kind: "record",
      record: { ...ANSWER, publicKey: device.publicKey },
    });
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

  test("signs nothing when the previous key is not the record's key after the replacement", async () => {
    const h = harness();
    const recordKey = await existingDevice(h);
    const start = started(await h.flow.start());
    // The key store changes while the attempt waits for the code.
    await h.keyStore.replace();
    await h.keyStore.confirmReplacement();
    const changed = h.keyStore.keys()?.current.publicKey;
    expect(changed).not.toBe(recordKey);
    await deliverCode(h.opened.at(-1) ?? "");

    expect(await start.outcome).toEqual({
      kind: "failed",
      reason: "key_changed",
    });
    expect(h.requests).toEqual([]);
    // The replacement is abandoned: the store holds what it held before.
    expect(h.keyStore.keys()?.current.publicKey).toBe(changed);
    expect(h.keyStore.keys()?.previous).toBeNull();
    expect(h.errors).toContain("The device key changed during the sign-in.");
  }, 20_000);
});

describe("answers of the API", () => {
  test.each(["sign_in_required", "conflict", "bad_request"] as const)(
    "abandons the replacement on a 4xx answer with %s",
    async (code) => {
      const h = harness();
      const previousKey = await existingDevice(h);
      h.answer = () => errorAnswer(code);
      const { outcome } = await signIn(h);

      expect(outcome).toEqual({ kind: "refused", code });
      const keys = h.keyStore.keys();
      expect(keys?.current.publicKey).toBe(previousKey);
      expect(keys?.previous).toBeNull();
      expect(await h.records.read()).toEqual({
        kind: "record",
        record: { ...RECORD, publicKey: previousKey },
      });
    },
    20_000,
  );

  test.each(UNCERTAIN_REFUSAL_CODES)(
    "keeps the replacement pending on %s",
    async (code) => {
      const h = harness();
      const previousKey = await existingDevice(h);
      h.answer = () => errorAnswer(code);
      const { outcome } = await signIn(h);

      expect(outcome).toEqual({
        kind: "failed",
        reason: "uncertain_refusal",
        apiError: code,
      });
      const keys = h.keyStore.keys();
      expect(keys?.previous?.publicKey).toBe(previousKey);
      expect(keys?.current.publicKey).toBe(
        h.requests[0]?.body.device.publicKey,
      );
      expect(await h.records.read()).toEqual({
        kind: "record",
        record: { ...RECORD, publicKey: previousKey },
      });
    },
    20_000,
  );

  test("keeps the key that the API holds when a resent copy of a committed request gets 409 with sign_in_code_used (#152)", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    const api = fakeApi(previousKey);
    const statuses: number[] = [];
    // The fetch delivers the request twice, as `net.fetch` or a proxy can
    // after the connection failed: the first copy commits but its answer is
    // lost, and only the answer to the second copy arrives.
    h.answer = (body) => {
      api.handle(body);
      const answer = api.handle(body);
      statuses.push(answer.status);
      return answer;
    };
    const { outcome } = await signIn(h);

    expect(statuses).toEqual([409]);
    expect(api.commits()).toBe(1);
    expect(outcome).toEqual({
      kind: "failed",
      reason: "uncertain_refusal",
      apiError: "sign_in_code_used",
    });
    // The replacement stays pending, with the key that the API holds.
    const keys = h.keyStore.keys();
    expect(keys?.current.publicKey).toBe(api.publicKey());
    expect(keys?.previous?.publicKey).toBe(previousKey);
    expect(await h.records.read()).toEqual({
      kind: "record",
      record: { ...RECORD, publicKey: previousKey },
    });
  }, 20_000);

  test("keeps the key that the API holds when a resent copy of a committed request gets auth_failed", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    const api = fakeApi(previousKey);
    // The fetch delivers the request twice, as `net.fetch` or a proxy can
    // after the connection failed: the first copy commits but its answer is
    // lost, and only the answer to the second copy arrives. The API
    // restarted in between and lost its record of the code (#152).
    h.answer = (body) => {
      api.handle(body);
      api.restart();
      return api.handle(body);
    };
    const { outcome } = await signIn(h);
    const newKey = h.requests[0]?.body.device.publicKey;

    expect(api.commits()).toBe(1);
    expect(api.publicKey()).toBe(newKey);
    // The replacement stays pending: the key that the API holds is kept,
    // next to the previous key, and the record still names the previous key.
    const keys = h.keyStore.keys();
    expect(keys?.current.publicKey).toBe(api.publicKey());
    expect(keys?.previous?.publicKey).toBe(previousKey);
    expect(await h.records.read()).toEqual({
      kind: "record",
      record: { ...RECORD, publicKey: previousKey },
    });
    expect(outcome).toEqual({
      kind: "failed",
      reason: "uncertain_refusal",
      apiError: "auth_failed",
    });

    // Both keys are on disk, and the next start deletes neither.
    const restarted = harness();
    await restarted.keyStore.load();
    expect(await restarted.flow.start()).toEqual({
      started: false,
      outcome: { kind: "failed", reason: "replacement_pending" },
    });
    expect(restarted.keyStore.keys()?.current.publicKey).toBe(api.publicKey());
    expect(restarted.keyStore.keys()?.previous?.publicKey).toBe(previousKey);
  }, 20_000);

  test("keeps the replacement pending on a 5xx answer, even with an error body", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    h.answer = () => json(500, SERVER_ERROR);
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({ kind: "failed", reason: "server_error" });
    const keys = h.keyStore.keys();
    expect(keys?.previous?.publicKey).toBe(previousKey);
    expect(keys?.current.publicKey).toBe(h.requests[0]?.body.device.publicKey);
  }, 20_000);

  test("a cancel while the request is in flight keeps the replacement pending", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    let cancel: () => void = () => undefined;
    h.answer = () =>
      new Promise<Response>((_resolve, reject) => {
        const signal = h.requests[0]?.init.signal;
        signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        cancel();
      });
    const start = started(await h.flow.start());
    cancel = start.cancel;
    const params = authorizeParams(h.opened[0] ?? "");
    const form = new URLSearchParams({
      code: SIGN_IN_CODE,
      state: params.get("state") ?? "",
    }).toString();
    expect(await postForm(params.get("redirect_uri") ?? "", form)).toBe(200);
    expect(await start.outcome).toEqual({ kind: "cancelled" });
    expect(h.requests).toHaveLength(1);
    expect(h.keyStore.keys()?.previous?.publicKey).toBe(previousKey);
    expect(await h.records.read()).toEqual({
      kind: "record",
      record: { ...RECORD, publicKey: previousKey },
    });
  }, 20_000);

  test("does not read an answer larger than the limit", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    let pulled = 0;
    h.answer = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(16 * 1024).fill(32));
            if (pulled > 100) {
              controller.close();
            }
          },
        }),
        { status: 200 },
      );
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({ kind: "failed", reason: "unexpected_response" });
    expect(pulled).toBeLessThan(10);
    expect(h.keyStore.keys()?.previous?.publicKey).toBe(previousKey);
  }, 20_000);

  test("refuses a Content-Length over the limit before reading", async () => {
    const h = harness();
    await existingDevice(h);
    h.answer = () =>
      new Response(JSON.stringify(ANSWER), {
        status: 200,
        headers: { "content-length": String(MAX_ANSWER_BYTES + 1) },
      });
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({ kind: "failed", reason: "unexpected_response" });
    expect(h.keyStore.keys()?.previous).not.toBeNull();
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
    expect(await h.records.read()).toEqual({
      kind: "record",
      record: { ...RECORD, publicKey: previousKey },
    });
  }, 20_000);

  test("keeps the replacement pending for an answer that is not the API's", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    h.answer = () => new Response("<html>Not Found</html>", { status: 404 });
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
    h.answer = () => errorAnswer("device_registration_locked");
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({
      kind: "refused",
      code: "device_registration_locked",
    });
    expect(await h.keyStore.hasKey()).toBe(false);
    expect(await h.records.read()).toEqual({ kind: "none" });
  }, 20_000);

  test("does not trust a 200 answer outside the format", async () => {
    const h = harness();
    const previousKey = await existingDevice(h);
    h.answer = () => json(200, { ...ANSWER, login: "octo cat" });
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({ kind: "failed", reason: "unexpected_response" });
    expect(h.keyStore.keys()?.previous).not.toBeNull();
    expect(await h.records.read()).toEqual({
      kind: "record",
      record: { ...RECORD, publicKey: previousKey },
    });
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

  test("shows the URL when opening the browser does not finish in time", async () => {
    const h = harness();
    h.openResult = () => new Promise<boolean>(() => undefined);
    const pending = h.flow.start();
    const timer = await waitForTimer(h, OPEN_EXTERNAL_TIMEOUT_MS);
    timer.callback();
    const start = started(await pending);
    if (start.opened) {
      throw new Error("expected opened: false");
    }
    expect(start.authorizeUrl).toBe(h.opened[0]);
    expect(start.warning).toBe(SIGN_IN_URL_WARNING);
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
  /** A fake `safeStorage` whose system protection the test switches. */
  function switchableSafeStorage() {
    const state = { available: true, backend: "unknown" };
    const systemProtection: SystemKeyProtection = {
      ...fakeSafeStorage,
      isAsyncEncryptionAvailable: () => Promise.resolve(state.available),
      getSelectedStorageBackend: () => state.backend,
    };
    return { state, systemProtection };
  }

  test("refuses a new device before the browser opens when the system cannot protect its key", async () => {
    const { state, systemProtection } = switchableSafeStorage();
    state.available = false;
    const h = harness({
      keyStore: createDeviceKeyStore({
        folder,
        platform: "win32",
        systemProtection,
      }),
    });

    expect(await h.flow.start()).toEqual({
      started: false,
      outcome: { kind: "failed", reason: "system_protection_unavailable" },
    });
    expect(h.opened).toEqual([]);
    expect(h.timers).toEqual([]);
    expect(await h.keyStore.hasKey()).toBe(false);

    // The flow can start once the system protects keys again.
    state.available = true;
    const again = started(await h.flow.start());
    again.cancel();
    expect(await again.outcome).toEqual({ kind: "cancelled" });
  });

  test("refuses a Linux device without a secret service early, unless the person chose a passphrase", async () => {
    const { state, systemProtection } = switchableSafeStorage();
    state.backend = "basic_text";
    const h = harness({
      platform: "linux",
      keyStore: createDeviceKeyStore({
        folder,
        platform: "linux",
        systemProtection,
      }),
    });

    expect(await h.flow.start()).toEqual({
      started: false,
      outcome: { kind: "failed", reason: "system_protection_unavailable" },
    });
    expect(h.opened).toEqual([]);

    const chosen = started(
      await h.flow.start({
        newKeyProtection: { kind: "passphrase", passphrase: "correct horse" },
      }),
    );
    expect(h.opened).toHaveLength(1);
    chosen.cancel();
    await chosen.outcome;
  });

  test("refuses to replace a key that the system protects when the system no longer can, and keeps it", async () => {
    const { state, systemProtection } = switchableSafeStorage();
    const keyStore = createDeviceKeyStore({
      folder,
      platform: "win32",
      systemProtection,
    });
    const h = harness({ keyStore });
    const previousKey = (await keyStore.create({ kind: "system" })).publicKey;
    await h.records.write({ ...RECORD, publicKey: previousKey });
    state.available = false;

    expect(await h.flow.start()).toEqual({
      started: false,
      outcome: { kind: "failed", reason: "system_protection_unavailable" },
    });
    expect(h.opened).toEqual([]);
    expect(keyStore.keys()?.current.publicKey).toBe(previousKey);
    expect(keyStore.keys()?.previous).toBeNull();
  });

  test("reports the store's error code when the key cannot be created after the code arrived", async () => {
    const { state, systemProtection } = switchableSafeStorage();
    const h = harness({
      keyStore: createDeviceKeyStore({
        folder,
        platform: "win32",
        systemProtection,
      }),
    });
    const start = started(await h.flow.start());
    // The system's protection went away while the browser was open.
    state.available = false;
    await deliverCode(h.opened.at(-1) ?? "");

    expect(await start.outcome).toEqual({
      kind: "failed",
      reason: "key_store_failed",
      keyError: "system_protection_unavailable",
    });
    expect(h.requests).toEqual([]);
  }, 20_000);
});

describe("the callback", () => {
  test("calls onCallback once the listener accepted the code, before the request", async () => {
    const h = harness();
    const steps: string[] = [];
    h.answer = () => {
      steps.push("request");
      return json(200, ANSWER);
    };
    const start = started(
      await h.flow.start({ onCallback: () => steps.push("callback") }),
    );
    expect(steps).toEqual([]);
    await deliverCode(h.opened.at(-1) ?? "");

    expect(await start.outcome).toMatchObject({ kind: "signed_in" });
    expect(steps).toEqual(["callback", "request"]);
  }, 20_000);

  test("calls onCallback for an error that the API's page posted, and never after a cancel or the timeout", async () => {
    const h = harness();
    let calls = 0;
    const onCallback = () => {
      calls += 1;
    };

    const posted = started(await h.flow.start({ onCallback }));
    const params = authorizeParams(h.opened.at(-1) ?? "");
    await postForm(
      params.get("redirect_uri") ?? "",
      new URLSearchParams({
        error: "access_denied",
        state: params.get("state") ?? "",
      }).toString(),
    );
    expect(await posted.outcome).toMatchObject({ kind: "listener_error" });
    expect(calls).toBe(1);

    const cancelled = started(await h.flow.start({ onCallback }));
    cancelled.cancel();
    expect(await cancelled.outcome).toEqual({ kind: "cancelled" });

    const timedOut = started(await h.flow.start({ onCallback }));
    h.timers
      .find((entry) => entry.delayMs === SIGN_IN_LISTENER_TIMEOUT_MS)
      ?.callback();
    expect(await timedOut.outcome).toEqual({ kind: "timed_out" });
    expect(calls).toBe(1);
  }, 20_000);

  test("a callback that throws changes nothing", async () => {
    const h = harness();
    const start = started(
      await h.flow.start({
        onCallback: () => {
          throw new Error("no window");
        },
      }),
    );
    await deliverCode(h.opened.at(-1) ?? "");

    expect(await start.outcome).toMatchObject({ kind: "signed_in" });
    expect(h.errors).toEqual([]);
  }, 20_000);
});

describe("reset", () => {
  test("drops the account mismatch, so the next attempt is a plain repeat", async () => {
    const h = harness();
    await existingDevice(h);
    h.answer = () => errorAnswer("device_account_mismatch");
    await signIn(h);

    expect(h.flow.reset()).toBe(true);
    const next = started(await h.flow.start());
    const params = authorizeParams(h.opened.at(-1) ?? "");
    expect(params.has("prompt")).toBe(false);
    expect(params.get("login")).toBe("octocat");
    next.cancel();
    await next.outcome;
  }, 20_000);

  test("drops an unsaved record, so it is never written for a forgotten account", async () => {
    const records = createDeviceRecordStore({ folder, platform: "win32" });
    let failing = true;
    const h = harness({
      deviceRecords: {
        read: records.read,
        delete: records.delete,
        write: (record) =>
          failing
            ? Promise.reject(new Error("disk full"))
            : records.write(record),
      },
    });
    const { outcome } = await signIn(h);
    expect(outcome).toEqual({ kind: "failed", reason: "record_not_saved" });

    // "This is not me" deletes the key and resets the flow.
    await h.keyStore.delete();
    expect(h.flow.reset()).toBe(true);
    failing = false;
    const next = started(await h.flow.start());

    expect(await records.read()).toEqual({ kind: "none" });
    expect(authorizeParams(h.opened.at(-1) ?? "").get("prompt")).toBe(
      "select_account",
    );
    next.cancel();
    await next.outcome;
  }, 20_000);

  test("changes nothing while an attempt runs", async () => {
    const h = harness();
    const start = started(await h.flow.start());

    expect(h.flow.reset()).toBe(false);
    start.cancel();
    await start.outcome;
    expect(h.flow.reset()).toBe(true);
  });
});

describe("unexpected errors", () => {
  test("an error that the flow did not expect is unexpected, not a key store failure", async () => {
    const timers: { delayMs: number; callback: () => void }[] = [];
    const h = harness({
      // The clock fails when the request is about to be sent.
      scheduleTimer: (callback, delayMs) => {
        if (delayMs === SIGN_IN_REQUEST_TIMEOUT_MS) {
          throw new Error("clock");
        }
        timers.push({ delayMs, callback });
        return () => undefined;
      },
    });
    const { outcome } = await signIn(h);

    expect(outcome).toEqual({ kind: "failed", reason: "unexpected" });
    expect(h.requests).toEqual([]);
    expect(h.errors).toEqual(["The sign-in failed unexpectedly."]);
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
      () => errorAnswer("sign_in_required"),
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

    // The private keys, as the store handed them to safeStorage, appear
    // neither in an outcome or a message nor in the record file.
    expect(encryptedPlainTexts.length).toBeGreaterThan(0);
    const recordFile = await readFile(
      path.join(folder, DEVICE_RECORD_FILE),
      "utf8",
    );
    for (const plainText of encryptedPlainTexts) {
      const pkcs8 = Buffer.from(plainText, "base64");
      const seed = pkcs8.subarray(pkcs8.length - 32);
      for (const form of [
        plainText,
        pkcs8.toString("hex"),
        seed.toString("hex"),
        seed.toString("base64"),
        seed.toString("base64url"),
      ]) {
        expect(shown).not.toContain(form);
        expect(recordFile).not.toContain(form);
      }
    }
  }, 40_000);
});
