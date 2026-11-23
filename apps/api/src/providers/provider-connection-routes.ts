import {
  type Database,
  listProviderConnections,
  registerProviderConnection,
  type RegisterProviderConnectionResult,
  removeProviderConnection,
} from "@mymandev/database";
import {
  PROVIDER_CONNECTION_ROUTES,
  type ProviderConnection,
  type ProviderConnectionId,
  ProviderConnectionIdSchema,
  type ProviderConnectionListResponse,
  type RegisterProviderConnectionRequest,
  RegisterProviderConnectionRequestSchema,
  type RegisterProviderConnectionResponse,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import * as z from "zod";
import {
  authOf,
  lockActor,
  type RequireAccessToken,
} from "../auth/authenticate.ts";
import { ApiError } from "../errors.ts";
import { zodValidatorCompiler } from "../validation.ts";

export type ProviderConnectionRouteOptions = Readonly<{
  database: Database;
  requireAccessToken: RequireAccessToken;
  now: () => number;
}>;

/** The path parameter of a removal. */
const ProviderConnectionParamsSchema = z.object({
  providerConnectionId: ProviderConnectionIdSchema,
});

/**
 * The answer to a refused registration (#295). A device at its limit of
 * connections that are not removed answers `409` with
 * `provider_connection_limit` and no `Retry-After`, because no time frees a
 * place, only a removal does. The account's 20 registrations in 24 hours
 * answer `rate_limited` with the time until the oldest of them leaves the
 * window. Each refusal of the database has its own case: one that it adds
 * fails the type check here.
 */
function refusedRegistration(
  result: Extract<RegisterProviderConnectionResult, { registered: false }>,
): ApiError {
  switch (result.refusal) {
    case "provider_connection_limit":
      return new ApiError("provider_connection_limit");
    case "rate_limited":
      return new ApiError("rate_limited", {
        retryAfterSeconds: result.retryAfterMs / 1000,
      });
    // `lockActor` refuses a disabled account and a revoked device first;
    // the database checks both again for callers without it.
    case "forbidden":
      return new ApiError("unauthorized");
    default:
      return result satisfies never;
  }
}

/**
 * A connection as its host device reads it, built field by field, so that a
 * field that the database result gains later is not sent until it is added
 * here.
 */
function item(connection: ProviderConnection): ProviderConnection {
  return {
    id: connection.id,
    kind: connection.kind,
    label: connection.label,
    createdAt: connection.createdAt,
  };
}

/**
 * The provider connections of the calling device (#295; Project Manager
 * decisions of 2026-11-20, whose defaults the Project Manager accepted on
 * 2026-11-23): registering one, listing them, and removing one. Every route
 * needs an access token, and the account limit of every authenticated route
 * applies. No path names a device: the calling device, from the access
 * token, is the host device of every connection that a route reads or
 * changes, as for `GET /grant-records`, so a device never reaches another
 * device's connection, also of the same account.
 *
 * Each change runs in one transaction that checks the account and the
 * device again (`lockActor`), so a device that was revoked after the
 * request was authenticated changes nothing. A removal revokes the
 * connection's active `provider.use` grants in the same transaction (ADR
 * 0015, P-77) and cancels no run. No change sends a workspace event, because
 * a connection is device data (#110), and none sends `agent.grant.revoked`
 * until the grant routes send them for every change that revokes grants
 * (#75). Neither change writes an audit record.
 */
export async function registerProviderConnectionRoutes(
  app: FastifyInstance,
  options: ProviderConnectionRouteOptions,
): Promise<void> {
  const { database } = options;

  await app.register(async (scope) => {
    scope.setValidatorCompiler(zodValidatorCompiler);
    options.requireAccessToken(scope);

    // The calling device's connections that are not removed, the oldest
    // first.
    scope.get(
      PROVIDER_CONNECTION_ROUTES.listProviderConnections.path,
      async (request): Promise<ProviderConnectionListResponse> => {
        const auth = authOf(request);
        const connections = await listProviderConnections(database, {
          userId: auth.userId,
          deviceId: auth.deviceId,
        });
        return { providerConnections: connections.map(item) };
      },
    );

    // The calling device becomes the host device. The body's schema strips
    // every field but the kind and the label, so a secret, a provider
    // account, or a host device in the body never reaches the database.
    scope.post(
      PROVIDER_CONNECTION_ROUTES.registerProviderConnection.path,
      { schema: { body: RegisterProviderConnectionRequestSchema } },
      async (request): Promise<RegisterProviderConnectionResponse> => {
        const auth = authOf(request);
        const { kind, label } =
          request.body as RegisterProviderConnectionRequest;
        const now = new Date(options.now());
        const providerConnection = await database.transaction(async (tx) => {
          await lockActor(tx, auth, now.getTime());
          const result = await registerProviderConnection(tx, {
            userId: auth.userId,
            deviceId: auth.deviceId,
            kind,
            label,
            now,
          });
          if (!result.registered) {
            throw refusedRegistration(result);
          }
          return result.providerConnection;
        });
        return { providerConnection: item(providerConnection) };
      },
    );

    // Only the host device; a connection of another device looks missing.
    scope.post(
      PROVIDER_CONNECTION_ROUTES.removeProviderConnection.path,
      { schema: { params: ProviderConnectionParamsSchema } },
      async (request, reply) => {
        const auth = authOf(request);
        const { providerConnectionId } = request.params as {
          providerConnectionId: ProviderConnectionId;
        };
        const now = new Date(options.now());
        await database.transaction(async (tx) => {
          await lockActor(tx, auth, now.getTime());
          const result = await removeProviderConnection(tx, {
            userId: auth.userId,
            deviceId: auth.deviceId,
            providerConnectionId,
            now,
          });
          if (!result.removed) {
            // `lockActor` refuses a disabled account and a revoked device
            // first; the database checks both again for callers without it.
            throw new ApiError(
              result.refusal === "forbidden" ? "unauthorized" : result.refusal,
            );
          }
        });
        return reply.code(204).send();
      },
    );
  });
}
