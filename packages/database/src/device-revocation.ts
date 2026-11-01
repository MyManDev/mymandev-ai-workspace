import {
  type AgentId,
  type DeviceId,
  type DeviceRevocationReason,
  newUuidV7,
  type PermissionGrantId,
  type UserId,
} from "@mymandev/protocol";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  type CancelledRun,
  cancelRuns,
  disableAgents,
  revokeGrants,
} from "./cascade.ts";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import {
  agentRuns,
  agents,
  auditEvents,
  devices,
  permissionGrants,
} from "./schema/index.ts";

export type { CancelledRun, UnfinishedRunState } from "./cascade.ts";

export type RevokeDeviceInput = Readonly<{
  deviceId: DeviceId;
  /** The account that owns the device; it is recorded as `revoked_by_user_id` of the grants (ADR 0015, P-77). */
  userId: UserId;
  reason: DeviceRevocationReason;
  now: Date;
  /** Who acted, for the audit record: the account and its device, or null for an operator. */
  actorUserId: UserId | null;
  actorDeviceId: DeviceId | null;
}>;

export type RevokeDeviceResult = Readonly<{
  /** False when the device does not exist, belongs to another account, or was already revoked. */
  revoked: boolean;
  /** In the order of their IDs. */
  disabledAgentIds: readonly AgentId[];
  /** In the order of their IDs. */
  revokedGrantIds: readonly PermissionGrantId[];
  /** In the order of their run IDs, each with the reason `device_revoked`. */
  cancelledRuns: readonly CancelledRun[];
}>;

const NOTHING: RevokeDeviceResult = Object.freeze({
  revoked: false,
  disabledAgentIds: Object.freeze([]),
  revokedGrantIds: Object.freeze([]),
  cancelledRuns: Object.freeze([]),
});

/**
 * Revokes a device in one transaction (ADR 0014, "Revocation, sign-out, and
 * recovery"): sets `revoked_at` and `revocation_reason`, disables the agents
 * that the device hosts, revokes the active grants on the device with the
 * account as `revoked_by_user_id`, moves the unfinished runs of those agents
 * to `cancelled` with the reason code `device_revoked`, and writes an audit
 * record. Inside another transaction it runs as a savepoint. Revoking a
 * revoked device changes nothing, because a revoked device never comes back.
 *
 * After the device, it locks the agents, then the grants, then the runs,
 * each `FOR NO KEY UPDATE` and in the order of their IDs (`src/cascade.ts`),
 * as removing a person does, so the two cannot deadlock. The caller closes
 * the device's socket and sends the run events after the commit; the
 * server's `system` actor is the author of those events (P-60).
 */
export async function revokeDevice(
  db: Database,
  input: RevokeDeviceInput,
): Promise<RevokeDeviceResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx) => {
      const revoked = await tx
        .update(devices)
        .set({
          revokedAt: input.now,
          revocationReason: input.reason,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(devices.id, input.deviceId),
            eq(devices.userId, input.userId),
            isNull(devices.revokedAt),
          ),
        )
        .returning({ id: devices.id });
      if (revoked.length === 0) {
        return NOTHING;
      }

      const disabled = await disableAgents(
        tx,
        eq(agents.hostDeviceId, input.deviceId),
        input.now,
      );
      const grants = await revokeGrants(
        tx,
        eq(permissionGrants.hostDeviceId, input.deviceId),
        input.userId,
        input.now,
      );
      const hosted = tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.hostDeviceId, input.deviceId));
      const cancelled = await cancelRuns(
        tx,
        inArray(agentRuns.agentId, hosted),
        "device_revoked",
        input.now,
      );

      await tx.insert(auditEvents).values({
        id: newUuidV7(),
        createdAt: input.now,
        action: "device.revoked",
        actorUserId: input.actorUserId,
        actorDeviceId: input.actorDeviceId,
        subjectId: input.deviceId,
        reason: input.reason,
      });

      return Object.freeze({
        revoked: true,
        disabledAgentIds: Object.freeze(disabled),
        revokedGrantIds: Object.freeze(grants),
        cancelledRuns: cancelled,
      });
    }),
  );
}
