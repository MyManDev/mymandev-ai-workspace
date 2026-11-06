import {
  type Claim,
  RECENT_CLAIMS,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, desc, eq, exists, isNotNull, or } from "drizzle-orm";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import { activePersonOf } from "./membership.ts";
import { administers } from "./people.ts";
import {
  userIdentities,
  workspaceInvitations,
  workspaceJoinRequests,
  workspaceMembers,
} from "./schema/index.ts";

// The claims of a workspace (ADR 0014, "Invitations"; #208). A claim is the
// moment an account took a person: by accepting an invitation, which claims
// the invited person, or through an approved join request, which creates a
// claimed person. Both set `workspace_members.claimed_at`, write a
// `member.claimed` audit record, and make the API send
// `workspace.member.claimed`. A person row is claimed at most once, because
// its account never changes and a rejoining account gets a new person.

export type ListClaimsInput = Readonly<{
  workspaceId: WorkspaceId;
  /** The account that asks; its active person must be the owner or an admin. */
  userId: UserId;
}>;

export type ListClaimsResult =
  | Readonly<{ listed: true; claims: Claim[] }>
  | Readonly<{ listed: false; refusal: "not_member" | "forbidden" }>;

/**
 * The workspace's recent claims: the answer of
 * `GET /workspaces/:workspaceId/claims` (#208). Only the owner and admins: a
 * member is `forbidden`, and an account without an active person in the
 * workspace `not_member`. The most recent first, by `claimed_at`, ties to the
 * higher person ID, at most `RECENT_CLAIMS` (50), whatever their age.
 *
 * A claim is a claimed person of the workspace with an accepted invitation
 * or an approved join request. The creator's own person, which
 * `createWorkspace` inserts as the claimed `owner`, has neither and is no
 * claim. A claim stays listed after its person was removed. Each shows the
 * claiming account's GitHub identity as it is now, with the login, the time
 * it was last verified (`user_identities.last_sign_in_at`), and the creation
 * date of the GitHub account, or null after the account's data was erased.
 *
 * The role check and the list are read in one read-only `REPEATABLE READ`
 * transaction, from one snapshot, so that a demotion or a removal that
 * commits in between is seen by both or by neither. Inside another
 * transaction it runs as a savepoint, at that transaction's isolation level.
 */
export async function listClaims(
  db: Database,
  input: ListClaimsInput,
): Promise<ListClaimsResult> {
  const read = await withDatabaseErrors(() =>
    db.transaction(
      async (tx) => {
        const person = await activePersonOf(tx, input);
        if (person === undefined) {
          return { listed: false, refusal: "not_member" } as const;
        }
        if (!administers(person.role)) {
          return { listed: false, refusal: "forbidden" } as const;
        }
        const acceptedInvitation = tx
          .select({ id: workspaceInvitations.id })
          .from(workspaceInvitations)
          .where(
            and(
              eq(
                workspaceInvitations.workspaceId,
                workspaceMembers.workspaceId,
              ),
              eq(workspaceInvitations.memberId, workspaceMembers.id),
              isNotNull(workspaceInvitations.acceptedAt),
            ),
          );
        const approvedRequest = tx
          .select({ id: workspaceJoinRequests.id })
          .from(workspaceJoinRequests)
          .where(
            and(
              eq(
                workspaceJoinRequests.workspaceId,
                workspaceMembers.workspaceId,
              ),
              eq(workspaceJoinRequests.memberId, workspaceMembers.id),
              eq(workspaceJoinRequests.decision, "approved"),
            ),
          );
        const rows = await tx
          .select({
            workspaceId: workspaceMembers.workspaceId,
            memberId: workspaceMembers.id,
            claimedAt: workspaceMembers.claimedAt,
            provider: userIdentities.identityProvider,
            login: userIdentities.login,
            verifiedAt: userIdentities.lastSignInAt,
            accountCreatedAt: userIdentities.accountCreatedAt,
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
              eq(workspaceMembers.workspaceId, input.workspaceId),
              isNotNull(workspaceMembers.claimedAt),
              or(exists(acceptedInvitation), exists(approvedRequest)),
            ),
          )
          .orderBy(desc(workspaceMembers.claimedAt), desc(workspaceMembers.id))
          .limit(RECENT_CLAIMS);
        return { listed: true, rows } as const;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    ),
  );
  if (!read.listed) {
    return { listed: false, refusal: read.refusal };
  }
  return {
    listed: true,
    claims: read.rows.map((row): Claim => {
      if (row.claimedAt === null) {
        // The query reads only claimed people. Outside
        // `withDatabaseErrors`, so that the message reaches the log.
        throw new Error("Invariant broken: a claim has no claim time");
      }
      return {
        workspaceId: row.workspaceId,
        memberId: row.memberId,
        claimer:
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
        claimedAt: row.claimedAt.toISOString(),
      };
    }),
  };
}
