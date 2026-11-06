import {
  AcceptInvitationRequestSchema,
  AcceptInvitationResponseSchema,
  API_ERROR_CODES,
  type ApiErrorCode,
  ApproveJoinRequestRequestSchema,
  ApproveJoinRequestResponseSchema,
  CreateInvitationRequestSchema,
  CreateInvitationResponseSchema,
  CreateJoinRequestRequestSchema,
  CreateJoinRequestResponseSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  DefineMemberRequestSchema,
  DefineMemberResponseSchema,
  INVITATION_CODE_PATTERN,
  MEMBERSHIP_ROUTE_ERRORS,
  MEMBERSHIP_ROUTES,
  OfferOwnershipRequestSchema,
  PreviewInvitationRequestSchema,
  PreviewInvitationResponseSchema,
  PROJECT_ROUTE_ERRORS,
  PROJECT_ROUTES,
  RenameMemberRequestSchema,
  routePath,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  ACTION_RATE_LIMITED_WAIT_MS,
  WORKSPACE_ACTION_BUDGET,
  WORKSPACE_ACTION_FAILURES,
  WORKSPACE_ACTIONS,
  type WorkspaceActionFailure,
  type WorkspaceActionName,
  workspaceActionFailed,
  workspaceActionFailedFor,
  workspaceActionFailureOf,
  workspaceActionRequest,
} from "./api-actions.ts";
import {
  SESSION_FAILURE_REASONS,
  type SessionFailureReason,
} from "./session/session.ts";

const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1";
const MEMBER_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f1";
const INVITATION_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819301";
const JOIN_REQUEST_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819311";
/** An invitation code of the protocol's format, as a person pastes it. */
const CODE = `mmdi_${"Q7x-_9kPz2".repeat(4)}Lmw`;

const W = `/workspaces/${WORKSPACE_ID}`;
const IN_WORKSPACE = { workspaceId: WORKSPACE_ID };
const OF_MEMBER = { workspaceId: WORKSPACE_ID, memberId: MEMBER_ID };
const OF_REQUEST = {
  workspaceId: WORKSPACE_ID,
  joinRequestId: JOIN_REQUEST_ID,
};

/** Each write with its parameters, its body, its filled path, and the body sent. */
const ACTIONS: [
  WorkspaceActionName,
  Record<string, string>,
  unknown,
  string,
  unknown,
][] = [
  [
    "createWorkspace",
    {},
    { name: "Team", displayName: "Ada" },
    "/workspaces",
    { name: "Team", displayName: "Ada" },
  ],
  [
    "defineMember",
    IN_WORKSPACE,
    { displayName: "Grace" },
    `${W}/members`,
    { displayName: "Grace" },
  ],
  [
    "renameMember",
    OF_MEMBER,
    { displayName: "Grace H." },
    `${W}/members/${MEMBER_ID}/rename`,
    { displayName: "Grace H." },
  ],
  [
    "removeMember",
    OF_MEMBER,
    undefined,
    `${W}/members/${MEMBER_ID}/remove`,
    undefined,
  ],
  [
    "promoteMember",
    OF_MEMBER,
    undefined,
    `${W}/members/${MEMBER_ID}/promote`,
    undefined,
  ],
  [
    "demoteMember",
    OF_MEMBER,
    undefined,
    `${W}/members/${MEMBER_ID}/demote`,
    undefined,
  ],
  ["leaveWorkspace", IN_WORKSPACE, undefined, `${W}/leave`, undefined],
  [
    "offerOwnership",
    IN_WORKSPACE,
    { memberId: MEMBER_ID },
    `${W}/ownership-offer`,
    { memberId: MEMBER_ID },
  ],
  [
    "acceptOwnershipOffer",
    IN_WORKSPACE,
    undefined,
    `${W}/ownership-offer/accept`,
    undefined,
  ],
  [
    "withdrawOwnershipOffer",
    IN_WORKSPACE,
    undefined,
    `${W}/ownership-offer/withdraw`,
    undefined,
  ],
  [
    "createInvitation",
    IN_WORKSPACE,
    { memberId: MEMBER_ID, lifetimeSeconds: 3_600 },
    `${W}/invitations`,
    { memberId: MEMBER_ID, lifetimeSeconds: 3_600 },
  ],
  [
    "revokeInvitation",
    { workspaceId: WORKSPACE_ID, invitationId: INVITATION_ID },
    undefined,
    `${W}/invitations/${INVITATION_ID}/revoke`,
    undefined,
  ],
  [
    "previewInvitation",
    {},
    { code: CODE },
    "/invitations/preview",
    { code: CODE },
  ],
  [
    "acceptInvitation",
    {},
    { code: CODE },
    "/invitations/accept",
    { code: CODE },
  ],
  [
    "createJoinRequest",
    {},
    { workspaceId: WORKSPACE_ID, displayName: "Ada" },
    "/join-requests",
    { workspaceId: WORKSPACE_ID, displayName: "Ada" },
  ],
  [
    "withdrawJoinRequest",
    { joinRequestId: JOIN_REQUEST_ID },
    undefined,
    `/join-requests/${JOIN_REQUEST_ID}/withdraw`,
    undefined,
  ],
  [
    "approveJoinRequest",
    OF_REQUEST,
    { displayName: "Ada L." },
    `${W}/join-requests/${JOIN_REQUEST_ID}/approve`,
    { displayName: "Ada L." },
  ],
  [
    "denyJoinRequest",
    OF_REQUEST,
    undefined,
    `${W}/join-requests/${JOIN_REQUEST_ID}/deny`,
    undefined,
  ],
  [
    "denyAllJoinRequests",
    IN_WORKSPACE,
    undefined,
    `${W}/join-requests/deny-all`,
    undefined,
  ],
  [
    "blockJoinRequest",
    OF_REQUEST,
    undefined,
    `${W}/join-requests/${JOIN_REQUEST_ID}/block`,
    undefined,
  ],
  [
    "unblockJoinRequest",
    OF_REQUEST,
    undefined,
    `${W}/join-requests/${JOIN_REQUEST_ID}/unblock`,
    undefined,
  ],
  [
    "pauseJoinRequests",
    IN_WORKSPACE,
    undefined,
    `${W}/join-requests/pause`,
    undefined,
  ],
  [
    "resumeJoinRequests",
    IN_WORKSPACE,
    undefined,
    `${W}/join-requests/resume`,
    undefined,
  ],
  [
    "createProject",
    IN_WORKSPACE,
    // Sent normalized: NFC and without the white space around it.
    { name: "  Café " },
    `${W}/projects`,
    { name: "Café" },
  ],
];

/** The `:name` parameters of a route path, in order. */
function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/gu)].map(
    (match) => match[1] as string,
  );
}

test("the allowlist holds exactly the 24 POST writes of the screens, frozen, each the protocol's route with its path parameters", () => {
  expect(Object.keys(WORKSPACE_ACTIONS)).toEqual(ACTIONS.map(([name]) => name));
  expect(Object.isFrozen(WORKSPACE_ACTIONS)).toBe(true);
  for (const [name, entry] of Object.entries(WORKSPACE_ACTIONS)) {
    expect(entry.route.method, name).toBe("POST");
    expect(Object.isFrozen(entry), name).toBe(true);
    expect(Object.isFrozen(entry.params), name).toBe(true);
    expect(entry.params, name).toEqual(pathParams(entry.route.path));
    const protocol =
      name === "createProject"
        ? PROJECT_ROUTES.createProject
        : MEMBERSHIP_ROUTES[name as keyof typeof MEMBERSHIP_ROUTES];
    expect(entry.route, name).toBe(protocol);
  }
  // Left out: the owner's limit of unclaimed people and project renames,
  // which no screen of #95 sends, and every read.
  expect(Object.keys(WORKSPACE_ACTIONS)).not.toContain(
    "setUnclaimedMemberLimit",
  );
  expect(Object.keys(WORKSPACE_ACTIONS)).not.toContain("renameProject");
});

test("each write fills its path with its IDs and sends its body as its schema parsed it", () => {
  for (const [name, params, body, path, sent] of ACTIONS) {
    const request = workspaceActionRequest(name, params, body);
    expect(request, name).not.toBeNull();
    expect(routePath(request!.route.path, request!.params), name).toBe(path);
    expect(request!.body, name).toEqual(sent);
    expect("body" in request!, name).toBe(sent !== undefined);
    expect(request!.query, name).toBeUndefined();
    // Every answer is small: the session's default cap holds it.
    expect(request!.maxAnswerBytes, name).toBeUndefined();
    expect(Object.isFrozen(request), name).toBe(true);
  }
  // The display name of an approval is optional.
  expect(
    workspaceActionRequest("approveJoinRequest", OF_REQUEST, {})?.body,
  ).toEqual({});
  // So is the lifetime of an invitation and the limit of a new workspace.
  expect(
    workspaceActionRequest("createInvitation", IN_WORKSPACE, {
      memberId: MEMBER_ID,
    })?.body,
  ).toEqual({ memberId: MEMBER_ID });
  expect(
    workspaceActionRequest(
      "createWorkspace",
      {},
      { name: "Team", displayName: "Ada", maxUnclaimedMembers: 20 },
    )?.body,
  ).toEqual({ name: "Team", displayName: "Ada", maxUnclaimedMembers: 20 });
});

test("each write's request and answer schemas are the protocol's", () => {
  const schemas: Record<WorkspaceActionName, [unknown, unknown]> = {
    createWorkspace: [
      CreateWorkspaceRequestSchema,
      CreateWorkspaceResponseSchema,
    ],
    defineMember: [DefineMemberRequestSchema, DefineMemberResponseSchema],
    renameMember: [RenameMemberRequestSchema, "empty"],
    removeMember: [null, "empty"],
    promoteMember: [null, "empty"],
    demoteMember: [null, "empty"],
    leaveWorkspace: [null, "empty"],
    offerOwnership: [OfferOwnershipRequestSchema, "empty"],
    acceptOwnershipOffer: [null, "empty"],
    withdrawOwnershipOffer: [null, "empty"],
    createInvitation: [
      CreateInvitationRequestSchema,
      CreateInvitationResponseSchema,
    ],
    revokeInvitation: [null, "empty"],
    previewInvitation: [
      PreviewInvitationRequestSchema,
      PreviewInvitationResponseSchema,
    ],
    acceptInvitation: [
      AcceptInvitationRequestSchema,
      AcceptInvitationResponseSchema,
    ],
    createJoinRequest: [
      CreateJoinRequestRequestSchema,
      CreateJoinRequestResponseSchema,
    ],
    withdrawJoinRequest: [null, "empty"],
    approveJoinRequest: [
      ApproveJoinRequestRequestSchema,
      ApproveJoinRequestResponseSchema,
    ],
    denyJoinRequest: [null, "empty"],
    denyAllJoinRequests: [null, "empty"],
    blockJoinRequest: [null, "empty"],
    unblockJoinRequest: [null, "empty"],
    pauseJoinRequests: [null, "empty"],
    resumeJoinRequests: [null, "empty"],
    createProject: [CreateProjectRequestSchema, CreateProjectResponseSchema],
  };
  expect(Object.keys(WORKSPACE_ACTIONS).sort()).toEqual(
    Object.keys(schemas).sort(),
  );
  for (const name of Object.keys(schemas) as WorkspaceActionName[]) {
    const [body, answer] = schemas[name];
    expect(WORKSPACE_ACTIONS[name].body, name).toBe(body);
    expect(WORKSPACE_ACTIONS[name].answer, name).toBe(answer);
  }
  for (const [name, params, body] of ACTIONS) {
    expect(workspaceActionRequest(name, params, body)?.answer, name).toBe(
      schemas[name][1],
    );
  }
});

test("a name off the allowlist, a missing, extra, or invalid path parameter, or a body outside its schema is refused", () => {
  const upper = WORKSPACE_ID.toUpperCase();
  const v4 = "0192f2a0-7c3e-4a1b-8c4d-5e6f708192d1";
  const refused: [string, unknown, unknown][] = [
    // Off the allowlist: a read, a route that no screen sends, a device
    // action, and names of every object.
    ["listWorkspaces", {}, undefined],
    ["getWorkspace", IN_WORKSPACE, undefined],
    ["setUnclaimedMemberLimit", IN_WORKSPACE, { maxUnclaimedMembers: 5 }],
    ["renameProject", IN_WORKSPACE, { name: "x" }],
    ["revokeDevice", {}, undefined],
    ["toString", {}, undefined],
    ["__proto__", {}, undefined],
    ["constructor", {}, undefined],
    // Path parameters.
    ["leaveWorkspace", {}, undefined],
    ["leaveWorkspace", null, undefined],
    ["leaveWorkspace", [WORKSPACE_ID], undefined],
    ["leaveWorkspace", { workspaceId: 7 }, undefined],
    ["leaveWorkspace", { workspaceId: upper }, undefined],
    ["leaveWorkspace", { workspaceId: v4 }, undefined],
    ["leaveWorkspace", { workspaceId: "../devices" }, undefined],
    ["leaveWorkspace", { workspaceId: `${WORKSPACE_ID}/` }, undefined],
    ["leaveWorkspace", { ...IN_WORKSPACE, memberId: MEMBER_ID }, undefined],
    ["removeMember", IN_WORKSPACE, undefined],
    [
      "removeMember",
      { workspaceId: WORKSPACE_ID, member: MEMBER_ID },
      undefined,
    ],
    ["withdrawJoinRequest", IN_WORKSPACE, undefined],
    ["createWorkspace", IN_WORKSPACE, { name: "Team", displayName: "Ada" }],
    // Bodies: one for a route without a body, none or another for one with.
    ["leaveWorkspace", IN_WORKSPACE, {}],
    ["leaveWorkspace", IN_WORKSPACE, null],
    ["defineMember", IN_WORKSPACE, undefined],
    ["defineMember", IN_WORKSPACE, null],
    ["defineMember", IN_WORKSPACE, [{ displayName: "Grace" }]],
    ["defineMember", IN_WORKSPACE, { displayName: "" }],
    ["defineMember", IN_WORKSPACE, { displayName: "   " }],
    ["defineMember", IN_WORKSPACE, { displayName: "a".repeat(65) }],
    ["defineMember", IN_WORKSPACE, { displayName: "a\nb" }],
    ["defineMember", IN_WORKSPACE, { displayName: "Grace", role: "admin" }],
    ["createWorkspace", {}, { name: "Team" }],
    [
      "createWorkspace",
      {},
      { name: "Team", displayName: "Ada", maxUnclaimedMembers: 501 },
    ],
    ["offerOwnership", IN_WORKSPACE, { memberId: upper }],
    [
      "createInvitation",
      IN_WORKSPACE,
      { memberId: MEMBER_ID, lifetimeSeconds: 60 },
    ],
    ["createJoinRequest", {}, { workspaceId: v4, displayName: "Ada" }],
    [
      "createJoinRequest",
      IN_WORKSPACE,
      { workspaceId: WORKSPACE_ID, displayName: "Ada" },
    ],
    ["approveJoinRequest", OF_REQUEST, undefined],
    ["approveJoinRequest", OF_REQUEST, { displayName: "" }],
    ["createProject", IN_WORKSPACE, { name: " \t " }],
    ["createProject", IN_WORKSPACE, { name: "a".repeat(101) }],
  ];
  for (const [name, params, body] of refused) {
    expect(
      workspaceActionRequest(name as WorkspaceActionName, params, body),
      `${name} ${JSON.stringify(params)} ${JSON.stringify(body)}`,
    ).toBeNull();
  }
});

test("only a pasted text of the protocol's code format is sent, in the body and never in the path", () => {
  expect(INVITATION_CODE_PATTERN.test(CODE)).toBe(true);
  for (const name of ["previewInvitation", "acceptInvitation"] as const) {
    const request = workspaceActionRequest(name, {}, { code: CODE })!;
    expect(request.body).toEqual({ code: CODE });
    expect(request.params).toEqual({});
    expect(routePath(request.route.path, request.params)).not.toContain(CODE);

    const notCodes: unknown[] = [
      "",
      ` ${CODE}`,
      `${CODE}\n`,
      CODE.toUpperCase(),
      CODE.slice(0, -1),
      `${CODE}A`,
      // The last character of 32 bytes in base64url is one of 16.
      `${CODE.slice(0, -1)}B`,
      `mmdc_${CODE.slice(5)}`,
      `mmda_${CODE.slice(5)}`,
      CODE.replace("_", "-"),
      7,
      null,
    ];
    for (const code of notCodes) {
      expect(
        workspaceActionRequest(name, {}, { code }),
        `${name} ${JSON.stringify(code)}`,
      ).toBeNull();
    }
    expect(workspaceActionRequest(name, {}, {})).toBeNull();
    expect(workspaceActionRequest(name, {}, CODE)).toBeNull();
    expect(
      workspaceActionRequest(
        name,
        {},
        { code: CODE, workspaceId: WORKSPACE_ID },
      ),
    ).toBeNull();
    // A code is never a path parameter.
    expect(
      workspaceActionRequest(name, { code: CODE }, { code: CODE }),
    ).toBeNull();
  }
});

test("every failure of the session maps into the closed set, and only an uncertain one to unknown", () => {
  // A new reason of the session fails to compile here until it is mapped.
  const expected: Record<SessionFailureReason, WorkspaceActionFailure> = {
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
    no_answer: "unknown",
    server_error: "unknown",
    unexpected_response: "unknown",
  };
  expect(Object.keys(expected).sort()).toEqual(
    [...SESSION_FAILURE_REASONS].sort(),
  );
  for (const reason of SESSION_FAILURE_REASONS) {
    expect(workspaceActionFailureOf({ ok: false, reason }), reason).toBe(
      expected[reason],
    );
    expect(WORKSPACE_ACTION_FAILURES).toContain(expected[reason]);
  }
});

test("each code of the API maps to its fixed failure, and every code that a write's route answers is one the screens can show", () => {
  // A new code of the API fails to compile here until it is mapped.
  const expected: Record<ApiErrorCode, WorkspaceActionFailure> = {
    bad_request: "failed",
    unauthorized: "not_signed_in",
    auth_failed: "not_signed_in",
    device_revoked: "not_signed_in",
    sign_in_required: "not_signed_in",
    forbidden: "forbidden",
    device_registration_locked: "failed",
    device_too_new: "device_too_new",
    unsupported_account: "failed",
    join_requests_closed: "join_requests_closed",
    not_found: "not_found",
    workspace_not_found: "workspace_not_found",
    invitation_invalid: "invitation_invalid",
    device_account_mismatch: "not_signed_in",
    already_member: "already_member",
    conflict: "conflict",
    sign_in_code_used: "failed",
    rate_limited: "rate_limited",
    // Only with a 5xx, which the session reads as `server_error`.
    internal_error: "unknown",
    sign_in_unavailable: "failed",
  };
  expect(Object.keys(expected).sort()).toEqual([...API_ERROR_CODES].sort());
  for (const code of API_ERROR_CODES) {
    expect(
      workspaceActionFailureOf({ ok: false, reason: "refused", code }),
      code,
    ).toBe(expected[code]);
  }
  // Beyond the common codes, every code of a write's route has its own
  // failure.
  const routeErrors: Record<string, readonly ApiErrorCode[]> = {
    ...MEMBERSHIP_ROUTE_ERRORS,
    createProject: PROJECT_ROUTE_ERRORS.createProject,
  };
  for (const name of Object.keys(WORKSPACE_ACTIONS)) {
    for (const code of routeErrors[name] ?? []) {
      if (code !== "bad_request" && code !== "internal_error") {
        expect(expected[code], `${name} ${code}`).not.toBe("failed");
      }
    }
  }
});

test("rate_limited waits as long as the API's Retry-After, or a fixed minute without one", () => {
  expect(
    workspaceActionFailedFor({
      ok: false,
      reason: "refused",
      code: "rate_limited",
      retryAfterSeconds: 120,
    }),
  ).toEqual({ ok: false, reason: "rate_limited", retryAfterMs: 120_000 });
  expect(
    workspaceActionFailedFor({
      ok: false,
      reason: "refused",
      code: "rate_limited",
    }),
  ).toEqual({
    ok: false,
    reason: "rate_limited",
    retryAfterMs: ACTION_RATE_LIMITED_WAIT_MS,
  });
  expect(ACTION_RATE_LIMITED_WAIT_MS).toBe(60_000);
  // Every other failure carries its reason only.
  expect(
    workspaceActionFailedFor({
      ok: false,
      reason: "refused",
      code: "conflict",
    }),
  ).toEqual({ ok: false, reason: "conflict" });
  expect(workspaceActionFailedFor({ ok: false, reason: "no_answer" })).toEqual({
    ok: false,
    reason: "unknown",
  });
  expect(workspaceActionFailed("too_soon", 1_234.5)).toEqual({
    ok: false,
    reason: "too_soon",
    retryAfterMs: 1_235,
  });
  expect(Object.isFrozen(workspaceActionFailed("invalid"))).toBe(true);
});

test("the write budget is far below the API's limit of 300 requests a minute", () => {
  expect(WORKSPACE_ACTION_BUDGET).toEqual({ writes: 30, windowMs: 60_000 });
  expect(Object.isFrozen(WORKSPACE_ACTION_BUDGET)).toBe(true);
});
