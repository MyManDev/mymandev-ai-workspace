import { type Database, listClaims } from "@mymandev/database";
import {
  type ClaimListResponse,
  MEMBERSHIP_ROUTES,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import { authOf } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import { WorkspaceParamsSchema } from "./access.ts";

export type ClaimRouteOptions = Readonly<{
  database: Database;
}>;

/**
 * The recent claims of a workspace (ADR 0014, "Invitations"; #208): who
 * claimed which person, with the GitHub login and the creation date of that
 * GitHub account, and when, the most recent first, at most `RECENT_CLAIMS`.
 * Registered on a scope that `requireActiveMember` protects. The owner and
 * admins only; a member gets `403` with `forbidden`, and an account that
 * stopped being an active member after the membership check the check's
 * `404`. The route only reads, so it needs no `lockActor`, as the other lists
 * of the owner and admins.
 */
export function registerClaimRoutes(
  workspace: FastifyInstance,
  options: ClaimRouteOptions,
): void {
  const { database } = options;

  workspace.get(
    MEMBERSHIP_ROUTES.listClaims.path,
    { schema: { params: WorkspaceParamsSchema } },
    async (request): Promise<ClaimListResponse> => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const result = await listClaims(database, {
        workspaceId,
        userId: auth.userId,
      });
      if (!result.listed) {
        throw new ApiError(
          result.refusal === "not_member" ? "not_found" : result.refusal,
        );
      }
      return { claims: result.claims };
    },
  );
}
