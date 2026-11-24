import {
  createAgent,
  type CreateAgentResult,
  type Database,
  disableAgent,
  listProjectAgents,
  listProjectRuns,
  revokedGrantsOf,
} from "@mymandev/database";
import {
  AGENT_ROUTES,
  type AgentId,
  AgentIdSchema,
  type AgentListResponse,
  type AgentRunListResponse,
  type CreateAgentRequest,
  CreateAgentRequestSchema,
  type CreateAgentResponse,
  type ProjectId,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import { authOf, lockActor } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import type { ConnectionRegistry } from "../gateway.ts";
import { ProjectPathParamsSchema } from "./access.ts";
import {
  agentDisabledEvent,
  sendCancelledRuns,
  sendRevokedGrants,
  sendWorkspaceEvent,
  serverEventHeader,
  workspaceAgent,
  type WorkspaceEventHandler,
} from "./events.ts";

export type AgentRouteOptions = Readonly<{
  database: Database;
  now: () => number;
  /**
   * Receives `workspace.agent.created` and `workspace.agent.disabled` after
   * the commit.
   */
  onWorkspaceEvent: WorkspaceEventHandler;
  /**
   * The open connections, to which the grants that a disable revoked and the
   * runs that it cancelled go.
   */
  connections: ConnectionRegistry;
}>;

/** The path parameters of a route under `/projects/:projectId/agents/:agentId`. */
const AgentParamsSchema = ProjectPathParamsSchema.extend({
  agentId: AgentIdSchema,
});

type AgentParams = Readonly<{ projectId: ProjectId; agentId: AgentId }>;

/**
 * The answer to a refused creation (#294). A project at a count limit of
 * `AGENT_COUNT_LIMITS` answers `409` with `agent_limit` and no
 * `Retry-After`, because no time frees a place, only disabling an agent
 * frees one of the enabled agents, as a project at its limit of
 * repositories answers `repository_limit`. The account's 20 new agents in
 * 24 hours answer `rate_limited` with the time until the oldest of them
 * leaves the window. Each refusal of the database has its own case: one
 * that it adds fails the type check here.
 */
function refusedCreation(
  result: Extract<CreateAgentResult, { created: false }>,
): ApiError {
  switch (result.refusal) {
    case "agent_limit":
      return new ApiError("agent_limit");
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
    // `lockActor` refuses a disabled account and a revoked device first;
    // the database checks both again for callers without it.
    case "forbidden":
      return new ApiError("unauthorized");
    default:
      return result satisfies never;
  }
}

/**
 * A project's agents and runs (#28, D3), which the desktop reloads after
 * every `workspace.subscribed`, and the creation and the disabling of an
 * agent (#294; Project Manager decisions of 2026-11-20). Registered on a
 * scope that `requireProjectMember` protects, so a non-member, a removed
 * member, and an unknown, foreign, or malformed project ID get the same
 * `404`, and the account limit of every authenticated route applies. Run
 * transitions are sent over the connection with `agent.run.state_changed`,
 * not over HTTP.
 *
 * Each change runs in one transaction that checks the account and the
 * device again (`lockActor`) and then decides on the locked person; a frozen
 * copy of its workspace event goes to `onWorkspaceEvent` after the commit,
 * for the subscribers of the project's workspace. A disable then sends one
 * `agent.grant.revoked` for each grant that it revoked (#75; ADR 0015,
 * update of 2026-11-14) and one `agent.run.state_changed` for each run that
 * it cancelled, with the reason `agent_disabled`, to the same subscribers.
 * Neither change writes an audit record.
 */
export function registerAgentRoutes(
  project: FastifyInstance,
  options: AgentRouteOptions,
): void {
  const { database, connections } = options;

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

  // Any active member, from the calling device, which becomes the agent's
  // host device; the caller owns the agent.
  project.post(
    AGENT_ROUTES.createAgent.path,
    {
      schema: {
        params: ProjectPathParamsSchema,
        body: CreateAgentRequestSchema,
      },
    },
    async (request): Promise<CreateAgentResponse> => {
      const auth = authOf(request);
      const { projectId } = request.params as { projectId: ProjectId };
      const { name } = request.body as CreateAgentRequest;
      const now = new Date(options.now());
      const { workspaceId, agent } = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await createAgent(tx, {
          projectId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          name,
          now,
        });
        if (!result.created) {
          throw refusedCreation(result);
        }
        return result;
      });
      sendWorkspaceEvent(request, options.onWorkspaceEvent, {
        ...serverEventHeader(workspaceId, now),
        type: "workspace.agent.created",
        payload: { agent: workspaceAgent(agent) },
      });
      return { agent: workspaceAgent(agent) };
    },
  );

  // The agent's owner, from any device, the owner, and admins. Final in v0.
  project.post(
    AGENT_ROUTES.disableAgent.path,
    { schema: { params: AgentParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { projectId, agentId } = request.params as AgentParams;
      const now = new Date(options.now());
      const disabled = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await disableAgent(tx, {
          projectId,
          agentId,
          userId: auth.userId,
          now,
        });
        if (!result.disabled) {
          // An account that stopped being an active member after the
          // membership check gets the check's 404.
          throw new ApiError(
            result.refusal === "not_member" ? "not_found" : result.refusal,
          );
        }
        return {
          ...result,
          revokedGrants: await revokedGrantsOf(tx, result.revokedGrantIds),
        };
      });
      // The same event as a cascade sends for each agent that it disabled
      // (#326).
      sendWorkspaceEvent(
        request,
        options.onWorkspaceEvent,
        agentDisabledEvent(disabled, now),
      );
      // Each revoked grant and each cancelled run reaches its workspace's
      // subscribed connections, as after a device revocation or a removal
      // (P-60, P-77).
      sendRevokedGrants(request.log, connections, disabled.revokedGrants, now);
      sendCancelledRuns(connections, disabled.cancelledRuns, now);
      return reply.code(204).send();
    },
  );
}
