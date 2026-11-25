import {
  APPROVERS_PER_NOTIFICATION,
  ERASED_AGENT_NAME,
  ERASURE_NOTIFICATION_VERSION,
  type ErasureNotification,
} from "@mymandev/database";
import {
  AgentIdSchema,
  CorrelationIdSchema,
  JoinRequestIdSchema,
  MemberIdSchema,
  PermissionGrantIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunCancelReasonSchema,
  RunIdSchema,
  UserIdSchema,
  UtcTimestampSchema,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import type { ConnectionRegistry } from "../gateway.ts";
import {
  type AccountFrameHandler,
  type ApproverEventHandler,
  sendCancelledRuns,
  sendDisabledAgents,
  sendJoinRequestResolved,
  sendMemberRemoved,
  sendRevokedGrants,
  type WorkspaceEventHandler,
} from "./events.ts";

// The API's side of an operator's account erasure (#341; ADR 0014, update of
// 2026-11-25): each notification that the erasure's transaction sent
// (`src/erasure-notifications.ts` in `@mymandev/database`) is checked and
// replayed through the senders of the API's own routes, so that every
// connection gets what a removal, a device revocation, or a withdrawal
// through the API would have sent it.

const header = <Kind extends string>(kind: Kind) => ({
  v: z.literal(ERASURE_NOTIFICATION_VERSION),
  kind: z.literal(kind),
  at: UtcTimestampSchema,
});

/** Every notification of the version that this API reads, and nothing else. */
const ErasureNotificationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...header("account_erased"), userId: UserIdSchema }),
  z.strictObject({
    ...header("membership_ended"),
    workspaceId: WorkspaceIdSchema,
    memberId: MemberIdSchema,
    userId: UserIdSchema,
  }),
  z.strictObject({
    ...header("agent_disabled"),
    workspaceId: WorkspaceIdSchema,
    agentId: AgentIdSchema,
    projectId: ProjectIdSchema,
    ownerMemberId: MemberIdSchema,
    disabledAt: UtcTimestampSchema,
  }),
  z.strictObject({
    ...header("grant_revoked"),
    workspaceId: WorkspaceIdSchema,
    grantId: PermissionGrantIdSchema,
    granteeAgentId: AgentIdSchema,
    revokedAt: UtcTimestampSchema,
  }),
  z.strictObject({
    ...header("run_cancelled"),
    workspaceId: WorkspaceIdSchema,
    runId: RunIdSchema,
    agentId: AgentIdSchema,
    projectId: ProjectIdSchema,
    repositoryId: RepositoryIdSchema.nullable(),
    correlationId: CorrelationIdSchema.nullable(),
    previousState: z.enum(["queued", "running", "awaiting_input"]),
    reason: RunCancelReasonSchema,
  }),
  z.strictObject({
    ...header("join_request_withdrawn"),
    workspaceId: WorkspaceIdSchema,
    joinRequestId: JoinRequestIdSchema,
    approvers: z.array(MemberIdSchema).min(1).max(APPROVERS_PER_NOTIFICATION),
  }),
]) satisfies z.ZodType<ErasureNotification>;

/** Why a payload was not replayed. */
export type IgnoredReason = "malformed" | "unknown_version" | "unknown_kind";

const KINDS: ReadonlySet<unknown> = new Set<ErasureNotification["kind"]>([
  "account_erased",
  "membership_ended",
  "agent_disabled",
  "grant_revoked",
  "run_cancelled",
  "join_request_withdrawn",
]);

/**
 * The notification in `payload`, or why it is ignored: a payload that is
 * not JSON or breaks the schema is `malformed`; one of another version,
 * such as one from a newer operator command, is `unknown_version`; one of a
 * kind that this API does not know is `unknown_kind`.
 */
export function decodeErasureNotification(
  payload: string,
):
  | Readonly<{ ok: true; notification: ErasureNotification }>
  | Readonly<{ ok: false; reason: IgnoredReason }> {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, reason: "malformed" };
  }
  if (!("v" in json) || json.v !== ERASURE_NOTIFICATION_VERSION) {
    return { ok: false, reason: "unknown_version" };
  }
  if (!("kind" in json) || !KINDS.has(json.kind)) {
    return { ok: false, reason: "unknown_kind" };
  }
  const parsed = ErasureNotificationSchema.safeParse(json);
  return parsed.success
    ? { ok: true, notification: parsed.data }
    : { ok: false, reason: "malformed" };
}

/** Where the replayed events go: the same handlers as the routes'. */
export type ErasureReplayTargets = Readonly<{
  connections: ConnectionRegistry;
  onWorkspaceEvent: WorkspaceEventHandler;
  onApproverEvent: ApproverEventHandler;
  onAccountFrame: AccountFrameHandler;
  log: FastifyBaseLogger;
}>;

/**
 * Replays one notification of an erasure, as the route that makes the same
 * change sends its events, with the erasure's time as the events' time:
 *
 * - `account_erased` closes every open connection of the account at once,
 *   with `device_revoked`, the reason with which the sweep would close it
 *   within 60 seconds, as every device of the account is revoked; that ends
 *   its subscriptions, and the other subscribers see its people go offline;
 * - `membership_ended` sends `workspace.member.removed` and
 *   `account.removed_from_workspace` (`sendMemberRemoved`), as a removal;
 * - `agent_disabled` sends `workspace.agent.disabled`, with
 *   `ERASED_AGENT_NAME`, which the erasure gave every agent of the account,
 *   as a removal or a device revocation (`sendDisabledAgents`);
 * - `grant_revoked` sends `agent.grant.revoked` (`sendRevokedGrants`);
 * - `run_cancelled` sends `agent.run.state_changed` (`sendCancelledRuns`);
 * - `join_request_withdrawn` sends `workspace.join_request.resolved` with
 *   the outcome `withdrawn` to the approvers that it names
 *   (`sendJoinRequestResolved`), as a withdrawal.
 *
 * A payload that `decodeErasureNotification` refuses is logged with the
 * reason only, never its content, and changes nothing. Returns whether it
 * was replayed.
 */
export function replayErasureNotification(
  targets: ErasureReplayTargets,
  payload: string,
): boolean {
  const decoded = decodeErasureNotification(payload);
  if (!decoded.ok) {
    targets.log.warn(
      { reason: decoded.reason },
      "erasure notification ignored",
    );
    return false;
  }
  const { notification } = decoded;
  const at = new Date(notification.at);
  const logged = { log: targets.log };
  switch (notification.kind) {
    case "account_erased":
      targets.connections.closeUser(
        notification.userId,
        "device_revoked",
        targets.log,
      );
      break;
    case "membership_ended":
      sendMemberRemoved(logged, targets, notification, at);
      break;
    case "agent_disabled":
      sendDisabledAgents(
        logged,
        targets.onWorkspaceEvent,
        [
          {
            workspaceId: notification.workspaceId,
            agent: {
              id: notification.agentId,
              projectId: notification.projectId,
              name: ERASED_AGENT_NAME,
              ownerMemberId: notification.ownerMemberId,
              disabledAt: notification.disabledAt,
            },
          },
        ],
        at,
      );
      break;
    case "grant_revoked":
      sendRevokedGrants(
        targets.log,
        targets.connections,
        [
          {
            grantId: notification.grantId,
            granteeAgentId: notification.granteeAgentId,
            workspaceId: notification.workspaceId,
            revokedAt: new Date(notification.revokedAt),
          },
        ],
        at,
      );
      break;
    case "run_cancelled":
      sendCancelledRuns(
        targets.connections,
        [
          {
            runId: notification.runId,
            agentId: notification.agentId,
            projectId: notification.projectId,
            workspaceId: notification.workspaceId,
            repositoryId: notification.repositoryId,
            correlationId: notification.correlationId,
            previousState: notification.previousState,
            reason: notification.reason,
          },
        ],
        at,
      );
      break;
    case "join_request_withdrawn":
      sendJoinRequestResolved(logged, targets.onApproverEvent, {
        workspaceId: notification.workspaceId,
        joinRequestId: notification.joinRequestId,
        outcome: "withdrawn",
        now: at,
        approvers: notification.approvers,
      });
      break;
  }
  return true;
}
