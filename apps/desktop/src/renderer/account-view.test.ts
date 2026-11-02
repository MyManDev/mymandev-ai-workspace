import { expect, test } from "vitest";
import {
  DEVICE_KEY_STATES,
  SIGN_IN_OUTCOME_CODES,
  START_SIGN_IN_REFUSALS,
  UNLOCK_REFUSALS,
} from "../shared/ipc-contract.ts";
import { unlockMessage } from "./AccountPanel.tsx";
import {
  ACTION_MESSAGES,
  apiOriginProblem,
  START_REFUSAL_MESSAGES,
  DEVICE_KEY_PROBLEM_MESSAGES,
  describeOutcome,
  initialAccountView,
  SIGN_IN_OUTCOME_MESSAGES,
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
