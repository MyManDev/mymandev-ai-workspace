import {
  agentRuns,
  agents,
  auditEvents,
  permissionGrants,
  projects,
  repositories,
  workspaceMembers,
} from "@mymandev/database";
import {
  AGENT_COUNT_LIMITS,
  type AgentId,
  AgentListResponseSchema,
  ApiErrorBodySchema,
  CreateAgentResponseSchema,
  CreateProjectResponseSchema,
  CreateWorkspaceResponseSchema,
  decodeEvent,
  decodeServerMessage,
  type MemberId,
  type MemberRole,
  newId,
  type PermissionGrantId,
  type ProjectId,
  type RepositoryId,
  type RunId,
  type RunState,
  SERVER_EVENT_AUDIENCES,
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
import type { WorkspaceEvent } from "./events.ts";

// Creating and disabling an agent (#294): any active member creates an
// agent hosted on the calling device; the agent's owner, from any of its
// devices, the workspace's owner, and admins disable it, which revokes its
// grants and cancels its unfinished runs in the same transaction. Each change
// sends its event to every connection subscribed to the project's workspace,
// after the commit, and a disable sends one run event for each cancelled run.

const database = useTestDatabase();

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const {
  enabledPerProject: ENABLED_PER_PROJECT,
  perProject: PER_PROJECT,
  perDay: PER_DAY,
} = AGENT_COUNT_LIMITS;

type Account = Readonly<{
  app: FastifyInstance;
  device: SignedInDevice;
  token: string;
}>;

/**
 * One API instance: each account signs in through its own app, and every app
 * shares one registry of connections, one clock, and one database, whose
 * next commit can be made to fail. The workspace events that went out are
 * recorded.
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
    events,
    account,
    secondDevice,
    failNextCommit: commits.failNextCommit,
    failedCommits: commits.failedCommits,
  };
}

/** The account with a new access token; one lives 15 minutes. */
async function renewed(account: Account): Promise<Account> {
  return { ...account, token: await accessToken(account.app, account.device) };
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

function create(account: Account, projectId: string, name: string) {
  return post(account, `/projects/${projectId}/agents`, { name });
}

function disable(account: Account, projectId: string, agentId: string) {
  return post(account, `/projects/${projectId}/agents/${agentId}/disable`);
}

async function list(account: Account, projectId: string) {
  const response = await get(account, `/projects/${projectId}/agents`);
  assert.equal(response.statusCode, 200, response.body);
  return AgentListResponseSchema.parse(response.json()).agents;
}

/** Creates an agent that must be created. */
async function created(account: Account, projectId: string, name: string) {
  const response = await create(account, projectId, name);
  assert.equal(response.statusCode, 200, response.body);
  return CreateAgentResponseSchema.parse(response.json()).agent;
}

/** Disables an agent that must be disabled. */
async function disabled(account: Account, projectId: string, agentId: string) {
  const response = await disable(account, projectId, agentId);
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(response.body, "");
}

/** A workspace of the account with one project, created through the API. */
async function workspaceWithProject(owner: Account, name = "Research") {
  const response = await post(owner, "/workspaces", {
    name,
    displayName: "Ada at work",
  });
  assert.equal(response.statusCode, 200, response.body);
  const { workspace } = CreateWorkspaceResponseSchema.parse(response.json());
  return { workspace, project: await projectIn(owner, workspace.id, "App") };
}

async function projectIn(owner: Account, workspaceId: string, name: string) {
  const response = await post(owner, `/workspaces/${workspaceId}/projects`, {
    name,
  });
  assert.equal(response.statusCode, 200, response.body);
  return CreateProjectResponseSchema.parse(response.json()).project;
}

/** Adds the account to the workspace as a claimed person. */
async function addClaimed(
  workspaceId: WorkspaceId,
  account: Account,
  addedBy: Account,
  role: MemberRole = "member",
): Promise<MemberId> {
  const id = newId<MemberId>();
  await database().insert(workspaceMembers).values({
    id,
    workspaceId,
    userId: account.device.userId,
    displayName: "Grace",
    role,
    addedByUserId: addedBy.device.userId,
    claimedAt: new Date(),
  });
  return id;
}

/** Inserts `n` agents of the account directly, created at `createdAt`. */
async function fill(
  projectId: ProjectId,
  by: Account,
  n: number,
  createdAt: Date,
  disabledAt: Date | null = null,
): Promise<AgentId[]> {
  const rows = Array.from({ length: n }, (_, index) => ({
    id: newId<AgentId>(),
    projectId,
    ownerUserId: by.device.userId,
    hostDeviceId: by.device.deviceId,
    name: `Filler ${index}`,
    createdAt,
    disabledAt,
  }));
  await database().insert(agents).values(rows);
  return rows.map((row) => row.id);
}

async function agentRow(id: AgentId) {
  const [row] = await database().select().from(agents).where(eq(agents.id, id));
  assert.ok(row !== undefined);
  return row;
}

function rowsOf(projectId: ProjectId) {
  return database()
    .select()
    .from(agents)
    .where(eq(agents.projectId, projectId));
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

test("a member creates an agent hosted on the calling device, the list shows it, and the creation sends its event from the system after the commit", async (t) => {
  const { account, events, clock } = instance(t);
  const owner = await account(2901);
  const member = await account(2902);
  const { workspace, project } = await workspaceWithProject(owner);
  const memberPerson = await addClaimed(workspace.id, member, owner);
  events.length = 0;

  const agent = await created(member, project.id, "Reviewer");
  assert.deepEqual(agent, {
    id: agent.id,
    projectId: project.id,
    name: "Reviewer",
    ownerMemberId: memberPerson,
    disabledAt: null,
  });
  // The calling device hosts it, and the caller's account owns it.
  const row = await agentRow(agent.id);
  assert.equal(row.hostDeviceId, member.device.deviceId);
  assert.equal(row.ownerUserId, member.device.userId);
  assert.deepEqual(row.createdAt, new Date(clock.now()));
  assert.deepEqual(await list(owner, project.id), [agent]);

  assert.deepEqual(
    events.map((event) => [event.type, event.payload]),
    [["workspace.agent.created", { agent }]],
  );
  for (const event of events) {
    assert.ok(decodeEvent(event).ok, event.type);
    assert.equal(event.workspaceId, workspace.id);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    assert.equal(event.occurredAt, new Date(clock.now()).toISOString());
    assert.ok(Object.isFrozen(event.payload));
    // The event never names the host device.
    assert.equal(JSON.stringify(event).includes(member.device.deviceId), false);
  }

  // Creating an agent is not an administrative action of ADR 0014.
  const audited = await database()
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspace.id));
  assert.deepEqual(
    audited.map((record) => record.action),
    ["workspace.created"],
  );
});

test("a creation takes the name only: a host device, an owner, or a provider kind beside it is dropped, and a malformed name answers 400", async (t) => {
  const { account, events } = instance(t);
  const owner = await account(2911);
  const other = await account(2912);
  const { workspace, project } = await workspaceWithProject(owner);
  await addClaimed(workspace.id, other, owner);
  events.length = 0;

  const response = await post(owner, `/projects/${project.id}/agents`, {
    name: "Reviewer",
    hostDeviceId: other.device.deviceId,
    ownerUserId: other.device.userId,
    projectId: newId<ProjectId>(),
    kind: "claude",
  });
  assert.equal(response.statusCode, 200, response.body);
  const { agent } = CreateAgentResponseSchema.parse(response.json());
  const row = await agentRow(agent.id);
  assert.equal(row.hostDeviceId, owner.device.deviceId);
  assert.equal(row.ownerUserId, owner.device.userId);
  assert.equal(row.projectId, project.id);

  // A name is a label, stored as sent, also a second time.
  const spaced = await created(owner, project.id, "  Reviewer  ");
  assert.equal(spaced.name, "  Reviewer  ");
  const twice = await created(owner, project.id, "Reviewer");
  assert.notEqual(twice.id, agent.id);

  for (const payload of [
    {},
    { name: "" },
    { name: " " },
    { name: "a".repeat(65) },
    { name: "Re\nviewer" },
    { name: "Re\u200Bviewer" },
    { name: 7 },
  ]) {
    const refused = await post(
      owner,
      `/projects/${project.id}/agents`,
      payload,
    );
    assert.equal(refused.statusCode, 400, JSON.stringify(payload));
    assert.equal(errorCode(refused), "bad_request");
  }
  assert.equal((await rowsOf(project.id)).length, 3);
  assert.equal(events.length, 3);
});

test(`a project with ${ENABLED_PER_PROJECT} enabled agents answers 409 with agent_limit and no Retry-After, and a disable frees a place`, async (t) => {
  const { account, events } = instance(t);
  const owner = await account(2921);
  const { project } = await workspaceWithProject(owner);
  const ids = await fill(
    project.id,
    owner,
    ENABLED_PER_PROJECT,
    new Date(Date.now() - 2 * DAY_MS),
  );
  events.length = 0;

  // Its own code, not `rate_limited`: waiting does not help.
  const refused = await create(owner, project.id, "One more");
  assert.equal(refused.statusCode, 409, refused.body);
  assert.deepEqual(refused.json(), {
    statusCode: 409,
    error: "Conflict",
    message: "Conflict",
    code: "agent_limit",
  });
  assert.equal(ApiErrorBodySchema.safeParse(refused.json()).success, true);
  assert.equal(refused.headers["retry-after"], undefined);
  assert.deepEqual([...events], [], "a refusal sends no event");

  const [first] = ids;
  assert.ok(first !== undefined);
  await disabled(owner, project.id, first);
  await created(owner, project.id, "One more");
  assert.equal((await rowsOf(project.id)).length, ENABLED_PER_PROJECT + 1);
});

test(`a project with ${PER_PROJECT} agents, disabled ones included, answers 409 with agent_limit`, async (t) => {
  const { account } = instance(t);
  const owner = await account(2931);
  const { project } = await workspaceWithProject(owner);
  const longAgo = new Date(Date.now() - 2 * DAY_MS);
  await fill(project.id, owner, PER_PROJECT, longAgo, longAgo);
  const refused = await create(owner, project.id, "One more");
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(errorCode(refused), "agent_limit");
  assert.equal(refused.headers["retry-after"], undefined);
  assert.equal((await list(owner, project.id)).length, PER_PROJECT);
});

test(`an account's creation beyond ${PER_DAY} agents within 24 hours answers 429 with Retry-After, and the window slides`, async (t) => {
  const { account, clock } = instance(t);
  let owner = await account(2941);
  const { workspace, project: first } = await workspaceWithProject(owner);
  const second = await projectIn(owner, workspace.id, "Website");
  const oldest = await created(owner, first.id, "Agent 0");
  clock.advance(HOUR_MS);
  owner = await renewed(owner);
  // A disabled agent counts too.
  await disabled(owner, first.id, oldest.id);
  await fill(second.id, owner, PER_DAY - 1, new Date(clock.now()));

  const refused = await create(owner, first.id, "One more");
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(errorCode(refused), "rate_limited");
  // The first agent leaves the window 23 hours from now.
  assert.equal(
    refused.headers["retry-after"],
    String((DAY_MS - HOUR_MS) / 1000),
  );

  clock.advance(DAY_MS - HOUR_MS);
  owner = await renewed(owner);
  await created(owner, first.id, "One more");
  const next = await create(owner, first.id, "And another");
  assert.equal(next.statusCode, 429);
});

test("the agent's owner, from any of its devices, the workspace's owner, and an admin disable an agent; another member gets 403, and an unknown agent or one of another project the same 404", async (t) => {
  const { account, secondDevice, events, clock } = instance(t);
  const owner = await account(2951);
  const alice = await account(2952);
  const bob = await account(2953);
  const admin = await account(2954);
  const { workspace, project } = await workspaceWithProject(owner);
  const alicePerson = await addClaimed(workspace.id, alice, owner);
  await addClaimed(workspace.id, bob, owner);
  await addClaimed(workspace.id, admin, owner, "admin");
  const elsewhere = await projectIn(owner, workspace.id, "Website");
  const a1 = await created(alice, project.id, "A1");
  const a2 = await created(alice, project.id, "A2");
  const a3 = await created(alice, project.id, "A3");
  const inOther = await created(alice, elsewhere.id, "A4");
  events.length = 0;

  const forbidden = await disable(bob, project.id, a1.id);
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.equal(errorCode(forbidden), "forbidden");
  for (const [id, label] of [
    [newId<AgentId>(), "unknown"],
    [inOther.id, "of another project"],
  ] as const) {
    for (const who of [owner, bob]) {
      const response = await disable(who, project.id, id);
      assert.equal(response.statusCode, 404, label);
      assert.deepEqual(response.json(), NOT_FOUND, label);
    }
  }
  assert.deepEqual([...events], [], "a refusal sends no event");

  // Alice disables from her second device, which does not host the agent.
  const aliceElsewhere = await secondDevice(alice);
  await disabled(aliceElsewhere, project.id, a1.id);
  await disabled(owner, project.id, a2.id);
  await disabled(admin, project.id, a3.id);
  const at = new Date(clock.now()).toISOString();
  const expected = [a1, a2, a3].map((agent) => ({
    ...agent,
    ownerMemberId: alicePerson,
    disabledAt: at,
  }));
  assert.deepEqual(
    events.map((event) => [event.type, event.payload]),
    expected.map((agent) => ["workspace.agent.disabled", { agent }]),
  );
  for (const event of events) {
    assert.ok(decodeEvent(event).ok, event.type);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    assert.equal(event.occurredAt, at);
  }
  assert.deepEqual(await list(bob, project.id), expected);

  // Disabling is final: a second disable answers 409 and sends nothing.
  const again = await disable(alice, project.id, a1.id);
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(errorCode(again), "conflict");
  assert.equal(events.length, 3);
});

/** A run of the agent in `state`, written directly. */
async function runOf(
  projectId: ProjectId,
  agentId: AgentId,
  by: Account,
  state: RunState,
): Promise<RunId> {
  const id = newId<RunId>();
  const finished =
    state === "completed" || state === "failed" || state === "cancelled";
  await database()
    .insert(agentRuns)
    .values({
      id,
      agentId,
      projectId,
      requestedByUserId: by.device.userId,
      state,
      ...(finished ? { finishedAt: new Date() } : {}),
    });
  return id;
}

test("a disable revokes the agent's grants, cancels its unfinished runs with agent_disabled, and every subscribed member receives the disabled agent and each cancelled run", async (t) => {
  const { account, events, clock } = instance(t);
  const ada = await account(2961);
  const bob = await account(2962);
  const cleo = await account(2963);
  const dan = await account(2964);
  const { workspace, project } = await workspaceWithProject(ada);
  await addClaimed(workspace.id, bob, ada);
  await addClaimed(workspace.id, dan, ada);
  // Cleo owns another workspace and is no member of Ada's.
  const { workspace: other } = await workspaceWithProject(cleo, "Elsewhere");
  const agent = await created(bob, project.id, "Builder");
  const kept = await created(bob, project.id, "Kept");
  const repositoryId = newId<RepositoryId>();
  await database().insert(repositories).values({
    id: repositoryId,
    projectId: project.id,
    name: "web",
    createdByUserId: bob.device.userId,
  });
  const grant = async (agentId: AgentId) => {
    const id = newId<PermissionGrantId>();
    await database()
      .insert(permissionGrants)
      .values({
        id,
        projectId: project.id,
        granteeAgentId: agentId,
        hostDeviceId: bob.device.deviceId,
        capability: "repo.read",
        repositoryId,
        grantedByUserId: bob.device.userId,
        createdAt: new Date(clock.now() - HOUR_MS),
      });
    return id;
  };
  const granted = await grant(agent.id);
  const keptGrant = await grant(kept.id);
  const queued = await runOf(project.id, agent.id, bob, "queued");
  const running = await runOf(project.id, agent.id, bob, "running");
  const completed = await runOf(project.id, agent.id, bob, "completed");
  const keptRun = await runOf(project.id, kept.id, bob, "running");

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
  events.length = 0;

  // The workspace's owner disables Bob's agent.
  await disabled(ada, project.id, agent.id);
  const at = new Date(clock.now());
  const [grantRow] = await database()
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, granted));
  assert.deepEqual(grantRow?.revokedAt, at);
  assert.equal(grantRow?.revokedByUserId, ada.device.userId);
  const [keptGrantRow] = await database()
    .select()
    .from(permissionGrants)
    .where(eq(permissionGrants.id, keptGrant));
  assert.equal(keptGrantRow?.revokedAt, null);
  const runState = async (id: RunId) => {
    const [row] = await database()
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, id));
    assert.ok(row !== undefined);
    return [row.state, row.stateReason];
  };
  assert.deepEqual(await runState(queued), ["cancelled", "agent_disabled"]);
  assert.deepEqual(await runState(running), ["cancelled", "agent_disabled"]);
  assert.equal((await runState(completed))[0], "completed");
  assert.equal((await runState(keptRun))[0], "running");

  const cancelled = new Map([
    [queued, "queued"],
    [running, "running"],
  ]);
  // The owner of the workspace and the agent's owner alike, whatever role:
  // first the disabled agent, then one run event for each cancelled run.
  for (const client of [adaClient, bobClient]) {
    const first = await nextEvent(client);
    assert.ok(first.type === "workspace.agent.disabled", first.type);
    assert.equal(first.workspaceId, workspace.id);
    assert.deepEqual(first.actor, { kind: "system" });
    assert.equal(first.deviceId, null);
    assert.deepEqual(first.payload, {
      agent: { ...agent, disabledAt: at.toISOString() },
    });
    const seen = new Map<string, string | null>();
    for (let n = 0; n < cancelled.size; n += 1) {
      const event = await nextEvent(client);
      assert.ok(event.type === "agent.run.state_changed", event.type);
      assert.equal(event.workspaceId, workspace.id);
      assert.deepEqual(event.actor, { kind: "system" });
      assert.equal(event.deviceId, null);
      assert.equal(event.payload.agentId, agent.id);
      assert.equal(event.payload.state, "cancelled");
      assert.equal(event.payload.reason, "agent_disabled");
      seen.set(event.payload.runId, event.payload.previousState);
    }
    assert.deepEqual(seen, cancelled);
  }
  // Cleo, of another workspace, and Dan, not subscribed, receive nothing.
  await quiet(...everyone);
  assert.deepEqual(
    events.map((event) => event.type),
    ["workspace.agent.disabled"],
  );
  assert.equal(SERVER_EVENT_AUDIENCES["workspace.agent.disabled"], "members");
  assert.equal(SERVER_EVENT_AUDIENCES["workspace.agent.created"], "members");

  // A creation reaches every subscribed member too, and no one else.
  const made = await created(bob, project.id, "Again");
  for (const client of [adaClient, bobClient]) {
    const event = await nextEvent(client);
    assert.ok(event.type === "workspace.agent.created", event.type);
    assert.deepEqual(event.payload, { agent: made });
  }
  await quiet(...everyone);
});

test("an archived project answers 409 to a creation and to a disable, and still lists its agents", async (t) => {
  const { account, events } = instance(t);
  const owner = await account(2971);
  const { project } = await workspaceWithProject(owner);
  const agent = await created(owner, project.id, "Reviewer");
  await database()
    .update(projects)
    .set({ archivedAt: new Date() })
    .where(eq(projects.id, project.id));
  events.length = 0;
  for (const response of [
    await create(owner, project.id, "Website"),
    await disable(owner, project.id, agent.id),
  ]) {
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(errorCode(response), "conflict");
  }
  assert.deepEqual([...events], []);
  assert.deepEqual(await list(owner, project.id), [agent]);
});

test("a non-member gets the 404 of an unknown project on both agent routes, and so do a removed member and a malformed project ID", async (t) => {
  const { account, events } = instance(t);
  const owner = await account(2981);
  const former = await account(2982);
  const outsider = await account(2983);
  const { workspace, project } = await workspaceWithProject(owner);
  const person = await addClaimed(workspace.id, former, owner);
  const agent = await created(former, project.id, "Reviewer");
  await database()
    .update(workspaceMembers)
    .set({ removedAt: new Date(), removedByUserId: owner.device.userId })
    .where(eq(workspaceMembers.id, person));
  events.length = 0;

  const unknownId = newId<ProjectId>();
  for (const who of [former, outsider]) {
    for (const ask of [
      (id: string) => create(who, id, "Mine"),
      (id: string) => disable(who, id, agent.id),
      // The check comes before validation: a malformed body or agent ID
      // answers the same 404.
      (id: string) => post(who, `/projects/${id}/agents`, {}),
      (id: string) => disable(who, id, "not-an-id"),
    ]) {
      const refused = await ask(project.id);
      const unknown = await ask(unknownId);
      const malformed = await ask("not-an-id");
      assert.equal(refused.statusCode, 404);
      assert.deepEqual(refused.json(), NOT_FOUND);
      assert.equal(refused.body, unknown.body);
      assert.equal(refused.body, malformed.body);
    }
  }
  assert.deepEqual([...events], []);
  assert.equal((await agentRow(agent.id)).disabledAt, null);
});

test("a refused or rolled-back change sends no agent event and changes nothing, and the same change sends one once it commits", async (t) => {
  const { account, events, failNextCommit, failedCommits } = instance(t);
  const ada = await account(2991);
  const bob = await account(2992);
  const { workspace, project } = await workspaceWithProject(ada);
  await addClaimed(workspace.id, bob, ada);
  const agent = await created(ada, project.id, "Reviewer");
  const run = await runOf(project.id, agent.id, ada, "running");
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  await subscribed(adaClient, workspace.id);
  await subscribed(bobClient, workspace.id);
  await drainPresence(adaClient, bobClient);
  events.length = 0;
  const before = await rowsOf(project.id);

  for (const [response, status] of [
    [await disable(bob, project.id, agent.id), 403],
    [await disable(ada, project.id, newId<AgentId>()), 404],
    [await create(bob, project.id, ""), 400],
  ] as const) {
    assert.equal(response.statusCode, status, response.body);
  }
  await quiet(adaClient, bobClient);

  const rolledBack = [
    () => create(bob, project.id, "Builder"),
    () => disable(ada, project.id, agent.id),
  ];
  for (const change of rolledBack) {
    failNextCommit();
    const response = await change();
    assert.equal(response.statusCode, 500, response.body);
  }
  assert.deepEqual(
    failedCommits(),
    Array(rolledBack.length).fill("agent-routes.ts"),
  );
  assert.deepEqual(await rowsOf(project.id), before);
  const [runRow] = await database()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, run));
  assert.equal(runRow?.state, "running");
  await quiet(adaClient, bobClient);
  assert.deepEqual([...events], []);

  const builder = await created(bob, project.id, "Builder");
  await disabled(ada, project.id, agent.id);
  for (const client of [adaClient, bobClient]) {
    const first = await nextEvent(client);
    assert.ok(first.type === "workspace.agent.created", first.type);
    assert.deepEqual(first.payload, { agent: builder });
    const second = await nextEvent(client);
    assert.ok(second.type === "workspace.agent.disabled", second.type);
    assert.equal(second.payload.agent.id, agent.id);
    const third = await nextEvent(client);
    assert.ok(third.type === "agent.run.state_changed", third.type);
    assert.equal(third.payload.runId, run);
    assert.equal(third.payload.reason, "agent_disabled");
  }
});

test("the agent routes need a valid access token", async (t) => {
  const { account } = instance(t);
  const owner = await account(2999);
  const { project } = await workspaceWithProject(owner);
  const agent = await created(owner, project.id, "Reviewer");
  for (const [url, payload] of [
    [`/projects/${project.id}/agents`, { name: "Builder" }],
    [`/projects/${project.id}/agents/${agent.id}/disable`, undefined],
  ] as const) {
    for (const headers of [{}, { authorization: "Bearer not-a-token" }]) {
      const response = await owner.app.inject({
        method: "POST",
        url,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      assert.equal(response.statusCode, 401, url);
      assert.equal(errorCode(response), "unauthorized");
    }
  }
  assert.deepEqual(await list(owner, project.id), [agent]);
});
