import {
  createWorkspace,
  type Database,
  listWorkspaces,
  setUnclaimedMemberLimit,
  workspaceView,
} from "@mymandev/database";
import {
  type CreateWorkspaceRequest,
  CreateWorkspaceRequestSchema,
  type CreateWorkspaceResponse,
  MEMBERSHIP_ROUTES,
  type SetUnclaimedMemberLimitRequest,
  SetUnclaimedMemberLimitRequestSchema,
  type WorkspaceId,
  type WorkspaceListResponse,
  type WorkspaceViewResponse,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import {
  authOf,
  lockActor,
  type RequireAccessToken,
} from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import type { ConnectionRegistry } from "../gateway.ts";
import { zodValidatorCompiler } from "../validation.ts";
import {
  requireActiveMember,
  requireProjectMember,
  WorkspaceParamsSchema,
} from "./access.ts";
import { registerChatRoutes } from "./chat-routes.ts";
import type { AccountFrameHandler, WorkspaceEventHandler } from "./events.ts";
import { registerInvitationCodeRoutes } from "./invitation-code-routes.ts";
import { registerInvitationRoutes } from "./invitation-routes.ts";
import {
  registerJoinRequestRoutes,
  registerOwnJoinRequestRoutes,
} from "./join-request-routes.ts";
import { registerOwnershipRoutes } from "./ownership-routes.ts";
import { registerPeopleRoutes } from "./people-routes.ts";
import { registerProjectRoutes } from "./project-routes.ts";

export type WorkspaceRouteOptions = Readonly<{
  database: Database;
  requireAccessToken: RequireAccessToken;
  now: () => number;
  /**
   * Receives the membership events of the people routes, of accepting an
   * ownership offer, of accepting an invitation, and of approving a join
   * request, and the project events of the project routes, after the commit.
   */
  onWorkspaceEvent: WorkspaceEventHandler;
  /**
   * Receives the account frames after the commit, for the account's open
   * connections: a join request decision for the requester,
   * `account.removed_from_workspace` after a removal or a departure,
   * `account.ownership_offered` and `account.ownership_offer_ended` for the
   * target of an ownership offer, and `account.ownership_transferred` for
   * the previous and the new owner after a transfer.
   */
  onAccountFrame: AccountFrameHandler;
  /**
   * The open connections, to which the people routes send the runs that a
   * removal or a departure cancelled, after the commit.
   */
  connections: ConnectionRegistry;
}>;

/**
 * Workspaces and the people in them (ADR 0014, "People and roles", "Join
 * requests", and "What a workspace ID allows"): the account's workspaces,
 * creating one, the view of one, its limit of unclaimed people, its people,
 * their invitations, its join requests, and its projects (#155); previewing
 * and accepting an invitation code; the account's own join requests; and
 * the routes under `/projects/:projectId`, such as a project's chat history
 * (#27).
 */
export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  options: WorkspaceRouteOptions,
): Promise<void> {
  const { database } = options;

  await app.register(async (scope) => {
    scope.setValidatorCompiler(zodValidatorCompiler);
    options.requireAccessToken(scope);

    scope.get(
      MEMBERSHIP_ROUTES.listWorkspaces.path,
      async (request): Promise<WorkspaceListResponse> => {
        const auth = authOf(request);
        return { workspaces: await listWorkspaces(database, auth.userId) };
      },
    );

    // Creating a workspace sends no workspace event: the protocol has none
    // for it, and the creator is its only member.
    scope.post(
      MEMBERSHIP_ROUTES.createWorkspace.path,
      { schema: { body: CreateWorkspaceRequestSchema } },
      async (request): Promise<CreateWorkspaceResponse> => {
        const auth = authOf(request);
        const { name, displayName, maxUnclaimedMembers } =
          request.body as CreateWorkspaceRequest;
        const now = new Date(options.now());
        const result = await database.transaction(async (tx) => {
          await lockActor(tx, auth, now.getTime());
          return createWorkspace(tx, {
            userId: auth.userId,
            deviceId: auth.deviceId,
            name,
            displayName,
            maxUnclaimedMembers,
            now,
          });
        });
        if (!result.created) {
          throw new ApiError("rate_limited", {
            retryAfterSeconds: result.retryAfterMs / 1000,
          });
        }
        return result.membership;
      },
    );

    // The code travels only in the body, so these routes are not under
    // `/workspaces/:workspaceId` and need no membership.
    registerInvitationCodeRoutes(scope, {
      database,
      now: options.now,
      onWorkspaceEvent: options.onWorkspaceEvent,
    });

    // A join request is the only action that a workspace ID allows a
    // non-member, so these routes are not under `/workspaces/:workspaceId`.
    const joinRequests = {
      database,
      now: options.now,
      onWorkspaceEvent: options.onWorkspaceEvent,
      onAccountFrame: options.onAccountFrame,
    };
    registerOwnJoinRequestRoutes(scope, joinRequests);

    await scope.register(async (workspace) => {
      requireActiveMember(workspace, database);

      workspace.get(
        MEMBERSHIP_ROUTES.getWorkspace.path,
        { schema: { params: WorkspaceParamsSchema } },
        async (request): Promise<WorkspaceViewResponse> => {
          const { workspaceId } = request.params as {
            workspaceId: WorkspaceId;
          };
          const view = await workspaceView(database, {
            workspaceId,
            now: new Date(options.now()),
          });
          // Workspaces are never deleted, so a member's workspace exists.
          if (view === undefined) {
            throw new ApiError("not_found");
          }
          return view;
        },
      );

      // Only the owner changes the limit of unclaimed people, never below
      // their number. No workspace event reports it, because the protocol has
      // none; the members read it from the workspace view.
      workspace.post(
        MEMBERSHIP_ROUTES.setUnclaimedMemberLimit.path,
        {
          schema: {
            params: WorkspaceParamsSchema,
            body: SetUnclaimedMemberLimitRequestSchema,
          },
        },
        async (request, reply) => {
          const auth = authOf(request);
          const { workspaceId } = request.params as {
            workspaceId: WorkspaceId;
          };
          const { maxUnclaimedMembers } =
            request.body as SetUnclaimedMemberLimitRequest;
          const now = new Date(options.now());
          await database.transaction(async (tx) => {
            await lockActor(tx, auth, now.getTime());
            const result = await setUnclaimedMemberLimit(tx, {
              workspaceId,
              userId: auth.userId,
              deviceId: auth.deviceId,
              maxUnclaimedMembers,
              now,
            });
            if (!result.set) {
              // An account that stopped being an active member after the
              // membership check gets the check's 404.
              throw new ApiError(
                result.refusal === "not_member" ? "not_found" : result.refusal,
              );
            }
          });
          return reply.code(204).send();
        },
      );

      registerPeopleRoutes(workspace, {
        database,
        now: options.now,
        onWorkspaceEvent: options.onWorkspaceEvent,
        onAccountFrame: options.onAccountFrame,
        connections: options.connections,
      });

      registerOwnershipRoutes(workspace, {
        database,
        now: options.now,
        onWorkspaceEvent: options.onWorkspaceEvent,
        onAccountFrame: options.onAccountFrame,
      });

      registerInvitationRoutes(workspace, { database, now: options.now });

      registerJoinRequestRoutes(workspace, joinRequests);

      registerProjectRoutes(workspace, {
        database,
        now: options.now,
        onWorkspaceEvent: options.onWorkspaceEvent,
      });
    });

    // A project ID names its workspace, so these routes check the
    // membership of the project's workspace (#27, #28).
    await scope.register(async (project) => {
      requireProjectMember(project, database);

      registerChatRoutes(project, { database });
    });
  });
}
