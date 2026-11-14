import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as z from "zod";
import { AUTH_ROUTES, routePath } from "./auth-api.ts";
import { decodeClientEvent, decodeEvent } from "./decode.ts";
import { SERVER_ONLY_EVENT_TYPES } from "./envelope.ts";
import { decodeClientMessage, decodeServerMessage } from "./frames.ts";
import { ProjectIdSchema, WorkspaceIdSchema } from "./ids.ts";
import {
  CreateWorkspaceRequestSchema,
  MEMBERSHIP_ROUTES,
} from "./membership-api.ts";
import {
  API_ERROR_CODES,
  type ApiErrorCode,
  MAX_ANSWER_LIST_ITEMS,
} from "./model.ts";
import {
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  normalizeProjectName,
  PROJECT_ROUTE_ERRORS,
  PROJECT_ROUTES,
  ProjectListResponseSchema,
  type ProjectRouteName,
  RenameProjectRequestSchema,
} from "./project-api.ts";

type Json = Record<string, unknown>;

const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OTHER_WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4";
const PROJECT_ID = "0192f2a0-7c3e-7e00-8000-000000000005";
const EVENT_ID = "0192f2a0-7c3e-7e00-8000-000000000006";
const DEVICE_ID = "0192f2a0-7c3e-7e00-8000-000000000007";
const USER_ID = "0192f2a0-7c3e-7f00-a000-000000000002";
const NOW = "2026-11-02T12:00:00.000Z";

const MEMBER_ID = "0192f2a0-7c3e-7d2e-9f10-112233445502";

const project = {
  id: PROJECT_ID,
  workspaceId: WORKSPACE_ID,
  name: "App",
  createdByMemberId: MEMBER_ID,
};

/** The codes that every project route can answer, as every membership route can. */
const COMMON_CODES: readonly string[] = [
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
];

/** The codes of each route beyond the common ones, in their order. */
function specificCodes(): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(PROJECT_ROUTE_ERRORS).map(([name, codes]) => [
      name,
      codes.filter((code) => !COMMON_CODES.includes(code)),
    ]),
  );
}

function projectEvent(type: string, payload: Json): Json {
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

function projectEvents(): Json[] {
  return [
    projectEvent("workspace.project.created", { project }),
    projectEvent("workspace.project.renamed", {
      projectId: PROJECT_ID,
      name: "App 2",
    }),
  ];
}

test("the project routes are fixed, frozen, under the membership-checked path, and apart from the other routes", () => {
  const table = Object.values(PROJECT_ROUTES).map(
    (route) => `${route.method} ${route.path}`,
  );
  assert.deepEqual(table, [
    "GET /workspaces/:workspaceId/projects",
    "POST /workspaces/:workspaceId/projects",
    "POST /workspaces/:workspaceId/projects/:projectId/rename",
  ]);
  assert.equal(Object.isFrozen(PROJECT_ROUTES), true);
  assert.equal(Object.isFrozen(PROJECT_ROUTE_ERRORS), true);
  for (const [name, route] of Object.entries(PROJECT_ROUTES)) {
    assert.equal(Object.isFrozen(route), true, name);
    assert.deepEqual(Object.keys(route).sort(), ["method", "path"]);
    assert.match(route.path, /^\/workspaces\/:workspaceId\//u, name);
  }
  const others = new Set(
    [...Object.values(AUTH_ROUTES), ...Object.values(MEMBERSHIP_ROUTES)].map(
      (route) => `${route.method} ${route.path}`,
    ),
  );
  for (const entry of table) {
    assert.equal(others.has(entry), false, entry);
  }
  for (const name of Object.keys(PROJECT_ROUTES)) {
    assert.equal(Object.hasOwn(AUTH_ROUTES, name), false, name);
    assert.equal(Object.hasOwn(MEMBERSHIP_ROUTES, name), false, name);
  }
});

test("every path parameter of a project route is an ID, and routePath fills each route", () => {
  const values = { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID };
  assert.equal(WorkspaceIdSchema.safeParse(WORKSPACE_ID).success, true);
  assert.equal(ProjectIdSchema.safeParse(PROJECT_ID).success, true);
  assert.equal(
    routePath(PROJECT_ROUTES.renameProject.path, values),
    `/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/rename`,
  );
  assert.equal(
    routePath(PROJECT_ROUTES.createProject.path, { workspaceId: WORKSPACE_ID }),
    `/workspaces/${WORKSPACE_ID}/projects`,
  );
  for (const bad of ["not-a-uuid", PROJECT_ID.toUpperCase(), ""]) {
    assert.throws(
      () =>
        routePath(PROJECT_ROUTES.renameProject.path, {
          ...values,
          projectId: bad,
        }),
      TypeError,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () =>
      routePath(PROJECT_ROUTES.renameProject.path, {
        workspaceId: WORKSPACE_ID,
      }),
    TypeError,
  );
});

test("each project route answers only known error codes, the common ones included", () => {
  assert.deepEqual(
    Object.keys(PROJECT_ROUTE_ERRORS),
    Object.keys(PROJECT_ROUTES),
  );
  const known = new Set<string>(API_ERROR_CODES);
  for (const [name, codes] of Object.entries(PROJECT_ROUTE_ERRORS)) {
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
    listProjects: ["not_found"],
    createProject: ["not_found", "conflict", "project_limit"],
    renameProject: ["not_found", "forbidden", "conflict"],
  });
  // Only a creation counts the projects of a workspace (#255), and no
  // project route registers a device.
  const holders = (code: ApiErrorCode) =>
    Object.entries(PROJECT_ROUTE_ERRORS)
      .filter(([, codes]) => codes.includes(code))
      .map(([name]) => name);
  assert.deepEqual(holders("project_limit"), ["createProject"]);
  assert.deepEqual(holders("device_limit"), []);
  assert.deepEqual(holders("device_daily_limit"), []);
  assert.deepEqual(holders("unclaimed_limit"), []);
});

test("the README's project route table lists every project route with its codes", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section =
    readme
      .split(/^## /mu)
      .find((part) => part.startsWith("Project routes\n")) ?? "";
  const rows = section
    .split("\n")
    .filter((line) => /^\| `(?:GET|POST) \//u.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  const names = new Map(
    Object.entries(PROJECT_ROUTES).map(([name, route]) => [
      `\`${route.method} ${route.path}\``,
      name,
    ]),
  );
  const table: Record<string, string[]> = {};
  for (const cells of rows) {
    assert.equal(cells.length, 7, cells[1]);
    const name = names.get(cells[1] ?? "");
    assert.ok(name, `${cells[1]} is not a project route`);
    table[name] = [...(cells[5] ?? "").matchAll(/`([a-z_]+)`/gu)].map(
      (match) => match[1] ?? "",
    );
  }
  assert.deepEqual(Object.keys(table), Object.keys(PROJECT_ROUTES));
  assert.deepEqual(table, specificCodes());
});

test("creating and renaming a project take a name of single-line text from 1 to 100 characters, and nothing else", () => {
  for (const schema of [
    CreateProjectRequestSchema,
    RenameProjectRequestSchema,
  ]) {
    for (const name of [
      "App",
      "a".repeat(100),
      "\u00C4rger",
      "Team \u{1F680}",
    ]) {
      assert.deepEqual(schema.safeParse({ name }).data, { name }, name);
    }
    for (const [label, value] of [
      ["empty", { name: "" }],
      ["over 100", { name: "a".repeat(101) }],
      ["blank", { name: " \t " }],
      ["only white space of other kinds", { name: "\u00A0\u3000\n" }],
      ["line feed inside", { name: "App\nWeb" }],
      ["line separator inside", { name: "App\u2028Web" }],
      ["byte order mark inside", { name: "App\uFEFFWeb" }],
      ["control character", { name: "Ap\u0000p" }],
      ["zero-width space", { name: "Ap\u200Bp" }],
      ["right-to-left override", { name: "\u202EppA" }],
      ["over 1,000 as sent", { name: `${" ".repeat(998)}App` }],
      ["missing", {}],
      ["number", { name: 7 }],
    ] as const) {
      assert.equal(schema.safeParse(value).success, false, label);
    }
    const parsed = schema.parse({
      name: "App",
      workspaceId: OTHER_WORKSPACE_ID,
      createdByUserId: USER_ID,
    });
    assert.deepEqual(parsed, { name: "App" }, "unknown fields are stripped");
  }
});

test("a project name is normalized to NFC and trimmed before it is checked, so names that look the same are the same", () => {
  const composed = "Caf\u00E9";
  const decomposed = "Cafe\u0301";
  assert.notEqual(composed, decomposed);
  assert.equal(normalizeProjectName(decomposed), composed);
  for (const schema of [
    CreateProjectRequestSchema,
    RenameProjectRequestSchema,
  ]) {
    for (const [sent, stored] of [
      [decomposed, composed],
      [composed, composed],
      [" App ", "App"],
      ["\tApp\n", "App"],
      ["\u00A0App\u3000", "App"],
      ["\uFEFF\r\nApp\u2028\r", "App"],
      [` ${decomposed} `, composed],
      // Too long only before trimming.
      [`  ${"a".repeat(100)}  `, "a".repeat(100)],
      // 100 characters only after composing: each "e" with its accent is one.
      ["e\u0301".repeat(100), "\u00E9".repeat(100)],
    ] as const) {
      assert.deepEqual(
        schema.parse({ name: sent }),
        { name: stored },
        JSON.stringify(sent),
      );
    }
  }
  // Inner white space stays as it is.
  assert.equal(normalizeProjectName(" A  B "), "A  B");
  // Workspace and person names stay as they are sent.
  assert.deepEqual(
    CreateWorkspaceRequestSchema.parse({
      name: ` ${decomposed} `,
      displayName: " Ada ",
    }),
    { name: ` ${decomposed} `, displayName: " Ada " },
  );
});

test("the answers carry projects, at most MAX_ANSWER_LIST_ITEMS in a list, and export to JSON Schema", () => {
  assert.deepEqual(CreateProjectResponseSchema.parse({ project }), {
    project,
  });
  for (const [label, value] of [
    ["missing project", {}],
    ["blank name", { project: { ...project, name: " " } }],
    ["bad ID", { project: { ...project, id: "x" } }],
    ["missing workspace", { project: { id: PROJECT_ID, name: "App" } }],
    [
      "missing creator",
      { project: { id: PROJECT_ID, workspaceId: WORKSPACE_ID, name: "App" } },
    ],
    ["bad creator", { project: { ...project, createdByMemberId: "x" } }],
  ] as const) {
    assert.equal(
      CreateProjectResponseSchema.safeParse(value).success,
      false,
      label,
    );
  }
  const full = Array.from({ length: MAX_ANSWER_LIST_ITEMS }, () => project);
  assert.equal(
    ProjectListResponseSchema.safeParse({ projects: full }).success,
    true,
  );
  assert.equal(
    ProjectListResponseSchema.safeParse({ projects: [...full, project] })
      .success,
    false,
  );
  assert.deepEqual(ProjectListResponseSchema.parse({ projects: [] }), {
    projects: [],
  });

  const schemas = {
    listProjects: [null, ProjectListResponseSchema],
    createProject: [CreateProjectRequestSchema, CreateProjectResponseSchema],
    renameProject: [RenameProjectRequestSchema, null],
  } satisfies Record<
    ProjectRouteName,
    [request: z.ZodType | null, response: z.ZodType | null]
  >;
  assert.deepEqual(Object.keys(schemas), Object.keys(PROJECT_ROUTES));
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

test("project events come only from the server, with a system actor and no device", () => {
  for (const event of projectEvents()) {
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

test("project events check the project and its name", () => {
  for (const [label, input] of [
    [
      "a project of another workspace",
      projectEvent("workspace.project.created", {
        project: { ...project, workspaceId: OTHER_WORKSPACE_ID },
      }),
    ],
    [
      "a created project without its creator",
      projectEvent("workspace.project.created", {
        project: { id: PROJECT_ID, workspaceId: WORKSPACE_ID, name: "App" },
      }),
    ],
    [
      "a created project with a blank name",
      projectEvent("workspace.project.created", {
        project: { ...project, name: " " },
      }),
    ],
    [
      "a rename to a name over 100 characters",
      projectEvent("workspace.project.renamed", {
        projectId: PROJECT_ID,
        name: "a".repeat(101),
      }),
    ],
    [
      "a rename to a name with a line feed",
      projectEvent("workspace.project.renamed", {
        projectId: PROJECT_ID,
        name: "App\nWeb",
      }),
    ],
    [
      "a rename without a project",
      projectEvent("workspace.project.renamed", { name: "App" }),
    ],
  ] as const) {
    assert.deepEqual(
      decodeEvent(input),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
});
