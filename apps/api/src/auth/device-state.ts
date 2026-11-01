import type { devices } from "@mymandev/database";
import {
  type DeviceId,
  type DeviceListItem,
  SIGN_IN_LIFETIME_MS,
  type UserId,
} from "@mymandev/protocol";

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

/** The columns of a device that the device list shows. */
export type ListedDevice = Pick<
  typeof devices.$inferSelect,
  | "id"
  | "label"
  | "platform"
  | "createdAt"
  | "lastSeenAt"
  | "lastSignInAt"
  | "revokedAt"
>;

/**
 * One of the person's own devices as the device list shows it, with its
 * sign-in expiry; `current` marks the device that asks. The frame
 * `account.device_registered` carries the same item.
 */
export function deviceListItem(
  row: ListedDevice,
  current: boolean,
): DeviceListItem {
  return {
    id: row.id,
    label: row.label,
    platform: row.platform,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    lastSignInAt: row.lastSignInAt.toISOString(),
    signInExpiresAt: new Date(
      row.lastSignInAt.getTime() + SIGN_IN_LIFETIME_MS,
    ).toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    current,
  };
}
