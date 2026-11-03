import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type {
  ConnectionStatus,
  ReconnectResult,
} from "../shared/ipc-contract.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import { registerConnectionIpc } from "./connection-ipc.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";

const DEV_URL = "http://localhost:5173/";

const WAITING: ConnectionStatus = Object.freeze({
  state: "waiting",
  reason: "connection_lost",
  retryAt: "2026-11-03T10:00:01.000Z",
  revision: 4,
});

function frame(url: string, parent: IpcFrame | null = null): IpcFrame {
  return { url, parent, detached: false, isDestroyed: () => false };
}

function receiver(url: string = DEV_URL) {
  const sent: unknown[][] = [];
  const value: StatusReceiver & { sent: unknown[][] } = {
    mainFrame: frame(url),
    sent,
    isDestroyed: () => false,
    send: (channel, ...args) => {
      sent.push([channel, ...args]);
    },
    once: () => undefined,
  };
  return value;
}

function event(
  senderFrame: IpcFrame | null,
  sender: StatusReceiver = receiver(),
): IpcInvokeEvent {
  return { senderFrame, sender };
}

/** A client that records its calls and answers fixed values. */
function fakeClient(
  status: unknown = WAITING,
  reconnect: unknown = { outcome: "reconnecting" },
) {
  const calls: string[] = [];
  const listeners: ((status: ConnectionStatus) => void)[] = [];
  return {
    calls,
    emit: (next: unknown) => {
      for (const listener of listeners) {
        listener(next as ConnectionStatus);
      }
    },
    client: {
      status: () => {
        calls.push("status");
        return status as ConnectionStatus;
      },
      onStatusChange: (listener: (status: ConnectionStatus) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      reconnect: () => {
        calls.push("reconnect");
        return reconnect as ReconnectResult;
      },
    },
  };
}

function register(
  fake: ReturnType<typeof fakeClient>,
  appUrl: string = DEV_URL,
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const errors: string[] = [];
  registerConnectionIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    fake.client,
    (message) => errors.push(message),
  );
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}.`);
    }
    return handler(event(frame(appUrl)), ...args);
  };
  return { handlers, errors, call };
}

test("the connection channels are registered, and nothing else", () => {
  const { handlers } = register(fakeClient());
  expect([...handlers.keys()].sort()).toEqual(
    [
      INVOKE_CHANNELS.getConnectionStatus,
      INVOKE_CHANNELS.subscribeConnectionStatus,
      INVOKE_CHANNELS.reconnect,
    ].sort(),
  );
});

test("the status and the reconnect result pass the contract, and unknown keys are dropped", () => {
  const fake = fakeClient(
    { ...WAITING, nonce: "secret", frame: "{}" },
    { outcome: "refused", reason: "too_soon", signature: "secret" },
  );
  const { call } = register(fake);

  expect(call(INVOKE_CHANNELS.getConnectionStatus)).toEqual(WAITING);
  expect(call(INVOKE_CHANNELS.reconnect)).toEqual({
    outcome: "refused",
    reason: "too_soon",
  });
  expect(fake.calls).toEqual(["status", "reconnect"]);
});

test("a status outside the contract is not sent", () => {
  const { call } = register(fakeClient({ state: "connected", revision: -1 }));
  expect(() => call(INVOKE_CHANNELS.getConnectionStatus)).toThrow();
  const other = register(fakeClient({ state: "waiting", revision: 1 }));
  expect(() => other.call(INVOKE_CHANNELS.getConnectionStatus)).toThrow();
});

test("every handler refuses a foreign sender and any argument, before the client is asked", () => {
  const fake = fakeClient();
  const { handlers } = register(fake, APP_ENTRY_URL);
  for (const [channel, handler] of handlers) {
    for (const sender of [
      null,
      frame("https://example.invalid/"),
      frame(APP_ENTRY_URL, frame(APP_ENTRY_URL)),
      frame(DEV_URL),
    ]) {
      expect(() => handler(event(sender)), channel).toThrow(
        `The call on ${channel} was refused: the sender is not the application.`,
      );
    }
    expect(() => handler(event(frame(APP_ENTRY_URL)), "now"), channel).toThrow(
      `The call on ${channel} was refused: the arguments do not match the contract.`,
    );
  }
  expect(fake.calls).toEqual([]);
});

test("a subscribed frame receives every later status, parsed by the contract", () => {
  const fake = fakeClient();
  const { handlers, errors } = register(fake);
  const subscriber = receiver();
  const subscribe = handlers.get(INVOKE_CHANNELS.subscribeConnectionStatus);
  expect(subscribe?.(event(frame(DEV_URL), subscriber))).toEqual(WAITING);

  fake.emit({ state: "connected", revision: 5, frame: "secret" });
  expect(subscriber.sent).toEqual([
    [
      EVENT_CHANNELS.connectionStatusChanged,
      { state: "connected", revision: 5 },
    ],
  ]);

  // A status that the contract refuses is reported, not sent.
  fake.emit({ state: "connected", revision: -1 });
  expect(subscriber.sent).toHaveLength(1);
  expect(errors).toEqual(["Sending the connection status failed."]);
});
