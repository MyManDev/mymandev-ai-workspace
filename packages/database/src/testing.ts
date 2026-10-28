import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import { checkDatabaseUrl, createDatabase } from "./client.ts";
import type { Database } from "./db.ts";
import { migrationsFolder, runMigrations } from "./migrate.ts";
import * as schema from "./schema/index.ts";

/** Runs SQL on the test database without Drizzle. */
export type TestClient = {
  query<Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
};

export type TestDatabase = {
  readonly db: Database;
  readonly client: TestClient;
  /** The URL of the test database on a server; undefined for PGlite. */
  readonly url: string | undefined;
  readonly close: () => Promise<void>;
};

/**
 * A fresh database with every migration applied. Tests only. Not exported from
 * the package yet; the export "./testing" is added when another workspace
 * first needs a test database (M2).
 *
 * With DATABASE_TEST_URL set, the database is created on that PostgreSQL
 * server and dropped by close(); the URL's role must be allowed to create
 * databases. Otherwise it is an in-memory PGlite.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const url = process.env["DATABASE_TEST_URL"];
  return url ? createServerDatabase(url) : createPgliteDatabase();
}

/** In-process PostgreSQL (PGlite, WebAssembly) with every migration applied. */
export async function createPgliteDatabase(): Promise<TestDatabase> {
  const client = await PGlite.create();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder });
  return { db, client, url: undefined, close: () => client.close() };
}

async function createServerDatabase(serverUrl: string): Promise<TestDatabase> {
  const problem = checkDatabaseUrl(serverUrl, false);
  if (problem !== undefined) {
    throw new Error(`DATABASE_TEST_URL ${problem}.`);
  }
  // node --test runs test files in parallel, so each file gets its own database.
  const name = `mymandev_test_${randomBytes(8).toString("hex")}`;
  await administer(serverUrl, `create database ${name}`);

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const migrator = createDatabase(url.href, { max: 1 });
  try {
    await runMigrations(migrator.db);
  } finally {
    await migrator.close();
  }

  // The tests use the production connection; raw SQL gets a small pool of its own.
  const connection = createDatabase(url.href);
  const raw = new pg.Pool({
    connectionString: url.href,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
  return {
    db: connection.db,
    client: {
      query: async <Row>(text: string, params?: unknown[]) => ({
        rows: (await raw.query(text, params)).rows as Row[],
      }),
    },
    url: url.href,
    close: async () => {
      await Promise.all([connection.close(), raw.end()]);
      await administer(serverUrl, `drop database ${name} with (force)`);
    },
  };
}

/** Runs one statement on the server's maintenance connection. */
async function administer(serverUrl: string, statement: string): Promise<void> {
  const client = new pg.Client({
    connectionString: serverUrl,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}
