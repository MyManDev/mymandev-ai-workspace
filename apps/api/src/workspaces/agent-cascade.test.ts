import { agentRuns, agents, workspaceMembers } from "@mymandev/database";
import {
  type AgentId,
  type AgentListItem,
  CreateAgentResponseSchema,
  CreateProjectResponseSchema,
  CreateWorkspaceResponseSchema,
  decodeServerMessage,
  GrantCapabilityResponseSchema,
  type MemberId,
  newId,
  type PermissionGrant,
  type ProjectId,
  RegisterRepositoryResponseSchema,
  type RunId,
  type ServerEvent,
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
  postNewDevice,
  signInCode,
  signInDevice,
  type SignedInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";
import {
  type Client,
  closedWith,
  connected,
  settle,
} from "../gateway-test-support.ts";
import { ConnectionRegistry } from "../gateway.ts";

// The cascades that disable agents send one workspace.agent.disabled for
// each agent after the commit (#326), with the payload of the agent route
// (#294): the agent as the agent list shows it, never its host device. They
// are a device revocation, a sign-in that replaces a device, a removal of a
// person, and a departure. Each event goes to the connections subscribed to
// the agent's own workspace, so a revocation that spans workspaces tells
// each workspace of its own agents only. The order of a cascade's messages
// is the order of the agent route: its own messages first (the closed
// connection and account.device_revoked, or workspace.member.removed and
// account.removed_from_workspace), then the disabled agents in the order of
// the agent IDs, then agent.grant.revoked, then agent.run.state_changed. A
// change whose commit fails sends nothing, and the revoked device or the
// removed person gets none of these events. The erasure of an account is an
// operator command outside the API and sends none.

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
  options: Readonly<{
    connections?: ConnectionRegistry;
    logLines?: string[];
  }> = {},
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
      ...(options.logLines === undefined ? {} : { logLines: options.logLines }),
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

/** Posts a change whose commit fails: `500`, and only the route's own transaction rolled back. */
async function failed(
  commits: Readonly<{
    failNextCommit: () => void;
    failedCommits: () => readonly string[];
  }>,
  file: string,
  change: () => Promise<{ statusCode: number; body: string }>,
) {
  const before = commits.failedCommits().length;
  commits.failNextCommit();
  const response = await change();
  assert.equal(response.statusCode, 500, response.body);
  assert.deepEqual(commits.failedCommits().slice(before), [file]);
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

/**
 * A new agent of the account's device in the project, as every member sees
 * it in the agent list: the answer's host device, which only the owner reads
 * (#342), is checked and left out.
 */
async function agentOn(
  account: Account,
  projectId: string,
  name = "Builder",
): Promise<AgentListItem> {
  const response = await post(account, `/projects/${projectId}/agents`, {
    name,
  });
  assert.equal(response.statusCode, 200, response.body);
  const { hostDeviceId, ...agent } = CreateAgentResponseSchema.parse(
    response.json(),
  ).agent;
  assert.equal(hostDeviceId, account.device.deviceId);
  return agent;
}

async function repositoryOf(account: Account, projectId: string) {
  const response = await post(account, `/projects/${projectId}/repositories`, {
    name: "web",
  });
  assert.equal(response.statusCode, 200, response.body);
  return RegisterRepositoryResponseSchema.parse(response.json()).repository.id;
}

/** A `repo.read` grant on the repository to the agent, by its owner from its host device. */
async function granted(
  account: Account,
  agentId: string,
  repositoryId: string,
): Promise<PermissionGrant> {
  const response = await post(account, `/agents/${agentId}/grants`, {
    capability: "repo.read",
    repositoryId,
    lifetimeSeconds: null,
  });
  assert.equal(response.statusCode, 200, response.body);
  return GrantCapabilityResponseSchema.parse(response.json()).grant;
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

async function disabledAt(agentId: string): Promise<Date | null> {
  const [row] = await database()
    .select({ disabledAt: agents.disabledAt })
    .from(agents)
    .where(eq(agents.id, agentId as AgentId));
  assert.ok(row !== undefined);
  return row.disabledAt;
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

type Received = Readonly<{
  /**
   * Each message: `disabled:<agent ID>`, `revoked:<grant ID>`,
   * `run:<run ID>`, another event's type, or `frame:<type>` for a frame
   * other than `presence.changed`, which is left out.
   */
  seen: string[];
  /** The `workspace.agent.disabled` events, with their raw text. */
  disabled: { event: ServerEvent; raw: string }[];
}>;

/** Every message that arrived, after pending ones settled. */
async function received(client: Client): Promise<Received> {
  await settle();
  const result: Received = { seen: [], disabled: [] };
  while (client.unread() > 0) {
    const { decoded, raw } = await nextMessage(client);
    if (decoded.kind === "frame") {
      if (decoded.frame.type !== "presence.changed") {
        result.seen.push(`frame:${decoded.frame.type}`);
      }
      continue;
    }
    const { event } = decoded;
    if (event.type === "workspace.agent.disabled") {
      result.seen.push(`disabled:${event.payload.agent.id}`);
      result.disabled.push({ event, raw });
    } else if (event.type === "agent.grant.revoked") {
      result.seen.push(`revoked:${event.payload.grantId}`);
    } else if (event.type === "agent.run.state_changed") {
      result.seen.push(`run:${event.payload.runId}`);
    } else {
      result.seen.push(event.type);
    }
  }
  return result;
}

/** The labels of the agents' disabled events, in the order of the agent IDs. */
function disabledInOrder(...agentIds: string[]): string[] {
  return [...agentIds].sort().map((id) => `disabled:${id}`);
}

/**
 * Checks each `workspace.agent.disabled` against its agent as the creation
 * answered it, now disabled at `at` in `workspaceId`: a `system` actor,
 * `deviceId: null`, and the agent list item and nothing else, so the raw
 * text never names the host device.
 */
function assertDisabled(
  events: Received["disabled"],
  expected: readonly Readonly<{
    workspaceId: WorkspaceId;
    agent: AgentListItem;
  }>[],
  at: Date,
  hostDeviceId: string,
) {
  const inOrder = [...expected].sort((a, b) =>
    a.agent.id < b.agent.id ? -1 : 1,
  );
  assert.equal(events.length, inOrder.length);
  inOrder.forEach(({ workspaceId, agent }, index) => {
    const { event, raw } = events[index] ?? assert.fail("missing event");
    assert.ok(event.type === "workspace.agent.disabled", raw);
    assert.equal(event.workspaceId, workspaceId);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    assert.equal(event.occurredAt, at.toISOString());
    const payload = { agent: { ...agent, disabledAt: at.toISOString() } };
    assert.deepEqual(event.payload, payload);
    // As sent, before the decoder strips any field that it does not know.
    assert.deepEqual(
      (JSON.parse(raw) as { payload: unknown }).payload,
      payload,
    );
    assert.equal(raw.includes(hostDeviceId), false, raw);
  });
}

test("a device revocation sends workspace.agent.disabled for each agent of the device to the subscribers of the agent's own workspace, after the account frame and before the grant and run events, and nothing when its commit fails", async (t) => {
  const commits = instance(t);
  const { account, clock, secondDevice } = commits;
  const ada = await account(8601);
  const bob = await account(8602);
  const cleo = await account(8603);
  const dan = await account(8604);
  const { workspace: adas, project: adaProject } =
    await workspaceWithProject(ada);
  await addClaimed(adas.id, bob, ada);
  const { workspace: bobs, project: bobProject } = await workspaceWithProject(
    bob,
    "Own",
  );
  await addClaimed(bobs.id, cleo, bob);
  const { workspace: dans } = await workspaceWithProject(dan, "Elsewhere");
  const laptop = await secondDevice(bob);
  const deskInAdas = await agentOn(bob, adaProject.id, "Desk");
  const deskInBobs = await agentOn(bob, bobProject.id, "Desk too");
  const laptopAgent = await agentOn(laptop, adaProject.id, "Laptop");
  const adaAgent = await agentOn(ada, adaProject.id, "Ada's");
  // An agent of the desk that its owner disabled before: the revocation
  // does not disable it again, so no event announces it again.
  const retired = await agentOn(bob, adaProject.id, "Retired");
  await done(bob, `/projects/${adaProject.id}/agents/${retired.id}/disable`);
  const retiredAt = await disabledAt(retired.id);
  assert.ok(retiredAt !== null);
  const repositoryId = await repositoryOf(ada, adaProject.id);
  const grant = await granted(bob, deskInAdas.id, repositoryId);
  const run = await runOf(adaProject.id, deskInAdas.id, bob);
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const danClient = (await connected(t, dan.app, dan.device)).client;
  const deskClient = (await connected(t, bob.app, bob.device)).client;
  const laptopClient = (await connected(t, laptop.app, laptop.device)).client;
  await subscribed(adaClient, adas.id);
  await subscribed(cleoClient, bobs.id);
  await subscribed(danClient, dans.id);
  for (const client of [deskClient, laptopClient]) {
    await subscribed(client, adas.id);
    await subscribed(client, bobs.id);
  }
  const clients = [adaClient, cleoClient, danClient, deskClient, laptopClient];
  for (const client of clients) {
    await received(client);
  }
  const revoke = () =>
    post(laptop, `/devices/${bob.device.deviceId}/revoke`, {
      reason: "removed",
    });

  // A revocation whose commit fails sends nothing and disables nothing.
  clock.advance(1_000);
  await failed(commits, "device-routes.ts", revoke);
  for (const client of clients) {
    assert.deepEqual((await received(client)).seen, []);
  }
  assert.equal(await disabledAt(deskInAdas.id), null);

  // The laptop revokes the desk.
  clock.advance(1_000);
  const response = await revoke();
  assert.equal(response.statusCode, 204, response.body);
  const at = new Date(clock.now());
  assert.deepEqual(await deskClient.closed, closedWith("device_revoked"));
  const adaSeen = await received(adaClient);
  assert.deepEqual(adaSeen.seen, [
    `disabled:${deskInAdas.id}`,
    `revoked:${grant.id}`,
    `run:${run}`,
  ]);
  assertDisabled(
    adaSeen.disabled,
    [{ workspaceId: adas.id, agent: deskInAdas }],
    at,
    bob.device.deviceId,
  );
  const cleoSeen = await received(cleoClient);
  assert.deepEqual(cleoSeen.seen, [`disabled:${deskInBobs.id}`]);
  assertDisabled(
    cleoSeen.disabled,
    [{ workspaceId: bobs.id, agent: deskInBobs }],
    at,
    bob.device.deviceId,
  );
  // The account's other device hears of the revocation first, then of both
  // agents, each in its own workspace.
  const laptopSeen = await received(laptopClient);
  assert.deepEqual(laptopSeen.seen, [
    "frame:account.device_revoked",
    ...disabledInOrder(deskInAdas.id, deskInBobs.id),
    `revoked:${grant.id}`,
    `run:${run}`,
  ]);
  assertDisabled(
    laptopSeen.disabled,
    [
      { workspaceId: adas.id, agent: deskInAdas },
      { workspaceId: bobs.id, agent: deskInBobs },
    ],
    at,
    bob.device.deviceId,
  );
  // The revoked device's connection closed first, and another workspace's
  // subscriber hears of nothing.
  await settle();
  assert.equal(deskClient.unread(), 0);
  assert.deepEqual((await received(danClient)).seen, []);
  assert.equal(await disabledAt(laptopAgent.id), null);
  assert.equal(await disabledAt(adaAgent.id), null);
  assert.deepEqual(await disabledAt(retired.id), retiredAt);
});

test("a sign-in that replaces a device sends workspace.agent.disabled for each agent of the replaced device, before the grant and run events, never to the replaced device, and nothing when its commit fails", async (t) => {
  const commits = instance(t);
  const { account, clock, secondDevice } = commits;
  const ada = await account(8611);
  const bob = await account(8612);
  const { workspace, project } = await workspaceWithProject(ada);
  await addClaimed(workspace.id, bob, ada);
  const laptop = await secondDevice(bob);
  const first = await agentOn(laptop, project.id, "First");
  const second = await agentOn(laptop, project.id, "Second");
  const kept = await agentOn(bob, project.id, "Desk");
  const repositoryId = await repositoryOf(ada, project.id);
  const grant = await granted(laptop, first.id, repositoryId);
  const run = await runOf(project.id, second.id, bob);
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const deskClient = (await connected(t, bob.app, bob.device)).client;
  const laptopClient = (await connected(t, laptop.app, laptop.device)).client;
  for (const client of [adaClient, deskClient, laptopClient]) {
    await subscribed(client, workspace.id);
  }
  for (const client of [adaClient, deskClient, laptopClient]) {
    await received(client);
  }

  // A sign-in whose commit fails replaces nothing and sends nothing.
  clock.advance(1_000);
  const code = await signInCode(bob.app);
  await failed(commits, "sign-in.ts", () =>
    postNewDevice(bob.app, code, newKey(), laptop.device.deviceId),
  );
  for (const client of [adaClient, deskClient, laptopClient]) {
    assert.deepEqual((await received(client)).seen, []);
  }
  assert.equal(await disabledAt(first.id), null);

  // A new device replaces the laptop.
  clock.advance(1_000);
  await signInDevice(bob.app, newKey(), laptop.device.deviceId);
  const at = new Date(clock.now());
  assert.deepEqual(await laptopClient.closed, closedWith("device_revoked"));
  const expected = [
    ...disabledInOrder(first.id, second.id),
    `revoked:${grant.id}`,
    `run:${run}`,
  ];
  const adaSeen = await received(adaClient);
  assert.deepEqual(adaSeen.seen, expected);
  assertDisabled(
    adaSeen.disabled,
    [first, second].map((agent) => ({ workspaceId: workspace.id, agent })),
    at,
    laptop.device.deviceId,
  );
  // The account's other device gets the same events, then the account
  // frames of the sign-in, which the route sends after them.
  const deskSeen = await received(deskClient);
  assert.deepEqual(deskSeen.seen, [
    ...expected,
    "frame:account.device_registered",
    "frame:account.device_revoked",
  ]);
  await settle();
  assert.equal(laptopClient.unread(), 0);
  assert.equal(await disabledAt(kept.id), null);
});

test("a removal and a departure send workspace.agent.disabled for the person's agents in the workspace to the remaining subscribers, after the removal and before the grant and run events, never to the removed person, and nothing when the commit fails", async (t) => {
  const commits = instance(t);
  const { account, clock } = commits;
  const ada = await account(8621);
  const bob = await account(8622);
  const cleo = await account(8623);
  const { workspace, project } = await workspaceWithProject(ada);
  const bobPerson = await addClaimed(workspace.id, bob, ada);
  const cleoPerson = await addClaimed(workspace.id, cleo, ada);
  const { workspace: bobs, project: bobProject } = await workspaceWithProject(
    bob,
    "Own",
  );
  const repositoryId = await repositoryOf(ada, project.id);
  const bobFirst = await agentOn(bob, project.id, "First");
  const bobSecond = await agentOn(bob, project.id, "Second");
  const bobElsewhere = await agentOn(bob, bobProject.id, "Elsewhere");
  const bobGrant = await granted(bob, bobFirst.id, repositoryId);
  const bobRun = await runOf(project.id, bobSecond.id, bob);
  const cleoAgent = await agentOn(cleo, project.id, "Cleo's");
  const cleoGrant = await granted(cleo, cleoAgent.id, repositoryId);
  const adaAgent = await agentOn(ada, project.id, "Ada's");
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  await subscribed(adaClient, workspace.id);
  await subscribed(bobClient, workspace.id);
  await subscribed(bobClient, bobs.id);
  await subscribed(cleoClient, workspace.id);
  const clients = [adaClient, bobClient, cleoClient];
  for (const client of clients) {
    await received(client);
  }
  const removeBob = () =>
    post(ada, `/workspaces/${workspace.id}/members/${bobPerson}/remove`);

  // A removal whose commit fails sends nothing and disables nothing.
  clock.advance(1_000);
  await failed(commits, "people-routes.ts", removeBob);
  for (const client of clients) {
    assert.deepEqual((await received(client)).seen, []);
  }
  assert.equal(await disabledAt(bobFirst.id), null);

  // The owner removes Bob: his agents in this workspace only.
  clock.advance(1_000);
  const removed = await removeBob();
  assert.equal(removed.statusCode, 204, removed.body);
  const at = new Date(clock.now());
  // Bob's agents keep his removed person as their owner, as the agent list
  // shows them.
  const bobAgents = [bobFirst, bobSecond].map((agent) => {
    assert.equal(agent.ownerMemberId, bobPerson);
    return { workspaceId: workspace.id, agent };
  });
  for (const client of [adaClient, cleoClient]) {
    const seen = await received(client);
    assert.deepEqual(seen.seen, [
      "workspace.member.removed",
      ...disabledInOrder(bobFirst.id, bobSecond.id),
      `revoked:${bobGrant.id}`,
      `run:${bobRun}`,
    ]);
    assertDisabled(seen.disabled, bobAgents, at, bob.device.deviceId);
  }
  // The removed person's subscription ended first: no event, also not of
  // his own workspace, whose agent stays enabled.
  assert.deepEqual((await received(bobClient)).seen, [
    "frame:workspace.unsubscribed",
    "frame:account.removed_from_workspace",
  ]);
  assert.equal(await disabledAt(bobElsewhere.id), null);

  // A departure does the same; a departure whose commit fails sends nothing.
  const leave = () => post(cleo, `/workspaces/${workspace.id}/leave`);
  clock.advance(1_000);
  await failed(commits, "people-routes.ts", leave);
  for (const client of [adaClient, cleoClient]) {
    assert.deepEqual((await received(client)).seen, []);
  }
  clock.advance(1_000);
  const left = await leave();
  assert.equal(left.statusCode, 204, left.body);
  const leftAt = new Date(clock.now());
  const adaSeen = await received(adaClient);
  assert.deepEqual(adaSeen.seen, [
    "workspace.member.removed",
    `disabled:${cleoAgent.id}`,
    `revoked:${cleoGrant.id}`,
  ]);
  assert.equal(cleoAgent.ownerMemberId, cleoPerson);
  assertDisabled(
    adaSeen.disabled,
    [{ workspaceId: workspace.id, agent: cleoAgent }],
    leftAt,
    cleo.device.deviceId,
  );
  assert.deepEqual((await received(cleoClient)).seen, [
    "frame:workspace.unsubscribed",
    "frame:account.removed_from_workspace",
  ]);
  assert.equal(await disabledAt(adaAgent.id), null);
});

/** A registry whose every `workspace.agent.disabled` fails to send. */
class FailingAgentEvents extends ConnectionRegistry {
  override sendToWorkspace(
    ...args: Parameters<ConnectionRegistry["sendToWorkspace"]>
  ): number {
    if (args[0].type === "workspace.agent.disabled") {
      throw new Error("the send failed");
    }
    return super.sendToWorkspace(...args);
  }
}

test("a disabled agent's event that fails to send fails neither the committed change nor the events after it, and is logged without its message", async (t) => {
  const logLines: string[] = [];
  const { account } = instance(t, {
    connections: new FailingAgentEvents(),
    logLines,
  });
  const ada = await account(8631);
  const bob = await account(8632);
  const { workspace, project } = await workspaceWithProject(ada);
  const bobPerson = await addClaimed(workspace.id, bob, ada);
  const repositoryId = await repositoryOf(ada, project.id);
  const bobAgent = await agentOn(bob, project.id);
  const bobGrant = await granted(bob, bobAgent.id, repositoryId);
  const bobRun = await runOf(project.id, bobAgent.id, bob);
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  await subscribed(adaClient, workspace.id);
  await received(adaClient);

  await done(ada, `/workspaces/${workspace.id}/members/${bobPerson}/remove`);
  assert.deepEqual((await received(adaClient)).seen, [
    "workspace.member.removed",
    `revoked:${bobGrant.id}`,
    `run:${bobRun}`,
  ]);
  assert.notEqual(await disabledAt(bobAgent.id), null);
  const failures = logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line["msg"] === "workspace event failed");
  assert.deepEqual(
    failures.map((line) => [line["eventType"], line["errorType"]]),
    [["workspace.agent.disabled", "Error"]],
  );
  assert.ok(
    !logLines.some((line) => line.includes("the send failed")),
    "the log never holds the error's message",
  );
});
