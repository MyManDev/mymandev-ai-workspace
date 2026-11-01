import { expect, test } from "vitest";
import type { RuntimeStatus } from "../shared/ipc-contract.ts";
import { createLocalRuntime, type RuntimeHooks } from "./runtime.ts";
import {
  stopRuntimeOnQuit,
  type Defer,
  type QuitHost,
} from "./runtime-lifecycle.ts";

/**
 * An application that emits `will-quit` for every `quit` and records whether
 * it ended. Deferred callbacks wait until the test calls `runDeferred`.
 */
function fakeApp() {
  let willQuit: ((event: { preventDefault(): void }) => void) | undefined;
  const record = { quitCalls: 0, exited: false };
  const deferred: (() => void)[] = [];
  const defer: Defer = (callback) => {
    deferred.push(callback);
  };
  function runDeferred(): void {
    for (const callback of deferred.splice(0)) {
      callback();
    }
  }
  /** Returns true when no listener held the quit back. */
  function emitWillQuit(): boolean {
    let prevented = false;
    willQuit?.({
      preventDefault: () => {
        prevented = true;
      },
    });
    if (!prevented) {
      record.exited = true;
    }
    return !prevented;
  }
  const host: QuitHost = {
    on: (event, listener) => {
      expect(event).toBe("will-quit");
      willQuit = listener;
    },
    quit: () => {
      record.quitCalls += 1;
      emitWillQuit();
    },
  };
  return { host, record, emitWillQuit, defer, runDeferred, deferred };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

test("a running runtime holds the quit back until it has stopped", async () => {
  const app = fakeApp();
  const runtime = createLocalRuntime();
  const seen: RuntimeStatus["state"][] = [];
  runtime.onStatusChange((status) => seen.push(status.state));
  stopRuntimeOnQuit(app.host, runtime, app.defer);
  await runtime.start();

  expect(app.emitWillQuit()).toBe(false);
  expect(app.record.exited).toBe(false);
  await settle();
  app.runDeferred();

  expect(seen).toEqual(["starting", "running", "stopping", "stopped"]);
  expect(app.record.quitCalls).toBe(1);
  expect(app.record.exited).toBe(true);
});

test("the second quit runs in a later task, not inside the will-quit listener", async () => {
  const app = fakeApp();
  const runtime = createLocalRuntime();
  stopRuntimeOnQuit(app.host, runtime, app.defer);
  await runtime.start();

  app.emitWillQuit();
  await settle();

  expect(runtime.status().state).toBe("stopped");
  expect(app.record.quitCalls).toBe(0);
  expect(app.deferred).toHaveLength(1);
  app.runDeferred();
  expect(app.record.quitCalls).toBe(1);
  expect(app.record.exited).toBe(true);
});

test("a second quit while stopping is held back and does not stop twice", async () => {
  let resolveStop: () => void = () => undefined;
  let stopCalls = 0;
  const hooks: RuntimeHooks = {
    start: () => Promise.resolve(),
    stop: () => {
      stopCalls += 1;
      return new Promise<void>((resolve) => {
        resolveStop = resolve;
      });
    },
  };
  const app = fakeApp();
  const runtime = createLocalRuntime({ hooks });
  stopRuntimeOnQuit(app.host, runtime, app.defer);
  await runtime.start();

  expect(app.emitWillQuit()).toBe(false);
  await settle();
  expect(app.emitWillQuit()).toBe(false);
  expect(stopCalls).toBe(1);
  resolveStop();
  await settle();
  app.runDeferred();

  expect(app.record.quitCalls).toBe(1);
  expect(app.record.exited).toBe(true);
  expect(runtime.status().state).toBe("stopped");
});

test("a runtime that fails to stop does not keep the application open", async () => {
  const app = fakeApp();
  const runtime = createLocalRuntime({
    hooks: {
      start: () => Promise.resolve(),
      stop: () => Promise.reject(new Error("no")),
    },
  });
  stopRuntimeOnQuit(app.host, runtime, app.defer);
  await runtime.start();

  app.emitWillQuit();
  await settle();
  app.runDeferred();

  expect(runtime.status().state).toBe("failed");
  expect(app.record.exited).toBe(true);
});

test("a stopped runtime does not hold the quit back", () => {
  const stopped = fakeApp();
  stopRuntimeOnQuit(stopped.host, createLocalRuntime(), stopped.defer);

  expect(stopped.emitWillQuit()).toBe(true);
  expect(stopped.deferred).toEqual([]);
});

test("a failed runtime runs its stop hook before the application quits", async () => {
  let stopCalls = 0;
  const app = fakeApp();
  const runtime = createLocalRuntime({
    hooks: {
      start: () => Promise.reject(new Error("no")),
      stop: () => {
        stopCalls += 1;
        return Promise.resolve();
      },
    },
  });
  await runtime.start();
  stopRuntimeOnQuit(app.host, runtime, app.defer);

  expect(app.emitWillQuit()).toBe(false);
  await settle();
  app.runDeferred();

  expect(stopCalls).toBe(1);
  expect(runtime.status().state).toBe("stopped");
  expect(app.record.quitCalls).toBe(1);
  expect(app.record.exited).toBe(true);
});

test("a quit during starting waits for the start, then stops and quits", async () => {
  let resolveStart: () => void = () => undefined;
  const app = fakeApp();
  const runtime = createLocalRuntime({
    hooks: {
      start: () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
      stop: () => Promise.resolve(),
    },
  });
  stopRuntimeOnQuit(app.host, runtime, app.defer);
  const started = runtime.start();
  await settle();

  expect(app.emitWillQuit()).toBe(false);
  resolveStart();
  await started;
  await settle();
  app.runDeferred();

  expect(runtime.status().state).toBe("stopped");
  expect(app.record.exited).toBe(true);
});
