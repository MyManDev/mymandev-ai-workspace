import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { STATUS_CODES } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "./config.ts";
import { CloseCode, registerGateway, type EventHandler } from "./gateway.ts";
import { serializeError, serializeRequest } from "./log.ts";

export type BuildAppOptions = Readonly<{
  config: Config;
  /** The application version that `/health` reports. */
  version: string;
  /** Receives every valid event. The default logs it at debug level. */
  onEvent?: EventHandler;
  /** How long shutdown waits for WebSocket clients to close. Default: 2000 ms. */
  shutdownGraceMs?: number;
  /**
   * `false` turns logging off. A `stream` receives the JSON log lines instead
   * of standard output. Default: standard output.
   */
  logger?: false | Readonly<{ stream: { write(line: string): void } }>;
}>;

/** The ws default (100 MiB) is far above what one event needs. Larger frames close with 1009. */
const MAX_FRAME_BYTES = 64 * 1024;

const REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

const healthResponse = {
  type: "object",
  properties: {
    status: { type: "string", const: "ok" },
    version: { type: "string" },
  },
  required: ["status", "version"],
} as const;

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
    // Reject instead of silently stripping unknown properties or coercing types.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  // The default handler sends err.message in every environment, also for errors
  // whose statusCode is below 500 or not an HTTP error status at all.
  app.setErrorHandler((error, request, reply) => {
    const received = statusCodeOf(error);
    const statusCode = received >= 400 && received <= 599 ? received : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    const reason = STATUS_CODES[statusCode] ?? "Error";
    const message =
      statusCode < 500 && isFastifyError(error) ? error.message : reason;
    return reply
      .status(statusCode)
      .send({ statusCode, error: reason, message });
  });

  // The default handler logs and echoes the method and the full URL.
  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .send({ statusCode: 404, error: "Not Found", message: "Not Found" }),
  );

  await app.register(websocket, {
    options: { maxPayload: MAX_FRAME_BYTES },
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

  registerGateway(app, { allowedOrigins: config.allowedOrigins, onEvent });

  return app;
}
