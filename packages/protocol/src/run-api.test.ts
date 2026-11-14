import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as z from "zod";
import { ApiErrorBodySchema } from "./account.ts";
import {
  AGENT_ROUTE_ERRORS,
  AGENT_ROUTES,
  AgentRunListItemSchema,
  AgentRunListResponseSchema,
} from "./agent-api.ts";
import { AUTH_ROUTES, routePath } from "./auth-api.ts";
import { CHAT_ROUTE_ERRORS, CHAT_ROUTES } from "./chat-api.ts";
import { decodeClientEvent } from "./decode.ts";
import { AgentRunSchema } from "./entities.ts";
import {
  AgentRunStateChangedPayloadSchema,
  isApproverEventType,
  SERVER_EVENT_AUDIENCES,
  SERVER_ONLY_EVENT_TYPES,
} from "./envelope.ts";
import { decodeClientMessage, decodeServerMessage } from "./frames.ts";
import {
  MEMBERSHIP_ROUTE_ERRORS,
  MEMBERSHIP_ROUTES,
} from "./membership-api.ts";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  type ApiErrorCode,
  RUN_STATES,
} from "./model.ts";
import { PROJECT_ROUTE_ERRORS, PROJECT_ROUTES } from "./project-api.ts";
import {
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  RUN_ROUTE_ERRORS,
  RUN_ROUTES,
} from "./run-api.ts";

const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a1";
const PROJECT_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192b1";
const AGENT_ID = "0192f2a0-7c3e-7e00-8000-000000000005";
const OTHER_AGENT_ID = "0192f2a0-7c3e-7e00-8000-000000000006";
const RUN_ID = "0192f2a0-7c3e-7b00-8000-000000000001";
const OTHER_RUN_ID = "0192f2a0-7c3e-7b00-8000-000000000002";
const REPOSITORY_ID = "0192f2a0-7c3e-7c00-9000-000000000008";
const OTHER_REPOSITORY_ID = "0192f2a0-7c3e-7c00-9000-000000000009";
const CONNECTION_ID = "0192f2a0-7c3e-7d00-a000-00000000000a";
const MESSAGE_ID = "0192f2a0-7c3e-7f00-b000-00000000000b";
const USER_ID = "0192f2a0-7c3e-7f00-a000-000000000002";
const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const EVENT_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1";
const NOW = "2026-11-14T12:00:00.000Z";
const LATER = "2026-11-14T12:05:00.000Z";

type Json = Record<string, unknown>;

/** The codes that every route can answer, as for the membership routes. */
const COMMON_CODES: readonly string[] = [
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
];

/** A request for a run without a repository. */
const request = {
  agentId: AGENT_ID,
  providerConnectionId: CONNECTION_ID,
  inputMessageId: MESSAGE_ID,
};

/** A new run as every member reads it: with its input, without its provider connection. */
function memberRun(fields: Json = {}): Json {
  return {
    id: RUN_ID,
    agentId: AGENT_ID,
    projectId: PROJECT_ID,
    repositoryId: null,
    state: "queued",
    reason: null,
    createdAt: NOW,
    finishedAt: null,
    inputMessageId: MESSAGE_ID,
    ...fields,
  };
}

/** A new run as the account that owns its agent reads it. */
function ownerRun(fields: Json = {}): Json {
  return memberRun({ providerConnectionId: CONNECTION_ID, ...fields });
}

/** The server's `agent.run.state_changed` for a new run, with `payload`. */
function creation(payload: Json = {}): Json {
  return {
    protocolVersion: 0,
    id: EVENT_ID,
    type: "agent.run.state_changed",
    occurredAt: NOW,
    workspaceId: WORKSPACE_ID,
    actor: { kind: "system" },
    deviceId: null,
    payload: {
      runId: RUN_ID,
      agentId: AGENT_ID,
      previousState: null,
      state: "queued",
      run: memberRun(),
      ...payload,
    },
  };
}

function without(value: Json, key: string): Json {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

test("the run route is fixed, frozen, and creates a run in a project", () => {
  assert.deepEqual(
    Object.values(RUN_ROUTES).map((route) => `${route.method} ${route.path}`),
    ["POST /projects/:projectId/runs"],
  );
  assert.equal(Object.isFrozen(RUN_ROUTES), true);
  for (const [name, route] of Object.entries(RUN_ROUTES)) {
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
  // The creation shares its path with the run list and differs by method.
  assert.equal(RUN_ROUTES.createRun.path, AGENT_ROUTES.listRuns.path);
  assert.notEqual(RUN_ROUTES.createRun.method, AGENT_ROUTES.listRuns.method);
});

test("the run route has its own name and its own method and path among every route of the protocol", () => {
  const groups = [
    AUTH_ROUTES,
    MEMBERSHIP_ROUTES,
    PROJECT_ROUTES,
    CHAT_ROUTES,
    AGENT_ROUTES,
    RUN_ROUTES,
  ];
  const names = groups.flatMap((routes) => Object.keys(routes));
  assert.equal(new Set(names).size, names.length);
  const table = groups.flatMap((routes) =>
    Object.values(routes).map((route) => `${route.method} ${route.path}`),
  );
  assert.equal(new Set(table).size, table.length);
});

test("a run creation answers the common codes, not_found, forbidden, conflict, and its two limits, and no other route answers the limits", () => {
  assert.deepEqual(Object.keys(RUN_ROUTE_ERRORS), Object.keys(RUN_ROUTES));
  assert.deepEqual(RUN_ROUTE_ERRORS.createRun, [
    ...COMMON_CODES,
    "not_found",
    "forbidden",
    "conflict",
    "run_limit",
    "run_daily_limit",
  ]);
  const known = new Set<string>(API_ERROR_CODES);
  for (const code of RUN_ROUTE_ERRORS.createRun) {
    assert.equal(known.has(code), true, code);
  }
  assert.equal(Object.isFrozen(RUN_ROUTE_ERRORS), true);
  assert.equal(Object.isFrozen(RUN_ROUTE_ERRORS.createRun), true);

  const tables: Record<string, readonly ApiErrorCode[]> = {
    ...MEMBERSHIP_ROUTE_ERRORS,
    ...PROJECT_ROUTE_ERRORS,
    ...CHAT_ROUTE_ERRORS,
    ...AGENT_ROUTE_ERRORS,
    ...RUN_ROUTE_ERRORS,
  };
  const holders = (code: ApiErrorCode) =>
    Object.entries(tables)
      .filter(([, codes]) => codes.includes(code))
      .map(([name]) => name);
  assert.deepEqual(holders("run_limit"), ["createRun"]);
  assert.deepEqual(holders("run_daily_limit"), ["createRun"]);
});

test("run_limit is a 409 without a wait, and run_daily_limit a 429", () => {
  assert.equal(API_ERROR_STATUS.run_limit, 409);
  assert.equal(API_ERROR_STATUS.run_daily_limit, 429);
  const body = (statusCode: number, code: string) => ({
    statusCode,
    error: "Status",
    message: "Status",
    code,
  });
  const cases: [status: number, code: string, accepted: boolean][] = [
    [409, "run_limit", true],
    [429, "run_daily_limit", true],
    // The limit of unfinished runs is no wait, and the daily limit is one.
    [429, "run_limit", false],
    [409, "run_daily_limit", false],
  ];
  for (const [status, code, accepted] of cases) {
    assert.equal(
      ApiErrorBodySchema.safeParse(body(status, code)).success,
      accepted,
      `${status} ${code}`,
    );
  }
});

test("a run request names an agent, a provider connection, and an input message, and a repository only when the run has one", () => {
  assert.deepEqual(CreateRunRequestSchema.parse(request), request);
  const withRepository = { ...request, repositoryId: REPOSITORY_ID };
  assert.deepEqual(
    CreateRunRequestSchema.parse(withRepository),
    withRepository,
  );

  for (const key of ["agentId", "providerConnectionId", "inputMessageId"]) {
    assert.equal(
      CreateRunRequestSchema.safeParse(without(request, key)).success,
      false,
      `without ${key}`,
    );
    for (const value of [
      null,
      "",
      "agent",
      AGENT_ID.toUpperCase(),
      7,
      [],
      {},
    ]) {
      assert.equal(
        CreateRunRequestSchema.safeParse({ ...request, [key]: value }).success,
        false,
        `${key}: ${JSON.stringify(value)}`,
      );
    }
  }
  // A run without a repository leaves the field out; null is not an ID.
  for (const value of [null, "", "web", REPOSITORY_ID.toUpperCase()]) {
    assert.equal(
      CreateRunRequestSchema.safeParse({ ...request, repositoryId: value })
        .success,
      false,
      `repositoryId: ${JSON.stringify(value)}`,
    );
  }
  for (const value of [undefined, null, "run", [], [request]]) {
    assert.equal(CreateRunRequestSchema.safeParse(value).success, false);
  }
});

test("a run request carries no text, no project, no requester, no device, and no state: unknown keys are stripped", () => {
  const sent = {
    ...request,
    projectId: PROJECT_ID,
    requestedBy: USER_ID,
    hostDeviceId: DEVICE_ID,
    state: "running",
    correlationId: EVENT_ID,
    body: "Do it",
    text: "Do it",
    input: "Do it",
  };
  assert.deepEqual(CreateRunRequestSchema.parse(sent), request);
  assert.deepEqual(Object.keys(CreateRunRequestSchema.shape).sort(), [
    "agentId",
    "inputMessageId",
    "providerConnectionId",
    "repositoryId",
  ]);
});

test("the answer of a creation is the queued run with its input message and its provider connection", () => {
  const answer = { run: ownerRun() };
  assert.deepEqual(CreateRunResponseSchema.parse(answer), answer);
  const withRepository = { run: ownerRun({ repositoryId: REPOSITORY_ID }) };
  assert.deepEqual(
    CreateRunResponseSchema.parse(withRepository),
    withRepository,
  );

  const refused: [label: string, run: Json][] = [
    ["without its provider connection", memberRun()],
    ["without its input message", without(ownerRun(), "inputMessageId")],
    ["with a reason", ownerRun({ reason: "Started" })],
    ["finished", ownerRun({ state: "failed", finishedAt: LATER })],
    ["with a finish time", ownerRun({ finishedAt: LATER })],
    ["a malformed connection", ownerRun({ providerConnectionId: "none" })],
    ["a null connection", ownerRun({ providerConnectionId: null })],
    ["a null input message", ownerRun({ inputMessageId: null })],
  ];
  for (const state of RUN_STATES) {
    if (state !== "queued") {
      refused.push([
        `in ${state}`,
        ownerRun({
          state,
          finishedAt: ["completed", "failed", "cancelled"].includes(state)
            ? LATER
            : null,
        }),
      ]);
    }
  }
  for (const [label, run] of refused) {
    assert.equal(
      CreateRunResponseSchema.safeParse({ run }).success,
      false,
      label,
    );
  }
  assert.equal(CreateRunResponseSchema.safeParse({}).success, false);
});

test("a run in the list may name its input message and its provider connection, and a run without them still parses", () => {
  // A run of the development seed, and an answer of a server before #35.
  const seeded = without(memberRun(), "inputMessageId");
  assert.deepEqual(AgentRunListItemSchema.parse(seeded), seeded);
  assert.deepEqual(AgentRunListItemSchema.parse(memberRun()), memberRun());
  assert.deepEqual(AgentRunListItemSchema.parse(ownerRun()), ownerRun());

  for (const key of ["inputMessageId", "providerConnectionId"]) {
    for (const value of [null, "", "none", MESSAGE_ID.toUpperCase(), 7]) {
      assert.equal(
        AgentRunListItemSchema.safeParse(ownerRun({ [key]: value })).success,
        false,
        `${key}: ${JSON.stringify(value)}`,
      );
    }
  }
  // The host device, the requester, and a text never pass through.
  assert.deepEqual(
    AgentRunListItemSchema.parse(
      ownerRun({ hostDeviceId: DEVICE_ID, requestedBy: USER_ID, input: "x" }),
    ),
    ownerRun(),
  );

  // One list may hold runs with and without the fields, also finished ones.
  const list = {
    unfinishedRuns: [
      ownerRun(),
      memberRun({ id: OTHER_RUN_ID, agentId: OTHER_AGENT_ID }),
    ],
    finishedRuns: [
      ownerRun({
        id: "0192f2a0-7c3e-7b00-8000-000000000003",
        state: "completed",
        finishedAt: LATER,
      }),
      without(
        memberRun({
          id: "0192f2a0-7c3e-7b00-8000-000000000004",
          state: "cancelled",
          reason: "device_revoked",
          finishedAt: LATER,
        }),
        "inputMessageId",
      ),
    ],
  };
  assert.deepEqual(AgentRunListResponseSchema.parse(list), list);
});

test("the run entity carries an optional provider connection and an optional input message", () => {
  const run = {
    id: RUN_ID,
    agentId: AGENT_ID,
    projectId: PROJECT_ID,
    requestedBy: USER_ID,
    state: "queued",
  };
  assert.deepEqual(AgentRunSchema.parse(run), run);
  const created = {
    ...run,
    repositoryId: REPOSITORY_ID,
    providerConnectionId: CONNECTION_ID,
    inputMessageId: MESSAGE_ID,
  };
  assert.deepEqual(AgentRunSchema.parse(created), created);
  for (const key of ["providerConnectionId", "inputMessageId"]) {
    for (const value of [null, "", MESSAGE_ID.toUpperCase()]) {
      assert.equal(
        AgentRunSchema.safeParse({ ...created, [key]: value }).success,
        false,
        `${key}: ${JSON.stringify(value)}`,
      );
    }
  }
});

test("the server's event for a new run carries the run as every member sees it, and a device decodes it", () => {
  const decoded = decodeServerMessage(creation());
  assert.deepEqual(decoded, { ok: true, kind: "event", event: creation() });

  const withRepository = creation({
    repositoryId: REPOSITORY_ID,
    run: memberRun({ repositoryId: REPOSITORY_ID }),
  });
  assert.deepEqual(decodeServerMessage(withRepository), {
    ok: true,
    kind: "event",
    event: withRepository,
  });

  // A creation without the run still decodes, as before #35.
  const bare = creation();
  delete (bare["payload"] as Json)["run"];
  assert.deepEqual(decodeServerMessage(bare), {
    ok: true,
    kind: "event",
    event: bare,
  });

  // Unknown keys of the run are stripped, the host device among them.
  const padded = creation({
    run: memberRun({ hostDeviceId: DEVICE_ID, requestedBy: USER_ID }),
  });
  assert.deepEqual(decodeServerMessage(padded), {
    ok: true,
    kind: "event",
    event: creation(),
  });
});

test("an event never names a run's provider connection", () => {
  assert.deepEqual(decodeServerMessage(creation({ run: ownerRun() })), {
    ok: false,
    code: "invalid_payload",
  });
  const result = AgentRunStateChangedPayloadSchema.safeParse({
    runId: RUN_ID,
    agentId: AGENT_ID,
    previousState: null,
    state: "queued",
    run: ownerRun(),
  });
  assert.equal(result.success, false);
  assert.deepEqual(
    result.error?.issues.map((issue) => issue.path),
    [["run", "providerConnectionId"]],
  );
});

test("the run of a creation agrees with the event's payload", () => {
  const refused: [label: string, payload: Json][] = [
    ["another run", { run: memberRun({ id: OTHER_RUN_ID }) }],
    ["another agent", { run: memberRun({ agentId: OTHER_AGENT_ID }) }],
    [
      "a repository that the payload does not name",
      { run: memberRun({ repositoryId: REPOSITORY_ID }) },
    ],
    [
      "no repository where the payload names one",
      { repositoryId: REPOSITORY_ID },
    ],
    [
      "another repository",
      {
        repositoryId: REPOSITORY_ID,
        run: memberRun({ repositoryId: OTHER_REPOSITORY_ID }),
      },
    ],
    [
      "a reason that the payload does not give",
      { run: memberRun({ reason: "x" }) },
    ],
    ["no reason where the payload gives one", { reason: "Requested" }],
    ["another state", { run: memberRun({ state: "running" }) }],
    [
      "a finished run",
      { run: memberRun({ state: "failed", finishedAt: LATER }) },
    ],
    ["a run with a finish time", { run: memberRun({ finishedAt: LATER }) }],
    ["a run without a project", { run: without(memberRun(), "projectId") }],
    ["a run that is not an object", { run: RUN_ID }],
    ["a null run", { run: null }],
  ];
  for (const [label, payload] of refused) {
    assert.deepEqual(
      decodeServerMessage(creation(payload)),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
  // A reason that both give is accepted.
  const reasoned = creation({
    reason: "Requested",
    run: memberRun({ reason: "Requested" }),
  });
  assert.equal(decodeServerMessage(reasoned).ok, true);
});

test("only a run's creation carries the run: a transition and a cancellation with one are refused", () => {
  const started = {
    ...creation(),
    actor: { kind: "agent", agentId: AGENT_ID },
    payload: {
      runId: RUN_ID,
      agentId: AGENT_ID,
      previousState: "queued",
      state: "running",
    },
  };
  assert.equal(decodeServerMessage(started).ok, true);
  assert.deepEqual(
    decodeServerMessage({
      ...started,
      payload: { ...started.payload, run: memberRun({ state: "running" }) },
    }),
    { ok: false, code: "invalid_payload" },
  );
  const cancelled = {
    ...creation(),
    payload: {
      runId: RUN_ID,
      agentId: AGENT_ID,
      previousState: "queued",
      state: "cancelled",
      reason: "device_revoked",
    },
  };
  assert.equal(decodeServerMessage(cancelled).ok, true);
  assert.deepEqual(
    decodeServerMessage({
      ...cancelled,
      payload: {
        ...cancelled.payload,
        run: memberRun({
          state: "cancelled",
          reason: "device_revoked",
          finishedAt: LATER,
        }),
      },
    }),
    { ok: false, code: "invalid_payload" },
  );
});

test("a device never creates a run, with or without the run in the payload, and never adds one to its transition", () => {
  const fromDevice = {
    ...creation(),
    actor: { kind: "agent", agentId: AGENT_ID },
    deviceId: DEVICE_ID,
  };
  const notAllowed = { ok: false, code: "not_allowed_from_device" };
  assert.deepEqual(decodeClientEvent(fromDevice), notAllowed);
  assert.deepEqual(decodeClientMessage(fromDevice), notAllowed);
  assert.deepEqual(decodeClientEvent(creation()), notAllowed);
  const transition = {
    ...fromDevice,
    payload: {
      runId: RUN_ID,
      agentId: AGENT_ID,
      previousState: "queued",
      state: "running",
    },
  };
  assert.equal(decodeClientEvent(transition).ok, true);
  assert.deepEqual(
    decodeClientEvent({
      ...transition,
      payload: { ...transition.payload, run: memberRun({ state: "running" }) },
    }),
    { ok: false, code: "invalid_payload" },
  );
});

test("the event for a new run goes to every member of the workspace, as the audience map declares", () => {
  assert.equal(SERVER_EVENT_AUDIENCES["agent.run.state_changed"], "members");
  assert.equal(isApproverEventType("agent.run.state_changed"), false);
  // A device also sends it, for its transitions, so it is not server-only.
  assert.equal(
    (SERVER_ONLY_EVENT_TYPES as readonly string[]).includes(
      "agent.run.state_changed",
    ),
    false,
  );
});

test("the run schemas export to JSON Schema for documentation", () => {
  for (const schema of [
    CreateRunRequestSchema,
    CreateRunResponseSchema,
    AgentRunListItemSchema,
    AgentRunStateChangedPayloadSchema,
  ]) {
    const json = z.toJSONSchema(schema, { io: "input" });
    assert.equal(typeof json, "object");
  }
  const json = z.toJSONSchema(CreateRunRequestSchema, { io: "input" }) as {
    required?: string[];
  };
  assert.deepEqual([...(json.required ?? [])].sort(), [
    "agentId",
    "inputMessageId",
    "providerConnectionId",
  ]);
});

test("the README's table lists the run route with its codes", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const rows = readme
    .split("\n")
    .filter((line) => line.startsWith("| `POST /projects/"))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  for (const [name, route] of Object.entries(RUN_ROUTES)) {
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
      RUN_ROUTE_ERRORS[name as keyof typeof RUN_ROUTES].filter(
        (code) => !COMMON_CODES.includes(code),
      ),
      name,
    );
  }
});
