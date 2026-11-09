import {
  INVITATION_LIFETIME_SECONDS,
  InvitationCodeSchema,
  type InvitationId,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  type MemberId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  INVITATION_LIMITS,
  INVITATION_LOAD_REFUSALS,
  INVITATION_STATUSES,
  InvitationCodeTextSchema,
  InvitationLifetimeSchema,
  InvitationsViewSchema,
  WORKSPACE_PROBLEMS,
  type InvitationLoadResult,
  type InvitationsView,
} from "../shared/ipc-contract.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import {
  INVITATION_PUBLISH_INTERVAL_MS,
  invitationsView,
  registerInvitationIpc,
} from "./invitation-ipc.ts";
import type {
  InvitationListState,
  InvitationLoadOutcome,
  InvitationState,
} from "./invitations/service.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import { UNKNOWN_MEMBER_NAME } from "./workspace/service.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OWNER = id(0xc1) as MemberId;
const ADMIN = id(0xc2) as MemberId;
const INVITEE = id(0xc3) as MemberId;
const GONE = id(0xc4) as MemberId;
const FIRST = id(0xe1) as InvitationId;
const SECOND = id(0xe2) as InvitationId;
const EXPIRED = id(0xe3) as InvitationId;
const AT = "2026-11-05T10:00:00.000Z";
const NOW = Date.parse("2026-11-06T10:00:00.000Z");
const EXPIRES_AT = "2026-11-12T10:00:00.000Z";

function invitation(
  invitationId: InvitationId,
  createdByMemberId: MemberId,
  expiresAt: string = EXPIRES_AT,
): InvitationState {
  return Object.freeze({
    id: invitationId,
    memberId: INVITEE,
    createdByMemberId,
    createdAt: AT,
    expiresAt,
  });
}

function listState(
  overrides: Partial<InvitationListState> = {},
): InvitationListState {
  return Object.freeze({
    revision: 4,
    status: "ready",
    workspaceId: WORKSPACE,
    invitations: Object.freeze([
      invitation(FIRST, OWNER),
      invitation(SECOND, ADMIN),
    ]),
    ...overrides,
  });
}

const NAMES: Readonly<Record<string, string>> = {
  [OWNER]: "Ada Owner",
  [ADMIN]: "Grace Admin",
};

function memberName(memberId: MemberId): string {
  return NAMES[memberId] ?? UNKNOWN_MEMBER_NAME;
}

/** The invitation service and the workspace service's names, as the test sets them. */
function fakeServices() {
  let state = listState();
  let names = memberName;
  // The IPC reads the services again on every change and ignores the
  // listener's argument.
  const listeners = new Set<(state: never) => void>();
  const loads: InvitationLoadOutcome[] = [
    { outcome: "loading" },
    { outcome: "refused", reason: "too_soon" },
  ];
  let loaded = 0;
  const onChange = <S>(listener: (state: S) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    invitations: {
      state: () => state,
      onChange,
      load: () => loads[loaded++] ?? { outcome: "loading" as const },
    },
    workspaces: {
      memberName: (memberId: MemberId) => names(memberId),
      onChange,
    },
    loads: () => loaded,
    listeners: () => listeners.size,
    set(next: Partial<InvitationListState>) {
      state = listState(next);
    },
    rename(next: (memberId: MemberId) => string) {
      names = next;
    },
    fire() {
      for (const listener of [...listeners]) {
        listener(undefined as never);
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
  fake = fakeServices(),
  appUrl: string = DEV_URL,
  reports: "recorded" | "default" = "recorded",
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const timers = fakeTimers();
  // Every argument of every report, so that an error passed on shows.
  const errors: unknown[][] = [];
  const ipc = registerInvitationIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    {
      invitations: fake.invitations,
      workspaces: fake.workspaces,
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

test("the invitation state channels are registered, and nothing else", () => {
  const { handlers } = register();
  expect([...handlers.keys()].sort()).toEqual(
    [
      INVOKE_CHANNELS.getInvitationState,
      INVOKE_CHANNELS.subscribeInvitationState,
      INVOKE_CHANNELS.loadInvitations,
    ].sort(),
  );
});

test("every handler refuses a foreign sender and any argument, before the service is asked", () => {
  const fake = fakeServices();
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

test("the view holds each invitation's ID, person, creator's name, and times, in the service's order, with the view's own revision", () => {
  const view = invitationsView(listState(), 7, memberName, NOW);
  expect(view).toEqual({
    revision: 7,
    status: "ready",
    workspaceId: WORKSPACE,
    invitations: [
      {
        invitationId: FIRST,
        memberId: INVITEE,
        creatorName: "Ada Owner",
        createdAt: AT,
        expiresAt: EXPIRES_AT,
      },
      {
        invitationId: SECOND,
        memberId: INVITEE,
        creatorName: "Grace Admin",
        createdAt: AT,
        expiresAt: EXPIRES_AT,
      },
    ],
  });
  expect(InvitationsViewSchema.safeParse(view).success).toBe(true);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.invitations)).toBe(true);
  expect(Object.isFrozen(view.invitations[0])).toBe(true);
});

test("a creator's member ID never crosses: an unknown creator shows as the unknown person's name, and a long name is cut in characters", () => {
  const face = "\u{1F600}";
  const view = invitationsView(
    listState({
      invitations: [invitation(FIRST, GONE), invitation(SECOND, ADMIN)],
    }),
    1,
    (memberId) =>
      memberId === ADMIN
        ? face.repeat(INVITATION_LIMITS.displayName + 5)
        : memberName(memberId),
    NOW,
  );
  expect(view.invitations.map((entry) => entry.creatorName)).toEqual([
    UNKNOWN_MEMBER_NAME,
    face.repeat(INVITATION_LIMITS.displayName),
  ]);
  const text = JSON.stringify(view);
  for (const memberId of [OWNER, ADMIN, GONE]) {
    expect(text).not.toContain(memberId);
  }
  expect(InvitationsViewSchema.safeParse(view).success).toBe(true);
});

test("an invitation past its expiry is left out", () => {
  const view = invitationsView(
    listState({
      invitations: [
        invitation(FIRST, OWNER),
        invitation(EXPIRED, OWNER, new Date(NOW).toISOString()),
        invitation(SECOND, OWNER, new Date(NOW + 1).toISOString()),
      ],
    }),
    1,
    memberName,
    NOW,
  );
  expect(view.invitations.map((entry) => entry.invitationId)).toEqual([
    FIRST,
    SECOND,
  ]);
});

test("every status of the service crosses as it is, with the problem only while unavailable, and the contract's statuses and limits match the service and the protocol", () => {
  const statuses: InvitationListState["status"][] = [
    "signed_out",
    "no_workspace",
    "not_allowed",
    "loading",
    "ready",
  ];
  expect([...statuses, "unavailable"].sort()).toEqual(
    [...INVITATION_STATUSES].sort(),
  );
  for (const status of statuses) {
    const view = invitationsView(
      listState({ status, invitations: [] }),
      1,
      memberName,
      NOW,
    );
    expect(view).toEqual({
      revision: 1,
      status,
      workspaceId: WORKSPACE,
      invitations: [],
    });
  }
  for (const problem of WORKSPACE_PROBLEMS) {
    const view = invitationsView(
      listState({ status: "unavailable", problem }),
      1,
      memberName,
      NOW,
    );
    expect(view).toMatchObject({ status: "unavailable", problem });
    expect(view.invitations).toHaveLength(2);
    expect(InvitationsViewSchema.safeParse(view).success).toBe(true);
  }
  expect([...INVITATION_LOAD_REFUSALS].sort()).toEqual(
    ["no_workspace", "not_allowed", "not_signed_in", "too_soon"].sort(),
  );
  expect(INVITATION_LIMITS.invitations).toBe(MAX_ANSWER_LIST_ITEMS);
  expect(INVITATION_LIMITS.displayName).toBe(LIMITS.displayName);
  expect(INVITATION_LIMITS.workspaceName).toBe(LIMITS.name);
  expect(INVITATION_LIMITS.minLifetimeSeconds).toBe(
    INVITATION_LIFETIME_SECONDS.min,
  );
  expect(INVITATION_LIMITS.maxLifetimeSeconds).toBe(
    INVITATION_LIFETIME_SECONDS.max,
  );
  for (const seconds of [3_599, 3_600, 604_800, 604_801, 3_600.5]) {
    expect(InvitationLifetimeSchema.safeParse(seconds).success).toBe(
      seconds >= INVITATION_LIFETIME_SECONDS.min &&
        seconds <= INVITATION_LIFETIME_SECONDS.max &&
        Number.isInteger(seconds),
    );
  }
});

test("the contract's code text accepts exactly the protocol's invitation codes", () => {
  const body = "AbcDEF0123456789_-xyzXYZ0123456789abcdefgh".slice(0, 42);
  const samples = [
    `mmdi_${body}A`,
    `mmdi_${body}w`,
    `mmdi_${body}8`,
    `mmdi_${body}B`,
    `mmdi_${body}`,
    `mmdi_${body}AA`,
    `mmda_${body}A`,
    `MMDI_${body}A`,
    ` mmdi_${body}A`,
    `mmdi_${body}A `,
    `mmdi_${body}A\n`,
    `mmdi_${body.slice(1)}+A`,
    `mmdi_${body.slice(1)}=A`,
    `mmdi_${body.slice(1)}\u00e9A`,
    "",
  ];
  for (const sample of samples) {
    expect(
      InvitationCodeTextSchema.safeParse(sample).success,
      JSON.stringify(sample),
    ).toBe(InvitationCodeSchema.safeParse(sample).success);
  }
  expect(InvitationCodeTextSchema.safeParse(`mmdi_${body}A`).success).toBe(
    true,
  );
  // A long text is refused before the pattern runs, without repeating it.
  const long = InvitationCodeTextSchema.safeParse(`mmdi_${"a".repeat(10_000)}`);
  expect(long.error?.issues).toHaveLength(1);
  expect(JSON.stringify(long.error?.issues)).not.toContain("aaaa");
});

test("load passes the service's answer through, and get answers without subscribing the caller", () => {
  const { call } = register();
  expect(call<InvitationLoadResult>(INVOKE_CHANNELS.loadInvitations)).toEqual({
    outcome: "loading",
  });
  expect(call<InvitationLoadResult>(INVOKE_CHANNELS.loadInvitations)).toEqual({
    outcome: "refused",
    reason: "too_soon",
  });

  const fake = fakeServices();
  const registered = register(fake);
  const caller = receiver();
  expect(
    registered.call<InvitationsView>(INVOKE_CHANNELS.getInvitationState, caller)
      .invitations,
  ).toHaveLength(2);
  fake.fire();
  registered.timers.fire();
  expect(caller.sent).toEqual([]);
});

test("a change of either service raises the revision at once, and a burst publishes once, after the interval, with the latest view and names", () => {
  const fake = fakeServices();
  const { call, timers } = register(fake);
  const caller = receiver();
  const first = call<InvitationsView>(
    INVOKE_CHANNELS.subscribeInvitationState,
    caller,
  );
  expect(first.revision).toBe(0);

  fake.set({ invitations: [invitation(FIRST, OWNER)] });
  fake.fire();
  fake.rename((memberId) =>
    memberId === OWNER ? "Ada Renamed" : memberName(memberId),
  );
  fake.fire();
  expect(caller.sent).toEqual([]);
  expect(timers.pending().map((timer) => timer.delayMs)).toEqual([
    INVITATION_PUBLISH_INTERVAL_MS,
  ]);
  expect(
    call<InvitationsView>(INVOKE_CHANNELS.getInvitationState).revision,
  ).toBeGreaterThan(first.revision);

  timers.fire();
  expect(caller.sent).toHaveLength(1);
  const [channel, payload] = caller.sent[0] as [string, InvitationsView];
  expect(channel).toBe(EVENT_CHANNELS.invitationStateChanged);
  expect(payload.invitations.map((entry) => entry.creatorName)).toEqual([
    "Ada Renamed",
  ]);
  expect(payload.revision).toBeGreaterThan(first.revision);
});

test("close cancels the waiting publish and stops listening", () => {
  const fake = fakeServices();
  const { call, timers, ipc } = register(fake);
  const caller = receiver();
  call(INVOKE_CHANNELS.subscribeInvitationState, caller);
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
  const fake = fakeServices();
  const { call, timers, errors } = register(fake);
  const caller = receiver();
  call(INVOKE_CHANNELS.subscribeInvitationState, caller);
  fake.set({
    invitations: [{ ...invitation(FIRST, OWNER), id: "not-an-id" }],
  } as unknown as Partial<InvitationListState>);
  fake.fire();
  timers.fire();
  expect(caller.sent).toEqual([]);
  // The message alone: never the error.
  expect(errors).toEqual([["Sending the invitations failed."]]);

  const printed: unknown[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    printed.push(args);
  });
  const quiet = fakeServices();
  const registered = register(quiet, DEV_URL, "default");
  registered.call(INVOKE_CHANNELS.subscribeInvitationState, receiver());
  quiet.set({
    invitations: [{ ...invitation(FIRST, OWNER), id: "not-an-id" }],
  } as unknown as Partial<InvitationListState>);
  quiet.fire();
  registered.timers.fire();
  expect(printed).toEqual([["Sending the invitations failed."]]);
});
