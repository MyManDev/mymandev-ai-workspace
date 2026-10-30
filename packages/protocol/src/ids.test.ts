import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentIdSchema,
  ConnectionIdSchema,
  CorrelationIdSchema,
  DeviceIdSchema,
  EventIdSchema,
  InvitationIdSchema,
  JoinRequestIdSchema,
  MemberIdSchema,
  newId,
  newUuidV7,
  PermissionGrantIdSchema,
  ProjectIdSchema,
  ProviderConnectionIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type AgentId,
  type DeviceId,
  type EventId,
  type InvitationId,
  type JoinRequestId,
  type MemberId,
  type PermissionGrantId,
  type ProviderConnectionId,
  type RepositoryId,
  type UserId,
} from "./ids.ts";
import { UUIDV7_PATTERN } from "./model.ts";

const ID_SCHEMAS = [
  UserIdSchema,
  DeviceIdSchema,
  WorkspaceIdSchema,
  ProjectIdSchema,
  RepositoryIdSchema,
  AgentIdSchema,
  RunIdSchema,
  EventIdSchema,
  CorrelationIdSchema,
  PermissionGrantIdSchema,
  ProviderConnectionIdSchema,
  MemberIdSchema,
  InvitationIdSchema,
  JoinRequestIdSchema,
  ConnectionIdSchema,
];

test("generated IDs are lowercase UUIDv7 and sort in creation order", () => {
  const ids: string[] = [];
  for (let i = 0; i < 1000; i += 1) {
    ids.push(i % 2 === 0 ? newUuidV7() : newId<EventId>());
  }
  for (const id of ids) {
    assert.match(id, UUIDV7_PATTERN);
    for (const schema of ID_SCHEMAS) {
      assert.equal(schema.safeParse(id).success, true);
    }
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ids);
});

test("an uppercase UUIDv7 and other UUID versions are rejected", () => {
  const valid = "0192f0a0-7b3c-7d4e-8f50-123456789abc";
  const rejected = [
    // Uppercase UUIDv7.
    "0192F0A0-7B3C-7D4E-8F50-123456789ABC",
    // Version 4.
    "9b2f0e3a-4c5d-4e6f-8a7b-0c1d2e3f4a5b",
    // Version 7 with the wrong variant.
    "0192f0a0-7b3c-7d4e-cf50-123456789abc",
    // Nil UUID, no hyphens, braces, surrounding white space, empty.
    "00000000-0000-0000-0000-000000000000",
    "0192f0a07b3c7d4e8f50123456789abc",
    "{0192f0a0-7b3c-7d4e-8f50-123456789abc}",
    " 0192f0a0-7b3c-7d4e-8f50-123456789abc",
    "",
  ];
  for (const schema of ID_SCHEMAS) {
    assert.equal(schema.safeParse(valid).success, true);
    for (const id of rejected) {
      assert.equal(schema.safeParse(id).success, false, id);
    }
    assert.equal(schema.safeParse(42).success, false);
  }
});

test("ID kinds are not interchangeable (checked by tsc)", () => {
  const userId = newId<UserId>();
  // @ts-expect-error A UserId is not a DeviceId.
  const deviceId: DeviceId = userId;
  assert.equal(deviceId, userId);

  const repositoryId = newId<RepositoryId>();
  // @ts-expect-error A RepositoryId is not a ProviderConnectionId.
  const providerConnectionId: ProviderConnectionId = repositoryId;
  assert.equal(providerConnectionId, repositoryId);

  const agentId = newId<AgentId>();
  // @ts-expect-error An AgentId is not a PermissionGrantId.
  const permissionGrantId: PermissionGrantId = agentId;
  assert.equal(permissionGrantId, agentId);

  const memberId = newId<MemberId>();
  // @ts-expect-error A MemberId is not a UserId.
  const memberAsUser: UserId = memberId;
  assert.equal(memberAsUser, memberId);

  const invitationId = newId<InvitationId>();
  // @ts-expect-error An InvitationId is not a JoinRequestId.
  const joinRequestId: JoinRequestId = invitationId;
  assert.equal(joinRequestId, invitationId);
});
