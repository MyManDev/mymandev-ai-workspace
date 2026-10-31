import {
  type DeviceId,
  newUuidV7,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { AuditAction } from "./audit-vocabulary.ts";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import { auditEvents, devices, workspaceMembers } from "./schema/index.ts";

// Queries of the WebSocket gateway (ADR 0014, "Device key and
// authentication"; ADR 0006, identity binding).

export type ActiveMemberInput = Readonly<{
  workspaceId: WorkspaceId;
  userId: UserId;
}>;

/**
 * Whether the account is an active member of the workspace: it has claimed a
 * person there whose `removed_at` is empty (ADR 0014, "People and roles"). A
 * workspace that does not exist gives false, like one without the account.
 */
export async function isActiveMember(
  db: Database,
  input: ActiveMemberInput,
): Promise<boolean> {
  return withDatabaseErrors(async () => {
    const rows = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.userId),
          isNull(workspaceMembers.removedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}

export type DeviceSeenInput = Readonly<{ deviceId: DeviceId; now: Date }>;

/** Records that a device was seen now: it authenticated a WebSocket connection. */
export async function markDeviceSeen(
  db: Database,
  input: DeviceSeenInput,
): Promise<void> {
  await withDatabaseErrors(() =>
    db
      .update(devices)
      .set({ lastSeenAt: input.now, updatedAt: input.now })
      .where(eq(devices.id, input.deviceId)),
  );
}

/** The audit actions of an authenticated WebSocket connection. */
export type ConnectionAuditAction = Extract<
  AuditAction,
  "connection.replaced" | "event.identity_mismatch"
>;

export type ConnectionAuditInput = Readonly<{
  action: ConnectionAuditAction;
  /** The connection's account and device, which its key proved. */
  userId: UserId;
  deviceId: DeviceId;
  /**
   * The affected item: the device for `connection.replaced`, the event ID
   * for `event.identity_mismatch`. A label without a foreign key.
   */
  subjectId: string;
  now: Date;
}>;

/**
 * Writes an audit record for an authenticated connection, with the
 * connection's account and device as the actor. It never writes a workspace:
 * the workspace of a refused event is unverified, and
 * `audit_events.workspace_id` is a foreign key.
 */
export async function writeConnectionAudit(
  db: Database,
  input: ConnectionAuditInput,
): Promise<void> {
  await withDatabaseErrors(() =>
    db.insert(auditEvents).values({
      id: newUuidV7(),
      createdAt: input.now,
      action: input.action,
      actorUserId: input.userId,
      actorDeviceId: input.deviceId,
      subjectId: input.subjectId,
    }),
  );
}
