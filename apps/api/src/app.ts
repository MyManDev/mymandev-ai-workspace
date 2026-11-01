import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { createDatabase, type Database } from "@mymandev/database";
import { genericApiErrorCode, MAX_FRAME_BYTES } from "@mymandev/protocol";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { STATUS_CODES } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  RecentRevocations,
  SignInAttempts,
  SignInCodes,
} from "./auth/attempts.ts";
import { createAccessCheck } from "./auth/authenticate.ts";
import { createGitHubApi, type GitHubApi } from "./auth/github-api.ts";
import { registerGitHubSignIn } from "./auth/github-routes.ts";
import { registerGitHubWebhook } from "./auth/github-webhook.ts";
import { registerDeviceRoutes } from "./auth/device-routes.ts";
import { registerSignIn } from "./auth/sign-in.ts";
import { AccessTokens, Challenges } from "./auth/tokens.ts";
import type { Config } from "./config.ts";
import { ApiError } from "./errors.ts";
import {
  CloseCode,
  ConnectionRegistry,
  GATEWAY_PATH,
  registerGateway,
  socketErrorHandler,
  type EventHandler,
} from "./gateway.ts";
import { serializeError, serializeRequest } from "./log.ts";
import {
  deliverWorkspaceEvent,
  type WorkspaceEventHandler,
} from "./workspaces/events.ts";
import { registerWorkspaceRoutes } from "./workspaces/workspace-routes.ts";

export type BuildAppOptions = Readonly<{
  config: Config;
  /** The application version that `/health` reports. */
  version: string;
  /**
   * Receives every event that passed identity binding, with its
   * authenticated connection. The default logs it at debug level.
   */
  onEvent?: EventHandler;
  /**
   * Receives each membership event that the server originates, after the
   * transaction that made the change committed and after the gateway
   * delivered it to the workspace's subscribed connections. Tests use it to
   * observe the events. Default: nothing more.
   */
  onWorkspaceEvent?: WorkspaceEventHandler;
  /**
   * The open WebSocket connections. The default is a new registry; tests
   * pass one to count or close connections.
   */
  connections?: ConnectionRegistry;
  /** How long shutdown waits for WebSocket clients to close. Default: 2000 ms. */
  shutdownGraceMs?: number;
  /**
   * `false` turns logging off. A `stream` receives the JSON log lines instead
   * of standard output. Default: standard output.
   */
  logger?: false | Readonly<{ stream: { write(line: string): void } }>;
  /** The GitHub calls of sign-in. The default calls GitHub; tests pass a stub. */
  github?: GitHubApi;
  /** The clock, in milliseconds since the epoch. Default: Date.now. */
  now?: () => number;
  /**
   * The database. The default connects to DATABASE_URL and closes the pool
   * when the API closes; tests pass a test database. Without either, the
   * routes that need the database answer the generic 404.
   */
  database?: Database;
}>;

/** In-memory sign-in state (ADR 0014, "Lifetimes" and "Limits"). */
const MAX_OPEN_ATTEMPTS = 1_000;
const ATTEMPT_LIFETIME_MS = 10 * 60_000;
const SIGN_IN_CODE_LIFETIME_MS = 60_000;
const MAX_OPEN_CHALLENGES = 1_000;
const CHALLENGE_LIFETIME_MS = 60_000;
/** Far above 20 devices per account with one token each 15 minutes. */
const MAX_ACCESS_TOKENS = 100_000;
const ACCESS_TOKEN_LIFETIME_MS = 15 * 60_000;
/**
 * GitHub revocations stay in memory as long as a sign-in whose identity was
 * read before them can finish: an attempt and its code (#115), and 2 minutes
 * more as a margin. The sign-in checks again after its commit, which comes
 * after it took the code by as long as its queries run, each up to the
 * database's statement timeout of 30 seconds. The cap is far above the
 * revocations that GitHub sends in that time.
 */
const MAX_RECENT_REVOCATIONS = 10_000;
const RECENT_REVOCATION_MARGIN_MS = 2 * 60_000;
const RECENT_REVOCATION_LIFETIME_MS =
  ATTEMPT_LIFETIME_MS + SIGN_IN_CODE_LIFETIME_MS + RECENT_REVOCATION_MARGIN_MS;

const REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

const NOT_FOUND = {
  statusCode: 404,
  error: "Not Found",
  message: "Not Found",
  code: "not_found",
} as const;

const healthResponse = {
  type: "object",
  properties: {
    status: { type: "string", const: "ok" },
    version: { type: "string" },
  },
  required: ["status", "version"],
} as const;

/** ApiErrorBodySchema allows at most this many characters in `message`. */
const MAX_MESSAGE_LENGTH = 100;

const CRLF = String.fromCharCode(13, 10);

/** The error body for a status, with the status text as the message and a generic code. */
function genericBody(statusCode: number) {
  const reason = STATUS_CODES[statusCode] ?? "Error";
  return {
    statusCode,
    error: reason,
    message: reason,
    code: genericApiErrorCode(statusCode),
  };
}

/**
 * Answers errors that Node.js reports on the connection before Fastify sees a
 * request (a malformed request line, headers over the limit, a timeout), like
 * Fastify's default handler but with a code.
 */
function clientErrorHandler(error: Error & { code?: string }, socket: Socket) {
  if (error.code === "ECONNRESET" || socket.destroyed) {
    return;
  }
  const statusCode =
    error.code === "ERR_HTTP_REQUEST_TIMEOUT"
      ? 408
      : error.code === "HPE_HEADER_OVERFLOW"
        ? 431
        : 400;
  const body = JSON.stringify(genericBody(statusCode));
  if (socket.writable) {
    socket.write(
      [
        `HTTP/1.1 ${statusCode} ${STATUS_CODES[statusCode] ?? "Error"}`,
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Content-Type: application/json; charset=utf-8",
        "Connection: close",
        "",
        body,
      ].join(CRLF),
    );
  }
  socket.destroy(error);
}

// Fastify types the error handler's `error` as unknown, so narrow it.
function statusCodeOf(error: unknown): number {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return 500;
}

/** Fastify's own client errors (validation, 413, 415) have FST_ codes and safe messages. */
function isFastifyError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("FST_")
  );
}

/**
 * Builds the API application without listening. The caller decides when to
 * listen (`server.ts`) or injects requests directly (tests).
 */
export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const { config } = options;
  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            serializers: { req: serializeRequest, err: serializeError },
            ...(options.logger === undefined
              ? {}
              : { stream: options.logger.stream }),
          },
    bodyLimit: config.bodyLimitBytes,
    trustProxy: false,
    requestTimeout: REQUEST_TIMEOUT_MS,
    // A HEAD route per GET route would get its own rate-limit budget and run
    // the GET handler, which doubles every limit.
    exposeHeadRoutes: false,
    // The default answers to a bad URL and to an over-long path parameter
    // echo the path and carry a Fastify code instead of an API error code.
    frameworkErrors: (error, _request, reply) => {
      const received = statusCodeOf(error);
      const statusCode = received >= 400 && received <= 499 ? received : 400;
      void (reply as FastifyReply)
        .code(statusCode)
        .send(genericBody(statusCode));
    },
    clientErrorHandler,
    // Fastify's own 503 while closing has no code; the onRequest hook below
    // sends it with one.
    return503OnClosing: false,
    // Reject instead of silently stripping unknown properties or coercing types.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  // The default handler sends err.message in every environment, also for errors
  // whose statusCode is below 500 or not an HTTP error status at all. Every
  // answer carries a code from API_ERROR_CODES (ADR 0014, P-66).
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error }, "request failed");
      }
      const reason = STATUS_CODES[error.statusCode] ?? "Error";
      if (error.retryAfterSeconds !== undefined) {
        reply.header("retry-after", String(error.retryAfterSeconds));
      }
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: reason,
        message: reason,
        code: error.code,
      });
    }
    const received = statusCodeOf(error);
    const statusCode = received >= 400 && received <= 599 ? received : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    const reason = STATUS_CODES[statusCode] ?? "Error";
    const message =
      statusCode < 500 && isFastifyError(error)
        ? error.message.slice(0, MAX_MESSAGE_LENGTH)
        : reason;
    return reply.status(statusCode).send({
      statusCode,
      error: reason,
      message,
      code: genericApiErrorCode(statusCode),
    });
  });

  // The default handler logs and echoes the method and the full URL.
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(NOT_FOUND));

  // While the API closes, a request on a kept-alive connection gets a 503.
  let closing = false;
  app.addHook("preClose", async () => {
    closing = true;
  });
  app.addHook("onRequest", async (_request, reply) => {
    if (closing) {
      return reply
        .code(503)
        .header("connection", "close")
        .send(genericBody(503));
    }
  });

  // Limits are set per route; a limit answers 429 with rate_limited and
  // Retry-After (P-64). The in-memory store fits one API instance.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => new ApiError("rate_limited"),
  });

  const connections =
    options.connections ?? new ConnectionRegistry({ log: app.log });

  // Every membership event goes to the workspace's subscribed connections
  // (#110), then to the option.
  const onWorkspaceEvent: WorkspaceEventHandler = (event) => {
    deliverWorkspaceEvent(connections, event, app.log);
    return options.onWorkspaceEvent?.(event);
  };
  await app.register(websocket, {
    // The ws default (100 MiB) is far above what one message needs. Larger
    // frames close with 1009.
    options: { maxPayload: MAX_FRAME_BYTES },
    // What a client sent wrong is logged at debug level, with the connection ID.
    errorHandler: socketErrorHandler(connections),
    // Close every client with 1001, wait up to the grace period, then terminate.
    preClose: async () => {
      const server = app.websocketServer;
      for (const client of server.clients) {
        client.close(CloseCode.goingAway, "server_shutdown");
      }
      const allClosed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      await Promise.race([
        allClosed,
        delay(graceMs, undefined, { ref: false }),
      ]);
      for (const client of server.clients) {
        client.terminate();
      }
    },
  });

  // The plugin upgrades a handshake on every GET route, skipping the Origin
  // check of /ws, and logs the full URL when the route has no WebSocket handler.
  app.addHook("onRequest", async (request, reply) => {
    if (request.ws && request.routeOptions.url !== GATEWAY_PATH) {
      return reply.code(404).send(NOT_FOUND);
    }
  });

  app.get(
    "/health",
    { schema: { response: { 200: healthResponse } } },
    async () => ({ status: "ok", version: options.version }),
  );

  const onEvent: EventHandler =
    options.onEvent ??
    ((event, context) => {
      app.log.debug(
        {
          eventId: event.id,
          eventType: event.type,
          connectionId: context.connectionId,
        },
        "event received",
      );
    });

  let database: Database | null = options.database ?? null;
  if (database === null && config.databaseUrl !== null) {
    const connection = createDatabase(config.databaseUrl.reveal());
    database = connection.db;
    app.addHook("onClose", async () => {
      await connection.close();
    });
  }

  const now = options.now ?? Date.now;
  let tokens: AccessTokens | null = null;
  let revocations: RecentRevocations | null = null;

  // Without GitHub sign-in configured, its routes and /ws answer the generic
  // 404; the routes that need the database and /ws also need the database.
  if (config.githubSignIn !== null) {
    const codes = new SignInCodes({
      max: MAX_OPEN_ATTEMPTS,
      lifetimeMs: SIGN_IN_CODE_LIFETIME_MS,
      now,
    });
    await registerGitHubSignIn(app, {
      publicOrigin: config.githubSignIn.publicOrigin,
      github:
        options.github ??
        createGitHubApi({
          clientId: config.githubSignIn.clientId,
          clientSecret: config.githubSignIn.clientSecret,
        }),
      attempts: new SignInAttempts({
        max: MAX_OPEN_ATTEMPTS,
        lifetimeMs: ATTEMPT_LIFETIME_MS,
        now,
      }),
      codes,
      now,
    });
    // Registering the device needs the database too.
    if (database !== null) {
      tokens = new AccessTokens({
        max: MAX_ACCESS_TOKENS,
        lifetimeMs: ACCESS_TOKEN_LIFETIME_MS,
        now,
      });
      // One check for every authenticated route, so that the account's
      // request limit counts them together.
      const requireAccessToken = createAccessCheck(app, {
        database,
        tokens,
        now,
      });
      revocations = new RecentRevocations({
        max: MAX_RECENT_REVOCATIONS,
        lifetimeMs: RECENT_REVOCATION_LIFETIME_MS,
        now,
      });
      await registerSignIn(app, {
        publicOrigin: config.githubSignIn.publicOrigin,
        database,
        codes,
        revocations,
        tokens,
        connections,
        now,
      });
      await registerDeviceRoutes(app, {
        publicOrigin: config.githubSignIn.publicOrigin,
        database,
        challenges: new Challenges({
          max: MAX_OPEN_CHALLENGES,
          lifetimeMs: CHALLENGE_LIFETIME_MS,
          now,
        }),
        tokens,
        requireAccessToken,
        connections,
        now,
      });
      await registerWorkspaceRoutes(app, {
        database,
        requireAccessToken,
        now,
        onWorkspaceEvent,
        // Account frames go to the account's open connections at once.
        onAccountFrame: (userId, frame) => {
          connections.sendToUser(userId, frame);
        },
        connections,
      });
      // A connection authenticates with its device key (ADR 0014).
      registerGateway(app, {
        allowedOrigins: config.allowedOrigins,
        publicOrigin: config.githubSignIn.publicOrigin,
        database,
        now,
        connections,
        onEvent,
      });
    }
  }

  // Without the webhook secret or the database, the webhook answers the
  // generic 404 (ADR 0014, "Configuration").
  if (config.githubWebhook !== null && database !== null) {
    const { secret, previousSecret } = config.githubWebhook;
    await registerGitHubWebhook(app, {
      secrets: previousSecret === null ? [secret] : [secret, previousSecret],
      database,
      connections,
      tokens,
      revocations,
      now,
    });
  }

  return app;
}
