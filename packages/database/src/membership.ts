import {
  type DeviceId,
  type IdentityProvider,
  MAX_ANSWER_LIST_ITEMS,
  type MemberId,
  type MemberRole,
  newId,
  newUuidV7,
  type OwnershipOffer,
  UNCLAIMED_MEMBER_LIMIT,
  type UserId,
  type WorkspaceId,
  type WorkspaceMember,
  type WorkspaceMembership,
  type WorkspaceViewResponse,
} from "@mymandev/protocol";
import { and, count, desc, eq, gt, isNull, min, sql } from "drizzle-orm";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import {
  auditEvents,
  userIdentities,
  users,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";

// Workspaces and the people in them (ADR 0014, "People and roles", "Limits",
// and "What a workspace ID allows").

const DAY_MS = 24 * 60 * 60_000;
/** ADR 0014, "Limits". */
const MAX_NEW_WORKSPACES_PER_DAY = 10;
/**
 * How long an ownership offer lives (ADR 0014, "Lifetimes"): an offer made
 * this long before `now` or longer is no offer.
 */
export const OWNERSHIP_OFFER_LIFETIME_MS = 7 * DAY_MS;

/** A person with the sign-in identity of the account that claimed it. */
const memberColumns = {
  id: workspaceMembers.id,
  workspaceId: workspaceMembers.workspaceId,
  displayName: workspaceMembers.displayName,
  role: workspaceMembers.role,
  userId: workspaceMembers.userId,
  removedAt: workspaceMembers.removedAt,
  provider: userIdentities.identityProvider,
  login: userIdentities.login,
  verifiedAt: userIdentities.lastSignInAt,
};

type MemberRow = Readonly<{
  id: MemberId;
  workspaceId: WorkspaceId;
  displayName: string;
  role: MemberRole;
  userId: UserId | null;
  removedAt: Date | null;
  provider: IdentityProvider | null;
  login: string | null;
  verifiedAt: Date | null;
}>;

/**
 * The join from a person to its account's identity. GitHub is the only
 * sign-in method, and an unclaimed person matches no identity.
 */
const identityOfMember = and(
  eq(userIdentities.userId, workspaceMembers.userId),
  eq(userIdentities.identityProvider, "github"),
);

/**
 * A person as the protocol shows it. The login was last verified at the
 * account's last sign-in; an erased identity has no login, and the person
 * then has no identity (P-62).
 */
function toMember(row: MemberRow): WorkspaceMember {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    displayName: row.displayName,
    role: row.role,
    userId: row.userId,
    identity:
      row.provider === null || row.login === null || row.verifiedAt === null
        ? null
        : {
            provider: row.provider,
            login: row.login,
            verifiedAt: row.verifiedAt.toISOString(),
          },
    removedAt: row.removedAt?.toISOString() ?? null,
  };
}

/**
 * One person with the sign-in identity of its account, as the protocol shows
 * it; undefined when the person does not exist. For the functions of this
 * package, which run it through `withDatabaseErrors`.
 */
export async function memberById(
  db: Database,
  memberId: MemberId,
): Promise<WorkspaceMember | undefined> {
  const [row] = await db
    .select(memberColumns)
    .from(workspaceMembers)
    .leftJoin(userIdentities, identityOfMember)
    .where(eq(workspaceMembers.id, memberId));
  return row === undefined ? undefined : toMember(row);
}

export type CreateWorkspaceInput = Readonly<{
  userId: UserId;
  /** The account's device that asks, recorded as the actor's device. */
  deviceId: DeviceId;
  name: string;
  /** The creator's person name in the new workspace. */
  displayName: string;
  /**
   * How many active unclaimed people the workspace may hold, from 1 to 500;
   * `UNCLAIMED_MEMBER_LIMIT.default` (500) when omitted. Outside the range
   * the CHECK fails.
   */
  maxUnclaimedMembers?: number;
  now: Date;
}>;

export type CreateWorkspaceResult =
  | Readonly<{ created: true; membership: WorkspaceMembership }>
  /**
   * The account created 10 workspaces in the last 24 hours. The oldest of
   * them leaves the window after `retryAfterMs`.
   */
  | Readonly<{ created: false; retryAfterMs: number }>;

/**
 * Creates a workspace in one transaction (ADR 0014, "People and roles" and
 * "Limits"): it locks the account's row, so that concurrent creations of one
 * account are counted one after another; refuses an 11th workspace that the
 * account created within 24 hours; inserts the workspace with its limit of
 * unclaimed people and the creator's person as the claimed `owner` with
 * `displayName`; and writes a `workspace.created` audit record. Every row
 * gets the time `now`. `workspaces.created_by_user_id` stays a historical
 * fact; ownership lives in the role. Inside another transaction it runs as a
 * savepoint.
 */
export async function createWorkspace(
  db: Database,
  input: CreateWorkspaceInput,
): Promise<CreateWorkspaceResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<CreateWorkspaceResult> => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .for("no key update");
      const [recent] = await tx
        .select({ n: count(), oldest: min(workspaces.createdAt) })
        .from(workspaces)
        .where(
          and(
            eq(workspaces.createdByUserId, input.userId),
            gt(workspaces.createdAt, new Date(input.now.getTime() - DAY_MS)),
          ),
        );
      if ((recent?.n ?? 0) >= MAX_NEW_WORKSPACES_PER_DAY) {
        const oldest = recent?.oldest ?? input.now;
        return {
          created: false,
          retryAfterMs: oldest.getTime() + DAY_MS - input.now.getTime(),
        };
      }

      const workspaceId = newId<WorkspaceId>();
      const memberId = newId<MemberId>();
      await tx.insert(workspaces).values({
        id: workspaceId,
        name: input.name,
        createdByUserId: input.userId,
        createdAt: input.now,
        updatedAt: input.now,
        maxUnclaimedMembers:
          input.maxUnclaimedMembers ?? UNCLAIMED_MEMBER_LIMIT.default,
      });
      await tx.insert(workspaceMembers).values({
        id: memberId,
        workspaceId,
        userId: input.userId,
        displayName: input.displayName,
        role: "owner",
        addedByUserId: input.userId,
        createdAt: input.now,
        updatedAt: input.now,
        claimedAt: input.now,
      });
      await tx.insert(auditEvents).values({
        id: newUuidV7(),
        createdAt: input.now,
        action: "workspace.created",
        actorUserId: input.userId,
        actorDeviceId: input.deviceId,
        workspaceId,
        subjectId: workspaceId,
      });

      const [identity] = await tx
        .select({
          provider: userIdentities.identityProvider,
          login: userIdentities.login,
          verifiedAt: userIdentities.lastSignInAt,
        })
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.userId, input.userId),
            eq(userIdentities.identityProvider, "github"),
          ),
        );
      return {
        created: true,
        membership: {
          workspace: { id: workspaceId, name: input.name },
          member: toMember({
            id: memberId,
            workspaceId,
            displayName: input.displayName,
            role: "owner",
            userId: input.userId,
            removedAt: null,
            provider: identity?.provider ?? null,
            login: identity?.login ?? null,
            verifiedAt: identity?.verifiedAt ?? null,
          }),
        },
      };
    }),
  );
}

/**
 * The workspaces that the account is an active member of, each with the
 * account's own person: the answer of `GET /workspaces`. The most recently
 * claimed come first, at most `MAX_ANSWER_LIST_ITEMS`.
 */
export async function listWorkspaces(
  db: Database,
  userId: UserId,
): Promise<WorkspaceMembership[]> {
  return withDatabaseErrors(async () => {
    const rows = await db
      .select({ workspaceName: workspaces.name, ...memberColumns })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .leftJoin(userIdentities, identityOfMember)
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          isNull(workspaceMembers.removedAt),
        ),
      )
      .orderBy(desc(workspaceMembers.claimedAt), desc(workspaceMembers.id))
      .limit(MAX_ANSWER_LIST_ITEMS);
    return rows.map(({ workspaceName, ...row }) => ({
      workspace: { id: row.workspaceId, name: workspaceName },
      member: toMember(row),
    }));
  });
}

/**
 * The ownership offer on one of the people, unless it expired by `now`. A
 * CHECK and a unique index keep the offer on at most one active, claimed
 * person who is not the owner.
 */
function liveOffer(
  rows: readonly Readonly<{ id: MemberId; ownershipOfferedAt: Date | null }>[],
  now: Date,
): OwnershipOffer | null {
  for (const row of rows) {
    if (row.ownershipOfferedAt === null) {
      continue;
    }
    const expiresAt =
      row.ownershipOfferedAt.getTime() + OWNERSHIP_OFFER_LIFETIME_MS;
    if (expiresAt <= now.getTime()) {
      return null;
    }
    return {
      memberId: row.id,
      offeredAt: row.ownershipOfferedAt.toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  return null;
}

export type WorkspaceViewInput = Readonly<{
  workspaceId: WorkspaceId;
  /** An ownership offer made 7 days or more before `now` is over. */
  now: Date;
}>;

/**
 * A workspace as its active members see it: the answer of
 * `GET /workspaces/:workspaceId`. It holds every person, unclaimed, active,
 * and former, each with the login of its account and the time that login was
 * last verified (`user_identities.last_sign_in_at`); whether join requests are
 * paused; how many active unclaimed people the workspace may hold; and the
 * ownership offer that has not expired. undefined when the workspace does
 * not exist. The caller checks membership first.
 *
 * The people are cut to `MAX_ANSWER_LIST_ITEMS`, in an order that never
 * drops those whom the view's rules name and in which unclaimed people never
 * push out claimed ones: the active owner, the target of the offer, the other
 * active claimed people, then the active unclaimed people, each the most
 * recently created first, then former members, the most recently removed
 * first.
 */
export async function workspaceView(
  db: Database,
  input: WorkspaceViewInput,
): Promise<WorkspaceViewResponse | undefined> {
  return withDatabaseErrors(async () => {
    const [workspace] = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        joinRequestsPausedAt: workspaces.joinRequestsPausedAt,
        maxUnclaimedMembers: workspaces.maxUnclaimedMembers,
      })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId));
    if (workspace === undefined) {
      return undefined;
    }
    const rows = await db
      .select({
        ...memberColumns,
        ownershipOfferedAt: workspaceMembers.ownershipOfferedAt,
      })
      .from(workspaceMembers)
      .leftJoin(userIdentities, identityOfMember)
      .where(eq(workspaceMembers.workspaceId, input.workspaceId))
      .orderBy(
        sql`${workspaceMembers.removedAt} is not null`,
        sql`${workspaceMembers.role} <> 'owner'`,
        sql`${workspaceMembers.ownershipOfferedAt} is null`,
        sql`${workspaceMembers.removedAt} is null and ${workspaceMembers.userId} is null`,
        desc(workspaceMembers.removedAt),
        desc(workspaceMembers.createdAt),
        desc(workspaceMembers.id),
      )
      .limit(MAX_ANSWER_LIST_ITEMS);

    return {
      workspace: { id: workspace.id, name: workspace.name },
      members: rows.map(toMember),
      joinRequestsPausedAt:
        workspace.joinRequestsPausedAt?.toISOString() ?? null,
      maxUnclaimedMembers: workspace.maxUnclaimedMembers,
      ownershipOffer: liveOffer(rows, input.now),
    };
  });
}

export type ActiveMemberInput = Readonly<{
  workspaceId: WorkspaceId;
  userId: UserId;
}>;

/** The account's active person in a workspace, as the membership check needs it. */
export type ActivePerson = Readonly<{ id: MemberId; role: MemberRole }>;

/**
 * The account's active person in the workspace: the claimed person whose
 * `removed_at` is empty (ADR 0014, "People and roles"). undefined when the
 * account is not an active member, also when the workspace does not exist, so
 * that the caller answers both alike ("What a workspace ID allows").
 */
export async function activePersonOf(
  db: Database,
  input: ActiveMemberInput,
): Promise<ActivePerson | undefined> {
  return withDatabaseErrors(async () => {
    const [person] = await db
      .select({ id: workspaceMembers.id, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.userId),
          isNull(workspaceMembers.removedAt),
        ),
      );
    return person;
  });
}
