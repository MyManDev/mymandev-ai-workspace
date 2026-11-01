import type { LocalRuntime } from "./runtime.ts";

/** The part of Electron's `app` that ends the runtime with the application. */
export interface QuitHost {
  on(
    event: "will-quit",
    listener: (event: { preventDefault(): void }) => void,
  ): unknown;
  quit(): void;
}

/** Runs `callback` in a later task. */
export type Defer = (callback: () => void) => void;

const deferWithSetTimeout: Defer = (callback) => {
  setTimeout(callback, 0);
};

/**
 * Stops the runtime before the application quits. While the runtime is not
 * `stopped`, the first `will-quit` is held back until `stop` has settled, and
 * the application then quits again; a `failed` runtime is stopped too, so its
 * stop hook can clean up. Every later `will-quit` passes. The quit waits up
 * to about two hook timeouts: a start that is still running, then the stop.
 *
 * The second `quit` runs in a later task. When a quit starts outside
 * JavaScript, for example on SIGINT or SIGTERM, Electron runs the promise
 * callbacks of the listener before the `will-quit` event returns; a `quit`
 * from there is ignored, because Electron is still quitting, and the
 * application would stay open without a window.
 */
export function stopRuntimeOnQuit(
  host: QuitHost,
  runtime: Pick<LocalRuntime, "status" | "stop">,
  defer: Defer = deferWithSetTimeout,
): void {
  let phase: "running" | "stopping" | "stopped" = "running";
  host.on("will-quit", (event) => {
    const { state } = runtime.status();
    if (phase === "stopped" || state === "stopped") {
      return;
    }
    event.preventDefault();
    if (phase === "stopping") {
      return;
    }
    phase = "stopping";
    const quit = () => {
      phase = "stopped";
      defer(() => host.quit());
    };
    runtime.stop().then(quit, quit);
  });
}
