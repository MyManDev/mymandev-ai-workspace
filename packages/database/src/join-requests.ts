import {
  type DeviceId,
  type JoinRequest,
  type JoinRequestDecision,
  type JoinRequestId,
  MAX_ANSWER_LIST_ITEMS,
  type MemberId,
  newId,
  type OwnJoinRequest,
  type OwnJoinRequestListItem,
  type UserId,
  type WorkspaceId,
  type WorkspaceMember,
} from "@mymandev/protocol";
import {
  and,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  max,
  min,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { idIn } from "./cascade.ts";
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
  users,
  workspaceJoinRequests,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";

// Join requests (ADR 0014, "Join requests", "Limits", "Lifetimes", and "What
// a workspace ID allows"). A request is pending while it has no decision and
// its expiry lies after `now`; a request past its expiry is not pending even
// before it is marked `expired` (Project Manager decision of 2026-11-01).
//
// Lock order, the order of `src/people.ts` extended: the account (`users`),
// then the device (`devices`), as `lockActor` in the API does; then the people
// (`workspace_members`) in the order of their IDs; then the join request
// rows, several in the order of their IDs; then the workspace row
// (`workspaces`), only where the counts of the workspace or its pause need
// it. Creating a request locks the account, then the account's open row in
// the workspace, then the workspace row. Approving, denying, blocking, and
// unblocking lock the acting person, then the request. Denying all locks the
// acting person, then the pending requests of the workspace in the order of
// their IDs. Pausing and resuming lock the acting person, then the workspace
// row. Withdrawing locks only the request after the account and the device.

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** ADR 0014, "Lifetimes": 7 days, counted as 168 hours. */
const JOIN_REQUEST_LIFETIME_MS = 168 * HOUR_MS;
/** ADR 0014, "Limits". */
const MAX_PENDING_PER_ACCOUNT = 5;
/** ADR 0014, "Limits". */
const MAX_NEW_PER_ACCOUNT_PER_DAY = 10;
/** ADR 0014, "Limits". */
const MAX_PENDING_PER_WORKSPACE = 50;
/** ADR 0014, "Limits": a denied account asks the same workspace again after 24 hours. */
const WAIT_AFTER_DENIAL_MS = DAY_MS;

/** The unique index that allows one active person per account and workspace. */
const ACTIVE_PERSON_KEY = "workspace_members_active_user_key";

/** A request without a decision whose expiry lies after `now`. */
function pending(now: Date) {
  return and(
    isNull(workspaceJoinRequests.decision),
    gt(workspaceJoinRequests.expiresAt, now),
  );
}

/** What the requester sent, as the requester sees a request. */
const ownColumns = {
  id: workspaceJoinRequests.id,
  workspaceId: workspaceJoinRequests.workspaceId,
  requestedDisplayName: workspaceJoinRequests.requestedDisplayName,
  createdAt: workspaceJoinRequests.createdAt,
  expiresAt: workspaceJoinRequests.expiresAt,
};

type OwnRow = Readonly<{
  id: JoinRequestId;
  workspaceId: WorkspaceId;
  requestedDisplayName: string;
  createdAt: Date;
  expiresAt: Date;
}>;

function toOwn(row: OwnRow): OwnJoinRequest {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    requestedDisplayName: row.requestedDisplayName,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export type CreateJoinRequestInput = Readonly<{
  /** The workspace that the account asks to join, named by its ID. */
  workspaceId: WorkspaceId;
  /** The account that asks. */
  userId: UserId;
  /** The account's device that asks, stored on the request and recorded as the actor's device. */
  deviceId: DeviceId;
  /** The display name that the requester asks for. */
  displayName: string;
  now: Date;
}>;

/**
 * Why a join request was refused (ADR 0014, "What a workspace ID allows").
 * Nothing was written.
 *
 * - `workspace_not_found`: no workspace has the ID, or it is archived;
 * - `already_member`: the account is an active member of the workspace;
 * - `join_requests_closed`: the workspace pauses new requests, or it blocks
 *   the account.
 */
export type JoinRequestRefusal =
  "workspace_not_found" | "already_member" | "join_requests_closed";

export type CreateJoinRequestResult =
  | Readonly<{
      requested: true;
      /** false when the account's pending request was returned instead. */
      created: boolean;
      joinRequest: OwnJoinRequest;
    }>
  | Readonly<{ requested: false; refusal: JoinRequestRefusal }>
  /**
   * A limit of ADR 0014 is reached. After `retryAfterMs`, the limit that was
   * reached no longer is; with several reached, the latest of their times.
   */
  | Readonly<{
      requested: false;
      refusal: "rate_limited";
      retryAfterMs: number;
    }>;

/**
 * How long a new request must wait for the limits of ADR 0014, or null when
 * none is reached: 24 hours after the account's latest denial in the
 * workspace; 5 pending requests of the account, until the first of them
 * expires; 10 requests of the account created within 24 hours, until the
 * oldest leaves the window; and 50 pending requests in the workspace, until
 * the first of them expires, rounded up to the next full hour, so that the
 * answer does not tell when another account asked. A pending request ends
 * at the latest at its expiry. The waits of the account's own requests stay
 * exact.
 */
async function limitWait(
  tx: Database,
  input: CreateJoinRequestInput,
): Promise<number | null> {
  const now = input.now.getTime();
  const dayBefore = new Date(now - DAY_MS);
  const waits: number[] = [];

  const [denied] = await tx
    .select({ latest: max(workspaceJoinRequests.decidedAt) })
    .from(workspaceJoinRequests)
    .where(
      and(
        eq(workspaceJoinRequests.workspaceId, input.workspaceId),
        eq(workspaceJoinRequests.requesterUserId, input.userId),
        eq(workspaceJoinRequests.decision, "denied"),
        gt(
          workspaceJoinRequests.decidedAt,
          new Date(now - WAIT_AFTER_DENIAL_MS),
        ),
      ),
    );
  if (denied?.latest != null) {
    waits.push(denied.latest.getTime() + WAIT_AFTER_DENIAL_MS - now);
  }

  const [own] = await tx
    .select({ n: count(), soonest: min(workspaceJoinRequests.expiresAt) })
    .from(workspaceJoinRequests)
    .where(
      and(
        eq(workspaceJoinRequests.requesterUserId, input.userId),
        pending(input.now),
      ),
    );
  if ((own?.n ?? 0) >= MAX_PENDING_PER_ACCOUNT) {
    waits.push((own?.soonest ?? input.now).getTime() - now);
  }

  const [recent] = await tx
    .select({ n: count(), oldest: min(workspaceJoinRequests.createdAt) })
    .from(workspaceJoinRequests)
    .where(
      and(
        eq(workspaceJoinRequests.requesterUserId, input.userId),
        gt(workspaceJoinRequests.createdAt, dayBefore),
      ),
    );
  if ((recent?.n ?? 0) >= MAX_NEW_PER_ACCOUNT_PER_DAY) {
    waits.push((recent?.oldest ?? input.now).getTime() + DAY_MS - now);
  }

  const [inWorkspace] = await tx
    .select({ n: count(), soonest: min(workspaceJoinRequests.expiresAt) })
    .from(workspaceJoinRequests)
    .where(
      and(
        eq(workspaceJoinRequests.workspaceId, input.workspaceId),
        pending(input.now),
      ),
    );
  if ((inWorkspace?.n ?? 0) >= MAX_PENDING_PER_WORKSPACE) {
    const exact = (inWorkspace?.soonest ?? input.now).getTime() - now;
    waits.push(Math.ceil(exact / HOUR_MS) * HOUR_MS);
  }

  return waits.length === 0 ? null : Math.max(...waits);
}

/**
 * Asks to join a workspace as a new person, in one transaction (ADR 0014,
 * "Join requests", "Limits", and "What a workspace ID allows"). It decides
 * in this order, and a refusal writes nothing:
 *
 * 1. a workspace that does not exist or is archived is `workspace_not_found`;
 * 2. an active member of it is `already_member`;
 * 3. the account's pending request in the workspace is returned unchanged,
 *    with `created: false`, also while requests are paused (awaiting the
 *    Project Manager's confirmation);
 * 4. a paused workspace, or a block of the account in force, is
 *    `join_requests_closed`;
 * 5. a limit of ADR 0014 is `rate_limited` with `retryAfterMs`.
 *
 * Otherwise it marks the account's earlier request in the workspace that is
 * past its expiry but still unmarked as `expired`, with `decided_at` set to
 * its expiry and no audit record, and only then stores the new request with
 * the requested display name, the device, `created_at` set to `now`, and
 * `expires_at` 7 days later; it writes a `join_request.created` audit
 * record. It locks the account's row first, so that the requests of one
 * account are counted one after another, then the account's open row in
 * the workspace, then the workspace row, so that the requests of one
 * workspace are counted one after another and a pause is seen. Inside
 * another transaction it runs as a savepoint.
 */
export async function createJoinRequest(
  db: Database,
  input: CreateJoinRequestInput,
): Promise<CreateJoinRequestResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<CreateJoinRequestResult> => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .for("no key update");
      const [workspace] = await tx
        .select({ archivedAt: workspaces.archivedAt })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId));
      if (workspace === undefined || workspace.archivedAt !== null) {
        return { requested: false, refusal: "workspace_not_found" };
      }

      // The account's row without a decision in this workspace, at most one
      // by the unique index, before the workspace row. Locking it waits for
      // an approval that holds it, so that the membership check below sees
      // the approval's person.
      const [open] = await tx
        .select(ownColumns)
        .from(workspaceJoinRequests)
        .where(
          and(
            eq(workspaceJoinRequests.workspaceId, input.workspaceId),
            eq(workspaceJoinRequests.requesterUserId, input.userId),
            isNull(workspaceJoinRequests.decision),
          ),
        )
        .for("no key update");
      if ((await activePersonOf(tx, input)) !== undefined) {
        return { requested: false, refusal: "already_member" };
      }
      if (open !== undefined && open.expiresAt > input.now) {
        return { requested: true, created: false, joinRequest: toOwn(open) };
      }

      const [locked] = await tx
        .select({
          archivedAt: workspaces.archivedAt,
          joinRequestsPausedAt: workspaces.joinRequestsPausedAt,
        })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .for("no key update");
      if (locked === undefined || locked.archivedAt !== null) {
        return { requested: false, refusal: "workspace_not_found" };
      }
      const [block] = await tx
        .select({ id: workspaceJoinRequests.id })
        .from(workspaceJoinRequests)
        .where(
          and(
            eq(workspaceJoinRequests.workspaceId, input.workspaceId),
            eq(workspaceJoinRequests.requesterUserId, input.userId),
            eq(workspaceJoinRequests.decision, "blocked"),
            isNull(workspaceJoinRequests.unblockedAt),
          ),
        )
        .limit(1);
      if (locked.joinRequestsPausedAt !== null || block !== undefined) {
        return { requested: false, refusal: "join_requests_closed" };
      }
      const retryAfterMs = await limitWait(tx, input);
      if (retryAfterMs !== null) {
        return { requested: false, refusal: "rate_limited", retryAfterMs };
      }

      if (open !== undefined) {
        await tx
          .update(workspaceJoinRequests)
          .set({ decision: "expired", decidedAt: open.expiresAt })
          .where(eq(workspaceJoinRequests.id, open.id));
      }
      const joinRequest = {
        id: newId<JoinRequestId>(),
        workspaceId: input.workspaceId,
        requestedDisplayName: input.displayName,
        createdAt: input.now,
        expiresAt: new Date(input.now.getTime() + JOIN_REQUEST_LIFETIME_MS),
      };
      await tx.insert(workspaceJoinRequests).values({
        ...joinRequest,
        requesterUserId: input.userId,
        requesterDeviceId: input.deviceId,
      });
      await audit(tx, input, "join_request.created", joinRequest.id);
      return {
        requested: true,
        created: true,
        joinRequest: toOwn(joinRequest),
      };
    }),
  );
}

export type ListOwnJoinRequestsInput = Readonly<{
  /** The account whose requests are listed. */
  userId: UserId;
  /** A request without a decision whose expiry is `now` or earlier is shown as `expired`. */
  now: Date;
}>;

/**
 * The account's own join requests with how each ended, as the requester
 * sees them: the answer of `GET /join-requests`. The most recently created
 * first, at most `MAX_ANSWER_LIST_ITEMS`. A block is shown as `denied`, and a
 * request without a decision whose expiry is `now` or earlier as `expired`,
 * with its expiry as `decidedAt`, which is the time that marking it later
 * stores too. Nothing about the workspace or the approver leaves the
 * database.
 */
export async function listOwnJoinRequests(
  db: Database,
  input: ListOwnJoinRequestsInput,
): Promise<OwnJoinRequestListItem[]> {
  return withDatabaseErrors(async () => {
    const rows = await db
      .select({
        ...ownColumns,
        decision: workspaceJoinRequests.decision,
        decidedAt: workspaceJoinRequests.decidedAt,
      })
      .from(workspaceJoinRequests)
      .where(eq(workspaceJoinRequests.requesterUserId, input.userId))
      .orderBy(
        desc(workspaceJoinRequests.createdAt),
        desc(workspaceJoinRequests.id),
      )
      .limit(MAX_ANSWER_LIST_ITEMS);
    return rows.map((row): OwnJoinRequestListItem => {
      if (row.decision === null) {
        const expired = row.expiresAt <= input.now;
        return {
          ...toOwn(row),
          decision: expired ? "expired" : null,
          decidedAt: expired ? row.expiresAt.toISOString() : null,
        };
      }
      return {
        ...toOwn(row),
        decision: row.decision === "blocked" ? "denied" : row.decision,
        decidedAt: row.decidedAt?.toISOString() ?? null,
      };
    });
  });
}

export type WithdrawJoinRequestInput = Readonly<{
  joinRequestId: JoinRequestId;
  /** The account that withdraws; only the requester can. */
  userId: UserId;
  /** The account's device that asks, recorded as the actor's device. */
  deviceId: DeviceId;
  /** A request whose expiry is `now` or earlier is no longer pending. */
  now: Date;
}>;

export type WithdrawJoinRequestResult =
  | Readonly<{ withdrawn: true; workspaceId: WorkspaceId }>
  /**
   * `not_found`: the account has no request with this ID, also when another
   * account has; `conflict`: the request is no longer pending.
   */
  | Readonly<{ withdrawn: false; refusal: "not_found" | "conflict" }>;

/**
 * The requester withdraws their own pending request, in one transaction
 * (ADR 0014, "Join requests"): it locks the request, sets `decision` to
 * `withdrawn`, `decided_at` to `now`, and `decided_by_user_id` to the
 * account, and writes a `join_request.withdrawn` audit record in the
 * request's workspace. A request of another account is `not_found`, as one
 * that does not exist; a request with a decision or past its expiry is
 * `conflict`. Inside another transaction it runs as a savepoint.
 */
export async function withdrawJoinRequest(
  db: Database,
  input: WithdrawJoinRequestInput,
): Promise<WithdrawJoinRequestResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<WithdrawJoinRequestResult> => {
      const [request] = await tx
        .select({
          workspaceId: workspaceJoinRequests.workspaceId,
          decision: workspaceJoinRequests.decision,
          expiresAt: workspaceJoinRequests.expiresAt,
        })
        .from(workspaceJoinRequests)
        .where(
          and(
            eq(workspaceJoinRequests.id, input.joinRequestId),
            eq(workspaceJoinRequests.requesterUserId, input.userId),
          ),
        )
        .for("no key update");
      if (request === undefined) {
        return { withdrawn: false, refusal: "not_found" };
      }
      if (request.decision !== null || request.expiresAt <= input.now) {
        return { withdrawn: false, refusal: "conflict" };
      }
      await tx
        .update(workspaceJoinRequests)
        .set({
          decision: "withdrawn",
          decidedAt: input.now,
          decidedByUserId: input.userId,
        })
        .where(eq(workspaceJoinRequests.id, input.joinRequestId));
      await audit(
        tx,
        { ...input, workspaceId: request.workspaceId },
        "join_request.withdrawn",
        input.joinRequestId,
      );
      return { withdrawn: true, workspaceId: request.workspaceId };
    }),
  );
}

export type ListJoinRequestsInput = Readonly<{
  workspaceId: WorkspaceId;
  /** The account that asks; its active person must be the owner or an admin. */
  userId: UserId;
  /** A request whose expiry is `now` or earlier is no longer pending. */
  now: Date;
}>;

export type ListJoinRequestsResult =
  | Readonly<{ listed: true; joinRequests: JoinRequest[] }>
  | Readonly<{ listed: false; refusal: "not_member" | "forbidden" }>;

/**
 * The join requests of a workspace in the approvers' view: the answer of
 * `GET /workspaces/:workspaceId/join-requests`. Only the owner and admins.
 * It holds the pending requests, then the blocked requests whose block is in
 * force, each the most recently created first, at most
 * `MAX_ANSWER_LIST_ITEMS`. Each shows the requested name and the requester's
 * GitHub login, the time it was last verified (the account's last sign-in),
 * and the creation date of the GitHub account. A pending request is left
 * out when its requester is already an active member of the workspace, for
 * example after accepting an invitation, because approving it could only
 * answer `already_member`; and when the requester's identity was erased,
 * because the approvers could not tell who asks. A block in force stays
 * listed, also of an erased account, which then has no requester.
 */
export async function listJoinRequests(
  db: Database,
  input: ListJoinRequestsInput,
): Promise<ListJoinRequestsResult> {
  return withDatabaseErrors(async () => {
    const person = await activePersonOf(db, input);
    if (person === undefined) {
      return { listed: false, refusal: "not_member" };
    }
    if (!administers(person.role)) {
      return { listed: false, refusal: "forbidden" };
    }
    const requesterIsMember = db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceJoinRequests.workspaceId),
          eq(workspaceMembers.userId, workspaceJoinRequests.requesterUserId),
          isNull(workspaceMembers.removedAt),
        ),
      );
    const rows = await db
      .select({
        ...ownColumns,
        decision: workspaceJoinRequests.decision,
        decidedAt: workspaceJoinRequests.decidedAt,
        provider: userIdentities.identityProvider,
        login: userIdentities.login,
        verifiedAt: userIdentities.lastSignInAt,
        accountCreatedAt: userIdentities.accountCreatedAt,
      })
      .from(workspaceJoinRequests)
      .leftJoin(
        userIdentities,
        and(
          eq(userIdentities.userId, workspaceJoinRequests.requesterUserId),
          eq(userIdentities.identityProvider, "github"),
        ),
      )
      .where(
        and(
          eq(workspaceJoinRequests.workspaceId, input.workspaceId),
          or(
            and(
              pending(input.now),
              isNotNull(userIdentities.login),
              notExists(requesterIsMember),
            ),
            and(
              eq(workspaceJoinRequests.decision, "blocked"),
              isNull(workspaceJoinRequests.unblockedAt),
            ),
          ),
        ),
      )
      .orderBy(
        sql`${workspaceJoinRequests.decision} is not null`,
        desc(workspaceJoinRequests.createdAt),
        desc(workspaceJoinRequests.id),
      )
      .limit(MAX_ANSWER_LIST_ITEMS);
    return {
      listed: true,
      joinRequests: rows.map((row) => ({
        ...toOwn(row),
        requester:
          row.provider === null ||
          row.login === null ||
          row.verifiedAt === null ||
          row.accountCreatedAt === null
            ? null
            : {
                provider: row.provider,
                login: row.login,
                verifiedAt: row.verifiedAt.toISOString(),
                accountCreatedAt: row.accountCreatedAt.toISOString(),
              },
        decision: row.decision,
        decidedAt: row.decidedAt?.toISOString() ?? null,
      })),
    };
  });
}

export type DecideJoinRequestInput = Actor &
  Readonly<{ joinRequestId: JoinRequestId }>;

type PendingRequest = Readonly<{
  id: JoinRequestId;
  requesterUserId: UserId;
  requestedDisplayName: string;
}>;

/**
 * Locks the acting person, then the request, and decides whether the actor
 * may decide on it: an account without an active person is `not_member`; a
 * request that the workspace does not have is `not_found`; a member is
 * `forbidden`; a request with a decision or past its expiry is `conflict`.
 * PostgreSQL reads a request that a concurrent decision changed again after
 * the lock, so of two decisions on one request only the first finds it
 * pending.
 */
async function lockPendingRequest(
  tx: Database,
  input: DecideJoinRequestInput,
): Promise<
  Readonly<{ refusal: PersonRefusal }> | Readonly<{ request: PendingRequest }>
> {
  const { actor } = await lockPeople(tx, input);
  if (actor === undefined) {
    return { refusal: "not_member" };
  }
  const [request] = await tx
    .select({
      id: workspaceJoinRequests.id,
      requesterUserId: workspaceJoinRequests.requesterUserId,
      requestedDisplayName: workspaceJoinRequests.requestedDisplayName,
      decision: workspaceJoinRequests.decision,
      expiresAt: workspaceJoinRequests.expiresAt,
    })
    .from(workspaceJoinRequests)
    .where(
      and(
        eq(workspaceJoinRequests.id, input.joinRequestId),
        eq(workspaceJoinRequests.workspaceId, input.workspaceId),
      ),
    )
    .for("no key update");
  if (request === undefined) {
    return { refusal: "not_found" };
  }
  if (!administers(actor.role)) {
    return { refusal: "forbidden" };
  }
  if (request.decision !== null || request.expiresAt <= input.now) {
    return { refusal: "conflict" };
  }
  return { request };
}

/** Records a decision of the acting account on a request at `now`. */
async function decide(
  tx: Database,
  input: DecideJoinRequestInput,
  decision: Extract<JoinRequestDecision, "approved" | "denied" | "blocked">,
  memberId: MemberId | null = null,
): Promise<void> {
  await tx
    .update(workspaceJoinRequests)
    .set({
      decision,
      decidedAt: input.now,
      decidedByUserId: input.userId,
      memberId,
    })
    .where(eq(workspaceJoinRequests.id, input.joinRequestId));
}

export type ApproveJoinRequestInput = DecideJoinRequestInput &
  Readonly<{
    /** The approver's name for the new person; the requested name when omitted. */
    displayName?: string;
  }>;

export type ApproveJoinRequestResult =
  | Readonly<{
      approved: true;
      /** The new claimed person with the role `member`. */
      member: WorkspaceMember;
      /** The account that asked, which the decision is sent to. */
      requesterUserId: UserId;
    }>
  | Readonly<{ approved: false; refusal: PersonRefusal | "already_member" }>;

/**
 * Approves a pending request in one transaction (ADR 0014, "Join requests"):
 * only the owner or an admin, with the refusals of `lockPendingRequest`. A
 * requester who is already an active member of the workspace is
 * `already_member`, and the request stays pending. Otherwise it creates a
 * new claimed person of the requester with the role `member`, the
 * approver's `displayName` or else the requested name, the approver as
 * `added_by_user_id`, and `created_at` and `claimed_at` set to `now`; a
 * requester who was removed earlier rejoins as this new person, and the
 * earlier person stays in the history. It sets the request's `decision` to
 * `approved` with `decided_at`, `decided_by_user_id`, and the new person as
 * `member_id`, and writes a `join_request.approved` and a `member.claimed`
 * audit record, both with the approver as the actor. When the requester
 * claimed another person of the workspace concurrently, the unique index of
 * one active person per account and workspace refuses the new person, the
 * transaction rolls back, and the result is `already_member`. Inside
 * another transaction it runs as a savepoint.
 */
export async function approveJoinRequest(
  db: Database,
  input: ApproveJoinRequestInput,
): Promise<ApproveJoinRequestResult> {
  return withDatabaseErrors(async () => {
    try {
      return await db.transaction(
        async (tx): Promise<ApproveJoinRequestResult> => {
          const locked = await lockPendingRequest(tx, input);
          if ("refusal" in locked) {
            return { approved: false, refusal: locked.refusal };
          }
          const { request } = locked;
          const requester = await activePersonOf(tx, {
            workspaceId: input.workspaceId,
            userId: request.requesterUserId,
          });
          if (requester !== undefined) {
            return { approved: false, refusal: "already_member" };
          }
          const memberId = newId<MemberId>();
          await tx.insert(workspaceMembers).values({
            id: memberId,
            workspaceId: input.workspaceId,
            userId: request.requesterUserId,
            displayName: input.displayName ?? request.requestedDisplayName,
            role: "member",
            addedByUserId: input.userId,
            createdAt: input.now,
            updatedAt: input.now,
            claimedAt: input.now,
          });
          await decide(tx, input, "approved", memberId);
          await audit(tx, input, "join_request.approved", request.id);
          await audit(tx, input, "member.claimed", memberId);
          const member = await memberById(tx, memberId);
          if (member === undefined) {
            throw new Error("The approved person is missing");
          }
          return {
            approved: true,
            member,
            requesterUserId: request.requesterUserId,
          };
        },
      );
    } catch (error) {
      const failure = toDatabaseError(error);
      if (
        failure.code === "23505" &&
        failure.constraint === ACTIVE_PERSON_KEY
      ) {
        return { approved: false, refusal: "already_member" };
      }
      throw failure;
    }
  });
}

export type DenyJoinRequestResult =
  | Readonly<{
      denied: true;
      /** The account that asked, which the decision is sent to. */
      requesterUserId: UserId;
    }>
  | Readonly<{ denied: false; refusal: PersonRefusal }>;

/**
 * Denies a pending request in one transaction (ADR 0014, "Join requests"):
 * only the owner or an admin, with the refusals of `lockPendingRequest`. It
 * sets `decision` to `denied` with `decided_at` and `decided_by_user_id`
 * and writes a `join_request.denied` audit record. The requester can ask
 * the workspace again 24 hours later. Inside another transaction it runs as
 * a savepoint.
 */
export async function denyJoinRequest(
  db: Database,
  input: DecideJoinRequestInput,
): Promise<DenyJoinRequestResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<DenyJoinRequestResult> => {
      const locked = await lockPendingRequest(tx, input);
      if ("refusal" in locked) {
        return { denied: false, refusal: locked.refusal };
      }
      await decide(tx, input, "denied");
      await audit(tx, input, "join_request.denied", locked.request.id);
      return { denied: true, requesterUserId: locked.request.requesterUserId };
    }),
  );
}

export type BlockJoinRequestResult =
  | Readonly<{
      blocked: true;
      /** The account that asked, which the decision is sent to as `denied`. */
      requesterUserId: UserId;
    }>
  | Readonly<{ blocked: false; refusal: PersonRefusal }>;

/**
 * Denies a pending request and blocks its account in one transaction (ADR
 * 0014, "Join requests"): only the owner or an admin, with the refusals of
 * `lockPendingRequest`. It sets `decision` to `blocked` with `decided_at`
 * and `decided_by_user_id` and writes a `join_request.blocked` audit record.
 * Until an owner or admin lifts the block, a new request of the account in
 * the workspace is `join_requests_closed`. The requester sees the request
 * as `denied`. Inside another transaction it runs as a savepoint.
 */
export async function blockJoinRequest(
  db: Database,
  input: DecideJoinRequestInput,
): Promise<BlockJoinRequestResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<BlockJoinRequestResult> => {
      const locked = await lockPendingRequest(tx, input);
      if ("refusal" in locked) {
        return { blocked: false, refusal: locked.refusal };
      }
      await decide(tx, input, "blocked");
      await audit(tx, input, "join_request.blocked", locked.request.id);
      return {
        blocked: true,
        requesterUserId: locked.request.requesterUserId,
      };
    }),
  );
}

export type UnblockJoinRequestResult =
  | Readonly<{ unblocked: true }>
  | Readonly<{ unblocked: false; refusal: PersonRefusal }>;

/**
 * Lifts the block of a blocked request in one transaction (ADR 0014, "Join
 * requests"): only the owner or an admin. It locks the acting person, then
 * the request, and refuses with `not_member`, `not_found` (a request that
 * the workspace does not have), `forbidden` (a member), or `conflict` (a
 * request that is not blocked, or whose block was already lifted), in this
 * order. It sets `unblocked_at` and `unblocked_by_user_id` and writes a
 * `join_request.unblocked` audit record. The decision stays `blocked`, so
 * the requester still sees `denied`, and nothing is sent to them. The
 * account can ask again at once: only a `denied` decision starts the
 * 24-hour wait. Inside another transaction it runs as a savepoint.
 */
export async function unblockJoinRequest(
  db: Database,
  input: DecideJoinRequestInput,
): Promise<UnblockJoinRequestResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<UnblockJoinRequestResult> => {
      const { actor } = await lockPeople(tx, input);
      if (actor === undefined) {
        return { unblocked: false, refusal: "not_member" };
      }
      const [request] = await tx
        .select({
          decision: workspaceJoinRequests.decision,
          unblockedAt: workspaceJoinRequests.unblockedAt,
        })
        .from(workspaceJoinRequests)
        .where(
          and(
            eq(workspaceJoinRequests.id, input.joinRequestId),
            eq(workspaceJoinRequests.workspaceId, input.workspaceId),
          ),
        )
        .for("no key update");
      if (request === undefined) {
        return { unblocked: false, refusal: "not_found" };
      }
      if (!administers(actor.role)) {
        return { unblocked: false, refusal: "forbidden" };
      }
      if (request.decision !== "blocked" || request.unblockedAt !== null) {
        return { unblocked: false, refusal: "conflict" };
      }
      await tx
        .update(workspaceJoinRequests)
        .set({ unblockedAt: input.now, unblockedByUserId: input.userId })
        .where(eq(workspaceJoinRequests.id, input.joinRequestId));
      await audit(tx, input, "join_request.unblocked", input.joinRequestId);
      return { unblocked: true };
    }),
  );
}

/** An action of the owner or an admin on the join requests of a whole workspace. */
export type WorkspaceJoinRequestsInput = Actor;

/** Why an action on the join requests of a whole workspace was refused. Nothing was written. */
export type WorkspaceJoinRequestsRefusal = "not_member" | "forbidden";

/** A request that denying all pending requests denied. */
export type DeniedJoinRequest = Readonly<{
  joinRequestId: JoinRequestId;
  /** The account that asked, which the decision is sent to. */
  requesterUserId: UserId;
}>;

export type DenyAllJoinRequestsResult =
  | Readonly<{
      denied: true;
      /** The requests that were pending, in the order of their IDs; empty when none was. */
      joinRequests: readonly DeniedJoinRequest[];
    }>
  | Readonly<{ denied: false; refusal: WorkspaceJoinRequestsRefusal }>;

/**
 * Locks the acting person and decides whether the actor may act on the join
 * requests of the whole workspace: an account without an active person is
 * `not_member`, and a member is `forbidden`.
 */
async function lockAdministrator(
  tx: Database,
  input: WorkspaceJoinRequestsInput,
): Promise<WorkspaceJoinRequestsRefusal | undefined> {
  const { actor } = await lockPeople(tx, input);
  if (actor === undefined) {
    return "not_member";
  }
  return administers(actor.role) ? undefined : "forbidden";
}

/**
 * Denies every pending request of the workspace in one transaction (ADR
 * 0014, "Join requests"): only the owner or an admin, refused with
 * `not_member` or `forbidden`, in this order. It locks the acting person,
 * then the pending requests `FOR NO KEY UPDATE` in the order of their IDs,
 * so that it never waits for a transaction that waits for it. PostgreSQL
 * reads a request that a concurrent decision or withdrawal changed again
 * after the lock, and leaves it out when it is no longer pending. It sets
 * each request's `decision` to `denied` with `decided_at` and
 * `decided_by_user_id`, as a denial of one request does, also of a requester
 * who is an active member or whose identity was erased, and writes one
 * `join_request.denied` audit record per request (Project Manager decision
 * of 2026-11-01). A request past its expiry is not pending and stays as it
 * is. It returns the denied requests with their accounts, which the API
 * sends the decision to. Inside another transaction it runs as a savepoint.
 */
export async function denyAllJoinRequests(
  db: Database,
  input: WorkspaceJoinRequestsInput,
): Promise<DenyAllJoinRequestsResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<DenyAllJoinRequestsResult> => {
      const refusal = await lockAdministrator(tx, input);
      if (refusal !== undefined) {
        return { denied: false, refusal };
      }
      const rows = await tx
        .select({
          joinRequestId: workspaceJoinRequests.id,
          requesterUserId: workspaceJoinRequests.requesterUserId,
        })
        .from(workspaceJoinRequests)
        .where(
          and(
            eq(workspaceJoinRequests.workspaceId, input.workspaceId),
            pending(input.now),
          ),
        )
        .orderBy(workspaceJoinRequests.id)
        .for("no key update");
      if (rows.length > 0) {
        await tx
          .update(workspaceJoinRequests)
          .set({
            decision: "denied",
            decidedAt: input.now,
            decidedByUserId: input.userId,
          })
          .where(
            idIn(
              workspaceJoinRequests.id,
              rows.map((row) => row.joinRequestId),
            ),
          );
        for (const row of rows) {
          await audit(tx, input, "join_request.denied", row.joinRequestId);
        }
      }
      return { denied: true, joinRequests: rows };
    }),
  );
}

export type PauseJoinRequestsResult =
  | Readonly<{
      paused: true;
      /** false when the workspace was already paused, and nothing was written. */
      changed: boolean;
    }>
  | Readonly<{ paused: false; refusal: WorkspaceJoinRequestsRefusal }>;

export type ResumeJoinRequestsResult =
  | Readonly<{
      resumed: true;
      /** false when the workspace was not paused, and nothing was written. */
      changed: boolean;
    }>
  | Readonly<{ resumed: false; refusal: WorkspaceJoinRequestsRefusal }>;

/**
 * Sets or clears `join_requests_paused_at` after the acting person, with
 * `updated_at`, only when it changes, and audits the change with the
 * workspace as the subject. A concurrent pause or resume waits for the
 * workspace row and then finds it changed.
 */
async function setPaused(
  tx: Database,
  input: WorkspaceJoinRequestsInput,
  paused: boolean,
): Promise<
  | Readonly<{ refusal: WorkspaceJoinRequestsRefusal }>
  | Readonly<{ changed: boolean }>
> {
  const refusal = await lockAdministrator(tx, input);
  if (refusal !== undefined) {
    return { refusal };
  }
  const changed = await tx
    .update(workspaces)
    .set({
      joinRequestsPausedAt: paused ? input.now : null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(workspaces.id, input.workspaceId),
        paused
          ? isNull(workspaces.joinRequestsPausedAt)
          : isNotNull(workspaces.joinRequestsPausedAt),
      ),
    )
    .returning({ id: workspaces.id });
  if (changed.length === 0) {
    return { changed: false };
  }
  await audit(
    tx,
    input,
    paused ? "join_requests.paused" : "join_requests.resumed",
    input.workspaceId,
  );
  return { changed: true };
}

/**
 * Pauses new join requests of the workspace in one transaction (ADR 0014,
 * "Join requests"): only the owner or an admin, refused with `not_member` or
 * `forbidden`, in this order. It sets `join_requests_paused_at` to `now` and
 * writes a `join_requests.paused` audit record; pausing a paused workspace
 * changes nothing and writes nothing. While paused, a new request is
 * `join_requests_closed`. The pending requests stay pending and can still be
 * approved, denied, blocked, or withdrawn, and a requester who asks again
 * gets their pending request back (awaiting the Project Manager's
 * confirmation). A pause has no expiry: it ends only with
 * `resumeJoinRequests`. It locks the acting person, then the workspace row,
 * which a new request locks too, so a request either was stored before the
 * pause or sees it. Inside another transaction it runs as a savepoint.
 */
export async function pauseJoinRequests(
  db: Database,
  input: WorkspaceJoinRequestsInput,
): Promise<PauseJoinRequestsResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<PauseJoinRequestsResult> => {
      const result = await setPaused(tx, input, true);
      return "refusal" in result
        ? { paused: false, refusal: result.refusal }
        : { paused: true, changed: result.changed };
    }),
  );
}

/**
 * Ends a pause of join requests in one transaction: only the owner or an
 * admin, refused with `not_member` or `forbidden`, in this order. It clears
 * `join_requests_paused_at` and writes a `join_requests.resumed` audit
 * record; resuming a workspace that is not paused changes nothing and writes
 * nothing. It locks the acting person, then the workspace row. Inside
 * another transaction it runs as a savepoint.
 */
export async function resumeJoinRequests(
  db: Database,
  input: WorkspaceJoinRequestsInput,
): Promise<ResumeJoinRequestsResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<ResumeJoinRequestsResult> => {
      const result = await setPaused(tx, input, false);
      return "refusal" in result
        ? { resumed: false, refusal: result.refusal }
        : { resumed: true, changed: result.changed };
    }),
  );
}
