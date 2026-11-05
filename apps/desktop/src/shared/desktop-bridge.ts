import type {
  AccountStatus,
  AgentActivityView,
  ConnectionStatus,
  ForgetResult,
  ListDevicesResult,
  MountResult,
  ReconnectResult,
  RemoveDeviceResult,
  RepositoryList,
  RuntimeStatus,
  SignOutResult,
  StartSignInOptions,
  StartSignInResult,
  UnlockResult,
  WorkspaceActionResult,
  WorkspaceView,
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
  /** The Electron version the application runs on, for example "45.0.0". */
  readonly electronVersion: string;
  /** The local runtime in the main process. */
  readonly runtime: RuntimeBridge;
  /** The repositories mounted on this device, read-only. */
  readonly repositories: RepositoryBridge;
  /** The sign-in of this installation. */
  readonly account: AccountBridge;
  /** The status of the connection to the cloud API. */
  readonly connection: ConnectionBridge;
  /** The account's workspaces, the selected one's projects, and the open project. */
  readonly workspaces: WorkspaceBridge;
  /** The agent activity of the open project, read-only. */
  readonly agents: AgentBridge;
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

/**
 * The sign-in and the device of this installation. The main process runs
 * them: the renderer gets the account, the pairing code, the device list,
 * and fixed codes, never a sign-in code, a verifier, a signature, a key, or
 * a token (ADR 0014).
 */
export interface AccountBridge {
  /** The current account status. */
  readonly getStatus: () => Promise<AccountStatus>;
  /**
   * Calls `listener` with the current status and then after every change. A
   * status older than the last one delivered is dropped. `onError` is called
   * when the main process refuses the subscription. Returns a function that
   * ends the subscription.
   */
  readonly subscribeStatus: (
    listener: (status: AccountStatus) => void,
    onError?: () => void,
  ) => () => void;
  /**
   * Starts a GitHub sign-in in the system browser. Call it only after the
   * person's action. With `{ browser: "other" }` the main process opens no
   * browser and offers the start address for copying into another one
   * (#175); the bridge passes on only that fixed choice, nothing else from
   * the renderer. The main process refuses a start within a few seconds of
   * the last one that opened the browser or offered its address
   * (`too_soon`).
   */
  readonly startSignIn: (
    options?: StartSignInOptions,
  ) => Promise<StartSignInResult>;
  /** Ends the open sign-in. Resolves to false when none was open. */
  readonly cancelSignIn: () => Promise<boolean>;
  /**
   * Loads a device key that a passphrase protects (Linux). The passphrase
   * goes to the main process and is never sent back.
   */
  readonly unlockDeviceKey: (passphrase: string) => Promise<UnlockResult>;
  /**
   * "This is not me": the main process asks the person to confirm in a
   * native dialog, removes the device at the API where it can, then deletes
   * the device key and the device record of this installation. Resolves to
   * `cancelled` when the person kept them.
   */
  readonly forgetAccount: () => Promise<ForgetResult>;
  /**
   * Signs out (P-65): the device and its key stay, and the next GitHub
   * sign-in is needed. Resolves to `pending` when the API learns it later.
   */
  readonly signOut: () => Promise<SignOutResult>;
  /**
   * Removes this device from its account: the main process asks the person
   * to confirm in a native dialog, and deletes the device key only after
   * the API confirmed. Resolves to `pending` while the API has not answered.
   */
  readonly removeDevice: () => Promise<RemoveDeviceResult>;
  /** The devices of the account; the device of this installation is marked. */
  readonly listDevices: () => Promise<ListDevicesResult>;
}

/**
 * The connection to the cloud API, which the main process keeps. The
 * renderer gets its status as fixed codes and can ask to connect again; it
 * never sees a frame, a nonce, a signature, or a key (ADR 0014).
 */
export interface ConnectionBridge {
  /** The current connection status. */
  readonly getStatus: () => Promise<ConnectionStatus>;
  /**
   * Calls `listener` with the current status and then after every change. A
   * status older than the last one delivered is dropped. `onError` is called
   * when the main process refuses the subscription. Returns a function that
   * ends the subscription.
   */
  readonly subscribeStatus: (
    listener: (status: ConnectionStatus) => void,
    onError?: () => void,
  ) => () => void;
  /**
   * Connects again at once, after the person's action: "Retry now" while
   * the connection waits, and "Reconnect here once" after another
   * installation took over the device's connection. It passes nothing from
   * the renderer on.
   */
  readonly reconnect: () => Promise<ReconnectResult>;
}

/**
 * The workspaces of the account, which the workspace service in the main
 * process holds. The renderer gets IDs, names, and fixed codes, and can
 * select a workspace or open a project; it never sees a member ID, a user
 * ID, or anything secret.
 */
export interface WorkspaceBridge {
  /** The current workspace state. */
  readonly getState: () => Promise<WorkspaceView>;
  /**
   * Calls `listener` with the current state and then after every change. A
   * state older than the last one delivered is dropped. `onError` is called
   * when the main process refuses the subscription. Returns a function that
   * ends the subscription.
   */
  readonly subscribeState: (
    listener: (state: WorkspaceView) => void,
    onError?: () => void,
  ) => () => void;
  /**
   * Selects a workspace of the list; the open project closes. Resolves to
   * `refused` with `not_found` for a workspace that the list does not hold,
   * and with `too_soon` beyond the main process's budget of switches to
   * another workspace (`WORKSPACE_SWITCH_BUDGET` per minute); selecting the
   * selected workspace is not counted. The main process accepts only a
   * lowercase UUIDv7.
   */
  readonly select: (workspaceId: string) => Promise<WorkspaceActionResult>;
  /**
   * Opens a project of the selected workspace, or closes the open one with
   * null. Resolves to `refused` with `not_found` for a project that the
   * selected workspace does not hold. The main process closes the open
   * project itself when a new page commits, also on a reload, when the page
   * fails to load, when the render process is gone, and when the window
   * closes.
   */
  readonly openProject: (
    projectId: string | null,
  ) => Promise<WorkspaceActionResult>;
}

/**
 * The agents and runs of the open project, which the main process holds.
 * The renderer reads them and changes nothing: an agent's owner comes as a
 * display name, never as a member ID, and nothing names a device. The
 * newest runs come, with a count of the unfinished ones left out.
 */
export interface AgentBridge {
  /** The current agent activity. */
  readonly getState: () => Promise<AgentActivityView>;
  /**
   * Calls `listener` with the current agent activity and then after
   * changes, at most once every 50 ms with the latest one. An activity
   * older than the last one delivered is dropped. `onError` is called when
   * the main process refuses the subscription. Returns a function that ends
   * the subscription.
   */
  readonly subscribeState: (
    listener: (state: AgentActivityView) => void,
    onError?: () => void,
  ) => () => void;
}
