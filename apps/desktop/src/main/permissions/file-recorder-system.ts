// Connects the enforcement record files to Electron: the
// `enforcement-records` folder of the data folder (`userData`, which
// `claimDataFolder` sets first, in index.ts) and the platform. It stays
// thin, like claims/system.ts; `enforcement-wiring.test.ts` guards it.
// The folder is resolved here, once: Electron's `userData` path is set
// before `start()` runs and does not change afterwards.
import { app } from "electron";
import path from "node:path";
import {
  createFileEnforcementRecorder,
  ENFORCEMENT_RECORD_FOLDER,
  type FileEnforcementRecorder,
} from "./file-recorder.ts";

export function createSystemEnforcementRecorder(
  log: (message: string) => void,
): FileEnforcementRecorder {
  return createFileEnforcementRecorder({
    folder: path.join(app.getPath("userData"), ENFORCEMENT_RECORD_FOLDER),
    platform: process.platform,
    log,
  });
}
