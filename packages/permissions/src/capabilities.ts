import type { Capability } from "@mymandev/protocol";

/**
 * The kinds of scope a grant can name. Every capability has exactly one scope
 * kind, and a grant names exactly one scope of that kind.
 */
export const GRANT_SCOPE_KINDS = Object.freeze([
  "repository",
  "provider_connection",
] as const);
/** One scope kind: `"repository"` or `"provider_connection"`. */
export type GrantScopeKind = (typeof GRANT_SCOPE_KINDS)[number];

/**
 * The scope kind of every capability (ADR 0015). `provider.use` is scoped to
 * one provider connection on the agent's host device; every other capability
 * is scoped to one repository. It relates a capability to a scope kind, never
 * to another capability. A new capability does not compile until its scope
 * kind is decided here.
 */
export const CAPABILITY_SCOPE = Object.freeze({
  "repo.read": "repository",
  "repo.write": "repository",
  "terminal.execute": "repository",
  "git.commit": "repository",
  "git.push": "repository",
  "provider.use": "provider_connection",
} as const satisfies Record<Capability, GrantScopeKind>);

/** The capabilities that are scoped to one repository. */
export type RepositoryCapability = {
  [C in Capability]: (typeof CAPABILITY_SCOPE)[C] extends "repository"
    ? C
    : never;
}[Capability];

/** The capabilities that are scoped to one provider connection. */
export type ProviderConnectionCapability = {
  [C in Capability]: (typeof CAPABILITY_SCOPE)[C] extends "provider_connection"
    ? C
    : never;
}[Capability];

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
