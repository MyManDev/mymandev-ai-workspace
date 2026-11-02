import type {
  MemberId,
  MemberRole,
  OwnershipOffer,
  OwnershipOfferEndReason,
  UserId,
  WorkspaceId,
} from "@mymandev/protocol";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import { OWNERSHIP_OFFER_LIFETIME_MS } from "./membership.ts";
import {
  type Actor,
  audit,
  deviceOldEnough,
  type PersonRefusal,
} from "./people.ts";
import { workspaceMembers } from "./schema/index.ts";

// Offering the ownership of a workspace, accepting the offer, and
// withdrawing it (ADR 0014, "People and roles", "Removal and ownership", and
// "Lifetimes"). The offer is `ownership_offered_at` on the target's row: a
// CHECK keeps it on an active, claimed person who is not the owner, and a
// unique index keeps at most one per workspace. An offer lives
// `OWNERSHIP_OFFER_LIFETIME_MS`; an older one is no offer. Nothing sweeps
// it: the owner's next offer or withdrawal, or the target's acceptance,
// clears it, and the reads skip it (Project Manager decision of
// 2026-11-01).
//
// Lock order, as in `src/people.ts`: the account and the device (`lockActor`
// in the API), then the people in the order of their IDs, in one statement:
// the acting person, the owner, the person that holds the offer, and the
// person that a new offer names. A transfer therefore locks both people
// before it changes either. Only the owner makes an offer, and each function
// here locks the owner's row before it decides, so offers are made one after
// another. A removal or a departure clears an offer to the removed person
// under the locks of the acting and the removed person (`removePerson`), so
// it waits for each function here that holds the target, and they for it.

/** A person that an ownership decision reads, locked. */
type OfferParty = Readonly<{
  id: MemberId;
  userId: UserId | null;
  role: MemberRole;
  removedAt: Date | null;
  ownershipOfferedAt: Date | null;
}>;

/** A person that holds the workspace's ownership offer, live or expired. */
type OfferHolder = OfferParty & Readonly<{ ownershipOfferedAt: Date }>;

/**
 * Locks, `FOR NO KEY UPDATE` in one statement and in the order of their IDs,
 * the acting account's active person, the workspace's active owner, the
 * person that holds the workspace's ownership offer, and, with `memberId`,
 * that person. PostgreSQL checks a row that changed while the statement
 * waited again, so an acting person removed in the meantime is not found,
 * and an offer cleared in the meantime is not reported. A person that
 * received an offer while the statement waited is reported only when another
 * rule names it, as the acting person or the new target: `offerOwnership`
 * reads the offer again for that reason, and a withdrawal or another
 * person's acceptance decides as if it came before that offer.
 */
async function lockOfferParties(
  tx: Database,
  input: Readonly<{
    workspaceId: WorkspaceId;
    userId: UserId;
    memberId?: MemberId;
  }>,
): Promise<{
  actor: OfferParty | undefined;
  owner: OfferParty | undefined;
  offered: OfferHolder | undefined;
  target: OfferParty | undefined;
}> {
  const rows = await tx
    .select({
      id: workspaceMembers.id,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      removedAt: workspaceMembers.removedAt,
      ownershipOfferedAt: workspaceMembers.ownershipOfferedAt,
    })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, input.workspaceId),
        or(
          and(
            eq(workspaceMembers.userId, input.userId),
            isNull(workspaceMembers.removedAt),
          ),
          and(
            eq(workspaceMembers.role, "owner"),
            isNull(workspaceMembers.removedAt),
          ),
          isNotNull(workspaceMembers.ownershipOfferedAt),
          input.memberId === undefined
            ? undefined
            : eq(workspaceMembers.id, input.memberId),
        ),
      ),
    )
    .orderBy(workspaceMembers.id)
    .for("no key update");
  return {
    actor: rows.find(
      (row) => row.userId === input.userId && row.removedAt === null,
    ),
    owner: rows.find((row) => row.role === "owner" && row.removedAt === null),
    offered: rows.find(
      (row): row is OfferHolder => row.ownershipOfferedAt !== null,
    ),
    target: rows.find((row) => row.id === input.memberId),
  };
}

/** The time at which an offer made at `offeredAt` stops being an offer. */
function expiryOf(offeredAt: Date): Date {
  return new Date(offeredAt.getTime() + OWNERSHIP_OFFER_LIFETIME_MS);
}

/** Whether the offer is still an offer at `now`, as `workspaceView` decides. */
function isLive(holder: OfferHolder, now: Date): boolean {
  return expiryOf(holder.ownershipOfferedAt).getTime() > now.getTime();
}

/**
 * An ownership offer that ended without a transfer, for the
 * `account.ownership_offer_ended` frame that the server sends to the
 * target's account after the commit.
 */
export type EndedOwnershipOffer = Readonly<{
  /** The person that the offer named. */
  memberId: MemberId;
  /** The account that claimed that person. */
  userId: UserId;
  reason: OwnershipOfferEndReason;
  /** When the owner withdrew the offer (`now`), or when it expired. */
  endedAt: Date;
}>;

/**
 * Clears the offer that `holder` holds, at `now`, and reports how it ended.
 * The CHECK on `workspace_members` allows an offer only on a claimed person.
 */
async function endOffer(
  tx: Database,
  holder: OfferHolder,
  reason: OwnershipOfferEndReason,
  now: Date,
): Promise<EndedOwnershipOffer> {
  if (holder.userId === null) {
    throw new Error("An ownership offer names a claimed person");
  }
  await tx
    .update(workspaceMembers)
    .set({ ownershipOfferedAt: null, updatedAt: now })
    .where(eq(workspaceMembers.id, holder.id));
  return Object.freeze({
    memberId: holder.id,
    userId: holder.userId,
    reason,
    endedAt: reason === "expired" ? expiryOf(holder.ownershipOfferedAt) : now,
  });
}

export type OfferOwnershipInput = Actor & Readonly<{ memberId: MemberId }>;

export type OfferOwnershipResult =
  | Readonly<{
      offered: true;
      /** The new offer, as the workspace view and the account frame show it. */
      offer: OwnershipOffer;
      /** The account that claimed the target, which the server tells. */
      userId: UserId;
      /** The expired offer that the new one replaced, or null. */
      ended: EndedOwnershipOffer | null;
    }>
  | Readonly<{
      offered: false;
      /** `device_too_new`: the acting device is not older than `DEVICE_TOO_NEW_MS`. */
      refusal: PersonRefusal | "device_too_new";
    }>;

/**
 * Offers the ownership of the workspace to another active, claimed person,
 * an admin or a member, in one transaction (ADR 0014, "People and roles" and
 * "Removal and ownership"): only the owner, from a device that is older than
 * `DEVICE_TOO_NEW_MS` at `now`. Anyone else, and an offer to the owner's own
 * person, is `forbidden`; a device exactly that old or younger is
 * `device_too_new`; a
 * removed or unclaimed person, and a workspace that already has a live
 * offer, to this person or another, are `conflict`. The device age is
 * decided after the role and before the person's state, as for a promotion.
 * A refusal writes nothing.
 *
 * An offer that expired by `now` is no offer: the new offer clears it first
 * and reports it as `ended` with the reason `expired`. It sets
 * `ownership_offered_at` of the person to `now`, so that the offer expires
 * `OWNERSHIP_OFFER_LIFETIME_MS` later, and writes an `ownership.offered`
 * audit record. Inside another transaction it runs as a savepoint.
 */
export async function offerOwnership(
  db: Database,
  input: OfferOwnershipInput,
): Promise<OfferOwnershipResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<OfferOwnershipResult> => {
      const { actor, target, offered } = await lockOfferParties(tx, input);
      if (actor === undefined) {
        return { offered: false, refusal: "not_member" };
      }
      if (target === undefined) {
        return { offered: false, refusal: "not_found" };
      }
      if (actor.role !== "owner" || target.role === "owner") {
        return { offered: false, refusal: "forbidden" };
      }
      if (!(await deviceOldEnough(tx, input))) {
        return { offered: false, refusal: "device_too_new" };
      }
      if (target.removedAt !== null || target.userId === null) {
        return { offered: false, refusal: "conflict" };
      }
      if (offered !== undefined && isLive(offered, input.now)) {
        return { offered: false, refusal: "conflict" };
      }
      // An offer that another device of the owner made while the lock waited
      // for the owner's row is not among the locked rows when it names a
      // third person. Offers are made only under the owner's lock, which
      // this transaction holds now, so a new read sees every offer.
      const [current] = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            isNotNull(workspaceMembers.ownershipOfferedAt),
          ),
        );
      if (current !== undefined && current.id !== offered?.id) {
        return { offered: false, refusal: "conflict" };
      }
      const ended =
        offered === undefined
          ? null
          : await endOffer(tx, offered, "expired", input.now);
      await tx
        .update(workspaceMembers)
        .set({ ownershipOfferedAt: input.now, updatedAt: input.now })
        .where(eq(workspaceMembers.id, target.id));
      await audit(tx, input, "ownership.offered", target.id);
      return {
        offered: true,
        offer: Object.freeze({
          memberId: target.id,
          offeredAt: input.now.toISOString(),
          expiresAt: expiryOf(input.now).toISOString(),
        }),
        userId: target.userId,
        ended,
      };
    }),
  );
}

export type AcceptOwnershipOfferInput = Actor;

export type AcceptOwnershipOfferResult =
  | Readonly<{
      accepted: true;
      /** The former owner, an `admin` now. */
      previousOwnerMemberId: MemberId;
      /**
       * The account that claimed the former owner, which the server tells
       * with the acting account.
       */
      previousOwnerUserId: UserId;
      /** The acting account's person, the `owner` now. */
      ownerMemberId: MemberId;
    }>
  | Readonly<{
      accepted: false;
      refusal: Exclude<PersonRefusal, "not_found">;
      /**
       * The expired offer to the acting person, which the refusal cleared and
       * committed; null when the refusal wrote nothing.
       */
      ended: EndedOwnershipOffer | null;
    }>;

/**
 * The target accepts the workspace's live ownership offer in one transaction
 * (ADR 0014, "People and roles" and "Removal and ownership"), from any of the
 * target's devices: it makes the owner an `admin` and then the target the
 * `owner`, in two statements in this order, so that the unique index of one
 * owner never sees two, and clears the offer in the second. Writes an
 * `ownership.transferred` audit record with the target as the subject.
 *
 * The owner is `forbidden`, and so is any other person while the offer names
 * someone else. Without a live offer it is `conflict`: no offer, and an
 * offer that expired by `now`, which counts as no offer. An expired offer to
 * the acting person is cleared and reported as `ended`, and this refusal
 * commits; every other refusal writes nothing. Inside another transaction it
 * runs as a savepoint.
 */
export async function acceptOwnershipOffer(
  db: Database,
  input: AcceptOwnershipOfferInput,
): Promise<AcceptOwnershipOfferResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<AcceptOwnershipOfferResult> => {
      const { actor, owner, offered } = await lockOfferParties(tx, input);
      if (actor === undefined) {
        return { accepted: false, refusal: "not_member", ended: null };
      }
      if (actor.role === "owner") {
        return { accepted: false, refusal: "forbidden", ended: null };
      }
      if (offered === undefined) {
        return { accepted: false, refusal: "conflict", ended: null };
      }
      if (!isLive(offered, input.now)) {
        const ended =
          offered.id === actor.id
            ? await endOffer(tx, offered, "expired", input.now)
            : null;
        return { accepted: false, refusal: "conflict", ended };
      }
      if (offered.id !== actor.id) {
        return { accepted: false, refusal: "forbidden", ended: null };
      }
      // A workspace always has one active owner; the transfer keeps it so.
      if (owner === undefined) {
        return { accepted: false, refusal: "conflict", ended: null };
      }
      // The CHECK on `workspace_members` keeps an unclaimed person a `member`.
      if (owner.userId === null) {
        throw new Error("An owner is a claimed person");
      }
      await tx
        .update(workspaceMembers)
        .set({ role: "admin", updatedAt: input.now })
        .where(eq(workspaceMembers.id, owner.id));
      await tx
        .update(workspaceMembers)
        .set({ role: "owner", ownershipOfferedAt: null, updatedAt: input.now })
        .where(eq(workspaceMembers.id, actor.id));
      await audit(tx, input, "ownership.transferred", actor.id);
      return {
        accepted: true,
        previousOwnerMemberId: owner.id,
        previousOwnerUserId: owner.userId,
        ownerMemberId: actor.id,
      };
    }),
  );
}

export type WithdrawOwnershipOfferInput = Actor;

export type WithdrawOwnershipOfferResult =
  | Readonly<{
      withdrawn: true;
      /** The withdrawn offer, with the reason `withdrawn` and `now`. */
      ended: EndedOwnershipOffer;
    }>
  | Readonly<{
      withdrawn: false;
      refusal: Exclude<PersonRefusal, "not_found">;
      /**
       * The expired offer, which the refusal cleared and committed; null
       * when the refusal wrote nothing.
       */
      ended: EndedOwnershipOffer | null;
    }>;

/**
 * The owner withdraws the workspace's live ownership offer in one
 * transaction (ADR 0014, "Removal and ownership"), from any of the owner's
 * devices: it clears the offer and writes an `ownership.offer_withdrawn`
 * audit record with the target as the subject. Anyone else is `forbidden`.
 * Without a live offer it is `conflict`; an offer that expired by `now` is
 * cleared and reported as `ended` with the reason `expired`, and this
 * refusal commits; every other refusal writes nothing. Inside another
 * transaction it runs as a savepoint.
 *
 * An offer that another device of the owner makes while the withdrawal waits
 * for the owner's row is not withdrawn: the withdrawal decides as if it came
 * first, so it is `conflict` when no other offer was live, and the new offer
 * stays until the next withdrawal. Both requests come from the owner, and
 * either order is one that the owner could have chosen; withdrawing it would
 * need its row locked out of the order of IDs.
 */
export async function withdrawOwnershipOffer(
  db: Database,
  input: WithdrawOwnershipOfferInput,
): Promise<WithdrawOwnershipOfferResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<WithdrawOwnershipOfferResult> => {
      const { actor, offered } = await lockOfferParties(tx, input);
      if (actor === undefined) {
        return { withdrawn: false, refusal: "not_member", ended: null };
      }
      if (actor.role !== "owner") {
        return { withdrawn: false, refusal: "forbidden", ended: null };
      }
      if (offered === undefined) {
        return { withdrawn: false, refusal: "conflict", ended: null };
      }
      if (!isLive(offered, input.now)) {
        const ended = await endOffer(tx, offered, "expired", input.now);
        return { withdrawn: false, refusal: "conflict", ended };
      }
      const ended = await endOffer(tx, offered, "withdrawn", input.now);
      await audit(tx, input, "ownership.offer_withdrawn", offered.id);
      return { withdrawn: true, ended };
    }),
  );
}
