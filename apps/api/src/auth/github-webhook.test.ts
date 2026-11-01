import { auditEvents, devices, users } from "@mymandev/database";
import {
  ChallengeResponseSchema,
  decodeServerMessage,
  type DeviceId,
  newId,
  type UserId,
} from "@mymandev/protocol";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { buildApp } from "../app.ts";
import { loadConfig } from "../config.ts";
import { ConnectionRegistry } from "../gateway.ts";
import { AccessTokens } from "./tokens.ts";
import {
  deviceApp,
  type DeviceAppOptions,
  fakeClock,
  ORIGIN,
  signInAgain,
  type SignedInDevice,
  signInDevice,
  signInput,
  useTestDatabase,
} from "./device-test-support.ts";

const database = useTestDatabase();

// Obviously fake secrets in the accepted format.
const WEBHOOK_SECRET = "fake-webhook-secret-0123456789abcdef";
const PREVIOUS_SECRET = "fake-previous-webhook-secret-0123456789";
const OTHER_SECRET = "fake-other-webhook-secret-0123456789ab";

const WEBHOOK_PATH = "/auth/github/webhook";

const UNAUTHORIZED = {
  statusCode: 401,
  error: "Unauthorized",
  message: "Unauthorized",
  code: "unauthorized",
};

/** An app with sign-in, the database, and the webhook secret. */
function webhookApp(
  t: TestContext,
  options: Omit<DeviceAppOptions, "database">,
) {
  return deviceApp(t, {
    ...options,
    database: database(),
    env: { API_GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, ...options.env },
  });
}

/** `X-Hub-Signature-256` as GitHub computes it. */
function sign(body: string, secret: string = WEBHOOK_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** GitHub's `github_app_authorization` body for a revocation by the sender. */
function revokedBody(sender: unknown): string {
  return JSON.stringify({ action: "revoked", sender });
}

function senderOf(githubId: number) {
  return { login: `user-${githubId}`, id: githubId, type: "User" };
}

type Delivery = Readonly<{
  body: string;
  /** `X-GitHub-Event`; null leaves it out. */
  event?: string | null;
  /** `X-GitHub-Delivery`; null leaves it out. */
  deliveryId?: string | null;
  /** `X-Hub-Signature-256`; by default the body signed with the current secret, null leaves it out. */
  signature?: string | null;
  contentType?: string;
}>;

/** Posts a delivery the way GitHub does. */
function deliver(app: FastifyInstance, delivery: Delivery) {
  const signature =
    delivery.signature === undefined ? sign(delivery.body) : delivery.signature;
  const event =
    delivery.event === undefined ? "github_app_authorization" : delivery.event;
  const deliveryId =
    delivery.deliveryId === undefined ? randomUUID() : delivery.deliveryId;
  return app.inject({
    method: "POST",
    url: WEBHOOK_PATH,
    headers: {
      "content-type": delivery.contentType ?? "application/json",
      "user-agent": "GitHub-Hookshot/test",
      ...(signature === null ? {} : { "x-hub-signature-256": signature }),
      ...(event === null ? {} : { "x-github-event": event }),
      ...(deliveryId === null ? {} : { "x-github-delivery": deliveryId }),
    },
    payload: delivery.body,
  });
}

async function signInRequiredAt(userId: string): Promise<Date | null> {
  const [row] = await database()
    .select({ signInRequiredAt: users.signInRequiredAt })
    .from(users)
    .where(eq(users.id, userId as UserId));
  assert.ok(row);
  return row.signInRequiredAt;
}

function auditsOf(deliveryId: string) {
  return database()
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.githubDeliveryId, deliveryId));
}

/** Asks for an access token with the device's key. */
async function requestToken(app: FastifyInstance, device: SignedInDevice) {
  const { challengeId, nonce } = ChallengeResponseSchema.parse(
    (await app.inject({ method: "POST", url: "/auth/challenge" })).json(),
  );
  return app.inject({
    method: "POST",
    url: "/auth/access-token",
    payload: {
      deviceId: device.deviceId,
      challengeId,
      signature: signInput(device.key, {
        purpose: "http",
        audience: ORIGIN,
        nonce,
        deviceId: device.deviceId,
        challengeId,
      }),
    },
  });
}

function codeOf(response: { json(): unknown }): string {
  return (response.json() as { code: string }).code;
}

type Closed = Readonly<{ code: number; reason: string }>;

/**
 * Opens /ws and authenticates the device as the desktop does. Resolves the
 * returned promise when the server closes the socket.
 */
async function openSocket(
  t: TestContext,
  app: FastifyInstance,
  device: SignedInDevice,
): Promise<Readonly<{ closed: Promise<Closed> }>> {
  // injectWS never settles unless the app is ready.
  await app.ready();
  const frames: unknown[] = [];
  const waiting: Array<() => void> = [];
  const closed = Promise.withResolvers<Closed>();
  const ws = await app.injectWS(
    "/ws",
    {},
    {
      onInit: (socket) => {
        socket.on("message", (data) => {
          frames.push(JSON.parse(String(data)));
          waiting.shift()?.();
        });
        socket.on("close", (code, reason) => {
          closed.resolve({ code, reason: reason.toString() });
        });
      },
    },
  );
  t.after(() => ws.terminate());
  const next = async () => {
    if (frames.length === 0) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    return decodeServerMessage(frames.shift());
  };
  const challenge = await next();
  assert.ok(
    challenge.ok &&
      challenge.kind === "frame" &&
      challenge.frame.type === "auth.challenge",
  );
  ws.send(
    JSON.stringify({
      protocolVersion: 0,
      type: "auth.response",
      deviceId: device.deviceId,
      signature: signInput(device.key, {
        purpose: "ws",
        audience: ORIGIN,
        nonce: challenge.frame.nonce,
        deviceId: device.deviceId,
        connectionId: challenge.frame.connectionId,
      }),
    }),
  );
  const ok = await next();
  assert.ok(ok.ok && ok.kind === "frame" && ok.frame.type === "auth.ok");
  return { closed: closed.promise };
}

test("a missing or wrong signature answers 401 with unauthorized and changes nothing", async (t) => {
  const app = await webhookApp(t, { githubId: 4001 });
  const device = await signInDevice(app);
  const body = revokedBody(senderOf(4001));
  const deliveryId = randomUUID();
  const correct = sign(body);

  for (const [signature, label] of [
    [null, "no signature"],
    ["", "an empty signature"],
    [`sha256=${"0".repeat(64)}`, "a wrong signature"],
    [sign(body, OTHER_SECRET), "another secret"],
    [sign(revokedBody(senderOf(4002))), "the signature of another body"],
    [correct.toUpperCase(), "uppercase hexadecimal"],
    [correct.slice(0, -2), "a short signature"],
    [`${correct}00`, "a long signature"],
    [correct.replace("sha256=", "sha1="), "another algorithm"],
  ] as const) {
    const response = await deliver(app, { body, deliveryId, signature });
    assert.equal(response.statusCode, 401, label);
    assert.deepEqual(response.json(), UNAUTHORIZED, label);
  }
  // A malformed body is not even read without a valid signature.
  const malformed = await deliver(app, {
    body: "not json",
    signature: sign("other"),
  });
  assert.equal(malformed.statusCode, 401);
  assert.equal(await signInRequiredAt(device.userId), null);
  assert.deepEqual(await auditsOf(deliveryId), []);

  const accepted = await deliver(app, { body, deliveryId });
  assert.equal(accepted.statusCode, 204);
  assert.notEqual(await signInRequiredAt(device.userId), null);
});

test("the previous secret works only while it is configured", async (t) => {
  const body = revokedBody(senderOf(4099));
  const current = await webhookApp(t, { githubId: 4003 });
  const refused = randomUUID();
  const response = await deliver(current, {
    body,
    deliveryId: refused,
    signature: sign(body, PREVIOUS_SECRET),
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(await auditsOf(refused), []);

  const rotating = await webhookApp(t, {
    githubId: 4003,
    env: { API_GITHUB_WEBHOOK_SECRET_PREVIOUS: PREVIOUS_SECRET },
  });
  for (const secret of [PREVIOUS_SECRET, WEBHOOK_SECRET]) {
    const deliveryId = randomUUID();
    const accepted = await deliver(rotating, {
      body,
      deliveryId,
      signature: sign(body, secret),
    });
    assert.equal(accepted.statusCode, 204);
    assert.equal((await auditsOf(deliveryId)).length, 1);
  }
  const other = await deliver(rotating, {
    body,
    signature: sign(body, OTHER_SECRET),
  });
  assert.equal(other.statusCode, 401);
});

test("the signature covers the raw bytes: a body that JSON.stringify would write differently verifies, and the same JSON written again does not", async (t) => {
  const app = await webhookApp(t, { githubId: 4012 });
  const device = await signInDevice(app);
  // Spaces, line breaks, escaped slashes, "&", and text outside ASCII.
  const body = `{ "action" : "revoked",\n  "sender" : { "login" : "user-4012", "id" : 4012, "html_url" : "https:\\/\\/github.com\\/user-4012", "name" : "R&D \u0130\u011f\u00fc\u015f" } }\n`;
  const rewritten = JSON.stringify(JSON.parse(body));
  assert.notEqual(rewritten, body);
  const signature = sign(body);

  const refused = await deliver(app, { body: rewritten, signature });
  assert.equal(refused.statusCode, 401);
  assert.equal(await signInRequiredAt(device.userId), null);

  const accepted = await deliver(app, { body, signature });
  assert.equal(accepted.statusCode, 204);
  assert.notEqual(await signInRequiredAt(device.userId), null);
});

test("a revocation sets sign_in_required_at, closes the person's socket with sign_in_required, and requires a new sign-in of every device", async (t) => {
  const clock = fakeClock();
  const connections = new ConnectionRegistry();
  const app = await webhookApp(t, {
    githubId: 4004,
    now: clock.now,
    connections,
  });
  const laptop = await signInDevice(app);
  const desktop = await signInDevice(app);
  assert.equal(laptop.userId, desktop.userId);
  const tokenResponse = await requestToken(app, laptop);
  assert.equal(tokenResponse.statusCode, 200);
  const { accessToken } = tokenResponse.json() as { accessToken: string };
  const socket = await openSocket(t, app, laptop);
  clock.advance(60_000);

  const deliveryId = randomUUID();
  const response = await deliver(app, {
    body: revokedBody(senderOf(4004)),
    deliveryId,
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");

  assert.deepEqual(await socket.closed, {
    code: 4003,
    reason: "sign_in_required",
  });
  assert.equal(connections.liveCount, 0);
  assert.deepEqual(
    (await signInRequiredAt(laptop.userId))?.getTime(),
    clock.now(),
  );
  for (const device of [laptop, desktop]) {
    const refused = await requestToken(app, device);
    assert.equal(refused.statusCode, 401);
    assert.equal(codeOf(refused), "sign_in_required");
  }
  const listed = await app.inject({
    method: "GET",
    url: "/devices",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(listed.statusCode, 401);
  assert.equal(codeOf(listed), "unauthorized");

  // The devices stay registered.
  const rows = await database()
    .select({ revokedAt: devices.revokedAt, signedOutAt: devices.signedOutAt })
    .from(devices)
    .where(eq(devices.userId, laptop.userId as UserId));
  assert.deepEqual(rows, [
    { revokedAt: null, signedOutAt: null },
    { revokedAt: null, signedOutAt: null },
  ]);
  const audits = await auditsOf(deliveryId);
  assert.deepEqual(
    audits.map((row) => [
      row.action,
      row.actorUserId,
      row.actorDeviceId,
      row.subjectId,
    ]),
    [["github.authorization_revoked", null, null, laptop.userId]],
  );

  // A new sign-in of a device makes it work again; the other device still waits.
  clock.advance(60_000);
  const signedIn = await signInAgain(app, laptop);
  assert.equal((await requestToken(app, signedIn)).statusCode, 200);
  assert.equal(codeOf(await requestToken(app, desktop)), "sign_in_required");
});

test("a second delivery with the same ID changes nothing and writes no second audit record", async (t) => {
  const clock = fakeClock();
  const connections = new ConnectionRegistry();
  const app = await webhookApp(t, {
    githubId: 4005,
    now: clock.now,
    connections,
  });
  const device = await signInDevice(app);
  clock.advance(60_000);
  const deliveryId = randomUUID();
  const body = revokedBody(senderOf(4005));
  assert.equal((await deliver(app, { body, deliveryId })).statusCode, 204);
  const first = await signInRequiredAt(device.userId);

  clock.advance(60_000);
  const signedIn = await signInAgain(app, device);
  await openSocket(t, app, signedIn);
  clock.advance(60_000);
  assert.equal((await deliver(app, { body, deliveryId })).statusCode, 204);

  assert.deepEqual(await signInRequiredAt(device.userId), first);
  assert.notEqual(connections.connectionOf(device.deviceId), null);
  assert.equal((await requestToken(app, signedIn)).statusCode, 200);
  assert.equal((await auditsOf(deliveryId)).length, 1);
});

test("a revocation drops the cached access tokens of the account's devices and no others", async (t) => {
  // The app's own store is the one whose issue() mints the tokens.
  const issue = t.mock.method(AccessTokens.prototype, "issue");
  const clock = fakeClock();
  const app = await webhookApp(t, { githubId: 4013, now: clock.now });
  const laptop = await signInDevice(app);
  const desktop = await signInDevice(app);
  const minted: string[] = [];
  for (const device of [laptop, desktop]) {
    const response = await requestToken(app, device);
    assert.equal(response.statusCode, 200);
    minted.push((response.json() as { accessToken: string }).accessToken);
  }
  const store = issue.mock.calls[0]?.this;
  assert.ok(store instanceof AccessTokens);
  assert.ok(issue.mock.calls.every((call) => call.this === store));
  const stranger = store.issue({
    userId: newId<UserId>(),
    deviceId: newId<DeviceId>(),
    signedInAt: clock.now(),
  });
  assert.ok(stranger);
  for (const token of minted) {
    assert.notEqual(store.find(token), null);
  }

  clock.advance(60_000);
  const response = await deliver(app, { body: revokedBody(senderOf(4013)) });
  assert.equal(response.statusCode, 204);
  for (const token of minted) {
    assert.equal(store.find(token), null);
  }
  assert.notEqual(store.find(stranger.accessToken), null);
});

test("with the webhook secret and the database but without GitHub sign-in, a revocation is still recorded", async (t) => {
  const signInApp = await webhookApp(t, { githubId: 4014 });
  const device = await signInDevice(signInApp);
  const app = await buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      API_GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    }),
    version: "1.2.3",
    logger: false,
    database: database(),
  });
  t.after(() => app.close());
  // The device routes, and with them the access tokens, do not exist here.
  const challenge = await app.inject({
    method: "POST",
    url: "/auth/challenge",
  });
  assert.equal(challenge.statusCode, 404);

  const deliveryId = randomUUID();
  const response = await deliver(app, {
    body: revokedBody(senderOf(4014)),
    deliveryId,
  });
  assert.equal(response.statusCode, 204);
  assert.notEqual(await signInRequiredAt(device.userId), null);
  assert.equal((await auditsOf(deliveryId)).length, 1);
});

test("a sender without an account gets 204 and one audit record without a person, also after a redelivery", async (t) => {
  const app = await webhookApp(t, { githubId: 4006 });
  const deliveryId = randomUUID();
  const body = revokedBody(senderOf(4098));
  for (let round = 0; round < 2; round += 1) {
    const response = await deliver(app, { body, deliveryId });
    assert.equal(response.statusCode, 204);
    const audits = await auditsOf(deliveryId);
    assert.deepEqual(
      audits.map((row) => [
        row.action,
        row.actorUserId,
        row.actorDeviceId,
        row.subjectId,
      ]),
      [["github.authorization_revoked", null, null, null]],
    );
  }
});

test("installation, installation_repositories, ping, other events, and other actions are acknowledged without a change", async (t) => {
  const app = await webhookApp(t, { githubId: 4007 });
  const device = await signInDevice(app);
  const sender = senderOf(4007);
  const installation = { id: 1, account: sender };
  const deliveries: Delivery[] = [
    {
      event: "installation",
      body: JSON.stringify({ action: "created", installation, sender }),
    },
    {
      event: "installation",
      body: JSON.stringify({ action: "revoked", installation, sender }),
    },
    {
      event: "installation_repositories",
      body: JSON.stringify({ action: "added", installation, sender }),
    },
    {
      event: "ping",
      body: JSON.stringify({ zen: "Design for failure.", hook_id: 1, sender }),
    },
    { event: "push", body: revokedBody(sender) },
    { event: null, body: revokedBody(sender) },
    {
      event: "github_app_authorization",
      body: JSON.stringify({ action: "granted", sender }),
    },
  ];
  for (const delivery of deliveries) {
    const deliveryId = randomUUID();
    const response = await deliver(app, { ...delivery, deliveryId });
    assert.equal(response.statusCode, 204, delivery.body);
    assert.deepEqual(await auditsOf(deliveryId), [], delivery.body);
  }
  assert.equal(await signInRequiredAt(device.userId), null);
  assert.equal((await requestToken(app, device)).statusCode, 200);
});

test("a signed body that is not a JSON object, or a revocation without a valid delivery ID or sender ID, answers 400 with bad_request", async (t) => {
  const app = await webhookApp(t, { githubId: 4008 });
  const device = await signInDevice(app);
  const body = revokedBody(senderOf(4008));
  const cases: [Delivery, string][] = [
    [{ body: "not json" }, "not JSON"],
    [{ body: "" }, "an empty body"],
    [{ body: "[]" }, "an array"],
    [{ body: "null" }, "null"],
    [{ body, deliveryId: null }, "no delivery ID"],
    [{ body, deliveryId: "has space" }, "a space in the delivery ID"],
    [{ body, deliveryId: "under_score" }, "an underscore in the delivery ID"],
    [{ body, deliveryId: "a".repeat(65) }, "a delivery ID over 64 characters"],
    [{ body: JSON.stringify({ action: "revoked" }) }, "no sender"],
    [{ body: revokedBody({ login: "user-4008" }) }, "no sender ID"],
    [{ body: revokedBody({ id: "4008" }) }, "a sender ID as text"],
    [{ body: revokedBody({ id: 0 }) }, "a sender ID of 0"],
    [{ body: revokedBody({ id: -4008 }) }, "a negative sender ID"],
    [{ body: revokedBody({ id: 4008.5 }) }, "a fractional sender ID"],
    [{ body: revokedBody({ id: 2 ** 53 }) }, "an unsafe integer"],
  ];
  for (const [delivery, label] of cases) {
    const response = await deliver(app, delivery);
    assert.equal(response.statusCode, 400, label);
    assert.equal(codeOf(response), "bad_request", label);
  }
  assert.equal(await signInRequiredAt(device.userId), null);
});

test("the webhook accepts only application/json, up to 1 MiB, above the API's general body limit", async (t) => {
  const app = await webhookApp(t, { githubId: 4009 });
  const body = revokedBody(senderOf(4097));
  for (const contentType of [
    "application/x-www-form-urlencoded",
    "text/plain",
  ]) {
    const response = await deliver(app, { body, contentType });
    assert.equal(response.statusCode, 415, contentType);
    assert.equal(codeOf(response), "bad_request", contentType);
  }
  const withCharset = await deliver(app, {
    body,
    contentType: "application/json; charset=utf-8",
  });
  assert.equal(withCharset.statusCode, 204);

  // The general limit is 64 KiB by default.
  const padded = (size: number) =>
    JSON.stringify({ zen: "x".repeat(size), hook_id: 1 });
  const large = await deliver(app, {
    event: "ping",
    body: padded(512 * 1024),
  });
  assert.equal(large.statusCode, 204);
  const tooLarge = await deliver(app, {
    event: "ping",
    body: padded(1024 * 1024),
  });
  assert.equal(tooLarge.statusCode, 413);
});

test("without the webhook secret or without the database, the webhook answers the generic 404", async (t) => {
  const notFound = {
    statusCode: 404,
    error: "Not Found",
    message: "Not Found",
    code: "not_found",
  };
  const body = revokedBody(senderOf(4010));
  const withoutSecret = await deviceApp(t, {
    database: database(),
    githubId: 4010,
  });
  const device = await signInDevice(withoutSecret);
  const response = await deliver(withoutSecret, { body });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), notFound);
  assert.equal(await signInRequiredAt(device.userId), null);

  const withoutDatabase = await buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      API_GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    }),
    version: "1.2.3",
    logger: false,
  });
  t.after(() => withoutDatabase.close());
  const missing = await deliver(withoutDatabase, { body });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), notFound);
});

test("the logs contain the event type and the outcome, but no body, signature, delivery ID, sender ID, or user ID", async (t) => {
  // Long IDs, so that neither turns up by chance in a time or a duration.
  const githubId = 73_019_446_285;
  const strangerId = 81_726_354_091;
  const logLines: string[] = [];
  const app = await webhookApp(t, { githubId, logLines });
  const device = await signInDevice(app);
  const signedIn = logLines.length;

  const sender = { ...senderOf(githubId), login: "log-check-login" };
  const body = revokedBody(sender);
  const deliveryId = randomUUID();
  const signature = sign(body);
  const forbidden: string[] = [
    body,
    sender.login,
    signature,
    signature.slice("sha256=".length),
    deliveryId,
    String(githubId),
    device.userId,
    WEBHOOK_SECRET,
  ];
  assert.equal((await deliver(app, { body, deliveryId })).statusCode, 204);
  assert.equal((await deliver(app, { body, deliveryId })).statusCode, 204);

  const strangerBody = revokedBody({
    ...senderOf(strangerId),
    login: "log-check-stranger",
  });
  const strangerDelivery = randomUUID();
  forbidden.push(
    strangerBody,
    "log-check-stranger",
    String(strangerId),
    strangerDelivery,
  );
  assert.equal(
    (await deliver(app, { body: strangerBody, deliveryId: strangerDelivery }))
      .statusCode,
    204,
  );

  const refusedId = randomUUID();
  const wrong = sign(body, OTHER_SECRET);
  forbidden.push(refusedId, wrong);
  assert.equal(
    (await deliver(app, { body, deliveryId: refusedId, signature: wrong }))
      .statusCode,
    401,
  );
  const malformedId = "malformed-delivery-0001";
  const malformedBody = revokedBody({ id: "log-check-text-id" });
  forbidden.push(malformedId, malformedBody, "log-check-text-id");
  assert.equal(
    (await deliver(app, { body: malformedBody, deliveryId: malformedId }))
      .statusCode,
    400,
  );
  const pingBody = JSON.stringify({ zen: "log-check-zen", hook_id: 1 });
  forbidden.push("log-check-zen");
  assert.equal(
    (await deliver(app, { event: "ping", body: pingBody })).statusCode,
    204,
  );

  const lines = logLines.slice(signedIn);
  const logs = lines.join("\n");
  for (const text of forbidden) {
    assert.equal(logs.includes(text), false, text);
  }
  const outcomes = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry["githubEvent"] !== undefined)
    .map((entry) => [entry["githubEvent"], entry["outcome"]]);
  assert.deepEqual(outcomes, [
    ["github_app_authorization", "revoked"],
    ["github_app_authorization", "already_processed"],
    ["github_app_authorization", "no_account"],
    ["ping", "ignored"],
  ]);
});
