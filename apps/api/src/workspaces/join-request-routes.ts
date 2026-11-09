import {
  approveJoinRequest,
  blockJoinRequest,
  createJoinRequest,
  type Database,
  denyAllJoinRequests,
  denyJoinRequest,
  joinRequestApprovers,
  joinRequestForApprovers,
  listJoinRequests,
  listOwnJoinRequests,
  pauseJoinRequests,
  type PersonRefusal,
  resumeJoinRequests,
  unblockJoinRequest,
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
  type JoinRequest,
  type JoinRequestId,
  JoinRequestIdSchema,
  type JoinRequestListResponse,
  type JoinRequestOutcome,
  MEMBERSHIP_ROUTES,
  type MemberId,
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
  type ApproverEventHandler,
  sendAccountFrame,
  sendApproverEvent,
  sendWorkspaceEvent,
  serverEventHeader,
  type WorkspaceEventHandler,
} from "./events.ts";

export type JoinRequestRouteOptions = Readonly<{
  database: Database;
  now: () => number;
  /** Receives `workspace.member.claimed` after an approval committed. */
  onWorkspaceEvent: WorkspaceEventHandler;
  /**
   * Receives the join request events (#210) for the workspace's owner and
   * admins after the change committed: `workspace.join_request.created`
   * after a new request, and `workspace.join_request.resolved` after a
   * withdrawal, an approval, a denial, a block, and each request that
   * denying all denied.
   */
  onApproverEvent: ApproverEventHandler;
  /**
   * Receives `account.join_request_decided` for the requester after an
   * approval, a denial, a block, or denying all committed.
   */
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
 * Tells the workspace's owner and admins, as the change's transaction read
 * them, that a pending request is no longer pending.
 */
function sendResolved(
  request: FastifyRequest,
  options: JoinRequestRouteOptions,
  resolved: Readonly<{
    workspaceId: WorkspaceId;
    joinRequestId: JoinRequestId;
    outcome: JoinRequestOutcome;
    now: Date;
    approvers: readonly MemberId[];
  }>,
): void {
  sendApproverEvent(
    request,
    options.onApproverEvent,
    {
      ...serverEventHeader(resolved.workspaceId, resolved.now),
      type: "workspace.join_request.resolved",
      payload: {
        joinRequestId: resolved.joinRequestId,
        outcome: resolved.outcome,
      },
    },
    resolved.approvers,
  );
}

/**
 * What a join request change hands to `changeThenReadApprovers`: its result,
 * and the workspace whose owner and admins its event goes to, or null when
 * it sends no join request event.
 */
type JoinRequestChange<T> = Readonly<{
  result: T;
  announceIn: WorkspaceId | null;
}>;

/**
 * Runs a join request change in one transaction (#210): it checks the
 * account and the device again first (`lockActor`), then runs `change`, and
 * reads the owner and admins of `announceIn` last (`joinRequestApprovers`),
 * after every lock that the change took, so that a demotion or a removal
 * that committed while the change waited for a lock leaves the person out.
 * A refused decision or withdrawal throws inside `change`, so the
 * transaction rolls back and nothing is read or sent; a refused new request
 * writes nothing and returns `announceIn: null`, so nothing is read or sent
 * either, and its route throws after the commit. Every route that sends a
 * join request event runs its change through it, so that they share one
 * order.
 */
async function changeThenReadApprovers<T>(
  database: Database,
  request: FastifyRequest,
  now: Date,
  change: (tx: Database) => Promise<JoinRequestChange<T>>,
): Promise<Readonly<{ result: T; approvers: readonly MemberId[] }>> {
  const auth = authOf(request);
  return database.transaction(async (tx) => {
    await lockActor(tx, auth, now.getTime());
    const { result, announceIn } = await change(tx);
    const approvers =
      announceIn === null ? [] : await joinRequestApprovers(tx, announceIn);
    return { result, approvers };
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
 * again (`lockActor`) first, and that reads the workspace's owner and
 * admins last, after the change (`changeThenReadApprovers`). After the
 * commit, a new request goes to them as `workspace.join_request.created`,
 * and a withdrawal as `workspace.join_request.resolved`, through
 * `onApproverEvent`. A pending request returned again sends nothing.
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
      const { result, approvers } = await changeThenReadApprovers(
        database,
        request,
        now,
        async (tx) => {
          const asked = await createJoinRequest(tx, {
            workspaceId,
            userId: auth.userId,
            deviceId: auth.deviceId,
            displayName,
            now,
          });
          // The new request as the approvers' list shows it. The list leaves
          // out a request whose requester's identity was erased, and so does
          // the event; a request just made has one.
          let announced: JoinRequest | null = null;
          if (asked.requested && asked.created) {
            const shown = await joinRequestForApprovers(tx, {
              workspaceId,
              joinRequestId: asked.joinRequest.id,
            });
            if (shown !== undefined && shown.requester !== null) {
              announced = shown;
            }
          }
          return {
            result: { asked, announced },
            announceIn: announced === null ? null : workspaceId,
          };
        },
      );
      const { asked, announced } = result;
      if (announced !== null) {
        sendApproverEvent(
          request,
          options.onApproverEvent,
          {
            ...serverEventHeader(workspaceId, now),
            type: "workspace.join_request.created",
            payload: { joinRequest: announced },
          },
          approvers,
        );
      }
      if (asked.requested) {
        return { joinRequest: asked.joinRequest };
      }
      throw asked.refusal === "rate_limited"
        ? new ApiError("rate_limited", {
            retryAfterSeconds: asked.retryAfterMs / 1000,
          })
        : new ApiError(asked.refusal);
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
      const withdrawn = await changeThenReadApprovers(
        database,
        request,
        now,
        async (tx) => {
          const result = await withdrawJoinRequest(tx, {
            joinRequestId,
            userId: auth.userId,
            deviceId: auth.deviceId,
            now,
          });
          if (!result.withdrawn) {
            throw new ApiError(result.refusal);
          }
          return { result: result.workspaceId, announceIn: result.workspaceId };
        },
      );
      sendResolved(request, options, {
        workspaceId: withdrawn.result,
        joinRequestId,
        outcome: "withdrawn",
        now,
        approvers: withdrawn.approvers,
      });
      return reply.code(204).send();
    },
  );
}

/**
 * The approvers' join request routes (ADR 0014, "Join requests"): listing,
 * approving, denying, blocking and unblocking, denying all, and pausing and
 * resuming. Registered on a scope that `requireActiveMember` protects. The
 * owner and admins only; a member gets `403` with `forbidden`. A change runs
 * in one transaction that checks the account and the device again
 * (`lockActor`), then locks the caller's own person, then the request, the
 * pending requests in the order of their IDs, or the workspace row; a
 * decision then reads the workspace's owner and admins
 * (`changeThenReadApprovers`). After the commit, an approval sends
 * `workspace.member.claimed` with the new person through
 * `onWorkspaceEvent`; every decision sends
 * `workspace.join_request.resolved` to the owner and admins through
 * `onApproverEvent`, and `account.join_request_decided` to the requester's
 * open connections through `onAccountFrame`, in this order. A block is
 * `blocked` in the event and `denied` in the frame, and denying all sends
 * one event and one frame per denied request. Unblocking, pausing, and
 * resuming send nothing.
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
      const { result: approved, approvers } = await changeThenReadApprovers(
        database,
        request,
        now,
        async (tx) => {
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
          return { result, announceIn: workspaceId };
        },
      );
      sendWorkspaceEvent(request, options.onWorkspaceEvent, {
        ...serverEventHeader(workspaceId, now),
        type: "workspace.member.claimed",
        payload: { member: approved.member },
      });
      sendResolved(request, options, {
        workspaceId,
        joinRequestId,
        outcome: "approved",
        now,
        approvers,
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
      const denied = await changeThenReadApprovers(
        database,
        request,
        now,
        async (tx) => {
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
          return { result: result.requesterUserId, announceIn: workspaceId };
        },
      );
      sendResolved(request, options, {
        workspaceId,
        joinRequestId,
        outcome: "denied",
        now,
        approvers: denied.approvers,
      });
      sendDecision(request, options, denied.result, {
        joinRequestId,
        workspaceId,
        decision: "denied",
        decidedAt: now.toISOString(),
      });
      return reply.code(204).send();
    },
  );

  workspace.post(
    MEMBERSHIP_ROUTES.blockJoinRequest.path,
    { schema: { params: JoinRequestParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId, joinRequestId } =
        request.params as JoinRequestParams;
      const now = new Date(options.now());
      const blocked = await changeThenReadApprovers(
        database,
        request,
        now,
        async (tx) => {
          const result = await blockJoinRequest(tx, {
            workspaceId,
            joinRequestId,
            userId: auth.userId,
            deviceId: auth.deviceId,
            now,
          });
          if (!result.blocked) {
            throw refused(result.refusal);
          }
          return { result: result.requesterUserId, announceIn: workspaceId };
        },
      );
      // The owner and admins see the block; the requester sees a denial.
      sendResolved(request, options, {
        workspaceId,
        joinRequestId,
        outcome: "blocked",
        now,
        approvers: blocked.approvers,
      });
      sendDecision(request, options, blocked.result, {
        joinRequestId,
        workspaceId,
        decision: "denied",
        decidedAt: now.toISOString(),
      });
      return reply.code(204).send();
    },
  );

  workspace.post(
    MEMBERSHIP_ROUTES.unblockJoinRequest.path,
    { schema: { params: JoinRequestParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId, joinRequestId } =
        request.params as JoinRequestParams;
      const now = new Date(options.now());
      await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await unblockJoinRequest(tx, {
          workspaceId,
          joinRequestId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          now,
        });
        if (!result.unblocked) {
          throw refused(result.refusal);
        }
      });
      return reply.code(204).send();
    },
  );

  workspace.post(
    MEMBERSHIP_ROUTES.denyAllJoinRequests.path,
    { schema: { params: WorkspaceParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const now = new Date(options.now());
      const denied = await changeThenReadApprovers(
        database,
        request,
        now,
        async (tx) => {
          const result = await denyAllJoinRequests(tx, {
            workspaceId,
            userId: auth.userId,
            deviceId: auth.deviceId,
            now,
          });
          if (!result.denied) {
            throw refused(result.refusal);
          }
          return {
            result: result.joinRequests,
            announceIn: result.joinRequests.length === 0 ? null : workspaceId,
          };
        },
      );
      for (const { joinRequestId, requesterUserId } of denied.result) {
        sendResolved(request, options, {
          workspaceId,
          joinRequestId,
          outcome: "denied",
          now,
          approvers: denied.approvers,
        });
        sendDecision(request, options, requesterUserId, {
          joinRequestId,
          workspaceId,
          decision: "denied",
          decidedAt: now.toISOString(),
        });
      }
      return reply.code(204).send();
    },
  );

  workspace.post(
    MEMBERSHIP_ROUTES.pauseJoinRequests.path,
    { schema: { params: WorkspaceParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const now = new Date(options.now());
      await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await pauseJoinRequests(tx, {
          workspaceId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          now,
        });
        if (!result.paused) {
          throw refused(result.refusal);
        }
      });
      return reply.code(204).send();
    },
  );

  workspace.post(
    MEMBERSHIP_ROUTES.resumeJoinRequests.path,
    { schema: { params: WorkspaceParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const now = new Date(options.now());
      await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await resumeJoinRequests(tx, {
          workspaceId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          now,
        });
        if (!result.resumed) {
          throw refused(result.refusal);
        }
      });
      return reply.code(204).send();
    },
  );
}
