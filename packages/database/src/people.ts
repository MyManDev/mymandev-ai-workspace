import {
  type DeviceId,
  type InvitationId,
  type MemberId,
  type MemberRole,
  newId,
  newUuidV7,
  type UserId,
  type WorkspaceId,
  type WorkspaceMember,
} from "@mymandev/protocol";
import { and, eq, isNull, or } from "drizzle-orm";
import type { AuditAction, AuditReason } from "./audit-vocabulary.ts";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import {
  auditEvents,
  workspaceInvitations,
  workspaceMembers,
} from "./schema/index.ts";

// Defining, renaming, and removing the people of a workspace (ADR 0014,
// "People and roles", "Invitations", and "Removal and ownership"). Each
// function locks the people it decides on, the acting person included, before
// it reads their state, so that concurrent changes of one person happen one
// after another.
//
// Lock order, so that no two transactions wait for each other: the account
// (`users`), then the device (`devices`), as `lockActor` in the API does; then
// the people (`workspace_members`) in the order of their IDs; then the
// invitations. Creating and accepting an invitation lock the person before
// the invitation too.

/**
 * Why an action on a person was refused. Nothing was written.
 *
 * - `not_member`: the account is not an active member of the workspace, also
 *   when the workspace does not exist;
 * - `not_found`: the workspace has no person with this ID;
 * - `forbidden`: the acting person's role does not allow the action on this
 *   person;
 * - `conflict`: the person is not in the state that the action needs.
 */
export type PersonRefusal =
  "not_member" | "not_found" | "forbidden" | "conflict";

/** Who acts, as the audit record shows it. */
type Actor = Readonly<{
  workspaceId: WorkspaceId;
  /** The acting account; its active person in the workspace acts. */
  userId: UserId;
  /** The account's device that asks, recorded as the actor's device. */
  deviceId: DeviceId;
  now: Date;
}>;

type LockedPerson = Readonly<{
  id: MemberId;
  userId: UserId | null;
  role: MemberRole;
  removedAt: Date | null;
}>;

/** The owner and admins define, rename, and remove unclaimed people. */
function administers(role: MemberRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Locks the acting account's active person in the workspace and, with
 * `memberId`, the target person, in one statement and in the order of their
 * IDs, so that two actions on the same two people cannot deadlock. "No key
 * update" waits for every other change of these rows, but not for the
 * key-share locks of foreign-key checks. PostgreSQL checks a row that changed
 * while the statement waited again, so an acting person removed in the
 * meantime is not found.
 */
async function lockPeople(
  tx: Database,
  input: Readonly<{
    workspaceId: WorkspaceId;
    userId: UserId;
    memberId?: MemberId;
  }>,
): Promise<{
  actor: LockedPerson | undefined;
  target: LockedPerson | undefined;
}> {
  const rows = await tx
    .select({
      id: workspaceMembers.id,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      removedAt: workspaceMembers.removedAt,
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
    target: rows.find((row) => row.id === input.memberId),
  };
}

async function audit(
  tx: Database,
  actor: Actor,
  action: AuditAction,
  subjectId: string,
  reason?: AuditReason,
): Promise<void> {
  await tx.insert(auditEvents).values({
    id: newUuidV7(),
    createdAt: actor.now,
    action,
    actorUserId: actor.userId,
    actorDeviceId: actor.deviceId,
    workspaceId: actor.workspaceId,
    subjectId,
    reason,
  });
}

export type DefineMemberInput = Actor & Readonly<{ displayName: string }>;

export type DefineMemberResult =
  | Readonly<{ defined: true; member: WorkspaceMember }>
  | Readonly<{ defined: false; refusal: "not_member" | "forbidden" }>;

/**
 * Defines an unclaimed person in one transaction (ADR 0014, "People and
 * roles"): only the owner or an admin; the person is always a `member`, gets
 * `displayName` and the time `now`, and has the acting account as
 * `added_by_user_id`. Writes a `member.defined` audit record. Inside another
 * transaction it runs as a savepoint.
 */
export async function defineMember(
  db: Database,
  input: DefineMemberInput,
): Promise<DefineMemberResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<DefineMemberResult> => {
      const { actor } = await lockPeople(tx, input);
      if (actor === undefined) {
        return { defined: false, refusal: "not_member" };
      }
      if (!administers(actor.role)) {
        return { defined: false, refusal: "forbidden" };
      }
      const id = newId<MemberId>();
      await tx.insert(workspaceMembers).values({
        id,
        workspaceId: input.workspaceId,
        displayName: input.displayName,
        role: "member",
        addedByUserId: input.userId,
        createdAt: input.now,
        updatedAt: input.now,
      });
      await audit(tx, input, "member.defined", id);
      return {
        defined: true,
        member: {
          id,
          workspaceId: input.workspaceId,
          displayName: input.displayName,
          role: "member",
          userId: null,
          identity: null,
          removedAt: null,
        },
      };
    }),
  );
}

export type RenameMemberInput = Actor &
  Readonly<{ memberId: MemberId; displayName: string }>;

export type RenameMemberResult =
  | Readonly<{ renamed: true }>
  | Readonly<{ renamed: false; refusal: PersonRefusal }>;

/**
 * Renames a person in one transaction (ADR 0014, "People and roles"): every
 * active member renames their own person, and the owner or an admin renames
 * an unclaimed person; nobody renames another claimed person (`forbidden`).
 * A removed person is `conflict`. Writes a `member.renamed` audit record.
 * Inside another transaction it runs as a savepoint.
 */
export async function renameMember(
  db: Database,
  input: RenameMemberInput,
): Promise<RenameMemberResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<RenameMemberResult> => {
      const { actor, target } = await lockPeople(tx, input);
      if (actor === undefined) {
        return { renamed: false, refusal: "not_member" };
      }
      if (target === undefined) {
        return { renamed: false, refusal: "not_found" };
      }
      const allowed =
        target.userId === null
          ? administers(actor.role)
          : target.id === actor.id;
      if (!allowed) {
        return { renamed: false, refusal: "forbidden" };
      }
      if (target.removedAt !== null) {
        return { renamed: false, refusal: "conflict" };
      }
      await tx
        .update(workspaceMembers)
        .set({ displayName: input.displayName, updatedAt: input.now })
        .where(eq(workspaceMembers.id, target.id));
      await audit(tx, input, "member.renamed", target.id);
      return { renamed: true };
    }),
  );
}

export type RemoveMemberInput = Actor & Readonly<{ memberId: MemberId }>;

export type RemoveMemberResult =
  | Readonly<{
      removed: true;
      /** The person's live invitation that the removal revoked, if it had one. */
      revokedInvitationId: InvitationId | null;
    }>
  | Readonly<{ removed: false; refusal: PersonRefusal }>;

/**
 * Removes an unclaimed person in one transaction (ADR 0014, "Removal and
 * ownership"): only the owner or an admin; sets `removed_at` to `now` and
 * `removed_by_user_id` to the acting account, and revokes the person's live
 * invitation, the one neither accepted nor revoked, with the acting account
 * as `revoked_by_user_id`. Writes a `member.removed` audit record and, for a
 * revoked invitation, an `invitation.revoked` record with the reason
 * `member_removed`. A removed person is `conflict`, and so is a claimed
 * person until #93 removes claimed people. Nothing is deleted. Inside
 * another transaction it runs as a savepoint.
 */
export async function removeMember(
  db: Database,
  input: RemoveMemberInput,
): Promise<RemoveMemberResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<RemoveMemberResult> => {
      const { actor, target } = await lockPeople(tx, input);
      if (actor === undefined) {
        return { removed: false, refusal: "not_member" };
      }
      if (target === undefined) {
        return { removed: false, refusal: "not_found" };
      }
      if (!administers(actor.role)) {
        return { removed: false, refusal: "forbidden" };
      }
      if (target.removedAt !== null || target.userId !== null) {
        return { removed: false, refusal: "conflict" };
      }
      await tx
        .update(workspaceMembers)
        .set({
          removedAt: input.now,
          removedByUserId: input.userId,
          updatedAt: input.now,
        })
        .where(eq(workspaceMembers.id, target.id));
      await audit(tx, input, "member.removed", target.id);
      const [revoked] = await tx
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
      if (revoked !== undefined) {
        await audit(
          tx,
          input,
          "invitation.revoked",
          revoked.id,
          "member_removed",
        );
      }
      return { removed: true, revokedInvitationId: revoked?.id ?? null };
    }),
  );
}
