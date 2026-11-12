import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeServerMessage,
  type OwnJoinRequestListResponse,
  OwnJoinRequestListResponseSchema,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import type {
  AccountStatus,
  ConnectionStatus,
} from "../../shared/ipc-contract.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type { ServerMessage } from "../connection/client.ts";
import {
  RATE_LIMITED_RETRY_MS,
  WORKSPACE_RETRY_BASE_MS,
} from "../workspace/service.ts";
import {
  createOwnJoinRequestService,
  OWN_JOIN_REQUEST_EXPIRY_CHECK_MAX_MS,
  OWN_JOIN_REQUEST_LOAD_COOLDOWN_MS,
  type OwnJoinRequestAccount,
  type OwnJoinRequestConnection,
  type OwnJoinRequestListState,
  type OwnJoinRequestService,
} from "./service.ts";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const DEVICE_ID = id(0xd1);
const OTHER_DEVICE_ID = id(0xd2);
const WORKSPACE = id(0xa1);
const OTHER_WORKSPACE = id(0xa2);
const FIRST = id(0xf1);
const SECOND = id(0xf2);
const THIRD = id(0xf3);
const FOURTH = id(0xf4);
const MEMBER = id(0xc1);
const USER = id(0xb1);
const CREATED_AT = "2026-11-05T10:00:00.000Z";
const DECIDED_AT = "2026-11-06T09:00:00.000Z";
/** The system clock of the tests. */
const WALL = Date.parse("2026-11-06T10:00:00.000Z");
/** Six days after `WALL`, so the expiry timer waits its longest. */
const EXPIRES_AT = "2026-11-12T10:00:00.000Z";
/** Five minutes after `WALL`. */
const SOON = "2026-11-06T10:05:00.000Z";
const SOON_MS = 5 * 60_000;

/** Every name and ID that the fixtures use, which no log may hold. */
const SECRETS = [
  "Linus Requester",
  "Grace Requester",
  WORKSPACE,
  OTHER_WORKSPACE,
  FIRST,
  SECOND,
  THIRD,
  DEVICE_ID,
];

function accountStatus(
  overrides: Partial<AccountStatus> = {},
  deviceId: string = DEVICE_ID,
): AccountStatus {
  return Object.freeze({
    revision: 1,
    account: Object.freeze({
      kind: "signed_in",
      login: "linus",
      displayName: "Linus Requester",
      deviceId,
      signInExpiresAt: "2026-12-02T10:00:00.000Z",
    }),
    signIn: Object.freeze({ kind: "idle" }),
    lastOutcome: null,
    deviceKey: "ready",
    replacementPending: false,
    apiOrigin: "set",
    device: "signed_in",
    ...overrides,
  }) as AccountStatus;
}

const SIGNED_OUT = accountStatus({
  account: Object.freeze({ kind: "hidden" }),
  device: "signed_out",
});

/** One of the account's own requests, as `GET /join-requests` lists it. */
function item(joinRequestId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: joinRequestId,
    workspaceId: WORKSPACE,
    requestedDisplayName: "Linus Requester",
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    decision: null,
    decidedAt: null,
    ...overrides,
  };
}

/** The account service's answer, parsed with the protocol's schema. */
function list(
  items: readonly Record<string, unknown>[],
): OwnJoinRequestListResponse {
  return OwnJoinRequestListResponseSchema.parse({ joinRequests: items });
}

function ok(
  value: OwnJoinRequestListResponse,
): WorkspaceReadResult<OwnJoinRequestListResponse> {
  return { ok: true, value };
}

function failure(reason: WorkspaceReadFailure): WorkspaceReadResult<never> {
  return { ok: false, reason };
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

function decided(
  decision: "approved" | "denied" = "denied",
  joinRequestId: string = FIRST,
): ServerMessage {
  return decoded({
    type: "account.join_request_decided",
    joinRequestId,
    workspaceId: WORKSPACE,
    decision,
    decidedAt: DECIDED_AT,
  });
}

/** The account's own person claimed in a workspace that it is subscribed to. */
function ownClaim(): ServerMessage {
  return decoded({
    id: id(0x9001),
    occurredAt: DECIDED_AT,
    workspaceId: WORKSPACE,
    actor: { kind: "system" },
    deviceId: null,
    type: "workspace.member.claimed",
    payload: {
      member: {
        id: MEMBER,
        workspaceId: WORKSPACE,
        displayName: "Linus Requester",
        role: "member",
        userId: USER,
        identity: {
          provider: "github",
          login: "linus",
          verifiedAt: CREATED_AT,
        },
        removedAt: null,
      },
    },
  });
}

interface Timer {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

class Harness {
  accountStatus: AccountStatus;
  connectionStatus: ConnectionStatus;
  /** The monotonic clock. */
  clock = 0;
  /** The system clock, in milliseconds since the epoch. */
  wall = WALL;
  readonly accountListeners = new Set<(status: AccountStatus) => void>();
  readonly connectionListeners = new Set<(status: ConnectionStatus) => void>();
  readonly messageListeners = new Set<(message: ServerMessage) => void>();
  /** The reads that wait for an answer, the oldest first. */
  readonly reads: {
    readonly resolve: (
      result: WorkspaceReadResult<OwnJoinRequestListResponse>,
    ) => void;
    readonly reject: (error: unknown) => void;
  }[] = [];
  /** Every read that was sent, with its name and parameters. */
  readonly sentReads: { readonly name: string; readonly params: unknown }[] =
    [];
  readonly timers: Timer[] = [];
  readonly logs: string[] = [];
  readonly states: OwnJoinRequestListState[] = [];
  readonly service: OwnJoinRequestService;

  constructor(
    status: AccountStatus = accountStatus(),
    connection: ConnectionStatus["state"] = "connected",
  ) {
    this.accountStatus = status;
    this.connectionStatus = {
      state: connection,
      revision: 0,
    } as ConnectionStatus;
    const account = {
      status: () => this.accountStatus,
      onStatusChange: (listener: (status: AccountStatus) => void) => {
        this.accountListeners.add(listener);
        return () => this.accountListeners.delete(listener);
      },
      readWorkspaceData: (name: string, params: unknown) =>
        new Promise((resolve, reject) => {
          this.sentReads.push({ name, params });
          this.reads.push({ resolve, reject });
        }),
    } as unknown as OwnJoinRequestAccount;
    const client: OwnJoinRequestConnection = {
      status: () => this.connectionStatus,
      onStatusChange: (listener) => {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
      },
      onMessage: (listener) => {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
      },
    };
    this.service = createOwnJoinRequestService({
      account,
      connection: client,
      now: () => this.clock,
      clock: () => this.wall,
      scheduleTimer: (callback, delayMs) => {
        const timer: Timer = { callback, delayMs, cancelled: false };
        this.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      log: (message) => this.logs.push(message),
    });
    this.service.onChange((state) => this.states.push(state));
  }

  get sent(): number {
    return this.sentReads.length;
  }

  setAccount(status: AccountStatus): void {
    this.accountStatus = status;
    for (const listener of [...this.accountListeners]) {
      listener(status);
    }
  }

  setConnection(state: ConnectionStatus["state"]): void {
    this.connectionStatus = {
      state,
      revision: this.connectionStatus.revision + 1,
    } as ConnectionStatus;
    for (const listener of [...this.connectionListeners]) {
      listener(this.connectionStatus);
    }
  }

  receive(message: ServerMessage): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  /** Answers the oldest read that waits, and lets its answer apply. */
  async answer(
    result: WorkspaceReadResult<OwnJoinRequestListResponse>,
  ): Promise<void> {
    const read = this.reads.shift();
    if (read === undefined) {
      throw new Error("No read waits.");
    }
    read.resolve(result);
    await settle();
  }

  openTimers(): Timer[] {
    return this.timers.filter((timer) => !timer.cancelled);
  }

  /** The waits of the open timers other than the expiry timer's. */
  retries(): number[] {
    return this.openTimers()
      .filter((timer) => timer.delayMs !== OWN_JOIN_REQUEST_EXPIRY_CHECK_MAX_MS)
      .map((timer) => timer.delayMs);
  }

  /** Fires the open timers whose wait is `delayMs`, or all of them. */
  fire(delayMs?: number): void {
    for (const timer of this.openTimers()) {
      if (delayMs === undefined || timer.delayMs === delayMs) {
        timer.cancelled = true;
        timer.callback();
      }
    }
  }

  /** The screen asks, and the read answers with `value`. */
  async loaded(
    value: OwnJoinRequestListResponse = list([item(FIRST)]),
  ): Promise<void> {
    expect(this.service.load()).toEqual({ outcome: "loading" });
    await this.answer(ok(value));
    expect(this.service.state().status).toBe("ready");
  }

  ids(): string[] {
    return this.service.state().requests.map((request) => request.id);
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

test("nothing is read until the screen asks; then the state holds the requests in the API's order with their decisions, the expired ones too, frozen", async () => {
  const h = new Harness();
  expect(h.service.state()).toEqual({
    revision: 0,
    status: "loading",
    requests: [],
  });
  expect(h.sent).toBe(0);

  expect(h.service.load()).toEqual({ outcome: "loading" });
  expect(h.sentReads).toEqual([{ name: "listOwnJoinRequests", params: {} }]);
  await h.answer(
    ok(
      list([
        item(FIRST),
        item(SECOND, {
          workspaceId: OTHER_WORKSPACE,
          requestedDisplayName: "Grace Requester",
          decision: "denied",
          decidedAt: DECIDED_AT,
        }),
        item(THIRD, {
          expiresAt: CREATED_AT,
          decision: "expired",
          decidedAt: CREATED_AT,
        }),
        item(FOURTH, { decision: "approved", decidedAt: DECIDED_AT }),
      ]),
    ),
  );

  const state = h.service.state();
  expect(state).toEqual({
    revision: 1,
    status: "ready",
    requests: [
      {
        id: FIRST,
        workspaceId: WORKSPACE,
        requestedDisplayName: "Linus Requester",
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        decision: null,
        decidedAt: null,
      },
      {
        id: SECOND,
        workspaceId: OTHER_WORKSPACE,
        requestedDisplayName: "Grace Requester",
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        decision: "denied",
        decidedAt: DECIDED_AT,
      },
      {
        id: THIRD,
        workspaceId: WORKSPACE,
        requestedDisplayName: "Linus Requester",
        createdAt: CREATED_AT,
        expiresAt: CREATED_AT,
        decision: "expired",
        decidedAt: CREATED_AT,
      },
      {
        id: FOURTH,
        workspaceId: WORKSPACE,
        requestedDisplayName: "Linus Requester",
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
        decision: "approved",
        decidedAt: DECIDED_AT,
      },
    ],
  });
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state.requests)).toBe(true);
  for (const request of state.requests) {
    expect(Object.isFrozen(request)).toBe(true);
  }
});

test("the screen's request is refused without a signed-in device, still counts, and starts no cooldown; another within the cooldown is too_soon", async () => {
  const h = new Harness(SIGNED_OUT);
  expect(h.service.state().status).toBe("signed_out");
  expect(h.service.load()).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
  expect(h.sent).toBe(0);

  // The request counts: the requests load once a device is signed in, and
  // no cooldown started.
  h.setAccount(accountStatus());
  expect(h.sent).toBe(1);
  await h.answer(ok(list([item(FIRST)])));
  expect(h.service.load()).toEqual({ outcome: "loading" });
  expect(h.sent).toBe(2);
  await h.answer(ok(list([item(FIRST)])));

  h.clock += OWN_JOIN_REQUEST_LOAD_COOLDOWN_MS - 1;
  expect(h.service.load()).toEqual({ outcome: "refused", reason: "too_soon" });
  expect(h.sent).toBe(2);
  h.clock += 1;
  expect(h.service.load()).toEqual({ outcome: "loading" });
  expect(h.sent).toBe(3);
});

test("once the screen asked, the requests load again after account.join_request_decided, a reconnect, a new sign-in, and an action", async () => {
  const h = new Harness();
  await h.loaded();
  expect(h.sent).toBe(1);

  h.receive(decided("denied"));
  expect(h.sent).toBe(2);
  await h.answer(
    ok(list([item(FIRST, { decision: "denied", decidedAt: DECIDED_AT })])),
  );
  expect(h.service.state().requests[0]?.decision).toBe("denied");

  h.receive(decided("approved"));
  expect(h.sent).toBe(3);
  await h.answer(ok(list([item(FIRST)])));

  h.setConnection("offline");
  expect(h.sent).toBe(3);
  h.setConnection("connected");
  expect(h.sent).toBe(4);
  await h.answer(ok(list([item(FIRST)])));

  expect(h.service.reload()).toBe(true);
  expect(h.sent).toBe(5);
  await h.answer(ok(list([item(FIRST)])));

  h.setAccount(accountStatus({}, OTHER_DEVICE_ID));
  expect(h.sent).toBe(6);
  await h.answer(ok(list([item(SECOND)])));
  expect(h.ids()).toEqual([SECOND]);
});

test("the decided frame is not applied to the held requests: only the reload's answer changes them", async () => {
  const h = new Harness();
  await h.loaded();
  h.receive(decided("approved"));
  expect(h.service.state().requests[0]?.decision).toBeNull();
  await h.answer(
    ok(list([item(FIRST, { decision: "approved", decidedAt: DECIDED_AT })])),
  );
  expect(h.service.state().requests[0]).toMatchObject({
    decision: "approved",
    decidedAt: DECIDED_AT,
  });
});

test("the account's own workspace.member.claimed and other frames are no trigger", async () => {
  const h = new Harness();
  await h.loaded();
  h.receive(ownClaim());
  h.receive(
    decoded({
      type: "account.device_revoked",
      deviceId: OTHER_DEVICE_ID,
      reason: "lost",
      revokedAt: DECIDED_AT,
    }),
  );
  h.receive(
    decoded({
      type: "workspace.subscribed",
      workspaceId: WORKSPACE,
      onlineMemberIds: [],
    }),
  );
  expect(h.sent).toBe(1);
});

test("only a change of the connection to connected loads: not another status, and not the same status again", async () => {
  const h = new Harness();
  await h.loaded();
  h.setConnection("connected");
  h.setConnection("authenticating");
  expect(h.sent).toBe(1);
  h.setConnection("connected");
  expect(h.sent).toBe(2);
  await h.answer(ok(list([item(FIRST)])));
  h.setConnection("connected");
  expect(h.sent).toBe(2);
});

test("before the screen asked, a frame, a reconnect, a sign-in, and reload read nothing", () => {
  const h = new Harness();
  h.receive(decided());
  h.setConnection("offline");
  h.setConnection("connected");
  h.setAccount(accountStatus({}, OTHER_DEVICE_ID));
  expect(h.service.reload()).toBe(false);
  expect(h.sent).toBe(0);
  expect(h.service.state().status).toBe("loading");
});

test("without a signed-in device, reload and the decided frame read nothing", async () => {
  const h = new Harness();
  await h.loaded();
  h.setAccount(SIGNED_OUT);
  expect(h.service.reload()).toBe(false);
  h.receive(decided());
  expect(h.sent).toBe(1);
});

test("triggers while a load is on its way merge into one more load, and the older answer is dropped", async () => {
  const h = new Harness();
  expect(h.service.load()).toEqual({ outcome: "loading" });
  h.receive(decided());
  expect(h.service.reload()).toBe(true);
  h.receive(decided());
  expect(h.sent).toBe(1);

  await h.answer(ok(list([item(FIRST)])));
  // The older answer is dropped, and exactly one more load goes.
  expect(h.service.state().status).toBe("loading");
  expect(h.ids()).toEqual([]);
  expect(h.sent).toBe(2);
  await h.answer(ok(list([item(SECOND)])));
  expect(h.ids()).toEqual([SECOND]);
  expect(h.sent).toBe(2);
});

test("a sign-out, another account, or another device drops the requests and the answers on their way", async () => {
  for (const next of [
    SIGNED_OUT,
    accountStatus({}, OTHER_DEVICE_ID),
    accountStatus({ deviceKey: "passphrase_required" }),
  ]) {
    const h = new Harness();
    await h.loaded();
    expect(h.service.reload()).toBe(true);
    expect(h.sent).toBe(2);

    h.setAccount(next);
    const dropped = h.service.state();
    expect(dropped.requests).toEqual([]);
    expect(dropped.status).toBe(
      next.account.kind === "signed_in" && next.deviceKey === "ready"
        ? "loading"
        : "signed_out",
    );
    // The answer of the earlier device is dropped.
    await h.answer(ok(list([item(FIRST)])));
    expect(h.service.state().requests).toEqual([]);
  }
});

test("while a sign-in runs, a load waits for its end, also when the status already shows the device signed in", async () => {
  const h = new Harness(SIGNED_OUT);
  expect(h.service.load()).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
  h.setAccount(accountStatus({ signIn: { kind: "completing" } }));
  expect(h.service.state().status).toBe("loading");
  expect(h.sent).toBe(0);
  h.receive(decided());
  expect(h.service.reload()).toBe(true);
  expect(h.sent).toBe(0);

  h.setAccount(accountStatus());
  expect(h.sent).toBe(1);
  await h.answer(ok(list([item(FIRST)])));
  expect(h.service.state().status).toBe("ready");
});

test("a failed load keeps what was loaded, shows its problem, and is retried with the backoff while connected; offline, the next connection loads", async () => {
  const h = new Harness();
  await h.loaded();

  expect(h.service.reload()).toBe(true);
  await h.answer(failure("unavailable"));
  expect(h.service.state()).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
  });
  expect(h.ids()).toEqual([FIRST]);
  expect(h.retries()).toEqual([WORKSPACE_RETRY_BASE_MS]);
  expect(h.logs).toContain("The own join requests did not load (unavailable).");

  h.fire(WORKSPACE_RETRY_BASE_MS);
  expect(h.sent).toBe(3);
  await h.answer(failure("failed"));
  expect(h.retries()).toEqual([WORKSPACE_RETRY_BASE_MS * 2]);

  h.fire(WORKSPACE_RETRY_BASE_MS * 2);
  await h.answer(ok(list([item(SECOND)])));
  expect(h.service.state().status).toBe("ready");
  expect(h.service.state().problem).toBeUndefined();
  expect(h.ids()).toEqual([SECOND]);
  expect(h.retries()).toEqual([]);

  // Offline, a failure schedules no retry; the next connection loads.
  h.setConnection("offline");
  expect(h.service.reload()).toBe(true);
  await h.answer(failure("unavailable"));
  expect(h.retries()).toEqual([]);
  h.setConnection("connected");
  expect(h.sent).toBe(6);
});

test("a read that rejects counts as unavailable", async () => {
  const h = new Harness();
  expect(h.service.load()).toEqual({ outcome: "loading" });
  h.reads.shift()?.reject(new Error("broken"));
  await settle();
  expect(h.service.state()).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
  });
});

test("after rate_limited, no trigger loads before the server's wait has ended; a trigger meanwhile loads at its end", async () => {
  const h = new Harness();
  await h.loaded();
  expect(h.service.reload()).toBe(true);
  await h.answer(failure("rate_limited"));
  expect(h.service.state()).toMatchObject({
    status: "unavailable",
    problem: "rate_limited",
  });
  expect(h.retries()).toEqual([RATE_LIMITED_RETRY_MS]);

  h.clock += 1_000;
  h.receive(decided());
  expect(h.service.reload()).toBe(true);
  h.setConnection("offline");
  h.setConnection("connected");
  expect(h.sent).toBe(2);
  // The retry at the end of the wait loads.
  expect(h.retries()).toEqual([RATE_LIMITED_RETRY_MS - 1_000]);
  h.clock += RATE_LIMITED_RETRY_MS - 1_000;
  h.fire();
  expect(h.sent).toBe(3);
  await h.answer(ok(list([item(FIRST)])));
  expect(h.service.state().status).toBe("ready");
});

test("a rate_limited answer of a load that a trigger overtook still makes the next load wait, and shows the problem when nothing loaded yet", async () => {
  const h = new Harness();
  expect(h.service.load()).toEqual({ outcome: "loading" });
  h.receive(decided());
  await h.answer(failure("rate_limited"));
  expect(h.sent).toBe(1);
  expect(h.service.state()).toMatchObject({
    status: "unavailable",
    problem: "rate_limited",
  });
  expect(h.retries()).toEqual([RATE_LIMITED_RETRY_MS]);
  h.clock += RATE_LIMITED_RETRY_MS;
  h.fire();
  expect(h.sent).toBe(2);
  await h.answer(ok(list([item(FIRST)])));
  expect(h.service.state().status).toBe("ready");
});

test("a pending request becomes expired, decided at its expiry, when the system clock passes it, also one that the answer holds past it; an ended request never changes", async () => {
  const h = new Harness();
  const PAST = "2026-11-06T09:59:59.999Z";
  await h.loaded(
    list([
      item(FIRST, { expiresAt: SOON }),
      item(SECOND),
      item(THIRD, {
        expiresAt: SOON,
        decision: "withdrawn",
        decidedAt: DECIDED_AT,
      }),
      // Past its expiry by this device's clock, before the API marked it.
      item(FOURTH, { expiresAt: PAST }),
    ]),
  );
  const decisions = () =>
    h.service
      .state()
      .requests.map((request) => [
        request.id,
        request.decision,
        request.decidedAt,
      ]);
  expect(decisions()).toEqual([
    [FIRST, null, null],
    [SECOND, null, null],
    [THIRD, "withdrawn", DECIDED_AT],
    [FOURTH, "expired", PAST],
  ]);
  // One timer, for the soonest expiry of a pending request.
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([SOON_MS]);

  const before = h.service.state();
  h.wall += SOON_MS;
  h.fire(SOON_MS);
  expect(decisions()).toEqual([
    [FIRST, "expired", SOON],
    [SECOND, null, null],
    [THIRD, "withdrawn", DECIDED_AT],
    [FOURTH, "expired", PAST],
  ]);
  const after = h.service.state();
  expect(after.revision).toBe(before.revision + 1);
  expect(Object.isFrozen(after.requests[0])).toBe(true);
  // The requests that did not change are the same objects.
  expect(after.requests[1]).toBe(before.requests[1]);
  expect(after.requests[2]).toBe(before.requests[2]);
  // The next expiry is six days away; the timer waits at most a day.
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([
    OWN_JOIN_REQUEST_EXPIRY_CHECK_MAX_MS,
  ]);
  h.wall += OWN_JOIN_REQUEST_EXPIRY_CHECK_MAX_MS;
  h.fire();
  expect(h.service.state().revision).toBe(after.revision);
  expect(decisions()[1]).toEqual([SECOND, null, null]);
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([
    OWN_JOIN_REQUEST_EXPIRY_CHECK_MAX_MS,
  ]);
  h.wall = Date.parse(EXPIRES_AT);
  h.fire();
  expect(decisions()[1]).toEqual([SECOND, "expired", EXPIRES_AT]);

  // Without a pending request, no timer waits.
  h.setAccount(SIGNED_OUT);
  expect(h.openTimers()).toEqual([]);
});

test("every change raises the revision once and reaches the listeners; a listener that throws is logged and the others still hear it", async () => {
  const h = new Harness();
  const heard: number[] = [];
  h.service.onChange(() => {
    throw new Error("broken");
  });
  const remove = h.service.onChange((state) => heard.push(state.revision));
  await h.loaded();
  expect(heard).toEqual([1]);
  expect(h.states.map((state) => state.revision)).toEqual([1]);
  expect(h.logs).toContain("An own join request state listener failed.");
  remove();
  h.receive(decided());
  await h.answer(ok(list([item(SECOND)])));
  expect(heard).toEqual([1]);
  expect(h.states.map((state) => state.revision)).toEqual([1, 2]);
});

test("close stops listening and cancels the timers, and later calls change nothing", async () => {
  const h = new Harness();
  await h.loaded(list([item(FIRST, { expiresAt: SOON })]));
  expect(h.service.reload()).toBe(true);
  await h.answer(failure("unavailable"));
  expect(h.openTimers()).toHaveLength(2);

  h.service.close();
  expect(h.openTimers()).toEqual([]);
  expect(h.accountListeners.size).toBe(0);
  expect(h.connectionListeners.size).toBe(0);
  expect(h.messageListeners.size).toBe(0);
  const revision = h.service.state().revision;
  expect(h.service.load()).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
  });
  expect(h.service.reload()).toBe(false);
  h.service.close();
  expect(h.service.state().revision).toBe(revision);
  expect(h.sent).toBe(2);
});

test("no log holds a name or an ID, and the service does not log with console", async () => {
  const h = new Harness();
  await h.loaded(
    list([
      item(FIRST),
      item(SECOND, { requestedDisplayName: "Grace Requester" }),
    ]),
  );
  h.receive(decided());
  await h.answer(failure("failed"));
  h.setAccount(SIGNED_OUT);
  expect(h.logs.length).toBeGreaterThan(0);
  for (const line of h.logs) {
    for (const secret of SECRETS) {
      expect(line).not.toContain(secret);
    }
  }
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "service.ts"),
    "utf8",
  );
  expect(source).not.toMatch(/console\./u);
});
