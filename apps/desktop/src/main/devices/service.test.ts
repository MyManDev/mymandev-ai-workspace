import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeviceListResponseSchema,
  decodeServerMessage,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import type {
  AccountStatus,
  ConnectionStatus,
} from "../../shared/ipc-contract.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { ServerMessage } from "../connection/client.ts";
import type { DeviceList } from "../session/session.ts";
import {
  RATE_LIMITED_RETRY_MS,
  WORKSPACE_RETRY_BASE_MS,
} from "../workspace/service.ts";
import {
  createDeviceListService,
  DEVICE_LIST_LOAD_COOLDOWN_MS,
  MAX_NEW_DEVICE_NOTICES,
  type DeviceListAccount,
  type DeviceListConnection,
  type DeviceListService,
  type DeviceListState,
} from "./service.ts";

const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000014";
const NEW_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000024";
const AT = "2026-11-09T09:00:00.000Z";
const LATER = "2026-11-09T10:00:00.000Z";
const LOCK_END = "2026-11-16T10:00:00.000Z";

/** Every label that the fixtures use, which no log may hold. */
const LABELS = ["Mac", "Work laptop", "Old laptop", "octocat"];

function accountStatus(
  overrides: Partial<AccountStatus> = {},
  deviceId: string = DEVICE_ID,
): AccountStatus {
  return Object.freeze({
    revision: 1,
    account: Object.freeze({
      kind: "signed_in",
      login: "octocat",
      displayName: "The Octocat",
      deviceId,
    }),
    signIn: Object.freeze({ kind: "idle" }),
    lastOutcome: null,
    deviceKey: "ready",
    replacementPending: false,
    apiOrigin: "set",
    device: "signed_in",
    ...overrides,
  }) as AccountStatus;
}

const SIGNED_OUT = accountStatus({
  account: Object.freeze({ kind: "hidden" }),
  device: "signed_out",
});

function item(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: id === DEVICE_ID ? "Mac" : "Old laptop",
    platform: id === DEVICE_ID ? "macos" : "windows",
    createdAt: AT,
    lastSeenAt: null,
    lastSignInAt: AT,
    signInExpiresAt: "2026-12-09T09:00:00.000Z",
    revokedAt: null,
    current: id === DEVICE_ID,
    ...overrides,
  };
}

/** The session's answer, parsed with the protocol's schema and frozen. */
function list(
  items: readonly Record<string, unknown>[],
  registrationLockedUntil: string | null = null,
): DeviceList {
  const parsed = DeviceListResponseSchema.parse({
    devices: items,
    registrationLockedUntil,
  });
  return Object.freeze({
    devices: Object.freeze(
      parsed.devices.map((device) => Object.freeze(device)),
    ),
    registrationLockedUntil: parsed.registrationLockedUntil,
  });
}

const OWN_LIST = list([item(DEVICE_ID)]);

function ok(value: DeviceList): WorkspaceReadResult<DeviceList> {
  return { ok: true, value };
}

function failure(reason: WorkspaceReadFailure): WorkspaceReadResult<never> {
  return { ok: false, reason };
}

/** A server frame, decoded as the connection client receives it. */
function frame(input: Record<string, unknown>): ServerMessage {
  const decoded = decodeServerMessage({ protocolVersion: 0, ...input });
  if (!decoded.ok || decoded.kind !== "frame") {
    throw new Error("The test frame does not decode");
  }
  return { kind: "frame", frame: decoded.frame };
}

function registered(
  id: string = NEW_DEVICE_ID,
  label = "Work laptop",
): ServerMessage {
  return frame({
    type: "account.device_registered",
    device: item(id, {
      label,
      platform: "linux",
      createdAt: LATER,
      current: false,
    }),
  });
}

function revoked(id: string): ServerMessage {
  return frame({
    type: "account.device_revoked",
    deviceId: id,
    reason: "lost",
    revokedAt: LATER,
  });
}

interface Timer {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

class Harness {
  accountStatus: AccountStatus;
  connectionStatus: ConnectionStatus;
  clock = 0;
  readonly accountListeners = new Set<(status: AccountStatus) => void>();
  readonly actionListeners = new Set<() => void>();
  readonly connectionListeners = new Set<(status: ConnectionStatus) => void>();
  readonly messageListeners = new Set<(message: ServerMessage) => void>();
  /** The reads that wait for an answer, the oldest first. */
  readonly reads: ((result: WorkspaceReadResult<DeviceList>) => void)[] = [];
  /** How many reads were sent. */
  sent = 0;
  readonly timers: Timer[] = [];
  readonly logs: string[] = [];
  readonly states: DeviceListState[] = [];
  readonly service: DeviceListService;

  constructor(
    status: AccountStatus = accountStatus(),
    connection: ConnectionStatus["state"] = "connected",
  ) {
    this.accountStatus = status;
    this.connectionStatus = {
      state: connection,
      revision: 0,
    } as ConnectionStatus;
    const account: DeviceListAccount = {
      status: () => this.accountStatus,
      onStatusChange: (listener) => {
        this.accountListeners.add(listener);
        return () => this.accountListeners.delete(listener);
      },
      onDeviceAction: (listener) => {
        this.actionListeners.add(listener);
        return () => this.actionListeners.delete(listener);
      },
      readDeviceList: () =>
        new Promise((resolve) => {
          this.sent += 1;
          this.reads.push(resolve);
        }),
    };
    const client: DeviceListConnection = {
      status: () => this.connectionStatus,
      onStatusChange: (listener) => {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
      },
      onMessage: (listener) => {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
      },
    };
    this.service = createDeviceListService({
      account,
      connection: client,
      now: () => this.clock,
      scheduleTimer: (callback, delayMs) => {
        const timer: Timer = { callback, delayMs, cancelled: false };
        this.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      log: (message) => this.logs.push(message),
    });
    this.service.onChange((state) => this.states.push(state));
  }

  setAccount(status: AccountStatus): void {
    this.accountStatus = status;
    for (const listener of [...this.accountListeners]) {
      listener(status);
    }
  }

  setConnection(state: ConnectionStatus["state"]): void {
    this.connectionStatus = {
      state,
      revision: this.connectionStatus.revision + 1,
    } as ConnectionStatus;
    for (const listener of [...this.connectionListeners]) {
      listener(this.connectionStatus);
    }
  }

  receive(message: ServerMessage): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  deviceAction(): void {
    for (const listener of [...this.actionListeners]) {
      listener();
    }
  }

  /** Answers the oldest read that waits, and lets its answer apply. */
  async answer(result: WorkspaceReadResult<DeviceList>): Promise<void> {
    const read = this.reads.shift();
    if (read === undefined) {
      throw new Error("No read waits.");
    }
    read(result);
    await settle();
  }

  openTimers(): Timer[] {
    return this.timers.filter((timer) => !timer.cancelled);
  }

  /** Fires the open timers once. */
  fire(): void {
    for (const timer of this.openTimers()) {
      timer.cancelled = true;
      timer.callback();
    }
  }

  /** The screen asks, and the read answers with `value`. */
  async loaded(value: DeviceList = OWN_LIST): Promise<void> {
    expect(this.service.load()).toEqual({ outcome: "loading" });
    await this.answer(ok(value));
    expect(this.service.state().status).toBe("ready");
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

test("nothing is read until the Account screen asks; then the state holds the devices and the lock end in the server's order, frozen", async () => {
  const h = new Harness();
  expect(h.service.state()).toEqual({
    revision: 0,
    status: "loading",
    devices: [],
    registrationLockedUntil: null,
    newDevices: [],
  });
  expect(h.sent).toBe(0);

  const answer = list(
    [
      item(NEW_DEVICE_ID, { createdAt: LATER }),
      item(DEVICE_ID),
      item(OTHER_DEVICE_ID, { revokedAt: LATER }),
    ],
    LOCK_END,
  );
  expect(h.service.load()).toEqual({ outcome: "loading" });
  expect(h.sent).toBe(1);
  await h.answer(ok(answer));

  const state = h.service.state();
  expect(state).toEqual({
    revision: 1,
    status: "ready",
    devices: answer.devices,
    registrationLockedUntil: LOCK_END,
    newDevices: [],
  });
  expect(state.devices.map((device) => device.id)).toEqual([
    NEW_DEVICE_ID,
    DEVICE_ID,
    OTHER_DEVICE_ID,
  ]);
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state.devices)).toBe(true);
  expect(Object.isFrozen(state.newDevices)).toBe(true);
  expect(h.states).toEqual([state]);
});

test("the screen's request is refused without a signed-in device and within the cooldown, and never reads then", async () => {
  for (const status of [
    SIGNED_OUT,
    accountStatus({ account: { kind: "signed_out" }, device: "no_device" }),
    accountStatus({ deviceKey: "passphrase_required" }),
    accountStatus({ apiOrigin: "unset" }),
    accountStatus({ device: "sign_in_required" }),
  ]) {
    const out = new Harness(status);
    expect(out.service.load(), status.device).toEqual({
      outcome: "refused",
      reason: "not_signed_in",
    });
    expect(out.service.state().status).toBe("signed_out");
    expect(out.sent).toBe(0);
  }

  const h = new Harness();
  await h.loaded();
  h.clock += DEVICE_LIST_LOAD_COOLDOWN_MS - 1;
  expect(h.service.load()).toEqual({ outcome: "refused", reason: "too_soon" });
  expect(h.sent).toBe(1);
  h.clock += 1;
  expect(h.service.load()).toEqual({ outcome: "loading" });
  expect(h.sent).toBe(2);
  expect(DEVICE_LIST_LOAD_COOLDOWN_MS).toBe(2_000);
});

test("once the screen asked, the list loads again after each account frame, a reconnect, a device action, and a new sign-in", async () => {
  const h = new Harness();
  await h.loaded();

  h.receive(registered());
  expect(h.sent).toBe(2);
  await h.answer(ok(OWN_LIST));
  h.receive(revoked(OTHER_DEVICE_ID));
  expect(h.sent).toBe(3);
  await h.answer(ok(OWN_LIST));

  h.setConnection("offline");
  expect(h.sent).toBe(3);
  h.setConnection("connected");
  expect(h.sent).toBe(4);
  await h.answer(ok(OWN_LIST));

  h.deviceAction();
  expect(h.sent).toBe(5);
  await h.answer(ok(OWN_LIST));

  // Other frames read nothing.
  h.receive(
    frame({
      type: "workspace.subscribed",
      workspaceId: "0192f0a0-7b3c-7d4e-8f50-0000000000a1",
      onlineMemberIds: [],
    }),
  );
  expect(h.sent).toBe(5);

  // A sign-out drops the list, and the next sign-in loads it again.
  h.setAccount(SIGNED_OUT);
  expect(h.service.state().status).toBe("signed_out");
  h.deviceAction();
  h.receive(registered());
  expect(h.sent).toBe(5);
  h.setAccount(accountStatus());
  expect(h.sent).toBe(6);
  expect(h.service.state().status).toBe("loading");
  await h.answer(ok(OWN_LIST));
  expect(h.service.state().status).toBe("ready");
});

test("before the screen asked, frames, a reconnect, and a device action read nothing, and the notice of a new device is kept", () => {
  const h = new Harness();
  h.receive(registered());
  h.receive(revoked(OTHER_DEVICE_ID));
  h.setConnection("offline");
  h.setConnection("connected");
  h.deviceAction();
  h.setAccount(SIGNED_OUT);
  h.setAccount(accountStatus());
  h.receive(registered());
  expect(h.sent).toBe(0);
  expect(h.service.state()).toMatchObject({
    status: "loading",
    newDevices: [
      {
        id: NEW_DEVICE_ID,
        label: "Work laptop",
        platform: "linux",
        createdAt: LATER,
      },
    ],
  });
});

test("a load asked for while one is on its way drops that answer and loads again", async () => {
  const h = new Harness();
  expect(h.service.load()).toEqual({ outcome: "loading" });
  h.receive(revoked(OTHER_DEVICE_ID));
  h.receive(revoked(OTHER_DEVICE_ID));
  // One read at a time.
  expect(h.sent).toBe(1);

  await h.answer(ok(list([item(DEVICE_ID), item(OTHER_DEVICE_ID)])));
  expect(h.service.state().status).toBe("loading");
  expect(h.service.state().devices).toEqual([]);
  expect(h.sent).toBe(2);

  const newer = list([
    item(DEVICE_ID),
    item(OTHER_DEVICE_ID, { revokedAt: LATER }),
  ]);
  await h.answer(ok(newer));
  expect(h.service.state()).toMatchObject({
    status: "ready",
    devices: newer.devices,
  });
  expect(h.sent).toBe(2);
});

test("a sign-out, another account, or another device drops the list, the lock, the notices, and the answers on their way", async () => {
  const changes: [string, AccountStatus][] = [
    ["sign-out", SIGNED_OUT],
    [
      "another account",
      accountStatus({
        account: {
          kind: "signed_in",
          login: "hubot",
          displayName: "Hubot",
          deviceId: OTHER_DEVICE_ID,
        },
      }),
    ],
    ["another device", accountStatus({}, OTHER_DEVICE_ID)],
    ["a revoked device", accountStatus({ device: "revoked" })],
    ["a removal", accountStatus({ device: "removal_pending" })],
  ];
  for (const [name, next] of changes) {
    const h = new Harness();
    await h.loaded(list([item(DEVICE_ID)], LOCK_END));
    h.receive(registered());
    expect(h.sent, name).toBe(2);

    h.setAccount(next);
    const dropped = h.service.state();
    expect(dropped.devices, name).toEqual([]);
    expect(dropped.registrationLockedUntil, name).toBeNull();
    expect(dropped.newDevices, name).toEqual([]);

    // The answer that was on its way for the earlier device never applies.
    const before = h.states.length;
    await h.answer(ok(list([item(DEVICE_ID)], LOCK_END)));
    expect(h.service.state().devices, name).toEqual([]);
    expect(h.service.state().registrationLockedUntil, name).toBeNull();
    if (next.device === "signed_in") {
      // The next device's own list loads, because the screen asked before.
      expect(h.service.state().status, name).toBe("loading");
      expect(h.reads, name).toHaveLength(1);
    } else {
      expect(h.service.state().status, name).toBe("signed_out");
      expect(h.states.length, name).toBe(before);
    }
  }
});

test("while a sign-in runs, a load waits for its end, also when the status already shows the device signed in", async () => {
  const h = new Harness(SIGNED_OUT);
  h.setAccount(accountStatus());
  await h.loaded();
  h.setAccount(SIGNED_OUT);

  // A repeated sign-in shows the device signed in before the sign-in ends.
  h.setAccount(accountStatus({ signIn: { kind: "completing" } }));
  expect(h.service.state().status).toBe("loading");
  expect(h.sent).toBe(1);
  h.receive(registered());
  h.deviceAction();
  expect(h.sent).toBe(1);

  h.setAccount(accountStatus());
  expect(h.sent).toBe(2);
  await h.answer(ok(OWN_LIST));
  expect(h.service.state().status).toBe("ready");

  // The screen's request during a sign-in is accepted, and loads after it.
  h.clock += DEVICE_LIST_LOAD_COOLDOWN_MS;
  h.setAccount(accountStatus({ signIn: { kind: "starting" } }));
  expect(h.service.load()).toEqual({ outcome: "loading" });
  expect(h.sent).toBe(2);
  h.setAccount(accountStatus());
  expect(h.sent).toBe(3);

  // A load that a trigger overtook, answered while a sign-in runs, loads
  // again only after the sign-in.
  h.receive(revoked(OTHER_DEVICE_ID));
  h.setAccount(accountStatus({ signIn: { kind: "starting" } }));
  await h.answer(ok(OWN_LIST));
  expect(h.sent).toBe(3);
  h.setAccount(accountStatus());
  expect(h.sent).toBe(4);
});

test("a failed load keeps what was loaded, shows its problem, and is retried with the backoff while connected; offline, the next connection loads", async () => {
  const h = new Harness();
  await h.loaded(list([item(DEVICE_ID)], LOCK_END));

  h.deviceAction();
  await h.answer(failure("unavailable"));
  expect(h.service.state()).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
    devices: [{ id: DEVICE_ID }],
    registrationLockedUntil: LOCK_END,
  });
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([
    WORKSPACE_RETRY_BASE_MS,
  ]);
  h.fire();
  expect(h.sent).toBe(3);
  await h.answer(failure("failed"));
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([
    2 * WORKSPACE_RETRY_BASE_MS,
  ]);
  h.fire();
  await h.answer(failure("rate_limited"));
  expect(h.service.state()).toMatchObject({
    status: "unavailable",
    problem: "rate_limited",
  });
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([
    RATE_LIMITED_RETRY_MS,
  ]);

  // A lost connection cancels the retry; the next connection loads.
  h.setConnection("offline");
  expect(h.openTimers()).toEqual([]);
  h.deviceAction();
  expect(h.sent).toBe(5);
  await h.answer(failure("unavailable"));
  expect(h.openTimers()).toEqual([]);
  h.setConnection("connected");
  expect(h.sent).toBe(6);
  await h.answer(ok(OWN_LIST));
  expect(h.service.state()).toEqual({
    revision: expect.any(Number),
    status: "ready",
    devices: OWN_LIST.devices,
    registrationLockedUntil: null,
    newDevices: [],
  });
  // A success starts the backoff again.
  h.deviceAction();
  await h.answer(failure("unavailable"));
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([
    WORKSPACE_RETRY_BASE_MS,
  ]);
  expect(h.logs).toContain("The device list did not load (unavailable).");
});

test("a read that rejects counts as unavailable", async () => {
  const service = createDeviceListService({
    account: {
      status: () => accountStatus(),
      onStatusChange: () => () => undefined,
      onDeviceAction: () => () => undefined,
      readDeviceList: () => Promise.reject(new Error("broken")),
    },
    connection: {
      status: () => ({ state: "offline", revision: 0 }),
      onStatusChange: () => () => undefined,
      onMessage: () => () => undefined,
    },
    scheduleTimer: () => () => undefined,
  });
  expect(service.load()).toEqual({ outcome: "loading" });
  await settle();
  expect(service.state()).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
  });
  service.close();
});

test("a notice of a new device comes from the frame, never for this device, keeps the 10 newest, and ends when dismissed, revoked, or dropped, not with a reload", async () => {
  const h = new Harness();
  await h.loaded();

  h.receive(registered());
  expect(h.service.state().newDevices).toEqual([
    {
      id: NEW_DEVICE_ID,
      label: "Work laptop",
      platform: "linux",
      createdAt: LATER,
    },
  ]);
  // The reload that the frame starts, the screen's next request, and a
  // reconnect keep it.
  await h.answer(
    ok(list([item(NEW_DEVICE_ID, { createdAt: LATER }), item(DEVICE_ID)])),
  );
  h.clock += DEVICE_LIST_LOAD_COOLDOWN_MS;
  h.service.load();
  await h.answer(
    ok(list([item(NEW_DEVICE_ID, { createdAt: LATER }), item(DEVICE_ID)])),
  );
  h.setConnection("offline");
  h.setConnection("connected");
  await h.answer(ok(OWN_LIST));
  expect(h.service.state().newDevices).toHaveLength(1);

  // A frame that names this device makes no notice; the same device again
  // replaces its notice.
  h.receive(registered(DEVICE_ID));
  h.receive(registered(NEW_DEVICE_ID, "Renamed laptop"));
  await h.answer(ok(OWN_LIST));
  expect(h.service.state().newDevices).toEqual([
    {
      id: NEW_DEVICE_ID,
      label: "Renamed laptop",
      platform: "linux",
      createdAt: LATER,
    },
  ]);

  // Dismissed.
  expect(h.service.dismissNewDevices()).toBe(true);
  expect(h.service.state().newDevices).toEqual([]);
  expect(h.service.dismissNewDevices()).toBe(false);

  // The 10 newest stay.
  const ids = Array.from(
    { length: MAX_NEW_DEVICE_NOTICES + 2 },
    (_, index) =>
      `0192f0a0-7b3c-7d4e-8f50-0000000001${index.toString(16).padStart(2, "0")}`,
  );
  for (const id of ids) {
    h.receive(registered(id));
  }
  expect(h.service.state().newDevices.map((notice) => notice.id)).toEqual(
    ids.slice(2),
  );
  expect(MAX_NEW_DEVICE_NOTICES).toBe(10);

  // The revocation frame of a device ends its notice at once, and a list
  // that shows a device revoked ends its notice too.
  h.receive(revoked(ids[2] as string));
  expect(h.service.state().newDevices.map((notice) => notice.id)).toEqual(
    ids.slice(3),
  );
  // The read on its way was sent before these frames: its answer is
  // dropped, and the list loads again.
  expect(h.reads).toHaveLength(1);
  await h.answer(ok(OWN_LIST));
  expect(h.service.state().newDevices).toHaveLength(9);
  await h.answer(
    ok(
      list([
        item(ids[3] as string, { revokedAt: LATER }),
        item(ids[4] as string),
        item(DEVICE_ID),
      ]),
    ),
  );
  expect(h.service.state().newDevices.map((notice) => notice.id)).toEqual(
    ids.slice(4),
  );

  // A sign-out drops them.
  h.setAccount(SIGNED_OUT);
  expect(h.service.state().newDevices).toEqual([]);
  expect(h.service.dismissNewDevices()).toBe(false);
});

test("close stops listening and cancels the retry, and later calls change nothing", async () => {
  const h = new Harness();
  await h.loaded();
  h.deviceAction();
  await h.answer(failure("unavailable"));
  expect(h.openTimers()).toHaveLength(1);
  const before = h.states.length;

  h.service.close();
  h.service.close();
  expect(h.openTimers()).toEqual([]);
  expect(h.accountListeners.size).toBe(0);
  expect(h.actionListeners.size).toBe(0);
  expect(h.connectionListeners.size).toBe(0);
  expect(h.messageListeners.size).toBe(0);
  expect(h.service.load()).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
  expect(h.service.dismissNewDevices()).toBe(false);
  expect(h.states).toHaveLength(before);
});

test("a listener that throws is logged and the others still hear the state; no log holds a label or an ID, and the file does not log with console", async () => {
  const h = new Harness();
  const heard: string[] = [];
  h.service.onChange(() => {
    throw new Error("broken");
  });
  const stop = h.service.onChange((state) => heard.push(state.status));
  await h.loaded(list([item(DEVICE_ID)], LOCK_END));
  h.receive(registered());
  await h.answer(failure("failed"));
  stop();
  h.service.dismissNewDevices();

  expect(heard).toEqual(["ready", "ready", "unavailable"]);
  expect(h.logs).toContain("A device list state listener failed.");
  const logged = h.logs.join("\n");
  for (const value of [...LABELS, DEVICE_ID, NEW_DEVICE_ID, LOCK_END]) {
    expect(logged).not.toContain(value);
  }
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "service.ts"),
    "utf8",
  );
  expect(source).not.toMatch(/console\./);
});
