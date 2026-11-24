import {
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  PROVIDER_CONNECTION_ROUTE_ERRORS,
  PROVIDER_KINDS,
  type ProviderConnectionListResponse,
  ProviderConnectionListResponseSchema,
  type RegisterProviderConnectionResponse,
  RegisterProviderConnectionResponseSchema,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  type AccountStatus,
  type ConnectionStatus,
  PROVIDER_CONNECTION_LIMITS,
  PROVIDER_CONNECTION_STATUSES,
  PROVIDER_KIND_VIEWS,
  REGISTER_PROVIDER_CONNECTION_REFUSALS,
  REMOVE_PROVIDER_CONNECTION_REFUSALS,
  RegisterProviderConnectionResultSchema,
  RemoveProviderConnectionResultSchema,
} from "../../shared/ipc-contract.ts";
import {
  WORKSPACE_ACTION_FAILURES,
  type WorkspaceActionFailure,
  type WorkspaceActionResult,
  workspaceActionFailed,
  workspaceActionFailedFor,
  workspaceActionSent,
} from "../api-actions.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadResult,
} from "../api-reads.ts";
import {
  RATE_LIMITED_RETRY_MS,
  WORKSPACE_RETRY_BASE_MS,
} from "../workspace/service.ts";
import {
  createProviderConnectionService,
  type ProviderConnectionAccount,
  type ProviderConnectionConnection,
  providerConnectionStatus,
  type ProviderConnectionService,
  type ProviderConnectionsState,
} from "./service.ts";

// This device's AI provider connections in the main process (#32): the
// list, a status for each connection without any credential, and the
// registration and removal, one write at a time.

const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000014";
const CONNECTION_1 = "0192f0a0-7b3c-7d4e-8f50-000000000101";
const CONNECTION_2 = "0192f0a0-7b3c-7d4e-8f50-000000000102";
const AT = "2026-11-24T09:00:00.000Z";
const LOGIN = "octocat";

/** Every label of the fixtures, which no log may hold. */
const LABELS = ["Work laptop", "Personal"];

function accountStatus(
  overrides: Partial<AccountStatus> = {},
  deviceId: string = DEVICE_ID,
): AccountStatus {
  return Object.freeze({
    revision: 1,
    account: Object.freeze({
      kind: "signed_in",
      login: LOGIN,
      displayName: "The Octocat",
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

function connection(id: string, label: string, kind = "claude") {
  return { id, kind, label, createdAt: AT };
}

/** The read's answer, parsed with the protocol's schema. */
function listOf(
  ...items: ReturnType<typeof connection>[]
): ProviderConnectionListResponse {
  return ProviderConnectionListResponseSchema.parse({
    providerConnections: items,
  });
}

const ONE = listOf(connection(CONNECTION_1, "Work laptop"));
const TWO = listOf(
  connection(CONNECTION_1, "Work laptop"),
  connection(CONNECTION_2, "Personal", "codex"),
);

function ok<T>(value: T): WorkspaceReadResult<T> {
  return { ok: true, value };
}

function failure(reason: WorkspaceReadFailure): WorkspaceReadResult<never> {
  return { ok: false, reason };
}

function registeredAnswer(
  kind: string,
  label: string,
): WorkspaceActionResult<RegisterProviderConnectionResponse> {
  return {
    ok: true,
    value: RegisterProviderConnectionResponseSchema.parse({
      providerConnection: { id: CONNECTION_2, kind, label, createdAt: AT },
    }),
  };
}

interface Timer {
  readonly callback: () => void;
  readonly delayMs: number;
  cancelled: boolean;
}

interface Write {
  readonly name: string;
  readonly params: unknown;
  readonly body: unknown;
  readonly answer: (result: WorkspaceActionResult<unknown>) => void;
  readonly fail: (error: unknown) => void;
}

class Harness {
  accountStatus: AccountStatus;
  connectionStatus: ConnectionStatus;
  clock = 0;
  readonly accountListeners = new Set<(status: AccountStatus) => void>();
  readonly resumeListeners = new Set<() => void>();
  readonly connectionListeners = new Set<(status: ConnectionStatus) => void>();
  /** The reads that wait for an answer, the oldest first. */
  readonly reads: ((
    result: WorkspaceReadResult<ProviderConnectionListResponse>,
  ) => void)[] = [];
  readNames: string[] = [];
  readonly writes: Write[] = [];
  grantReads = 0;
  readonly timers: Timer[] = [];
  readonly logs: string[] = [];
  readonly states: ProviderConnectionsState[] = [];
  readonly service: ProviderConnectionService;

  constructor(
    status: AccountStatus = accountStatus(),
    state: ConnectionStatus["state"] = "connected",
  ) {
    this.accountStatus = status;
    this.connectionStatus = { state, revision: 0 } as ConnectionStatus;
    const account = {
      status: () => this.accountStatus,
      onStatusChange: (listener: (status: AccountStatus) => void) => {
        this.accountListeners.add(listener);
        return () => this.accountListeners.delete(listener);
      },
      onReadsResumed: (listener: () => void) => {
        this.resumeListeners.add(listener);
        return () => this.resumeListeners.delete(listener);
      },
      readWorkspaceData: (name: string) =>
        new Promise((resolve) => {
          this.readNames.push(name);
          this.reads.push(resolve);
        }),
      sendWorkspaceAction: (name: string, params: unknown, body?: unknown) =>
        new Promise((resolve, reject) => {
          this.writes.push({
            name,
            params,
            body,
            answer: resolve,
            fail: reject,
          });
        }),
    } as unknown as ProviderConnectionAccount;
    const client: ProviderConnectionConnection = {
      status: () => this.connectionStatus,
      onStatusChange: (listener) => {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
      },
    };
    this.service = createProviderConnectionService({
      account,
      connection: client,
      grants: {
        ownGrantAnswered: () => {
          this.grantReads += 1;
        },
      },
      now: () => this.clock,
      scheduleTimer: (callback, delayMs) => {
        const timer: Timer = { callback, delayMs, cancelled: false };
        this.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      log: (message) => this.logs.push(message),
    });
    this.service.onChange((next) => this.states.push(next));
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

  resumeReads(): void {
    for (const listener of [...this.resumeListeners]) {
      listener();
    }
  }

  /** Answers the oldest read that waits, and lets its answer apply. */
  async answer(
    result: WorkspaceReadResult<ProviderConnectionListResponse>,
  ): Promise<void> {
    const read = this.reads.shift();
    if (read === undefined) {
      throw new Error("No read waits.");
    }
    read(result);
    await settle();
  }

  async ready(value: ProviderConnectionListResponse = ONE): Promise<void> {
    await this.answer(ok(value));
    expect(this.service.state().status).toBe("ready");
  }

  openTimers(): Timer[] {
    return this.timers.filter((timer) => !timer.cancelled);
  }

  fire(): void {
    for (const timer of this.openTimers()) {
      timer.cancelled = true;
      timer.callback();
    }
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

test("the contract's provider connection values match the protocol's", () => {
  expect([...PROVIDER_KIND_VIEWS]).toEqual([...PROVIDER_KINDS]);
  expect(PROVIDER_CONNECTION_LIMITS).toEqual({
    connections: MAX_ANSWER_LIST_ITEMS,
    label: LIMITS.providerConnectionLabel,
  });
  // The closed list of statuses of this slice; #33 adds its own.
  expect([...PROVIDER_CONNECTION_STATUSES]).toEqual(["registered", "unknown"]);
});

test("the status comes from a closed list: registered while the list is current, else unknown", () => {
  expect(providerConnectionStatus({ listCurrent: true })).toBe("registered");
  expect(providerConnectionStatus({ listCurrent: false })).toBe("unknown");
});

test("a signed-in device reads its list at once, and each connection holds its ID, kind, label, time, and status only", async () => {
  const harness = new Harness();
  expect(harness.service.state()).toEqual({
    revision: 0,
    status: "loading",
    connections: [],
  });
  expect(harness.readNames).toEqual(["listProviderConnections"]);
  await harness.ready(TWO);
  const state = harness.service.state();
  expect(state).toEqual({
    revision: 1,
    status: "ready",
    connections: [
      {
        id: CONNECTION_1,
        kind: "claude",
        label: "Work laptop",
        createdAt: AT,
        status: "registered",
      },
      {
        id: CONNECTION_2,
        kind: "codex",
        label: "Personal",
        createdAt: AT,
        status: "registered",
      },
    ],
  });
  expect(Object.isFrozen(state)).toBe(true);
  expect(Object.isFrozen(state.connections)).toBe(true);
  expect(Object.isFrozen(state.connections[0])).toBe(true);
  // No device ID, user, or login reaches the state.
  const text = JSON.stringify(state);
  expect(text).not.toContain(DEVICE_ID);
  expect(text).not.toContain(LOGIN);
  expect(harness.states.at(-1)).toBe(state);
});

test("without a signed-in device nothing is read and the list is empty; a sign-in reads it, and a sign-out drops it", async () => {
  const harness = new Harness(SIGNED_OUT);
  expect(harness.service.state()).toEqual({
    revision: 0,
    status: "signed_out",
    connections: [],
  });
  expect(harness.readNames).toEqual([]);
  harness.setAccount(accountStatus());
  expect(harness.readNames).toHaveLength(1);
  await harness.ready();
  harness.setAccount(SIGNED_OUT);
  expect(harness.service.state()).toMatchObject({
    status: "signed_out",
    connections: [],
  });
  expect(harness.readNames).toHaveLength(1);
});

test("a read waits for a sign-in that runs, and another device drops the list and the answer on its way", async () => {
  const running = accountStatus({
    signIn: Object.freeze({ kind: "completing" }),
  });
  const harness = new Harness(running);
  expect(harness.readNames).toEqual([]);
  harness.setAccount(accountStatus());
  expect(harness.readNames).toHaveLength(1);
  await harness.ready(TWO);
  // Another device of another account: the list goes, and a new read goes.
  harness.setAccount(accountStatus({}, OTHER_DEVICE_ID));
  expect(harness.service.state()).toMatchObject({
    status: "loading",
    connections: [],
  });
  expect(harness.reads).toHaveLength(1);
  // An answer for the earlier device that comes late is dropped.
  harness.setAccount(accountStatus({}, DEVICE_ID));
  expect(harness.reads).toHaveLength(2);
  await harness.answer(ok(TWO));
  expect(harness.service.state().status).toBe("loading");
  await harness.answer(ok(ONE));
  expect(harness.service.state().connections).toHaveLength(1);
});

test("offline, every connection is unknown, and the next connection reads the list again", async () => {
  const harness = new Harness();
  await harness.ready();
  harness.setConnection("offline");
  expect(harness.service.state()).toMatchObject({
    status: "ready",
    connections: [{ id: CONNECTION_1, status: "unknown" }],
  });
  harness.setConnection("connected");
  expect(harness.reads).toHaveLength(1);
  await harness.ready(TWO);
  expect(
    harness.service.state().connections.map((entry) => entry.status),
  ).toEqual(["registered", "registered"]);
});

test("a connection reached while a read is on its way sends no second read, and the first answer is shown", async () => {
  // At a launch, the device is signed in before the connection is up.
  const harness = new Harness(accountStatus(), "offline");
  expect(harness.reads).toHaveLength(1);
  harness.setConnection("connected");
  expect(harness.reads).toHaveLength(1);
  await harness.ready(TWO);
  expect(harness.readNames).toHaveLength(1);
  expect(
    harness.service.state().connections.map((entry) => entry.status),
  ).toEqual(["registered", "registered"]);
});

test("a failed read keeps what was read, each connection unknown, and retries with the backoff until a read succeeds", async () => {
  const harness = new Harness();
  await harness.ready();
  harness.setConnection("offline");
  harness.setConnection("connected");
  await harness.answer(failure("unavailable"));
  expect(harness.service.state()).toEqual({
    revision: expect.any(Number) as number,
    status: "unavailable",
    problem: "unavailable",
    connections: [
      {
        id: CONNECTION_1,
        kind: "claude",
        label: "Work laptop",
        createdAt: AT,
        status: "unknown",
      },
    ],
  });
  expect(harness.openTimers().map((timer) => timer.delayMs)).toEqual([
    WORKSPACE_RETRY_BASE_MS,
  ]);
  harness.fire();
  await harness.answer(failure("failed"));
  expect(harness.openTimers().map((timer) => timer.delayMs)).toEqual([
    WORKSPACE_RETRY_BASE_MS * 2,
  ]);
  harness.fire();
  await harness.ready(TWO);
  expect(harness.service.state().problem).toBeUndefined();
  expect(harness.openTimers()).toEqual([]);
  expect(harness.logs.join("\n")).toContain("(unavailable)");
});

test("after rate_limited nothing reads until the wait ended, also when a trigger comes meanwhile", async () => {
  const harness = new Harness();
  await harness.answer(failure("rate_limited"));
  expect(harness.service.state()).toMatchObject({
    status: "unavailable",
    problem: "rate_limited",
  });
  harness.clock = 1_000;
  harness.setConnection("offline");
  harness.setConnection("connected");
  expect(harness.reads).toHaveLength(0);
  expect(harness.openTimers().map((timer) => timer.delayMs)).toEqual([
    RATE_LIMITED_RETRY_MS - 1_000,
  ]);
  harness.clock = RATE_LIMITED_RETRY_MS;
  harness.fire();
  expect(harness.reads).toHaveLength(1);
  await harness.ready();
});

test("a read that the account service held back waits for the reads to go on, without a problem", async () => {
  const harness = new Harness();
  await harness.answer({ ok: false, reason: "unavailable", heldBack: true });
  expect(harness.service.state().status).toBe("loading");
  expect(harness.openTimers()).toEqual([]);
  expect(harness.reads).toHaveLength(0);
  harness.resumeReads();
  expect(harness.reads).toHaveLength(1);
  await harness.ready();
  // Without a held-back read, a resume reads nothing.
  harness.resumeReads();
  expect(harness.reads).toHaveLength(0);
});

test("a registration sends the kind and the label only, as they are, and the list is read again", async () => {
  const harness = new Harness();
  await harness.ready();
  const pending = harness.service.register("codex", " Personal ");
  expect(harness.writes).toHaveLength(1);
  const [write] = harness.writes;
  expect(write?.name).toBe("registerProviderConnection");
  expect(write?.params).toEqual({});
  expect(write?.body).toEqual({ kind: "codex", label: " Personal " });
  expect(Object.keys(write?.body as object).sort()).toEqual(["kind", "label"]);
  write?.answer(registeredAnswer("codex", " Personal "));
  expect(RegisterProviderConnectionResultSchema.parse(await pending)).toEqual({
    outcome: "ok",
  });
  expect(harness.reads).toHaveLength(1);
  await harness.ready(TWO);
  expect(harness.service.state().connections).toHaveLength(2);
  // A registration revokes nothing.
  expect(harness.grantReads).toBe(0);
});

test("an answer with another kind or label is not the registration's: unknown", async () => {
  const harness = new Harness();
  await harness.ready();
  for (const [kind, label] of [
    ["claude", "Personal"],
    ["codex", "Other"],
  ] as const) {
    const pending = harness.service.register("codex", "Personal");
    harness.writes.at(-1)?.answer(registeredAnswer(kind, label));
    await expect(pending).resolves.toEqual({ outcome: "unknown" });
    await harness.answer(ok(ONE));
  }
});

test("a registration outside the protocol's rules, or without a signed-in device, is refused and never sent", async () => {
  const harness = new Harness();
  await harness.ready();
  for (const [kind, label] of [
    ["gemini", "Work"],
    ["claude", ""],
    ["claude", "   "],
    ["claude", "x".repeat(LIMITS.providerConnectionLabel + 1)],
    ["claude", "a\nb"],
    ["claude", "a\u202Eb"],
    ["claude", "a\u0000b"],
  ]) {
    await expect(
      harness.service.register(kind as string, label as string),
      JSON.stringify([kind, label]),
    ).resolves.toEqual({
      outcome: "refused",
      reason: "invalid",
      retryAfterMs: null,
    });
  }
  // 64 characters of four bytes each are within the limit.
  const longest = "\u{1F600}".repeat(LIMITS.providerConnectionLabel);
  const pending = harness.service.register("claude", longest);
  expect(harness.writes).toHaveLength(1);
  harness.writes[0]?.answer(registeredAnswer("claude", longest));
  await expect(pending).resolves.toEqual({ outcome: "ok" });
  await harness.answer(ok(ONE));

  harness.setAccount(SIGNED_OUT);
  await expect(harness.service.register("claude", "Work")).resolves.toEqual({
    outcome: "refused",
    reason: "not_signed_in",
    retryAfterMs: null,
  });
  await expect(harness.service.remove(CONNECTION_1)).resolves.toEqual({
    outcome: "refused",
    reason: "not_signed_in",
    retryAfterMs: null,
  });
  expect(harness.writes).toHaveLength(1);
});

test("one write at a time: a second registration or removal while the first waits is refused as busy and never sent", async () => {
  const harness = new Harness();
  await harness.ready(TWO);
  const first = harness.service.register("claude", "Work laptop");
  expect(harness.writes).toHaveLength(1);
  await expect(harness.service.register("claude", "Again")).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
    retryAfterMs: null,
  });
  await expect(harness.service.remove(CONNECTION_1)).resolves.toEqual({
    outcome: "refused",
    reason: "busy",
    retryAfterMs: null,
  });
  expect(harness.writes).toHaveLength(1);
  harness.writes[0]?.answer(registeredAnswer("claude", "Work laptop"));
  await first;
  // Once it answered, the next write goes.
  const second = harness.service.remove(CONNECTION_2);
  expect(harness.writes).toHaveLength(2);
  harness.writes[1]?.answer({ ok: true, value: null });
  await expect(second).resolves.toEqual({ outcome: "ok" });
});

test("a removal names a connection of the list held now, reads the list and the grant records again, and the server revokes its grants", async () => {
  const harness = new Harness();
  await harness.ready(TWO);
  await expect(harness.service.remove("not-an-id")).resolves.toEqual({
    outcome: "refused",
    reason: "invalid",
    retryAfterMs: null,
  });
  await expect(
    harness.service.remove(CONNECTION_1.toUpperCase()),
  ).resolves.toMatchObject({ reason: "invalid" });
  await expect(
    harness.service.remove("0192f0a0-7b3c-7d4e-8f50-000000000999"),
  ).resolves.toEqual({
    outcome: "refused",
    reason: "not_listed",
    retryAfterMs: null,
  });
  expect(harness.writes).toEqual([]);
  const pending = harness.service.remove(CONNECTION_2);
  expect(harness.writes[0]).toMatchObject({
    name: "removeProviderConnection",
    params: { providerConnectionId: CONNECTION_2 },
    body: undefined,
  });
  harness.writes[0]?.answer({ ok: true, value: null });
  expect(RemoveProviderConnectionResultSchema.parse(await pending)).toEqual({
    outcome: "ok",
  });
  expect(harness.grantReads).toBe(1);
  expect(harness.reads).toHaveLength(1);
  await harness.ready(ONE);
  expect(harness.service.state().connections.map((entry) => entry.id)).toEqual([
    CONNECTION_1,
  ]);
});

test("a write that the account service refused without a request reads nothing again; one that may have been sent or that threw reads again", async () => {
  const harness = new Harness();
  await harness.ready(TWO);
  const unsent = harness.service.remove(CONNECTION_1);
  harness.writes[0]?.answer(workspaceActionFailed("too_soon", 1_500));
  await expect(unsent).resolves.toEqual({
    outcome: "refused",
    reason: "too_soon",
    retryAfterMs: 1_500,
  });
  expect(harness.reads).toHaveLength(0);
  expect(harness.grantReads).toBe(0);

  const sent = harness.service.remove(CONNECTION_1);
  harness.writes[1]?.answer(
    workspaceActionSent(workspaceActionFailed("unavailable")),
  );
  await expect(sent).resolves.toMatchObject({ reason: "unavailable" });
  expect(harness.reads).toHaveLength(1);
  expect(harness.grantReads).toBe(1);
  await harness.answer(ok(TWO));

  const thrown = harness.service.register("claude", "Work laptop");
  harness.writes[2]?.fail(new Error("broken"));
  await expect(thrown).resolves.toEqual({ outcome: "unknown" });
  expect(harness.reads).toHaveLength(1);
  await harness.answer(ok(TWO));
  // The next write goes after a thrown one.
  void harness.service.register("claude", "Work laptop");
  expect(harness.writes).toHaveLength(4);
});

test("a removal that threw reads the grant records again exactly once, and the list again", async () => {
  const harness = new Harness();
  await harness.ready(TWO);
  const pending = harness.service.remove(CONNECTION_1);
  harness.writes[0]?.fail(new Error("broken"));
  await expect(pending).resolves.toEqual({ outcome: "unknown" });
  expect(harness.grantReads).toBe(1);
  expect(harness.reads).toHaveLength(1);
  await harness.ready(ONE);
  expect(harness.grantReads).toBe(1);
});

test("a write that may have reached the API while a read is on its way drops that stale answer and reads exactly once more", async () => {
  const harness = new Harness();
  expect(harness.reads).toHaveLength(1);
  const pending = harness.service.register("codex", "Personal");
  harness.writes[0]?.answer(registeredAnswer("codex", "Personal"));
  await expect(pending).resolves.toEqual({ outcome: "ok" });
  // The read on its way may predate the new connection.
  await harness.answer(ok(ONE));
  expect(harness.service.state()).toMatchObject({
    status: "loading",
    connections: [],
  });
  expect(harness.reads).toHaveLength(1);
  await harness.ready(TWO);
  expect(harness.service.state().connections).toHaveLength(2);
  expect(harness.readNames).toHaveLength(2);
  expect(harness.reads).toHaveLength(0);
});

test("a switch to another device while a write waits sends no extra read for the new device when the write answers", async () => {
  const harness = new Harness();
  await harness.ready(TWO);
  const pending = harness.service.remove(CONNECTION_1);
  harness.setAccount(accountStatus({}, OTHER_DEVICE_ID));
  // The new device's own read.
  expect(harness.reads).toHaveLength(1);
  harness.writes[0]?.answer({ ok: true, value: null });
  await pending;
  expect(harness.reads).toHaveLength(1);
  // Its answer counts: no read for the new device was asked for meanwhile.
  await harness.ready(ONE);
  expect(harness.service.state().connections).toHaveLength(1);
  expect(harness.reads).toHaveLength(0);
  expect(harness.readNames).toHaveLength(2);
});

test("a connection reached while a sign-in runs sends no read until the sign-in ends", async () => {
  const harness = new Harness();
  await harness.ready();
  harness.setAccount(
    accountStatus({ signIn: Object.freeze({ kind: "completing" }) }),
  );
  harness.setConnection("offline");
  harness.setConnection("connected");
  expect(harness.reads).toHaveLength(0);
  harness.setAccount(accountStatus());
  expect(harness.reads).toHaveLength(1);
  await harness.ready(TWO);
  expect(harness.readNames).toHaveLength(2);
});

test("every failure of a write maps to a fixed refusal of the contract, with a wait only for too_soon and rate_limited", async () => {
  const expectedRegister: Record<WorkspaceActionFailure, string> = {
    invalid: "invalid",
    too_soon: "too_soon",
    not_signed_in: "not_signed_in",
    unavailable: "unavailable",
    forbidden: "failed",
    not_found: "failed",
    conflict: "failed",
    already_member: "failed",
    invitation_invalid: "failed",
    join_requests_closed: "failed",
    workspace_not_found: "failed",
    device_too_new: "failed",
    unclaimed_limit: "failed",
    project_limit: "failed",
    repository_limit: "failed",
    grant_limit: "failed",
    provider_connection_limit: "provider_connection_limit",
    rate_limited: "rate_limited",
    unknown: "unknown",
    failed: "failed",
  };
  const expectedRemove: Record<WorkspaceActionFailure, string> = {
    ...expectedRegister,
    not_found: "not_found",
    conflict: "conflict",
    provider_connection_limit: "failed",
  };
  const harness = new Harness();
  await harness.ready(TWO);
  for (const reason of WORKSPACE_ACTION_FAILURES) {
    const waits = reason === "too_soon" || reason === "rate_limited";
    const result = waits
      ? workspaceActionFailed(reason, 2_000)
      : workspaceActionFailed(reason);
    for (const [call, expected, refusals, schema] of [
      [
        () => harness.service.register("claude", "Work laptop"),
        expectedRegister,
        REGISTER_PROVIDER_CONNECTION_REFUSALS,
        RegisterProviderConnectionResultSchema,
      ],
      [
        () => harness.service.remove(CONNECTION_1),
        expectedRemove,
        REMOVE_PROVIDER_CONNECTION_REFUSALS,
        RemoveProviderConnectionResultSchema,
      ],
    ] as const) {
      const pending = call();
      harness.writes.at(-1)?.answer(result);
      const answer = schema.parse(await pending);
      const outcome = expected[reason];
      expect(answer, reason).toEqual(
        outcome === "unknown"
          ? { outcome: "unknown" }
          : {
              outcome: "refused",
              reason: outcome,
              retryAfterMs: waits ? 2_000 : null,
            },
      );
      if (answer.outcome === "refused") {
        expect((refusals as readonly string[]).includes(answer.reason)).toBe(
          true,
        );
      }
    }
  }
});

test("every code of the two routes maps to its own refusal, and rate_limited carries the server's Retry-After", async () => {
  const harness = new Harness();
  await harness.ready(TWO);
  const common: Record<string, unknown> = {
    bad_request: { outcome: "refused", reason: "failed", retryAfterMs: null },
    unauthorized: {
      outcome: "refused",
      reason: "not_signed_in",
      retryAfterMs: null,
    },
    rate_limited: {
      outcome: "refused",
      reason: "rate_limited",
      retryAfterMs: 90_000,
    },
    internal_error: { outcome: "unknown" },
  };
  for (const name of [
    "registerProviderConnection",
    "removeProviderConnection",
  ] as const) {
    for (const code of PROVIDER_CONNECTION_ROUTE_ERRORS[name]) {
      const pending =
        name === "registerProviderConnection"
          ? harness.service.register("claude", "Work laptop")
          : harness.service.remove(CONNECTION_1);
      harness.writes.at(-1)?.answer(
        workspaceActionSent(
          workspaceActionFailedFor({
            ok: false,
            reason: "refused",
            code,
            retryAfterSeconds: 90,
          }),
        ),
      );
      const label = `${name} ${code}`;
      expect(await pending, label).toEqual(
        common[code] ?? {
          // `provider_connection_limit`, `not_found`, and `conflict` keep
          // their own code, without a wait.
          outcome: "refused",
          reason: code,
          retryAfterMs: null,
        },
      );
      await harness.answer(ok(TWO));
    }
  }
});

test("an answer after a sign-out reads nothing for the device that left, and nothing is published after close", async () => {
  const harness = new Harness();
  await harness.ready(TWO);
  const pending = harness.service.register("claude", "Work laptop");
  harness.setAccount(SIGNED_OUT);
  harness.writes[0]?.answer(registeredAnswer("claude", "Work laptop"));
  await pending;
  expect(harness.reads).toHaveLength(0);
  expect(harness.service.state().status).toBe("signed_out");
  harness.service.close();
  const count = harness.states.length;
  harness.setAccount(accountStatus());
  harness.setConnection("offline");
  expect(harness.states).toHaveLength(count);
  expect(harness.accountListeners.size).toBe(0);
  expect(harness.connectionListeners.size).toBe(0);
  expect(harness.resumeListeners.size).toBe(0);
  await expect(harness.service.register("claude", "Work")).resolves.toEqual({
    outcome: "refused",
    reason: "unavailable",
    retryAfterMs: null,
  });
});

test("the logs are fixed text: no label, connection ID, device ID, or login", async () => {
  const harness = new Harness();
  await harness.answer(failure("failed"));
  harness.fire();
  await harness.ready(TWO);
  const pending = harness.service.remove(CONNECTION_1);
  harness.writes[0]?.fail(new Error(`boom ${CONNECTION_1}`));
  await pending;
  await harness.answer(ok(TWO));
  expect(harness.logs.length).toBeGreaterThan(0);
  const text = harness.logs.join("\n");
  for (const value of [
    ...LABELS,
    CONNECTION_1,
    CONNECTION_2,
    DEVICE_ID,
    LOGIN,
  ]) {
    expect(text).not.toContain(value);
  }
});
