import {
  type Database,
  getChatMessage,
  listChatMessages,
} from "@mymandev/database";
import {
  CHAT_ROUTES,
  type ChatHistoryQuery,
  ChatHistoryQuerySchema,
  type ChatHistoryResponse,
  type ChatMessageResponse,
  type MessageId,
  MessageIdSchema,
  type ProjectId,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import { authOf } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import { ProjectPathParamsSchema } from "./access.ts";

export type ChatRouteOptions = Readonly<{
  database: Database;
}>;

/** The path parameters of `GET /projects/:projectId/messages/:messageId`. */
const MessageParamsSchema = ProjectPathParamsSchema.extend({
  messageId: MessageIdSchema,
});

/**
 * The chat history of a project (#27, D5) and one of its messages (#34).
 * Registered on a scope that `requireProjectMember` protects, so a
 * non-member, a removed member, and an unknown, foreign, or malformed
 * project ID get the same `404` before the path and the query are
 * validated, and the account limit of every authenticated route applies.
 * Messages are sent over the connection with `chat.message.send`, not over
 * HTTP.
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

  // One message, as a page shows it; also of an archived project. A
  // malformed message ID answers 400 to a member, after the membership
  // check, as a malformed ID beside the project does on the other routes.
  project.get(
    CHAT_ROUTES.getMessage.path,
    { schema: { params: MessageParamsSchema } },
    async (request): Promise<ChatMessageResponse> => {
      const auth = authOf(request);
      const { projectId, messageId } = request.params as {
        projectId: ProjectId;
        messageId: MessageId;
      };
      const result = await getChatMessage(database, {
        actorUserId: auth.userId,
        projectId,
        messageId,
      });
      // A message ID that the project's chat does not have, also one of
      // another project, gets the 404 of an unknown project, and so does an
      // account removed after the membership check.
      if (!result.found) {
        throw new ApiError("not_found");
      }
      return { message: result.message };
    },
  );
}
