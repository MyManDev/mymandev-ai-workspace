import {
  decodeClientEvent,
  newUuidV7,
  type DeviceId,
  type UnverifiedEvent,
  type UserId,
} from "@mymandev/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";

/**
 * WebSocket close codes used by the gateway (RFC 6455, section 7.4.1). The
 * codes and the reasons sent with them are provisional: the WebSocket message
 * protocol (M2-01) may change them.
 */
export const CloseCode = {
  /** The server is shutting down. Reason `server_shutdown`. */
  goingAway: 1001,
  /** A binary frame. Reason `binary_not_supported`. */
  unsupportedData: 1003,
  /** A text frame that is not JSON. Reason `invalid_json`. */
  invalidFramePayload: 1007,
  /** A frame that is not a valid event from a device. The reason is the decode code. */
  policyViolation: 1008,
  /** A frame over the size limit. Sent by the WebSocket library. */
  messageTooBig: 1009,
} as const;

/** The authenticated user and device of a connection. */
export type ConnectionIdentity = Readonly<{
  userId: UserId;
  deviceId: DeviceId;
}>;

export type ConnectionContext = Readonly<{
  /** A UUIDv7 that identifies the connection in logs. */
  connectionId: string;
  /** Set by authentication in M2. Always null in M1-02. */
  identity: ConnectionIdentity | null;
}>;

/**
 * Receives events that are well-formed but not yet bound to an identity. Only
 * the server's identity binding (M2) may turn them into events that are
 * relayed or stored.
 */
export type EventHandler = (
  event: UnverifiedEvent,
  context: ConnectionContext,
) => void;

/**
 * Refuses a WebSocket handshake from a browser origin that is not listed.
 * Browsers send Origin on every WebSocket handshake and apply no same-origin
 * rule to WebSocket; Node and the Electron main process send no Origin.
 */
export function originGuard(allowedOrigins: readonly string[]) {
  const allowed: ReadonlySet<string> = new Set(allowedOrigins);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) {
      return reply
        .code(403)
        .send({ statusCode: 403, error: "Forbidden", message: "Forbidden" });
    }
  };
}

function frameToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

/**
 * Registers the WebSocket gateway on `GET /ws`. Every text frame must be one
 * JSON event that `decodeClientEvent` accepts; anything else closes the
 * connection. Valid events go to `onEvent` with the connection context. There
 * is no routing, fan-out, persistence or reply in M1-02.
 */
export function registerGateway(
  app: FastifyInstance,
  options: Readonly<{
    allowedOrigins: readonly string[];
    onEvent: EventHandler;
  }>,
): void {
  app.get(
    "/ws",
    { websocket: true, preValidation: originGuard(options.allowedOrigins) },
    (socket: WebSocket, request) => {
      const context: ConnectionContext = Object.freeze({
        connectionId: newUuidV7(),
        identity: null,
      });
      socket.on("message", (data, isBinary) => {
        // After a close was requested, ignore frames that arrived in the same read.
        if (socket.readyState !== socket.OPEN) {
          return;
        }
        if (isBinary) {
          socket.close(CloseCode.unsupportedData, "binary_not_supported");
          return;
        }
        let input: unknown;
        try {
          input = JSON.parse(frameToText(data));
        } catch {
          socket.close(CloseCode.invalidFramePayload, "invalid_json");
          return;
        }
        const result = decodeClientEvent(input);
        if (!result.ok) {
          request.log.debug(
            { connectionId: context.connectionId, code: result.code },
            "event rejected",
          );
          socket.close(CloseCode.policyViolation, result.code);
          return;
        }
        options.onEvent(result.event, context);
      });
    },
  );
}
