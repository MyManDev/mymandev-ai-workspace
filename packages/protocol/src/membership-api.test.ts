import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as z from "zod";
import { AUTH_ROUTES, routePath } from "./auth-api.ts";
import { decodeClientEvent, decodeEvent } from "./decode.ts";
import {
  JoinRequestOutcomeSchema,
  SERVER_ONLY_EVENT_TYPES,
  WorkspaceJoinRequestCreatedEventSchema,
  WorkspaceJoinRequestResolvedEventSchema,
  WorkspaceJoinRequestUnblockedEventSchema,
} from "./envelope.ts";
import { decodeClientMessage, decodeServerMessage } from "./frames.ts";
import {
  InvitationIdSchema,
  JoinRequestIdSchema,
  type MemberId,
  MemberIdSchema,
  newId,
  WorkspaceIdSchema,
} from "./ids.ts";
import {
  AcceptInvitationRequestSchema,
  AcceptInvitationResponseSchema,
  ApproveJoinRequestRequestSchema,
  ApproveJoinRequestResponseSchema,
  ClaimListResponseSchema,
  ClaimSchema,
  CreateInvitationRequestSchema,
  CreateInvitationResponseSchema,
  CreateJoinRequestRequestSchema,
  CreateJoinRequestResponseSchema,
  CreateWorkspaceRequestSchema,
  CreateWorkspaceResponseSchema,
  DefineMemberRequestSchema,
  DefineMemberResponseSchema,
  InvitationListResponseSchema,
  JoinRequestListResponseSchema,
  MEMBERSHIP_ROUTE_ERRORS,
  MEMBERSHIP_ROUTES,
  type MembershipRouteName,
  OfferOwnershipRequestSchema,
  OwnJoinRequestListResponseSchema,
  PreviewInvitationRequestSchema,
  PreviewInvitationResponseSchema,
  RenameMemberRequestSchema,
  SetUnclaimedMemberLimitRequestSchema,
  WorkspaceListResponseSchema,
  WorkspaceViewResponseSchema,
} from "./membership-api.ts";
import {
  API_ERROR_CODES,
  type ApiErrorCode,
  JOIN_REQUEST_DECISIONS,
  MAX_ANSWER_LIST_ITEMS,
  UNCLAIMED_MEMBER_LIMIT,
} from "./model.ts";

type Schema = { safeParse(value: unknown): { success: boolean } };

const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OTHER_WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4";
const OWNER_ID = "0192f2a0-7c3e-7d2e-9f10-112233445501";
const MEMBER_ID = "0192f2a0-7c3e-7d2e-9f10-112233445502";
const UNCLAIMED_ID = "0192f2a0-7c3e-7d2e-9f10-112233445503";
const FORMER_ID = "0192f2a0-7c3e-7d2e-9f10-112233445504";
const OWNER_USER_ID = "0192f2a0-7c3e-7f00-a000-000000000001";
const USER_ID = "0192f2a0-7c3e-7f00-a000-000000000002";
const INVITATION_ID = "0192f2a0-7c3e-7b00-8000-000000000003";
const JOIN_REQUEST_ID = "0192f2a0-7c3e-7c00-9000-000000000004";
const EVENT_ID = "0192f2a0-7c3e-7e00-8000-000000000006";
const DEVICE_ID = "0192f2a0-7c3e-7e00-8000-000000000007";
const NOW = "2026-10-29T12:00:00.000Z";
const LATER = "2026-11-05T12:00:00.000Z";
const GITHUB_CREATED = "2011-01-25T18:44:36.000Z";

const invitationCode = () => `mmdi_${randomBytes(32).toString("base64url")}`;

/** IDs that are not lowercase UUIDv7s. */
const BAD_IDS = [
  "not-a-uuid",
  WORKSPACE_ID.toUpperCase(),
  "0192f2a0-7c3e-4a1b-8c4d-5e6f708192a3",
  `${WORKSPACE_ID}/leave`,
  "",
];

/** Codes of the wrong format: another prefix, 47 and 49 characters, no prefix. */
function badCodes(): string[] {
  const code = invitationCode();
  return [
    `mmda_${code.slice(5)}`,
    `mmdc_${code.slice(5)}`,
    code.slice(0, 47),
    `${code}A`,
    code.slice(5),
    `${code.slice(0, 47)}=`,
  ];
}

const workspace = { id: WORKSPACE_ID, name: "MyManDev" };

const owner = {
  id: OWNER_ID,
  workspaceId: WORKSPACE_ID,
  displayName: "Grace",
  role: "owner",
  userId: OWNER_USER_ID,
  identity: { provider: "github", login: "grace-h", verifiedAt: NOW },
  removedAt: null,
};

const member = {
  id: MEMBER_ID,
  workspaceId: WORKSPACE_ID,
  displayName: "Ada",
  role: "member",
  userId: USER_ID,
  identity: { provider: "github", login: "ada-l", verifiedAt: NOW },
  removedAt: null,
};

const unclaimed = {
  id: UNCLAIMED_ID,
  workspaceId: WORKSPACE_ID,
  displayName: "Linus",
  role: "member",
  userId: null,
  identity: null,
  removedAt: null,
};

/** The same account as `member`, from an earlier membership period. */
const former = { ...member, id: FORMER_ID, role: "admin", removedAt: NOW };

function assertRejects(
  schema: Schema,
  rejected: [label: string, value: unknown][],
) {
  for (const [label, value] of rejected) {
    assert.equal(schema.safeParse(value).success, false, label);
  }
}

/**
 * One rejection for each field of `valid`, without that field, wrapped by
 * `wrap` into the value that the schema parses. `where` names the nested
 * object in the labels.
 */
function withoutEach(
  valid: Record<string, unknown>,
  wrap: (value: Record<string, unknown>) => unknown = (value) => value,
  where = "",
): [label: string, value: unknown][] {
  return Object.keys(valid).map((key) => {
    const value = { ...valid };
    delete value[key];
    return [`missing ${where}${key}`, wrap(value)];
  });
}

/** The codes that every membership route can answer. */
const COMMON_CODES: readonly string[] = [
  "bad_request",
  "unauthorized",
  "rate_limited",
  "internal_error",
];

/** The codes of each route beyond the common ones, in their order. */
function specificCodes(): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(MEMBERSHIP_ROUTE_ERRORS).map(([name, codes]) => [
      name,
      codes.filter((code) => !COMMON_CODES.includes(code)),
    ]),
  );
}

test("the membership routes are fixed, frozen, and apart from the authentication routes", () => {
  const table = Object.values(MEMBERSHIP_ROUTES).map(
    (route) => `${route.method} ${route.path}`,
  );
  assert.deepEqual(table, [
    "GET /workspaces",
    "POST /workspaces",
    "GET /workspaces/:workspaceId",
    "POST /workspaces/:workspaceId/unclaimed-member-limit",
    "POST /workspaces/:workspaceId/members",
    "POST /workspaces/:workspaceId/members/:memberId/rename",
    "POST /workspaces/:workspaceId/members/:memberId/remove",
    "POST /workspaces/:workspaceId/members/:memberId/promote",
    "POST /workspaces/:workspaceId/members/:memberId/demote",
    "POST /workspaces/:workspaceId/leave",
    "POST /workspaces/:workspaceId/ownership-offer",
    "POST /workspaces/:workspaceId/ownership-offer/accept",
    "POST /workspaces/:workspaceId/ownership-offer/withdraw",
    "GET /workspaces/:workspaceId/invitations",
    "POST /workspaces/:workspaceId/invitations",
    "POST /workspaces/:workspaceId/invitations/:invitationId/revoke",
    "POST /invitations/preview",
    "POST /invitations/accept",
    "POST /join-requests",
    "GET /join-requests",
    "POST /join-requests/:joinRequestId/withdraw",
    "GET /workspaces/:workspaceId/join-requests",
    "POST /workspaces/:workspaceId/join-requests/:joinRequestId/approve",
    "POST /workspaces/:workspaceId/join-requests/:joinRequestId/deny",
    "POST /workspaces/:workspaceId/join-requests/:joinRequestId/block",
    "POST /workspaces/:workspaceId/join-requests/:joinRequestId/unblock",
    "POST /workspaces/:workspaceId/join-requests/deny-all",
    "POST /workspaces/:workspaceId/join-requests/pause",
    "POST /workspaces/:workspaceId/join-requests/resume",
    "GET /workspaces/:workspaceId/claims",
  ]);
  assert.equal(new Set(table).size, table.length);
  assert.equal(Object.isFrozen(MEMBERSHIP_ROUTES), true);
  for (const route of Object.values(MEMBERSHIP_ROUTES)) {
    assert.equal(Object.isFrozen(route), true, route.path);
    assert.deepEqual(Object.keys(route).sort(), ["method", "path"]);
  }

  const authTable = new Set(
    Object.values(AUTH_ROUTES).map((route) => `${route.method} ${route.path}`),
  );
  for (const entry of table) {
    assert.equal(authTable.has(entry), false, entry);
  }
  for (const name of Object.keys(MEMBERSHIP_ROUTES)) {
    assert.equal(Object.hasOwn(AUTH_ROUTES, name), false, name);
  }
});

test("a join request is the only route of a workspace ID outside the membership-checked path", () => {
  for (const [name, route] of Object.entries(MEMBERSHIP_ROUTES)) {
    if (route.path.startsWith("/workspaces/")) {
      assert.match(route.path, /^\/workspaces\/:workspaceId(?:\/|$)/u, name);
    } else {
      assert.equal(route.path.includes(":workspaceId"), false, name);
    }
  }
});

test("every path parameter is an ID, and routePath fills each route", () => {
  const ids = new Map<string, [value: string, schema: Schema]>([
    ["workspaceId", [WORKSPACE_ID, WorkspaceIdSchema]],
    ["memberId", [MEMBER_ID, MemberIdSchema]],
    ["invitationId", [INVITATION_ID, InvitationIdSchema]],
    ["joinRequestId", [JOIN_REQUEST_ID, JoinRequestIdSchema]],
  ]);
  for (const [name, route] of Object.entries(MEMBERSHIP_ROUTES)) {
    assert.equal(route.path.includes("?"), false, `${name}: query`);
    assert.doesNotMatch(route.path, /code|token/iu, `${name}: secret`);
    const parameters = [...route.path.matchAll(/:([A-Za-z0-9]+)/gu)].map(
      (match) => match[1] ?? "",
    );
    const values: Record<string, string> = {};
    for (const parameter of parameters) {
      const id = ids.get(parameter);
      assert.ok(id, `${name}: ${parameter} is not an ID`);
      assert.equal(id[1].safeParse(id[0]).success, true, parameter);
      values[parameter] = id[0];
    }
    const expected = route.path.replace(
      /:([A-Za-z0-9]+)/gu,
      (_match, parameter: string) => values[parameter] ?? "",
    );
    assert.equal(routePath(route.path, values), expected, name);
    assert.equal(expected.includes(":"), false, name);

    for (const parameter of parameters) {
      for (const bad of [...BAD_IDS, invitationCode()]) {
        assert.throws(
          () => routePath(route.path, { ...values, [parameter]: bad }),
          TypeError,
          `${name}: ${parameter} = ${JSON.stringify(bad)}`,
        );
      }
      const missing = { ...values };
      delete missing[parameter];
      assert.throws(
        () => routePath(route.path, missing),
        TypeError,
        `${name}: missing ${parameter}`,
      );
    }
    assert.throws(
      () => routePath(route.path, { ...values, code: WORKSPACE_ID }),
      TypeError,
      `${name}: unknown parameter`,
    );
  }
});

test("each route answers only known error codes, the common ones included", () => {
  assert.deepEqual(
    Object.keys(MEMBERSHIP_ROUTE_ERRORS),
    Object.keys(MEMBERSHIP_ROUTES),
  );
  const known = new Set<string>(API_ERROR_CODES);
  const entries = Object.entries(MEMBERSHIP_ROUTE_ERRORS) as [
    MembershipRouteName,
    readonly ApiErrorCode[],
  ][];
  for (const [name, codes] of entries) {
    assert.equal(new Set(codes).size, codes.length, `${name}: duplicates`);
    for (const code of codes) {
      assert.equal(known.has(code), true, `${name}: ${code}`);
    }
    for (const code of COMMON_CODES) {
      assert.equal(codes.includes(code as ApiErrorCode), true, name);
    }
    const route = MEMBERSHIP_ROUTES[name];
    if (route.path.includes(":")) {
      assert.equal(codes.includes("not_found"), true, `${name}: not_found`);
    }
  }

  assert.deepEqual(specificCodes(), {
    listWorkspaces: [],
    createWorkspace: [],
    getWorkspace: ["not_found"],
    setUnclaimedMemberLimit: ["not_found", "forbidden", "conflict"],
    defineMember: ["not_found", "forbidden", "unclaimed_limit"],
    renameMember: ["not_found", "forbidden", "conflict"],
    removeMember: ["not_found", "forbidden", "conflict"],
    promoteMember: ["not_found", "forbidden", "device_too_new", "conflict"],
    demoteMember: ["not_found", "forbidden", "conflict"],
    leaveWorkspace: ["not_found", "forbidden"],
    offerOwnership: ["not_found", "forbidden", "device_too_new", "conflict"],
    acceptOwnershipOffer: ["not_found", "forbidden", "conflict"],
    withdrawOwnershipOffer: ["not_found", "forbidden", "conflict"],
    listInvitations: ["not_found", "forbidden"],
    createInvitation: ["not_found", "forbidden", "conflict"],
    revokeInvitation: ["not_found", "forbidden", "conflict"],
    previewInvitation: ["invitation_invalid", "already_member"],
    acceptInvitation: ["invitation_invalid", "already_member"],
    createJoinRequest: [
      "workspace_not_found",
      "join_requests_closed",
      "already_member",
    ],
    listOwnJoinRequests: [],
    withdrawJoinRequest: ["not_found", "conflict"],
    listJoinRequests: ["not_found", "forbidden"],
    approveJoinRequest: [
      "not_found",
      "forbidden",
      "conflict",
      "already_member",
    ],
    denyJoinRequest: ["not_found", "forbidden", "conflict"],
    blockJoinRequest: ["not_found", "forbidden", "conflict"],
    unblockJoinRequest: ["not_found", "forbidden", "conflict"],
    denyAllJoinRequests: ["not_found", "forbidden"],
    pauseJoinRequests: ["not_found", "forbidden"],
    resumeJoinRequests: ["not_found", "forbidden"],
    listClaims: ["not_found", "forbidden"],
  });

  const holders = (code: ApiErrorCode) =>
    entries.filter(([, codes]) => codes.includes(code)).map(([name]) => name);
  assert.deepEqual(holders("workspace_not_found"), ["createJoinRequest"]);
  assert.deepEqual(holders("join_requests_closed"), ["createJoinRequest"]);
  assert.deepEqual(holders("invitation_invalid"), [
    "previewInvitation",
    "acceptInvitation",
  ]);
  assert.deepEqual(holders("device_too_new"), [
    "promoteMember",
    "offerOwnership",
  ]);
  // Only a definition counts the unclaimed people (#242).
  assert.deepEqual(holders("unclaimed_limit"), ["defineMember"]);
  assert.deepEqual(holders("already_member"), [
    "previewInvitation",
    "acceptInvitation",
    "createJoinRequest",
    "approveJoinRequest",
  ]);
  for (const code of [
    "auth_failed",
    "device_revoked",
    "sign_in_required",
    "device_account_mismatch",
    "device_registration_locked",
    "unsupported_account",
    "sign_in_unavailable",
    "sign_in_code_used",
  ] as const) {
    assert.deepEqual(holders(code), [], code);
  }
  for (const name of [
    "listWorkspaces",
    "createWorkspace",
    "getWorkspace",
    "previewInvitation",
    "acceptInvitation",
    "createJoinRequest",
    "listOwnJoinRequests",
    "withdrawJoinRequest",
  ] as const) {
    assert.equal(
      MEMBERSHIP_ROUTE_ERRORS[name].includes("forbidden"),
      false,
      `${name} is open to every role`,
    );
  }
});

test("the README's route table lists every route with its codes", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  // The section of the membership routes, up to the next section.
  const section = readme
    .split("\n## Membership routes\n")[1]
    ?.split("\n## ")[0];
  assert.ok(section);
  const rows = section
    .split("\n")
    .filter((line) => /^\| `(?:GET|POST) \//u.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()));
  const names = new Map(
    Object.entries(MEMBERSHIP_ROUTES).map(([name, route]) => [
      `\`${route.method} ${route.path}\``,
      name,
    ]),
  );
  const table: Record<string, string[]> = {};
  for (const cells of rows) {
    assert.equal(cells.length, 7, cells[1]);
    const name = names.get(cells[1] ?? "");
    assert.ok(name, `${cells[1]} is not a membership route`);
    table[name] = [...(cells[5] ?? "").matchAll(/`([a-z_]+)`/gu)].map(
      (match) => match[1] ?? "",
    );
  }
  assert.deepEqual(Object.keys(table), Object.keys(MEMBERSHIP_ROUTES));
  assert.deepEqual(table, specificCodes());
});

test("the exported route constants are frozen, nested values included", () => {
  // Modules run in strict mode, so a write to a frozen value throws.
  for (const [label, value] of [
    ["MEMBERSHIP_ROUTES", MEMBERSHIP_ROUTES],
    ["MEMBERSHIP_ROUTE_ERRORS", MEMBERSHIP_ROUTE_ERRORS],
  ] as const) {
    const mutable = value as unknown as Record<string, unknown>;
    assert.equal(Object.isFrozen(value), true, label);
    assert.throws(
      () => {
        mutable.listWorkspaces = null;
      },
      TypeError,
      `${label}: change`,
    );
    assert.throws(
      () => {
        mutable.added = null;
      },
      TypeError,
      `${label}: add`,
    );
  }
  for (const route of Object.values(MEMBERSHIP_ROUTES)) {
    const mutable = route as { path: string };
    assert.throws(
      () => {
        mutable.path = "/";
      },
      TypeError,
      route.path,
    );
  }
  for (const [name, codes] of Object.entries(MEMBERSHIP_ROUTE_ERRORS)) {
    const mutable = codes as ApiErrorCode[];
    assert.equal(Object.isFrozen(codes), true, name);
    assert.throws(() => mutable.push("conflict"), TypeError, `${name}: push`);
    assert.throws(
      () => {
        mutable[0] = "conflict";
      },
      TypeError,
      `${name}: index`,
    );
  }
});

test("the workspace list carries each workspace with the account's own active person", () => {
  const item = { workspace, member: owner };
  assert.equal(
    WorkspaceListResponseSchema.safeParse({ workspaces: [item] }).success,
    true,
  );
  assert.equal(
    WorkspaceListResponseSchema.safeParse({ workspaces: [] }).success,
    true,
  );
  assertRejects(WorkspaceListResponseSchema, [
    ...withoutEach({ workspaces: [item] }),
    ...withoutEach(item, (value) => ({ workspaces: [value] }), "item."),
    ["list as an object", { workspaces: item }],
    [
      "person of another workspace",
      {
        workspaces: [
          { workspace: { ...workspace, id: OTHER_WORKSPACE_ID }, member },
        ],
      },
    ],
    ["former person", { workspaces: [{ workspace, member: former }] }],
    ["unclaimed person", { workspaces: [{ workspace, member: unclaimed }] }],
    [
      "workspace name over 100",
      {
        workspaces: [
          { workspace: { ...workspace, name: "a".repeat(101) }, member },
        ],
      },
    ],
    [
      "invalid workspace ID",
      {
        workspaces: [
          {
            workspace: { ...workspace, id: "not-a-uuid" },
            member: { ...member, workspaceId: "not-a-uuid" },
          },
        ],
      },
    ],
  ]);
  const parsed = WorkspaceListResponseSchema.parse({
    workspaces: [{ ...item, memberCount: 3 }],
    total: 1,
  });
  assert.deepEqual(Object.keys(parsed), ["workspaces"]);
  assert.deepEqual(Object.keys(parsed.workspaces[0] ?? {}).sort(), [
    "member",
    "workspace",
  ]);
});

test("creating a workspace takes its name, the creator's display name, and an optional limit of unclaimed people", () => {
  const body = { name: "MyManDev", displayName: "Grace" };
  assert.equal(CreateWorkspaceRequestSchema.safeParse(body).success, true);
  for (const maxUnclaimedMembers of [1, 20, 500]) {
    assert.deepEqual(
      CreateWorkspaceRequestSchema.parse({ ...body, maxUnclaimedMembers }),
      { ...body, maxUnclaimedMembers },
      String(maxUnclaimedMembers),
    );
  }
  assert.equal(
    CreateWorkspaceRequestSchema.safeParse({
      name: "a".repeat(100),
      displayName: "a".repeat(64),
    }).success,
    true,
  );
  assertRejects(CreateWorkspaceRequestSchema, [
    ["name over 100", { ...body, name: "a".repeat(101) }],
    ["display name over 64", { ...body, displayName: "a".repeat(65) }],
    ["blank name", { ...body, name: "   " }],
    ["empty display name", { ...body, displayName: "" }],
    ["name with a line break", { ...body, name: "My\nManDev" }],
    [
      "display name with a bidirectional control",
      { ...body, displayName: "Grace\u202E" },
    ],
    ...withoutEach(body),
    ["name as a number", { ...body, name: 1 }],
    ["limit of 0", { ...body, maxUnclaimedMembers: 0 }],
    ["limit over 500", { ...body, maxUnclaimedMembers: 501 }],
    ["negative limit", { ...body, maxUnclaimedMembers: -1 }],
    ["fractional limit", { ...body, maxUnclaimedMembers: 20.5 }],
    ["limit as a string", { ...body, maxUnclaimedMembers: "500" }],
    ["null limit", { ...body, maxUnclaimedMembers: null }],
  ]);
  const parsed = CreateWorkspaceRequestSchema.parse({
    ...body,
    id: WORKSPACE_ID,
    role: "owner",
  });
  assert.deepEqual(Object.keys(parsed).sort(), ["displayName", "name"]);

  assert.equal(
    CreateWorkspaceResponseSchema.safeParse({ workspace, member: owner })
      .success,
    true,
  );
  assertRejects(
    CreateWorkspaceResponseSchema,
    withoutEach({ workspace, member: owner }),
  );
});

test("the workspace view shows every person, the pause, the limit of unclaimed people, and a valid ownership offer", () => {
  const view = {
    workspace,
    members: [owner, member, unclaimed, former],
    joinRequestsPausedAt: null,
    maxUnclaimedMembers: 500,
    ownershipOffer: null,
  };
  const offer = { memberId: MEMBER_ID, offeredAt: NOW, expiresAt: LATER };
  assert.equal(WorkspaceViewResponseSchema.safeParse(view).success, true);
  assert.equal(
    WorkspaceViewResponseSchema.safeParse({
      ...view,
      joinRequestsPausedAt: NOW,
      ownershipOffer: offer,
    }).success,
    true,
  );
  assert.equal(
    WorkspaceViewResponseSchema.safeParse({ ...view, maxUnclaimedMembers: 1 })
      .success,
    true,
  );
  assert.equal(
    WorkspaceViewResponseSchema.safeParse({
      ...view,
      members: [
        { ...owner, id: FORMER_ID, removedAt: NOW },
        { ...member, role: "owner" },
      ],
    }).success,
    true,
    "a former owner stays in history next to the current owner",
  );

  assertRejects(WorkspaceViewResponseSchema, [
    ...withoutEach(view),
    ...withoutEach(
      offer,
      (value) => ({ ...view, ownershipOffer: value }),
      "ownershipOffer.",
    ),
    ["no owner", { ...view, members: [member, unclaimed] }],
    ["no people", { ...view, members: [] }],
    ["people as a string", { ...view, members: "owner" }],
    ["people with a null entry", { ...view, members: [owner, null] }],
    ["offer as a string", { ...view, ownershipOffer: MEMBER_ID }],
    ["two owners", { ...view, members: [owner, { ...member, role: "owner" }] }],
    [
      "person of another workspace",
      {
        ...view,
        members: [owner, { ...member, workspaceId: OTHER_WORKSPACE_ID }],
      },
    ],
    [
      "offer to an unclaimed person",
      { ...view, ownershipOffer: { ...offer, memberId: UNCLAIMED_ID } },
    ],
    [
      "offer to a former member",
      { ...view, ownershipOffer: { ...offer, memberId: FORMER_ID } },
    ],
    [
      "offer to the owner",
      { ...view, ownershipOffer: { ...offer, memberId: OWNER_ID } },
    ],
    [
      "offer to an unknown person",
      { ...view, ownershipOffer: { ...offer, memberId: INVITATION_ID } },
    ],
    [
      "offer with an invalid ID",
      { ...view, ownershipOffer: { ...offer, memberId: "x" } },
    ],
    [
      "pause time without milliseconds",
      { ...view, joinRequestsPausedAt: "2026-10-29T12:00:00Z" },
    ],
    ["pause as a boolean", { ...view, joinRequestsPausedAt: true }],
    ["limit of 0", { ...view, maxUnclaimedMembers: 0 }],
    ["limit over 500", { ...view, maxUnclaimedMembers: 501 }],
    ["fractional limit", { ...view, maxUnclaimedMembers: 1.5 }],
    ["null limit", { ...view, maxUnclaimedMembers: null }],
    ["pause as undefined", { ...view, joinRequestsPausedAt: undefined }],
    ["offer as undefined", { ...view, ownershipOffer: undefined }],
    [
      "display name over 64",
      {
        ...view,
        members: [owner, { ...member, displayName: "a".repeat(65) }],
      },
    ],
  ]);
  const parsed = WorkspaceViewResponseSchema.parse({
    ...view,
    memberCount: 4,
    projects: [],
  });
  assert.deepEqual(Object.keys(parsed).sort(), [
    "joinRequestsPausedAt",
    "maxUnclaimedMembers",
    "members",
    "ownershipOffer",
    "workspace",
  ]);
});

test("the limit of unclaimed people lies from 1 to 500, 500 by default, below the answer list maximum", () => {
  assert.deepEqual(UNCLAIMED_MEMBER_LIMIT, { min: 1, max: 500, default: 500 });
  assert.equal(Object.isFrozen(UNCLAIMED_MEMBER_LIMIT), true);
  assert.ok(UNCLAIMED_MEMBER_LIMIT.max < MAX_ANSWER_LIST_ITEMS);

  for (const maxUnclaimedMembers of [1, 2, 499, 500]) {
    assert.deepEqual(
      SetUnclaimedMemberLimitRequestSchema.parse({
        maxUnclaimedMembers,
        workspaceId: WORKSPACE_ID,
      }),
      { maxUnclaimedMembers },
      String(maxUnclaimedMembers),
    );
  }
  assertRejects(SetUnclaimedMemberLimitRequestSchema, [
    ["0", { maxUnclaimedMembers: 0 }],
    ["501", { maxUnclaimedMembers: 501 }],
    ["negative", { maxUnclaimedMembers: -500 }],
    ["fractional", { maxUnclaimedMembers: 499.5 }],
    ["infinite", { maxUnclaimedMembers: Number.POSITIVE_INFINITY }],
    ["string", { maxUnclaimedMembers: "500" }],
    ["null", { maxUnclaimedMembers: null }],
    ["missing", {}],
  ]);
});

test("defining and renaming a person take a display name only", () => {
  for (const schema of [DefineMemberRequestSchema, RenameMemberRequestSchema]) {
    assert.equal(schema.safeParse({ displayName: "Linus" }).success, true);
    assertRejects(schema, [
      ["over 64", { displayName: "a".repeat(65) }],
      ["blank", { displayName: " \t " }],
      ["control character", { displayName: "Li\u0000nus" }],
      ["zero-width space", { displayName: "Li\u200Bnus" }],
      ["missing", {}],
      ["number", { displayName: 7 }],
    ]);
    const parsed = schema.parse({
      displayName: "Linus",
      role: "admin",
      userId: USER_ID,
    });
    assert.deepEqual(
      Object.keys(parsed),
      ["displayName"],
      "no role or account",
    );
  }
  assert.equal(
    DefineMemberResponseSchema.safeParse({ member: unclaimed }).success,
    true,
  );
  assertRejects(DefineMemberResponseSchema, [
    ["missing person", {}],
    ["unclaimed admin", { member: { ...unclaimed, role: "admin" } }],
  ]);
});

test("an ownership offer names one person by ID", () => {
  assert.equal(
    OfferOwnershipRequestSchema.safeParse({ memberId: MEMBER_ID }).success,
    true,
  );
  assertRejects(OfferOwnershipRequestSchema, [
    ...BAD_IDS.map((id): [string, unknown] => [
      `ID ${JSON.stringify(id)}`,
      { memberId: id },
    ]),
    ["missing", {}],
  ]);
  const parsed = OfferOwnershipRequestSchema.parse({
    memberId: MEMBER_ID,
    login: "ada-l",
  });
  assert.deepEqual(Object.keys(parsed), ["memberId"]);
});

test("live invitations are listed with their creators and never with a code", () => {
  const invitation = {
    id: INVITATION_ID,
    workspaceId: WORKSPACE_ID,
    memberId: UNCLAIMED_ID,
    createdByMemberId: OWNER_ID,
    createdAt: NOW,
    expiresAt: LATER,
  };
  assert.equal(
    InvitationListResponseSchema.safeParse({ invitations: [invitation] })
      .success,
    true,
  );
  assert.equal(
    InvitationListResponseSchema.safeParse({ invitations: [] }).success,
    true,
  );
  assertRejects(InvitationListResponseSchema, [
    ...withoutEach({ invitations: [invitation] }),
    ...withoutEach(
      invitation,
      (value) => ({ invitations: [value] }),
      "invitation.",
    ),
    [
      "invalid invitation ID",
      { invitations: [{ ...invitation, id: "not-a-uuid" }] },
    ],
    [
      "invalid creator",
      {
        invitations: [
          { ...invitation, createdByMemberId: OWNER_USER_ID.toUpperCase() },
        ],
      },
    ],
  ]);
  const parsed = InvitationListResponseSchema.parse({
    invitations: [{ ...invitation, code: invitationCode(), tokenHash: "00" }],
  });
  assert.deepEqual(Object.keys(parsed.invitations[0] ?? {}).sort(), [
    "createdAt",
    "createdByMemberId",
    "expiresAt",
    "id",
    "memberId",
    "workspaceId",
  ]);

  const code = invitationCode();
  assert.equal(
    CreateInvitationResponseSchema.safeParse({ invitation, code }).success,
    true,
  );
  assertRejects(CreateInvitationResponseSchema, [
    ...badCodes().map((bad): [string, unknown] => [
      `code ${bad.length} ${bad.slice(0, 5)}`,
      { invitation, code: bad },
    ]),
    ...withoutEach({ invitation, code }),
    ...withoutEach(
      invitation,
      (value) => ({ invitation: value, code }),
      "invitation.",
    ),
  ]);
});

test("an invitation is created for one person, with a lifetime from 1 hour to 7 days", () => {
  const body = { memberId: UNCLAIMED_ID };
  assert.equal(CreateInvitationRequestSchema.safeParse(body).success, true);
  for (const lifetimeSeconds of [3_600, 86_400, 604_800]) {
    assert.equal(
      CreateInvitationRequestSchema.safeParse({ ...body, lifetimeSeconds })
        .success,
      true,
      String(lifetimeSeconds),
    );
  }
  assertRejects(CreateInvitationRequestSchema, [
    ["under 1 hour", { ...body, lifetimeSeconds: 3_599 }],
    ["over 7 days", { ...body, lifetimeSeconds: 604_801 }],
    ["fractional", { ...body, lifetimeSeconds: 3_600.5 }],
    ["string", { ...body, lifetimeSeconds: "3600" }],
    ["null lifetime", { ...body, lifetimeSeconds: null }],
    ["invalid person ID", { memberId: "x" }],
    ["uppercase person ID", { memberId: UNCLAIMED_ID.toUpperCase() }],
    ...withoutEach(body),
    ["missing person with a lifetime", { lifetimeSeconds: 3_600 }],
  ]);
  const parsed = CreateInvitationRequestSchema.parse({
    ...body,
    githubLogin: "ada-l",
    role: "admin",
  });
  assert.deepEqual(Object.keys(parsed), ["memberId"]);
});

test("preview and accept take the code in the body, in its exact format", () => {
  for (const schema of [
    PreviewInvitationRequestSchema,
    AcceptInvitationRequestSchema,
  ]) {
    assert.equal(schema.safeParse({ code: invitationCode() }).success, true);
    assertRejects(schema, [
      ...badCodes().map((bad): [string, unknown] => [
        `code ${bad.length} ${bad.slice(0, 5)}`,
        { code: bad },
      ]),
      ["missing", {}],
      ["number", { code: 1 }],
    ]);
    const parsed = schema.parse({
      code: invitationCode(),
      workspaceId: WORKSPACE_ID,
    });
    assert.deepEqual(Object.keys(parsed), ["code"]);
  }
});

test("a preview shows the workspace name, the person, the inviter, and the expiry", () => {
  const preview = {
    workspaceName: "MyManDev",
    displayName: "Linus",
    inviter: {
      displayName: "Grace",
      identity: { provider: "github", login: "grace-h", verifiedAt: NOW },
    },
    expiresAt: LATER,
  };
  for (const [label, value] of [
    ["as listed", preview],
    ["workspace name of 100", { ...preview, workspaceName: "a".repeat(100) }],
    ["display name of 64", { ...preview, displayName: "a".repeat(64) }],
    [
      "inviter name of 64",
      {
        ...preview,
        inviter: { ...preview.inviter, displayName: "a".repeat(64) },
      },
    ],
  ] as const) {
    assert.equal(
      PreviewInvitationResponseSchema.safeParse(value).success,
      true,
      label,
    );
  }
  assertRejects(PreviewInvitationResponseSchema, [
    ...withoutEach(preview),
    ...withoutEach(
      preview.inviter,
      (value) => ({ ...preview, inviter: value }),
      "inviter.",
    ),
    ...withoutEach(
      preview.inviter.identity,
      (value) => ({
        ...preview,
        inviter: { ...preview.inviter, identity: value },
      }),
      "inviter.identity.",
    ),
    ["workspace name over 100", { ...preview, workspaceName: "a".repeat(101) }],
    ["display name over 64", { ...preview, displayName: "a".repeat(65) }],
    [
      "inviter name over 64",
      {
        ...preview,
        inviter: { ...preview.inviter, displayName: "a".repeat(65) },
      },
    ],
    [
      "inviter with a bad login",
      {
        ...preview,
        inviter: {
          ...preview.inviter,
          identity: { ...preview.inviter.identity, login: "grace h" },
        },
      },
    ],
    [
      "inviter without an identity",
      { ...preview, inviter: { ...preview.inviter, identity: null } },
    ],
    [
      "expiry with an offset",
      { ...preview, expiresAt: "2026-11-05T14:00:00.000+02:00" },
    ],
  ]);
  const parsed = PreviewInvitationResponseSchema.parse({
    ...preview,
    workspaceId: WORKSPACE_ID,
    members: [owner],
    memberCount: 3,
  });
  assert.deepEqual(Object.keys(parsed).sort(), [
    "displayName",
    "expiresAt",
    "inviter",
    "workspaceName",
  ]);

  assert.equal(
    AcceptInvitationResponseSchema.safeParse({ workspace, member }).success,
    true,
  );
  assertRejects(AcceptInvitationResponseSchema, [
    ["claimed nobody", { workspace, member: unclaimed }],
    ...withoutEach({ workspace, member }),
  ]);
});

test("a join request names the workspace and a display name, and nothing else", () => {
  const body = { workspaceId: WORKSPACE_ID, displayName: "Ada" };
  assert.equal(CreateJoinRequestRequestSchema.safeParse(body).success, true);
  assertRejects(CreateJoinRequestRequestSchema, [
    ...BAD_IDS.map((id): [string, unknown] => [
      `workspace ID ${JSON.stringify(id)}`,
      { ...body, workspaceId: id },
    ]),
    ["display name over 64", { ...body, displayName: "a".repeat(65) }],
    ["blank display name", { ...body, displayName: "  " }],
    ...withoutEach(body),
  ]);
  const parsed = CreateJoinRequestRequestSchema.parse({
    ...body,
    note: "Please let me in",
    code: invitationCode(),
  });
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["displayName", "workspaceId"],
    "no free-text note",
  );

  const own = {
    id: JOIN_REQUEST_ID,
    workspaceId: WORKSPACE_ID,
    requestedDisplayName: "Ada",
    createdAt: NOW,
    expiresAt: LATER,
  };
  assert.equal(
    CreateJoinRequestResponseSchema.safeParse({ joinRequest: own }).success,
    true,
  );
  assertRejects(CreateJoinRequestResponseSchema, [
    ["invalid ID", { joinRequest: { ...own, id: "x" } }],
    [
      "name over 64",
      { joinRequest: { ...own, requestedDisplayName: "a".repeat(65) } },
    ],
    ...withoutEach({ joinRequest: own }),
    ...withoutEach(own, (value) => ({ joinRequest: value }), "joinRequest."),
  ]);
  const ownParsed = CreateJoinRequestResponseSchema.parse({
    joinRequest: { ...own, workspaceName: "MyManDev", memberCount: 3 },
  });
  assert.deepEqual(
    Object.keys(ownParsed.joinRequest).sort(),
    ["createdAt", "expiresAt", "id", "requestedDisplayName", "workspaceId"],
    "the requester sees nothing about the workspace",
  );
});

test("approvers see the requester's GitHub login and account creation date", () => {
  const pending = {
    id: JOIN_REQUEST_ID,
    workspaceId: WORKSPACE_ID,
    requestedDisplayName: "Ada",
    requester: {
      provider: "github",
      login: "ada-l",
      verifiedAt: NOW,
      accountCreatedAt: GITHUB_CREATED,
    },
    createdAt: NOW,
    expiresAt: LATER,
    decision: null,
    decidedAt: null,
  };
  const blocked = { ...pending, decision: "blocked", decidedAt: NOW };
  assert.equal(
    JoinRequestListResponseSchema.safeParse({
      joinRequests: [pending, blocked],
    }).success,
    true,
  );
  assert.equal(
    JoinRequestListResponseSchema.safeParse({
      joinRequests: [{ ...blocked, requester: null }],
    }).success,
    true,
    "a block of an erased account stays listed",
  );
  const one = (request: unknown) => ({ joinRequests: [request] });
  assertRejects(JoinRequestListResponseSchema, [
    ...withoutEach(one(pending)),
    ...withoutEach(pending, one, "joinRequest."),
    ...withoutEach(
      pending.requester,
      (value) => one({ ...pending, requester: value }),
      "requester.",
    ),
    ...withoutEach(blocked, one, "blocked joinRequest."),
    ["pending without a requester", one({ ...pending, requester: null })],
    [
      "requester with a bad login",
      one({
        ...pending,
        requester: { ...pending.requester, login: "-".repeat(40) },
      }),
    ],
    [
      "account creation date without milliseconds",
      one({
        ...pending,
        requester: {
          ...pending.requester,
          accountCreatedAt: "2011-01-25T18:44:36Z",
        },
      }),
    ],
    ["decision without a time", one({ ...pending, decision: "denied" })],
    ["time without a decision", one({ ...pending, decidedAt: NOW })],
    ["unknown decision", one({ ...blocked, decision: "ignored" })],
    ["invalid ID", one({ ...pending, id: JOIN_REQUEST_ID.toUpperCase() })],
    [
      "requested name over 64",
      one({ ...pending, requestedDisplayName: "a".repeat(65) }),
    ],
  ]);
  const parsed = JoinRequestListResponseSchema.parse(
    one({
      ...pending,
      requesterUserId: USER_ID,
      note: "hello",
      requester: { ...pending.requester, email: "never@example.invalid" },
    }),
  );
  const request = parsed.joinRequests[0];
  assert.ok(request);
  assert.equal("note" in request, false);
  assert.equal("requesterUserId" in request, false);
  assert.equal(
    request.requester !== null && "email" in request.requester,
    false,
  );
});

/** A pending request as the approvers' list shows it. */
const pendingRequest = {
  id: JOIN_REQUEST_ID,
  workspaceId: WORKSPACE_ID,
  requestedDisplayName: "Ada",
  requester: {
    provider: "github",
    login: "ada-l",
    verifiedAt: NOW,
    accountCreatedAt: GITHUB_CREATED,
  },
  createdAt: NOW,
  expiresAt: LATER,
  decision: null,
  decidedAt: null,
};

function joinRequestEvent(type: string, payload: unknown) {
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

const created = (joinRequest: unknown) =>
  joinRequestEvent("workspace.join_request.created", { joinRequest });

const resolved = (payload: unknown) =>
  joinRequestEvent("workspace.join_request.resolved", payload);

const unblocked = (payload: unknown) =>
  joinRequestEvent("workspace.join_request.unblocked", payload);

test("a join request event comes only from the server, with a system actor and no device, and reaches a device", () => {
  const events = [
    created(pendingRequest),
    ...["approved", "denied", "withdrawn", "blocked"].map((outcome) =>
      resolved({ joinRequestId: JOIN_REQUEST_ID, outcome }),
    ),
    unblocked({ joinRequestId: JOIN_REQUEST_ID }),
  ];
  for (const event of events) {
    const label = `${event.type} ${JSON.stringify(event.payload)}`;
    assert.deepEqual(decodeEvent(event), { ok: true, event }, label);
    assert.deepEqual(
      decodeServerMessage(event),
      { ok: true, kind: "event", event },
      `${label} reaches a device`,
    );
    assert.equal(
      (SERVER_ONLY_EVENT_TYPES as readonly string[]).includes(event.type),
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
      decodeServerMessage({ ...event, deviceId: DEVICE_ID }),
      { ok: false, code: "invalid_actor" },
      `${label} from the server with a device`,
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
    // The forgery a device would try: its own user and device.
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

test("workspace.join_request.created carries the new pending request as the approvers' list shows it", () => {
  const parsed = WorkspaceJoinRequestCreatedEventSchema.parse(
    created({
      ...pendingRequest,
      requesterUserId: USER_ID,
      requesterDeviceId: DEVICE_ID,
      note: "hello",
      requester: {
        ...pendingRequest.requester,
        email: "never@example.invalid",
      },
    }),
  );
  assert.deepEqual(parsed.payload.joinRequest, pendingRequest);
  assert.deepEqual(Object.keys(parsed.payload), ["joinRequest"]);

  const rejected: [label: string, value: unknown][] = [
    [
      "missing payload.joinRequest",
      joinRequestEvent("workspace.join_request.created", {}),
    ],
    ["no payload", joinRequestEvent("workspace.join_request.created", null)],
    ...withoutEach(pendingRequest, created, "joinRequest."),
    ...withoutEach(
      pendingRequest.requester,
      (requester) => created({ ...pendingRequest, requester }),
      "requester.",
    ),
    [
      "a request of another workspace",
      created({ ...pendingRequest, workspaceId: OTHER_WORKSPACE_ID }),
    ],
    ...["approved", "denied", "withdrawn", "blocked", "expired"].map(
      (decision): [string, unknown] => [
        `a ${decision} request`,
        created({ ...pendingRequest, decision, decidedAt: NOW }),
      ],
    ),
    [
      "a pending request without its requester",
      created({ ...pendingRequest, requester: null }),
    ],
    [
      "a decision time without a decision",
      created({ ...pendingRequest, decidedAt: NOW }),
    ],
    ["no request", created(null)],
    ["an invalid request ID", created({ ...pendingRequest, id: "x" })],
    [
      "a requested name over 64",
      created({ ...pendingRequest, requestedDisplayName: "a".repeat(65) }),
    ],
    [
      "a requester with a bad login",
      created({
        ...pendingRequest,
        requester: { ...pendingRequest.requester, login: "-".repeat(40) },
      }),
    ],
    [
      "an account creation date without milliseconds",
      created({
        ...pendingRequest,
        requester: {
          ...pendingRequest.requester,
          accountCreatedAt: "2011-01-25T18:44:36Z",
        },
      }),
    ],
  ];
  for (const [label, value] of rejected) {
    assert.deepEqual(
      decodeEvent(value),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
});

test("workspace.join_request.resolved carries the request ID and its outcome, never an expiry or an unknown outcome", () => {
  assert.deepEqual(
    [...JoinRequestOutcomeSchema.options].sort(),
    JOIN_REQUEST_DECISIONS.filter((decision) => decision !== "expired").sort(),
  );
  assert.deepEqual([...JoinRequestOutcomeSchema.options].sort(), [
    "approved",
    "blocked",
    "denied",
    "withdrawn",
  ]);
  const valid = { joinRequestId: JOIN_REQUEST_ID, outcome: "approved" };
  const parsed = WorkspaceJoinRequestResolvedEventSchema.parse(
    resolved({
      ...valid,
      requesterUserId: USER_ID,
      decidedBy: OWNER_USER_ID,
      memberId: MEMBER_ID,
    }),
  );
  assert.deepEqual(parsed.payload, valid);

  const rejected: [label: string, value: unknown][] = [
    ...withoutEach(valid, resolved, "payload."),
    ["no payload", resolved(undefined)],
    ...["expired", "ignored", "Approved", "pending", "", null, 1].map(
      (outcome): [string, unknown] => [
        `the outcome ${JSON.stringify(outcome)}`,
        resolved({ ...valid, outcome }),
      ],
    ),
    [
      "an invalid request ID",
      resolved({ ...valid, joinRequestId: JOIN_REQUEST_ID.toUpperCase() }),
    ],
    [
      "a member ID instead",
      resolved({ outcome: "approved", memberId: MEMBER_ID }),
    ],
  ];
  for (const [label, value] of rejected) {
    assert.deepEqual(
      decodeEvent(value),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
});

test("workspace.join_request.unblocked carries only the ID of the request whose block was lifted", () => {
  const valid = { joinRequestId: JOIN_REQUEST_ID };
  assert.deepEqual(decodeEvent(unblocked(valid)), {
    ok: true,
    event: unblocked(valid),
  });
  // An unknown field is stripped, as on every event: a lifted block has no
  // outcome, and the requester stays unnamed.
  const parsed = WorkspaceJoinRequestUnblockedEventSchema.parse(
    unblocked({
      ...valid,
      outcome: "unblocked",
      requesterUserId: USER_ID,
      unblockedBy: OWNER_USER_ID,
    }),
  );
  assert.deepEqual(parsed.payload, valid);
  assert.deepEqual(Object.keys(parsed.payload), ["joinRequestId"]);

  const rejected: [label: string, value: unknown][] = [
    ...withoutEach(valid, unblocked, "payload."),
    ["no payload", unblocked(undefined)],
    ["a null payload", unblocked(null)],
    ["a null request ID", unblocked({ joinRequestId: null })],
    [
      "an invalid request ID",
      unblocked({ joinRequestId: JOIN_REQUEST_ID.toUpperCase() }),
    ],
    ["a member ID instead", unblocked({ memberId: MEMBER_ID })],
  ];
  for (const [label, value] of rejected) {
    assert.deepEqual(
      decodeEvent(value),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
  // A device never sends it, also when it is otherwise valid.
  assert.deepEqual(decodeClientEvent(unblocked(valid)), {
    ok: false,
    code: "not_allowed_from_device",
  });
  assert.deepEqual(decodeClientMessage(unblocked(valid)), {
    ok: false,
    code: "not_allowed_from_device",
  });
});

test("the requester's own list shows how each request ended, a block as a denial, and nothing about the workspace", () => {
  const pending = {
    id: JOIN_REQUEST_ID,
    workspaceId: WORKSPACE_ID,
    requestedDisplayName: "Ada",
    createdAt: NOW,
    expiresAt: LATER,
    decision: null,
    decidedAt: null,
  };
  const ended = ["approved", "denied", "withdrawn", "expired"].map(
    (decision) => ({ ...pending, decision, decidedAt: LATER }),
  );
  assert.equal(
    OwnJoinRequestListResponseSchema.safeParse({
      joinRequests: [pending, ...ended],
    }).success,
    true,
  );
  assert.equal(
    OwnJoinRequestListResponseSchema.safeParse({ joinRequests: [] }).success,
    true,
  );
  const one = (request: unknown) => ({ joinRequests: [request] });
  assertRejects(OwnJoinRequestListResponseSchema, [
    ...withoutEach(one(pending)),
    ...withoutEach(pending, one, "joinRequest."),
    ["a block", one({ ...pending, decision: "blocked", decidedAt: NOW })],
    ["decision without a time", one({ ...pending, decision: "denied" })],
    ["time without a decision", one({ ...pending, decidedAt: NOW })],
    [
      "unknown decision",
      one({ ...pending, decision: "ignored", decidedAt: NOW }),
    ],
    ["invalid ID", one({ ...pending, id: "x" })],
    [
      "requested name over 64",
      one({ ...pending, requestedDisplayName: "a".repeat(65) }),
    ],
  ]);
  const parsed = OwnJoinRequestListResponseSchema.parse(
    one({
      ...pending,
      workspaceName: "MyManDev",
      memberCount: 3,
      requester: { provider: "github", login: "ada-l" },
      decidedBy: OWNER_USER_ID,
      memberId: MEMBER_ID,
    }),
  );
  assert.deepEqual(
    Object.keys(parsed.joinRequests[0] ?? {}).sort(),
    [
      "createdAt",
      "decidedAt",
      "decision",
      "expiresAt",
      "id",
      "requestedDisplayName",
      "workspaceId",
    ],
    "the requester sees nothing about the workspace or the approver",
  );
});

test("an approval may change the display name and answers with the new person", () => {
  assert.equal(ApproveJoinRequestRequestSchema.safeParse({}).success, true);
  assert.equal(
    ApproveJoinRequestRequestSchema.safeParse({ displayName: "Ada L." })
      .success,
    true,
  );
  assertRejects(ApproveJoinRequestRequestSchema, [
    ["over 64", { displayName: "a".repeat(65) }],
    ["blank", { displayName: " " }],
    ["null", { displayName: null }],
  ]);
  const parsed = ApproveJoinRequestRequestSchema.parse({ role: "admin" });
  assert.deepEqual(Object.keys(parsed), [], "an approval never sets a role");

  assert.equal(
    ApproveJoinRequestResponseSchema.safeParse({ member }).success,
    true,
  );
  assertRejects(ApproveJoinRequestResponseSchema, [
    ...withoutEach({ member }),
    ["null person", { member: null }],
    ["invalid person", { member: { ...member, id: "x" } }],
  ]);
});

test("owners and admins see each recent claim with the claimer's GitHub login and account creation date and how the person was claimed, the most recent first", () => {
  const claimer = {
    provider: "github",
    login: "ada-l",
    verifiedAt: LATER,
    accountCreatedAt: GITHUB_CREATED,
  };
  const recent = {
    workspaceId: WORKSPACE_ID,
    memberId: MEMBER_ID,
    claimer,
    via: "invitation",
    claimedAt: LATER,
  };
  // The claim of an account whose data was erased stays, without a claimer.
  const erased = {
    ...recent,
    memberId: FORMER_ID,
    claimer: null,
    via: "join_request",
    claimedAt: NOW,
  };
  assert.equal(ClaimSchema.safeParse(recent).success, true);
  assert.equal(ClaimSchema.safeParse(erased).success, true);
  assert.equal(
    ClaimListResponseSchema.safeParse({ claims: [recent, erased] }).success,
    true,
  );
  assert.equal(ClaimListResponseSchema.safeParse({ claims: [] }).success, true);
  assert.equal(
    ClaimListResponseSchema.safeParse({
      claims: [{ ...erased, claimedAt: LATER }, recent],
    }).success,
    true,
    "claims of the same time keep any order",
  );
  const one = (value: unknown) => ({ claims: [value] });
  assertRejects(ClaimListResponseSchema, [
    ...withoutEach({ claims: [recent] }),
    ...withoutEach(recent, one, "claim."),
    ...withoutEach(
      claimer,
      (value) => one({ ...recent, claimer: value }),
      "claimer.",
    ),
    ["the oldest first", { claims: [erased, recent] }],
    ["a person twice", { claims: [recent, { ...recent, claimedAt: NOW }] }],
    [
      "a claim of another workspace",
      { claims: [recent, { ...erased, workspaceId: OTHER_WORKSPACE_ID }] },
    ],
    [
      "claim time without milliseconds",
      one({ ...recent, claimedAt: "2026-11-05T12:00:00Z" }),
    ],
    [
      "claim time with an offset",
      one({ ...recent, claimedAt: "2026-11-05T14:00:00.000+02:00" }),
    ],
    ["claim time null", one({ ...recent, claimedAt: null })],
    [
      "account creation date without milliseconds",
      one({
        ...recent,
        claimer: { ...claimer, accountCreatedAt: "2011-01-25T18:44:36Z" },
      }),
    ],
    [
      "account creation date null",
      one({ ...recent, claimer: { ...claimer, accountCreatedAt: null } }),
    ],
    [
      "claimer with a bad login",
      one({ ...recent, claimer: { ...claimer, login: "-".repeat(40) } }),
    ],
    [
      "claimer of an unknown provider",
      one({ ...recent, claimer: { ...claimer, provider: "gitlab" } }),
    ],
    [
      "invalid person ID",
      one({ ...recent, memberId: MEMBER_ID.toUpperCase() }),
    ],
    ["invalid workspace ID", one({ ...recent, workspaceId: "x" })],
    // A closed list: a third way of claiming needs a protocol change.
    ["unknown way of claiming", one({ ...recent, via: "approval" })],
    ["the creator's own person", one({ ...recent, via: "workspace_created" })],
    ["no way of claiming", one({ ...recent, via: null })],
    ["way of claiming in capitals", one({ ...recent, via: "INVITATION" })],
    ["no list", { claims: null }],
  ]);
  // Nothing beyond the person, the claimer's identity, how, and when.
  const parsed = ClaimListResponseSchema.parse(
    one({
      ...recent,
      userId: USER_ID,
      displayName: "Ada",
      invitationId: INVITATION_ID,
      claimer: {
        ...claimer,
        subject: "583231",
        email: "never@example.invalid",
      },
    }),
  );
  const [item] = parsed.claims;
  assert.ok(item);
  assert.deepEqual(Object.keys(item).sort(), [
    "claimedAt",
    "claimer",
    "memberId",
    "via",
    "workspaceId",
  ]);
  assert.deepEqual(Object.keys(item.claimer ?? {}).sort(), [
    "accountCreatedAt",
    "login",
    "provider",
    "verifiedAt",
  ]);
});

test("every route with a body has its schemas, and they export to JSON Schema", () => {
  const schemas = {
    listWorkspaces: [null, WorkspaceListResponseSchema],
    createWorkspace: [
      CreateWorkspaceRequestSchema,
      CreateWorkspaceResponseSchema,
    ],
    getWorkspace: [null, WorkspaceViewResponseSchema],
    setUnclaimedMemberLimit: [SetUnclaimedMemberLimitRequestSchema, null],
    defineMember: [DefineMemberRequestSchema, DefineMemberResponseSchema],
    renameMember: [RenameMemberRequestSchema, null],
    removeMember: [null, null],
    promoteMember: [null, null],
    demoteMember: [null, null],
    leaveWorkspace: [null, null],
    offerOwnership: [OfferOwnershipRequestSchema, null],
    acceptOwnershipOffer: [null, null],
    withdrawOwnershipOffer: [null, null],
    listInvitations: [null, InvitationListResponseSchema],
    createInvitation: [
      CreateInvitationRequestSchema,
      CreateInvitationResponseSchema,
    ],
    revokeInvitation: [null, null],
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
    listOwnJoinRequests: [null, OwnJoinRequestListResponseSchema],
    withdrawJoinRequest: [null, null],
    listJoinRequests: [null, JoinRequestListResponseSchema],
    approveJoinRequest: [
      ApproveJoinRequestRequestSchema,
      ApproveJoinRequestResponseSchema,
    ],
    denyJoinRequest: [null, null],
    blockJoinRequest: [null, null],
    unblockJoinRequest: [null, null],
    denyAllJoinRequests: [null, null],
    pauseJoinRequests: [null, null],
    resumeJoinRequests: [null, null],
    listClaims: [null, ClaimListResponseSchema],
  } satisfies Record<
    MembershipRouteName,
    [request: z.ZodType | null, response: z.ZodType | null]
  >;
  assert.deepEqual(Object.keys(schemas), Object.keys(MEMBERSHIP_ROUTES));
  for (const [name, [request, response]] of Object.entries(schemas)) {
    const route = MEMBERSHIP_ROUTES[name as MembershipRouteName];
    if (route.method === "GET") {
      assert.equal(request, null, `${name}: a GET has no body`);
      assert.notEqual(response, null, `${name}: a GET answers with a body`);
    }
    for (const schema of [request, response]) {
      if (schema !== null) {
        const json = z.toJSONSchema(schema, { io: "input" });
        assert.equal(typeof json, "object", name);
      }
    }
  }
});

test("every answer list holds at most MAX_ANSWER_LIST_ITEMS items", () => {
  const invitation = {
    id: INVITATION_ID,
    workspaceId: WORKSPACE_ID,
    memberId: UNCLAIMED_ID,
    createdByMemberId: OWNER_ID,
    createdAt: NOW,
    expiresAt: LATER,
  };
  const joinRequest = {
    id: JOIN_REQUEST_ID,
    workspaceId: WORKSPACE_ID,
    requestedDisplayName: "Ada",
    requester: {
      provider: "github",
      login: "ada-l",
      verifiedAt: NOW,
      accountCreatedAt: GITHUB_CREATED,
    },
    createdAt: NOW,
    expiresAt: LATER,
    decision: null,
    decidedAt: null,
  };
  const claim = {
    workspaceId: WORKSPACE_ID,
    memberId: MEMBER_ID,
    claimer: joinRequest.requester,
    via: "join_request",
    claimedAt: NOW,
  };
  const lists: [
    label: string,
    build: (count: number) => unknown,
    schema: { safeParse(value: unknown): { success: boolean } },
  ][] = [
    [
      "workspaces",
      (count) => ({
        workspaces: Array(count).fill({ workspace, member: owner }),
      }),
      WorkspaceListResponseSchema,
    ],
    [
      "people",
      (count) => ({
        workspace,
        members: [owner, ...Array(count - 1).fill(former)],
        joinRequestsPausedAt: null,
        maxUnclaimedMembers: 500,
        ownershipOffer: null,
      }),
      WorkspaceViewResponseSchema,
    ],
    [
      "invitations",
      (count) => ({ invitations: Array(count).fill(invitation) }),
      InvitationListResponseSchema,
    ],
    [
      "join requests",
      (count) => ({ joinRequests: Array(count).fill(joinRequest) }),
      JoinRequestListResponseSchema,
    ],
    [
      "own join requests",
      (count) => ({
        joinRequests: Array(count).fill({
          id: JOIN_REQUEST_ID,
          workspaceId: WORKSPACE_ID,
          requestedDisplayName: "Ada",
          createdAt: NOW,
          expiresAt: LATER,
          decision: null,
          decidedAt: null,
        }),
      }),
      OwnJoinRequestListResponseSchema,
    ],
    [
      "claims",
      // A person is claimed once, so each claim names its own person.
      (count) => ({
        claims: Array.from({ length: count }, () => ({
          ...claim,
          memberId: newId<MemberId>(),
        })),
      }),
      ClaimListResponseSchema,
    ],
  ];
  assert.equal(MAX_ANSWER_LIST_ITEMS, 1_000);
  for (const [label, build, schema] of lists) {
    assert.equal(
      schema.safeParse(build(MAX_ANSWER_LIST_ITEMS)).success,
      true,
      `${label} at the maximum`,
    );
    assert.equal(
      schema.safeParse(build(MAX_ANSWER_LIST_ITEMS + 1)).success,
      false,
      `${label} over the maximum`,
    );
  }
});
