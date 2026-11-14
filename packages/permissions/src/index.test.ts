import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the package exports exactly the contract", async () => {
  // Capability names and ID kinds are imported from @mymandev/protocol and
  // are not re-exported here.
  const exported = Object.keys(await import("./index.ts")).sort();
  assert.deepEqual(exported, [
    "CAPABILITY_RISK",
    "CAPABILITY_RISKS",
    "CAPABILITY_SCOPE",
    "GRANT_SCOPE_KINDS",
    "GrantFactsSchema",
    "GrantRecordSchema",
    "PermissionGrantSchema",
    "PermissionRequestSchema",
    "hasGrant",
    "isGrantActive",
  ]);
});

test("the capabilities subpath exports exactly the presentation vocabulary and imports no value", async () => {
  // The desktop renderer imports this subpath: it must never evaluate the
  // schemas and checks, and with them zod and @mymandev/protocol.
  const main = await import("@mymandev/permissions");
  const capabilities = await import("@mymandev/permissions/capabilities");
  assert.deepEqual(Object.keys(capabilities).sort(), [
    "CAPABILITY_RISK",
    "CAPABILITY_RISKS",
    "CAPABILITY_SCOPE",
    "GRANT_SCOPE_KINDS",
  ]);
  for (const [name, value] of Object.entries(capabilities)) {
    assert.equal(value, main[name as keyof typeof main]);
  }

  const source = readFileSync(
    new URL("./capabilities.ts", import.meta.url),
    "utf8",
  );
  const lines = source.split("\n");
  const imports = lines.filter((line) => /^import\b/.test(line));
  assert.ok(imports.length > 0);
  for (const line of imports) {
    assert.match(line, /^import type\b/);
  }
  assert.deepEqual(
    lines.filter((line) => /^export\s*(?:\*|\{)/.test(line)),
    [],
  );
});
