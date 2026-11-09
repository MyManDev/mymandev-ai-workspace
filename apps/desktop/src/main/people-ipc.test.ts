import {
  decodeServerMessage,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  MEMBER_ROLES,
  type MemberId,
  UNCLAIMED_MEMBER_LIMIT,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  PEOPLE_LIMITS,
  PEOPLE_STATUSES,
  WORKSPACE_LIMITS,
  PeopleViewSchema,
  PERSON_ROLES,
  WORKSPACE_PROBLEMS,
  WORKSPACE_STATUSES,
  type AccountStatus,
  type PeopleView,
} from "../shared/ipc-contract.ts";
import type { WorkspaceReadResult } from "./api-reads.ts";
import { APP_ENTRY_URL } from "./app-protocol.ts";
import type { ServerMessage } from "./connection/client.ts";
import type {
  IpcFrame,
  IpcInvokeEvent,
  IpcInvokeListener,
  StatusReceiver,
} from "./ipc.ts";
import {
  PEOPLE_PUBLISH_INTERVAL_MS,
  peopleView,
  registerPeopleIpc,
} from "./people-ipc.ts";
import {
  createWorkspaceService,
  type PersonState,
  type WorkspaceAccount,
  type WorkspaceConnection,
  type WorkspaceState,
} from "./workspace/service.ts";

const DEV_URL = "http://localhost:5173/";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OWNER = id(0xc1) as MemberId;
const ADMIN = id(0xc2) as MemberId;
const UNCLAIMED = id(0xc3) as MemberId;
const FORMER = id(0xc4) as MemberId;
const USER_ID = id(0xb1);
const OTHER_USER_ID = id(0xb2);
const DEVICE_ID = id(0xd1);
const AT = "2026-11-05T10:00:00.000Z";
const LATER = "2026-11-06T09:30:00.000Z";

function person(
  memberId: MemberId,
  displayName: string,
  overrides: Partial<PersonState> = {},
): PersonState {
  return Object.freeze({
    id: memberId,
    displayName,
    role: "member",
    claimed: true,
    identity: Object.freeze({ login: "octocat", verifiedAt: AT }),
    removedAt: null,
    ...overrides,
  });
}

const PEOPLE: readonly PersonState[] = Object.freeze([
  person(OWNER, "Ada Lovelace", { role: "owner" }),
  // A former member, in the middle of the service's order.
  person(FORMER, "Alan Turing", { role: "admin", removedAt: AT }),
  person(ADMIN, "Grace Hopper", {
    role: "admin",
    identity: Object.freeze({ login: "grace-h", verifiedAt: LATER }),
  }),
  person(UNCLAIMED, "Linus Newcomer", { claimed: false, identity: null }),
]);

function workspaceState(
  overrides: Partial<WorkspaceState> = {},
): WorkspaceState {
  return Object.freeze({
    revision: 3,
    status: "ready",
    workspaces: Object.freeze([
      Object.freeze({ id: WORKSPACE, name: "Workspace Alpha" }),
    ]),
    selectedWorkspaceId: WORKSPACE,
    projects: Object.freeze([]),
    openProjectId: null,
    ...overrides,
  } as WorkspaceState);
}

interface Timer {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
  fired: boolean;
}

/** The workspace service, with a listener the test calls. */
function fakeService(
  initial: WorkspaceState = workspaceState(),
  initialPeople: readonly PersonState[] = PEOPLE,
) {
  let state = initial;
  let people = initialPeople;
  const listeners = new Set<(state: WorkspaceState) => void>();
  const timers: Timer[] = [];
  const errors: string[] = [];
  let reads = 0;
  return {
    timers,
    errors,
    listeners,
    reads: () => reads,
    /** The timers that were neither cancelled nor fired. */
    waiting: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
    set(next: Partial<WorkspaceState>, nextPeople: readonly PersonState[]) {
      state = workspaceState({ revision: state.revision + 1, ...next });
      people = nextPeople;
      for (const listener of [...listeners]) {
        listener(state);
      }
    },
    /** Fires every waiting timer once. */
    fire() {
      for (const timer of [...timers]) {
        if (!timer.cancelled && !timer.fired) {
          timer.fired = true;
          timer.callback();
        }
      }
    },
    options: {
      workspaces: {
        state: () => {
          reads += 1;
          return state;
        },
        people: () => {
          reads += 1;
          return people;
        },
        ownMemberId: (workspaceId: WorkspaceId) => {
          reads += 1;
          return workspaceId === WORKSPACE ? OWNER : null;
        },
        ownershipOffer: () => {
          reads += 1;
          return null;
        },
        unclaimedMemberLimit: () => {
          reads += 1;
          return 500;
        },
        onChange: (listener: (state: WorkspaceState) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      scheduleTimer: (callback: () => void, delayMs: number) => {
        const timer: Timer = {
          callback,
          delayMs,
          cancelled: false,
          fired: false,
        };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      onError: (message: string) => {
        errors.push(message);
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
  options: Parameters<typeof registerPeopleIpc>[2],
  appUrl: string = DEV_URL,
) {
  const handlers = new Map<string, IpcInvokeListener>();
  const peopleIpc = registerPeopleIpc(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    appUrl,
    options,
  );
  const call = (channel: string, sender: StatusReceiver = receiver()) => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`No handler for ${channel}.`);
    }
    return handler(event(frame(appUrl), sender)) as PeopleView;
  };
  /** Subscribes a frame and returns the payloads that it receives. */
  const subscribe = () => {
    const subscriber = receiver(appUrl);
    const first = call(INVOKE_CHANNELS.subscribePeopleState, subscriber);
    return {
      first,
      payloads: () =>
        subscriber.sent.map(([channel, payload]) => {
          expect(channel).toBe(EVENT_CHANNELS.peopleStateChanged);
          return payload as PeopleView;
        }),
    };
  };
  return { handlers, peopleIpc, call, subscribe };
}

test("the people channels are registered, read-only, and nothing else", () => {
  const { handlers } = register(fakeService().options);
  expect([...handlers.keys()].sort()).toEqual(
    [
      INVOKE_CHANNELS.getPeopleState,
      INVOKE_CHANNELS.subscribePeopleState,
    ].sort(),
  );
});

test("every handler refuses a foreign sender and any argument, before the service is asked", () => {
  const fake = fakeService();
  const { handlers } = register(fake.options, APP_ENTRY_URL);
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
    expect(() => handler(event(frame(APP_ENTRY_URL)), OWNER), channel).toThrow(
      `The call on ${channel} was refused: the arguments do not match the contract.`,
    );
  }
  expect(fake.reads()).toBe(0);
});

test("the view holds each person's member ID, name, role, claim, login, and former flag, the active people first, and the account's own member ID", () => {
  const { call } = register(fakeService().options);

  expect(call(INVOKE_CHANNELS.getPeopleState)).toEqual({
    status: "ready",
    revision: 3,
    workspaceId: WORKSPACE,
    workspaceName: "Workspace Alpha",
    ownMemberId: OWNER,
    people: [
      {
        memberId: OWNER,
        displayName: "Ada Lovelace",
        role: "owner",
        claimed: true,
        login: "octocat",
        verifiedAt: AT,
        former: false,
      },
      {
        memberId: ADMIN,
        displayName: "Grace Hopper",
        role: "admin",
        claimed: true,
        login: "grace-h",
        verifiedAt: LATER,
        former: false,
      },
      {
        memberId: UNCLAIMED,
        displayName: "Linus Newcomer",
        role: "member",
        claimed: false,
        login: null,
        verifiedAt: null,
        former: false,
      },
      {
        memberId: FORMER,
        displayName: "Alan Turing",
        role: "admin",
        claimed: true,
        login: "octocat",
        verifiedAt: AT,
        former: true,
      },
    ],
    morePeople: 0,
    ownershipOffer: null,
    maxUnclaimedMembers: 500,
  });
});

test("the ownership offer crosses only to the owner and its target, before its expiry, and the unclaimed limit only to the owner and the admins", () => {
  const expiresAt = "2026-11-12T10:00:00.000Z";
  const expiry = Date.parse(expiresAt);
  const settings = (now: number = expiry - 1) => ({
    ownershipOffer: Object.freeze({ memberId: ADMIN, expiresAt }),
    unclaimedMemberLimit: 40,
    now,
  });
  const MEMBER = id(0xc5) as MemberId;
  const people = [...PEOPLE, person(MEMBER, "Mary Member")];
  const view = (own: MemberId | null, now?: number) =>
    peopleView(workspaceState(), people, own, settings(now));
  const offer = { memberId: ADMIN, expiresAt };

  // The owner made the offer, and the target may accept it.
  expect(view(OWNER)).toMatchObject({
    ownershipOffer: offer,
    maxUnclaimedMembers: 40,
  });
  expect(view(ADMIN)).toMatchObject({
    ownershipOffer: offer,
    maxUnclaimedMembers: 40,
  });
  // A member sees neither; nor does a former member or an unknown person.
  for (const own of [MEMBER, FORMER, id(0xc9) as MemberId, null]) {
    expect(view(own), String(own)).toMatchObject({
      ownershipOffer: null,
      maxUnclaimedMembers: null,
    });
  }
  // Another admin sees the limit, but not an offer to someone else.
  const other = id(0xc6) as MemberId;
  const withOther = [...people, person(other, "Ola Admin", { role: "admin" })];
  expect(
    peopleView(workspaceState(), withOther, other, settings()),
  ).toMatchObject({ ownershipOffer: null, maxUnclaimedMembers: 40 });
  // An offer at or past its expiry is no offer.
  expect(view(OWNER, expiry).ownershipOffer).toBeNull();
  expect(view(ADMIN, expiry + 1).ownershipOffer).toBeNull();
  // Without a selection, nothing.
  expect(
    peopleView(
      workspaceState({ selectedWorkspaceId: null }),
      people,
      OWNER,
      settings(),
    ),
  ).toMatchObject({ ownershipOffer: null, maxUnclaimedMembers: null });
  // Without a loaded view, nothing either.
  expect(peopleView(workspaceState(), people, OWNER)).toMatchObject({
    ownershipOffer: null,
    maxUnclaimedMembers: null,
  });
  const shown = view(OWNER);
  expect(Object.isFrozen(shown.ownershipOffer)).toBe(true);
  expect(Object.keys(shown.ownershipOffer ?? {}).sort()).toEqual([
    "expiresAt",
    "memberId",
  ]);
  expect(PeopleViewSchema.safeParse(shown).success).toBe(true);
});

test("an offer to a plain member crosses to that member without the limit, and not to an admin who is not its target", () => {
  const expiresAt = "2026-11-12T10:00:00.000Z";
  const MEMBER = id(0xc5) as MemberId;
  const people = [...PEOPLE, person(MEMBER, "Mary Member")];
  const view = (own: MemberId) =>
    peopleView(workspaceState(), people, own, {
      ownershipOffer: Object.freeze({ memberId: MEMBER, expiresAt }),
      unclaimedMemberLimit: 40,
      now: Date.parse(expiresAt) - 1,
    });

  expect(view(MEMBER)).toMatchObject({
    ownershipOffer: { memberId: MEMBER, expiresAt },
    maxUnclaimedMembers: null,
  });
  expect(view(ADMIN)).toMatchObject({
    ownershipOffer: null,
    maxUnclaimedMembers: 40,
  });
  expect(view(OWNER)).toMatchObject({
    ownershipOffer: { memberId: MEMBER, expiresAt },
    maxUnclaimedMembers: 40,
  });
});

test("the channels read the offer and the limit from the service, and the offer's expiry with the clock", () => {
  const expiresAt = "2026-11-12T10:00:00.000Z";
  const fake = fakeService();
  let clock = Date.parse(expiresAt) - 1;
  const { call } = register({
    ...fake.options,
    workspaces: {
      ...fake.options.workspaces,
      ownershipOffer: () => Object.freeze({ memberId: ADMIN, expiresAt }),
      unclaimedMemberLimit: () => 7,
    },
    now: () => clock,
  });

  expect(call(INVOKE_CHANNELS.getPeopleState)).toMatchObject({
    ownershipOffer: { memberId: ADMIN, expiresAt },
    maxUnclaimedMembers: 7,
  });
  clock += 1;
  expect(call(INVOKE_CHANNELS.getPeopleState).ownershipOffer).toBeNull();
});

test("the status follows the workspace state, with no_workspace once the list loaded without a selection", () => {
  const view = (overrides: Partial<WorkspaceState>) =>
    peopleView(workspaceState(overrides), PEOPLE, OWNER);

  expect(view({ status: "signed_out", selectedWorkspaceId: null })).toEqual(
    expect.objectContaining({
      status: "signed_out",
      workspaceId: null,
      workspaceName: null,
      ownMemberId: null,
    }),
  );
  expect(view({ status: "loading", selectedWorkspaceId: null }).status).toBe(
    "loading",
  );
  expect(view({ status: "loading" }).status).toBe("loading");
  expect(view({ status: "ready", selectedWorkspaceId: null })).toEqual(
    expect.objectContaining({
      status: "no_workspace",
      workspaceId: null,
      workspaceName: null,
      ownMemberId: null,
    }),
  );
  expect(view({ status: "ready" }).status).toBe("ready");
  // An unavailable state keeps the people that were loaded before.
  const unavailable = view({ status: "unavailable", problem: "rate_limited" });
  expect(unavailable).toEqual(
    expect.objectContaining({
      status: "unavailable",
      problem: "rate_limited",
      ownMemberId: OWNER,
    }),
  );
  expect(unavailable.people).toHaveLength(PEOPLE.length);
  expect(
    view({ status: "unavailable", selectedWorkspaceId: null }),
  ).toMatchObject({ status: "unavailable", problem: "failed" });
  for (const status of WORKSPACE_STATUSES) {
    expect(
      PeopleViewSchema.safeParse(
        view({ status, problem: "failed" } as Partial<WorkspaceState>),
      ).success,
    ).toBe(true);
  }
});

test("the view names the selected workspace from the workspace list, cut to the limit, with the state's revision", () => {
  const face = "\u{1f600}";
  const other = id(0xa2) as WorkspaceId;
  const workspaces = Object.freeze([
    Object.freeze({ id: other, name: "Workspace Beta" }),
    Object.freeze({
      id: WORKSPACE,
      name: face.repeat(WORKSPACE_LIMITS.name + 5),
    }),
  ]);
  const view = peopleView(
    workspaceState({ revision: 9, workspaces }),
    PEOPLE,
    OWNER,
  );
  expect(view.revision).toBe(9);
  expect(view.workspaceName).toBe(face.repeat(WORKSPACE_LIMITS.name));
  expect(PeopleViewSchema.safeParse(view).success).toBe(true);
  expect(
    peopleView(
      workspaceState({ workspaces, selectedWorkspaceId: other }),
      [],
      null,
    ).workspaceName,
  ).toBe("Workspace Beta");
  // A selection that the list does not hold, or none, names nothing.
  expect(
    peopleView(workspaceState({ workspaces: Object.freeze([]) }), PEOPLE, OWNER)
      .workspaceName,
  ).toBeNull();
  expect(
    peopleView(
      workspaceState({ workspaces, selectedWorkspaceId: null }),
      [],
      null,
    ).workspaceName,
  ).toBeNull();
});

test("no user ID, device ID, or other key of the service crosses", () => {
  const leaky = [
    {
      ...person(OWNER, "Ada Lovelace", { role: "owner" }),
      userId: USER_ID,
      identity: { login: "octocat", verifiedAt: AT, userId: USER_ID },
      deviceId: DEVICE_ID,
    },
  ] as unknown as readonly PersonState[];
  const fake = fakeService(workspaceState(), leaky);
  const { call, subscribe } = register(fake.options);
  const { payloads } = subscribe();
  fake.set({}, leaky);
  fake.fire();

  const views = [
    peopleView(workspaceState(), leaky, OWNER),
    call(INVOKE_CHANNELS.getPeopleState),
    ...payloads(),
  ];
  expect(views).toHaveLength(3);
  for (const view of views) {
    const text = JSON.stringify(view);
    expect(text).not.toContain(USER_ID);
    expect(text).not.toContain(DEVICE_ID);
    expect(Object.keys(view.people[0] ?? {}).sort()).toEqual([
      "claimed",
      "displayName",
      "former",
      "login",
      "memberId",
      "role",
      "verifiedAt",
    ]);
  }
});

test("at most the limit of people crosses, the active people before the former members, with a count of the rest, and names are cut in characters", () => {
  const face = "\u{1F600}";
  const active = Array.from({ length: PEOPLE_LIMITS.people - 1 }, (_, n) =>
    person(id(0x5000 + n) as MemberId, `Person ${n}`),
  );
  const former = Array.from({ length: 6 }, (_, n) =>
    person(id(0x7000 + n) as MemberId, `Former ${n}`, { removedAt: AT }),
  );
  const long = person(id(0x6000) as MemberId, face.repeat(70));
  // The service's order mixes them; the former members go last.
  const people = [former[0], long, ...active, ...former.slice(1)].filter(
    (entry) => entry !== undefined,
  );
  const view = peopleView(workspaceState(), people, OWNER);

  expect(view.people).toHaveLength(PEOPLE_LIMITS.people);
  expect(view.people[0]?.displayName).toBe(
    face.repeat(PEOPLE_LIMITS.displayName),
  );
  expect(
    view.people.slice(1, PEOPLE_LIMITS.people).map((p) => p.memberId),
  ).toEqual(active.map((p) => p.id));
  expect(view.people.some((p) => p.former)).toBe(false);
  expect(view.morePeople).toBe(6);
  expect(PeopleViewSchema.safeParse(view).success).toBe(true);

  // At the limit, nothing is left out, and the former members come last.
  const atLimit = peopleView(
    workspaceState(),
    [former[0], ...active].filter((entry) => entry !== undefined),
    OWNER,
  );
  expect(atLimit.people).toHaveLength(PEOPLE_LIMITS.people);
  expect(atLimit.morePeople).toBe(0);
  expect(atLimit.people.at(-1)?.memberId).toBe(former[0]?.id);
});

test("the view is a frozen copy that shares no object with the service's people", () => {
  const view = peopleView(workspaceState(), PEOPLE, OWNER);

  expect(view.revision).toBe(3);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.people)).toBe(true);
  expect(view.people).not.toBe(PEOPLE);
  for (const [index, entry] of view.people.entries()) {
    expect(Object.isFrozen(entry)).toBe(true);
    expect(PEOPLE).not.toContain(entry);
    expect(entry).not.toBe(PEOPLE[index]);
  }
});

test("a burst of changes publishes once, after the interval, with the last people", () => {
  const fake = fakeService(
    workspaceState({ revision: 0, status: "loading" }),
    [],
  );
  const { subscribe, call } = register(fake.options);
  const { first, payloads } = subscribe();
  expect(first.status).toBe("loading");
  expect(first.revision).toBe(0);

  fake.set({ status: "ready" }, PEOPLE.slice(0, 1));
  expect(fake.timers).toHaveLength(1);
  const [timer] = fake.timers;
  expect(timer?.delayMs).toBe(PEOPLE_PUBLISH_INTERVAL_MS);
  // The later changes of the burst neither cancel the timer nor add one:
  // the first change sets when the view goes out.
  fake.set({ status: "ready" }, PEOPLE.slice(0, 2));
  fake.set({ status: "ready" }, PEOPLE);
  expect(payloads()).toEqual([]);
  expect(fake.timers).toEqual([timer]);
  expect(timer?.cancelled).toBe(false);
  // A call meanwhile already answers with the latest view.
  expect(call(INVOKE_CHANNELS.getPeopleState).revision).toBe(3);

  fake.fire();
  expect(payloads()).toHaveLength(1);
  const [sent] = payloads();
  expect(sent?.revision).toBe(3);
  expect(sent?.people).toHaveLength(PEOPLE.length);

  // The next change waits for its own interval.
  fake.set({ status: "ready" }, PEOPLE.slice(0, 1));
  expect(fake.waiting()).toHaveLength(1);
  fake.fire();
  expect(payloads().map((view) => view.revision)).toEqual([3, 4]);
  expect(payloads()[1]?.people).toHaveLength(1);
  expect(fake.errors).toEqual([]);
});

test("close cancels the waiting publish and stops listening", () => {
  const fake = fakeService();
  const { subscribe, peopleIpc } = register(fake.options);
  const { payloads } = subscribe();
  fake.set({}, PEOPLE.slice(0, 2));
  const [timer] = fake.waiting();

  peopleIpc.close();
  expect(timer?.cancelled).toBe(true);
  expect(fake.listeners.size).toBe(0);
  timer?.callback();
  fake.fire();
  expect(payloads()).toEqual([]);
  peopleIpc.close();
});

test("a view that the contract refuses is reported, not sent", () => {
  const fake = fakeService();
  const { subscribe } = register(fake.options);
  const { payloads } = subscribe();
  fake.set({}, [
    { ...person(OWNER, "Ada Lovelace"), id: "not-an-id" as MemberId },
  ]);
  fake.fire();

  expect(payloads()).toEqual([]);
  expect(fake.errors).toEqual(["Sending the people failed."]);

  // The next change is scheduled and sent again.
  fake.set({}, PEOPLE);
  expect(fake.waiting()).toHaveLength(1);
  fake.fire();
  expect(payloads().map((view) => view.revision)).toEqual([5]);
  expect(fake.errors).toHaveLength(1);
});

test("getState answers without subscribing the caller", () => {
  const fake = fakeService();
  const { call } = register(fake.options);
  const caller = receiver();

  expect(call(INVOKE_CHANNELS.getPeopleState, caller).revision).toBe(3);
  fake.set({}, PEOPLE.slice(0, 1));
  fake.fire();

  expect(caller.sent).toEqual([]);
});

test("the contract's statuses, roles, problems, and limits match the service and the protocol", () => {
  expect([...PERSON_ROLES]).toEqual([...MEMBER_ROLES]);
  expect(PEOPLE_LIMITS.people).toBe(MAX_ANSWER_LIST_ITEMS);
  expect(PEOPLE_LIMITS.displayName).toBe(LIMITS.displayName);
  expect(PEOPLE_LIMITS.maxUnclaimedMembers).toBe(UNCLAIMED_MEMBER_LIMIT.max);
  // Every status of the workspace service has a people status, plus the
  // one without a selected workspace.
  expect([...PEOPLE_STATUSES].sort()).toEqual(
    [...WORKSPACE_STATUSES, "no_workspace"].sort(),
  );
  for (const problem of WORKSPACE_PROBLEMS) {
    const view = peopleView(
      workspaceState({ status: "unavailable", problem }),
      PEOPLE,
      OWNER,
    );
    expect(view).toMatchObject({ status: "unavailable", problem });
  }
});

// The real workspace service, end to end.

const SIGNED_IN = Object.freeze({
  revision: 1,
  account: Object.freeze({
    kind: "signed_in",
    login: "octocat",
    displayName: "The Octocat",
    deviceId: DEVICE_ID,
    signInExpiresAt: "2026-12-02T10:00:00.000Z",
  }),
  signIn: Object.freeze({ kind: "idle" }),
  lastOutcome: null,
  deviceKey: "ready",
  replacementPending: false,
  apiOrigin: "set",
  device: "signed_in",
}) satisfies AccountStatus;

function member(
  memberId: string,
  displayName: string,
  role: "owner" | "admin" | "member",
  userId: string | null,
) {
  return {
    id: memberId,
    workspaceId: WORKSPACE,
    displayName,
    role,
    userId,
    identity:
      userId === null
        ? null
        : { provider: "github", login: "octocat", verifiedAt: AT },
    removedAt: null,
  };
}

function decoded(input: Record<string, unknown>): ServerMessage {
  const result = decodeServerMessage({ protocolVersion: 0, ...input });
  if (!result.ok) {
    throw new Error("The test message does not decode");
  }
  return result.kind === "frame"
    ? { kind: "frame", frame: result.frame }
    : { kind: "event", event: result.event };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("with the real workspace service, the people of its view and of a claim cross without any user ID", async () => {
  const messageListeners = new Set<(message: ServerMessage) => void>();
  const account: WorkspaceAccount = {
    status: () => SIGNED_IN,
    onStatusChange: () => () => undefined,
    readWorkspaceData: ((name: string) => {
      switch (name) {
        case "listWorkspaces":
          return Promise.resolve({
            ok: true,
            value: {
              workspaces: [
                {
                  workspace: { id: WORKSPACE, name: "Workspace Alpha" },
                  member: member(OWNER, "Ada Lovelace", "owner", USER_ID),
                },
              ],
            },
          });
        case "getWorkspace":
          return Promise.resolve({
            ok: true,
            value: {
              workspace: { id: WORKSPACE, name: "Workspace Alpha" },
              members: [
                member(OWNER, "Ada Lovelace", "owner", USER_ID),
                member(UNCLAIMED, "Linus Newcomer", "member", null),
              ],
              joinRequestsPausedAt: null,
              maxUnclaimedMembers: 500,
              ownershipOffer: null,
            },
          });
        default:
          return Promise.resolve({ ok: true, value: { projects: [] } });
      }
    }) as unknown as (name: string) => Promise<WorkspaceReadResult<unknown>>,
  } as WorkspaceAccount;
  const connection = {
    status: () => ({ state: "connected", revision: 1 }),
    onStatusChange: () => () => undefined,
    onMessage: (listener: (message: ServerMessage) => void) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    subscribeWorkspace: () => undefined,
    unsubscribeWorkspace: () => undefined,
  } as unknown as WorkspaceConnection;
  const receive = (message: ServerMessage) => {
    for (const listener of [...messageListeners]) {
      listener(message);
    }
  };
  const service = createWorkspaceService({ account, connection });
  const timers: (() => void)[] = [];
  const { call, subscribe } = register({
    workspaces: service,
    scheduleTimer: (callback) => {
      timers.push(callback);
      return () => undefined;
    },
  });
  await settle();
  receive(
    decoded({
      type: "workspace.subscribed",
      workspaceId: WORKSPACE,
      onlineMemberIds: [],
    }),
  );
  await settle();
  const { first, payloads } = subscribe();
  expect(first).toMatchObject({
    status: "ready",
    workspaceId: WORKSPACE,
    workspaceName: "Workspace Alpha",
    ownMemberId: OWNER,
  });
  expect(first.people.map((entry) => [entry.memberId, entry.claimed])).toEqual([
    [OWNER, true],
    [UNCLAIMED, false],
  ]);

  receive(
    decoded({
      id: id(0x9001),
      occurredAt: LATER,
      workspaceId: WORKSPACE,
      actor: { kind: "system" },
      deviceId: null,
      type: "workspace.member.claimed",
      payload: {
        member: {
          ...member(UNCLAIMED, "Linus Newcomer", "member", OTHER_USER_ID),
          identity: { provider: "github", login: "linus", verifiedAt: LATER },
        },
      },
    }),
  );
  for (const timer of timers.splice(0)) {
    timer();
  }
  const [sent] = payloads();
  expect(sent?.people[1]).toEqual({
    memberId: UNCLAIMED,
    displayName: "Linus Newcomer",
    role: "member",
    claimed: true,
    login: "linus",
    verifiedAt: LATER,
    former: false,
  });
  for (const view of [first, sent, call(INVOKE_CHANNELS.getPeopleState)]) {
    const text = JSON.stringify(view);
    expect(text).not.toContain(USER_ID);
    expect(text).not.toContain(OTHER_USER_ID);
    expect(text).not.toContain(DEVICE_ID);
  }
  service.close();
});
