// The loopback listener of the sign-in (ADR 0014, "Sign-in", step 6). The
// API's page posts the sign-in code, or an error, with the attempt's state in
// a form body to `http://127.0.0.1:<port>/callback`. The listener accepts only
// that request and answers every other one with 404 without ending the
// attempt. It never reads the `Origin` header, which the browsers checked in
// #67 send as `null`. It never logs: the code reaches only the caller, in a
// property that logging leaves out.
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  Base64Url32BytesSchema,
  LOOPBACK_CALLBACK_PATH,
  LoopbackCallbackBodySchema,
  LoopbackRedirectUriSchema,
} from "@mymandev/protocol";
import type { ScheduleTimer } from "../runtime.ts";

/** The listener binds to this address only, passed explicitly (RFC 8252). */
export const SIGN_IN_LISTENER_HOST = "127.0.0.1";

/** The listener closes after 10 minutes, the lifetime of the API's attempt. */
export const SIGN_IN_LISTENER_TIMEOUT_MS = 10 * 60_000;

/** The largest form body accepted. The API's form is about 100 bytes. */
export const SIGN_IN_LISTENER_MAX_BODY_BYTES = 1024;

/**
 * A connection ends after this long without activity, without an answer, so
 * a request that stalls in the middle of its headers or body usually ends
 * this way. A request that keeps sending, but whose headers or body take
 * longer than this in total, gets the 404 and is closed when Node.js next
 * checks the request limits, once a second, so within about one more second.
 */
export const SIGN_IN_LISTENER_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * After the answer to the valid request, how long the other connections and
 * that answer get before every connection is closed, so `close` always
 * resolves.
 */
const ANSWER_GRACE_MS = 1_000;

/**
 * The errors that the API's page posts instead of a code: `access_denied`
 * (declined on GitHub, or Cancel on the confirmation page), `sign_in_failed`
 * (GitHub did not confirm the code or the account), `unsupported_account` (a
 * login outside the login rule), and `sign_in_unavailable` (GitHub's limit,
 * or too many open sign-ins). Another error code that the protocol's form
 * accepts is reported as `sign_in_failed`.
 */
export const SIGN_IN_LISTENER_ERRORS = Object.freeze([
  "access_denied",
  "sign_in_failed",
  "unsupported_account",
  "sign_in_unavailable",
] as const);
export type SignInListenerError = (typeof SIGN_IN_LISTENER_ERRORS)[number];

/**
 * How the listener ended. `code` holds the sign-in code; the property is not
 * enumerable, so `console.log` and `JSON.stringify` of the result leave it
 * out.
 */
export type SignInListenerResult =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "error"; readonly error: SignInListenerError }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timed_out" };

export interface SignInListener {
  /** `http://127.0.0.1:<port>/callback`, for the authorize URL and `POST /auth/sign-in`. */
  readonly redirectUri: string;
  readonly port: number;
  /** Resolves once with the result; never rejects. */
  readonly wait: () => Promise<SignInListenerResult>;
  /** Ends the attempt from the application: `wait` resolves with `cancelled`, unless it already resolved, and the listener closes. */
  readonly cancel: () => void;
  /** Cancels like `cancel` and resolves once the port is released. */
  readonly close: () => Promise<void>;
}

export interface SignInListenerOptions {
  /** The attempt's state, 43 base64url characters; the API posts it back. */
  readonly state: string;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /**
   * Defaults to `SIGN_IN_LISTENER_CONNECTION_TIMEOUT_MS`; tests pass a
   * shorter one.
   */
  readonly connectionTimeoutMs?: number;
  /**
   * Receives a fixed message when the server reports an error after it
   * started. A message never contains a request value.
   */
  readonly onError?: (message: string) => void;
}

const scheduleWithSetTimeout: ScheduleTimer = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/** Headers of every answer, the 404 included. */
const RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  // One request per connection, so that closing never waits for an idle one
  // and a refused body is not read to its end.
  connection: "close",
});

function page(title: string, text: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${title}</title>`,
    "</head>",
    "<body>",
    `<h1>${title}</h1>`,
    `<p>${text}</p>`,
    "</body>",
    "</html>",
  ].join("");
}

// Fixed text only: nothing from the request appears on a page.
const CODE_PAGE = page(
  "Returning to MyManDev",
  "The MyManDev application finishes the sign-in. You can close this tab.",
);
const ERROR_PAGE = page(
  "Sign-in did not finish",
  "The MyManDev application shows what to do next. You can close this tab.",
);

function send(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
): void {
  // Nothing more is written once the connection ended, for example after the
  // 404 that `clientError` wrote to the socket itself.
  const socket = response.socket;
  if (
    response.headersSent ||
    response.destroyed ||
    socket === null ||
    socket.destroyed ||
    socket.writableEnded
  ) {
    return;
  }
  const bytes = Buffer.from(body, "utf8");
  response.writeHead(statusCode, {
    ...RESPONSE_HEADERS,
    "content-type": contentType,
    "content-length": String(bytes.length),
  });
  response.end(bytes);
}

const NOT_FOUND_TYPE = "text/plain; charset=utf-8";
const NOT_FOUND_BODY = "Not Found";

function notFound(response: ServerResponse): void {
  send(response, 404, NOT_FOUND_TYPE, NOT_FOUND_BODY);
}

/**
 * The same 404, written straight to the socket for a request that Node.js
 * could not parse or that timed out, when there is no response object.
 */
const RAW_NOT_FOUND = Buffer.from(
  [
    "HTTP/1.1 404 Not Found",
    ...Object.entries({
      ...RESPONSE_HEADERS,
      "content-type": NOT_FOUND_TYPE,
      "content-length": String(NOT_FOUND_BODY.length),
    }).map(([name, value]) => `${name}: ${value}`),
    "",
    NOT_FOUND_BODY,
  ].join("\r\n"),
  "latin1",
);

/** The value of a header sent exactly once; undefined when it is missing or repeated. */
function singleHeader(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const raw = request.rawHeaders;
  let value: string | undefined;
  let count = 0;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === name) {
      count += 1;
      value = raw[index + 1];
    }
  }
  return count === 1 ? value : undefined;
}

/** Whether the media type, without its parameters, is a form body. */
function isFormBody(contentType: string | undefined): boolean {
  if (contentType === undefined) {
    return false;
  }
  const essence = contentType.split(";", 1)[0] ?? "";
  return essence.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

/** Reads the body up to the limit; null when it is larger or the request ends early. */
function readBody(request: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (body: Buffer | null) => {
      if (!done) {
        done = true;
        resolve(body);
      }
    };
    request.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }
      size += chunk.length;
      if (size > SIGN_IN_LISTENER_MAX_BODY_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish(Buffer.concat(chunks)));
    request.on("error", () => finish(null));
    request.on("close", () => finish(null));
  });
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

const knownErrors: ReadonlySet<string> = new Set(SIGN_IN_LISTENER_ERRORS);

/** A frozen code result whose `code` is not enumerable. */
function codeResult(code: string): SignInListenerResult {
  const result = { kind: "code" };
  Object.defineProperty(result, "code", { value: code, enumerable: false });
  return Object.freeze(result) as SignInListenerResult;
}

/**
 * The result that a form body carries, or null when it is not exactly
 * `code` and `state` or `error` and `state`, a key repeats, a value is
 * outside the protocol's format, or the state is not the expected one. The
 * state is compared in constant time, through SHA-256 hashes of equal length.
 */
function parseCallback(
  body: Buffer,
  expectedStateHash: Buffer,
): SignInListenerResult | null {
  const params = new URLSearchParams(body.toString("utf8"));
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) {
    return null;
  }
  const names = [...keys].sort().join(",");
  if (names !== "code,state" && names !== "error,state") {
    return null;
  }
  const parsed = LoopbackCallbackBodySchema.safeParse(
    Object.fromEntries(params),
  );
  if (
    !parsed.success ||
    !timingSafeEqual(sha256(parsed.data.state), expectedStateHash)
  ) {
    return null;
  }
  if ("code" in parsed.data) {
    return codeResult(parsed.data.code);
  }
  const error = knownErrors.has(parsed.data.error)
    ? (parsed.data.error as SignInListenerError)
    : "sign_in_failed";
  return Object.freeze({ kind: "error", error });
}

/**
 * Starts the listener on `127.0.0.1`, a port that the system chooses, and
 * the path `/callback`. It accepts only `POST /callback` with exactly one
 * `Host` header equal to `127.0.0.1:<port>`, a form body of at most
 * `SIGN_IN_LISTENER_MAX_BODY_BYTES`, and the expected state, and answers
 * every other request with 404 and keeps listening. It closes after the
 * valid request, after `cancel` or `close`, or after 10 minutes. Rejects
 * when the server cannot listen, and throws a `TypeError` for a state outside
 * the protocol's format.
 */
export async function startSignInListener(
  options: SignInListenerOptions,
): Promise<SignInListener> {
  const state = Base64Url32BytesSchema.safeParse(options.state);
  if (!state.success) {
    throw new TypeError("Invalid state");
  }
  const expectedStateHash = sha256(state.data);
  const timeoutMs =
    options.connectionTimeoutMs ?? SIGN_IN_LISTENER_CONNECTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Invalid connection timeout");
  }
  const scheduleTimer = options.scheduleTimer ?? scheduleWithSetTimeout;
  const report = options.onError ?? (() => undefined);

  let expectedHost: string | null = null;
  let settled = false;
  let cancelTimer: () => void = () => undefined;
  let resolveResult: (result: SignInListenerResult) => void = () => undefined;
  const result = new Promise<SignInListenerResult>((resolve) => {
    resolveResult = resolve;
  });

  // The response of the request that each connection carries, so that an
  // answer written straight to the socket never mixes into a started one.
  const responses = new WeakMap<Duplex, ServerResponse>();

  const server = createServer(
    {
      // A missing Host header gets this listener's 404, not Node's 400.
      requireHostHeader: false,
      headersTimeout: timeoutMs,
      requestTimeout: timeoutMs,
      // Node.js checks the two limits above on this interval (30 seconds by
      // default), so it bounds how late a slow request ends.
      connectionsCheckingInterval: Math.min(1_000, timeoutMs),
    },
    (request, response) => {
      responses.set(request.socket, response);
      handle(request, response).catch(() => {
        report("The sign-in listener failed to answer a request.");
        notFound(response);
      });
    },
  );
  // One request per connection: Node.js drops a pipelined request before it
  // reaches the handler, and the first answer closes the connection, so the
  // 503 that Node.js prepares for it is never sent.
  server.maxRequestsPerSocket = 1;
  // No cap on connections (no `maxConnections`). A cap would let a local
  // process that holds every slot, and reopens each one as soon as it
  // closes, keep the browser's request out for the whole attempt. A process
  // of the same user is outside the threat model, because it could stop the
  // application anyway, and the timeouts bound how long each connection lives.
  // A connection that sends nothing, or stops sending, ends too.
  server.on("connection", (socket: Socket) => {
    socket.setTimeout(timeoutMs, () => socket.destroy());
  });
  // An unknown `Expect` header gets the same 404 instead of Node's 417.
  server.on("checkExpectation", (request, response) => {
    responses.set(request.socket, response);
    notFound(response);
  });
  // A request that Node.js cannot parse, whose headers are too large, or
  // that keeps sending past the header or request timeout gets the same 404
  // instead of Node's bare 400, 431, or 408, unless an answer has already
  // started on the connection.
  server.on("clientError", (_error, socket: Duplex) => {
    const response = responses.get(socket);
    if (socket.writable && (response === undefined || !response.headersSent)) {
      socket.end(RAW_NOT_FOUND, () => socket.destroy());
      return;
    }
    socket.destroy();
  });
  const closed = new Promise<void>((resolve) => {
    server.once("close", () => resolve());
  });

  function settle(
    value: SignInListenerResult,
    answered?: ServerResponse,
  ): void {
    if (settled) {
      return;
    }
    settled = true;
    cancelTimer();
    resolveResult(value);
    server.close();
    if (answered === undefined || answered.destroyed) {
      server.closeAllConnections();
      return;
    }
    // Let the answer to the valid request reach the browser first, but never
    // wait for it, or for another connection, longer than the grace period.
    server.closeIdleConnections();
    const fallback = setTimeout(
      () => server.closeAllConnections(),
      ANSWER_GRACE_MS,
    );
    fallback.unref();
    server.once("close", () => clearTimeout(fallback));
    answered.once("close", () => {
      clearTimeout(fallback);
      server.closeAllConnections();
    });
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (
      settled ||
      expectedHost === null ||
      request.method !== "POST" ||
      request.url !== LOOPBACK_CALLBACK_PATH ||
      singleHeader(request, "host") !== expectedHost ||
      !isFormBody(singleHeader(request, "content-type"))
    ) {
      notFound(response);
      return;
    }
    const declaredLength = request.headers["content-length"];
    if (
      declaredLength !== undefined &&
      Number(declaredLength) > SIGN_IN_LISTENER_MAX_BODY_BYTES
    ) {
      notFound(response);
      return;
    }
    const body = await readBody(request);
    const callback =
      body === null ? null : parseCallback(body, expectedStateHash);
    if (callback === null || settled) {
      notFound(response);
      return;
    }
    send(
      response,
      200,
      "text/html; charset=utf-8",
      callback.kind === "code" ? CODE_PAGE : ERROR_PAGE,
    );
    settle(callback, response);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(
        { host: SIGN_IN_LISTENER_HOST, port: 0, exclusive: true },
        () => {
          server.off("error", reject);
          resolve();
        },
      );
    });
  } catch (cause) {
    throw new Error("The sign-in listener could not start.", { cause });
  }
  server.on("error", () => report("The sign-in listener reported an error."));

  const address = server.address();
  const port =
    address !== null &&
    typeof address === "object" &&
    address.address === SIGN_IN_LISTENER_HOST
      ? address.port
      : 0;
  const redirectUri = `http://${SIGN_IN_LISTENER_HOST}:${port}${LOOPBACK_CALLBACK_PATH}`;
  if (!LoopbackRedirectUriSchema.safeParse(redirectUri).success) {
    server.close();
    server.closeAllConnections();
    throw new Error(
      "The sign-in listener did not get a port from 1024 to 65535.",
    );
  }
  expectedHost = `${SIGN_IN_LISTENER_HOST}:${port}`;
  cancelTimer = scheduleTimer(
    () => settle(Object.freeze({ kind: "timed_out" })),
    SIGN_IN_LISTENER_TIMEOUT_MS,
  );

  return Object.freeze({
    redirectUri,
    port,
    wait: () => result,
    cancel: () => settle(Object.freeze({ kind: "cancelled" })),
    close: async () => {
      settle(Object.freeze({ kind: "cancelled" }));
      await closed;
    },
  });
}
