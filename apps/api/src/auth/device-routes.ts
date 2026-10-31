import {
  auditEvents,
  type Database,
  devices,
  revokeDevice,
  users,
} from "@mymandev/database";
import {
  type AccessTokenRequest,
  AccessTokenRequestSchema,
  type AccessTokenResponse,
  ACCESS_TOKEN_PATTERN,
  AUTH_ROUTES,
  type ChallengeResponse,
  type DeviceId,
  DeviceIdSchema,
  type DeviceListResponse,
  MAX_ANSWER_LIST_ITEMS,
  newUuidV7,
  type RevokeDeviceRequest,
  RevokeDeviceRequestSchema,
  SIGN_IN_LIFETIME_MS,
} from "@mymandev/protocol";
import { and, desc, eq, gt } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import * as z from "zod";
import { ApiError } from "../errors.ts";
import { zodValidatorCompiler } from "../validation.ts";
import { verifyDeviceSignature } from "./device-keys.ts";
import {
  type AuthContext,
  deviceRow,
  stateOf,
  tokenUsable,
} from "./device-state.ts";
import { type AccessTokens, type Challenges, WindowLimiter } from "./tokens.ts";

const DAY_MS = 24 * 60 * 60_000;
/** ADR 0014, "Lifetimes". */
const REGISTRATION_LOCK_MS = 7 * DAY_MS;

/** Per remote address, before any signature is verified (P-63). */
const ADDRESS_LIMIT = { max: 60, timeWindow: 10 * 60_000 };
/** Access tokens per device after a verified signature; one is needed every 15 minutes. */
const TOKENS_PER_DEVICE = { max: 30, windowMs: 15 * 60_000 };
/** Authenticated requests per account. */
const REQUESTS_PER_USER = { max: 300, windowMs: 60_000 };

const accessTokenPattern = new RegExp(
  ACCESS_TOKEN_PATTERN.source,
  ACCESS_TOKEN_PATTERN.flags,
);

const BEARER = "bearer ";

declare module "fastify" {
  interface FastifyRequest {
    /** Set on authenticated routes after the access token passed every check. */
    auth: AuthContext | null;
  }
}

export type DeviceRouteOptions = Readonly<{
  publicOrigin: string;
  database: Database;
  challenges: Challenges;
  tokens: AccessTokens;
  now: () => number;
}>;

/**
 * Locks the account and the acting device until the transaction ends and
 * checks them again, so that a request authenticated before a revocation, a
 * sign-out, a new sign-in, or a disable cannot change anything after it. The
 * account is locked before the device, in the order the sign-in uses. "No key
 * update" still waits for every other change of these rows, but not for the
 * key-share locks of foreign-key checks, so that it cannot deadlock with them.
 */
export async function lockActor(
  tx: Database,
  auth: AuthContext,
  now: number,
): Promise<void> {
  const [user] = await tx
    .select({
      disabledAt: users.disabledAt,
      signInRequiredAt: users.signInRequiredAt,
    })
    .from(users)
    .where(eq(users.id, auth.userId))
    .for("no key update");
  const [device] = await tx
    .select({
      userId: devices.userId,
      revokedAt: devices.revokedAt,
      signedOutAt: devices.signedOutAt,
      lastSignInAt: devices.lastSignInAt,
    })
    .from(devices)
    .where(eq(devices.id, auth.deviceId))
    .for("no key update");
  const row =
    user === undefined || device === undefined
      ? undefined
      : { ...device, ...user };
  if (!tokenUsable(row, auth, now)) {
    throw new ApiError("unauthorized");
  }
}

async function audit(
  database: Database,
  values: Readonly<{
    action:
      | "device.signed_out"
      | "account.registration_locked"
      | "account.registration_lock_lifted";
    auth: AuthContext;
    subjectId: string;
    now: Date;
    reason?: "lost";
  }>,
): Promise<void> {
  await database.insert(auditEvents).values({
    id: newUuidV7(),
    createdAt: values.now,
    action: values.action,
    actorUserId: values.auth.userId,
    actorDeviceId: values.auth.deviceId,
    subjectId: values.subjectId,
    ...(values.reason === undefined ? {} : { reason: values.reason }),
  });
}

/**
 * Access tokens, sign-out, and the person's own devices (ADR 0014, "Device
 * key and authentication" and "Revocation, sign-out, and recovery").
 */
export async function registerDeviceRoutes(
  app: FastifyInstance,
  options: DeviceRouteOptions,
): Promise<void> {
  const { database, challenges, tokens, publicOrigin } = options;
  const tokensPerDevice = new WindowLimiter(
    TOKENS_PER_DEVICE.max,
    TOKENS_PER_DEVICE.windowMs,
    options.now,
  );
  const requestsPerUser = new WindowLimiter(
    REQUESTS_PER_USER.max,
    REQUESTS_PER_USER.windowMs,
    options.now,
  );
  const sweeper = setInterval(() => {
    challenges.sweep();
    tokens.sweep();
    tokensPerDevice.sweep();
    requestsPerUser.sweep();
  }, 15_000);
  sweeper.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweeper);
  });
  if (!app.hasRequestDecorator("auth")) {
    app.decorateRequest("auth", null);
  }

  // Minting a token needs no token.
  await app.register(async (scope) => {
    scope.setValidatorCompiler(zodValidatorCompiler);

    scope.post(
      AUTH_ROUTES.challenge.path,
      { config: { rateLimit: ADDRESS_LIMIT } },
      async (_request, reply): Promise<ChallengeResponse> => {
        reply.header("cache-control", "no-store");
        const challenge = challenges.issue();
        if (challenge === null) {
          throw new ApiError("rate_limited", { retryAfterSeconds: 60 });
        }
        return challenge;
      },
    );

    scope.post(
      AUTH_ROUTES.accessToken.path,
      {
        schema: { body: AccessTokenRequestSchema },
        config: { rateLimit: ADDRESS_LIMIT },
      },
      async (request, reply): Promise<AccessTokenResponse> => {
        reply.header("cache-control", "no-store");
        const body = request.body as AccessTokenRequest;
        const nonce = challenges.take(body.challengeId);
        const row =
          nonce === null ? undefined : await deviceRow(database, body.deviceId);
        // The signature is checked first; only then does the device state answer.
        if (
          nonce === null ||
          row === undefined ||
          !verifyDeviceSignature(
            row.publicKey,
            {
              purpose: "http",
              audience: publicOrigin,
              nonce,
              deviceId: body.deviceId,
              challengeId: body.challengeId,
            },
            body.signature,
          )
        ) {
          throw new ApiError("auth_failed");
        }
        const wait = tokensPerDevice.hit(body.deviceId);
        if (wait > 0) {
          throw new ApiError("rate_limited", { retryAfterSeconds: wait });
        }
        const state = stateOf(row, options.now());
        switch (state.state) {
          case "revoked":
            throw new ApiError("device_revoked");
          case "disabled":
            throw new ApiError("auth_failed");
          case "sign_in_required":
            throw new ApiError("sign_in_required");
          case "ok":
            break;
        }
        // The token belongs to the sign-in whose key signed; a newer sign-in ends it.
        const issued = tokens.issue({
          userId: state.userId,
          deviceId: body.deviceId,
          signedInAt: row.lastSignInAt.getTime(),
        });
        if (issued === null) {
          throw new ApiError("rate_limited", { retryAfterSeconds: 60 });
        }
        return {
          accessToken: issued.accessToken,
          expiresAt: new Date(issued.expiresAt).toISOString(),
        };
      },
    );
  });

  /** The live token in `Authorization: Bearer <access token>`; the scheme ignores case. */
  function tokenOf(request: FastifyRequest): AuthContext {
    const header = request.headers.authorization ?? "";
    const token =
      header.slice(0, BEARER.length).toLowerCase() === BEARER
        ? header.slice(BEARER.length)
        : "";
    const record = accessTokenPattern.test(token) ? tokens.find(token) : null;
    if (record === null) {
      throw new ApiError("unauthorized");
    }
    return {
      userId: record.userId,
      deviceId: record.deviceId,
      signedInAt: record.signedInAt,
    };
  }

  /**
   * Every other route needs an access token. The token and the account's
   * request limit are checked when the headers arrive.
   */
  async function admit(request: FastifyRequest): Promise<void> {
    const wait = requestsPerUser.hit(tokenOf(request).userId);
    if (wait > 0) {
      throw new ApiError("rate_limited", { retryAfterSeconds: wait });
    }
  }

  /**
   * The token, the device, and the account are checked again after the body
   * arrived, so that a slow body cannot carry a request past a revocation.
   * Every failure is 401 with unauthorized.
   */
  async function authenticate(request: FastifyRequest): Promise<void> {
    const auth = tokenOf(request);
    const row = await deviceRow(database, auth.deviceId);
    if (!tokenUsable(row, auth, options.now())) {
      throw new ApiError("unauthorized");
    }
    request.auth = auth;
  }

  await app.register(async (scope) => {
    scope.setValidatorCompiler(zodValidatorCompiler);
    scope.addHook("onRequest", admit);
    scope.addHook("preValidation", authenticate);
    const authOf = (request: FastifyRequest): AuthContext => {
      if (request.auth === null) {
        throw new ApiError("unauthorized");
      }
      return request.auth;
    };

    scope.post(AUTH_ROUTES.signOut.path, async (request, reply) => {
      const auth = authOf(request);
      const now = new Date(options.now());
      await database.transaction(async (tx) => {
        await lockActor(tx, auth, now.getTime());
        await tx
          .update(devices)
          .set({ signedOutAt: now, updatedAt: now })
          .where(eq(devices.id, auth.deviceId));
        await audit(tx, {
          action: "device.signed_out",
          auth,
          subjectId: auth.deviceId,
          now,
        });
      });
      tokens.dropDevice(auth.deviceId);
      return reply.code(204).send();
    });

    scope.get(
      AUTH_ROUTES.listDevices.path,
      async (request): Promise<DeviceListResponse> => {
        const auth = authOf(request);
        const rows = await database
          .select()
          .from(devices)
          .where(eq(devices.userId, auth.userId))
          .orderBy(desc(devices.createdAt))
          .limit(MAX_ANSWER_LIST_ITEMS);
        return {
          devices: rows.map((row) => ({
            id: row.id,
            label: row.label,
            platform: row.platform,
            createdAt: row.createdAt.toISOString(),
            lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
            lastSignInAt: row.lastSignInAt.toISOString(),
            signInExpiresAt: new Date(
              row.lastSignInAt.getTime() + SIGN_IN_LIFETIME_MS,
            ).toISOString(),
            revokedAt: row.revokedAt?.toISOString() ?? null,
            current: row.id === auth.deviceId,
          })),
        };
      },
    );

    scope.post(
      AUTH_ROUTES.revokeDevice.path,
      {
        schema: {
          params: z.object({ deviceId: DeviceIdSchema }),
          body: RevokeDeviceRequestSchema,
        },
      },
      async (request, reply) => {
        const auth = authOf(request);
        const { deviceId } = request.params as { deviceId: DeviceId };
        const { reason } = request.body as RevokeDeviceRequest;
        // A device cannot report itself lost: whoever holds it could otherwise
        // lock the account's new devices (P-55).
        if (reason === "lost" && deviceId === auth.deviceId) {
          throw new ApiError("conflict");
        }
        const now = new Date(options.now());
        const [target] = await database
          .select({ userId: devices.userId, revokedAt: devices.revokedAt })
          .from(devices)
          .where(eq(devices.id, deviceId));
        // Only the person's own devices; another person's device looks missing.
        if (target === undefined || target.userId !== auth.userId) {
          throw new ApiError("not_found");
        }
        if (target.revokedAt !== null) {
          throw new ApiError("conflict");
        }
        await database.transaction(async (tx) => {
          await lockActor(tx, auth, now.getTime());
          const result = await revokeDevice(tx, {
            deviceId,
            userId: auth.userId,
            reason,
            now,
            actorUserId: auth.userId,
            actorDeviceId: auth.deviceId,
          });
          if (!result.revoked) {
            throw new ApiError("conflict");
          }
          if (reason === "lost") {
            // New devices are refused for 7 days (P-55).
            await tx
              .update(users)
              .set({
                deviceRegistrationLockedUntil: new Date(
                  now.getTime() + REGISTRATION_LOCK_MS,
                ),
                updatedAt: now,
              })
              .where(eq(users.id, auth.userId));
            await audit(tx, {
              action: "account.registration_locked",
              auth,
              subjectId: auth.userId,
              now,
              reason: "lost",
            });
          }
        });
        tokens.dropDevice(deviceId);
        return reply.code(204).send();
      },
    );

    scope.post(
      AUTH_ROUTES.liftRegistrationLock.path,
      async (request, reply) => {
        const auth = authOf(request);
        const now = new Date(options.now());
        await database.transaction(async (tx) => {
          await lockActor(tx, auth, now.getTime());
          const lifted = await tx
            .update(users)
            .set({ deviceRegistrationLockedUntil: null, updatedAt: now })
            .where(
              and(
                eq(users.id, auth.userId),
                gt(users.deviceRegistrationLockedUntil, now),
              ),
            )
            .returning({ id: users.id });
          if (lifted.length > 0) {
            await audit(tx, {
              action: "account.registration_lock_lifted",
              auth,
              subjectId: auth.userId,
              now,
            });
          }
        });
        return reply.code(204).send();
      },
    );
  });
}
