import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type { MountResult } from "../shared/ipc-contract.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";
import type { RepositoryService } from "./repositories.ts";

/**
 * Shows the folder dialog of the main process and resolves to the selected
 * folder's absolute path, or undefined when the user cancelled it.
 */
export type SelectFolder = () => Promise<string | undefined>;

/**
 * Registers the handlers of the repository channels and sends each change
 * of the list to the frames that subscribed. Every handler checks the sender
 * and the arguments first (`createInvokeHandler`). The renderer never sends
 * a path: `mount` asks the user with the folder dialog of the main process,
 * one dialog at a time, and `unmount` takes a mount ID that the main process
 * created.
 */
export function registerRepositoryIpc(
  ipc: IpcRegistry,
  appUrl: string,
  service: Pick<RepositoryService, "list" | "mount" | "unmount" | "onChange">,
  selectFolder: SelectFolder,
  onError: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): void {
  const publisher = createEventPublisher(
    EVENT_CHANNELS.repositoriesChanged,
    appUrl,
  );
  let selecting = false;

  const mount = async (): Promise<MountResult> => {
    if (selecting) {
      return { outcome: "refused", reason: "busy" };
    }
    selecting = true;
    try {
      const folder = await selectFolder();
      if (folder === undefined) {
        return { outcome: "cancelled" };
      }
      return await service.mount(folder);
    } catch (error) {
      onError("Mounting a repository failed.", error);
      return { outcome: "refused", reason: "failed" };
    } finally {
      selecting = false;
    }
  };

  ipc.handle(
    INVOKE_CHANNELS.listRepositories,
    createInvokeHandler(INVOKE_CHANNELS.listRepositories, appUrl, () =>
      service.list(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeRepositories,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeRepositories,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return service.list();
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.mountRepository,
    createInvokeHandler(INVOKE_CHANNELS.mountRepository, appUrl, mount),
  );
  ipc.handle(
    INVOKE_CHANNELS.unmountRepository,
    createInvokeHandler(
      INVOKE_CHANNELS.unmountRepository,
      appUrl,
      (_event, [mountId]) => service.unmount(mountId),
    ),
  );
  service.onChange((list) => {
    try {
      publisher.publish(list);
    } catch (error) {
      onError("Sending the repository list failed.", error);
    }
  });
}
