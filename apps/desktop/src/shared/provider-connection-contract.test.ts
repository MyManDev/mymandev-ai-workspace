import { expect, test } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "./ipc-channels.ts";
import {
  EVENT_CONTRACT,
  INVOKE_CONTRACT,
  PROVIDER_CONNECTION_LIMITS,
  PROVIDER_CONNECTION_LIST_PROBLEMS,
  PROVIDER_CONNECTION_STATUSES,
  ProviderConnectionListViewSchema,
  REGISTER_PROVIDER_CONNECTION_REFUSALS,
  REMOVE_PROVIDER_CONNECTION_REFUSALS,
  RegisterProviderConnectionResultSchema,
  RemoveProviderConnectionResultSchema,
} from "./ipc-contract.ts";

// The contract of this device's AI provider connections (#32): metadata
// and a status cross, never a credential.

const CONNECTION = "0192f0a0-7b3c-7d4e-8f50-000000000101";
const AT = "2026-11-24T09:00:00.000Z";
const ITEM = {
  id: CONNECTION,
  kind: "claude",
  label: "Work laptop",
  createdAt: AT,
  status: "registered",
};

test("the provider connection channels have their own names and schemas", () => {
  expect(INVOKE_CHANNELS.getProviderConnections).toBe(
    "provider-connections:get-state",
  );
  expect(INVOKE_CHANNELS.subscribeProviderConnections).toBe(
    "provider-connections:subscribe-state",
  );
  expect(INVOKE_CHANNELS.registerProviderConnection).toBe(
    "provider-connections:register",
  );
  expect(INVOKE_CHANNELS.removeProviderConnection).toBe(
    "provider-connections:remove",
  );
  expect(EVENT_CHANNELS.providerConnectionsChanged).toBe(
    "provider-connections:state-changed",
  );
  expect(EVENT_CONTRACT[EVENT_CHANNELS.providerConnectionsChanged]).toBe(
    ProviderConnectionListViewSchema,
  );
  for (const channel of [
    INVOKE_CHANNELS.getProviderConnections,
    INVOKE_CHANNELS.subscribeProviderConnections,
  ]) {
    expect(INVOKE_CONTRACT[channel].result).toBe(
      ProviderConnectionListViewSchema,
    );
  }
});

test("a registration takes one strict object of a known kind and a label of 1 to 64 characters, and no other key", () => {
  const { args } = INVOKE_CONTRACT[INVOKE_CHANNELS.registerProviderConnection];
  const longest = "\u{1F600}".repeat(PROVIDER_CONNECTION_LIMITS.label);
  for (const request of [
    { kind: "claude", label: "Work" },
    { kind: "codex", label: " Personal " },
    { kind: "claude", label: longest },
  ]) {
    expect(args.parse([request])).toEqual([request]);
  }
  for (const value of [
    [],
    [{ kind: "claude" }],
    [{ label: "Work" }],
    [{ kind: "gemini", label: "Work" }],
    [{ kind: "claude", label: "" }],
    [{ kind: "claude", label: `${longest}x` }],
    [{ kind: "claude", label: 7 }],
    [{ kind: "claude", label: "Work", apiKey: "sk-ant-secret" }],
    [{ kind: "claude", label: "Work", credential: "secret" }],
    [{ kind: "claude", label: "Work", deviceId: CONNECTION }],
    [
      { kind: "claude", label: "Work" },
      { kind: "claude", label: "Work" },
    ],
    ["claude", "Work"],
    [null],
  ]) {
    expect(
      args.safeParse(value).success,
      JSON.stringify(value)?.slice(0, 80),
    ).toBe(false);
  }
});

test("a removal takes exactly one lowercase UUIDv7", () => {
  const { args } = INVOKE_CONTRACT[INVOKE_CHANNELS.removeProviderConnection];
  expect(args.parse([CONNECTION])).toEqual([CONNECTION]);
  for (const value of [
    [],
    [CONNECTION.toUpperCase()],
    ["0192f0a0-7b3c-4d4e-8f50-000000000101"],
    [CONNECTION, CONNECTION],
    [{ id: CONNECTION }],
  ]) {
    expect(args.safeParse(value).success, JSON.stringify(value)).toBe(false);
  }
});

test("a list view holds the ID, kind, label, time, and status of each connection, and a problem only while unavailable", () => {
  for (const status of ["signed_out", "loading", "ready"] as const) {
    expect(
      ProviderConnectionListViewSchema.parse({
        revision: 1,
        status,
        connections: [ITEM],
      }),
    ).toEqual({ revision: 1, status, connections: [ITEM] });
  }
  for (const problem of PROVIDER_CONNECTION_LIST_PROBLEMS) {
    for (const itemStatus of PROVIDER_CONNECTION_STATUSES) {
      expect(
        ProviderConnectionListViewSchema.safeParse({
          revision: 2,
          status: "unavailable",
          problem,
          connections: [{ ...ITEM, status: itemStatus }],
        }).success,
      ).toBe(true);
    }
  }
  // Unknown keys are dropped at every level: no credential or device crosses.
  expect(
    ProviderConnectionListViewSchema.parse({
      revision: 1,
      status: "ready",
      connections: [
        { ...ITEM, credential: "sk-ant-secret", deviceId: CONNECTION },
      ],
      userId: CONNECTION,
    }),
  ).toEqual({ revision: 1, status: "ready", connections: [ITEM] });
  const full = Array.from(
    { length: PROVIDER_CONNECTION_LIMITS.connections },
    () => ITEM,
  );
  for (const value of [
    { revision: 1, status: "ready", connections: [...full, ITEM] },
    { revision: 1, status: "unavailable", connections: [] },
    {
      revision: 1,
      status: "unavailable",
      problem: "not_found",
      connections: [],
    },
    { revision: -1, status: "ready", connections: [] },
    { revision: 1, status: "ready", connections: [{ ...ITEM, kind: "x" }] },
    {
      revision: 1,
      status: "ready",
      connections: [{ ...ITEM, status: "ready" }],
    },
    {
      revision: 1,
      status: "ready",
      connections: [{ ...ITEM, status: "credential_missing" }],
    },
    { revision: 1, status: "ready", connections: [{ ...ITEM, label: "" }] },
    { revision: 1, status: "ready", connections: [{ ...ITEM, id: "x" }] },
  ]) {
    expect(
      ProviderConnectionListViewSchema.safeParse(value).success,
      JSON.stringify(value).slice(0, 120),
    ).toBe(false);
  }
});

test("the results of a registration and a removal are ok, a fixed refusal with a wait only for too_soon and rate_limited, or unknown", () => {
  for (const [schema, reasons] of [
    [
      RegisterProviderConnectionResultSchema,
      REGISTER_PROVIDER_CONNECTION_REFUSALS,
    ],
    [RemoveProviderConnectionResultSchema, REMOVE_PROVIDER_CONNECTION_REFUSALS],
  ] as const) {
    expect(schema.parse({ outcome: "ok" })).toEqual({ outcome: "ok" });
    expect(schema.parse({ outcome: "unknown" })).toEqual({
      outcome: "unknown",
    });
    for (const reason of reasons) {
      const waits = reason === "too_soon" || reason === "rate_limited";
      expect(
        schema.safeParse({
          outcome: "refused",
          reason,
          retryAfterMs: waits ? 1_000 : null,
        }).success,
        reason,
      ).toBe(true);
      expect(
        schema.safeParse({
          outcome: "refused",
          reason,
          retryAfterMs: waits ? null : 1_000,
        }).success,
        reason,
      ).toBe(false);
    }
    expect(
      schema.safeParse({
        outcome: "refused",
        reason: "credential_missing",
        retryAfterMs: null,
      }).success,
    ).toBe(false);
  }
  expect(REGISTER_PROVIDER_CONNECTION_REFUSALS).toContain(
    "provider_connection_limit",
  );
  expect(REMOVE_PROVIDER_CONNECTION_REFUSALS).not.toContain(
    "provider_connection_limit",
  );
  expect(REMOVE_PROVIDER_CONNECTION_REFUSALS).toContain("not_found");
  expect(REMOVE_PROVIDER_CONNECTION_REFUSALS).toContain("conflict");
});
