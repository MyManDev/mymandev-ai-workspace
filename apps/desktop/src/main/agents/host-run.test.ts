import {
  decodeClientMessage,
  decodeServerMessage,
  EVENT_REFUSAL_CODES,
  RUN_CANCEL_REASONS,
  RUN_STATES,
  type AgentId,
  type AgentRunStateChangedEvent,
  type DeviceId,
  type EventId,
  type ReceivedServerEvent,
  type RunId,
  type RunState,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  CONNECTION_STOP_REASONS,
  CONNECTION_WAITING_REASONS,
  type ConnectionStatus,
} from "../../shared/ipc-contract.ts";
import type {
  BuildClientEvent,
  SendOutcome,
  ServerMessage,
} from "../connection/client.ts";
import {
  createHostRun,
  HOST_RUN_ACK_TIMEOUT_MS,
  type HostRun,
  type HostRunConnection,
  type HostRunState,
} from "./host-run.ts";

const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004" as DeviceId;
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000014" as DeviceId;
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009" as UserId;
const WS_A = "0192f0a0-7b3c-7d4e-8f50-0000000000a1" as WorkspaceId;
const WS_B = "0192f0a0-7b3c-7d4e-8f50-0000000000a2" as WorkspaceId;
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-0000000000f1" as AgentId;
const OTHER_AGENT = "0192f0a0-7b3c-7d4e-8f50-0000000000f2" as AgentId;
const RUN_1 = "0192f0a0-7b3c-7d4e-8f50-0000000b0001" as RunId;
const RUN_2 = "0192f0a0-7b3c-7d4e-8f50-0000000b0002" as RunId;
const WALL_START = Date.parse("2026-11-14T12:00:00.000Z");

function eventId(n: number): EventId {
  return `0192f0a0-7b3c-7d4e-8f50-0000000e${n.toString(16).padStart(4, "0")}` as EventId;
}

/**
 * The run lifecycle of ADR 0007, written out here so that the model's check
 * is compared with the decision, not with itself.
 */
const ALLOWED: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["running", "failed", "cancelled"],
  running: ["awaiting_input", "completed", "failed", "cancelled"],
  awaiting_input: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const CONNECTED: ConnectionStatus = { state: "connected", revision: 1 };
const CONNECTING: ConnectionStatus = { state: "connecting", revision: 2 };

function waiting(
  reason: (typeof CONNECTION_WAITING_REASONS)[number],
): ConnectionStatus {
  return {
    state: "waiting",
    reason,
    retryAt: "2026-11-14T12:00:30.000Z",
    revision: 2,
  };
}

interface Timer {
  readonly at: number;
  readonly callback: () => void;
  cancelled: boolean;
}

interface HarnessOptions {
  readonly runState?: RunState;
  readonly connection?: ConnectionStatus;
  readonly ackTimeoutMs?: number;
}

class Harness {
  time = 0;
  identity: { userId: UserId; deviceId: DeviceId } | null = {
    userId: USER_ID,
    deviceId: DEVICE_ID,
  };
  /** What `sendAs` answers instead of sending, when set. */
  failSend: SendOutcome | null = null;
  connectionStatus: ConnectionStatus;
  readonly sent: AgentRunStateChangedEvent[] = [];
  readonly sentAt: number[] = [];
  readonly timers: Timer[] = [];
  readonly reports: HostRunState[] = [];
  readonly messageListeners = new Set<(message: ServerMessage) => void>();
  readonly connectionListeners = new Set<(status: ConnectionStatus) => void>();
  readonly run: HostRun;
  #nextEvent = 0;

  constructor(options: HarnessOptions = {}) {
    this.connectionStatus = options.connection ?? CONNECTED;
    const connection: HostRunConnection = {
      sendAs: (build: BuildClientEvent) => this.sendAs(build),
      onMessage: (listener) => {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
      },
      status: () => this.connectionStatus,
      onStatusChange: (listener) => {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
      },
    };
    this.run = createHostRun({
      workspaceId: WS_A,
      agentId: AGENT_ID,
      hostDeviceId: DEVICE_ID,
      runId: RUN_1,
      runState: options.runState ?? "queued",
      connection,
      ...(options.ackTimeoutMs === undefined
        ? {}
        : { ackTimeoutMs: options.ackTimeoutMs }),
      scheduleTimer: (callback, delayMs) => {
        const timer: Timer = {
          at: this.time + delayMs,
          callback,
          cancelled: false,
        };
        this.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      wallClock: () => WALL_START + this.time,
      newEventId: () => {
        this.#nextEvent += 1;
        return eventId(this.#nextEvent);
      },
      onChange: (state) => this.reports.push(state),
    });
  }

  /** Like the connection client: builds from the identity, checks, sends. */
  sendAs(build: BuildClientEvent): SendOutcome {
    if (this.identity === null) {
      return "not_connected";
    }
    let event;
    try {
      event = build(this.identity);
    } catch {
      return "invalid";
    }
    const checked = decodeClientMessage(
      JSON.parse(JSON.stringify(event)) as unknown,
    );
    if (
      !checked.ok ||
      checked.kind !== "event" ||
      checked.event.type !== "agent.run.state_changed" ||
      checked.event.deviceId !== this.identity.deviceId
    ) {
      return "invalid";
    }
    if (this.failSend !== null) {
      return this.failSend;
    }
    this.sent.push(checked.event);
    this.sentAt.push(this.time);
    return "sent";
  }

  get last(): AgentRunStateChangedEvent {
    const event = this.sent.at(-1);
    if (event === undefined) {
      throw new Error("Nothing was sent");
    }
    return event;
  }

  /** The phases that the model reported, in order. */
  phases(): string[] {
    return this.reports.map((state) => state.phase);
  }

  receive(message: ServerMessage): void {
    for (const listener of [...this.messageListeners]) {
      listener(message);
    }
  }

  /** The server relays `event` with `deviceId: null`: its acknowledgement. */
  ack(
    event: AgentRunStateChangedEvent = this.last,
    payload: Record<string, unknown> = {},
  ): void {
    const decoded = decodeServerMessage({
      ...event,
      deviceId: null,
      payload: { ...event.payload, ...payload },
    });
    if (!decoded.ok || decoded.kind !== "event") {
      throw new Error("The relayed transition does not decode");
    }
    this.receive({ kind: "event", event: decoded.event });
  }

  refuse(code: string, id: string = this.last.id): void {
    const decoded = decodeServerMessage({
      protocolVersion: 0,
      type: "event.refused",
      eventId: id,
      code,
    });
    if (!decoded.ok || decoded.kind !== "frame") {
      throw new Error("The refusal does not decode");
    }
    this.receive({ kind: "frame", frame: decoded.frame });
  }

  setConnection(status: ConnectionStatus): void {
    this.connectionStatus = status;
    for (const listener of [...this.connectionListeners]) {
      listener(status);
    }
  }

  openTimers(): Timer[] {
    return this.timers.filter((timer) => !timer.cancelled);
  }

  /** Moves the clock forward by `ms`, firing the timers that come due. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = this.openTimers()
        .filter((timer) => timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) {
        break;
      }
      due.cancelled = true;
      this.time = due.at;
      due.callback();
    }
    this.time = end;
  }

  /** Whether the model let go of the connection and of its timer. */
  released(): boolean {
    return (
      this.messageListeners.size === 0 &&
      this.connectionListeners.size === 0 &&
      this.openTimers().length === 0
    );
  }
}

/** Every close or loss of an open connection, as the client reports it. */
const CLOSES: readonly ConnectionStatus[] = [
  ...CONNECTION_WAITING_REASONS.map(waiting),
  ...CONNECTION_STOP_REASONS.map((reason): ConnectionStatus => ({
    state: "stopped",
    reason,
    revision: 2,
  })),
  CONNECTING,
];

function closeCode(status: ConnectionStatus): string {
  return "reason" in status && status.reason !== undefined
    ? status.reason
    : status.state;
}

// Transitions.

test("it sends exactly the transitions of the run lifecycle, from the run's known state", () => {
  for (const from of RUN_STATES) {
    for (const to of RUN_STATES) {
      const h = new Harness({ runState: from });
      const allowed = ALLOWED[from].includes(to);
      expect(h.run.transition(to)).toBe(allowed ? "sent" : "not_allowed");
      if (allowed) {
        expect(h.sent).toHaveLength(1);
        expect(h.last.payload).toEqual({
          runId: RUN_1,
          agentId: AGENT_ID,
          previousState: from,
          state: to,
        });
        expect(h.run.state()).toEqual({
          phase: "awaiting_ack",
          runState: from,
          unacknowledged: { previousState: from, state: to, resent: false },
          stop: null,
        });
      } else {
        // A refused transition sends nothing, reports nothing, and leaves
        // the model ready for an allowed one.
        expect(h.sent).toEqual([]);
        expect(h.reports).toEqual([]);
        expect(h.run.state().phase).toBe("idle");
      }
    }
  }
});

test("the event is the agent's, from this device, with a new ID and the wall clock when it is sent", () => {
  const h = new Harness();
  h.advance(1_500);
  expect(h.run.transition("running")).toBe("sent");
  expect(h.last).toEqual({
    protocolVersion: 0,
    id: eventId(1),
    type: "agent.run.state_changed",
    occurredAt: new Date(WALL_START + 1_500).toISOString(),
    workspaceId: WS_A,
    actor: { kind: "agent", agentId: AGENT_ID },
    deviceId: DEVICE_ID,
    payload: {
      runId: RUN_1,
      agentId: AGENT_ID,
      previousState: "queued",
      state: "running",
    },
  });
  h.ack();
  h.advance(500);
  expect(h.run.transition("failed", "The tests did not pass.")).toBe("sent");
  expect(h.last.id).toBe(eventId(2));
  expect(h.last.occurredAt).toBe(new Date(WALL_START + 2_000).toISOString());
  expect(h.last.payload.reason).toBe("The tests did not pass.");
});

test("after a terminal acknowledgement, no transition is allowed", () => {
  for (const terminal of ["completed", "failed", "cancelled"] as const) {
    const h = new Harness({ runState: "running" });
    h.run.transition(terminal);
    h.ack();
    expect(h.run.state().runState).toBe(terminal);
    for (const to of RUN_STATES) {
      expect(h.run.transition(to)).toBe("not_allowed");
    }
    expect(h.sent).toHaveLength(1);
  }
});

// Reasons.

test("the host may send any reason except the server's cancel reasons", () => {
  // The server's codes (P-60, #201), written out as well, so that a change
  // of the protocol's list shows here.
  expect([...RUN_CANCEL_REASONS]).toEqual(["member_removed", "device_revoked"]);
  for (const reason of RUN_CANCEL_REASONS) {
    for (const [from, to] of [
      ["running", "cancelled"],
      ["queued", "cancelled"],
      ["running", "failed"],
      ["awaiting_input", "running"],
    ] as const) {
      const h = new Harness({ runState: from });
      expect(h.run.transition(to, reason)).toBe("reserved_reason");
      expect(h.sent).toEqual([]);
      expect(h.reports).toEqual([]);
      // The model stays ready: the same transition without the code goes.
      expect(h.run.transition(to)).toBe("sent");
    }
  }
  // Any other reason goes, also one that only looks like a code, and also
  // on a transition that is not a cancellation.
  for (const reason of [
    "The person stopped the run.",
    "member_removed.",
    "Device_revoked",
    "cancelled",
  ]) {
    const h = new Harness({ runState: "running" });
    expect(h.run.transition("cancelled", reason)).toBe("sent");
    expect(h.last.payload.reason).toBe(reason);
  }
  const h = new Harness({ runState: "running" });
  expect(h.run.transition("awaiting_input", "Approve the push?")).toBe("sent");
});

// One in flight.

test("one transition is in flight at a time, until its acknowledgement", () => {
  const h = new Harness();
  expect(h.run.transition("running")).toBe("sent");
  // Another transition, also an allowed one, and a resend wait.
  expect(h.run.transition("failed")).toBe("busy");
  expect(h.run.transition("cancelled")).toBe("busy");
  expect(h.run.resend()).toBe("busy");
  h.advance(HOST_RUN_ACK_TIMEOUT_MS - 1);
  expect(h.run.transition("failed")).toBe("busy");
  expect(h.sent).toHaveLength(1);
  // The acknowledgement frees it, from the acknowledged state.
  h.ack();
  expect(h.run.transition("awaiting_input")).toBe("sent");
  expect(h.last.payload.previousState).toBe("running");
  // While a resend is due, a new transition waits as well.
  h.advance(HOST_RUN_ACK_TIMEOUT_MS);
  expect(h.run.state().phase).toBe("resend_due");
  expect(h.run.transition("running")).toBe("busy");
  expect(h.sent).toHaveLength(2);
});

// The acknowledgement.

test("only the relayed event with the same ID, workspace, agent, and run is the acknowledgement", () => {
  const h = new Harness();
  h.run.transition("running");
  const sent = h.last;
  h.ack({ ...sent, id: eventId(77) });
  h.ack(
    { ...sent, actor: { kind: "agent", agentId: OTHER_AGENT } },
    { agentId: OTHER_AGENT },
  );
  h.ack(sent, { runId: RUN_2 });
  h.ack({ ...sent, workspaceId: WS_B });
  // A system actor with the same ID, as a server cancellation would carry.
  h.ack(
    { ...sent, actor: { kind: "system" } },
    { previousState: "queued", state: "cancelled" },
  );
  // Built without the decoder, because no other event type carries an agent
  // actor.
  h.receive({
    kind: "event",
    event: {
      ...sent,
      deviceId: null,
      type: "workspace.project.renamed",
    } as unknown as ReceivedServerEvent,
  });
  expect(h.run.state().phase).toBe("awaiting_ack");
  expect(h.phases()).toEqual(["awaiting_ack"]);
  h.ack(sent);
  expect(h.run.state()).toEqual({
    phase: "idle",
    runState: "running",
    unacknowledged: null,
    stop: null,
  });
  expect(h.phases()).toEqual(["awaiting_ack", "idle"]);
  // The timer of the acknowledgement is gone, and a second relay of the
  // same event changes nothing.
  expect(h.openTimers()).toEqual([]);
  h.ack(sent);
  expect(h.reports).toHaveLength(2);
});

test("the run's state comes from the acknowledgement's payload, not from what was sent", () => {
  const h = new Harness({ runState: "running" });
  h.run.transition("awaiting_input");
  h.ack(h.last, { previousState: "running", state: "failed" });
  expect(h.run.state().runState).toBe("failed");
  expect(h.run.transition("running")).toBe("not_allowed");
  // Before an acknowledgement, the known state stays the start's.
  const g = new Harness({ runState: "awaiting_input" });
  g.run.transition("running");
  expect(g.run.state().runState).toBe("awaiting_input");
});

// The resend.

test("without an acknowledgement the same event is due once more, and then the model stops", () => {
  const h = new Harness();
  h.run.transition("running");
  const first = h.last;
  h.advance(HOST_RUN_ACK_TIMEOUT_MS - 1);
  expect(h.run.state().phase).toBe("awaiting_ack");
  h.advance(1);
  // Due, but only the owner sends it.
  expect(h.run.state()).toEqual({
    phase: "resend_due",
    runState: "queued",
    unacknowledged: {
      previousState: "queued",
      state: "running",
      resent: false,
    },
    stop: null,
  });
  expect(h.sent).toHaveLength(1);
  h.advance(60_000);
  expect(h.sent).toHaveLength(1);
  // The resend is the same event: the same ID and the same time.
  expect(h.run.resend()).toBe("sent");
  expect(h.sent).toHaveLength(2);
  expect(h.sent[1]).toEqual(first);
  expect(h.run.state().unacknowledged?.resent).toBe(true);
  expect(h.run.resend()).toBe("busy");
  // No acknowledgement of the resend either: it stops, and the transition
  // may have been applied.
  h.advance(HOST_RUN_ACK_TIMEOUT_MS);
  expect(h.run.state()).toEqual({
    phase: "stopped",
    runState: "queued",
    unacknowledged: {
      previousState: "queued",
      state: "running",
      resent: true,
    },
    stop: { cause: "no_acknowledgement" },
  });
  expect(h.phases()).toEqual([
    "awaiting_ack",
    "resend_due",
    "awaiting_ack",
    "stopped",
  ]);
  expect(h.released()).toBe(true);
  // Nothing more: not a late acknowledgement, a resend, or a transition.
  h.ack(first);
  expect(h.run.resend()).toBe("stopped");
  expect(h.run.transition("running")).toBe("stopped");
  h.advance(60_000);
  expect(h.sent).toHaveLength(2);
  expect(h.run.state().phase).toBe("stopped");
});

test("an acknowledgement of the resend, or a late one of the first send, frees the model", () => {
  const h = new Harness();
  h.run.transition("running");
  h.advance(HOST_RUN_ACK_TIMEOUT_MS);
  h.run.resend();
  h.ack();
  expect(h.run.state().phase).toBe("idle");
  expect(h.run.state().runState).toBe("running");
  expect(h.openTimers()).toEqual([]);

  const g = new Harness();
  g.run.transition("running");
  g.advance(HOST_RUN_ACK_TIMEOUT_MS);
  g.ack();
  expect(g.run.state().phase).toBe("idle");
  expect(g.run.resend()).toBe("busy");
  expect(g.sent).toHaveLength(1);
});

test("the timeout can be set", () => {
  const h = new Harness({ ackTimeoutMs: 3_000 });
  h.run.transition("running");
  h.advance(2_999);
  expect(h.run.state().phase).toBe("awaiting_ack");
  h.advance(1);
  expect(h.run.state().phase).toBe("resend_due");
});

// Stops.

test("a refusal of its event stops the model; the server applied nothing", () => {
  for (const code of EVENT_REFUSAL_CODES) {
    const h = new Harness();
    h.run.transition("running");
    // A refusal of another event changes nothing.
    h.refuse(code, eventId(77));
    expect(h.run.state().phase).toBe("awaiting_ack");
    h.refuse(code);
    expect(h.run.state()).toEqual({
      phase: "stopped",
      runState: "queued",
      unacknowledged: null,
      stop: { cause: "refused", code },
    });
    expect(h.released()).toBe(true);
    h.ack();
    expect(h.run.transition("running")).toBe("stopped");
    expect(h.sent).toHaveLength(1);
  }
  // Also while the resend is due, and after it.
  const h = new Harness();
  h.run.transition("running");
  h.advance(HOST_RUN_ACK_TIMEOUT_MS);
  h.refuse("conflict");
  expect(h.run.state().stop).toEqual({ cause: "refused", code: "conflict" });
  expect(h.run.resend()).toBe("stopped");
  expect(h.sent).toHaveLength(1);
});

test("any close or loss of the open connection stops the model, whether a transition waits or not", () => {
  for (const close of CLOSES) {
    for (const waits of [true, false]) {
      const h = new Harness();
      h.run.transition("running");
      if (!waits) {
        h.ack();
      }
      h.setConnection(close);
      expect(h.run.state()).toEqual({
        phase: "stopped",
        runState: waits ? "queued" : "running",
        unacknowledged: waits
          ? { previousState: "queued", state: "running", resent: false }
          : null,
        stop: { cause: "connection_closed", code: closeCode(close) },
      });
      expect(h.released()).toBe(true);
      // Nothing after the reconnect: no resend and no next transition.
      h.setConnection(CONNECTED);
      h.ack();
      h.advance(60_000);
      expect(h.run.transition("awaiting_input")).toBe("stopped");
      expect(h.sent).toHaveLength(1);
    }
  }
});

test("a sign-out stops the model, whether a transition waits or not", () => {
  for (const reason of ["not_signed_in", "no_api_origin", undefined] as const) {
    for (const waits of [true, false]) {
      const h = new Harness();
      h.run.transition("running");
      if (!waits) {
        h.ack();
      }
      h.setConnection(
        reason === undefined
          ? { state: "offline", revision: 3 }
          : { state: "offline", reason, revision: 3 },
      );
      expect(h.run.state().phase).toBe("stopped");
      expect(h.run.state().stop).toEqual({
        cause: "signed_out",
        code: reason ?? "offline",
      });
      expect(h.run.state().unacknowledged !== null).toBe(waits);
      expect(h.released()).toBe(true);
      h.setConnection(CONNECTED);
      expect(h.run.transition("awaiting_input")).toBe("stopped");
    }
  }
});

test("a connection that was not open yet changes nothing", () => {
  const h = new Harness({ connection: CONNECTING });
  h.setConnection(waiting("connection_failed"));
  h.setConnection({ state: "offline", reason: "not_signed_in", revision: 3 });
  h.setConnection(CONNECTING);
  expect(h.run.state().phase).toBe("idle");
  h.setConnection(CONNECTED);
  expect(h.run.transition("running")).toBe("sent");
  // Once it was open, its loss stops the model.
  h.setConnection(waiting("connection_lost"));
  expect(h.run.state().stop).toEqual({
    cause: "connection_closed",
    code: "connection_lost",
  });
});

test("a send that the connection client refuses stops the model", () => {
  for (const outcome of [
    "not_connected",
    "backpressure",
    "too_large",
  ] as const) {
    const h = new Harness();
    h.failSend = outcome;
    expect(h.run.transition("running")).toBe("stopped");
    expect(h.run.state()).toEqual({
      phase: "stopped",
      runState: "queued",
      unacknowledged: null,
      stop: { cause: "not_sent", code: outcome },
    });
    expect(h.released()).toBe(true);

    // A resend that does not go out: the first send may have been applied.
    const g = new Harness();
    g.run.transition("running");
    g.advance(HOST_RUN_ACK_TIMEOUT_MS);
    g.failSend = outcome;
    expect(g.run.resend()).toBe("stopped");
    expect(g.run.state().stop).toEqual({ cause: "not_sent", code: outcome });
    expect(g.run.state().unacknowledged).toEqual({
      previousState: "queued",
      state: "running",
      resent: true,
    });
  }
  // A socket of another device gets nothing: the build refuses it.
  const h = new Harness();
  h.identity = { userId: USER_ID, deviceId: OTHER_DEVICE_ID };
  expect(h.run.transition("running")).toBe("stopped");
  expect(h.run.state().stop).toEqual({ cause: "not_sent", code: "invalid" });
  expect(h.sent).toEqual([]);
});

test("close stops listening and cancels the timer, without a report", () => {
  const h = new Harness();
  h.run.transition("running");
  expect(h.openTimers()).toHaveLength(1);
  h.run.close();
  expect(h.released()).toBe(true);
  expect(h.run.state().phase).toBe("closed");
  expect(h.phases()).toEqual(["awaiting_ack"]);
  h.ack();
  h.advance(60_000);
  expect(h.run.transition("running")).toBe("stopped");
  expect(h.run.resend()).toBe("stopped");
  h.run.close();
  expect(h.sent).toHaveLength(1);

  // A stopped model stays stopped.
  const g = new Harness();
  g.run.transition("running");
  g.refuse("conflict");
  g.run.close();
  expect(g.run.state().phase).toBe("stopped");
});

test("the reported states are frozen and never hold an ID", () => {
  const h = new Harness();
  h.run.transition("running", "Started by its owner.");
  h.advance(HOST_RUN_ACK_TIMEOUT_MS);
  h.run.resend();
  h.ack();
  h.run.transition("completed");
  h.refuse("not_found");
  expect(h.reports.length).toBeGreaterThan(3);
  for (const state of h.reports) {
    expect(Object.isFrozen(state)).toBe(true);
    if (state.unacknowledged !== null) {
      expect(Object.isFrozen(state.unacknowledged)).toBe(true);
    }
  }
  expect(JSON.stringify(h.reports)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
});
