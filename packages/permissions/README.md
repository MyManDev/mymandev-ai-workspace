# @mymandev/permissions

The capability and permission contract v0. It holds the shape of a permission grant and the facts that decide whether a grant is active, defines the request of an agent for one capability, and owns the only checks: `isGrantActive` and `hasGrant`. Every capability is checked on its own and on its own scope: no capability grants another.

Since #75 the shape of a grant, of its facts, and of a grant record, and the scope vocabulary are defined in `@mymandev/protocol`, because whole grants travel on the wire and the protocol can never import this package ([ADR 0015](../../docs/architecture/decisions/0015-capability-and-permission-contract-v0.md), P-80). This package exports them under the same names as before.

The permission contract is a shared boundary. It changes only by agreement between the Project Manager and the desktop owner; see [OWNERSHIP.md](../../docs/process/OWNERSHIP.md). The decisions behind it are recorded in [ADR 0008](../../docs/architecture/decisions/0008-capability-vocabulary-v0.md) and [ADR 0015](../../docs/architecture/decisions/0015-capability-and-permission-contract-v0.md). The desktop owner's agreement was not required while the desktop owner had not started work (Project Manager decision of 2026-10-28). The contract is reviewed with the desktop owner when they start.

## Contents

| Module                | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/capabilities.ts` | Also exported as `@mymandev/permissions/capabilities`. `GRANT_SCOPE_KINDS` and `CAPABILITY_SCOPE` (the scope kind of every capability), as copies of the protocol's that the type checker holds equal to them; the types `GrantScopeKind`, `RepositoryCapability`, and `ProviderConnectionCapability`, re-exported from the protocol; and `CAPABILITY_RISKS`, `CapabilityRisk`, and `CAPABILITY_RISK` (for presentation only), which are defined here. |
| `src/grant.ts`        | `PermissionGrantSchema`, `GrantFactsSchema`, `GrantRecordSchema`, and their types, re-exported from the protocol: the same schema objects. `PermissionRequestSchema` and its type, which are defined here.                                                                                                                                                                                                                                             |
| `src/check.ts`        | `isGrantActive` and `hasGrant`.                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Consumer rules

- Import only from `@mymandev/permissions`, or from `@mymandev/permissions/capabilities` for the presentation vocabulary alone (`GRANT_SCOPE_KINDS`, `CAPABILITY_SCOPE`, `CAPABILITY_RISKS`, `CAPABILITY_RISK`, and their types). The subpath imports no value, so it evaluates no schema, no check, no zod, and no `@mymandev/protocol`, also where nothing is tree-shaken; the desktop renderer imports only this subpath. Never import a file path inside this package. Import capability names and ID kinds from `@mymandev/protocol`; this package does not re-export them.
- `PermissionGrantSchema`, `GrantFactsSchema`, `GrantRecordSchema`, their types, and the scope types are the protocol's own, re-exported: importing them from either package gives the same schema objects. `GRANT_SCOPE_KINDS` and `CAPABILITY_SCOPE` are not. The capabilities module must import no value, so it cannot re-export them: it holds copies, which `satisfies` holds equal to the protocol's, so that a difference does not compile, and a test compares them. The schemas and the checks are built from the protocol's map, never from the copies. This arrangement is provisional (#75; see "Open decisions" in the [protocol README](../protocol/README.md#grant-routes-and-events)).
- `hasGrant(records, request, now)` is the only authorization check. `isGrantActive(record, now)` is the only definition of an active grant; use it for display and listing.
- No other code combines `revoked_at`, `expires_at`, the agent's `disabled_at`, the device's `revoked_at`, and the membership's `removed_at`. SQL selects candidate rows by `grantee_agent_id`, `capability`, and the scope ID only, never by a lifecycle column, and every decision goes through `hasGrant`. One exception is provisional (#75): the record list of `GET /grant-records` leaves out revoked grants. A revoked grant never grants and cancels no other grant, so every check gives the same result with or without it.
- Exact match only. Never build a set of capabilities from an agent's grants, and never add a helper that relates one capability to another.
- Pass `now` explicitly. The package reads no clock and no database.
- The caller owns every input of a check. `now` is read from the caller's own clock immediately before the call. The records come from the caller's own store, and the agent and the scope come from the run that the caller holds. None of them is taken from the requester, a message between processes, or the network. Parse the request with `PermissionRequestSchema` first, pass the parsed request to `hasGrant`, and act only on that parsed request, never on the raw message.
- The records passed to one `hasGrant` call come from one consistent read. Never merge copies of a grant or of a fact from different reads into one list; the enforcement point decides how a local copy is refreshed (#55). For the desktop, one consistent read is one answer of `GET /grant-records`, whose records the server reads from one snapshot (one statement, or a REPEATABLE READ transaction) (#75, [protocol README](../protocol/README.md#grant-routes-and-events)). A grant event carries no facts, so a record is never built from an event.
- Build each record from rows read together, as plain data. Mapping from the current tables:
  - The grant fields are the Drizzle property names of `permission_grants`, unchanged. The table's `hostDeviceId` is not a grant field and is stripped; the agent fact carries the host device.
  - Timestamps are mapped with `toISOString()`. A value that is not a valid `Date` (for example from a database `infinity`) cannot be mapped; leave that row out, which denies.
  - `grantorMembership` is the granting user's membership in the workspace of the grant's project: the row that is not removed if there is one, otherwise a removed row or null. A removed row and null both deny.
  - `providerConnection` is the `provider_connections` row of the grant's `provider_connection_id`, read together with the grant, for a `provider.use` grant, and null for a grant on a repository. A removed connection, a connection on another device than the agent's, and a fact for the wrong grant all deny.
  - Obtain a typed `GrantRecord` with `GrantRecordSchema.safeParse` and leave out a row that fails. Never cast a row to `GrantRecord`.
- Records and requests are plain data: only their own enumerable data properties are read, each once. An accessor, a cycle through objects, or a field that is only inherited from a prototype makes the input malformed. Arrays inside them are not traversed; the schemas accept no array. `hasGrant` reads the length of the list once from its own data, and each element once through its own descriptor.
- The checks never throw. `isGrantActive` returns false for a malformed record or an invalid `now`. `hasGrant` returns false for a malformed request, an invalid `now`, a list that is not an array, or a list whose length or elements cannot be read. It skips a malformed record, a hole, or an accessor in the list, which never grants and does not stop another record from granting. Treat false as a denial, and never retry with a looser request.
- `CAPABILITY_RISK` is for presentation only. The permission screen presents `terminal.execute` as the highest-risk capability ([ADR 0015](../../docs/architecture/decisions/0015-capability-and-permission-contract-v0.md)).
- A grant never carries a credential. A `ProviderConnectionId` names connection metadata only.
- Under a strict Content Security Policy, a consumer that imports the main entry sets `z.config({ jitless: true })` before this package is evaluated, exactly as for `@mymandev/protocol` (see its README). The main entry creates its schemas when it is evaluated. The capabilities subpath creates none and needs no setting.

## Not included

- Enforcement: the enforcement point in the local runtime (#55).
- The provider connection entity and its binding to the agent's host device (ADR 0015, P-82), and local credential storage (#33).
- The grant routes and the grant events. Their contract is in `@mymandev/protocol` (#75); the database writers and the API routes follow in their own changes.
- The database migration that adds the provider connection column; it comes with the provider connection entity (ADR 0015, P-79).
- The permission screen.

## Scripts

From the repository root:

```sh
npm run typecheck -w @mymandev/permissions
npm test -w @mymandev/permissions
```

`typecheck` runs `tsconfig.json` (source and tests, with Node.js types) and `tsconfig.src.json` (source only, without Node.js types, at the renderer language level). The internal package rules are described in [WORKSPACE.md](../../docs/development/WORKSPACE.md#internal-packages).
