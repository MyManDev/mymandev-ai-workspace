import {
  API_ERROR_CODES,
  type AuthChallengeFrame,
  type AuthResponseFrame,
  type DeviceId,
  GITHUB_LOGIN_PATTERN,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  type ProjectId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  ACCOUNT_LIMITS,
  AccountStatusSchema,
  type AccountStatus,
  type SignInOutcomeCode,
} from "../shared/ipc-contract.ts";
import {
  type AccountServiceOptions,
  type AccountSession,
  type AccountSystem,
  createAccountService,
  FORGET_CONFIRMATION,
  forgetConfirmationMessage,
  LIST_DEVICES_COOLDOWN_MS,
  forgetConfirmed,
  SIGN_IN_START_COOLDOWN_MS,
  signInOutcomeView,
  UNLOCK_DELAY_MAX_MS,
  unlockDelayMs,
} from "./account.ts";
import {
  DeviceKeyError,
  type DeviceKeyErrorCode,
} from "./device-key/errors.ts";
import { PASSPHRASE_MAX_CHARACTERS } from "./device-key/key-file.ts";
import type { DeviceKeyStatus } from "./device-key/store.ts";
import type { DeviceRecord, DeviceRecordRead } from "./device-record.ts";
import { WORKSPACE_READS } from "./api-reads.ts";
import type {
  AuthorizedRequest,
  DeviceSessionState,
  SessionAccount,
  SessionResult,
} from "./session/session.ts";
import {
  SIGN_IN_FAILURE_REASONS,
  SIGN_IN_URL_WARNING,
  UNCERTAIN_REFUSAL_CODES,
  type SignInOutcome,
  type SignInStart,
} from "./sign-in/flow.ts";
import { SIGN_IN_LISTENER_ERRORS } from "./sign-in/listener.ts";

const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3" as DeviceId;
const OTHER_DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b7" as DeviceId;
const USER_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4" as UserId;
const PUBLIC_KEY = "ab".repeat(32);
const AUTHORIZE_URL =
  "https://api.mymandev.example/auth/github/authorize?code_challenge=c&state=s";
const PASSPHRASE = "correct horse battery staple";

const RECORD: DeviceRecord = Object.freeze({
  deviceId: DEVICE_ID,
  userId: USER_ID,
  login: "octocat",
  displayName: "The Octocat",
  signInExpiresAt: "2026-12-02T10:00:00.000Z",
  publicKey: PUBLIC_KEY,
});

const SESSION_ACCOUNT: SessionAccount = Object.freeze({
  deviceId: DEVICE_ID,
  userId: USER_ID,
  login: "octocat",
  displayName: "The Octocat",
  signInExpiresAt: "2026-12-02T10:00:00.000Z",
});

const SESSION_SIGNED_IN: DeviceSessionState = Object.freeze({
  kind: "signed_in",
  account: SESSION_ACCOUNT,
});

const DEVICE_ITEM = Object.freeze({
  id: DEVICE_ID,
  label: "Mac",
  platform: "macos",
  createdAt: "2026-10-01T10:00:00.000Z",
  lastSeenAt: "2026-11-02T09:00:00.000Z",
  lastSignInAt: "2026-11-01T10:00:00.000Z",
  signInExpiresAt: "2026-12-01T10:00:00.000Z",
  revokedAt: null,
  current: true,
} as const);

const CHALLENGE: AuthChallengeFrame = Object.freeze({
  protocolVersion: 0,
  type: "auth.challenge",
  nonce: "n".repeat(43),
  connectionId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1",
} as AuthChallengeFrame);

const AUTH_RESPONSE: AuthResponseFrame = Object.freeze({
  protocolVersion: 0,
  type: "auth.response",
  deviceId: DEVICE_ID,
  signature: "s".repeat(86),
} as AuthResponseFrame);

const WORKSPACE_LIST = Object.freeze({ workspaces: [] });
const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1" as WorkspaceId;
const PROJECT_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1" as ProjectId;

const SIGNED_IN_OUTCOME: SignInOutcome = Object.freeze({
  kind: "signed_in",
  account: Object.freeze({
    userId: USER_ID,
    login: "hubot",
    displayName: "Hubot",
    deviceId: OTHER_DEVICE_ID,
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
  }),
  newDevice: true,
  login: "hubot",
});

/** A started sign-in whose outcome the test settles. */
function startedSignIn(opened = true) {
  let settle: (outcome: SignInOutcome) => void = () => undefined;
  const outcome = new Promise<SignInOutcome>((resolve) => {
    settle = resolve;
  });
  let cancels = 0;
  const base = {
    started: true as const,
    pairingCode: "042137",
    cancel: () => {
      cancels += 1;
      settle({ kind: "cancelled" });
    },
    outcome,
  };
  const start: SignInStart = opened
    ? { ...base, opened: true }
    : {
        ...base,
        opened: false,
        authorizeUrl: AUTHORIZE_URL,
        warning: SIGN_IN_URL_WARNING,
      };
  return {
    start,
    settle: (value: SignInOutcome) => settle(value),
    cancels: () => cancels,
  };
}

interface Harness {
  readonly service: ReturnType<typeof createAccountService>;
  /** Every step of the fakes and the service, in order. */
  readonly log: string[];
  readonly statuses: AccountStatus[];
  readonly errors: string[];
  flows: number;
  focused: number;
  record: DeviceRecordRead | Error;
  keyStatus: DeviceKeyStatus | Error;
  /** What `load` does with the passphrase it got, or undefined without one. */
  load: (passphrase: string | undefined) => Promise<void>;
  /** What the flow's `start` resolves with. */
  start: () => Promise<SignInStart>;
  /** The `openBrowser` option of every `start` of the flow, in order. */
  readonly openBrowser: (boolean | undefined)[];
  /** The `onCallback` that the service passed to the last `start`. */
  callback: (() => void) | undefined;
  /** The answer of the native confirmation of "This is not me". */
  confirm: (login: string) => Promise<boolean>;
  /** The service's clock in milliseconds. */
  clock: number;
  recordDelete: () => Promise<void>;
  markerDelete: () => Promise<void>;
  keyDelete: () => Promise<void>;
  /** The answer of the native confirmation of removing this device. */
  confirmRemoval: (login: string) => Promise<boolean>;
  /** When set, every read of the record waits for it. */
  readGate: Promise<void> | null;
  /** How often local execution was stopped. */
  stopped: number;
  /** The state of the fake device session, which `state` and `refresh` return. */
  sessionState: DeviceSessionState;
  /** Sets the session's state and calls its listeners, as the session does. */
  emit: (state: DeviceSessionState) => void;
  authenticate: () => Promise<SessionResult<SessionAccount>>;
  signOut: () => Promise<SessionResult<"reported" | "pending">>;
  reportSignOut: () => Promise<SessionResult<"reported" | "pending">>;
  removeDevice: () => Promise<SessionResult<"removed" | "pending">>;
  listDevices: () => Promise<SessionResult<readonly unknown[]>>;
  /** The answers of the session's `signWebSocketChallenge`, one per call. */
  signChallenge: () => Promise<SessionResult<AuthResponseFrame>>;
  /** What the session's `request` answers. */
  request: (
    call: AuthorizedRequest<unknown>,
  ) => Promise<SessionResult<unknown>>;
  /** Every request that reached the session's `request`, in order. */
  readonly requests: AuthorizedRequest<unknown>[];
  /** What the session's `deviceRefused` does; it moves to the state it returns. */
  refuseDevice: (
    code: string,
    deviceId: DeviceId,
  ) => Promise<DeviceSessionState>;
  createSession: () => AccountSession;
}

function harness(
  overrides: Partial<
    Pick<
      AccountServiceOptions,
      "apiOrigin" | "openSystem" | "stopLocalExecution"
    >
  > = {},
): Harness {
  const state = {
    log: [] as string[],
    statuses: [] as AccountStatus[],
    errors: [] as string[],
    flows: 0,
    focused: 0,
    record: { kind: "record", record: RECORD } as DeviceRecordRead | Error,
    keyStatus: {
      protection: "system",
      loaded: true,
      replacementPending: false,
      passphraseRequired: false,
    } as DeviceKeyStatus | Error,
    load: async () => undefined,
    start: async (): Promise<SignInStart> => startedSignIn().start,
    openBrowser: [] as (boolean | undefined)[],
    callback: undefined,
    confirm: async () => true,
    clock: 0,
    recordDelete: async () => undefined,
    markerDelete: async () => undefined,
    keyDelete: async () => undefined,
    confirmRemoval: async () => true,
    readGate: null,
    stopped: 0,
    sessionState: SESSION_SIGNED_IN,
    emit: () => undefined,
    authenticate: async () => ({ ok: true, value: SESSION_ACCOUNT }),
    signOut: async () => ({ ok: true, value: "reported" }),
    reportSignOut: async () => ({ ok: true, value: "reported" }),
    removeDevice: async () => ({ ok: true, value: "removed" }),
    listDevices: async () => ({ ok: true, value: [DEVICE_ITEM] }),
    signChallenge: async () => ({ ok: true, value: AUTH_RESPONSE }),
    request: async () => ({ ok: true, value: WORKSPACE_LIST }),
    requests: [] as AuthorizedRequest<unknown>[],
    refuseDevice: async () => SESSION_SIGNED_IN,
  } as unknown as Omit<Harness, "service">;
  const sessionListeners = new Set<(state: DeviceSessionState) => void>();
  state.emit = (next) => {
    state.sessionState = next;
    for (const listener of [...sessionListeners]) {
      listener(next);
    }
  };
  // A fake of the device session that logs every call.
  state.createSession = () => {
    state.log.push("session create");
    return {
      state: () => state.sessionState,
      onChange: (listener) => {
        sessionListeners.add(listener);
        return () => {
          sessionListeners.delete(listener);
        };
      },
      refresh: async () => {
        state.log.push("session refresh");
        return state.sessionState;
      },
      signInStarted: () => {
        state.log.push("session signInStarted");
      },
      signInFinished: async (outcome) => {
        const detail = (outcome as { reason?: string }).reason ?? outcome.code;
        state.log.push(
          `session signInFinished ${outcome.kind}${detail === undefined ? "" : ` ${detail}`}`,
        );
        return state.sessionState;
      },
      authenticate: async () => {
        state.log.push("session authenticate");
        return state.authenticate();
      },
      listDevices: async () => {
        state.log.push("session listDevices");
        return (await state.listDevices()) as never;
      },
      signOut: async () => {
        state.log.push("session signOut");
        return state.signOut();
      },
      reportSignOut: async () => {
        state.log.push("session reportSignOut");
        return state.reportSignOut();
      },
      removeDevice: async () => {
        state.log.push("session removeDevice");
        return state.removeDevice();
      },
      signWebSocketChallenge: async () => {
        state.log.push("session signWebSocketChallenge");
        return state.signChallenge();
      },
      deviceRefused: async (code, deviceId) => {
        state.log.push(`session deviceRefused ${code}`);
        return state.refuseDevice(code, deviceId);
      },
      request: async (call) => {
        state.log.push(`session request ${call.route.path}`);
        state.requests.push(call as AuthorizedRequest<unknown>);
        return (await state.request(
          call as AuthorizedRequest<unknown>,
        )) as never;
      },
    };
  };
  const system: AccountSystem = {
    keyStore: {
      load: async (options) => {
        state.log.push(
          options?.passphrase === undefined ? "load" : "load with passphrase",
        );
        await state.load(options?.passphrase);
        return null;
      },
      status: async () => {
        if (state.keyStatus instanceof Error) {
          throw state.keyStatus;
        }
        return state.keyStatus;
      },
      delete: async () => {
        state.log.push("delete key");
        await state.keyDelete();
      },
    },
    deviceRecords: {
      read: async () => {
        state.log.push("read record");
        await state.readGate;
        if (state.record instanceof Error) {
          throw state.record;
        }
        return state.record;
      },
      delete: async () => {
        state.log.push("delete record");
        await state.recordDelete();
      },
    },
    registrationMarkers: {
      delete: async () => {
        state.log.push("delete registration marker");
        await state.markerDelete();
      },
    },
    createFlow: () => {
      state.flows += 1;
      state.log.push(`create flow ${state.flows}`);
      return {
        start: (options) => {
          state.log.push("start");
          state.openBrowser.push(options?.openBrowser);
          state.callback = options?.onCallback;
          return state.start();
        },
        reset: () => {
          state.log.push("reset flow");
          return true;
        },
      };
    },
    createSession: () => state.createSession(),
  };
  const service = createAccountService({
    apiOrigin: { ok: true, origin: "https://api.mymandev.example" },
    openSystem: () => system,
    focusWindow: () => {
      state.focused += 1;
      state.log.push("focus");
    },
    confirmForget: (login) => {
      state.log.push(`confirm ${login}`);
      return state.confirm(login);
    },
    confirmRemoveDevice: (login) => {
      state.log.push(`confirm removal ${login}`);
      return state.confirmRemoval(login);
    },
    stopLocalExecution: () => {
      state.stopped += 1;
      state.log.push("stop local execution");
    },
    now: () => state.clock,
    onError: (message) => state.errors.push(message),
    ...overrides,
  });
  service.onStatusChange((status) => {
    state.statuses.push(status);
    state.log.push(`status ${status.signIn.kind}`);
  });
  return Object.assign(state, { service }) as Harness;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

/** Resolves with the next status that `predicate` accepts. */
function nextStatus(
  h: Harness,
  predicate: (status: AccountStatus) => boolean,
): Promise<AccountStatus> {
  return new Promise((resolve) => {
    const end = h.service.onStatusChange((status) => {
      if (predicate(status)) {
        end();
        resolve(status);
      }
    });
  });
}

test("before the key is loaded, the status says so and every action waits", async () => {
  const h = harness();

  expect(h.service.status()).toEqual({
    revision: 0,
    account: { kind: "signed_out" },
    signIn: { kind: "idle" },
    lastOutcome: null,
    deviceKey: "loading",
    replacementPending: false,
    apiOrigin: "set",
    device: "starting",
  });
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "refused",
    reason: "key_not_ready",
  });
  await expect(h.service.unlockDeviceKey(PASSPHRASE)).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  expect(h.service.cancelSignIn()).toBe(false);
  expect(h.log).toEqual([]);
});

test("initialize loads the key once, then reads the record, and shows only the login, the name, and the device ID", async () => {
  const h = harness();

  await Promise.all([h.service.initialize(), h.service.initialize()]);
  await h.service.initialize();

  expect(h.log).toEqual([
    "load",
    "session create",
    "read record",
    "status idle",
    "session refresh",
  ]);
  expect(h.service.status()).toEqual({
    revision: 1,
    account: {
      kind: "signed_in",
      login: "octocat",
      displayName: "The Octocat",
      deviceId: DEVICE_ID,
    },
    signIn: { kind: "idle" },
    lastOutcome: null,
    deviceKey: "ready",
    replacementPending: false,
    apiOrigin: "set",
    device: "signed_in",
  });
  expect(JSON.stringify(h.service.status())).not.toMatch(
    new RegExp(`${USER_ID}|${PUBLIC_KEY}|signInExpiresAt`),
  );
  expect(Object.isFrozen(h.service.status())).toBe(true);
  expect(AccountStatusSchema.parse(h.service.status())).toEqual(
    h.service.status(),
  );
});

test("without a record, with a corrupt one, or with one that cannot be read, the installation is signed out", async () => {
  for (const [record, errors] of [
    [{ kind: "none" }, []],
    [{ kind: "corrupt" }, []],
    [new Error("EACCES"), ["The device record could not be read."]],
  ] as const) {
    const h = harness();
    h.record = record;

    await h.service.initialize();

    expect(h.service.status().account).toEqual({ kind: "signed_out" });
    expect(h.service.status().deviceKey).toBe("ready");
    expect(h.errors).toEqual(errors);
  }
});

test("a pending key replacement and the API origin reach the status", async () => {
  const h = harness();
  h.keyStatus = {
    protection: "system",
    loaded: true,
    replacementPending: true,
    passphraseRequired: false,
  };
  await h.service.initialize();
  expect(h.service.status().replacementPending).toBe(true);

  for (const [apiOrigin, state] of [
    [{ ok: false, reason: "api_origin_unset" }, "unset"],
    [{ ok: false, reason: "api_origin_invalid" }, "invalid"],
  ] as const) {
    expect(harness({ apiOrigin }).service.status().apiOrigin).toBe(state);
  }
});

test("a key that cannot be loaded shows why, and the sign-in is refused", async () => {
  for (const [error, deviceKey] of [
    [new DeviceKeyError("unreadable"), "unreadable"],
    [new DeviceKeyError("corrupt"), "corrupt"],
    [new DeviceKeyError("newer_format"), "newer_format"],
    [new DeviceKeyError("key_retired"), "failed"],
    [new Error("EIO"), "failed"],
  ] as const) {
    const h = harness();
    h.load = () => Promise.reject(error);

    await h.service.initialize();

    expect(h.service.status().deviceKey).toBe(deviceKey);
    expect(h.errors).toEqual(["The device key could not be loaded."]);
    await expect(h.service.startSignIn()).resolves.toEqual({
      outcome: "refused",
      reason: "key_not_ready",
    });
    await expect(h.service.startSignIn({ browser: "other" })).resolves.toEqual({
      outcome: "refused",
      reason: "key_not_ready",
    });
    expect(h.flows).toBe(0);
  }
});

test("a key store that cannot be opened shows why", async () => {
  for (const [error, deviceKey] of [
    [
      new DeviceKeyError("local_data_folder_missing"),
      "local_data_folder_missing",
    ],
    [new Error("The device key store needs a ready application."), "failed"],
  ] as const) {
    const h = harness({
      openSystem: () => {
        throw error;
      },
    });

    await h.service.initialize();

    expect(h.service.status()).toMatchObject({
      account: { kind: "signed_out" },
      deviceKey,
      device: "unavailable",
    });
    expect(h.errors).toEqual(["The device key store could not be opened."]);
    await expect(h.service.startSignIn()).resolves.toEqual({
      outcome: "refused",
      reason: "key_not_ready",
    });
    await expect(h.service.forgetAccount()).resolves.toEqual({
      outcome: "refused",
      reason: "not_signed_in",
    });
  }
});

test("a key that needs its passphrase waits for it; a wrong one is refused and the right one unlocks it", async () => {
  const h = harness();
  h.load = async (passphrase) => {
    if (passphrase === undefined) {
      throw new DeviceKeyError("passphrase_required");
    }
    if (passphrase !== PASSPHRASE) {
      throw new DeviceKeyError("wrong_passphrase");
    }
  };
  h.keyStatus = {
    protection: "passphrase",
    loaded: false,
    replacementPending: true,
    passphraseRequired: true,
  };
  await h.service.initialize();

  expect(h.service.status().deviceKey).toBe("passphrase_required");
  expect(h.service.status().replacementPending).toBe(true);
  expect(h.errors).toEqual([]);
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "refused",
    reason: "key_not_ready",
  });

  const revision = h.service.status().revision;
  const wrong = await h.service.unlockDeviceKey("not the passphrase");
  expect(wrong).toEqual({ outcome: "refused", reason: "wrong_passphrase" });
  expect(h.service.status().revision).toBe(revision);
  h.clock += unlockDelayMs(1);

  h.keyStatus = {
    protection: "passphrase",
    loaded: true,
    replacementPending: false,
    passphraseRequired: false,
  };
  const right = await h.service.unlockDeviceKey(PASSPHRASE);
  expect(right).toEqual({ outcome: "unlocked" });
  expect(h.service.status()).toMatchObject({
    deviceKey: "ready",
    replacementPending: false,
    revision: revision + 1,
  });
  await expect(h.service.unlockDeviceKey(PASSPHRASE)).resolves.toEqual({
    outcome: "refused",
    reason: "not_required",
  });

  // The passphrase is never sent back, kept in the status, or reported.
  const sent = JSON.stringify([h.statuses, wrong, right, h.errors]);
  expect(sent).not.toContain(PASSPHRASE);
  expect(sent).not.toContain("not the passphrase");
});

test("one unlock runs at a time, and an invalid passphrase or a damaged key is reported without the passphrase", async () => {
  const h = harness();
  let release: () => void = () => undefined;
  let next: DeviceKeyErrorCode = "passphrase_required";
  h.load = (passphrase) => {
    if (passphrase === undefined) {
      return Promise.reject(new DeviceKeyError("passphrase_required"));
    }
    return new Promise((_resolve, reject) => {
      release = () => reject(new DeviceKeyError(next));
    });
  };
  await h.service.initialize();

  next = "passphrase_invalid";
  const first = h.service.unlockDeviceKey("\ud800");
  await expect(h.service.unlockDeviceKey(PASSPHRASE)).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  await settle();
  release();
  await expect(first).resolves.toEqual({
    outcome: "refused",
    reason: "passphrase_invalid",
  });

  next = "corrupt";
  const second = h.service.unlockDeviceKey(PASSPHRASE);
  await settle();
  release();
  await expect(second).resolves.toEqual({ outcome: "failed" });
  expect(h.service.status().deviceKey).toBe("corrupt");
  expect(h.errors).toEqual(["The device key could not be loaded."]);
  expect(JSON.stringify([h.statuses, h.errors])).not.toContain(PASSPHRASE);
});

test("a sign-in moves from starting to waiting with the pairing code, and to its outcome", async () => {
  const h = harness();
  h.record = { kind: "none" };
  await h.service.initialize();
  const attempt = startedSignIn();
  let open: () => void = () => undefined;
  h.start = () =>
    new Promise((resolve) => {
      open = () => resolve(attempt.start);
    });

  const result = h.service.startSignIn();
  expect(h.service.status().signIn).toEqual({ kind: "starting" });
  await settle();
  open();
  await expect(result).resolves.toEqual({ outcome: "started" });
  expect(h.service.status().signIn).toEqual({
    kind: "waiting",
    pairingCode: "042137",
    opened: true,
  });
  expect(h.focused).toBe(0);

  // The browser posted to the listener: the window comes up at once, before
  // the answer of the API.
  h.callback?.();
  expect(h.service.status().signIn).toEqual({ kind: "completing" });
  expect(h.log.slice(-2)).toEqual(["status completing", "focus"]);

  // The account comes from the outcome, not from a record read.
  const done = nextStatus(h, (status) => status.signIn.kind === "idle");
  attempt.settle(SIGNED_IN_OUTCOME);
  const after = await done;

  expect(after).toMatchObject({
    account: {
      kind: "signed_in",
      login: "hubot",
      displayName: "Hubot",
      deviceId: OTHER_DEVICE_ID,
    },
    signIn: { kind: "idle" },
    lastOutcome: { code: "signed_in" },
  });
  await settle();
  expect(h.focused).toBe(1);
  expect(h.statuses.map((status) => status.signIn.kind)).toEqual([
    "idle",
    "starting",
    "waiting",
    "completing",
    "idle",
  ]);
  expect(h.statuses.map((status) => status.revision)).toEqual([1, 2, 3, 4, 5]);
  expect(JSON.stringify(h.statuses)).not.toContain(USER_ID);
});

test("when the browser did not open, the status holds the URL to copy and the warning", async () => {
  const h = harness();
  await h.service.initialize();
  h.start = async () => startedSignIn(false).start;

  await h.service.startSignIn();

  expect(h.service.status().signIn).toEqual({
    kind: "waiting",
    pairingCode: "042137",
    opened: false,
    authorizeUrl: AUTHORIZE_URL,
    warning: SIGN_IN_URL_WARNING,
    browser: "default",
  });
  expect(AccountStatusSchema.parse(h.service.status())).toEqual(
    h.service.status(),
  );
});

test("only one sign-in runs at a time, and a new one starts after the outcome on the same flow", async () => {
  const h = harness();
  await h.service.initialize();
  const attempt = startedSignIn();
  let open: () => void = () => undefined;
  h.start = () =>
    new Promise((resolve) => {
      open = () => resolve(attempt.start);
    });

  const first = h.service.startSignIn();
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  await settle();
  open();
  await first;
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  await expect(h.service.unlockDeviceKey(PASSPHRASE)).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  expect(h.log.filter((step) => step === "start")).toHaveLength(1);

  const done = nextStatus(h, (status) => status.signIn.kind === "idle");
  attempt.settle({ kind: "timed_out" });
  await done;
  h.start = async () => startedSignIn().start;
  h.clock += SIGN_IN_START_COOLDOWN_MS;

  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "started",
  });
  expect(h.log.filter((step) => step === "start")).toHaveLength(2);
  expect(h.flows).toBe(1);
});

test("cancel ends the open sign-in, and a cancel while it starts ends it once it started", async () => {
  const h = harness();
  await h.service.initialize();
  expect(h.service.cancelSignIn()).toBe(false);

  const waiting = startedSignIn();
  h.start = async () => waiting.start;
  await h.service.startSignIn();
  const cancelled = nextStatus(h, (status) => status.signIn.kind === "idle");
  expect(h.service.cancelSignIn()).toBe(true);
  expect(waiting.cancels()).toBe(1);
  expect((await cancelled).lastOutcome).toEqual({ code: "cancelled" });

  const starting = startedSignIn();
  h.clock += SIGN_IN_START_COOLDOWN_MS;
  let open: () => void = () => undefined;
  h.start = () =>
    new Promise((resolve) => {
      open = () => resolve(starting.start);
    });
  const result = h.service.startSignIn();
  // The flow's start is on its way.
  await settle();
  expect(h.log.at(-1)).toBe("start");
  expect(h.service.cancelSignIn()).toBe(true);
  expect(starting.cancels()).toBe(0);
  const ended = nextStatus(h, (status) => status.signIn.kind === "idle");
  await settle();
  open();
  await expect(result).resolves.toEqual({ outcome: "started" });
  expect(starting.cancels()).toBe(1);
  expect((await ended).lastOutcome).toEqual({ code: "cancelled" });
  expect(h.focused).toBe(0);
});

test("the window comes to the front once the browser posted to the listener, never for a cancel or a timeout", async () => {
  const cases: [SignInOutcome, boolean][] = [
    [SIGNED_IN_OUTCOME, true],
    [{ kind: "refused", code: "device_revoked" }, true],
    [{ kind: "failed", reason: "no_answer" }, true],
    [{ kind: "listener_error", error: "access_denied" }, true],
    [{ kind: "cancelled" }, false],
    [{ kind: "timed_out" }, false],
  ];
  for (const [outcome, posted] of cases) {
    const h = harness();
    await h.service.initialize();
    const attempt = startedSignIn();
    h.start = async () => attempt.start;
    await h.service.startSignIn();
    expect(h.focused).toBe(0);

    if (posted) {
      h.callback?.();
      h.callback?.();
      expect(h.focused).toBe(1);
    }
    const done = nextStatus(h, (status) => status.signIn.kind === "idle");
    attempt.settle(outcome);
    await done;
    await settle();

    expect(h.focused).toBe(posted ? 1 : 0);
  }
});

test("a callback before start returns shows the sign-in as completing, and a late callback of an old attempt changes nothing", async () => {
  const h = harness();
  await h.service.initialize();
  const first = startedSignIn();
  h.start = async () => {
    h.callback?.();
    return first.start;
  };

  await h.service.startSignIn();
  expect(h.service.status().signIn).toEqual({ kind: "completing" });
  expect(h.focused).toBe(1);
  const oldCallback = h.callback;
  const done = nextStatus(h, (status) => status.signIn.kind === "idle");
  first.settle({ kind: "timed_out" });
  await done;

  h.start = async () => startedSignIn().start;
  h.clock += SIGN_IN_START_COOLDOWN_MS;
  await h.service.startSignIn();
  oldCallback?.();
  expect(h.service.status().signIn).toMatchObject({ kind: "waiting" });
  expect(h.focused).toBe(1);
});

test("a sign-in that does not start leaves the status idle with its code, and the window where it is", async () => {
  const h = harness();
  await h.service.initialize();
  h.start = async () => ({
    started: false,
    outcome: { kind: "failed", reason: "api_origin_unset" },
  });

  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "failed",
    code: "api_origin_unset",
  });
  expect(h.service.status()).toMatchObject({
    signIn: { kind: "idle" },
    lastOutcome: { code: "api_origin_unset" },
  });

  h.start = () => Promise.reject(new Error("broken"));
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "failed",
    code: "failed",
  });
  expect(h.errors).toEqual(["The sign-in could not start."]);
  expect(h.focused).toBe(0);
  expect(h.statuses.map((status) => status.signIn.kind)).toEqual([
    "idle",
    "starting",
    "idle",
    "starting",
    "idle",
  ]);
});

test("after an outcome the account is read again, so a revoked device is signed out", async () => {
  const h = harness();
  await h.service.initialize();
  const attempt = startedSignIn();
  h.start = async () => attempt.start;
  await h.service.startSignIn();
  // The flow deleted the key and the record after `device_revoked`.
  h.record = { kind: "none" };

  const done = nextStatus(h, (status) => status.signIn.kind === "idle");
  attempt.settle({ kind: "refused", code: "device_revoked" });

  expect(await done).toMatchObject({
    account: { kind: "signed_out" },
    lastOutcome: { code: "device_revoked" },
  });
});

test("every outcome of the flow maps to a fixed code, and an unknown one to a generic code", () => {
  const view = (outcome: unknown) =>
    signInOutcomeView(outcome as SignInOutcome);

  expect(view(SIGNED_IN_OUTCOME)).toEqual({ code: "signed_in" });
  expect(view({ kind: "cancelled" })).toEqual({ code: "cancelled" });
  expect(view({ kind: "timed_out" })).toEqual({ code: "timed_out" });

  expect(
    Object.fromEntries(
      SIGN_IN_LISTENER_ERRORS.map((error) => [
        error,
        view({ kind: "listener_error", error }).code,
      ]),
    ),
  ).toEqual({
    access_denied: "access_denied",
    sign_in_failed: "sign_in_failed",
    unsupported_account: "unsupported_account",
    sign_in_unavailable: "sign_in_unavailable",
  });

  const refusals: Partial<Record<string, SignInOutcomeCode>> = {
    sign_in_required: "sign_in_required",
    device_account_mismatch: "device_account_mismatch",
    device_revoked: "device_revoked",
    device_registration_locked: "device_registration_locked",
    unsupported_account: "unsupported_account",
    sign_in_unavailable: "sign_in_unavailable",
  };
  for (const code of API_ERROR_CODES) {
    expect(view({ kind: "refused", code }), code).toEqual({
      code: refusals[code] ?? "refused",
    });
  }
  expect(
    view({
      kind: "refused",
      code: "device_account_mismatch",
      deviceLogin: "octocat",
    }),
  ).toEqual({ code: "device_account_mismatch", deviceLogin: "octocat" });

  expect(
    Object.fromEntries(
      SIGN_IN_FAILURE_REASONS.map((reason) => [
        reason,
        view({ kind: "failed", reason }).code,
      ]),
    ),
  ).toEqual({
    api_origin_unset: "api_origin_unset",
    api_origin_invalid: "api_origin_invalid",
    unsupported_platform: "unsupported_platform",
    label_invalid: "failed",
    already_running: "failed",
    key_not_loaded: "key_not_loaded",
    replacement_pending: "replacement_pending",
    key_store_failed: "key_store_failed",
    system_protection_unavailable: "system_protection_unavailable",
    record_unreadable: "record_unreadable",
    listener_unavailable: "listener_unavailable",
    no_answer: "no_answer",
    server_error: "server_error",
    unexpected_response: "unexpected_response",
    unexpected: "failed",
    uncertain_refusal: "uncertain_refusal",
    key_changed: "key_changed",
    record_not_saved: "record_not_saved",
  });
  // The API's code of an uncertain refusal is not passed on.
  for (const apiError of UNCERTAIN_REFUSAL_CODES) {
    expect(
      view({ kind: "failed", reason: "uncertain_refusal", apiError }),
    ).toEqual({ code: "uncertain_refusal" });
  }
  expect(
    view({
      kind: "failed",
      reason: "key_store_failed",
      keyError: "system_protection_unavailable",
    }),
  ).toEqual({ code: "system_protection_unavailable" });
  expect(
    view({ kind: "failed", reason: "key_store_failed", keyError: "corrupt" }),
  ).toEqual({ code: "key_store_failed" });

  // Values that a later flow or API could add, and prototype keys.
  expect(view({ kind: "failed", reason: "disk_full" })).toEqual({
    code: "failed",
  });
  expect(view({ kind: "failed", reason: "constructor" })).toEqual({
    code: "failed",
  });
  expect(view({ kind: "refused", code: "toString" })).toEqual({
    code: "refused",
  });
  expect(view({ kind: "listener_error", error: "server_error" })).toEqual({
    code: "sign_in_failed",
  });
  expect(view({ kind: "paused" })).toEqual({ code: "failed" });
});

test("This is not me asks for confirmation, removes the device at the API, deletes the record and the registration marker, resets the flow, deletes the key, and signs out", async () => {
  const h = harness();
  await h.service.initialize();
  h.start = async () => ({
    started: false,
    outcome: { kind: "failed", reason: "listener_unavailable" },
  });
  await h.service.startSignIn();
  expect(h.service.status().lastOutcome).toEqual({
    code: "listener_unavailable",
  });
  h.log.length = 0;

  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "forgotten",
    removedAtServer: true,
  });

  expect(h.log).toEqual([
    "confirm octocat",
    "session removeDevice",
    "delete record",
    "delete registration marker",
    "reset flow",
    "delete key",
    "status idle",
    "session refresh",
  ]);
  expect(h.service.status()).toMatchObject({
    account: { kind: "signed_out" },
    deviceKey: "ready",
    replacementPending: false,
    lastOutcome: null,
  });
  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });

  h.start = async () => startedSignIn().start;
  await h.service.startSignIn();
  expect(h.flows).toBe(1);
});

test("This is not me goes on when the registration marker cannot be deleted, so the key is deleted and names no marker", async () => {
  const h = harness();
  await h.service.initialize();
  h.markerDelete = () => Promise.reject(new Error("EBUSY"));
  h.log.length = 0;
  await expect(h.service.forgetAccount()).resolves.toMatchObject({
    outcome: "forgotten",
  });
  const recorded = h.log.indexOf("delete record");
  expect(h.log.slice(recorded, recorded + 3)).toEqual([
    "delete record",
    "delete registration marker",
    "delete key",
  ]);
  expect(h.errors).toEqual(["The registration marker could not be deleted."]);
});

test("This is not me also works while the key waits for its passphrase", async () => {
  const h = harness();
  h.load = () => Promise.reject(new DeviceKeyError("passphrase_required"));
  await h.service.initialize();

  h.removeDevice = async () => ({ ok: false, reason: "key_not_loaded" });

  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "forgotten",
    removedAtServer: false,
  });
  expect(h.service.status()).toMatchObject({
    account: { kind: "signed_out" },
    deviceKey: "ready",
  });
});

test("a failed delete is reported and the account is read again, so This is not me can be tried again", async () => {
  const h = harness();
  await h.service.initialize();
  // A start that does not get far still creates the flow.
  h.start = async () => ({
    started: false,
    outcome: { kind: "failed", reason: "listener_unavailable" },
  });
  await h.service.startSignIn();
  h.recordDelete = () => Promise.reject(new Error("EBUSY"));

  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "failed",
  });
  // While the record stays, the account and what the flow keeps for it stay.
  expect(h.log).not.toContain("delete key");
  expect(h.log).not.toContain("reset flow");
  expect(h.service.status().account.kind).toBe("signed_in");

  h.recordDelete = async () => {
    h.record = { kind: "none" };
  };
  h.keyDelete = () => Promise.reject(new Error("EBUSY"));
  h.log.length = 0;
  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "failed",
  });
  // The flow forgot the account before the key delete failed.
  expect(h.log.slice(0, 6)).toEqual([
    "confirm octocat",
    "session removeDevice",
    "delete record",
    "delete registration marker",
    "reset flow",
    "delete key",
  ]);
  // A key without a record or a registration marker is deleted by the next
  // sign-in.
  expect(h.service.status().account).toEqual({ kind: "signed_out" });
  expect(h.errors).toEqual([
    "The account could not be forgotten on this device.",
    "The account could not be forgotten on this device.",
  ]);
});

test("a listener that throws and a window that cannot come up are reported and change nothing", async () => {
  const h = harness();
  h.service.onStatusChange(() => {
    throw new Error("listener");
  });
  const focusing = createAccountService({
    apiOrigin: { ok: true, origin: "https://api.mymandev.example" },
    openSystem: () => ({
      keyStore: {
        load: async () => null,
        status: async () => ({ protection: "none" }),
        delete: async () => undefined,
      },
      deviceRecords: {
        read: async () => ({ kind: "none" }),
        delete: async () => undefined,
      },
      registrationMarkers: { delete: async () => undefined },
      createFlow: () => ({
        start: async (startOptions) => {
          callback = startOptions?.onCallback;
          return attempt.start;
        },
        reset: () => true,
      }),
      createSession: () => h.createSession(),
    }),
    focusWindow: () => {
      throw new Error("no window");
    },
    confirmForget: async () => true,
    confirmRemoveDevice: async () => true,
    onError: (message) => h.errors.push(message),
  });
  const attempt = startedSignIn();
  let callback: (() => void) | undefined;

  await h.service.initialize();
  await focusing.initialize();
  await focusing.startSignIn();
  callback?.();
  expect(focusing.status().signIn).toEqual({ kind: "completing" });
  const done = nextStatus(
    { ...h, service: focusing },
    (status) => status.signIn.kind === "idle",
  );
  attempt.settle({ kind: "refused", code: "device_revoked" });
  await done;
  await settle();

  expect(h.service.status().deviceKey).toBe("ready");
  expect(h.errors).toEqual([
    "An account status listener failed.",
    "The window could not be brought to the front.",
  ]);
});

test("This is not me deletes nothing when the person keeps the account or the confirmation fails, and waits while it is open", async () => {
  const h = harness();
  await h.service.initialize();
  h.confirm = async () => false;

  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "cancelled",
  });
  expect(h.log.slice(-1)).toEqual(["confirm octocat"]);

  h.confirm = () => Promise.reject(new Error("no dialog"));
  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "failed",
  });
  expect(h.errors).toEqual(["The confirmation could not be shown."]);

  let answer: (confirmed: boolean) => void = () => undefined;
  h.confirm = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  const forgetting = h.service.forgetAccount();
  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  answer(false);
  await expect(forgetting).resolves.toEqual({ outcome: "cancelled" });

  expect(h.log).not.toContain("delete record");
  expect(h.log).not.toContain("delete key");
  expect(h.service.status().account.kind).toBe("signed_in");
});

test("the confirmation of This is not me names the login, offers Keep as the default, and only the remove button confirms", () => {
  expect(FORGET_CONFIRMATION).toEqual({
    type: "warning",
    buttons: ["Remove from this installation", "Keep"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "This is not me",
    detail:
      "The device key and the account are deleted on this computer. When this device is signed in with a usable key and the server can be reached, it is first removed from that account; otherwise it stays listed there, without a key, until its sign-in ends or the account removes it. You can then sign in with your own GitHub account.",
  });
  expect(Object.isFrozen(FORGET_CONFIRMATION)).toBe(true);
  expect(Object.isFrozen(FORGET_CONFIRMATION.buttons)).toBe(true);
  expect(forgetConfirmationMessage("octocat")).toBe(
    "Remove the GitHub account octocat from this installation?",
  );
  expect(forgetConfirmed({ response: 0 })).toBe(true);
  for (const response of [1, 2, -1]) {
    expect(forgetConfirmed({ response })).toBe(false);
  }
});

test("a start within the cooldown after one that opened the browser is refused as too soon", async () => {
  const h = harness();
  await h.service.initialize();
  const first = startedSignIn();
  h.start = async () => first.start;
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "started",
  });
  const cancelled = nextStatus(h, (status) => status.signIn.kind === "idle");
  h.service.cancelSignIn();
  await cancelled;

  h.start = async () => startedSignIn().start;
  h.clock += SIGN_IN_START_COOLDOWN_MS - 1;
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "refused",
    reason: "too_soon",
  });
  expect(h.log.filter((step) => step === "start")).toHaveLength(1);

  h.clock += 1;
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "started",
  });
  expect(h.log.filter((step) => step === "start")).toHaveLength(2);
});

test("a start in another browser opens no browser, offers the URL with the warning, and counts for the cooldown", async () => {
  const h = harness();
  await h.service.initialize();
  const attempt = startedSignIn(false);
  h.start = async () => attempt.start;

  await expect(h.service.startSignIn({ browser: "other" })).resolves.toEqual({
    outcome: "started",
  });
  expect(h.openBrowser).toEqual([false]);
  expect(h.service.status().signIn).toEqual({
    kind: "waiting",
    pairingCode: "042137",
    opened: false,
    authorizeUrl: AUTHORIZE_URL,
    warning: SIGN_IN_URL_WARNING,
    browser: "other",
  });
  for (const options of [undefined, { browser: "other" } as const]) {
    await expect(h.service.startSignIn(options)).resolves.toEqual({
      outcome: "refused",
      reason: "busy",
    });
  }

  const cancelled = nextStatus(h, (status) => status.signIn.kind === "idle");
  expect(h.service.cancelSignIn()).toBe(true);
  expect(attempt.cancels()).toBe(1);
  expect((await cancelled).lastOutcome).toEqual({ code: "cancelled" });

  h.start = async () => startedSignIn().start;
  h.clock += SIGN_IN_START_COOLDOWN_MS - 1;
  for (const options of [undefined, { browser: "other" } as const]) {
    await expect(h.service.startSignIn(options)).resolves.toEqual({
      outcome: "refused",
      reason: "too_soon",
    });
  }
  h.clock += 1;
  await expect(h.service.startSignIn({ browser: "default" })).resolves.toEqual({
    outcome: "started",
  });
  expect(h.openBrowser).toEqual([false, true]);
});

test("a sign-in that waits in the browser ends with a cancel before a start in another browser can follow", async () => {
  const h = harness();
  await h.service.initialize();
  const first = startedSignIn();
  h.start = async () => first.start;
  await h.service.startSignIn();
  expect(h.service.status().signIn).toMatchObject({
    kind: "waiting",
    opened: true,
  });
  await expect(h.service.startSignIn({ browser: "other" })).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  expect(first.cancels()).toBe(0);

  h.clock += SIGN_IN_START_COOLDOWN_MS;
  const cancelled = nextStatus(h, (status) => status.signIn.kind === "idle");
  expect(h.service.cancelSignIn()).toBe(true);
  expect(first.cancels()).toBe(1);
  // The attempt stays open until its outcome is recorded.
  await expect(h.service.startSignIn({ browser: "other" })).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  expect((await cancelled).lastOutcome).toEqual({ code: "cancelled" });

  const second = startedSignIn(false);
  h.start = async () => second.start;
  await expect(h.service.startSignIn({ browser: "other" })).resolves.toEqual({
    outcome: "started",
  });
  expect(h.openBrowser).toEqual([true, false]);
  expect(h.service.status().signIn).toEqual({
    kind: "waiting",
    pairingCode: "042137",
    opened: false,
    authorizeUrl: AUTHORIZE_URL,
    warning: SIGN_IN_URL_WARNING,
    browser: "other",
  });
});

test("a start that did not open the browser does not hold back the next one", async () => {
  const h = harness();
  await h.service.initialize();
  h.start = async () => ({
    started: false,
    outcome: { kind: "failed", reason: "listener_unavailable" },
  });
  await h.service.startSignIn();

  h.start = async () => startedSignIn().start;
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "started",
  });
});

test("after a wrong passphrase the next unlock waits 1 second, doubling up to 30 seconds, also for the right passphrase", async () => {
  expect([0, 1, 2, 3, 4, 5, 6, 100].map(unlockDelayMs)).toEqual([
    0,
    1_000,
    2_000,
    4_000,
    8_000,
    16_000,
    30_000,
    UNLOCK_DELAY_MAX_MS,
  ]);

  const h = harness();
  h.load = async (passphrase) => {
    if (passphrase !== PASSPHRASE) {
      throw new DeviceKeyError(
        passphrase === undefined ? "passphrase_required" : "wrong_passphrase",
      );
    }
  };
  await h.service.initialize();
  const loads = () => h.log.filter((step) => step === "load with passphrase");

  for (const delay of [1_000, 2_000, 4_000]) {
    await expect(h.service.unlockDeviceKey("wrong")).resolves.toEqual({
      outcome: "refused",
      reason: "wrong_passphrase",
    });
    const tried = loads().length;
    h.clock += delay - 1;
    // Also the right passphrase waits; the store is not asked.
    await expect(h.service.unlockDeviceKey(PASSPHRASE)).resolves.toEqual({
      outcome: "refused",
      reason: "too_soon",
    });
    expect(loads()).toHaveLength(tried);
    h.clock += 1;
  }

  await expect(h.service.unlockDeviceKey(PASSPHRASE)).resolves.toEqual({
    outcome: "unlocked",
  });
  expect(h.service.status().deviceKey).toBe("ready");
});

test("the contract's limits follow the protocol and the key store", () => {
  expect(ACCOUNT_LIMITS.displayName).toBe(LIMITS.displayName);
  expect(ACCOUNT_LIMITS.deviceLabel).toBe(LIMITS.deviceLabel);
  expect(ACCOUNT_LIMITS.devices).toBe(MAX_ANSWER_LIST_ITEMS);
  // NFC can join up to four UTF-16 code units into one character, and the
  // store counts characters after normalization.
  expect(ACCOUNT_LIMITS.passphrase).toBeGreaterThanOrEqual(
    4 * PASSPHRASE_MAX_CHARACTERS,
  );
  const login = AccountStatusSchema.shape.account.options[1].shape.login;
  for (const value of [
    "octocat",
    "a",
    "a-b_c",
    "x".repeat(39),
    "",
    "a b",
    "x".repeat(40),
    "\u00e9",
  ]) {
    expect(login.safeParse(value).success, value).toBe(
      GITHUB_LOGIN_PATTERN.test(value),
    );
  }
});

// ---- The device session (part 3 of #94) ---------------------------------

test("the session is created after the key's load, also for a key that waits for its passphrase, and refreshed at startup", async () => {
  const h = harness();
  h.load = () => Promise.reject(new DeviceKeyError("passphrase_required"));
  h.sessionState = { kind: "key_not_loaded", account: SESSION_ACCOUNT };

  await h.service.initialize();

  expect(h.log).toEqual([
    "load",
    "session create",
    "read record",
    "status idle",
    "session refresh",
  ]);
  expect(h.service.status().device).toBe("key_not_loaded");

  // The unlock refreshes the session, which reads the loaded key.
  h.sessionState = SESSION_SIGNED_IN;
  h.load = async () => undefined;
  await expect(h.service.unlockDeviceKey(PASSPHRASE)).resolves.toEqual({
    outcome: "unlocked",
  });
  await settle();
  // The new state reaches the status, and the account is read again.
  expect(h.log.slice(-5)).toEqual([
    "load with passphrase",
    "status idle",
    "session refresh",
    "status idle",
    "read record",
  ]);
  expect(h.service.status().device).toBe("signed_in");
});

test("a sign-out that the API has not learned is reported at startup", async () => {
  const h = harness();
  h.sessionState = {
    kind: "signed_out",
    account: SESSION_ACCOUNT,
    reportPending: true,
  };

  await h.service.initialize();

  expect(h.log.slice(-2)).toEqual(["session refresh", "session reportSignOut"]);
  expect(h.service.status().device).toBe("sign_out_report_pending");
  h.emit({
    kind: "signed_out",
    account: SESSION_ACCOUNT,
    reportPending: false,
  });
  expect(h.service.status().device).toBe("signed_out");
});

test("a session that cannot be created is reported, and its actions are refused", async () => {
  const h = harness();
  h.createSession = () => {
    throw new Error("The device session needs a ready application.");
  };

  await h.service.initialize();

  expect(h.service.status()).toMatchObject({
    account: { kind: "signed_in" },
    deviceKey: "ready",
    device: "unavailable",
  });
  expect(h.errors).toEqual(["The device session could not be created."]);
  for (const action of [
    h.service.signOut,
    h.service.removeDevice,
    h.service.listDevices,
  ]) {
    await expect(action()).resolves.toEqual({
      outcome: "refused",
      reason: "not_signed_in",
    });
  }
  // A sign-in and "This is not me" still work without the session.
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "started",
  });
});

test("every state of the session reaches the status as its code, without the account's user ID or sign-in expiry", async () => {
  const h = harness();
  await h.service.initialize();
  const states: [DeviceSessionState, string][] = [
    [{ kind: "starting" }, "starting"],
    [{ kind: "no_device" }, "no_device"],
    [{ kind: "key_lost", account: SESSION_ACCOUNT }, "key_lost"],
    [{ kind: "unavailable", reason: "record_unreadable" }, "unavailable"],
    [{ kind: "key_not_loaded", account: SESSION_ACCOUNT }, "key_not_loaded"],
    [SESSION_SIGNED_IN, "signed_in"],
    [
      { kind: "signed_out", account: SESSION_ACCOUNT, reportPending: false },
      "signed_out",
    ],
    [
      { kind: "signed_out", account: SESSION_ACCOUNT, reportPending: true },
      "sign_out_report_pending",
    ],
    [
      { kind: "sign_in_required", account: SESSION_ACCOUNT },
      "sign_in_required",
    ],
    [{ kind: "auth_failed", account: SESSION_ACCOUNT }, "auth_failed"],
    [
      { kind: "account_mismatch", account: SESSION_ACCOUNT },
      "account_mismatch",
    ],
    [{ kind: "removal_pending", account: SESSION_ACCOUNT }, "removal_pending"],
    [{ kind: "removed" }, "removed"],
    [{ kind: "revoked" }, "revoked"],
  ];
  for (const [state, code] of states) {
    h.emit(state);
    expect(h.service.status().device).toBe(code);
    expect(AccountStatusSchema.parse(h.service.status())).toEqual(
      h.service.status(),
    );
  }
  await settle();
  const sent = JSON.stringify(h.statuses);
  expect(sent).not.toContain(USER_ID);
  expect(sent).not.toContain("2026-12-02T10:00:00.000Z");
  expect(sent).not.toContain(PUBLIC_KEY);
});

test("a revoked device stops local execution once, resets the flow, and reads the account again", async () => {
  const h = harness();
  await h.service.initialize();
  h.start = async () => ({
    started: false,
    outcome: { kind: "failed", reason: "listener_unavailable" },
  });
  await h.service.startSignIn();
  h.log.length = 0;

  // The session deleted the key and then the record.
  h.record = { kind: "none" };
  h.emit({ kind: "revoked" });
  expect(h.log.slice(0, 3)).toEqual([
    "stop local execution",
    "reset flow",
    "status idle",
  ]);
  await settle();
  expect(h.service.status()).toMatchObject({
    account: { kind: "signed_out" },
    device: "revoked",
  });
  h.emit({ kind: "revoked" });
  expect(h.stopped).toBe(1);

  // A device that is revoked again later stops again.
  h.emit({ kind: "no_device" });
  h.emit({ kind: "revoked" });
  expect(h.stopped).toBe(2);

  // A local execution that cannot be stopped is reported.
  const failing = harness({
    stopLocalExecution: () => {
      throw new Error("busy");
    },
  });
  await failing.service.initialize();
  failing.emit({ kind: "revoked" });
  expect(failing.errors).toEqual(["The local execution could not be stopped."]);
  expect(failing.service.status().device).toBe("revoked");
});

test("a sign-in tells the session when it starts and how it ended, also when it did not start", async () => {
  const outcomes: SignInOutcome[] = [
    SIGNED_IN_OUTCOME,
    {
      kind: "refused",
      code: "device_account_mismatch",
      deviceLogin: "octocat",
    },
    { kind: "failed", reason: "uncertain_refusal", apiError: "auth_failed" },
    { kind: "cancelled" },
  ];
  for (const outcome of outcomes) {
    const h = harness();
    await h.service.initialize();
    const attempt = startedSignIn();
    h.start = async () => attempt.start;
    h.log.length = 0;

    await h.service.startSignIn();
    const done = nextStatus(h, (status) => status.signIn.kind === "idle");
    attempt.settle(outcome);
    await done;

    const detail =
      outcome.kind === "refused"
        ? ` ${outcome.code}`
        : outcome.kind === "failed"
          ? ` ${outcome.reason}`
          : "";
    expect(h.log.filter((step) => step.startsWith("session"))).toEqual([
      "session signInStarted",
      `session signInFinished ${outcome.kind}${detail}`,
    ]);
    expect(h.log.indexOf("session signInStarted")).toBeLessThan(
      h.log.indexOf("start"),
    );
  }

  const h = harness();
  await h.service.initialize();
  h.log.length = 0;
  h.start = async () => ({
    started: false,
    outcome: { kind: "failed", reason: "api_origin_unset" },
  });
  await h.service.startSignIn();
  h.clock += SIGN_IN_START_COOLDOWN_MS;
  h.start = () => Promise.reject(new Error("broken"));
  await h.service.startSignIn();
  expect(h.log.filter((step) => step.startsWith("session"))).toEqual([
    "session signInStarted",
    "session signInFinished failed api_origin_unset",
    "session signInStarted",
    "session signInFinished failed unexpected",
  ]);
});

test("the session's state after a sign-in reaches the status", async () => {
  const h = harness();
  h.sessionState = { kind: "no_device" };
  h.record = { kind: "none" };
  await h.service.initialize();
  expect(h.service.status().device).toBe("no_device");
  const attempt = startedSignIn();
  h.start = async () => attempt.start;
  await h.service.startSignIn();

  h.sessionState = SESSION_SIGNED_IN;
  const done = nextStatus(h, (status) => status.signIn.kind === "idle");
  attempt.settle(SIGNED_IN_OUTCOME);

  expect(await done).toMatchObject({
    device: "signed_in",
    lastOutcome: { code: "signed_in" },
  });
});

const REPLACEMENT_PENDING: SignInStart = Object.freeze({
  started: false,
  outcome: Object.freeze({ kind: "failed", reason: "replacement_pending" }),
});

test("a pending replacement that an authentication resolves starts the flow once more", async () => {
  const h = harness();
  await h.service.initialize();
  const attempt = startedSignIn();
  const starts = [REPLACEMENT_PENDING, attempt.start];
  h.start = async () => starts.shift() ?? REPLACEMENT_PENDING;
  h.keyStatus = {
    protection: "system",
    loaded: true,
    replacementPending: true,
    passphraseRequired: false,
  };
  h.authenticate = async () => {
    // The new key authenticated: the session confirmed the replacement.
    h.keyStatus = {
      protection: "system",
      loaded: true,
      replacementPending: false,
      passphraseRequired: false,
    };
    return { ok: true, value: SESSION_ACCOUNT };
  };
  h.log.length = 0;

  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "started",
  });

  expect(h.log.filter((step) => step !== "status starting")).toEqual([
    "session signInStarted",
    "create flow 1",
    "start",
    "session signInFinished failed replacement_pending",
    "session authenticate",
    "session signInStarted",
    "start",
    "status waiting",
  ]);
  expect(h.flows).toBe(1);
});

test("a start in another browser keeps its option when the flow starts once more after a resolved replacement", async () => {
  const h = harness();
  await h.service.initialize();
  const starts = [REPLACEMENT_PENDING, startedSignIn(false).start];
  h.start = async () => starts.shift() ?? REPLACEMENT_PENDING;
  h.keyStatus = {
    protection: "system",
    loaded: true,
    replacementPending: true,
    passphraseRequired: false,
  };
  h.authenticate = async () => {
    h.keyStatus = {
      protection: "system",
      loaded: true,
      replacementPending: false,
      passphraseRequired: false,
    };
    return { ok: true, value: SESSION_ACCOUNT };
  };

  await expect(h.service.startSignIn({ browser: "other" })).resolves.toEqual({
    outcome: "started",
  });
  expect(h.openBrowser).toEqual([false, false]);
  expect(h.service.status().signIn).toMatchObject({
    kind: "waiting",
    opened: false,
    warning: SIGN_IN_URL_WARNING,
    browser: "other",
  });
});

test("both keys lost in the authentication also start the flow once more, which then registers a new device", async () => {
  const h = harness();
  await h.service.initialize();
  const starts = [REPLACEMENT_PENDING, startedSignIn().start];
  h.start = async () => starts.shift() ?? REPLACEMENT_PENDING;
  h.keyStatus = {
    protection: "system",
    loaded: true,
    replacementPending: true,
    passphraseRequired: false,
  };
  h.authenticate = async () => {
    // A second round refused both keys: the session deleted them.
    h.keyStatus = { protection: "none" };
    return { ok: false, reason: "key_lost" };
  };

  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "started",
  });
  expect(h.log.filter((step) => step === "start")).toHaveLength(2);
});

test("a pending replacement that the authentication does not resolve is reported without a second start, and the flow never loops", async () => {
  {
    // No answer: the store still holds the replacement.
    const h = harness();
    await h.service.initialize();
    h.start = async () => REPLACEMENT_PENDING;
    h.keyStatus = {
      protection: "system",
      loaded: true,
      replacementPending: true,
      passphraseRequired: false,
    };
    h.authenticate = async () => ({ ok: false, reason: "no_answer" });

    await expect(h.service.startSignIn()).resolves.toEqual({
      outcome: "failed",
      code: "replacement_pending",
    });
    expect(h.log.filter((step) => step === "start")).toHaveLength(1);
    expect(
      h.log.filter((step) => step === "session authenticate"),
    ).toHaveLength(1);
  }

  // The store says the replacement is resolved, but the flow answers
  // `replacement_pending` again: the second answer is shown as it is.
  const h = harness();
  await h.service.initialize();
  h.start = async () => REPLACEMENT_PENDING;
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "failed",
    code: "replacement_pending",
  });
  expect(h.log.filter((step) => step === "start")).toHaveLength(2);
  expect(h.log.filter((step) => step === "session authenticate")).toHaveLength(
    1,
  );
  expect(h.log.filter((step) => step === "session signInStarted")).toHaveLength(
    2,
  );
  expect(h.service.status().lastOutcome).toEqual({
    code: "replacement_pending",
  });

  // An authentication or a key store that throws counts as unresolved.
  for (const broken of ["authenticate", "status"] as const) {
    const b = harness();
    await b.service.initialize();
    b.start = async () => REPLACEMENT_PENDING;
    if (broken === "authenticate") {
      b.authenticate = () => Promise.reject(new Error("broken"));
    } else {
      b.keyStatus = new Error("EIO");
    }
    await expect(b.service.startSignIn()).resolves.toEqual({
      outcome: "failed",
      code: "replacement_pending",
    });
    expect(b.log.filter((step) => step === "start")).toHaveLength(1);
    expect(b.errors).toEqual([
      "The pending key replacement could not be resolved.",
    ]);
  }
});

test("a cancel while the pending replacement is resolved starts nothing more", async () => {
  const h = harness();
  await h.service.initialize();
  h.start = async () => REPLACEMENT_PENDING;
  let answer: () => void = () => undefined;
  h.authenticate = () =>
    new Promise((resolve) => {
      answer = () => resolve({ ok: true, value: SESSION_ACCOUNT });
    });

  const result = h.service.startSignIn();
  await settle();
  expect(h.log.at(-1)).toBe("session authenticate");
  expect(h.service.status().signIn).toEqual({ kind: "starting" });
  expect(h.service.cancelSignIn()).toBe(true);
  answer();

  await expect(result).resolves.toEqual({
    outcome: "failed",
    code: "replacement_pending",
  });
  expect(h.log.filter((step) => step === "start")).toHaveLength(1);
});

test("sign-out asks the session, which keeps the key, and maps its answer", async () => {
  const h = harness();
  await h.service.initialize();
  h.signOut = async () => {
    h.emit({
      kind: "signed_out",
      account: SESSION_ACCOUNT,
      reportPending: false,
    });
    return { ok: true, value: "reported" };
  };

  await expect(h.service.signOut()).resolves.toEqual({
    outcome: "signed_out",
  });
  expect(h.log).not.toContain("delete key");
  expect(h.log).not.toContain("delete record");
  expect(h.service.status()).toMatchObject({
    account: { kind: "signed_in", login: "octocat" },
    device: "signed_out",
  });

  h.signOut = async () => ({ ok: true, value: "pending" });
  await expect(h.service.signOut()).resolves.toEqual({ outcome: "pending" });

  for (const [failure, reason] of [
    [{ ok: false, reason: "key_not_loaded" }, "key_not_loaded"],
    [{ ok: false, reason: "no_device" }, "no_device"],
    [
      { ok: false, reason: "refused", code: "device_revoked" },
      "device_revoked",
    ],
    [{ ok: false, reason: "refused", code: "conflict" }, "refused"],
    [{ ok: false, reason: "invalid_request" }, "failed"],
  ] as const) {
    h.signOut = async () => failure;
    await expect(h.service.signOut()).resolves.toEqual({
      outcome: "failed",
      reason,
    });
  }

  h.signOut = () => Promise.reject(new Error("broken"));
  await expect(h.service.signOut()).resolves.toEqual({
    outcome: "failed",
    reason: "failed",
  });
  expect(h.errors).toEqual(["The sign-out failed."]);
});

test("sign-out, removal, and the device list are refused while busy and without an account", async () => {
  const before = harness();
  for (const action of [
    before.service.signOut,
    before.service.removeDevice,
    before.service.listDevices,
  ]) {
    await expect(action()).resolves.toEqual({
      outcome: "refused",
      reason: "busy",
    });
  }

  const h = harness();
  await h.service.initialize();
  const attempt = startedSignIn();
  h.start = async () => attempt.start;
  await h.service.startSignIn();
  for (const action of [
    h.service.signOut,
    h.service.removeDevice,
    h.service.listDevices,
  ]) {
    await expect(action()).resolves.toEqual({
      outcome: "refused",
      reason: "busy",
    });
  }
  const done = nextStatus(h, (status) => status.signIn.kind === "idle");
  attempt.settle({ kind: "cancelled" });
  await done;

  let release: () => void = () => undefined;
  h.signOut = () =>
    new Promise((resolve) => {
      release = () => resolve({ ok: true, value: "reported" });
    });
  const signingOut = h.service.signOut();
  for (const action of [
    h.service.signOut,
    h.service.removeDevice,
    h.service.listDevices,
    h.service.forgetAccount,
  ]) {
    await expect(action()).resolves.toEqual({
      outcome: "refused",
      reason: "busy",
    });
  }
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
  });
  release();
  await expect(signingOut).resolves.toEqual({ outcome: "signed_out" });

  const signedOut = harness();
  signedOut.record = { kind: "none" };
  await signedOut.service.initialize();
  for (const action of [
    signedOut.service.signOut,
    signedOut.service.removeDevice,
    signedOut.service.listDevices,
  ]) {
    await expect(action()).resolves.toEqual({
      outcome: "refused",
      reason: "not_signed_in",
    });
  }
  expect(signedOut.log.filter((step) => step.startsWith("session"))).toEqual([
    "session create",
    "session refresh",
  ]);
});

test("removing this device asks for confirmation, then the session, and resets the flow once the API confirmed", async () => {
  const h = harness();
  await h.service.initialize();
  h.start = async () => ({
    started: false,
    outcome: { kind: "failed", reason: "listener_unavailable" },
  });
  await h.service.startSignIn();
  h.log.length = 0;
  h.removeDevice = async () => {
    h.record = { kind: "none" };
    h.emit({ kind: "removed" });
    return { ok: true, value: "removed" };
  };

  await expect(h.service.removeDevice()).resolves.toEqual({
    outcome: "removed",
  });
  expect(h.log.slice(0, 2)).toEqual([
    "confirm removal octocat",
    "session removeDevice",
  ]);
  expect(h.log).toContain("reset flow");
  expect(h.log).not.toContain("stop local execution");
  await settle();
  expect(h.service.status()).toMatchObject({
    account: { kind: "signed_out" },
    device: "removed",
  });
});

test("a removal without a clear answer stays pending, and a refusal or a failure is mapped", async () => {
  const h = harness();
  await h.service.initialize();
  h.removeDevice = async () => {
    h.emit({ kind: "removal_pending", account: SESSION_ACCOUNT });
    return { ok: true, value: "pending" };
  };

  await expect(h.service.removeDevice()).resolves.toEqual({
    outcome: "pending",
  });
  expect(h.service.status().device).toBe("removal_pending");
  expect(h.log).not.toContain("reset flow");

  for (const [failure, reason] of [
    [{ ok: false, reason: "signed_out" }, "signed_out"],
    [{ ok: false, reason: "refused", code: "rate_limited" }, "rate_limited"],
    [
      { ok: false, reason: "refused", code: "sign_in_required" },
      "sign_in_required",
    ],
    [{ ok: false, reason: "refused", code: "conflict" }, "refused"],
  ] as const) {
    h.removeDevice = async () => failure;
    await expect(h.service.removeDevice()).resolves.toEqual({
      outcome: "failed",
      reason,
    });
  }
  h.removeDevice = () => Promise.reject(new Error("broken"));
  await expect(h.service.removeDevice()).resolves.toEqual({
    outcome: "failed",
    reason: "failed",
  });
  expect(h.errors).toEqual(["The device could not be removed."]);
});

test("removing this device asks nothing of the session when the person keeps it or the confirmation fails, and waits while it is open", async () => {
  const h = harness();
  await h.service.initialize();
  h.confirmRemoval = async () => false;
  await expect(h.service.removeDevice()).resolves.toEqual({
    outcome: "cancelled",
  });

  h.confirmRemoval = () => Promise.reject(new Error("no dialog"));
  await expect(h.service.removeDevice()).resolves.toEqual({
    outcome: "failed",
    reason: "failed",
  });
  expect(h.errors).toEqual(["The confirmation could not be shown."]);

  let answer: (confirmed: boolean) => void = () => undefined;
  h.confirmRemoval = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  const removing = h.service.removeDevice();
  for (const action of [
    h.service.removeDevice,
    h.service.signOut,
    h.service.forgetAccount,
  ]) {
    await expect(action()).resolves.toEqual({
      outcome: "refused",
      reason: "busy",
    });
  }
  answer(false);
  await expect(removing).resolves.toEqual({ outcome: "cancelled" });
  expect(h.log).not.toContain("session removeDevice");
});

test("the device list holds only the fields that the renderer may see, with the current device marked", async () => {
  const h = harness();
  await h.service.initialize();
  h.listDevices = async () => ({
    ok: true,
    value: [
      { ...DEVICE_ITEM, publicKey: PUBLIC_KEY, userId: USER_ID },
      {
        ...DEVICE_ITEM,
        id: OTHER_DEVICE_ID,
        label: "Windows computer",
        platform: "windows",
        lastSeenAt: null,
        revokedAt: "2026-11-02T08:00:00.000Z",
        current: false,
      },
    ],
  });

  const listed = await h.service.listDevices();

  expect(listed).toEqual({
    outcome: "listed",
    devices: [
      {
        id: DEVICE_ID,
        label: "Mac",
        platform: "macos",
        lastSeenAt: "2026-11-02T09:00:00.000Z",
        signInExpiresAt: "2026-12-01T10:00:00.000Z",
        revokedAt: null,
        current: true,
      },
      {
        id: OTHER_DEVICE_ID,
        label: "Windows computer",
        platform: "windows",
        lastSeenAt: null,
        signInExpiresAt: "2026-12-01T10:00:00.000Z",
        revokedAt: "2026-11-02T08:00:00.000Z",
        current: false,
      },
    ],
  });
  expect(JSON.stringify(listed)).not.toMatch(
    new RegExp(`${PUBLIC_KEY}|${USER_ID}|createdAt|lastSignInAt`),
  );

  h.listDevices = async () => ({ ok: false, reason: "no_answer" });
  h.clock += LIST_DEVICES_COOLDOWN_MS;
  await expect(h.service.listDevices()).resolves.toEqual({
    outcome: "failed",
    reason: "no_answer",
  });
  h.listDevices = () => Promise.reject(new Error("broken"));
  h.clock += LIST_DEVICES_COOLDOWN_MS;
  await expect(h.service.listDevices()).resolves.toEqual({
    outcome: "failed",
    reason: "failed",
  });
  expect(h.errors).toEqual(["The device list could not be read."]);
});

test("This is not me forgets the account on this installation also when the API removal is pending, refused, or fails", async () => {
  const answers: [
    string,
    () => Promise<SessionResult<"removed" | "pending">>,
    string[],
  ][] = [
    ["pending", async () => ({ ok: true, value: "pending" }), []],
    ["signed out", async () => ({ ok: false, reason: "signed_out" }), []],
    [
      "refused",
      async () => ({ ok: false, reason: "refused", code: "conflict" }),
      [],
    ],
    [
      "broken",
      () => Promise.reject(new Error("broken")),
      ["The device could not be removed at the server."],
    ],
  ];
  for (const [name, removeDevice, errors] of answers) {
    const h = harness();
    await h.service.initialize();
    h.removeDevice = removeDevice;
    h.log.length = 0;

    await expect(h.service.forgetAccount(), name).resolves.toEqual({
      outcome: "forgotten",
      removedAtServer: false,
    });
    expect(h.log).toEqual([
      "confirm octocat",
      "session removeDevice",
      "delete record",
      "delete registration marker",
      "delete key",
      "status idle",
      "session refresh",
    ]);
    expect(h.errors).toEqual(errors);
    expect(h.service.status().account).toEqual({ kind: "signed_out" });
  }
});

// ---- Review fixes: background refresh, removal, list --------------------

/** Holds the fake session's next `reportSignOut` until `release`. */
function holdReport(h: Harness): () => void {
  let release: () => void = () => undefined;
  const answer = h.reportSignOut;
  h.reportSignOut = () => {
    h.reportSignOut = answer;
    return new Promise((resolve) => {
      release = () => resolve({ ok: true, value: "reported" });
    });
  };
  return () => release();
}

const SIGNED_OUT_PENDING: DeviceSessionState = Object.freeze({
  kind: "signed_out",
  account: SESSION_ACCOUNT,
  reportPending: true,
});

test("This is not me waits for the background refresh before it asks, removes, or deletes anything", async () => {
  const h = harness();
  h.sessionState = SIGNED_OUT_PENDING;
  const release = holdReport(h);

  const initializing = h.service.initialize();
  await settle();
  expect(h.log.at(-1)).toBe("session reportSignOut");
  const forgetting = h.service.forgetAccount();
  // The forget holds the lock while it waits: other actions are busy.
  for (const action of [
    h.service.forgetAccount,
    h.service.signOut,
    h.service.removeDevice,
    h.service.listDevices,
  ]) {
    await expect(action()).resolves.toEqual({
      outcome: "refused",
      reason: "busy",
    });
  }
  await settle();
  expect(h.log.at(-1)).toBe("session reportSignOut");

  release();
  await initializing;
  await expect(forgetting).resolves.toEqual({
    outcome: "forgotten",
    removedAtServer: true,
  });
  const reported = h.log.indexOf("session reportSignOut");
  expect(h.log.slice(reported + 1, reported + 4)).toEqual([
    "confirm octocat",
    "session removeDevice",
    "delete record",
  ]);
});

test("every action of the session waits for the background refresh, also the one after an unlock", async () => {
  const actions: [string, (h: Harness) => Promise<unknown>, string][] = [
    ["sign-out", (h) => h.service.signOut(), "session signOut"],
    ["removal", (h) => h.service.removeDevice(), "confirm removal octocat"],
    ["list", (h) => h.service.listDevices(), "session listDevices"],
    ["sign-in", (h) => h.service.startSignIn(), "session signInStarted"],
  ];
  for (const [name, act, step] of actions) {
    const h = harness();
    h.load = async (passphrase) => {
      if (passphrase === undefined) {
        throw new DeviceKeyError("passphrase_required");
      }
    };
    await h.service.initialize();
    // After the unlock the session finds the sign-out to report.
    h.sessionState = SIGNED_OUT_PENDING;
    const release = holdReport(h);
    await h.service.unlockDeviceKey(PASSPHRASE);
    await settle();
    expect(h.log.at(-1), name).toBe("session reportSignOut");
    h.emit(SESSION_SIGNED_IN);

    const acting = act(h);
    await settle();
    expect(h.log, name).not.toContain(step);
    release();
    await acting;
    expect(h.log.indexOf(step), name).toBeGreaterThan(
      h.log.indexOf("session reportSignOut"),
    );
  }
});

test("sign-out is refused while a removal is pending, so a confirmed removal is never dropped", async () => {
  const h = harness();
  h.sessionState = { kind: "removal_pending", account: SESSION_ACCOUNT };
  await h.service.initialize();

  await expect(h.service.signOut()).resolves.toEqual({
    outcome: "failed",
    reason: "removal_pending",
  });
  expect(h.log).not.toContain("session signOut");
  // The removal can be retried.
  await expect(h.service.removeDevice()).resolves.toEqual({
    outcome: "removed",
  });
});

test("removing this device is refused before the confirmation while the key waits for its passphrase", async () => {
  const h = harness();
  h.load = () => Promise.reject(new DeviceKeyError("passphrase_required"));
  h.sessionState = { kind: "key_not_loaded", account: SESSION_ACCOUNT };
  await h.service.initialize();

  await expect(h.service.removeDevice()).resolves.toEqual({
    outcome: "failed",
    reason: "key_not_loaded",
  });
  expect(h.log.filter((step) => step.startsWith("confirm"))).toEqual([]);
  expect(h.log).not.toContain("session removeDevice");
});

test("the device list takes the lock, waits a cooldown between requests, and is dropped when the account changed meanwhile", async () => {
  const h = harness();
  await h.service.initialize();
  let answer: () => void = () => undefined;
  h.listDevices = () =>
    new Promise((resolve) => {
      answer = () => resolve({ ok: true, value: [DEVICE_ITEM] });
    });

  const listing = h.service.listDevices();
  await settle();
  for (const action of [
    h.service.signOut,
    h.service.removeDevice,
    h.service.forgetAccount,
  ]) {
    await expect(action()).resolves.toEqual({
      outcome: "refused",
      reason: "busy",
    });
  }
  answer();
  await expect(listing).resolves.toMatchObject({ outcome: "listed" });

  h.clock += LIST_DEVICES_COOLDOWN_MS - 1;
  await expect(h.service.listDevices()).resolves.toEqual({
    outcome: "refused",
    reason: "too_soon",
  });
  expect(h.log.filter((step) => step === "session listDevices")).toHaveLength(
    1,
  );

  // The session finds the device revoked while the list is on its way.
  h.clock += 1;
  h.listDevices = async () => {
    h.emit({ kind: "revoked" });
    return { ok: true, value: [DEVICE_ITEM] };
  };
  await expect(h.service.listDevices()).resolves.toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
});

test("a cancel while the sign-in waits for the background refresh never opens the browser", async () => {
  const h = harness();
  h.sessionState = SIGNED_OUT_PENDING;
  const release = holdReport(h);
  const initializing = h.service.initialize();
  await settle();
  expect(h.log.at(-1)).toBe("session reportSignOut");

  const starting = h.service.startSignIn();
  await settle();
  expect(h.service.status().signIn).toEqual({ kind: "starting" });
  expect(h.service.cancelSignIn()).toBe(true);
  release();
  await initializing;

  await expect(starting).resolves.toEqual({
    outcome: "failed",
    code: "cancelled",
  });
  expect(h.log).not.toContain("start");
  expect(h.log).not.toContain("session signInStarted");
  expect(h.flows).toBe(0);
  expect(h.service.status()).toMatchObject({
    signIn: { kind: "idle" },
    lastOutcome: { code: "cancelled" },
  });
  // The next start is not held back by a cooldown: no browser opened.
  await expect(h.service.startSignIn()).resolves.toEqual({
    outcome: "started",
  });
});

test("a sign-in between the key's load and the startup refresh waits for the refresh", async () => {
  const h = harness();
  let release: () => void = () => undefined;
  h.readGate = new Promise((resolve) => {
    release = resolve;
  });
  const initializing = h.service.initialize();
  await settle();
  // The key is loaded, and the record read is on its way.
  expect(h.log).toEqual(["load", "session create", "read record"]);

  const starting = h.service.startSignIn();
  await settle();
  expect(h.log).not.toContain("start");
  h.readGate = null;
  release();
  await initializing;

  await expect(starting).resolves.toEqual({ outcome: "started" });
  expect(h.log.indexOf("start")).toBeGreaterThan(
    h.log.indexOf("session refresh"),
  );
});

// ---- Connection (#26) --------------------------------------------------

test("the connection's challenge is signed by the session, and only the frame or nothing comes back", async () => {
  const h = harness();
  await expect(
    h.service.signWebSocketChallenge(CHALLENGE),
    "before the session exists",
  ).resolves.toEqual({ ok: false });
  await h.service.initialize();
  h.log.length = 0;

  await expect(h.service.signWebSocketChallenge(CHALLENGE)).resolves.toEqual({
    ok: true,
    frame: AUTH_RESPONSE,
  });
  expect(h.log).toEqual(["session signWebSocketChallenge"]);

  // A failure keeps its reason and the API's code inside the main process.
  h.signChallenge = async () => ({
    ok: false,
    reason: "refused",
    code: "sign_in_required",
  });
  await expect(h.service.signWebSocketChallenge(CHALLENGE)).resolves.toEqual({
    ok: false,
  });

  h.signChallenge = () => Promise.reject(new Error("broken"));
  await expect(h.service.signWebSocketChallenge(CHALLENGE)).resolves.toEqual({
    ok: false,
  });
  expect(h.errors).toEqual(["The connection's challenge could not be signed."]);
});

test("a pending replacement is resolved with one authentication before the challenge is signed again", async () => {
  const h = harness();
  await h.service.initialize();
  const answers: SessionResult<AuthResponseFrame>[] = [
    { ok: false, reason: "replacement_pending" },
    { ok: true, value: AUTH_RESPONSE },
  ];
  h.signChallenge = async () =>
    answers.shift() ?? { ok: false, reason: "replacement_pending" };
  h.log.length = 0;

  await expect(h.service.signWebSocketChallenge(CHALLENGE)).resolves.toEqual({
    ok: true,
    frame: AUTH_RESPONSE,
  });
  expect(h.log.filter((line) => line.startsWith("session"))).toEqual([
    "session signWebSocketChallenge",
    "session authenticate",
    "session signWebSocketChallenge",
  ]);
  // The key's replacement is read again for the status.
  expect(h.log).toContain("read record");

  // An authentication that fails is not followed by a second signature, and
  // a second `replacement_pending` is not retried.
  const cases: [SessionResult<SessionAccount>, string[]][] = [
    [
      { ok: false, reason: "no_answer" },
      ["session signWebSocketChallenge", "session authenticate"],
    ],
    [
      { ok: true, value: SESSION_ACCOUNT },
      [
        "session signWebSocketChallenge",
        "session authenticate",
        "session signWebSocketChallenge",
      ],
    ],
  ];
  for (const [authenticated, calls] of cases) {
    h.authenticate = async () => authenticated;
    h.signChallenge = async () => ({
      ok: false,
      reason: "replacement_pending",
    });
    h.log.length = 0;
    await expect(h.service.signWebSocketChallenge(CHALLENGE)).resolves.toEqual({
      ok: false,
    });
    expect(h.log.filter((line) => line.startsWith("session"))).toEqual(calls);
  }
});

test("the authentication for a pending replacement waits for no action and runs none while an action holds the key", async () => {
  const h = harness();
  await h.service.initialize();
  h.signChallenge = async () => ({ ok: false, reason: "replacement_pending" });
  let finishSignOut: (
    value: SessionResult<"reported" | "pending">,
  ) => void = () => undefined;
  h.signOut = () =>
    new Promise((resolve) => {
      finishSignOut = resolve;
    });
  const signingOut = h.service.signOut();
  await new Promise((resolve) => setImmediate(resolve));
  h.log.length = 0;

  await expect(h.service.signWebSocketChallenge(CHALLENGE)).resolves.toEqual({
    ok: false,
  });
  expect(h.log.filter((line) => line.startsWith("session"))).toEqual([
    "session signWebSocketChallenge",
  ]);

  finishSignOut({ ok: true, value: "reported" });
  await signingOut;
});

test("a close reason of the connection reaches the session for the connection's device, and device_revoked stops local execution once", async () => {
  const h = harness();
  await h.service.initialize();
  h.refuseDevice = async (code) => {
    const next: DeviceSessionState =
      code === "device_revoked"
        ? { kind: "revoked" }
        : { kind: "sign_in_required", account: SESSION_ACCOUNT };
    // The session publishes the state, then answers with it.
    h.emit(next);
    return next;
  };
  const seen: string[] = [];
  const original = h.refuseDevice;
  h.refuseDevice = async (code, deviceId) => {
    seen.push(`${code} ${deviceId}`);
    return original(code, deviceId);
  };

  await h.service.deviceRefused("sign_in_required", DEVICE_ID);
  expect(h.service.status().device).toBe("sign_in_required");
  expect(h.stopped).toBe(0);

  await h.service.deviceRefused("device_revoked", DEVICE_ID);
  expect(seen).toEqual([
    `sign_in_required ${DEVICE_ID}`,
    `device_revoked ${DEVICE_ID}`,
  ]);
  expect(h.service.status()).toMatchObject({
    device: "revoked",
    account: { kind: "signed_out" },
  });
  expect(h.stopped).toBe(1);
});

test("a refusal that the session ignores changes nothing, and one that fails still stops local execution after device_revoked", async () => {
  const h = harness();
  await h.service.initialize();
  // Another device: the session keeps its state.
  h.refuseDevice = async () => SESSION_SIGNED_IN;
  await h.service.deviceRefused("device_revoked", OTHER_DEVICE_ID);
  expect(h.service.status().device).toBe("signed_in");
  expect(h.stopped).toBe(0);

  h.refuseDevice = () => Promise.reject(new Error("broken"));
  await h.service.deviceRefused("sign_in_required", DEVICE_ID);
  expect(h.stopped).toBe(0);
  await h.service.deviceRefused("device_revoked", DEVICE_ID);
  expect(h.stopped).toBe(1);
  expect(h.errors).toEqual([
    "The device session could not apply the connection's refusal.",
    "The device session could not apply the connection's refusal.",
  ]);
});

// ---- Workspace reads (#27, #28) ----------------------------------------

/** Waits until the pending promise callbacks and I/O callbacks have run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Makes the session's next answers wait; the result settles them. */
function heldAnswer(h: Harness) {
  let finish: (result: SessionResult<unknown>) => void = () => undefined;
  h.request = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  return (result: SessionResult<unknown>) => finish(result);
}

test("a workspace read goes to the session with the allowlist's route, parameters, query, and cap, and only the parsed answer comes back", async () => {
  const h = harness();
  await h.service.initialize();
  h.log.length = 0;

  await expect(
    h.service.readWorkspaceData("listWorkspaces", {}),
  ).resolves.toEqual({ ok: true, value: WORKSPACE_LIST });
  await expect(
    h.service.readWorkspaceData(
      "listMessages",
      { projectId: PROJECT_ID },
      { beforeSeq: 120 },
    ),
  ).resolves.toEqual({ ok: true, value: WORKSPACE_LIST });
  expect(h.log).toEqual([
    "session request /workspaces",
    "session request /projects/:projectId/messages",
  ]);
  expect(h.requests).toEqual([
    {
      route: WORKSPACE_READS.listWorkspaces.route,
      params: {},
      answer: WORKSPACE_READS.listWorkspaces.answer,
      maxAnswerBytes: 2 * 1024 * 1024,
    },
    {
      route: WORKSPACE_READS.listMessages.route,
      params: { projectId: PROJECT_ID },
      query: { beforeSeq: "120", limit: "50" },
      answer: WORKSPACE_READS.listMessages.answer,
      maxAnswerBytes: 4 * 1024 * 1024,
    },
  ]);
});

test("only the allowlist's reads are sent, checked by type and at runtime", async () => {
  const h = harness();
  await h.service.initialize();
  const read = h.service.readWorkspaceData;
  const refused: (() => Promise<unknown>)[] = [
    // @ts-expect-error A route that is not on the allowlist.
    () => read("listDevices", {}),
    // @ts-expect-error A POST route of the protocol.
    () => read("createWorkspace", {}),
    () => read("toString" as "listWorkspaces", {}),
    // @ts-expect-error A query for a read that takes none.
    () => read("listAgents", { projectId: PROJECT_ID }, { limit: 5 }),
    // @ts-expect-error A missing path parameter.
    () => read("getWorkspace", {}),
    () =>
      read("getWorkspace", {
        workspaceId: WORKSPACE_ID,
        extra: WORKSPACE_ID,
      } as never),
    // A page larger than the cap holds.
    () => read("listMessages", { projectId: PROJECT_ID }, { limit: 51 }),
    () => read("listMessages", { projectId: PROJECT_ID }, { beforeSeq: 0 }),
  ];
  for (const call of refused) {
    await expect(call()).resolves.toEqual({ ok: false, reason: "failed" });
  }
  expect(h.requests).toEqual([]);
});

test("a read is not signed in without an account, and maps the session's failures to a closed set", async () => {
  const none = harness();
  none.record = { kind: "none" };
  await none.service.initialize();
  await expect(
    none.service.readWorkspaceData("listWorkspaces", {}),
  ).resolves.toEqual({ ok: false, reason: "not_signed_in" });
  expect(none.requests).toEqual([]);

  const h = harness();
  await h.service.initialize();
  const cases: [SessionResult<unknown>, string][] = [
    [{ ok: false, reason: "refused", code: "not_found" }, "not_found"],
    [{ ok: false, reason: "refused", code: "rate_limited" }, "rate_limited"],
    [{ ok: false, reason: "refused", code: "unauthorized" }, "not_signed_in"],
    [{ ok: false, reason: "refused", code: "forbidden" }, "failed"],
    [{ ok: false, reason: "signed_out" }, "not_signed_in"],
    [{ ok: false, reason: "removal_pending" }, "not_signed_in"],
    [{ ok: false, reason: "sign_in_running" }, "unavailable"],
    [{ ok: false, reason: "no_answer" }, "unavailable"],
    [{ ok: false, reason: "server_error" }, "unavailable"],
    // An answer too large or outside the response schema.
    [{ ok: false, reason: "unexpected_response" }, "failed"],
  ];
  for (const [result, reason] of cases) {
    h.request = async () => result;
    await expect(
      h.service.readWorkspaceData("listRuns", { projectId: PROJECT_ID }),
      JSON.stringify(result),
    ).resolves.toEqual({ ok: false, reason });
  }

  h.request = () => Promise.reject(new Error("broken"));
  await expect(
    h.service.readWorkspaceData("listAgents", { projectId: PROJECT_ID }),
  ).resolves.toEqual({ ok: false, reason: "unavailable" });
  expect(h.errors).toEqual(["The workspace data could not be read."]);
});

test("a read takes no lock: an action runs while a read is on its way", async () => {
  const h = harness();
  await h.service.initialize();
  const finish = heldAnswer(h);
  const reading = h.service.readWorkspaceData("listWorkspaces", {});
  await tick();
  expect(h.requests).toHaveLength(1);

  await expect(h.service.listDevices()).resolves.toMatchObject({
    outcome: "listed",
  });

  finish({ ok: true, value: WORKSPACE_LIST });
  await expect(reading).resolves.toEqual({ ok: true, value: WORKSPACE_LIST });
});

test("a read is unavailable during This is not me, a sign-out, and a device removal", async () => {
  const h = harness();
  await h.service.initialize();

  let confirm: (value: boolean) => void = () => undefined;
  h.confirm = () =>
    new Promise((resolve) => {
      confirm = resolve;
    });
  const forgetting = h.service.forgetAccount();
  await tick();
  await expect(
    h.service.readWorkspaceData("listWorkspaces", {}),
  ).resolves.toEqual({ ok: false, reason: "unavailable" });
  confirm(false);
  await forgetting;

  let signedOut: (value: SessionResult<"reported" | "pending">) => void = () =>
    undefined;
  h.signOut = () =>
    new Promise((resolve) => {
      signedOut = resolve;
    });
  const signingOut = h.service.signOut();
  await tick();
  await expect(
    h.service.readWorkspaceData("getWorkspace", { workspaceId: WORKSPACE_ID }),
  ).resolves.toEqual({ ok: false, reason: "unavailable" });
  signedOut({ ok: true, value: "reported" });
  await signingOut;

  h.confirmRemoval = () =>
    new Promise((resolve) => {
      confirm = resolve;
    });
  const removing = h.service.removeDevice();
  await tick();
  await expect(
    h.service.readWorkspaceData("listProjects", { workspaceId: WORKSPACE_ID }),
  ).resolves.toEqual({ ok: false, reason: "unavailable" });
  confirm(false);
  await removing;

  expect(h.requests).toEqual([]);
});

test("a read is unavailable during a sign-in, also with a pending key replacement, and the answer of a read that a sign-in overtook is dropped", async () => {
  const h = harness();
  h.keyStatus = {
    protection: "system",
    loaded: true,
    replacementPending: true,
    passphraseRequired: false,
  };
  await h.service.initialize();
  expect(h.service.status().replacementPending).toBe(true);

  // A read that is on its way when the sign-in starts.
  const finish = heldAnswer(h);
  const overtaken = h.service.readWorkspaceData("listWorkspaces", {});
  await tick();

  const signIn = startedSignIn();
  h.start = async () => signIn.start;
  await expect(h.service.startSignIn()).resolves.toMatchObject({
    outcome: "started",
  });
  await expect(
    h.service.readWorkspaceData("listAgents", { projectId: PROJECT_ID }),
  ).resolves.toEqual({ ok: false, reason: "unavailable" });
  expect(h.requests).toHaveLength(1);

  finish({ ok: true, value: WORKSPACE_LIST });
  await expect(overtaken).resolves.toEqual({
    ok: false,
    reason: "unavailable",
  });
  signIn.settle({ kind: "cancelled" });
});

test("a read during the startup waits for the startup refresh and is sent after it", async () => {
  const h = harness();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const createSession = h.createSession;
  h.createSession = () => {
    const session = createSession();
    return {
      ...session,
      refresh: async () => {
        await gate;
        return session.refresh();
      },
    };
  };
  const initializing = h.service.initialize();
  // Before the key is loaded, and then while the refresh runs.
  const early = h.service.readWorkspaceData("listWorkspaces", {});
  await tick();
  const reading = h.service.readWorkspaceData("listProjects", {
    workspaceId: WORKSPACE_ID,
  });
  await tick();
  expect(h.log).not.toContain("session refresh");
  expect(h.requests).toEqual([]);

  release();
  await initializing;
  await expect(early).resolves.toEqual({ ok: true, value: WORKSPACE_LIST });
  await expect(reading).resolves.toEqual({ ok: true, value: WORKSPACE_LIST });
  expect(h.log.indexOf("session request /workspaces")).toBeGreaterThan(
    h.log.indexOf("session refresh"),
  );
});

test("an answer is dropped when the signed-in device changed while the read was on its way", async () => {
  const h = harness();
  await h.service.initialize();

  // The device is revoked meanwhile: no device is signed in.
  let finish = heldAnswer(h);
  let reading = h.service.readWorkspaceData("listRuns", {
    projectId: PROJECT_ID,
  });
  await tick();
  h.emit({ kind: "revoked" });
  finish({ ok: true, value: WORKSPACE_LIST });
  await expect(reading).resolves.toEqual({
    ok: false,
    reason: "not_signed_in",
  });

  // Another device signed in meanwhile: the caller reads again for it.
  const other = harness();
  await other.service.initialize();
  finish = heldAnswer(other);
  reading = other.service.readWorkspaceData("listRuns", {
    projectId: PROJECT_ID,
  });
  await tick();
  other.record = {
    kind: "record",
    record: { ...RECORD, deviceId: OTHER_DEVICE_ID },
  };
  // The session moves through another state, so that the service reads the
  // record again.
  other.emit({ kind: "no_device" });
  other.emit({
    kind: "signed_in",
    account: { ...SESSION_ACCOUNT, deviceId: OTHER_DEVICE_ID },
  });
  await tick();
  expect(other.service.status().account).toMatchObject({
    deviceId: OTHER_DEVICE_ID,
  });
  finish({ ok: true, value: WORKSPACE_LIST });
  await expect(reading).resolves.toEqual({ ok: false, reason: "unavailable" });
});

test("an answer is dropped when an action began and ended while the read was on its way", async () => {
  const h = harness();
  await h.service.initialize();

  // A sign-out that starts and ends: the record is kept, the same device
  // stays in the account, and no action runs when the answer arrives.
  let finish = heldAnswer(h);
  let reading: Promise<unknown> = h.service.readWorkspaceData("listMessages", {
    projectId: PROJECT_ID,
  });
  await tick();
  await expect(h.service.signOut()).resolves.toEqual({
    outcome: "signed_out",
  });
  expect(h.service.status().account).toMatchObject({
    kind: "signed_in",
    deviceId: DEVICE_ID,
  });
  finish({ ok: true, value: WORKSPACE_LIST });
  await expect(reading).resolves.toEqual({ ok: false, reason: "unavailable" });

  // A removal that ends as pending.
  finish = heldAnswer(h);
  reading = h.service.readWorkspaceData("listAgents", {
    projectId: PROJECT_ID,
  });
  await tick();
  h.removeDevice = async () => ({ ok: true, value: "pending" });
  await expect(h.service.removeDevice()).resolves.toEqual({
    outcome: "pending",
  });
  finish({ ok: true, value: WORKSPACE_LIST });
  await expect(reading).resolves.toEqual({ ok: false, reason: "unavailable" });

  // A sign-in attempt that starts and is cancelled.
  finish = heldAnswer(h);
  reading = h.service.readWorkspaceData("listRuns", { projectId: PROJECT_ID });
  await tick();
  const signIn = startedSignIn();
  h.start = async () => signIn.start;
  await expect(h.service.startSignIn()).resolves.toMatchObject({
    outcome: "started",
  });
  expect(h.service.cancelSignIn()).toBe(true);
  await tick();
  expect(h.service.status().signIn).toEqual({ kind: "idle" });
  finish({ ok: true, value: WORKSPACE_LIST });
  await expect(reading).resolves.toEqual({ ok: false, reason: "unavailable" });

  // Without a change, the next answer comes back.
  h.request = async () => ({ ok: true, value: WORKSPACE_LIST });
  await expect(
    h.service.readWorkspaceData("listWorkspaces", {}),
  ).resolves.toEqual({ ok: true, value: WORKSPACE_LIST });
});

test("an answer is dropped when the device signed out without an action while the read was on its way, and kept when it only became signed in", async () => {
  const h = harness();
  await h.service.initialize();

  // For example a close reason of the connection.
  let finish = heldAnswer(h);
  let reading = h.service.readWorkspaceData("listWorkspaces", {});
  await tick();
  h.emit({
    kind: "signed_out",
    account: SESSION_ACCOUNT,
    reportPending: false,
  });
  finish({ ok: true, value: WORKSPACE_LIST });
  await expect(reading).resolves.toEqual({ ok: false, reason: "unavailable" });

  // Signed in again, for example after `refresh`: nothing ended.
  h.emit({ kind: "auth_failed", account: SESSION_ACCOUNT });
  finish = heldAnswer(h);
  reading = h.service.readWorkspaceData("listWorkspaces", {});
  await tick();
  h.emit(SESSION_SIGNED_IN);
  finish({ ok: true, value: WORKSPACE_LIST });
  await expect(reading).resolves.toEqual({ ok: true, value: WORKSPACE_LIST });
});
