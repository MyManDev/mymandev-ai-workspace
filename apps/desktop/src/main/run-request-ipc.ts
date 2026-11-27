import { INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type { RunRequestService } from "./agents/run-request.ts";
import { createInvokeHandler, type IpcRegistry } from "./ipc.ts";

export interface RunRequestIpcOptions {
  readonly service: Pick<RunRequestService, "request" | "takeOutcome">;
}

/**
 * Registers the handlers of `agents:request-run` and
 * `agents:take-run-request-outcome` (#35): a run of an agent of the open
 * project, requested from the project chat, and the outcome of a project's
 * last request, which the chat screen takes once when it opens. Each
 * handler checks the sender and the argument first
 * (`createInvokeHandler`): for a request, one object with exactly the
 * project ID, the agent ID, the provider connection ID, and the input
 * message ID, each a lowercase UUIDv7, and the chosen repository's ID or
 * null (#362), and no other key; for an outcome,
 * one project ID. The results are parsed by the contract, so only fixed
 * codes, a wait, or the new run's ID reach the renderer, and a kept
 * outcome carries no ID. The service sends a request at most once; these
 * handlers never call it again. Call it before the first window loads.
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
  ipc.handle(
    INVOKE_CHANNELS.takeRunRequestOutcome,
    createInvokeHandler(
      INVOKE_CHANNELS.takeRunRequestOutcome,
      appUrl,
      (_event, [projectId]) => service.takeOutcome(projectId),
    ),
  );
}
