import type { CancelledRun } from "@mymandev/database";
import {
  type AgentRunStateChangedEvent,
  type EventId,
  newId,
  PROTOCOL_VERSION,
  type ProtocolEvent,
  type RunCancelReason,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { ConnectionRegistry } from "../gateway.ts";

/**
 * A membership event: a change of the people that every member of the
 * workspace must see (`workspace.member.*` and
 * `workspace.ownership.transferred`). Only the server originates it, with a
 * `system` actor and `deviceId: null` (ADR 0014, "Protocol"). Other events
 * that only the server originates, such as `chat.message.created`, are not
 * membership events.
 */
export type WorkspaceEvent = Extract<
  ProtocolEvent,
  { type: `workspace.${string}` }
>;

/**
 * Receives each membership event after the transaction that made the change
 * committed, as a frozen copy. The route does not wait for it, so a slow
 * handler never holds the answer.
 */
export type WorkspaceEventHandler = (
  event: WorkspaceEvent,
) => void | Promise<void>;

/**
 * Delivers a membership event to the connections subscribed to its
 * workspace (#110). A removed person's subscriptions end first, with
 * `workspace.unsubscribed` and `membership_ended`, so the removed account
 * gets no more events of the workspace, and the other subscribers see the
 * person go offline before the event. Logs the event type, the workspace
 * ID, and the number of connections at debug level.
 */
export function deliverWorkspaceEvent(
  connections: ConnectionRegistry,
  event: WorkspaceEvent,
  log: FastifyBaseLogger,
): void {
  if (event.type === "workspace.member.removed") {
    connections.endMembership(event.workspaceId, event.payload.memberId);
  }
  const sent = connections.sendToWorkspace(event);
  log.debug(
    { eventType: event.type, workspaceId: event.workspaceId, sent },
    "workspace event",
  );
}

/** The reason code of a run that a device revocation cancelled (ADR 0014, P-60). */
const DEVICE_REVOKED: RunCancelReason = "device_revoked";

/**
 * The event that tells a workspace's members that a device revocation
 * cancelled a run (ADR 0014, "Removal and ownership"; P-60): a `system`
 * actor, `deviceId: null`, and the reason code `device_revoked`, with the
 * run's correlation ID and repository when it has them.
 */
export function cancelledRunEvent(
  run: CancelledRun,
  now: Date,
): AgentRunStateChangedEvent {
  return {
    ...serverEventHeader(run.workspaceId, now),
    ...(run.correlationId === null ? {} : { correlationId: run.correlationId }),
    type: "agent.run.state_changed",
    payload: {
      runId: run.runId,
      agentId: run.agentId,
      ...(run.repositoryId === null ? {} : { repositoryId: run.repositoryId }),
      previousState: run.previousState,
      state: "cancelled",
      reason: DEVICE_REVOKED,
    },
  };
}

/**
 * Sends each run that a committed device revocation cancelled as
 * `agent.run.state_changed` to the connections subscribed to the run's
 * workspace, and to no one else. The caller closes the revoked device's
 * connection first.
 */
export function sendCancelledRuns(
  connections: ConnectionRegistry,
  runs: readonly CancelledRun[],
  now: Date,
): void {
  for (const run of runs) {
    connections.sendToWorkspace(cancelledRunEvent(run, now));
  }
}

/** The header of an event that the server originates at `now`. */
export function serverEventHeader(workspaceId: WorkspaceId, now: Date) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: newId<EventId>(),
    occurredAt: now.toISOString(),
    workspaceId,
    actor: { kind: "system" },
    deviceId: null,
  } as const;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * A deeply frozen copy of an event, so that the event handler shares no
 * object with the HTTP answer and cannot change it.
 */
export function frozenCopy(event: WorkspaceEvent): WorkspaceEvent {
  return deepFreeze(structuredClone(event));
}

/**
 * Hands a frozen copy of a membership event to `handler` without waiting for
 * it: the change is already committed, so a handler that never returns
 * cannot hold the answer, and a failure is only logged. The log names the
 * error's type and never its message, which may quote a display name.
 */
export function sendWorkspaceEvent(
  request: FastifyRequest,
  handler: WorkspaceEventHandler,
  event: WorkspaceEvent,
): void {
  const copy = frozenCopy(event);
  const failed = (error: unknown) => {
    request.log.error(
      {
        eventType: copy.type,
        workspaceId: copy.workspaceId,
        errorType: error instanceof Error ? error.name : typeof error,
      },
      "workspace event failed",
    );
  };
  try {
    Promise.resolve(handler(copy)).catch(failed);
  } catch (error) {
    failed(error);
  }
}
