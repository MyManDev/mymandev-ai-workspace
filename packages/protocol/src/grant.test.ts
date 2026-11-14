import assert from "node:assert/strict";
import { test } from "node:test";
import * as z from "zod";
import { CAPABILITY_SCOPE } from "./grant-scope.ts";
import {
  GrantFactsSchema,
  GrantRecordSchema,
  PermissionGrantSchema,
  type PermissionGrant,
} from "./grant.ts";
import { CAPABILITIES, type Capability } from "./model.ts";

// The schemas of this module were moved from `@mymandev/permissions` (#75).
// That package re-exports them, and its `grant.test.ts` and `check.test.ts`
// still exercise them through the re-exports, with every ID field, every
// timestamp form, and hostile input. These tests hold the rules that the
// wire contract of this package rests on.

type Json = Record<string, unknown>;

const GRANT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000001";
const PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000002";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000003";
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-000000000005";
const PROVIDER_CONNECTION_ID = "0192f0a0-7b3c-7d4e-8f50-000000000006";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007";
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000008";
const CREATED_AT = "2026-11-14T10:00:00.000Z";
const LATER = "2026-11-14T11:30:00.007Z";

/** The scope field of a capability's kind, and the field of the other kind. */
function scopeKeys(capability: Capability): [own: string, other: string] {
  return CAPABILITY_SCOPE[capability] === "repository"
    ? ["repositoryId", "providerConnectionId"]
    : ["providerConnectionId", "repositoryId"];
}

function scopeId(key: string): string {
  return key === "repositoryId" ? REPOSITORY_ID : PROVIDER_CONNECTION_ID;
}

function grant(capability: Capability, fields: Json = {}): Json {
  const [own] = scopeKeys(capability);
  return {
    id: GRANT_ID,
    projectId: PROJECT_ID,
    granteeAgentId: AGENT_ID,
    capability,
    [own]: scopeId(own),
    grantedByUserId: USER_ID,
    createdAt: CREATED_AT,
    expiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    ...fields,
  };
}

function facts(capability: Capability = "repo.read"): Json {
  return {
    agent: { id: AGENT_ID, hostDeviceId: DEVICE_ID, disabledAt: null },
    hostDevice: { id: DEVICE_ID, revokedAt: null },
    project: { id: PROJECT_ID, workspaceId: WORKSPACE_ID },
    grantorMembership: {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      removedAt: null,
    },
    providerConnection:
      CAPABILITY_SCOPE[capability] === "provider_connection"
        ? {
            id: PROVIDER_CONNECTION_ID,
            hostDeviceId: DEVICE_ID,
            removedAt: null,
          }
        : null,
  };
}

function without(value: Json, key: string): Json {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== key),
  );
}

test("a grant parses for each capability with exactly the scope of its kind", () => {
  for (const capability of CAPABILITIES) {
    const [own, other] = scopeKeys(capability);
    const input = grant(capability);
    const parsed = PermissionGrantSchema.parse(input);
    assert.deepEqual(parsed, input, capability);
    assert.equal(Object.hasOwn(parsed, other), false, capability);

    // The scope of the other kind alone, and no scope at all, are refused.
    assert.equal(
      PermissionGrantSchema.safeParse({
        ...without(input, own),
        [other]: scopeId(other),
      }).success,
      false,
      `${capability} with only ${other}`,
    );
    assert.equal(
      PermissionGrantSchema.safeParse(without(input, own)).success,
      false,
      `${capability} without a scope`,
    );
    assert.equal(
      PermissionGrantSchema.safeParse({ ...input, [own]: null }).success,
      false,
      `${capability} with a null scope`,
    );
  }
});

test("a grant that names both scopes keeps only the scope of its capability", () => {
  for (const capability of CAPABILITIES) {
    const [own, other] = scopeKeys(capability);
    const parsed = PermissionGrantSchema.parse({
      ...grant(capability),
      [other]: scopeId(other),
    });
    assert.deepEqual(parsed, grant(capability), capability);
    assert.equal(Object.hasOwn(parsed, own), true, capability);
    assert.equal(Object.hasOwn(parsed, other), false, capability);
  }
});

test("a grant names one capability of the vocabulary: no wildcard, list, or other spelling", () => {
  for (const capability of [
    "repo.*",
    "*",
    "repo",
    "repo.read ",
    "Repo.Read",
    "repo.read,repo.write",
    "terminal",
    "",
    ["repo.read"],
    null,
    7,
  ]) {
    for (const key of ["repositoryId", "providerConnectionId"]) {
      assert.equal(
        PermissionGrantSchema.safeParse({
          ...without(grant("repo.read"), "repositoryId"),
          capability,
          [key]: scopeId(key),
        }).success,
        false,
        `${JSON.stringify(capability)} with ${key}`,
      );
    }
  }
});

test("revokedAt and revokedByUserId are set together, and expiresAt is after createdAt", () => {
  for (const capability of CAPABILITIES) {
    const ok: Json[] = [
      grant(capability),
      grant(capability, { revokedAt: LATER, revokedByUserId: USER_ID }),
      grant(capability, { expiresAt: LATER }),
      grant(capability, { expiresAt: "2026-11-14T10:00:00.001Z" }),
    ];
    for (const input of ok) {
      assert.deepEqual(PermissionGrantSchema.parse(input), input, capability);
    }
    const refused: [label: string, input: Json, path: string][] = [
      [
        "revokedAt alone",
        grant(capability, { revokedAt: LATER }),
        "revokedByUserId",
      ],
      [
        "revokedByUserId alone",
        grant(capability, { revokedByUserId: USER_ID }),
        "revokedByUserId",
      ],
      [
        "expiresAt equal to createdAt",
        grant(capability, { expiresAt: CREATED_AT }),
        "expiresAt",
      ],
      [
        "expiresAt before createdAt",
        grant(capability, { expiresAt: "2026-11-14T09:59:59.999Z" }),
        "expiresAt",
      ],
    ];
    for (const [label, input, path] of refused) {
      const result = PermissionGrantSchema.safeParse(input);
      assert.equal(result.success, false, `${capability}: ${label}`);
      assert.deepEqual(
        result.error?.issues.map((issue) => issue.path),
        [[path]],
        `${capability}: ${label}`,
      );
    }
  }
});

test("a grant needs every field, with IDs and UTC timestamps in the protocol's form", () => {
  const input = grant("repo.read");
  for (const key of Object.keys(input)) {
    assert.equal(
      PermissionGrantSchema.safeParse(without(input, key)).success,
      false,
      `without ${key}`,
    );
  }
  for (const [label, fields] of [
    ["an uppercase ID", { id: GRANT_ID.toUpperCase() }],
    ["an ID that is not a UUIDv7", { granteeAgentId: "agent-1" }],
    ["a null granting account", { grantedByUserId: null }],
    ["a time without milliseconds", { createdAt: "2026-11-14T10:00:00Z" }],
    ["a time with an offset", { createdAt: "2026-11-14T10:00:00.000+03:00" }],
    ["a time as a number", { expiresAt: 1_794_650_400_000 }],
    ["a missing expiry written as undefined", { expiresAt: undefined }],
  ] as const) {
    assert.equal(
      PermissionGrantSchema.safeParse(grant("repo.read", fields)).success,
      false,
      label,
    );
  }
});

test("a record holds a grant and every fact; only the membership and the provider connection may be null", () => {
  for (const capability of CAPABILITIES) {
    const record = { grant: grant(capability), facts: facts(capability) };
    assert.deepEqual(GrantRecordSchema.parse(record), record, capability);
  }
  const base = facts("provider.use");
  assert.deepEqual(GrantFactsSchema.parse(base), base);
  for (const key of ["grantorMembership", "providerConnection"]) {
    const input = { ...base, [key]: null };
    assert.deepEqual(GrantFactsSchema.parse(input), input, key);
  }
  for (const key of Object.keys(base)) {
    assert.equal(
      GrantFactsSchema.safeParse(without(base, key)).success,
      false,
      `without ${key}`,
    );
  }
  for (const key of ["agent", "hostDevice", "project"]) {
    assert.equal(
      GrantFactsSchema.safeParse({ ...base, [key]: null }).success,
      false,
      `a null ${key}`,
    );
  }
  // A lifecycle time is never missing: it is a time or null.
  for (const [fact, key] of [
    ["agent", "disabledAt"],
    ["hostDevice", "revokedAt"],
    ["grantorMembership", "removedAt"],
    ["providerConnection", "removedAt"],
  ] as const) {
    assert.equal(
      GrantFactsSchema.safeParse({
        ...base,
        [fact]: without(base[fact] as Json, key),
      }).success,
      false,
      `${fact} without ${key}`,
    );
  }
  assert.equal(
    GrantRecordSchema.safeParse({ grant: grant("repo.read") }).success,
    false,
    "a grant without facts",
  );
  assert.equal(
    GrantRecordSchema.safeParse({ facts: facts() }).success,
    false,
    "facts without a grant",
  );
});

test("unknown keys are stripped at every level of a record, and the input is not changed", () => {
  const input = {
    grant: {
      ...grant("repo.read"),
      hostDeviceId: DEVICE_ID,
      role: "owner",
      capabilities: [...CAPABILITIES],
    },
    facts: {
      ...facts(),
      agent: { ...(facts()["agent"] as Json), ownerUserId: USER_ID },
      repository: { id: REPOSITORY_ID, archivedAt: null },
    },
    active: true,
  };
  const copy = structuredClone(input);
  const parsed = GrantRecordSchema.parse(input);
  assert.deepEqual(parsed, { grant: grant("repo.read"), facts: facts() });
  assert.deepEqual(input, copy);
  assert.notEqual(parsed.grant, input.grant);
});

test("the grant schemas export to JSON Schema, and the types name exactly one scope (checked by tsc)", () => {
  for (const schema of [
    PermissionGrantSchema,
    GrantFactsSchema,
    GrantRecordSchema,
  ]) {
    assert.equal(typeof z.toJSONSchema(schema, { io: "input" }), "object");
  }
  const parsed: PermissionGrant = PermissionGrantSchema.parse(
    grant("repo.read"),
  );
  if (parsed.capability === "provider.use") {
    const connection: string = parsed.providerConnectionId;
    // @ts-expect-error A grant on a provider connection has no repository.
    const repository: string = parsed.repositoryId;
    assert.fail(`${connection} ${repository}`);
  } else {
    const repository: string = parsed.repositoryId;
    // @ts-expect-error A grant on a repository has no provider connection.
    const connection: unknown = parsed.providerConnectionId;
    assert.equal(repository, REPOSITORY_ID);
    assert.equal(connection, undefined);
  }
});
