import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDatabaseUrl } from "./client.ts";

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

  // Production requires verify-full.
  for (const url of [base, `${base}?sslmode=disable`]) {
    assert.equal(
      check(url, true),
      "sslmode=verify-full is required in production",
    );
  }
  assert.equal(check(`${base}?sslmode=verify-full`, true), undefined);

  assert.equal(messages.length, 11);
  for (const message of messages) {
    assert.equal(message.includes(password), false);
    assert.equal(message.includes("db.internal.example"), false);
  }
});
