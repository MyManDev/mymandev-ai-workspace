// Connects the sign-in flow to Electron: `net.fetch`, which follows the
// system proxy settings (ADR 0014), `shell.openExternal`, and
// `app.isPackaged`, which decides between the fixed production origin and
// `MYMANDEV_API_ORIGIN`. It stays thin and is not tested directly; the type
// check proves that Electron's APIs fit the flow.
//
// Create the flow after the device key store (device-key/system.ts) and
// after `load`, in the instance that holds the single-instance lock. The
// caller passes the device record store over the key's folder, so that the
// flow and the caller read and write the same record through one store.
import { app, net, shell } from "electron";
import { resolveApiOrigin } from "../api-origin.ts";
import type { DeviceKeyStore } from "../device-key/store.ts";
import type { DeviceRecordStore } from "../device-record.ts";
import { createSignInFlow, type SignInFlow } from "./flow.ts";

export function createSystemSignInFlow(
  keyStore: DeviceKeyStore,
  deviceRecords: DeviceRecordStore,
  onError: (message: string) => void,
): SignInFlow {
  if (!app.isReady()) {
    throw new Error("The sign-in flow needs a ready application.");
  }
  return createSignInFlow({
    apiOrigin: resolveApiOrigin({
      isPackaged: app.isPackaged,
      env: process.env,
    }),
    keyStore,
    deviceRecords,
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
