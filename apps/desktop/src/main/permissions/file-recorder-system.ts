// Connects the enforcement record files to Electron: the
// `enforcement-records` folder of the local data folder that
// `deviceKeyFolder` chooses for the device key and the repository links
// (Project Manager decision of 2026-11-25): `%LOCALAPPDATA%\MyManDev` on
// Windows, which a roaming profile never copies, and the data folder
// (`userData`, which `claimDataFolder` sets first, in index.ts) on macOS
// and Linux, which does not roam. It stays thin, like
// repository-links/system.ts, and `enforcement-wiring.test.ts` guards it.
// As there, the folder is resolved whenever a file is opened, so that a
// Windows without `LOCALAPPDATA` fails each record (`folder_unavailable`)
// instead of stopping the start; it never falls back to the roaming folder.
import { app } from "electron";
import path from "node:path";
import { deviceKeyFolder } from "../device-key/key-folder.ts";
import {
  createFileEnforcementRecorder,
  ENFORCEMENT_RECORD_FOLDER,
  type FileEnforcementRecorder,
} from "./file-recorder.ts";

export function createSystemEnforcementRecorder(
  log: (message: string) => void,
): FileEnforcementRecorder {
  return createFileEnforcementRecorder({
    folder: () =>
      path.join(
        deviceKeyFolder({
          platform: process.platform,
          env: process.env,
          userData: app.getPath("userData"),
        }),
        ENFORCEMENT_RECORD_FOLDER,
      ),
    platform: process.platform,
    log,
  });
}
