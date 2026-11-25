import {
  APPROVERS_PER_NOTIFICATION,
  ERASED_AGENT_NAME,
  type ErasureCheck,
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
// (`src/erasure-notifications.ts` in `@mymandev/database`) is decoded,
// checked against the database (`checkErasureNotification`, Project Manager
// decision of 2026-11-25), because any role that can connect to the
// database can send one, and replayed through the senders of the API's own
// routes, so that every connection gets what a removal, a device
// revocation, or a withdrawal through the API would have sent it.

const header = <Kind extends string>(kind: Kind) => ({
  v: z.literal(ERASURE_NOTIFICATION_VERSION),
  kind: z.literal(kind),
  at: UtcTimestampSchema,
  userId: UserIdSchema,
});

/** Every notification of the version that this API reads, and nothing else. */
const ErasureNotificationSchema = z.discriminatedUnion("kind", [
  z.strictObject(header("account_erased")),
  z.strictObject({
    ...header("membership_ended"),
    workspaceId: WorkspaceIdSchema,
    memberId: MemberIdSchema,
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

/** Why a payload was not decoded. */
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
 * Replays one notification of an erasure that the database confirmed
 * (`check`), as the route that makes the same change sends its events,
 * with the erasure's time as the events' time:
 *
 * - `account_erased` closes the open connections of the account's revoked
 *   devices (`check.revokedDeviceIds`) at once, with `device_revoked`, the
 *   reason with which the sweep would close them within 60 seconds; that
 *   ends their subscriptions, and the other subscribers see its people go
 *   offline;
 * - `membership_ended` sends `workspace.member.removed` and
 *   `account.removed_from_workspace` (`sendMemberRemoved`), as a removal;
 * - `agent_disabled` sends `workspace.agent.disabled`, with
 *   `ERASED_AGENT_NAME`, which the erasure gave every agent of the account,
 *   as a removal or a device revocation (`sendDisabledAgents`);
 * - `grant_revoked` sends `agent.grant.revoked` (`sendRevokedGrants`);
 * - `run_cancelled` sends `agent.run.state_changed` (`sendCancelledRuns`);
 * - `join_request_withdrawn` sends `workspace.join_request.resolved` with
 *   the outcome `withdrawn`, as a withdrawal, to the approvers that it names
 *   and that are still an owner or admin (`check.approvers`), if any
 *   (`sendJoinRequestResolved`).
 */
export function replayErasureNotification(
  targets: ErasureReplayTargets,
  notification: ErasureNotification,
  check: ErasureCheck,
): void {
  const at = new Date(notification.at);
  const logged = { log: targets.log };
  switch (notification.kind) {
    case "account_erased":
      for (const deviceId of check.revokedDeviceIds) {
        targets.connections.closeDevice(
          deviceId,
          "device_revoked",
          targets.log,
        );
      }
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
      if (check.approvers.length > 0) {
        sendJoinRequestResolved(logged, targets.onApproverEvent, {
          workspaceId: notification.workspaceId,
          joinRequestId: notification.joinRequestId,
          outcome: "withdrawn",
          now: at,
          approvers: check.approvers,
        });
      }
      break;
  }
}

/** The most notifications that wait for their check; more are dropped. */
export const MAX_PENDING_ERASURE_NOTIFICATIONS = 10_000;

export type ErasureReplayOptions = ErasureReplayTargets &
  Readonly<{
    /** Checks a notification against the database (`checkErasureNotification`). */
    check: (notification: ErasureNotification) => Promise<ErasureCheck>;
    /** Default: `MAX_PENDING_ERASURE_NOTIFICATIONS`. */
    maxPending?: number;
  }>;

/** The error's type for a log line, never its message. */
function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The API instance's replay of the erasure's notifications, one payload at
 * a time and in the order of delivery: each payload is decoded
 * (`decodeErasureNotification`), checked against the database (`check`,
 * one read-only statement without a lock), and replayed
 * (`replayErasureNotification`) only when the database confirms that its
 * account is erased and its item is as the erasure left it. Otherwise it is
 * dropped and logged with the reason only, never its content or an ID:
 * `malformed`, `unknown_version`, or `unknown_kind` from the decoding,
 * `not_confirmed` when the database does not confirm it, for example a
 * notification that another role forged for an account that is not erased,
 * and `backlog` when `maxPending` notifications already wait for their
 * check. A check that fails is logged with the error's type, and its
 * notification is dropped, as delivery is at most once anyway.
 */
export class ErasureReplay {
  readonly #options: ErasureReplayOptions;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(options: ErasureReplayOptions) {
    this.#options = options;
  }

  /** Queues one payload; it never throws. */
  push(payload: string): void {
    const { log } = this.#options;
    const decoded = decodeErasureNotification(payload);
    if (!decoded.ok) {
      log.warn({ reason: decoded.reason }, "erasure notification ignored");
      return;
    }
    const max = this.#options.maxPending ?? MAX_PENDING_ERASURE_NOTIFICATIONS;
    if (this.#pending >= max) {
      log.warn({ reason: "backlog" }, "erasure notification ignored");
      return;
    }
    this.#pending += 1;
    this.#tail = this.#tail.then(async () => {
      try {
        await this.#replay(decoded.notification);
      } finally {
        this.#pending -= 1;
      }
    });
  }

  /** Resolves once every queued payload is checked and replayed or dropped. */
  idle(): Promise<void> {
    return this.#tail;
  }

  async #replay(notification: ErasureNotification): Promise<void> {
    const { log } = this.#options;
    let check: ErasureCheck;
    try {
      check = await this.#options.check(notification);
    } catch (error) {
      log.error(
        { errorType: errorTypeOf(error) },
        "erasure notification check failed",
      );
      return;
    }
    if (!check.confirmed) {
      log.warn({ reason: "not_confirmed" }, "erasure notification ignored");
      return;
    }
    try {
      replayErasureNotification(this.#options, notification, check);
    } catch (error) {
      log.error(
        { errorType: errorTypeOf(error) },
        "erasure notification failed",
      );
    }
  }
}
