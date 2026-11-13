// The model of a run that this device hosts (#35, first part; ADR 0007 and
// its updates of 2026-11-02 and 2026-11-06): it sends the run's transitions
// as the run's agent, from the agent's host device, over the real
// connection, and keeps the run's state from the server's acknowledgements.
// It neither creates nor executes a run; its owner decides which transition
// comes next and when.
//
// - Before a send, it checks the transition with the protocol's
//   `canTransition` from the run's known state, and the reason with the
//   protocol's `runReasonAllowed`: a code of `RUN_CANCEL_REASONS` comes only
//   from the server, which would refuse it with `conflict`.
// - One transition is in flight at a time. It waits for its acknowledgement,
//   the relayed transition with the same event ID, workspace, agent, and
//   run; the acknowledgement's payload is the run's state from then on.
// - Without an acknowledgement within the timeout, the same event, with the
//   same event ID and time, is due once more, which the server never applies
//   twice. The owner sends it with `resend` when its own guards allow. Without
//   an acknowledgement of the resend, the model stops.
// - It stops for good at a refusal of its event, at a send that the
//   connection client refuses, at any close or loss of the open connection,
//   and at a sign-out (the client's own close for the account, `offline`).
//   A stopped model sends nothing more; the owner makes a new one when it
//   wants to go on.
//
// Every change goes to the owner's `onChange`. The model never logs, and
// its state holds codes, never an ID.
import {
  canTransition,
  newId,
  PROTOCOL_VERSION,
  runReasonAllowed,
  type AgentId,
  type AgentRunStateChangedEvent,
  type DeviceId,
  type EventId,
  type EventRefusalCode,
  type RunId,
  type RunState,
  type WorkspaceId,
} from "@mymandev/protocol";
import type {
  ConnectionClient,
  SendOutcome,
  ServerMessage,
} from "../connection/client.ts";
import type { ConnectionStatus } from "../../shared/ipc-contract.ts";
import type { ScheduleTimer } from "../runtime.ts";

/** How long a send waits for its acknowledgement by default. */
export const HOST_RUN_ACK_TIMEOUT_MS = 10_000;

/** The part of the connection client that the model uses. */
export type HostRunConnection = Pick<
  ConnectionClient,
  "sendAs" | "onMessage" | "status" | "onStatusChange"
>;

/**
 * Where the model is:
 *
 * - `idle`: nothing waits; `transition` may send.
 * - `awaiting_ack`: a transition was sent and waits for its acknowledgement.
 * - `resend_due`: its acknowledgement timed out, and `resend` sends it once
 *   more.
 * - `stopped`: it stopped for good, for the reason in `stop`.
 * - `closed`: its owner closed it.
 */
export type HostRunPhase =
  "idle" | "awaiting_ack" | "resend_due" | "stopped" | "closed";

/**
 * Why the model stopped. `code` is a refusal code, a send outcome, or a
 * connection reason (the connection's state when it has none).
 */
export type HostRunStop =
  | { readonly cause: "refused"; readonly code: EventRefusalCode }
  | { readonly cause: "no_acknowledgement" }
  | {
      readonly cause: "not_sent";
      readonly code: Exclude<SendOutcome, "sent">;
    }
  | { readonly cause: "connection_closed"; readonly code: string }
  | { readonly cause: "signed_out"; readonly code: string };

/** A sent transition without an acknowledgement. */
export interface HostRunUnacknowledged {
  readonly previousState: RunState;
  readonly state: RunState;
  /** Whether it was sent a second time. */
  readonly resent: boolean;
}

export interface HostRunState {
  readonly phase: HostRunPhase;
  /** The run's state as the start or the last acknowledgement reported it. */
  readonly runState: RunState;
  /**
   * The transition that was sent and not acknowledged: in flight, due to be
   * sent again, or, after a stop or a close, one that the server may have
   * applied. Null when nothing waits, and after a refusal, because the
   * server applied nothing.
   */
  readonly unacknowledged: HostRunUnacknowledged | null;
  /** Why it stopped; null unless `phase` is `stopped`. */
  readonly stop: HostRunStop | null;
}

/**
 * What `transition` and `resend` did: `sent`; `busy` while a transition
 * waits for its acknowledgement (or, for `resend`, when nothing is due);
 * `not_allowed` when `canTransition` refuses the transition from the run's
 * known state; `reserved_reason` for a reason that only the server gives;
 * `stopped` when the model is stopped or closed, also when this send made
 * it stop.
 */
export type HostRunSendResult =
  "sent" | "busy" | "not_allowed" | "reserved_reason" | "stopped";

export interface HostRunOptions {
  readonly workspaceId: WorkspaceId;
  readonly agentId: AgentId;
  /** The device that hosts the agent; the model sends only from it. */
  readonly hostDeviceId: DeviceId;
  readonly runId: RunId;
  /** The run's state when the model starts, from the agent activity. */
  readonly runState: RunState;
  readonly connection: HostRunConnection;
  /** Defaults to `HOST_RUN_ACK_TIMEOUT_MS`. */
  readonly ackTimeoutMs?: number;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** The wall clock in milliseconds, for `occurredAt`; defaults to `Date.now`. */
  readonly wallClock?: () => number;
  /** Defaults to a new UUIDv7. */
  readonly newEventId?: () => EventId;
  /**
   * Called synchronously after every change of the state, except a close
   * by the owner: a send, a resend, a timeout, an acknowledgement, and a
   * stop.
   */
  readonly onChange?: (state: HostRunState) => void;
}

export interface HostRun {
  readonly runId: RunId;
  /** The current state, frozen. */
  readonly state: () => HostRunState;
  /**
   * Sends the transition from the run's known state to `to`, with `reason`
   * if given, unless the model refuses it (`HostRunSendResult`). The event
   * gets a new event ID and the wall clock as `occurredAt`.
   */
  readonly transition: (to: RunState, reason?: string) => HostRunSendResult;
  /** Sends the transition whose acknowledgement timed out once more. */
  readonly resend: () => HostRunSendResult;
  /**
   * Stops listening and cancels the timer, without a report; the phase
   * becomes `closed`. A stopped model stays `stopped`.
   */
  readonly close: () => void;
}

/** A transition that the agent's host device sends. */
type Transition = Omit<AgentRunStateChangedEvent, "deviceId">;

interface Pending {
  readonly transition: Transition;
  readonly previousState: RunState;
  readonly state: RunState;
  resent: boolean;
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export function createHostRun(options: HostRunOptions): HostRun {
  const { workspaceId, agentId, hostDeviceId, runId, connection } = options;
  const ackTimeoutMs = options.ackTimeoutMs ?? HOST_RUN_ACK_TIMEOUT_MS;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const wallClock = options.wallClock ?? (() => Date.now());
  const newEventId = options.newEventId ?? (() => newId<EventId>());

  let phase: HostRunPhase = "idle";
  let runState: RunState = options.runState;
  let pending: Pending | null = null;
  let stopReason: HostRunStop | null = null;
  let cancelAck: (() => void) | null = null;
  /** Whether the connection's last status was `connected`. */
  let connected = connection.status().state === "connected";
  let current = snapshot();

  function snapshot(): HostRunState {
    return Object.freeze({
      phase,
      runState,
      unacknowledged:
        pending === null
          ? null
          : Object.freeze({
              previousState: pending.previousState,
              state: pending.state,
              resent: pending.resent,
            }),
      stop: stopReason,
    });
  }

  function changed(): void {
    current = snapshot();
    options.onChange?.(current);
  }

  function ended(): boolean {
    return phase === "stopped" || phase === "closed";
  }

  function stopTimer(): void {
    cancelAck?.();
    cancelAck = null;
  }

  function release(): void {
    stopTimer();
    for (const remove of removers.splice(0)) {
      remove();
    }
  }

  function stop(reason: HostRunStop): void {
    if (ended()) {
      return;
    }
    phase = "stopped";
    stopReason = Object.freeze(reason);
    if (reason.cause === "refused") {
      // The server applied nothing.
      pending = null;
    }
    release();
    changed();
  }

  /** Sends `sent` on the connection and waits for its acknowledgement. */
  function transmit(sent: Pending): HostRunSendResult {
    const outcome = connection.sendAs((identity) => {
      // The server closes the connection for an agent that another device
      // hosts, so the identity of the socket is checked as well.
      if (identity.deviceId !== hostDeviceId) {
        throw new Error("This device does not host the agent.");
      }
      return { ...sent.transition, deviceId: identity.deviceId };
    });
    if (outcome !== "sent") {
      if (!sent.resent) {
        // The first send did not go out: nothing waits.
        pending = null;
      }
      stop({ cause: "not_sent", code: outcome });
      return "stopped";
    }
    phase = "awaiting_ack";
    cancelAck = schedule(() => {
      cancelAck = null;
      acknowledgementTimedOut();
    }, ackTimeoutMs);
    changed();
    return "sent";
  }

  function transition(to: RunState, reason?: string): HostRunSendResult {
    if (ended()) {
      return "stopped";
    }
    if (phase !== "idle") {
      return "busy";
    }
    if (!canTransition(runState, to)) {
      return "not_allowed";
    }
    const actor = Object.freeze({ kind: "agent" as const, agentId });
    const payload: Transition["payload"] = Object.freeze({
      runId,
      agentId,
      previousState: runState,
      state: to,
      ...(reason === undefined ? {} : { reason }),
    });
    if (!runReasonAllowed({ actor, payload })) {
      return "reserved_reason";
    }
    // The event gets its ID and its time only when it is sent.
    pending = {
      transition: Object.freeze({
        protocolVersion: PROTOCOL_VERSION,
        id: newEventId(),
        type: "agent.run.state_changed",
        occurredAt: new Date(wallClock()).toISOString(),
        workspaceId,
        actor,
        payload,
      }),
      previousState: runState,
      state: to,
      resent: false,
    };
    return transmit(pending);
  }

  function resend(): HostRunSendResult {
    if (ended()) {
      return "stopped";
    }
    if (phase !== "resend_due" || pending === null) {
      return "busy";
    }
    pending.resent = true;
    return transmit(pending);
  }

  function acknowledgementTimedOut(): void {
    if (ended() || pending === null) {
      return;
    }
    if (pending.resent) {
      stop({ cause: "no_acknowledgement" });
      return;
    }
    phase = "resend_due";
    changed();
  }

  function messageReceived(message: ServerMessage): void {
    if (ended() || pending === null) {
      return;
    }
    const sent = pending.transition;
    if (message.kind === "frame") {
      if (
        message.frame.type === "event.refused" &&
        message.frame.eventId === sent.id
      ) {
        stop({ cause: "refused", code: message.frame.code });
      }
      return;
    }
    const event = message.event;
    if (
      event.type !== "agent.run.state_changed" ||
      event.id !== sent.id ||
      event.workspaceId !== sent.workspaceId ||
      event.actor.kind !== "agent" ||
      event.actor.agentId !== agentId ||
      event.payload.runId !== runId
    ) {
      return;
    }
    // The acknowledgement, also of the first send while the resend is due:
    // its payload is the run's state from now on, not what was sent.
    runState = event.payload.state;
    pending = null;
    phase = "idle";
    stopTimer();
    changed();
  }

  /**
   * Any close or loss of the open connection stops the model, whether a
   * transition waits or not: a close of the server, which the client
   * reports as `waiting` or `stopped`, and the client's own close and
   * reopen, which it reports as `connecting`. `offline` is the client's
   * close for the account (a sign-out, a removal, a key that is not ready,
   * or no API origin). A connection that was not open yet changes nothing.
   */
  function connectionChanged(status: ConnectionStatus): void {
    const wasConnected = connected;
    connected = status.state === "connected";
    if (ended() || !wasConnected || connected) {
      return;
    }
    const code =
      "reason" in status && status.reason !== undefined
        ? status.reason
        : status.state;
    stop(
      status.state === "offline"
        ? { cause: "signed_out", code }
        : { cause: "connection_closed", code },
    );
  }

  const removers = [
    connection.onStatusChange((status) => connectionChanged(status)),
    connection.onMessage((message) => messageReceived(message)),
  ];

  return Object.freeze({
    runId,
    state: () => current,
    transition,
    resend,
    close: () => {
      if (ended()) {
        // A stopped model has already let go of everything.
        return;
      }
      phase = "closed";
      release();
      current = snapshot();
    },
  });
}
