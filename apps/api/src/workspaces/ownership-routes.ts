import {
  acceptOwnershipOffer,
  type Database,
  type EndedOwnershipOffer,
  offerOwnership,
  type PersonRefusal,
  withdrawOwnershipOffer,
} from "@mymandev/database";
import {
  type AccountOwnershipOfferedFrame,
  type AccountOwnershipOfferEndedFrame,
  type AccountOwnershipTransferredFrame,
  MEMBERSHIP_ROUTES,
  type OfferOwnershipRequest,
  OfferOwnershipRequestSchema,
  PROTOCOL_VERSION,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
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

export type OwnershipRouteOptions = Readonly<{
  database: Database;
  now: () => number;
  onWorkspaceEvent: WorkspaceEventHandler;
  /**
   * Receives `account.ownership_offered` and `account.ownership_offer_ended`
   * for the target's account and then for the owner's account, and
   * `account.ownership_transferred` for the previous and the new owner's
   * accounts, after the commit.
   */
  onAccountFrame: AccountFrameHandler;
}>;

/**
 * The answer to a refused ownership action. An account that stopped being an
 * active member after the membership check gets the check's `404`.
 */
function refused(refusal: PersonRefusal | "device_too_new"): ApiError {
  return new ApiError(refusal === "not_member" ? "not_found" : refusal);
}

/**
 * Offering the ownership of a workspace, accepting the offer, and
 * withdrawing it (ADR 0014, "People and roles" and "Removal and
 * ownership"). Registered on a scope that `requireActiveMember` protects.
 * Each runs in one transaction that checks the account and the device again
 * (`lockActor`) and then decides on the locked people. After the commit, the
 * target's account gets `account.ownership_offered` or
 * `account.ownership_offer_ended` through `onAccountFrame`, and then the
 * owner's account gets the same frame (#241), so that every device of both
 * people reads the offer again. No workspace event reports an offer, so no
 * other member learns of it. A transfer reaches the workspace's subscribers
 * as `workspace.ownership.transferred` through `onWorkspaceEvent`, and then
 * every connection of the previous owner's account and of the new owner's
 * account as `account.ownership_transferred` through `onAccountFrame`, in
 * this order. `buildApp` connects both handlers to the registry, which sends
 * at once, so the order holds.
 */
export function registerOwnershipRoutes(
  workspace: FastifyInstance,
  options: OwnershipRouteOptions,
): void {
  const { database } = options;

  /**
   * Hands an offer frame for every connection of the target's account and
   * then of the owner's account (#241). They are two accounts: a person of
   * the workspace belongs to one account, and the target is never the owner.
   */
  function sendOfferFrame(
    request: FastifyRequest,
    frame: AccountOwnershipOfferedFrame | AccountOwnershipOfferEndedFrame,
    targetUserId: UserId,
    ownerUserId: UserId,
  ): void {
    for (const userId of [targetUserId, ownerUserId]) {
      sendAccountFrame(request, options.onAccountFrame, userId, frame);
    }
  }

  /** Tells the target's and the owner's accounts that the offer ended. */
  function sendOfferEnded(
    request: FastifyRequest,
    workspaceId: WorkspaceId,
    ended: EndedOwnershipOffer | null,
  ): void {
    if (ended === null) {
      return;
    }
    const frame: AccountOwnershipOfferEndedFrame = {
      protocolVersion: PROTOCOL_VERSION,
      type: "account.ownership_offer_ended",
      workspaceId,
      reason: ended.reason,
      endedAt: ended.endedAt.toISOString(),
    };
    sendOfferFrame(request, frame, ended.userId, ended.ownerUserId);
  }

  // Only the owner offers, from a device older than 72 hours, so the caller
  // is the owner. An expired offer that the new one replaces ends with
  // `expired` before the new one reaches its target and the owner.
  workspace.post(
    MEMBERSHIP_ROUTES.offerOwnership.path,
    {
      schema: {
        params: WorkspaceParamsSchema,
        body: OfferOwnershipRequestSchema,
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const { memberId } = request.body as OfferOwnershipRequest;
      const now = new Date(options.now());
      const result = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await offerOwnership(tx, {
          workspaceId,
          memberId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          now,
        });
        if (!result.offered) {
          throw refused(result.refusal);
        }
        return result;
      });
      sendOfferEnded(request, workspaceId, result.ended);
      const frame: AccountOwnershipOfferedFrame = {
        protocolVersion: PROTOCOL_VERSION,
        type: "account.ownership_offered",
        workspaceId,
        offer: result.offer,
      };
      sendOfferFrame(request, frame, result.userId, auth.userId);
      return reply.code(204).send();
    },
  );

  // A refusal that cleared an expired offer commits it, so the transaction
  // returns the refusal and the route answers it after the commit. An
  // acceptance sends no offer frame: `account.ownership_transferred` tells
  // both accounts that the offer is gone.
  workspace.post(
    MEMBERSHIP_ROUTES.acceptOwnershipOffer.path,
    { schema: { params: WorkspaceParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const now = new Date(options.now());
      const result = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        return acceptOwnershipOffer(tx, {
          workspaceId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          now,
        });
      });
      if (!result.accepted) {
        sendOfferEnded(request, workspaceId, result.ended);
        throw refused(result.refusal);
      }
      sendWorkspaceEvent(request, options.onWorkspaceEvent, {
        ...serverEventHeader(workspaceId, now),
        type: "workspace.ownership.transferred",
        payload: {
          previousOwnerMemberId: result.previousOwnerMemberId,
          ownerMemberId: result.ownerMemberId,
        },
      });
      const frame: AccountOwnershipTransferredFrame = {
        protocolVersion: PROTOCOL_VERSION,
        type: "account.ownership_transferred",
        workspaceId,
        previousOwnerMemberId: result.previousOwnerMemberId,
        ownerMemberId: result.ownerMemberId,
        transferredAt: now.toISOString(),
      };
      // Two accounts: a person of the workspace belongs to one account, and
      // the target is never the owner.
      for (const userId of [result.previousOwnerUserId, auth.userId]) {
        sendAccountFrame(request, options.onAccountFrame, userId, frame);
      }
      return reply.code(204).send();
    },
  );

  workspace.post(
    MEMBERSHIP_ROUTES.withdrawOwnershipOffer.path,
    { schema: { params: WorkspaceParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const now = new Date(options.now());
      const result = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        return withdrawOwnershipOffer(tx, {
          workspaceId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          now,
        });
      });
      sendOfferEnded(request, workspaceId, result.ended);
      if (!result.withdrawn) {
        throw refused(result.refusal);
      }
      return reply.code(204).send();
    },
  );
}
