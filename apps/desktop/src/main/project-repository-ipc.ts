import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type {
  ProjectRepositoriesView,
  ProjectRepositoryProblem,
} from "../shared/ipc-contract.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type {
  ProjectRepositoryService,
  ProjectRepositoryState,
} from "./repository-links/service.ts";
import type { ScheduleTimer } from "./runtime.ts";

/**
 * The shortest time between two publishes of the project repositories, as
 * for the agent activity: a burst of changes sends the latest view once.
 */
export const PROJECT_REPOSITORY_PUBLISH_INTERVAL_MS = 50;

/**
 * Each read failure and its problem in the contract. `satisfies` checks the
 * fresh literal, so the record fails to compile when a failure is added.
 */
const PROBLEMS = {
  not_signed_in: "not_signed_in",
  not_found: "not_found",
  rate_limited: "rate_limited",
  unavailable: "unavailable",
  failed: "failed",
} satisfies Record<
  NonNullable<ProjectRepositoryState["problem"]>,
  ProjectRepositoryProblem
>;
Object.freeze(PROBLEMS);

/**
 * The frozen copy of the service's state that crosses IPC, with `revision`
 * as its revision: IDs, names, whether the account linked each repository,
 * the mount ID of a linked folder while it is mounted, and whether the
 * account may remove each repository, which the service worked out (#309).
 * No path, member ID, or user ID crosses.
 */
export function projectRepositoriesView(
  state: ProjectRepositoryState,
  revision: number,
): ProjectRepositoriesView {
  const fields = {
    revision,
    workspaceId: state.workspaceId,
    projectId: state.projectId,
    links: state.links,
    repositories: Object.freeze(
      state.repositories.map((entry) =>
        Object.freeze({
          repositoryId: entry.repositoryId,
          name: entry.name,
          linked: entry.linked,
          mountId: entry.linked ? entry.mountId : null,
          removable: entry.removable,
        }),
      ),
    ),
  };
  if (state.status === "unavailable") {
    return Object.freeze({
      status: "unavailable",
      problem: PROBLEMS[state.problem ?? "failed"],
      ...fields,
    });
  }
  return Object.freeze({ status: state.status, ...fields });
}

function scheduleWithSetTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
}

export interface ProjectRepositoryIpcOptions {
  readonly service: Pick<
    ProjectRepositoryService,
    "state" | "onChange" | "register" | "remove" | "link" | "unlink"
  >;
  /** Defaults to `setTimeout`. */
  readonly scheduleTimer?: ScheduleTimer;
  /** Defaults to `console.error`. */
  readonly onError?: (message: string, error: unknown) => void;
}

export interface ProjectRepositoryIpc {
  /** Stops listening and cancels a publish that waits, for the quit. */
  readonly close: () => void;
}

/**
 * Registers the handlers of the project repository channels (#286) and
 * sends the open project's repositories to the frames that subscribed, at
 * most one view every `PROJECT_REPOSITORY_PUBLISH_INTERVAL_MS`. Every
 * handler checks the sender and the arguments first (`createInvokeHandler`):
 * the IDs as lowercase UUIDv7s, the mount ID as a UUID, and a name of 1 to
 * 100 characters, never a path. The results are parsed by the contract, so
 * only fixed codes, a wait, and a new repository's ID reach the renderer.
 * The resolution of a repository to its folder has no channel: it stays in
 * the main process. Call it before the first window loads.
 */
export function registerProjectRepositoryIpc(
  ipc: IpcRegistry,
  appUrl: string,
  options: ProjectRepositoryIpcOptions,
): ProjectRepositoryIpc {
  const { service } = options;
  const schedule = options.scheduleTimer ?? scheduleWithSetTimeout;
  const onError =
    options.onError ??
    ((message: string, error: unknown) => console.error(message, error));
  const publisher = createEventPublisher(
    EVENT_CHANNELS.projectRepositoriesChanged,
    appUrl,
  );

  let closed = false;
  let revision = 0;
  let cancelPublish: (() => void) | null = null;

  function view(): ProjectRepositoriesView {
    return projectRepositoriesView(service.state(), revision);
  }

  function publish(): void {
    cancelPublish = null;
    if (closed) {
      return;
    }
    try {
      publisher.publish(view());
    } catch (error) {
      onError("Sending the project repositories failed.", error);
    }
  }

  function changed(): void {
    if (closed) {
      return;
    }
    revision += 1;
    cancelPublish ??= schedule(publish, PROJECT_REPOSITORY_PUBLISH_INTERVAL_MS);
  }

  ipc.handle(
    INVOKE_CHANNELS.getProjectRepositoryState,
    createInvokeHandler(INVOKE_CHANNELS.getProjectRepositoryState, appUrl, () =>
      view(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeProjectRepositoryState,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeProjectRepositoryState,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return view();
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.registerRepository,
    createInvokeHandler(
      INVOKE_CHANNELS.registerRepository,
      appUrl,
      (_event, [projectId, name]) => service.register(projectId, name),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.removeRepository,
    createInvokeHandler(
      INVOKE_CHANNELS.removeRepository,
      appUrl,
      (_event, [projectId, repositoryId]) =>
        service.remove(projectId, repositoryId),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.linkRepository,
    createInvokeHandler(
      INVOKE_CHANNELS.linkRepository,
      appUrl,
      (_event, [repositoryId, mountId]) => service.link(repositoryId, mountId),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.unlinkRepository,
    createInvokeHandler(
      INVOKE_CHANNELS.unlinkRepository,
      appUrl,
      (_event, [repositoryId]) => service.unlink(repositoryId),
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
