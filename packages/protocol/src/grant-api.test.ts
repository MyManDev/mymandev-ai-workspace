import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as z from "zod";
import { AGENT_ROUTES } from "./agent-api.ts";
import { AUTH_ROUTES, routePath } from "./auth-api.ts";
import { CHAT_ROUTES } from "./chat-api.ts";
import { decodeClientEvent, decodeEvent } from "./decode.ts";
import {
  APPROVER_EVENT_TYPES,
  EVENT_TYPES,
  isApproverEventType,
  SERVER_EVENT_AUDIENCES,
  SERVER_ONLY_EVENT_TYPES,
} from "./envelope.ts";
import { decodeClientMessage, decodeServerMessage } from "./frames.ts";
import {
  AgentGrantCreatedPayloadSchema,
  AgentGrantRevokedPayloadSchema,
  GRANT_COUNT_LIMITS,
  GRANT_LIFETIME_SECONDS,
  GRANT_ROUTE_ERRORS,
  GRANT_ROUTES,
  GrantCapabilityRequestSchema,
  GrantCapabilityResponseSchema,
  GrantRecordListResponseSchema,
  type GrantRouteName,
  WorkspaceGrantSchema,
} from "./grant-api.ts";
import { CAPABILITY_SCOPE } from "./grant-scope.ts";
import { MEMBERSHIP_ROUTES } from "./membership-api.ts";
import {
  API_ERROR_CODES,
  type ApiErrorCode,
  CAPABILITIES,
  type Capability,
  MAX_ANSWER_LIST_ITEMS,
} from "./model.ts";
import { PROJECT_ROUTES } from "./project-api.ts";

type Json = Record<string, unknown>;

const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OTHER_WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4";
const PROJECT_ID = "0192f2a0-7c3e-7e00-8000-000000000005";
const OTHER_PROJECT_ID = "0192f2a0-7c3e-7e00-8000-000000000015";
const EVENT_ID = "0192f2a0-7c3e-7e00-8000-000000000006";
const DEVICE_ID = "0192f2a0-7c3e-7e00-8000-000000000007";
const OTHER_DEVICE_ID = "0192f2a0-7c3e-7e00-8000-000000000017";
const AGENT_ID = "0192f2a0-7c3e-7e00-8000-000000000008";
const OTHER_AGENT_ID = "0192f2a0-7c3e-7e00-8000-000000000018";
const REPOSITORY_ID = "0192f2a0-7c3e-7c00-9000-000000000009";
const PROVIDER_CONNECTION_ID = "0192f2a0-7c3e-7c00-9000-00000000000a";
const USER_ID = "0192f2a0-7c3e-7f00-a000-000000000002";
const OTHER_USER_ID = "0192f2a0-7c3e-7f00-a000-000000000012";
const GRANT_ID = "0192f2a0-7c3e-7b00-8000-000000000001";
const NOW = "2026-11-14T12:00:00.000Z";
const LATER = "2026-11-14T13:00:00.000Z";

/** The codes that every grant route can answer, as every membership route can. */
const COMMON_CODES: readonly string[] = [
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
];

/** The codes of each route beyond the common ones, in their order. */
function specificCodes(): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(GRANT_ROUTE_ERRORS).map(([name, codes]) => [
      name,
      codes.filter((code) => !COMMON_CODES.includes(code)),
    ]),
  );
}

/** The scope field of a capability's kind, and the field of the other kind. */
function scopeKeys(capability: Capability): [own: string, other: string] {
  return CAPABILITY_SCOPE[capability] === "repository"
    ? ["repositoryId", "providerConnectionId"]
    : ["providerConnectionId", "repositoryId"];
}

function scopeId(key: string): string {
  return key === "repositoryId" ? REPOSITORY_ID : PROVIDER_CONNECTION_ID;
}

function without(value: Json, key: string): Json {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== key),
  );
}

/** The ID of grant number `index`. */
function grantId(index: number): string {
  return `0192f2a0-7c3e-7b00-8000-${index.toString(16).padStart(12, "0")}`;
}

/** The body of a grant: one capability, the scope of its kind, and a lifetime. */
function body(capability: Capability, fields: Json = {}): Json {
  const [own] = scopeKeys(capability);
  return {
    capability,
    [own]: scopeId(own),
    lifetimeSeconds: 3_600,
    ...fields,
  };
}

/** A whole grant, as its granting account sees it. */
function grant(capability: Capability, fields: Json = {}): Json {
  const [own] = scopeKeys(capability);
  return {
    id: GRANT_ID,
    projectId: PROJECT_ID,
    granteeAgentId: AGENT_ID,
    capability,
    [own]: scopeId(own),
    grantedByUserId: USER_ID,
    createdAt: NOW,
    expiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    ...fields,
  };
}

function facts(capability: Capability): Record<string, Json | null> {
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

/**
 * Grant record number `index`: a grant of `capability` with its facts.
 * `grantFields` change the grant, and `factFields` change single facts.
 */
function record(
  index: number,
  capability: Capability = "repo.read",
  grantFields: Json = {},
  factFields: Record<string, Json | null> = {},
): Json {
  const base = facts(capability);
  const changed = Object.fromEntries(
    Object.entries(factFields).map(([name, fields]) => [
      name,
      fields === null ? null : { ...base[name], ...fields },
    ]),
  );
  return {
    grant: grant(capability, { id: grantId(index), ...grantFields }),
    facts: { ...base, ...changed },
  };
}

/** A grant as the members of its workspace see it. */
function workspaceGrant(capability: Capability, fields: Json = {}): Json {
  return {
    id: GRANT_ID,
    projectId: PROJECT_ID,
    granteeAgentId: AGENT_ID,
    capability,
    ...(CAPABILITY_SCOPE[capability] === "repository"
      ? { repositoryId: REPOSITORY_ID }
      : {}),
    createdAt: NOW,
    expiresAt: null,
    ...fields,
  };
}

const revocation = {
  grantId: GRANT_ID,
  granteeAgentId: AGENT_ID,
  revokedAt: LATER,
};

function grantEvent(type: string, payload: Json): Json {
  return {
    protocolVersion: 0,
    id: EVENT_ID,
    type,
    occurredAt: LATER,
    workspaceId: WORKSPACE_ID,
    actor: { kind: "system" },
    deviceId: null,
    payload,
  };
}

function grantEvents(): Json[] {
  return [
    ...CAPABILITIES.map((capability) =>
      grantEvent("agent.grant.created", { grant: workspaceGrant(capability) }),
    ),
    grantEvent("agent.grant.created", {
      grant: workspaceGrant("terminal.execute", { expiresAt: LATER }),
    }),
    grantEvent("agent.grant.revoked", revocation),
  ];
}

/** The issues of a refused parse, as `[path, message]` pairs. */
function issues(result: {
  success: boolean;
  error?: z.ZodError;
}): [path: string, message: string][] {
  assert.equal(result.success, false);
  return (result.error?.issues ?? []).map((issue) => [
    issue.path.join("."),
    issue.message,
  ]);
}

/**
 * What a decoded grant event shows of the accounts, the host device, and
 * the provider connection that the tests pass in: their IDs anywhere in the
 * event, and the payload's field names that would carry them.
 */
function hiddenIn(event: { payload: unknown }): string[] {
  const sent = JSON.stringify(event);
  const names: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "object" && value !== null) {
      for (const [name, child] of Object.entries(value)) {
        names.push(name);
        collect(child);
      }
    }
  };
  collect(event.payload);
  return [
    ...[USER_ID, OTHER_USER_ID, DEVICE_ID, PROVIDER_CONNECTION_ID].filter(
      (id) => sent.includes(id),
    ),
    ...names.filter((name) => /user|member|device|connection/iu.test(name)),
  ];
}

test("the grant routes are fixed, frozen, and apart from the other routes", () => {
  const table = Object.values(GRANT_ROUTES).map(
    (route) => `${route.method} ${route.path}`,
  );
  assert.deepEqual(table, [
    "GET /grant-records",
    "POST /agents/:agentId/grants",
    "POST /agents/:agentId/grants/:grantId/revoke",
  ]);
  assert.equal(Object.isFrozen(GRANT_ROUTES), true);
  assert.equal(Object.isFrozen(GRANT_ROUTE_ERRORS), true);
  for (const [name, route] of Object.entries(GRANT_ROUTES)) {
    assert.equal(Object.isFrozen(route), true, name);
    assert.deepEqual(Object.keys(route).sort(), ["method", "path"]);
    assert.equal(route.path.includes("?"), false, `${name}: query`);
  }
  const groups = [
    AUTH_ROUTES,
    MEMBERSHIP_ROUTES,
    CHAT_ROUTES,
    AGENT_ROUTES,
    PROJECT_ROUTES,
  ];
  const others = new Set(
    groups.flatMap((routes) =>
      Object.values(routes).map((route) => `${route.method} ${route.path}`),
    ),
  );
  for (const entry of table) {
    assert.equal(others.has(entry), false, entry);
  }
  for (const name of Object.keys(GRANT_ROUTES)) {
    for (const routes of groups) {
      assert.equal(Object.hasOwn(routes, name), false, name);
    }
  }
});

test("a write names its agent and its grant by ID, and the list takes no parameter, so it names no device", () => {
  const parameters = Object.fromEntries(
    Object.entries(GRANT_ROUTES).map(([name, route]) => [
      name,
      [...route.path.matchAll(/:([A-Za-z]+)/gu)].map((match) => match[1]),
    ]),
  );
  assert.deepEqual(parameters, {
    listGrantRecords: [],
    grantCapability: ["agentId"],
    revokeGrant: ["agentId", "grantId"],
  });
  assert.equal(routePath(GRANT_ROUTES.listGrantRecords.path), "/grant-records");
  assert.throws(
    () =>
      routePath(GRANT_ROUTES.listGrantRecords.path, { deviceId: DEVICE_ID }),
    TypeError,
  );
  assert.equal(
    routePath(GRANT_ROUTES.grantCapability.path, { agentId: AGENT_ID }),
    `/agents/${AGENT_ID}/grants`,
  );
  const values = { agentId: AGENT_ID, grantId: GRANT_ID };
  assert.equal(
    routePath(GRANT_ROUTES.revokeGrant.path, values),
    `/agents/${AGENT_ID}/grants/${GRANT_ID}/revoke`,
  );
  for (const bad of ["not-a-uuid", GRANT_ID.toUpperCase(), ""]) {
    assert.throws(
      () =>
        routePath(GRANT_ROUTES.revokeGrant.path, { ...values, grantId: bad }),
      TypeError,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => routePath(GRANT_ROUTES.revokeGrant.path, { agentId: AGENT_ID }),
    TypeError,
  );
});

test("each grant route answers only known error codes, the common ones included, and no code of its own", () => {
  assert.deepEqual(Object.keys(GRANT_ROUTE_ERRORS), Object.keys(GRANT_ROUTES));
  const known = new Set<string>(API_ERROR_CODES);
  for (const [name, codes] of Object.entries(GRANT_ROUTE_ERRORS)) {
    assert.equal(Object.isFrozen(codes), true, name);
    assert.equal(new Set(codes).size, codes.length, `${name}: duplicates`);
    for (const code of codes) {
      assert.equal(known.has(code), true, `${name}: ${code}`);
    }
    for (const code of COMMON_CODES) {
      assert.equal(codes.includes(code as ApiErrorCode), true, name);
    }
  }
  assert.deepEqual(specificCodes(), {
    listGrantRecords: [],
    grantCapability: ["not_found", "forbidden", "conflict"],
    revokeGrant: ["not_found", "forbidden", "conflict"],
  });
  // A count limit of grants answers `conflict` for now (provisional, #75):
  // no grant route answers the count limit code of another route, and no
  // code exists for grants.
  const limitCodes = API_ERROR_CODES.filter((code) => code.endsWith("_limit"));
  assert.ok(limitCodes.includes("project_limit"));
  for (const code of limitCodes) {
    for (const [name, codes] of Object.entries(GRANT_ROUTE_ERRORS)) {
      assert.equal(codes.includes(code), false, `${name}: ${code}`);
    }
  }
  assert.deepEqual(
    API_ERROR_CODES.filter((code) => /grant/u.test(code)),
    [],
  );
});

test("the README's grant route table lists every grant route with its codes", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section =
    readme
      .split(/^## /mu)
      .find((part) => part.startsWith("Grant routes and events\n")) ?? "";
  const rows = section
    .split("\n")
    .filter((line) => /^\| `(?:GET|POST) \//u.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  const names = new Map(
    Object.entries(GRANT_ROUTES).map(([name, route]) => [
      `\`${route.method} ${route.path}\``,
      name,
    ]),
  );
  const table: Record<string, string[]> = {};
  for (const cells of rows) {
    assert.equal(cells.length, 7, cells[1]);
    const name = names.get(cells[1] ?? "");
    assert.ok(name, `${cells[1]} is not a grant route`);
    table[name] = [...(cells[5] ?? "").matchAll(/`([a-z_]+)`/gu)].map(
      (match) => match[1] ?? "",
    );
  }
  assert.deepEqual(Object.keys(table), Object.keys(GRANT_ROUTES));
  assert.deepEqual(table, specificCodes());
  // The documentation says that the records are read from one snapshot.
  assert.equal(
    section.includes(
      "- The records of one answer are read from one snapshot (one statement, or a REPEATABLE READ transaction), so the answer is one consistent read (P-76).",
    ),
    true,
  );
});

test("a lifetime is 1 minute to 365 days, and the count limits keep the record list whole", () => {
  assert.deepEqual(GRANT_LIFETIME_SECONDS, { min: 60, max: 31_536_000 });
  assert.equal(GRANT_LIFETIME_SECONDS.max, 365 * 24 * 60 * 60);
  assert.deepEqual(GRANT_COUNT_LIMITS, { perAgent: 100, perHostDevice: 1_000 });
  // Every grant of a device that is not revoked fits in one answer.
  assert.equal(GRANT_COUNT_LIMITS.perHostDevice, MAX_ANSWER_LIST_ITEMS);
  assert.ok(GRANT_COUNT_LIMITS.perAgent <= GRANT_COUNT_LIMITS.perHostDevice);
  assert.equal(Object.isFrozen(GRANT_LIFETIME_SECONDS), true);
  assert.equal(Object.isFrozen(GRANT_COUNT_LIMITS), true);
});

test("a grant takes one capability, exactly the scope of its kind, and a lifetime or an explicit null", () => {
  for (const capability of CAPABILITIES) {
    const [own, other] = scopeKeys(capability);
    for (const lifetimeSeconds of [null, 60, 3_600, 31_536_000]) {
      const input = body(capability, { lifetimeSeconds });
      assert.deepEqual(
        GrantCapabilityRequestSchema.safeParse(input).data,
        input,
        `${capability} for ${lifetimeSeconds}`,
      );
    }
    for (const [label, input] of [
      [
        "only the scope of the other kind",
        { ...without(body(capability), own), [other]: scopeId(other) },
      ],
      ["no scope", without(body(capability), own)],
      ["a null scope", body(capability, { [own]: null })],
      ["a scope that is not an ID", body(capability, { [own]: "main" })],
      [
        "an uppercase scope ID",
        body(capability, { [own]: scopeId(own).toUpperCase() }),
      ],
      ["a list of scopes", body(capability, { [own]: [scopeId(own)] })],
      ["no lifetime", without(body(capability), "lifetimeSeconds")],
      [
        "an undefined lifetime",
        body(capability, { lifetimeSeconds: undefined }),
      ],
      ["a lifetime under a minute", body(capability, { lifetimeSeconds: 59 })],
      ["a lifetime of zero", body(capability, { lifetimeSeconds: 0 })],
      ["a negative lifetime", body(capability, { lifetimeSeconds: -3_600 })],
      [
        "a lifetime over 365 days",
        body(capability, { lifetimeSeconds: 31_536_001 }),
      ],
      [
        "a lifetime with a fraction",
        body(capability, { lifetimeSeconds: 3_600.5 }),
      ],
      ["a lifetime as text", body(capability, { lifetimeSeconds: "3600" })],
      ["an infinite lifetime", body(capability, { lifetimeSeconds: Infinity })],
      [
        "a lifetime that is not a number",
        body(capability, { lifetimeSeconds: NaN }),
      ],
      [
        "an expiry time instead of a lifetime",
        { ...without(body(capability), "lifetimeSeconds"), expiresAt: LATER },
      ],
    ] as const) {
      assert.equal(
        GrantCapabilityRequestSchema.safeParse(input).success,
        false,
        `${capability}: ${label}`,
      );
    }
  }
  for (const capability of [
    "repo.*",
    "*",
    "repo",
    "Repo.Read",
    "repo.read,repo.write",
    ["repo.read", "repo.write"],
    "",
    null,
    undefined,
  ]) {
    for (const key of ["repositoryId", "providerConnectionId"]) {
      assert.equal(
        GrantCapabilityRequestSchema.safeParse({
          capability,
          [key]: scopeId(key),
          lifetimeSeconds: null,
        }).success,
        false,
        `${JSON.stringify(capability)} with ${key}`,
      );
    }
  }
  for (const input of [null, undefined, [], "repo.read", 7]) {
    assert.equal(GrantCapabilityRequestSchema.safeParse(input).success, false);
  }
});

test("no capability requires an expiry, terminal.execute included, but a grant without one says so (provisional, ADR 0015 P-71)", () => {
  for (const capability of CAPABILITIES) {
    assert.deepEqual(
      GrantCapabilityRequestSchema.parse(
        body(capability, { lifetimeSeconds: null }),
      ),
      body(capability, { lifetimeSeconds: null }),
      capability,
    );
    assert.equal(
      GrantCapabilityRequestSchema.safeParse(
        without(body(capability), "lifetimeSeconds"),
      ).success,
      false,
      capability,
    );
  }
});

test("unknown fields of a grant are stripped: a body with both scopes keeps its own, and a client sets nothing else", () => {
  for (const capability of CAPABILITIES) {
    const [own, other] = scopeKeys(capability);
    const input = {
      ...body(capability),
      [other]: scopeId(other),
      id: GRANT_ID,
      agentId: OTHER_AGENT_ID,
      granteeAgentId: OTHER_AGENT_ID,
      projectId: OTHER_PROJECT_ID,
      hostDeviceId: OTHER_DEVICE_ID,
      grantedByUserId: OTHER_USER_ID,
      createdAt: NOW,
      expiresAt: null,
      revokedAt: null,
      revokedByUserId: null,
      capabilities: [...CAPABILITIES],
    };
    const copy = structuredClone(input);
    const parsed = GrantCapabilityRequestSchema.parse(input);
    assert.deepEqual(parsed, body(capability), capability);
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["capability", "lifetimeSeconds", own].sort(),
      capability,
    );
    assert.deepEqual(input, copy, "the input is not changed");
  }
});

test("the answer of a grant is the whole new grant, which is not revoked", () => {
  for (const capability of CAPABILITIES) {
    for (const fields of [{}, { expiresAt: LATER }]) {
      const answer = { grant: grant(capability, fields) };
      assert.deepEqual(
        GrantCapabilityResponseSchema.parse(answer),
        answer,
        capability,
      );
    }
  }
  assert.deepEqual(
    issues(
      GrantCapabilityResponseSchema.safeParse({
        grant: grant("repo.read", {
          revokedAt: LATER,
          revokedByUserId: USER_ID,
        }),
      }),
    ),
    [["grant.revokedAt", "A new grant is not revoked"]],
  );
  for (const [label, value] of [
    ["no grant", {}],
    ["a grant as members see it", { grant: workspaceGrant("repo.read") }],
    [
      "a grant without its account",
      { grant: without(grant("repo.read"), "grantedByUserId") },
    ],
    [
      "a grant with both revocation fields apart",
      { grant: grant("repo.read", { revokedAt: LATER }) },
    ],
    [
      "a grant that expires when it is created",
      { grant: grant("repo.read", { expiresAt: NOW }) },
    ],
    [
      "a grant on the scope of the other kind",
      {
        grant: {
          ...without(grant("repo.read"), "repositoryId"),
          providerConnectionId: PROVIDER_CONNECTION_ID,
        },
      },
    ],
    ["a list of grants", { grant: [grant("repo.read")] }],
  ] as const) {
    assert.equal(
      GrantCapabilityResponseSchema.safeParse(value).success,
      false,
      label,
    );
  }
});

test("the record list holds whole grant records of one device and one account, each grant once and none revoked", () => {
  assert.deepEqual(GrantRecordListResponseSchema.parse({ records: [] }), {
    records: [],
  });
  const each = CAPABILITIES.map((capability, index) =>
    record(index + 1, capability),
  );
  assert.deepEqual(GrantRecordListResponseSchema.parse({ records: each }), {
    records: each,
  });
  // Each record is the grant and the five facts that `hasGrant` takes.
  for (const entry of GrantRecordListResponseSchema.parse({ records: each })
    .records) {
    assert.deepEqual(Object.keys(entry), ["grant", "facts"]);
    assert.deepEqual(Object.keys(entry.facts), [
      "agent",
      "hostDevice",
      "project",
      "grantorMembership",
      "providerConnection",
    ]);
  }

  // What decides whether a grant is active is not the schema's to judge:
  // such records are listed, and `isGrantActive` denies them.
  const listed: [label: string, records: Json[]][] = [
    [
      "an expired grant",
      [
        record(1, "repo.read", {
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-02T00:00:00.000Z",
        }),
      ],
    ],
    [
      "a disabled agent",
      [record(1, "repo.read", {}, { agent: { disabledAt: NOW } })],
    ],
    [
      "a revoked host device",
      [record(1, "repo.read", {}, { hostDevice: { revokedAt: NOW } })],
    ],
    [
      "a removed membership",
      [record(1, "repo.read", {}, { grantorMembership: { removedAt: NOW } })],
    ],
    [
      "no membership",
      [record(1, "repo.read", {}, { grantorMembership: null })],
    ],
    [
      "a removed provider connection",
      [
        record(
          1,
          "provider.use",
          {},
          { providerConnection: { removedAt: NOW } },
        ),
      ],
    ],
    [
      "agents of two projects in two workspaces",
      [
        record(1),
        record(
          2,
          "git.push",
          { granteeAgentId: OTHER_AGENT_ID, projectId: OTHER_PROJECT_ID },
          {
            agent: { id: OTHER_AGENT_ID },
            project: { id: OTHER_PROJECT_ID, workspaceId: OTHER_WORKSPACE_ID },
            grantorMembership: { workspaceId: OTHER_WORKSPACE_ID },
          },
        ),
      ],
    ],
    [
      "the same capability and scope twice, as two grants",
      [record(1, "repo.write"), record(2, "repo.write")],
    ],
  ];
  for (const [label, records] of listed) {
    assert.deepEqual(
      GrantRecordListResponseSchema.safeParse({ records }).data,
      { records },
      label,
    );
  }

  const refused: [label: string, records: Json[], issue: [string, string]][] = [
    [
      "a grant listed twice",
      [record(1), record(2), record(1, "git.commit")],
      ["records.2.grant.id", "A grant is listed once"],
    ],
    [
      "a revoked grant",
      [
        record(1),
        record(2, "repo.read", { revokedAt: LATER, revokedByUserId: USER_ID }),
      ],
      ["records.1.grant.revokedAt", "A listed grant is not revoked"],
    ],
    [
      "an agent on another device",
      [
        record(1),
        record(
          2,
          "repo.read",
          {},
          {
            agent: { hostDeviceId: OTHER_DEVICE_ID },
            hostDevice: { id: OTHER_DEVICE_ID },
          },
        ),
      ],
      ["records.1.facts", "Every record belongs to one host device"],
    ],
    [
      "an agent fact of another device alone",
      [
        record(1),
        record(
          2,
          "repo.read",
          {},
          { agent: { hostDeviceId: OTHER_DEVICE_ID } },
        ),
      ],
      ["records.1.facts", "Every record belongs to one host device"],
    ],
    [
      "a host device fact of another device",
      [
        record(1),
        record(2, "repo.read", {}, { hostDevice: { id: OTHER_DEVICE_ID } }),
      ],
      ["records.1.facts", "Every record belongs to one host device"],
    ],
    [
      "a host device fact of another device in the first record",
      [record(1, "repo.read", {}, { hostDevice: { id: OTHER_DEVICE_ID } })],
      ["records.0.facts", "Every record belongs to one host device"],
    ],
    [
      "a provider connection on another device",
      [
        record(1),
        record(
          2,
          "provider.use",
          {},
          { providerConnection: { hostDeviceId: OTHER_DEVICE_ID } },
        ),
      ],
      ["records.1.facts", "Every record belongs to one host device"],
    ],
    [
      "a grant by another account",
      [
        record(1),
        record(
          2,
          "repo.read",
          { grantedByUserId: OTHER_USER_ID },
          { grantorMembership: { userId: OTHER_USER_ID } },
        ),
      ],
      ["records.1.grant.grantedByUserId", "Every record names one account"],
    ],
    [
      "a grant by another account, without a membership",
      [
        record(1),
        record(
          2,
          "repo.read",
          { grantedByUserId: OTHER_USER_ID },
          { grantorMembership: null },
        ),
      ],
      ["records.1.grant.grantedByUserId", "Every record names one account"],
    ],
    [
      "a membership of another account",
      [
        record(1),
        record(
          2,
          "repo.read",
          {},
          { grantorMembership: { userId: OTHER_USER_ID } },
        ),
      ],
      ["records.1.grant.grantedByUserId", "Every record names one account"],
    ],
    [
      "a membership of another account in the first record",
      [
        record(
          1,
          "repo.read",
          {},
          { grantorMembership: { userId: OTHER_USER_ID } },
        ),
      ],
      ["records.0.grant.grantedByUserId", "Every record names one account"],
    ],
  ];
  for (const [label, records, issue] of refused) {
    assert.deepEqual(
      issues(GrantRecordListResponseSchema.safeParse({ records })),
      [issue],
      label,
    );
  }

  for (const [label, value] of [
    ["no list", {}],
    ["a list that is not an array", { records: record(1) }],
    ["a grant without facts", { records: [{ grant: grant("repo.read") }] }],
    ["facts without a grant", { records: [{ facts: facts("repo.read") }] }],
    [
      "a grant as members see it",
      {
        records: [
          { grant: workspaceGrant("repo.read"), facts: facts("repo.read") },
        ],
      },
    ],
    [
      "a record without the host device fact",
      {
        records: [
          {
            grant: grant("repo.read"),
            facts: without(facts("repo.read"), "hostDevice"),
          },
        ],
      },
    ],
    ["a hole", { records: [record(1), null] }],
  ] as const) {
    assert.equal(
      GrantRecordListResponseSchema.safeParse(value).success,
      false,
      label,
    );
  }
});

test(`the record list holds at most MAX_ANSWER_LIST_ITEMS (${MAX_ANSWER_LIST_ITEMS}) records, as many as a device may hold`, () => {
  const full = Array.from({ length: MAX_ANSWER_LIST_ITEMS }, (_, index) =>
    record(index + 1),
  );
  assert.equal(full.length, GRANT_COUNT_LIMITS.perHostDevice);
  assert.equal(
    GrantRecordListResponseSchema.safeParse({ records: full }).success,
    true,
  );
  assert.equal(
    GrantRecordListResponseSchema.safeParse({
      records: [...full, record(MAX_ANSWER_LIST_ITEMS + 1)],
    }).success,
    false,
  );
});

test("the grant schemas of each route export to JSON Schema", () => {
  const schemas = {
    listGrantRecords: [null, GrantRecordListResponseSchema],
    grantCapability: [
      GrantCapabilityRequestSchema,
      GrantCapabilityResponseSchema,
    ],
    revokeGrant: [null, null],
  } satisfies Record<
    GrantRouteName,
    [request: z.ZodType | null, response: z.ZodType | null]
  >;
  assert.deepEqual(Object.keys(schemas), Object.keys(GRANT_ROUTES));
  for (const [name, pair] of Object.entries(schemas)) {
    for (const schema of pair) {
      if (schema !== null) {
        assert.equal(
          typeof z.toJSONSchema(schema, { io: "input" }),
          "object",
          name,
        );
      }
    }
  }
  for (const schema of [
    WorkspaceGrantSchema,
    AgentGrantCreatedPayloadSchema,
    AgentGrantRevokedPayloadSchema,
  ]) {
    assert.equal(typeof z.toJSONSchema(schema, { io: "input" }), "object");
  }
});

test("grant events come only from the server, with a system actor and no device", () => {
  for (const event of grantEvents()) {
    const label = String(event["type"]);
    assert.deepEqual(decodeEvent(event), { ok: true, event }, label);
    assert.deepEqual(
      decodeServerMessage(event),
      { ok: true, kind: "event", event },
      `${label} reaches a device`,
    );
    assert.equal(
      (SERVER_ONLY_EVENT_TYPES as readonly string[]).includes(label),
      true,
      label,
    );
    assert.deepEqual(
      decodeEvent({ ...event, actor: { kind: "user", userId: USER_ID } }),
      { ok: false, code: "invalid_actor" },
      `${label} from a user`,
    );
    assert.deepEqual(
      decodeEvent({ ...event, actor: { kind: "agent", agentId: AGENT_ID } }),
      { ok: false, code: "invalid_actor" },
      `${label} from the agent`,
    );
    assert.deepEqual(
      decodeEvent({ ...event, deviceId: DEVICE_ID }),
      { ok: false, code: "invalid_actor" },
      `${label} with a device`,
    );
    assert.deepEqual(
      decodeClientEvent(event),
      { ok: false, code: "not_allowed_from_device" },
      `${label} sent by a device`,
    );
    assert.deepEqual(
      decodeClientMessage(event),
      { ok: false, code: "not_allowed_from_device" },
      `${label} sent by a device after authentication`,
    );
    assert.equal(
      decodeClientEvent({
        ...event,
        actor: { kind: "user", userId: USER_ID },
        deviceId: DEVICE_ID,
      }).ok,
      false,
      `${label} forged by a device`,
    );
  }
});

test("the grant events are in the audience map, for every subscribed connection of the workspace (checked by tsc)", () => {
  const types = ["agent.grant.created", "agent.grant.revoked"] as const;
  assert.deepEqual(
    EVENT_TYPES.filter((type) => type.startsWith("agent.grant.")),
    types,
  );
  assert.deepEqual(
    Object.keys(SERVER_EVENT_AUDIENCES).filter((type) =>
      type.startsWith("agent.grant."),
    ),
    types,
  );
  for (const type of types) {
    assert.equal(Object.hasOwn(SERVER_EVENT_AUDIENCES, type), true, type);
    assert.equal(SERVER_EVENT_AUDIENCES[type], "members", type);
    assert.equal(isApproverEventType(type), false, type);
    assert.equal(
      (APPROVER_EVENT_TYPES as readonly string[]).includes(type),
      false,
      type,
    );
  }
  const created: "members" = SERVER_EVENT_AUDIENCES["agent.grant.created"];
  // @ts-expect-error A grant event goes to every member, not only the approvers.
  const revoked: "approvers" = SERVER_EVENT_AUDIENCES["agent.grant.revoked"];
  assert.deepEqual([created, revoked], ["members", "members"]);
});

test("a grant event names no account and no device data, whatever the server passes in", () => {
  for (const capability of CAPABILITIES) {
    // The whole grant with everything that a record knows about it.
    const decoded = decodeEvent(
      grantEvent("agent.grant.created", {
        grant: {
          ...grant(capability, {
            revokedAt: LATER,
            revokedByUserId: OTHER_USER_ID,
          }),
          repositoryId: REPOSITORY_ID,
          providerConnectionId: PROVIDER_CONNECTION_ID,
          hostDeviceId: DEVICE_ID,
          ownerUserId: USER_ID,
        },
        facts: facts(capability),
        grantedByUserId: USER_ID,
      }),
    );
    assert.ok(decoded.ok && decoded.event.type === "agent.grant.created");
    assert.deepEqual(Object.keys(decoded.event.payload), ["grant"]);
    assert.deepEqual(
      decoded.event.payload.grant,
      workspaceGrant(capability),
      capability,
    );
    assert.deepEqual(
      Object.keys(decoded.event.payload.grant).sort(),
      CAPABILITY_SCOPE[capability] === "repository"
        ? [
            "capability",
            "createdAt",
            "expiresAt",
            "granteeAgentId",
            "id",
            "projectId",
            "repositoryId",
          ]
        : [
            "capability",
            "createdAt",
            "expiresAt",
            "granteeAgentId",
            "id",
            "projectId",
          ],
      capability,
    );
    assert.deepEqual(hiddenIn(decoded.event), [], capability);
  }

  const decoded = decodeEvent(
    grantEvent("agent.grant.revoked", {
      ...revocation,
      revokedByUserId: OTHER_USER_ID,
      revokedByMemberId: OTHER_USER_ID,
      grantedByUserId: USER_ID,
      hostDeviceId: DEVICE_ID,
      providerConnectionId: PROVIDER_CONNECTION_ID,
      reason: "device_revoked",
    }),
  );
  assert.ok(decoded.ok && decoded.event.type === "agent.grant.revoked");
  assert.deepEqual(decoded.event.payload, revocation);
  assert.deepEqual(Object.keys(decoded.event.payload).sort(), [
    "grantId",
    "granteeAgentId",
    "revokedAt",
  ]);
  assert.deepEqual(hiddenIn(decoded.event), []);
});

test("a revocation event reports exactly one grant, so a cascade sends one event for each grant", () => {
  assert.deepEqual(
    AgentGrantRevokedPayloadSchema.parse(revocation),
    revocation,
  );
  for (const [label, payload] of [
    [
      "a list of grants",
      { ...without(revocation, "grantId"), grantIds: [GRANT_ID, grantId(2)] },
    ],
    ["a list as the grant", { ...revocation, grantId: [GRANT_ID, grantId(2)] }],
    ["an agent without a grant", without(revocation, "grantId")],
    ["a grant without its agent", without(revocation, "granteeAgentId")],
    ["a grant without the time", without(revocation, "revokedAt")],
    ["a null time", { ...revocation, revokedAt: null }],
    [
      "a time without milliseconds",
      { ...revocation, revokedAt: "2026-11-14T13:00:00Z" },
    ],
    ["a grant that is not an ID", { ...revocation, grantId: "all" }],
    ["a wildcard", { ...revocation, grantId: "*" }],
  ] as const) {
    assert.equal(
      AgentGrantRevokedPayloadSchema.safeParse(payload).success,
      false,
      label,
    );
    assert.deepEqual(
      decodeEvent(grantEvent("agent.grant.revoked", payload)),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
});

test("a created grant event checks the grant: one capability, the repository of a repository grant, and an expiry after its creation", () => {
  for (const capability of CAPABILITIES) {
    for (const fields of [{}, { expiresAt: LATER }]) {
      const input = workspaceGrant(capability, fields);
      assert.deepEqual(WorkspaceGrantSchema.parse(input), input, capability);
    }
  }
  const cases: [label: string, grant: Json][] = [
    [
      "a repository grant without its repository",
      without(workspaceGrant("repo.read"), "repositoryId"),
    ],
    [
      "a repository grant with a null repository",
      workspaceGrant("repo.read", { repositoryId: null }),
    ],
    [
      "a wildcard capability",
      workspaceGrant("repo.read", { capability: "repo.*" }),
    ],
    [
      "a list of capabilities",
      workspaceGrant("repo.read", { capability: ["repo.read", "repo.write"] }),
    ],
    [
      "an expiry at the creation",
      workspaceGrant("terminal.execute", { expiresAt: NOW }),
    ],
    [
      "an expiry before the creation",
      workspaceGrant("provider.use", { expiresAt: "2026-11-14T11:59:59.999Z" }),
    ],
    ["a missing expiry", without(workspaceGrant("repo.read"), "expiresAt")],
    [
      "a missing creation time",
      without(workspaceGrant("repo.read"), "createdAt"),
    ],
    ["a missing agent", without(workspaceGrant("repo.read"), "granteeAgentId")],
    ["a missing project", without(workspaceGrant("repo.read"), "projectId")],
    [
      "a grant that is not an ID",
      workspaceGrant("repo.read", { id: "grant-1" }),
    ],
  ];
  for (const [label, input] of cases) {
    assert.equal(WorkspaceGrantSchema.safeParse(input).success, false, label);
    assert.deepEqual(
      decodeEvent(grantEvent("agent.grant.created", { grant: input })),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
  for (const [label, payload] of [
    ["no grant", {}],
    ["a list of grants", { grants: [workspaceGrant("repo.read")] }],
    ["a list as the grant", { grant: [workspaceGrant("repo.read")] }],
  ] as const) {
    assert.deepEqual(
      decodeEvent(grantEvent("agent.grant.created", payload)),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
});
