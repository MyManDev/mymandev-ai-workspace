# @mymandev/api

The cloud API skeleton: a Fastify application with a health endpoint and a WebSocket gateway that validates protocol events from [`@mymandev/protocol`](../../packages/protocol/README.md). It has no authentication and no persistence yet. The decisions behind it are recorded in [ADR 0009](../../docs/architecture/decisions/0009-fastify-cloud-api.md) and [ADR 0010](../../docs/architecture/decisions/0010-api-configuration-and-runtime.md).

## Start locally

From the repository root, after `npm ci`:

```sh
npm run start -w @mymandev/api
```

The API listens on `http://127.0.0.1:3000` and writes JSON log lines to standard output. Check it with:

```sh
curl http://127.0.0.1:3000/health
```

Stop it with Ctrl+C. The API logs "shutting down", closes every WebSocket connection with code 1001, and exits with code 0. On Windows, SIGTERM is never delivered; Ctrl+C sends SIGINT, which runs the same shutdown. When npm runs through `npm.cmd` on Windows, `cmd.exe` may then ask "Terminate batch job (Y/N)?"; the API has already stopped at that point.

For development, `npm run dev -w @mymandev/api` restarts the API when a source file changes, including a file in `packages/protocol`, and reads `apps/api/.env` if it exists. On Windows, a restart by `--watch` stops the process without running the shutdown handler; on Linux and macOS, `--watch` sends SIGTERM, which runs it.

Node.js runs the TypeScript source directly. There is no build step.

## Scripts

| Script      | Runs                                                   |
| ----------- | ------------------------------------------------------ |
| `dev`       | `node --watch --env-file-if-exists=.env src/server.ts` |
| `start`     | `node src/server.ts`                                   |
| `typecheck` | `tsc -p tsconfig.json`                                 |
| `test`      | `node --test "src/**/*.test.ts"`                       |

Run them from the repository root with `-w @mymandev/api`, or from `apps/api`.

## Configuration

The API reads its configuration from environment variables once, at startup. An empty value counts as unset. Other variables are ignored. If a variable is invalid, the API prints one line per invalid variable, names the variable without printing its value, and exits with code 1.

| Variable               | Default       | Accepted values                                                                                                                                                                      |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`             | `development` | `development`, `test`, `production`                                                                                                                                                  |
| `API_HOST`             | `127.0.0.1`   | `127.0.0.1`, `::1`, or `localhost`. Loopback only until authentication exists (M2).                                                                                                  |
| `API_PORT`             | `3000`        | A decimal integer from 0 to 65535, without sign, leading zero, or spaces.                                                                                                            |
| `API_LOG_LEVEL`        | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                                                                                                                         |
| `API_BODY_LIMIT_BYTES` | `65536`       | A decimal integer from 1 to 10485760.                                                                                                                                                |
| `API_ALLOWED_ORIGINS`  | empty         | A comma-separated list of at most 20 browser origins that may open `/ws`, each exactly `http://host[:port]` or `https://host[:port]`: no path, no trailing slash, no `*`, no `null`. |

[`.env.example`](.env.example) lists every variable with its default. To change a value for `npm run dev`, copy it to `apps/api/.env`. `.env` is ignored by Git; never commit it. The API has no secret in M1-02.

## Endpoints

### `GET /health`

Returns `200` with `{"status":"ok","version":"<version>"}`, where the version is the `version` field of `apps/api/package.json`. No other REST route exists yet.

Errors use one body shape, `{"statusCode":<code>,"error":"<status text>","message":"<message>"}`. A server error (5xx) always has the generic message "Internal Server Error". A client error keeps the message only when Fastify produced it, for example a validation error or `413` for a body over `API_BODY_LIMIT_BYTES`. An unknown route gets `404` with the message "Not Found" and does not echo the method or the path.

### `GET /ws` (WebSocket)

`/ws` is the only path that accepts a WebSocket handshake; a handshake on any other path gets `404` before the upgrade. The gateway accepts WebSocket connections and validates every frame as a protocol event that a device sent:

1. A handshake with an `Origin` header that is not listed in `API_ALLOWED_ORIGINS` gets `403` before the upgrade. A handshake without `Origin` (Node.js, the Electron main process) is accepted. Browsers send `Origin` on every WebSocket handshake and apply no same-origin rule to WebSocket, so every browser origin that may connect must be listed. A renderer loaded from `file://` or a custom scheme sends the origin `null`, which cannot be listed.
2. Each text frame must contain one JSON event. The gateway decodes it with `decodeClientEvent` from `@mymandev/protocol`.
3. A valid event goes, typed as `UnverifiedEvent`, to the event handler together with the connection context (`connectionId` and `identity`, which is always `null` until authentication exists). The default handler logs the event ID, the event type, and the connection ID at `debug` level. Nothing is routed, relayed, stored, or answered.
4. Anything else closes the connection. Frames that arrive after the gateway has decided to close are ignored.

| Close code | Reason                                                                                                            | When                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1001       | `server_shutdown`                                                                                                 | The API shuts down.                           |
| 1003       | `binary_not_supported`                                                                                            | A binary frame.                               |
| 1007       | `invalid_json`                                                                                                    | A text frame that is not JSON.                |
| 1008       | `malformed`, `unsupported_version`, `unknown_type`, `invalid_payload`, `invalid_actor`, `not_allowed_from_device` | The event is rejected by `decodeClientEvent`. |
| 1009       | (set by the WebSocket library)                                                                                    | A frame larger than 64 KiB.                   |

These close codes and reasons are provisional. The WebSocket message protocol (M2-01) owns them and may change them.

## Rules

- Credentials never appear in URLs, including the WebSocket URL. A browser `WebSocket` cannot set headers, which invites `/ws?token=...`; the query string would then reach proxies and browser history. WebSocket authentication (M2) uses the first message or the `Sec-WebSocket-Protocol` header.
- Logs contain the request method, the path without the query string, and the remote address. Errors are logged with their type, codes, message, and stack; an error that may carry query data (an own `query`, `params`, or `detail` property) is logged without message and stack.
- An event from a device stays `UnverifiedEvent` until the server's identity binding (M2) has bound it to the authenticated connection. Never cast it to `ProtocolEvent` or to a verified type.
- `src/server.ts` is the only module with side effects. Tests build the application with `buildApp` from `src/app.ts` and use `inject` and `injectWS` without a network.

## Not included

Authentication, sessions, tokens, identity binding, rate limits, CORS, OpenAPI, TLS, database access, permission enforcement, event routing and relay, the WebSocket message protocol (M2-01), Docker, deployment configuration, clustering, a build step, pretty-printed logs, and a Fastify type provider.
