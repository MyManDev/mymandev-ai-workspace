// The read routes of a project's agent activity (#28): its agents, and its
// unfinished and recent runs. The desktop reloads both after every
// `workspace.subscribed` and then applies the buffered run events on top
// (README, resynchronizing). Every route needs an access token, and any
// active member of the project's workspace may read them. A project that
// does not exist and a project of a workspace that the account is not an
// active member of both answer `404` and `not_found`, so that a route never
// tells them apart.
//
// Creating and disabling an agent (#294; Project Manager decisions of
// 2026-11-20, whose defaults the Project Manager accepted on 2026-11-23):
// any active member of the project's workspace creates an agent from the
// calling device, which becomes the agent's host device, and the caller's
// person owns it. The agent's owner, from any of the owner's devices, and
// the workspace's owner and admins disable it. Disabling is final in v0: it
// revokes the agent's active grants and cancels its unfinished runs in its
// own transaction (ADR 0015, P-77; `agent_disabled` of
// `RUN_CANCEL_REASONS`), and nothing enables the agent again. An agent has
// no provider kind: a run names its provider connection (ADR 0007, update
// of 2026-11-14). The README lists the contract under "Agent creation and
// disabling".

import * as z from "zod";
import type { ApiRoute } from "./auth-api.ts";
import { displayText, RunStateSchema, UtcTimestampSchema } from "./entities.ts";
import {
  AgentIdSchema,
  DeviceIdSchema,
  MemberIdSchema,
  MessageIdSchema,
  ProjectIdSchema,
  ProviderConnectionIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
} from "./ids.ts";
import type { ApiErrorCode } from "./model.ts";
import { isTerminalRunState, LIMITS, MAX_ANSWER_LIST_ITEMS } from "./model.ts";

function route(method: ApiRoute["method"], path: string): ApiRoute {
  return Object.freeze({ method, path });
}

/**
 * The agent activity routes (#28) and the routes that create and disable an
 * agent (#294). Every path parameter is an ID, and no route takes a query.
 * The paths start with the project, as the chat history does: a project ID
 * names its workspace.
 */
export const AGENT_ROUTES = Object.freeze({
  /**
   * The project's agents, disabled ones included, each with its owner's
   * person. Any active member. Only the account that owns an agent gets its
   * host device (`hostDeviceId`, #342); every other reader gets none.
   */
  listAgents: route("GET", "/projects/:projectId/agents"),
  /**
   * The project's unfinished runs and its most recently finished runs. Any
   * active member.
   */
  listRuns: route("GET", "/projects/:projectId/runs"),
  /**
   * Creates an agent in the project and answers `200` with it. Any active
   * member of the project's workspace; the calling device becomes the
   * agent's host device, and the caller owns the agent (#294).
   */
  createAgent: route("POST", "/projects/:projectId/agents"),
  /**
   * Disables an agent of the project and answers `204` without a body. The
   * agent's owner, from any of the owner's devices, and the workspace's
   * owner and admins (#294). It revokes the agent's active grants and
   * cancels its unfinished runs in the same transaction.
   */
  disableAgent: route("POST", "/projects/:projectId/agents/:agentId/disable"),
});
export type AgentRouteName = keyof typeof AGENT_ROUTES;

/** The codes that every agent route can answer. */
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
 * Every error code that each agent route can answer, with its status from
 * `API_ERROR_STATUS`: the common codes of the membership routes, and
 * `not_found` for a project that does not exist or that is in a workspace
 * that the account is not an active member of. Beyond those, decided in
 * this order:
 *
 * - a creation: `conflict` for an archived project or workspace; then
 *   `agent_limit` for a project at a count limit of `AGENT_COUNT_LIMITS`,
 *   without `Retry-After`; then `rate_limited` with `Retry-After` for an
 *   account at its limit of new agents in 24 hours, whose places come free
 *   with time;
 * - a disable: `not_found` for an agent ID that the project does not have,
 *   also one of another project; `forbidden` for a caller who neither owns
 *   the agent nor is the workspace's owner or an admin; `conflict` for an
 *   agent that is already disabled, or an archived project or workspace.
 */
export const AGENT_ROUTE_ERRORS = Object.freeze({
  listAgents: errors("not_found"),
  listRuns: errors("not_found"),
  createAgent: errors("not_found", "conflict", "agent_limit"),
  disableAgent: errors("not_found", "forbidden", "conflict"),
} satisfies Record<AgentRouteName, readonly ApiErrorCode[]>);

/**
 * How many agents a project and an account may have (#294; Project Manager
 * decision of 2026-11-20):
 *
 * - `enabledPerProject`: at most 20 enabled agents in one project. A
 *   creation over it answers `agent_limit`; only disabling an agent frees a
 *   place.
 * - `perProject`: at most 500 agents in one project over its lifetime,
 *   disabled ones included. A creation over it answers `agent_limit` too,
 *   and nothing frees a place. It keeps the agent list, which holds the
 *   disabled agents too, within `MAX_ANSWER_LIST_ITEMS`.
 * - `perDay`: at most 20 new agents of one account within 24 hours, in all
 *   its projects together, disabled ones included. A creation over it
 *   answers `rate_limited` with `Retry-After`, by the rule of 2026-11-14 on
 *   #75: a limit whose places come free with time answers `rate_limited`.
 *
 * The API applies these values. They may be tuned with use (ADR 0014,
 * P-64).
 */
export const AGENT_COUNT_LIMITS = Object.freeze({
  enabledPerProject: 20,
  perProject: 500,
  perDay: 20,
} as const);

/**
 * An agent in the agent list. The owner is shown through their person row,
 * also after they were removed.
 *
 * `hostDeviceId` is optional (#342; Project Manager decision of
 * 2026-11-24), as `providerConnectionId` of a run is (#35): the agent's host
 * device is device data, which only its own account sees (#110). Only the
 * account that owns the agent gets it, on any of its devices, in the agent
 * list and in the answer of the creation, so that the owner's desktop knows
 * whether it is the agent's host device and may grant. It is absent for
 * every other reader and in every event (`workspace.agent.created` and
 * `workspace.agent.disabled` refuse it), and an answer of a server before
 * it still parses.
 */
export const AgentListItemSchema = z.object({
  id: AgentIdSchema,
  projectId: ProjectIdSchema,
  name: displayText(LIMITS.agentName),
  /** The owner's person in the project's workspace. */
  ownerMemberId: MemberIdSchema,
  /** When the agent was disabled; null while it is enabled. */
  disabledAt: UtcTimestampSchema.nullable(),
  /** The agent's host device: only for the account that owns the agent. */
  hostDeviceId: DeviceIdSchema.optional(),
});
export type AgentListItem = z.infer<typeof AgentListItemSchema>;

/**
 * `POST /projects/:projectId/agents`. The body holds the name only; every
 * other field is stripped, a host device, an owner, or a provider kind
 * included. The name is a label of 1 to `LIMITS.agentName` (64) characters
 * of single-line text by the text rule of ADR 0005: stored as sent, not
 * normalized, not trimmed, and not unique (ADR 0005, update of 2026-11-02).
 */
export const CreateAgentRequestSchema = z.object({
  name: displayText(LIMITS.agentName),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

/**
 * The answer of `POST /projects/:projectId/agents`: the new agent as its
 * owner sees it in the agent list, enabled, with its host device, the
 * calling device (#342). The schema cannot see the request, so the device
 * checks that the agent names the project of the path and the name that it
 * sent, and that `ownerMemberId` is its account's person.
 */
export const CreateAgentResponseSchema = z
  .object({ agent: AgentListItemSchema })
  .superRefine(({ agent }, ctx) => {
    if (agent.disabledAt !== null) {
      ctx.addIssue({
        code: "custom",
        message: "A new agent is enabled",
        path: ["agent", "disabledAt"],
      });
    }
  });
export type CreateAgentResponse = z.infer<typeof CreateAgentResponseSchema>;

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
 *
 * The two fields of #35 are optional, so that a run without them, and an
 * answer of a server before them, still parse:
 *
 * - `inputMessageId`: the run's input, a message of its project's chat,
 *   which every reader of the run can read in the history. A run that a
 *   request created has one; a run that the development seed created has
 *   none.
 * - `providerConnectionId`: the provider connection that the run uses, a
 *   connection of its agent's host device, which never changes after the
 *   creation. It is device data, as the agent's host device is (#110): only
 *   the account that owns the run's agent gets it, in the run list and in
 *   the answer of the creation. It is absent for every other reader, in
 *   every event, and for a run without one.
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
    inputMessageId: MessageIdSchema.optional(),
    providerConnectionId: ProviderConnectionIdSchema.optional(),
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
