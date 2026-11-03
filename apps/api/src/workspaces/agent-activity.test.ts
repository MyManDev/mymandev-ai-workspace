import {
  agentRunTransitions,
  agentRuns,
  agents,
  auditEvents,
  createProject,
  type Database,
  devices,
  projects,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  type AgentId,
  AgentListResponseSchema,
  AgentRunListResponseSchema,
  type ConnectionId,
  type CorrelationId,
  type DeviceId,
  decodeClientEvent,
  decodeServerMessage,
  type EventId,
  LIMITS,
  type MemberId,
  type MemberRole,
  newId,
  type ProjectId,
  type RunId,
  type RunState,
  type ServerEvent,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  accessToken,
  deviceApp,
  type FakeClock,
  fakeClock,
  type SignedInDevice,
  signInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";
import {
  AuditThrottle,
  type AuthenticatedConnectionContext,
  bindIdentity,
  CloseCode,
  CONNECTION_AUDIT_WINDOW_MS,
  ConnectionRegistry,
  MAX_BUFFERED_BYTES,
} from "../gateway.ts";
import {
  type Client,
  connected,
  interceptingDatabase,
  nextFrame,
  settle,
} from "../gateway-test-support.ts";
import { RUN_TRANSITION_LIMIT, runTransitionHandler } from "./agent-events.ts";
import { CHAT_SEND_LIMIT } from "./chat-events.ts";

const database = useTestDatabase();

type Json = Record<string, unknown>;

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
  options: Readonly<{ clock?: FakeClock }> = {},
) {
  const connections = new ConnectionRegistry();
  const account = async (
    githubId: number,
    through: Database = database(),
  ): Promise<Account> => {
    const app = await deviceApp(t, {
      database: through,
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

/** A workspace that `owner` owns, with `members` as claimed members, written directly. */
async function workspaceOf(
  owner: SignedInDevice,
  members: readonly SignedInDevice[] = [],
) {
  const workspaceId = newId<WorkspaceId>();
  await database()
    .insert(workspaces)
    .values({ id: workspaceId, name: "Team", createdByUserId: owner.userId });
  const person = async (userId: UserId, role: MemberRole) => {
    const id = newId<MemberId>();
    await database()
      .insert(workspaceMembers)
      .values({
        id,
        workspaceId,
        userId,
        displayName: role === "owner" ? "Ada" : "Bob",
        role,
        addedByUserId: owner.userId,
        claimedAt: new Date(),
      });
    return id;
  };
  const ownerId = await person(owner.userId, "owner");
  const memberIds: MemberId[] = [];
  for (const member of members) {
    memberIds.push(await person(member.userId, "member"));
  }
  return { workspaceId, ownerId, memberIds };
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

let lastCreatedAt = 0;

/**
 * An agent of the project, owned by the device's account and hosted on the
 * device, with `runs` runs in `queued`, written directly as the development
 * seed writes them (#28, D2).
 */
async function agentOf(
  projectId: ProjectId,
  host: SignedInDevice,
  options: Readonly<{ runs?: number; name?: string; disabled?: boolean }> = {},
) {
  const agentId = newId<AgentId>();
  // Strictly later than the agent before, so that the lists have one order.
  const now = new Date(Math.max(Date.now(), lastCreatedAt + 10));
  lastCreatedAt = now.getTime();
  await database()
    .insert(agents)
    .values({
      id: agentId,
      projectId,
      ownerUserId: host.userId,
      hostDeviceId: host.deviceId as DeviceId,
      name: options.name ?? "Builder",
      createdAt: now,
      updatedAt: now,
      disabledAt: options.disabled === true ? now : null,
    });
  const runIds = Array.from({ length: options.runs ?? 1 }, () =>
    newId<RunId>(),
  );
  for (const [index, id] of runIds.entries()) {
    await database()
      .insert(agentRuns)
      .values({
        id,
        agentId,
        projectId,
        requestedByUserId: host.userId,
        state: "queued",
        createdAt: new Date(now.getTime() + index),
      });
  }
  return { agentId, runIds };
}

/** An `agent.run.state_changed` of the agent's host device, as the desktop sends it. */
function transitionOf(
  device: SignedInDevice,
  workspaceId: WorkspaceId,
  agentId: AgentId,
  runId: RunId,
  previousState: RunState,
  state: RunState,
  extra: Readonly<{
    id?: EventId;
    reason?: string;
    correlationId?: CorrelationId;
    causationId?: EventId;
  }> = {},
) {
  return {
    protocolVersion: 0,
    id: extra.id ?? newId<EventId>(),
    type: "agent.run.state_changed",
    occurredAt: "2026-11-03T09:00:00.123Z",
    workspaceId,
    actor: { kind: "agent", agentId },
    deviceId: device.deviceId,
    ...(extra.correlationId === undefined
      ? {}
      : { correlationId: extra.correlationId }),
    ...(extra.causationId === undefined
      ? {}
      : { causationId: extra.causationId }),
    payload: {
      runId,
      agentId,
      previousState,
      state,
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
    },
  } as const;
}

/** The relayed form of a transition: every field unchanged, except `deviceId: null`. */
function relayed(sent: ReturnType<typeof transitionOf>) {
  return { ...sent, deviceId: null };
}

function subscribe(workspaceId: WorkspaceId): Json {
  return { protocolVersion: 0, type: "workspace.subscribe", workspaceId };
}

async function subscribed(client: Client, workspaceId: WorkspaceId) {
  client.send(subscribe(workspaceId));
  const frame = await nextFrame(client);
  assert.ok(
    frame.type === "workspace.subscribed" && frame.workspaceId === workspaceId,
    JSON.stringify(frame),
  );
}

/** The next message, which must be an event that the device's decoder accepts. */
async function nextEvent(client: Client): Promise<ServerEvent> {
  const decoded = decodeServerMessage(await client.next());
  assert.ok(decoded.ok && decoded.kind === "event", JSON.stringify(decoded));
  return decoded.event;
}

/** The next message, which must be the relayed form of `sent`. */
async function nextRelayed(
  client: Client,
  sent: ReturnType<typeof transitionOf>,
) {
  assert.deepEqual(await nextEvent(client), relayed(sent));
}

/** The next message, which must be `event.refused` for `eventId`. */
async function nextRefused(client: Client, eventId: EventId, code: string) {
  assert.deepEqual(await nextFrame(client), {
    protocolVersion: 0,
    type: "event.refused",
    eventId,
    code,
  });
}

/** Lets pending frames arrive, then checks that none is left unread. */
async function quiet(...clients: Client[]) {
  await settle();
  for (const client of clients) {
    assert.equal(client.unread(), 0);
  }
}

function isOpen(client: Client): boolean {
  return client.ws.readyState === client.ws.OPEN;
}

async function runState(runId: RunId) {
  const [run] = await database()
    .select({ state: agentRuns.state, reason: agentRuns.stateReason })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  return run;
}

/** The event IDs of the recorded transitions of a run, in the order they were recorded. */
async function recordedOf(runId: RunId) {
  const rows = await database()
    .select({
      eventId: agentRunTransitions.eventId,
      state: agentRunTransitions.state,
    })
    .from(agentRunTransitions)
    .where(eq(agentRunTransitions.runId, runId))
    .orderBy(agentRunTransitions.id);
  return rows;
}

function get(account: Account, url: string) {
  return account.app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${account.token}` },
  });
}

test("an accepted transition is relayed to another subscribed member with the same event ID, agent actor, and fields, and deviceId null, and to the sender", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3801);
  const bob = await account(3802);
  const { workspaceId } = await workspaceOf(ada.device, [bob.device]);
  const projectId = await projectIn(workspaceId, ada.device);
  const { agentId, runIds } = await agentOf(projectId, ada.device);
  const [runId] = runIds;
  assert.ok(runId !== undefined);
  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(adaConnection.client, workspaceId);
  await subscribed(bobConnection.client, workspaceId);
  assert.equal(
    (await nextFrame(adaConnection.client)).type,
    "presence.changed",
  );

  const started = transitionOf(
    ada.device,
    workspaceId,
    agentId,
    runId,
    "queued",
    "running",
    {
      reason: "Picked up",
      correlationId: newId<CorrelationId>(),
      causationId: newId<EventId>(),
    },
  );
  adaConnection.client.send(started);
  // The device's decoder refuses an event with a device ID, so Bob never
  // sees Ada's device.
  const seenByBob = await nextEvent(bobConnection.client);
  assert.deepEqual(seenByBob, relayed(started));
  assert.equal(seenByBob.deviceId, null);
  await nextRelayed(adaConnection.client, started);
  await quiet(adaConnection.client, bobConnection.client);
  assert.deepEqual(await runState(runId), {
    state: "running",
    reason: "Picked up",
  });
  assert.deepEqual(await recordedOf(runId), [
    { eventId: started.id, state: "running" },
  ]);
});

test("the sender gets its relayed transition as its acknowledgement also when it is not subscribed, and a resent event ID gets the stored relayed event on the sending connection only", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3811);
  const bob = await account(3812);
  const { workspaceId } = await workspaceOf(ada.device, [bob.device]);
  const projectId = await projectIn(workspaceId, ada.device);
  const { agentId, runIds } = await agentOf(projectId, ada.device);
  const [runId] = runIds;
  assert.ok(runId !== undefined);
  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(bobConnection.client, workspaceId);

  const started = transitionOf(
    ada.device,
    workspaceId,
    agentId,
    runId,
    "queued",
    "running",
  );
  adaConnection.client.send(started);
  await nextRelayed(adaConnection.client, started);
  await nextRelayed(bobConnection.client, started);
  await quiet(adaConnection.client, bobConnection.client);

  // The event ID is the idempotency key: a resent event, also one that
  // differs, gets the event as it was stored and changes nothing.
  adaConnection.client.send(started);
  await nextRelayed(adaConnection.client, started);
  const changed = transitionOf(
    ada.device,
    workspaceId,
    agentId,
    runId,
    "running",
    "completed",
    { id: started.id, reason: "Changed" },
  );
  adaConnection.client.send(changed);
  await nextRelayed(adaConnection.client, started);
  await quiet(adaConnection.client, bobConnection.client);

  // Subscribed, the sender still gets a resent event ID alone.
  await subscribed(adaConnection.client, workspaceId);
  assert.equal(
    (await nextFrame(bobConnection.client)).type,
    "presence.changed",
  );
  adaConnection.client.send(started);
  await nextRelayed(adaConnection.client, started);
  await quiet(adaConnection.client, bobConnection.client);
  assert.deepEqual(await runState(runId), { state: "running", reason: null });
  assert.deepEqual(await recordedOf(runId), [
    { eventId: started.id, state: "running" },
  ]);
});

test("an unknown agent or run, an agent of another workspace, a run of another agent, a stale previousState, a disabled agent, an archived project, and an event ID used in another workspace get event.refused on the sending connection only, which stays open", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3821);
  const bob = await account(3822);
  const team = await workspaceOf(ada.device, [bob.device]);
  const projectId = await projectIn(team.workspaceId, ada.device);
  const { agentId, runIds } = await agentOf(projectId, ada.device, {
    runs: 2,
  });
  const [runId, finishedRun] = runIds;
  assert.ok(runId !== undefined && finishedRun !== undefined);
  const other = await agentOf(projectId, ada.device, { name: "Reviewer" });
  const [otherRun] = other.runIds;
  assert.ok(otherRun !== undefined);
  const disabled = await agentOf(projectId, ada.device, {
    name: "Retired",
    disabled: true,
  });
  const [disabledRun] = disabled.runIds;
  assert.ok(disabledRun !== undefined);
  const archivedProject = await projectIn(team.workspaceId, ada.device, "Old");
  const archived = await agentOf(archivedProject, ada.device);
  const [archivedRun] = archived.runIds;
  assert.ok(archivedRun !== undefined);
  await database()
    .update(projects)
    .set({ archivedAt: new Date() })
    .where(eq(projects.id, archivedProject));
  // Ada's agent in a second workspace of hers.
  const second = await workspaceOf(ada.device);
  const secondProject = await projectIn(second.workspaceId, ada.device);
  const elsewhere = await agentOf(secondProject, ada.device);
  const [elsewhereRun] = elsewhere.runIds;
  assert.ok(elsewhereRun !== undefined);

  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(bobConnection.client, team.workspaceId);

  // A run that finished: a transition from it is stale.
  const finish = [
    transitionOf(
      ada.device,
      team.workspaceId,
      agentId,
      finishedRun,
      "queued",
      "running",
    ),
    transitionOf(
      ada.device,
      team.workspaceId,
      agentId,
      finishedRun,
      "running",
      "completed",
    ),
  ];
  for (const sent of finish) {
    adaConnection.client.send(sent);
    await nextRelayed(adaConnection.client, sent);
    await nextRelayed(bobConnection.client, sent);
  }
  // An event ID recorded in the second workspace, reused in the team.
  const recordedElsewhere = transitionOf(
    ada.device,
    second.workspaceId,
    elsewhere.agentId,
    elsewhereRun,
    "queued",
    "running",
  );
  adaConnection.client.send(recordedElsewhere);
  await nextRelayed(adaConnection.client, recordedElsewhere);

  const unknownAgent = newId<AgentId>();
  const cases = [
    [unknownAgent, newId<RunId>(), "queued", "not_found"],
    [agentId, newId<RunId>(), "queued", "not_found"],
    // The reference binding: an agent that Ada's device hosts, but in
    // another workspace than the event's.
    [elsewhere.agentId, elsewhereRun, "running", "not_found"],
    [agentId, otherRun, "queued", "not_found"],
    [agentId, runId, "running", "conflict"],
    [agentId, finishedRun, "running", "conflict"],
    [disabled.agentId, disabledRun, "queued", "conflict"],
    [archived.agentId, archivedRun, "queued", "conflict"],
  ] as const;
  for (const [agent, run, previousState, code] of cases) {
    const sent = transitionOf(
      ada.device,
      team.workspaceId,
      agent,
      run,
      previousState,
      previousState === "queued" ? "running" : "awaiting_input",
    );
    adaConnection.client.send(sent);
    await nextRefused(adaConnection.client, sent.id, code);
  }
  const reused = transitionOf(
    ada.device,
    team.workspaceId,
    agentId,
    runId,
    "queued",
    "running",
    { id: recordedElsewhere.id },
  );
  adaConnection.client.send(reused);
  await nextRefused(adaConnection.client, reused.id, "conflict");
  await quiet(adaConnection.client, bobConnection.client);
  for (const run of [runId, otherRun, disabledRun, archivedRun]) {
    assert.equal((await runState(run))?.state, "queued", run);
    assert.deepEqual(await recordedOf(run), [], run);
  }

  // The connection stayed open and still reports.
  assert.ok(isOpen(adaConnection.client));
  const accepted = transitionOf(
    ada.device,
    team.workspaceId,
    agentId,
    runId,
    "queued",
    "running",
  );
  adaConnection.client.send(accepted);
  await nextRelayed(adaConnection.client, accepted);
  await nextRelayed(bobConnection.client, accepted);
});

test("a transition for an agent of the workspace that another device hosts closes the connection with identity_mismatch, is audited, and stores and relays nothing", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3831);
  const bob = await account(3832);
  const { workspaceId } = await workspaceOf(ada.device, [bob.device]);
  const projectId = await projectIn(workspaceId, ada.device);
  // Bob's agent, and an agent on a second device of Ada's account.
  const bobs = await agentOf(projectId, bob.device);
  const adaDesktop = await signInDevice(ada.app);
  const onDesktop = await agentOf(projectId, adaDesktop, { name: "Desktop" });
  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(bobConnection.client, workspaceId);
  await subscribed(adaConnection.client, workspaceId);
  assert.equal(
    (await nextFrame(bobConnection.client)).type,
    "presence.changed",
  );

  const [bobsRun] = bobs.runIds;
  assert.ok(bobsRun !== undefined);
  const asBobsAgent = transitionOf(
    ada.device,
    workspaceId,
    bobs.agentId,
    bobsRun,
    "queued",
    "running",
  );
  adaConnection.client.send(asBobsAgent);
  assert.deepEqual(await adaConnection.client.closed, {
    code: CloseCode.policyViolation,
    reason: "identity_mismatch",
  });
  assert.equal(
    (await nextFrame(bobConnection.client)).type,
    "presence.changed",
  );

  const [desktopRun] = onDesktop.runIds;
  assert.ok(desktopRun !== undefined);
  const again = await connected(t, ada.app, ada.device);
  const asDesktopAgent = transitionOf(
    ada.device,
    workspaceId,
    onDesktop.agentId,
    desktopRun,
    "queued",
    "running",
  );
  again.client.send(asDesktopAgent);
  assert.deepEqual(await again.client.closed, {
    code: CloseCode.policyViolation,
    reason: "identity_mismatch",
  });
  await quiet(bobConnection.client);
  for (const run of [bobsRun, desktopRun]) {
    assert.equal((await runState(run))?.state, "queued");
    assert.deepEqual(await recordedOf(run), []);
  }

  // Audited as identity binding audits a mismatch: once per device per
  // hour, with the event ID as its subject and no workspace.
  const audits = await database()
    .select({
      actorUserId: auditEvents.actorUserId,
      subjectId: auditEvents.subjectId,
      workspaceId: auditEvents.workspaceId,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "event.identity_mismatch"),
        eq(auditEvents.actorDeviceId, ada.device.deviceId as DeviceId),
      ),
    );
  assert.deepEqual(audits, [
    {
      actorUserId: ada.device.userId,
      subjectId: asBobsAgent.id,
      workspaceId: null,
    },
  ]);
});

test("after identity binding, the transition handler refuses a removed member, a revoked device, and another device's agent inside its transaction, and records nothing", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3881);
  const bob = await account(3882);
  const { workspaceId, memberIds } = await workspaceOf(ada.device, [
    bob.device,
  ]);
  const projectId = await projectIn(workspaceId, ada.device);
  const bobs = await agentOf(projectId, bob.device);
  const adas = await agentOf(projectId, ada.device);
  const [bobsRun] = bobs.runIds;
  const [adasRun] = adas.runIds;
  assert.ok(bobsRun !== undefined && adasRun !== undefined);
  const bobPerson = memberIds[0];
  assert.ok(bobPerson !== undefined);
  const [device] = await database()
    .select({ lastSignInAt: devices.lastSignInAt })
    .from(devices)
    .where(eq(devices.id, bob.device.deviceId as DeviceId));
  assert.ok(device !== undefined);
  const context: AuthenticatedConnectionContext = Object.freeze({
    connectionId: newId<ConnectionId>(),
    identity: Object.freeze({
      userId: bob.device.userId,
      deviceId: bob.device.deviceId as DeviceId,
    }),
    signedInAt: device.lastSignInAt.getTime(),
  });
  // The handler registers its sweep on an app that has not started.
  const host = Fastify();
  t.after(() => host.close());
  const handle = runTransitionHandler(host, {
    database: database(),
    now: Date.now,
    connections: new ConnectionRegistry(),
    log: bob.app.log,
  });
  /** A transition of Bob's device that passed identity binding. */
  async function verified(agentId: AgentId, runId: RunId) {
    const decoded = decodeClientEvent(
      transitionOf(
        bob.device,
        workspaceId,
        agentId,
        runId,
        "queued",
        "running",
      ),
    );
    assert.ok(decoded.ok);
    const bound = await bindIdentity(decoded.event, context, {
      database: database(),
      now: Date.now,
      mismatchAudits: new AuditThrottle(CONNECTION_AUDIT_WINDOW_MS, Date.now),
      log: bob.app.log,
    });
    assert.ok(bound.ok && bound.event.type === "agent.run.state_changed");
    return bound.event;
  }

  // Identity binding checks only the envelope; the agent's host device is
  // the handler's to check.
  assert.deepEqual(
    await handle(await verified(adas.agentId, adasRun), context),
    {
      rejected: "identity_mismatch",
    },
  );
  const removedLater = await verified(bobs.agentId, bobsRun);
  await database()
    .update(workspaceMembers)
    .set({ removedAt: new Date(), removedByUserId: ada.device.userId })
    .where(eq(workspaceMembers.id, bobPerson));
  assert.deepEqual(await handle(removedLater, context), {
    rejected: "not_a_member",
  });
  await database()
    .update(workspaceMembers)
    .set({ removedAt: null, removedByUserId: null })
    .where(eq(workspaceMembers.id, bobPerson));
  const revokedLater = await verified(bobs.agentId, bobsRun);
  await database()
    .update(devices)
    .set({ revokedAt: new Date(), revocationReason: "lost" })
    .where(eq(devices.id, context.identity.deviceId));
  assert.deepEqual(await handle(revokedLater, context), {
    rejected: "device_revoked",
  });
  for (const run of [bobsRun, adasRun]) {
    assert.equal((await runState(run))?.state, "queued");
    assert.deepEqual(await recordedOf(run), []);
  }
});

test("one connection's transitions that arrive back to back are recorded and relayed in the order they arrived", async (t) => {
  const { account } = await instance(t);
  const intercepting = interceptingDatabase(database());
  const ada = await account(3841, intercepting.database);
  const bob = await account(3842);
  const { workspaceId } = await workspaceOf(ada.device, [bob.device]);
  const projectId = await projectIn(workspaceId, ada.device);
  const { agentId, runIds } = await agentOf(projectId, ada.device);
  const [runId] = runIds;
  assert.ok(runId !== undefined);
  const adaConnection = await connected(t, ada.app, ada.device);
  const bobConnection = await connected(t, bob.app, bob.device);
  await subscribed(bobConnection.client, workspaceId);

  // Each transition starts from the state that the one before it left, so
  // a transition handled before its predecessor would be refused as stale.
  const states: RunState[] = [
    "queued",
    "running",
    "awaiting_input",
    "running",
    "completed",
  ];
  const walk = states
    .slice(1)
    .map((state, index) =>
      transitionOf(
        ada.device,
        workspaceId,
        agentId,
        runId,
        states[index] ?? "queued",
        state,
      ),
    );
  // The first transition's identity binding waits a while before it reads
  // the device: a transition handled meanwhile would overtake it.
  intercepting.interceptNext(
    "select",
    devices,
    () => new Promise((resolve) => setTimeout(resolve, 100)),
  );
  for (const sent of walk) {
    adaConnection.client.send(sent);
  }
  for (const sent of walk) {
    await nextRelayed(adaConnection.client, sent);
  }
  for (const sent of walk) {
    await nextRelayed(bobConnection.client, sent);
  }
  await quiet(adaConnection.client, bobConnection.client);
  assert.deepEqual(await runState(runId), { state: "completed", reason: null });
  assert.deepEqual(
    await recordedOf(runId),
    walk.map((sent) => ({ eventId: sent.id, state: sent.payload.state })),
  );
});

test(`an account's transitions above ${RUN_TRANSITION_LIMIT.burst.max} in ${RUN_TRANSITION_LIMIT.burst.windowMs / 1000} seconds get event.refused with rate_limited, the connection stays open, and the limit and the chat send limit count apart`, async (t) => {
  const clock = fakeClock();
  const { account } = await instance(t, { clock });
  const ada = await account(3851);
  const { workspaceId } = await workspaceOf(ada.device);
  const projectId = await projectIn(workspaceId, ada.device);
  const { agentId, runIds } = await agentOf(projectId, ada.device);
  const [runId] = runIds;
  assert.ok(runId !== undefined);
  const { client } = await connected(t, ada.app, ada.device);

  // Every transition below the limit counts, also a refused one.
  for (let index = 0; index < RUN_TRANSITION_LIMIT.burst.max; index += 1) {
    const sent = transitionOf(
      ada.device,
      workspaceId,
      agentId,
      newId<RunId>(),
      "queued",
      "running",
    );
    client.send(sent);
    await nextRefused(client, sent.id, "not_found");
    clock.advance(100);
  }
  const limited = transitionOf(
    ada.device,
    workspaceId,
    agentId,
    runId,
    "queued",
    "running",
  );
  client.send(limited);
  await nextRefused(client, limited.id, "rate_limited");
  assert.equal((await runState(runId))?.state, "queued");

  // Chat has its own count: a message still goes through, and a full chat
  // burst does not hold up a transition.
  const sendOf = (body: string) => ({
    protocolVersion: 0,
    id: newId<EventId>(),
    type: "chat.message.send",
    occurredAt: "2026-11-03T09:00:00.000Z",
    workspaceId,
    actor: { kind: "user", userId: ada.device.userId },
    deviceId: ada.device.deviceId,
    payload: { projectId, body },
  });
  for (let index = 0; index < CHAT_SEND_LIMIT.burst.max; index += 1) {
    client.send(sendOf(`Line ${index}`));
    assert.equal((await nextEvent(client)).type, "chat.message.created");
  }

  // The burst slides: the oldest transition leaves it 10 seconds after it was sent.
  clock.advance(
    RUN_TRANSITION_LIMIT.burst.windowMs - 100 * RUN_TRANSITION_LIMIT.burst.max,
  );
  client.send(limited);
  await nextRelayed(client, limited);
  const chatLimited = sendOf("Too many");
  client.send(chatLimited);
  await nextRefused(client, chatLimited.id, "rate_limited");
  assert.ok(isOpen(client));
  await quiet(client);
});

test("the largest relayed transitions of one burst fit, with the largest chat messages of one burst, under the backpressure limit of a connection", () => {
  const workspaceId = newId<WorkspaceId>();
  const agentId = newId<AgentId>();
  // A code point takes at most 4 bytes in UTF-8, and JSON.stringify escapes
  // a quote or a backslash with 2.
  const astral = String.fromCodePoint(0x1f600);
  const transition = {
    ...relayed(
      transitionOf(
        { deviceId: newId<DeviceId>() } as SignedInDevice,
        workspaceId,
        agentId,
        newId<RunId>(),
        "awaiting_input",
        "cancelled",
        {
          reason: astral.repeat(LIMITS.runReason),
          correlationId: newId<CorrelationId>(),
          causationId: newId<EventId>(),
        },
      ),
    ),
  };
  const withRepository = {
    ...transition,
    payload: { ...transition.payload, repositoryId: newId() },
  };
  const decoded = decodeServerMessage(withRepository);
  assert.ok(decoded.ok && decoded.kind === "event", JSON.stringify(decoded));
  const transitionBytes = Buffer.byteLength(JSON.stringify(decoded.event));
  const message = {
    protocolVersion: 0,
    id: newId<EventId>(),
    occurredAt: "2026-11-03T09:00:00.000Z",
    workspaceId,
    actor: { kind: "system" },
    deviceId: null,
    correlationId: newId(),
    causationId: newId(),
    type: "chat.message.created",
    payload: {
      message: {
        id: newId(),
        projectId: newId(),
        seq: Number.MAX_SAFE_INTEGER,
        author: { kind: "agent", agentId },
        body: `a${astral.repeat(LIMITS.messageBody - 1)}`,
        createdAt: "2026-11-03T09:00:00.000Z",
      },
    },
  };
  const decodedMessage = decodeServerMessage(message);
  assert.ok(
    decodedMessage.ok && decodedMessage.kind === "event",
    JSON.stringify(decodedMessage),
  );
  const messageBytes = Buffer.byteLength(JSON.stringify(decodedMessage.event));
  const burst =
    RUN_TRANSITION_LIMIT.burst.max * transitionBytes +
    CHAT_SEND_LIMIT.burst.max * messageBytes;
  assert.ok(
    burst <= MAX_BUFFERED_BYTES,
    `${transitionBytes} and ${messageBytes} bytes: ${burst}`,
  );
  assert.equal(
    RUN_TRANSITION_LIMIT.burst.windowMs,
    CHAT_SEND_LIMIT.burst.windowMs,
  );
});

test("the agent and run routes answer a member with the project's agents, disabled ones included and without a host device, and its unfinished and finished runs", async (t) => {
  const { account } = await instance(t);
  const ada = await account(3861);
  const bob = await account(3862);
  const { workspaceId, ownerId, memberIds } = await workspaceOf(ada.device, [
    bob.device,
  ]);
  const projectId = await projectIn(workspaceId, ada.device);
  const otherProject = await projectIn(workspaceId, ada.device, "Other");
  const builder = await agentOf(projectId, ada.device, { runs: 3 });
  const retired = await agentOf(projectId, bob.device, {
    name: "Retired",
    runs: 0,
    disabled: true,
  });
  await agentOf(otherProject, ada.device);

  // Bob reads before and after Ada's agent moves its runs.
  const agentsAnswer = await get(bob, `/projects/${projectId}/agents`);
  assert.equal(agentsAnswer.statusCode, 200, agentsAnswer.body);
  const listed = AgentListResponseSchema.parse(agentsAnswer.json());
  assert.deepEqual(
    listed.agents.map(({ id, name, ownerMemberId, disabledAt }) => ({
      id,
      name,
      ownerMemberId,
      disabled: disabledAt !== null,
    })),
    [
      {
        id: builder.agentId,
        name: "Builder",
        ownerMemberId: ownerId,
        disabled: false,
      },
      {
        id: retired.agentId,
        name: "Retired",
        ownerMemberId: memberIds[0],
        disabled: true,
      },
    ],
  );
  assert.ok(!agentsAnswer.body.includes(ada.device.deviceId));
  assert.ok(!agentsAnswer.body.includes(bob.device.deviceId));

  const [first, second, third] = builder.runIds;
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  const { client } = await connected(t, ada.app, ada.device);
  const moves = [
    transitionOf(
      ada.device,
      workspaceId,
      builder.agentId,
      first,
      "queued",
      "running",
    ),
    transitionOf(
      ada.device,
      workspaceId,
      builder.agentId,
      first,
      "running",
      "completed",
    ),
    transitionOf(
      ada.device,
      workspaceId,
      builder.agentId,
      second,
      "queued",
      "running",
      { reason: "Started" },
    ),
  ];
  for (const sent of moves) {
    client.send(sent);
    await nextRelayed(client, sent);
  }

  const runsAnswer = await get(bob, `/projects/${projectId}/runs`);
  assert.equal(runsAnswer.statusCode, 200, runsAnswer.body);
  const runs = AgentRunListResponseSchema.parse(runsAnswer.json());
  assert.deepEqual(
    runs.unfinishedRuns.map(({ id, state, reason }) => ({ id, state, reason })),
    [
      { id: third, state: "queued", reason: null },
      { id: second, state: "running", reason: "Started" },
    ],
  );
  assert.deepEqual(
    runs.finishedRuns.map(({ id, state }) => ({ id, state })),
    [{ id: first, state: "completed" }],
  );

  // A project without agents, and an archived project, still answer.
  await database()
    .update(projects)
    .set({ archivedAt: new Date() })
    .where(eq(projects.id, projectId));
  const archived = await get(ada, `/projects/${projectId}/runs`);
  assert.equal(archived.statusCode, 200, archived.body);
  const empty = await projectIn(workspaceId, ada.device, "Empty");
  assert.deepEqual(
    AgentListResponseSchema.parse(
      (await get(ada, `/projects/${empty}/agents`)).json(),
    ),
    { agents: [] },
  );
  assert.deepEqual(
    AgentRunListResponseSchema.parse(
      (await get(ada, `/projects/${empty}/runs`)).json(),
    ),
    { unfinishedRuns: [], finishedRuns: [] },
  );
});
