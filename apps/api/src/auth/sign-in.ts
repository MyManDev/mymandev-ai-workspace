import {
  type Database,
  devices,
  revokeDevice,
  toDatabaseError,
  userIdentities,
  users,
  auditEvents,
} from "@mymandev/database";
import {
  AUTH_ROUTES,
  type DeviceId,
  type DeviceRegistration,
  displayText,
  LIMITS,
  newId,
  newUuidV7,
  SIGN_IN_LIFETIME_MS,
  type SignInRequest,
  SignInRequestSchema,
  type SignInResponse,
  type UserId,
} from "@mymandev/protocol";
import { and, count, eq, gt, isNull, min, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.ts";
import { zodValidatorCompiler } from "../validation.ts";
import { s256, type SignInCodes } from "./attempts.ts";
import { verifyDeviceSignature } from "./device-keys.ts";
import type { GitHubIdentity } from "./github-api.ts";
import type { AccessTokens } from "./tokens.ts";

/** ADR 0014, "Accounts" and "Limits". */
const MAX_ACTIVE_DEVICES = 20;
const MAX_NEW_DEVICES_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60_000;

/** Per remote address, while the API is reached directly (P-63). */
const ROUTE_LIMIT = { max: 30, timeWindow: 10 * 60_000 };

const displayNameSchema = displayText(LIMITS.displayName);

export type SignInRouteOptions = Readonly<{
  publicOrigin: string;
  database: Database;
  codes: SignInCodes;
  tokens: AccessTokens;
  now: () => number;
}>;

type SignInResult = Readonly<{
  response: SignInResponse;
  /** The previous device that this sign-in revoked as replaced, if any. */
  replacedDeviceId: DeviceId | null;
}>;

/** The first display name: the GitHub name if it passes the text rule and the length limit, else the login. */
function firstDisplayName(identity: GitHubIdentity): string {
  return identity.name !== null &&
    displayNameSchema.safeParse(identity.name).success
    ? identity.name
    : identity.login;
}

/** Verifies the signatures of the registration over the `sign-in` input (ADR 0014, step 7). */
function signaturesValid(
  publicOrigin: string,
  code: string,
  device: DeviceRegistration,
  currentPublicKey: string | null,
): boolean {
  const input = {
    purpose: "sign-in",
    audience: publicOrigin,
    signInCode: code,
    deviceId: device.kind === "new" ? null : device.deviceId,
    newPublicKey: device.publicKey,
  } as const;
  if (!verifyDeviceSignature(device.publicKey, input, device.newKeySignature)) {
    return false;
  }
  return (
    device.kind === "new" ||
    (currentPublicKey !== null &&
      verifyDeviceSignature(
        currentPublicKey,
        input,
        device.currentKeySignature,
      ))
  );
}

/**
 * `POST /auth/sign-in` (ADR 0014, steps 7 and 8): takes the sign-in code once,
 * checks the PKCE verifier, `redirect_uri`, and the signatures, then creates
 * or updates the account and registers the device or replaces its key, in
 * one transaction. The answer carries no credential.
 */
export async function registerSignIn(
  app: FastifyInstance,
  options: SignInRouteOptions,
): Promise<void> {
  const { database, codes, tokens, publicOrigin } = options;

  await app.register(async (scope) => {
    scope.setValidatorCompiler(zodValidatorCompiler);
    scope.post(
      AUTH_ROUTES.signIn.path,
      {
        schema: { body: SignInRequestSchema },
        config: { rateLimit: ROUTE_LIMIT },
      },
      async (request): Promise<SignInResponse> => {
        const body = request.body as SignInRequest;
        // Taking the code consumes it, also when a later check fails.
        const binding = codes.take(body.code);
        if (
          binding === null ||
          s256(body.codeVerifier) !== binding.desktopCodeChallenge ||
          body.redirectUri !== binding.redirectUri
        ) {
          throw new ApiError("auth_failed");
        }

        const now = new Date(options.now());
        let currentKey: string | null = null;
        if (body.device.kind === "existing") {
          const [row] = await database
            .select({ publicKey: devices.publicKey })
            .from(devices)
            .where(eq(devices.id, body.device.deviceId));
          currentKey = row?.publicKey ?? null;
          // Each sign-in replaces the key; keeping it would keep a copied key valid.
          if (currentKey === body.device.publicKey) {
            throw new ApiError("auth_failed");
          }
        }
        if (
          !signaturesValid(publicOrigin, body.code, body.device, currentKey)
        ) {
          throw new ApiError("auth_failed");
        }

        let result: SignInResult;
        try {
          result = await database.transaction((tx) =>
            signIn(tx, binding.identity, body.device, currentKey, now),
          );
        } catch (error) {
          if (error instanceof ApiError || !fromDatabase(error)) {
            throw error;
          }
          const failure = toDatabaseError(error);
          // A concurrent sign-in of the same account or the same key.
          throw failure.code === "23505" ? new ApiError("conflict") : failure;
        }
        // The earlier tokens of the device would be refused anyway; dropping
        // them keeps them from using up the account's request limit.
        tokens.dropDevice(result.response.deviceId);
        if (result.replacedDeviceId !== null) {
          tokens.dropDevice(result.replacedDeviceId);
        }
        return result.response;
      },
    );
  });
}

/** The account and device changes of one sign-in, inside its transaction. */
async function signIn(
  tx: Database,
  identity: GitHubIdentity,
  device: DeviceRegistration,
  verifiedCurrentKey: string | null,
  now: Date,
): Promise<SignInResult> {
  const userId = await upsertAccount(tx, identity, now);
  // "No key update" still serializes with every other change of the row, but
  // not with the key-share locks of foreign-key checks.
  const [user] = await tx
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .for("no key update");
  if (user === undefined || user.disabledAt !== null) {
    throw new ApiError("auth_failed");
  }

  let deviceId: DeviceId;
  let replacedDeviceId: DeviceId | null = null;
  if (device.kind === "existing") {
    const [row] = await tx
      .select()
      .from(devices)
      .where(eq(devices.id, device.deviceId))
      .for("no key update");
    if (row === undefined) {
      throw new ApiError("auth_failed");
    }
    // A revoked device answers device_revoked whatever account signs in, so
    // that the desktop deletes the key (ADR 0014, "Accounts").
    if (row.revokedAt !== null) {
      throw new ApiError("device_revoked");
    }
    if (row.userId !== userId) {
      throw new ApiError("device_account_mismatch");
    }
    // The key that signed must still be the device's key.
    if (row.publicKey !== verifiedCurrentKey) {
      throw new ApiError("auth_failed");
    }
    await tx
      .update(devices)
      .set({
        publicKey: device.publicKey,
        keyAlgorithm: device.keyAlgorithm,
        lastSignInAt: now,
        signedOutAt: null,
        updatedAt: now,
      })
      .where(eq(devices.id, row.id));
    deviceId = row.id;
    await audit(tx, "device.key_replaced", userId, deviceId, deviceId, now);
  } else {
    if (
      user.deviceRegistrationLockedUntil !== null &&
      user.deviceRegistrationLockedUntil > now
    ) {
      throw new ApiError("device_registration_locked");
    }
    // The previous device that this sign-in replaces does not count: the
    // recovery path keeps the number of active devices.
    const [active] = await tx
      .select({ n: count() })
      .from(devices)
      .where(
        and(
          eq(devices.userId, userId),
          isNull(devices.revokedAt),
          device.previousDeviceId === undefined
            ? undefined
            : ne(devices.id, device.previousDeviceId),
        ),
      );
    if ((active?.n ?? 0) >= MAX_ACTIVE_DEVICES) {
      // Only removing a device frees a place; ask again in a day.
      throw new ApiError("rate_limited", { retryAfterSeconds: DAY_MS / 1000 });
    }
    const [recent] = await tx
      .select({ n: count(), oldest: min(devices.createdAt) })
      .from(devices)
      .where(
        and(
          eq(devices.userId, userId),
          gt(devices.createdAt, new Date(now.getTime() - DAY_MS)),
        ),
      );
    if ((recent?.n ?? 0) >= MAX_NEW_DEVICES_PER_DAY) {
      const oldest = recent?.oldest ?? now;
      throw new ApiError("rate_limited", {
        retryAfterSeconds: (oldest.getTime() + DAY_MS - now.getTime()) / 1000,
      });
    }
    deviceId = newId<DeviceId>();
    await tx.insert(devices).values({
      id: deviceId,
      userId,
      label: device.label,
      platform: device.platform,
      publicKey: device.publicKey,
      keyAlgorithm: device.keyAlgorithm,
      createdAt: now,
      updatedAt: now,
      lastSignInAt: now,
    });
    await audit(tx, "device.registered", userId, deviceId, deviceId, now);
    if (device.previousDeviceId !== undefined) {
      // Revoked only if it belongs to the same account (ADR 0014, step 8).
      // Closing its socket and sending the run events for the result waits
      // for the gateway's connection registry (#89).
      const replaced = await revokeDevice(tx, {
        deviceId: device.previousDeviceId,
        userId,
        reason: "replaced",
        now,
        actorUserId: userId,
        actorDeviceId: deviceId,
      });
      if (replaced.revoked) {
        replacedDeviceId = device.previousDeviceId;
      }
    }
  }
  await audit(tx, "account.signed_in", userId, deviceId, userId, now);

  return {
    response: {
      userId,
      deviceId,
      displayName: user.displayName,
      login: identity.login,
      signInExpiresAt: new Date(
        now.getTime() + SIGN_IN_LIFETIME_MS,
      ).toISOString(),
    },
    replacedDeviceId,
  };
}

/**
 * Finds the account by GitHub's numeric ID, never by login, and refreshes the
 * login; or creates the account with its first display name.
 */
async function upsertAccount(
  tx: Database,
  identity: GitHubIdentity,
  now: Date,
): Promise<UserId> {
  const [existing] = await tx
    .select({ userId: userIdentities.userId, id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        eq(userIdentities.identityProvider, "github"),
        eq(userIdentities.subject, identity.githubId),
      ),
    )
    .for("update");
  if (existing !== undefined) {
    await tx
      .update(userIdentities)
      .set({ login: identity.login, lastSignInAt: now, updatedAt: now })
      .where(eq(userIdentities.id, existing.id));
    return existing.userId;
  }
  const userId = newId<UserId>();
  await tx.insert(users).values({
    id: userId,
    displayName: firstDisplayName(identity),
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(userIdentities).values({
    id: newUuidV7(),
    userId,
    identityProvider: "github",
    subject: identity.githubId,
    login: identity.login,
    accountCreatedAt: new Date(identity.accountCreatedAt),
    createdAt: now,
    updatedAt: now,
    lastSignInAt: now,
  });
  return userId;
}

async function audit(
  tx: Database,
  action: "account.signed_in" | "device.registered" | "device.key_replaced",
  userId: UserId,
  deviceId: DeviceId,
  subjectId: UserId | DeviceId,
  now: Date,
): Promise<void> {
  await tx.insert(auditEvents).values({
    id: newUuidV7(),
    createdAt: now,
    action,
    actorUserId: userId,
    actorDeviceId: deviceId,
    subjectId,
  });
}

/**
 * Whether an error came from the database driver or Drizzle, whose message
 * carries SQL and parameters. Any other error, such as a programming error,
 * keeps its type and stack for the log.
 */
function fromDatabase(error: unknown): boolean {
  const carries = (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    ("code" in value || "query" in value || "params" in value);
  return carries(error) || (error instanceof Error && carries(error.cause));
}
