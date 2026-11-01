import {
  agentRuns,
  agents,
  projects,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  type AgentId,
  decodeServerMessage,
  type EventId,
  type MemberId,
  type MemberRole,
  newId,
  type ProjectId,
  type RunId,
  type RunState,
  type ServerEvent,
  type ServerFrame,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  accessToken,
  deviceApp,
  type SignedInDevice,
  signInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";
import {
  type Client,
  connected,
  nextFrame,
  settle,
} from "../gateway-test-support.ts";
import { CloseCode, ConnectionRegistry } from "../gateway.ts";

// What the server sends after a removal or a departure commits (ADR 0014,
// "Removal and ownership"; #93 on top of the delivery of #110): the removed
// person's subscriptions to the workspace end, the other subscribers see the
// person go offline and then `workspace.member.removed`, every connection of
// the removed account gets `account.removed_from_workspace`, and each
// cancelled run reaches the remaining subscribers. Every message is decoded
// with the desktop's decoder.

const database = useTestDatabase();

type Account = Readonly<{
  app: FastifyInstance;
  device: SignedInDevice;
  token: string;
}>;

/**
 * One API instance: each account signs in through its own app, and every app
 * shares one registry of connections and one database.
 */
async function instance(t: TestContext) {
  const connections = new ConnectionRegistry();
  const account = async (githubId: number): Promise<Account> => {
    const app = await deviceApp(t, {
      database: database(),
      githubId,
      connections,
    });
    // injectWS never settles unless the app is ready.
    await app.ready();
    const device = await signInDevice(app);
    return { app, device, token: await accessToken(app, device) };
  };
  return { connections, account };
}

/** A workspace, written directly, with an owner and claimed people of the given roles. */
async function workspaceOf(
  owner: SignedInDevice,
  people: readonly (readonly [SignedInDevice, MemberRole])[] = [],
) {
  const workspaceId = newId<WorkspaceId>();
  await database()
    .insert(workspaces)
    .values({ id: workspaceId, name: "Team", createdByUserId: owner.userId });
  const person = async (userId: UserId, role: MemberRole) => {
    const id = newId<MemberId>();
    await database().insert(workspaceMembers).values({
      id,
      workspaceId,
      userId,
      displayName: "Someone",
      role,
      addedByUserId: owner.userId,
      claimedAt: new Date(),
    });
    return id;
  };
  const ownerId = await person(owner.userId, "owner");
  const memberIds: MemberId[] = [];
  for (const [device, role] of people) {
    memberIds.push(await person(device.userId, role));
  }
  return { workspaceId, ownerId, memberIds };
}

async function projectIn(workspaceId: WorkspaceId, by: SignedInDevice) {
  const projectId = newId<ProjectId>();
  await database().insert(projects).values({
    id: projectId,
    workspaceId,
    name: "App",
    createdByUserId: by.userId,
  });
  return projectId;
}

async function agentOn(projectId: ProjectId, host: SignedInDevice) {
  const agentId = newId<AgentId>();
  await database().insert(agents).values({
    id: agentId,
    projectId,
    ownerUserId: host.userId,
    hostDeviceId: host.deviceId,
    name: "Builder",
  });
  return agentId;
}

async function runOf(
  agentId: AgentId,
  projectId: ProjectId,
  state: RunState,
  requestedBy: SignedInDevice,
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
      requestedByUserId: requestedBy.userId,
      state,
      ...(finished ? { finishedAt: new Date() } : {}),
    });
  return id;
}

function post(account: Account, url: string) {
  return account.app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${account.token}` },
  });
}

/** Subscribes and checks the answer. */
async function subscribe(client: Client, workspaceId: WorkspaceId) {
  client.send({ protocolVersion: 0, type: "workspace.subscribe", workspaceId });
  const frame = await nextFrame(client);
  assert.ok(
    frame.type === "workspace.subscribed" && frame.workspaceId === workspaceId,
    JSON.stringify(frame),
  );
}

function presence(
  workspaceId: WorkspaceId,
  memberId: MemberId,
  status: "online" | "offline",
): ServerFrame {
  return {
    protocolVersion: 0,
    type: "presence.changed",
    workspaceId,
    memberId,
    status,
  };
}

function membershipEnded(workspaceId: WorkspaceId): ServerFrame {
  return {
    protocolVersion: 0,
    type: "workspace.unsubscribed",
    workspaceId,
    reason: "membership_ended",
  };
}

/** The next message, which must be an event that the device's decoder accepts. */
async function nextEvent(client: Client): Promise<ServerEvent> {
  const decoded = decodeServerMessage(await client.next());
  assert.ok(decoded.ok && decoded.kind === "event", JSON.stringify(decoded));
  return decoded.event;
}

/** The next message must be `account.removed_from_workspace` for the workspace; returns its `removedAt`. */
async function removedFrom(
  client: Client,
  workspaceId: WorkspaceId,
): Promise<string> {
  const frame = await nextFrame(client);
  assert.ok(
    frame.type === "account.removed_from_workspace" &&
      frame.workspaceId === workspaceId,
    JSON.stringify(frame),
  );
  return frame.removedAt;
}

/** Checks the removal event from the system and returns its `removedAt`. */
function assertRemoved(
  event: ServerEvent,
  workspaceId: WorkspaceId,
  memberId: MemberId,
): string {
  assert.ok(event.type === "workspace.member.removed", event.type);
  assert.equal(event.workspaceId, workspaceId);
  assert.deepEqual(event.actor, { kind: "system" });
  assert.equal(event.deviceId, null);
  assert.equal(event.payload.memberId, memberId);
  return event.payload.removedAt;
}

/** Checks a run event of the system that cancelled the run with `member_removed`. */
function assertCancelled(
  event: ServerEvent,
  expected: Readonly<{
    workspaceId: WorkspaceId;
    runId: RunId;
    agentId: AgentId;
    previousState: RunState;
  }>,
) {
  assert.ok(event.type === "agent.run.state_changed", event.type);
  assert.equal(event.workspaceId, expected.workspaceId);
  assert.deepEqual(event.actor, { kind: "system" });
  assert.equal(event.deviceId, null);
  assert.deepEqual(event.payload, {
    runId: expected.runId,
    agentId: expected.agentId,
    previousState: expected.previousState,
    state: "cancelled",
    reason: "member_removed",
  });
}

/** Lets pending frames arrive, then checks that none is left unread. */
async function quiet(...clients: Client[]) {
  await settle();
  for (const client of clients) {
    assert.equal(client.unread(), 0);
  }
}

test("a removal ends the person's subscriptions, tells every connection of the account, and sends the removal and the cancelled runs to the remaining subscribers only", async (t) => {
  const { connections, account } = await instance(t);
  const ada = await account(3401);
  const bob = await account(3402);
  const bobsDesktop = await signInDevice(bob.app);
  const cleo = await account(3403);
  const dan = await account(3404);
  const team = await workspaceOf(ada.device, [
    [bob.device, "admin"],
    [cleo.device, "member"],
  ]);
  const [bobInTeam, cleoInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined && cleoInTeam !== undefined);
  const other = await workspaceOf(cleo.device, [[bob.device, "member"]]);
  const [bobInOther] = other.memberIds;
  assert.ok(bobInOther !== undefined);

  const project = await projectIn(team.workspaceId, ada.device);
  const bobsAgent = await agentOn(project, bob.device);
  const adasAgent = await agentOn(project, ada.device);
  const runs = {
    queued: await runOf(bobsAgent, project, "queued", bob.device),
    running: await runOf(bobsAgent, project, "running", ada.device),
    // Bob asked Ada's agent for this one.
    awaiting: await runOf(adasAgent, project, "awaiting_input", bob.device),
  };
  await runOf(adasAgent, project, "running", ada.device);
  await runOf(bobsAgent, project, "completed", bob.device);
  const otherProject = await projectIn(other.workspaceId, cleo.device);
  const bobsOtherAgent = await agentOn(otherProject, bob.device);
  await runOf(bobsOtherAgent, otherProject, "running", bob.device);

  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const laptop = (await connected(t, bob.app, bob.device)).client;
  const desktop = (await connected(t, bob.app, bobsDesktop)).client;
  const danClient = (await connected(t, dan.app, dan.device)).client;
  await subscribe(adaClient, team.workspaceId);
  await subscribe(cleoClient, team.workspaceId);
  assert.deepEqual(
    await nextFrame(adaClient),
    presence(team.workspaceId, cleoInTeam, "online"),
  );
  await subscribe(cleoClient, other.workspaceId);
  await subscribe(laptop, team.workspaceId);
  await subscribe(laptop, other.workspaceId);
  assert.deepEqual(
    await nextFrame(adaClient),
    presence(team.workspaceId, bobInTeam, "online"),
  );
  assert.deepEqual(
    [await nextFrame(cleoClient), await nextFrame(cleoClient)],
    [
      presence(team.workspaceId, bobInTeam, "online"),
      presence(other.workspaceId, bobInOther, "online"),
    ],
  );
  await quiet(adaClient, cleoClient, laptop, desktop, danClient);

  const response = await post(
    ada,
    `/workspaces/${team.workspaceId}/members/${bobInTeam}/remove`,
  );
  assert.equal(response.statusCode, 204, response.body);

  // Bob's laptop: its subscription to the team ends, then the account frame;
  // it gets neither the removal nor the run events.
  assert.deepEqual(await nextFrame(laptop), membershipEnded(team.workspaceId));
  const removedAt = await removedFrom(laptop, team.workspaceId);
  // Bob's desktop, which subscribed to nothing, gets the account frame too.
  assert.equal(await removedFrom(desktop, team.workspaceId), removedAt);

  const cancelled = [
    { runId: runs.queued, agentId: bobsAgent, previousState: "queued" },
    { runId: runs.running, agentId: bobsAgent, previousState: "running" },
    {
      runId: runs.awaiting,
      agentId: adasAgent,
      previousState: "awaiting_input",
    },
  ] as const;
  const inOrder = [...cancelled].sort((a, b) => (a.runId < b.runId ? -1 : 1));
  // The remaining subscribers: Bob goes offline, then the removal, then each
  // cancelled run in the order of the run IDs.
  for (const client of [adaClient, cleoClient]) {
    assert.deepEqual(
      await nextFrame(client),
      presence(team.workspaceId, bobInTeam, "offline"),
    );
    assert.equal(
      assertRemoved(await nextEvent(client), team.workspaceId, bobInTeam),
      removedAt,
    );
    for (const expected of inOrder) {
      assertCancelled(await nextEvent(client), {
        ...expected,
        workspaceId: team.workspaceId,
      });
    }
  }
  await quiet(adaClient, cleoClient, laptop, desktop, danClient);
  // Bob stays subscribed to Cleo's workspace.
  assert.deepEqual(
    connections
      .subscriptions()
      .filter(({ context }) => context.identity.userId === bob.device.userId)
      .map(({ workspaceId, memberId }) => [workspaceId, memberId]),
    [[other.workspaceId, bobInOther]],
  );

  // The per-event membership check stays the backstop: an event of Bob's in
  // the team closes his laptop's connection, and with it his subscription to
  // Cleo's workspace.
  laptop.send({
    protocolVersion: 0,
    id: newId<EventId>(),
    type: "chat.message.send",
    occurredAt: new Date().toISOString(),
    workspaceId: team.workspaceId,
    actor: { kind: "user", userId: bob.device.userId },
    deviceId: bob.device.deviceId,
    payload: { projectId: project, body: "Still here?" },
  });
  assert.deepEqual(await laptop.closed, {
    code: CloseCode.policyViolation,
    reason: "not_a_member",
  });
  assert.deepEqual(
    await nextFrame(cleoClient),
    presence(other.workspaceId, bobInOther, "offline"),
  );
  await quiet(adaClient, cleoClient, desktop, danClient);
});

test("leaving ends the leaver's subscription with membership_ended and tells the account and the remaining subscribers; the owner's leave changes nothing", async (t) => {
  const { connections, account } = await instance(t);
  const ada = await account(3411);
  const bob = await account(3412);
  const team = await workspaceOf(ada.device, [[bob.device, "member"]]);
  const [bobInTeam] = team.memberIds;
  assert.ok(bobInTeam !== undefined);
  const project = await projectIn(team.workspaceId, ada.device);
  const adasAgent = await agentOn(project, ada.device);
  const requested = await runOf(adasAgent, project, "queued", bob.device);

  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  await subscribe(adaClient, team.workspaceId);
  await subscribe(bobClient, team.workspaceId);
  assert.deepEqual(
    await nextFrame(adaClient),
    presence(team.workspaceId, bobInTeam, "online"),
  );

  const refused = await post(ada, `/workspaces/${team.workspaceId}/leave`);
  assert.equal(refused.statusCode, 403);
  await quiet(adaClient, bobClient);

  const response = await post(bob, `/workspaces/${team.workspaceId}/leave`);
  assert.equal(response.statusCode, 204, response.body);
  assert.deepEqual(
    await nextFrame(bobClient),
    membershipEnded(team.workspaceId),
  );
  const removedAt = await removedFrom(bobClient, team.workspaceId);
  assert.deepEqual(
    await nextFrame(adaClient),
    presence(team.workspaceId, bobInTeam, "offline"),
  );
  assert.equal(
    assertRemoved(await nextEvent(adaClient), team.workspaceId, bobInTeam),
    removedAt,
  );
  assertCancelled(await nextEvent(adaClient), {
    workspaceId: team.workspaceId,
    runId: requested,
    agentId: adasAgent,
    previousState: "queued",
  });
  await quiet(adaClient, bobClient);
  assert.equal(connections.subscriptions().length, 1);
});

test("removing an unclaimed person sends no account frame and cancels nothing", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3421);
  const team = await workspaceOf(ada.device);
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  await subscribe(adaClient, team.workspaceId);
  const defined = await ada.app.inject({
    method: "POST",
    url: `/workspaces/${team.workspaceId}/members`,
    headers: { authorization: `Bearer ${ada.token}` },
    payload: { displayName: "Linus" },
  });
  assert.equal(defined.statusCode, 200, defined.body);
  assert.equal((await nextEvent(adaClient)).type, "workspace.member.defined");
  const { member } = defined.json() as { member: { id: MemberId } };

  const response = await post(
    ada,
    `/workspaces/${team.workspaceId}/members/${member.id}/remove`,
  );
  assert.equal(response.statusCode, 204, response.body);
  assertRemoved(await nextEvent(adaClient), team.workspaceId, member.id);
  await quiet(adaClient);
});
