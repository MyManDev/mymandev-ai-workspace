import type { DeviceId, UserId, WorkspaceId } from "@mymandev/protocol";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AuditAction, AuditReason } from "../audit-vocabulary.ts";
import { createdAt } from "./columns.ts";
import { devices, users } from "./identity.ts";
import { workspaces } from "./workspaces.ts";

/**
 * A minimal audit record (P-61): IDs and closed vocabularies only, no secret
 * and no human-entered text. The M3 audit trail (#37) extends it. Records stay,
 * because nothing is deleted (P-62).
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    createdAt: createdAt(),
    action: text("action").notNull().$type<AuditAction>(),
    /** Empty for an action of the server or an operator. */
    actorUserId: uuid("actor_user_id")
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    actorDeviceId: uuid("actor_device_id").$type<DeviceId>(),
    workspaceId: uuid("workspace_id")
      .$type<WorkspaceId>()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    /** The ID of the affected row; a label, deliberately without a foreign key. */
    subjectId: uuid("subject_id"),
    reason: text("reason").$type<AuditReason>(),
    /** `X-GitHub-Delivery` of a processed webhook, so a redelivery is recognized. */
    githubDeliveryId: text("github_delivery_id"),
  },
  (t) => [
    index("audit_events_workspace_id_idx").on(t.workspaceId),
    uniqueIndex("audit_events_github_delivery_id_key")
      .on(t.githubDeliveryId)
      .where(sql`${t.githubDeliveryId} is not null`),
    check(
      "audit_events_action_check",
      sql`${t.action} in ('account.signed_in', 'device.registered', 'device.key_replaced', 'device.signed_out', 'device.revoked', 'account.registration_locked', 'account.registration_lock_lifted', 'connection.replaced', 'github.authorization_revoked', 'event.identity_mismatch', 'account.disabled', 'account.enabled', 'account.erased', 'workspace.created', 'member.defined', 'member.renamed', 'member.claimed', 'member.removed', 'member.left', 'member.promoted', 'member.demoted', 'ownership.offered', 'ownership.offer_withdrawn', 'ownership.transferred', 'invitation.created', 'invitation.accepted', 'invitation.revoked', 'join_request.created', 'join_request.approved', 'join_request.denied', 'join_request.blocked', 'join_request.unblocked', 'join_request.withdrawn', 'join_requests.paused', 'join_requests.resumed')`,
    ),
    check(
      "audit_events_reason_check",
      sql`${t.reason} in ('removed', 'lost', 'replaced', 'account_erased', 'creator_demoted', 'member_removed')`,
    ),
    // A device acts only together with its account, so the composite key below applies.
    check(
      "audit_events_actor_device_check",
      sql`${t.actorDeviceId} is null or ${t.actorUserId} is not null`,
    ),
    // The acting device belongs to the acting account.
    foreignKey({
      name: "audit_events_actor_device_user_fk",
      columns: [t.actorDeviceId, t.actorUserId],
      foreignColumns: [devices.id, devices.userId],
    }).onDelete("restrict"),
  ],
);
