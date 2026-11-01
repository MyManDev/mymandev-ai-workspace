import { type DeviceId, newUuidV7, type UserId } from "@mymandev/protocol";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import { auditEvents, devices, userIdentities, users } from "./schema/index.ts";

export type GitHubRevocationInput = Readonly<{
  /** The sender's numeric GitHub ID as decimal text, never the login. */
  subject: string;
  /** `X-GitHub-Delivery` of the webhook; a redelivery keeps it. */
  deliveryId: string;
  now: Date;
}>;

export type GitHubRevocationResult = Readonly<{
  /** False when the delivery ID was already recorded; then nothing changed. */
  changed: boolean;
  /** The account with this GitHub ID; null when none has it or nothing changed. */
  userId: UserId | null;
  /** The account's devices that are not revoked, whose access tokens the caller drops. */
  deviceIds: readonly DeviceId[];
}>;

export type RequireSignInInput = Readonly<{
  userId: UserId;
  now: Date;
}>;

const NOTHING: GitHubRevocationResult = Object.freeze({
  changed: false,
  userId: null,
  deviceIds: Object.freeze([]),
});

/**
 * How far past `now` a device's last sign-in can move `sign_in_required_at`:
 * a last sign-in in the future, after the clock jumped, must not keep the
 * account from signing in for longer than this.
 */
const MAX_AHEAD_MS = 60_000;

/**
 * Inside a transaction: locks the account's row as the API's sign-in does,
 * so the two serialize, and sets `users.sign_in_required_at`, which never
 * moves backward, to `now` or, if later, to just past the last sign-in of
 * every device that is not revoked, capped at `MAX_AHEAD_MS` past `now`. A
 * sign-in that committed first must therefore sign in again, whatever times
 * the two requests took before their transactions (#115). Returns the
 * devices that are not revoked.
 */
async function markSignInRequired(
  tx: Database,
  userId: UserId,
  now: Date,
): Promise<readonly DeviceId[]> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for("no key update");
  const active = await tx
    .select({ id: devices.id, lastSignInAt: devices.lastSignInAt })
    .from(devices)
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
  const requiredAt = new Date(
    Math.max(
      now.getTime(),
      ...active.map((row) =>
        Math.min(row.lastSignInAt.getTime() + 1, now.getTime() + MAX_AHEAD_MS),
      ),
    ),
  );
  await tx
    .update(users)
    .set({ signInRequiredAt: requiredAt, updatedAt: now })
    .where(
      and(
        eq(users.id, userId),
        or(
          isNull(users.signInRequiredAt),
          lt(users.signInRequiredAt, requiredAt),
        ),
      ),
    );
  return Object.freeze(active.map((row) => row.id));
}

/**
 * GitHub reported that a person revoked the app's authorization (ADR 0014,
 * "Revocation, sign-out, and recovery"; P-54). In one transaction it finds
 * the account by the GitHub ID in `user_identities`, writes a
 * `github.authorization_revoked` audit record without an actor and with the
 * delivery ID, and sets `users.sign_in_required_at` as `requireSignIn`
 * does, so that every device that signed in before must sign in again. The
 * devices stay registered. A delivery ID that is already recorded changes
 * nothing. A sender without an account, or whose identity was erased, gets
 * the audit record without a subject, so that its redelivery is recognized
 * too.
 *
 * The caller closes the account's sockets and drops its access tokens after
 * the commit.
 */
export async function recordGitHubRevocation(
  db: Database,
  input: GitHubRevocationInput,
): Promise<GitHubRevocationResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx) => {
      const [identity] = await tx
        .select({ userId: userIdentities.userId })
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.identityProvider, "github"),
            eq(userIdentities.subject, input.subject),
          ),
        );
      const userId = identity?.userId ?? null;
      // The unique delivery ID waits for a concurrent insert of the same ID.
      const recorded = await tx
        .insert(auditEvents)
        .values({
          id: newUuidV7(),
          createdAt: input.now,
          action: "github.authorization_revoked",
          subjectId: userId,
          githubDeliveryId: input.deliveryId,
        })
        .onConflictDoNothing({
          target: auditEvents.githubDeliveryId,
          where: sql`${auditEvents.githubDeliveryId} is not null`,
        })
        .returning({ id: auditEvents.id });
      if (recorded.length === 0) {
        return NOTHING;
      }
      if (userId === null) {
        return Object.freeze({
          changed: true,
          userId: null,
          deviceIds: Object.freeze([]),
        });
      }
      return Object.freeze({
        changed: true,
        userId,
        deviceIds: await markSignInRequired(tx, userId, input.now),
      });
    }),
  );
}

/**
 * Requires every device of the account that signed in up to now to sign in
 * again, in one transaction, as a GitHub revocation does, but without an
 * audit record. The API calls it when a sign-in committed while the webhook
 * recorded a revocation of its GitHub identity that the webhook's own lookup
 * may have missed (#115). Returns the account's devices that are not
 * revoked.
 */
export async function requireSignIn(
  db: Database,
  input: RequireSignInInput,
): Promise<readonly DeviceId[]> {
  return withDatabaseErrors(() =>
    db.transaction((tx) => markSignInRequired(tx, input.userId, input.now)),
  );
}
