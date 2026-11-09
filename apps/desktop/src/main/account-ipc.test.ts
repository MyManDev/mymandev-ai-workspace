import { createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  API_ERROR_STATUS,
  type ApiErrorCode,
  deviceAuthInput,
  type DeviceId,
  newUuidV7,
  SignInRequestSchema,
  type UserId,
} from "@mymandev/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type {
  AccountStatus,
  ConnectionStatus,
} from "../shared/ipc-contract.ts";
import {
  createAccountService,
  SIGN_IN_START_COOLDOWN_MS,
  type AccountService,
} from "./account.ts";
import { registerAccountIpc } from "./account-ipc.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import { registerDeviceIpc } from "./device-ipc.ts";
import {
  createDeviceListService,
  DEVICE_LIST_LOAD_COOLDOWN_MS,
  type DeviceListConnection,
  type DeviceListService,
  type DeviceListState,
} from "./devices/service.ts";
import {
  createDeviceKeyStore,
  type DeviceKeyStore,
  type SystemKeyProtection,
} from "./device-key/store.ts";
import {
  createDeviceRecordStore,
  type DeviceRecordStore,
} from "./device-record.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import type { ScheduleTimer } from "./runtime.ts";
import { createDeviceSession } from "./session/session.ts";
import { createSessionNotesStore } from "./session/session-notes.ts";
import { createSignOutMarkerStore } from "./session/sign-out-marker.ts";
import { createSignInFlow } from "./sign-in/flow.ts";
import { createRegistrationMarkerStore } from "./sign-in/registration-marker.ts";

const DEV_URL = "http://localhost:5173/";
const PASSPHRASE = "correct horse battery staple";

const STATUS: AccountStatus = Object.freeze({
  revision: 1,
  account: Object.freeze({ kind: "signed_out" }),
  signIn: Object.freeze({ kind: "idle" }),
  lastOutcome: null,
  deviceKey: "passphrase_required",
  replacementPending: false,
  apiOrigin: "set",
  device: "key_not_loaded",
});

function frame(url: string, parent: IpcFrame | null = null): IpcFrame {
  return { url, parent, detached: false, isDestroyed: () => false };
}

function receiver(url: string = DEV_URL) {
  const sent: unknown[][] = [];
  const value: StatusReceiver & { sent: unknown[][] } = {
    mainFrame: frame(url),
    sent,
    isDestroyed: () => false,
    send: (channel, ...args) => {
      sent.push([channel, ...args]);
    },
    once: () => undefined,
  };
  return value;
}

function event(
  senderFrame: IpcFrame | null,
  sender: StatusReceiver = receiver(),
): IpcInvokeEvent {
  return { senderFrame, sender };
}

type AccountPart = Parameters<typeof registerAccountIpc>[2];

/** A service that records its calls and answers fixed values. */
function fakeService() {
  const calls: { method: string; args: unknown[] }[] = [];
  const listeners: ((status: AccountStatus) => void)[] = [];
  const service: AccountPart = {
    status: () => {
      calls.push({ method: "status", args: [] });
      return STATUS;
    },
    onStatusChange: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    startSignIn: async (options) => {
      calls.push({
        method: "startSignIn",
        args: options === undefined ? [] : [options],
      });
      return { outcome: "started" };
    },
    cancelSignIn: () => {
      calls.push({ method: "cancelSignIn", args: [] });
      return true;
    },
    unlockDeviceKey: async (passphrase) => {
      calls.push({ method: "unlockDeviceKey", args: [passphrase] });
      return { outcome: "refused", reason: "wrong_passphrase" };
    },
    forgetAccount: async () => {
      calls.push({ method: "forgetAccount", args: [] });
      return { outcome: "forgotten", removedAtServer: true };
    },
    signOut: async () => {
      calls.push({ method: "signOut", args: [] });
      return { outcome: "pending" };
    },
    removeDevice: async () => {
      calls.push({ method: "removeDevice", args: [] });
      return { outcome: "failed", reason: "no_answer" };
    },
  };
  return {
    service,
    calls,
    change: (status: AccountStatus) => {
      for (const listener of listeners) {
        listener(status);
      }
    },
  };
}

function register(service: AccountPart) {
  const handlers = new Map<string, IpcInvokeListener>();
  const errors: unknown[] = [];
  registerAccountIpc(
    {
      handle: (channel, listener) => {
        expect(handlers.has(channel)).toBe(false);
        handlers.set(channel, listener);
      },
    },
    DEV_URL,
    service,
    (message, error) => errors.push(message, error),
  );
  const call = (
    channel: string,
    ipcEvent: IpcInvokeEvent,
    ...args: unknown[]
  ): unknown => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`no handler for ${channel}`);
    }
    return handler(ipcEvent, ...args);
  };
  return { handlers, call, errors };
}

/** A connection that stays offline and receives nothing. */
const OFFLINE_CONNECTION: DeviceListConnection = Object.freeze({
  status: (): ConnectionStatus => ({ state: "offline", revision: 0 }),
  onStatusChange: () => () => undefined,
  onMessage: () => () => undefined,
});

/**
 * Registers the device list channels over `devices`, with publishes on a
 * microtask, and returns a call that answers like the account channels.
 */
function registerDevices(devices: DeviceListService) {
  const handlers = new Map<string, IpcInvokeListener>();
  registerDeviceIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    DEV_URL,
    {
      devices,
      scheduleTimer: (callback) => {
        let active = true;
        queueMicrotask(() => {
          if (active) {
            callback();
          }
        });
        return () => {
          active = false;
        };
      },
    },
  );
  return (
    channel: string,
    ipcEvent: IpcInvokeEvent,
    ...args: unknown[]
  ): unknown => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`no handler for ${channel}`);
    }
    return handler(ipcEvent, ...args);
  };
}

/** Resolves with the first device list state, the current one included, that `accept` takes. */
function deviceListWhen(
  devices: DeviceListService,
  accept: (state: DeviceListState) => boolean,
): Promise<DeviceListState> {
  return new Promise((resolve) => {
    if (accept(devices.state())) {
      resolve(devices.state());
      return;
    }
    const stop = devices.onChange((state) => {
      if (accept(state)) {
        stop();
        resolve(state);
      }
    });
  });
}

const ACCOUNT_CHANNELS = Object.values(INVOKE_CHANNELS).filter((channel) =>
  channel.startsWith("account:"),
);

test("a handler is registered for every account channel and nothing else", () => {
  const { handlers } = register(fakeService().service);

  // The device list has channels of its own (device-ipc.ts).
  expect(ACCOUNT_CHANNELS).toHaveLength(8);
  expect(ACCOUNT_CHANNELS).not.toContain("account:list-devices");
  expect([...handlers.keys()].sort()).toEqual([...ACCOUNT_CHANNELS].sort());
});

test("every account handler refuses a foreign sender before anything runs", () => {
  const fake = fakeService();
  const { call } = register(fake.service);
  const subscriber = receiver("https://example.com/");

  for (const channel of ACCOUNT_CHANNELS) {
    for (const senderFrame of [
      frame("https://example.com/"),
      frame(APP_ENTRY_URL),
      frame("file:///home/user/evil.html"),
      frame(DEV_URL, frame(DEV_URL)),
      null,
    ]) {
      const args =
        channel === INVOKE_CHANNELS.unlockDeviceKey ? [PASSPHRASE] : [];
      expect(() =>
        call(channel, event(senderFrame, subscriber), ...args),
      ).toThrow(
        `The call on ${channel} was refused: the sender is not the application.`,
      );
    }
  }
  fake.change({ ...STATUS, revision: 2 });

  expect(fake.calls).toEqual([]);
  expect(subscriber.sent).toEqual([]);
});

test("every account handler refuses arguments that break the contract, without naming them", () => {
  const fake = fakeService();
  const { call } = register(fake.service);

  for (const channel of ACCOUNT_CHANNELS) {
    const argumentLists: unknown[][] =
      channel === INVOKE_CHANNELS.unlockDeviceKey
        ? [
            [],
            [""],
            [`${PASSPHRASE}${"x".repeat(5000)}`],
            [PASSPHRASE, "extra"],
            [1],
            [null],
            [{ passphrase: PASSPHRASE }],
          ]
        : [
            [PASSPHRASE],
            [{ login: "octocat" }],
            [undefined],
            [1, 2],
            [{ browser: "chrome" }],
            [{ browser: "other", login: "octocat" }],
            [{ browser: "other" }, "extra"],
            [{}],
          ];
    for (const args of argumentLists) {
      let refusal: unknown;
      try {
        call(channel, event(frame(DEV_URL)), ...args);
      } catch (error) {
        refusal = error;
      }
      expect(String(refusal)).toBe(
        `IpcRefusedError: The call on ${channel} was refused: the arguments do not match the contract.`,
      );
    }
  }
  expect(fake.calls).toEqual([]);
});

test("the handlers answer with the service's values, and unlock passes the passphrase to the service only", async () => {
  const fake = fakeService();
  const { call } = register(fake.service);
  const app = event(frame(DEV_URL));

  expect(call(INVOKE_CHANNELS.getAccountStatus, app)).toEqual(STATUS);
  await expect(call(INVOKE_CHANNELS.startSignIn, app)).resolves.toEqual({
    outcome: "started",
  });
  await expect(
    call(INVOKE_CHANNELS.startSignIn, app, { browser: "other" }),
  ).resolves.toEqual({ outcome: "started" });
  expect(call(INVOKE_CHANNELS.cancelSignIn, app)).toBe(true);
  const unlocked = await (call(
    INVOKE_CHANNELS.unlockDeviceKey,
    app,
    PASSPHRASE,
  ) as Promise<unknown>);
  await expect(call(INVOKE_CHANNELS.forgetAccount, app)).resolves.toEqual({
    outcome: "forgotten",
    removedAtServer: true,
  });
  await expect(call(INVOKE_CHANNELS.signOut, app)).resolves.toEqual({
    outcome: "pending",
  });
  await expect(call(INVOKE_CHANNELS.removeDevice, app)).resolves.toEqual({
    outcome: "failed",
    reason: "no_answer",
  });

  expect(unlocked).toEqual({ outcome: "refused", reason: "wrong_passphrase" });
  expect(JSON.stringify(unlocked)).not.toContain(PASSPHRASE);
  expect(fake.calls.map(({ method }) => method)).toEqual([
    "status",
    "startSignIn",
    "startSignIn",
    "cancelSignIn",
    "unlockDeviceKey",
    "forgetAccount",
    "signOut",
    "removeDevice",
  ]);
  expect(fake.calls[1]?.args).toEqual([]);
  expect(fake.calls[2]?.args).toEqual([{ browser: "other" }]);
  expect(fake.calls[4]?.args).toEqual([PASSPHRASE]);
});

test("subscribe answers with the status and sends every later one, parsed by the contract, to the subscribers only", () => {
  const fake = fakeService();
  const { call } = register(fake.service);
  const subscriber = receiver();
  const bystander = receiver();

  expect(
    call(
      INVOKE_CHANNELS.subscribeAccountStatus,
      event(frame(DEV_URL), subscriber),
    ),
  ).toEqual(STATUS);
  const next = {
    ...STATUS,
    revision: 2,
    deviceKey: "ready",
    passphrase: PASSPHRASE,
    codeVerifier: "verifier",
  } as AccountStatus;
  fake.change(next);

  expect(subscriber.sent).toEqual([
    [
      EVENT_CHANNELS.accountStatusChanged,
      { ...STATUS, revision: 2, deviceKey: "ready" },
    ],
  ]);
  expect(bystander.sent).toEqual([]);
});

test("a status that breaks the contract is not sent, and the failure is reported", () => {
  const fake = fakeService();
  const { call, errors } = register(fake.service);
  const subscriber = receiver();
  call(
    INVOKE_CHANNELS.subscribeAccountStatus,
    event(frame(DEV_URL), subscriber),
  );

  fake.change({ ...STATUS, revision: 2, deviceKey: "stolen" } as never);

  expect(subscriber.sent).toEqual([]);
  expect(errors[0]).toBe("Sending the account status failed.");
});

// The whole path with the real sign-in flow, key store, record store, and
// listener: nothing that reaches the renderer holds the sign-in code, the
// verifier, a signature, or key material.

const API_ORIGIN = "https://api.mymandev.example";
const SIGN_IN_CODE = "mmdc_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
const SECOND_CODE = "mmdc_QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY";
const MISMATCH_CODE = "mmdc_bWlzbWF0Y2gtbWlzbWF0Y2gtbWlzbWF0Y2gtbWlzbWE";
const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3" as DeviceId;
const USER_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4" as UserId;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mymandev-account-ipc-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * The real device session over the key store and the record store of a
 * test, with its own `fetch`; offline unless the test passes one.
 */
function sessionOver(
  folder: string,
  keyStore: DeviceKeyStore,
  deviceRecords: DeviceRecordStore,
  fetch: (url: string, init: RequestInit) => Promise<Response> = () =>
    Promise.reject(new TypeError("offline")),
) {
  return createDeviceSession({
    apiOrigin: { ok: true, origin: API_ORIGIN },
    keyStore,
    deviceRecords,
    signOutMarkers: createSignOutMarkerStore({ folder, platform: "win32" }),
    sessionNotes: createSessionNotesStore({ folder, platform: "win32" }),
    fetch,
    scheduleTimer: () => () => undefined,
  });
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

function idleWithOutcome(
  service: AccountService,
  revisionAbove: number,
): Promise<AccountStatus> {
  return new Promise((resolve) => {
    const end = service.onStatusChange((status) => {
      if (
        status.revision > revisionAbove &&
        status.signIn.kind === "idle" &&
        status.lastOutcome !== null
      ) {
        end();
        resolve(status);
      }
    });
  });
}

test("a new and a repeated sign-in through IPC send no code, verifier, signature, or key to the renderer", async () => {
  const folder = path.join(root, "MyManDev");
  const encrypted: string[] = [];
  const safeStorage: SystemKeyProtection = {
    isAsyncEncryptionAvailable: () => Promise.resolve(true),
    getSelectedStorageBackend: () => "unknown",
    encryptStringAsync: (plainText) => {
      encrypted.push(plainText);
      return Promise.resolve(Buffer.from(`fake:${plainText}`, "utf8"));
    },
    decryptStringAsync: (ciphertext) =>
      Promise.resolve({
        shouldReEncrypt: false,
        result: ciphertext.toString("utf8").slice("fake:".length),
      }),
  };
  const keyStore = createDeviceKeyStore({
    folder,
    platform: "win32",
    systemProtection: safeStorage,
  });
  const records = createDeviceRecordStore({ folder, platform: "win32" });
  const bodies: string[] = [];
  /** How often the window came up when each request was sent. */
  const focusedAtRequest: number[] = [];
  const errors: string[] = [];
  // The listener's 10 minutes and the request timeout never fire here.
  const scheduleTimer: ScheduleTimer = () => () => undefined;
  let focused = 0;
  let clock = 0;
  const service = createAccountService({
    apiOrigin: { ok: true, origin: API_ORIGIN },
    openSystem: () => ({
      keyStore,
      deviceRecords: records,
      registrationMarkers: createRegistrationMarkerStore({
        folder,
        platform: "win32",
      }),
      createFlow: () =>
        createSignInFlow({
          apiOrigin: { ok: true, origin: API_ORIGIN },
          keyStore,
          deviceRecords: records,
          registrationMarkers: createRegistrationMarkerStore({
            folder,
            platform: "win32",
          }),
          // The browser does not open, so the URL to copy is sent too.
          openExternal: async () => false,
          fetch: async (_url, init) => {
            const body = String(init.body);
            SignInRequestSchema.parse(JSON.parse(body));
            bodies.push(body);
            focusedAtRequest.push(focused);
            return new Response(
              JSON.stringify({
                userId: USER_ID,
                deviceId: DEVICE_ID,
                displayName: "The Octocat",
                login: "octocat",
                signInExpiresAt: "2026-12-02T10:00:00.000Z",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
          platform: "win32",
          scheduleTimer,
          listenerConnectionTimeoutMs: 2_000,
          onError: (message) => errors.push(message),
        }),
      // The session is offline: "This is not me" is then local only.
      createSession: () => sessionOver(folder, keyStore, records),
    }),
    focusWindow: () => {
      focused += 1;
    },
    confirmForget: async () => true,
    confirmRemoveDevice: async () => true,
    confirmRevokeDevice: async () => false,
    confirmLiftRegistrationLock: async () => false,
    now: () => clock,
    onError: (message) => errors.push(message),
  });
  const { call } = register(service);
  const subscriber = receiver();
  const app = () => event(frame(DEV_URL), subscriber);
  const answers: unknown[] = [];
  const invoke = async (channel: string, ...args: unknown[]) => {
    const answer = await call(channel, app(), ...args);
    answers.push(answer);
    return answer;
  };

  answers.push(call(INVOKE_CHANNELS.subscribeAccountStatus, app()));
  await service.initialize();

  for (const code of [SIGN_IN_CODE, SECOND_CODE]) {
    clock += SIGN_IN_START_COOLDOWN_MS;
    const before = service.status().revision;
    await expect(invoke(INVOKE_CHANNELS.startSignIn)).resolves.toEqual({
      outcome: "started",
    });
    const waiting = (await invoke(
      INVOKE_CHANNELS.getAccountStatus,
    )) as AccountStatus;
    if (waiting.signIn.kind !== "waiting" || waiting.signIn.opened) {
      throw new Error("expected a sign-in that waits with the URL to copy");
    }
    expect(focused).toBe(bodies.length);
    const query = new URL(waiting.signIn.authorizeUrl).searchParams;
    const done = idleWithOutcome(service, before);
    expect(
      await postForm(
        query.get("redirect_uri") ?? "",
        new URLSearchParams({
          code,
          state: query.get("state") ?? "",
        }).toString(),
      ),
    ).toBe(200);
    expect((await done).lastOutcome).toEqual({ code: "signed_in" });
  }
  await invoke(INVOKE_CHANNELS.getAccountStatus);
  await expect(invoke(INVOKE_CHANNELS.forgetAccount)).resolves.toEqual({
    outcome: "forgotten",
    removedAtServer: false,
  });

  expect(focused).toBe(2);
  // The window came up after the browser's post, before each request.
  expect(focusedAtRequest).toEqual([1, 2]);
  const kinds = subscriber.sent.map(
    ([, status]) => (status as AccountStatus).signIn.kind,
  );
  // Each sign-in moved to completing once; the device state of the session
  // may change while it completes.
  expect(
    kinds.filter(
      (kind, index) => kind === "completing" && kinds[index - 1] !== kind,
    ),
  ).toHaveLength(2);
  expect(errors).toEqual([
    "The system browser could not be opened.",
    "The system browser could not be opened.",
  ]);
  const requests = bodies.map((body) =>
    SignInRequestSchema.parse(JSON.parse(body)),
  );
  const second = requests[1]?.device;
  if (requests[0] === undefined || second?.kind !== "existing") {
    throw new Error("expected a new and then an existing device");
  }
  const secrets = [
    SIGN_IN_CODE,
    SECOND_CODE,
    ...requests.map((sent) => sent.codeVerifier),
    ...requests.map((sent) => sent.device.newKeySignature),
    second.currentKeySignature,
    ...requests.map((sent) => sent.device.publicKey),
    // The private keys as PKCS#8, as the store handed them to safeStorage.
    ...encrypted,
    ...encrypted.map((pkcs8) =>
      Buffer.from(pkcs8, "base64").toString("base64url"),
    ),
    ...encrypted.map((pkcs8) => Buffer.from(pkcs8, "base64").toString("hex")),
  ];
  expect(secrets.every((secret) => secret.length >= 32)).toBe(true);
  const sent = JSON.stringify([subscriber.sent, answers]);
  expect(subscriber.sent.length).toBeGreaterThanOrEqual(8);
  for (const secret of secrets) {
    expect(sent).not.toContain(secret);
  }
  expect(sent).not.toMatch(/mmdc_|mmda_|codeVerifier|Signature|pkcs8/i);
  // The status that the renderer saw after the sign-in.
  expect(answers.at(-2)).toMatchObject({
    account: {
      kind: "signed_in",
      login: "octocat",
      displayName: "The Octocat",
      deviceId: DEVICE_ID,
    },
  });
  // "This is not me" deleted the key files and the record.
  await expect(
    readFile(path.join(folder, "device-record.json")),
  ).rejects.toThrow();
  await expect(keyStore.hasKey()).resolves.toBe(false);
});

test("a This is not me whose key delete fails after an unsaved record never brings the account back", async () => {
  const folder = path.join(root, "MyManDev");
  const realKeys = createDeviceKeyStore({
    folder,
    platform: "win32",
    systemProtection: {
      isAsyncEncryptionAvailable: () => Promise.resolve(true),
      getSelectedStorageBackend: () => "unknown",
      encryptStringAsync: (plainText) =>
        Promise.resolve(Buffer.from(`fake:${plainText}`, "utf8")),
      decryptStringAsync: (ciphertext) =>
        Promise.resolve({
          shouldReEncrypt: false,
          result: ciphertext.toString("utf8").slice("fake:".length),
        }),
    },
  });
  const realRecords = createDeviceRecordStore({ folder, platform: "win32" });
  let failRecordWrites = false;
  let failKeyDelete = false;
  const records: DeviceRecordStore = {
    read: realRecords.read,
    delete: realRecords.delete,
    write: (record) =>
      failRecordWrites
        ? Promise.reject(new Error("disk full"))
        : realRecords.write(record),
  };
  const keyStore: DeviceKeyStore = {
    ...realKeys,
    delete: () =>
      failKeyDelete ? Promise.reject(new Error("EBUSY")) : realKeys.delete(),
  };
  // The installation holds the account that is not the person's.
  const key = await realKeys.create({ kind: "system" });
  await realRecords.write({
    deviceId: DEVICE_ID,
    userId: USER_ID,
    login: "octocat",
    displayName: "The Octocat",
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
    publicKey: key.publicKey,
  });
  const opened: string[] = [];
  let clock = 0;
  const service = createAccountService({
    apiOrigin: { ok: true, origin: API_ORIGIN },
    openSystem: () => ({
      keyStore,
      deviceRecords: records,
      registrationMarkers: createRegistrationMarkerStore({
        folder,
        platform: "win32",
      }),
      createFlow: () =>
        createSignInFlow({
          apiOrigin: { ok: true, origin: API_ORIGIN },
          keyStore,
          deviceRecords: records,
          registrationMarkers: createRegistrationMarkerStore({
            folder,
            platform: "win32",
          }),
          openExternal: async (url) => {
            opened.push(url);
            return true;
          },
          fetch: async () =>
            new Response(
              JSON.stringify({
                userId: USER_ID,
                deviceId: DEVICE_ID,
                displayName: "The Octocat",
                login: "octocat",
                signInExpiresAt: "2026-12-02T10:00:00.000Z",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          platform: "win32",
          scheduleTimer: () => () => undefined,
          listenerConnectionTimeoutMs: 2_000,
        }),
      createSession: () => sessionOver(folder, keyStore, records),
    }),
    focusWindow: () => undefined,
    confirmForget: async () => true,
    confirmRemoveDevice: async () => true,
    confirmRevokeDevice: async () => false,
    confirmLiftRegistrationLock: async () => false,
    now: () => clock,
  });
  await service.initialize();
  expect(service.status().account).toMatchObject({ login: "octocat" });

  // A repeated sign-in gets a 200, but both record writes fail: the flow
  // keeps the record in memory for its next attempt.
  failRecordWrites = true;
  const before = service.status().revision;
  await expect(service.startSignIn()).resolves.toEqual({ outcome: "started" });
  const repeated = new URL(opened.at(-1) ?? "").searchParams;
  expect(repeated.get("login")).toBe("octocat");
  const unsaved = idleWithOutcome(service, before);
  await postForm(
    repeated.get("redirect_uri") ?? "",
    new URLSearchParams({
      code: SIGN_IN_CODE,
      state: repeated.get("state") ?? "",
    }).toString(),
  );
  expect((await unsaved).lastOutcome).toEqual({ code: "record_not_saved" });

  // "This is not me" deletes the record, and then the key delete fails.
  failKeyDelete = true;
  await expect(service.forgetAccount()).resolves.toEqual({
    outcome: "failed",
  });
  expect(service.status().account).toEqual({ kind: "signed_out" });

  // The next sign-in is a first sign-in: the unsaved record of the other
  // account is not written back, and its login is not sent.
  failRecordWrites = false;
  failKeyDelete = false;
  clock += SIGN_IN_START_COOLDOWN_MS;
  await expect(service.startSignIn()).resolves.toEqual({ outcome: "started" });
  const next = new URL(opened.at(-1) ?? "").searchParams;
  expect(next.has("login")).toBe(false);
  expect(next.get("prompt")).toBe("select_account");
  expect(await realRecords.read()).toEqual({ kind: "none" });
  expect(service.status().account).toEqual({ kind: "signed_out" });

  const ended = idleWithOutcome(service, service.status().revision);
  service.cancelSignIn();
  expect((await ended).lastOutcome).toEqual({ code: "cancelled" });
}, 20_000);

test("This is not me deletes the registration marker, so a key whose delete fails is never sent again for the forgotten account (#153)", async () => {
  const folder = path.join(root, "MyManDev");
  const realKeys = createDeviceKeyStore({
    folder,
    platform: "win32",
    systemProtection: {
      isAsyncEncryptionAvailable: () => Promise.resolve(true),
      getSelectedStorageBackend: () => "unknown",
      encryptStringAsync: (plainText) =>
        Promise.resolve(Buffer.from(`fake:${plainText}`, "utf8")),
      decryptStringAsync: (ciphertext) =>
        Promise.resolve({
          shouldReEncrypt: false,
          result: ciphertext.toString("utf8").slice("fake:".length),
        }),
    },
  });
  const records = createDeviceRecordStore({ folder, platform: "win32" });
  const markers = createRegistrationMarkerStore({ folder, platform: "win32" });
  let failKeyDelete = false;
  const keyStore: DeviceKeyStore = {
    ...realKeys,
    delete: () =>
      failKeyDelete ? Promise.reject(new Error("EBUSY")) : realKeys.delete(),
  };
  // The installation holds an account whose device key was lost.
  const lost = await realKeys.create({ kind: "system" });
  await records.write({
    deviceId: DEVICE_ID,
    userId: USER_ID,
    login: "octocat",
    displayName: "The Octocat",
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
    publicKey: lost.publicKey,
  });
  await realKeys.delete();
  const sent: string[] = [];
  const opened: string[] = [];
  let clock = 0;
  const service = createAccountService({
    apiOrigin: { ok: true, origin: API_ORIGIN },
    openSystem: () => ({
      keyStore,
      deviceRecords: records,
      registrationMarkers: markers,
      createFlow: () =>
        createSignInFlow({
          apiOrigin: { ok: true, origin: API_ORIGIN },
          keyStore,
          deviceRecords: records,
          registrationMarkers: markers,
          openExternal: async (url) => {
            opened.push(url);
            return true;
          },
          fetch: async (_url, init) => {
            sent.push(
              SignInRequestSchema.parse(JSON.parse(String(init.body))).device
                .publicKey,
            );
            return new Response("{}", { status: 503 });
          },
          platform: "win32",
          scheduleTimer: () => () => undefined,
          listenerConnectionTimeoutMs: 2_000,
        }),
      createSession: () => sessionOver(folder, keyStore, records),
    }),
    focusWindow: () => undefined,
    confirmForget: async () => true,
    confirmRemoveDevice: async () => true,
    confirmRevokeDevice: async () => false,
    confirmLiftRegistrationLock: async () => false,
    now: () => clock,
  });
  await service.initialize();
  const signIn = async () => {
    const before = service.status().revision;
    await expect(service.startSignIn()).resolves.toEqual({
      outcome: "started",
    });
    const query = new URL(opened.at(-1) ?? "").searchParams;
    const done = idleWithOutcome(service, before);
    await postForm(
      query.get("redirect_uri") ?? "",
      new URLSearchParams({
        code: SIGN_IN_CODE,
        state: query.get("state") ?? "",
      }).toString(),
    );
    return (await done).lastOutcome;
  };

  // The new device's registration gets no clear answer: its key and the
  // marker stay.
  expect(await signIn()).toEqual({ code: "server_error" });
  const uncertain = sent[0];
  expect(await markers.read()).toMatchObject({
    marker: { publicKey: uncertain },
  });

  // "This is not me" deletes the record and the marker; the key delete fails.
  failKeyDelete = true;
  await expect(service.forgetAccount()).resolves.toEqual({
    outcome: "failed",
  });
  expect(await records.read()).toEqual({ kind: "none" });
  expect(await markers.read()).toEqual({ kind: "none" });
  expect(realKeys.keys()?.current.publicKey).toBe(uncertain);

  // The next sign-in deletes the leftover key and sends a new one.
  failKeyDelete = false;
  clock += SIGN_IN_START_COOLDOWN_MS;
  await signIn();
  expect(sent).toHaveLength(2);
  expect(sent[1]).not.toBe(uncertain);
}, 20_000);

// The device session through IPC, with the real sign-in flow, key store,
// record store, session, and a fake API with the rules of the API's device
// routes: sign in, list the devices, sign out, sign in again, and remove
// this device. Nothing that reaches the renderer holds a token, a
// signature, or key material.

const SPKI_ED25519_PREFIX = "302a300506032b6570032100";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refusal(code: ApiErrorCode): Response {
  const statusCode = API_ERROR_STATUS[code];
  return json(statusCode, {
    statusCode,
    error: "Error",
    message: "Refused",
    code,
  });
}

/** Whether `signature` is the `http` signature of the key `publicKey`. */
function signedBy(
  publicKey: string,
  nonce: string,
  challengeId: string,
  signature: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(
        deviceAuthInput({
          purpose: "http",
          audience: API_ORIGIN,
          nonce,
          deviceId: DEVICE_ID,
          challengeId,
        }),
        "utf8",
      ),
      createPublicKey({
        key: Buffer.from(`${SPKI_ED25519_PREFIX}${publicKey}`, "hex"),
        format: "der",
        type: "spki",
      }),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/**
 * A fake API for one device: a sign-in registers it or replaces its key, a
 * challenge is single use, a token needs the key that the API holds, and a
 * sign-out or a revocation ends every token.
 */
function deviceApi() {
  const api = {
    publicKey: null as string | null,
    signedOut: false,
    revokedReason: null as string | null,
    tokens: new Set<string>(),
    issued: [] as string[],
    signatures: [] as string[],
    signInBodies: [] as string[],
    routes: [] as string[],
    /** Holds every answer to `POST /auth/access-token` until it resolves. */
    tokenGate: null as Promise<void> | null,
    /** Called when a request arrives. */
    onRequest: null as ((route: string) => void) | null,
    /** Refuses every sign-in as another GitHub account's. */
    accountMismatch: false,
    /**
     * Another device of the account, listed after this one, with its
     * revocation once revoked; null without one.
     */
    otherDevice: null as {
      readonly id: DeviceId;
      readonly label: string;
      revokedAt: string | null;
      revokedReason: string | null;
    } | null,
    /** The end of the registration lock, or null without one. */
    lockedUntil: null as string | null,
    /** The sign-in expiry that the next sign-in answers (D4). */
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
    /**
     * Answers a route that needs a token in place of the API when it
     * returns a response; for example an uncertain answer.
     */
    override: null as ((route: string) => Response | undefined) | null,
  };
  const nonces = new Map<string, string>();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    expect(parsed.origin).toBe(API_ORIGIN);
    const method = init.method ?? "GET";
    const route = `${method} ${parsed.pathname}`;
    api.routes.push(route);
    api.onRequest?.(route);
    const text = init.body === undefined ? "" : String(init.body);
    const body =
      text === "" ? {} : (JSON.parse(text) as Record<string, string>);
    if (route === "POST /auth/sign-in") {
      const request = SignInRequestSchema.parse(JSON.parse(text));
      api.signInBodies.push(text);
      api.signatures.push(request.device.newKeySignature);
      if (request.device.kind === "existing") {
        api.signatures.push(request.device.currentKeySignature);
      }
      if (api.revokedReason !== null) {
        return refusal("device_revoked");
      }
      if (api.accountMismatch) {
        return refusal("device_account_mismatch");
      }
      api.publicKey = request.device.publicKey;
      api.signedOut = false;
      // The API drops the device's earlier tokens when it replaces the key.
      api.tokens.clear();
      return json(200, {
        userId: USER_ID,
        deviceId: DEVICE_ID,
        displayName: "The Octocat",
        login: "octocat",
        signInExpiresAt: api.signInExpiresAt,
      });
    }
    if (route === "POST /auth/challenge") {
      const challengeId = newUuidV7();
      const nonce = randomBytes(32).toString("base64url");
      nonces.set(challengeId, nonce);
      return json(200, { challengeId, nonce });
    }
    if (route === "POST /auth/access-token") {
      await api.tokenGate;
      const challengeId = body["challengeId"] ?? "";
      const signature = body["signature"] ?? "";
      api.signatures.push(signature);
      const nonce = nonces.get(challengeId);
      nonces.delete(challengeId);
      if (
        nonce === undefined ||
        body["deviceId"] !== DEVICE_ID ||
        api.publicKey === null ||
        !signedBy(api.publicKey, nonce, challengeId, signature)
      ) {
        return refusal("auth_failed");
      }
      if (api.revokedReason !== null) {
        return refusal("device_revoked");
      }
      if (api.signedOut) {
        return refusal("sign_in_required");
      }
      const accessToken = `mmda_${randomBytes(32).toString("base64url")}`;
      api.tokens.add(accessToken);
      api.issued.push(accessToken);
      return json(200, {
        accessToken,
        expiresAt: "2026-12-02T10:00:00.000Z",
      });
    }
    const token =
      new Headers(init.headers)
        .get("authorization")
        ?.replace(/^Bearer /u, "") ?? "";
    if (!api.tokens.has(token)) {
      return refusal("unauthorized");
    }
    const overridden = api.override?.(route);
    if (overridden !== undefined) {
      return overridden;
    }
    const other = api.otherDevice;
    switch (route) {
      case "POST /auth/sign-out":
        api.signedOut = true;
        api.tokens.clear();
        return new Response(null, { status: 204 });
      case "GET /devices":
        return json(200, {
          devices: [
            {
              id: DEVICE_ID,
              label: "Windows computer",
              platform: "windows",
              createdAt: "2026-11-01T10:00:00.000Z",
              lastSeenAt: null,
              lastSignInAt: "2026-11-02T10:00:00.000Z",
              signInExpiresAt: "2026-12-02T10:00:00.000Z",
              revokedAt: null,
              current: true,
            },
            ...(other === null
              ? []
              : [
                  {
                    id: other.id,
                    label: other.label,
                    platform: "linux",
                    createdAt: "2026-10-01T10:00:00.000Z",
                    lastSeenAt: "2026-11-01T10:00:00.000Z",
                    lastSignInAt: "2026-10-20T10:00:00.000Z",
                    signInExpiresAt: "2026-11-19T10:00:00.000Z",
                    revokedAt: other.revokedAt,
                    current: false,
                  },
                ]),
          ],
          registrationLockedUntil:
            api.lockedUntil !== null && Date.parse(api.lockedUntil) > Date.now()
              ? api.lockedUntil
              : null,
        });
      case `POST /devices/${DEVICE_ID}/revoke`:
        api.revokedReason = body["reason"] ?? null;
        api.tokens.clear();
        return new Response(null, { status: 204 });
      case "POST /account/registration-lock/lift":
        api.lockedUntil = null;
        return new Response(null, { status: 204 });
      default:
        break;
    }
    // Another device of the account, as the API's revoke route answers it.
    if (other !== null && route === `POST /devices/${other.id}/revoke`) {
      if (other.revokedAt !== null) {
        return refusal("conflict");
      }
      other.revokedAt = new Date().toISOString();
      other.revokedReason = body["reason"] ?? null;
      if (other.revokedReason === "lost") {
        api.lockedUntil = new Date(
          Date.now() + 7 * 24 * 60 * 60_000,
        ).toISOString();
      }
      return new Response(null, { status: 204 });
    }
    return refusal("not_found");
  };
  return { api, fetch };
}

test("sign in, list the devices, sign out, sign in again, and remove this device through IPC, with no token, signature, or key sent to the renderer", async () => {
  const folder = path.join(root, "MyManDev");
  const encrypted: string[] = [];
  const keyStore = createDeviceKeyStore({
    folder,
    platform: "win32",
    systemProtection: {
      isAsyncEncryptionAvailable: () => Promise.resolve(true),
      getSelectedStorageBackend: () => "unknown",
      encryptStringAsync: (plainText) => {
        encrypted.push(plainText);
        return Promise.resolve(Buffer.from(`fake:${plainText}`, "utf8"));
      },
      decryptStringAsync: (ciphertext) =>
        Promise.resolve({
          shouldReEncrypt: false,
          result: ciphertext.toString("utf8").slice("fake:".length),
        }),
    },
  });
  const records = createDeviceRecordStore({ folder, platform: "win32" });
  const { api, fetch } = deviceApi();
  const opened: string[] = [];
  const confirmed: string[] = [];
  const errors: string[] = [];
  let stopped = 0;
  let clock = 0;
  const service = createAccountService({
    apiOrigin: { ok: true, origin: API_ORIGIN },
    openSystem: () => ({
      keyStore,
      deviceRecords: records,
      registrationMarkers: createRegistrationMarkerStore({
        folder,
        platform: "win32",
      }),
      createFlow: () =>
        createSignInFlow({
          apiOrigin: { ok: true, origin: API_ORIGIN },
          keyStore,
          deviceRecords: records,
          registrationMarkers: createRegistrationMarkerStore({
            folder,
            platform: "win32",
          }),
          openExternal: async (url) => {
            opened.push(url);
            return true;
          },
          fetch,
          platform: "win32",
          scheduleTimer: () => () => undefined,
          listenerConnectionTimeoutMs: 2_000,
          onError: (message) => errors.push(message),
        }),
      createSession: () => sessionOver(folder, keyStore, records, fetch),
    }),
    focusWindow: () => undefined,
    confirmForget: async () => false,
    confirmRemoveDevice: async (login) => {
      confirmed.push(login);
      return true;
    },
    confirmRevokeDevice: async () => false,
    confirmLiftRegistrationLock: async () => false,
    stopLocalExecution: () => {
      stopped += 1;
    },
    now: () => clock,
    onError: (message) => errors.push(message),
  });
  const { call } = register(service);
  // The device list service over the real account service, as index.ts
  // creates it, with its channels.
  const devices = createDeviceListService({
    account: service,
    connection: OFFLINE_CONNECTION,
    now: () => clock,
  });
  const callDevices = registerDevices(devices);
  const subscriber = receiver();
  const app = () => event(frame(DEV_URL), subscriber);
  const answers: unknown[] = [];
  const invoke = async (channel: string): Promise<unknown> => {
    const answer = await (channel.startsWith("devices:")
      ? callDevices(channel, app())
      : call(channel, app()));
    answers.push(answer);
    return answer;
  };
  const signIn = async (
    code: string,
    outcome: AccountStatus["lastOutcome"] = { code: "signed_in" },
  ) => {
    clock += SIGN_IN_START_COOLDOWN_MS;
    const before = service.status().revision;
    await expect(invoke(INVOKE_CHANNELS.startSignIn)).resolves.toEqual({
      outcome: "started",
    });
    const query = new URL(opened.at(-1) ?? "").searchParams;
    const done = idleWithOutcome(service, before);
    expect(
      await postForm(
        query.get("redirect_uri") ?? "",
        new URLSearchParams({
          code,
          state: query.get("state") ?? "",
        }).toString(),
      ),
    ).toBe(200);
    expect((await done).lastOutcome).toEqual(outcome);
  };
  const device = async () =>
    ((await invoke(INVOKE_CHANNELS.getAccountStatus)) as AccountStatus).device;
  const LISTED_DEVICE = {
    id: DEVICE_ID,
    label: "Windows computer",
    platform: "windows",
    createdAt: "2026-11-01T10:00:00.000Z",
    lastSeenAt: null,
    lastSignInAt: "2026-11-02T10:00:00.000Z",
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
    revokedAt: null,
    current: true,
  };
  const listRequests = () =>
    api.routes.filter((route) => route === "GET /devices").length;

  answers.push(call(INVOKE_CHANNELS.subscribeAccountStatus, app()));
  answers.push(callDevices(INVOKE_CHANNELS.subscribeDeviceList, app()));
  await service.initialize();
  expect(await device()).toBe("no_device");
  // The Account screen opens before the sign-in and asks once, as the
  // section does when it opens; the request is refused but counts.
  await expect(invoke(INVOKE_CHANNELS.loadDeviceList)).resolves.toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
  await expect(invoke(INVOKE_CHANNELS.getDeviceList)).resolves.toMatchObject({
    status: "signed_out",
    devices: [],
  });
  expect(listRequests()).toBe(0);

  // Sign in on the open screen: a new device. The list loads on its own,
  // without another request of the screen.
  await signIn(SIGN_IN_CODE);
  expect(await device()).toBe("signed_in");
  await deviceListWhen(devices, (state) => state.status === "ready");
  await expect(invoke(INVOKE_CHANNELS.getDeviceList)).resolves.toEqual({
    status: "ready",
    revision: expect.any(Number),
    devices: [LISTED_DEVICE],
    registrationLockedUntil: null,
    newDevices: [],
    lostDeviceAdvice: false,
  });
  expect(listRequests()).toBe(1);

  // Sign out (P-65): the key and the record stay, and the API ended the
  // tokens; the key is not used until the next sign-in.
  const sentBeforeSignOut = subscriber.sent.length;
  await expect(invoke(INVOKE_CHANNELS.signOut)).resolves.toEqual({
    outcome: "signed_out",
  });
  expect(api.signedOut).toBe(true);
  expect(await device()).toBe("signed_out");
  await expect(keyStore.hasKey()).resolves.toBe(true);
  expect(await records.read()).toMatchObject({ kind: "record" });
  // #195: no status that reached the renderer since the sign-out names the
  // account or the outcome of the sign-in.
  await expect(invoke(INVOKE_CHANNELS.getAccountStatus)).resolves.toMatchObject(
    { account: { kind: "hidden" }, lastOutcome: null },
  );
  const sentSignedOut = JSON.stringify(
    subscriber.sent.slice(sentBeforeSignOut),
  );
  expect(sentSignedOut).toContain('"hidden"');
  for (const detail of ["octocat", "The Octocat", DEVICE_ID, '"signed_in"']) {
    expect(sentSignedOut).not.toContain(detail);
  }

  // The device list is dropped with the sign-out, and no list is read.
  const routesAfterSignOut = api.routes.length;
  clock += DEVICE_LIST_LOAD_COOLDOWN_MS;
  await expect(invoke(INVOKE_CHANNELS.getDeviceList)).resolves.toMatchObject({
    status: "signed_out",
    devices: [],
  });
  await expect(invoke(INVOKE_CHANNELS.loadDeviceList)).resolves.toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
  await expect(invoke(INVOKE_CHANNELS.removeDevice)).resolves.toEqual({
    outcome: "failed",
    reason: "signed_out",
  });
  expect(api.routes.length).toBe(routesAfterSignOut);

  // A restart whose key cannot be decrypted: the session names the key
  // before the sign-out, and no status names the account either, also while
  // the session starts.
  const lockedKeyStore = createDeviceKeyStore({
    folder,
    platform: "win32",
    systemProtection: {
      isAsyncEncryptionAvailable: () => Promise.resolve(true),
      getSelectedStorageBackend: () => "unknown",
      encryptStringAsync: () => Promise.reject(new Error("locked")),
      decryptStringAsync: () => Promise.reject(new Error("locked")),
    },
  });
  const restarted = createAccountService({
    apiOrigin: { ok: true, origin: API_ORIGIN },
    openSystem: () => ({
      keyStore: lockedKeyStore,
      deviceRecords: records,
      registrationMarkers: createRegistrationMarkerStore({
        folder,
        platform: "win32",
      }),
      createFlow: () => {
        throw new Error("No sign-in after this restart.");
      },
      createSession: () => sessionOver(folder, lockedKeyStore, records, fetch),
    }),
    focusWindow: () => undefined,
    confirmForget: async () => false,
    confirmRemoveDevice: async () => false,
    confirmRevokeDevice: async () => false,
    confirmLiftRegistrationLock: async () => false,
  });
  const restartedStatuses: AccountStatus[] = [];
  restarted.onStatusChange((status) => restartedStatuses.push(status));
  await restarted.initialize();
  expect(restartedStatuses.map((status) => status.device)).toEqual([
    "starting",
    "key_not_loaded",
  ]);
  expect(restarted.status()).toMatchObject({
    account: { kind: "hidden" },
    lastOutcome: null,
  });
  const sentAfterRestart = JSON.stringify(restartedStatuses);
  for (const detail of ["octocat", "The Octocat", DEVICE_ID]) {
    expect(sentAfterRestart).not.toContain(detail);
  }

  // A sign-in with another GitHub account: the outcome names the login of
  // the installation's account, and nothing names its name or device ID.
  api.accountMismatch = true;
  const sentBeforeMismatch = subscriber.sent.length;
  await signIn(MISMATCH_CODE, {
    code: "device_account_mismatch",
    deviceLogin: "octocat",
  });
  await expect(invoke(INVOKE_CHANNELS.getAccountStatus)).resolves.toMatchObject(
    { account: { kind: "hidden" }, device: "account_mismatch" },
  );
  const sentMismatch = JSON.stringify(
    subscriber.sent.slice(sentBeforeMismatch),
  );
  for (const detail of ["The Octocat", DEVICE_ID]) {
    expect(sentMismatch).not.toContain(detail);
  }
  api.accountMismatch = false;
  // Removing the device is refused without asking, also after the refused
  // sign-in.
  await expect(invoke(INVOKE_CHANNELS.removeDevice)).resolves.toEqual({
    outcome: "failed",
    reason: "signed_out",
  });
  expect(confirmed).toEqual([]);

  // Sign in again: the same device with a new key, signed in once more.
  await signIn(SECOND_CODE);
  expect(new URL(opened.at(-1) ?? "").searchParams.get("login")).toBe(
    "octocat",
  );
  expect(await device()).toBe("signed_in");
  await expect(invoke(INVOKE_CHANNELS.getAccountStatus)).resolves.toMatchObject(
    {
      account: {
        kind: "signed_in",
        login: "octocat",
        displayName: "The Octocat",
      },
      lastOutcome: { code: "signed_in" },
    },
  );
  // The Account screen asked for the list before, so it loads again on its
  // own once the sign-in ended, with the device's new token.
  await deviceListWhen(devices, (state) => state.status === "ready");
  await expect(invoke(INVOKE_CHANNELS.getDeviceList)).resolves.toMatchObject({
    status: "ready",
    devices: [LISTED_DEVICE],
  });
  expect(listRequests()).toBe(2);

  // Remove this device: confirmed in the main process, revoked at the API,
  // and only then are the key and the record deleted.
  await expect(invoke(INVOKE_CHANNELS.removeDevice)).resolves.toEqual({
    outcome: "removed",
  });
  expect(confirmed).toEqual(["octocat"]);
  expect(api.revokedReason).toBe("removed");
  await expect(keyStore.hasKey()).resolves.toBe(false);
  expect(await records.read()).toEqual({ kind: "none" });
  const last = (await invoke(
    INVOKE_CHANNELS.getAccountStatus,
  )) as AccountStatus;
  expect(last).toMatchObject({
    account: { kind: "signed_out" },
    device: "removed",
  });
  // The removal drops the list, and nothing reads it again.
  await expect(invoke(INVOKE_CHANNELS.getDeviceList)).resolves.toMatchObject({
    status: "signed_out",
    devices: [],
  });
  expect(listRequests()).toBe(2);
  // A removal is not a revocation by the API: local execution goes on.
  expect(stopped).toBe(0);
  expect(errors).toEqual([]);

  // Nothing that reached the renderer holds a sign-in code, a verifier, a
  // token, a signature, or key material.
  const requests = api.signInBodies.map((body) =>
    SignInRequestSchema.parse(JSON.parse(body)),
  );
  // The refused sign-in with another account sent the existing device too.
  expect(requests.map((request) => request.device.kind)).toEqual([
    "new",
    "existing",
    "existing",
  ]);
  const secrets = [
    SIGN_IN_CODE,
    SECOND_CODE,
    MISMATCH_CODE,
    ...requests.map((request) => request.codeVerifier),
    ...requests.map((request) => request.device.publicKey),
    ...api.issued,
    ...api.signatures,
    ...encrypted,
    ...encrypted.map((pkcs8) =>
      Buffer.from(pkcs8, "base64").toString("base64url"),
    ),
    ...encrypted.map((pkcs8) => Buffer.from(pkcs8, "base64").toString("hex")),
  ];
  // A token before the sign-out and one after the second sign-in; the
  // signatures of the three sign-ins (five) and of both tokens.
  expect(api.issued).toHaveLength(2);
  expect(api.signatures).toHaveLength(7);
  expect(secrets.every((secret) => secret.length >= 32)).toBe(true);
  const sent = JSON.stringify([subscriber.sent, answers]);
  expect(subscriber.sent.length).toBeGreaterThanOrEqual(10);
  // The device lists that reached the renderer, the ready ones included,
  // are part of the search.
  const deviceLists = subscriber.sent.filter(
    ([channel]) => channel === EVENT_CHANNELS.deviceListChanged,
  );
  expect(
    deviceLists.some(
      ([, payload]) => (payload as { status: string }).status === "ready",
    ),
  ).toBe(true);
  for (const secret of secrets) {
    expect(sent).not.toContain(secret);
  }
  expect(sent).not.toMatch(
    /mmdc_|mmda_|codeVerifier|Signature|pkcs8|publicKey|accessToken|userId/i,
  );
  // The user ID that the API answered never reaches the renderer either.
  expect(sent).not.toContain(USER_ID);
}, 20_000);

test("renew the sign-in of a signed-in device through IPC with the real flow and session: the same device with a new key and a new end, no sign-out, and the API asked with the new key afterwards (D4)", async () => {
  const folder = path.join(root, "MyManDev");
  const keyStore = createDeviceKeyStore({
    folder,
    platform: "win32",
    systemProtection: {
      isAsyncEncryptionAvailable: () => Promise.resolve(true),
      getSelectedStorageBackend: () => "unknown",
      encryptStringAsync: (plainText) =>
        Promise.resolve(Buffer.from(`fake:${plainText}`, "utf8")),
      decryptStringAsync: (ciphertext) =>
        Promise.resolve({
          shouldReEncrypt: false,
          result: ciphertext.toString("utf8").slice("fake:".length),
        }),
    },
  });
  const records = createDeviceRecordStore({ folder, platform: "win32" });
  const { api, fetch } = deviceApi();
  const opened: string[] = [];
  const errors: string[] = [];
  let clock = 0;
  const markers = () =>
    createRegistrationMarkerStore({ folder, platform: "win32" });
  const service = createAccountService({
    apiOrigin: { ok: true, origin: API_ORIGIN },
    openSystem: () => ({
      keyStore,
      deviceRecords: records,
      registrationMarkers: markers(),
      createFlow: () =>
        createSignInFlow({
          apiOrigin: { ok: true, origin: API_ORIGIN },
          keyStore,
          deviceRecords: records,
          registrationMarkers: markers(),
          openExternal: async (url) => {
            opened.push(url);
            return true;
          },
          fetch,
          platform: "win32",
          scheduleTimer: () => () => undefined,
          listenerConnectionTimeoutMs: 2_000,
          onError: (message) => errors.push(message),
        }),
      createSession: () => sessionOver(folder, keyStore, records, fetch),
    }),
    focusWindow: () => undefined,
    confirmForget: async () => false,
    confirmRemoveDevice: async () => false,
    confirmRevokeDevice: async () => false,
    confirmLiftRegistrationLock: async () => false,
    now: () => clock,
    onError: (message) => errors.push(message),
  });
  const { call } = register(service);
  const subscriber = receiver();
  const app = () => event(frame(DEV_URL), subscriber);
  const signIn = async (code: string) => {
    clock += SIGN_IN_START_COOLDOWN_MS;
    const before = service.status().revision;
    await expect(
      call(INVOKE_CHANNELS.startSignIn, app()) as Promise<unknown>,
    ).resolves.toEqual({ outcome: "started" });
    const authorize = new URL(opened.at(-1) ?? "");
    const done = idleWithOutcome(service, before);
    expect(
      await postForm(
        authorize.searchParams.get("redirect_uri") ?? "",
        new URLSearchParams({
          code,
          state: authorize.searchParams.get("state") ?? "",
        }).toString(),
      ),
    ).toBe(200);
    return { authorize, status: await done };
  };

  call(INVOKE_CHANNELS.subscribeAccountStatus, app());
  await service.initialize();
  const first = await signIn(SIGN_IN_CODE);
  expect(first.status).toMatchObject({
    account: {
      kind: "signed_in",
      deviceId: DEVICE_ID,
      signInExpiresAt: "2026-12-02T10:00:00.000Z",
    },
    device: "signed_in",
    lastOutcome: { code: "signed_in" },
  });
  // A read mints a token with the first key.
  await expect(service.readDeviceList()).resolves.toMatchObject({ ok: true });
  const firstKey = api.publicKey;
  const sentBefore = subscriber.sent.length;

  // "Renew the sign-in" starts the same sign-in while the device is signed
  // in. It names the device's login in the browser, and the API replaces
  // the key and answers 30 days from now.
  api.signInExpiresAt = "2026-12-09T10:00:00.000Z";
  const renewal = await signIn(SECOND_CODE);
  expect(renewal.authorize.searchParams.get("login")).toBe("octocat");
  expect(renewal.status).toMatchObject({
    account: {
      kind: "signed_in",
      login: "octocat",
      deviceId: DEVICE_ID,
      signInExpiresAt: "2026-12-09T10:00:00.000Z",
    },
    device: "signed_in",
    replacementPending: false,
    lastOutcome: { code: "signed_in" },
  });
  const request = SignInRequestSchema.parse(
    JSON.parse(api.signInBodies.at(-1) ?? ""),
  );
  expect(request.device).toMatchObject({
    kind: "existing",
    deviceId: DEVICE_ID,
  });
  expect(api.publicKey).not.toBe(firstKey);
  expect(api.publicKey).toBe(request.device.publicKey);
  await expect(records.read()).resolves.toMatchObject({
    kind: "record",
    record: {
      deviceId: DEVICE_ID,
      publicKey: api.publicKey,
      signInExpiresAt: "2026-12-09T10:00:00.000Z",
    },
  });
  await expect(keyStore.status()).resolves.toMatchObject({
    replacementPending: false,
  });
  // Every status of the renewal kept the device signed in and named it, so
  // nothing that follows the device dropped it, and no sign-out was sent.
  const during = subscriber.sent
    .slice(sentBefore)
    .map(([, status]) => status as AccountStatus);
  expect(during.length).toBeGreaterThanOrEqual(3);
  for (const status of during) {
    expect(status.device).toBe("signed_in");
    expect(status.account).toMatchObject({
      kind: "signed_in",
      deviceId: DEVICE_ID,
    });
  }
  expect(api.routes).not.toContain("POST /auth/sign-out");

  // The API dropped the earlier tokens; the next read mints one with the
  // new key, which the API verifies against the key that it now holds.
  const tokensBefore = api.issued.length;
  await expect(service.readDeviceList()).resolves.toMatchObject({ ok: true });
  expect(api.issued.length).toBe(tokensBefore + 1);
  expect(errors).toEqual([]);
});

test("revoke another device as lost and lift the registration lock through IPC with the real session: confirmed in the main process, sent once, and the list loads again after each", async () => {
  const folder = path.join(root, "MyManDev");
  const keyStore = createDeviceKeyStore({
    folder,
    platform: "win32",
    systemProtection: {
      isAsyncEncryptionAvailable: () => Promise.resolve(true),
      getSelectedStorageBackend: () => "unknown",
      encryptStringAsync: (plainText) =>
        Promise.resolve(Buffer.from(`fake:${plainText}`, "utf8")),
      decryptStringAsync: (ciphertext) =>
        Promise.resolve({
          shouldReEncrypt: false,
          result: ciphertext.toString("utf8").slice("fake:".length),
        }),
    },
  });
  const records = createDeviceRecordStore({ folder, platform: "win32" });
  const { api, fetch } = deviceApi();
  const otherId = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c9" as DeviceId;
  api.otherDevice = {
    id: otherId,
    label: "Old laptop",
    revokedAt: null,
    revokedReason: null,
  };
  const opened: string[] = [];
  const confirmations: string[] = [];
  const errors: string[] = [];
  let clock = 0;
  const service = createAccountService({
    apiOrigin: { ok: true, origin: API_ORIGIN },
    openSystem: () => ({
      keyStore,
      deviceRecords: records,
      registrationMarkers: createRegistrationMarkerStore({
        folder,
        platform: "win32",
      }),
      createFlow: () =>
        createSignInFlow({
          apiOrigin: { ok: true, origin: API_ORIGIN },
          keyStore,
          deviceRecords: records,
          registrationMarkers: createRegistrationMarkerStore({
            folder,
            platform: "win32",
          }),
          openExternal: async (url) => {
            opened.push(url);
            return true;
          },
          fetch,
          platform: "win32",
          scheduleTimer: () => () => undefined,
          listenerConnectionTimeoutMs: 2_000,
          onError: (message) => errors.push(message),
        }),
      createSession: () => sessionOver(folder, keyStore, records, fetch),
    }),
    focusWindow: () => undefined,
    confirmForget: async () => false,
    confirmRemoveDevice: async () => false,
    confirmRevokeDevice: async (login, device, reason) => {
      confirmations.push(
        `${login} ${device.id} ${device.label} ${device.platform} ${reason}`,
      );
      return true;
    },
    confirmLiftRegistrationLock: async (login, lockedUntil) => {
      confirmations.push(`lift ${login} ${lockedUntil}`);
      return true;
    },
    now: () => clock,
    onError: (message) => errors.push(message),
  });
  const { call } = register(service);
  const devices = createDeviceListService({
    account: service,
    connection: OFFLINE_CONNECTION,
    now: () => clock,
  });
  const callDevices = registerDevices(devices);
  const app = () => event(frame(DEV_URL), receiver());
  const ask = async (channel: string, ...args: unknown[]) =>
    await callDevices(channel, app(), ...args);
  const routes = (route: string) =>
    api.routes.filter((sent) => sent === route).length;
  const revokeRoute = `POST /devices/${otherId}/revoke`;
  const liftRoute = "POST /account/registration-lock/lift";

  await service.initialize();
  await expect(ask(INVOKE_CHANNELS.loadDeviceList)).resolves.toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
  clock += SIGN_IN_START_COOLDOWN_MS;
  const before = service.status().revision;
  await expect(call(INVOKE_CHANNELS.startSignIn, app())).resolves.toEqual({
    outcome: "started",
  });
  const query = new URL(opened.at(-1) ?? "").searchParams;
  const done = idleWithOutcome(service, before);
  await postForm(
    query.get("redirect_uri") ?? "",
    new URLSearchParams({
      code: SIGN_IN_CODE,
      state: query.get("state") ?? "",
    }).toString(),
  );
  expect((await done).lastOutcome).toEqual({ code: "signed_in" });
  await deviceListWhen(
    devices,
    (state) => state.status === "ready" && state.devices.length === 2,
  );
  const listsBefore = routes("GET /devices");

  // This device and an ID that the list does not hold are refused before
  // anything is asked or sent.
  await expect(
    ask(INVOKE_CHANNELS.revokeDevice, DEVICE_ID, "lost"),
  ).resolves.toEqual({ outcome: "refused", reason: "current_device" });
  await expect(
    ask(
      INVOKE_CHANNELS.revokeDevice,
      "0192f2a0-7c3e-7a1b-8c4d-5e6f708192ff",
      "lost",
    ),
  ).resolves.toEqual({ outcome: "refused", reason: "not_listed" });
  // No lock is in force yet.
  await expect(ask(INVOKE_CHANNELS.liftRegistrationLock)).resolves.toEqual({
    outcome: "refused",
    reason: "no_lock",
  });
  expect(confirmations).toEqual([]);
  expect(routes(revokeRoute) + routes(liftRoute)).toBe(0);

  // Revoke the other device as lost: confirmed with the login, its label,
  // and its platform, sent once, and the list loads again on its own with
  // the device revoked and the lock in force.
  await expect(
    ask(INVOKE_CHANNELS.revokeDevice, otherId, "lost"),
  ).resolves.toEqual({ outcome: "revoked", reason: "lost" });
  expect(confirmations).toEqual([`octocat ${otherId} Old laptop linux lost`]);
  expect(routes(revokeRoute)).toBe(1);
  expect(api.otherDevice.revokedReason).toBe("lost");
  const revokedList = await deviceListWhen(
    devices,
    (state) =>
      state.devices.some(
        (device) => device.id === otherId && device.revokedAt !== null,
      ) && state.registrationLockedUntil !== null,
  );
  expect(revokedList.status).toBe("ready");
  expect(routes("GET /devices")).toBeGreaterThan(listsBefore);
  // This device stays signed in.
  expect(service.status().device).toBe("signed_in");
  // The advice after a revocation as lost reaches the renderer with the
  // list, and stays until it is dismissed through its channel.
  await expect(ask(INVOKE_CHANNELS.getDeviceList)).resolves.toMatchObject({
    lostDeviceAdvice: true,
  });
  await expect(ask(INVOKE_CHANNELS.dismissLostDeviceAdvice)).resolves.toBe(
    true,
  );
  await expect(ask(INVOKE_CHANNELS.getDeviceList)).resolves.toMatchObject({
    lostDeviceAdvice: false,
  });
  // A revoked device is no longer listed as active.
  await expect(
    ask(INVOKE_CHANNELS.revokeDevice, otherId, "removed"),
  ).resolves.toEqual({ outcome: "refused", reason: "not_listed" });

  // An uncertain answer to the lift is unknown and never sent again.
  api.override = (route) =>
    route === liftRoute
      ? json(503, { statusCode: 503, code: "unavailable" })
      : undefined;
  await expect(ask(INVOKE_CHANNELS.liftRegistrationLock)).resolves.toEqual({
    outcome: "unknown",
  });
  expect(routes(liftRoute)).toBe(1);
  api.override = null;
  const listsAfterUnknown = routes("GET /devices");

  // The lift: confirmed, sent once, and the list loads again without it.
  await expect(ask(INVOKE_CHANNELS.liftRegistrationLock)).resolves.toEqual({
    outcome: "lifted",
  });
  expect(routes(liftRoute)).toBe(2);
  // Each confirmation names the end of the lock that the list reported.
  const lockEnd = revokedList.registrationLockedUntil;
  expect(confirmations.slice(1)).toEqual([
    `lift octocat ${lockEnd}`,
    `lift octocat ${lockEnd}`,
  ]);
  await deviceListWhen(
    devices,
    (state) =>
      state.registrationLockedUntil === null &&
      routes("GET /devices") > listsAfterUnknown,
  );
  expect(errors).toEqual([]);
  devices.close();
}, 20_000);

test("This is not me during a sign-out report of the startup refresh never writes the other account back", async () => {
  const folder = path.join(root, "MyManDev");
  const keyStore = createDeviceKeyStore({
    folder,
    platform: "win32",
    systemProtection: {
      isAsyncEncryptionAvailable: () => Promise.resolve(true),
      getSelectedStorageBackend: () => "unknown",
      encryptStringAsync: (plainText) =>
        Promise.resolve(Buffer.from(`fake:${plainText}`, "utf8")),
      decryptStringAsync: (ciphertext) =>
        Promise.resolve({
          shouldReEncrypt: false,
          result: ciphertext.toString("utf8").slice("fake:".length),
        }),
    },
  });
  const records = createDeviceRecordStore({ folder, platform: "win32" });
  // The installation holds the other account: a sign-in replaced its key
  // without a clear answer (the record names the previous key), and the
  // person signed out while offline, so the report is pending. The API
  // holds the new key.
  const previous = await keyStore.create({ kind: "system" });
  await records.write({
    deviceId: DEVICE_ID,
    userId: USER_ID,
    login: "octocat",
    displayName: "The Octocat",
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
    publicKey: previous.publicKey,
  });
  const replaced = await keyStore.replace();
  await createSignOutMarkerStore({ folder, platform: "win32" }).write({
    publicKeys: [replaced.current.publicKey, previous.publicKey],
    reported: false,
  });
  const { api, fetch } = deviceApi();
  api.publicKey = replaced.current.publicKey;
  // The answer to the token request of the report is held back.
  let release: () => void = () => undefined;
  api.tokenGate = new Promise((resolve) => {
    release = resolve;
  });
  const tokenAsked = new Promise<void>((resolve) => {
    api.onRequest = (route) => {
      if (route === "POST /auth/access-token") {
        resolve();
      }
    };
  });
  const service = createAccountService({
    apiOrigin: { ok: true, origin: API_ORIGIN },
    openSystem: () => ({
      keyStore,
      deviceRecords: records,
      registrationMarkers: createRegistrationMarkerStore({
        folder,
        platform: "win32",
      }),
      createFlow: () =>
        createSignInFlow({
          apiOrigin: { ok: true, origin: API_ORIGIN },
          keyStore,
          deviceRecords: records,
          registrationMarkers: createRegistrationMarkerStore({
            folder,
            platform: "win32",
          }),
          openExternal: async () => true,
          fetch,
          platform: "win32",
          scheduleTimer: () => () => undefined,
        }),
      createSession: () => sessionOver(folder, keyStore, records, fetch),
    }),
    focusWindow: () => undefined,
    confirmForget: async () => true,
    confirmRemoveDevice: async () => true,
    confirmRevokeDevice: async () => false,
    confirmLiftRegistrationLock: async () => false,
  });

  // The startup refresh finds the pending report and sends it.
  const initializing = service.initialize();
  await tokenAsked;
  expect(service.status().device).toBe("sign_out_report_pending");

  // "This is not me" while the token answer is on its way.
  const forgetting = service.forgetAccount();
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await initializing;

  await expect(forgetting).resolves.toEqual({
    outcome: "forgotten",
    removedAtServer: false,
  });
  // Nothing wrote the other account back.
  expect(await records.read()).toEqual({ kind: "none" });
  await expect(keyStore.hasKey()).resolves.toBe(false);
  expect(service.status()).toMatchObject({
    account: { kind: "signed_out" },
    device: "no_device",
  });
  // The report reached the API before the forget.
  expect(api.signedOut).toBe(true);
}, 20_000);

test("a workspace read refused by its own token request answers not_signed_in, although the real session moved the device meanwhile", async () => {
  const cases: ["sign_in_required" | "auth_failed", string][] = [
    ["sign_in_required", "sign-in-required"],
    ["auth_failed", "auth-failed"],
  ];
  for (const [refusalCode, name] of cases) {
    const folder = path.join(root, name);
    const keyStore = createDeviceKeyStore({
      folder,
      platform: "win32",
      systemProtection: {
        isAsyncEncryptionAvailable: () => Promise.resolve(true),
        getSelectedStorageBackend: () => "unknown",
        encryptStringAsync: (plainText) =>
          Promise.resolve(Buffer.from(`fake:${plainText}`, "utf8")),
        decryptStringAsync: (ciphertext) =>
          Promise.resolve({
            shouldReEncrypt: false,
            result: ciphertext.toString("utf8").slice("fake:".length),
          }),
      },
    });
    const records = createDeviceRecordStore({ folder, platform: "win32" });
    const key = await keyStore.create({ kind: "system" });
    await records.write({
      deviceId: DEVICE_ID,
      userId: USER_ID,
      login: "octocat",
      displayName: "The Octocat",
      signInExpiresAt: "2026-12-02T10:00:00.000Z",
      publicKey: key.publicKey,
    });
    const { api, fetch } = deviceApi();
    if (refusalCode === "sign_in_required") {
      // The device's sign-in ended at the API.
      api.publicKey = key.publicKey;
      api.signedOut = true;
    } else {
      // The API holds another key.
      api.publicKey = "a".repeat(64);
    }
    const service = createAccountService({
      apiOrigin: { ok: true, origin: API_ORIGIN },
      openSystem: () => ({
        keyStore,
        deviceRecords: records,
        registrationMarkers: createRegistrationMarkerStore({
          folder,
          platform: "win32",
        }),
        createFlow: () => {
          throw new Error("no sign-in here");
        },
        createSession: () => sessionOver(folder, keyStore, records, fetch),
      }),
      focusWindow: () => undefined,
      confirmForget: async () => false,
      confirmRemoveDevice: async () => false,
      confirmRevokeDevice: async () => false,
      confirmLiftRegistrationLock: async () => false,
    });
    await service.initialize();
    expect(service.status().device, name).toBe("signed_in");

    await expect(
      service.readWorkspaceData("listWorkspaces", {}),
      name,
    ).resolves.toEqual({ ok: false, reason: "not_signed_in" });
    // The session published the refusal while the read was on its way.
    expect(service.status().device, name).toBe(refusalCode);
    expect(api.routes, name).toEqual([
      "POST /auth/challenge",
      "POST /auth/access-token",
    ]);
  }
}, 20_000);
