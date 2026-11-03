import { expect, test } from "vitest";
import {
  type AccountStatus,
  DEVICE_ACTION_FAILURES,
  DEVICE_KEY_STATES,
  DEVICE_STATES,
  SIGN_IN_OUTCOME_CODES,
  START_SIGN_IN_REFUSALS,
  UNLOCK_REFUSALS,
} from "../shared/ipc-contract.ts";
import { unlockMessage } from "./AccountPanel.tsx";
import {
  ACTION_MESSAGES,
  apiOriginProblem,
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
} from "./account-view.ts";

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
