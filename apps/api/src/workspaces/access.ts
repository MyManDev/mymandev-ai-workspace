import {
  activePersonOf,
  type ActivePerson,
  type Database,
  projects,
  workspaceMembers,
} from "@mymandev/database";
import {
  type ProjectId,
  ProjectIdSchema,
  type UserId,
  WorkspaceIdSchema,
} from "@mymandev/protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import * as z from "zod";
import { authOf } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Set on routes under `/workspaces/:workspaceId` after the membership check passed. */
    person: ActivePerson | null;
  }
}

/** The path parameters of a route under `/workspaces/:workspaceId`. */
export const WorkspaceParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
});

/**
 * Makes every route of a plugin scope check active membership first (ADR
 * 0014, "What a workspace ID allows"). Every route of the scope lies under
 * `/workspaces/:workspaceId` and needs an access token. The check runs right
 * after authentication, before the path, the query, and the body are
 * validated. An account without an active person in the workspace gets `404`
 * with `not_found`, the same answer as for a workspace that does not exist
 * or a malformed workspace ID, whatever else the request holds, so that a
 * workspace ID tells a non-member nothing.
 */
export function requireActiveMember(
  scope: FastifyInstance,
  database: Database,
): void {
  scope.decorateRequest("person", null);
  scope.addHook("preValidation", async (request) => {
    const params = WorkspaceParamsSchema.safeParse(request.params);
    const person = params.success
      ? await activePersonOf(database, {
          workspaceId: params.data.workspaceId,
          userId: authOf(request).userId,
        })
      : undefined;
    if (person === undefined) {
      throw new ApiError("not_found");
    }
    request.person = person;
  });
}

/** The caller's active person on a route that `requireActiveMember` protects. */
export function personOf(request: FastifyRequest): ActivePerson {
  if (request.person === null) {
    throw new ApiError("not_found");
  }
  return request.person;
}

/** The path parameters of a route under `/projects/:projectId`. */
export const ProjectPathParamsSchema = z.object({
  projectId: ProjectIdSchema,
});

/**
 * Whether the account is an active member of the project's workspace: it
 * has a claimed person there whose `removed_at` is empty. A project that does
 * not exist gives false, like one of a workspace without the account. Also
 * true for an archived project, whose history stays readable (#27).
 */
export async function isProjectMember(
  database: Database,
  input: Readonly<{ projectId: ProjectId; userId: UserId }>,
): Promise<boolean> {
  const [row] = await database
    .select({ id: workspaceMembers.id })
    .from(projects)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, projects.workspaceId),
        eq(workspaceMembers.userId, input.userId),
        isNull(workspaceMembers.removedAt),
      ),
    )
    .where(eq(projects.id, input.projectId))
    .limit(1);
  return row !== undefined;
}

/**
 * Makes every route of a plugin scope check, first, that the account is an
 * active member of the project's workspace (#27, #28). Every route of the
 * scope lies under `/projects/:projectId` and needs an access token. The
 * check runs right after authentication, before the path, the query, and the
 * body are validated. A project that does not exist, a project of a
 * workspace that the account is not an active member of, also after a
 * removal, and a malformed project ID get the same `404` with `not_found`,
 * whatever else the request holds, so that a project ID tells a non-member
 * nothing. A project ID names its workspace, so the path carries no
 * workspace.
 */
export function requireProjectMember(
  scope: FastifyInstance,
  database: Database,
): void {
  scope.addHook("preValidation", async (request) => {
    const params = ProjectPathParamsSchema.safeParse(request.params);
    if (
      !params.success ||
      !(await isProjectMember(database, {
        projectId: params.data.projectId,
        userId: authOf(request).userId,
      }))
    ) {
      throw new ApiError("not_found");
    }
  });
}
