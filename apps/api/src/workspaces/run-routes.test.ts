import {
  agentRuns,
  agents,
  createProject,
  type Database,
  devices,
  MAX_NEW_RUNS_PER_AGENT_PER_DAY,
  MAX_UNFINISHED_RUNS_PER_AGENT,
  postChatMessage,
  projects,
  providerConnections,
  removeMember,
  repositories,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  type AgentId,
  AgentRunListResponseSchema,
  ApiErrorBodySchema,
  CreateRunResponseSchema,
  decodeServerMessage,
  type DeviceId,
  type EventId,
  type MemberId,
  type MemberRole,
  type MessageId,
  newId,
  type ProjectId,
  type ProviderConnectionId,
  type RepositoryId,
  RUN_ROUTE_ERRORS,
  type RunId,
  type ServerEvent,
  SERVER_EVENT_AUDIENCES,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  accessToken,
  deviceApp,
  failingCommits,
  type FakeClock,
  fakeClock,
  type SignedInDevice,
  signInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";
import { ConnectionRegistry } from "../gateway.ts";
import {
  type Client,
  connected,
  interceptingDatabase,
  nextFrame,
  settle,
} from "../gateway-test-support.ts";

const database = useTestDatabase();

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

type Account = Readonly<{
  app: FastifyInstance;
  device: SignedInDevice;
  token: string;
}>;

/**
 * One API instance: each account signs in through its own app (the fake
 * GitHub of an app knows one account), and every app shares one registry
 * of connections, one database, and one clock, as one API process does.
 */
async function instance(
  t: TestContext,
  options: Readonly<{ clock?: FakeClock; through?: Database }> = {},
) {
  const connections = new ConnectionRegistry();
  const account = async (githubId: number): Promise<Account> => {
    const app = await deviceApp(t, {
      database: options.through ?? database(),
      githubId,
      connections,
      ...(options.clock === undefined ? {} : { now: options.clock.now }),
    });
    // injectWS never settles unless the app is ready.
    await app.ready();
    const device = await signInDevice(app);
    return { app, device, token: await accessToken(app, device) };
  };
  return { connections, account };
}

/** The account with a fresh access token, which lives 15 minutes. */
async function refreshed(account: Account): Promise<Account> {
  return { ...account, token: await accessToken(account.app, account.device) };
}

/** A workspace that `owner` owns, with `members` as claimed members, written directly. */
async function workspaceOf(
  owner: SignedInDevice,
  members: readonly SignedInDevice[] = [],
): Promise<WorkspaceId> {
  const workspaceId = newId<WorkspaceId>();
  await database()
    .insert(workspaces)
    .values({ id: workspaceId, name: "Team", createdByUserId: owner.userId });
  const person = async (userId: UserId, role: MemberRole) => {
    await database()
      .insert(workspaceMembers)
      .values({
        id: newId<MemberId>(),
        workspaceId,
        userId,
        displayName: role === "owner" ? "Ada" : "Bob",
        role,
        addedByUserId: owner.userId,
        claimedAt: new Date(),
      });
  };
  await person(owner.userId, "owner");
  for (const member of members) {
    await person(member.userId, "member");
  }
  return workspaceId;
}

/** A project of the workspace, as `POST .../projects` creates it. */
async function projectIn(
  workspaceId: WorkspaceId,
  creator: SignedInDevice,
  name = "App",
): Promise<ProjectId> {
  const result = await createProject(database(), {
    workspaceId,
    userId: creator.userId,
    name,
    now: new Date(),
  });
  assert.ok(result.created, JSON.stringify(result));
  return result.project.id;
}

/**
 * An agent of the project, owned by the device's account and hosted on the
 * device, written directly as the development seed writes it: no route
 * creates agents yet.
 */
async function agentOf(
  projectId: ProjectId,
  host: SignedInDevice,
): Promise<AgentId> {
  const agentId = newId<AgentId>();
  await database()
    .insert(agents)
    .values({
      id: agentId,
      projectId,
      ownerUserId: host.userId,
      hostDeviceId: host.deviceId as DeviceId,
      name: "Builder",
    });
  return agentId;
}

/** A provider connection of the device, written directly: no route registers one yet. */
async function connectionOf(
  device: SignedInDevice,
): Promise<ProviderConnectionId> {
  const id = newId<ProviderConnectionId>();
  await database()
    .insert(providerConnections)
    .values({
      id,
      hostDeviceId: device.deviceId as DeviceId,
      kind: "claude",
      label: "Work",
    });
  return id;
}

/** A repository of the project, written directly. */
async function repositoryIn(
  projectId: ProjectId,
  by: SignedInDevice,
): Promise<RepositoryId> {
  const id = newId<RepositoryId>();
  await database()
    .insert(repositories)
    .values({ id, projectId, name: "web", createdByUserId: by.userId });
  return id;
}

/** A message that the device's account posted to the project's chat. */
async function messageIn(
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  by: SignedInDevice,
): Promise<MessageId> {
  const result = await postChatMessage(database(), {
    actor: {
      workspaceId,
      userId: by.userId,
      deviceId: by.deviceId as DeviceId,
    },
    projectId,
    eventId: newId<EventId>(),
    body: "Add a health check",
    now: new Date(),
  });
  assert.ok(result.posted, JSON.stringify(result));
  return result.message.id;
}

/**
 * Ada owns a workspace that Bob is a member of, with a project, an agent
 * of Ada's hosted on her device, a provider connection of that device, and
 * a message of Ada's in the project's chat: everything a run needs.
 */
async function team(
  t: TestContext,
  ids: readonly [ada: number, bob: number],
  options: Readonly<{ clock?: FakeClock; through?: Database }> = {},
) {
  const { account, connections } = await instance(t, options);
  const ada = await account(ids[0]);
  const bob = await account(ids[1]);
  const workspaceId = await workspaceOf(ada.device, [bob.device]);
  const projectId = await projectIn(workspaceId, ada.device);
  const agentId = await agentOf(projectId, ada.device);
  const providerConnectionId = await connectionOf(ada.device);
  const inputMessageId = await messageIn(workspaceId, projectId, ada.device);
  const body = { agentId, providerConnectionId, inputMessageId };
  return {
    account,
    connections,
    ada,
    bob,
    workspaceId,
    projectId,
    agentId,
    providerConnectionId,
    inputMessageId,
    body,
  };
}

function post(account: Account, projectId: string, payload?: object) {
  return account.app.inject({
    method: "POST",
    url: `/projects/${projectId}/runs`,
    headers: { authorization: `Bearer ${account.token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

type Answer = Awaited<ReturnType<typeof post>>;

function errorCode(response: Answer): string {
  const body = ApiErrorBodySchema.parse(response.json());
  assert.equal(body.statusCode, response.statusCode);
  // The route answers only the codes that the protocol lists for it.
  assert.ok(
    RUN_ROUTE_ERRORS.createRun.includes(body.code),
    `${body.code} is not a code of the route`,
  );
  return body.code;
}

/** The run of a creation that must have succeeded. */
function createdRun(response: Answer) {
  assert.equal(response.statusCode, 200, response.body);
  return CreateRunResponseSchema.parse(response.json()).run;
}

async function runs(account: Account, projectId: string) {
  const response = await account.app.inject({
    method: "GET",
    url: `/projects/${projectId}/runs`,
    headers: { authorization: `Bearer ${account.token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  return AgentRunListResponseSchema.parse(response.json());
}

async function runCount(agentId: AgentId): Promise<number> {
  const [row] = await database()
    .select({ n: count() })
    .from(agentRuns)
    .where(eq(agentRuns.agentId, agentId));
  return row?.n ?? 0;
}

/** Subscribes the connection and drops the frames of the subscription. */
async function subscribed(client: Client, workspaceId: WorkspaceId) {
  client.send({ protocolVersion: 0, type: "workspace.subscribe", workspaceId });
  const frame = await nextFrame(client);
  assert.ok(
    frame.type === "workspace.subscribed" && frame.workspaceId === workspaceId,
    JSON.stringify(frame),
  );
}

/** Reads and drops what arrived, such as the presence of a later subscriber. */
async function drained(...clients: Client[]) {
  await settle();
  for (const client of clients) {
    while (client.unread() > 0) {
      await client.next();
    }
  }
}

/** Lets pending frames arrive, then checks that none is left unread. */
async function quiet(...clients: Client[]) {
  await settle();
  for (const client of clients) {
    assert.equal(client.unread(), 0);
  }
}

/** The next message as it arrived and as the device's decoder reads it. */
async function nextEvent(
  client: Client,
): Promise<Readonly<{ raw: string; event: ServerEvent }>> {
  const message = await client.next();
  const decoded = decodeServerMessage(message);
  assert.ok(decoded.ok && decoded.kind === "event", JSON.stringify(decoded));
  return { raw: JSON.stringify(message), event: decoded.event };
}

/** `count` runs of the agent written directly, each `stepMs` after `from`. */
async function seedRuns(
  agentId: AgentId,
  projectId: ProjectId,
  by: SignedInDevice,
  options: Readonly<{
    count: number;
    finished: boolean;
    from: number;
    stepMs?: number;
  }>,
) {
  await database()
    .insert(agentRuns)
    .values(
      Array.from({ length: options.count }, (_, index) => {
        const createdAt = new Date(
          options.from + index * (options.stepMs ?? 1),
        );
        return {
          id: newId<RunId>(),
          agentId,
          projectId,
          requestedByUserId: by.userId,
          state: options.finished
            ? ("completed" as const)
            : ("queued" as const),
          createdAt,
          finishedAt: options.finished ? createdAt : null,
        };
      }),
    );
}

test("the owner of an agent creates a run: the answer is the queued run, and the workspace's subscribers get it from the system after the commit, without its provider connection", async (t) => {
  const clock = fakeClock();
  const { ada, bob, workspaceId, projectId, agentId, body } = await team(
    t,
    [4101, 4102],
    { clock },
  );
  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(adaConnection.client, workspaceId);
  await subscribed(bobConnection.client, workspaceId);
  await drained(adaConnection.client, bobConnection.client);

  const run = createdRun(await post(ada, projectId, body));
  const createdAt = new Date(clock.now()).toISOString();
  assert.deepEqual(run, {
    id: run.id,
    agentId,
    projectId,
    repositoryId: null,
    state: "queued",
    reason: null,
    createdAt,
    finishedAt: null,
    inputMessageId: body.inputMessageId,
    providerConnectionId: body.providerConnectionId,
  });
  const [row] = await database()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, run.id));
  assert.equal(row?.requestedByUserId, ada.device.userId);
  assert.equal(row?.hostDeviceId, ada.device.deviceId);
  assert.equal(row?.providerConnectionId, body.providerConnectionId);
  assert.equal(row?.inputMessageId, body.inputMessageId);

  // Every subscriber gets the same event: the asking account's connection
  // and the other member's.
  for (const client of [adaConnection.client, bobConnection.client]) {
    const { raw, event } = await nextEvent(client);
    assert.deepEqual(event, {
      protocolVersion: 0,
      id: event.id,
      type: "agent.run.state_changed",
      occurredAt: createdAt,
      workspaceId,
      actor: { kind: "system" },
      deviceId: null,
      payload: {
        runId: run.id,
        agentId,
        previousState: null,
        state: "queued",
        run: {
          id: run.id,
          agentId,
          projectId,
          repositoryId: null,
          state: "queued",
          reason: null,
          createdAt,
          finishedAt: null,
          inputMessageId: body.inputMessageId,
        },
      },
    });
    // Device data never reaches the members: neither the provider
    // connection nor the host device, nor the asking account.
    assert.equal(raw.includes(body.providerConnectionId), false);
    assert.equal(raw.includes(ada.device.deviceId), false);
    assert.equal(raw.includes(ada.device.userId), false);
  }
  await quiet(adaConnection.client, bobConnection.client);
  assert.equal(SERVER_EVENT_AUDIENCES["agent.run.state_changed"], "members");
});

test("the event of a new run goes to the workspace's subscribers and to no one else: not to an unsubscribed connection, a subscriber of another workspace, or a non-member", async (t) => {
  const { account, ada, bob, workspaceId, projectId, body } = await team(
    t,
    [4111, 4112],
  );
  const cleo = await account(4113);
  const elsewhere = await workspaceOf(cleo.device, [bob.device]);
  // Ada's second device is connected, but not subscribed.
  const adasDesktop = await signInDevice(ada.app);
  const unsubscribed = await connected(t, ada.app, adasDesktop);
  // Bob has one connection in each workspace.
  const inTeam = await connected(t, bob.app, bob.device);
  await subscribed(inTeam.client, workspaceId);
  const bobsDesktop = await signInDevice(bob.app);
  const inOther = await connected(t, bob.app, bobsDesktop);
  await subscribed(inOther.client, elsewhere);
  // Cleo is not a member of Ada's workspace.
  const stranger = await connected(t, cleo.app, cleo.device);
  await subscribed(stranger.client, elsewhere);
  const all = [
    unsubscribed.client,
    inTeam.client,
    inOther.client,
    stranger.client,
  ];
  await drained(...all);

  const run = createdRun(await post(ada, projectId, body));
  const { event } = await nextEvent(inTeam.client);
  assert.ok(event.type === "agent.run.state_changed", event.type);
  assert.equal(event.workspaceId, workspaceId);
  assert.equal(event.payload.runId, run.id);
  await quiet(...all);
});

test("a run with a repository names it in the answer and in the event, and the run list shows the provider connection only to the account that owns the agent", async (t) => {
  const { ada, bob, workspaceId, projectId, body } = await team(
    t,
    [4121, 4122],
  );
  const repositoryId = await repositoryIn(projectId, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(bobConnection.client, workspaceId);

  const run = createdRun(await post(ada, projectId, { ...body, repositoryId }));
  assert.equal(run.repositoryId, repositoryId);
  const { event } = await nextEvent(bobConnection.client);
  assert.ok(event.type === "agent.run.state_changed", event.type);
  assert.equal(event.payload.repositoryId, repositoryId);
  assert.equal(event.payload.run?.repositoryId, repositoryId);

  const { providerConnectionId, ...forMembers } = run;
  assert.equal(providerConnectionId, body.providerConnectionId);
  // The event's run is the run that every member reads in the list.
  assert.deepEqual(event.payload.run, forMembers);
  assert.deepEqual(await runs(bob, projectId), {
    unfinishedRuns: [forMembers],
    finishedRuns: [],
  });
  // The owner reads the provider connection, on any of their devices.
  assert.deepEqual(await runs(ada, projectId), {
    unfinishedRuns: [run],
    finishedRuns: [],
  });
  const adasDesktop = await signInDevice(ada.app);
  const fromDesktop: Account = {
    app: ada.app,
    device: adasDesktop,
    token: await accessToken(ada.app, adasDesktop),
  };
  assert.deepEqual(await runs(fromDesktop, projectId), {
    unfinishedRuns: [run],
    finishedRuns: [],
  });
});

test("only the agent's host device asks: another device of the owner is 403, whatever else the body names, and nothing is created or sent", async (t) => {
  const { ada, workspaceId, projectId, agentId, body } = await team(
    t,
    [4131, 4132],
  );
  // A new device of Ada's, as one that a taken-over GitHub account
  // registers, asks with the IDs of the agent's host device.
  const adasDesktop = await signInDevice(ada.app);
  const fromDesktop: Account = {
    app: ada.app,
    device: adasDesktop,
    token: await accessToken(ada.app, adasDesktop),
  };
  const adaConnection = await connected(t, ada.app, ada.device);
  await subscribed(adaConnection.client, workspaceId);
  const refused = await post(fromDesktop, projectId, body);
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(errorCode(refused), "forbidden");
  // With its own connection, or with IDs that do not exist, the answer is
  // the same: the device learns nothing about them.
  const answers = [
    await post(fromDesktop, projectId, {
      ...body,
      providerConnectionId: await connectionOf(adasDesktop),
    }),
    await post(fromDesktop, projectId, {
      agentId,
      providerConnectionId: newId<ProviderConnectionId>(),
      inputMessageId: newId<MessageId>(),
      repositoryId: newId<RepositoryId>(),
    }),
  ];
  for (const answer of answers) {
    assert.equal(answer.statusCode, 403, answer.body);
    assert.equal(answer.body, refused.body);
  }
  assert.equal(await runCount(agentId), 0);
  await quiet(adaConnection.client);
  // The agent's host device asks with the same body.
  createdRun(await post(ada, projectId, body));
  assert.equal(await runCount(agentId), 1);
});

test("only a message that the caller wrote is the input: another member's is the same 404 as an unknown one, and nothing is created or sent", async (t) => {
  const { ada, bob, workspaceId, projectId, agentId, body } = await team(
    t,
    [4133, 4134],
  );
  const adaConnection = await connected(t, ada.app, ada.device);
  await subscribed(adaConnection.client, workspaceId);
  const bobsMessage = await messageIn(workspaceId, projectId, bob.device);
  const refused = await post(ada, projectId, {
    ...body,
    inputMessageId: bobsMessage,
  });
  assert.equal(refused.statusCode, 404, refused.body);
  assert.equal(errorCode(refused), "not_found");
  const unknown = await post(ada, projectId, {
    ...body,
    inputMessageId: newId<MessageId>(),
  });
  assert.equal(refused.body, unknown.body);
  assert.equal(await runCount(agentId), 0);
  await quiet(adaConnection.client);
  // Bob's message is the input of a run of Bob's own agent.
  const run = createdRun(
    await post(bob, projectId, {
      agentId: await agentOf(projectId, bob.device),
      providerConnectionId: await connectionOf(bob.device),
      inputMessageId: bobsMessage,
    }),
  );
  assert.equal(run.inputMessageId, bobsMessage);
});

test("a request without a token is 401, and a non-member, a removed member, and an unknown or malformed project get the same 404 before the body is read", async (t) => {
  const { account, ada, bob, workspaceId, projectId, agentId, body } =
    await team(t, [4141, 4142]);
  const cleo = await account(4143);
  const noToken = await ada.app.inject({
    method: "POST",
    url: `/projects/${projectId}/runs`,
    payload: body,
  });
  assert.equal(noToken.statusCode, 401, noToken.body);

  const notFound = { statusCode: 404, code: "not_found" };
  const answers = [
    // A non-member, with a valid and with a malformed body.
    await post(cleo, projectId, body),
    await post(cleo, projectId, { agentId: "none" }),
    // An unknown and a malformed project, for a member.
    await post(ada, newId<ProjectId>(), body),
    await post(ada, "not-a-project", body),
    await post(ada, projectId.toUpperCase(), body),
  ];
  // A removed member.
  const [person] = await database()
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, bob.device.userId));
  assert.ok(person !== undefined);
  const removed = await removeMember(database(), {
    workspaceId,
    userId: ada.device.userId,
    deviceId: ada.device.deviceId as DeviceId,
    memberId: person.id,
    now: new Date(),
  });
  assert.ok(removed.removed, JSON.stringify(removed));
  answers.push(await post(bob, projectId, body));
  for (const answer of answers) {
    assert.deepEqual(
      { statusCode: answer.statusCode, code: errorCode(answer) },
      notFound,
      answer.body,
    );
  }
  assert.equal(await runCount(agentId), 0);
});

test("a malformed body is 400, and nothing is created or sent", async (t) => {
  const { ada, workspaceId, projectId, agentId, body } = await team(
    t,
    [4151, 4152],
  );
  const adaConnection = await connected(t, ada.app, ada.device);
  await subscribed(adaConnection.client, workspaceId);
  const payloads: (object | undefined)[] = [
    undefined,
    {},
    { ...body, agentId: undefined },
    { ...body, providerConnectionId: undefined },
    { ...body, inputMessageId: undefined },
    { ...body, agentId: body.agentId.toUpperCase() },
    { ...body, providerConnectionId: "connection" },
    { ...body, inputMessageId: 7 },
    { ...body, repositoryId: null },
    { ...body, repositoryId: "web" },
  ];
  for (const payload of payloads) {
    const response = await post(ada, projectId, payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(errorCode(response), "bad_request");
  }
  assert.equal(await runCount(agentId), 0);
  await quiet(adaConnection.client);
  // Unknown keys are stripped: a text, a state, and a requester change nothing.
  const run = createdRun(
    await post(ada, projectId, {
      ...body,
      body: "Do something else",
      state: "running",
      requestedBy: newId<UserId>(),
      hostDeviceId: newId<DeviceId>(),
    }),
  );
  assert.equal(run.state, "queued");
  const [row] = await database()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, run.id));
  assert.equal(row?.requestedByUserId, ada.device.userId);
  assert.equal(row?.hostDeviceId, ada.device.deviceId);
});

test("only the agent's owner creates its runs: another member is 403, also the workspace's owner for a member's agent, whatever else the body names", async (t) => {
  const { ada, bob, workspaceId, projectId, agentId, body } = await team(
    t,
    [4161, 4162],
  );
  const adaConnection = await connected(t, ada.app, ada.device);
  await subscribed(adaConnection.client, workspaceId);
  // Bob asks for Ada's agent, with Ada's own connection.
  const byMember = await post(bob, projectId, body);
  assert.equal(byMember.statusCode, 403, byMember.body);
  assert.equal(errorCode(byMember), "forbidden");
  // With IDs that do not exist, the answer is the same: no probing.
  const probing = await post(bob, projectId, {
    agentId,
    providerConnectionId: newId<ProviderConnectionId>(),
    inputMessageId: newId<MessageId>(),
    repositoryId: newId<RepositoryId>(),
  });
  assert.equal(probing.statusCode, 403, probing.body);
  assert.equal(errorCode(probing), "forbidden");
  // Ada owns the workspace, not Bob's agent.
  const bobsAgent = await agentOf(projectId, bob.device);
  const bobsConnection = await connectionOf(bob.device);
  const byOwner = await post(ada, projectId, {
    ...body,
    agentId: bobsAgent,
    providerConnectionId: bobsConnection,
  });
  assert.equal(byOwner.statusCode, 403, byOwner.body);
  assert.equal(errorCode(byOwner), "forbidden");
  assert.equal(await runCount(agentId), 0);
  assert.equal(await runCount(bobsAgent), 0);
  await quiet(adaConnection.client);
  // Bob's own agent with Bob's own connection and message is his to run.
  createdRun(
    await post(bob, projectId, {
      agentId: bobsAgent,
      providerConnectionId: bobsConnection,
      inputMessageId: await messageIn(workspaceId, projectId, bob.device),
    }),
  );
});

test("an agent, a repository, a provider connection, and a message that do not fit the project or the agent's host device are all the same 404, and nothing is created or sent", async (t) => {
  const { ada, bob, workspaceId, projectId, agentId, body } = await team(
    t,
    [4171, 4172],
  );
  const adaConnection = await connected(t, ada.app, ada.device);
  await subscribed(adaConnection.client, workspaceId);
  const otherProject = await projectIn(workspaceId, ada.device, "Site");
  const payloads: [label: string, payload: object][] = [
    ["an unknown agent", { ...body, agentId: newId<AgentId>() }],
    [
      "an agent of another project",
      { ...body, agentId: await agentOf(otherProject, ada.device) },
    ],
    ["an unknown repository", { ...body, repositoryId: newId<RepositoryId>() }],
    [
      "a repository of another project",
      { ...body, repositoryId: await repositoryIn(otherProject, ada.device) },
    ],
    [
      "an unknown provider connection",
      { ...body, providerConnectionId: newId<ProviderConnectionId>() },
    ],
    [
      "a provider connection of another member's device",
      { ...body, providerConnectionId: await connectionOf(bob.device) },
    ],
    ["an unknown message", { ...body, inputMessageId: newId<MessageId>() }],
    [
      "a message of another project",
      {
        ...body,
        inputMessageId: await messageIn(workspaceId, otherProject, ada.device),
      },
    ],
  ];
  const answers = new Set<string>();
  for (const [label, payload] of payloads) {
    const response = await post(ada, projectId, payload);
    assert.equal(response.statusCode, 404, label);
    assert.equal(errorCode(response), "not_found", label);
    answers.add(response.body);
  }
  // One body for all of them: the answer does not say which ID it was.
  assert.equal(answers.size, 1);
  assert.equal(await runCount(agentId), 0);
  await quiet(adaConnection.client);
});

test("a disabled agent, an archived project, an archived repository, and a removed provider connection are 409 with conflict, and nothing is created or sent", async (t) => {
  const { ada, workspaceId, projectId, agentId, providerConnectionId, body } =
    await team(t, [4181, 4182]);
  const adaConnection = await connected(t, ada.app, ada.device);
  await subscribed(adaConnection.client, workspaceId);
  const repositoryId = await repositoryIn(projectId, ada.device);
  const now = new Date();
  const states: [
    label: string,
    payload: object,
    set: (at: Date | null) => Promise<unknown>,
  ][] = [
    [
      "a disabled agent",
      body,
      (at) =>
        database()
          .update(agents)
          .set({ disabledAt: at })
          .where(eq(agents.id, agentId)),
    ],
    [
      "an archived project",
      body,
      (at) =>
        database()
          .update(projects)
          .set({ archivedAt: at })
          .where(eq(projects.id, projectId)),
    ],
    [
      "an archived repository",
      { ...body, repositoryId },
      (at) =>
        database()
          .update(repositories)
          .set({ archivedAt: at })
          .where(eq(repositories.id, repositoryId)),
    ],
    [
      "a removed provider connection",
      body,
      (at) =>
        database()
          .update(providerConnections)
          .set({ removedAt: at })
          .where(eq(providerConnections.id, providerConnectionId)),
    ],
  ];
  for (const [label, payload, set] of states) {
    await set(now);
    const response = await post(ada, projectId, payload);
    assert.equal(response.statusCode, 409, label);
    assert.equal(errorCode(response), "conflict", label);
    assert.equal(response.headers["retry-after"], undefined, label);
    await set(null);
  }
  assert.equal(await runCount(agentId), 0);
  await quiet(adaConnection.client);
  createdRun(await post(ada, projectId, { ...body, repositoryId }));
});

test(`an agent with ${MAX_UNFINISHED_RUNS_PER_AGENT} unfinished runs answers 409 with run_limit and no Retry-After, and a run that finishes frees a place`, async (t) => {
  const { ada, workspaceId, projectId, agentId, body } = await team(
    t,
    [4191, 4192],
  );
  const adaConnection = await connected(t, ada.app, ada.device);
  await subscribed(adaConnection.client, workspaceId);
  const made: RunId[] = [];
  for (let n = 0; n < MAX_UNFINISHED_RUNS_PER_AGENT; n += 1) {
    made.push(createdRun(await post(ada, projectId, body)).id);
  }
  await drained(adaConnection.client);

  const refused = await post(ada, projectId, body);
  assert.equal(refused.statusCode, 409, refused.body);
  assert.deepEqual(refused.json(), {
    statusCode: 409,
    error: "Conflict",
    message: "Conflict",
    code: "run_limit",
  });
  assert.equal(errorCode(refused), "run_limit");
  assert.equal(refused.headers["retry-after"], undefined);
  assert.equal(await runCount(agentId), MAX_UNFINISHED_RUNS_PER_AGENT);
  await quiet(adaConnection.client);

  const [first] = made;
  assert.ok(first !== undefined);
  await database()
    .update(agentRuns)
    .set({ state: "completed", finishedAt: new Date() })
    .where(eq(agentRuns.id, first));
  createdRun(await post(ada, projectId, body));
  assert.equal(errorCode(await post(ada, projectId, body)), "run_limit");
});

test(`an agent that got ${MAX_NEW_RUNS_PER_AGENT_PER_DAY} runs within 24 hours answers 429 with run_daily_limit and Retry-After, and the window slides`, async (t) => {
  const clock = fakeClock();
  const { ada, workspaceId, projectId, agentId, body } = await team(
    t,
    [4201, 4202],
    { clock },
  );
  const adaConnection = await connected(t, ada.app, ada.device);
  await subscribed(adaConnection.client, workspaceId);
  // One run short of the limit, all finished, the oldest 23 hours ago.
  await seedRuns(agentId, projectId, ada.device, {
    count: MAX_NEW_RUNS_PER_AGENT_PER_DAY - 1,
    finished: true,
    from: clock.now() - 23 * HOUR_MS,
    stepMs: 1_000,
  });
  createdRun(await post(ada, projectId, body));
  await drained(adaConnection.client);

  const refused = await post(ada, projectId, body);
  assert.equal(refused.statusCode, 429, refused.body);
  assert.deepEqual(refused.json(), {
    statusCode: 429,
    error: "Too Many Requests",
    message: "Too Many Requests",
    code: "run_daily_limit",
  });
  assert.equal(errorCode(refused), "run_daily_limit");
  // The oldest run leaves the 24 hours one hour from now.
  assert.equal(refused.headers["retry-after"], String(HOUR_MS / 1000));
  assert.equal(await runCount(agentId), MAX_NEW_RUNS_PER_AGENT_PER_DAY);
  await quiet(adaConnection.client);

  clock.advance(HOUR_MS);
  createdRun(await post(await refreshed(ada), projectId, body));
});

test("an agent at both limits answers run_limit: the limit that no wait frees is decided first", async (t) => {
  const clock = fakeClock();
  const { ada, projectId, agentId, body } = await team(t, [4211, 4212], {
    clock,
  });
  await seedRuns(agentId, projectId, ada.device, {
    count: MAX_NEW_RUNS_PER_AGENT_PER_DAY,
    finished: false,
    from: clock.now() - HOUR_MS,
  });
  const both = await post(ada, projectId, body);
  assert.equal(both.statusCode, 409, both.body);
  assert.equal(errorCode(both), "run_limit");
  assert.equal(both.headers["retry-after"], undefined);
  // With the runs finished, only the daily limit is left.
  await database()
    .update(agentRuns)
    .set({ state: "failed", finishedAt: new Date(clock.now()) })
    .where(eq(agentRuns.agentId, agentId));
  const daily = await post(ada, projectId, body);
  assert.equal(daily.statusCode, 429, daily.body);
  assert.equal(errorCode(daily), "run_daily_limit");
  assert.equal(daily.headers["retry-after"], String((DAY_MS - HOUR_MS) / 1000));
});

test("a device that was revoked after the request was authenticated creates nothing", async (t) => {
  const intercepting = interceptingDatabase(database());
  const { ada, workspaceId, projectId, agentId, body } = await team(
    t,
    [4221, 4222],
    { through: intercepting.database },
  );
  const adaConnection = await connected(t, ada.app, ada.device);
  await subscribed(adaConnection.client, workspaceId);
  // The revocation commits between the membership check, which reads the
  // project, and the route's transaction.
  intercepting.interceptNext("select", projects, () =>
    database()
      .update(devices)
      .set({ revokedAt: new Date(), revocationReason: "lost" })
      .where(eq(devices.id, ada.device.deviceId as DeviceId)),
  );
  const response = await post(ada, projectId, body);
  assert.equal(response.statusCode, 401, response.body);
  assert.equal(ApiErrorBodySchema.parse(response.json()).code, "unauthorized");
  assert.equal(await runCount(agentId), 0);
  await quiet(adaConnection.client);
});

test("a creation whose commit fails stores no run and sends no event, and the same request, once it commits, sends one", async (t) => {
  const commits = failingCommits(database());
  const { ada, bob, workspaceId, projectId, agentId, body } = await team(
    t,
    [4231, 4232],
    { through: commits.database },
  );
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(bobConnection.client, workspaceId);

  commits.failNextCommit();
  const rolledBack = await post(ada, projectId, body);
  assert.equal(rolledBack.statusCode, 500, rolledBack.body);
  // The route's own transaction failed, not one that ran before it.
  assert.deepEqual(commits.failedCommits(), ["run-routes.ts"]);
  assert.equal(await runCount(agentId), 0);
  await quiet(bobConnection.client);

  const run = createdRun(await post(ada, projectId, body));
  const { event } = await nextEvent(bobConnection.client);
  assert.ok(event.type === "agent.run.state_changed", event.type);
  assert.equal(event.payload.runId, run.id);
  await quiet(bobConnection.client);
});
