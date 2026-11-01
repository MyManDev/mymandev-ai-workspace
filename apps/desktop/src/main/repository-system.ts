// Connects the repository service to the system: Node.js's `execFile` and
// `fs.watch`, the file system checks, and the folder dialog options. It
// imports no Electron value, so the integration test can use it.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, watch } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { createGitInspector } from "./git-inspector.ts";
import {
  buildGitEnvironment,
  createGitRunner,
  findGitExecutable,
  type GitRunner,
} from "./git-process.ts";
import {
  createRepositoryService,
  type RepositoryService,
} from "./repositories.ts";
import { watchRepository } from "./repository-watcher.ts";

/** True when `file` is a regular file that this process may execute. */
export async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) {
      return false;
    }
    // Windows has no execute permission; a `.exe` file runs.
    if (process.platform !== "win32") {
      await access(file, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The Git runner of this process: the `git` found in an absolute folder of
 * `PATH`, run with `execFile` and the minimal environment built from
 * `environment`.
 */
export function createSystemGitRunner(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GitRunner {
  return createGitRunner({
    execFile,
    environment: buildGitEnvironment(environment, process.platform),
    locateGit: () =>
      findGitExecutable(environment, process.platform, path, isExecutableFile),
  });
}

export function createSystemRepositoryService(
  onError: (message: string, error: unknown) => void,
): RepositoryService {
  return createRepositoryService({
    inspector: createGitInspector(createSystemGitRunner(), {
      pathApi: path,
      isDirectory,
    }),
    watch: (location, callbacks) =>
      watchRepository(location, callbacks, { watch, pathApi: path }),
    pathApi: path,
    caseInsensitivePaths: process.platform === "win32",
    newMountId: randomUUID,
    onError,
  });
}

/**
 * The options of the folder dialog: one existing folder, no files, no new
 * folder, and no entry in the system's list of recent documents.
 */
export const FOLDER_DIALOG_OPTIONS = Object.freeze({
  title: "Add a repository",
  buttonLabel: "Add",
  properties: Object.freeze(["openDirectory", "dontAddToRecent"] as const),
});

/** The folder of a dialog result, or undefined when it was cancelled. */
export function selectedFolder(result: {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}): string | undefined {
  return result.canceled || result.filePaths.length !== 1
    ? undefined
    : result.filePaths[0];
}
