import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type { RunRequestService } from "./agents/run-request.ts";
import { createInvokeHandler, type IpcRegistry } from "./ipc.ts";

export interface RunRequestIpcOptions {
  readonly service: Pick<RunRequestService, "request">;
}

/**
 * Registers the handler of `agents:request-run` (#35): a run of an agent
 * of the open project, requested from the project chat. The handler checks
 * the sender and the argument first (`createInvokeHandler`): one object
 * with exactly the project ID, the agent ID, the provider connection ID,
 * and the input message ID, each a lowercase UUIDv7, and no other key. The
 * result is parsed by the contract, so only fixed codes, a wait, or the
 * new run's ID reach the renderer. The service sends the request at most
 * once; this handler never calls it again. Call it before the first window
 * loads.
 */
export function registerRunRequestIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: RunRequestIpcOptions,
): void {
  const { service } = options;
  ipc.handle(
    INVOKE_CHANNELS.requestRun,
    createInvokeHandler(
      INVOKE_CHANNELS.requestRun,
      appUrl,
      (_event, [request]) => service.request(request),
    ),
  );
}
