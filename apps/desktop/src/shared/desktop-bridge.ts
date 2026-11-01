import type { RuntimeStatus } from "./ipc-contract.ts";

/**
 * What the preload script exposes to the renderer as `window.desktop`.
 *
 * The renderer runs sandboxed, with context isolation and without Node.js. It
 * reaches the main process only through this object, whose functions call the
 * channels of the IPC contract (`ipc-contract.ts`). It holds no `ipcRenderer`
 * and no function that takes a channel name. The preload script freezes it.
 */
export interface DesktopBridge {
  /** The Electron version the application runs on, for example "44.9.1". */
  readonly electronVersion: string;
  /** The local runtime in the main process. */
  readonly runtime: RuntimeBridge;
}

export interface RuntimeBridge {
  /** The current status of the local runtime. */
  readonly getStatus: () => Promise<RuntimeStatus>;
  /**
   * Calls `listener` with the current status and then after every change. A
   * status older than the last one delivered is dropped. `onError` is called
   * when the main process refuses the subscription. Returns a function that
   * ends the subscription.
   */
  readonly subscribeStatus: (
    listener: (status: RuntimeStatus) => void,
    onError?: () => void,
  ) => () => void;
}
