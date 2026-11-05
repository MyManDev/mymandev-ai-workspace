// The reads of workspace, chat, and agent data that the main process may
// send to the API for #27 and #28: a frozen allowlist of six `GET` routes,
// each with the protocol's response schema and a fixed cap on the size of
// its answer. The account service sends them with the device session
// (`readWorkspaceData`); no IPC channel and no bridge member reach them.
// Chat messages are sent over the connection, never here.
import {
  AGENT_ROUTES,
  type AgentListResponse,
  AgentListResponseSchema,
  type AgentRunListResponse,
  AgentRunListResponseSchema,
  type ApiErrorCode,
  type ApiRoute,
  CHAT_ROUTES,
  type ChatHistoryResponse,
  ChatHistoryQuerySchema,
  ChatHistoryResponseSchema,
  MEMBERSHIP_ROUTES,
  PROJECT_ROUTES,
  type ProjectId,
  type ProjectListResponse,
  ProjectListResponseSchema,
  type WorkspaceId,
  type WorkspaceListResponse,
  WorkspaceListResponseSchema,
  type WorkspaceViewResponse,
  WorkspaceViewResponseSchema,
} from "@mymandev/protocol";
import type * as z from "zod";
import type { AuthorizedRequest, SessionFailure } from "./session/session.ts";

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * The most messages that one page of the chat history asks for. The API
 * accepts up to 100; the answer cap of `listMessages` fits 50.
 */
export const MESSAGE_PAGE_LIMIT = 50;

interface WorkspaceRead<T> {
  readonly route: ApiRoute;
  /** The names of the route's path parameters, in order. */
  readonly params: readonly string[];
  readonly answer: z.ZodType<T>;
  /** The cap of the answer body in bytes. */
  readonly maxAnswerBytes: number;
}

function read<T>(
  route: ApiRoute,
  params: readonly string[],
  answer: z.ZodType<T>,
  maxAnswerBytes: number,
): WorkspaceRead<T> {
  return Object.freeze({
    route,
    params: Object.freeze([...params]),
    answer,
    maxAnswerBytes,
  });
}

/**
 * The allowlist. Each cap holds the largest answer that the protocol's
 * limits allow, measured with 4-byte characters at the schema maximums,
 * with room to spare: a workspace list of 1,000 memberships is about
 * 1.06 MB, a workspace view with 1,000 people about 0.6 MB, a project list
 * of 100 projects about 57 KB, a page of 50 messages about 3.2 MB, the
 * agents about 0.46 MB, and the runs with 50 finished runs about 2.4 MB.
 * The runs' cap holds up to about 900 finished runs; a server that sends
 * more needs a desktop with a larger cap.
 */
export const WORKSPACE_READS = Object.freeze({
  /** `GET /workspaces`: the account's workspaces. */
  listWorkspaces: read(
    MEMBERSHIP_ROUTES.listWorkspaces,
    [],
    WorkspaceListResponseSchema,
    2 * MIB,
  ),
  /** `GET /workspaces/:workspaceId`: the workspace and all its people. */
  getWorkspace: read(
    MEMBERSHIP_ROUTES.getWorkspace,
    ["workspaceId"],
    WorkspaceViewResponseSchema,
    1 * MIB,
  ),
  /** `GET /workspaces/:workspaceId/projects`: its projects. */
  listProjects: read(
    PROJECT_ROUTES.listProjects,
    ["workspaceId"],
    ProjectListResponseSchema,
    512 * KIB,
  ),
  /** `GET /projects/:projectId/messages`: one page of the chat history. */
  listMessages: read(
    CHAT_ROUTES.listMessages,
    ["projectId"],
    ChatHistoryResponseSchema,
    4 * MIB,
  ),
  /** `GET /projects/:projectId/agents`: the project's agents. */
  listAgents: read(
    AGENT_ROUTES.listAgents,
    ["projectId"],
    AgentListResponseSchema,
    1 * MIB,
  ),
  /** `GET /projects/:projectId/runs`: the unfinished and recent runs. */
  listRuns: read(
    AGENT_ROUTES.listRuns,
    ["projectId"],
    AgentRunListResponseSchema,
    4 * MIB,
  ),
});
export type WorkspaceReadName = keyof typeof WORKSPACE_READS;

/** No path parameter. */
export type NoParams = Readonly<Record<string, never>>;

/** The path parameters of each read. */
export interface WorkspaceReadParams {
  readonly listWorkspaces: NoParams;
  readonly getWorkspace: { readonly workspaceId: WorkspaceId };
  readonly listProjects: { readonly workspaceId: WorkspaceId };
  readonly listMessages: { readonly projectId: ProjectId };
  readonly listAgents: { readonly projectId: ProjectId };
  readonly listRuns: { readonly projectId: ProjectId };
}

/**
 * The page of the chat history: `beforeSeq` for an older page, and `limit`
 * from 1 to `MESSAGE_PAGE_LIMIT`, which is also its default.
 */
export interface MessagePageQuery {
  readonly beforeSeq?: number;
  readonly limit?: number;
}

/** The query of each read; only `listMessages` takes one. */
export interface WorkspaceReadQuery {
  readonly listWorkspaces: never;
  readonly getWorkspace: never;
  readonly listProjects: never;
  readonly listMessages: MessagePageQuery;
  readonly listAgents: never;
  readonly listRuns: never;
}

/** The answer of each read, as its response schema parsed it. */
export interface WorkspaceReadAnswer {
  readonly listWorkspaces: WorkspaceListResponse;
  readonly getWorkspace: WorkspaceViewResponse;
  readonly listProjects: ProjectListResponse;
  readonly listMessages: ChatHistoryResponse;
  readonly listAgents: AgentListResponse;
  readonly listRuns: AgentRunListResponse;
}

/**
 * Why a read failed, a closed set:
 *
 * - `not_signed_in`: no device of this installation is signed in, or the API
 *   refused its key or its token; the answer of a device that is no longer
 *   signed in is dropped as well.
 * - `not_found`: the API answered `not_found`: the workspace or the project
 *   does not exist, or the account is not an active member of it.
 * - `rate_limited`: the API answered `rate_limited`; the caller tries again
 *   after a fixed time.
 * - `unavailable`: try again later: a sign-in, a sign-out, "This is not me",
 *   a device removal, or an unlock runs, or one began while the read was on
 *   its way, also one that has ended since; the account or the device
 *   changed meanwhile, for example another device signed in; or the API gave
 *   no answer, failed, or is not set.
 * - `failed`: the request is outside the allowlist's format, the API refused
 *   it otherwise, or the answer is too large or does not fit its schema.
 */
export const WORKSPACE_READ_FAILURES = Object.freeze([
  "not_signed_in",
  "not_found",
  "rate_limited",
  "unavailable",
  "failed",
] as const);
export type WorkspaceReadFailure = (typeof WORKSPACE_READ_FAILURES)[number];

export type WorkspaceReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: WorkspaceReadFailure };

export function workspaceReadFailed(
  reason: WorkspaceReadFailure,
): WorkspaceReadResult<never> {
  return Object.freeze({ ok: false, reason });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inRange(value: unknown, max: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= max
  );
}

/** The encoded query of a chat history page, or null outside its format. */
function messagePageQuery(query: unknown): Record<string, string> | null {
  const given: Readonly<Record<string, unknown>> =
    query === undefined ? {} : isRecord(query) ? query : { invalid: true };
  for (const key of Object.keys(given)) {
    if (key !== "beforeSeq" && key !== "limit") {
      return null;
    }
  }
  const { beforeSeq, limit = MESSAGE_PAGE_LIMIT } = given;
  if (
    (beforeSeq !== undefined && !inRange(beforeSeq, Number.MAX_SAFE_INTEGER)) ||
    !inRange(limit, MESSAGE_PAGE_LIMIT)
  ) {
    return null;
  }
  // The limit is always sent, so that the answer fits its cap whatever the
  // API's default is.
  const encoded: Record<string, string> =
    beforeSeq === undefined
      ? { limit: String(limit) }
      : { beforeSeq: String(beforeSeq), limit: String(limit) };
  return ChatHistoryQuerySchema.safeParse(encoded).success ? encoded : null;
}

/**
 * The session's request for one read of the allowlist, or null when the
 * name is not on it or a parameter or the query is outside its format. The
 * values are checked at runtime as well, because a caller's types do not
 * hold at runtime. A path parameter that is not an ID is refused by the
 * session's `routePath` before anything is sent.
 */
export function workspaceReadRequest<N extends WorkspaceReadName>(
  name: N,
  params: unknown,
  query: unknown,
): AuthorizedRequest<WorkspaceReadAnswer[N]> | null {
  if (typeof name !== "string" || !Object.hasOwn(WORKSPACE_READS, name)) {
    return null;
  }
  const entry = WORKSPACE_READS[name] as WorkspaceRead<WorkspaceReadAnswer[N]>;
  if (!isRecord(params)) {
    return null;
  }
  const names = Object.keys(params);
  if (
    names.length !== entry.params.length ||
    !entry.params.every(
      (param) =>
        Object.hasOwn(params, param) && typeof params[param] === "string",
    )
  ) {
    return null;
  }
  let encoded: Record<string, string> | undefined;
  if (name === "listMessages") {
    const page = messagePageQuery(query);
    if (page === null) {
      return null;
    }
    encoded = page;
  } else if (query !== undefined) {
    return null;
  }
  const filled: Record<string, string> = {};
  for (const param of entry.params) {
    filled[param] = params[param] as string;
  }
  return Object.freeze({
    route: entry.route,
    params: Object.freeze(filled),
    ...(encoded === undefined ? {} : { query: Object.freeze(encoded) }),
    answer: entry.answer,
    maxAnswerBytes: entry.maxAnswerBytes,
  });
}

/** The API's codes that mean that the device or its token is refused. */
const NOT_SIGNED_IN_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>([
  "unauthorized",
  "auth_failed",
  "device_revoked",
  "sign_in_required",
  "device_account_mismatch",
]);

/** The closed failure of a read for a failure of the device session. */
export function workspaceReadFailureOf(
  failure: SessionFailure,
): WorkspaceReadFailure {
  switch (failure.reason) {
    case "no_device":
    case "key_lost":
    case "key_not_loaded":
    case "signed_out":
    case "removal_pending":
      return "not_signed_in";
    case "refused": {
      const code = failure.code;
      if (code === "not_found" || code === "workspace_not_found") {
        return "not_found";
      }
      if (code === "rate_limited") {
        return "rate_limited";
      }
      if (code === "internal_error") {
        return "unavailable";
      }
      return code !== undefined && NOT_SIGNED_IN_CODES.has(code)
        ? "not_signed_in"
        : "failed";
    }
    case "invalid_request":
    case "unexpected_response":
      return "failed";
    case "api_origin_unset":
    case "api_origin_invalid":
    case "record_unreadable":
    case "key_store_failed":
    case "sign_in_running":
    case "replacement_pending":
    case "record_not_saved":
    case "no_answer":
    case "server_error":
      return "unavailable";
  }
}
