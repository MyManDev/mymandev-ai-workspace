import type { DeviceId, MemberId, UserId } from "@mymandev/protocol";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import type { OperatorNotification } from "./erasure-notifications.ts";

// The API's check of an erasure's notification against the database (#341;
// Project Manager decision of 2026-11-25). PostgreSQL lets any role that can
// connect to the database send on the erasure's channel, so a payload alone
// proves nothing: a forged `account_erased` would close a living account's
// connections with `device_revoked`, which makes its desktops delete their
// device keys and stop their agents. Before the API replays a notification,
// one read-only statement without a lock checks that the account that it
// names is erased (every identity of the account has `erased_at`, which only
// `eraseAccount` sets and nothing clears) and that its item is in the state
// that the erasure left it in, linked to that account as the erasure's
// removals and device revocations select their rows (an agent's host device
// always belongs to the agent's owner, and a grant's to its agent's host):
//
// - `account_erased`: the account's devices that are revoked, the only
//   connections that the API closes, as its 60-second sweep would;
// - `membership_ended`: the account's person in the workspace, removed;
// - `agent_disabled`: the account's agent of that project and workspace,
//   disabled, whose owner is the named owner's person there;
// - `grant_revoked`: the grant of that workspace to that agent of the
//   account, revoked;
// - `run_cancelled`: the run of that agent, project, and workspace,
//   cancelled, whose agent the account owns or which the account requested;
// - `join_request_withdrawn`: the account's request in the workspace,
//   withdrawn; and of the named approvers, the ones that are still an
//   active owner or admin of the workspace (`joinRequestApprovers`).
//
// The times, the previous state, and the reason of a notification are not
// checked, and nothing tells a first delivery from a repeat: a role that
// can connect can still send a real erasure's notification again, or with
// those fields changed. Nor does the check tell whether the erasure itself
// ended the item: an item of the erased account that ended before the
// erasure, such as a person removed earlier, passes too, and can be
// replayed as a stale event about that account. A role that can connect can
// forge nothing about an account that is not erased, or about an item of
// another account.
//
// The notifications of an operator's account disable (#350,
// `src/disable-notifications.ts`) travel on the same channel and are checked
// by the same function, against what a disable leaves: the account that a
// notification names must be disabled (`users.disabled_at` is set), and
//
// - `account_disabled`: the account's devices that are not revoked, whose
//   connections the API closes with `auth_failed`, as its sweep would;
// - `disable_grant_revoked`: the grant of that workspace to that agent of
//   the account, revoked by the account at the time of the disable (the
//   disable writes the account as `revoked_by_user_id` and its `now` as both
//   `revoked_at` and `disabled_at`), so a grant that ended at another time,
//   or by someone else, does not pass; the equality also requires that the
//   account is disabled, as a null `disabled_at` equals nothing.
//
// A role that can connect can forge nothing about an account that is not
// disabled, or about an item of another account. It can resend a real
// disable's notifications: `account_disabled` closes only connections that
// the sweep would close anyway, and a grant of the latest disable is sent
// again as revoked. A disable confirms none of an erasure's kinds. An erased
// account is disabled too, so a disable's kinds about it can pass:
// `account_disabled` closes nothing, as every device of an erased account is
// revoked, and a grant that the erasure revoked when it set `disabled_at`
// is sent again as revoked, as the erasure's own notification says.

/** What the database confirms of one notification. */
export type ErasureCheck = Readonly<{
  /**
   * Whether the account is erased, or disabled for a disable's kinds, and
   * the item is as the erasure or the disable left it.
   */
  confirmed: boolean;
  /**
   * For a confirmed `account_erased`: the account's revoked devices, in the
   * order of their IDs. Otherwise empty.
   */
  revokedDeviceIds: readonly DeviceId[];
  /**
   * For a confirmed `account_disabled`: the account's devices that are not
   * revoked, in the order of their IDs. Otherwise empty.
   */
  disabledAccountDeviceIds: readonly DeviceId[];
  /**
   * For a confirmed `join_request_withdrawn`: the named approvers that are
   * still an active owner or admin of the workspace, in the order of their
   * IDs. Otherwise empty.
   */
  approvers: readonly MemberId[];
}>;

/** Whether every identity of the account is erased; false for an account without one. */
function erased(userId: UserId): SQL {
  return sql`coalesce((select bool_and(i.erased_at is not null) from user_identities i where i.user_id = ${userId}::uuid), false)`;
}

/** Whether the account is disabled; false for an account that does not exist. */
function disabled(userId: UserId): SQL {
  return sql`coalesce((select u.disabled_at is not null from users u where u.id = ${userId}::uuid), false)`;
}

/** The statement that checks the notification; it returns one row. */
function statementOf(notification: OperatorNotification): SQL {
  const { userId } = notification;
  switch (notification.kind) {
    case "account_erased":
      return sql`select ${erased(userId)} as confirmed, array(select d.id::text from devices d where d.user_id = ${userId}::uuid and d.revoked_at is not null order by d.id) as ids`;
    case "membership_ended":
      return sql`select ${erased(userId)} and exists (select 1 from workspace_members m where m.id = ${notification.memberId}::uuid and m.workspace_id = ${notification.workspaceId}::uuid and m.user_id = ${userId}::uuid and m.removed_at is not null) as confirmed`;
    case "agent_disabled":
      return sql`select ${erased(userId)} and exists (select 1 from agents a join projects p on p.id = a.project_id join workspace_members o on o.id = ${notification.ownerMemberId}::uuid and o.workspace_id = p.workspace_id and o.user_id = a.owner_user_id where a.id = ${notification.agentId}::uuid and a.project_id = ${notification.projectId}::uuid and p.workspace_id = ${notification.workspaceId}::uuid and a.owner_user_id = ${userId}::uuid and a.disabled_at is not null) as confirmed`;
    case "grant_revoked":
      return sql`select ${erased(userId)} and exists (select 1 from permission_grants g join projects p on p.id = g.project_id join agents a on a.id = g.grantee_agent_id where g.id = ${notification.grantId}::uuid and g.grantee_agent_id = ${notification.granteeAgentId}::uuid and p.workspace_id = ${notification.workspaceId}::uuid and a.owner_user_id = ${userId}::uuid and g.revoked_at is not null) as confirmed`;
    case "run_cancelled":
      return sql`select ${erased(userId)} and exists (select 1 from agent_runs r join projects p on p.id = r.project_id join agents a on a.id = r.agent_id where r.id = ${notification.runId}::uuid and r.agent_id = ${notification.agentId}::uuid and r.project_id = ${notification.projectId}::uuid and p.workspace_id = ${notification.workspaceId}::uuid and r.state = 'cancelled' and (a.owner_user_id = ${userId}::uuid or r.requested_by_user_id = ${userId}::uuid)) as confirmed`;
    case "join_request_withdrawn":
      return sql`select ${erased(userId)} and exists (select 1 from workspace_join_requests j where j.id = ${notification.joinRequestId}::uuid and j.workspace_id = ${notification.workspaceId}::uuid and j.requester_user_id = ${userId}::uuid and j.decision = 'withdrawn') as confirmed, array(select m.id::text from workspace_members m where m.id = any(${sql.param(notification.approvers)}::uuid[]) and m.workspace_id = ${notification.workspaceId}::uuid and m.removed_at is null and m.role in ('owner', 'admin') order by m.id) as ids`;
    case "account_disabled":
      return sql`select ${disabled(userId)} as confirmed, array(select d.id::text from devices d where d.user_id = ${userId}::uuid and d.revoked_at is null order by d.id) as ids`;
    case "disable_grant_revoked":
      return sql`select exists (select 1 from users u join agents a on a.owner_user_id = u.id join permission_grants g on g.grantee_agent_id = a.id join projects p on p.id = g.project_id where u.id = ${userId}::uuid and g.id = ${notification.grantId}::uuid and g.grantee_agent_id = ${notification.granteeAgentId}::uuid and p.workspace_id = ${notification.workspaceId}::uuid and g.revoked_by_user_id = u.id and g.revoked_at = u.disabled_at) as confirmed`;
  }
}

/**
 * Checks one notification of an erasure or a disable against the database,
 * with one read-only statement that locks nothing (see the top of this
 * file). The caller replays only a confirmed notification, and for
 * `account_erased` closes only the connections of `revokedDeviceIds`, for
 * `account_disabled` only those of `disabledAccountDeviceIds`, and for
 * `join_request_withdrawn` sends only to `approvers`.
 */
export async function checkErasureNotification(
  db: Database,
  notification: OperatorNotification,
): Promise<ErasureCheck> {
  return withDatabaseErrors(async () => {
    // node-postgres and PGlite both return the rows as `rows`.
    const { rows } = (await db.execute(statementOf(notification))) as {
      rows: readonly Readonly<{
        confirmed: boolean | null;
        ids?: readonly string[] | null;
      }>[];
    };
    const confirmed = rows[0]?.confirmed === true;
    const ids = confirmed ? [...(rows[0]?.ids ?? [])] : [];
    return Object.freeze({
      confirmed,
      revokedDeviceIds: Object.freeze(
        notification.kind === "account_erased" ? (ids as DeviceId[]) : [],
      ),
      disabledAccountDeviceIds: Object.freeze(
        notification.kind === "account_disabled" ? (ids as DeviceId[]) : [],
      ),
      approvers: Object.freeze(
        notification.kind === "join_request_withdrawn"
          ? (ids as MemberId[])
          : [],
      ),
    });
  });
}
