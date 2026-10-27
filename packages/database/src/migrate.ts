import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type * as schema from "./schema/index.ts";

/** The folder with the generated SQL migrations and their journal. */
export const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

const MIGRATION_LOCK_KEY = 726_001;

/**
 * Applies pending migrations under a session-level advisory lock, because the
 * drizzle-orm migrator takes no lock. The caller must pass a pool with max: 1,
 * so the lock and the migration use the same session.
 */
export async function runMigrations(
  db: NodePgDatabase<typeof schema>,
): Promise<void> {
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
  }
}
