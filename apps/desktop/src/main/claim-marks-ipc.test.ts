import { MAX_ANSWER_LIST_ITEMS, type WorkspaceId } from "@mymandev/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  ClaimMarksViewSchema,
  type ClaimMarksView,
  WORKSPACE_LIMITS,
} from "../shared/ipc-contract.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import { CLAIM_PUBLISH_INTERVAL_MS } from "./claim-ipc.ts";
import { claimMarksView, registerClaimMarksIpc } from "./claim-marks-ipc.ts";
import type { ClaimMarkState } from "./claims/marks.ts";
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

const WS_B = id(0xa2) as WorkspaceId;
const WS_C = id(0xa3) as WorkspaceId;
const MEMBER_ID = id(0xd1);
const USER_ID = id(0xb9);

function markState(overrides: Partial<ClaimMarkState> = {}): ClaimMarkState {
  return Object.freeze({
    revision: 4,
    workspaceIds: Object.freeze([WS_B, WS_C]),
    ...overrides,
  });
}

/** The claim mark service, as the test sets it. */
function fakeService() {
  let state = markState();
  const listeners = new Set<(state: ClaimMarkState) => void>();
  return {
    marks: {
      state: () => state,
      onChange: (listener: (state: ClaimMarkState) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    listeners: () => listeners.size,
    set(next: Partial<ClaimMarkState>) {
      state = markState(next);
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
  const errors: unknown[][] = [];
  const ipc = registerClaimMarksIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      marks: fake.marks,
      scheduleTimer: timers.schedule,
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

test("the claim mark channels are registered, and nothing else", () => {
  const { handlers } = register();
  expect([...handlers.keys()].sort()).toEqual(
    [INVOKE_CHANNELS.getClaimMarks, INVOKE_CHANNELS.subscribeClaimMarks].sort(),
  );
});

test("every handler refuses a foreign sender and any argument", () => {
  const { handlers } = register(fakeService(), APP_ENTRY_URL);
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
    for (const args of [[WS_B], [undefined], [{}], [[WS_B]]]) {
      expect(() =>
        handler(event(receiver(APP_ENTRY_URL), frame(APP_ENTRY_URL)), ...args),
      ).toThrow(
        `The call on ${channel} was refused: the arguments do not match the contract.`,
      );
    }
  }
});

test("the view holds the marked workspaces' IDs with the view's own revision, cut at the limit of the workspace list, and nothing else crosses", () => {
  const view = claimMarksView(markState({ revision: 9 }), 2);
  expect(view).toEqual({ revision: 2, workspaceIds: [WS_B, WS_C] });
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.workspaceIds)).toBe(true);
  expect(WORKSPACE_LIMITS.workspaces).toBe(MAX_ANSWER_LIST_ITEMS);
  const many = Array.from(
    { length: WORKSPACE_LIMITS.workspaces + 2 },
    (_, index) => id(0x1000 + index) as WorkspaceId,
  );
  const cut = claimMarksView(markState({ workspaceIds: many }), 1);
  expect(cut.workspaceIds).toEqual(many.slice(0, WORKSPACE_LIMITS.workspaces));
  expect(ClaimMarksViewSchema.safeParse(cut).success).toBe(true);

  // A state that held more would not carry it across.
  const fake = fakeService();
  fake.set({
    claims: [{ memberId: MEMBER_ID, login: "linus" }],
    userId: USER_ID,
  } as unknown as Partial<ClaimMarkState>);
  const { call } = register(fake);
  const answered = call<ClaimMarksView>(INVOKE_CHANNELS.getClaimMarks);
  expect(Object.keys(answered).sort()).toEqual(["revision", "workspaceIds"]);
  expect(JSON.stringify(answered)).not.toContain(MEMBER_ID);
  expect(JSON.stringify(answered)).not.toContain(USER_ID);
  expect(JSON.stringify(answered)).not.toContain("linus");
});

test("get answers without subscribing the caller, and a change raises the revision at once and publishes once after the interval with the latest view", () => {
  const fake = fakeService();
  const { call, timers } = register(fake);
  const reader = receiver();
  expect(
    call<ClaimMarksView>(INVOKE_CHANNELS.getClaimMarks, reader).workspaceIds,
  ).toEqual([WS_B, WS_C]);
  const caller = receiver();
  const first = call<ClaimMarksView>(
    INVOKE_CHANNELS.subscribeClaimMarks,
    caller,
  );
  expect(first.revision).toBe(0);

  fake.set({ workspaceIds: [WS_C] });
  fake.fire();
  fake.set({ workspaceIds: [] });
  fake.fire();
  expect(caller.sent).toEqual([]);
  expect(timers.pending().map((timer) => timer.delayMs)).toEqual([
    CLAIM_PUBLISH_INTERVAL_MS,
  ]);
  expect(
    call<ClaimMarksView>(INVOKE_CHANNELS.getClaimMarks).revision,
  ).toBeGreaterThan(first.revision);

  timers.fire();
  expect(caller.sent).toEqual([
    [EVENT_CHANNELS.claimMarksChanged, { revision: 2, workspaceIds: [] }],
  ]);
  expect(reader.sent).toEqual([]);
});

test("close cancels the waiting publish and stops listening", () => {
  const fake = fakeService();
  const { call, timers, ipc } = register(fake);
  const caller = receiver();
  call(INVOKE_CHANNELS.subscribeClaimMarks, caller);
  fake.fire();
  ipc.close();
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
  call(INVOKE_CHANNELS.subscribeClaimMarks, caller);
  fake.set({
    workspaceIds: ["not-an-id"],
  } as unknown as Partial<ClaimMarkState>);
  fake.fire();
  timers.fire();
  expect(caller.sent).toEqual([]);
  expect(errors).toEqual([["Sending the claim marks failed."]]);

  const printed: unknown[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    printed.push(args);
  });
  const quiet = fakeService();
  const registered = register(quiet, DEV_URL, "default");
  registered.call(INVOKE_CHANNELS.subscribeClaimMarks, receiver());
  quiet.set({
    workspaceIds: ["not-an-id"],
  } as unknown as Partial<ClaimMarkState>);
  quiet.fire();
  registered.timers.fire();
  expect(printed).toEqual([["Sending the claim marks failed."]]);
});
