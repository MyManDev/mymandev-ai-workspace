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
  focusesTitleAfterAction,
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
      lostDeviceAdvice: false,
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
    lostDeviceAdvice: false,
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
    lostDeviceAdvice: false,
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

test("every result of a revocation has its fixed sentence, which points to the advice after a revocation as lost, also when the answer does not show whether it was revoked", () => {
  expect(
    revokeDeviceOutcome({ outcome: "revoked", reason: "lost" }, "lost"),
  ).toEqual({
    message: DEVICE_ACTION_RESULT_MESSAGES.revokedAsLost,
    done: true,
  });
  expect(
    revokeDeviceOutcome({ outcome: "revoked", reason: "removed" }, "removed"),
  ).toEqual({ message: DEVICE_ACTION_RESULT_MESSAGES.removed, done: true });
  expect(revokeDeviceOutcome({ outcome: "cancelled" }, "lost")).toEqual({
    message: undefined,
    done: false,
  });
  expect(revokeDeviceOutcome({ outcome: "unknown" }, "lost")).toEqual({
    message: `${DEVICE_ACTION_RESULT_MESSAGES.revokeUnknown} ${DEVICE_ACTION_RESULT_MESSAGES.adviceFollows}`,
    done: false,
  });
  expect(revokeDeviceOutcome({ outcome: "unknown" }, "removed")).toEqual({
    message: DEVICE_ACTION_RESULT_MESSAGES.revokeUnknown,
    done: false,
  });
  for (const reason of REVOKE_DEVICE_REFUSALS) {
    expect(
      revokeDeviceOutcome({ outcome: "refused", reason }, "lost"),
      reason,
    ).toEqual({
      message: `${DEVICE_ACTION_RESULT_MESSAGES.revokeNotDone} ${DEVICE_ACTION_REFUSAL_MESSAGES[reason]}`,
      done: false,
    });
  }
  for (const reason of DEVICE_LIST_ACTION_FAILURES) {
    expect(
      revokeDeviceOutcome({ outcome: "failed", reason }, "lost"),
      reason,
    ).toEqual({
      message: `${DEVICE_ACTION_RESULT_MESSAGES.revokeNotDone} ${DEVICE_LIST_ACTION_FAILURE_MESSAGES[reason]}`,
      done: false,
    });
  }
  expect(DEVICE_ACTION_RESULT_MESSAGES.revokedAsLost).toContain("7 days");
  expect(DEVICE_ACTION_RESULT_MESSAGES.revokedAsLost).toContain(
    "Follow the advice below.",
  );
  expect(DEVICE_LIST_ACTION_FAILURE_MESSAGES.conflict).toBe(
    "The device was revoked already.",
  );
});

test("every result of a lift has its fixed sentence", () => {
  expect(liftRegistrationLockOutcome({ outcome: "lifted" })).toEqual({
    message: DEVICE_ACTION_RESULT_MESSAGES.lifted,
    done: true,
  });
  expect(DEVICE_ACTION_RESULT_MESSAGES.lifted).toBe(
    "The registration lock was lifted. New devices can register on this account again.",
  );
  expect(liftRegistrationLockOutcome({ outcome: "cancelled" })).toEqual({
    message: undefined,
    done: false,
  });
  expect(liftRegistrationLockOutcome({ outcome: "unknown" })).toEqual({
    message: DEVICE_ACTION_RESULT_MESSAGES.liftUnknown,
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

test("the advice after a revocation as lost names ADR 0014's three steps, with GitHub's sessions as an address in the text, and shows while the list holds it", () => {
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
  // The main process holds the advice; the model passes it on, also while
  // the list loads again or is unavailable, and never without a state.
  for (const state of [
    {},
    { status: "loading", devices: [] },
    { status: "unavailable", problem: "failed" },
  ] as Partial<DeviceListView>[]) {
    expect(
      describeDeviceList(known({ ...state, lostDeviceAdvice: true }), NOW)
        .lostDeviceAdvice,
      JSON.stringify(state),
    ).toBe(true);
  }
  expect(describeDeviceList(known({}), NOW).lostDeviceAdvice).toBe(false);
  for (const view of [{ kind: "pending" }, { kind: "unavailable" }] as const) {
    expect(describeDeviceList(view, NOW).lostDeviceAdvice).toBe(false);
  }
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

test("one device action runs at a time and the view says so, and a new action clears the last sentence", async () => {
  const fake = actionBridge();
  const views: DeviceActionsView[] = [];
  const actions = createDeviceActions(fake.bridge, (view) => views.push(view));

  const revoking = actions.revoke(NEW_LAPTOP.id, "lost");
  expect(views.at(-1)).toEqual({ running: true, message: undefined });
  // A click while it runs changes nothing.
  await expect(actions.revoke(NEW_LAPTOP.id, "removed")).resolves.toBe(false);
  await expect(actions.lift()).resolves.toBe(false);
  expect(fake.calls).toEqual([`revoke ${NEW_LAPTOP.id} lost`]);

  fake.revoked({ outcome: "revoked", reason: "lost" });
  await expect(revoking).resolves.toBe(true);
  expect(views.at(-1)).toEqual({
    running: false,
    message: DEVICE_ACTION_RESULT_MESSAGES.revokedAsLost,
  });

  // The next action clears the sentence.
  const lifting = actions.lift();
  expect(views.at(-1)).toEqual({ running: true, message: undefined });
  fake.lifted({ outcome: "refused", reason: "no_lock" });
  await expect(lifting).resolves.toBe(false);
  expect(views.at(-1)).toEqual({
    running: false,
    message: `${DEVICE_ACTION_RESULT_MESSAGES.liftNotDone} ${DEVICE_ACTION_REFUSAL_MESSAGES.no_lock}`,
  });
  expect(Object.isFrozen(views.at(-1))).toBe(true);
  expect(IDLE_DEVICE_ACTIONS).toEqual({ running: false, message: undefined });
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
  });

  const kept = actions.revoke(NEW_LAPTOP.id, "lost");
  fake.revoked({ outcome: "cancelled" });
  await expect(kept).resolves.toBe(false);
  expect(views.at(-1)).toEqual({ running: false, message: undefined });

  const lifted = actions.lift();
  fake.lifted({ outcome: "lifted" });
  await expect(lifted).resolves.toBe(true);
  expect(views.at(-1)?.message).toBe(DEVICE_ACTION_RESULT_MESSAGES.lifted);
});

test("the sentence of the last action goes with a sign-out, a list that loads again for a device, and another device named as this one, and stays otherwise", async () => {
  const sentence = async () => {
    const fake = actionBridge();
    const views: DeviceActionsView[] = [];
    const actions = createDeviceActions(fake.bridge, (view) =>
      views.push(view),
    );
    actions.listChanged(known({}));
    const removing = actions.revoke(NEW_LAPTOP.id, "removed");
    fake.revoked({ outcome: "revoked", reason: "removed" });
    await removing;
    expect(views.at(-1)?.message).toBe(DEVICE_ACTION_RESULT_MESSAGES.removed);
    return { actions, views };
  };

  // The same device's list, also updated, unavailable, or before the first
  // state, keeps it.
  const kept = await sentence();
  for (const view of [
    known({ revision: 2, devices: [THIS_DEVICE] }),
    known({ status: "unavailable", problem: "failed" }),
    { kind: "pending" },
    { kind: "unavailable" },
  ] as DeviceSectionView[]) {
    kept.actions.listChanged(view);
  }
  expect(kept.views.at(-1)?.message).toBe(
    DEVICE_ACTION_RESULT_MESSAGES.removed,
  );

  const otherThis: DeviceView = {
    ...THIS_DEVICE,
    id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b9",
  };
  for (const [name, view] of [
    ["signed out", known({ status: "signed_out", devices: [] })],
    ["loading after a drop", known({ status: "loading", devices: [] })],
    ["another device", known({ devices: [otherThis, NEW_LAPTOP] })],
  ] as const) {
    const { actions, views } = await sentence();
    const count = views.length;
    actions.listChanged(view);
    expect(views.at(-1), name).toEqual({ running: false, message: undefined });
    expect(views, name).toHaveLength(count + 1);
    // Nothing more to clear.
    actions.listChanged(view);
    expect(views, name).toHaveLength(count + 1);
  }
});

/** This device's list after a sign-in as another device. */
const ANOTHER_THIS_DEVICE: DeviceView = {
  ...THIS_DEVICE,
  id: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c1",
};

/** The notice of `NEW_LAPTOP`. */
const NEW_LAPTOP_NOTICE = {
  id: NEW_LAPTOP.id,
  label: NEW_LAPTOP.label,
  platform: NEW_LAPTOP.platform,
  createdAt: NEW_LAPTOP.createdAt,
};

function stateOf(view: DeviceSectionView): DeviceListView {
  if (view.kind !== "known") {
    throw new Error("The view has no state.");
  }
  return view.state;
}

test("the list's first load for a device keeps the sentence of a notice's action that ran before it, also after a sign-in as another device", async () => {
  const fake = actionBridge();
  const views: DeviceActionsView[] = [];
  const actions = createDeviceActions(fake.bridge, (view) => views.push(view));
  const notMe = async () => {
    const revoking = actions.revoke(NEW_LAPTOP.id, "lost");
    fake.revoked({ outcome: "revoked", reason: "lost" });
    await expect(revoking).resolves.toBe(true);
    expect(views.at(-1)?.message).toBe(
      DEVICE_ACTION_RESULT_MESSAGES.revokedAsLost,
    );
  };
  const loading = known({
    status: "loading",
    devices: [],
    newDevices: [NEW_LAPTOP_NOTICE],
  });
  // The advice and the end of the notice come while the list still loads,
  // and then the list itself.
  const afterwards = (devices: DeviceView[]) => [
    known({
      status: "loading",
      revision: 2,
      devices: [],
      lostDeviceAdvice: true,
    }),
    known({ revision: 3, devices, lostDeviceAdvice: true }),
  ];

  actions.listChanged(loading);
  await notMe();
  for (const view of afterwards([NEW_LAPTOP, THIS_DEVICE])) {
    actions.listChanged(view);
  }
  expect(views.at(-1)?.message).toBe(
    DEVICE_ACTION_RESULT_MESSAGES.revokedAsLost,
  );

  // A sign-out, and a sign-in as another device, whose list has not loaded.
  actions.listChanged(known({ status: "signed_out", devices: [] }));
  expect(views.at(-1)?.message).toBeUndefined();
  actions.listChanged(loading);
  await notMe();
  for (const view of afterwards([NEW_LAPTOP, ANOTHER_THIS_DEVICE])) {
    actions.listChanged(view);
  }
  expect(views.at(-1)?.message).toBe(
    DEVICE_ACTION_RESULT_MESSAGES.revokedAsLost,
  );

  // A drop to another device without a sign-out: the list loads again
  // after a list that had loaded, and then names another device.
  actions.listChanged(loading);
  expect(views.at(-1)?.message).toBeUndefined();
  await notMe();
  for (const view of afterwards([NEW_LAPTOP, THIS_DEVICE])) {
    actions.listChanged(view);
  }
  expect(views.at(-1)?.message).toBe(
    DEVICE_ACTION_RESULT_MESSAGES.revokedAsLost,
  );
});

test("an action whose answer comes after a sign-out, a drop of the list, or another device shows no sentence, whatever the answer", async () => {
  type Fake = ReturnType<typeof actionBridge>;
  type Actions = ReturnType<typeof createDeviceActions>;
  // Each kind of answer: the call, and how the test settles it.
  const answers: readonly (readonly [
    string,
    (actions: Actions) => Promise<boolean>,
    (fake: Fake) => void,
  ])[] = [
    [
      "removed",
      (actions) => actions.revoke(NEW_LAPTOP.id, "removed"),
      (fake) => fake.revoked({ outcome: "revoked", reason: "removed" }),
    ],
    [
      "revoked as lost",
      (actions) => actions.revoke(NEW_LAPTOP.id, "lost"),
      (fake) => fake.revoked({ outcome: "revoked", reason: "lost" }),
    ],
    [
      "a rejected call",
      (actions) => actions.revoke(NEW_LAPTOP.id, "removed"),
      (fake) => fake.revokeFails(),
    ],
    [
      "a refused revocation",
      (actions) => actions.revoke(NEW_LAPTOP.id, "removed"),
      (fake) => fake.revoked({ outcome: "refused", reason: "not_listed" }),
    ],
    [
      "an unknown revocation",
      (actions) => actions.revoke(NEW_LAPTOP.id, "lost"),
      (fake) => fake.revoked({ outcome: "unknown" }),
    ],
    [
      "lifted",
      (actions) => actions.lift(),
      (fake) => fake.lifted({ outcome: "lifted" }),
    ],
    [
      "a refused lift",
      (actions) => actions.lift(),
      (fake) => fake.lifted({ outcome: "refused", reason: "no_lock" }),
    ],
  ];
  const drops: readonly (readonly [string, readonly DeviceSectionView[]])[] = [
    ["signed out", [known({ status: "signed_out", devices: [] })]],
    ["loading after ready", [known({ status: "loading", devices: [] })]],
    [
      "loading after unavailable",
      [
        known({ status: "unavailable", problem: "failed" }),
        known({ status: "loading", devices: [] }),
      ],
    ],
    [
      "signed out and in as another device",
      [
        known({ status: "signed_out", devices: [] }),
        known({ status: "loading", devices: [] }),
        known({ devices: [NEW_LAPTOP, ANOTHER_THIS_DEVICE] }),
      ],
    ],
    ["another device", [known({ devices: [ANOTHER_THIS_DEVICE] })]],
  ];
  for (const [dropName, drop] of drops) {
    for (const [answerName, start, settle] of answers) {
      const name = `${dropName}, ${answerName}`;
      const fake = actionBridge();
      const views: DeviceActionsView[] = [];
      const actions = createDeviceActions(fake.bridge, (view) =>
        views.push(view),
      );
      actions.listChanged(known({}));
      const acting = start(actions);
      for (const view of drop) {
        actions.listChanged(view);
      }
      settle(fake);
      await acting;
      expect(views.at(-1), name).toEqual({
        running: false,
        message: undefined,
      });

      // The next action on the same list says its sentence again.
      const lifting = actions.lift();
      fake.lifted({ outcome: "lifted" });
      await lifting;
      expect(views.at(-1)?.message, name).toBe(
        DEVICE_ACTION_RESULT_MESSAGES.lifted,
      );
    }
  }
});

test("a list that loads again after one that failed is a drop and clears the sentence", async () => {
  const fake = actionBridge();
  const views: DeviceActionsView[] = [];
  const actions = createDeviceActions(fake.bridge, (view) => views.push(view));
  actions.listChanged(known({}));
  const removing = actions.revoke(NEW_LAPTOP.id, "removed");
  fake.revoked({ outcome: "revoked", reason: "removed" });
  await removing;
  actions.listChanged(known({ status: "unavailable", problem: "failed" }));
  expect(views.at(-1)?.message).toBe(DEVICE_ACTION_RESULT_MESSAGES.removed);
  actions.listChanged(known({ status: "loading", devices: [] }));
  expect(views.at(-1)).toEqual({ running: false, message: undefined });
});

test("following the device list with the device actions tells them each view first, in the same call, so the sentence goes in the same render as the list", async () => {
  const log: string[] = [];
  let deliver: (state: DeviceListView) => void = () => undefined;
  const bridge: Pick<DeviceListBridge, "subscribeState" | "load"> = {
    subscribeState: (listener) => {
      deliver = listener;
      return () => undefined;
    },
    load: () => Promise.resolve<DeviceListLoadResult>({ outcome: "loading" }),
  };
  const fake = actionBridge();
  const actions = createDeviceActions(fake.bridge, (view) =>
    log.push(`sentence ${view.message ?? "none"}`),
  );
  followDeviceList(
    bridge,
    (view) =>
      log.push(`list ${view.kind === "known" ? view.state.status : view.kind}`),
    actions,
  );
  deliver(stateOf(known({})));
  const removing = actions.revoke(NEW_LAPTOP.id, "removed");
  fake.revoked({ outcome: "revoked", reason: "removed" });
  await removing;
  expect(log.at(-1)).toBe(`sentence ${DEVICE_ACTION_RESULT_MESSAGES.removed}`);

  log.length = 0;
  deliver(stateOf(known({ status: "signed_out", devices: [] })));
  expect(log).toEqual(["sentence none", "list signed_out"]);
});

test("the focus moves to the section's title only after an action whose button leaves the page, while the focus is still on that button or on the page", () => {
  expect(focusesTitleAfterAction(true, true)).toBe(true);
  expect(focusesTitleAfterAction(true, false)).toBe(false);
  expect(focusesTitleAfterAction(false, true)).toBe(false);
  expect(focusesTitleAfterAction(false, false)).toBe(false);
});
