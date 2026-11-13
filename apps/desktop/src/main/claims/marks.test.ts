import {
  ClaimListResponseSchema,
  type MemberId,
  type MemberRole,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import type { WorkspaceReadResult } from "../api-reads.ts";
import {
  RATE_LIMITED_RETRY_MS,
  WORKSPACE_RETRY_BASE_MS,
  type WorkspaceState,
} from "../workspace/service.ts";
import {
  type ClaimMarkServiceOptions,
  type ClaimMarkState,
  createClaimMarkService,
} from "./marks.ts";
import { MAX_SEEN_CLAIMS_PER_ENTRY } from "./seen-store.ts";
import type { ClaimListState, ClaimState } from "./service.ts";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WS_A = id(0xa1) as WorkspaceId;
const WS_B = id(0xa2) as WorkspaceId;
const WS_C = id(0xa3) as WorkspaceId;
const WS_D = id(0xa4) as WorkspaceId;
/** The account's own person in each workspace. */
const OWN: Readonly<Record<string, MemberId>> = {
  [WS_A]: id(0xc1) as MemberId,
  [WS_B]: id(0xc2) as MemberId,
  [WS_C]: id(0xc3) as MemberId,
  [WS_D]: id(0xc4) as MemberId,
};
/** The account's own person after another account signed in. */
const NEXT_OWN = id(0xc9) as MemberId;
const FIRST = id(0xd1) as MemberId;
const SECOND = id(0xd2) as MemberId;
const THIRD = id(0xd3) as MemberId;
const CLAIMER_USER_ID = id(0xb9);
const T1 = "2026-11-05T10:00:00.000Z";
const T2 = "2026-11-05T11:00:00.000Z";
const T3 = "2026-11-05T12:00:00.000Z";
const LOGIN = "linus";

function ownOf(workspaceId: WorkspaceId): MemberId {
  return OWN[workspaceId] as MemberId;
}

interface Listed {
  readonly id: WorkspaceId;
  readonly role: MemberRole;
  readonly own?: MemberId;
}

/**
 * The workspace service: its list with the account's own person and role in
 * each workspace, the selection, and the list's generation, which the test
 * changes and then reports with `set`.
 */
function fakeWorkspaces() {
  let revision = 0;
  let status: WorkspaceState["status"] = "ready";
  let listed: readonly Listed[] = [];
  let selected: WorkspaceId | null = null;
  let generation = 0;
  const listeners = new Set<(state: WorkspaceState) => void>();
  const state = (): WorkspaceState =>
    Object.freeze({
      revision,
      status,
      workspaces: Object.freeze(
        listed.map((entry) => Object.freeze({ id: entry.id, name: "Name" })),
      ),
      selectedWorkspaceId: selected,
      projects: Object.freeze([]),
      openProjectId: null,
    });
  const entry = (workspaceId: WorkspaceId) =>
    listed.find((item) => item.id === workspaceId);
  const workspaces: ClaimMarkServiceOptions["workspaces"] = {
    state,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ownMemberId: (workspaceId) => {
      const item = entry(workspaceId);
      return item === undefined ? null : (item.own ?? ownOf(workspaceId));
    },
    ownRole: (workspaceId) => entry(workspaceId)?.role ?? null,
    listGeneration: () => generation,
  };
  return {
    workspaces,
    listeners: () => listeners.size,
    set(next: {
      status?: WorkspaceState["status"];
      selected?: WorkspaceId | null;
      /** A new answer of the list: the generation grows. */
      list?: readonly Listed[];
      /** A change of the list without an answer, such as a lost membership. */
      listedWithoutLoad?: readonly Listed[];
    }) {
      status = next.status ?? status;
      selected = next.selected === undefined ? selected : next.selected;
      if (next.list !== undefined) {
        listed = next.list;
        generation += 1;
      }
      if (next.listedWithoutLoad !== undefined) {
        listed = next.listedWithoutLoad;
      }
      revision += 1;
      for (const listener of [...listeners]) {
        listener(state());
      }
    },
    /** A sign-out: the workspace service resets, with a new generation. */
    signOut() {
      status = "signed_out";
      listed = [];
      selected = null;
      generation += 1;
      revision += 1;
      for (const listener of [...listeners]) {
        listener(state());
      }
    },
  };
}

function claimState(
  memberId: MemberId,
  overrides: Partial<ClaimState> = {},
): ClaimState {
  return Object.freeze({
    memberId,
    claimer: Object.freeze({
      login: LOGIN,
      verifiedAt: T1,
      accountCreatedAt: T1,
    }),
    via: "invitation",
    claimedAt: T1,
    unseen: true,
    ...overrides,
  });
}

/**
 * The claim service: its state of the selected workspace and the seen
 * claims by workspace and own person; null until the file was read.
 */
function fakeClaims() {
  let state: ClaimListState = Object.freeze({
    revision: 0,
    status: "signed_out",
    workspaceId: null,
    claims: Object.freeze([]),
  });
  let seen: Map<string, Set<MemberId>> | null = new Map();
  const listeners = new Set<(state: ClaimListState) => void>();
  const asked: string[] = [];
  const claims: ClaimMarkServiceOptions["claims"] = {
    state: () => state,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    seenMemberIds: (workspaceId, ownMemberId) => {
      asked.push(`${workspaceId} ${ownMemberId}`);
      if (seen === null) {
        return null;
      }
      return new Set(seen.get(`${workspaceId} ${ownMemberId}`) ?? []);
    },
  };
  const fire = () => {
    for (const listener of [...listeners]) {
      listener(state);
    }
  };
  return {
    claims,
    asked,
    listeners: () => listeners.size,
    notRead() {
      seen = null;
    },
    /** The seen claims of `ownMemberId` in `workspaceId`, then a change. */
    see(
      workspaceId: WorkspaceId,
      memberIds: readonly MemberId[],
      ownMemberId: MemberId = ownOf(workspaceId),
    ) {
      seen ??= new Map();
      const key = `${workspaceId} ${ownMemberId}`;
      seen.set(key, new Set([...(seen.get(key) ?? []), ...memberIds]));
      fire();
    },
    set(next: Partial<ClaimListState>) {
      state = Object.freeze({
        ...state,
        ...next,
        revision: state.revision + 1,
      });
      fire();
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
    readonly params: { readonly workspaceId: WorkspaceId };
    readonly resolve: (result: ListResult) => void;
    readonly reject: (error: unknown) => void;
  }[] = [];
  const account = {
    readWorkspaceData: (
      name: string,
      params: { readonly workspaceId: WorkspaceId },
    ) =>
      new Promise<ListResult>((resolve, reject) => {
        reads.push({ name, params, resolve, reject });
      }),
  } as unknown as ClaimMarkServiceOptions["account"];
  return { account, reads };
}

function fakeConnection() {
  let state = "connected";
  const listeners = new Set<(status: { state: string }) => void>();
  const connection = {
    status: () => ({ state, revision: 1 }),
    onStatusChange: (listener: (status: { state: string }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ClaimMarkServiceOptions["connection"];
  return {
    connection,
    listeners: () => listeners.size,
    setState(next: string) {
      state = next;
      for (const listener of [...listeners]) {
        listener({ state: next });
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
    retries: () =>
      timers.filter((timer) => timer.active).map((timer) => timer.delayMs),
    fire() {
      for (const timer of timers.filter((entry) => entry.active)) {
        timer.active = false;
        timer.callback();
      }
    },
  };
}

/** A claim as the API lists it, with the claimer's login. */
function claim(
  workspaceId: WorkspaceId,
  memberId: MemberId,
  claimedAt: string = T1,
) {
  return {
    workspaceId,
    memberId,
    claimer: {
      provider: "github",
      login: LOGIN,
      verifiedAt: T1,
      accountCreatedAt: T1,
    },
    via: "invitation",
    claimedAt,
  };
}

function list(
  workspaceId: WorkspaceId,
  ...memberIds: readonly MemberId[]
): ListResult {
  const times = [T3, T2, T1];
  return {
    ok: true,
    value: ClaimListResponseSchema.parse({
      claims: memberIds.map((memberId, index) =>
        claim(workspaceId, memberId, times[index] ?? T1),
      ),
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
  const claims = fakeClaims();
  const account = fakeAccount();
  const connection = fakeConnection();
  const timers = fakeTimers();
  const logs: string[] = [];
  const states: ClaimMarkState[] = [];
  const service = createClaimMarkService({
    account: account.account,
    connection: connection.connection,
    workspaces: workspaces.workspaces,
    claims: claims.claims,
    scheduleTimer: timers.schedule,
    log: (message) => logs.push(message),
  });
  service.onChange((state) => states.push(state));
  return {
    service,
    workspaces,
    claims,
    account,
    connection,
    timers,
    logs,
    states,
    marked: () => service.state().workspaceIds,
    /** The workspaces read so far, in order. */
    readIds: () => account.reads.map((read) => read.params.workspaceId),
    /** Answers the read of `index` and lets the next one start. */
    async answer(index: number, result: ListResult) {
      account.reads[index]?.resolve(result);
      await settle();
    },
  };
}

/** A, selected and owned; B owned; C with an admin; D with a member. */
const FOUR: readonly Listed[] = [
  { id: WS_A, role: "owner" },
  { id: WS_B, role: "owner" },
  { id: WS_C, role: "admin" },
  { id: WS_D, role: "member" },
];

test("after the list loads, only the other workspaces where the account's own person is the owner or an admin are read, one at a time, in the list's order", async () => {
  const live = setup();
  expect(live.service.state()).toEqual({ revision: 0, workspaceIds: [] });
  expect(live.account.reads).toEqual([]);

  live.workspaces.set({ list: FOUR, selected: WS_A });
  // The selected workspace is the claim service's; a member's is never read.
  expect(live.readIds()).toEqual([WS_B]);
  expect(live.account.reads[0]?.name).toBe("listClaims");
  await live.answer(0, list(WS_B, FIRST));
  expect(live.readIds()).toEqual([WS_B, WS_C]);
  await live.answer(1, list(WS_C));
  expect(live.readIds()).toEqual([WS_B, WS_C]);
  expect(live.marked()).toEqual([WS_B]);

  // The role is the account's own person's: a workspace where it is a
  // member is never read, whoever else owns it.
  const member = setup();
  member.workspaces.set({
    list: [
      { id: WS_A, role: "member" },
      { id: WS_B, role: "member" },
    ],
    selected: null,
  });
  await settle();
  expect(member.account.reads).toEqual([]);
});

test("each answer of the list reads each workspace once, and nothing else reads", async () => {
  const live = setup();
  live.workspaces.set({ list: FOUR, selected: WS_A });
  await live.answer(0, list(WS_B, FIRST));
  await live.answer(1, list(WS_C, SECOND));
  expect(live.readIds()).toEqual([WS_B, WS_C]);

  // Another change of the workspaces, a change of the claims, a change of
  // the seen claims, and a reconnect without a new list read nothing.
  live.workspaces.set({ status: "ready" });
  live.claims.set({ status: "loading", workspaceId: WS_A });
  live.claims.see(WS_B, [FIRST]);
  live.connection.setState("offline");
  live.connection.setState("connected");
  await settle();
  expect(live.readIds()).toEqual([WS_B, WS_C]);

  // The list loads again, after a reconnect or another trigger of the list:
  // each workspace is read once more.
  live.workspaces.set({ list: FOUR });
  await live.answer(2, list(WS_B, FIRST));
  await live.answer(3, list(WS_C, SECOND));
  expect(live.readIds()).toEqual([WS_B, WS_C, WS_B, WS_C]);
  await settle();
  expect(live.account.reads).toHaveLength(4);
});

test("a new answer of the list while a read is on its way drops that answer and reads its own workspaces after it, one at a time", async () => {
  const live = setup();
  live.workspaces.set({ list: FOUR, selected: WS_A });
  expect(live.readIds()).toEqual([WS_B]);
  live.workspaces.set({ list: FOUR });
  // The read on its way finishes first.
  expect(live.readIds()).toEqual([WS_B]);
  await live.answer(0, list(WS_B, FIRST));
  // Its answer counts for nothing; the new list reads B again.
  expect(live.marked()).toEqual([]);
  expect(live.readIds()).toEqual([WS_B, WS_B]);
  await live.answer(1, list(WS_B, FIRST));
  expect(live.marked()).toEqual([WS_B]);
});

test("the selected workspace is never read: also one selected while the reads run, and an answer for a workspace selected meanwhile is dropped", async () => {
  const live = setup();
  live.workspaces.set({ list: FOUR, selected: WS_A });
  expect(live.readIds()).toEqual([WS_B]);
  // C is selected before its turn: it is skipped.
  live.workspaces.set({ selected: WS_C });
  await live.answer(0, list(WS_B, FIRST));
  expect(live.readIds()).toEqual([WS_B]);
  await settle();
  expect(live.account.reads).toHaveLength(1);

  // B's read is on its way when B is selected: its answer is the claim
  // service's to give.
  live.workspaces.set({ list: FOUR, selected: WS_A });
  expect(live.readIds()).toEqual([WS_B, WS_B]);
  live.workspaces.set({ selected: WS_B });
  await live.answer(1, list(WS_B, FIRST, SECOND));
  // A is still skipped while selected, and C follows.
  expect(live.readIds()).toEqual([WS_B, WS_B, WS_C]);
  await live.answer(2, list(WS_C));
  live.workspaces.set({ selected: WS_A });
  // B kept the first answer only; the selected one's was dropped.
  live.claims.see(WS_B, [FIRST]);
  expect(live.marked()).toEqual([]);
});

test("the selected workspace is never marked by the service, and its claims from the claim service carry its mark once it is not selected", async () => {
  const live = setup();
  live.workspaces.set({ list: FOUR, selected: WS_A });
  await live.answer(0, list(WS_B, FIRST));
  await live.answer(1, list(WS_C));
  expect(live.marked()).toEqual([WS_B]);

  // Selecting B: its mark follows the selected-workspace logic, outside
  // this service.
  live.workspaces.set({ selected: WS_B });
  expect(live.marked()).toEqual([]);
  // The claim service loads B, and the screen reports FIRST as seen.
  live.claims.set({
    status: "ready",
    workspaceId: WS_B,
    claims: [claimState(SECOND), claimState(FIRST)],
  });
  live.claims.see(WS_B, [FIRST]);
  // Back to A: B holds the claim service's claims, and SECOND is unseen.
  live.workspaces.set({ selected: WS_A });
  expect(live.marked()).toEqual([WS_B]);
  live.claims.see(WS_B, [SECOND]);
  expect(live.marked()).toEqual([]);

  // The claims of A, while selected, mark A once B is selected; A was
  // never read by this service.
  live.claims.set({
    status: "ready",
    workspaceId: WS_A,
    claims: [claimState(THIRD)],
  });
  expect(live.marked()).toEqual([]);
  live.workspaces.set({ selected: WS_B });
  expect(live.marked()).toEqual([WS_A]);
  expect(live.readIds()).toEqual([WS_B, WS_C]);

  // A state of the claim service for another workspace than the selected
  // one, and one that is still loading, change nothing.
  live.claims.set({ status: "ready", workspaceId: WS_A, claims: [] });
  expect(live.marked()).toEqual([WS_A]);
  live.claims.set({ status: "loading", workspaceId: WS_B, claims: [] });
  live.workspaces.set({ selected: WS_C });
  expect(live.marked()).toEqual([WS_A]);
});

test("the claim service's not_allowed drops what was held for the selected workspace", async () => {
  const live = setup();
  live.workspaces.set({ list: FOUR, selected: WS_A });
  await live.answer(0, list(WS_B, FIRST));
  await live.answer(1, list(WS_C));
  live.workspaces.set({ selected: WS_B });
  // A demotion while selected, which the list does not show yet.
  live.claims.set({ status: "not_allowed", workspaceId: WS_B, claims: [] });
  live.workspaces.set({ selected: WS_A });
  expect(live.marked()).toEqual([]);
});

test("the seen claims decide: a claim is unseen while the account's own person has not seen it, the own claim and a claim behind the 50 most recent never are, and nothing marks before the file was read", async () => {
  const live = setup();
  live.claims.notRead();
  live.workspaces.set({
    list: [
      { id: WS_A, role: "owner" },
      { id: WS_B, role: "admin" },
      { id: WS_C, role: "owner" },
    ],
    selected: WS_A,
  });
  await live.answer(0, list(WS_B, SECOND, FIRST));
  // C lists only the account's own claim, as an admin who joined with an
  // invitation sees it.
  await live.answer(1, list(WS_C, ownOf(WS_C)));
  // Before the seen claims file was read, nothing is marked.
  expect(live.marked()).toEqual([]);
  live.claims.see(WS_B, []);
  expect(live.marked()).toEqual([WS_B]);
  // Each seen claim counts, compared by the account's own person in B.
  expect(live.claims.asked).toContain(`${WS_B} ${ownOf(WS_B)}`);
  live.claims.see(WS_B, [SECOND]);
  expect(live.marked()).toEqual([WS_B]);
  // Seen by another own person, such as another account's: it stays.
  live.claims.see(WS_B, [FIRST], NEXT_OWN);
  expect(live.marked()).toEqual([WS_B]);
  live.claims.see(WS_B, [FIRST]);
  expect(live.marked()).toEqual([]);

  // Behind the 50 most recent claims of a list, a claim is never unseen.
  const many = setup();
  many.workspaces.set({
    list: [{ id: WS_B, role: "owner" }],
    selected: null,
  });
  const recent = Array.from(
    { length: MAX_SEEN_CLAIMS_PER_ENTRY },
    (_, index) => id(0x1000 + index) as MemberId,
  );
  const behind = id(0x2000) as MemberId;
  await many.answer(0, {
    ok: true,
    value: ClaimListResponseSchema.parse({
      claims: [...recent, behind].map((memberId) => claim(WS_B, memberId)),
    }),
  });
  expect(many.marked()).toEqual([WS_B]);
  many.claims.see(WS_B, recent);
  expect(many.marked()).toEqual([]);
});

test("unavailable and rate_limited are retried with the backoff, the reads after them wait, and a success starts the backoff again", async () => {
  const live = setup();
  live.workspaces.set({ list: FOUR, selected: WS_A });
  await live.answer(0, { ok: false, reason: "unavailable" });
  expect(live.timers.retries()).toEqual([WORKSPACE_RETRY_BASE_MS]);
  // C waits for the retry.
  expect(live.readIds()).toEqual([WS_B]);
  // A new list keeps the waiting retry: the retry reads its workspaces.
  live.workspaces.set({ list: FOUR });
  expect(live.readIds()).toEqual([WS_B]);
  live.timers.fire();
  expect(live.readIds()).toEqual([WS_B, WS_B]);
  await live.answer(1, { ok: false, reason: "unavailable" });
  expect(live.timers.retries()).toEqual([WORKSPACE_RETRY_BASE_MS * 2]);
  live.timers.fire();
  await live.answer(2, { ok: false, reason: "rate_limited" });
  expect(live.timers.retries()).toEqual([RATE_LIMITED_RETRY_MS]);
  live.timers.fire();
  // A read that rejects counts as unavailable.
  live.account.reads[3]?.reject(new Error(`EACCES ${CLAIMER_USER_ID}`));
  await settle();
  expect(live.timers.retries()).toEqual([WORKSPACE_RETRY_BASE_MS * 8]);
  live.timers.fire();
  await live.answer(4, list(WS_B, FIRST));
  // The success starts the backoff again, and C is read after B.
  expect(live.readIds()).toEqual([WS_B, WS_B, WS_B, WS_B, WS_B, WS_C]);
  await live.answer(5, { ok: false, reason: "unavailable" });
  expect(live.timers.retries()).toEqual([WORKSPACE_RETRY_BASE_MS]);
  expect(live.marked()).toEqual([WS_B]);
  expect(live.logs).toContain(
    "The claims of another workspace did not load (rate_limited).",
  );
  for (const line of live.logs) {
    expect(line).not.toContain(CLAIMER_USER_ID);
    expect(line).not.toContain(WS_B);
  }
});

test("a transient failure keeps what was held; offline, no retry is scheduled, a lost connection cancels one, and the next list reads again", async () => {
  const live = setup();
  live.workspaces.set({ list: FOUR, selected: WS_A });
  await live.answer(0, list(WS_B, FIRST));
  await live.answer(1, list(WS_C));
  expect(live.marked()).toEqual([WS_B]);

  live.workspaces.set({ list: FOUR });
  await live.answer(2, { ok: false, reason: "unavailable" });
  // What was held for B stays.
  expect(live.marked()).toEqual([WS_B]);
  expect(live.timers.retries()).toEqual([WORKSPACE_RETRY_BASE_MS]);
  live.connection.setState("offline");
  expect(live.timers.retries()).toEqual([]);
  live.connection.setState("connected");
  await settle();
  expect(live.readIds()).toEqual([WS_B, WS_C, WS_B]);
  // The list loads again on the reconnect, and its reads begin.
  live.workspaces.set({ list: FOUR });
  expect(live.readIds()).toEqual([WS_B, WS_C, WS_B, WS_B]);
  live.connection.setState("offline");
  await live.answer(3, { ok: false, reason: "unavailable" });
  expect(live.timers.retries()).toEqual([]);
  await settle();
  expect(live.account.reads).toHaveLength(4);
});

test("failed, not_found, and not_signed_in drop what was held for the workspace, are not retried, and the next workspace is read", async () => {
  for (const reason of ["failed", "not_found", "not_signed_in"] as const) {
    const live = setup();
    live.workspaces.set({ list: FOUR, selected: WS_A });
    await live.answer(0, list(WS_B, FIRST));
    await live.answer(1, list(WS_C, SECOND));
    expect(live.marked(), reason).toEqual([WS_B, WS_C]);
    live.workspaces.set({ list: FOUR });
    // A member's `forbidden` after a demotion gives `failed`.
    await live.answer(2, { ok: false, reason });
    expect(live.marked(), reason).toEqual([WS_C]);
    expect(live.timers.retries(), reason).toEqual([]);
    expect(live.readIds(), reason).toEqual([WS_B, WS_C, WS_B, WS_C]);
  }
  // A list that names another workspace is `failed`.
  const other = setup();
  other.workspaces.set({ list: FOUR, selected: WS_A });
  await other.answer(0, list(WS_C, FIRST));
  expect(other.marked()).toEqual([]);
  expect(other.timers.retries()).toEqual([]);
  expect(other.logs).toEqual([
    "The claims of another workspace did not load (failed).",
  ]);
});

test("a sign-out and another device drop everything, also an answer on its way and a waiting retry", async () => {
  const live = setup();
  live.workspaces.set({ list: FOUR, selected: WS_A });
  await live.answer(0, list(WS_B, FIRST));
  await live.answer(1, list(WS_C, SECOND));
  expect(live.marked()).toEqual([WS_B, WS_C]);
  live.workspaces.set({ list: FOUR });
  live.workspaces.signOut();
  expect(live.marked()).toEqual([]);
  await live.answer(2, list(WS_B, FIRST));
  expect(live.marked()).toEqual([]);
  expect(live.readIds()).toEqual([WS_B, WS_C, WS_B]);
  expect(live.states.at(-1)?.workspaceIds).toEqual([]);
  // Signing in again to the same account holds nothing from before: the
  // marks wait for the new reads.
  live.workspaces.set({ status: "ready", list: FOUR, selected: WS_A });
  expect(live.marked()).toEqual([]);
  expect(live.readIds()).toEqual([WS_B, WS_C, WS_B, WS_B]);

  // A waiting retry ends with the sign-out.
  const waiting = setup();
  waiting.workspaces.set({ list: FOUR, selected: WS_A });
  await waiting.answer(0, { ok: false, reason: "rate_limited" });
  expect(waiting.timers.retries()).toEqual([RATE_LIMITED_RETRY_MS]);
  waiting.workspaces.signOut();
  expect(waiting.timers.retries()).toEqual([]);

  // Another device: the workspace service resets to an empty list at once,
  // and the other account's list names other own people.
  const device = setup();
  device.workspaces.set({ list: FOUR, selected: WS_A });
  await device.answer(0, list(WS_B, FIRST));
  await device.answer(1, list(WS_C));
  expect(device.marked()).toEqual([WS_B]);
  device.workspaces.set({ status: "loading", list: [], selected: null });
  expect(device.marked()).toEqual([]);
  device.workspaces.set({
    status: "ready",
    list: [
      { id: WS_A, role: "member", own: NEXT_OWN },
      { id: WS_B, role: "member", own: NEXT_OWN },
    ],
    selected: WS_A,
  });
  await settle();
  expect(device.marked()).toEqual([]);
  expect(device.readIds()).toEqual([WS_B, WS_C]);
});

test("a workspace that the list no longer holds, another own person in it, and a newer list without the owner's or an admin's role drop what was held", async () => {
  const live = setup();
  live.workspaces.set({ list: FOUR, selected: WS_A });
  await live.answer(0, list(WS_B, FIRST));
  await live.answer(1, list(WS_C, SECOND));
  expect(live.marked()).toEqual([WS_B, WS_C]);

  // A lost membership leaves the list before it loads again.
  live.workspaces.set({
    listedWithoutLoad: FOUR.filter((entry) => entry.id !== WS_C),
  });
  expect(live.marked()).toEqual([WS_B]);
  // Another own person in B, for example after a removal and a new claim.
  live.workspaces.set({
    listedWithoutLoad: [
      { id: WS_A, role: "owner" },
      { id: WS_B, role: "owner", own: NEXT_OWN },
    ],
  });
  expect(live.marked()).toEqual([]);

  const demoted = setup();
  demoted.workspaces.set({ list: FOUR, selected: WS_A });
  await demoted.answer(0, list(WS_B, FIRST));
  await demoted.answer(1, list(WS_C, SECOND));
  demoted.workspaces.set({
    list: [
      { id: WS_A, role: "owner" },
      { id: WS_B, role: "member" },
      { id: WS_C, role: "admin" },
    ],
  });
  expect(demoted.marked()).toEqual([WS_C]);
  // B is not read for the member.
  expect(demoted.readIds()).toEqual([WS_B, WS_C, WS_C]);
});

test("the state holds workspace IDs only, never a claim, a login, or a user ID, and a change publishes once with a new revision", async () => {
  const live = setup();
  live.workspaces.set({ list: FOUR, selected: WS_A });
  await live.answer(0, list(WS_B, FIRST, SECOND));
  await live.answer(1, list(WS_C));
  const state = live.service.state();
  expect(state).toEqual({ revision: 1, workspaceIds: [WS_B] });
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state.workspaceIds)).toBe(true);
  const text = JSON.stringify(live.states);
  for (const value of [LOGIN, FIRST, SECOND, CLAIMER_USER_ID, ownOf(WS_B)]) {
    expect(text).not.toContain(value);
  }
  expect(live.states).toHaveLength(1);
  // A change that leaves the marks as they are publishes nothing.
  live.workspaces.set({ status: "ready" });
  live.claims.see(WS_B, [FIRST]);
  expect(live.states).toHaveLength(1);
  live.claims.see(WS_B, [SECOND]);
  expect(live.states.map((entry) => entry.revision)).toEqual([1, 2]);
});

test("close stops listening and cancels the retry, and a late answer changes nothing", async () => {
  const live = setup();
  live.workspaces.set({ list: FOUR, selected: WS_A });
  await live.answer(0, { ok: false, reason: "unavailable" });
  live.timers.fire();
  live.service.close();
  live.service.close();
  expect(live.workspaces.listeners()).toBe(0);
  expect(live.claims.listeners()).toBe(0);
  expect(live.connection.listeners()).toBe(0);
  await live.answer(1, list(WS_B, FIRST));
  expect(live.marked()).toEqual([]);
  expect(live.readIds()).toEqual([WS_B, WS_B]);
  expect(live.timers.retries()).toEqual([]);
});
