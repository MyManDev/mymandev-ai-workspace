import {
  type JoinRequestId,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  OWN_JOIN_REQUEST_DECISIONS,
  type WorkspaceId,
} from "@mymandev/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  OWN_JOIN_REQUEST_LIMITS,
  OWN_JOIN_REQUEST_LOAD_REFUSALS,
  OWN_JOIN_REQUEST_OUTCOMES,
  OWN_JOIN_REQUEST_STATUSES,
  OwnJoinRequestsViewSchema,
  WORKSPACE_PROBLEMS,
  type OwnJoinRequestLoadResult,
  type OwnJoinRequestsView,
} from "../shared/ipc-contract.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import {
  OWN_JOIN_REQUEST_PUBLISH_INTERVAL_MS,
  ownJoinRequestsView,
  registerOwnJoinRequestIpc,
} from "./own-join-request-ipc.ts";
import type {
  OwnJoinRequestListState,
  OwnJoinRequestLoadOutcome,
  OwnJoinRequestOutcome,
  OwnJoinRequestState,
} from "./own-join-requests/service.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OTHER_WORKSPACE = id(0xa2) as WorkspaceId;
const FIRST = id(0xf1) as JoinRequestId;
const SECOND = id(0xf2) as JoinRequestId;
const EXPIRED = id(0xf3) as JoinRequestId;
const ENDED = id(0xf4) as JoinRequestId;
const AT = "2026-11-05T10:00:00.000Z";
const DECIDED_AT = "2026-11-06T09:00:00.000Z";
const NOW = Date.parse("2026-11-06T10:00:00.000Z");
const EXPIRES_AT = "2026-11-12T10:00:00.000Z";

function request(
  joinRequestId: JoinRequestId,
  overrides: Partial<OwnJoinRequestState> = {},
): OwnJoinRequestState {
  return Object.freeze({
    id: joinRequestId,
    workspaceId: WORKSPACE,
    requestedDisplayName: "Linus Requester",
    createdAt: AT,
    expiresAt: EXPIRES_AT,
    decision: null,
    decidedAt: null,
    ...overrides,
  });
}

function listState(
  overrides: Partial<OwnJoinRequestListState> = {},
): OwnJoinRequestListState {
  return Object.freeze({
    revision: 4,
    status: "ready",
    requests: Object.freeze([
      request(FIRST),
      request(SECOND, {
        workspaceId: OTHER_WORKSPACE,
        requestedDisplayName: "Grace Requester",
        decision: "denied",
        decidedAt: DECIDED_AT,
      }),
    ]),
    ...overrides,
  });
}

/** The own join request service, as the test sets it. */
function fakeService() {
  let state = listState();
  const listeners = new Set<(state: OwnJoinRequestListState) => void>();
  const loads: OwnJoinRequestLoadOutcome[] = [
    { outcome: "loading" },
    { outcome: "refused", reason: "too_soon" },
  ];
  let loaded = 0;
  return {
    ownJoinRequests: {
      state: () => state,
      onChange: (listener: (state: OwnJoinRequestListState) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      load: () => loads[loaded++] ?? { outcome: "loading" as const },
    },
    loads: () => loaded,
    listeners: () => listeners.size,
    set(next: Partial<OwnJoinRequestListState>) {
      state = listState(next);
    },
    fire() {
      for (const listener of [...listeners]) {
        listener(state);
      }
    },
  };
}

function frame(url: string, parent: IpcFrame | null = null): IpcFrame {
  return { url, parent, detached: false, isDestroyed: () => false };
}

function receiver(url: string = DEV_URL) {
  const sent: unknown[][] = [];
  const caller: StatusReceiver & { sent: unknown[][] } = {
    sent,
    mainFrame: frame(url),
    isDestroyed: () => false,
    send: (channel, ...args) => {
      sent.push([channel, ...args]);
    },
    once: () => undefined,
  };
  return caller;
}

function event(sender: StatusReceiver, senderFrame: IpcFrame | null) {
  return { senderFrame, sender } satisfies IpcInvokeEvent;
}

function fakeTimers() {
  const timers: { delayMs: number; callback: () => void; active: boolean }[] =
    [];
  return {
    schedule: (callback: () => void, delayMs: number) => {
      const timer = { delayMs, callback, active: true };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
    pending: () => timers.filter((timer) => timer.active),
    fire() {
      for (const timer of timers.filter((entry) => entry.active)) {
        timer.active = false;
        timer.callback();
      }
    },
  };
}

function register(
  fake = fakeService(),
  appUrl: string = DEV_URL,
  reports: "recorded" | "default" = "recorded",
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const timers = fakeTimers();
  // Every argument of every report, so that an error passed on shows.
  const errors: unknown[][] = [];
  const ipc = registerOwnJoinRequestIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      ownJoinRequests: fake.ownJoinRequests,
      scheduleTimer: timers.schedule,
      now: () => NOW,
      ...(reports === "recorded"
        ? { onError: (...args: unknown[]) => errors.push(args) }
        : {}),
    },
  );
  const call = <T>(channel: string, caller = receiver(appUrl)): T => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}.`);
    }
    return handler(event(caller, frame(appUrl))) as T;
  };
  return { handlers, call, timers, errors, ipc, fake };
}

test("the own join request state channels are registered, and nothing else", () => {
  const { handlers } = register();
  expect([...handlers.keys()].sort()).toEqual(
    [
      INVOKE_CHANNELS.getOwnJoinRequestState,
      INVOKE_CHANNELS.subscribeOwnJoinRequestState,
      INVOKE_CHANNELS.loadOwnJoinRequests,
    ].sort(),
  );
});

test("every handler refuses a foreign sender and any argument, before the service is asked", () => {
  const fake = fakeService();
  const { handlers } = register(fake, APP_ENTRY_URL);
  for (const [channel, handler] of handlers) {
    for (const sender of [
      null,
      frame("https://example.invalid/"),
      frame(APP_ENTRY_URL, frame(APP_ENTRY_URL)),
    ]) {
      expect(() => handler(event(receiver(APP_ENTRY_URL), sender))).toThrow(
        `The call on ${channel} was refused: the sender is not the application.`,
      );
    }
    for (const args of [[WORKSPACE], [undefined], [{}]]) {
      expect(() =>
        handler(event(receiver(APP_ENTRY_URL), frame(APP_ENTRY_URL)), ...args),
      ).toThrow(
        `The call on ${channel} was refused: the arguments do not match the contract.`,
      );
    }
  }
  expect(fake.loads()).toBe(0);
});

test("the view holds each request's ID, its workspace's ID, the requested name, its times, and how it ended, with the view's own revision", () => {
  const view = ownJoinRequestsView(listState(), 7, NOW);
  expect(view).toEqual({
    revision: 7,
    status: "ready",
    requests: [
      {
        joinRequestId: FIRST,
        workspaceId: WORKSPACE,
        requestedName: "Linus Requester",
        createdAt: AT,
        expiresAt: EXPIRES_AT,
        decision: null,
        decidedAt: null,
      },
      {
        joinRequestId: SECOND,
        workspaceId: OTHER_WORKSPACE,
        requestedName: "Grace Requester",
        createdAt: AT,
        expiresAt: EXPIRES_AT,
        decision: "denied",
        decidedAt: DECIDED_AT,
      },
    ],
  });
  expect(OwnJoinRequestsViewSchema.safeParse(view).success).toBe(true);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.requests)).toBe(true);
  expect(Object.isFrozen(view.requests[0])).toBe(true);
});

test("a pending request past its expiry crosses as expired, decided at its expiry, an ended one as it is, a long name is cut in characters, and the list holds at most its limit", () => {
  const face = "\u{1F600}";
  const view = ownJoinRequestsView(
    listState({
      requests: [
        request(FIRST, {
          requestedDisplayName: face.repeat(
            OWN_JOIN_REQUEST_LIMITS.displayName + 5,
          ),
        }),
        request(EXPIRED, { expiresAt: new Date(NOW).toISOString() }),
        request(SECOND, { expiresAt: new Date(NOW + 1).toISOString() }),
        request(ENDED, {
          expiresAt: AT,
          decision: "withdrawn",
          decidedAt: AT,
        }),
      ],
    }),
    1,
    NOW,
  );
  expect(
    view.requests.map((entry) => [
      entry.joinRequestId,
      entry.decision,
      entry.decidedAt,
    ]),
  ).toEqual([
    [FIRST, null, null],
    [EXPIRED, "expired", new Date(NOW).toISOString()],
    [SECOND, null, null],
    [ENDED, "withdrawn", AT],
  ]);
  expect(Object.isFrozen(view.requests[1])).toBe(true);
  expect(view.requests[0]?.requestedName).toBe(
    face.repeat(OWN_JOIN_REQUEST_LIMITS.displayName),
  );
  expect(OwnJoinRequestsViewSchema.safeParse(view).success).toBe(true);

  const many = Array.from(
    { length: OWN_JOIN_REQUEST_LIMITS.requests + 3 },
    (_, index) => request(id(0x1000 + index) as JoinRequestId),
  );
  const full = ownJoinRequestsView(listState({ requests: many }), 1, NOW);
  expect(full.requests).toHaveLength(OWN_JOIN_REQUEST_LIMITS.requests);
  // The most recent ones, which come first.
  expect(full.requests[0]?.joinRequestId).toBe(id(0x1000));
  expect(OwnJoinRequestsViewSchema.safeParse(full).success).toBe(true);
});

test("every status of the service crosses as it is, with the problem only while unavailable, and the contract's statuses, outcomes, and limits match the service and the protocol", () => {
  const statuses: OwnJoinRequestListState["status"][] = [
    "signed_out",
    "loading",
    "ready",
  ];
  expect([...statuses, "unavailable"].sort()).toEqual(
    [...OWN_JOIN_REQUEST_STATUSES].sort(),
  );
  for (const status of statuses) {
    const view = ownJoinRequestsView(
      listState({ status, requests: [] }),
      1,
      NOW,
    );
    expect(view).toEqual({ revision: 1, status, requests: [] });
  }
  for (const problem of WORKSPACE_PROBLEMS) {
    const view = ownJoinRequestsView(
      listState({ status: "unavailable", problem }),
      1,
      NOW,
    );
    expect(view).toMatchObject({ status: "unavailable", problem });
    expect(view.requests).toHaveLength(2);
    expect(OwnJoinRequestsViewSchema.safeParse(view).success).toBe(true);
  }
  expect([...OWN_JOIN_REQUEST_LOAD_REFUSALS].sort()).toEqual(
    ["not_signed_in", "too_soon"].sort(),
  );
  // The outcomes are the protocol's decisions of a requester.
  const outcomes: readonly OwnJoinRequestOutcome[] = OWN_JOIN_REQUEST_OUTCOMES;
  expect([...outcomes].sort()).toEqual([...OWN_JOIN_REQUEST_DECISIONS].sort());
  expect(OWN_JOIN_REQUEST_LIMITS.requests).toBe(MAX_ANSWER_LIST_ITEMS);
  expect(OWN_JOIN_REQUEST_LIMITS.displayName).toBe(LIMITS.displayName);
});

test("no user ID or other field of the service's state crosses", () => {
  const view = ownJoinRequestsView(
    listState({
      requests: [
        {
          ...request(FIRST),
          userId: id(0xb9),
          requesterDeviceId: id(0xd9),
          workspaceName: "Hidden workspace",
        } as OwnJoinRequestState,
      ],
    }),
    1,
    NOW,
  );
  const text = JSON.stringify(view);
  expect(text).not.toContain(id(0xb9));
  expect(text).not.toContain(id(0xd9));
  expect(text).not.toContain("Hidden workspace");
});

test("load passes the service's answer through, and get answers without subscribing the caller", () => {
  const { call } = register();
  expect(
    call<OwnJoinRequestLoadResult>(INVOKE_CHANNELS.loadOwnJoinRequests),
  ).toEqual({ outcome: "loading" });
  expect(
    call<OwnJoinRequestLoadResult>(INVOKE_CHANNELS.loadOwnJoinRequests),
  ).toEqual({ outcome: "refused", reason: "too_soon" });

  const fake = fakeService();
  const registered = register(fake);
  const caller = receiver();
  expect(
    registered.call<OwnJoinRequestsView>(
      INVOKE_CHANNELS.getOwnJoinRequestState,
      caller,
    ).requests,
  ).toHaveLength(2);
  fake.fire();
  registered.timers.fire();
  expect(caller.sent).toEqual([]);
});

test("a change raises the revision at once, and a burst publishes once, after the interval, with the latest view", () => {
  const fake = fakeService();
  const { call, timers } = register(fake);
  const caller = receiver();
  const first = call<OwnJoinRequestsView>(
    INVOKE_CHANNELS.subscribeOwnJoinRequestState,
    caller,
  );
  expect(first.revision).toBe(0);

  fake.set({ requests: [request(FIRST)] });
  fake.fire();
  fake.set({ requests: [request(SECOND)] });
  fake.fire();
  expect(caller.sent).toEqual([]);
  expect(timers.pending().map((timer) => timer.delayMs)).toEqual([
    OWN_JOIN_REQUEST_PUBLISH_INTERVAL_MS,
  ]);
  expect(
    call<OwnJoinRequestsView>(INVOKE_CHANNELS.getOwnJoinRequestState).revision,
  ).toBeGreaterThan(first.revision);

  timers.fire();
  expect(caller.sent).toHaveLength(1);
  const [channel, payload] = caller.sent[0] as [string, OwnJoinRequestsView];
  expect(channel).toBe(EVENT_CHANNELS.ownJoinRequestStateChanged);
  expect(payload.requests.map((entry) => entry.joinRequestId)).toEqual([
    SECOND,
  ]);
  expect(payload.revision).toBeGreaterThan(first.revision);
});

test("close cancels the waiting publish and stops listening", () => {
  const fake = fakeService();
  const { call, timers, ipc } = register(fake);
  const caller = receiver();
  call(INVOKE_CHANNELS.subscribeOwnJoinRequestState, caller);
  fake.fire();
  ipc.close();
  timers.fire();
  expect(caller.sent).toEqual([]);
  expect(fake.listeners()).toBe(0);
  expect(timers.pending()).toEqual([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("a view that the contract refuses is reported with a fixed message only, not sent, also by the default report", () => {
  const fake = fakeService();
  const { call, timers, errors } = register(fake);
  const caller = receiver();
  call(INVOKE_CHANNELS.subscribeOwnJoinRequestState, caller);
  fake.set({
    requests: [{ ...request(FIRST), id: "not-an-id" }],
  } as unknown as Partial<OwnJoinRequestListState>);
  fake.fire();
  timers.fire();
  expect(caller.sent).toEqual([]);
  // The message alone: never the error.
  expect(errors).toEqual([["Sending the own join requests failed."]]);

  const printed: unknown[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    printed.push(args);
  });
  const quiet = fakeService();
  const registered = register(quiet, DEV_URL, "default");
  registered.call(INVOKE_CHANNELS.subscribeOwnJoinRequestState, receiver());
  quiet.set({
    requests: [{ ...request(FIRST), id: "not-an-id" }],
  } as unknown as Partial<OwnJoinRequestListState>);
  quiet.fire();
  registered.timers.fire();
  expect(printed).toEqual([["Sending the own join requests failed."]]);
});
