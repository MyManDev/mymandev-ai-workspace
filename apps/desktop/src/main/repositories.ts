// The repositories mounted on this device, in the main process. A mount is
// read-only: the service reads the repository with Git and watches its
// files, and nothing it does writes to the folder. Mounts live in memory
// only; they are not stored and are gone after a restart.
import type { PlatformPath } from "node:path";
import {
  REPOSITORY_LIMITS,
  type MountedRepository,
  type MountResult,
  type RepositoryList,
  type RepositoryState,
} from "../shared/ipc-contract.ts";
import {
  displayText,
  type GitInspector,
  type RepositoryLocation,
} from "./git-inspector.ts";
import type {
  RepositoryWatch,
  RepositoryWatchCallbacks,
} from "./repository-watcher.ts";

export type WatchRepositoryFunction = (
  location: RepositoryLocation,
  callbacks: RepositoryWatchCallbacks,
) => RepositoryWatch | undefined;

/** The timer functions the service uses, so tests can drive them. */
export interface Timers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const SYSTEM_TIMERS: Timers = Object.freeze({
  setTimeout: (callback: () => void, milliseconds: number) =>
    setTimeout(callback, milliseconds),
  clearTimeout: (handle: unknown) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
});

export interface RepositoryServiceOptions {
  readonly inspector: GitInspector;
  readonly watch: WatchRepositoryFunction;
  readonly pathApi: PlatformPath;
  /** True where two paths that differ only in case are the same folder (Windows). */
  readonly caseInsensitivePaths: boolean;
  readonly newMountId: () => string;
  readonly timers?: Timers;
  /** A file change refreshes the status after this many quiet milliseconds... */
  readonly quietMs?: number;
  /** ...or at the latest this many milliseconds after the first change. */
  readonly maxWaitMs?: number;
  readonly onError?: (message: string, error: unknown) => void;
}

export interface RepositoryService {
  /** The mounted repositories, in the order they were mounted. */
  list(): RepositoryList;
  /**
   * Mounts the repository whose top-level folder is `folder`, an absolute
   * path from the folder dialog. Never rejects.
   */
  mount(folder: string): Promise<MountResult>;
  /** Unmounts a repository and stops watching it. False when it was not mounted. */
  unmount(mountId: string): boolean;
  /** Calls `listener` with the list after every change. Returns a function that removes it. */
  onChange(listener: (list: RepositoryList) => void): () => void;
  /** Stops every watcher and cancels every running Git command, for the application's quit. */
  close(): void;
}

interface Mount {
  readonly id: string;
  readonly location: RepositoryLocation;
  /** The top-level folder compared for duplicates. */
  readonly key: string;
  readonly name: string;
  readonly path: string;
  readonly controller: AbortController;
  state: RepositoryState;
  watch: RepositoryWatch | undefined;
  refreshing: boolean;
  refreshAgain: boolean;
  timer: unknown;
  firstChangeAt: number | undefined;
}

export function createRepositoryService(
  options: RepositoryServiceOptions,
): RepositoryService {
  const {
    inspector,
    pathApi,
    timers = SYSTEM_TIMERS,
    quietMs = 300,
    maxWaitMs = 2_000,
    onError = () => undefined,
  } = options;
  const mounts = new Map<string, Mount>();
  const listeners = new Set<(list: RepositoryList) => void>();
  const closing = new AbortController();
  let revision = 0;

  const snapshot = (mount: Mount): MountedRepository => ({
    mountId: mount.id,
    name: mount.name,
    path: mount.path,
    watching: mount.watch !== undefined,
    state: mount.state,
  });

  const list = (): RepositoryList => ({
    revision,
    repositories: [...mounts.values()].map(snapshot),
  });

  const publish = () => {
    revision += 1;
    const current = list();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        onError("A repository list listener failed.", error);
      }
    }
  };

  const isMounted = (mount: Mount) => mounts.get(mount.id) === mount;

  const stopWatching = (mount: Mount) => {
    if (mount.timer !== undefined) {
      timers.clearTimeout(mount.timer);
      mount.timer = undefined;
    }
    mount.watch?.close();
    mount.watch = undefined;
  };

  const refresh = async (mount: Mount): Promise<void> => {
    if (mount.refreshing) {
      // A change during a refresh refreshes once more afterwards.
      mount.refreshAgain = true;
      return;
    }
    mount.refreshing = true;
    try {
      do {
        mount.refreshAgain = false;
        let state: RepositoryState;
        try {
          state = await inspector.inspect(
            mount.location,
            mount.controller.signal,
          );
        } catch (error) {
          onError("Reading a repository failed.", error);
          state = { kind: "unavailable", problem: "failed" };
        }
        if (!isMounted(mount)) {
          return;
        }
        if (JSON.stringify(state) !== JSON.stringify(mount.state)) {
          mount.state = state;
          publish();
        }
      } while (mount.refreshAgain && isMounted(mount));
    } finally {
      mount.refreshing = false;
    }
  };

  const scheduleRefresh = (mount: Mount) => {
    if (!isMounted(mount)) {
      return;
    }
    const now = timers.now();
    mount.firstChangeAt ??= now;
    if (mount.timer !== undefined) {
      timers.clearTimeout(mount.timer);
    }
    // Waits for `quietMs` without changes, but never longer than
    // `maxWaitMs` after the first one, so a busy folder still refreshes.
    const delay = Math.max(
      0,
      Math.min(quietMs, mount.firstChangeAt + maxWaitMs - now),
    );
    mount.timer = timers.setTimeout(() => {
      mount.timer = undefined;
      mount.firstChangeAt = undefined;
      void refresh(mount);
    }, delay);
  };

  const pathKey = (path: string) =>
    options.caseInsensitivePaths ? path.toLowerCase() : path;

  const mount = async (folder: string): Promise<MountResult> => {
    if (closing.signal.aborted) {
      return { outcome: "refused", reason: "failed" };
    }
    if (
      typeof folder !== "string" ||
      folder.length > REPOSITORY_LIMITS.path ||
      folder.includes("\0") ||
      !pathApi.isAbsolute(folder)
    ) {
      return { outcome: "refused", reason: "unsupported-path" };
    }
    if (mounts.size >= REPOSITORY_LIMITS.mounted) {
      return { outcome: "refused", reason: "limit" };
    }
    let located;
    try {
      located = await inspector.locate(folder, closing.signal);
    } catch (error) {
      onError("Locating a repository failed.", error);
      return { outcome: "refused", reason: "failed" };
    }
    if (located.kind === "refused") {
      return { outcome: "refused", reason: located.reason };
    }
    const { location } = located;
    if (location.topLevel.length > REPOSITORY_LIMITS.path) {
      return { outcome: "refused", reason: "unsupported-path" };
    }
    // Checked again: another mount may have finished meanwhile.
    if (closing.signal.aborted) {
      return { outcome: "refused", reason: "failed" };
    }
    const key = pathKey(location.topLevel);
    for (const existing of mounts.values()) {
      if (existing.key === key) {
        return { outcome: "refused", reason: "already-mounted" };
      }
    }
    if (mounts.size >= REPOSITORY_LIMITS.mounted) {
      return { outcome: "refused", reason: "limit" };
    }

    const controller = new AbortController();
    const entry: Mount = {
      id: options.newMountId(),
      location,
      key,
      name: displayText(
        pathApi.basename(location.topLevel) || location.topLevel,
        REPOSITORY_LIMITS.name,
      ),
      path: displayText(location.topLevel, REPOSITORY_LIMITS.path),
      controller,
      state: { kind: "loading" },
      watch: undefined,
      refreshing: false,
      refreshAgain: false,
      timer: undefined,
      firstChangeAt: undefined,
    };
    mounts.set(entry.id, entry);
    try {
      entry.watch = options.watch(location, {
        onChange: () => scheduleRefresh(entry),
        onError: (error) => {
          onError("Watching a repository failed.", error);
          if (!isMounted(entry)) {
            return;
          }
          stopWatching(entry);
          publish();
          // The folder may be gone; the next status says so.
          void refresh(entry);
        },
      });
    } catch (error) {
      onError("Watching a repository failed.", error);
      entry.watch = undefined;
    }
    publish();
    void refresh(entry);
    return { outcome: "mounted", mountId: entry.id };
  };

  const unmount = (mountId: string): boolean => {
    const entry = mounts.get(mountId);
    if (entry === undefined) {
      return false;
    }
    mounts.delete(mountId);
    stopWatching(entry);
    entry.controller.abort();
    publish();
    return true;
  };

  const onChange = (listener: (list: RepositoryList) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const close = () => {
    closing.abort();
    for (const entry of mounts.values()) {
      stopWatching(entry);
      entry.controller.abort();
    }
    mounts.clear();
    listeners.clear();
  };

  return Object.freeze({ list, mount, unmount, onChange, close });
}
