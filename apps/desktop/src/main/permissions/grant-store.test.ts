import {
  decodeServerMessage,
  GrantRecordListResponseSchema,
  type GrantRecordListResponse,
  type WorkspaceId,
} from "@mymandev/protocol";
import { type GrantRecord, GrantRecordSchema } from "@mymandev/permissions";
import { expect, test } from "vitest";
import type { AccountStatus } from "../../shared/ipc-contract.ts";
import type { WorkspaceReadResult } from "../api-reads.ts";
import type {
  ConnectionIdentity,
  ServerMessage,
} from "../connection/client.ts";
import {
  RATE_LIMITED_RETRY_MS,
  WORKSPACE_RETRY_BASE_MS,
  type WorkspaceState,
} from "../workspace/service.ts";
import {
  createGrantStore,
  type GrantStoreOptions,
  type GrantStoreService,
} from "./grant-store.ts";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OTHER_WORKSPACE = id(0xa2) as WorkspaceId;
const DEVICE = id(0xb1);
const OTHER_DEVICE = id(0xb2);
const USER = id(0xc1);
const OTHER_USER = id(0xc2);
const PROJECT = id(0xd1);
const OTHER_PROJECT = id(0xd2);
const AGENT = id(0xe1);
const OTHER_AGENT = id(0xe2);
const REPOSITORY = id(0xf1);
const GRANT = id(0x101);
const SECOND_GRANT = id(0x102);
const T0 = "2026-11-19T10:00:00.000Z";
const NOW = Date.parse("2026-11-19T12:00:00.000Z");

interface RecordOptions {
  readonly grantId?: string;
  readonly agentId?: string;
  readonly workspaceId?: string;
  readonly hostDeviceId?: string;
  readonly userId?: string;
  readonly expiresAt?: string | null;
}

/** A grant record on the repository, built through its schema. */
function record(options: RecordOptions = {}): GrantRecord {
  const agentId = options.agentId ?? AGENT;
  const hostDeviceId = options.hostDeviceId ?? DEVICE;
  const userId = options.userId ?? USER;
  const workspaceId = options.workspaceId ?? WORKSPACE;
  const projectId = workspaceId === WORKSPACE ? PROJECT : OTHER_PROJECT;
  return GrantRecordSchema.parse({
    grant: {
      id: options.grantId ?? GRANT,
      projectId,
      granteeAgentId: agentId,
      capability: "repo.read",
      repositoryId: REPOSITORY,
      grantedByUserId: userId,
      createdAt: T0,
      expiresAt: options.expiresAt ?? null,
      revokedAt: null,
      revokedByUserId: null,
    },
    facts: {
      agent: { id: agentId, hostDeviceId, disabledAt: null },
      hostDevice: { id: hostDeviceId, revokedAt: null },
      project: { id: projectId, workspaceId },
      grantorMembership: { workspaceId, userId, removedAt: null },
      providerConnection: null,
    },
  });
}

type ListResult = WorkspaceReadResult<GrantRecordListResponse>;

function list(...records: GrantRecord[]): ListResult {
  return {
    ok: true,
    value: GrantRecordListResponseSchema.parse({ records }),
  };
}

function failed(reason: "not_found" | "failed" | "rate_limited"): ListResult {
  return { ok: false, reason };
}

function frame(input: Record<string, unknown>): ServerMessage {
  const decoded = decodeServerMessage({ protocolVersion: 0, ...input });
  if (!decoded.ok || decoded.kind !== "frame") {
    throw new Error("The test frame does not decode");
  }
  return { kind: "frame", frame: decoded.frame };
}

function subscribed(workspaceId: WorkspaceId = WORKSPACE): ServerMessage {
  return frame({
    type: "workspace.subscribed",
    workspaceId,
    onlineMemberIds: [],
  });
}

let eventCount = 0;

function event(
  type: string,
  payload: Record<string, unknown>,
  workspaceId: WorkspaceId = WORKSPACE,
): ServerMessage {
  eventCount += 1;
  const decoded = decodeServerMessage({
    protocolVersion: 0,
    id: id(0x9000 + eventCount),
    occurredAt: T0,
    workspaceId,
    actor: { kind: "system" },
    deviceId: null,
    type,
    payload,
  });
  if (!decoded.ok || decoded.kind !== "event") {
    throw new Error("The test event does not decode");
  }
  return { kind: "event", event: decoded.event };
}

function grantCreated(
  agentId = AGENT,
  workspaceId: WorkspaceId = WORKSPACE,
): ServerMessage {
  return event(
    "agent.grant.created",
    {
      grant: {
        id: SECOND_GRANT,
        projectId: PROJECT,
        granteeAgentId: agentId,
        capability: "repo.read",
        repositoryId: REPOSITORY,
        createdAt: T0,
        expiresAt: null,
      },
    },
    workspaceId,
  );
}

function grantRevoked(
  agentId = AGENT,
  workspaceId: WorkspaceId = WORKSPACE,
): ServerMessage {
  return event(
    "agent.grant.revoked",
    { grantId: GRANT, granteeAgentId: agentId, revokedAt: T0 },
    workspaceId,
  );
}

function runCancelled(reason: string): ServerMessage {
  return event("agent.run.state_changed", {
    runId: id(0x201),
    agentId: OTHER_AGENT,
    previousState: "running",
    state: "cancelled",
    reason,
  });
}

const TRIGGERS: readonly (readonly [string, () => ServerMessage])[] = [
  ["agent.grant.created", () => grantCreated()],
  [
    "agent.grant.created of an agent that no record names",
    () => grantCreated(OTHER_AGENT),
  ],
  ["agent.grant.revoked of a held agent", () => grantRevoked()],
  [
    "workspace.member.removed",
    () =>
      event("workspace.member.removed", { memberId: id(0x301), removedAt: T0 }),
  ],
  [
    "a cancellation that disabled agents (member_removed)",
    () => runCancelled("member_removed"),
  ],
  [
    "a cancellation that disabled agents (device_revoked)",
    () => runCancelled("device_revoked"),
  ],
  [
    "account.device_revoked",
    () =>
      frame({
        type: "account.device_revoked",
        deviceId: OTHER_DEVICE,
        reason: "removed",
        revokedAt: T0,
      }),
  ],
  [
    "workspace.repository.removed",
    () =>
      event("workspace.repository.removed", {
        projectId: PROJECT,
        repositoryId: REPOSITORY,
      }),
  ],
];

const NOT_TRIGGERS: readonly (readonly [string, () => ServerMessage])[] = [
  [
    "agent.grant.revoked of an agent that no record names",
    () => grantRevoked(OTHER_AGENT),
  ],
  [
    "agent.grant.created of another workspace",
    () => grantCreated(AGENT, OTHER_WORKSPACE),
  ],
  [
    "workspace.member.removed of another workspace",
    () =>
      event(
        "workspace.member.removed",
        { memberId: id(0x301), removedAt: T0 },
        OTHER_WORKSPACE,
      ),
  ],
  ["a cancellation without a server code", () => runCancelled("stopped")],
  [
    "workspace.member.renamed",
    () =>
      event("workspace.member.renamed", {
        memberId: id(0x301),
        displayName: "Grace",
      }),
  ],
];

function signedIn(deviceId = DEVICE, login = "octocat"): AccountStatus {
  return {
    apiOrigin: "set",
    device: "signed_in",
    deviceKey: "ready",
    account: { kind: "signed_in", deviceId, login },
  } as unknown as AccountStatus;
}

const SIGNED_OUT = {
  apiOrigin: "set",
  device: "signed_out",
  deviceKey: "ready",
  account: { kind: "signed_out" },
} as unknown as AccountStatus;

interface Read {
  readonly name: string;
  readonly params: unknown;
  readonly resolve: (result: ListResult) => void;
}

function setup() {
  let status = signedIn();
  let connectionState = "connected";
  let identity: ConnectionIdentity | null = {
    userId: USER,
    deviceId: DEVICE,
  } as ConnectionIdentity;
  let workspaceStatus: WorkspaceState["status"] = "ready";
  let selected: WorkspaceId | null = WORKSPACE;
  let wallClock = NOW;
  const reads: Read[] = [];
  const timers: { delayMs: number; callback: () => void; active: boolean }[] =
    [];
  const accountListeners = new Set<(status: AccountStatus) => void>();
  const statusListeners = new Set<(status: { state: string }) => void>();
  const messageListeners = new Set<(message: ServerMessage) => void>();
  const workspaceListeners = new Set<() => void>();
  const logs: string[] = [];
  let signals = 0;

  function listen<T>(set: Set<T>, listener: T): () => void {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  const options: GrantStoreOptions = {
    account: {
      status: () => status,
      onStatusChange: (listener) => listen(accountListeners, listener),
      readWorkspaceData: ((name: string, params: unknown) =>
        new Promise<ListResult>((resolve) => {
          reads.push({ name, params, resolve });
        })) as unknown as GrantStoreOptions["account"]["readWorkspaceData"],
    },
    connection: {
      status: () => ({ state: connectionState }) as never,
      onStatusChange: (listener) =>
        listen(
          statusListeners,
          listener as (status: { state: string }) => void,
        ),
      onMessage: (listener) => listen(messageListeners, listener),
      identity: () => identity,
    },
    workspaces: {
      state: () =>
        ({
          revision: 0,
          status: workspaceStatus,
          workspaces: [],
          selectedWorkspaceId: selected,
          projects: [],
          openProjectId: null,
        }) as WorkspaceState,
      onChange: (listener) =>
        listen(workspaceListeners, listener as unknown as () => void),
    },
    scheduleTimer: (callback, delayMs) => {
      const timer = { delayMs, callback, active: true };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
    wallClock: () => wallClock,
    log: (message) => logs.push(message),
  };
  const store: GrantStoreService = createGrantStore(options);
  store.onGrantsChanged(() => {
    signals += 1;
  });

  return {
    store,
    reads,
    logs,
    signals: () => signals,
    listeners: () =>
      accountListeners.size +
      statusListeners.size +
      messageListeners.size +
      workspaceListeners.size,
    pending: () =>
      timers.filter((timer) => timer.active).map((timer) => timer.delayMs),
    fire() {
      for (const timer of timers.filter((entry) => entry.active)) {
        timer.active = false;
        timer.callback();
      }
    },
    setClock(ms: number) {
      wallClock = ms;
    },
    setAccount(next: AccountStatus) {
      status = next;
      for (const listener of [...accountListeners]) {
        listener(next);
      }
    },
    setConnection(state: string) {
      connectionState = state;
      if (state !== "connected") {
        identity = null;
      }
      for (const listener of [...statusListeners]) {
        listener({ state });
      }
    },
    setIdentity(next: ConnectionIdentity | null) {
      identity = next;
    },
    setWorkspaces(next: {
      status?: WorkspaceState["status"];
      selected?: WorkspaceId | null;
    }) {
      workspaceStatus = next.status ?? workspaceStatus;
      selected = next.selected === undefined ? selected : next.selected;
      for (const listener of [...workspaceListeners]) {
        listener();
      }
    },
    receive(message: ServerMessage) {
      for (const listener of [...messageListeners]) {
        listener(message);
      }
    },
    /** Answers the read at `index` and lets its promise settle. */
    async answer(index: number, result: ListResult) {
      reads[index]!.resolve(result);
      await settle();
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A store that read `records` after `workspace.subscribed`. */
async function live(...records: GrantRecord[]) {
  const h = setup();
  h.receive(subscribed());
  await h.answer(0, list(...(records.length === 0 ? [record()] : records)));
  expect(h.store.read().usable).toBe(true);
  return h;
}

test("usable only after a read sent since the last workspace.subscribed", async () => {
  const h = setup();
  expect(h.store.read()).toEqual({ usable: false, records: [] });
  expect(h.reads).toHaveLength(0);
  // Another workspace's subscription neither reads nor makes it usable.
  h.receive(subscribed(OTHER_WORKSPACE));
  expect(h.reads).toHaveLength(0);

  h.receive(subscribed());
  expect(h.reads.map((read) => [read.name, read.params])).toEqual([
    ["listGrantRecords", {}],
  ]);
  expect(h.store.read().usable).toBe(false);
  await h.answer(0, list(record()));
  expect(h.store.read()).toEqual({ usable: true, records: [record()] });

  // A fresh `workspace.subscribed` makes it unusable at once, and the answer
  // of a read sent before it never counts.
  h.receive(grantCreated());
  expect(h.reads).toHaveLength(2);
  h.receive(subscribed());
  expect(h.store.read().usable).toBe(false);
  expect(h.reads).toHaveLength(3);
  await h.answer(1, list(record()));
  expect(h.store.read().usable).toBe(false);
  expect(h.reads).toHaveLength(3);
  await h.answer(2, list(record()));
  expect(h.store.read().usable).toBe(true);
});

test("a store created while connected waits for the next workspace.subscribed", () => {
  const h = setup();
  h.receive(grantCreated());
  h.receive(
    event("workspace.member.removed", { memberId: id(1), removedAt: T0 }),
  );
  expect(h.reads).toHaveLength(0);
  expect(h.store.read().usable).toBe(false);
});

const DROPS: readonly (readonly [
  string,
  (h: ReturnType<typeof setup>) => void,
])[] = [
  ["the connection is lost", (h) => h.setConnection("waiting")],
  ["the connection is closed", (h) => h.setConnection("offline")],
  ["a sign-out", (h) => h.setAccount(SIGNED_OUT)],
  ["another device", (h) => h.setAccount(signedIn(OTHER_DEVICE))],
  ["another account", (h) => h.setAccount(signedIn(DEVICE, "hubot"))],
  [
    "the workspace service signs out",
    (h) => h.setWorkspaces({ status: "signed_out" }),
  ],
  [
    "another selected workspace",
    (h) => h.setWorkspaces({ selected: OTHER_WORKSPACE }),
  ],
  ["no selected workspace", (h) => h.setWorkspaces({ selected: null })],
  [
    "workspace.unsubscribed",
    (h) =>
      h.receive(
        frame({
          type: "workspace.unsubscribed",
          workspaceId: WORKSPACE,
          reason: "membership_ended",
        }),
      ),
  ],
  [
    "workspace.subscribe_refused",
    (h) =>
      h.receive(
        frame({
          type: "workspace.subscribe_refused",
          workspaceId: WORKSPACE,
          code: "not_found",
        }),
      ),
  ],
];

test("each drop makes the store unusable at once and drops the answer on its way", async () => {
  for (const [name, drop] of DROPS) {
    const h = await live();
    h.receive(grantCreated());
    const before = h.signals();
    drop(h);
    expect(h.store.read(), name).toEqual({ usable: false, records: [] });
    expect(h.signals(), name).toBe(before + 1);
    // The read that was on its way does not make it usable again.
    await h.answer(1, list(record()));
    expect(h.store.read().usable, name).toBe(false);
  }
});

test("a failed read, also of a route that the server lacks, makes it unusable at once", async () => {
  for (const reason of ["not_found", "failed", "rate_limited"] as const) {
    const h = await live();
    h.receive(grantCreated());
    expect(h.store.read().usable).toBe(true);
    await h.answer(1, failed(reason));
    expect(h.store.read().usable, reason).toBe(false);
    expect(h.signals(), reason).toBe(2);
    expect(h.logs, reason).toEqual([
      `The grant records did not load (${reason}).`,
    ]);
  }
  // A first read that fails leaves it unusable.
  const h = setup();
  h.receive(subscribed());
  await h.answer(0, failed("not_found"));
  expect(h.store.read().usable).toBe(false);
});

test("a refused list makes it unusable: another device, another account, or another connection", async () => {
  const refused: readonly (readonly [
    string,
    ListResult,
    (h: ReturnType<typeof setup>) => void,
  ])[] = [
    [
      "another host device",
      list(record({ hostDeviceId: OTHER_DEVICE })),
      () => undefined,
    ],
    ["another account", list(record({ userId: OTHER_USER })), () => undefined],
    ["a list that the schema refused", failed("failed"), () => undefined],
    [
      "another identity of the connection",
      list(record()),
      (h) =>
        h.setIdentity({
          userId: OTHER_USER,
          deviceId: DEVICE,
        } as ConnectionIdentity),
    ],
    [
      "an answer that names the connection's new account, not the one it was sent for",
      list(record({ userId: OTHER_USER })),
      (h) =>
        h.setIdentity({
          userId: OTHER_USER,
          deviceId: DEVICE,
        } as ConnectionIdentity),
    ],
    [
      "a connection identity of another device",
      list(record()),
      (h) => {
        h.setIdentity({
          userId: USER,
          deviceId: OTHER_DEVICE,
        } as ConnectionIdentity);
      },
    ],
  ];
  for (const [name, answer, change] of refused) {
    const h = await live();
    h.receive(grantCreated());
    change(h);
    await h.answer(1, answer);
    expect(h.store.read(), name).toEqual({ usable: false, records: [] });
    expect(h.pending(), name).toEqual([WORKSPACE_RETRY_BASE_MS]);
  }
});

test("each trigger reads again, and other messages do not", async () => {
  for (const [name, message] of TRIGGERS) {
    const h = await live();
    h.receive(message());
    expect(
      h.reads.map((read) => read.name),
      name,
    ).toEqual(["listGrantRecords", "listGrantRecords"]);
  }
  for (const [name, message] of NOT_TRIGGERS) {
    const h = await live();
    h.receive(message());
    expect(h.reads, name).toHaveLength(1);
  }
});

test("a revocation of an agent that no record names reads while a read is on its way", async () => {
  const h = await live();
  h.receive(grantCreated(OTHER_AGENT));
  expect(h.reads).toHaveLength(2);
  // The answer on its way may hold the revoked grant.
  h.receive(grantRevoked(OTHER_AGENT));
  await h.answer(
    1,
    list(record(), record({ grantId: SECOND_GRANT, agentId: OTHER_AGENT })),
  );
  expect(h.reads).toHaveLength(3);
  await h.answer(2, list(record()));
  expect(h.store.read().records).toEqual([record()]);
});

test("reads merge: triggers during a read drop its answer and read once more", async () => {
  const h = await live();
  h.receive(grantCreated());
  h.receive(grantRevoked());
  h.receive(grantCreated());
  h.receive(runCancelled("member_removed"));
  expect(h.reads).toHaveLength(2);
  await h.answer(1, list());
  // The answer was dropped: the records of the first answer stay.
  expect(h.store.read().records).toEqual([record()]);
  expect(h.reads).toHaveLength(3);
  await h.answer(2, list());
  expect(h.store.read()).toEqual({ usable: true, records: [] });
  expect(h.reads).toHaveLength(3);
});

test("a failed read is retried with the backoff while connected, and triggers wait for it", async () => {
  const h = await live();
  h.receive(grantCreated());
  await h.answer(1, failed("not_found"));
  expect(h.pending()).toEqual([WORKSPACE_RETRY_BASE_MS]);
  // Triggers during the wait do not read; the retry does.
  h.receive(grantCreated());
  h.receive(grantRevoked());
  expect(h.reads).toHaveLength(2);
  h.fire();
  expect(h.reads).toHaveLength(3);
  await h.answer(2, failed("failed"));
  expect(h.pending()).toEqual([WORKSPACE_RETRY_BASE_MS * 2]);
  h.fire();
  await h.answer(3, failed("rate_limited"));
  expect(h.pending()).toEqual([RATE_LIMITED_RETRY_MS]);
  h.fire();
  await h.answer(4, list(record()));
  expect(h.store.read().usable).toBe(true);
  // The backoff starts again after a success.
  h.receive(grantCreated());
  await h.answer(5, failed("failed"));
  expect(h.pending()).toEqual([WORKSPACE_RETRY_BASE_MS]);

  // `rate_limited` with a trigger on its way waits out the backoff.
  h.fire();
  h.receive(grantCreated());
  await h.answer(6, failed("rate_limited"));
  expect(h.reads).toHaveLength(7);
  expect(h.pending()).toEqual([RATE_LIMITED_RETRY_MS]);

  // Offline, nothing is retried; the next `workspace.subscribed` reads.
  h.setConnection("waiting");
  expect(h.pending()).toEqual([]);
  h.setConnection("connected");
  h.setIdentity({ userId: USER, deviceId: DEVICE } as ConnectionIdentity);
  h.receive(grantCreated());
  expect(h.reads).toHaveLength(7);
  h.receive(subscribed());
  expect(h.reads).toHaveLength(8);
});

test("read() gives one snapshot of one answer, frozen, until the next answer", async () => {
  const other = record({ grantId: SECOND_GRANT, agentId: OTHER_AGENT });
  const h = await live(record(), other);
  const first = h.store.read();
  expect(h.store.read()).toBe(first);
  expect(first.records).toEqual([record(), other]);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.records)).toBe(true);
  for (const entry of first.records) {
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.grant)).toBe(true);
    expect(Object.isFrozen(entry.facts)).toBe(true);
    expect(Object.isFrozen(entry.facts.agent)).toBe(true);
    expect(Object.isFrozen(entry.facts.grantorMembership)).toBe(true);
  }

  h.receive(grantRevoked());
  await h.answer(1, list(other));
  const second = h.store.read();
  expect(second.records).toEqual([other]);
  // The earlier snapshot is unchanged: answers are never merged.
  expect(first.records).toEqual([record(), other]);
});

test("only the selected workspace's records are kept", async () => {
  const elsewhere = record({
    grantId: SECOND_GRANT,
    workspaceId: OTHER_WORKSPACE,
  });
  const h = await live(record(), elsewhere);
  expect(h.store.read().records).toEqual([record()]);
});

test("an event never builds or removes a record; only the read's answer does", async () => {
  const h = await live();
  const before = h.store.read();
  h.receive(grantCreated(OTHER_AGENT));
  h.receive(grantRevoked());
  expect(h.store.read()).toBe(before);
  expect(h.signals()).toBe(1);
  await h.answer(1, list());
  // The second trigger came during the read, so its answer was dropped.
  expect(h.store.read()).toBe(before);
  await h.answer(2, list());
  expect(h.store.read().records).toEqual([]);
});

test("the change signal follows changed records, unusable states, and expiries", async () => {
  const h = setup();
  h.receive(subscribed());
  expect(h.signals()).toBe(0);
  await h.answer(0, list(record()));
  expect(h.signals()).toBe(1);
  // The same records again: no signal, and the same snapshot.
  const before = h.store.read();
  h.receive(grantCreated());
  await h.answer(1, list(record()));
  expect(h.signals()).toBe(1);
  expect(h.store.read()).toBe(before);
  // Other records: a signal.
  h.receive(grantCreated());
  await h.answer(2, list(record(), record({ grantId: SECOND_GRANT })));
  expect(h.signals()).toBe(2);
  // Unusable: a signal, once.
  h.setConnection("waiting");
  h.setConnection("offline");
  expect(h.signals()).toBe(3);

  // A held grant that expires signals at its `expiresAt`, in steps for a
  // long wait, and the next expiry is scheduled after it.
  const soon = new Date(NOW + 60_000).toISOString();
  const late = new Date(NOW + 30 * 86_400_000).toISOString();
  const e = setup();
  e.receive(subscribed());
  await e.answer(
    0,
    list(
      record({ expiresAt: soon }),
      record({ grantId: SECOND_GRANT, expiresAt: late }),
    ),
  );
  expect(e.pending()).toEqual([60_000]);
  e.setClock(NOW + 60_000);
  e.fire();
  expect(e.signals()).toBe(2);
  expect(e.pending()).toEqual([2 ** 31 - 1]);
  // A step of the long wait signals nothing.
  e.setClock(NOW + 60_000 + 2 ** 31 - 1);
  e.fire();
  expect(e.signals()).toBe(2);
  expect(e.pending()).toHaveLength(1);
  e.setClock(Date.parse(late));
  e.fire();
  expect(e.signals()).toBe(3);
  expect(e.pending()).toEqual([]);
  // Unusable cancels the expiry timer.
  e.receive(grantCreated());
  await e.answer(1, list(record({ expiresAt: late })));
  expect(e.pending()).toHaveLength(0);
  e.setClock(NOW);
  e.receive(grantCreated());
  await e.answer(2, list(record({ expiresAt: soon })));
  expect(e.pending()).toEqual([60_000]);
  e.setConnection("waiting");
  expect(e.pending()).toEqual([]);
});

test("a listener that throws is logged, and a removed listener is not called", async () => {
  const h = setup();
  let calls = 0;
  h.store.onGrantsChanged(() => {
    throw new Error(`failed ${GRANT}`);
  });
  const remove = h.store.onGrantsChanged(() => {
    calls += 1;
  });
  h.receive(subscribed());
  await h.answer(0, list(record()));
  expect(h.signals()).toBe(1);
  expect(calls).toBe(1);
  expect(h.logs).toEqual(["A grant change listener failed."]);
  remove();
  h.setConnection("waiting");
  expect(calls).toBe(1);
  expect(h.signals()).toBe(2);
});

test("close stops listening, cancels the timers, signals once, and stays unusable", async () => {
  const h = await live(
    record({ expiresAt: new Date(NOW + 60_000).toISOString() }),
  );
  h.receive(grantCreated());
  expect(h.listeners()).toBe(4);
  expect(h.pending()).toEqual([60_000]);
  h.store.close();
  h.store.close();
  expect(h.listeners()).toBe(0);
  expect(h.pending()).toEqual([]);
  expect(h.signals()).toBe(2);
  expect(h.store.read()).toEqual({ usable: false, records: [] });
  await h.answer(1, list(record()));
  expect(h.store.read().usable).toBe(false);
  expect(h.reads).toHaveLength(2);

  // A failed read's retry is cancelled as well.
  const r = await live();
  r.receive(grantCreated());
  await r.answer(1, failed("failed"));
  expect(r.pending()).toEqual([WORKSPACE_RETRY_BASE_MS]);
  r.store.close();
  expect(r.pending()).toEqual([]);
});
