import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { checkDatabaseUrl, createDatabase } from "./client.ts";
import { DatabaseError, withDatabaseErrors } from "./errors.ts";
import { createTestDatabase } from "./testing.ts";

test(
  "createDatabase sends the session timeouts to the server",
  {
    skip:
      process.env["DATABASE_TEST_URL"] === undefined &&
      "needs DATABASE_TEST_URL; PGlite ignores session timeouts",
  },
  async () => {
    const testDatabase = await createTestDatabase();
    assert.ok(testDatabase.url, "the test database is on a server");
    const connection = createDatabase(testDatabase.url, {
      max: 1,
      statementTimeoutMs: 200,
    });
    try {
      const settings = await connection.db.execute<{
        statement: string;
        idle: string;
      }>(
        sql`select current_setting('statement_timeout') as statement, current_setting('idle_in_transaction_session_timeout') as idle`,
      );
      assert.deepEqual(
        { ...settings.rows[0] },
        { statement: "200ms", idle: "1min" },
      );

      // 57014: query_canceled, raised when the statement timeout expires.
      await assert.rejects(
        withDatabaseErrors(() =>
          connection.db.execute(sql`select pg_sleep(2)`),
        ),
        (error: unknown) =>
          error instanceof DatabaseError && error.code === "57014",
      );
    } finally {
      await connection.close();
      await testDatabase.close();
    }
  },
);

test("checkDatabaseUrl accepts only safe TLS modes and never repeats the URL", () => {
  const password = "Sup3r-Secret-Passw0rd";
  const base = `postgres://mymandev_migrator:${password}@db.internal.example:5432/mymandev`;
  const messages: string[] = [];
  function check(url: string, production: boolean): string | undefined {
    const problem = checkDatabaseUrl(url, production);
    if (problem !== undefined) {
      messages.push(problem);
    }
    return problem;
  }

  // Accepted outside production: no sslmode, disable and verify-full, with either scheme.
  for (const url of [
    base,
    `${base}?sslmode=disable`,
    `${base}?sslmode=verify-full`,
    base.replace("postgres:", "postgresql:"),
  ]) {
    assert.equal(check(url, false), undefined, url);
  }

  // pg handles these differently from libpq, or skips certificate checks.
  for (const mode of ["bogus", "require", "prefer", "verify-ca", "no-verify"]) {
    assert.equal(
      check(`${base}?sslmode=${mode}`, false),
      "sslmode must be disable or verify-full",
    );
  }
  assert.equal(
    check(`${base}?sslmode=verify-full&uselibpqcompat=true`, false),
    "must not set uselibpqcompat",
  );
  for (const url of [
    base.replace("postgres:", "mysql:"),
    base.replace("postgres:", "https:"),
  ]) {
    assert.equal(
      check(url, false),
      "must use the postgres: or postgresql: scheme",
    );
  }
  assert.equal(check(`no scheme ${password}`, false), "is not a valid URL");

  // pg takes the last value of a repeated parameter, so a URL could pass with
  // its first sslmode and connect with a weaker one.
  for (const [url, production] of [
    [`${base}?sslmode=disable&sslmode=no-verify`, false],
    [
      `${base}?sslmode=verify-full&application_name=a&application_name=b`,
      false,
    ],
    [`${base}?sslmode=verify-full&sslmode=no-verify`, true],
    [`${base}?sslmode=verify-full&sslmode=disable`, true],
  ] as const) {
    assert.equal(
      check(url, production),
      "must not repeat a query parameter",
      url,
    );
  }

  // pg re-encodes a URL with a space or a stray "%" before parsing it, and then
  // reads "ssl%6Dode" as an unknown parameter instead of sslmode.
  for (const [url, production] of [
    [`${base}?application_name=100%`, false],
    [`${base}?ssl%6Dode=verify-full&application_name=a b`, true],
  ] as const) {
    assert.equal(
      check(url, production),
      "must be percent-encoded, without spaces or stray % signs",
      url,
    );
  }

  // Production requires verify-full.
  for (const url of [base, `${base}?sslmode=disable`]) {
    assert.equal(
      check(url, true),
      "sslmode=verify-full is required in production",
    );
  }
  for (const url of [
    `${base}?sslmode=verify-full`,
    `${base}?sslmode=verify-full&application_name=a%20b`,
  ]) {
    assert.equal(check(url, true), undefined, url);
  }

  assert.equal(messages.length, 17);
  for (const message of messages) {
    assert.equal(message.includes(password), false);
    assert.equal(message.includes("db.internal.example"), false);
  }
});
