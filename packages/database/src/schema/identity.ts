import type { DeviceId, DevicePlatform, UserId } from "@mymandev/protocol";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, nullableTimestamp, updatedAt } from "./columns.ts";

/** A person. No handle, email or credentials until the account model is decided (#15). */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().$type<UserId>(),
    displayName: text("display_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "users_display_name_length",
      sql`char_length(${t.displayName}) between 1 and 64`,
    ),
  ],
);

/** One desktop installation, owned by exactly one user. The server issues the ID. */
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
    createdAt: createdAt(),
    lastSeenAt: nullableTimestamp("last_seen_at"),
    revokedAt: nullableTimestamp("revoked_at"),
  },
  (t) => [
    index("devices_user_id_idx").on(t.userId),
    // Target of composite foreign keys that require a device of a given user.
    unique("devices_id_user_id_key").on(t.id, t.userId),
    check(
      "devices_label_length",
      sql`char_length(${t.label}) between 1 and 64`,
    ),
    check(
      "devices_platform_check",
      sql`${t.platform} in ('windows', 'macos', 'linux')`,
    ),
  ],
);
