import {
  CLAIM_VIAS,
  MAX_ANSWER_LIST_ITEMS,
  type MemberId,
  RECENT_CLAIMS,
  type WorkspaceId,
} from "@mymandev/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  CLAIM_LIMITS,
  CLAIM_LOAD_REFUSALS,
  CLAIM_MARK_SEEN_REFUSALS,
  CLAIM_STATUSES,
  CLAIM_VIAS_VIEW,
  ClaimsViewSchema,
  WORKSPACE_PROBLEMS,
  type ClaimLoadResult,
  type ClaimMarkSeenResult,
  type ClaimsView,
} from "../shared/ipc-contract.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import {
  CLAIM_PUBLISH_INTERVAL_MS,
  claimsView,
  markClaimsSeen,
  registerClaimIpc,
} from "./claim-ipc.ts";
import type {
  ClaimListState,
  ClaimLoadOutcome,
  ClaimMarkSeenOutcome,
  ClaimState,
} from "./claims/service.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const FIRST = id(0xd1) as MemberId;
const SECOND = id(0xd2) as MemberId;
const ERASED = id(0xd3) as MemberId;
const AT = "2026-11-05T10:00:00.000Z";
const LATER = "2026-11-05T11:00:00.000Z";
const ACCOUNT_CREATED_AT = "2026-11-01T03:04:05.000Z";

const CLAIMER = Object.freeze({
  login: "linus",
  verifiedAt: AT,
  accountCreatedAt: ACCOUNT_CREATED_AT,
});

function claim(
  memberId: MemberId,
  overrides: Partial<ClaimState> = {},
): ClaimState {
  return Object.freeze({
    memberId,
    claimer: CLAIMER,
    via: "invitation",
    claimedAt: AT,
    unseen: true,
    ...overrides,
  });
}

function listState(overrides: Partial<ClaimListState> = {}): ClaimListState {
  return Object.freeze({
    revision: 4,
    status: "ready",
    workspaceId: WORKSPACE,
    claims: Object.freeze([
      claim(SECOND, { claimedAt: LATER, via: "join_request" }),
      claim(FIRST, { unseen: false }),
    ]),
    ...overrides,
  });
}

/** The claim service, as the test sets it. */
function fakeService() {
  let state = listState();
  const listeners = new Set<(state: ClaimListState) => void>();
  const loads: ClaimLoadOutcome[] = [
    { outcome: "loading" },
    { outcome: "refused", reason: "too_soon" },
  ];
  let loaded = 0;
  const marked: [WorkspaceId, readonly MemberId[]][] = [];
  let markAnswer: ClaimMarkSeenOutcome = { outcome: "ok" };
  return {
    claims: {
      state: () => state,
      onChange: (listener: (state: ClaimListState) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      load: () => loads[loaded++] ?? { outcome: "loading" as const },
      markSeen: (workspaceId: WorkspaceId, memberIds: readonly MemberId[]) => {
        marked.push([workspaceId, memberIds]);
        return markAnswer;
      },
    },
    loads: () => loaded,
    marked,
    answerMark(next: ClaimMarkSeenOutcome) {
      markAnswer = next;
    },
    listeners: () => listeners.size,
    set(next: Partial<ClaimListState>) {
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
  const ipc = registerClaimIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      claims: fake.claims,
      scheduleTimer: timers.schedule,
      ...(reports === "recorded"
        ? { onError: (...args: unknown[]) => errors.push(args) }
        : {}),
    },
  );
  const call = <T>(
    channel: string,
    caller = receiver(appUrl),
    ...args: unknown[]
  ): T => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}.`);
    }
    return handler(event(caller, frame(appUrl)), ...args) as T;
  };
  return { handlers, call, timers, errors, ipc, fake };
}

test("the claim channels are registered, and nothing else", () => {
  const { handlers } = register();
  expect([...handlers.keys()].sort()).toEqual(
    [
      INVOKE_CHANNELS.getClaimState,
      INVOKE_CHANNELS.subscribeClaimState,
      INVOKE_CHANNELS.loadClaims,
      INVOKE_CHANNELS.markClaimsSeen,
    ].sort(),
  );
});

test("every handler refuses a foreign sender and wrong arguments, before the service is asked", () => {
  const fake = fakeService();
  const { handlers } = register(fake, APP_ENTRY_URL);
  for (const [channel, handler] of handlers) {
    for (const sender of [
      null,
      frame("https://example.invalid/"),
      frame(APP_ENTRY_URL, frame(APP_ENTRY_URL)),
    ]) {
      expect(() =>
        handler(event(receiver(APP_ENTRY_URL), sender), WORKSPACE, [FIRST]),
      ).toThrow(
        `The call on ${channel} was refused: the sender is not the application.`,
      );
    }
    const wrong =
      channel === INVOKE_CHANNELS.markClaimsSeen
        ? [
            [],
            [WORKSPACE],
            [WORKSPACE, [FIRST], [FIRST]],
            [WORKSPACE.toUpperCase(), [FIRST]],
            [WORKSPACE, FIRST],
            [WORKSPACE, []],
            [WORKSPACE, [FIRST.toUpperCase()]],
            [WORKSPACE, [AT]],
            [WORKSPACE, [FIRST, null]],
            [WORKSPACE, null],
            [[FIRST], WORKSPACE],
            [
              WORKSPACE,
              Array.from({ length: CLAIM_LIMITS.claims + 1 }, () => FIRST),
            ],
          ]
        : [[WORKSPACE], [undefined], [{}]];
    for (const args of wrong) {
      expect(() =>
        handler(event(receiver(APP_ENTRY_URL), frame(APP_ENTRY_URL)), ...args),
      ).toThrow(
        `The call on ${channel} was refused: the arguments do not match the contract.`,
      );
    }
  }
  expect(fake.loads()).toBe(0);
  expect(fake.marked).toEqual([]);
});

test("the view holds each claim's member ID, the claimer's login with its times, how and when, and whether it is unseen, with the view's own revision", () => {
  const view = claimsView(
    listState({
      claims: [
        claim(SECOND, { claimedAt: LATER, via: "join_request" }),
        claim(FIRST, { unseen: false }),
        claim(ERASED, { claimer: null }),
      ],
    }),
    7,
  );
  expect(view).toEqual({
    revision: 7,
    status: "ready",
    workspaceId: WORKSPACE,
    claims: [
      {
        memberId: SECOND,
        login: "linus",
        verifiedAt: AT,
        accountCreatedAt: ACCOUNT_CREATED_AT,
        via: "join_request",
        claimedAt: LATER,
        unseen: true,
      },
      {
        memberId: FIRST,
        login: "linus",
        verifiedAt: AT,
        accountCreatedAt: ACCOUNT_CREATED_AT,
        via: "invitation",
        claimedAt: AT,
        unseen: false,
      },
      {
        memberId: ERASED,
        login: null,
        verifiedAt: null,
        accountCreatedAt: null,
        via: "invitation",
        claimedAt: AT,
        unseen: true,
      },
    ],
  });
  expect(ClaimsViewSchema.safeParse(view).success).toBe(true);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.claims)).toBe(true);
  expect(Object.isFrozen(view.claims[0])).toBe(true);
});

test("the list holds at most its limit, and every status crosses as it is, with the problem only while unavailable; the contract's values match the service and the protocol", () => {
  const many = Array.from({ length: CLAIM_LIMITS.claims + 3 }, () =>
    claim(FIRST),
  );
  const full = claimsView(listState({ claims: many }), 1);
  expect(full.claims).toHaveLength(CLAIM_LIMITS.claims);
  expect(ClaimsViewSchema.safeParse(full).success).toBe(true);

  const statuses: ClaimListState["status"][] = [
    "signed_out",
    "no_workspace",
    "not_allowed",
    "loading",
    "ready",
  ];
  expect([...statuses, "unavailable"].sort()).toEqual(
    [...CLAIM_STATUSES].sort(),
  );
  for (const status of statuses) {
    expect(claimsView(listState({ status, claims: [] }), 1)).toEqual({
      revision: 1,
      status,
      workspaceId: WORKSPACE,
      claims: [],
    });
  }
  for (const problem of WORKSPACE_PROBLEMS) {
    const view = claimsView(listState({ status: "unavailable", problem }), 1);
    expect(view).toMatchObject({ status: "unavailable", problem });
    expect(view.claims).toHaveLength(2);
    expect(ClaimsViewSchema.safeParse(view).success).toBe(true);
  }
  expect([...CLAIM_LOAD_REFUSALS].sort()).toEqual(
    ["no_workspace", "not_allowed", "not_signed_in", "too_soon"].sort(),
  );
  expect([...CLAIM_MARK_SEEN_REFUSALS].sort()).toEqual(
    ["invalid", "not_allowed", "not_listed", "not_selected"].sort(),
  );
  expect(CLAIM_LIMITS.claims).toBe(MAX_ANSWER_LIST_ITEMS);
  expect(RECENT_CLAIMS).toBeLessThanOrEqual(CLAIM_LIMITS.claims);
  expect([...CLAIM_VIAS_VIEW]).toEqual([...CLAIM_VIAS]);
});

test("no user ID or other field of the service's state crosses", () => {
  const view = claimsView(
    listState({
      claims: [
        {
          ...claim(FIRST),
          userId: id(0xb9),
          workspaceId: WORKSPACE,
          claimer: { ...CLAIMER, provider: "github", userId: id(0xb9) },
        } as ClaimState,
      ],
    }),
    1,
  );
  const text = JSON.stringify(view);
  expect(text).not.toContain(id(0xb9));
  expect(text).not.toContain("provider");
});

test("load passes the service's answer through, and get answers without subscribing the caller", () => {
  const { call } = register();
  expect(call<ClaimLoadResult>(INVOKE_CHANNELS.loadClaims)).toEqual({
    outcome: "loading",
  });
  expect(call<ClaimLoadResult>(INVOKE_CHANNELS.loadClaims)).toEqual({
    outcome: "refused",
    reason: "too_soon",
  });

  const fake = fakeService();
  const registered = register(fake);
  const caller = receiver();
  expect(
    registered.call<ClaimsView>(INVOKE_CHANNELS.getClaimState, caller).claims,
  ).toHaveLength(2);
  fake.fire();
  registered.timers.fire();
  expect(caller.sent).toEqual([]);
});

test("markSeen checks the workspace ID and every member ID with the protocol's schemas again and passes the service's answer through", () => {
  const fake = fakeService();
  const { call } = register(fake);
  expect(
    call<ClaimMarkSeenResult>(
      INVOKE_CHANNELS.markClaimsSeen,
      receiver(),
      WORKSPACE,
      [SECOND, FIRST],
    ),
  ).toEqual({ outcome: "ok" });
  expect(fake.marked).toEqual([[WORKSPACE, [SECOND, FIRST]]]);
  for (const reason of ["not_selected", "not_allowed", "not_listed"] as const) {
    fake.answerMark({ outcome: "refused", reason });
    expect(
      call<ClaimMarkSeenResult>(
        INVOKE_CHANNELS.markClaimsSeen,
        receiver(),
        WORKSPACE,
        [FIRST],
      ),
    ).toEqual({ outcome: "refused", reason });
  }

  // Behind the contract, the protocol's schemas refuse a value as invalid
  // before the service is asked.
  fake.marked.length = 0;
  for (const [workspaceId, memberIds] of [
    ["not-an-id", [FIRST]],
    [WORKSPACE.toUpperCase(), [FIRST]],
    ["", [FIRST]],
    [WORKSPACE, ["not-an-id"]],
    [WORKSPACE, [FIRST, FIRST.toUpperCase()]],
    [WORKSPACE, [FIRST, ""]],
  ] as const) {
    expect(
      markClaimsSeen(fake.claims, workspaceId, memberIds),
      `${workspaceId} ${memberIds.join(" ")}`,
    ).toEqual({ outcome: "refused", reason: "invalid" });
  }
  expect(fake.marked).toEqual([]);
});

test("a change raises the revision at once, and a burst publishes once, after the interval, with the latest view", () => {
  const fake = fakeService();
  const { call, timers } = register(fake);
  const caller = receiver();
  const first = call<ClaimsView>(INVOKE_CHANNELS.subscribeClaimState, caller);
  expect(first.revision).toBe(0);

  fake.set({ claims: [claim(FIRST)] });
  fake.fire();
  fake.set({ claims: [claim(SECOND, { unseen: false })] });
  fake.fire();
  expect(caller.sent).toEqual([]);
  expect(timers.pending().map((timer) => timer.delayMs)).toEqual([
    CLAIM_PUBLISH_INTERVAL_MS,
  ]);
  expect(
    call<ClaimsView>(INVOKE_CHANNELS.getClaimState).revision,
  ).toBeGreaterThan(first.revision);

  timers.fire();
  expect(caller.sent).toHaveLength(1);
  const [channel, payload] = caller.sent[0] as [string, ClaimsView];
  expect(channel).toBe(EVENT_CHANNELS.claimStateChanged);
  expect(payload.claims).toEqual([
    expect.objectContaining({ memberId: SECOND, unseen: false }),
  ]);
  expect(payload.revision).toBeGreaterThan(first.revision);
});

test("close cancels the waiting publish and stops listening", () => {
  const fake = fakeService();
  const { call, timers, ipc } = register(fake);
  const caller = receiver();
  call(INVOKE_CHANNELS.subscribeClaimState, caller);
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
  call(INVOKE_CHANNELS.subscribeClaimState, caller);
  fake.set({
    claims: [{ ...claim(FIRST), memberId: "not-an-id" }],
  } as unknown as Partial<ClaimListState>);
  fake.fire();
  timers.fire();
  expect(caller.sent).toEqual([]);
  // The message alone: never the error.
  expect(errors).toEqual([["Sending the claims failed."]]);

  const printed: unknown[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    printed.push(args);
  });
  const quiet = fakeService();
  const registered = register(quiet, DEV_URL, "default");
  registered.call(INVOKE_CHANNELS.subscribeClaimState, receiver());
  quiet.set({
    claims: [{ ...claim(FIRST), memberId: "not-an-id" }],
  } as unknown as Partial<ClaimListState>);
  quiet.fire();
  registered.timers.fire();
  expect(printed).toEqual([["Sending the claims failed."]]);
});
