import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPABILITIES } from "@mymandev/protocol";
import {
  CAPABILITY_RISK,
  CAPABILITY_RISKS,
  CAPABILITY_SCOPE,
  GRANT_SCOPE_KINDS,
} from "./capabilities.ts";

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

test("only terminal.execute is marked as the highest risk", () => {
  assert.deepEqual(Object.keys(CAPABILITY_RISK), [...CAPABILITIES]);
  assert.deepEqual(CAPABILITY_RISK, {
    "repo.read": "standard",
    "repo.write": "standard",
    "terminal.execute": "highest",
    "git.commit": "standard",
    "git.push": "standard",
    "provider.use": "standard",
  });
  assert.deepEqual(CAPABILITY_RISKS, ["standard", "highest"]);
  for (const capability of CAPABILITIES) {
    assert.ok(
      CAPABILITY_RISKS.includes(CAPABILITY_RISK[capability]),
      capability,
    );
  }
  assert.deepEqual(
    CAPABILITIES.filter(
      (capability) => CAPABILITY_RISK[capability] === "highest",
    ),
    ["terminal.execute"],
  );
  assert.equal(Object.isFrozen(CAPABILITY_RISK), true);
  assert.equal(Object.isFrozen(CAPABILITY_RISKS), true);
});

test("no scope kind or risk value names a capability: the contract has no capability-to-capability relation", () => {
  const names: readonly string[] = CAPABILITIES;
  const values: [label: string, value: unknown][] = [
    ...GRANT_SCOPE_KINDS.map((kind): [string, unknown] => [
      `scope kind ${kind}`,
      kind,
    ]),
    ...CAPABILITY_RISKS.map((risk): [string, unknown] => [
      `risk ${risk}`,
      risk,
    ]),
    ...Object.entries(CAPABILITY_SCOPE).map(
      ([capability, kind]): [string, unknown] => [
        `scope of ${capability}`,
        kind,
      ],
    ),
    ...Object.entries(CAPABILITY_RISK).map(
      ([capability, risk]): [string, unknown] => [
        `risk of ${capability}`,
        risk,
      ],
    ),
  ];
  assert.equal(values.length, 16);
  for (const [label, value] of values) {
    assert.equal(typeof value, "string", label);
    assert.equal(names.includes(value as string), false, label);
  }
});
