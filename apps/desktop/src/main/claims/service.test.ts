import {
  ClaimListResponseSchema,
  decodeServerMessage,
  type MemberId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import type { WorkspaceReadResult } from "../api-reads.ts";
import type { ServerMessage } from "../connection/client.ts";
import type {
  PersonState,
  WorkspaceService,
  WorkspaceState,
} from "../workspace/service.ts";
import {
  type ClaimSeenEntry,
  type ClaimSeenRead,
  MAX_CLAIM_SEEN_ENTRIES,
  MAX_SEEN_CLAIMS_PER_ENTRY,
} from "./seen-store.ts";
import {
  CLAIM_LOAD_COOLDOWN_MS,
  type ClaimConnection,
  type ClaimServiceOptions,
  createClaimService,
} from "./service.ts";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OTHER_WORKSPACE = id(0xa2) as WorkspaceId;
const OWN = id(0xc1) as MemberId;
const OTHER = id(0xc3) as MemberId;
/** The account's own person after another account signed in. */
const NEXT_OWN = id(0xc4) as MemberId;
const FIRST = id(0xd1) as MemberId;
const SECOND = id(0xd2) as MemberId;
const THIRD = id(0xd3) as MemberId;
/** A claimed person that the list does not hold. */
const OUTSIDER = id(0xd9) as MemberId;
/** A claimed person whose claim left the list. */
const GONE = id(0xd0) as MemberId;
const CLAIMER_USER_ID = id(0xb9);
const T1 = "2026-11-05T10:00:00.000Z";
const T2 = "2026-11-05T11:00:00.000Z";
const T3 = "2026-11-05T12:00:00.000Z";
const ACCOUNT_CREATED_AT = "2026-11-01T03:04:05.000Z";

function person(
  memberId: MemberId,
  role: PersonState["role"],
  removedAt: string | null = null,
): PersonState {
  return Object.freeze({
    id: memberId,
    displayName: "Ada Owner",
    role,
    claimed: true,
    identity: null,
    removedAt,
  });
}

/**
 * The workspace service's state, people, own person, and gate, which the
 * test changes and then reports with `set`.
 */
function fakeWorkspaces() {
  let revision = 0;
  let status: WorkspaceState["status"] = "ready";
  let selected: WorkspaceId | null = WORKSPACE;
  let people: readonly PersonState[] = [person(OWN, "owner")];
  let own: MemberId | null = OWN;
  let gateLive = true;
  const listeners = new Set<(state: WorkspaceState) => void>();
  const state = (): WorkspaceState =>
    Object.freeze({
      revision,
      status,
      workspaces: Object.freeze([]),
      selectedWorkspaceId: selected,
      projects: Object.freeze([]),
      openProjectId: null,
    });
  const workspaces: Pick<
    WorkspaceService,
    "state" | "onChange" | "people" | "ownMemberId" | "gateLive"
  > = {
    state,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    people: () => people,
    ownMemberId: (workspaceId) => (workspaceId === selected ? own : null),
    gateLive: (workspaceId) => workspaceId === selected && gateLive,
  };
  return {
    workspaces,
    listeners: () => listeners.size,
    set(next: {
      status?: WorkspaceState["status"];
      selected?: WorkspaceId | null;
      people?: readonly PersonState[];
      own?: MemberId | null;
      gateLive?: boolean;
    }) {
      status = next.status ?? status;
      selected = next.selected === undefined ? selected : next.selected;
      people = next.people ?? people;
      own = next.own === undefined ? own : next.own;
      gateLive = next.gateLive ?? gateLive;
      revision += 1;
      for (const listener of [...listeners]) {
        listener(state());
      }
    },
  };
}

type ListResult = WorkspaceReadResult<
  ReturnType<typeof ClaimListResponseSchema.parse>
>;

/** The account's reads, each answered by the test. */
function fakeAccount() {
  const reads: {
    readonly name: string;
    readonly params: unknown;
    readonly resolve: (result: ListResult) => void;
    readonly reject: (error: unknown) => void;
  }[] = [];
  const account = {
    readWorkspaceData: (name: string, params: unknown) =>
      new Promise<ListResult>((resolve, reject) => {
        reads.push({ name, params, resolve, reject });
      }),
  } as unknown as ClaimServiceOptions["account"];
  return { account, reads };
}

function fakeConnection() {
  let state = "connected";
  const statusListeners = new Set<(status: { state: string }) => void>();
  const messageListeners = new Set<(message: ServerMessage) => void>();
  const connection = {
    status: () => ({ state, revision: 1 }),
    onStatusChange: (listener: (status: { state: string }) => void) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onMessage: (listener: (message: ServerMessage) => void) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
  } as unknown as ClaimConnection;
  return {
    connection,
    listeners: () => statusListeners.size + messageListeners.size,
    setState(next: string) {
      state = next;
      for (const listener of [...statusListeners]) {
        listener({ state: next });
      }
    },
    receive(message: ServerMessage) {
      for (const listener of [...messageListeners]) {
        listener(message);
      }
    },
  };
}

/**
 * The seen claims file: its read answers what the test gives, and each
 * write is recorded and settled by the test, or at once with `autoWrite`.
 */
function fakeSeen(
  read: ClaimSeenRead | "unreadable" | "pending" = { kind: "none" },
  autoWrite = true,
) {
  const writes: {
    readonly entries: readonly ClaimSeenEntry[];
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }[] = [];
  let finishRead: (value: ClaimSeenRead) => void = () => undefined;
  let reads = 0;
  const seen = {
    read: () => {
      reads += 1;
      if (read === "unreadable") {
        return Promise.reject(new Error(`EACCES ${CLAIMER_USER_ID}`));
      }
      if (read === "pending") {
        return new Promise<ClaimSeenRead>((resolve) => {
          finishRead = resolve;
        });
      }
      return Promise.resolve(read);
    },
    write: (entries: readonly ClaimSeenEntry[]) =>
      new Promise<void>((resolve, reject) => {
        writes.push({ entries, resolve, reject });
        if (autoWrite) {
          resolve();
        }
      }),
  };
  return {
    seen,
    writes,
    reads: () => reads,
    finishRead: (value: ClaimSeenRead) => finishRead(value),
  };
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
    retries: () =>
      timers.filter((timer) => timer.active).map((timer) => timer.delayMs),
    fire() {
      const due = timers.filter((timer) => timer.active);
      for (const timer of due) {
        timer.active = false;
        timer.callback();
      }
    },
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

function subscribed(workspaceId: WorkspaceId = WORKSPACE): ServerMessage {
  return decoded({
    type: "workspace.subscribed",
    workspaceId,
    onlineMemberIds: [],
  });
}

let eventCount = 0;

function workspaceEvent(
  type: string,
  payload: Record<string, unknown>,
  workspaceId: WorkspaceId = WORKSPACE,
): ServerMessage {
  eventCount += 1;
  return decoded({
    id: id(0x9000 + eventCount),
    occurredAt: T3,
    workspaceId,
    actor: { kind: "system" },
    deviceId: null,
    type,
    payload,
  });
}

function claimedEvent(
  memberId: MemberId = THIRD,
  workspaceId: WorkspaceId = WORKSPACE,
): ServerMessage {
  return workspaceEvent(
    "workspace.member.claimed",
    {
      member: {
        id: memberId,
        workspaceId,
        displayName: "Grace Invitee",
        role: "member",
        userId: CLAIMER_USER_ID,
        identity: { provider: "github", login: "grace", verifiedAt: T3 },
        removedAt: null,
      },
    },
    workspaceId,
  );
}

function removed(
  memberId: MemberId,
  workspaceId: WorkspaceId = WORKSPACE,
): ServerMessage {
  return workspaceEvent(
    "workspace.member.removed",
    { memberId, removedAt: T3 },
    workspaceId,
  );
}

function roleChanged(memberId: MemberId, role: "admin" | "member") {
  return workspaceEvent("workspace.member.role_changed", { memberId, role });
}

/** A claim as the API lists it. */
function claim(
  memberId: MemberId,
  claimedAt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    workspaceId: WORKSPACE,
    memberId,
    claimer: {
      provider: "github",
      login: "linus",
      verifiedAt: T1,
      accountCreatedAt: ACCOUNT_CREATED_AT,
    },
    via: "invitation",
    claimedAt,
    ...overrides,
  };
}

function list(...items: readonly Record<string, unknown>[]): ListResult {
  return {
    ok: true,
    value: ClaimListResponseSchema.parse({ claims: items }),
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function setup(seenFile = fakeSeen()) {
  const workspaces = fakeWorkspaces();
  const account = fakeAccount();
  const connection = fakeConnection();
  const timers = fakeTimers();
  const logs: string[] = [];
  let monotonic = 10_000;
  const service = createClaimService({
    account: account.account,
    connection: connection.connection,
    workspaces: workspaces.workspaces,
    seen: seenFile.seen,
    scheduleTimer: timers.schedule,
    now: () => monotonic,
    log: (message) => logs.push(message),
  });
  const ids = () => service.state().claims.map((entry) => entry.memberId);
  const unseen = () =>
    service
      .state()
      .claims.filter((entry) => entry.unseen)
      .map((entry) => entry.memberId);
  return {
    service,
    workspaces,
    account,
    connection,
    timers,
    seen: seenFile,
    logs,
    ids,
    unseen,
    advance: (ms: number) => {
      monotonic += ms;
    },
  };
}

/** A setup whose list loaded once with `items`. */
async function loadedWith(...items: readonly Record<string, unknown>[]) {
  const live = setup();
  await settle();
  live.account.reads[0]?.resolve(list(...items));
  await settle();
  return live;
}

test("the claims load without the screen asking once the seen claims are read, and the state holds each claim without a user ID", async () => {
  const live = setup();
  expect(live.service.state()).toEqual({
    revision: 0,
    status: "loading",
    workspaceId: WORKSPACE,
    claims: [],
  });
  // Nothing is read before the seen claims file.
  expect(live.account.reads).toEqual([]);
  await settle();
  expect(live.seen.reads()).toBe(1);
  expect(live.account.reads.map((read) => [read.name, read.params])).toEqual([
    ["listClaims", { workspaceId: WORKSPACE }],
  ]);
  live.account.reads[0]?.resolve(
    list(
      claim(FIRST, T2, { via: "join_request" }),
      claim(SECOND, T1, { claimer: null }),
    ),
  );
  await settle();
  const state = live.service.state();
  expect(state).toEqual({
    revision: 2,
    status: "ready",
    workspaceId: WORKSPACE,
    claims: [
      {
        memberId: FIRST,
        claimer: {
          login: "linus",
          verifiedAt: T1,
          accountCreatedAt: ACCOUNT_CREATED_AT,
        },
        via: "join_request",
        claimedAt: T2,
        unseen: true,
      },
      {
        memberId: SECOND,
        claimer: null,
        via: "invitation",
        claimedAt: T1,
        unseen: true,
      },
    ],
  });
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state.claims)).toBe(true);
  expect(Object.isFrozen(state.claims[0])).toBe(true);
  expect(Object.isFrozen(state.claims[0]?.claimer)).toBe(true);
  const text = JSON.stringify(state);
  expect(text).not.toContain("provider");
  expect(text).not.toContain(CLAIMER_USER_ID);
});

test("a list that names another workspace is a failure, and what was loaded before stays", async () => {
  const live = await loadedWith(claim(FIRST, T1));
  live.connection.receive(claimedEvent());
  live.account.reads[1]?.resolve(
    list(claim(SECOND, T2, { workspaceId: OTHER_WORKSPACE })),
  );
  await settle();
  expect(live.service.state()).toMatchObject({
    status: "unavailable",
    problem: "failed",
  });
  expect(live.ids()).toEqual([FIRST]);
});

test("while the account's own role is member, nothing loads and a claim is ignored; while the role is not known, nothing loads until it is", async () => {
  const member = setup();
  member.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "member")],
  });
  await settle();
  member.connection.receive(subscribed());
  member.connection.receive(claimedEvent());
  expect(member.account.reads).toEqual([]);
  expect(member.service.state()).toMatchObject({
    status: "not_allowed",
    claims: [],
  });
  expect(member.service.load()).toEqual({
    outcome: "refused",
    reason: "not_allowed",
  });

  // A removed own person, as a former owner, is not allowed either.
  member.workspaces.set({ people: [person(OWN, "owner", T1)] });
  expect(member.service.state().status).toBe("not_allowed");
  expect(member.account.reads).toEqual([]);

  const unknown = setup();
  unknown.workspaces.set({ people: [] });
  await settle();
  unknown.connection.receive(claimedEvent());
  expect(unknown.service.load()).toEqual({ outcome: "loading" });
  expect(unknown.account.reads).toEqual([]);
  expect(unknown.service.state().status).toBe("loading");
  unknown.workspaces.set({ people: [person(OWN, "admin")] });
  expect(unknown.account.reads).toHaveLength(1);
});

test("a demotion that the people show drops the claims at once and reads nothing; a promotion loads them", async () => {
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  await settle();
  live.account.reads[0]?.resolve(list(claim(FIRST, T1)));
  await settle();
  // A load on its way is dropped with the demotion.
  live.connection.receive(claimedEvent());
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "member")],
  });
  expect(live.service.state()).toMatchObject({
    status: "not_allowed",
    claims: [],
  });
  live.account.reads[1]?.resolve(list(claim(FIRST, T1)));
  await settle();
  expect(live.service.state()).toMatchObject({
    status: "not_allowed",
    claims: [],
  });

  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  expect(live.account.reads).toHaveLength(3);
});

test("the demotion of the account's own person drops the claims at once when its event comes while the workspace service's gate holds it, and nothing loads until the people show the role", async () => {
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  await settle();
  live.account.reads[0]?.resolve(list(claim(FIRST, T1)));
  await settle();

  // The workspace reloads, so its gate holds the event; the people still
  // show the account's own person as an admin.
  live.workspaces.set({ gateLive: false });
  live.connection.receive(roleChanged(OWN, "member"));
  expect(live.service.state()).toMatchObject({
    status: "not_allowed",
    claims: [],
  });
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "not_allowed",
  });
  expect(live.service.markSeen(WORKSPACE, [FIRST])).toEqual({
    outcome: "refused",
    reason: "not_allowed",
  });

  // Other changes of the workspace while the people still show the old
  // role, and the triggers, read nothing.
  live.workspaces.set({ gateLive: false });
  live.connection.receive(claimedEvent());
  live.connection.receive(subscribed());
  expect(live.service.state().status).toBe("not_allowed");

  // The reload answers with the event applied.
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "member")],
    gateLive: true,
  });
  expect(live.service.state().status).toBe("not_allowed");
  expect(live.account.reads).toHaveLength(1);
});

test("a demotion event keeps the claims dropped after the gate is live only while the people show the demotion; a promotion that only a reload shows loads", async () => {
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  await settle();
  live.account.reads[0]?.resolve(list(claim(FIRST, T1)));
  await settle();

  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "member")],
  });
  live.connection.receive(roleChanged(OWN, "member"));
  expect(live.service.state().status).toBe("not_allowed");
  expect(live.account.reads).toHaveLength(1);

  // A promotion that only a reload shows, for example after a reconnect.
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  expect(live.account.reads).toHaveLength(2);
});

test("a live gate ends the demotion that an event reported, so that the people decide again", async () => {
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  await settle();
  live.account.reads[0]?.resolve(list(claim(FIRST, T1)));
  await settle();

  // An event for the account's own person whose reload shows it as an
  // admin again, for example a demotion and a promotion that the reload
  // both holds.
  live.workspaces.set({ gateLive: false });
  live.connection.receive(roleChanged(OWN, "member"));
  expect(live.service.state().status).toBe("not_allowed");
  live.workspaces.set({ gateLive: true });
  expect(live.service.state().status).toBe("loading");
  expect(live.account.reads).toHaveLength(2);
});

test("a promotion event after a demotion event, while the gate holds both, lets the people decide again, and the load waits for the gate", async () => {
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  await settle();
  live.account.reads[0]?.resolve(list(claim(FIRST, T1)));
  await settle();

  live.workspaces.set({ gateLive: false });
  live.connection.receive(roleChanged(OWN, "member"));
  expect(live.service.state().status).toBe("not_allowed");
  live.connection.receive(roleChanged(OWN, "admin"));
  expect(live.service.state().status).toBe("loading");
  expect(live.account.reads).toHaveLength(1);

  live.workspaces.set({ gateLive: true });
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve(list(claim(SECOND, T2)));
  await settle();
  expect(live.ids()).toEqual([SECOND]);
});

test("a load waits until the workspace service's gate is live, so that a reconnect after a demotion reads nothing and drops the claims", async () => {
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  await settle();
  live.account.reads[0]?.resolve(list(claim(FIRST, T1)));
  await settle();

  // A reconnect: the workspace reloads after workspace.subscribed, and the
  // demotion happened while the device was offline.
  live.connection.setState("offline");
  live.connection.setState("connected");
  live.workspaces.set({ gateLive: false });
  live.connection.receive(subscribed());
  expect(live.account.reads).toHaveLength(1);
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "member")],
    gateLive: true,
  });
  expect(live.service.state()).toMatchObject({
    status: "not_allowed",
    claims: [],
  });
  expect(live.account.reads).toHaveLength(1);

  // The first load also waits for the gate.
  const first = setup();
  first.workspaces.set({ gateLive: false });
  await settle();
  expect(first.account.reads).toEqual([]);
  first.workspaces.set({ gateLive: true });
  expect(first.account.reads).toHaveLength(1);
});

test("workspace.subscribed and a claim of the selected workspace load again; the same of another workspace, a removal, and a role change of another person do not", async () => {
  const live = await loadedWith(claim(FIRST, T1));
  live.connection.receive(subscribed(OTHER_WORKSPACE));
  live.connection.receive(claimedEvent(THIRD, OTHER_WORKSPACE));
  live.connection.receive(removed(FIRST));
  live.connection.receive(roleChanged(OTHER, "member"));
  live.connection.receive(roleChanged(OTHER, "admin"));
  await settle();
  expect(live.account.reads).toHaveLength(1);

  let reads = 1;
  for (const trigger of [subscribed(), claimedEvent()]) {
    live.connection.receive(trigger);
    reads += 1;
    expect(live.account.reads).toHaveLength(reads);
    live.account.reads[reads - 1]?.resolve(
      list(claim(THIRD, T3), claim(FIRST, T1)),
    );
    await settle();
  }
  expect(live.ids()).toEqual([THIRD, FIRST]);
});

test("the screen's request loads at once, is refused without a device, a workspace, or the role, and within the cooldown is too_soon", async () => {
  const live = await loadedWith(claim(FIRST, T1));
  expect(live.service.load()).toEqual({ outcome: "loading" });
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve(list(claim(FIRST, T1)));
  await settle();
  live.advance(CLAIM_LOAD_COOLDOWN_MS - 1);
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "too_soon",
  });
  expect(live.account.reads).toHaveLength(2);
  live.advance(1);
  expect(live.service.load()).toEqual({ outcome: "loading" });
  expect(live.account.reads).toHaveLength(3);

  live.workspaces.set({ selected: null, people: [] });
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "no_workspace",
  });
  live.workspaces.set({ status: "signed_out" });
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
});

test("triggers while a load is on its way merge into one more load, and the older answer is dropped", async () => {
  const live = setup();
  await settle();
  live.connection.receive(subscribed());
  live.connection.receive(claimedEvent());
  live.connection.receive(claimedEvent());
  expect(live.account.reads).toHaveLength(1);

  live.account.reads[0]?.resolve(list(claim(FIRST, T1)));
  await settle();
  expect(live.service.state().status).toBe("loading");
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve(list(claim(SECOND, T2), claim(FIRST, T1)));
  await settle();
  expect(live.ids()).toEqual([SECOND, FIRST]);
  expect(live.account.reads).toHaveLength(2);
});

test("a failed load keeps what was loaded, shows the problem, and is retried with the workspace service's backoff; triggers during the backoff wait for the retry; rate_limited waits 60 seconds", async () => {
  const live = await loadedWith(claim(FIRST, T1));
  live.connection.receive(claimedEvent());
  live.account.reads[1]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.service.state()).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
    claims: [{ memberId: FIRST }],
  });
  expect(live.logs).toEqual(["The claims did not load (unavailable)."]);
  expect(live.timers.retries()).toEqual([2_000]);

  live.connection.receive(subscribed());
  live.connection.receive(claimedEvent());
  expect(live.account.reads).toHaveLength(2);

  live.timers.fire();
  expect(live.account.reads).toHaveLength(3);
  live.account.reads[2]?.resolve({ ok: false, reason: "failed" });
  await settle();
  expect(live.timers.retries()).toEqual([4_000]);
  live.timers.fire();
  live.account.reads[3]?.resolve(list(claim(SECOND, T2)));
  await settle();
  expect(live.service.state()).toMatchObject({ status: "ready" });
  expect(live.service.state()).not.toHaveProperty("problem");

  live.connection.receive(claimedEvent());
  live.connection.receive(claimedEvent());
  live.account.reads[4]?.resolve({ ok: false, reason: "rate_limited" });
  await settle();
  expect(live.account.reads).toHaveLength(5);
  expect(live.timers.retries()).toEqual([60_000]);
});

test("a read that rejects is unavailable; offline, a failure schedules no retry and the next workspace.subscribed loads", async () => {
  const live = setup();
  await settle();
  live.account.reads[0]?.reject(new Error("no answer"));
  await settle();
  expect(live.service.state()).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
  });
  live.connection.setState("offline");
  expect(live.timers.pending()).toEqual([]);
  live.connection.receive(subscribed());
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.timers.pending()).toEqual([]);
});

test("another workspace, a sign-out, and another device drop the claims and the answers on their way", async () => {
  const live = await loadedWith(claim(FIRST, T1));
  live.connection.receive(claimedEvent());
  live.workspaces.set({ selected: OTHER_WORKSPACE, people: [] });
  expect(live.service.state()).toMatchObject({
    status: "loading",
    workspaceId: OTHER_WORKSPACE,
    claims: [],
  });
  live.account.reads[1]?.resolve(list(claim(SECOND, T2)));
  await settle();
  expect(live.service.state().claims).toEqual([]);

  live.workspaces.set({ selected: WORKSPACE, people: [person(OWN, "owner")] });
  expect(live.account.reads[2]?.params).toEqual({ workspaceId: WORKSPACE });
  live.account.reads[2]?.resolve(list(claim(FIRST, T1)));
  await settle();
  expect(live.ids()).toEqual([FIRST]);

  live.workspaces.set({ status: "signed_out", selected: null, people: [] });
  expect(live.service.state()).toMatchObject({
    status: "signed_out",
    workspaceId: null,
    claims: [],
  });
});

test("without seen claims every claim is unseen, except the account's own claim", async () => {
  const live = await loadedWith(
    claim(FIRST, T3),
    claim(OWN, T2, { via: "join_request" }),
    claim(SECOND, T1),
  );
  expect(live.unseen()).toEqual([FIRST, SECOND]);
  expect(live.ids()).toEqual([FIRST, OWN, SECOND]);
});

test("markSeen counts the reported claims that the list holds and ignores the others; the entry keeps the seen claims of the latest list, the most recent first", async () => {
  const live = await loadedWith(
    claim(THIRD, T3),
    claim(SECOND, T2),
    claim(FIRST, T1),
  );
  const revision = live.service.state().revision;
  expect(live.service.markSeen(WORKSPACE, [SECOND])).toEqual({ outcome: "ok" });
  expect(live.unseen()).toEqual([THIRD, FIRST]);
  expect(live.service.state().revision).toBe(revision + 1);
  await settle();
  expect(live.seen.writes.map((write) => write.entries)).toEqual([
    [{ workspaceId: WORKSPACE, ownMemberId: OWN, seenMemberIds: [SECOND] }],
  ]);

  // Seen already: nothing changes, and nothing is written.
  expect(live.service.markSeen(WORKSPACE, [SECOND, SECOND])).toEqual({
    outcome: "ok",
  });
  expect(live.service.state().revision).toBe(revision + 1);
  await settle();
  expect(live.seen.writes).toHaveLength(1);

  // Only claims that the list holds, of the selected workspace.
  expect(live.service.markSeen(WORKSPACE, [OUTSIDER])).toEqual({
    outcome: "refused",
    reason: "not_listed",
  });
  expect(live.service.markSeen(WORKSPACE, [])).toEqual({
    outcome: "refused",
    reason: "not_listed",
  });
  expect(live.service.markSeen(OTHER_WORKSPACE, [THIRD])).toEqual({
    outcome: "refused",
    reason: "not_selected",
  });
  expect(live.unseen()).toEqual([THIRD, FIRST]);

  // A claim that the list does not hold is ignored beside one that it does.
  expect(live.service.markSeen(WORKSPACE, [OUTSIDER, FIRST])).toEqual({
    outcome: "ok",
  });
  expect(live.unseen()).toEqual([THIRD]);
  await settle();
  expect(live.seen.writes.at(-1)?.entries).toEqual([
    {
      workspaceId: WORKSPACE,
      ownMemberId: OWN,
      seenMemberIds: [SECOND, FIRST],
    },
  ]);

  expect(live.service.markSeen(WORKSPACE, [THIRD])).toEqual({ outcome: "ok" });
  expect(live.unseen()).toEqual([]);
  await settle();
  expect(live.seen.writes.at(-1)?.entries).toEqual([
    {
      workspaceId: WORKSPACE,
      ownMemberId: OWN,
      seenMemberIds: [THIRD, SECOND, FIRST],
    },
  ]);
});

test("a claim that commits late with an earlier time stays unseen until the screen reports it", async () => {
  const live = await loadedWith(claim(THIRD, T3), claim(FIRST, T1));
  live.service.markSeen(WORKSPACE, [THIRD, FIRST]);
  expect(live.unseen()).toEqual([]);

  // The API took the time of this claim before the one of the newest, but
  // committed it after.
  live.connection.receive(claimedEvent(SECOND));
  live.account.reads[1]?.resolve(
    list(claim(THIRD, T3), claim(SECOND, T2), claim(FIRST, T1)),
  );
  await settle();
  expect(live.unseen()).toEqual([SECOND]);
  live.service.markSeen(WORKSPACE, [SECOND]);
  expect(live.unseen()).toEqual([]);
});

test("a claim that left the list leaves the seen claims at the next write, and an entry holds at most the claims that the API lists", async () => {
  const live = setup(
    fakeSeen({
      kind: "entries",
      entries: [
        {
          workspaceId: WORKSPACE,
          ownMemberId: OWN,
          seenMemberIds: [GONE, FIRST],
        },
      ],
    }),
  );
  await settle();
  live.account.reads[0]?.resolve(list(claim(SECOND, T2), claim(FIRST, T1)));
  await settle();
  expect(live.unseen()).toEqual([SECOND]);
  live.service.markSeen(WORKSPACE, [SECOND]);
  await settle();
  expect(live.seen.writes.at(-1)?.entries).toEqual([
    {
      workspaceId: WORKSPACE,
      ownMemberId: OWN,
      seenMemberIds: [SECOND, FIRST],
    },
  ]);

  // A server that lists more claims than this desktop keeps: the most
  // recent ones stay seen.
  const many = Array.from(
    { length: MAX_SEEN_CLAIMS_PER_ENTRY + 2 },
    (_, index) => id(0x30000 + index) as MemberId,
  );
  live.connection.receive(claimedEvent());
  live.account.reads[1]?.resolve(
    list(...many.map((memberId) => claim(memberId, T1))),
  );
  await settle();
  live.service.markSeen(WORKSPACE, many);
  await settle();
  expect(live.seen.writes.at(-1)?.entries[0]?.seenMemberIds).toEqual(
    many.slice(0, MAX_SEEN_CLAIMS_PER_ENTRY),
  );
  // The older claims, which the entry cannot hold, are not new either.
  expect(live.unseen()).toEqual([]);
});

test("a claim behind the MAX_SEEN_CLAIMS_PER_ENTRY most recent ones of a list is never unseen, so a server that lists more leaves none new for good", async () => {
  const many = Array.from(
    { length: MAX_SEEN_CLAIMS_PER_ENTRY + 3 },
    (_, index) => id(0x30000 + index) as MemberId,
  );
  const live = await loadedWith(...many.map((memberId) => claim(memberId, T1)));
  expect(live.ids()).toEqual(many);
  // Without seen claims, only the most recent ones can be new.
  expect(live.unseen()).toEqual(many.slice(0, MAX_SEEN_CLAIMS_PER_ENTRY));
  live.service.markSeen(WORKSPACE, many.slice(0, MAX_SEEN_CLAIMS_PER_ENTRY));
  expect(live.unseen()).toEqual([]);
});

test("markSeen is refused before the claims loaded, without the role, without a workspace, and after close", async () => {
  const live = setup();
  await settle();
  expect(live.service.markSeen(WORKSPACE, [FIRST])).toEqual({
    outcome: "refused",
    reason: "not_listed",
  });
  live.account.reads[0]?.resolve(list(claim(FIRST, T1)));
  await settle();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "member")],
  });
  expect(live.service.markSeen(WORKSPACE, [FIRST])).toEqual({
    outcome: "refused",
    reason: "not_allowed",
  });
  live.workspaces.set({ selected: null, people: [] });
  expect(live.service.markSeen(WORKSPACE, [FIRST])).toEqual({
    outcome: "refused",
    reason: "not_selected",
  });
  live.service.close();
  expect(live.service.markSeen(WORKSPACE, [FIRST])).toEqual({
    outcome: "refused",
    reason: "not_selected",
  });
  expect(live.seen.writes).toEqual([]);
});

test("a claim made while the application was closed is unseen at the next start, and the seen ones stay seen", async () => {
  const seenFile = fakeSeen({
    kind: "entries",
    entries: [
      {
        workspaceId: WORKSPACE,
        ownMemberId: OWN,
        seenMemberIds: [SECOND, FIRST],
      },
    ],
  });
  const live = setup(seenFile);
  await settle();
  live.account.reads[0]?.resolve(
    list(claim(THIRD, T3), claim(SECOND, T2), claim(FIRST, T1)),
  );
  await settle();
  expect(live.unseen()).toEqual([THIRD]);
});

test("the seen claims are per workspace and per account: another workspace and another account's own person never use them", async () => {
  const seenFile = fakeSeen({
    kind: "entries",
    entries: [
      { workspaceId: WORKSPACE, ownMemberId: OWN, seenMemberIds: [SECOND] },
      {
        workspaceId: OTHER_WORKSPACE,
        ownMemberId: OWN,
        seenMemberIds: [FIRST],
      },
    ],
  });
  const live = setup(seenFile);
  await settle();
  live.account.reads[0]?.resolve(list(claim(SECOND, T2)));
  await settle();
  expect(live.unseen()).toEqual([]);

  live.workspaces.set({
    selected: OTHER_WORKSPACE,
    people: [person(OWN, "admin")],
  });
  live.account.reads[1]?.resolve(
    list(
      claim(SECOND, T2, { workspaceId: OTHER_WORKSPACE }),
      claim(FIRST, T1, { workspaceId: OTHER_WORKSPACE }),
    ),
  );
  await settle();
  expect(live.unseen()).toEqual([SECOND]);

  // Another account signs in on this device: its own person in the same
  // workspace has another member ID, so the earlier account's seen claims
  // do not apply.
  live.workspaces.set({ status: "signed_out", selected: null, people: [] });
  live.workspaces.set({
    status: "ready",
    selected: WORKSPACE,
    own: NEXT_OWN,
    people: [person(NEXT_OWN, "admin")],
  });
  live.account.reads[2]?.resolve(list(claim(SECOND, T2)));
  await settle();
  expect(live.unseen()).toEqual([SECOND]);
  live.service.markSeen(WORKSPACE, [SECOND]);
  await settle();
  // The earlier account's entries stay as they were.
  expect(live.seen.writes.at(-1)?.entries).toEqual([
    { workspaceId: WORKSPACE, ownMemberId: OWN, seenMemberIds: [SECOND] },
    { workspaceId: OTHER_WORKSPACE, ownMemberId: OWN, seenMemberIds: [FIRST] },
    {
      workspaceId: WORKSPACE,
      ownMemberId: NEXT_OWN,
      seenMemberIds: [SECOND],
    },
  ]);
});

test("a missing, unreadable, or invalid seen claims file counts as no entry, is logged with fixed text, and the claims still load", async () => {
  for (const [read, message] of [
    [{ kind: "none" }, null],
    [
      "unreadable",
      "The seen claims could not be read; every claim counts as unseen.",
    ],
    [
      { kind: "corrupt" },
      "The seen claims were not valid; every claim counts as unseen.",
    ],
  ] as const) {
    const live = setup(fakeSeen(read));
    await settle();
    expect(live.account.reads).toHaveLength(1);
    live.account.reads[0]?.resolve(list(claim(FIRST, T1)));
    await settle();
    expect(live.unseen()).toEqual([FIRST]);
    expect(live.logs).toEqual(message === null ? [] : [message]);
    // The next change writes the file again.
    expect(live.service.markSeen(WORKSPACE, [FIRST])).toEqual({
      outcome: "ok",
    });
    await settle();
    expect(live.seen.writes).toHaveLength(1);
  }
});

test("nothing loads until the seen claims file was read", async () => {
  const seenFile = fakeSeen("pending");
  const live = setup(seenFile);
  await settle();
  live.connection.receive(subscribed());
  live.connection.receive(claimedEvent());
  expect(live.service.load()).toEqual({ outcome: "loading" });
  expect(live.account.reads).toEqual([]);
  expect(live.service.state().status).toBe("loading");

  seenFile.finishRead({
    kind: "entries",
    entries: [
      { workspaceId: WORKSPACE, ownMemberId: OWN, seenMemberIds: [FIRST] },
    ],
  });
  await settle();
  expect(live.account.reads).toHaveLength(1);
  live.account.reads[0]?.resolve(list(claim(SECOND, T2), claim(FIRST, T1)));
  await settle();
  expect(live.unseen()).toEqual([SECOND]);
});

test("the seen claims are written one at a time, the latest last; a failed write is logged and the seen claims stay", async () => {
  const seenFile = fakeSeen({ kind: "none" }, false);
  const live = setup(seenFile);
  await settle();
  live.account.reads[0]?.resolve(
    list(claim(THIRD, T3), claim(SECOND, T2), claim(FIRST, T1)),
  );
  await settle();

  live.service.markSeen(WORKSPACE, [FIRST]);
  await settle();
  live.service.markSeen(WORKSPACE, [SECOND]);
  live.service.markSeen(WORKSPACE, [THIRD]);
  await settle();
  // The first write is on its way: the others wait for it.
  expect(seenFile.writes).toHaveLength(1);
  seenFile.writes[0]?.reject(new Error(`EACCES ${CLAIMER_USER_ID}`));
  await settle();
  expect(live.logs).toEqual(["The seen claims were not saved."]);
  expect(seenFile.writes).toHaveLength(2);
  expect(seenFile.writes[1]?.entries).toEqual([
    {
      workspaceId: WORKSPACE,
      ownMemberId: OWN,
      seenMemberIds: [THIRD, SECOND, FIRST],
    },
  ]);
  seenFile.writes[1]?.resolve();
  await settle();
  expect(seenFile.writes).toHaveLength(2);
  expect(live.unseen()).toEqual([]);
});

test("at most MAX_CLAIM_SEEN_ENTRIES entries are kept: a changed entry moves last, and the one that changed longest ago goes first", async () => {
  const entries = [
    { workspaceId: WORKSPACE, ownMemberId: OWN, seenMemberIds: [] },
    ...Array.from({ length: MAX_CLAIM_SEEN_ENTRIES - 1 }, (_, index) => ({
      workspaceId: id(0x10000 + index) as WorkspaceId,
      ownMemberId: OWN,
      seenMemberIds: [],
    })),
  ];
  const live = setup(fakeSeen({ kind: "entries", entries }));
  await settle();
  live.account.reads[0]?.resolve(list(claim(FIRST, T1)));
  await settle();
  // The oldest entry changes: it moves last, and nothing is dropped.
  live.service.markSeen(WORKSPACE, [FIRST]);
  await settle();
  let written = live.seen.writes.at(-1)?.entries ?? [];
  expect(written).toHaveLength(MAX_CLAIM_SEEN_ENTRIES);
  expect(written[0]?.workspaceId).toBe(id(0x10000));
  expect(written.at(-1)?.workspaceId).toBe(WORKSPACE);

  // A new entry drops the one that changed longest ago, not the one that
  // changed last.
  live.workspaces.set({
    selected: OTHER_WORKSPACE,
    people: [person(OWN, "admin")],
  });
  live.account.reads[1]?.resolve(
    list(claim(SECOND, T2, { workspaceId: OTHER_WORKSPACE })),
  );
  await settle();
  live.service.markSeen(OTHER_WORKSPACE, [SECOND]);
  await settle();
  written = live.seen.writes.at(-1)?.entries ?? [];
  expect(written).toHaveLength(MAX_CLAIM_SEEN_ENTRIES);
  expect(written[0]?.workspaceId).toBe(id(0x10001));
  expect(written.map((entry) => entry.workspaceId)).toContain(WORKSPACE);
  expect(written.at(-1)?.workspaceId).toBe(OTHER_WORKSPACE);
});

test("an access that is no longer allowed for any reason drops the claims and the answer on its way", async () => {
  const live = await loadedWith(claim(FIRST, T1));
  live.connection.receive(claimedEvent());
  expect(live.account.reads).toHaveLength(2);
  // The own person is no longer in the people: the role is not known.
  live.workspaces.set({ people: [] });
  expect(live.service.state()).toMatchObject({
    status: "loading",
    claims: [],
  });
  live.account.reads[1]?.resolve(list(claim(SECOND, T2), claim(FIRST, T1)));
  await settle();
  expect(live.service.state()).toMatchObject({
    status: "loading",
    claims: [],
  });
  live.workspaces.set({ people: [person(OWN, "owner")] });
  expect(live.account.reads).toHaveLength(3);
});

test("another own person in the same workspace drops the claims and the answer on its way, republishes, and does not use the earlier person's seen claims", async () => {
  const live = setup(
    fakeSeen({
      kind: "entries",
      entries: [
        { workspaceId: WORKSPACE, ownMemberId: OWN, seenMemberIds: [FIRST] },
      ],
    }),
  );
  await settle();
  live.account.reads[0]?.resolve(list(claim(FIRST, T1)));
  await settle();
  expect(live.unseen()).toEqual([]);
  const states: { revision: number; claims: number }[] = [];
  live.service.onChange((state) =>
    states.push({ revision: state.revision, claims: state.claims.length }),
  );

  // Removed and claimed again while offline: the list names another own
  // person in the same workspace, and the people show it as an admin.
  live.workspaces.set({ gateLive: false });
  live.connection.receive(claimedEvent());
  live.workspaces.set({
    own: NEXT_OWN,
    people: [person(OWN, "admin", T2), person(NEXT_OWN, "admin")],
  });
  expect(states.at(-1)).toEqual({
    revision: live.service.state().revision,
    claims: 0,
  });
  expect(live.service.state()).toMatchObject({
    status: "loading",
    claims: [],
  });
  live.workspaces.set({ gateLive: true });
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve(list(claim(FIRST, T1)));
  await settle();
  expect(live.unseen()).toEqual([FIRST]);
});

test("a switch, a demotion, and a sign-out cancel a retry that waits", async () => {
  for (const change of [
    { selected: OTHER_WORKSPACE, people: [] },
    { people: [person(OTHER, "owner"), person(OWN, "member")] },
    { status: "signed_out" as const, selected: null, people: [] },
  ]) {
    const live = await loadedWith(claim(FIRST, T1));
    live.connection.receive(claimedEvent());
    live.account.reads[1]?.resolve({ ok: false, reason: "unavailable" });
    await settle();
    expect(live.timers.retries()).toEqual([2_000]);
    live.workspaces.set(change);
    expect(live.timers.pending()).toEqual([]);
  }
});

test("a successful load starts the backoff again", async () => {
  const live = await loadedWith(claim(FIRST, T1));
  live.connection.receive(claimedEvent());
  live.account.reads[1]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  live.timers.fire();
  live.account.reads[2]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.timers.retries()).toEqual([4_000]);
  live.timers.fire();
  live.account.reads[3]?.resolve(list(claim(FIRST, T1)));
  await settle();
  live.connection.receive(claimedEvent());
  live.account.reads[4]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.timers.retries()).toEqual([2_000]);
});

test("a drop ends a load that waits for the gate, so that the next workspace reads once", async () => {
  const live = await loadedWith(claim(FIRST, T1));
  live.workspaces.set({ gateLive: false });
  live.connection.receive(claimedEvent());
  expect(live.account.reads).toHaveLength(1);

  live.workspaces.set({
    selected: OTHER_WORKSPACE,
    people: [person(OWN, "admin")],
    gateLive: true,
  });
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve(
    list(claim(SECOND, T2, { workspaceId: OTHER_WORKSPACE })),
  );
  await settle();
  expect(live.account.reads).toHaveLength(2);
  expect(live.service.state()).toMatchObject({
    status: "ready",
    workspaceId: OTHER_WORKSPACE,
    claims: [{ memberId: SECOND }],
  });
});

test("every change raises the revision once and reaches the listeners; close stops everything", async () => {
  const live = setup();
  const seen: number[] = [];
  const remove = live.service.onChange((state) => seen.push(state.revision));
  await settle();
  live.account.reads[0]?.resolve(list(claim(FIRST, T1)));
  await settle();
  expect(seen).toEqual([1, 2]);
  remove();

  live.connection.receive(claimedEvent());
  live.account.reads[1]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.timers.pending()).toHaveLength(1);
  live.service.close();
  expect(live.workspaces.listeners()).toBe(0);
  expect(live.connection.listeners()).toBe(0);
  expect(live.timers.pending()).toEqual([]);
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
});

test("no log holds a login or an ID", async () => {
  const live = setup(fakeSeen("unreadable"));
  await settle();
  live.account.reads[0]?.resolve({ ok: false, reason: "failed" });
  await settle();
  const text = JSON.stringify(live.logs);
  for (const hidden of [FIRST, WORKSPACE, OWN, "linus", CLAIMER_USER_ID]) {
    expect(text).not.toContain(hidden);
  }
  expect(live.logs.length).toBeGreaterThan(1);
});
