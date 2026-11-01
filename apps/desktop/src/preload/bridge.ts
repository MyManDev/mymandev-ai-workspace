import type {
  DesktopBridge,
  RepositoryBridge,
  RuntimeBridge,
} from "../shared/desktop-bridge.ts";
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type InvokeChannel,
} from "../shared/ipc-channels.ts";
import type {
  MountResult,
  RepositoryList,
  RuntimeStatus,
} from "../shared/ipc-contract.ts";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

/** The part of Electron's `ipcRenderer` that the bridge uses. */
export interface BridgeIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

type ReportError = (message: string, error: unknown) => void;

/**
 * A subscription to a value with a revision: `invokeChannel` answers with
 * the current value and subscribes the frame, and `eventChannel` carries
 * every later one. A value with a revision not above the last one delivered
 * is dropped, because the answer and an event can arrive in either order.
 */
function subscribeRevisions<T extends { readonly revision: number }>(
  ipc: BridgeIpc,
  invokeChannel: InvokeChannel,
  eventChannel: EventChannel,
  callbackFailure: string,
  reportError: ReportError,
  listener: (value: T) => void,
  onError: (() => void) | undefined,
): () => void {
  if (typeof listener !== "function") {
    throw new TypeError("A subscription needs a listener function.");
  }
  if (onError !== undefined && typeof onError !== "function") {
    throw new TypeError("onError must be a function.");
  }
  const call = (callback: () => void): void => {
    try {
      callback();
    } catch (error) {
      reportError(callbackFailure, error);
    }
  };
  let active = true;
  let lastRevision = -1;
  const deliver = (value: T) => {
    if (active && value.revision > lastRevision) {
      lastRevision = value.revision;
      call(() => listener(value));
    }
  };
  // The event object holds ipcRenderer and never reaches the renderer.
  const onChanged: IpcListener = (_event, value) => deliver(value as T);
  ipc.on(eventChannel, onChanged);
  ipc.invoke(invokeChannel).then(
    (value) => deliver(value as T),
    () => {
      if (active && onError !== undefined) {
        call(onError);
      }
    },
  );
  return () => {
    active = false;
    ipc.removeListener(eventChannel, onChanged);
  };
}

/**
 * The object the preload script exposes as `window.desktop`. Every function
 * calls one fixed channel of the IPC contract and passes no argument from
 * the renderer on to it, except the mount ID of `repositories.unmount`,
 * which must be a string and which the main process validates. Event
 * objects, which hold `ipcRenderer`, never reach the renderer. The object
 * and its parts are frozen. An error that a renderer callback throws goes
 * to `reportError` and stops nothing else.
 */
export function createDesktopBridge(
  electronVersion: string,
  ipc: BridgeIpc,
  reportError: ReportError = (message, error) => console.error(message, error),
): DesktopBridge {
  // The main process parses every value it sends with the contract.
  const runtime: RuntimeBridge = Object.freeze({
    getStatus: () =>
      ipc.invoke(INVOKE_CHANNELS.getRuntimeStatus) as Promise<RuntimeStatus>,
    subscribeStatus: (
      listener: (status: RuntimeStatus) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeRuntimeStatus,
        EVENT_CHANNELS.runtimeStatusChanged,
        "A runtime status callback failed.",
        reportError,
        listener,
        onError,
      ),
  });

  const repositories: RepositoryBridge = Object.freeze({
    list: () =>
      ipc.invoke(INVOKE_CHANNELS.listRepositories) as Promise<RepositoryList>,
    subscribe: (
      listener: (list: RepositoryList) => void,
      onError?: () => void,
    ) =>
      subscribeRevisions(
        ipc,
        INVOKE_CHANNELS.subscribeRepositories,
        EVENT_CHANNELS.repositoriesChanged,
        "A repository list callback failed.",
        reportError,
        listener,
        onError,
      ),
    mount: () =>
      ipc.invoke(INVOKE_CHANNELS.mountRepository) as Promise<MountResult>,
    unmount: (mountId: string) =>
      typeof mountId === "string"
        ? (ipc.invoke(
            INVOKE_CHANNELS.unmountRepository,
            mountId,
          ) as Promise<boolean>)
        : Promise.reject(new TypeError("unmount needs a mount ID string.")),
  });

  return Object.freeze({ electronVersion, runtime, repositories });
}
