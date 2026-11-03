import {
  type Database,
  listProjectAgents,
  listProjectRuns,
} from "@mymandev/database";
import {
  AGENT_ROUTES,
  type AgentListResponse,
  type AgentRunListResponse,
  type ProjectId,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import { authOf } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import { ProjectPathParamsSchema } from "./access.ts";

export type AgentRouteOptions = Readonly<{
  database: Database;
}>;

/**
 * A project's agents and runs (#28, D3), which the desktop reloads after
 * every `workspace.subscribed`. Registered on a scope that
 * `requireProjectMember` protects, so a non-member, a removed member, and an
 * unknown, foreign, or malformed project ID get the same `404`, and the
 * account limit of every authenticated route applies. Run transitions are
 * sent over the connection with `agent.run.state_changed`, not over HTTP.
 */
export function registerAgentRoutes(
  project: FastifyInstance,
  options: AgentRouteOptions,
): void {
  const { database } = options;

  // Disabled agents included, without their host device; also of an
  // archived project.
  project.get(
    AGENT_ROUTES.listAgents.path,
    { schema: { params: ProjectPathParamsSchema } },
    async (request): Promise<AgentListResponse> => {
      const auth = authOf(request);
      const { projectId } = request.params as { projectId: ProjectId };
      const list = await listProjectAgents(database, {
        actorUserId: auth.userId,
        projectId,
      });
      // An account removed after the membership check gets the check's 404.
      if (!list.listed) {
        throw new ApiError("not_found");
      }
      return { agents: list.agents };
    },
  );

  // The unfinished runs, the most recently created first, and the most
  // recently finished runs, the most recently finished first.
  project.get(
    AGENT_ROUTES.listRuns.path,
    { schema: { params: ProjectPathParamsSchema } },
    async (request): Promise<AgentRunListResponse> => {
      const auth = authOf(request);
      const { projectId } = request.params as { projectId: ProjectId };
      const list = await listProjectRuns(database, {
        actorUserId: auth.userId,
        projectId,
      });
      if (!list.listed) {
        throw new ApiError("not_found");
      }
      return {
        unfinishedRuns: list.unfinishedRuns,
        finishedRuns: list.finishedRuns,
      };
    },
  );
}
