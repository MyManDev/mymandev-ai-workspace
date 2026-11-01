import {
  createInvitation,
  type Database,
  listInvitations,
  type PersonRefusal,
  revokeInvitation,
} from "@mymandev/database";
import {
  type CreateInvitationRequest,
  CreateInvitationRequestSchema,
  type CreateInvitationResponse,
  type InvitationId,
  InvitationIdSchema,
  type InvitationListResponse,
  MEMBERSHIP_ROUTES,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import { randomToken, sha256Hex } from "../auth/attempts.ts";
import { authOf, lockActor } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import { WorkspaceParamsSchema } from "./access.ts";

/** The prefix of an invitation code (ADR 0014, "Invitations"). */
export const INVITATION_CODE_PREFIX = "mmdi_";

/** A new invitation code: the prefix and 32 random bytes as base64url. */
export function newInvitationCode(): string {
  return `${INVITATION_CODE_PREFIX}${randomToken()}`;
}

/** The hash of an invitation code that the database stores and looks up. */
export function invitationCodeHash(code: string): string {
  return sha256Hex(code);
}

export type InvitationRouteOptions = Readonly<{
  database: Database;
  now: () => number;
}>;

/** The path parameters of a route under `/workspaces/:workspaceId/invitations/:invitationId`. */
const InvitationParamsSchema = WorkspaceParamsSchema.extend({
  invitationId: InvitationIdSchema,
});

type InvitationParams = Readonly<{
  workspaceId: WorkspaceId;
  invitationId: InvitationId;
}>;

/**
 * The answer to a refused action on an invitation. An account that stopped
 * being an active member after the membership check gets the check's `404`.
 */
function refused(refusal: PersonRefusal): ApiError {
  return new ApiError(refusal === "not_member" ? "not_found" : refusal);
}

/**
 * Creating, listing, and revoking invitations (ADR 0014, "Invitations" and
 * "Limits"). Registered on a scope that `requireActiveMember` protects. The
 * owner and admins only. A change runs in one transaction that checks the
 * account and the device again (`lockActor`) and then decides on the locked
 * people. The code of a new invitation is in its answer and nowhere else:
 * the database keeps its hash, and neither the logs nor the audit records
 * see it. Invitations send no membership event, because only the owner and
 * admins see them.
 */
export function registerInvitationRoutes(
  workspace: FastifyInstance,
  options: InvitationRouteOptions,
): void {
  const { database } = options;

  workspace.get(
    MEMBERSHIP_ROUTES.listInvitations.path,
    { schema: { params: WorkspaceParamsSchema } },
    async (request): Promise<InvitationListResponse> => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const result = await listInvitations(database, {
        workspaceId,
        userId: auth.userId,
        now: new Date(options.now()),
      });
      if (!result.listed) {
        throw refused(result.refusal);
      }
      return { invitations: result.invitations };
    },
  );

  workspace.post(
    MEMBERSHIP_ROUTES.createInvitation.path,
    {
      schema: {
        params: WorkspaceParamsSchema,
        body: CreateInvitationRequestSchema,
      },
    },
    async (request, reply): Promise<CreateInvitationResponse> => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const { memberId, lifetimeSeconds } =
        request.body as CreateInvitationRequest;
      const now = new Date(options.now());
      const code = newInvitationCode();
      const invitation = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await createInvitation(tx, {
          workspaceId,
          memberId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          tokenHash: invitationCodeHash(code),
          lifetimeSeconds,
          now,
        });
        if (result.created) {
          return result.invitation;
        }
        throw result.refusal === "rate_limited"
          ? new ApiError("rate_limited", {
              retryAfterSeconds: result.retryAfterMs / 1000,
            })
          : refused(result.refusal);
      });
      reply.header("cache-control", "no-store");
      return { invitation, code };
    },
  );

  workspace.post(
    MEMBERSHIP_ROUTES.revokeInvitation.path,
    { schema: { params: InvitationParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId, invitationId } = request.params as InvitationParams;
      const now = new Date(options.now());
      await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await revokeInvitation(tx, {
          workspaceId,
          invitationId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          now,
        });
        if (!result.revoked) {
          throw refused(result.refusal);
        }
      });
      return reply.code(204).send();
    },
  );
}
