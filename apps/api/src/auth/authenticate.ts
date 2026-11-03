import { type Database, deviceRow, devices, users } from "@mymandev/database";
import {
  ACCESS_TOKEN_PATTERN,
  type DeviceId,
  type UserId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.ts";
import {
  type AuthContext,
  type DeviceRow,
  tokenUsable,
} from "./device-state.ts";
import { type AccessTokens, WindowLimiter } from "./tokens.ts";

/** Authenticated requests per account, across every authenticated route. */
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

export type AccessCheckOptions = Readonly<{
  database: Database;
  tokens: AccessTokens;
  now: () => number;
}>;

/**
 * Makes every route of a plugin scope need `Authorization: Bearer <access
 * token>` (ADR 0014, "Device key and authentication" and "Limits").
 */
export type RequireAccessToken = (scope: FastifyInstance) => void;

/**
 * The access-token check of the authenticated routes. Create it once per
 * app, so that the account's request limit counts every authenticated route
 * together.
 */
export function createAccessCheck(
  app: FastifyInstance,
  options: AccessCheckOptions,
): RequireAccessToken {
  const { database, tokens } = options;
  const requestsPerUser = new WindowLimiter(
    REQUESTS_PER_USER.max,
    REQUESTS_PER_USER.windowMs,
    options.now,
  );
  const sweeper = setInterval(() => {
    requestsPerUser.sweep();
  }, 15_000);
  sweeper.unref();
  app.addHook("onClose", async () => {
    clearInterval(sweeper);
  });
  if (!app.hasRequestDecorator("auth")) {
    app.decorateRequest("auth", null);
  }

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
   * The token and the account's request limit are checked when the headers
   * arrive.
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

  return (scope) => {
    scope.addHook("onRequest", admit);
    scope.addHook("preValidation", authenticate);
  };
}

/** Who sent a request on a route that `RequireAccessToken` protects. */
export function authOf(request: FastifyRequest): AuthContext {
  if (request.auth === null) {
    throw new ApiError("unauthorized");
  }
  return request.auth;
}

/**
 * Locks an account and one of its devices until the transaction ends and
 * reads them as `deviceRow` does, or undefined when either is missing. The
 * account is locked before the device, in the order the sign-in uses. "No
 * key update" still waits for every other change of these rows, but not for
 * the key-share locks of foreign-key checks, so that it cannot deadlock with
 * them.
 */
export async function lockDeviceRow(
  tx: Database,
  identity: Readonly<{ userId: UserId; deviceId: DeviceId }>,
): Promise<DeviceRow | undefined> {
  const [user] = await tx
    .select({
      disabledAt: users.disabledAt,
      signInRequiredAt: users.signInRequiredAt,
    })
    .from(users)
    .where(eq(users.id, identity.userId))
    .for("no key update");
  const [device] = await tx
    .select({
      userId: devices.userId,
      revokedAt: devices.revokedAt,
      signedOutAt: devices.signedOutAt,
      lastSignInAt: devices.lastSignInAt,
    })
    .from(devices)
    .where(eq(devices.id, identity.deviceId))
    .for("no key update");
  return user === undefined || device === undefined
    ? undefined
    : { ...device, ...user };
}

/**
 * Locks the account and the acting device until the transaction ends and
 * checks them again (`lockDeviceRow`), so that a request authenticated
 * before a revocation, a sign-out, a new sign-in, or a disable cannot change
 * anything after it.
 */
export async function lockActor(
  tx: Database,
  auth: AuthContext,
  now: number,
): Promise<void> {
  if (!tokenUsable(await lockDeviceRow(tx, auth), auth, now)) {
    throw new ApiError("unauthorized");
  }
}
