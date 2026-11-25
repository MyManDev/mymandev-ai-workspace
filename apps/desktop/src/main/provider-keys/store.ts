// The provider key store of the main process (#33; the Project Manager's
// decisions D2 to D4 of 2026-11-25). It keeps one API key for each provider
// connection of this device, each encrypted with Electron's `safeStorage`
// in its own file of the `provider-keys` folder of the device key's local
// data folder (`deviceKeyFolder`), which never roams.
//
// - Only the system protects a key. On Windows and macOS `safeStorage` must
//   report that it can encrypt. On Linux and elsewhere a secret service must
//   be confirmed too, as for the device key: the backend must be one of
//   `CONFIRMED_LINUX_BACKENDS` (never `basic_text` or `unknown`), and the
//   ciphertext must start with `SECRET_SERVICE_CIPHERTEXT_PREFIX`. Without
//   it no key is stored (fail closed); there is no passphrase and no
//   unprotected file for a provider key.
// - The key is bound to the device ID and the connection ID inside the
//   encrypted payload (key-file.ts); a reader that asks for another device
//   or another connection is refused (`bound_elsewhere`).
// - The plaintext is never cached. `check` decrypts and drops it; `read`
//   decrypts and hands it to its caller, the adapter that starts a run, which
//   holds it for that run only.
// - Writes are atomic, as the device key's (atomic-file.ts): a temporary
//   file, flushed and renamed over the key file, mode 0600 on Linux and
//   macOS, in a folder for its owner only. A failed write leaves the
//   previous key file as it was and no temporary file.
//
// Nothing here logs, and nothing here is reachable from the renderer. Every
// error is a `ProviderKeyError` with a fixed message and no `cause`.
import path from "node:path";
import {
  isMissingFileError,
  isTemporaryFileOf,
  KEY_FOLDER_MODE,
  type KeyFileSystem,
  nodeKeyFileSystem,
  removeFile,
  syncFolder,
  writeFileAtomic,
} from "../device-key/atomic-file.ts";
import {
  CONFIRMED_LINUX_BACKENDS,
  SECRET_SERVICE_CIPHERTEXT_PREFIX,
  type SystemKeyProtection,
} from "../device-key/store.ts";
import { ProviderKeyError } from "./errors.ts";
import {
  checkBinding,
  checkConnectionId,
  connectionOfFileName,
  decodeProviderKeyFile,
  encodeProviderKeyFile,
  encodeProviderKeyPayload,
  isProviderKeyShape,
  openProviderKeyPayload,
  type ProviderKeyBinding,
  providerKeyFileName,
} from "./key-file.ts";

/** The folder of the key files, inside the device key's local data folder. */
export const PROVIDER_KEY_FOLDER = "provider-keys";

/** Whether the system can protect a new provider key. */
export type ProviderKeyProtectionStatus =
  | { readonly available: true }
  | {
      readonly available: false;
      /**
       * `encryption_unavailable`: `isAsyncEncryptionAvailable` resolved
       * false. `no_secret_service`: Linux selected `basic_text`.
       * `secret_service_unconfirmed`: Linux reported `unknown` or another
       * backend that is not a secret service.
       */
      readonly reason:
        | "encryption_unavailable"
        | "no_secret_service"
        | "secret_service_unconfirmed";
    };

/** What a check of a connection's key found. */
export type ProviderKeyCheck = "ready" | "missing";

export interface ProviderKeyStore {
  /** Whether the system can protect a new key now. */
  readonly protection: () => Promise<ProviderKeyProtectionStatus>;
  /**
   * Encrypts `key`, bound to the binding's device and connection, and
   * writes it atomically over the connection's key file. Rejects with
   * `invalid_binding`, `invalid_key`, `system_protection_unavailable`,
   * `folder_unavailable`, or `write_failed`; the previous file then stays.
   */
  readonly save: (binding: ProviderKeyBinding, key: string) => Promise<void>;
  /**
   * `ready` when the connection's key file exists and decrypts for this
   * binding, `missing` without a file. The plaintext is dropped at once.
   * Rejects with `invalid_binding`, `folder_unavailable`, `read_failed`,
   * `corrupt`, `newer_format`, `unreadable`, or `bound_elsewhere`.
   */
  readonly check: (binding: ProviderKeyBinding) => Promise<ProviderKeyCheck>;
  /**
   * Decrypts the connection's key on demand, for the main process only:
   * the adapter that starts a run calls it at the start and holds the key
   * for that run only (#30, #31). Nothing caches it. Rejects as `check`,
   * and with `missing` without a file.
   */
  readonly read: (binding: ProviderKeyBinding) => Promise<string>;
  /**
   * Deletes the connection's key file and its temporary files; a missing
   * file is not an error. Rejects with `invalid_binding`,
   * `folder_unavailable`, or `delete_failed`.
   */
  readonly remove: (providerConnectionId: string) => Promise<void>;
  /**
   * Deletes every key file and temporary file of the folder, with the
   * device key. Other names are left alone. Rejects with
   * `folder_unavailable` or `delete_failed` after it tried every file.
   */
  readonly removeAll: () => Promise<void>;
}

export interface ProviderKeyStoreOptions {
  /**
   * The device key's local data folder (`deviceKeyFolder`), resolved at
   * each operation; it may throw, for example on a Windows without
   * `LOCALAPPDATA`, and the operation then fails with `folder_unavailable`.
   */
  readonly folder: () => string;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Electron's `safeStorage`, its asynchronous API only. */
  readonly systemProtection: SystemKeyProtection;
  /** Defaults to `node:fs/promises`. */
  readonly fileSystem?: KeyFileSystem;
  /**
   * Receives an error that does not stop the operation: a failed rewrite
   * after `shouldReEncrypt`, after which the old file is kept. The error is
   * a `ProviderKeyError` and holds no key. An error that it throws is
   * ignored.
   */
  readonly onError?: (message: string, error: unknown) => void;
}

const secretServicePrefix = Buffer.from(
  SECRET_SERVICE_CIPHERTEXT_PREFIX,
  "ascii",
);

/** Whether a temporary file name belongs to a key file of `folder`. */
function isKeyTemporaryFile(name: string): boolean {
  // `<connection ID>.json.<16 hexadecimal characters>.tmp`
  const target = name.slice(0, -".0123456789abcdef.tmp".length);
  return (
    connectionOfFileName(target) !== null && isTemporaryFileOf(name, target)
  );
}

export function createProviderKeyStore(
  options: ProviderKeyStoreOptions,
): ProviderKeyStore {
  const {
    platform,
    systemProtection: safeStorage,
    fileSystem = nodeKeyFileSystem,
    onError = () => undefined,
  } = options;
  const systemAlwaysProtects = platform === "win32" || platform === "darwin";

  // Every operation runs after the one before it has settled, so a removal
  // never races a write of the same file.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }

  function keyFolder(): string {
    let folder: string;
    try {
      folder = options.folder();
    } catch {
      throw new ProviderKeyError("folder_unavailable");
    }
    if (typeof folder !== "string" || !path.isAbsolute(folder)) {
      throw new ProviderKeyError("folder_unavailable");
    }
    return path.join(folder, PROVIDER_KEY_FOLDER);
  }

  async function protection(): Promise<ProviderKeyProtectionStatus> {
    let available: boolean;
    try {
      available = await safeStorage.isAsyncEncryptionAvailable();
    } catch {
      available = false;
    }
    if (!available) {
      return Object.freeze({
        available: false,
        reason: "encryption_unavailable",
      });
    }
    if (systemAlwaysProtects) {
      return Object.freeze({ available: true });
    }
    let backend: string;
    try {
      backend = safeStorage.getSelectedStorageBackend();
    } catch {
      backend = "unknown";
    }
    if (!CONFIRMED_LINUX_BACKENDS.includes(backend)) {
      return Object.freeze({
        available: false,
        reason:
          backend === "basic_text"
            ? "no_secret_service"
            : "secret_service_unconfirmed",
      });
    }
    return Object.freeze({ available: true });
  }

  /**
   * Encrypts a payload. On Linux and elsewhere a ciphertext that was not
   * made with a secret service's key is refused and never written, even
   * when the backend claimed one.
   */
  async function encrypt(payload: string): Promise<Buffer> {
    if (!(await protection()).available) {
      throw new ProviderKeyError("system_protection_unavailable");
    }
    let ciphertext: Buffer;
    try {
      ciphertext = await safeStorage.encryptStringAsync(payload);
    } catch {
      throw new ProviderKeyError("system_protection_unavailable");
    }
    if (
      !systemAlwaysProtects &&
      !ciphertext
        .subarray(0, secretServicePrefix.length)
        .equals(secretServicePrefix)
    ) {
      throw new ProviderKeyError("system_protection_unavailable");
    }
    return ciphertext;
  }

  async function writeKeyFile(
    folder: string,
    file: string,
    ciphertext: Buffer,
  ): Promise<void> {
    const bytes = encodeProviderKeyFile(ciphertext);
    try {
      await fileSystem.mkdir(folder, {
        recursive: true,
        mode: KEY_FOLDER_MODE,
      });
      await writeFileAtomic(fileSystem, file, bytes, platform);
    } catch {
      throw new ProviderKeyError("write_failed");
    } finally {
      bytes.fill(0);
    }
  }

  async function save(
    requested: ProviderKeyBinding,
    key: string,
  ): Promise<void> {
    const binding = checkBinding(requested);
    if (!isProviderKeyShape(key)) {
      throw new ProviderKeyError("invalid_key");
    }
    const folder = keyFolder();
    const ciphertext = await encrypt(encodeProviderKeyPayload(binding, key));
    await writeKeyFile(
      folder,
      path.join(folder, providerKeyFileName(binding.providerConnectionId)),
      ciphertext,
    );
  }

  /**
   * Reads, decrypts, and opens a connection's key file; null without one.
   * Rewrites it when `safeStorage` reports `shouldReEncrypt`.
   */
  async function open(requested: ProviderKeyBinding): Promise<string | null> {
    const binding = checkBinding(requested);
    const folder = keyFolder();
    const file = path.join(
      folder,
      providerKeyFileName(binding.providerConnectionId),
    );
    let bytes: Uint8Array;
    try {
      bytes = await fileSystem.readFile(file);
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw new ProviderKeyError("read_failed");
    }
    const ciphertext = decodeProviderKeyFile(bytes);
    let decrypted: { shouldReEncrypt: boolean; result: string };
    try {
      decrypted = await safeStorage.decryptStringAsync(ciphertext);
    } catch {
      throw new ProviderKeyError("unreadable");
    }
    const key = openProviderKeyPayload(decrypted.result, binding);
    if (decrypted.shouldReEncrypt) {
      await reEncrypt(folder, file, decrypted.result);
    }
    return key;
  }

  /**
   * Writes a key file again after `shouldReEncrypt`. A failure, also a
   * system that no longer confirms a secret service, keeps the old file,
   * which still decrypts, and is reported without a value.
   */
  async function reEncrypt(
    folder: string,
    file: string,
    payload: string,
  ): Promise<void> {
    try {
      await writeKeyFile(folder, file, await encrypt(payload));
    } catch (error) {
      try {
        onError("A provider key could not be encrypted again.", error);
      } catch {
        // An error of the receiver changes nothing.
      }
    }
  }

  async function check(binding: ProviderKeyBinding): Promise<ProviderKeyCheck> {
    return (await open(binding)) === null ? "missing" : "ready";
  }

  async function read(binding: ProviderKeyBinding): Promise<string> {
    const key = await open(binding);
    if (key === null) {
      throw new ProviderKeyError("missing");
    }
    return key;
  }

  async function namesInFolder(folder: string): Promise<string[]> {
    try {
      return await fileSystem.readdir(folder);
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw new ProviderKeyError("delete_failed");
    }
  }

  async function removeNames(folder: string, names: string[]): Promise<void> {
    let failed = false;
    for (const name of names) {
      try {
        await removeFile(fileSystem, path.join(folder, name));
      } catch {
        failed = true;
      }
    }
    await syncFolder(fileSystem, folder, platform);
    if (failed) {
      throw new ProviderKeyError("delete_failed");
    }
  }

  async function remove(providerConnectionId: string): Promise<void> {
    const id = checkConnectionId(providerConnectionId);
    const folder = keyFolder();
    const target = providerKeyFileName(id);
    const names = await namesInFolder(folder);
    // The key file first, then the temporary files that a stopped write
    // left for it.
    await removeNames(folder, [
      target,
      ...names.filter((name) => isTemporaryFileOf(name, target)),
    ]);
  }

  async function removeAll(): Promise<void> {
    const folder = keyFolder();
    const names = await namesInFolder(folder);
    await removeNames(
      folder,
      names.filter(
        (name) =>
          connectionOfFileName(name) !== null || isKeyTemporaryFile(name),
      ),
    );
  }

  return Object.freeze({
    protection: () => exclusive(protection),
    save: (binding: ProviderKeyBinding, key: string) =>
      exclusive(() => save(binding, key)),
    check: (binding: ProviderKeyBinding) => exclusive(() => check(binding)),
    read: (binding: ProviderKeyBinding) => exclusive(() => read(binding)),
    remove: (providerConnectionId: string) =>
      exclusive(() => remove(providerConnectionId)),
    removeAll: () => exclusive(removeAll),
  });
}
