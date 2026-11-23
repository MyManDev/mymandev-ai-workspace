import {
  agents,
  permissionGrants,
  repositories,
  workspaceMembers,
} from "@mymandev/database";
import {
  type AgentId,
  ApiErrorBodySchema,
  CreateAgentResponseSchema,
  CreateProjectResponseSchema,
  CreateWorkspaceResponseSchema,
  decodeServerMessage,
  GRANT_COUNT_LIMITS,
  GrantCapabilityResponseSchema,
  GrantRecordListResponseSchema,
  type MemberId,
  newId,
  type PermissionGrantId,
  type ProjectId,
  type ProviderConnectionId,
  RegisterProviderConnectionResponseSchema,
  RegisterRepositoryResponseSchema,
  type RepositoryId,
  SERVER_EVENT_AUDIENCES,
  SHELL_GRANT_MAX_LIFETIME_SECONDS,
  type WorkspaceId,
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
import { type Client, connected, settle } from "../gateway-test-support.ts";
import { ConnectionRegistry } from "../gateway.ts";

// The grant routes (#75): only the agent's owner grants, and only from the
// agent's host device; the owner revokes from any of its devices; another
// account learns nothing of an agent that it cannot see; a count limit
// answers grant_limit, and an account's grants of a day rate_limited; a
// grant of terminal.execute expires within 30 days;
// each change sends its events after the commit to every connection
// subscribed to the agent's workspace; and the record list holds the
// unrevoked grants of the calling device's agents, with their facts.

const database = useTestDatabase();

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

type Account = Readonly<{
  app: FastifyInstance;
  device: SignedInDevice;
  token: string;
}>;

/**
 * One API instance: each account signs in through its own app, and every app
 * shares one registry of connections, one clock, and one database, whose
 * next commit can be made to fail.
 */
function instance(t: TestContext) {
  const connections = new ConnectionRegistry();
  const commits = failingCommits(database());
  const clock = fakeClock();
  const account = async (githubId: number): Promise<Account> => {
    const app = await deviceApp(t, {
      database: commits.database,
      githubId,
      connections,
      now: clock.now,
    });
    // injectWS never settles unless the app is ready.
    await app.ready();
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

function post(account: Account, url: string, payload?: object | string) {
  return account.app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${account.token}`,
      ...(typeof payload === "string"
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

function grant(account: Account, agentId: string, payload: object | string) {
  return post(account, `/agents/${agentId}/grants`, payload);
}

function revoke(account: Account, agentId: string, grantId: string) {
  return post(account, `/agents/${agentId}/grants/${grantId}/revoke`);
}

/** Grants a capability that must be granted. */
async function granted(account: Account, agentId: string, payload: object) {
  const response = await grant(account, agentId, payload);
  assert.equal(response.statusCode, 200, response.body);
  return GrantCapabilityResponseSchema.parse(response.json()).grant;
}

/** Revokes a grant that must be revoked. */
async function revoked(account: Account, agentId: string, grantId: string) {
  const response = await revoke(account, agentId, grantId);
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(response.body, "");
}

async function records(account: Account) {
  const response = await get(account, "/grant-records");
  assert.equal(response.statusCode, 200, response.body);
  return GrantRecordListResponseSchema.parse(response.json()).records;
}

/** A workspace of the account with one project, created through the API. */
async function workspaceWithProject(owner: Account, name = "Research") {
  const response = await post(owner, "/workspaces", {
    name,
    displayName: "Ada at work",
  });
  assert.equal(response.statusCode, 200, response.body);
  const { workspace } = CreateWorkspaceResponseSchema.parse(response.json());
  const project = await post(owner, `/workspaces/${workspace.id}/projects`, {
    name: "App",
  });
  assert.equal(project.statusCode, 200, project.body);
  return {
    workspace,
    project: CreateProjectResponseSchema.parse(project.json()).project,
  };
}

/** Adds the account to the workspace as a claimed member. */
async function addClaimed(
  workspaceId: WorkspaceId,
  account: Account,
  addedBy: Account,
): Promise<MemberId> {
  const id = newId<MemberId>();
  await database().insert(workspaceMembers).values({
    id,
    workspaceId,
    userId: account.device.userId,
    displayName: "Grace",
    role: "member",
    addedByUserId: addedBy.device.userId,
    claimedAt: new Date(),
  });
  return id;
}

/** An agent hosted on the account's calling device, created through the API. */
async function agentOn(account: Account, projectId: string, name = "Builder") {
  const response = await post(account, `/projects/${projectId}/agents`, {
    name,
  });
  assert.equal(response.statusCode, 200, response.body);
  return CreateAgentResponseSchema.parse(response.json()).agent;
}

/** A repository of the project, registered through the API. */
async function repositoryOf(
  account: Account,
  projectId: string,
  name = "web",
): Promise<RepositoryId> {
  const response = await post(account, `/projects/${projectId}/repositories`, {
    name,
  });
  assert.equal(response.statusCode, 200, response.body);
  return RegisterRepositoryResponseSchema.parse(response.json()).repository.id;
}

/** A provider connection of the account's calling device, through the API. */
async function connectionOf(account: Account): Promise<ProviderConnectionId> {
  const response = await post(account, "/provider-connections", {
    kind: "claude",
    label: "Work",
  });
  assert.equal(response.statusCode, 200, response.body);
  return RegisterProviderConnectionResponseSchema.parse(response.json())
    .providerConnection.id;
}

async function grantRow(id: PermissionGrantId) {
  const [row] = await database()
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, id));
  assert.ok(row !== undefined);
  return row;
}

function grantRowsOf(agentId: AgentId) {
  return database()
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.granteeAgentId, agentId))
    .orderBy(permissionGrants.id);
}

function errorCode(response: { json(): unknown }): unknown {
  return (response.json() as { code?: unknown }).code;
}

const NOT_FOUND = {
  statusCode: 404,
  error: "Not Found",
  message: "Not Found",
  code: "not_found",
};

const FORBIDDEN = {
  statusCode: 403,
  error: "Forbidden",
  message: "Forbidden",
  code: "forbidden",
};

/** How long a test waits for a message that the server sends at once. */
const MESSAGE_TIMEOUT_MS = 2_000;

/** The next message, which the device's decoder accepts, or a failure after `MESSAGE_TIMEOUT_MS`. */
async function nextMessage(client: Client) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no message within ${MESSAGE_TIMEOUT_MS} ms`));
    }, MESSAGE_TIMEOUT_MS);
  });
  try {
    const decoded = decodeServerMessage(
      await Promise.race([client.next(), timeout]),
    );
    assert.ok(decoded.ok, JSON.stringify(decoded));
    return decoded;
  } finally {
    clearTimeout(timer);
  }
}

async function nextEvent(client: Client) {
  const message = await nextMessage(client);
  assert.ok(message.kind === "event", JSON.stringify(message));
  return message.event;
}

/** The next message as the server sent it, before the decoder. */
async function nextRaw(client: Client): Promise<string> {
  return JSON.stringify(await client.next());
}

/** Subscribes, skipping the presence frames of other subscribers. */
async function subscribed(client: Client, workspaceId: WorkspaceId) {
  client.send({ protocolVersion: 0, type: "workspace.subscribe", workspaceId });
  for (;;) {
    const message = await nextMessage(client);
    assert.ok(message.kind === "frame", JSON.stringify(message));
    if (message.frame.type === "workspace.subscribed") {
      assert.equal(message.frame.workspaceId, workspaceId);
      return;
    }
    assert.equal(message.frame.type, "presence.changed");
  }
}

/** Lets pending messages arrive, then reads the presence frames among them. */
async function drainPresence(...clients: Client[]) {
  await settle();
  for (const client of clients) {
    while (client.unread() > 0) {
      const message = await nextMessage(client);
      assert.ok(
        message.kind === "frame" && message.frame.type === "presence.changed",
        JSON.stringify(message),
      );
    }
  }
}

/** Lets pending messages arrive, then checks that none is left unread. */
async function quiet(...clients: Client[]) {
  await settle();
  for (const client of clients) {
    assert.equal(client.unread(), 0);
  }
}

test("the owner grants from the agent's host device: the answer is the whole new grant, and every subscribed member receives agent.grant.created without account or device data", async (t) => {
  const { account, clock } = instance(t);
  const ada = await account(7501);
  const bob = await account(7502);
  const cleo = await account(7503);
  const dan = await account(7504);
  const { workspace, project } = await workspaceWithProject(ada);
  await addClaimed(workspace.id, bob, ada);
  await addClaimed(workspace.id, dan, ada);
  // Cleo owns another workspace and is no member of Ada's.
  const { workspace: other } = await workspaceWithProject(cleo, "Elsewhere");
  const agent = await agentOn(bob, project.id);
  const repositoryId = await repositoryOf(bob, project.id);
  const connectionId = await connectionOf(bob);

  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  // Dan is a member whose connection is not subscribed.
  const danClient = (await connected(t, dan.app, dan.device)).client;
  const everyone = [adaClient, bobClient, cleoClient, danClient];
  await subscribed(adaClient, workspace.id);
  await subscribed(bobClient, workspace.id);
  await subscribed(cleoClient, other.id);
  await drainPresence(...everyone);

  const now = new Date(clock.now());
  const onRepository = await granted(bob, agent.id, {
    capability: "repo.write",
    repositoryId,
    lifetimeSeconds: 3_600,
  });
  assert.deepEqual(onRepository, {
    id: onRepository.id,
    projectId: project.id,
    granteeAgentId: agent.id,
    grantedByUserId: bob.device.userId,
    capability: "repo.write",
    repositoryId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + HOUR_MS).toISOString(),
    revokedAt: null,
    revokedByUserId: null,
  });
  const row = await grantRow(onRepository.id);
  assert.equal(row.hostDeviceId, bob.device.deviceId);
  assert.equal(row.grantedByUserId, bob.device.userId);
  assert.equal(row.revokedAt, null);
  for (const client of [adaClient, bobClient]) {
    const event = await nextEvent(client);
    assert.ok(event.type === "agent.grant.created", event.type);
    assert.equal(event.workspaceId, workspace.id);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    assert.deepEqual(event.payload, {
      grant: {
        id: onRepository.id,
        projectId: project.id,
        granteeAgentId: agent.id,
        capability: "repo.write",
        repositoryId,
        createdAt: now.toISOString(),
        expiresAt: onRepository.expiresAt,
      },
    });
  }
  await quiet(...everyone);

  // A grant of provider.use names its connection in the answer only: the
  // event carries no connection, no account, and no device.
  const onConnection = await granted(bob, agent.id, {
    capability: "provider.use",
    providerConnectionId: connectionId,
    lifetimeSeconds: null,
  });
  assert.equal(onConnection.capability, "provider.use");
  assert.ok(onConnection.capability === "provider.use");
  assert.equal(onConnection.providerConnectionId, connectionId);
  assert.equal(onConnection.expiresAt, null);
  for (const client of [adaClient, bobClient]) {
    const raw = await nextRaw(client);
    for (const secret of [
      connectionId,
      bob.device.userId,
      bob.device.deviceId,
    ]) {
      assert.equal(raw.includes(secret), false, secret);
    }
    const decoded = decodeServerMessage(JSON.parse(raw));
    assert.ok(decoded.ok && decoded.kind === "event", raw);
    assert.deepEqual(decoded.event.payload, {
      grant: {
        id: onConnection.id,
        projectId: project.id,
        granteeAgentId: agent.id,
        capability: "provider.use",
        createdAt: now.toISOString(),
        expiresAt: null,
      },
    });
  }
  // Cleo, of another workspace, and Dan, not subscribed, receive nothing.
  await quiet(...everyone);
  assert.equal(SERVER_EVENT_AUDIENCES["agent.grant.created"], "members");
  assert.equal(SERVER_EVENT_AUDIENCES["agent.grant.revoked"], "members");
});

test("only the agent's owner grants, and only from its host device: another device of the owner and another member get 403, and a non-member, a removed member, and an unknown agent or scope get the same 404", async (t) => {
  const { account, secondDevice } = instance(t);
  const ada = await account(7511);
  const bob = await account(7512);
  const former = await account(7513);
  const outsider = await account(7514);
  const { workspace, project } = await workspaceWithProject(ada);
  await addClaimed(workspace.id, bob, ada);
  const formerPerson = await addClaimed(workspace.id, former, ada);
  const laptop = await secondDevice(bob);
  const agent = await agentOn(bob, project.id);
  const repositoryId = await repositoryOf(bob, project.id);
  // A repository of another project and a connection of another device.
  const { project: elsewhere } = await workspaceWithProject(bob, "Elsewhere");
  const foreignRepository = await repositoryOf(bob, elsewhere.id);
  const laptopConnection = await connectionOf(laptop);
  await database()
    .update(workspaceMembers)
    .set({ removedAt: new Date(), removedByUserId: ada.device.userId })
    .where(eq(workspaceMembers.id, formerPerson));
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  await subscribed(bobClient, workspace.id);
  await drainPresence(bobClient);

  const body = { capability: "repo.read", repositoryId, lifetimeSeconds: null };
  // The owner on another of its devices, and the workspace's owner.
  for (const caller of [laptop, ada]) {
    const refused = await grant(caller, agent.id, body);
    assert.equal(refused.statusCode, 403, refused.body);
    assert.deepEqual(refused.json(), FORBIDDEN);
  }
  const unknown = await grant(bob, newId<AgentId>(), body);
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.deepEqual(unknown.json(), NOT_FOUND);
  for (const caller of [former, outsider]) {
    const refused = await grant(caller, agent.id, body);
    assert.equal(refused.statusCode, 404, refused.body);
    assert.equal(refused.body, unknown.body);
  }
  for (const scope of [
    { capability: "repo.read", repositoryId: foreignRepository },
    { capability: "repo.read", repositoryId: newId<RepositoryId>() },
    { capability: "provider.use", providerConnectionId: laptopConnection },
  ]) {
    const refused = await grant(bob, agent.id, {
      ...scope,
      lifetimeSeconds: null,
    });
    assert.equal(refused.statusCode, 404, JSON.stringify(scope));
    assert.equal(refused.body, unknown.body);
  }
  assert.deepEqual(await grantRowsOf(agent.id), []);
  await quiet(bobClient);
  // The host device itself grants.
  await granted(bob, agent.id, body);
});

test("the owner revokes from any of its devices: the answer is 204, the row records the revocation, and every subscribed member receives agent.grant.revoked; a second revocation answers 409", async (t) => {
  const { account, secondDevice, clock } = instance(t);
  const ada = await account(7521);
  const bob = await account(7522);
  const outsider = await account(7523);
  const { workspace, project } = await workspaceWithProject(ada);
  await addClaimed(workspace.id, bob, ada);
  const laptop = await secondDevice(bob);
  const agent = await agentOn(bob, project.id);
  const otherAgent = await agentOn(bob, project.id, "Reviewer");
  const repositoryId = await repositoryOf(bob, project.id);
  const body = { capability: "repo.read", repositoryId, lifetimeSeconds: null };
  const grantOf = await granted(bob, agent.id, body);
  const otherGrant = await granted(bob, otherAgent.id, body);
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  const outsiderClient = (await connected(t, outsider.app, outsider.device))
    .client;
  await subscribed(adaClient, workspace.id);
  await subscribed(bobClient, workspace.id);
  await drainPresence(adaClient, bobClient, outsiderClient);

  // The workspace's owner is not the agent's owner.
  const forbidden = await revoke(ada, agent.id, grantOf.id);
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.deepEqual(forbidden.json(), FORBIDDEN);
  const unknown = await revoke(bob, newId<AgentId>(), grantOf.id);
  assert.equal(unknown.statusCode, 404, unknown.body);
  assert.deepEqual(unknown.json(), NOT_FOUND);
  for (const refused of [
    await revoke(outsider, agent.id, grantOf.id),
    // A grant of another agent, and a grant that does not exist.
    await revoke(bob, agent.id, otherGrant.id),
    await revoke(bob, agent.id, newId<PermissionGrantId>()),
  ]) {
    assert.equal(refused.statusCode, 404, refused.body);
    assert.equal(refused.body, unknown.body);
  }
  assert.equal((await grantRow(grantOf.id)).revokedAt, null);
  assert.equal((await grantRow(otherGrant.id)).revokedAt, null);
  await quiet(adaClient, bobClient, outsiderClient);

  // Another device of the owner revokes.
  clock.advance(1_000);
  await revoked(laptop, agent.id, grantOf.id);
  const at = new Date(clock.now());
  const row = await grantRow(grantOf.id);
  assert.deepEqual(row.revokedAt, at);
  assert.equal(row.revokedByUserId, bob.device.userId);
  for (const client of [adaClient, bobClient]) {
    const event = await nextEvent(client);
    assert.ok(event.type === "agent.grant.revoked", event.type);
    assert.equal(event.workspaceId, workspace.id);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    assert.deepEqual(event.payload, {
      grantId: grantOf.id,
      granteeAgentId: agent.id,
      revokedAt: at.toISOString(),
    });
  }
  await quiet(adaClient, bobClient, outsiderClient);

  const again = await revoke(bob, agent.id, grantOf.id);
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(errorCode(again), "conflict");
  assert.equal((await grantRow(otherGrant.id)).revokedAt, null);
  await quiet(adaClient, bobClient);
});

test("a grant of terminal.execute needs a lifetime of at most 30 days, the other capabilities accept none, and a malformed body or an inherited lifetime answers 400 and writes nothing", async (t) => {
  const { account, clock } = instance(t);
  const bob = await account(7531);
  const other = await account(7532);
  const { project } = await workspaceWithProject(bob);
  const agent = await agentOn(bob, project.id);
  const repositoryId = await repositoryOf(bob, project.id);

  for (const payload of [
    { capability: "terminal.execute", repositoryId, lifetimeSeconds: null },
    {
      capability: "terminal.execute",
      repositoryId,
      lifetimeSeconds: SHELL_GRANT_MAX_LIFETIME_SECONDS + 1,
    },
    { capability: "terminal.execute", repositoryId },
    { capability: "repo.read", repositoryId },
    { capability: "repo.read", repositoryId, lifetimeSeconds: 59 },
    { capability: "repo.read", repositoryId, lifetimeSeconds: 60.5 },
    { capability: "repo.read", repositoryId, lifetimeSeconds: "3600" },
    { capability: "repo.admin", repositoryId, lifetimeSeconds: null },
    { capability: "provider.use", repositoryId, lifetimeSeconds: null },
    { capability: "repo.read", lifetimeSeconds: null },
    {},
  ]) {
    const refused = await grant(bob, agent.id, payload);
    assert.equal(refused.statusCode, 400, JSON.stringify(payload));
    assert.equal(errorCode(refused), "bad_request");
  }
  // A lifetime that the body only inherits never counts.
  for (const raw of [
    `{"capability":"repo.read","repositoryId":"${repositoryId}","__proto__":{"lifetimeSeconds":null}}`,
    `{"capability":"repo.read","repositoryId":"${repositoryId}","constructor":{"prototype":{"lifetimeSeconds":null}}}`,
  ]) {
    const refused = await grant(bob, agent.id, raw);
    assert.equal(refused.statusCode, 400, raw);
    assert.equal(errorCode(refused), "bad_request");
  }
  const malformed = await grant(bob, "not-an-id", {
    capability: "repo.read",
    repositoryId,
    lifetimeSeconds: null,
  });
  assert.equal(malformed.statusCode, 400, malformed.body);
  assert.deepEqual(await grantRowsOf(agent.id), []);

  // At most 30 days, and the server's time sets the expiry; a field that
  // names the grant's ID, agent, account, or times is stripped.
  const now = new Date(clock.now());
  const shell = await granted(bob, agent.id, {
    capability: "terminal.execute",
    repositoryId,
    lifetimeSeconds: SHELL_GRANT_MAX_LIFETIME_SECONDS,
    id: newId<PermissionGrantId>(),
    granteeAgentId: newId<AgentId>(),
    grantedByUserId: other.device.userId,
    projectId: newId<ProjectId>(),
    createdAt: "2020-01-01T00:00:00.000Z",
    expiresAt: null,
    providerConnectionId: newId<ProviderConnectionId>(),
  });
  assert.equal(shell.capability, "terminal.execute");
  assert.equal(shell.granteeAgentId, agent.id);
  assert.equal(shell.grantedByUserId, bob.device.userId);
  assert.equal(shell.projectId, project.id);
  assert.equal(shell.createdAt, now.toISOString());
  assert.equal(
    shell.expiresAt,
    new Date(now.getTime() + 30 * DAY_MS).toISOString(),
  );
  const [row] = await grantRowsOf(agent.id);
  assert.equal(row?.id, shell.id);
  assert.equal(row?.providerConnectionId, null);
  // Another capability without an expiry.
  const forever = await granted(bob, agent.id, {
    capability: "repo.read",
    repositoryId,
    lifetimeSeconds: null,
  });
  assert.equal(forever.expiresAt, null);
});

test(`an agent with ${GRANT_COUNT_LIMITS.perAgent} grants that are not revoked answers 409 with grant_limit and no Retry-After, a grant of the same scope or of a disabled agent answers 409 with conflict, and a revocation frees a place`, async (t) => {
  const { account } = instance(t);
  const bob = await account(7541);
  const { project } = await workspaceWithProject(bob);
  const agent = await agentOn(bob, project.id);
  const repositoryId = await repositoryOf(bob, project.id);
  const held = await granted(bob, agent.id, {
    capability: "repo.read",
    repositoryId,
    lifetimeSeconds: null,
  });
  const duplicate = await grant(bob, agent.id, {
    capability: "repo.read",
    repositoryId,
    lifetimeSeconds: 3_600,
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.equal(errorCode(duplicate), "conflict");

  // The agent holds one grant; fill its other places directly.
  const fillers = Array.from(
    { length: GRANT_COUNT_LIMITS.perAgent - 1 },
    (_, index) => ({
      id: newId<RepositoryId>(),
      projectId: project.id,
      name: `filler-${index}`,
      createdByUserId: bob.device.userId,
    }),
  );
  await database().insert(repositories).values(fillers);
  await database()
    .insert(permissionGrants)
    .values(
      fillers.map((repository) => ({
        id: newId<PermissionGrantId>(),
        projectId: project.id,
        granteeAgentId: agent.id,
        hostDeviceId: bob.device.deviceId,
        capability: "repo.read" as const,
        repositoryId: repository.id,
        grantedByUserId: bob.device.userId,
      })),
    );
  const over = await grant(bob, agent.id, {
    capability: "repo.write",
    repositoryId,
    lifetimeSeconds: null,
  });
  assert.equal(over.statusCode, 409, over.body);
  assert.deepEqual(ApiErrorBodySchema.parse(over.json()), {
    statusCode: 409,
    error: "Conflict",
    message: "Conflict",
    code: "grant_limit",
  });
  assert.equal(over.headers["retry-after"], undefined);
  assert.equal(
    (await grantRowsOf(agent.id)).length,
    GRANT_COUNT_LIMITS.perAgent,
  );

  await revoked(bob, agent.id, held.id);
  await granted(bob, agent.id, {
    capability: "repo.write",
    repositoryId,
    lifetimeSeconds: null,
  });

  // A disabled agent is granted nothing.
  await database()
    .update(agents)
    .set({ disabledAt: new Date() })
    .where(eq(agents.id, agent.id));
  const disabled = await grant(bob, agent.id, {
    capability: "git.commit",
    repositoryId,
    lifetimeSeconds: null,
  });
  assert.equal(disabled.statusCode, 409, disabled.body);
  assert.equal(errorCode(disabled), "conflict");
});

test(`an account that made ${GRANT_COUNT_LIMITS.perDay} grants within 24 hours, renewals and revoked grants included, answers 429 with rate_limited and Retry-After, sends no event, and grants again once the oldest is 24 hours old`, async (t) => {
  const { account, clock } = instance(t);
  const bob = await account(7591);
  const { workspace, project } = await workspaceWithProject(bob);
  const agent = await agentOn(bob, project.id);
  const repositoryId = await repositoryOf(bob, project.id);
  // A grant that expires in a minute, made through the route.
  const expiring = await granted(bob, agent.id, {
    capability: "repo.write",
    repositoryId,
    lifetimeSeconds: 60,
  });
  // Revoked grants of the last 24 hours, the oldest 23 hours ago, written
  // directly: with the expiring one, one short of the limit.
  const start = clock.now();
  const oldest = start - 23 * HOUR_MS;
  await database()
    .insert(permissionGrants)
    .values(
      Array.from({ length: GRANT_COUNT_LIMITS.perDay - 2 }, (_, index) => {
        const createdAt = new Date(index === 0 ? oldest : start - HOUR_MS);
        return {
          id: newId<PermissionGrantId>(),
          projectId: project.id,
          granteeAgentId: agent.id,
          hostDeviceId: bob.device.deviceId,
          capability: "repo.read" as const,
          repositoryId,
          grantedByUserId: bob.device.userId,
          createdAt,
          revokedAt: new Date(createdAt.getTime() + 60_000),
          revokedByUserId: bob.device.userId,
        };
      }),
    );
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  await subscribed(bobClient, workspace.id);
  await drainPresence(bobClient);

  // The renewal of the expired grant is the last grant of the day.
  clock.advance(120_000);
  const renewal = await granted(bob, agent.id, {
    capability: "repo.write",
    repositoryId,
    lifetimeSeconds: null,
  });
  assert.notEqual(renewal.id, expiring.id);
  assert.equal((await nextEvent(bobClient)).type, "agent.grant.revoked");
  assert.equal((await nextEvent(bobClient)).type, "agent.grant.created");
  const before = (await grantRowsOf(agent.id)).length;

  const refused = await grant(bob, agent.id, {
    capability: "git.commit",
    repositoryId,
    lifetimeSeconds: null,
  });
  assert.equal(refused.statusCode, 429, refused.body);
  assert.deepEqual(ApiErrorBodySchema.parse(refused.json()), {
    statusCode: 429,
    error: "Too Many Requests",
    message: "Too Many Requests",
    code: "rate_limited",
  });
  // The oldest leaves the 24 hours one hour after `start`.
  const waitMs = oldest + DAY_MS - clock.now();
  assert.equal(waitMs, HOUR_MS - 120_000);
  assert.equal(refused.headers["retry-after"], String(waitMs / 1000));
  assert.equal((await grantRowsOf(agent.id)).length, before);
  await quiet(bobClient);

  clock.advance(waitMs);
  const later = { ...bob, token: await accessToken(bob.app, bob.device) };
  await granted(later, agent.id, {
    capability: "git.commit",
    repositoryId,
    lifetimeSeconds: null,
  });
});

test("a grant that replaces an expired grant of the same scope sends agent.grant.revoked for the expired one and then agent.grant.created", async (t) => {
  const { account, clock } = instance(t);
  const ada = await account(7551);
  const bob = await account(7552);
  const { workspace, project } = await workspaceWithProject(ada);
  await addClaimed(workspace.id, bob, ada);
  const agent = await agentOn(bob, project.id);
  const repositoryId = await repositoryOf(bob, project.id);
  const body = { capability: "repo.read", repositoryId, lifetimeSeconds: 60 };
  const first = await granted(bob, agent.id, body);
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  await subscribed(adaClient, workspace.id);
  await drainPresence(adaClient);

  // Not expired yet: the same scope answers conflict.
  clock.advance(59_000);
  const early = await grant(bob, agent.id, body);
  assert.equal(early.statusCode, 409, early.body);
  assert.equal(errorCode(early), "conflict");
  await quiet(adaClient);

  clock.advance(1_000);
  const at = new Date(clock.now());
  const second = await granted(bob, agent.id, body);
  const old = await grantRow(first.id);
  assert.deepEqual(old.revokedAt, at);
  assert.equal(old.revokedByUserId, bob.device.userId);
  const revokedEvent = await nextEvent(adaClient);
  assert.ok(revokedEvent.type === "agent.grant.revoked", revokedEvent.type);
  assert.deepEqual(revokedEvent.payload, {
    grantId: first.id,
    granteeAgentId: agent.id,
    revokedAt: at.toISOString(),
  });
  const createdEvent = await nextEvent(adaClient);
  assert.ok(createdEvent.type === "agent.grant.created", createdEvent.type);
  assert.equal(createdEvent.payload.grant.id, second.id);
  assert.equal(createdEvent.payload.grant.createdAt, at.toISOString());
  await quiet(adaClient);
});

test("the record list holds the unrevoked grants of the agents that the calling device hosts, each with its facts, and nothing of another device or account", async (t) => {
  const { account, secondDevice, clock } = instance(t);
  const ada = await account(7561);
  const bob = await account(7562);
  const dan = await account(7563);
  const { workspace, project } = await workspaceWithProject(ada);
  await addClaimed(workspace.id, bob, ada);
  await addClaimed(workspace.id, dan, ada);
  const laptop = await secondDevice(bob);
  const onDesk = await agentOn(bob, project.id, "Desk");
  const onLaptop = await agentOn(laptop, project.id, "Laptop");
  const adaAgent = await agentOn(ada, project.id, "Ada's");
  const repositoryId = await repositoryOf(bob, project.id);
  const deskConnection = await connectionOf(bob);

  const read = await granted(bob, onDesk.id, {
    capability: "repo.read",
    repositoryId,
    lifetimeSeconds: 60,
  });
  const use = await granted(bob, onDesk.id, {
    capability: "provider.use",
    providerConnectionId: deskConnection,
    lifetimeSeconds: null,
  });
  const gone = await granted(bob, onDesk.id, {
    capability: "repo.write",
    repositoryId,
    lifetimeSeconds: null,
  });
  await revoked(laptop, onDesk.id, gone.id);
  const fromLaptop = await granted(laptop, onLaptop.id, {
    capability: "git.commit",
    repositoryId,
    lifetimeSeconds: null,
  });
  const adaGrant = await granted(ada, adaAgent.id, {
    capability: "repo.read",
    repositoryId,
    lifetimeSeconds: null,
  });
  // An expired grant stays listed until it is revoked.
  clock.advance(2 * 60_000);

  const project_ = { id: project.id, workspaceId: workspace.id };
  const facts = (agentId: AgentId, device: SignedInDevice) => ({
    agent: { id: agentId, hostDeviceId: device.deviceId, disabledAt: null },
    hostDevice: { id: device.deviceId, revokedAt: null },
    project: project_,
    grantorMembership: {
      workspaceId: workspace.id,
      userId: device.userId,
      removedAt: null,
    },
  });
  const desk = await records(bob);
  assert.deepEqual(
    desk,
    [read, use]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((grant) => ({
        grant,
        facts: {
          ...facts(onDesk.id, bob.device),
          providerConnection:
            grant.capability === "provider.use"
              ? {
                  id: deskConnection,
                  hostDeviceId: bob.device.deviceId,
                  removedAt: null,
                }
              : null,
        },
      })),
  );
  assert.deepEqual(await records(laptop), [
    {
      grant: fromLaptop,
      facts: { ...facts(onLaptop.id, laptop.device), providerConnection: null },
    },
  ]);
  assert.deepEqual(await records(ada), [
    {
      grant: adaGrant,
      facts: { ...facts(adaAgent.id, ada.device), providerConnection: null },
    },
  ]);
  // A device that hosts no agent gets an empty list.
  assert.deepEqual(await records(dan), []);
});

test("a refused or rolled-back grant or revocation sends no grant event and changes nothing, and the same change sends its event once it commits", async (t) => {
  const { account, failNextCommit, failedCommits } = instance(t);
  const bob = await account(7571);
  const { workspace, project } = await workspaceWithProject(bob);
  const agent = await agentOn(bob, project.id);
  const repositoryId = await repositoryOf(bob, project.id);
  const body = { capability: "repo.read", repositoryId, lifetimeSeconds: null };
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  await subscribed(bobClient, workspace.id);
  await drainPresence(bobClient);

  failNextCommit();
  const failedGrant = await grant(bob, agent.id, body);
  assert.equal(failedGrant.statusCode, 500, failedGrant.body);
  assert.deepEqual(await grantRowsOf(agent.id), []);
  await quiet(bobClient);

  const made = await granted(bob, agent.id, body);
  const created = await nextEvent(bobClient);
  assert.ok(created.type === "agent.grant.created", created.type);
  assert.equal(created.payload.grant.id, made.id);

  failNextCommit();
  const failedRevoke = await revoke(bob, agent.id, made.id);
  assert.equal(failedRevoke.statusCode, 500, failedRevoke.body);
  assert.deepEqual(failedCommits(), ["grant-routes.ts", "grant-routes.ts"]);
  assert.equal((await grantRow(made.id)).revokedAt, null);
  await quiet(bobClient);

  await revoked(bob, agent.id, made.id);
  const revokedEvent = await nextEvent(bobClient);
  assert.ok(revokedEvent.type === "agent.grant.revoked", revokedEvent.type);
  assert.equal(revokedEvent.payload.grantId, made.id);
  await quiet(bobClient);
});

test("the grant routes need a valid access token, and a revoked device gets 401", async (t) => {
  const { account, secondDevice } = instance(t);
  const bob = await account(7581);
  const laptop = await secondDevice(bob);
  const { project } = await workspaceWithProject(bob);
  const agent = await agentOn(bob, project.id);
  const repositoryId = await repositoryOf(bob, project.id);
  const made = await granted(bob, agent.id, {
    capability: "repo.read",
    repositoryId,
    lifetimeSeconds: null,
  });
  const requests = [
    ["GET", "/grant-records", undefined],
    [
      "POST",
      `/agents/${agent.id}/grants`,
      { capability: "repo.write", repositoryId, lifetimeSeconds: null },
    ],
    ["POST", `/agents/${agent.id}/grants/${made.id}/revoke`, undefined],
  ] as const;
  for (const [method, url, payload] of requests) {
    for (const headers of [{}, { authorization: "Bearer not-a-token" }]) {
      const response = await bob.app.inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      assert.equal(response.statusCode, 401, url);
      assert.equal(errorCode(response), "unauthorized");
    }
  }
  const revokeDevice = await post(
    laptop,
    `/devices/${bob.device.deviceId}/revoke`,
    { reason: "removed" },
  );
  assert.equal(revokeDevice.statusCode, 204, revokeDevice.body);
  for (const [method, url, payload] of requests) {
    const response = await bob.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${bob.token}` },
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(response.statusCode, 401, url);
  }
});
