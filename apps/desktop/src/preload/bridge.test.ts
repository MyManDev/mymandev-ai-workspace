import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type { RuntimeStatus } from "../shared/ipc-contract.ts";
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

test("the bridge holds the Electron version and the runtime functions only, frozen", () => {
  const bridge = createDesktopBridge("44.9.1", fakeIpc().ipc);

  expect(Object.keys(bridge).sort()).toEqual(["electronVersion", "runtime"]);
  expect(Object.keys(bridge.runtime).sort()).toEqual([
    "getStatus",
    "subscribeStatus",
  ]);
  expect(bridge.electronVersion).toBe("44.9.1");
  expect(Object.isFrozen(bridge)).toBe(true);
  expect(Object.isFrozen(bridge.runtime)).toBe(true);
  expect(typeof bridge.runtime.getStatus).toBe("function");
  expect(typeof bridge.runtime.subscribeStatus).toBe("function");
});

test("no part of the bridge is the ipc object or a generic invoke", () => {
  const { ipc } = fakeIpc();
  const bridge = createDesktopBridge("44.9.1", ipc);
  const values = [
    ...Object.values(bridge),
    ...Object.values(bridge.runtime),
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
