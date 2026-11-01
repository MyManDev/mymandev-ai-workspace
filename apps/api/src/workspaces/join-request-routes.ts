import {
  approveJoinRequest,
  createJoinRequest,
  type Database,
  denyJoinRequest,
  listJoinRequests,
  listOwnJoinRequests,
  type PersonRefusal,
  withdrawJoinRequest,
} from "@mymandev/database";
import {
  type AccountJoinRequestDecidedFrame,
  type ApproveJoinRequestRequest,
  ApproveJoinRequestRequestSchema,
  type ApproveJoinRequestResponse,
  type CreateJoinRequestRequest,
  CreateJoinRequestRequestSchema,
  type CreateJoinRequestResponse,
  type JoinRequestId,
  JoinRequestIdSchema,
  type JoinRequestListResponse,
  MEMBERSHIP_ROUTES,
  type OwnJoinRequestListResponse,
  PROTOCOL_VERSION,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import * as z from "zod";
import { authOf, lockActor } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import { WorkspaceParamsSchema } from "./access.ts";
import {
  type AccountFrameHandler,
  sendAccountFrame,
  sendWorkspaceEvent,
  serverEventHeader,
  type WorkspaceEventHandler,
} from "./events.ts";

export type JoinRequestRouteOptions = Readonly<{
  database: Database;
  now: () => number;
  /** Receives `workspace.member.claimed` after an approval committed. */
  onWorkspaceEvent: WorkspaceEventHandler;
  /** Receives `account.join_request_decided` for the requester after a decision committed. */
  onAccountFrame: AccountFrameHandler;
}>;

/** The path parameters of `/join-requests/:joinRequestId/withdraw`. */
const OwnJoinRequestParamsSchema = z.object({
  joinRequestId: JoinRequestIdSchema,
});

/** The path parameters of a route under `/workspaces/:workspaceId/join-requests/:joinRequestId`. */
const JoinRequestParamsSchema = WorkspaceParamsSchema.extend({
  joinRequestId: JoinRequestIdSchema,
});

type JoinRequestParams = Readonly<{
  workspaceId: WorkspaceId;
  joinRequestId: JoinRequestId;
}>;

/**
 * The answer to a refused decision. An account that stopped being an active
 * member after the membership check gets the check's `404`.
 */
function refused(refusal: PersonRefusal | "already_member"): ApiError {
  return new ApiError(refusal === "not_member" ? "not_found" : refusal);
}

/**
 * Tells the requester's open connections how an owner or admin decided on
 * their request.
 */
function sendDecision(
  request: FastifyRequest,
  options: JoinRequestRouteOptions,
  requesterUserId: UserId,
  frame: Omit<AccountJoinRequestDecidedFrame, "protocolVersion" | "type">,
): void {
  sendAccountFrame(request, options.onAccountFrame, requesterUserId, {
    protocolVersion: PROTOCOL_VERSION,
    type: "account.join_request_decided",
    ...frame,
  });
}

/**
 * The requester's join request routes (ADR 0014, "Join requests", "Limits",
 * and "What a workspace ID allows"). Registered on a scope that needs an
 * access token, outside `/workspaces/:workspaceId`: a join request is the
 * only action that a workspace ID allows a non-member, so it takes the ID in
 * its body. Its answers tell only whether a workspace with that ID exists
 * and accepts requests, and never show anything about the workspace. A
 * change runs in one transaction that checks the account and the device
 * again (`lockActor`) first.
 */
export function registerOwnJoinRequestRoutes(
  scope: FastifyInstance,
  options: JoinRequestRouteOptions,
): void {
  const { database } = options;

  scope.post(
    MEMBERSHIP_ROUTES.createJoinRequest.path,
    { schema: { body: CreateJoinRequestRequestSchema } },
    async (request): Promise<CreateJoinRequestResponse> => {
      const auth = authOf(request);
      const { workspaceId, displayName } =
        request.body as CreateJoinRequestRequest;
      const now = new Date(options.now());
      const result = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        return createJoinRequest(tx, {
          workspaceId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          displayName,
          now,
        });
      });
      if (result.requested) {
        return { joinRequest: result.joinRequest };
      }
      throw result.refusal === "rate_limited"
        ? new ApiError("rate_limited", {
            retryAfterSeconds: result.retryAfterMs / 1000,
          })
        : new ApiError(result.refusal);
    },
  );

  scope.get(
    MEMBERSHIP_ROUTES.listOwnJoinRequests.path,
    async (request): Promise<OwnJoinRequestListResponse> => {
      const auth = authOf(request);
      return {
        joinRequests: await listOwnJoinRequests(database, {
          userId: auth.userId,
          now: new Date(options.now()),
        }),
      };
    },
  );

  scope.post(
    MEMBERSHIP_ROUTES.withdrawJoinRequest.path,
    { schema: { params: OwnJoinRequestParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { joinRequestId } = request.params as {
        joinRequestId: JoinRequestId;
      };
      const now = new Date(options.now());
      await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await withdrawJoinRequest(tx, {
          joinRequestId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          now,
        });
        if (!result.withdrawn) {
          throw new ApiError(result.refusal);
        }
      });
      return reply.code(204).send();
    },
  );
}

/**
 * The approvers' join request routes (ADR 0014, "Join requests"):
 * listing, approving, and denying. Registered on a scope that
 * `requireActiveMember` protects. The owner and admins only; a member gets
 * `403` with `forbidden`. A decision runs in one transaction that checks the
 * account and the device again (`lockActor`), then locks the caller's own
 * person and the request. After the commit, an approval sends
 * `workspace.member.claimed` with the new person through `onWorkspaceEvent`,
 * and every decision sends `account.join_request_decided` to the
 * requester's open connections through `onAccountFrame`.
 */
export function registerJoinRequestRoutes(
  workspace: FastifyInstance,
  options: JoinRequestRouteOptions,
): void {
  const { database } = options;

  workspace.get(
    MEMBERSHIP_ROUTES.listJoinRequests.path,
    { schema: { params: WorkspaceParamsSchema } },
    async (request): Promise<JoinRequestListResponse> => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const result = await listJoinRequests(database, {
        workspaceId,
        userId: auth.userId,
        now: new Date(options.now()),
      });
      if (!result.listed) {
        throw refused(result.refusal);
      }
      return { joinRequests: result.joinRequests };
    },
  );

  workspace.post(
    MEMBERSHIP_ROUTES.approveJoinRequest.path,
    {
      schema: {
        params: JoinRequestParamsSchema,
        body: ApproveJoinRequestRequestSchema,
      },
    },
    async (request): Promise<ApproveJoinRequestResponse> => {
      const auth = authOf(request);
      const { workspaceId, joinRequestId } =
        request.params as JoinRequestParams;
      // Without `displayName`, the person gets the requested name.
      const { displayName } = request.body as ApproveJoinRequestRequest;
      const now = new Date(options.now());
      const approved = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await approveJoinRequest(tx, {
          workspaceId,
          joinRequestId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          ...(displayName === undefined ? {} : { displayName }),
          now,
        });
        if (!result.approved) {
          throw refused(result.refusal);
        }
        return result;
      });
      sendWorkspaceEvent(request, options.onWorkspaceEvent, {
        ...serverEventHeader(workspaceId, now),
        type: "workspace.member.claimed",
        payload: { member: approved.member },
      });
      sendDecision(request, options, approved.requesterUserId, {
        joinRequestId,
        workspaceId,
        decision: "approved",
        decidedAt: now.toISOString(),
      });
      return { member: approved.member };
    },
  );

  workspace.post(
    MEMBERSHIP_ROUTES.denyJoinRequest.path,
    { schema: { params: JoinRequestParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId, joinRequestId } =
        request.params as JoinRequestParams;
      const now = new Date(options.now());
      const requesterUserId = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await denyJoinRequest(tx, {
          workspaceId,
          joinRequestId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          now,
        });
        if (!result.denied) {
          throw refused(result.refusal);
        }
        return result.requesterUserId;
      });
      sendDecision(request, options, requesterUserId, {
        joinRequestId,
        workspaceId,
        decision: "denied",
        decidedAt: now.toISOString(),
      });
      return reply.code(204).send();
    },
  );
}
