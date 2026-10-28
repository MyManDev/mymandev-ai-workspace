import assert from "node:assert/strict";
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
