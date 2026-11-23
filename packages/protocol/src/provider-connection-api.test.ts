import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as z from "zod";
import { AGENT_ROUTE_ERRORS, AGENT_ROUTES } from "./agent-api.ts";
import { AUTH_ROUTES, routePath } from "./auth-api.ts";
import { CHAT_ROUTE_ERRORS } from "./chat-api.ts";
import { GRANT_ROUTE_ERRORS, GRANT_ROUTES } from "./grant-api.ts";
import { MEMBERSHIP_ROUTE_ERRORS } from "./membership-api.ts";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  type ApiErrorCode,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  PROVIDER_KINDS,
} from "./model.ts";
import { PROJECT_ROUTE_ERRORS } from "./project-api.ts";
import {
  PROVIDER_CONNECTION_COUNT_LIMITS,
  PROVIDER_CONNECTION_ROUTE_ERRORS,
  PROVIDER_CONNECTION_ROUTES,
  ProviderConnectionListResponseSchema,
  type ProviderConnectionRouteName,
  ProviderConnectionSchema,
  RegisterProviderConnectionRequestSchema,
  RegisterProviderConnectionResponseSchema,
} from "./provider-connection-api.ts";
import { REPOSITORY_ROUTE_ERRORS } from "./repository-api.ts";
import { RUN_ROUTE_ERRORS } from "./run-api.ts";

// The provider connections of a host device (#295).

const CONNECTION_ID = "0192f2a0-7c3e-7e00-8000-0000000000c1";
const OTHER_CONNECTION_ID = "0192f2a0-7c3e-7e00-8000-0000000000c2";
const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const USER_ID = "0192f2a0-7c3e-7f00-a000-000000000002";
const NOW = "2026-11-23T12:00:00.000Z";

/** The codes that every route can answer, as for the membership routes. */
const COMMON_CODES: readonly string[] = [
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
];

const connection = {
  id: CONNECTION_ID,
  kind: "claude",
  label: "Work account",
  createdAt: NOW,
};

/** Each route's codes beyond the common ones. */
function specificCodes(): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(PROVIDER_CONNECTION_ROUTE_ERRORS).map(([name, codes]) => [
      name,
      codes.filter((code) => !COMMON_CODES.includes(code)),
    ]),
  );
}

test("the provider connection routes are fixed, frozen, and name no device", () => {
  assert.deepEqual(
    Object.values(PROVIDER_CONNECTION_ROUTES).map(
      (route) => `${route.method} ${route.path}`,
    ),
    [
      "GET /provider-connections",
      "POST /provider-connections",
      "POST /provider-connections/:providerConnectionId/remove",
    ],
  );
  assert.equal(Object.isFrozen(PROVIDER_CONNECTION_ROUTES), true);
  for (const [name, route] of Object.entries(PROVIDER_CONNECTION_ROUTES)) {
    assert.equal(Object.isFrozen(route), true, name);
    assert.deepEqual(Object.keys(route).sort(), ["method", "path"]);
    assert.equal(route.path.includes("?"), false, `${name}: query`);
    // Only the calling device's connections: no path names a device, an
    // account, or a workspace.
    assert.doesNotMatch(route.path, /device|user|workspace/iu, name);
  }
  const parameters = Object.fromEntries(
    Object.entries(PROVIDER_CONNECTION_ROUTES).map(([name, route]) => [
      name,
      [...route.path.matchAll(/:([A-Za-z]+)/gu)].map((match) => match[1]),
    ]),
  );
  assert.deepEqual(parameters, {
    listProviderConnections: [],
    registerProviderConnection: [],
    removeProviderConnection: ["providerConnectionId"],
  });
  assert.equal(
    routePath(PROVIDER_CONNECTION_ROUTES.listProviderConnections.path),
    "/provider-connections",
  );
  assert.throws(
    () =>
      routePath(PROVIDER_CONNECTION_ROUTES.listProviderConnections.path, {
        deviceId: DEVICE_ID,
      }),
    TypeError,
  );
  const remove = PROVIDER_CONNECTION_ROUTES.removeProviderConnection.path;
  assert.equal(
    routePath(remove, { providerConnectionId: CONNECTION_ID }),
    `/provider-connections/${CONNECTION_ID}/remove`,
  );
  // A label, or anything else that is not an ID, never fills a path.
  for (const bad of ["Work account", CONNECTION_ID.toUpperCase(), ""]) {
    assert.throws(
      () => routePath(remove, { providerConnectionId: bad }),
      TypeError,
      JSON.stringify(bad),
    );
  }
  // Apart from the routes of the device and of the grant records.
  const others = new Set(
    [AUTH_ROUTES, GRANT_ROUTES, AGENT_ROUTES].flatMap((routes) =>
      Object.values(routes).map((route) => `${route.method} ${route.path}`),
    ),
  );
  for (const route of Object.values(PROVIDER_CONNECTION_ROUTES)) {
    assert.equal(others.has(`${route.method} ${route.path}`), false);
  }
});

test("each provider connection route answers the common codes and its own, and only a registration answers provider_connection_limit", () => {
  assert.deepEqual(
    Object.keys(PROVIDER_CONNECTION_ROUTE_ERRORS),
    Object.keys(PROVIDER_CONNECTION_ROUTES),
  );
  assert.equal(Object.isFrozen(PROVIDER_CONNECTION_ROUTE_ERRORS), true);
  const known = new Set<string>(API_ERROR_CODES);
  for (const [name, codes] of Object.entries(
    PROVIDER_CONNECTION_ROUTE_ERRORS,
  )) {
    assert.equal(Object.isFrozen(codes), true, name);
    assert.equal(new Set(codes).size, codes.length, `${name}: duplicates`);
    assert.deepEqual(codes.slice(0, COMMON_CODES.length), COMMON_CODES, name);
    for (const code of codes) {
      assert.equal(known.has(code), true, `${name}: ${code}`);
    }
  }
  assert.deepEqual(specificCodes(), {
    listProviderConnections: [],
    registerProviderConnection: ["provider_connection_limit"],
    removeProviderConnection: ["not_found", "conflict"],
  });
  // No role is involved: a device acts on its own connections only, and
  // another device's connection looks missing.
  for (const codes of Object.values(PROVIDER_CONNECTION_ROUTE_ERRORS)) {
    assert.equal(codes.includes("forbidden"), false);
  }
  // No time frees a place, so the status is a conflict and not a wait.
  assert.equal(API_ERROR_STATUS.provider_connection_limit, 409);
  // No route of another group answers it, and no provider connection route
  // answers the count limit code of another route.
  const otherGroups: Record<string, readonly ApiErrorCode[]>[] = [
    MEMBERSHIP_ROUTE_ERRORS,
    PROJECT_ROUTE_ERRORS,
    CHAT_ROUTE_ERRORS,
    AGENT_ROUTE_ERRORS,
    REPOSITORY_ROUTE_ERRORS,
    RUN_ROUTE_ERRORS,
    GRANT_ROUTE_ERRORS,
  ];
  for (const group of otherGroups) {
    for (const [name, codes] of Object.entries(group)) {
      assert.equal(codes.includes("provider_connection_limit"), false, name);
    }
  }
  for (const code of API_ERROR_CODES.filter((c) => c.endsWith("_limit"))) {
    for (const [name, codes] of Object.entries(
      PROVIDER_CONNECTION_ROUTE_ERRORS,
    )) {
      assert.equal(
        codes.includes(code),
        code === "provider_connection_limit" &&
          name === "registerProviderConnection",
        `${name}: ${code}`,
      );
    }
  }
});

test("the count limits are 10 connections per device and 20 registrations per account in 24 hours, frozen, and within one answer", () => {
  assert.deepEqual(PROVIDER_CONNECTION_COUNT_LIMITS, {
    activePerDevice: 10,
    perDay: 20,
  });
  assert.equal(Object.isFrozen(PROVIDER_CONNECTION_COUNT_LIMITS), true);
  assert.ok(
    PROVIDER_CONNECTION_COUNT_LIMITS.activePerDevice <= MAX_ANSWER_LIST_ITEMS,
  );
});

test("a registration takes a provider kind of the closed list and a label of single-line text from 1 to 64 characters, and nothing else", () => {
  const schema = RegisterProviderConnectionRequestSchema;
  assert.deepEqual(Object.keys(schema.shape), ["kind", "label"]);
  for (const kind of PROVIDER_KINDS) {
    for (const label of [
      "Work account",
      "a".repeat(LIMITS.providerConnectionLabel),
      "\u00C4rger",
      "Codex \u{1F680}",
      " Personal ",
      "me/claude",
    ]) {
      assert.deepEqual(
        schema.safeParse({ kind, label }).data,
        { kind, label },
        `${kind} ${label}`,
      );
    }
  }
  for (const [name, value] of [
    ["an unknown kind", { kind: "gemini", label: "Work" }],
    ["a kind in capitals", { kind: "Claude", label: "Work" }],
    ["a kind with a space", { kind: "claude ", label: "Work" }],
    ["no kind", { label: "Work" }],
    ["a null kind", { kind: null, label: "Work" }],
    ["an empty label", { kind: "claude", label: "" }],
    [
      "a label over 64",
      {
        kind: "claude",
        label: "a".repeat(LIMITS.providerConnectionLabel + 1),
      },
    ],
    ["a blank label", { kind: "claude", label: " \t " }],
    ["a line feed inside", { kind: "claude", label: "Wo\nrk" }],
    ["a line separator inside", { kind: "claude", label: "Wo\u2028rk" }],
    ["a byte order mark inside", { kind: "claude", label: "Wo\uFEFFrk" }],
    ["a control character", { kind: "claude", label: "Wo\u0000rk" }],
    ["a zero-width space", { kind: "claude", label: "Wo\u200Brk" }],
    ["a right-to-left override", { kind: "claude", label: "\u202Ekrow" }],
    ["no label", { kind: "claude" }],
    ["a number as the label", { kind: "claude", label: 7 }],
  ] as const) {
    assert.equal(schema.safeParse(value).success, false, name);
  }
  // No secret and nothing that identifies the provider account reaches the
  // server (#33), and the device, the ID, and the times are never the
  // caller's to choose: every other field is stripped.
  assert.deepEqual(
    schema.parse({
      kind: "codex",
      label: "Work",
      apiKey: "not-a-real-key",
      token: "secret-token",
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
      credential: { key: "secret" },
      secret: "secret",
      password: "secret",
      accountId: "acct_123",
      email: "someone",
      organizationId: "org_123",
      hostDeviceId: DEVICE_ID,
      userId: USER_ID,
      id: OTHER_CONNECTION_ID,
      createdAt: NOW,
      removedAt: NOW,
    }),
    { kind: "codex", label: "Work" },
  );
});

test("a connection shows its ID, kind, label, and registration time, and never a device, an account, or a secret", () => {
  assert.deepEqual(ProviderConnectionSchema.parse(connection), connection);
  assert.deepEqual(Object.keys(ProviderConnectionSchema.shape).sort(), [
    "createdAt",
    "id",
    "kind",
    "label",
  ]);
  // A field that a server could add is stripped.
  assert.deepEqual(
    ProviderConnectionSchema.parse({
      ...connection,
      hostDeviceId: DEVICE_ID,
      apiKey: "not-a-real-key",
      removedAt: null,
    }),
    connection,
  );
  for (const [name, value] of [
    ...Object.keys(connection).map((key): [string, unknown] => [
      `missing ${key}`,
      { ...connection, [key]: undefined },
    ]),
    ["an unknown kind", { ...connection, kind: "gemini" }],
    ["an ID that is not a UUIDv7", { ...connection, id: "not-an-id" }],
    ["a time without its zone", { ...connection, createdAt: "2026-11-23" }],
    ["an empty label", { ...connection, label: "" }],
    [
      "a label with a control character",
      { ...connection, label: "Wo\u0000rk" },
    ],
    [
      "a label over the limit",
      {
        ...connection,
        label: "a".repeat(LIMITS.providerConnectionLabel + 1),
      },
    ],
  ] as const) {
    assert.equal(
      ProviderConnectionSchema.safeParse(value).success,
      false,
      name,
    );
  }
  assert.deepEqual(
    RegisterProviderConnectionResponseSchema.parse({
      providerConnection: connection,
    }),
    { providerConnection: connection },
  );
  assert.equal(
    RegisterProviderConnectionResponseSchema.safeParse({}).success,
    false,
  );
});

test("the list holds each connection once, up to MAX_ANSWER_LIST_ITEMS", () => {
  const other = { ...connection, id: OTHER_CONNECTION_ID, kind: "codex" };
  assert.deepEqual(
    ProviderConnectionListResponseSchema.parse({
      providerConnections: [connection, other],
    }),
    { providerConnections: [connection, other] },
  );
  assert.equal(
    ProviderConnectionListResponseSchema.safeParse({ providerConnections: [] })
      .success,
    true,
  );
  assert.equal(
    ProviderConnectionListResponseSchema.safeParse({
      providerConnections: [connection, { ...connection, label: "Again" }],
    }).success,
    false,
  );
  const many = Array.from({ length: MAX_ANSWER_LIST_ITEMS + 1 }, (_, i) => ({
    ...connection,
    id: `0192f2a0-7c3e-7e00-8000-${i.toString(16).padStart(12, "0")}`,
  }));
  assert.equal(
    ProviderConnectionListResponseSchema.safeParse({
      providerConnections: many,
    }).success,
    false,
  );
  assert.equal(
    ProviderConnectionListResponseSchema.safeParse({
      providerConnections: many.slice(0, MAX_ANSWER_LIST_ITEMS),
    }).success,
    true,
  );
});

test("the schemas of each provider connection route export to JSON Schema for documentation", () => {
  const schemas = {
    listProviderConnections: [null, ProviderConnectionListResponseSchema],
    registerProviderConnection: [
      RegisterProviderConnectionRequestSchema,
      RegisterProviderConnectionResponseSchema,
    ],
    removeProviderConnection: [null, null],
  } satisfies Record<
    ProviderConnectionRouteName,
    [request: z.ZodType | null, response: z.ZodType | null]
  >;
  assert.deepEqual(
    Object.keys(schemas),
    Object.keys(PROVIDER_CONNECTION_ROUTES),
  );
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
});

test("the README's provider connection table lists every route with its codes", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section =
    readme
      .split(/^## /mu)
      .find((part) => part.startsWith("Provider connections\n")) ?? "";
  const rows = section
    .split("\n")
    .filter((line) => /^\| `(?:GET|POST) \//u.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  const names = new Map(
    Object.entries(PROVIDER_CONNECTION_ROUTES).map(([name, route]) => [
      `\`${route.method} ${route.path}\``,
      name,
    ]),
  );
  const table: Record<string, string[]> = {};
  for (const cells of rows) {
    assert.equal(cells.length, 7, cells[1]);
    const name = names.get(cells[1] ?? "");
    assert.ok(name, `${cells[1]} is not a provider connection route`);
    table[name] = [...(cells[5] ?? "").matchAll(/`([a-z_]+)`/gu)].map(
      (match) => match[1] ?? "",
    );
  }
  assert.deepEqual(Object.keys(table), Object.keys(PROVIDER_CONNECTION_ROUTES));
  assert.deepEqual(table, specificCodes());
});
