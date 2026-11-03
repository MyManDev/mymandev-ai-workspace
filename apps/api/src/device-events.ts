import type { FastifyBaseLogger } from "fastify";
import type {
  AuthenticatedConnectionContext,
  EventHandler,
  VerifiedEvent,
} from "./gateway.ts";

/** A verified event of one type. */
export type VerifiedEventOf<Type extends VerifiedEvent["type"]> = Extract<
  VerifiedEvent,
  { type: Type }
>;

/**
 * The handlers of the event types that a device sends, by type. A type
 * without a handler is only logged. Handling a new event type is one more
 * entry here, as the run transitions of #28 are.
 */
export type DeviceEventHandlers = Readonly<{
  [Type in VerifiedEvent["type"]]?: (
    event: VerifiedEventOf<Type>,
    context: AuthenticatedConnectionContext,
  ) => ReturnType<EventHandler>;
}>;

/**
 * The gateway's event handler: logs every verified event at debug level,
 * with its ID, its type, and the connection ID, and hands it to the handler
 * of its type, whose result it returns.
 */
export function dispatchDeviceEvents(
  handlers: DeviceEventHandlers,
  log: FastifyBaseLogger,
): EventHandler {
  return (event, context) => {
    log.debug(
      {
        eventId: event.id,
        eventType: event.type,
        connectionId: context.connectionId,
      },
      "event received",
    );
    // The mapped type pairs each type with its handler; TypeScript cannot
    // follow that pairing through the index, so it is widened here once.
    const handler = handlers[event.type] as EventHandler | undefined;
    return handler?.(event, context);
  };
}
