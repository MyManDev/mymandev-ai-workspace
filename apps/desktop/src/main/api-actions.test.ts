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
  CreateRunRequestSchema,
  CreateRunResponseSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  DefineMemberRequestSchema,
  DefineMemberResponseSchema,
  GRANT_ROUTE_ERRORS,
  GRANT_ROUTES,
  GrantCapabilityRequestSchema,
  GrantCapabilityResponseSchema,
  INVITATION_CODE_PATTERN,
  MEMBERSHIP_ROUTE_ERRORS,
  MEMBERSHIP_ROUTES,
  OfferOwnershipRequestSchema,
  PreviewInvitationRequestSchema,
  PreviewInvitationResponseSchema,
  PROJECT_ROUTE_ERRORS,
  PROJECT_ROUTES,
  PROVIDER_CONNECTION_ROUTE_ERRORS,
  PROVIDER_CONNECTION_ROUTES,
  RegisterProviderConnectionRequestSchema,
  RegisterProviderConnectionResponseSchema,
  RegisterRepositoryRequestSchema,
  RegisterRepositoryResponseSchema,
  RenameMemberRequestSchema,
  REPOSITORY_ROUTE_ERRORS,
  REPOSITORY_ROUTES,
  routePath,
  RUN_ROUTE_ERRORS,
  RUN_ROUTES,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  ACTION_RATE_LIMITED_WAIT_MS,
  RUN_CREATION_FAILURES,
  RUN_DAILY_LIMIT_WAIT_MS,
  WORKSPACE_ACTION_BUDGET,
  WORKSPACE_ACTION_FAILURES,
  WORKSPACE_ACTIONS,
  type RunCreationFailure,
  type WorkspaceActionFailure,
  type WorkspaceActionName,
  type WorkspaceActionResult,
  workspaceActionFailed,
  workspaceActionFailedFor,
  workspaceActionFailureOf,
  workspaceActionMayHaveSent,
  workspaceActionRequest,
  workspaceActionSent,
} from "./api-actions.ts";
import {
  SESSION_FAILURE_REASONS,
  type SessionFailureReason,
} from "./session/session.ts";

const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192d1";
const MEMBER_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192f1";
const INVITATION_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819301";
const JOIN_REQUEST_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819311";
const PROJECT_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819321";
const REPOSITORY_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819331";
const AGENT_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819341";
const GRANT_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819351";
const CONNECTION_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819361";
const MESSAGE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f70819371";
/** The body of a run creation (#35). */
const RUN = {
  agentId: AGENT_ID,
  providerConnectionId: CONNECTION_ID,
  inputMessageId: MESSAGE_ID,
};
const OF_AGENT = { agentId: AGENT_ID };
const OF_GRANT = { agentId: AGENT_ID, grantId: GRANT_ID };
const IN_PROJECT = { projectId: PROJECT_ID };
const OF_REPOSITORY = { projectId: PROJECT_ID, repositoryId: REPOSITORY_ID };
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
  [
    "registerRepository",
    IN_PROJECT,
    // A label, sent as it is.
    { name: " web app " },
    `/projects/${PROJECT_ID}/repositories`,
    { name: " web app " },
  ],
  [
    "removeRepository",
    OF_REPOSITORY,
    undefined,
    `/projects/${PROJECT_ID}/repositories/${REPOSITORY_ID}/remove`,
    undefined,
  ],
  [
    "grantCapability",
    OF_AGENT,
    {
      capability: "repo.read",
      repositoryId: REPOSITORY_ID,
      lifetimeSeconds: null,
    },
    `/agents/${AGENT_ID}/grants`,
    {
      capability: "repo.read",
      repositoryId: REPOSITORY_ID,
      lifetimeSeconds: null,
    },
  ],
  [
    "revokeGrant",
    OF_GRANT,
    undefined,
    `/agents/${AGENT_ID}/grants/${GRANT_ID}/revoke`,
    undefined,
  ],
  [
    "registerProviderConnection",
    {},
    // A label, sent as it is.
    { kind: "claude", label: " Work laptop " },
    "/provider-connections",
    { kind: "claude", label: " Work laptop " },
  ],
  [
    "removeProviderConnection",
    { providerConnectionId: CONNECTION_ID },
    undefined,
    `/provider-connections/${CONNECTION_ID}/remove`,
    undefined,
  ],
  [
    "createRun",
    IN_PROJECT,
    // IDs only; the run of #35 names no repository yet.
    {
      agentId: AGENT_ID,
      providerConnectionId: CONNECTION_ID,
      inputMessageId: MESSAGE_ID,
    },
    `/projects/${PROJECT_ID}/runs`,
    {
      agentId: AGENT_ID,
      providerConnectionId: CONNECTION_ID,
      inputMessageId: MESSAGE_ID,
    },
  ],
];

/** The `:name` parameters of a route path, in order. */
function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/gu)].map(
    (match) => match[1] as string,
  );
}

test("the allowlist holds exactly the 31 POST writes of the screens, the repositories, the grants, the provider connections, and the run creation, frozen, each the protocol's route with its path parameters", () => {
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
        : name === "registerRepository" || name === "removeRepository"
          ? REPOSITORY_ROUTES[name]
          : name === "grantCapability" || name === "revokeGrant"
            ? GRANT_ROUTES[name]
            : name === "registerProviderConnection" ||
                name === "removeProviderConnection"
              ? PROVIDER_CONNECTION_ROUTES[name]
              : name === "createRun"
                ? RUN_ROUTES.createRun
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
    registerRepository: [
      RegisterRepositoryRequestSchema,
      RegisterRepositoryResponseSchema,
    ],
    removeRepository: [null, "empty"],
    grantCapability: [
      GrantCapabilityRequestSchema,
      GrantCapabilityResponseSchema,
    ],
    revokeGrant: [null, "empty"],
    registerProviderConnection: [
      RegisterProviderConnectionRequestSchema,
      RegisterProviderConnectionResponseSchema,
    ],
    removeProviderConnection: [null, "empty"],
    createRun: [CreateRunRequestSchema, CreateRunResponseSchema],
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
    // A repository: never a path, as a name or beside it (#286).
    ["listRepositories", IN_PROJECT, undefined],
    ["registerRepository", IN_PROJECT, { name: "/home/user/web" }],
    ["registerRepository", IN_PROJECT, { name: "C:\\Users\\user\\web" }],
    ["registerRepository", IN_PROJECT, { name: "web", path: "/home/web" }],
    ["registerRepository", IN_PROJECT, { name: "" }],
    ["registerRepository", IN_PROJECT, { name: "a".repeat(101) }],
    ["registerRepository", IN_PROJECT, { name: "a\nb" }],
    ["registerRepository", IN_PROJECT, undefined],
    ["registerRepository", IN_WORKSPACE, { name: "web" }],
    ["registerRepository", { projectId: upper }, { name: "web" }],
    ["removeRepository", IN_PROJECT, undefined],
    ["removeRepository", OF_REPOSITORY, {}],
    [
      "removeRepository",
      { projectId: PROJECT_ID, repositoryId: v4 },
      undefined,
    ],
    [
      "removeRepository",
      { ...OF_REPOSITORY, workspaceId: WORKSPACE_ID },
      undefined,
    ],
    // A grant (#342): one capability on the scope of its kind, a lifetime
    // that is a number or an explicit null, and no extra field.
    ["grantCapability", OF_AGENT, undefined],
    [
      "grantCapability",
      OF_AGENT,
      { capability: "repo.read", repositoryId: REPOSITORY_ID },
    ],
    [
      "grantCapability",
      OF_AGENT,
      {
        capability: "repo.read",
        providerConnectionId: CONNECTION_ID,
        lifetimeSeconds: null,
      },
    ],
    [
      "grantCapability",
      OF_AGENT,
      {
        capability: "provider.use",
        repositoryId: REPOSITORY_ID,
        lifetimeSeconds: null,
      },
    ],
    [
      "grantCapability",
      OF_AGENT,
      {
        capability: "repo.read",
        repositoryId: REPOSITORY_ID,
        lifetimeSeconds: 59,
      },
    ],
    [
      "grantCapability",
      OF_AGENT,
      {
        capability: "terminal.execute",
        repositoryId: REPOSITORY_ID,
        lifetimeSeconds: null,
      },
    ],
    [
      "grantCapability",
      OF_AGENT,
      {
        capability: "terminal.execute",
        repositoryId: REPOSITORY_ID,
        lifetimeSeconds: 2_592_001,
      },
    ],
    [
      "grantCapability",
      OF_AGENT,
      {
        capability: "repo.admin",
        repositoryId: REPOSITORY_ID,
        lifetimeSeconds: null,
      },
    ],
    [
      "grantCapability",
      OF_AGENT,
      {
        capability: "repo.read",
        repositoryId: REPOSITORY_ID,
        providerConnectionId: CONNECTION_ID,
        lifetimeSeconds: null,
      },
    ],
    [
      "grantCapability",
      OF_AGENT,
      {
        capability: "repo.read",
        repositoryId: REPOSITORY_ID,
        lifetimeSeconds: null,
        granteeAgentId: AGENT_ID,
      },
    ],
    [
      "grantCapability",
      IN_PROJECT,
      {
        capability: "repo.read",
        repositoryId: REPOSITORY_ID,
        lifetimeSeconds: null,
      },
    ],
    [
      "grantCapability",
      { agentId: v4 },
      {
        capability: "repo.read",
        repositoryId: REPOSITORY_ID,
        lifetimeSeconds: null,
      },
    ],
    ["revokeGrant", OF_AGENT, undefined],
    ["revokeGrant", OF_GRANT, {}],
    ["revokeGrant", { agentId: AGENT_ID, grantId: upper }, undefined],
    // A registration names no device and carries no credential (#33): an
    // extra key is refused, not dropped, and so is a kind that is not one
    // of the protocol's or a label outside its limits.
    ["registerProviderConnection", {}, undefined],
    ["registerProviderConnection", {}, { kind: "claude" }],
    ["registerProviderConnection", {}, { label: "Work" }],
    [
      "registerProviderConnection",
      {},
      { kind: "claude", label: "Work", apiKey: "sk-ant-secret" },
    ],
    [
      "registerProviderConnection",
      {},
      { kind: "claude", label: "Work", token: "secret" },
    ],
    [
      "registerProviderConnection",
      {},
      { kind: "claude", label: "Work", deviceId: WORKSPACE_ID },
    ],
    ["registerProviderConnection", {}, { kind: "gemini", label: "Work" }],
    ["registerProviderConnection", {}, { kind: "claude", label: "" }],
    ["registerProviderConnection", {}, { kind: "claude", label: "   " }],
    [
      "registerProviderConnection",
      {},
      { kind: "claude", label: "x".repeat(65) },
    ],
    ["registerProviderConnection", {}, { kind: "claude", label: "a\nb" }],
    ["registerProviderConnection", {}, { kind: "claude", label: "a\u202eb" }],
    [
      "registerProviderConnection",
      IN_WORKSPACE,
      { kind: "claude", label: "Work" },
    ],
    ["removeProviderConnection", {}, undefined],
    ["removeProviderConnection", { providerConnectionId: CONNECTION_ID }, {}],
    [
      "removeProviderConnection",
      { providerConnectionId: CONNECTION_ID.toUpperCase() },
      undefined,
    ],
    [
      "removeProviderConnection",
      { providerConnectionId: CONNECTION_ID, deviceId: WORKSPACE_ID },
      undefined,
    ],
    // A run creation (#35): IDs only, each a lowercase UUIDv7, and no text,
    // state, requester, or idempotency key beside them.
    ["createRun", {}, RUN],
    ["createRun", IN_WORKSPACE, RUN],
    ["createRun", { projectId: PROJECT_ID.toUpperCase() }, RUN],
    ["createRun", { ...IN_PROJECT, agentId: AGENT_ID }, RUN],
    ["createRun", IN_PROJECT, undefined],
    ["createRun", IN_PROJECT, {}],
    ["createRun", IN_PROJECT, { ...RUN, agentId: undefined }],
    ["createRun", IN_PROJECT, { ...RUN, providerConnectionId: undefined }],
    ["createRun", IN_PROJECT, { ...RUN, inputMessageId: undefined }],
    ["createRun", IN_PROJECT, { ...RUN, agentId: v4 }],
    ["createRun", IN_PROJECT, { ...RUN, inputMessageId: upper }],
    ["createRun", IN_PROJECT, { ...RUN, repositoryId: "repo" }],
    ["createRun", IN_PROJECT, { ...RUN, text: "Fix the build" }],
    ["createRun", IN_PROJECT, { ...RUN, state: "running" }],
    ["createRun", IN_PROJECT, { ...RUN, idempotencyKey: MESSAGE_ID }],
  ];
  for (const [name, params, body] of refused) {
    expect(
      workspaceActionRequest(name as WorkspaceActionName, params, body),
      `${name} ${JSON.stringify(params)} ${JSON.stringify(body)}`,
    ).toBeNull();
  }
  // The other forms of a grant pass: provider.use on a connection, a
  // lifetime, and the shell with one of at most 30 days.
  for (const body of [
    {
      capability: "provider.use",
      providerConnectionId: CONNECTION_ID,
      lifetimeSeconds: null,
    },
    {
      capability: "git.push",
      repositoryId: REPOSITORY_ID,
      lifetimeSeconds: 3_600,
    },
    {
      capability: "terminal.execute",
      repositoryId: REPOSITORY_ID,
      lifetimeSeconds: 2_592_000,
    },
  ]) {
    expect(
      workspaceActionRequest("grantCapability", OF_AGENT, body)?.body,
      JSON.stringify(body),
    ).toEqual(body);
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
    // Nothing was sent: a value outside the protocol's format.
    invalid_request: "invalid",
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
    unclaimed_limit: "unclaimed_limit",
    project_limit: "project_limit",
    // Only a run creation shows a run's limits (#35); every other write,
    // and a failure mapped without a write's name, answers them as
    // `failed`.
    run_limit: "failed",
    run_daily_limit: "failed",
    // A registration in a full project (#286, decision of 2026-11-14).
    repository_limit: "repository_limit",
    // A grant over a count limit (#75, #342), without a wait.
    grant_limit: "grant_limit",
    // No write of the desktop creates an agent yet (#294).
    agent_limit: "failed",
    // A registration on a device at its limit (#32, #295), without a wait.
    provider_connection_limit: "provider_connection_limit",
    // Only the sign-in answers it, never a write (#255).
    device_limit: "failed",
    // Nor this one: a write then fails without a wait, never as the
    // `rate_limited` of its own route (#269).
    device_daily_limit: "failed",
    rate_limited: "rate_limited",
    // Defensive: only with a 5xx, which the session reads as
    // `server_error`, so it never comes as a refusal.
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
    registerRepository: REPOSITORY_ROUTE_ERRORS.registerRepository,
    removeRepository: REPOSITORY_ROUTE_ERRORS.removeRepository,
    grantCapability: GRANT_ROUTE_ERRORS.grantCapability,
    revokeGrant: GRANT_ROUTE_ERRORS.revokeGrant,
    ...PROVIDER_CONNECTION_ROUTE_ERRORS,
    createRun: RUN_ROUTE_ERRORS.createRun,
  };
  for (const name of Object.keys(WORKSPACE_ACTIONS)) {
    expect(routeErrors[name], name).toBeDefined();
  }
  for (const name of Object.keys(WORKSPACE_ACTIONS) as WorkspaceActionName[]) {
    for (const code of routeErrors[name] ?? []) {
      if (code !== "bad_request" && code !== "internal_error") {
        expect(
          workspaceActionFailureOf(
            { ok: false, reason: "refused", code },
            name,
          ),
          `${name} ${code}`,
        ).not.toBe("failed");
      }
    }
  }
});

test("a run creation keeps the API's two run limits, and every other write answers them as failed (#35)", () => {
  // With the name of the write, every code maps as without one, except the
  // two limits of a run, which only `createRun` keeps.
  for (const name of Object.keys(WORKSPACE_ACTIONS) as WorkspaceActionName[]) {
    for (const code of API_ERROR_CODES) {
      const failure = { ok: false as const, reason: "refused" as const, code };
      const named = workspaceActionFailureOf(failure, name);
      if (
        name === "createRun" &&
        (code === "run_limit" || code === "run_daily_limit")
      ) {
        expect(named, `${name} ${code}`).toBe(code);
      } else {
        expect(named, `${name} ${code}`).toBe(
          workspaceActionFailureOf(failure),
        );
      }
    }
  }
  // Every session failure maps alike with or without the name.
  for (const reason of SESSION_FAILURE_REASONS) {
    expect(workspaceActionFailureOf({ ok: false, reason }, "createRun")).toBe(
      workspaceActionFailureOf({ ok: false, reason }),
    );
  }
  // The run's failures are those of every write and the two limits, and
  // only those.
  expect([...RUN_CREATION_FAILURES].sort()).toEqual(
    [...WORKSPACE_ACTION_FAILURES, "run_limit", "run_daily_limit"].sort(),
  );
  expect(Object.isFrozen(RUN_CREATION_FAILURES)).toBe(true);
  expect(WORKSPACE_ACTION_FAILURES).not.toContain("run_limit");
  expect(WORKSPACE_ACTION_FAILURES).not.toContain("run_daily_limit");
});

test("run_daily_limit waits as long as the API's Retry-After, or the whole 24 hours without one; run_limit carries no wait (#35)", () => {
  expect(
    workspaceActionFailedFor(
      {
        ok: false,
        reason: "refused",
        code: "run_daily_limit",
        retryAfterSeconds: 3_600,
      },
      "createRun",
    ),
  ).toEqual({ ok: false, reason: "run_daily_limit", retryAfterMs: 3_600_000 });
  expect(
    workspaceActionFailedFor(
      { ok: false, reason: "refused", code: "run_daily_limit" },
      "createRun",
    ),
  ).toEqual({
    ok: false,
    reason: "run_daily_limit",
    retryAfterMs: RUN_DAILY_LIMIT_WAIT_MS,
  });
  expect(RUN_DAILY_LIMIT_WAIT_MS).toBe(86_400_000);
  // No time frees a place below the limit of unfinished runs.
  expect(
    workspaceActionFailedFor(
      {
        ok: false,
        reason: "refused",
        code: "run_limit",
        retryAfterSeconds: 120,
      },
      "createRun",
    ),
  ).toEqual({ ok: false, reason: "run_limit" });
  // The account's request limit stays `rate_limited` for a run creation.
  expect(
    workspaceActionFailedFor(
      {
        ok: false,
        reason: "refused",
        code: "rate_limited",
        retryAfterSeconds: 30,
      },
      "createRun",
    ),
  ).toEqual({ ok: false, reason: "rate_limited", retryAfterMs: 30_000 });
  // Another write answers both as `failed`, without a wait.
  for (const code of ["run_limit", "run_daily_limit"] as const) {
    expect(
      workspaceActionFailedFor(
        { ok: false, reason: "refused", code, retryAfterSeconds: 120 },
        "grantCapability",
      ),
    ).toEqual({ ok: false, reason: "failed" });
    expect(
      workspaceActionFailedFor({
        ok: false,
        reason: "refused",
        code,
        retryAfterSeconds: 120,
      }),
    ).toEqual({ ok: false, reason: "failed" });
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
  // The limit of unclaimed people is no wait (#242), even with a time.
  expect(
    workspaceActionFailedFor({
      ok: false,
      reason: "refused",
      code: "unclaimed_limit",
      retryAfterSeconds: 120,
    }),
  ).toEqual({ ok: false, reason: "unclaimed_limit" });
  // Nor is the limit of projects in a workspace (#255).
  expect(
    workspaceActionFailedFor({
      ok: false,
      reason: "refused",
      code: "project_limit",
      retryAfterSeconds: 120,
    }),
  ).toEqual({ ok: false, reason: "project_limit" });
  // Nor is the limit of repositories in a project (#286).
  expect(
    workspaceActionFailedFor({
      ok: false,
      reason: "refused",
      code: "repository_limit",
      retryAfterSeconds: 120,
    }),
  ).toEqual({ ok: false, reason: "repository_limit" });
  // Nor is the limit of grants (#75, #342).
  expect(
    workspaceActionFailedFor({
      ok: false,
      reason: "refused",
      code: "grant_limit",
      retryAfterSeconds: 120,
    }),
  ).toEqual({ ok: false, reason: "grant_limit" });
  // Nor is the limit of a device's provider connections (#295).
  expect(
    workspaceActionFailedFor({
      ok: false,
      reason: "refused",
      code: "provider_connection_limit",
      retryAfterSeconds: 120,
    }),
  ).toEqual({ ok: false, reason: "provider_connection_limit" });
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

test("a failure marked as sent may have reached the API, as every successful answer; a refusal of the service itself did not (#342)", () => {
  const sent = workspaceActionSent(workspaceActionFailed("too_soon", 1_000));
  expect(sent).toEqual({
    ok: false,
    reason: "too_soon",
    retryAfterMs: 1_000,
    sent: true,
  });
  expect(Object.isFrozen(sent)).toBe(true);
  expect(workspaceActionMayHaveSent(sent)).toBe(true);
  expect(
    workspaceActionMayHaveSent(
      workspaceActionSent(workspaceActionFailed("unavailable")),
    ),
  ).toBe(true);
  expect(workspaceActionMayHaveSent({ ok: true, value: null })).toBe(true);
  for (const reason of WORKSPACE_ACTION_FAILURES) {
    const failure =
      reason === "too_soon" || reason === "rate_limited"
        ? workspaceActionFailed(reason, 1_000)
        : workspaceActionFailed(reason);
    expect(workspaceActionMayHaveSent(failure), reason).toBe(false);
  }
  // A run creation's limits follow the same rule (#35).
  const runFailures: WorkspaceActionResult<never, RunCreationFailure>[] = [
    workspaceActionFailed("run_limit"),
    workspaceActionFailed("run_daily_limit", 1_000),
  ];
  for (const failure of runFailures) {
    expect(workspaceActionMayHaveSent(failure)).toBe(false);
    expect(workspaceActionMayHaveSent(workspaceActionSent(failure))).toBe(true);
  }
});

test("the write budget is far below the API's limit of 300 requests a minute", () => {
  expect(WORKSPACE_ACTION_BUDGET).toEqual({ writes: 30, windowMs: 60_000 });
  expect(Object.isFrozen(WORKSPACE_ACTION_BUDGET)).toBe(true);
});
