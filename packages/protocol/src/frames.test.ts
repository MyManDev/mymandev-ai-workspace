import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeClientEvent, decodeEvent } from "./decode.ts";
import {
  CLIENT_ONLY_EVENT_TYPES,
  EVENT_TYPES,
  SERVER_ONLY_EVENT_TYPES,
} from "./envelope.ts";
import {
  CLIENT_FRAME_TYPES,
  decodeClientFrame,
  decodeClientMessage,
  decodeServerMessage,
  MAX_AUTH_FRAME_BYTES,
  MAX_FRAME_BYTES,
  PresenceChangedFrameSchema,
  SERVER_FRAME_TYPES,
  WorkspaceSubscribedFrameSchema,
  WorkspaceSubscribeFrameSchema,
  WorkspaceSubscribeRefusedFrameSchema,
  WorkspaceUnsubscribedFrameSchema,
  WorkspaceUnsubscribeFrameSchema,
  WS_AUTH_TIMEOUT_MS,
} from "./frames.ts";
import {
  EVENT_TYPE_PATTERN,
  FRAME_TYPE_PATTERN,
  LIMITS,
  MAX_ANSWER_LIST_ITEMS,
  WORKSPACE_SUBSCRIBE_REFUSAL_CODES,
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
const OTHER_EVENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000002";
const PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000e";
const MESSAGE_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000f";
const JOIN_REQUEST_ID = "0192f0a0-7b3c-7d4e-8f50-000000000010";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000005";
const RUN_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007";
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
    {
      protocolVersion: 0,
      type: "account.ownership_transferred",
      workspaceId: WORKSPACE_ID,
      previousOwnerMemberId: MEMBER_ID,
      ownerMemberId: OTHER_MEMBER_ID,
      transferredAt: NOW,
    },
    {
      protocolVersion: 0,
      type: "account.join_request_decided",
      joinRequestId: JOIN_REQUEST_ID,
      workspaceId: WORKSPACE_ID,
      decision: "approved",
      decidedAt: NOW,
    },
    ...workspaceServerFrames(),
  ];
}

/** The server's frames of a workspace subscription. */
function workspaceServerFrames(): Json[] {
  return [
    {
      protocolVersion: 0,
      type: "workspace.subscribed",
      workspaceId: WORKSPACE_ID,
      onlineMemberIds: [MEMBER_ID, OTHER_MEMBER_ID],
    },
    {
      protocolVersion: 0,
      type: "workspace.subscribe_refused",
      workspaceId: WORKSPACE_ID,
      code: "not_found",
    },
    {
      protocolVersion: 0,
      type: "workspace.unsubscribed",
      workspaceId: WORKSPACE_ID,
      reason: "requested",
    },
    {
      protocolVersion: 0,
      type: "presence.changed",
      workspaceId: WORKSPACE_ID,
      memberId: MEMBER_ID,
      status: "online",
    },
  ];
}

/** The frames that a device sends after `auth.ok`. */
function workspaceClientFrames(): Json[] {
  return [
    {
      protocolVersion: 0,
      type: "workspace.subscribe",
      workspaceId: WORKSPACE_ID,
    },
    {
      protocolVersion: 0,
      type: "workspace.unsubscribe",
      workspaceId: WORKSPACE_ID,
    },
  ];
}

/** A person sends a chat message from their device. */
function chatSend(body = "Hello"): Json {
  return {
    protocolVersion: 0,
    id: EVENT_ID,
    type: "chat.message.send",
    occurredAt: NOW,
    workspaceId: WORKSPACE_ID,
    actor: { kind: "user", userId: USER_ID },
    deviceId: DEVICE_ID,
    payload: { projectId: PROJECT_ID, body },
  };
}

/** The server stored the message of `chatSend`. */
function chatCreated(): Json {
  return {
    protocolVersion: 0,
    id: OTHER_EVENT_ID,
    type: "chat.message.created",
    occurredAt: NOW,
    workspaceId: WORKSPACE_ID,
    actor: { kind: "system" },
    deviceId: null,
    causationId: EVENT_ID,
    payload: {
      message: {
        id: MESSAGE_ID,
        projectId: PROJECT_ID,
        authorMemberId: MEMBER_ID,
        body: "Hello",
        createdAt: NOW,
      },
    },
  };
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

test("the close codes are 4000 to 4006, in the order of ADR 0014 and #89, and frozen", () => {
  assert.deepEqual(WS_CLOSE_CODES, {
    auth_failed: 4000,
    auth_timeout: 4001,
    device_revoked: 4002,
    sign_in_required: 4003,
    connection_replaced: 4004,
    protocol_violation: 4005,
    key_replaced: 4006,
  });
  // Numbers are never reused and follow in order.
  assert.deepEqual(
    Object.values(WS_CLOSE_CODES),
    Object.values(WS_CLOSE_CODES).map((_, index) => 4000 + index),
  );
  assert.ok(Object.isFrozen(WS_CLOSE_CODES));
});

test("authentication has 10 seconds and a frame limit of 1 KiB, and an authenticated frame a limit of 64 KiB", () => {
  assert.equal(WS_AUTH_TIMEOUT_MS, 10_000);
  assert.equal(MAX_AUTH_FRAME_BYTES, 1024);
  // Equal to the `maxPayload` of the gateway in @mymandev/api.
  assert.equal(MAX_FRAME_BYTES, 64 * 1024);
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
  assert.deepEqual(CLIENT_FRAME_TYPES, [
    "auth.response",
    "workspace.subscribe",
    "workspace.unsubscribe",
  ]);
  assert.deepEqual(
    SERVER_FRAME_TYPES,
    serverFrames().map((frame) => frame["type"]),
  );
  assert.ok(Object.isFrozen(SERVER_FRAME_TYPES));
  assert.ok(Object.isFrozen(CLIENT_FRAME_TYPES));
  // An event type is sent by the server only, by a device only, or by both.
  for (const type of [...SERVER_ONLY_EVENT_TYPES, ...CLIENT_ONLY_EVENT_TYPES]) {
    assert.ok(EVENT_TYPES.includes(type), type);
  }
  for (const type of CLIENT_ONLY_EVENT_TYPES) {
    assert.equal(
      (SERVER_ONLY_EVENT_TYPES as readonly string[]).includes(type),
      false,
      type,
    );
  }
  assert.ok(Object.isFrozen(CLIENT_ONLY_EVENT_TYPES));
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
  // A frame that a device sends after auth.ok is unexpected before it.
  for (const frame of workspaceClientFrames()) {
    assert.deepEqual(
      decodeClientFrame(frame),
      { ok: false, code: "unexpected_frame" },
      String(frame["type"]),
    );
  }
  const cases: [label: string, input: unknown, code: string][] = [
    ["an event", membershipEvents()[2], "malformed"],
    ["a chat message", chatSend(), "malformed"],
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

test("a device decodes every server frame, every membership event, and a stored chat message", () => {
  for (const frame of serverFrames()) {
    assert.deepEqual(
      decodeServerMessage({ ...frame, extra: 1 }),
      { ok: true, kind: "frame", frame },
      String(frame["type"]),
    );
  }
  for (const event of [...membershipEvents(), chatCreated()]) {
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
    ["workspace.subscribe", workspaceClientFrames()[0], "unknown_type"],
    // The server never relays what a device sent.
    ["chat.message.send", chatSend(), "unknown_type"],
    // Refused by its type, before its fields are checked.
    [
      "a malformed chat.message.send",
      { ...chatSend(), actor: { kind: "system" }, payload: {} },
      "unknown_type",
    ],
  ];
  for (const [label, input, code] of cases) {
    assert.deepEqual(decodeServerMessage(input), { ok: false, code }, label);
  }
});

test("a join request decision reaches the requester as approved or denied, never as a block, a withdrawal, or an expiry", () => {
  const decided = serverFrames().find(
    (frame) => frame["type"] === "account.join_request_decided",
  );
  assert.ok(decided);
  for (const decision of ["approved", "denied"]) {
    const input: Json = { ...decided, decision };
    assert.deepEqual(
      decodeServerMessage(input),
      { ok: true, kind: "frame", frame: input },
      decision,
    );
  }
  const cases: [label: string, input: unknown][] = [
    // The requester never learns of a block, and makes a withdrawal itself.
    ...["blocked", "withdrawn", "expired", "ignored"].map(
      (decision): [string, unknown] => [decision, { ...decided, decision }],
    ),
    ["no request", { ...decided, joinRequestId: undefined }],
    ["an invalid request ID", { ...decided, joinRequestId: "x" }],
    ["no workspace", { ...decided, workspaceId: undefined }],
    ["no time", { ...decided, decidedAt: undefined }],
    [
      "a time without milliseconds",
      { ...decided, decidedAt: "2026-10-30T17:00:00Z" },
    ],
  ];
  for (const [label, input] of cases) {
    assert.deepEqual(
      decodeServerMessage(input),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
  // Nothing about the workspace or the approver reaches the requester.
  const decoded = decodeServerMessage({
    ...decided,
    workspaceName: "MyManDev",
    memberId: MEMBER_ID,
    decidedByUserId: USER_ID,
  });
  assert.ok(decoded.ok && decoded.kind === "frame");
  assert.deepEqual(Object.keys(decoded.frame).sort(), [
    "decidedAt",
    "decision",
    "joinRequestId",
    "protocolVersion",
    "type",
    "workspaceId",
  ]);
});

test("an ownership transfer reaches both accounts with the workspace, both people, and the time, and always names two people", () => {
  const transferred = serverFrames().find(
    (frame) => frame["type"] === "account.ownership_transferred",
  );
  assert.ok(transferred);
  assert.deepEqual(decodeServerMessage(transferred), {
    ok: true,
    kind: "frame",
    frame: transferred,
  });
  const cases: [label: string, input: unknown][] = [
    [
      "ownership to the same person",
      { ...transferred, ownerMemberId: MEMBER_ID },
    ],
    ["no workspace", { ...transferred, workspaceId: undefined }],
    ["no previous owner", { ...transferred, previousOwnerMemberId: undefined }],
    ["no new owner", { ...transferred, ownerMemberId: undefined }],
    [
      "an uppercase person ID",
      { ...transferred, ownerMemberId: OTHER_MEMBER_ID.toUpperCase() },
    ],
    ["no time", { ...transferred, transferredAt: undefined }],
    [
      "a time without milliseconds",
      { ...transferred, transferredAt: "2026-10-30T17:00:00Z" },
    ],
  ];
  for (const [label, input] of cases) {
    assert.deepEqual(
      decodeServerMessage(input),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
  // The frame names people, never an account or a device.
  const decoded = decodeServerMessage({
    ...transferred,
    previousOwnerUserId: USER_ID,
    deviceId: DEVICE_ID,
  });
  assert.ok(decoded.ok && decoded.kind === "frame");
  assert.deepEqual(Object.keys(decoded.frame).sort(), [
    "ownerMemberId",
    "previousOwnerMemberId",
    "protocolVersion",
    "transferredAt",
    "type",
    "workspaceId",
  ]);
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
  // The project events are tested in `project-api.test.ts`.
  assert.deepEqual(
    [...SERVER_ONLY_EVENT_TYPES].sort(),
    [...membershipEvents(), chatCreated()]
      .map((event) => String(event["type"]))
      .concat(["workspace.project.created", "workspace.project.renamed"])
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

test("after authentication, a device sends workspace frames and events, but never auth.response or what only the server sends", () => {
  for (const frame of workspaceClientFrames()) {
    assert.deepEqual(
      decodeClientMessage({ ...frame, extra: true }),
      { ok: true, kind: "frame", frame },
      String(frame["type"]),
    );
  }
  const sent = decodeClientMessage({
    ...chatSend(),
    extra: true,
    payload: {
      projectId: PROJECT_ID,
      body: "Hello",
      authorMemberId: MEMBER_ID,
    },
  });
  assert.deepEqual(sent, { ok: true, kind: "event", event: chatSend() });

  for (const message of [
    ...serverFrames(),
    ...membershipEvents(),
    chatCreated(),
  ]) {
    assert.deepEqual(
      decodeClientMessage(message),
      { ok: false, code: "not_allowed_from_device" },
      String(message["type"]),
    );
  }
  const [subscribe] = workspaceClientFrames();
  const cases: [label: string, input: unknown, code: string][] = [
    ["auth.response", authResponse(), "unexpected_frame"],
    [
      "a run creation",
      {
        protocolVersion: 0,
        id: EVENT_ID,
        type: "agent.run.state_changed",
        occurredAt: NOW,
        workspaceId: WORKSPACE_ID,
        actor: { kind: "agent", agentId: AGENT_ID },
        deviceId: DEVICE_ID,
        payload: {
          runId: RUN_ID,
          agentId: AGENT_ID,
          previousState: null,
          state: "queued",
        },
      },
      "not_allowed_from_device",
    ],
    ["not an object", "workspace.subscribe", "malformed"],
    ["a one-part type", { ...subscribe, type: "workspace" }, "malformed"],
    [
      "an unknown frame",
      { ...subscribe, type: "workspace.join" },
      "unknown_type",
    ],
    [
      "an unknown event",
      { ...chatSend(), type: "chat.message.edited" },
      "unknown_type",
    ],
    [
      "another version",
      { ...subscribe, protocolVersion: 1 },
      "unsupported_version",
    ],
    [
      "an uppercase workspace ID",
      { ...subscribe, workspaceId: WORKSPACE_ID.toUpperCase() },
      "invalid_payload",
    ],
    [
      "no workspace ID",
      { ...subscribe, workspaceId: undefined },
      "invalid_payload",
    ],
    [
      "a chat message without a project",
      { ...chatSend(), payload: { body: "Hi" } },
      "invalid_payload",
    ],
  ];
  for (const [label, input, code] of cases) {
    assert.deepEqual(decodeClientMessage(input), { ok: false, code }, label);
  }
});

test("chat.message.send comes from a person on a device, and chat.message.created only from the server", () => {
  const send = decodeClientEvent(chatSend());
  assert.ok(send.ok);
  assert.deepEqual(send.event, chatSend());

  const sendCases: [label: string, input: Json][] = [
    ["from the system", { ...chatSend(), actor: { kind: "system" } }],
    [
      "from an agent",
      { ...chatSend(), actor: { kind: "agent", agentId: AGENT_ID } },
    ],
    ["without a device", { ...chatSend(), deviceId: null }],
  ];
  for (const [label, input] of sendCases) {
    assert.deepEqual(
      decodeEvent(input),
      { ok: false, code: "invalid_actor" },
      label,
    );
    assert.equal(decodeClientEvent(input).ok, false, label);
  }

  const created = decodeEvent(chatCreated());
  assert.ok(created.ok);
  assert.deepEqual(created.event, chatCreated());
  const createdCases: [label: string, input: Json][] = [
    [
      "from a user",
      { ...chatCreated(), actor: { kind: "user", userId: USER_ID } },
    ],
    ["with a device", { ...chatCreated(), deviceId: DEVICE_ID }],
  ];
  for (const [label, input] of createdCases) {
    assert.deepEqual(
      decodeEvent(input),
      { ok: false, code: "invalid_actor" },
      label,
    );
  }
  assert.deepEqual(decodeClientEvent(chatCreated()), {
    ok: false,
    code: "not_allowed_from_device",
  });
  // The forgery a device would try: its own user and device.
  assert.equal(
    decodeClientEvent({
      ...chatCreated(),
      actor: { kind: "user", userId: USER_ID },
      deviceId: DEVICE_ID,
    }).ok,
    false,
  );

  const message = (chatCreated()["payload"] as Json)["message"] as Json;
  const payloadCases: [label: string, input: Json][] = [
    [
      "a message without an author",
      {
        ...chatCreated(),
        payload: { message: { ...message, authorMemberId: undefined } },
      },
    ],
    [
      "a message with a local time",
      {
        ...chatCreated(),
        payload: { message: { ...message, createdAt: "2026-10-30T17:00:00" } },
      },
    ],
    [
      "a blank message",
      { ...chatCreated(), payload: { message: { ...message, body: " " } } },
    ],
  ];
  for (const [label, input] of payloadCases) {
    assert.deepEqual(
      decodeServerMessage(input),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
});

test("a chat message holds up to 16,000 characters, and the largest one fits the gateway's 64 KiB frame limit", () => {
  const atLimit = "a".repeat(LIMITS.messageBody);
  assert.equal(decodeClientEvent(chatSend(atLimit)).ok, true);
  assert.equal(decodeClientEvent(chatSend("Line one\n\tLine two")).ok, true);
  const refused: [label: string, body: unknown][] = [
    ["over the limit", `${atLimit}a`],
    ["empty", ""],
    ["blank", "\n \t"],
    ["a carriage return", "Line one\r\nLine two"],
    ["not a string", 42],
  ];
  for (const [label, body] of refused) {
    assert.deepEqual(
      decodeClientEvent(chatSend(body as string)),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }

  // The limit counts code points, as zod and the database CHECK do. A code
  // point takes at most 4 bytes in UTF-8, and JSON.stringify escapes only
  // quotes, backslashes, and the allowed line feed and tab, with 2 bytes
  // each. The gateway refuses a frame over MAX_FRAME_BYTES after
  // authentication.
  const astral = String.fromCodePoint(0x1f600);
  const cjk = String.fromCharCode(0x4e00);
  assert.equal(
    decodeClientEvent(chatSend(astral.repeat(LIMITS.messageBody))).ok,
    true,
  );
  for (const character of [astral, cjk, '"', "\\", "\n", "\t"]) {
    const body = `a${character.repeat(LIMITS.messageBody - 1)}`;
    const event = {
      ...chatSend(body),
      correlationId: OTHER_EVENT_ID,
      causationId: OTHER_EVENT_ID,
    };
    assert.equal(decodeClientEvent(event).ok, true, JSON.stringify(character));
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    assert.ok(
      bytes < MAX_FRAME_BYTES,
      `${JSON.stringify(character)}: ${bytes}`,
    );
  }
});

test("the presence snapshot lists each online person once, and at most MAX_ANSWER_LIST_ITEMS", () => {
  const [subscribed] = workspaceServerFrames();
  const memberIds = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        `0192f0a0-7b3c-7d4e-8f50-${index.toString(16).padStart(12, "0")}`,
    );
  const accepted = [0, 1, MAX_ANSWER_LIST_ITEMS];
  for (const count of accepted) {
    assert.equal(
      decodeServerMessage({ ...subscribed, onlineMemberIds: memberIds(count) })
        .ok,
      true,
      String(count),
    );
  }
  const refused: [label: string, onlineMemberIds: unknown][] = [
    ["over the maximum", memberIds(MAX_ANSWER_LIST_ITEMS + 1)],
    ["a person twice", [MEMBER_ID, OTHER_MEMBER_ID, MEMBER_ID]],
    ["an ID that is not a UUIDv7", ["not-an-id"]],
    ["no list", undefined],
  ];
  for (const [label, onlineMemberIds] of refused) {
    assert.deepEqual(
      decodeServerMessage({ ...subscribed, onlineMemberIds }),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
});

test("no subscription or presence frame names a device, and a non-member and an unknown workspace get the same refusal", () => {
  for (const schema of [
    WorkspaceSubscribeFrameSchema,
    WorkspaceUnsubscribeFrameSchema,
    WorkspaceSubscribedFrameSchema,
    WorkspaceSubscribeRefusedFrameSchema,
    WorkspaceUnsubscribedFrameSchema,
    PresenceChangedFrameSchema,
  ]) {
    const keys = Object.keys(schema.shape);
    assert.equal(
      keys.some((key) => key.toLowerCase().includes("device")),
      false,
      keys.join(", "),
    );
  }
  const [, refusedFrame, unsubscribed, presence] = workspaceServerFrames();
  // A device ID that the server sent by mistake is stripped.
  assert.deepEqual(decodeServerMessage({ ...presence, deviceId: DEVICE_ID }), {
    ok: true,
    kind: "frame",
    frame: presence,
  });

  // One code covers both cases, so no answer tells them apart.
  assert.equal(WORKSPACE_SUBSCRIBE_REFUSAL_CODES.includes("not_found"), true);
  const cases: [label: string, input: Json][] = [
    ["not_a_member", { ...refusedFrame, code: "not_a_member" }],
    ["workspace_not_found", { ...refusedFrame, code: "workspace_not_found" }],
    ["forbidden", { ...refusedFrame, code: "forbidden" }],
    ["away", { ...presence, status: "away" }],
    ["revoked", { ...unsubscribed, reason: "revoked" }],
  ];
  for (const [label, input] of cases) {
    assert.deepEqual(
      decodeServerMessage(input),
      { ok: false, code: "invalid_payload" },
      label,
    );
  }
});
