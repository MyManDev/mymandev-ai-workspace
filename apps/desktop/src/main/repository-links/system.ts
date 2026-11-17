// Connects the repository link file to Electron: the local data folder of
// the device key (`deviceKeyFolder`: `%LOCALAPPDATA%\MyManDev` on Windows,
// the data folder on macOS and Linux) and the platform. It stays thin and is
// not tested directly, like claims/system.ts. The folder is resolved at each
// read and write, so that a Windows without `LOCALAPPDATA` leaves the links
// unavailable instead of stopping the start; it never falls back to the
// roaming folder.
import { app } from "electron";
import { deviceKeyFolder } from "../device-key/key-folder.ts";
import {
  createRepositoryLinkStore,
  type RepositoryLinkStore,
} from "./link-store.ts";

export function createSystemRepositoryLinkStore(): RepositoryLinkStore {
  return createRepositoryLinkStore({
    folder: () =>
      deviceKeyFolder({
        platform: process.platform,
        env: process.env,
        userData: app.getPath("userData"),
      }),
    platform: process.platform,
  });
}
