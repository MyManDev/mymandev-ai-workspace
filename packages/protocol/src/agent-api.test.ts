import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as z from "zod";
import {
  AGENT_COUNT_LIMITS,
  AGENT_ROUTE_ERRORS,
  AGENT_ROUTES,
  AgentListItemSchema,
  AgentListResponseSchema,
  type AgentRouteName,
  AgentRunListResponseSchema,
  CreateAgentRequestSchema,
  CreateAgentResponseSchema,
} from "./agent-api.ts";
import { AUTH_ROUTES, routePath } from "./auth-api.ts";
import { CHAT_ROUTES } from "./chat-api.ts";
import { decodeClientEvent, decodeEvent } from "./decode.ts";
import {
  APPROVER_EVENT_TYPES,
  SERVER_EVENT_AUDIENCES,
  SERVER_ONLY_EVENT_TYPES,
  WorkspaceAgentCreatedEventSchema,
  WorkspaceAgentDisabledEventSchema,
} from "./envelope.ts";
import { decodeClientMessage, decodeServerMessage } from "./frames.ts";
import { GRANT_ROUTES } from "./grant-api.ts";
import { MEMBERSHIP_ROUTES } from "./membership-api.ts";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  type ApiErrorCode,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  RECENT_FINISHED_RUNS,
  RUN_STATES,
  TERMINAL_RUN_STATES,
} from "./model.ts";
import { PROJECT_ROUTES } from "./project-api.ts";
import { REPOSITORY_ROUTES } from "./repository-api.ts";
import { RUN_ROUTES } from "./run-api.ts";

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

test("the agent routes are fixed, frozen, and start with the project", () => {
  assert.deepEqual(
    Object.values(AGENT_ROUTES).map((route) => `${route.method} ${route.path}`),
    [
      "GET /projects/:projectId/agents",
      "GET /projects/:projectId/runs",
      "POST /projects/:projectId/agents",
      "POST /projects/:projectId/agents/:agentId/disable",
    ],
  );
  assert.equal(Object.isFrozen(AGENT_ROUTES), true);
  for (const [name, route] of Object.entries(AGENT_ROUTES)) {
    assert.equal(Object.isFrozen(route), true, name);
    assert.equal(route.path.includes("?"), false, `${name}: query`);
    const params: Record<string, string> = route.path.includes(":agentId")
      ? { projectId: PROJECT_ID, agentId: AGENT_ID }
      : { projectId: PROJECT_ID };
    assert.equal(
      routePath(route.path, params),
      route.path
        .replace(":projectId", PROJECT_ID)
        .replace(":agentId", AGENT_ID),
      name,
    );
    assert.throws(
      () =>
        routePath(route.path, {
          ...params,
          projectId: PROJECT_ID.toUpperCase(),
        }),
      TypeError,
      name,
    );
  }
  // An agent's name, or anything else that is not an ID, never fills a path.
  for (const bad of ["Reviewer", AGENT_ID.toUpperCase(), ""]) {
    assert.throws(
      () =>
        routePath(AGENT_ROUTES.disableAgent.path, {
          projectId: PROJECT_ID,
          agentId: bad,
        }),
      TypeError,
      JSON.stringify(bad),
    );
  }
});

test("every route of the protocol has its own name and its own method and path", () => {
  const groups = [
    AUTH_ROUTES,
    MEMBERSHIP_ROUTES,
    PROJECT_ROUTES,
    CHAT_ROUTES,
    AGENT_ROUTES,
    REPOSITORY_ROUTES,
    RUN_ROUTES,
    GRANT_ROUTES,
  ];
  const names = groups.flatMap((routes) => Object.keys(routes));
  assert.equal(new Set(names).size, names.length);
  const table = groups.flatMap((routes) =>
    Object.values(routes).map((route) => `${route.method} ${route.path}`),
  );
  assert.equal(new Set(table).size, table.length);
  // The project's chat and agent activity are read with GET, under the
  // project, as the history is.
  for (const route of [
    ...Object.values(CHAT_ROUTES),
    AGENT_ROUTES.listAgents,
    AGENT_ROUTES.listRuns,
  ]) {
    assert.match(route.path, /^\/projects\/:projectId\/[a-z]+$/u, route.path);
    assert.equal(route.method, "GET", route.path);
  }
  // A change of an agent is a POST under the project.
  for (const route of [AGENT_ROUTES.createAgent, AGENT_ROUTES.disableAgent]) {
    assert.match(route.path, /^\/projects\/:projectId\/agents/u, route.path);
    assert.equal(route.method, "POST", route.path);
  }
});

test("each agent route answers the common codes and its own, frozen, and only a creation answers agent_limit", () => {
  assert.deepEqual(Object.keys(AGENT_ROUTE_ERRORS), Object.keys(AGENT_ROUTES));
  const known = new Set<string>(API_ERROR_CODES);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(AGENT_ROUTE_ERRORS).map(([name, codes]) => [
        name,
        codes.filter((code) => !COMMON_CODES.includes(code)),
      ]),
    ),
    {
      listAgents: ["not_found"],
      listRuns: ["not_found"],
      createAgent: ["not_found", "conflict", "agent_limit"],
      disableAgent: ["not_found", "forbidden", "conflict"],
    },
  );
  for (const [name, codes] of Object.entries(AGENT_ROUTE_ERRORS)) {
    assert.deepEqual(codes.slice(0, COMMON_CODES.length), COMMON_CODES, name);
    for (const code of codes) {
      assert.equal(known.has(code), true, `${name}: ${code}`);
    }
    assert.equal(Object.isFrozen(codes), true, name);
  }
  assert.equal(Object.isFrozen(AGENT_ROUTE_ERRORS), true);
  const holders = (code: ApiErrorCode) =>
    Object.entries(AGENT_ROUTE_ERRORS)
      .filter(([, codes]) => codes.includes(code))
      .map(([name]) => name);
  assert.deepEqual(holders("agent_limit"), ["createAgent"]);
  // The other limits that no time frees have their own routes.
  assert.deepEqual(holders("repository_limit"), []);
  assert.deepEqual(holders("run_limit"), []);
  assert.deepEqual(holders("grant_limit"), []);
  // No time frees a place of either count limit of a project, so the status
  // is a conflict and not a wait.
  assert.equal(API_ERROR_STATUS.agent_limit, 409);
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

test("the run list holds the unfinished runs and the most recently finished runs of one project, each list at most MAX_ANSWER_LIST_ITEMS", () => {
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
      "more finished runs than the server sends today",
      {
        unfinishedRuns: [],
        finishedRuns: runs(RECENT_FINISHED_RUNS + 1, "completed"),
      },
      true,
    ],
    [
      "the most finished runs",
      {
        unfinishedRuns: [],
        finishedRuns: runs(MAX_ANSWER_LIST_ITEMS, "completed"),
      },
      true,
    ],
    [
      "one finished run too many",
      {
        unfinishedRuns: [],
        finishedRuns: runs(MAX_ANSWER_LIST_ITEMS + 1, "completed"),
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

test("the schemas of each agent route export to JSON Schema for documentation", () => {
  const schemas = {
    listAgents: [null, AgentListResponseSchema],
    listRuns: [null, AgentRunListResponseSchema],
    createAgent: [CreateAgentRequestSchema, CreateAgentResponseSchema],
    disableAgent: [null, null],
  } satisfies Record<
    AgentRouteName,
    [request: z.ZodType | null, response: z.ZodType | null]
  >;
  assert.deepEqual(Object.keys(schemas), Object.keys(AGENT_ROUTES));
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

test("the README's tables list the agent routes with their codes", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rows = readme
    .split("\n")
    .filter((line) => /^\| `(?:GET|POST) \/projects\//u.test(line))
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

// Creating and disabling an agent (#294).

const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192c4";
const EVENT_ID = "0192f2a0-7c3e-7e00-8000-0000000000e1";

type Json = Record<string, unknown>;

function agentEvent(type: string, payload: Json): Json {
  return {
    protocolVersion: 0,
    id: EVENT_ID,
    type,
    occurredAt: NOW,
    workspaceId: WORKSPACE_ID,
    actor: { kind: "system" },
    deviceId: null,
    payload,
  };
}

function agentEvents(): Json[] {
  return [
    agentEvent("workspace.agent.created", { agent }),
    agentEvent("workspace.agent.disabled", {
      agent: { ...agent, disabledAt: LATER },
    }),
  ];
}

test("the agent count limits are fixed, frozen, and keep the agent list within MAX_ANSWER_LIST_ITEMS", () => {
  assert.deepEqual(AGENT_COUNT_LIMITS, {
    enabledPerProject: 20,
    perProject: 500,
    perDay: 20,
  });
  assert.equal(Object.isFrozen(AGENT_COUNT_LIMITS), true);
  // The list holds disabled agents too, so the lifetime limit bounds it.
  assert.ok(AGENT_COUNT_LIMITS.perProject <= MAX_ANSWER_LIST_ITEMS);
  assert.ok(
    AGENT_COUNT_LIMITS.enabledPerProject <= AGENT_COUNT_LIMITS.perProject,
  );
});

test("a creation takes a name of single-line text from 1 to 64 characters, and nothing else", () => {
  const schema = CreateAgentRequestSchema;
  for (const name of [
    "Reviewer",
    "a".repeat(LIMITS.agentName),
    "\u00C4rger",
    "Bot \u{1F680}",
    " Reviewer ",
    "Reviewer/2",
  ]) {
    assert.deepEqual(schema.safeParse({ name }).data, { name }, name);
  }
  for (const [label, value] of [
    ["empty", { name: "" }],
    ["over 64", { name: "a".repeat(LIMITS.agentName + 1) }],
    ["blank", { name: " \t " }],
    ["line feed inside", { name: "Re\nviewer" }],
    ["line separator inside", { name: "Re\u2028viewer" }],
    ["byte order mark inside", { name: "Re\uFEFFviewer" }],
    ["control character", { name: "Re\u0000viewer" }],
    ["zero-width space", { name: "Re\u200Bviewer" }],
    ["right-to-left override", { name: "\u202Eweiver" }],
    ["missing", {}],
    ["null", { name: null }],
    ["number", { name: 7 }],
  ] as const) {
    assert.equal(schema.safeParse(value).success, false, label);
  }
  assert.deepEqual(Object.keys(schema.shape), ["name"]);
  // The host device, the owner, the project, and a provider kind are never
  // the caller's to choose: they are stripped.
  assert.deepEqual(
    schema.parse({
      name: "Reviewer",
      hostDeviceId: DEVICE_ID,
      ownerUserId: USER_ID,
      ownerMemberId: MEMBER_ID,
      projectId: OTHER_PROJECT_ID,
      id: OTHER_AGENT_ID,
      kind: "claude",
      provider: "claude",
      disabledAt: NOW,
    }),
    { name: "Reviewer" },
  );
});

test("the answer of a creation is the new agent as the list shows it: enabled, without its host device", () => {
  assert.deepEqual(CreateAgentResponseSchema.parse({ agent }), { agent });
  assert.deepEqual(
    CreateAgentResponseSchema.parse({
      agent: { ...agent, hostDeviceId: DEVICE_ID, ownerUserId: USER_ID },
    }),
    { agent },
  );
  assert.equal(
    CreateAgentResponseSchema.safeParse({
      agent: { ...agent, disabledAt: NOW },
    }).success,
    false,
  );
  assert.equal(CreateAgentResponseSchema.safeParse({}).success, false);
});

test("agent events come only from the server, with a system actor and no device", () => {
  for (const event of agentEvents()) {
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
  }
});

test("agent events go to every member of the workspace, never only to the approvers", () => {
  for (const type of [
    "workspace.agent.created",
    "workspace.agent.disabled",
  ] as const) {
    assert.equal(SERVER_EVENT_AUDIENCES[type], "members", type);
    assert.equal(
      (APPROVER_EVENT_TYPES as readonly string[]).includes(type),
      false,
      type,
    );
  }
});

test("agent events carry the agent as the list shows it, never its host device, and in the state that their type says", () => {
  assert.deepEqual(
    Object.keys(WorkspaceAgentCreatedEventSchema.shape.payload.shape),
    ["agent"],
  );
  assert.deepEqual(
    Object.keys(WorkspaceAgentDisabledEventSchema.shape.payload.shape),
    ["agent"],
  );
  const [created, disabled] = agentEvents();
  assert.ok(created !== undefined && disabled !== undefined);
  // The host device and the owner's account are stripped.
  assert.deepEqual(
    decodeEvent({
      ...created,
      payload: {
        agent: { ...agent, hostDeviceId: DEVICE_ID, ownerUserId: USER_ID },
      },
    }),
    { ok: true, event: created },
  );
  for (const [label, input] of [
    [
      "a created agent that is disabled",
      agentEvent("workspace.agent.created", {
        agent: { ...agent, disabledAt: NOW },
      }),
    ],
    [
      "a disabled agent without the time of its disabling",
      agentEvent("workspace.agent.disabled", { agent }),
    ],
    [
      "a created agent without its owner",
      agentEvent("workspace.agent.created", {
        agent: { ...agent, ownerMemberId: undefined },
      }),
    ],
    [
      "a created agent with a name over 64 characters",
      agentEvent("workspace.agent.created", {
        agent: { ...agent, name: "a".repeat(LIMITS.agentName + 1) },
      }),
    ],
    [
      "a disabled agent named only by its ID",
      agentEvent("workspace.agent.disabled", { agentId: AGENT_ID }),
    ],
  ] as const) {
    assert.deepEqual(
      decodeEvent(input),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
});
