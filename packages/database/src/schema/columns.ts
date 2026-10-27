import { timestamp } from "drizzle-orm/pg-core";

// Shared column definitions. Every timestamp is `timestamptz` and is read as a
// JavaScript Date.

/** `created_at timestamptz DEFAULT now() NOT NULL`. */
export function createdAt() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

/**
 * `updated_at timestamptz DEFAULT now() NOT NULL`, set by the data layer on
 * every update made through Drizzle, not by a database trigger (P-31).
 */
export function updatedAt() {
  return timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
}

/** A nullable `timestamptz`, for example a lifecycle column such as `archived_at`. */
export function nullableTimestamp<TName extends string>(name: TName) {
  return timestamp(name, { withTimezone: true });
}
