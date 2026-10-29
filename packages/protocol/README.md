# @mymandev/protocol

Protocol v0: the shared contract between the desktop application and the cloud API. It defines the identities, the entities, the event envelope, the agent run lifecycle, the capability vocabulary, and the account, device, and authentication contract, with zod schemas that validate untrusted input at runtime.

The protocol is a shared boundary. It changes only by agreement between the Project Manager and the desktop owner; see [OWNERSHIP.md](../../docs/process/OWNERSHIP.md). The decisions behind it are recorded in [ADR 0003 to ADR 0008 and ADR 0014](../../docs/architecture/decisions/README.md).

## Contents

| Module               | Contents                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/model.ts`       | `PROTOCOL_VERSION`, the capability, run state, device platform, member role, device key algorithm, device revocation reason, join request decision, identity provider, and run cancel reason vocabularies, the run transition table with `canTransition`, `API_ERROR_STATUS` and `API_ERROR_CODES` with `genericApiErrorCode`, the text, ID, and GitHub login patterns, `INVITATION_LIFETIME_SECONDS`, and `LIMITS`. |
| `src/ids.ts`         | Branded ID schemas and types (`UserId`, `DeviceId`, `WorkspaceId`, `ProjectId`, `RepositoryId`, `AgentId`, `RunId`, `EventId`, `CorrelationId`, `PermissionGrantId`, `ProviderConnectionId`, `MemberId`, `InvitationId`, `JoinRequestId`), `newId`, `newUuidV7`.                                                                                                                                                     |
| `src/entities.ts`    | `displayText`, the vocabulary schemas, and the User, Device, Workspace, Project, Repository, Agent, and AgentRun schemas.                                                                                                                                                                                                                                                                                            |
| `src/envelope.ts`    | The event envelope, the `agent.run.state_changed` event, `ProtocolEventSchema`, `EVENT_TYPES`, and `actorAllowed`.                                                                                                                                                                                                                                                                                                   |
| `src/decode.ts`      | `decodeEvent`, `decodeClientEvent`, `UnverifiedEvent`, and `enableJitlessValidation`.                                                                                                                                                                                                                                                                                                                                |
| `src/device-auth.ts` | The wire formats of public keys, signatures, nonces, sign-in codes, access tokens, and invitation codes, `isDevicePublicKey` with `ED25519_WEAK_PUBLIC_KEYS`, `isDeviceAuthAudience`, `deviceAuthInput` (the signed input), and `pairingCode`. No zod import.                                                                                                                                                        |
| `src/account.ts`     | The schemas of the account vocabularies and formats, `WorkspaceMember`, the device list item, and the HTTP error body.                                                                                                                                                                                                                                                                                               |
| `src/auth-api.ts`    | `AUTH_ROUTES`, `routePath`, and the request and response schemas of the authentication and device routes, the authorize query, and the loopback callback body.                                                                                                                                                                                                                                                       |

## Consumer rules

- Import only from `@mymandev/protocol`. Never import a file path inside this package.
- A device decodes events that the server sends with `decodeEvent`.
- The server decodes events that a device sends with `decodeClientEvent`. It rejects what only the server may originate (a `system` actor, `deviceId: null`, and a run creation) with `not_allowed_from_device`. Treat the result as `UnverifiedEvent` until the server's identity binding (M2) has bound its actor, device, and referenced IDs to the authenticated connection. Never cast it to `ProtocolEvent` or to a verified type.
- Decoding results are `{ ok: true, event }` or `{ ok: false, code }`. Unknown fields are stripped at every level, and the input is never mutated. The server rejects an event it cannot decode and reports the error to the sender; a device drops and logs it. Nobody processes part of an event, and the server never relays an event it could not validate.
- Under a strict Content Security Policy, the desktop renderer sets `z.config({ jitless: true })` before this package is evaluated: in a module that imports zod at the same exact version ([ADR 0003](../../docs/architecture/decisions/0003-zod-runtime-validation.md)) and that the renderer entry imports before anything that imports `@mymandev/protocol`. zod reads the setting when a schema is created, and this package creates its schemas when it is evaluated, so `enableJitlessValidation()` called after the import does not affect them. Without the setting, validation still works when code generation is blocked, because zod falls back, but zod's code generation probe is reported as a CSP violation.
- Human-entered text (`displayName`, `label`, `name`, run `reason`) is always rendered as text, never as markup.
- `newId` and `newUuidV7` generate identifiers, never secrets. An ID is not a capability, and a UUIDv7 reveals its creation time.
- The server generates every entity ID, including run IDs. A device generates only event IDs.
- The capability names are defined here and nowhere else. This package exports no capability check; grant checks belong to `@mymandev/permissions`.
- Change the protocol only by agreement. Protocol version 0 is pre-stable: peers must run the same version, and any other version is rejected as `unsupported_version`.

## Credentials and device authentication

These rules follow [ADR 0014](../../docs/architecture/decisions/0014-accounts-devices-and-invitations.md), which changes the secret rule of [ADR 0004](../../docs/architecture/decisions/0004-uuidv7-identifiers.md) (P-10, P-51).

- A device credential is a registered public key, not a stored secret. Each device holds an Ed25519 key pair; the private key never leaves the device, and the server stores only the raw 32-byte public key as 64 lowercase hexadecimal characters. `isDevicePublicKey` also refuses a non-canonical encoding and the keys of small order (`ED25519_WEAK_PUBLIC_KEYS`), for which `node:crypto` accepts a signature forged without the private key; the API checks it before it registers a key.
- Sign-in codes (`mmdc_`), access tokens (`mmda_`), invitation codes (`mmdi_`), and the sign-in cookie are 32 bytes from `crypto.randomBytes`, encoded as base64url. The codes carry their prefix and are 48 characters long, so secret scanning and the desktop recognize them. Only SHA-256 hashes are kept: invitation codes in the database, the others in API memory. The codes travel only in request bodies or the `Authorization` header, and the cookie only in the `Cookie` header; none of them appears in a URL or a log.
- The API's PKCE verifier for GitHub is the one exception to hashing: it is kept readable, and only in API memory, while a sign-in attempt lives.
- Nonces, PKCE states, verifiers, and challenges are 32 bytes as 43 base64url characters; a signature is 64 bytes as 86 base64url characters. Every encoding is the canonical one without padding that `Buffer.toString("base64url")` writes, and any other form is refused before verification.
- A device signs the UTF-8 bytes of `deviceAuthInput(...)`, never a string it builds itself. The input names its purpose (`ws`, `http`, or `sign-in`), the API's public origin as the audience, the nonce or sign-in code, the device, and what the signature binds to, so a signature never counts for another purpose, server, or connection. The audience is the origin of the API base URL as a URL parser writes it, with a DNS name or a dotted IPv4 address as the host, and must equal `API_PUBLIC_ORIGIN` exactly; the API's configuration refuses an origin that fails `isDeviceAuthAudience`, and `deviceAuthInput` throws for any value outside its format. Signing and verification use `node:crypto` in the desktop main process and in the API.
- `pairingCode(codeChallenge)` gives the 6 digits that the desktop and the API's confirmation page both show for one sign-in. It is not secret.
- The loopback listener checks the `state`, never the `Origin` header, which browsers send as `null` for the API's form POST (#67).

## Accounts and errors

- Inside a workspace, a user is always shown through their person row (`WorkspaceMember`): the person's display name and the GitHub login of its identity, in a monospace font with the time it was last verified, also for a removed person, who is shown as a former member. The account's own display name appears only on the account's own screens. A GitHub login is display data and never identifies an account.
- Every HTTP error answer has the body `{ statusCode, error, message, code }`. `code` is one of `API_ERROR_CODES`. A code that the API raises itself comes with its status from `API_ERROR_STATUS`. An error without its own code, such as a framework error, keeps its status and gets `genericApiErrorCode(status)`, so `bad_request` can come with another 4xx status (for example `413`) and `internal_error` with another 5xx status. `error` and `message` are the status text, never an input value: show the person the text for `code`.
- A route that names a workspace answers a non-member with `404` and `not_found`, exactly as for a workspace that does not exist. Only a join request answers an unknown workspace with `workspace_not_found`.
- An action that the caller's role does not allow answers `403` with `forbidden`; an action that conflicts with the current state, such as a second ownership offer, answers `409` with `conflict`; and an ownership offer or a promotion from a device younger than 72 hours answers `403` with `device_too_new`.

## Scripts

From the repository root:

```sh
npm run typecheck -w @mymandev/protocol
npm test -w @mymandev/protocol
```

`typecheck` runs `tsconfig.json` (source and tests, with Node.js types) and `tsconfig.src.json` (source only, without Node.js types, at the renderer language level). The internal package rules are described in [WORKSPACE.md](../../docs/development/WORKSPACE.md#internal-packages).
