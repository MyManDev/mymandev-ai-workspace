import {
  INVITATION_LIFETIME_SECONDS,
  type Invitation,
  type InvitationId,
  MAX_ANSWER_LIST_ITEMS,
  type MemberId,
  newId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, count, desc, eq, gt, isNull, min, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import { activePersonOf } from "./membership.ts";
import {
  type Actor,
  administers,
  audit,
  lockPeople,
  type PersonRefusal,
} from "./people.ts";
import {
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";

// Invitations to claim an unclaimed person (ADR 0014, "Invitations",
// "Limits", and "Lifetimes"). Only the SHA-256 hash of a code reaches the
// database; the caller makes the code and its hash. The locks follow the
// order of `src/people.ts`: the acting person and the invited person first,
// then the workspace row for the counts of the workspace, then the
// invitations, so that every change of a person's invitations waits for
// every other change of that person.

const DAY_MS = 24 * 60 * 60_000;
/** ADR 0014, "Limits". */
const MAX_LIVE_INVITATIONS = 50;
/** ADR 0014, "Limits". */
const MAX_NEW_INVITATIONS_PER_DAY = 100;

/** An invitation that is neither accepted nor revoked nor expired at `now`. */
function live(now: Date) {
  return and(
    isNull(workspaceInvitations.acceptedAt),
    isNull(workspaceInvitations.revokedAt),
    gt(workspaceInvitations.expiresAt, now),
  );
}

/**
 * How long a new invitation in the workspace must wait for the limits of
 * ADR 0014: at most 50 live invitations, not counting the one of `memberId`,
 * which the new invitation replaces, and at most 100 new invitations within
 * 24 hours before `now`. null when neither limit is reached. A live
 * invitation ends at the latest at its expiry, and a new one leaves the
 * window 24 hours after its creation; with both limits reached, the later
 * of the two times counts.
 */
async function limitWait(
  tx: Database,
  input: Readonly<{ workspaceId: WorkspaceId; memberId: MemberId; now: Date }>,
): Promise<number | null> {
  const [liveCount] = await tx
    .select({ n: count(), soonest: min(workspaceInvitations.expiresAt) })
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, input.workspaceId),
        live(input.now),
        ne(workspaceInvitations.memberId, input.memberId),
      ),
    );
  const [recent] = await tx
    .select({ n: count(), oldest: min(workspaceInvitations.createdAt) })
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, input.workspaceId),
        gt(
          workspaceInvitations.createdAt,
          new Date(input.now.getTime() - DAY_MS),
        ),
      ),
    );
  const waits: number[] = [];
  if ((liveCount?.n ?? 0) >= MAX_LIVE_INVITATIONS) {
    const soonest = liveCount?.soonest ?? input.now;
    waits.push(soonest.getTime() - input.now.getTime());
  }
  if ((recent?.n ?? 0) >= MAX_NEW_INVITATIONS_PER_DAY) {
    const oldest = recent?.oldest ?? input.now;
    waits.push(oldest.getTime() + DAY_MS - input.now.getTime());
  }
  return waits.length === 0 ? null : Math.max(...waits);
}

export type CreateInvitationInput = Actor &
  Readonly<{
    /** The unclaimed person that the invitation claims. */
    memberId: MemberId;
    /**
     * The SHA-256 hash of the code as 64 lowercase hexadecimal characters.
     * The code itself never reaches the database.
     */
    tokenHash: string;
    /** From 1 hour to 7 days; 7 days when omitted. */
    lifetimeSeconds?: number;
  }>;

export type CreateInvitationResult =
  | Readonly<{
      created: true;
      invitation: Invitation;
      /** The person's earlier invitation that the new one revoked, if it had one. */
      replacedInvitationId: InvitationId | null;
    }>
  | Readonly<{ created: false; refusal: PersonRefusal }>
  /**
   * The workspace has 50 live invitations, or 100 created within 24 hours.
   * After `retryAfterMs`, the limit that was reached no longer is.
   */
  | Readonly<{ created: false; refusal: "rate_limited"; retryAfterMs: number }>;

/**
 * Creates an invitation for an unclaimed person in one transaction (ADR 0014,
 * "Invitations" and "Limits"): only the owner or an admin; a claimed or
 * removed person is `conflict`. It locks the acting person and the invited
 * person, then the workspace row, so that concurrent creations in one
 * workspace are counted one after another, and refuses with `rate_limited`
 * when the workspace has 50 live invitations or created 100 within 24 hours.
 * It revokes the person's earlier invitation that is neither accepted nor
 * revoked, with the acting account as `revoked_by_user_id`, and inserts the
 * new one with `tokenHash`, `created_at` set to `now`, and `expires_at`
 * `lifetimeSeconds` later. It writes an `invitation.revoked` audit record
 * with the reason `replaced` for the earlier invitation and an
 * `invitation.created` record. The invitation's creator is the acting
 * person. Inside another transaction it runs as a savepoint.
 */
export async function createInvitation(
  db: Database,
  input: CreateInvitationInput,
): Promise<CreateInvitationResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<CreateInvitationResult> => {
      const { actor, target } = await lockPeople(tx, input);
      if (actor === undefined) {
        return { created: false, refusal: "not_member" };
      }
      if (target === undefined) {
        return { created: false, refusal: "not_found" };
      }
      if (!administers(actor.role)) {
        return { created: false, refusal: "forbidden" };
      }
      if (target.userId !== null || target.removedAt !== null) {
        return { created: false, refusal: "conflict" };
      }

      await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .for("no key update");
      const retryAfterMs = await limitWait(tx, input);
      if (retryAfterMs !== null) {
        return { created: false, refusal: "rate_limited", retryAfterMs };
      }

      const [replaced] = await tx
        .update(workspaceInvitations)
        .set({ revokedAt: input.now, revokedByUserId: input.userId })
        .where(
          and(
            eq(workspaceInvitations.memberId, target.id),
            isNull(workspaceInvitations.acceptedAt),
            isNull(workspaceInvitations.revokedAt),
          ),
        )
        .returning({ id: workspaceInvitations.id });
      if (replaced !== undefined) {
        await audit(tx, input, "invitation.revoked", replaced.id, "replaced");
      }

      const id = newId<InvitationId>();
      const lifetimeSeconds =
        input.lifetimeSeconds ?? INVITATION_LIFETIME_SECONDS.default;
      const expiresAt = new Date(input.now.getTime() + lifetimeSeconds * 1000);
      await tx.insert(workspaceInvitations).values({
        id,
        workspaceId: input.workspaceId,
        memberId: target.id,
        tokenHash: input.tokenHash,
        createdByUserId: input.userId,
        createdAt: input.now,
        expiresAt,
      });
      await audit(tx, input, "invitation.created", id);
      return {
        created: true,
        invitation: {
          id,
          workspaceId: input.workspaceId,
          memberId: target.id,
          createdByMemberId: actor.id,
          createdAt: input.now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        replacedInvitationId: replaced?.id ?? null,
      };
    }),
  );
}

export type ListInvitationsInput = Readonly<{
  workspaceId: WorkspaceId;
  /** The account that asks; its active person must be the owner or an admin. */
  userId: UserId;
  /** An invitation that expired by `now` is not live. */
  now: Date;
}>;

export type ListInvitationsResult =
  | Readonly<{ listed: true; invitations: Invitation[] }>
  | Readonly<{ listed: false; refusal: "not_member" | "forbidden" }>;

const creator = alias(workspaceMembers, "creator");

/**
 * The live invitations of a workspace, those neither accepted nor revoked nor
 * expired at `now`, each with its creator: the answer of
 * `GET /workspaces/:workspaceId/invitations`. Only the owner and admins; the
 * most recently created first, at most `MAX_ANSWER_LIST_ITEMS`. No code and
 * no hash leaves the database.
 *
 * The table records the creator's account; the protocol shows the creator's
 * person. That is the account's active person in the workspace, because
 * removing a person or demoting an admin revokes the invitations they
 * created (#93). Should the account have none, its most recently removed
 * person is shown, so that the invitation still names its creator.
 */
export async function listInvitations(
  db: Database,
  input: ListInvitationsInput,
): Promise<ListInvitationsResult> {
  return withDatabaseErrors(async () => {
    const person = await activePersonOf(db, input);
    if (person === undefined) {
      return { listed: false, refusal: "not_member" };
    }
    if (!administers(person.role)) {
      return { listed: false, refusal: "forbidden" };
    }
    const creatorPerson = db
      .select({ id: creator.id })
      .from(creator)
      .where(
        and(
          eq(creator.workspaceId, workspaceInvitations.workspaceId),
          eq(creator.userId, workspaceInvitations.createdByUserId),
        ),
      )
      .orderBy(sql`${creator.removedAt} desc nulls first`, desc(creator.id))
      .limit(1);
    const rows = await db
      .select({
        id: workspaceInvitations.id,
        workspaceId: workspaceInvitations.workspaceId,
        memberId: workspaceInvitations.memberId,
        createdByMemberId: sql<MemberId>`(${creatorPerson})`,
        createdAt: workspaceInvitations.createdAt,
        expiresAt: workspaceInvitations.expiresAt,
      })
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, input.workspaceId),
          live(input.now),
        ),
      )
      .orderBy(
        desc(workspaceInvitations.createdAt),
        desc(workspaceInvitations.id),
      )
      .limit(MAX_ANSWER_LIST_ITEMS);
    return {
      listed: true,
      invitations: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
    };
  });
}

export type RevokeInvitationInput = Actor &
  Readonly<{ invitationId: InvitationId }>;

export type RevokeInvitationResult =
  | Readonly<{ revoked: true }>
  | Readonly<{ revoked: false; refusal: PersonRefusal }>;

/**
 * Revokes a live invitation in one transaction (ADR 0014, "Invitations"):
 * only the owner or an admin; sets `revoked_at` to `now` and
 * `revoked_by_user_id` to the acting account, and writes an
 * `invitation.revoked` audit record without a reason. An invitation that the
 * workspace does not have is `not_found`; one that is already accepted,
 * revoked, or expired is `conflict`, so a second revocation changes nothing.
 * It locks the acting person and the invited person first, as every change
 * of a person's invitations does. Inside another transaction it runs as a
 * savepoint.
 */
export async function revokeInvitation(
  db: Database,
  input: RevokeInvitationInput,
): Promise<RevokeInvitationResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<RevokeInvitationResult> => {
      // The person of an invitation never changes, so it is read before the lock.
      const [invitation] = await tx
        .select({ memberId: workspaceInvitations.memberId })
        .from(workspaceInvitations)
        .where(
          and(
            eq(workspaceInvitations.id, input.invitationId),
            eq(workspaceInvitations.workspaceId, input.workspaceId),
          ),
        );
      const { actor } = await lockPeople(tx, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        ...(invitation === undefined ? {} : { memberId: invitation.memberId }),
      });
      if (actor === undefined) {
        return { revoked: false, refusal: "not_member" };
      }
      if (invitation === undefined) {
        return { revoked: false, refusal: "not_found" };
      }
      if (!administers(actor.role)) {
        return { revoked: false, refusal: "forbidden" };
      }
      const [revoked] = await tx
        .update(workspaceInvitations)
        .set({ revokedAt: input.now, revokedByUserId: input.userId })
        .where(
          and(eq(workspaceInvitations.id, input.invitationId), live(input.now)),
        )
        .returning({ id: workspaceInvitations.id });
      if (revoked === undefined) {
        return { revoked: false, refusal: "conflict" };
      }
      await audit(tx, input, "invitation.revoked", revoked.id);
      return { revoked: true };
    }),
  );
}
