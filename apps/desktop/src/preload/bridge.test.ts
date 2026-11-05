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

test("the bridge holds the Electron version, the runtime, the repository, the account, the connection, and the workspace functions only, frozen", () => {
  const bridge = createDesktopBridge("44.9.1", fakeIpc().ipc);

  expect(Object.keys(bridge).sort()).toEqual([
    "account",
    "connection",
    "electronVersion",
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
    "listDevices",
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
    "getState",
    "openProject",
    "select",
    "subscribeState",
  ]);
  expect(bridge.electronVersion).toBe("44.9.1");
  expect(Object.isFrozen(bridge)).toBe(true);
  expect(Object.isFrozen(bridge.runtime)).toBe(true);
  expect(Object.isFrozen(bridge.repositories)).toBe(true);
  expect(Object.isFrozen(bridge.account)).toBe(true);
  expect(Object.isFrozen(bridge.connection)).toBe(true);
  expect(Object.isFrozen(bridge.workspaces)).toBe(true);
  for (const value of [
    ...Object.values(bridge.runtime),
    ...Object.values(bridge.repositories),
    ...Object.values(bridge.account),
    ...Object.values(bridge.connection),
    ...Object.values(bridge.workspaces),
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
    account["listDevices"]?.({ all: true }),
  ];
  fake.answers[0]?.resolve(accountStatus(1));
  fake.answers[1]?.resolve({ outcome: "started" });
  fake.answers[2]?.resolve(true);
  fake.answers[3]?.resolve({ outcome: "forgotten", removedAtServer: true });
  fake.answers[4]?.resolve({ outcome: "pending" });
  fake.answers[5]?.resolve({ outcome: "cancelled" });
  fake.answers[6]?.resolve({ outcome: "listed", devices: [] });

  await expect(Promise.all(answers)).resolves.toEqual([
    accountStatus(1),
    { outcome: "started" },
    true,
    { outcome: "forgotten", removedAtServer: true },
    { outcome: "pending" },
    { outcome: "cancelled" },
    { outcome: "listed", devices: [] },
  ]);
  expect(fake.invoked).toEqual([
    { channel: INVOKE_CHANNELS.getAccountStatus, args: [] },
    { channel: INVOKE_CHANNELS.startSignIn, args: [] },
    { channel: INVOKE_CHANNELS.cancelSignIn, args: [] },
    { channel: INVOKE_CHANNELS.forgetAccount, args: [] },
    { channel: INVOKE_CHANNELS.signOut, args: [] },
    { channel: INVOKE_CHANNELS.removeDevice, args: [] },
    { channel: INVOKE_CHANNELS.listDevices, args: [] },
  ]);
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
