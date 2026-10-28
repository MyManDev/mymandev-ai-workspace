# ADR 0015 review record

- Status: Review record for [ADR 0015](../decisions/0015-capability-and-permission-contract-v0.md), which is Accepted.
- Date: 2026-10-28

This record keeps the experiments and the review behind ADR 0015. The ADR is authoritative; where this record and the ADR differ, the ADR applies.

The contract was checked in two rounds. In the first, three independent reviews looked at correctness, with mutation testing of the checks; security; and consistency with the existing records, conventions, and issues. They reported 24 findings; some items below combine findings that two reviews reported. The second round reviewed the state after those changes, with three new reviews (code and security, contract and documents, repository integration), and a separate verifier tried to refute each finding. Every finding was reproduced before it was applied or rejected.

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
- Archiving a workspace, project, or repository revokes the affected grants (P-77). Signing out and an invalid sign-in never revoke grants (P-78).
- The provider connection entity has no owner yet. It is recorded as P-82, with the provider connection fact and the foreign key that bind a grant to the host device; the references to #32 were corrected.
- SQL selects candidate rows by agent, capability, and scope only, never by a lifecycle column.
- The README says how to obtain a typed record without a cast, and that a value that is not a valid Date leaves the row out. The ADR states that `permission_grants.id` stays unbranded until the first task that reads or writes grants types it.
- The membership fact is the row that is not removed if the granting user has several in one workspace.
- Enforcement rules for `terminal.execute`: every allowed shell start is recorded, and the person sees while a shell runs.
- P-81 describes the numbering rule correctly and names the amendment that keeping 0015 needs.
- The ADR lists the accepted records it refines, and links this review record.

### Rejected

- Deny when two records in one list disagree about the same grant or entity. A stale copy that is alone in the list still passes, so the guarantee must come from the enforcement point's store (#55). The rule would also make the result for one record depend on the other records. The README and the ADR instead require one consistent read per call (P-76).
- Make `PermissionRequestSchema` strict, so that a request with both scopes is rejected. It would be the only exception to the stripping rule of ADR 0003, and the parsed request already keeps only the scope of its own capability; the caller acts only on that parsed request.
- Add the membership's creation time to the fact and require it to be before the grant's creation. The writer rule that revokes grants when a member is removed (P-77) already covers a grant from an earlier membership, and the extra field would change the fact for both membership models.
- Add an archive fact for workspaces, projects, and repositories. The revocation cascade (P-77) denies without three more facts.

## Second review

### Applied

- An object that is referenced more than once in a record or a request was copied once per path. A graph of 25 objects (24 levels) in an unknown key made the process run out of memory, which no `try` can catch. The plain-data copy now copies each object once and treats a cycle as malformed instead of relying on the stack running out. Tests count the reads.
- `hasGrant` read each element of the list with a plain property read, so a hole in the list was read from a polluted `Array.prototype` or `Object.prototype` and could grant. It now reads each element as an own data property and skips holes and accessors. A test pollutes both prototypes.
- Tests in which a request or a grant reads differently from its own data, for the agent, the capability, and both scope kinds. Before, comparing the raw agent or capability passed every test.
- A test that a request naming both scopes keeps only the scope of its capability, for all six capabilities. Before, a repository request that kept the other scope passed every test.
- The provider connection column of `permission_grants` now comes in one migration with the provider connection entity and its foreign key (P-79, P-82). Before, the record said both that `provider.use` is denied until the entity exists and that a separate earlier migration adds the column, which would have let a `provider.use` grant name any connection in between.
- The enforcement rules now say that the enforcement point denies every check while the device is signed out or its sign-in is not valid. P-78 relied on this rule without stating it.
- The ADR and the README say that `hasGrant` skips a malformed record instead of denying the whole list.
- P-78 names the four facts of this record; ADR 0008 lists five conditions, two of which are fields of the grant.
- The proposed default expiry for `terminal.execute` is a presentation rule, not only part of the P-71 recommendation.
- The ADR names the change to `hasGrant` (a list of records instead of grants) as a refinement of ADR 0008.
- This record describes the mutation testing below.

### Applied after the fixes were checked

A further check of the fixes above found these, each reproduced by a separate verifier:

- An accessor was recognized by testing `"value" in descriptor`, which also finds a polluted `Object.prototype.value`. An accessor element of the list, or an accessor field of a record, was then read as the polluted value and could grant. Both places now test `Object.hasOwn(descriptor, "value")`, and a test pollutes `Object.prototype.value`.
- `hasGrant` read `records.length` on every iteration, so a list Proxy whose length reads as `Infinity` or grows on every read never returned. It now reads the length once from its own data and denies anything that is not a valid array length.
- Tests that an object referenced again is judged on its copy, that a cycle is detected when it is reached again and not by running out of stack, that the checks keep no state between calls, that fields that are not enumerable are missing, and that the exported JSON Schema requires the lifecycle timestamps. Before, a mutant for each of these passed every test.
- The ADR and the README describe the list separately from the request and the records, say that arrays are not traversed, and say that an object is read once within one input.
- The enforcement rule for a signed-out device says that no check succeeds, and #55 also decides what happens to running processes when the device signs out or its sign-in becomes invalid.
- A test restores `Array.prototype.length`, which defining index 0 on `Array.prototype` had raised for the rest of the test process.

### Rejected

- The time of `hasGrant` grows with the length of the list, holes included, so a sparse list or a list Proxy with a length near the maximum takes very long. Every index costs what one real record costs, no document promises a time bound, the length can no longer be infinite, and the list comes only from the caller's own store.
- P-78 should name the account disabling of proposed ADR 0014 and require it to revoke grants. ADR 0014 does not say that a disabled account keeps its grants, P-78 already requires the task that introduces that state to revoke them, and P-77 already says that clearing any `disabled_at` never restores a grant.

## Mutation testing

The checks were mutated one change at a time, and the full package test suite ran for each mutant. Every surviving mutant that a review reported in an earlier round and that is not equivalent now fails at least one test.

The final run covered 110 mutants of `check.ts` and `grant.ts`, including every mutant of the earlier rounds, adapted to the final code. 96 fail at least one test. The type check rejects four of the remaining 14. Of the 14:

- 10 are equivalent: no input tells them apart from the code.
  - The scope comparison returns true instead of false at its end. The line is unreachable: the capabilities are compared first, and parsed grants and requests with the same capability always have their own scope field of that kind.
  - The provider branch of the scope comparison without its own-property tests, and the repository branch without its `in` tests. Only own fields of parsed values reach it; the `in` tests exist for TypeScript, which rejects the second mutant.
  - The cycle lookup and the copy lookup of the plain-data copy in the other order. An object is never in both at the same time.
  - A hole in the list parsed as `undefined` instead of skipped. zod rejects `undefined`, so it is skipped.
  - `Number.isFinite` replaced by `!Number.isNaN` for `now`. The time value of a Date is never infinite.
  - Four changes to the length check: no descriptor test, `in` instead of the own-property test, no accessor test, and no number test. The length of an array or of an array Proxy is always an own data property, and `Number.isSafeInteger` rejects every value that is not a number.
- 4 change no result, only what is read or reported.
  - Without the check that the request parsed, without the check of an invalid length, or without the lower bound of the length, `hasGrant` reads more of its input before it denies, and it still returns false.
  - The expiry refinement written as `<=` adds no second issue for an invalid timestamp. The grant is rejected either way.
