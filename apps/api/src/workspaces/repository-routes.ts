import {
  type Database,
  listRepositories,
  registerRepository,
  type RegisterRepositoryResult,
  removeRepository,
} from "@mymandev/database";
import {
  type ProjectId,
  type RegisterRepositoryRequest,
  RegisterRepositoryRequestSchema,
  type RegisterRepositoryResponse,
  REPOSITORY_ROUTES,
  type RepositoryId,
  RepositoryIdSchema,
  type RepositoryListResponse,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import { authOf, lockActor } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import { ProjectPathParamsSchema } from "./access.ts";
import {
  sendWorkspaceEvent,
  serverEventHeader,
  type WorkspaceEventHandler,
} from "./events.ts";

export type RepositoryRouteOptions = Readonly<{
  database: Database;
  now: () => number;
  /**
   * Receives `workspace.repository.registered` and
   * `workspace.repository.removed` after the commit.
   */
  onWorkspaceEvent: WorkspaceEventHandler;
}>;

/** The path parameters of a route under `/projects/:projectId/repositories/:repositoryId`. */
const RepositoryParamsSchema = ProjectPathParamsSchema.extend({
  repositoryId: RepositoryIdSchema,
});

type RepositoryParams = Readonly<{
  projectId: ProjectId;
  repositoryId: RepositoryId;
}>;

/**
 * The answer to a refused registration. A project that holds 20
 * repositories that are not removed answers `409` with `repository_limit`
 * and no `Retry-After`, because no time frees a place, only removing a
 * repository does, as a workspace at its limit of projects answers
 * `project_limit` (#255). The account's 20 registrations in 24 hours answer
 * `rate_limited` with the time until the oldest of them leaves the window.
 * Each refusal of the database has its own case: one that it adds fails the
 * type check here.
 */
function refusedRegistration(
  result: Extract<RegisterRepositoryResult, { registered: false }>,
): ApiError {
  switch (result.refusal) {
    case "repository_limit":
      return new ApiError("repository_limit");
    case "rate_limited":
      return new ApiError("rate_limited", {
        retryAfterSeconds: result.retryAfterMs / 1000,
      });
    // An account that stopped being an active member after the membership
    // check gets the check's 404.
    case "not_member":
      return new ApiError("not_found");
    case "conflict":
      return new ApiError("conflict");
    default:
      return result satisfies never;
  }
}

/**
 * Registering, listing, and removing the repositories of a project (#286;
 * Project Manager decision of 2026-11-14). Registered on a scope that
 * `requireProjectMember` protects, so a non-member, a removed member, and an
 * unknown, foreign, or malformed project ID get the same `404`, and the
 * account limit of every authenticated route applies. A repository is an
 * identity and a name: no route takes or answers a path or a remote URL, and
 * the body's schema strips every field but the name. Each change runs in one
 * transaction that checks the account and the device again (`lockActor`) and
 * then decides on the locked person; a frozen copy of its workspace event
 * goes to `onWorkspaceEvent` after the commit, for the subscribers of the
 * project's workspace. Neither change writes an audit record: they are not
 * administrative actions of ADR 0014. Who may register and remove, and the
 * code `repository_limit`, follow the Project Manager's decisions of
 * 2026-11-14 (#286), and the two limits and what a removal does follow the
 * Project Manager's decision of 2026-11-17 on #286 (protocol README,
 * "Repository routes").
 */
export function registerRepositoryRoutes(
  project: FastifyInstance,
  options: RepositoryRouteOptions,
): void {
  const { database } = options;

  // The repositories that are not removed, the oldest first; also of an
  // archived project.
  project.get(
    REPOSITORY_ROUTES.listRepositories.path,
    { schema: { params: ProjectPathParamsSchema } },
    async (request): Promise<RepositoryListResponse> => {
      const auth = authOf(request);
      const { projectId } = request.params as { projectId: ProjectId };
      const list = await listRepositories(database, {
        actorUserId: auth.userId,
        projectId,
      });
      // An account removed after the membership check gets the check's 404.
      if (!list.listed) {
        throw new ApiError("not_found");
      }
      return { repositories: list.repositories };
    },
  );

  project.post(
    REPOSITORY_ROUTES.registerRepository.path,
    {
      schema: {
        params: ProjectPathParamsSchema,
        body: RegisterRepositoryRequestSchema,
      },
    },
    async (request): Promise<RegisterRepositoryResponse> => {
      const auth = authOf(request);
      const { projectId } = request.params as { projectId: ProjectId };
      const { name } = request.body as RegisterRepositoryRequest;
      const now = new Date(options.now());
      const { workspaceId, repository } = await database.transaction(
        async (tx) => {
          await lockActor(tx, auth, now.getTime());
          const result = await registerRepository(tx, {
            projectId,
            userId: auth.userId,
            name,
            now,
          });
          if (!result.registered) {
            throw refusedRegistration(result);
          }
          return result;
        },
      );
      sendWorkspaceEvent(request, options.onWorkspaceEvent, {
        ...serverEventHeader(workspaceId, now),
        type: "workspace.repository.registered",
        payload: { repository },
      });
      return { repository };
    },
  );

  // The removal revokes the grants on the repository in its transaction
  // (ADR 0015, P-77). The event names the repository and no grant: every
  // grant scoped to it is revoked. No `agent.grant.revoked` is sent for
  // those grants until the grant routes send them for every change that
  // revokes grants (#75), as a device revocation and a removal of a person
  // send none yet (the Project Manager's decision of 2026-11-17 on #286).
  project.post(
    REPOSITORY_ROUTES.removeRepository.path,
    { schema: { params: RepositoryParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { projectId, repositoryId } = request.params as RepositoryParams;
      const now = new Date(options.now());
      const workspaceId = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await removeRepository(tx, {
          projectId,
          repositoryId,
          userId: auth.userId,
          now,
        });
        if (!result.removed) {
          // An account that stopped being an active member after the
          // membership check gets the check's 404.
          throw new ApiError(
            result.refusal === "not_member" ? "not_found" : result.refusal,
          );
        }
        return result.workspaceId;
      });
      sendWorkspaceEvent(request, options.onWorkspaceEvent, {
        ...serverEventHeader(workspaceId, now),
        type: "workspace.repository.removed",
        payload: { projectId, repositoryId },
      });
      return reply.code(204).send();
    },
  );
}
