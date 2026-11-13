// The project routes (#155; Project Manager decision of 2026-11-02): creating,
// listing, and renaming the projects of a workspace. Every route needs an
// access token and lies under `/workspaces/:workspaceId`, so it checks active
// membership first and answers a non-member with `404` and `not_found`,
// exactly as for a workspace that does not exist (ADR 0014, "What a workspace
// ID allows"). Archiving, repositories, agents, and grants come later.

import * as z from "zod";
import type { ApiRoute } from "./auth-api.ts";
import { displayText, ProjectSchema } from "./entities.ts";
import { MemberIdSchema } from "./ids.ts";
import type { ApiErrorCode } from "./model.ts";
import { LIMITS, MAX_ANSWER_LIST_ITEMS } from "./model.ts";

function route(method: ApiRoute["method"], path: string): ApiRoute {
  return Object.freeze({ method, path });
}

/**
 * The project routes. Every path parameter is an ID. A route with a response
 * schema answers `200` with that body; every other route answers `204`
 * without a body, and the caller reads the new state from the list or the
 * server's workspace events.
 */
export const PROJECT_ROUTES = Object.freeze({
  /** The workspace's projects that are not archived, the oldest first. Any active member. */
  listProjects: route("GET", "/workspaces/:workspaceId/projects"),
  /**
   * Creates a project and its project chat in one transaction. Any active
   * member. A name that a project of the workspace that is not archived
   * already has, compared without regard to case, answers `conflict`. A
   * workspace with 100 projects that are not archived answers
   * `project_limit`, and an account that created 20 projects within 24 hours
   * answers `rate_limited`.
   */
  createProject: route("POST", "/workspaces/:workspaceId/projects"),
  /**
   * Renames a project: the account that created it, the owner, or an admin.
   * The name in force changes nothing; a name of another project answers
   * `conflict`, as for a creation.
   */
  renameProject: route(
    "POST",
    "/workspaces/:workspaceId/projects/:projectId/rename",
  ),
});
export type ProjectRouteName = keyof typeof PROJECT_ROUTES;

/** The codes that every project route can answer, as every membership route can. */
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
 * Every error code that each project route can answer, with its status from
 * `API_ERROR_STATUS`. Every route can answer `bad_request`, `unauthorized`,
 * `rate_limited` (with `Retry-After`), and `internal_error`. Beyond those:
 *
 * - `not_found`: a non-member, or a project ID that the workspace does not
 *   have, also one of another workspace;
 * - `forbidden`: the caller neither created the project nor is the owner or
 *   an admin;
 * - `conflict`: a project of the workspace that is not archived has the name,
 *   compared without regard to case, or the project is archived;
 * - `project_limit`: a creation in a workspace that holds 100 projects that
 *   are not archived, without `Retry-After`, because no time frees a place
 *   (#255).
 *
 * The limit of 20 new projects per account in 24 hours answers
 * `rate_limited`, because its places come free with time.
 */
export const PROJECT_ROUTE_ERRORS = Object.freeze({
  listProjects: errors("not_found"),
  createProject: errors("not_found", "conflict", "project_limit"),
  renameProject: errors("not_found", "forbidden", "conflict"),
} satisfies Record<ProjectRouteName, readonly ApiErrorCode[]>);

/**
 * How many characters a project name may have as sent, before it is
 * normalized: room for a name of `LIMITS.name` characters in a decomposed
 * form, which can take several code points per character, and for white
 * space around it. Longer text stops validation before it is normalized.
 */
const MAX_SENT_PROJECT_NAME_LENGTH = 1_000;

/**
 * Normalizes a project name as sent (Project Manager decision of 2026-11-02,
 * #155): to Unicode NFC, then without white space at the start and the end
 * (`String.prototype.trim`), so that names that look the same are the same.
 * Workspace and person names are not normalized.
 */
export function normalizeProjectName(name: string): string {
  return name.normalize("NFC").trim();
}

/**
 * A project's name in a request: normalized with `normalizeProjectName`,
 * then 1 to `LIMITS.name` (100) characters of single-line text by the text
 * rule of ADR 0005, as a workspace's name. The parsed value is the
 * normalized name, which the server stores and compares; a name of only
 * white space is empty after it and refused.
 */
const projectName = () =>
  z
    .string()
    .max(MAX_SENT_PROJECT_NAME_LENGTH, { abort: true })
    .transform(normalizeProjectName)
    .pipe(displayText(LIMITS.name));

/**
 * A project as the members of its workspace see it: the protocol's
 * `Project` with its creator, `createdByMemberId`. The table records the
 * creating account, and renaming rights follow that account (#155): the
 * creator is the account's active person in the workspace, so that a creator
 * who left and joined again finds their own person; without one, the
 * account's most recently removed person, so that the project still names
 * its creator, shown through that person row as a former member.
 */
export const WorkspaceProjectSchema = ProjectSchema.extend({
  createdByMemberId: MemberIdSchema,
});
export type WorkspaceProject = z.infer<typeof WorkspaceProjectSchema>;

/** `POST /workspaces/:workspaceId/projects`. */
export const CreateProjectRequestSchema = z.object({
  name: projectName(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/** The answer of `POST /workspaces/:workspaceId/projects`: the new project. */
export const CreateProjectResponseSchema = z.object({
  project: WorkspaceProjectSchema,
});
export type CreateProjectResponse = z.infer<typeof CreateProjectResponseSchema>;

/**
 * The answer of `GET /workspaces/:workspaceId/projects`: the projects that
 * are not archived, the oldest first.
 */
export const ProjectListResponseSchema = z.object({
  projects: z.array(WorkspaceProjectSchema).max(MAX_ANSWER_LIST_ITEMS),
});
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

/** `POST /workspaces/:workspaceId/projects/:projectId/rename`. */
export const RenameProjectRequestSchema = z.object({
  name: projectName(),
});
export type RenameProjectRequest = z.infer<typeof RenameProjectRequestSchema>;
