import { type DeviceId, newUuidV7, type UserId } from "@mymandev/protocol";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AuditAction } from "./audit-vocabulary.ts";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import { type ActiveMemberInput, activePersonOf } from "./membership.ts";
import { auditEvents, devices, users } from "./schema/index.ts";

// Queries of device authentication and the WebSocket gateway (ADR 0014,
// "Device key and authentication" and "Revocation, sign-out, and recovery";
// ADR 0006, identity binding).

/** At most this many device IDs go into one statement. */
const DEVICE_IDS_PER_STATEMENT = 500;

/** The IDs in slices of at most `DEVICE_IDS_PER_STATEMENT`. */
function slices(deviceIds: readonly DeviceId[]): DeviceId[][] {
  const result: DeviceId[][] = [];
  for (
    let start = 0;
    start < deviceIds.length;
    start += DEVICE_IDS_PER_STATEMENT
  ) {
    result.push(deviceIds.slice(start, start + DEVICE_IDS_PER_STATEMENT));
  }
  return result;
}

/**
 * A device with its current key and its account's state: everything that
 * decides whether the device may act now (ADR 0014).
 */
export type DeviceAccessRow = Readonly<{
  userId: UserId;
  publicKey: string;
  revokedAt: Date | null;
  signedOutAt: Date | null;
  lastSignInAt: Date;
  disabledAt: Date | null;
  signInRequiredAt: Date | null;
}>;

const deviceAccess = {
  userId: devices.userId,
  publicKey: devices.publicKey,
  revokedAt: devices.revokedAt,
  signedOutAt: devices.signedOutAt,
  lastSignInAt: devices.lastSignInAt,
  disabledAt: users.disabledAt,
  signInRequiredAt: users.signInRequiredAt,
};

/** The device with its current key and its account's state; undefined when the device does not exist. */
export async function deviceRow(
  db: Database,
  deviceId: DeviceId,
): Promise<DeviceAccessRow | undefined> {
  return withDatabaseErrors(async () => {
    const [row] = await db
      .select(deviceAccess)
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .where(eq(devices.id, deviceId));
    return row;
  });
}

/**
 * Several devices like `deviceRow`, by device ID, with one query per 500
 * IDs: the gateway's sweep re-checks the devices of every open connection at
 * once. A device that does not exist is missing from the map.
 */
export async function deviceRows(
  db: Database,
  deviceIds: readonly DeviceId[],
): Promise<ReadonlyMap<DeviceId, DeviceAccessRow>> {
  return withDatabaseErrors(async () => {
    const rows = new Map<DeviceId, DeviceAccessRow>();
    for (const slice of slices(deviceIds)) {
      const found = await db
        .select({ id: devices.id, ...deviceAccess })
        .from(devices)
        .innerJoin(users, eq(users.id, devices.userId))
        .where(inArray(devices.id, slice));
      for (const { id, ...row } of found) {
        rows.set(id, row);
      }
    }
    return rows;
  });
}

/**
 * Whether the account is an active member of the workspace: it has an active
 * person there (`activePersonOf`), a claimed person whose `removed_at` is
 * empty (ADR 0014, "People and roles"). A workspace that does not exist gives
 * false, like one without the account.
 */
export async function isActiveMember(
  db: Database,
  input: ActiveMemberInput,
): Promise<boolean> {
  return (await activePersonOf(db, input)) !== undefined;
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

export type DevicesSeenInput = Readonly<{
  deviceIds: readonly DeviceId[];
  now: Date;
}>;

/**
 * Records that devices were seen now: their connections are still open. One
 * update per 500 IDs. A revoked device is left unchanged, also one revoked
 * since its connection was checked. A device row that another transaction
 * holds, such as a sign-in or a revocation, is skipped: the update never
 * waits for a locked row, so it cannot deadlock with such a transaction.
 */
export async function markDevicesSeen(
  db: Database,
  input: DevicesSeenInput,
): Promise<void> {
  await withDatabaseErrors(async () => {
    for (const slice of slices(input.deviceIds)) {
      const free = db
        .select({ id: devices.id })
        .from(devices)
        .where(and(inArray(devices.id, slice), isNull(devices.revokedAt)))
        .for("no key update", { skipLocked: true });
      await db
        .update(devices)
        .set({ lastSeenAt: input.now, updatedAt: input.now })
        .where(inArray(devices.id, free));
    }
  });
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
