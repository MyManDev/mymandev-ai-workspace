import assert from "node:assert/strict";
import { test } from "node:test";
import * as z from "zod";
import {
  AgentIdSchema,
  CAPABILITIES,
  ProviderConnectionIdSchema,
  RepositoryIdSchema,
  type Capability,
} from "@mymandev/protocol";
import { CAPABILITY_SCOPE } from "./capabilities.ts";
import {
  GrantRecordSchema,
  PermissionGrantSchema,
  PermissionRequestSchema,
  type PermissionRequest,
} from "./grant.ts";

// Every non-ASCII character in this file is written as an escape.

const GRANT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000001";
const PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000002";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000003";
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-000000000005";
const PROVIDER_CONNECTION_ID = "0192f0a0-7b3c-7d4e-8f50-000000000006";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007";
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000008";
const CREATED_AT = "2026-10-28T10:00:00.000Z";
const LATER = "2026-10-28T11:30:00.007Z";

const REVOCATION_MESSAGE = "revokedAt and revokedByUserId are set together";
const EXPIRY_MESSAGE = "expiresAt is after createdAt";

type Json = Record<string, unknown>;

function scopeKey(capability: Capability): string {
  return CAPABILITY_SCOPE[capability] === "repository"
    ? "repositoryId"
    : "providerConnectionId";
}

function otherScopeKey(capability: Capability): string {
  return CAPABILITY_SCOPE[capability] === "repository"
    ? "providerConnectionId"
    : "repositoryId";
}

function scopeId(capability: Capability): string {
  return CAPABILITY_SCOPE[capability] === "repository"
    ? REPOSITORY_ID
    : PROVIDER_CONNECTION_ID;
}

function grant(capability: Capability, fields: Json = {}): Json {
  return {
    id: GRANT_ID,
    projectId: PROJECT_ID,
    granteeAgentId: AGENT_ID,
    capability,
    [scopeKey(capability)]: scopeId(capability),
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

function record(capability: Capability, fields: Json = {}): Json {
  return { grant: grant(capability, fields), facts: facts(capability) };
}

function request(capability: Capability): Json {
  return {
    agentId: AGENT_ID,
    capability,
    [scopeKey(capability)]: scopeId(capability),
  };
}

function without(value: Json, key: string): Json {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

/** A copy of `base` with `value` at `path`. */
function withValue(base: Json, path: readonly string[], value: unknown): Json {
  const copy = structuredClone(base);
  let target = copy;
  for (const key of path.slice(0, -1)) {
    target = target[key] as Json;
  }
  target[path.at(-1) as string] = value;
  return copy;
}

/** A copy of `base` without the key at `path`. */
function withoutPath(base: Json, path: readonly string[]): Json {
  const copy = structuredClone(base);
  let target = copy;
  for (const key of path.slice(0, -1)) {
    target = target[key] as Json;
  }
  delete target[path.at(-1) as string];
  return copy;
}

/** Adds own `__proto__`, `constructor` and unknown keys, as JSON.parse creates them. */
function hostile(value: Json): Json {
  const keys =
    '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"extra":"unknown",';
  return JSON.parse(`{${keys}${JSON.stringify(value).slice(1)}`) as Json;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

test("a grant parses for each capability with the scope of its kind", () => {
  const cases: [label: string, value: Json][] = CAPABILITIES.map(
    (capability) => [capability, grant(capability)],
  );
  assert.equal(cases.length, 6);
  for (const [label, value] of cases) {
    const result = PermissionGrantSchema.safeParse(value);
    assert.ok(result.success, label);
    assert.deepEqual(result.data, value, label);
    const recordResult = GrantRecordSchema.safeParse({
      grant: value,
      facts: facts(),
    });
    assert.ok(recordResult.success, `${label} as a record`);
    assert.deepEqual(recordResult.data, { grant: value, facts: facts() });
  }

  // A row as Drizzle reads it from permission_grants, with Date timestamps,
  // mapped with toISOString() as the README describes.
  const createdAt = new Date(Date.UTC(2026, 9, 28, 10, 0, 0, 123));
  const row = {
    id: GRANT_ID,
    projectId: PROJECT_ID,
    granteeAgentId: AGENT_ID,
    capability: "repo.read",
    repositoryId: REPOSITORY_ID,
    grantedByUserId: USER_ID,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 3_600_000),
    revokedAt: null as Date | null,
    revokedByUserId: null,
  };
  const disabledAt: Date | null = null;
  const mapped = {
    grant: {
      ...row,
      createdAt: iso(row.createdAt),
      expiresAt: iso(row.expiresAt),
      revokedAt: iso(row.revokedAt),
    },
    facts: {
      ...facts(),
      agent: {
        id: AGENT_ID,
        hostDeviceId: DEVICE_ID,
        disabledAt: iso(disabledAt),
      },
    },
  };
  const mappedResult = GrantRecordSchema.safeParse(mapped);
  assert.ok(mappedResult.success, "a record mapped from Date values");
  assert.equal(mappedResult.data.grant.createdAt, "2026-10-28T10:00:00.123Z");
  assert.equal(mappedResult.data.grant.expiresAt, "2026-10-28T11:00:00.123Z");
});

test("a grant with the other kind's scope or with no scope is rejected", () => {
  const cases: [label: string, value: Json][] = [];
  for (const capability of CAPABILITIES) {
    if (CAPABILITY_SCOPE[capability] === "repository") {
      cases.push([
        `${capability} with a provider connection`,
        {
          ...without(grant(capability), "repositoryId"),
          providerConnectionId: PROVIDER_CONNECTION_ID,
        },
      ]);
    }
  }
  cases.push([
    "provider.use with a repository",
    {
      ...without(grant("provider.use"), "providerConnectionId"),
      repositoryId: REPOSITORY_ID,
    },
  ]);
  for (const capability of CAPABILITIES) {
    cases.push([
      `${capability} without a scope`,
      without(grant(capability), scopeKey(capability)),
    ]);
  }
  assert.equal(cases.length, 12);
  for (const [label, value] of cases) {
    assert.equal(PermissionGrantSchema.safeParse(value).success, false, label);
    assert.equal(
      GrantRecordSchema.safeParse({ grant: value, facts: facts() }).success,
      false,
      `${label} as a record`,
    );
  }

  // The current table has no provider connection column: a provider.use row
  // has a null repository and cannot be mapped to a grant.
  assert.equal(
    PermissionGrantSchema.safeParse({
      ...without(grant("provider.use"), "providerConnectionId"),
      repositoryId: null,
    }).success,
    false,
    "provider.use row of the current table",
  );
});

test("a grant or a request that names both scopes keeps only the scope of its capability", () => {
  const cases: [label: string, value: Json][] = CAPABILITIES.map(
    (capability) => [
      capability,
      grant(capability, {
        repositoryId: REPOSITORY_ID,
        providerConnectionId: PROVIDER_CONNECTION_ID,
      }),
    ],
  );
  assert.equal(cases.length, 6);
  for (const [label, value] of cases) {
    const capability = value.capability as Capability;
    const result = PermissionGrantSchema.safeParse(value);
    assert.ok(result.success, label);
    assert.deepEqual(result.data, grant(capability), label);
    assert.equal(
      Object.hasOwn(result.data, otherScopeKey(capability)),
      false,
      label,
    );
  }

  for (const capability of CAPABILITIES) {
    const label = `${capability} request`;
    const result = PermissionRequestSchema.safeParse({
      ...request(capability),
      repositoryId: REPOSITORY_ID,
      providerConnectionId: PROVIDER_CONNECTION_ID,
      extra: "unknown",
    });
    assert.ok(result.success, label);
    assert.deepEqual(result.data, request(capability), label);
    assert.equal(
      Object.hasOwn(result.data, otherScopeKey(capability)),
      false,
      label,
    );
  }
});

test("wildcard-like, misspelled and non-string capabilities are rejected", () => {
  const cases: [label: string, value: unknown][] = [
    ["*", "*"],
    ["**", "**"],
    ["repo.*", "repo.*"],
    ["git.*", "git.*"],
    ["*.read", "*.read"],
    ["repo", "repo"],
    ["repo.", "repo."],
    ["REPO.READ", "REPO.READ"],
    ["Repo.Read", "Repo.Read"],
    ["leading space", " repo.read"],
    ["trailing space", "repo.read "],
    ["trailing NUL", "repo.read\u0000"],
    ["trailing ZERO WIDTH SPACE", "repo.read\u200b"],
    ["Cyrillic o", "rep\u043e.read"],
    ["two capabilities", "repo.read,repo.write"],
    ["all", "all"],
    ["admin", "admin"],
    ["empty", ""],
    ["an array", ["repo.read"]],
    ["a String object", new String("repo.read")],
    ["null", null],
    ["undefined", undefined],
    ["a number", 1],
  ];
  assert.equal(cases.length, 23);
  for (const [label, value] of cases) {
    for (const scoped of ["repo.read", "provider.use"] as const) {
      assert.equal(
        PermissionGrantSchema.safeParse(grant(scoped, { capability: value }))
          .success,
        false,
        `${label} as a grant with the scope of ${scoped}`,
      );
      assert.equal(
        PermissionRequestSchema.safeParse({
          ...request(scoped),
          capability: value,
        }).success,
        false,
        `${label} as a request with the scope of ${scoped}`,
      );
    }
  }
});

test("malformed IDs are rejected in every ID field", () => {
  const values: [label: string, value: unknown][] = [
    ["*", "*"],
    ["empty", ""],
    ["%", "%"],
    ["uppercase", "0192F0A0-7B3C-7D4E-8F50-000000000009"],
    ["braces", "{0192f0a0-7b3c-7d4e-8f50-000000000009}"],
    ["leading space", " 0192f0a0-7b3c-7d4e-8f50-000000000009"],
    ["nil UUID", "00000000-0000-0000-0000-000000000000"],
    ["UUIDv4", "9b2f0e3a-4c5d-4e6f-8a7b-0c1d2e3f4a5b"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an array", [AGENT_ID]],
  ];
  assert.equal(values.length, 12);

  const revoked = record("repo.read", {
    revokedAt: LATER,
    revokedByUserId: USER_ID,
  });
  const fields: [
    label: string,
    schema: z.ZodType,
    base: Json,
    path: readonly string[],
  ][] = [
    ["grant.id", GrantRecordSchema, record("repo.read"), ["grant", "id"]],
    [
      "grant.projectId",
      GrantRecordSchema,
      record("repo.read"),
      ["grant", "projectId"],
    ],
    [
      "grant.granteeAgentId",
      GrantRecordSchema,
      record("repo.read"),
      ["grant", "granteeAgentId"],
    ],
    [
      "grant.grantedByUserId",
      GrantRecordSchema,
      record("repo.read"),
      ["grant", "grantedByUserId"],
    ],
    // null is a valid ID here only together with a null revokedAt.
    [
      "grant.revokedByUserId",
      GrantRecordSchema,
      revoked,
      ["grant", "revokedByUserId"],
    ],
    [
      "grant.repositoryId",
      GrantRecordSchema,
      record("repo.read"),
      ["grant", "repositoryId"],
    ],
    [
      "grant.providerConnectionId",
      GrantRecordSchema,
      record("provider.use"),
      ["grant", "providerConnectionId"],
    ],
    [
      "facts.agent.id",
      GrantRecordSchema,
      record("repo.read"),
      ["facts", "agent", "id"],
    ],
    [
      "facts.agent.hostDeviceId",
      GrantRecordSchema,
      record("repo.read"),
      ["facts", "agent", "hostDeviceId"],
    ],
    [
      "facts.hostDevice.id",
      GrantRecordSchema,
      record("repo.read"),
      ["facts", "hostDevice", "id"],
    ],
    [
      "facts.project.id",
      GrantRecordSchema,
      record("repo.read"),
      ["facts", "project", "id"],
    ],
    [
      "facts.project.workspaceId",
      GrantRecordSchema,
      record("repo.read"),
      ["facts", "project", "workspaceId"],
    ],
    [
      "facts.grantorMembership.workspaceId",
      GrantRecordSchema,
      record("repo.read"),
      ["facts", "grantorMembership", "workspaceId"],
    ],
    [
      "facts.grantorMembership.userId",
      GrantRecordSchema,
      record("repo.read"),
      ["facts", "grantorMembership", "userId"],
    ],
    [
      "facts.providerConnection.id",
      GrantRecordSchema,
      record("provider.use"),
      ["facts", "providerConnection", "id"],
    ],
    [
      "facts.providerConnection.hostDeviceId",
      GrantRecordSchema,
      record("provider.use"),
      ["facts", "providerConnection", "hostDeviceId"],
    ],
    [
      "request.agentId",
      PermissionRequestSchema,
      request("repo.read"),
      ["agentId"],
    ],
    [
      "request.repositoryId",
      PermissionRequestSchema,
      request("repo.read"),
      ["repositoryId"],
    ],
    [
      "request.providerConnectionId",
      PermissionRequestSchema,
      request("provider.use"),
      ["providerConnectionId"],
    ],
  ];
  assert.equal(fields.length, 19);
  for (const [field, schema, base, path] of fields) {
    assert.equal(schema.safeParse(base).success, true, field);
    for (const [label, value] of values) {
      assert.equal(
        schema.safeParse(withValue(base, path, value)).success,
        false,
        `${field}: ${label}`,
      );
    }
  }
});

test("timestamps are UTC ISO 8601 strings with milliseconds", () => {
  const rejected: [label: string, value: unknown][] = [
    ["a Date object", new Date(LATER)],
    ["a number", Date.parse(LATER)],
    ["no milliseconds", "2026-10-28T11:30:00Z"],
    ["a +00:00 offset", "2026-10-28T11:30:00.007+00:00"],
    ["no Z", "2026-10-28T11:30:00.007"],
    ["February 30", "2026-02-30T11:30:00.007Z"],
    ["empty", ""],
    ["undefined", undefined],
  ];
  assert.equal(rejected.length, 8);
  const accepted = new Date(Date.parse(LATER)).toISOString();
  assert.equal(accepted, LATER);

  const fields: [label: string, base: Json, path: readonly string[]][] = [
    ["grant.createdAt", record("repo.read"), ["grant", "createdAt"]],
    ["grant.expiresAt", record("repo.read"), ["grant", "expiresAt"]],
    [
      "grant.revokedAt",
      record("repo.read", { revokedAt: CREATED_AT, revokedByUserId: USER_ID }),
      ["grant", "revokedAt"],
    ],
    [
      "facts.agent.disabledAt",
      record("repo.read"),
      ["facts", "agent", "disabledAt"],
    ],
    [
      "facts.hostDevice.revokedAt",
      record("repo.read"),
      ["facts", "hostDevice", "revokedAt"],
    ],
    [
      "facts.grantorMembership.removedAt",
      record("repo.read"),
      ["facts", "grantorMembership", "removedAt"],
    ],
    [
      "facts.providerConnection.removedAt",
      record("provider.use"),
      ["facts", "providerConnection", "removedAt"],
    ],
  ];
  assert.equal(fields.length, 7);
  for (const [field, base, path] of fields) {
    assert.equal(
      GrantRecordSchema.safeParse(withValue(base, path, accepted)).success,
      true,
      `${field}: toISOString()`,
    );
    // A lifecycle timestamp is null when it is not set, never missing.
    assert.equal(
      GrantRecordSchema.safeParse(withoutPath(base, path)).success,
      false,
      `${field}: missing`,
    );
    for (const [label, value] of rejected) {
      assert.equal(
        GrantRecordSchema.safeParse(withValue(base, path, value)).success,
        false,
        `${field}: ${label}`,
      );
    }
  }
});

test("revokedAt and revokedByUserId are set together, and expiresAt is after createdAt", () => {
  const cases: [label: string, fields: Json, message: string | null][] = [
    ["not revoked", {}, null],
    ["revoked by a user", { revokedAt: LATER, revokedByUserId: USER_ID }, null],
    ["revokedAt alone", { revokedAt: LATER }, REVOCATION_MESSAGE],
    ["revokedByUserId alone", { revokedByUserId: USER_ID }, REVOCATION_MESSAGE],
    [
      "expiresAt 1 ms after createdAt",
      { expiresAt: "2026-10-28T10:00:00.001Z" },
      null,
    ],
    ["expiresAt equal to createdAt", { expiresAt: CREATED_AT }, EXPIRY_MESSAGE],
    [
      "expiresAt before createdAt",
      { expiresAt: "2026-10-28T09:59:59.999Z" },
      EXPIRY_MESSAGE,
    ],
  ];
  assert.equal(cases.length, 7);
  for (const capability of CAPABILITIES) {
    for (const [label, fields, message] of cases) {
      const result = PermissionGrantSchema.safeParse(grant(capability, fields));
      if (message === null) {
        assert.equal(result.success, true, `${capability}: ${label}`);
      } else {
        assert.equal(result.success, false, `${capability}: ${label}`);
        // A fixed message that never includes the input.
        assert.deepEqual(
          result.error?.issues.map((issue) => issue.message),
          [message],
          `${capability}: ${label}`,
        );
      }
    }
  }
});

test("unknown, __proto__ and constructor keys are stripped, and the input is not mutated", () => {
  const plainGrant = grant("provider.use");
  const plainFacts = facts("provider.use");
  const plainRecord = { grant: plainGrant, facts: plainFacts };
  const plainRequest = request("provider.use");
  const factsInput = plainFacts as {
    agent: Json;
    hostDevice: Json;
    project: Json;
    grantorMembership: Json;
    providerConnection: Json;
  };
  const hostileRecord = deepFreeze(
    hostile({
      grant: hostile(plainGrant),
      facts: hostile({
        agent: hostile(factsInput.agent),
        hostDevice: hostile(factsInput.hostDevice),
        project: hostile(factsInput.project),
        grantorMembership: hostile(factsInput.grantorMembership),
        providerConnection: hostile(factsInput.providerConnection),
      }),
    }),
  );
  const hostileGrant = deepFreeze(hostile(plainGrant));
  const hostileRequest = deepFreeze(hostile(plainRequest));
  assert.equal(Object.hasOwn(hostileRecord, "__proto__"), true);
  assert.equal(Object.hasOwn(hostileRecord.grant as Json, "__proto__"), true);

  const cases: [
    label: string,
    schema: z.ZodType,
    input: Json,
    expected: Json,
  ][] = [
    ["PermissionGrantSchema", PermissionGrantSchema, hostileGrant, plainGrant],
    ["GrantRecordSchema", GrantRecordSchema, hostileRecord, plainRecord],
    [
      "PermissionRequestSchema",
      PermissionRequestSchema,
      hostileRequest,
      plainRequest,
    ],
  ];
  assert.equal(cases.length, 3);
  for (const [label, schema, input, expected] of cases) {
    const before = structuredClone(input);
    const result = schema.safeParse(input);
    assert.ok(result.success, label);
    assert.deepEqual(result.data, expected, label);
    assert.deepEqual(input, before, `${label}: input unchanged`);
    assert.notEqual(result.data, input, label);

    const levels: [string, unknown][] = [[label, result.data]];
    for (let index = 0; index < levels.length; index += 1) {
      const [path, value] = levels[index] as [string, unknown];
      if (typeof value !== "object" || value === null) {
        continue;
      }
      for (const key of ["__proto__", "constructor", "extra"]) {
        assert.equal(Object.hasOwn(value, key), false, `${path}.${key}`);
      }
      assert.equal(Object.getPrototypeOf(value), Object.prototype, path);
      for (const [key, child] of Object.entries(value)) {
        levels.push([`${path}.${key}`, child]);
      }
    }
  }
  assert.equal((Object.prototype as Json)["polluted"], undefined);
});

test("the JSON Schema export in input mode allows unknown keys and requires the lifecycle timestamps", () => {
  const schemas: [label: string, schema: z.ZodType][] = [
    ["PermissionGrantSchema", PermissionGrantSchema],
    ["GrantRecordSchema", GrantRecordSchema],
    ["PermissionRequestSchema", PermissionRequestSchema],
  ];
  assert.equal(schemas.length, 3);
  for (const [label, schema] of schemas) {
    const exported = z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io: "input",
    });
    // Input mode documents that unknown keys are accepted (and stripped).
    assert.equal(
      JSON.stringify(exported).includes('"additionalProperties":false'),
      false,
      label,
    );
    assert.doesNotThrow(() => z.toJSONSchema(schema), `${label} output mode`);
  }

  // Lifecycle timestamps can be null, but they are never optional.
  const grantSchema = z.toJSONSchema(PermissionGrantSchema, {
    target: "draft-2020-12",
    io: "input",
  });
  const options = (grantSchema.oneOf ?? []) as { required?: string[] }[];
  assert.equal(options.length, 2);
  for (const option of options) {
    for (const key of ["expiresAt", "revokedAt", "revokedByUserId"]) {
      assert.equal(option.required?.includes(key), true, key);
    }
  }
});

test("requests that mix or omit scopes do not compile and are rejected at runtime (checked by tsc)", () => {
  const agentId = AgentIdSchema.parse(AGENT_ID);
  const repositoryId = RepositoryIdSchema.parse(REPOSITORY_ID);
  const providerConnectionId = ProviderConnectionIdSchema.parse(
    PROVIDER_CONNECTION_ID,
  );
  // A capability whose type is not narrowed to one scope kind.
  const capability = "repo.read" as Capability;

  const compiles: PermissionRequest[] = [
    { agentId, capability: "repo.read", repositoryId },
    { agentId, capability: "provider.use", providerConnectionId },
  ];
  const rejectedByTsc: unknown[] = [
    {
      agentId,
      capability: "provider.use",
      // @ts-expect-error provider.use is not scoped to a repository.
      repositoryId,
    } satisfies PermissionRequest,
    {
      agentId,
      capability: "repo.read",
      // @ts-expect-error A repository capability is not scoped to a provider connection.
      providerConnectionId,
    } satisfies PermissionRequest,
    {
      agentId,
      capability: "provider.use",
      // @ts-expect-error A RepositoryId is not a ProviderConnectionId.
      providerConnectionId: repositoryId,
    } satisfies PermissionRequest,
    // @ts-expect-error repo.* is not a capability.
    { agentId, capability: "repo.*", repositoryId } satisfies PermissionRequest,
    // @ts-expect-error An unnarrowed capability cannot pick a scope.
    { agentId, capability, repositoryId } satisfies PermissionRequest,
    // @ts-expect-error A request names a scope.
    { agentId, capability: "repo.read" } satisfies PermissionRequest,
    {
      agentId,
      capability: "repo.read",
      repositoryId,
      // @ts-expect-error A request names one scope, not both.
      providerConnectionId,
    } satisfies PermissionRequest,
    {
      agentId,
      capability: "repo.read",
      // @ts-expect-error A plain string is not a RepositoryId.
      repositoryId: REPOSITORY_ID,
    } satisfies PermissionRequest,
  ];
  assert.equal(compiles.length, 2);
  assert.equal(rejectedByTsc.length, 8);

  const accepted: [label: string, value: Json][] = CAPABILITIES.map((name) => [
    name,
    request(name),
  ]);
  const rejected: [label: string, value: Json][] = CAPABILITIES.map((name) => [
    `${name} with the other scope kind`,
    {
      agentId: AGENT_ID,
      capability: name,
      [otherScopeKey(name)]: scopeId(name),
    },
  ]);
  assert.equal(accepted.length, 6);
  assert.equal(rejected.length, 6);
  for (const [label, value] of accepted) {
    const result = PermissionRequestSchema.safeParse(value);
    assert.ok(result.success, label);
    assert.deepEqual(result.data, value, label);
  }
  for (const [label, value] of rejected) {
    assert.equal(
      PermissionRequestSchema.safeParse(value).success,
      false,
      label,
    );
  }
});
