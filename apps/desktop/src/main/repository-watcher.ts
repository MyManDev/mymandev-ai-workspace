// Watches a mounted repository with `fs.watch` (ADR 0016) and reports
// changes that can change its Git status. The watcher only reads; the
// repository service debounces the reports and refreshes the status.
import type { PlatformPath } from "node:path";
import type { RepositoryLocation } from "./git-inspector.ts";

/** The part of Node.js's `fs.FSWatcher` that the watcher uses. */
export interface FileWatcher {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface WatchOptions {
  readonly recursive: boolean;
  /** False, so a watcher never keeps the process alive. */
  readonly persistent: false;
  readonly encoding: "utf8";
}

/** The part of Node.js's `fs.watch` that the watcher uses. */
export type WatchFunction = (
  path: string,
  options: WatchOptions,
  listener: (eventType: string, filename: string | null) => void,
) => FileWatcher;

export interface RepositoryWatchCallbacks {
  /** A change that can change the status. Called once per file event. */
  readonly onChange: () => void;
  /** The watcher of the working tree failed and was closed. */
  readonly onError: (error: unknown) => void;
}

export interface RepositoryWatch {
  /** True when the whole working tree is watched, false for its top-level folder only. */
  readonly recursive: boolean;
  /** Stops every watcher. Calling it again does nothing. */
  close(): void;
}

/**
 * Folders and files of a Git directory whose changes never change the
 * status: the object store, the reflogs, and lock files, which Git writes
 * before it renames them to their final name.
 */
const IGNORED_GIT_FOLDERS = new Set(["objects", "logs"]);

/** The parts of a relative path, split at "/" and, on Windows, also at "\\". */
function segments(relativePath: string, pathApi: PlatformPath): string[] {
  const separator = pathApi.sep === "\\" ? /[\\/]/ : /\//;
  return relativePath.split(separator).filter((part) => part !== "");
}

/**
 * `folder` relative to `parent`, or undefined when it is not inside it, for
 * example the Git directory of a linked worktree or a submodule, which is
 * outside the working tree.
 */
export function relativeInside(
  parent: string,
  folder: string,
  pathApi: PlatformPath,
): string | undefined {
  const relative = pathApi.relative(parent, folder);
  if (
    relative === "" ||
    pathApi.isAbsolute(relative) ||
    segments(relative, pathApi)[0] === ".."
  ) {
    return undefined;
  }
  return relative;
}

/**
 * True when a change inside a Git directory, given as the parts of its path
 * relative to that directory, can change the status.
 */
export function isRelevantGitChange(parts: readonly string[]): boolean {
  const [first] = parts;
  const last = parts.at(-1);
  if (first !== undefined && IGNORED_GIT_FOLDERS.has(first)) {
    return false;
  }
  return last === undefined || !last.endsWith(".lock");
}

/**
 * True when the file event `filename`, relative to the top-level folder, can
 * change the status: every change in the working tree, and in the Git
 * directory a change of HEAD, the index, a ref, or the like, but not of the
 * object store, the reflogs, or a lock file. An event without a name counts.
 */
export function isRelevantChange(
  filename: string | null,
  gitDirRelative: string | undefined,
  pathApi: PlatformPath,
): boolean {
  if (filename === null) {
    return true;
  }
  const parts = segments(filename, pathApi);
  if (gitDirRelative === undefined) {
    return true;
  }
  const gitParts = segments(gitDirRelative, pathApi);
  const inGitDir = gitParts.every((part, index) => parts[index] === part);
  return !inGitDir || isRelevantGitChange(parts.slice(gitParts.length));
}

export interface RepositoryWatcherOptions {
  readonly watch: WatchFunction;
  readonly pathApi: PlatformPath;
}

/**
 * Watches the working tree of `location`, recursively where `fs.watch`
 * supports it (macOS, Windows, and Linux with Node.js 20 or later), else its
 * top-level folder only. A Git directory outside the working tree (a linked
 * worktree, a submodule) and the common Git directory are watched without
 * their subfolders, which covers HEAD, the index, and packed refs. Returns
 * undefined when the working tree cannot be watched at all.
 */
export function watchRepository(
  location: RepositoryLocation,
  callbacks: RepositoryWatchCallbacks,
  options: RepositoryWatcherOptions,
): RepositoryWatch | undefined {
  const { watch, pathApi } = options;
  const watchers: FileWatcher[] = [];
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    for (const watcher of watchers.splice(0)) {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    }
  };
  const report = () => {
    if (!closed) {
      callbacks.onChange();
    }
  };

  const insideGitDir = relativeInside(
    location.topLevel,
    location.gitDir,
    pathApi,
  );
  const onWorkTreeEvent = (_eventType: string, filename: string | null) => {
    if (isRelevantChange(filename, insideGitDir, pathApi)) {
      report();
    }
  };

  let recursive = true;
  let workTree: FileWatcher | undefined;
  for (const attempt of [true, false]) {
    try {
      workTree = watch(
        location.topLevel,
        { recursive: attempt, persistent: false, encoding: "utf8" },
        onWorkTreeEvent,
      );
      recursive = attempt;
      break;
    } catch {
      // Recursive watching is not available, or the system is out of
      // watches; try the top-level folder alone.
    }
  }
  if (workTree === undefined) {
    return undefined;
  }
  workTree.on("error", (error) => {
    close();
    callbacks.onError(error);
  });
  watchers.push(workTree);

  // Git directories outside the working tree, without their subfolders.
  const extraFolders = new Set<string>();
  for (const folder of [location.gitDir, location.commonDir]) {
    if (relativeInside(location.topLevel, folder, pathApi) === undefined) {
      extraFolders.add(folder);
    }
  }
  for (const folder of extraFolders) {
    try {
      const watcher = watch(
        folder,
        { recursive: false, persistent: false, encoding: "utf8" },
        (_eventType, filename) => {
          if (
            filename === null ||
            isRelevantGitChange(segments(filename, pathApi))
          ) {
            report();
          }
        },
      );
      // The working tree watcher still reports; this one just stops.
      watcher.on("error", () => {
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
      });
      watchers.push(watcher);
    } catch {
      // Best effort: the working tree is still watched.
    }
  }

  return Object.freeze({ recursive, close });
}
