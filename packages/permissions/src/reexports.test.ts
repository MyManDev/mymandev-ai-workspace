import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as protocol from "@mymandev/protocol";
import { CAPABILITIES } from "@mymandev/protocol";
import * as permissions from "./index.ts";

// Since #75 the grant shape and the scope vocabulary are defined in
// `@mymandev/protocol`, because whole grants travel on the wire. This package
// keeps its public names: `index.test.ts` holds the list. These tests hold
// what stands behind the names.

const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-000000000005";
const PROVIDER_CONNECTION_ID = "0192f0a0-7b3c-7d4e-8f50-000000000006";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000003";

test("the grant schemas are the protocol's own, re-exported under the same names", () => {
  for (const name of [
    "PermissionGrantSchema",
    "GrantFactsSchema",
    "GrantRecordSchema",
  ] as const) {
    assert.equal(typeof protocol[name].safeParse, "function", name);
    assert.equal(permissions[name], protocol[name], name);
  }
});

test("the checks, the request, and the risk labels stay in this package: the protocol exports none of them", () => {
  for (const name of [
    "hasGrant",
    "isGrantActive",
    "PermissionRequestSchema",
    "CAPABILITY_RISK",
    "CAPABILITY_RISKS",
  ]) {
    assert.equal(Object.hasOwn(permissions, name), true, name);
    assert.equal(Object.hasOwn(protocol, name), false, name);
  }
});

test("the scope constants equal the protocol's, value for value and in the same order", () => {
  assert.deepEqual(
    Object.entries(permissions.CAPABILITY_SCOPE),
    Object.entries(protocol.CAPABILITY_SCOPE),
  );
  assert.deepEqual(
    [...permissions.GRANT_SCOPE_KINDS],
    [...protocol.GRANT_SCOPE_KINDS],
  );
  assert.deepEqual(Object.keys(permissions.CAPABILITY_SCOPE), [
    ...CAPABILITIES,
  ]);
  for (const constant of [
    permissions.CAPABILITY_SCOPE,
    permissions.GRANT_SCOPE_KINDS,
    protocol.CAPABILITY_SCOPE,
    protocol.GRANT_SCOPE_KINDS,
  ]) {
    assert.equal(Object.isFrozen(constant), true);
  }
});

test("the type checker holds the scope constants and types equal to the protocol's (checked by tsc)", () => {
  // Each direction compiles only while the two declarations are the same.
  const scope: typeof protocol.CAPABILITY_SCOPE = permissions.CAPABILITY_SCOPE;
  const scopeBack: typeof permissions.CAPABILITY_SCOPE =
    protocol.CAPABILITY_SCOPE;
  const kinds: typeof protocol.GRANT_SCOPE_KINDS =
    permissions.GRANT_SCOPE_KINDS;
  const kindsBack: typeof permissions.GRANT_SCOPE_KINDS =
    protocol.GRANT_SCOPE_KINDS;
  const drifted = {
    ...permissions.CAPABILITY_SCOPE,
    "git.push": "provider_connection",
  } as const;
  // @ts-expect-error A map that scopes one capability differently.
  const wrongScope: typeof protocol.CAPABILITY_SCOPE = drifted;
  const { "provider.use": providerUse, ...withoutOne } =
    permissions.CAPABILITY_SCOPE;
  // @ts-expect-error A map without one capability.
  const incomplete: typeof protocol.CAPABILITY_SCOPE = withoutOne;
  const reordered = ["provider_connection", "repository"] as const;
  // @ts-expect-error The scope kinds in another order.
  const wrongKinds: typeof protocol.GRANT_SCOPE_KINDS = reordered;

  // The scope types are the protocol's types under the same names.
  const kind = (value: protocol.GrantScopeKind): permissions.GrantScopeKind =>
    value;
  const kindBack = (
    value: permissions.GrantScopeKind,
  ): protocol.GrantScopeKind => value;
  const repository = (
    value: protocol.RepositoryCapability,
  ): permissions.RepositoryCapability => value;
  const repositoryBack = (
    value: permissions.RepositoryCapability,
  ): protocol.RepositoryCapability => value;
  const connection = (
    value: protocol.ProviderConnectionCapability,
  ): permissions.ProviderConnectionCapability => value;
  const connectionBack = (
    value: permissions.ProviderConnectionCapability,
  ): protocol.ProviderConnectionCapability => value;
  const grant = (
    value: protocol.PermissionGrant,
  ): permissions.PermissionGrant => value;
  const record = (value: permissions.GrantRecord): protocol.GrantRecord =>
    value;
  const facts = (value: protocol.GrantFacts): permissions.GrantFacts => value;

  assert.deepEqual(scope, scopeBack);
  assert.deepEqual(kinds, kindsBack);
  assert.equal(wrongScope, drifted);
  assert.equal(incomplete, withoutOne);
  assert.equal(wrongKinds, reordered);
  assert.equal(providerUse, "provider_connection");
  assert.equal(kind(kindBack("repository")), "repository");
  assert.equal(repository(repositoryBack("repo.read")), "repo.read");
  assert.equal(connection(connectionBack("provider.use")), "provider.use");
  assert.equal(typeof grant, "function");
  assert.equal(typeof record, "function");
  assert.equal(typeof facts, "function");
});

test("the request follows the protocol's scope map, and no schema or check is built from the copy", () => {
  for (const capability of CAPABILITIES) {
    const [own, other] =
      protocol.CAPABILITY_SCOPE[capability] === "repository"
        ? (["repositoryId", "providerConnectionId"] as const)
        : (["providerConnectionId", "repositoryId"] as const);
    const ids = {
      repositoryId: REPOSITORY_ID,
      providerConnectionId: PROVIDER_CONNECTION_ID,
    };
    assert.deepEqual(
      permissions.PermissionRequestSchema.parse({
        agentId: AGENT_ID,
        capability,
        ...ids,
      }),
      { agentId: AGENT_ID, capability, [own]: ids[own] },
      capability,
    );
    assert.equal(
      permissions.PermissionRequestSchema.safeParse({
        agentId: AGENT_ID,
        capability,
        [other]: ids[other],
      }).success,
      false,
      capability,
    );
  }
  // The copy in capabilities.ts is for presentation: the modules that hold
  // the schemas and the checks never import it.
  for (const file of ["./grant.ts", "./check.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.equal(source.includes("capabilities.ts"), false, file);
  }
});
