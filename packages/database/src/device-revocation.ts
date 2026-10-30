import {
  type AgentId,
  type DeviceId,
  type DeviceRevocationReason,
  newUuidV7,
  type PermissionGrantId,
  type RunId,
  type UserId,
} from "@mymandev/protocol";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import {
  agentRuns,
  agents,
  auditEvents,
  devices,
  permissionGrants,
} from "./schema/index.ts";

/** Run states that have not finished; a revocation cancels them (P-60). */
const UNFINISHED_STATES = ["queued", "running", "awaiting_input"] as const;

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
  disabledAgentIds: readonly AgentId[];
  revokedGrantIds: readonly PermissionGrantId[];
  cancelledRunIds: readonly RunId[];
}>;

const NOTHING: RevokeDeviceResult = Object.freeze({
  revoked: false,
  disabledAgentIds: Object.freeze([]),
  revokedGrantIds: Object.freeze([]),
  cancelledRunIds: Object.freeze([]),
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
 * The caller closes the device's socket and sends the run events after the
 * commit; the server's `system` actor is the author of those events (P-60).
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

      const disabled = await tx
        .update(agents)
        .set({ disabledAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(agents.hostDeviceId, input.deviceId),
            isNull(agents.disabledAt),
          ),
        )
        .returning({ id: agents.id });

      const grants = await tx
        .update(permissionGrants)
        .set({ revokedAt: input.now, revokedByUserId: input.userId })
        .where(
          and(
            eq(permissionGrants.hostDeviceId, input.deviceId),
            isNull(permissionGrants.revokedAt),
          ),
        )
        .returning({ id: permissionGrants.id });

      const hosted = tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.hostDeviceId, input.deviceId));
      const cancelled = await tx
        .update(agentRuns)
        .set({
          state: "cancelled",
          stateReason: "device_revoked",
          finishedAt: input.now,
        })
        .where(
          and(
            inArray(agentRuns.agentId, hosted),
            inArray(agentRuns.state, [...UNFINISHED_STATES]),
          ),
        )
        .returning({ id: agentRuns.id });

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
        disabledAgentIds: Object.freeze(disabled.map((row) => row.id)),
        revokedGrantIds: Object.freeze(grants.map((row) => row.id)),
        cancelledRunIds: Object.freeze(cancelled.map((row) => row.id)),
      });
    }),
  );
}
