# ADR 0010: API configuration, runtime and shutdown

- Status: Accepted (2026-10-28)
- Date: 2026-10-27
- Decided by: Project Manager

## Context

Issue #20 requires that configuration is loaded at startup, that no secrets are committed, and that the API starts locally with a documented command. [ADR 0001](0001-internal-packages-export-typescript-source.md) lets Node.js run the source directly.

## Options considered

- Configuration: zod (already the validation library, [ADR 0003](0003-zod-runtime-validation.md)), TypeBox `Value.Convert` (the research found that it accepts `80.5`, `0x50`, `8e1`, `true`, and the empty string as numbers), or `@fastify/env` and `env-schema` (an extra dependency built on Ajv coercion).
- Runtime: Node.js type stripping (recommended), `tsx`, or a `tsc` build.

## Decision

- `src/config.ts` exports `loadConfig(env)`. It reads only the known variables, treats an empty string as unset, validates the raw strings before converting them, returns a frozen object, and throws `ConfigError`. Error lines name the variable and never contain its value.

| Variable               | Default       | Accepted values                                                                                                                                                                                       |
| ---------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | `development` | `development`, `test`, `production`                                                                                                                                                                   |
| `API_HOST`             | `127.0.0.1`   | `127.0.0.1`, `::1`, or `localhost` (loopback only until authentication exists in M2)                                                                                                                  |
| `API_PORT`             | `3000`        | Decimal integer 0 to 65535, no sign, no leading zero, no spaces                                                                                                                                       |
| `API_LOG_LEVEL`        | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                                                                                                                                          |
| `API_BODY_LIMIT_BYTES` | `65536`       | Decimal integer 1 to 10,485,760                                                                                                                                                                       |
| `API_ALLOWED_ORIGINS`  | empty         | Comma-separated list of at most 20 `http` or `https` origins, each exactly in the form `scheme://host[:port]` (no path, no trailing slash, no `*`, no `null`). Browser origins allowed to open `/ws`. |

- `src/server.ts` is the only module with side effects: it loads the configuration (prints the `ConfigError` and exits with 1), builds the application, reads the version from `../package.json` with an import attribute, registers SIGINT and SIGTERM handlers, and listens. Shutdown runs `app.close()` once, with a 10-second force-exit timer that does not keep the process alive.
- Scripts: `dev` = `node --watch --env-file-if-exists=.env src/server.ts`, `start` = `node src/server.ts`, `typecheck` = `tsc -p tsconfig.json`, `test` = `node --test "src/**/*.test.ts"`. No `build` script in M1-02.
- `apps/api/.env.example` lists the variables with their defaults. `.env` is ignored by the root `.gitignore` (`.env.example` is explicitly allowed). M1-02 has no secret; `DATABASE_URL` (the application role, M1-03) arrives with the first API feature that stores data.
- Logs are pino JSON. No pino-pretty.

## Consequences

- No `tsx`, no build, and no `dist` for development, tests, and local start.
- The deployment artifact is decided by a later deployment task: either ship the workspace layout and run with Node.js, or bundle ([ADR 0001](0001-internal-packages-export-typescript-source.md)). Either way, production installs use `npm ci --omit=dev`, so development tools and their install scripts never reach a server.
- Running the API for another machine needs a code change (`API_HOST`) together with authentication, not only an environment variable.
- On Windows, SIGTERM is never delivered, and `node --watch` restarts terminate the process without running the handler. Ctrl+C sends SIGINT, which runs it.

## Dependency policy

- zod 4, declared by `@mymandev/api` as a `dependency` with the same exact version as `@mymandev/protocol` ([ADR 0003](0003-zod-runtime-validation.md)). No other configuration dependency: no `@fastify/env`, `env-schema`, `dotenv`, or `close-with-grace`.
- `@types/node` for Node.js 24, exact pin, as a `devDependency`, as in every Node-side workspace ([ADR 0001](0001-internal-packages-export-typescript-source.md)).

## Evidence

- [`apps/api/src/config.ts`](../../../apps/api/src/config.ts) (`loadConfig`, `Config`, `ConfigError`), [`apps/api/src/server.ts`](../../../apps/api/src/server.ts), [`apps/api/package.json`](../../../apps/api/package.json), and [`apps/api/.env.example`](../../../apps/api/.env.example).
- [`apps/api/src/config.test.ts`](../../../apps/api/src/config.test.ts): defaults, only known variables, empty strings as unset, a frozen result, rejection of `80.5`, `0x50`, `8e1`, `" 80"`, `true`, `-1`, `65536`, `080`, `1_000`, a zero body limit, an unknown `NODE_ENV` and log level, the loopback-only `API_HOST`, the origin list rules, and errors that name every variable without its value.
- M1-02 acceptance checks: `API_PORT=0x50` and `API_HOST=0.0.0.0` exit with 1 and name the variable without its value; `npm run start -w @mymandev/api` serves `/health`; Ctrl+C logs "shutting down" and exits with 0.
- Usage: [`apps/api/README.md`](../../../apps/api/README.md).
- Review record: [M1 Technical Decision Set](../research/m1-technical-decision-set.md), revision 2 of 2026-10-27 (ADR 0010, Sections 2.2 and 2.5).

## Needs Project Manager decision

Answered by the Project Manager on 2026-10-28.

- The variable names and the `API_` prefix, loopback-only `API_HOST` in M1, and `API_ALLOWED_ORIGINS` empty by default (P-26, recommended: accept).
  - Accepted.
- No build step in M1-02; the deployment artifact is decided later; production installs use `npm ci --omit=dev` (P-27, recommended: accept).
  - Accepted.
