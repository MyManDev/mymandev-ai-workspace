import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import {
  PROVIDER_CONNECTION_LIMITS,
  type ProviderConnectionItemView,
  type ProviderConnectionListProblem,
  type ProviderConnectionListStatusView,
  type ProviderConnectionListView,
} from "../shared/ipc-contract.ts";
import type { WorkspaceReadFailure } from "./api-reads.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type {
  ProviderConnectionEntry,
  ProviderConnectionListStatus,
  ProviderConnectionService,
  ProviderConnectionsState,
} from "./provider-connections/service.ts";
import type { ScheduleTimer } from "./runtime.ts";

/**
 * The shortest time between two publishes of the provider connections, as
 * for the device list: a burst of changes sends the latest view once.
 */
export const PROVIDER_CONNECTION_PUBLISH_INTERVAL_MS = 50;

/**
 * Each status of the service and its status in the contract. `satisfies`
 * checks the fresh literal, so the record fails to compile when the service
 * gains or loses a status.
 */
const STATUS_VIEWS = {
  signed_out: "signed_out",
  loading: "loading",
  ready: "ready",
  unavailable: "unavailable",
} satisfies Record<
  ProviderConnectionListStatus,
  ProviderConnectionListStatusView
>;
Object.freeze(STATUS_VIEWS);

/**
 * Each failure of a read and the problem that the renderer shows. The API
 * answers `GET /provider-connections` without `not_found`, so it would be a
 * refusal that the desktop does not expect, `failed`.
 */
const PROBLEM_VIEWS = {
  not_signed_in: "not_signed_in",
  not_found: "failed",
  rate_limited: "rate_limited",
  unavailable: "unavailable",
  failed: "failed",
} satisfies Record<WorkspaceReadFailure, ProviderConnectionListProblem>;
Object.freeze(PROBLEM_VIEWS);

function itemView(entry: ProviderConnectionEntry): ProviderConnectionItemView {
  return Object.freeze({
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    createdAt: entry.createdAt,
    status: entry.status,
    model: entry.model,
  });
}

/**
 * The frozen copy of the service's state that crosses IPC, with `revision`
 * as its revision. Each connection keeps its ID, kind, label, creation
 * time, status, and the model chosen for it on this device (#30) only: no
 * device, no account, no credential, and no field that the protocol adds
 * later. The list keeps the server's order and
 * is cut to `PROVIDER_CONNECTION_LIMITS.connections`.
 */
export function providerConnectionListView(
  state: ProviderConnectionsState,
  revision: number,
): ProviderConnectionListView {
  const connections = Object.freeze(
    state.connections
      .slice(0, PROVIDER_CONNECTION_LIMITS.connections)
      .map(itemView),
  );
  const status = STATUS_VIEWS[state.status];
  if (status === "unavailable") {
    return Object.freeze({
      revision,
      status,
      problem: PROBLEM_VIEWS[state.problem ?? "failed"],
      connections,
    });
  }
  return Object.freeze({ revision, status, connections });
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export interface ProviderConnectionIpcOptions {
  readonly service: Pick<
    ProviderConnectionService,
    | "state"
    | "onChange"
    | "register"
    | "remove"
    | "saveKey"
    | "setModel"
    | "removeKey"
  >;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** Defaults to `console.error`. */
  readonly onError?: (message: string, error: unknown) => void;
}

export interface ProviderConnectionIpc {
  /** Stops listening and cancels a publish that waits, for the quit. */
  readonly close: () => void;
}

/**
 * Registers the handlers of the provider connection channels (#32) and
 * sends this device's connections to the frames that subscribed, at most
 * one view every `PROVIDER_CONNECTION_PUBLISH_INTERVAL_MS`. Every handler
 * checks the sender and the arguments first (`createInvokeHandler`):
 * `provider-connections:register` takes one strict object of a kind of the
 * contract and a label of 1 to 64 characters and no other key, so nothing
 * such as a credential can travel beside them; `provider-connections:remove`
 * takes one lowercase UUIDv7. `provider-connections:save-key` takes one
 * strict object of a connection ID, a key of 1 to 512 characters, and a
 * model of `CLAUDE_MODEL_VIEWS` or null, and no other key (#33, #30); the
 * key goes to the service once and is never part of a result, an event, or
 * a log. `provider-connections:set-model` takes one strict object of a
 * connection ID and a model of `CLAUDE_MODEL_VIEWS`, and no other key (#30).
 * `provider-connections:remove-key` takes one lowercase UUIDv7. The results
 * are parsed by the contract, so only fixed codes, a wait, and the
 * connections' IDs, kinds, labels, times, statuses, and models reach the
 * renderer: never a key. Call it before the first window loads.
 */
export function registerProviderConnectionIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: ProviderConnectionIpcOptions,
): ProviderConnectionIpc {
  const { service } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const onError =
    options.onError ??
    ((message: string, error: unknown) => console.error(message, error));
  const publisher = createEventPublisher(
    EVENT_CHANNELS.providerConnectionsChanged,
    appUrl,
  );

  let closed = false;
  let revision = 0;
  let cancelPublish: (() => void) | null = null;

  function view(): ProviderConnectionListView {
    return providerConnectionListView(service.state(), revision);
  }

  function publish(): void {
    cancelPublish = null;
    if (closed) {
      return;
    }
    try {
      publisher.publish(view());
    } catch (error) {
      onError("Sending the provider connections failed.", error);
    }
  }

  function changed(): void {
    if (closed) {
      return;
    }
    revision += 1;
    cancelPublish ??= schedule(
      publish,
      PROVIDER_CONNECTION_PUBLISH_INTERVAL_MS,
    );
  }

  ipc.handle(
    INVOKE_CHANNELS.getProviderConnections,
    createInvokeHandler(INVOKE_CHANNELS.getProviderConnections, appUrl, () =>
      view(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeProviderConnections,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeProviderConnections,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return view();
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.registerProviderConnection,
    createInvokeHandler(
      INVOKE_CHANNELS.registerProviderConnection,
      appUrl,
      // The contract checked the kind and the length of the label, and
      // refused any other key; the service checks the label with the
      // protocol's text rule.
      (_event, [request]) => service.register(request.kind, request.label),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.removeProviderConnection,
    createInvokeHandler(
      INVOKE_CHANNELS.removeProviderConnection,
      appUrl,
      // The contract checked the ID as a lowercase UUIDv7; the service
      // accepts only a connection of its list.
      (_event, [providerConnectionId]) => service.remove(providerConnectionId),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.saveProviderKey,
    createInvokeHandler(
      INVOKE_CHANNELS.saveProviderKey,
      appUrl,
      // The contract checked the ID, the key's length, and the model of the
      // closed list or null, and refused any other key; the service checks
      // the key's shape and that the model fits the connection's kind. The
      // result is `ok` or a fixed refusal, never the key.
      (_event, [request]) =>
        service.saveKey(
          request.providerConnectionId,
          request.key,
          request.model,
        ),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.setProviderModel,
    createInvokeHandler(
      INVOKE_CHANNELS.setProviderModel,
      appUrl,
      // The contract checked the ID and the model of the closed list; the
      // service accepts only a Claude connection of its list with a key.
      (_event, [request]) =>
        service.setModel(request.providerConnectionId, request.model),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.removeProviderKey,
    createInvokeHandler(
      INVOKE_CHANNELS.removeProviderKey,
      appUrl,
      // The contract checked the ID; the service accepts only a connection
      // of its list.
      (_event, [providerConnectionId]) =>
        service.removeKey(providerConnectionId),
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
