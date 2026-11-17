/** A service or an IPC registration of the main process that ends at quit. */
export interface Closable {
  readonly close: () => void;
}

/** The part of Electron's `app` that `closeOnQuit` uses. */
export interface ClosingHost {
  on(event: "will-quit", listener: () => void): unknown;
}

/** The closables that `closeOnQuit` closes at quit. */
export interface QuitClosables {
  /**
   * Adds `closable`. At quit it closes before every closable that was added
   * earlier.
   */
  readonly add: (closable: Closable) => void;
}

/** The fixed text that reports a closable whose `close` threw. */
export const CLOSE_FAILED_MESSAGE =
  "A service of the main process failed to close at quit.";

/**
 * Closes the closables of the main process with one `will-quit` listener,
 * instead of one listener each, so that their number never reaches Node's
 * limit of listeners and the order is stated in one place (#304).
 *
 * At the first `will-quit` it closes each closable once, in the reverse order
 * of `add`. The entry point adds each service and each IPC registration
 * right after it creates them, so an IPC registration closes before its
 * service, and a service before the services that it uses, such as the
 * workspace service before the connection: none of them reacts to the close
 * of another. Each `close` runs in its own `try`, so that one that throws
 * does not skip the rest; it is reported with `CLOSE_FAILED_MESSAGE`. A later
 * `will-quit`, after the runtime held back the first one, closes nothing
 * again.
 *
 * The entry point registers it right after `stopRuntimeOnQuit`, so the
 * runtime's listener runs first at every `will-quit`: it holds back the first
 * quit and starts the runtime's stop, and the closables then close in the
 * same event, while the stop settles.
 */
export function closeOnQuit(
  host: ClosingHost,
  onError: (message: string, error: unknown) => void,
): QuitClosables {
  const closables: Closable[] = [];
  let closed = false;
  host.on("will-quit", () => {
    if (closed) {
      return;
    }
    closed = true;
    for (const closable of closables.toReversed()) {
      try {
        closable.close();
      } catch (error: unknown) {
        onError(CLOSE_FAILED_MESSAGE, error);
      }
    }
  });
  return Object.freeze({
    add: (closable: Closable) => {
      closables.push(closable);
    },
  });
}
