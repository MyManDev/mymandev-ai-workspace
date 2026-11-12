import {
  type JoinRequestId,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  type WorkspaceId,
} from "@mymandev/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  JOIN_REQUEST_LIMITS,
  JOIN_REQUEST_LOAD_REFUSALS,
  JOIN_REQUEST_STATUSES,
  JoinRequestsViewSchema,
  WORKSPACE_PROBLEMS,
  type JoinRequestLoadResult,
  type JoinRequestsView,
} from "../shared/ipc-contract.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import {
  JOIN_REQUEST_PUBLISH_INTERVAL_MS,
  joinRequestsView,
  registerJoinRequestIpc,
} from "./join-request-ipc.ts";
import {
  MAX_HELD_JOIN_REQUESTS,
  type BlockedJoinRequestState,
  type JoinRequestListState,
  type JoinRequestLoadOutcome,
  type PendingJoinRequestState,
} from "./join-requests/service.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const FIRST = id(0xf1) as JoinRequestId;
const SECOND = id(0xf2) as JoinRequestId;
const EXPIRED = id(0xf3) as JoinRequestId;
const BLOCKED = id(0xf4) as JoinRequestId;
const ERASED = id(0xf5) as JoinRequestId;
const AT = "2026-11-05T10:00:00.000Z";
const BLOCKED_AT = "2026-11-05T11:00:00.000Z";
const PAUSED_AT = "2026-11-05T12:00:00.000Z";
const ACCOUNT_CREATED_AT = "2020-01-02T03:04:05.000Z";
const NOW = Date.parse("2026-11-06T10:00:00.000Z");
const EXPIRES_AT = "2026-11-12T10:00:00.000Z";

const REQUESTER = Object.freeze({
  login: "linus",
  verifiedAt: AT,
  accountCreatedAt: ACCOUNT_CREATED_AT,
});

function pending(
  joinRequestId: JoinRequestId,
  overrides: Partial<PendingJoinRequestState> = {},
): PendingJoinRequestState {
  return Object.freeze({
    id: joinRequestId,
    requestedDisplayName: "Linus Requester",
    requester: REQUESTER,
    createdAt: AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  });
}

function blocked(
  joinRequestId: JoinRequestId,
  overrides: Partial<BlockedJoinRequestState> = {},
): BlockedJoinRequestState {
  return Object.freeze({
    id: joinRequestId,
    requestedDisplayName: "Grace Blocked",
    requester: REQUESTER,
    createdAt: AT,
    blockedAt: BLOCKED_AT,
    ...overrides,
  });
}

function listState(
  overrides: Partial<JoinRequestListState> = {},
): JoinRequestListState {
  return Object.freeze({
    revision: 4,
    status: "ready",
    workspaceId: WORKSPACE,
    pending: Object.freeze([pending(FIRST), pending(SECOND)]),
    blocked: Object.freeze([blocked(BLOCKED)]),
    pausedAt: PAUSED_AT,
    ...overrides,
  });
}

/** The join request service, as the test sets it. */
function fakeService() {
  let state = listState();
  const listeners = new Set<(state: JoinRequestListState) => void>();
  const loads: JoinRequestLoadOutcome[] = [
    { outcome: "loading" },
    { outcome: "refused", reason: "too_soon" },
  ];
  let loaded = 0;
  return {
    joinRequests: {
      state: () => state,
      onChange: (listener: (state: JoinRequestListState) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      load: () => loads[loaded++] ?? { outcome: "loading" as const },
    },
    loads: () => loaded,
    listeners: () => listeners.size,
    set(next: Partial<JoinRequestListState>) {
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
  const ipc = registerJoinRequestIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      joinRequests: fake.joinRequests,
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

test("the join request state channels are registered, and nothing else", () => {
  const { handlers } = register();
  expect([...handlers.keys()].sort()).toEqual(
    [
      INVOKE_CHANNELS.getJoinRequestState,
      INVOKE_CHANNELS.subscribeJoinRequestState,
      INVOKE_CHANNELS.loadJoinRequests,
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

test("the view holds each pending request's ID, requested name, login with its times, and times, each block with when it was blocked, and the pause, with the view's own revision", () => {
  const view = joinRequestsView(
    listState({
      blocked: [
        blocked(BLOCKED),
        blocked(ERASED, { requester: null, requestedDisplayName: "Gone" }),
      ],
    }),
    7,
    NOW,
  );
  expect(view).toEqual({
    revision: 7,
    status: "ready",
    workspaceId: WORKSPACE,
    pending: [FIRST, SECOND].map((joinRequestId) => ({
      joinRequestId,
      requestedName: "Linus Requester",
      login: "linus",
      verifiedAt: AT,
      accountCreatedAt: ACCOUNT_CREATED_AT,
      createdAt: AT,
      expiresAt: EXPIRES_AT,
    })),
    blocked: [
      {
        joinRequestId: BLOCKED,
        requestedName: "Grace Blocked",
        login: "linus",
        verifiedAt: AT,
        accountCreatedAt: ACCOUNT_CREATED_AT,
        createdAt: AT,
        blockedAt: BLOCKED_AT,
      },
      {
        joinRequestId: ERASED,
        requestedName: "Gone",
        login: null,
        verifiedAt: null,
        accountCreatedAt: null,
        createdAt: AT,
        blockedAt: BLOCKED_AT,
      },
    ],
    pausedAt: PAUSED_AT,
  });
  expect(JoinRequestsViewSchema.safeParse(view).success).toBe(true);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.pending)).toBe(true);
  expect(Object.isFrozen(view.pending[0])).toBe(true);
  expect(Object.isFrozen(view.blocked)).toBe(true);
  expect(Object.isFrozen(view.blocked[0])).toBe(true);
});

test("a pending request past its expiry is left out, a block never is, a long name is cut in characters, and each list holds at most its limit", () => {
  const face = "\u{1F600}";
  const view = joinRequestsView(
    listState({
      pending: [
        pending(FIRST, {
          requestedDisplayName: face.repeat(
            JOIN_REQUEST_LIMITS.displayName + 5,
          ),
        }),
        pending(EXPIRED, { expiresAt: new Date(NOW).toISOString() }),
        pending(SECOND, { expiresAt: new Date(NOW + 1).toISOString() }),
      ],
      blocked: [blocked(BLOCKED, { createdAt: "2020-01-01T00:00:00.000Z" })],
    }),
    1,
    NOW,
  );
  expect(view.pending.map((entry) => entry.joinRequestId)).toEqual([
    FIRST,
    SECOND,
  ]);
  expect(view.pending[0]?.requestedName).toBe(
    face.repeat(JOIN_REQUEST_LIMITS.displayName),
  );
  expect(view.blocked.map((entry) => entry.joinRequestId)).toEqual([BLOCKED]);
  expect(JoinRequestsViewSchema.safeParse(view).success).toBe(true);

  const many = Array.from({ length: JOIN_REQUEST_LIMITS.requests + 3 }, () =>
    pending(FIRST),
  );
  const blocks = Array.from({ length: JOIN_REQUEST_LIMITS.requests + 3 }, () =>
    blocked(BLOCKED),
  );
  const full = joinRequestsView(
    listState({ pending: many, blocked: blocks }),
    1,
    NOW,
  );
  expect(full.pending).toHaveLength(JOIN_REQUEST_LIMITS.requests);
  expect(full.blocked).toHaveLength(JOIN_REQUEST_LIMITS.requests);
  expect(JoinRequestsViewSchema.safeParse(full).success).toBe(true);
});

test("every status of the service crosses as it is, with the problem only while unavailable, and the contract's statuses and limits match the service and the protocol", () => {
  const statuses: JoinRequestListState["status"][] = [
    "signed_out",
    "no_workspace",
    "not_allowed",
    "loading",
    "ready",
  ];
  expect([...statuses, "unavailable"].sort()).toEqual(
    [...JOIN_REQUEST_STATUSES].sort(),
  );
  for (const status of statuses) {
    const view = joinRequestsView(
      listState({ status, pending: [], blocked: [], pausedAt: null }),
      1,
      NOW,
    );
    expect(view).toEqual({
      revision: 1,
      status,
      workspaceId: WORKSPACE,
      pending: [],
      blocked: [],
      pausedAt: null,
    });
  }
  for (const problem of WORKSPACE_PROBLEMS) {
    const view = joinRequestsView(
      listState({ status: "unavailable", problem }),
      1,
      NOW,
    );
    expect(view).toMatchObject({ status: "unavailable", problem });
    expect(view.pending).toHaveLength(2);
    expect(JoinRequestsViewSchema.safeParse(view).success).toBe(true);
  }
  expect([...JOIN_REQUEST_LOAD_REFUSALS].sort()).toEqual(
    ["no_workspace", "not_allowed", "not_signed_in", "too_soon"].sort(),
  );
  expect(JOIN_REQUEST_LIMITS.requests).toBe(MAX_ANSWER_LIST_ITEMS);
  expect(MAX_HELD_JOIN_REQUESTS).toBe(MAX_ANSWER_LIST_ITEMS);
  expect(JOIN_REQUEST_LIMITS.displayName).toBe(LIMITS.displayName);
});

test("no user ID or other field of the service's state crosses", () => {
  const view = joinRequestsView(
    listState({
      pending: [
        {
          ...pending(FIRST),
          userId: id(0xb9),
          requester: { ...REQUESTER, provider: "github", userId: id(0xb9) },
        } as PendingJoinRequestState,
      ],
    }),
    1,
    NOW,
  );
  const text = JSON.stringify(view);
  expect(text).not.toContain(id(0xb9));
  expect(text).not.toContain("provider");
});

test("load passes the service's answer through, and get answers without subscribing the caller", () => {
  const { call } = register();
  expect(call<JoinRequestLoadResult>(INVOKE_CHANNELS.loadJoinRequests)).toEqual(
    { outcome: "loading" },
  );
  expect(call<JoinRequestLoadResult>(INVOKE_CHANNELS.loadJoinRequests)).toEqual(
    { outcome: "refused", reason: "too_soon" },
  );

  const fake = fakeService();
  const registered = register(fake);
  const caller = receiver();
  expect(
    registered.call<JoinRequestsView>(
      INVOKE_CHANNELS.getJoinRequestState,
      caller,
    ).pending,
  ).toHaveLength(2);
  fake.fire();
  registered.timers.fire();
  expect(caller.sent).toEqual([]);
});

test("a change raises the revision at once, and a burst publishes once, after the interval, with the latest view", () => {
  const fake = fakeService();
  const { call, timers } = register(fake);
  const caller = receiver();
  const first = call<JoinRequestsView>(
    INVOKE_CHANNELS.subscribeJoinRequestState,
    caller,
  );
  expect(first.revision).toBe(0);

  fake.set({ pending: [pending(FIRST)] });
  fake.fire();
  fake.set({ pending: [pending(SECOND)], pausedAt: null });
  fake.fire();
  expect(caller.sent).toEqual([]);
  expect(timers.pending().map((timer) => timer.delayMs)).toEqual([
    JOIN_REQUEST_PUBLISH_INTERVAL_MS,
  ]);
  expect(
    call<JoinRequestsView>(INVOKE_CHANNELS.getJoinRequestState).revision,
  ).toBeGreaterThan(first.revision);

  timers.fire();
  expect(caller.sent).toHaveLength(1);
  const [channel, payload] = caller.sent[0] as [string, JoinRequestsView];
  expect(channel).toBe(EVENT_CHANNELS.joinRequestStateChanged);
  expect(payload.pending.map((entry) => entry.joinRequestId)).toEqual([SECOND]);
  expect(payload.pausedAt).toBeNull();
  expect(payload.revision).toBeGreaterThan(first.revision);
});

test("close cancels the waiting publish and stops listening", () => {
  const fake = fakeService();
  const { call, timers, ipc } = register(fake);
  const caller = receiver();
  call(INVOKE_CHANNELS.subscribeJoinRequestState, caller);
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
  call(INVOKE_CHANNELS.subscribeJoinRequestState, caller);
  fake.set({
    pending: [{ ...pending(FIRST), id: "not-an-id" }],
  } as unknown as Partial<JoinRequestListState>);
  fake.fire();
  timers.fire();
  expect(caller.sent).toEqual([]);
  // The message alone: never the error.
  expect(errors).toEqual([["Sending the join requests failed."]]);

  const printed: unknown[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    printed.push(args);
  });
  const quiet = fakeService();
  const registered = register(quiet, DEV_URL, "default");
  registered.call(INVOKE_CHANNELS.subscribeJoinRequestState, receiver());
  quiet.set({
    pending: [{ ...pending(FIRST), id: "not-an-id" }],
  } as unknown as Partial<JoinRequestListState>);
  quiet.fire();
  registered.timers.fire();
  expect(printed).toEqual([["Sending the join requests failed."]]);
});
