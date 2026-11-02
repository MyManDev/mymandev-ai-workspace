// The application's data folder: Electron's `userData` path. Chromium keeps
// the single-instance lock and the session data (cookies, caches, and local
// storage) there. The device key (#94) is stored there on macOS and Linux;
// on Windows, where this folder roams, it is stored in the local data folder
// instead (device-key/key-folder.ts).
import { mkdirSync } from "node:fs";
import path, { type PlatformPath } from "node:path";
import { DATA_FOLDER_NAME } from "../shared/product.ts";

/**
 * The part of Electron's `app` that sets the data folder and takes the
 * single-instance lock.
 */
export interface DataFolderHost {
  getPath(name: "appData"): string;
  setPath(name: "userData", path: string): void;
  requestSingleInstanceLock(): boolean;
}

/** Creates a folder and its missing parents, and keeps one that exists. */
export type MakeFolder = (folder: string) => void;

const makeFolderForOwner: MakeFolder = (folder) => {
  // Only the owner may open it, as for the folders that Chromium creates on
  // Linux and macOS. Windows ignores the mode.
  mkdirSync(folder, { recursive: true, mode: 0o700 });
};

/**
 * The data folder inside `appData`, the system's per-user application data
 * folder: `%APPDATA%` on Windows, `~/Library/Application Support` on macOS,
 * and `$XDG_CONFIG_HOME` or `~/.config` on Linux.
 */
export function dataFolderPath(
  appData: string,
  pathApi: PlatformPath = path,
): string {
  return pathApi.join(appData, DATA_FOLDER_NAME);
}

/**
 * Sets the data folder, then takes the single-instance lock. Returns true
 * when this instance holds the lock.
 *
 * Without it, Electron names the folder after the application name, which
 * comes from `package.json` and is `@mymandev/desktop`. The path is set
 * before anything reads it: Chromium keeps the single-instance lock in the
 * data folder, so a lock taken earlier would sit in the other folder, and
 * the sessions read it when the application is ready. Electron's `setPath`
 * expects the folder to exist, so a missing one is created first.
 */
export function claimDataFolder(
  host: DataFolderHost,
  makeFolder: MakeFolder = makeFolderForOwner,
): boolean {
  const folder = dataFolderPath(host.getPath("appData"));
  makeFolder(folder);
  host.setPath("userData", folder);
  return host.requestSingleInstanceLock();
}
