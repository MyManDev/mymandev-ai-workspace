import {
  type AgentId,
  type DeviceId,
  type InvitationId,
  type MemberId,
  type MemberRole,
  newId,
  newUuidV7,
  type PermissionGrantId,
  type UserId,
  type WorkspaceId,
  type WorkspaceMember,
} from "@mymandev/protocol";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { AuditAction, AuditReason } from "./audit-vocabulary.ts";
import {
  type CancelledRun,
  cancelRuns,
  disableAgents,
  idIn,
  revokeGrants,
} from "./cascade.ts";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import {
  agentRuns,
  agents,
  auditEvents,
  devices,
  permissionGrants,
  projects,
  workspaceInvitations,
  workspaceMembers,
} from "./schema/index.ts";

// Defining, renaming, and removing the people of a workspace, leaving it,
// and promoting and demoting admins (ADR 0014, "People and roles",
// "Invitations", and "Removal and ownership"). Each function locks the
// people it decides on, the acting person included, before it reads their
// state, so that concurrent changes of one person happen one after another.
//
// Lock order, so that no two transactions wait for each other: the account
// (`users`), then the device (`devices`), as `lockActor` in the API does; then
// the people (`workspace_members`) in the order of their IDs; then the
// invitations. Creating and accepting an invitation lock the person before
// the invitation too. The invitations of `src/invitations.ts` use the
// helpers below; creating one locks the workspace row (`workspaces`) after
// the people and before the invitations, for the counts of the workspace.
// A removal and a demotion also revoke the invitations that the removed or
// demoted person created, which name other people whom they do not lock:
// they lock them after the people and in the order of their IDs, and every
// other change of an invitation locks its person before it touches that
// person's invitations, of which at most one is live. A removal then locks
// the removed person's agents, their grants, and the runs it cancels
// (`src/cascade.ts`), in that order, as a device revocation does after its
// device.
//
// A future writer that inserts an agent, a grant, or a run (#75, M3) locks
// the person of each account it attaches the row to first: the agent's
// owner, and for a run also the requester, in the order of their IDs,
// `FOR SHARE` or stronger, and it checks that each is still active. A
// removal holds the person `FOR NO KEY UPDATE`, which `FOR SHARE` waits for
// and `FOR KEY SHARE` does not; so either the removal commits first and the
// writer finds the person removed, or the insert commits first and the
// removal sees the new row. Without this a removal could miss an agent,
// grant, or run that a concurrent insert added.

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
export type Actor = Readonly<{
  workspaceId: WorkspaceId;
  /** The acting account; its active person in the workspace acts. */
  userId: UserId;
  /** The account's device that asks, recorded as the actor's device. */
  deviceId: DeviceId;
  now: Date;
}>;

export type LockedPerson = Readonly<{
  id: MemberId;
  userId: UserId | null;
  role: MemberRole;
  removedAt: Date | null;
}>;

/** The owner and admins define, rename, and remove unclaimed people, and invite them. */
export function administers(role: MemberRole): boolean {
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
export async function lockPeople(
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

/** Writes an audit record of the acting account and device, at `now`, in the actor's workspace. */
export async function audit(
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

/**
 * What removing a person or leaving changed, for what the server sends after
 * the commit (ADR 0014, "Removal and ownership"). Each list is in the order
 * of its IDs.
 */
export type MembershipEnd = Readonly<{
  /** The person that was removed or left. */
  memberId: MemberId;
  /**
   * The account that had claimed the person, whose connections the server
   * tells; null for an unclaimed person, which has no account, agents, or
   * runs.
   */
  userId: UserId | null;
  /**
   * The person's own invitation and the invitations that the person's
   * account created in the workspace, each neither accepted nor revoked.
   */
  revokedInvitationIds: readonly InvitationId[];
  /** The account's agents in the workspace's projects that were not disabled yet. */
  disabledAgentIds: readonly AgentId[];
  /**
   * The grants of the account's agents in the workspace's projects that were
   * not revoked yet, the active ones and the expired ones alike.
   */
  revokedGrantIds: readonly PermissionGrantId[];
  /** Each with the reason `member_removed`, in the order of the run IDs. */
  cancelledRuns: readonly CancelledRun[];
}>;

export type RemoveMemberResult =
  | (Readonly<{ removed: true }> & MembershipEnd)
  | Readonly<{ removed: false; refusal: PersonRefusal }>;

/**
 * Whether a person with the role `actor` may remove an active person with
 * the role `target` (ADR 0014, "People and roles"): the owner removes anyone
 * but the owner; an admin only people with the role `member`, which every
 * unclaimed person has; a member nobody. So nobody removes the owner, and
 * nobody removes their own person: an admin or a member leaves instead.
 */
function mayRemove(actor: MemberRole, target: MemberRole): boolean {
  switch (actor) {
    case "owner":
      return target !== "owner";
    case "admin":
      return target === "member";
    case "member":
      return false;
  }
}

/**
 * Removes a person in one transaction (ADR 0014, "People and roles" and
 * "Removal and ownership"): the owner removes any person but the owner, and
 * an admin removes unclaimed people and claimed people with the role
 * `member`. Every other combination is `forbidden`: a member's removal, an
 * admin's removal of the owner or of an admin, and anyone's removal of their
 * own person, who leaves with `leaveWorkspace` instead. A removed person is
 * `conflict`. The removal itself is described at `removePerson` below; it
 * writes a `member.removed` audit record. Inside another transaction it runs
 * as a savepoint.
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
      if (target.removedAt !== null) {
        return { removed: false, refusal: "conflict" };
      }
      if (!mayRemove(actor.role, target.role)) {
        return { removed: false, refusal: "forbidden" };
      }
      const ended = await removePerson(tx, input, target, "member.removed");
      return { removed: true, ...ended };
    }),
  );
}

export type LeaveWorkspaceInput = Actor;

export type LeaveWorkspaceResult =
  | (Readonly<{ left: true }> & MembershipEnd)
  | Readonly<{ left: false; refusal: "not_member" | "forbidden" }>;

/**
 * The acting account's person leaves the workspace in one transaction (ADR
 * 0014, "People and roles" and "Removal and ownership"): an admin or a
 * member. The owner cannot leave and transfers ownership first
 * (`forbidden`). Leaving is the removal of `removePerson` below, with the
 * leaving account as the remover, and writes a `member.left` audit record.
 * Inside another transaction it runs as a savepoint.
 */
export async function leaveWorkspace(
  db: Database,
  input: LeaveWorkspaceInput,
): Promise<LeaveWorkspaceResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<LeaveWorkspaceResult> => {
      const { actor } = await lockPeople(tx, input);
      if (actor === undefined) {
        return { left: false, refusal: "not_member" };
      }
      if (actor.role === "owner") {
        return { left: false, refusal: "forbidden" };
      }
      const ended = await removePerson(tx, input, actor, "member.left");
      return { left: true, ...ended };
    }),
  );
}

const NO_AGENTS = Object.freeze({
  disabledAgentIds: Object.freeze([]),
  revokedGrantIds: Object.freeze([]),
  cancelledRuns: Object.freeze([]),
});

/**
 * An operator's removal of an account's person (`src/account-erasure.ts`):
 * the erased account itself is the remover, recorded as `removed_by_user_id`
 * and `revoked_by_user_id`, because the request comes from that person (the
 * Project Manager's decision in the #93 issue comment of 2026-10-30). There
 * is no acting device, and the audit records have no actor, as an
 * operator's have none (decision of 2026-11-01).
 */
export type OperatorRemoval = Readonly<{
  workspaceId: WorkspaceId;
  userId: UserId;
  now: Date;
  /** Why the operator removes the person; the reason of the removal's audit record. */
  operatorReason: "account_erased";
}>;

/** Who removes a person in `removePerson`: an acting account and its device, or an operator. */
export type Remover = Actor | OperatorRemoval;

/** Writes an audit record of a removal: of the acting account, or without an actor for an operator. */
async function auditRemoval(
  tx: Database,
  remover: Remover,
  action: AuditAction,
  subjectId: string,
  reason?: AuditReason,
): Promise<void> {
  if (!("operatorReason" in remover)) {
    await audit(tx, remover, action, subjectId, reason);
    return;
  }
  await tx.insert(auditEvents).values({
    id: newUuidV7(),
    createdAt: remover.now,
    action,
    workspaceId: remover.workspaceId,
    subjectId,
    reason,
  });
}

/**
 * Removes an active person that the caller locked, with the acting account
 * as the remover (ADR 0014, "Removal and ownership"; P-60; ADR 0015, P-77):
 *
 * - it sets `removed_at` to `now` and `removed_by_user_id` to the acting
 *   account, clears an ownership offer to the person, which only an active
 *   person can hold, and writes `action` as the audit record;
 * - it revokes the person's own invitation and the invitations that the
 *   person's account created in the workspace, each neither accepted nor
 *   revoked, also an expired one, with the acting account as
 *   `revoked_by_user_id` and an `invitation.revoked` audit record with the
 *   reason `member_removed` for each;
 * - for a claimed person, it disables the account's agents in the
 *   workspace's projects, revokes their active grants with the acting
 *   account as `revoked_by_user_id`, and moves to `cancelled`, with the
 *   reason `member_removed`, the unfinished runs in the workspace's projects
 *   that run on those agents or that the account requested on another
 *   member's agent.
 *
 * After the people, it locks the invitations, the agents, the grants, and
 * the runs, each `FOR NO KEY UPDATE` and in the order of their IDs. Nothing
 * outside the workspace changes, and nothing is deleted. An operator's
 * removal (`OperatorRemoval`) writes its records without an actor, and the
 * removal's record with the operator's reason.
 */
export async function removePerson(
  tx: Database,
  actor: Remover,
  person: LockedPerson,
  action: "member.removed" | "member.left",
): Promise<MembershipEnd> {
  const { workspaceId, now } = actor;
  await tx
    .update(workspaceMembers)
    .set({
      removedAt: now,
      removedByUserId: actor.userId,
      ownershipOfferedAt: null,
      updatedAt: now,
    })
    .where(eq(workspaceMembers.id, person.id));
  await auditRemoval(
    tx,
    actor,
    action,
    person.id,
    "operatorReason" in actor ? actor.operatorReason : undefined,
  );

  const ownOrCreated = or(
    eq(workspaceInvitations.memberId, person.id),
    person.userId === null
      ? undefined
      : eq(workspaceInvitations.createdByUserId, person.userId),
  );
  if (ownOrCreated === undefined) {
    throw new Error("A removal selects the person's invitations");
  }
  const revokedInvitationIds = await revokeOpenInvitations(
    tx,
    actor,
    ownOrCreated,
    "member_removed",
  );
  const ended = {
    memberId: person.id,
    userId: person.userId,
    revokedInvitationIds,
  };
  if (person.userId === null) {
    return Object.freeze({ ...ended, ...NO_AGENTS });
  }

  const inWorkspace = tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId));
  const owned = and(
    eq(agents.ownerUserId, person.userId),
    inArray(agents.projectId, inWorkspace),
  );
  const disabledAgentIds = await disableAgents(tx, owned, now);
  const ownedAgents = tx.select({ id: agents.id }).from(agents).where(owned);
  const revokedGrantIds = await revokeGrants(
    tx,
    inArray(permissionGrants.granteeAgentId, ownedAgents),
    actor.userId,
    now,
  );
  const cancelledRuns = await cancelRuns(
    tx,
    and(
      inArray(agentRuns.projectId, inWorkspace),
      or(
        inArray(agentRuns.agentId, ownedAgents),
        eq(agentRuns.requestedByUserId, person.userId),
      ),
    ),
    "member_removed",
    now,
  );
  return Object.freeze({
    ...ended,
    disabledAgentIds: Object.freeze(disabledAgentIds),
    revokedGrantIds: Object.freeze(revokedGrantIds),
    cancelledRuns,
  });
}

/**
 * Revokes the invitations of the actor's workspace that `which` selects and
 * that are neither accepted nor revoked, also an expired one, as in the
 * unique index of one live invitation per person, with the acting account as
 * `revoked_by_user_id` and an `invitation.revoked` audit record with `reason`
 * for each, without an actor for an operator (`Remover`). It locks them
 * `FOR NO KEY UPDATE` in the order of their IDs, after the people, and
 * returns their IDs in that order. `which` is required, so that no caller
 * revokes every open invitation of the workspace by leaving it out.
 */
async function revokeOpenInvitations(
  tx: Database,
  actor: Remover,
  which: SQL,
  reason: "member_removed" | "creator_demoted",
): Promise<readonly InvitationId[]> {
  const rows = await tx
    .select({ id: workspaceInvitations.id })
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, actor.workspaceId),
        isNull(workspaceInvitations.acceptedAt),
        isNull(workspaceInvitations.revokedAt),
        which,
      ),
    )
    .orderBy(workspaceInvitations.id)
    .for("no key update");
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await tx
      .update(workspaceInvitations)
      .set({ revokedAt: actor.now, revokedByUserId: actor.userId })
      .where(idIn(workspaceInvitations.id, ids));
    for (const id of ids) {
      await auditRemoval(tx, actor, "invitation.revoked", id, reason);
    }
  }
  return Object.freeze(ids);
}

/**
 * A device must be older than this to promote a member to admin or to offer
 * ownership (ADR 0014, "People and roles" and "Lifetimes"): 72 hours after
 * its registration, `devices.created_at`. A device exactly this old is still
 * too new. A new sign-in keeps the device and so its age.
 */
export const DEVICE_TOO_NEW_MS = 72 * 60 * 60_000;

/**
 * Whether the acting device is older than `DEVICE_TOO_NEW_MS` at `now`. A
 * device that the acting account does not have is not. `created_at` never
 * changes, so the row is read without a lock; the API's `lockActor` holds it
 * anyway.
 */
export async function deviceOldEnough(
  tx: Database,
  actor: Actor,
): Promise<boolean> {
  const [device] = await tx
    .select({ createdAt: devices.createdAt })
    .from(devices)
    .where(
      and(eq(devices.id, actor.deviceId), eq(devices.userId, actor.userId)),
    );
  return (
    device !== undefined &&
    device.createdAt.getTime() + DEVICE_TOO_NEW_MS < actor.now.getTime()
  );
}

/**
 * Whether the acting person may change the role of the target at all (ADR
 * 0014, "People and roles"): only the owner, and never the owner's own role,
 * which changes only by an ownership transfer. So nobody changes their own
 * role.
 */
function mayChangeRole(actor: LockedPerson, target: LockedPerson): boolean {
  return actor.role === "owner" && target.role !== "owner";
}

export type PromoteMemberInput = Actor & Readonly<{ memberId: MemberId }>;

export type PromoteMemberResult =
  | Readonly<{ promoted: true }>
  | Readonly<{
      promoted: false;
      /** `device_too_new`: the acting device is not older than `DEVICE_TOO_NEW_MS`. */
      refusal: PersonRefusal | "device_too_new";
    }>;

/**
 * Promotes an active, claimed `member` to `admin` in one transaction (ADR
 * 0014, "People and roles"): only the owner, from a device that is older
 * than `DEVICE_TOO_NEW_MS` at `now`. Anyone else, and a change of the owner's
 * own role, is `forbidden`; a device that is not is `device_too_new`; a removed
 * or unclaimed person, who is always a member, and an admin are `conflict`.
 * Writes a `member.promoted` audit record. Inside another transaction it
 * runs as a savepoint.
 */
export async function promoteMember(
  db: Database,
  input: PromoteMemberInput,
): Promise<PromoteMemberResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<PromoteMemberResult> => {
      const { actor, target } = await lockPeople(tx, input);
      if (actor === undefined) {
        return { promoted: false, refusal: "not_member" };
      }
      if (target === undefined) {
        return { promoted: false, refusal: "not_found" };
      }
      if (!mayChangeRole(actor, target)) {
        return { promoted: false, refusal: "forbidden" };
      }
      if (!(await deviceOldEnough(tx, input))) {
        return { promoted: false, refusal: "device_too_new" };
      }
      if (
        target.removedAt !== null ||
        target.userId === null ||
        target.role !== "member"
      ) {
        return { promoted: false, refusal: "conflict" };
      }
      await tx
        .update(workspaceMembers)
        .set({ role: "admin", updatedAt: input.now })
        .where(eq(workspaceMembers.id, target.id));
      await audit(tx, input, "member.promoted", target.id);
      return { promoted: true };
    }),
  );
}

export type DemoteMemberInput = Actor & Readonly<{ memberId: MemberId }>;

export type DemoteMemberResult =
  | Readonly<{
      demoted: true;
      /**
       * The invitations that the demoted account created in the workspace,
       * each neither accepted nor revoked, in the order of their IDs.
       */
      revokedInvitationIds: readonly InvitationId[];
    }>
  | Readonly<{ demoted: false; refusal: PersonRefusal }>;

/**
 * Demotes an active `admin` to `member` in one transaction (ADR 0014,
 * "People and roles"): only the owner, from any of the owner's devices.
 * Anyone else, and a change of the owner's own role, is `forbidden`; a
 * removed person and a member, an unclaimed one too, are `conflict`. Writes
 * a `member.demoted` audit record, then revokes the invitations that the
 * demoted account created in the workspace, each neither accepted nor
 * revoked, also an expired one, with the owner as `revoked_by_user_id` and
 * an `invitation.revoked` audit record with the reason `creator_demoted` for
 * each. It locks the invitations after the people, in the order of their
 * IDs, as a removal does. Inside another transaction it runs as a savepoint.
 */
export async function demoteMember(
  db: Database,
  input: DemoteMemberInput,
): Promise<DemoteMemberResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<DemoteMemberResult> => {
      const { actor, target } = await lockPeople(tx, input);
      if (actor === undefined) {
        return { demoted: false, refusal: "not_member" };
      }
      if (target === undefined) {
        return { demoted: false, refusal: "not_found" };
      }
      if (!mayChangeRole(actor, target)) {
        return { demoted: false, refusal: "forbidden" };
      }
      if (
        target.removedAt !== null ||
        target.userId === null ||
        target.role !== "admin"
      ) {
        return { demoted: false, refusal: "conflict" };
      }
      await tx
        .update(workspaceMembers)
        .set({ role: "member", updatedAt: input.now })
        .where(eq(workspaceMembers.id, target.id));
      await audit(tx, input, "member.demoted", target.id);
      const revokedInvitationIds = await revokeOpenInvitations(
        tx,
        input,
        eq(workspaceInvitations.createdByUserId, target.userId),
        "creator_demoted",
      );
      return { demoted: true, revokedInvitationIds };
    }),
  );
}
