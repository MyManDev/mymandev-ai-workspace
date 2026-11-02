import {
  MAX_ANSWER_LIST_ITEMS,
  newId,
  newUuidV7,
  type Project,
  type ProjectId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, asc, count, eq, gt, isNull, min } from "drizzle-orm";
import type { Database } from "./db.ts";
import { toDatabaseError, withDatabaseErrors } from "./errors.ts";
import { administers, lockPeople } from "./people.ts";
import { conversations, projects, users, workspaces } from "./schema/index.ts";

// The projects of a workspace: creating, listing, and renaming them (#155;
// Project Manager decision of 2026-11-02). Any active member creates a
// project; its creator, the owner, and the admins rename it. A project's name
// is unique among the workspace's projects that are not archived, compared
// without regard to case; the unique index `projects_active_name_key` decides
// it, so that concurrent writers cannot both pass. Creating and renaming a
// project write no audit record: they are not administrative actions of ADR
// 0014, and its audit vocabulary has no project action.
//
// Lock order, the order of `src/people.ts` extended: the account (`users`),
// then the device (`devices`), as `lockActor` in the API does; then the
// acting person (`workspace_members`); then the workspace row (`workspaces`);
// then the project. Creating a project locks the account, so that the
// creations of one account are counted one after another, then the acting
// person, then the workspace row, so that the creations of one workspace are
// counted one after another. Renaming locks the acting person, then the
// workspace row, then the project. So every writer of a workspace's project
// names holds its workspace row, and they run one after another: two renames
// that swap two names cannot each wait for the other's entry in the unique
// index of names, a deadlock that PostgreSQL would end with an error. An
// erasure (`src/account-erasure.ts`) locks the workspace rows before their
// projects, in the same order.

const DAY_MS = 24 * 60 * 60_000;
/** Project Manager decision of 2026-11-02 (#155). */
export const MAX_ACTIVE_PROJECTS_PER_WORKSPACE = 100;
/** Project Manager decision of 2026-11-02 (#155). */
export const MAX_NEW_PROJECTS_PER_DAY = 20;

/** The unique index of one name per workspace among the projects that are not archived. */
const PROJECT_NAME_KEY = "projects_active_name_key";

/** Whether a failure is the unique index of project names. */
function isNameClash(error: unknown): boolean {
  const failure = toDatabaseError(error);
  return failure.code === "23505" && failure.constraint === PROJECT_NAME_KEY;
}

export type CreateProjectInput = Readonly<{
  workspaceId: WorkspaceId;
  /** The acting account; its active person in the workspace creates the project. */
  userId: UserId;
  name: string;
  now: Date;
}>;

export type CreateProjectResult =
  | Readonly<{ created: true; project: Project }>
  | Readonly<{
      created: false;
      /**
       * `not_member`: the account is not an active member of the workspace,
       * also when the workspace does not exist; `conflict`: a project of the
       * workspace that is not archived has the name, compared without regard
       * to case.
       */
      refusal: "not_member" | "conflict";
    }>
  /**
   * A limit is reached. The account created 20 projects within 24 hours,
   * the oldest of which leaves the window after `retryAfterMs`; or the
   * workspace holds 100 projects that are not archived, which no time
   * changes, and `retryAfterMs` is null.
   */
  | Readonly<{
      created: false;
      refusal: "rate_limited";
      retryAfterMs: number | null;
    }>;

/**
 * Creates a project in one transaction (#155): any active member of the
 * workspace. It locks the account's row, so that the creations of one
 * account are counted one after another, then the acting person, then the
 * workspace row, so that the creations of one workspace are counted one after
 * another. It refuses with `rate_limited` when the workspace holds
 * `MAX_ACTIVE_PROJECTS_PER_WORKSPACE` projects that are not archived, and
 * when the account created `MAX_NEW_PROJECTS_PER_DAY` projects, in any
 * workspace, whose `created_at` lies within 24 hours before `now`. It inserts
 * the project with `name`, the account as `created_by_user_id`, and the time
 * `now`, and its `project` conversation, the project's chat, with the same
 * account and time and no title. A name that a project of the workspace that
 * is not archived already has, compared without regard to case, fails the
 * unique index; the transaction rolls back and the result is `conflict`.
 * Inside another transaction it runs as a savepoint.
 */
export async function createProject(
  db: Database,
  input: CreateProjectInput,
): Promise<CreateProjectResult> {
  return withDatabaseErrors(async () => {
    try {
      return await db.transaction(async (tx): Promise<CreateProjectResult> => {
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, input.userId))
          .for("no key update");
        const { actor } = await lockPeople(tx, input);
        if (actor === undefined) {
          return { created: false, refusal: "not_member" };
        }
        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, input.workspaceId))
          .for("no key update");
        const [active] = await tx
          .select({ n: count() })
          .from(projects)
          .where(
            and(
              eq(projects.workspaceId, input.workspaceId),
              isNull(projects.archivedAt),
            ),
          );
        if ((active?.n ?? 0) >= MAX_ACTIVE_PROJECTS_PER_WORKSPACE) {
          return {
            created: false,
            refusal: "rate_limited",
            retryAfterMs: null,
          };
        }
        const [recent] = await tx
          .select({ n: count(), oldest: min(projects.createdAt) })
          .from(projects)
          .where(
            and(
              eq(projects.createdByUserId, input.userId),
              gt(projects.createdAt, new Date(input.now.getTime() - DAY_MS)),
            ),
          );
        if ((recent?.n ?? 0) >= MAX_NEW_PROJECTS_PER_DAY) {
          const oldest = recent?.oldest ?? input.now;
          return {
            created: false,
            refusal: "rate_limited",
            retryAfterMs: oldest.getTime() + DAY_MS - input.now.getTime(),
          };
        }

        const project: Project = {
          id: newId<ProjectId>(),
          workspaceId: input.workspaceId,
          name: input.name,
        };
        await tx.insert(projects).values({
          ...project,
          createdByUserId: input.userId,
          createdAt: input.now,
          updatedAt: input.now,
        });
        await tx.insert(conversations).values({
          id: newUuidV7(),
          projectId: project.id,
          kind: "project",
          createdByUserId: input.userId,
          createdAt: input.now,
        });
        return { created: true, project };
      });
    } catch (error) {
      if (isNameClash(error)) {
        return { created: false, refusal: "conflict" };
      }
      throw toDatabaseError(error);
    }
  });
}

/**
 * The workspace's projects that are not archived: the answer of
 * `GET /workspaces/:workspaceId/projects`. The oldest first, in the order in
 * which they were created, so that a project keeps its place when it is
 * renamed and a new one comes last; at most `MAX_ANSWER_LIST_ITEMS`, far
 * above `MAX_ACTIVE_PROJECTS_PER_WORKSPACE`. The caller checks membership
 * first.
 */
export async function listProjects(
  db: Database,
  workspaceId: WorkspaceId,
): Promise<Project[]> {
  return withDatabaseErrors(() =>
    db
      .select({
        id: projects.id,
        workspaceId: projects.workspaceId,
        name: projects.name,
      })
      .from(projects)
      .where(
        and(eq(projects.workspaceId, workspaceId), isNull(projects.archivedAt)),
      )
      .orderBy(asc(projects.createdAt), asc(projects.id))
      .limit(MAX_ANSWER_LIST_ITEMS),
  );
}

export type RenameProjectInput = Readonly<{
  workspaceId: WorkspaceId;
  projectId: ProjectId;
  /** The acting account; its active person in the workspace renames the project. */
  userId: UserId;
  name: string;
  now: Date;
}>;

export type RenameProjectResult =
  | Readonly<{
      renamed: true;
      /** false when the project already had exactly this name, and nothing was written. */
      changed: boolean;
    }>
  | Readonly<{
      renamed: false;
      /**
       * `not_member`: the account is not an active member of the workspace,
       * also when the workspace does not exist; `not_found`: the workspace
       * has no project with this ID; `forbidden`: the acting account did not
       * create the project, and its person is neither the owner nor an
       * admin; `conflict`: the project is archived, or another project of
       * the workspace that is not archived has the name, compared without
       * regard to case.
       */
      refusal: "not_member" | "not_found" | "forbidden" | "conflict";
    }>;

/**
 * Renames a project in one transaction (#155): the account that created it,
 * also after it left the workspace and joined again, the owner, or an admin.
 * It locks the acting person, then the workspace row, as a creation does, so
 * that the name changes of one workspace happen one after another, then the
 * project, each `FOR NO KEY UPDATE`, and decides in this order: `not_member`, `not_found`, `forbidden`, then
 * `conflict` for an archived project. The name in force, exactly as stored,
 * changes nothing and writes nothing; a change of case alone is a new name.
 * It sets `name` and `updated_at`. A name that another project of the
 * workspace that is not archived has fails the unique index; the
 * transaction rolls back and the result is `conflict`. Inside another
 * transaction it runs as a savepoint.
 */
export async function renameProject(
  db: Database,
  input: RenameProjectInput,
): Promise<RenameProjectResult> {
  return withDatabaseErrors(async () => {
    try {
      return await db.transaction(async (tx): Promise<RenameProjectResult> => {
        const { actor } = await lockPeople(tx, input);
        if (actor === undefined) {
          return { renamed: false, refusal: "not_member" };
        }
        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, input.workspaceId))
          .for("no key update");
        const [project] = await tx
          .select({
            name: projects.name,
            createdByUserId: projects.createdByUserId,
            archivedAt: projects.archivedAt,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, input.projectId),
              eq(projects.workspaceId, input.workspaceId),
            ),
          )
          .for("no key update");
        if (project === undefined) {
          return { renamed: false, refusal: "not_found" };
        }
        if (
          project.createdByUserId !== input.userId &&
          !administers(actor.role)
        ) {
          return { renamed: false, refusal: "forbidden" };
        }
        if (project.archivedAt !== null) {
          return { renamed: false, refusal: "conflict" };
        }
        if (project.name === input.name) {
          return { renamed: true, changed: false };
        }
        await tx
          .update(projects)
          .set({ name: input.name, updatedAt: input.now })
          .where(eq(projects.id, input.projectId));
        return { renamed: true, changed: true };
      });
    } catch (error) {
      if (isNameClash(error)) {
        return { renamed: false, refusal: "conflict" };
      }
      throw toDatabaseError(error);
    }
  });
}
