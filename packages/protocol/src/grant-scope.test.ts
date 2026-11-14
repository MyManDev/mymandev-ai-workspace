import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CAPABILITY_SCOPE,
  GRANT_SCOPE_KINDS,
  type GrantScopeKind,
  type ProviderConnectionCapability,
  type RepositoryCapability,
} from "./grant-scope.ts";
import { CAPABILITIES, type Capability } from "./model.ts";

test("every capability has exactly one scope kind, and only provider.use is scoped to a provider connection", () => {
  assert.deepEqual(Object.keys(CAPABILITY_SCOPE), [...CAPABILITIES]);
  // The literal table from ADR 0015, so that CAPABILITY_SCOPE cannot drift from it.
  assert.deepEqual(CAPABILITY_SCOPE, {
    "repo.read": "repository",
    "repo.write": "repository",
    "terminal.execute": "repository",
    "git.commit": "repository",
    "git.push": "repository",
    "provider.use": "provider_connection",
  });
  assert.deepEqual(GRANT_SCOPE_KINDS, ["repository", "provider_connection"]);
  for (const capability of CAPABILITIES) {
    assert.ok(
      GRANT_SCOPE_KINDS.includes(CAPABILITY_SCOPE[capability]),
      capability,
    );
  }
  assert.deepEqual(
    CAPABILITIES.filter(
      (capability) => CAPABILITY_SCOPE[capability] === "provider_connection",
    ),
    ["provider.use"],
  );
  assert.equal(Object.isFrozen(CAPABILITY_SCOPE), true);
  assert.equal(Object.isFrozen(GRANT_SCOPE_KINDS), true);
});

test("no scope kind names a capability: the map relates a capability to a scope kind, never to another capability", () => {
  const names: readonly string[] = CAPABILITIES;
  for (const kind of [
    ...GRANT_SCOPE_KINDS,
    ...Object.values(CAPABILITY_SCOPE),
  ]) {
    assert.equal(typeof kind, "string");
    assert.equal(names.includes(kind), false, kind);
  }
});

test("the scope module imports no value, so it evaluates no schema and no zod", () => {
  const source = readFileSync(
    new URL("./grant-scope.ts", import.meta.url),
    "utf8",
  );
  const lines = source.split("\n");
  const imports = lines.filter((line) => /^import\b/u.test(line));
  assert.deepEqual(imports, ['import type { Capability } from "./model.ts";']);
  // No re-export, which would import a value, and no other way to load one.
  assert.deepEqual(
    lines.filter((line) => /^export\b.*\bfrom\b/u.test(line)),
    [],
  );
  assert.equal(/\bimport\s*\(|\brequire\s*\(/u.test(source), false);
});

test("the scope types follow the map, and a capability without a scope kind does not compile (checked by tsc)", () => {
  const repository: RepositoryCapability[] = [
    "repo.read",
    "repo.write",
    "terminal.execute",
    "git.commit",
    "git.push",
  ];
  const connection: ProviderConnectionCapability = "provider.use";
  // @ts-expect-error provider.use is not scoped to a repository.
  const wrongRepository: RepositoryCapability = "provider.use";
  // @ts-expect-error terminal.execute is not scoped to a provider connection.
  const wrongConnection: ProviderConnectionCapability = "terminal.execute";
  // @ts-expect-error A device is not a scope kind.
  const wrongKind: GrantScopeKind = "device";
  const { "provider.use": providerUse, ...withoutOne } = CAPABILITY_SCOPE;
  // @ts-expect-error A capability without a scope kind.
  const incomplete: Record<Capability, GrantScopeKind> = withoutOne;
  // Every capability is in exactly one of the two types.
  const every: Record<
    RepositoryCapability | ProviderConnectionCapability,
    true
  > = {
    "repo.read": true,
    "repo.write": true,
    "terminal.execute": true,
    "git.commit": true,
    "git.push": true,
    "provider.use": true,
  } satisfies Record<Capability, true>;
  assert.deepEqual(
    [...repository, connection].sort(),
    [...CAPABILITIES].sort(),
  );
  assert.deepEqual(Object.keys(every), [...CAPABILITIES]);
  assert.deepEqual(
    [wrongRepository, wrongConnection, wrongKind, providerUse],
    ["provider.use", "terminal.execute", "device", "provider_connection"],
  );
  assert.equal(incomplete, withoutOne);
});
