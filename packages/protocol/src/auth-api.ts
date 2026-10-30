import * as z from "zod";
import {
  AccessTokenSchema,
  Base64Url32BytesSchema,
  DeviceKeyAlgorithmSchema,
  DeviceListItemSchema,
  DevicePublicKeySchema,
  DeviceRevocationReasonSchema,
  DeviceSignatureSchema,
  GitHubLoginSchema,
  SignInCodeSchema,
} from "./account.ts";
import { DevicePlatformSchema, displayText } from "./entities.ts";
import { UtcTimestampSchema } from "./entities.ts";
import { DeviceIdSchema, UserIdSchema } from "./ids.ts";
import { LIMITS, MAX_ANSWER_LIST_ITEMS, UUIDV7_PATTERN } from "./model.ts";
import { privatePattern } from "./private-pattern.ts";

/** One HTTP route of the API. Path parameters are written as `:name`. */
export type ApiRoute = Readonly<{ method: "GET" | "POST"; path: string }>;

function route(method: ApiRoute["method"], path: string): ApiRoute {
  return Object.freeze({ method, path });
}

/**
 * The authentication and device routes (ADR 0014). Everything else needs an
 * access token, except `/health`.
 */
export const AUTH_ROUTES = Object.freeze({
  /** Opened in the system browser. Starts a sign-in attempt and redirects to GitHub. */
  githubAuthorize: route("GET", "/auth/github/authorize"),
  /** GitHub's callback. Shows the confirmation page. */
  githubCallback: route("GET", "/auth/github/callback"),
  /** Continue on the confirmation page. Posts the sign-in code to the loopback listener. */
  githubConfirm: route("POST", "/auth/github/confirm"),
  /** GitHub's `github_app_authorization` webhook. */
  githubWebhook: route("POST", "/auth/github/webhook"),
  /** Registers the device or replaces its key. */
  signIn: route("POST", "/auth/sign-in"),
  /** Issues a challenge for an access token. */
  challenge: route("POST", "/auth/challenge"),
  /** Issues an access token for a signed challenge. */
  accessToken: route("POST", "/auth/access-token"),
  /** Signs out the current device. */
  signOut: route("POST", "/auth/sign-out"),
  /** Lists the person's own devices. */
  listDevices: route("GET", "/devices"),
  /** Revokes one of the person's own devices. */
  revokeDevice: route("POST", "/devices/:deviceId/revoke"),
  /** Lifts the registration lock after a lost device. */
  liftRegistrationLock: route("POST", "/account/registration-lock/lift"),
});

/** The path of the desktop's loopback listener. */
export const LOOPBACK_CALLBACK_PATH = "/callback";

const uuidV7Pattern = privatePattern(UUIDV7_PATTERN);

/**
 * Fills the `:name` parameters of a route path. Every parameter is an ID, so
 * a value must be a lowercase UUIDv7, and every parameter must be given.
 * Throws a `TypeError` otherwise; the error never contains a value.
 */
export function routePath(
  path: string,
  params: Readonly<Record<string, string>> = {},
): string {
  const used = new Set<string>();
  const filled = path.replace(
    /:([A-Za-z][A-Za-z0-9]*)/gu,
    (_match, name: string) => {
      const value: unknown = Object.hasOwn(params, name)
        ? params[name]
        : undefined;
      if (typeof value !== "string" || !uuidV7Pattern.test(value)) {
        throw new TypeError(`Invalid path parameter ${name}`);
      }
      used.add(name);
      return value;
    },
  );
  for (const name of Object.keys(params)) {
    if (!used.has(name)) {
      throw new TypeError(`Unknown path parameter ${name}`);
    }
  }
  return filled;
}

/**
 * The redirect URI of the desktop's loopback listener: `127.0.0.1` with a
 * port from 1024 to 65535 and the path `/callback`.
 */
export const LOOPBACK_REDIRECT_URI_PATTERN =
  /^http:\/\/127\.0\.0\.1:(?:102[4-9]|10[3-9][0-9]|1[1-9][0-9]{2}|[2-9][0-9]{3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])\/callback$/u;

export const LoopbackRedirectUriSchema = z
  .string()
  .regex(
    privatePattern(LOOPBACK_REDIRECT_URI_PATTERN),
    "Expected the loopback callback URI",
  );

/**
 * The query of `GET /auth/github/authorize`, which the desktop opens in the
 * system browser. None of these values is secret. The names follow OAuth.
 */
export const GitHubAuthorizeQuerySchema = z.object({
  code_challenge: Base64Url32BytesSchema,
  code_challenge_method: z.literal("S256"),
  redirect_uri: LoopbackRedirectUriSchema,
  state: Base64Url32BytesSchema,
  /** The GitHub login of the device's account, on a repeated sign-in. */
  login: GitHubLoginSchema.optional(),
  /** On a first sign-in, or after `device_account_mismatch`. */
  prompt: z.literal("select_account").optional(),
});
export type GitHubAuthorizeQuery = z.infer<typeof GitHubAuthorizeQuerySchema>;

/**
 * The form body that the API's page posts to the loopback listener: the
 * sign-in code, or an error when GitHub reported one or the person declined.
 * The listener checks `state`; the `Origin` header of this request is `null`.
 */
export const LoopbackCallbackBodySchema = z.union([
  z.object({ code: SignInCodeSchema, state: Base64Url32BytesSchema }),
  z.object({
    error: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/u, "Expected an error code"),
    state: Base64Url32BytesSchema,
  }),
]);
export type LoopbackCallbackBody = z.infer<typeof LoopbackCallbackBodySchema>;

/** A device that signs in for the first time. `newKeySignature` signs the `sign-in` input with the new key. */
export const NewDeviceRegistrationSchema = z.object({
  kind: z.literal("new"),
  publicKey: DevicePublicKeySchema,
  keyAlgorithm: DeviceKeyAlgorithmSchema,
  label: displayText(LIMITS.deviceLabel),
  platform: DevicePlatformSchema,
  newKeySignature: DeviceSignatureSchema,
  /** The device of this installation whose key was lost; the server revokes it as `replaced`. */
  previousDeviceId: DeviceIdSchema.optional(),
});

/** A device that signs in again and replaces its key. Both keys sign the same `sign-in` input. */
export const ExistingDeviceRegistrationSchema = z.object({
  kind: z.literal("existing"),
  deviceId: DeviceIdSchema,
  publicKey: DevicePublicKeySchema,
  keyAlgorithm: DeviceKeyAlgorithmSchema,
  currentKeySignature: DeviceSignatureSchema,
  newKeySignature: DeviceSignatureSchema,
});

export const DeviceRegistrationSchema = z.discriminatedUnion("kind", [
  NewDeviceRegistrationSchema,
  ExistingDeviceRegistrationSchema,
]);
export type DeviceRegistration = z.infer<typeof DeviceRegistrationSchema>;

/** `POST /auth/sign-in`. */
export const SignInRequestSchema = z.object({
  code: SignInCodeSchema,
  codeVerifier: Base64Url32BytesSchema,
  redirectUri: LoopbackRedirectUriSchema,
  device: DeviceRegistrationSchema,
});
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

/** The answer of `POST /auth/sign-in`. It carries no credential: the device holds its key. */
export const SignInResponseSchema = z.object({
  userId: UserIdSchema,
  deviceId: DeviceIdSchema,
  /** The account's display name, shown on the account's own screens. */
  displayName: displayText(LIMITS.displayName),
  login: GitHubLoginSchema,
  signInExpiresAt: UtcTimestampSchema,
});
export type SignInResponse = z.infer<typeof SignInResponseSchema>;

/** The answer of `POST /auth/challenge`. The challenge is single use and valid for 60 seconds. */
export const ChallengeResponseSchema = z.object({
  challengeId: z
    .string()
    .regex(privatePattern(UUIDV7_PATTERN), "Expected a lowercase UUIDv7"),
  nonce: Base64Url32BytesSchema,
});
export type ChallengeResponse = z.infer<typeof ChallengeResponseSchema>;

/** `POST /auth/access-token`. The signature signs the `http` input. */
export const AccessTokenRequestSchema = z.object({
  deviceId: DeviceIdSchema,
  challengeId: z
    .string()
    .regex(privatePattern(UUIDV7_PATTERN), "Expected a lowercase UUIDv7"),
  signature: DeviceSignatureSchema,
});
export type AccessTokenRequest = z.infer<typeof AccessTokenRequestSchema>;

/** The answer of `POST /auth/access-token`. The token is valid for 15 minutes and never extended. */
export const AccessTokenResponseSchema = z.object({
  accessToken: AccessTokenSchema,
  expiresAt: UtcTimestampSchema,
});
export type AccessTokenResponse = z.infer<typeof AccessTokenResponseSchema>;

/** The answer of `GET /devices`. */
export const DeviceListResponseSchema = z.object({
  devices: z.array(DeviceListItemSchema).max(MAX_ANSWER_LIST_ITEMS),
});
export type DeviceListResponse = z.infer<typeof DeviceListResponseSchema>;

/** `POST /devices/:deviceId/revoke`. A person revokes a device as removed or lost. */
export const RevokeDeviceRequestSchema = z.object({
  reason: DeviceRevocationReasonSchema.extract(["removed", "lost"]),
});
export type RevokeDeviceRequest = z.infer<typeof RevokeDeviceRequestSchema>;
