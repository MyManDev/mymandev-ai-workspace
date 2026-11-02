import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type DeviceId,
  SignInRequestSchema,
  type UserId,
} from "@mymandev/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type { AccountStatus } from "../shared/ipc-contract.ts";
import { createAccountService, type AccountService } from "./account.ts";
import { registerAccountIpc } from "./account-ipc.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import {
  createDeviceKeyStore,
  type SystemKeyProtection,
} from "./device-key/store.ts";
import { createDeviceRecordStore } from "./device-record.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import type { ScheduleTimer } from "./runtime.ts";
import { createSignInFlow } from "./sign-in/flow.ts";

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
    startSignIn: async () => {
      calls.push({ method: "startSignIn", args: [] });
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
      return { outcome: "forgotten" };
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

const ACCOUNT_CHANNELS = Object.values(INVOKE_CHANNELS).filter((channel) =>
  channel.startsWith("account:"),
);

test("a handler is registered for every account channel and nothing else", () => {
  const { handlers } = register(fakeService().service);

  expect(ACCOUNT_CHANNELS).toHaveLength(6);
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
        : [[PASSPHRASE], [{ login: "octocat" }], [undefined], [1, 2]];
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
  expect(call(INVOKE_CHANNELS.cancelSignIn, app)).toBe(true);
  const unlocked = await (call(
    INVOKE_CHANNELS.unlockDeviceKey,
    app,
    PASSPHRASE,
  ) as Promise<unknown>);
  await expect(call(INVOKE_CHANNELS.forgetAccount, app)).resolves.toEqual({
    outcome: "forgotten",
  });

  expect(unlocked).toEqual({ outcome: "refused", reason: "wrong_passphrase" });
  expect(JSON.stringify(unlocked)).not.toContain(PASSPHRASE);
  expect(fake.calls.map(({ method }) => method)).toEqual([
    "status",
    "startSignIn",
    "cancelSignIn",
    "unlockDeviceKey",
    "forgetAccount",
  ]);
  expect(fake.calls[3]?.args).toEqual([PASSPHRASE]);
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
const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3" as DeviceId;
const USER_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4" as UserId;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mymandev-account-ipc-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

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
  const errors: string[] = [];
  // The listener's 10 minutes and the request timeout never fire here.
  const scheduleTimer: ScheduleTimer = () => () => undefined;
  let focused = 0;
  const service = createAccountService({
    apiOrigin: { ok: true, origin: API_ORIGIN },
    openSystem: () => ({
      keyStore,
      deviceRecords: records,
      createFlow: () =>
        createSignInFlow({
          apiOrigin: { ok: true, origin: API_ORIGIN },
          keyStore,
          deviceRecords: records,
          // The browser does not open, so the URL to copy is sent too.
          openExternal: async () => false,
          fetch: async (_url, init) => {
            const body = String(init.body);
            SignInRequestSchema.parse(JSON.parse(body));
            bodies.push(body);
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
    }),
    focusWindow: () => {
      focused += 1;
    },
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
  });

  expect(focused).toBe(2);
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
