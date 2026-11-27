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
  ProviderKeyError,
  type ProviderKeyErrorCode,
} from "../provider-keys/errors.ts";
import type { ProviderKeyBinding } from "../provider-keys/key-file.ts";
import type { ClaudeModel } from "../provider-keys/models.ts";
import type { ProviderKeyCheck } from "../provider-keys/store.ts";
import {
  RATE_LIMITED_RETRY_MS,
  WORKSPACE_RETRY_BASE_MS,
} from "../workspace/service.ts";
import {
  createProviderConnectionService,
  type ProviderConnectionAccount,
  type ProviderConnectionConnection,
  type ProviderConnectionKeys,
  providerConnectionStatus,
  type ProviderConnectionService,
  type ProviderConnectionsState,
  providerKeyStateAfterFailure,
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
    keys?: ProviderConnectionKeys,
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
      ...(keys === undefined ? {} : { keys }),
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
  // The closed list of statuses (#33).
  expect([...PROVIDER_CONNECTION_STATUSES]).toEqual([
    "credential_missing",
    "model_missing",
    "ready",
    "unknown",
  ]);
});

test("the status comes from a closed list: unknown while the list is not current, else the key's state, and model_missing for a key without its model", () => {
  for (const modelMissing of [false, true]) {
    expect(
      providerConnectionStatus({
        listCurrent: true,
        key: "missing",
        modelMissing,
      }),
    ).toBe("credential_missing");
    expect(
      providerConnectionStatus({
        listCurrent: true,
        key: "unknown",
        modelMissing,
      }),
    ).toBe("unknown");
    for (const key of ["ready", "missing", "unknown"] as const) {
      expect(
        providerConnectionStatus({ listCurrent: false, key, modelMissing }),
      ).toBe("unknown");
    }
  }
  expect(
    providerConnectionStatus({
      listCurrent: true,
      key: "ready",
      modelMissing: false,
    }),
  ).toBe("ready");
  expect(
    providerConnectionStatus({
      listCurrent: true,
      key: "ready",
      modelMissing: true,
    }),
  ).toBe("model_missing");
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
        status: "credential_missing",
        model: null,
      },
      {
        id: CONNECTION_2,
        kind: "codex",
        label: "Personal",
        createdAt: AT,
        status: "credential_missing",
        model: null,
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
  ).toEqual(["credential_missing", "credential_missing"]);
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
  ).toEqual(["credential_missing", "credential_missing"]);
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
        model: null,
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

test("a rate_limited answer of a read that a write dropped is shown, and the next read goes once its wait ended", async () => {
  const harness = new Harness();
  const pending = harness.service.register("codex", "Personal");
  harness.writes[0]?.answer(registeredAnswer("codex", "Personal"));
  await pending;
  await harness.answer(failure("rate_limited"));
  expect(harness.service.state()).toMatchObject({
    status: "unavailable",
    problem: "rate_limited",
  });
  expect(harness.reads).toHaveLength(0);
  expect(harness.openTimers().map((timer) => timer.delayMs)).toEqual([
    RATE_LIMITED_RETRY_MS,
  ]);
  harness.clock = RATE_LIMITED_RETRY_MS;
  harness.fire();
  expect(harness.reads).toHaveLength(1);
  await harness.ready(TWO);
  expect(harness.service.state().problem).toBeUndefined();
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

// ---- Provider keys (#33) ---------------------------------------------------

/** An obvious fake key that no state, result, or log may hold. */
const SENTINEL_KEY = "FAKE-PROVIDER-KEY-SENTINEL-0123456789";

/** The model chosen with a Claude connection's key in these tests (#30). */
const MODEL: ClaudeModel = "claude-sonnet-5-5";

/**
 * A provider key store in memory with the binding rules of the real one:
 * each file is bound to a device and a connection, and a check of another
 * device is refused. A test can make the next call of a kind fail, or hold
 * it until it releases it.
 */
class FakeKeys implements ProviderConnectionKeys {
  /**
   * The files, with the model stored next to the key; a file set without
   * `model` holds none, as one of the format before models.
   */
  readonly files = new Map<
    string,
    { deviceId: string; key: string; model?: string | null }
  >();
  readonly calls: string[] = [];
  readonly failures: Partial<
    Record<"save" | "setModel" | "check" | "remove", ProviderKeyErrorCode>
  > = {};
  /** Calls of these kinds wait until `release` runs. */
  readonly held = new Set<"save" | "setModel" | "check" | "remove">();
  readonly waiting: (() => void)[] = [];

  private async gate(
    kind: "save" | "setModel" | "check" | "remove",
  ): Promise<void> {
    if (this.held.has(kind)) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    const code = this.failures[kind];
    if (code !== undefined) {
      throw new ProviderKeyError(code);
    }
  }

  release(): void {
    for (const resolve of this.waiting.splice(0)) {
      resolve();
    }
  }

  readonly save = async (
    binding: ProviderKeyBinding,
    key: string,
    model: ClaudeModel | null,
  ): Promise<void> => {
    this.calls.push(`save:${binding.providerConnectionId}:${String(model)}`);
    await this.gate("save");
    this.files.set(binding.providerConnectionId, {
      deviceId: binding.deviceId,
      key,
      model,
    });
  };

  readonly setModel = async (
    binding: ProviderKeyBinding,
    model: ClaudeModel,
  ): Promise<void> => {
    this.calls.push(`setModel:${binding.providerConnectionId}:${model}`);
    await this.gate("setModel");
    const file = this.files.get(binding.providerConnectionId);
    if (file === undefined) {
      throw new ProviderKeyError("missing");
    }
    if (file.deviceId !== binding.deviceId) {
      throw new ProviderKeyError("bound_elsewhere");
    }
    this.files.set(binding.providerConnectionId, { ...file, model });
  };

  readonly check = async (
    binding: ProviderKeyBinding,
  ): Promise<ProviderKeyCheck> => {
    this.calls.push(`check:${binding.providerConnectionId}`);
    await this.gate("check");
    const file = this.files.get(binding.providerConnectionId);
    if (file === undefined) {
      return { key: "missing" };
    }
    if (file.deviceId !== binding.deviceId) {
      throw new ProviderKeyError("bound_elsewhere");
    }
    return { key: "ready", model: file.model ?? null };
  };

  readonly remove = async (providerConnectionId: string): Promise<void> => {
    this.calls.push(`remove:${providerConnectionId}`);
    await this.gate("remove");
    this.files.delete(providerConnectionId);
  };
}

function statuses(harness: Harness): string[] {
  return harness.service.state().connections.map((entry) => entry.status);
}

/** Everything of the service that could reach the renderer or a log. */
function exposed(harness: Harness, ...results: unknown[]): string {
  return JSON.stringify([
    harness.service.state(),
    harness.states,
    harness.logs,
    results,
  ]);
}

test("the key state after a failed check: corrupt and bound elsewhere are missing, every other failure unknown", () => {
  expect(providerKeyStateAfterFailure(new ProviderKeyError("corrupt"))).toBe(
    "missing",
  );
  expect(
    providerKeyStateAfterFailure(new ProviderKeyError("bound_elsewhere")),
  ).toBe("missing");
  for (const code of [
    "unreadable",
    "read_failed",
    "folder_unavailable",
    "newer_format",
  ] as const) {
    expect(providerKeyStateAfterFailure(new ProviderKeyError(code))).toBe(
      "unknown",
    );
  }
  expect(providerKeyStateAfterFailure(new Error("other"))).toBe("unknown");
});

test("each listed connection is unknown until its key is checked, then credential_missing or ready; offline every one is unknown", async () => {
  const keys = new FakeKeys();
  keys.files.set(CONNECTION_2, { deviceId: DEVICE_ID, key: SENTINEL_KEY });
  keys.held.add("check");
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.answer(ok(TWO));
  expect(statuses(harness)).toEqual(["unknown", "unknown"]);
  expect(keys.calls).toEqual([
    `check:${CONNECTION_1}`,
    `check:${CONNECTION_2}`,
  ]);
  keys.held.clear();
  keys.release();
  await settle();
  expect(statuses(harness)).toEqual(["credential_missing", "ready"]);

  // Another list read checks no key again.
  harness.setConnection("offline");
  expect(statuses(harness)).toEqual(["unknown", "unknown"]);
  harness.setConnection("connected");
  await harness.ready(TWO);
  expect(statuses(harness)).toEqual(["credential_missing", "ready"]);
  expect(keys.calls).toHaveLength(2);
  expect(exposed(harness)).not.toContain(SENTINEL_KEY);
});

test("a key that cannot be checked is unknown; a damaged one or one bound to another device is credential_missing", async () => {
  const keys = new FakeKeys();
  keys.failures.check = "unreadable";
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(ONE);
  await settle();
  expect(statuses(harness)).toEqual(["unknown"]);
  expect(harness.logs).toContain(
    "A provider key could not be checked (unreadable).",
  );

  const corrupt = new FakeKeys();
  corrupt.failures.check = "corrupt";
  const second = new Harness(accountStatus(), "connected", corrupt);
  await second.ready(ONE);
  await settle();
  expect(statuses(second)).toEqual(["credential_missing"]);

  const elsewhere = new FakeKeys();
  elsewhere.files.set(CONNECTION_1, {
    deviceId: OTHER_DEVICE_ID,
    key: SENTINEL_KEY,
  });
  const third = new Harness(accountStatus(), "connected", elsewhere);
  await third.ready(ONE);
  await settle();
  expect(statuses(third)).toEqual(["credential_missing"]);
});

test("a key is stored once, bound to this device and the connection, and the connection becomes ready; removing it makes it credential_missing", async () => {
  const keys = new FakeKeys();
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(TWO);
  await settle();
  expect(statuses(harness)).toEqual([
    "credential_missing",
    "credential_missing",
  ]);

  const saved = await harness.service.saveKey(
    CONNECTION_1,
    SENTINEL_KEY,
    MODEL,
  );
  expect(saved).toEqual({ outcome: "ok" });
  expect(keys.files.get(CONNECTION_1)).toEqual({
    deviceId: DEVICE_ID,
    key: SENTINEL_KEY,
    model: MODEL,
  });
  await settle();
  expect(statuses(harness)).toEqual(["ready", "credential_missing"]);
  // Nothing was sent to the server.
  expect(harness.writes).toEqual([]);

  const removed = await harness.service.removeKey(CONNECTION_1);
  expect(removed).toEqual({ outcome: "ok" });
  await settle();
  expect(keys.files.has(CONNECTION_1)).toBe(false);
  expect(statuses(harness)).toEqual([
    "credential_missing",
    "credential_missing",
  ]);
  // Removing a key that is not there is fine.
  expect(await harness.service.removeKey(CONNECTION_2)).toEqual({
    outcome: "ok",
  });
  expect(harness.writes).toEqual([]);
  expect(exposed(harness, saved, removed)).not.toContain(SENTINEL_KEY);
});

test("a key of the wrong shape, an invalid or unlisted connection, or no signed-in device is refused before the store is asked", async () => {
  const keys = new FakeKeys();
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(ONE);
  await settle();
  keys.calls.length = 0;
  const results: unknown[] = [];
  for (const key of [
    "",
    ` ${SENTINEL_KEY}`,
    `${SENTINEL_KEY}\n`,
    `${SENTINEL_KEY}\u200b`,
    "k".repeat(513),
  ]) {
    const result = await harness.service.saveKey(CONNECTION_1, key, MODEL);
    results.push(result);
    expect(result).toEqual({
      outcome: "refused",
      reason: "invalid",
      retryAfterMs: null,
    });
  }
  for (const id of ["not-an-id", CONNECTION_1.toUpperCase()]) {
    expect(
      await harness.service.saveKey(id, SENTINEL_KEY, MODEL),
    ).toMatchObject({
      reason: "invalid",
    });
    expect(await harness.service.removeKey(id)).toMatchObject({
      reason: "invalid",
    });
  }
  expect(
    await harness.service.saveKey(CONNECTION_2, SENTINEL_KEY, null),
  ).toEqual({
    outcome: "refused",
    reason: "not_listed",
    retryAfterMs: null,
  });
  expect(await harness.service.removeKey(CONNECTION_2)).toMatchObject({
    reason: "not_listed",
  });
  harness.setAccount(SIGNED_OUT);
  expect(
    await harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL),
  ).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
    retryAfterMs: null,
  });
  expect(await harness.service.removeKey(CONNECTION_1)).toMatchObject({
    reason: "not_signed_in",
  });
  expect(keys.calls).toEqual([]);

  // Without a key store nothing can be stored.
  const bare = new Harness();
  await bare.ready(ONE);
  expect(statuses(bare)).toEqual(["credential_missing"]);
  expect(
    await bare.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL),
  ).toMatchObject({
    reason: "failed",
  });
  expect(exposed(harness, results)).not.toContain(SENTINEL_KEY);
});

test("a store that cannot protect or write the key refuses it with a fixed reason, logged by its code only", async () => {
  const keys = new FakeKeys();
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(ONE);
  await settle();
  const results: unknown[] = [];
  for (const [code, reason] of [
    ["system_protection_unavailable", "protection_unavailable"],
    ["invalid_key", "invalid"],
    ["write_failed", "failed"],
    ["folder_unavailable", "failed"],
  ] as const) {
    keys.failures.save = code;
    const result = await harness.service.saveKey(
      CONNECTION_1,
      SENTINEL_KEY,
      MODEL,
    );
    results.push(result);
    expect(result).toEqual({ outcome: "refused", reason, retryAfterMs: null });
    expect(harness.logs.at(-1)).toBe(
      `A provider key was not stored (${code}).`,
    );
  }
  keys.failures.save = undefined;
  keys.failures.remove = "delete_failed";
  expect(await harness.service.removeKey(CONNECTION_1)).toEqual({
    outcome: "refused",
    reason: "failed",
    retryAfterMs: null,
  });
  expect(harness.logs.at(-1)).toBe(
    "A provider key could not be deleted (delete_failed).",
  );
  expect(keys.files.size).toBe(0);
  expect(exposed(harness, results)).not.toContain(SENTINEL_KEY);
});

test("a key stored while the device signs out stays bound to it (D4), and is ready once the same device signs in again", async () => {
  const keys = new FakeKeys();
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(ONE);
  await settle();
  keys.held.add("save");
  const pending = harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL);
  await settle();
  harness.setAccount(SIGNED_OUT);
  keys.held.clear();
  keys.release();
  expect(await pending).toEqual({ outcome: "ok" });
  expect(keys.files.get(CONNECTION_1)).toEqual({
    deviceId: DEVICE_ID,
    key: SENTINEL_KEY,
    model: MODEL,
  });
  expect(keys.calls.filter((call) => call.startsWith("remove:"))).toEqual([]);
  expect(harness.service.state().status).toBe("signed_out");

  // The same device signs in again: the key is still there and ready.
  harness.setAccount(accountStatus());
  await harness.ready(ONE);
  await settle();
  expect(statuses(harness)).toEqual(["ready"]);
  expect(exposed(harness)).not.toContain(SENTINEL_KEY);
});

test("a key stored while another device signs in, or while the device key is deleted, is deleted again and refused", async () => {
  const ended = [
    // Another device at once.
    [accountStatus({}, OTHER_DEVICE_ID)],
    // A sign-out, then another device.
    [SIGNED_OUT, accountStatus({}, OTHER_DEVICE_ID)],
    // The device key is deleted: a revocation, a confirmed removal, a lost
    // key, and "This is not me" (no device record any more).
    [
      accountStatus({
        account: Object.freeze({ kind: "hidden" }),
        device: "revoked",
      }),
    ],
    [
      accountStatus({
        account: Object.freeze({ kind: "hidden" }),
        device: "removed",
      }),
    ],
    [
      accountStatus({
        account: Object.freeze({ kind: "hidden" }),
        device: "key_lost",
      }),
    ],
    [
      accountStatus({
        account: Object.freeze({ kind: "signed_out" }),
        device: "signed_out",
      }),
    ],
  ] as unknown as AccountStatus[][];
  for (const statusesMeanwhile of ended) {
    const keys = new FakeKeys();
    const harness = new Harness(accountStatus(), "connected", keys);
    await harness.ready(ONE);
    await settle();
    keys.held.add("save");
    const pending = harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL);
    await settle();
    for (const status of statusesMeanwhile) {
      harness.setAccount(status);
    }
    keys.held.clear();
    keys.release();
    expect(await pending).toEqual({
      outcome: "refused",
      reason: "not_signed_in",
      retryAfterMs: null,
    });
    expect(keys.files.size).toBe(0);
    expect(keys.calls).toContain(`remove:${CONNECTION_1}`);
    expect(exposed(harness)).not.toContain(SENTINEL_KEY);
  }
});

test("after the server confirmed a removal no key is stored or deleted for that connection, although the list still holds it", async () => {
  const keys = new FakeKeys();
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(TWO);
  await settle();
  const removal = harness.service.remove(CONNECTION_1);
  harness.writes.at(-1)?.answer({ ok: true, value: null });
  expect(await removal).toEqual({ outcome: "ok" });
  // The list read after the removal has not answered yet.
  expect(harness.reads).toHaveLength(1);
  expect(harness.service.state().connections.map((entry) => entry.id)).toEqual([
    CONNECTION_1,
    CONNECTION_2,
  ]);
  keys.calls.length = 0;
  const saved = await harness.service.saveKey(
    CONNECTION_1,
    SENTINEL_KEY,
    MODEL,
  );
  expect(saved).toEqual({
    outcome: "refused",
    reason: "not_listed",
    retryAfterMs: null,
  });
  expect(await harness.service.removeKey(CONNECTION_1)).toEqual({
    outcome: "refused",
    reason: "not_listed",
    retryAfterMs: null,
  });
  expect(keys.calls).toEqual([]);
  expect(keys.files.has(CONNECTION_1)).toBe(false);
  // Another connection is not affected.
  expect(
    await harness.service.saveKey(CONNECTION_2, SENTINEL_KEY, null),
  ).toEqual({
    outcome: "ok",
  });

  // The list read answers without it: still refused.
  await harness.ready(listOf(connection(CONNECTION_2, "Personal")));
  expect(
    await harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL),
  ).toEqual({
    outcome: "refused",
    reason: "not_listed",
    retryAfterMs: null,
  });
  expect(keys.files.has(CONNECTION_1)).toBe(false);
  expect(exposed(harness, saved)).not.toContain(SENTINEL_KEY);
});

test("a key action that comes while a removal waits for the server or deletes its key file is refused and never reaches the store", async () => {
  const keys = new FakeKeys();
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(TWO);
  await settle();
  keys.calls.length = 0;
  keys.held.add("remove");
  const removal = harness.service.remove(CONNECTION_1);
  // The server has not answered: busy, for this connection and any other.
  for (const id of [CONNECTION_1, CONNECTION_2]) {
    expect(await harness.service.saveKey(id, SENTINEL_KEY, MODEL)).toEqual({
      outcome: "refused",
      reason: "busy",
      retryAfterMs: null,
    });
  }
  harness.writes.at(-1)?.answer({ ok: true, value: null });
  await settle();
  // The removal's key deletion is held: a key for the removed connection
  // would be queued right behind it.
  expect(keys.calls).toEqual([`remove:${CONNECTION_1}`]);
  expect(
    await harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL),
  ).toEqual({
    outcome: "refused",
    reason: "not_listed",
    retryAfterMs: null,
  });
  expect(
    await harness.service.saveKey(CONNECTION_2, SENTINEL_KEY, null),
  ).toEqual({
    outcome: "refused",
    reason: "busy",
    retryAfterMs: null,
  });
  expect(await harness.service.removeKey(CONNECTION_2)).toEqual({
    outcome: "refused",
    reason: "busy",
    retryAfterMs: null,
  });
  keys.held.clear();
  keys.release();
  expect(await removal).toEqual({ outcome: "ok" });
  expect(keys.calls).toEqual([`remove:${CONNECTION_1}`]);
  expect(keys.files.size).toBe(0);
  // Once the removal ended, a key action for another connection goes.
  expect(
    await harness.service.saveKey(CONNECTION_2, SENTINEL_KEY, null),
  ).toEqual({
    outcome: "ok",
  });
});

test("one key action at a time, and none while a registration or a removal waits: each is refused as busy and never reaches the store", async () => {
  const keys = new FakeKeys();
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(TWO);
  await settle();
  keys.calls.length = 0;
  const busy = { outcome: "refused", reason: "busy", retryAfterMs: null };

  // A key action runs.
  keys.held.add("save");
  const first = harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL);
  await settle();
  expect(
    await harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL),
  ).toEqual(busy);
  expect(
    await harness.service.saveKey(CONNECTION_2, SENTINEL_KEY, null),
  ).toEqual(busy);
  expect(await harness.service.removeKey(CONNECTION_1)).toEqual(busy);
  expect(keys.calls).toEqual([`save:${CONNECTION_1}:${MODEL}`]);
  keys.held.clear();
  keys.release();
  expect(await first).toEqual({ outcome: "ok" });
  await settle();

  // A key deletion runs.
  keys.calls.length = 0;
  keys.held.add("remove");
  const deleting = harness.service.removeKey(CONNECTION_1);
  await settle();
  expect(
    await harness.service.saveKey(CONNECTION_2, SENTINEL_KEY, null),
  ).toEqual(busy);
  expect(await harness.service.removeKey(CONNECTION_2)).toEqual(busy);
  keys.held.clear();
  keys.release();
  expect(await deleting).toEqual({ outcome: "ok" });
  await settle();
  expect(keys.calls.filter((call) => !call.startsWith("check:"))).toEqual([
    `remove:${CONNECTION_1}`,
  ]);

  // A registration waits for the server.
  keys.calls.length = 0;
  const registration = harness.service.register("claude", "Third");
  expect(
    await harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL),
  ).toEqual(busy);
  expect(await harness.service.removeKey(CONNECTION_1)).toEqual(busy);
  harness.writes.at(-1)?.answer(registeredAnswer("claude", "Third"));
  await registration;
  expect(keys.calls).toEqual([]);

  // Once nothing runs, a key action goes.
  expect(
    await harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL),
  ).toEqual({
    outcome: "ok",
  });
  expect(keys.files.get(CONNECTION_1)?.deviceId).toBe(DEVICE_ID);
});

test("a removal deletes the key file only after the server confirmed it; a refusal, an unknown answer, or a sign-out keeps it", async () => {
  const keys = new FakeKeys();
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(TWO);
  await settle();
  await harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL);
  await harness.service.saveKey(CONNECTION_2, SENTINEL_KEY, null);
  keys.calls.length = 0;

  // Refused by the server, or not known: the key stays.
  for (const answer of [
    workspaceActionSent(workspaceActionFailed("not_found")),
    workspaceActionSent(workspaceActionFailed("conflict")),
    workspaceActionSent(workspaceActionFailed("rate_limited", 5_000)),
    workspaceActionSent(workspaceActionFailed("unavailable")),
    workspaceActionFailed("not_signed_in"),
  ]) {
    const pending = harness.service.remove(CONNECTION_1);
    harness.writes.at(-1)?.answer(answer);
    await pending;
    await harness.ready(TWO).catch(() => undefined);
    harness.reads.length = 0;
  }
  const threw = harness.service.remove(CONNECTION_1);
  harness.writes.at(-1)?.fail(new Error("network"));
  expect(await threw).toEqual({ outcome: "unknown" });
  // Every one of them reached the account service.
  expect(harness.writes).toHaveLength(6);
  expect(keys.calls.filter((call) => call.startsWith("remove:"))).toEqual([]);
  expect(keys.files.has(CONNECTION_1)).toBe(true);

  // The server confirmed: the key file is deleted before the result.
  harness.reads.length = 0;
  const confirmed = harness.service.remove(CONNECTION_1);
  expect(keys.calls.filter((call) => call.startsWith("remove:"))).toEqual([]);
  harness.writes.at(-1)?.answer({ ok: true, value: null });
  expect(await confirmed).toEqual({ outcome: "ok" });
  expect(keys.calls.filter((call) => call.startsWith("remove:"))).toEqual([
    `remove:${CONNECTION_1}`,
  ]);
  expect(keys.files.has(CONNECTION_1)).toBe(false);
  expect(keys.files.has(CONNECTION_2)).toBe(true);

  // A key file that cannot be deleted is logged, and the removal still
  // counts.
  await harness.ready(TWO).catch(() => undefined);
  harness.reads.length = 0;
  keys.failures.remove = "delete_failed";
  const failing = harness.service.remove(CONNECTION_2);
  harness.writes.at(-1)?.answer({ ok: true, value: null });
  expect(await failing).toEqual({ outcome: "ok" });
  expect(harness.logs).toContain(
    "The provider key of a removed connection could not be deleted (delete_failed).",
  );

  // A sign-out deletes nothing.
  keys.failures.remove = undefined;
  keys.calls.length = 0;
  harness.setAccount(SIGNED_OUT);
  await settle();
  expect(keys.calls).toEqual([]);
  expect(keys.files.has(CONNECTION_2)).toBe(true);
  expect(exposed(harness)).not.toContain(SENTINEL_KEY);
});

// ---- The model of a Claude connection (#30) ------------------------------

function models(harness: Harness): (string | null)[] {
  return harness.service.state().connections.map((entry) => entry.model);
}

test("a Claude connection is ready only with a model of the closed list: a key without one is model_missing, and a connection of another kind needs none", async () => {
  const keys = new FakeKeys();
  // A Claude key of the format before models, and a Codex key.
  keys.files.set(CONNECTION_1, { deviceId: DEVICE_ID, key: SENTINEL_KEY });
  keys.files.set(CONNECTION_2, { deviceId: DEVICE_ID, key: SENTINEL_KEY });
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(TWO);
  await settle();
  expect(statuses(harness)).toEqual(["model_missing", "ready"]);
  expect(models(harness)).toEqual([null, null]);

  // A model that this version no longer offers counts as none.
  keys.files.set(CONNECTION_1, {
    deviceId: DEVICE_ID,
    key: SENTINEL_KEY,
    model: "claude-opus-4-8",
  });
  // A Codex key never shows a model, whatever its file holds.
  keys.files.set(CONNECTION_2, {
    deviceId: DEVICE_ID,
    key: SENTINEL_KEY,
    model: MODEL,
  });
  const fresh = new Harness(accountStatus(), "connected", keys);
  await fresh.ready(TWO);
  await settle();
  expect(statuses(fresh)).toEqual(["model_missing", "ready"]);
  expect(models(fresh)).toEqual([null, null]);

  // Offline, the model of the last check stays and the status is unknown.
  expect(await fresh.service.setModel(CONNECTION_1, MODEL)).toEqual({
    outcome: "ok",
  });
  await settle();
  expect(statuses(fresh)).toEqual(["ready", "ready"]);
  expect(models(fresh)).toEqual([MODEL, null]);
  fresh.setConnection("offline");
  expect(statuses(fresh)).toEqual(["unknown", "unknown"]);
  expect(models(fresh)).toEqual([MODEL, null]);
  expect(exposed(harness)).not.toContain(SENTINEL_KEY);
  expect(exposed(fresh)).not.toContain(SENTINEL_KEY);
});

test("saveKey stores a Claude key only with a model of the closed list, and a key of another kind only without one; nothing else reaches the store", async () => {
  const keys = new FakeKeys();
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(TWO);
  await settle();
  keys.calls.length = 0;
  const invalidModel = {
    outcome: "refused",
    reason: "invalid_model",
    retryAfterMs: null,
  };
  const results: unknown[] = [];
  for (const model of [
    null,
    "",
    "claude-opus-4-8",
    "claude-opus-5-5-20260401",
    "Claude Opus 5.5",
    "gpt-5",
  ]) {
    const result = await harness.service.saveKey(
      CONNECTION_1,
      SENTINEL_KEY,
      model,
    );
    results.push(result);
    expect(result, String(model)).toEqual(invalidModel);
  }
  for (const model of [MODEL, "claude-opus-5-5", ""]) {
    const result = await harness.service.saveKey(
      CONNECTION_2,
      SENTINEL_KEY,
      model,
    );
    results.push(result);
    expect(result, model).toEqual(invalidModel);
  }
  expect(keys.calls).toEqual([]);
  expect(keys.files.size).toBe(0);

  for (const model of [
    "claude-fable-5-2",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ]) {
    expect(
      await harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, model),
    ).toEqual({ outcome: "ok" });
    await settle();
    expect(models(harness)).toEqual([model, null]);
    expect(statuses(harness)).toEqual(["ready", "credential_missing"]);
  }
  expect(
    await harness.service.saveKey(CONNECTION_2, SENTINEL_KEY, null),
  ).toEqual({ outcome: "ok" });
  await settle();
  expect(statuses(harness)).toEqual(["ready", "ready"]);
  expect(keys.calls.filter((call) => call.startsWith("save:"))).toEqual([
    `save:${CONNECTION_1}:claude-fable-5-2`,
    `save:${CONNECTION_1}:claude-opus-5-5`,
    `save:${CONNECTION_1}:claude-sonnet-5-5`,
    `save:${CONNECTION_1}:claude-haiku-5-5`,
    `save:${CONNECTION_2}:null`,
  ]);
  // A refusal of the store keeps its code.
  keys.failures.save = "invalid_model";
  expect(
    await harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL),
  ).toEqual(invalidModel);
  expect(exposed(harness, ...results)).not.toContain(SENTINEL_KEY);
});

test("setModel changes the model of a stored Claude key without the key, and is refused for anything else", async () => {
  const keys = new FakeKeys();
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(TWO);
  await settle();
  const refusal = (reason: string) => ({
    outcome: "refused",
    reason,
    retryAfterMs: null,
  });
  keys.calls.length = 0;

  // Before the store: an invalid ID, an unlisted connection, a Codex
  // connection, and a model outside the list.
  expect(await harness.service.setModel("nope", MODEL)).toEqual(
    refusal("invalid"),
  );
  expect(
    await harness.service.setModel(
      "0192f0a0-7b3c-7d4e-8f50-000000000199",
      MODEL,
    ),
  ).toEqual(refusal("not_listed"));
  expect(await harness.service.setModel(CONNECTION_2, MODEL)).toEqual(
    refusal("invalid_model"),
  );
  for (const model of ["", "claude-opus-4-8", "gpt-5"]) {
    expect(await harness.service.setModel(CONNECTION_1, model), model).toEqual(
      refusal("invalid_model"),
    );
  }
  expect(keys.calls).toEqual([]);

  // No key yet: the model is chosen with a key.
  expect(await harness.service.setModel(CONNECTION_1, MODEL)).toEqual(
    refusal("credential_missing"),
  );
  await settle();
  expect(statuses(harness)).toEqual([
    "credential_missing",
    "credential_missing",
  ]);

  // A key of the format before models: model_missing until one is chosen.
  keys.files.set(CONNECTION_1, { deviceId: DEVICE_ID, key: SENTINEL_KEY });
  expect(
    await harness.service.setModel(CONNECTION_1, "claude-opus-5-5"),
  ).toEqual({ outcome: "ok" });
  expect(keys.files.get(CONNECTION_1)).toEqual({
    deviceId: DEVICE_ID,
    key: SENTINEL_KEY,
    model: "claude-opus-5-5",
  });
  await settle();
  expect(statuses(harness)).toEqual(["ready", "credential_missing"]);
  expect(models(harness)).toEqual(["claude-opus-5-5", null]);
  // Nothing was sent to the server.
  expect(harness.writes).toEqual([]);

  // The store's failures.
  for (const [code, reason] of [
    ["bound_elsewhere", "credential_missing"],
    ["corrupt", "credential_missing"],
    ["missing", "credential_missing"],
    ["system_protection_unavailable", "protection_unavailable"],
    ["unreadable", "failed"],
    ["write_failed", "failed"],
  ] as const) {
    keys.failures.setModel = code;
    expect(await harness.service.setModel(CONNECTION_1, MODEL), code).toEqual(
      refusal(reason),
    );
    expect(harness.logs).toContain(
      `A provider model was not stored (${code}).`,
    );
  }
  keys.failures.setModel = undefined;
  // The model stays as it was after every refusal.
  await settle();
  expect(models(harness)).toEqual(["claude-opus-5-5", null]);

  // One key action at a time.
  keys.held.add("setModel");
  const first = harness.service.setModel(CONNECTION_1, MODEL);
  await settle();
  expect(await harness.service.setModel(CONNECTION_1, MODEL)).toEqual(
    refusal("busy"),
  );
  expect(
    await harness.service.saveKey(CONNECTION_1, SENTINEL_KEY, MODEL),
  ).toEqual(refusal("busy"));
  keys.held.clear();
  keys.release();
  expect(await first).toEqual({ outcome: "ok" });
  await settle();
  expect(models(harness)).toEqual([MODEL, null]);

  // Signed out.
  harness.setAccount(SIGNED_OUT);
  expect(await harness.service.setModel(CONNECTION_1, MODEL)).toEqual(
    refusal("not_signed_in"),
  );
  expect(exposed(harness)).not.toContain(SENTINEL_KEY);
});

test("a model stored while another device signs in is deleted with its key file again", async () => {
  const keys = new FakeKeys();
  keys.files.set(CONNECTION_1, {
    deviceId: DEVICE_ID,
    key: SENTINEL_KEY,
    model: "claude-opus-5-5",
  });
  const harness = new Harness(accountStatus(), "connected", keys);
  await harness.ready(ONE);
  await settle();
  keys.held.add("setModel");
  const pending = harness.service.setModel(CONNECTION_1, MODEL);
  await settle();
  harness.setAccount(accountStatus({}, OTHER_DEVICE_ID));
  keys.held.clear();
  keys.release();
  expect(await pending).toEqual({
    outcome: "refused",
    reason: "not_signed_in",
    retryAfterMs: null,
  });
  expect(keys.files.has(CONNECTION_1)).toBe(false);
});
