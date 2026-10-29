# ADR 0015: Capability and permission contract v0

- Status: Accepted (2026-10-28)
- Amended by [ADR 0014](0014-accounts-devices-and-invitations.md)
- Date: 2026-10-28
- Decided by: Project Manager

## Context

- [ADR 0008](0008-capability-vocabulary-v0.md) defines the six capability names in `@mymandev/protocol`. It assigns the only grant checks to `@mymandev/permissions` (P-20): `isGrantActive`, the single definition of an active grant, and `hasGrant`, which requires an exact capability and the exact scope. It leaves the scope of `provider.use` and the risk treatment of `terminal.execute` to M1-06 (P-21). This record settles both.
- [ADR 0013](0013-m1-data-model.md) adds a provisional `permission_grants` table (P-34): one capability per row, a repository scope, `expires_at`, `revoked_at`, and composite foreign keys. Grants go to agents only (P-35), and only the agent's owner grants (P-44).
  - The table has no provider connection column, and its unscoped unique index allows one `provider.use` grant per agent.
  - How an expired grant is replaced is left to M1-06.
- [ADR 0004](0004-uuidv7-identifiers.md) expects M1-06 to define the ID kind of a permission grant.
- [ADR 0006](0006-event-envelope-v0.md) assigns permission grant events to M1-06, and P-17 fixes the v0 event set.
- Proposed ADR 0014 (pull request #68) describes a different membership model, in which an active member is a claimed person whose `removed_at` is empty, and revocation cascades. This record must not depend on ADR 0014 being accepted.
- Workspaces, projects, and repositories can already be archived (`archived_at` in ADR 0013).
- Enforcement is M3: one enforcement point in the local runtime (#55). Local credential storage is also M3 (#33), and #32 shows the status of provider connections in the desktop application. No issue defines a provider connection entity yet.
- Issue #24 requires that every capability is checked on its own: `repo.write` does not grant `repo.read`, and `git.push` does not grant `git.commit`.
- On 2026-10-28 the Project Manager decided that the desktop owner's agreement is not required while the desktop owner has not started work. The contract is reviewed with the desktop owner when they start.

## Options considered

- Grant shape:
  - A flat grant, discriminated by capability, with the one scope field of the capability's kind (chosen). It mirrors the table columns and the request in ADR 0008.
  - A nested scope object. Rejected: it matches neither the table nor the request, so every reader and writer maps it.
  - A generic `scopeKind` and `scopeId` pair. Rejected: one ID field for two kinds cannot carry a brand per kind, so a repository ID could be passed as a provider connection ID.
- Scope of `provider.use`:
  - One provider connection on the agent's host device (chosen).
  - The whole host device. Rejected: one grant silently covers every provider account added to the device later.
  - A provider kind. Rejected: it needs a provider vocabulary, which [ADR 0005](0005-workspaces-contain-projects.md) defers to M3.
- Scope of `terminal.execute`:
  - One repository (chosen).
  - The whole host device. Rejected: one grant covers every repository, and it adds a third scope kind.
  - No scope. Rejected: ADR 0008 requires an exact scope for every check, and a grant without a scope covers everything the agent can reach.
- Risk:
  - An exhaustive label per capability (chosen). A new capability does not compile until it is classified.
  - A list of the highest-risk capabilities. Rejected: a new capability is unclassified by default.
  - An ordered level. Rejected: an order invites checks such as "at least this level", which infer one capability from another.
  - A machine-readable table such as "`terminal.execute` includes `git.commit`". Rejected: it is an implication table, which ADR 0008 and issue #24 forbid.
- Inputs to "active":
  - Explicit facts, each bound to the entity it describes (chosen).
  - Flat joined columns that can be null. Rejected: a missing joined row reads as "not removed", which fails open.
  - Booleans computed by the caller. Rejected: the caller would combine the conditions, which ADR 0008 forbids.
  - The package querying the database. Rejected: the package is environment-agnostic and also runs in the local runtime.
- Timestamps:
  - The protocol's UTC ISO 8601 strings (chosen).
  - Date objects. Rejected: they are native for Drizzle, but they cannot be exported to JSON Schema, the wire would need a transform, and `instanceof Date` fails across JavaScript realms.
- Malformed input:
  - Deny and never throw (chosen).
  - Throw a `TypeError` on a programming error. Rejected: it adds an exception path at the enforcement point that can be handled wrongly, while a denial already stops the action.
- Reading the input:
  - Parse a copy that holds only the input's own data properties (chosen). A field that is missing stays missing, even when `Object.prototype` is polluted, and the value that is validated is the value that is compared.
  - Parse the input directly. Rejected: zod reads a missing field through the prototype chain, so a polluted `Object.prototype` or an object built with `Object.create` could supply "not revoked" or a membership.
  - Rely on the runtime to freeze `Object.prototype` early. Rejected as the only defense: the package also runs where it does not control start-up, such as the cloud and tests.
- Ambiguous requests:
  - Strip unknown keys, as everywhere else ([ADR 0003](0003-zod-runtime-validation.md)), and require the caller to act only on the parsed request (chosen).
  - Reject a request with unknown keys. Rejected: it would be the only strict schema in the codebase, and the parsed request already keeps only the scope of its own capability.
- Freshness and consistency of the facts:
  - Decided by the M3 enforcement point (chosen).
  - A maximum age inside `isGrantActive`. Rejected: the bound would be chosen before any synchronization design exists, and the cloud would have to invent an observation time.
  - Deny when two records in one list disagree about the same grant or entity. Rejected for v0: it catches a stale copy only when the fresh copy happens to be in the same list, a stale copy alone still passes, and it makes the result for one record depend on the other records. A list comes from one consistent read instead.
- Renewing an expired grant:
  - Revoke the expired row, then insert a new one (chosen).
  - Extend `expires_at` in place. Rejected: it loses history, and one grant ID would stand for different permissions over time.
- Archived workspaces, projects, and repositories:
  - Archiving revokes the affected grants in the same transaction (chosen). It follows the cascade rule for agents, devices, and members, and needs no new fact.
  - An archive fact for each of the three. Rejected for v0: it adds three facts to every record, while the cascade already denies.
- ID kinds:
  - Brands in the protocol now (chosen).
  - Plain UUIDv7 strings until later. Rejected: a grant ID could be confused with any other ID, and ADR 0004 expects the kind from M1-06.
  - Brands in the permissions package. Rejected: `newId` needs the kind in `AnyId`, and the protocol can never import the permissions package.
- Database shape:
  - The provider connection column of `permission_grants`, its foreign key, the scope CHECK, and the scoped unique index in one migration with the provider connection entity (P-82) (chosen). A `provider.use` row then never names a connection that the database cannot check.
  - The provider connection column in a follow-up migration before the entity exists. Rejected: until the foreign key exists, a `provider.use` grant could name any connection, also one on another device, and it would be active.
  - A migration in the same change. Rejected: it would change a shared table before the shape is accepted. No code reads or writes grants yet, and P-34 already provides for a follow-up migration.

## Decision

- Package:
  - `@mymandev/permissions` is an internal, environment-agnostic package ([ADR 0001](0001-internal-packages-export-typescript-source.md)). It uses no Node.js API and reads no clock, no database, and no environment.
  - It imports `CAPABILITIES`, `Capability`, `CapabilitySchema`, the ID schemas, and `UtcTimestampSchema` from `@mymandev/protocol`. It is the only home of the grant shape and of the checks, and it does not re-export protocol names.
- Scopes:
  - `CAPABILITY_SCOPE` is exhaustive. `repo.read`, `repo.write`, `terminal.execute`, `git.commit`, and `git.push` are scoped to one repository. `provider.use` is scoped to one provider connection.
  - It relates a capability to a scope kind, never to another capability. Adding a capability requires a scope decision, enforced at compile time.
- `provider.use` (P-21, P-69, P-82):
  - The scope is exactly one provider connection on the agent's host device, not a repository.
  - A `ProviderConnectionId` is a server-generated UUIDv7 that names connection metadata, never a credential. Credentials stay on the device.
  - The connection needs a server-side entity that holds metadata only, such as its ID, its host device, and when it was created and removed, and never a credential. No issue defines it yet (P-82).
  - When that entity exists, the facts gain a provider connection fact (`id`, `hostDeviceId`, `removedAt`). For a `provider.use` grant, `isGrantActive` then also requires that the fact describes the grant's connection, that the connection is on the agent's host device, and that it is not removed. The migration that adds the entity also adds the `provider_connection_id` column of `permission_grants` with its foreign key, the scope CHECK, and the scoped unique index (P-79).
  - Until then, a `provider.use` row has no provider connection, cannot be mapped to a grant, and is denied. The enforcement point resolves a `ProviderConnectionId` only from its own device's store.
  - The permission screen tells the person that `repo.read` on a repository together with `provider.use` on a provider connection lets the agent send that repository's content to that connection's provider. This is a statement for the person, not an inference.
- `terminal.execute` (P-21, P-70):
  - It is scoped to one repository: the repository is the working directory and the context in which the shell is requested. A run without a repository cannot use it.
  - The scope is not a sandbox. A shell runs as the person on the host device. It can read and change files outside the repository, use the network, run `git commit` and `git push`, and read credentials stored for that user, including local AI provider credentials.
  - Nothing is inferred from it, in either direction.
  - `CAPABILITY_RISK` marks it, and only it, as `highest`. Every other capability is `standard`. The labels are not an ordered level, and no check reads them.
  - Presentation rules:
    - The permission screen shows it as the highest-risk capability and says what a shell can do.
    - It is never preselected and never part of a bundle or a "select all".
    - It is granted on its own, with a separate explicit confirmation.
    - It is offered with a proposed default expiry, which the person can change or remove (P-71).
    - When it is granted on a repository while `git.commit` or `git.push` is not, the screen says that the shell can still commit and push.
  - Enforcement rules:
    - The enforcement point starts the shell in the repository root.
    - It records every shell start that it allows, with the agent, the repository, and the time, in addition to every denial.
    - The desktop application shows the person while a shell runs.
    - What happens to a running shell when its grant becomes inactive, or when the device signs out or its sign-in becomes invalid, is decided in #55.
  - No mandatory expiry in v0 (P-71).
- Grant:
  - The fields of `PermissionGrant` equal the Drizzle property names of `permission_grants` (`id`, `projectId`, `granteeAgentId`, `capability`, `repositoryId`, `grantedByUserId`, `createdAt`, `expiresAt`, `revokedAt`, `revokedByUserId`), plus `providerConnectionId` for the column that arrives with the provider connection entity (P-79, P-82).
  - One capability per grant, and exactly one scope of the capability's kind. Grants go to agents only (P-35), and only the agent's owner grants (P-44, enforced by the database).
  - The schema mirrors the CHECK constraints: `revokedAt` and `revokedByUserId` are set together, and `expiresAt` is after `createdAt`.
  - Unknown keys are stripped ([ADR 0003](0003-zod-runtime-validation.md)). A grant that names both scopes keeps only the scope of its capability.
  - IDs: `PermissionGrantId` and `ProviderConnectionId` are added to the protocol (P-72). The change is additive, and `PROTOCOL_VERSION` is unchanged.
- Request: `PermissionRequest` is the request of ADR 0008, `{ agentId, capability, repositoryId | providerConnectionId }`, discriminated by capability. `PermissionRequestSchema` is exported, so that the M3 messages between the desktop renderer and the main process are validated against the same definition. A caller acts only on the parsed request, never on the raw message, because the parsed request keeps only the scope of its own capability.
- Time (P-73):
  - Grant and fact timestamps are the protocol's UTC ISO 8601 strings with milliseconds. `now` is a `Date` passed by the caller; the package never reads the clock. Any genuine `Date` is accepted, also from another JavaScript realm, and its own time value is read.
  - Expiry is half-open: a grant is active while `now` is before `expiresAt`, so `expiresAt` equal to `now` is expired. A null `expiresAt` means no expiry.
  - There is no not-before check: `createdAt` is never compared with `now`, so clock skew cannot deny a new grant.
  - Mapping database values with `toISOString()` truncates them to milliseconds, which makes expiry earlier and fails closed. A device whose clock is behind keeps a grant up to the skew longer; revocation on the server stays authoritative.
- Facts and "active" (ADR 0008, P-74):
  - `isGrantActive(record, now)` takes a `GrantRecord`: the grant together with the facts it is judged on. This refines `isGrantActive(grant, now)` in ADR 0008, and `hasGrant` takes a list of `GrantRecord` values instead of a list of grants.
  - The facts are the agent (`id`, `hostDeviceId`, `disabledAt`), the host device (`id`, `revokedAt`), the project (`id`, `workspaceId`), and the granting user's membership in the workspace of the grant's project (`workspaceId`, `userId`, `removedAt`), or null when there is none.
  - A grant is active only when all of these hold:
    - it is not revoked, and it has not expired;
    - the agent fact describes the grantee agent, and the agent is not disabled;
    - the host device fact describes the agent's host device, and the device is not revoked;
    - the project fact describes the grant's project;
    - the membership is not null, belongs to the granting user, is in the project's workspace, and is not removed.
  - Any lifecycle timestamp that is set means inactive, whatever its value, including a future one.
  - The facts fit both membership models: today's `workspace_members` row, and under ADR 0014 the claimed person whose user is the granting user. An unclaimed person has no user ID and cannot match. When the granting user has several membership rows in one workspace, the fact is the row that is not removed if there is one, otherwise a removed row or null; both deny.
  - SQL selects candidate rows by agent, capability, and scope ID only, never by a lifecycle column. This applies ADR 0008's rule that no other code combines these columns to queries.
- `hasGrant(records, request, now)`:
  - It returns true only when one record is active and has the same agent, the same capability, and the same scope ID of that capability's kind. Everything else is false.
  - There are no negative grants and no deny-overrides: a revoked row does not cancel a separate active row.
  - It judges each record on its own and does not compare records with each other. The records passed to one call come from one consistent read (P-76).
  - No capability, risk label, scope kind, wildcard, prefix, or case variant grants another capability. Scope fields are compared only as own properties, so a scope inherited from a polluted `Object.prototype` never matches.
- Malformed input (P-75):
  - Both functions are total. They never throw and never mutate their inputs.
  - They read the request and each record as plain data: only own enumerable data properties, each once. An accessor, a cycle through objects, or a field that is only inherited from a prototype makes the input malformed. Arrays are not traversed: an array is rejected where a field is expected and stripped where it is unknown. Within one input, an object that is referenced more than once is read once. The decision uses the validated copy.
  - `hasGrant` reads the length of the list once from its own data, and each element once through its own descriptor.
  - `isGrantActive` returns false for a malformed record or an invalid `now`. `hasGrant` returns false for a malformed request, an invalid `now`, a list that is not an array (also an array-like object), and a list whose length or elements cannot be read. It skips a malformed record, a hole, and an accessor in the list: they never grant, and they do not stop another record from granting. Malformed includes throwing getters and proxies.
- Rules for code that writes grants (P-77):
  - A row never changes after insert, except that `revoked_at` and `revoked_by_user_id` are set once. Revocation is one-way.
  - Renewing an expired grant revokes the expired row and inserts a new one in one transaction; `expires_at` is never extended. This answers the question that ADR 0013 left open.
  - Disabling an agent, revoking a device, removing a member, and archiving a workspace, project, or repository revoke the affected active grants in the same transaction.
  - Clearing `disabled_at`, `removed_at`, or `archived_at` never restores a grant. Without this rule, re-adding a person under today's table would revive their old grants, because `workspace_members` has the primary key (`workspace_id`, `user_id`).
- Rules for the enforcement point (#55):
  - Call `hasGrant` immediately before each action and each process start, and never cache a result.
  - Own every input of the check. Read `now` from its own clock immediately before the call. Take the records from its own store as one consistent read, and the agent and the scope from the run it holds. None of them comes from the requester, a message between processes, or the network.
  - Parse the request with `PermissionRequestSchema`, check the parsed request, and act only on it.
  - Apply the `terminal.execute` enforcement rules above.
  - Evaluate only agents hosted on this device.
  - Deny every check while this device is signed out or its sign-in is no longer valid, whatever the reason. The grants stay active in the data (P-78), but no check on this device succeeds for them.
  - Record every denial.
  - #55 also decides the freshness bound of locally held facts and how a local copy is refreshed (P-76), and what happens to running processes, including a running shell, when a grant becomes inactive or when the device signs out or its sign-in becomes invalid.
- Not in v0:
  - Grant events (P-80). They come with the grant commands as a protocol change. If a whole grant must travel on the wire, the grant schema moves into the protocol and the permissions package re-exports it, because the protocol cannot import the permissions package.
  - Further facts (P-78). The four facts (agent, host device, project, and the granting user's membership) and the grant's own fields cover the five conditions of ADR 0008. A disabled or erased account and a removed provider connection do not exist yet. The task that introduces one of them makes its transaction revoke the affected grants, as in P-77, and the provider connection fact follows P-82. Signing out and an invalid sign-in never revoke grants: they are session states, and the enforcement point denies every check while the device is signed out or its sign-in is not valid.
  - The database migration (P-79).

## Consequences

- One more workspace and two additive protocol ID kinds. The Database workflow runs for this change, because the lockfile and the protocol change.
- This record refines accepted records: [ADR 0004](0004-uuidv7-identifiers.md) (two more ID kinds, P-72), [ADR 0006](0006-event-envelope-v0.md) (grant events deferred, P-80), [ADR 0008](0008-capability-vocabulary-v0.md) (`isGrantActive` takes a `GrantRecord` and `hasGrant` a list of them, P-74, and the risk treatment of `terminal.execute`, P-70), and [ADR 0013](0013-m1-data-model.md) (the renewal and cascade rules, P-77, and the table shape, P-79). Their text is not changed. If P-68 of proposed ADR 0014 is accepted, each of them then gets an "Amended by ADR 0015" line.
- Until the provider connection entity exists, a `provider.use` row cannot be mapped to a grant and is denied: the contract fails closed. `permission_grants.id` stays an unbranded `uuid` column until the first task that reads or writes grants types it as `PermissionGrantId`, a change of the TypeScript type only; until then readers get the brand by parsing with `GrantRecordSchema`.
- `provider.use` cannot be granted or enforced until the provider connection entity exists (P-82).
- Every reader builds the facts with joins, and a missing row fails closed.
- The permission screen and the enforcement point (#55) inherit the presentation and enforcement rules above.
- Offline behavior of the desktop application is bounded only after #55 decides freshness.
- Adding a capability needs a protocol change, a scope entry, a risk entry, and a database migration.
- Update of 2026-10-29 (#74): the provider connection entity exists. The `provider_connections` table and the `provider_connection_id` column of `permission_grants`, with its foreign key, came in one migration (P-79, P-82). The database also requires that a `provider.use` grant names a connection of its agent's host device, through a `host_device_id` column and two composite foreign keys. The facts gained `providerConnection` (`id`, `hostDeviceId`, `removedAt`), null for a grant on a repository; `isGrantActive` requires for `provider.use` that it describes the grant's connection, that the connection is on the agent's host device, and that it is not removed, and for a repository grant that it is null. `permission_grants.id` is typed as `PermissionGrantId` in the same change. Enforcement is still #55, and the writer that removes a connection revokes its grants (P-77). The text above is unchanged.

## Dependency policy

- No new third-party dependency.
- zod 4, classic API, exact pin, at the same version as `@mymandev/protocol` ([ADR 0003](0003-zod-runtime-validation.md)). `@mymandev/protocol` is an internal dependency at `0.0.0`.
- `@types/node` is an exact-pinned development dependency ([ADR 0001](0001-internal-packages-export-typescript-source.md)).

## Evidence

- [`packages/permissions/src/capabilities.ts`](../../../packages/permissions/src/capabilities.ts), [`grant.ts`](../../../packages/permissions/src/grant.ts), and [`check.ts`](../../../packages/permissions/src/check.ts), with the consumer rules in [`packages/permissions/README.md`](../../../packages/permissions/README.md).
- [`packages/protocol/src/ids.ts`](../../../packages/protocol/src/ids.ts) (`PermissionGrantId`, `ProviderConnectionId`) and [`ids.test.ts`](../../../packages/protocol/src/ids.test.ts): the new kinds are generated and validated like the other kinds, and `@ts-expect-error` lines prove that a `RepositoryId` is not a `ProviderConnectionId` and an `AgentId` is not a `PermissionGrantId`.
- [`capabilities.test.ts`](../../../packages/permissions/src/capabilities.test.ts): every capability has exactly one scope kind and one risk label, only `provider.use` is scoped to a provider connection, only `terminal.execute` is `highest`, and no scope kind or risk label names a capability.
- [`grant.test.ts`](../../../packages/permissions/src/grant.test.ts): grants, records, and requests accept exactly one scope of the capability's kind, and a grant or request that names both scopes keeps only its own; wildcard-like, misspelled, and non-string capabilities, malformed IDs, and timestamps that are not UTC with milliseconds, including missing and undefined ones, are rejected; the CHECK mirrors hold; unknown, `__proto__`, and `constructor` keys are stripped without mutating the input; the input-mode JSON Schema export allows unknown keys and requires the lifecycle timestamps; and `@ts-expect-error` lines prove that requests that mix or omit scopes do not compile.
- [`check.test.ts`](../../../packages/permissions/src/check.test.ts): none of the 30 ordered capability pairs grants the other capability, five grants together do not grant the sixth, the scope and the agent must match exactly, each inactive fact alone denies, also with a future timestamp, expiry is half-open, malformed records, requests, times, and lists deny without throwing, accessors, inherited fields, and a polluted `Object.prototype` neither fill a missing field nor widen a scope, a hole or an accessor in the list is skipped and never read through a polluted prototype, an accessor stays malformed when `Object.prototype.value` is polluted, a request or grant whose later reads differ from its own data is judged on its own data, an object referenced more than once is read once and judged on its copy, a cycle is detected when it is reached again, the length of the list is read once from its own data, the checks keep no state between calls, a `Date` from another realm is a valid `now`, `hasGrant` equals a reference implementation over a full cross product, and writable inputs are not changed.
- [`index.test.ts`](../../../packages/permissions/src/index.test.ts): the package exports exactly the contract.
- Review record: [ADR 0015 review record](../research/adr-0015-review.md).

## Needs Project Manager decision

Answered by the Project Manager on 2026-10-28. Every recommendation was accepted.

- The scope of `provider.use`: exactly one provider connection on the agent's host device, named by a server-generated `ProviderConnectionId` (connection metadata only, never a credential); the binding to the host device needs the provider connection entity (P-82). The alternatives are the whole host device or a provider kind (P-69, recommended: accept one provider connection on the host device; a whole-device grant silently covers every provider account added later, and a provider kind needs a vocabulary that ADR 0005 defers to M3).
  - Accepted.
- `terminal.execute`: scoped to one repository (not a sandbox), and marked as the only `highest` risk in an exhaustive `CAPABILITY_RISK` label that no check reads, with the presentation rules and the enforcement rules above (the shell starts in the repository root, every allowed shell start is recorded, and the person sees while a shell runs). The alternatives are a device-wide scope, or an implication table saying that `terminal.execute` includes `git.commit` and `git.push` (P-70, recommended: accept a repository scope with a presentation-only risk label and these enforcement rules; a device-wide scope covers every repository with one grant, and an implication table contradicts ADR 0008).
  - Accepted.
- Should `terminal.execute` grants require an expiry, with a schema refinement and a database CHECK on the maximum duration (P-71, recommended: no rule in v0; the permission screen proposes a default expiry for `terminal.execute`, as in the presentation rules; revisit with the M3 enforcement, #55)?
  - Accepted.
- Add `PermissionGrantId` and `ProviderConnectionId` to `@mymandev/protocol` in this change? The change is additive and leaves `PROTOCOL_VERSION` unchanged, but the protocol is a shared boundary, and the change runs the Database workflow (P-72, recommended: yes; ADR 0004 expects M1-06 to define the grant ID kind, `newId` requires the kind in `AnyId`, and brands defined in the permissions package could never be used by the protocol).
  - Accepted.
- Timestamps in the grant and the facts: the protocol's UTC ISO 8601 strings with milliseconds, or Date objects; in both cases `now` is a `Date` passed by the caller (P-73, recommended: ISO strings; they are the protocol's only timestamp convention, native on the wire for the local runtime, and exportable to JSON Schema, and mapping database values with `toISOString()` makes expiry earlier, which fails closed).
  - Accepted.
- `isGrantActive` takes the grant together with explicit facts bound to their entities (agent, host device, project, and the granting user's membership or null), not joined columns that can be null or booleans computed by the caller. When the granting user has several membership rows in one workspace, the fact is the row that is not removed if there is one. `hasGrant` accordingly takes a list of such records instead of a list of grants. Does this refinement of `isGrantActive(grant, now)` and `hasGrant(grants, request, now)` in ADR 0008 stand? It works with today's membership table and with proposed ADR 0014 (P-74, recommended: accept; a fact about the wrong entity or a missing row fails closed, and M1-06 then does not depend on ADR 0014 being accepted).
  - Accepted.
- Malformed input, such as bad grant data, a bad request, an invalid `now`, or a list that is not an array: deny and never throw, or throw a `TypeError` on programming errors. The checks read their input as plain data, so an accessor or a field that is only inherited from a prototype is malformed (P-75, recommended: deny and never throw; both functions parse a plain-data copy with zod inside `try`/`catch` and return false, a denial already stops the action, #55 records every denial, and the enforcement point has no exception path to get wrong)?
  - Accepted.
- Freshness and consistency of the facts that the local runtime holds: a maximum age inside `isGrantActive` now (5 minutes was proposed), or decided by the M3 enforcement point, with the rule that the records of one `hasGrant` call come from one consistent read (P-76, recommended: decide in #55; #55 owns where the runtime reads grants from, a bound fixed now would be chosen before any synchronization design exists, the cloud would have to invent an observation time, and comparing records inside `hasGrant` misses a stale copy that is alone in the list)?
  - Accepted: #55 decides the freshness bound and the refresh of local copies.
- The rules for code that writes grants, as listed in the decision: rows are immutable except for a one-way revocation; an expired grant is renewed by revoking it and inserting a new row in one transaction, never by extending `expires_at`; disabling an agent, revoking a device, removing a member, and archiving a workspace, project, or repository revoke the affected active grants in the same transaction; re-enabling an agent, re-adding a member, or unarchiving never restores a grant (P-77, recommended: accept; extending a grant in place loses history, and one grant ID would stand for different permissions over time; without the cascade, re-adding a person under today's `workspace_members` key would revive their old grants, and an archived repository would keep its grants; this is consistent with P-60 in proposed ADR 0014).
  - Accepted.
- Should v0 add facts beyond the four in this record (agent, host device, project, and the granting user's membership), which together with the grant's own fields cover the five conditions of ADR 0008, such as a disabled or erased account or a removed provider connection (P-78, recommended: no; keep the four facts, let the task that introduces one of those states revoke the affected grants in its transaction, as in P-77, and add the provider connection fact with P-82; signing out and an invalid sign-in never revoke grants, because proposed ADR 0014 keeps a signed-out device and its agents; instead, the enforcement point denies every check while the device is signed out or its sign-in is not valid)?
  - Accepted.
- The database change for `permission_grants`: a `provider_connection_id` column with a foreign key to the provider connection, a scope CHECK with `num_nonnulls`, and a unique index scoped to the provider connection. Should it come in a migration of its own after this record is accepted, or in one migration with the provider connection entity (P-79, recommended: in one migration with the entity, P-82; a column without the foreign key would let a `provider.use` grant name any connection, also one on another device; until then a `provider.use` row cannot be mapped to a grant and is denied; typing `id` as `PermissionGrantId` changes only the TypeScript type and comes with the first task that reads or writes grants)?
  - Accepted: the column comes with the provider connection entity in #74.
- ADR 0006 assigned permission grant events to M1-06, but P-17 fixed the v0 event set: add grant events now, or defer them (P-80, recommended: defer them to the task that adds grant commands, in M2 or M3, as a protocol change; if a whole grant must travel on the wire, the grant schema moves into the protocol and the permissions package re-exports it, because the protocol cannot import the permissions package)?
  - Accepted: the grant commands and events are #75.
- The ADR number. The numbering rule gives a record the next free number when it is merged, and open pull request #68 already uses 0014. If this record merges first, either it keeps 0015 and the Numbering paragraph is amended so that a number used by an open pull request is skipped, or it is renamed to 0014 before merge and #68 takes the next free number. Whichever merges second also resolves the index row that both add after 0013 (P-81, recommended: keep 0015 and amend the Numbering paragraph in this pull request on acceptance; #68 and its review record cite 0014 throughout, and the P-69 to P-82 IDs do not depend on the record number).
  - Accepted: this record keeps 0015, and the Numbering paragraph of the index now says that a number used by a record in an open pull request is not free.
- `provider.use` needs a server-side provider connection entity (metadata only: an ID, the host device, when it was created and removed, never a credential), a provider connection fact in the contract, and the `provider_connection_id` column of `permission_grants` with its foreign key (P-79). No issue defines it: #32 shows connection status, and #33 stores credentials on the device. Who owns it, and when (P-82, recommended: a new M3 issue, assigned by the Project Manager, that lands before #55 enforces `provider.use` and before the provider adapters, #30 and #31)?
  - Accepted: #74, assigned to the Project Manager.
- The desktop owner's agreement is not required while the desktop owner has not started work (Project Manager decision of 2026-10-28). The contract is reviewed with the desktop owner when they start.
  - The review with the desktop owner is #76.
