# ADR 0009: Fastify 5 for the cloud API, with hardened defaults

- Status: Accepted (2026-10-28)
- Date: 2026-10-27
- Decided by: Project Manager

## Context

M1-02 needs a REST skeleton, a WebSocket gateway, a health endpoint, configuration, and protocol integration (#20). Authentication, persistence, the WebSocket message protocol, and deployment are out of scope. [ADR 0001](0001-internal-packages-export-typescript-source.md) requires erasable TypeScript that Node.js runs directly, which excludes decorator frameworks.

## Options considered

| Option                          | Result (research and integration runs)                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fastify 5 + @fastify/websocket  | Built-in pino JSON logging, `app.inject()` for HTTP and `app.injectWS()` for WebSocket tests without a network, shutdown hooks, its own TypeScript types (clean under TypeScript 6), runs from source through type stripping. Several unsafe defaults must be overridden (below). |
| Hono 4 + @hono/node-server + ws | No default body limit, no structured logger, no WebSocket inject, manual shutdown; @hono/node-ws is deprecated; Hono 5 is at release candidate.                                                                                                                                   |
| Express 5 + ws                  | The default error handler sends `err.stack` unless `NODE_ENV=production`; no inject; the WebSocket upgrade is wired by hand; types from DefinitelyTyped.                                                                                                                          |
| NestJS                          | Decorators and parameter properties fail under Node.js type stripping ("SyntaxError: Invalid or unexpected token"); needs a separate build pipeline, rxjs, and reflect-metadata.                                                                                                  |

## Decision

Fastify 5 with @fastify/websocket, built by a `buildApp(options)` function that returns an application that is not yet listening. These defaults are overridden, each locked by a test:

| Setting                               | Fastify default                                              | M1-02 value                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error response body                   | Sends `err.message` in every environment                     | Custom error handler. A status outside 400 to 599 becomes 500. A 5xx is logged and gets a generic body. A 4xx keeps the message only for Fastify's own errors (code starting with `FST_`, for example validation, 413, 415); every other 4xx gets the status text, for example "Not Found". |
| Ajv `removeAdditional`, `coerceTypes` | Silently strips unknown properties and coerces types         | Both `false`: reject instead.                                                                                                                                                                                                                                                               |
| `requestTimeout`                      | `0` (no timeout)                                             | 30 seconds.                                                                                                                                                                                                                                                                                 |
| `bodyLimit`                           | 1 MiB                                                        | `API_BODY_LIMIT_BYTES`, default 65,536 ([ADR 0010](0010-api-configuration-and-runtime.md)).                                                                                                                                                                                                 |
| WebSocket `maxPayload`                | 100 MiB (ws default)                                         | 64 KiB; larger frames close with 1009.                                                                                                                                                                                                                                                      |
| WebSocket frames after a close        | Still delivered to the `message` handler                     | Ignored: the handler returns unless `socket.readyState` is `OPEN`.                                                                                                                                                                                                                          |
| WebSocket Origin                      | Not checked; browsers apply no same-origin rule to WebSocket | A `preValidation` hook on `/ws`: a request with an `Origin` header that is not listed in `API_ALLOWED_ORIGINS` (empty by default) gets 403. A request without `Origin` (Node.js, Electron main) is accepted.                                                                                |
| WebSocket handshake on other paths    | Upgraded on every GET route; the full URL is logged          | An `onRequest` hook answers a handshake on any path other than `/ws` with the generic 404, before the upgrade.                                                                                                                                                                              |
| `HEAD /ws`                            | Exposed; runs the WebSocket handler, which fails with 500    | `exposeHeadRoute: false` on `/ws`: 404.                                                                                                                                                                                                                                                     |
| WebSocket shutdown                    | Clients see close code 1005                                  | Close 1001 `server_shutdown`, wait up to the grace period (2 seconds), then terminate.                                                                                                                                                                                                      |
| Not-found response                    | Echoes and logs the method and the full URL                  | Generic `{"statusCode":404,"error":"Not Found","message":"Not Found"}`, nothing logged.                                                                                                                                                                                                     |
| Request log line                      | Logs the full URL, including the query string                | The `req` serializer logs the method, the path without the query string, and the remote address.                                                                                                                                                                                            |
| Error log                             | Logs every own property, the message, and the stack          | The `err` serializer logs the type, the codes, the message, and the stack; message and stack are replaced when the error or its cause carries `query`, `params`, or `detail` (database errors).                                                                                             |
| `trustProxy`                          | `false`                                                      | `false`, set explicitly.                                                                                                                                                                                                                                                                    |
| Prototype poisoning                   | `onProtoPoisoning: "error"`                                  | Kept; a JSON body with `__proto__` returns 400.                                                                                                                                                                                                                                             |
| Bind address                          | Set by the caller                                            | `API_HOST`: `127.0.0.1` (default), `::1`, or `localhost` only, until authentication exists (M2).                                                                                                                                                                                            |

REST skeleton: `GET /health` returns `{ "status": "ok", "version": "<package version>" }` with a response schema, so Fastify serializes only the declared fields. No other REST route exists in M1-02.

WebSocket gateway on `GET /ws`:

- The Origin check above runs before the upgrade.
- Each connection gets a `ConnectionContext`: a `connectionId` (UUIDv7) and `identity: null`. Authentication in M2 fills `identity` with the user and the device.
- Frames that arrive after the handler has requested a close are ignored.
- Text frames only. A binary frame closes with 1003 `binary_not_supported`.
- Each text frame is parsed with `JSON.parse`; a failure closes with 1007 `invalid_json`.
- The parsed value goes through `decodeClientEvent` from `@mymandev/protocol` ([ADR 0006](0006-event-envelope-v0.md)). A failure closes with 1008 and the decode code as the reason (`malformed`, `unsupported_version`, `unknown_type`, `invalid_payload`, `invalid_actor`, `not_allowed_from_device`).
- A valid event is passed, as `UnverifiedEvent`, together with its `ConnectionContext` to an injected `onEvent(event, context)` handler. The default handler logs the event ID, the event type, and the connection ID at debug level. There is no routing, fan-out, persistence, presence, or reply; those belong to M2, behind `bindIdentity` ([ADR 0006](0006-event-envelope-v0.md)).
- These close codes and reasons are provisional. M2-01 owns the WebSocket protocol and may change them.

Rule for M2 and later: credentials never appear in URLs. A browser `WebSocket` cannot set headers, which invites `/ws?token=...`; the query string would then reach proxies and history even though the API does not log it. WebSocket authentication uses the first message or the `Sec-WebSocket-Protocol` header (P-48).

Not in M1-02: authentication, sessions, tokens, rate limits, CORS, OpenAPI, TLS, database access, permission enforcement, Docker, deployment configuration, clustering, pino-pretty, tsx, and a Fastify type provider ([ADR 0003](0003-zod-runtime-validation.md)).

## Consequences

- Fastify ships security releases often: eight advisories in its 5.12 line between August and October 2026, four of them high (the last one was GHSA-389g-gv7q-r4x8). With exact pins, upgrades are manual, so releases must be tracked (P-23).
- The overridden defaults are easy to lose in later edits. The tests for the generic 5xx body, validation without coercion or property removal, 413, 404, prototype poisoning, the log redaction (including a refused handshake on `/health` and `HEAD /ws`), and the WebSocket close codes, including the shutdown close, keep them in place.
- Because `coerceTypes` is `false`, numeric query and path parameters must be declared as pattern-checked strings when they appear in M2.
- @fastify/websocket logs client-caused errors such as "Max payload size exceeded" at error level. A custom `errorHandler` may be needed later.
- Clients created by `injectWS` never finish the closing handshake, so tests pass a short shutdown grace period to keep `app.close()` fast. `injectWS` also needs `await app.ready()` first; without it the returned promise never settles.
- The API cannot be reached from another machine in M1. Widening `API_HOST` is part of the authentication work in M2.
- The error serializer drops message and stack for database errors. The database package (M1-03) also turns every query error into an error without query data, so the serializer is a second line of defense.
- A major Fastify release (6) is in alpha; a major upgrade will come.

## Dependency policy

- fastify 5 and @fastify/websocket 11 (with ws 8), exact pins, as `dependencies` of `@mymandev/api`. Never a Fastify release older than the fix for the latest Fastify security advisory. Follow Fastify security releases (P-23).
- `@types/ws` 8, exact pin, as a `devDependency` of `@mymandev/api`, for the socket types.
- pino comes through Fastify and is not declared. No pino-pretty, no Fastify type provider in M1-02.
- Exact versions live in [`apps/api/package.json`](../../../apps/api/package.json) and `package-lock.json`.

## Evidence

- [`apps/api/src/app.ts`](../../../apps/api/src/app.ts) (`buildApp`, error and not-found handlers, WebSocket plugin options and shutdown, `/health`), [`apps/api/src/log.ts`](../../../apps/api/src/log.ts) (`serializeRequest`, `serializeError`), and [`apps/api/src/gateway.ts`](../../../apps/api/src/gateway.ts) (`registerGateway`, `originGuard`, `CloseCode`, `ConnectionContext`).
- [`apps/api/src/app.test.ts`](../../../apps/api/src/app.test.ts): `/health` body, generic 404, thrown errors with `statusCode` 200, 302, 0, 404, and 500 never send their message, validation 400 without coercion or property removal, 413 and the request timeout, `__proto__` 400, and logs without query strings or a client-chosen forwarded address (also for a WebSocket handshake on `/health`, which gets 404 with or without a foreign Origin, and for `HEAD /ws`, which gets 404), with the redacting error serializer wired into the logger and tested on its own.
- [`apps/api/src/gateway.test.ts`](../../../apps/api/src/gateway.test.ts): a valid event reaches `onEvent` stripped with `identity: null`, close codes 1003, 1007, 1008 (every decode code and `not_allowed_from_device`), and 1009, no event after an invalid frame, the Origin check, and close 1001 `server_shutdown` on shutdown.
- Usage and close codes: [`apps/api/README.md`](../../../apps/api/README.md).
- Review record: M1 Technical Decision Set, revision 2 of 2026-10-27 (ADR 0009, Sections 2.3 and 2.5), linked from the M1-02 pull request.

## Needs Project Manager decision

Answered by the Project Manager on 2026-10-28.

- Fastify 5 with @fastify/websocket (P-22, recommended: accept).
  - Accepted.
- A follow-up for dependency update tracking (for example Dependabot) because of the Fastify release rate (P-23, recommended: a separate follow-up task).
  - A separate follow-up task.
- The WebSocket close codes are provisional until M2-01 (P-24, recommended: accept).
  - Accepted.
- `/health` returns the application version. Remove it if the version should not be public (P-25, recommended: keep; it is the application version, not the Fastify version).
  - Keep.
- Credentials never in URLs; WebSocket authentication through the first message or `Sec-WebSocket-Protocol` (P-48, recommended: accept; M2-01 designs the handshake under this rule).
  - Accepted. M2-01 designs the handshake under this rule.
