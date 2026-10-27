# ADR 0004: Identifiers are lowercase UUIDv7

- Status: Proposed
- Date: 2026-10-27
- Decided by: (filled in by the Project Manager on acceptance)

## Context

IDs cross devices, the API, and PostgreSQL. They must not collide, must sort well in B-tree indexes, must have one canonical text form, and different ID kinds must not be confused in code. Node.js 24 has `crypto.randomUUID()` (version 4) but no UUIDv7 generator. PostgreSQL has `uuidv7()` only from version 18.

## Options considered

- UUIDv7 (RFC 9562 section 5.7: "Implementations SHOULD utilize UUIDv7"): time-ordered, native PostgreSQL `uuid` type (16 bytes). RFC 9562 leaves 74 bits after the timestamp. The uuid library uses them as a 32-bit counter plus 42 random bits: the first ID in a millisecond starts the counter at a random 31-bit value (73 random bits in total); each further ID in the same millisecond from the same process takes the previous counter plus one and carries only 42 fresh random bits.
- ULID: sortable with 80 random bits, but no RFC and no native PostgreSQL type.
- Prefixed text IDs (`usr_...`): readable, but they need `text` keys and a custom codec.
- Database-generated `gen_random_uuid()` (version 4): random index inserts, and the database instead of the application decides IDs.

## Decision

- Every ID is a UUIDv7 in canonical lowercase form, validated by `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`. PostgreSQL stores it as `uuid`.
- TypeScript brands per kind: `UserId`, `DeviceId`, `WorkspaceId`, `ProjectId`, `RepositoryId`, `AgentId`, `RunId`, `EventId`, and `CorrelationId`. The database types its columns with the same brands. Conversations, messages, and permission grants use plain UUIDv7 strings until the protocol defines their kinds (M2-03, M1-06).
- The protocol owns generation with the uuid library: `newId<T>()` for a branded kind and `newUuidV7()` for an unbranded ID. No database column has an ID default.
- Authority:
  - The server generates every entity ID (user, device, workspace, project, repository, agent, run, conversation, message, grant). A client never chooses an entity ID. This includes runs: creating a run is a server command (M2). The server allocates the `RunId` and emits the creation transition (`null -> queued`) with a `system` actor; `decodeClientEvent` rejects `previousState: null` from a device ([ADR 0006](0006-event-envelope-v0.md), [ADR 0007](0007-agent-run-lifecycle-v0.md)).
  - An emitting device generates only event IDs. An event ID is the idempotency key: the server de-duplicates on the authenticated connection's device ID and the event ID, never on the `deviceId` field inside the event. For chat messages this is a `client_event_id` column with a unique index per sending device (M1-03).
- An ID is never a secret and never a capability (RFC 9562 section 8: UUIDs "MUST NOT be used as security capabilities"). Knowing a workspace ID grants nothing ([ADR 0005](0005-workspaces-contain-projects.md)).
- Secrets are never UUIDs. Invitation tokens, device credentials, and session IDs are 32 bytes from `crypto.randomBytes`, encoded as base64url, and stored only as a SHA-256 hash. `newId` and `newUuidV7` carry a "never use it for a secret" comment, and the protocol README states the rule.
- The timestamp inside a UUIDv7 is never used for ordering, auditing, or authorization. The server uses its own receive time and, from M2, a server sequence.

## Consequences

- IDs sort in creation order.
- A UUIDv7 reveals its creation time to the millisecond. This is acceptable for these entities; see P-08 for user IDs. Event IDs that a device generates also reveal that device's clock.
- IDs from one process in the same millisecond are sequential. They stay unique and unguessable enough for identifiers, which are not secrets.
- Mixed case is impossible: a JavaScript `Map` and a PostgreSQL `uuid` column cannot disagree about equality.
- One extra runtime dependency in the protocol package (uuid: MIT, ESM, under 1 KB gzip for version 7).

## Dependency policy

- uuid 14, exact pin, as a `dependency` of `@mymandev/protocol` only. Other workspaces generate IDs through the protocol package.

## Evidence

- [`packages/protocol/src/model.ts`](../../../packages/protocol/src/model.ts) (`UUIDV7_PATTERN`) and [`packages/protocol/src/ids.ts`](../../../packages/protocol/src/ids.ts).
- [`packages/protocol/src/ids.test.ts`](../../../packages/protocol/src/ids.test.ts): generated IDs match the pattern and sort in creation order; uppercase and version 4 UUIDs are rejected; a `@ts-expect-error` line proves that a `UserId` is not assignable to a `DeviceId`.
- Review record: M1 Technical Decision Set, revision 2 of 2026-10-27 (ADR 0004, Section 2.5), linked from the M1-01 pull request.

## Needs Project Manager decision

- UUIDv7, lowercase, PostgreSQL `uuid`, branded types (P-07).
- Whether user IDs are also UUIDv7, which reveals the sign-up time to the millisecond (P-08, recommended: yes).
- The protocol package generates IDs and depends on uuid (P-09, recommended: yes).
- The server generates entity IDs, including run IDs; devices generate only event IDs; de-duplication uses the authenticated device ID; secrets are random bytes stored as hashes, never UUIDs (P-10).
