import {
  API_ERROR_CODES,
  type DeviceId,
  GITHUB_LOGIN_PATTERN,
  LIMITS,
  type UserId,
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
  type AccountSystem,
  createAccountService,
  signInOutcomeView,
} from "./account.ts";
import {
  DeviceKeyError,
  type DeviceKeyErrorCode,
} from "./device-key/errors.ts";
import { PASSPHRASE_MAX_CHARACTERS } from "./device-key/key-file.ts";
import type { DeviceKeyStatus } from "./device-key/store.ts";
import type { DeviceRecord, DeviceRecordRead } from "./device-record.ts";
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
  /** The `onCallback` that the service passed to the last `start`. */
  callback: (() => void) | undefined;
  recordDelete: () => Promise<void>;
  keyDelete: () => Promise<void>;
}

function harness(
  overrides: Partial<
    Pick<AccountServiceOptions, "apiOrigin" | "openSystem">
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
    callback: undefined,
    recordDelete: async () => undefined,
    keyDelete: async () => undefined,
  } as Omit<Harness, "service">;
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
    createFlow: () => {
      state.flows += 1;
      state.log.push(`create flow ${state.flows}`);
      return {
        start: (options) => {
          state.log.push("start");
          state.callback = options?.onCallback;
          return state.start();
        },
        reset: () => {
          state.log.push("reset flow");
          return true;
        },
      };
    },
  };
  const service = createAccountService({
    apiOrigin: { ok: true, origin: "https://api.mymandev.example" },
    openSystem: () => system,
    focusWindow: () => {
      state.focused += 1;
      state.log.push("focus");
    },
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

  expect(h.log).toEqual(["load", "read record", "status idle"]);
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
  let open: () => void = () => undefined;
  h.start = () =>
    new Promise((resolve) => {
      open = () => resolve(starting.start);
    });
  const result = h.service.startSignIn();
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

test("This is not me deletes the record, then the key, signs out, and resets the flow", async () => {
  const h = harness();
  await h.service.initialize();
  h.start = async () => ({
    started: false,
    outcome: { kind: "failed", reason: "replacement_pending" },
  });
  await h.service.startSignIn();
  expect(h.service.status().lastOutcome).toEqual({
    code: "replacement_pending",
  });
  h.log.length = 0;

  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "forgotten",
  });

  expect(h.log).toEqual([
    "delete record",
    "delete key",
    "reset flow",
    "status idle",
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

test("This is not me also works while the key waits for its passphrase", async () => {
  const h = harness();
  h.load = () => Promise.reject(new DeviceKeyError("passphrase_required"));
  await h.service.initialize();

  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "forgotten",
  });
  expect(h.service.status()).toMatchObject({
    account: { kind: "signed_out" },
    deviceKey: "ready",
  });
});

test("a failed delete is reported and the account is read again, so This is not me can be tried again", async () => {
  const h = harness();
  await h.service.initialize();
  h.recordDelete = () => Promise.reject(new Error("EBUSY"));

  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "failed",
  });
  expect(h.log).not.toContain("delete key");
  expect(h.service.status().account.kind).toBe("signed_in");

  h.recordDelete = async () => {
    h.record = { kind: "none" };
  };
  h.keyDelete = () => Promise.reject(new Error("EBUSY"));
  await expect(h.service.forgetAccount()).resolves.toEqual({
    outcome: "failed",
  });
  // A key without a record is deleted by the next sign-in.
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
      createFlow: () => ({
        start: async (startOptions) => {
          callback = startOptions?.onCallback;
          return attempt.start;
        },
        reset: () => true,
      }),
    }),
    focusWindow: () => {
      throw new Error("no window");
    },
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

test("the contract's limits follow the protocol and the key store", () => {
  expect(ACCOUNT_LIMITS.displayName).toBe(LIMITS.displayName);
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
