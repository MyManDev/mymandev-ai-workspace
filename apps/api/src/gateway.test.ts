import {
  auditEvents,
  type Database,
  devices,
  revokeDevice,
  users,
  workspaceMembers,
  workspaces,
} from "@mymandev/database";
import {
  type AgentId,
  type AuthChallengeFrame,
  type ConnectionId,
  decodeServerMessage,
  type DeviceId,
  type EventId,
  type MemberId,
  newId,
  type RunId,
  SIGN_IN_LIFETIME_MS,
  type UnverifiedEvent,
  type UserId,
  UUIDV7_PATTERN,
  WS_AUTH_TIMEOUT_MS,
  WS_CLOSE_CODES,
  type WorkspaceId,
} from "@mymandev/protocol";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect as connectTcp, type Socket } from "node:net";
import { test, type TestContext } from "node:test";
import type { WebSocket } from "ws";
import { buildApp } from "./app.ts";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  deviceApp,
  type DeviceAppOptions,
  fakeClock,
  type Key,
  newKey,
  ORIGIN,
  signInAgain,
  type SignedInDevice,
  signInDevice,
  signInput,
  useTestDatabase,
} from "./auth/device-test-support.ts";
import { loadConfig } from "./config.ts";
import {
  AuditThrottle,
  type AuthenticatedConnectionContext,
  bindIdentity,
  type BindIdentityDependencies,
  CloseCode,
  CONNECTION_AUDIT_WINDOW_MS,
  ConnectionRegistry,
  type ConnectionIdentity,
  type EventHandler,
  MAX_UNAUTHENTICATED_CONNECTIONS,
  REFUSED_CLOSE_GRACE_MS,
  UNAUTHENTICATED_PLACE_SECONDS,
  type VerifiedEvent,
} from "./gateway.ts";

const database = useTestDatabase();

const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000005" as AgentId;
const OTHER_AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000006" as AgentId;
const RUN_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007" as RunId;
const ALLOWED_ORIGIN = "https://app.example";
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

type Json = Record<string, unknown>;
type Closed = Readonly<{ code: number; reason: string }>;
type Received = Readonly<{
  event: VerifiedEvent;
  context: AuthenticatedConnectionContext;
}>;

/**
 * An app with sign-in and the gateway that records every event that reaches
 * onEvent, then passes it to `handle`. `database` replaces the test database,
 * for example with an intercepting one.
 */
async function gatewayApp(
  t: TestContext,
  options: Omit<DeviceAppOptions, "database" | "onEvent"> &
    Readonly<{ database?: Database; handle?: EventHandler }>,
) {
  const received: Received[] = [];
  const { handle, ...rest } = options;
  const app = await deviceApp(t, {
    ...rest,
    database: options.database ?? database(),
    env: { API_ALLOWED_ORIGINS: ALLOWED_ORIGIN, ...options.env },
    onEvent: (event, context) => {
      received.push({ event, context });
      return handle?.(event, context);
    },
  });
  // injectWS never settles unless the app is ready.
  await app.ready();
  return { app, received };
}

/** Waits until the check passes; fails after two seconds. */
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Client = Readonly<{
  ws: WebSocket;
  /** The next message from the server, parsed; rejects when the connection closes first. */
  next: () => Promise<unknown>;
  closed: Promise<Closed>;
  send: (frame: unknown) => void;
}>;

/**
 * Opens a WebSocket on the app. The listeners are attached before the
 * connection opens, so the server's first frame is never missed.
 */
async function connect(
  t: TestContext,
  app: FastifyInstance,
  options: Readonly<{
    headers?: Record<string, string>;
    path?: string;
    /** The remote address that the per-address limit counts; injectWS has none otherwise. */
    remoteAddress?: string;
  }> = {},
): Promise<Client> {
  const messages: unknown[] = [];
  const waiting: Array<{
    resolve: (message: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  const closed = Promise.withResolvers<Closed>();
  let closeResult: Closed | null = null;
  const ws = await app.injectWS(
    options.path ?? "/ws",
    {
      headers: options.headers ?? {},
      ...(options.remoteAddress === undefined
        ? {}
        : { socket: { remoteAddress: options.remoteAddress } as Socket }),
    },
    {
      onInit: (socket) => {
        socket.on("message", (data) => {
          const message: unknown = JSON.parse(String(data));
          const waiter = waiting.shift();
          if (waiter === undefined) {
            messages.push(message);
          } else {
            waiter.resolve(message);
          }
        });
        socket.on("close", (code, reason) => {
          closeResult = { code, reason: reason.toString() };
          closed.resolve(closeResult);
          for (const waiter of waiting.splice(0)) {
            waiter.reject(new Error(`closed with ${code}`));
          }
        });
      },
    },
  );
  t.after(() => ws.terminate());
  return {
    ws,
    next: () => {
      if (messages.length > 0) {
        return Promise.resolve(messages.shift());
      }
      if (closeResult !== null) {
        return Promise.reject(new Error(`closed with ${closeResult.code}`));
      }
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
      });
    },
    closed: closed.promise,
    send: (frame) => {
      ws.send(
        typeof frame === "string" || Buffer.isBuffer(frame)
          ? frame
          : JSON.stringify(frame),
      );
    },
  };
}

/** Reads the server's auth.challenge, checking it with the device's decoder. */
async function challengeOf(client: Client): Promise<AuthChallengeFrame> {
  const decoded = decodeServerMessage(await client.next());
  assert.ok(
    decoded.ok &&
      decoded.kind === "frame" &&
      decoded.frame.type === "auth.challenge",
    JSON.stringify(decoded),
  );
  return decoded.frame;
}

type DeviceKey = Readonly<{ deviceId: string; key: Key }>;

/** The `ws` input that the device signs for a challenge. */
function wsInput(deviceId: string, challenge: AuthChallengeFrame) {
  return {
    purpose: "ws",
    audience: ORIGIN,
    nonce: challenge.nonce,
    deviceId,
    connectionId: challenge.connectionId,
  } as const;
}

function authResponse(deviceId: string, signature: string): Json {
  return { protocolVersion: 0, type: "auth.response", deviceId, signature };
}

/** The correctly signed auth.response for a challenge. */
function signedResponse(device: DeviceKey, challenge: AuthChallengeFrame) {
  return authResponse(
    device.deviceId,
    signInput(device.key, wsInput(device.deviceId, challenge)),
  );
}

/** Answers the challenge as the desktop does and returns auth.ok. */
async function authenticate(client: Client, device: DeviceKey) {
  const challenge = await challengeOf(client);
  client.send(signedResponse(device, challenge));
  const decoded = decodeServerMessage(await client.next());
  assert.ok(
    decoded.ok && decoded.kind === "frame" && decoded.frame.type === "auth.ok",
    JSON.stringify(decoded),
  );
  return { challenge, ok: decoded.frame };
}

/** Opens a connection and authenticates it. */
async function connected(
  t: TestContext,
  app: FastifyInstance,
  device: DeviceKey,
) {
  const client = await connect(t, app);
  const { challenge } = await authenticate(client, device);
  return { client, connectionId: challenge.connectionId };
}

/** A run transition that the agent's host device reports. */
function runEvent(
  workspaceId: WorkspaceId,
  deviceId: string,
  fields: Json = {},
): Json {
  return {
    protocolVersion: 0,
    id: newId<EventId>(),
    type: "agent.run.state_changed",
    occurredAt: "2026-10-27T12:34:56.789Z",
    workspaceId,
    actor: { kind: "agent", agentId: AGENT_ID },
    deviceId,
    payload: {
      runId: RUN_ID,
      agentId: AGENT_ID,
      previousState: "queued",
      state: "running",
    },
    ...fields,
  };
}

/** A workspace whose owner is the account. */
async function workspaceOf(userId: UserId): Promise<WorkspaceId> {
  const workspaceId = newId<WorkspaceId>();
  await database()
    .insert(workspaces)
    .values({ id: workspaceId, name: "Team", createdByUserId: userId });
  await database().insert(workspaceMembers).values({
    id: newId<MemberId>(),
    workspaceId,
    userId,
    displayName: "Owner",
    role: "owner",
    addedByUserId: userId,
    claimedAt: new Date(),
  });
  return workspaceId;
}

async function auditsOf(
  action: "connection.replaced" | "event.identity_mismatch",
  deviceId: string,
) {
  return database()
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, action),
        eq(auditEvents.actorDeviceId, deviceId as DeviceId),
      ),
    );
}

function closedWith(reason: keyof typeof WS_CLOSE_CODES): Closed {
  return { code: WS_CLOSE_CODES[reason], reason };
}

test("auth.challenge, auth.response, and auth.ok authenticate a device; auth.ok writes last_seen_at; an event then reaches onEvent with the frozen context", async (t) => {
  const clock = fakeClock();
  const signedInAt = clock.now();
  const connections = new ConnectionRegistry();
  const { app, received } = await gatewayApp(t, {
    githubId: 3001,
    now: clock.now,
    connections,
  });
  const device = await signInDevice(app);
  clock.advance(60_000);

  const client = await connect(t, app);
  const other = await connect(t, app);
  const challenge = await challengeOf(client);
  const otherChallenge = await challengeOf(other);
  assert.equal(challenge.protocolVersion, 0);
  assert.match(challenge.connectionId, UUIDV7_PATTERN);
  assert.notEqual(challenge.nonce, otherChallenge.nonce);
  assert.notEqual(challenge.connectionId, otherChallenge.connectionId);
  assert.equal(connections.pendingCount, 2);

  client.send(signedResponse(device, challenge));
  assert.deepEqual(await client.next(), {
    protocolVersion: 0,
    type: "auth.ok",
    userId: device.userId,
    deviceId: device.deviceId,
    signInExpiresAt: new Date(signedInAt + SIGN_IN_LIFETIME_MS).toISOString(),
  });
  assert.equal(connections.pendingCount, 1);
  assert.equal(connections.liveCount, 1);
  const [row] = await database()
    .select({ lastSeenAt: devices.lastSeenAt })
    .from(devices)
    .where(eq(devices.id, device.deviceId));
  assert.equal(row?.lastSeenAt?.getTime(), clock.now());

  const workspaceId = await workspaceOf(device.userId);
  const event = runEvent(workspaceId, device.deviceId);
  client.send({
    ...event,
    extra: "dropped",
    payload: { ...(event.payload as Json), extra: "dropped" },
  });
  await until(() => received.length === 1, "the event");
  const [first] = received;
  assert.ok(first);
  assert.deepEqual(first.event, event);
  assert.deepEqual(first.context, {
    connectionId: challenge.connectionId,
    identity: { userId: device.userId, deviceId: device.deviceId },
    signedInAt,
  });
  assert.ok(Object.isFrozen(first.context));
  assert.ok(Object.isFrozen(first.context.identity));
  assert.deepEqual(connections.connectionOf(device.deviceId), first.context);
});

/** Lets pending I/O between the test client and the server run. */
async function settle() {
  for (let round = 0; round < 10; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("without auth.response, the connection closes with auth_timeout after 10 seconds", async (t) => {
  const { app } = await gatewayApp(t, { githubId: 3002 });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const client = await connect(t, app);
    await challengeOf(client);
    t.mock.timers.tick(WS_AUTH_TIMEOUT_MS - 1);
    await settle();
    assert.equal(client.ws.readyState, client.ws.OPEN);
    t.mock.timers.tick(1);
    await settle();
    // The server's close frame arrived.
    assert.equal(client.ws.readyState, client.ws.CLOSING);
    // An injectWS client finishes its closing handshake only when the close
    // timer of ws fires, which the mocked clock holds back.
    t.mock.timers.runAll();
    assert.deepEqual(await client.closed, closedWith("auth_timeout"));
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(WS_AUTH_TIMEOUT_MS, 10_000);
});

test("before authentication no frame reaches onEvent: another frame, a frame over 1 KiB, a binary frame, bad JSON, and a second frame close with protocol_violation", async (t) => {
  const { app, received } = await gatewayApp(t, { githubId: 3003 });
  const device = await signInDevice(app);
  const workspaceId = await workspaceOf(device.userId);
  const event = runEvent(workspaceId, device.deviceId);

  /** A signed auth.response with an unknown field that brings its JSON to `bytes`. */
  const padded = (challenge: AuthChallengeFrame, bytes: number) => {
    const response = { ...signedResponse(device, challenge), pad: "" };
    const length = Buffer.byteLength(JSON.stringify(response));
    return JSON.stringify({ ...response, pad: "x".repeat(bytes - length) });
  };
  const cases: [
    label: string,
    frames: (challenge: AuthChallengeFrame) => Array<string | Buffer | Json>,
  ][] = [
    ["an event", () => [event]],
    [
      "a server frame",
      (challenge) => [{ ...challenge, type: "auth.challenge" }],
    ],
    [
      "an unknown frame",
      (challenge) => [
        { ...signedResponse(device, challenge), type: "auth.retry" },
      ],
    ],
    [
      "another protocol version",
      (challenge) => [
        { ...signedResponse(device, challenge), protocolVersion: 1 },
      ],
    ],
    ["a frame over 1 KiB", (challenge) => [padded(challenge, 1025)]],
    [
      "a binary frame",
      (challenge) => [
        Buffer.from(JSON.stringify(signedResponse(device, challenge))),
      ],
    ],
    ["bad JSON", () => ["{not json"]],
    [
      "an event after auth.response",
      (challenge) => [signedResponse(device, challenge), event],
    ],
    [
      "auth.response twice",
      (challenge) => [
        signedResponse(device, challenge),
        signedResponse(device, challenge),
      ],
    ],
  ];
  for (const [label, frames] of cases) {
    const client = await connect(t, app);
    const challenge = await challengeOf(client);
    for (const frame of frames(challenge)) {
      client.send(frame);
    }
    assert.deepEqual(
      await client.closed,
      closedWith("protocol_violation"),
      label,
    );
  }
  assert.equal(received.length, 0);

  // The limit counts the raw frame: exactly 1 KiB still authenticates.
  const client = await connect(t, app);
  const challenge = await challengeOf(client);
  client.send(padded(challenge, 1024));
  const decoded = decodeServerMessage(await client.next());
  assert.ok(decoded.ok && decoded.kind === "frame");
  assert.equal(decoded.frame.type, "auth.ok");
});

test("a wrong signature, audience, purpose, or connection ID, another connection's nonce or response, an unknown device, and a disabled account close with auth_failed", async (t) => {
  const { app } = await gatewayApp(t, { githubId: 3004 });
  const device = await signInDevice(app);
  const sign = (input: Parameters<typeof signInput>[1], key = device.key) =>
    authResponse(device.deviceId, signInput(key, input));

  const cases: [
    label: string,
    response: (
      challenge: AuthChallengeFrame,
      earlier: AuthChallengeFrame,
    ) => Json,
  ][] = [
    [
      "another key",
      (challenge) => sign(wsInput(device.deviceId, challenge), newKey()),
    ],
    [
      "another audience",
      (challenge) =>
        sign({
          ...wsInput(device.deviceId, challenge),
          audience: "https://other.example",
        }),
    ],
    [
      "the http purpose",
      (challenge) =>
        sign({
          purpose: "http",
          audience: ORIGIN,
          nonce: challenge.nonce,
          deviceId: device.deviceId,
          challengeId: challenge.connectionId,
        }),
    ],
    [
      "another connection ID",
      (challenge) =>
        sign({
          ...wsInput(device.deviceId, challenge),
          connectionId: newId<ConnectionId>(),
        }),
    ],
    [
      "another connection's nonce",
      (challenge, earlier) =>
        sign({ ...wsInput(device.deviceId, challenge), nonce: earlier.nonce }),
    ],
    [
      "another connection's response",
      (_challenge, earlier) => signedResponse(device, earlier),
    ],
    [
      "an unknown device",
      (challenge) => {
        const unknown = newId<DeviceId>();
        return authResponse(
          unknown,
          signInput(device.key, wsInput(unknown, challenge)),
        );
      },
    ],
  ];
  for (const [label, response] of cases) {
    const earlier = await connect(t, app);
    const earlierChallenge = await challengeOf(earlier);
    const client = await connect(t, app);
    const challenge = await challengeOf(client);
    client.send(response(challenge, earlierChallenge));
    assert.deepEqual(await client.closed, closedWith("auth_failed"), label);
  }

  await database()
    .update(users)
    .set({ disabledAt: new Date() })
    .where(eq(users.id, device.userId));
  const client = await connect(t, app);
  client.send(signedResponse(device, await challengeOf(client)));
  assert.deepEqual(
    await client.closed,
    closedWith("auth_failed"),
    "a disabled account",
  );
});

test("a revoked device gets device_revoked; a signed-out device, a sign-in 30 days old, and a later sign_in_required_at get sign_in_required; a bad signature always gets auth_failed", async (t) => {
  const clock = fakeClock();
  const { app } = await gatewayApp(t, { githubId: 3005, now: clock.now });
  const states: [
    label: string,
    expected: keyof typeof WS_CLOSE_CODES,
    change: (device: SignedInDevice) => Promise<unknown>,
  ][] = [
    [
      "revoked",
      "device_revoked",
      (d) =>
        database()
          .update(devices)
          .set({ revokedAt: new Date(clock.now()), revocationReason: "lost" })
          .where(eq(devices.id, d.deviceId)),
    ],
    [
      "signed out",
      "sign_in_required",
      (d) =>
        database()
          .update(devices)
          .set({ signedOutAt: new Date(clock.now()) })
          .where(eq(devices.id, d.deviceId)),
    ],
    [
      "sign-in 30 days old",
      "sign_in_required",
      (d) =>
        database()
          .update(devices)
          .set({ lastSignInAt: new Date(clock.now() - 30 * DAY_MS) })
          .where(eq(devices.id, d.deviceId)),
    ],
    [
      "GitHub revocation after the sign-in",
      "sign_in_required",
      (d) =>
        database()
          .update(users)
          .set({ signInRequiredAt: new Date(clock.now() + 1_000) })
          .where(eq(users.id, d.userId)),
    ],
  ];
  for (const [label, expected, change] of states) {
    const device = await signInDevice(app);
    await change(device);
    const valid = await connect(t, app);
    valid.send(signedResponse(device, await challengeOf(valid)));
    assert.deepEqual(await valid.closed, closedWith(expected), label);

    const forged = await connect(t, app);
    const challenge = await challengeOf(forged);
    forged.send(
      authResponse(
        device.deviceId,
        signInput(newKey(), wsInput(device.deviceId, challenge)),
      ),
    );
    assert.deepEqual(
      await forged.closed,
      closedWith("auth_failed"),
      `${label} with a bad signature`,
    );
    await database()
      .update(users)
      .set({ signInRequiredAt: null })
      .where(eq(users.id, device.userId));
  }

  // One millisecond before the 30 days end, the sign-in still counts.
  const device = await signInDevice(app);
  clock.advance(SIGN_IN_LIFETIME_MS - 1);
  const client = await connect(t, app);
  const { ok } = await authenticate(client, device);
  assert.equal(
    Date.parse(ok.signInExpiresAt) - clock.now(),
    1,
    "the expiry counts from the sign-in",
  );
});

test("a second connection of the same device replaces the first with connection_replaced; repeated replacements write one audit record per device per hour", async (t) => {
  const clock = fakeClock();
  const logLines: string[] = [];
  const connections = new ConnectionRegistry();
  const { app } = await gatewayApp(t, {
    githubId: 3006,
    now: clock.now,
    connections,
    logLines,
  });
  const device = await signInDevice(app);
  const first = await connected(t, app, device);
  assert.equal(
    (await auditsOf("connection.replaced", device.deviceId)).length,
    0,
  );

  const second = await connected(t, app, device);
  assert.deepEqual(
    await first.client.closed,
    closedWith("connection_replaced"),
  );
  assert.equal(second.client.ws.readyState, second.client.ws.OPEN);
  const [audit] = await auditsOf("connection.replaced", device.deviceId);
  assert.deepEqual(
    audit && {
      actorUserId: audit.actorUserId,
      subjectId: audit.subjectId,
      workspaceId: audit.workspaceId,
    },
    {
      actorUserId: device.userId,
      subjectId: device.deviceId,
      workspaceId: null,
    },
  );

  clock.advance(HOUR_MS - 1);
  const third = await connected(t, app, device);
  assert.deepEqual(
    await second.client.closed,
    closedWith("connection_replaced"),
  );
  const fourth = await connected(t, app, device);
  assert.deepEqual(
    await third.client.closed,
    closedWith("connection_replaced"),
  );
  assert.equal(
    (await auditsOf("connection.replaced", device.deviceId)).length,
    1,
  );
  const counted = logLines
    .map((line) => JSON.parse(line) as Json)
    .filter((entry) => entry.msg === "connection replaced")
    .map((entry) => entry.unauditedReplacements);
  assert.deepEqual(counted, [undefined, 1, 2]);

  clock.advance(1);
  const fifth = await connected(t, app, device);
  assert.deepEqual(
    await fourth.client.closed,
    closedWith("connection_replaced"),
  );
  assert.equal(
    (await auditsOf("connection.replaced", device.deviceId)).length,
    2,
  );
  assert.equal(connections.liveCount, 1);
  assert.equal(
    connections.connectionOf(device.deviceId as DeviceId)?.connectionId,
    fifth.connectionId,
  );
});

test("bindIdentity refuses an event with another device ID or user ID and audits it, and refuses an event from a removed member, for an unknown workspace, and from a revoked device", async (t) => {
  const clock = fakeClock();
  const { app, received } = await gatewayApp(t, {
    githubId: 3007,
    now: clock.now,
  });
  const device = await signInDevice(app);
  const workspaceId = await workspaceOf(device.userId);

  // Through the gateway: another device ID.
  const mismatch = await connected(t, app, device);
  const foreign = runEvent(workspaceId, newId<DeviceId>());
  mismatch.client.send(foreign);
  assert.deepEqual(await mismatch.client.closed, {
    code: CloseCode.policyViolation,
    reason: "identity_mismatch",
  });
  const audits = await auditsOf("event.identity_mismatch", device.deviceId);
  assert.deepEqual(
    audits.map((row) => ({
      actorUserId: row.actorUserId,
      subjectId: row.subjectId,
      workspaceId: row.workspaceId,
    })),
    [{ actorUserId: device.userId, subjectId: foreign.id, workspaceId: null }],
  );

  // Directly: a user actor must be the connection's user.
  const context: AuthenticatedConnectionContext = Object.freeze({
    connectionId: newId<ConnectionId>(),
    identity: Object.freeze({
      userId: device.userId,
      deviceId: device.deviceId,
    }),
    signedInAt: clock.now(),
  });
  const dependencies: BindIdentityDependencies = {
    database: database(),
    now: clock.now,
    mismatchAudits: new AuditThrottle(CONNECTION_AUDIT_WINDOW_MS, clock.now),
    log: app.log,
  };
  // No event type takes a user actor from a device yet (chat comes in M2).
  const userEvent = (userId: string) =>
    ({
      ...runEvent(workspaceId, device.deviceId),
      actor: { kind: "user", userId },
    }) as unknown as UnverifiedEvent;
  const otherUser = userEvent(newId<UserId>());
  assert.deepEqual(await bindIdentity(otherUser, context, dependencies), {
    ok: false,
    code: "identity_mismatch",
  });
  assert.deepEqual(
    (await auditsOf("event.identity_mismatch", device.deviceId))
      .map((row) => row.subjectId)
      .sort(),
    [foreign.id, otherUser.id].sort(),
  );
  const ownUser = userEvent(device.userId);
  assert.deepEqual(await bindIdentity(ownUser, context, dependencies), {
    ok: true,
    event: ownUser,
  });

  // A removed member and a workspace that does not exist.
  await database()
    .update(workspaceMembers)
    .set({ removedAt: new Date(clock.now()), removedByUserId: device.userId })
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  for (const [label, target] of [
    ["a removed member", workspaceId],
    ["an unknown workspace", newId<WorkspaceId>()],
  ] as const) {
    const { client } = await connected(t, app, device);
    client.send(runEvent(target, device.deviceId));
    assert.deepEqual(
      await client.closed,
      { code: CloseCode.policyViolation, reason: "not_a_member" },
      label,
    );
  }

  // A device revoked after its connection authenticated.
  const active = await workspaceOf(device.userId);
  const { client } = await connected(t, app, device);
  await database()
    .update(devices)
    .set({ revokedAt: new Date(clock.now()), revocationReason: "removed" })
    .where(eq(devices.id, device.deviceId));
  client.send(runEvent(active, device.deviceId));
  assert.deepEqual(await client.closed, closedWith("device_revoked"));

  assert.equal(received.length, 0);
  assert.equal(
    (await auditsOf("event.identity_mismatch", device.deviceId)).length,
    2,
    "only mismatches are audited",
  );
});

test("after authentication, the M1-02 frame rules stay: 1003, 1007, 1008 with the decode code, 1009, and nothing after an invalid frame", async (t) => {
  const { app, received } = await gatewayApp(t, { githubId: 3008 });
  const device = await signInDevice(app);
  const workspaceId = await workspaceOf(device.userId);
  const valid = runEvent(workspaceId, device.deviceId);
  const withPayload = (fields: Json) => ({
    ...valid,
    payload: { ...(valid.payload as Json), ...fields },
  });
  const cases: [expected: Closed, frames: Array<string | Buffer | Json>][] = [
    [
      { code: CloseCode.unsupportedData, reason: "binary_not_supported" },
      [Buffer.from(JSON.stringify(valid))],
    ],
    [
      { code: CloseCode.invalidFramePayload, reason: "invalid_json" },
      ["{not json", ...Array.from({ length: 20 }, () => valid)],
    ],
    [
      { code: CloseCode.policyViolation, reason: "malformed" },
      [{ protocolVersion: 0 }],
    ],
    [
      { code: CloseCode.policyViolation, reason: "unsupported_version" },
      [{ ...valid, protocolVersion: 1 }],
    ],
    [
      { code: CloseCode.policyViolation, reason: "unknown_type" },
      [{ ...valid, type: "agent.run.deleted" }],
    ],
    [
      { code: CloseCode.policyViolation, reason: "invalid_payload" },
      [withPayload({ previousState: "completed" })],
    ],
    [
      { code: CloseCode.policyViolation, reason: "invalid_actor" },
      [{ ...valid, actor: { kind: "agent", agentId: OTHER_AGENT_ID } }],
    ],
    [
      { code: CloseCode.policyViolation, reason: "not_allowed_from_device" },
      [{ ...valid, actor: { kind: "system" } }],
    ],
    [
      { code: CloseCode.policyViolation, reason: "malformed" },
      [authResponse(device.deviceId, "A".repeat(86))],
    ],
  ];
  for (const [expected, frames] of cases) {
    const { client } = await connected(t, app, device);
    for (const frame of frames) {
      client.send(frame);
    }
    assert.deepEqual(await client.closed, expected, JSON.stringify(expected));
  }
  const { client } = await connected(t, app, device);
  client.send("x".repeat(70 * 1024));
  assert.equal((await client.closed).code, CloseCode.messageTooBig);
  assert.equal(received.length, 0);
});

/** Sends a WebSocket handshake to the listening app and returns the raw HTTP answer. */
async function rawHandshake(app: FastifyInstance): Promise<string> {
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  const socket = connectTcp(address.port, "127.0.0.1");
  await once(socket, "connect");
  let raw = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    raw += chunk;
  });
  const closed = once(socket, "close");
  const crlf = String.fromCharCode(13, 10);
  socket.write(
    [
      "GET /ws HTTP/1.1",
      "Host: 127.0.0.1",
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "",
      "",
    ].join(crlf),
  );
  await closed;
  return raw;
}

test("the 201st unauthenticated connection gets 429 with Retry-After before the upgrade", async (t) => {
  const connections = new ConnectionRegistry();
  const { app } = await gatewayApp(t, { githubId: 3009, connections });
  const device = await signInDevice(app);
  // Each from its own address, so that the per-address limit stays out of the way.
  const address = (index: number) =>
    `10.0.${Math.floor(index / 100)}.${index % 100}`;
  const waiting: Client[] = [];
  for (let index = 0; index < MAX_UNAUTHENTICATED_CONNECTIONS; index += 1) {
    waiting.push(await connect(t, app, { remoteAddress: address(index) }));
  }
  assert.equal(MAX_UNAUTHENTICATED_CONNECTIONS, 200);
  assert.equal(connections.pendingCount, 200);
  await assert.rejects(
    connect(t, app, { remoteAddress: address(200) }),
    /429/u,
  );
  assert.equal(connections.pendingCount, 200, "no socket was created");

  await app.listen({ host: "127.0.0.1", port: 0 });
  const raw = await rawHandshake(app);
  const crlf = String.fromCharCode(13, 10);
  const [head = "", body = ""] = raw.split(crlf + crlf);
  assert.match(head, /^HTTP\/1\.1 429 /u);
  // 10 seconds to authenticate and 1 second to close.
  assert.equal(UNAUTHENTICATED_PLACE_SECONDS, 11);
  assert.match(head, /^retry-after: 11$/imu);
  assert.deepEqual(JSON.parse(body), {
    statusCode: 429,
    error: "Too Many Requests",
    message: "Too Many Requests",
    code: "rate_limited",
  });

  // A connection that authenticates frees its place.
  const [first] = waiting;
  assert.ok(first);
  await authenticate(first, device);
  assert.equal(connections.pendingCount, 199);
  await connect(t, app, { remoteAddress: address(201) });
  assert.equal(connections.pendingCount, 200);
});

test("the type checker refuses an event handler or a bindIdentity call with a ConnectionContext whose identity can be null", () => {
  type ConnectionContext = Readonly<{
    connectionId: ConnectionId;
    identity: ConnectionIdentity | null;
    signedInAt: number;
  }>;
  const typeOnly = (
    handler: EventHandler,
    event: UnverifiedEvent,
    verifiedEvent: VerifiedEvent,
    context: AuthenticatedConnectionContext,
    nullable: ConnectionContext,
    dependencies: BindIdentityDependencies,
  ) => {
    // @ts-expect-error -- the handler needs a context whose identity is never null
    handler(verifiedEvent, nullable);
    // @ts-expect-error -- bindIdentity needs a context whose identity is never null
    void bindIdentity(event, nullable, dependencies);
    // @ts-expect-error -- the handler takes only an event that bindIdentity verified
    handler(event, context);
    // @ts-expect-error -- an UnverifiedEvent never becomes a VerifiedEvent by assignment
    const assigned: VerifiedEvent = event;
    handler(verifiedEvent, context);
    void bindIdentity(event, context, dependencies);
    return assigned;
  };
  assert.equal(typeof typeOnly, "function");
});

test("no authentication frame, nonce, signature, or query string reaches the logs; refusals log the code with the connection ID only", async (t) => {
  const logLines: string[] = [];
  const { app, received } = await gatewayApp(t, {
    githubId: 3010,
    logLines,
    env: { API_LOG_LEVEL: "trace" },
  });
  const device = await signInDevice(app);
  const workspaceId = await workspaceOf(device.userId);
  const token = "SECRET_URL_TOKEN_2";
  const secrets: string[] = [token];

  const client = await connect(t, app, { path: `/ws?token=${token}` });
  const challenge = await challengeOf(client);
  const response = signedResponse(device, challenge);
  secrets.push(challenge.nonce, String(response.signature));
  client.send(response);
  await client.next();
  client.send(runEvent(workspaceId, device.deviceId));

  const forged = await connect(t, app);
  const forgedChallenge = await challengeOf(forged);
  const forgedResponse = authResponse(
    device.deviceId,
    signInput(newKey(), wsInput(device.deviceId, forgedChallenge)),
  );
  secrets.push(forgedChallenge.nonce, String(forgedResponse.signature));
  forged.send(forgedResponse);
  await forged.closed;

  const violating = await connect(t, app);
  const violatingChallenge = await challengeOf(violating);
  secrets.push(violatingChallenge.nonce);
  violating.send({ ...response, type: "auth.retry" });
  await violating.closed;
  await until(() => received.length === 1, "the event");

  const entries = logLines.map((line) => JSON.parse(line) as Json);
  assert.ok(
    entries.some((entry) => entry.msg === "connection authenticated"),
    "authentication is logged",
  );
  for (const line of logLines) {
    for (const secret of secrets) {
      assert.equal(line.includes(secret), false, line);
    }
    assert.equal(line.includes("auth.response"), false, line);
  }
  const requests = entries
    .filter((entry) => entry.msg === "incoming request")
    .map((entry) => (entry.req as { url?: string } | undefined)?.url);
  assert.ok(requests.includes("/ws"));
  const refusals = entries.filter(
    (entry) => entry.msg === "connection refused",
  );
  assert.deepEqual(
    refusals.map((entry) => entry.code),
    ["auth_failed", "protocol_violation"],
  );
  for (const entry of refusals) {
    assert.match(String(entry.connectionId), UUIDV7_PATTERN);
    assert.equal(entry.deviceId, undefined);
    assert.equal(entry.userId, undefined);
  }
  assert.deepEqual(
    refusals.map((entry) => entry.connectionId),
    [forgedChallenge.connectionId, violatingChallenge.connectionId],
  );
});

test("closeDevice and closeUser close live connections with the given reason", async (t) => {
  const connections = new ConnectionRegistry();
  const { app } = await gatewayApp(t, { githubId: 3011, connections });
  const laptop = await signInDevice(app);
  const desktop = await signInDevice(app);
  const otherApp = (await gatewayApp(t, { githubId: 3012, connections })).app;
  const stranger = await signInDevice(otherApp);
  const first = await connected(t, app, laptop);
  const second = await connected(t, app, desktop);
  const third = await connected(t, otherApp, stranger);
  assert.equal(connections.liveCount, 3);

  assert.equal(
    connections.closeDevice(laptop.deviceId as DeviceId, "device_revoked"),
    true,
  );
  assert.deepEqual(await first.client.closed, closedWith("device_revoked"));
  assert.equal(
    connections.closeDevice(laptop.deviceId as DeviceId, "device_revoked"),
    false,
  );
  assert.equal(connections.closeUser(desktop.userId, "sign_in_required"), 1);
  assert.deepEqual(await second.client.closed, closedWith("sign_in_required"));
  assert.equal(third.client.ws.readyState, third.client.ws.OPEN);
  assert.equal(connections.liveCount, 1);
});

test("a foreign browser origin gets 403; a listed origin and no origin connect, and shutdown closes pending and authenticated connections with 1001", async (t) => {
  const { app } = await gatewayApp(t, { githubId: 3013 });
  const device = await signInDevice(app);
  await assert.rejects(
    app.injectWS("/ws", { headers: { origin: "https://evil.example" } }),
    /403/u,
  );
  const pending = await connect(t, app, {
    headers: { origin: ALLOWED_ORIGIN },
  });
  const { client } = await connected(t, app, device);
  const closed = [pending.closed, client.closed];
  await app.close();
  for (const result of await Promise.all(closed)) {
    assert.deepEqual(result, {
      code: CloseCode.goingAway,
      reason: "server_shutdown",
    });
  }
});

test("a connection that closes leaves the registry, before and after authentication", async (t) => {
  const connections = new ConnectionRegistry();
  const { app } = await gatewayApp(t, { githubId: 3014, connections });
  const device = await signInDevice(app);
  // injectWS sockets never report their close to the server, so this test
  // uses a real socket and Node's own WebSocket client.
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const open = () => {
    const socket = new globalThis.WebSocket(url);
    t.after(() => socket.close());
    const messages: unknown[] = [];
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)));
    });
    return { socket, messages };
  };

  const pending = open();
  await until(() => pending.messages.length === 1, "the challenge");
  assert.equal(connections.pendingCount, 1);
  pending.socket.close();
  await until(() => connections.pendingCount === 0, "the pending close");

  const live = open();
  await until(() => live.messages.length === 1, "the challenge");
  const decoded = decodeServerMessage(live.messages[0]);
  assert.ok(
    decoded.ok &&
      decoded.kind === "frame" &&
      decoded.frame.type === "auth.challenge",
  );
  live.socket.send(JSON.stringify(signedResponse(device, decoded.frame)));
  await until(() => live.messages.length === 2, "auth.ok");
  assert.equal(connections.liveCount, 1);
  assert.equal(connections.pendingCount, 0);
  live.socket.close();
  await until(() => connections.liveCount === 0, "the live close");
  assert.equal(
    connections.connectionOf(device.deviceId as DeviceId),
    null,
    "a closed connection is no longer the device's",
  );
});

test("without GitHub sign-in or without a database, /ws answers 404", async (t) => {
  const configs = [
    loadConfig({ NODE_ENV: "test" }),
    loadConfig({
      NODE_ENV: "test",
      API_PUBLIC_ORIGIN: ORIGIN,
      API_GITHUB_CLIENT_ID: CLIENT_ID,
      API_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    }),
  ];
  for (const config of configs) {
    const app = await buildApp({
      config,
      version: "0.0.0",
      logger: false,
      shutdownGraceMs: 50,
    });
    t.after(() => app.close());
    await app.ready();
    await assert.rejects(app.injectWS("/ws"), /404/u);
  }
});

type AnyFunction = (...args: unknown[]) => unknown;

/** A query builder whose result waits for `before` first. */
function delayed<T extends object>(
  builder: T,
  before: () => Promise<unknown>,
): T {
  return new Proxy(builder, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      const method = value as AnyFunction;
      if (property === "then") {
        return (onFulfilled?: AnyFunction, onRejected?: AnyFunction) =>
          before().then(
            () => method.call(target, onFulfilled, onRejected),
            onRejected,
          );
      }
      return (...args: unknown[]) => {
        const result = method.apply(target, args);
        return typeof result === "object" && result !== null
          ? delayed(result, before)
          : result;
      };
    },
  });
}

type QueryKind = "select" | "update";

/**
 * Wraps the test database. After `interceptNext(kind, table, before)`, the
 * next query that starts with `update(table)` or `select(...).from(table)`,
 * as `kind` says, waits for `before` first: a change that commits while the
 * gateway is between two of its steps.
 */
function interceptingDatabase(target: Database) {
  let hook: Readonly<{
    kind: QueryKind;
    table: unknown;
    before: () => Promise<unknown>;
  }> | null = null;
  const take = (kind: QueryKind, table: unknown) => {
    if (hook === null || hook.kind !== kind || hook.table !== table) {
      return null;
    }
    const { before } = hook;
    hook = null;
    return before;
  };
  const wrap = <T extends object>(
    kind: QueryKind,
    query: T,
    table: unknown,
  ): T => {
    const before = take(kind, table);
    return before === null ? query : delayed(query, before);
  };
  const proxy = new Proxy(target, {
    get(object, property) {
      const value: unknown = Reflect.get(object, property, object);
      if (typeof value !== "function") {
        return value;
      }
      const method = value as AnyFunction;
      if (property === "update") {
        return (table: unknown) =>
          wrap("update", method.call(object, table) as object, table);
      }
      if (property === "select") {
        return (...args: unknown[]) => {
          const builder = method.apply(object, args) as object;
          return new Proxy(builder, {
            get(inner, key) {
              const field: unknown = Reflect.get(inner, key, inner);
              if (typeof field !== "function") {
                return field;
              }
              const call = field as AnyFunction;
              return key === "from"
                ? (table: unknown) =>
                    wrap("select", call.call(inner, table) as object, table)
                : call.bind(inner);
            },
          });
        };
      }
      return method.bind(object);
    },
  });
  return {
    database: proxy,
    interceptNext: (
      kind: QueryKind,
      table: unknown,
      before: () => Promise<unknown>,
    ) => {
      hook = { kind, table, before };
    },
  };
}

/** The first of the next message and the close, so that a missing close fails at once. */
async function outcomeOf(
  client: Client,
): Promise<Closed | { message: unknown }> {
  return Promise.race([
    client.closed,
    client.next().then(
      (message) => ({ message }),
      () => client.closed,
    ),
  ]);
}

test("a revocation, sign-out, disable, or new sign-in that commits between the state check and the registration closes the connection before auth.ok, and nothing stays live", async (t) => {
  const clock = fakeClock();
  const connections = new ConnectionRegistry();
  const intercepting = interceptingDatabase(database());
  const { app } = await gatewayApp(t, {
    githubId: 3015,
    now: clock.now,
    connections,
    database: intercepting.database,
  });
  const changes: [
    label: string,
    expected: keyof typeof WS_CLOSE_CODES,
    change: (device: SignedInDevice) => Promise<unknown>,
  ][] = [
    [
      "revoked",
      "device_revoked",
      (d) =>
        revokeDevice(database(), {
          deviceId: d.deviceId,
          userId: d.userId,
          reason: "removed",
          now: new Date(clock.now()),
          actorUserId: d.userId,
          actorDeviceId: d.deviceId,
        }),
    ],
    [
      "signed out",
      "sign_in_required",
      (d) =>
        database()
          .update(devices)
          .set({ signedOutAt: new Date(clock.now()) })
          .where(eq(devices.id, d.deviceId)),
    ],
    [
      "disabled",
      "auth_failed",
      (d) =>
        database()
          .update(users)
          .set({ disabledAt: new Date(clock.now()) })
          .where(eq(users.id, d.userId)),
    ],
    [
      "a new sign-in replaced the key",
      "key_replaced",
      async (d) => {
        clock.advance(1_000);
        await signInAgain(app, d);
      },
    ],
  ];
  for (const [label, expected, change] of changes) {
    const device = await signInDevice(app);
    const client = await connect(t, app);
    const challenge = await challengeOf(client);
    // markDeviceSeen runs after the first state check and before the registration.
    intercepting.interceptNext("update", devices, () => change(device));
    client.send(signedResponse(device, challenge));
    assert.deepEqual(await outcomeOf(client), closedWith(expected), label);
    assert.equal(
      connections.connectionOf(device.deviceId as DeviceId),
      null,
      label,
    );
    assert.equal(connections.liveCount, 0, label);
    await database()
      .update(users)
      .set({ disabledAt: null })
      .where(eq(users.id, device.userId));
  }
});

test("every event re-checks the device: a newer sign-in gets key_replaced, a disabled account gets auth_failed, a sign-out or a later GitHub revocation gets sign_in_required, and the 30-day expiry is left to the sweep", async (t) => {
  const clock = fakeClock();
  const { app, received } = await gatewayApp(t, {
    githubId: 3016,
    now: clock.now,
  });
  const cases: [
    label: string,
    expected: keyof typeof WS_CLOSE_CODES,
    change: (device: SignedInDevice) => Promise<unknown>,
  ][] = [
    [
      "a new sign-in replaced the key",
      "key_replaced",
      async (d) => {
        clock.advance(1_000);
        await signInAgain(app, d);
      },
    ],
    [
      "disabled",
      "auth_failed",
      (d) =>
        database()
          .update(users)
          .set({ disabledAt: new Date(clock.now()) })
          .where(eq(users.id, d.userId)),
    ],
    [
      "signed out",
      "sign_in_required",
      (d) =>
        database()
          .update(devices)
          .set({ signedOutAt: new Date(clock.now()) })
          .where(eq(devices.id, d.deviceId)),
    ],
    [
      "GitHub revocation after the sign-in",
      "sign_in_required",
      (d) =>
        database()
          .update(users)
          .set({ signInRequiredAt: new Date(clock.now() + 1_000) })
          .where(eq(users.id, d.userId)),
    ],
  ];
  for (const [label, expected, change] of cases) {
    const device = await signInDevice(app);
    const workspaceId = await workspaceOf(device.userId);
    const { client } = await connected(t, app, device);
    await change(device);
    client.send(runEvent(workspaceId, device.deviceId));
    assert.deepEqual(await client.closed, closedWith(expected), label);
    await database()
      .update(users)
      .set({ disabledAt: null, signInRequiredAt: null })
      .where(eq(users.id, device.userId));
  }
  assert.equal(received.length, 0);

  // An open connection outlives the 30 days; the sweep of part B closes it.
  const device = await signInDevice(app);
  const workspaceId = await workspaceOf(device.userId);
  const { client } = await connected(t, app, device);
  clock.advance(SIGN_IN_LIFETIME_MS + HOUR_MS);
  client.send(runEvent(workspaceId, device.deviceId));
  await until(() => received.length === 1, "the event after 30 days");
  assert.equal(client.ws.readyState, client.ws.OPEN);
});

test("a refused or timed-out connection is terminated 1 second after its close frame and frees its place within 11 seconds", async (t) => {
  const connections = new ConnectionRegistry();
  const { app } = await gatewayApp(t, { githubId: 3017, connections });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const refused = await connect(t, app);
    const silent = await connect(t, app);
    await challengeOf(refused);
    await challengeOf(silent);
    assert.equal(connections.pendingCount, 2);

    refused.send("{not json");
    await settle();
    assert.equal(refused.ws.readyState, refused.ws.CLOSING);
    assert.equal(connections.pendingCount, 2, "the close frame frees nothing");
    t.mock.timers.tick(REFUSED_CLOSE_GRACE_MS - 1);
    await settle();
    assert.equal(connections.pendingCount, 2);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(connections.pendingCount, 1, "the refused one is gone");

    // The silent one times out at 10 seconds and is gone at 11.
    t.mock.timers.tick(WS_AUTH_TIMEOUT_MS - REFUSED_CLOSE_GRACE_MS);
    await settle();
    assert.equal(silent.ws.readyState, silent.ws.CLOSING);
    assert.equal(connections.pendingCount, 1);
    t.mock.timers.tick(REFUSED_CLOSE_GRACE_MS);
    await settle();
    assert.equal(connections.pendingCount, 0);
  } finally {
    t.mock.timers.reset();
  }
});

test("one remote address may open 60 handshakes in 10 minutes; the 61st gets 429 with Retry-After before the upgrade", async (t) => {
  const connections = new ConnectionRegistry();
  const { app } = await gatewayApp(t, { githubId: 3018, connections });
  for (let index = 0; index < 60; index += 1) {
    await connect(t, app, { remoteAddress: "127.0.0.1" });
  }
  await assert.rejects(connect(t, app, { remoteAddress: "127.0.0.1" }), /429/u);
  assert.equal(connections.pendingCount, 60, "no socket was created");
  await connect(t, app, { remoteAddress: "10.4.0.1" });
  assert.equal(connections.pendingCount, 61, "another address is not limited");

  await app.listen({ host: "127.0.0.1", port: 0 });
  const raw = await rawHandshake(app);
  const crlf = String.fromCharCode(13, 10);
  const [head = "", body = ""] = raw.split(crlf + crlf);
  assert.match(head, /^HTTP\/1\.1 429 /u);
  const retryAfter = Number(/^retry-after: ([0-9]+)$/imu.exec(head)?.[1]);
  assert.ok(retryAfter > 0 && retryAfter <= 600, head);
  assert.equal(JSON.parse(body).code, "rate_limited");
});

test("an authenticated connection stays open past the 10-second authentication timeout", async (t) => {
  const { app, received } = await gatewayApp(t, { githubId: 3019 });
  const device = await signInDevice(app);
  const workspaceId = await workspaceOf(device.userId);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { client } = await connected(t, app, device);
    t.mock.timers.tick(WS_AUTH_TIMEOUT_MS * 3);
    await settle();
    assert.equal(client.ws.readyState, client.ws.OPEN);
    client.send(runEvent(workspaceId, device.deviceId));
    const deadline = Date.now() + 2_000;
    while (received.length === 0 && Date.now() < deadline) {
      await settle();
    }
    assert.equal(received.length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("with real sockets, the replaced connection's close leaves the newer connection live", async (t) => {
  const connections = new ConnectionRegistry();
  const { app } = await gatewayApp(t, { githubId: 3020, connections });
  const device = await signInDevice(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const open = async () => {
    const socket = new globalThis.WebSocket(url);
    t.after(() => socket.close());
    const messages: unknown[] = [];
    const closed = new Promise<Closed>((resolve) => {
      socket.addEventListener("close", (event) => {
        resolve({ code: event.code, reason: event.reason });
      });
    });
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)));
    });
    await until(() => messages.length === 1, "the challenge");
    const decoded = decodeServerMessage(messages[0]);
    assert.ok(
      decoded.ok &&
        decoded.kind === "frame" &&
        decoded.frame.type === "auth.challenge",
    );
    socket.send(JSON.stringify(signedResponse(device, decoded.frame)));
    await until(() => messages.length === 2, "auth.ok");
    return { socket, closed, connectionId: decoded.frame.connectionId };
  };

  const older = await open();
  const newer = await open();
  assert.deepEqual(await older.closed, closedWith("connection_replaced"));
  older.socket.close();
  // The server has seen the older socket close once its client list shrinks.
  await until(
    () => app.websocketServer.clients.size === 1,
    "the older socket's close on the server",
  );
  assert.equal(connections.liveCount, 1);
  assert.equal(
    connections.connectionOf(device.deviceId as DeviceId)?.connectionId,
    newer.connectionId,
  );
});

test("two connections of the same device that authenticate at once end with exactly one live connection", async (t) => {
  const connections = new ConnectionRegistry();
  const { app } = await gatewayApp(t, { githubId: 3021, connections });
  const device = await signInDevice(app);
  const first = await connect(t, app);
  const second = await connect(t, app);
  const firstChallenge = await challengeOf(first);
  const secondChallenge = await challengeOf(second);
  first.send(signedResponse(device, firstChallenge));
  second.send(signedResponse(device, secondChallenge));

  const replaced = await Promise.race([
    first.closed.then((closed) => ({ closed, survivor: second })),
    second.closed.then((closed) => ({ closed, survivor: first })),
  ]);
  assert.deepEqual(replaced.closed, closedWith("connection_replaced"));
  const survivorId =
    replaced.survivor === first
      ? firstChallenge.connectionId
      : secondChallenge.connectionId;
  const ok = decodeServerMessage(await replaced.survivor.next());
  assert.ok(ok.ok && ok.kind === "frame" && ok.frame.type === "auth.ok");
  await settle();
  assert.equal(replaced.survivor.ws.readyState, replaced.survivor.ws.OPEN);
  assert.equal(connections.liveCount, 1);
  assert.equal(
    connections.connectionOf(device.deviceId as DeviceId)?.connectionId,
    survivorId,
  );
  assert.equal(
    (await auditsOf("connection.replaced", device.deviceId)).length,
    1,
  );
});

test("an event in flight on a connection that is replaced or closed meanwhile is not delivered", async (t) => {
  const connections = new ConnectionRegistry();
  const intercepting = interceptingDatabase(database());
  const { app, received } = await gatewayApp(t, {
    githubId: 3022,
    connections,
    database: intercepting.database,
  });
  const device = await signInDevice(app);
  const workspaceId = await workspaceOf(device.userId);

  // A newer connection replaces this one while its event checks membership.
  const replacedOne = await connected(t, app, device);
  let newer: Awaited<ReturnType<typeof connected>> | undefined;
  intercepting.interceptNext("select", workspaceMembers, async () => {
    newer = await connected(t, app, device);
  });
  replacedOne.client.send(runEvent(workspaceId, device.deviceId));
  assert.deepEqual(
    await replacedOne.client.closed,
    closedWith("connection_replaced"),
  );
  await settle();
  assert.equal(received.length, 0, "the replaced connection's event");

  // closeDevice closes the newer one while its event checks membership.
  assert.ok(newer);
  intercepting.interceptNext("select", workspaceMembers, async () => {
    connections.closeDevice(device.deviceId as DeviceId, "sign_in_required");
  });
  newer.client.send(runEvent(workspaceId, device.deviceId));
  assert.deepEqual(await newer.client.closed, closedWith("sign_in_required"));
  await settle();
  assert.equal(received.length, 0, "the closed connection's event");

  // Without a change in between, the event arrives.
  const { client } = await connected(t, app, device);
  client.send(runEvent(workspaceId, device.deviceId));
  await until(() => received.length === 1, "the event");
});

test("identity mismatches are audited at most once per device per hour and the rest are logged with a count", async (t) => {
  const clock = fakeClock();
  const logLines: string[] = [];
  const { app } = await gatewayApp(t, {
    githubId: 3023,
    now: clock.now,
    logLines,
  });
  const device = await signInDevice(app);
  const workspaceId = await workspaceOf(device.userId);
  const mismatch = async () => {
    const { client } = await connected(t, app, device);
    client.send(runEvent(workspaceId, newId<DeviceId>()));
    assert.deepEqual(await client.closed, {
      code: CloseCode.policyViolation,
      reason: "identity_mismatch",
    });
  };
  await mismatch();
  await mismatch();
  clock.advance(HOUR_MS - 1);
  await mismatch();
  assert.equal(
    (await auditsOf("event.identity_mismatch", device.deviceId)).length,
    1,
  );
  assert.deepEqual(
    logLines
      .map((line) => JSON.parse(line) as Json)
      .filter((entry) => entry.msg === "identity mismatch")
      .map((entry) => entry.unauditedMismatches),
    [undefined, 1, 2],
  );
  clock.advance(1);
  await mismatch();
  assert.equal(
    (await auditsOf("event.identity_mismatch", device.deviceId)).length,
    2,
  );
});

test("an AuditThrottle allows one record per device per window and drops a device's count when its window ends", () => {
  const clock = fakeClock();
  const throttle = new AuditThrottle(HOUR_MS, clock.now);
  const first = newId<DeviceId>();
  const second = newId<DeviceId>();
  assert.deepEqual(
    [throttle.take(first), throttle.take(first), throttle.take(first)],
    [0, 1, 2],
  );
  assert.equal(throttle.size, 1);
  clock.advance(HOUR_MS - 1);
  assert.equal(throttle.take(second), 0);
  assert.equal(throttle.take(first), 3);
  assert.equal(throttle.size, 2);
  clock.advance(1);
  throttle.sweep();
  assert.equal(throttle.size, 1, "the first device's window ended");
  assert.equal(throttle.take(first), 0, "a new window starts with a record");
});

test("a frame over 64 KiB is logged at debug level with the connection ID, not as an error", async (t) => {
  const logLines: string[] = [];
  const { app } = await gatewayApp(t, {
    githubId: 3024,
    logLines,
    env: { API_LOG_LEVEL: "trace" },
  });
  const device = await signInDevice(app);
  const { client, connectionId } = await connected(t, app, device);
  client.send("x".repeat(70 * 1024));
  assert.equal((await client.closed).code, CloseCode.messageTooBig);
  await until(
    () => logLines.some((line) => line.includes('"connection error"')),
    "the error log line",
  );
  const entries = logLines.map((line) => JSON.parse(line) as Json);
  const errors = entries.filter((entry) => entry.msg === "connection error");
  assert.deepEqual(
    errors.map((entry) => [entry.level, entry.connectionId]),
    [[20, connectionId]],
  );
  assert.deepEqual(
    entries.filter((entry) => Number(entry.level) >= 50),
    [],
  );
});

test("the gateway awaits an asynchronous event handler before the next event, and a failing handler closes with 1011 and a redacted log", async (t) => {
  const logLines: string[] = [];
  const steps: string[] = [];
  const release = Promise.withResolvers<void>();
  const secret = "SECRET_QUERY_PARAMETER";
  let fail = false;
  const { app } = await gatewayApp(t, {
    githubId: 3025,
    logLines,
    handle: async (event) => {
      if (fail) {
        throw Object.assign(new Error(`insert failed with ${secret}`), {
          query: "insert into messages ...",
          params: [secret],
        });
      }
      steps.push(`start ${event.id}`);
      if (steps.length === 1) {
        await release.promise;
      }
      steps.push(`end ${event.id}`);
    },
  });
  const device = await signInDevice(app);
  const workspaceId = await workspaceOf(device.userId);
  const { client } = await connected(t, app, device);
  const one = runEvent(workspaceId, device.deviceId);
  const two = runEvent(workspaceId, device.deviceId);
  client.send(one);
  client.send(two);
  await until(() => steps.length === 1, "the first event");
  await settle();
  assert.deepEqual(steps, [`start ${one.id}`], "the second event waits");
  release.resolve();
  await until(() => steps.length === 4, "both events");
  assert.deepEqual(steps, [
    `start ${one.id}`,
    `end ${one.id}`,
    `start ${two.id}`,
    `end ${two.id}`,
  ]);

  fail = true;
  client.send(runEvent(workspaceId, device.deviceId));
  assert.deepEqual(await client.closed, {
    code: CloseCode.internalError,
    reason: "internal_error",
  });
  const failures = logLines
    .map((line) => JSON.parse(line) as Json)
    .filter((entry) => entry.msg === "connection failed");
  assert.equal(failures.length, 1);
  assert.equal(
    (failures[0]?.err as { message?: string } | undefined)?.message,
    "[redacted: may contain query data]",
  );
  for (const line of logLines) {
    assert.equal(line.includes(secret), false, line);
  }
});
