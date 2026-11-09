import { expect, test } from "vitest";
import type { DeviceListBridge } from "../shared/desktop-bridge.ts";
import {
  DEVICE_LIST_ACTION_FAILURES,
  DEVICE_LIST_PROBLEMS,
  DEVICE_PLATFORMS,
  LIFT_REGISTRATION_LOCK_REFUSALS,
  REVOKE_DEVICE_REFUSALS,
  type DeviceListLoadResult,
  type DeviceListView,
  type DeviceView,
  type LiftRegistrationLockResult,
  type RevokeOtherDeviceResult,
} from "../shared/ipc-contract.ts";
import {
  createDeviceActions,
  DEVICE_ACTION_LABELS,
  DEVICE_ACTION_REFUSAL_MESSAGES,
  DEVICE_ACTION_RESULT_MESSAGES,
  DEVICE_LIST_ACTION_FAILURE_MESSAGES,
  DEVICE_LIST_MESSAGES,
  DEVICE_LIST_PROBLEM_MESSAGES,
  focusesActionMessage,
  IDLE_DEVICE_ACTIONS,
  liftRegistrationLockOutcome,
  LOST_DEVICE_ADVICE,
  revokeDeviceOutcome,
  type DeviceActionsView,
  describeDeviceList,
  deviceTimeFormat,
  followDeviceList,
  formatDeviceTime,
  initialDeviceSectionView,
  isNewDevice,
  NEW_DEVICE_WINDOW_MS,
  nextDeviceListChange,
  PLATFORM_NAMES,
  registrationLockInForce,
  type DeviceSectionView,
} from "./device-view.ts";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function at(ms: number): string {
  return new Date(ms).toISOString();
}

const THIS_DEVICE: DeviceView = {
  id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3",
  label: "Mac",
  platform: "macos",
  createdAt: at(NOW - 30 * DAY_MS),
  lastSeenAt: at(NOW - 60_000),
  lastSignInAt: at(NOW - 2 * DAY_MS),
  signInExpiresAt: at(NOW + 28 * DAY_MS),
  revokedAt: null,
  current: true,
};

const NEW_LAPTOP: DeviceView = {
  ...THIS_DEVICE,
  id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4",
  label: "Work laptop",
  platform: "windows",
  createdAt: at(NOW - DAY_MS),
  lastSeenAt: null,
  current: false,
};

const LOST_LAPTOP: DeviceView = {
  ...THIS_DEVICE,
  id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a5",
  label: "Lost laptop",
  platform: "linux",
  createdAt: at(NOW - 3 * DAY_MS),
  revokedAt: at(NOW - 2 * DAY_MS),
  current: false,
};

function known(state: Partial<DeviceListView>): DeviceSectionView {
  return {
    kind: "known",
    state: {
      status: "ready",
      revision: 1,
      devices: [NEW_LAPTOP, THIS_DEVICE, LOST_LAPTOP],
      registrationLockedUntil: null,
      newDevices: [],
      ...state,
    } as DeviceListView,
  };
}

test("without the bridge the view is unavailable, and with it pending until the first state", () => {
  expect(initialDeviceSectionView(false)).toEqual({ kind: "unavailable" });
  expect(initialDeviceSectionView(true)).toEqual({ kind: "pending" });
});

test("following the device list subscribes, asks the main process to load it once, and reports each state and a refused subscription", async () => {
  const calls: string[] = [];
  let deliver: (state: DeviceListView) => void = () => undefined;
  let refuse: () => void = () => undefined;
  let ended = false;
  const bridge: Pick<DeviceListBridge, "subscribeState" | "load"> = {
    subscribeState: (listener, onError) => {
      calls.push("subscribe");
      deliver = listener;
      refuse = onError ?? (() => undefined);
      return () => {
        ended = true;
      };
    },
    load: () => {
      calls.push("load");
      return Promise.resolve<DeviceListLoadResult>({
        outcome: "refused",
        reason: "too_soon",
      });
    },
  };
  const views: DeviceSectionView[] = [];
  const stop = followDeviceList(bridge, (view) => views.push(view));

  expect(calls).toEqual(["subscribe", "load"]);
  const ready = (known({}) as { state: DeviceListView }).state;
  deliver(ready);
  refuse();
  expect(views).toEqual([
    { kind: "known", state: ready },
    { kind: "unavailable" },
  ]);
  stop();
  expect(ended).toBe(true);
  // A refused or failed load changes nothing that the section shows.
  await Promise.resolve();
  expect(views).toHaveLength(2);

  const failing = followDeviceList(
    {
      subscribeState: () => () => undefined,
      load: () => Promise.reject(new Error("refused")),
    },
    (view) => views.push(view),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(views).toHaveLength(2);
  failing();
});

test("each state has its fixed text, and an unavailable list keeps what was loaded before with its problem", () => {
  expect(describeDeviceList({ kind: "unavailable" }, NOW)).toEqual({
    status: DEVICE_LIST_MESSAGES.unavailable,
    newDevices: [],
    lockedUntil: null,
    lists: null,
  });
  expect(describeDeviceList({ kind: "pending" }, NOW).status).toBe(
    DEVICE_LIST_MESSAGES.pending,
  );
  expect(
    describeDeviceList(known({ status: "signed_out", devices: [] }), NOW),
  ).toEqual({
    status: DEVICE_LIST_MESSAGES.signedOut,
    newDevices: [],
    lockedUntil: null,
    lists: null,
  });
  expect(
    describeDeviceList(known({ status: "loading", devices: [] }), NOW),
  ).toMatchObject({ status: DEVICE_LIST_MESSAGES.loading, lists: null });
  expect(describeDeviceList(known({ devices: [] }), NOW)).toMatchObject({
    status: DEVICE_LIST_MESSAGES.empty,
    lists: null,
  });
  expect(describeDeviceList(known({}), NOW).status).toBe("");

  for (const problem of DEVICE_LIST_PROBLEMS) {
    const withList = describeDeviceList(
      known({ status: "unavailable", problem } as Partial<DeviceListView>),
      NOW,
    );
    expect(withList.status).toBe(DEVICE_LIST_PROBLEM_MESSAGES[problem]);
    expect(withList.lists?.active).toHaveLength(2);
    // Without anything loaded, only the problem shows.
    const without = describeDeviceList(
      known({
        status: "unavailable",
        problem,
        devices: [],
      } as Partial<DeviceListView>),
      NOW,
    );
    expect(without.status).toBe(DEVICE_LIST_PROBLEM_MESSAGES[problem]);
    expect(without.lists).toBeNull();
  }
  expect(Object.keys(DEVICE_LIST_PROBLEM_MESSAGES).sort()).toEqual(
    [...DEVICE_LIST_PROBLEMS].sort(),
  );
  expect(Object.keys(PLATFORM_NAMES).sort()).toEqual(
    [...DEVICE_PLATFORMS].sort(),
  );
});

test("the active devices come first in the main process's order, with this device marked, and the revoked ones apart", () => {
  const { lists } = describeDeviceList(known({}), NOW);

  expect(lists?.active).toEqual([
    {
      id: NEW_LAPTOP.id,
      label: "Work laptop",
      platformName: "Windows",
      current: false,
      isNew: true,
      createdAt: NEW_LAPTOP.createdAt,
      lastSeenAt: null,
      lastSignInAt: NEW_LAPTOP.lastSignInAt,
      signInExpiresAt: NEW_LAPTOP.signInExpiresAt,
      revokedAt: null,
    },
    {
      id: THIS_DEVICE.id,
      label: "Mac",
      platformName: "macOS",
      current: true,
      isNew: false,
      createdAt: THIS_DEVICE.createdAt,
      lastSeenAt: THIS_DEVICE.lastSeenAt,
      lastSignInAt: THIS_DEVICE.lastSignInAt,
      signInExpiresAt: THIS_DEVICE.signInExpiresAt,
      revokedAt: null,
    },
  ]);
  expect(lists?.revoked).toEqual([
    expect.objectContaining({
      id: LOST_LAPTOP.id,
      platformName: "Linux",
      isNew: true,
      revokedAt: LOST_LAPTOP.revokedAt,
    }),
  ]);
  // Without active devices, the revoked ones still show.
  expect(
    describeDeviceList(known({ devices: [LOST_LAPTOP] }), NOW).lists,
  ).toMatchObject({ active: [], revoked: [{ id: LOST_LAPTOP.id }] });
});

test("a device created in the last 7 days is new, by the renderer's clock", () => {
  expect(NEW_DEVICE_WINDOW_MS).toBe(7 * DAY_MS);
  const created = NOW - 7 * DAY_MS;
  expect(isNewDevice(at(created), NOW - 1)).toBe(true);
  expect(isNewDevice(at(created), NOW)).toBe(false);
  expect(isNewDevice(at(created), NOW + DAY_MS)).toBe(false);
  // A creation time later than the clock, for example a clock behind.
  expect(isNewDevice(at(NOW + 60_000), NOW)).toBe(true);
  expect(isNewDevice("not a time", NOW)).toBe(false);
});

test("the registration lock shows while its end is later than now, and only with a list", () => {
  const end = at(NOW + DAY_MS);
  expect(registrationLockInForce(end, NOW)).toBe(true);
  expect(registrationLockInForce(end, NOW + DAY_MS)).toBe(false);
  expect(registrationLockInForce(null, NOW)).toBe(false);
  expect(registrationLockInForce("soon", NOW)).toBe(false);

  expect(
    describeDeviceList(known({ registrationLockedUntil: end }), NOW)
      .lockedUntil,
  ).toBe(end);
  expect(
    describeDeviceList(known({ registrationLockedUntil: end }), NOW + DAY_MS)
      .lockedUntil,
  ).toBeNull();
  expect(
    describeDeviceList(
      known({ registrationLockedUntil: end, devices: [] }),
      NOW,
    ).lockedUntil,
  ).toBeNull();
  expect(
    describeDeviceList(
      known({
        status: "unavailable",
        problem: "unavailable",
        registrationLockedUntil: end,
      } as Partial<DeviceListView>),
      NOW,
    ).lockedUntil,
  ).toBe(end);
});

test("the notices of new devices show with a signed-in device, in their order, also while the list loads or is unavailable", () => {
  const notice = {
    id: NEW_LAPTOP.id,
    label: "Work laptop",
    platform: "windows" as const,
    createdAt: NEW_LAPTOP.createdAt,
  };
  const expected = [
    {
      id: NEW_LAPTOP.id,
      label: "Work laptop",
      platformName: "Windows",
      createdAt: NEW_LAPTOP.createdAt,
    },
  ];
  for (const state of [
    {},
    { status: "loading", devices: [] },
    { status: "unavailable", problem: "failed", devices: [] },
  ] as Partial<DeviceListView>[]) {
    expect(
      describeDeviceList(known({ ...state, newDevices: [notice] }), NOW)
        .newDevices,
    ).toEqual(expected);
  }
});

test("the next change by the clock alone is the earliest end of a new device's 7 days or of the lock", () => {
  const lockEnd = NOW + 3 * 60 * 60 * 1000;
  expect(
    nextDeviceListChange(known({ registrationLockedUntil: at(lockEnd) }), NOW),
  ).toBe(lockEnd);
  // The lost laptop stops being new 4 days from now, before the lock ends.
  expect(
    nextDeviceListChange(
      known({ registrationLockedUntil: at(NOW + 6.5 * DAY_MS) }),
      NOW,
    ),
  ).toBe(Date.parse(LOST_LAPTOP.createdAt) + NEW_DEVICE_WINDOW_MS);
  expect(nextDeviceListChange(known({ devices: [THIS_DEVICE] }), NOW)).toBe(
    undefined,
  );
  expect(nextDeviceListChange({ kind: "pending" }, NOW)).toBeUndefined();
});

test("the times show in the locale and the time zone given, as the chat screen shows them", () => {
  const format = deviceTimeFormat({ locale: "en-GB", timeZone: "UTC" });
  expect(formatDeviceTime("2026-11-06T09:30:00.000Z", format)).toBe(
    "6 Nov 2026, 09:30",
  );
  const istanbul = deviceTimeFormat({
    locale: "en-GB",
    timeZone: "Europe/Istanbul",
  });
  expect(formatDeviceTime("2026-11-06T09:30:00.000Z", istanbul)).toBe(
    "6 Nov 2026, 12:30",
  );
  expect(formatDeviceTime("not a time", format)).toBe("not a time");
  expect(deviceTimeFormat().resolvedOptions().timeZone).toBe(
    new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
});

// ---- The device actions (#95, D1) ----------------------------------------

test("every result of a revocation has its fixed sentence, and the advice follows a revocation as lost, also when the answer does not show whether it was revoked", () => {
  expect(
    revokeDeviceOutcome({ outcome: "revoked", reason: "lost" }, "lost"),
  ).toEqual({
    message: DEVICE_ACTION_RESULT_MESSAGES.revokedAsLost,
    advice: true,
    done: true,
  });
  expect(
    revokeDeviceOutcome({ outcome: "revoked", reason: "removed" }, "removed"),
  ).toEqual({
    message: DEVICE_ACTION_RESULT_MESSAGES.removed,
    advice: false,
    done: true,
  });
  expect(revokeDeviceOutcome({ outcome: "cancelled" }, "lost")).toEqual({
    message: undefined,
    advice: false,
    done: false,
  });
  expect(revokeDeviceOutcome({ outcome: "unknown" }, "lost")).toEqual({
    message: `${DEVICE_ACTION_RESULT_MESSAGES.revokeUnknown} ${DEVICE_ACTION_RESULT_MESSAGES.adviceFollows}`,
    advice: true,
    done: false,
  });
  expect(revokeDeviceOutcome({ outcome: "unknown" }, "removed")).toEqual({
    message: DEVICE_ACTION_RESULT_MESSAGES.revokeUnknown,
    advice: false,
    done: false,
  });
  for (const reason of REVOKE_DEVICE_REFUSALS) {
    const outcome = revokeDeviceOutcome({ outcome: "refused", reason }, "lost");
    expect(outcome, reason).toEqual({
      message: `${DEVICE_ACTION_RESULT_MESSAGES.revokeNotDone} ${DEVICE_ACTION_REFUSAL_MESSAGES[reason]}`,
      advice: false,
      done: false,
    });
  }
  for (const reason of DEVICE_LIST_ACTION_FAILURES) {
    const outcome = revokeDeviceOutcome({ outcome: "failed", reason }, "lost");
    expect(outcome, reason).toEqual({
      message: `${DEVICE_ACTION_RESULT_MESSAGES.revokeNotDone} ${DEVICE_LIST_ACTION_FAILURE_MESSAGES[reason]}`,
      advice: false,
      done: false,
    });
  }
  expect(DEVICE_ACTION_RESULT_MESSAGES.revokedAsLost).toContain("7 days");
  expect(DEVICE_LIST_ACTION_FAILURE_MESSAGES.conflict).toBe(
    "The device was revoked already.",
  );
});

test("every result of a lift has its fixed sentence, and no advice", () => {
  expect(liftRegistrationLockOutcome({ outcome: "lifted" })).toEqual({
    message: DEVICE_ACTION_RESULT_MESSAGES.lifted,
    advice: false,
    done: true,
  });
  expect(liftRegistrationLockOutcome({ outcome: "cancelled" })).toEqual({
    message: undefined,
    advice: false,
    done: false,
  });
  expect(liftRegistrationLockOutcome({ outcome: "unknown" })).toEqual({
    message: DEVICE_ACTION_RESULT_MESSAGES.liftUnknown,
    advice: false,
    done: false,
  });
  for (const reason of LIFT_REGISTRATION_LOCK_REFUSALS) {
    expect(
      liftRegistrationLockOutcome({ outcome: "refused", reason }).message,
      reason,
    ).toBe(
      `${DEVICE_ACTION_RESULT_MESSAGES.liftNotDone} ${DEVICE_ACTION_REFUSAL_MESSAGES[reason]}`,
    );
  }
  for (const reason of DEVICE_LIST_ACTION_FAILURES) {
    expect(
      liftRegistrationLockOutcome({ outcome: "failed", reason }).message,
      reason,
    ).toBe(
      `${DEVICE_ACTION_RESULT_MESSAGES.liftNotDone} ${DEVICE_LIST_ACTION_FAILURE_MESSAGES[reason]}`,
    );
  }
});

test("the advice after a revocation as lost names ADR 0014's three steps, with GitHub's sessions as an address in the text", () => {
  expect(LOST_DEVICE_ADVICE).toEqual({
    title: "After a lost device",
    steps: [
      "End that device's GitHub sessions: open github.com/settings/sessions in your browser and revoke them.",
      "If the device was unlocked, change your GitHub password.",
      "Rotate the AI provider credentials that are stored on that device. The server cannot reach them.",
    ],
  });
  expect(Object.isFrozen(LOST_DEVICE_ADVICE.steps)).toBe(true);
  expect(DEVICE_ACTION_LABELS).toEqual({
    remove: "Remove",
    revokeAsLost: "Revoke as lost",
    notMe: "This was not me: revoke as lost",
    liftLock: "Lift the registration lock",
    dismissAdvice: "Dismiss the advice",
  });
});

/** A device list bridge whose answers the test settles. */
function actionBridge() {
  const calls: string[] = [];
  let settleRevoke: (result: RevokeOtherDeviceResult) => void = () => undefined;
  let failRevoke: (error: Error) => void = () => undefined;
  let settleLift: (result: LiftRegistrationLockResult) => void = () =>
    undefined;
  const bridge: Pick<
    DeviceListBridge,
    "revokeDevice" | "liftRegistrationLock"
  > = {
    revokeDevice: (deviceId, reason) => {
      calls.push(`revoke ${deviceId} ${reason}`);
      return new Promise((resolve, reject) => {
        settleRevoke = resolve;
        failRevoke = reject;
      });
    },
    liftRegistrationLock: () => {
      calls.push("lift");
      return new Promise((resolve) => {
        settleLift = resolve;
      });
    },
  };
  return {
    bridge,
    calls,
    revoked: (result: RevokeOtherDeviceResult) => settleRevoke(result),
    revokeFails: () => failRevoke(new Error("refused")),
    lifted: (result: LiftRegistrationLockResult) => settleLift(result),
  };
}

test("one device action runs at a time and the view says so; a new action clears the last sentence, and the advice stays until it is dismissed", async () => {
  const fake = actionBridge();
  const views: DeviceActionsView[] = [];
  const actions = createDeviceActions(fake.bridge, (view) => views.push(view));

  const revoking = actions.revoke(NEW_LAPTOP.id, "lost");
  expect(views.at(-1)).toEqual({
    running: true,
    message: undefined,
    advice: false,
  });
  // A click while it runs changes nothing.
  await expect(actions.revoke(NEW_LAPTOP.id, "removed")).resolves.toBe(false);
  await expect(actions.lift()).resolves.toBe(false);
  expect(fake.calls).toEqual([`revoke ${NEW_LAPTOP.id} lost`]);

  fake.revoked({ outcome: "revoked", reason: "lost" });
  await expect(revoking).resolves.toBe(true);
  expect(views.at(-1)).toEqual({
    running: false,
    message: DEVICE_ACTION_RESULT_MESSAGES.revokedAsLost,
    advice: true,
  });

  // The next action clears the sentence, and the advice stays.
  const lifting = actions.lift();
  expect(views.at(-1)).toEqual({
    running: true,
    message: undefined,
    advice: true,
  });
  fake.lifted({ outcome: "refused", reason: "no_lock" });
  await expect(lifting).resolves.toBe(false);
  expect(views.at(-1)).toEqual({
    running: false,
    message: `${DEVICE_ACTION_RESULT_MESSAGES.liftNotDone} ${DEVICE_ACTION_REFUSAL_MESSAGES.no_lock}`,
    advice: true,
  });

  actions.dismissAdvice();
  expect(views.at(-1)).toEqual({
    running: false,
    message: `${DEVICE_ACTION_RESULT_MESSAGES.liftNotDone} ${DEVICE_ACTION_REFUSAL_MESSAGES.no_lock}`,
    advice: false,
  });
  const count = views.length;
  actions.dismissAdvice();
  expect(views).toHaveLength(count);
  expect(Object.isFrozen(views.at(-1))).toBe(true);
  expect(IDLE_DEVICE_ACTIONS).toEqual({
    running: false,
    message: undefined,
    advice: false,
  });
});

test("a call that fails says that the action could not be done and to try again, and a kept confirmation says nothing", async () => {
  const fake = actionBridge();
  const views: DeviceActionsView[] = [];
  const actions = createDeviceActions(fake.bridge, (view) => views.push(view));

  const failing = actions.revoke(NEW_LAPTOP.id, "removed");
  fake.revokeFails();
  await expect(failing).resolves.toBe(false);
  expect(views.at(-1)).toEqual({
    running: false,
    message: "The device could not be revoked. Try again.",
    advice: false,
  });

  const kept = actions.revoke(NEW_LAPTOP.id, "lost");
  fake.revoked({ outcome: "cancelled" });
  await expect(kept).resolves.toBe(false);
  expect(views.at(-1)).toEqual({
    running: false,
    message: undefined,
    advice: false,
  });

  const lifted = actions.lift();
  fake.lifted({ outcome: "lifted" });
  await expect(lifted).resolves.toBe(true);
  expect(views.at(-1)?.message).toBe(DEVICE_ACTION_RESULT_MESSAGES.lifted);
});

test("the focus moves to the action's sentence only after an action whose button leaves the page, while the focus is still on that button or on the page", () => {
  expect(focusesActionMessage(true, true)).toBe(true);
  expect(focusesActionMessage(true, false)).toBe(false);
  expect(focusesActionMessage(false, true)).toBe(false);
  expect(focusesActionMessage(false, false)).toBe(false);
});
