import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type { GrantsView } from "../shared/ipc-contract.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type {
  GrantActionsService,
  GrantsState,
} from "./permissions/grant-actions.ts";
import type { ScheduleTimer } from "./runtime.ts";

/**
 * The shortest time between two publishes of the grants, as for the agent
 * activity: a burst of changes sends the latest view once.
 */
export const GRANT_PUBLISH_INTERVAL_MS = 50;

/**
 * The frozen copy of the grants of the open project's agents that crosses
 * IPC, with `revision` as its revision: IDs, capabilities, scopes, times,
 * and whether each grant expired. No account and no host device cross.
 */
export function grantsView(state: GrantsState, revision: number): GrantsView {
  return Object.freeze({
    revision,
    projectId: state.projectId,
    usable: state.usable,
    grants: state.grants,
  });
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export interface GrantIpcOptions {
  readonly service: Pick<
    GrantActionsService,
    | "state"
    | "onChange"
    | "listProviderConnections"
    | "listAgentGrants"
    | "grant"
    | "revoke"
  >;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** Defaults to `console.error`. */
  readonly onError?: (message: string, error: unknown) => void;
}

export interface GrantIpc {
  /** Stops listening and cancels a publish that waits, for the quit. */
  readonly close: () => void;
}

/**
 * Registers the handlers of the grant channels (#342, #345) and sends the
 * grants of the open project's agents to the frames that subscribed, at most
 * one view every `GRANT_PUBLISH_INTERVAL_MS`. Every handler checks the sender
 * and the arguments first (`createInvokeHandler`): the IDs as lowercase
 * UUIDv7s, the capability as one of the contract's names, and the lifetime
 * as a positive integer or null. The results are parsed by the contract,
 * so only fixed codes, a wait, a new grant's ID, this device's provider
 * connections (an ID, a kind, and a label each), and the grants of an agent
 * that another device hosts (IDs, a capability, a scope, and times each)
 * reach the renderer. Call it before the first window loads.
 */
export function registerGrantIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: GrantIpcOptions,
): GrantIpc {
  const { service } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const onError =
    options.onError ??
    ((message: string, error: unknown) => console.error(message, error));
  const publisher = createEventPublisher(
    EVENT_CHANNELS.grantStateChanged,
    appUrl,
  );

  let closed = false;
  let revision = 0;
  let cancelPublish: (() => void) | null = null;

  function view(): GrantsView {
    return grantsView(service.state(), revision);
  }

  function publish(): void {
    cancelPublish = null;
    if (closed) {
      return;
    }
    try {
      publisher.publish(view());
    } catch (error) {
      onError("Sending the grants failed.", error);
    }
  }

  function changed(): void {
    if (closed) {
      return;
    }
    revision += 1;
    cancelPublish ??= schedule(publish, GRANT_PUBLISH_INTERVAL_MS);
  }

  ipc.handle(
    INVOKE_CHANNELS.getGrantState,
    createInvokeHandler(INVOKE_CHANNELS.getGrantState, appUrl, () => view()),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeGrantState,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeGrantState,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return view();
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.listProviderConnections,
    createInvokeHandler(INVOKE_CHANNELS.listProviderConnections, appUrl, () =>
      service.listProviderConnections(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.grantCapability,
    createInvokeHandler(
      INVOKE_CHANNELS.grantCapability,
      appUrl,
      (_event, [agentId, request]) => service.grant(agentId, request),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.listAgentGrants,
    createInvokeHandler(
      INVOKE_CHANNELS.listAgentGrants,
      appUrl,
      (_event, [agentId]) => service.listAgentGrants(agentId),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.revokeGrant,
    createInvokeHandler(
      INVOKE_CHANNELS.revokeGrant,
      appUrl,
      (_event, [agentId, grantId]) => service.revoke(agentId, grantId),
    ),
  );
  const remove = service.onChange(changed);

  return Object.freeze({
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      remove();
      cancelPublish?.();
      cancelPublish = null;
    },
  });
}
