import {
  type AgentId,
  type CorrelationId,
  type DeviceId,
  type DeviceRevocationReason,
  newUuidV7,
  type PermissionGrantId,
  type ProjectId,
  type RepositoryId,
  type RunId,
  type UserId,
  type WorkspaceId,
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
  projects,
} from "./schema/index.ts";

/** Run states that have not finished; a revocation cancels them (P-60). */
const UNFINISHED_STATES = ["queued", "running", "awaiting_input"] as const;

/** The state of a run that has not finished. */
export type UnfinishedRunState = (typeof UNFINISHED_STATES)[number];

const unfinishedStates: ReadonlySet<string> = new Set(UNFINISHED_STATES);

function isUnfinished(state: string): state is UnfinishedRunState {
  return unfinishedStates.has(state);
}

/**
 * A run that a revocation cancelled, with what the server's
 * `agent.run.state_changed` event about it needs: the run, its agent, its
 * repository and correlation ID when it has them, the state it had before,
 * and the workspace whose members are told.
 */
export type CancelledRun = Readonly<{
  runId: RunId;
  agentId: AgentId;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  repositoryId: RepositoryId | null;
  correlationId: CorrelationId | null;
  previousState: UnfinishedRunState;
}>;

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
  /** In the order of their run IDs. */
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
 * The runs are locked `FOR NO KEY UPDATE`, the lock that their update takes,
 * at the same step as before and in the order of their IDs, and read with
 * the state they had and their project's workspace before they are updated.
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
      // PostgreSQL checks a row that changed while it waited for the lock
      // again, so a run that finished meanwhile is not read.
      const unfinished = await tx
        .select({
          runId: agentRuns.id,
          agentId: agentRuns.agentId,
          projectId: agentRuns.projectId,
          workspaceId: projects.workspaceId,
          repositoryId: agentRuns.repositoryId,
          correlationId: agentRuns.correlationId,
          previousState: agentRuns.state,
        })
        .from(agentRuns)
        .innerJoin(projects, eq(projects.id, agentRuns.projectId))
        .where(
          and(
            inArray(agentRuns.agentId, hosted),
            inArray(agentRuns.state, [...UNFINISHED_STATES]),
          ),
        )
        .orderBy(agentRuns.id)
        .for("no key update", { of: agentRuns });
      const cancelled: CancelledRun[] = [];
      for (const { previousState, ...run } of unfinished) {
        if (isUnfinished(previousState)) {
          cancelled.push(Object.freeze({ ...run, previousState }));
        }
      }
      if (cancelled.length > 0) {
        await tx
          .update(agentRuns)
          .set({
            state: "cancelled",
            stateReason: "device_revoked",
            finishedAt: input.now,
          })
          .where(
            inArray(
              agentRuns.id,
              cancelled.map((run) => run.runId),
            ),
          );
      }

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
        cancelledRuns: Object.freeze(cancelled),
      });
    }),
  );
}
