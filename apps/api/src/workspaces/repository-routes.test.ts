import {
  agents,
  auditEvents,
  type Database,
  devices,
  permissionGrants,
  projects,
  repositories,
  workspaceMembers,
} from "@mymandev/database";
import {
  type AgentId,
  ApiErrorBodySchema,
  CreateProjectResponseSchema,
  CreateWorkspaceResponseSchema,
  decodeEvent,
  decodeServerMessage,
  type MemberId,
  type MemberRole,
  newId,
  type PermissionGrantId,
  type ProjectId,
  type ProjectRepository,
  RegisterRepositoryResponseSchema,
  REPOSITORY_COUNT_LIMITS,
  type RepositoryId,
  RepositoryListResponseSchema,
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
import {
  type Client,
  connected,
  interceptingDatabase,
  settle,
} from "../gateway-test-support.ts";
import { ConnectionRegistry } from "../gateway.ts";
import type { WorkspaceEvent } from "./events.ts";

// The repository routes (#286): registering a repository in a project,
// listing a project's repositories, and removing one. A repository is an
// identity and a name; no path and no remote URL reaches the database, an
// answer, or an event. Each change sends its event to every connection
// subscribed to the project's workspace, after the commit.

const database = useTestDatabase();

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const { perProject: PER_PROJECT, perDay: PER_DAY } = REPOSITORY_COUNT_LIMITS;

/** A backslash, kept out of the string literals below. */
const BACKSLASH = String.fromCharCode(0x5c);

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
  return {
    clock,
    events,
    account,
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

function register(account: Account, projectId: string, name: string) {
  return post(account, `/projects/${projectId}/repositories`, { name });
}

function remove(account: Account, projectId: string, repositoryId: string) {
  return post(
    account,
    `/projects/${projectId}/repositories/${repositoryId}/remove`,
  );
}

async function list(account: Account, projectId: string) {
  const response = await get(account, `/projects/${projectId}/repositories`);
  assert.equal(response.statusCode, 200, response.body);
  return RepositoryListResponseSchema.parse(response.json()).repositories;
}

/** Registers a repository that must be registered. */
async function registered(account: Account, projectId: string, name: string) {
  const response = await register(account, projectId, name);
  assert.equal(response.statusCode, 200, response.body);
  return RegisterRepositoryResponseSchema.parse(response.json()).repository;
}

/** Removes a repository that must be removed. */
async function removed(
  account: Account,
  projectId: string,
  repositoryId: string,
) {
  const response = await remove(account, projectId, repositoryId);
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(response.body, "");
}

/** A workspace of the account with one project, created through the API. */
async function workspaceWithProject(owner: Account, name = "Research") {
  const created = await post(owner, "/workspaces", {
    name,
    displayName: "Ada at work",
  });
  assert.equal(created.statusCode, 200, created.body);
  const { workspace } = CreateWorkspaceResponseSchema.parse(created.json());
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

/** Inserts `n` repositories of the account directly, registered at `createdAt`. */
async function fill(
  projectId: ProjectId,
  by: Account,
  n: number,
  createdAt: Date,
): Promise<RepositoryId[]> {
  const rows = Array.from({ length: n }, (_, index) => ({
    id: newId<RepositoryId>(),
    projectId,
    name: `Filler ${index}`,
    createdByUserId: by.device.userId,
    createdAt,
  }));
  await database().insert(repositories).values(rows);
  return rows.map((row) => row.id);
}

function rowsOf(projectId: ProjectId) {
  return database()
    .select()
    .from(repositories)
    .where(eq(repositories.projectId, projectId));
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

test("a member registers, lists, and removes repositories, and each change sends its event from the system after the commit", async (t) => {
  const { account, events, clock } = instance(t);
  const owner = await account(3701);
  const member = await account(3702);
  const { workspace, project } = await workspaceWithProject(owner);
  const memberPerson = await addClaimed(workspace.id, member, owner);
  events.length = 0;

  const app = await registered(member, project.id, "App");
  assert.deepEqual(app, {
    id: app.id,
    projectId: project.id,
    name: "App",
    createdByMemberId: memberPerson,
  });
  const website = await registered(owner, project.id, "Website");
  assert.deepEqual(await list(owner, project.id), [app, website]);
  assert.deepEqual(await list(member, project.id), [app, website]);

  await removed(member, project.id, app.id);
  assert.deepEqual(await list(member, project.id), [website]);
  // Nothing is deleted: the row stays, with the time of its removal.
  const rows = await rowsOf(project.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.find((row) => row.id === app.id)?.archivedAt,
    new Date(clock.now()),
  );

  assert.deepEqual(
    events.map((event) => [event.type, event.payload]),
    [
      ["workspace.repository.registered", { repository: app }],
      ["workspace.repository.registered", { repository: website }],
      [
        "workspace.repository.removed",
        { projectId: project.id, repositoryId: app.id },
      ],
    ],
  );
  for (const event of events) {
    assert.ok(decodeEvent(event).ok, event.type);
    assert.equal(event.workspaceId, workspace.id);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    assert.equal(event.occurredAt, new Date(clock.now()).toISOString());
    assert.ok(Object.isFrozen(event.payload));
  }

  // Neither change is an administrative action of ADR 0014.
  const audited = await database()
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspace.id));
  assert.deepEqual(
    audited.map((record) => record.action),
    ["workspace.created"],
  );
});

test("a registration stores, answers, and sends the name only: a path or a remote URL beside it is dropped", async (t) => {
  const { account, events } = instance(t);
  const owner = await account(3711);
  const { project } = await workspaceWithProject(owner);
  events.length = 0;
  const path = "/srv/code/app";
  const url = "https://example.com/team/app.git";

  const response = await post(owner, `/projects/${project.id}/repositories`, {
    name: "App",
    path,
    localPath: path,
    rootPath: `D:${BACKSLASH}code${BACKSLASH}app`,
    remoteUrl: url,
    url,
    remote: { name: "origin", url },
    id: newId<RepositoryId>(),
    projectId: newId<ProjectId>(),
    createdByMemberId: newId<MemberId>(),
  });
  assert.equal(response.statusCode, 200, response.body);
  const { repository } = RegisterRepositoryResponseSchema.parse(
    response.json(),
  );
  assert.equal(repository.projectId, project.id);
  // The answer, the stored row, the list, and the event hold no more than
  // the repository's four fields, and nowhere the path or the URL.
  const answer = response.json() as { repository: Record<string, unknown> };
  assert.deepEqual(Object.keys(answer.repository).sort(), [
    "createdByMemberId",
    "id",
    "name",
    "projectId",
  ]);
  const [row] = await rowsOf(project.id);
  assert.deepEqual(row, {
    id: repository.id,
    projectId: project.id,
    name: "App",
    createdByUserId: owner.device.userId,
    createdAt: row?.createdAt,
    updatedAt: row?.updatedAt,
    archivedAt: null,
  });
  const listed = await get(owner, `/projects/${project.id}/repositories`);
  assert.deepEqual(listed.json(), { repositories: [repository] });
  assert.equal(events.length, 1);
  for (const text of [
    response.body,
    listed.body,
    JSON.stringify(row),
    JSON.stringify(events),
  ]) {
    assert.equal(text.includes(path), false);
    assert.equal(text.includes(url), false);
    for (const part of ["srv", "example.com", "origin", "D:"]) {
      assert.equal(text.includes(part), false, part);
    }
  }
});

test("a name that is malformed, or that holds a slash or a backslash, answers 400, and a name is a label that is stored as sent", async (t) => {
  const { account, events } = instance(t);
  const owner = await account(3721);
  const { project } = await workspaceWithProject(owner);
  events.length = 0;

  for (const payload of [
    {},
    { name: "" },
    { name: " " },
    { name: "a".repeat(101) },
    { name: "App\nWeb" },
    { name: "Ap\u200Bp" },
    { name: 7 },
    // A folder's path or a remote URL never travels as a name.
    { name: "/srv/code/app" },
    { name: "~/code/app" },
    { name: "code/app" },
    { name: `D:${BACKSLASH}code${BACKSLASH}app` },
    { name: `${BACKSLASH}${BACKSLASH}server${BACKSLASH}app` },
    { name: "https://example.com/team/app.git" },
    { name: "team/app" },
    // A path without a name is no registration either.
    { path: "/srv/code/app" },
  ]) {
    const response = await post(
      owner,
      `/projects/${project.id}/repositories`,
      payload,
    );
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(errorCode(response), "bad_request");
    // The error never repeats what was sent.
    assert.equal(response.body.includes("srv"), false);
    assert.equal(response.body.includes("example.com"), false);
  }
  assert.deepEqual(await rowsOf(project.id), []);
  assert.deepEqual([...events], [], "a refusal sends no event");

  // A label: neither normalized nor trimmed, and not unique in the project.
  const decomposed = " Cafe\u0301 ";
  const first = await registered(owner, project.id, decomposed);
  const second = await registered(owner, project.id, decomposed);
  assert.equal(first.name, decomposed);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(
    (await rowsOf(project.id)).map((row) => row.name),
    [decomposed, decomposed],
  );
  // A malformed repository ID is a malformed request.
  const malformed = await remove(owner, project.id, "not-an-id");
  assert.equal(malformed.statusCode, 400, malformed.body);
  const named = await remove(owner, project.id, "App");
  assert.equal(named.statusCode, 400, named.body);
});

test("the registering account, the owner, and an admin remove a repository; another member gets 403, and an unknown repository or one of another project the same 404", async (t) => {
  const { account, events } = instance(t);
  const owner = await account(3731);
  const admin = await account(3732);
  const registrant = await account(3733);
  const member = await account(3734);
  const { workspace, project } = await workspaceWithProject(owner);
  const other = await projectIn(owner, workspace.id, "Website");
  await addClaimed(workspace.id, admin, owner, "admin");
  await addClaimed(workspace.id, registrant, owner);
  await addClaimed(workspace.id, member, owner);
  const mine = await registered(registrant, project.id, "Mine");
  const forOwner = await registered(registrant, project.id, "For the owner");
  const forAdmin = await registered(registrant, project.id, "For the admin");
  const ofOwner = await registered(owner, project.id, "The owner's");
  const foreign = await registered(owner, other.id, "Foreign");
  events.length = 0;

  // A member removes only what its own account registered.
  for (const [by, repository] of [
    [member, mine],
    [registrant, ofOwner],
  ] as const) {
    const refused = await remove(by, project.id, repository.id);
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(errorCode(refused), "forbidden");
  }
  assert.deepEqual([...events], [], "a refusal sends no event");
  for (const [by, repository] of [
    [registrant, mine],
    [owner, forOwner],
    [admin, forAdmin],
  ] as const) {
    await removed(by, project.id, repository.id);
  }
  assert.deepEqual(
    events.map((event) =>
      event.type === "workspace.repository.removed"
        ? event.payload.repositoryId
        : null,
    ),
    [mine.id, forOwner.id, forAdmin.id],
  );
  assert.deepEqual(await list(member, project.id), [ofOwner]);

  const unknown = await remove(owner, project.id, newId<RepositoryId>());
  // Named through a project that does not hold it.
  const elsewhere = await remove(owner, project.id, foreign.id);
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), NOT_FOUND);
  assert.equal(elsewhere.body, unknown.body);
  // An unknown repository is not found before any right is checked.
  const forMember = await remove(member, project.id, newId<RepositoryId>());
  assert.equal(forMember.body, unknown.body);
  assert.deepEqual(await list(owner, other.id), [foreign]);
});

test(`a registration beyond ${PER_DAY} repositories of an account within 24 hours answers 429 with Retry-After, and the window slides`, async (t) => {
  const { account, clock } = instance(t);
  let owner = await account(3741);
  const { workspace, project: first } = await workspaceWithProject(owner);
  const second = await projectIn(owner, workspace.id, "Website");
  await registered(owner, first.id, "Repository 0");
  clock.advance(HOUR_MS);
  owner = await renewed(owner);
  for (let index = 1; index < PER_DAY; index += 1) {
    await registered(
      owner,
      index % 2 === 0 ? first.id : second.id,
      `R${index}`,
    );
  }

  const refused = await register(owner, second.id, "One more");
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(errorCode(refused), "rate_limited");
  // The first repository leaves the window 23 hours from now.
  assert.equal(
    refused.headers["retry-after"],
    String((DAY_MS - HOUR_MS) / 1000),
  );

  clock.advance(DAY_MS - HOUR_MS);
  owner = await renewed(owner);
  await registered(owner, second.id, "One more");
  const next = await register(owner, second.id, "And another");
  assert.equal(next.statusCode, 429);
  assert.equal(next.headers["retry-after"], String(HOUR_MS / 1000));
});

test(`a project with ${PER_PROJECT} repositories that are not removed answers 409 with repository_limit and no Retry-After, and a removal frees a place`, async (t) => {
  const { account, events } = instance(t);
  const owner = await account(3751);
  const { project } = await workspaceWithProject(owner);
  const ids = await fill(
    project.id,
    owner,
    PER_PROJECT,
    new Date(Date.now() - 2 * DAY_MS),
  );
  events.length = 0;

  // Its own code, not `rate_limited`: waiting does not help.
  const refused = await register(owner, project.id, "One more");
  assert.equal(refused.statusCode, 409, refused.body);
  assert.deepEqual(refused.json(), {
    statusCode: 409,
    error: "Conflict",
    message: "Conflict",
    code: "repository_limit",
  });
  assert.equal(ApiErrorBodySchema.safeParse(refused.json()).success, true);
  assert.equal(refused.headers["retry-after"], undefined);
  assert.deepEqual([...events], [], "a refusal sends no event");
  assert.equal((await list(owner, project.id)).length, PER_PROJECT);

  const [first] = ids;
  assert.ok(first !== undefined);
  await removed(owner, project.id, first);
  await registered(owner, project.id, "One more");
  assert.equal((await list(owner, project.id)).length, PER_PROJECT);
});

test("a registration at both limits of repositories answers repository_limit, and the account's limit alone still answers 429 with rate_limited", async (t) => {
  const { account, clock } = instance(t);
  const owner = await account(3761);
  const { project } = await workspaceWithProject(owner);
  // The account registered all of them within the last hour.
  const ids = await fill(
    project.id,
    owner,
    PER_PROJECT,
    new Date(clock.now() - HOUR_MS),
  );
  assert.ok(PER_PROJECT >= PER_DAY, "the project is full at the daily limit");

  const both = await register(owner, project.id, "One more");
  assert.equal(both.statusCode, 409, both.body);
  assert.equal(errorCode(both), "repository_limit");
  assert.equal(both.headers["retry-after"], undefined);

  const [first] = ids;
  assert.ok(first !== undefined);
  await removed(owner, project.id, first);
  const daily = await register(owner, project.id, "One more");
  assert.equal(daily.statusCode, 429, daily.body);
  assert.equal(errorCode(daily), "rate_limited");
  assert.equal(daily.headers["retry-after"], String((DAY_MS - HOUR_MS) / 1000));
});

test("an archived project answers 409 to a registration and to a removal, and still lists its repositories", async (t) => {
  const { account, events } = instance(t);
  const owner = await account(3771);
  const { project } = await workspaceWithProject(owner);
  const repository = await registered(owner, project.id, "App");
  await database()
    .update(projects)
    .set({ archivedAt: new Date() })
    .where(eq(projects.id, project.id));
  events.length = 0;

  for (const response of [
    await register(owner, project.id, "Website"),
    await remove(owner, project.id, repository.id),
  ]) {
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(errorCode(response), "conflict");
  }
  assert.deepEqual([...events], []);
  assert.deepEqual(await list(owner, project.id), [repository]);
});

test("a removal revokes the grants on the repository in its transaction, names no grant in its event, and a second removal answers 409", async (t) => {
  const { account, events, clock } = instance(t);
  const owner = await account(3781);
  const alice = await account(3782);
  const { workspace, project } = await workspaceWithProject(owner);
  await addClaimed(workspace.id, alice, owner);
  const repository = await registered(alice, project.id, "App");
  const kept = await registered(alice, project.id, "Website");
  const agentId = newId<AgentId>();
  await database().insert(agents).values({
    id: agentId,
    projectId: project.id,
    ownerUserId: alice.device.userId,
    hostDeviceId: alice.device.deviceId,
    name: "Builder",
  });
  const grant = async (
    repositoryId: RepositoryId,
    capability: "repo.read" | "repo.write",
  ) => {
    const id = newId<PermissionGrantId>();
    await database()
      .insert(permissionGrants)
      .values({
        id,
        projectId: project.id,
        granteeAgentId: agentId,
        hostDeviceId: alice.device.deviceId,
        capability,
        repositoryId,
        grantedByUserId: alice.device.userId,
        createdAt: new Date(clock.now() - HOUR_MS),
      });
    return id;
  };
  const read = await grant(repository.id, "repo.read");
  const write = await grant(repository.id, "repo.write");
  const onKept = await grant(kept.id, "repo.read");
  const grantRows = async () =>
    new Map(
      (
        await database()
          .select()
          .from(permissionGrants)
          .where(eq(permissionGrants.projectId, project.id))
      ).map((row) => [row.id, row]),
    );
  events.length = 0;

  // The owner removes what another account registered.
  await removed(owner, project.id, repository.id);
  const rows = await grantRows();
  for (const id of [read, write]) {
    assert.deepEqual(rows.get(id)?.revokedAt, new Date(clock.now()), id);
    assert.equal(rows.get(id)?.revokedByUserId, owner.device.userId, id);
  }
  assert.equal(rows.get(onKept)?.revokedAt, null);
  assert.deepEqual(
    events.map((event) => [event.type, event.payload]),
    [
      [
        "workspace.repository.removed",
        { projectId: project.id, repositoryId: repository.id },
      ],
    ],
  );

  // Removed once: the second removal changes nothing and sends nothing.
  clock.advance(60_000);
  const again = await remove(owner, project.id, repository.id);
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(errorCode(again), "conflict");
  assert.equal(events.length, 1);
  assert.deepEqual(await grantRows(), rows);
  assert.deepEqual(await list(owner, project.id), [kept]);
});

test("a non-member gets the 404 of an unknown project on every repository route, and so do a removed member and a malformed project ID", async (t) => {
  const { account, events } = instance(t);
  const owner = await account(3791);
  const former = await account(3792);
  const outsider = await account(3793);
  const { workspace, project } = await workspaceWithProject(owner);
  const person = await addClaimed(workspace.id, former, owner);
  const repository = await registered(former, project.id, "App");
  assert.equal((await list(former, project.id)).length, 1);
  await database()
    .update(workspaceMembers)
    .set({ removedAt: new Date(), removedByUserId: owner.device.userId })
    .where(eq(workspaceMembers.id, person));
  events.length = 0;

  const unknownId = newId<ProjectId>();
  for (const who of [former, outsider]) {
    for (const ask of [
      (id: string) => get(who, `/projects/${id}/repositories`),
      (id: string) => register(who, id, "Mine"),
      (id: string) => remove(who, id, repository.id),
      // The check comes before validation: a malformed body or repository
      // ID answers the same 404.
      (id: string) => post(who, `/projects/${id}/repositories`, {}),
      (id: string) => remove(who, id, "not-an-id"),
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
  // A member gets the same 404 for a project that does not exist.
  const missing = await register(owner, unknownId, "App");
  assert.deepEqual(missing.json(), NOT_FOUND);
  assert.deepEqual([...events], []);
  // The former member's repository stays, and names its former person.
  const expected: ProjectRepository = {
    ...repository,
    createdByMemberId: person,
  };
  assert.deepEqual(await list(owner, project.id), [expected]);
});

test("every connection subscribed to the project's workspace receives the repository events, whatever its person's role, and no other connection does", async (t) => {
  const { account } = instance(t);
  const ada = await account(3801);
  const bob = await account(3802);
  const cleo = await account(3803);
  const dan = await account(3804);
  const { workspace, project } = await workspaceWithProject(ada);
  await addClaimed(workspace.id, bob, ada);
  await addClaimed(workspace.id, dan, ada);
  // Cleo owns another workspace and is no member of Ada's.
  const { workspace: other } = await workspaceWithProject(cleo, "Elsewhere");

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

  // A member's registration reaches the owner and the member alike.
  const repository = await registered(bob, project.id, "App");
  for (const client of [adaClient, bobClient]) {
    const event = await nextEvent(client);
    assert.ok(event.type === "workspace.repository.registered", event.type);
    assert.equal(event.workspaceId, workspace.id);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    assert.deepEqual(event.payload, { repository });
  }
  await quiet(...everyone);

  // The owner's removal reaches both too.
  await removed(ada, project.id, repository.id);
  for (const client of [adaClient, bobClient]) {
    const event = await nextEvent(client);
    assert.ok(event.type === "workspace.repository.removed", event.type);
    assert.equal(event.workspaceId, workspace.id);
    assert.deepEqual(event.payload, {
      projectId: project.id,
      repositoryId: repository.id,
    });
  }
  await quiet(...everyone);
});

test("a refused or rolled-back change sends no repository event, and the same change sends one once it commits", async (t) => {
  const { account, events, failNextCommit, failedCommits } = instance(t);
  const ada = await account(3811);
  const bob = await account(3812);
  const { workspace, project } = await workspaceWithProject(ada);
  await addClaimed(workspace.id, bob, ada);
  const repository = await registered(ada, project.id, "App");
  const adaClient = (await connected(t, ada.app, ada.device)).client;
  const bobClient = (await connected(t, bob.app, bob.device)).client;
  await subscribed(adaClient, workspace.id);
  await subscribed(bobClient, workspace.id);
  await drainPresence(adaClient, bobClient);
  events.length = 0;
  const before = await rowsOf(project.id);

  // Refused: a member removes another account's repository, an unknown
  // repository, and a malformed name.
  for (const [response, status] of [
    [await remove(bob, project.id, repository.id), 403],
    [await remove(ada, project.id, newId<RepositoryId>()), 404],
    [await register(bob, project.id, "team/app"), 400],
  ] as const) {
    assert.equal(response.statusCode, status, response.body);
  }
  await quiet(adaClient, bobClient);

  // Rolled back: each change ran to its end, and its commit failed.
  const rolledBack = [
    () => register(bob, project.id, "Website"),
    () => remove(ada, project.id, repository.id),
  ];
  for (const change of rolledBack) {
    failNextCommit();
    const response = await change();
    assert.equal(response.statusCode, 500, response.body);
  }
  // Each route's own transaction failed, not one that ran before it.
  assert.deepEqual(
    failedCommits(),
    Array(rolledBack.length).fill("repository-routes.ts"),
  );
  assert.deepEqual(await rowsOf(project.id), before);
  await quiet(adaClient, bobClient);
  assert.deepEqual([...events], []);

  // Committed, the same changes send their events.
  const website = await registered(bob, project.id, "Website");
  await removed(ada, project.id, repository.id);
  for (const client of [adaClient, bobClient]) {
    const first = await nextEvent(client);
    assert.ok(first.type === "workspace.repository.registered", first.type);
    assert.deepEqual(first.payload, { repository: website });
    const second = await nextEvent(client);
    assert.ok(second.type === "workspace.repository.removed", second.type);
    assert.equal(second.payload.repositoryId, repository.id);
  }
  assert.deepEqual(
    events.map((event) => event.type),
    ["workspace.repository.registered", "workspace.repository.removed"],
  );
});

test("a member removed, or a device revoked, after the membership check and before the change gets the 404 or the 401, and nothing changes", async (t) => {
  // The route's transaction starts only after `beforeTransaction` ran, as if
  // the change had committed between the membership check and the route's.
  let beforeTransaction: (() => Promise<unknown>) | null = null;
  const racing = new Proxy(database(), {
    get(target, property, receiver) {
      const run = beforeTransaction;
      if (property === "transaction" && run !== null) {
        beforeTransaction = null;
        return async (...args: Parameters<Database["transaction"]>) => {
          await run();
          return target.transaction(...args);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const { account } = instance(t);
  const owner = await account(3821);
  const events: WorkspaceEvent[] = [];
  const racingAccount = async (githubId: number): Promise<Account> => {
    const app = await deviceApp(t, {
      database: racing,
      githubId,
      onWorkspaceEvent: (event) => {
        events.push(event);
      },
    });
    const device = await signInDevice(app);
    return { app, device, token: await accessToken(app, device) };
  };
  const member = await racingAccount(3822);
  const { workspace, project } = await workspaceWithProject(owner);
  const first = await addClaimed(workspace.id, member, owner);
  const repository = await registered(member, project.id, "App");
  events.length = 0;
  const before = await rowsOf(project.id);
  const removePerson = (id: MemberId) => () =>
    database()
      .update(workspaceMembers)
      .set({ removedAt: new Date(), removedByUserId: owner.device.userId })
      .where(eq(workspaceMembers.id, id));
  const unknownId = newId<ProjectId>();

  beforeTransaction = removePerson(first);
  const refusedRegistration = await register(member, project.id, "Website");
  assert.equal(beforeTransaction, null, "the route's transaction started");
  assert.equal(refusedRegistration.statusCode, 404);
  assert.equal(
    refusedRegistration.body,
    (await register(member, unknownId, "Website")).body,
  );

  // The account joins again and is removed before its removal's transaction.
  const second = await addClaimed(workspace.id, member, owner);
  beforeTransaction = removePerson(second);
  const refusedRemoval = await remove(member, project.id, repository.id);
  assert.equal(beforeTransaction, null, "the route's transaction started");
  assert.equal(refusedRemoval.statusCode, 404);
  assert.equal(
    refusedRemoval.body,
    (await remove(member, unknownId, repository.id)).body,
  );

  // A device revoked in between may no longer act: each change checks the
  // account and the device again inside its transaction.
  await addClaimed(workspace.id, member, owner);
  const revokeDevice = () =>
    database()
      .update(devices)
      .set({ revokedAt: new Date(), revocationReason: "removed" })
      .where(eq(devices.id, member.device.deviceId));
  const restoreDevice = () =>
    database()
      .update(devices)
      .set({ revokedAt: null, revocationReason: null })
      .where(eq(devices.id, member.device.deviceId));
  for (const change of [
    () => register(member, project.id, "Website"),
    () => remove(member, project.id, repository.id),
  ]) {
    beforeTransaction = revokeDevice;
    const response = await change();
    assert.equal(beforeTransaction, null, "the route's transaction started");
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(errorCode(response), "unauthorized");
    await restoreDevice();
  }

  assert.deepEqual(await rowsOf(project.id), before);
  assert.deepEqual([...events], [], "a refusal sends no event");
  // Without a race, the same changes pass.
  await registered(member, project.id, "Website");
  await removed(member, project.id, repository.id);
  assert.equal(events.length, 2);
});

test("a member removed after the membership check and before the list is read gets the same 404", async (t) => {
  const intercepting = interceptingDatabase(database());
  const { account } = instance(t);
  const owner = await account(3831);
  const app = await deviceApp(t, {
    database: intercepting.database,
    githubId: 3832,
  });
  const device = await signInDevice(app);
  const reader: Account = {
    app,
    device,
    token: await accessToken(app, device),
  };
  const { workspace, project } = await workspaceWithProject(owner);
  const person = await addClaimed(workspace.id, reader, owner);
  const repository = await registered(owner, project.id, "App");
  // A request reads the project twice: the membership check, then the list.
  // `between` runs after the first and before the second.
  const readWith = async (between: () => Promise<unknown>) => {
    const started = intercepting.started("select", projects);
    intercepting.interceptNext("select", projects, () => {
      intercepting.interceptNext("select", projects, between);
      return Promise.resolve();
    });
    const response = await get(reader, `/projects/${project.id}/repositories`);
    assert.equal(intercepting.started("select", projects) - started, 2);
    return response;
  };

  let ran = 0;
  const unchanged = await readWith(() => {
    ran += 1;
    return Promise.resolve();
  });
  assert.equal(ran, 1, "the step between the check and the list ran");
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  assert.deepEqual(unchanged.json(), { repositories: [repository] });

  const refused = await readWith(() =>
    database()
      .update(workspaceMembers)
      .set({ removedAt: new Date(), removedByUserId: owner.device.userId })
      .where(eq(workspaceMembers.id, person)),
  );
  assert.equal(refused.statusCode, 404, refused.body);
  assert.deepEqual(refused.json(), NOT_FOUND);
  const unknown = await get(
    reader,
    `/projects/${newId<ProjectId>()}/repositories`,
  );
  assert.equal(refused.body, unknown.body);
});

test("the repository routes need a valid access token", async (t) => {
  const { account } = instance(t);
  const owner = await account(3841);
  const { project } = await workspaceWithProject(owner);
  const repository = await registered(owner, project.id, "App");
  for (const [method, url, payload] of [
    ["GET", `/projects/${project.id}/repositories`, undefined],
    ["POST", `/projects/${project.id}/repositories`, { name: "Website" }],
    [
      "POST",
      `/projects/${project.id}/repositories/${repository.id}/remove`,
      undefined,
    ],
  ] as const) {
    for (const headers of [{}, { authorization: "Bearer not-a-token" }]) {
      const response = await owner.app.inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
      assert.equal(response.statusCode, 401, url);
      assert.equal(errorCode(response), "unauthorized");
    }
  }
  assert.deepEqual(await list(owner, project.id), [repository]);
});
