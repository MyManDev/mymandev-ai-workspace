import type { CancelledRun } from "@mymandev/database";
import {
  type AgentRunStateChangedEvent,
  type EventId,
  type MemberId,
  newId,
  PROTOCOL_VERSION,
  type ProtocolEvent,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { AccountFrame, ConnectionRegistry } from "../gateway.ts";

/**
 * A join request event (#210, #227): `workspace.join_request.created`,
 * `workspace.join_request.resolved`, and
 * `workspace.join_request.unblocked`. Only the server originates it, with a
 * `system` actor and `deviceId: null`, and it goes only to the connections
 * subscribed to the workspace as its owner or an admin, never to every
 * member, so it is not a `WorkspaceEvent`.
 */
export type JoinRequestEvent = Extract<
  ProtocolEvent,
  { type: `workspace.join_request.${string}` }
>;

/**
 * A membership event: a change of the people that every member of the
 * workspace must see (`workspace.member.*` and
 * `workspace.ownership.transferred`). Only the server originates it, with a
 * `system` actor and `deviceId: null` (ADR 0014, "Protocol"). The project
 * events `workspace.project.created` and `workspace.project.renamed` (#155)
 * share the type and its delivery. Other events that only the server
 * originates, such as `chat.message.created`, are not membership events, and
 * neither are the join request events, which only the owner and admins get.
 */
export type WorkspaceEvent = Exclude<
  Extract<ProtocolEvent, { type: `workspace.${string}` }>,
  JoinRequestEvent
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

/**
 * Receives each join request event after the transaction that made the
 * change committed, as a frozen copy, with the workspace's owner and admins
 * as that transaction read them (`joinRequestApprovers`). The route does not
 * wait for it.
 */
export type ApproverEventHandler = (
  event: JoinRequestEvent,
  approvers: readonly MemberId[],
) => void | Promise<void>;

/**
 * Delivers a join request event only to the connections subscribed to its
 * workspace as one of `approvers`, the owner and admins that the change's
 * transaction read (#210): never to a member, to the requester, or to a
 * connection subscribed to another workspace. Logs the event type, the
 * workspace ID, and the number of connections at debug level.
 */
export function deliverApproverEvent(
  connections: ConnectionRegistry,
  event: JoinRequestEvent,
  approvers: readonly MemberId[],
  log: FastifyBaseLogger,
): void {
  const sent = connections.sendToPeople(event, approvers);
  log.debug(
    { eventType: event.type, workspaceId: event.workspaceId, sent },
    "join request event",
  );
}

/**
 * The event that tells a workspace's members that a device revocation or a
 * removal cancelled a run (ADR 0014, "Removal and ownership"; P-60): a
 * `system` actor, `deviceId: null`, and the reason code stored with the run,
 * `device_revoked` or `member_removed`, with the run's correlation ID and
 * repository when it has them.
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
      reason: run.reason,
    },
  };
}

/**
 * Sends each run that a committed device revocation or removal cancelled as
 * `agent.run.state_changed` to the connections subscribed to the run's
 * workspace, and to no one else. After a revocation, the caller closes the
 * revoked device's connection first; after a removal, the removed person's
 * subscriptions end first.
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
export function frozenCopy<T extends WorkspaceEvent | JoinRequestEvent>(
  event: T,
): T {
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

/**
 * Hands a frozen copy of a join request event and of its approvers to
 * `handler` without waiting for it, as `sendWorkspaceEvent` does: the change
 * is already committed, so a failure is only logged, with the event type,
 * the workspace ID, and the error's type, never its message.
 */
export function sendApproverEvent(
  request: FastifyRequest,
  handler: ApproverEventHandler,
  event: JoinRequestEvent,
  approvers: readonly MemberId[],
): void {
  const copy = frozenCopy(event);
  const people = Object.freeze([...approvers]);
  const failed = (error: unknown) => {
    request.log.error(
      {
        eventType: copy.type,
        workspaceId: copy.workspaceId,
        errorType: error instanceof Error ? error.name : typeof error,
      },
      "join request event failed",
    );
  };
  try {
    Promise.resolve(handler(copy, people)).catch(failed);
  } catch (error) {
    failed(error);
  }
}

/**
 * Receives an account frame for the open connections of one account, after
 * the transaction that made the change committed. `buildApp` connects it to
 * the gateway's `ConnectionRegistry.sendToUser`, which sends the frame at
 * once and never waits.
 */
export type AccountFrameHandler = (userId: UserId, frame: AccountFrame) => void;

/**
 * Hands an account frame to `handler`. The change is already committed, so a
 * failure is only logged, with the frame type and the error's type and never
 * the error's message.
 */
export function sendAccountFrame(
  request: FastifyRequest,
  handler: AccountFrameHandler,
  userId: UserId,
  frame: AccountFrame,
): void {
  try {
    handler(userId, frame);
  } catch (error) {
    request.log.error(
      {
        frameType: frame.type,
        errorType: error instanceof Error ? error.name : typeof error,
      },
      "account frame failed",
    );
  }
}
