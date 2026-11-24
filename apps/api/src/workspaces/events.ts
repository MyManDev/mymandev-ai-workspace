import type {
  CancelledRun,
  DisabledAgent,
  RevokedGrant,
} from "@mymandev/database";
import {
  type AgentGrantCreatedEvent,
  type AgentGrantRevokedEvent,
  type AgentListItem,
  type AgentRunStateChangedEvent,
  type ApproverEventType,
  type EventId,
  type MemberId,
  newId,
  type PermissionGrant,
  PROTOCOL_VERSION,
  type ProtocolEvent,
  type UserId,
  type WorkspaceGrant,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { AccountFrame, ConnectionRegistry } from "../gateway.ts";

/**
 * An event whose audience is the workspace's owner and admins, one of
 * `APPROVER_EVENT_TYPES` (#232): today the join request events (#210,
 * #227), `workspace.join_request.created`, `workspace.join_request.resolved`,
 * and `workspace.join_request.unblocked`. Only the server originates it,
 * with a `system` actor and `deviceId: null`, and it goes only to the
 * connections subscribed to the workspace as its owner or an admin, never to
 * every member, so it is not a `WorkspaceEvent`, whatever its name.
 */
export type ApproverEvent = Extract<ProtocolEvent, { type: ApproverEventType }>;

/**
 * A membership event: a change of the people that every member of the
 * workspace must see (`workspace.member.*` and
 * `workspace.ownership.transferred`). Only the server originates it, with a
 * `system` actor and `deviceId: null` (ADR 0014, "Protocol"). The project
 * events `workspace.project.created` and `workspace.project.renamed` (#155),
 * the repository events `workspace.repository.registered` and
 * `workspace.repository.removed` (#286), and the agent events
 * `workspace.agent.created` and `workspace.agent.disabled` (#294) share the
 * type and its delivery.
 * Other events that only the server originates, such as
 * `chat.message.created`, are not membership events, and neither are the
 * events of `APPROVER_EVENT_TYPES` (`ApproverEvent`), which only the owner
 * and admins get.
 */
export type WorkspaceEvent = Exclude<
  Extract<ProtocolEvent, { type: `workspace.${string}` }>,
  ApproverEvent
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
  event: ApproverEvent,
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
  event: ApproverEvent,
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
 * The agent as every member reads it in `workspace.agent.created` and
 * `workspace.agent.disabled` (#294), and the base of the creation's answer,
 * built field by field, so that a field that the database result gains
 * later is not sent to the members until it is added here. It never holds
 * the host device (#110), which only the agent's own account reads, in the
 * agent list and in the creation's answer (#342).
 */
export function workspaceAgent(agent: AgentListItem): AgentListItem {
  return {
    id: agent.id,
    projectId: agent.projectId,
    name: agent.name,
    ownerMemberId: agent.ownerMemberId,
    disabledAt: agent.disabledAt,
  };
}

/** `workspace.agent.disabled`, the membership event of a disabled agent. */
export type AgentDisabledEvent = Extract<
  WorkspaceEvent,
  { type: "workspace.agent.disabled" }
>;

/**
 * `workspace.agent.disabled` for an agent that a change disabled (#294,
 * #326): a `system` actor, `deviceId: null`, the agent's workspace, and the
 * agent as the agent list shows it (`workspaceAgent`), never its host
 * device. The agent route and the cascades send the same payload.
 */
export function agentDisabledEvent(
  disabled: DisabledAgent,
  now: Date,
): AgentDisabledEvent {
  return {
    ...serverEventHeader(disabled.workspaceId, now),
    type: "workspace.agent.disabled",
    payload: { agent: workspaceAgent(disabled.agent) },
  };
}

/**
 * Sends each agent that a committed device revocation, a sign-in that
 * replaced a device, a removal, or a departure disabled as
 * `workspace.agent.disabled` through `handler`, the membership event
 * delivery, to the connections subscribed to the agent's own workspace and
 * to no one else (`members` in `SERVER_EVENT_AUDIENCES`; #326): one event
 * per agent, in the order of the agent IDs. A change that spans workspaces,
 * such as a device revocation, tells each workspace of its own agents only,
 * as `sendRevokedGrants` does with grants. Each goes as
 * `sendWorkspaceEvent` sends one, so a failure is logged and neither fails
 * the committed change's answer nor keeps the events after it from being
 * sent. The caller sends them before the grant and run events of the same
 * change, as the agent route does; after a revocation it closes the revoked
 * device's connection first, and after a removal the removed person's
 * subscriptions end first.
 */
export function sendDisabledAgents(
  request: FastifyRequest,
  handler: WorkspaceEventHandler,
  agents: readonly DisabledAgent[],
  now: Date,
): void {
  for (const agent of agents) {
    sendWorkspaceEvent(request, handler, agentDisabledEvent(agent, now));
  }
}

/**
 * The event that tells a workspace's members that a device revocation, a
 * removal, or an agent's disabling cancelled a run (ADR 0014, "Removal and
 * ownership"; P-60; #294): a `system` actor, `deviceId: null`, and the
 * reason code stored with the run, `device_revoked`, `member_removed`, or
 * `agent_disabled`, with the run's correlation ID and
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
 * Sends each run that a committed device revocation, removal, or disabling
 * of an agent cancelled as
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

/**
 * A grant as the members of its workspace see it in `agent.grant.created`
 * (`WorkspaceGrant`, #75), built field by field from the whole grant, so that
 * neither the granting account, the revocation fields, nor the provider
 * connection of a `provider.use` grant, which is device data (#110), reaches
 * the members, also when the grant gains a field later.
 */
export function workspaceGrant(grant: PermissionGrant): WorkspaceGrant {
  const header = {
    id: grant.id,
    projectId: grant.projectId,
    granteeAgentId: grant.granteeAgentId,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
  };
  return grant.capability === "provider.use"
    ? { ...header, capability: grant.capability }
    : {
        ...header,
        capability: grant.capability,
        repositoryId: grant.repositoryId,
      };
}

/** `agent.grant.created` for a new grant of the workspace's agent (#75). */
export function grantCreatedEvent(
  workspaceId: WorkspaceId,
  grant: PermissionGrant,
  now: Date,
): AgentGrantCreatedEvent {
  return {
    ...serverEventHeader(workspaceId, now),
    type: "agent.grant.created",
    payload: { grant: workspaceGrant(grant) },
  };
}

/**
 * `agent.grant.revoked` for one grant that a change revoked (#75; ADR 0015,
 * P-77): the grant, its agent, and the time that the server stored as
 * `revoked_at`, without who revoked it or why.
 */
export function grantRevokedEvent(
  grant: RevokedGrant,
  now: Date,
): AgentGrantRevokedEvent {
  return {
    ...serverEventHeader(grant.workspaceId, now),
    type: "agent.grant.revoked",
    payload: {
      grantId: grant.grantId,
      granteeAgentId: grant.granteeAgentId,
      revokedAt: grant.revokedAt.toISOString(),
    },
  };
}

/**
 * Sends grant events, in the order given, to the connections subscribed to
 * each event's workspace (`members` in `SERVER_EVENT_AUDIENCES`). The change
 * is committed, so a failure to tell the subscribers never fails the answer
 * or stops the events after it; it is only logged, with the event type, the
 * workspace ID, and the error's type.
 */
export function sendGrantEvents(
  log: FastifyBaseLogger,
  connections: ConnectionRegistry,
  events: readonly (AgentGrantCreatedEvent | AgentGrantRevokedEvent)[],
): void {
  for (const event of events) {
    try {
      const sent = connections.sendToWorkspace(event);
      log.debug(
        { eventType: event.type, workspaceId: event.workspaceId, sent },
        "grant event",
      );
    } catch (error) {
      log.error(
        {
          eventType: event.type,
          workspaceId: event.workspaceId,
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "grant event failed",
      );
    }
  }
}

/**
 * Sends each grant that a committed change revoked as `agent.grant.revoked`
 * to the connections subscribed to the grant's workspace, and to no one else
 * (`members` in `SERVER_EVENT_AUDIENCES`; #75, ADR 0015 update of
 * 2026-11-14): one event per grant, in the order of the grant IDs. A change
 * that spans workspaces, such as a device revocation, tells each workspace
 * of its own grants only, as `sendCancelledRuns` does with runs. Each event
 * is sent as the grant routes send theirs (`sendGrantEvents`), so a failure
 * is logged and neither fails the committed change's answer nor keeps the
 * events after it, such as the cancelled runs, from being sent.
 */
export function sendRevokedGrants(
  log: FastifyBaseLogger,
  connections: ConnectionRegistry,
  grants: readonly RevokedGrant[],
  now: Date,
): void {
  sendGrantEvents(
    log,
    connections,
    grants.map((grant) => grantRevokedEvent(grant, now)),
  );
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
export function frozenCopy<T extends WorkspaceEvent | ApproverEvent>(
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
  event: ApproverEvent,
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
