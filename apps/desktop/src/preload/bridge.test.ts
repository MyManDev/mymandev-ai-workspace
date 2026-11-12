import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type {
  AccountStatus,
  RepositoryList,
  RuntimeStatus,
} from "../shared/ipc-contract.ts";
import { createDesktopBridge, type BridgeIpc } from "./bridge.ts";

type Listener = (event: unknown, ...args: unknown[]) => void;

/** An ipcRenderer whose invoke answers the test settles. */
function fakeIpc() {
  const invoked: { channel: string; args: unknown[] }[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const answers: {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const ipc: BridgeIpc = {
    invoke: (channel, ...args) => {
      invoked.push({ channel, args });
      return new Promise((resolve, reject) => {
        answers.push({ resolve, reject });
      });
    },
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener);
    },
  };
  return {
    ipc,
    invoked,
    answers,
    listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
    emit(channel: string, ...args: unknown[]) {
      const event = { sender: "ipcRenderer", ports: [] };
      for (const listener of listeners.get(channel) ?? []) {
        listener(event, ...args);
      }
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

const status = (state: RuntimeStatus["state"], revision: number) => ({
  state,
  revision,
});

test("the bridge holds the Electron version, the runtime, the repository, the account, the connection, the workspace, the people, the people action, the invitation, the invitation action, the agent, the chat, and the device list functions only, frozen", () => {
  const bridge = createDesktopBridge("44.9.1", fakeIpc().ipc);

  expect(Object.keys(bridge).sort()).toEqual([
    "account",
    "agents",
    "chat",
    "connection",
    "devices",
    "electronVersion",
    "invitationActions",
    "invitations",
    "people",
    "peopleActions",
    "repositories",
    "runtime",
    "workspaces",
  ]);
  expect(Object.keys(bridge.runtime).sort()).toEqual([
    "getStatus",
    "subscribeStatus",
  ]);
  expect(Object.keys(bridge.repositories).sort()).toEqual([
    "list",
    "mount",
    "subscribe",
    "unmount",
  ]);
  expect(Object.keys(bridge.account).sort()).toEqual([
    "cancelSignIn",
    "forgetAccount",
    "getStatus",
    "removeDevice",
    "signOut",
    "startSignIn",
    "subscribeStatus",
    "unlockDeviceKey",
  ]);
  expect(Object.keys(bridge.connection).sort()).toEqual([
    "getStatus",
    "reconnect",
    "subscribeStatus",
  ]);
  expect(Object.keys(bridge.workspaces).sort()).toEqual([
    "create",
    "createProject",
    "getState",
    "openProject",
    "select",
    "subscribeState",
  ]);
  expect(Object.keys(bridge.people).sort()).toEqual([
    "getState",
    "subscribeState",
  ]);
  expect(Object.keys(bridge.peopleActions).sort()).toEqual([
    "acceptOwnershipOffer",
    "define",
    "demote",
    "leave",
    "offerOwnership",
    "promote",
    "remove",
    "rename",
    "withdrawOwnershipOffer",
  ]);
  expect(Object.keys(bridge.invitations).sort()).toEqual([
    "getState",
    "load",
    "subscribeState",
  ]);
  expect(Object.keys(bridge.invitationActions).sort()).toEqual([
    "accept",
    "create",
    "preview",
    "revoke",
  ]);
  expect(Object.keys(bridge.agents).sort()).toEqual([
    "getState",
    "subscribeState",
  ]);
  expect(Object.keys(bridge.chat).sort()).toEqual([
    "discard",
    "getState",
    "loadOlder",
    "retry",
    "send",
    "subscribeState",
  ]);
  expect(Object.keys(bridge.devices).sort()).toEqual([
    "dismissLostDeviceAdvice",
    "dismissNewDevices",
    "getState",
    "liftRegistrationLock",
    "load",
    "revokeDevice",
    "subscribeState",
  ]);
  expect(bridge.electronVersion).toBe("44.9.1");
  expect(Object.isFrozen(bridge)).toBe(true);
  expect(Object.isFrozen(bridge.runtime)).toBe(true);
  expect(Object.isFrozen(bridge.repositories)).toBe(true);
  expect(Object.isFrozen(bridge.account)).toBe(true);
  expect(Object.isFrozen(bridge.connection)).toBe(true);
  expect(Object.isFrozen(bridge.workspaces)).toBe(true);
  expect(Object.isFrozen(bridge.people)).toBe(true);
  expect(Object.isFrozen(bridge.peopleActions)).toBe(true);
  expect(Object.isFrozen(bridge.invitations)).toBe(true);
  expect(Object.isFrozen(bridge.invitationActions)).toBe(true);
  expect(Object.isFrozen(bridge.agents)).toBe(true);
  expect(Object.isFrozen(bridge.chat)).toBe(true);
  expect(Object.isFrozen(bridge.devices)).toBe(true);
  for (const value of [
    ...Object.values(bridge.runtime),
    ...Object.values(bridge.repositories),
    ...Object.values(bridge.account),
    ...Object.values(bridge.connection),
    ...Object.values(bridge.workspaces),
    ...Object.values(bridge.people),
    ...Object.values(bridge.peopleActions),
    ...Object.values(bridge.invitations),
    ...Object.values(bridge.invitationActions),
    ...Object.values(bridge.agents),
    ...Object.values(bridge.chat),
    ...Object.values(bridge.devices),
  ]) {
    expect(typeof value).toBe("function");
  }
});

test("no part of the bridge is the ipc object or a generic invoke", () => {
  const { ipc } = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", ipc);
  const values = [
    ...Object.values(bridge),
    ...Object.values(bridge.runtime),
    ...Object.values(bridge.repositories),
    ...Object.values(bridge.account),
    ...Object.values(bridge.connection),
    ...Object.values(bridge.workspaces),
    ...Object.values(bridge.people),
    ...Object.values(bridge.peopleActions),
    ...Object.values(bridge.invitations),
    ...Object.values(bridge.invitationActions),
    ...Object.values(bridge.agents),
    ...Object.values(bridge.chat),
    ...Object.values(bridge.devices),
  ] as unknown[];

  expect(values).not.toContain(ipc);
  expect(values).not.toContain(ipc.invoke);
  expect(values).not.toContain(ipc.on);
  expect(values).not.toContain(ipc.removeListener);
});

test("getStatus calls its channel and passes no argument from the renderer on", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);

  const answer = (
    bridge.runtime.getStatus as (...args: unknown[]) => Promise<RuntimeStatus>
  )("runtime:other", { evil: true });
  fake.answers[0]?.resolve(status("running", 2));

  await expect(answer).resolves.toEqual(status("running", 2));
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.getRuntimeStatus, args: [] },
  ]);
});

test("subscribeStatus delivers the current status and every later one, without the event object", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);
  const calls: unknown[][] = [];

  bridge.runtime.subscribeStatus((...args: unknown[]) => calls.push(args));
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.subscribeRuntimeStatus, args: [] },
  ]);
  fake.answers[0]?.resolve(status("starting", 1));
  await settle();
  fake.emit(EVENT_CHANNELS.runtimeStatusChanged, status("running", 2));

  expect(calls).toEqual([[status("starting", 1)], [status("running", 2)]]);
});

test("subscribeStatus drops a status older than the last one delivered", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);
  const seen: RuntimeStatus[] = [];

  bridge.runtime.subscribeStatus((next) => seen.push(next));
  // The event arrives before the answer to the subscription.
  fake.emit(EVENT_CHANNELS.runtimeStatusChanged, status("running", 2));
  fake.answers[0]?.resolve(status("starting", 1));
  await settle();
  fake.emit(EVENT_CHANNELS.runtimeStatusChanged, status("running", 2));

  expect(seen).toEqual([status("running", 2)]);
});

test("ending a subscription removes its listener and drops a late answer", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);
  const seen: RuntimeStatus[] = [];

  const end = bridge.runtime.subscribeStatus((next) => seen.push(next));
  expect(fake.listenerCount(EVENT_CHANNELS.runtimeStatusChanged)).toBe(1);
  end();
  fake.answers[0]?.resolve(status("running", 2));
  await settle();
  fake.emit(EVENT_CHANNELS.runtimeStatusChanged, status("stopping", 3));

  expect(fake.listenerCount(EVENT_CHANNELS.runtimeStatusChanged)).toBe(0);
  expect(seen).toEqual([]);
});

test("a refused subscription calls onError", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);
  let errors = 0;

  bridge.runtime.subscribeStatus(
    () => undefined,
    () => {
      errors += 1;
    },
  );
  fake.answers[0]?.reject(new Error("refused"));
  await settle();

  expect(errors).toBe(1);
});

test("subscribeStatus refuses a listener that is not a function", () => {
  const fake = fakeIpc();
  const subscribe = createDesktopBridge("44.9.1", fake.ipc).runtime
    .subscribeStatus as (...args: unknown[]) => () => void;

  expect(() => subscribe("runtime:get-status")).toThrow(TypeError);
  expect(() => subscribe(() => undefined, "not a function")).toThrow(TypeError);
  expect(fake.invoked).toEqual([]);
  expect(fake.listenerCount(EVENT_CHANNELS.runtimeStatusChanged)).toBe(0);
});

test("a listener that throws is reported, in the answer and in later events", async () => {
  const fake = fakeIpc();
  const reported: string[] = [];
  const bridge = createDesktopBridge("44.9.1", fake.ipc, (message) =>
    reported.push(message),
  );
  const seen: number[] = [];

  bridge.runtime.subscribeStatus((next) => {
    seen.push(next.revision);
    throw new Error("listener");
  });
  fake.answers[0]?.resolve(status("starting", 1));
  await settle();
  expect(() =>
    fake.emit(EVENT_CHANNELS.runtimeStatusChanged, status("running", 2)),
  ).not.toThrow();

  expect(seen).toEqual([1, 2]);
  expect(reported).toEqual([
    "A runtime status callback failed.",
    "A runtime status callback failed.",
  ]);
});

test("an onError callback that throws is reported", async () => {
  const fake = fakeIpc();
  const reported: unknown[] = [];
  const bridge = createDesktopBridge("44.9.1", fake.ipc, (_message, error) =>
    reported.push(error),
  );

  bridge.runtime.subscribeStatus(
    () => undefined,
    () => {
      throw new Error("onError");
    },
  );
  fake.answers[0]?.reject(new Error("refused"));
  await settle();

  expect(reported).toHaveLength(1);
  expect((reported[0] as Error).message).toBe("onError");
});

const MOUNT_ID = "0b9e2f7c-5d0a-4c8e-9f3b-2a1d6e4c8b70";

const repositoryList = (revision: number): RepositoryList => ({
  revision,
  repositories: [],
});

test("list and mount call their channels and pass no argument from the renderer on", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);

  const listed = (
    bridge.repositories.list as (...args: unknown[]) => Promise<unknown>
  )("/etc", { path: "/" });
  const mounted = (
    bridge.repositories.mount as (...args: unknown[]) => Promise<unknown>
  )("/home/user/project");
  fake.answers[0]?.resolve(repositoryList(1));
  fake.answers[1]?.resolve({ outcome: "cancelled" });

  await expect(listed).resolves.toEqual(repositoryList(1));
  await expect(mounted).resolves.toEqual({ outcome: "cancelled" });
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.listRepositories, args: [] },
    { channel: INVOKE_CHANNELS.mountRepository, args: [] },
  ]);
});

test("unmount passes only the mount ID string on", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);
  const unmount = bridge.repositories.unmount as (
    ...args: unknown[]
  ) => Promise<boolean>;

  const answer = unmount(MOUNT_ID, "extra", { evil: true });
  fake.answers[0]?.resolve(true);

  await expect(answer).resolves.toBe(true);
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.unmountRepository, args: [MOUNT_ID] },
  ]);
});

test("unmount refuses a mount ID that is not a string without calling the main process", async () => {
  const fake = fakeIpc();
  const unmount = createDesktopBridge("44.9.1", fake.ipc).repositories
    .unmount as (...args: unknown[]) => Promise<boolean>;

  for (const value of [undefined, 1, { mountId: MOUNT_ID }, [MOUNT_ID]]) {
    await expect(unmount(value)).rejects.toThrow(TypeError);
  }
  expect(fake.invoked).toEqual([]);
});

test("subscribe delivers the list and every newer one, without the event object", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);
  const calls: unknown[][] = [];

  const end = bridge.repositories.subscribe((...args: unknown[]) =>
    calls.push(args),
  );
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.subscribeRepositories, args: [] },
  ]);
  // A change arrives before the answer; the older answer is dropped.
  fake.emit(EVENT_CHANNELS.repositoriesChanged, repositoryList(3));
  fake.answers[0]?.resolve(repositoryList(2));
  await settle();
  fake.emit(EVENT_CHANNELS.repositoriesChanged, repositoryList(4));
  end();
  fake.emit(EVENT_CHANNELS.repositoriesChanged, repositoryList(5));

  expect(calls).toEqual([[repositoryList(3)], [repositoryList(4)]]);
  expect(fake.listenerCount(EVENT_CHANNELS.repositoriesChanged)).toBe(0);
});

test("a refused repository subscription calls onError, and a throwing listener is reported", async () => {
  const fake = fakeIpc();
  const reported: string[] = [];
  const bridge = createDesktopBridge("44.9.1", fake.ipc, (message) =>
    reported.push(message),
  );
  let errors = 0;

  bridge.repositories.subscribe(
    () => {
      throw new Error("listener");
    },
    () => {
      errors += 1;
    },
  );
  fake.emit(EVENT_CHANNELS.repositoriesChanged, repositoryList(1));
  fake.answers[0]?.reject(new Error("refused"));
  await settle();

  expect(errors).toBe(1);
  expect(reported).toEqual(["A repository list callback failed."]);
});

const accountStatus = (revision: number): AccountStatus => ({
  revision,
  account: { kind: "signed_out" },
  signIn: { kind: "idle" },
  lastOutcome: null,
  deviceKey: "ready",
  replacementPending: false,
  apiOrigin: "set",
  device: "no_device",
});

test("the account functions call their channels and pass no argument from the renderer on", async () => {
  const fake = fakeIpc();
  const account = createDesktopBridge("44.9.1", fake.ipc)
    .account as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;

  const answers = [
    account["getStatus"]?.("account:forget"),
    account["startSignIn"]?.({ login: "octocat" }, "https://evil.example"),
    account["cancelSignIn"]?.(true),
    account["forgetAccount"]?.({ confirmed: false }),
    account["signOut"]?.({ keepKey: false }),
    account["removeDevice"]?.({ confirmed: true }, "0192f2a0"),
  ];
  fake.answers[0]?.resolve(accountStatus(1));
  fake.answers[1]?.resolve({ outcome: "started" });
  fake.answers[2]?.resolve(true);
  fake.answers[3]?.resolve({ outcome: "forgotten", removedAtServer: true });
  fake.answers[4]?.resolve({ outcome: "pending" });
  fake.answers[5]?.resolve({ outcome: "cancelled" });

  await expect(Promise.all(answers)).resolves.toEqual([
    accountStatus(1),
    { outcome: "started" },
    true,
    { outcome: "forgotten", removedAtServer: true },
    { outcome: "pending" },
    { outcome: "cancelled" },
  ]);
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.getAccountStatus, args: [] },
    { channel: INVOKE_CHANNELS.startSignIn, args: [] },
    { channel: INVOKE_CHANNELS.cancelSignIn, args: [] },
    { channel: INVOKE_CHANNELS.forgetAccount, args: [] },
    { channel: INVOKE_CHANNELS.signOut, args: [] },
    { channel: INVOKE_CHANNELS.removeDevice, args: [] },
  ]);
});

/** A device list state with the revision `revision`. */
function deviceList(revision: number) {
  return {
    status: "ready",
    revision,
    devices: [],
    registrationLockedUntil: null,
    newDevices: [],
    lostDeviceAdvice: false,
  };
}

test("the device list functions call their channels and pass no argument from the renderer on, except a copy of the dismissed device IDs", async () => {
  const fake = fakeIpc();
  const devices = createDesktopBridge("44.9.1", fake.ipc)
    .devices as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const shown = ["0192f2a0", "0192f2a1"];

  const answers = [
    devices["getState"]?.("devices:dismiss-new-devices"),
    devices["load"]?.({ force: true }, "0192f2a0"),
    devices["dismissNewDevices"]?.(shown, "extra"),
  ];
  fake.answers[0]?.resolve(deviceList(1));
  fake.answers[1]?.resolve({ outcome: "loading" });
  fake.answers[2]?.resolve(true);

  await expect(Promise.all(answers)).resolves.toEqual([
    deviceList(1),
    { outcome: "loading" },
    true,
  ]);
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.getDeviceList, args: [] },
    { channel: INVOKE_CHANNELS.loadDeviceList, args: [] },
    { channel: INVOKE_CHANNELS.dismissNewDevices, args: [shown] },
  ]);
  // A new array goes on, not the renderer's own.
  expect(fake.invoked[2]?.args[0]).not.toBe(shown);
});

test("dismissNewDevices refuses a value that is not an array of strings without calling the main process or naming it", async () => {
  const fake = fakeIpc();
  const dismiss = createDesktopBridge("44.9.1", fake.ipc).devices
    .dismissNewDevices as (...args: unknown[]) => Promise<unknown>;

  for (const value of [
    "0192f2a0",
    undefined,
    null,
    [1],
    ["0192f2a0", { id: "0192f2a0" }],
    { 0: "0192f2a0", length: 1 },
  ]) {
    await expect(dismiss(value)).rejects.toThrow(
      "dismissNewDevices needs an array of ID strings.",
    );
  }
  expect(fake.invoked).toEqual([]);
});

test("revokeDevice passes on only the device ID string and its own reason, and liftRegistrationLock and dismissLostDeviceAdvice nothing", async () => {
  const fake = fakeIpc();
  const devices = createDesktopBridge("44.9.1", fake.ipc)
    .devices as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const deviceId = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b4";

  const answers = [
    devices["revokeDevice"]?.(deviceId, "removed", { force: true }),
    devices["revokeDevice"]?.(deviceId, "lost"),
    devices["liftRegistrationLock"]?.("devices:revoke", deviceId),
    devices["dismissLostDeviceAdvice"]?.("devices:dismiss-new-devices", [
      deviceId,
    ]),
  ];
  fake.answers[0]?.resolve({ outcome: "revoked", reason: "removed" });
  fake.answers[1]?.resolve({ outcome: "unknown" });
  fake.answers[2]?.resolve({ outcome: "lifted" });
  fake.answers[3]?.resolve(true);

  await expect(Promise.all(answers)).resolves.toEqual([
    { outcome: "revoked", reason: "removed" },
    { outcome: "unknown" },
    { outcome: "lifted" },
    true,
  ]);
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.revokeDevice, args: [deviceId, "removed"] },
    { channel: INVOKE_CHANNELS.revokeDevice, args: [deviceId, "lost"] },
    { channel: INVOKE_CHANNELS.liftRegistrationLock, args: [] },
    { channel: INVOKE_CHANNELS.dismissLostDeviceAdvice, args: [] },
  ]);
});

test("revokeDevice refuses an ID that is not a string or another reason without calling the main process or naming the value", async () => {
  const fake = fakeIpc();
  const revoke = createDesktopBridge("44.9.1", fake.ipc).devices
    .revokeDevice as (...args: unknown[]) => Promise<unknown>;
  const deviceId = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b4";

  for (const args of [
    [],
    [deviceId],
    [deviceId, "replaced"],
    [deviceId, "LOST"],
    [deviceId, { toString: () => "lost" }],
    [[deviceId], "lost"],
    [{ id: deviceId }, "removed"],
    [undefined, "removed"],
  ]) {
    await expect(revoke(...args)).rejects.toThrow(
      "revokeDevice needs a device ID string and a revocation reason.",
    );
  }
  expect(fake.invoked).toEqual([]);
});

test("startSignIn passes on only its own fixed option, and only when the renderer asks for another browser", async () => {
  const fake = fakeIpc();
  const start = createDesktopBridge("44.9.1", fake.ipc).account.startSignIn as (
    ...args: unknown[]
  ) => Promise<unknown>;

  const asked = { browser: "other", login: "octocat" };
  const answers = [
    start({ browser: "other" }),
    start(asked, "https://evil.example"),
    start({ browser: "default" }),
    start({ browser: "chrome" }),
    start("other"),
    start(null),
  ];
  for (const answer of fake.answers) {
    answer.resolve({ outcome: "started" });
  }
  await expect(Promise.all(answers)).resolves.toHaveLength(6);

  const other = {
    channel: INVOKE_CHANNELS.startSignIn,
    args: [{ browser: "other" }],
  };
  const plain = { channel: INVOKE_CHANNELS.startSignIn, args: [] };
  expect(fake.invoked).toEqual([other, other, plain, plain, plain, plain]);
  // The option sent is the bridge's own object, never the renderer's.
  expect(fake.invoked[1]?.args[0]).not.toBe(asked);
});

test("unlockDeviceKey passes only the passphrase string on", async () => {
  const fake = fakeIpc();
  const unlock = createDesktopBridge("44.9.1", fake.ipc).account
    .unlockDeviceKey as (...args: unknown[]) => Promise<unknown>;

  const answer = unlock("correct horse", "extra", { evil: true });
  fake.answers[0]?.resolve({ outcome: "unlocked" });

  await expect(answer).resolves.toEqual({ outcome: "unlocked" });
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.unlockDeviceKey, args: ["correct horse"] },
  ]);
});

test("unlockDeviceKey refuses a passphrase that is not a string without calling the main process or naming it", async () => {
  const fake = fakeIpc();
  const unlock = createDesktopBridge("44.9.1", fake.ipc).account
    .unlockDeviceKey as (...args: unknown[]) => Promise<unknown>;

  for (const value of [undefined, 1, { passphrase: "secret" }, ["secret"]]) {
    const error = await unlock(value).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain("secret");
  }
  expect(fake.invoked).toEqual([]);
});

test("the account subscription delivers the status and every newer one, without the event object", async () => {
  const fake = fakeIpc();
  const reported: string[] = [];
  const bridge = createDesktopBridge("44.9.1", fake.ipc, (message) =>
    reported.push(message),
  );
  const calls: unknown[][] = [];
  let errors = 0;

  const end = bridge.account.subscribeStatus(
    (...args: unknown[]) => calls.push(args),
    () => {
      errors += 1;
    },
  );
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.subscribeAccountStatus, args: [] },
  ]);
  fake.emit(EVENT_CHANNELS.accountStatusChanged, accountStatus(3));
  fake.answers[0]?.resolve(accountStatus(2));
  await settle();
  fake.emit(EVENT_CHANNELS.accountStatusChanged, accountStatus(4));
  end();
  fake.emit(EVENT_CHANNELS.accountStatusChanged, accountStatus(5));

  expect(calls).toEqual([[accountStatus(3)], [accountStatus(4)]]);
  expect(fake.listenerCount(EVENT_CHANNELS.accountStatusChanged)).toBe(0);
  expect(errors).toBe(0);

  bridge.account.subscribeStatus(
    () => {
      throw new Error("listener");
    },
    () => {
      errors += 1;
    },
  );
  fake.emit(EVENT_CHANNELS.accountStatusChanged, accountStatus(1));
  fake.answers[1]?.reject(new Error("refused"));
  await settle();

  expect(errors).toBe(1);
  expect(reported).toEqual(["An account status callback failed."]);
});

test("the connection functions call their channels and pass no argument from the renderer on", async () => {
  const fake = fakeIpc();
  const connection = createDesktopBridge("44.9.1", fake.ipc)
    .connection as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const offline = { state: "offline", revision: 1 };

  const answers = [
    connection["getStatus"]?.("connection:reconnect"),
    connection["reconnect"]?.({ here: true }, "wss://evil.example"),
  ];
  fake.answers[0]?.resolve(offline);
  fake.answers[1]?.resolve({ outcome: "reconnecting" });

  await expect(Promise.all(answers)).resolves.toEqual([
    offline,
    { outcome: "reconnecting" },
  ]);
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.getConnectionStatus, args: [] },
    { channel: INVOKE_CHANNELS.reconnect, args: [] },
  ]);
});

test("the connection subscription delivers the status and every newer one, without the event object", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);
  const calls: unknown[][] = [];
  const reported: string[] = [];
  bridge.connection.subscribeStatus((...args) => calls.push(args));

  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.subscribeConnectionStatus, args: [] },
  ]);
  fake.answers[0]?.resolve({ state: "connecting", revision: 3 });
  await settle();
  fake.emit(EVENT_CHANNELS.connectionStatusChanged, {
    state: "connected",
    revision: 4,
  });
  fake.emit(EVENT_CHANNELS.connectionStatusChanged, {
    state: "connecting",
    revision: 2,
  });
  expect(calls).toEqual([
    [{ state: "connecting", revision: 3 }],
    [{ state: "connected", revision: 4 }],
  ]);

  const failing = createDesktopBridge("44.9.1", fake.ipc, (message) =>
    reported.push(message),
  );
  failing.connection.subscribeStatus(() => {
    throw new Error("broken");
  });
  fake.emit(EVENT_CHANNELS.connectionStatusChanged, {
    state: "connected",
    revision: 5,
  });
  expect(reported).toEqual(["A connection status callback failed."]);
});

const WORKSPACE_ID = "019a5b2c-3d4e-7f60-8a1b-2c3d4e5f6a7b";
const PROJECT_ID = "019a5b2c-3d4e-7f60-9a1b-2c3d4e5f6a7c";

const workspaceState = (revision: number) => ({
  revision,
  status: "ready",
  workspaces: [{ id: WORKSPACE_ID, name: "Team" }],
  selectedWorkspaceId: WORKSPACE_ID,
  projects: [{ id: PROJECT_ID, name: "Desktop" }],
  openProjectId: null,
});

test("getState calls its channel and passes no argument from the renderer on", async () => {
  const fake = fakeIpc();
  const getState = createDesktopBridge("44.9.1", fake.ipc).workspaces
    .getState as (...args: unknown[]) => Promise<unknown>;

  const answer = getState("workspaces:select", WORKSPACE_ID);
  fake.answers[0]?.resolve(workspaceState(1));

  await expect(answer).resolves.toEqual(workspaceState(1));
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.getWorkspaceState, args: [] },
  ]);
});

test("select passes only the workspace ID string on", async () => {
  const fake = fakeIpc();
  const select = createDesktopBridge("44.9.1", fake.ipc).workspaces.select as (
    ...args: unknown[]
  ) => Promise<unknown>;

  const answer = select(WORKSPACE_ID, "extra", { force: true });
  fake.answers[0]?.resolve({ outcome: "ok" });

  await expect(answer).resolves.toEqual({ outcome: "ok" });
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.selectWorkspace, args: [WORKSPACE_ID] },
  ]);
});

test("openProject passes only the project ID string or null on", async () => {
  const fake = fakeIpc();
  const openProject = createDesktopBridge("44.9.1", fake.ipc).workspaces
    .openProject as (...args: unknown[]) => Promise<unknown>;

  const answers = [openProject(PROJECT_ID, "extra"), openProject(null, 1)];
  fake.answers[0]?.resolve({ outcome: "ok" });
  fake.answers[1]?.resolve({ outcome: "refused", reason: "not_found" });

  await expect(Promise.all(answers)).resolves.toEqual([
    { outcome: "ok" },
    { outcome: "refused", reason: "not_found" },
  ]);
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.openProject, args: [PROJECT_ID] },
    { channel: INVOKE_CHANNELS.openProject, args: [null] },
  ]);
});

test("select and openProject pass on only their own fixed option, and only when the renderer asks to discard the waiting messages", async () => {
  const fake = fakeIpc();
  const workspaces = createDesktopBridge("44.9.1", fake.ipc)
    .workspaces as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const asked = { discardWaiting: true, force: true };

  void workspaces["select"]?.(WORKSPACE_ID, asked);
  void workspaces["openProject"]?.(PROJECT_ID, { discardWaiting: true });
  void workspaces["openProject"]?.(null, { discardWaiting: true }, "extra");
  for (const option of [
    { discardWaiting: false },
    { discardWaiting: "true" },
    { discardWaiting: 1 },
    {},
    true,
    null,
    "discard",
  ]) {
    void workspaces["select"]?.(WORKSPACE_ID, option);
    void workspaces["openProject"]?.(PROJECT_ID, option);
  }

  const discard = { discardWaiting: true };
  expect(fake.invoked.slice(0, 3)).toEqual([
    { channel: INVOKE_CHANNELS.selectWorkspace, args: [WORKSPACE_ID, discard] },
    { channel: INVOKE_CHANNELS.openProject, args: [PROJECT_ID, discard] },
    { channel: INVOKE_CHANNELS.openProject, args: [null, discard] },
  ]);
  // The option is the bridge's own frozen object, never the renderer's.
  const sent = fake.invoked[0]?.args[1];
  expect(sent).not.toBe(asked);
  expect(Object.isFrozen(sent)).toBe(true);
  expect(fake.invoked.slice(3)).toEqual(
    Array.from({ length: 7 }, () => [
      { channel: INVOKE_CHANNELS.selectWorkspace, args: [WORKSPACE_ID] },
      { channel: INVOKE_CHANNELS.openProject, args: [PROJECT_ID] },
    ]).flat(),
  );
});

test("select and openProject refuse a value of another type without calling the main process", async () => {
  const fake = fakeIpc();
  const workspaces = createDesktopBridge("44.9.1", fake.ipc)
    .workspaces as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;

  for (const value of [undefined, 1, { id: WORKSPACE_ID }, [WORKSPACE_ID]]) {
    await expect(workspaces["select"]?.(value)).rejects.toThrow(TypeError);
    await expect(workspaces["openProject"]?.(value)).rejects.toThrow(TypeError);
  }
  await expect(workspaces["select"]?.(null)).rejects.toThrow(TypeError);
  await expect(workspaces["openProject"]?.()).rejects.toThrow(TypeError);
  expect(fake.invoked).toEqual([]);
});

test("create passes only the name string on, and createProject only the workspace ID and the name strings", async () => {
  const fake = fakeIpc();
  const workspaces = createDesktopBridge("44.9.1", fake.ipc)
    .workspaces as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;

  const answers = [
    workspaces["create"]?.("Team Alpha", "extra", { force: true }),
    workspaces["createProject"]?.(WORKSPACE_ID, "Launch Plan", "extra"),
  ];
  const created = {
    outcome: "ok",
    workspaceId: WORKSPACE_ID,
    selected: true,
  };
  fake.answers[0]?.resolve(created);
  fake.answers[1]?.resolve({ outcome: "ok", projectId: PROJECT_ID });

  await expect(Promise.all(answers)).resolves.toEqual([
    created,
    { outcome: "ok", projectId: PROJECT_ID },
  ]);
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.createWorkspace, args: ["Team Alpha"] },
    {
      channel: INVOKE_CHANNELS.createProject,
      args: [WORKSPACE_ID, "Launch Plan"],
    },
  ]);
});

test("create and createProject refuse a value that is not a string without calling the main process or naming it", async () => {
  const fake = fakeIpc();
  const workspaces = createDesktopBridge("44.9.1", fake.ipc)
    .workspaces as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;

  for (const value of [undefined, null, 1, { name: "Secret" }, ["Secret"]]) {
    for (const call of [
      () => workspaces["create"]?.(value),
      () => workspaces["createProject"]?.(value, "Secret"),
      () => workspaces["createProject"]?.(WORKSPACE_ID, value),
    ]) {
      const answer = call();
      await expect(answer).rejects.toThrow(TypeError);
      await answer?.catch((error: unknown) => {
        expect(String(error)).not.toContain("Secret");
      });
    }
  }
  expect(fake.invoked).toEqual([]);
});

test("the workspace subscription delivers the state and every newer one, without the event object", async () => {
  const fake = fakeIpc();
  const reported: string[] = [];
  const bridge = createDesktopBridge("44.9.1", fake.ipc, (message) =>
    reported.push(message),
  );
  const calls: unknown[][] = [];
  let errors = 0;

  const end = bridge.workspaces.subscribeState(
    (...args: unknown[]) => calls.push(args),
    () => {
      errors += 1;
    },
  );
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.subscribeWorkspaceState, args: [] },
  ]);
  fake.emit(EVENT_CHANNELS.workspaceStateChanged, workspaceState(3));
  fake.answers[0]?.resolve(workspaceState(2));
  await settle();
  fake.emit(EVENT_CHANNELS.workspaceStateChanged, workspaceState(4));
  end();
  fake.emit(EVENT_CHANNELS.workspaceStateChanged, workspaceState(5));

  expect(calls).toEqual([[workspaceState(3)], [workspaceState(4)]]);
  expect(fake.listenerCount(EVENT_CHANNELS.workspaceStateChanged)).toBe(0);
  expect(errors).toBe(0);

  bridge.workspaces.subscribeState(
    () => {
      throw new Error("listener");
    },
    () => {
      errors += 1;
    },
  );
  fake.emit(EVENT_CHANNELS.workspaceStateChanged, workspaceState(1));
  fake.answers[1]?.reject(new Error("refused"));
  await settle();

  expect(errors).toBe(1);
  expect(reported).toEqual(["A workspace state callback failed."]);
});

test("the people functions call their channels and pass no argument from the renderer on", async () => {
  const fake = fakeIpc();
  const people = createDesktopBridge("44.9.1", fake.ipc)
    .people as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const empty = { status: "signed_out", revision: 0 };

  const answer = people["getState"]?.("people:subscribe-state", {
    memberId: "other",
  });
  fake.answers[0]?.resolve(empty);

  await expect(answer).resolves.toEqual(empty);
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.getPeopleState, args: [] },
  ]);
});

test("the people subscription delivers the people and every newer state, without the event object", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);
  const calls: unknown[][] = [];
  const reported: string[] = [];
  const unsubscribe = bridge.people.subscribeState((...args) =>
    calls.push(args),
  );

  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.subscribePeopleState, args: [] },
  ]);
  fake.answers[0]?.resolve({ status: "loading", revision: 3 });
  await settle();
  fake.emit(EVENT_CHANNELS.peopleStateChanged, {
    status: "ready",
    revision: 4,
  });
  fake.emit(EVENT_CHANNELS.peopleStateChanged, {
    status: "loading",
    revision: 2,
  });
  expect(calls).toEqual([
    [{ status: "loading", revision: 3 }],
    [{ status: "ready", revision: 4 }],
  ]);
  unsubscribe();
  expect(fake.listenerCount(EVENT_CHANNELS.peopleStateChanged)).toBe(0);

  const failing = createDesktopBridge("44.9.1", fake.ipc, (message) =>
    reported.push(message),
  );
  let refused = 0;
  failing.people.subscribeState(
    () => {
      throw new Error("broken");
    },
    () => {
      refused += 1;
    },
  );
  fake.emit(EVENT_CHANNELS.peopleStateChanged, {
    status: "ready",
    revision: 5,
  });
  expect(reported).toEqual(["A people state callback failed."]);
  fake.answers[1]?.reject(new Error("refused"));
  await settle();
  expect(refused).toBe(1);
});

const MEMBER_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000c1";

/** Each people action, its channel, and the strings it takes. */
const PEOPLE_ACTIONS = [
  ["define", INVOKE_CHANNELS.definePerson, [WORKSPACE_ID, "Linus"]],
  ["rename", INVOKE_CHANNELS.renamePerson, [WORKSPACE_ID, MEMBER_ID, "Linus"]],
  ["remove", INVOKE_CHANNELS.removePerson, [WORKSPACE_ID, MEMBER_ID]],
  ["promote", INVOKE_CHANNELS.promotePerson, [WORKSPACE_ID, MEMBER_ID]],
  ["demote", INVOKE_CHANNELS.demotePerson, [WORKSPACE_ID, MEMBER_ID]],
  ["leave", INVOKE_CHANNELS.leaveWorkspace, [WORKSPACE_ID]],
  ["offerOwnership", INVOKE_CHANNELS.offerOwnership, [WORKSPACE_ID, MEMBER_ID]],
  [
    "withdrawOwnershipOffer",
    INVOKE_CHANNELS.withdrawOwnershipOffer,
    [WORKSPACE_ID],
  ],
  [
    "acceptOwnershipOffer",
    INVOKE_CHANNELS.acceptOwnershipOffer,
    [WORKSPACE_ID],
  ],
] as const;

test("each people action calls its own channel with only its strings, and passes the answer through", async () => {
  const fake = fakeIpc();
  const actions = createDesktopBridge("44.9.1", fake.ipc)
    .peopleActions as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;

  const answers = PEOPLE_ACTIONS.map(([name, , args]) =>
    // An extra argument is not passed on.
    actions[name]?.(...args, { force: true }, "people:remove"),
  );
  for (const [index, answer] of fake.answers.entries()) {
    answer.resolve(
      index === 0
        ? { outcome: "ok", memberId: MEMBER_ID }
        : { outcome: "unknown" },
    );
  }

  await expect(Promise.all(answers)).resolves.toEqual([
    { outcome: "ok", memberId: MEMBER_ID },
    ...PEOPLE_ACTIONS.slice(1).map(() => ({ outcome: "unknown" })),
  ]);
  expect(fake.invoked).toEqual(
    PEOPLE_ACTIONS.map(([, channel, args]) => ({ channel, args: [...args] })),
  );
});

test("each people action refuses a value that is not a string without calling the main process or naming it", async () => {
  const fake = fakeIpc();
  const actions = createDesktopBridge("44.9.1", fake.ipc)
    .peopleActions as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;

  for (const [name, , args] of PEOPLE_ACTIONS) {
    for (const [index] of args.entries()) {
      for (const value of [
        undefined,
        null,
        1,
        ["secret-value"],
        { toString: () => "secret-value" },
      ]) {
        const call = args.map((arg, at) => (at === index ? value : arg));
        const result = actions[name]?.(...call);
        await expect(result, name).rejects.toThrow(TypeError);
        await result?.catch((error: unknown) => {
          expect(String(error)).not.toContain("secret-value");
        });
      }
    }
    await expect(actions[name]?.(), name).rejects.toThrow(TypeError);
  }
  expect(fake.invoked).toEqual([]);
});

test("the invitation functions call their channels and pass no argument from the renderer on", async () => {
  const fake = fakeIpc();
  const invitations = createDesktopBridge("44.9.1", fake.ipc)
    .invitations as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const empty = { status: "signed_out", revision: 0 };

  const state = invitations["getState"]?.("invitations:create", WORKSPACE_ID);
  const load = invitations["load"]?.(WORKSPACE_ID, { force: true });
  fake.answers[0]?.resolve(empty);
  fake.answers[1]?.resolve({ outcome: "loading" });

  await expect(state).resolves.toEqual(empty);
  await expect(load).resolves.toEqual({ outcome: "loading" });
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.getInvitationState, args: [] },
    { channel: INVOKE_CHANNELS.loadInvitations, args: [] },
  ]);
});

test("the invitation subscription delivers the state and every newer one, without the event object", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);
  const calls: unknown[][] = [];
  const reported: string[] = [];
  const unsubscribe = bridge.invitations.subscribeState((...args) =>
    calls.push(args),
  );

  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.subscribeInvitationState, args: [] },
  ]);
  fake.answers[0]?.resolve({ status: "loading", revision: 3 });
  await settle();
  fake.emit(EVENT_CHANNELS.invitationStateChanged, {
    status: "ready",
    revision: 4,
  });
  fake.emit(EVENT_CHANNELS.invitationStateChanged, {
    status: "loading",
    revision: 2,
  });
  expect(calls).toEqual([
    [{ status: "loading", revision: 3 }],
    [{ status: "ready", revision: 4 }],
  ]);
  unsubscribe();
  expect(fake.listenerCount(EVENT_CHANNELS.invitationStateChanged)).toBe(0);

  const failing = createDesktopBridge("44.9.1", fake.ipc, (message) =>
    reported.push(message),
  );
  let refused = 0;
  failing.invitations.subscribeState(
    () => {
      throw new Error("broken");
    },
    () => {
      refused += 1;
    },
  );
  fake.emit(EVENT_CHANNELS.invitationStateChanged, {
    status: "ready",
    revision: 5,
  });
  expect(reported).toEqual(["An invitation state callback failed."]);
  fake.answers[1]?.reject(new Error("refused"));
  await settle();
  expect(refused).toBe(1);
});

const INVITATION_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000e1";
const INVITATION_CODE = `mmdi_${"Br1dgeC0de-_".repeat(4).slice(0, 42)}g`;

/** Each invitation action, its channel, and the values it takes. */
const INVITATION_ACTIONS = [
  [
    "create",
    INVOKE_CHANNELS.createInvitation,
    [WORKSPACE_ID, MEMBER_ID, 3_600],
  ],
  ["create", INVOKE_CHANNELS.createInvitation, [WORKSPACE_ID, MEMBER_ID, null]],
  ["revoke", INVOKE_CHANNELS.revokeInvitation, [WORKSPACE_ID, INVITATION_ID]],
  ["preview", INVOKE_CHANNELS.previewInvitation, [INVITATION_CODE]],
  ["accept", INVOKE_CHANNELS.acceptInvitation, [INVITATION_CODE]],
] as const;

test("each invitation action calls its own channel with only its values, and passes the answer through", async () => {
  const fake = fakeIpc();
  const actions = createDesktopBridge("44.9.1", fake.ipc)
    .invitationActions as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;

  const answers = INVITATION_ACTIONS.map(([name, , args]) =>
    // An extra argument is not passed on.
    actions[name]?.(...args, { force: true }, "people:remove"),
  );
  // A create without a lifetime, or with undefined, passes on null.
  answers.push(actions["create"]?.(WORKSPACE_ID, MEMBER_ID));
  answers.push(actions["create"]?.(WORKSPACE_ID, MEMBER_ID, undefined));
  const created = {
    outcome: "ok",
    invitationId: INVITATION_ID,
    code: INVITATION_CODE,
    expiresAt: "2026-11-12T10:00:00.000Z",
  };
  for (const [index, answer] of fake.answers.entries()) {
    answer.resolve(index === 0 ? created : { outcome: "unknown" });
  }

  await expect(Promise.all(answers)).resolves.toEqual([
    created,
    ...Array.from({ length: answers.length - 1 }, () => ({
      outcome: "unknown",
    })),
  ]);
  expect(fake.invoked).toEqual([
    ...INVITATION_ACTIONS.map(([, channel, args]) => ({
      channel,
      args: [...args],
    })),
    {
      channel: INVOKE_CHANNELS.createInvitation,
      args: [WORKSPACE_ID, MEMBER_ID, null],
    },
    {
      channel: INVOKE_CHANNELS.createInvitation,
      args: [WORKSPACE_ID, MEMBER_ID, null],
    },
  ]);
});

test("each invitation action refuses a value of another type without calling the main process or naming it", async () => {
  const fake = fakeIpc();
  const actions = createDesktopBridge("44.9.1", fake.ipc)
    .invitationActions as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;

  for (const [name, , args] of INVITATION_ACTIONS) {
    for (const [index, arg] of args.entries()) {
      const values =
        arg === null || typeof arg === "number"
          ? ["3600", 3_600.5, Number.NaN, Infinity, { valueOf: () => 3_600 }]
          : [
              undefined,
              null,
              1,
              [INVITATION_CODE],
              { toString: () => INVITATION_CODE },
            ];
      for (const value of values) {
        const call = args.map((entry, at) => (at === index ? value : entry));
        const result = actions[name]?.(...call);
        await expect(result, name).rejects.toThrow(TypeError);
        await result?.catch((error: unknown) => {
          expect(String(error)).not.toContain(INVITATION_CODE);
          expect(String(error)).not.toContain(INVITATION_CODE.slice(5));
        });
      }
    }
    await expect(actions[name]?.(), name).rejects.toThrow(TypeError);
  }
  expect(fake.invoked).toEqual([]);
});

test("the agent functions call their channels and pass no argument from the renderer on", async () => {
  const fake = fakeIpc();
  const agents = createDesktopBridge("44.9.1", fake.ipc)
    .agents as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const empty = { status: "no_project", revision: 0 };

  const answer = agents["getState"]?.("agents:subscribe-state", {
    projectId: "other",
  });
  fake.answers[0]?.resolve(empty);

  await expect(answer).resolves.toEqual(empty);
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.getAgentState, args: [] },
  ]);
});

test("the agent subscription delivers the activity and every newer one, without the event object", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);
  const calls: unknown[][] = [];
  const reported: string[] = [];
  const unsubscribe = bridge.agents.subscribeState((...args) =>
    calls.push(args),
  );

  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.subscribeAgentState, args: [] },
  ]);
  fake.answers[0]?.resolve({ status: "loading", revision: 3 });
  await settle();
  fake.emit(EVENT_CHANNELS.agentStateChanged, { status: "ready", revision: 4 });
  fake.emit(EVENT_CHANNELS.agentStateChanged, {
    status: "loading",
    revision: 2,
  });
  expect(calls).toEqual([
    [{ status: "loading", revision: 3 }],
    [{ status: "ready", revision: 4 }],
  ]);
  unsubscribe();
  expect(fake.listenerCount(EVENT_CHANNELS.agentStateChanged)).toBe(0);

  const failing = createDesktopBridge("44.9.1", fake.ipc, (message) =>
    reported.push(message),
  );
  let refused = 0;
  failing.agents.subscribeState(
    () => {
      throw new Error("broken");
    },
    () => {
      refused += 1;
    },
  );
  fake.emit(EVENT_CHANNELS.agentStateChanged, { status: "ready", revision: 5 });
  expect(reported).toEqual(["An agent activity callback failed."]);
  fake.answers[1]?.reject(new Error("refused"));
  await settle();
  expect(refused).toBe(1);
});

const EVENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000003001";

test("the chat state and load-older call their channels and pass no argument from the renderer on", async () => {
  const fake = fakeIpc();
  const chat = createDesktopBridge("44.9.1", fake.ipc)
    .chat as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const empty = { status: "no_project", revision: 0 };

  const answers = [
    chat["getState"]?.("chat:send", "Hello"),
    chat["loadOlder"]?.(5, { beforeSeq: 1 }),
  ];
  fake.answers[0]?.resolve(empty);
  fake.answers[1]?.resolve("started");

  await expect(Promise.all(answers)).resolves.toEqual([empty, "started"]);
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.getChatState, args: [] },
    { channel: INVOKE_CHANNELS.loadOlderChatMessages, args: [] },
  ]);
});

test("send passes only the text string on, and retry and discard only the event ID string", async () => {
  const fake = fakeIpc();
  const chat = createDesktopBridge("44.9.1", fake.ipc)
    .chat as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;

  const answers = [
    chat["send"]?.("Hello\r\nthere", { projectId: "other" }),
    chat["retry"]?.(EVENT_ID, "extra"),
    chat["discard"]?.(EVENT_ID, EVENT_ID),
  ];
  fake.answers[0]?.resolve({ outcome: "accepted", eventId: EVENT_ID });
  fake.answers[1]?.resolve(true);
  fake.answers[2]?.resolve(false);

  await expect(Promise.all(answers)).resolves.toEqual([
    { outcome: "accepted", eventId: EVENT_ID },
    true,
    false,
  ]);
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.sendChatMessage, args: ["Hello\r\nthere"] },
    { channel: INVOKE_CHANNELS.retryChatMessage, args: [EVENT_ID] },
    { channel: INVOKE_CHANNELS.discardChatMessage, args: [EVENT_ID] },
  ]);
});

test("send, retry, and discard refuse a value of another type without calling the main process or naming it", async () => {
  const fake = fakeIpc();
  const chat = createDesktopBridge("44.9.1", fake.ipc)
    .chat as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;

  for (const name of ["send", "retry", "discard"]) {
    for (const value of [
      undefined,
      null,
      1,
      { text: "secret" },
      ["secret"],
      new String("secret"),
    ]) {
      const answer = chat[name]?.(value);
      await expect(answer).rejects.toThrow(TypeError);
      await answer?.catch((error: unknown) => {
        expect(String(error)).not.toContain("secret");
      });
    }
  }
  expect(fake.invoked).toEqual([]);
});

test("the chat subscription delivers the state and every newer one, without the event object", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);
  const calls: unknown[][] = [];
  const reported: string[] = [];
  const unsubscribe = bridge.chat.subscribeState((...args) => calls.push(args));

  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.subscribeChatState, args: [] },
  ]);
  fake.answers[0]?.resolve({ status: "loading", revision: 3 });
  await settle();
  fake.emit(EVENT_CHANNELS.chatStateChanged, { status: "ready", revision: 4 });
  fake.emit(EVENT_CHANNELS.chatStateChanged, {
    status: "loading",
    revision: 2,
  });
  expect(calls).toEqual([
    [{ status: "loading", revision: 3 }],
    [{ status: "ready", revision: 4 }],
  ]);
  unsubscribe();
  expect(fake.listenerCount(EVENT_CHANNELS.chatStateChanged)).toBe(0);

  const failing = createDesktopBridge("44.9.1", fake.ipc, (message) =>
    reported.push(message),
  );
  let refused = 0;
  failing.chat.subscribeState(
    () => {
      throw new Error("broken");
    },
    () => {
      refused += 1;
    },
  );
  fake.emit(EVENT_CHANNELS.chatStateChanged, { status: "ready", revision: 5 });
  expect(reported).toEqual(["A chat state callback failed."]);
  fake.answers[1]?.reject(new Error("refused"));
  await settle();
  expect(refused).toBe(1);
});

test("the device list subscription delivers the state and every newer one, without the event object", async () => {
  const fake = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", fake.ipc);
  const calls: unknown[][] = [];
  const reported: string[] = [];
  const unsubscribe = bridge.devices.subscribeState((...args) =>
    calls.push(args),
  );

  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.subscribeDeviceList, args: [] },
  ]);
  fake.answers[0]?.resolve({ status: "loading", revision: 3 });
  await settle();
  fake.emit(EVENT_CHANNELS.deviceListChanged, { status: "ready", revision: 4 });
  fake.emit(EVENT_CHANNELS.deviceListChanged, {
    status: "loading",
    revision: 2,
  });
  expect(calls).toEqual([
    [{ status: "loading", revision: 3 }],
    [{ status: "ready", revision: 4 }],
  ]);
  unsubscribe();
  expect(fake.listenerCount(EVENT_CHANNELS.deviceListChanged)).toBe(0);

  const failing = createDesktopBridge("44.9.1", fake.ipc, (message) =>
    reported.push(message),
  );
  let refused = 0;
  failing.devices.subscribeState(
    () => {
      throw new Error("broken");
    },
    () => {
      refused += 1;
    },
  );
  fake.emit(EVENT_CHANNELS.deviceListChanged, {
    status: "ready",
    revision: 5,
  });
  expect(reported).toEqual(["A device list callback failed."]);
  fake.answers[1]?.reject(new Error("refused"));
  await settle();
  expect(refused).toBe(1);
});
