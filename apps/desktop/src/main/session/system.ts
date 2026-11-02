// Connects the device session to Electron: `net.fetch`, which follows the
// system proxy settings (ADR 0014), the key folder, and `app.isPackaged`,
// which decides between the fixed production origin and
// `MYMANDEV_API_ORIGIN`. It stays thin and is not tested directly; the type
// check proves that Electron's APIs fit the session.
//
// Create the session after the device key store (device-key/system.ts) and
// after `load`, in the instance that holds the single-instance lock, then
// call `refresh`.
import { app, net } from "electron";
import { resolveApiOrigin } from "../api-origin.ts";
import { deviceKeyFolder } from "../device-key/key-folder.ts";
import type { DeviceKeyStore } from "../device-key/store.ts";
import { createDeviceRecordStore } from "../device-record.ts";
import { createDeviceSession, type DeviceSession } from "./session.ts";
import { createSignOutMarkerStore } from "./sign-out-marker.ts";

export function createSystemDeviceSession(
  keyStore: DeviceKeyStore,
  onError: (message: string) => void,
): DeviceSession {
  if (!app.isReady()) {
    throw new Error("The device session needs a ready application.");
  }
  const folder = deviceKeyFolder({
    platform: process.platform,
    env: process.env,
    userData: app.getPath("userData"),
  });
  return createDeviceSession({
    apiOrigin: resolveApiOrigin({
      isPackaged: app.isPackaged,
      env: process.env,
    }),
    keyStore,
    deviceRecords: createDeviceRecordStore({
      folder,
      platform: process.platform,
    }),
    signOutMarkers: createSignOutMarkerStore({
      folder,
      platform: process.platform,
    }),
    fetch: (url, init) => net.fetch(url, init),
    onError,
  });
}
