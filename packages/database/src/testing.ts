import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Database } from "./db.ts";
import { migrationsFolder } from "./migrate.ts";
import * as schema from "./schema/index.ts";

/**
 * In-process PostgreSQL (PGlite, WebAssembly) with every migration applied.
 * Tests only. Not exported from the package in M1-03; the export "./testing"
 * is added when another workspace first needs a test database (M2).
 */
export async function createTestDatabase(): Promise<{
  db: Database;
  client: PGlite;
  close: () => Promise<void>;
}> {
  const client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return { db, client, close: () => client.close() };
}
