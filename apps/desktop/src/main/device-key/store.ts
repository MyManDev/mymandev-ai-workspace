// The device key store of the main process (ADR 0014, P-51 and P-56): it
// creates the Ed25519 device key, keeps it encrypted in the local data
// folder, decrypts it once at startup, replaces it at a sign-in while it
// keeps the previous key until the new one authenticates, deletes it, and
// hands out keys that can only sign the input that `deviceAuthInput` builds.
//
// Nothing here logs, and nothing here is reachable from the renderer.
import path from "node:path";
import {
  flushRename,
  isMissingFileError,
  isTemporaryFileOf,
  KEY_FOLDER_MODE,
  type KeyFileSystem,
  nodeKeyFileSystem,
  readFileIfPresent,
  removeFile,
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

/**
 * The first bytes of a `safeStorage` ciphertext on Linux whose key comes from
 * a secret service. Chromium writes `v10` for its fixed key, which protects
 * nothing. Not yet verified with the asynchronous API on a real Linux
 * desktop (#67); any other prefix counts as no secret service, so a wrong
 * guess only leads to a passphrase.
 */
export const SECRET_SERVICE_CIPHERTEXT_PREFIX = "v11";

/** What `systemProtection` encrypts on Linux to learn which key `safeStorage` uses. */
const PROBE_TEXT = "mymandev-device-key-probe";

/** Whether the system can protect a new device key. */
export type SystemProtectionStatus =
  | { readonly available: true }
  | {
      readonly available: false;
      /**
       * `encryption_unavailable`: `isAsyncEncryptionAvailable` resolved false,
       * or the Linux probe failed to encrypt.
       * `no_secret_service`: Linux selected `basic_text`.
       * `secret_service_unconfirmed`: Linux reported another backend that is
       * not a secret service, or `unknown`, or the probe's ciphertext does
       * not start with `SECRET_SERVICE_CIPHERTEXT_PREFIX`.
       */
      readonly reason:
        | "encryption_unavailable"
        | "no_secret_service"
        | "secret_service_unconfirmed";
      /**
       * Whether a key protected by a passphrase, or an unprotected key, may
       * be created instead: on Linux only. On Windows and macOS the person
       * must make the system's protection available.
       */
      readonly fallbackAllowed: boolean;
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
      /**
       * Whether `load` needs the passphrase: a key file that is not loaded
       * yet, the current or the previous one, is protected by a passphrase.
       */
      readonly passphraseRequired: boolean;
    };

/**
 * How a new key is protected. `system` needs the system's protection. The
 * other two exist on Linux only and are refused while the system can protect
 * the key. `unprotected` needs `acceptsUnprotectedKey: true`, which the UI
 * sets only after the person read the warning and chose it. There is no
 * memory-only key.
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

export interface ReplaceDeviceKeyOptions {
  /**
   * Needed to replace an unprotected key while the system still cannot
   * protect keys: the UI sets it only after the person read the warning
   * again and chose an unprotected key again.
   */
  readonly acceptsUnprotectedKey?: true;
}

export interface DeviceKeyStore {
  /** Whether the system can protect a new key (see `SystemProtectionStatus`). */
  readonly systemProtection: () => Promise<SystemProtectionStatus>;
  /** Whether a key file exists, readable or not. */
  readonly hasKey: () => Promise<boolean>;
  /**
   * The protection of the stored key, read from the key file without
   * decrypting it. Rejects with `corrupt` or `newer_format` for a key file
   * that this version cannot read, and with `corrupt` for a key file
   * protected by a passphrase or unprotected on Windows or macOS.
   */
  readonly status: () => Promise<DeviceKeyStatus>;
  /**
   * Decrypts the stored keys once and holds them; resolves with null when no
   * key is stored. Await it at startup before any connection to the API
   * opens, so that no prompt of the operating system runs inside the
   * 10-second WebSocket handshake. A later call resolves with the keys held.
   * A system-protected key file is written again when `safeStorage` reports
   * `shouldReEncrypt`. Rejects with `passphrase_required`,
   * `wrong_passphrase`, `unreadable`, `corrupt`, or `newer_format`; a key
   * file protected by a passphrase or unprotected is `corrupt` on Windows
   * and macOS, where the store never writes one.
   */
  readonly load: (options?: LoadDeviceKeyOptions) => Promise<DeviceKeys | null>;
  /** The keys held, or null before `load` or `create` and after `delete`. */
  readonly keys: () => DeviceKeys | null;
  /**
   * Generates a key pair, stores the private key with `protection`, and
   * holds it. Rejects with `key_exists` when a key file exists. Rejects for
   * a protection that does not apply: `system_protection_unavailable` (the
   * system cannot protect the key; on Windows and macOS the person must fix
   * that first), `system_protection_required` (a passphrase or an
   * unprotected key on Windows or macOS), `system_protection_available` (a
   * passphrase or an unprotected key on Linux while the system can protect
   * it), `unprotected_not_accepted`, or `passphrase_invalid`.
   */
  readonly create: (protection: NewDeviceKeyProtection) => Promise<DeviceKey>;
  /**
   * For a GitHub sign-in: generates a new key pair, stores it, and keeps the
   * current key as the previous one. The new key is protected by the system
   * whenever the system can protect it, so a Linux key protected by a
   * passphrase or unprotected moves up when a secret service appears; only
   * otherwise does it keep the protection of the current key, and an
   * unprotected key then needs `acceptsUnprotectedKey: true` again. Resolves
   * after both are on disk, with the new key as `current`; only then may the
   * sign-in send the new public key. Rejects with `not_loaded`,
   * `system_protection_unavailable` (a system-protected key that the system
   * can no longer protect), `unprotected_not_accepted`, and
   * `replacement_pending` while a previous key is still kept: the caller
   * first learns, by authenticating, which key the API holds, and calls
   * `confirmReplacement` or `abandonReplacement`.
   */
  readonly replace: (options?: ReplaceDeviceKeyOptions) => Promise<DeviceKeys>;
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
   * The passphrase key while a held key is protected by a passphrase, kept
   * so that a replacement needs no second prompt. The private key is in
   * memory anyway, so it adds no exposure.
   */
  wrapping: PassphraseWrapping | null;
}

/** The ASCII bytes of `SECRET_SERVICE_CIPHERTEXT_PREFIX`. */
const secretServicePrefix = Buffer.from(
  SECRET_SERVICE_CIPHERTEXT_PREFIX,
  "ascii",
);

/** Whether a Linux `safeStorage` ciphertext was made with a secret service's key. */
function madeWithSecretService(ciphertext: Buffer): boolean {
  return ciphertext
    .subarray(0, secretServicePrefix.length)
    .equals(secretServicePrefix);
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
  // Windows and macOS always protect a key with the system. Elsewhere the
  // system's protection must be confirmed, and only Linux may fall back to a
  // passphrase or an unprotected key.
  const systemAlwaysProtects = platform === "win32" || platform === "darwin";
  const fallbackAllowed = platform === "linux";
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

  function unavailable(
    reason: Extract<SystemProtectionStatus, { available: false }>["reason"],
  ): SystemProtectionStatus {
    return Object.freeze({ available: false, reason, fallbackAllowed });
  }

  async function systemProtection(): Promise<SystemProtectionStatus> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      return unavailable("encryption_unavailable");
    }
    if (systemAlwaysProtects) {
      return Object.freeze({ available: true });
    }
    const backend = safeStorage.getSelectedStorageBackend();
    if (!CONFIRMED_LINUX_BACKENDS.includes(backend)) {
      return unavailable(
        backend === "basic_text"
          ? "no_secret_service"
          : "secret_service_unconfirmed",
      );
    }
    // The backend names the store of the synchronous API. The asynchronous
    // encryptor can still fall back to Chromium's fixed key when the secret
    // service cannot be reached, so its output decides (fail closed).
    let probe: Buffer;
    try {
      probe = await safeStorage.encryptStringAsync(PROBE_TEXT);
    } catch {
      return unavailable("encryption_unavailable");
    }
    return madeWithSecretService(probe)
      ? Object.freeze({ available: true })
      : unavailable("secret_service_unconfirmed");
  }

  /**
   * Reads and decodes a key file. On Windows and macOS a key file protected
   * by a passphrase or unprotected is `corrupt`: the store never writes one
   * there, so it was placed by someone else, and a replacement must not
   * inherit its lower protection.
   */
  async function readKeyFile(file: string): Promise<KeyFile | null> {
    const bytes = await readFileIfPresent(fileSystem, file);
    if (bytes === null) {
      return null;
    }
    const stored = decodeKeyFile(bytes);
    if (stored.protection !== "system" && !fallbackAllowed) {
      throw new DeviceKeyError("corrupt");
    }
    return stored;
  }

  /**
   * Encrypts with `safeStorage`. On Linux, a ciphertext that was not made
   * with a secret service's key is refused and never written, even when the
   * probe of `systemProtection` passed a moment before.
   */
  async function systemEncrypt(plainText: string): Promise<Buffer> {
    const ciphertext = await safeStorage.encryptStringAsync(plainText);
    if (!systemAlwaysProtects && !madeWithSecretService(ciphertext)) {
      throw new DeviceKeyError("system_protection_unavailable");
    }
    return ciphertext;
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
            ciphertext: await systemEncrypt(pkcs8.toString("base64")),
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
      const ciphertext = await systemEncrypt(encodedPkcs8);
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
      await flushRename(fileSystem, currentPath, platform);
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
      // After a key moved up from a passphrase to the system, the previous
      // key may still be the passphrase key; its wrapping is kept for an
      // `abandonReplacement` that makes it current again.
      const passphraseFile = [current, previous].find(
        (file) => file?.protection === "passphrase",
      );
      const kept =
        passphraseFile?.protection === "passphrase"
          ? await passphraseWrapping(passphraseFile.salt, passphraseFile.cost)
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
    if (protection.kind !== "system" && !fallbackAllowed) {
      throw new DeviceKeyError("system_protection_required");
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

  /**
   * The protection of a replacement key: the system's whenever it can
   * protect the key; otherwise, on Linux only, the protection of a current
   * key that the system did not protect.
   */
  async function replacementProtection(
    current: DeviceKeyProtection,
    replaceOptions: ReplaceDeviceKeyOptions,
  ): Promise<DeviceKeyProtection> {
    if ((await systemProtection()).available) {
      return "system";
    }
    if (current === "system" || !fallbackAllowed) {
      throw new DeviceKeyError("system_protection_unavailable");
    }
    if (
      current === "unprotected" &&
      (replaceOptions as { acceptsUnprotectedKey?: unknown })
        .acceptsUnprotectedKey !== true
    ) {
      throw new DeviceKeyError("unprotected_not_accepted");
    }
    return current;
  }

  async function replace(
    replaceOptions: ReplaceDeviceKeyOptions = {},
  ): Promise<DeviceKeys> {
    const keys = loaded;
    if (keys === null) {
      throw new DeviceKeyError("not_loaded");
    }
    if (keys.previous !== null) {
      throw new DeviceKeyError("replacement_pending");
    }
    const protection = await replacementProtection(
      keys.current.protection,
      replaceOptions,
    );
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
    // out. Each rename is flushed before the next step and before `replace`
    // resolves.
    try {
      await fileSystem.rename(currentPath, previousPath);
      await flushRename(fileSystem, previousPath, platform);
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
      try {
        await fileSystem.rename(previousPath, currentPath);
        await flushRename(fileSystem, currentPath, platform);
      } catch {
        // See above.
      }
      throw error;
    }
    keys.previous = keys.current;
    keys.current = { held, protection };
    return view(keys);
  }

  /** Drops the passphrase key once no held key is protected by a passphrase. */
  function dropUnusedWrapping(keys: LoadedKeys): void {
    if (
      keys.wrapping !== null &&
      keys.current.protection !== "passphrase" &&
      keys.previous?.protection !== "passphrase"
    ) {
      keys.wrapping.key.fill(0);
      keys.wrapping = null;
    }
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
    dropUnusedWrapping(keys);
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
    await flushRename(fileSystem, currentPath, platform);
    keys.current.held.retire();
    keys.current = previous;
    keys.previous = null;
    dropUnusedWrapping(keys);
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
        passphraseRequired: false,
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
      passphraseRequired:
        current?.protection === "passphrase" ||
        previous?.protection === "passphrase",
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
    replace: (replaceOptions?: ReplaceDeviceKeyOptions) =>
      exclusive(() => replace(replaceOptions)),
    confirmReplacement: () => exclusive(confirmReplacement),
    abandonReplacement: () => exclusive(abandonReplacement),
    delete: () => exclusive(deleteKeys),
  });
}
