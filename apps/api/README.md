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

| Variable                   | Default       | Accepted values                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                 | `development` | `development`, `test`, `production`                                                                                                                                                                                                                                                                                                             |
| `API_HOST`                 | `127.0.0.1`   | `127.0.0.1`, `::1`, or `localhost`. Loopback only; widening it is part of the hosting decision (#96).                                                                                                                                                                                                                                           |
| `API_PORT`                 | `3000`        | A decimal integer from 0 to 65535, without sign, leading zero, or spaces.                                                                                                                                                                                                                                                                       |
| `API_LOG_LEVEL`            | `info`        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                                                                                                                                                                                                                                                                                    |
| `API_BODY_LIMIT_BYTES`     | `65536`       | A decimal integer from 1 to 10485760.                                                                                                                                                                                                                                                                                                           |
| `API_ALLOWED_ORIGINS`      | empty         | A comma-separated list of at most 20 browser origins that may open `/ws`, each exactly `http://host[:port]` or `https://host[:port]`: no path, no trailing slash, no `*`, no `null`.                                                                                                                                                            |
| `API_PUBLIC_ORIGIN`        | empty         | The API's public origin, exactly `https://host[:port]` in lowercase without the default port; the host is a DNS name or a dotted IPv4 address. It is GitHub's callback origin and the audience of device signatures (ADR 0014). `http` is accepted only with `NODE_ENV` set to `development` or `test` and the host `127.0.0.1` or `localhost`. |
| `API_GITHUB_CLIENT_ID`     | empty         | The client ID of the GitHub App.                                                                                                                                                                                                                                                                                                                |
| `API_GITHUB_CLIENT_SECRET` | empty         | A client secret of the GitHub App. A secret: never printed or logged.                                                                                                                                                                                                                                                                           |
| `DATABASE_URL`             | empty         | A `postgres:` or `postgresql:` URL, percent-encoded, with `sslmode` unset, `disable`, or `verify-full` ([`@mymandev/database`](../../packages/database/README.md)). A secret: never printed or logged.                                                                                                                                          |

[`.env.example`](.env.example) lists every variable with its default. To change a value for `npm run dev`, copy it to `apps/api/.env`. `.env` is ignored by Git; never commit it.

`API_PUBLIC_ORIGIN`, `API_GITHUB_CLIENT_ID`, and `API_GITHUB_CLIENT_SECRET` enable GitHub sign-in together: set all three or none. With `NODE_ENV=production`, they and `DATABASE_URL` are required, and `DATABASE_URL` needs `sslmode=verify-full`. In development and test the API also starts without them and logs a warning that GitHub sign-in or the database is disabled. The configuration keeps the client secret and the database URL in an object that prints `[redacted]` in logs, JSON, and inspection.

## Endpoints

### `GET /health`

Returns `200` with `{"status":"ok","version":"<version>"}`, where the version is the `version` field of `apps/api/package.json`.

Errors use one body shape, `{"statusCode":<code>,"error":"<status text>","message":"<message>","code":"<code>"}`, where `code` is one of `API_ERROR_CODES` of [`@mymandev/protocol`](../../packages/protocol/README.md) (ADR 0014, P-66). A route raises a typed `ApiError` with a code; the answer then has the code's fixed status and the status text as the message. Every other error gets a generic code for its status (`genericApiErrorCode`). A server error (5xx) always has the generic message "Internal Server Error". A client error keeps the message only when Fastify produced it, for example a validation error or `413` for a body over `API_BODY_LIMIT_BYTES`. An unknown route gets `404` with the message "Not Found" and the code `not_found`, and does not echo the method or the path. A malformed URL, an over-long path parameter (`414`), a malformed request line, headers over the limit (`431`), a request timeout (`408`), and a request that arrives while the API closes (`503`) get the status text as the message and a generic code too. A message is at most 100 characters. GET routes get no automatic HEAD route, so a rate limit counts every request against one budget.

A route with a rate limit answers `429` with `rate_limited` and `Retry-After` when it is reached (`@fastify/rate-limit`, in-memory store, one instance). Routes that take a body validate it with the zod schema of `@mymandev/protocol` through `zodValidatorCompiler` (`src/validation.ts`), registered in their plugin scope: unknown keys are stripped, and a failure answers `400` with `bad_request` and a message that names the part, the path, and the issue, never an input value.

### Sign-in with GitHub

These routes exist only when GitHub sign-in is configured; otherwise they answer the generic `404`. They implement steps 2 to 5 of ADR 0014, "Sign-in". The API keeps every attempt, its PKCE verifier for GitHub, and the sign-in codes only in memory, and the codes and the cookie only as SHA-256 hashes. A timer drops expired entries every 15 seconds, and a restart drops them all. Every GitHub call refuses redirects, and a token in a failed exchange answer is deleted at once.

- `GET /auth/github/authorize`, opened by the desktop in the system browser with `code_challenge`, `code_challenge_method=S256`, `redirect_uri` (`http://127.0.0.1:<port>/callback`, ports 1024 to 65535), `state`, and optionally `login` and `prompt=select_account`. A malformed or repeated parameter gets an error page and never a redirect. Otherwise it starts an attempt that lives 10 minutes (at most 1,000 open attempts), sets the attempt cookie, and redirects to GitHub with the API's own state and PKCE pair. With an `https` origin the cookie is `__Host-mmd_signin` with `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`; with an `http` origin, which only development and test allow, it is `mmd_signin` without `Secure` (#99).
- `GET /auth/github/callback`, GitHub's redirect. It needs the cookie of the attempt that the state names and runs once. A request that names a live attempt without its cookie ends that attempt, so GitHub's code from another browser is never exchanged (the phishing scenario of ADR 0014, "Threats"). It exchanges the code with a form-encoded body and never retries; a token answer with an `error` field fails whatever its status. It reads `GET /user`, then deletes the user token at once and keeps no GitHub token. It shows the confirmation page with the GitHub login and the pairing code.
- `POST /auth/github/confirm`, the form of the confirmation page, with `state` and `decision` (`continue` or `cancel`). It accepts only a form body and needs the attempt's cookie. It refuses a request whose `Sec-Fetch-Site` header is present and not `same-origin`; without that header, the `SameSite=Lax` cookie keeps a cross-site form from carrying the attempt. Continue creates a sign-in code (`mmdc_`, single use, 60 seconds) and answers with a page that posts `code` and `state` to the desktop's listener, by a script and a visible button. The code never appears in a URL.

- `POST /auth/sign-in`, sent by the desktop with the sign-in code, its PKCE verifier, `redirect_uri`, and the device registration (`SignInRequestSchema`). It needs the database too. It takes the code once, also when a later check fails, and answers `401` with `auth_failed` for an unknown, used, or expired code, a verifier whose S256 hash is not the bound challenge, another `redirect_uri`, or a signature that does not verify. A new device signs the `sign-in` input with its new key; an existing device signs it with its current key and with the new key. In one transaction the API then finds the account by GitHub's numeric ID, never by login, and refreshes the login, or creates the account with the GitHub name as its first display name, or the login when the name is not usable. It registers the device or replaces its key, keeping the device ID and clearing a sign-out, and revokes a named previous device of the same account as `replaced`. It refuses a disabled account (`auth_failed`), a device of another account (`device_account_mismatch`), a revoked device (`device_revoked`), a new device while the registration lock is active (`device_registration_locked`), and more than 20 active or 10 new devices in 24 hours (`rate_limited`). It writes audit records for the sign-in and for the registration or key replacement, and answers with the user ID, the device ID, the display name, the login, and the sign-in expiry, 30 days later, without any credential.

When an attempt ends without a code, the page posts `error` and `state` to the listener instead: `access_denied` (declined on GitHub or Cancel), `sign_in_failed` (GitHub did not confirm the code or the account), `unsupported_account` (a login outside the login rule), or `sign_in_unavailable` (GitHub's limit, with `Retry-After`). A request without a valid attempt gets an error page and posts nothing.

The pages load nothing from outside and send `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a Content Security Policy with `default-src 'none'`, a hash for the one style and the one script, `frame-ancestors 'none'`, and a `form-action` that allows only the API itself or this attempt's listener. Each route allows 30 requests per address in 10 minutes. The API logs a warning above 1,500 token exchanges in an hour, below GitHub's limit of 2,000. No code, state, cookie, token, verifier, or GitHub response body is logged.

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
