import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  AccessTokenSchema,
  ApiErrorBodySchema,
  Base64Url32BytesSchema,
  DeviceListItemSchema,
  DevicePublicKeySchema,
  DeviceSignatureSchema,
  GitHubLoginSchema,
  InvitationCodeSchema,
  MemberRoleSchema,
  RunCancelReasonSchema,
  SignInCodeSchema,
  WorkspaceMemberSchema,
} from "./account.ts";

const WORKSPACE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const MEMBER_ID = "0192f2a0-7c3e-7d2e-9f10-112233445566";
const USER_ID = "0192f2a0-7c3e-7f00-a000-000000000001";
const NOW = "2026-10-29T12:00:00.000Z";

const claimed = {
  id: MEMBER_ID,
  workspaceId: WORKSPACE_ID,
  displayName: "Ada",
  role: "admin",
  userId: USER_ID,
  identity: { provider: "github", login: "ada-l", verifiedAt: NOW },
  removedAt: null,
};

const unclaimed = {
  ...claimed,
  role: "member",
  userId: null,
  identity: null,
};

test("a workspace member is claimed with an identity, or unclaimed as a member without one", () => {
  assert.equal(WorkspaceMemberSchema.safeParse(claimed).success, true);
  assert.equal(WorkspaceMemberSchema.safeParse(unclaimed).success, true);
  assert.equal(
    WorkspaceMemberSchema.safeParse({
      ...claimed,
      role: "owner",
      removedAt: NOW,
    }).success,
    true,
    "a former owner stays in history",
  );
  assert.equal(
    WorkspaceMemberSchema.safeParse({
      ...claimed,
      identity: null,
      removedAt: NOW,
    }).success,
    true,
    "an erased account keeps its user ID without an identity",
  );

  const rejected: [label: string, value: unknown][] = [
    ["unclaimed owner", { ...unclaimed, role: "owner" }],
    ["unclaimed admin", { ...unclaimed, role: "admin" }],
    ["identity without a user", { ...unclaimed, identity: claimed.identity }],
    ["unknown role", { ...claimed, role: "viewer" }],
    [
      "unknown provider",
      { ...claimed, identity: { ...claimed.identity, provider: "gitlab" } },
    ],
    [
      "bad login",
      { ...claimed, identity: { ...claimed.identity, login: "ada l" } },
    ],
    [
      "timestamp without milliseconds",
      { ...claimed, removedAt: "2026-10-29T12:00:00Z" },
    ],
    ["blank display name", { ...claimed, displayName: "  " }],
    ["display name over 64", { ...claimed, displayName: "a".repeat(65) }],
    [
      "display name with a bidirectional control",
      { ...claimed, displayName: "Ada\u202E" },
    ],
    ["user ID as the member ID", { ...claimed, id: "not-a-uuid" }],
    ["missing removedAt", { ...claimed, removedAt: undefined }],
  ];
  for (const [label, value] of rejected) {
    assert.equal(WorkspaceMemberSchema.safeParse(value).success, false, label);
  }
});

test("unknown fields are stripped from a member", () => {
  const parsed = WorkspaceMemberSchema.parse({
    ...claimed,
    email: "never@example.invalid",
    identity: {
      ...claimed.identity,
      avatarUrl: "https://example.invalid/a.png",
    },
  });
  assert.equal("email" in parsed, false);
  assert.equal(
    parsed.identity !== null && "avatarUrl" in parsed.identity,
    false,
  );
});

test("a device list item has nullable last seen and revoked times", () => {
  const item = {
    id: USER_ID,
    label: "Work laptop",
    platform: "windows",
    createdAt: NOW,
    lastSeenAt: null,
    lastSignInAt: NOW,
    signInExpiresAt: "2026-11-28T12:00:00.000Z",
    revokedAt: null,
    current: true,
  };
  assert.equal(DeviceListItemSchema.safeParse(item).success, true);
  assert.equal(
    DeviceListItemSchema.safeParse({
      ...item,
      lastSeenAt: NOW,
      revokedAt: NOW,
      current: false,
    }).success,
    true,
  );
  for (const [label, value] of [
    ["unknown platform", { ...item, platform: "android" }],
    ["missing sign-in expiry", { ...item, signInExpiresAt: undefined }],
    ["current as a string", { ...item, current: "true" }],
    ["label over 64", { ...item, label: "a".repeat(65) }],
  ] as const) {
    assert.equal(DeviceListItemSchema.safeParse(value).success, false, label);
  }
});

test("the error body carries a known code and only the status text", () => {
  const body = {
    statusCode: 404,
    error: "Not Found",
    message: "Not Found",
    code: "not_found",
  };
  assert.equal(ApiErrorBodySchema.safeParse(body).success, true);
  for (const [label, value] of [
    ["unknown code", { ...body, code: "teapot" }],
    ["missing code", { ...body, code: undefined }],
    ["status below 400", { ...body, statusCode: 302 }],
    ["status above 599", { ...body, statusCode: 600 }],
    ["fractional status", { ...body, statusCode: 404.5 }],
    ["long message", { ...body, message: "x".repeat(101) }],
  ] as const) {
    assert.equal(ApiErrorBodySchema.safeParse(value).success, false, label);
  }
});

test("the format schemas accept only their own format", () => {
  const bytes32 = randomBytes(32).toString("base64url");
  const cases: [
    label: string,
    schema: { safeParse(value: unknown): { success: boolean } },
    valid: string,
    invalid: string[],
  ][] = [
    [
      "state",
      Base64Url32BytesSchema,
      bytes32,
      [`${bytes32}=`, bytes32.slice(1), `mmdc_${bytes32}`],
    ],
    [
      "sign-in code",
      SignInCodeSchema,
      `mmdc_${bytes32}`,
      [bytes32, `mmda_${bytes32}`, `mmdc_${bytes32}A`],
    ],
    [
      "access token",
      AccessTokenSchema,
      `mmda_${bytes32}`,
      [`mmdi_${bytes32}`, `Bearer mmda_${bytes32}`],
    ],
    [
      "invitation code",
      InvitationCodeSchema,
      `mmdi_${bytes32}`,
      [`mmdi_${bytes32.slice(1)}`, ` mmdi_${bytes32}`],
    ],
    [
      "public key",
      DevicePublicKeySchema,
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      [
        "D75A980182B10AB7D54BFED3C964073A0EE172F3DAA62325AF021A68F707511A",
        "d75a98",
      ],
    ],
    [
      "signature",
      DeviceSignatureSchema,
      randomBytes(64).toString("base64url"),
      [
        randomBytes(64).toString("base64"),
        randomBytes(63).toString("base64url"),
      ],
    ],
    [
      "GitHub login",
      GitHubLoginSchema,
      "octocat",
      ["", "a".repeat(40), "octo cat"],
    ],
  ];
  for (const [label, schema, valid, invalid] of cases) {
    assert.equal(schema.safeParse(valid).success, true, label);
    for (const value of invalid) {
      assert.equal(
        schema.safeParse(value).success,
        false,
        `${label}: ${value}`,
      );
    }
    assert.equal(schema.safeParse(42).success, false, `${label}: number`);
  }
});

test("the vocabulary schemas match exactly", () => {
  assert.equal(MemberRoleSchema.safeParse("owner").success, true);
  assert.equal(MemberRoleSchema.safeParse("Owner").success, false);
  assert.equal(RunCancelReasonSchema.safeParse("device_revoked").success, true);
  assert.equal(RunCancelReasonSchema.safeParse("removed").success, false);
});
