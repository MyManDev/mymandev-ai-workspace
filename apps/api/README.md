# @mymandev/api

The cloud API: a Fastify application with a health endpoint, GitHub sign-in, device keys and access tokens, and a WebSocket gateway that authenticates each connection with its device key and validates protocol events from [`@mymandev/protocol`](../../packages/protocol/README.md). The decisions behind it are recorded in [ADR 0009](../../docs/architecture/decisions/0009-fastify-cloud-api.md), [ADR 0010](../../docs/architecture/decisions/0010-api-configuration-and-runtime.md), and [ADR 0014](../../docs/architecture/decisions/0014-accounts-devices-and-invitations.md).

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

### Access tokens and devices

These routes need GitHub sign-in and the database (ADR 0014, "Device key and authentication" and "Revocation, sign-out, and recovery"). Challenges and access tokens live only in API memory, the tokens as SHA-256 hashes; a restart drops them, and the desktop fetches a new token.

- `POST /auth/challenge` returns a challenge ID and a nonce. The challenge is single use and valid for 60 seconds; at most 1,000 are open (`429` with `rate_limited` and `Retry-After`).
- `POST /auth/access-token` takes the device ID, the challenge ID, and a signature over the `http` input. The signature is checked first with the device's current key; an unknown device, a used or expired challenge, or a bad signature answers `auth_failed`. Only then does the device answer: `device_revoked`, `sign_in_required` (signed out, last sign-in 30 days ago or more, or a GitHub revocation after the last sign-in), or `auth_failed` for a disabled account. It returns an access token (`mmda_`, 15 minutes, never extended). A device may mint 30 tokens in 15 minutes and keeps at most 3 live tokens; a fourth ends the oldest. A token belongs to the device's sign-in: a new sign-in, which also replaces the key, ends the earlier tokens. Both routes answer with `Cache-Control: no-store`.
- Every other route below needs `Authorization: Bearer <access token>`. The token and the account's limit of 300 authenticated requests a minute are checked when the headers arrive. The token, the device, and the account are checked again after the body arrived and before it is validated, so that a slow body cannot carry a request past a revocation; sign-out, revocation, and lifting the lock check them a third time inside their transaction. Every failure is `401` with `unauthorized`.
- `POST /auth/sign-out` signs the current device out: the device, its agents, and their grants stay, its tokens stop working, and the next token needs a GitHub sign-in (P-65).
- `GET /devices` lists the account's own devices, newest first, with the sign-in expiry and the current device.
- `POST /devices/:deviceId/revoke` with `reason` `removed` or `lost` revokes one of the account's own devices in one transaction: its agents are disabled, their grants revoked, and their unfinished runs cancelled (`revokeDevice`). Another account's device answers `404` with `not_found`, also for the owner of a shared workspace; a revoked device answers `409` with `conflict`. `lost` also refuses new device registrations for 7 days; the current device cannot report itself `lost` (`409` with `conflict`), so that whoever holds it cannot lock the account's new devices.
- `POST /account/registration-lock/lift` lifts that lock from an active device.

Sign-out, revocations, and the lock write audit records. No `Authorization` header, token, nonce, or signature is logged.

The operator command (`db:account`) runs outside the API and cannot drop tokens from its memory: after disabling and enabling an account within 15 minutes, a token minted before the disable works again until it expires.

### `GET /ws` (WebSocket)

`/ws` is the only path that accepts a WebSocket handshake; a handshake on any other path gets `404` before the upgrade. `/ws` exists only with GitHub sign-in and the database, like the routes that need them (ADR 0014, "Configuration"); without them it answers the generic `404` as well, and no unauthenticated mode exists.

Before the upgrade:

1. A handshake with an `Origin` header that is not listed in `API_ALLOWED_ORIGINS` gets `403`. A handshake without `Origin` (Node.js, the Electron main process) is accepted. Browsers send `Origin` on every WebSocket handshake and apply no same-origin rule to WebSocket, so every browser origin that may connect must be listed. A renderer loaded from `file://` or a custom scheme sends the origin `null`, which cannot be listed.
2. At most 200 connections may wait for authentication at once (ADR 0014, "Limits"). Above that, the handshake gets `429` with `rate_limited` and `Retry-After: 10`, the longest time until a waiting connection authenticates or times out. No socket, timer, or nonce is created for it. Limits per remote address wait for the hosting decision on `trustProxy` (P-63).

Authentication (ADR 0014, "Device key and authentication"):

1. After the upgrade the server sends `auth.challenge` with a nonce (32 random bytes), a new connection ID, and the protocol version, and starts a 10-second timer (`WS_AUTH_TIMEOUT_MS`). The nonce lives only in API memory and only for this connection.
2. The device answers with exactly one `auth.response`: its device ID and a signature over `deviceAuthInput` with the purpose `ws`, `API_PUBLIC_ORIGIN` as the audience, the nonce, the device ID, and the connection ID. The nonce is used once: the connection accepts no second response.
3. The server verifies the signature with the device's current key first and checks the device state second, like `POST /auth/access-token`: an unknown device, a bad signature, and a disabled account get `auth_failed`; a revoked device gets `device_revoked`; a signed-out device, a last sign-in 30 days ago or more, and a GitHub revocation after the last sign-in get `sign_in_required`.
4. On success the server writes `devices.last_seen_at`, sends `auth.ok` with the user ID, the device ID, and the sign-in expiry (30 days after the last sign-in), and builds a frozen `AuthenticatedConnectionContext`: the connection ID, the identity (user and device), which is never null, and the time of the device's last sign-in.
5. A device has one live connection. A newer authenticated connection closes the older one with `connection_replaced`. The server writes at most one `connection.replaced` audit record per device per hour and logs the other replacements with a count.

Before `auth.ok`, no frame reaches `decodeClientEvent` or the event handler: a binary frame, a frame over 1 KiB (`MAX_AUTH_FRAME_BYTES`, measured on the raw frame before the JSON is parsed), a frame that is not JSON or that `decodeClientFrame` refuses, any frame other than `auth.response`, and a second frame close the connection with `protocol_violation`. A frame over 64 KiB closes with 1009 at any time, because the WebSocket library refuses it first.

Events after `auth.ok`:

1. Each text frame must contain one JSON event, which the gateway decodes with `decodeClientEvent`.
2. `bindIdentity` then binds the event to the connection (ADR 0006, identity binding). The event's `deviceId`, and for a `user` actor its `actor.userId`, must be the connection's; a mismatch is refused and audited as `event.identity_mismatch`, with the event ID as the subject and no workspace, because the event's workspace is unverified. It is never overwritten. Every event also needs a device that is not revoked and a user who is an active member of `event.workspaceId` at this moment: a claimed person whose `removed_at` is empty. A workspace that does not exist is refused like one without the user.
3. Only the result, a `VerifiedEvent` (a second brand next to `UnverifiedEvent`, defined in `src/gateway.ts`), reaches the event handler, together with the `AuthenticatedConnectionContext`. The handler's type accepts nothing else. The default handler logs the event ID, the event type, and the connection ID at `debug` level. Nothing is routed, relayed, stored, or answered yet: the reference binding of runs, agents, projects, and repositories comes with the first event types that carry those references (#27, #28).
4. Events are handled one after another, in the order they arrived. While events wait for their checks, the gateway stops reading from the socket, so a fast sender cannot queue without bound.
5. Anything else closes the connection. Frames that arrive after the gateway has decided to close are ignored.

| Close code | Reason                                                                                                            | When                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1001       | `server_shutdown`                                                                                                 | The API shuts down.                                                                                                               |
| 1003       | `binary_not_supported`                                                                                            | After authentication: a binary frame.                                                                                             |
| 1007       | `invalid_json`                                                                                                    | After authentication: a text frame that is not JSON.                                                                              |
| 1008       | `malformed`, `unsupported_version`, `unknown_type`, `invalid_payload`, `invalid_actor`, `not_allowed_from_device` | After authentication: `decodeClientEvent` refuses the event.                                                                      |
| 1008       | `identity_mismatch`, `not_a_member`                                                                               | After authentication: `bindIdentity` refuses the event.                                                                           |
| 1009       | (set by the WebSocket library)                                                                                    | A frame larger than 64 KiB.                                                                                                       |
| 1011       | `internal_error`                                                                                                  | The server failed, for example its database.                                                                                      |
| 4000       | `auth_failed`                                                                                                     | An unknown device, a bad signature, or a disabled account.                                                                        |
| 4001       | `auth_timeout`                                                                                                    | No `auth.response` within 10 seconds.                                                                                             |
| 4002       | `device_revoked`                                                                                                  | A valid signature from a revoked device, or after authentication an event from a device that was revoked since.                   |
| 4003       | `sign_in_required`                                                                                                | A valid signature, but the device signed out, its last sign-in is 30 days old or older, or GitHub reported a revocation after it. |
| 4004       | `connection_replaced`                                                                                             | A newer connection of the same device authenticated.                                                                              |
| 4005       | `protocol_violation`                                                                                              | Before authentication: a frame that breaks the rules above.                                                                       |

The codes 4000 to 4005 and their reasons are `WS_CLOSE_CODES` of `@mymandev/protocol`, whose README lists what the desktop does for each. The codes from 1003 to 1011 stay provisional (P-24).

No authentication frame, nonce, or signature is logged. A refused connection is logged with its connection ID and the close reason only (`protocol_violation` at `debug` level, with what broke the rule, and the others at `info`), and an authenticated connection with its connection ID, user ID, and device ID.

`ConnectionRegistry` (`src/gateway.ts`) holds the open connections of the instance: the unauthenticated ones, for their cap, and the live connection of each device. `closeDevice(deviceId, reason)` and `closeUser(userId, reason)` close live connections with a close reason of the protocol. `buildApp` takes a registry as an option, so tests can count and close connections.

Decisions that ADR 0014 leaves open, settled by the Project Manager on 2026-10-31 (#89):

- A frame that breaks the rules before authentication closes with the new code `protocol_violation` (4005). The desktop does not reconnect on its own and shows an error; when the protocol versions differ, it asks the person to update.
- Above the cap of 200 unauthenticated connections, the handshake gets `429` with `rate_limited` and `Retry-After` before the upgrade.
- `devices.last_seen_at` is written when a connection authenticates.
- Without the sign-in configuration or without the database, `/ws` answers `404`; the unauthenticated mode of M1-02 is gone.

Still to come in #89, part B:

- every 60 seconds, one batched query re-checks the devices in the registry for a revocation, a disabled account, a sign-out, `users.sign_in_required_at`, and a connection past the 24-hour grace after the 30-day sign-in, and closes those connections with the matching reason;
- closing a device's socket after its revocation commits (`device_revoked`), after a sign-out (`sign_in_required`), and after a sign-in that replaces the device (#87, #88);
- sending each run that a revocation cancelled as `agent.run.state_changed` with a `system` actor, `deviceId: null`, and the reason `device_revoked` to the workspace's connections;
- the account frames for a registered and a revoked device, sent only to the account's own connections;
- updating `devices.last_seen_at` every 5 minutes for an open connection, in the 60-second sweep.

Until then, an authenticated connection stays open after a sign-out, a disabled account, or the end of its sign-in; the per-event checks still refuse events from a revoked device and from a person who is not an active member.

## Rules

- Credentials never appear in URLs, including the WebSocket URL. A browser `WebSocket` cannot set headers, which invites `/ws?token=...`; the query string would then reach proxies and browser history. WebSocket authentication uses the first message, `auth.response`.
- Logs contain the request method, the path without the query string, and the remote address. Errors are logged with their type, codes, message, and stack; an error that may carry query data (an own `query`, `params`, or `detail` property) is logged without message and stack.
- An event from a device stays `UnverifiedEvent` until `bindIdentity` has bound it to the authenticated connection. Never cast it to `ProtocolEvent` or to `VerifiedEvent`; only `bindIdentity` creates a `VerifiedEvent`, and the event handler accepts only that type with an `AuthenticatedConnectionContext`.
- `src/server.ts` is the only module with side effects. Tests build the application with `buildApp` from `src/app.ts` and use `inject` and `injectWS` without a network.

## Not included

Sessions, CORS, OpenAPI, TLS, permission enforcement, the reference binding of events (#27, #28), event routing, relay, and storage, the parts of #89 listed above as still to come, Docker, deployment configuration, clustering, a build step, pretty-printed logs, and a Fastify type provider.
