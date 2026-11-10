import {
  decodeServerMessage,
  type InvitationId,
  InvitationListResponseSchema,
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
  createInvitationService,
  INVITATION_LOAD_COOLDOWN_MS,
  type InvitationConnection,
  type InvitationServiceOptions,
} from "./service.ts";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OTHER_WORKSPACE = id(0xa2) as WorkspaceId;
const OWN = id(0xc1) as MemberId;
const INVITEE = id(0xc2) as MemberId;
const OTHER = id(0xc3) as MemberId;
const INVITATION = id(0xe1) as InvitationId;
const OTHER_INVITATION = id(0xe2) as InvitationId;
const AT = "2026-11-05T10:00:00.000Z";
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
 * The workspace service's state, people, and own person, which the test
 * changes and then reports with `changed`.
 */
function fakeWorkspaces() {
  let revision = 0;
  let status: WorkspaceState["status"] = "ready";
  let selected: WorkspaceId | null = WORKSPACE;
  let people: readonly PersonState[] = [person(OWN, "owner")];
  let own: MemberId | null = OWN;
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
    "state" | "onChange" | "people" | "ownMemberId"
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
  };
  const changed = () => {
    revision += 1;
    for (const listener of [...listeners]) {
      listener(state());
    }
  };
  return {
    workspaces,
    listeners: () => listeners.size,
    set(next: {
      status?: WorkspaceState["status"];
      selected?: WorkspaceId | null;
      people?: readonly PersonState[];
      own?: MemberId | null;
    }) {
      status = next.status ?? status;
      selected = next.selected === undefined ? selected : next.selected;
      people = next.people ?? people;
      own = next.own === undefined ? own : next.own;
      changed();
    },
  };
}

type ListResult = WorkspaceReadResult<
  ReturnType<typeof InvitationListResponseSchema.parse>
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
  } as unknown as InvitationServiceOptions["account"];
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
  } as unknown as InvitationConnection;
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

function membershipEvent(
  type: string,
  payload: Record<string, unknown>,
  workspaceId: WorkspaceId = WORKSPACE,
): ServerMessage {
  eventCount += 1;
  return decoded({
    id: id(0x9000 + eventCount),
    occurredAt: AT,
    workspaceId,
    actor: { kind: "system" },
    deviceId: null,
    type,
    payload,
  });
}

function claimed(workspaceId: WorkspaceId = WORKSPACE): ServerMessage {
  return membershipEvent(
    "workspace.member.claimed",
    {
      member: {
        id: INVITEE,
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

function list(...ids: readonly InvitationId[]): ListResult {
  return listIn(WORKSPACE, ...ids);
}

function listIn(
  workspaceId: WorkspaceId,
  ...ids: readonly InvitationId[]
): ListResult {
  return {
    ok: true,
    value: InvitationListResponseSchema.parse({
      invitations: ids.map((invitationId) => ({
        id: invitationId,
        workspaceId,
        memberId: INVITEE,
        createdByMemberId: OWN,
        createdAt: AT,
        expiresAt: EXPIRES_AT,
      })),
    }),
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
  let clock = 10_000;
  const service = createInvitationService({
    account: account.account,
    connection: connection.connection,
    workspaces: workspaces.workspaces,
    scheduleTimer: timers.schedule,
    now: () => clock,
    log: (message) => logs.push(message),
  });
  return {
    service,
    workspaces,
    account,
    connection,
    timers,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("nothing loads until the screen asks; then the list loads for the selected workspace and the state holds IDs and times only", async () => {
  const live = setup();
  expect(live.service.state()).toEqual({
    revision: 0,
    status: "loading",
    workspaceId: WORKSPACE,
    invitations: [],
  });
  live.connection.receive(subscribed());
  live.connection.receive(claimed());
  expect(live.service.reload(WORKSPACE)).toBe(false);
  expect(live.account.reads).toEqual([]);

  expect(live.service.load()).toEqual({ outcome: "loading" });
  expect(live.account.reads.map((read) => [read.name, read.params])).toEqual([
    ["listInvitations", { workspaceId: WORKSPACE }],
  ]);
  live.account.reads[0]?.resolve(list(INVITATION));
  await settle();
  const state = live.service.state();
  expect(state).toEqual({
    revision: 1,
    status: "ready",
    workspaceId: WORKSPACE,
    invitations: [
      {
        id: INVITATION,
        memberId: INVITEE,
        createdByMemberId: OWN,
        createdAt: AT,
        expiresAt: EXPIRES_AT,
      },
    ],
  });
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state.invitations)).toBe(true);
  expect(Object.isFrozen(state.invitations[0])).toBe(true);
});

test("a request is refused without a device, a workspace, or the role, still counts, and starts no cooldown; another one within the cooldown is too_soon", async () => {
  const live = setup();
  live.workspaces.set({ status: "signed_out", selected: null });
  expect(live.service.state().status).toBe("signed_out");
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
  live.workspaces.set({ status: "ready" });
  expect(live.service.state().status).toBe("no_workspace");
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "no_workspace",
  });
  live.workspaces.set({
    selected: WORKSPACE,
    people: [person(OWN, "member")],
  });
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

  // No refusal started the cooldown.
  expect(live.service.load()).toEqual({ outcome: "loading" });
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve(list());
  await settle();
  live.advance(INVITATION_LOAD_COOLDOWN_MS - 1);
  expect(live.service.load()).toEqual({
    outcome: "refused",
    reason: "too_soon",
  });
  expect(live.account.reads).toHaveLength(2);
  live.advance(1);
  expect(live.service.load()).toEqual({ outcome: "loading" });
  expect(live.account.reads).toHaveLength(3);
});

test("only the owner and the admins see the invitations: a member loads nothing, a demotion drops them at once, and a removed own person is not allowed", async () => {
  for (const role of ["owner", "admin"] as const) {
    const live = setup();
    live.workspaces.set({ people: [person(OWN, role)] });
    live.service.load();
    expect(live.account.reads, role).toHaveLength(1);
  }

  const live = setup();
  live.service.load();
  live.account.reads[0]?.resolve(list(INVITATION));
  await settle();
  expect(live.service.state().invitations).toHaveLength(1);

  // A demotion: nothing stays, and the answer on its way is dropped.
  live.service.reload(WORKSPACE);
  live.workspaces.set({ people: [person(OWN, "member")] });
  expect(live.service.state()).toMatchObject({
    status: "not_allowed",
    invitations: [],
  });
  live.account.reads[1]?.resolve(list(INVITATION));
  await settle();
  expect(live.service.state()).toMatchObject({
    status: "not_allowed",
    invitations: [],
  });
  // No trigger loads for a member.
  live.connection.receive(subscribed());
  live.connection.receive(claimed());
  expect(live.service.reload(WORKSPACE)).toBe(false);
  expect(live.account.reads).toHaveLength(2);

  // A removed own person, as a former owner, is not allowed either.
  live.workspaces.set({ people: [person(OWN, "owner", AT)] });
  expect(live.service.state().status).toBe("not_allowed");
  expect(live.account.reads).toHaveLength(2);
});

test("the role is the account's own person's, not another person's: a member beside another owner sees nothing, and an admin beside another member loads", async () => {
  const member = setup();
  member.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "member")],
  });
  expect(member.service.state().status).toBe("not_allowed");
  expect(member.service.load()).toEqual({
    outcome: "refused",
    reason: "not_allowed",
  });
  member.connection.receive(subscribed());
  member.connection.receive(claimed());
  expect(member.service.reload(WORKSPACE)).toBe(false);
  expect(member.account.reads).toEqual([]);

  const admin = setup();
  admin.workspaces.set({
    people: [person(OTHER, "member"), person(OWN, "admin")],
  });
  expect(admin.service.load()).toEqual({ outcome: "loading" });
  expect(admin.account.reads.map((read) => read.params)).toEqual([
    { workspaceId: WORKSPACE },
  ]);
  admin.account.reads[0]?.resolve(list(INVITATION));
  await settle();
  expect(admin.service.state().status).toBe("ready");
});

test("with the people loaded but no own person known for the workspace, the role is not known: loading, and nothing is read", () => {
  const live = setup();
  live.workspaces.set({
    people: [person(OTHER, "owner"), person(OWN, "admin")],
    own: null,
  });
  expect(live.service.state().status).toBe("loading");
  expect(live.service.load()).toEqual({ outcome: "loading" });
  live.connection.receive(subscribed());
  live.connection.receive(claimed());
  expect(live.service.reload(WORKSPACE)).toBe(false);
  expect(live.account.reads).toEqual([]);
});

test("the backoff starts again from its first wait after a successful load", async () => {
  const live = setup();
  live.service.load();
  live.account.reads[0]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  live.timers.fire();
  live.account.reads[1]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.timers.pending().map((timer) => timer.delayMs)).toEqual([4_000]);
  live.timers.fire();
  live.account.reads[2]?.resolve(list(INVITATION));
  await settle();

  live.service.reload(WORKSPACE);
  live.account.reads[3]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.timers.pending().map((timer) => timer.delayMs)).toEqual([2_000]);
});

test("the backoff starts again from its first wait in another workspace", async () => {
  const live = setup();
  live.service.load();
  live.account.reads[0]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.timers.pending().map((timer) => timer.delayMs)).toEqual([2_000]);

  // Another workspace, whose people load with the account's own admin.
  live.workspaces.set({ selected: OTHER_WORKSPACE, people: [] });
  expect(live.timers.pending()).toEqual([]);
  live.workspaces.set({ people: [person(OWN, "admin")] });
  expect(live.account.reads[1]?.params).toEqual({
    workspaceId: OTHER_WORKSPACE,
  });
  live.account.reads[1]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.timers.pending().map((timer) => timer.delayMs)).toEqual([2_000]);
});

test("while the role is not known, a request answers loading, and the list loads once the people show the owner's or an admin's role", async () => {
  const live = setup();
  live.workspaces.set({ people: [] });
  expect(live.service.load()).toEqual({ outcome: "loading" });
  expect(live.service.state().status).toBe("loading");
  expect(live.account.reads).toEqual([]);
  live.workspaces.set({ people: [person(OWN, "owner")] });
  expect(live.account.reads).toHaveLength(1);
  // Further changes of the workspace with the same role load nothing more.
  live.workspaces.set({
    people: [person(OWN, "owner"), person(INVITEE, "member")],
  });
  expect(live.account.reads).toHaveLength(1);
});

test("after the screen asked, workspace.subscribed and a claim of the selected workspace load again, and the same frames of another workspace do not", async () => {
  const live = setup();
  live.service.load();
  live.account.reads[0]?.resolve(list(INVITATION));
  await settle();

  live.connection.receive(subscribed(OTHER_WORKSPACE));
  live.connection.receive(claimed(OTHER_WORKSPACE));
  live.connection.receive(
    membershipEvent("workspace.member.renamed", {
      memberId: INVITEE,
      displayName: "Grace Renamed",
    }),
  );
  expect(live.account.reads).toHaveLength(1);

  live.connection.receive(subscribed());
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve(list(INVITATION));
  await settle();

  // A claim consumed the invitation.
  live.connection.receive(claimed());
  expect(live.account.reads).toHaveLength(3);
  live.account.reads[2]?.resolve(list());
  await settle();
  expect(live.service.state().invitations).toEqual([]);

  // An action reloads the selected workspace only.
  expect(live.service.reload(OTHER_WORKSPACE)).toBe(false);
  expect(live.service.reload(WORKSPACE)).toBe(true);
  expect(live.account.reads).toHaveLength(4);
});

test("triggers while a load is on its way merge into one more load, and the older answer is dropped", async () => {
  const live = setup();
  live.service.load();
  live.connection.receive(subscribed());
  live.connection.receive(claimed());
  expect(live.service.reload(WORKSPACE)).toBe(true);
  expect(live.account.reads).toHaveLength(1);

  live.account.reads[0]?.resolve(list(INVITATION));
  await settle();
  // The answer was asked for before the triggers: it does not apply.
  expect(live.service.state().status).toBe("loading");
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve(list(OTHER_INVITATION));
  await settle();
  expect(live.service.state().invitations.map((entry) => entry.id)).toEqual([
    OTHER_INVITATION,
  ]);
  expect(live.account.reads).toHaveLength(2);
});

test("a failed load keeps what was loaded, shows the problem, and is retried with the workspace service's backoff; triggers during the backoff wait for the retry", async () => {
  const live = setup();
  live.service.load();
  live.account.reads[0]?.resolve(list(INVITATION));
  await settle();

  live.service.reload(WORKSPACE);
  live.account.reads[1]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.service.state()).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
    invitations: [{ id: INVITATION }],
  });
  expect(live.logs).toEqual(["The invitations did not load (unavailable)."]);
  expect(live.timers.pending().map((timer) => timer.delayMs)).toEqual([2_000]);

  // Triggers wait for the retry, which reads everything.
  live.connection.receive(subscribed());
  live.connection.receive(claimed());
  expect(live.service.reload(WORKSPACE)).toBe(true);
  expect(live.account.reads).toHaveLength(2);

  live.timers.fire();
  expect(live.account.reads).toHaveLength(3);
  live.account.reads[2]?.resolve({ ok: false, reason: "failed" });
  await settle();
  expect(live.timers.pending().map((timer) => timer.delayMs)).toEqual([4_000]);
  live.timers.fire();
  live.account.reads[3]?.resolve(list());
  await settle();
  expect(live.service.state()).toEqual({
    revision: expect.any(Number),
    status: "ready",
    workspaceId: WORKSPACE,
    invitations: [],
  });

  // After `rate_limited`, the wait is 60 seconds, also when a trigger came
  // during the load.
  live.service.reload(WORKSPACE);
  live.service.reload(WORKSPACE);
  live.account.reads[4]?.resolve({ ok: false, reason: "rate_limited" });
  await settle();
  expect(live.account.reads).toHaveLength(5);
  expect(live.timers.pending().map((timer) => timer.delayMs)).toEqual([60_000]);
  expect(live.service.state()).toMatchObject({ problem: "rate_limited" });
});

test("a read that rejects, and a list that names another workspace, are failures", async () => {
  const live = setup();
  live.service.load();
  live.account.reads[0]?.reject(new Error("no answer"));
  await settle();
  expect(live.service.state()).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
  });
  live.timers.fire();
  const value = InvitationListResponseSchema.parse({
    invitations: [
      {
        id: INVITATION,
        workspaceId: OTHER_WORKSPACE,
        memberId: INVITEE,
        createdByMemberId: OWN,
        createdAt: AT,
        expiresAt: EXPIRES_AT,
      },
    ],
  });
  live.account.reads[1]?.resolve({ ok: true, value });
  await settle();
  expect(live.service.state()).toMatchObject({
    status: "unavailable",
    problem: "failed",
    invitations: [],
  });
});

test("offline, a failure schedules no retry and a lost connection cancels one; the next workspace.subscribed loads", async () => {
  const live = setup();
  live.service.load();
  live.account.reads[0]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.timers.pending()).toHaveLength(1);
  live.connection.setState("offline");
  expect(live.timers.pending()).toEqual([]);

  live.connection.receive(subscribed());
  expect(live.account.reads).toHaveLength(2);
  live.account.reads[1]?.resolve({ ok: false, reason: "unavailable" });
  await settle();
  expect(live.timers.pending()).toEqual([]);
});

test("another workspace, also the reset of another device, and a sign-out drop the invitations and the answers on their way", async () => {
  const live = setup();
  live.service.load();
  live.account.reads[0]?.resolve(list(INVITATION));
  await settle();

  // Another workspace: its people load later, and an earlier answer is dropped.
  live.service.reload(WORKSPACE);
  live.workspaces.set({ selected: OTHER_WORKSPACE, people: [] });
  expect(live.service.state()).toMatchObject({
    status: "loading",
    workspaceId: OTHER_WORKSPACE,
    invitations: [],
  });
  live.account.reads[1]?.resolve(list(INVITATION));
  await settle();
  expect(live.service.state().invitations).toEqual([]);
  live.workspaces.set({ people: [person(OWN, "admin")] });
  expect(live.account.reads[2]?.params).toEqual({
    workspaceId: OTHER_WORKSPACE,
  });
  live.account.reads[2]?.resolve(listIn(OTHER_WORKSPACE, OTHER_INVITATION));
  await settle();
  expect(live.service.state().invitations).toHaveLength(1);

  // A sign-out.
  live.workspaces.set({ status: "signed_out", selected: null, people: [] });
  expect(live.service.state()).toMatchObject({
    status: "signed_out",
    workspaceId: null,
    invitations: [],
  });
});

test("every change raises the revision once and reaches the listeners; close stops everything", async () => {
  const live = setup();
  const seen: number[] = [];
  const remove = live.service.onChange((state) => seen.push(state.revision));
  live.service.load();
  live.account.reads[0]?.resolve({ ok: false, reason: "unavailable" });
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
