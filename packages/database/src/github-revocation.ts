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

const NOTHING: GitHubRevocationResult = Object.freeze({
  changed: false,
  userId: null,
  deviceIds: Object.freeze([]),
});

/**
 * GitHub reported that a person revoked the app's authorization (ADR 0014,
 * "Revocation, sign-out, and recovery"; P-54). In one transaction it finds
 * the account by the GitHub ID in `user_identities`, writes a
 * `github.authorization_revoked` audit record without an actor and with the
 * delivery ID, and sets `users.sign_in_required_at`, which never moves
 * backward, so that every device whose last sign-in is earlier must sign in
 * again. The devices stay registered. A delivery ID that is already recorded
 * changes nothing. A sender without an account, or whose identity was
 * erased, gets the audit record without a subject, so that its redelivery is
 * recognized too.
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
      await tx
        .update(users)
        .set({ signInRequiredAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(users.id, userId),
            or(
              isNull(users.signInRequiredAt),
              lt(users.signInRequiredAt, input.now),
            ),
          ),
        );
      const active = await tx
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
      return Object.freeze({
        changed: true,
        userId,
        deviceIds: Object.freeze(active.map((row) => row.id)),
      });
    }),
  );
}
