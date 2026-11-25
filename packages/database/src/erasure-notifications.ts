import type {
  AgentId,
  CorrelationId,
  JoinRequestId,
  MemberId,
  PermissionGrantId,
  ProjectId,
  RepositoryId,
  RunCancelReason,
  RunId,
  UserId,
  WorkspaceId,
} from "@mymandev/protocol";
import { sql } from "drizzle-orm";
import type {
  CancelledRun,
  DisabledAgent,
  RevokedGrant,
  UnfinishedRunState,
} from "./cascade.ts";
import type { Database } from "./db.ts";

// The live events of an operator's account erasure (#341; ADR 0014, update
// of 2026-11-25). The erasure runs in the operator command, outside the API,
// so its transaction sends PostgreSQL notifications (`pg_notify`) on one
// channel, and every API instance that listens (`NotificationSession`)
// replays them with the event builders of its own routes. PostgreSQL
// delivers them only when the transaction commits, none after a rollback,
// also of a savepoint, and in the order sent. Delivery is at most once: a
// listener whose session is down at the commit misses them, and its
// connections see the change when they next load the workspace, as before.
//
// Each notification is one item, in the order of the API's routes: the
// account first, whose open connections the API closes; then each ended
// membership with its disabled agents, revoked grants, and cancelled runs,
// as a removal sends them; then each revoked device's disabled agents,
// revoked grants, and cancelled runs, as a device revocation sends them;
// last, each withdrawn join request with the workspace's owner and admins.
// A notification carries IDs, times, and codes only: no display name, no
// agent name (the API fills in `ERASED_AGENT_NAME`, which every agent of an
// erased account has), no label, and no message body. Nothing about an
// archived workspace is sent, as there is nobody left in it to tell.

/** The channel of the erasure's notifications; a fixed, lowercase SQL identifier. */
export const ERASURE_NOTIFICATION_CHANNEL = "mymandev_account_erasure";

/** The version of the payload; a listener ignores any other. */
export const ERASURE_NOTIFICATION_VERSION = 1;

/**
 * The largest payload in bytes. PostgreSQL refuses a payload of 8000 bytes
 * or more in its default configuration (`pg_notify`), which would abort the
 * erasure.
 */
export const MAX_NOTIFICATION_PAYLOAD_BYTES = 7_999;

/**
 * The most approvers that one notification of a withdrawn join request
 * names. A workspace can have more owners and admins than fit in one
 * payload, so a withdrawal is split into notifications of at most this many
 * approvers each; each approver is named in exactly one of them. 100 IDs of
 * 39 bytes each, with quotes and a comma, make a payload of about 4,100
 * bytes, about half of the bound.
 */
export const APPROVERS_PER_NOTIFICATION = 100;

type Header<Kind extends string> = Readonly<{
  v: typeof ERASURE_NOTIFICATION_VERSION;
  kind: Kind;
  /** The erasure's `now`, in UTC with milliseconds: the time of every event. */
  at: string;
}>;

/** The erased account: the API closes its open connections at once. */
export type AccountErasedNotification = Header<"account_erased"> &
  Readonly<{ userId: UserId }>;

/** An ended membership: `workspace.member.removed` and `account.removed_from_workspace`. */
export type MembershipEndedNotification = Header<"membership_ended"> &
  Readonly<{ workspaceId: WorkspaceId; memberId: MemberId; userId: UserId }>;

/** A disabled agent: `workspace.agent.disabled`, with `ERASED_AGENT_NAME` as its name. */
export type AgentDisabledNotification = Header<"agent_disabled"> &
  Readonly<{
    workspaceId: WorkspaceId;
    agentId: AgentId;
    projectId: ProjectId;
    ownerMemberId: MemberId;
    disabledAt: string;
  }>;

/** A revoked grant: `agent.grant.revoked`. */
export type GrantRevokedNotification = Header<"grant_revoked"> &
  Readonly<{
    workspaceId: WorkspaceId;
    grantId: PermissionGrantId;
    granteeAgentId: AgentId;
    revokedAt: string;
  }>;

/** A cancelled run: `agent.run.state_changed`. */
export type RunCancelledNotification = Header<"run_cancelled"> &
  Readonly<{
    workspaceId: WorkspaceId;
    runId: RunId;
    agentId: AgentId;
    projectId: ProjectId;
    repositoryId: RepositoryId | null;
    correlationId: CorrelationId | null;
    previousState: UnfinishedRunState;
    reason: RunCancelReason;
  }>;

/**
 * A withdrawn join request: `workspace.join_request.resolved` with the
 * outcome `withdrawn`, to these owners and admins of the workspace, as the
 * erasure's transaction read them last.
 */
export type JoinRequestWithdrawnNotification =
  Header<"join_request_withdrawn"> &
    Readonly<{
      workspaceId: WorkspaceId;
      joinRequestId: JoinRequestId;
      approvers: readonly MemberId[];
    }>;

export type ErasureNotification =
  | AccountErasedNotification
  | MembershipEndedNotification
  | AgentDisabledNotification
  | GrantRevokedNotification
  | RunCancelledNotification
  | JoinRequestWithdrawnNotification;

/** An ended membership as the notifications need it. */
export type NotifiedMembership = Readonly<{
  workspaceId: WorkspaceId;
  memberId: MemberId;
  disabledAgents: readonly DisabledAgent[];
  revokedGrants: readonly RevokedGrant[];
  cancelledRuns: readonly CancelledRun[];
}>;

/** A revoked device's cascade as the notifications need it. */
export type NotifiedDevice = Readonly<{
  disabledAgents: readonly DisabledAgent[];
  revokedGrants: readonly RevokedGrant[];
  cancelledRuns: readonly CancelledRun[];
}>;

/** A withdrawn join request with the workspace's owner and admins. */
export type NotifiedWithdrawal = Readonly<{
  workspaceId: WorkspaceId;
  joinRequestId: JoinRequestId;
  approvers: readonly MemberId[];
}>;

export type ErasureNotificationsInput = Readonly<{
  userId: UserId;
  now: Date;
  /** In the order of the person IDs. */
  endedMemberships: readonly NotifiedMembership[];
  /** In the order of the device IDs. */
  revokedDevices: readonly NotifiedDevice[];
  /** In the order of their IDs. */
  withdrawnJoinRequests: readonly NotifiedWithdrawal[];
  /** The workspaces that the erasure archived; nothing about them is sent. */
  archivedWorkspaceIds: readonly WorkspaceId[];
}>;

/**
 * The notifications of one erasure, in the order in which the API's routes
 * send their events (see the top of this file), leaving out everything in
 * an archived workspace and every withdrawn request without an approver.
 */
export function erasureNotifications(
  input: ErasureNotificationsInput,
): readonly ErasureNotification[] {
  const at = input.now.toISOString();
  const header = <Kind extends ErasureNotification["kind"]>(kind: Kind) =>
    ({ v: ERASURE_NOTIFICATION_VERSION, kind, at }) as const;
  const archived: ReadonlySet<WorkspaceId> = new Set(
    input.archivedWorkspaceIds,
  );
  const live = <T extends Readonly<{ workspaceId: WorkspaceId }>>(
    items: readonly T[],
  ) => items.filter((item) => !archived.has(item.workspaceId));
  const notifications: ErasureNotification[] = [
    { ...header("account_erased"), userId: input.userId },
  ];
  const cascade = (change: NotifiedDevice) => {
    for (const { workspaceId, agent } of live(change.disabledAgents)) {
      notifications.push({
        ...header("agent_disabled"),
        workspaceId,
        agentId: agent.id,
        projectId: agent.projectId,
        ownerMemberId: agent.ownerMemberId,
        disabledAt: requiredTime(agent.disabledAt),
      });
    }
    for (const grant of live(change.revokedGrants)) {
      notifications.push({
        ...header("grant_revoked"),
        workspaceId: grant.workspaceId,
        grantId: grant.grantId,
        granteeAgentId: grant.granteeAgentId,
        revokedAt: grant.revokedAt.toISOString(),
      });
    }
    for (const run of live(change.cancelledRuns)) {
      notifications.push({
        ...header("run_cancelled"),
        workspaceId: run.workspaceId,
        runId: run.runId,
        agentId: run.agentId,
        projectId: run.projectId,
        repositoryId: run.repositoryId,
        correlationId: run.correlationId,
        previousState: run.previousState,
        reason: run.reason,
      });
    }
  };
  for (const membership of live(input.endedMemberships)) {
    notifications.push({
      ...header("membership_ended"),
      workspaceId: membership.workspaceId,
      memberId: membership.memberId,
      userId: input.userId,
    });
    cascade(membership);
  }
  for (const device of input.revokedDevices) {
    cascade(device);
  }
  for (const withdrawal of live(input.withdrawnJoinRequests)) {
    for (
      let start = 0;
      start < withdrawal.approvers.length;
      start += APPROVERS_PER_NOTIFICATION
    ) {
      notifications.push({
        ...header("join_request_withdrawn"),
        workspaceId: withdrawal.workspaceId,
        joinRequestId: withdrawal.joinRequestId,
        approvers: withdrawal.approvers.slice(
          start,
          start + APPROVERS_PER_NOTIFICATION,
        ),
      });
    }
  }
  return Object.freeze(notifications);
}

/** A disabled agent read after its disabling always has its time. */
function requiredTime(value: string | null): string {
  if (value === null) {
    throw new Error("Invariant broken: a disabled agent has no disabledAt");
  }
  return value;
}

/**
 * The notification as its payload: JSON, at most
 * `MAX_NOTIFICATION_PAYLOAD_BYTES` bytes. Every notification is far below
 * the bound; one above it breaks that invariant and throws, so that the
 * erasure rolls back rather than lose its events in a refused `pg_notify`.
 */
export function encodeErasureNotification(
  notification: ErasureNotification,
): string {
  const payload = JSON.stringify(notification);
  if (Buffer.byteLength(payload, "utf8") > MAX_NOTIFICATION_PAYLOAD_BYTES) {
    throw new Error(
      `Invariant broken: a ${notification.kind} notification is over ${MAX_NOTIFICATION_PAYLOAD_BYTES} bytes`,
    );
  }
  return payload;
}

/**
 * Sends the notifications in one statement, in their order, on
 * `ERASURE_NOTIFICATION_CHANNEL`. Inside the erasure's transaction they are
 * delivered only at its commit. The payloads travel as one array parameter,
 * which `unnest` reads in order.
 */
export async function sendErasureNotifications(
  tx: Database,
  notifications: readonly ErasureNotification[],
): Promise<void> {
  if (notifications.length === 0) {
    return;
  }
  const payloads = notifications.map(encodeErasureNotification);
  await tx.execute(
    sql`select pg_notify(${ERASURE_NOTIFICATION_CHANNEL}, payload) from unnest(${sql.param(payloads)}::text[]) with ordinality as sent(payload, position) order by position`,
  );
}
