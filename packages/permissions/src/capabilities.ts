import type {
  Capability,
  CAPABILITY_SCOPE as PROTOCOL_CAPABILITY_SCOPE,
  GRANT_SCOPE_KINDS as PROTOCOL_GRANT_SCOPE_KINDS,
} from "@mymandev/protocol";

// This module is also the subpath `@mymandev/permissions/capabilities`, which
// the desktop renderer imports. It imports no value, only types, so that it
// never evaluates a schema, a check, zod, or `@mymandev/protocol`.
//
// Since #75 the scope vocabulary is defined in `@mymandev/protocol`, because a
// whole grant travels on the wire. The scope types are re-exported from
// there. The two scope constants cannot be: re-exporting a value would import
// one. They are copies, which `satisfies` holds equal to the protocol's, so
// that a difference does not compile, and a test compares them. Provisional
// (#75): see "Open decisions" in the protocol README.

export type {
  GrantScopeKind,
  ProviderConnectionCapability,
  RepositoryCapability,
} from "@mymandev/protocol";

/**
 * The kinds of scope a grant can name. Every capability has exactly one scope
 * kind, and a grant names exactly one scope of that kind. A copy of the
 * protocol's `GRANT_SCOPE_KINDS`, held equal by the type checker.
 */
export const GRANT_SCOPE_KINDS = Object.freeze([
  "repository",
  "provider_connection",
] as const satisfies typeof PROTOCOL_GRANT_SCOPE_KINDS);

/**
 * The scope kind of every capability (ADR 0015). `provider.use` is scoped to
 * one provider connection on the agent's host device; every other capability
 * is scoped to one repository. It relates a capability to a scope kind, never
 * to another capability. A copy of the protocol's `CAPABILITY_SCOPE`, held
 * equal by the type checker: a new capability, or another scope kind there,
 * does not compile until this copy says the same. The schemas and the checks
 * are built from the protocol's map, never from this copy.
 */
export const CAPABILITY_SCOPE = Object.freeze({
  "repo.read": "repository",
  "repo.write": "repository",
  "terminal.execute": "repository",
  "git.commit": "repository",
  "git.push": "repository",
  "provider.use": "provider_connection",
} as const satisfies typeof PROTOCOL_CAPABILITY_SCOPE);

/** The risk labels. They are labels, not an ordered level. */
export const CAPABILITY_RISKS = Object.freeze(["standard", "highest"] as const);
/** One risk label: `"standard"` or `"highest"`. It is not an ordered level. */
export type CapabilityRisk = (typeof CAPABILITY_RISKS)[number];

/**
 * The risk label of every capability, for presentation and confirmation only
 * (ADR 0015). `terminal.execute` is the only highest-risk capability, because
 * a shell runs as the person on the host device and can, for example, run
 * `git commit` and `git push`. No check reads this table, and it is not an
 * ordered level: nothing is inferred from it. A new capability does not
 * compile until it is classified here.
 */
export const CAPABILITY_RISK = Object.freeze({
  "repo.read": "standard",
  "repo.write": "standard",
  "terminal.execute": "highest",
  "git.commit": "standard",
  "git.push": "standard",
  "provider.use": "standard",
} as const satisfies Record<Capability, CapabilityRisk>);
