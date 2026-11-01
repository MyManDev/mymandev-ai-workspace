import {
  type Database,
  defineMember,
  type PersonRefusal,
  removeMember,
  renameMember,
} from "@mymandev/database";
import {
  type DefineMemberRequest,
  DefineMemberRequestSchema,
  type DefineMemberResponse,
  type MemberId,
  MemberIdSchema,
  MEMBERSHIP_ROUTES,
  type RenameMemberRequest,
  RenameMemberRequestSchema,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authOf, lockActor } from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import { WorkspaceParamsSchema } from "./access.ts";
import {
  frozenCopy,
  serverEventHeader,
  type WorkspaceEvent,
  type WorkspaceEventHandler,
} from "./events.ts";

export type PeopleRouteOptions = Readonly<{
  database: Database;
  now: () => number;
  onWorkspaceEvent: WorkspaceEventHandler;
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
 * Defining, renaming, and removing people (ADR 0014, "People and roles" and
 * "Removal and ownership"). Registered on a scope that `requireActiveMember`
 * protects. Each change runs in one transaction that checks the account and
 * the device again (`lockActor`) and then decides on the locked people; a
 * frozen copy of its membership event goes to `onWorkspaceEvent` after the
 * commit.
 */
export function registerPeopleRoutes(
  workspace: FastifyInstance,
  options: PeopleRouteOptions,
): void {
  const { database } = options;

  /**
   * Hands a frozen copy of a membership event to `onWorkspaceEvent` without
   * waiting for it: the change is already committed, so a handler that never
   * returns cannot hold the answer, and a failure is only logged. The log
   * names the error's type and never its message, which may quote a display
   * name.
   */
  function send(request: FastifyRequest, event: WorkspaceEvent): void {
    const copy = frozenCopy(event);
    const failed = (error: unknown) => {
      request.log.error(
        {
          eventType: copy.type,
          workspaceId: copy.workspaceId,
          errorType: error instanceof Error ? error.name : typeof error,
        },
        "workspace event failed",
      );
    };
    try {
      Promise.resolve(options.onWorkspaceEvent(copy)).catch(failed);
    } catch (error) {
      failed(error);
    }
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
      await database.transaction(async (tx) => {
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
      });
      send(request, {
        ...serverEventHeader(workspaceId, now),
        type: "workspace.member.removed",
        payload: { memberId, removedAt: now.toISOString() },
      });
      return reply.code(204).send();
    },
  );
}
