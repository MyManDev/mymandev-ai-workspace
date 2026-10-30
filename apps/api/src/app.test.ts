import {
  API_ERROR_STATUS,
  ApiErrorBodySchema,
  RevokeDeviceRequestSchema,
} from "@mymandev/protocol";
import assert from "node:assert/strict";
import { STATUS_CODES } from "node:http";
import { test, type TestContext } from "node:test";
import { buildApp, type BuildAppOptions } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ApiError } from "./errors.ts";
import { serializeError } from "./log.ts";
import { zodValidatorCompiler } from "./validation.ts";

const SECRET = "SECRET db password=hunter2";

/** Builds an app that the test closes when it ends. Logging is off unless a stream is given. */
async function appFor(
  t: TestContext,
  overrides: Partial<BuildAppOptions> = {},
) {
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: "test" }),
    version: "1.2.3",
    logger: false,
    shutdownGraceMs: 50,
    ...overrides,
  });
  t.after(() => app.close());
  return app;
}

test("/health returns exactly the status and the version", async (t) => {
  const app = await appFor(t);
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /^application\/json/u);
  assert.deepEqual(response.json(), { status: "ok", version: "1.2.3" });
});

test("an unknown route gets a generic 404 that echoes neither method nor path", async (t) => {
  const app = await appFor(t);
  const response = await app.inject({
    method: "DELETE",
    url: "/admin/secret-path?token=abc",
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    statusCode: 404,
    error: "Not Found",
    message: "Not Found",
    code: "not_found",
  });
  assert.equal(response.body.includes("DELETE"), false);
  assert.equal(response.body.includes("secret-path"), false);
});

test("a thrown error never sends its message, whatever statusCode it carries", async (t) => {
  const app = await appFor(t);
  const statuses = [200, 302, 0, 404, 500];
  for (const status of statuses) {
    app.get(`/throws/${status}`, async () => {
      throw Object.assign(new Error(SECRET), { statusCode: status });
    });
  }
  for (const status of statuses) {
    const response = await app.inject({
      method: "GET",
      url: `/throws/${status}`,
    });
    assert.equal(response.body.includes("hunter2"), false, String(status));
    if (status === 404) {
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), {
        statusCode: 404,
        error: "Not Found",
        message: "Not Found",
        code: "not_found",
      });
    } else {
      assert.equal(response.statusCode, 500, String(status));
      assert.deepEqual(response.json(), {
        statusCode: 500,
        error: "Internal Server Error",
        message: "Internal Server Error",
        code: "internal_error",
      });
    }
  }
});

test("a schema validation failure returns 400 with Fastify's message, without coercion or property removal", async (t) => {
  const app = await appFor(t);
  let handled = false;
  app.post(
    "/numbers",
    {
      schema: {
        body: {
          type: "object",
          properties: { n: { type: "integer" } },
          required: ["n"],
          additionalProperties: false,
        },
      },
    },
    async () => {
      handled = true;
      return { accepted: true };
    },
  );
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ n: "1" }, "body/n must be integer"],
    // Fastify's default strips the unknown property and runs the handler.
    [{ n: 1, extra: true }, "body must NOT have additional properties"],
  ];
  for (const [payload, message] of cases) {
    const response = await app.inject({
      method: "POST",
      url: "/numbers",
      payload,
    });
    assert.equal(response.statusCode, 400, message);
    assert.deepEqual(response.json(), {
      statusCode: 400,
      error: "Bad Request",
      message,
      code: "bad_request",
    });
  }
  assert.equal(handled, false);
});

test("a body over the limit returns 413, and requests have a timeout", async (t) => {
  const app = await appFor(t, {
    config: loadConfig({ API_BODY_LIMIT_BYTES: "1024" }),
  });
  assert.equal(app.initialConfig.bodyLimit, 1024);
  // Fastify's types omit requestTimeout from initialConfig, but the value is there.
  assert.equal(Reflect.get(app.initialConfig, "requestTimeout"), 30_000);
  app.post("/echo", async () => ({ accepted: true }));
  const response = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ text: "x".repeat(2048) }),
  });
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().message, "Request body is too large");
  assert.equal(response.json().code, "bad_request");
});

test("a JSON body with __proto__ returns 400", async (t) => {
  const app = await appFor(t);
  let handled = false;
  app.post("/echo", async () => {
    handled = true;
    return { accepted: true };
  });
  const response = await app.inject({
    method: "POST",
    url: "/echo",
    headers: { "content-type": "application/json" },
    payload: '{"n":1,"__proto__":{"polluted":true}}',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(handled, false);
  assert.equal(Object.prototype.hasOwnProperty.call({}, "polluted"), false);
});

test("logs never contain query strings, and errors with query data are redacted", async (t) => {
  const token = "SECRET_URL_TOKEN_1";
  const lines: string[] = [];
  const app = await appFor(t, {
    logger: { stream: { write: (line) => void lines.push(line) } },
  });
  app.get("/fails", async () => {
    // Like a database error: the message and the params carry query values.
    throw Object.assign(new Error(`insert failed with params ${token}`), {
      query: "insert into messages ...",
      params: [token],
    });
  });
  // injectWS never settles unless the app is ready.
  await app.ready();
  for (const url of ["/health", "/nope", "/fails"]) {
    await app.inject({
      method: "GET",
      url: `${url}?token=${token}`,
      // trustProxy is off: a client-chosen forwarding header is not logged as the address.
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
  }
  // Only /ws upgrades. Otherwise a handshake on /health would skip the Origin
  // check, and the WebSocket plugin would log its full URL.
  for (const headers of [{}, { origin: "https://evil.example" }]) {
    await assert.rejects(
      app.injectWS(`/health?token=${token}`, { headers }),
      /404/u,
    );
  }
  // HEAD /ws is not a route, so the WebSocket handler never runs for it.
  const head = await app.inject({ method: "HEAD", url: `/ws?token=${token}` });
  assert.equal(head.statusCode, 404);
  const ws = await app.injectWS(`/ws?token=${token}`);
  ws.terminate();

  const entries = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  const requests = entries
    .filter((entry) => entry.msg === "incoming request")
    .map(
      (entry) =>
        entry.req as { url?: string; remoteAddress?: string } | undefined,
    );
  assert.deepEqual(
    requests.map((request) => request?.url),
    ["/health", "/nope", "/fails", "/health", "/health", "/ws", "/ws"],
  );
  for (const request of requests.slice(0, 3)) {
    assert.equal(request?.remoteAddress, "127.0.0.1");
  }
  // Only the failing route logs at error level, through the redacting serializer.
  const failures = entries.filter((entry) => Number(entry.level) >= 50);
  assert.deepEqual(
    failures.map((entry) => entry.msg),
    ["request failed"],
  );
  assert.deepEqual(
    failures.map((entry) => (entry.err as { message?: string }).message),
    ["[redacted: may contain query data]"],
  );
  for (const line of lines) {
    assert.equal(line.includes(token), false, line);
  }

  const leaked = "SECRET_TOKEN_MATERIAL";
  const databaseError = Object.assign(
    new Error(`insert failed with params ${leaked}`),
    { query: "insert into messages ...", params: [leaked] },
  );
  const wrapped = new Error(`query failed: ${leaked}`, {
    cause: databaseError,
  });
  for (const error of [databaseError, wrapped]) {
    const serialized = serializeError(error);
    assert.equal(serialized.message, "[redacted: may contain query data]");
    assert.equal(serialized.stack, "");
    assert.equal(JSON.stringify(serialized).includes(leaked), false);
  }
  const plain = serializeError(
    Object.assign(new Error("plain"), { code: "E_PLAIN", statusCode: 500 }),
  );
  assert.equal(plain.message, "plain");
  assert.equal(plain.code, "E_PLAIN");
  assert.equal(plain.statusCode, 500);
});

test("an ApiError answers with its code's fixed status, the status text, and the code", async (t) => {
  const app = await appFor(t);
  const codes = [
    "device_too_new",
    "invitation_invalid",
    "conflict",
    "sign_in_unavailable",
  ] as const;
  for (const code of codes) {
    app.get(`/api-error/${code}`, async () => {
      throw new ApiError(code);
    });
  }
  for (const code of codes) {
    const response = await app.inject({
      method: "GET",
      url: `/api-error/${code}`,
    });
    const status = API_ERROR_STATUS[code];
    assert.equal(response.statusCode, status, code);
    const body = response.json();
    assert.deepEqual(body, {
      statusCode: status,
      error: STATUS_CODES[status],
      message: STATUS_CODES[status],
      code,
    });
    assert.equal(ApiErrorBodySchema.safeParse(body).success, true, code);
  }
});

test("a rate-limited route answers 429 with rate_limited and Retry-After", async (t) => {
  const app = await appFor(t);
  app.get(
    "/limited",
    { config: { rateLimit: { max: 1, timeWindow: 60_000 } } },
    async () => ({ ok: true }),
  );
  app.get("/unlimited", async () => ({ ok: true }));
  assert.equal(
    (await app.inject({ method: "GET", url: "/limited" })).statusCode,
    200,
  );
  const limited = await app.inject({ method: "GET", url: "/limited" });
  assert.equal(limited.statusCode, 429);
  assert.deepEqual(limited.json(), {
    statusCode: 429,
    error: "Too Many Requests",
    message: "Too Many Requests",
    code: "rate_limited",
  });
  assert.match(String(limited.headers["retry-after"]), /^[0-9]+$/u);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(
      (await app.inject({ method: "GET", url: "/unlimited" })).statusCode,
      200,
    );
  }
});

test("zod schemas validate in their scope: unknown keys are stripped, and a failure names the path without the value", async (t) => {
  const app = await appFor(t);
  const received: unknown[] = [];
  await app.register(async (scope) => {
    scope.setValidatorCompiler(zodValidatorCompiler);
    scope.post(
      "/devices/revoke-test",
      { schema: { body: RevokeDeviceRequestSchema } },
      async (request) => {
        received.push(request.body);
        return { ok: true };
      },
    );
  });
  const ok = await app.inject({
    method: "POST",
    url: "/devices/revoke-test",
    payload: { reason: "lost", role: "owner" },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(received, [{ reason: "lost" }]);

  const secret = "SECRET-reason-value";
  const bad = await app.inject({
    method: "POST",
    url: "/devices/revoke-test",
    payload: { reason: secret },
  });
  assert.equal(bad.statusCode, 400);
  const body = bad.json();
  assert.equal(body.code, "bad_request");
  assert.match(body.message, /^body\/reason: /u);
  assert.equal(bad.body.includes(secret), false);
  assert.equal(received.length, 1);

  const missing = await app.inject({
    method: "POST",
    url: "/devices/revoke-test",
    payload: {},
  });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().message, /^body\/reason: /u);
});
