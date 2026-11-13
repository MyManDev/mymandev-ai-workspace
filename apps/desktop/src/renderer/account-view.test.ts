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
  deviceDailyLimitMessage,
  describeSignInExpiry,
  deviceSignedIn,
  followAccountStatus,
  forgetMessage,
  initialAccountView,
  nextSignInExpiryChange,
  nextSignInWaitChange,
  offersForget,
  offersRenewal,
  offersSignIn,
  removeDeviceMessage,
  SIGN_IN_OUTCOME_MESSAGES,
  signInLimitedMessage,
  signInWaitLeft,
  SIGN_IN_RENEWAL_MESSAGES,
  SIGN_IN_RENEWAL_WINDOW_MS,
  signInEndFormat,
  signInRetryAt,
  signInRetryNote,
  signInRetryReading,
  signInTimeFormat,
  showsTwoFactorNote,
  signOutMessage,
  startInAnotherBrowser,
  startMessage,
  SYSTEM_RETRY_CLOCK,
  TWO_FACTOR_NOTE,
  waitingPairingCode,
  watchSignInRetry,
  type AccountView,
} from "./account-view.ts";
import { describeWait as peopleDescribeWait } from "./people-actions-view.ts";
import { describeWait } from "./wait-text.ts";

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
    (code) => describeOutcome({ code }, 0).text,
  );
  expect(new Set(texts).size).toBe(texts.length);
  for (const code of SIGN_IN_OUTCOME_CODES) {
    expect(describeOutcome({ code }, 0).role, code).toBe(
      code === "signed_in" || code === "cancelled" ? "status" : "alert",
    );
  }
});

test("the account's limit of active devices says to remove a device on another device, and names no wait (#255)", () => {
  const message = describeOutcome({ code: "device_limit" }, 0);
  expect(message).toEqual({
    role: "alert",
    text: "This account already has as many active devices as it allows, so this device cannot be added. On another of your devices, remove a device that you no longer use in the Devices section of the Account screen, then sign in here again.",
  });
  expect(message.text).not.toMatch(/Try again|wait/iu);
});

/** When the answer of the limit tests arrived, and the end of its wait. */
const LIMITED_AT = Date.parse("2026-11-14T10:00:00.000Z");
const limited = (
  code: "device_daily_limit" | "uncertain_refusal",
  ms: number,
) => ({ code, retryAfter: new Date(LIMITED_AT + ms).toISOString() }) as const;

test("the daily limit of new devices says how long to wait, from the clock, and says nothing uncertain (#269)", () => {
  const outcome = limited("device_daily_limit", 86_000_000);
  expect(describeOutcome(outcome, LIMITED_AT)).toEqual({
    role: "alert",
    text: "This account has added as many new devices as it may in one day. Try again in about 24 hours.",
  });
  // The refusal is certain, so nothing about an unknown outcome, and the
  // route's limit is not named.
  expect(describeOutcome(outcome, LIMITED_AT).text).not.toMatch(
    /does not show|safe|network/iu,
  );
  // What is left is counted from the clock, so the text does not go stale.
  expect(describeOutcome(outcome, LIMITED_AT + 20 * 3_600_000).text).toBe(
    "This account has added as many new devices as it may in one day. Try again in about 4 hours.",
  );
  expect(describeOutcome(outcome, LIMITED_AT + 85_400_000).text).toBe(
    deviceDailyLimitMessage(600_000),
  );
  expect(deviceDailyLimitMessage(600_000)).toContain(
    "Try again in about 10 minutes.",
  );
  // Once the time has come, and without a time, the sentence has no wait.
  const plain =
    "This account has added as many new devices as it may in one day.";
  expect(SIGN_IN_OUTCOME_MESSAGES.device_daily_limit).toBe(plain);
  for (const now of [LIMITED_AT + 86_000_000, LIMITED_AT + 90_000_000]) {
    expect(describeOutcome(outcome, now)).toEqual({
      role: "alert",
      text: plain,
    });
  }
  expect(describeOutcome(outcome, LIMITED_AT + 85_999_999).text).toBe(
    `${plain} Try again in about 1 minute.`,
  );
  expect(describeOutcome({ code: "device_daily_limit" }, LIMITED_AT).text).toBe(
    plain,
  );
});

test("an uncertain refusal with the wait of rate_limited says how long to wait, names the route's limit only, and still does not say whether the sign-in was completed (#269)", () => {
  const outcome = limited("uncertain_refusal", 600_000);
  expect(describeOutcome(outcome, LIMITED_AT)).toEqual({
    role: "alert",
    text: "The server is limiting sign-ins for now: too many sign-ins came from this network. Its answer does not show whether the sign-in was completed. Try again in about 10 minutes; starting it again then is safe.",
  });
  // The daily limit of new devices has its own outcome now.
  expect(describeOutcome(outcome, LIMITED_AT).text).not.toMatch(
    /device|one day/iu,
  );
  // What is left is counted from the clock.
  expect(describeOutcome(outcome, LIMITED_AT + 420_000).text).toBe(
    signInLimitedMessage(180_000),
  );
  expect(signInLimitedMessage(180_000)).toContain(
    "Try again in about 3 minutes;",
  );
  // Once the time has come, and without a time, the message is the one of
  // every uncertain refusal.
  for (const now of [LIMITED_AT + 600_000, LIMITED_AT + 3_600_000]) {
    expect(describeOutcome(outcome, now).text).toBe(
      SIGN_IN_OUTCOME_MESSAGES.uncertain_refusal,
    );
  }
  expect(describeOutcome({ code: "uncertain_refusal" }, LIMITED_AT).text).toBe(
    SIGN_IN_OUTCOME_MESSAGES.uncertain_refusal,
  );
});

test("the wait of a limited sign-in is rounded up in the words of the other screens, and never counts seconds (#269)", () => {
  // Rounded up, so that a start after the wait is not refused again.
  const waits: [number, string][] = [
    [600_000, "10 minutes"],
    [3_600_000, "1 hour"],
    [3_660_000, "2 hours"],
    [90_000, "2 minutes"],
    // Below a minute it stays a minute: the message is an alert, and a
    // count of seconds would announce it again every second.
    [60_000, "1 minute"],
    [30_000, "1 minute"],
    [1, "1 minute"],
  ];
  for (const [ms, wait] of waits) {
    expect(signInLimitedMessage(ms)).toContain(`Try again in about ${wait};`);
    expect(deviceDailyLimitMessage(ms)).toContain(
      `Try again in about ${wait}.`,
    );
  }
  for (const ms of [
    60_000, 61_000, 3_599_000, 3_600_000, 3_601_000, 86_400_000, 604_800_000,
  ]) {
    expect(signInLimitedMessage(ms)).toContain(
      `Try again in about ${describeWait(ms)};`,
    );
  }
  // One function for every screen: the People screen's is the same one.
  expect(peopleDescribeWait).toBe(describeWait);
});

test("what is left of a limit's wait is read from the outcome's time, with the two limit codes only (#269)", () => {
  const at = new Date(LIMITED_AT + 600_000).toISOString();
  for (const code of ["device_daily_limit", "uncertain_refusal"] as const) {
    expect(signInWaitLeft({ code, retryAfter: at }, LIMITED_AT)).toBe(600_000);
    expect(signInWaitLeft({ code, retryAfter: at }, LIMITED_AT + 599_999)).toBe(
      1,
    );
    expect(
      signInWaitLeft({ code, retryAfter: at }, LIMITED_AT + 600_000),
    ).toBeUndefined();
    expect(signInWaitLeft({ code }, LIMITED_AT)).toBeUndefined();
    // A time that cannot be read names no wait.
    expect(
      signInWaitLeft({ code, retryAfter: "soon" }, LIMITED_AT),
    ).toBeUndefined();
  }
  // The time of `replacement_pending` belongs to its own note (#199), and
  // no other code carries one.
  for (const code of SIGN_IN_OUTCOME_CODES) {
    if (code === "device_daily_limit" || code === "uncertain_refusal") {
      continue;
    }
    expect(signInWaitLeft({ code, retryAfter: at }, LIMITED_AT), code).toBe(
      undefined,
    );
    expect(describeOutcome({ code, retryAfter: at }, LIMITED_AT).text).toBe(
      SIGN_IN_OUTCOME_MESSAGES[code],
    );
  }
});

test("the clock is read again each time the wait of a limited sign-in reads differently, down to its end (#269)", () => {
  for (const code of ["device_daily_limit", "uncertain_refusal"] as const) {
    const status = (ms: number): AccountStatus => ({
      ...IDLE,
      lastOutcome: limited(code, ms),
    });
    // 9 minutes and 30 seconds read "10 minutes" until 9 minutes are left.
    expect(nextSignInWaitChange(status(570_000), LIMITED_AT)).toBe(
      LIMITED_AT + 30_000,
    );
    // At a whole minute, the next one.
    expect(nextSignInWaitChange(status(600_000), LIMITED_AT)).toBe(
      LIMITED_AT + 60_000,
    );
    // In the last minute, the end, where the message drops the wait.
    expect(nextSignInWaitChange(status(600_000), LIMITED_AT + 540_000)).toBe(
      LIMITED_AT + 600_000,
    );
    expect(nextSignInWaitChange(status(600_000), LIMITED_AT + 599_999)).toBe(
      LIMITED_AT + 600_000,
    );
    // Nothing after the end, without a time, or while a sign-in runs.
    expect(
      nextSignInWaitChange(status(600_000), LIMITED_AT + 600_000),
    ).toBeUndefined();
    expect(
      nextSignInWaitChange({ ...IDLE, lastOutcome: { code } }, LIMITED_AT),
    ).toBeUndefined();
    expect(
      nextSignInWaitChange(
        { ...status(600_000), signIn: { kind: "starting" } },
        LIMITED_AT,
      ),
    ).toBeUndefined();
  }
  expect(
    nextSignInWaitChange({ ...IDLE, lastOutcome: null }, LIMITED_AT),
  ).toBeUndefined();

  // Followed with the panel's watch, the text is never stale: every reading
  // lies on a change of the text, and the last one is the end.
  const status: AccountStatus = {
    ...IDLE,
    lastOutcome: limited("uncertain_refusal", 150_000),
  };
  const clock = fakeRetryClock(LIMITED_AT);
  const texts: string[] = [];
  let now = LIMITED_AT;
  for (let step = 0; step < 10; step += 1) {
    if (status.lastOutcome !== null) {
      texts.push(describeOutcome(status.lastOutcome, now).text);
    }
    const change = nextSignInWaitChange(status, now);
    if (change === undefined) {
      break;
    }
    let later: number | undefined;
    watchSignInRetry(change, now, (time) => (later = time), clock);
    clock.time = change;
    clock.fire();
    expect(later).toBe(change);
    now = change;
  }
  expect(texts).toEqual([
    signInLimitedMessage(180_000),
    signInLimitedMessage(120_000),
    signInLimitedMessage(60_000),
    SIGN_IN_OUTCOME_MESSAGES.uncertain_refusal,
  ]);
});

test("an account mismatch names the installation's login when the main process sent it", () => {
  expect(
    describeOutcome(
      { code: "device_account_mismatch", deviceLogin: "hubot" },
      0,
    ),
  ).toEqual({
    role: "alert",
    text: "This installation belongs to the GitHub account hubot. Sign in with that account.",
  });
  expect(describeOutcome({ code: "device_account_mismatch" }, 0).text).toBe(
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
          signInExpiresAt: "2026-12-02T10:00:00.000Z",
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
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
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

test("the device is signed in only while the status names its account and the session holds it signed in", () => {
  const signedIn: AccountStatus = {
    ...IDLE,
    lastOutcome: null,
    account: {
      kind: "signed_in",
      login: "octocat",
      displayName: "The Octocat",
      deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
      signInExpiresAt: "2026-12-02T10:00:00.000Z",
    },
    device: "signed_in",
  };
  expect(deviceSignedIn(signedIn)).toBe(true);
  expect(
    DEVICE_STATES.filter((device) => deviceSignedIn({ ...signedIn, device })),
  ).toEqual(["signed_in"]);
  for (const account of [{ kind: "signed_out" }, { kind: "hidden" }] as const) {
    expect(deviceSignedIn({ ...signedIn, account }), account.kind).toBe(false);
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
        signInExpiresAt: "2026-12-02T10:00:00.000Z",
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
  }
  for (const [reason, text] of [
    ["busy", DEVICE_ACTION_MESSAGES.busy],
    ["not_signed_in", DEVICE_ACTION_MESSAGES.notSignedIn],
  ] as const) {
    const refused = { outcome: "refused", reason } as const;
    expect(signOutMessage(refused)).toBe(text);
    expect(removeDeviceMessage(refused)).toBe(text);
  }
  expect(signOutMessage({ outcome: "signed_out" })).toBeUndefined();
  expect(signOutMessage({ outcome: "pending" })).toBeUndefined();
  for (const outcome of ["removed", "pending", "cancelled"] as const) {
    expect(removeDeviceMessage({ outcome })).toBeUndefined();
  }
});

test("This is not me says whether the server removed the device or it stays listed for that account, without an end of its sign-in (#198)", () => {
  expect(forgetMessage({ outcome: "forgotten", removedAtServer: true })).toBe(
    "The account was removed from this installation, and the server removed this device from it.",
  );
  // The message names the removal from another device, as the dialog does
  // (the Project Manager's decision of 2026-11-09).
  expect(forgetMessage({ outcome: "forgotten", removedAtServer: false })).toBe(
    'The account was removed from this installation only. The server did not remove this device, so it stays listed for that GitHub account, without a key. Whoever owns that account can remove it from another of their devices, with "Remove" in the device list on the Account screen.',
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

test("the panel offers another browser for a waiting sign-in no sooner than the cooldown allows a new start", () => {
  // Otherwise the cancel would end the waiting sign-in, and the new start
  // would be refused as too soon.
  expect(ANOTHER_BROWSER_DELAY_MS).toBeGreaterThanOrEqual(
    SIGN_IN_START_COOLDOWN_MS,
  );
});

const END = Date.parse("2026-12-09T10:00:00.000Z");

/** A signed-in device whose sign-in ends at `END`, which can start a sign-in. */
const RENEWABLE: AccountStatus = {
  ...IDLE,
  lastOutcome: null,
  account: {
    kind: "signed_in",
    login: "octocat",
    displayName: "The Octocat",
    deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
    signInExpiresAt: "2026-12-09T10:00:00.000Z",
  },
  device: "signed_in",
};

test("the panel asks to renew the sign-in from day 25 of the 30 days, 6 days before its end, and says after the end that it ended (D4)", () => {
  expect(SIGN_IN_RENEWAL_WINDOW_MS).toBe(6 * 24 * 60 * 60 * 1000);
  const start = END - SIGN_IN_RENEWAL_WINDOW_MS;
  for (const [now, prompt] of [
    [END - 30 * 24 * 60 * 60 * 1000, undefined],
    [start - 1, undefined],
    [start, SIGN_IN_RENEWAL_MESSAGES.due],
    [END - 1, SIGN_IN_RENEWAL_MESSAGES.due],
    [END, SIGN_IN_RENEWAL_MESSAGES.ended],
    [END + 24 * 60 * 60 * 1000, SIGN_IN_RENEWAL_MESSAGES.ended],
  ] as const) {
    expect(describeSignInExpiry(RENEWABLE, now), String(now)).toEqual({
      endsAt: "2026-12-09T10:00:00.000Z",
      prompt,
    });
  }
  // Day 25 of the 30 days begins after 24 days, with the prompt; day 24
  // ends without it.
  const signedInAt = END - 30 * 24 * 60 * 60 * 1000;
  const day25 = signedInAt + 24 * 24 * 60 * 60 * 1000;
  expect(describeSignInExpiry(RENEWABLE, day25)?.prompt).toBe(
    SIGN_IN_RENEWAL_MESSAGES.due,
  );
  expect(describeSignInExpiry(RENEWABLE, day25 - 1)?.prompt).toBe(undefined);
});

test("the end of the sign-in shows only while this device is signed in and the status names its account (D4)", () => {
  expect(
    DEVICE_STATES.filter(
      (device) =>
        describeSignInExpiry({ ...RENEWABLE, device }, END) !== undefined,
    ),
  ).toEqual(["signed_in"]);
  for (const account of [{ kind: "signed_out" }, { kind: "hidden" }] as const) {
    expect(describeSignInExpiry({ ...RENEWABLE, account }, END)).toBe(
      undefined,
    );
    expect(nextSignInExpiryChange({ ...RENEWABLE, account }, 0)).toBe(
      undefined,
    );
  }
  expect(
    nextSignInExpiryChange({ ...RENEWABLE, device: "sign_in_required" }, 0),
  ).toBe(undefined);
});

test("the panel's clock is read again when the prompt begins and when the sign-in ends, and not after (D4)", () => {
  const start = END - SIGN_IN_RENEWAL_WINDOW_MS;
  expect(nextSignInExpiryChange(RENEWABLE, start - 1)).toBe(start);
  expect(nextSignInExpiryChange(RENEWABLE, start)).toBe(END);
  expect(nextSignInExpiryChange(RENEWABLE, END - 1)).toBe(END);
  expect(nextSignInExpiryChange(RENEWABLE, END)).toBe(undefined);
  expect(nextSignInExpiryChange(RENEWABLE, END + 1)).toBe(undefined);
});

test("the renewal is offered at any time while this device is signed in, no sign-in runs, the key is ready, and the build has a server address (D4)", () => {
  expect(offersRenewal(RENEWABLE)).toBe(true);
  // It does not compete with "Sign in with GitHub", which the panel offers
  // only where the device needs a sign-in.
  expect(offersSignIn(RENEWABLE)).toBe(false);
  expect(
    DEVICE_STATES.filter((device) => offersRenewal({ ...RENEWABLE, device })),
  ).toEqual(["signed_in"]);
  const blocked: [string, AccountStatus][] = [
    ["signed out", { ...RENEWABLE, account: { kind: "signed_out" } }],
    ["hidden", { ...RENEWABLE, account: { kind: "hidden" } }],
    ["sign-in starting", { ...RENEWABLE, signIn: { kind: "starting" } }],
    ["sign-in waiting", { ...RENEWABLE, signIn: WAITING.signIn }],
    ["sign-in completing", { ...RENEWABLE, signIn: { kind: "completing" } }],
    ["api origin unset", { ...RENEWABLE, apiOrigin: "unset" }],
    ["api origin invalid", { ...RENEWABLE, apiOrigin: "invalid" }],
    ...DEVICE_KEY_STATES.filter((deviceKey) => deviceKey !== "ready").map(
      (deviceKey): [string, AccountStatus] => [
        deviceKey,
        { ...RENEWABLE, deviceKey },
      ],
    ),
  ];
  for (const [name, status] of blocked) {
    expect(offersRenewal(status), name).toBe(false);
  }
});

test("the end of the sign-in is a date and a time of day in the person's locale and time zone (D4)", () => {
  const at = Date.parse("2026-12-09T22:30:00.000Z");
  expect(signInEndFormat({ locale: "en-GB", timeZone: "UTC" }).format(at)).toBe(
    "9 December 2026 at 22:30",
  );
  expect(
    signInEndFormat({ locale: "en-GB", timeZone: "Asia/Tokyo" }).format(at),
  ).toBe("10 December 2026 at 07:30");
  expect(
    signInEndFormat({ locale: "tr-TR", timeZone: "Europe/Istanbul" }).format(
      at,
    ),
  ).toBe("10 Aral\u0131k 2026 01:30");
  // The defaults are the system's time zone and the person's locale.
  const system = new Intl.DateTimeFormat().resolvedOptions();
  const defaults = signInEndFormat().resolvedOptions();
  expect(defaults.timeZone).toBe(system.timeZone);
  expect(defaults.locale).toBe(system.locale);
});

test("the note on two-factor authentication shows while no sign-in runs and the panel offers one or the device is signed in (D6)", () => {
  const signedIn: AccountStatus = {
    ...IDLE,
    lastOutcome: null,
    account: {
      kind: "signed_in",
      login: "octocat",
      displayName: "The Octocat",
      deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
      signInExpiresAt: "2026-12-02T10:00:00.000Z",
    },
    device: "signed_in",
  };
  expect(showsTwoFactorNote(IDLE)).toBe(true);
  expect(
    DEVICE_STATES.filter((device) =>
      showsTwoFactorNote({ ...signedIn, device }),
    ),
  ).toEqual([
    "no_device",
    "signed_in",
    "signed_out",
    "sign_out_report_pending",
    "sign_in_required",
    "auth_failed",
    "account_mismatch",
    "key_lost",
    "removed",
    "revoked",
  ]);
  // While the device is signed out, the main process names no account.
  expect(
    showsTwoFactorNote({
      ...signedIn,
      account: { kind: "hidden" },
      device: "signed_out",
    }),
  ).toBe(true);
  // Never while a sign-in runs, also when the device is signed in.
  for (const signIn of [
    { kind: "starting" },
    WAITING.signIn,
    { kind: "completing" },
  ] as const) {
    expect(showsTwoFactorNote({ ...IDLE, signIn }), signIn.kind).toBe(false);
    expect(showsTwoFactorNote({ ...signedIn, signIn }), signIn.kind).toBe(
      false,
    );
  }
});

test("the note on two-factor authentication is one fixed text without an address (D6)", () => {
  expect(TWO_FACTOR_NOTE).toBe(
    "Turn on two-factor authentication for the GitHub account that you sign in with. MyManDev has no password of its own: whoever can sign in to that GitHub account can use your MyManDev account.",
  );
  expect(TWO_FACTOR_NOTE).not.toMatch(/https?:|www\.|\.com\b|[<>{}]/);
  expect(TWO_FACTOR_NOTE).toMatch(/^[\x20-\x7e]+$/);
});
