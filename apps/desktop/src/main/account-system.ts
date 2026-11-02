// Connects the account service to Electron: the device key store
// (device-key/system.ts), the device record in the key's folder, the
// sign-in flow (sign-in/system.ts), and the API origin of this build. It
// stays thin and is not tested directly; the type check proves that the
// parts fit the service.
//
// Create the service in the instance that holds the single-instance lock
// (index.ts); `initialize` opens the key store, so call it only after the
// application is ready.
import { app } from "electron";
import { createAccountService, type AccountService } from "./account.ts";
import { resolveApiOrigin } from "./api-origin.ts";
import { deviceKeyFolder } from "./device-key/key-folder.ts";
import { createSystemDeviceKeyStore } from "./device-key/system.ts";
import { createDeviceRecordStore } from "./device-record.ts";
import { createSystemSignInFlow } from "./sign-in/system.ts";

export interface SystemAccountOptions {
  /** Brings the main window to the front after a valid callback. */
  readonly focusWindow: () => void;
  /** Receives fixed messages; the key store's errors hold no secret. */
  readonly onError: (message: string, error?: unknown) => void;
}

export function createSystemAccountService(
  options: SystemAccountOptions,
): AccountService {
  return createAccountService({
    apiOrigin: resolveApiOrigin({
      isPackaged: app.isPackaged,
      env: process.env,
    }),
    openSystem: () => {
      const keyStore = createSystemDeviceKeyStore(options.onError);
      return {
        keyStore,
        // The flow keeps its own record store over the same file.
        deviceRecords: createDeviceRecordStore({
          folder: deviceKeyFolder({
            platform: process.platform,
            env: process.env,
            userData: app.getPath("userData"),
          }),
          platform: process.platform,
        }),
        createFlow: () =>
          createSystemSignInFlow(keyStore, (message) =>
            options.onError(message),
          ),
      };
    },
    focusWindow: options.focusWindow,
    onError: (message) => options.onError(message),
  });
}
