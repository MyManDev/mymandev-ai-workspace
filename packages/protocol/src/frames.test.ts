import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeClientEvent, decodeEvent } from "./decode.ts";
import { EVENT_TYPES, SERVER_ONLY_EVENT_TYPES } from "./envelope.ts";
import {
  CLIENT_FRAME_TYPES,
  decodeClientFrame,
  decodeServerMessage,
  MAX_AUTH_FRAME_BYTES,
  SERVER_FRAME_TYPES,
  WS_AUTH_TIMEOUT_MS,
} from "./frames.ts";
import {
  EVENT_TYPE_PATTERN,
  FRAME_TYPE_PATTERN,
  WS_CLOSE_CODES,
} from "./model.ts";

const EVENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000001";
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000003";
const OTHER_WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000013";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009";
const CONNECTION_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000b";
const MEMBER_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000c";
const OTHER_MEMBER_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000d";
const NOW = "2026-10-30T17:00:00.000Z";
const NONCE = "A".repeat(43);
const SIGNATURE = "A".repeat(86);

type Json = Record<string, unknown>;

function authResponse(): Json {
  return {
    protocolVersion: 0,
    type: "auth.response",
    deviceId: DEVICE_ID,
    signature: SIGNATURE,
  };
}

function serverFrames(): Json[] {
  return [
    {
      protocolVersion: 0,
      type: "auth.challenge",
      nonce: NONCE,
      connectionId: CONNECTION_ID,
    },
    {
      protocolVersion: 0,
      type: "auth.ok",
      userId: USER_ID,
      deviceId: DEVICE_ID,
      signInExpiresAt: NOW,
    },
    {
      protocolVersion: 0,
      type: "account.device_registered",
      device: {
        id: DEVICE_ID,
        label: "Laptop",
        platform: "macos",
        createdAt: NOW,
        lastSeenAt: null,
        lastSignInAt: NOW,
        signInExpiresAt: NOW,
        revokedAt: null,
        current: false,
      },
    },
    {
      protocolVersion: 0,
      type: "account.device_revoked",
      deviceId: DEVICE_ID,
      reason: "lost",
      revokedAt: NOW,
    },
    {
      protocolVersion: 0,
      type: "account.removed_from_workspace",
      workspaceId: WORKSPACE_ID,
      removedAt: NOW,
    },
    {
      protocolVersion: 0,
      type: "account.ownership_offered",
      workspaceId: WORKSPACE_ID,
      offer: { memberId: MEMBER_ID, offeredAt: NOW, expiresAt: NOW },
    },
    {
      protocolVersion: 0,
      type: "account.ownership_offer_ended",
      workspaceId: WORKSPACE_ID,
      reason: "withdrawn",
      endedAt: NOW,
    },
  ];
}

const unclaimed = {
  id: MEMBER_ID,
  workspaceId: WORKSPACE_ID,
  displayName: "Ada",
  role: "member",
  userId: null,
  identity: null,
  removedAt: null,
};

const claimed = {
  ...unclaimed,
  userId: USER_ID,
  identity: { provider: "github", login: "ada-l", verifiedAt: NOW },
};

function membershipEvent(type: string, payload: Json): Json {
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

function membershipEvents(): Json[] {
  return [
    membershipEvent("workspace.member.defined", { member: unclaimed }),
    membershipEvent("workspace.member.claimed", { member: claimed }),
    membershipEvent("workspace.member.renamed", {
      memberId: MEMBER_ID,
      displayName: "Ada L.",
    }),
    membershipEvent("workspace.member.removed", {
      memberId: MEMBER_ID,
      removedAt: NOW,
    }),
    membershipEvent("workspace.member.role_changed", {
      memberId: MEMBER_ID,
      role: "admin",
    }),
    membershipEvent("workspace.ownership.transferred", {
      previousOwnerMemberId: MEMBER_ID,
      ownerMemberId: OTHER_MEMBER_ID,
    }),
  ];
}

test("the close codes are 4000 to 4005, in the order of ADR 0014 and #89, and frozen", () => {
  assert.deepEqual(WS_CLOSE_CODES, {
    auth_failed: 4000,
    auth_timeout: 4001,
    device_revoked: 4002,
    sign_in_required: 4003,
    connection_replaced: 4004,
    protocol_violation: 4005,
  });
  // Numbers are never reused and follow in order.
  assert.deepEqual(
    Object.values(WS_CLOSE_CODES),
    Object.values(WS_CLOSE_CODES).map((_, index) => 4000 + index),
  );
  assert.ok(Object.isFrozen(WS_CLOSE_CODES));
});

test("authentication has 10 seconds and a frame limit of 1 KiB", () => {
  assert.equal(WS_AUTH_TIMEOUT_MS, 10_000);
  assert.equal(MAX_AUTH_FRAME_BYTES, 1024);
});

test("a frame type has two parts and an event type three, so they never overlap", () => {
  const frameTypes = [...SERVER_FRAME_TYPES, ...CLIENT_FRAME_TYPES];
  assert.equal(new Set(frameTypes).size, frameTypes.length);
  for (const type of frameTypes) {
    assert.match(type, FRAME_TYPE_PATTERN);
    assert.doesNotMatch(type, EVENT_TYPE_PATTERN);
  }
  for (const type of EVENT_TYPES) {
    assert.match(type, EVENT_TYPE_PATTERN);
    assert.doesNotMatch(type, FRAME_TYPE_PATTERN);
  }
  assert.deepEqual(CLIENT_FRAME_TYPES, ["auth.response"]);
  assert.ok(Object.isFrozen(SERVER_FRAME_TYPES));
  assert.ok(Object.isFrozen(CLIENT_FRAME_TYPES));
});

test("a device's auth.response decodes without unknown fields and fits the size limit", () => {
  assert.deepEqual(decodeClientFrame({ ...authResponse(), extra: true }), {
    ok: true,
    frame: authResponse(),
  });
  assert.ok(
    new TextEncoder().encode(JSON.stringify(authResponse())).length <
      MAX_AUTH_FRAME_BYTES,
  );
});

test("before authentication, a device may send only auth.response", () => {
  for (const frame of serverFrames()) {
    assert.deepEqual(
      decodeClientFrame(frame),
      { ok: false, code: "not_allowed_from_device" },
      String(frame["type"]),
    );
  }
  const cases: [label: string, input: unknown, code: string][] = [
    ["an event", membershipEvents()[2], "malformed"],
    ["not an object", "auth.response", "malformed"],
    ["null", null, "malformed"],
    [
      "no version",
      { ...authResponse(), protocolVersion: undefined },
      "malformed",
    ],
    [
      "another version",
      { ...authResponse(), protocolVersion: 1 },
      "unsupported_version",
    ],
    ["no type", { ...authResponse(), type: undefined }, "malformed"],
    [
      "a type over the limit",
      { ...authResponse(), type: `a.${"b".repeat(200)}` },
      "malformed",
    ],
    [
      "an unknown frame",
      { ...authResponse(), type: "auth.retry" },
      "unknown_type",
    ],
    [
      "a short signature",
      { ...authResponse(), signature: "A".repeat(85) },
      "invalid_payload",
    ],
    [
      "an uppercase device ID",
      { ...authResponse(), deviceId: DEVICE_ID.toUpperCase() },
      "invalid_payload",
    ],
  ];
  for (const [label, input, code] of cases) {
    assert.deepEqual(decodeClientFrame(input), { ok: false, code }, label);
  }
});

test("a device decodes every server frame and every membership event", () => {
  for (const frame of serverFrames()) {
    assert.deepEqual(
      decodeServerMessage({ ...frame, extra: 1 }),
      { ok: true, kind: "frame", frame },
      String(frame["type"]),
    );
  }
  for (const event of membershipEvents()) {
    const result = decodeServerMessage(event);
    assert.ok(result.ok && result.kind === "event", String(event["type"]));
    assert.equal(result.event.type, event["type"]);
  }
});

test("a device refuses auth.response and malformed frames from the server", () => {
  const [challenge, , registered, , , , offerEnded] = serverFrames();
  const cases: [label: string, input: unknown, code: string][] = [
    ["auth.response", authResponse(), "unknown_type"],
    [
      "an offer that ended by acceptance",
      { ...offerEnded, reason: "accepted" },
      "invalid_payload",
    ],
    [
      "a short nonce",
      { ...challenge, nonce: "A".repeat(42) },
      "invalid_payload",
    ],
    [
      "the receiving device as a new device",
      {
        ...registered,
        device: { ...(registered?.["device"] as Json), current: true },
      },
      "invalid_payload",
    ],
    [
      "a revoked device as a new device",
      {
        ...registered,
        device: { ...(registered?.["device"] as Json), revokedAt: NOW },
      },
      "invalid_payload",
    ],
    [
      "another version",
      { ...challenge, protocolVersion: 1 },
      "unsupported_version",
    ],
  ];
  for (const [label, input, code] of cases) {
    assert.deepEqual(decodeServerMessage(input), { ok: false, code }, label);
  }
});

test("membership events come only from the server, with a system actor and no device", () => {
  for (const event of membershipEvents()) {
    const label = String(event["type"]);
    assert.ok(decodeEvent(event).ok, label);
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
  assert.deepEqual(
    [...SERVER_ONLY_EVENT_TYPES].sort(),
    membershipEvents()
      .map((event) => String(event["type"]))
      .sort(),
  );
});

test("membership events check the person and the roles", () => {
  const cases: [label: string, input: Json][] = [
    [
      "a claimed person defined",
      membershipEvent("workspace.member.defined", { member: claimed }),
    ],
    [
      "an unclaimed person claimed",
      membershipEvent("workspace.member.claimed", { member: unclaimed }),
    ],
    [
      "a removed person claimed",
      membershipEvent("workspace.member.claimed", {
        member: { ...claimed, removedAt: NOW },
      }),
    ],
    [
      "a person of another workspace",
      membershipEvent("workspace.member.defined", {
        member: { ...unclaimed, workspaceId: OTHER_WORKSPACE_ID },
      }),
    ],
    [
      "an owner claimed",
      membershipEvent("workspace.member.claimed", {
        member: { ...claimed, role: "owner" },
      }),
    ],
    [
      "a role change to owner",
      membershipEvent("workspace.member.role_changed", {
        memberId: MEMBER_ID,
        role: "owner",
      }),
    ],
    [
      "ownership to the same person",
      membershipEvent("workspace.ownership.transferred", {
        previousOwnerMemberId: MEMBER_ID,
        ownerMemberId: MEMBER_ID,
      }),
    ],
  ];
  for (const [label, input] of cases) {
    assert.deepEqual(
      decodeEvent(input),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
});
