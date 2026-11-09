import { expect, test } from "vitest";
import type { DeviceListBridge } from "../shared/desktop-bridge.ts";
import {
  DEVICE_LIST_PROBLEMS,
  DEVICE_PLATFORMS,
  type DeviceListLoadResult,
  type DeviceListView,
  type DeviceView,
} from "../shared/ipc-contract.ts";
import {
  DEVICE_LIST_MESSAGES,
  DEVICE_LIST_PROBLEM_MESSAGES,
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
