# @mymandev/database

The PostgreSQL baseline: the Drizzle schema of the M1 tables and of the account, device key, membership, and audit tables, the SQL migrations, a migration command, typed connection handling, and errors that never carry query data. The decisions behind it are recorded in [ADR 0011](../../docs/architecture/decisions/0011-drizzle-sql-migrations.md), [ADR 0012](../../docs/architecture/decisions/0012-pglite-database-tests.md), [ADR 0013](../../docs/architecture/decisions/0013-m1-data-model.md), and [ADR 0014](../../docs/architecture/decisions/0014-accounts-devices-and-invitations.md).

No application uses this package yet. The cloud API imports its query functions and types from `@mymandev/database` with the first feature that stores data (M2).

## Scripts

| Script        | Runs                                                       |
| ------------- | ---------------------------------------------------------- |
| `db:generate` | `drizzle-kit generate`                                     |
| `db:check`    | `drizzle-kit check`                                        |
| `db:migrate`  | `node --env-file-if-exists=.env src/migrate-cli.ts`        |
| `db:compare`  | `node --env-file-if-exists=.env src/compare-schema-cli.ts` |
| `db:account`  | `node --env-file-if-exists=.env src/account-cli.ts`        |
| `typecheck`   | `tsc -p tsconfig.json`                                     |
| `test`        | `node --test --test-timeout=120000 "src/**/*.test.ts"`     |

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
- drizzle-kit adds the new constraints of a changed table after the foreign keys of new tables. A new composite foreign key whose target is a new unique constraint on an existing table therefore fails. Generate the unique constraint first, then the foreign key as a second migration, as `0003_account_tables` and `0004_account_tables_member_keys` do; both stay generated, and the pending migrations still run in one transaction.
- A destructive change starts with a hand-written `--custom` guard migration that stops with a clear message when the affected tables hold rows. Because all pending migrations run in one transaction, the guard also stops the migrations after it. `0002_account_tables_guard` stops the account tables migrations (ADR 0014) on a database with a row in `users`, `devices`, or `workspace_members`.

## Reset a local database

The account tables migrations (ADR 0014) need a database without users, devices, or workspace members: `devices` gains required key columns and `workspace_members` a new primary key, and neither has an honest default. No production database exists. On a local database that holds such rows, `db:migrate` stops with "The account tables migrations (0003, 0004) need a database without users, devices, or workspace members" and changes nothing. Drop and recreate the database, then migrate again.

In `psql` as a superuser, connected to the `postgres` database (see [Roles](#roles) for how to start it). The roles stay; only the database is replaced:

```sql
DROP DATABASE mymandev WITH (FORCE);
CREATE DATABASE mymandev OWNER mymandev_migrator;
REVOKE ALL ON DATABASE mymandev FROM PUBLIC;
GRANT CONNECT ON DATABASE mymandev TO mymandev_app;
\c mymandev
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE mymandev_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO mymandev_app;
```

`WITH (FORCE)` closes open connections to the database first. Then, from the repository root:

```sh
npm run db:migrate -w @mymandev/database
```

PGlite test databases and `pglite-server` keep their data in memory, so they need no reset.

## Rules for code in this package

- Use only the SQL-like core query builder: `select`, `insert`, `update`, `delete`, and joins. Do not use `relations()` or `db.query`, which Drizzle 1.0 replaces.
- Every query function runs its statements through `withDatabaseErrors`. A failed Drizzle query throws an error whose message and stack contain the SQL text and every parameter value; `withDatabaseErrors` replaces it with a `DatabaseError` that carries only the SQLSTATE `code` and the `constraint` name.
- Schema files import from `@mymandev/protocol` only with `import type` (ID brands and literal unions), so drizzle-kit loads them without running protocol code. ID columns carry the protocol brands, so a `DeviceId` cannot be written into a `UserId` column.
- CHECK vocabularies (capabilities, run states, platforms, roles, key algorithms, revocation reasons, join request decisions, identity providers) are literal SQL. A test compares them with the protocol constants, so a change on one side fails until the other side follows. The audit vocabularies, which only the server uses, are constants in this package (`AUDIT_ACTIONS`, `AUDIT_REASONS` in `src/audit-vocabulary.ts`), compared the same way.
- Public keys and SHA-256 hashes are lowercase hexadecimal `text` with the CHECK `^[0-9a-f]{64}$`. No table holds sign-in attempts, sign-in codes, or access tokens.
- `updated_at` is set by `.$onUpdate(() => new Date())` on updates made through Drizzle. An update in raw SQL must set it itself.
- Where a CHECK compares `created_at` with a time the application sets, as the invitation expiry does, the writer sets both from the same instant. The default `now()` is the start of the database transaction, not the application's clock. Durations in CHECKs use hours (`interval '168 hours'`), because adding days follows the session time zone and a day across a daylight saving change has 23 or 25 hours.
- Foreign keys use `ON DELETE RESTRICT`; nothing is hard-deleted. Ownership rules that span tables are composite foreign keys, listed in [ADR 0013](../../docs/architecture/decisions/0013-m1-data-model.md) and [ADR 0014](../../docs/architecture/decisions/0014-accounts-devices-and-invitations.md).
- Constraint errors carry the SQLSTATE: `23505` unique, `23514` check, `23503` missing parent, `23001` delete of a referenced row.

## Transactions

- `revokeDevice(db, input)` revokes a device in one transaction (ADR 0014, "Revocation, sign-out, and recovery"): it sets `revoked_at` and `revocation_reason`, disables the agents that the device hosts, revokes the active grants on the device with the account as `revoked_by_user_id` (ADR 0015, P-77), moves the unfinished runs of those agents to `cancelled` with the reason `device_revoked` (P-60), and writes a `device.revoked` audit record. Inside another transaction it runs as a savepoint, so a sign-in can revoke the replaced device in its own transaction. A device that does not exist, belongs to another account, or is already revoked is left unchanged and the result says `revoked: false`. The result lists the disabled agents, the revoked grants, and the cancelled runs, so that the caller can close the device's socket and send the run events after the commit.

- `recordGitHubRevocation(db, { subject, deliveryId, now })` records GitHub's revocation webhook in one transaction (ADR 0014, P-54): it finds the account whose GitHub identity has `subject`, the numeric sender ID as decimal text, never the login; writes a `github.authorization_revoked` audit record without an actor, with the account as the subject and `deliveryId` as `github_delivery_id`; locks the account's row with `FOR NO KEY UPDATE`, the lock of the API's sign-in, so the two serialize; and sets `users.sign_in_required_at` to the latest of its current value, `now`, and one millisecond after the `last_sign_in_at` of each of the account's devices that are not revoked, so that it never moves backward. Each device counts at most 60 seconds past `now`, so a last sign-in in the future, after a jump of the clock, cannot keep the account from signing in for longer. Every sign-in that committed before the revocation must therefore be repeated, whatever times the two requests took before their transactions (#115; a decision applied on 2026-11-01 under the Project Manager's rule to apply the recommended option). The devices stay registered. A delivery ID that is already recorded changes nothing (`changed: false`); the insert waits for a concurrent one with the same ID. A sender without an account, or whose identity was erased, gets the audit record without a subject and `userId: null`. The result also lists the account's devices that are not revoked, so that the API can drop their access tokens after it closes the account's sockets.

- `requireSignIn(db, { userId, now })` locks the account's row and sets `users.sign_in_required_at` in one transaction by the same rule, without an audit record, and returns the account's devices that are not revoked. The API calls it after a sign-in committed while the webhook recorded a revocation of its GitHub identity that the webhook's own lookup may have missed, such as for an account that the sign-in created (#115).

- `createWorkspace(db, { userId, deviceId, name, displayName, now })` creates a workspace in one transaction (ADR 0014, "People and roles" and "Limits"): it locks the account's row, so that concurrent creations of one account are counted one after another; counts the workspaces whose `created_by_user_id` is the account and whose `created_at` lies within 24 hours before `now`; and at 10 returns `created: false` with `retryAfterMs`, the time until the oldest of them leaves the window, without writing anything. Otherwise it inserts the workspace and the creator's person as the claimed `owner` named `displayName`, both with `created_at` set to `now`, writes a `workspace.created` audit record with the account and the device as the actor and the workspace as `workspace_id` and subject, and returns the workspace with the person as a `WorkspaceMembership` of the protocol. Inside another transaction it runs as a savepoint, so the API checks the actor in the same transaction first.

- `defineMember`, `renameMember`, and `removeMember` (`src/people.ts`) change the people of a workspace, each in one transaction (ADR 0014, "People and roles" and "Removal and ownership"). Each takes the acting account and its device, recorded as the actor of the audit record, the workspace, and `now`. Each first locks the acting account's active person and the target person `FOR NO KEY UPDATE` in one statement, in the order of their IDs, so that two changes of the same people wait for each other and cannot deadlock; PostgreSQL checks a row that changed while it waited again, so an actor removed in the meantime is not found. A refusal writes nothing and names its reason: `not_member` (the account is not an active member, also when the workspace does not exist), `not_found` (the workspace has no person with that ID), `forbidden`, or `conflict`. Inside another transaction each runs as a savepoint, so the API checks the actor in the same transaction first.
  - `defineMember(db, { workspaceId, userId, deviceId, displayName, now })` lets only the owner and admins define a person, unclaimed and with the role `member`, the account as `added_by_user_id`, and `created_at` set to `now`, and writes a `member.defined` audit record. It returns the person as the protocol's `WorkspaceMember`.
  - `renameMember(db, { workspaceId, memberId, userId, deviceId, displayName, now })` lets every active member rename their own person and the owner and admins rename an unclaimed person; another claimed person is `forbidden`, and a removed person is `conflict`. It writes a `member.renamed` audit record.
  - `removeMember(db, { workspaceId, memberId, userId, deviceId, now })` lets only the owner and admins remove an unclaimed person: it sets `removed_at` and `removed_by_user_id`, and revokes the person's live invitation, the one neither accepted nor revoked, with the account as `revoked_by_user_id`. An expired invitation that was never revoked counts as live, as in the unique index of one live invitation per person, and is revoked with `member_removed` too. It writes a `member.removed` audit record and, for a revoked invitation, an `invitation.revoked` record with the reason `member_removed`, and returns the revoked invitation's ID. A removed person is `conflict`, and so is a claimed person until #93.

Lock order: a transaction that changes the people of a workspace locks the account (`users`), then the device (`devices`), as `lockActor` in the API does, then the people (`workspace_members`) in the order of their IDs, then the invitations (`workspace_invitations`). Creating and revoking an invitation lock the person before the invitation as well, and creating one locks the workspace row (`workspaces`) after the people and before the invitations, for the counts of the workspace; accepting an invitation locks the invited person before it consumes the invitation and claims the person. So no two of these transactions wait for each other.

- `createInvitation` and `revokeInvitation` (`src/invitations.ts`) change the invitations of a workspace, each in one transaction (ADR 0014, "Invitations" and "Limits"). They take the same actor and give the same refusals as the people functions, and first lock the acting person and the invited person in the same way, so that every change of a person's invitations waits for every other change of that person. Inside another transaction each runs as a savepoint.
  - `createInvitation(db, { workspaceId, memberId, userId, deviceId, tokenHash, lifetimeSeconds, now })` lets only the owner and admins invite an unclaimed person; a claimed or removed person is `conflict`. After the people it locks the workspace row `FOR NO KEY UPDATE`, so that concurrent creations in one workspace are counted one after another, and returns `rate_limited` with `retryAfterMs`, without writing anything, when the workspace has 50 live invitations (neither accepted, revoked, nor expired at `now`), not counting the one of the invited person, or 100 whose `created_at` lies within 24 hours before `now`. `retryAfterMs` is the time until the live invitation that expires first expires, or until the oldest of the 24 hours leaves the window; the later of the two when both limits are reached. It revokes the person's invitation that is neither accepted nor revoked, also an expired one, with the account as `revoked_by_user_id` and an `invitation.revoked` audit record with the reason `replaced`; inserts the new invitation with `tokenHash`, the SHA-256 hash of the code that the caller made, so that the code never reaches the database, `created_at` set to `now`, and `expires_at` `lifetimeSeconds` later (7 days when omitted; outside 1 hour to 7 days the CHECK fails); and writes an `invitation.created` audit record. It returns the protocol's `Invitation`, whose creator is the acting person, and the ID of the invitation it replaced.
  - `revokeInvitation(db, { workspaceId, invitationId, userId, deviceId, now })` lets only the owner and admins revoke a live invitation: it sets `revoked_at` and `revoked_by_user_id` and writes an `invitation.revoked` audit record without a reason. An invitation that the workspace does not have is `not_found`; one that is accepted, revoked, or expired is `conflict`.

- `acceptInvitation(db, { tokenHash, userId, deviceId, now })` (`src/invitations.ts`) consumes an invitation code and claims its person in one transaction, at the connection's isolation level, PostgreSQL's default READ COMMITTED (ADR 0014, "Invitations"). It takes the SHA-256 hash of the code, never the code. It finds the invitation by the hash in whatever state; an unknown hash is `invitation_invalid`. An account that is already an active member of the invitation's workspace is `already_member` before anything is consumed. Then it locks the invitation's person `FOR NO KEY UPDATE`, which it read without a lock because the person of an invitation never changes; consumes the invitation with a conditional update, only if the hash matches and the invitation is neither accepted, nor revoked, nor expired at `now`, recording `accepted_at`, `accepted_by_user_id`, and `accepted_device_id`; and claims the person only if it is still unclaimed and not removed, with `claimed_at` set to `now`. When either update changes no row, the transaction rolls back and the result is `invitation_invalid` with the reason (`InvitationFailure`): `unknown`, `used`, `revoked`, `expired`, `member_removed`, or `member_claimed`; the last two happen only to data written outside these functions, because removing a person revokes its invitation and claiming one consumes it. A unique violation of `workspace_members_active_user_key`, when the account claimed another person of the workspace concurrently, rolls back too and is `already_member`. PostgreSQL checks a row that a concurrent transaction changed again before it updates it, so of two acceptances of one code only the first claims the person, and the second is `used`. A claim always takes the invited person, a new row, so an account that was removed rejoins as a new person and its earlier person stays. It writes an `invitation.accepted` and a `member.claimed` audit record with the account and the device as the actor, and returns the workspace with the claimed person as a `WorkspaceMembership`. Inside another transaction it runs as a savepoint, so the API checks the actor in the same transaction first. A refusal carries the invitation's ID, if the hash names one, so that the API can log it with the reason.

## Queries

Device authentication and the WebSocket gateway of the API use these (ADR 0014, "Device key and authentication" and "Revocation, sign-out, and recovery"; ADR 0006, identity binding):

- `deviceRow(db, deviceId)` reads a device with its current key and its account's state, a `DeviceAccessRow`: the account, the public key, `revoked_at`, `signed_out_at`, `last_sign_in_at`, and the account's `disabled_at` and `sign_in_required_at`. A device that does not exist gives `undefined`.
- `deviceRows(db, deviceIds)` reads the same rows for many devices, as a map by device ID, with one query per 500 IDs; the gateway's sweep re-checks every open connection with it. A device that does not exist is missing from the map.
- `isActiveMember(db, { workspaceId, userId })` says whether the account is an active member of the workspace: whether `activePersonOf` finds a claimed person whose `removed_at` is empty. A workspace that does not exist gives `false`.
- `markDeviceSeen(db, { deviceId, now })` sets `devices.last_seen_at`, when a connection authenticates.
- `markDevicesSeen(db, { deviceIds, now })` sets `devices.last_seen_at` of many devices whose connections are still open, with one update per 500 IDs. A revoked device is left unchanged. A device row that another transaction holds is skipped (`FOR NO KEY UPDATE SKIP LOCKED`): the update never waits for a locked row, so it cannot deadlock with a sign-in or a revocation.
- `writeConnectionAudit(db, { action, userId, deviceId, subjectId, now })` writes a `connection.replaced` or `event.identity_mismatch` audit record with the connection's account and device as the actor. It never writes `workspace_id`, which is a foreign key, because the workspace of a refused event is unverified; the event ID goes into `subject_id`.

The workspace routes of the API use these (ADR 0014, "People and roles" and "What a workspace ID allows"). They return the protocol's `WorkspaceMember` for each person: the identity is the account's GitHub identity, its `verifiedAt` is `user_identities.last_sign_in_at`, and it is null for an unclaimed person and after erasure.

- `activePersonOf(db, { workspaceId, userId })` returns the account's active person in the workspace, its ID and role, or `undefined` when the account is not an active member, also when the workspace does not exist, so that the API answers both alike.
- `listWorkspaces(db, userId)` returns the workspaces that the account is an active member of, each with the account's own person, the most recently claimed first, at most `MAX_ANSWER_LIST_ITEMS`.
- `workspaceView(db, { workspaceId, now })` returns the workspace, all its people including former members, `join_requests_paused_at`, and the ownership offer while it is younger than 7 days at `now`, or `undefined` when the workspace does not exist. The caller checks membership first. The people are cut to `MAX_ANSWER_LIST_ITEMS` in an order that keeps the active owner and the target of the offer and in which unclaimed people never push out claimed ones: active people first, the owner, then the target, then the other claimed people, then the unclaimed people, each the most recently created first; then former members, the most recently removed first. ADR 0014 sets no limit on the people that the owner and admins define, so an admin could otherwise define 1,000 unclaimed people and push every claimed member out of the view (applied on 2026-11-01 under the Project Manager's rule; a limit per workspace stays open for the Project Manager).
- `listInvitations(db, { workspaceId, userId, now })` returns the live invitations of the workspace, those neither accepted, revoked, nor expired at `now`, as the protocol's `Invitation`, the most recently created first, at most `MAX_ANSWER_LIST_ITEMS`. Only the owner and admins: a member is `forbidden`, and an account that is not an active member is `not_member`. The table records the creator's account; `createdByMemberId` is that account's active person in the workspace, which it has because removing a person or demoting an admin revokes the invitations they created (#93), and otherwise its most recently removed person. No code and no hash leaves the database.
- `previewInvitation(db, { tokenHash, userId, now })` returns what an invitation code claims, without consuming it or writing anything: the workspace's name, the display name of the person, the inviter, and the expiry, as the protocol's `PreviewInvitationResponse`. The inviter is the person of the invitation's creator in the workspace, its active person or else its most recently removed one, as in `listInvitations`, with the GitHub login and the time it was last verified. It decides as `acceptInvitation` does: `already_member` first, for an active member of the invitation's workspace in whatever state the invitation is, and otherwise `invitation_invalid` with the same reasons, and `inviter_unknown` when the creator has no person or no GitHub identity in the workspace. `acceptInvitation` needs no inviter and still takes such a code; the API README records why this is deliberate.

## Operator commands

An operator disables or enables an account with the application role in `DATABASE_URL`:

```sh
npm run db:account -w @mymandev/database -- disable <user ID>
npm run db:account -w @mymandev/database -- enable <user ID>
```

- `disableAccount` sets `users.disabled_at`, so every authentication of the account fails, and revokes in the same transaction the active grants of the agents that the account owns, with the account as `revoked_by_user_id` (ADR 0014; ADR 0015, P-77 and P-78).
- `enableAccount` clears it. No grant is restored; the person grants again what their agents need.
- Both write an audit record (`account.disabled`, `account.enabled`) without an actor, and change nothing when the account does not exist or is already in that state.

## Tests

`src/testing.ts` provides `createTestDatabase()`: a fresh database with every migration applied. By default it is an in-memory PGlite. Other workspaces import it from `@mymandev/database/testing`, in tests only. A workspace that does so declares `@electric-sql/pglite` as a `devDependency` with the identical exact version as this package, because a nested PGlite copy breaks `drizzle-orm/pglite`.

Each test file that needs a database creates one test database in `before` and closes it in `after`. Starting PGlite and applying the migrations takes a few seconds, and each instance uses a few hundred megabytes of memory. `node --test` runs test files in parallel processes, so keep database tests in few files.

With `DATABASE_TEST_URL` set, the same tests run on a PostgreSQL server: `createTestDatabase()` creates a database with a random name on that server, applies the migrations with the production migrator, connects through `createDatabase`, and drops the database again in `close()`. The URL's role must be allowed to create databases, so use a local or throwaway server, never a shared one. The Database workflow runs the tests this way on PostgreSQL 18. Some tests run only on a server, because PGlite has a single session: they check the session timeouts of `createDatabase`, that `markDevicesSeen` skips a row that another transaction holds, and concurrent transactions, such as creations of workspaces or invitations at their limits, a removal that waits for a claim, and acceptances of one code, or of a code and a removal, that run at the same time. On PGlite they are skipped. The role test always uses its own PGlite instance; the Database workflow checks the same privileges on the server.

```sh
DATABASE_TEST_URL="postgres://postgres:<password>@127.0.0.1:5432/postgres?sslmode=disable" npm test -w @mymandev/database
```

The command above needs Git Bash on Windows; in PowerShell, set `$env:DATABASE_TEST_URL` first.

`db:compare` checks that the migrations create the same columns, constraints, indexes, and triggers on a PostgreSQL server as on PGlite. Run it after `db:migrate`; it reads `DATABASE_MIGRATION_URL` and needs the devDependencies. It always compares with PGlite, also when `DATABASE_TEST_URL` is set.

## Not included

API endpoints and query functions for these tables (each API issue of ADR 0014, #87 to #93, adds its own), the application connection (`DATABASE_URL`, M2), authentication, the permission check (M1-06), a purge job for old rows (P-62), and production database hosting.
