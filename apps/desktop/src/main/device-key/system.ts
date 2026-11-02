// Connects the device key store to Electron: `safeStorage`, the data folder,
// the environment, and the platform. It stays thin and is not tested
// directly; the type check proves that Electron's `safeStorage` provides
// the asynchronous API that the store uses.
//
// Create the store only in the instance that holds the single-instance lock
// (index.ts), so two instances never share one key, and only after the
// application is ready: on Linux, `safeStorage` reports its backend only
// then. Await `load` before any connection to the API opens (ADR 0014).
import { app, safeStorage } from "electron";
import { deviceKeyFolder } from "./key-folder.ts";
import { createDeviceKeyStore, type DeviceKeyStore } from "./store.ts";

export function createSystemDeviceKeyStore(
  onError: (message: string, error: unknown) => void,
): DeviceKeyStore {
  if (!app.isReady()) {
    throw new Error("The device key store needs a ready application.");
  }
  return createDeviceKeyStore({
    folder: deviceKeyFolder({
      platform: process.platform,
      env: process.env,
      userData: app.getPath("userData"),
    }),
    platform: process.platform,
    systemProtection: safeStorage,
    onError,
  });
}
