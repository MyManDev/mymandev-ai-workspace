import { randomBytes } from "node:crypto";
import { Server } from "node:http";
import { connect } from "node:net";
import { inspect } from "node:util";
import { LoopbackRedirectUriSchema } from "@mymandev/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ScheduleTimer } from "../runtime.ts";
import {
  SIGN_IN_LISTENER_ERRORS,
  SIGN_IN_LISTENER_MAX_BODY_BYTES,
  SIGN_IN_LISTENER_TIMEOUT_MS,
  type SignInListener,
  type SignInListenerOptions,
  type SignInListenerResult,
  startSignInListener,
} from "./listener.ts";

const random32 = () => randomBytes(32).toString("base64url");
const newSignInCode = () => `mmdc_${random32()}`;

/** A timer that fires only when the test calls `fire`. */
function manualTimers() {
  const pending = new Map<number, { delayMs: number; callback: () => void }>();
  let next = 0;
  const schedule: ScheduleTimer = (callback, delayMs) => {
    const id = next++;
    pending.set(id, { delayMs, callback });
    return () => {
      pending.delete(id);
    };
  };
  return {
    schedule,
    pending: () => [...pending.values()].map((timer) => timer.delayMs),
    fire() {
      const timers = [...pending.values()];
      pending.clear();
      for (const timer of timers) {
        timer.callback();
      }
    },
  };
}

const open: SignInListener[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((listener) => listener.close()));
  vi.restoreAllMocks();
});

/** Starts a listener and returns the HTTP server behind it. */
async function start(options: Partial<SignInListenerOptions> = {}) {
  const listen = vi.spyOn(Server.prototype, "listen");
  const state = random32();
  const timers = manualTimers();
  const errors: string[] = [];
  const listener = await startSignInListener({
    state,
    scheduleTimer: timers.schedule,
    onError: (message) => errors.push(message),
    ...options,
  });
  open.push(listener);
  const server = listen.mock.contexts.at(-1) as Server;
  const listenArguments = listen.mock.calls.at(-1);
  listen.mockRestore();
  let result: SignInListenerResult | undefined;
  void listener.wait().then((value) => {
    result = value;
  });
  return {
    listener,
    server,
    state,
    timers,
    errors,
    listenArguments,
    result: () => result,
  };
}

type Parts = Readonly<{
  method?: string;
  path?: string;
  /** null leaves the header out; an array sends it once per value. */
  host?: string | readonly string[] | null;
  contentType?: string | readonly string[] | null;
  headers?: readonly string[];
  body?: string;
}>;

/** One raw HTTP/1.1 request with a Content-Length. */
function rawRequest(port: number, parts: Parts = {}): string {
  const body = parts.body ?? "";
  const lines = [
    `${parts.method ?? "POST"} ${parts.path ?? "/callback"} HTTP/1.1`,
  ];
  const repeat = (name: string, value: string | readonly string[] | null) => {
    for (const item of value === null ? [] : [value].flat()) {
      lines.push(`${name}: ${item}`);
    }
  };
  repeat("Host", parts.host === undefined ? `127.0.0.1:${port}` : parts.host);
  repeat(
    "Content-Type",
    parts.contentType === undefined
      ? "application/x-www-form-urlencoded"
      : parts.contentType,
  );
  lines.push(...(parts.headers ?? []));
  lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

function form(fields: Readonly<Record<string, string>> | [string, string][]) {
  return new URLSearchParams(
    Array.isArray(fields) ? fields : Object.entries(fields),
  ).toString();
}

type Answer = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

/**
 * Sends raw bytes on a new connection to 127.0.0.1 and reads the answer
 * until the listener closes the connection, which it does after every answer.
 */
function exchange(port: number, request: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const end = text.indexOf("\r\n\r\n");
      const [statusLine = "", ...headerLines] = text
        .slice(0, end)
        .split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const colon = line.indexOf(":");
        headers[line.slice(0, colon).toLowerCase()] = line
          .slice(colon + 1)
          .trim();
      }
      resolve({
        status: Number(statusLine.split(" ")[1]),
        headers,
        body: text.slice(end + 4),
      });
    });
    socket.write(request);
  });
}

/**
 * Opens a connection that sends nothing and waits until the listener has
 * accepted it. `closed` resolves when the listener closes it.
 */
async function idleConnection(
  port: number,
  server: Server,
): Promise<{ closed: Promise<void> }> {
  const accepted = new Promise<void>((resolve) => {
    server.once("connection", () => resolve());
  });
  const socket = connect({ host: "127.0.0.1", port });
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
  socket.on("error", () => undefined);
  await accepted;
  return { closed };
}

/** Whether a TCP connection to the address succeeds. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Lets pending I/O callbacks and promise reactions run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  connection: "close",
};

describe("startSignInListener", () => {
  test("listens on 127.0.0.1 only, with the host passed explicitly and port 0", async () => {
    const { listener, server, listenArguments } = await start();
    expect(listenArguments?.[0]).toEqual({
      host: "127.0.0.1",
      port: 0,
      exclusive: true,
    });
    expect(server.address()).toEqual({
      address: "127.0.0.1",
      family: "IPv4",
      port: listener.port,
    });
    expect(listener.port).toBeGreaterThanOrEqual(1024);
    expect(listener.redirectUri).toBe(
      `http://127.0.0.1:${listener.port}/callback`,
    );
    expect(LoopbackRedirectUriSchema.parse(listener.redirectUri)).toBe(
      listener.redirectUri,
    );
    expect(await reachable("127.0.0.1", listener.port)).toBe(true);
    expect(await reachable("::1", listener.port)).toBe(false);
  }, 20_000);

  test.each(["", "short", `${random32()}A`, "mmdc_x"])(
    "refuses the state %j without naming it",
    async (state) => {
      const error = await startSignInListener({ state }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toEqual(new TypeError("Invalid state"));
    },
  );

  test("starts a timer of 10 minutes", async () => {
    const { timers } = await start();
    expect(SIGN_IN_LISTENER_TIMEOUT_MS).toBe(600_000);
    expect(timers.pending()).toEqual([600_000]);
  });
});

describe("the valid request", () => {
  test("resolves with the code, answers the return page, and closes the listener", async () => {
    const { listener, server, state, timers, result } = await start();
    const idle = await idleConnection(listener.port, server);
    const code = newSignInCode();
    const answer = await exchange(
      listener.port,
      rawRequest(listener.port, { body: form({ code, state }) }),
    );
    expect(answer.status).toBe(200);
    const value = await listener.wait();
    expect(value.kind).toBe("code");
    expect(value.kind === "code" && value.code).toBe(code);
    expect(result()).toBe(value);
    expect(server.listening).toBe(false);
    expect(timers.pending()).toEqual([]);
    await idle.closed;
    await listener.close();
    expect(await listener.wait()).toBe(value);
  });

  test.each(SIGN_IN_LISTENER_ERRORS)(
    "resolves with the error %s from the API",
    async (error) => {
      const { listener, server, state } = await start();
      const answer = await exchange(
        listener.port,
        rawRequest(listener.port, { body: form({ error, state }) }),
      );
      expect(answer.status).toBe(200);
      expect(await listener.wait()).toEqual({ kind: "error", error });
      expect(server.listening).toBe(false);
    },
  );

  test("reports another error code of the protocol as sign_in_failed", async () => {
    const { listener, state } = await start();
    const answer = await exchange(
      listener.port,
      rawRequest(listener.port, { body: form({ error: "new_reason", state }) }),
    );
    expect(answer.status).toBe(200);
    expect(await listener.wait()).toEqual({
      kind: "error",
      error: "sign_in_failed",
    });
  });

  test.each([
    ["Origin: null"],
    ["Origin: https://attacker.example"],
    ["Referer: https://attacker.example/"],
  ])("does not depend on the header %s", async (header) => {
    const { listener, state } = await start();
    const code = newSignInCode();
    const answer = await exchange(
      listener.port,
      rawRequest(listener.port, {
        headers: [header, "Sec-Fetch-Site: cross-site"],
        body: form({ code, state }),
      }),
    );
    expect(answer.status).toBe(200);
    const value = await listener.wait();
    expect(value.kind === "code" && value.code).toBe(code);
  });

  test("accepts the fields in either order and a charset parameter", async () => {
    const { listener, state } = await start();
    const code = newSignInCode();
    const answer = await exchange(
      listener.port,
      rawRequest(listener.port, {
        contentType: "Application/X-WWW-Form-URLEncoded; charset=UTF-8",
        body: form([
          ["state", state],
          ["code", code],
        ]),
      }),
    );
    expect(answer.status).toBe(200);
    const value = await listener.wait();
    expect(value.kind === "code" && value.code).toBe(code);
  });
});

/** Builds one refused request from the port, the expected state, and a valid code. */
type Refused = (port: number, state: string, code: string) => string;

const refused: [string, Refused][] = [
  // Method.
  ...["GET", "HEAD", "PUT", "OPTIONS", "PATCH"].map(
    (method): [string, Refused] => [
      `the method ${method}`,
      (port, state, code) =>
        rawRequest(port, { method, body: form({ code, state }) }),
    ],
  ),
  // Path.
  ...[
    "/",
    "/callback/",
    "/CALLBACK",
    "/callback?x=1",
    "/callback#x",
    "//callback",
    "/auth/callback",
  ].map((path): [string, Refused] => [
    `the path ${path}`,
    (port, state, code) =>
      rawRequest(port, { path, body: form({ code, state }) }),
  ]),
  [
    "an absolute request target",
    (port, state, code) =>
      rawRequest(port, {
        path: `http://127.0.0.1:${port}/callback`,
        body: form({ code, state }),
      }),
  ],
  // Host.
  ...(
    [
      ["localhost:PORT"],
      ["127.0.0.1"],
      ["127.0.0.1:1"],
      ["[::1]:PORT"],
      ["127.1:PORT"],
      ["127.0.0.1:0PORT"],
      ["127.0.0.1:PORT."],
      ["attacker.example"],
      [],
      ["127.0.0.1:PORT", "127.0.0.1:PORT"],
      ["127.0.0.1:PORT", "attacker.example"],
    ] as const
  ).map((hosts): [string, Refused] => [
    `the Host header ${JSON.stringify(hosts)}`,
    (port, state, code) =>
      rawRequest(port, {
        host: hosts.map((host) => host.replace("PORT", String(port))),
        body: form({ code, state }),
      }),
  ]),
  // Content type.
  ...(
    [
      null,
      "text/plain",
      "application/json",
      "multipart/form-data; boundary=x",
      "application/x-www-form-urlencoded-x",
      [
        "application/x-www-form-urlencoded",
        "application/x-www-form-urlencoded",
      ],
    ] as const
  ).map((contentType): [string, Refused] => [
    `the content type ${JSON.stringify(contentType)}`,
    (port, state, code) =>
      rawRequest(port, { contentType, body: form({ code, state }) }),
  ]),
  // State.
  [
    "another state",
    (port, _state, code) =>
      rawRequest(port, { body: form({ code, state: random32() }) }),
  ],
  [
    "no state",
    (port, _state, code) => rawRequest(port, { body: form({ code }) }),
  ],
  [
    "an empty state",
    (port, _state, code) =>
      rawRequest(port, { body: form({ code, state: "" }) }),
  ],
  [
    "a longer state",
    (port, state, code) =>
      rawRequest(port, { body: form({ code, state: `${state}A` }) }),
  ],
  [
    "the state in another case",
    (port, state, code) =>
      rawRequest(port, {
        body: form({
          code,
          state:
            state.toUpperCase() === state
              ? state.toLowerCase()
              : state.toUpperCase(),
        }),
      }),
  ],
  // Body.
  ["an empty body", (port) => rawRequest(port, { body: "" })],
  [
    "no code and no error",
    (port, state) => rawRequest(port, { body: form({ state }) }),
  ],
  [
    "a code and an error",
    (port, state, code) =>
      rawRequest(port, {
        body: form({ code, error: "access_denied", state }),
      }),
  ],
  [
    "an extra field",
    (port, state, code) =>
      rawRequest(port, { body: form({ code, state, extra: "1" }) }),
  ],
  [
    "a repeated state",
    (port, state, code) =>
      rawRequest(port, {
        body: form([
          ["code", code],
          ["state", state],
          ["state", state],
        ]),
      }),
  ],
  [
    "a repeated code",
    (port, state, code) =>
      rawRequest(port, {
        body: form([
          ["code", code],
          ["code", code],
          ["state", state],
        ]),
      }),
  ],
  [
    "an access token instead of a code",
    (port, state) =>
      rawRequest(port, { body: form({ code: `mmda_${random32()}`, state }) }),
  ],
  [
    "a code without its prefix",
    (port, state) =>
      rawRequest(port, { body: form({ code: random32(), state }) }),
  ],
  [
    "an error outside the format",
    (port, state) =>
      rawRequest(port, { body: form({ error: "Access_Denied", state }) }),
  ],
  [
    "a JSON body",
    (port, state, code) =>
      rawRequest(port, {
        contentType: "application/json",
        body: JSON.stringify({ code, state }),
      }),
  ],
];

describe("refused requests", () => {
  test.each(refused)(
    "answers 404 to %s and keeps listening",
    async (_name, build) => {
      const { listener, server, state, result, errors } = await start();
      const answer = await exchange(
        listener.port,
        build(listener.port, state, newSignInCode()),
      );
      expect(answer.status).toBe(404);
      expect(answer.headers).toMatchObject(SECURITY_HEADERS);
      await settle();
      expect(result()).toBeUndefined();
      expect(server.listening).toBe(true);

      const code = newSignInCode();
      const valid = await exchange(
        listener.port,
        rawRequest(listener.port, { body: form({ code, state }) }),
      );
      expect(valid.status).toBe(200);
      const value = await listener.wait();
      expect(value.kind === "code" && value.code).toBe(code);
      expect(errors).toEqual([]);
    },
  );

  test("accepts a body of exactly the size limit", async () => {
    const { listener, state } = await start();
    const code = newSignInCode();
    const fields = form({ code, state });
    // Empty pairs between the separators carry no field.
    const body =
      fields + "&".repeat(SIGN_IN_LISTENER_MAX_BODY_BYTES - fields.length);
    expect(Buffer.byteLength(body)).toBe(SIGN_IN_LISTENER_MAX_BODY_BYTES);
    const answer = await exchange(
      listener.port,
      rawRequest(listener.port, { body }),
    );
    expect(answer.status).toBe(200);
    const value = await listener.wait();
    expect(value.kind === "code" && value.code).toBe(code);
  });

  test("refuses a body over the size limit, also without a Content-Length, and keeps listening", async () => {
    const { listener, server, state, result } = await start();
    const code = newSignInCode();
    const fields = form({ code, state });
    const body =
      fields + "&".repeat(SIGN_IN_LISTENER_MAX_BODY_BYTES + 1 - fields.length);

    const declared = await exchange(
      listener.port,
      rawRequest(listener.port, { body }),
    );
    expect(declared.status).toBe(404);
    expect(declared.headers).toMatchObject(SECURITY_HEADERS);

    // A declared length alone is refused before the body arrives.
    const headersOnly = await exchange(
      listener.port,
      rawRequest(listener.port, { body }).slice(0, -body.length),
    );
    expect(headersOnly.status).toBe(404);

    // A chunked body is counted as it arrives.
    const chunked = await exchange(
      listener.port,
      [
        "POST /callback HTTP/1.1",
        `Host: 127.0.0.1:${listener.port}`,
        "Content-Type: application/x-www-form-urlencoded",
        "Transfer-Encoding: chunked",
        "",
        body.length.toString(16),
        body,
        "",
      ].join("\r\n"),
    );
    expect(chunked.status).toBe(404);

    await settle();
    expect(result()).toBeUndefined();
    expect(server.listening).toBe(true);
    const valid = await exchange(
      listener.port,
      rawRequest(listener.port, { body: fields }),
    );
    expect(valid.status).toBe(200);
    const value = await listener.wait();
    expect(value.kind === "code" && value.code).toBe(code);
  });
});

describe("closing", () => {
  test("cancel resolves with cancelled, stops the timer, and closes every connection", async () => {
    const { listener, server, timers } = await start();
    const idle = await idleConnection(listener.port, server);
    listener.cancel();
    expect(await listener.wait()).toEqual({ kind: "cancelled" });
    expect(server.listening).toBe(false);
    expect(timers.pending()).toEqual([]);
    await idle.closed;
    await listener.close();
    listener.cancel();
    expect(await listener.wait()).toEqual({ kind: "cancelled" });
  });

  test("close cancels and resolves once the port is released", async () => {
    const { listener, server } = await start();
    await listener.close();
    expect(server.listening).toBe(false);
    expect(await listener.wait()).toEqual({ kind: "cancelled" });
  });

  test("closes after 10 minutes with timed_out", async () => {
    const { listener, server, timers } = await start();
    const idle = await idleConnection(listener.port, server);
    expect(timers.pending()).toEqual([SIGN_IN_LISTENER_TIMEOUT_MS]);
    timers.fire();
    expect(await listener.wait()).toEqual({ kind: "timed_out" });
    expect(server.listening).toBe(false);
    await idle.closed;
    await listener.close();
  });

  test("a cancel after the valid request keeps its result", async () => {
    const { listener, state } = await start();
    const code = newSignInCode();
    await exchange(
      listener.port,
      rawRequest(listener.port, { body: form({ code, state }) }),
    );
    listener.cancel();
    const value = await listener.wait();
    expect(value.kind === "code" && value.code).toBe(code);
  });
});

describe("answers", () => {
  /** Whether a page could load anything: an attribute or CSS that names a resource. */
  function loadsNothing(html: string): boolean {
    return !/<(?:script|link|img|iframe|style|object|embed|form|base)\b|\b(?:src|href|action|srcset)=|url\(|https?:/iu.test(
      html,
    );
  }

  test("the return page sends the security headers and loads nothing", async () => {
    const { listener, state } = await start();
    const code = newSignInCode();
    const answer = await exchange(
      listener.port,
      rawRequest(listener.port, { body: form({ code, state }) }),
    );
    expect(answer.status).toBe(200);
    expect(answer.headers).toMatchObject({
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
    });
    expect(answer.headers["content-length"]).toBe(
      String(Buffer.byteLength(answer.body)),
    );
    expect(answer.body).toMatch(/^<!doctype html>/u);
    expect(answer.body).toContain("<title>Returning to MyManDev</title>");
    expect(loadsNothing(answer.body)).toBe(true);
    expect(answer.body).not.toContain(code);
    expect(answer.body).not.toContain(state);
  });

  test("the page after an error sends the same headers and loads nothing", async () => {
    const { listener, state } = await start();
    const answer = await exchange(
      listener.port,
      rawRequest(listener.port, {
        body: form({ error: "access_denied", state }),
      }),
    );
    expect(answer.status).toBe(200);
    expect(answer.headers).toMatchObject({
      ...SECURITY_HEADERS,
      "content-type": "text/html; charset=utf-8",
    });
    expect(answer.body).toContain("<title>Sign-in did not finish</title>");
    expect(loadsNothing(answer.body)).toBe(true);
    expect(answer.body).not.toContain(state);
  });

  test("the 404 answer sends the same headers and echoes nothing", async () => {
    const { listener, state } = await start();
    const code = newSignInCode();
    const answer = await exchange(
      listener.port,
      rawRequest(listener.port, {
        path: "/callback/",
        body: form({ code, state }),
      }),
    );
    expect(answer.status).toBe(404);
    expect(answer.headers).toMatchObject({
      ...SECURITY_HEADERS,
      "content-type": "text/plain; charset=utf-8",
    });
    expect(answer.body).toBe("Not Found");
  });
});

describe("logs", () => {
  test("nothing secret reaches a log, an error report, or a logged result", async () => {
    const calls: unknown[][] = [];
    for (const method of [
      "log",
      "info",
      "warn",
      "error",
      "debug",
      "trace",
    ] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        calls.push(args);
      });
    }
    const { listener, state, errors } = await start();
    const code = newSignInCode();
    for (const request of [
      rawRequest(listener.port, { body: form({ code, state: random32() }) }),
      rawRequest(listener.port, {
        method: "GET",
        path: `/callback?code=${code}&state=${state}`,
      }),
      rawRequest(listener.port, {
        host: "attacker.example",
        body: form({ code, state }),
      }),
    ]) {
      expect((await exchange(listener.port, request)).status).toBe(404);
    }
    await exchange(
      listener.port,
      rawRequest(listener.port, { body: form({ code, state }) }),
    );
    const value = await listener.wait();
    await listener.close();

    expect(value.kind === "code" && value.code).toBe(code);
    expect(Object.keys(value)).toEqual(["kind"]);
    expect(inspect(value)).not.toContain(code);
    expect(JSON.stringify(value)).not.toContain(code);
    expect(`${String(value)}`).not.toContain(code);
    expect(Object.isFrozen(value)).toBe(true);

    expect(errors).toEqual([]);
    const logged = calls.map((args) => inspect(args)).join("\n");
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(state);
    expect(calls).toEqual([]);
  });
});
