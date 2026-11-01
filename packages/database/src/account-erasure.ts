import {
  type AgentId,
  type DeviceId,
  type JoinRequestId,
  newUuidV7,
  type PermissionGrantId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, eq, isNull, sql } from "drizzle-orm";
import { type CancelledRun, idIn } from "./cascade.ts";
import type { Database } from "./db.ts";
import { revokeDevice } from "./device-revocation.ts";
import { withDatabaseErrors } from "./errors.ts";
import { type MembershipEnd, removePerson } from "./people.ts";
import {
  auditEvents,
  devices,
  userIdentities,
  users,
  workspaceJoinRequests,
  workspaceMembers,
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
// Then the account's devices that are not revoked, its join requests, and its
// people, removed ones included, each `FOR NO KEY UPDATE` and in the order of
// their IDs. The join requests come before the people, unlike in an approval,
// which locks the approver's person and then the request: an approval that
// holds a request of the account makes the erasure wait and commits its new
// person first, which the erasure then finds and removes; otherwise the
// approval waits for the erasure and finds the request withdrawn. An
// approval locks no person of the requester, so the two cannot wait for each
// other in a cycle. After the people, each removal locks its invitations,
// agents, grants, and runs (`removePerson` in `src/people.ts`), and then each
// device revocation locks the agents, grants, and runs of its device
// (`revokeDevice`), each in the order of their IDs (`src/cascade.ts`). Every
// other transaction that changes these rows locks the account first (the
// API's requests of the account, a sign-in, `disableAccount`), or a person of
// the account first (a removal, and the future writers of agents, grants,
// and runs), so it waits for the erasure at that row, or the erasure waits
// for it there and then sees what it changed.
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

export type EraseAccountResult =
  | Readonly<{
      erased: true;
      /**
       * Each active membership that the erasure ended, as a removal ends one,
       * in the order of the person IDs.
       */
      endedMemberships: readonly MembershipEnd[];
      /** In the order of the device IDs. */
      revokedDevices: readonly ErasedDevice[];
      /** The pending join requests, now withdrawn, in the order of their IDs. */
      withdrawnJoinRequestIds: readonly JoinRequestId[];
    }>
  /**
   * `not_found`: no account has this ID, or it has no GitHub identity, which
   * the sign-in always creates with the account; `already_erased`: the
   * account's identity is erased, and nothing changed.
   */
  | Readonly<{ erased: false; refusal: "not_found" | "already_erased" }>
  /**
   * The account is the owner of these workspaces, in the order of its
   * person IDs; ownership is transferred first (ADR 0014). Nothing changed.
   */
  | Readonly<{
      erased: false;
      refusal: "owner";
      ownedWorkspaceIds: readonly WorkspaceId[];
    }>;

/**
 * Erases an account's personal data in one transaction (ADR 0014, P-62). It
 * refuses an account that owns a workspace, because the owner is never
 * removed; ownership is transferred first. Otherwise:
 *
 * - it sets `user_identities.erased_at` and clears `subject`, `login`, and
 *   `account_created_at`, so that the former GitHub ID never matches a
 *   sign-in again: a later sign-in with it creates a new account;
 * - it replaces `users.display_name`, the display names of every person of
 *   the account, removed ones included, and the requested display names of
 *   every join request of the account with `ERASED_DISPLAY_NAME`, and sets
 *   `users.disabled_at`, keeping an earlier time;
 * - it withdraws each pending join request of the account, with the account
 *   as `decided_by_user_id` and a `join_request.withdrawn` audit record, and
 *   marks a request past its expiry without a decision `expired`, with its
 *   `expires_at` as `decided_at` and no audit record, as the account's next
 *   request would, so that none of them can be approved;
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
 * messages, runs, grants, and the person rows keep their attribution to the
 * account's ID. A second erasure of the same account changes nothing.
 * It first takes the advisory lock that serializes erasures, held until the
 * transaction ends. Inside another transaction it runs as a savepoint.
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
      const liveDevices = await tx
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))
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
      const ownedWorkspaceIds = active
        .filter((person) => person.role === "owner")
        .map((person) => person.workspaceId);
      if (ownedWorkspaceIds.length > 0) {
        return {
          erased: false,
          refusal: "owner",
          ownedWorkspaceIds: Object.freeze(ownedWorkspaceIds),
        };
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
      for (const { id: deviceId } of liveDevices) {
        const revoked = await revokeDevice(tx, {
          deviceId,
          userId,
          reason: "account_erased",
          now,
          actorUserId: null,
          actorDeviceId: null,
        });
        if (revoked.revoked) {
          revokedDevices.push(
            Object.freeze({
              deviceId,
              disabledAgentIds: revoked.disabledAgentIds,
              revokedGrantIds: revoked.revokedGrantIds,
              cancelledRuns: revoked.cancelledRuns,
            }),
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
      });
    }),
  );
}
