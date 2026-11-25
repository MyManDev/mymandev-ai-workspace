import {
  agentRuns,
  agents,
  type Database,
  encodeErasureNotification,
  ERASED_AGENT_NAME,
  eraseAccount,
  ERASURE_NOTIFICATION_CHANNEL,
  LISTENER_APPLICATION_NAME,
  type NotificationSessions,
  permissionGrants,
  projects,
  repositories,
  workspaceJoinRequests,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  createTestDatabase,
  type TestDatabase,
} from "@mymandev/database/testing";
import {
  type AgentId,
  type DeviceId,
  type JoinRequestId,
  type MemberId,
  type MemberRole,
  newId,
  type PermissionGrantId,
  type ProjectId,
  type RepositoryId,
  type RunId,
  type UserId,
  type WorkspaceId,
} from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
import {
  accessToken,
  deviceApp,
  type SignedInDevice,
  signInDevice,
} from "../auth/device-test-support.ts";
import {
  type Client,
  closedWith,
  connected,
  nextFrame,
  settle,
  until,
} from "../gateway-test-support.ts";
import { ConnectionRegistry } from "../gateway.ts";
import type { ApproverEvent, WorkspaceEvent } from "./events.ts";

// The live events of an operator's account erasure (#341): the erasure's
// transaction sends notifications, and the API instance's listener replays
// them through the senders of its own routes. Every comparison with a route
// runs the route and the erasure on twin workspaces and compares what a
// third person's connection receives, with IDs, times, and the agent's name
// replaced by placeholders. The listener runs on PGlite's `listen`, or on a
// dedicated session of the server with DATABASE_TEST_URL.

let testDatabase: TestDatabase | undefined;

before(async () => {
  testDatabase = await createTestDatabase();
});

after(async () => {
  await testDatabase?.close();
});

function database(): Database {
  assert.ok(testDatabase, "the test database is created in before()");
  return testDatabase.db;
}

type Account = Readonly<{
  app: FastifyInstance;
  device: SignedInDevice;
  token: string;
}>;

type Observed = Readonly<{
  workspace: WorkspaceEvent[];
  approver: (readonly [ApproverEvent, readonly MemberId[]])[];
}>;

/**
 * One API instance: each account signs in through its own app, every app
 * shares one registry and the database, and only the first app listens for
 * erasures, as one instance holds one listener. `observed` collects every
 * workspace and approver event that the listening app sends.
 */
async function instance(
  t: TestContext,
  options: Readonly<{
    sessions?: NotificationSessions;
    logLines?: string[];
    backoff?: Readonly<{ initialMs: number; maxMs: number }>;
  }> = {},
) {
  assert.ok(testDatabase);
  const sessions = options.sessions ?? testDatabase.notificationSessions;
  const connections = new ConnectionRegistry();
  const observed: Observed = { workspace: [], approver: [] };
  let listening = false;
  const account = async (githubId: number): Promise<Account> => {
    const listens = !listening;
    listening = true;
    const app = await deviceApp(t, {
      database: database(),
      githubId,
      connections,
      ...(listens
        ? {
            erasureNotifications: sessions,
            onWorkspaceEvent: (event) => {
              observed.workspace.push(event);
            },
            onApproverEvent: (event, approvers) => {
              observed.approver.push([event, approvers]);
            },
            ...(options.logLines === undefined
              ? {}
              : { logLines: options.logLines }),
            ...(options.backoff === undefined
              ? {}
              : { erasureListenerBackoff: options.backoff }),
          }
        : {}),
    });
    // injectWS never settles unless the app is ready; ready also starts the
    // listener of the first app.
    await app.ready();
    const device = await signInDevice(app);
    return { app, device, token: await accessToken(app, device) };
  };
  return { connections, observed, account };
}

async function workspaceOf(
  owner: SignedInDevice,
  people: readonly (readonly [SignedInDevice, MemberRole])[] = [],
) {
  const workspaceId = newId<WorkspaceId>();
  await database()
    .insert(workspaces)
    .values({ id: workspaceId, name: "Team", createdByUserId: owner.userId });
  const person = async (userId: UserId | null, role: MemberRole) => {
    const id = newId<MemberId>();
    await database()
      .insert(workspaceMembers)
      .values({
        id,
        workspaceId,
        userId,
        displayName: "Someone",
        role,
        addedByUserId: owner.userId,
        ...(userId === null ? {} : { claimedAt: new Date() }),
      });
    return id;
  };
  const ownerId = await person(owner.userId, "owner");
  const memberIds: MemberId[] = [];
  for (const [device, role] of people) {
    memberIds.push(await person(device.userId, role));
  }
  return {
    workspaceId,
    ownerId,
    memberIds,
    unclaimed: () => person(null, "member"),
  };
}

/**
 * A project of the workspace with an agent of `host` on its device, a
 * `repo.read` grant to the agent, and a queued run on it.
 */
async function agentWithWork(workspaceId: WorkspaceId, host: SignedInDevice) {
  const projectId = newId<ProjectId>();
  await database().insert(projects).values({
    id: projectId,
    workspaceId,
    name: "App",
    createdByUserId: host.userId,
  });
  const repositoryId = newId<RepositoryId>();
  await database().insert(repositories).values({
    id: repositoryId,
    projectId,
    name: "app",
    createdByUserId: host.userId,
  });
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
  const grantId = newId<PermissionGrantId>();
  await database()
    .insert(permissionGrants)
    .values({
      id: grantId,
      projectId,
      granteeAgentId: agentId,
      hostDeviceId: host.deviceId as DeviceId,
      capability: "repo.read",
      repositoryId,
      grantedByUserId: host.userId,
    });
  const runId = newId<RunId>();
  await database().insert(agentRuns).values({
    id: runId,
    agentId,
    projectId,
    requestedByUserId: host.userId,
    state: "queued",
  });
  return { projectId, agentId, grantId, runId };
}

async function pendingRequest(
  who: SignedInDevice,
  workspaceId: WorkspaceId,
): Promise<JoinRequestId> {
  const id = newId<JoinRequestId>();
  await database()
    .insert(workspaceJoinRequests)
    .values({
      id,
      workspaceId,
      requesterUserId: who.userId,
      requesterDeviceId: who.deviceId as DeviceId,
      requestedDisplayName: "Requester",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
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

async function subscribe(client: Client, workspaceId: WorkspaceId) {
  client.send({ protocolVersion: 0, type: "workspace.subscribe", workspaceId });
  const frame = await nextFrame(client);
  assert.ok(
    frame.type === "workspace.subscribed" && frame.workspaceId === workspaceId,
    JSON.stringify(frame),
  );
}

/** The next `count` messages of the client, as sent. */
async function messages(client: Client, count: number): Promise<unknown[]> {
  const read: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    read.push(await client.next());
  }
  return read;
}

/** Lets pending frames arrive, then checks that none is left unread. */
async function quiet(...clients: Client[]) {
  await settle();
  for (const client of clients) {
    assert.equal(client.unread(), 0);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * The messages with each ID replaced by a placeholder numbered in the order
 * of first appearance, each time by one placeholder, and each agent's name
 * by one placeholder: two runs of the same change compare equal.
 */
function shape(sent: readonly unknown[]): unknown {
  const ids = new Map<string, string>();
  const walk = (value: unknown, key?: string): unknown => {
    if (key === "name" && typeof value === "string") {
      return "<name>";
    }
    if (typeof value === "string") {
      if (UUID.test(value)) {
        if (!ids.has(value)) {
          ids.set(value, `<id ${ids.size}>`);
        }
        return ids.get(value);
      }
      return TIMESTAMP.test(value) ? "<time>" : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item));
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, walk(item, name)]),
      );
    }
    return value;
  };
  return sent.map((message) => walk(message));
}

test("an erasure closes the account's connections at once and sends the remaining subscribers each ended membership, disabled agent, revoked grant, and cancelled run exactly as a removal through the route does", async (t) => {
  const { connections, observed, account } = await instance(t);
  const ada = await account(34101);
  const bob = await account(34102);
  const cleo = await account(34103);
  const erin = await account(34104);
  const erinsDesktop = await signInDevice(erin.app);

  // Twin workspaces: Bob is removed from the first through the route, Erin
  // is erased with a person in the second; Cleo watches both.
  const removal = await workspaceOf(ada.device, [
    [bob.device, "member"],
    [cleo.device, "member"],
  ]);
  const erasure = await workspaceOf(ada.device, [
    [erin.device, "member"],
    [cleo.device, "member"],
  ]);
  const [bobInRemoval] = removal.memberIds;
  const [erinInErasure] = erasure.memberIds;
  assert.ok(bobInRemoval !== undefined && erinInErasure !== undefined);
  const bobsWork = await agentWithWork(removal.workspaceId, bob.device);
  const erinsWork = await agentWithWork(erasure.workspaceId, erin.device);

  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  const erinsLaptop = (await connected(t, erin.app, erin.device)).client;
  const erinsOther = (await connected(t, erin.app, erinsDesktop)).client;
  await subscribe(cleoClient, removal.workspaceId);
  await subscribe(cleoClient, erasure.workspaceId);
  await subscribe(bobClient, removal.workspaceId);
  await subscribe(erinsLaptop, erasure.workspaceId);
  // Cleo sees Bob and Erin come online.
  await messages(cleoClient, 2);
  await quiet(cleoClient, bobClient, erinsLaptop, erinsOther);

  const removed = await post(
    ada,
    `/workspaces/${removal.workspaceId}/members/${bobInRemoval}/remove`,
  );
  assert.equal(removed.statusCode, 204, removed.body);
  const byRoute = await messages(cleoClient, 5);
  await messages(bobClient, 2);
  await quiet(cleoClient, bobClient, erinsLaptop, erinsOther);

  const erased = await eraseAccount(database(), {
    userId: erin.device.userId,
    now: new Date(),
  });
  assert.ok(erased.erased);
  // Every connection of Erin's closes at once with the reason of the sweep,
  // which would close them only within 60 seconds.
  assert.deepEqual(await erinsLaptop.closed, closedWith("device_revoked"));
  assert.deepEqual(await erinsOther.closed, closedWith("device_revoked"));
  assert.equal(
    connections
      .live()
      .filter(({ context }) => context.identity.userId === erin.device.userId)
      .length,
    0,
  );
  const byErasure = await messages(cleoClient, 5);
  await quiet(cleoClient, bobClient);

  // Cleo gets the same messages in the same order: Bob or Erin offline, the
  // removal, the agent disabled, the grant revoked, and the run cancelled.
  assert.deepEqual(shape(byErasure), shape(byRoute));
  assert.deepEqual(
    byErasure.map((message) => (message as { type: string }).type),
    [
      "presence.changed",
      "workspace.member.removed",
      "workspace.agent.disabled",
      "agent.grant.revoked",
      "agent.run.state_changed",
    ],
  );
  const [, removedEvent, disabledEvent, revokedEvent, runEvent] =
    byErasure as Record<string, unknown>[];
  assert.deepEqual(removedEvent?.["payload"], {
    memberId: erinInErasure,
    removedAt: (removedEvent?.["payload"] as { removedAt: string }).removedAt,
  });
  assert.deepEqual(disabledEvent?.["payload"], {
    agent: {
      id: erinsWork.agentId,
      projectId: erinsWork.projectId,
      name: ERASED_AGENT_NAME,
      ownerMemberId: erinInErasure,
      disabledAt: (removedEvent?.["payload"] as { removedAt: string })
        .removedAt,
    },
  });
  assert.equal(
    (revokedEvent?.["payload"] as { grantId: string }).grantId,
    erinsWork.grantId,
  );
  assert.deepEqual(runEvent?.["payload"], {
    runId: erinsWork.runId,
    agentId: erinsWork.agentId,
    previousState: "queued",
    state: "cancelled",
    reason: "member_removed",
  });
  assert.equal(
    (byRoute[3] as { payload: { grantId: string } }).payload.grantId,
    bobsWork.grantId,
  );
  // The handlers saw the erasure's removal and disabled agent as the
  // route's; the replayed ones carry the system actor.
  const erasureEvents = observed.workspace.filter(
    (event) => event.workspaceId === erasure.workspaceId,
  );
  assert.deepEqual(
    erasureEvents.map((event) => [event.type, event.actor, event.deviceId]),
    [
      ["workspace.member.removed", { kind: "system" }, null],
      ["workspace.agent.disabled", { kind: "system" }, null],
    ],
  );
});

test("approvers get workspace.join_request.resolved for each request that an erasure withdrew, exactly as after a withdrawal through the route; a member gets nothing", async (t) => {
  const { observed, account } = await instance(t);
  const dana = await account(34201);
  const ada = await account(34202);
  const cleo = await account(34203);
  const fay = await account(34204);
  const erin = await account(34205);
  const team = await workspaceOf(dana.device, [
    [ada.device, "admin"],
    [cleo.device, "member"],
  ]);
  const [adaInTeam] = team.memberIds;
  assert.ok(adaInTeam !== undefined);
  const faysRequest = await pendingRequest(fay.device, team.workspaceId);
  const erinsRequest = await pendingRequest(erin.device, team.workspaceId);

  const danaClient = (await connected(t, dana.app, dana.device)).client;
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const cleoClient = (await connected(t, cleo.app, cleo.device)).client;
  await subscribe(danaClient, team.workspaceId);
  await subscribe(adaClient, team.workspaceId);
  await messages(danaClient, 1);
  await subscribe(cleoClient, team.workspaceId);
  await messages(danaClient, 1);
  await messages(adaClient, 1);
  await quiet(danaClient, adaClient, cleoClient);

  const withdrawn = await post(fay, `/join-requests/${faysRequest}/withdraw`);
  assert.equal(withdrawn.statusCode, 204, withdrawn.body);
  const byRoute = [
    ...(await messages(danaClient, 1)),
    ...(await messages(adaClient, 1)),
  ];
  await quiet(danaClient, adaClient, cleoClient);

  const erased = await eraseAccount(database(), {
    userId: erin.device.userId,
    now: new Date(),
  });
  assert.ok(erased.erased);
  assert.deepEqual(erased.withdrawnJoinRequestIds, [erinsRequest]);
  const byErasure = [
    ...(await messages(danaClient, 1)),
    ...(await messages(adaClient, 1)),
  ];
  await quiet(danaClient, adaClient, cleoClient);

  assert.deepEqual(shape(byErasure), shape(byRoute));
  for (const message of byErasure) {
    const event = message as Record<string, unknown>;
    assert.equal(event["type"], "workspace.join_request.resolved");
    assert.deepEqual(event["payload"], {
      joinRequestId: erinsRequest,
      outcome: "withdrawn",
    });
  }
  const [, approvers] = observed.approver.at(-1) ?? [];
  assert.deepEqual(approvers, [team.ownerId, adaInTeam].sort());
});

test("a workspace that the erasure archived gets no event, and nobody hears of its denied requests", async (t) => {
  const { observed, account } = await instance(t);
  const erin = await account(34301);
  const gus = await account(34302);
  const alone = await workspaceOf(erin.device);
  await alone.unclaimed();
  await agentWithWork(alone.workspaceId, erin.device);
  await pendingRequest(gus.device, alone.workspaceId);

  const erinClient = (await connected(t, erin.app, erin.device)).client;
  const gusClient = (await connected(t, gus.app, gus.device)).client;
  await subscribe(erinClient, alone.workspaceId);
  await quiet(erinClient, gusClient);

  const erased = await eraseAccount(database(), {
    userId: erin.device.userId,
    now: new Date(),
  });
  assert.ok(erased.erased);
  assert.deepEqual(
    erased.archivedWorkspaces.map((archive) => archive.workspaceId),
    [alone.workspaceId],
  );
  assert.deepEqual(await erinClient.closed, closedWith("device_revoked"));
  await quiet(gusClient);
  assert.deepEqual(observed.workspace, []);
  assert.deepEqual(observed.approver, []);
});

test("a malformed, unknown, or foreign notification is ignored and logged without its content, and the next one is still replayed", async (t) => {
  assert.ok(testDatabase);
  const logLines: string[] = [];
  const { account } = await instance(t, { logLines });
  const erin = await account(34401);
  const erinClient = (await connected(t, erin.app, erin.device)).client;
  const at = new Date().toISOString();
  const valid = encodeErasureNotification({
    v: 1,
    kind: "account_erased",
    at,
    userId: erin.device.userId,
  });
  const marker = "do-not-log-this";
  const ignored = [
    `${marker} is not JSON`,
    JSON.stringify([marker]),
    JSON.stringify({ v: 2, kind: "account_erased", at, userId: marker }),
    JSON.stringify({ v: 1, kind: "account_restored", at, userId: marker }),
    JSON.stringify({ v: 1, kind: "account_erased", at, userId: marker }),
    JSON.stringify({ ...JSON.parse(valid), extra: marker }),
    JSON.stringify({
      v: 1,
      kind: "join_request_withdrawn",
      at,
      workspaceId: newId<WorkspaceId>(),
      joinRequestId: newId<JoinRequestId>(),
      approvers: [],
    }),
  ];
  for (const payload of ignored) {
    await testDatabase.client.query("select pg_notify($1, $2)", [
      ERASURE_NOTIFICATION_CHANNEL,
      payload,
    ]);
  }
  await until(
    () =>
      logLines.filter((line) => line.includes("erasure notification ignored"))
        .length === ignored.length,
    "the ignored notifications",
  );
  await quiet(erinClient);
  assert.equal(erinClient.ws.readyState, erinClient.ws.OPEN);

  await testDatabase.client.query("select pg_notify($1, $2)", [
    ERASURE_NOTIFICATION_CHANNEL,
    valid,
  ]);
  assert.deepEqual(await erinClient.closed, closedWith("device_revoked"));

  const reasons = logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["msg"] === "erasure notification ignored")
    .map((entry) => entry["reason"]);
  assert.deepEqual(reasons, [
    "malformed",
    "malformed",
    "unknown_version",
    "unknown_kind",
    "malformed",
    "malformed",
    "malformed",
  ]);
  for (const line of logLines) {
    assert.equal(line.includes(marker), false, line);
  }
  assert.ok(
    logLines.some((line) => line.includes("erasure listener listening")),
  );
});

test("the listener's session closes when the app closes, and an app whose listener cannot connect still starts and tries again", async (t) => {
  assert.ok(testDatabase);
  const real = testDatabase.notificationSessions;
  let opened = 0;
  let closed = 0;
  const counted: NotificationSessions = async () => {
    const session = await real();
    opened += 1;
    return {
      listen: session.listen,
      close: async () => {
        closed += 1;
        await session.close();
      },
    };
  };
  const { account } = await instance(t, { sessions: counted });
  const erin = await account(34501);
  assert.equal(opened, 1);
  await erin.app.close();
  assert.equal(closed, 1);

  // A database that cannot be reached: the app starts, logs the error's
  // type only, and tries again after the wait.
  let attempts = 0;
  const unreachable: NotificationSessions = () => {
    attempts += 1;
    return Promise.reject(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
  };
  const logLines: string[] = [];
  const other = await instance(t, {
    sessions: unreachable,
    logLines,
    backoff: { initialMs: 5, maxMs: 10 },
  });
  await other.account(34502);
  await until(() => attempts >= 3, "three attempts");
  const failures = logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["msg"] === "erasure listener could not listen");
  assert.ok(failures.length >= 2);
  assert.deepEqual(failures[0]?.["errorType"], "Error");
  for (const line of logLines) {
    assert.equal(line.includes("10.0.0.1"), false, line);
  }
});

const SERVER_ONLY = {
  skip:
    process.env["DATABASE_TEST_URL"] === undefined &&
    "needs DATABASE_TEST_URL; a PGlite session is never lost",
};

test(
  "after the server ends the listener's session, the listener connects again and replays the next erasure; at shutdown its session ends",
  SERVER_ONLY,
  async (t) => {
    assert.ok(testDatabase);
    const client = testDatabase.client;
    const listenerSessions = async () =>
      (
        await client.query<{ sessions: number }>(
          "select count(*)::int as sessions from pg_stat_activity where datname = current_database() and application_name = $1",
          [LISTENER_APPLICATION_NAME],
        )
      ).rows[0]?.sessions ?? 0;
    const logLines: string[] = [];
    const { account } = await instance(t, {
      logLines,
      backoff: { initialMs: 20, maxMs: 100 },
    });
    const ada = await account(34601);
    const erin = await account(34602);
    const team = await workspaceOf(ada.device, [[erin.device, "member"]]);
    const adaClient = (await connected(t, ada.app, ada.device)).client;
    const erinClient = (await connected(t, erin.app, erin.device)).client;
    await subscribe(adaClient, team.workspaceId);
    await subscribe(erinClient, team.workspaceId);
    await messages(adaClient, 1);
    assert.equal(await listenerSessions(), 1);

    await client.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and application_name = $1",
      [LISTENER_APPLICATION_NAME],
    );
    await until(
      () =>
        logLines.some((line) =>
          line.includes("erasure listener lost its database session"),
        ),
      "the lost session",
    );
    await until(
      () =>
        logLines.filter((line) => line.includes("erasure listener listening"))
          .length === 2,
      "the new session",
    );

    const erased = await eraseAccount(database(), {
      userId: erin.device.userId,
      now: new Date(),
    });
    assert.ok(erased.erased);
    assert.deepEqual(await erinClient.closed, closedWith("device_revoked"));
    const replayed = await messages(adaClient, 2);
    assert.deepEqual(
      replayed.map((message) => (message as { type: string }).type),
      ["presence.changed", "workspace.member.removed"],
    );

    await ada.app.close();
    await until(
      async () => (await listenerSessions()) === 0,
      "the listener's session to end",
    );
  },
);
