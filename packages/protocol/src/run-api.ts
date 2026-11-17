// Creating a run (#35; Project Manager decision of 2026-11-14): the owner of
// an agent asks the server for a run of that agent in the agent's project.
// The server allocates the run's ID, stores the run in `queued`, and tells
// the workspace's subscribers with `agent.run.state_changed` (ADR 0007).
// The route needs an access token and starts with the project, as the read
// routes of the agent activity do (`AGENT_ROUTES`): a project that does not
// exist and a project of a workspace that the account is not an active
// member of both answer `404` and `not_found`.
//
// - Only the agent's owner may ask in v0: a run that another member asked
//   for would spend the owner's provider, which belongs to provider sharing
//   (M5).
// - Only from the agent's host device, as only that device grants (#75,
//   Project Manager decision of 2026-11-14): another device of the account,
//   for example one that a taken-over GitHub account registered, would
//   otherwise start a run with the grants that the agent already holds.
// - A run carries one provider connection of its agent's host device, which
//   never changes after the creation, so that the enforcement point takes
//   the scope of `provider.use` from the run that it holds (ADR 0015).
// - A run's input is a chat message of its project that the caller wrote,
//   so that the instruction shows in the project's chat as the requester's
//   own words, and no other member's or agent's text becomes the
//   instruction of the owner's run; a run has no text of its own.
//
// Provisional (#35), applied as defaults until the Project Manager decides:
// the path; that the owner asks only from the agent's host device, which
// follows the decision for grants (#75); that the input is only a message
// that the caller wrote; that only the agent's owner reads the run's
// provider connection; that the creation's event is
// `agent.run.state_changed` with an added `run`, not a new event type; the
// two limits and their codes; and that the request carries no idempotency
// key and no correlation ID. Each rule about who may ask, what the input
// is, and who reads the connection is the narrower option; widening it
// later is an additive change.

import * as z from "zod";
import { AgentRunListItemSchema } from "./agent-api.ts";
import type { ApiRoute } from "./auth-api.ts";
import {
  AgentIdSchema,
  MessageIdSchema,
  ProviderConnectionIdSchema,
  RepositoryIdSchema,
} from "./ids.ts";
import type { ApiErrorCode } from "./model.ts";
import { INITIAL_RUN_STATE } from "./model.ts";

function route(method: ApiRoute["method"], path: string): ApiRoute {
  return Object.freeze({ method, path });
}

/**
 * The run routes (#35). Every path parameter is an ID, and no route takes a
 * query. A run's later state changes are sent over the connection with
 * `agent.run.state_changed`, by the agent's host device, not over HTTP.
 */
export const RUN_ROUTES = Object.freeze({
  /**
   * Creates a run of an agent of the project, in `queued`, and answers `200`
   * with it. Only the account that owns the agent, as an active member of
   * the project's workspace, and only from the agent's host device.
   */
  createRun: route("POST", "/projects/:projectId/runs"),
});
export type RunRouteName = keyof typeof RUN_ROUTES;

/** The codes that every run route can answer, as every membership route can. */
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
 * Every error code that each run route can answer, with its status from
 * `API_ERROR_STATUS`. Every route can answer `bad_request`, `unauthorized`,
 * `rate_limited` (with `Retry-After`), and `internal_error`. Beyond those,
 * a creation answers, decided in this order:
 *
 * - `not_found`: a non-member, a project that does not exist, or an agent
 *   that the project does not have;
 * - `forbidden`: the caller does not own the agent, or the calling device
 *   is not the agent's host device. It comes before every check of the
 *   repository, the provider connection, and the message, so that only an
 *   agent's owner, on the agent's host device, learns anything about them;
 * - `not_found`: a repository that the project does not have, a provider
 *   connection that the agent's host device does not have, or a message
 *   that the project's chat does not have from the caller. Each answers
 *   alike whether the ID exists elsewhere, is a message of another author,
 *   or exists nowhere, so that an ID cannot be probed, and the answer does
 *   not say which of them it was;
 * - `conflict`: all of them exist, but one is not in the state that a run
 *   needs: the project or its workspace is archived, the agent is disabled,
 *   the repository is archived, or the provider connection is removed;
 * - `run_limit`: the agent already has as many unfinished runs as the
 *   server allows, without `Retry-After`, because no time frees a place:
 *   only a run of the agent that finishes does;
 * - `run_daily_limit`: the agent got as many new runs within 24 hours as
 *   the server allows, with `Retry-After`, the time until the oldest of
 *   them leaves the 24 hours. It has its own code, so that the desktop
 *   can tell it apart from the account's limit of requests, which stays
 *   `rate_limited`.
 *
 * The server sets both limits and tunes them with use (P-64); the API's
 * README records their values.
 */
export const RUN_ROUTE_ERRORS = Object.freeze({
  createRun: errors(
    "not_found",
    "forbidden",
    "conflict",
    "run_limit",
    "run_daily_limit",
  ),
} satisfies Record<RunRouteName, readonly ApiErrorCode[]>);

/**
 * `POST /projects/:projectId/runs`. Every field is an ID; the project is
 * the path's.
 *
 * - `agentId`: an agent of the project that the caller owns.
 * - `repositoryId`: a repository of the project, or absent for a run
 *   without one, which can never use a capability that is scoped to a
 *   repository (ADR 0015).
 * - `providerConnectionId`: a provider connection of the agent's host
 *   device. The run keeps it for good.
 * - `inputMessageId`: a message that the caller wrote in the project's chat
 *   and that is not deleted. It is the run's input; the request carries no
 *   text.
 *
 * The request carries no idempotency key: the same request sent again
 * creates a second run, so the desktop never sends it again on its own.
 */
export const CreateRunRequestSchema = z.object({
  agentId: AgentIdSchema,
  repositoryId: RepositoryIdSchema.optional(),
  providerConnectionId: ProviderConnectionIdSchema,
  inputMessageId: MessageIdSchema,
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

/**
 * The answer of `POST /projects/:projectId/runs`: the new run as its
 * agent's owner reads it in the run list, in `queued`, with its input
 * message and its provider connection. The schema cannot see the request,
 * so the device checks that the run names the project of the path and the
 * agent, the repository, the provider connection, and the message that it
 * sent.
 */
export const CreateRunResponseSchema = z
  .object({ run: AgentRunListItemSchema })
  .superRefine(({ run }, ctx) => {
    if (run.state !== INITIAL_RUN_STATE) {
      ctx.addIssue({
        code: "custom",
        message: "A new run is queued",
        path: ["run", "state"],
      });
    }
    if (run.reason !== null) {
      ctx.addIssue({
        code: "custom",
        message: "A new run has no reason",
        path: ["run", "reason"],
      });
    }
    if (run.inputMessageId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "A new run names its input message",
        path: ["run", "inputMessageId"],
      });
    }
    if (run.providerConnectionId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "A new run names its provider connection",
        path: ["run", "providerConnectionId"],
      });
    }
  });
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;
