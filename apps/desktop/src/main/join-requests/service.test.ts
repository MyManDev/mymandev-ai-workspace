import {
  decodeServerMessage,
  type JoinRequestId,
  JoinRequestListResponseSchema,
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
  createJoinRequestService,
  JOIN_REQUEST_EXPIRY_CHECK_MAX_MS,
  JOIN_REQUEST_LOAD_COOLDOWN_MS,
  JOIN_REQUEST_MEMORY_LIMIT,
  JOIN_REQUEST_MEMORY_MS,
  MAX_HELD_JOIN_REQUESTS,
  MAX_REPLAYED_JOIN_REQUEST_EVENTS,
  type JoinRequestConnection,
  type JoinRequestServiceOptions,
} from "./service.ts";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OTHER_WORKSPACE = id(0xa2) as WorkspaceId;
const OWN = id(0xc1) as MemberId;
const OTHER = id(0xc3) as MemberId;
const FIRST = id(0xf1) as JoinRequestId;
const SECOND = id(0xf2) as JoinRequestId;
const THIRD = id(0xf3) as JoinRequestId;
const REQUESTER_USER_ID = id(0xb9);
const AT = "2026-11-05T10:00:00.000Z";
const BLOCKED_AT = "2026-11-05T11:00:00.000Z";
const ACCOUNT_CREATED_AT = "2020-01-02T03:04:05.000Z";
const PAUSED = "2026-11-05T12:00:00.000Z";
/** The system clock of the tests. */
const WALL = Date.parse("2026-11-06T10:00:00.000Z");
/** Six days after `WALL`, so the expiry timer waits its longest. */
const EXPIRES_AT = "2026-11-12T10:00:00.000Z";

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
 * The workspace service's state, people, own person, and pause, which the
 * test changes and then reports with `set`.
 */
function fakeWorkspaces() {
  let revision = 0;
  let status: WorkspaceState["status"] = "ready";
  let selected: WorkspaceId | null = WORKSPACE;
  let people: readonly PersonState[] = [person(OWN, "owner")];
  let own: MemberId | null = OWN;
  let pausedAt: string | null = null;
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
    | "state"
    | "onChange"
    | "people"
    | "ownMemberId"
    | "joinRequestsPausedAt"
    | "gateLive"
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
    joinRequestsPausedAt: () => pausedAt,
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
      pausedAt?: string | null;
      gateLive?: boolean;
    }) {
      status = next.status ?? status;
      selected = next.selected === undefined ? selected : next.selected;
      people = next.people ?? people;
      own = next.own === undefined ? own : next.own;
      pausedAt = next.pausedAt === undefined ? pausedAt : next.pausedAt;
      gateLive = next.gateLive ?? gateLive;
      revision += 1;
      for (const listener of [...listeners]) {
        listener(state());
      }
    },
  };
}

type ListResult = WorkspaceReadResult<
  ReturnType<typeof JoinRequestListResponseSchema.parse>
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
  } as unknown as JoinRequestServiceOptions["account"];
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
  } as unknown as JoinRequestConnection;
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
    /** The waits of the pending retries, without the expiry timer's. */
    retries: () =>
      timers
        .filter(
          (timer) =>
            timer.active && timer.delayMs !== JOIN_REQUEST_EXPIRY_CHECK_MAX_MS,
        )
        .map((timer) => timer.delayMs),
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
  occurredAt: string = AT,
): ServerMessage {
  eventCount += 1;
  return decoded({
    id: id(0x9000 + eventCount),
    occurredAt,
    workspaceId,
    actor: { kind: "system" },
    deviceId: null,
    type,
    payload,
  });
}

/** A request as the approvers' list shows it. */
function request(
  joinRequestId: JoinRequestId,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: joinRequestId,
    workspaceId: WORKSPACE,
    requestedDisplayName: "Linus Requester",
    requester: {
      provider: "github",
      login: "linus",
      verifiedAt: AT,
      accountCreatedAt: ACCOUNT_CREATED_AT,
    },
    createdAt: AT,
    expiresAt: EXPIRES_AT,
    decision: null,
    decidedAt: null,
    ...overrides,
  };
}

function block(
  joinRequestId: JoinRequestId,
  overrides: Record<string, unknown> = {},
) {
  return request(joinRequestId, {
    decision: "blocked",
    decidedAt: BLOCKED_AT,
    ...overrides,
  });
}

function created(
  joinRequestId: JoinRequestId,
  workspaceId: WorkspaceId = WORKSPACE,
  overrides: Record<string, unknown> = {},
): ServerMessage {
  return workspaceEvent(
    "workspace.join_request.created",
    { joinRequest: request(joinRequestId, { workspaceId, ...overrides }) },
    workspaceId,
  );
}

function resolved(
  joinRequestId: JoinRequestId,
  outcome: "approved" | "denied" | "withdrawn" | "blocked",
  workspaceId: WorkspaceId = WORKSPACE,
): ServerMessage {
  return workspaceEvent(
    "workspace.join_request.resolved",
    { joinRequestId, outcome },
    workspaceId,
    BLOCKED_AT,
  );
}

function unblocked(
  joinRequestId: JoinRequestId,
  workspaceId: WorkspaceId = WORKSPACE,
): ServerMessage {
  return workspaceEvent(
    "workspace.join_request.unblocked",
    { joinRequestId },
    workspaceId,
  );
}

function claimed(workspaceId: WorkspaceId = WORKSPACE): ServerMessage {
  return workspaceEvent(
    "workspace.member.claimed",
    {
      member: {
        id: OTHER,
        workspaceId,
        displayName: "Grace Invitee",
        role: "member",
        userId: id(0xb2),
        identity: { provider: "github", login: "grace", verifiedAt: AT },
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
    { memberId, removedAt: AT },
    workspaceId,
  );
}

function roleChanged(memberId: MemberId, role: "admin" | "member") {
  return workspaceEvent("workspace.member.role_changed", { memberId, role });
}

function list(...items: readonly Record<string, unknown>[]): ListResult {
  return {
    ok: true,
    value: JoinRequestListResponseSchema.parse({ joinRequests: items }),
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function setup() {
  const workspaces = fakeWorkspaces();
  const account = fakeAccount();
  const connection = fakeConnection();
  const timers = fakeTimers();
  const logs: string[] = [];
  let monotonic = 10_000;
  let wall = WALL;
  const service = createJoinRequestService({
    account: account.account,
    connection: connection.connection,
    workspaces: workspaces.workspaces,
    scheduleTimer: timers.schedule,
    now: () => monotonic,
    clock: () => wall,
    log: (message) => logs.push(message),
  });
  const ids = () => ({
    pending: service.state().pending.map((entry) => entry.id),
    blocked: service.state().blocked.map((entry) => entry.id),
  });
  return {
    service,
    workspaces,
    account,
    connection,
    timers,
    logs,
    ids,
    advance: (ms: number) => {
      monotonic += ms;
      wall += ms;
    },
  };
}

/** A setup whose list loaded once with `items`. */
async function loadedWith(...items: readonly Record<string, unknown>[]) {
  const live = setup();
  live.service.load();
  live.account.reads[0]?.resolve(list(...items));
  await settle();
  return live;
}

test("nothing loads until the screen asks; then the list loads for the selected workspace, and the state holds the pending requests and the blocks without a user ID", async () => {
  const live = setup();
  expect(live.service.state()).toEqual({
    revision: 0,
    status: "loading",
    workspaceId: WORKSPACE,
    pending: [],
    blocked: [],
    pausedAt: null,
  });
  live.connection.receive(subscribed());
  live.connection.receive(claimed());
  live.connection.receive(created(FIRST));
  expect(live.service.reload(WORKSPACE)).toBe(false);
  expect(live.account.reads).toEqual([]);
  expect(live.service.state().pending).toEqual([]);

  expect(live.service.load()).toEqual({ outcome: "loading" });
  expect(live.account.reads.map((read) => [read.name, read.params])).toEqual([
    ["listJoinRequests", { workspaceId: WORKSPACE }],
  ]);
  live.account.reads[0]?.resolve(
    list(
      request(FIRST, { requester: { ...request(FIRST).requester } }),
      block(SECOND),
    ),
  );
  await settle();
  const state = live.service.state();
  expect(state).toEqual({
    revision: 1,
    status: "ready",
    workspaceId: WORKSPACE,
    pending: [
      {
        id: FIRST,
        requestedDisplayName: "Linus Requester",
        requester: {
          login: "linus",
          verifiedAt: AT,
          accountCreatedAt: ACCOUNT_CREATED_AT,
        },
        createdAt: AT,
        expiresAt: EXPIRES_AT,
      },
    ],
    blocked: [
      {
        id: SECOND,
        requestedDisplayName: "Linus Requester",
        requester: {
          login: "linus",
          verifiedAt: AT,
          accountCreatedAt: ACCOUNT_CREATED_AT,
        },
        createdAt: AT,
        blockedAt: BLOCKED_AT,
      },
    ],
    pausedAt: null,
  });
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state.pending)).toBe(true);
  expect(Object.isFrozen(state.pending[0])).toBe(true);
  expect(Object.isFrozen(state.pending[0]?.requester)).toBe(true);
  expect(Object.isFrozen(state.blocked[0])).toBe(true);
  expect(JSON.stringify(state)).not.toContain("provider");
});

test("a block of an erased account keeps no requester, a decision that the list does not show is left out, and a list that names another workspace is a failure", async () => {
  const live = await loadedWith(
    block(FIRST, { requester: null }),
    request(SECOND, {
      decision: "denied",
      decidedAt: BLOCKED_AT,
    }),
    request(THIRD),
  );
  expect(live.service.state().blocked).toEqual([
    {
      id: FIRST,
      requestedDisplayName: "Linus Requester",
      requester: null,
      createdAt: AT,
      blockedAt: BLOCKED_AT,
    },
  ]);
  expect(live.ids().pending).toEqual([THIRD]);

  live.service.reload(WORKSPACE);
  live.account.reads[1]?.resolve(
    list(request(FIRST, { workspaceId: OTHER_WORKSPACE })),
  );
  await settle();
  expect(live.service.state()).toMatchObject({
    status: "unavailable",
    problem: "failed",
  });
  // What was loaded before stays.
  expect(live.ids()).toEqual({ pending: [THIRD], blocked: [FIRST] });
});

test("a request is refused without a device, a workspace, or the role, still counts, and starts no cooldown; another one within the cooldown is too_soon", async () => {
  const live = setup();
  live.workspaces.set({ status: "signed_out", selected: null });
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
  live.workspaces.set({ status: "ready" });
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "no_workspace",
  });
  live.workspaces.set({ selected: WORKSPACE, people: [person(OWN, "member")] });
  expect(live.service.state().status).toBe("not_allowed");
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "not_allowed",
  });
  expect(live.account.reads).toEqual([]);

  // The earlier request counted: a promotion loads without another one.
  live.workspaces.set({ people: [person(OWN, "admin")] });
  expect(live.account.reads).toHaveLength(1);
  live.account.reads[0]?.resolve(list());
  await settle();

  expect(live.service.load()).toEqual({ outcome: "loading" });
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve(list());
  await settle();
  live.advance(JOIN_REQUEST_LOAD_COOLDOWN_MS - 1);
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "too_soon",
  });
  expect(live.account.reads).toHaveLength(2);
  live.advance(1);
  expect(live.service.load()).toEqual({ outcome: "loading" });
  expect(live.account.reads).toHaveLength(3);
});

test("while the account's own role is member, nothing loads and the join request events and triggers are ignored; a demotion drops the list and the pause at once", async () => {
  const member = setup();
  member.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "member")],
    pausedAt: AT,
  });
  member.service.load();
  member.connection.receive(created(FIRST));
  member.connection.receive(subscribed());
  member.connection.receive(claimed());
  member.connection.receive(removed(OTHER));
  expect(member.service.reload(WORKSPACE)).toBe(false);
  expect(member.account.reads).toEqual([]);
  expect(member.service.state()).toMatchObject({
    status: "not_allowed",
    pending: [],
    blocked: [],
    pausedAt: null,
  });

  // An admin who is demoted: nothing stays, and the answer on its way is
  // dropped.
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
    pausedAt: AT,
  });
  live.service.load();
  live.account.reads[0]?.resolve(list(request(FIRST), block(SECOND)));
  await settle();
  expect(live.service.state().pausedAt).toBe(AT);
  live.service.reload(WORKSPACE);
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "member")],
  });
  expect(live.service.state()).toMatchObject({
    status: "not_allowed",
    pending: [],
    blocked: [],
    pausedAt: null,
  });
  live.account.reads[1]?.resolve(list(request(FIRST)));
  await settle();
  live.connection.receive(created(THIRD));
  expect(live.service.state()).toMatchObject({
    status: "not_allowed",
    pending: [],
    blocked: [],
  });

  // A removed own person, as a former owner, is not allowed either.
  live.workspaces.set({ people: [person(OWN, "owner", AT)] });
  expect(live.service.state().status).toBe("not_allowed");
  expect(live.account.reads).toHaveLength(2);
});

test("while the role is not known, a request answers loading and an event is ignored; the list loads once the people show the owner's or an admin's role", async () => {
  const live = setup();
  live.workspaces.set({ people: [] });
  expect(live.service.load()).toEqual({ outcome: "loading" });
  live.connection.receive(created(FIRST));
  expect(live.account.reads).toEqual([]);
  live.workspaces.set({ people: [person(OWN, "owner")] });
  expect(live.account.reads).toHaveLength(1);
  live.account.reads[0]?.resolve(list());
  await settle();
  expect(live.service.state()).toMatchObject({ status: "ready", pending: [] });
});

test("the pause comes from the workspace's view for the owner and the admins, and follows its changes", async () => {
  const live = setup();
  expect(live.service.state().pausedAt).toBeNull();
  live.workspaces.set({ pausedAt: AT });
  expect(live.service.state().pausedAt).toBe(AT);
  live.workspaces.set({ pausedAt: null });
  expect(live.service.state().pausedAt).toBeNull();
  // Nothing was read for it.
  expect(live.account.reads).toEqual([]);
});

test("a created event adds a pending request at the end, once; resolved ends it; blocked makes it a block at the event's time; unblocked ends the block", async () => {
  const live = await loadedWith(request(FIRST));
  live.connection.receive(created(SECOND));
  live.connection.receive(created(SECOND));
  expect(live.ids()).toEqual({ pending: [FIRST, SECOND], blocked: [] });
  expect(live.service.state().pending[1]).toMatchObject({
    id: SECOND,
    requester: { login: "linus", accountCreatedAt: ACCOUNT_CREATED_AT },
  });

  live.connection.receive(resolved(FIRST, "denied"));
  expect(live.ids()).toEqual({ pending: [SECOND], blocked: [] });
  live.connection.receive(resolved(SECOND, "blocked"));
  expect(live.ids()).toEqual({ pending: [], blocked: [SECOND] });
  expect(live.service.state().blocked[0]).toEqual({
    id: SECOND,
    requestedDisplayName: "Linus Requester",
    requester: {
      login: "linus",
      verifiedAt: AT,
      accountCreatedAt: ACCOUNT_CREATED_AT,
    },
    createdAt: AT,
    blockedAt: BLOCKED_AT,
  });
  const revision = live.service.state().revision;
  // A repeated event, and one for a request that is not held, change
  // nothing.
  live.connection.receive(resolved(SECOND, "blocked"));
  live.connection.receive(resolved(THIRD, "approved"));
  live.connection.receive(unblocked(THIRD));
  expect(live.service.state().revision).toBe(revision);

  live.connection.receive(unblocked(SECOND));
  expect(live.ids()).toEqual({ pending: [], blocked: [] });
  // The events read nothing.
  expect(live.account.reads).toHaveLength(1);
});

test("every outcome but blocked ends a pending request", async () => {
  for (const outcome of ["approved", "denied", "withdrawn"] as const) {
    const live = await loadedWith(request(FIRST));
    live.connection.receive(resolved(FIRST, outcome));
    expect(live.ids(), outcome).toEqual({ pending: [], blocked: [] });
  }
});

test("the events of another workspace change nothing", async () => {
  const live = await loadedWith(request(FIRST), block(SECOND));
  const revision = live.service.state().revision;
  live.connection.receive(created(THIRD, OTHER_WORKSPACE));
  live.connection.receive(resolved(FIRST, "denied", OTHER_WORKSPACE));
  live.connection.receive(unblocked(SECOND, OTHER_WORKSPACE));
  expect(live.ids()).toEqual({ pending: [FIRST], blocked: [SECOND] });
  expect(live.service.state().revision).toBe(revision);
});

test("a resolved request's ID is remembered, so that a late created does not bring it back, until the memory ends", async () => {
  const live = await loadedWith();
  live.connection.receive(resolved(FIRST, "denied"));
  live.connection.receive(created(FIRST));
  expect(live.ids().pending).toEqual([]);

  // A load answer that still shows it pending, also one that waited, does
  // not either.
  live.service.reload(WORKSPACE);
  live.account.reads[1]?.resolve(list(request(FIRST)));
  await settle();
  expect(live.ids().pending).toEqual([]);

  live.advance(JOIN_REQUEST_MEMORY_MS);
  live.connection.receive(created(FIRST));
  expect(live.ids().pending).toEqual([FIRST]);
});

test("an unblocked request's ID is remembered, so that a late resolved with blocked does not bring the block back", async () => {
  const live = await loadedWith(request(FIRST));
  live.connection.receive(unblocked(FIRST));
  live.connection.receive(resolved(FIRST, "blocked"));
  expect(live.ids()).toEqual({ pending: [], blocked: [] });

  // A load answer that still shows the block does not either.
  live.service.reload(WORKSPACE);
  live.account.reads[1]?.resolve(list(block(FIRST)));
  await settle();
  expect(live.ids()).toEqual({ pending: [], blocked: [] });
});

test("the events that arrive while a load is on its way apply again on top of its answer", async () => {
  const live = await loadedWith(request(FIRST), request(SECOND), block(THIRD));
  live.service.reload(WORKSPACE);
  const fourth = id(0xf4) as JoinRequestId;
  live.connection.receive(created(fourth));
  live.connection.receive(resolved(FIRST, "blocked"));
  live.connection.receive(unblocked(THIRD));
  // They apply at once to the list that shows.
  expect(live.ids()).toEqual({ pending: [SECOND, fourth], blocked: [FIRST] });

  // The answer was read before them.
  live.account.reads[1]?.resolve(
    list(request(FIRST), request(SECOND), block(THIRD)),
  );
  await settle();
  expect(live.ids()).toEqual({ pending: [SECOND, fourth], blocked: [FIRST] });
  expect(live.service.state().blocked[0]?.blockedAt).toBe(BLOCKED_AT);

  // The events do not apply again on the next answer, which is read after
  // them.
  live.service.reload(WORKSPACE);
  live.account.reads[2]?.resolve(list(request(SECOND)));
  await settle();
  expect(live.ids()).toEqual({ pending: [SECOND], blocked: [] });
});

test("events during the first load apply on top of its answer", async () => {
  const live = setup();
  live.service.load();
  live.connection.receive(created(SECOND));
  expect(live.service.state().pending).toEqual([]);
  live.account.reads[0]?.resolve(list(request(FIRST)));
  await settle();
  expect(live.ids().pending).toEqual([FIRST, SECOND]);
});

test("too many events during a load drop its answer, and one more load follows", async () => {
  const live = await loadedWith();
  live.service.reload(WORKSPACE);
  for (let index = 0; index <= MAX_REPLAYED_JOIN_REQUEST_EVENTS; index += 1) {
    live.connection.receive(
      resolved(id(0x10000 + index) as JoinRequestId, "denied"),
    );
  }
  live.account.reads[1]?.resolve(list(request(FIRST)));
  await settle();
  expect(live.account.reads).toHaveLength(3);
  live.account.reads[2]?.resolve(list(request(SECOND)));
  await settle();
  expect(live.ids().pending).toEqual([SECOND]);
});

test("after the screen asked, workspace.subscribed, a claim, and the removal of another person load again; a role change and the same events of another workspace do not", async () => {
  const live = await loadedWith(request(FIRST));
  live.connection.receive(subscribed(OTHER_WORKSPACE));
  live.connection.receive(claimed(OTHER_WORKSPACE));
  live.connection.receive(removed(OTHER, OTHER_WORKSPACE));
  live.connection.receive(roleChanged(OTHER, "member"));
  live.connection.receive(roleChanged(OTHER, "admin"));
  await settle();
  expect(live.account.reads).toHaveLength(1);

  let reads = 1;
  for (const trigger of [subscribed(), claimed(), removed(OTHER)]) {
    live.connection.receive(trigger);
    reads += 1;
    expect(live.account.reads).toHaveLength(reads);
    live.account.reads[reads - 1]?.resolve(list());
    await settle();
  }
  expect(live.service.state().pending).toEqual([]);

  // An action reloads the selected workspace only.
  expect(live.service.reload(OTHER_WORKSPACE)).toBe(false);
  expect(live.service.reload(WORKSPACE)).toBe(true);
  expect(live.account.reads).toHaveLength(reads + 1);
});

test("the removal of the account's own person reads nothing", async () => {
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  live.service.load();
  live.account.reads[0]?.resolve(list(request(FIRST)));
  await settle();
  live.connection.receive(removed(OWN));
  expect(live.account.reads).toHaveLength(1);
});

test("triggers while a load is on its way merge into one more load, and the older answer is dropped", async () => {
  const live = setup();
  live.service.load();
  live.connection.receive(subscribed());
  live.connection.receive(claimed());
  live.connection.receive(removed(OTHER));
  expect(live.service.reload(WORKSPACE)).toBe(true);
  expect(live.account.reads).toHaveLength(1);

  live.account.reads[0]?.resolve(list(request(FIRST)));
  await settle();
  expect(live.service.state().status).toBe("loading");
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve(list(request(SECOND)));
  await settle();
  expect(live.ids().pending).toEqual([SECOND]);
  expect(live.account.reads).toHaveLength(2);
});

test("a failed load keeps what was loaded, shows the problem, and is retried with the workspace service's backoff; triggers during the backoff wait for the retry; rate_limited waits 60 seconds", async () => {
  const live = await loadedWith(request(FIRST));
  live.service.reload(WORKSPACE);
  live.account.reads[1]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.service.state()).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
    pending: [{ id: FIRST }],
  });
  expect(live.logs).toEqual(["The join requests did not load (unavailable)."]);
  expect(live.timers.retries()).toEqual([2_000]);

  live.connection.receive(subscribed());
  live.connection.receive(claimed());
  expect(live.service.reload(WORKSPACE)).toBe(true);
  expect(live.account.reads).toHaveLength(2);
  // An event still applies to the list that shows.
  live.connection.receive(resolved(FIRST, "denied"));
  expect(live.ids().pending).toEqual([]);

  live.timers.fire();
  expect(live.account.reads).toHaveLength(3);
  live.account.reads[2]?.resolve({ ok: false, reason: "failed" });
  await settle();
  expect(live.timers.retries()).toEqual([4_000]);
  live.timers.fire();
  live.account.reads[3]?.resolve(list(request(SECOND)));
  await settle();
  expect(live.service.state()).toMatchObject({ status: "ready" });
  expect(live.service.state()).not.toHaveProperty("problem");

  live.service.reload(WORKSPACE);
  live.service.reload(WORKSPACE);
  live.account.reads[4]?.resolve({ ok: false, reason: "rate_limited" });
  await settle();
  expect(live.account.reads).toHaveLength(5);
  expect(live.timers.retries()).toEqual([60_000]);
});

test("a read that rejects is unavailable; offline, a failure schedules no retry and the next workspace.subscribed loads", async () => {
  const live = setup();
  live.service.load();
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

test("a pending request leaves the list at its expiry by the system clock, a created event past it adds nothing, and a load's answer is not filtered by the system clock", async () => {
  const soon = new Date(WALL + 60_000).toISOString();
  const live = await loadedWith(
    request(FIRST, { expiresAt: soon }),
    request(SECOND),
    request(THIRD, { expiresAt: new Date(WALL).toISOString() }),
  );
  // The server left out the requests past their expiry by its own clock:
  // the answer holds all three, and the expiry timer follows the system
  // clock from here on.
  expect(live.ids().pending).toEqual([FIRST, SECOND, THIRD]);
  expect(live.timers.pending().map((timer) => timer.delayMs)).toEqual([0]);
  live.timers.fire();
  expect(live.ids().pending).toEqual([FIRST, SECOND]);
  expect(live.timers.pending().map((timer) => timer.delayMs)).toEqual([60_000]);

  live.advance(60_000);
  live.timers.fire();
  expect(live.ids().pending).toEqual([SECOND]);
  // The next timer waits for the next expiry, at most a day.
  expect(live.timers.pending().map((timer) => timer.delayMs)).toEqual([
    JOIN_REQUEST_EXPIRY_CHECK_MAX_MS,
  ]);

  live.connection.receive(
    created(THIRD, WORKSPACE, { expiresAt: new Date(WALL).toISOString() }),
  );
  expect(live.ids().pending).toEqual([SECOND]);

  // A block has no expiry.
  live.connection.receive(resolved(SECOND, "blocked"));
  expect(live.ids()).toEqual({ pending: [], blocked: [SECOND] });
  expect(live.timers.pending()).toEqual([]);
});

test("another workspace, a sign-out, and another device drop the requests, the remembered IDs, and the answers on their way", async () => {
  const live = await loadedWith(request(FIRST));
  live.connection.receive(resolved(SECOND, "denied"));

  live.service.reload(WORKSPACE);
  live.workspaces.set({ selected: OTHER_WORKSPACE, people: [] });
  expect(live.service.state()).toMatchObject({
    status: "loading",
    workspaceId: OTHER_WORKSPACE,
    pending: [],
  });
  live.account.reads[1]?.resolve(list(request(FIRST)));
  await settle();
  expect(live.service.state().pending).toEqual([]);

  // Back to the first workspace: the remembered ID was dropped with it.
  live.workspaces.set({ selected: WORKSPACE, people: [person(OWN, "owner")] });
  expect(live.account.reads[2]?.params).toEqual({ workspaceId: WORKSPACE });
  live.account.reads[2]?.resolve(list(request(SECOND)));
  await settle();
  expect(live.ids().pending).toEqual([SECOND]);

  live.workspaces.set({ status: "signed_out", selected: null, people: [] });
  expect(live.service.state()).toMatchObject({
    status: "signed_out",
    workspaceId: null,
    pending: [],
    blocked: [],
  });
});

test("every change raises the revision once and reaches the listeners; close stops everything", async () => {
  const live = setup();
  const seen: number[] = [];
  const remove = live.service.onChange((state) => seen.push(state.revision));
  live.service.load();
  live.account.reads[0]?.resolve(list(request(FIRST)));
  await settle();
  expect(seen).toEqual([1]);
  remove();

  live.service.close();
  expect(live.workspaces.listeners()).toBe(0);
  expect(live.connection.listeners()).toBe(0);
  expect(live.timers.pending()).toEqual([]);
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
  expect(live.service.reload(WORKSPACE)).toBe(false);
});

test("no log holds a name, a login, or an ID", async () => {
  const live = await loadedWith(request(FIRST));
  live.service.reload(WORKSPACE);
  live.account.reads[1]?.resolve({ ok: false, reason: "failed" });
  await settle();
  const text = JSON.stringify(live.logs);
  for (const hidden of [
    FIRST,
    WORKSPACE,
    "linus",
    "Linus",
    REQUESTER_USER_ID,
  ]) {
    expect(text).not.toContain(hidden);
  }
  expect(live.logs.length).toBeGreaterThan(0);
});

test("the demotion of the account's own person drops the list at once when its event comes while the workspace service's gate holds it, and nothing loads until the people show the role", async () => {
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
    pausedAt: AT,
  });
  live.service.load();
  live.account.reads[0]?.resolve(list(request(FIRST), block(SECOND)));
  await settle();

  // The workspace reloads, so its gate holds the event; the people still
  // show the account's own person as an admin.
  live.workspaces.set({ gateLive: false });
  live.connection.receive(roleChanged(OWN, "member"));
  expect(live.service.state()).toMatchObject({
    status: "not_allowed",
    pending: [],
    blocked: [],
    pausedAt: null,
  });
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "not_allowed",
  });

  // Other changes of the workspace while the people still show the old
  // role, events, and triggers read nothing.
  live.workspaces.set({ pausedAt: PAUSED });
  live.connection.receive(created(THIRD));
  live.connection.receive(claimed());
  live.connection.receive(subscribed());
  expect(live.service.reload(WORKSPACE)).toBe(false);
  expect(live.service.state()).toMatchObject({
    status: "not_allowed",
    pending: [],
    pausedAt: null,
  });

  // The reload answers with the event applied.
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "member")],
    gateLive: true,
  });
  expect(live.service.state().status).toBe("not_allowed");
  expect(live.account.reads).toHaveLength(1);
});

test("the demotion of the account's own person that the workspace service shows first reads nothing, and a later promotion that only its people show loads", async () => {
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  live.service.load();
  live.account.reads[0]?.resolve(list(request(FIRST)));
  await settle();

  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "member")],
  });
  live.connection.receive(roleChanged(OWN, "member"));
  expect(live.service.state()).toMatchObject({
    status: "not_allowed",
    pending: [],
  });
  expect(live.account.reads).toHaveLength(1);

  // A promotion that only a reload shows, for example after a reconnect.
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  expect(live.account.reads).toHaveLength(2);
});

test("a promotion event after a demotion event, while the gate holds both, lets the people decide again, and the load waits for the gate", async () => {
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  live.service.load();
  live.account.reads[0]?.resolve(list(request(FIRST)));
  await settle();

  live.workspaces.set({ gateLive: false });
  live.connection.receive(roleChanged(OWN, "member"));
  expect(live.service.state().status).toBe("not_allowed");
  live.connection.receive(roleChanged(OWN, "admin"));
  expect(live.service.state().status).toBe("loading");
  expect(live.account.reads).toHaveLength(1);

  live.workspaces.set({ gateLive: true });
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve(list(request(SECOND)));
  await settle();
  expect(live.ids().pending).toEqual([SECOND]);
});

test("a load waits until the workspace service's gate is live, so that a reconnect after a demotion reads nothing and drops the list", async () => {
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
  });
  live.service.load();
  live.account.reads[0]?.resolve(list(request(FIRST)));
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
    pending: [],
  });
  expect(live.account.reads).toHaveLength(1);

  // The screen's first request also waits for the gate.
  const first = setup();
  first.workspaces.set({ gateLive: false });
  expect(first.service.load()).toEqual({ outcome: "loading" });
  expect(first.account.reads).toEqual([]);
  first.workspaces.set({ gateLive: true });
  expect(first.account.reads).toHaveLength(1);
});

test("a created event that does not fit beside the held requests loads the list again, so that it shows once the server lists it", async () => {
  const blocks = Array.from({ length: MAX_HELD_JOIN_REQUESTS }, (_, index) =>
    block(id(0x20000 + index) as JoinRequestId),
  );
  const live = await loadedWith(...blocks);
  expect(live.ids().blocked).toHaveLength(MAX_HELD_JOIN_REQUESTS);

  live.connection.receive(created(FIRST));
  expect(live.ids().pending).toEqual([]);
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve(list(request(FIRST), ...blocks.slice(1)));
  await settle();
  expect(live.ids().pending).toEqual([FIRST]);

  // One that arrived during the first load, applied again on its answer,
  // loads once more too.
  const first = setup();
  first.service.load();
  first.connection.receive(created(SECOND));
  first.account.reads[0]?.resolve(list(...blocks));
  await settle();
  expect(first.ids().pending).toEqual([]);
  expect(first.account.reads).toHaveLength(2);
});

test("at most JOIN_REQUEST_MEMORY_LIMIT resolved IDs are remembered, the oldest going first", async () => {
  const live = await loadedWith();
  const others = Array.from(
    { length: JOIN_REQUEST_MEMORY_LIMIT },
    (_, index) => id(0x30000 + index) as JoinRequestId,
  );
  for (const joinRequestId of [FIRST, ...others]) {
    live.connection.receive(resolved(joinRequestId, "denied"));
  }
  // FIRST, the oldest of 1,001, was forgotten; the others were not.
  live.connection.receive(created(FIRST));
  live.connection.receive(created(others[0] as JoinRequestId));
  live.connection.receive(created(others.at(-1) as JoinRequestId));
  expect(live.ids().pending).toEqual([FIRST]);
});

test("a resolved and an unblocked ID are remembered on arrival, also when the first load fails", async () => {
  const live = setup();
  live.service.load();
  live.connection.receive(resolved(FIRST, "denied"));
  live.connection.receive(unblocked(SECOND));
  live.account.reads[0]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  live.timers.fire();
  // An answer read before the events still shows them.
  live.account.reads[1]?.resolve(list(request(FIRST), block(SECOND)));
  await settle();
  expect(live.ids()).toEqual({ pending: [], blocked: [] });
  expect(live.service.state().status).toBe("ready");
});
