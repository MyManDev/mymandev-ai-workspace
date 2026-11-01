import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type InvokeChannel,
} from "../shared/ipc-channels.ts";
import {
  EVENT_CONTRACT,
  INVOKE_CONTRACT,
  type EventPayload,
  type InvokeArgs,
  type InvokeResult,
} from "../shared/ipc-contract.ts";
import { isAppNavigation } from "./navigation.ts";
import type { LocalRuntime } from "./runtime.ts";

/** The part of Electron's `WebFrameMain` that the sender check reads. */
export interface IpcFrame {
  readonly url: string;
  readonly parent: IpcFrame | null;
  readonly detached: boolean;
  isDestroyed(): boolean;
}

/** The part of Electron's `WebContents` that receives status events. */
export interface StatusReceiver {
  readonly mainFrame: IpcFrame;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once(event: "destroyed", listener: () => void): unknown;
}

/** The part of Electron's `IpcMainInvokeEvent` that the handlers read. */
export interface IpcInvokeEvent {
  readonly senderFrame: IpcFrame | null;
  readonly sender: StatusReceiver;
}

export type IpcInvokeListener = (
  event: IpcInvokeEvent,
  ...args: unknown[]
) => unknown;

/** The part of Electron's `ipcMain` that registers the handlers. */
export interface IpcRegistry {
  handle(channel: string, listener: IpcInvokeListener): void;
}

/**
 * True when `frame` belongs to the application: a main frame, not a
 * subframe, that is still attached and shows the application's URL by the
 * rules of the navigation guard (`isAppNavigation`). ADR 0014: the main
 * process validates the sender of every IPC message.
 */
export function isApplicationFrame(
  frame: IpcFrame | null | undefined,
  appUrl: string,
): boolean {
  if (frame === null || frame === undefined) {
    return false;
  }
  try {
    return (
      !frame.isDestroyed() &&
      !frame.detached &&
      frame.parent === null &&
      isAppNavigation(frame.url, appUrl)
    );
  } catch {
    // Electron throws when a frame that was disposed meanwhile is read.
    return false;
  }
}

/** The error a refused call rejects with in the renderer. */
export class IpcRefusedError extends Error {
  constructor(channel: string, reason: "sender" | "arguments") {
    super(
      reason === "sender"
        ? `The call on ${channel} was refused: the sender is not the application.`
        : `The call on ${channel} was refused: the arguments do not match the contract.`,
    );
    this.name = "IpcRefusedError";
  }
}

/**
 * The `ipcMain.handle` listener of an invoke channel. It refuses a sender
 * that is not the application and arguments that do not match the contract,
 * before `implementation` runs, and parses the result with the contract, so
 * no unknown key reaches the renderer. An implementation may return a
 * promise; its value is parsed the same way. Error messages never contain
 * the arguments.
 */
export function createInvokeHandler<C extends InvokeChannel>(
  channel: C,
  appUrl: string,
  implementation: (
    event: IpcInvokeEvent,
    args: InvokeArgs<C>,
  ) => InvokeResult<C> | Promise<InvokeResult<C>>,
): IpcInvokeListener {
  const contract = INVOKE_CONTRACT[channel];
  return (event, ...args) => {
    if (!isApplicationFrame(event.senderFrame, appUrl)) {
      throw new IpcRefusedError(channel, "sender");
    }
    const parsed = contract.args.safeParse(args);
    if (!parsed.success) {
      throw new IpcRefusedError(channel, "arguments");
    }
    const result = implementation(event, parsed.data as InvokeArgs<C>);
    return result instanceof Promise
      ? result.then((value) => contract.result.parse(value))
      : contract.result.parse(result);
  };
}

export interface EventPublisher<C extends EventChannel> {
  /** Sends later payloads to `receiver` until it is destroyed or leaves the application. */
  readonly add: (receiver: StatusReceiver) => void;
  /** Sends `payload` to every receiver whose main frame still shows the application. */
  readonly publish: (payload: EventPayload<C>) => void;
  /** The number of receivers. */
  readonly size: () => number;
}

export type StatusPublisher = EventPublisher<
  typeof EVENT_CHANNELS.runtimeStatusChanged
>;

export function createStatusPublisher(appUrl: string): StatusPublisher {
  return createEventPublisher(EVENT_CHANNELS.runtimeStatusChanged, appUrl);
}

/**
 * Sends the payloads of one event channel to the frames that subscribed.
 * Every payload is parsed with the contract first, so unknown keys never
 * reach the renderer.
 */
export function createEventPublisher<C extends EventChannel>(
  channel: C,
  appUrl: string,
): EventPublisher<C> {
  const receivers = new Set<StatusReceiver>();
  // Receivers that already have a "destroyed" listener. A receiver that
  // leaves the set and subscribes again, for example after a reload or a
  // renderer crash, gets no second listener.
  const watched = new WeakSet<StatusReceiver>();
  const schema = EVENT_CONTRACT[channel];
  return Object.freeze({
    add: (receiver: StatusReceiver) => {
      receivers.add(receiver);
      if (!watched.has(receiver)) {
        watched.add(receiver);
        receiver.once("destroyed", () => {
          receivers.delete(receiver);
        });
      }
    },
    publish: (value: EventPayload<C>) => {
      const payload = schema.parse(value);
      for (const receiver of receivers) {
        if (
          receiver.isDestroyed() ||
          !isApplicationFrame(receiver.mainFrame, appUrl)
        ) {
          // A page that shows the application subscribes again when it loads.
          receivers.delete(receiver);
          continue;
        }
        receiver.send(channel, payload);
      }
    },
    size: () => receivers.size,
  });
}

/**
 * Registers the handlers of the runtime channels and sends each status
 * change to the frames that subscribed. Call it before the first window
 * loads, so that the renderer's first call finds its handler.
 */
export function registerRuntimeIpc(
  ipc: IpcRegistry,
  appUrl: string,
  runtime: Pick<LocalRuntime, "status" | "onStatusChange">,
): void {
  const publisher = createStatusPublisher(appUrl);
  ipc.handle(
    INVOKE_CHANNELS.getRuntimeStatus,
    createInvokeHandler(INVOKE_CHANNELS.getRuntimeStatus, appUrl, () =>
      runtime.status(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeRuntimeStatus,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeRuntimeStatus,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return runtime.status();
      },
    ),
  );
  runtime.onStatusChange(publisher.publish);
}
