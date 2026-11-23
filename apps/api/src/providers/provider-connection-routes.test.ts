import {
  agentRuns,
  auditEvents,
  permissionGrants,
  providerConnections,
} from "@mymandev/database";
import {
  type AgentId,
  ApiErrorBodySchema,
  CreateAgentResponseSchema,
  CreateProjectResponseSchema,
  CreateWorkspaceResponseSchema,
  newId,
  type PermissionGrantId,
  PROVIDER_CONNECTION_COUNT_LIMITS,
  type ProjectId,
  type ProviderConnectionId,
  ProviderConnectionListResponseSchema,
  RegisterProviderConnectionResponseSchema,
  type RunId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  accessToken,
  deviceApp,
  failingCommits,
  fakeClock,
  signInDevice,
  type SignedInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";
import { ConnectionRegistry } from "../gateway.ts";
import type { WorkspaceEvent } from "../workspaces/events.ts";

// The provider connections of the calling device (#295): only the host
// device registers, lists, and removes its own connections; a device holds
// at most 10 that are not removed, and an account registers at most 20 in
// 24 hours; a removal revokes the connection's provider.use grants in its
// transaction and cancels no run; no secret in the body reaches the
// database, and no change sends a workspace event.

const database = useTestDatabase();

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const { activePerDevice: PER_DEVICE, perDay: PER_DAY } =
  PROVIDER_CONNECTION_COUNT_LIMITS;

type Account = Readonly<{
  app: FastifyInstance;
  device: SignedInDevice;
  token: string;
}>;

/**
 * One API instance: each account signs in through its own app, and every app
 * shares one clock and one database, whose next commit can be made to fail.
 * The workspace events that went out are recorded.
 */
function instance(t: TestContext) {
  const connections = new ConnectionRegistry();
  const commits = failingCommits(database());
  const clock = fakeClock();
  const events: WorkspaceEvent[] = [];
  const account = async (githubId: number): Promise<Account> => {
    const app = await deviceApp(t, {
      database: commits.database,
      githubId,
      connections,
      now: clock.now,
      onWorkspaceEvent: (event) => {
        events.push(event);
      },
    });
    const device = await signInDevice(app);
    return { app, device, token: await accessToken(app, device) };
  };
  /** Another device of the account, signed in through the account's app. */
  const secondDevice = async (of: Account): Promise<Account> => {
    const device = await signInDevice(of.app);
    assert.equal(device.userId, of.device.userId);
    assert.notEqual(device.deviceId, of.device.deviceId);
    return { app: of.app, device, token: await accessToken(of.app, device) };
  };
  return {
    clock,
    events,
    account,
    secondDevice,
    failNextCommit: commits.failNextCommit,
    failedCommits: commits.failedCommits,
  };
}

function get(account: Account, url: string) {
  return account.app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${account.token}` },
  });
}

function post(account: Account, url: string, payload?: object) {
  return account.app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${account.token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

function register(account: Account, payload: object) {
  return post(account, "/provider-connections", payload);
}

function remove(account: Account, id: string) {
  return post(account, `/provider-connections/${id}/remove`);
}

/** Registers a connection that must be registered. */
async function registered(account: Account, label = "Work", kind = "claude") {
  const response = await register(account, { kind, label });
  assert.equal(response.statusCode, 200, response.body);
  return RegisterProviderConnectionResponseSchema.parse(response.json())
    .providerConnection;
}

/** Removes a connection that must be removed. */
async function removed(account: Account, id: string) {
  const response = await remove(account, id);
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(response.body, "");
}

async function list(account: Account) {
  const response = await get(account, "/provider-connections");
  assert.equal(response.statusCode, 200, response.body);
  return ProviderConnectionListResponseSchema.parse(response.json())
    .providerConnections;
}

async function connectionRow(id: ProviderConnectionId) {
  const [row] = await database()
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.id, id));
  assert.ok(row !== undefined);
  return row;
}

function rowsOn(account: Account) {
  return database()
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.hostDeviceId, account.device.deviceId));
}

/** Inserts `n` connections of the account's device directly, created at `createdAt`. */
async function fill(
  account: Account,
  n: number,
  createdAt: Date,
  removedAt: Date | null = null,
): Promise<ProviderConnectionId[]> {
  const rows = Array.from({ length: n }, (_, index) => ({
    id: newId<ProviderConnectionId>(),
    hostDeviceId: account.device.deviceId,
    kind: "codex" as const,
    label: `Filler ${index}`,
    createdAt,
    removedAt,
  }));
  await database().insert(providerConnections).values(rows);
  return rows.map((row) => row.id);
}

/** A workspace, a project, and an agent hosted on the account's device, created through the API. */
async function agentOf(owner: Account) {
  const workspace = await post(owner, "/workspaces", {
    name: "Research",
    displayName: "Ada at work",
  });
  assert.equal(workspace.statusCode, 200, workspace.body);
  const workspaceId = CreateWorkspaceResponseSchema.parse(workspace.json())
    .workspace.id;
  const project = await post(owner, `/workspaces/${workspaceId}/projects`, {
    name: "App",
  });
  assert.equal(project.statusCode, 200, project.body);
  const projectId = CreateProjectResponseSchema.parse(project.json()).project
    .id;
  const agent = await post(owner, `/projects/${projectId}/agents`, {
    name: "Builder",
  });
  assert.equal(agent.statusCode, 200, agent.body);
  const agentId = CreateAgentResponseSchema.parse(agent.json()).agent.id;
  return { workspaceId, projectId, agentId };
}

/** A provider.use grant to the agent on the connection, inserted directly. */
async function useGrant(
  owner: Account,
  projectId: ProjectId,
  agentId: AgentId,
  providerConnectionId: ProviderConnectionId,
): Promise<PermissionGrantId> {
  const id = newId<PermissionGrantId>();
  await database().insert(permissionGrants).values({
    id,
    projectId,
    granteeAgentId: agentId,
    hostDeviceId: owner.device.deviceId,
    capability: "provider.use",
    providerConnectionId,
    grantedByUserId: owner.device.userId,
  });
  return id;
}

async function grantRow(id: PermissionGrantId) {
  const [row] = await database()
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, id));
  assert.ok(row !== undefined);
  return row;
}

function errorCode(response: { json(): unknown }): unknown {
  return (response.json() as { code?: unknown }).code;
}

test("a device registers a connection that it hosts, lists it, and no workspace event or audit record follows", async (t) => {
  const { account, events, clock } = instance(t);
  const owner = await account(2951);
  const connection = await registered(owner, "Work account", "codex");
  assert.deepEqual(connection, {
    id: connection.id,
    kind: "codex",
    label: "Work account",
    createdAt: new Date(clock.now()).toISOString(),
  });
  const row = await connectionRow(connection.id);
  assert.equal(row.hostDeviceId, owner.device.deviceId);
  assert.equal(row.removedAt, null);
  // A label is not unique, and it is stored as sent.
  const second = await registered(owner, "  Work account  ");
  assert.equal(second.label, "  Work account  ");
  assert.deepEqual(await list(owner), [connection, second]);
  // A connection is device data (#110): no event, and no audit record.
  assert.deepEqual(events, []);
  const audited = await database()
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.actorUserId, owner.device.userId));
  assert.equal(
    audited.some((record) => record.action.startsWith("provider")),
    false,
  );
});

test("a registration takes the kind and the label only: a secret, a provider account, or a host device beside them never reaches the database, and a malformed body answers 400", async (t) => {
  const { account } = instance(t);
  const owner = await account(2952);
  const other = await account(2953);
  const secret = "not-a-real-key-2952";
  const response = await register(owner, {
    kind: "claude",
    label: "Work",
    apiKey: secret,
    token: secret,
    accessToken: secret,
    credential: { key: secret },
    accountId: secret,
    email: secret,
    hostDeviceId: other.device.deviceId,
    userId: other.device.userId,
    id: newId<ProviderConnectionId>(),
    createdAt: "2020-01-01T00:00:00.000Z",
    removedAt: "2020-01-01T00:00:00.000Z",
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.body.includes(secret), false);
  const { providerConnection } = RegisterProviderConnectionResponseSchema.parse(
    response.json(),
  );
  const row = await connectionRow(providerConnection.id);
  assert.deepEqual(Object.keys(row).sort(), [
    "createdAt",
    "hostDeviceId",
    "id",
    "kind",
    "label",
    "removedAt",
  ]);
  assert.equal(row.hostDeviceId, owner.device.deviceId);
  assert.equal(row.removedAt, null);
  assert.equal(JSON.stringify(row).includes(secret), false);
  assert.deepEqual(await rowsOn(other), []);

  for (const payload of [
    {},
    { label: "Work" },
    { kind: "gemini", label: "Work" },
    { kind: "Claude", label: "Work" },
    { kind: "claude" },
    { kind: "claude", label: "" },
    { kind: "claude", label: " " },
    { kind: "claude", label: "a".repeat(65) },
    { kind: "claude", label: "Wo\nrk" },
    { kind: "claude", label: 7 },
  ]) {
    const refused = await register(owner, payload);
    assert.equal(refused.statusCode, 400, JSON.stringify(payload));
    assert.equal(errorCode(refused), "bad_request");
  }
  assert.equal((await rowsOn(owner)).length, 1);
});

test("only the host device lists and removes its connections: another device of the account and another account see none and get 404, as for an unknown ID", async (t) => {
  const { account, secondDevice } = instance(t);
  const owner = await account(2954);
  const laptop = await secondDevice(owner);
  const other = await account(2955);
  const connection = await registered(owner);
  const onLaptop = await registered(laptop, "Laptop");

  assert.deepEqual(await list(laptop), [onLaptop]);
  assert.deepEqual(await list(other), []);
  const unknown = await remove(owner, newId<ProviderConnectionId>());
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.equal(errorCode(unknown), "not_found");
  for (const caller of [laptop, other]) {
    const refused = await remove(caller, connection.id);
    assert.equal(refused.statusCode, 404, refused.body);
    assert.equal(refused.body, unknown.body);
  }
  assert.equal((await connectionRow(connection.id)).removedAt, null);
  // A malformed ID is a malformed request.
  const malformed = await remove(owner, "not-an-id");
  assert.equal(malformed.statusCode, 400, malformed.body);
  assert.equal(errorCode(malformed), "bad_request");
  // Without an access token, nothing.
  for (const response of [
    await owner.app.inject({ method: "GET", url: "/provider-connections" }),
    await owner.app.inject({
      method: "POST",
      url: "/provider-connections",
      payload: { kind: "claude", label: "Work" },
    }),
    await owner.app.inject({
      method: "POST",
      url: `/provider-connections/${connection.id}/remove`,
    }),
  ]) {
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(errorCode(response), "unauthorized");
  }
  assert.deepEqual(await list(owner), [connection]);
});

test(`a device with ${PER_DEVICE} connections that are not removed answers 409 with provider_connection_limit and no Retry-After, and a removal frees a place`, async (t) => {
  const { account, secondDevice } = instance(t);
  const owner = await account(2956);
  const earlier = new Date(Date.now() - 2 * DAY_MS);
  await fill(owner, 2, earlier, earlier);
  const ids = await fill(owner, PER_DEVICE, earlier);
  const refused = await register(owner, { kind: "claude", label: "Over" });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.deepEqual(ApiErrorBodySchema.parse(refused.json()), {
    statusCode: 409,
    error: "Conflict",
    message: "Conflict",
    code: "provider_connection_limit",
  });
  assert.equal(refused.headers["retry-after"], undefined);
  assert.equal((await rowsOn(owner)).length, PER_DEVICE + 2);
  // Another device of the account has its own place.
  await registered(await secondDevice(owner));
  const [first] = ids;
  assert.ok(first);
  await removed(owner, first);
  await registered(owner, "Again");
});

test(`an account that registered ${PER_DAY} connections within 24 hours answers 429 with rate_limited and Retry-After until the oldest is 24 hours old`, async (t) => {
  const { account, secondDevice, clock } = instance(t);
  const owner = await account(2957);
  const laptop = await secondDevice(owner);
  const now = clock.now();
  const oldest = new Date(now - 20 * HOUR_MS);
  await fill(owner, 5, oldest, new Date(now - HOUR_MS));
  await fill(laptop, PER_DAY - 5 - 1, new Date(now - HOUR_MS), new Date(now));
  await registered(owner);
  const refused = await register(owner, { kind: "claude", label: "Over" });
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(errorCode(refused), "rate_limited");
  assert.equal(refused.headers["retry-after"], String(4 * 60 * 60));
  clock.advance(4 * HOUR_MS + 1_000);
  // The access token lives 15 minutes.
  const renewed = {
    ...owner,
    token: await accessToken(owner.app, owner.device),
  };
  await registered(renewed, "Later");
});

test("a removal sets the removal time, revokes the connection's provider.use grants in its transaction, cancels no run, and sends no event; a second removal answers 409", async (t) => {
  const { account, events, clock, failNextCommit, failedCommits } = instance(t);
  const owner = await account(2958);
  const { projectId, agentId } = await agentOf(owner);
  const connection = await registered(owner);
  const kept = await registered(owner, "Kept");
  const grant = await useGrant(owner, projectId, agentId, connection.id);
  const onKept = await useGrant(owner, projectId, agentId, kept.id);
  const runId = newId<RunId>();
  await database().insert(agentRuns).values({
    id: runId,
    agentId,
    projectId,
    requestedByUserId: owner.device.userId,
    state: "running",
    providerConnectionId: connection.id,
    hostDeviceId: owner.device.deviceId,
  });
  events.length = 0;

  // A failed commit removes nothing and revokes nothing.
  failNextCommit();
  const failed = await remove(owner, connection.id);
  assert.equal(failed.statusCode, 500, failed.body);
  assert.deepEqual(failedCommits(), ["provider-connection-routes.ts"]);
  assert.equal((await connectionRow(connection.id)).removedAt, null);
  assert.equal((await grantRow(grant)).revokedAt, null);

  await removed(owner, connection.id);
  const at = new Date(clock.now());
  assert.deepEqual((await connectionRow(connection.id)).removedAt, at);
  const revoked = await grantRow(grant);
  assert.deepEqual(revoked.revokedAt, at);
  assert.equal(revoked.revokedByUserId, owner.device.userId);
  assert.equal((await grantRow(onKept)).revokedAt, null);
  const [run] = await database()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  assert.equal(run?.state, "running");
  assert.deepEqual(events, []);
  assert.deepEqual(await list(owner), [kept]);

  const again = await remove(owner, connection.id);
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(errorCode(again), "conflict");
});

test("a failed commit of a registration stores nothing, and a revoked device registers, lists, and removes nothing", async (t) => {
  const { account, secondDevice, failNextCommit, failedCommits } = instance(t);
  const owner = await account(2959);
  const laptop = await secondDevice(owner);
  failNextCommit();
  const failed = await register(owner, { kind: "claude", label: "Work" });
  assert.equal(failed.statusCode, 500, failed.body);
  assert.deepEqual(failedCommits(), ["provider-connection-routes.ts"]);
  assert.deepEqual(await rowsOn(owner), []);

  const connection = await registered(owner);
  const revoke = await post(
    laptop,
    `/devices/${owner.device.deviceId}/revoke`,
    {
      reason: "removed",
    },
  );
  assert.equal(revoke.statusCode, 204, revoke.body);
  for (const response of [
    await get(owner, "/provider-connections"),
    await register(owner, { kind: "claude", label: "After" }),
    await remove(owner, connection.id),
  ]) {
    assert.equal(response.statusCode, 401, response.body);
  }
  // A device revocation does not mark its connections removed.
  assert.equal((await connectionRow(connection.id)).removedAt, null);
  assert.equal((await rowsOn(owner)).length, 1);
});
