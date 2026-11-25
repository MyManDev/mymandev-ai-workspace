import type { DeviceId, MemberId, UserId } from "@mymandev/protocol";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import type { ErasureNotification } from "./erasure-notifications.ts";

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
// those fields changed, but nothing about an account that is not erased or
// an item that its erasure did not change.

/** What the database confirms of one notification. */
export type ErasureCheck = Readonly<{
  /** Whether the account is erased and the item is as the erasure left it. */
  confirmed: boolean;
  /**
   * For a confirmed `account_erased`: the account's revoked devices, in the
   * order of their IDs. Otherwise empty.
   */
  revokedDeviceIds: readonly DeviceId[];
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

/** The statement that checks the notification; it returns one row. */
function statementOf(notification: ErasureNotification): SQL {
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
  }
}

/**
 * Checks one notification of an erasure against the database, with one
 * read-only statement that locks nothing (see the top of this file). The
 * caller replays only a confirmed notification, and for `account_erased`
 * closes only the connections of `revokedDeviceIds`, and for
 * `join_request_withdrawn` sends only to `approvers`.
 */
export async function checkErasureNotification(
  db: Database,
  notification: ErasureNotification,
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
      approvers: Object.freeze(
        notification.kind === "join_request_withdrawn"
          ? (ids as MemberId[])
          : [],
      ),
    });
  });
}
