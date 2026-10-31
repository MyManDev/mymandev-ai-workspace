import { type Database, devices, users } from "@mymandev/database";
import {
  type DeviceId,
  SIGN_IN_LIFETIME_MS,
  type UserId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";

/** Who an authenticated request comes from, and the sign-in its token belongs to. */
export type AuthContext = Readonly<{
  userId: UserId;
  deviceId: DeviceId;
  signedInAt: number;
}>;

export type DeviceState =
  | Readonly<{ state: "ok"; userId: UserId }>
  | Readonly<{ state: "revoked" | "disabled" | "sign_in_required" }>;

export type DeviceRow = Readonly<{
  userId: UserId;
  revokedAt: Date | null;
  signedOutAt: Date | null;
  lastSignInAt: Date;
  disabledAt: Date | null;
  signInRequiredAt: Date | null;
}>;

/**
 * What a device may do now (ADR 0014): a revoked device never comes back; a
 * signed-out device, a sign-in older than 30 days, or a GitHub revocation
 * after the last sign-in requires a new sign-in; a disabled account fails.
 */
export function stateOf(row: DeviceRow, now: number): DeviceState {
  if (row.revokedAt !== null) {
    return { state: "revoked" };
  }
  if (row.disabledAt !== null) {
    return { state: "disabled" };
  }
  if (
    row.signedOutAt !== null ||
    row.lastSignInAt.getTime() + SIGN_IN_LIFETIME_MS <= now ||
    (row.signInRequiredAt !== null && row.signInRequiredAt > row.lastSignInAt)
  ) {
    return { state: "sign_in_required" };
  }
  return { state: "ok", userId: row.userId };
}

/** Whether a token may act now: its device is usable and has not signed in again since. */
export function tokenUsable(
  row: DeviceRow | undefined,
  auth: AuthContext,
  now: number,
): boolean {
  if (row === undefined || row.lastSignInAt.getTime() !== auth.signedInAt) {
    return false;
  }
  const state = stateOf(row, now);
  return state.state === "ok" && state.userId === auth.userId;
}

/** The device with its current key and its account's state; undefined when the device does not exist. */
export async function deviceRow(
  database: Database,
  deviceId: DeviceId,
): Promise<(DeviceRow & { publicKey: string }) | undefined> {
  const [row] = await database
    .select({
      userId: devices.userId,
      publicKey: devices.publicKey,
      revokedAt: devices.revokedAt,
      signedOutAt: devices.signedOutAt,
      lastSignInAt: devices.lastSignInAt,
      disabledAt: users.disabledAt,
      signInRequiredAt: users.signInRequiredAt,
    })
    .from(devices)
    .innerJoin(users, eq(users.id, devices.userId))
    .where(eq(devices.id, deviceId));
  return row;
}
