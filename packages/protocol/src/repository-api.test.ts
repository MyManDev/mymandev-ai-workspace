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
  SERVER_EVENT_AUDIENCES,
  SERVER_ONLY_EVENT_TYPES,
  WorkspaceRepositoryRegisteredEventSchema,
  WorkspaceRepositoryRemovedEventSchema,
} from "./envelope.ts";
import { decodeClientMessage, decodeServerMessage } from "./frames.ts";
import { ProjectIdSchema, RepositoryIdSchema } from "./ids.ts";
import { MEMBERSHIP_ROUTES } from "./membership-api.ts";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  type ApiErrorCode,
  MAX_ANSWER_LIST_ITEMS,
} from "./model.ts";
import { CreateProjectRequestSchema, PROJECT_ROUTES } from "./project-api.ts";
import {
  ProjectRepositorySchema,
  RegisterRepositoryRequestSchema,
  RegisterRepositoryResponseSchema,
  REPOSITORY_COUNT_LIMITS,
  REPOSITORY_NAME_PATTERN,
  REPOSITORY_ROUTE_ERRORS,
  REPOSITORY_ROUTES,
  RepositoryListResponseSchema,
  type RepositoryRouteName,
} from "./repository-api.ts";

type Json = Record<string, unknown>;

const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const PROJECT_ID = "0192f2a0-7c3e-7e00-8000-000000000005";
const OTHER_PROJECT_ID = "0192f2a0-7c3e-7e00-8000-000000000015";
const EVENT_ID = "0192f2a0-7c3e-7e00-8000-000000000006";
const DEVICE_ID = "0192f2a0-7c3e-7e00-8000-000000000007";
const REPOSITORY_ID = "0192f2a0-7c3e-7e00-8000-000000000008";
const OTHER_REPOSITORY_ID = "0192f2a0-7c3e-7e00-8000-000000000018";
const USER_ID = "0192f2a0-7c3e-7f00-a000-000000000002";
const MEMBER_ID = "0192f2a0-7c3e-7d2e-9f10-112233445502";
const NOW = "2026-11-14T12:00:00.000Z";

/** A backslash, kept out of the string literals below. */
const BACKSLASH = String.fromCharCode(0x5c);

const repository = {
  id: REPOSITORY_ID,
  projectId: PROJECT_ID,
  name: "App",
  createdByMemberId: MEMBER_ID,
};

/** The codes that every repository route can answer, as every membership route can. */
const COMMON_CODES: readonly string[] = [
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
];

/** The codes of each route beyond the common ones, in their order. */
function specificCodes(): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(REPOSITORY_ROUTE_ERRORS).map(([name, codes]) => [
      name,
      codes.filter((code) => !COMMON_CODES.includes(code)),
    ]),
  );
}

function repositoryEvent(type: string, payload: Json): Json {
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

function repositoryEvents(): Json[] {
  return [
    repositoryEvent("workspace.repository.registered", { repository }),
    repositoryEvent("workspace.repository.removed", {
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
    }),
  ];
}

/** What a device must never send as, or with, a repository: a folder's path or a remote URL. */
function pathsAndUrls(): [label: string, value: string][] {
  return [
    ["an absolute path", "/srv/code/app"],
    ["a path in the home folder", "~/code/app"],
    ["a relative path", "code/app"],
    ["a path to the parent folder", "../app"],
    ["a path with a trailing slash", "app/"],
    ["a drive path", `D:${BACKSLASH}code${BACKSLASH}app`],
    ["a drive path with slashes", "D:/code/app"],
    ["a network share", `${BACKSLASH}${BACKSLASH}server${BACKSLASH}app`],
    ["a relative path with backslashes", `code${BACKSLASH}app`],
    ["a file URL", "file:///srv/code/app"],
    ["a remote URL", "https://example.com/team/app.git"],
    ["a remote URL without a scheme", "example.com:team/app.git"],
    ["an owner and a name", "team/app"],
  ];
}

test("the repository routes are fixed, frozen, under the project's path, and apart from the other routes", () => {
  const table = Object.values(REPOSITORY_ROUTES).map(
    (route) => `${route.method} ${route.path}`,
  );
  assert.deepEqual(table, [
    "GET /projects/:projectId/repositories",
    "POST /projects/:projectId/repositories",
    "POST /projects/:projectId/repositories/:repositoryId/remove",
  ]);
  assert.equal(Object.isFrozen(REPOSITORY_ROUTES), true);
  assert.equal(Object.isFrozen(REPOSITORY_ROUTE_ERRORS), true);
  for (const [name, route] of Object.entries(REPOSITORY_ROUTES)) {
    assert.equal(Object.isFrozen(route), true, name);
    assert.deepEqual(Object.keys(route).sort(), ["method", "path"]);
    assert.match(route.path, /^\/projects\/:projectId\//u, name);
  }
  const otherRoutes = [
    AUTH_ROUTES,
    MEMBERSHIP_ROUTES,
    PROJECT_ROUTES,
    CHAT_ROUTES,
    AGENT_ROUTES,
  ];
  const others = new Set(
    otherRoutes
      .flatMap((routes) => Object.values(routes))
      .map((route) => `${route.method} ${route.path}`),
  );
  for (const entry of table) {
    assert.equal(others.has(entry), false, entry);
  }
  for (const name of Object.keys(REPOSITORY_ROUTES)) {
    for (const routes of otherRoutes) {
      assert.equal(Object.hasOwn(routes, name), false, name);
    }
  }
});

test("every path parameter of a repository route is an ID, and routePath fills each route", () => {
  const values = { projectId: PROJECT_ID, repositoryId: REPOSITORY_ID };
  assert.equal(ProjectIdSchema.safeParse(PROJECT_ID).success, true);
  assert.equal(RepositoryIdSchema.safeParse(REPOSITORY_ID).success, true);
  assert.equal(
    routePath(REPOSITORY_ROUTES.removeRepository.path, values),
    `/projects/${PROJECT_ID}/repositories/${REPOSITORY_ID}/remove`,
  );
  for (const name of ["listRepositories", "registerRepository"] as const) {
    assert.equal(
      routePath(REPOSITORY_ROUTES[name].path, { projectId: PROJECT_ID }),
      `/projects/${PROJECT_ID}/repositories`,
    );
  }
  // A name, a path, or anything else that is not an ID never fills a path.
  for (const bad of ["not-a-uuid", REPOSITORY_ID.toUpperCase(), "", "App"]) {
    assert.throws(
      () =>
        routePath(REPOSITORY_ROUTES.removeRepository.path, {
          ...values,
          repositoryId: bad,
        }),
      TypeError,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () =>
      routePath(REPOSITORY_ROUTES.removeRepository.path, {
        projectId: PROJECT_ID,
      }),
    TypeError,
  );
});

test("each repository route answers only known error codes, the common ones included, and only a registration answers repository_limit", () => {
  assert.deepEqual(
    Object.keys(REPOSITORY_ROUTE_ERRORS),
    Object.keys(REPOSITORY_ROUTES),
  );
  const known = new Set<string>(API_ERROR_CODES);
  for (const [name, codes] of Object.entries(REPOSITORY_ROUTE_ERRORS)) {
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
    listRepositories: ["not_found"],
    registerRepository: ["not_found", "conflict", "repository_limit"],
    removeRepository: ["not_found", "forbidden", "conflict"],
  });
  const holders = (code: ApiErrorCode) =>
    Object.entries(REPOSITORY_ROUTE_ERRORS)
      .filter(([, codes]) => codes.includes(code))
      .map(([name]) => name);
  assert.deepEqual(holders("repository_limit"), ["registerRepository"]);
  // The other limits that no time frees have their own routes.
  assert.deepEqual(holders("project_limit"), []);
  assert.deepEqual(holders("agent_limit"), []);
  assert.deepEqual(holders("provider_connection_limit"), []);
  assert.deepEqual(holders("device_limit"), []);
  assert.deepEqual(holders("unclaimed_limit"), []);
  // No time frees a place, so the status is a conflict and not a wait.
  assert.equal(API_ERROR_STATUS.repository_limit, 409);
});

test("the README's repository route table lists every repository route with its codes", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section =
    readme
      .split(/^## /mu)
      .find((part) => part.startsWith("Repository routes\n")) ?? "";
  const rows = section
    .split("\n")
    .filter((line) => /^\| `(?:GET|POST) \//u.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  const names = new Map(
    Object.entries(REPOSITORY_ROUTES).map(([name, route]) => [
      `\`${route.method} ${route.path}\``,
      name,
    ]),
  );
  const table: Record<string, string[]> = {};
  for (const cells of rows) {
    assert.equal(cells.length, 7, cells[1]);
    const name = names.get(cells[1] ?? "");
    assert.ok(name, `${cells[1]} is not a repository route`);
    table[name] = [...(cells[5] ?? "").matchAll(/`([a-z_]+)`/gu)].map(
      (match) => match[1] ?? "",
    );
  }
  assert.deepEqual(Object.keys(table), Object.keys(REPOSITORY_ROUTES));
  assert.deepEqual(table, specificCodes());
  // The limits in the text are the limits in force.
  assert.ok(
    section.includes(
      `at most ${REPOSITORY_COUNT_LIMITS.perProject} repositories that are not removed`,
    ),
  );
  assert.ok(
    section.includes(
      `at most ${REPOSITORY_COUNT_LIMITS.perDay} repositories in 24 hours`,
    ),
  );
});

test("the limits of repositories are fixed, frozen, and far below the size of a list in an answer", () => {
  assert.deepEqual(REPOSITORY_COUNT_LIMITS, { perProject: 20, perDay: 20 });
  assert.equal(Object.isFrozen(REPOSITORY_COUNT_LIMITS), true);
  assert.ok(REPOSITORY_COUNT_LIMITS.perProject < MAX_ANSWER_LIST_ITEMS);
});

test("a registration takes a name of single-line text from 1 to 100 characters, and nothing else", () => {
  const schema = RegisterRepositoryRequestSchema;
  for (const name of [
    "App",
    "a".repeat(100),
    "\u00C4rger",
    "Team \u{1F680}",
    "mobile-app.v2",
    "App: web (2026)",
  ]) {
    assert.deepEqual(schema.safeParse({ name }).data, { name }, name);
  }
  for (const [label, value] of [
    ["empty", { name: "" }],
    ["over 100", { name: "a".repeat(101) }],
    ["blank", { name: " \t " }],
    ["only white space of other kinds", { name: "\u00A0\u3000" }],
    ["line feed inside", { name: "App\nWeb" }],
    ["line separator inside", { name: "App\u2028Web" }],
    ["byte order mark inside", { name: "App\uFEFFWeb" }],
    ["control character", { name: "Ap\u0000p" }],
    ["zero-width space", { name: "Ap\u200Bp" }],
    ["right-to-left override", { name: "\u202EppA" }],
    ["missing", {}],
    ["null", { name: null }],
    ["number", { name: 7 }],
    ["a list", { name: ["App"] }],
  ] as const) {
    assert.equal(schema.safeParse(value).success, false, label);
  }
  // The body's only field is the name.
  assert.deepEqual(Object.keys(schema.shape), ["name"]);
});

test("a registration strips every field beyond the name, a path and a remote URL included", () => {
  const sent = {
    name: "App",
    path: "/srv/code/app",
    localPath: "/srv/code/app",
    rootPath: `D:${BACKSLASH}code${BACKSLASH}app`,
    folder: "app",
    remoteUrl: "https://example.com/team/app.git",
    url: "https://example.com/team/app.git",
    remote: { name: "origin", url: "https://example.com/team/app.git" },
    id: OTHER_REPOSITORY_ID,
    projectId: OTHER_PROJECT_ID,
    createdByMemberId: MEMBER_ID,
    createdByUserId: USER_ID,
  };
  const before = structuredClone(sent);
  assert.deepEqual(RegisterRepositoryRequestSchema.parse(sent), {
    name: "App",
  });
  assert.deepEqual(sent, before, "the input is not changed");
});

test("a name that holds a slash or a backslash is refused, so a folder's path or a remote URL never travels as a name", () => {
  for (const [label, name] of pathsAndUrls()) {
    assert.equal(REPOSITORY_NAME_PATTERN.test(name), false, label);
    assert.equal(
      RegisterRepositoryRequestSchema.safeParse({ name }).success,
      false,
      label,
    );
  }
  for (const name of ["/", BACKSLASH, "a/b", `a${BACKSLASH}b`]) {
    assert.equal(
      RegisterRepositoryRequestSchema.safeParse({ name }).success,
      false,
      JSON.stringify(name),
    );
  }
  // Other punctuation stays allowed: a name is a label, not an identifier.
  for (const name of ["app.git", "D:", "~app", "app | web", "100% app"]) {
    assert.equal(
      RegisterRepositoryRequestSchema.safeParse({ name }).success,
      true,
      name,
    );
  }
  // The pattern is anchored, and the schema keeps its own copy of it.
  assert.equal(REPOSITORY_NAME_PATTERN.source, "^[^/\\\\]*$");
  assert.equal(REPOSITORY_NAME_PATTERN.flags, "u");
  // A project's name has no such rule.
  assert.equal(
    CreateProjectRequestSchema.safeParse({ name: "team/app" }).success,
    true,
  );
});

test("a repository name is stored as sent: it is neither normalized nor trimmed, unlike a project's name", () => {
  const decomposed = "Cafe\u0301";
  for (const name of [decomposed, " App ", "App  Web"]) {
    assert.deepEqual(
      RegisterRepositoryRequestSchema.parse({ name }),
      { name },
      JSON.stringify(name),
    );
  }
  assert.deepEqual(CreateProjectRequestSchema.parse({ name: " App " }), {
    name: "App",
  });
});

test("a repository carries its ID, its project, its name, and who registered it, and no path or remote URL", () => {
  assert.deepEqual(Object.keys(ProjectRepositorySchema.shape), [
    "id",
    "projectId",
    "name",
    "createdByMemberId",
  ]);
  assert.deepEqual(ProjectRepositorySchema.parse(repository), repository);
  // Whatever a server adds, a parsed repository holds only its four fields.
  assert.deepEqual(
    ProjectRepositorySchema.parse({
      ...repository,
      path: "/srv/code/app",
      remoteUrl: "https://example.com/team/app.git",
      createdByUserId: USER_ID,
    }),
    repository,
  );
  // An answer carries the stored name, which the rule for a sent name does
  // not bind, so that a change of that rule never breaks a reader.
  for (const name of ["team/app", " App ", "Archived repository"]) {
    assert.equal(
      ProjectRepositorySchema.safeParse({ ...repository, name }).success,
      true,
      name,
    );
  }
  for (const [label, value] of [
    ["blank name", { ...repository, name: " " }],
    ["name over 100", { ...repository, name: "a".repeat(101) }],
    ["name with a line feed", { ...repository, name: "App\nWeb" }],
    ["bad ID", { ...repository, id: "x" }],
    ["bad project", { ...repository, projectId: "x" }],
    ["bad registrant", { ...repository, createdByMemberId: "x" }],
    [
      "missing registrant",
      { id: REPOSITORY_ID, projectId: PROJECT_ID, name: "App" },
    ],
    [
      "missing project",
      { id: REPOSITORY_ID, name: "App", createdByMemberId: MEMBER_ID },
    ],
  ] as const) {
    assert.equal(
      ProjectRepositorySchema.safeParse(value).success,
      false,
      label,
    );
  }
});

test("the answers carry repositories of one project, each once, at most MAX_ANSWER_LIST_ITEMS in a list, and export to JSON Schema", () => {
  assert.deepEqual(RegisterRepositoryResponseSchema.parse({ repository }), {
    repository,
  });
  for (const [label, value] of [
    ["missing repository", {}],
    ["blank name", { repository: { ...repository, name: " " } }],
    ["bad ID", { repository: { ...repository, id: "x" } }],
  ] as const) {
    assert.equal(
      RegisterRepositoryResponseSchema.safeParse(value).success,
      false,
      label,
    );
  }

  const other = { ...repository, id: OTHER_REPOSITORY_ID, name: "Web" };
  assert.deepEqual(
    RepositoryListResponseSchema.parse({ repositories: [repository, other] }),
    { repositories: [repository, other] },
  );
  assert.deepEqual(RepositoryListResponseSchema.parse({ repositories: [] }), {
    repositories: [],
  });
  // Two repositories may share a name: a name is a label.
  assert.equal(
    RepositoryListResponseSchema.safeParse({
      repositories: [repository, { ...other, name: repository.name }],
    }).success,
    true,
  );
  for (const [label, repositories] of [
    ["a repository listed twice", [repository, repository]],
    [
      "a repository of another project",
      [repository, { ...other, projectId: OTHER_PROJECT_ID }],
    ],
  ] as const) {
    assert.equal(
      RepositoryListResponseSchema.safeParse({ repositories }).success,
      false,
      label,
    );
  }
  assert.equal(RepositoryListResponseSchema.safeParse({}).success, false);

  // Distinct IDs in the canonical form, the last 12 digits counting up.
  const full = Array.from(
    { length: MAX_ANSWER_LIST_ITEMS + 1 },
    (_, index) => ({
      ...repository,
      id: `0192f2a0-7c3e-7e00-8000-${String(index).padStart(12, "0")}`,
    }),
  );
  assert.equal(
    RepositoryListResponseSchema.safeParse({
      repositories: full.slice(0, MAX_ANSWER_LIST_ITEMS),
    }).success,
    true,
  );
  assert.equal(
    RepositoryListResponseSchema.safeParse({ repositories: full }).success,
    false,
  );

  const schemas = {
    listRepositories: [null, RepositoryListResponseSchema],
    registerRepository: [
      RegisterRepositoryRequestSchema,
      RegisterRepositoryResponseSchema,
    ],
    removeRepository: [null, null],
  } satisfies Record<
    RepositoryRouteName,
    [request: z.ZodType | null, response: z.ZodType | null]
  >;
  assert.deepEqual(Object.keys(schemas), Object.keys(REPOSITORY_ROUTES));
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
  // The exported request schema carries the rule of the name.
  const exported = z.toJSONSchema(RegisterRepositoryRequestSchema, {
    io: "input",
  });
  assert.ok(JSON.stringify(exported).includes(JSON.stringify("^[^/\\\\]*$")));
});

test("repository events come only from the server, with a system actor and no device", () => {
  for (const event of repositoryEvents()) {
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

test("repository events go to every member of the workspace, never only to the approvers", () => {
  for (const type of [
    "workspace.repository.registered",
    "workspace.repository.removed",
  ] as const) {
    assert.equal(SERVER_EVENT_AUDIENCES[type], "members", type);
    assert.equal(
      (APPROVER_EVENT_TYPES as readonly string[]).includes(type),
      false,
      type,
    );
  }
});

test("repository events check the repository and the IDs, and carry nothing else", () => {
  for (const [label, input] of [
    [
      "a registered repository without who registered it",
      repositoryEvent("workspace.repository.registered", {
        repository: { id: REPOSITORY_ID, projectId: PROJECT_ID, name: "App" },
      }),
    ],
    [
      "a registered repository with a blank name",
      repositoryEvent("workspace.repository.registered", {
        repository: { ...repository, name: " " },
      }),
    ],
    [
      "a registered repository with a name over 100 characters",
      repositoryEvent("workspace.repository.registered", {
        repository: { ...repository, name: "a".repeat(101) },
      }),
    ],
    [
      "a registered repository without a project",
      repositoryEvent("workspace.repository.registered", {
        repository: {
          id: REPOSITORY_ID,
          name: "App",
          createdByMemberId: MEMBER_ID,
        },
      }),
    ],
    [
      "a registration without a repository",
      repositoryEvent("workspace.repository.registered", {}),
    ],
    [
      "a removal without a repository",
      repositoryEvent("workspace.repository.removed", {
        projectId: PROJECT_ID,
      }),
    ],
    [
      "a removal without a project",
      repositoryEvent("workspace.repository.removed", {
        repositoryId: REPOSITORY_ID,
      }),
    ],
    [
      "a removal that names the repository by its name",
      repositoryEvent("workspace.repository.removed", {
        projectId: PROJECT_ID,
        repositoryId: "App",
      }),
    ],
  ] as const) {
    assert.deepEqual(
      decodeEvent(input),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }

  // The payloads have no field for a path or a remote URL, and a decoded
  // event holds none, whatever was sent.
  assert.deepEqual(
    Object.keys(WorkspaceRepositoryRegisteredEventSchema.shape.payload.shape),
    ["repository"],
  );
  assert.deepEqual(
    Object.keys(WorkspaceRepositoryRemovedEventSchema.shape.payload.shape),
    ["projectId", "repositoryId"],
  );
  const [registered, removed] = repositoryEvents();
  assert.ok(registered !== undefined && removed !== undefined);
  assert.deepEqual(
    decodeEvent({
      ...registered,
      payload: {
        repository: { ...repository, path: "/srv/code/app" },
        remoteUrl: "https://example.com/team/app.git",
      },
    }),
    { ok: true, event: registered },
  );
  assert.deepEqual(
    decodeEvent({
      ...removed,
      payload: {
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        path: "/srv/code/app",
      },
    }),
    { ok: true, event: removed },
  );
});
