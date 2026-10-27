# @mymandev/protocol

Protocol v0: the shared contract between the desktop application and the cloud API. It defines the identities, the entities, the event envelope, the agent run lifecycle, and the capability vocabulary, with zod schemas that validate untrusted input at runtime.

The protocol is a shared boundary. It changes only by agreement between the Project Manager and the desktop owner; see [OWNERSHIP.md](../../docs/process/OWNERSHIP.md). The decisions behind it are recorded in [ADR 0003 to ADR 0008](../../docs/architecture/decisions/README.md).

## Contents

| Module            | Contents                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/model.ts`    | `PROTOCOL_VERSION`, the capability, run state, and device platform vocabularies, the run transition table with `canTransition`, the text and ID patterns, and `LIMITS`. |
| `src/ids.ts`      | Branded ID schemas and types (`UserId`, `DeviceId`, `WorkspaceId`, `ProjectId`, `RepositoryId`, `AgentId`, `RunId`, `EventId`, `CorrelationId`), `newId`, `newUuidV7`.  |
| `src/entities.ts` | `displayText`, the vocabulary schemas, and the User, Device, Workspace, Project, Repository, Agent, and AgentRun schemas.                                               |
| `src/envelope.ts` | The event envelope, the `agent.run.state_changed` event, `ProtocolEventSchema`, `EVENT_TYPES`, and `actorAllowed`.                                                      |
| `src/decode.ts`   | `decodeEvent`, `decodeClientEvent`, `UnverifiedEvent`, and `enableJitlessValidation`.                                                                                   |

## Consumer rules

- Import only from `@mymandev/protocol`. Never import a file path inside this package.
- A device decodes events that the server sends with `decodeEvent`.
- The server decodes events that a device sends with `decodeClientEvent`. It rejects what only the server may originate (a `system` actor, `deviceId: null`, and a run creation) with `not_allowed_from_device`. Treat the result as `UnverifiedEvent` until the server's identity binding (M2) has bound its actor, device, and referenced IDs to the authenticated connection. Never cast it to `ProtocolEvent` or to a verified type.
- Decoding results are `{ ok: true, event }` or `{ ok: false, code }`. Unknown fields are stripped at every level, and the input is never mutated. The server rejects an event it cannot decode and reports the error to the sender; a device drops and logs it. Nobody processes part of an event, and the server never relays an event it could not validate.
- The desktop renderer calls `enableJitlessValidation()` once at startup, before the first decode, so that validation works under a strict Content Security Policy.
- Human-entered text (`displayName`, `label`, `name`, run `reason`) is always rendered as text, never as markup.
- `newId` and `newUuidV7` generate identifiers, never secrets. An ID is not a capability, and a UUIDv7 reveals its creation time. A secret, such as an invitation token, a device credential, or a session ID, is 32 bytes from `crypto.randomBytes`, encoded as base64url, and stored only as a SHA-256 hash.
- The server generates every entity ID, including run IDs. A device generates only event IDs.
- The capability names are defined here and nowhere else. This package exports no capability check; grant checks belong to the permissions package (M1-06).
- Change the protocol only by agreement. Protocol version 0 is pre-stable: peers must run the same version, and any other version is rejected as `unsupported_version`.

## Scripts

From the repository root:

```sh
npm run typecheck -w @mymandev/protocol
npm test -w @mymandev/protocol
```

`typecheck` runs `tsconfig.json` (source and tests, with Node.js types) and `tsconfig.src.json` (source only, without Node.js types, at the renderer language level). The internal package rules are described in [WORKSPACE.md](../../docs/development/WORKSPACE.md#internal-packages).
