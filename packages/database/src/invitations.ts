import {
  type DeviceId,
  INVITATION_LIFETIME_SECONDS,
  type Invitation,
  type InvitationId,
  MAX_ANSWER_LIST_ITEMS,
  type MemberId,
  newId,
  type PreviewInvitationResponse,
  type UserId,
  type WorkspaceId,
  type WorkspaceMembership,
} from "@mymandev/protocol";
import { and, count, desc, eq, gt, isNull, min, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "./db.ts";
import { toDatabaseError, withDatabaseErrors } from "./errors.ts";
import { activePersonOf, memberById } from "./membership.ts";
import {
  type Actor,
  administers,
  audit,
  lockPeople,
  type PersonRefusal,
} from "./people.ts";
import {
  userIdentities,
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
// every other change of that person. Accepting an invitation locks its
// person before it consumes the invitation, too.

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

/**
 * Why an invitation code claims nothing (ADR 0014, "Invitations"). The API
 * answers each of them with the same `invitation_invalid` and logs only the
 * reason and the invitation's ID, never the code.
 *
 * - `unknown`: no invitation has the code's hash;
 * - `used`: the invitation was accepted;
 * - `revoked` and `expired`: the invitation was revoked, or its expiry has
 *   passed;
 * - `member_removed` and `member_claimed`: the invitation is live, but its
 *   person was removed or claimed; removing or claiming a person ends its
 *   invitation, so this happens only to data written outside these functions;
 * - `inviter_unknown`: a preview finds no person or no GitHub identity of the
 *   account that created the invitation in its workspace, for example after
 *   the account's data was erased.
 */
export type InvitationFailure =
  | "unknown"
  | "used"
  | "revoked"
  | "expired"
  | "member_removed"
  | "member_claimed"
  | "inviter_unknown";

/** Why a preview or an acceptance of an invitation code was refused. Nothing was written. */
export type InvitationCodeRefusal =
  /** The account is an active member of the invitation's workspace, whatever the invitation's state. */
  | Readonly<{ refusal: "already_member"; invitationId: InvitationId }>
  | Readonly<{
      refusal: "invitation_invalid";
      reason: InvitationFailure;
      /** null when no invitation has the code's hash. */
      invitationId: InvitationId | null;
    }>;

export type PreviewInvitationInput = Readonly<{
  /**
   * The SHA-256 hash of the code as 64 lowercase hexadecimal characters. The
   * code itself never reaches the database.
   */
  tokenHash: string;
  /** The account that presents the code. */
  userId: UserId;
  /** An invitation whose expiry is `now` or earlier is expired. */
  now: Date;
}>;

export type PreviewInvitationResult =
  | Readonly<{
      previewed: true;
      invitationId: InvitationId;
      preview: PreviewInvitationResponse;
    }>
  | (Readonly<{ previewed: false }> & InvitationCodeRefusal);

export type AcceptInvitationInput = PreviewInvitationInput &
  Readonly<{
    /** The account's device that accepts, recorded on the invitation and as the actor's device. */
    deviceId: DeviceId;
  }>;

export type AcceptInvitationResult =
  | Readonly<{
      accepted: true;
      invitationId: InvitationId;
      /** The workspace and the person that the account claimed. */
      membership: WorkspaceMembership;
    }>
  | (Readonly<{ accepted: false }> & InvitationCodeRefusal);

/** The unique index that allows one active person per account and workspace. */
const ACTIVE_PERSON_KEY = "workspace_members_active_user_key";

function invalid(
  reason: InvitationFailure,
  invitationId: InvitationId | null,
): Extract<InvitationCodeRefusal, { refusal: "invitation_invalid" }> {
  return { refusal: "invitation_invalid", reason, invitationId };
}

/** Why an invitation is not live at `now`, or null when it is. */
function invitationFailure(
  invitation: Readonly<{
    acceptedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
  }>,
  now: Date,
): InvitationFailure | null {
  if (invitation.acceptedAt !== null) {
    return "used";
  }
  if (invitation.revokedAt !== null) {
    return "revoked";
  }
  return invitation.expiresAt <= now ? "expired" : null;
}

/** Why a person cannot be claimed, or null when it is unclaimed and active. */
function personFailure(
  person: Readonly<{ userId: UserId | null; removedAt: Date | null }>,
): InvitationFailure | null {
  if (person.removedAt !== null) {
    return "member_removed";
  }
  return person.userId === null ? null : "member_claimed";
}

/**
 * The person of the account that created an invitation, with its GitHub
 * login, as the preview shows the inviter: the account's active person in
 * the workspace, or else its most recently removed one, as
 * `listInvitations` shows the creator. undefined without such a person or
 * without a GitHub identity.
 */
async function inviterOf(
  db: Database,
  invitation: Readonly<{ workspaceId: WorkspaceId; createdByUserId: UserId }>,
): Promise<PreviewInvitationResponse["inviter"] | undefined> {
  const [row] = await db
    .select({
      displayName: workspaceMembers.displayName,
      provider: userIdentities.identityProvider,
      login: userIdentities.login,
      verifiedAt: userIdentities.lastSignInAt,
    })
    .from(workspaceMembers)
    .leftJoin(
      userIdentities,
      and(
        eq(userIdentities.userId, workspaceMembers.userId),
        eq(userIdentities.identityProvider, "github"),
      ),
    )
    .where(
      and(
        eq(workspaceMembers.workspaceId, invitation.workspaceId),
        eq(workspaceMembers.userId, invitation.createdByUserId),
      ),
    )
    .orderBy(
      sql`${workspaceMembers.removedAt} desc nulls first`,
      desc(workspaceMembers.id),
    )
    .limit(1);
  if (
    row === undefined ||
    row.provider === null ||
    row.login === null ||
    row.verifiedAt === null
  ) {
    return undefined;
  }
  return {
    displayName: row.displayName,
    identity: {
      provider: row.provider,
      login: row.login,
      verifiedAt: row.verifiedAt.toISOString(),
    },
  };
}

/**
 * What an invitation code claims, without consuming it (ADR 0014,
 * "Invitations"): the answer of `POST /invitations/preview`. It finds the
 * invitation by `tokenHash` in whatever state. An account that is already an
 * active member of its workspace is `already_member`, before anything else
 * is decided. Every other refusal is `invitation_invalid` with its reason:
 * an unknown hash, an invitation that is accepted, revoked, or expired at
 * `now`, a person that is removed or claimed, or an inviter without a person
 * or an identity. The preview shows the workspace's name, the person's
 * display name, the inviter's person in the workspace with its GitHub login,
 * and the expiry. It writes nothing.
 */
export async function previewInvitation(
  db: Database,
  input: PreviewInvitationInput,
): Promise<PreviewInvitationResult> {
  return withDatabaseErrors(async () => {
    const [found] = await db
      .select({
        id: workspaceInvitations.id,
        workspaceId: workspaceInvitations.workspaceId,
        createdByUserId: workspaceInvitations.createdByUserId,
        expiresAt: workspaceInvitations.expiresAt,
        acceptedAt: workspaceInvitations.acceptedAt,
        revokedAt: workspaceInvitations.revokedAt,
        workspaceName: workspaces.name,
        displayName: workspaceMembers.displayName,
        userId: workspaceMembers.userId,
        removedAt: workspaceMembers.removedAt,
      })
      .from(workspaceInvitations)
      .innerJoin(
        workspaces,
        eq(workspaces.id, workspaceInvitations.workspaceId),
      )
      .innerJoin(
        workspaceMembers,
        eq(workspaceMembers.id, workspaceInvitations.memberId),
      )
      .where(eq(workspaceInvitations.tokenHash, input.tokenHash));
    if (found === undefined) {
      return { previewed: false, ...invalid("unknown", null) };
    }
    const member = await activePersonOf(db, {
      workspaceId: found.workspaceId,
      userId: input.userId,
    });
    if (member !== undefined) {
      return {
        previewed: false,
        refusal: "already_member",
        invitationId: found.id,
      };
    }
    const failure = invitationFailure(found, input.now) ?? personFailure(found);
    if (failure !== null) {
      return { previewed: false, ...invalid(failure, found.id) };
    }
    const inviter = await inviterOf(db, found);
    if (inviter === undefined) {
      return { previewed: false, ...invalid("inviter_unknown", found.id) };
    }
    return {
      previewed: true,
      invitationId: found.id,
      preview: {
        workspaceName: found.workspaceName,
        displayName: found.displayName,
        inviter,
        expiresAt: found.expiresAt.toISOString(),
      },
    };
  });
}

/** Ends an acceptance's transaction with a rollback and this result. */
class AcceptanceUndone extends Error {
  readonly result: AcceptInvitationResult;

  constructor(result: AcceptInvitationResult) {
    super("acceptance undone");
    this.name = "AcceptanceUndone";
    this.result = result;
  }
}

/**
 * Consumes an invitation code and claims its person in one transaction (ADR
 * 0014, "Invitations"), at the isolation level of the connection, which is
 * PostgreSQL's default, READ COMMITTED.
 *
 * It finds the invitation by `tokenHash` in whatever state; an unknown hash
 * is `invitation_invalid`. An account that is already an active member of
 * the invitation's workspace is `already_member` before anything is
 * consumed, so the invitation stays as it was. Then it locks the
 * invitation's person, as every change of a person's invitations does, and
 * consumes the invitation with a conditional update: only if the hash
 * matches and the invitation is neither accepted, nor revoked, nor expired
 * at `now`. It records the accepting account and device and `now`. It then
 * claims the person only if the person is still unclaimed and not removed,
 * with `claimed_at` set to `now`. When either update changes no row, the
 * transaction rolls back and the result is `invitation_invalid` with the
 * reason. PostgreSQL checks a row that a concurrent transaction changed
 * again before it updates it, so of two acceptances of one code only the
 * first claims the person. When the account claimed another person of the
 * workspace concurrently, the unique index of one active person per account
 * and workspace refuses the claim, and the result is `already_member`.
 *
 * A claim always takes the invited person, a new person row, so an account
 * that was removed and is invited again rejoins as a new person, and its
 * earlier person stays in the history. It writes an `invitation.accepted`
 * and a `member.claimed` audit record, with the account and the device as
 * the actor, and returns the workspace with the claimed person. Inside
 * another transaction it runs as a savepoint.
 */
export async function acceptInvitation(
  db: Database,
  input: AcceptInvitationInput,
): Promise<AcceptInvitationResult> {
  return withDatabaseErrors(async () => {
    // The invitation that the hash names, for a refusal after a rollback.
    const seen: { invitationId: InvitationId | null } = { invitationId: null };
    try {
      return await db.transaction(
        async (tx): Promise<AcceptInvitationResult> => {
          // The person of an invitation never changes, so it is read before the lock.
          const [found] = await tx
            .select({
              id: workspaceInvitations.id,
              workspaceId: workspaceInvitations.workspaceId,
              memberId: workspaceInvitations.memberId,
            })
            .from(workspaceInvitations)
            .where(eq(workspaceInvitations.tokenHash, input.tokenHash));
          if (found === undefined) {
            return { accepted: false, ...invalid("unknown", null) };
          }
          seen.invitationId = found.id;
          const actor: Actor = {
            workspaceId: found.workspaceId,
            userId: input.userId,
            deviceId: input.deviceId,
            now: input.now,
          };
          if ((await activePersonOf(tx, actor)) !== undefined) {
            return {
              accepted: false,
              refusal: "already_member",
              invitationId: found.id,
            };
          }

          const [person] = await tx
            .select({
              userId: workspaceMembers.userId,
              removedAt: workspaceMembers.removedAt,
            })
            .from(workspaceMembers)
            .where(eq(workspaceMembers.id, found.memberId))
            .for("no key update");

          const [consumed] = await tx
            .update(workspaceInvitations)
            .set({
              acceptedAt: input.now,
              acceptedByUserId: input.userId,
              acceptedDeviceId: input.deviceId,
            })
            .where(
              and(
                eq(workspaceInvitations.tokenHash, input.tokenHash),
                live(input.now),
              ),
            )
            .returning({ id: workspaceInvitations.id });
          if (consumed === undefined) {
            const [state] = await tx
              .select({
                acceptedAt: workspaceInvitations.acceptedAt,
                revokedAt: workspaceInvitations.revokedAt,
                expiresAt: workspaceInvitations.expiresAt,
              })
              .from(workspaceInvitations)
              .where(eq(workspaceInvitations.id, found.id));
            const reason =
              state === undefined
                ? "unknown"
                : (invitationFailure(state, input.now) ?? "unknown");
            return { accepted: false, ...invalid(reason, found.id) };
          }

          const [claimed] = await tx
            .update(workspaceMembers)
            .set({
              userId: input.userId,
              claimedAt: input.now,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(workspaceMembers.id, found.memberId),
                isNull(workspaceMembers.userId),
                isNull(workspaceMembers.removedAt),
              ),
            )
            .returning({ id: workspaceMembers.id });
          if (claimed === undefined) {
            const reason =
              (person === undefined ? null : personFailure(person)) ??
              "member_claimed";
            throw new AcceptanceUndone({
              accepted: false,
              ...invalid(reason, found.id),
            });
          }

          await audit(tx, actor, "invitation.accepted", found.id);
          await audit(tx, actor, "member.claimed", claimed.id);
          const [workspace] = await tx
            .select({ id: workspaces.id, name: workspaces.name })
            .from(workspaces)
            .where(eq(workspaces.id, found.workspaceId));
          const member = await memberById(tx, claimed.id);
          if (workspace === undefined || member === undefined) {
            throw new Error("The claimed person or its workspace is missing");
          }
          return {
            accepted: true,
            invitationId: found.id,
            membership: { workspace, member },
          };
        },
      );
    } catch (error) {
      if (error instanceof AcceptanceUndone) {
        return error.result;
      }
      const failure = toDatabaseError(error);
      if (
        failure.code === "23505" &&
        failure.constraint === ACTIVE_PERSON_KEY &&
        seen.invitationId !== null
      ) {
        return {
          accepted: false,
          refusal: "already_member",
          invitationId: seen.invitationId,
        };
      }
      throw failure;
    }
  });
}
