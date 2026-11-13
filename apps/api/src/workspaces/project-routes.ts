import {
  createProject,
  type CreateProjectResult,
  type Database,
  listProjects,
  renameProject,
} from "@mymandev/database";
import {
  type CreateProjectRequest,
  CreateProjectRequestSchema,
  type CreateProjectResponse,
  PROJECT_ROUTES,
  type ProjectId,
  ProjectIdSchema,
  type ProjectListResponse,
  type RenameProjectRequest,
  RenameProjectRequestSchema,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import { authOf, lockActor } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import { WorkspaceParamsSchema } from "./access.ts";
import {
  sendWorkspaceEvent,
  serverEventHeader,
  type WorkspaceEventHandler,
} from "./events.ts";

export type ProjectRouteOptions = Readonly<{
  database: Database;
  now: () => number;
  /** Receives `workspace.project.created` and `workspace.project.renamed` after the commit. */
  onWorkspaceEvent: WorkspaceEventHandler;
}>;

/** The path parameters of a route under `/workspaces/:workspaceId/projects/:projectId`. */
const ProjectParamsSchema = WorkspaceParamsSchema.extend({
  projectId: ProjectIdSchema,
});

type ProjectParams = Readonly<{
  workspaceId: WorkspaceId;
  projectId: ProjectId;
}>;

/**
 * The answer to a refused creation. A workspace that holds 100 projects that
 * are not archived, the limit without a wait (`retryAfterMs` null), answers
 * `409` with `project_limit` and no `Retry-After`, because no time frees a
 * place, only archiving a project does (#255). The account's 20 creations in
 * 24 hours answer `rate_limited` with the time until the oldest of them
 * leaves the window.
 */
function refusedCreation(
  result: Extract<CreateProjectResult, { created: false }>,
): ApiError {
  switch (result.refusal) {
    case "rate_limited":
      return result.retryAfterMs === null
        ? new ApiError("project_limit")
        : new ApiError("rate_limited", {
            retryAfterSeconds: result.retryAfterMs / 1000,
          });
    // An account that stopped being an active member after the membership
    // check gets the check's 404.
    case "not_member":
      return new ApiError("not_found");
    case "conflict":
      return new ApiError("conflict");
  }
}

/**
 * Creating, listing, and renaming the projects of a workspace (#155).
 * Registered on a scope that `requireActiveMember` protects, so the account
 * limit of every authenticated route applies, as on the other workspace
 * routes. Each change runs in one transaction that checks the account and
 * the device again (`lockActor`) and then decides on the locked person; a
 * frozen copy of its workspace event goes to `onWorkspaceEvent` after the
 * commit. Neither change writes an audit record: they are not
 * administrative actions of ADR 0014.
 */
export function registerProjectRoutes(
  workspace: FastifyInstance,
  options: ProjectRouteOptions,
): void {
  const { database } = options;

  workspace.get(
    PROJECT_ROUTES.listProjects.path,
    { schema: { params: WorkspaceParamsSchema } },
    async (request): Promise<ProjectListResponse> => {
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      return { projects: await listProjects(database, workspaceId) };
    },
  );

  workspace.post(
    PROJECT_ROUTES.createProject.path,
    {
      schema: {
        params: WorkspaceParamsSchema,
        body: CreateProjectRequestSchema,
      },
    },
    async (request): Promise<CreateProjectResponse> => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const { name } = request.body as CreateProjectRequest;
      const now = new Date(options.now());
      const project = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await createProject(tx, {
          workspaceId,
          userId: auth.userId,
          name,
          now,
        });
        if (!result.created) {
          throw refusedCreation(result);
        }
        return result.project;
      });
      sendWorkspaceEvent(request, options.onWorkspaceEvent, {
        ...serverEventHeader(workspaceId, now),
        type: "workspace.project.created",
        payload: { project },
      });
      return { project };
    },
  );

  // The protocol schema normalized the name, so the name in force, also sent
  // with other white space around it or in another normal form, changes
  // nothing and sends no event.
  workspace.post(
    PROJECT_ROUTES.renameProject.path,
    {
      schema: {
        params: ProjectParamsSchema,
        body: RenameProjectRequestSchema,
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId, projectId } = request.params as ProjectParams;
      const { name } = request.body as RenameProjectRequest;
      const now = new Date(options.now());
      const changed = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await renameProject(tx, {
          workspaceId,
          projectId,
          userId: auth.userId,
          name,
          now,
        });
        if (!result.renamed) {
          throw new ApiError(
            result.refusal === "not_member" ? "not_found" : result.refusal,
          );
        }
        return result.changed;
      });
      if (changed) {
        sendWorkspaceEvent(request, options.onWorkspaceEvent, {
          ...serverEventHeader(workspaceId, now),
          type: "workspace.project.renamed",
          payload: { projectId, name },
        });
      }
      return reply.code(204).send();
    },
  );
}
