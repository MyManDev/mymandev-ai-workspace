import {
  type AgentId,
  type DeviceId,
  type InvitationId,
  type JoinRequestId,
  newUuidV7,
  type PermissionGrantId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, eq, gt, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { type CancelledRun, idIn } from "./cascade.ts";
import type { Database } from "./db.ts";
import { revokeDevice } from "./device-revocation.ts";
import { withDatabaseErrors } from "./errors.ts";
import { type MembershipEnd, removePerson } from "./people.ts";
import {
  agents,
  auditEvents,
  devices,
  userIdentities,
  users,
  workspaceInvitations,
  workspaceJoinRequests,
  workspaceMembers,
  workspaces,
} from "./schema/index.ts";

// An operator erases a person's data on request (ADR 0014, "Data model",
// "Migration, retention, and erasure"; P-62), with the operator command
// `db:account -- erase <user ID> --confirm` (`src/account-cli.ts`).
//
// Lock order. The account's GitHub identity (`user_identities`) comes first,
// `FOR UPDATE`, because the API's sign-in locks the identity that it finds by
// the GitHub ID before the account: a sign-in that commits first is erased
// with the device that it registered, and a sign-in that waits for the
// erasure no longer finds the identity, whose subject is cleared, and creates
// a new account. Then the account (`users`), as `lockActor` in the API and
// `disableAccount` do, so that every request of the account, which checks the
// account inside its transaction, waits for the erasure and is then refused.
// Then the account's devices, revoked ones included, its join requests, and
// its people, removed ones included, each `FOR NO KEY UPDATE` and in the
// order of their IDs. The join requests come before the people, unlike in an
// approval, which locks the approver's person and then the request: an
// approval that holds a request of the account makes the erasure wait and
// commits its new person first, which the erasure then finds and removes;
// otherwise the approval waits for the erasure and finds the request
// withdrawn. An approval locks no person of the requester, so the two cannot
// wait for each other in a cycle.
//
// After the people come the workspaces that the account owns, which the
// erasure archives when no other active, claimed person remains in them
// (Project Manager decision of 2026-11-02), each step `FOR NO KEY UPDATE` and
// in the order of the IDs. First the pending join requests of other accounts
// in them, before the workspace rows, as `src/join-requests.ts` locks a
// request before a workspace row (`createJoinRequest`). Then the workspace
// rows, after the people, as the writers of `src/people.ts` and
// `src/invitations.ts` lock a person before a workspace row. Then the pending
// join requests once more: a new request locks the workspace row before it
// stores the request, so this finds every request stored before the erasure
// held the row, and a new request that waits for the erasure at the row then
// finds the workspace archived. A withdrawal or a decision of a request holds
// no workspace row. Then the workspaces' invitations that are neither
// accepted nor revoked. Only then does the erasure read whether another
// active, claimed person remains, so that no claim escapes it: an acceptance
// that consumed its invitation first makes the erasure wait for its commit,
// and the erasure then sees the new person and refuses; an acceptance that
// comes later waits for the erasure at the invitation and finds it revoked.
// An approval or a new invitation needs an active owner or admin, which is
// the account's person, which the erasure holds, or another person, who
// stops the archive anyway. An acceptance locks its unclaimed person, which
// the erasure never locks, and then its invitation, so the two cannot wait
// for each other in a cycle.
//
// After that, each removal locks its invitations, agents, grants, and runs
// (`removePerson` in `src/people.ts`), and then each device revocation locks
// the agents, grants, and runs of its device (`revokeDevice`), each in the
// order of their IDs (`src/cascade.ts`); last, the agents that the account
// owns, for their names, in the order of their IDs. Every other transaction
// that changes these rows locks the account first (the API's requests of the
// account, a sign-in, `disableAccount`), or a person of the account first (a
// removal, and the future writers of agents, grants, and runs), so it waits
// for the erasure at that row, or the erasure waits for it there and then
// sees what it changed.
//
// Before all of these, every erasure takes one transaction-level advisory
// lock with a fixed key (`ERASURE_LOCK_KEY`), so two erasures run one after
// another. Without it, two erasures of accounts that share workspaces could
// deadlock: the run that one account requested on the other's agent is
// cancelled by the erasure of either, and each erasure takes the workspaces
// in the order of its own account's person IDs, so the two could lock such
// runs in opposite orders. Erasures are rare operator commands, so waiting
// costs nothing.

/**
 * The key of the transaction-level advisory lock that serializes erasures
 * (`pg_advisory_xact_lock`): the ASCII bytes of "mmderase" as a bigint.
 */
const ERASURE_LOCK_KEY = "7885068909469070181";

/** The fixed placeholder that replaces the erased person's names (ADR 0014, P-62). */
export const ERASED_DISPLAY_NAME = "Former user";

/**
 * The fixed placeholder that replaces the labels of the erased account's
 * devices, which can hold personal data (Project Manager decision of
 * 2026-11-02).
 */
export const ERASED_DEVICE_LABEL = "Former device";

/**
 * The fixed placeholder that replaces the names of the agents that the
 * erased account owns, which can hold personal data (Project Manager
 * decision of 2026-11-02).
 */
export const ERASED_AGENT_NAME = "Former agent";

export type EraseAccountInput = Readonly<{ userId: UserId; now: Date }>;

/** A device that the erasure revoked with the reason `account_erased`. */
export type ErasedDevice = Readonly<{
  deviceId: DeviceId;
  /** The agents that the device hosts and that no removal had disabled, in the order of their IDs. */
  disabledAgentIds: readonly AgentId[];
  /** The grants on the device that no removal had revoked, in the order of their IDs. */
  revokedGrantIds: readonly PermissionGrantId[];
  /** The unfinished runs of those agents that no removal had cancelled, with the reason `device_revoked`. */
  cancelledRuns: readonly CancelledRun[];
}>;

/**
 * A workspace that the erased account owned and that the erasure archived,
 * because no other active, claimed person remained in it (Project Manager
 * decision of 2026-11-02).
 */
export type ArchivedWorkspace = Readonly<{
  workspaceId: WorkspaceId;
  /**
   * Its invitations that were neither accepted nor revoked, also expired
   * ones, now revoked, in the order of their IDs.
   */
  revokedInvitationIds: readonly InvitationId[];
  /** Its pending join requests of other accounts, now denied, in the order of their IDs. */
  deniedJoinRequestIds: readonly JoinRequestId[];
}>;

export type EraseAccountResult =
  | Readonly<{
      erased: true;
      /**
       * Each active membership that the erasure ended, as a removal ends one,
       * in the order of the person IDs; the owner's person of an archived
       * workspace too.
       */
      endedMemberships: readonly MembershipEnd[];
      /** In the order of the device IDs. */
      revokedDevices: readonly ErasedDevice[];
      /** The pending join requests, now withdrawn, in the order of their IDs. */
      withdrawnJoinRequestIds: readonly JoinRequestId[];
      /** In the order of the workspace IDs. */
      archivedWorkspaces: readonly ArchivedWorkspace[];
    }>
  /**
   * `not_found`: no account has this ID, or it has no GitHub identity, which
   * the sign-in always creates with the account; `already_erased`: the
   * account's identity is erased, and nothing changed.
   */
  | Readonly<{ erased: false; refusal: "not_found" | "already_erased" }>
  /**
   * The account is the owner of these workspaces, in the order of their IDs,
   * and each has another active, claimed person, to whom ownership is
   * transferred first (ADR 0014). Nothing changed.
   */
  | Readonly<{
      erased: false;
      refusal: "owner";
      ownedWorkspaceIds: readonly WorkspaceId[];
    }>;

/** A pending join request of another account in a workspace that the account owns. */
type PendingRequest = Readonly<{ id: JoinRequestId; workspaceId: WorkspaceId }>;

/**
 * Locks the pending join requests of other accounts than `userId` in the
 * workspaces `workspaceIds`, `FOR NO KEY UPDATE` and in the order of their
 * IDs, and returns them.
 */
function lockPendingRequestsIn(
  tx: Database,
  workspaceIds: readonly WorkspaceId[],
  userId: UserId,
  now: Date,
): Promise<PendingRequest[]> {
  return tx
    .select({
      id: workspaceJoinRequests.id,
      workspaceId: workspaceJoinRequests.workspaceId,
    })
    .from(workspaceJoinRequests)
    .where(
      and(
        idIn(workspaceJoinRequests.workspaceId, workspaceIds),
        ne(workspaceJoinRequests.requesterUserId, userId),
        isNull(workspaceJoinRequests.decision),
        gt(workspaceJoinRequests.expiresAt, now),
      ),
    )
    .orderBy(workspaceJoinRequests.id)
    .for("no key update");
}

/** The IDs of `rows` that belong to the workspace, in the order of `rows`. */
function idsIn<Id extends string>(
  rows: readonly Readonly<{ id: Id; workspaceId: WorkspaceId }>[],
  workspaceId: WorkspaceId,
): readonly Id[] {
  return Object.freeze(
    rows.filter((row) => row.workspaceId === workspaceId).map((row) => row.id),
  );
}

/**
 * Erases an account's personal data in one transaction (ADR 0014, P-62). It
 * refuses an account that owns a workspace in which another active, claimed
 * person remains, because the owner is never removed; ownership is
 * transferred to that person first. Otherwise:
 *
 * - it sets `user_identities.erased_at` and clears `subject`, `login`, and
 *   `account_created_at`, so that the former GitHub ID never matches a
 *   sign-in again: a later sign-in with it creates a new account;
 * - it replaces `users.display_name`, the display names of every person of
 *   the account, removed ones included, and the requested display names of
 *   every join request of the account with `ERASED_DISPLAY_NAME`, the labels
 *   of every device of the account, revoked ones included, with
 *   `ERASED_DEVICE_LABEL`, and the names of every agent that the account
 *   owns, disabled ones included, with `ERASED_AGENT_NAME`, and sets
 *   `users.disabled_at`, keeping an earlier time;
 * - it withdraws each pending join request of the account, with the account
 *   as `decided_by_user_id` and a `join_request.withdrawn` audit record, and
 *   marks a request past its expiry without a decision `expired`, with its
 *   `expires_at` as `decided_at` and no audit record, as the account's next
 *   request would, so that none of them can be approved;
 * - it archives each workspace that the account owns, in which no other
 *   active, claimed person remains (Project Manager decision of
 *   2026-11-02): it sets `archived_at`, revokes the workspace's invitations
 *   that are neither accepted nor revoked, also expired ones, with the
 *   account as `revoked_by_user_id`, denies the pending join requests of
 *   other accounts in it with the account as `decided_by_user_id`, and makes
 *   the owner's person a `member`, so that its removal below passes
 *   `workspace_members_owner_removal_check`. It writes `workspace.archived`,
 *   `invitation.revoked`, and `join_request.denied` audit records with the
 *   reason `account_erased`. An archived workspace has no owner, which only
 *   an archived workspace may lack, and its unclaimed people stay;
 * - it removes each active person of the account as a removal does
 *   (`removePerson`), with the account itself as `removed_by_user_id` and
 *   `revoked_by_user_id` (the Project Manager's decision in the #93 issue
 *   comment of 2026-10-30) and a `member.removed` audit record with the
 *   reason `account_erased`; the invitations it revokes keep the reason
 *   `member_removed`, and the runs it cancels `member_removed`;
 * - it revokes every device of the account that is not revoked with the
 *   reason `account_erased` (`revokeDevice`), which disables the agents,
 *   revokes the grants, and cancels the runs with `device_revoked` that no
 *   removal reached, in workspaces that the account had left before;
 * - it writes an `account.erased` audit record with the account as the
 *   subject.
 *
 * Every audit record of an erasure has no actor, as an operator's has none
 * (the Project Manager's decision of 2026-11-01). Nothing is deleted:
 * messages, runs, grants, workspaces, and the person rows keep their
 * attribution to the account's ID. A second erasure of the same account
 * changes nothing. It first takes the advisory lock that serializes
 * erasures, held until the transaction ends. Inside another transaction it
 * runs as a savepoint.
 *
 * The caller runs outside the API, which learns of the erasure only from the
 * database: see "Operator commands" in the package's README.
 */
export async function eraseAccount(
  db: Database,
  input: EraseAccountInput,
): Promise<EraseAccountResult> {
  const { userId, now } = input;
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<EraseAccountResult> => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${sql.raw(ERASURE_LOCK_KEY)})`,
      );
      const identities = await tx
        .select({ erasedAt: userIdentities.erasedAt })
        .from(userIdentities)
        .where(eq(userIdentities.userId, userId))
        .orderBy(userIdentities.id)
        .for("update");
      const [account] = await tx
        .select({ disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, userId))
        .for("no key update");
      if (account === undefined || identities.length === 0) {
        return { erased: false, refusal: "not_found" };
      }
      if (identities.every((identity) => identity.erasedAt !== null)) {
        return { erased: false, refusal: "already_erased" };
      }
      const accountDevices = await tx
        .select({ id: devices.id, revokedAt: devices.revokedAt })
        .from(devices)
        .where(eq(devices.userId, userId))
        .orderBy(devices.id)
        .for("no key update");
      const requests = await tx
        .select({
          id: workspaceJoinRequests.id,
          workspaceId: workspaceJoinRequests.workspaceId,
          decision: workspaceJoinRequests.decision,
          expiresAt: workspaceJoinRequests.expiresAt,
        })
        .from(workspaceJoinRequests)
        .where(eq(workspaceJoinRequests.requesterUserId, userId))
        .orderBy(workspaceJoinRequests.id)
        .for("no key update");
      const people = await tx
        .select({
          id: workspaceMembers.id,
          workspaceId: workspaceMembers.workspaceId,
          userId: workspaceMembers.userId,
          role: workspaceMembers.role,
          removedAt: workspaceMembers.removedAt,
        })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .orderBy(workspaceMembers.id)
        .for("no key update");
      const active = people.filter((person) => person.removedAt === null);
      const owners = active.filter((person) => person.role === "owner");

      // The workspaces that the account owns, archived below unless another
      // active, claimed person remains in one of them.
      let ownedWorkspaceIds: WorkspaceId[] = [];
      let workspaceRequests: PendingRequest[] = [];
      let openInvitations: Readonly<{
        id: InvitationId;
        workspaceId: WorkspaceId;
      }>[] = [];
      if (owners.length > 0) {
        const candidates = owners.map((person) => person.workspaceId);
        await lockPendingRequestsIn(tx, candidates, userId, now);
        const locked = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(idIn(workspaces.id, candidates))
          .orderBy(workspaces.id)
          .for("no key update");
        ownedWorkspaceIds = locked.map((workspace) => workspace.id);
        workspaceRequests = await lockPendingRequestsIn(
          tx,
          ownedWorkspaceIds,
          userId,
          now,
        );
        openInvitations = await tx
          .select({
            id: workspaceInvitations.id,
            workspaceId: workspaceInvitations.workspaceId,
          })
          .from(workspaceInvitations)
          .where(
            and(
              idIn(workspaceInvitations.workspaceId, ownedWorkspaceIds),
              isNull(workspaceInvitations.acceptedAt),
              isNull(workspaceInvitations.revokedAt),
            ),
          )
          .orderBy(workspaceInvitations.id)
          .for("no key update");
        const contested = await tx
          .selectDistinct({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(
            and(
              idIn(workspaceMembers.workspaceId, ownedWorkspaceIds),
              isNotNull(workspaceMembers.userId),
              ne(workspaceMembers.userId, userId),
              isNull(workspaceMembers.removedAt),
            ),
          )
          .orderBy(workspaceMembers.workspaceId);
        if (contested.length > 0) {
          return {
            erased: false,
            refusal: "owner",
            ownedWorkspaceIds: Object.freeze(
              contested.map((workspace) => workspace.workspaceId),
            ),
          };
        }
      }

      await tx
        .update(userIdentities)
        .set({
          erasedAt: now,
          subject: null,
          login: null,
          accountCreatedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(userIdentities.userId, userId),
            isNull(userIdentities.erasedAt),
          ),
        );
      await tx
        .update(users)
        .set({
          displayName: ERASED_DISPLAY_NAME,
          disabledAt: account.disabledAt ?? now,
          updatedAt: now,
        })
        .where(eq(users.id, userId));
      if (people.length > 0) {
        await tx
          .update(workspaceMembers)
          .set({ displayName: ERASED_DISPLAY_NAME, updatedAt: now })
          .where(
            idIn(
              workspaceMembers.id,
              people.map((person) => person.id),
            ),
          );
      }
      if (accountDevices.length > 0) {
        await tx
          .update(devices)
          .set({ label: ERASED_DEVICE_LABEL, updatedAt: now })
          .where(
            idIn(
              devices.id,
              accountDevices.map((device) => device.id),
            ),
          );
      }

      const undecided = requests.filter((request) => request.decision === null);
      const pending = undecided.filter((request) => request.expiresAt > now);
      const lapsed = undecided.filter((request) => request.expiresAt <= now);
      if (requests.length > 0) {
        await tx
          .update(workspaceJoinRequests)
          .set({ requestedDisplayName: ERASED_DISPLAY_NAME })
          .where(
            idIn(
              workspaceJoinRequests.id,
              requests.map((request) => request.id),
            ),
          );
      }
      if (pending.length > 0) {
        await tx
          .update(workspaceJoinRequests)
          .set({
            decision: "withdrawn",
            decidedAt: now,
            decidedByUserId: userId,
          })
          .where(
            idIn(
              workspaceJoinRequests.id,
              pending.map((request) => request.id),
            ),
          );
        await tx.insert(auditEvents).values(
          pending.map((request) => ({
            id: newUuidV7(),
            createdAt: now,
            action: "join_request.withdrawn" as const,
            workspaceId: request.workspaceId,
            subjectId: request.id,
            reason: "account_erased" as const,
          })),
        );
      }
      if (lapsed.length > 0) {
        await tx
          .update(workspaceJoinRequests)
          .set({
            decision: "expired",
            decidedAt: sql`${workspaceJoinRequests.expiresAt}`,
          })
          .where(
            idIn(
              workspaceJoinRequests.id,
              lapsed.map((request) => request.id),
            ),
          );
      }

      if (ownedWorkspaceIds.length > 0) {
        await tx
          .update(workspaces)
          .set({ archivedAt: now, updatedAt: now })
          .where(idIn(workspaces.id, ownedWorkspaceIds));
        if (openInvitations.length > 0) {
          await tx
            .update(workspaceInvitations)
            .set({ revokedAt: now, revokedByUserId: userId })
            .where(
              idIn(
                workspaceInvitations.id,
                openInvitations.map((invitation) => invitation.id),
              ),
            );
        }
        if (workspaceRequests.length > 0) {
          await tx
            .update(workspaceJoinRequests)
            .set({
              decision: "denied",
              decidedAt: now,
              decidedByUserId: userId,
            })
            .where(
              idIn(
                workspaceJoinRequests.id,
                workspaceRequests.map((request) => request.id),
              ),
            );
        }
        await tx
          .update(workspaceMembers)
          .set({ role: "member", updatedAt: now })
          .where(
            idIn(
              workspaceMembers.id,
              owners.map((person) => person.id),
            ),
          );
        const archivedRecords = (
          action:
            "workspace.archived" | "invitation.revoked" | "join_request.denied",
          rows: readonly Readonly<{ id: string; workspaceId: WorkspaceId }>[],
        ) =>
          rows.map((row) => ({
            id: newUuidV7(),
            createdAt: now,
            action,
            workspaceId: row.workspaceId,
            subjectId: row.id,
            reason: "account_erased" as const,
          }));
        await tx.insert(auditEvents).values([
          ...archivedRecords(
            "workspace.archived",
            ownedWorkspaceIds.map((id) => ({ id, workspaceId: id })),
          ),
          ...archivedRecords("invitation.revoked", openInvitations),
          ...archivedRecords("join_request.denied", workspaceRequests),
        ]);
      }

      const endedMemberships: MembershipEnd[] = [];
      for (const person of active) {
        endedMemberships.push(
          await removePerson(
            tx,
            {
              workspaceId: person.workspaceId,
              userId,
              now,
              operatorReason: "account_erased",
            },
            person,
            "member.removed",
          ),
        );
      }

      const revokedDevices: ErasedDevice[] = [];
      for (const device of accountDevices) {
        if (device.revokedAt !== null) {
          continue;
        }
        const revoked = await revokeDevice(tx, {
          deviceId: device.id,
          userId,
          reason: "account_erased",
          now,
          actorUserId: null,
          actorDeviceId: null,
        });
        if (revoked.revoked) {
          revokedDevices.push(
            Object.freeze({
              deviceId: device.id,
              disabledAgentIds: revoked.disabledAgentIds,
              revokedGrantIds: revoked.revokedGrantIds,
              cancelledRuns: revoked.cancelledRuns,
            }),
          );
        }
      }

      // Every agent of the account runs on one of its devices
      // (`agents_host_device_owner_fk`), so the index of the host device
      // finds them all.
      if (accountDevices.length > 0) {
        const ownedAgents = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              idIn(
                agents.hostDeviceId,
                accountDevices.map((device) => device.id),
              ),
              eq(agents.ownerUserId, userId),
            ),
          )
          .orderBy(agents.id)
          .for("no key update");
        if (ownedAgents.length > 0) {
          await tx
            .update(agents)
            .set({ name: ERASED_AGENT_NAME, updatedAt: now })
            .where(
              idIn(
                agents.id,
                ownedAgents.map((agent) => agent.id),
              ),
            );
        }
      }

      await tx.insert(auditEvents).values({
        id: newUuidV7(),
        createdAt: now,
        action: "account.erased",
        subjectId: userId,
      });
      return Object.freeze({
        erased: true,
        endedMemberships: Object.freeze(endedMemberships),
        revokedDevices: Object.freeze(revokedDevices),
        withdrawnJoinRequestIds: Object.freeze(
          pending.map((request) => request.id),
        ),
        archivedWorkspaces: Object.freeze(
          ownedWorkspaceIds.map((workspaceId) =>
            Object.freeze({
              workspaceId,
              revokedInvitationIds: idsIn(openInvitations, workspaceId),
              deniedJoinRequestIds: idsIn(workspaceRequests, workspaceId),
            }),
          ),
        ),
      });
    }),
  );
}
