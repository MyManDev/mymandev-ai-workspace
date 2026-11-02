// Connects the sign-in flow to Electron: `net.fetch`, which follows the
// system proxy settings (ADR 0014), `shell.openExternal`, the key folder,
// and `app.isPackaged`, which decides between the fixed production origin
// and `MYMANDEV_API_ORIGIN`. It stays thin and is not tested directly; the
// type check proves that Electron's APIs fit the flow.
//
// Create the flow after the device key store (device-key/system.ts) and
// after `load`, in the instance that holds the single-instance lock.
import { app, net, shell } from "electron";
import { resolveApiOrigin } from "../api-origin.ts";
import { deviceKeyFolder } from "../device-key/key-folder.ts";
import type { DeviceKeyStore } from "../device-key/store.ts";
import { createDeviceRecordStore } from "../device-record.ts";
import { createSignInFlow, type SignInFlow } from "./flow.ts";

export function createSystemSignInFlow(
  keyStore: DeviceKeyStore,
  onError: (message: string) => void,
): SignInFlow {
  if (!app.isReady()) {
    throw new Error("The sign-in flow needs a ready application.");
  }
  const folder = deviceKeyFolder({
    platform: process.platform,
    env: process.env,
    userData: app.getPath("userData"),
  });
  return createSignInFlow({
    apiOrigin: resolveApiOrigin({
      isPackaged: app.isPackaged,
      env: process.env,
    }),
    keyStore,
    deviceRecords: createDeviceRecordStore({
      folder,
      platform: process.platform,
    }),
    openExternal: async (url) => {
      try {
        await shell.openExternal(url);
        return true;
      } catch {
        return false;
      }
    },
    fetch: (url, init) => net.fetch(url, init),
    platform: process.platform,
    onError,
  });
}
