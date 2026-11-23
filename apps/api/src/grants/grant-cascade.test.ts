import {
  agentRuns,
  permissionGrants,
  workspaceMembers,
} from "@mymandev/database";
import {
  type AgentId,
  CreateAgentResponseSchema,
  CreateProjectResponseSchema,
  CreateWorkspaceResponseSchema,
  decodeServerMessage,
  GrantCapabilityResponseSchema,
  type MemberId,
  newId,
  type PermissionGrant,
  type ProjectId,
  RegisterProviderConnectionResponseSchema,
  RegisterRepositoryResponseSchema,
  type RunId,
  type UserId,
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
  newKey,
  signInDevice,
  type SignedInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";
import { type Client, connected, settle } from "../gateway-test-support.ts";
import { ConnectionRegistry } from "../gateway.ts";

// The changes that revoke grants in their own transaction send one
// agent.grant.revoked for each grant after the commit (#75; ADR 0015, update
// of 2026-11-14): a repository removal, a provider connection removal, a
// removal of a person and a departure, a device revocation, and a sign-in
// that replaces a device. Each event goes to the connections subscribed to
// the grant's own workspace, so a change that spans workspaces tells each
// workspace of its own grants only. The grant events come before the run
// events of the same change. An agent's disable is covered with its route
// (agent-routes.test.ts).

const database = useTestDatabase();

type Account = Readonly<{
  app: FastifyInstance;
  device: SignedInDevice;
  token: string;
}>;

/**
 * One API instance: each account signs in through its own app, and every app
 * shares one registry of connections (`connections`, a new one by default),
 * one clock, and one database, whose next commit can be made to fail.
 */
function instance(
  t: TestContext,
  options: Readonly<{ connections?: ConnectionRegistry }> = {},
) {
  const connections = options.connections ?? new ConnectionRegistry();
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

function post(account: Account, url: string, payload?: object) {
  return account.app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${account.token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Posts a change that must answer `204`. */
async function done(account: Account, url: string, payload?: object) {
  const response = await post(account, url, payload);
  assert.equal(response.statusCode, 204, response.body);
}

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

async function agentOn(account: Account, projectId: string, name = "Builder") {
  const response = await post(account, `/projects/${projectId}/agents`, {
    name,
  });
  assert.equal(response.statusCode, 200, response.body);
  return CreateAgentResponseSchema.parse(response.json()).agent;
}

async function repositoryOf(account: Account, projectId: string, name = "web") {
  const response = await post(account, `/projects/${projectId}/repositories`, {
    name,
  });
  assert.equal(response.statusCode, 200, response.body);
  return RegisterRepositoryResponseSchema.parse(response.json()).repository.id;
}

async function connectionOf(account: Account) {
  const response = await post(account, "/provider-connections", {
    kind: "claude",
    label: "Work",
  });
  assert.equal(response.statusCode, 200, response.body);
  return RegisterProviderConnectionResponseSchema.parse(response.json())
    .providerConnection.id;
}

/** A queued run of the agent, requested by its owner, written directly. */
async function runOf(
  projectId: string,
  agentId: string,
  by: Account,
): Promise<RunId> {
  const id = newId<RunId>();
  await database()
    .insert(agentRuns)
    .values({
      id,
      agentId: agentId as AgentId,
      projectId: projectId as ProjectId,
      requestedByUserId: by.device.userId as UserId,
      state: "queued",
    });
  return id;
}

async function granted(account: Account, agentId: string, payload: object) {
  const response = await post(account, `/agents/${agentId}/grants`, payload);
  assert.equal(response.statusCode, 200, response.body);
  return GrantCapabilityResponseSchema.parse(response.json()).grant;
}

/** How long a test waits for a message that the server sends at once. */
const MESSAGE_TIMEOUT_MS = 2_000;

async function nextMessage(client: Client) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no message within ${MESSAGE_TIMEOUT_MS} ms`));
    }, MESSAGE_TIMEOUT_MS);
  });
  try {
    const raw = await Promise.race([client.next(), timeout]);
    const decoded = decodeServerMessage(raw);
    assert.ok(decoded.ok, JSON.stringify(decoded));
    return { decoded, raw: JSON.stringify(raw) };
  } finally {
    clearTimeout(timer);
  }
}

async function subscribed(client: Client, workspaceId: WorkspaceId) {
  client.send({ protocolVersion: 0, type: "workspace.subscribe", workspaceId });
  for (;;) {
    const { decoded } = await nextMessage(client);
    assert.ok(decoded.kind === "frame", JSON.stringify(decoded));
    if (decoded.frame.type === "workspace.subscribed") {
      return;
    }
    assert.equal(decoded.frame.type, "presence.changed");
  }
}

/**
 * Every message that arrived, after pending ones settled: the events as
 * `type` and, for a grant revocation, its grant; frames as `frame:type`.
 */
async function received(client: Client): Promise<string[]> {
  await settle();
  const seen: string[] = [];
  while (client.unread() > 0) {
    const { decoded } = await nextMessage(client);
    if (decoded.kind === "frame") {
      seen.push(`frame:${decoded.frame.type}`);
    } else if (decoded.event.type === "agent.grant.revoked") {
      seen.push(`revoked:${decoded.event.payload.grantId}`);
    } else if (decoded.event.type === "agent.run.state_changed") {
      seen.push(`run:${decoded.event.payload.runId}`);
    } else {
      seen.push(decoded.event.type);
    }
  }
  return seen;
}

/**
 * The next `agent.grant.revoked`, skipping presence frames, checked against
 * the grant, the workspace, and the time; returns its raw text.
 */
async function expectRevoked(
  client: Client,
  grant: PermissionGrant,
  workspaceId: WorkspaceId,
  at: Date,
): Promise<string> {
  for (;;) {
    const { decoded, raw } = await nextMessage(client);
    if (decoded.kind === "frame") {
      assert.equal(decoded.frame.type, "presence.changed", raw);
      continue;
    }
    const { event } = decoded;
    assert.ok(event.type === "agent.grant.revoked", raw);
    assert.equal(event.workspaceId, workspaceId);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    assert.deepEqual(event.payload, {
      grantId: grant.id,
      granteeAgentId: grant.granteeAgentId,
      revokedAt: at.toISOString(),
    });
    return raw;
  }
}

function byId(grants: readonly PermissionGrant[]): PermissionGrant[] {
  return [...grants].sort((a, b) => (a.id < b.id ? -1 : 1));
}

test("a repository removal sends agent.grant.revoked for each grant on the repository, after workspace.repository.removed, to the workspace's subscribers only", async (t) => {
  const { account, clock, failNextCommit, failedCommits } = instance(t);
  const ada = await account(7601);
  const bob = await account(7602);
  const cleo = await account(7603);
  const { workspace, project } = await workspaceWithProject(ada);
  await addClaimed(workspace.id, bob, ada);
  const { workspace: other } = await workspaceWithProject(cleo, "Elsewhere");
  const agent = await agentOn(bob, project.id);
  const removed = await repositoryOf(bob, project.id, "web");
  const kept = await repositoryOf(bob, project.id, "api");
  const onRemoved = byId([
    await granted(bob, agent.id, {
      capability: "repo.read",
      repositoryId: removed,
      lifetimeSeconds: null,
    }),
    await granted(bob, agent.id, {
      capability: "repo.write",
      repositoryId: removed,
      lifetimeSeconds: 3_600,
    }),
  ]);
  await granted(bob, agent.id, {
    capability: "repo.read",
    repositoryId: kept,
    lifetimeSeconds: null,
  });
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  await subscribed(adaClient, workspace.id);
  await subscribed(bobClient, workspace.id);
  await subscribed(cleoClient, other.id);
  await received(adaClient);

  // A removal whose commit fails sends nothing.
  failNextCommit();
  const failed = await post(
    ada,
    `/projects/${project.id}/repositories/${removed}/remove`,
  );
  assert.equal(failed.statusCode, 500, failed.body);
  assert.deepEqual(failedCommits(), ["repository-routes.ts"]);
  assert.deepEqual(await received(adaClient), []);

  // The workspace's owner removes the repository.
  clock.advance(1_000);
  await done(ada, `/projects/${project.id}/repositories/${removed}/remove`);
  const at = new Date(clock.now());
  const { decoded } = await nextMessage(adaClient);
  assert.ok(
    decoded.kind === "event" &&
      decoded.event.type === "workspace.repository.removed",
  );
  for (const grant of onRemoved) {
    await expectRevoked(adaClient, grant, workspace.id, at);
  }
  assert.deepEqual(await received(adaClient), []);
  assert.deepEqual(await received(bobClient), [
    "workspace.repository.removed",
    ...onRemoved.map((grant) => `revoked:${grant.id}`),
  ]);
  assert.deepEqual(await received(cleoClient), []);
});

test("a provider connection removal sends agent.grant.revoked for its provider.use grants, each to the subscribers of the grant's own workspace, without naming the connection", async (t) => {
  const { account, clock, secondDevice } = instance(t);
  const ada = await account(7611);
  const bob = await account(7612);
  const { workspace: adas, project: adaProject } =
    await workspaceWithProject(ada);
  await addClaimed(adas.id, bob, ada);
  const { workspace: bobs, project: bobProject } = await workspaceWithProject(
    bob,
    "Own",
  );
  const laptop = await secondDevice(bob);
  const inAdas = await agentOn(bob, adaProject.id);
  const inBobs = await agentOn(bob, bobProject.id);
  const connection = await connectionOf(bob);
  const kept = await connectionOf(bob);
  const body = (providerConnectionId: string) => ({
    capability: "provider.use",
    providerConnectionId,
    lifetimeSeconds: null,
  });
  const adaGrant = await granted(bob, inAdas.id, body(connection));
  const bobGrant = await granted(bob, inBobs.id, body(connection));
  await granted(bob, inBobs.id, body(kept));
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const laptopClient = (await connected(t, laptop.app, laptop.device)).client;
  await subscribed(adaClient, adas.id);
  await subscribed(laptopClient, adas.id);
  await subscribed(laptopClient, bobs.id);
  await received(adaClient);

  clock.advance(1_000);
  await done(bob, `/provider-connections/${connection}/remove`);
  const at = new Date(clock.now());
  // Ada sees only the grant of her workspace.
  const raw = await expectRevoked(adaClient, adaGrant, adas.id, at);
  assert.equal(raw.includes(connection), false);
  assert.equal(raw.includes(bob.device.deviceId), false);
  assert.deepEqual(await received(adaClient), []);
  // Bob's laptop, subscribed to both, sees each in its own workspace.
  const seen = new Map<string, string>();
  for (let n = 0; n < 2; n += 1) {
    const { decoded } = await nextMessage(laptopClient);
    assert.ok(
      decoded.kind === "event" && decoded.event.type === "agent.grant.revoked",
    );
    seen.set(decoded.event.payload.grantId, decoded.event.workspaceId);
  }
  assert.deepEqual(
    seen,
    new Map([
      [adaGrant.id, adas.id],
      [bobGrant.id, bobs.id],
    ]),
  );
  assert.deepEqual(await received(laptopClient), []);
});

test("a removal and a departure send agent.grant.revoked for the grants of the person's agents to the remaining subscribers, after the removal and before the cancelled runs, and never to the removed person", async (t) => {
  const { account, clock } = instance(t);
  const ada = await account(7621);
  const bob = await account(7622);
  const cleo = await account(7623);
  const { workspace, project } = await workspaceWithProject(ada);
  const bobPerson = await addClaimed(workspace.id, bob, ada);
  await addClaimed(workspace.id, cleo, ada);
  const repositoryId = await repositoryOf(ada, project.id);
  const body = { capability: "repo.read", repositoryId, lifetimeSeconds: null };
  const bobAgent = await agentOn(bob, project.id);
  const bobGrant = await granted(bob, bobAgent.id, body);
  const bobRun = await runOf(project.id, bobAgent.id, bob);
  const cleoAgent = await agentOn(cleo, project.id);
  const cleoGrant = await granted(cleo, cleoAgent.id, body);
  const cleoRun = await runOf(project.id, cleoAgent.id, cleo);
  const adaAgent = await agentOn(ada, project.id);
  await granted(ada, adaAgent.id, body);
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  await subscribed(adaClient, workspace.id);
  await subscribed(bobClient, workspace.id);
  await subscribed(cleoClient, workspace.id);
  await received(adaClient);
  await received(bobClient);

  clock.advance(1_000);
  await done(ada, `/workspaces/${workspace.id}/members/${bobPerson}/remove`);
  for (const client of [adaClient, cleoClient]) {
    assert.deepEqual(
      (await received(client)).filter(
        (seen) => seen !== "frame:presence.changed",
      ),
      ["workspace.member.removed", `revoked:${bobGrant.id}`, `run:${bobRun}`],
    );
  }
  // The removed person's subscription ended first: no grant event.
  assert.deepEqual(
    (await received(bobClient)).filter((seen) => !seen.startsWith("frame:")),
    [],
  );

  // A departure does the same.
  clock.advance(1_000);
  await done(cleo, `/workspaces/${workspace.id}/leave`);
  const adaSeen = (await received(adaClient)).filter(
    (seen) => seen !== "frame:presence.changed",
  );
  assert.deepEqual(adaSeen, [
    "workspace.member.removed",
    `revoked:${cleoGrant.id}`,
    `run:${cleoRun}`,
  ]);
  assert.deepEqual(
    (await received(cleoClient)).filter((seen) => !seen.startsWith("frame:")),
    [],
  );
});

test("a device revocation and a sign-in that replaces a device send agent.grant.revoked for the device's grants, each to the subscribers of the grant's own workspace, before the cancelled runs", async (t) => {
  const { account, clock, secondDevice } = instance(t);
  const ada = await account(7631);
  const bob = await account(7632);
  const { workspace: adas, project: adaProject } =
    await workspaceWithProject(ada);
  await addClaimed(adas.id, bob, ada);
  const { workspace: bobs, project: bobProject } = await workspaceWithProject(
    bob,
    "Own",
  );
  const laptop = await secondDevice(bob);
  const adaRepository = await repositoryOf(ada, adaProject.id);
  const bobRepository = await repositoryOf(bob, bobProject.id);
  const deskInAdas = await agentOn(bob, adaProject.id, "Desk");
  const deskInBobs = await agentOn(bob, bobProject.id, "Desk");
  const laptopInAdas = await agentOn(laptop, adaProject.id, "Laptop");
  const read = (repositoryId: string) => ({
    capability: "repo.read",
    repositoryId,
    lifetimeSeconds: null,
  });
  const deskAdaGrant = await granted(bob, deskInAdas.id, read(adaRepository));
  const deskBobGrant = await granted(bob, deskInBobs.id, read(bobRepository));
  const laptopGrant = await granted(
    laptop,
    laptopInAdas.id,
    read(adaRepository),
  );
  const deskRun = await runOf(adaProject.id, deskInAdas.id, bob);
  const laptopRun = await runOf(adaProject.id, laptopInAdas.id, laptop);
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const laptopClient = (await connected(t, laptop.app, laptop.device)).client;
  await subscribed(adaClient, adas.id);
  await subscribed(laptopClient, adas.id);
  await subscribed(laptopClient, bobs.id);
  await received(adaClient);

  // The laptop revokes the desk.
  clock.advance(1_000);
  await done(laptop, `/devices/${bob.device.deviceId}/revoke`, {
    reason: "removed",
  });
  const at = new Date(clock.now());
  await expectRevoked(adaClient, deskAdaGrant, adas.id, at);
  assert.deepEqual(await received(adaClient), [`run:${deskRun}`]);
  const laptopSeen = await received(laptopClient);
  assert.deepEqual(laptopSeen, [
    "frame:account.device_revoked",
    ...byId([deskAdaGrant, deskBobGrant]).map((grant) => `revoked:${grant.id}`),
    `run:${deskRun}`,
  ]);

  // A new device that replaces the laptop revokes the laptop's grants.
  clock.advance(1_000);
  await signInDevice(bob.app, newKey(), laptop.device.deviceId);
  const replacedAt = new Date(clock.now());
  await expectRevoked(adaClient, laptopGrant, adas.id, replacedAt);
  assert.deepEqual(await received(adaClient), [`run:${laptopRun}`]);
});

/** A registry whose every `agent.grant.revoked` fails to send. */
class FailingGrantRevocations extends ConnectionRegistry {
  override sendToWorkspace(
    ...args: Parameters<ConnectionRegistry["sendToWorkspace"]>
  ): number {
    if (args[0].type === "agent.grant.revoked") {
      throw new Error("the send failed");
    }
    return super.sendToWorkspace(...args);
  }
}

test("a grant event that fails to send fails neither the committed change nor the events after it", async (t) => {
  const { account } = instance(t, {
    connections: new FailingGrantRevocations(),
  });
  const ada = await account(7641);
  const bob = await account(7642);
  const { workspace, project } = await workspaceWithProject(ada);
  const bobPerson = await addClaimed(workspace.id, bob, ada);
  const repositoryId = await repositoryOf(ada, project.id);
  const bobAgent = await agentOn(bob, project.id);
  const bobGrant = await granted(bob, bobAgent.id, {
    capability: "repo.read",
    repositoryId,
    lifetimeSeconds: null,
  });
  const bobRun = await runOf(project.id, bobAgent.id, bob);
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  await subscribed(adaClient, workspace.id);
  await received(adaClient);

  await done(ada, `/workspaces/${workspace.id}/members/${bobPerson}/remove`);
  assert.deepEqual(
    (await received(adaClient)).filter(
      (seen) => seen !== "frame:presence.changed",
    ),
    ["workspace.member.removed", `run:${bobRun}`],
  );
  const [row] = await database()
    .select({ revokedAt: permissionGrants.revokedAt })
    .from(permissionGrants)
    .where(eq(permissionGrants.id, bobGrant.id));
  assert.notEqual(row?.revokedAt ?? null, null);
});
