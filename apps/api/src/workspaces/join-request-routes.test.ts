import {
  auditEvents,
  workspaceJoinRequests,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  ApiErrorBodySchema,
  ApproveJoinRequestResponseSchema,
  CreateJoinRequestResponseSchema,
  CreateWorkspaceResponseSchema,
  decodeEvent,
  decodeServerMessage,
  type JoinRequestId,
  JoinRequestListResponseSchema,
  type MemberId,
  type MemberRole,
  newId,
  OwnJoinRequestListResponseSchema,
  type WorkspaceId,
  WorkspaceListResponseSchema,
  WorkspaceViewResponseSchema,
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
import { ConnectionRegistry } from "../gateway.ts";
import { connected, settle } from "../gateway-test-support.ts";
import type { WorkspaceEvent } from "./events.ts";

const database = useTestDatabase();

type App = FastifyInstance;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function joinApp(
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

function request(
  session: Session,
  method: "GET" | "POST",
  url: string,
  payload?: object,
) {
  return session.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${session.token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

function ask(session: Session, workspaceId: string, displayName = "Ada") {
  return request(session, "POST", "/join-requests", {
    workspaceId,
    displayName,
  });
}

/** Asks to join and expects the request. */
async function asked(
  session: Session,
  workspaceId: WorkspaceId,
  displayName = "Ada",
) {
  const response = await ask(session, workspaceId, displayName);
  assert.equal(response.statusCode, 200, response.body);
  return CreateJoinRequestResponseSchema.parse(response.json()).joinRequest;
}

async function ownList(session: Session) {
  const response = await request(session, "GET", "/join-requests");
  assert.equal(response.statusCode, 200, response.body);
  return OwnJoinRequestListResponseSchema.parse(response.json()).joinRequests;
}

function withdraw(session: Session, joinRequestId: string) {
  return request(session, "POST", `/join-requests/${joinRequestId}/withdraw`);
}

function list(session: Session, workspaceId: string) {
  return request(session, "GET", `/workspaces/${workspaceId}/join-requests`);
}

function approve(
  session: Session,
  workspaceId: string,
  joinRequestId: string,
  payload: object = {},
) {
  return request(
    session,
    "POST",
    `/workspaces/${workspaceId}/join-requests/${joinRequestId}/approve`,
    payload,
  );
}

function deny(session: Session, workspaceId: string, joinRequestId: string) {
  return request(
    session,
    "POST",
    `/workspaces/${workspaceId}/join-requests/${joinRequestId}/deny`,
  );
}

function block(session: Session, workspaceId: string, joinRequestId: string) {
  return request(
    session,
    "POST",
    `/workspaces/${workspaceId}/join-requests/${joinRequestId}/block`,
  );
}

function unblock(session: Session, workspaceId: string, joinRequestId: string) {
  return request(
    session,
    "POST",
    `/workspaces/${workspaceId}/join-requests/${joinRequestId}/unblock`,
  );
}

/** An action on the join requests of a whole workspace. */
function onAll(
  action: "deny-all" | "pause" | "resume",
  session: Session,
  workspaceId: string,
) {
  return request(
    session,
    "POST",
    `/workspaces/${workspaceId}/join-requests/${action}`,
  );
}

/** When the workspace view says join requests were paused, or null. */
async function pausedAt(session: Session, workspaceId: WorkspaceId) {
  const response = await request(session, "GET", `/workspaces/${workspaceId}`);
  assert.equal(response.statusCode, 200, response.body);
  return WorkspaceViewResponseSchema.parse(response.json())
    .joinRequestsPausedAt;
}

async function createWorkspace(session: Session) {
  const response = await request(session, "POST", "/workspaces", {
    name: "Research",
    displayName: "Ada at work",
  });
  assert.equal(response.statusCode, 200, response.body);
  return CreateWorkspaceResponseSchema.parse(response.json());
}

/** Adds the device's account to the workspace as a claimed person; promotion is #93. */
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

async function requestRow(id: JoinRequestId) {
  const [row] = await database()
    .select()
    .from(workspaceJoinRequests)
    .where(eq(workspaceJoinRequests.id, id));
  assert.ok(row !== undefined);
  return row;
}

async function auditActions(workspaceId: WorkspaceId) {
  const rows = await database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId))
    .orderBy(auditEvents.id);
  return rows.map((row) => [row.action, row.actorUserId, row.subjectId]);
}

/** Collects the membership events that an app hands to `onWorkspaceEvent`. */
function recorder() {
  const events: WorkspaceEvent[] = [];
  return {
    events,
    onWorkspaceEvent: (event: WorkspaceEvent) => {
      events.push(event);
    },
  };
}

/** The headers of an answer, without those that change with the time or the connection. */
function stableHeaders(response: { headers: Record<string, unknown> }) {
  return Object.fromEntries(
    Object.entries(response.headers).filter(
      ([name]) => name !== "date" && name !== "connection",
    ),
  );
}

/** The next message, which must be the account frame of a decision. */
/** How long a test waits for a frame that the server sends at once. */
const FRAME_TIMEOUT_MS = 2_000;

/** The next message, or a failure when none arrives within `FRAME_TIMEOUT_MS`. */
async function nextMessage(
  client: Awaited<ReturnType<typeof connected>>,
): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no frame within ${FRAME_TIMEOUT_MS} ms`));
    }, FRAME_TIMEOUT_MS);
  });
  try {
    return await Promise.race([client.client.next(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function nextDecision(client: Awaited<ReturnType<typeof connected>>) {
  const decoded = decodeServerMessage(await nextMessage(client));
  assert.ok(
    decoded.ok &&
      decoded.kind === "frame" &&
      decoded.frame.type === "account.join_request_decided",
    JSON.stringify(decoded),
  );
  return decoded.frame;
}

const FORBIDDEN = {
  statusCode: 403,
  error: "Forbidden",
  message: "Forbidden",
  code: "forbidden",
};

const CONFLICT = {
  statusCode: 409,
  error: "Conflict",
  message: "Conflict",
  code: "conflict",
};

const NOT_FOUND = {
  statusCode: 404,
  error: "Not Found",
  message: "Not Found",
  code: "not_found",
};

test("a requester asks by workspace ID and sees only what they sent; asking again returns the pending request; the requester lists and withdraws it", async (t) => {
  const owner = await signedIn(await joinApp(t, { githubId: 3401 }));
  const guest = await signedIn(await joinApp(t, { githubId: 3402 }));
  const { workspace } = await createWorkspace(owner);

  const response = await request(guest, "POST", "/join-requests", {
    workspaceId: workspace.id,
    displayName: "Ada",
    note: "Please let me in",
  });
  assert.equal(response.statusCode, 200, response.body);
  const sent = response.json() as { joinRequest: Record<string, unknown> };
  assert.deepEqual(
    Object.keys(sent.joinRequest).sort(),
    ["createdAt", "expiresAt", "id", "requestedDisplayName", "workspaceId"],
    "nothing about the workspace",
  );
  assert.ok(!response.body.includes("Research"));
  const { joinRequest } = CreateJoinRequestResponseSchema.parse(sent);
  assert.equal(joinRequest.workspaceId, workspace.id);
  assert.equal(joinRequest.requestedDisplayName, "Ada");
  assert.equal(
    Date.parse(joinRequest.expiresAt) - Date.parse(joinRequest.createdAt),
    7 * DAY_MS,
  );
  const row = await requestRow(joinRequest.id);
  assert.equal(row.requesterUserId, guest.device.userId);
  assert.equal(row.requesterDeviceId, guest.device.deviceId);

  const again = await ask(guest, workspace.id, "Someone else");
  assert.equal(again.statusCode, 200);
  assert.equal(again.body, response.body);

  assert.deepEqual(await ownList(guest), [
    { ...joinRequest, decision: null, decidedAt: null },
  ]);
  assert.deepEqual(await ownList(owner), []);

  // Another account's request answers as one that does not exist.
  const foreign = await withdraw(owner, joinRequest.id);
  const unknown = await withdraw(owner, newId<JoinRequestId>());
  assert.equal(foreign.statusCode, 404);
  assert.deepEqual(foreign.json(), NOT_FOUND);
  assert.equal(foreign.body, unknown.body);

  const withdrawn = await withdraw(guest, joinRequest.id);
  assert.equal(withdrawn.statusCode, 204, withdrawn.body);
  assert.equal(withdrawn.body, "");
  const [listed] = await ownList(guest);
  assert.equal(listed?.decision, "withdrawn");
  const twice = await withdraw(guest, joinRequest.id);
  assert.equal(twice.statusCode, 409);
  assert.deepEqual(twice.json(), CONFLICT);

  assert.deepEqual(await auditActions(workspace.id), [
    ["workspace.created", owner.device.userId, workspace.id],
    ["join_request.created", guest.device.userId, joinRequest.id],
    ["join_request.withdrawn", guest.device.userId, joinRequest.id],
  ]);
});

test("an owner approves: the requester becomes a claimed member, the members get workspace.member.claimed, and only the requester's connections get account.join_request_decided", async (t) => {
  const connections = new ConnectionRegistry();
  const events = recorder();
  const ownerApp = await joinApp(t, {
    githubId: 3403,
    connections,
    onWorkspaceEvent: events.onWorkspaceEvent,
  });
  const guestApp = await joinApp(t, { githubId: 3404, connections });
  const owner = await signedIn(ownerApp);
  const guest = await signedIn(guestApp);
  // Both devices sign in before either connects, so that no
  // `account.device_registered` frame is waiting on a connection.
  const phone = await signInDevice(guestApp);
  const guestLaptop = await connected(t, guestApp, guest.device);
  const guestPhone = await connected(t, guestApp, phone);
  const ownerSocket = await connected(t, ownerApp, owner.device);
  const { workspace } = await createWorkspace(owner);
  const joinRequest = await asked(guest, workspace.id, "Ada");

  const listed = await list(owner, workspace.id);
  assert.equal(listed.statusCode, 200, listed.body);
  const [shown] = JoinRequestListResponseSchema.parse(
    listed.json(),
  ).joinRequests;
  assert.deepEqual(shown, {
    ...joinRequest,
    requester: {
      provider: "github",
      login: "user-3404",
      verifiedAt: shown?.requester?.verifiedAt,
      accountCreatedAt: "2015-06-01T10:00:00.000Z",
    },
    decision: null,
    decidedAt: null,
  });

  const response = await approve(owner, workspace.id, joinRequest.id, {
    displayName: "Ada L.",
    role: "admin",
  });
  assert.equal(response.statusCode, 200, response.body);
  const { member } = ApproveJoinRequestResponseSchema.parse(response.json());
  assert.deepEqual(member, {
    id: member.id,
    workspaceId: workspace.id,
    displayName: "Ada L.",
    role: "member",
    userId: guest.device.userId,
    identity: {
      provider: "github",
      login: "user-3404",
      verifiedAt: member.identity?.verifiedAt,
    },
    removedAt: null,
  });

  // The members' event, from the system actor, as the protocol decodes it.
  assert.equal(events.events.length, 1);
  const [event] = events.events;
  assert.ok(event?.type === "workspace.member.claimed");
  assert.equal(event.workspaceId, workspace.id);
  assert.deepEqual(event.payload.member, member);
  assert.deepEqual(decodeEvent(JSON.parse(JSON.stringify(event))), {
    ok: true,
    event,
  });

  // Every open connection of the requester gets the decision; the owner's does not.
  for (const socket of [guestLaptop, guestPhone]) {
    assert.deepEqual(await nextDecision(socket), {
      protocolVersion: 0,
      type: "account.join_request_decided",
      joinRequestId: joinRequest.id,
      workspaceId: workspace.id,
      decision: "approved",
      decidedAt: event.occurredAt,
    });
  }
  await settle();
  assert.equal(ownerSocket.client.unread(), 0);

  const workspaces = WorkspaceListResponseSchema.parse(
    (await request(guest, "GET", "/workspaces")).json(),
  ).workspaces;
  assert.deepEqual(workspaces, [{ workspace, member }]);
  const [own] = await ownList(guest);
  assert.equal(own?.decision, "approved");
  assert.deepEqual((await auditActions(workspace.id)).slice(-2), [
    ["join_request.approved", owner.device.userId, joinRequest.id],
    ["member.claimed", owner.device.userId, member.id],
  ]);

  // A decision is made once.
  const again = await approve(owner, workspace.id, joinRequest.id);
  assert.equal(again.statusCode, 409);
  assert.deepEqual(again.json(), CONFLICT);
  await settle();
  assert.equal(events.events.length, 1);
  assert.equal(guestLaptop.client.unread(), 0);
});

test("an admin denies: the answer is 204, the requester's connection gets denied, and the requester may ask again after 24 hours", async (t) => {
  const clock = fakeClock();
  const connections = new ConnectionRegistry();
  const ownerApp = await joinApp(t, { githubId: 3405, now: clock.now });
  const adminApp = await joinApp(t, {
    githubId: 3406,
    now: clock.now,
    connections,
  });
  const guestApp = await joinApp(t, {
    githubId: 3407,
    now: clock.now,
    connections,
  });
  const owner = await signedIn(ownerApp);
  const admin = await signedIn(adminApp);
  const guest = await signedIn(guestApp);
  const socket = await connected(t, guestApp, guest.device);
  const { workspace } = await createWorkspace(owner);
  await addClaimed(workspace.id, admin.device, owner.device, "admin");
  const joinRequest = await asked(guest, workspace.id);

  const response = await deny(admin, workspace.id, joinRequest.id);
  assert.equal(response.statusCode, 204, response.body);
  assert.deepEqual(await nextDecision(socket), {
    protocolVersion: 0,
    type: "account.join_request_decided",
    joinRequestId: joinRequest.id,
    workspaceId: workspace.id,
    decision: "denied",
    decidedAt: new Date(clock.now()).toISOString(),
  });
  const [own] = await ownList(guest);
  assert.equal(own?.decision, "denied");
  assert.equal(
    (await requestRow(joinRequest.id)).decidedByUserId,
    admin.device.userId,
  );
  assert.deepEqual((await auditActions(workspace.id)).at(-1), [
    "join_request.denied",
    admin.device.userId,
    joinRequest.id,
  ]);

  const early = await ask(guest, workspace.id);
  assert.equal(early.statusCode, 429);
  assert.equal(ApiErrorBodySchema.parse(early.json()).code, "rate_limited");
  assert.equal(early.headers["retry-after"], String(DAY_MS / 1000));

  clock.advance(DAY_MS);
  const later = { ...guest, token: await accessToken(guestApp, guest.device) };
  const fresh = await asked(later, workspace.id);
  assert.notEqual(fresh.id, joinRequest.id);
});

test("an owner blocks: the requester's connection gets denied, a new request answers join_requests_closed, and after an admin lifts the block the requester asks again at once", async (t) => {
  const clock = fakeClock();
  const connections = new ConnectionRegistry();
  const owner = await signedIn(
    await joinApp(t, { githubId: 3418, now: clock.now, connections }),
  );
  const admin = await signedIn(
    await joinApp(t, { githubId: 3419, now: clock.now, connections }),
  );
  const guestApp = await joinApp(t, {
    githubId: 3420,
    now: clock.now,
    connections,
  });
  const guest = await signedIn(guestApp);
  const socket = await connected(t, guestApp, guest.device);
  const { workspace } = await createWorkspace(owner);
  await addClaimed(workspace.id, admin.device, owner.device, "admin");
  const joinRequest = await asked(guest, workspace.id);

  const response = await block(owner, workspace.id, joinRequest.id);
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(response.body, "");
  // The requester sees a block as a denial.
  assert.deepEqual(await nextDecision(socket), {
    protocolVersion: 0,
    type: "account.join_request_decided",
    joinRequestId: joinRequest.id,
    workspaceId: workspace.id,
    decision: "denied",
    decidedAt: new Date(clock.now()).toISOString(),
  });
  const [own] = await ownList(guest);
  assert.equal(own?.decision, "denied");
  const closed = await ask(guest, workspace.id);
  assert.equal(closed.statusCode, 403, closed.body);
  assert.equal(
    ApiErrorBodySchema.parse(closed.json()).code,
    "join_requests_closed",
  );
  const listed = await list(admin, workspace.id);
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(
    JoinRequestListResponseSchema.parse(listed.json()).joinRequests.map(
      (shown) => [shown.id, shown.decision],
    ),
    [[joinRequest.id, "blocked"]],
  );
  const twice = await block(admin, workspace.id, joinRequest.id);
  assert.equal(twice.statusCode, 409);
  assert.deepEqual(twice.json(), CONFLICT);
  assert.deepEqual((await auditActions(workspace.id)).at(-1), [
    "join_request.blocked",
    owner.device.userId,
    joinRequest.id,
  ]);

  const lifted = await unblock(admin, workspace.id, joinRequest.id);
  assert.equal(lifted.statusCode, 204, lifted.body);
  assert.equal(lifted.body, "");
  const row = await requestRow(joinRequest.id);
  assert.equal(row.decision, "blocked");
  assert.equal(row.unblockedByUserId, admin.device.userId);
  assert.deepEqual((await auditActions(workspace.id)).at(-1), [
    "join_request.unblocked",
    admin.device.userId,
    joinRequest.id,
  ]);
  const again = await unblock(owner, workspace.id, joinRequest.id);
  assert.equal(again.statusCode, 409);
  assert.deepEqual(again.json(), CONFLICT);
  const unknown = await unblock(owner, workspace.id, newId<JoinRequestId>());
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), NOT_FOUND);

  // A lifted block starts no 24-hour wait, and lifting it sends nothing.
  const fresh = await asked(guest, workspace.id);
  assert.notEqual(fresh.id, joinRequest.id);
  await settle();
  assert.equal(socket.client.unread(), 0);
});

test("an admin denies all: every pending request is denied with one audit record each, and each requester's connection gets one denied frame", async (t) => {
  const clock = fakeClock();
  const connections = new ConnectionRegistry();
  const owner = await signedIn(
    await joinApp(t, { githubId: 3421, now: clock.now }),
  );
  const adminApp = await joinApp(t, {
    githubId: 3422,
    now: clock.now,
    connections,
  });
  const admin = await signedIn(adminApp);
  const adaApp = await joinApp(t, {
    githubId: 3423,
    now: clock.now,
    connections,
  });
  const bobApp = await joinApp(t, {
    githubId: 3424,
    now: clock.now,
    connections,
  });
  const ada = await signedIn(adaApp);
  const bob = await signedIn(bobApp);
  const adminSocket = await connected(t, adminApp, admin.device);
  const adaSocket = await connected(t, adaApp, ada.device);
  const bobSocket = await connected(t, bobApp, bob.device);
  const { workspace } = await createWorkspace(owner);
  await addClaimed(workspace.id, admin.device, owner.device, "admin");
  const adaRequest = await asked(ada, workspace.id);
  const bobRequest = await asked(bob, workspace.id);
  const audited = await auditActions(workspace.id);

  const response = await onAll("deny-all", admin, workspace.id);
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(response.body, "");
  for (const [socket, joinRequest] of [
    [adaSocket, adaRequest],
    [bobSocket, bobRequest],
  ] as const) {
    assert.deepEqual(await nextDecision(socket), {
      protocolVersion: 0,
      type: "account.join_request_decided",
      joinRequestId: joinRequest.id,
      workspaceId: workspace.id,
      decision: "denied",
      decidedAt: new Date(clock.now()).toISOString(),
    });
    const row = await requestRow(joinRequest.id);
    assert.equal(row.decision, "denied");
    assert.equal(row.decidedByUserId, admin.device.userId);
  }
  assert.deepEqual(await auditActions(workspace.id), [
    ...audited,
    ["join_request.denied", admin.device.userId, adaRequest.id],
    ["join_request.denied", admin.device.userId, bobRequest.id],
  ]);
  const [own] = await ownList(ada);
  assert.equal(own?.decision, "denied");

  // With nothing pending, denying all answers 204 and changes nothing.
  const again = await onAll("deny-all", owner, workspace.id);
  assert.equal(again.statusCode, 204, again.body);
  await settle();
  for (const socket of [adminSocket, adaSocket, bobSocket]) {
    assert.equal(socket.client.unread(), 0);
  }
  assert.equal((await auditActions(workspace.id)).length, audited.length + 2);
});

test("an owner pauses and an admin resumes: the workspace view shows the pause, pending requests stay, and a new request answers join_requests_closed until the resume", async (t) => {
  const owner = await signedIn(await joinApp(t, { githubId: 3425 }));
  const admin = await signedIn(await joinApp(t, { githubId: 3426 }));
  const waiting = await signedIn(await joinApp(t, { githubId: 3427 }));
  const late = await signedIn(await joinApp(t, { githubId: 3428 }));
  const { workspace } = await createWorkspace(owner);
  await addClaimed(workspace.id, admin.device, owner.device, "admin");
  const pending = await asked(waiting, workspace.id);
  assert.equal(await pausedAt(admin, workspace.id), null);

  const paused = await onAll("pause", owner, workspace.id);
  assert.equal(paused.statusCode, 204, paused.body);
  assert.equal(paused.body, "");
  const since = await pausedAt(admin, workspace.id);
  assert.ok(since !== null);
  // Pausing again keeps the first pause.
  const twice = await onAll("pause", admin, workspace.id);
  assert.equal(twice.statusCode, 204, twice.body);
  assert.equal(await pausedAt(admin, workspace.id), since);

  const closed = await ask(late, workspace.id);
  assert.equal(closed.statusCode, 403, closed.body);
  assert.equal(
    ApiErrorBodySchema.parse(closed.json()).code,
    "join_requests_closed",
  );
  assert.deepEqual(await asked(waiting, workspace.id), pending);
  assert.equal((await requestRow(pending.id)).decision, null);

  const resumed = await onAll("resume", admin, workspace.id);
  assert.equal(resumed.statusCode, 204, resumed.body);
  assert.equal(await pausedAt(owner, workspace.id), null);
  const again = await onAll("resume", owner, workspace.id);
  assert.equal(again.statusCode, 204, again.body);
  await asked(late, workspace.id);

  assert.deepEqual(
    (await auditActions(workspace.id)).filter(([action]) =>
      String(action).startsWith("join_requests."),
    ),
    [
      ["join_requests.paused", owner.device.userId, workspace.id],
      ["join_requests.resumed", admin.device.userId, workspace.id],
    ],
  );
});

test("a member gets forbidden for listing, approving, denying, blocking, unblocking, denying all, pausing, and resuming, and nothing changes and nothing is sent", async (t) => {
  const connections = new ConnectionRegistry();
  const events = recorder();
  const owner = await signedIn(await joinApp(t, { githubId: 3408 }));
  const member = await signedIn(
    await joinApp(t, {
      githubId: 3409,
      connections,
      onWorkspaceEvent: events.onWorkspaceEvent,
    }),
  );
  const guestApp = await joinApp(t, { githubId: 3410, connections });
  const guest = await signedIn(guestApp);
  const blocked = await signedIn(await joinApp(t, { githubId: 3417 }));
  const socket = await connected(t, guestApp, guest.device);
  const { workspace } = await createWorkspace(owner);
  await addClaimed(workspace.id, member.device, owner.device);
  const joinRequest = await asked(guest, workspace.id);
  const blockedRequest = await asked(blocked, workspace.id);
  const blocking = await block(owner, workspace.id, blockedRequest.id);
  assert.equal(blocking.statusCode, 204, blocking.body);
  const before = await requestRow(joinRequest.id);
  const blockBefore = await requestRow(blockedRequest.id);
  const audited = await auditActions(workspace.id);

  const refusals = [
    await list(member, workspace.id),
    await approve(member, workspace.id, joinRequest.id),
    await deny(member, workspace.id, joinRequest.id),
    await block(member, workspace.id, joinRequest.id),
    await unblock(member, workspace.id, blockedRequest.id),
    await onAll("deny-all", member, workspace.id),
    await onAll("pause", member, workspace.id),
  ];
  // Resuming is refused too, also while the workspace is paused.
  const pausing = await onAll("pause", owner, workspace.id);
  assert.equal(pausing.statusCode, 204, pausing.body);
  const paused = await pausedAt(owner, workspace.id);
  refusals.push(await onAll("resume", member, workspace.id));
  for (const response of refusals) {
    assert.equal(response.statusCode, 403, response.body);
    assert.deepEqual(response.json(), FORBIDDEN);
  }
  assert.deepEqual(await requestRow(joinRequest.id), before);
  assert.deepEqual(await requestRow(blockedRequest.id), blockBefore);
  assert.equal(await pausedAt(owner, workspace.id), paused);
  assert.deepEqual(await auditActions(workspace.id), [
    ...audited,
    ["join_requests.paused", owner.device.userId, workspace.id],
  ]);
  await settle();
  assert.deepEqual(events.events, []);
  assert.equal(socket.client.unread(), 0);
});

test("an unknown and an archived workspace get the same workspace_not_found, a pause and a block the same join_requests_closed, and an active member already_member", async (t) => {
  const owner = await signedIn(await joinApp(t, { githubId: 3411 }));
  const guest = await signedIn(await joinApp(t, { githubId: 3412 }));
  const blocked = await signedIn(await joinApp(t, { githubId: 3413 }));
  const { workspace } = await createWorkspace(owner);
  const archived = await createWorkspace(owner);
  await database()
    .update(workspaces)
    .set({ archivedAt: new Date() })
    .where(eq(workspaces.id, archived.workspace.id));

  const unknown = await ask(guest, newId<WorkspaceId>());
  const gone = await ask(guest, archived.workspace.id);
  assert.equal(unknown.statusCode, 404);
  assert.equal(
    ApiErrorBodySchema.parse(unknown.json()).code,
    "workspace_not_found",
  );
  assert.equal(gone.body, unknown.body);
  assert.deepEqual(stableHeaders(gone), stableHeaders(unknown));

  await database()
    .insert(workspaceJoinRequests)
    .values({
      id: newId<JoinRequestId>(),
      workspaceId: workspace.id,
      requesterUserId: blocked.device.userId,
      requesterDeviceId: blocked.device.deviceId,
      requestedDisplayName: "Eve",
      expiresAt: new Date(Date.now() + DAY_MS),
      decision: "blocked",
      decidedAt: new Date(),
      decidedByUserId: owner.device.userId,
    });
  const block = await ask(blocked, workspace.id);
  await database()
    .update(workspaces)
    .set({ joinRequestsPausedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));
  const pause = await ask(guest, workspace.id);
  assert.equal(pause.statusCode, 403);
  assert.equal(
    ApiErrorBodySchema.parse(pause.json()).code,
    "join_requests_closed",
  );
  assert.equal(block.body, pause.body);
  assert.deepEqual(stableHeaders(block), stableHeaders(pause));

  const member = await ask(owner, workspace.id);
  assert.equal(member.statusCode, 409);
  assert.equal(ApiErrorBodySchema.parse(member.json()).code, "already_member");

  for (const response of [unknown, gone, block, pause, member]) {
    assert.ok(!response.body.includes("Research"));
  }
  assert.deepEqual(await ownList(guest), []);
});

test("a body that breaks the protocol answers 400 with bad_request", async (t) => {
  const owner = await signedIn(await joinApp(t, { githubId: 3414 }));
  const guest = await signedIn(await joinApp(t, { githubId: 3415 }));
  const { workspace } = await createWorkspace(owner);
  for (const payload of [
    {},
    { workspaceId: workspace.id },
    { workspaceId: workspace.id, displayName: "" },
    { workspaceId: workspace.id, displayName: "a".repeat(65) },
    { workspaceId: "not-an-id", displayName: "Ada" },
  ]) {
    const response = await request(guest, "POST", "/join-requests", payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(ApiErrorBodySchema.parse(response.json()).code, "bad_request");
  }
  const joinRequest = await asked(guest, workspace.id);
  for (const response of [
    await approve(owner, workspace.id, joinRequest.id, { displayName: "" }),
    await approve(owner, workspace.id, "not-an-id"),
    await withdraw(guest, "not-an-id"),
    await block(owner, workspace.id, "not-an-id"),
    await unblock(owner, workspace.id, "not-an-id"),
  ]) {
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(ApiErrorBodySchema.parse(response.json()).code, "bad_request");
  }
  assert.equal((await requestRow(joinRequest.id)).decision, null);

  // The body is an object, also when it names nothing.
  const bare = await owner.app.inject({
    method: "POST",
    url: `/workspaces/${workspace.id}/join-requests/${joinRequest.id}/approve`,
    headers: { authorization: `Bearer ${owner.token}` },
  });
  assert.equal(bare.statusCode, 400, bare.body);
  assert.equal((await requestRow(joinRequest.id)).decision, null);
  // An empty body keeps the requested name.
  const kept = await approve(owner, workspace.id, joinRequest.id, {});
  assert.equal(kept.statusCode, 200, kept.body);
  assert.equal(
    ApproveJoinRequestResponseSchema.parse(kept.json()).member.displayName,
    "Ada",
  );
});

test("the join request routes need a valid access token", async (t) => {
  const app = await joinApp(t, { githubId: 3416 });
  const owner = await signedIn(app);
  const { workspace } = await createWorkspace(owner);
  const joinRequestId = newId<JoinRequestId>();
  for (const [method, url, payload] of [
    [
      "POST",
      "/join-requests",
      { workspaceId: workspace.id, displayName: "Ada" },
    ],
    ["GET", "/join-requests", undefined],
    ["POST", `/join-requests/${joinRequestId}/withdraw`, undefined],
    ["GET", `/workspaces/${workspace.id}/join-requests`, undefined],
    [
      "POST",
      `/workspaces/${workspace.id}/join-requests/${joinRequestId}/approve`,
      {},
    ],
    [
      "POST",
      `/workspaces/${workspace.id}/join-requests/${joinRequestId}/deny`,
      undefined,
    ],
    [
      "POST",
      `/workspaces/${workspace.id}/join-requests/${joinRequestId}/block`,
      undefined,
    ],
    [
      "POST",
      `/workspaces/${workspace.id}/join-requests/${joinRequestId}/unblock`,
      undefined,
    ],
    ["POST", `/workspaces/${workspace.id}/join-requests/deny-all`, undefined],
    ["POST", `/workspaces/${workspace.id}/join-requests/pause`, undefined],
    ["POST", `/workspaces/${workspace.id}/join-requests/resume`, undefined],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(response.statusCode, 401, url);
    assert.equal(
      ApiErrorBodySchema.parse(response.json()).code,
      "unauthorized",
    );
  }
});
