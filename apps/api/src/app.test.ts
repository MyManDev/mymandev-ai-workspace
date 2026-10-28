import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { buildApp, type BuildAppOptions } from "./app.ts";
import { loadConfig } from "./config.ts";
import { serializeError } from "./log.ts";

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
      });
    } else {
      assert.equal(response.statusCode, 500, String(status));
      assert.deepEqual(response.json(), {
        statusCode: 500,
        error: "Internal Server Error",
        message: "Internal Server Error",
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
