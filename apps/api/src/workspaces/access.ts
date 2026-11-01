import {
  activePersonOf,
  type ActivePerson,
  type Database,
} from "@mymandev/database";
import { WorkspaceIdSchema } from "@mymandev/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import * as z from "zod";
import { authOf } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";

declare module "fastify" {
  interface FastifyRequest {
    /** Set on routes under `/workspaces/:workspaceId` after the membership check passed. */
    person: ActivePerson | null;
  }
}

/** The path parameters of a route under `/workspaces/:workspaceId`. */
export const WorkspaceParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
});

/**
 * Makes every route of a plugin scope check active membership first (ADR
 * 0014, "What a workspace ID allows"). Every route of the scope lies under
 * `/workspaces/:workspaceId` and needs an access token. The check runs right
 * after authentication, before the path, the query, and the body are
 * validated. An account without an active person in the workspace gets `404`
 * with `not_found`, the same answer as for a workspace that does not exist
 * or a malformed workspace ID, whatever else the request holds, so that a
 * workspace ID tells a non-member nothing.
 */
export function requireActiveMember(
  scope: FastifyInstance,
  database: Database,
): void {
  scope.decorateRequest("person", null);
  scope.addHook("preValidation", async (request) => {
    const params = WorkspaceParamsSchema.safeParse(request.params);
    const person = params.success
      ? await activePersonOf(database, {
          workspaceId: params.data.workspaceId,
          userId: authOf(request).userId,
        })
      : undefined;
    if (person === undefined) {
      throw new ApiError("not_found");
    }
    request.person = person;
  });
}

/** The caller's active person on a route that `requireActiveMember` protects. */
export function personOf(request: FastifyRequest): ActivePerson {
  if (request.person === null) {
    throw new ApiError("not_found");
  }
  return request.person;
}
