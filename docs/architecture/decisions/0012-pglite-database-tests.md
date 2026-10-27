# ADR 0012: Database tests run on in-process PGlite

- Status: Proposed
- Date: 2026-10-27
- Decided by: (filled in by the Project Manager on acceptance)

## Context

Tests must run on every developer machine and in CI on Windows, macOS, and Linux, without Docker and without a local PostgreSQL server. Issue #21 also asks for documented local PostgreSQL setup and for migrations that create the full schema on an empty PostgreSQL database.

## Options considered

- In-process PGlite with `drizzle-orm/pglite` (recommended): real PostgreSQL 18 compiled to WebAssembly, no native code.
- PGlite over TCP with `@electric-sql/pglite-socket` as a dependency: rejected ([ADR 0011](0011-drizzle-sql-migrations.md), guardrail 8).
- A real PostgreSQL server in tests: requires Docker or a local installation; planned later as a CI service container.

## Decision

- `packages/database/src/testing.ts` contains `createTestDatabase()`: a fresh in-memory PGlite with every migration applied. M1-03 does not export it; the package's own tests import `./testing.ts` directly. The export `"./testing"` is added in M2, when the API first needs a test database, together with the rule that a consumer declares `@electric-sql/pglite` as a `devDependency` at the identical exact version (a nested PGlite breaks `drizzle-orm/pglite`).
- One PGlite instance per test file, created in `before` and closed in `after`. M1-03 keeps the PGlite-backed tests in one file; the role test inside it creates and closes a second instance of its own. The journal and URL tests need no database.
- The production path (pg pool, advisory lock, node-postgres migrator) is smoke-tested by hand with `pglite-server` through `npx`, not in the test suite.
- `packages/database/README.md` documents local development with a real PostgreSQL 18 (installed natively, the two roles from [ADR 0011](0011-drizzle-sql-migrations.md), `DATABASE_MIGRATION_URL` in `packages/database/.env`, `npm run db:migrate -w @mymandev/database`) and the smoke test without an installation.
- A CI job against a real PostgreSQL 18 service container is a follow-up once the CI workflow exists (P-33).

## Consequences

- PGlite startup and migration take a few seconds per test file, and each instance uses roughly 300 MB of memory or more. `node --test` runs files in parallel processes, so many PGlite test files multiply memory.
- PGlite is a single connection: locking, concurrency, and pooling behave differently from a server.
- The PGlite release in use inherits the host time zone; later releases default to UTC. Typed timestamp columns return `Date` objects, so tests are not affected.
- Constraint errors carry the SQLSTATE on the cause of the Drizzle error: `23505` unique, `23514` check, `23503` missing parent on insert, `23001` restrict on delete.
- On Windows, the `pglite-server` node process can keep listening after the shell that started it has ended. Stop it with Ctrl+C before closing the terminal, and check that the port is free, for example with `netstat -ano | findstr 54329`, which then prints nothing.
- `pglite-server` ignores the pg session parameters `statement_timeout` and `idle_in_transaction_session_timeout`.

## Dependency policy

- `@electric-sql/pglite` 0.5, exact pin, as a `devDependency` of `@mymandev/database` only. One hoisted copy: `npm ls @electric-sql/pglite` shows a single version, and the lockfile key is `node_modules/@electric-sql/pglite`, not nested.
- Ad hoc only, never declared: `@electric-sql/pglite-socket` with the exact `@electric-sql/pglite` version it requires as a peer, run through `npx` without `-y`. pglite-socket also requires seven PGlite extension packages as exact peers; npx installs them into its cache, outside the lockfile and `npm audit`, so npx lists them and asks before installing. `pglite-server` binds to `127.0.0.1` by default.
- Upgrade PGlite and pglite-socket together, once the new release is at least two weeks old.

## Evidence

- [`packages/database/src/testing.ts`](../../../packages/database/src/testing.ts) (`createTestDatabase`) and [`src/db.ts`](../../../packages/database/src/db.ts) (`Database`, which fits both node-postgres and PGlite).
- [`src/schema.test.ts`](../../../packages/database/src/schema.test.ts): one PGlite instance for the file; the test database reports PostgreSQL 18; the role test uses its own instance.
- M1-03 acceptance check: the two-terminal `pglite-server` smoke test applied the migration ("Migrations applied.", exit 0) and a second run applied nothing; the server reported PostgreSQL 18.6 and 11 tables.
- Usage: [`packages/database/README.md`](../../../packages/database/README.md).
- Review record: M1 Technical Decision Set, revision 2 of 2026-10-27 (ADR 0012, Sections 2.2, 2.4, and 2.5), linked from the M1-03 pull request.

## Needs Project Manager decision

- Accept PGlite (PostgreSQL 18) as the M1-03 evidence that migrations create the full schema on an empty PostgreSQL database, or require one run against a real PostgreSQL 18 server before merge (P-32, recommended: one real PostgreSQL 18 run before merge if anyone has it; otherwise accept PGlite and add the CI job).
- Add a CI job with a real PostgreSQL 18 service container once CI exists (P-33, recommended: a follow-up after PR #46).
