import type {
  AgentId,
  PermissionGrantId,
  UserId,
  WorkspaceId,
} from "@mymandev/protocol";
import type { RevokedGrant } from "./cascade.ts";
import {
  ERASURE_NOTIFICATION_VERSION,
  type NotificationHeader,
} from "./erasure-notifications.ts";

// The live events of an operator's account disable (#350; ADR 0014, update
// of 2026-11-25). `disableAccount` runs in the operator command, outside the
// API, like an erasure, so its transaction sends PostgreSQL notifications on
// the erasure's channel (`ERASURE_NOTIFICATION_CHANNEL`), with the erasure's
// header, version, payload bound, and sending (`src/erasure-notifications.ts`),
// and every API instance replays them through its one listener. PostgreSQL
// delivers them only when the transaction commits, none after a rollback,
// also of a savepoint, and in the order sent; delivery is at most once.
//
// A disable sets the account's `disabled_at` and revokes the active grants
// of the agents that the account owns; it disables no agent and cancels no
// run. Each notification is one item, in the order of the API's routes: the
// account first, whose open connections the API closes with `auth_failed`,
// the reason with which its sweep closes a disabled account's connections;
// then each revoked grant, in the order of their IDs, as `agent.grant.revoked`.
// A notification carries IDs, times, and codes only.
//
// The kinds are a disable's own, not the erasure's, so that the API checks
// each one against what a disable leaves (`checkErasureNotification`,
// `src/erasure-check.ts`): a disabled account, not an erased one.

/** The disabled account: the API closes the connections of its devices that are not revoked. */
export type AccountDisabledNotification =
  NotificationHeader<"account_disabled">;

/** A grant that the disable revoked: `agent.grant.revoked`. */
export type DisableGrantRevokedNotification =
  NotificationHeader<"disable_grant_revoked"> &
    Readonly<{
      workspaceId: WorkspaceId;
      grantId: PermissionGrantId;
      granteeAgentId: AgentId;
      revokedAt: string;
    }>;

export type DisableNotification =
  AccountDisabledNotification | DisableGrantRevokedNotification;

export type DisableNotificationsInput = Readonly<{
  userId: UserId;
  now: Date;
  /** The grants that the disable revoked, in the order of their IDs (`revokedGrantsOf`). */
  revokedGrants: readonly RevokedGrant[];
}>;

/**
 * The notifications of one disable, in the order in which the API's routes
 * send their events (see the top of this file): the account, then each
 * revoked grant.
 */
export function disableNotifications(
  input: DisableNotificationsInput,
): readonly DisableNotification[] {
  const header = <Kind extends DisableNotification["kind"]>(kind: Kind) =>
    ({
      v: ERASURE_NOTIFICATION_VERSION,
      kind,
      at: input.now.toISOString(),
      userId: input.userId,
    }) as const;
  return Object.freeze([
    header("account_disabled"),
    ...input.revokedGrants.map((grant): DisableGrantRevokedNotification => ({
      ...header("disable_grant_revoked"),
      workspaceId: grant.workspaceId,
      grantId: grant.grantId,
      granteeAgentId: grant.granteeAgentId,
      revokedAt: grant.revokedAt.toISOString(),
    })),
  ]);
}
