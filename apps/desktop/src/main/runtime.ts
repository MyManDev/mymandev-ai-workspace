import type { RuntimeState, RuntimeStatus } from "../shared/ipc-contract.ts";

/**
 * The work of the local runtime. The runtime is a placeholder: it has no work
 * of its own yet, opens no network connection, and touches no file. Later
 * milestones add theirs here, for example agent execution (M3).
 */
export interface RuntimeHooks {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** Calls `callback` after `delayMs` milliseconds; the result cancels the call. */
export type ScheduleTimer = (
  callback: () => void,
  delayMs: number,
) => () => void;

export interface LocalRuntimeOptions {
  /** Defaults to `PLACEHOLDER_HOOKS`. */
  readonly hooks?: RuntimeHooks;
  /**
   * How long a hook may take before the runtime reports `failed`, so that a
   * hook that never settles cannot hold back the quit of the application.
   */
  readonly hookTimeoutMs?: number;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /**
   * Receives the errors of the hooks and of status listeners. An error that
   * it throws is ignored.
   */
  readonly onError?: (message: string, error: unknown) => void;
}

export interface LocalRuntime {
  /** The current status. */
  readonly status: () => RuntimeStatus;
  /**
   * Starts a runtime that is `stopped` or `failed`; otherwise changes nothing.
   * Settles with the status after the start, and never rejects.
   */
  readonly start: () => Promise<RuntimeStatus>;
  /**
   * Stops a runtime that is `running` or `failed`; otherwise changes nothing.
   * A `failed` runtime runs the stop hook too, so that a start that failed or
   * timed out can clean up. Settles with the status after the stop, and never
   * rejects.
   */
  readonly stop: () => Promise<RuntimeStatus>;
  /** Calls `listener` after every change. The result removes the listener. */
  readonly onStatusChange: (
    listener: (status: RuntimeStatus) => void,
  ) => () => void;
}

/** Hooks without work, for the placeholder runtime. */
export const PLACEHOLDER_HOOKS: RuntimeHooks = Object.freeze({
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
});

export const DEFAULT_HOOK_TIMEOUT_MS = 5000;

const scheduleWithSetTimeout: ScheduleTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/**
 * The local runtime of the main process. Its state moves through
 * `stopped`, `starting`, `running`, `stopping`, and back to `stopped`; a hook
 * that fails or times out moves it to `failed`, from which `start` and `stop`
 * are possible. Calls of `start` and `stop` run one after the other, in the
 * order they were made, so a `stop` during `starting` waits for the start and
 * then stops.
 */
export function createLocalRuntime(
  options: LocalRuntimeOptions = {},
): LocalRuntime {
  const hooks = options.hooks ?? PLACEHOLDER_HOOKS;
  const hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const scheduleTimer = options.scheduleTimer ?? scheduleWithSetTimeout;
  const onError = options.onError ?? (() => undefined);
  const report = (message: string, error: unknown): void => {
    try {
      onError(message, error);
    } catch {
      // A failing error handler must not stop a state change.
    }
  };
  const listeners = new Set<(status: RuntimeStatus) => void>();
  let status: RuntimeStatus = Object.freeze({ state: "stopped", revision: 0 });
  let queue: Promise<unknown> = Promise.resolve();

  function enter(state: RuntimeState): void {
    status = Object.freeze({ state, revision: status.revision + 1 });
    for (const listener of [...listeners]) {
      try {
        listener(status);
      } catch (error) {
        report("A runtime status listener failed.", error);
      }
    }
  }

  async function runHook(
    name: "start" | "stop",
    nextState: RuntimeState,
  ): Promise<void> {
    try {
      await withTimeout(() => hooks[name](), hookTimeoutMs, scheduleTimer);
      enter(nextState);
    } catch (error) {
      report(`The local runtime failed to ${name}.`, error);
      enter("failed");
    }
  }

  function enqueue(operation: () => Promise<void>): Promise<RuntimeStatus> {
    const run = queue.then(operation).then(
      () => status,
      (error: unknown) => {
        report("A local runtime operation failed.", error);
        return status;
      },
    );
    // The next operation runs whatever this one did.
    queue = run.catch(() => undefined);
    return run;
  }

  return Object.freeze({
    status: () => status,
    start: () =>
      enqueue(async () => {
        if (status.state === "stopped" || status.state === "failed") {
          enter("starting");
          await runHook("start", "running");
        }
      }),
    stop: () =>
      enqueue(async () => {
        if (status.state === "running" || status.state === "failed") {
          enter("stopping");
          await runHook("stop", "stopped");
        }
      }),
    onStatusChange: (listener: (status: RuntimeStatus) => void) => {
      const entry = (next: RuntimeStatus) => listener(next);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
  });
}

/** Calls `hook` and rejects when it has not settled after `timeoutMs`. */
function withTimeout(
  hook: () => Promise<void>,
  timeoutMs: number,
  scheduleTimer: ScheduleTimer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = scheduleTimer(() => {
      reject(new Error(`The hook did not settle within ${timeoutMs} ms.`));
    }, timeoutMs);
    Promise.resolve()
      .then(hook)
      .then(
        () => {
          cancel();
          resolve();
        },
        (error: unknown) => {
          cancel();
          reject(error);
        },
      );
  });
}
