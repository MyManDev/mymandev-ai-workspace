// The chat history route of #27. A project has one chat in M2. Every route
// needs an access token, and any active member of the project's workspace
// may read it. A project that does not exist and a project of a workspace
// that the account is not an active member of both answer `404` and
// `not_found`, so that a route never tells them apart.

import * as z from "zod";
import type { ApiRoute } from "./auth-api.ts";
import { ChatMessageSchema } from "./entities.ts";
import type { ApiErrorCode } from "./model.ts";
import { CHAT_HISTORY_PAGE } from "./model.ts";

function route(method: ApiRoute["method"], path: string): ApiRoute {
  return Object.freeze({ method, path });
}

/**
 * The chat routes (#27). Every path parameter is an ID. The history is
 * read only; messages are sent over the connection with
 * `chat.message.send`.
 */
export const CHAT_ROUTES = Object.freeze({
  /**
   * One page of the project's chat history, the newest message first: the
   * newest messages, or with `beforeSeq` the newest messages before that
   * number. Also the history of an archived project. Any active member.
   */
  listMessages: route("GET", "/projects/:projectId/messages"),
});
export type ChatRouteName = keyof typeof CHAT_ROUTES;

/** The codes that every chat route can answer. */
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
 * Every error code that each chat route can answer, with its status from
 * `API_ERROR_STATUS`: the common codes of the membership routes, and
 * `not_found` for a project that does not exist or that is in a workspace
 * that the account is not an active member of.
 */
export const CHAT_ROUTE_ERRORS = Object.freeze({
  listMessages: errors("not_found"),
} satisfies Record<ChatRouteName, readonly ApiErrorCode[]>);

/**
 * A positive integer in a query, from 1 to `max`, in its plain decimal form:
 * no sign, no leading zero, no exponent, and no white space.
 */
function queryInteger(max: number) {
  return z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/u, "Expected a positive integer")
    .transform(Number)
    .pipe(z.int().min(1).max(max));
}

/**
 * The query of `GET /projects/:projectId/messages`. `beforeSeq`: only
 * messages with a lower `seq`, to read older pages; without it, the newest
 * messages. `limit`: how many messages, from 1 to 100, and 50 when it is
 * omitted (`CHAT_HISTORY_PAGE`).
 */
export const ChatHistoryQuerySchema = z.object({
  beforeSeq: queryInteger(Number.MAX_SAFE_INTEGER).optional(),
  limit: queryInteger(CHAT_HISTORY_PAGE.max).default(CHAT_HISTORY_PAGE.default),
});
export type ChatHistoryQuery = z.infer<typeof ChatHistoryQuerySchema>;

/**
 * The answer of `GET /projects/:projectId/messages`: messages of the
 * project's chat, the newest first, each once. A page with fewer messages
 * than its `limit` is the oldest; the device asks for the next older page
 * with the lowest `seq` it holds as `beforeSeq`. Chat messages are
 * deduplicated by message ID, so a page that overlaps the messages that
 * arrived over the connection changes nothing.
 */
export const ChatHistoryResponseSchema = z
  .object({
    messages: z.array(ChatMessageSchema).max(CHAT_HISTORY_PAGE.max),
  })
  .superRefine((page, ctx) => {
    page.messages.forEach((message, index) => {
      const newer = page.messages[index - 1];
      if (newer === undefined) {
        return;
      }
      if (message.projectId !== newer.projectId) {
        ctx.addIssue({
          code: "custom",
          message: "Every message belongs to one project",
          path: ["messages", index, "projectId"],
        });
      }
      if (message.seq >= newer.seq) {
        ctx.addIssue({
          code: "custom",
          message: "Messages are listed once, the newest first",
          path: ["messages", index, "seq"],
        });
      }
    });
  });
export type ChatHistoryResponse = z.infer<typeof ChatHistoryResponseSchema>;
