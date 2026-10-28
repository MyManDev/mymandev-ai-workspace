import { UUIDV7_PATTERN, type UnverifiedEvent } from "@mymandev/protocol";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import type { WebSocket } from "ws";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { CloseCode, type ConnectionContext } from "./gateway.ts";

const EVENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000001";
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000003";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000005";
const OTHER_AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000006";
const RUN_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007";
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009";

const ALLOWED_ORIGIN = "https://app.example";

type Json = Record<string, unknown>;

/** A run transition that the agent's host device reports. */
function validEvent(): Json {
  return {
    protocolVersion: 0,
    id: EVENT_ID,
    type: "agent.run.state_changed",
    occurredAt: "2026-10-27T12:34:56.789Z",
    workspaceId: WORKSPACE_ID,
    actor: { kind: "agent", agentId: AGENT_ID },
    deviceId: DEVICE_ID,
    payload: {
      runId: RUN_ID,
      agentId: AGENT_ID,
      previousState: "queued",
      state: "running",
    },
  };
}

function withPayload(fields: Json): Json {
  const event = validEvent();
  return { ...event, payload: { ...(event.payload as Json), ...fields } };
}

type Received = { event: UnverifiedEvent; context: ConnectionContext };

/** Builds an app that records every event its gateway accepts. */
async function gatewayApp(t: TestContext) {
  const received: Received[] = [];
  const firstEvent = Promise.withResolvers<void>();
  const app = await buildApp({
    config: loadConfig({ API_ALLOWED_ORIGINS: ALLOWED_ORIGIN }),
    version: "0.0.0",
    logger: false,
    // injectWS clients never finish the closing handshake; keep close fast.
    shutdownGraceMs: 50,
    onEvent: (event, context) => {
      received.push({ event, context });
      firstEvent.resolve();
    },
  });
  t.after(() => app.close());
  // injectWS never settles unless the app is ready.
  await app.ready();
  return { app, received, firstEvent: firstEvent.promise };
}

/** Sends the frames in the same tick and returns the close code and reason. */
async function closeAfter(
  app: FastifyInstance,
  ...frames: Array<string | Buffer>
): Promise<{ code: number; reason: string }> {
  const ws: WebSocket = await app.injectWS("/ws");
  try {
    const closed = once(ws, "close");
    for (const frame of frames) {
      ws.send(frame);
    }
    const [code, reason] = (await closed) as [number, Buffer];
    return { code, reason: reason.toString() };
  } finally {
    ws.terminate();
  }
}

test("a valid event reaches onEvent decoded and stripped, with identity null", async (t) => {
  const { app, received, firstEvent } = await gatewayApp(t);
  const ws = await app.injectWS("/ws");
  t.after(() => ws.terminate());
  const event = validEvent();
  ws.send(
    JSON.stringify({
      ...event,
      extra: "dropped",
      payload: { ...(event.payload as Json), extra: "dropped" },
    }),
  );
  await firstEvent;
  assert.equal(received.length, 1);
  const [first] = received;
  assert.ok(first);
  assert.deepEqual(first.event, event);
  assert.equal(first.context.identity, null);
  assert.match(first.context.connectionId, UUIDV7_PATTERN);
  assert.ok(Object.isFrozen(first.context));
});

test("a binary frame closes with 1003", async (t) => {
  const { app, received } = await gatewayApp(t);
  const result = await closeAfter(
    app,
    Buffer.from(JSON.stringify(validEvent())),
  );
  assert.deepEqual(result, {
    code: CloseCode.unsupportedData,
    reason: "binary_not_supported",
  });
  assert.equal(received.length, 0);
});

test("invalid JSON closes with 1007", async (t) => {
  const { app, received } = await gatewayApp(t);
  const result = await closeAfter(app, "{not json");
  assert.deepEqual(result, {
    code: CloseCode.invalidFramePayload,
    reason: "invalid_json",
  });
  assert.equal(received.length, 0);
});

test("each decode failure closes with 1008 and its code as the reason", async (t) => {
  const { app, received } = await gatewayApp(t);
  const cases: Array<[string, unknown]> = [
    ["malformed", { protocolVersion: 0 }],
    ["malformed", "not an object"],
    ["unsupported_version", { ...validEvent(), protocolVersion: 1 }],
    ["unknown_type", { ...validEvent(), type: "agent.run.deleted" }],
    ["invalid_payload", withPayload({ previousState: "completed" })],
    [
      "invalid_actor",
      { ...validEvent(), actor: { kind: "user", userId: USER_ID } },
    ],
    [
      "invalid_actor",
      { ...validEvent(), actor: { kind: "agent", agentId: OTHER_AGENT_ID } },
    ],
  ];
  for (const [code, input] of cases) {
    const result = await closeAfter(app, JSON.stringify(input));
    assert.deepEqual(
      result,
      { code: CloseCode.policyViolation, reason: code },
      JSON.stringify(input),
    );
  }
  assert.equal(received.length, 0);
});

test("events that only the server may originate close with 1008 not_allowed_from_device", async (t) => {
  const { app, received } = await gatewayApp(t);
  const cases: Json[] = [
    { ...validEvent(), actor: { kind: "system" } },
    { ...validEvent(), deviceId: null },
    withPayload({ previousState: null, state: "queued" }),
  ];
  for (const input of cases) {
    const result = await closeAfter(app, JSON.stringify(input));
    assert.deepEqual(
      result,
      { code: CloseCode.policyViolation, reason: "not_allowed_from_device" },
      JSON.stringify(input),
    );
  }
  assert.equal(received.length, 0);
});

test("valid events sent in the same tick after an invalid frame never reach onEvent", async (t) => {
  const { app, received } = await gatewayApp(t);
  const valid = JSON.stringify(validEvent());
  const result = await closeAfter(
    app,
    "{not json",
    ...Array.from({ length: 50 }, () => valid),
  );
  assert.deepEqual(result, {
    code: CloseCode.invalidFramePayload,
    reason: "invalid_json",
  });
  assert.equal(received.length, 0);
});

test("a 70 KB frame closes with 1009", async (t) => {
  const { app, received } = await gatewayApp(t);
  const result = await closeAfter(app, "x".repeat(70 * 1024));
  assert.equal(result.code, CloseCode.messageTooBig);
  assert.equal(received.length, 0);
});

test("a foreign browser origin gets 403; a listed origin and no origin connect until shutdown closes them with 1001", async (t) => {
  const { app } = await gatewayApp(t);
  await assert.rejects(
    app.injectWS("/ws", { headers: { origin: "https://evil.example" } }),
    /403/u,
  );
  const clients: WebSocket[] = [];
  for (const headers of [{ origin: ALLOWED_ORIGIN }, {}]) {
    const ws = await app.injectWS("/ws", { headers });
    t.after(() => ws.terminate());
    assert.equal(ws.readyState, ws.OPEN);
    clients.push(ws);
  }
  const closed = clients.map((ws) => once(ws, "close"));
  await app.close();
  for (const [code, reason] of (await Promise.all(closed)) as Array<
    [number, Buffer]
  >) {
    assert.equal(code, CloseCode.goingAway);
    assert.equal(reason.toString(), "server_shutdown");
  }
});
