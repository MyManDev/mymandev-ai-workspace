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
import { SIGN_IN_START_COOLDOWN_MS } from "../shared/sign-in-timing.ts";
import { unlockMessage } from "./AccountPanel.tsx";
import {
  ACTION_MESSAGES,
  ANOTHER_BROWSER_DELAY_MS,
  apiOriginProblem,
  canStartSignIn,
  createIdleWaits,
  START_REFUSAL_MESSAGES,
  DEVICE_ACTION_FAILURE_MESSAGES,
  DEVICE_ACTION_MESSAGES,
  DEVICE_KEY_PROBLEM_MESSAGES,
  DEVICE_STATE_MESSAGES,
  describeDeviceState,
  describeOutcome,
  deviceDetail,
  followAccountStatus,
  forgetMessage,
  initialAccountView,
  listDevicesMessage,
  offersForget,
  offersSignIn,
  removeDeviceMessage,
  SIGN_IN_OUTCOME_MESSAGES,
  signInRetryAt,
  signInRetryNote,
  signInRetryReading,
  signInTimeFormat,
  signOutMessage,
  startInAnotherBrowser,
  startMessage,
  SYSTEM_RETRY_CLOCK,
  waitingPairingCode,
  watchSignInRetry,
  type AccountView,
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

test("the time after which a new sign-in can start is the local time of day, in the system's zone and locale by default (#199)", () => {
  const at = Date.parse("2026-11-06T09:30:00.000Z");
  // A zone that is not UTC, so a fixed UTC zone fails here also on a
  // machine whose zone is UTC.
  expect(
    signInTimeFormat({ locale: "en-GB", timeZone: "UTC" }).format(at),
  ).toBe("09:30");
  expect(
    signInTimeFormat({ locale: "en-GB", timeZone: "Asia/Tokyo" }).format(at),
  ).toBe("18:30");

  // The defaults are the system's time zone and the person's locale.
  const system = new Intl.DateTimeFormat().resolvedOptions();
  const defaults = signInTimeFormat().resolvedOptions();
  expect(defaults.timeZone).toBe(system.timeZone);
  expect(defaults.locale).toBe(system.locale);
  expect(defaults.timeStyle).toBe("short");
  expect(defaults.dateStyle).toBeUndefined();
  // Each call makes a new format, so a changed system zone is used.
  expect(signInTimeFormat()).not.toBe(signInTimeFormat());
});

test("a start refused during the grace period of an uncertain sign-in has a note with the time, rounded up to the minute, until then (#199)", () => {
  const utc = signInTimeFormat({ locale: "en-GB", timeZone: "UTC" });
  const refused = (retryAfter?: string): AccountStatus => ({
    ...IDLE,
    replacementPending: true,
    lastOutcome:
      retryAfter === undefined
        ? { code: "replacement_pending" }
        : { code: "replacement_pending", retryAfter },
  });
  const now = Date.parse("2026-11-06T10:00:00.000Z");

  const status = refused("2026-11-06T10:09:30.000Z");
  expect(signInRetryAt(status)).toBe(Date.parse("2026-11-06T10:09:30.000Z"));
  expect(signInRetryNote(status, now, utc)).toBe(
    "A new sign-in can start after 10:10. Try again then.",
  );
  // A time on the minute is shown as it is.
  expect(signInRetryNote(refused("2026-11-06T10:10:00.000Z"), now, utc)).toBe(
    "A new sign-in can start after 10:10. Try again then.",
  );
  expect(signInRetryNote(refused("2026-11-06T10:10:00.001Z"), now, utc)).toBe(
    "A new sign-in can start after 10:11. Try again then.",
  );

  // Until the time has come.
  const at = Date.parse("2026-11-06T10:09:30.000Z");
  expect(signInRetryNote(status, at - 1, utc)).toBeDefined();
  expect(signInRetryNote(status, at, utc)).toBeUndefined();
  expect(signInRetryNote(status, at + 60_000, utc)).toBeUndefined();

  // Not without the time, while a sign-in runs, or for another outcome.
  expect(signInRetryAt(refused())).toBeUndefined();
  expect(signInRetryNote(refused(), now, utc)).toBeUndefined();
  for (const signIn of [
    { kind: "starting" },
    { kind: "completing" },
    WAITING.signIn,
  ] as const) {
    expect(signInRetryAt({ ...status, signIn })).toBeUndefined();
    expect(signInRetryNote({ ...status, signIn }, now, utc)).toBeUndefined();
  }
  expect(signInRetryAt(IDLE)).toBeUndefined();
  expect(signInRetryAt({ ...IDLE, lastOutcome: null })).toBeUndefined();

  // Not once the status no longer reports the pending replacement, for
  // example when it was resolved before that time.
  const resolved = { ...status, replacementPending: false };
  expect(signInRetryAt(resolved)).toBeUndefined();
  expect(signInRetryNote(resolved, now, utc)).toBeUndefined();
});

/** A clock whose time the test sets and whose timers fire when the test says so. */
function fakeRetryClock(start: number) {
  const timers: { run: () => void; delayMs: number }[] = [];
  const clock = {
    time: start,
    timers,
    now: () => clock.time,
    setTimer: (run: () => void, delayMs: number) => {
      const timer = { run, delayMs };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) {
          timers.splice(index, 1);
        }
      };
    },
    /** The delays of the timers that run. */
    delays: () => timers.map((timer) => timer.delayMs),
    /** Fires the one timer that runs, at the time that the test set. */
    fire: () => {
      expect(timers).toHaveLength(1);
      timers.shift()?.run();
    },
  };
  return clock;
}

test("the panel's clock is read again when the note ends, and a time at or after it arms no timer (#199)", () => {
  const at = Date.parse("2026-11-06T10:09:30.000Z");
  const times: number[] = [];
  const onTime = (time: number) => times.push(time);

  // A timer until the time, counted from the clock's reading.
  const clock = fakeRetryClock(at - 570_000);
  watchSignInRetry(at, clock.time, onTime, clock);
  expect(clock.delays()).toEqual([570_000]);
  clock.time = at;
  clock.fire();
  expect(times).toEqual([at]);
  expect(clock.delays()).toEqual([]);

  // With that time, or a later one, or without a time, nothing is armed,
  // so the time passed on does not arm timers of no delay again and again.
  for (const now of [at, at + 1, at + 3_600_000]) {
    watchSignInRetry(at, now, onTime, clock);
  }
  watchSignInRetry(undefined, at - 570_000, onTime, clock);
  expect(clock.delays()).toEqual([]);
  expect(times).toEqual([at]);

  // A `now` that the panel read long ago does not lengthen the wait: the
  // delay counts from the clock. When the clock is already at the time, the
  // timer has no delay and passes the time on.
  const stale = fakeRetryClock(at - 60_000);
  watchSignInRetry(at, at - 3_600_000, onTime, stale);
  expect(stale.delays()).toEqual([60_000]);
  const past = fakeRetryClock(at + 5_000);
  watchSignInRetry(at, at - 60_000, onTime, past);
  expect(past.delays()).toEqual([0]);
  past.fire();
  expect(times).toEqual([at, at + 5_000]);
  expect(past.delays()).toEqual([]);
});

test("a clock that still reads earlier when the timer fires gets the timer again for the rest (#199)", () => {
  const at = Date.parse("2026-11-06T10:09:30.000Z");
  const times: number[] = [];
  const clock = fakeRetryClock(at - 570_000);
  watchSignInRetry(at, clock.time, (time) => times.push(time), clock);

  // The wall clock trails the timer by a millisecond.
  clock.time = at - 1;
  clock.fire();
  expect(times).toEqual([]);
  expect(clock.delays()).toEqual([1]);

  // The clock was set back by an hour meanwhile.
  clock.time = at - 3_600_000;
  clock.fire();
  expect(times).toEqual([]);
  expect(clock.delays()).toEqual([3_600_000]);

  clock.time = at + 2;
  clock.fire();
  expect(times).toEqual([at + 2]);
  expect(clock.delays()).toEqual([]);

  // A clock set back further than `setTimeout` can wait (it runs a longer
  // delay at once) waits as long as it can, and then again.
  const far = fakeRetryClock(at - 30 * 24 * 3_600_000);
  watchSignInRetry(at, far.time, (time) => times.push(time), far);
  expect(far.delays()).toEqual([2_147_483_647]);
  far.time += 2_147_483_647;
  far.fire();
  expect(far.delays()).toEqual([30 * 24 * 3_600_000 - 2_147_483_647]);
  expect(times).toEqual([at + 2]);
});

test("stopping the watch stops the timer that runs, also one armed again (#199)", () => {
  const at = Date.parse("2026-11-06T10:09:30.000Z");
  const times: number[] = [];
  const clock = fakeRetryClock(at - 570_000);

  const stop = watchSignInRetry(
    at,
    clock.time,
    (time) => times.push(time),
    clock,
  );
  expect(clock.delays()).toEqual([570_000]);
  stop();
  expect(clock.delays()).toEqual([]);

  const again = watchSignInRetry(
    at,
    clock.time,
    (time) => times.push(time),
    clock,
  );
  clock.time = at - 1;
  clock.fire();
  expect(clock.delays()).toEqual([1]);
  again();
  expect(clock.delays()).toEqual([]);
  // Stopping twice, or a watch that armed nothing, is harmless.
  again();
  watchSignInRetry(undefined, clock.time, (time) => times.push(time), clock)();
  expect(times).toEqual([]);
});

test("the panel's clock is read again whenever the time of the note changes, so a note shows after the clock was set back (#204)", () => {
  const utc = signInTimeFormat({ locale: "en-GB", timeZone: "UTC" });
  const refused = (retryAt: number): AccountStatus => ({
    ...IDLE,
    replacementPending: true,
    lastOutcome: {
      code: "replacement_pending",
      retryAfter: new Date(retryAt).toISOString(),
    },
  });
  const first = Date.parse("2026-11-06T10:09:30.000Z");
  const clock = fakeRetryClock(first - 570_000);
  const read = signInRetryReading(undefined, first, clock);
  expect(read).toEqual({ retryAt: first, now: first - 570_000 });

  // The same time keeps the reading; the clock is not read.
  clock.time = first - 60_000;
  expect(signInRetryReading(read, first, clock)).toBe(read);

  // The note ended: the watch passed on a reading at its time. Then the
  // clock is set back by two hours, and a later start is refused with a
  // time before that reading.
  const ended = { retryAt: first, now: first + 1_000 };
  clock.time = first - 2 * 3_600_000;
  const second = clock.time + 570_000;
  expect(signInRetryNote(refused(second), ended.now, utc)).toBeUndefined();
  const again = signInRetryReading(ended, second, clock);
  expect(again).toEqual({ retryAt: second, now: clock.time });
  expect(signInRetryNote(refused(second), again.now, utc)).toBe(
    "A new sign-in can start after 08:19. Try again then.",
  );

  // Also when the time goes away, for example while a sign-in starts, and
  // comes back.
  clock.time += 1_000;
  const none = signInRetryReading(again, undefined, clock);
  expect(none).toEqual({ retryAt: undefined, now: clock.time });
  expect(signInRetryReading(none, undefined, clock)).toBe(none);
  clock.time += 1_000;
  expect(signInRetryReading(none, second, clock)).toEqual({
    retryAt: second,
    now: clock.time,
  });
});

test("the system's clock runs its timer once, and its stop keeps it from running (#199)", async () => {
  const runs: string[] = [];
  SYSTEM_RETRY_CLOCK.setTimer(() => runs.push("kept"), 1);
  const stop = SYSTEM_RETRY_CLOCK.setTimer(() => runs.push("stopped"), 1);
  stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(runs).toEqual(["kept"]);
  const before = Date.now();
  const read = SYSTEM_RETRY_CLOCK.now();
  expect(read).toBeGreaterThanOrEqual(before);
  expect(read).toBeLessThanOrEqual(Date.now());
});

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

test("another browser waits for the cancel's outcome before it cancels, so that an outcome before the answer is not missed", async () => {
  const fake = fakeAccount();
  const waits = createIdleWaits();
  fake.cancel = async () => {
    // The status of the cancelled sign-in arrives before the answer.
    waits.status(IDLE);
    return true;
  };

  const result = startInAnotherBrowser(fake.account, true, waits.wait);
  await settle();
  expect(fake.log).toEqual(["cancel", 'start {"browser":"other"}']);
  await expect(result).resolves.toEqual({ outcome: "started" });
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

test("the panel follows the status: each one becomes the view and reaches the waits, and the end of the subscription ends them", async () => {
  const views: AccountView[] = [];
  let listener: (status: AccountStatus) => void = () => undefined;
  let onError: () => void = () => undefined;
  let stops = 0;
  const account: Pick<AccountBridge, "subscribeStatus"> = {
    subscribeStatus: (next, error) => {
      listener = next;
      onError = error ?? (() => undefined);
      return () => {
        stops += 1;
      };
    },
  };
  const waits = createIdleWaits();
  const stop = followAccountStatus(account, waits, (view) => views.push(view));

  const idle = waits.wait();
  listener(WAITING);
  listener(IDLE);
  await expect(idle.idle).resolves.toBe(IDLE);
  expect(views).toEqual([
    { kind: "known", status: WAITING },
    { kind: "known", status: IDLE },
  ]);

  // The subscription failed.
  const failed = waits.wait();
  onError();
  await expect(failed.idle).resolves.toBeUndefined();
  expect(views.at(-1)).toEqual({ kind: "unavailable" });

  // The panel is no longer shown.
  const unmounted = waits.wait();
  stop();
  expect(stops).toBe(1);
  await expect(unmounted.idle).resolves.toBeUndefined();
});

test("only a sign-in that waits for the browser has a pairing code that another browser can replace", () => {
  expect(waitingPairingCode({ kind: "known", status: WAITING })).toBe("042137");
  expect(
    waitingPairingCode({
      kind: "known",
      status: {
        ...WAITING,
        signIn: {
          kind: "waiting",
          pairingCode: "123456",
          opened: false,
          authorizeUrl: "https://api.mymandev.example/auth/github/authorize",
          warning: "Do not share this address.",
          browser: "other",
        },
      },
    }),
  ).toBe("123456");
  for (const signIn of [
    { kind: "idle" },
    { kind: "starting" },
    { kind: "completing" },
  ] as const) {
    expect(
      waitingPairingCode({ kind: "known", status: { ...IDLE, signIn } }),
    ).toBeUndefined();
  }
  expect(waitingPairingCode({ kind: "pending" })).toBeUndefined();
  expect(waitingPairingCode({ kind: "unavailable" })).toBeUndefined();
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
  // While the device is signed out, the main process names no account.
  for (const device of ["signed_out", "sign_out_report_pending"] as const) {
    expect(
      offersSignIn({ ...status(device), account: { kind: "hidden" } }),
    ).toBe(true);
  }
});

test("a sign-in can start now only while it is offered and idle, with a ready key and a server address", () => {
  const signedIn = {
    kind: "signed_in",
    login: "octocat",
    displayName: "The Octocat",
    deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
  } as const;
  const startable: AccountStatus = { ...IDLE, lastOutcome: null };
  expect(canStartSignIn(startable)).toBe(true);
  expect(
    canStartSignIn({
      ...startable,
      account: { kind: "hidden" },
      device: "signed_out",
    }),
  ).toBe(true);

  const blocked: [string, AccountStatus][] = [
    ["sign-in starting", { ...startable, signIn: { kind: "starting" } }],
    ["sign-in waiting", { ...WAITING }],
    ["sign-in completing", { ...startable, signIn: { kind: "completing" } }],
    [
      "not offered: signed in",
      { ...startable, account: signedIn, device: "signed_in" },
    ],
    [
      "not offered: removal pending",
      { ...startable, account: signedIn, device: "removal_pending" },
    ],
    [
      "not offered: starting",
      { ...startable, account: { kind: "hidden" }, device: "starting" },
    ],
    ["api origin unset", { ...startable, apiOrigin: "unset" }],
    ["api origin invalid", { ...startable, apiOrigin: "invalid" }],
  ];
  for (const deviceKey of DEVICE_KEY_STATES) {
    if (deviceKey !== "ready") {
      blocked.push([deviceKey, { ...startable, deviceKey }]);
    }
  }
  // Each case differs from a status that can start in one way only.
  for (const [name, status] of blocked) {
    expect(canStartSignIn(status), name).toBe(false);
  }
});

test("This is not me is offered whenever the installation holds an account, also one that the status does not name (#195)", () => {
  const status = (account: AccountStatus["account"]): AccountStatus => ({
    ...IDLE,
    account,
    device: account.kind === "hidden" ? "signed_out" : "signed_in",
  });

  expect(
    offersForget(
      status({
        kind: "signed_in",
        login: "octocat",
        displayName: "The Octocat",
        deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
      }),
    ),
  ).toBe(true);
  expect(offersForget(status({ kind: "hidden" }))).toBe(true);
  expect(offersForget(status({ kind: "signed_out" }))).toBe(false);
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

test("This is not me says whether the server removed the device or it stays listed for that account, without an end of its sign-in (#198)", () => {
  expect(forgetMessage({ outcome: "forgotten", removedAtServer: true })).toBe(
    "The account was removed from this installation, and the server removed this device from it.",
  );
  expect(forgetMessage({ outcome: "forgotten", removedAtServer: false })).toBe(
    "The account was removed from this installation only. The server did not remove this device, so it stays listed for that GitHub account, without a key.",
  );
  expect(DEVICE_ACTION_MESSAGES.forgottenAtServer).toBe(
    forgetMessage({ outcome: "forgotten", removedAtServer: true }),
  );
  expect(DEVICE_ACTION_MESSAGES.forgottenLocally).toBe(
    forgetMessage({ outcome: "forgotten", removedAtServer: false }),
  );
  for (const message of [
    DEVICE_ACTION_MESSAGES.forgottenAtServer,
    DEVICE_ACTION_MESSAGES.forgottenLocally,
  ]) {
    expect(message).not.toMatch(/30|sign-in ends|until/);
  }
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

test("the panel offers another browser for a waiting sign-in no sooner than the cooldown allows a new start", () => {
  // Otherwise the cancel would end the waiting sign-in, and the new start
  // would be refused as too soon.
  expect(ANOTHER_BROWSER_DELAY_MS).toBeGreaterThanOrEqual(
    SIGN_IN_START_COOLDOWN_MS,
  );
});
