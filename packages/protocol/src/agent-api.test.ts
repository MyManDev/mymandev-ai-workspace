import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as z from "zod";
import {
  AGENT_ROUTE_ERRORS,
  AGENT_ROUTES,
  AgentListItemSchema,
  AgentListResponseSchema,
  AgentRunListResponseSchema,
} from "./agent-api.ts";
import { AUTH_ROUTES, routePath } from "./auth-api.ts";
import { CHAT_ROUTES } from "./chat-api.ts";
import { MEMBERSHIP_ROUTES } from "./membership-api.ts";
import {
  API_ERROR_CODES,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  RECENT_FINISHED_RUNS,
  RUN_STATES,
  TERMINAL_RUN_STATES,
} from "./model.ts";

const PROJECT_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1";
const OTHER_PROJECT_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b2";
const AGENT_ID = "0192f2a0-7c3e-7e00-8000-000000000005";
const OTHER_AGENT_ID = "0192f2a0-7c3e-7e00-8000-000000000006";
const MEMBER_ID = "0192f2a0-7c3e-7d2e-9f10-112233445502";
const USER_ID = "0192f2a0-7c3e-7f00-a000-000000000002";
const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const REPOSITORY_ID = "0192f2a0-7c3e-7c00-9000-000000000008";
const NOW = "2026-11-02T12:00:00.000Z";
const LATER = "2026-11-02T12:05:00.000Z";

/** The codes that every route can answer, as for the membership routes. */
const COMMON_CODES: readonly string[] = [
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
];

const agent = {
  id: AGENT_ID,
  projectId: PROJECT_ID,
  name: "Reviewer",
  ownerMemberId: MEMBER_ID,
  disabledAt: null,
};

/** Run number `index` in `state`, finished exactly when the state is terminal. */
function run(
  index: number,
  state: string,
  fields: Record<string, unknown> = {},
) {
  const terminal = (TERMINAL_RUN_STATES as readonly string[]).includes(state);
  return {
    id: `0192f2a0-7c3e-7b00-8000-${index.toString(16).padStart(12, "0")}`,
    agentId: AGENT_ID,
    projectId: PROJECT_ID,
    repositoryId: null,
    state,
    reason: null,
    createdAt: NOW,
    finishedAt: terminal ? LATER : null,
    ...fields,
  };
}

/** `count` runs in `state`, numbered from `from`. */
function runs(count: number, state: string, from = 1) {
  return Array.from({ length: count }, (_, index) => run(from + index, state));
}

test("the agent activity routes are fixed, frozen, and read a project", () => {
  assert.deepEqual(
    Object.values(AGENT_ROUTES).map((route) => `${route.method} ${route.path}`),
    ["GET /projects/:projectId/agents", "GET /projects/:projectId/runs"],
  );
  assert.equal(Object.isFrozen(AGENT_ROUTES), true);
  for (const [name, route] of Object.entries(AGENT_ROUTES)) {
    assert.equal(Object.isFrozen(route), true, name);
    assert.equal(route.path.includes("?"), false, `${name}: query`);
    assert.equal(
      routePath(route.path, { projectId: PROJECT_ID }),
      route.path.replace(":projectId", PROJECT_ID),
      name,
    );
    assert.throws(
      () => routePath(route.path, { projectId: PROJECT_ID.toUpperCase() }),
      TypeError,
      name,
    );
  }
});

test("every route of the protocol has its own name and its own method and path", () => {
  const groups = [AUTH_ROUTES, MEMBERSHIP_ROUTES, CHAT_ROUTES, AGENT_ROUTES];
  const names = groups.flatMap((routes) => Object.keys(routes));
  assert.equal(new Set(names).size, names.length);
  const table = groups.flatMap((routes) =>
    Object.values(routes).map((route) => `${route.method} ${route.path}`),
  );
  assert.equal(new Set(table).size, table.length);
  // The project routes all start with the project, as the history does.
  for (const route of [
    ...Object.values(CHAT_ROUTES),
    ...Object.values(AGENT_ROUTES),
  ]) {
    assert.match(route.path, /^\/projects\/:projectId\/[a-z]+$/u, route.path);
    assert.equal(route.method, "GET", route.path);
  }
});

test("the agent activity routes answer the common codes and not_found, frozen", () => {
  assert.deepEqual(Object.keys(AGENT_ROUTE_ERRORS), Object.keys(AGENT_ROUTES));
  const known = new Set<string>(API_ERROR_CODES);
  for (const [name, codes] of Object.entries(AGENT_ROUTE_ERRORS)) {
    assert.deepEqual(codes, [...COMMON_CODES, "not_found"], name);
    for (const code of codes) {
      assert.equal(known.has(code), true, `${name}: ${code}`);
    }
    assert.equal(Object.isFrozen(codes), true, name);
  }
  assert.equal(Object.isFrozen(AGENT_ROUTE_ERRORS), true);
});

test("an agent in the list shows its owner's person and whether it is disabled, never its host device", () => {
  assert.equal(AgentListItemSchema.safeParse(agent).success, true);
  assert.equal(
    AgentListItemSchema.safeParse({ ...agent, disabledAt: NOW }).success,
    true,
  );
  // The host device and the owner's account are stripped.
  const parsed = AgentListItemSchema.parse({
    ...agent,
    hostDeviceId: DEVICE_ID,
    ownerUserId: USER_ID,
  });
  assert.deepEqual(parsed, agent);
  const keys = Object.keys(AgentListItemSchema.shape);
  assert.deepEqual(keys.sort(), [
    "disabledAt",
    "id",
    "name",
    "ownerMemberId",
    "projectId",
  ]);
  assert.equal(
    keys.some((key) => key.toLowerCase().includes("device")),
    false,
  );

  const refused: [label: string, value: unknown][] = [
    ...Object.keys(agent).map((key): [string, unknown] => [
      `missing ${key}`,
      { ...agent, [key]: undefined },
    ]),
    ["an empty name", { ...agent, name: "" }],
    [
      "a name over the limit",
      { ...agent, name: "a".repeat(LIMITS.agentName + 1) },
    ],
    ["a name with a line feed", { ...agent, name: "Re\nviewer" }],
    ["a boolean instead of the time", { ...agent, disabledAt: false }],
    ["an owner that is not an ID", { ...agent, ownerMemberId: "not-an-id" }],
  ];
  for (const [label, value] of refused) {
    assert.equal(AgentListItemSchema.safeParse(value).success, false, label);
  }
  assert.equal(
    AgentListItemSchema.safeParse({
      ...agent,
      name: "a".repeat(LIMITS.agentName),
    }).success,
    true,
  );
});

test("the agent list holds each agent of one project once, at most MAX_ANSWER_LIST_ITEMS", () => {
  const many = (count: number) => ({
    agents: Array.from({ length: count }, (_, index) => ({
      ...agent,
      id: `0192f2a0-7c3e-7e00-8000-${index.toString(16).padStart(12, "0")}`,
    })),
  });
  for (const count of [0, 1, MAX_ANSWER_LIST_ITEMS]) {
    assert.equal(
      AgentListResponseSchema.safeParse(many(count)).success,
      true,
      String(count),
    );
  }
  const refused: [label: string, value: unknown][] = [
    ["over the maximum", many(MAX_ANSWER_LIST_ITEMS + 1)],
    ["an agent twice", { agents: [agent, agent] }],
    [
      "two projects",
      {
        agents: [
          agent,
          { ...agent, id: OTHER_AGENT_ID, projectId: OTHER_PROJECT_ID },
        ],
      },
    ],
    ["no list", {}],
  ];
  for (const [label, value] of refused) {
    assert.equal(
      AgentListResponseSchema.safeParse(value).success,
      false,
      label,
    );
  }
  // A host device that the server sent by mistake is stripped.
  const parsed = AgentListResponseSchema.parse({
    agents: [{ ...agent, hostDeviceId: DEVICE_ID }],
  });
  assert.deepEqual(parsed, { agents: [agent] });
});

test("the run list holds every unfinished run and the 50 most recently finished runs of one project", () => {
  const valid = {
    unfinishedRuns: [
      run(1, "queued"),
      run(2, "running", { repositoryId: REPOSITORY_ID }),
      run(3, "awaiting_input", { reason: "Waiting for an answer" }),
    ],
    finishedRuns: [
      run(4, "completed"),
      run(5, "failed", { reason: "The provider is unavailable" }),
      run(6, "cancelled", { reason: "device_revoked" }),
    ],
  };
  assert.deepEqual(AgentRunListResponseSchema.parse(valid), valid);
  assert.equal(
    AgentRunListResponseSchema.safeParse({
      unfinishedRuns: [],
      finishedRuns: [],
    }).success,
    true,
  );
  assert.equal(RECENT_FINISHED_RUNS, 50);
  const bounds: [label: string, value: unknown, accepted: boolean][] = [
    [
      "the most unfinished runs",
      {
        unfinishedRuns: runs(MAX_ANSWER_LIST_ITEMS, "running"),
        finishedRuns: runs(RECENT_FINISHED_RUNS, "completed", 5_000),
      },
      true,
    ],
    [
      "one unfinished run too many",
      {
        unfinishedRuns: runs(MAX_ANSWER_LIST_ITEMS + 1, "running"),
        finishedRuns: [],
      },
      false,
    ],
    [
      "one finished run too many",
      {
        unfinishedRuns: [],
        finishedRuns: runs(RECENT_FINISHED_RUNS + 1, "completed"),
      },
      false,
    ],
  ];
  for (const [label, value, accepted] of bounds) {
    assert.equal(
      AgentRunListResponseSchema.safeParse(value).success,
      accepted,
      label,
    );
  }

  const refused: [label: string, value: unknown][] = [
    [
      "a finished run among the unfinished",
      { unfinishedRuns: [run(1, "completed")], finishedRuns: [] },
    ],
    [
      "an unfinished run among the finished",
      { unfinishedRuns: [], finishedRuns: [run(1, "running")] },
    ],
    [
      "a run in both lists",
      { unfinishedRuns: [run(1, "running")], finishedRuns: [run(1, "failed")] },
    ],
    [
      "a run twice",
      {
        unfinishedRuns: [run(1, "queued"), run(1, "queued")],
        finishedRuns: [],
      },
    ],
    [
      "two projects",
      {
        unfinishedRuns: [run(1, "queued")],
        finishedRuns: [run(2, "failed", { projectId: OTHER_PROJECT_ID })],
      },
    ],
    [
      "a finished run without a finish time",
      {
        unfinishedRuns: [],
        finishedRuns: [run(1, "failed", { finishedAt: null })],
      },
    ],
    [
      "an unfinished run with a finish time",
      {
        unfinishedRuns: [run(1, "running", { finishedAt: LATER })],
        finishedRuns: [],
      },
    ],
    [
      "an unknown state",
      { unfinishedRuns: [run(1, "paused")], finishedRuns: [] },
    ],
    [
      "a reason over the limit",
      {
        unfinishedRuns: [
          run(1, "running", { reason: "a".repeat(LIMITS.runReason + 1) }),
        ],
        finishedRuns: [],
      },
    ],
    [
      "an empty reason",
      { unfinishedRuns: [run(1, "running", { reason: "" })], finishedRuns: [] },
    ],
    [
      "a run without its agent",
      {
        unfinishedRuns: [run(1, "running", { agentId: undefined })],
        finishedRuns: [],
      },
    ],
    [
      "a run without its repository field",
      {
        unfinishedRuns: [run(1, "running", { repositoryId: undefined })],
        finishedRuns: [],
      },
    ],
    ["no finished list", { unfinishedRuns: [] }],
  ];
  for (const [label, value] of refused) {
    assert.equal(
      AgentRunListResponseSchema.safeParse(value).success,
      false,
      label,
    );
  }

  // Every state belongs to exactly one of the two lists.
  for (const state of RUN_STATES) {
    const terminal = (TERMINAL_RUN_STATES as readonly string[]).includes(state);
    assert.equal(
      AgentRunListResponseSchema.safeParse({
        unfinishedRuns: terminal ? [] : [run(1, state)],
        finishedRuns: terminal ? [run(1, state)] : [],
      }).success,
      true,
      state,
    );
  }
});

test("the agent activity schemas export to JSON Schema for documentation", () => {
  for (const schema of [AgentListResponseSchema, AgentRunListResponseSchema]) {
    const json = z.toJSONSchema(schema, { io: "input" });
    assert.equal(typeof json, "object");
  }
});

test("the README's table lists the agent activity routes with their codes", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rows = readme
    .split("\n")
    .filter((line) => line.startsWith("| `GET /projects/"))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  for (const [name, route] of Object.entries(AGENT_ROUTES)) {
    const row = rows.find(
      (cells) => cells[1] === `\`${route.method} ${route.path}\``,
    );
    assert.ok(row, `${name} is not in the README`);
    assert.equal(row.length, 7, name);
    const codes = [...(row[5] ?? "").matchAll(/`([a-z_]+)`/gu)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      codes,
      AGENT_ROUTE_ERRORS[name as keyof typeof AGENT_ROUTES].filter(
        (code) => !COMMON_CODES.includes(code),
      ),
      name,
    );
  }
});
