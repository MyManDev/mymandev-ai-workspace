// The device key store of the main process (ADR 0014, P-51 and P-56): it
// creates the Ed25519 device key, keeps it encrypted in the local data
// folder, decrypts it once at startup, replaces it at a sign-in while it
// keeps the previous key until the new one authenticates, deletes it, and
// hands out keys that can only sign the input that `deviceAuthInput` builds.
//
// Nothing here logs, and nothing here is reachable from the renderer.
import path from "node:path";
import {
  isTemporaryFileOf,
  KEY_FOLDER_MODE,
  type KeyFileSystem,
  nodeKeyFileSystem,
  readFileIfPresent,
  removeFile,
  isMissingFileError,
  syncFolder,
  writeFileAtomic,
} from "./atomic-file.ts";
import { DeviceKeyError } from "./errors.ts";
import {
  decodeKeyFile,
  derivePassphraseWrapping,
  type DeviceKeyProtection,
  encodeKeyFile,
  type KeyFile,
  openWithPassphrase,
  type PassphraseWrapping,
  type ScryptCost,
  sealWithPassphrase,
} from "./key-file.ts";
import {
  type DeviceKey,
  generateDeviceKey,
  type HeldDeviceKey,
  importDeviceKey,
} from "./signing-key.ts";

/**
 * The part of Electron's `safeStorage` that the store uses: the asynchronous
 * API only. The synchronous one is deprecated and removed in Electron 46.
 */
export interface SystemKeyProtection {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  /** Linux only; the store calls it on no other platform. */
  getSelectedStorageBackend(): string;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(
    encrypted: Buffer,
  ): Promise<{ shouldReEncrypt: boolean; result: string }>;
}

/**
 * The Linux backends of `safeStorage` that keep the encryption key in a
 * secret service. Any other value, `basic_text` (a fixed key that protects
 * nothing) and `unknown` (asked before the application was ready) included,
 * does not confirm a secret service.
 */
export const CONFIRMED_LINUX_BACKENDS: readonly string[] = Object.freeze([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);

/** Whether the system can protect a new device key. */
export type SystemProtectionStatus =
  | { readonly available: true }
  | {
      readonly available: false;
      /**
       * `encryption_unavailable`: `isAsyncEncryptionAvailable` resolved false.
       * `no_secret_service`: Linux selected `basic_text`.
       * `secret_service_unconfirmed`: Linux reported another backend that is
       * not a secret service, or `unknown`.
       */
      readonly reason:
        | "encryption_unavailable"
        | "no_secret_service"
        | "secret_service_unconfirmed";
    };

/** The file of the newest key, which is tried first. */
export const CURRENT_KEY_FILE = "device-key.json";

/**
 * The file of the key that the newest key replaced, kept until one
 * authentication with the newest key succeeds.
 */
export const PREVIOUS_KEY_FILE = "device-key.previous.json";

/**
 * What the UI may ask: how the stored key is protected (`system`,
 * `passphrase`, or `unprotected`), or `none` when no key is stored.
 */
export type DeviceKeyStatus =
  | { readonly protection: "none" }
  | {
      readonly protection: DeviceKeyProtection;
      /** Whether `load` or `create` holds the key in this process. */
      readonly loaded: boolean;
      /** Whether a previous key is kept until the newest key authenticates. */
      readonly replacementPending: boolean;
    };

/**
 * How a new key is protected. `system` needs the system's protection; the
 * other two are refused while the system can protect the key, and
 * `unprotected` needs `acceptsUnprotectedKey: true`, which the UI sets only
 * after the person read the warning and chose it. There is no memory-only
 * key.
 */
export type NewDeviceKeyProtection =
  | { readonly kind: "system" }
  | { readonly kind: "passphrase"; readonly passphrase: string }
  | { readonly kind: "unprotected"; readonly acceptsUnprotectedKey: true };

/** The keys that the store holds, in the order to try them. */
export interface DeviceKeys {
  /** The newest key. It is tried first. */
  readonly current: DeviceKey;
  /**
   * The key that `current` replaced, kept until one authentication with
   * `current` succeeds; null when there is none.
   */
  readonly previous: DeviceKey | null;
}

export interface LoadDeviceKeyOptions {
  /** Needed when the key is protected by a passphrase; ignored otherwise. */
  readonly passphrase?: string;
}

export interface DeviceKeyStore {
  /** Whether the system can protect a new key (see `SystemProtectionStatus`). */
  readonly systemProtection: () => Promise<SystemProtectionStatus>;
  /** Whether a key file exists, readable or not. */
  readonly hasKey: () => Promise<boolean>;
  /**
   * The protection of the stored key, read from the key file without
   * decrypting it. Rejects with `corrupt` or `newer_format` for a key file
   * that this version cannot read.
   */
  readonly status: () => Promise<DeviceKeyStatus>;
  /**
   * Decrypts the stored keys once and holds them; resolves with null when no
   * key is stored. Await it at startup before any connection to the API
   * opens, so that no prompt of the operating system runs inside the
   * 10-second WebSocket handshake. A later call resolves with the keys held.
   * A system-protected key file is written again when `safeStorage` reports
   * `shouldReEncrypt`. Rejects with `passphrase_required`,
   * `wrong_passphrase`, `unreadable`, `corrupt`, or `newer_format`.
   */
  readonly load: (options?: LoadDeviceKeyOptions) => Promise<DeviceKeys | null>;
  /** The keys held, or null before `load` or `create` and after `delete`. */
  readonly keys: () => DeviceKeys | null;
  /**
   * Generates a key pair, stores the private key with `protection`, and
   * holds it. Rejects with `key_exists` when a key file exists, and with
   * `system_protection_unavailable`, `system_protection_available`,
   * `unprotected_not_accepted`, or `passphrase_invalid` for a protection
   * that does not apply.
   */
  readonly create: (protection: NewDeviceKeyProtection) => Promise<DeviceKey>;
  /**
   * For a GitHub sign-in: generates a new key pair, stores it with the
   * protection of the current key, and keeps the current key as the
   * previous one. Resolves after both are on disk, with the new key as
   * `current`; only then may the sign-in send the new public key. Rejects
   * with `not_loaded`, and with `replacement_pending` while a previous key is
   * still kept: the caller first learns, by authenticating, which key the
   * API holds, and calls `confirmReplacement` or `abandonReplacement`.
   */
  readonly replace: () => Promise<DeviceKeys>;
  /**
   * One authentication with the newest key succeeded: deletes the previous
   * key, which then signs nothing more. Rejects with `no_replacement`.
   */
  readonly confirmReplacement: () => Promise<void>;
  /**
   * The previous key authenticated and the newest did not, so the API never
   * registered the newest key: deletes it and makes the previous key the
   * current one again. Rejects with `no_replacement`.
   */
  readonly abandonReplacement: () => Promise<void>;
  /**
   * Deletes both key files, whether loaded or not, and every key held stops
   * signing. Used after the API confirmed a removal, after
   * `device_revoked`, and when a key is lost.
   */
  readonly delete: () => Promise<void>;
}

export interface DeviceKeyStoreOptions {
  /** The folder of the key files, from `deviceKeyFolder`. */
  readonly folder: string;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Electron's `safeStorage`. */
  readonly systemProtection: SystemKeyProtection;
  /** Defaults to `node:fs/promises`. */
  readonly fileSystem?: KeyFileSystem;
  /** The scrypt cost of a new passphrase key; tests pass a lower one. */
  readonly scryptCost?: ScryptCost;
  /**
   * Receives an error that does not stop the operation: a failed rewrite
   * after `shouldReEncrypt`, after which the old file is kept. The error
   * holds no secret. An error that it throws is ignored.
   */
  readonly onError?: (message: string, error: unknown) => void;
}

interface HeldSlot {
  readonly held: HeldDeviceKey;
  readonly protection: DeviceKeyProtection;
}

interface LoadedKeys {
  current: HeldSlot;
  previous: HeldSlot | null;
  /**
   * The passphrase key of a passphrase-protected key, kept so that a
   * replacement needs no second prompt. The private key is in memory
   * anyway, so it adds no exposure.
   */
  wrapping: PassphraseWrapping | null;
}

export function createDeviceKeyStore(
  options: DeviceKeyStoreOptions,
): DeviceKeyStore {
  const {
    folder,
    platform,
    systemProtection: safeStorage,
    fileSystem = nodeKeyFileSystem,
    scryptCost,
    onError = () => undefined,
  } = options;
  const currentPath = path.join(folder, CURRENT_KEY_FILE);
  const previousPath = path.join(folder, PREVIOUS_KEY_FILE);
  let loaded: LoadedKeys | null = null;

  // Every operation runs after the one before it has settled, so two calls
  // never move the files at the same time.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }

  function view(keys: LoadedKeys): DeviceKeys {
    return Object.freeze({
      current: keys.current.held.key,
      previous: keys.previous?.held.key ?? null,
    });
  }

  async function systemProtection(): Promise<SystemProtectionStatus> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      return { available: false, reason: "encryption_unavailable" };
    }
    if (platform === "win32" || platform === "darwin") {
      return { available: true };
    }
    const backend = safeStorage.getSelectedStorageBackend();
    if (CONFIRMED_LINUX_BACKENDS.includes(backend)) {
      return { available: true };
    }
    return {
      available: false,
      reason:
        backend === "basic_text"
          ? "no_secret_service"
          : "secret_service_unconfirmed",
    };
  }

  async function readKeyFile(file: string): Promise<KeyFile | null> {
    const bytes = await readFileIfPresent(fileSystem, file);
    return bytes === null ? null : decodeKeyFile(bytes);
  }

  async function keyFileExists(): Promise<boolean> {
    return (
      (await readFileIfPresent(fileSystem, currentPath)) !== null ||
      (await readFileIfPresent(fileSystem, previousPath)) !== null
    );
  }

  /** Deletes temporary files that a write left when the process stopped. */
  async function removeTemporaryFiles(): Promise<void> {
    let names: string[];
    try {
      names = await fileSystem.readdir(folder);
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    for (const name of names) {
      if (
        isTemporaryFileOf(name, CURRENT_KEY_FILE) ||
        isTemporaryFileOf(name, PREVIOUS_KEY_FILE)
      ) {
        await removeFile(fileSystem, path.join(folder, name));
      }
    }
  }

  /** The bytes of a key file that holds `held` with `protection`. */
  async function seal(
    held: HeldDeviceKey,
    protection: DeviceKeyProtection,
    wrapping: PassphraseWrapping | null,
  ): Promise<Buffer> {
    const pkcs8 = held.exportPkcs8();
    try {
      switch (protection) {
        case "system":
          return encodeKeyFile({
            protection,
            ciphertext: await safeStorage.encryptStringAsync(
              pkcs8.toString("base64"),
            ),
          });
        case "passphrase":
          if (wrapping === null) {
            throw new DeviceKeyError("passphrase_required");
          }
          return encodeKeyFile(sealWithPassphrase(pkcs8, wrapping));
        case "unprotected":
          return encodeKeyFile({ protection, pkcs8 });
      }
    } finally {
      pkcs8.fill(0);
    }
  }

  /** Writes a key file and fills its bytes with zeros afterwards. */
  async function writeKeyFile(file: string, bytes: Buffer): Promise<void> {
    try {
      await writeFileAtomic(fileSystem, file, bytes, platform);
    } finally {
      bytes.fill(0);
    }
  }

  /** Decrypts one key file; re-encrypts it when `safeStorage` asks for it. */
  async function openKeyFile(
    stored: KeyFile,
    file: string,
    passphraseWrapping: (
      salt: Buffer,
      cost: ScryptCost,
    ) => Promise<PassphraseWrapping>,
  ): Promise<HeldSlot> {
    switch (stored.protection) {
      case "system": {
        let decrypted: { shouldReEncrypt: boolean; result: string };
        try {
          decrypted = await safeStorage.decryptStringAsync(stored.ciphertext);
        } catch {
          throw new DeviceKeyError("unreadable");
        }
        const pkcs8 = Buffer.from(decrypted.result, "base64");
        try {
          if (pkcs8.toString("base64") !== decrypted.result) {
            throw new DeviceKeyError("corrupt");
          }
          const held = importDeviceKey(pkcs8);
          if (decrypted.shouldReEncrypt) {
            await reEncrypt(decrypted.result, file);
          }
          return { held, protection: stored.protection };
        } finally {
          pkcs8.fill(0);
        }
      }
      case "passphrase": {
        const wrapping = await passphraseWrapping(stored.salt, stored.cost);
        const pkcs8 = openWithPassphrase(stored, wrapping);
        try {
          return {
            held: importDeviceKey(pkcs8),
            protection: stored.protection,
          };
        } finally {
          pkcs8.fill(0);
        }
      }
      case "unprotected":
        try {
          return {
            held: importDeviceKey(stored.pkcs8),
            protection: stored.protection,
          };
        } finally {
          stored.pkcs8.fill(0);
        }
    }
  }

  /**
   * Writes a system-protected key file again after `shouldReEncrypt`. On
   * Linux, a system that no longer confirms a secret service would encrypt
   * with a fixed key, so the old file is kept. A failure keeps the old file,
   * which still decrypts, and does not stop the start.
   */
  async function reEncrypt(encodedPkcs8: string, file: string): Promise<void> {
    try {
      if (!(await systemProtection()).available) {
        return;
      }
      const ciphertext = await safeStorage.encryptStringAsync(encodedPkcs8);
      await writeKeyFile(
        file,
        encodeKeyFile({ protection: "system", ciphertext }),
      );
    } catch (error) {
      try {
        onError("The device key could not be encrypted again.", error);
      } catch {
        // An error of the receiver does not stop the start either.
      }
    }
  }

  async function load(
    loadOptions: LoadDeviceKeyOptions = {},
  ): Promise<DeviceKeys | null> {
    if (loaded !== null) {
      return view(loaded);
    }
    await removeTemporaryFiles();
    let current = await readKeyFile(currentPath);
    let previous = await readKeyFile(previousPath);
    if (current === null) {
      if (previous === null) {
        return null;
      }
      // A replacement stopped between its two renames. Its new key was
      // never handed out, so the previous key is the current one again.
      await fileSystem.rename(previousPath, currentPath);
      await syncFolder(fileSystem, folder, platform);
      current = previous;
      previous = null;
    }

    // A passphrase is derived once for each salt and cost.
    const wrappings = new Map<string, Promise<PassphraseWrapping>>();
    const passphraseWrapping = (
      salt: Buffer,
      cost: ScryptCost,
    ): Promise<PassphraseWrapping> => {
      const { passphrase } = loadOptions;
      if (passphrase === undefined) {
        return Promise.reject(new DeviceKeyError("passphrase_required"));
      }
      const id = `${salt.toString("hex")}:${cost.n}:${cost.r}:${cost.p}`;
      let wrapping = wrappings.get(id);
      if (wrapping === undefined) {
        wrapping = derivePassphraseWrapping(passphrase, { salt, cost });
        wrappings.set(id, wrapping);
      }
      return wrapping;
    };

    const opened: HeldSlot[] = [];
    try {
      const currentSlot = await openKeyFile(
        current,
        currentPath,
        passphraseWrapping,
      );
      opened.push(currentSlot);
      const previousSlot =
        previous === null
          ? null
          : await openKeyFile(previous, previousPath, passphraseWrapping);
      if (previousSlot !== null) {
        opened.push(previousSlot);
      }
      const kept =
        current.protection === "passphrase"
          ? await passphraseWrapping(current.salt, current.cost)
          : null;
      for (const wrapping of wrappings.values()) {
        const settled = await wrapping.catch(() => null);
        if (settled !== null && settled !== kept) {
          settled.key.fill(0);
        }
      }
      loaded = { current: currentSlot, previous: previousSlot, wrapping: kept };
      return view(loaded);
    } catch (error) {
      for (const slot of opened) {
        slot.held.retire();
      }
      for (const wrapping of wrappings.values()) {
        (await wrapping.catch(() => null))?.key.fill(0);
      }
      throw error;
    }
  }

  async function create(
    protection: NewDeviceKeyProtection,
  ): Promise<DeviceKey> {
    if (loaded !== null || (await keyFileExists())) {
      throw new DeviceKeyError("key_exists");
    }
    const system = await systemProtection();
    if (protection.kind === "system" && !system.available) {
      throw new DeviceKeyError("system_protection_unavailable");
    }
    if (protection.kind !== "system" && system.available) {
      throw new DeviceKeyError("system_protection_available");
    }
    if (
      protection.kind === "unprotected" &&
      (protection as { acceptsUnprotectedKey?: unknown })
        .acceptsUnprotectedKey !== true
    ) {
      throw new DeviceKeyError("unprotected_not_accepted");
    }
    const wrapping =
      protection.kind === "passphrase"
        ? await derivePassphraseWrapping(protection.passphrase, {
            cost: scryptCost,
          })
        : null;
    const held = await generateDeviceKey();
    try {
      const bytes = await seal(held, protection.kind, wrapping);
      await fileSystem.mkdir(folder, {
        recursive: true,
        mode: KEY_FOLDER_MODE,
      });
      await writeKeyFile(currentPath, bytes);
    } catch (error) {
      held.retire();
      wrapping?.key.fill(0);
      throw error;
    }
    loaded = {
      current: { held, protection: protection.kind },
      previous: null,
      wrapping,
    };
    return held.key;
  }

  async function replace(): Promise<DeviceKeys> {
    const keys = loaded;
    if (keys === null) {
      throw new DeviceKeyError("not_loaded");
    }
    if (keys.previous !== null) {
      throw new DeviceKeyError("replacement_pending");
    }
    const { protection } = keys.current;
    if (protection === "system" && !(await systemProtection()).available) {
      throw new DeviceKeyError("system_protection_unavailable");
    }
    const held = await generateDeviceKey();
    let bytes: Buffer;
    try {
      bytes = await seal(held, protection, keys.wrapping);
    } catch (error) {
      held.retire();
      throw error;
    }
    // First the current key becomes the previous one, then the new key
    // becomes the current one. If the process stops in between, `load`
    // makes the previous key current again; the new key was never handed
    // out.
    try {
      await fileSystem.rename(currentPath, previousPath);
    } catch (error) {
      bytes.fill(0);
      held.retire();
      throw error;
    }
    try {
      await writeKeyFile(currentPath, bytes);
    } catch (error) {
      held.retire();
      // The key that the API holds stays the current one. If this rename
      // fails too, `load` does it at the next start.
      await fileSystem.rename(previousPath, currentPath).catch(() => undefined);
      throw error;
    }
    keys.previous = keys.current;
    keys.current = { held, protection };
    return view(keys);
  }

  async function confirmReplacement(): Promise<void> {
    const keys = loaded;
    if (keys === null) {
      throw new DeviceKeyError("not_loaded");
    }
    const { previous } = keys;
    if (previous === null) {
      throw new DeviceKeyError("no_replacement");
    }
    await removeFile(fileSystem, previousPath);
    await syncFolder(fileSystem, folder, platform);
    previous.held.retire();
    keys.previous = null;
  }

  async function abandonReplacement(): Promise<void> {
    const keys = loaded;
    if (keys === null) {
      throw new DeviceKeyError("not_loaded");
    }
    const { previous } = keys;
    if (previous === null) {
      throw new DeviceKeyError("no_replacement");
    }
    // The rename replaces the newest key file with the previous one in one
    // step.
    await fileSystem.rename(previousPath, currentPath);
    await syncFolder(fileSystem, folder, platform);
    keys.current.held.retire();
    keys.current = previous;
    keys.previous = null;
  }

  async function deleteKeys(): Promise<void> {
    // The previous key first: `load` would make a previous key without a
    // current one the current key again.
    await removeFile(fileSystem, previousPath);
    await removeFile(fileSystem, currentPath);
    await removeTemporaryFiles();
    await syncFolder(fileSystem, folder, platform);
    if (loaded !== null) {
      loaded.current.held.retire();
      loaded.previous?.held.retire();
      loaded.wrapping?.key.fill(0);
      loaded = null;
    }
  }

  async function status(): Promise<DeviceKeyStatus> {
    if (loaded !== null) {
      return Object.freeze({
        protection: loaded.current.protection,
        loaded: true,
        replacementPending: loaded.previous !== null,
      });
    }
    const current = await readKeyFile(currentPath);
    const previous = await readKeyFile(previousPath);
    const stored = current ?? previous;
    if (stored === null) {
      return Object.freeze({ protection: "none" });
    }
    return Object.freeze({
      protection: stored.protection,
      loaded: false,
      replacementPending: current !== null && previous !== null,
    });
  }

  return Object.freeze({
    systemProtection: () => exclusive(systemProtection),
    hasKey: () =>
      exclusive(async () => loaded !== null || (await keyFileExists())),
    status: () => exclusive(status),
    load: (loadOptions?: LoadDeviceKeyOptions) =>
      exclusive(() => load(loadOptions)),
    keys: () => (loaded === null ? null : view(loaded)),
    create: (protection: NewDeviceKeyProtection) =>
      exclusive(() => create(protection)),
    replace: () => exclusive(replace),
    confirmReplacement: () => exclusive(confirmReplacement),
    abandonReplacement: () => exclusive(abandonReplacement),
    delete: () => exclusive(deleteKeys),
  });
}
