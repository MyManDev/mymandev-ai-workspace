// The names of the IPC channels between the renderer and the main process.
// This module imports nothing, so the preload script can use the names without
// bundling zod. The schemas of every channel are in ipc-contract.ts.

/** Channels the renderer calls with `ipcRenderer.invoke`; the main process answers. */
export const INVOKE_CHANNELS = Object.freeze({
  /** The current status of the local runtime. */
  getRuntimeStatus: "runtime:get-status",
  /**
   * The current status of the local runtime. The calling frame then receives
   * every later status on `EVENT_CHANNELS.runtimeStatusChanged`.
   */
  subscribeRuntimeStatus: "runtime:subscribe-status",
  /** The mounted repositories. */
  listRepositories: "repositories:list",
  /**
   * The mounted repositories. The calling frame then receives every later
   * list on `EVENT_CHANNELS.repositoriesChanged`.
   */
  subscribeRepositories: "repositories:subscribe",
  /**
   * Opens the folder dialog of the main process and mounts the selected
   * repository. The renderer never sends a path.
   */
  mountRepository: "repositories:mount",
  /** Unmounts a repository by its mount ID. Nothing in the folder changes. */
  unmountRepository: "repositories:unmount",
} as const);

/** Channels the main process sends on with `webContents.send`. */
export const EVENT_CHANNELS = Object.freeze({
  /** The new status after every change, to the frames that subscribed. */
  runtimeStatusChanged: "runtime:status-changed",
  /** The mounted repositories after every change, to the frames that subscribed. */
  repositoriesChanged: "repositories:changed",
} as const);

export type InvokeChannel =
  (typeof INVOKE_CHANNELS)[keyof typeof INVOKE_CHANNELS];

export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS];
