import {
  MAX_ANSWER_LIST_ITEMS,
  type MemberId,
  newId,
  type PermissionGrantId,
  type ProjectId,
  type ProjectRepository,
  REPOSITORY_COUNT_LIMITS,
  type RepositoryId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, asc, count, desc, eq, gt, isNull, min, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { revokeGrants } from "./cascade.ts";
import type { Database } from "./db.ts";
import { withDatabaseErrors } from "./errors.ts";
import { administers, type LockedPerson, lockPeople } from "./people.ts";
import {
  permissionGrants,
  projects,
  repositories,
  users,
  workspaceMembers,
} from "./schema/index.ts";

// The repositories of a project: registering, listing, and removing them
// (#286; Project Manager decision of 2026-11-14). A repository is an
// identity and a name. The table has no column for a path or a remote URL,
// and these functions take and return none: the folder's path stays on the
// device (ADR 0005, ADR 0013).
//
// Decided by the Project Manager on 2026-11-14 (#286): any active member of
// the project's workspace registers a repository, and the account that
// registered it, the owner, and the admins remove it.
//
// Decided by the Project Manager on 2026-11-17 (#286), as proposed, the way
// the project functions settle the same points:
//
// - A project holds `REPOSITORY_COUNT_LIMITS.perProject` repositories that
//   are not removed, and an account registers
//   `REPOSITORY_COUNT_LIMITS.perDay` repositories in 24 hours.
// - A removal sets `archived_at`; nothing is deleted (ADR 0013). In the same
//   transaction it revokes every grant scoped to the repository that is not
//   revoked yet, through `revokeGrants` of `src/cascade.ts` (ADR 0015, P-77).
//   It cancels no run and disables no agent: P-77 names the grants only, and
//   a run's host device can still report it, unlike after a device
//   revocation or a removal of its person (P-60). A grant record has no
//   repository fact (Project Manager decision of 2026-11-14, #75), so this
//   revocation is what keeps a grant on a removed repository from granting.
//   The result lists the revoked grants for the `agent.grant.revoked` events
//   that the API sends after the commit (#75; `revokedGrantsOf` of
//   `src/cascade.ts`), as for every change that revokes grants.
// - A name is a label (ADR 0005, update of 2026-11-02): no unique index, and
//   it is stored as given. The API passes names that the protocol checked.
// - Neither function writes an audit record: they are not administrative
//   actions of ADR 0014, and its audit vocabulary has no repository action.
//   A revoked grant records its revoker and the time.
//
// Lock order, the order of `src/projects.ts` extended: the account (`users`),
// then the device (`devices`), as `lockActor` in the API does; then the
// acting person (`workspace_members`); then the project; then the
// repository; then the grants that a removal revokes, in the order of their
// IDs (`src/cascade.ts`). A registration locks the account, so that the
// registrations of one account are counted one after another, then the
// acting person, then the project row, so that the registrations of one
// project are counted one after another. A removal locks the acting person,
// the project, and the repository. Neither locks the workspace row: a
// repository's name is in no unique index, and the counts are per project
// and per account. An erasure (`src/account-erasure.ts`) locks a project
// before its repositories too, and both after the people.
//
// A writer that inserts a grant or a run that names a repository (#75, M3)
// locks the repository's row `FOR SHARE` or stronger, after the people that
// `src/people.ts` asks it to lock and, if it locks the project, after the
// project, and checks that the repository is not removed. A removal holds
// the row `FOR NO KEY UPDATE`, which `FOR SHARE` waits for and the
// `FOR KEY SHARE` of a foreign-key check does not; so
// either the removal commits first and the writer finds the repository
// removed, or the insert commits first and the removal revokes the new
// grant. Without this a removal could miss a grant that a concurrent insert
// added.

const DAY_MS = 24 * 60 * 60_000;

type Located = Readonly<{
  workspaceId: WorkspaceId;
  actor: LockedPerson;
  /** When the project was archived; null while it is not. */
  projectArchivedAt: Date | null;
}>;

/**
 * Locks, for a write to a project's repositories, the acting account's
 * active person in the project's workspace and then the project row, each
 * `FOR NO KEY UPDATE`. A project's workspace never changes, so it is read
 * before the locks. undefined when the project does not exist or the account
 * has no active person in its workspace.
 */
async function lockActorAndProject(
  tx: Database,
  input: Readonly<{ projectId: ProjectId; userId: UserId }>,
): Promise<Located | undefined> {
  const [found] = await tx
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, input.projectId));
  if (found === undefined) {
    return undefined;
  }
  const { actor } = await lockPeople(tx, {
    workspaceId: found.workspaceId,
    userId: input.userId,
  });
  if (actor === undefined) {
    return undefined;
  }
  const [project] = await tx
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .for("no key update");
  // Projects are never deleted, so the project read above is still there.
  if (project === undefined) {
    return undefined;
  }
  return {
    workspaceId: found.workspaceId,
    actor,
    projectArchivedAt: project.archivedAt,
  };
}

export type RegisterRepositoryInput = Readonly<{
  projectId: ProjectId;
  /** The acting account; its active person in the project's workspace registers the repository. */
  userId: UserId;
  name: string;
  now: Date;
}>;

export type RegisterRepositoryResult =
  | Readonly<{
      registered: true;
      /** The project's workspace, whose subscribers the caller tells. */
      workspaceId: WorkspaceId;
      repository: ProjectRepository;
    }>
  | Readonly<{
      registered: false;
      /**
       * `not_member`: the account is not an active member of the project's
       * workspace, also when the project does not exist; `conflict`: the
       * project is archived; `repository_limit`: the project holds 20
       * repositories that are not removed, which no time changes.
       */
      refusal: "not_member" | "conflict" | "repository_limit";
    }>
  /**
   * The account registered 20 repositories within 24 hours, the oldest of
   * which leaves the window after `retryAfterMs`.
   */
  | Readonly<{
      registered: false;
      refusal: "rate_limited";
      retryAfterMs: number;
    }>;

/**
 * Registers a repository in a project in one transaction (#286): any active
 * member of the project's workspace. It locks the account's row, so that the
 * registrations of one account are counted one after another, then the
 * acting person, then the project row, so that the registrations of one
 * project are counted one after another. It decides in this order:
 * `not_member`; `conflict` for an archived project; `repository_limit` when
 * the project holds `REPOSITORY_COUNT_LIMITS.perProject` repositories that
 * are not removed; then `rate_limited` when the account registered
 * `REPOSITORY_COUNT_LIMITS.perDay` repositories, in any project, removed ones
 * included, whose `created_at` lies within 24 hours before `now`. It inserts
 * the repository with `name` as given, the account as `created_by_user_id`,
 * and the time `now`. A name is a label, so a name that another repository
 * of the project has is accepted. Inside another transaction it runs as a
 * savepoint.
 */
export async function registerRepository(
  db: Database,
  input: RegisterRepositoryInput,
): Promise<RegisterRepositoryResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<RegisterRepositoryResult> => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .for("no key update");
      const located = await lockActorAndProject(tx, input);
      if (located === undefined) {
        return { registered: false, refusal: "not_member" };
      }
      if (located.projectArchivedAt !== null) {
        return { registered: false, refusal: "conflict" };
      }
      const [active] = await tx
        .select({ n: count() })
        .from(repositories)
        .where(
          and(
            eq(repositories.projectId, input.projectId),
            isNull(repositories.archivedAt),
          ),
        );
      if ((active?.n ?? 0) >= REPOSITORY_COUNT_LIMITS.perProject) {
        return { registered: false, refusal: "repository_limit" };
      }
      const [recent] = await tx
        .select({ n: count(), oldest: min(repositories.createdAt) })
        .from(repositories)
        .where(
          and(
            eq(repositories.createdByUserId, input.userId),
            gt(repositories.createdAt, new Date(input.now.getTime() - DAY_MS)),
          ),
        );
      if ((recent?.n ?? 0) >= REPOSITORY_COUNT_LIMITS.perDay) {
        const oldest = recent?.oldest ?? input.now;
        return {
          registered: false,
          refusal: "rate_limited",
          retryAfterMs: oldest.getTime() + DAY_MS - input.now.getTime(),
        };
      }

      const repository: ProjectRepository = {
        id: newId<RepositoryId>(),
        projectId: input.projectId,
        name: input.name,
        createdByMemberId: located.actor.id,
      };
      await tx.insert(repositories).values({
        id: repository.id,
        projectId: repository.projectId,
        name: repository.name,
        createdByUserId: input.userId,
        createdAt: input.now,
        updatedAt: input.now,
      });
      return {
        registered: true,
        workspaceId: located.workspaceId,
        repository,
      };
    }),
  );
}

export type ListRepositoriesInput = Readonly<{
  /** The reading account; it must be an active member of the project's workspace. */
  actorUserId: UserId;
  projectId: ProjectId;
}>;

export type ListRepositoriesResult =
  | Readonly<{ listed: true; repositories: ProjectRepository[] }>
  /**
   * The project does not exist, or the account is not an active member of
   * its workspace: the same answer, so that an ID cannot be probed.
   */
  | Readonly<{ listed: false; refusal: "not_found" }>;

const NOT_FOUND = Object.freeze({
  listed: false,
  refusal: "not_found",
} as const);

const registrant = alias(workspaceMembers, "registrant");

/**
 * The project's repositories that are not removed, each with who registered
 * it: the answer of `GET /projects/:projectId/repositories`. The oldest
 * first, in the order in which they were registered, so that a new one comes
 * last; at most `MAX_ANSWER_LIST_ITEMS`, far above
 * `REPOSITORY_COUNT_LIMITS.perProject`. Any active member of the project's
 * workspace reads them, also of an archived project; a project that does not
 * exist and a project of a workspace that the account is not an active
 * member of, removed members included, give the same `not_found`. The
 * membership check and the list are one statement, so they see one snapshot.
 *
 * The table records the registering account; the protocol shows that
 * account's person, `createdByMemberId`, as `listProjects` shows a project's
 * creator: its active person in the project's workspace, which holds the
 * account's right to remove the repository, or else its most recently
 * removed one, whose ID stays valid because person rows are never deleted.
 *
 * Invariant: the registering account of every repository has a person in
 * the workspace of the repository's project. `registerRepository` inserts a
 * repository only for the acting account's active person, and person rows
 * are never deleted. A repository written otherwise without one breaks the
 * invariant, and the whole list fails rather than answering without it.
 */
export async function listRepositories(
  db: Database,
  input: ListRepositoriesInput,
): Promise<ListRepositoriesResult> {
  const rows = await withDatabaseErrors(() => {
    const registrantPerson = db
      .select({ id: registrant.id })
      .from(registrant)
      .where(
        and(
          eq(registrant.workspaceId, projects.workspaceId),
          eq(registrant.userId, repositories.createdByUserId),
        ),
      )
      .orderBy(
        sql`${registrant.removedAt} desc nulls first`,
        desc(registrant.id),
      )
      .limit(1);
    // One row for each repository, or one row without a repository for a
    // project that has none; no row when the project does not exist or the
    // account has no active person in its workspace.
    return db
      .select({
        id: repositories.id,
        name: repositories.name,
        createdByMemberId: sql<MemberId | null>`(${registrantPerson})`,
      })
      .from(projects)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, projects.workspaceId),
          eq(workspaceMembers.userId, input.actorUserId),
          isNull(workspaceMembers.removedAt),
        ),
      )
      .leftJoin(
        repositories,
        and(
          eq(repositories.projectId, projects.id),
          isNull(repositories.archivedAt),
        ),
      )
      .where(eq(projects.id, input.projectId))
      .orderBy(asc(repositories.createdAt), asc(repositories.id))
      .limit(MAX_ANSWER_LIST_ITEMS);
  });
  if (rows.length === 0) {
    return NOT_FOUND;
  }
  // Outside `withDatabaseErrors`, so that the message reaches the log; it
  // holds no data of the row.
  const listed: ProjectRepository[] = [];
  for (const { id, name, createdByMemberId } of rows) {
    if (id === null || name === null) {
      continue;
    }
    if (createdByMemberId === null) {
      throw new Error(
        "Invariant broken: the registering account of a repository has no person in its project's workspace",
      );
    }
    listed.push({ id, projectId: input.projectId, name, createdByMemberId });
  }
  return { listed: true, repositories: listed };
}

export type RemoveRepositoryInput = Readonly<{
  projectId: ProjectId;
  repositoryId: RepositoryId;
  /** The acting account; its active person in the project's workspace removes the repository. */
  userId: UserId;
  now: Date;
}>;

export type RemoveRepositoryResult =
  | Readonly<{
      removed: true;
      /** The project's workspace, whose subscribers the caller tells. */
      workspaceId: WorkspaceId;
      /** The grants that the removal revoked, in the order of their IDs. */
      revokedGrantIds: readonly PermissionGrantId[];
    }>
  | Readonly<{
      removed: false;
      /**
       * `not_member`: the account is not an active member of the project's
       * workspace, also when the project does not exist; `not_found`: the
       * project has no repository with this ID; `forbidden`: the acting
       * account did not register the repository, and its person is neither
       * the owner nor an admin; `conflict`: the project is archived, or the
       * repository is already removed.
       */
      refusal: "not_member" | "not_found" | "forbidden" | "conflict";
    }>;

/**
 * Removes a repository from its project in one transaction (#286): the
 * account that registered it, also after it left the workspace and joined
 * again, the owner, or an admin. It locks the acting person, then the
 * project, then the repository, each `FOR NO KEY UPDATE`, and decides in
 * this order: `not_member`, `not_found`, `forbidden`, then `conflict` for an
 * archived project or a repository that is already removed. It sets
 * `archived_at` and `updated_at` to `now`; the row, its name, and every row
 * that names it stay (ADR 0013). Then it revokes every grant scoped to the
 * repository that is not revoked yet, an expired one included, with the
 * acting account as `revoked_by_user_id` (`revokeGrants`; ADR 0015, P-77).
 * Nothing restores them, also not clearing `archived_at`. It cancels no run
 * and disables no agent. Inside another transaction it runs as a savepoint.
 */
export async function removeRepository(
  db: Database,
  input: RemoveRepositoryInput,
): Promise<RemoveRepositoryResult> {
  return withDatabaseErrors(() =>
    db.transaction(async (tx): Promise<RemoveRepositoryResult> => {
      const located = await lockActorAndProject(tx, input);
      if (located === undefined) {
        return { removed: false, refusal: "not_member" };
      }
      const [repository] = await tx
        .select({
          createdByUserId: repositories.createdByUserId,
          archivedAt: repositories.archivedAt,
        })
        .from(repositories)
        .where(
          and(
            eq(repositories.id, input.repositoryId),
            eq(repositories.projectId, input.projectId),
          ),
        )
        .for("no key update");
      if (repository === undefined) {
        return { removed: false, refusal: "not_found" };
      }
      if (
        repository.createdByUserId !== input.userId &&
        !administers(located.actor.role)
      ) {
        return { removed: false, refusal: "forbidden" };
      }
      if (
        located.projectArchivedAt !== null ||
        repository.archivedAt !== null
      ) {
        return { removed: false, refusal: "conflict" };
      }
      await tx
        .update(repositories)
        .set({ archivedAt: input.now, updatedAt: input.now })
        .where(eq(repositories.id, input.repositoryId));
      const revokedGrantIds = await revokeGrants(
        tx,
        eq(permissionGrants.repositoryId, input.repositoryId),
        input.userId,
        input.now,
      );
      return {
        removed: true,
        workspaceId: located.workspaceId,
        revokedGrantIds: Object.freeze(revokedGrantIds),
      };
    }),
  );
}
