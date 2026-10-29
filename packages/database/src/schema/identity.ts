import type {
  DeviceId,
  DeviceKeyAlgorithm,
  DevicePlatform,
  DeviceRevocationReason,
  IdentityProvider,
  UserId,
} from "@mymandev/protocol";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, nullableTimestamp, updatedAt } from "./columns.ts";

/**
 * A person's account (ADR 0014). It is identified by a sign-in identity in
 * `user_identities`, never by a handle, an email or a password.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().$type<UserId>(),
    displayName: text("display_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** An operator disabled the account; every authentication fails. */
    disabledAt: nullableTimestamp("disabled_at"),
    /** Every device whose last sign-in is earlier must sign in again. */
    signInRequiredAt: nullableTimestamp("sign_in_required_at"),
    /** New device registrations are refused until then (after a lost device). */
    deviceRegistrationLockedUntil: nullableTimestamp(
      "device_registration_locked_until",
    ),
  },
  (t) => [
    check(
      "users_display_name_length",
      sql`char_length(${t.displayName}) between 1 and 64`,
    ),
  ],
);

/**
 * How an account signs in: for GitHub, the numeric account ID. The column is
 * `identity_provider` because `provider` already means an AI provider. Erasing
 * a person's data clears `subject`, `login` and `account_created_at` and sets
 * `erased_at`; no synthetic subject is written, so an erased account never
 * matches a sign-in (P-62).
 */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    identityProvider: text("identity_provider")
      .notNull()
      .$type<IdentityProvider>(),
    /** The provider's immutable account ID; for GitHub the numeric ID as decimal text. */
    subject: text("subject"),
    /** Display only; a GitHub login can change and be reused. */
    login: text("login"),
    accountCreatedAt: nullableTimestamp("account_created_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastSignInAt: nullableTimestamp("last_sign_in_at").notNull(),
    erasedAt: nullableTimestamp("erased_at"),
  },
  (t) => [
    uniqueIndex("user_identities_identity_provider_subject_key")
      .on(t.identityProvider, t.subject)
      .where(sql`${t.subject} is not null`),
    unique("user_identities_user_id_identity_provider_key").on(
      t.userId,
      t.identityProvider,
    ),
    check(
      "user_identities_identity_provider_check",
      sql`${t.identityProvider} in ('github')`,
    ),
    // subject, login and account_created_at are empty exactly when erased_at is set.
    check(
      "user_identities_erasure_check",
      sql`(${t.erasedAt} is null) = (${t.subject} is not null) and (${t.erasedAt} is null) = (${t.login} is not null) and (${t.erasedAt} is null) = (${t.accountCreatedAt} is not null)`,
    ),
    check(
      "user_identities_github_subject_check",
      sql`${t.identityProvider} <> 'github' or ${t.subject} ~ '^[1-9][0-9]{0,18}$'`,
    ),
    check(
      "user_identities_github_login_check",
      sql`${t.identityProvider} <> 'github' or ${t.login} ~ '^[A-Za-z0-9_-]{1,39}$'`,
    ),
  ],
);

/**
 * One desktop installation, owned by exactly one user. The server issues the
 * ID and stores only the public key of the device's key pair (P-52).
 */
export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().$type<DeviceId>(),
    userId: uuid("user_id")
      .notNull()
      .$type<UserId>()
      .references(() => users.id, { onDelete: "restrict" }),
    label: text("label").notNull(),
    platform: text("platform").notNull().$type<DevicePlatform>(),
    /** Lowercase hexadecimal; replaced at every GitHub sign-in. */
    publicKey: text("public_key").notNull(),
    keyAlgorithm: text("key_algorithm").notNull().$type<DeviceKeyAlgorithm>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastSeenAt: nullableTimestamp("last_seen_at"),
    lastSignInAt: nullableTimestamp("last_sign_in_at").notNull(),
    signedOutAt: nullableTimestamp("signed_out_at"),
    revokedAt: nullableTimestamp("revoked_at"),
    revocationReason: text("revocation_reason").$type<DeviceRevocationReason>(),
  },
  (t) => [
    index("devices_user_id_idx").on(t.userId),
    // Target of composite foreign keys that require a device of a given user.
    unique("devices_id_user_id_key").on(t.id, t.userId),
    unique("devices_public_key_key").on(t.publicKey),
    check(
      "devices_label_length",
      sql`char_length(${t.label}) between 1 and 64`,
    ),
    check(
      "devices_platform_check",
      sql`${t.platform} in ('windows', 'macos', 'linux')`,
    ),
    check("devices_key_algorithm_check", sql`${t.keyAlgorithm} in ('ed25519')`),
    // An Ed25519 public key is 32 bytes: 64 lowercase hexadecimal characters.
    check(
      "devices_public_key_check",
      sql`${t.keyAlgorithm} <> 'ed25519' or ${t.publicKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "devices_revocation_reason_check",
      sql`${t.revocationReason} in ('removed', 'lost', 'replaced', 'account_erased')`,
    ),
    check(
      "devices_revocation_check",
      sql`(${t.revokedAt} is null) = (${t.revocationReason} is null)`,
    ),
  ],
);
