import {
  type Database,
  defineMember,
  leaveWorkspace,
  type MembershipEnd,
  type PersonRefusal,
  removeMember,
  renameMember,
} from "@mymandev/database";
import {
  type AccountRemovedFromWorkspaceFrame,
  type DefineMemberRequest,
  DefineMemberRequestSchema,
  type DefineMemberResponse,
  type MemberId,
  MemberIdSchema,
  MEMBERSHIP_ROUTES,
  PROTOCOL_VERSION,
  type RenameMemberRequest,
  RenameMemberRequestSchema,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authOf, lockActor } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import type { ConnectionRegistry } from "../gateway.ts";
import { WorkspaceParamsSchema } from "./access.ts";
import {
  type AccountFrameHandler,
  sendAccountFrame,
  sendCancelledRuns,
  sendWorkspaceEvent,
  serverEventHeader,
  type WorkspaceEvent,
  type WorkspaceEventHandler,
} from "./events.ts";

export type PeopleRouteOptions = Readonly<{
  database: Database;
  now: () => number;
  onWorkspaceEvent: WorkspaceEventHandler;
  /** Receives `account.removed_from_workspace` after a removal or a departure. */
  onAccountFrame: AccountFrameHandler;
  /** The open connections, to which the runs that a removal cancelled go. */
  connections: ConnectionRegistry;
}>;

/** The path parameters of a route under `/workspaces/:workspaceId/members/:memberId`. */
const MemberParamsSchema = WorkspaceParamsSchema.extend({
  memberId: MemberIdSchema,
});

type MemberParams = Readonly<{ workspaceId: WorkspaceId; memberId: MemberId }>;

/**
 * The answer to a refused action on a person. An account that stopped being
 * an active member after the membership check gets the check's `404`.
 */
function refused(refusal: PersonRefusal): ApiError {
  return new ApiError(refusal === "not_member" ? "not_found" : refusal);
}

/**
 * Defining, renaming, and removing people, and leaving (ADR 0014, "People and
 * roles" and "Removal and ownership"). Registered on a scope that
 * `requireActiveMember` protects. Each change runs in one transaction that
 * checks the account and the device again (`lockActor`) and then decides on
 * the locked people; a frozen copy of its membership event goes to
 * `onWorkspaceEvent` after the commit.
 */
export function registerPeopleRoutes(
  workspace: FastifyInstance,
  options: PeopleRouteOptions,
): void {
  const { database, connections } = options;

  function send(request: FastifyRequest, event: WorkspaceEvent): void {
    sendWorkspaceEvent(request, options.onWorkspaceEvent, event);
  }

  /**
   * Tells the open connections that a person was removed or left, after the
   * commit and in this order: `workspace.member.removed` through
   * `onWorkspaceEvent`, whose delivery first ends the person's subscriptions
   * to the workspace with `membership_ended` and sends the person's
   * `offline` to the other subscribers; `account.removed_from_workspace`
   * through `onAccountFrame` to every connection of the person's account;
   * and each cancelled run as `agent.run.state_changed` to the workspace's
   * remaining subscribers. `buildApp` connects both handlers to the
   * registry, which sends at once, so the order holds.
   */
  function sendMembershipEnd(
    request: FastifyRequest,
    workspaceId: WorkspaceId,
    ended: MembershipEnd,
    now: Date,
  ): void {
    send(request, {
      ...serverEventHeader(workspaceId, now),
      type: "workspace.member.removed",
      payload: { memberId: ended.memberId, removedAt: now.toISOString() },
    });
    if (ended.userId !== null) {
      const frame: AccountRemovedFromWorkspaceFrame = {
        protocolVersion: PROTOCOL_VERSION,
        type: "account.removed_from_workspace",
        workspaceId,
        removedAt: now.toISOString(),
      };
      sendAccountFrame(request, options.onAccountFrame, ended.userId, frame);
    }
    sendCancelledRuns(connections, ended.cancelledRuns, now);
  }

  // A `role` in the body is stripped by the protocol schema: an unclaimed
  // person is always a `member`.
  workspace.post(
    MEMBERSHIP_ROUTES.defineMember.path,
    {
      schema: {
        params: WorkspaceParamsSchema,
        body: DefineMemberRequestSchema,
      },
    },
    async (request): Promise<DefineMemberResponse> => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const { displayName } = request.body as DefineMemberRequest;
      const now = new Date(options.now());
      const member = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await defineMember(tx, {
          workspaceId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          displayName,
          now,
        });
        if (!result.defined) {
          throw refused(result.refusal);
        }
        return result.member;
      });
      send(request, {
        ...serverEventHeader(workspaceId, now),
        type: "workspace.member.defined",
        payload: { member },
      });
      return { member };
    },
  );

  workspace.post(
    MEMBERSHIP_ROUTES.renameMember.path,
    {
      schema: {
        params: MemberParamsSchema,
        body: RenameMemberRequestSchema,
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId, memberId } = request.params as MemberParams;
      const { displayName } = request.body as RenameMemberRequest;
      const now = new Date(options.now());
      await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await renameMember(tx, {
          workspaceId,
          memberId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          displayName,
          now,
        });
        if (!result.renamed) {
          throw refused(result.refusal);
        }
      });
      send(request, {
        ...serverEventHeader(workspaceId, now),
        type: "workspace.member.renamed",
        payload: { memberId, displayName },
      });
      return reply.code(204).send();
    },
  );

  workspace.post(
    MEMBERSHIP_ROUTES.removeMember.path,
    { schema: { params: MemberParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId, memberId } = request.params as MemberParams;
      const now = new Date(options.now());
      const ended = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await removeMember(tx, {
          workspaceId,
          memberId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          now,
        });
        if (!result.removed) {
          throw refused(result.refusal);
        }
        return result;
      });
      sendMembershipEnd(request, workspaceId, ended, now);
      return reply.code(204).send();
    },
  );

  // The owner cannot leave: the protocol answers `forbidden`, and ownership
  // moves only by transfer.
  workspace.post(
    MEMBERSHIP_ROUTES.leaveWorkspace.path,
    { schema: { params: WorkspaceParamsSchema } },
    async (request, reply) => {
      const auth = authOf(request);
      const { workspaceId } = request.params as { workspaceId: WorkspaceId };
      const now = new Date(options.now());
      const ended = await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        const result = await leaveWorkspace(tx, {
          workspaceId,
          userId: auth.userId,
          deviceId: auth.deviceId,
          now,
        });
        if (!result.left) {
          throw refused(result.refusal);
        }
        return result;
      });
      sendMembershipEnd(request, workspaceId, ended, now);
      return reply.code(204).send();
    },
  );
}
