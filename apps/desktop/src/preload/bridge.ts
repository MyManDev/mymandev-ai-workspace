import type { DesktopBridge, RuntimeBridge } from "../shared/desktop-bridge.ts";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type { RuntimeStatus } from "../shared/ipc-contract.ts";

type IpcListener = (event: unknown, ...args: unknown[]) => void;

/** The part of Electron's `ipcRenderer` that the bridge uses. */
export interface BridgeIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

/**
 * The object the preload script exposes as `window.desktop`. Every function
 * calls one fixed channel of the IPC contract and passes no argument from
 * the renderer on to it. Event objects, which hold `ipcRenderer`, never reach
 * the renderer. The object and its parts are frozen. An error that a
 * renderer callback throws goes to `reportError` and stops nothing else.
 */
export function createDesktopBridge(
  electronVersion: string,
  ipc: BridgeIpc,
  reportError: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): DesktopBridge {
  const call = (callback: () => void): void => {
    try {
      callback();
    } catch (error) {
      reportError("A runtime status callback failed.", error);
    }
  };

  // The main process parses every value it sends with the contract.
  const getStatus = () =>
    ipc.invoke(INVOKE_CHANNELS.getRuntimeStatus) as Promise<RuntimeStatus>;

  const subscribeStatus = (
    listener: (status: RuntimeStatus) => void,
    onError?: () => void,
  ): (() => void) => {
    if (typeof listener !== "function") {
      throw new TypeError("subscribeStatus needs a listener function.");
    }
    if (onError !== undefined && typeof onError !== "function") {
      throw new TypeError("onError must be a function.");
    }
    let active = true;
    let lastRevision = -1;
    const deliver = (status: RuntimeStatus) => {
      if (active && status.revision > lastRevision) {
        lastRevision = status.revision;
        call(() => listener(status));
      }
    };
    const onChanged: IpcListener = (_event, status) =>
      deliver(status as RuntimeStatus);
    ipc.on(EVENT_CHANNELS.runtimeStatusChanged, onChanged);
    ipc.invoke(INVOKE_CHANNELS.subscribeRuntimeStatus).then(
      (status) => deliver(status as RuntimeStatus),
      () => {
        if (active && onError !== undefined) {
          call(onError);
        }
      },
    );
    return () => {
      active = false;
      ipc.removeListener(EVENT_CHANNELS.runtimeStatusChanged, onChanged);
    };
  };

  const runtime: RuntimeBridge = Object.freeze({ getStatus, subscribeStatus });
  return Object.freeze({ electronVersion, runtime });
}
