// Removing the device deletes every provider key file, as it deletes the
// device key (#33, D4 of 2026-11-25). Every place that ends this device's
// identity deletes the device key through the key store's `delete`: a
// removal that the API confirmed, `device_revoked`, "This is not me", a
// lost key, and a sign-in that registers a new device instead of this one.
// A provider key file is bound to the device ID, so after any of them no
// later device could open it anyway. A sign-out never calls `delete`, so it
// keeps the provider keys.
import type { DeviceKeyStore } from "../device-key/store.ts";
import type { ProviderKeyStore } from "./store.ts";

/**
 * `keyStore` with a `delete` that deletes the device key first and then
 * every provider key file. When the device key cannot be deleted, the
 * error is thrown as before and the provider keys stay, because the device
 * stays. When a provider key file cannot be deleted, `report` receives a
 * fixed message and the deletion of the device key still counts: the file
 * is bound to a device that no longer exists, so it is refused on read.
 */
export function deletingProviderKeys<S extends Pick<DeviceKeyStore, "delete">>(
  keyStore: S,
  providerKeys: Pick<ProviderKeyStore, "removeAll">,
  report: (message: string) => void,
): S {
  return Object.freeze({
    ...keyStore,
    delete: async () => {
      await keyStore.delete();
      try {
        await providerKeys.removeAll();
      } catch {
        try {
          report("The provider keys could not be deleted with the device key.");
        } catch {
          // A failing report changes nothing.
        }
      }
    },
  });
}
