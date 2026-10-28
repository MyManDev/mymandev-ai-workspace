# @mymandev/database

The PostgreSQL baseline: the Drizzle schema of the M1 tables, the generated SQL migrations, a migration command, typed connection handling, and errors that never carry query data. The decisions behind it are recorded in [ADR 0011](../../docs/architecture/decisions/0011-drizzle-sql-migrations.md), [ADR 0012](../../docs/architecture/decisions/0012-pglite-database-tests.md), and [ADR 0013](../../docs/architecture/decisions/0013-m1-data-model.md).

No application uses this package yet. The cloud API imports its query functions and types from `@mymandev/database` with the first feature that stores data (M2).

## Scripts

| Script        | Runs                                                       |
| ------------- | ---------------------------------------------------------- |
| `db:generate` | `drizzle-kit generate`                                     |
| `db:check`    | `drizzle-kit check`                                        |
| `db:migrate`  | `node --env-file-if-exists=.env src/migrate-cli.ts`        |
| `db:compare`  | `node --env-file-if-exists=.env src/compare-schema-cli.ts` |
| `typecheck`   | `tsc -p tsconfig.json`                                     |
| `test`        | `node --test "src/**/*.test.ts"`                           |

Run them from the repository root with `-w @mymandev/database`, or from `packages/database`. The tests need no server: they run on PGlite, PostgreSQL 18 compiled to WebAssembly, inside the test process.

## Local PostgreSQL 18

Development and production use PostgreSQL 18. Install it natively, for example with the installer from postgresql.org on Windows, Postgres.app or Homebrew `postgresql@18` on macOS, or the PostgreSQL packages of your Linux distribution. Docker is not required.

### Roles

The database uses two roles:

- `mymandev_migrator` owns the database and the schema. Only `npm run db:migrate` connects as this role, through `DATABASE_MIGRATION_URL`.
- `mymandev_app` is the role of the application (from M2, through `DATABASE_URL`). It gets `CONNECT` on the database and `SELECT`, `INSERT`, and `UPDATE` on tables, and nothing else: no `DELETE` or `TRUNCATE`, because nothing is hard-deleted; no `CREATE` and no temporary tables; and no access to the `drizzle` schema that records the applied migrations.

PostgreSQL lets every role connect to a new database and create temporary tables in it. The script below removes these defaults, so apart from superusers only the two roles can connect.

Run this once per server in `psql` as a superuser. How to start `psql` as a superuser depends on the installation:

- Windows installer: `psql -U postgres`, with `C:\Program Files\PostgreSQL\18\bin` on `PATH`, or with the full path to `psql.exe` in that folder.
- macOS with Homebrew: `psql -d postgres`. Homebrew makes your macOS user the superuser; it creates no `postgres` role.
- macOS with Postgres.app: the bundled `/Applications/Postgres.app/Contents/Versions/latest/bin/psql -d postgres`, which connects as your macOS user.
- Linux distribution packages: `sudo -u postgres psql`. The default `pg_hba.conf` lets only the `postgres` operating system user connect as `postgres`.

Use real passwords from a password manager or secret store instead of `change-me`:

```sql
CREATE ROLE mymandev_migrator LOGIN PASSWORD 'change-me';
CREATE ROLE mymandev_app LOGIN PASSWORD 'change-me';
CREATE DATABASE mymandev OWNER mymandev_migrator;
REVOKE ALL ON DATABASE mymandev FROM PUBLIC;
GRANT CONNECT ON DATABASE mymandev TO mymandev_app;
\c mymandev
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE mymandev_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO mymandev_app;
```

The same privileges are tested on PGlite (`src/schema.test.ts`), where `ALTER DATABASE ... OWNER TO` replaces `CREATE DATABASE` and the roles have no passwords. The Database workflow (`.github/workflows/database.yml`) runs this script on a PostgreSQL 18 server in CI, applies the migrations twice, runs `db:compare`, and checks that the application role is refused everything listed above.

### Apply the migrations

Copy [`.env.example`](.env.example) to `packages/database/.env` and put the migration role's password into the URL. `.env` is ignored by Git; never commit it. The file works the same in PowerShell, `cmd.exe`, and Git Bash. A `DATABASE_MIGRATION_URL` set in the environment wins over the file.

```text
DATABASE_MIGRATION_URL=postgres://mymandev_migrator:<password>@127.0.0.1:5432/mymandev?sslmode=disable
```

Then, from the repository root:

```sh
npm run db:migrate -w @mymandev/database
```

The command prints "Migrations applied." and exits with 0. A second run applies nothing. Without a URL it prints "DATABASE_MIGRATION_URL is not set." and exits with 1; Node.js also prints ".env not found. Continuing without it." when the file does not exist.

### Connection URLs

`checkDatabaseUrl` checks every URL before it is used, and the URL is never printed, because it contains the password:

- The scheme is `postgres:` or `postgresql:`.
- `sslmode` is absent, `disable`, or `verify-full`. The pg driver treats `prefer`, `require`, and `verify-ca` differently from libpq, and `no-verify` skips certificate checks, so these values are rejected, and so is `uselibpqcompat`.
- With `NODE_ENV=production`, `sslmode=verify-full` is required.
- The URL is percent-encoded: no spaces, and every `%` starts an escape such as `%40`. Encode special characters in the password this way.
- No query parameter appears twice.

pg parses the URL again on its own. It takes the last value of a repeated parameter, and it re-encodes a URL with a space or a stray `%` before parsing it, so without the last two rules it could connect with other settings than the ones that were checked, for example `sslmode=verify-full&sslmode=disable`.

`createDatabase` creates a pg connection pool with a connection timeout of 5 seconds (pg waits forever by default), a statement timeout of 30 seconds (configurable per connection), and an idle-in-transaction timeout of 60 seconds. The two server timeouts are sent as session parameters; PGlite ignores them, so their effect is verified only on a real server.

### Smoke test without PostgreSQL

The production path (pg pool, advisory lock, node-postgres migrator) can be tried without installing PostgreSQL, with `pglite-server` from `@electric-sql/pglite-socket` run through `npx`. Use two terminals.

Terminal 1, from the repository root. npx lists the packages it would install and asks first; answer only after checking the list. Stop the server with Ctrl+C before you close the terminal; on Windows, the `node` process can otherwise keep listening. `netstat -ano | findstr 54329` (Windows) or `lsof -i :54329` (macOS, Linux) prints nothing once the port is free.

```sh
npx -p @electric-sql/pglite-socket@0.2.12 -p @electric-sql/pglite@0.5.9 pglite-server --port 54329
```

Terminal 2: set `DATABASE_MIGRATION_URL` in `packages/database/.env` to this line, then run the migration twice. If the file already holds the URL of your local PostgreSQL, keep a copy of that line first. Both runs print "Migrations applied." and exit with 0. Afterwards, put your previous line back, or delete the file if you created it only for this test.

```text
DATABASE_MIGRATION_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres?sslmode=disable
```

```sh
npm run db:migrate -w @mymandev/database
```

`pglite-server` binds to `127.0.0.1` and keeps its database in memory. Never add `@electric-sql/pglite-socket` to a `package.json`: its exact-version peers make npm install a second PGlite copy, which breaks `drizzle-orm/pglite`, and it resets pooled connections after a second error on the same connection.

## Migrations

- Migrations are generated from the schema in `src/schema/` and committed as SQL in `migrations/` together with `migrations/meta/`:

  ```sh
  npm run db:generate -w @mymandev/database -- --name <name>
  ```

- Always check that a new SQL file was written. drizzle-kit asks in the terminal about ambiguous changes such as renames. In a non-interactive shell it prints an error, writes nothing, and still exits with 0. Generate such migrations in an interactive terminal, or write them by hand with `drizzle-kit generate --custom`.
- A merged migration is never edited. Hand-written SQL goes into a `--custom` migration.
- Generated files are never reformatted. drizzle-kit writes SQL with tabs and without a final newline; the root `.editorconfig` keeps editors from changing `migrations/**`, and the root `.prettierignore` excludes `migrations/meta/`.
- `npm run db:check -w @mymandev/database` checks the migration folder for consistency. Running `db:generate` without changes prints "No schema changes, nothing to migrate".
- `src/migrations.test.ts` fails when the journal timestamps do not strictly increase, because the migrator silently skips a migration that is older than the last applied one. If it fails after merging `develop`, delete the branch's new migration and generate it again.
- The migrator runs all pending migrations in one transaction, so statements that cannot run in a transaction, such as `CREATE INDEX CONCURRENTLY`, are not possible. Vocabularies therefore use `text` with a CHECK constraint, not PostgreSQL enums.
- Migrations run as a separate deployment step, never when the API starts. Deployments install with `npm ci --omit=dev`; `db:migrate` needs only drizzle-orm and pg, so drizzle-kit and its build tools never reach a server.
- Destructive migrations are out of scope in M1.

## Rules for code in this package

- Use only the SQL-like core query builder: `select`, `insert`, `update`, `delete`, and joins. Do not use `relations()` or `db.query`, which Drizzle 1.0 replaces.
- Every query function runs its statements through `withDatabaseErrors`. A failed Drizzle query throws an error whose message and stack contain the SQL text and every parameter value; `withDatabaseErrors` replaces it with a `DatabaseError` that carries only the SQLSTATE `code` and the `constraint` name.
- Schema files import from `@mymandev/protocol` only with `import type` (ID brands and literal unions), so drizzle-kit loads them without running protocol code. ID columns carry the protocol brands, so a `DeviceId` cannot be written into a `UserId` column.
- CHECK vocabularies (capabilities, run states, platforms) are literal SQL. A test compares them with the protocol constants, so a change on one side fails until the other side follows.
- `updated_at` is set by `.$onUpdate(() => new Date())` on updates made through Drizzle. An update in raw SQL must set it itself.
- Foreign keys use `ON DELETE RESTRICT`; nothing is hard-deleted in M1. Ownership rules that span tables are composite foreign keys, listed in [ADR 0013](../../docs/architecture/decisions/0013-m1-data-model.md).
- Constraint errors carry the SQLSTATE: `23505` unique, `23514` check, `23503` missing parent, `23001` delete of a referenced row.

## Tests

`src/testing.ts` provides `createTestDatabase()`: a fresh database with every migration applied. By default it is an in-memory PGlite. It is not exported from the package yet; the export is added when another workspace first needs a test database (M2), and that workspace then declares `@electric-sql/pglite` with the identical exact version.

Each test file that needs a database creates one test database in `before` and closes it in `after`. Starting PGlite and applying the migrations takes a few seconds, and each instance uses a few hundred megabytes of memory. `node --test` runs test files in parallel processes, so keep database tests in few files.

With `DATABASE_TEST_URL` set, the same tests run on a PostgreSQL server: `createTestDatabase()` creates a database with a random name on that server, applies the migrations with the production migrator, connects through `createDatabase`, and drops the database again in `close()`. The URL's role must be allowed to create databases, so use a local or throwaway server, never a shared one. The Database workflow runs the tests this way on PostgreSQL 18. A test that runs only on a server checks the session timeouts of `createDatabase`; on PGlite it is skipped. The role test always uses its own PGlite instance; the Database workflow checks the same privileges on the server.

```sh
DATABASE_TEST_URL="postgres://postgres:<password>@127.0.0.1:5432/postgres?sslmode=disable" npm test -w @mymandev/database
```

The command above needs Git Bash on Windows; in PowerShell, set `$env:DATABASE_TEST_URL` first.

`db:compare` checks that the migrations create the same columns, constraints, indexes, and triggers on a PostgreSQL server as on PGlite. Run it after `db:migrate`; it reads `DATABASE_MIGRATION_URL` and needs the devDependencies. It always compares with PGlite, also when `DATABASE_TEST_URL` is set.

## Not included

API endpoints and query functions for these tables, the application connection (`DATABASE_URL`, M2), authentication, the permission check (M1-06), destructive migrations, and production database hosting.
