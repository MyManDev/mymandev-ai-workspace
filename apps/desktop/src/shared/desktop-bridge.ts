import type {
  MountResult,
  RepositoryList,
  RuntimeStatus,
} from "./ipc-contract.ts";

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
  /** The repositories mounted on this device, read-only. */
  readonly repositories: RepositoryBridge;
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

export interface RepositoryBridge {
  /** The mounted repositories. */
  readonly list: () => Promise<RepositoryList>;
  /**
   * Calls `listener` with the mounted repositories and then after every
   * change, including a new status after a file change. A list older than
   * the last one delivered is dropped. `onError` is called when the main
   * process refuses the subscription. Returns a function that ends the
   * subscription.
   */
  readonly subscribe: (
    listener: (list: RepositoryList) => void,
    onError?: () => void,
  ) => () => void;
  /**
   * Opens the folder dialog of the main process and mounts the selected
   * repository. The renderer never passes a path.
   */
  readonly mount: () => Promise<MountResult>;
  /**
   * Unmounts a repository: it leaves the list and is no longer watched.
   * Nothing in the folder changes. Resolves to false when it was not mounted.
   */
  readonly unmount: (mountId: string) => Promise<boolean>;
}
