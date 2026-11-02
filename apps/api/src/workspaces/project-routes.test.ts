import {
  auditEvents,
  conversations,
  MAX_ACTIVE_PROJECTS_PER_WORKSPACE,
  MAX_NEW_PROJECTS_PER_DAY,
  projects,
  workspaceMembers,
} from "@mymandev/database";
import {
  CreateProjectResponseSchema,
  CreateWorkspaceResponseSchema,
  decodeEvent,
  decodeServerMessage,
  type MemberId,
  type MemberRole,
  newId,
  type ProjectId,
  ProjectListResponseSchema,
  type WorkspaceId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  accessToken,
  deviceApp,
  type DeviceAppOptions,
  fakeClock,
  signInDevice,
  type SignedInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";
import { connected, nextFrame } from "../gateway-test-support.ts";
import type { WorkspaceEvent } from "./events.ts";

const database = useTestDatabase();

type App = FastifyInstance;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function workspaceApp(
  t: TestContext,
  options: Omit<DeviceAppOptions, "database">,
): Promise<App> {
  return deviceApp(t, { database: database(), ...options });
}

/** A signed-in device of the app's account and an access token for it. */
async function signedIn(app: App) {
  const device = await signInDevice(app);
  return { app, device, token: await accessToken(app, device) };
}

type Session = Awaited<ReturnType<typeof signedIn>>;

function get(session: Session, url: string) {
  return session.app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${session.token}` },
  });
}

function post(session: Session, url: string, payload?: object) {
  return session.app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${session.token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

function create(session: Session, workspaceId: string, name: string) {
  return post(session, `/workspaces/${workspaceId}/projects`, { name });
}

function rename(
  session: Session,
  workspaceId: string,
  projectId: string,
  name: string,
) {
  return post(
    session,
    `/workspaces/${workspaceId}/projects/${projectId}/rename`,
    { name },
  );
}

async function list(session: Session, workspaceId: string) {
  const response = await get(session, `/workspaces/${workspaceId}/projects`);
  assert.equal(response.statusCode, 200, response.body);
  return ProjectListResponseSchema.parse(response.json()).projects;
}

/** Creates a project that must be created. */
async function created(session: Session, workspaceId: string, name: string) {
  const response = await create(session, workspaceId, name);
  assert.equal(response.statusCode, 200, response.body);
  return CreateProjectResponseSchema.parse(response.json()).project;
}

async function createWorkspace(session: Session, name = "Research") {
  const response = await post(session, "/workspaces", {
    name,
    displayName: "Ada at work",
  });
  assert.equal(response.statusCode, 200, response.body);
  return CreateWorkspaceResponseSchema.parse(response.json()).workspace;
}

/** Adds the device's account to the workspace as a claimed person. */
async function addClaimed(
  workspaceId: WorkspaceId,
  device: SignedInDevice,
  addedBy: SignedInDevice,
  role: MemberRole = "member",
): Promise<MemberId> {
  const id = newId<MemberId>();
  await database().insert(workspaceMembers).values({
    id,
    workspaceId,
    userId: device.userId,
    displayName: "Grace",
    role,
    addedByUserId: addedBy.userId,
    claimedAt: new Date(),
  });
  return id;
}

/** Collects the workspace events that an app hands to `onWorkspaceEvent`. */
function recorder() {
  const events: WorkspaceEvent[] = [];
  return {
    events,
    onWorkspaceEvent: (event: WorkspaceEvent) => {
      events.push(event);
    },
  };
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

test("a member creates, lists, and renames projects, and each change sends its event from the system after the commit", async (t) => {
  const recorded = recorder();
  const clock = fakeClock();
  const owner = await signedIn(
    await workspaceApp(t, { githubId: 3501, now: clock.now, ...recorded }),
  );
  const member = await signedIn(
    await workspaceApp(t, { githubId: 3502, now: clock.now, ...recorded }),
  );
  const workspace = await createWorkspace(owner);
  await addClaimed(workspace.id, member.device, owner.device);

  const app = await created(member, workspace.id, "App");
  assert.deepEqual(app, { id: app.id, workspaceId: workspace.id, name: "App" });
  // A field beyond the name is stripped.
  const response = await post(member, `/workspaces/${workspace.id}/projects`, {
    name: "Website",
    workspaceId: newId<WorkspaceId>(),
  });
  assert.equal(response.statusCode, 200, response.body);
  const website = CreateProjectResponseSchema.parse(response.json()).project;
  assert.equal(website.workspaceId, workspace.id);
  assert.deepEqual(await list(owner, workspace.id), [app, website]);

  // Exactly one project conversation each.
  for (const project of [app, website]) {
    const rows = await database()
      .select({ kind: conversations.kind })
      .from(conversations)
      .where(eq(conversations.projectId, project.id));
    assert.deepEqual(rows, [{ kind: "project" }]);
  }

  const renamed = await rename(member, workspace.id, app.id, "App 2");
  assert.equal(renamed.statusCode, 204, renamed.body);
  assert.equal(renamed.body, "");
  // The name in force changes nothing and sends nothing.
  const again = await rename(member, workspace.id, app.id, "App 2");
  assert.equal(again.statusCode, 204, again.body);
  assert.deepEqual(
    (await list(member, workspace.id)).map((project) => project.name),
    ["App 2", "Website"],
  );

  assert.deepEqual(
    recorded.events.map((event) => [event.type, event.payload]),
    [
      ["workspace.project.created", { project: app }],
      ["workspace.project.created", { project: website }],
      ["workspace.project.renamed", { projectId: app.id, name: "App 2" }],
    ],
  );
  for (const event of recorded.events) {
    assert.ok(decodeEvent(event).ok, event.type);
    assert.equal(event.workspaceId, workspace.id);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    assert.equal(event.occurredAt, new Date(clock.now()).toISOString());
    assert.ok(Object.isFrozen(event.payload));
  }

  const audited = await database()
    .select({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspace.id));
  assert.deepEqual(
    audited.map((record) => record.action),
    ["workspace.created"],
  );
});

test("the creator, the owner, and an admin rename a project; another member gets 403, and an unknown project or one of another workspace the same 404", async (t) => {
  const recorded = recorder();
  const owner = await signedIn(
    await workspaceApp(t, { githubId: 3511, ...recorded }),
  );
  const admin = await signedIn(
    await workspaceApp(t, { githubId: 3512, ...recorded }),
  );
  const creator = await signedIn(
    await workspaceApp(t, { githubId: 3513, ...recorded }),
  );
  const member = await signedIn(
    await workspaceApp(t, { githubId: 3514, ...recorded }),
  );
  const workspace = await createWorkspace(owner);
  const other = await createWorkspace(owner, "Elsewhere");
  await addClaimed(workspace.id, admin.device, owner.device, "admin");
  await addClaimed(workspace.id, creator.device, owner.device);
  await addClaimed(workspace.id, member.device, owner.device);
  const project = await created(creator, workspace.id, "App");
  const foreign = await created(owner, other.id, "Foreign");
  recorded.events.length = 0;

  const refused = await rename(member, workspace.id, project.id, "Mine");
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(errorCode(refused), "forbidden");
  for (const [session, name] of [
    [creator, "App 2"],
    [owner, "App 3"],
    [admin, "App 4"],
  ] as const) {
    const response = await rename(session, workspace.id, project.id, name);
    assert.equal(response.statusCode, 204, response.body);
  }
  assert.deepEqual(
    recorded.events.map((event) =>
      event.type === "workspace.project.renamed" ? event.payload.name : null,
    ),
    ["App 2", "App 3", "App 4"],
  );

  const unknown = await rename(
    owner,
    workspace.id,
    newId<ProjectId>(),
    "Taken",
  );
  const elsewhere = await rename(owner, workspace.id, foreign.id, "Taken");
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), NOT_FOUND);
  assert.equal(elsewhere.body, unknown.body);
  const malformed = await rename(owner, workspace.id, "not-an-id", "Taken");
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(
    (await list(owner, other.id)).map((item) => item.name),
    ["Foreign"],
  );
});

test("a name that a project of the workspace has, in any case, answers 409, and a malformed name 400", async (t) => {
  const recorded = recorder();
  const owner = await signedIn(
    await workspaceApp(t, { githubId: 3521, ...recorded }),
  );
  const workspace = await createWorkspace(owner);
  const app = await created(owner, workspace.id, "App");
  const web = await created(owner, workspace.id, "Web");
  recorded.events.length = 0;

  for (const name of ["app", "APP"]) {
    const response = await create(owner, workspace.id, name);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(errorCode(response), "conflict");
  }
  const clash = await rename(owner, workspace.id, web.id, "aPp");
  assert.equal(clash.statusCode, 409, clash.body);
  // A change of case alone renames.
  const cased = await rename(owner, workspace.id, app.id, "APP");
  assert.equal(cased.statusCode, 204, cased.body);

  for (const payload of [
    {},
    { name: "" },
    { name: " " },
    { name: "a".repeat(101) },
    { name: "App\nWeb" },
    { name: "Ap\u200Bp" },
  ]) {
    const response = await post(
      owner,
      `/workspaces/${workspace.id}/projects`,
      payload,
    );
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(errorCode(response), "bad_request");
  }
  assert.deepEqual(
    (await list(owner, workspace.id)).map((project) => project.name),
    ["APP", "Web"],
  );
  assert.deepEqual(
    recorded.events.map((event) => event.type),
    ["workspace.project.renamed"],
  );
});

test(`the ${MAX_NEW_PROJECTS_PER_DAY + 1}th project of an account within 24 hours answers 429 with Retry-After, and the window slides`, async (t) => {
  const clock = fakeClock();
  const app = await workspaceApp(t, { githubId: 3531, now: clock.now });
  const device = await signInDevice(app);
  let owner: Session = { app, device, token: await accessToken(app, device) };
  const first = await createWorkspace(owner, "First");
  const second = await createWorkspace(owner, "Second");
  await created(owner, first.id, "Project 0");
  clock.advance(HOUR_MS);
  // An access token lives 15 minutes.
  owner = { ...owner, token: await accessToken(app, device) };
  for (let index = 1; index < MAX_NEW_PROJECTS_PER_DAY; index += 1) {
    await created(owner, index % 2 === 0 ? first.id : second.id, `P${index}`);
  }

  const refused = await create(owner, second.id, "One more");
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(errorCode(refused), "rate_limited");
  // The first project leaves the window 23 hours from now.
  assert.equal(
    refused.headers["retry-after"],
    String((DAY_MS - HOUR_MS) / 1000),
  );

  clock.advance(DAY_MS - HOUR_MS);
  owner = { ...owner, token: await accessToken(app, device) };
  await created(owner, second.id, "One more");
  const next = await create(owner, second.id, "And another");
  assert.equal(next.statusCode, 429);
  assert.equal(next.headers["retry-after"], String(HOUR_MS / 1000));
});

test(`a workspace with ${MAX_ACTIVE_PROJECTS_PER_WORKSPACE} projects that are not archived answers 429 with a Retry-After of a day, and an archived project frees a place`, async (t) => {
  const owner = await signedIn(await workspaceApp(t, { githubId: 3541 }));
  const workspace = await createWorkspace(owner);
  const ids = Array.from({ length: MAX_ACTIVE_PROJECTS_PER_WORKSPACE }, () =>
    newId<ProjectId>(),
  );
  await database()
    .insert(projects)
    .values(
      ids.map((id, index) => ({
        id,
        workspaceId: workspace.id,
        name: `Filler ${index}`,
        createdByUserId: owner.device.userId,
        createdAt: new Date(Date.now() - 2 * DAY_MS),
      })),
    );

  const refused = await create(owner, workspace.id, "One more");
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(errorCode(refused), "rate_limited");
  assert.equal(refused.headers["retry-after"], String(DAY_MS / 1000));

  const [first] = ids;
  assert.ok(first !== undefined);
  await database()
    .update(projects)
    .set({ archivedAt: new Date() })
    .where(eq(projects.id, first));
  await created(owner, workspace.id, "One more");
  assert.equal(
    (await list(owner, workspace.id)).length,
    MAX_ACTIVE_PROJECTS_PER_WORKSPACE,
  );
});

test("a non-member gets the 404 of an unknown workspace on every project route, and a removed member too", async (t) => {
  const owner = await signedIn(await workspaceApp(t, { githubId: 3551 }));
  const former = await signedIn(await workspaceApp(t, { githubId: 3552 }));
  const workspace = await createWorkspace(owner);
  const project = await created(owner, workspace.id, "App");
  const person = await addClaimed(workspace.id, former.device, owner.device);
  assert.equal((await list(former, workspace.id)).length, 1);
  await database()
    .update(workspaceMembers)
    .set({ removedAt: new Date(), removedByUserId: owner.device.userId })
    .where(eq(workspaceMembers.id, person));

  const unknownId = newId<WorkspaceId>();
  for (const ask of [
    (id: string) => get(former, `/workspaces/${id}/projects`),
    (id: string) => create(former, id, "Mine"),
    (id: string) => rename(former, id, project.id, "Mine"),
  ]) {
    const removed = await ask(workspace.id);
    const unknown = await ask(unknownId);
    assert.equal(removed.statusCode, 404);
    assert.deepEqual(removed.json(), NOT_FOUND);
    assert.equal(removed.body, unknown.body);
  }
  assert.deepEqual(
    (await list(owner, workspace.id)).map((item) => item.name),
    ["App"],
  );
});

test("the workspace's subscribed connections receive the project events, and the device's decoder accepts them", async (t) => {
  const app = await workspaceApp(t, { githubId: 3561 });
  await app.ready();
  const owner = await signedIn(app);
  const workspace = await createWorkspace(owner);
  const { client } = await connected(t, app, owner.device);
  client.send({
    protocolVersion: 0,
    type: "workspace.subscribe",
    workspaceId: workspace.id,
  });
  const subscribed = await nextFrame(client);
  assert.equal(subscribed.type, "workspace.subscribed");

  const project = await created(owner, workspace.id, "App");
  const response = await rename(owner, workspace.id, project.id, "App 2");
  assert.equal(response.statusCode, 204, response.body);

  const received = [];
  for (let index = 0; index < 2; index += 1) {
    const decoded = decodeServerMessage(await client.next());
    assert.ok(decoded.ok && decoded.kind === "event", JSON.stringify(decoded));
    received.push(decoded.event);
  }
  assert.deepEqual(
    received.map((event) => [event.type, event.workspaceId, event.payload]),
    [
      ["workspace.project.created", workspace.id, { project }],
      [
        "workspace.project.renamed",
        workspace.id,
        { projectId: project.id, name: "App 2" },
      ],
    ],
  );
});
