// The scope vocabulary of a permission grant (ADR 0015; moved here from
// `@mymandev/permissions` with #75, because a whole grant travels on the
// wire): plain constants without a zod import, like `model.ts`. This module
// imports no value at all, only a type, so that it never evaluates a schema.

import type { Capability } from "./model.ts";

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
 *
 * The grant schemas of this package are built from this map. The
 * capabilities module of `@mymandev/permissions` holds a copy for the desktop
 * renderer, which the type checker and a test hold equal to this one (see
 * that package's README).
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
