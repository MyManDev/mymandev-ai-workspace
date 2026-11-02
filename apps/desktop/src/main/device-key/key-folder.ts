// Where the device key is stored: in the application's local data folder,
// which a roaming profile never copies to another machine (ADR 0014,
// "Storage and transport on the device").
import path, { type PlatformPath } from "node:path";
import { LOCAL_DATA_FOLDER_NAME } from "../../shared/product.ts";
import { DeviceKeyError } from "./errors.ts";

export interface DeviceKeyFolderOptions {
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** `process.env`; only `LOCALAPPDATA` is read, and only on Windows. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Electron's `userData` path, the data folder that `data-folder.ts` sets. */
  readonly userData: string;
}

/**
 * The folder that holds the device key.
 *
 * - Windows: `%LOCALAPPDATA%\MyManDev`. The data folder there is
 *   `%APPDATA%\MyManDev`, which a roaming profile copies to every machine
 *   the person signs in to; `%LOCALAPPDATA%` stays on this machine. Throws a
 *   `DeviceKeyError` (`local_data_folder_missing`) when `LOCALAPPDATA` is
 *   not set to an absolute folder: a relative one would follow the working
 *   folder, and falling back to the roaming folder would copy the key.
 * - macOS and Linux: the data folder (`userData`), which does not roam.
 */
export function deviceKeyFolder(options: DeviceKeyFolderOptions): string {
  if (options.platform !== "win32") {
    return options.userData;
  }
  return localDataFolder(options.env["LOCALAPPDATA"], path.win32);
}

function localDataFolder(
  localAppData: string | undefined,
  pathApi: PlatformPath,
): string {
  if (
    localAppData === undefined ||
    localAppData === "" ||
    !pathApi.isAbsolute(localAppData) ||
    // `C:` alone, or `\folder` without a drive, depends on the current drive
    // or folder.
    pathApi.parse(localAppData).root.length < 3
  ) {
    throw new DeviceKeyError("local_data_folder_missing");
  }
  return pathApi.join(localAppData, LOCAL_DATA_FOLDER_NAME);
}
