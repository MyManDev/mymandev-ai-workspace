import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type { RuntimeStatus } from "../shared/ipc-contract.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import {
  createInvokeHandler,
  createStatusPublisher,
  isApplicationFrame,
  registerRuntimeIpc,
  type IpcFrame,
  type IpcInvokeEvent,
  type IpcInvokeListener,
  type StatusReceiver,
} from "./ipc.ts";
import { resolveRendererUrl } from "./navigation.ts";

const DEV_URL = "http://localhost:5173/";
const RUNNING: RuntimeStatus = { state: "running", revision: 2 };

interface FakeFrameOptions {
  readonly parent?: IpcFrame | null;
  readonly detached?: boolean;
  readonly destroyed?: boolean;
}

function fakeFrame(url: string, options: FakeFrameOptions = {}): IpcFrame {
  return {
    url,
    parent: options.parent ?? null,
    detached: options.detached ?? false,
    isDestroyed: () => options.destroyed ?? false,
  };
}

interface FakeReceiver extends StatusReceiver {
  mainFrame: IpcFrame;
  readonly sent: unknown[][];
  /** The number of "destroyed" listeners that have not fired yet. */
  destroyedListeners(): number;
  destroy(): void;
}

function fakeReceiver(url: string = DEV_URL): FakeReceiver {
  const onDestroyed: (() => void)[] = [];
  let destroyed = false;
  return {
    mainFrame: fakeFrame(url),
    sent: [],
    isDestroyed: () => destroyed,
    send(channel, ...args) {
      this.sent.push([channel, ...args]);
    },
    once(_event, listener) {
      onDestroyed.push(listener);
    },
    destroyedListeners: () => onDestroyed.length,
    destroy() {
      destroyed = true;
      for (const listener of onDestroyed.splice(0)) {
        listener();
      }
    },
  };
}

function fakeEvent(
  senderFrame: IpcFrame | null,
  sender: StatusReceiver = fakeReceiver(),
): IpcInvokeEvent {
  return { senderFrame, sender };
}

test("the main frame of the application is a trusted sender", () => {
  expect(isApplicationFrame(fakeFrame(DEV_URL), DEV_URL)).toBe(true);
  expect(
    isApplicationFrame(fakeFrame("http://localhost:5173/index.html"), DEV_URL),
  ).toBe(true);
  expect(isApplicationFrame(fakeFrame(APP_ENTRY_URL), APP_ENTRY_URL)).toBe(
    true,
  );
  expect(
    isApplicationFrame(fakeFrame(`${APP_ENTRY_URL}#about`), APP_ENTRY_URL),
  ).toBe(true);
});

test("the sender check follows the URL the window loads", () => {
  const built = resolveRendererUrl({
    isPackaged: true,
    devServerUrl: DEV_URL,
  });
  const development = resolveRendererUrl({
    isPackaged: false,
    devServerUrl: DEV_URL,
  });

  expect(built).toBe("app://renderer/index.html");
  expect(isApplicationFrame(fakeFrame(built), built)).toBe(true);
  expect(isApplicationFrame(fakeFrame(DEV_URL), built)).toBe(false);
  expect(isApplicationFrame(fakeFrame(development), development)).toBe(true);
  expect(isApplicationFrame(fakeFrame(built), development)).toBe(false);
});

test("a foreign sender is refused", () => {
  for (const url of [
    "https://example.com/",
    "http://localhost:5174/",
    "http://127.0.0.1:5173/",
    "https://localhost:5173/",
    "app://renderer/other.html",
    "app://renderer/assets/index.js",
    "app://renderer/index.html?x=1",
    "app://other/index.html",
    "file:///app/out/renderer/index.html",
    "file:///etc/passwd",
    "about:blank",
    "data:text/html,<p>x</p>",
    "",
  ]) {
    expect(isApplicationFrame(fakeFrame(url), DEV_URL)).toBe(false);
    expect(isApplicationFrame(fakeFrame(url), APP_ENTRY_URL)).toBe(false);
  }
});

test("a subframe, a detached or destroyed frame, and a missing frame are refused", () => {
  const top = fakeFrame(DEV_URL);

  expect(isApplicationFrame(fakeFrame(DEV_URL, { parent: top }), DEV_URL)).toBe(
    false,
  );
  expect(
    isApplicationFrame(fakeFrame(DEV_URL, { detached: true }), DEV_URL),
  ).toBe(false);
  expect(
    isApplicationFrame(fakeFrame(DEV_URL, { destroyed: true }), DEV_URL),
  ).toBe(false);
  expect(isApplicationFrame(null, DEV_URL)).toBe(false);
  expect(isApplicationFrame(undefined, DEV_URL)).toBe(false);
});

test("a frame that throws when it is read is refused", () => {
  const disposed: IpcFrame = {
    get url(): string {
      throw new Error("Render frame was disposed.");
    },
    parent: null,
    detached: false,
    isDestroyed: () => false,
  };

  expect(isApplicationFrame(disposed, DEV_URL)).toBe(false);
});

test("a handler answers the application with the parsed result", () => {
  const handler = createInvokeHandler(
    INVOKE_CHANNELS.getRuntimeStatus,
    DEV_URL,
    () => ({ ...RUNNING, internal: "never sent" }) as RuntimeStatus,
  );

  expect(handler(fakeEvent(fakeFrame(DEV_URL)))).toEqual(RUNNING);
});

test("a handler refuses a foreign sender before the implementation runs", () => {
  let calls = 0;
  const handler = createInvokeHandler(
    INVOKE_CHANNELS.getRuntimeStatus,
    DEV_URL,
    () => {
      calls += 1;
      return RUNNING;
    },
  );

  for (const frame of [
    fakeFrame("https://example.com/"),
    fakeFrame(DEV_URL, { parent: fakeFrame(DEV_URL) }),
    null,
  ]) {
    expect(() => handler(fakeEvent(frame))).toThrow(
      "The call on runtime:get-status was refused: the sender is not the application.",
    );
  }
  expect(calls).toBe(0);
});

test("a handler refuses invalid arguments without echoing them", () => {
  let calls = 0;
  const handler = createInvokeHandler(
    INVOKE_CHANNELS.subscribeRuntimeStatus,
    DEV_URL,
    () => {
      calls += 1;
      return RUNNING;
    },
  );

  for (const args of [["secret-argument"], [undefined], [{}, 1]]) {
    let message = "";
    try {
      handler(fakeEvent(fakeFrame(DEV_URL)), ...args);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "The call on runtime:subscribe-status was refused: the arguments do not match the contract.",
    );
  }
  expect(calls).toBe(0);
});

test("a handler parses the value of a promise with the contract", async () => {
  const handler = createInvokeHandler(
    INVOKE_CHANNELS.getRuntimeStatus,
    DEV_URL,
    () =>
      Promise.resolve({ ...RUNNING, internal: "never sent" } as RuntimeStatus),
  );

  await expect(handler(fakeEvent(fakeFrame(DEV_URL)))).resolves.toEqual(
    RUNNING,
  );
});

test("a handler rejects a promised result that breaks the contract", async () => {
  const handler = createInvokeHandler(
    INVOKE_CHANNELS.getRuntimeStatus,
    DEV_URL,
    () =>
      Promise.resolve({
        state: "paused",
        revision: 0,
      } as unknown as RuntimeStatus),
  );

  await expect(handler(fakeEvent(fakeFrame(DEV_URL)))).rejects.toThrow();
});

test("a handler with an asynchronous implementation still refuses before it runs", () => {
  let calls = 0;
  const handler = createInvokeHandler(
    INVOKE_CHANNELS.getRuntimeStatus,
    DEV_URL,
    async () => {
      calls += 1;
      return RUNNING;
    },
  );

  expect(() => handler(fakeEvent(fakeFrame("https://example.com/")))).toThrow(
    /the sender is not the application/,
  );
  expect(() => handler(fakeEvent(fakeFrame(DEV_URL)), "extra")).toThrow(
    /the arguments do not match the contract/,
  );
  expect(calls).toBe(0);
});

test("a handler never sends a result that breaks the contract", () => {
  const handler = createInvokeHandler(
    INVOKE_CHANNELS.getRuntimeStatus,
    DEV_URL,
    () => ({ state: "paused", revision: 0 }) as unknown as RuntimeStatus,
  );

  expect(() => handler(fakeEvent(fakeFrame(DEV_URL)))).toThrow();
});

test("the publisher sends a status to every receiver that shows the application", () => {
  const publisher = createStatusPublisher(DEV_URL);
  const first = fakeReceiver();
  const second = fakeReceiver();

  publisher.add(first);
  publisher.add(second);
  publisher.add(first);
  publisher.publish({ ...RUNNING, extra: 1 } as RuntimeStatus);

  expect(publisher.size()).toBe(2);
  expect(first.sent).toEqual([[EVENT_CHANNELS.runtimeStatusChanged, RUNNING]]);
  expect(second.sent).toEqual([[EVENT_CHANNELS.runtimeStatusChanged, RUNNING]]);
});

test("the publisher drops a destroyed receiver and one that left the application", () => {
  const publisher = createStatusPublisher(DEV_URL);
  const destroyed = fakeReceiver();
  const navigated = fakeReceiver();
  const staying = fakeReceiver();
  publisher.add(destroyed);
  publisher.add(navigated);
  publisher.add(staying);

  destroyed.destroy();
  navigated.mainFrame = fakeFrame("https://example.com/");
  publisher.publish(RUNNING);

  expect(destroyed.sent).toEqual([]);
  expect(navigated.sent).toEqual([]);
  expect(staying.sent).toHaveLength(1);
  expect(publisher.size()).toBe(1);
});

test("a destroyed receiver leaves the publisher at once, before any status is sent", () => {
  const publisher = createStatusPublisher(DEV_URL);
  const receiver = fakeReceiver();
  publisher.add(receiver);

  expect(publisher.size()).toBe(1);
  receiver.destroy();

  expect(publisher.size()).toBe(0);
  expect(receiver.destroyedListeners()).toBe(0);
});

test("subscribing again after a reload or a crash adds no second destroyed listener", () => {
  const publisher = createStatusPublisher(DEV_URL);
  const receiver = fakeReceiver();

  for (let round = 0; round < 5; round += 1) {
    publisher.add(receiver);
    publisher.add(receiver);
    // The page leaves the application, for example while it crashes or
    // reloads, and the next status removes the receiver.
    receiver.mainFrame = fakeFrame("about:blank");
    publisher.publish(RUNNING);
    expect(publisher.size()).toBe(0);
    receiver.mainFrame = fakeFrame(DEV_URL);
  }
  publisher.add(receiver);

  expect(receiver.destroyedListeners()).toBe(1);
  expect(publisher.size()).toBe(1);
  receiver.destroy();
  expect(publisher.size()).toBe(0);
});

function fakeRuntime(initial: RuntimeStatus) {
  let status = initial;
  const listeners: ((status: RuntimeStatus) => void)[] = [];
  return {
    status: () => status,
    onStatusChange: (listener: (status: RuntimeStatus) => void) => {
      listeners.push(listener);
      return () => undefined;
    },
    change(next: RuntimeStatus) {
      status = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
  };
}

function registerWithFakeIpc(runtime: ReturnType<typeof fakeRuntime>) {
  const handlers = new Map<string, IpcInvokeListener>();
  registerRuntimeIpc(
    {
      handle: (channel, listener) => {
        expect(handlers.has(channel)).toBe(false);
        handlers.set(channel, listener);
      },
    },
    DEV_URL,
    runtime,
  );
  return handlers;
}

const RUNTIME_CHANNELS = Object.values(INVOKE_CHANNELS).filter((channel) =>
  channel.startsWith("runtime:"),
);

test("registerRuntimeIpc registers a handler for every runtime channel and nothing else", () => {
  const handlers = registerWithFakeIpc(fakeRuntime(RUNNING));

  expect(RUNTIME_CHANNELS).toHaveLength(2);
  expect([...handlers.keys()].sort()).toEqual([...RUNTIME_CHANNELS].sort());
});

test("every registered handler checks the sender and the arguments", () => {
  const handlers = registerWithFakeIpc(fakeRuntime(RUNNING));
  const subframe = fakeFrame(DEV_URL, { parent: fakeFrame(DEV_URL) });

  expect(handlers.size).toBe(RUNTIME_CHANNELS.length);
  for (const [channel, handler] of handlers) {
    const receiver = fakeReceiver();
    for (const frame of [
      fakeFrame("https://example.com/"),
      fakeFrame(APP_ENTRY_URL),
      subframe,
      fakeFrame(DEV_URL, { detached: true }),
      null,
    ]) {
      expect(() => handler(fakeEvent(frame, receiver))).toThrow(
        `The call on ${channel} was refused: the sender is not the application.`,
      );
    }
    for (const args of [[undefined], ["extra"], [{}, 1]]) {
      expect(() =>
        handler(fakeEvent(fakeFrame(DEV_URL), receiver), ...args),
      ).toThrow(
        `The call on ${channel} was refused: the arguments do not match the contract.`,
      );
    }
    expect(receiver.destroyedListeners()).toBe(0);
    expect(handler(fakeEvent(fakeFrame(DEV_URL), receiver))).toEqual(RUNNING);
  }
});

test("get-status answers with the current status", () => {
  const runtime = fakeRuntime(RUNNING);
  const handlers = registerWithFakeIpc(runtime);

  expect(
    handlers.get(INVOKE_CHANNELS.getRuntimeStatus)?.(
      fakeEvent(fakeFrame(DEV_URL)),
    ),
  ).toEqual(RUNNING);
});

test("subscribe-status answers with the current status and sends every later one", () => {
  const runtime = fakeRuntime({ state: "starting", revision: 1 });
  const handlers = registerWithFakeIpc(runtime);
  const subscriber = fakeReceiver();
  const bystander = fakeReceiver();

  expect(
    handlers.get(INVOKE_CHANNELS.subscribeRuntimeStatus)?.(
      fakeEvent(fakeFrame(DEV_URL), subscriber),
    ),
  ).toEqual({ state: "starting", revision: 1 });
  runtime.change(RUNNING);

  expect(subscriber.sent).toEqual([
    [EVENT_CHANNELS.runtimeStatusChanged, RUNNING],
  ]);
  expect(bystander.sent).toEqual([]);
});

test("a refused subscription receives no status", () => {
  const runtime = fakeRuntime({ state: "starting", revision: 1 });
  const handlers = registerWithFakeIpc(runtime);
  const foreign = fakeReceiver("https://example.com/");

  expect(() =>
    handlers.get(INVOKE_CHANNELS.subscribeRuntimeStatus)?.(
      fakeEvent(fakeFrame("https://example.com/"), foreign),
    ),
  ).toThrow(/the sender is not the application/);
  runtime.change(RUNNING);

  expect(foreign.sent).toEqual([]);
});
