# M1 Technical Decision Set

- Status: Review record. The Project Manager answered the decisions in Section 6 on 2026-10-28. The answers are recorded in ADRs 0001 to 0013 in [`docs/architecture/decisions`](../decisions/README.md), which are authoritative. Where an ADR or the code differs from this document, for example after review fixes in the pull requests, the ADR and the code apply.
- Date: 2026-10-27
- Revision: 2. A security review and a maintainability review were applied; Appendix C lists every point and how it was resolved. Section 2.5 lists the experiments that verify the changed snippets.
- Scope: M1-01 Protocol v0 (#19), M1-02 Cloud API skeleton (#20), M1-03 PostgreSQL baseline (#21).
- Related: M1-06 capability and permission contract (#24); M0-03 desktop shell (#3); the open decisions on workspace invitations and join flow (#14), the authentication and account model (#15) and permission enforcement placement (#18); the CI check workflow (PR #46).
- Environment for every verification below: Windows 11, Node.js 24.15.0, npm 11.12.1, TypeScript 6.0.3. No Docker and no local PostgreSQL.

How to read this document:

1. Section 1 lists the decisions and shows how they fit together.
2. Section 2 lists the evidence: the first integration run of all three workspaces (2.2) and the revision 2 experiments (2.5).
3. Section 3 contains the ADRs 0001 to 0013, each with Status: Proposed.
4. Section 4 is the implementation plan for the three stacked pull requests.
5. Section 5 covers risks and conflicts with the parallel desktop work.
6. Section 6 is the consolidated list of Project Manager decisions.
7. Appendix A lists exact versions. Appendix B shows how to reproduce the checks. Appendix C resolves the review points.

Shell commands in this document use POSIX syntax. Commands that set a variable inline (`NAME=value command`) or use `rm -rf` or `( ... )` need Git Bash on Windows; they do not work in PowerShell or `cmd.exe`.

## 1. Decisions at a glance

| ADR  | Decision                                                                                                                                                                                                                                                                   | Lands in | Shared boundary        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------- |
| 0001 | Internal workspace packages export TypeScript source. No build step, no `dist`, no project references.                                                                                                                                                                     | M1-01    | Yes (desktop)          |
| 0002 | `node:test` in every Node-side workspace. The root `test` script delegates to workspaces. Vitest only inside a bundled workspace, never at root.                                                                                                                           | M1-01    | Yes (root scripts)     |
| 0003 | zod 4.6.7 (classic API) is the only runtime validation library. Every workspace that uses it pins the same exact version.                                                                                                                                                  | M1-01    | Yes                    |
| 0004 | IDs are lowercase UUIDv7, stored as PostgreSQL `uuid`, typed as zod brands. The protocol package owns ID generation. The server owns entity IDs.                                                                                                                           | M1-01    | Yes                    |
| 0005 | Workspace 1:N Project. Membership grants visibility, never a capability. A workspace ID is not a join secret.                                                                                                                                                              | M1-01    | Yes                    |
| 0006 | Event envelope v0 with staged decoding, `protocolVersion: 0` (same-version-only), unknown fields stripped, one event type. Events from devices go through `decodeClientEvent` and stay `UnverifiedEvent` until the server binds them to the authenticated connection (M2). | M1-01    | Yes                    |
| 0007 | Agent run lifecycle: six states, a fixed transition table, three terminal states, a retry is a new run. The server creates runs; devices report later transitions only.                                                                                                    | M1-01    | Yes                    |
| 0008 | Capability vocabulary: a closed set of six, exact match only. Defined in `@mymandev/protocol`; M1-06 imports it and owns every grant check.                                                                                                                                | M1-01    | Yes (M1-06)            |
| 0009 | Fastify 5.12.7 with @fastify/websocket 11.3.4 and hardened defaults: generic error bodies, no query strings in logs, WebSocket Origin check, loopback-only bind. No Fastify type provider in M1-02.                                                                        | M1-02    | No                     |
| 0010 | API configuration from environment variables through zod, run by Node type stripping, no build step, graceful shutdown.                                                                                                                                                    | M1-02    | No                     |
| 0011 | Drizzle ORM 0.45.4 and drizzle-kit 0.31.11 with generated SQL migrations, pg 8.23.1 as driver, plus guardrails, a migration role separate from the application role, and errors without query data.                                                                        | M1-03    | No                     |
| 0012 | Database tests run on in-process PGlite 0.5.9 (PostgreSQL 18.6 compiled to WebAssembly). No Docker required.                                                                                                                                                               | M1-03    | No                     |
| 0013 | M1 data model conventions and the M1-03 table set, with composite foreign keys that keep owners, devices and projects consistent, and a per-conversation message sequence.                                                                                                 | M1-03    | Yes (entities and IDs) |

### 1.1 How the decisions fit together

- One package strategy. All three workspaces use the same `tsconfig.json` flags (`allowImportingTsExtensions`, `noEmit`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `module`/`moduleResolution` `nodenext`, `target`/`lib` `es2025`). The protocol source is checked a second time with `types: []` and `lib: ["es2024"]`, the level the renderer is expected to support (P-02). Node, `tsc`, `node --test` and drizzle-kit all load `@mymandev/protocol` from its TypeScript source through the npm workspace link. Verified together in one monorepo.
- One trust model. Every event a device sends is decoded with `decodeClientEvent` and typed `UnverifiedEvent`. Only the server's identity binding (M2) may turn it into an event that is relayed or stored. The database repeats the ownership rules as composite foreign keys, so an inconsistent row is rejected even if a server check is missing.
- One validation library. zod validates wire data in the protocol package, WebSocket frames in the API (through the protocol's `decodeClientEvent`) and API configuration. npm installs one hoisted zod copy because protocol and API pin the same version (`npm ls zod` shows `deduped`). Fastify keeps its internal Ajv only for the JSON Schema that Fastify routes declare (the `/health` response in M1-02). There is no second schema library such as TypeBox.
- One test runner. `node --test "src/**/*.test.ts"` runs the TypeScript tests in all three workspaces directly. The root `test` script delegates. The database tests use in-process PGlite, so no test needs a server, Docker or network.
- One ID model. The protocol defines branded ID types and the lowercase UUIDv7 pattern and generates IDs. The database stores them as `uuid` columns typed with the same brands (`.$type<UserId>()`), so assigning a `DeviceId` to a `UserId` column is a compile error (verified).
- One vocabulary source. `CAPABILITIES`, `RUN_STATES` and `DEVICE_PLATFORMS` live in `packages/protocol/src/model.ts`. The database CHECK constraints are literal SQL, and a test proves they equal the protocol constants exactly.
- An acyclic dependency graph: `apps/api` depends on `packages/protocol`, and `packages/database` depends on `packages/protocol`. `apps/api` does not depend on `packages/database` in M1; that link comes with the first API feature that stores data (M2).

```text
apps/api ───────────────► packages/protocol ◄─────────────── packages/database
(fastify, ws, zod)        (zod, uuid)                        (drizzle-orm, pg)
                               ▲
apps/desktop (M0-03) ──────────┘  (later: renderer and main import the protocol)
```

## 2. Evidence

### 2.1 Inputs

This decision set combines four research reports, each based on experiments in scratch directories that have since been deleted:

1. Internal package strategy and test runner (source exports, `dist`, project references, custom conditions; `node:test` and Vitest).
2. Protocol v0 model and validation library (zod, zod/mini, valibot, TypeBox, arktype, types-only).
3. API stack (Fastify, Hono, Express, NestJS), configuration, shutdown and inject-based tests.
4. Database stack (Drizzle, Kysely, Prisma, node-pg-migrate; pg and postgres.js; PGlite and pglite-socket).

The reports disagreed in three places. This document resolves them as follows:

| Conflict                                                                                                                                                   | Resolution                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation library: the protocol report recommends zod; the API report recommends TypeBox because it fits Fastify.                                         | zod everywhere. TypeBox does not strip unknown keys, its `Clean()` is slow on unions, it has no brands and no Standard Schema, and choosing it for the API alone would mean two schema libraries for the same wire data. M1-02 needs no Fastify type provider (ADR 0003, ADR 0009). |
| `rewriteRelativeImportExtensions` or `allowImportingTsExtensions` in consumer tsconfigs.                                                                   | `allowImportingTsExtensions` with `noEmit` in every workspace. It is the flag a bundler consumer (desktop renderer) also needs, and no M1 workspace emits JavaScript (ADR 0001).                                                                                                    |
| Agent run state names and message IDs: the database report used placeholder names (`waiting_for_permission`, `succeeded`) and client-supplied message IDs. | The database uses the protocol's six states. The server generates every entity ID; device retries are made idempotent by a separate `client_event_id` column (ADR 0004, ADR 0013).                                                                                                  |

### 2.2 Integration run of all three workspaces

All three workspaces were built together in one scratch monorepo copied from the repository baseline: root `package.json`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.mjs`, `.npmrc`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `.editorconfig` and `.gitattributes`. The root scripts were changed exactly as proposed in Section 4. The workspaces contained the full protocol v0 package, the API skeleton and the complete M1-03 schema with 11 tables, in the revision 1 form; the ADR snippets are excerpts of that code. The directory was deleted afterwards, and the repository worktree was not modified.

This run cannot be reproduced from this document alone: the snippets are excerpts ("// ...", "condensed") and the sources were deleted. The test counts below are what that run reported. Revision 2 changes several snippets; those changes were verified separately (Section 2.5), and Section 4 lists the revised tests with the counts each pull request must report.

| Check                   | Command                                                                                                                                                        | Result                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install                 | `npm install` (engine-strict, save-exact)                                                                                                                      | Passed. One hoisted zod 4.6.7 (`deduped`) and one hoisted `@electric-sql/pglite` 0.5.9 (lockfile key `node_modules/@electric-sql/pglite`).                                    |
| Full repository gate    | `npm run check` (format:check, lint, typecheck, test)                                                                                                          | Exit 0 in 22 s.                                                                                                                                                               |
| Type checks             | root `tsc -p tsconfig.json`, then each workspace, including the protocol's `tsconfig.src.json` with `types: []`                                                | Exit 0 in all four programs.                                                                                                                                                  |
| Tests                   | `npm test`                                                                                                                                                     | protocol 9/9, api 14/14, database 9/9 (32 tests). The revision 1 plan in Section 4.4 said "10" for the database; the run reported 9, and the per-file split was not recorded. |
| Clean checkout          | delete every `node_modules`, `npm ci`, `npm run typecheck`, `npm test`                                                                                         | 203 packages installed; typecheck exit 0; 32/32 tests pass.                                                                                                                   |
| Migration generation    | `npm run db:generate -- --name init` with stdin from `/dev/null` (no TTY)                                                                                      | 11 tables in one SQL file, exit 0. Schema files that `import type` from `@mymandev/protocol` loaded fine.                                                                     |
| Drift                   | `npm run db:check`; then `npm run db:generate` again                                                                                                           | "Everything's fine"; "No schema changes, nothing to migrate".                                                                                                                 |
| Migrations over TCP     | `npx -y -p @electric-sql/pglite-socket@0.2.12 -p @electric-sql/pglite@0.5.9 pglite-server --port 54329 --include-database-url --run "node src/migrate-cli.ts"` | "Migrations applied." and "Command exited with code 0": the production path (pg Pool, advisory lock, node-postgres migrator) works.                                           |
| Missing configuration   | `node src/migrate-cli.ts` without `DATABASE_URL`                                                                                                               | "DATABASE_URL is not set.", exit 1.                                                                                                                                           |
| Real HTTP and WebSocket | `API_PORT=3917 node src/server.ts`; `curl /health`; `curl /x`; Node's built-in `WebSocket` client sends `{"protocolVersion":0}`                                | `{"status":"ok","version":"0.0.0"}`; generic 404; close code 1008 with reason `malformed`. Logs are pino JSON.                                                                |
| Fail-fast configuration | `API_PORT=0x50 API_LOG_LEVEL=loud NODE_ENV=staging node src/server.ts`                                                                                         | Three lines naming `NODE_ENV`, `API_PORT` and `API_LOG_LEVEL`, without the values; exit 1.                                                                                    |
| Strict CSP simulation   | `node --disallow-code-generation-from-strings` with `enableJitlessValidation()`                                                                                | Decoding works with eval blocked.                                                                                                                                             |
| Renderer bundle         | esbuild 0.25.12 `--bundle --minify --format=esm --platform=browser` of `decodeEvent` + `newId`                                                                 | 95.0 KB minified, 28.7 KB gzip, no `node:` imports.                                                                                                                           |
| Supply chain            | `npm audit --omit=dev`; `npm audit`; `npm audit signatures`                                                                                                    | 0 production vulnerabilities; 4 moderate dev-only findings (drizzle-kit, see ADR 0011); 200 packages with verified registry signatures.                                       |

The rows "Migrations over TCP" and "Missing configuration" used the revision 1 migration CLI (`DATABASE_URL`, `npx -y ... --run`). Revision 2 replaces the variable with `DATABASE_MIGRATION_URL` and the command with the two-terminal procedure (ADR 0011, ADR 0012); Section 2.5 has the new results.

### 2.3 Findings from the integration run that the research did not have

1. Fastify 5.12.7 types the `setErrorHandler` error parameter as `unknown`. Reading `error.statusCode` fails with TS18046, so the handler narrows the value first (ADR 0009 snippet).
2. `ON DELETE RESTRICT` raises SQLSTATE `23001` (restrict_violation), not `23503`. Inserting a row whose parent does not exist raises `23503`. Tests must assert the right code.
3. Invisible characters. While the experiment was prepared, a file-writing tool turned the escape sequences for U+202E in a regular expression and a test string into the literal characters. Prettier, ESLint and `tsc` all passed with literal bidirectional control characters in the source. Source code must write these characters as `\u` escapes, and review must look for them; GitHub shows a warning for bidirectional text in diffs. A repository-wide check is proposed as a follow-up (Section 6, P-39). It happened twice more while revision 2 was written: in the experiment's text pattern and test strings, and in the scan command of Section 4.2 in this document. A scan with `/[\p{Cf}\p{Co}\p{DI}\p{Zl}\p{Zp}]/u` found both; the files were rewritten with escapes and the experiment was run again (17/17 pass).
4. drizzle-kit 0.31.11 loads schema files that contain `import type` from `@mymandev/protocol`, because type-only imports are erased. Database columns can therefore carry protocol brands with `.$type<UserId>()`. A `// @ts-expect-error` test proves that assigning a `DeviceId` to a `UserId` column is rejected by `tsc`.
5. `pg_get_constraintdef` gives the CHECK definition, so a test can compare each database vocabulary with the protocol constant exactly, in both directions.
6. `pglite-server --run` kept listening after its command finished on Windows. Stop it with Ctrl+C.
7. zod issue messages do not contain the input value. A test sets every configuration variable to a secret-looking value and asserts that neither the message nor the serialized error contains it.
8. Node 24's global `WebSocket` client is enough for manual smoke tests; no extra dependency is needed.

Revision 2 added these findings (Section 2.5 has the evidence):

9. `app.injectWS()` from @fastify/websocket 11.3.4 never settles unless `await app.ready()` ran first. Gateway tests call it before the first `injectWS`.
10. @fastify/websocket keeps emitting `message` events for frames that arrived in the same read after the handler called `socket.close()`. Without a `readyState` guard, 50 valid events sent after an invalid frame all reached `onEvent`.
11. A failed Drizzle query throws an error whose `message` and `stack` contain the SQL and every parameter value (own keys `query`, `params`, `cause`). Logging such an error leaks whatever the row contained.
12. PGlite over pglite-server ignores the pg startup parameters `statement_timeout` and `idle_in_transaction_session_timeout` (`SHOW` returns `0`). The connection still works; the effect on a real PostgreSQL server is unverified.
13. The first proposed text pattern still accepted Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and U+034F, which are invisible but neither control nor format characters. Excluding the Unicode property `Default_Ignorable_Code_Point` closes this.

### 2.4 Not verified

- A real PostgreSQL server. All database evidence comes from PGlite 0.5.9 (PostgreSQL 18.6), both in-process and over TCP through the pg driver. This includes the two-role setup (verified with `SET ROLE` inside PGlite, without passwords or `CREATE DATABASE`) and the pg pool timeouts (PGlite ignores them).
- Linux and macOS. The CI workflow from PR #46 will be the first run there, and only for pull requests that target `develop` or `main` (Section 4.1).
- The Electron main and preload processes consuming the protocol package, and Vite with this zod-based protocol. The research verified Vite 8.3.4 with a smaller source-exported package; this run verified an esbuild browser bundle.
- The Origin header an Electron renderer sends. The M1-02 Origin check accepts only `http` and `https` origins in `API_ALLOWED_ORIGINS`; a renderer loaded from `file://` or a custom scheme has the origin `null` and would be rejected (P-02).
- Real SIGTERM delivery on Linux. On Windows, shutdown was exercised through SIGINT.
- `fastify-type-provider-zod` 7.0.0 in this exact stack. The research verified it on its own (typecheck and requests under TS 6.0.3).
- The `.editorconfig` value `unset` in the VS Code EditorConfig extension (Section 4.4). It is part of the EditorConfig specification but was not tried in an editor.

### 2.5 Revision 2 experiments

A flat scratch project (deleted afterwards) installed the exact M1 dependency set (Appendix A) and contained the revised protocol, API and database code in the form shown in the ADR snippets. Results on Windows 11, Node 24.15.0, TypeScript 6.0.3:

| Check                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc -p tsconfig.json` (all code, es2025 + node types)                       | Exit 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tsc -p tsconfig.src.json` (protocol source, `types: []`, `lib: ["es2024"]`) | Exit 0. A probe file using `new Set(a).union(b)` and `Iterator.from(xs).take(1).toArray()` failed with TS2550 and TS2693, exit 2.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `node --test "src/**/*.test.ts"`                                             | 17 tests, 17 pass: protocol 6, API 5, database 6. Final run with every invisible character in the sources written as an escape (Section 2.3, finding 3). These are experiment tests; the pull requests add the larger sets listed in Section 4.                                                                                                                                                                                                                                                                                                                |
| Text pattern                                                                 | Accepts Latin, Turkish, Arabic, Persian with ZWNJ, Devanagari with ZWJ, CJK, a ZWJ family emoji, a skin tone, VS16, a regional-indicator flag and a keycap. Rejects U+200B, U+2060, U+FEFF, U+2028, U+2029, U+00AD, tag characters, a lone surrogate, U+206A, U+FFF9, U+E000, U+3164, U+115F, U+FFA0, U+034F, U+180E, U+202E, U+061C, U+200E, U+2066, C0 and C1 controls, whitespace-only and empty text, and the England subdivision flag (trade-off). The exported JSON Schema contains the pattern, and all 11 exported patterns compile with the `u` flag. |
| `decodeEvent` and `decodeClientEvent`                                        | Server-created run (`system`, `deviceId: null`, `null -> queued`) decodes with `decodeEvent`; a `user` actor or another agent's ID returns `invalid_actor`; `decodeClientEvent` returns `not_allowed_from_device` for a `system` actor, a `null` device and `previousState: null`.                                                                                                                                                                                                                                                                             |
| uuid 14.0.3 counter                                                          | For 50 pairs generated in the same millisecond, the second ID's 32-bit counter was exactly the first plus one.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Error handler on Fastify 5.12.7                                              | Errors thrown with `statusCode` 200, 302, 0 and 500 and the message `SECRET db password=hunter2` returned `{"statusCode":500,"error":"Internal Server Error","message":"Internal Server Error"}`; 404 returned `"message":"Not Found"`. Fastify's own messages stayed: 400 `body/n must be integer`, 413 `Request body is too large`, and a `__proto__` body returned 400 with a fixed message.                                                                                                                                                                |
| Logs                                                                         | Requests to `/health?token=SECRET_URL_TOKEN_1`, `/nope?token=...` and a failing route produced no log line containing the token; the request line shows `"url":"/nope"`.                                                                                                                                                                                                                                                                                                                                                                                       |
| WebSocket after close                                                        | An invalid frame followed by 50 valid events in the same tick: close 1007 `invalid_json`, 0 events delivered. Control run without the `readyState` guard: 50 delivered.                                                                                                                                                                                                                                                                                                                                                                                        |
| Origin check                                                                 | `Origin: https://evil.example` failed with "Unexpected server response: 403"; the listed origin and a request without an Origin header connected. Over real HTTP on port 3917, the `curl` upgrade request from Section 4.3 got `HTTP/1.1 403 Forbidden` with the Origin header and `HTTP/1.1 101 Switching Protocols` without it.                                                                                                                                                                                                                              |
| Configuration                                                                | `API_HOST` `0.0.0.0`, `::`, `192.168.1.10` and `example.com` rejected (message `API_HOST: Invalid option: expected one of "127.0.0.1"\|"::1"\|"localhost"`); `::1` accepted. `API_ALLOWED_ORIGINS` accepted `https://app.example, http://localhost:5173` and rejected a trailing slash, a path, `file://`, `null`, `*` and `app://desktop`.                                                                                                                                                                                                                    |
| drizzle-kit 0.31.11                                                          | Generated 11 tables with the composite unique keys and composite foreign keys as named constraints; `drizzle-kit check` "Everything's fine"; a second `generate` "No schema changes".                                                                                                                                                                                                                                                                                                                                                                          |
| Composite foreign keys on PGlite                                             | 8 inconsistent rows rejected with 23503: agent of Alice on Bob's device; grant on a repository of another project; grant recorded in the wrong project; grant to Bob's agent by Alice (P-44); Alice's message from Bob's device; Bob's agent's message from Alice's device; run recorded in the wrong project; run on a repository of another project. Consistent rows with null optional columns were accepted.                                                                                                                                               |
| Message sequence                                                             | Allocation through `conversations.last_seq` in a transaction gave 1, 2 in one conversation and 1 in another; a duplicate (`conversation_id`, `seq`) failed with 23505.                                                                                                                                                                                                                                                                                                                                                                                         |
| Grant expiry                                                                 | `expires_at` before `created_at` failed with 23514.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Database errors                                                              | A duplicate insert whose row contained `SECRET_TOKEN_MATERIAL`: the raw Drizzle error message contained it (own keys `query`, `params`, `cause`); `toDatabaseError` gave `Database operation failed (code 23505, constraint messages_sender_device_client_event_key)`, and neither its message, stack and JSON nor the API log serializer output for the raw error contained the secret.                                                                                                                                                                       |
| Roles on PGlite                                                              | After `ALTER DATABASE ... OWNER TO mymandev_migrator`, `REVOKE CREATE ON SCHEMA public FROM PUBLIC` and default privileges, migrations ran as the migrator (tables owned by it). As `mymandev_app`: INSERT and UPDATE worked; DELETE, TRUNCATE, CREATE TABLE, DROP TABLE and reading `drizzle.__drizzle_migrations` failed with 42501.                                                                                                                                                                                                                         |
| Migration CLI over TCP                                                       | pglite-server 0.2.12 on port 54329; `node --env-file-if-exists=.env src/migrate-cli.ts` with `DATABASE_MIGRATION_URL` in `.env`: "Migrations applied.", exit 0, twice. A variable set in the environment won over the file. No file and no variable: ".env not found. Continuing without it." and "DATABASE_MIGRATION_URL is not set.", exit 1. `sslmode=bogus`: "sslmode must be disable or verify-full", exit 1. `NODE_ENV=production` without `sslmode=verify-full`: rejected, exit 1. The URL was never printed.                                           |
| Install scripts                                                              | `npm query ":attr(scripts, [postinstall]), :attr(scripts, [install]), :attr(scripts, [preinstall])"` over the whole M1 dependency set returned exactly esbuild 0.18.20, 0.25.12 and 0.28.2. `npm ls` shows tsx 4.23.15 under drizzle-kit.                                                                                                                                                                                                                                                                                                                      |
| Bidirectional character scan                                                 | The Node scan in Section 4.2 exited 0 on the repository worktree (read-only) in Git Bash and in PowerShell 5.1. The same regular expression run over a scratch file containing U+202E printed the file name and exited 1.                                                                                                                                                                                                                                                                                                                                      |
| Electron                                                                     | `npm view electron@latest`: 45.0.0, depends on `@types/node ^24.9.0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 3. Architecture decision records

Each ADR below becomes its own file in `docs/architecture/decisions/`. The committed file keeps Context, Options considered, Decision, Consequences and Needs Project Manager decision; "Exact versions" becomes a short dependency policy and "Verified snippets" becomes links to the code and tests (template in Section 4.5). Section 4 says which pull request adds which file. Every ADR has Status: Proposed until the Project Manager accepts it.

### ADR 0001: Internal workspace packages export TypeScript source

- Status: Proposed
- Lands in: M1-01. Shared boundary with the desktop owner.

#### Context

M1 creates three Node-side workspaces (`packages/protocol`, `apps/api`, `packages/database`). The desktop application (`apps/desktop`, #3) is built in parallel and has not chosen a bundler. A clean checkout must type-check, test and run directly after `npm ci`.

- Node.js 24 runs `.ts` files through built-in type stripping. The v24 documentation marks it Stability 2 (Stable): on by default since v23.6.0, without a warning since v24.3.0, and stable since v24.12.0. The `engines` range `^24.15.0` covers it (https://nodejs.org/docs/latest-v24.x/api/typescript.html).
- Type stripping refuses files under `node_modules`. An npm workspace link is a junction on Windows and a symlink elsewhere. Node resolves it to the real path (`packages/<name>/...`), which is outside `node_modules`, so stripping applies (verified).
- npm runs `--workspaces` scripts in directory order (`apps/*` before `packages/*`), not in dependency order (verified).

#### Options considered

| Option                                                                   | Result                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Source exports: `"exports": { ".": "./src/index.ts" }`                | Clean checkout typechecks, tests and runs (verified in all three workspaces). Vite 8.3.4 and esbuild bundle it without configuration. `node --watch` restarts when a linked package changes.                       |
| 2. Compiled `dist` per package with `tsc`                                | Clean checkout fails until a build runs (TS2307, ERR_MODULE_NOT_FOUND). `npm run build --workspaces` built a consumer before its dependency and failed on the first run (verified). Needs a hand-kept build order. |
| 3. Project references with `tsc -b`                                      | Correct build order, but it emits `dist` and `tsconfig.tsbuildinfo`, needs `composite` and `references` kept in sync with `package.json`, and plain `tsc -p` still fails on a clean tree.                          |
| 4. Custom export condition (source in development, `dist` in production) | Every `node`, `tsc` and bundler invocation needs the condition, and it keeps every `dist` ordering problem of option 2.                                                                                            |

#### Decision

Option 1 for every `packages/*` workspace:

- `package.json` sets `"type": "module"`, `"private": true` and `"exports": { ".": "./src/index.ts" }`. Further subpaths are added only as deliberate public API when a consumer needs them; M1 adds none. A package without side effects also sets `"sideEffects": false`.
- Internal workspaces stay at version `0.0.0`, and dependents record exactly `"0.0.0"`. If the two drift, npm looks the package up on the public registry (reproduced by the maintainability review: `404 Not Found - GET https://registry.npmjs.org/@mymandev%2fprotocol`), and whoever owns the `@mymandev` scope there could publish a matching version. The Project Manager should claim the npm organization `mymandev` (P-46).
- Relative imports include the `.ts` extension (`./envelope.ts`). A `./x.js` import fails at runtime with ERR_MODULE_NOT_FOUND.
- Type-only imports use `import type`, enforced by `verbatimModuleSyntax` (TS1484 otherwise; Node would fail with "does not provide an export named").
- Only erasable syntax: no `enum`, no runtime `namespace`, no parameter properties, no decorators. `erasableSyntaxOnly` turns these into TS1294 at type-check time; Node would fail with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
- No tsconfig `paths`. Workspaces import each other only by package name.
- Every Node-side workspace uses the same compiler options (snippet below). `target` and `lib` are `es2025`, like the root `tsconfig.json`.
- An environment-agnostic package (the protocol now, later any package the desktop renderer imports) adds `tsconfig.src.json` with `types: []` and an explicit `lib` at the agreed renderer language level, and excludes tests. Its `typecheck` runs both configurations, so a Node global such as `process` in `src` fails in the package's own check (TS2591), and so does a language feature newer than the renderer level (TS2550, TS2693), instead of later in the desktop check. The proposed renderer level is ES2024 (P-02).
- Consumers:
  - Node applications run their source directly: `node src/server.ts`.
  - A bundled consumer (the desktop renderer) sets `moduleResolution: "bundler"`, `allowImportingTsExtensions: true` and `noEmit: true`. The Electron main and preload code that imports a workspace package is bundled too; running it unbundled was not verified.

#### Consequences

- No `dist`, no build order and no stale output. Go-to-definition opens the source.
- A workspace package must never become a real directory under `node_modules`: not published, not packed, not copied with dereferenced links, and not run with `--preserve-symlinks`. Each of these fails with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING (reproduced). A future deployment must keep the workspace layout or bundle the application.
- Each consumer type-checks package source with its own options. Shared packages must compile under the strictest consumer. The `tsconfig.src.json` check covers the renderer case for Node globals (`types: []`) and for language features (`lib`), as long as its `lib` matches the renderer's.
- Decorator-based frameworks and ORMs (NestJS, TypeORM) are excluded.
- Revisit (move one package to `tsc -b`) only if a package must be published, needs non-erasable syntax, consumer type checks become slow, or the deployment task chooses a compiled artifact.

#### Exact versions

- typescript 6.0.3 at the root, unchanged.
- @types/node 24.19.2 in each Node-side workspace (`devDependencies`). The root keeps `types: []` and gets no @types/node.
- No new root devDependencies.

#### Verified snippets

`packages/protocol/package.json` (integration run):

```json
{
  "name": "@mymandev/protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json && tsc -p tsconfig.src.json",
    "test": "node --test \"src/**/*.test.ts\""
  },
  "dependencies": {
    "uuid": "14.0.3",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@types/node": "24.19.2"
  }
}
```

Compiler options shared by `packages/protocol`, `apps/api` and `packages/database` (integration run; `apps/api` adds `"resolveJsonModule": true`, `packages/database` adds `"drizzle.config.ts"` to `include`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "es2025",
    "lib": ["es2025"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`packages/protocol/tsconfig.src.json` (revision 2; verified in Section 2.5):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["es2024"],
    "types": []
  },
  "exclude": ["src/**/*.test.ts"]
}
```

Bundled consumer, for the desktop owner to adapt (research run with Vite 8.3.4; `jsx` and `types` are the desktop's choice; `target` and `lib` must stay at or above the level in the protocol's `tsconfig.src.json`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024", "dom"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "types": ["vite/client"],
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"]
}
```

#### Needs Project Manager decision

- Accept source exports for every internal package (P-01).
- Agree with the desktop owner on the consumer rules: the renderer tsconfig flags above, one renderer language level (proposed: ES2024) written into the protocol's `tsconfig.src.json`, bundling the Electron main and preload code, never compiling package source with a `tsc` emit build, and whether the desktop opens the WebSocket from the main process (no Origin header) or from the renderer (P-02).
- Claim the npm organization `mymandev` and keep internal versions at `0.0.0` (P-46).
- Record these rules in `docs/development/WORKSPACE.md` as part of M1-01 (Section 4.2).

### ADR 0002: node:test is the test runner; the root delegates

- Status: Proposed
- Lands in: M1-01, together with the first workspace.

#### Context

No test runner exists. The three M1 workspaces run on Node. The desktop may later need DOM and `.tsx` tests. npm 11.12.1 cannot delegate a script when no workspace exists: every form, including `--if-present` and `--include-workspace-root`, fails with "No workspaces found!" (verified). The root `test` delegation can therefore only land together with the first workspace, exactly like the documented `typecheck` delegation.

#### Options considered

| Option                                           | Result                                                                                                                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:test` (built in), one script per workspace | No dependency. Runs `.ts` tests directly through type stripping. The quoted glob works through `cmd.exe`. Excludes `node_modules`. Exits 0 when nothing matches. No `.tsx`; module mocking is experimental. |
| Vitest in each workspace that wants it           | Works on Windows with source exports. Requires `vite` as a non-optional peer, which pulls in Vite and Rolldown native bindings (about 63 packages and 42 MB). Fits a bundled workspace.                     |
| Vitest at the root                               | Adds Vite to the root and can choose a different Vite than the desktop. A root-level `node --test` would also execute Vitest files and fail (verified).                                                     |

#### Decision

- Every Node-side workspace uses `node:test` with the script `"test": "node --test \"src/**/*.test.ts\""`. Tests sit next to the code as `src/**/*.test.ts`.
- The root gets `"test": "npm run test --workspaces --if-present"` in M1-01. A workspace without a `test` script is skipped.
- Tests use dependency injection rather than module mocks (`mock.module` needs `--experimental-test-module-mocks` and already prints a deprecation warning on Node 24.15).
- A bundled workspace (`apps/desktop`, a future `packages/ui`) may choose Vitest in its own `devDependencies`, matched to its Vite version. Vitest never goes into the root `package.json`, and nobody runs `node --test` at the root.
- A workspace `test` script runs once and exits. With Vitest that means `"test": "vitest run"`: plain `vitest` enters watch mode in an interactive terminal and would block the root `npm run check` (Vitest CLI guide: "will enter the watch mode in development environment and run mode in CI (or non-interactive terminal)").
- `node --test` exits 0 when its pattern matches no file. Every acceptance check therefore states the expected number of tests, and the reviewer compares it with the `# tests` line of the output.
- Coverage (`--experimental-test-coverage`, Stability 1) is optional and not a gate.
- Recommended: the root `check` script also runs the tests, so the CI workflow from PR #46 runs them on all three operating systems for every pull request that workflow covers: `"check": "npm run format:check && npm run lint && npm run typecheck && npm test"`. As proposed in PR #46, the workflow covers only pull requests into `develop` or `main`, so stacked pull requests are checked only after they are retargeted (Section 4.1, P-45).

#### Consequences

- Zero test dependencies in M1. The integration run took about 0.3 s (protocol), 0.8 s (api) and 3 to 4.5 s (database, dominated by PGlite startup) per workspace.
- With a failing test, npm still runs the other workspaces and the root exits 1 (verified in the research).
- No `.tsx` tests under `node:test`; that is the desktop's concern and is handled by the Vitest exception.

#### Exact versions

- None. `node:test` ships with Node 24.15.0.
- Only if the desktop opts in, in `apps/desktop` only: vitest 5.0.4 (5.0.5 from 2026-10-15 is under two weeks old) with the desktop's Vite (vitest's peer range is `^6.4.0 || ^7.0.0 || ^8.0.0`).

#### Verified snippets

Root `package.json` scripts after M1-01 (integration run; the `check` line is the recommended option):

```json
{
  "scripts": {
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "typecheck": "tsc -p tsconfig.json && npm run typecheck --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "check": "npm run format:check && npm run lint && npm run typecheck && npm test"
  }
}
```

Test file pattern:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { canTransition } from "./model.ts";

test("a run starts in queued", () => {
  assert.equal(canTransition(null, "queued"), true);
  assert.equal(canTransition(null, "running"), false);
});
```

#### Needs Project Manager decision

- Accept `node:test` and the root `test` delegation in M1-01 (P-03).
- Decide whether `check` runs the tests, which makes CI from PR #46 run them (P-04, recommended: yes).

### ADR 0003: zod 4 is the runtime validation library

- Status: Proposed
- Lands in: M1-01. Also used by M1-02.

#### Context

Cross-device messages are untrusted input. The protocol must validate them at runtime in three places: the Node API, the Electron renderer under a strict Content Security Policy, and later the Electron main process. Requirements: strip unknown keys including `__proto__` and `constructor` keys created by `JSON.parse`; strict UTC timestamps; branded ID types; discriminated unions with focused errors; JSON Schema export for documentation and non-TypeScript clients; works under TypeScript 6.0.3 with the repository's strict flags; works without `eval`.

#### Options considered

| Option                     | Key facts (research measurements on 20,000 decodes of the same envelope)                                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| zod 4.6.7, classic API     | Passed every hostile-input case without extra code. Strips unknown keys and drops own `__proto__`/`constructor` keys. `z.iso.datetime({ precision: 3 })` accepts only UTC `Z` with milliseconds and rejects `2026-02-30`. Native JSON Schema export. 106.9 ms; works with eval blocked. Since 4.6.6 checks array bounds before elements. About 28 KB gzip. |
| zod/mini 4.6.7             | Same core, about 9 KB gzip, but every message reads "Invalid input" until a locale is configured.                                                                                                                                                                                                                                                          |
| valibot 1.5.0              | Smallest (about 3 KB gzip). Needs custom UUIDv7 and timestamp checks; its JSON Schema converter drops custom checks.                                                                                                                                                                                                                                       |
| TypeBox (`typebox` 1.3.37) | Schemas are JSON Schema, best fit for Fastify. But `Check()` does not strip unknown keys, `Clean()` took 8,669 ms, union errors are noisy, no brands, no Standard Schema, and a pattern-only timestamp accepted `2026-02-30`.                                                                                                                              |
| arktype 2.2.8              | An own `__proto__` key survived both `delete` and `reject` modes, and `Object.assign({}, output)` then inherited an attacker-chosen prototype. Rejected for security.                                                                                                                                                                                      |
| Types only                 | No runtime safety for untrusted input.                                                                                                                                                                                                                                                                                                                     |

#### Decision

- zod 4.6.7 with the classic API: `import * as z from "zod"`.
- `@mymandev/protocol` declares zod as a `dependency`. Any other workspace that imports zod directly (M1-02: `apps/api` for configuration) declares the same exact version. npm then installs one hoisted copy (verified: `npm ls zod` shows `deduped`). A zod upgrade changes every workspace in one pull request.
- Usage rules:
  1. IDs use `z.string().regex(UUIDV7_PATTERN)`, never `z.uuidv7()`, which accepts uppercase (ADR 0004).
  2. Objects use `z.object` (strip). Never `passthrough`, `looseObject` or `strictObject` for wire data (ADR 0006).
  3. Every string and array on the wire has a maximum length.
  4. The renderer calls the protocol's `enableJitlessValidation()` once at startup. The call goes through the protocol package so that it configures the same zod instance the schemas use.
  5. Documentation JSON Schema is exported with `io: "input"`; the default output mode adds `additionalProperties: false`, which contradicts stripping.
  6. A schema has the suffix `Schema` when a type with the same name exists (`UserIdSchema` and `UserId`); same-name exports collided with TS2308 in the research.
  7. Error messages never include the input value. zod issues do not, unless `reportInput` is enabled (verified).
- Fastify integration: M1-02 needs no Fastify type provider. Its only Fastify JSON Schema is the `/health` response; WebSocket frames go through `decodeClientEvent`, and configuration goes through zod. When the first REST route with a request body arrives (M2), choose between `fastify-type-provider-zod` 7.0.0 (required peers `@fastify/swagger` 9.9.2 and `openapi-types` 12.1.3 are installed automatically; verified with TS 6.0.3 in the research) and a small `validatorCompiler` that calls `safeParse`.

#### Consequences

- About 28.7 KB gzip in the renderer for the whole protocol package including uuid (measured with esbuild). An Electron app loads it from disk. If size ever matters, the schemas can move to zod/mini.
- Supply chain: the zod v4.6.6 release notes report that six malicious commits were pushed to the main branch on 2026-09-21 with a compromised credential and reverted the same day; the notice says none were published to npm. zod 4.6.7 has npm SLSA provenance and a verified registry signature. Mitigation: exact pins, the lockfile, `npm audit signatures`, and a review of every zod upgrade.
- Adding a value to a closed `z.enum` makes old receivers reject the message. That is a protocol change (ADR 0006).

#### Exact versions

- zod 4.6.7 (published 2026-10-12, 15 days before this document). MIT, no dependencies.
- Fallback if the Project Manager wants a release from before the 2026-09-21 incident: zod 4.6.5 (2026-09-13). It lacks the array bound fix from 4.6.6.

#### Verified snippets

Branded IDs and safe display text (`packages/protocol/src/ids.ts` and `entities.ts`, revision 2; verified in Section 2.5):

```ts
// z.uuidv7() is case-insensitive, so IDs use the strict lowercase pattern.
function uuidV7String() {
  return z.string().regex(UUIDV7_PATTERN, "Expected a lowercase UUIDv7");
}

export const UserIdSchema = uuidV7String().brand<"UserId">();
export type UserId = z.infer<typeof UserIdSchema>;

/** Human-entered text that other devices render. Always render it as text, never as markup. */
export function displayText(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .regex(
      SAFE_TEXT_PATTERN,
      "Contains control, format or invisible characters",
    )
    .regex(NOT_BLANK_PATTERN, "Must not be blank");
}
```

Strict-CSP switch, exported by the protocol (verified under `node --disallow-code-generation-from-strings`):

```ts
export function enableJitlessValidation(): void {
  z.config({ jitless: true });
}
```

Documentation export (verified in a protocol test):

```ts
const schema = z.toJSONSchema(ProtocolEventSchema, {
  target: "draft-2020-12",
  io: "input",
});
```

#### Needs Project Manager decision

- zod 4.6.7 classic (recommended), zod/mini or valibot (P-05).
- Defer the Fastify type provider choice to the first REST route with a body in M2 (P-06).

### ADR 0004: Identifiers are lowercase UUIDv7

- Status: Proposed
- Lands in: M1-01. Used by M1-02 and M1-03.

#### Context

IDs cross devices, the API and PostgreSQL. They must not collide, must sort well in B-tree indexes, must have one canonical text form, and different ID kinds must not be confused in code. Node 24.15 has `crypto.randomUUID()` (version 4) but no `randomUUIDv7` (verified). PostgreSQL has `uuidv7()` only from version 18.

#### Options considered

- UUIDv7 (RFC 9562 section 5.7, "Implementations SHOULD utilize UUIDv7"): time-ordered, native PostgreSQL `uuid` type (16 bytes). RFC 9562 leaves 74 bits after the timestamp. uuid 14.0.3 uses them as a 32-bit counter plus 42 random bits (`dist/v7.js`): the first ID in a millisecond starts the counter at a random 31-bit value (73 random bits in total); each further ID in the same millisecond from the same process takes the previous counter plus one and carries only 42 fresh random bits (verified in Section 2.5).
- ULID: sortable with 80 random bits, but no RFC and no native PostgreSQL type.
- Prefixed text IDs (`usr_...`): readable, but they need `text` keys and a custom codec.
- Database-generated `gen_random_uuid()` (version 4): random index inserts, and the database instead of the application decides IDs.

#### Decision

- Every ID is a UUIDv7 in canonical lowercase form, validated by `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. PostgreSQL stores it as `uuid`.
- TypeScript brands per kind: `UserId`, `DeviceId`, `WorkspaceId`, `ProjectId`, `RepositoryId`, `AgentId`, `RunId`, `EventId`, `CorrelationId`. The database types its columns with the same brands through `.$type<...>()`. Conversations, messages and permission grants use plain UUIDv7 strings until the protocol defines their kinds (M2-03, M1-06).
- The protocol owns generation with uuid 14.0.3: `newId<T>()` for a branded kind and `newUuidV7()` for an unbranded ID. No database column has an ID default.
- Authority:
  - The server generates every entity ID (user, device, workspace, project, repository, agent, run, conversation, message, grant). A client never chooses an entity ID. This includes runs: creating a run is a server command (M2). The server allocates the `RunId` and emits the creation transition (`null -> queued`) with a `system` actor; `decodeClientEvent` rejects `previousState: null` from a device (ADR 0006, ADR 0007).
  - An emitting device generates only event IDs. An event ID is the idempotency key: the server de-duplicates on (the authenticated connection's device ID, event ID), never on the `deviceId` field inside the event. For chat messages this is the `client_event_id` column with a unique index per sending device (ADR 0013).
- An ID is never a secret and never a capability (RFC 9562 section 8: UUIDs "MUST NOT be used as security capabilities"). Knowing a workspace ID grants nothing (ADR 0005).
- Secrets are never UUIDs. Invitation tokens, device credentials and session IDs are 32 bytes from `crypto.randomBytes`, encoded as base64url, and stored only as a SHA-256 hash. `newId` and `newUuidV7` carry a "never use for a secret" comment, and the protocol README states the rule.
- The timestamp inside a UUIDv7 is never used for ordering, auditing or authorization. The server uses its own receive time and, from M2, a server sequence.

#### Consequences

- IDs sort in creation order (verified for 1,000 IDs in one process; the research verified 100,000).
- A UUIDv7 reveals its creation time to the millisecond (the research decoded one). This is acceptable for these entities; see P-08 for user IDs. Event IDs that a device generates also reveal that device's clock.
- IDs from one process in the same millisecond are sequential. They stay unique and unguessable enough for identifiers, which are not secrets.
- Mixed case is impossible: a JavaScript `Map` and a PostgreSQL `uuid` column cannot disagree about equality.
- One extra runtime dependency in the protocol package (uuid, MIT, ESM, 665 B gzip for v7 in the research bundle).

#### Exact versions

- uuid 14.0.3 (published 2026-10-10) as a `dependency` of `@mymandev/protocol`.

#### Verified snippets

Generation (`packages/protocol/src/ids.ts`, integration run):

```ts
import { v7 as uuidv7 } from "uuid";

/** Generates a new lowercase UUIDv7 string. Never use it for a secret. */
export function newUuidV7(): string {
  return uuidv7();
}

/** Generates a new lowercase UUIDv7 for one ID kind, for example newId<EventId>(). Never use it for a secret. */
export function newId<T extends AnyId>(): T {
  return uuidv7() as T;
}
```

The same brand in the database (`packages/database/src/schema/identity.ts`, integration run):

```ts
export const devices = pgTable("devices", {
  id: uuid("id").primaryKey().$type<DeviceId>(),
  userId: uuid("user_id")
    .notNull()
    .$type<UserId>()
    .references(() => users.id, { onDelete: "restrict" }),
  // ...
});
```

Compile-time proof (passes only because `tsc` reports the expected error):

```ts
const values = {
  id: newId<DeviceId>(),
  // @ts-expect-error A DeviceId is not a UserId.
  userId: deviceId as DeviceId,
  label: "x",
  platform: "macos" as const,
} satisfies Partial<typeof devices.$inferInsert>;
```

#### Needs Project Manager decision

- UUIDv7, lowercase, PostgreSQL `uuid`, branded types (P-07).
- Whether user IDs are also UUIDv7, which reveals sign-up time to the millisecond (P-08, recommended: yes).
- The protocol package generates IDs and depends on uuid 14.0.3 (P-09, recommended: yes).
- The server generates entity IDs, including run IDs; devices generate only event IDs; de-duplication uses the authenticated device ID; secrets are random bytes stored as hashes, never UUIDs (P-10).

### ADR 0005: Workspaces contain projects

- Status: Proposed
- Lands in: M1-01 (protocol types) and M1-03 (tables).

#### Context

The product description lets people "meet in a shared workspace ID". The roadmap talks about projects, project chat (M2-03) and "the same workspace" and "the same project events" (M2-05). The event envelope must carry the routing and security boundary. The invitation and join flow is an open decision (#14), and so is the account model (#15).

#### Options considered

1. Two levels: a workspace contains projects. The workspace is the membership, security and routing boundary; a project holds repositories, agents, conversations and runs.
2. One level: a workspace and a project are the same thing.

#### Decision

Option 1. The protocol v0 entities are:

| Entity     | Fields                                                                                  | Notes                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User       | `id`, `displayName` (1 to 64 characters)                                                | No handle, email or credentials until #15 is decided.                                                                                                                                        |
| Device     | `id`, `userId`, `label` (1 to 64), `platform` (`windows`, `macos`, `linux`)             | One desktop installation, owned by exactly one user. The server issues the ID at registration.                                                                                               |
| Workspace  | `id`, `name` (1 to 100)                                                                 | Membership boundary. The envelope carries `workspaceId`.                                                                                                                                     |
| Project    | `id`, `workspaceId`, `name` (1 to 100)                                                  | Holds repositories, agents, conversations and runs.                                                                                                                                          |
| Repository | `id`, `projectId`, `name` (1 to 100)                                                    | Logical repository registered in a project. The local path never leaves the device, because paths contain operating system user names. The remote URL is deferred to the M1-05 coordination. |
| Agent      | `id`, `projectId`, `ownerUserId`, `hostDeviceId`, `name` (1 to 64)                      | Runs on its host device, where provider credentials stay. The provider kind is deferred to M3.                                                                                               |
| Agent run  | `id`, `agentId`, `projectId`, `repositoryId?`, `requestedBy`, `state`, `correlationId?` | Lifecycle in ADR 0007.                                                                                                                                                                       |

Rules:

- Workspace membership grants visibility only. It never implies a capability (ADR 0008).
- A workspace ID is not a join secret. Joining requires a separate invitation token (32 bytes from `crypto.randomBytes`, base64url, stored only as a SHA-256 hash, expiring, revocable; ADR 0004) and a server-side membership check. The token design belongs to #14.
- All human-entered text (`displayName`, `label`, `name`, run `reason`) is always rendered as text, never as markup, and rejects: control characters (Cc), format characters (Cf, which includes the bidirectional controls, U+200B, U+FEFF, U+00AD and the invisible tag characters U+E0000 to U+E007F that an AI model still reads), lone surrogates (Cs), private-use characters (Co), line and paragraph separators (Zl, Zp), every other default-ignorable code point (Hangul fillers, U+034F, variation selectors) and text that is empty or only white space. Allowed exceptions: U+200C (ZWNJ, needed for Persian and Indic scripts), U+200D (ZWJ, emoji sequences and Indic scripts) and U+FE0E/U+FE0F (emoji presentation). Trade-off: subdivision flags made of tag characters (England, Scotland, Wales) are rejected.

#### Consequences

- M1-03 needs two tables that issue #21 does not list: `workspaces` and `workspace_members` (P-12).
- Per-project authorization can be added later without changing the envelope.
- Names are labels, not identity, so M1 adds no uniqueness constraint on names.

#### Exact versions

No new dependency.

#### Verified snippets

`packages/protocol/src/entities.ts` (integration run, excerpt):

```ts
export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  workspaceId: WorkspaceIdSchema,
  name: displayText(LIMITS.name),
});

export const AgentSchema = z.object({
  id: AgentIdSchema,
  projectId: ProjectIdSchema,
  ownerUserId: UserIdSchema,
  hostDeviceId: DeviceIdSchema,
  name: displayText(LIMITS.agentName),
});
```

#### Needs Project Manager decision

- Two levels, workspace and project (recommended), or one level (P-11).
- Add `workspaces` and `workspace_members` to M1-03 (P-12).
- Confirm that a workspace ID is not a join secret and that joining needs an invitation token plus a membership check (P-13; detailed design in #14).

### ADR 0006: Event envelope v0, decoding and versioning

- Status: Proposed
- Lands in: M1-01. Used by the M1-02 WebSocket gateway.

#### Context

Desktop devices and the server exchange events. Every event from another device is untrusted. Issue #19 requires that a client cannot choose its actor identity without verification. WebSocket framing, handshake and acknowledgements are out of scope (M2-01).

#### Options considered

- Envelope with header fields plus a `payload` chosen by `type` (recommended), or a type-specific top-level shape per event.
- Unknown fields: strip (recommended) or reject. Rejecting turns every added field into a breaking change.
- Version check: inside a single schema, or as its own decoding stage (recommended), so an event from a newer protocol is reported as `unsupported_version`, not as `malformed`.

#### Decision

Envelope (a flat JSON object):

| Field             | Type                                                                             | Rule                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `protocolVersion` | `0`                                                                              | Integer. v0 is pre-stable: peers must run the same version.                                           |
| `id`              | `EventId`                                                                        | Generated by the emitter; idempotency key.                                                            |
| `type`            | string                                                                           | Lowercase dotted `<domain>.<entity>.<past_tense>`, at most 100 characters.                            |
| `occurredAt`      | string                                                                           | ISO 8601 UTC with `Z` and exactly three fractional digits (`Date#toISOString()`). Informational only. |
| `workspaceId`     | `WorkspaceId`                                                                    | Routing and security boundary.                                                                        |
| `actor`           | `{ kind: "user", userId }`, `{ kind: "agent", agentId }` or `{ kind: "system" }` | Verified by the server (below).                                                                       |
| `deviceId`        | `DeviceId` or `null`                                                             | `null` only for events the server originates.                                                         |
| `correlationId`   | `CorrelationId`, optional                                                        | Groups one flow, for example one request and all its runs.                                            |
| `causationId`     | `EventId`, optional                                                              | The event that directly caused this one.                                                              |
| `payload`         | chosen by `type`                                                                 | Object schema per event type.                                                                         |

The v0 event set contains one type: `agent.run.state_changed` with payload `{ runId, agentId, repositoryId?, previousState: RunState | null, state, reason? }` (`reason` at most 500 characters). Permission grant events belong to M1-06; chat and presence events to M2.

`decodeEvent(input: unknown)` decodes in stages and returns `{ ok: true, event }` or `{ ok: false, code }`:

1. `malformed`: not an object, or `protocolVersion` is not a non-negative integer.
2. `unsupported_version`: `protocolVersion` is not `0`.
3. `malformed`: a header field is invalid.
4. `unknown_type`: `type` is well-formed but not a known event type.
5. `invalid_payload`: the payload, or the lifecycle rule in ADR 0007, fails.
6. `invalid_actor`: the actor does not fit the event type. For `agent.run.state_changed` the actor is `system` or `{ kind: "agent", agentId }` with `agentId` equal to `payload.agentId`. A `user` actor is reserved for later event types (chat in M2).

Devices and the server decode with different functions:

- A device decodes what the server sends with `decodeEvent`.
- The server decodes what a device sends with `decodeClientEvent(input)`. It runs `decodeEvent` and then returns `not_allowed_from_device` for anything only the server may originate: a `system` actor, `deviceId: null`, and a run creation (`previousState: null`). On success it returns the event typed as `UnverifiedEvent`, a branded type that marks it as well-formed but not yet bound to the connection. M1-02 already uses it.

Rules:

- Unknown fields are stripped at every level, never passed through. The input object is never returned or mutated.
- Unknown event types: the server rejects them and reports the error to the sender. Clients drop and log them; they never crash and never process them partially. The server never relays an event it could not validate.
- An unknown enum value (capability, run state, platform) rejects the whole message.
- Identity binding, enforced by the server from M2 when authentication exists. One server function, `bindIdentity(event: UnverifiedEvent, connection): VerifiedEvent | Rejection`, applies every rule below. Only a `VerifiedEvent` (a second brand, defined in `apps/api`, never in the protocol) may be relayed or stored; the relay and storage functions accept no other type. The gateway handler signature is already `(event: UnverifiedEvent, context: ConnectionContext) => void` in M1-02, so M2 cannot skip the step without a type error.
  - `deviceId` and, for a `user` actor, `actor.userId` must match the authenticated connection. On a mismatch, the server rejects the event and writes an audit record; it never silently overwrites.
  - An `agent` actor is accepted only from that agent's host device, and only while the device is not revoked and the agent is not disabled.
  - A `system` actor is accepted only from the server itself (`decodeClientEvent` already rejects it).
  - De-duplication uses the connection's device ID, never the `deviceId` field of the event.
- Reference binding, enforced by the server from M2 for every event, not once per connection. The server loads run, agent, project and workspace and requires:
  - `run.agentId` equals `payload.agentId`;
  - the agent's project belongs to the workspace in `envelope.workspaceId`;
  - `payload.repositoryId`, when present, belongs to the same project;
  - the sending device is the agent's host device and is not revoked;
  - the sending user is an active member of the workspace (`removed_at is null`) at the time of this event.
  - `correlationId` and `causationId` are labels chosen by the client. The server never uses them to look up or return data, and never across workspaces.
  - The database repeats the ownership part of these rules as composite foreign keys (ADR 0013), so a row that breaks them cannot be stored even if a check is missing.
- Ordering and auditing use the server's receive time and, from M2, a server sequence. `occurredAt` and the timestamp inside the ID are informational.
- Versioning after v0: from version 1, adding an optional field or a new event type does not change the version. A new required field, a changed meaning, a removed field or a new value in an existing enum does, or uses a new event type name.
- The union type is named `ProtocolEvent`, not `Event`, to avoid shadowing the DOM `Event` type in the desktop renderer.

#### Consequences

- An outdated client receives a clear `unsupported_version`. The M2-01 handshake should advertise the version so the desktop can ask the user to update.
- Clock skew on devices cannot reorder history.
- A closed enum change (for example a seventh capability) needs a version change or a new event type.
- A new event type needs its own actor rule in `actorAllowed`; the `switch` over `event.type` makes a missing case a type error once the union has more than one member.
- `UnverifiedEvent` and `VerifiedEvent` are compile-time brands. A cast can bypass them, so review checks for `as VerifiedEvent` outside `bindIdentity`.

#### Exact versions

zod 4.6.7 (ADR 0003).

#### Verified snippets

`packages/protocol/src/envelope.ts` (integration run, excerpt):

```ts
export const ActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: UserIdSchema }),
  z.object({ kind: z.literal("agent"), agentId: AgentIdSchema }),
  z.object({ kind: z.literal("system") }),
]);

/** ISO 8601 in UTC with a Z suffix and exactly three fractional digits. */
export const UtcTimestampSchema = z.iso.datetime({ precision: 3 });

export const envelopeHeaderShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  id: EventIdSchema,
  occurredAt: UtcTimestampSchema,
  workspaceId: WorkspaceIdSchema,
  actor: ActorSchema,
  /** null only for events that the server itself originates. */
  deviceId: DeviceIdSchema.nullable(),
  correlationId: CorrelationIdSchema.optional(),
  causationId: EventIdSchema.optional(),
};

export const AgentRunStateChangedEventSchema = z.object({
  ...envelopeHeaderShape,
  type: z.literal("agent.run.state_changed"),
  payload: AgentRunStateChangedPayloadSchema,
});

export const ProtocolEventSchema = z.discriminatedUnion("type", [
  AgentRunStateChangedEventSchema,
]);
export type ProtocolEvent = z.infer<typeof ProtocolEventSchema>;
```

Actor rule (`packages/protocol/src/envelope.ts`, revision 2; verified in Section 2.5):

```ts
/** Actor rules that hold in every direction. */
export function actorAllowed(event: ProtocolEvent): boolean {
  switch (event.type) {
    case "agent.run.state_changed":
      // The server (system) creates runs; afterwards only the run's agent reports transitions.
      return (
        event.actor.kind === "system" ||
        (event.actor.kind === "agent" &&
          event.actor.agentId === event.payload.agentId)
      );
  }
}
```

`packages/protocol/src/decode.ts` (revision 2; verified in Section 2.5):

```ts
export function decodeEvent(input: unknown): DecodeResult {
  const probe = VersionProbeSchema.safeParse(input);
  if (!probe.success) {
    return { ok: false, code: "malformed" };
  }
  if (probe.data.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, code: "unsupported_version" };
  }
  const header = EnvelopeHeaderSchema.safeParse(input);
  if (!header.success) {
    return { ok: false, code: "malformed" };
  }
  if (!knownTypes.has(header.data.type)) {
    return { ok: false, code: "unknown_type" };
  }
  const event = ProtocolEventSchema.safeParse(input);
  if (!event.success) {
    return { ok: false, code: "invalid_payload" };
  }
  if (!actorAllowed(event.data)) {
    return { ok: false, code: "invalid_actor" };
  }
  return { ok: true, event: event.data };
}

declare const unverified: unique symbol;

/**
 * An event that a device sent. It is well-formed, but its actor, device and
 * referenced IDs are not yet bound to the authenticated connection. Only the
 * server's identity binding (M2) produces an event that may be relayed or stored.
 */
export type UnverifiedEvent = ProtocolEvent & { readonly [unverified]: true };

export type ClientDecodeErrorCode = DecodeErrorCode | "not_allowed_from_device";
export type ClientDecodeResult =
  | { ok: true; event: UnverifiedEvent }
  | { ok: false; code: ClientDecodeErrorCode };

/** Decodes an event that a device sent. Rejects what only the server may originate. */
export function decodeClientEvent(input: unknown): ClientDecodeResult {
  const result = decodeEvent(input);
  if (!result.ok) {
    return result;
  }
  const { event } = result;
  if (event.actor.kind === "system" || event.deviceId === null) {
    return { ok: false, code: "not_allowed_from_device" };
  }
  // Creating a run is a server command (M2); a device never sends null -> queued.
  if (
    event.type === "agent.run.state_changed" &&
    event.payload.previousState === null
  ) {
    return { ok: false, code: "not_allowed_from_device" };
  }
  return { ok: true, event: event as UnverifiedEvent };
}
```

`declare const` is erased by Node type stripping, so the brand costs nothing at runtime (verified: the module runs under Node 24.15.0 with `erasableSyntaxOnly`).

The revision 1 protocol test suite classified 19 hostile inputs, including a version 4 UUID, an uppercase UUIDv7, a `+02:00` offset, a timestamp without milliseconds, `2026-02-30`, a 501-character reason, a reason containing U+202E, an illegal transition and a missing payload. It also proved that `__proto__` and `constructor` keys from `JSON.parse` and unknown keys at both levels are stripped, and that the input is not mutated (9/9 tests passed). Revision 2 adds the actor rule and `decodeClientEvent` cases (Section 4.2).

`SAFE_TEXT_PATTERN` must be written with escapes (see Section 2.3, finding 3). Revision 2 (verified in Section 2.5):

```ts
/**
 * Human-entered text: rejects control, format (including bidirectional and tag
 * characters), surrogate, private-use, line and paragraph separator, and
 * default-ignorable characters. ZWNJ, ZWJ and the two emoji variation
 * selectors stay allowed for Persian, Indic scripts and emoji sequences.
 * The `u` flag (not `v`) keeps z.toJSONSchema patterns valid.
 */
export const SAFE_TEXT_PATTERN =
  /^(?:[\u200C\u200D\uFE0E\uFE0F]|[^\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{DI}])*$/u;

/** At least one character that is not white space. */
export const NOT_BLANK_PATTERN = /\S/u;
```

The database CHECKs keep only the length rules. PostgreSQL regular expressions have no `\p{...}` classes, and every text reaches the database through the protocol schemas.

#### Needs Project Manager decision

- `protocolVersion: 0` with the same-version-only rule, and when version 1 is declared (P-14).
- Actor or device mismatch: reject and audit (recommended) or overwrite; `decodeClientEvent` and `UnverifiedEvent` in M1, `bindIdentity` with reference binding in M2 (P-15).
- Unknown fields: strip (recommended) or reject (P-16).
- The v0 event set is only `agent.run.state_changed` (P-17).
- Text limits and the character rule for human-entered text, including the rejected subdivision flags (P-18).

### ADR 0007: Agent run lifecycle v0

- Status: Proposed
- Lands in: M1-01 (protocol) and M1-03 (database constraint).

#### Context

Agents run on their host device. Other members see run progress. The state machine must be the same in the protocol, on the server and in the database, and terminal states must stay terminal.

#### Options considered

- One `awaiting_input` state for both "waiting for a permission approval" and "waiting for a human answer" (recommended), or two states. Two states add a protocol change for every new reason to wait.
- Retry as a new run (recommended) or as a transition back from `failed`. A transition back would make terminal states non-terminal.

#### Decision

| From              | Allowed next states                                  |
| ----------------- | ---------------------------------------------------- |
| (created, `null`) | `queued` (emitted by the server only)                |
| `queued`          | `running`, `failed`, `cancelled`                     |
| `running`         | `awaiting_input`, `completed`, `failed`, `cancelled` |
| `awaiting_input`  | `running`, `failed`, `cancelled`                     |
| `completed`       | none (terminal)                                      |
| `failed`          | none (terminal)                                      |
| `cancelled`       | none (terminal)                                      |

- A retry is a new run with a new `RunId`, linked through `correlationId`.
- Creating a run is a server command (M2). The server allocates the `RunId` (ADR 0004), stores the run and emits `null -> queued` with a `system` actor and `deviceId: null`. A device never sends a creation transition; `decodeClientEvent` rejects `previousState: null` with `not_allowed_from_device`.
- Every later transition comes from the agent's host device, with the actor `{ kind: "agent", agentId }` matching `payload.agentId` (`invalid_actor` otherwise). The server accepts it only if the run exists in the event's workspace with that agent (ADR 0006, reference binding), `previousState` equals the stored state (optimistic concurrency) and `canTransition()` allows it. The server answers an unknown run ID with the same rejection as a run in another workspace, so a device cannot probe which run IDs exist.
- A cancel request from another member is a command. Commands are out of scope for v0.
- The database stores `state` with a CHECK constraint on the six values and a second CHECK: `finished_at` is set exactly when the state is terminal.

#### Consequences

- The protocol enforces the transition rule inside the payload schema, so every decoder rejects an illegal transition.
- Retries keep a clean audit trail: one run never moves from `failed` back to `running`.

#### Exact versions

No new dependency.

#### Verified snippets

`packages/protocol/src/model.ts` (integration run, excerpt):

```ts
export const RUN_TRANSITIONS = {
  queued: ["running", "failed", "cancelled"],
  running: ["awaiting_input", "completed", "failed", "cancelled"],
  awaiting_input: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<RunState, readonly RunState[]>;

/** `from` is null when the run is created. */
export function canTransition(from: RunState | null, to: RunState): boolean {
  if (from === null) {
    return to === INITIAL_RUN_STATE;
  }
  const allowed: readonly RunState[] = RUN_TRANSITIONS[from];
  return allowed.includes(to);
}
```

Payload rule (`envelope.ts`):

```ts
export const AgentRunStateChangedPayloadSchema = z
  .object({
    runId: RunIdSchema,
    agentId: AgentIdSchema,
    repositoryId: RepositoryIdSchema.optional(),
    previousState: RunStateSchema.nullable(),
    state: RunStateSchema,
    reason: displayText(LIMITS.runReason).optional(),
  })
  .superRefine((payload, ctx) => {
    if (!canTransition(payload.previousState, payload.state)) {
      ctx.addIssue({
        code: "custom",
        message: "Illegal run state transition",
        path: ["state"],
      });
    }
  });
```

Database constraints (generated SQL, applied to PGlite; a completed run without `finished_at` and a running run with `finished_at` both fail with 23514):

```sql
CONSTRAINT "agent_runs_state_check" CHECK ("agent_runs"."state" in ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled')),
CONSTRAINT "agent_runs_finished_at_check" CHECK (("agent_runs"."state" in ('completed', 'failed', 'cancelled')) = ("agent_runs"."finished_at" is not null))
```

#### Needs Project Manager decision

- The six state names, one `awaiting_input` state, retry as a new run, and run creation as a server command (P-19).

### ADR 0008: Capability vocabulary v0

- Status: Proposed
- Lands in: M1-01 (names) and M1-03 (database CHECK). The grant shape belongs to M1-06.

#### Context

The roadmap fixes six capabilities and the rule that no implementation may infer one capability from another. Issues #19 and #24 both require that capability names are defined in one package only and that the other package imports them. M1-01 lands first, and M1-06 plans a separate `packages/permissions`.

#### Options considered

- Define the names in `@mymandev/protocol` (M1-01) and let `@mymandev/permissions` import them (recommended), or define them in `@mymandev/permissions` and make the protocol depend on it. The second option forces M1-06 to land before or with M1-01.
- A closed enum with exact matching (recommended), or a hierarchy or wildcards. A hierarchy or wildcard contradicts the roadmap rule.

#### Decision

- `CAPABILITIES = ["repo.read", "repo.write", "terminal.execute", "git.commit", "git.push", "provider.use"]` in `packages/protocol/src/model.ts`, with the type `Capability` and `CapabilitySchema = z.enum(CAPABILITIES)` in `entities.ts`.
- Exact match only. No wildcard (`repo.*` is rejected), no hierarchy, no implication: `repo.write` does not grant `repo.read`, and `git.push` does not grant `git.commit`. An absent capability is denied. An unknown string rejects the message.
- The protocol exports no capability check. A set-based `hasCapability(granted, required)` has no scope: a set built from all of an agent's grants would let `repo.write` on repository X pass for repository Y, which is the kind of inference the roadmap forbids. The only check lives in `packages/permissions` (M1-06):
  - `isGrantActive(grant, now)` is the single definition of "active": not revoked, not expired, the agent not disabled, the host device not revoked, and the granting user still a member of the workspace. No other code combines these columns.
  - `hasGrant(grants, { agentId, capability, repositoryId | providerConnectionId }, now)` requires an exact capability and the exact scope.
- M1-06 adds the grant shape in `packages/permissions` and imports `CAPABILITIES`, `Capability` and `CapabilitySchema` from `@mymandev/protocol`.
- The database CHECK on `permission_grants.capability` must equal `CAPABILITIES` exactly, proven by a test.
- Notes for M1-06:
  - `provider.use` is not repository-scoped; its scope is a provider connection on the host device. The provisional table has no provider connection column yet, so one `provider.use` grant would cover every provider account on the host device. This is one reason to hold the M1-03 merge until the grant shape is agreed (P-34).
  - `terminal.execute` can run `git commit` and `git push` through a shell. The contract still infers nothing from it, but the UI and the enforcement must treat it as the highest-risk capability and say so.

#### Consequences

- The vocabulary is a closed enum: adding a capability is a protocol change (ADR 0006) and a database migration.
- `packages/permissions` will depend on `packages/protocol`, which is allowed (packages may depend on packages; no cycle).

#### Exact versions

No new dependency.

#### Verified snippets

```ts
export const CAPABILITIES = [
  "repo.read",
  "repo.write",
  "terminal.execute",
  "git.commit",
  "git.push",
  "provider.use",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

// entities.ts
export const CapabilitySchema = z.enum(CAPABILITIES);
```

The revision 1 integration run also contained a `hasCapability` function with a 36-pair test; revision 2 removes it from the protocol (see above). The protocol test now checks the exact list and that `CapabilitySchema` rejects `repo.*`, `REPO.READ` and unknown strings. The database test reads the CHECK definition and compares it with `CAPABILITIES` in both directions (condensed from the integration run; the run used a helper for the regular expression):

```ts
const { rows } = await query(
  "select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1",
  ["permission_grants_capability_check"],
);
const def = (rows[0] as { def: string } | undefined)?.def ?? "";
const values = [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1] ?? "");
assert.deepEqual(values.sort(), [...CAPABILITIES].sort());
```

#### Needs Project Manager decision

- Capability names live in `@mymandev/protocol`, which exports no capability check; `@mymandev/permissions` imports the names and owns `isGrantActive` and `hasGrant` (P-20). This also needs the desktop owner's agreement, because M1-06 is shared.
- The `provider.use` scope and the risk treatment of `terminal.execute` are settled in M1-06 (P-21).

### ADR 0009: Fastify 5 for the cloud API, with hardened defaults

- Status: Proposed
- Lands in: M1-02.

#### Context

M1-02 needs a REST skeleton, a WebSocket gateway, a health endpoint, configuration and protocol integration (#20). Authentication, persistence, the WebSocket message protocol and deployment are out of scope. ADR 0001 requires erasable TypeScript that Node runs directly, which excludes decorator frameworks.

#### Options considered

| Option                                     | Result (research and integration runs)                                                                                                                                                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fastify 5.12.7 + @fastify/websocket 11.3.4 | Built-in pino JSON logging, `app.inject()` for HTTP and `app.injectWS()` for WebSocket tests without a network, shutdown hooks, its own TypeScript types (clean under TS 6.0.3), runs from source through type stripping. Several unsafe defaults must be overridden (below). |
| Hono 4 + @hono/node-server 2 + ws          | No default body limit, no structured logger, no WebSocket inject, manual shutdown; @hono/node-ws is deprecated; hono 5 is at release candidate.                                                                                                                               |
| Express 5 + ws                             | Default error handler sends `err.stack` unless `NODE_ENV=production`; no inject; WebSocket upgrade wired by hand; types from DefinitelyTyped.                                                                                                                                 |
| NestJS 12                                  | Decorators and parameter properties fail under Node type stripping (verified "SyntaxError: Invalid or unexpected token"); needs a separate build pipeline, rxjs and reflect-metadata.                                                                                         |

#### Decision

Fastify 5.12.7 with @fastify/websocket 11.3.4, built by a `buildApp(options)` function that returns an app that is not yet listening. Defaults that are overridden, each locked by a test:

| Setting                               | Fastify default                                                 | M1-02 value                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error response body                   | Sends `err.message` in every environment (verified)             | Custom error handler. A status outside 400 to 599 becomes 500. A 5xx is logged and gets a generic body. A 4xx keeps the message only for Fastify's own errors (code starting with `FST_`, for example validation, 413, 415); every other 4xx gets the status text, for example "Not Found" (verified) |
| Ajv `removeAdditional`, `coerceTypes` | Silently strips unknown properties and coerces types (verified) | Both `false`: reject instead                                                                                                                                                                                                                                                                          |
| `requestTimeout`                      | `0` (no timeout)                                                | `30000` ms                                                                                                                                                                                                                                                                                            |
| `bodyLimit`                           | 1 MiB                                                           | `API_BODY_LIMIT_BYTES`, default 65,536                                                                                                                                                                                                                                                                |
| WebSocket `maxPayload`                | 100 MiB (ws default)                                            | 64 KiB; larger frames close with 1009                                                                                                                                                                                                                                                                 |
| WebSocket frames after a close        | Still delivered to the `message` handler (verified)             | Ignored: the handler returns unless `socket.readyState` is `OPEN`                                                                                                                                                                                                                                     |
| WebSocket Origin                      | Not checked; browsers apply no same-origin rule to WebSocket    | `preValidation` hook on `/ws`: a request with an `Origin` header not listed in `API_ALLOWED_ORIGINS` (empty by default) gets 403. A request without `Origin` (Node, Electron main) is accepted                                                                                                        |
| WebSocket shutdown                    | Clients see close code 1005                                     | Close 1001 `server_shutdown`, wait up to `shutdownGraceMs` (2 s), then terminate                                                                                                                                                                                                                      |
| Not-found response                    | Echoes and logs method and full URL                             | Generic `{"statusCode":404,"error":"Not Found","message":"Not Found"}`, nothing logged                                                                                                                                                                                                                |
| Request log line                      | Logs the full URL, including the query string (verified)        | `req` serializer logs method, path without query and remote address                                                                                                                                                                                                                                   |
| Error log                             | Logs every own property, message and stack                      | `err` serializer: type, codes, message and stack; message and stack are replaced when the error carries `query`, `params` or `detail` (database errors)                                                                                                                                               |
| `trustProxy`                          | `false`                                                         | `false`, set explicitly                                                                                                                                                                                                                                                                               |
| Prototype poisoning                   | `onProtoPoisoning: "error"`                                     | Kept; a JSON body with `__proto__` returns 400 (verified)                                                                                                                                                                                                                                             |
| Bind address                          | (set by the caller)                                             | `API_HOST`: `127.0.0.1` (default), `::1` or `localhost` only, until authentication exists (M2)                                                                                                                                                                                                        |

REST skeleton: `GET /health` returns `{ "status": "ok", "version": "<package version>" }` with a response schema, so Fastify serializes only declared fields. No other REST route exists in M1-02.

WebSocket gateway on `GET /ws`:

- The Origin check above runs before the upgrade.
- Each connection gets a `ConnectionContext`: a `connectionId` (UUIDv7) and `identity: null`. M2 authentication fills `identity` with the user and device.
- Frames that arrive after the handler has requested a close are ignored.
- Text frames only. A binary frame closes with 1003 `binary_not_supported`.
- Each text frame is parsed with `JSON.parse`; a failure closes with 1007 `invalid_json`.
- The parsed value goes through `decodeClientEvent` from `@mymandev/protocol`. A failure closes with 1008 and the decode code as the reason (`malformed`, `unsupported_version`, `unknown_type`, `invalid_payload`, `invalid_actor`, `not_allowed_from_device`).
- A valid event is passed, as `UnverifiedEvent`, with its `ConnectionContext` to an injected `onEvent(event, context)` handler. The default handler logs the event ID, type and connection ID at debug level. There is no routing, fan-out, persistence, presence or reply; those belong to M2, behind `bindIdentity` (ADR 0006).
- These close codes and reasons are provisional. M2-01 owns the WebSocket protocol and may change them.

Rule for M2 and later: credentials never appear in URLs. A browser `WebSocket` cannot set headers, which invites `/ws?token=...`; the query string would then reach proxies and history even though the API no longer logs it. WebSocket authentication uses the first message or the `Sec-WebSocket-Protocol` header (P-48).

Not in M1-02: authentication, sessions, tokens, rate limits, CORS, OpenAPI, TLS, database access, permission enforcement, Docker, deployment configuration, clustering, pino-pretty, tsx, and a Fastify type provider.

#### Consequences

- Fastify ships security releases often: 8 advisories in the 5.12.x line between August and October 2026, 4 of them high, all fixed by 5.12.6 (GHSA-389g-gv7q-r4x8 was the last). With exact pins, upgrades are manual, so releases must be tracked (P-23).
- The overridden defaults are easy to lose in later edits. The tests for the generic 5xx body, 413, 404, prototype poisoning and the WebSocket close codes keep them in place.
- Because `coerceTypes` is `false`, numeric query and path parameters must be declared as pattern-checked strings when they appear in M2.
- @fastify/websocket logs client-caused errors such as "Max payload size exceeded" at error level. A custom `errorHandler` may be needed later.
- Clients created by `injectWS` never finish the closing handshake, so tests pass `shutdownGraceMs: 50` to keep `app.close()` fast. `injectWS` also needs `await app.ready()` first; without it the returned promise never settles.
- The API cannot be reached from another machine in M1. Widening `API_HOST` is part of the authentication work in M2.
- The error serializer drops message and stack for database errors. The database package also turns every query error into a `DatabaseError` without query data (ADR 0011), so the serializer is a second line of defense.
- Fastify 6 is in alpha (`6.0.0-alpha.5`); a major upgrade will come.

#### Exact versions

- fastify 5.12.7 (published 2026-10-13T08:07Z, exactly 14 days old; the version bump after the 5.12.6 security release). Do not use 5.12.5.
- @fastify/websocket 11.3.4 (2026-10-09). Resolves ws 8.22.0 (2026-09-26).
- pino 10.4.0 (2026-10-02), through fastify.
- @types/ws 8.18.2 (2026-09-29), dev-only, needed for the socket types.

#### Verified snippets

`apps/api/src/app.ts` (revision 2, excerpt; verified in Section 2.5):

```ts
import { STATUS_CODES } from "node:http";

// Fastify 5.12.7 types the error handler's `error` as unknown, so narrow it.
function statusCodeOf(error: unknown): number {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return 500;
}

/** Fastify's own client errors (validation, 413, 415) have FST_ codes and safe messages. */
function isFastifyError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("FST_")
  );
}

const app = Fastify({
  logger:
    options.logger === false
      ? false
      : {
          level: config.logLevel,
          serializers: { req: serializeRequest, err: serializeError },
        },
  bodyLimit: config.bodyLimitBytes,
  trustProxy: false,
  requestTimeout: 30_000,
  // Reject instead of silently stripping unknown properties or coercing types.
  ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
});

// The default handler sends err.message in every environment, also for errors
// whose statusCode is below 500 or not an HTTP error status at all.
app.setErrorHandler((error, request, reply) => {
  const received = statusCodeOf(error);
  const statusCode = received >= 400 && received <= 599 ? received : 500;
  if (statusCode >= 500) {
    request.log.error({ err: error }, "request failed");
  }
  const reason = STATUS_CODES[statusCode] ?? "Error";
  const message =
    statusCode < 500 && isFastifyError(error) ? error.message : reason;
  return reply.status(statusCode).send({ statusCode, error: reason, message });
});

// The default handler logs and echoes the method and the full URL.
app.setNotFoundHandler((_request, reply) =>
  reply
    .code(404)
    .send({ statusCode: 404, error: "Not Found", message: "Not Found" }),
);

await app.register(websocket, {
  options: { maxPayload: 64 * 1024 },
  preClose: async () => {
    const server = app.websocketServer;
    for (const client of server.clients) {
      client.close(CloseCode.goingAway, "server_shutdown");
    }
    const allClosed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    await Promise.race([allClosed, delay(graceMs, undefined, { ref: false })]);
    for (const client of server.clients) {
      client.terminate();
    }
  },
});

app.get(
  "/health",
  { schema: { response: { 200: healthResponse } } },
  async () => ({ status: "ok", version: options.version }),
);
```

`apps/api/src/log.ts` (revision 2; verified in Section 2.5):

```ts
import type { FastifyRequest } from "fastify";

/** Logs the path without the query string, so a token in a URL never reaches the logs. */
export function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: request.url.split("?", 1)[0],
    remoteAddress: request.ip,
  };
}

const QUERY_DATA_KEYS = ["query", "params", "detail"];

function carriesQueryData(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    QUERY_DATA_KEYS.some((key) => key in value)
  );
}

/**
 * Allowlist error serializer. An error that may carry SQL, query parameters or
 * row details (Drizzle and driver errors) is logged without message and stack.
 */
export function serializeError(
  error: unknown,
  depth = 0,
): {
  type: string;
  message: string;
  stack: string;
  [key: string]: unknown;
} {
  if (!(error instanceof Error)) {
    return { type: typeof error, message: "", stack: "" };
  }
  const fields = error as Error & { code?: unknown; statusCode?: unknown };
  const redact = carriesQueryData(error) || carriesQueryData(error.cause);
  return {
    type: error.name,
    code: typeof fields.code === "string" ? fields.code : undefined,
    statusCode:
      typeof fields.statusCode === "number" ? fields.statusCode : undefined,
    message: redact ? "[redacted: may contain query data]" : error.message,
    stack: redact ? "" : (error.stack ?? ""),
    cause:
      error.cause === undefined || depth >= 2
        ? undefined
        : serializeError(error.cause, depth + 1),
  };
}
```

`apps/api/src/gateway.ts` (revision 2, excerpt; verified in Section 2.5):

```ts
export type ConnectionIdentity = Readonly<{
  userId: UserId;
  deviceId: DeviceId;
}>;

export type ConnectionContext = Readonly<{
  connectionId: string;
  /** Set by authentication in M2. Always null in M1-02. */
  identity: ConnectionIdentity | null;
}>;

/** Receives events that are well-formed but not yet bound to an identity. */
export type EventHandler = (
  event: UnverifiedEvent,
  context: ConnectionContext,
) => void;

/** Browsers send Origin on every WebSocket handshake; Node and Electron main do not. */
export function originGuard(allowedOrigins: readonly string[]) {
  const allowed: ReadonlySet<string> = new Set(allowedOrigins);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) {
      return reply
        .code(403)
        .send({ statusCode: 403, error: "Forbidden", message: "Forbidden" });
    }
  };
}

export function registerGateway(
  app: FastifyInstance,
  options: { allowedOrigins: readonly string[]; onEvent: EventHandler },
): void {
  app.get(
    "/ws",
    { websocket: true, preValidation: originGuard(options.allowedOrigins) },
    (socket: WebSocket, request) => {
      const context: ConnectionContext = {
        connectionId: newUuidV7(),
        identity: null,
      };
      socket.on("message", (data, isBinary) => {
        // After a close was requested, ignore frames that arrived in the same read.
        if (socket.readyState !== socket.OPEN) {
          return;
        }
        if (isBinary) {
          socket.close(CloseCode.unsupportedData, "binary_not_supported");
          return;
        }
        let input: unknown;
        try {
          input = JSON.parse(frameToText(data));
        } catch {
          socket.close(CloseCode.invalidFramePayload, "invalid_json");
          return;
        }
        const result = decodeClientEvent(input);
        if (!result.ok) {
          request.log.debug({ code: result.code }, "event rejected");
          socket.close(CloseCode.policyViolation, result.code);
          return;
        }
        options.onEvent(result.event, context);
      });
    },
  );
}
```

Test patterns (`apps/api/src/gateway.test.ts`, revision 2; verified in Section 2.5):

```ts
const app = await buildApp({
  config,
  version: "0.0.0",
  onEvent,
  shutdownGraceMs: 50,
});
await app.ready(); // injectWS never settles without it

// An invalid frame followed by valid events in the same tick: none reaches onEvent.
const ws = await app.injectWS("/ws");
const closed = once(ws, "close");
ws.send("{not json");
for (let i = 0; i < 50; i += 1) {
  ws.send(JSON.stringify(validEvent()));
}
const [code, reason] = (await closed) as [number, Buffer];
assert.equal(code, 1007);
assert.equal(reason.toString(), "invalid_json");
assert.equal(received.length, 0);
ws.terminate();

// A foreign browser origin is refused before the upgrade.
await assert.rejects(
  app.injectWS("/ws", { headers: { origin: "https://evil.example" } }),
  /403/,
);
```

#### Needs Project Manager decision

- Fastify 5.12.7 with @fastify/websocket 11.3.4 (P-22).
- A follow-up for dependency update tracking (for example Dependabot) because of the Fastify release rate (P-23).
- The WebSocket close codes are provisional until M2-01 (P-24).
- `/health` returns the application version. Remove it if the version should not be public (P-25, recommended: keep; it is the app version, not the Fastify version).
- Credentials never in URLs; WebSocket authentication through the first message or `Sec-WebSocket-Protocol` (P-48).

### ADR 0010: API configuration, runtime and shutdown

- Status: Proposed
- Lands in: M1-02.

#### Context

Issue #20 requires that configuration is loaded at startup, that no secrets are committed, and that the API starts locally with a documented command. ADR 0001 lets Node run the source directly.

#### Options considered

- Configuration: zod (already the validation library), TypeBox `Value.Convert` (the research found it accepts `80.5`, `0x50`, `8e1`, `true` and the empty string as numbers), or `@fastify/env`/`env-schema` (an extra dependency built on Ajv coercion).
- Runtime: Node type stripping (recommended), `tsx`, or a `tsc` build.

#### Decision

- `src/config.ts` exports `loadConfig(env)`. It reads only the known variables, treats an empty string as unset, validates the raw strings before converting them, returns a frozen object and throws `ConfigError`. Error lines name the variable and never contain its value.

| Variable               | Default       | Accepted values                                                                                                                                                                                       |
| ---------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | `development` | `development`, `test`, `production`                                                                                                                                                                   |
| `API_HOST`             | `127.0.0.1`   | `127.0.0.1`, `::1` or `localhost` (loopback only until authentication exists in M2)                                                                                                                   |
| `API_PORT`             | `3000`        | Decimal integer 0 to 65535, no sign, no leading zero, no spaces                                                                                                                                       |
| `API_LOG_LEVEL`        | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                                                                                                                                          |
| `API_BODY_LIMIT_BYTES` | `65536`       | Decimal integer 1 to 10,485,760                                                                                                                                                                       |
| `API_ALLOWED_ORIGINS`  | empty         | Comma-separated list of at most 20 `http` or `https` origins, each exactly in the form `scheme://host[:port]` (no path, no trailing slash, no `*`, no `null`). Browser origins allowed to open `/ws`. |

- `src/server.ts` is the only file with side effects: it loads configuration (prints `ConfigError` and exits 1), builds the app, reads the version from `../package.json` with an import attribute, registers SIGINT and SIGTERM handlers, and listens. Shutdown runs `app.close()` once, with a 10-second force-exit timer that does not keep the process alive.
- Scripts: `dev` = `node --watch --env-file-if-exists=.env src/server.ts`, `start` = `node src/server.ts`, `typecheck` = `tsc -p tsconfig.json`, `test` = `node --test "src/**/*.test.ts"`. No `build` script in M1-02.
- `apps/api/.env.example` lists the variables with their defaults. `.env` is ignored by the root `.gitignore` (`.env.example` is explicitly allowed). M1-02 has no secret; `DATABASE_URL` (the application role, ADR 0011) arrives with the first API feature that stores data.
- Logs are pino JSON. No pino-pretty.

#### Consequences

- No `tsx`, no build and no `dist` for development, tests and local start.
- The deployment artifact is decided by a later deployment task: either ship the workspace layout and run with Node, or bundle (ADR 0001). Either way, production installs use `npm ci --omit=dev`, so drizzle-kit, tsx and esbuild with their install scripts never reach a server (ADR 0011).
- Running the API for another machine needs a code change (`API_HOST`) together with authentication, not only an environment variable.
- On Windows, SIGTERM is never delivered and `node --watch` restarts terminate the process without running the handler. Ctrl+C sends SIGINT, which runs it.

#### Exact versions

zod 4.6.7 (declared in `apps/api` as well, same version as the protocol). No other dependency.

#### Verified snippets

`apps/api/src/config.ts` (revision 2, excerpt; verified in Section 2.5):

```ts
// Validate the raw string first: Number(" 80"), Number("0x50") and Number("8e1") all return 80.
const DecimalString = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,8})$/, "Expected a decimal integer");

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

const OriginList = z
  .string()
  .max(2048)
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .refine(isOrigin, "Expected an origin such as https://app.example"),
      )
      .max(20),
  );

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  // Loopback only until authentication exists (M2).
  API_HOST: z.enum(["127.0.0.1", "::1", "localhost"]).default("127.0.0.1"),
  API_PORT: DecimalString.default("3000")
    .transform(Number)
    .pipe(z.number().int().min(0).max(65_535)),
  API_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  API_BODY_LIMIT_BYTES: DecimalString.default("65536")
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(1)
        .max(10 * 1024 * 1024),
    ),
  // Browser origins allowed to open /ws. Empty: no browser origin is allowed.
  API_ALLOWED_ORIGINS: OriginList.default([]),
});

export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
): Config {
  const raw: Record<string, string> = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      raw[key] = value;
    }
  }
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }
  // ... map to { nodeEnv, host, port, logLevel, bodyLimitBytes, allowedOrigins } and Object.freeze
}
```

Fail-fast output (revision 1 run, Git Bash):

```text
$ API_PORT=0x50 API_LOG_LEVEL=loud NODE_ENV=staging node src/server.ts
Invalid configuration:
  NODE_ENV: Invalid option: expected one of "development"|"test"|"production"
  API_PORT: Expected a decimal integer
  API_LOG_LEVEL: Invalid option: expected one of "fatal"|"error"|"warn"|"info"|"debug"|"trace"|"silent"
exit=1
```

`apps/api/src/server.ts` (integration run, excerpt):

```ts
import packageJson from "../package.json" with { type: "json" };

const app = await buildApp({ config, version: packageJson.version });

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  setTimeout(() => process.exit(1), 10_000).unref();
  await app.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, (received) => void shutdown(received));
}
```

#### Needs Project Manager decision

- The variable names and the `API_` prefix, loopback-only `API_HOST` in M1, and `API_ALLOWED_ORIGINS` empty by default (P-26).
- No build step in M1-02; the deployment artifact is decided later; production installs use `npm ci --omit=dev` (P-27).

### ADR 0011: Drizzle ORM with generated SQL migrations

- Status: Proposed
- Lands in: M1-03.

#### Context

M1-03 needs a database package, migrations and the initial entities (#21). There is no Docker and no local PostgreSQL in the current environment. ADR 0001 requires TypeScript that Node runs without a build. Types must stay in sync with the schema without a running database.

#### Options considered

| Option                                   | Result                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drizzle ORM 0.45.4 + drizzle-kit 0.31.11 | TypeScript schema is the single source for row types and migrations. `drizzle-kit generate` writes reviewable SQL. First-party PGlite and node-postgres drivers and migrators read the same folder. Runtime dependencies are pure JavaScript. |
| Kysely 0.29.6                            | Most SQL-transparent, but the database types are maintained by hand or generated from a live database, and there is no first-party PGlite dialect.                                                                                            |
| Prisma 7.10.1                            | 137 packages and 264 MB; downloads a native `schema-engine-windows.exe` on install; separate schema language; `prisma` `latest` tag points to an 8.0 release candidate.                                                                       |
| node-pg-migrate 9.0.0                    | Plain SQL migrations with an advisory lock, but only a runner: needs a second library for typed queries and a wire connection, so it cannot use in-process PGlite.                                                                            |
| Driver: pg 8.23.1 or postgres 3.4.9      | pg is supported by every option, has an explicit pool size and is pure JavaScript. postgres.js has a slower release pace and less first-party support.                                                                                        |

#### Decision

Drizzle ORM 0.45.4, drizzle-kit 0.31.11 and pg 8.23.1, with these guardrails:

1. Migrations are generated with `npm run db:generate -w @mymandev/database -- --name <name>` and committed as SQL plus `migrations/meta/`. `migrations/meta/` is in the root `.prettierignore`, because drizzle-kit rewrites those JSON files in its own format (Prettier failed on them in the research).
2. A test fails when the journal `when` values do not strictly increase. The 0.45 migrator silently skips a migration that is older than the last applied one (reproduced in the research). After merging `develop` into a branch with a new migration, regenerate the migration if the test fails.
3. `runMigrations` takes a session-level `pg_advisory_lock` on a pool with `max: 1`, because the drizzle-orm migrator takes no lock.
4. Migrations run as a separate step (`npm run db:migrate -w @mymandev/database` with `DATABASE_MIGRATION_URL`), never on API startup. The script is `node --env-file-if-exists=.env src/migrate-cli.ts`, so a developer on Windows puts the URL into `packages/database/.env` instead of setting it inline; a variable set in the environment still wins over the file (verified in Section 2.5).
5. drizzle-kit needs an interactive terminal for ambiguous changes such as renames. In a non-interactive shell it prints an error, writes nothing and exits 0 (reproduced). A human generates such migrations in a terminal, or writes them with `drizzle-kit generate --custom`, and always checks that a file was written.
6. A merged migration is never edited. Hand-written SQL goes into `--custom` migrations.
7. Only the SQL-like core query builder is used (`select`, `insert`, `update`, `delete`, joins). Not `relations()` or `db.query`, which Drizzle 1.0 replaces.
8. `@electric-sql/pglite-socket` is never added to a `package.json`. It reset pooled pg connections after a second error on the same connection, and its exact-version peers made npm nest PGlite, which broke `drizzle-orm/pglite` (both reproduced). It is used only ad hoc through `npx`.
9. Schema files import from `@mymandev/protocol` only with `import type` (brands and literal unions). CHECK vocabularies are literal SQL, and a test compares them with the protocol constants.
10. `updated_at` is maintained in the data layer with `.$onUpdate(() => new Date())` (verified). A database trigger is the alternative (P-31).
11. Plan the upgrade to Drizzle 1.0 when it is generally available (`drizzle-kit up` converts the folder; 1.0 removes the journal and adds commutativity checks).
12. Errors never carry query data out of the package. A failed Drizzle query throws an error whose message and stack contain the SQL and every parameter value, and whose `cause.detail` repeats key values (verified). Every query function runs its statements through `withDatabaseErrors`, which throws a `DatabaseError` with only the SQLSTATE `code` and the `constraint` name. The API's log serializer redacts such errors as a second line of defense (ADR 0009).
13. Two database roles. `mymandev_migrator` owns the database and the schema and is used only by `db:migrate` through `DATABASE_MIGRATION_URL`. `mymandev_app` gets `SELECT`, `INSERT` and `UPDATE` on tables through default privileges, nothing else: no `DELETE` or `TRUNCATE` (nothing is hard-deleted), no `CREATE`, and no access to the `drizzle` migration schema. The application connects with `DATABASE_URL` from M2. Setup SQL in `packages/database/README.md`:

    ```sql
    -- As a superuser, once per server. Use real passwords from a secret store.
    CREATE ROLE mymandev_migrator LOGIN PASSWORD 'change-me';
    CREATE ROLE mymandev_app LOGIN PASSWORD 'change-me';
    CREATE DATABASE mymandev OWNER mymandev_migrator;
    \c mymandev
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES FOR ROLE mymandev_migrator IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE ON TABLES TO mymandev_app;
    ```

    Verified on PGlite with `ALTER DATABASE ... OWNER TO` in place of `CREATE DATABASE` and without passwords (Section 2.5). Not yet run on a real PostgreSQL 18 server.

14. Connection URLs are checked before use and never printed. The scheme must be `postgres:` or `postgresql:`. `sslmode` may be absent, `disable` or `verify-full`; pg 8 treats `prefer`, `require` and `verify-ca` differently from libpq and `no-verify` skips certificate checks, so those are rejected, and so is `uselibpqcompat`. With `NODE_ENV=production`, `sslmode=verify-full` is required.
15. Timeouts. `createDatabase` sets `connectionTimeoutMillis: 5000` (pg's default waits forever), `statement_timeout: 30000` (overridable per connection) and `idle_in_transaction_session_timeout: 60000`. PGlite ignores the two server parameters, so their effect is verified only on a real server (P-32).
16. Editors must not rewrite generated migrations. The root `.editorconfig` gets a section that switches off final-newline, whitespace-trimming and indentation rules for `packages/database/migrations/**`, because drizzle-kit writes tabs and no final newline and a merged migration is never edited.

Data access lives in `packages/database`. `apps/api` does not use drizzle-orm directly; it will import query functions and types from `@mymandev/database` in M2.

#### Consequences

- `npm audit` reports 4 moderate findings, all from drizzle-kit's deprecated `@esbuild-kit/*` dependencies, which pull in esbuild 0.18.20 (GHSA-67mh-4wv8-2f99, which concerns esbuild's development server). They are dev-only; `npm audit --omit=dev` reports 0. `npm audit fix --force` would downgrade drizzle-kit to 0.18.1 and must not be run. A future audit gate needs an exception or Drizzle 1.0 (P-30).
- What drizzle-kit 0.31.11 brings in (verified with `npm ls` and `npm query`): it declares `tsx ^4.21.0` (resolved to tsx 4.23.15) and `esbuild ^0.25.4`, and the tree contains three esbuild copies: 0.18.20 (through `@esbuild-kit/core-utils`), 0.25.12 and 0.28.2 (through tsx). Each esbuild runs `"postinstall": "node install.js"` and ships a native binary. They are the only install scripts in the whole M1 dependency set. `tsx`, `esbuild` and `drizzle-kit` appear in `node_modules/.bin`. tsx is not a direct dependency and must not be used in scripts.
- Deployment installs with `npm ci --omit=dev`. `db:migrate` uses only the drizzle-orm migrator and pg, so drizzle-kit, tsx and esbuild never reach a server.
- The runtime stack (drizzle-orm, pg) is pure JavaScript.
- Generated SQL uses tabs and has no final newline. Prettier does not check SQL, the `.editorconfig` section keeps editors from changing it, and generated files are not edited by hand.
- Every future query function must use `withDatabaseErrors`; review checks for direct `db.` calls that bypass it.
- The migrator runs all pending migrations in one transaction. Statements that cannot run in a transaction (for example `CREATE INDEX CONCURRENTLY`) are not possible, so vocabularies use `text` with CHECK constraints instead of PostgreSQL enums.

#### Exact versions

- dependencies: drizzle-orm 0.45.4 (2026-10-08), pg 8.23.1 (2026-09-30), `@mymandev/protocol` (workspace, recorded as `0.0.0`).
- devDependencies: drizzle-kit 0.31.11 (2026-09-21), @electric-sql/pglite 0.5.9 (2026-10-12), @types/pg 8.23.1 (2026-08-17), @types/node 24.19.2 (2026-10-09).
- Not declared: pg-native, @electric-sql/pglite-socket, tsx. tsx 4.23.15 and esbuild 0.18.20, 0.25.12 and 0.28.2 are installed anyway, as dependencies of drizzle-kit (see Consequences).

#### Verified snippets

`packages/database/package.json` (revision 2: no `./testing` export, `db:migrate` reads `.env`):

```json
{
  "name": "@mymandev/database",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:check": "drizzle-kit check",
    "db:migrate": "node --env-file-if-exists=.env src/migrate-cli.ts",
    "typecheck": "tsc -p tsconfig.json",
    "test": "node --test \"src/**/*.test.ts\""
  },
  "dependencies": {
    "@mymandev/protocol": "0.0.0",
    "drizzle-orm": "0.45.4",
    "pg": "8.23.1"
  },
  "devDependencies": {
    "@electric-sql/pglite": "0.5.9",
    "@types/node": "24.19.2",
    "@types/pg": "8.23.1",
    "drizzle-kit": "0.31.11"
  }
}
```

`packages/database/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
});
```

`packages/database/src/migrate.ts`:

```ts
export const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

const MIGRATION_LOCK_KEY = 726_001;

/**
 * Applies pending migrations under a session-level advisory lock, because the
 * drizzle-orm migrator takes no lock. The caller must pass a pool with max: 1,
 * so the lock and the migration use the same session.
 */
export async function runMigrations(
  db: NodePgDatabase<typeof schema>,
): Promise<void> {
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
  }
}
```

`packages/database/src/client.ts` and `src/migrate-cli.ts` (revision 2; verified in Section 2.5):

```ts
const ALLOWED_SSL_MODES = new Set(["disable", "verify-full"]);

/**
 * Checks a connection URL without ever printing it (it contains the password).
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
```

```ts
// The migration role owns the schema; the application role (M2) cannot change it.
const url = process.env["DATABASE_MIGRATION_URL"];
if (!url) {
  console.error("DATABASE_MIGRATION_URL is not set.");
  process.exit(1);
}
const problem = checkDatabaseUrl(url, process.env["NODE_ENV"] === "production");
if (problem !== undefined) {
  console.error(`DATABASE_MIGRATION_URL ${problem}.`);
  process.exit(1);
}

const { db, close } = createDatabase(url, { max: 1 });
try {
  await runMigrations(db);
  console.log("Migrations applied.");
} finally {
  await close();
}
```

`packages/database/src/migrations.test.ts`:

```ts
type Journal = { entries: { idx: number; when: number; tag: string }[] };

// The drizzle-orm 0.45 migrator silently skips a migration whose `when` is older
// than the last applied one. Regenerate a migration after merging develop if this fails.
test("migration journal timestamps strictly increase", () => {
  const journal = JSON.parse(
    readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8"),
  ) as Journal;
  assert.ok(journal.entries.length > 0);
  journal.entries.forEach((entry, index) => {
    assert.equal(entry.idx, index);
    const previous = journal.entries[index - 1];
    if (previous) {
      assert.ok(
        entry.when > previous.when,
        `${entry.tag} is not newer than ${previous.tag}`,
      );
    }
  });
});
```

`packages/database/src/errors.ts` (revision 2; verified in Section 2.5):

```ts
/** A database failure that carries no SQL text, parameters or row details. */
export class DatabaseError extends Error {
  override readonly name = "DatabaseError";
  /** SQLSTATE such as 23505, or a driver code such as ECONNREFUSED. */
  readonly code: string | undefined;
  readonly constraint: string | undefined;

  constructor(code: string | undefined, constraint: string | undefined) {
    super(
      `Database operation failed (code ${code ?? "unknown"}${constraint === undefined ? "" : `, constraint ${constraint}`})`,
    );
    this.code = code;
    this.constraint = constraint;
  }
}

function readCode(
  value: unknown,
  key: "code" | "constraint",
): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === "string" && /^[0-9A-Za-z_]{1,63}$/.test(field)
    ? field
    : undefined;
}

/** Replaces a driver or Drizzle error (whose message contains the parameters) with a DatabaseError. */
export function toDatabaseError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) {
    return error;
  }
  const source =
    error instanceof Error && error.cause !== undefined ? error.cause : error;
  return new DatabaseError(
    readCode(source, "code"),
    readCode(source, "constraint"),
  );
}

/** Every query function in this package runs its statements through this wrapper. */
export async function withDatabaseErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toDatabaseError(error);
  }
}
```

Root `.prettierignore` addition (format check passed with it):

```text
# drizzle-kit writes these files; keep the format it produces.
/packages/database/migrations/meta/
```

Root `.editorconfig` addition (not tried in an editor; `unset` is part of the EditorConfig specification):

```ini
# drizzle-kit writes migrations with tabs and no final newline; never reformat them.
[packages/database/migrations/**]
insert_final_newline = unset
trim_trailing_whitespace = unset
indent_style = unset
indent_size = unset
```

Acceptance check for install scripts (expected output: exactly the three esbuild packages):

```sh
npm query ":attr(scripts, [postinstall]), :attr(scripts, [install]), :attr(scripts, [preinstall])"
```

#### Needs Project Manager decision

- Drizzle 0.45 stable with the guardrails (recommended), or start on the 1.0 release candidate (P-28).
- Migrations as a separate deployment step, not on API startup (P-29).
- Accept the 4 moderate dev-only audit findings from drizzle-kit 0.31.11, and the three esbuild install scripts it brings (P-30).
- `updated_at` in the data layer (recommended) or by a trigger (P-31).
- Two database roles, `DATABASE_MIGRATION_URL` for migrations, and `sslmode=verify-full` required in production (P-47).

### ADR 0012: Database tests run on in-process PGlite

- Status: Proposed
- Lands in: M1-03.

#### Context

Tests must run on every developer machine and in CI on Windows, macOS and Linux, without Docker and without a local PostgreSQL server. Issue #21 also asks for documented local PostgreSQL setup and for migrations that create the full schema on an empty PostgreSQL database.

#### Options considered

- In-process PGlite with `drizzle-orm/pglite` (recommended): real PostgreSQL 18.6 compiled to WebAssembly, no native code.
- PGlite over TCP with pglite-socket as a dependency: rejected (ADR 0011, guardrail 8).
- A real PostgreSQL server in tests: requires Docker or a local install; planned later as a CI service container.

#### Decision

- `packages/database/src/testing.ts` contains `createTestDatabase()`: a fresh in-memory PGlite with every migration applied. M1-03 does not export it; the package's own tests import `./testing.ts` directly. The export `"./testing"` is added in M2, when the API first needs a test database, together with the rule that a consumer declares `@electric-sql/pglite` as a devDependency at the identical exact version (a nested PGlite breaks `drizzle-orm/pglite`, guardrail 8).
- One PGlite instance per test file, created in `before` and closed in `after`. M1-03 keeps PGlite-backed tests in one file; the role test inside it creates and closes a second instance of its own. The journal and URL tests need no database.
- The production path (pg pool, advisory lock, node-postgres migrator) is smoke-tested by hand with pglite-server through `npx`, not in the test suite.
- `packages/database/README.md` documents local development with a real PostgreSQL 18 (installed natively, the two roles from ADR 0011, `DATABASE_MIGRATION_URL` in `packages/database/.env`, `npm run db:migrate -w @mymandev/database`) and the no-install smoke path.
- A CI job against a real PostgreSQL 18 service container is a follow-up once the CI workflow exists (P-33).

#### Consequences

- PGlite startup and migration took 3 to 4.5 s per test file in the integration run, and the research measured about 300 MB or more resident memory per instance. `node --test` runs files in parallel processes, so many PGlite test files multiply memory.
- PGlite is a single connection: locking, concurrency and pooling behaviour differ from a server.
- PGlite 0.5.9 inherits the host time zone; 0.5.12 (2026-10-26) defaults to UTC. Typed timestamp columns return `Date` objects, so tests are not affected.
- Constraint errors carry the SQLSTATE on `error.cause.code`: 23505 unique, 23514 check, 23503 missing parent on insert, 23001 restrict on delete.

#### Exact versions

- @electric-sql/pglite 0.5.9 (PostgreSQL 18.6), dev-only.
- Ad hoc only: @electric-sql/pglite-socket 0.2.12 with @electric-sql/pglite 0.5.9 (an exact peer pair), through `npx`. pglite-socket also requires seven PGlite extension packages as exact peers; npx installs them into its cache, outside the lockfile and `npm audit`. The command therefore omits `-y`, so npx lists the packages and asks before installing. pglite-server binds to `127.0.0.1` by default.
- Upgrade candidate: @electric-sql/pglite 0.5.12 once it is two weeks old (on or after 2026-11-09), paired with pglite-socket 0.2.15 for the smoke test.

#### Verified snippets

`packages/database/src/testing.ts` (integration run; internal in M1-03, not exported):

```ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Database } from "./db.ts";
import { migrationsFolder } from "./migrate.ts";
import * as schema from "./schema/index.ts";

/** In-process PostgreSQL (PGlite, WASM) with every migration applied. Tests only. */
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
```

`packages/database/src/db.ts`:

```ts
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema/index.ts";

/** Works for both node-postgres (production) and PGlite (tests). */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
```

Manual production-path smoke test with two terminals (revision 2). `pglite-server --include-database-url --run` sets `DATABASE_URL`, which the migration CLI no longer reads, so the server runs on its own.

Terminal 1, from the repository root (npx lists the packages and asks before installing; answer only after checking the list; stop the server with Ctrl+C afterwards):

```sh
npx -p @electric-sql/pglite-socket@0.2.12 -p @electric-sql/pglite@0.5.9 pglite-server --port 54329
```

Terminal 2: put this line into `packages/database/.env` (ignored by Git; works the same in PowerShell, `cmd.exe` and Git Bash), then run the migration twice:

```text
DATABASE_MIGRATION_URL=postgresql://postgres:postgres@127.0.0.1:54329/postgres?sslmode=disable
```

```sh
npm run db:migrate -w @mymandev/database
```

Verified in Section 2.5 with pglite-server 0.2.12 started from a local install and `node --env-file-if-exists=.env src/migrate-cli.ts` (the command the npm script runs): "Migrations applied.", exit 0, both times. Running through `npx` and `npm run` in two terminals was not repeated in revision 2.

#### Needs Project Manager decision

- Accept PGlite (PostgreSQL 18.6) as the M1-03 evidence that migrations create the full schema on an empty PostgreSQL database, or require one run against a real PostgreSQL 18 server before merge (P-32).
- Add a CI job with a real PostgreSQL 18 service container once CI exists (P-33).

### ADR 0013: M1 data model conventions and the M1-03 tables

- Status: Proposed
- Lands in: M1-03. Database entities consumed by desktop and cloud are a shared boundary.

#### Context

Issue #21 lists users, devices, projects, repositories, agents, conversations, messages, permission grants and agent runs. Identities must match the protocol (ADR 0004 to ADR 0008). Permission grants depend on M1-06. Users and devices depend on the account model decision (#15). Destructive migrations are out of scope.

#### Options considered

- PostgreSQL enums or `text` with CHECK constraints (recommended, because enum changes are awkward inside Drizzle's single migration transaction).
- A generic soft-delete column or explicit lifecycle columns (recommended: `archived_at`, `disabled_at`, `revoked_at`, `removed_at`, `deleted_at` where each has a meaning).
- Database-generated or application-supplied IDs (recommended: application, ADR 0004).

#### Decision

Conventions for every table:

- `uuid` primary keys supplied by the application; no default.
- `timestamptz` everywhere; `created_at DEFAULT now() NOT NULL`; `updated_at` on mutable entities, maintained by the data layer.
- Foreign keys `ON DELETE RESTRICT`. Nothing is hard-deleted in M1.
- Ownership rules that span tables are composite foreign keys, not only application checks. A composite key targets a composite unique key on the parent (for example `devices (id, user_id)`). PostgreSQL's default `MATCH SIMPLE` skips the check when an optional column is null, which is the intended behaviour for optional repositories and for the author column that is not used.
- Vocabularies as `text` with a CHECK that matches the protocol constant, proven by a test.
- Length CHECKs that match the protocol limits for human-entered text.
- Explicit snake_case column names; TypeScript property names in camelCase.
- Production target: PostgreSQL 18, matching PGlite 18.6.

Tables (11; `workspaces` and `workspace_members` are additions to the list in #21):

| Table               | Columns                                                                                                                                                                                                                  | Constraints and indexes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`             | `id`, `display_name`, `created_at`, `updated_at`                                                                                                                                                                         | `char_length(display_name)` 1 to 64. No credentials, email or handle until #15.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `devices`           | `id`, `user_id` -> users, `label`, `platform`, `created_at`, `last_seen_at`, `revoked_at`                                                                                                                                | label 1 to 64; platform in (`windows`, `macos`, `linux`); index on `user_id`; unique (`id`, `user_id`) as composite key target.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `workspaces`        | `id`, `name`, `created_by_user_id` -> users, `created_at`, `updated_at`, `archived_at`                                                                                                                                   | name 1 to 100.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `workspace_members` | `workspace_id` -> workspaces, `user_id` -> users, `added_by_user_id` -> users, `created_at`, `removed_at`                                                                                                                | Primary key (`workspace_id`, `user_id`); index on `user_id`. Membership is visibility only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `projects`          | `id`, `workspace_id` -> workspaces, `name`, `created_by_user_id` -> users, `created_at`, `updated_at`, `archived_at`                                                                                                     | name 1 to 100; index on `workspace_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `repositories`      | `id`, `project_id` -> projects, `name`, `created_by_user_id` -> users, `created_at`, `updated_at`, `archived_at`                                                                                                         | name 1 to 100; index on `project_id`; unique (`id`, `project_id`) as composite key target. No local path; remote URL deferred to M1-05.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `agents`            | `id`, `project_id` -> projects, `owner_user_id` -> users, `host_device_id` -> devices, `name`, `created_at`, `updated_at`, `disabled_at`                                                                                 | name 1 to 64; indexes on `project_id` and `host_device_id`; unique (`id`, `project_id`), (`id`, `host_device_id`) and (`id`, `owner_user_id`) as composite key targets; (`host_device_id`, `owner_user_id`) -> devices (`id`, `user_id`): the host device belongs to the owner. Provider kind deferred to M3.                                                                                                                                                                                                                                                                                  |
| `conversations`     | `id`, `project_id` -> projects, `kind`, `title`, `created_by_user_id` -> users, `last_seq` (bigint, default 0), `created_at`                                                                                             | kind in (`project`); title 1 to 200 when set; `last_seq >= 0`; index on `project_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `messages`          | `id`, `conversation_id` -> conversations, `seq` (bigint, per conversation), `author_user_id` -> users, `author_agent_id` -> agents, `sender_device_id` -> devices, `client_event_id`, `body`, `created_at`, `deleted_at` | Exactly one author (`num_nonnulls(...) = 1`); body 1 to 16,000 characters; `seq >= 1`; unique (`conversation_id`, `seq`); unique (`sender_device_id`, `client_event_id`) where `client_event_id` is not null; (`sender_device_id`, `author_user_id`) -> devices (`id`, `user_id`); (`author_agent_id`, `sender_device_id`) -> agents (`id`, `host_device_id`).                                                                                                                                                                                                                                 |
| `permission_grants` | `id`, `project_id` -> projects, `grantee_agent_id` -> agents, `capability`, `repository_id` -> repositories, `granted_by_user_id` -> users, `created_at`, `expires_at`, `revoked_at`, `revoked_by_user_id` -> users      | capability in the six values; `provider.use` has no repository and every other capability has one; `revoked_at` and `revoked_by_user_id` set together; `expires_at` null or after `created_at`; one non-revoked grant per (agent, capability, repository), with a second partial unique index for the no-repository case; (`grantee_agent_id`, `project_id`) -> agents (`id`, `project_id`); (`repository_id`, `project_id`) -> repositories (`id`, `project_id`); if P-44 is accepted, (`grantee_agent_id`, `granted_by_user_id`) -> agents (`id`, `owner_user_id`). Provisional until M1-06. |
| `agent_runs`        | `id`, `agent_id` -> agents, `project_id` -> projects, `repository_id` -> repositories, `requested_by_user_id` -> users, `correlation_id`, `state`, `state_reason`, `created_at`, `started_at`, `finished_at`             | state in the six protocol states; `finished_at` set exactly when terminal; `state_reason` 1 to 500 when set; indexes (`agent_id`, `created_at`) and (`project_id`, `state`); (`agent_id`, `project_id`) -> agents (`id`, `project_id`); (`repository_id`, `project_id`) -> repositories (`id`, `project_id`).                                                                                                                                                                                                                                                                                  |

The message sequence is allocated per conversation in the insert transaction, so the number a client sees reveals nothing about other conversations or workspaces. A global identity column would: the gaps between two messages would show how many messages other workspaces wrote in between. The first message writer (M2-03) adds the allocation as a database package function:

```ts
// Inside db.transaction (verified on PGlite: 1, 2 in one conversation, 1 in another).
const [row] = await tx
  .update(conversations)
  .set({ lastSeq: sql`${conversations.lastSeq} + 1` })
  .where(eq(conversations.id, conversationId))
  .returning({ seq: conversations.lastSeq });
await tx.insert(messages).values({ ...values, conversationId, seq: row.seq });
```

The `UPDATE` locks the conversation row until the transaction ends, so concurrent writers to one conversation are serialized; different conversations do not wait for each other. Event sequences in M2 follow the same rule (per workspace or per run, never global).

#### Consequences

- One grant row grants exactly one capability. There is no wildcard, role or level column, so the data model cannot express an inferred capability.
- The database rejects rows that mix owners, devices and projects (8 cases verified with 23503 in Section 2.5).
- An expired grant still occupies the unique slot until it is revoked, because an index predicate cannot use `now()`. M1-06 decides whether re-granting revokes the expired row first or extends it; `isGrantActive` treats it as inactive either way.
- Server ordering of messages comes from `seq` within a conversation, never from client time.
- A device retry of the same message hits the unique (`sender_device_id`, `client_event_id`) index and fails with 23505 instead of creating a duplicate.
- Adding authentication columns later (#15) is an additive migration.
- If M1-06 changes the grant shape after M1-03 is merged, that is a new migration, possibly a destructive one. Hence P-34.

#### Exact versions

See ADR 0011.

#### Verified snippets

Permission grants (`packages/database/src/schema/agents.ts`, integration run, excerpt of the table options):

```ts
(t) => [
  index("permission_grants_project_id_idx").on(t.projectId),
  check(
    "permission_grants_capability_check",
    sql`${t.capability} in ('repo.read', 'repo.write', 'terminal.execute', 'git.commit', 'git.push', 'provider.use')`,
  ),
  // provider.use is scoped to a provider connection (M1-06), every other capability to a repository.
  check(
    "permission_grants_scope_check",
    sql`(${t.capability} = 'provider.use') = (${t.repositoryId} is null)`,
  ),
  check(
    "permission_grants_revocation_check",
    sql`(${t.revokedAt} is null) = (${t.revokedByUserId} is null)`,
  ),
  uniqueIndex("permission_grants_active_repository_key")
    .on(t.granteeAgentId, t.capability, t.repositoryId)
    .where(sql`${t.revokedAt} is null and ${t.repositoryId} is not null`),
  uniqueIndex("permission_grants_active_unscoped_key")
    .on(t.granteeAgentId, t.capability)
    .where(sql`${t.revokedAt} is null and ${t.repositoryId} is null`),
  // Revision 2 additions (verified in Section 2.5):
  check(
    "permission_grants_expiry_check",
    sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.createdAt}`,
  ),
  foreignKey({
    name: "permission_grants_agent_project_fk",
    columns: [t.granteeAgentId, t.projectId],
    foreignColumns: [agents.id, agents.projectId],
  }).onDelete("restrict"),
  foreignKey({
    name: "permission_grants_repository_project_fk",
    columns: [t.repositoryId, t.projectId],
    foreignColumns: [repositories.id, repositories.projectId],
  }).onDelete("restrict"),
  // Only if P-44 is accepted: in v0 only the agent's owner grants it a capability.
  foreignKey({
    name: "permission_grants_agent_owner_fk",
    columns: [t.granteeAgentId, t.grantedByUserId],
    foreignColumns: [agents.id, agents.ownerUserId],
  }).onDelete("restrict"),
],
```

Composite key targets and the agent's own composite key (`schema/identity.ts` and `schema/agents.ts`, excerpts; verified in Section 2.5):

```ts
// devices
unique("devices_id_user_id_key").on(t.id, t.userId),

// agents
unique("agents_id_project_id_key").on(t.id, t.projectId),
unique("agents_id_host_device_id_key").on(t.id, t.hostDeviceId),
unique("agents_id_owner_user_id_key").on(t.id, t.ownerUserId),
// The host device belongs to the agent's owner.
foreignKey({
  name: "agents_host_device_owner_fk",
  columns: [t.hostDeviceId, t.ownerUserId],
  foreignColumns: [devices.id, devices.userId],
}).onDelete("restrict"),
```

drizzle-kit 0.31.11 writes each `unique()` inline in `CREATE TABLE` and each `foreignKey()` as `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (a, b) REFERENCES ... ON DELETE restrict`, with the given names. Constraint names stay under PostgreSQL's 63-character limit.

Messages (`packages/database/src/schema/conversations.ts`, revision 2 excerpt; verified in Section 2.5):

```ts
/** Per-conversation server order, allocated from conversations.last_seq. Never supplied by clients. */
seq: bigint("seq", { mode: "number" }).notNull(),
/** Idempotency key: the event ID the sending device generated. */
clientEventId: uuid("client_event_id").$type<EventId>(),
```

```ts
unique("messages_conversation_id_seq_key").on(t.conversationId, t.seq),
uniqueIndex("messages_sender_device_client_event_key")
  .on(t.senderDeviceId, t.clientEventId)
  .where(sql`${t.clientEventId} is not null`),
check("messages_author_check", sql`num_nonnulls(${t.authorUserId}, ${t.authorAgentId}) = 1`),
check("messages_seq_check", sql`${t.seq} >= 1`),
check("messages_body_length", sql`char_length(${t.body}) between 1 and 16000`),
// A user's message comes from one of that user's devices.
foreignKey({
  name: "messages_sender_device_user_fk",
  columns: [t.senderDeviceId, t.authorUserId],
  foreignColumns: [devices.id, devices.userId],
}).onDelete("restrict"),
// An agent's message comes from the agent's host device.
foreignKey({
  name: "messages_agent_host_device_fk",
  columns: [t.authorAgentId, t.senderDeviceId],
  foreignColumns: [agents.id, agents.hostDeviceId],
}).onDelete("restrict"),
```

Constraint behaviour proven on PGlite. Rows marked "rev 1" come from the integration run (database tests, 9/9 passed); rows marked "rev 2" from the revision 2 experiment (Section 2.5):

| Case                                                                            | Result                 | Run          |
| ------------------------------------------------------------------------------- | ---------------------- | ------------ |
| `server_version_num` of the test database                                       | 18xxxx (18.6)          | rev 1        |
| CHECK lists for capability, run state and platform equal the protocol constants | equal                  | rev 1        |
| Messages in two conversations                                                   | `seq` 1, 2 and 1       | rev 2        |
| Same (`conversation_id`, `seq`) again                                           | 23505                  | rev 2        |
| Same (`sender_device_id`, `client_event_id`) again                              | 23505                  | rev 1, rev 2 |
| Message with two authors; empty body                                            | 23514; 23514           | rev 1        |
| One grant per capability (provider.use without repository)                      | all accepted           | rev 1        |
| Second active grant for the same capability and repository                      | 23505                  | rev 1        |
| `repo.read` without repository; `provider.use` with repository; `repo.*`        | 23514 each             | rev 1        |
| Revoke `git.push`, then grant it again                                          | accepted               | rev 1        |
| `expires_at` before `created_at`                                                | 23514                  | rev 2        |
| The 8 inconsistent rows listed in Section 2.5                                   | 23503 each             | rev 2        |
| `completed` without `finished_at`; `running` with `finished_at`                 | 23514; 23514           | rev 1        |
| Device whose user does not exist                                                | 23503                  | rev 1        |
| Delete a user that devices reference                                            | 23001                  | rev 1        |
| Update a project                                                                | `updated_at` increases | rev 1        |

#### Needs Project Manager decision

- Include `permission_grants` in M1-03 as provisional and hold the M1-03 merge until the M1-06 grant shape is agreed (recommended), or ship M1-03 without it and add the table in a follow-up migration after M1-06 (P-34).
- Grantee model: agents only in v0 (recommended), or a subject type and subject ID pair (P-35).
- Only the agent's owner may grant it a capability in v0, enforced by a composite foreign key (P-44).
- Message body limit of 16,000 characters, `client_event_id` idempotency and a per-conversation `seq` (P-36).
- PostgreSQL 18 as the production target (P-37).
- No `handle` or credentials on `users` until #15 is decided (P-38).

## 4. Implementation plan for the stacked pull requests

### 4.1 Common workflow

- One pull request per task, one topic per pull request. Each pull request body follows `.github/pull_request_template.md` (What this does, Why, What this does not do, Checks, Related issue) and closes its issue (`Closes #19`, `Closes #20`, `Closes #21`). No AI attribution anywhere; the identity-guard workflow checks this.
- Branches and bases (stacked in the agreed order):

| PR    | Branch                              | Created from                 | PR base                      | Issue |
| ----- | ----------------------------------- | ---------------------------- | ---------------------------- | ----- |
| M1-01 | `feature/m1-01-protocol-v0`         | fresh `origin/develop`       | `develop`                    | #19   |
| M1-02 | `feature/m1-02-api-skeleton`        | `feature/m1-01-protocol-v0`  | `feature/m1-01-protocol-v0`  | #20   |
| M1-03 | `feature/m1-03-postgresql-baseline` | `feature/m1-02-api-skeleton` | `feature/m1-02-api-skeleton` | #21   |

- Pull requests are opened for review and not merged; the Project Manager merges. A fix to the protocol found while building M1-02 or M1-03 is committed on the M1-01 branch and merged upward with `git merge`, never by rebasing.
- Checks on stacked pull requests. `identity-guard.yml` (on `develop`) and `check.yml` (PR #46) run only for pull requests whose base is `develop` or `main` (`on.pull_request.branches: [develop, main]`). M1-02 targets `feature/m1-01-protocol-v0` and M1-03 targets `feature/m1-02-api-skeleton`, so neither gets any automatic check, including the identity guard, until it is retargeted. Until P-45 removes the `branches:` filter under `pull_request:`, the rule is: run `npm ci` and `npm run check` locally on every stacked branch and report the result in the pull request, and merge a stacked pull request only after it targets `develop` and its checks pass there.
- Retargeting is not automatic in this repository. GitHub retargets dependent pull requests only when the merged head branch is deleted, and the repository has `delete_branch_on_merge: false` (verified with `gh api`). If M1-01 is merged and its branch is kept, pressing Merge on M1-02 merges it into `feature/m1-01-protocol-v0`, not into `develop`. After merging the lower pull request, and before reviewing or merging the next one:
  1. delete the merged branch or run `gh pr edit <number> --base develop`;
  2. on the next branch, run `git fetch origin` and `git merge origin/develop`, resolve conflicts (lockfile: Section 5.2) and push;
  3. wait for the checks on the retargeted pull request.
- npm quirk (reproduced in the research): after creating a new workspace `package.json`, run a plain `npm install` once before `npm install <package> -w @mymandev/<name>`; otherwise the first `-w` install links the workspace but silently does not save the dependency. Check the workspace `package.json` after every install.
- Every pull request runs, from a clean install: `npm ci` and `npm run check`, and reports the `# tests` count of each workspace, which must equal the number listed in its section (`node --test` exits 0 when no file matches). Each section below lists the additional checks.
- Before implementation, each pull request states the task, the affected boundaries, the expected files, what is deliberately not changing and the required verification, as `CLAUDE.md` requires. The subsections below provide this.

### 4.2 M1-01 Protocol v0 (`packages/protocol`, first workspace)

Task: define protocol v0 as the typed workspace package `@mymandev/protocol` and introduce the root workspace delegation for `typecheck` and `test`.

Affected boundaries: the protocol (shared with the desktop owner), the root `package.json` scripts, `package-lock.json`, `docs/development/WORKSPACE.md`, and the new `docs/architecture/decisions/`.

Files:

| File                                                   | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol/package.json`                       | As in ADR 0001.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/protocol/tsconfig.json`, `tsconfig.src.json` | As in ADR 0001.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/protocol/README.md`                          | Consumer rules: a device decodes server events with `decodeEvent`, the server decodes device events with `decodeClientEvent` and treats the result as `UnverifiedEvent` until identity binding (never cast to `ProtocolEvent` or a verified type); call `enableJitlessValidation()` in the renderer; render human text as text; never use `newId` or `newUuidV7` for secrets (32 random bytes, stored as a SHA-256 hash); import only from `@mymandev/protocol`; change the protocol only by agreement.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/protocol/src/model.ts`                       | `PROTOCOL_VERSION`, `CAPABILITIES`, `RUN_STATES`, `INITIAL_RUN_STATE`, `TERMINAL_RUN_STATES`, `RUN_TRANSITIONS`, `canTransition`, `isTerminalRunState`, `DEVICE_PLATFORMS`, `UUIDV7_PATTERN`, `EVENT_TYPE_PATTERN`, `SAFE_TEXT_PATTERN`, `NOT_BLANK_PATTERN`, `LIMITS`. No capability check (ADR 0008). No zod import.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/protocol/src/ids.ts`                         | Nine branded ID schemas and types, `AnyId`, `newId<T>()`, `newUuidV7()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/protocol/src/entities.ts`                    | `displayText()`, `CapabilitySchema`, `RunStateSchema`, `DevicePlatformSchema`, and the entity schemas and types for User, Device, Workspace, Project, Repository, Agent and AgentRun.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/protocol/src/envelope.ts`                    | `ActorSchema`, `UtcTimestampSchema`, `envelopeHeaderShape`, `AgentRunStateChangedPayloadSchema`, `AgentRunStateChangedEventSchema`, `ProtocolEventSchema`, `ProtocolEvent`, `EVENT_TYPES`, `actorAllowed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/protocol/src/decode.ts`                      | `decodeEvent`, `DecodeResult`, `DecodeErrorCode`, `decodeClientEvent`, `ClientDecodeResult`, `ClientDecodeErrorCode`, `UnverifiedEvent`, `enableJitlessValidation`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/protocol/src/index.ts`                       | Re-exports the five modules.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/protocol/src/*.test.ts`                      | Tests listed below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `package.json` (root)                                  | `typecheck`, `test` and (if P-04 is accepted) `check` as in ADR 0002. No new devDependencies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `package-lock.json`                                    | Adds the workspace, zod 4.6.7, uuid 14.0.3 and @types/node 24.19.2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `docs/development/WORKSPACE.md`                        | Update the root scripts table (`typecheck`, `test`, `check`) and the sentence on line 44 that says workspace type checks are "added together with the first workspace". Keep the heading `### Root typecheck delegation` unchanged, because the anchor `#root-typecheck-delegation` is linked from lines 44, 103 and 163; state in that section that the delegation is now applied. Add a separate `### Root test delegation`. Add "Internal packages" (ADR 0001 rules, the consumer tsconfig, the `0.0.0` version rule) and "Tests" (ADR 0002, including "a workspace `test` script runs once and exits; with Vitest use `vitest run`"); add the `npm install` quirk to "Adding a workspace". "Desktop workspace contract" changes only if the desktop owner agrees under P-02, and then by exactly one line: "The root `typecheck` and `test` delegation already exists; do not change the root scripts." |
| `docs/architecture/decisions/README.md`                | Index and template (Section 4.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/architecture/decisions/0001-...` to `0008-...`   | ADRs 0001 to 0008 with Status: Proposed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Commands:

```sh
git fetch origin
git worktree add -b feature/m1-01-protocol-v0 ../mymandev-ai-workspace-m1-01 origin/develop
# In the new worktree: create packages/protocol/package.json without dependencies, then:
npm install
npm install zod@4.6.7 uuid@14.0.3 -w @mymandev/protocol
npm install -D @types/node@24.19.2 -w @mymandev/protocol
npm ls zod uuid @types/node
```

Tests to write (`node:test`; one bullet is one `test()` call; 15 in total):

- `model.test.ts` (3):
  1. The capability list is exactly the six names in order, and `CapabilitySchema` rejects `repo.*`, `REPO.READ` and an unknown string.
  2. Every (from, to) state pair, including `from = null`, matches `RUN_TRANSITIONS`; `null` leads only to `queued`.
  3. Terminal states have no outgoing transition.
- `ids.test.ts` (3):
  1. Generated IDs match `UUIDV7_PATTERN` and sort in creation order.
  2. An uppercase UUIDv7 and a version 4 UUID are rejected.
  3. A `// @ts-expect-error` line proves that a `UserId` is not assignable to `DeviceId` (checked by `tsc`).
- `entities.test.ts` (2):
  1. `displayText` accepts Latin, Turkish, Arabic, Persian with ZWNJ, Devanagari with ZWJ, CJK, a ZWJ emoji sequence, a skin tone, VS16, a flag and a keycap.
  2. `displayText` rejects the empty string, whitespace-only text, text over the limit, C0 and C1 controls, each bidirectional formatting character (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), U+200B, U+2060, U+FEFF, U+2028, U+2029, U+00AD, tag characters, a lone surrogate, U+FFF9, a private-use character, U+3164, U+115F, U+FFA0 and U+034F, all written as escapes.
- `decode.test.ts` (7):
  1. The 19 classification cases from ADR 0006 (table-driven; the base event uses an `agent` actor whose ID matches the payload).
  2. Every allowed transition decodes.
  3. Unknown keys at both levels and `__proto__` and `constructor` keys from `JSON.parse` are stripped.
  4. The input is not mutated.
  5. `z.toJSONSchema(..., { io: "input" })` works, contains `SAFE_TEXT_PATTERN`, and every exported pattern compiles with the `u` flag.
  6. Actor rule: a `user` actor and an `agent` actor with another agent's ID return `invalid_actor`; a server-created run (`system`, `deviceId: null`, `null -> queued`) decodes with `decodeEvent`.
  7. `decodeClientEvent` returns `not_allowed_from_device` for a `system` actor, `deviceId: null` and `previousState: null`, passes on decode failures such as `unsupported_version`, and accepts a valid agent transition.

Acceptance checks:

| Check                                                                                                                                           | Expected                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm ci` then `npm run check`                                                                                                                   | Exit 0, including both protocol type checks and the protocol tests; the protocol reports `# tests 15`.                                                                                                                                                                                     |
| `npm ls zod`                                                                                                                                    | One zod 4.6.7.                                                                                                                                                                                                                                                                             |
| Temporary negative checks, not committed: `process.env` in a `src` file; an `enum`; an import of `./model` without `.ts`; `new Set(a).union(b)` | `tsc -p packages/protocol/tsconfig.src.json` fails with TS2591, TS1294, TS2835 and TS2550 (the first three verified in the integration run, TS2550 in Section 2.5). `tsconfig.json` alone does not report TS2591 or TS2550. TS2835 suggests `./model.js`; the correct fix is `./model.ts`. |
| Bidirectional character scan (below), in Git Bash, PowerShell or a macOS/Linux shell                                                            | Prints nothing and exits 0 (verified on Windows in Section 2.5). Replaces `git grep -P`, which needs a Git built with PCRE and may fail on macOS.                                                                                                                                          |
| Desktop owner review                                                                                                                            | The "both reviewed and agreed" checkbox on #19 is ticked by the people, not by the assistant.                                                                                                                                                                                              |

Bidirectional character scan (it reads every tracked file; it can later become the P-39 script):

```sh
node -e "const {execFileSync:x}=require('node:child_process'),fs=require('node:fs');const re=/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;let bad=0;for(const f of x('git',['ls-files','-z']).toString().split('\0').filter(Boolean)){if(re.test(fs.readFileSync(f,'utf8'))){console.log(f);bad=1}}process.exit(bad)"
```

Deliberately not changing: `apps/*`, `tsconfig.base.json`, the root `tsconfig.json`, `eslint.config.mjs`, `.prettierignore`, `.editorconfig`, the CI workflows, WebSocket messages (M2-01), the permission grant shape and any capability check (M1-06), authentication and the join flow (#14, #15), and the database.

### 4.3 M1-02 Cloud API skeleton (`apps/api`)

Task: add the runnable API application `@mymandev/api` with configuration, `GET /health` and a WebSocket gateway that validates protocol events.

Affected boundaries: the new `apps/api` workspace and `package-lock.json`. The root scripts are already in place from M1-01.

Files:

| File                                                             | Content                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/package.json`                                          | Scripts `dev`, `start`, `typecheck`, `test` (ADR 0010); dependencies below.                                                                                  |
| `apps/api/tsconfig.json`                                         | ADR 0001 options plus `"resolveJsonModule": true`.                                                                                                           |
| `apps/api/.env.example`                                          | The six variables with their defaults (ADR 0010).                                                                                                            |
| `apps/api/README.md`                                             | Documented start command (required by #20), variables, endpoints, close codes, the Origin rule, the "no credentials in URLs" rule, and what is not included. |
| `apps/api/src/config.ts`                                         | `loadConfig`, `Config`, `ConfigError`.                                                                                                                       |
| `apps/api/src/app.ts`                                            | `buildApp(options)` with the hardened defaults, error and not-found handlers, logger serializers, WebSocket plugin, `/health`.                               |
| `apps/api/src/log.ts`                                            | `serializeRequest`, `serializeError` (ADR 0009).                                                                                                             |
| `apps/api/src/gateway.ts`                                        | `registerGateway`, `originGuard`, `EventHandler`, `ConnectionContext`, `ConnectionIdentity`, `CloseCode`.                                                    |
| `apps/api/src/server.ts`                                         | Entry point: configuration, signals, listen.                                                                                                                 |
| `apps/api/src/*.test.ts`                                         | Tests listed below.                                                                                                                                          |
| `package-lock.json`                                              | Adds the workspace and its dependencies.                                                                                                                     |
| `docs/architecture/decisions/0009-...`, `0010-...`, README index | ADRs 0009 and 0010.                                                                                                                                          |

Commands:

```sh
# Create apps/api/package.json without dependencies, then:
npm install
npm install fastify@5.12.7 @fastify/websocket@11.3.4 zod@4.6.7 @mymandev/protocol -w @mymandev/api
npm install -D @types/node@24.19.2 @types/ws@8.18.2 -w @mymandev/api
npm ls zod ws pino
```

Expected `apps/api/package.json` dependencies (integration run): `"@fastify/websocket": "11.3.4"`, `"@mymandev/protocol": "0.0.0"`, `"fastify": "5.12.7"`, `"zod": "4.6.7"`; devDependencies `"@types/node": "24.19.2"`, `"@types/ws": "8.18.2"`.

Tests to write (one bullet is one `test()` call; 20 in total; the integration run had 14 of the earlier set):

- `config.test.ts` (5):
  1. Defaults, including `API_HOST` `127.0.0.1` and an empty origin list.
  2. Known variables are read, empty strings count as unset, other variables are ignored, the result is frozen.
  3. Rejection of `80.5`, `0x50`, `8e1`, ` 80`, `true`, `-1`, `65536`, `080`, `1_000`, a zero body limit, an unknown `NODE_ENV` and an unknown log level.
  4. `API_HOST` rejects `0.0.0.0`, `::`, a LAN address and a host name and accepts `::1`; `API_ALLOWED_ORIGINS` parses a comma-separated list and rejects a trailing slash, a path, `file://`, `null`, `*` and `app://desktop`.
  5. Errors name the variable and never contain the value (every variable set to a secret-looking value).
- `app.test.ts` (7):
  1. `/health` returns exactly `{ status, version }`.
  2. Unknown route: the generic 404 body, no method or path echoed.
  3. Errors thrown with a secret message and `statusCode` 200, 302, 0, 404 and 500: the body never contains the secret; 404 says "Not Found", the others the generic 500 body.
  4. A schema validation failure returns 400 with Fastify's message.
  5. A body over the limit returns 413.
  6. A JSON body with `__proto__` returns 400.
  7. Captured logs for requests with `?token=...` (a route, an unknown route and a failing route) never contain the token, and `serializeError` redacts an error that carries `params`.
- `gateway.test.ts` (8; call `await app.ready()` before the first `injectWS`):
  1. A valid event reaches `onEvent` decoded and stripped, with `identity: null`.
  2. A binary frame closes with 1003.
  3. Invalid JSON closes with 1007.
  4. `malformed`, `unsupported_version`, `unknown_type`, `invalid_payload` and `invalid_actor` each close with 1008 and that reason.
  5. A `system` actor, `deviceId: null` and a run creation each close with 1008 `not_allowed_from_device`.
  6. An invalid frame followed by 50 valid events in the same tick: `onEvent` is never called.
  7. A 70 KB frame closes with 1009.
  8. `Origin: https://evil.example` gets 403; a listed origin and a request without Origin connect.

Acceptance checks:

| Check                                                                                                                                                                                                 | Expected                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm ci` then `npm run check`                                                                                                                                                                         | Exit 0; the API reports `# tests 20`.                                                    |
| `npm run start -w @mymandev/api`, then `curl http://127.0.0.1:3000/health`                                                                                                                            | `{"status":"ok","version":"0.0.0"}` and a JSON "Server listening" log line.              |
| A WebSocket client without an Origin header (Node's global `WebSocket`) connects to `ws://127.0.0.1:3000/ws`                                                                                          | The connection is accepted (#20: "the WebSocket gateway accepts a connection").          |
| `curl -i -H "Origin: https://evil.example" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://127.0.0.1:3000/ws` | `HTTP/1.1 403`.                                                                          |
| Ctrl+C on the running server                                                                                                                                                                          | "shutting down" is logged and the process exits with code 0 (research run: about 23 ms). |
| Git Bash, in `apps/api`: `API_PORT=0x50 node src/server.ts`; `API_HOST=0.0.0.0 node src/server.ts`                                                                                                    | Exit 1 each time; the message names the variable; the value is not printed.              |
| `npm audit --omit=dev`                                                                                                                                                                                | 0 vulnerabilities.                                                                       |
| `git status` after `npm run dev` with a local `apps/api/.env`                                                                                                                                         | `.env` is not listed (ignored).                                                          |

Deliberately not changing: `packages/protocol` (any needed change goes to the M1-01 branch), the root scripts, the database, authentication, identity binding (`bindIdentity`, M2), rate limits, CORS, OpenAPI, deployment, CI and the WebSocket message protocol (M2-01).

### 4.4 M1-03 PostgreSQL baseline (`packages/database`)

Task: add `@mymandev/database` with the schema, generated migrations, a migration command, a test database helper and constraint tests.

Affected boundaries: the new `packages/database` workspace, database entities consumed by desktop and cloud (shared), the root `.prettierignore` and `.editorconfig`, `package-lock.json`.

Files:

| File                                                                                                              | Content                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database/package.json`                                                                                  | As in ADR 0011.                                                                                                                                                                                                                               |
| `packages/database/tsconfig.json`                                                                                 | ADR 0001 options; `include` adds `drizzle.config.ts`.                                                                                                                                                                                         |
| `packages/database/drizzle.config.ts`                                                                             | As in ADR 0011.                                                                                                                                                                                                                               |
| `packages/database/.env.example`                                                                                  | `DATABASE_MIGRATION_URL=postgres://mymandev_migrator:change-me@127.0.0.1:5432/mymandev?sslmode=disable` (an obvious placeholder, not a credential).                                                                                           |
| `packages/database/README.md`                                                                                     | Local PostgreSQL 18 setup (required by #21) with the two roles from ADR 0011, the commands, the migration rules from ADR 0011, the `sslmode=verify-full` rule for production, and the pglite-server smoke test.                               |
| `packages/database/migrations/0000_init.sql`, `migrations/meta/*`                                                 | Generated by drizzle-kit; never edited by hand.                                                                                                                                                                                               |
| `packages/database/src/schema/columns.ts`                                                                         | `createdAt()`, `updatedAt()`, `nullableTimestamp()`.                                                                                                                                                                                          |
| `packages/database/src/schema/identity.ts`                                                                        | `users`, `devices`.                                                                                                                                                                                                                           |
| `packages/database/src/schema/workspaces.ts`                                                                      | `workspaces`, `workspaceMembers`, `projects`, `repositories`.                                                                                                                                                                                 |
| `packages/database/src/schema/agents.ts`                                                                          | `agents`, `agentRuns`, `permissionGrants` (the grants may move to their own `grants.ts`).                                                                                                                                                     |
| `packages/database/src/schema/conversations.ts`                                                                   | `conversations`, `messages`.                                                                                                                                                                                                                  |
| `packages/database/src/schema/index.ts`                                                                           | Re-exports.                                                                                                                                                                                                                                   |
| `packages/database/src/db.ts`, `client.ts`, `errors.ts`, `migrate.ts`, `migrate-cli.ts`, `testing.ts`, `index.ts` | As in ADR 0011 and ADR 0012. `index.ts` exports the schema, `Database`, `createDatabase`, `checkDatabaseUrl`, `migrationsFolder`, `runMigrations`, `DatabaseError`, `toDatabaseError` and `withDatabaseErrors`. `testing.ts` is not exported. |
| `packages/database/src/schema.test.ts`, `client.test.ts`, `migrations.test.ts`                                    | Tests listed below.                                                                                                                                                                                                                           |
| `.prettierignore` (root)                                                                                          | The two lines from ADR 0011.                                                                                                                                                                                                                  |
| `.editorconfig` (root)                                                                                            | The `[packages/database/migrations/**]` section from ADR 0011.                                                                                                                                                                                |
| `package-lock.json`                                                                                               | Adds the workspace and its dependencies.                                                                                                                                                                                                      |
| `docs/architecture/decisions/0011-...` to `0013-...`, README index                                                | ADRs 0011 to 0013.                                                                                                                                                                                                                            |

Commands:

```sh
# Create packages/database/package.json without dependencies, then:
npm install
npm install drizzle-orm@0.45.4 pg@8.23.1 @mymandev/protocol -w @mymandev/database
npm install -D drizzle-kit@0.31.11 @electric-sql/pglite@0.5.9 @types/pg@8.23.1 @types/node@24.19.2 -w @mymandev/database
npm ls @electric-sql/pglite
# Write the schema, then generate the first migration:
npm run db:generate -w @mymandev/database -- --name init
```

Tests to write (one bullet is one `test()` call; 14 in total):

- `schema.test.ts` (12, one shared PGlite instance; test 12 creates its own):
  1. The server version is 18.
  2. The CHECK lists for capability, run state and platform equal the protocol constants in both directions.
  3. Message sequence: a test helper allocates `seq` from `conversations.last_seq` in a transaction (ADR 0013); two conversations get 1, 2 and 1; a duplicate (`conversation_id`, `seq`) fails with 23505.
  4. Messages: a repeated (`sender_device_id`, `client_event_id`) fails with 23505; two authors and an empty body fail with 23514.
  5. Grants: one row per capability is accepted; a duplicate active grant fails with 23505; wrong scoping and `repo.*` fail with 23514; a grant is accepted again after revocation; `expires_at` not after `created_at` fails with 23514.
  6. Composite foreign keys: the 8 inconsistent rows from Section 2.5 each fail with 23503 (7 if P-44 is rejected), and consistent rows with null optional columns are accepted.
  7. Run state and `finished_at` consistency (23514).
  8. 23503 for a missing parent and 23001 for deleting a referenced user.
  9. `updated_at` increases on update.
  10. The brand mismatch `@ts-expect-error` (checked by `tsc`).
  11. A duplicate insert whose row contains a secret: the raw error's message contains it (documents the risk); `toDatabaseError` returns code 23505 and the constraint name, and neither its message, stack nor JSON contains the secret; `withDatabaseErrors` rethrows a `DatabaseError`. (The API's serializer is tested in M1-02 with a synthetic error, because a package must not import from an app.)
  12. Roles: on a fresh PGlite, migrations run as `mymandev_migrator`; as `mymandev_app`, INSERT and UPDATE work and DELETE, TRUNCATE, CREATE TABLE, DROP TABLE and reading the migration journal fail with 42501.
- `client.test.ts` (1, no database): `checkDatabaseUrl` accepts no `sslmode`, `disable` and `verify-full`; rejects `bogus`, `require`, `prefer`, `verify-ca`, `no-verify`, `uselibpqcompat` and a non-PostgreSQL scheme; requires `verify-full` in production; never includes the password in its message.
- `migrations.test.ts` (1, no database): journal order (ADR 0011).

Acceptance checks:

| Check                                                                                                                  | Expected                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm ci` then `npm run check`                                                                                          | Exit 0; the database reports `# tests 14`.                                                 |
| `npm run db:check -w @mymandev/database`; then `npm run db:generate -w @mymandev/database`                             | "Everything's fine"; "No schema changes, nothing to migrate".                              |
| `npm ls @electric-sql/pglite` and the lockfile key                                                                     | One copy; key `node_modules/@electric-sql/pglite`, not nested.                             |
| `npm query ":attr(scripts, [postinstall]), :attr(scripts, [install]), :attr(scripts, [preinstall])"`                   | Exactly esbuild 0.18.20, 0.25.12 and 0.28.2.                                               |
| The two-terminal pglite-server smoke test from ADR 0012                                                                | "Migrations applied.", exit 0, on both runs.                                               |
| `npm run db:migrate -w @mymandev/database` without `DATABASE_MIGRATION_URL` and without `.env`                         | ".env not found. Continuing without it." and "DATABASE_MIGRATION_URL is not set.", exit 1. |
| Against a real PostgreSQL 18 with the two roles, if P-32 requires it: `npm run db:migrate -w @mymandev/database` twice | First run applies `0000_init`; the second run applies nothing; the app role cannot DELETE. |
| `npm audit --omit=dev`; `npm audit`                                                                                    | 0; only the 4 known moderate drizzle-kit findings.                                         |
| `git status`                                                                                                           | No `.env`, no database files.                                                              |

Deliberately not changing: `apps/api` (no database wiring and no endpoints, as #21 excludes them), `packages/protocol` (contract fixes go to the M1-01 branch), root scripts, authentication, destructive migrations and production hosting.

### 4.5 ADR files added by each pull request

All files go to `docs/architecture/decisions/`, start with Status: Proposed, and are formatted by Prettier.

| PR    | Files                                                                                                                                                                                                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1-01 | `README.md` (index and template), `0001-internal-packages-export-typescript-source.md`, `0002-node-test-runner.md`, `0003-zod-runtime-validation.md`, `0004-uuidv7-identifiers.md`, `0005-workspaces-contain-projects.md`, `0006-event-envelope-v0.md`, `0007-agent-run-lifecycle-v0.md`, `0008-capability-vocabulary-v0.md` |
| M1-02 | `0009-fastify-cloud-api.md`, `0010-api-configuration-and-runtime.md`, and two new lines in the README index                                                                                                                                                                                                                  |
| M1-03 | `0011-drizzle-sql-migrations.md`, `0012-pglite-database-tests.md`, `0013-m1-data-model.md`, and three new lines in the README index                                                                                                                                                                                          |

Template in `README.md` (revision 2: committed ADRs do not copy code or exact versions):

```markdown
# ADR NNNN: Title

- Status: Proposed | Accepted | Superseded by ADR NNNN
- Date: YYYY-MM-DD
- Decided by: (filled in by the Project Manager on acceptance)

## Context

## Options considered

## Decision

## Consequences

## Dependency policy

Library, major version and pin rule only. Exact versions live in package.json and package-lock.json.

## Evidence

Links to the files and tests that implement the decision, and to the review record.

## Needs Project Manager decision
```

An ADR file keeps the decision and its reasons, which do not change with every patch release. It states the policy ("fastify 5.x, exact pin, follow security releases") and links to `apps/api/src/app.ts` and its tests instead of copying them, so an upgrade (for example PGlite 0.5.12 from 2026-11-09, or the next Fastify security release) does not leave an accepted ADR wrong. This decision document remains the review record with the exact versions and the verified snippets of 2026-10-27; the Project Manager decides where it is kept (for example as a comment on #19), and each pull request links to it.

When the Project Manager accepts an ADR, its status becomes Accepted with the date, and "Needs Project Manager decision" records the answers.

## 5. Risks and conflicts with the parallel desktop work

### 5.1 Files that both sides change

| File                            | Desktop PR (#3)                                                                                     | M1 PRs                                                                                                                                                | Conflict risk                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `package.json` (root)           | Applies the `typecheck` delegation if it is the first workspace                                     | M1-01 adds `typecheck`, `test` and possibly `check`                                                                                                   | Likely, small, in the `scripts` block                         |
| `package-lock.json`             | Adds `apps/desktop`, Electron, React and the bundler                                                | Every M1 PR adds a workspace                                                                                                                          | Certain                                                       |
| `docs/development/WORKSPACE.md` | May change "Desktop workspace contract" and the ignore rules. PR #46 (CI) also edits lines 43 to 46 | M1-01 changes the root scripts table, line 44, the "Root typecheck delegation" body, and adds "Root test delegation", "Internal packages" and "Tests" | Likely with PR #46 (same lines); possible with the desktop PR |
| `.gitignore`, `.prettierignore` | May add build output directories                                                                    | M1-03 adds `migrations/meta/` to `.prettierignore`                                                                                                    | Possible, small                                               |
| `.editorconfig` (root)          | May add sections                                                                                    | M1-03 adds the `[packages/database/migrations/**]` section                                                                                            | Possible, small                                               |
| `.github/workflows/*.yml`       | Electron download and caching in CI (PR #46 or later)                                               | None in M1; P-45 asks to drop the `branches:` filter under `pull_request:`                                                                            | Small, separate pull request                                  |
| `eslint.config.mjs` (root)      | May add global ignores                                                                              | None                                                                                                                                                  | None from M1                                                  |
| `docs/architecture/decisions/`  | May add ADRs (bundler, packaging)                                                                   | Adds 0001 to 0013 and the README index                                                                                                                | Numbering and index                                           |

### 5.2 Mitigations

1. Agree the root `scripts` block with the desktop owner before either pull request lands (the exact text is in ADR 0002). The second pull request to land keeps one copy of each line when it merges `develop`.
2. Resolve lockfile conflicts by regeneration, never by hand. On the task branch:

   ```sh
   git fetch origin
   git merge origin/develop
   # If package-lock.json conflicts, take the develop version, which is "theirs" in this merge:
   git checkout --theirs package-lock.json
   npm install
   npm ci
   npm run check
   git add package-lock.json
   git commit
   ```

   `npm install` keeps every resolution from `develop` and adds the branch's workspaces from their `package.json` files. Do not delete the lockfile; that would re-resolve every transitive version.

3. M1-01 keeps the heading and anchor `#root-typecheck-delegation`, so the links on lines 44, 103 and 163 stay valid. It edits the "Desktop workspace contract" section only with the desktop owner's agreement under P-02, and then by one line: line 163 ("The same pull request applies the root typecheck delegation") becomes "The root `typecheck` and `test` delegation already exists; do not change the root scripts." Without that agreement, the desktop pull request makes this change when it merges `develop`. The new sections ("Root test delegation", "Internal packages", "Tests") are added in separate places. Whichever of PR #46 and M1-01 lands second merges `develop` and keeps both changes to lines 43 to 46.
4. ADR numbers 0001 to 0013 are reserved for M1 as listed in Section 4.5. A desktop ADR takes the next free number when it is merged, and the README index only gets lines appended (P-43).
5. The desktop consumes the protocol under the ADR 0001 rules: renderer tsconfig flags, main and preload bundled, imports only by package name. If the desktop imports zod directly, it pins 4.6.7; a second zod copy would not be affected by `enableJitlessValidation()` and would break `instanceof` checks on zod errors.
6. @types/node and Electron. `electron@latest` is 45.0.0 and depends on `@types/node ^24.9.0`, which 24.19.2 satisfies, so npm installs one shared copy. A nested second copy appears only if the desktop picks an older Electron whose range excludes 24.19.2. Each workspace declares its own @types/node, and the protocol's `types: []` check keeps its source independent of any Node types either way.
7. Vitest stays inside `apps/desktop` if the desktop chooses it, pinned to the desktop's Vite, with `"test": "vitest run"`. The root `test` delegation runs each workspace's script in turn (verified in the research); a script in watch mode would block it, which is why the run-once rule is part of WORKSPACE.md and the desktop contract. Nobody runs `node --test` at the root.
8. The CI workflow (PR #46) runs `npm ci` and `npm run check` on Ubuntu, Windows and macOS with a 15-minute timeout, for pull requests into `develop` or `main` only. Stacked M1 pull requests therefore run nothing until they are retargeted (Section 4.1, P-45). Locally, `npm ci` took about 33 s and `npm run check` 22 s for all three M1 workspaces. PGlite has not been run on Linux or macOS yet; it is WebAssembly and expected to work, but the first CI run is the proof. Electron's install-time download is the desktop's CI concern.

### 5.3 Stacked pull requests and squash merges

`develop` received #4 as one squash commit. After M1-01 is squash-merged, the M1-02 branch still contains the original M1-01 commits. Merging `origin/develop` into M1-02 resolves files that are identical on both sides automatically; files that M1-02 changed after M1-01 (at least `package-lock.json`) conflict and follow the procedure above. A rebase is not allowed on pushed branches. The Project Manager can avoid this by merging stacked pull requests with a merge commit instead of a squash (P-41). Merge commits are already allowed in the repository settings (`allow_merge_commit: true`), so P-41 needs no settings change.

Whatever the merge method, GitHub does not retarget M1-02 to `develop` by itself while `delete_branch_on_merge` is `false` and the merged branch is kept. Section 4.1 lists the three steps after each merge: delete the merged branch or `gh pr edit <number> --base develop`, merge `origin/develop` into the next branch, and wait for its checks.

### 5.4 Other risks

| Risk                                                                                                                                             | Mitigation                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source exports break if a package ends up under `node_modules` as a real directory (publish, pack, a dereferencing copy, `--preserve-symlinks`). | Packages stay private; the deployment task keeps the workspace layout or bundles (ADR 0001).                                                                                                                                                                                                                      |
| Protocol changes after the desktop starts building on it.                                                                                        | Both owners review M1-01 before merge; v0 is same-version-only, so a change is visible as `unsupported_version`.                                                                                                                                                                                                  |
| M1-02 accepts unauthenticated WebSocket connections.                                                                                             | Loopback-only bind enforced by configuration; browser origins refused unless listed; frames after a close ignored; events typed `UnverifiedEvent`, validated and dropped, with no fan-out and no persistence. Authentication, identity and reference binding, and rate limits must exist before M2 relays events. |
| Stacked pull requests get no CI and no identity guard until retargeted, and are not retargeted automatically.                                    | Local `npm ci` and `npm run check` reported in each pull request; merge only after retargeting and green checks; P-45 removes the branch filter (Section 4.1).                                                                                                                                                    |
| A drifted internal version makes npm fetch `@mymandev/*` from the public registry.                                                               | Internal versions stay `0.0.0`; claim the npm organization (P-46).                                                                                                                                                                                                                                                |
| Database errors and URLs carry secrets into logs.                                                                                                | `DatabaseError` at the package boundary, the API's redacting serializer, request paths logged without query strings, URLs never printed (ADR 0009, ADR 0011).                                                                                                                                                     |
| Fastify security release rate.                                                                                                                   | Exact pins, tracked releases (P-23), and the tests that lock the hardened defaults.                                                                                                                                                                                                                               |
| Drizzle journal ordering and non-interactive generation.                                                                                         | The journal test, regeneration after merging `develop`, and checking that a migration file was written.                                                                                                                                                                                                           |
| PGlite is not a production server; no real PostgreSQL was used.                                                                                  | P-32 and a later CI service container.                                                                                                                                                                                                                                                                            |
| The permission grant shape is not agreed yet (M1-06).                                                                                            | Hold the M1-03 merge or split the table out (P-34).                                                                                                                                                                                                                                                               |
| zod supply-chain incident of 2026-09-21.                                                                                                         | Exact pin, lockfile, `npm audit signatures`, reviewed upgrades.                                                                                                                                                                                                                                                   |
| Invisible bidirectional characters introduced by tools; Prettier, ESLint and `tsc` do not catch them.                                            | Escapes in source, the Node scan acceptance check (Section 4.2; works on every platform), GitHub's diff warning, and a repository-wide check (P-39).                                                                                                                                                              |
| @types/node 24.19.2 describes APIs that Node 24.15.0 (the `engines` floor) may not have.                                                         | M1 code uses no API newer than 24.15; or raise the floor (P-40).                                                                                                                                                                                                                                                  |

## 6. Project Manager decisions

Each decision has a recommendation. "Blocks" names the work that cannot be finished without it.

| ID   | Decision                                                                                                                                                                                                                                                                                                      | Recommendation                                                                                                                                                                           | Blocks                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| P-01 | Internal packages export TypeScript source (ADR 0001)                                                                                                                                                                                                                                                         | Accept                                                                                                                                                                                   | M1-01 package shape                 |
| P-02 | Desktop consumer rules: renderer flags, one renderer language level (ES2024 proposed) in the protocol's `tsconfig.src.json`, bundled main and preload, WebSocket from the main process or a listed renderer origin, and the one-line change to "Desktop workspace contract" (ADR 0001, ADR 0009, Section 5.2) | Agree with the desktop owner before M1-01 merges                                                                                                                                         | Desktop import of the protocol      |
| P-03 | `node:test` and the root `test` delegation in M1-01 (ADR 0002)                                                                                                                                                                                                                                                | Accept                                                                                                                                                                                   | M1-01 root scripts                  |
| P-04 | `check` also runs `npm test`, so CI runs tests (ADR 0002)                                                                                                                                                                                                                                                     | Yes                                                                                                                                                                                      | M1-01 root scripts, CI              |
| P-05 | zod 4.6.7 classic (ADR 0003)                                                                                                                                                                                                                                                                                  | Accept (alternatives: zod/mini, valibot 1.5.0)                                                                                                                                           | M1-01                               |
| P-06 | Fastify type provider chosen with the first REST body route (ADR 0003)                                                                                                                                                                                                                                        | Defer to M2                                                                                                                                                                              | Nothing in M1                       |
| P-07 | Lowercase UUIDv7, PostgreSQL `uuid`, branded types (ADR 0004)                                                                                                                                                                                                                                                 | Accept                                                                                                                                                                                   | M1-01, M1-03                        |
| P-08 | User IDs also UUIDv7 (creation time visible) (ADR 0004)                                                                                                                                                                                                                                                       | Yes                                                                                                                                                                                      | M1-01                               |
| P-09 | The protocol generates IDs with uuid 14.0.3 (ADR 0004)                                                                                                                                                                                                                                                        | Yes                                                                                                                                                                                      | M1-01                               |
| P-10 | The server generates entity IDs including run IDs; devices only event IDs; de-duplication by the authenticated device ID; secrets are 32 random bytes stored as SHA-256 hashes, never UUIDs (ADR 0004)                                                                                                        | Accept                                                                                                                                                                                   | M1-01, M1-03                        |
| P-11 | Workspace 1:N Project (ADR 0005)                                                                                                                                                                                                                                                                              | Two levels                                                                                                                                                                               | M1-01 envelope, M1-03               |
| P-12 | Add `workspaces` and `workspace_members` to M1-03 (ADR 0005)                                                                                                                                                                                                                                                  | Yes                                                                                                                                                                                      | M1-03                               |
| P-13 | A workspace ID is not a join secret; invitations need a token (32 random bytes, stored as a SHA-256 hash) and a membership check (ADR 0005)                                                                                                                                                                   | Accept; design in #14                                                                                                                                                                    | #14, M2                             |
| P-14 | `protocolVersion: 0`, same-version-only; when to declare 1 (ADR 0006)                                                                                                                                                                                                                                         | 0 now; 1 when the M2 two-device test passes                                                                                                                                              | M1-01                               |
| P-15 | Actor or device mismatch: reject and audit. `decodeClientEvent` and `UnverifiedEvent` from M1-01, used by the M1-02 gateway; `bindIdentity` with reference binding and per-event membership check in M2 (ADR 0006)                                                                                            | Reject and audit; accept the M1 part now                                                                                                                                                 | M1-01, M1-02, M2 server             |
| P-16 | Unknown fields are stripped (ADR 0006)                                                                                                                                                                                                                                                                        | Strip                                                                                                                                                                                    | M1-01                               |
| P-17 | v0 event set: only `agent.run.state_changed` (ADR 0006)                                                                                                                                                                                                                                                       | Accept                                                                                                                                                                                   | M1-01                               |
| P-18 | Human text: limits 64/100/500; no control, format, surrogate, private-use, separator or default-ignorable characters except ZWNJ, ZWJ and VS15/VS16; not blank. Subdivision flags (England, Scotland, Wales) are rejected (ADR 0005, ADR 0006)                                                                | Accept                                                                                                                                                                                   | M1-01, M1-03 CHECKs                 |
| P-19 | Run states, one `awaiting_input`, retry as a new run, run creation as a server command with a `system` actor (ADR 0007)                                                                                                                                                                                       | Accept                                                                                                                                                                                   | M1-01, M1-03, M2                    |
| P-20 | Capability names live in the protocol, which exports no capability check; M1-06 imports the names and owns `isGrantActive` and `hasGrant` (ADR 0008)                                                                                                                                                          | Accept; needs the desktop owner too                                                                                                                                                      | M1-01, M1-06                        |
| P-21 | `provider.use` scope and `terminal.execute` risk treatment (ADR 0008)                                                                                                                                                                                                                                         | Settle in M1-06                                                                                                                                                                          | M1-06                               |
| P-22 | Fastify 5.12.7 with @fastify/websocket 11.3.4 (ADR 0009)                                                                                                                                                                                                                                                      | Accept                                                                                                                                                                                   | M1-02                               |
| P-23 | Dependency update tracking (for example Dependabot) (ADR 0009)                                                                                                                                                                                                                                                | Separate follow-up task                                                                                                                                                                  | Nothing in M1                       |
| P-24 | WebSocket close codes are provisional until M2-01 (ADR 0009)                                                                                                                                                                                                                                                  | Accept                                                                                                                                                                                   | M1-02                               |
| P-25 | `/health` reports the application version (ADR 0009)                                                                                                                                                                                                                                                          | Keep                                                                                                                                                                                     | M1-02                               |
| P-26 | Configuration variable names with the `API_` prefix; `API_HOST` loopback-only in M1; `API_ALLOWED_ORIGINS` empty by default (ADR 0010)                                                                                                                                                                        | Accept                                                                                                                                                                                   | M1-02                               |
| P-27 | No build step in M1-02; deployment artifact decided later; production installs with `npm ci --omit=dev` (ADR 0010, ADR 0011)                                                                                                                                                                                  | Accept                                                                                                                                                                                   | M1-02                               |
| P-28 | Drizzle 0.45 with guardrails, not the 1.0 release candidate (ADR 0011)                                                                                                                                                                                                                                        | 0.45                                                                                                                                                                                     | M1-03                               |
| P-29 | Migrations as a deployment step, not on API startup (ADR 0011)                                                                                                                                                                                                                                                | Deployment step                                                                                                                                                                          | M1-03, M2                           |
| P-30 | Accept 4 moderate dev-only audit findings from drizzle-kit, and its tsx and three esbuild install scripts (ADR 0011)                                                                                                                                                                                          | Accept; never run `npm audit fix --force`; check the install-script inventory in every M1-03 update                                                                                      | M1-03                               |
| P-31 | `updated_at` in the data layer or by trigger (ADR 0011)                                                                                                                                                                                                                                                       | Data layer                                                                                                                                                                               | M1-03                               |
| P-32 | PGlite evidence is enough for "migrations create the full schema", or one real PostgreSQL 18 run first (ADR 0012)                                                                                                                                                                                             | One real PostgreSQL 18 run before merge if anyone has it; otherwise accept PGlite and add the CI job                                                                                     | M1-03 merge                         |
| P-33 | CI job with a real PostgreSQL 18 service container (ADR 0012)                                                                                                                                                                                                                                                 | Follow-up after PR #46                                                                                                                                                                   | Nothing in M1                       |
| P-34 | `permission_grants` in M1-03 now (provisional, hold the merge for M1-06), or a follow-up migration (ADR 0013). Open in the shape: the `provider.use` provider connection column, and how an expired grant is replaced                                                                                         | Include, and hold the M1-03 merge until the M1-06 shape is agreed                                                                                                                        | M1-03 merge                         |
| P-35 | Grants go to agents only in v0 (ADR 0013)                                                                                                                                                                                                                                                                     | Agents only                                                                                                                                                                              | M1-03, M1-06                        |
| P-36 | Message body limit 16,000 characters; `client_event_id` idempotency; per-conversation `seq` instead of a global identity column (ADR 0013)                                                                                                                                                                    | Accept                                                                                                                                                                                   | M1-03                               |
| P-37 | PostgreSQL 18 as the production target (ADR 0013)                                                                                                                                                                                                                                                             | Accept                                                                                                                                                                                   | M1-03                               |
| P-38 | No handle or credentials on `users` until #15 (ADR 0013)                                                                                                                                                                                                                                                      | Accept                                                                                                                                                                                   | M1-03                               |
| P-39 | A repository-wide check for invisible bidirectional characters (Section 2.3)                                                                                                                                                                                                                                  | Separate follow-up task that turns the Node scan into a script; M1-01 uses it as an acceptance check                                                                                     | Nothing in M1                       |
| P-40 | Keep `engines` at `^24.15.0` with @types/node 24.19.2, or raise the floor                                                                                                                                                                                                                                     | Keep for M1; decide with the desktop owner, because it affects everyone                                                                                                                  | Nothing in M1                       |
| P-41 | Merge method for stacked pull requests, and the retarget step after each merge (Section 4.1, 5.3)                                                                                                                                                                                                             | Merge commits for the M1 stack (already allowed), or squash plus `git merge origin/develop`; in both cases delete the merged branch or `gh pr edit --base develop` before the next merge | Merging M1-02 and M1-03             |
| P-42 | Base of M1-03: on M1-02 as planned, or directly on M1-01                                                                                                                                                                                                                                                      | Keep the planned stack (one lockfile history, no conflict between M1-02 and M1-03)                                                                                                       | M1-03 branch                        |
| P-43 | ADR numbers 0001 to 0013 reserved for M1; desktop ADRs take the next free number                                                                                                                                                                                                                              | Accept                                                                                                                                                                                   | Desktop ADRs                        |
| P-44 | Only the agent's owner may grant it a capability in v0: composite foreign key `permission_grants (grantee_agent_id, granted_by_user_id) -> agents (id, owner_user_id)` (ADR 0013; extends P-35)                                                                                                               | Yes; M1-06 can relax it later with a migration                                                                                                                                           | M1-03, M1-06                        |
| P-45 | Run CI and the identity guard on stacked pull requests: drop the `branches:` filter under `pull_request:` in `check.yml` (PR #46) and in `identity-guard.yml` (Section 4.1)                                                                                                                                   | Yes, as a small change in PR #46 or a chore pull request before M1-02 opens; until then, merge only after retargeting with green checks                                                  | Automatic checks on M1-02 and M1-03 |
| P-46 | Claim the npm organization `mymandev`; internal workspaces stay at version `0.0.0` (ADR 0001)                                                                                                                                                                                                                 | Yes                                                                                                                                                                                      | Nothing in M1 (risk reduction)      |
| P-47 | Two database roles (`mymandev_migrator`, `mymandev_app`), `DATABASE_MIGRATION_URL` for migrations, `sslmode=verify-full` required in production, pool timeouts (ADR 0011)                                                                                                                                     | Accept                                                                                                                                                                                   | M1-03                               |
| P-48 | Credentials never in URLs; WebSocket authentication through the first message or `Sec-WebSocket-Protocol` (ADR 0009)                                                                                                                                                                                          | Accept; M2-01 designs the handshake under this rule                                                                                                                                      | M2-01                               |

## Appendix A: Exact versions

All versions were published at least two weeks before 2026-10-27 (fastify 5.12.7 exactly 14 days).

| Package                     | Version | Published  | Declared in                  | Kind          |
| --------------------------- | ------- | ---------- | ---------------------------- | ------------- |
| typescript                  | 6.0.3   | (existing) | root                         | devDependency |
| @types/node                 | 24.19.2 | 2026-10-09 | protocol, api, database      | devDependency |
| zod                         | 4.6.7   | 2026-10-12 | protocol, api                | dependency    |
| uuid                        | 14.0.3  | 2026-10-10 | protocol                     | dependency    |
| fastify                     | 5.12.7  | 2026-10-13 | api                          | dependency    |
| @fastify/websocket          | 11.3.4  | 2026-10-09 | api                          | dependency    |
| @types/ws                   | 8.18.2  | 2026-09-29 | api                          | devDependency |
| ws                          | 8.22.0  | 2026-09-26 | (through @fastify/websocket) | transitive    |
| pino                        | 10.4.0  | 2026-10-02 | (through fastify)            | transitive    |
| drizzle-orm                 | 0.45.4  | 2026-10-08 | database                     | dependency    |
| pg                          | 8.23.1  | 2026-09-30 | database                     | dependency    |
| drizzle-kit                 | 0.31.11 | 2026-09-21 | database                     | devDependency |
| @electric-sql/pglite        | 0.5.9   | 2026-10-12 | database                     | devDependency |
| @types/pg                   | 8.23.1  | 2026-08-17 | database                     | devDependency |
| @electric-sql/pglite-socket | 0.2.12  |            | never declared; `npx` only   | ad hoc tool   |

Installed but not declared (through drizzle-kit 0.31.11, dev only, never used in scripts): tsx 4.23.15; esbuild 0.18.20, 0.25.12 and 0.28.2, each with a `postinstall` script and a native binary. These three are the only install scripts in the M1 dependency set (Section 2.5).

Deliberately not declared: tsx, Vitest and Vite (except possibly in `apps/desktop`), TypeBox and its Fastify provider, `fastify-type-provider-zod` (until M2), `@fastify/env`, `env-schema`, `close-with-grace`, pino-pretty, pg-native, Prisma, Kysely, esbuild (used only for measurement).

Upgrade candidates: @electric-sql/pglite 0.5.12 from 2026-11-09; drizzle-orm and drizzle-kit 1.0 when generally available; vitest 5.0.5 (desktop only) from 2026-10-29.

## Appendix B: Reproducing the checks

The ADR snippets are excerpts, so this sequence needs the complete files that each pull request adds; until those exist, it documents the procedure rather than a ready-made reproduction. Run it in Git Bash (it uses `rm -rf`, subshells and inline variables), from a checkout with the three workspaces in place:

```sh
npm install
npm run check   # expect "# tests 15", "# tests 20" and "# tests 14" for protocol, api and database
(cd packages/database && npm run db:check && npm run db:generate)
rm -rf node_modules && npm ci && npm run typecheck && npm test
npm ls zod @electric-sql/pglite
npm query ":attr(scripts, [postinstall]), :attr(scripts, [install]), :attr(scripts, [preinstall])"
npm audit --omit=dev && npm audit signatures
(cd apps/api && API_PORT=0x50 API_LOG_LEVEL=loud NODE_ENV=staging node src/server.ts; echo "exit=$?")
(cd apps/api && API_HOST=0.0.0.0 node src/server.ts; echo "exit=$?")
```

Then the two-terminal pglite-server smoke test from ADR 0012.

Observed results are listed in Section 2.2 (revision 1) and Section 2.5 (revision 2).

## Appendix C: Critique resolution

Two reviews of revision 1 were applied: a security review (S-1 to S-15) and a maintainability review (M-1 to M-14). Each point is listed with its outcome and a one-line reason. "Accepted, modified" means the point is accepted and the fix differs from the one proposed, for the reason given.

| ID    | Point                                                          | Outcome             | Reason and where it is resolved                                                                                                                                                                                                                                                                                                                        |
| ----- | -------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S-1   | Server trusts the client-chosen actor and device               | Accepted            | `decodeClientEvent` rejects `system` and `deviceId: null` from M1-01; the gateway hands `UnverifiedEvent` plus `ConnectionContext` to the handler; `bindIdentity` producing `VerifiedEvent` is mandatory in M2; de-duplication by the connection's device; run actor must be the payload's agent or `system` (ADR 0006, ADR 0009).                     |
| S-2   | Payload IDs not bound to the envelope's workspace              | Accepted            | Reference binding rule for every event, per-event membership check, `correlationId`/`causationId` never used for lookups (ADR 0006); the ownership part is also enforced by composite foreign keys (ADR 0013).                                                                                                                                         |
| S-3   | Run creation lets a device choose a run ID                     | Accepted            | Run creation is a server command with a `system` actor; `decodeClientEvent` rejects `previousState: null`; an unknown run and a foreign run get the same rejection (ADR 0004, ADR 0007).                                                                                                                                                               |
| S-4   | Schema accepts rows that mix owners, devices and projects      | Accepted            | Composite unique keys and composite foreign keys added; 8 inconsistent rows verified as 23503 with drizzle-kit-generated SQL (ADR 0013, Section 2.5); the owner-only grant key is P-44.                                                                                                                                                                |
| S-5   | Gateway processes frames after deciding to close               | Accepted            | `readyState` guard; verified 0 events delivered versus 50 without the guard (ADR 0009, Section 2.5).                                                                                                                                                                                                                                                   |
| S-6   | No Origin check on the WebSocket                               | Accepted            | `preValidation` Origin guard with `API_ALLOWED_ORIGINS` (empty by default); verified 403 through `injectWS` and real HTTP (ADR 0009, ADR 0010).                                                                                                                                                                                                        |
| S-7   | `API_HOST` accepts any address                                 | Accepted, modified  | Loopback-only enum; the proposed `API_ALLOW_NON_LOOPBACK` escape hatch is left out, because widening belongs with authentication in M2 and an unused switch is one more way to expose the gateway (ADR 0010).                                                                                                                                          |
| S-8   | Error handler leaks messages below 500                         | Accepted            | Status normalised to 400 to 599, message only for `FST_` errors, status text otherwise; verified for 200, 302, 0, 404, 500, 400 and 413 (ADR 0009).                                                                                                                                                                                                    |
| S-9a  | Query strings in logs                                          | Accepted            | `req` serializer without query, custom not-found handler that logs nothing, rule "no credentials in URLs" (ADR 0009, P-48); verified.                                                                                                                                                                                                                  |
| S-9b  | Failed queries carry parameters into logs                      | Accepted, modified  | `DatabaseError` at the database boundary as proposed; the API serializer is an allowlist that also drops message and stack, because the Drizzle error message itself contains the parameters, so dropping only `params`, `query` and `detail` would still leak them (verified; ADR 0009, ADR 0011). Hashing invitation tokens is in ADR 0004 and P-13. |
| S-10  | Safe-text pattern lets invisible characters through            | Accepted, modified  | The proposed pattern still accepted Hangul fillers and U+034F and rejected Persian ZWNJ (verified); the final pattern also excludes `\p{DI}` and allows ZWNJ and VS15/VS16. The optional database regex CHECK is rejected: PostgreSQL has no `\p{...}` classes and it was untested (ADR 0005, ADR 0006).                                               |
| S-11  | Global message `seq` reveals other workspaces' activity        | Accepted            | Per-conversation `seq` from `conversations.last_seq` with unique (`conversation_id`, `seq`); verified; same rule for M2 event sequences (ADR 0013, P-36).                                                                                                                                                                                              |
| S-12  | Unscoped capability check; no single "active grant" definition | Accepted            | `hasCapability` removed from the protocol; M1-06 owns `isGrantActive` and scoped `hasGrant`; expiry CHECK added and verified; provider connection scope kept under P-34 (ADR 0008, ADR 0013).                                                                                                                                                          |
| S-13  | No least privilege, TLS rule or timeouts for the database      | Accepted            | Two roles and `DATABASE_MIGRATION_URL` (verified on PGlite), URL check with `sslmode` allowlist and `verify-full` in production (verified), pool timeouts (accepted by pglite-server, effect unverified) (ADR 0011, P-47).                                                                                                                             |
| S-14  | Install scripts and packages from drizzle-kit not listed       | Accepted            | Inventory in ADR 0011 and Appendix A, `npm query` acceptance check (verified: exactly three esbuild packages), `npm ci --omit=dev` for deployment, `npx` without `-y`.                                                                                                                                                                                 |
| S-15  | UUID randomness overstated; no rule against UUIDs as secrets   | Accepted            | Corrected to the counter behaviour of uuid 14.0.3 (verified); secrets rule with 32 random bytes and SHA-256 storage; device clock exposure noted (ADR 0004).                                                                                                                                                                                           |
| M-1   | No CI or identity guard on stacked pull requests               | Accepted            | Local-check and merge-after-retarget rule now (Section 4.1); removing the `branches:` filter needs the Project Manager (P-45).                                                                                                                                                                                                                         |
| M-2   | Retargeting is not automatic                                   | Accepted            | `delete_branch_on_merge: false` confirmed with `gh api`; three-step procedure after each merge (Section 4.1, 5.3, P-41).                                                                                                                                                                                                                               |
| M-3   | Renaming the heading breaks `#root-typecheck-delegation`       | Accepted            | Heading kept, separate "Root test delegation" added, one-line contract change only by agreement under P-02, PR #46 added to the conflict table (verified hunk at line 43) (Section 4.2, 5.1, 5.2).                                                                                                                                                     |
| M-4   | Renderer check does not cover language features                | Accepted            | Protocol `tsconfig.src.json` gets `lib: ["es2024"]`; verified TS2550 and TS2693 for ES2025 features; the level is agreed under P-02 (ADR 0001).                                                                                                                                                                                                        |
| M-5   | Vitest watch mode would hang the root `check`                  | Accepted            | Run-once rule and `vitest run` in ADR 0002, WORKSPACE.md "Tests" and the desktop guidance (Section 5.2).                                                                                                                                                                                                                                               |
| M-6   | `db:migrate` ignores `.env`                                    | Accepted            | `node --env-file-if-exists=.env`; verified for file, environment precedence and missing file; POSIX-only commands labelled Git Bash (ADR 0011, document header).                                                                                                                                                                                       |
| M-7   | Premature `./testing` export                                   | Accepted            | Removed from M1-03; added in M2 with the identical-PGlite-version rule (ADR 0012).                                                                                                                                                                                                                                                                     |
| M-8   | Internal versions fall back to the public registry             | Accepted            | `0.0.0` rule in ADR 0001 and WORKSPACE.md; claiming the npm organization is P-46.                                                                                                                                                                                                                                                                      |
| M-9   | "No tsx" is inaccurate                                         | Accepted            | Verified tsx 4.23.15 and three esbuild versions under drizzle-kit; wording fixed in ADR 0011 and Appendix A.                                                                                                                                                                                                                                           |
| M-10  | Test counts do not match; integration run not reproducible     | Accepted            | Section 2.2 marked as not reproducible from the document; the plan lists every test with totals 15, 20 and 14; acceptance checks require the `# tests` count.                                                                                                                                                                                          |
| M-11  | `git grep -P` may fail on macOS                                | Accepted            | Replaced by the Node scan; verified in Git Bash and PowerShell 5.1 and on a planted U+202E file (Section 4.2).                                                                                                                                                                                                                                         |
| M-12  | Editors will rewrite generated migrations                      | Accepted            | `.editorconfig` section for `packages/database/migrations/**` in M1-03 and in the conflict table; the `unset` value was not tried in an editor.                                                                                                                                                                                                        |
| M-13  | ADRs copy code and versions that go stale                      | Accepted            | ADR template keeps policy and links; this document stays the review record with versions and snippets (Section 3, 4.5).                                                                                                                                                                                                                                |
| M-14a | `@types/node` worry does not apply to Electron 45              | Accepted            | Verified `electron@latest` 45.0.0 depends on `@types/node ^24.9.0`; Section 5.2 item 6 corrected.                                                                                                                                                                                                                                                      |
| M-14b | Root `tsconfig.node.json` preset for the shared options        | Rejected (deferred) | WORKSPACE.md requires each workspace to set `module`, `target`, `lib` and `types` explicitly, and a new root file widens the root conflict surface with the desktop; three short copies are acceptable in M1. Revisit when a fourth Node-side workspace arrives.                                                                                       |
