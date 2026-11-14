// The repository routes (#286; Project Manager decision of 2026-11-14):
// registering a repository in a project, listing a project's repositories,
// and removing one. The cloud keeps an identity and a name for a repository
// and nothing else. The folder's path stays on the device, which keeps its
// own map from `RepositoryId` to the path (ADR 0005, ADR 0013), and no route
// takes a remote URL, which ADR 0013 defers. Every route needs an access
// token and lies under `/projects/:projectId`, like the agent activity
// routes: a project ID names its workspace. A project that does not exist
// and a project of a workspace that the account is not an active member of
// both answer `404` and `not_found`, so that a route never tells them apart.
//
// The decision of 2026-11-14 settles the identity, the name, and that the
// path stays on the device. Provisional (#286): who may register and remove,
// the two limits and the code `repository_limit`, the rule of the name, the
// paths, the event payloads, and what a removal does to grants and runs. Each
// such choice below is the conservative one, as the project routes settle
// them, and is marked "Provisional"; the README lists them with their
// alternatives under "Repository routes".

import * as z from "zod";
import type { ApiRoute } from "./auth-api.ts";
import { displayText, RepositorySchema } from "./entities.ts";
import { MemberIdSchema } from "./ids.ts";
import type { ApiErrorCode } from "./model.ts";
import { LIMITS, MAX_ANSWER_LIST_ITEMS } from "./model.ts";
import { privatePattern } from "./private-pattern.ts";

function route(method: ApiRoute["method"], path: string): ApiRoute {
  return Object.freeze({ method, path });
}

/**
 * The repository routes. Every path parameter is an ID, and no route takes a
 * query. A route with a response schema answers `200` with that body; the
 * removal answers `204` without a body, and the caller reads the new state
 * from the list or the server's workspace events.
 */
export const REPOSITORY_ROUTES = Object.freeze({
  /**
   * The project's repositories that are not removed, the oldest first, also
   * of an archived project. Any active member.
   */
  listRepositories: route("GET", "/projects/:projectId/repositories"),
  /**
   * Registers a repository in the project: an identity and a name.
   * Provisional (#286): any active member. An archived project answers `conflict`, a project with 20
   * repositories that are not removed answers `repository_limit`, and an
   * account that registered 20 repositories within 24 hours answers
   * `rate_limited`.
   */
  registerRepository: route("POST", "/projects/:projectId/repositories"),
  /**
   * Removes a repository from the project. Provisional (#286): the account
   * that registered it, the owner, or an admin. The removal revokes every grant scoped to the
   * repository in the same transaction (ADR 0015, P-77). A repository that
   * is already removed, or one of an archived project, answers `conflict`.
   */
  removeRepository: route(
    "POST",
    "/projects/:projectId/repositories/:repositoryId/remove",
  ),
});
export type RepositoryRouteName = keyof typeof REPOSITORY_ROUTES;

/** The codes that every repository route can answer, as every membership route can. */
const COMMON_ERRORS = Object.freeze([
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
] as const satisfies readonly ApiErrorCode[]);

function errors(...codes: readonly ApiErrorCode[]): readonly ApiErrorCode[] {
  return Object.freeze([...COMMON_ERRORS, ...codes]);
}

/**
 * Every error code that each repository route can answer, with its status
 * from `API_ERROR_STATUS`. Every route can answer `bad_request`,
 * `unauthorized`, `rate_limited` (with `Retry-After`), and `internal_error`.
 * Beyond those:
 *
 * - `not_found`: a project that does not exist or that is in a workspace
 *   that the account is not an active member of, or a repository ID that the
 *   project does not have, also one of another project;
 * - `forbidden`: the caller neither registered the repository nor is the
 *   owner or an admin;
 * - `conflict`: the project is archived, or the repository is already
 *   removed;
 * - `repository_limit`: a registration in a project that holds 20
 *   repositories that are not removed, without `Retry-After`, because no
 *   time frees a place, only removing a repository does.
 *
 * The limit of 20 new repositories per account in 24 hours answers
 * `rate_limited`, because its places come free with time.
 */
export const REPOSITORY_ROUTE_ERRORS = Object.freeze({
  listRepositories: errors("not_found"),
  registerRepository: errors("not_found", "conflict", "repository_limit"),
  removeRepository: errors("not_found", "forbidden", "conflict"),
} satisfies Record<RepositoryRouteName, readonly ApiErrorCode[]>);

/**
 * How many repositories a project and an account may have (#286): at most
 * 20 repositories of one project that are not removed, and at most 20 new
 * repositories of one account within 24 hours, in all its projects together.
 * A registration over `perProject` answers `repository_limit`, and one over
 * `perDay` answers `rate_limited` with `Retry-After`. The API applies these
 * values. Both lie far below `MAX_ANSWER_LIST_ITEMS`, so raising one never
 * breaks an older desktop. The numbers await the Project Manager's
 * confirmation (Provisional, #286): 20 is the account's limit of new
 * projects in 24 hours and of active devices, and a limit is raised more
 * easily than lowered.
 */
export const REPOSITORY_COUNT_LIMITS = Object.freeze({
  perProject: 20,
  perDay: 20,
} as const);

/**
 * Text without a slash and without a backslash. A repository's name as sent
 * must match it: a folder's full path, on any operating system, and a remote
 * URL hold one of the two, so neither can travel as a name. The path of a
 * repository never leaves the device (ADR 0005, ADR 0013). Provisional
 * (#286): the rule awaits the Project Manager's confirmation; without it a
 * name is any label.
 */
export const REPOSITORY_NAME_PATTERN = /^[^/\\]*$/u;

const repositoryNamePattern = privatePattern(REPOSITORY_NAME_PATTERN);

/**
 * A repository's name in a request: 1 to `LIMITS.name` (100) characters of
 * single-line text by the text rule of ADR 0005, as a workspace's name, and
 * without a slash or a backslash (`REPOSITORY_NAME_PATTERN`). The name is a
 * label that a person chose and is stored as sent: it is not normalized and
 * not unique (ADR 0005, update of 2026-11-02).
 */
const repositoryName = () =>
  displayText(LIMITS.name).regex(
    repositoryNamePattern,
    "Must not contain a slash or a backslash",
  );

/**
 * A repository as the members of its workspace see it: the protocol's
 * `Repository` with who registered it, `createdByMemberId`. The table
 * records the registering account, and the right to remove the repository
 * follows that account: the person is the account's active person in the
 * workspace, so that someone who left and joined again finds their own
 * person; without one, the account's most recently removed person, shown
 * through that person row as a former member. It carries no path and no
 * remote URL, and its name is the stored one, which the rule for a sent
 * name does not bind.
 */
export const ProjectRepositorySchema = RepositorySchema.extend({
  createdByMemberId: MemberIdSchema,
});
export type ProjectRepository = z.infer<typeof ProjectRepositorySchema>;

/**
 * `POST /projects/:projectId/repositories`. The body holds the name only;
 * every other field is stripped, a path or a URL included.
 */
export const RegisterRepositoryRequestSchema = z.object({
  name: repositoryName(),
});
export type RegisterRepositoryRequest = z.infer<
  typeof RegisterRepositoryRequestSchema
>;

/** The answer of `POST /projects/:projectId/repositories`: the new repository. */
export const RegisterRepositoryResponseSchema = z.object({
  repository: ProjectRepositorySchema,
});
export type RegisterRepositoryResponse = z.infer<
  typeof RegisterRepositoryResponseSchema
>;

/**
 * The answer of `GET /projects/:projectId/repositories`: the project's
 * repositories that are not removed, the oldest first, each once.
 */
export const RepositoryListResponseSchema = z
  .object({
    repositories: z.array(ProjectRepositorySchema).max(MAX_ANSWER_LIST_ITEMS),
  })
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.repositories.forEach((repository, index) => {
      if (repository.projectId !== list.repositories[0]?.projectId) {
        ctx.addIssue({
          code: "custom",
          message: "Every repository belongs to one project",
          path: ["repositories", index, "projectId"],
        });
      }
      if (seen.has(repository.id)) {
        ctx.addIssue({
          code: "custom",
          message: "A repository is listed once",
          path: ["repositories", index, "id"],
        });
      }
      seen.add(repository.id);
    });
  });
export type RepositoryListResponse = z.infer<
  typeof RepositoryListResponseSchema
>;
