# ADR 0011: Drizzle ORM with generated SQL migrations

- Status: Proposed
- Date: 2026-10-27
- Decided by: (filled in by the Project Manager on acceptance)

## Context

M1-03 needs a database package, migrations, and the initial entities (#21). There is no Docker and no local PostgreSQL in the current environment. [ADR 0001](0001-internal-packages-export-typescript-source.md) requires TypeScript that Node.js runs without a build. Types must stay in sync with the schema without a running database.

## Options considered

| Option                                    | Result                                                                                                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drizzle ORM 0.45 + drizzle-kit 0.31       | The TypeScript schema is the single source for row types and migrations. `drizzle-kit generate` writes reviewable SQL. First-party PGlite and node-postgres drivers and migrators read the same folder. The runtime dependencies are pure JavaScript. |
| Kysely                                    | The most SQL-transparent, but the database types are maintained by hand or generated from a live database, and there is no first-party PGlite dialect.                                                                                                |
| Prisma 7                                  | 137 packages and 264 MB; downloads a native `schema-engine-windows.exe` on install; a separate schema language; its `latest` tag points to a release candidate of the next major version.                                                             |
| node-pg-migrate                           | Plain SQL migrations with an advisory lock, but only a runner: it needs a second library for typed queries and a wire connection, so it cannot use in-process PGlite.                                                                                 |
| Driver: pg (node-postgres) or postgres.js | pg is supported by every option, has an explicit pool size, and is pure JavaScript. postgres.js has a slower release pace and less first-party support.                                                                                               |

## Decision

Drizzle ORM, drizzle-kit, and the pg driver, with these guardrails:

1. Migrations are generated with `npm run db:generate -w @mymandev/database -- --name <name>` and committed as SQL plus `migrations/meta/`. `migrations/meta/` is in the root `.prettierignore`, because drizzle-kit rewrites those JSON files in its own format.
2. A test fails when the journal `when` values do not strictly increase. The drizzle-orm 0.45 migrator silently skips a migration that is older than the last applied one. After merging `develop` into a branch with a new migration, regenerate the migration if the test fails.
3. `runMigrations` takes a session-level `pg_advisory_lock` on a pool with `max: 1`, because the drizzle-orm migrator takes no lock.
4. Migrations run as a separate step (`npm run db:migrate -w @mymandev/database` with `DATABASE_MIGRATION_URL`), never on API startup. The script is `node --env-file-if-exists=.env src/migrate-cli.ts`, so a developer on Windows puts the URL into `packages/database/.env` instead of setting it inline; a variable set in the environment still wins over the file.
5. drizzle-kit needs an interactive terminal for ambiguous changes such as renames. In a non-interactive shell it prints an error, writes nothing, and exits with 0. A human generates such migrations in a terminal, or writes them with `drizzle-kit generate --custom`, and always checks that a file was written.
6. A merged migration is never edited. Hand-written SQL goes into `--custom` migrations.
7. Only the SQL-like core query builder is used (`select`, `insert`, `update`, `delete`, joins). Not `relations()` or `db.query`, which Drizzle 1.0 replaces.
8. `@electric-sql/pglite-socket` is never added to a `package.json`. It reset pooled pg connections after a second error on the same connection, and its exact-version peers made npm nest a second PGlite, which broke `drizzle-orm/pglite`. It is used only ad hoc through `npx` ([ADR 0012](0012-pglite-database-tests.md)).
9. Schema files import from `@mymandev/protocol` only with `import type` (brands and literal unions). CHECK vocabularies are literal SQL, and a test compares them with the protocol constants.
10. `updated_at` is maintained in the data layer with `.$onUpdate(() => new Date())`. A database trigger is the alternative (P-31).
11. The upgrade to Drizzle 1.0 is planned when it is generally available (`drizzle-kit up` converts the folder; 1.0 removes the journal and adds commutativity checks).
12. Errors never carry query data out of the package. A failed Drizzle query throws an error whose message and stack contain the SQL and every parameter value, and whose cause repeats key values in `detail`. Every query function runs its statements through `withDatabaseErrors`, which throws a `DatabaseError` with only the SQLSTATE `code` and the `constraint` name. The API's log serializer redacts such errors as a second line of defense ([ADR 0009](0009-fastify-cloud-api.md)).
13. Two database roles. `mymandev_migrator` owns the database and the schema and is used only by `db:migrate` through `DATABASE_MIGRATION_URL`. `mymandev_app` gets `CONNECT` on the database and `SELECT`, `INSERT`, and `UPDATE` on tables through default privileges, and nothing else: no `DELETE` or `TRUNCATE` (nothing is hard-deleted), no `CREATE`, no temporary tables, and no access to the `drizzle` migration schema. The setup revokes the default `CONNECT` and `TEMPORARY` privileges of `PUBLIC` on the database. The application connects with `DATABASE_URL` from M2. The setup SQL is in [`packages/database/README.md`](../../../packages/database/README.md). It is verified on PGlite, not yet on a real PostgreSQL 18 server.
14. Connection URLs are checked before use and never printed. The scheme must be `postgres:` or `postgresql:`. `sslmode` may be absent, `disable`, or `verify-full`; pg treats `prefer`, `require`, and `verify-ca` differently from libpq, and `no-verify` skips certificate checks, so those are rejected, and so is `uselibpqcompat`. With `NODE_ENV=production`, `sslmode=verify-full` is required. pg parses the URL again on its own: it takes the last value of a repeated parameter, and it re-encodes a URL that contains a space or a stray `%` before parsing it. A URL that repeats a query parameter or is not fully percent-encoded is therefore rejected, so that pg reads the values that were checked.
15. Timeouts. `createDatabase` sets a connection timeout of 5 seconds (pg waits forever by default), a statement timeout of 30 seconds (overridable per connection), and an idle-in-transaction timeout of 60 seconds. PGlite ignores the two server parameters, so their effect is verified only on a real server (P-32).
16. Editors must not rewrite generated migrations. The root `.editorconfig` has a section that switches off the final-newline, whitespace-trimming, and indentation rules for `packages/database/migrations/**`, because drizzle-kit writes tabs and no final newline and a merged migration is never edited.

Data access lives in `packages/database`. `apps/api` does not use drizzle-orm directly; it will import query functions and types from `@mymandev/database` in M2.

## Consequences

- `npm audit` reports 4 moderate findings, all from deprecated `@esbuild-kit/*` dependencies of drizzle-kit, which pull in an old esbuild (GHSA-67mh-4wv8-2f99, which concerns the esbuild development server). They are development-only; `npm audit --omit=dev` reports 0. `npm audit fix --force` would downgrade drizzle-kit to a much older release and must not be run. A future audit gate needs an exception or Drizzle 1.0 (P-30).
- drizzle-kit brings tsx and three esbuild copies (through `@esbuild-kit/core-utils`, directly, and through tsx). Each esbuild runs a `postinstall` script and ships a native binary. tsx also brings fsevents 2.3.3 as an optional dependency, which npm installs only on macOS and which runs an install script there. These four are the only packages with install scripts in the whole M1 dependency set (`"hasInstallScript": true` in `package-lock.json`). `tsx`, `esbuild`, and `drizzle-kit` appear in `node_modules/.bin`. tsx is not a direct dependency and must not be used in scripts.
- Deployment installs with `npm ci --omit=dev`. `db:migrate` uses only the drizzle-orm migrator and pg, so drizzle-kit, tsx, and esbuild never reach a server.
- The runtime stack (drizzle-orm, pg) is pure JavaScript.
- Generated SQL uses tabs and has no final newline. Prettier does not check SQL, the `.editorconfig` section keeps editors from changing it, and generated files are not edited by hand.
- Every future query function must use `withDatabaseErrors`; review checks for direct `db.` calls that bypass it.
- The migrator runs all pending migrations in one transaction. Statements that cannot run in a transaction (for example `CREATE INDEX CONCURRENTLY`) are not possible, so vocabularies use `text` with CHECK constraints instead of PostgreSQL enums.

## Dependency policy

- drizzle-orm 0.45 and pg 8, exact pins, as `dependencies` of `@mymandev/database`. Drizzle is below 1.0, so every minor upgrade is reviewed like a major one.
- drizzle-kit 0.31, `@types/pg` 8, and `@types/node` for Node.js 24, exact pins, as `devDependencies`. Check the install-script inventory on every drizzle-kit update (P-30). The lockfile covers every platform: list the entries with `"hasInstallScript": true` in `package-lock.json`. `npm query ":attr(scripts, [postinstall]), :attr(scripts, [install]), :attr(scripts, [preinstall])"` shows only the packages installed on the current platform, so it does not list fsevents on Windows or Linux.
- Not declared: pg-native, `@electric-sql/pglite-socket`, tsx.
- Exact versions live in [`packages/database/package.json`](../../../packages/database/package.json) and `package-lock.json`.

## Evidence

- [`packages/database/drizzle.config.ts`](../../../packages/database/drizzle.config.ts), [`src/migrate.ts`](../../../packages/database/src/migrate.ts) (`runMigrations`, `migrationsFolder`), [`src/migrate-cli.ts`](../../../packages/database/src/migrate-cli.ts), [`src/client.ts`](../../../packages/database/src/client.ts) (`checkDatabaseUrl`, `createDatabase`), [`src/errors.ts`](../../../packages/database/src/errors.ts) (`DatabaseError`, `toDatabaseError`, `withDatabaseErrors`), and the generated [`migrations/`](../../../packages/database/migrations/).
- [`src/migrations.test.ts`](../../../packages/database/src/migrations.test.ts): the journal order.
- [`src/client.test.ts`](../../../packages/database/src/client.test.ts): the accepted and rejected `sslmode` values, `uselibpqcompat`, the scheme, repeated query parameters, URLs that are not fully percent-encoded, `verify-full` in production, and messages without the password or host.
- [`src/schema.test.ts`](../../../packages/database/src/schema.test.ts): a duplicate insert whose row contains a secret (the raw error contains it; the `DatabaseError` message, stack, and JSON do not), and the two roles (the application role can insert and update; delete, truncate, create table, create temporary table, drop table, and reading the migration journal fail with 42501).
- M1-03 acceptance checks: `db:check` and a second `db:generate` report no drift; `db:migrate` against `pglite-server` applies the migration and a second run applies nothing; without a URL it exits with 1; `npm query` lists exactly the three esbuild copies on Windows, and the lockfile lists them and fsevents (macOS only).
- Usage: [`packages/database/README.md`](../../../packages/database/README.md).
- Review record: M1 Technical Decision Set, revision 2 of 2026-10-27 (ADR 0011, Sections 2.2, 2.3, and 2.5), linked from the M1-03 pull request.

## Needs Project Manager decision

- Drizzle 0.45 stable with the guardrails, or start on the 1.0 release candidate (P-28, recommended: 0.45).
- Migrations as a separate deployment step, not on API startup (P-29, recommended: deployment step).
- Accept the 4 moderate development-only audit findings from drizzle-kit, and the install scripts of its three esbuild copies and of fsevents on macOS (P-30, recommended: accept; never run `npm audit fix --force`; check the install-script inventory in every M1-03 update).
- `updated_at` in the data layer or by a trigger (P-31, recommended: data layer).
- Two database roles, `DATABASE_MIGRATION_URL` for migrations, `sslmode=verify-full` required in production, and the pool timeouts (P-47, recommended: accept).
