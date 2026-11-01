import {
  createWorkspace,
  type Database,
  listWorkspaces,
  workspaceView,
} from "@mymandev/database";
import {
  type CreateWorkspaceRequest,
  CreateWorkspaceRequestSchema,
  type CreateWorkspaceResponse,
  MEMBERSHIP_ROUTES,
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
import { zodValidatorCompiler } from "../validation.ts";
import { requireActiveMember, WorkspaceParamsSchema } from "./access.ts";
import type { WorkspaceEventHandler } from "./events.ts";
import { registerInvitationRoutes } from "./invitation-routes.ts";
import { registerPeopleRoutes } from "./people-routes.ts";

export type WorkspaceRouteOptions = Readonly<{
  database: Database;
  requireAccessToken: RequireAccessToken;
  now: () => number;
  /** Receives the membership events of the people routes after the commit. */
  onWorkspaceEvent: WorkspaceEventHandler;
}>;

/**
 * Workspaces and the people in them (ADR 0014, "People and roles" and "What
 * a workspace ID allows"): the account's workspaces, creating one, the view
 * of one, its people, and their invitations.
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
        const { name, displayName } = request.body as CreateWorkspaceRequest;
        const now = new Date(options.now());
        const result = await database.transaction(async (tx) => {
          await lockActor(tx, auth, now.getTime());
          return createWorkspace(tx, {
            userId: auth.userId,
            deviceId: auth.deviceId,
            name,
            displayName,
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

      registerPeopleRoutes(workspace, {
        database,
        now: options.now,
        onWorkspaceEvent: options.onWorkspaceEvent,
      });

      registerInvitationRoutes(workspace, { database, now: options.now });
    });
  });
}
