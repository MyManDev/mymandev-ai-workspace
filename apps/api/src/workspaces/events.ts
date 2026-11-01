import {
  type EventId,
  newId,
  PROTOCOL_VERSION,
  type ProtocolEvent,
  type ServerOnlyEventType,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyRequest } from "fastify";

/**
 * A membership event: a change of the people that every member of the
 * workspace must see. Only the server originates it, with a `system` actor
 * and `deviceId: null` (ADR 0014, "Protocol").
 */
export type WorkspaceEvent = Extract<
  ProtocolEvent,
  { type: ServerOnlyEventType }
>;

/**
 * Receives each membership event after the transaction that made the change
 * committed, as a frozen copy. The route does not wait for it, so a slow
 * handler never holds the answer. Until #110 delivers workspace events to
 * the members' connections, the default only logs the event type and the
 * workspace ID.
 */
export type WorkspaceEventHandler = (
  event: WorkspaceEvent,
) => void | Promise<void>;

/** The header of a membership event that the server originates at `now`. */
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
