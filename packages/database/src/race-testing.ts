import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "./client.ts";
import type { Database } from "./db.ts";
import type { TestDatabase } from "./testing.ts";

// Helpers for the tests of concurrent transactions, which run only on a
// PostgreSQL server (`DATABASE_TEST_URL`), because PGlite has a single
// session. Tests only; the package does not export them.

/** The options of a test that needs a server. */
export const SERVER_ONLY = Object.freeze({
  skip:
    process.env["DATABASE_TEST_URL"] === undefined &&
    "needs DATABASE_TEST_URL; PGlite has a single session",
});

/** Whether a session of the test database waits for a lock. */
export async function waitsForLock(
  testDatabase: TestDatabase,
): Promise<boolean> {
  const { rows } = await testDatabase.client.query<{ waiting: number }>(
    "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
  );
  return (rows[0]?.waiting ?? 0) > 0;
}

/**
 * What the sessions of the test database that wait for a lock wait for: the
 * table of the row, through the tuple lock that a session holds or waits for
 * while it waits for the transaction that holds the row, or else the kind of
 * lock, such as `transactionid` for an entry of a unique index. The sessions
 * are chosen by their database in `pg_stat_activity`, because a
 * `transactionid` lock has no database in `pg_locks`.
 */
export async function lockWaits(testDatabase: TestDatabase): Promise<string[]> {
  const { rows } = await testDatabase.client.query<{ waitedOn: string }>(
    `select distinct coalesce(c.relname, w.locktype) as "waitedOn"
       from pg_locks w
       left join pg_locks t on t.pid = w.pid and t.locktype = 'tuple'
       left join pg_class c on c.oid = t.relation
      where not w.granted
        and w.pid in (
          select pid from pg_stat_activity where datname = current_database()
        )`,
  );
  return rows.map((row) => row.waitedOn).sort();
}

/**
 * Runs `first` in a transaction of a second session and keeps it open while
 * `action` starts in this session. Returns the action's result after the
 * held transaction committed, and what the action waited for (`lockWaits`),
 * empty when it did not wait.
 */
export async function whileHeld<T>(
  testDatabase: TestDatabase | undefined,
  first: (tx: Database) => Promise<unknown>,
  action: () => Promise<T>,
): Promise<Readonly<{ result: T; waitedOn: readonly string[] }>> {
  assert.ok(testDatabase, "the test database is created in before()");
  const { url } = testDatabase;
  assert.ok(url, "the test database is on a server");
  const other = createDatabase(url, { max: 1 });
  const holding = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held = other.db.transaction(async (tx) => {
    await first(tx);
    holding.resolve();
    await release.promise;
  });
  try {
    await Promise.race([
      holding.promise,
      held.then(() => {
        throw new Error("the held transaction ended early");
      }),
    ]);
    const running = action();
    let settled = false;
    running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let waited = false;
    while (!settled && !waited) {
      waited = await waitsForLock(testDatabase);
      if (!waited) {
        await delay(10);
      }
    }
    // The action waits until the held transaction is released.
    const waitedOn = waited ? await lockWaits(testDatabase) : [];
    release.resolve();
    await held;
    return { result: await running, waitedOn };
  } finally {
    release.resolve();
    await held.catch(() => undefined);
    await other.close();
  }
}
