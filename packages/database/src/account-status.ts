import {
  newUuidV7,
  type PermissionGrantId,
  type UserId,
} from "@mymandev/protocol";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import {
  agents,
  auditEvents,
  permissionGrants,
  users,
} from "./schema/index.ts";

export type AccountStatusInput = Readonly<{ userId: UserId; now: Date }>;

export type DisableAccountResult = Readonly<{
  /** False when the account does not exist or was already disabled. */
  changed: boolean;
  revokedGrantIds: readonly PermissionGrantId[];
}>;

/**
 * An operator disables an account (ADR 0014, "Revocation, sign-out, and
 * recovery"): every authentication of the account fails from now on. In the
 * same transaction, the active grants of the agents that the account owns are
 * revoked, with the account as `revoked_by_user_id` (ADR 0015, P-77 and P-78),
 * and an `account.disabled` audit record without an actor is written.
 */
export async function disableAccount(
  db: Database,
  input: AccountStatusInput,
): Promise<DisableAccountResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx) => {
      const disabled = await tx
        .update(users)
        .set({ disabledAt: input.now, updatedAt: input.now })
        .where(and(eq(users.id, input.userId), isNull(users.disabledAt)))
        .returning({ id: users.id });
      if (disabled.length === 0) {
        return { changed: false, revokedGrantIds: [] };
      }
      const owned = tx
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.ownerUserId, input.userId));
      const grants = await tx
        .update(permissionGrants)
        .set({ revokedAt: input.now, revokedByUserId: input.userId })
        .where(
          and(
            inArray(permissionGrants.granteeAgentId, owned),
            isNull(permissionGrants.revokedAt),
          ),
        )
        .returning({ id: permissionGrants.id });
      await tx.insert(auditEvents).values({
        id: newUuidV7(),
        createdAt: input.now,
        action: "account.disabled",
        subjectId: input.userId,
      });
      return { changed: true, revokedGrantIds: grants.map((row) => row.id) };
    }),
  );
}

/**
 * An operator enables a disabled account again. No grant is restored: the
 * person grants again what their agents need (ADR 0015, P-78). Writes an
 * `account.enabled` audit record without an actor.
 */
export async function enableAccount(
  db: Database,
  input: AccountStatusInput,
): Promise<{ changed: boolean }> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx) => {
      const enabled = await tx
        .update(users)
        .set({ disabledAt: null, updatedAt: input.now })
        .where(and(eq(users.id, input.userId), isNotNull(users.disabledAt)))
        .returning({ id: users.id });
      if (enabled.length === 0) {
        return { changed: false };
      }
      await tx.insert(auditEvents).values({
        id: newUuidV7(),
        createdAt: input.now,
        action: "account.enabled",
        subjectId: input.userId,
      });
      return { changed: true };
    }),
  );
}
