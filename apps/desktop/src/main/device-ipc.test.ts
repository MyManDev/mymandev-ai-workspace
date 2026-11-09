import {
  DEVICE_PLATFORMS as PROTOCOL_DEVICE_PLATFORMS,
  DeviceListItemSchema,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  type DeviceId,
  type DeviceListItem,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  DEVICE_LIST_LIMITS,
  DEVICE_LIST_PROBLEMS,
  DEVICE_LIST_STATUSES,
  DEVICE_PLATFORMS,
  DeviceListViewSchema,
  type DeviceListLoadResult,
  type DeviceListView,
} from "../shared/ipc-contract.ts";
import { WORKSPACE_READ_FAILURES } from "./api-reads.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import {
  DEVICE_PUBLISH_INTERVAL_MS,
  deviceListView,
  registerDeviceIpc,
} from "./device-ipc.ts";
import {
  MAX_NEW_DEVICE_NOTICES,
  type DeviceListState,
  type DeviceListStatus,
  type NewDeviceNotice,
} from "./devices/service.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const DEVICE = id(0xd1);
const OTHER_DEVICE = id(0xd2);
const NEW_DEVICE = id(0xd3);
const USER = id(0xc1);
const AT = "2026-11-09T09:00:00.000Z";
const LATER = "2026-11-09T10:00:00.000Z";
const LOCK_END = "2026-11-16T10:00:00.000Z";

function device(
  deviceId: string,
  overrides: Partial<DeviceListItem> = {},
): DeviceListItem {
  return Object.freeze(
    DeviceListItemSchema.parse({
      id: deviceId,
      label: deviceId === DEVICE ? "Mac" : "Old laptop",
      platform: deviceId === DEVICE ? "macos" : "windows",
      createdAt: AT,
      lastSeenAt: deviceId === DEVICE ? LATER : null,
      lastSignInAt: AT,
      signInExpiresAt: "2026-12-09T09:00:00.000Z",
      revokedAt: null,
      current: deviceId === DEVICE,
      ...overrides,
    }),
  );
}

function notice(
  deviceId: string = NEW_DEVICE,
  label = "Work laptop",
): NewDeviceNotice {
  return Object.freeze({
    id: deviceId as DeviceId,
    label,
    platform: "linux",
    createdAt: LATER,
  });
}

function listState(overrides: Partial<DeviceListState> = {}): DeviceListState {
  return Object.freeze({
    revision: 1,
    status: "ready",
    devices: Object.freeze([
      device(DEVICE),
      device(OTHER_DEVICE, { revokedAt: LATER }),
    ]),
    registrationLockedUntil: LOCK_END,
    newDevices: Object.freeze([notice()]),
    ...overrides,
  } as DeviceListState);
}

const SIGNED_OUT: DeviceListState = Object.freeze({
  revision: 0,
  status: "signed_out",
  devices: Object.freeze([]),
  registrationLockedUntil: null,
  newDevices: Object.freeze([]),
});

interface Timer {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

/** The device list service, with listeners and answers the test controls. */
function fakeService(initial: DeviceListState = listState()) {
  let state = initial;
  const listeners = new Set<(state: DeviceListState) => void>();
  const timers: Timer[] = [];
  const errors: string[] = [];
  const calls: string[] = [];
  let loadAnswer: DeviceListLoadResult = { outcome: "loading" };
  let dismissAnswer = true;
  return {
    timers,
    errors,
    calls,
    listeners,
    answerLoad(answer: DeviceListLoadResult) {
      loadAnswer = answer;
    },
    answerDismiss(answer: boolean) {
      dismissAnswer = answer;
    },
    /** The timers that were neither cancelled nor fired. */
    waiting: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
    setState(next: DeviceListState) {
      state = next;
      for (const listener of [...listeners]) {
        listener(next);
      }
    },
    /** Fires every waiting timer once. */
    fire() {
      for (const timer of [...timers]) {
        if (!timer.cancelled && !timer.fired) {
          timer.fired = true;
          timer.callback();
        }
      }
    },
    options: {
      devices: {
        state: () => {
          calls.push("state");
          return state;
        },
        onChange: (listener: (state: DeviceListState) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        load: () => {
          calls.push("load");
          return loadAnswer;
        },
        dismissNewDevices: (deviceIds: readonly string[]) => {
          calls.push(`dismissNewDevices ${deviceIds.join(",")}`);
          return dismissAnswer;
        },
      },
      scheduleTimer: (callback: () => void, delayMs: number) => {
        const timer: Timer = {
          callback,
          delayMs,
          cancelled: false,
          fired: false,
        };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      onError: (message: string) => {
        errors.push(message);
      },
    },
  };
}

function frame(url: string, parent: IpcFrame | null = null): IpcFrame {
  return { url, parent, detached: false, isDestroyed: () => false };
}

function receiver(url: string = DEV_URL) {
  const sent: unknown[][] = [];
  const value: StatusReceiver & { sent: unknown[][] } = {
    mainFrame: frame(url),
    sent,
    isDestroyed: () => false,
    send: (channel, ...args) => {
      sent.push([channel, ...args]);
    },
    once: () => undefined,
  };
  return value;
}

function event(
  senderFrame: IpcFrame | null,
  sender: StatusReceiver = receiver(),
): IpcInvokeEvent {
  return { senderFrame, sender };
}

function register(
  fake: ReturnType<typeof fakeService>,
  appUrl: string = DEV_URL,
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const deviceIpc = registerDeviceIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    fake.options,
  );
  const call = (
    channel: string,
    sender: StatusReceiver = receiver(),
    ...args: unknown[]
  ) => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}.`);
    }
    return handler(event(frame(appUrl), sender), ...args);
  };
  const view = (sender?: StatusReceiver) =>
    call(INVOKE_CHANNELS.getDeviceList, sender) as DeviceListView;
  /** Subscribes a frame and returns the payloads that it receives. */
  const subscribe = () => {
    const subscriber = receiver(appUrl);
    const first = call(
      INVOKE_CHANNELS.subscribeDeviceList,
      subscriber,
    ) as DeviceListView;
    return {
      first,
      payloads: () =>
        subscriber.sent.map(([channel, payload]) => {
          expect(channel).toBe(EVENT_CHANNELS.deviceListChanged);
          return payload as DeviceListView;
        }),
    };
  };
  return { handlers, deviceIpc, call, view, subscribe };
}

const DEVICE_CHANNELS = [
  INVOKE_CHANNELS.getDeviceList,
  INVOKE_CHANNELS.subscribeDeviceList,
  INVOKE_CHANNELS.loadDeviceList,
  INVOKE_CHANNELS.dismissNewDevices,
];

test("the device list channels are registered, and nothing else", () => {
  const { handlers } = register(fakeService());
  expect([...handlers.keys()].sort()).toEqual([...DEVICE_CHANNELS].sort());
  expect(
    Object.values(INVOKE_CHANNELS).filter((channel) =>
      channel.startsWith("devices:"),
    ),
  ).toEqual(DEVICE_CHANNELS);
});

test("every handler refuses a foreign sender and arguments outside the contract, before the service is asked", () => {
  const fake = fakeService();
  const { handlers } = register(fake, APP_ENTRY_URL);
  for (const [channel, handler] of handlers) {
    for (const sender of [
      null,
      frame("https://example.invalid/"),
      frame(APP_ENTRY_URL, frame(APP_ENTRY_URL)),
      frame(DEV_URL),
    ]) {
      expect(() => handler(event(sender), [DEVICE]), channel).toThrow(
        `The call on ${channel} was refused: the sender is not the application.`,
      );
    }
    const refused: unknown[][] =
      channel === INVOKE_CHANNELS.dismissNewDevices
        ? [
            [],
            [DEVICE],
            [[]],
            [[DEVICE], "extra"],
            [[DEVICE.toUpperCase()]],
            // A UUID of another version.
            [["0192f0a0-7b3c-4d4e-8f50-0000000000d1"]],
            [[`${DEVICE}x`]],
            [[1]],
            [{ 0: DEVICE, length: 1 }],
            [
              Array.from(
                { length: DEVICE_LIST_LIMITS.newDevices + 1 },
                (_, n) => id(0x8000 + n),
              ),
            ],
          ]
        : [[DEVICE], [{ force: true }], [undefined], [true, 1]];
    for (const args of refused) {
      expect(
        () => handler(event(frame(APP_ENTRY_URL)), ...args),
        channel,
      ).toThrow(
        `The call on ${channel} was refused: the arguments do not match the contract.`,
      );
    }
  }
  expect(fake.calls).toEqual([]);
});

test("the view holds each device's ID, label, platform, times, and current mark, the lock end, and the notices, in the service's order", () => {
  const fake = fakeService();
  const { view } = register(fake);

  expect(view()).toEqual({
    status: "ready",
    revision: 0,
    devices: [
      {
        id: DEVICE,
        label: "Mac",
        platform: "macos",
        createdAt: AT,
        lastSeenAt: LATER,
        lastSignInAt: AT,
        signInExpiresAt: "2026-12-09T09:00:00.000Z",
        revokedAt: null,
        current: true,
      },
      {
        id: OTHER_DEVICE,
        label: "Old laptop",
        platform: "windows",
        createdAt: AT,
        lastSeenAt: null,
        lastSignInAt: AT,
        signInExpiresAt: "2026-12-09T09:00:00.000Z",
        revokedAt: LATER,
        current: false,
      },
    ],
    registrationLockedUntil: LOCK_END,
    newDevices: [
      {
        id: NEW_DEVICE,
        label: "Work laptop",
        platform: "linux",
        createdAt: LATER,
      },
    ],
  });
});

test("no user ID, key, token, or other key of the model crosses", () => {
  const leaky = {
    ...device(DEVICE),
    userId: USER,
    publicKey: "ab".repeat(32),
    accessToken: "mmda_secret",
  } as DeviceListItem;
  const leakyNotice = {
    ...notice(),
    userId: USER,
    publicKey: "ab".repeat(32),
  } as NewDeviceNotice;
  const fake = fakeService(
    listState({
      devices: Object.freeze([leaky]),
      newDevices: Object.freeze([leakyNotice]),
    }),
  );
  const { view, subscribe } = register(fake);
  const { first, payloads } = subscribe();
  fake.setState(
    listState({
      revision: 2,
      devices: Object.freeze([leaky]),
      newDevices: Object.freeze([leakyNotice]),
    }),
  );
  fake.fire();

  const views = [
    deviceListView(fake.options.devices.state(), 0),
    view(),
    first,
    ...payloads(),
  ];
  expect(views).toHaveLength(4);
  for (const item of views) {
    const text = JSON.stringify(item);
    for (const hidden of [USER, "publicKey", "userId", "mmda_"]) {
      expect(text).not.toContain(hidden);
    }
    expect(Object.keys(item.devices[0] ?? {}).sort()).toEqual([
      "createdAt",
      "current",
      "id",
      "label",
      "lastSeenAt",
      "lastSignInAt",
      "platform",
      "revokedAt",
      "signInExpiresAt",
    ]);
    expect(Object.keys(item.newDevices[0] ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "label",
      "platform",
    ]);
  }
});

test("the lists and labels are cut to the contract's limits: the first devices, the newest notices, and labels in characters", () => {
  const face = "\u{1F4BB}";
  const many = Array.from({ length: DEVICE_LIST_LIMITS.devices + 5 }, (_, n) =>
    device(id(0x5000 + n)),
  );
  const long = {
    ...device(DEVICE),
    label: face.repeat(DEVICE_LIST_LIMITS.label + 6),
  } as DeviceListItem;
  const notices = Array.from(
    { length: DEVICE_LIST_LIMITS.newDevices + 3 },
    (_, n) => notice(id(0x6000 + n)),
  );
  const longNotice = notice(
    id(0x7000),
    face.repeat(DEVICE_LIST_LIMITS.label + 1),
  );
  const fake = fakeService(
    listState({
      devices: Object.freeze([long, ...many]),
      newDevices: Object.freeze([...notices, longNotice]),
    }),
  );
  const { view } = register(fake);
  const value = view();

  expect(value.devices).toHaveLength(DEVICE_LIST_LIMITS.devices);
  expect(value.devices[0]?.label).toBe(face.repeat(DEVICE_LIST_LIMITS.label));
  expect(value.devices.at(-1)?.id).toBe(id(0x5000 + 998));
  expect(value.newDevices).toHaveLength(DEVICE_LIST_LIMITS.newDevices);
  expect(value.newDevices.map((item) => item.id)).toEqual([
    ...notices
      .slice(-(DEVICE_LIST_LIMITS.newDevices - 1))
      .map((item) => item.id),
    id(0x7000),
  ]);
  expect(value.newDevices.at(-1)?.label).toBe(
    face.repeat(DEVICE_LIST_LIMITS.label),
  );
  expect(DeviceListViewSchema.safeParse(value).success).toBe(true);
});

test("the view is a frozen copy that shares no object with the service's state", () => {
  const state = listState();
  const value = deviceListView(state, 7);

  expect(value.revision).toBe(7);
  expect(Object.isFrozen(value)).toBe(true);
  for (const list of [value.devices, value.newDevices]) {
    expect(Object.isFrozen(list)).toBe(true);
    for (const item of list) {
      expect(Object.isFrozen(item)).toBe(true);
    }
  }
  expect(value.devices).not.toBe(state.devices);
  expect(value.devices[0]).not.toBe(state.devices[0]);
  expect(value.newDevices).not.toBe(state.newDevices);
  expect(value.newDevices[0]).not.toBe(state.newDevices[0]);
});

test("every status crosses, and an unavailable list with its problem; not_found, which the device list never answers, crosses as failed", () => {
  // The record fails to compile when the service's statuses change.
  const statuses: Readonly<Record<DeviceListStatus, true>> = {
    signed_out: true,
    loading: true,
    ready: true,
    unavailable: true,
  };
  expect(Object.keys(statuses).sort()).toEqual(
    [...DEVICE_LIST_STATUSES].sort(),
  );
  for (const status of DEVICE_LIST_STATUSES) {
    const problem = status === "unavailable" ? { problem: "failed" } : {};
    const value = deviceListView(
      listState({ status, ...problem } as Partial<DeviceListState>),
      0,
    );
    expect(value.status).toBe(status);
  }
  for (const failure of WORKSPACE_READ_FAILURES) {
    const value = deviceListView(
      listState({ status: "unavailable", problem: failure }),
      0,
    );
    expect(value.status === "unavailable" && value.problem, failure).toBe(
      failure === "not_found" ? "failed" : failure,
    );
    expect(DeviceListViewSchema.safeParse(value).success).toBe(true);
  }
  expect([...DEVICE_LIST_PROBLEMS]).toEqual(
    WORKSPACE_READ_FAILURES.filter((failure) => failure !== "not_found"),
  );
});

test("the contract's limits and platforms follow the protocol and the service", () => {
  expect(DEVICE_LIST_LIMITS.devices).toBe(MAX_ANSWER_LIST_ITEMS);
  expect(DEVICE_LIST_LIMITS.label).toBe(LIMITS.deviceLabel);
  expect(DEVICE_LIST_LIMITS.newDevices).toBe(MAX_NEW_DEVICE_NOTICES);
  expect([...DEVICE_PLATFORMS]).toEqual([...PROTOCOL_DEVICE_PLATFORMS]);
});

test("the dismissal passes the shown device IDs on, up to the most notices that cross", () => {
  const fake = fakeService();
  const { call } = register(fake);
  const ids = Array.from({ length: DEVICE_LIST_LIMITS.newDevices }, (_, n) =>
    id(0x9000 + n),
  );
  expect(call(INVOKE_CHANNELS.dismissNewDevices, receiver(), ids)).toBe(true);
  expect(fake.calls).toEqual([`dismissNewDevices ${ids.join(",")}`]);
});

test("load and the dismissal go to the service and answer as it does", () => {
  const fake = fakeService();
  const { call } = register(fake);

  expect(call(INVOKE_CHANNELS.loadDeviceList)).toEqual({ outcome: "loading" });
  fake.answerLoad({ outcome: "refused", reason: "too_soon" });
  expect(call(INVOKE_CHANNELS.loadDeviceList)).toEqual({
    outcome: "refused",
    reason: "too_soon",
  });
  fake.answerLoad({ outcome: "refused", reason: "not_signed_in" });
  expect(call(INVOKE_CHANNELS.loadDeviceList)).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
  expect(
    call(INVOKE_CHANNELS.dismissNewDevices, receiver(), [NEW_DEVICE, DEVICE]),
  ).toBe(true);
  fake.answerDismiss(false);
  expect(
    call(INVOKE_CHANNELS.dismissNewDevices, receiver(), [NEW_DEVICE]),
  ).toBe(false);
  expect(fake.calls).toEqual([
    "load",
    "load",
    "load",
    `dismissNewDevices ${NEW_DEVICE},${DEVICE}`,
    `dismissNewDevices ${NEW_DEVICE}`,
  ]);
});

test("a burst of changes publishes once, after the interval, with the last state, to the subscribers only", () => {
  const fake = fakeService(SIGNED_OUT);
  const { subscribe, view } = register(fake);
  const caller = receiver();
  expect(view(caller).status).toBe("signed_out");
  const { first, payloads } = subscribe();
  expect(first.status).toBe("signed_out");
  expect(first.revision).toBe(0);

  fake.setState(listState({ status: "loading", devices: Object.freeze([]) }));
  expect(fake.timers).toHaveLength(1);
  const [timer] = fake.timers;
  expect(timer?.delayMs).toBe(DEVICE_PUBLISH_INTERVAL_MS);
  expect(DEVICE_PUBLISH_INTERVAL_MS).toBe(50);
  fake.setState(listState({ revision: 3 }));
  fake.setState(listState({ revision: 4, newDevices: Object.freeze([]) }));
  expect(payloads()).toEqual([]);
  expect(fake.timers).toEqual([timer]);
  // A call meanwhile already answers with the latest view.
  expect(view().revision).toBe(3);

  fake.fire();
  expect(payloads()).toHaveLength(1);
  expect(payloads()[0]).toMatchObject({
    status: "ready",
    revision: 3,
    newDevices: [],
  });

  // The next change waits for its own interval.
  fake.setState(listState({ status: "unavailable", problem: "rate_limited" }));
  expect(fake.waiting()).toHaveLength(1);
  fake.fire();
  expect(payloads().map((item) => item.revision)).toEqual([3, 4]);
  expect(payloads()[1]).toMatchObject({
    status: "unavailable",
    problem: "rate_limited",
  });
  expect(caller.sent).toEqual([]);
  expect(fake.errors).toEqual([]);
});

test("a view that the contract refuses is reported, not sent", () => {
  const fake = fakeService();
  const { subscribe } = register(fake);
  const { payloads } = subscribe();
  fake.setState(
    listState({
      devices: Object.freeze([
        { ...device(DEVICE), lastSeenAt: "yesterday" },
      ]) as unknown as readonly DeviceListItem[],
    }),
  );
  fake.fire();

  expect(payloads()).toEqual([]);
  expect(fake.errors).toEqual(["Sending the device list failed."]);

  // The next change is scheduled and sent again.
  fake.setState(listState());
  expect(fake.waiting()).toHaveLength(1);
  fake.fire();
  expect(payloads().map((item) => item.revision)).toEqual([2]);
  expect(fake.errors).toHaveLength(1);
});

test("close cancels the waiting publish and stops listening", () => {
  const fake = fakeService();
  const { subscribe, deviceIpc } = register(fake);
  const { payloads } = subscribe();
  fake.setState(listState({ revision: 2 }));
  const [timer] = fake.waiting();

  deviceIpc.close();
  expect(timer?.cancelled).toBe(true);
  expect(fake.listeners.size).toBe(0);
  timer?.callback();
  fake.fire();
  expect(payloads()).toEqual([]);
  deviceIpc.close();
});
