import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import {
  PROVIDER_CONNECTION_PUBLISH_INTERVAL_MS,
  providerConnectionListView,
  registerProviderConnectionIpc,
} from "./provider-connection-ipc.ts";
import type { ProviderConnectionsState } from "./provider-connections/service.ts";

// The provider connection channels of #32: the renderer reads this
// device's connections and registers and removes one through the main
// process, which checks the sender and every argument first. A
// registration carries a kind and a label only. A connection's API key
// (#33) goes from the renderer to the service once, and no result, event,
// or error ever carries it back.

const DEV_URL = "http://localhost:5173/";
const CONNECTION = "0192f0a0-7b3c-7d4e-8f50-000000000101";
const AT = "2026-11-24T09:00:00.000Z";
/** An obvious fake key; no result, event, or error may hold it. */
const SENTINEL_KEY = "FAKE-PROVIDER-KEY-SENTINEL-0123456789";

const ENTRY = Object.freeze({
  id: CONNECTION,
  kind: "claude",
  label: "Work laptop",
  createdAt: AT,
  status: "ready",
  model: "claude-sonnet-5-5",
}) as unknown as ProviderConnectionsState["connections"][number];

interface Timer {
  readonly callback: () => void;
  cancelled: boolean;
  fired: boolean;
}

function fakeService() {
  let state: ProviderConnectionsState = {
    revision: 0,
    status: "ready",
    connections: [ENTRY],
  };
  const listeners = new Set<(state: ProviderConnectionsState) => void>();
  const calls: unknown[][] = [];
  const timers: Timer[] = [];
  return {
    calls,
    timers,
    listeners,
    setState(next: ProviderConnectionsState) {
      state = next;
      for (const listener of [...listeners]) {
        listener(state);
      }
    },
    fire() {
      for (const timer of [...timers]) {
        if (!timer.cancelled && !timer.fired) {
          timer.fired = true;
          timer.callback();
        }
      }
    },
    options: {
      service: {
        state: () => state,
        onChange: (listener: (state: ProviderConnectionsState) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        register: (kind: string, label: string) => {
          calls.push(["register", kind, label]);
          return Promise.resolve({ outcome: "ok" as const });
        },
        remove: (id: string) => {
          calls.push(["remove", id]);
          return Promise.resolve({
            outcome: "refused" as const,
            reason: "rate_limited" as const,
            retryAfterMs: 30_000,
          });
        },
        saveKey: (id: string, key: string, model: string | null) => {
          calls.push(["saveKey", id, key, model]);
          return Promise.resolve({ outcome: "ok" as const });
        },
        setModel: (id: string, model: string) => {
          calls.push(["setModel", id, model]);
          return Promise.resolve({
            outcome: "refused" as const,
            reason: "credential_missing" as const,
            retryAfterMs: null,
          });
        },
        removeKey: (id: string) => {
          calls.push(["removeKey", id]);
          return Promise.resolve({
            outcome: "refused" as const,
            reason: "not_listed" as const,
            retryAfterMs: null,
          });
        },
      },
      scheduleTimer: (callback: () => void, delayMs: number) => {
        expect(delayMs).toBe(PROVIDER_CONNECTION_PUBLISH_INTERVAL_MS);
        const timer: Timer = { callback, cancelled: false, fired: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
  };
}

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

function register(
  fake: ReturnType<typeof fakeService>,
  appUrl: string = DEV_URL,
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const ipc = registerProviderConnectionIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    fake.options,
  );
  const call = (
    channel: string,
    args: unknown[] = [],
    sender: StatusReceiver = receiver(appUrl),
  ) => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}.`);
    }
    return handler(event(frame(appUrl), sender), ...args);
  };
  return { handlers, ipc, call };
}

test("the provider connection channels are registered, and nothing else", () => {
  const { handlers } = register(fakeService());
  expect([...handlers.keys()].sort()).toEqual(
    [
      INVOKE_CHANNELS.getProviderConnections,
      INVOKE_CHANNELS.subscribeProviderConnections,
      INVOKE_CHANNELS.registerProviderConnection,
      INVOKE_CHANNELS.removeProviderConnection,
      INVOKE_CHANNELS.saveProviderKey,
      INVOKE_CHANNELS.setProviderModel,
      INVOKE_CHANNELS.removeProviderKey,
    ].sort(),
  );
});

test("every handler refuses a foreign sender, and arguments outside the strict contract, before the service is asked", () => {
  const fake = fakeService();
  const { handlers } = register(fake, APP_ENTRY_URL);
  for (const [channel, handler] of handlers) {
    for (const sender of [
      null,
      frame("https://example.invalid/"),
      frame(APP_ENTRY_URL, frame(APP_ENTRY_URL)),
    ]) {
      expect(
        () => handler(event(sender), { kind: "claude", label: "Work" }),
        channel,
      ).toThrow(
        `The call on ${channel} was refused: the sender is not the application.`,
      );
    }
  }
  const request = { kind: "claude", label: "Work" };
  const refused: [string, unknown[]][] = [
    [INVOKE_CHANNELS.getProviderConnections, [CONNECTION]],
    [INVOKE_CHANNELS.subscribeProviderConnections, [{}]],
    [INVOKE_CHANNELS.registerProviderConnection, []],
    [INVOKE_CHANNELS.registerProviderConnection, ["claude", "Work"]],
    [INVOKE_CHANNELS.registerProviderConnection, [request, request]],
    [INVOKE_CHANNELS.registerProviderConnection, [{ kind: "claude" }]],
    [
      INVOKE_CHANNELS.registerProviderConnection,
      [{ ...request, kind: "gemini" }],
    ],
    [INVOKE_CHANNELS.registerProviderConnection, [{ ...request, label: "" }]],
    [
      INVOKE_CHANNELS.registerProviderConnection,
      [{ ...request, label: "x".repeat(65) }],
    ],
    [INVOKE_CHANNELS.registerProviderConnection, [{ ...request, label: 7 }]],
    // No credential, account, or device travels beside the kind and label.
    [
      INVOKE_CHANNELS.registerProviderConnection,
      [{ ...request, apiKey: "sk-ant-secret" }],
    ],
    [
      INVOKE_CHANNELS.registerProviderConnection,
      [{ ...request, token: "secret" }],
    ],
    [
      INVOKE_CHANNELS.registerProviderConnection,
      [{ ...request, deviceId: CONNECTION }],
    ],
    [INVOKE_CHANNELS.removeProviderConnection, []],
    [INVOKE_CHANNELS.removeProviderConnection, ["not-an-id"]],
    [INVOKE_CHANNELS.removeProviderConnection, [CONNECTION.toUpperCase()]],
    [INVOKE_CHANNELS.removeProviderConnection, [CONNECTION, CONNECTION]],
    [INVOKE_CHANNELS.removeProviderConnection, [{ id: CONNECTION }]],
  ];
  const keyRequest = {
    providerConnectionId: CONNECTION,
    key: SENTINEL_KEY,
    model: "claude-sonnet-5-5",
  };
  const modelRequest = {
    providerConnectionId: CONNECTION,
    model: "claude-sonnet-5-5",
  };
  const refusedKeys: [string, unknown[]][] = [
    [INVOKE_CHANNELS.saveProviderKey, []],
    [INVOKE_CHANNELS.saveProviderKey, [CONNECTION, SENTINEL_KEY]],
    [INVOKE_CHANNELS.saveProviderKey, [keyRequest, keyRequest]],
    [INVOKE_CHANNELS.saveProviderKey, [{ providerConnectionId: CONNECTION }]],
    [INVOKE_CHANNELS.saveProviderKey, [{ key: SENTINEL_KEY }]],
    // The model is always present: one of the closed list, or null (#30).
    [
      INVOKE_CHANNELS.saveProviderKey,
      [{ providerConnectionId: CONNECTION, key: SENTINEL_KEY }],
    ],
    [INVOKE_CHANNELS.saveProviderKey, [{ ...keyRequest, model: undefined }]],
    [INVOKE_CHANNELS.saveProviderKey, [{ ...keyRequest, model: "" }]],
    [
      INVOKE_CHANNELS.saveProviderKey,
      [{ ...keyRequest, model: "claude-opus-4-8" }],
    ],
    [
      INVOKE_CHANNELS.saveProviderKey,
      [{ ...keyRequest, model: "claude-opus-5-5-20260401" }],
    ],
    [
      INVOKE_CHANNELS.saveProviderKey,
      [{ ...keyRequest, model: "Claude Opus 5.5" }],
    ],
    [INVOKE_CHANNELS.saveProviderKey, [{ ...keyRequest, model: 7 }]],
    [
      INVOKE_CHANNELS.saveProviderKey,
      [{ ...keyRequest, model: ["claude-opus-5-5"] }],
    ],
    [INVOKE_CHANNELS.saveProviderKey, [{ ...keyRequest, key: "" }]],
    [INVOKE_CHANNELS.saveProviderKey, [{ ...keyRequest, key: 7 }]],
    [
      INVOKE_CHANNELS.saveProviderKey,
      [{ ...keyRequest, key: `${SENTINEL_KEY}${"x".repeat(512)}` }],
    ],
    [
      INVOKE_CHANNELS.saveProviderKey,
      [{ ...keyRequest, providerConnectionId: CONNECTION.toUpperCase() }],
    ],
    // Nothing travels beside the ID and the key.
    [INVOKE_CHANNELS.saveProviderKey, [{ ...keyRequest, kind: "claude" }]],
    [
      INVOKE_CHANNELS.saveProviderKey,
      [{ ...keyRequest, deviceId: CONNECTION }],
    ],
    [INVOKE_CHANNELS.setProviderModel, []],
    [INVOKE_CHANNELS.setProviderModel, [CONNECTION, "claude-opus-5-5"]],
    [INVOKE_CHANNELS.setProviderModel, [modelRequest, modelRequest]],
    [INVOKE_CHANNELS.setProviderModel, [{ providerConnectionId: CONNECTION }]],
    [INVOKE_CHANNELS.setProviderModel, [{ model: "claude-opus-5-5" }]],
    // A model is set, never taken away, and only one of the closed list.
    [INVOKE_CHANNELS.setProviderModel, [{ ...modelRequest, model: null }]],
    [INVOKE_CHANNELS.setProviderModel, [{ ...modelRequest, model: "" }]],
    [
      INVOKE_CHANNELS.setProviderModel,
      [{ ...modelRequest, model: "claude-opus-4-8" }],
    ],
    [INVOKE_CHANNELS.setProviderModel, [{ ...modelRequest, model: "gpt-5" }]],
    [
      INVOKE_CHANNELS.setProviderModel,
      [{ ...modelRequest, providerConnectionId: "not-an-id" }],
    ],
    // The key never travels with a model change.
    [INVOKE_CHANNELS.setProviderModel, [keyRequest]],
    [INVOKE_CHANNELS.setProviderModel, [{ ...modelRequest, kind: "claude" }]],
    [INVOKE_CHANNELS.removeProviderKey, []],
    [INVOKE_CHANNELS.removeProviderKey, ["not-an-id"]],
    [INVOKE_CHANNELS.removeProviderKey, [CONNECTION, SENTINEL_KEY]],
    [INVOKE_CHANNELS.removeProviderKey, [keyRequest]],
  ];
  for (const [channel, args] of [...refused, ...refusedKeys]) {
    const handler = handlers.get(channel)!;
    let thrown: unknown;
    try {
      handler(event(frame(APP_ENTRY_URL)), ...args);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `${channel} ${JSON.stringify(args)}`).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      `The call on ${channel} was refused: the arguments do not match the contract.`,
    );
    // The refusal never names the key it refused.
    expect(String(thrown)).not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(thrown)).not.toContain(SENTINEL_KEY);
    expect((thrown as Error).stack ?? "").not.toContain(SENTINEL_KEY);
    expect((thrown as Error).cause).toBeUndefined();
  }
  expect(fake.calls).toEqual([]);
});

test("a key reaches the service once with the connection's ID, and no result, state, or event ever carries it back", async () => {
  const fake = fakeService();
  const { call } = register(fake);
  const subscriber = receiver(DEV_URL);
  call(INVOKE_CHANNELS.subscribeProviderConnections, [], subscriber);
  const saved = await call(INVOKE_CHANNELS.saveProviderKey, [
    {
      providerConnectionId: CONNECTION,
      key: SENTINEL_KEY,
      model: "claude-sonnet-5-5",
    },
  ]);
  expect(saved).toEqual({ outcome: "ok" });
  const codexSaved = await call(INVOKE_CHANNELS.saveProviderKey, [
    { providerConnectionId: CONNECTION, key: SENTINEL_KEY, model: null },
  ]);
  expect(codexSaved).toEqual({ outcome: "ok" });
  const modelSet = await call(INVOKE_CHANNELS.setProviderModel, [
    { providerConnectionId: CONNECTION, model: "claude-haiku-5-5" },
  ]);
  expect(modelSet).toEqual({
    outcome: "refused",
    reason: "credential_missing",
    retryAfterMs: null,
  });
  expect(await call(INVOKE_CHANNELS.removeProviderKey, [CONNECTION])).toEqual({
    outcome: "refused",
    reason: "not_listed",
    retryAfterMs: null,
  });
  expect(fake.calls).toEqual([
    ["saveKey", CONNECTION, SENTINEL_KEY, "claude-sonnet-5-5"],
    ["saveKey", CONNECTION, SENTINEL_KEY, null],
    ["setModel", CONNECTION, "claude-haiku-5-5"],
    ["removeKey", CONNECTION],
  ]);

  // A service that leaked the key into its result is cut to the contract.
  fake.options.service.saveKey = () =>
    Promise.resolve({ outcome: "ok", key: SENTINEL_KEY } as unknown as {
      outcome: "ok";
    });
  const leaked = await call(INVOKE_CHANNELS.saveProviderKey, [
    { providerConnectionId: CONNECTION, key: SENTINEL_KEY, model: null },
  ]);
  expect(leaked).toEqual({ outcome: "ok" });
  fake.options.service.setModel = () =>
    Promise.resolve({ outcome: "ok", key: SENTINEL_KEY } as unknown as {
      outcome: "refused";
      reason: "credential_missing";
      retryAfterMs: null;
    });
  const leakedModel = await call(INVOKE_CHANNELS.setProviderModel, [
    { providerConnectionId: CONNECTION, model: "claude-opus-5-5" },
  ]);
  expect(leakedModel).toEqual({ outcome: "ok" });

  fake.setState({ revision: 1, status: "ready", connections: [ENTRY] });
  fake.fire();
  // The model crosses with the connection; it is not secret.
  expect(call(INVOKE_CHANNELS.getProviderConnections)).toMatchObject({
    connections: [{ id: CONNECTION, model: "claude-sonnet-5-5" }],
  });
  const crossed = JSON.stringify([
    saved,
    codexSaved,
    modelSet,
    leaked,
    leakedModel,
    subscriber.sent,
    call(INVOKE_CHANNELS.getProviderConnections),
  ]);
  expect(crossed).not.toContain(SENTINEL_KEY);
});

test("a key action that the service refused as busy crosses as that refusal", async () => {
  const fake = fakeService();
  const busy = {
    outcome: "refused" as const,
    reason: "busy" as const,
    retryAfterMs: null,
  };
  // The fake's types name its default answers only.
  fake.options.service.saveKey = () =>
    Promise.resolve(busy as unknown as { outcome: "ok" });
  fake.options.service.removeKey = () =>
    Promise.resolve(
      busy as unknown as {
        outcome: "refused";
        reason: "not_listed";
        retryAfterMs: null;
      },
    );
  const { call } = register(fake);
  expect(
    await call(INVOKE_CHANNELS.saveProviderKey, [
      { providerConnectionId: CONNECTION, key: SENTINEL_KEY, model: null },
    ]),
  ).toEqual(busy);
  expect(await call(INVOKE_CHANNELS.removeProviderKey, [CONNECTION])).toEqual(
    busy,
  );
});

test("a registration and a removal reach the service with their values only, and their results are parsed", async () => {
  const fake = fakeService();
  const { call } = register(fake);
  expect(
    await call(INVOKE_CHANNELS.registerProviderConnection, [
      { kind: "codex", label: " Personal " },
    ]),
  ).toEqual({ outcome: "ok" });
  expect(
    await call(INVOKE_CHANNELS.removeProviderConnection, [CONNECTION]),
  ).toEqual({
    outcome: "refused",
    reason: "rate_limited",
    retryAfterMs: 30_000,
  });
  expect(fake.calls).toEqual([
    ["register", "codex", " Personal "],
    ["remove", CONNECTION],
  ]);
});

test("a result outside the contract is refused, not passed on", async () => {
  const fake = fakeService();
  fake.options.service.register = () =>
    Promise.resolve({
      outcome: "ok",
      credential: "sk-ant-secret",
    } as unknown as { outcome: "ok" });
  const { call } = register(fake);
  const answer = (await call(INVOKE_CHANNELS.registerProviderConnection, [
    { kind: "claude", label: "Work" },
  ])) as Record<string, unknown>;
  // The contract's objects drop unknown keys: the credential never crosses.
  expect(answer).toEqual({ outcome: "ok" });
});

test("the view holds the ID, kind, label, time, and status of each connection only, and a problem only while unavailable", () => {
  const leaky = {
    ...ENTRY,
    deviceId: "0192f0a0-7b3c-7d4e-8f50-000000000004",
    userId: "0192f0a0-7b3c-7d4e-8f50-000000000005",
    credential: "sk-ant-secret",
  };
  const view = providerConnectionListView(
    { revision: 3, status: "ready", connections: [leaky] },
    7,
  );
  expect(view).toEqual({
    revision: 7,
    status: "ready",
    connections: [ENTRY],
  });
  expect(JSON.stringify(view)).not.toMatch(/deviceId|userId|credential|sk-/u);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.connections[0])).toBe(true);
  expect(
    providerConnectionListView(
      {
        revision: 3,
        status: "unavailable",
        problem: "not_found",
        connections: [{ ...ENTRY, status: "unknown" }],
      },
      8,
    ),
  ).toEqual({
    revision: 8,
    status: "unavailable",
    problem: "failed",
    connections: [{ ...ENTRY, status: "unknown" }],
  });
});

test("a subscribed frame gets the connections after each burst of changes, with a higher revision, until the IPC closes", () => {
  const fake = fakeService();
  const { call, ipc } = register(fake);
  const subscriber = receiver(DEV_URL);
  expect(
    call(INVOKE_CHANNELS.subscribeProviderConnections, [], subscriber),
  ).toEqual({ revision: 0, status: "ready", connections: [ENTRY] });
  fake.setState({ revision: 1, status: "loading", connections: [] });
  fake.setState({
    revision: 2,
    status: "ready",
    connections: [{ ...ENTRY, status: "unknown" }],
  });
  expect(subscriber.sent).toEqual([]);
  fake.fire();
  expect(subscriber.sent).toEqual([
    [
      EVENT_CHANNELS.providerConnectionsChanged,
      {
        revision: 2,
        status: "ready",
        connections: [{ ...ENTRY, status: "unknown" }],
      },
    ],
  ]);
  expect(call(INVOKE_CHANNELS.getProviderConnections)).toEqual({
    revision: 2,
    status: "ready",
    connections: [{ ...ENTRY, status: "unknown" }],
  });
  ipc.close();
  expect(fake.listeners.size).toBe(0);
  fake.fire();
  expect(subscriber.sent).toHaveLength(1);
});
