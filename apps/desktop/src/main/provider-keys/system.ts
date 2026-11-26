// Connects the provider key store to Electron: `safeStorage`, the device
// key's local data folder (`deviceKeyFolder`), the environment, and the
// platform. It stays thin, like permissions/file-recorder-system.ts and
// repository-links/system.ts, and is not tested directly; the type check
// proves that Electron's `safeStorage` provides the asynchronous API that
// the store uses. The folder is resolved at each operation, so that a
// Windows without `LOCALAPPDATA` fails each operation (`folder_unavailable`)
// instead of stopping the start; it never falls back to the roaming folder.
// `safeStorage` is used only after the application is ready: the store is
// called from the account's and the provider connections' work, which
// starts then.
import { app, safeStorage } from "electron";
import { deviceKeyFolder } from "../device-key/key-folder.ts";
import { createProviderKeyStore, type ProviderKeyStore } from "./store.ts";

export function createSystemProviderKeyStore(
  onError: (message: string, error: unknown) => void,
): ProviderKeyStore {
  return createProviderKeyStore({
    folder: () =>
      deviceKeyFolder({
        platform: process.platform,
        env: process.env,
        userData: app.getPath("userData"),
      }),
    platform: process.platform,
    systemProtection: safeStorage,
    onError,
  });
}
