// The read routes of a project's agent activity (#28): its agents, and its
// unfinished and recent runs. The desktop reloads both after every
// `workspace.subscribed` and then applies the buffered run events on top
// (README, resynchronizing). Every route needs an access token, and any
// active member of the project's workspace may read them. A project that
// does not exist and a project of a workspace that the account is not an
// active member of both answer `404` and `not_found`, so that a route never
// tells them apart.

import * as z from "zod";
import type { ApiRoute } from "./auth-api.ts";
import { displayText, RunStateSchema, UtcTimestampSchema } from "./entities.ts";
import {
  AgentIdSchema,
  MemberIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
} from "./ids.ts";
import type { ApiErrorCode } from "./model.ts";
import { isTerminalRunState, LIMITS, MAX_ANSWER_LIST_ITEMS } from "./model.ts";

function route(method: ApiRoute["method"], path: string): ApiRoute {
  return Object.freeze({ method, path });
}

/**
 * The agent activity routes (#28). Every path parameter is an ID, and no
 * route takes a query. The paths start with the project, as the chat
 * history does: a project ID names its workspace.
 */
export const AGENT_ROUTES = Object.freeze({
  /**
   * The project's agents, disabled ones included, each with its owner's
   * person and never with its host device. Any active member.
   */
  listAgents: route("GET", "/projects/:projectId/agents"),
  /**
   * The project's unfinished runs and its most recently finished runs. Any
   * active member.
   */
  listRuns: route("GET", "/projects/:projectId/runs"),
});
export type AgentRouteName = keyof typeof AGENT_ROUTES;

/** The codes that every agent activity route can answer. */
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
 * Every error code that each agent activity route can answer, with its
 * status from `API_ERROR_STATUS`: the common codes of the membership routes,
 * and `not_found` for a project that does not exist or that is in a
 * workspace that the account is not an active member of.
 */
export const AGENT_ROUTE_ERRORS = Object.freeze({
  listAgents: errors("not_found"),
  listRuns: errors("not_found"),
} satisfies Record<AgentRouteName, readonly ApiErrorCode[]>);

/**
 * An agent as every member of its workspace sees it. It names no device:
 * the host device is device data, which only its own account sees (#110),
 * and the owner is shown through their person row, also after they were
 * removed.
 */
export const AgentListItemSchema = z.object({
  id: AgentIdSchema,
  projectId: ProjectIdSchema,
  name: displayText(LIMITS.agentName),
  /** The owner's person in the project's workspace. */
  ownerMemberId: MemberIdSchema,
  /** When the agent was disabled; null while it is enabled. */
  disabledAt: UtcTimestampSchema.nullable(),
});
export type AgentListItem = z.infer<typeof AgentListItemSchema>;

/** The answer of `GET /projects/:projectId/agents`: each agent once. */
export const AgentListResponseSchema = z
  .object({
    agents: z.array(AgentListItemSchema).max(MAX_ANSWER_LIST_ITEMS),
  })
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.agents.forEach((agent, index) => {
      if (agent.projectId !== list.agents[0]?.projectId) {
        ctx.addIssue({
          code: "custom",
          message: "Every agent belongs to one project",
          path: ["agents", index, "projectId"],
        });
      }
      if (seen.has(agent.id)) {
        ctx.addIssue({
          code: "custom",
          message: "An agent is listed once",
          path: ["agents", index, "id"],
        });
      }
      seen.add(agent.id);
    });
  });
export type AgentListResponse = z.infer<typeof AgentListResponseSchema>;

/**
 * A run as every member of its workspace sees it. `finishedAt` is set
 * exactly when the state is terminal, as the database requires.
 */
export const AgentRunListItemSchema = z
  .object({
    id: RunIdSchema,
    agentId: AgentIdSchema,
    projectId: ProjectIdSchema,
    repositoryId: RepositoryIdSchema.nullable(),
    state: RunStateSchema,
    /** The reason given with the last state change; null without one. */
    reason: displayText(LIMITS.runReason).nullable(),
    createdAt: UtcTimestampSchema,
    finishedAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((run, ctx) => {
    if (isTerminalRunState(run.state) !== (run.finishedAt !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "A run has a finish time exactly when it is finished",
        path: ["finishedAt"],
      });
    }
  });
export type AgentRunListItem = z.infer<typeof AgentRunListItemSchema>;

/**
 * The answer of `GET /projects/:projectId/runs`. `unfinishedRuns`: every
 * unfinished run of the project (`queued`, `running`, or `awaiting_input`),
 * up to `MAX_ANSWER_LIST_ITEMS`, the most recently created first.
 * `finishedRuns`: the project's most recently finished runs, the most
 * recently finished first; the server sends `RECENT_FINISHED_RUNS` (50) of
 * them, and the schema accepts up to `MAX_ANSWER_LIST_ITEMS`, so that
 * raising the server's count never breaks an older desktop. A run is
 * listed once.
 */
export const AgentRunListResponseSchema = z
  .object({
    unfinishedRuns: z.array(AgentRunListItemSchema).max(MAX_ANSWER_LIST_ITEMS),
    finishedRuns: z.array(AgentRunListItemSchema).max(MAX_ANSWER_LIST_ITEMS),
  })
  .superRefine((list, ctx) => {
    const projectId = (list.unfinishedRuns[0] ?? list.finishedRuns[0])
      ?.projectId;
    const seen = new Set<string>();
    const lists = [
      ["unfinishedRuns", list.unfinishedRuns, false],
      ["finishedRuns", list.finishedRuns, true],
    ] as const;
    for (const [key, runs, finished] of lists) {
      runs.forEach((run, index) => {
        if (isTerminalRunState(run.state) !== finished) {
          ctx.addIssue({
            code: "custom",
            message: finished
              ? "A finished run is in a terminal state"
              : "An unfinished run is not in a terminal state",
            path: [key, index, "state"],
          });
        }
        if (run.projectId !== projectId) {
          ctx.addIssue({
            code: "custom",
            message: "Every run belongs to one project",
            path: [key, index, "projectId"],
          });
        }
        if (seen.has(run.id)) {
          ctx.addIssue({
            code: "custom",
            message: "A run is listed once",
            path: [key, index, "id"],
          });
        }
        seen.add(run.id);
      });
    }
  });
export type AgentRunListResponse = z.infer<typeof AgentRunListResponseSchema>;
