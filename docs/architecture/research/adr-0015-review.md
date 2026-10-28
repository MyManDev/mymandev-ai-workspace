# ADR 0015 review record

- Status: Review record for [ADR 0015](../decisions/0015-capability-and-permission-contract-v0.md), which is Proposed.
- Date: 2026-10-28

This record keeps the experiments and the review behind ADR 0015. The ADR is authoritative; where this record and the ADR differ, the ADR applies.

The contract was checked by three independent reviews: correctness, with mutation testing of the checks; security; and consistency with the existing records, conventions, and issues. Every finding was reproduced before it was applied or rejected.

## Experiments

Run with the zod and TypeScript versions pinned in `package-lock.json`.

- `CapabilitySchema.extract` over a list filtered by `CAPABILITY_SCOPE` gives one enum per scope kind, and a discriminated union of the two grant shapes keeps working with a refinement and when nested in `z.object`.
- A grant or request that names both scopes parses to the scope of its own capability only; the other scope is stripped.
- `UtcTimestampSchema` rejects Date objects, offsets such as `+00:00`, a missing `Z`, a missing millisecond part, and impossible dates such as 2026-02-30, and accepts the output of `toISOString()`.
- The JSON Schema export in input mode has no `additionalProperties: false`, and the output mode also exports.
- A Proxy that throws, or a throwing getter, propagates out of `safeParse`, so the checks catch every exception.
- zod reads a required field with a plain property access. A field that is missing from the input is therefore read from the prototype chain: with `Object.prototype.revokedAt` and `revokedByUserId` set to null, a grant without those fields parsed as not revoked, and facts without `grantorMembership` parsed with the inherited membership. The same happened for fields inherited through `Object.create`. Parsing a copy that holds only own data properties, in objects without a prototype, rejects all of these, and zod accepts such objects.
- The `in` operator also follows the prototype chain. With `Object.prototype.repositoryId` set to any value, including undefined, a `provider.use` grant on one connection matched a request for another connection, because both sides read the same inherited value. Comparing only own properties closes it.
- `instanceof Date` is false for a Date created in another realm (`node:vm`), while `Date.prototype.getTime.call` reads its time value and throws for every object that is not a Date, including `Object.create(Date.prototype)` and a Proxy of a Date.

## Review findings

### Applied

- Tests for a future host device revocation and a future membership removal. Before, a change that treated a future value as active passed every test.
- A test case for an array-like object as the list. Before, removing the array guard passed every test.
- The non-mutation test also runs on writable inputs. Before, inputs were frozen, a write threw, and the checks swallowed the exception, so a change that wrote to the caller's objects passed every test.
- Test cases in which the input changes between reads, through an accessor or a Proxy, so that the decision must use the validated copy. Before, using the raw record or the raw request passed every test.
- `now` is accepted from any realm: the `instanceof Date` test was removed, and `Date.prototype.getTime.call` is the only check. A test uses a Date from `node:vm`.
- Tests that a missing or undefined lifecycle timestamp is rejected. Before, making those fields optional passed every test.
- The README and JSDoc name `GrantScopeKind` and `CapabilityRisk`.
- Scope fields are compared only as own properties, with a test that pollutes `Object.prototype`.
- The checks parse a plain-data copy of the request and of each record. An accessor or an inherited field makes the input malformed. Tests cover inherited fields, accessors, a polluted `Object.prototype`, an array in place of an object, and a cycle.
- The README and the enforcement rules state that the caller owns every input: `now` from its own clock, the records from its own store, the agent and the scope from its own run, and that it acts only on the parsed request.
- Archiving a workspace, project, or repository revokes the affected grants (P-77). Signing out and an expired sign-in never revoke grants (P-78).
- The provider connection entity has no owner yet. It is recorded as P-82, with the provider connection fact and the foreign key that bind a grant to the host device; the references to #32 were corrected.
- SQL selects candidate rows by agent, capability, and scope only, never by a lifecycle column.
- The README says how to obtain a typed record without a cast, and that a value that is not a valid Date leaves the row out. The ADR states that `permission_grants.id` stays unbranded until the follow-up migration.
- The membership fact is the row that is not removed if the granting user has several in one workspace.
- Enforcement rules for `terminal.execute`: every allowed shell start is recorded, and the person sees while a shell runs.
- P-81 describes the numbering rule correctly and names the amendment that keeping 0015 needs.
- The ADR lists the accepted records it refines, and links this review record.

### Rejected

- Deny when two records in one list disagree about the same grant or entity. A stale copy that is alone in the list still passes, so the guarantee must come from the enforcement point's store (#55). The rule would also make the result for one record depend on the other records. The README and the ADR instead require one consistent read per call (P-76).
- Make `PermissionRequestSchema` strict, so that a request with both scopes is rejected. It would be the only exception to the stripping rule of ADR 0003, and the parsed request already keeps only the scope of its own capability; the caller acts only on that parsed request.
- Add the membership's creation time to the fact and require it to be before the grant's creation. The writer rule that revokes grants when a member is removed (P-77) already covers a grant from an earlier membership, and the extra field would change the fact for both membership models.
- Add an archive fact for workspaces, projects, and repositories. The revocation cascade (P-77) denies without three more facts.
