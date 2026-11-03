import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type { ConnectionClient } from "./connection/client.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";

/**
 * Registers the handlers of the connection channels and sends each change
 * of the connection status to the frames that subscribed. Every handler
 * checks the sender and the arguments first (`createInvokeHandler`) and
 * answers with a value parsed by the contract, so only fixed codes and a
 * time reach the renderer; no frame, nonce, signature, or key does (ADR
 * 0014). No channel takes an argument. Call it before the first window
 * loads.
 */
export function registerConnectionIpc(
  ipc: IpcRegistry,
  appUrl: string,
  client: Pick<ConnectionClient, "status" | "onStatusChange" | "reconnect">,
  onError: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): void {
  const publisher = createEventPublisher(
    EVENT_CHANNELS.connectionStatusChanged,
    appUrl,
  );

  ipc.handle(
    INVOKE_CHANNELS.getConnectionStatus,
    createInvokeHandler(INVOKE_CHANNELS.getConnectionStatus, appUrl, () =>
      client.status(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeConnectionStatus,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeConnectionStatus,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return client.status();
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.reconnect,
    createInvokeHandler(INVOKE_CHANNELS.reconnect, appUrl, () =>
      client.reconnect(),
    ),
  );
  client.onStatusChange((status) => {
    try {
      publisher.publish(status);
    } catch (error) {
      onError("Sending the connection status failed.", error);
    }
  });
}
