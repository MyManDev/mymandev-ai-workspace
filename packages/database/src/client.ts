import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.ts";

/** A node-postgres connection pool with Drizzle on top. */
export type DatabaseConnection = {
  readonly db: NodePgDatabase<typeof schema>;
  /** Ends every connection of the pool. */
  readonly close: () => Promise<void>;
};

const ALLOWED_SSL_MODES = new Set(["disable", "verify-full"]);

/**
 * Checks a connection URL without ever printing it (it contains the password).
 * Returns a problem description, or undefined when the URL is acceptable.
 * pg treats prefer, require and verify-ca differently from libpq, and no-verify
 * disables certificate checks, so only disable and verify-full are accepted.
 */
export function checkDatabaseUrl(
  url: string,
  production: boolean,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "is not a valid URL";
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return "must use the postgres: or postgresql: scheme";
  }
  if (parsed.searchParams.has("uselibpqcompat")) {
    return "must not set uselibpqcompat";
  }
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode !== null && !ALLOWED_SSL_MODES.has(sslmode)) {
    return "sslmode must be disable or verify-full";
  }
  if (production && sslmode !== "verify-full") {
    return "sslmode=verify-full is required in production";
  }
  return undefined;
}

/**
 * Creates a connection pool. Check the URL with checkDatabaseUrl first.
 * pg waits forever for a connection by default, so the pool sets a connection
 * timeout; the statement and idle-in-transaction timeouts are sent to the
 * server as session parameters.
 */
export function createDatabase(
  connectionString: string,
  options: { readonly max?: number; readonly statementTimeoutMs?: number } = {},
): DatabaseConnection {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  return { db: drizzle({ client: pool, schema }), close: () => pool.end() };
}
