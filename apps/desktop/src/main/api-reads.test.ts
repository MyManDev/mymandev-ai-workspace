import {
  AgentListResponseSchema,
  AgentRunListResponseSchema,
  ChatHistoryResponseSchema,
  ClaimListResponseSchema,
  InvitationListResponseSchema,
  JoinRequestListResponseSchema,
  OwnJoinRequestListResponseSchema,
  ProjectListResponseSchema,
  type ProjectId,
  routePath,
  type WorkspaceId,
  WorkspaceListResponseSchema,
  WorkspaceViewResponseSchema,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  MESSAGE_PAGE_LIMIT,
  WORKSPACE_READ_FAILURES,
  WORKSPACE_READS,
  type WorkspaceReadFailure,
  type WorkspaceReadName,
  workspaceReadFailureOf,
  workspaceReadRequest,
} from "./api-reads.ts";
import { callApi, MAX_API_ANSWER_BYTES } from "./session/api-call.ts";
import {
  SESSION_FAILURE_REASONS,
  type SessionFailureReason,
} from "./session/session.ts";

const ORIGIN = "https://api.mymandev.example";
const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1" as WorkspaceId;
const PROJECT_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192e1" as ProjectId;
const KIB = 1024;
const MIB = 1024 * KIB;

/** Each read with its parameters, its filled path, and its cap. */
const READS: [WorkspaceReadName, Record<string, string>, string, number][] = [
  ["listWorkspaces", {}, "/workspaces", 2 * MIB],
  [
    "getWorkspace",
    { workspaceId: WORKSPACE_ID },
    `/workspaces/${WORKSPACE_ID}`,
    1 * MIB,
  ],
  [
    "listProjects",
    { workspaceId: WORKSPACE_ID },
    `/workspaces/${WORKSPACE_ID}/projects`,
    512 * KIB,
  ],
  [
    "listMessages",
    { projectId: PROJECT_ID },
    `/projects/${PROJECT_ID}/messages`,
    4 * MIB,
  ],
  [
    "listAgents",
    { projectId: PROJECT_ID },
    `/projects/${PROJECT_ID}/agents`,
    1 * MIB,
  ],
  [
    "listRuns",
    { projectId: PROJECT_ID },
    `/projects/${PROJECT_ID}/runs`,
    4 * MIB,
  ],
  [
    "listInvitations",
    { workspaceId: WORKSPACE_ID },
    `/workspaces/${WORKSPACE_ID}/invitations`,
    512 * KIB,
  ],
  [
    "listJoinRequests",
    { workspaceId: WORKSPACE_ID },
    `/workspaces/${WORKSPACE_ID}/join-requests`,
    1 * MIB,
  ],
  ["listOwnJoinRequests", {}, "/join-requests", 1 * MIB],
  [
    "listClaims",
    { workspaceId: WORKSPACE_ID },
    `/workspaces/${WORKSPACE_ID}/claims`,
    512 * KIB,
  ],
];

/** Sends the request as the session does, with an answer of exactly `size` bytes. */
async function answerOfSize(
  request: NonNullable<ReturnType<typeof workspaceReadRequest>>,
  size: number,
  declare: boolean,
): Promise<string> {
  const query = new URLSearchParams(request.query).toString();
  const path = routePath(request.route.path, request.params);
  const answer = await callApi({
    fetch: () =>
      Promise.resolve(
        new Response(`"${" ".repeat(size - 2)}"`, {
          status: 200,
          headers: declare ? { "content-length": String(size) } : {},
        }),
      ),
    scheduleTimer: () => () => undefined,
    origin: ORIGIN,
    route: request.route,
    path: query === "" ? path : `${path}?${query}`,
    ...(request.maxAnswerBytes === undefined
      ? {}
      : { maxAnswerBytes: request.maxAnswerBytes }),
  });
  return answer.kind;
}

test("the allowlist holds exactly ten GET reads, frozen", () => {
  expect(Object.keys(WORKSPACE_READS)).toEqual(READS.map(([name]) => name));
  expect(Object.isFrozen(WORKSPACE_READS)).toBe(true);
  for (const entry of Object.values(WORKSPACE_READS)) {
    expect(entry.route.method).toBe("GET");
    expect(Object.isFrozen(entry)).toBe(true);
  }
  // The default for every other route is unchanged.
  expect(MAX_API_ANSWER_BYTES).toBe(512 * KIB);
});

test("each read fills its path, and only listMessages has a query", () => {
  for (const [name, params, path, cap] of READS) {
    const request = workspaceReadRequest(name, params, undefined);
    expect(request, name).not.toBeNull();
    expect(routePath(request!.route.path, request!.params), name).toBe(path);
    expect(request!.maxAnswerBytes, name).toBe(cap);
    expect(request!.query, name).toEqual(
      name === "listMessages"
        ? { limit: String(MESSAGE_PAGE_LIMIT) }
        : undefined,
    );
  }
  const pages: [unknown, Record<string, string> | null][] = [
    [{}, { limit: "50" }],
    [{ beforeSeq: 120 }, { beforeSeq: "120", limit: "50" }],
    [
      { beforeSeq: 7, limit: 1 },
      { beforeSeq: "7", limit: "1" },
    ],
    [
      { beforeSeq: Number.MAX_SAFE_INTEGER },
      { beforeSeq: String(Number.MAX_SAFE_INTEGER), limit: "50" },
    ],
    [{ limit: 51 }, null],
    [{ limit: 0 }, null],
    [{ beforeSeq: 0 }, null],
    [{ beforeSeq: 1.5 }, null],
    [{ beforeSeq: "12" }, null],
    [{ beforeSeq: Number.MAX_SAFE_INTEGER + 1 }, null],
    [{ cursor: "x" }, null],
    [null, null],
    [[], null],
  ];
  for (const [query, encoded] of pages) {
    const request = workspaceReadRequest(
      "listMessages",
      { projectId: PROJECT_ID },
      query,
    );
    expect(request?.query ?? null, JSON.stringify(query)).toEqual(encoded);
  }
});

test("a name off the allowlist, a wrong parameter, or a query of another read is refused", () => {
  const refused: [string, unknown, unknown][] = [
    ["listDevices", {}, undefined],
    ["createWorkspace", {}, undefined],
    ["toString", {}, undefined],
    ["__proto__", {}, undefined],
    ["getWorkspace", {}, undefined],
    ["getWorkspace", { projectId: PROJECT_ID }, undefined],
    ["getWorkspace", { workspaceId: 7 }, undefined],
    ["getWorkspace", { workspaceId: WORKSPACE_ID, x: "y" }, undefined],
    ["listWorkspaces", { workspaceId: WORKSPACE_ID }, undefined],
    ["listWorkspaces", null, undefined],
    ["listAgents", { projectId: PROJECT_ID }, { limit: 5 }],
    ["listRuns", { projectId: PROJECT_ID }, {}],
    ["listInvitations", {}, undefined],
    ["listJoinRequests", { workspaceId: 7 }, undefined],
    ["listOwnJoinRequests", { workspaceId: WORKSPACE_ID }, undefined],
    ["listOwnJoinRequests", {}, { limit: 5 }],
    ["listClaims", {}, undefined],
    ["listClaims", { workspaceId: WORKSPACE_ID }, { limit: 50 }],
  ];
  for (const [name, params, query] of refused) {
    expect(
      workspaceReadRequest(name as WorkspaceReadName, params, query),
      `${name} ${JSON.stringify(params)}`,
    ).toBeNull();
  }
});

test("each read's answer is read up to its cap and refused one byte over it", async () => {
  for (const [name, params, , cap] of READS) {
    const request = workspaceReadRequest(name, params, undefined)!;
    for (const declare of [true, false]) {
      expect(await answerOfSize(request, cap, declare), name).toBe("ok");
      expect(await answerOfSize(request, cap + 1, declare), name).toBe(
        "unexpected_response",
      );
    }
  }
});

test("each read's answer is checked with its response schema", () => {
  const valid: Record<WorkspaceReadName, unknown> = {
    listWorkspaces: { workspaces: [] },
    getWorkspace: null,
    listProjects: { projects: [] },
    listMessages: { messages: [] },
    listAgents: { agents: [] },
    listRuns: { unfinishedRuns: [], finishedRuns: [] },
    listInvitations: { invitations: [] },
    listJoinRequests: { joinRequests: [] },
    listOwnJoinRequests: { joinRequests: [] },
    listClaims: { claims: [] },
  };
  for (const [name, params] of READS) {
    const request = workspaceReadRequest(name, params, undefined)!;
    const schema = request.answer;
    if (schema === "empty") {
      throw new Error("every read has an answer");
    }
    for (const invalid of [{}, [], null, "x", { [name]: 1 }]) {
      expect(schema.safeParse(invalid).success, name).toBe(false);
    }
    if (valid[name] !== null) {
      expect(schema.safeParse(valid[name]).success, name).toBe(true);
    }
  }
});

test("every failure of the session maps into the closed set", () => {
  for (const reason of SESSION_FAILURE_REASONS) {
    expect(WORKSPACE_READ_FAILURES).toContain(
      workspaceReadFailureOf({ ok: false, reason }),
    );
  }
  const refused: [string, string][] = [
    ["not_found", "not_found"],
    ["workspace_not_found", "not_found"],
    ["rate_limited", "rate_limited"],
    ["unauthorized", "not_signed_in"],
    ["device_revoked", "not_signed_in"],
    ["sign_in_required", "not_signed_in"],
    ["auth_failed", "not_signed_in"],
    ["device_account_mismatch", "not_signed_in"],
    ["internal_error", "unavailable"],
    ["forbidden", "failed"],
    ["bad_request", "failed"],
  ];
  for (const [code, reason] of refused) {
    expect(
      workspaceReadFailureOf({
        ok: false,
        reason: "refused",
        code: code as never,
      }),
      code,
    ).toBe(reason);
  }
  expect(
    workspaceReadFailureOf({ ok: false, reason: "unexpected_response" }),
  ).toBe("failed");
  expect(workspaceReadFailureOf({ ok: false, reason: "no_answer" })).toBe(
    "unavailable",
  );
});

test("each read's answer schema is the protocol schema of its route", () => {
  const schemas: Record<WorkspaceReadName, unknown> = {
    listWorkspaces: WorkspaceListResponseSchema,
    getWorkspace: WorkspaceViewResponseSchema,
    listProjects: ProjectListResponseSchema,
    listMessages: ChatHistoryResponseSchema,
    listAgents: AgentListResponseSchema,
    listRuns: AgentRunListResponseSchema,
    listInvitations: InvitationListResponseSchema,
    listJoinRequests: JoinRequestListResponseSchema,
    listOwnJoinRequests: OwnJoinRequestListResponseSchema,
    listClaims: ClaimListResponseSchema,
  };
  expect(Object.keys(WORKSPACE_READS).sort()).toEqual(
    Object.keys(schemas).sort(),
  );
  for (const name of Object.keys(schemas) as WorkspaceReadName[]) {
    expect(WORKSPACE_READS[name].answer, name).toBe(schemas[name]);
  }
});

test("each failure reason of the session maps to its fixed failure", () => {
  // A new reason of the session fails to compile here until it is mapped.
  const expected: Record<SessionFailureReason, WorkspaceReadFailure> = {
    api_origin_unset: "unavailable",
    api_origin_invalid: "unavailable",
    no_device: "not_signed_in",
    key_lost: "not_signed_in",
    key_not_loaded: "not_signed_in",
    record_unreadable: "unavailable",
    key_store_failed: "unavailable",
    signed_out: "not_signed_in",
    sign_in_running: "unavailable",
    replacement_pending: "unavailable",
    removal_pending: "not_signed_in",
    // Without a code.
    refused: "failed",
    record_not_saved: "unavailable",
    invalid_request: "failed",
    no_answer: "unavailable",
    server_error: "unavailable",
    unexpected_response: "failed",
  };
  expect(Object.keys(expected).sort()).toEqual(
    [...SESSION_FAILURE_REASONS].sort(),
  );
  for (const reason of SESSION_FAILURE_REASONS) {
    expect(workspaceReadFailureOf({ ok: false, reason }), reason).toBe(
      expected[reason],
    );
  }
});
