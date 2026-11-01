import {
  auditEvents,
  type Database,
  workspaceInvitations,
  workspaceMembers,
} from "@mymandev/database";
import {
  CreateWorkspaceResponseSchema,
  decodeEvent,
  DefineMemberResponseSchema,
  type InvitationId,
  type MemberId,
  type MemberRole,
  newId,
  type WorkspaceId,
  WorkspaceViewResponseSchema,
} from "@mymandev/protocol";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  accessToken,
  deviceApp,
  type DeviceAppOptions,
  signInDevice,
  type SignedInDevice,
  useTestDatabase,
} from "../auth/device-test-support.ts";
import type { WorkspaceEvent } from "./events.ts";

const database = useTestDatabase();

type App = FastifyInstance;

const HOUR_MS = 60 * 60_000;

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

function post(session: Session, url: string, payload?: object) {
  return session.app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${session.token}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

function define(session: Session, workspaceId: string, payload: object) {
  return post(session, `/workspaces/${workspaceId}/members`, payload);
}

function rename(
  session: Session,
  workspaceId: string,
  memberId: string,
  payload: object,
) {
  return post(
    session,
    `/workspaces/${workspaceId}/members/${memberId}/rename`,
    payload,
  );
}

function remove(session: Session, workspaceId: string, memberId: string) {
  return post(session, `/workspaces/${workspaceId}/members/${memberId}/remove`);
}

async function view(session: Session, workspaceId: WorkspaceId) {
  const response = await session.app.inject({
    method: "GET",
    url: `/workspaces/${workspaceId}`,
    headers: { authorization: `Bearer ${session.token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  return WorkspaceViewResponseSchema.parse(response.json());
}

async function createWorkspace(session: Session) {
  const response = await post(session, "/workspaces", {
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

/** An unclaimed person defined through the API. */
async function defined(
  session: Session,
  workspaceId: WorkspaceId,
  displayName = "Linus",
): Promise<MemberId> {
  const response = await define(session, workspaceId, { displayName });
  assert.equal(response.statusCode, 200, response.body);
  return DefineMemberResponseSchema.parse(response.json()).member.id;
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

function errorCode(response: { json(): unknown }): unknown {
  return (response.json() as { code?: unknown }).code;
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

test("the owner and an admin define unclaimed members, and a role in the body has no effect", async (t) => {
  const recorded = recorder();
  const owner = await signedIn(
    await workspaceApp(t, { githubId: 3101, ...recorded }),
  );
  const admin = await signedIn(
    await workspaceApp(t, { githubId: 3102, ...recorded }),
  );
  const { workspace } = await createWorkspace(owner);
  await addClaimed(workspace.id, admin.device, owner.device, "admin");

  const byOwner = await define(owner, workspace.id, {
    displayName: "Linus",
    role: "admin",
    userId: owner.device.userId,
  });
  assert.equal(byOwner.statusCode, 200, byOwner.body);
  const { member } = DefineMemberResponseSchema.parse(byOwner.json());
  assert.deepEqual(member, {
    id: member.id,
    workspaceId: workspace.id,
    displayName: "Linus",
    role: "member",
    userId: null,
    identity: null,
    removedAt: null,
  });
  const byAdmin = await define(admin, workspace.id, {
    displayName: "Margaret",
    role: "owner",
  });
  assert.equal(byAdmin.statusCode, 200, byAdmin.body);
  const second = DefineMemberResponseSchema.parse(byAdmin.json()).member;
  assert.equal(second.role, "member");

  const people = (await view(owner, workspace.id)).members;
  assert.deepEqual(
    people.filter((person) => person.userId === null),
    [second, member],
    "the most recently created first",
  );
  const [row] = await database()
    .select({
      role: workspaceMembers.role,
      addedByUserId: workspaceMembers.addedByUserId,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.id, second.id));
  assert.deepEqual(row, { role: "member", addedByUserId: admin.device.userId });
  assert.deepEqual(
    recorded.events.map((event) => [event.type, event.workspaceId]),
    [
      ["workspace.member.defined", workspace.id],
      ["workspace.member.defined", workspace.id],
    ],
  );
});

test("a member gets forbidden for defining and removing people and for renaming another person, and nothing changes", async (t) => {
  const recorded = recorder();
  const owner = await signedIn(await workspaceApp(t, { githubId: 3103 }));
  const member = await signedIn(
    await workspaceApp(t, { githubId: 3104, ...recorded }),
  );
  const other = await signedIn(await workspaceApp(t, { githubId: 3105 }));
  const { workspace, member: ownerPerson } = await createWorkspace(owner);
  await addClaimed(workspace.id, member.device, owner.device);
  const otherPerson = await addClaimed(
    workspace.id,
    other.device,
    owner.device,
  );
  const unclaimed = await defined(owner, workspace.id);
  const before = await view(owner, workspace.id);

  for (const [label, response] of [
    ["define", await define(member, workspace.id, { displayName: "Eve" })],
    [
      "remove an unclaimed person",
      await remove(member, workspace.id, unclaimed),
    ],
    [
      "rename an unclaimed person",
      await rename(member, workspace.id, unclaimed, { displayName: "Eve" }),
    ],
    [
      "rename the owner",
      await rename(member, workspace.id, ownerPerson.id, {
        displayName: "Eve",
      }),
    ],
    [
      "rename another member",
      await rename(member, workspace.id, otherPerson, { displayName: "Eve" }),
    ],
  ] as const) {
    assert.equal(response.statusCode, 403, label);
    assert.deepEqual(response.json(), FORBIDDEN, label);
  }
  assert.deepEqual(await view(owner, workspace.id), before);
  assert.deepEqual(recorded.events, [], "a refusal sends no event");
});

test("every member renames their own person, and nobody renames another claimed person", async (t) => {
  const recorded = recorder();
  const owner = await signedIn(
    await workspaceApp(t, { githubId: 3106, ...recorded }),
  );
  const admin = await signedIn(
    await workspaceApp(t, { githubId: 3107, ...recorded }),
  );
  const member = await signedIn(
    await workspaceApp(t, { githubId: 3108, ...recorded }),
  );
  const { workspace, member: ownerPerson } = await createWorkspace(owner);
  const adminPerson = await addClaimed(
    workspace.id,
    admin.device,
    owner.device,
    "admin",
  );
  const memberPerson = await addClaimed(
    workspace.id,
    member.device,
    owner.device,
  );
  const unclaimed = await defined(owner, workspace.id);
  recorded.events.length = 0;

  for (const [session, memberId, displayName] of [
    [member, memberPerson, "Grace H."],
    [admin, adminPerson, "Admin A."],
    [owner, ownerPerson.id, "Ada L."],
    [admin, unclaimed, "Renamed by an admin"],
  ] as const) {
    const response = await rename(session, workspace.id, memberId, {
      displayName,
      role: "owner",
    });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(response.body, "");
  }
  const people = new Map(
    (await view(member, workspace.id)).members.map((person) => [
      person.id,
      person,
    ]),
  );
  assert.equal(people.get(memberPerson)?.displayName, "Grace H.");
  assert.equal(people.get(memberPerson)?.role, "member", "the role stays");
  assert.equal(people.get(adminPerson)?.displayName, "Admin A.");
  assert.equal(people.get(ownerPerson.id)?.displayName, "Ada L.");
  assert.equal(people.get(unclaimed)?.displayName, "Renamed by an admin");
  assert.deepEqual(
    recorded.events.map((event) => [event.type, event.payload]),
    [
      [
        "workspace.member.renamed",
        { memberId: memberPerson, displayName: "Grace H." },
      ],
      [
        "workspace.member.renamed",
        { memberId: adminPerson, displayName: "Admin A." },
      ],
      [
        "workspace.member.renamed",
        { memberId: ownerPerson.id, displayName: "Ada L." },
      ],
      [
        "workspace.member.renamed",
        { memberId: unclaimed, displayName: "Renamed by an admin" },
      ],
    ],
  );

  for (const [label, session, memberId] of [
    ["the owner, an admin", owner, adminPerson],
    ["the owner, a member", owner, memberPerson],
    ["an admin, the owner", admin, ownerPerson.id],
    ["an admin, a member", admin, memberPerson],
  ] as const) {
    const response = await rename(session, workspace.id, memberId, {
      displayName: "Impostor",
    });
    assert.equal(response.statusCode, 403, label);
    assert.deepEqual(response.json(), FORBIDDEN, label);
  }
});

test("a removed person answers conflict, and so does removing a claimed person", async (t) => {
  const recorded = recorder();
  const owner = await signedIn(
    await workspaceApp(t, { githubId: 3109, ...recorded }),
  );
  const admin = await signedIn(await workspaceApp(t, { githubId: 3110 }));
  const member = await signedIn(await workspaceApp(t, { githubId: 3111 }));
  const { workspace, member: ownerPerson } = await createWorkspace(owner);
  const adminPerson = await addClaimed(
    workspace.id,
    admin.device,
    owner.device,
    "admin",
  );
  const memberPerson = await addClaimed(
    workspace.id,
    member.device,
    owner.device,
  );
  const unclaimed = await defined(owner, workspace.id);
  const removed = await remove(owner, workspace.id, unclaimed);
  assert.equal(removed.statusCode, 204, removed.body);
  recorded.events.length = 0;

  for (const [label, response] of [
    ["removing it again", await remove(owner, workspace.id, unclaimed)],
    [
      "renaming it",
      await rename(owner, workspace.id, unclaimed, { displayName: "Back" }),
    ],
    [
      "renaming it as an admin",
      await rename(admin, workspace.id, unclaimed, { displayName: "Back" }),
    ],
    // Removing claimed people comes with #93.
    ["removing a member", await remove(owner, workspace.id, memberPerson)],
    ["removing an admin", await remove(owner, workspace.id, adminPerson)],
    [
      "an admin removing a member",
      await remove(admin, workspace.id, memberPerson),
    ],
    [
      "the owner removing themselves",
      await remove(owner, workspace.id, ownerPerson.id),
    ],
  ] as const) {
    assert.equal(response.statusCode, 409, label);
    assert.deepEqual(response.json(), CONFLICT, label);
  }
  const people = (await view(owner, workspace.id)).members;
  assert.deepEqual(
    people.filter((person) => person.removedAt !== null).map((p) => p.id),
    [unclaimed],
  );
  assert.equal(
    people.find((person) => person.id === unclaimed)?.displayName,
    "Linus",
  );
  assert.deepEqual(recorded.events, [], "a refusal sends no event");

  // A person ID that the workspace does not have.
  for (const response of [
    await remove(owner, workspace.id, newId<MemberId>()),
    await rename(owner, workspace.id, newId<MemberId>(), { displayName: "X" }),
  ]) {
    assert.equal(response.statusCode, 404);
    assert.equal(errorCode(response), "not_found");
  }
});

test("removing an unclaimed person revokes its live invitation with member_removed", async (t) => {
  const recorded = recorder();
  const owner = await signedIn(
    await workspaceApp(t, { githubId: 3112, ...recorded }),
  );
  const { workspace } = await createWorkspace(owner);
  const unclaimed = await defined(owner, workspace.id);
  // Creating invitations comes with the next change of #91.
  const invitationId = newId<InvitationId>();
  const createdAt = new Date();
  await database()
    .insert(workspaceInvitations)
    .values({
      id: invitationId,
      workspaceId: workspace.id,
      memberId: unclaimed,
      tokenHash: randomBytes(32).toString("hex"),
      createdByUserId: owner.device.userId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 24 * HOUR_MS),
    });

  const response = await remove(owner, workspace.id, unclaimed);
  assert.equal(response.statusCode, 204, response.body);

  const [invitation] = await database()
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, invitationId));
  assert.ok(invitation?.revokedAt instanceof Date);
  assert.equal(invitation.revokedByUserId, owner.device.userId);
  assert.equal(invitation.acceptedAt, null);
  const [person] = await database()
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.id, unclaimed));
  assert.deepEqual(person?.removedAt, invitation.revokedAt);
  assert.equal(person?.removedByUserId, owner.device.userId);

  const audit = await database()
    .select({
      action: auditEvents.action,
      actorUserId: auditEvents.actorUserId,
      actorDeviceId: auditEvents.actorDeviceId,
      subjectId: auditEvents.subjectId,
      reason: auditEvents.reason,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, workspace.id),
        eq(auditEvents.createdAt, invitation.revokedAt),
      ),
    )
    .orderBy(auditEvents.id);
  assert.deepEqual(audit, [
    {
      action: "member.removed",
      actorUserId: owner.device.userId,
      actorDeviceId: owner.device.deviceId,
      subjectId: unclaimed,
      reason: null,
    },
    {
      action: "invitation.revoked",
      actorUserId: owner.device.userId,
      actorDeviceId: owner.device.deviceId,
      subjectId: invitationId,
      reason: "member_removed",
    },
  ]);
  assert.deepEqual(recorded.events.at(-1)?.payload, {
    memberId: unclaimed,
    removedAt: invitation.revokedAt.toISOString(),
  });
});

test("membership events are sent after the commit as frozen copies from the system actor, and decode with the protocol's decoder", async (t) => {
  /** The person that each event names, as the database shows it when the event arrives. */
  const checks: Promise<unknown>[] = [];
  const events: WorkspaceEvent[] = [];
  const owner = await signedIn(
    await workspaceApp(t, {
      githubId: 3113,
      onWorkspaceEvent: (event) => {
        events.push(event);
        const memberId =
          event.type === "workspace.member.defined"
            ? event.payload.member.id
            : "memberId" in event.payload
              ? event.payload.memberId
              : undefined;
        assert.ok(memberId !== undefined);
        checks.push(
          database()
            .select({
              displayName: workspaceMembers.displayName,
              removed: workspaceMembers.removedAt,
            })
            .from(workspaceMembers)
            .where(eq(workspaceMembers.id, memberId))
            .then(([row]) => [
              event.type,
              row?.displayName,
              row?.removed !== null,
            ]),
        );
      },
    }),
  );
  const { workspace } = await createWorkspace(owner);
  const response = await define(owner, workspace.id, { displayName: "Linus" });
  assert.equal(response.statusCode, 200);
  const { member } = DefineMemberResponseSchema.parse(response.json());
  const renamed = await rename(owner, workspace.id, member.id, {
    displayName: "Linus T.",
  });
  assert.equal(renamed.statusCode, 204);
  const removed = await remove(owner, workspace.id, member.id);
  assert.equal(removed.statusCode, 204);

  assert.deepEqual(await Promise.all(checks), [
    ["workspace.member.defined", "Linus", false],
    ["workspace.member.renamed", "Linus T.", false],
    ["workspace.member.removed", "Linus T.", true],
  ]);
  assert.equal(new Set(events.map((event) => event.id)).size, 3);
  for (const event of events) {
    assert.equal(event.workspaceId, workspace.id);
    assert.deepEqual(event.actor, { kind: "system" });
    assert.equal(event.deviceId, null);
    // What #110 sends over the wire decodes to the same event.
    assert.deepEqual(decodeEvent(JSON.parse(JSON.stringify(event))), {
      ok: true,
      event,
    });
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.payload));
  }
  // The handler gets a copy that it cannot change, not the answer's object.
  const [first] = events;
  assert.ok(first?.type === "workspace.member.defined");
  assert.deepEqual(first.payload.member, member);
  assert.ok(Object.isFrozen(first.payload.member));
  assert.throws(() => {
    (first.payload.member as { displayName: string }).displayName = "Eve";
  }, TypeError);
});

/** Waits up to a second for `condition`. */
async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await delay(10);
  }
  assert.ok(condition());
}

test("the answer never waits for the event hook, and a failing hook is logged with the error's type only", async (t) => {
  const logLines: string[] = [];
  const owner = await signedIn(
    await workspaceApp(t, {
      githubId: 3114,
      logLines,
      onWorkspaceEvent: (event) => {
        switch (event.type) {
          case "workspace.member.defined":
            throw new TypeError(
              `cannot deliver ${event.payload.member.displayName}`,
            );
          case "workspace.member.renamed":
            return Promise.reject(
              new RangeError(`cannot deliver ${event.payload.displayName}`),
            );
          default:
            // A handler that never returns.
            return new Promise<void>(() => {});
        }
      },
    }),
  );
  const { workspace } = await createWorkspace(owner);
  const response = await define(owner, workspace.id, {
    displayName: "Secretive Linus",
  });
  assert.equal(response.statusCode, 200, response.body);
  const { member } = DefineMemberResponseSchema.parse(response.json());
  const renamed = await rename(owner, workspace.id, member.id, {
    displayName: "Secretive Linus T.",
  });
  assert.equal(renamed.statusCode, 204);
  const removed = await Promise.race([
    remove(owner, workspace.id, member.id),
    delay(5_000, "held", { ref: false }),
  ]);
  assert.ok(
    typeof removed !== "string",
    "a hook that never returns holds nothing",
  );
  assert.equal(removed.statusCode, 204);
  const person = (await view(owner, workspace.id)).members.find(
    (candidate) => candidate.id === member.id,
  );
  assert.equal(person?.displayName, "Secretive Linus T.");
  assert.notEqual(person?.removedAt, null);

  const failures = () =>
    logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry["msg"] === "workspace event failed");
  await eventually(() => failures().length === 2);
  assert.deepEqual(
    failures().map((entry) => [
      entry["level"],
      entry["eventType"],
      entry["workspaceId"],
      entry["errorType"],
      entry["err"],
    ]),
    [
      [50, "workspace.member.defined", workspace.id, "TypeError", undefined],
      [50, "workspace.member.renamed", workspace.id, "RangeError", undefined],
    ],
  );
  assert.ok(!logLines.join("\n").includes("Secretive Linus"));
});

test("without a hook, the event type and the workspace ID are logged at debug level, and nothing else of the event", async (t) => {
  const logLines: string[] = [];
  const owner = await signedIn(
    await workspaceApp(t, {
      githubId: 3115,
      logLines,
      env: { API_LOG_LEVEL: "debug" },
    }),
  );
  const { workspace } = await createWorkspace(owner);
  const unclaimed = await defined(owner, workspace.id, "Quiet Linus");
  const logged = logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["msg"] === "workspace event");
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.["level"], 20);
  assert.equal(logged[0]?.["eventType"], "workspace.member.defined");
  assert.equal(logged[0]?.["workspaceId"], workspace.id);
  assert.ok(!logLines.join("\n").includes("Quiet Linus"));
  assert.ok(!logLines.join("\n").includes(unclaimed));
});

test("display names follow the text rule of the protocol", async (t) => {
  const owner = await signedIn(await workspaceApp(t, { githubId: 3116 }));
  const { workspace } = await createWorkspace(owner);
  const unclaimed = await defined(owner, workspace.id);
  for (const payload of [
    {},
    { displayName: "" },
    { displayName: " \t " },
    { displayName: "x".repeat(65) },
    { displayName: "Li\u0000nus" },
    { displayName: "Li\u200Bnus" },
    { displayName: 7 },
  ]) {
    for (const response of [
      await define(owner, workspace.id, payload),
      await rename(owner, workspace.id, unclaimed, payload),
    ]) {
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.equal(errorCode(response), "bad_request");
    }
  }
  const longest = "x".repeat(64);
  assert.equal(
    (await define(owner, workspace.id, { displayName: longest })).statusCode,
    200,
  );
  assert.equal(
    (await rename(owner, workspace.id, unclaimed, { displayName: longest }))
      .statusCode,
    204,
  );
});

// The table-driven test in workspace-routes.test.ts covers an outsider on
// every route; a former admin, who could define and remove people before,
// gets the same answer here, with real person IDs and whatever the body holds.
test("a removed admin gets the answer for a workspace that does not exist on the people routes, and changes nothing", async (t) => {
  const owner = await signedIn(await workspaceApp(t, { githubId: 3117 }));
  const removedAdmin = await signedIn(
    await workspaceApp(t, { githubId: 3119 }),
  );
  const { workspace, member: ownerPerson } = await createWorkspace(owner);
  const unclaimed = await defined(owner, workspace.id);
  const formerPerson = await addClaimed(
    workspace.id,
    removedAdmin.device,
    owner.device,
    "admin",
  );
  await database()
    .update(workspaceMembers)
    .set({ removedAt: new Date(), removedByUserId: owner.device.userId })
    .where(eq(workspaceMembers.id, formerPerson));
  const before = await view(owner, workspace.id);
  const unknown = newId<WorkspaceId>();

  const requests = (workspaceId: string) => [
    define(removedAdmin, workspaceId, { displayName: "Eve" }),
    define(removedAdmin, workspaceId, { displayName: "" }),
    rename(removedAdmin, workspaceId, unclaimed, { displayName: "Eve" }),
    rename(removedAdmin, workspaceId, ownerPerson.id, { displayName: "Eve" }),
    rename(removedAdmin, workspaceId, formerPerson, { displayName: "Eve" }),
    rename(removedAdmin, workspaceId, "not-an-id", { displayName: "Eve" }),
    remove(removedAdmin, workspaceId, unclaimed),
    remove(removedAdmin, workspaceId, "not-an-id"),
  ];
  const nonMember = await Promise.all(requests(workspace.id));
  const missing = await Promise.all(requests(unknown));
  for (const [index, response] of nonMember.entries()) {
    const reference = missing[index];
    assert.ok(reference !== undefined);
    assert.equal(response.statusCode, 404, String(index));
    assert.equal(errorCode(response), "not_found");
    assert.equal(response.body, reference.body);
    assert.equal(
      response.headers["content-length"],
      reference.headers["content-length"],
    );
  }
  assert.deepEqual(await view(owner, workspace.id), before);

  // For a member, a malformed person ID is a bad request.
  for (const response of [
    await rename(owner, workspace.id, "not-an-id", { displayName: "Eve" }),
    await remove(owner, workspace.id, "not-an-id"),
  ]) {
    assert.equal(response.statusCode, 400);
    assert.equal(errorCode(response), "bad_request");
  }
});

test("an admin removed after the membership check and before the change gets the same 404, and nothing changes", async (t) => {
  // The route's transaction starts only after `beforeTransaction` ran, as if
  // the removal had committed between the membership check and the change.
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
  const recorded = recorder();
  const owner = await signedIn(await workspaceApp(t, { githubId: 3121 }));
  const admin = await signedIn(
    await deviceApp(t, { database: racing, githubId: 3122, ...recorded }),
  );
  const { workspace } = await createWorkspace(owner);
  const adminPerson = await addClaimed(
    workspace.id,
    admin.device,
    owner.device,
    "admin",
  );
  const unclaimed = await defined(owner, workspace.id);
  const before = await view(owner, workspace.id);
  const removeAdmin = () =>
    database()
      .update(workspaceMembers)
      .set({ removedAt: new Date(), removedByUserId: owner.device.userId })
      .where(eq(workspaceMembers.id, adminPerson));

  beforeTransaction = removeAdmin;
  const response = await remove(admin, workspace.id, unclaimed);
  assert.equal(beforeTransaction, null, "the route's transaction started");
  const unknown = await remove(admin, newId<WorkspaceId>(), unclaimed);
  assert.equal(response.statusCode, 404);
  assert.equal(response.body, unknown.body);
  const after = await view(owner, workspace.id);
  assert.deepEqual(
    after.members.filter((person) => person.id !== adminPerson),
    before.members.filter((person) => person.id !== adminPerson),
  );
  assert.deepEqual(recorded.events, [], "a refusal sends no event");
});

test("the people routes need a valid access token", async (t) => {
  const owner = await signedIn(await workspaceApp(t, { githubId: 3120 }));
  const { workspace } = await createWorkspace(owner);
  const unclaimed = await defined(owner, workspace.id);
  for (const [method, url, payload] of [
    ["POST", `/workspaces/${workspace.id}/members`, { displayName: "Eve" }],
    [
      "POST",
      `/workspaces/${workspace.id}/members/${unclaimed}/rename`,
      { displayName: "Eve" },
    ],
    ["POST", `/workspaces/${workspace.id}/members/${unclaimed}/remove`, {}],
  ] as const) {
    const response = await owner.app.inject({ method, url, payload });
    assert.equal(response.statusCode, 401, url);
    assert.equal(errorCode(response), "unauthorized");
  }
});
