import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChatHistoryResponseSchema,
  decodeClientMessage,
  decodeServerMessage,
  LIMITS,
  type ChatMessageSendEvent,
  type DeviceId,
  type EventId,
  type MemberId,
  type ProjectId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import type {
  AccountStatus,
  ConnectionStatus,
} from "../../shared/ipc-contract.ts";
import type {
  WorkspaceReadFailure,
  WorkspaceReadName,
  WorkspaceReadResult,
} from "../api-reads.ts";
import type {
  ConnectionIdentity,
  SendOutcome,
  ServerMessage,
} from "../connection/client.ts";
import { MAX_BUFFERED_EVENTS } from "../workspace/resync.ts";
import {
  RATE_LIMITED_RETRY_MS,
  UNKNOWN_MEMBER_NAME,
  WORKSPACE_RETRY_BASE_MS,
  type WorkspaceState,
} from "../workspace/service.ts";
import {
  CHAT_RATE_LIMITED_RETRY_MS,
  CHAT_RATE_LIMITED_RETRIES,
  CHAT_RESEND_INTERVAL_MS,
  createChatService,
  UNKNOWN_AGENT_NAME,
  type ChatAccount,
  type ChatConnection,
  type ChatService,
  type ChatState,
  type ChatWorkspaces,
} from "./service.ts";
import { MAX_PENDING_CHAT_MESSAGES } from "./timeline.ts";

const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004" as DeviceId;
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000014" as DeviceId;
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009" as UserId;
const OTHER_USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000019" as UserId;
const WS_A = "0192f0a0-7b3c-7d4e-8f50-0000000000a1" as WorkspaceId;
const WS_B = "0192f0a0-7b3c-7d4e-8f50-0000000000a2" as WorkspaceId;
const MEMBER = "0192f0a0-7b3c-7d4e-8f50-0000000000c2" as MemberId;
const PROJECT_1 = "0192f0a0-7b3c-7d4e-8f50-0000000000e1" as ProjectId;
const PROJECT_2 = "0192f0a0-7b3c-7d4e-8f50-0000000000e2" as ProjectId;
const PROJECT_B = "0192f0a0-7b3c-7d4e-8f50-0000000000e5" as ProjectId;
const UNKNOWN_PROJECT = "0192f0a0-7b3c-7d4e-8f50-0000000000e9" as ProjectId;
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000f1";
const AT = "2026-11-05T10:00:00.000Z";
/** The wall clock of the harness. */
const WALL_CLOCK = Date.parse("2026-11-05T12:00:00.000Z");

const IDENTITY: ConnectionIdentity = Object.freeze({
  userId: USER_ID,
  deviceId: DEVICE_ID,
});

/** Every name and body that the fixtures use, which no log may hold. */
const SECRETS = [
  "Grace Member",
  "Workspace Alpha",
  "Project One",
  "Message body",
  "Hello from the composer",
  "octocat",
  "Agent Smith",
];

function accountStatus(deviceId: string = DEVICE_ID): AccountStatus {
  return Object.freeze({
    revision: 1,
    account: Object.freeze({
      kind: "signed_in",
      login: "octocat",
      displayName: "The Octocat",
      deviceId,
    }),
    signIn: Object.freeze({ kind: "idle" }),
    lastOutcome: null,
    deviceKey: "ready",
    replacementPending: false,
    apiOrigin: "set",
    device: "signed_in",
  }) as AccountStatus;
}

const SIGNED_OUT = Object.freeze({
  ...accountStatus(),
  account: Object.freeze({ kind: "signed_out" }),
  device: "signed_out",
}) as AccountStatus;

function hex(n: number): string {
  return n.toString(16).padStart(12, "0");
}

function message(
  seq: number,
  options: {
    readonly projectId?: ProjectId;
    readonly agent?: boolean;
  } = {},
) {
  return {
    id: `0192f0b0-7b3c-7d4e-8f50-${hex(seq)}`,
    projectId: options.projectId ?? PROJECT_1,
    seq,
    author:
      options.agent === true
        ? { kind: "agent", agentId: AGENT_ID }
        : { kind: "member", memberId: MEMBER },
    body: `Message body ${seq}`,
    createdAt: AT,
  };
}

/** A history page of `seqs`, the newest first, through the protocol's schema. */
function page(seqs: readonly number[], projectId: ProjectId = PROJECT_1) {
  return ChatHistoryResponseSchema.parse({
    messages: [...seqs]
      .sort((a, b) => b - a)
      .map((seq) => message(seq, { projectId })),
  });
}

/** Seqs `from` to `to`, both included. */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function ok<T>(value: T): WorkspaceReadResult<T> {
  return { ok: true, value };
}

function failure(reason: WorkspaceReadFailure): WorkspaceReadResult<never> {
  return { ok: false, reason };
}

/** A server frame, decoded as the connection client receives it. */
function frame(input: Record<string, unknown>): ServerMessage {
  const decoded = decodeServerMessage({ protocolVersion: 0, ...input });
  if (!decoded.ok || decoded.kind !== "frame") {
    throw new Error("The test frame does not decode");
  }
  return { kind: "frame", frame: decoded.frame };
}

let eventCount = 0;

/** `chat.message.created`, decoded as the connection client receives it. */
function created(
  seq: number,
  options: {
    readonly causationId?: EventId;
    readonly projectId?: ProjectId;
    readonly workspaceId?: WorkspaceId;
  } = {},
): ServerMessage {
  eventCount += 1;
  const decoded = decodeServerMessage({
    protocolVersion: 0,
    id: `0192f0c0-7b3c-7d4e-8f50-${hex(eventCount)}`,
    occurredAt: AT,
    workspaceId: options.workspaceId ?? WS_A,
    actor: { kind: "system" },
    deviceId: null,
    ...(options.causationId === undefined
      ? {}
      : { causationId: options.causationId }),
    type: "chat.message.created",
    payload: { message: message(seq, { projectId: options.projectId }) },
  });
  if (!decoded.ok || decoded.kind !== "event") {
    throw new Error("The test event does not decode");
  }
  return { kind: "event", event: decoded.event };
}

function subscribed(workspaceId: WorkspaceId = WS_A): ServerMessage {
  return frame({
    type: "workspace.subscribed",
    workspaceId,
    onlineMemberIds: [],
  });
}

function refusedFrame(
  eventId: EventId,
  code: "not_found" | "conflict" | "rate_limited",
): ServerMessage {
  return frame({ type: "event.refused", eventId, code });
}

interface Read {
  readonly name: WorkspaceReadName;
  readonly params: unknown;
  readonly query: unknown;
  readonly answer: (result: WorkspaceReadResult<unknown>) => void;
}

interface Timer {
  readonly callback: () => void;
  readonly dueAt: number;
  readonly delayMs: number;
  cancelled: boolean;
}

const PROJECTS_OF: Readonly<Record<string, readonly ProjectId[]>> = {
  [WS_A]: [PROJECT_1, PROJECT_2],
  [WS_B]: [PROJECT_B],
};

/**
 * A fake workspace service: the selection, the open project, and
 * `gateLive`, which the test sets as the real service would.
 */
class FakeWorkspaces implements ChatWorkspaces {
  current: WorkspaceState = this.build(null, null);
  readonly live = new Set<WorkspaceId>();
  readonly listeners = new Set<(state: WorkspaceState) => void>();
  readonly calls: string[] = [];

  build(
    selected: WorkspaceId | null,
    openProjectId: ProjectId | null,
  ): WorkspaceState {
    return Object.freeze({
      revision: (this.current?.revision ?? -1) + 1,
      status: "ready",
      workspaces: Object.freeze([
        Object.freeze({ id: WS_A, name: "Workspace Alpha" }),
        Object.freeze({ id: WS_B, name: "Workspace Beta" }),
      ]),
      selectedWorkspaceId: selected,
      projects: Object.freeze(
        (selected === null ? [] : (PROJECTS_OF[selected] ?? [])).map((id) =>
          Object.freeze({ id, name: "Project One", createdByMemberId: MEMBER }),
        ),
      ),
      openProjectId,
    });
  }

  change(selected: WorkspaceId | null, openProjectId: ProjectId | null): void {
    if (selected !== this.current.selectedWorkspaceId) {
      this.live.clear();
    }
    this.current = this.build(selected, openProjectId);
    this.notify();
  }

  setLive(workspaceId: WorkspaceId, live: boolean): void {
    if (live) {
      this.live.add(workspaceId);
    } else {
      this.live.delete(workspaceId);
    }
    this.current = this.build(
      this.current.selectedWorkspaceId,
      this.current.openProjectId,
    );
    this.notify();
  }

  notify(): void {
    for (const listener of [...this.listeners]) {
      listener(this.current);
    }
  }

  state = (): WorkspaceState => this.current;

  onChange = (listener: (state: WorkspaceState) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  select = (workspaceId: WorkspaceId): boolean => {
    this.calls.push(`select ${workspaceId}`);
    if (!this.current.workspaces.some((held) => held.id === workspaceId)) {
      return false;
    }
    if (workspaceId !== this.current.selectedWorkspaceId) {
      this.change(workspaceId, null);
    }
    return true;
  };

  openProject = (projectId: ProjectId | null): boolean => {
    this.calls.push(`open ${projectId}`);
    if (
      projectId !== null &&
      !this.current.projects.some((held) => held.id === projectId)
    ) {
      return false;
    }
    if (projectId !== this.current.openProjectId) {
      this.change(this.current.selectedWorkspaceId, projectId);
    }
    return true;
  };

  selectedWorkspaceId = (): WorkspaceId | null =>
    this.current.selectedWorkspaceId;

  gateLive = (workspaceId: WorkspaceId): boolean =>
    workspaceId === this.current.selectedWorkspaceId &&
    this.live.has(workspaceId);

  memberName = (memberId: MemberId): string =>
    memberId === MEMBER ? "Grace Member" : UNKNOWN_MEMBER_NAME;
}

class Harness {
  accountStatus: AccountStatus;
  connectionStatus: ConnectionStatus = { state: "offline", revision: 0 };
  /** The identity of the fake socket's `auth.ok`, while connected. */
  socketIdentity: ConnectionIdentity | null = null;
  /** When set, `sendAs` answers it after building the event. */
  forcedOutcome: SendOutcome | null = null;
  readonly accountListeners = new Set<(status: AccountStatus) => void>();
  readonly connectionListeners = new Set<(status: ConnectionStatus) => void>();
  readonly messageListeners = new Set<(message: ServerMessage) => void>();
  readonly workspaces = new FakeWorkspaces();
  /** The events that went out, as `decodeClientMessage` decoded them. */
  readonly sent: ChatMessageSendEvent[] = [];
  /** The identities that `sendAs` passed to `build`. */
  readonly built: ConnectionIdentity[] = [];
  reads: Read[] = [];
  clock = 0;
  readonly timers: Timer[] = [];
  readonly logs: string[] = [];
  readonly states: ChatState[] = [];
  readonly service: ChatService;

  constructor(status: AccountStatus = accountStatus()) {
    this.accountStatus = status;
    const account: ChatAccount = {
      status: () => this.accountStatus,
      onStatusChange: (listener) => {
        this.accountListeners.add(listener);
        return () => this.accountListeners.delete(listener);
      },
      readWorkspaceData: (name, params, query) =>
        new Promise((resolve) => {
          this.reads.push({
            name,
            params,
            query,
            answer: resolve as (result: WorkspaceReadResult<unknown>) => void,
          });
        }),
    };
    const connection: ChatConnection = {
      status: () => this.connectionStatus,
      onStatusChange: (listener) => {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
      },
      onMessage: (listener) => {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
      },
      // Like the connection client: `build` gets the socket's identity, and
      // only a decoded event that is bound to it goes out.
      sendAs: (build) => {
        const identity = this.socketIdentity;
        if (identity === null) {
          return "not_connected";
        }
        this.built.push(identity);
        let event: unknown;
        try {
          event = build(identity);
        } catch {
          return "invalid";
        }
        if (this.forcedOutcome !== null) {
          return this.forcedOutcome;
        }
        const decoded = decodeClientMessage(
          JSON.parse(JSON.stringify(event)) as unknown,
        );
        if (
          !decoded.ok ||
          decoded.kind !== "event" ||
          decoded.event.type !== "chat.message.send" ||
          decoded.event.deviceId !== identity.deviceId ||
          decoded.event.actor.kind !== "user" ||
          decoded.event.actor.userId !== identity.userId
        ) {
          return "invalid";
        }
        this.sent.push(decoded.event);
        return "sent";
      },
      identity: () => this.socketIdentity,
    };
    this.service = createChatService({
      account,
      connection,
      workspaces: this.workspaces,
      scheduleTimer: (callback, delayMs) => {
        const timer: Timer = {
          callback,
          delayMs,
          dueAt: this.clock + delayMs,
          cancelled: false,
        };
        this.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      now: () => this.clock,
      wallClock: () => WALL_CLOCK + this.clock,
      log: (line) => this.logs.push(line),
    });
    this.service.onChange((state) => this.states.push(state));
  }

  setAccount(status: AccountStatus): void {
    this.accountStatus = status;
    for (const listener of [...this.accountListeners]) {
      listener(status);
    }
  }

  setConnection(
    state: "connected" | "connecting" | "offline",
    identity: ConnectionIdentity | null = state === "connected"
      ? IDENTITY
      : null,
  ): void {
    this.socketIdentity = identity;
    this.connectionStatus = {
      state,
      revision: this.connectionStatus.revision + 1,
    } as ConnectionStatus;
    for (const listener of [...this.connectionListeners]) {
      listener(this.connectionStatus);
    }
  }

  /**
   * The connection drops: as in the application, the workspace service hears
   * it first and its gate ends.
   */
  disconnect(): void {
    this.workspaces.setLive(WS_A, false);
    this.setConnection("offline");
  }

  receive(message: ServerMessage): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  get state(): ChatState {
    return this.service.state();
  }

  /** Takes the oldest open read. */
  take(): Read {
    const read = this.reads.shift();
    if (read === undefined) {
      throw new Error("No open read");
    }
    return read;
  }

  async answer(result: WorkspaceReadResult<unknown>): Promise<void> {
    this.take().answer(result);
    await settle();
  }

  openTimers(): Timer[] {
    return this.timers.filter((timer) => !timer.cancelled);
  }

  /** Moves the clock on by `ms`, firing the timers that fall due in order. */
  advance(ms: number): void {
    const target = this.clock + ms;
    for (;;) {
      const due = this.openTimers()
        .filter((timer) => timer.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (due === undefined) {
        break;
      }
      this.clock = due.dueAt;
      due.cancelled = true;
      due.callback();
    }
    this.clock = target;
  }

  /** The event IDs of the sent events, in order. */
  sentIds(): EventId[] {
    return this.sent.map((event) => event.id);
  }

  pendingStatuses(): string[] {
    return this.state.pending.map((copy) =>
      copy.status === "not_sent" ? `not_sent:${copy.reason}` : copy.status,
    );
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Signed in and connected, WS_A selected and subscribed, its gate live
 * when `live`, and PROJECT_1 open with the newest page of `seqs` loaded.
 */
async function withChat(
  options: { readonly live?: boolean; readonly seqs?: readonly number[] } = {},
): Promise<Harness> {
  const h = new Harness();
  h.setConnection("connected");
  h.workspaces.change(WS_A, null);
  h.receive(subscribed());
  // Without an open project, `workspace.subscribed` reads nothing.
  expect(h.reads).toEqual([]);
  if (options.live ?? true) {
    h.workspaces.setLive(WS_A, true);
  }
  h.workspaces.change(WS_A, PROJECT_1);
  await h.answer(ok(page(options.seqs ?? [1, 2, 3])));
  expect(h.state.status).toBe("ready");
  return h;
}

function seqsOf(state: ChatState): number[] {
  return state.messages.map((held) => held.seq);
}

const moduleFolder = path.dirname(fileURLToPath(import.meta.url));

test("opening a project loads its newest page, and the state is frozen", async () => {
  const h = new Harness();
  expect(h.state).toEqual({
    revision: 0,
    status: "no_project",
    workspaceId: null,
    projectId: null,
    messages: [],
    hasOlder: false,
    loadingOlder: false,
    pending: [],
  });
  h.setConnection("connected");
  h.workspaces.change(WS_A, PROJECT_1);
  expect(h.state).toMatchObject({
    status: "loading",
    workspaceId: WS_A,
    projectId: PROJECT_1,
  });
  expect(h.reads.map((read) => [read.name, read.params, read.query])).toEqual([
    ["listMessages", { projectId: PROJECT_1 }, { limit: 50 }],
  ]);
  await h.answer(ok(page(range(51, 100))));
  expect(h.state.status).toBe("ready");
  expect(seqsOf(h.state)).toEqual(range(51, 100));
  expect(h.state.hasOlder).toBe(true);
  expect(Object.isFrozen(h.state)).toBe(true);
  expect(Object.isFrozen(h.state.messages)).toBe(true);
  expect(Object.isFrozen(h.state.messages[0])).toBe(true);
  expect(Object.isFrozen(h.state.pending)).toBe(true);
  const revisions = h.states.map((state) => state.revision);
  expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
  expect(h.states.at(-1)).toBe(h.state);
});

test("nothing loads without a signed-in device and the connection's identity for it", async () => {
  // Signed out.
  const signedOut = new Harness(SIGNED_OUT);
  signedOut.setConnection("connected");
  signedOut.workspaces.change(WS_A, PROJECT_1);
  expect(signedOut.reads).toEqual([]);
  expect(signedOut.state.status).toBe("no_project");
  // Never connected: no identity yet.
  const offline = new Harness();
  offline.workspaces.change(WS_A, PROJECT_1);
  expect(offline.reads).toEqual([]);
  expect(offline.service.send("Hello from the composer")).toEqual({
    kind: "refused",
    reason: "no_project",
  });
  // An identity of another device.
  const other = new Harness();
  other.setConnection("connected", {
    userId: USER_ID,
    deviceId: OTHER_DEVICE_ID,
  });
  other.workspaces.change(WS_A, PROJECT_1);
  expect(other.reads).toEqual([]);
});

test("every workspace.subscribed of the selected workspace reloads the newest page, and events wait for it", async () => {
  const h = await withChat({ seqs: [1, 2, 3] });
  // Live: an event applies at once.
  h.receive(created(4));
  expect(seqsOf(h.state)).toEqual([1, 2, 3, 4]);
  // Another workspace's subscription changes nothing.
  h.receive(subscribed(WS_B));
  expect(h.reads).toEqual([]);

  h.receive(subscribed());
  expect(h.reads.map((read) => read.query)).toEqual([{ limit: 50 }]);
  h.receive(created(6));
  h.receive(created(5));
  // Another project's and another workspace's events are not held.
  h.receive(created(7, { projectId: PROJECT_2 }));
  h.receive(created(8, { workspaceId: WS_B }));
  expect(seqsOf(h.state)).toEqual([1, 2, 3, 4]);
  await h.answer(ok(page([1, 2, 3, 4])));
  expect(seqsOf(h.state)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("an answer of an earlier reload, or for another project, is dropped", async () => {
  const h = await withChat({ seqs: [1, 2] });
  h.receive(subscribed());
  h.receive(subscribed());
  const first = h.take();
  // The first answer is stale.
  first.answer(ok(page([1])));
  await settle();
  expect(seqsOf(h.state)).toEqual([1, 2]);
  await h.answer(ok(page([1, 2, 3])));
  expect(seqsOf(h.state)).toEqual([1, 2, 3]);

  // The page of PROJECT_1 answers after PROJECT_2 opened.
  h.receive(subscribed());
  const late = h.take();
  h.workspaces.change(WS_A, PROJECT_2);
  expect(h.state).toMatchObject({ projectId: PROJECT_2, status: "loading" });
  late.answer(ok(page([1, 2, 3, 4, 5])));
  await settle();
  expect(h.state.messages).toEqual([]);
  expect(h.state.status).toBe("loading");
  await h.answer(ok(page([9], PROJECT_2)));
  expect(seqsOf(h.state)).toEqual([9]);
});

test("a failed newest page is retried with the workspace service's backoff, and 60 seconds after rate_limited", async () => {
  const h = new Harness();
  h.setConnection("connected");
  h.workspaces.change(WS_A, null);
  h.receive(subscribed());
  h.workspaces.change(WS_A, PROJECT_1);
  await h.answer(failure("unavailable"));
  expect(h.state).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
  });
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([
    WORKSPACE_RETRY_BASE_MS,
  ]);
  h.advance(WORKSPACE_RETRY_BASE_MS);
  expect(h.reads).toHaveLength(1);
  await h.answer(failure("rate_limited"));
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([
    RATE_LIMITED_RETRY_MS,
  ]);
  h.advance(RATE_LIMITED_RETRY_MS);
  // A page that is not of the project fails as well.
  await h.answer(ok(page([1], PROJECT_2)));
  expect(h.state.problem).toBe("failed");
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([
    WORKSPACE_RETRY_BASE_MS * 4,
  ]);
  h.advance(WORKSPACE_RETRY_BASE_MS * 4);
  await h.answer(ok(page([1])));
  expect(h.state.status).toBe("ready");
  expect(h.state.problem).toBeUndefined();
});

test("older pages load with beforeSeq, and a late answer is dropped by generation or project", async () => {
  const h = await withChat({ seqs: range(51, 100) });
  expect(h.service.loadOlder()).toBe("started");
  expect(h.state.loadingOlder).toBe(true);
  expect(h.service.loadOlder()).toBe("busy");
  expect(h.reads.map((read) => read.query)).toEqual([
    { beforeSeq: 51, limit: 50 },
  ]);
  await h.answer(ok(page(range(1, 50))));
  expect(seqsOf(h.state)).toEqual(range(1, 100));
  expect(h.state.hasOlder).toBe(false);
  expect(h.state.loadingOlder).toBe(false);
  expect(h.service.loadOlder()).toBe("none");

  // A reload begins while an older page is on its way.
  const g = await withChat({ seqs: range(51, 100) });
  expect(g.service.loadOlder()).toBe("started");
  const olderRead = g.take();
  g.receive(subscribed());
  olderRead.answer(ok(page(range(1, 50))));
  await settle();
  expect(seqsOf(g.state)).toEqual(range(51, 100));
  expect(g.state.loadingOlder).toBe(false);

  // Another project opens while an older page is on its way.
  const p = await withChat({ seqs: range(51, 100) });
  expect(p.service.loadOlder()).toBe("started");
  const lateRead = p.take();
  p.workspaces.change(WS_A, PROJECT_2);
  lateRead.answer(ok(page(range(1, 50))));
  await settle();
  expect(p.state.projectId).toBe(PROJECT_2);
  expect(p.state.messages).toEqual([]);

  // A failed older page is reported until the next request.
  const f = await withChat({ seqs: range(51, 100) });
  f.service.loadOlder();
  await f.answer(failure("rate_limited"));
  expect(f.state.olderProblem).toBe("rate_limited");
  expect(f.service.loadOlder()).toBe("started");
  expect(f.state.olderProblem).toBeUndefined();
});

test("a message sent while live goes out at once with the connection's identity, and created with its causationId replaces it", async () => {
  const h = await withChat();
  const result = h.service.send("Hello from the composer\r\nSecond line");
  expect(result.kind).toBe("accepted");
  const eventId = result.kind === "accepted" ? result.eventId : undefined;
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0]).toEqual({
    protocolVersion: 0,
    id: eventId,
    occurredAt: new Date(WALL_CLOCK).toISOString(),
    workspaceId: WS_A,
    actor: { kind: "user", userId: USER_ID },
    deviceId: DEVICE_ID,
    type: "chat.message.send",
    payload: {
      projectId: PROJECT_1,
      body: "Hello from the composer\nSecond line",
    },
  });
  expect(h.built).toEqual([IDENTITY]);
  expect(h.state.pending).toEqual([
    {
      eventId,
      body: "Hello from the composer\nSecond line",
      status: "sending",
    },
  ]);
  h.receive(created(4, { causationId: eventId as EventId }));
  expect(h.state.pending).toEqual([]);
  expect(seqsOf(h.state)).toEqual([1, 2, 3, 4]);
});

test("a body that the protocol refuses is not kept", async () => {
  const h = await withChat();
  expect(h.service.send(" \n\t ")).toEqual({
    kind: "refused",
    reason: "blank",
  });
  expect(h.service.send("x".repeat(LIMITS.messageBody + 1))).toEqual({
    kind: "refused",
    reason: "too_long",
  });
  expect(h.service.send("Hello\u200bthere")).toEqual({
    kind: "refused",
    reason: "invalid_characters",
  });
  expect(h.state.pending).toEqual([]);
  expect(h.sent).toEqual([]);
});

test("at most 50 messages wait, and another one is refused with too_many_pending and not kept", async () => {
  const h = await withChat({ live: false });
  for (let index = 0; index < MAX_PENDING_CHAT_MESSAGES; index += 1) {
    expect(h.service.send(`Message ${index}`).kind).toBe("accepted");
  }
  expect(h.state.pending).toHaveLength(50);
  const revision = h.state.revision;
  expect(h.service.send("One too many")).toEqual({
    kind: "refused",
    reason: "too_many_pending",
  });
  expect(h.state.pending).toHaveLength(50);
  expect(h.state.revision).toBe(revision);
  expect(h.sent).toEqual([]);
});

test("messages are sent only while gateLive holds, and waiting ones go out with their event IDs, one per second", async () => {
  const h = await withChat({ live: false });
  const ids = ["First", "Second", "Third"].map((text) => {
    const result = h.service.send(text);
    return result.kind === "accepted" ? result.eventId : undefined;
  });
  // Connected and subscribed, but the workspace has not reloaded.
  expect(h.sent).toEqual([]);
  expect(h.built).toEqual([]);
  expect(h.pendingStatuses()).toEqual(["waiting", "waiting", "waiting"]);

  h.workspaces.setLive(WS_A, true);
  expect(h.sentIds()).toEqual([ids[0]]);
  h.advance(CHAT_RESEND_INTERVAL_MS - 1);
  expect(h.sentIds()).toEqual([ids[0]]);
  h.advance(1);
  expect(h.sentIds()).toEqual([ids[0], ids[1]]);
  // Another state change does not hurry the next send.
  h.workspaces.setLive(WS_A, true);
  expect(h.sentIds()).toEqual([ids[0], ids[1]]);
  h.advance(CHAT_RESEND_INTERVAL_MS);
  expect(h.sentIds()).toEqual(ids);
  expect(h.pendingStatuses()).toEqual(["sending", "sending", "sending"]);
  expect(h.sent.map((event) => event.payload.body)).toEqual([
    "First",
    "Second",
    "Third",
  ]);
});

test("a new message waits behind the waiting ones", async () => {
  const h = await withChat({ live: false });
  h.service.send("First");
  h.workspaces.setLive(WS_A, false);
  h.service.send("Second");
  expect(h.sent).toEqual([]);
  h.workspaces.setLive(WS_A, true);
  expect(h.sent.map((event) => event.payload.body)).toEqual(["First"]);
  h.service.send("Third");
  expect(h.sent.map((event) => event.payload.body)).toEqual(["First"]);
  h.advance(CHAT_RESEND_INTERVAL_MS * 2);
  expect(h.sent.map((event) => event.payload.body)).toEqual([
    "First",
    "Second",
    "Third",
  ]);
});

test("a lost connection turns sending messages back to waiting, and they go out again with the same event ID", async () => {
  const h = await withChat();
  const result = h.service.send("Hello from the composer");
  const eventId = result.kind === "accepted" ? result.eventId : undefined;
  expect(h.pendingStatuses()).toEqual(["sending"]);

  h.disconnect();
  expect(h.pendingStatuses()).toEqual(["waiting"]);
  h.advance(CHAT_RESEND_INTERVAL_MS);
  h.setConnection("connected");
  h.receive(subscribed());
  // Subscribed, but the workspace service has not reloaded yet.
  expect(h.sentIds()).toEqual([eventId]);
  h.workspaces.setLive(WS_A, true);
  expect(h.sentIds()).toEqual([eventId, eventId]);
  expect(h.sent[1]).toEqual(h.sent[0]);
  expect(h.pendingStatuses()).toEqual(["sending"]);
});

test("not_found and conflict show as not sent at once, and retry sends again with the same event ID", async () => {
  for (const code of ["not_found", "conflict"] as const) {
    const h = await withChat();
    const result = h.service.send("Hello from the composer");
    const eventId = (
      result.kind === "accepted" ? result.eventId : ""
    ) as EventId;
    h.receive(refusedFrame(eventId, code));
    expect(h.pendingStatuses()).toEqual([`not_sent:${code}`]);
    h.advance(CHAT_RATE_LIMITED_RETRY_MS * 10);
    expect(h.sent).toHaveLength(1);
    // A refusal of another event changes nothing.
    h.receive(
      refusedFrame("0192f0a0-7b3c-7d4e-8f50-0000000000dd" as EventId, code),
    );
    expect(h.sent).toHaveLength(1);

    expect(h.service.retry(eventId)).toBe(true);
    expect(h.sentIds()).toEqual([eventId, eventId]);
    expect(h.pendingStatuses()).toEqual(["sending"]);
    // Only a message that shows as not sent can be retried.
    expect(h.service.retry(eventId)).toBe(false);
  }
});

test("after rate_limited a message is tried again 3 times, 10 seconds apart, then shows as not sent", async () => {
  expect(CHAT_RATE_LIMITED_RETRIES).toBe(3);
  expect(CHAT_RATE_LIMITED_RETRY_MS).toBe(10_000);
  const h = await withChat();
  const result = h.service.send("Hello from the composer");
  const eventId = (result.kind === "accepted" ? result.eventId : "") as EventId;
  h.receive(refusedFrame(eventId, "rate_limited"));
  expect(h.pendingStatuses()).toEqual(["waiting"]);
  h.advance(CHAT_RATE_LIMITED_RETRY_MS - 1);
  expect(h.sent).toHaveLength(1);
  h.advance(1);
  expect(h.sent).toHaveLength(2);
  for (const sends of [3, 4]) {
    h.receive(refusedFrame(eventId, "rate_limited"));
    expect(h.pendingStatuses()).toEqual(["waiting"]);
    h.advance(CHAT_RATE_LIMITED_RETRY_MS);
    expect(h.sent).toHaveLength(sends);
  }
  // The first send and 3 retries were refused.
  h.receive(refusedFrame(eventId, "rate_limited"));
  expect(h.pendingStatuses()).toEqual(["not_sent:rate_limited"]);
  h.advance(CHAT_RATE_LIMITED_RETRY_MS * 10);
  expect(h.sentIds()).toEqual([eventId, eventId, eventId, eventId]);

  // Retry gives 3 new retries.
  expect(h.service.retry(eventId)).toBe(true);
  expect(h.sent).toHaveLength(5);
  for (const sends of [6, 7, 8]) {
    h.receive(refusedFrame(eventId, "rate_limited"));
    h.advance(CHAT_RATE_LIMITED_RETRY_MS);
    expect(h.sent).toHaveLength(sends);
  }
  expect(h.pendingStatuses()).toEqual(["sending"]);
});

test("a late rate_limited does not bring back a message that shows as not sent", async () => {
  const h = await withChat();
  const result = h.service.send("Hello from the composer");
  const eventId = (result.kind === "accepted" ? result.eventId : "") as EventId;
  h.receive(refusedFrame(eventId, "not_found"));
  expect(h.pendingStatuses()).toEqual(["not_sent:not_found"]);
  h.receive(refusedFrame(eventId, "rate_limited"));
  expect(h.pendingStatuses()).toEqual(["not_sent:not_found"]);
  h.advance(CHAT_RATE_LIMITED_RETRY_MS * 2);
  expect(h.sent).toHaveLength(1);
  expect(h.logs).toEqual(["A chat message was refused (not_found)."]);
});

test("a message that waits after rate_limited keeps its place: a new one goes out only after it", async () => {
  const h = await withChat();
  const a = h.service.send("First");
  const aId = (a.kind === "accepted" ? a.eventId : "") as EventId;
  h.receive(refusedFrame(aId, "rate_limited"));
  h.advance(2_000);
  const b = h.service.send("Second");
  const bId = (b.kind === "accepted" ? b.eventId : "") as EventId;
  expect(h.pendingStatuses()).toEqual(["waiting", "waiting"]);
  h.advance(CHAT_RATE_LIMITED_RETRY_MS - 2_000 - 1);
  expect(h.sentIds()).toEqual([aId]);
  h.advance(1);
  expect(h.sentIds()).toEqual([aId, aId]);
  h.advance(CHAT_RESEND_INTERVAL_MS);
  expect(h.sentIds()).toEqual([aId, aId, bId]);
  expect(h.pendingStatuses()).toEqual(["sending", "sending"]);
});

test("after a reconnect, the copies behind a message that waits after rate_limited do not pass it", async () => {
  const h = await withChat({ live: false });
  h.workspaces.setLive(WS_A, true);
  const a = h.service.send("First");
  const aId = (a.kind === "accepted" ? a.eventId : "") as EventId;
  h.receive(refusedFrame(aId, "rate_limited"));
  h.workspaces.setLive(WS_A, false);
  const b = h.service.send("Second");
  const bId = (b.kind === "accepted" ? b.eventId : "") as EventId;
  const c = h.service.send("Third");
  const cId = (c.kind === "accepted" ? c.eventId : "") as EventId;
  h.disconnect();
  h.advance(3_000);
  h.setConnection("connected");
  h.receive(subscribed());
  h.workspaces.setLive(WS_A, true);
  expect(h.sentIds()).toEqual([aId]);
  h.advance(CHAT_RATE_LIMITED_RETRY_MS - 3_000 - 1);
  expect(h.sentIds()).toEqual([aId]);
  h.advance(1);
  h.advance(CHAT_RESEND_INTERVAL_MS * 2);
  expect(h.sentIds()).toEqual([aId, aId, bId, cId]);
});

test("a send that the connection client cannot take keeps waiting or shows as not sent", async () => {
  const h = await withChat();
  h.forcedOutcome = "backpressure";
  h.service.send("First");
  expect(h.pendingStatuses()).toEqual(["waiting"]);
  h.forcedOutcome = null;
  h.advance(CHAT_RESEND_INTERVAL_MS - 1);
  expect(h.sent).toEqual([]);
  // It is tried again a second later.
  h.advance(1);
  expect(h.sent).toHaveLength(1);
  expect(h.pendingStatuses()).toEqual(["sending"]);

  for (const outcome of ["too_large", "invalid"] as const) {
    const g = await withChat();
    g.forcedOutcome = outcome;
    const result = g.service.send("Hello from the composer");
    const eventId = (
      result.kind === "accepted" ? result.eventId : ""
    ) as EventId;
    expect(g.pendingStatuses()).toEqual(["not_sent:not_sendable"]);
    // It is not tried again by itself.
    g.forcedOutcome = null;
    g.advance(CHAT_RESEND_INTERVAL_MS * 5);
    g.workspaces.setLive(WS_A, true);
    expect(g.sent).toEqual([]);
    expect(g.service.retry(eventId)).toBe(true);
    expect(g.sentIds()).toEqual([eventId]);
  }
});

test("discard drops a waiting or not sent message, never one that is being sent", async () => {
  const h = await withChat({ live: false });
  const result = h.service.send("Hello from the composer");
  const eventId = (result.kind === "accepted" ? result.eventId : "") as EventId;
  expect(h.service.discard(eventId)).toBe(true);
  expect(h.state.pending).toEqual([]);
  expect(h.service.discard(eventId)).toBe(false);

  h.workspaces.setLive(WS_A, true);
  const sending = h.service.send("Hello from the composer");
  const sendingId = (
    sending.kind === "accepted" ? sending.eventId : ""
  ) as EventId;
  expect(h.service.discard(sendingId)).toBe(false);
  h.receive(refusedFrame(sendingId, "conflict"));
  expect(h.service.discard(sendingId)).toBe(true);
  expect(h.state.pending).toEqual([]);
});

test("waiting messages are dropped without asking on sign-out and on another device", async () => {
  for (const status of [SIGNED_OUT, accountStatus(OTHER_DEVICE_ID)]) {
    const h = await withChat({ live: false });
    h.service.send("Hello from the composer");
    h.setAccount(status);
    expect(h.state.status).toBe("no_project");
    expect(h.state.pending).toEqual([]);
    // Back to the first device: nothing comes back, and nothing is sent.
    h.setAccount(accountStatus());
    h.setConnection("connected");
    h.workspaces.setLive(WS_A, true);
    expect(h.state.pending).toEqual([]);
    expect(h.sent).toEqual([]);
  }
});

test("waiting messages are dropped when the connection authenticates another account", async () => {
  const h = await withChat({ live: false });
  h.service.send("Hello from the composer");
  h.disconnect();
  h.setConnection("connected", { userId: OTHER_USER_ID, deviceId: DEVICE_ID });
  expect(h.state.pending).toEqual([]);
  h.workspaces.setLive(WS_A, true);
  expect(h.sent).toEqual([]);
});

test("a message is never sent under an identity that is not its own", async () => {
  const h = await withChat({ live: false });
  h.service.send("Hello from the composer");
  // The socket authenticated another account without a status change yet.
  h.socketIdentity = { userId: OTHER_USER_ID, deviceId: DEVICE_ID };
  h.workspaces.setLive(WS_A, true);
  expect(h.built).toHaveLength(1);
  expect(h.sent).toEqual([]);
  expect(h.state.pending).toEqual([]);
});

test("waiting messages are dropped when the membership ends", async () => {
  for (const ended of [
    frame({
      type: "workspace.unsubscribed",
      workspaceId: WS_A,
      reason: "membership_ended",
    }),
    frame({
      type: "account.removed_from_workspace",
      workspaceId: WS_A,
      removedAt: AT,
    }),
    frame({
      type: "workspace.subscribe_refused",
      workspaceId: WS_A,
      code: "not_found",
    }),
  ]) {
    const h = await withChat({ live: false });
    h.service.send("Hello from the composer");
    // Another workspace's end changes nothing.
    h.receive(
      frame({
        type: "account.removed_from_workspace",
        workspaceId: WS_B,
        removedAt: AT,
      }),
    );
    expect(h.state.pending).toHaveLength(1);
    h.receive(ended);
    expect(h.state.pending).toEqual([]);
    expect(seqsOf(h.state)).toEqual([1, 2, 3]);
  }

  // The workspace service leaves the workspace by itself.
  const h = await withChat({ live: false });
  h.service.send("Hello from the composer");
  h.workspaces.change(WS_B, null);
  expect(h.state.status).toBe("no_project");
  expect(h.state.pending).toEqual([]);
});

test("switchProject asks first while messages wait, and discards them only when told", async () => {
  const h = await withChat({ live: false });
  // Without waiting messages, the switch goes ahead.
  expect(h.service.switchProject(PROJECT_2, { discardWaiting: false })).toEqual(
    { kind: "switched" },
  );
  expect(h.workspaces.state().openProjectId).toBe(PROJECT_2);
  await h.answer(ok(page([1], PROJECT_2)));

  h.service.send("First");
  h.service.send("Second");
  expect(h.service.switchProject(PROJECT_1, { discardWaiting: false })).toEqual(
    { kind: "waiting", count: 2 },
  );
  expect(h.service.switchProject(null, { discardWaiting: false })).toEqual({
    kind: "waiting",
    count: 2,
  });
  expect(h.workspaces.state().openProjectId).toBe(PROJECT_2);
  expect(h.state.pending).toHaveLength(2);
  // The open project itself is no switch.
  expect(h.service.switchProject(PROJECT_2, { discardWaiting: false })).toEqual(
    { kind: "switched" },
  );
  expect(h.state.pending).toHaveLength(2);
  // An unknown project keeps the messages.
  expect(
    h.service.switchProject(UNKNOWN_PROJECT, { discardWaiting: true }),
  ).toEqual({ kind: "refused" });
  expect(h.state.pending).toHaveLength(2);

  expect(h.service.switchProject(PROJECT_1, { discardWaiting: true })).toEqual({
    kind: "switched",
  });
  expect(h.state).toMatchObject({ projectId: PROJECT_1, pending: [] });
  h.workspaces.setLive(WS_A, true);
  expect(h.sent).toEqual([]);
});

test("selectWorkspace asks first while messages wait, and discards them only when told", async () => {
  const h = await withChat({ live: false });
  h.service.send("Hello from the composer");
  expect(h.service.selectWorkspace(WS_B, { discardWaiting: false })).toEqual({
    kind: "waiting",
    count: 1,
  });
  expect(h.workspaces.calls).not.toContain(`select ${WS_B}`);
  expect(h.workspaces.state().selectedWorkspaceId).toBe(WS_A);
  expect(h.state.pending).toHaveLength(1);
  // The selected workspace itself is no switch.
  expect(h.service.selectWorkspace(WS_A, { discardWaiting: false })).toEqual({
    kind: "switched",
  });
  expect(h.state.pending).toHaveLength(1);
  expect(
    h.service.selectWorkspace(
      "0192f0a0-7b3c-7d4e-8f50-0000000000a9" as WorkspaceId,
      { discardWaiting: true },
    ),
  ).toEqual({ kind: "refused" });
  expect(h.state.pending).toHaveLength(1);

  expect(h.service.selectWorkspace(WS_B, { discardWaiting: true })).toEqual({
    kind: "switched",
  });
  expect(h.workspaces.state().selectedWorkspaceId).toBe(WS_B);
  expect(h.state.status).toBe("no_project");
  expect(h.state.pending).toEqual([]);

  // Without waiting messages it switches at once.
  expect(h.service.selectWorkspace(WS_A, { discardWaiting: false })).toEqual({
    kind: "switched",
  });
  expect(h.workspaces.state().selectedWorkspaceId).toBe(WS_A);
});

test("too many waiting events reload the chat after a backoff, and a message being sent goes out again", async () => {
  const h = await withChat({ seqs: [1] });
  const result = h.service.send("Hello from the composer");
  const eventId = (result.kind === "accepted" ? result.eventId : "") as EventId;
  h.receive(subscribed());
  // Events of other projects are not buffered.
  for (let index = 0; index <= MAX_BUFFERED_EVENTS; index += 1) {
    h.receive(created(2, { projectId: PROJECT_2 }));
  }
  expect(h.logs).toEqual([]);
  expect(h.openTimers()).toEqual([]);
  for (let index = 0; index <= MAX_BUFFERED_EVENTS; index += 1) {
    h.receive(created(2));
  }
  // The created event of the message was dropped with the others.
  h.receive(created(3, { causationId: eventId }));
  expect(h.logs).toContain("Too many chat events waited; the chat reloads.");
  // The open reload is stale.
  await h.answer(ok(page([1, 2])));
  expect(seqsOf(h.state)).toEqual([1]);
  expect(h.openTimers().map((timer) => timer.delayMs)).toContain(
    WORKSPACE_RETRY_BASE_MS,
  );
  h.advance(WORKSPACE_RETRY_BASE_MS);
  await h.answer(ok(page([1, 2, 3])));
  expect(seqsOf(h.state)).toEqual([1, 2, 3]);
  expect(h.sentIds()).toEqual([eventId, eventId]);
  h.receive(created(3, { causationId: eventId }));
  expect(h.state.pending).toEqual([]);
});

test("after an overflow, only the messages whose answer may be lost go out again", async () => {
  const h = await withChat({ seqs: [1] });
  const x = h.service.send("First");
  const xId = (x.kind === "accepted" ? x.eventId : "") as EventId;
  h.receive(subscribed());
  for (let index = 0; index <= MAX_BUFFERED_EVENTS; index += 1) {
    h.receive(created(2));
  }
  // Sent while the gate stays overflowed: its answer is dropped too.
  const y = h.service.send("Second");
  const yId = (y.kind === "accepted" ? y.eventId : "") as EventId;
  h.advance(WORKSPACE_RETRY_BASE_MS);
  // Sent after the reload began: its answer waits for the reload.
  const z = h.service.send("Third");
  const zId = (z.kind === "accepted" ? z.eventId : "") as EventId;
  expect(h.sentIds()).toEqual([xId, yId, zId]);
  // The reload of `workspace.subscribed` is stale; the one after the overflow applies.
  await h.answer(ok(page([1, 2])));
  await h.answer(ok(page([1, 2])));
  expect(seqsOf(h.state)).toEqual([1, 2]);
  expect(h.pendingStatuses()).toEqual(["waiting", "waiting", "sending"]);
  h.advance(CHAT_RESEND_INTERVAL_MS * 10);
  expect(h.sentIds()).toEqual([xId, yId, zId, xId, yId]);
  expect(h.pendingStatuses()).toEqual(["sending", "sending", "sending"]);
});

/** The event ID of an accepted send. */
function idOf(result: ReturnType<ChatService["send"]>): EventId {
  if (result.kind !== "accepted") {
    throw new Error("The test message was refused");
  }
  return result.eventId;
}

/** Overflows the chat's gate during the reload of a `workspace.subscribed`. */
function overflow(h: Harness): void {
  h.receive(subscribed());
  for (let index = 0; index <= MAX_BUFFERED_EVENTS; index += 1) {
    h.receive(created(2));
  }
  expect(h.logs).toContain("Too many chat events waited; the chat reloads.");
}

test("after an overflow and a failed reload, the retry sends the message again once", async () => {
  const h = await withChat({ seqs: [1] });
  const x = idOf(h.service.send("First"));
  overflow(h);
  h.advance(WORKSPACE_RETRY_BASE_MS);
  // The reload of `workspace.subscribed` is stale; the one after the overflow fails.
  await h.answer(ok(page([1, 2])));
  await h.answer(failure("unavailable"));
  expect(h.pendingStatuses()).toEqual(["sending"]);
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([
    WORKSPACE_RETRY_BASE_MS * 2,
  ]);
  h.advance(WORKSPACE_RETRY_BASE_MS * 2);
  await h.answer(ok(page([1, 2])));
  expect(h.sentIds()).toEqual([x, x]);
  h.receive(created(3, { causationId: x }));
  // The answer to the repeat.
  h.receive(created(3, { causationId: x }));
  h.advance(CHAT_RESEND_INTERVAL_MS * 10);
  expect(h.state.pending).toEqual([]);
  expect(seqsOf(h.state)).toEqual([1, 2, 3]);
  expect(h.sentIds()).toEqual([x, x]);
});

test("a message sent while the gate stays overflowed, whose answer is dropped, is sent again after the retried reload", async () => {
  const h = await withChat({ seqs: [1] });
  overflow(h);
  const y = idOf(h.service.send("Second"));
  // Its answer arrives while events are dropped.
  h.receive(created(3, { causationId: y }));
  expect(h.pendingStatuses()).toEqual(["sending"]);
  h.advance(WORKSPACE_RETRY_BASE_MS);
  await h.answer(ok(page([1, 2])));
  await h.answer(failure("unavailable"));
  h.advance(WORKSPACE_RETRY_BASE_MS * 2);
  await h.answer(ok(page([1, 2, 3])));
  expect(h.sentIds()).toEqual([y, y]);
  h.receive(created(3, { causationId: y }));
  h.advance(CHAT_RESEND_INTERVAL_MS * 10);
  expect(h.state.pending).toEqual([]);
  expect(h.sentIds()).toEqual([y, y]);
});

test("after an overflow and a lost connection, the reconnect sends the message again once", async () => {
  const h = await withChat({ seqs: [1] });
  const x = idOf(h.service.send("First"));
  overflow(h);
  h.disconnect();
  expect(h.pendingStatuses()).toEqual(["waiting"]);
  // The lost connection cancels the reload after the overflow.
  expect(h.openTimers()).toEqual([]);
  h.advance(CHAT_RESEND_INTERVAL_MS);
  h.setConnection("connected");
  h.receive(subscribed());
  h.workspaces.setLive(WS_A, true);
  expect(h.sentIds()).toEqual([x, x]);
  // The reload of the old subscription is stale; the new one applies, and
  // the message sent during it is not sent a third time.
  await h.answer(ok(page([1, 2])));
  await h.answer(ok(page([1, 2])));
  expect(h.pendingStatuses()).toEqual(["sending"]);
  h.advance(CHAT_RESEND_INTERVAL_MS * 10);
  expect(h.sentIds()).toEqual([x, x]);
  h.receive(created(3, { causationId: x }));
  expect(h.state.pending).toEqual([]);
});

test("discarding the first waiting message lets the next one go at once", async () => {
  const h = await withChat();
  const a = idOf(h.service.send("First"));
  h.receive(refusedFrame(a, "rate_limited"));
  h.advance(2_000);
  const b = idOf(h.service.send("Second"));
  expect(h.sentIds()).toEqual([a]);
  expect(h.service.discard(a)).toBe(true);
  expect(h.sentIds()).toEqual([a, b]);
  expect(h.pendingStatuses()).toEqual(["sending"]);
});

test("a second rate_limited for a message that already waits does not count against its retries", async () => {
  const h = await withChat();
  const a = idOf(h.service.send("First"));
  // Both answers of a message that was in flight twice.
  h.receive(refusedFrame(a, "rate_limited"));
  h.receive(refusedFrame(a, "rate_limited"));
  for (const sends of [2, 3, 4]) {
    h.advance(CHAT_RATE_LIMITED_RETRY_MS);
    expect(h.sent).toHaveLength(sends);
    expect(h.pendingStatuses()).toEqual(["sending"]);
    h.receive(refusedFrame(a, "rate_limited"));
  }
  expect(h.pendingStatuses()).toEqual(["not_sent:rate_limited"]);
  expect(h.logs).toHaveLength(4);
});

test("waiting messages and their key outlive a lost connection while the workspace service changes", async () => {
  const h = await withChat({ live: false });
  const result = h.service.send("Hello from the composer");
  const eventId = (result.kind === "accepted" ? result.eventId : "") as EventId;
  const pending = h.state.pending;
  h.disconnect();
  // The workspace service notifies while offline.
  h.workspaces.setLive(WS_A, false);
  h.workspaces.change(WS_A, PROJECT_1);
  // On the reconnect the workspace service hears `connected` first and
  // notifies before the chat does.
  h.socketIdentity = IDENTITY;
  h.workspaces.change(WS_A, PROJECT_1);
  expect(h.state.pending).toEqual(pending);
  expect(h.state.projectId).toBe(PROJECT_1);
  h.setConnection("connected");
  h.receive(subscribed());
  h.workspaces.setLive(WS_A, true);
  expect(h.sentIds()).toEqual([eventId]);
});

test("the switch question also counts messages that are being sent or show as not sent", async () => {
  const h = await withChat();
  const result = h.service.send("Hello from the composer");
  const eventId = (result.kind === "accepted" ? result.eventId : "") as EventId;
  for (const statuses of [["sending"], ["not_sent:conflict"]]) {
    if (statuses[0] !== "sending") {
      h.receive(refusedFrame(eventId, "conflict"));
    }
    expect(h.pendingStatuses()).toEqual(statuses);
    expect(
      h.service.switchProject(PROJECT_2, { discardWaiting: false }),
    ).toEqual({ kind: "waiting", count: 1 });
    expect(h.service.selectWorkspace(WS_B, { discardWaiting: false })).toEqual({
      kind: "waiting",
      count: 1,
    });
    expect(h.pendingStatuses()).toEqual(statuses);
    expect(h.workspaces.state()).toMatchObject({
      selectedWorkspaceId: WS_A,
      openProjectId: PROJECT_1,
    });
  }
});

test("a requested unsubscription keeps the waiting messages", async () => {
  const h = await withChat({ live: false });
  const result = h.service.send("Hello from the composer");
  const eventId = (result.kind === "accepted" ? result.eventId : "") as EventId;
  h.receive(
    frame({
      type: "workspace.unsubscribed",
      workspaceId: WS_A,
      reason: "requested",
    }),
  );
  expect(h.pendingStatuses()).toEqual(["waiting"]);
  h.receive(subscribed());
  h.workspaces.setLive(WS_A, true);
  expect(h.sentIds()).toEqual([eventId]);
});

test("a stale failed reload changes nothing", async () => {
  const h = await withChat({ seqs: [1, 2] });
  h.receive(subscribed());
  h.receive(subscribed());
  h.take().answer(failure("unavailable"));
  await settle();
  expect(h.state.status).toBe("ready");
  expect(h.logs).toEqual([]);
  expect(h.openTimers()).toEqual([]);
  await h.answer(ok(page([1, 2, 3])));
  expect(seqsOf(h.state)).toEqual([1, 2, 3]);
});

test("a failure after ready keeps the messages, and a success resets the backoff", async () => {
  const h = await withChat({ seqs: [1, 2] });
  h.receive(subscribed());
  await h.answer(failure("unavailable"));
  expect(h.state).toMatchObject({
    status: "unavailable",
    problem: "unavailable",
  });
  expect(seqsOf(h.state)).toEqual([1, 2]);
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([
    WORKSPACE_RETRY_BASE_MS,
  ]);
  h.advance(WORKSPACE_RETRY_BASE_MS);
  await h.answer(ok(page([1, 2])));
  expect(h.state.status).toBe("ready");
  h.receive(subscribed());
  await h.answer(failure("unavailable"));
  expect(h.openTimers().map((timer) => timer.delayMs)).toEqual([
    WORKSPACE_RETRY_BASE_MS,
  ]);
});

test("a sign-in again on the same device while offline loads nothing until the next auth.ok", async () => {
  const h = await withChat();
  h.setAccount(SIGNED_OUT);
  h.setConnection("offline");
  h.setAccount(accountStatus());
  expect(h.state.status).toBe("no_project");
  expect(h.reads).toEqual([]);
  h.setConnection("connected");
  expect(h.state).toMatchObject({ status: "loading", projectId: PROJECT_1 });
  expect(h.reads).toHaveLength(1);
});

test("authorName gives the person's name, and a fixed text for an agent", async () => {
  const h = await withChat();
  expect(h.service.authorName({ kind: "member", memberId: MEMBER })).toBe(
    "Grace Member",
  );
  expect(
    h.service.authorName({
      kind: "member",
      memberId: "0192f0a0-7b3c-7d4e-8f50-0000000000c9" as MemberId,
    }),
  ).toBe(UNKNOWN_MEMBER_NAME);
  const agentMessage = ChatHistoryResponseSchema.parse({
    messages: [message(4, { agent: true })],
  }).messages[0];
  expect(agentMessage).toBeDefined();
  if (agentMessage !== undefined) {
    expect(h.service.authorName(agentMessage.author)).toBe(UNKNOWN_AGENT_NAME);
  }
  expect(UNKNOWN_AGENT_NAME).toBe("Unknown agent");
});

test("a listener that throws is logged, and the others still get the state", async () => {
  const h = await withChat();
  const seen: number[] = [];
  h.service.onChange(() => {
    throw new Error("Grace Member");
  });
  h.service.onChange((state) => seen.push(state.revision));
  h.receive(created(4));
  expect(seen).toEqual([h.state.revision]);
  expect(h.logs).toEqual(["A chat state listener failed."]);
});

test("close stops listening and cancels the timers", async () => {
  const h = await withChat();
  const result = h.service.send("Hello from the composer");
  const eventId = (result.kind === "accepted" ? result.eventId : "") as EventId;
  h.receive(refusedFrame(eventId, "rate_limited"));
  expect(h.openTimers()).toHaveLength(1);
  h.service.close();
  expect(h.openTimers()).toEqual([]);
  expect(h.accountListeners.size).toBe(0);
  expect(h.connectionListeners.size).toBe(0);
  expect(h.messageListeners.size).toBe(0);
  expect(h.workspaces.listeners.size).toBe(0);
  expect(h.service.send("Hello from the composer")).toEqual({
    kind: "refused",
    reason: "no_project",
  });
  expect(h.service.loadOlder()).toBe("none");
  expect(h.service.switchProject(PROJECT_2, { discardWaiting: true })).toEqual({
    kind: "refused",
  });
});

test("no log holds a name, an ID, or a message body, and the service never logs with console", async () => {
  const h = new Harness();
  h.setConnection("connected");
  h.workspaces.change(WS_A, null);
  h.receive(subscribed());
  h.workspaces.setLive(WS_A, true);
  h.workspaces.change(WS_A, PROJECT_1);
  await h.answer(failure("not_found"));
  h.advance(WORKSPACE_RETRY_BASE_MS);
  await h.answer(ok(page(range(51, 100))));
  h.service.loadOlder();
  await h.answer(failure("unavailable"));
  const result = h.service.send("Hello from the composer");
  const eventId = (result.kind === "accepted" ? result.eventId : "") as EventId;
  h.receive(refusedFrame(eventId, "conflict"));
  h.forcedOutcome = "invalid";
  h.service.retry(eventId);
  h.advance(CHAT_RESEND_INTERVAL_MS);
  h.service.onChange(() => {
    throw new Error("Hello from the composer");
  });
  h.receive(created(101));
  expect(h.logs).toEqual([
    "The chat history did not load (not_found).",
    "An older chat page did not load (unavailable).",
    "A chat message was refused (conflict).",
    "A chat message could not be sent (invalid).",
    "A chat state listener failed.",
  ]);
  const text = h.logs.join("\n");
  for (const value of [
    ...SECRETS,
    DEVICE_ID,
    USER_ID,
    WS_A,
    MEMBER,
    PROJECT_1,
    eventId,
  ]) {
    expect(text).not.toContain(value);
  }
  const source = readFileSync(path.join(moduleFolder, "service.ts"), "utf8");
  expect(source).not.toMatch(/\bconsole\./);
  // The state holds no user ID or device ID either.
  expect(JSON.stringify(h.state)).not.toContain(USER_ID);
  expect(JSON.stringify(h.state)).not.toContain(DEVICE_ID);
});
