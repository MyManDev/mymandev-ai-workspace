# ADR 0014: Accounts, device credentials and invitations

- Status: Proposed
- Date: 2026-10-28
- Decided by: (filled in by the Project Manager on acceptance)

## Context

The desktop application will be publicly downloadable from mymandev.com. Anyone can run it, or a modified build of it. The cloud API therefore never trusts an identity that a client only claims. Each person connects their own AI provider. Provider credentials stay on the device and never reach the cloud. Repository access and AI provider access are separate capabilities.

The Project Manager decided on 2026-10-28 (#15 and #14):

- People sign in with GitHub. The desktop application signs in through the system browser, not an embedded window. Sign-in asks only for the account identity; repository access stays a separate capability.
- Each device gets its own credential, which can be revoked without affecting the person's other devices.
- People without a GitHub account cannot sign in for now. Another sign-in method can be added later.
- The person who creates a workspace defines its people. Claiming a predefined person needs a single-use, expiring invitation that is bound to that person. Adding a new person needs approval from the workspace creator or another approved person.
- A workspace ID only identifies a workspace. It never lets anyone act as a person ([ADR 0005](0005-workspaces-contain-projects.md), P-13).

Both issues leave the details to this record: the OAuth flow, the device credential, how HTTP requests and WebSocket connections authenticate, lifetimes, revocation and recovery, the person model, invitations, approval, removal, and what removal does to grants and history.

Accepted decisions that constrain it:

- [ADR 0003](0003-zod-runtime-validation.md): the validator for REST request bodies is chosen with the first REST route that has a body (P-06).
- [ADR 0004](0004-uuidv7-identifiers.md): the server generates every entity ID. An ID is never a secret. Secrets are 32 random bytes, base64url, stored only as a SHA-256 hash (P-10).
- [ADR 0005](0005-workspaces-contain-projects.md): membership grants visibility only. Joining requires an invitation token and a server-side membership check (P-13).
- [ADR 0006](0006-event-envelope-v0.md): `decodeClientEvent` returns `UnverifiedEvent`. From M2, `bindIdentity` binds every event to the authenticated connection, rejects and audits a mismatch, and checks device revocation and workspace membership for every event (P-15). Every event carries a `workspaceId`.
- [ADR 0007](0007-agent-run-lifecycle-v0.md): every run transition after creation comes from the agent's host device. Commands are out of scope for v0.
- [ADR 0008](0008-capability-vocabulary-v0.md) and [ADR 0015](0015-capability-and-permission-contract-v0.md): `@mymandev/permissions` implements `isGrantActive`, which judges a grant together with facts about its agent, host device, project, and the granting user's membership; a grant is inactive when the host device is revoked or the granting user is no longer a member of the workspace. The writer rules of ADR 0015 (P-77) revoke the affected grants in the same transaction when an agent is disabled, a device is revoked, or a member is removed; the transactions below follow them.
- [ADR 0009](0009-fastify-cloud-api.md): credentials never appear in URLs, and WebSocket authentication uses the first message or `Sec-WebSocket-Protocol` (P-48). `/ws` checks the Origin. Request logs drop the query string. `trustProxy` is off. `API_HOST` is loopback only until authentication exists. The close codes are provisional until M2-01 (P-24). The error handler sends the status text instead of the message for every 4xx that is not a Fastify error, and its body has no machine-readable code.
- [ADR 0010](0010-api-configuration-and-runtime.md): configuration reads only known `API_` variables and never prints a value; today every variable has a default. The API has no secret yet; `DATABASE_URL` arrives with the first API feature that stores data.
- [ADR 0011](0011-drizzle-sql-migrations.md), [ADR 0012](0012-pglite-database-tests.md), and [ADR 0013](0013-m1-data-model.md): generated migrations that run in one transaction, `text` vocabularies with CHECK constraints that equal a constant, composite foreign keys, `ON DELETE RESTRICT`, and an application role without `DELETE`. PGlite is a single connection. The `./testing` export arrives when the API first needs a test database. The account columns arrive with this implementation (P-38).

Gaps in the current code:

- `workspace_members` has the primary key (`workspace_id`, `user_id`), and `user_id` is required. It cannot hold a person who has no account yet, a role, or a second membership period after a removal.
- The gateway treats every text frame as an event and creates its context with `identity: null`. An authentication frame would close the connection today.
- No audit table exists, although ADR 0006 requires an audit record on a mismatch from M2. The audit trail (#37) is planned for M3.
- The API is not reachable from the internet. GitHub's webhook, two physical devices (M2-05), and production need a public HTTPS address. GitHub's callback does not: the person's browser follows it, so sign-in also works with an API on a loopback address during development.

## Options considered

GitHub application type:

- A public GitHub App with no permissions (chosen). GitHub recommends GitHub Apps over OAuth apps. A person can authorize the app without installing it, and authorizing allows reading the public profile. Its user tokens expire after 8 hours. GitHub documents that a GitHub App receives the `github_app_authorization` webhook by default when a person revokes its authorization, and that the app cannot unsubscribe; the event also arrives for a person who authorized the app without installing it (checked in #67). Since January 2026 (public preview), the consent screen leaves out the "Act on your behalf" note when the app requests no repository, organization, or enterprise permission; the development app's consent screen showed no such note (#67). A private app can be authorized only by members of the organization that owns it, so the app must be public.
- An OAuth app. It works without a scope, but no revocation webhook for OAuth apps was found. Repository access would later mean the `repo` scope, which covers every repository the person can reach.

Sign-in flow:

- Authorization code with PKCE, brokered by the API, bound to the browser that started it, confirmed on a page of the API, and handed to a loopback listener of the desktop in a form POST (chosen). GitHub requires the client secret for the code exchange, with or without PKCE, so only the API can redeem GitHub's code. GitHub redirects to one exact callback on the API. The API then hands its own single-use code to a listener of the desktop on `127.0.0.1` (RFC 8252) in a request body.
- The same flow with the sign-in code in the query string of a redirect to the loopback listener. Rejected: anyone can start a sign-in with their own PKCE pair and send the link to a victim. GitHub completes the authorization without a prompt for a person who has already authorized the app. Nothing listens on the victim's loopback port, so the browser shows a connection error with the code in the address bar, and a phishing page asks the victim to paste that address back. Attackers have used this pattern (ConsentFix) against the loopback flow of Azure CLI.
- The desktop redeems GitHub's code itself. Rejected: the desktop would have to ship the client secret, and a secret shipped to every user is not a secret (RFC 8252, section 8.5).
- The OAuth device flow. Rejected: GitHub's best-practice pages advise against it outside constrained environments such as command-line tools, because an attacker can start a device flow and send the code to a victim. Device-code phishing against GitHub has been published as a technique.
- A code that the person copies from the browser into the application. Rejected: the person carries the code to whichever application asks for it, which is the same phishing pattern.
- Completion by polling the API with a transaction ID. Rejected: whoever starts a flow and sends its link to a victim would receive the victim's sign-in.
- A custom URL scheme as the redirect. Rejected: the scheme must be registered at packaging time (#17 is deferred), it does not work in development launches on macOS and Linux, and any other application can register the same scheme.
- An embedded login window. Excluded by the decision in #15. RFC 8252 forbids it.

Where sign-in attempts, sign-in codes, and access tokens live:

- API memory, keyed by hashes, with global caps (chosen). They live for minutes. After a restart the desktop repeats the sign-in or fetches a new token. HTTP challenges live there already.
- Database tables. Rejected: every unauthenticated request to start a sign-in would create a row in a table that the application role can never delete from, and every device would add a token row every 15 minutes.
- Tokens signed with a server key. Rejected: a new server secret, with no gain over memory while the API runs as one instance.

Device credential:

- A device key pair, replaced at every GitHub sign-in (chosen). The desktop generates an Ed25519 key pair. The private key never leaves the device, and the server stores only the public key. A WebSocket connection authenticates by signing a server nonce. HTTP requests use a short-lived opaque access token that a signed challenge mints. No long-lived secret travels over the network or can reach a log, and a replayed signature is useless. Replacing the key at each sign-in bounds how long a copied key works. The key can later move into hardware (Secure Enclave, TPM) with an algorithm change.
- A long-lived opaque bearer secret with rotation. It fits the current wording of ADR 0004. But RFC 9700 rotation fails badly on a desktop: when a rotation response is lost to sleep, a network drop, or a crash, reuse detection logs the person out, unless a grace window weakens the detection. The secret travels on every connection.
- A long-lived opaque bearer secret without rotation. The simplest option. RFC 9700 requires a public client's refresh token to be rotated or bound to a key, and a copied secret works without any sign until it is revoked.
- Signed JWT access tokens. Rejected: a new signing secret and a new dependency, and revocation waits for expiry unless every request reads the database anyway.

WebSocket authentication under P-48:

- The first message, as challenge and response (chosen). A server nonce cannot travel in a handshake header.
- `Sec-WebSocket-Protocol` with a token. Rejected: it carries a bearer secret and no server nonce.
- A token in the URL. Forbidden by P-48.

Where the GitHub identity is stored:

- A `user_identities` table keyed by the provider and its immutable account ID (chosen). `users` stays independent of the provider, and a later sign-in method adds rows instead of columns.
- GitHub columns on `users`. Simpler, but the next sign-in method changes `users` again.

Protecting the device key on Linux without a secret service:

- A key file encrypted with a passphrase that the person enters at start (chosen). The device keeps its identity and can host agents.
- Memory only, with a GitHub sign-in at every start. Rejected: every start registers a new device, which strands the agents hosted on the previous one and sends a new-device notice each time, so people learn to ignore the notice that reveals a real takeover.
- A separate kind of short-lived device. Rejected: a second device model with its own rules.
- An unprotected key file. Offered only as an explicit choice after a warning.

Signing out:

- Signing out keeps the device registered and requires a GitHub sign-in before its key works again (chosen). The agents hosted on the device survive.
- Signing out revokes the device. Rejected: it disables every agent hosted on the installation for good.

New devices of the same person:

- No approval in general; for 7 days after a device is revoked as lost, a new device needs the lock lifted from another active device (chosen).
- Approval from an existing device for every new device. Rejected: recovery becomes impossible when the only device is lost.
- Suspending a device that a new device revokes, with a veto window for the older device. Rejected: GitHub stays the root of recovery, so an attacker who controls the GitHub account can register devices without limit and a veto only delays them. Every revocation would also gain a waiting state, which slows the containment of a real lost device.

Predefined people:

- `workspace_members` becomes the person table, with its own ID and a `user_id` that stays empty until someone claims the person (chosen).
- A placeholder `users` row for each predefined person. Rejected: a person who already has an account would end up with two `users` rows, and merging them is impossible with `ON DELETE RESTRICT` and no `DELETE`.
- The invitation as the only record of a predefined person. Rejected: the people of a workspace must be listable, nameable, and removable before anyone claims them.
- Letting an approver attach a join request to an existing predefined person. Rejected: the decision requires an invitation to claim a predefined person, and one claim path is easier to secure.

Invitation delivery:

- A code that the person pastes into the desktop (chosen). It meets P-48 completely and needs no URL scheme and no email.
- An HTTPS link with the code in the fragment. A later option, with the website (#16). The fragment never reaches a server but stays in browser history, so it would be a documented exception to P-48.
- A custom-scheme link with the code. Rejected: another application can register the scheme. On Windows and Linux the link arrives as a command-line argument, which Windows can record in plain text in the Security event log.
- Email. Rejected: sign-in requests no email address.

Who approves a new person:

- The owner and admins (chosen, P-58).
- Every active member. Simpler, but one compromised member account could admit anyone.

Ownership transfer:

- The target accepts, and only a device older than 72 hours can offer a transfer (chosen).
- An immediate transfer. Rejected: a device registered minutes earlier after a takeover could hand every workspace away at once.
- Acceptance plus a 24-hour waiting time. Rejected: the 72-hour rule already gives the owner's other devices notice.

Error codes on HTTP:

- One error body with a `code` from a closed vocabulary, produced by the error handler from a typed error (chosen).
- Routes that send their own error replies around the error handler. Rejected: two paths for errors, and the tests for the generic body would cover only one of them.

32-byte values in the database:

- Lowercase hexadecimal `text` with a pattern CHECK (chosen). drizzle-orm 0.45 has no built-in `bytea` column.
- `bytea` through a custom column type. Half the size, but it needs a custom type whose generated migrations are not yet proven free of drift.

## Decision

### GitHub App

- Three kinds of GitHub App, each with exactly one callback URL (P-49):
  - one production app and one staging app, owned by the MyManDev organization and operated by the Project Manager, whose secrets exist only in the secret store of the hosting environment. GitHub's consent screen names the account that owns the app ("by <owner>"), so a person sees the organization, not a personal account (checked in #67);
  - one development app per contributor, registered by that contributor, whose secrets stay in that contributor's local `.env`. The registration steps are in [`docs/development/GITHUB-APP.md`](../../development/GITHUB-APP.md).
- Settings of every app:
  - public ("Any account"), because a private app can be authorized only by members of the organization that owns it;
  - no repository, organization, or account permissions; the email permission is not requested;
  - "Request user authorization (OAuth) during installation" off, and no setup URL;
  - expiring user tokens on; device flow off;
  - one callback URL, `<API_PUBLIC_ORIGIN>/auth/github/callback`, HTTPS for production and staging, with wildcard matching off. GitHub's settings page calls it the redirect URI, and it accepts `http://127.0.0.1:<port>/...` for a development app (checked in #67);
  - a webhook URL with a secret, so that `github_app_authorization` events arrive. A development app may leave the webhook inactive; testing the webhook locally needs a relay to the local API.
- Anyone can install a public app. An installation grants nothing. `installation` and `installation_repositories` events are acknowledged and ignored.
- Repository access never comes from this app. If the cloud ever needs repository access, a second GitHub App is installed on selected repositories. Git on the device keeps using the person's local Git credentials (M1-05).
- Only the API talks to GitHub. The client ID, the client secret, and the webhook secret exist only in server configuration (below). The desktop knows only the API base URL.

### Sign-in

Flow (P-50):

1. The desktop main process creates a PKCE verifier and a state (32 random bytes each, base64url, 43 characters). It creates its device key pair if it has none. It listens on `127.0.0.1` (the host is passed explicitly), port 0, path `/callback`. It shows the pairing code (below) and opens the system browser with `shell.openExternal` on `<API base>/auth/github/authorize`, with `code_challenge` (S256 only), `code_challenge_method`, `redirect_uri`, and `state` as query parameters. On a repeated sign-in it adds `login` with the GitHub login that the device belongs to; on a first sign-in, or after `device_account_mismatch`, it adds `prompt=select_account`. None of these values is secret.
2. The API accepts `redirect_uri` only as `http://127.0.0.1:<port>/callback` with a port from 1024 to 65535, `state` and `code_challenge` only as exactly 43 base64url characters, `login` only when it matches the login rule, and `prompt` only as `select_account`. For anything else it shows an error page and never redirects. It creates a sign-in attempt in memory that lives 10 minutes, and sets a cookie with the `__Host-` prefix (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`) that holds 32 random bytes; the attempt keeps only the hash. It redirects to GitHub with its own client ID, its exact callback URL, its own state, and its own PKCE pair, and forwards `login` and `prompt`.
3. On GitHub's callback the API requires the cookie of the attempt that the state names, and consumes the callback once. It exchanges the code with the client secret and its PKCE verifier, with the parameters in a form-encoded request body, never in the URL. It calls `GET /user` and keeps the numeric `id`, the `login`, the `name`, and `created_at` in the attempt. It then deletes the user access token with `DELETE /applications/{client_id}/token`, which neither revokes the person's authorization nor sends the revocation webhook (checked in #67), and discards both tokens: they are never stored, logged, or sent to the desktop. It never logs a GitHub response body. A token response that carries an `error` field is a failure whatever its HTTP status, because GitHub can return an exchange error with status 200, and the API never retries an exchange, because GitHub consumes the code on the first attempt, also on a failed one (checked in #67).
4. The API shows its own confirmation page. The page names the GitHub login and the pairing code, and tells the person to continue only if the MyManDev application on this computer shows the same code and they started this sign-in themselves. Continue and Cancel are form POSTs that need the cookie. When GitHub reports an error or the person declines, the API skips the confirmation and sends `error` and `state` to the listener as in step 5.
5. After Continue, the API creates a sign-in code (prefix `mmdc_`, single use, valid for 60 seconds) in memory, bound to the attempt's GitHub identity, the desktop's PKCE challenge, and `redirect_uri`. It answers with a page that submits a form POST with `code` and `state` to `http://127.0.0.1:<port>/callback`, by a script and with a visible button for a browser that does not run it. The code never appears in a URL, in the address bar, or in browser history.
6. The listener accepts only `POST /callback` with the `Host` header `127.0.0.1:<port>`, a form body, and the expected state. It answers every other request with 404 and keeps listening. It closes after the valid request, after a cancel in the application, or after 10 minutes. Its return page loads no external resources and sends `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. The desktop then brings its window to the front.
7. The desktop posts the code, its PKCE verifier, `redirect_uri`, and the device registration to `POST /auth/sign-in`. The registration is one of:
   - a new device: its public key, key algorithm, label, platform, and a signature by the new key; optionally the ID of the previous device of this installation, when its key was lost;
   - an existing device: its ID, a new public key, and two signatures over the same input, one by the current key and one by the new key.
8. The API, in one transaction, creates or updates the user and the GitHub identity, registers the device or replaces its key, applies the device limits and the registration lock, and revokes the named previous device with the reason `replaced` if it belongs to the same account. It answers with the user ID, the device ID, the display name, the GitHub login, and the sign-in expiry. It returns no credential, because the device already holds its key.

Rules:

- The pairing code is the first 4 bytes of the decoded `code_challenge`, read as an unsigned big-endian integer, modulo 1,000,000, written as 6 digits. The protocol package computes it, so the desktop and the API show the same digits. It is not secret. It lets a person notice a sign-in that their own application did not start.
- If `shell.openExternal` fails, the desktop shows the authorize URL to copy. It holds no secret.
- What counts as a credential under P-48: a value that authenticates or authorizes a request on its own. GitHub's code on the API callback is not one: it is single use, short-lived, and useless without the client secret and the API's PKCE verifier. It is the only value of the flow that appears in a URL, and the request log already drops the query string. The sign-in code travels only in request bodies.
- The attempt, the API's PKCE verifier for GitHub, and the GitHub identity of an unfinished sign-in exist only in API memory and are dropped when the attempt is used or expires. The verifier is kept readable there; this is the one exception to the hashing rule of ADR 0004.
- The API never accepts a GitHub token from a client as proof of identity. It does not try to tell official builds from modified ones. Security never depends on which client is used.

### Accounts

- Accounts are keyed on GitHub's numeric user ID, which GitHub never changes or reuses. The login is display data: it is refreshed at each sign-in and never used for lookup or authorization. The GitHub name only sets the first `users.display_name` (below). A login can pass to another person after a rename, so nothing in the system is resolved by login.
- The first sign-in creates the user. `users.display_name` starts as the GitHub name if it passes the text rule and the length limit of ADR 0005, and as the login otherwise.
- The login must match `^[A-Za-z0-9_-]{1,39}$`, which includes managed user accounts (`handle_shortcode`). The API and the database CHECK use the same pattern. A sign-in whose login does not match is refused with `unsupported_account`.
- No email address and no avatar are stored. The creation time of the GitHub account is stored, and approvers see it.
- The device label is chosen by the person. The desktop suggests one from the platform, never from the host name, because host names often contain a person's name.
- An installation holds one account at a time. A sign-in with another GitHub account on an installation whose device is not revoked is refused with `device_account_mismatch`. The error body carries no login (P-66); the desktop shows the login of the account it holds and offers to sign in as that login, after which the device can be removed so that another account can sign in.
- A repeated sign-in on a device that is not revoked keeps the device ID and replaces its key. Agents and messages that reference the device stay valid.
- An account has at most 20 active devices and registers at most 10 new devices per 24 hours.

### Device key and authentication

- The device credential is an Ed25519 key pair generated with `node:crypto` in the desktop main process (P-51). The private key never leaves the device. The server stores the 32-byte public key and its algorithm. v0 accepts exactly one algorithm, `ed25519`; the algorithm column lets ES256 be added later for hardware-backed keys (P-52).
- Each GitHub sign-in replaces the key. The server rejects the previous key from the commit on. The desktop keeps the previous key until one authentication with the new key succeeds, and tries the new key first. A key copied earlier stops working at the next sign-in, at most 30 days later.
- Every signature covers a domain-separated input, as UTF-8 lines:
  1. `mymandev-device-auth-v0`;
  2. the purpose: `ws`, `http`, or `sign-in`;
  3. the audience: the API's public origin;
  4. the server nonce, or the sign-in code;
  5. the device ID, or empty for a new device;
  6. the connection ID (`ws`), the challenge ID (`http`), or the new public key (`sign-in`).

  Every line has a fixed character set without a line break, so the input is unambiguous. A signature for one purpose, server, or connection is never accepted for another. The desktop's audience is the origin of its API base URL and must equal `API_PUBLIC_ORIGIN` exactly. The protocol package builds the input. Signing and verification use `node:crypto` in the desktop main process and in the API.

- WebSocket (M2-01 designs the frames under these rules):
  1. After the upgrade, which keeps the Origin check, the server sends `auth.challenge` with a nonce (32 random bytes), the connection ID, and the protocol version. It starts a 10-second timer.
  2. The client sends exactly one `auth.response` with its device ID and a signature (purpose `ws`). Before success, any other frame, a second frame, or a frame over 1 KiB closes the connection. No frame reaches `decodeClientEvent` or the event handler before success.
  3. The server verifies the signature first and the device state second (table below).
  4. On success the server sends `auth.ok` with the user ID, the device ID, and the sign-in expiry. It builds a new frozen context of a separate type, `AuthenticatedConnectionContext`, whose identity is never null. `bindIdentity` and the event handler accept only that type.
  5. One live connection per device. A newer authenticated connection replaces the older one, which closes with `connection_replaced`. The server writes at most one audit record for this per device per hour and logs a count of the rest.
  6. The close codes come from the private range 4000 to 4999; M2-01 assigns the numbers.

| Close reason          | When                                                                                                                   | What the desktop does                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth_failed`         | Unknown device, bad signature, or disabled account.                                                                    | Does not reconnect. Shows the error and offers a sign-in.                                                                                                                         |
| `auth_timeout`        | No `auth.response` within 10 seconds.                                                                                  | Reconnects with backoff.                                                                                                                                                          |
| `device_revoked`      | A valid signature from a revoked device.                                                                               | Does not reconnect. Stops local execution, deletes the key, and creates a new key pair before the next sign-in.                                                                   |
| `sign_in_required`    | A valid signature, but the device signed out, its last sign-in is older than 30 days, or GitHub reported a revocation. | Does not reconnect. Shows an in-app prompt with a "Sign in with GitHub" button. It never opens the browser on its own.                                                            |
| `connection_replaced` | A newer connection of the same device authenticated.                                                                   | Does not reconnect on its own. Warns that the device key is in use in another installation and offers two actions: remove this device and register again, or reconnect here once. |
| 1001 or 1006          | Server shutdown or a dropped connection.                                                                               | Reconnects with backoff.                                                                                                                                                          |

- HTTP:
  1. `POST /auth/challenge` returns a challenge ID and a nonce. The challenge is single use, valid for 60 seconds, and kept in API memory.
  2. `POST /auth/access-token` with the device ID, the challenge ID, and a signature (purpose `http`) returns an access token (prefix `mmda_`), valid for 15 minutes and kept in API memory as a hash. The signature is verified first. A failure then answers `auth_failed`, `device_revoked`, or `sign_in_required`, with the same meaning as on the WebSocket.
  3. Every other authenticated route takes `Authorization: Bearer <access token>`. The server looks the token up by its hash and checks, in the same request, that it has not expired, that the device is not revoked and needs no sign-in, and that the account is not disabled. Every failure is a `401` with the code `unauthorized`. The desktop answers a `401` by fetching one new token, which reports the reason.
- Secrets follow ADR 0004. Sign-in codes, access tokens, invitation codes, and the sign-in cookie are 32 random bytes, base64url. The codes have a fixed prefix (`mmdc_`, `mmda_`, `mmdi_`) and are 48 characters in total, so secret scanning and the desktop recognize them. Only SHA-256 hashes are kept: invitation codes in the database; sign-in codes, access tokens, and cookies in API memory. Challenge and connection nonces live only in API memory.
- Nothing secret is logged: no query string (already the rule), no `Authorization` header, no cookie, no authentication frame, no body of an authentication route, and no GitHub response body.

Authentication routes:

| Route                                  | Authenticated by                        | Purpose                                                             |
| -------------------------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| `GET /auth/github/authorize`           | nothing                                 | Starts a sign-in attempt, sets its cookie, and redirects to GitHub. |
| `GET /auth/github/callback`            | the attempt's state and cookie          | Reads the GitHub identity and shows the confirmation page.          |
| `POST /auth/github/confirm`            | the attempt's cookie                    | Creates the sign-in code and posts it to the loopback listener.     |
| `POST /auth/github/webhook`            | `X-Hub-Signature-256`                   | Receives `github_app_authorization`.                                |
| `POST /auth/sign-in`                   | sign-in code, PKCE verifier, device key | Registers the device or replaces its key.                           |
| `POST /auth/challenge`                 | nothing                                 | Issues a challenge for an access token.                             |
| `POST /auth/access-token`              | device key                              | Issues an access token.                                             |
| `POST /auth/sign-out`                  | access token                            | Signs out the current device.                                       |
| `GET /devices`                         | access token                            | Lists the person's own devices.                                     |
| `POST /devices/{deviceId}/revoke`      | access token                            | Revokes one of the person's own devices, as `removed` or `lost`.    |
| `POST /account/registration-lock/lift` | access token                            | Lifts the registration lock after a lost device.                    |

The contract issue fixes the paths of the membership routes.

### Configuration

- New variables, under the rules of ADR 0010: `API_PUBLIC_ORIGIN`, `API_GITHUB_CLIENT_ID`, `API_GITHUB_CLIENT_SECRET`, `API_GITHUB_WEBHOOK_SECRET`, an optional `API_GITHUB_WEBHOOK_SECRET_PREVIOUS` for a secret rotation, and `DATABASE_URL`.
- In development and test every variable stays optional. Without the public origin, the client ID, and the client secret, the sign-in routes answer the generic 404 and startup logs that GitHub sign-in is disabled. Without the webhook secret, the webhook route answers 404. Without `DATABASE_URL`, the routes that need the database are disabled the same way. With `NODE_ENV=production`, all of them except the previous webhook secret are required.
- `API_PUBLIC_ORIGIN` has the form `scheme://host[:port]`, like `API_ALLOWED_ORIGINS`. It must use `https`, except with `NODE_ENV` set to `development` or `test` and a loopback host.
- Production desktop builds fix the API base URL. Development builds may read it from configuration.

### Lifetimes

| Item                         | Lifetime                                 | Rule                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in attempt and cookie   | 10 minutes                               | Single use; API memory.                                                                                                                                                 |
| Sign-in code                 | 60 seconds                               | Single use; API memory; bound to the desktop's PKCE challenge and `redirect_uri`.                                                                                       |
| HTTP challenge               | 60 seconds                               | Single use; API memory.                                                                                                                                                 |
| Access token                 | 15 minutes                               | API memory; never extended; the desktop fetches a new one.                                                                                                              |
| WebSocket authentication     | 10 seconds                               | From the upgrade to `auth.response`.                                                                                                                                    |
| Device sign-in               | 30 days                                  | Checked when a connection authenticates and when an access token is minted. An open connection may continue for up to 24 hours more. A new sign-in keeps the device ID. |
| Registration lock            | 7 days                                   | Starts when a device is revoked as lost; lifted early from another active device.                                                                                       |
| Device too new for ownership | 72 hours                                 | A device this young cannot offer ownership or promote admins.                                                                                                           |
| Invitation                   | 7 days by default; from 1 hour to 7 days | Single use.                                                                                                                                                             |
| Join request                 | 7 days                                   | One pending request per person and workspace.                                                                                                                           |
| Ownership offer              | 7 days                                   | Accepted by the target or withdrawn by the owner.                                                                                                                       |

The 30-day rule covers what the API cannot observe. GitHub sends no signal when an account is deleted or suspended; the next sign-in then fails. Together with the key replacement, the rule also limits how long a copied device key works. `auth.ok` and the device list return the sign-in expiry, the desktop asks the person to renew from day 25, and the person can renew at any time.

### Revocation, sign-out, and recovery

- Signing out (P-65) sets `devices.signed_out_at`. The server closes the device's sockets with `sign_in_required`. The desktop drops its access tokens and does not use the key until the next GitHub sign-in with the same account. The device and its agents stay. While offline, the desktop marks itself signed out and reports it when it is online again.
- Removing a device revokes it with the reason `removed`. It is required before another GitHub account can sign in on the installation. The desktop deletes the key only after the server confirms; while offline it shows the removal as pending.
- The person revokes a lost or stolen device with the reason `lost`, from another of their devices or after signing in with GitHub on a new device. This starts the registration lock: for 7 days, every new device registration of the account is refused with `device_registration_locked` until the person lifts the lock from one of their active devices. A repeated sign-in of an existing device is not affected (P-55).
- When a device is revoked as lost, the desktop tells the person to end that device's GitHub sessions (github.com/settings/sessions), to change the GitHub password if the device was unlocked, and to rotate the AI provider credentials stored on it, because the cloud cannot reach them.
- A device revocation is one transaction. It sets `revoked_at` and `revocation_reason`, disables the agents hosted on the device, revokes their active grants with the account as `revoked_by_user_id`, and cancels their runs that have not finished (P-60). After the commit, the server closes the device's socket with `device_revoked`. Its access tokens stop working at once, because every request checks the device. A revoked device never comes back.
- Workspace owners and admins cannot revoke another person's device; they remove the person instead.
- The per-event checks of ADR 0006 stay as a backstop. With one API instance, the server keeps a registry of open connections by device. Every 60 seconds one batched query re-checks the devices in the registry for a revocation, a disabled account, a sign-out, `users.sign_in_required_at`, and a connection past the 24-hour grace of the 30-day sign-in. A shared notification, for example PostgreSQL `LISTEN` and `NOTIFY`, is added before the API runs more than one instance.
- GitHub authorization revoked (P-54): the webhook is verified with `X-Hub-Signature-256` against the current secret, or the previous one during a rotation, and matched by the numeric sender ID. The server sets `users.sign_in_required_at`, closes the person's sockets with `sign_in_required`, and stores the `X-GitHub-Delivery` ID with the audit record; a delivery ID that was already processed changes nothing, and a redelivery keeps the ID of the original delivery (checked in #67). The event also arrives for a person who authorized the app without installing it (checked in #67). The devices stay registered.
- GitHub does not redeliver a failed webhook delivery on its own, and its delivery API needs the app's private key, which the API does not hold. A delivery lost during downtime is accepted in v0; the 30-day sign-in bounds it. After downtime or a secret rotation, the operator checks the app's recent deliveries and redelivers by hand.
- An operator can disable an account (`users.disabled_at`), for example after abuse, and enable it again. Every authentication of a disabled account fails. Disabling also revokes, in the same transaction, the active grants of the agents that the account owns (ADR 0015, P-77 and P-78); enabling it again restores none. Both actions write an audit record.
- The person's other devices are notified when a new device registers.
- The desktop stops local execution when it receives `device_revoked`, when its account is removed from a workspace (for that workspace's agents), and when the server cancels a run that it hosts. A stolen or hostile device cannot be stopped from the cloud; revocation only cuts it off.

### Storage and transport on the device

These rules are part of the authentication contract. They are reviewed with the desktop owner when they start work (P-56, P-67).

- The device key, the sign-in flow, and the cloud connection live in the Electron main process. The renderer never sees the private key, an access token, or a sign-in code. It gets narrow IPC results: whether the person is signed in, the account, and the device list. The main process validates the sender of every IPC message.
- The main process takes the single-instance lock (`app.requestSingleInstanceLock()`) before it touches the key, so two instances never share one key.
- Calls to the API use Electron's `net.fetch`, which follows the system proxy settings, including PAC and WPAD. The WebSocket client must work through the system proxy too; M2-02 (#26) chooses it.
- The private key is exported as PKCS#8 and encrypted with `safeStorage.encryptStringAsync`. It is written with an atomic write (a temporary file, then a rename) under the application's data folder; on Windows under the local, non-roaming folder, so that a roaming profile does not copy it to another machine. It is decrypted once at startup with `decryptStringAsync`, before any connection is opened, so that no operating system prompt can run inside the 10-second handshake. It is rewritten when that call reports `shouldReEncrypt`. The synchronous `safeStorage` API is deprecated and removed in Electron 46, and keytar is archived; neither is used.
- Protection by platform:
  - Windows: DPAPI. Other operating system users cannot read the key; other programs of the same user can, and can copy it.
  - macOS: the Keychain. Builds must be code-signed, or the Keychain asks again after every update (#17).
  - Linux: kwallet or libsecret. Without a secret service, `safeStorage` falls back to a fixed key, which protects nothing. When the desktop cannot confirm a secret service, it encrypts the key with a passphrase that the person enters at start (scrypt and AES-256-GCM from `node:crypto`). The person may instead choose an unprotected key file (mode 0600) after a warning. There is no memory-only mode. Which API reports the fallback is confirmed before this rule is final.
- When the key is lost (a forgotten passphrase, a deleted file), the installation registers a new device and names the previous device ID, which the server revokes with the reason `replaced`. The previous device's agents are disabled.
- Malware that runs as the person can use the key, and on Windows and on an unprotected Linux file it can copy the key and keep using it after it is removed. The key replacement at each sign-in, the one-connection rule, the 30-day sign-in, and revocation limit the damage. Hardware-backed keys are a later option.

### People and roles

- `workspace_members` becomes the person table (P-57). A person belongs to one workspace and has a display name in that workspace (1 to 64 characters, the text rule of ADR 0005) and a role. A person is unclaimed until an account claims it, and then belongs to exactly that account. An account has at most one active person per workspace.
- An active member is a claimed person whose `removed_at` is empty. ADR 0006 reference binding and ADR 0008 `isGrantActive` use this definition of membership.
- Inside a workspace, the desktop always shows a user through their person row: the person's display name and the GitHub login, also for removed people, who are shown as former members. The login is shown in a monospace font with the date it was last verified, so that a display name cannot impersonate someone. `users.display_name` appears only on the account's own screens and is the default name when the account creates a workspace or asks to join one.
- Roles (P-58): `owner` (exactly one per workspace, always claimed), `admin`, and `member`. An unclaimed person is always a `member`. Roles are workspace administration rights. They are not capabilities and never imply one (ADR 0008). An owner or admin cannot grant a capability on another person's agent (P-44).

| Action                                                                                   | Owner | Admin                              | Member     |
| ---------------------------------------------------------------------------------------- | ----- | ---------------------------------- | ---------- |
| See the workspace and its people; edit own display name                                  | yes   | yes                                | yes        |
| Leave the workspace                                                                      | no    | yes                                | yes        |
| Define, rename, and remove unclaimed people                                              | yes   | yes                                | no         |
| Create and revoke invitations; list live invitations with their creators                 | yes   | yes                                | no         |
| Approve, deny, and block join requests; pause join requests                              | yes   | yes                                | no         |
| Remove a claimed person                                                                  | yes   | only people with the role `member` | no         |
| Promote a claimed member to admin, or offer ownership, from a device older than 72 hours | yes   | no                                 | no         |
| Demote an admin                                                                          | yes   | no                                 | no         |
| Accept an ownership offer                                                                | no    | the target                         | the target |

- Creating a workspace creates the creator's person as the claimed `owner`. `workspaces.created_by_user_id` stays a historical fact; ownership lives in the role.
- Demoting an admin revokes, in the same transaction, the live invitations that the admin created.
- Archiving a workspace is not part of this record.

### Invitations

- An owner or admin creates an invitation for one unclaimed person. The code is shown once and never again; a lost code is replaced by a new invitation. A person has at most one live invitation: creating a new one revokes the previous one in the same transaction.
- The code has the prefix `mmdi_`. Only its hash is stored.
- The inviter passes the code on through any channel, and the person pastes it into the desktop's join screen. In v0 the code never appears in a URL (P-59).
- The code travels only in request bodies. A preview route shows the workspace name, the person's display name, the inviter's display name and GitHub login, and the expiry, without consuming the code. An accept route claims the person. Both need a signed-in device and answer with `Cache-Control: no-store`.
- Accepting is one transaction at READ COMMITTED. A conditional `UPDATE` consumes the invitation only if the hash matches and the invitation is not accepted, not revoked, and not expired. Then the person is claimed only if it is still unclaimed and not removed. PostgreSQL re-checks the condition after a concurrent update, so only one of two racing requests succeeds. An account that is already an active member of the workspace gets `already_member`.
- Every other failure (an unknown, used, expired, or revoked code, or a removed person) returns the same `invitation_invalid`. The server logs the reason with the invitation ID, never with the code.
- The owner and admins are notified of every claim, with the claimer's GitHub login and the creation date of that GitHub account, and can remove the person in one step.
- Binding an invitation to a specific GitHub account is a later option.
- Rejoining after a removal creates a new person, so the earlier membership stays in history.

### Join requests

- A signed-in person who knows a workspace ID can ask to join as a new person, with a requested display name. There is no free-text note, because a note is a channel for spam and phishing.
- Before approval, the requester sees nothing about the workspace: no name, people, projects, or member count.
- The owner and admins see the requested name together with the requester's GitHub login and the creation date of that GitHub account. Approving creates a claimed person with the role `member` in the same transaction; the approver may change the display name. Denying records the decision. Blocking denies and keeps the account from asking again until an owner or admin lifts the block. The owner and admins can deny all pending requests at once and pause new requests for the workspace. The requester may withdraw a pending request. An account that is already an active member gets `already_member`.
- A joiner who is one of the predefined people claims that person with an invitation. The join screen says so. When unclaimed people exist, the approver view offers to deny a request and create an invitation for one of them instead; the code is shown once to pass on.

### Limits

Limits are tuned with use (P-64).

- Before authentication (sign-in routes, the challenge, the WebSocket upgrade), global caps always apply: at most 1,000 open sign-in attempts, 1,000 open challenges, and 200 unauthenticated WebSocket connections. Limits per remote address are valid only while the API is reached directly, or after the hosting decision has set `trustProxy` to the exact proxy (P-63). Behind a proxy without that setting, every client has the proxy's address.
- After a verified signature, `POST /auth/access-token` is limited per device. Authenticated routes are limited per user.
- GitHub allows 2,000 token requests per hour per app. The API counts its token exchanges per hour and logs a warning above 1,500. When GitHub answers with its limit, the API answers `sign_in_unavailable` with `Retry-After`.
- Devices: at most 20 active devices per account and 10 new devices per account per 24 hours.
- Workspaces: at most 10 new workspaces per user per 24 hours.
- Join requests: one pending request per person and workspace, and a second request while one is pending returns the pending request instead of creating another; at most 5 pending requests per person in total, and 10 new requests per person per 24 hours; at most 50 pending requests per workspace; a denied person can ask the same workspace again after 24 hours; a paused workspace or a blocked person gets `join_requests_closed`.
- Invitations: at most 50 live invitations and 100 new invitations per workspace per 24 hours; at most 10 failed invitation previews or accepts per person per 15 minutes.
- A limit answers `429` with the code `rate_limited` and `Retry-After`.

### Removal and ownership

- The owner or an admin removes a person, and a member may leave. Removal is one transaction:
  - it sets `removed_at` and `removed_by_user_id`;
  - it revokes the person's live invitation if the person is unclaimed, and the unaccepted invitations that the person created;
  - it disables the person's agents in the workspace's projects and revokes their active grants, with the remover as `revoked_by_user_id`;
  - it cancels the unfinished runs of those agents, and every unfinished run in the workspace that the person requested on another member's agent (P-60).
- The server then drops the removed account's subscriptions to the workspace on open connections and tells that account's devices with an account frame. The per-event membership check is the backstop.
- Nothing is deleted. Messages, runs, grants, and the person row stay and keep their attribution. The desktop shows a removed person as a former member.
- The owner cannot be removed and cannot leave. Ownership changes only by transfer: the owner offers it to another active, claimed person, an admin or a member, from a device older than 72 hours; the target accepts within 7 days; the owner can withdraw the offer until then. Acceptance is one transaction that demotes the owner to `admin` before it promotes the target, so the unique index never sees two owners. Every device of both people is notified.
- At most one owner is guaranteed by a partial unique index; exactly one by the transfer transaction.
- Revoking a device never removes a person from a workspace.
- Cancelling runs: the server moves each affected run in `queued`, `running`, or `awaiting_input` to `cancelled`, with a `system` actor, `deviceId: null`, and a fixed reason code (`member_removed` or `device_revoked`) in `reason`. The protocol already allows a `system` actor for this event type. The desktop shows a known code from a `system` actor as its own text. Without this, such runs would stay unfinished forever, because their host device can no longer send events.

### What a workspace ID allows

- Without sign-in: nothing. Only the authentication routes, the GitHub callback and webhook, and `/health` work without authentication.
- With a signed-in device: exactly one action, a join request. The answer reveals only whether a workspace with that ID exists and accepts requests: `workspace_not_found` for an unknown or archived ID, so that a typing error shows, and `join_requests_closed` when requests are paused or the person is blocked. The design does not rely on the ID being hard to guess: it was never a secret (ADR 0004, RFC 9562 section 8), and a join request only creates something that an approver must accept.
- Never: reading the name, the people, the projects, or the member count; claiming or acting as a person; subscribing to events; sending events.
- Every other route or event that names a workspace checks active membership first. A non-member gets the same `404` as for a workspace that does not exist, as ADR 0007 does for run IDs.
- A workspace ID is routing data. It may appear in REST paths and in envelopes.

### HTTP errors

- Every error answer has the body `{ statusCode, error, message, code }` (P-66). `code` comes from the closed protocol vocabulary `API_ERROR_CODES`, for example `bad_request`, `unauthorized`, `auth_failed`, `device_revoked`, `sign_in_required`, `device_account_mismatch`, `device_registration_locked`, `unsupported_account`, `invitation_invalid`, `already_member`, `workspace_not_found`, `join_requests_closed`, `rate_limited`, `sign_in_unavailable`, `not_found`, and `internal_error`. `message` stays the status text and never contains an input value.
- Routes throw a typed `ApiError` with a status and a code. The error handler sends its code; every other error keeps today's generic body, with a generic code. The rate-limit plugin builds the same body.

### Data model

Proposed changes. The conventions of ADR 0013 apply: UUIDv7 keys supplied by the application, `timestamptz`, `ON DELETE RESTRICT`, `text` vocabularies with CHECK constraints that equal a constant, lifecycle columns set in pairs, and composite foreign keys. In addition:

- Public keys and SHA-256 hashes are stored as lowercase hexadecimal `text` with the CHECK `^[0-9a-f]{64}$`.
- Vocabularies that only the server uses (`AUDIT_ACTIONS`, `AUDIT_REASONS`) are constants in `packages/database`, with the same test that the CHECK equals the constant.
- No table holds sign-in attempts, sign-in codes, or access tokens.

Tables:

- `users` (additive):
  - Columns: `disabled_at` (an operator disabled the account); `sign_in_required_at` (every device whose last sign-in is earlier must sign in again); `device_registration_locked_until`.
  - Constraints: none new.
- `user_identities` (new):
  - Columns: `id`; `user_id` -> users; `identity_provider` (`github`); `subject` (the provider's immutable account ID; for GitHub the numeric ID as decimal text); `login` (display only); `account_created_at`; `created_at`; `updated_at`; `last_sign_in_at`; `erased_at`. The column is named `identity_provider` because `provider` already means an AI provider.
  - Constraints: Unique (`identity_provider`, `subject`) where `subject` is set; unique (`user_id`, `identity_provider`); `subject`, `login`, and `account_created_at` are empty exactly when `erased_at` is set; for `github`, `subject` matches `^[1-9][0-9]{0,18}$` and `login` matches `^[A-Za-z0-9_-]{1,39}$`.
- `devices` (additive):
  - Columns: `public_key`; `key_algorithm` (`ed25519`); `last_sign_in_at`; `signed_out_at`; `revocation_reason` (`removed`, `lost`, `replaced`, `account_erased`); `updated_at`. `public_key`, `key_algorithm`, and `last_sign_in_at` are required.
  - Constraints: Unique `public_key`, 64 hexadecimal characters for `ed25519`; `revoked_at` and `revocation_reason` set together.
- `workspaces` (additive):
  - Columns: `join_requests_paused_at`.
  - Constraints: none new.
- `workspace_members` (restructured):
  - Columns: `id` (`MemberId`, the new primary key); `workspace_id`; `user_id` (empty until claimed); `display_name`; `role` (`owner`, `admin`, `member`); `added_by_user_id`; `created_at`; `updated_at`; `claimed_at`; `ownership_offered_at`; `removed_at`; `removed_by_user_id`.
  - Constraints: `user_id` and `claimed_at` set together; the role is `member` while `user_id` is empty; `removed_at` and `removed_by_user_id` set together; `display_name` 1 to 64; an ownership offer only on a claimed, active person who is not the owner, and at most one per workspace; unique (`workspace_id`, `user_id`) where claimed and not removed; unique (`workspace_id`) where the role is `owner` and the person is not removed; unique (`id`, `workspace_id`) as a composite key target; index on `user_id`.
- `workspace_invitations` (new):
  - Columns: `id` (`InvitationId`); `workspace_id`; `member_id`; `token_hash`; `created_by_user_id`; `created_at`; `expires_at`; `accepted_at`, `accepted_by_user_id`, and `accepted_device_id`; `revoked_at` and `revoked_by_user_id`.
  - Constraints: (`member_id`, `workspace_id`) -> workspace_members (`id`, `workspace_id`); unique `token_hash`; `expires_at` at least 1 hour and at most 7 days after `created_at`; the accepted columns set together, with (`accepted_device_id`, `accepted_by_user_id`) -> devices (`id`, `user_id`); the revoked pair set together; never both accepted and revoked; at most one live invitation per person (unique `member_id` where neither accepted nor revoked).
- `workspace_join_requests` (new):
  - Columns: `id` (`JoinRequestId`); `workspace_id`; `requester_user_id`; `requester_device_id`; `requested_display_name`; `created_at`; `expires_at`; `decision` (`approved`, `denied`, `blocked`, `withdrawn`, `expired`); `decided_at`; `decided_by_user_id`; `member_id`; `unblocked_at` and `unblocked_by_user_id`.
  - Constraints: (`requester_device_id`, `requester_user_id`) -> devices (`id`, `user_id`); `decision` and `decided_at` set together; `decided_by_user_id` set for every decision except `expired`; `member_id` set exactly when approved, with (`member_id`, `workspace_id`) -> workspace_members (`id`, `workspace_id`); the unblocked pair set together and only on a `blocked` request; `requested_display_name` 1 to 64; one pending request per (`workspace_id`, `requester_user_id`). An expired pending request is marked `expired` before a new one is stored.
- `audit_events` (new):
  - Columns: `id`; `created_at`; `action`; `actor_user_id` -> users; `actor_device_id`; `workspace_id` -> workspaces; `subject_id` (the ID of the affected row, an unchecked label); `reason`; `github_delivery_id`. No secret and no human-entered text (P-61).
  - Constraints: `action` in `AUDIT_ACTIONS`; `reason` empty or in `AUDIT_REASONS`; (`actor_device_id`, `actor_user_id`) -> devices (`id`, `user_id`); unique `github_delivery_id` where set. The actions cover sign-in, device registration, key replacement, sign-out, revocation, and the registration lock; replaced connections; revoked GitHub authorization; disabled, enabled, and erased accounts; workspace creation; people defined, renamed, claimed, removed, or leaving; role changes and ownership offers and transfers; invitations; join requests, blocks, and pauses; and identity mismatches.

Migration, retention, and erasure:

- The migration that adds these columns is written by hand where drizzle-kit cannot generate it. It starts with a guard that stops with a clear message when `users`, `devices`, or `workspace_members` holds a row, because the new required columns and the new primary key have no honest default. The package README documents how to reset a local database. No production database exists.
- Used and expired invitations, join requests, and audit records stay in the database, because the application role has no `DELETE` (P-62).
- Erasing a person's data on request (P-62): an operator procedure sets `user_identities.erased_at` and clears `subject`, `login`, and `account_created_at`; replaces `users.display_name`, the person's `workspace_members.display_name` values, and their requested display names with a fixed placeholder ("Former user"); sets `users.disabled_at`; revokes every device with the reason `account_erased`; and removes the account's active memberships. No synthetic subject is ever written, so an erased account can never match a sign-in. An owner's account is erased only after ownership was transferred.

### Protocol

Changes to `@mymandev/protocol`, a shared boundary, reviewed with the desktop owner when they start work (P-67). The package stays free of Node.js APIs.

- ID brands `MemberId`, `InvitationId`, and `JoinRequestId`, added to `AnyId`. Sign-in attempts, codes, and tokens stay inside the server and get no brand.
- Vocabularies `MEMBER_ROLES`, `DEVICE_KEY_ALGORITHMS`, `DEVICE_REVOCATION_REASONS`, `JOIN_REQUEST_DECISIONS`, `IDENTITY_PROVIDERS`, `RUN_CANCEL_REASONS`, and `API_ERROR_CODES`. A test proves that each database CHECK equals its constant.
- A `WorkspaceMember` entity: `id`, `workspaceId`, `displayName`, `role`, `userId` (null until claimed), `identity` (`{ provider, login, verifiedAt }`, null until claimed), and `removedAt`. The identity is provider-neutral, so a later sign-in method changes no field.
- A device list item: `id`, `label`, `platform`, `createdAt`, `lastSeenAt`, `lastSignInAt`, `signInExpiresAt`, `revokedAt`, and whether it is the current device.
- Request and response schemas for the routes of this record, the error body, the builder of the signed input, the pairing code, and format checks for the prefixed codes.
- Frames that are not events, in a frame layer above the envelope that M2-01 (#25) adds:
  - `auth.challenge`, `auth.response`, and `auth.ok`;
  - account frames, sent only to the account's own connections: a device registered, a device revoked, removed from a workspace, and an ownership offer. A device belongs to an account, not to a workspace, so account frames never use the event envelope and never reach other members.
- Server-originated workspace events, defined by M2-01, for the membership changes that other members must see: a person defined, claimed, renamed, or removed; a role changed; ownership transferred. They carry a `system` actor and `deviceId: null`.
- The server cancels runs with `agent.run.state_changed`, a `system` actor, `deviceId: null`, and a code from `RUN_CANCEL_REASONS` in `reason`.
- The `user` actor of ADR 0006 now has an authenticated source: the connection's user.

### Threats

- Phishing through the sign-in flow (ConsentFix): an attacker starts a sign-in with their own PKCE pair and sends the link to a victim. The prize is a device on the victim's MyManDev account, not only a public profile. Defenses: the API's confirmation page, which names the GitHub login and a pairing code that the victim's own application does not show; the sign-in code, which reaches the loopback listener only in a POST body and never appears in the address bar; and the attempt cookie, which ties GitHub's callback to the browser that started the attempt. No device flow and no polling exist. The confirmation page relies on the person's attention, so a person who ignores its warning and helps an attacker extract a code from the browser can still be phished.
- Signing a victim into the attacker's account: the desktop accepts only its own state, and a sign-in code works only with the PKCE verifier that created its challenge.
- Another application using the public client ID: GitHub sends codes only to the API's exact callback, and only the API holds the client secret.
- Lost or stolen device: the person revokes it as lost from another device, or after a GitHub sign-in on a new one. Its socket closes and its access tokens stop working at once. Its agents are disabled and their runs cancelled. A stolen, unlocked laptop often holds the person's GitHub web session too, so revocation alone is not enough: the registration lock keeps that laptop from registering a new device for 7 days, and the desktop tells the person to end the GitHub sessions, change the GitHub password, and rotate the AI provider credentials on the device.
- Copied device key (malware running as the person): on Windows and with an unprotected Linux file, the key can be copied and used after the malware is gone. A WebSocket copy shows up as `connection_replaced` and is audited. The key replacement at the next GitHub sign-in, at most 30 days later, ends any copy, and the person can revoke the device at any time. Hardware-backed keys are the later answer.
- Leaked invitation code: it claims one predefined person with the role `member`, once, within at most 7 days. It never grants admin rights, because an unclaimed person is always a member and only the owner promotes a claimed person. The owner and admins see who claimed it, with the GitHub login and the account's creation date, and can remove that person in one step. The code never appears in a URL or a log, and its prefix lets secret scanning find it. A new invitation for the same person revokes the old one.
- Replay: a WebSocket signature covers a fresh nonce and the connection ID, and an HTTP signature covers a single-use challenge. Both name the purpose and the audience, so a signature relayed to another server or used for another purpose fails. Sign-in codes and invitations are single use. Events are de-duplicated per authenticated device (ADR 0004).
- An identity that a client claims: the server takes the user and the device only from the verified key. `bindIdentity` rejects and audits an event whose device or user differs. A GitHub token from a client is never accepted.
- Enumeration: workspace, device, and member IDs are not secrets, and no check relies on them being hard to guess. Codes and tokens have 256 random bits. Invitation failures share one code, and device authentication failures share one close code. A non-member gets the same `404` as for an unknown workspace. Failures are rate-limited.
- A reused GitHub login: accounts are keyed on the numeric ID, and nothing is resolved by login. A login shown to members may be up to 30 days old; it is shown with the date it was last verified.
- A removed insider: removal takes effect at the next event through the per-event membership check. It drops subscriptions, disables the person's agents, revokes their grants and the invitations they created, and cancels their runs and the runs they requested on other agents. History stays attributed.
- An abusive admin: an admin cannot remove the owner or another admin, cannot promote anyone, cannot revoke another person's device, and cannot grant capabilities on another person's agent. Demotion revokes the invitations the admin created. Every administrative action writes an audit record.
- Join request spam and impersonation: limits per person and per workspace, a waiting time after a denial, blocking, pausing, and denying all at once, no free-text note, and the GitHub login and account age always next to the requested name. The requester learns nothing before approval.
- Exhausting the server: no unauthenticated request creates a database row. Sign-in attempts, challenges, and unauthenticated sockets have global caps, and devices and workspaces have limits per account. A single GitHub account can still use up GitHub's 2,000 token requests per hour; the API then answers `sign_in_unavailable` until the hour passes.
- A leak from the server: the database holds public keys and hashes of invitation codes only. GitHub tokens are never stored, and the readable GitHub PKCE verifier lives only in memory for at most 10 minutes. Logs hold no query string, `Authorization` header, cookie, authentication frame, authentication body, or GitHub response body. The proxy in front of the API must follow the same rule (P-63).
- A leaked GitHub client secret: codes reach only the API's callback, so the secret alone signs in nobody. It is replaced in the GitHub App settings. Production, staging, and development use separate apps.
- A taken-over GitHub account: GitHub is the root of identity, so the attacker can register devices, and the person's other devices are notified. A device younger than 72 hours cannot offer ownership or promote admins, and an ownership transfer needs the target's acceptance. The attacker can still revoke the person's devices and act as the person until the GitHub account is recovered. The documentation recommends two-factor authentication on GitHub.
- A deleted, suspended, or de-authorized GitHub account: de-authorization arrives as a webhook and forces a new sign-in, unless the delivery is lost. GitHub sends nothing for deletion or suspension. The 30-day sign-in covers both cases.

## Consequences

- This record changes parts of accepted records. When it is accepted, each of them gets an "Amended by ADR 0014" line under its status (P-68):
  - ADR 0004 (P-10) and the protocol README: a device credential is a registered public key, not a stored secret; the 32-byte rule names sign-in codes, access tokens, invitation codes, and the sign-in cookie; the API's GitHub PKCE verifier is kept readable in memory only; the brands `MemberId`, `InvitationId`, and `JoinRequestId`.
  - ADR 0005: a user has a GitHub identity; people belong to a workspace and have a display name there; a person also joins through an approved join request, without a token; roles are administration rights, beyond visibility.
  - ADR 0006: the definition of an active member; `AuthenticatedConnectionContext`; the frame layer above the envelope and the account frames, which never use the envelope.
  - ADR 0007: the server may cancel runs (P-60).
  - ADR 0008 and ADR 0015 (P-74): the membership fact of `isGrantActive` is the person row of the granting user, by the definition of an active member above.
  - ADR 0009: what counts as a credential under P-48 (P-50); the context type and the non-event frames; the error body with a code (P-66); HTML pages under `/auth/github/*`.
  - ADR 0010: the new variables, the first secrets, and `DATABASE_URL`.
  - ADR 0013: the `workspace_members` change, the new tables, hexadecimal `text` for 32-byte values, and server-only vocabularies in `packages/database`.
- The `workspace_members` change is not additive. It replaces the primary key of an M1-03 table, which is a destructive migration and a shared boundary under OWNERSHIP.md. No production database exists, so no data is lost, but local databases must be reset.
- The gateway changes on purpose. The first frame is no longer an event, and the M1-02 test that expects `identity: null` on an event is replaced.
- Sign-in can be built and tested against an API on a loopback address with a development GitHub App. The webhook, two physical devices (M2-05), and production need a public HTTPS address; widening `API_HOST`, TLS, `trustProxy`, and the production secrets are decided separately (P-63).
- The first REST routes with a body arrive with this work, so the sign-in issue settles the REST validator (P-06) and records the choice in ADR 0003.
- With one API instance, sign-in attempts, sign-in codes, challenges, access tokens, rate-limit counters, and the connection registry live in memory. A restart costs a repeated sign-in or a new token, nothing more. Running more than one instance needs a shared store first.
- The desktop needs the shell of M0-03 (#3) and the main process and IPC of M1-04 (#22) before sign-in can be built. The device key needs secure storage in M2, earlier than the AI provider credential storage of M3 (#33).
- M2-01 (#25) and M2-02 (#26) list authentication as out of scope today. Their scope changes: #25 adds the frame layer, the `auth.*` frames, and the account frames; #26 adds WebSocket authentication on the desktop, in the main process. The roadmap gains M2 items for accounts and devices and for workspace membership.
- M2-05 (#29) uses two GitHub accounts: the second person claims a predefined person with an invitation, or is approved after a join request. A second device of the same account needs only a sign-in.
- GitHub becomes the root of recovery. A person whose GitHub account is taken over can lose control of their devices and workspaces until GitHub recovers it. A workspace whose owner loses their GitHub account, and that has no admin, cannot recover on its own. The desktop encourages at least one admin besides the owner; an operator procedure is a later item.
- Every sign-in now shows the API's confirmation page, so a returning person clicks once more than GitHub alone would ask.
- Behavior verified on GitHub on 2026-10-29 (#67), on which P-49, P-50, and P-54 rest:
  - GitHub sends `github_app_authorization` with action `revoked` for a person who authorized the app but never installed it, and a redelivery keeps its `X-GitHub-Delivery` ID;
  - deleting the API's own GitHub token does not trigger that webhook and does not revoke the authorization, so the API deletes the token right after reading the identity;
  - a GitHub App accepts an `http://127.0.0.1` callback for development;
  - GitHub accepts the code exchange parameters in a form-encoded body, enforces the PKCE verifier (`invalid_grant`), consumes the code on a failed exchange, and can return an exchange error with HTTP status 200;
  - the consent screen of an app without permissions names the owning account and asks only to verify the identity; a returning person passes GitHub without a prompt, and `prompt=select_account` shows an account chooser.
- Details this record leaves open. The first change that needs each one decides it and records it in the README of the protocol or the API package:
  - the wire encoding of public keys, nonces, and signatures, and the exact input that is signed;
  - the HTTP status of each error code, and the codes for a denied role and for a conflict;
  - a cancel route for the confirmation page and its effect on the listener, and the response headers of the API's HTML pages;
  - whether a new sign-in clears `signed_out_at`, and how an ownership offer that nobody answered within 7 days is cleared;
  - which notices carry the creation date of a GitHub account, and how a requester learns the decision on a join request;
  - the actor recorded when an operator disables or erases an account;
  - how a pause of join requests ends, and whether expired requests that are not yet marked count as pending;
  - the close reasons before authentication and above the connection cap, and when `devices.last_seen_at` is updated;
  - the answer to a revocation webhook whose sender has no account, and the values of `AUDIT_REASONS`.
- Behavior still to verify:
  - the form POST from the API's HTTPS page to `http://127.0.0.1` in current Chrome (including its Local Network Access prompt), Edge, Firefox, and Safari, and a `__Host-` cookie on a loopback HTTP origin in development;
  - which Electron API reports the Linux `safeStorage` fallback under the asynchronous API.

## Dependency policy

- No new dependency for cryptography or GitHub. The API uses `node:crypto` (Ed25519, SHA-256, HMAC, `randomBytes`, `timingSafeEqual`) and the global `fetch`. The desktop main process uses `node:crypto` (Ed25519, scrypt, AES-256-GCM) and Electron's `net.fetch`. No OAuth client library, no JWT library, and no keytar.
- @fastify/rate-limit 10, exact pin, as a `dependency` of `@mymandev/api`, with its in-memory store while the API runs as one instance (P-64).
- `@mymandev/database` becomes a `dependency` of `@mymandev/api`, and `@electric-sql/pglite` an exact-pinned `devDependency` at the same version as in `@mymandev/database` ([ADR 0012](0012-pglite-database-tests.md)).
- Any Fastify type provider chosen under P-06 is recorded in ADR 0003 with its own pin rule.
- `safeStorage`, `shell`, and `net` come with Electron. The Electron version policy belongs to M0-03.

## Evidence

This record comes before the code. The implementation issues link their pull requests here.

- Decisions: issues #14 and #15, comments of 2026-10-28.
- Code that this record changes or constrains: [`packages/database/src/schema/identity.ts`](../../../packages/database/src/schema/identity.ts), [`packages/database/src/schema/workspaces.ts`](../../../packages/database/src/schema/workspaces.ts), [`packages/database/src/schema/agents.ts`](../../../packages/database/src/schema/agents.ts), [`apps/api/src/gateway.ts`](../../../apps/api/src/gateway.ts) (`ConnectionContext`), [`apps/api/src/app.ts`](../../../apps/api/src/app.ts) (error handler, routes), [`apps/api/src/config.ts`](../../../apps/api/src/config.ts), [`apps/api/src/log.ts`](../../../apps/api/src/log.ts), [`apps/api/.env.example`](../../../apps/api/.env.example), [`packages/protocol/src/ids.ts`](../../../packages/protocol/src/ids.ts), [`packages/protocol/src/model.ts`](../../../packages/protocol/src/model.ts), [`packages/protocol/src/entities.ts`](../../../packages/protocol/src/entities.ts), [`packages/protocol/src/envelope.ts`](../../../packages/protocol/src/envelope.ts), [`packages/protocol/src/decode.ts`](../../../packages/protocol/src/decode.ts), and [`packages/protocol/README.md`](../../../packages/protocol/README.md).
- GitHub documentation:
  - [Differences between GitHub Apps and OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)
  - [Making a GitHub App public or private](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)
  - [Authorizing GitHub Apps](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps)
  - [Authenticating with a GitHub App on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)
  - [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) (`login`, `prompt=select_account`, PKCE, the code exchange)
  - [Best practices for creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
  - [Best practices for creating an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app)
  - [Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
  - [About the user authorization callback URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)
  - [PKCE support (changelog, 2025-07-14)](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/)
  - [Consent screen note for sign-in-only apps (changelog, 2026-01-12)](https://github.blog/changelog/2026-01-12-selectively-showing-act-on-your-behalf-warning-for-github-apps-is-in-public-preview/)
  - [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
  - [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) and [REST API endpoints for GitHub App webhooks](https://docs.github.com/en/rest/apps/webhooks)
  - [OAuth authorizations API](https://docs.github.com/en/rest/apps/oauth-applications)
  - [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
  - [Users API](https://docs.github.com/en/rest/users/users), [username changes](https://docs.github.com/en/account-and-profile/concepts/username-changes), and [usernames of managed user accounts](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/iam-configuration-reference/username-considerations-for-external-authentication)
  - [Organization invitations](https://docs.github.com/en/organizations/managing-membership-in-your-organization/inviting-users-to-join-your-organization)
- Standards: [RFC 6749](https://www.rfc-editor.org/rfc/rfc6749.html) (section 4.1.3, the token request body), [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html) (native apps), [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) (OAuth security; section 2.1.1 binds PKCE to the user agent), [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html) (device flow), [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html) (server nonces), [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html) (close codes), and [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html#section-8) (UUIDs are not capabilities).
- Platform: [Electron `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage), [Electron `app`](https://www.electronjs.org/docs/latest/api/app) (data folders, single-instance lock), [Electron `net`](https://www.electronjs.org/docs/latest/api/net) (system proxy), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [Electron deep links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app), [Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes), [Node.js `crypto`](https://nodejs.org/api/crypto.html), [Node.js `net`](https://nodejs.org/api/net.html), [Node.js enterprise network configuration](https://nodejs.org/en/learn/http/enterprise-network-configuration) (proxy and system certificates for `fetch`), [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access), and [Windows command-line process auditing](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/component-updates/command-line-process-auditing).
- Libraries: [@fastify/rate-limit](https://github.com/fastify/fastify-rate-limit) (Fastify 5 compatibility, `keyGenerator`, `errorResponseBuilder`, in-memory store).
- Guidance: [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html), [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html) (rules for emailed or linked tokens), [ConsentFix](https://pushsecurity.com/resources/browser-identity-attacks-matrix/consentfix) (authorization code phishing through a loopback redirect), [PostgreSQL 18 transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html), and [Matrix MSC2403](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/2403-knock.md) (join requests).
- Review record: [ADR 0014 review record](../research/adr-0014-review.md).

## Needs Project Manager decision

- A public GitHub App with no permissions, no email, no authorization during installation, expiring user tokens, the device flow off, one exact callback (HTTPS in production and staging), and the authorization webhook on; one production app, one staging app, and one development app per contributor (P-49, recommended: accept; an OAuth app would later need coarse scopes such as `repo` for repository access, and no revocation webhook for OAuth apps was found).
- The sign-in flow brokered by the API with PKCE on both legs: the attempt is bound to the browser by a cookie, the API shows a confirmation page with the GitHub login and a pairing code, and the sign-in code reaches the loopback listener only in a form POST. Under P-48, GitHub's code on the API callback is not a credential and is the only value of the flow in a URL. The attempt and the API's GitHub PKCE verifier live only in API memory, the verifier readable, as an exception to the hashing rule of ADR 0004 (P-50, recommended: accept; the alternative, a redirect with the sign-in code in the query string, works with fewer browser checks but lets a phishing page ask the victim to paste the code from the address bar).
- The device credential is a key pair that each GitHub sign-in replaces. A WebSocket connection authenticates by signing a server nonce, and HTTP uses 15-minute access tokens minted by a signed challenge. This changes the wording of ADR 0004 (P-10) and of the protocol README (P-51, recommended: accept; the alternative is a 32-byte bearer secret with rotation, which fits ADR 0004 unchanged but logs people out when a rotation response is lost).
- The key algorithm: Ed25519 only in v0, with an algorithm column, or ES256 from the start so that hardware-backed keys need no new algorithm later (P-52, recommended: Ed25519).
- The lifetimes in the table: sign-in attempt 10 minutes, sign-in code 60 seconds, challenge 60 seconds, access token 15 minutes, WebSocket authentication 10 seconds, device sign-in 30 days with up to 24 hours more for an open connection, registration lock 7 days, a device too new for ownership actions 72 hours, invitation from 1 hour to 7 days with 7 days by default, join request 7 days, ownership offer 7 days (P-53, recommended: accept).
- When a person revokes the app's authorization on GitHub, every device of that person must sign in again and stays registered. GitHub sends the event also for a person who authorized the app without installing it (checked in #67). A lost delivery is accepted in v0 and redelivered by hand (P-54, recommended: sign in again; the alternatives are to revoke every device, or only to record the event).
- A new device needs no approval from an existing device of the same person, and the other devices are notified. For 7 days after a device is revoked as lost, new devices are refused until the person lifts the lock from another active device. An account has at most 20 active devices and 10 new devices per 24 hours (P-55, recommended: accept; approval for every new device would make recovery impossible when the only device is lost).
- The desktop contract: the device key, the sign-in flow, and the cloud connection live in the Electron main process; one instance per installation; API calls through `net.fetch`; the key stored with the asynchronous `safeStorage` API in the local, non-roaming data folder and decrypted once at startup; on Linux without a confirmed secret service, a passphrase-encrypted key or, by explicit choice, an unprotected file; the close-reason behavior in the table; no browser opened without the person's action. It is reviewed with the desktop owner when they start work (P-67), and the Linux rule is final only after the check that names the fallback API (P-56, recommended: accept).
- `workspace_members` becomes the person table, with `MemberId`, a `user_id` that is empty until claimed, a display name per workspace, and a role. Inside a workspace, users are shown through their person row with the GitHub login. This replaces the primary key of an M1-03 table, a destructive migration under OWNERSHIP.md; the migration refuses to run on a database with rows (P-57, recommended: accept and keep the name `workspace_members`).
- "Another approved person" in #14 means an `admin`: the roles are `owner`, `admin`, and `member`; only the owner and admins approve, invite, and remove; an unclaimed person is always a member; only the owner promotes, and only a claimed person; demotion revokes the admin's invitations; an ownership transfer needs the target's acceptance and a device older than 72 hours; archiving is left for a later decision (P-58, recommended: accept; the alternative lets every active member approve).
- Invitations are delivered only as a code pasted into the application in v0. An HTTPS link with the code in the fragment comes later with the website (#16), as a documented exception to P-48. A custom-scheme link never carries the code. No binding to a GitHub account in v0 (P-59, recommended: accept).
- When a device is revoked or a person is removed, the server cancels the unfinished runs of the disabled agents, and of the runs that the removed person requested on other agents, with a `system` actor and a fixed reason code in `reason`. This changes ADR 0007, which lets only the host device make later transitions (P-60, recommended: yes; otherwise those runs never finish).
- A minimal `audit_events` table in M2 with closed action and reason vocabularies, which the M3 audit trail (#37) extends (P-61, recommended: yes; ADR 0006 already requires audit records from M2).
- Rows of used or expired invitations and join requests, and audit records, stay in v0, because the application role has no `DELETE`; sign-in attempts and tokens are never stored. A request to erase personal data is handled by `erased_at`, cleared identity columns, placeholder names, revoked devices, and ended memberships, never by a synthetic subject. A purge job with its own role is decided when the volume needs it (P-62, recommended: accept for v0).
- Hosting the API on a public HTTPS address is a separate decision in M2: TLS termination, `trustProxy` set to the exact proxy, a proxy that never logs query strings, cookies, or the `Authorization` header, widening `API_HOST`, the production and staging secrets, and how deliveries are checked after downtime. It blocks the webhook, M2-05, and limits by address in production, but not building sign-in (P-63, recommended: a separate decision issue in M2).
- The limits in this record, with global caps before authentication, and @fastify/rate-limit 10 with its in-memory store while the API runs as one instance (P-64, recommended: accept).
- Signing out keeps the device and its agents and requires a GitHub sign-in before the key works again; removing a device revokes it and is required before another GitHub account signs in on the installation (P-65, recommended: accept; the alternative, signing out by revocation, disables every agent hosted on the installation for good).
- Every HTTP error has a `code` from `API_ERROR_CODES`, sent by the error handler from a typed `ApiError` and by the rate-limit plugin. This changes the error body of ADR 0009, whose message rule stays (P-66, recommended: accept).
- The desktop owner's review: under the Project Manager decision of 2026-10-28, the desktop owner's agreement is not required while the desktop owner has not started work. The Project Manager accepts the whole record, and the desktop-facing rules (the loopback listener, the storage and transport contract, one account per installation, sign-out and removal, the close-reason behavior, and the protocol changes) are reviewed with the desktop owner when they start, as for ADR 0015 (#76); a change goes through a later record (P-67, recommended: accept).
- The ADR README gains one rule: an accepted record that a later record changes in part gets an "Amended by ADR NNNN" line under its status. It is used for ADRs 0004 to 0010 and 0013 (P-68, recommended: accept).
