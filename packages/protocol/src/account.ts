import * as z from "zod";
import {
  ACCESS_TOKEN_PATTERN,
  BASE64URL_32_BYTES_PATTERN,
  DEVICE_PUBLIC_KEY_PATTERN,
  DEVICE_SIGNATURE_PATTERN,
  INVITATION_CODE_PATTERN,
  SIGN_IN_CODE_PATTERN,
} from "./device-auth.ts";
import { DevicePlatformSchema, displayText } from "./entities.ts";
import { UtcTimestampSchema } from "./envelope.ts";
import {
  DeviceIdSchema,
  MemberIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "./ids.ts";
import {
  API_ERROR_CODES,
  DEVICE_KEY_ALGORITHMS,
  DEVICE_REVOCATION_REASONS,
  GITHUB_LOGIN_PATTERN,
  IDENTITY_PROVIDERS,
  JOIN_REQUEST_DECISIONS,
  LIMITS,
  MEMBER_ROLES,
  RUN_CANCEL_REASONS,
} from "./model.ts";
import { privatePattern } from "./private-pattern.ts";

export const MemberRoleSchema = z.enum(MEMBER_ROLES);
export const DeviceKeyAlgorithmSchema = z.enum(DEVICE_KEY_ALGORITHMS);
export const DeviceRevocationReasonSchema = z.enum(DEVICE_REVOCATION_REASONS);
export const JoinRequestDecisionSchema = z.enum(JOIN_REQUEST_DECISIONS);
export const IdentityProviderSchema = z.enum(IDENTITY_PROVIDERS);
export const RunCancelReasonSchema = z.enum(RUN_CANCEL_REASONS);
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

/** A GitHub login. Display data only; nothing is resolved by login. */
export const GitHubLoginSchema = z
  .string()
  .regex(privatePattern(GITHUB_LOGIN_PATTERN), "Expected a GitHub login");

/** A PKCE state, verifier, or challenge, and a server nonce: 32 bytes as 43 base64url characters. */
export const Base64Url32BytesSchema = z
  .string()
  .regex(
    privatePattern(BASE64URL_32_BYTES_PATTERN),
    "Expected 32 bytes as 43 base64url characters",
  );

/** A raw Ed25519 public key as 64 lowercase hexadecimal characters. */
export const DevicePublicKeySchema = z
  .string()
  .regex(
    privatePattern(DEVICE_PUBLIC_KEY_PATTERN),
    "Expected a raw Ed25519 public key in hexadecimal",
  );

/** An Ed25519 signature as 86 base64url characters. */
export const DeviceSignatureSchema = z
  .string()
  .regex(
    privatePattern(DEVICE_SIGNATURE_PATTERN),
    "Expected an Ed25519 signature in base64url",
  );

/** A sign-in code (`mmdc_`). A credential: never log it or put it in a URL. */
export const SignInCodeSchema = z
  .string()
  .regex(privatePattern(SIGN_IN_CODE_PATTERN), "Expected a sign-in code");

/** An access token (`mmda_`). A credential: never log it or put it in a URL. */
export const AccessTokenSchema = z
  .string()
  .regex(privatePattern(ACCESS_TOKEN_PATTERN), "Expected an access token");

/** An invitation code (`mmdi_`). A credential: never log it or put it in a URL. */
export const InvitationCodeSchema = z
  .string()
  .regex(
    privatePattern(INVITATION_CODE_PATTERN),
    "Expected an invitation code",
  );

/** The GitHub account that claimed a person, with the time its login was last verified. */
export const MemberIdentitySchema = z.object({
  provider: IdentityProviderSchema,
  login: GitHubLoginSchema,
  verifiedAt: UtcTimestampSchema,
});
export type MemberIdentity = z.infer<typeof MemberIdentitySchema>;

/**
 * One person of a workspace. Inside a workspace a user is always shown
 * through their person row: the person's display name and the login of the
 * identity, also for a removed person, who is shown as a former member.
 * `userId` and `identity` are null until an account claims the person; the
 * identity is also null after the account's data was erased.
 */
export const WorkspaceMemberSchema = z
  .object({
    id: MemberIdSchema,
    workspaceId: WorkspaceIdSchema,
    displayName: displayText(LIMITS.displayName),
    role: MemberRoleSchema,
    userId: UserIdSchema.nullable(),
    identity: MemberIdentitySchema.nullable(),
    removedAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((member, ctx) => {
    if (member.userId === null && member.role !== "member") {
      ctx.addIssue({
        code: "custom",
        message: "An unclaimed person is a member",
        path: ["role"],
      });
    }
    if (member.userId === null && member.identity !== null) {
      ctx.addIssue({
        code: "custom",
        message: "An unclaimed person has no identity",
        path: ["identity"],
      });
    }
  });
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;

/** One of the person's own devices, as the device list shows it. */
export const DeviceListItemSchema = z.object({
  id: DeviceIdSchema,
  label: displayText(LIMITS.deviceLabel),
  platform: DevicePlatformSchema,
  createdAt: UtcTimestampSchema,
  /** null until the device first connects. */
  lastSeenAt: UtcTimestampSchema.nullable(),
  lastSignInAt: UtcTimestampSchema,
  /** 30 days after the last sign-in. */
  signInExpiresAt: UtcTimestampSchema,
  revokedAt: UtcTimestampSchema.nullable(),
  /** Whether this is the device that asks. */
  current: z.boolean(),
});
export type DeviceListItem = z.infer<typeof DeviceListItemSchema>;

/**
 * The body of every HTTP error answer (P-66). `error` and `message` are the
 * status text; `message` never contains an input value. Show the person the
 * text for `code`, never `message`.
 */
export const ApiErrorBodySchema = z.object({
  statusCode: z.int().min(400).max(599),
  error: z.string().max(100),
  message: z.string().max(100),
  code: ApiErrorCodeSchema,
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
