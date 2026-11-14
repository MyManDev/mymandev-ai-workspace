import {
  createRun,
  type CreateRunResult,
  type Database,
} from "@mymandev/database";
import {
  type AgentRunListItem,
  type AgentRunStateChangedEvent,
  type CreateRunRequest,
  CreateRunRequestSchema,
  type CreateRunResponse,
  type ProjectId,
  RUN_ROUTES,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import { authOf, lockActor } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import type { ConnectionRegistry } from "../gateway.ts";
import { ProjectPathParamsSchema } from "./access.ts";
import { serverEventHeader } from "./events.ts";

export type RunRouteOptions = Readonly<{
  database: Database;
  now: () => number;
  /**
   * The open connections, to which a creation sends the new run after the
   * commit.
   */
  connections: ConnectionRegistry;
}>;

/**
 * The answer to a refused creation (#35). An account that stopped being an
 * active member after the membership check gets the check's `404`. An agent
 * with as many unfinished runs as it may have answers `409` with `run_limit`
 * and no `Retry-After`, because no time frees a place; an agent that got as
 * many runs in 24 hours as it may answers `429` with `run_daily_limit` and
 * the time until the oldest of them leaves the 24 hours. Each refusal of
 * the database has its own case: one that it adds fails the type check
 * here.
 */
function refusedCreation(
  result: Extract<CreateRunResult, { created: false }>,
): ApiError {
  switch (result.refusal) {
    case "not_member":
      return new ApiError("not_found");
    case "not_found":
    case "forbidden":
    case "conflict":
    case "run_limit":
      return new ApiError(result.refusal);
    case "run_daily_limit":
      return new ApiError("run_daily_limit", {
        retryAfterSeconds: result.retryAfterMs / 1000,
      });
    default:
      return result satisfies never;
  }
}

/**
 * The event that tells a workspace's members that the server created a run
 * (ADR 0007): `agent.run.state_changed` from no state to `queued`, with a
 * `system` actor, `deviceId: null`, and the run's creation time. Its `run`
 * is the new run as every member reads it in the run list, built field by
 * field: it never holds the run's provider connection, which is device data
 * that only the account that owns the run's agent reads, and a field that
 * the run gains later is not sent to the members until it is added here.
 */
export function createdRunEvent(
  workspaceId: WorkspaceId,
  run: AgentRunListItem,
  now: Date,
): AgentRunStateChangedEvent {
  return {
    ...serverEventHeader(workspaceId, now),
    type: "agent.run.state_changed",
    payload: {
      runId: run.id,
      agentId: run.agentId,
      ...(run.repositoryId === null ? {} : { repositoryId: run.repositoryId }),
      previousState: null,
      state: run.state,
      run: {
        id: run.id,
        agentId: run.agentId,
        projectId: run.projectId,
        repositoryId: run.repositoryId,
        state: run.state,
        reason: run.reason,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        ...(run.inputMessageId === undefined
          ? {}
          : { inputMessageId: run.inputMessageId }),
      },
    },
  };
}

/**
 * Creating a run (#35; Project Manager decision of 2026-11-14). Registered
 * on a scope that `requireProjectMember` protects, so a non-member, a
 * removed member, and an unknown, foreign, or malformed project ID get the
 * same `404` before the body is validated, and the account limit of every
 * authenticated route applies. The creation runs in one transaction that
 * checks the account and the device again (`lockActor`) and then decides in
 * the database (`createRun`): only the account that owns the agent asks,
 * only from the agent's host device (#75), and only with a message that
 * the account wrote.
 * After the commit, the run goes to the connections subscribed to its
 * workspace as `agent.run.state_changed`, and to no one else; the asking
 * device reads it from the answer. It writes no audit record: a run is not
 * an administrative action of ADR 0014.
 */
export function registerRunRoutes(
  project: FastifyInstance,
  options: RunRouteOptions,
): void {
  const { database, connections } = options;

  project.post(
    RUN_ROUTES.createRun.path,
    {
      schema: {
        params: ProjectPathParamsSchema,
        body: CreateRunRequestSchema,
      },
    },
    async (request): Promise<CreateRunResponse> => {
      const auth = authOf(request);
      const { projectId } = request.params as { projectId: ProjectId };
      const { agentId, repositoryId, providerConnectionId, inputMessageId } =
        request.body as CreateRunRequest;
      const now = new Date(options.now());
      const created = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await createRun(tx, {
          userId: auth.userId,
          deviceId: auth.deviceId,
          projectId,
          agentId,
          repositoryId,
          providerConnectionId,
          inputMessageId,
          now,
        });
        if (!result.created) {
          throw refusedCreation(result);
        }
        return result;
      });
      // The run is committed, so a failure to tell the subscribers never
      // fails the answer; they read the run at their next reload.
      const event = createdRunEvent(created.workspaceId, created.run, now);
      try {
        const sent = connections.sendToWorkspace(event);
        request.log.debug(
          { eventType: event.type, workspaceId: event.workspaceId, sent },
          "run created",
        );
      } catch (error) {
        request.log.error(
          {
            eventType: event.type,
            workspaceId: event.workspaceId,
            errorType: error instanceof Error ? error.name : typeof error,
          },
          "run event failed",
        );
      }
      return { run: created.run };
    },
  );
}
