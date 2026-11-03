import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../shared/ipc-channels.ts";
import type { AccountService } from "./account.ts";
import {
  createEventPublisher,
  createInvokeHandler,
  type IpcRegistry,
} from "./ipc.ts";

/**
 * Registers the handlers of the account channels and sends each change of
 * the account status to the frames that subscribed. Every handler checks the
 * sender and the arguments first (`createInvokeHandler`) and answers with a
 * value parsed by the contract, so only the narrow status, fixed codes,
 * and the device list reach the renderer (ADR 0014). Only
 * `unlockDeviceKey` takes an argument, the
 * passphrase, which goes to the key store and is never sent back or logged.
 * Call it before the first window loads.
 */
export function registerAccountIpc(
  ipc: IpcRegistry,
  appUrl: string,
  service: Pick<
    AccountService,
    | "status"
    | "onStatusChange"
    | "startSignIn"
    | "cancelSignIn"
    | "unlockDeviceKey"
    | "forgetAccount"
    | "signOut"
    | "removeDevice"
    | "listDevices"
  >,
  onError: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): void {
  const publisher = createEventPublisher(
    EVENT_CHANNELS.accountStatusChanged,
    appUrl,
  );

  ipc.handle(
    INVOKE_CHANNELS.getAccountStatus,
    createInvokeHandler(INVOKE_CHANNELS.getAccountStatus, appUrl, () =>
      service.status(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.subscribeAccountStatus,
    createInvokeHandler(
      INVOKE_CHANNELS.subscribeAccountStatus,
      appUrl,
      (event) => {
        publisher.add(event.sender);
        return service.status();
      },
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.startSignIn,
    createInvokeHandler(INVOKE_CHANNELS.startSignIn, appUrl, () =>
      service.startSignIn(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.cancelSignIn,
    createInvokeHandler(INVOKE_CHANNELS.cancelSignIn, appUrl, () =>
      service.cancelSignIn(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.unlockDeviceKey,
    createInvokeHandler(
      INVOKE_CHANNELS.unlockDeviceKey,
      appUrl,
      (_event, [passphrase]) => service.unlockDeviceKey(passphrase),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.forgetAccount,
    createInvokeHandler(INVOKE_CHANNELS.forgetAccount, appUrl, () =>
      service.forgetAccount(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.signOut,
    createInvokeHandler(INVOKE_CHANNELS.signOut, appUrl, () =>
      service.signOut(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.removeDevice,
    createInvokeHandler(INVOKE_CHANNELS.removeDevice, appUrl, () =>
      service.removeDevice(),
    ),
  );
  ipc.handle(
    INVOKE_CHANNELS.listDevices,
    createInvokeHandler(INVOKE_CHANNELS.listDevices, appUrl, () =>
      service.listDevices(),
    ),
  );
  service.onStatusChange((status) => {
    try {
      publisher.publish(status);
    } catch (error) {
      onError("Sending the account status failed.", error);
    }
  });
}
