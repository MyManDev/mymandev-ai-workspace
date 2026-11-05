import { expect, test } from "vitest";
import type { AccountBridge } from "../shared/desktop-bridge.ts";
import {
  type AccountStatus,
  DEVICE_ACTION_FAILURES,
  DEVICE_KEY_STATES,
  DEVICE_STATES,
  SIGN_IN_OUTCOME_CODES,
  START_SIGN_IN_REFUSALS,
  type StartSignInResult,
  UNLOCK_REFUSALS,
} from "../shared/ipc-contract.ts";
import { unlockMessage } from "./AccountPanel.tsx";
import {
  ACTION_MESSAGES,
  apiOriginProblem,
  createIdleWaits,
  START_REFUSAL_MESSAGES,
  DEVICE_ACTION_FAILURE_MESSAGES,
  DEVICE_ACTION_MESSAGES,
  DEVICE_KEY_PROBLEM_MESSAGES,
  DEVICE_STATE_MESSAGES,
  describeDeviceState,
  describeOutcome,
  deviceDetail,
  forgetMessage,
  initialAccountView,
  listDevicesMessage,
  offersSignIn,
  removeDeviceMessage,
  SIGN_IN_OUTCOME_MESSAGES,
  signOutMessage,
  startInAnotherBrowser,
  startMessage,
} from "./account-view.ts";

const IDLE: AccountStatus = {
  revision: 3,
  account: { kind: "signed_out" },
  signIn: { kind: "idle" },
  lastOutcome: { code: "cancelled" },
  deviceKey: "ready",
  replacementPending: false,
  apiOrigin: "set",
  device: "no_device",
};

const WAITING: AccountStatus = {
  ...IDLE,
  revision: 2,
  signIn: { kind: "waiting", pairingCode: "042137", opened: true },
  lastOutcome: null,
};

/** The start and cancel of the bridge, with answers that the test gives. */
function fakeAccount() {
  const fake = {
    log: [] as string[],
    cancel: async (): Promise<boolean> => true,
    start: async (): Promise<StartSignInResult> => ({ outcome: "started" }),
  };
  const account: Pick<AccountBridge, "startSignIn" | "cancelSignIn"> = {
    startSignIn: (options) => {
      fake.log.push(`start ${JSON.stringify(options)}`);
      return fake.start();
    },
    cancelSignIn: () => {
      fake.log.push("cancel");
      return fake.cancel();
    },
  };
  return Object.assign(fake, { account });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

test("the view starts pending with the bridge and unavailable without it", () => {
  expect(initialAccountView(true)).toEqual({ kind: "pending" });
  expect(initialAccountView(false)).toEqual({ kind: "unavailable" });
});

test("every outcome code has its own message, and only a success or a cancel is not an alert", () => {
  expect(Object.keys(SIGN_IN_OUTCOME_MESSAGES).sort()).toEqual(
    [...SIGN_IN_OUTCOME_CODES].sort(),
  );
  const texts = SIGN_IN_OUTCOME_CODES.map(
    (code) => describeOutcome({ code }).text,
  );
  expect(new Set(texts).size).toBe(texts.length);
  for (const code of SIGN_IN_OUTCOME_CODES) {
    expect(describeOutcome({ code }).role, code).toBe(
      code === "signed_in" || code === "cancelled" ? "status" : "alert",
    );
  }
});

test("an account mismatch names the installation's login when the main process sent it", () => {
  expect(
    describeOutcome({ code: "device_account_mismatch", deviceLogin: "hubot" }),
  ).toEqual({
    role: "alert",
    text: "This installation belongs to the GitHub account hubot. Sign in with that account.",
  });
  expect(describeOutcome({ code: "device_account_mismatch" }).text).toBe(
    SIGN_IN_OUTCOME_MESSAGES.device_account_mismatch,
  );
});

test("every key state that blocks the key has a message", () => {
  expect(Object.keys(DEVICE_KEY_PROBLEM_MESSAGES).sort()).toEqual(
    DEVICE_KEY_STATES.filter(
      (state) =>
        state !== "loading" &&
        state !== "ready" &&
        state !== "passphrase_required",
    ).sort(),
  );
});

test("a server address problem disables the sign-in with its message", () => {
  expect(apiOriginProblem("set")).toBeUndefined();
  expect(apiOriginProblem("unset")).toBe(
    SIGN_IN_OUTCOME_MESSAGES.api_origin_unset,
  );
  expect(apiOriginProblem("invalid")).toBe(
    SIGN_IN_OUTCOME_MESSAGES.api_origin_invalid,
  );
});

test("every unlock result has a message, or none when the status says it", () => {
  expect(unlockMessage({ outcome: "unlocked" })).toBeUndefined();
  expect(unlockMessage({ outcome: "failed" })).toBeUndefined();
  expect(
    UNLOCK_REFUSALS.map((reason) =>
      unlockMessage({ outcome: "refused", reason }),
    ),
  ).toEqual([
    ACTION_MESSAGES.unlockNotRequired,
    ACTION_MESSAGES.unlockBusy,
    ACTION_MESSAGES.wrongPassphrase,
    ACTION_MESSAGES.passphraseInvalid,
    ACTION_MESSAGES.unlockTooSoon,
  ]);
});

test("every refused start has its own message", () => {
  expect(Object.keys(START_REFUSAL_MESSAGES).sort()).toEqual(
    [...START_SIGN_IN_REFUSALS].sort(),
  );
  const texts = Object.values(START_REFUSAL_MESSAGES);
  expect(new Set(texts).size).toBe(texts.length);
  for (const reason of START_SIGN_IN_REFUSALS) {
    expect(startMessage({ outcome: "refused", reason })).toBe(
      START_REFUSAL_MESSAGES[reason],
    );
  }
  expect(startMessage({ outcome: "started" })).toBeUndefined();
  expect(startMessage({ outcome: "failed", code: "failed" })).toBeUndefined();
  expect(startMessage(undefined)).toBeUndefined();
});

test("another browser without an open sign-in starts at once, with the option and without a cancel", async () => {
  const fake = fakeAccount();
  const waits = createIdleWaits();

  await expect(
    startInAnotherBrowser(fake.account, false, waits.wait),
  ).resolves.toEqual({ outcome: "started" });
  expect(fake.log).toEqual(['start {"browser":"other"}']);

  // The main process's refusal reaches the panel as it is.
  fake.start = async () => ({ outcome: "refused", reason: "too_soon" });
  await expect(
    startInAnotherBrowser(fake.account, false, waits.wait),
  ).resolves.toEqual({ outcome: "refused", reason: "too_soon" });
});

test("another browser while a sign-in waits cancels it first and starts once it ended as cancelled", async () => {
  const fake = fakeAccount();
  const waits = createIdleWaits();

  const result = startInAnotherBrowser(fake.account, true, waits.wait);
  await settle();
  expect(fake.log).toEqual(["cancel"]);

  // A status that is not idle yet starts nothing.
  waits.status(WAITING);
  await settle();
  expect(fake.log).toEqual(["cancel"]);

  waits.status(IDLE);
  await expect(result).resolves.toEqual({ outcome: "started" });
  expect(fake.log).toEqual(["cancel", 'start {"browser":"other"}']);
});

test("another browser starts nothing when the waiting sign-in ended otherwise or had already ended", async () => {
  const fake = fakeAccount();
  const waits = createIdleWaits();

  // The browser posted meanwhile, and the sign-in completed.
  const completed = startInAnotherBrowser(fake.account, true, waits.wait);
  await settle();
  waits.status({ ...IDLE, lastOutcome: { code: "signed_in" } });
  await expect(completed).resolves.toBeUndefined();

  // No sign-in was open any more.
  fake.cancel = async () => false;
  await expect(
    startInAnotherBrowser(fake.account, true, waits.wait),
  ).resolves.toBeUndefined();
  // Its wait ended too: a later idle status starts nothing.
  waits.status(IDLE);
  await settle();
  expect(fake.log).toEqual(["cancel", "cancel"]);
});

test("another browser starts nothing when the cancel fails or the status is no longer followed", async () => {
  const fake = fakeAccount();
  const waits = createIdleWaits();

  fake.cancel = async () => {
    throw new Error("refused");
  };
  await expect(
    startInAnotherBrowser(fake.account, true, waits.wait),
  ).rejects.toThrow("refused");

  fake.cancel = async () => true;
  const unfollowed = startInAnotherBrowser(fake.account, true, waits.wait);
  await settle();
  waits.end();
  await expect(unfollowed).resolves.toBeUndefined();

  waits.status(IDLE);
  await settle();
  expect(fake.log).toEqual(["cancel", "cancel"]);
});

test("an idle status ends every wait with it, and a stopped wait ends without one", async () => {
  const waits = createIdleWaits();
  const first = waits.wait();
  const second = waits.wait();
  const stopped = waits.wait();
  stopped.stop();
  await expect(stopped.idle).resolves.toBeUndefined();

  waits.status(WAITING);
  waits.status(IDLE);
  await expect(first.idle).resolves.toBe(IDLE);
  await expect(second.idle).resolves.toBe(IDLE);

  const late = waits.wait();
  waits.end();
  await expect(late.idle).resolves.toBeUndefined();
});

test("every device state has an entry, and only the states that the panel shows otherwise have no message", () => {
  expect(Object.keys(DEVICE_STATE_MESSAGES).sort()).toEqual(
    [...DEVICE_STATES].sort(),
  );
  const silent = DEVICE_STATES.filter(
    (state) => describeDeviceState(state) === undefined,
  );
  expect(silent).toEqual(["no_device", "signed_in", "key_not_loaded"]);
  expect(describeDeviceState("revoked")?.role).toBe("alert");
  expect(describeDeviceState("signed_out")?.role).toBe("status");
});

test("the sign-in is offered without an account and in every state that needs one", () => {
  const status = (
    device: AccountStatus["device"],
    signedIn = true,
  ): AccountStatus => ({
    revision: 1,
    account: signedIn
      ? {
          kind: "signed_in",
          login: "octocat",
          displayName: "The Octocat",
          deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
        }
      : { kind: "signed_out" },
    signIn: { kind: "idle" },
    lastOutcome: null,
    deviceKey: "ready",
    replacementPending: false,
    apiOrigin: "set",
    device,
  });
  expect(
    DEVICE_STATES.filter((device) => offersSignIn(status(device))),
  ).toEqual([
    "no_device",
    "signed_out",
    "sign_out_report_pending",
    "sign_in_required",
    "auth_failed",
    "account_mismatch",
    "key_lost",
    "removed",
    "revoked",
  ]);
  for (const device of DEVICE_STATES) {
    expect(offersSignIn(status(device, false))).toBe(true);
  }
});

test("every failure of a device action has its own message, and a success none", () => {
  expect(Object.keys(DEVICE_ACTION_FAILURE_MESSAGES).sort()).toEqual(
    [...DEVICE_ACTION_FAILURES].sort(),
  );
  for (const reason of DEVICE_ACTION_FAILURES) {
    const failed = { outcome: "failed", reason } as const;
    expect(signOutMessage(failed)).toBe(DEVICE_ACTION_FAILURE_MESSAGES[reason]);
    expect(removeDeviceMessage(failed)).toBe(
      DEVICE_ACTION_FAILURE_MESSAGES[reason],
    );
    expect(listDevicesMessage(failed)).toBe(
      DEVICE_ACTION_FAILURE_MESSAGES[reason],
    );
  }
  for (const [reason, text] of [
    ["busy", DEVICE_ACTION_MESSAGES.busy],
    ["not_signed_in", DEVICE_ACTION_MESSAGES.notSignedIn],
    ["too_soon", DEVICE_ACTION_MESSAGES.tooSoon],
  ] as const) {
    const refused = { outcome: "refused", reason } as const;
    expect(signOutMessage(refused)).toBe(text);
    expect(removeDeviceMessage(refused)).toBe(text);
    expect(listDevicesMessage(refused)).toBe(text);
  }
  expect(signOutMessage({ outcome: "signed_out" })).toBeUndefined();
  expect(signOutMessage({ outcome: "pending" })).toBeUndefined();
  for (const outcome of ["removed", "pending", "cancelled"] as const) {
    expect(removeDeviceMessage({ outcome })).toBeUndefined();
  }
  expect(
    listDevicesMessage({ outcome: "listed", devices: [] }),
  ).toBeUndefined();
});

test("This is not me says when the server could not remove the device", () => {
  expect(
    forgetMessage({ outcome: "forgotten", removedAtServer: true }),
  ).toBeUndefined();
  expect(forgetMessage({ outcome: "forgotten", removedAtServer: false })).toBe(
    DEVICE_ACTION_MESSAGES.forgottenLocally,
  );
  expect(forgetMessage({ outcome: "cancelled" })).toBeUndefined();
  expect(forgetMessage({ outcome: "refused", reason: "busy" })).toBe(
    ACTION_MESSAGES.forgetBusy,
  );
  expect(forgetMessage({ outcome: "refused", reason: "not_signed_in" })).toBe(
    ACTION_MESSAGES.notSignedIn,
  );
  expect(forgetMessage({ outcome: "failed" })).toBe(
    ACTION_MESSAGES.forgetFailed,
  );
});

test("a device's detail names its platform and when it was last seen or removed", () => {
  const device = {
    id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
    label: "Linux computer",
    platform: "linux",
    lastSeenAt: null,
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
    revokedAt: null,
    current: false,
  } as const;

  expect(deviceDetail(device)).toBe("Linux, not connected yet");
  expect(
    deviceDetail({ ...device, lastSeenAt: "2026-11-02T09:00:00.000Z" }),
  ).toBe("Linux, last seen on 2026-11-02");
  expect(
    deviceDetail({
      ...device,
      platform: "windows",
      lastSeenAt: "2026-11-02T09:00:00.000Z",
      revokedAt: "2026-11-03T09:00:00.000Z",
    }),
  ).toBe("Windows, removed on 2026-11-03");
});
