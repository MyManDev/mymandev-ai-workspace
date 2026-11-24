import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type {
  GrantRequestView,
  GrantsView,
  GrantView,
} from "../shared/ipc-contract.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import { GRANT_PUBLISH_INTERVAL_MS, registerGrantIpc } from "./grant-ipc.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import type { GrantsState } from "./permissions/grant-actions.ts";

// The grant channels of #342: the renderer reads the grants of the open
// project's agents and this device's provider connections, and grants and
// revokes through the main process, which checks the sender and every
// argument first.

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const PROJECT = id(0xe1);
const AGENT = id(0xf1);
const REPOSITORY = id(0x2001);
const GRANT = id(0x4001);
const AT = "2026-11-24T10:00:00.000Z";

const A_GRANT: GrantView = {
  id: GRANT,
  agentId: AGENT,
  capability: "repo.read",
  repositoryId: REPOSITORY,
  providerConnectionId: null,
  createdAt: AT,
  expiresAt: null,
  expired: false,
};

const REQUEST: GrantRequestView = {
  capability: "repo.read",
  scopeId: REPOSITORY,
  lifetimeSeconds: 3_600,
};

interface Timer {
  readonly callback: () => void;
  cancelled: boolean;
  fired: boolean;
}

function fakeService() {
  let state: GrantsState = { projectId: PROJECT, usable: true, grants: [] };
  const listeners = new Set<() => void>();
  const calls: unknown[][] = [];
  const timers: Timer[] = [];
  return {
    calls,
    timers,
    listeners,
    setState(next: GrantsState) {
      state = next;
      for (const listener of [...listeners]) {
        listener();
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
        onChange: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        listProviderConnections: () => {
          calls.push(["listProviderConnections"]);
          return Promise.resolve({ outcome: "ok" as const, connections: [] });
        },
        grant: (agentId: string, request: GrantRequestView) => {
          calls.push(["grant", agentId, request]);
          return Promise.resolve({ outcome: "ok" as const, grantId: GRANT });
        },
        revoke: (agentId: string, grantId: string) => {
          calls.push(["revoke", agentId, grantId]);
          return Promise.resolve({ outcome: "ok" as const });
        },
      },
      scheduleTimer: (callback: () => void, delayMs: number) => {
        expect(delayMs).toBe(GRANT_PUBLISH_INTERVAL_MS);
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
  const ipc = registerGrantIpc(
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

test("the grant channels are registered, and nothing else", () => {
  const { handlers } = register(fakeService());
  expect([...handlers.keys()].sort()).toEqual(
    [
      INVOKE_CHANNELS.getGrantState,
      INVOKE_CHANNELS.subscribeGrantState,
      INVOKE_CHANNELS.listProviderConnections,
      INVOKE_CHANNELS.grantCapability,
      INVOKE_CHANNELS.revokeGrant,
    ].sort(),
  );
});

test("every handler refuses a foreign sender and arguments outside the contract, before the service is asked", () => {
  const fake = fakeService();
  const { handlers } = register(fake, APP_ENTRY_URL);
  for (const [channel, handler] of handlers) {
    for (const sender of [
      null,
      frame("https://example.invalid/"),
      frame(APP_ENTRY_URL, frame(APP_ENTRY_URL)),
    ]) {
      expect(() => handler(event(sender)), channel).toThrow(
        `The call on ${channel} was refused: the sender is not the application.`,
      );
    }
  }
  const refused: [string, unknown[]][] = [
    [INVOKE_CHANNELS.getGrantState, [AGENT]],
    [INVOKE_CHANNELS.listProviderConnections, [AGENT]],
    [INVOKE_CHANNELS.grantCapability, [AGENT]],
    [INVOKE_CHANNELS.grantCapability, ["not-an-id", REQUEST]],
    [
      INVOKE_CHANNELS.grantCapability,
      [AGENT, { ...REQUEST, capability: "repo.admin" }],
    ],
    [INVOKE_CHANNELS.grantCapability, [AGENT, { ...REQUEST, scopeId: "../x" }]],
    [
      INVOKE_CHANNELS.grantCapability,
      [AGENT, { ...REQUEST, lifetimeSeconds: 0 }],
    ],
    [
      INVOKE_CHANNELS.grantCapability,
      [AGENT, { ...REQUEST, lifetimeSeconds: 1.5 }],
    ],
    [
      INVOKE_CHANNELS.grantCapability,
      [AGENT, { capability: "repo.read", scopeId: REPOSITORY }],
    ],
    [
      INVOKE_CHANNELS.grantCapability,
      [AGENT, { ...REQUEST, confirmedHighestRisk: false }],
    ],
    [INVOKE_CHANNELS.revokeGrant, [AGENT]],
    [INVOKE_CHANNELS.revokeGrant, [AGENT, GRANT.toUpperCase()]],
  ];
  for (const [channel, args] of refused) {
    const handler = handlers.get(channel)!;
    expect(
      () => handler(event(frame(APP_ENTRY_URL)), ...args),
      `${channel} ${JSON.stringify(args)}`,
    ).toThrow(
      `The call on ${channel} was refused: the arguments do not match the contract.`,
    );
  }
  expect(fake.calls).toEqual([]);
});

test("a grant, a revocation, and a read of the provider connections reach the service with their arguments, and their results are parsed", async () => {
  const fake = fakeService();
  const { call } = register(fake);
  expect(await call(INVOKE_CHANNELS.grantCapability, [AGENT, REQUEST])).toEqual(
    { outcome: "ok", grantId: GRANT },
  );
  expect(await call(INVOKE_CHANNELS.revokeGrant, [AGENT, GRANT])).toEqual({
    outcome: "ok",
  });
  expect(await call(INVOKE_CHANNELS.listProviderConnections)).toEqual({
    outcome: "ok",
    connections: [],
  });
  expect(fake.calls).toEqual([
    ["grant", AGENT, REQUEST],
    ["revoke", AGENT, GRANT],
    ["listProviderConnections"],
  ]);
});

test("a subscribed frame gets the grants after each burst of changes, with a higher revision, until the IPC closes", () => {
  const fake = fakeService();
  const { call, ipc } = register(fake);
  const subscriber = receiver(DEV_URL);
  const first = call(INVOKE_CHANNELS.subscribeGrantState, [], subscriber);
  expect(first).toEqual({
    revision: 0,
    projectId: PROJECT,
    usable: true,
    grants: [],
  });
  fake.setState({ projectId: PROJECT, usable: true, grants: [A_GRANT] });
  fake.setState({ projectId: PROJECT, usable: false, grants: [] });
  fake.setState({ projectId: PROJECT, usable: true, grants: [A_GRANT] });
  expect(subscriber.sent).toEqual([]);
  fake.fire();
  expect(subscriber.sent).toEqual([
    [
      EVENT_CHANNELS.grantStateChanged,
      { revision: 3, projectId: PROJECT, usable: true, grants: [A_GRANT] },
    ],
  ]);
  expect(call(INVOKE_CHANNELS.getGrantState) as GrantsView).toEqual({
    revision: 3,
    projectId: PROJECT,
    usable: true,
    grants: [A_GRANT],
  });
  ipc.close();
  expect(fake.listeners.size).toBe(0);
  fake.fire();
  expect(subscriber.sent).toHaveLength(1);
});
