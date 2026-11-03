// Connects the connection client to Electron: `net.WebSocket` in the main
// process, with the default session and without its cookies, and the
// `powerMonitor` `resume` event. `net.WebSocket` runs on Chromium's network
// stack, so it follows the system proxy settings (PAC and WPAD included),
// the proxy authentication cache, and the system's TLS trust, like the
// `net.fetch` calls of the device session (ADR 0014). It sends by default
// the http(s) form of the socket URL's origin as `Origin`, which the API
// accepts (#154); the `origin` option stays unset. It stays thin and is not
// tested directly; the type check proves that Electron's APIs fit the
// client.
//
// Create the client after the account service, in the instance that holds
// the single-instance lock. It opens no socket before the account service
// reports a signed-in device, which happens only after the application is
// ready, when `net.WebSocket` can be used. Call `followSystemResume` once
// the application is ready, because `powerMonitor` needs it.
import { app, net, powerMonitor, session } from "electron";
import { resolveApiOrigin } from "../api-origin.ts";
import {
  createConnectionClient,
  type ConnectionAccount,
  type ConnectionClient,
  type ConnectionSocket,
  type SocketEvents,
} from "./client.ts";

function openElectronSocket(
  url: string,
  events: SocketEvents,
): ConnectionSocket {
  const socket = new net.WebSocket(url, {
    session: session.defaultSession,
    useSessionCookies: false,
  });
  socket.addEventListener("open", () => events.open());
  socket.addEventListener("message", (event) => {
    events.message((event as unknown as { readonly data: unknown }).data);
  });
  socket.addEventListener("close", (event) => {
    const { code, reason } = event as unknown as {
      readonly code: number;
      readonly reason: string;
    };
    events.close(code, reason);
  });
  return Object.freeze({
    bufferedAmount: () => socket.bufferedAmount,
    send: (data: string) => socket.send(data),
    close: (code: number) => socket.close(code),
  });
}

export function createSystemConnectionClient(
  account: ConnectionAccount,
  log: (message: string) => void,
): ConnectionClient {
  return createConnectionClient({
    apiOrigin: resolveApiOrigin({
      isPackaged: app.isPackaged,
      env: process.env,
    }),
    account,
    openSocket: openElectronSocket,
    log,
  });
}

/** Reconnects early when the system wakes up. Call it when the application is ready. */
export function followSystemResume(client: ConnectionClient): void {
  powerMonitor.on("resume", () => client.systemResumed());
}
