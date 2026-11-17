// Connects the repository link file to Electron: the local data folder that
// `repositoryLinkFolder` chooses from the platform, the environment, and
// Electron's `userData` path (`%LOCALAPPDATA%\MyManDev` on Windows, the data
// folder on macOS and Linux). It stays thin, like claims/system.ts: the
// choice itself is tested in link-store.test.ts. The folder is resolved at
// each read and write, so that a Windows without `LOCALAPPDATA` leaves the
// links unavailable instead of stopping the start; it never falls back to
// the roaming folder.
import { app } from "electron";
import {
  createRepositoryLinkStore,
  type RepositoryLinkStore,
  repositoryLinkFolder,
} from "./link-store.ts";

export function createSystemRepositoryLinkStore(): RepositoryLinkStore {
  return createRepositoryLinkStore({
    folder: () =>
      repositoryLinkFolder({
        platform: process.platform,
        env: process.env,
        userData: app.getPath("userData"),
      }),
    platform: process.platform,
  });
}
