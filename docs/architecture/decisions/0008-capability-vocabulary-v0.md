# ADR 0008: Capability vocabulary v0

- Status: Accepted (2026-10-28)
- Amended by [ADR 0014](0014-accounts-devices-and-invitations.md)
- Amended by [ADR 0015](0015-capability-and-permission-contract-v0.md)
- Date: 2026-10-27
- Decided by: Project Manager

## Context

The roadmap fixes six capabilities and the rule that no implementation may infer one capability from another. Issues #19 and #24 both require that capability names are defined in one package only and that the other package imports them. M1-01 lands first, and M1-06 plans a separate `packages/permissions`.

## Options considered

- Define the names in `@mymandev/protocol` (M1-01) and let `@mymandev/permissions` import them (recommended), or define them in `@mymandev/permissions` and make the protocol depend on it. The second option forces M1-06 to land before or with M1-01.
- A closed enum with exact matching (recommended), or a hierarchy or wildcards. A hierarchy or a wildcard contradicts the roadmap rule.

## Decision

- `CAPABILITIES` is `repo.read`, `repo.write`, `terminal.execute`, `git.commit`, `git.push`, and `provider.use`, in this order, in `packages/protocol/src/model.ts`, with the type `Capability`. `CapabilitySchema` in `packages/protocol/src/entities.ts` validates one name.
- Exact match only. No wildcard (`repo.*` is rejected), no hierarchy, and no implication: `repo.write` does not grant `repo.read`, and `git.push` does not grant `git.commit`. An absent capability is denied. An unknown string rejects the message.
- The protocol exports no capability check. A set-based `hasCapability(granted, required)` has no scope: a set built from all of an agent's grants would let `repo.write` on repository X pass for repository Y, which is the kind of inference the roadmap forbids. The only check lives in `packages/permissions` (M1-06):
  - `isGrantActive(grant, now)` is the single definition of "active": not revoked, not expired, the agent not disabled, the host device not revoked, and the granting user still a member of the workspace. No other code combines these columns.
  - `hasGrant(grants, { agentId, capability, repositoryId | providerConnectionId }, now)` requires an exact capability and the exact scope.
- M1-06 adds the grant shape in `packages/permissions` and imports `CAPABILITIES`, `Capability`, and `CapabilitySchema` from `@mymandev/protocol`.
- The database CHECK on `permission_grants.capability` must equal `CAPABILITIES` exactly, proven by a test (M1-03).
- Notes for M1-06:
  - `provider.use` is not repository-scoped; its scope is a provider connection on the host device. The provisional M1-03 table has no provider connection column yet, so one `provider.use` grant would cover every provider account on the host device. This is one reason to hold the M1-03 merge until the grant shape is agreed (P-34).
  - `terminal.execute` can run `git commit` and `git push` through a shell. The contract still infers nothing from it, but the user interface and the enforcement must treat it as the highest-risk capability and say so.

## Consequences

- The vocabulary is a closed enum: adding a capability is a protocol change ([ADR 0006](0006-event-envelope-v0.md)) and a database migration.
- `packages/permissions` will depend on `packages/protocol`, which is allowed: packages may depend on packages, and there is no cycle.

## Dependency policy

No new dependency.

## Evidence

- [`packages/protocol/src/model.ts`](../../../packages/protocol/src/model.ts) (`CAPABILITIES`, `Capability`) and [`packages/protocol/src/entities.ts`](../../../packages/protocol/src/entities.ts) (`CapabilitySchema`).
- [`packages/protocol/src/model.test.ts`](../../../packages/protocol/src/model.test.ts): the exact list in order, and `CapabilitySchema` rejects `repo.*`, `REPO.READ`, and unknown strings.
- Review record: [M1 Technical Decision Set](../research/m1-technical-decision-set.md), revision 2 of 2026-10-27 (ADR 0008).

## Needs Project Manager decision

Answered by the Project Manager on 2026-10-28.

- Capability names live in `@mymandev/protocol`, which exports no capability check; `@mymandev/permissions` imports the names and owns `isGrantActive` and `hasGrant` (P-20). This also needs the desktop owner's agreement, because M1-06 is shared.
  - Accepted by the Project Manager. The desktop owner's agreement was requested in pull request #48, and the merge did not wait for it.
- The `provider.use` scope and the risk treatment of `terminal.execute` are settled in M1-06 (P-21).
  - Settled in M1-06.
