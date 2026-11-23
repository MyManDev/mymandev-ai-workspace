import {
  type Database,
  grantCapability,
  type GrantCapabilityResult,
  listGrantRecords,
  revokeGrant,
  type RevokeGrantResult,
} from "@mymandev/database";
import {
  type AgentId,
  AgentIdSchema,
  type GrantCapabilityRequest,
  GrantCapabilityRequestSchema,
  type GrantCapabilityResponse,
  type GrantRecordListResponse,
  GRANT_ROUTES,
  type PermissionGrantId,
  PermissionGrantIdSchema,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import * as z from "zod";
import {
  authOf,
  lockActor,
  type RequireAccessToken,
} from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import type { ConnectionRegistry } from "../gateway.ts";
import { zodValidatorCompiler } from "../validation.ts";
import {
  grantCreatedEvent,
  grantRevokedEvent,
  sendGrantEvents,
} from "../workspaces/events.ts";

export type GrantRouteOptions = Readonly<{
  database: Database;
  requireAccessToken: RequireAccessToken;
  now: () => number;
  /**
   * The open connections, to which `agent.grant.created` and
   * `agent.grant.revoked` go after the commit.
   */
  connections: ConnectionRegistry;
}>;

/** The path parameter of a grant. */
const AgentParamsSchema = z.object({ agentId: AgentIdSchema });

/** The path parameters of a revocation. */
const GrantParamsSchema = AgentParamsSchema.extend({
  grantId: PermissionGrantIdSchema,
});

/**
 * The answer to a refused grant. Each refusal of the database has its own
 * case: one that it adds fails the type check here. `forbidden` is the
 * database's refusal of an account that is not the agent's owner, of a
 * calling device that is not the agent's host device, and of a disabled
 * account, which `lockActor` already refuses with `unauthorized` before the
 * database is asked. A count limit answers `409` with `grant_limit` and no
 * `Retry-After`, because no time frees a place, only a revocation does
 * (#75, decision of 2026-11-14). The account's 200 grants in 24 hours
 * answer `429` with `rate_limited` and the time until the oldest of them
 * leaves the window as `Retry-After` (#75, decision of 2026-11-23).
 */
function refusedGrant(
  result: Extract<GrantCapabilityResult, { granted: false }>,
): ApiError {
  switch (result.refusal) {
    case "not_found":
    case "forbidden":
    case "conflict":
    case "grant_limit":
      return new ApiError(result.refusal);
    case "rate_limited":
      return new ApiError("rate_limited", {
        retryAfterSeconds: result.retryAfterMs / 1000,
      });
    default:
      return result satisfies never;
  }
}

/** The answer to a refused revocation, as for a grant. */
function refusedRevocation(
  result: Extract<RevokeGrantResult, { revoked: false }>,
): ApiError {
  switch (result.refusal) {
    case "not_found":
    case "forbidden":
    case "conflict":
      return new ApiError(result.refusal);
    default:
      return result.refusal satisfies never;
  }
}

/**
 * The grant routes (#75; ADR 0015, P-74 to P-80; Project Manager decisions
 * of 2026-11-02, 2026-11-14, and 2026-11-19): granting a capability to an
 * agent, revoking a grant, and the grant records of the agents that the
 * calling device hosts. Every route needs an access token, and the account
 * limit of every authenticated route applies; beyond it, the count limits of
 * `GRANT_COUNT_LIMITS`, which the database applies, bound the grants: an
 * agent's and a host device's grants that are not revoked (`grant_limit`),
 * and an account's grants in 24 hours (`rate_limited`).
 *
 * No path names a workspace or a project: an agent ID names both, and the
 * database decides on the agent. An agent that does not exist and an agent
 * of a workspace that the account is not an active member of both answer
 * `404` with `not_found`, so that a route never tells them apart. Only the
 * agent's owner grants, only from the agent's host device; the owner
 * revokes from any of its devices.
 *
 * Each change runs in one transaction that checks the account and the
 * device again (`lockActor`), so a device that was revoked after the request
 * was authenticated changes nothing. After the commit, its events go to
 * every connection subscribed to the agent's workspace, with a `system`
 * actor and `deviceId: null`: a grant that replaced an expired grant sends
 * `agent.grant.revoked` for the expired one first, then
 * `agent.grant.created`. A refused or rolled-back change sends nothing.
 * Neither change writes an audit record.
 */
export async function registerGrantRoutes(
  app: FastifyInstance,
  options: GrantRouteOptions,
): Promise<void> {
  const { database, connections } = options;

  await app.register(async (scope) => {
    scope.setValidatorCompiler(zodValidatorCompiler);
    options.requireAccessToken(scope);

    // One statement, so one snapshot (P-76). Revoked grants are left out
    // (#75, decision of 2026-11-14); expired ones stay until revoked.
    scope.get(
      GRANT_ROUTES.listGrantRecords.path,
      async (request): Promise<GrantRecordListResponse> => {
        const auth = authOf(request);
        const records = await listGrantRecords(database, {
          userId: auth.userId,
          deviceId: auth.deviceId,
        });
        return { records };
      },
    );

    // The body is the parsed JSON body itself, validated by the request
    // schema (#290, review): Fastify's JSON parser refuses `__proto__` and
    // `constructor.prototype` keys, so no inherited `lifetimeSeconds` counts,
    // and unknown fields are stripped, so a client sets neither the grant's
    // ID, its agent, its granting account, nor its times.
    scope.post(
      GRANT_ROUTES.grantCapability.path,
      {
        schema: {
          params: AgentParamsSchema,
          body: GrantCapabilityRequestSchema,
        },
      },
      async (request): Promise<GrantCapabilityResponse> => {
        const auth = authOf(request);
        const { agentId } = request.params as { agentId: AgentId };
        const grant = request.body as GrantCapabilityRequest;
        const now = new Date(options.now());
        const granted = await database.transaction(async (tx) => {
          await lockActor(tx, auth, now.getTime());
          const result = await grantCapability(tx, {
            agentId,
            userId: auth.userId,
            deviceId: auth.deviceId,
            grant,
            now,
          });
          if (!result.granted) {
            throw refusedGrant(result);
          }
          return result;
        });
        const { replaced } = granted;
        if (replaced !== null && replaced.revokedAt === null) {
          // The database revoked it in the committed transaction; the change
          // stands, and only its event is missing.
          request.log.error(
            { grantId: replaced.id },
            "Invariant broken: a replaced grant has no revocation time",
          );
        }
        sendGrantEvents(request.log, connections, [
          ...(replaced === null || replaced.revokedAt === null
            ? []
            : [
                grantRevokedEvent(
                  {
                    grantId: replaced.id,
                    granteeAgentId: replaced.granteeAgentId,
                    workspaceId: granted.workspaceId,
                    revokedAt: new Date(replaced.revokedAt),
                  },
                  now,
                ),
              ]),
          grantCreatedEvent(granted.workspaceId, granted.grant, now),
        ]);
        return { grant: granted.grant };
      },
    );

    scope.post(
      GRANT_ROUTES.revokeGrant.path,
      { schema: { params: GrantParamsSchema } },
      async (request, reply) => {
        const auth = authOf(request);
        const { agentId, grantId } = request.params as {
          agentId: AgentId;
          grantId: PermissionGrantId;
        };
        const now = new Date(options.now());
        const revoked = await database.transaction(async (tx) => {
          await lockActor(tx, auth, now.getTime());
          const result = await revokeGrant(tx, {
            agentId,
            grantId,
            userId: auth.userId,
            now,
          });
          if (!result.revoked) {
            throw refusedRevocation(result);
          }
          return result;
        });
        const { grant } = revoked;
        if (grant.revokedAt === null) {
          // The revocation is committed, so the answer is still `204`; only
          // its event cannot be built.
          request.log.error(
            { grantId: grant.id },
            "Invariant broken: a revoked grant has no revocation time",
          );
          return reply.code(204).send();
        }
        sendGrantEvents(request.log, connections, [
          grantRevokedEvent(
            {
              grantId: grant.id,
              granteeAgentId: grant.granteeAgentId,
              workspaceId: revoked.workspaceId,
              revokedAt: new Date(grant.revokedAt),
            },
            now,
          ),
        ]);
        return reply.code(204).send();
      },
    );
  });
}
