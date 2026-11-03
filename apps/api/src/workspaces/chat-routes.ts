import { type Database, listChatMessages } from "@mymandev/database";
import {
  CHAT_ROUTES,
  type ChatHistoryQuery,
  ChatHistoryQuerySchema,
  type ChatHistoryResponse,
  type ProjectId,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import { authOf } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import { ProjectPathParamsSchema } from "./access.ts";

export type ChatRouteOptions = Readonly<{
  database: Database;
}>;

/**
 * The chat history of a project (#27, D5). Registered on a scope that
 * `requireProjectMember` protects, so a non-member, a removed member, and an
 * unknown, foreign, or malformed project ID get the same `404` before the
 * query is validated, and the account limit of every authenticated route
 * applies. Messages are sent over the connection with `chat.message.send`,
 * not over HTTP.
 */
export function registerChatRoutes(
  project: FastifyInstance,
  options: ChatRouteOptions,
): void {
  const { database } = options;

  // The newest messages first; with `beforeSeq`, the newest before it.
  // Also the history of an archived project.
  project.get(
    CHAT_ROUTES.listMessages.path,
    {
      schema: {
        params: ProjectPathParamsSchema,
        querystring: ChatHistoryQuerySchema,
      },
    },
    async (request): Promise<ChatHistoryResponse> => {
      const auth = authOf(request);
      const { projectId } = request.params as { projectId: ProjectId };
      const { beforeSeq, limit } = request.query as ChatHistoryQuery;
      const page = await listChatMessages(database, {
        actorUserId: auth.userId,
        projectId,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        limit,
      });
      // An account removed after the membership check gets the check's 404.
      if (!page.listed) {
        throw new ApiError("not_found");
      }
      return { messages: page.messages };
    },
  );
}
