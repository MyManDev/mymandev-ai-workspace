// Connects the seen claims file to Electron: the data folder (`userData`,
// which `claimDataFolder` sets first, in index.ts) and the platform. It
// stays thin and is not tested directly, like device-key/system.ts.
import { app } from "electron";
import { type ClaimSeenStore, createClaimSeenStore } from "./seen-store.ts";

export function createSystemClaimSeenStore(): ClaimSeenStore {
  return createClaimSeenStore({
    folder: app.getPath("userData"),
    platform: process.platform,
  });
}
