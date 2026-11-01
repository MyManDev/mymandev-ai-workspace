import { expect, test } from "vitest";
import type { RuntimeStatus } from "../shared/ipc-contract.ts";
import {
  createLocalRuntime,
  DEFAULT_HOOK_TIMEOUT_MS,
  type LocalRuntimeOptions,
  type RuntimeHooks,
  type ScheduleTimer,
} from "./runtime.ts";

/** A promise that the test settles. */
function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A timer that fires only when the test calls `fire`. */
function manualTimers() {
  const pending = new Map<number, { delayMs: number; callback: () => void }>();
  let next = 0;
  const schedule: ScheduleTimer = (callback, delayMs) => {
    const id = next++;
    pending.set(id, { delayMs, callback });
    return () => {
      pending.delete(id);
    };
  };
  return {
    schedule,
    pending: () => [...pending.values()].map((timer) => timer.delayMs),
    fire() {
      const timers = [...pending.values()];
      pending.clear();
      for (const timer of timers) {
        timer.callback();
      }
    },
  };
}

function observedRuntime(options: LocalRuntimeOptions = {}) {
  const errors: string[] = [];
  const timers = manualTimers();
  const runtime = createLocalRuntime({
    scheduleTimer: timers.schedule,
    onError: (message) => errors.push(message),
    ...options,
  });
  const seen: RuntimeStatus[] = [];
  runtime.onStatusChange((status) => seen.push(status));
  return { runtime, seen, errors, timers };
}

const states = (seen: readonly RuntimeStatus[]) =>
  seen.map((status) => status.state);

test("a new runtime is stopped at revision 0", () => {
  const { runtime, seen } = observedRuntime();

  expect(runtime.status()).toEqual({ state: "stopped", revision: 0 });
  expect(seen).toEqual([]);
});

test("start moves through starting to running, one revision per change", async () => {
  const { runtime, seen, errors } = observedRuntime();

  await expect(runtime.start()).resolves.toEqual({
    state: "running",
    revision: 2,
  });
  expect(seen).toEqual([
    { state: "starting", revision: 1 },
    { state: "running", revision: 2 },
  ]);
  expect(errors).toEqual([]);
});

test("the placeholder hooks settle at once and leave no timer behind", async () => {
  const { runtime, timers } = observedRuntime();

  await runtime.start();
  await runtime.stop();

  expect(runtime.status()).toEqual({ state: "stopped", revision: 4 });
  expect(timers.pending()).toEqual([]);
});

test("stop moves a running runtime through stopping to stopped", async () => {
  const { runtime, seen } = observedRuntime();
  await runtime.start();

  await expect(runtime.stop()).resolves.toEqual({
    state: "stopped",
    revision: 4,
  });
  expect(states(seen)).toEqual(["starting", "running", "stopping", "stopped"]);
});

test("a hook that rejects leaves the runtime failed and reports the error", async () => {
  const { runtime, seen, errors } = observedRuntime({
    hooks: {
      start: () => Promise.reject(new Error("no")),
      stop: () => Promise.resolve(),
    },
  });

  await expect(runtime.start()).resolves.toEqual({
    state: "failed",
    revision: 2,
  });
  expect(states(seen)).toEqual(["starting", "failed"]);
  expect(errors).toEqual(["The local runtime failed to start."]);
});

test("a hook that throws synchronously is a failure too", async () => {
  const { runtime, errors } = observedRuntime({
    hooks: {
      start: () => Promise.resolve(),
      stop: () => {
        throw new Error("no");
      },
    },
  });
  await runtime.start();

  await expect(runtime.stop()).resolves.toMatchObject({ state: "failed" });
  expect(errors).toEqual(["The local runtime failed to stop."]);
});

test("a stop hook that never settles fails after the timeout, so a quit cannot hang", async () => {
  const { runtime, seen, errors, timers } = observedRuntime({
    hooks: {
      start: () => Promise.resolve(),
      stop: () => new Promise<void>(() => undefined),
    },
    hookTimeoutMs: 250,
  });
  await runtime.start();

  const stopped = runtime.stop();
  await Promise.resolve();
  expect(timers.pending()).toEqual([250]);
  timers.fire();

  await expect(stopped).resolves.toEqual({ state: "failed", revision: 4 });
  expect(states(seen)).toEqual(["starting", "running", "stopping", "failed"]);
  expect(errors).toEqual(["The local runtime failed to stop."]);
});

test("the hook timeout defaults to five seconds", async () => {
  const { runtime, timers } = observedRuntime({
    hooks: {
      start: () => new Promise<void>(() => undefined),
      stop: () => Promise.resolve(),
    },
  });

  const started = runtime.start();
  await Promise.resolve();
  expect(timers.pending()).toEqual([DEFAULT_HOOK_TIMEOUT_MS]);
  expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(5000);
  timers.fire();

  await expect(started).resolves.toMatchObject({ state: "failed" });
});

test("start and stop that change nothing leave the status alone", async () => {
  const { runtime, seen } = observedRuntime();

  await expect(runtime.stop()).resolves.toEqual({
    state: "stopped",
    revision: 0,
  });
  await runtime.start();
  await expect(runtime.start()).resolves.toEqual({
    state: "running",
    revision: 2,
  });
  expect(seen).toHaveLength(2);
});

test("two starts at once run the start hook once", async () => {
  let calls = 0;
  const { runtime } = observedRuntime({
    hooks: {
      start: () => {
        calls += 1;
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
    },
  });

  await Promise.all([runtime.start(), runtime.start()]);

  expect(calls).toBe(1);
  expect(runtime.status()).toEqual({ state: "running", revision: 2 });
});

test("a stop during starting waits for the start and then stops", async () => {
  const startHook = deferred();
  const hooks: RuntimeHooks = {
    start: () => startHook.promise,
    stop: () => Promise.resolve(),
  };
  const { runtime, seen } = observedRuntime({ hooks });

  const started = runtime.start();
  const stopped = runtime.stop();
  await Promise.resolve();
  expect(runtime.status().state).toBe("starting");
  startHook.resolve();

  await expect(started).resolves.toMatchObject({ state: "running" });
  await expect(stopped).resolves.toEqual({ state: "stopped", revision: 4 });
  expect(states(seen)).toEqual(["starting", "running", "stopping", "stopped"]);
});

test("a failed runtime can start again", async () => {
  let attempts = 0;
  const { runtime } = observedRuntime({
    hooks: {
      start: () =>
        ++attempts === 1
          ? Promise.reject(new Error("first"))
          : Promise.resolve(),
      stop: () => Promise.resolve(),
    },
  });

  await expect(runtime.start()).resolves.toMatchObject({ state: "failed" });
  await expect(runtime.start()).resolves.toEqual({
    state: "running",
    revision: 4,
  });
});

test("a listener that throws does not stop the runtime or other listeners", async () => {
  const { runtime, seen, errors } = observedRuntime();
  runtime.onStatusChange(() => {
    throw new Error("listener");
  });
  const after: string[] = [];
  runtime.onStatusChange((status) => after.push(status.state));

  await expect(runtime.start()).resolves.toMatchObject({ state: "running" });
  expect(states(seen)).toEqual(["starting", "running"]);
  expect(after).toEqual(["starting", "running"]);
  expect(errors).toEqual([
    "A runtime status listener failed.",
    "A runtime status listener failed.",
  ]);
});

test("a removed listener receives nothing more", async () => {
  const runtime = createLocalRuntime();
  const seen: string[] = [];
  const remove = runtime.onStatusChange((status) => seen.push(status.state));

  await runtime.start();
  remove();
  await runtime.stop();

  expect(seen).toEqual(["starting", "running"]);
});

test("a status object is frozen", async () => {
  const runtime = createLocalRuntime();
  await runtime.start();

  expect(Object.isFrozen(runtime.status())).toBe(true);
  expect(Object.isFrozen(runtime)).toBe(true);
});

test("an error handler that throws neither blocks a state change nor the queue", async () => {
  let stopCalls = 0;
  const runtime = createLocalRuntime({
    hooks: {
      start: () => Promise.reject(new Error("start")),
      stop: () => {
        stopCalls += 1;
        return Promise.resolve();
      },
    },
    onError: () => {
      throw new Error("handler");
    },
  });
  runtime.onStatusChange(() => {
    throw new Error("listener");
  });

  await expect(runtime.start()).resolves.toEqual({
    state: "failed",
    revision: 2,
  });
  await expect(runtime.stop()).resolves.toEqual({
    state: "stopped",
    revision: 4,
  });
  await expect(runtime.start()).resolves.toMatchObject({ state: "failed" });
  expect(stopCalls).toBe(1);
});

test("a timer that throws fails the hook and keeps the queue alive", async () => {
  const errors: string[] = [];
  const runtime = createLocalRuntime({
    scheduleTimer: () => {
      throw new Error("no timers");
    },
    onError: (message) => errors.push(message),
  });

  await expect(runtime.start()).resolves.toMatchObject({ state: "failed" });
  await expect(runtime.stop()).resolves.toMatchObject({ state: "failed" });
  expect(errors).toEqual([
    "The local runtime failed to start.",
    "The local runtime failed to stop.",
  ]);
});

test("stop runs the stop hook of a runtime whose start failed", async () => {
  let stopCalls = 0;
  const { runtime, seen } = observedRuntime({
    hooks: {
      start: () => Promise.reject(new Error("no")),
      stop: () => {
        stopCalls += 1;
        return Promise.resolve();
      },
    },
  });
  await runtime.start();

  await expect(runtime.stop()).resolves.toEqual({
    state: "stopped",
    revision: 4,
  });
  expect(stopCalls).toBe(1);
  expect(states(seen)).toEqual(["starting", "failed", "stopping", "stopped"]);
});

test("stop runs the stop hook after a start that timed out", async () => {
  let stopCalls = 0;
  const { runtime, timers } = observedRuntime({
    hooks: {
      start: () => new Promise<void>(() => undefined),
      stop: () => {
        stopCalls += 1;
        return Promise.resolve();
      },
    },
  });
  const started = runtime.start();
  await Promise.resolve();
  timers.fire();
  await expect(started).resolves.toMatchObject({ state: "failed" });

  await expect(runtime.stop()).resolves.toMatchObject({ state: "stopped" });
  expect(stopCalls).toBe(1);
});

test("a failed runtime whose stop hook fails again stays failed", async () => {
  const { runtime, errors } = observedRuntime({
    hooks: {
      start: () => Promise.reject(new Error("start")),
      stop: () => Promise.reject(new Error("stop")),
    },
  });
  await runtime.start();

  await expect(runtime.stop()).resolves.toEqual({
    state: "failed",
    revision: 4,
  });
  expect(errors).toEqual([
    "The local runtime failed to start.",
    "The local runtime failed to stop.",
  ]);
});
