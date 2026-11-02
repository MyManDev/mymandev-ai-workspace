import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deviceAuthInput,
  type DeviceAuthInput,
  DEVICE_SIGNATURE_PATTERN,
} from "@mymandev/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type KeyFileSystem, nodeKeyFileSystem } from "./atomic-file.ts";
import { type DeviceKeyErrorCode, isDeviceKeyError } from "./errors.ts";
import type { DeviceKey } from "./signing-key.ts";
import {
  createDeviceKeyStore,
  CURRENT_KEY_FILE,
  type DeviceKeyStoreOptions,
  PREVIOUS_KEY_FILE,
  type SystemKeyProtection,
} from "./store.ts";

const TEST_COST = Object.freeze({ n: 2 ** 14, r: 8, p: 1 });
const PASSPHRASE = "correct horse battery staple";
const SPKI_ED25519_PREFIX = "302a300506032b6570032100";
const AUDIENCE = "https://api.mymandev.example";
const SIGN_IN_CODE = "mmdc_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";

let root: string;
let folder: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mymandev-device-key-"));
  // The store creates a missing folder itself.
  folder = path.join(root, "MyManDev");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A fake `safeStorage` with the asynchronous API only, so a call of the
 * synchronous API fails. It really encrypts, with AES-256-GCM under a key of
 * its own, so a test can tell whether a file holds the key in the clear.
 */
function fakeSafeStorage(
  options: { available?: boolean; backend?: string } = {},
) {
  const secret = randomBytes(32);
  const calls: string[] = [];
  const state = {
    available: options.available ?? true,
    backend: options.backend ?? "gnome_libsecret",
    reEncrypt: false,
    failDecrypt: false,
    failEncrypt: false,
    /**
     * The prefix of every ciphertext: Chromium writes `v11` with a secret
     * service's key and `v10` with its fixed key on Linux.
     */
    prefix: "v11",
    /** Prefixes for the next calls, before `prefix` applies again. */
    nextPrefixes: [] as string[],
  };
  const decrypt = (encrypted: Buffer): string => {
    const nonce = encrypted.subarray(3, 15);
    const tag = encrypted.subarray(encrypted.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", secret, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(encrypted.subarray(15, encrypted.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  };
  const safeStorage: SystemKeyProtection = {
    isAsyncEncryptionAvailable: () => {
      calls.push("isAsyncEncryptionAvailable");
      return Promise.resolve(state.available);
    },
    getSelectedStorageBackend: () => {
      calls.push("getSelectedStorageBackend");
      return state.backend;
    },
    encryptStringAsync: (plainText) => {
      calls.push("encryptStringAsync");
      if (state.failEncrypt) {
        return Promise.reject(new Error("encryption failed"));
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secret, nonce);
      const ciphertext = Buffer.concat([
        cipher.update(plainText, "utf8"),
        cipher.final(),
      ]);
      return Promise.resolve(
        Buffer.concat([
          Buffer.from(state.nextPrefixes.shift() ?? state.prefix, "ascii"),
          nonce,
          ciphertext,
          cipher.getAuthTag(),
        ]),
      );
    },
    decryptStringAsync: (encrypted) => {
      calls.push("decryptStringAsync");
      if (state.failDecrypt) {
        return Promise.reject(new Error("decryption failed"));
      }
      return Promise.resolve({
        shouldReEncrypt: state.reEncrypt,
        result: decrypt(encrypted),
      });
    },
  };
  return { safeStorage, calls, state, decrypt };
}

type FakeSafeStorage = ReturnType<typeof fakeSafeStorage>;

function storeWith(
  fake: FakeSafeStorage,
  options: Partial<DeviceKeyStoreOptions> = {},
) {
  return createDeviceKeyStore({
    folder,
    platform: "win32",
    systemProtection: fake.safeStorage,
    scryptCost: TEST_COST,
    ...options,
  });
}

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function expectRejection(
  action: () => Promise<unknown>,
  code: DeviceKeyErrorCode,
): Promise<void> {
  const error = await rejectionOf(action);
  expect(isDeviceKeyError(error, code), String(error)).toBe(true);
}

function expectRetired(key: DeviceKey): void {
  let thrown: unknown;
  try {
    key.sign(signInInput(key.publicKey));
  } catch (error) {
    thrown = error;
  }
  expect(isDeviceKeyError(thrown, "key_retired")).toBe(true);
}

async function keyFileJson(name = CURRENT_KEY_FILE) {
  return JSON.parse(await readFile(path.join(folder, name), "utf8")) as Record<
    string,
    string
  >;
}

/** The public key of the PKCS#8 key that a system-protected file holds. */
async function publicKeyInFile(
  fake: FakeSafeStorage,
  name = CURRENT_KEY_FILE,
): Promise<string> {
  const stored = await keyFileJson(name);
  const pkcs8 = Buffer.from(
    fake.decrypt(Buffer.from(stored["ciphertext"] ?? "", "base64url")),
    "base64",
  );
  const privateKey = createPrivateKey({
    key: pkcs8,
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .subarray(12)
    .toString("hex");
}

function signInInput(newPublicKey: string, deviceId: string | null = null) {
  return {
    purpose: "sign-in",
    audience: AUDIENCE,
    signInCode: SIGN_IN_CODE,
    deviceId,
    newPublicKey,
  } as const satisfies DeviceAuthInput;
}

function verifies(
  input: DeviceAuthInput,
  publicKeyHex: string,
  signature: string,
): boolean {
  return verify(
    null,
    Buffer.from(deviceAuthInput(input), "utf8"),
    createPublicKey({
      key: Buffer.from(SPKI_ED25519_PREFIX + publicKeyHex, "hex"),
      format: "der",
      type: "spki",
    }),
    Buffer.from(signature, "base64url"),
  );
}

test("without a key file the store has no key", async () => {
  const store = storeWith(fakeSafeStorage());

  expect(await store.status()).toEqual({ protection: "none" });
  expect(await store.hasKey()).toBe(false);
  expect(await store.load()).toBeNull();
  expect(store.keys()).toBeNull();
});

test("a new key is written as encrypted PKCS#8 only: no key in the clear and no public key", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);

  const key = await store.create({ kind: "system" });

  expect(await readdir(folder)).toEqual([CURRENT_KEY_FILE]);
  const raw = await readFile(path.join(folder, CURRENT_KEY_FILE));
  const stored = await keyFileJson();
  expect(Object.keys(stored)).toEqual([
    "format",
    "version",
    "protection",
    "ciphertext",
  ]);
  expect(stored).toMatchObject({
    format: "mymandev-device-key",
    version: 1,
    protection: "system",
  });
  // The ciphertext is the PKCS#8 key of exactly this key pair.
  expect(await publicKeyInFile(fake)).toBe(key.publicKey);

  const pkcs8 = Buffer.from(
    fake.decrypt(Buffer.from(stored["ciphertext"] ?? "", "base64url")),
    "base64",
  );
  const seed = pkcs8.subarray(16);
  const publicKey = Buffer.from(key.publicKey, "hex");
  const text = raw.toString("latin1");
  for (const secret of [pkcs8, seed, publicKey]) {
    expect(raw.includes(secret)).toBe(false);
    for (const encoding of ["hex", "base64", "base64url"] as const) {
      expect(text).not.toContain(secret.toString(encoding));
    }
  }
  expect(text).not.toContain("PRIVATE KEY");
  expect(fake.calls).toContain("encryptStringAsync");
  expect(await store.status()).toEqual({
    protection: "system",
    loaded: true,
    replacementPending: false,
    passphraseRequired: false,
  });
  expect(store.keys()).toEqual({ current: key, previous: null });
});

test("at the next start the key is decrypted once with decryptStringAsync, and not again", async () => {
  const fake = fakeSafeStorage();
  const created = await storeWith(fake).create({ kind: "system" });
  fake.calls.length = 0;

  const store = storeWith(fake);
  expect(await store.hasKey()).toBe(true);
  expect(await store.status()).toEqual({
    protection: "system",
    loaded: false,
    replacementPending: false,
    passphraseRequired: false,
  });
  expect(store.keys()).toBeNull();
  expect(fake.calls).toEqual([]);

  const keys = await store.load();
  expect(keys?.current.publicKey).toBe(created.publicKey);
  expect(keys?.previous).toBeNull();
  expect(fake.calls).toEqual(["decryptStringAsync"]);

  expect((await store.load())?.current).toBe(keys?.current);
  expect(store.keys()?.current).toBe(keys?.current);
  expect(fake.calls).toEqual(["decryptStringAsync"]);
});

test("a key is rewritten when decryptStringAsync reports shouldReEncrypt, and only then", async () => {
  const fake = fakeSafeStorage();
  const created = await storeWith(fake).create({ kind: "system" });
  const before = await readFile(path.join(folder, CURRENT_KEY_FILE), "utf8");

  await storeWith(fake).load();
  expect(await readFile(path.join(folder, CURRENT_KEY_FILE), "utf8")).toBe(
    before,
  );

  fake.state.reEncrypt = true;
  fake.calls.length = 0;
  const keys = await storeWith(fake).load();
  expect(keys?.current.publicKey).toBe(created.publicKey);
  expect(fake.calls).toEqual([
    "decryptStringAsync",
    "isAsyncEncryptionAvailable",
    "encryptStringAsync",
  ]);
  const after = await readFile(path.join(folder, CURRENT_KEY_FILE), "utf8");
  expect(after).not.toBe(before);
  expect(await publicKeyInFile(fake)).toBe(created.publicKey);
  expect(await readdir(folder)).toEqual([CURRENT_KEY_FILE]);

  fake.state.reEncrypt = false;
  expect((await storeWith(fake).load())?.current.publicKey).toBe(
    created.publicKey,
  );
});

test("a rewrite that fails keeps the old file, is reported, and does not stop the start", async () => {
  const fake = fakeSafeStorage();
  const created = await storeWith(fake).create({ kind: "system" });
  const before = await readFile(path.join(folder, CURRENT_KEY_FILE), "utf8");
  fake.state.reEncrypt = true;
  fake.state.failEncrypt = true;
  const reported: string[] = [];

  const keys = await storeWith(fake, {
    onError: (message) => {
      reported.push(message);
      throw new Error("the receiver fails too");
    },
  }).load();

  expect(keys?.current.publicKey).toBe(created.publicKey);
  expect(reported).toEqual(["The device key could not be encrypted again."]);
  expect(await readFile(path.join(folder, CURRENT_KEY_FILE), "utf8")).toBe(
    before,
  );
});

test("on Linux a rewrite is skipped when the system no longer confirms a secret service", async () => {
  const fake = fakeSafeStorage({ backend: "kwallet6" });
  await storeWith(fake, { platform: "linux" }).create({ kind: "system" });
  const before = await readFile(path.join(folder, CURRENT_KEY_FILE), "utf8");
  fake.state.reEncrypt = true;
  fake.state.backend = "basic_text";
  fake.calls.length = 0;

  await storeWith(fake, { platform: "linux" }).load();

  expect(fake.calls).toEqual([
    "decryptStringAsync",
    "isAsyncEncryptionAvailable",
    "getSelectedStorageBackend",
  ]);
  expect(await readFile(path.join(folder, CURRENT_KEY_FILE), "utf8")).toBe(
    before,
  );
});

test("the system protects keys on Windows and macOS, and on Linux only with a secret service", async () => {
  for (const platform of ["win32", "darwin"] as const) {
    const fake = fakeSafeStorage({ backend: "basic_text" });
    expect(await storeWith(fake, { platform }).systemProtection()).toEqual({
      available: true,
    });
    // The Linux backend is never asked on another platform.
    expect(fake.calls).toEqual(["isAsyncEncryptionAvailable"]);
  }
  for (const backend of [
    "gnome_libsecret",
    "kwallet",
    "kwallet5",
    "kwallet6",
  ]) {
    const fake = fakeSafeStorage({ backend });
    expect(
      await storeWith(fake, { platform: "linux" }).systemProtection(),
    ).toEqual({ available: true });
    // On Linux a probe shows which key the asynchronous encryptor uses.
    expect(fake.calls).toEqual([
      "isAsyncEncryptionAvailable",
      "getSelectedStorageBackend",
      "encryptStringAsync",
    ]);
  }
  expect(
    await storeWith(fakeSafeStorage({ backend: "basic_text" }), {
      platform: "linux",
    }).systemProtection(),
  ).toEqual({
    available: false,
    reason: "no_secret_service",
    fallbackAllowed: true,
  });
  for (const backend of ["unknown", "something_new"]) {
    expect(
      await storeWith(fakeSafeStorage({ backend }), {
        platform: "linux",
      }).systemProtection(),
    ).toEqual({
      available: false,
      reason: "secret_service_unconfirmed",
      fallbackAllowed: true,
    });
  }
  for (const platform of ["win32", "darwin", "linux"] as const) {
    expect(
      await storeWith(fakeSafeStorage({ available: false }), {
        platform,
      }).systemProtection(),
    ).toEqual({
      available: false,
      reason: "encryption_unavailable",
      // Only Linux may fall back to a passphrase or an unprotected key.
      fallbackAllowed: platform === "linux",
    });
  }
  const failing = fakeSafeStorage();
  failing.state.failEncrypt = true;
  expect(
    await storeWith(failing, { platform: "linux" }).systemProtection(),
  ).toEqual({
    available: false,
    reason: "encryption_unavailable",
    fallbackAllowed: true,
  });
});

test("on Linux a ciphertext of Chromium's fixed key (v10) does not count as a secret service, whatever the backend says", async () => {
  const fake = fakeSafeStorage({ backend: "gnome_libsecret" });
  fake.state.prefix = "v10";
  const store = storeWith(fake, { platform: "linux" });

  expect(await store.systemProtection()).toEqual({
    available: false,
    reason: "secret_service_unconfirmed",
    fallbackAllowed: true,
  });
  await expectRejection(
    () => store.create({ kind: "system" }),
    "system_protection_unavailable",
  );
  expect(await readdir(root)).toEqual([]);

  // The passphrase choice applies instead.
  await store.create({ kind: "passphrase", passphrase: PASSPHRASE });
  expect((await keyFileJson())["protection"]).toBe("passphrase");
  // A replacement stays with the passphrase while the fixed key is in use.
  await store.replace();
  expect((await keyFileJson())["protection"]).toBe("passphrase");
});

test("on Linux a key is never written with a v10 ciphertext, even when the probe a moment before passed", async () => {
  const fake = fakeSafeStorage({ backend: "kwallet6" });
  fake.state.nextPrefixes = ["v11", "v10"];
  const store = storeWith(fake, { platform: "linux" });

  await expectRejection(
    () => store.create({ kind: "system" }),
    "system_protection_unavailable",
  );

  expect(fake.calls.filter((call) => call === "encryptStringAsync")).toEqual([
    "encryptStringAsync",
    "encryptStringAsync",
  ]);
  expect(await readdir(root)).toEqual([]);
  expect(store.keys()).toBeNull();
});

test("on Linux a rewrite after shouldReEncrypt is not written with a v10 ciphertext", async () => {
  const fake = fakeSafeStorage({ backend: "gnome_libsecret" });
  await storeWith(fake, { platform: "linux" }).create({ kind: "system" });
  const before = await readFile(path.join(folder, CURRENT_KEY_FILE), "utf8");
  fake.state.reEncrypt = true;
  fake.state.nextPrefixes = ["v11", "v10"];
  const reported: string[] = [];

  const keys = await storeWith(fake, {
    platform: "linux",
    onError: (message) => reported.push(message),
  }).load();

  expect(keys).not.toBeNull();
  expect(reported).toEqual(["The device key could not be encrypted again."]);
  expect(await readFile(path.join(folder, CURRENT_KEY_FILE), "utf8")).toBe(
    before,
  );
});

test("on Linux without a secret service a key is protected by a passphrase, and a wrong passphrase is refused", async () => {
  const fake = fakeSafeStorage({ backend: "basic_text" });
  const store = storeWith(fake, { platform: "linux" });

  await expectRejection(
    () => store.create({ kind: "system" }),
    "system_protection_unavailable",
  );
  await expectRejection(
    () => store.create({ kind: "passphrase", passphrase: "" }),
    "passphrase_invalid",
  );
  expect(await store.hasKey()).toBe(false);
  const created = await store.create({
    kind: "passphrase",
    passphrase: PASSPHRASE,
  });

  expect(fake.calls).not.toContain("encryptStringAsync");
  const raw = await readFile(path.join(folder, CURRENT_KEY_FILE), "utf8");
  expect(raw).not.toContain(PASSPHRASE);
  expect(raw).not.toContain(created.publicKey);
  expect(await keyFileJson()).toMatchObject({
    protection: "passphrase",
    kdf: "scrypt",
    cipher: "aes-256-gcm",
  });

  const restarted = storeWith(fake, { platform: "linux" });
  expect(await restarted.status()).toEqual({
    protection: "passphrase",
    loaded: false,
    replacementPending: false,
    passphraseRequired: true,
  });
  await expectRejection(() => restarted.load(), "passphrase_required");
  const wrong = await rejectionOf(() =>
    restarted.load({ passphrase: "wrong passphrase" }),
  );
  expect(isDeviceKeyError(wrong, "wrong_passphrase")).toBe(true);
  expect((wrong as Error).message).not.toContain("wrong passphrase");
  expect(restarted.keys()).toBeNull();

  const keys = await restarted.load({ passphrase: PASSPHRASE });
  expect(keys?.current.publicKey).toBe(created.publicKey);
  expect(fake.calls).not.toContain("decryptStringAsync");
  expect(await restarted.status()).toMatchObject({
    loaded: true,
    passphraseRequired: false,
  });
});

test("on Linux a passphrase or an unprotected key is refused while the system protects keys", async () => {
  const store = storeWith(fakeSafeStorage(), { platform: "linux" });
  await expectRejection(
    () => store.create({ kind: "passphrase", passphrase: PASSPHRASE }),
    "system_protection_available",
  );
  await expectRejection(
    () => store.create({ kind: "unprotected", acceptsUnprotectedKey: true }),
    "system_protection_available",
  );
  expect(await readdir(root)).toEqual([]);
});

test("on Windows and macOS only the system protects a key, also when it cannot", async () => {
  for (const platform of ["win32", "darwin"] as const) {
    for (const available of [true, false]) {
      const fake = fakeSafeStorage({ available, backend: "basic_text" });
      const store = storeWith(fake, { platform });
      await expectRejection(
        () => store.create({ kind: "passphrase", passphrase: PASSPHRASE }),
        "system_protection_required",
      );
      await expectRejection(
        () =>
          store.create({ kind: "unprotected", acceptsUnprotectedKey: true }),
        "system_protection_required",
      );
      if (!available) {
        // For example a denied or locked Keychain: the screens tell the
        // person to fix it.
        await expectRejection(
          () => store.create({ kind: "system" }),
          "system_protection_unavailable",
        );
      }
      expect(fake.calls).not.toContain("encryptStringAsync");
    }
  }
  expect(await readdir(root)).toEqual([]);
});

test("on Windows and macOS a key file protected by a passphrase or unprotected is refused, and no replacement inherits it", async () => {
  const linux = fakeSafeStorage({ backend: "basic_text" });
  const planted = path.join(root, "planted");
  for (const protection of ["passphrase", "unprotected"] as const) {
    await rm(folder, { recursive: true, force: true });
    await storeWith(linux, { platform: "linux" }).create(
      protection === "passphrase"
        ? { kind: "passphrase", passphrase: PASSPHRASE }
        : { kind: "unprotected", acceptsUnprotectedKey: true },
    );
    await rm(planted, { force: true });
    await rename(path.join(folder, CURRENT_KEY_FILE), planted);

    for (const platform of ["win32", "darwin"] as const) {
      for (const name of [CURRENT_KEY_FILE, PREVIOUS_KEY_FILE]) {
        await rm(folder, { recursive: true, force: true });
        await mkdir(folder);
        await copyFile(planted, path.join(folder, name));
        const fake = fakeSafeStorage();
        const store = storeWith(fake, { platform });

        await expectRejection(() => store.status(), "corrupt");
        await expectRejection(
          () => store.load({ passphrase: PASSPHRASE }),
          "corrupt",
        );
        await expectRejection(() => store.replace(), "not_loaded");
        expect(store.keys()).toBeNull();
        expect(await readdir(folder)).toEqual([name]);
      }
    }
  }
});

test("an unprotected key needs the explicit choice and is stored for its owner only", async () => {
  const fake = fakeSafeStorage({ backend: "basic_text" });
  const store = storeWith(fake, { platform: "linux" });

  for (const choice of [false, undefined, "true"]) {
    await expectRejection(
      () =>
        store.create({
          kind: "unprotected",
          acceptsUnprotectedKey: choice as true,
        }),
      "unprotected_not_accepted",
    );
  }
  const created = await store.create({
    kind: "unprotected",
    acceptsUnprotectedKey: true,
  });

  expect(Object.keys(await keyFileJson())).toEqual([
    "format",
    "version",
    "protection",
    "pkcs8",
  ]);
  expect(await store.status()).toMatchObject({ protection: "unprotected" });
  const keys = await storeWith(fake, { platform: "linux" }).load();
  expect(keys?.current.publicKey).toBe(created.publicKey);
});

test.skipIf(process.platform === "win32")(
  "key files have mode 0600 and a new key folder mode 0700 on Linux and macOS",
  async () => {
    // The store's rules for Linux, on the real file system of this Linux or
    // macOS machine: an unprotected key exists on Linux only.
    const fake = fakeSafeStorage({ backend: "basic_text" });
    const store = storeWith(fake, { platform: "linux" });
    await store.create({ kind: "unprotected", acceptsUnprotectedKey: true });

    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(folder, CURRENT_KEY_FILE))).mode & 0o777).toBe(
      0o600,
    );

    await store.replace({ acceptsUnprotectedKey: true });
    for (const name of [CURRENT_KEY_FILE, PREVIOUS_KEY_FILE]) {
      expect((await stat(path.join(folder, name))).mode & 0o777).toBe(0o600);
    }
  },
);

test("a replacement keeps the previous key until one authentication with the new key is confirmed", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);
  const first = await store.create({ kind: "system" });

  const replaced = await store.replace();

  expect(replaced.previous).toBe(first);
  expect(replaced.current.publicKey).not.toBe(first.publicKey);
  expect((await readdir(folder)).sort()).toEqual([
    CURRENT_KEY_FILE,
    PREVIOUS_KEY_FILE,
  ]);
  expect(await publicKeyInFile(fake)).toBe(replaced.current.publicKey);
  expect(await publicKeyInFile(fake, PREVIOUS_KEY_FILE)).toBe(first.publicKey);
  expect(await store.status()).toEqual({
    protection: "system",
    loaded: true,
    replacementPending: true,
    passphraseRequired: false,
  });

  // A sign-in of an existing device signs the same input with both keys.
  const input = signInInput(replaced.current.publicKey, DEVICE_ID);
  for (const key of [replaced.current, first]) {
    const signature = key.sign(input);
    expect(signature).toMatch(DEVICE_SIGNATURE_PATTERN);
    expect(verifies(input, key.publicKey, signature)).toBe(true);
  }

  await expectRejection(() => store.replace(), "replacement_pending");

  // After a restart the new key is still tried first, and the previous key
  // is still kept.
  const restarted = storeWith(fake);
  expect(await restarted.status()).toMatchObject({ replacementPending: true });
  const loaded = await restarted.load();
  expect(loaded?.current.publicKey).toBe(replaced.current.publicKey);
  expect(loaded?.previous?.publicKey).toBe(first.publicKey);

  await restarted.confirmReplacement();

  expect(await readdir(folder)).toEqual([CURRENT_KEY_FILE]);
  expect(restarted.keys()?.previous).toBeNull();
  expectRetired(loaded?.previous as DeviceKey);
  expect(
    verifies(
      signInInput(replaced.current.publicKey),
      replaced.current.publicKey,
      (loaded?.current as DeviceKey).sign(
        signInInput(replaced.current.publicKey),
      ),
    ),
  ).toBe(true);
  await expectRejection(() => restarted.confirmReplacement(), "no_replacement");
  await expectRejection(() => restarted.abandonReplacement(), "no_replacement");

  const final = await storeWith(fake).load();
  expect(final?.current.publicKey).toBe(replaced.current.publicKey);
  expect(final?.previous).toBeNull();
});

test("abandoning a replacement makes the previous key current again and drops the new one", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);
  const first = await store.create({ kind: "system" });
  const replaced = await store.replace();

  await store.abandonReplacement();

  expect(store.keys()).toEqual({ current: first, previous: null });
  expectRetired(replaced.current);
  expect(await readdir(folder)).toEqual([CURRENT_KEY_FILE]);
  expect(await publicKeyInFile(fake)).toBe(first.publicKey);
  expect((await storeWith(fake).load())?.current.publicKey).toBe(
    first.publicKey,
  );
  // The next sign-in can replace the key again.
  expect((await store.replace()).previous).toBe(first);
});

test("a replacement needs a loaded key", async () => {
  const fake = fakeSafeStorage();
  await storeWith(fake).create({ kind: "system" });

  const restarted = storeWith(fake);
  await expectRejection(() => restarted.replace(), "not_loaded");
  await expectRejection(() => restarted.confirmReplacement(), "not_loaded");
  await expectRejection(() => restarted.abandonReplacement(), "not_loaded");
});

test("a replacement that stopped between its two renames leaves the previous key as the current one", async () => {
  const fake = fakeSafeStorage();
  const first = await storeWith(fake).create({ kind: "system" });
  await rename(
    path.join(folder, CURRENT_KEY_FILE),
    path.join(folder, PREVIOUS_KEY_FILE),
  );

  const store = storeWith(fake);
  expect(await store.hasKey()).toBe(true);
  expect(await store.status()).toEqual({
    protection: "system",
    loaded: false,
    replacementPending: false,
    passphraseRequired: false,
  });
  await expectRejection(() => store.create({ kind: "system" }), "key_exists");
  const keys = await store.load();

  expect(keys?.current.publicKey).toBe(first.publicKey);
  expect(keys?.previous).toBeNull();
  expect(await readdir(folder)).toEqual([CURRENT_KEY_FILE]);
});

test("a replacement whose write fails keeps the current key, on disk and in memory", async () => {
  const fake = fakeSafeStorage();
  let failWrites = false;
  const fileSystem: KeyFileSystem = {
    ...nodeKeyFileSystem,
    open: async (file, flags, mode) => {
      if (failWrites && flags === "wx") {
        const handle = await nodeKeyFileSystem.open(file, flags, mode);
        return {
          writeFile: async (data: Uint8Array) => {
            await handle.writeFile(data.subarray(0, 10));
            throw new Error("disk full");
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      }
      return nodeKeyFileSystem.open(file, flags, mode);
    },
  };
  const store = storeWith(fake, { fileSystem });
  const first = await store.create({ kind: "system" });

  failWrites = true;
  await expect(store.replace()).rejects.toThrow("disk full");

  expect(store.keys()).toEqual({ current: first, previous: null });
  expect(await readdir(folder)).toEqual([CURRENT_KEY_FILE]);
  expect(await publicKeyInFile(fake)).toBe(first.publicKey);
  failWrites = false;
  expect((await store.replace()).previous).toBe(first);
});

test("a passphrase key is replaced without asking for the passphrase again", async () => {
  const fake = fakeSafeStorage({ backend: "basic_text" });
  const store = storeWith(fake, { platform: "linux" });
  const first = await store.create({
    kind: "passphrase",
    passphrase: PASSPHRASE,
  });

  const replaced = await store.replace();

  const current = await keyFileJson(CURRENT_KEY_FILE);
  const previous = await keyFileJson(PREVIOUS_KEY_FILE);
  expect(current["protection"]).toBe("passphrase");
  expect(current["salt"]).toBe(previous["salt"]);
  expect(current["nonce"]).not.toBe(previous["nonce"]);
  const keys = await storeWith(fake, { platform: "linux" }).load({
    passphrase: PASSPHRASE,
  });
  expect(keys?.current.publicKey).toBe(replaced.current.publicKey);
  expect(keys?.previous?.publicKey).toBe(first.publicKey);
});

test("an unprotected key is renewed as an unprotected key only with a fresh explicit choice", async () => {
  const fake = fakeSafeStorage({ backend: "basic_text" });
  const store = storeWith(fake, { platform: "linux" });
  const first = await store.create({
    kind: "unprotected",
    acceptsUnprotectedKey: true,
  });

  for (const options of [
    undefined,
    {},
    { acceptsUnprotectedKey: false as unknown as true },
  ]) {
    await expectRejection(
      () => store.replace(options),
      "unprotected_not_accepted",
    );
  }
  expect(store.keys()).toEqual({ current: first, previous: null });
  expect(await readdir(folder)).toEqual([CURRENT_KEY_FILE]);

  await store.replace({ acceptsUnprotectedKey: true });

  expect((await keyFileJson())["protection"]).toBe("unprotected");
});

test("on Linux a replacement moves a passphrase key up to the system once a secret service appears", async () => {
  const fake = fakeSafeStorage({ backend: "basic_text" });
  const store = storeWith(fake, { platform: "linux" });
  const first = await store.create({
    kind: "passphrase",
    passphrase: PASSPHRASE,
  });
  fake.state.backend = "gnome_libsecret";

  const replaced = await store.replace();

  expect((await keyFileJson(CURRENT_KEY_FILE))["protection"]).toBe("system");
  expect(await publicKeyInFile(fake)).toBe(replaced.current.publicKey);
  // The previous key keeps its passphrase until the replacement is
  // confirmed, so a start in between still asks for it.
  expect((await keyFileJson(PREVIOUS_KEY_FILE))["protection"]).toBe(
    "passphrase",
  );
  const restarted = storeWith(fake, { platform: "linux" });
  expect(await restarted.status()).toEqual({
    protection: "system",
    loaded: false,
    replacementPending: true,
    passphraseRequired: true,
  });
  await expectRejection(() => restarted.load(), "passphrase_required");
  const keys = await restarted.load({ passphrase: PASSPHRASE });
  expect(keys?.current.publicKey).toBe(replaced.current.publicKey);
  expect(keys?.previous?.publicKey).toBe(first.publicKey);

  await restarted.confirmReplacement();

  const final = storeWith(fake, { platform: "linux" });
  expect(await final.status()).toMatchObject({
    protection: "system",
    passphraseRequired: false,
  });
  expect((await final.load())?.current.publicKey).toBe(
    replaced.current.publicKey,
  );
});

test("on Linux a replacement moves an unprotected key up to the system without a new choice", async () => {
  const fake = fakeSafeStorage({ backend: "basic_text" });
  const store = storeWith(fake, { platform: "linux" });
  await store.create({ kind: "unprotected", acceptsUnprotectedKey: true });
  fake.state.backend = "kwallet6";

  const replaced = await store.replace();

  expect((await keyFileJson())["protection"]).toBe("system");
  expect(await publicKeyInFile(fake)).toBe(replaced.current.publicKey);
  await store.confirmReplacement();
  expect(await readdir(folder)).toEqual([CURRENT_KEY_FILE]);
});

test("a moved-up key that is abandoned keeps its passphrase for the next replacement, also after a restart", async () => {
  const fake = fakeSafeStorage({ backend: "basic_text" });
  const first = await storeWith(fake, { platform: "linux" }).create({
    kind: "passphrase",
    passphrase: PASSPHRASE,
  });
  const salt = (await keyFileJson())["salt"];
  fake.state.backend = "gnome_libsecret";
  const mover = storeWith(fake, { platform: "linux" });
  await mover.load({ passphrase: PASSPHRASE });
  await mover.replace();

  const restarted = storeWith(fake, { platform: "linux" });
  await restarted.load({ passphrase: PASSPHRASE });
  await restarted.abandonReplacement();
  expect(restarted.keys()?.current.publicKey).toBe(first.publicKey);
  fake.state.backend = "basic_text";

  const replaced = await restarted.replace();

  const current = await keyFileJson(CURRENT_KEY_FILE);
  expect(current["protection"]).toBe("passphrase");
  expect(current["salt"]).toBe(salt);
  const keys = await storeWith(fake, { platform: "linux" }).load({
    passphrase: PASSPHRASE,
  });
  expect(keys?.current.publicKey).toBe(replaced.current.publicKey);
  expect(keys?.previous?.publicKey).toBe(first.publicKey);
});

test("on Windows every rename is flushed before replace and abandonReplacement resolve", async () => {
  const fake = fakeSafeStorage();
  const calls: string[] = [];
  const fileSystem: KeyFileSystem = {
    ...nodeKeyFileSystem,
    open: async (file, flags, mode) => {
      const handle = await nodeKeyFileSystem.open(file, flags, mode);
      const name = path.basename(file).replace(/\.[0-9a-f]{16}\.tmp$/, ".tmp");
      calls.push(`open ${name} ${flags}`);
      return {
        writeFile: (data: Uint8Array) => handle.writeFile(data),
        sync: async () => {
          calls.push(`sync ${name}`);
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
    rename: async (from, to) => {
      calls.push(`rename ${path.basename(to)}`);
      await nodeKeyFileSystem.rename(from, to);
    },
  };
  const store = storeWith(fake, { platform: "win32", fileSystem });
  await store.create({ kind: "system" });
  calls.length = 0;

  await store.replace();

  expect(calls).toEqual([
    `rename ${PREVIOUS_KEY_FILE}`,
    `open ${PREVIOUS_KEY_FILE} r+`,
    `sync ${PREVIOUS_KEY_FILE}`,
    `open ${CURRENT_KEY_FILE}.tmp wx`,
    `sync ${CURRENT_KEY_FILE}.tmp`,
    `rename ${CURRENT_KEY_FILE}`,
    `open ${CURRENT_KEY_FILE} r+`,
    `sync ${CURRENT_KEY_FILE}`,
  ]);

  calls.length = 0;
  await store.abandonReplacement();
  expect(calls).toEqual([
    `rename ${CURRENT_KEY_FILE}`,
    `open ${CURRENT_KEY_FILE} r+`,
    `sync ${CURRENT_KEY_FILE}`,
  ]);
});

test("a system-protected key is not replaced once the system cannot protect keys", async () => {
  const fake = fakeSafeStorage({ backend: "kwallet5" });
  const store = storeWith(fake, { platform: "linux" });
  const first = await store.create({ kind: "system" });
  fake.state.backend = "basic_text";

  await expectRejection(() => store.replace(), "system_protection_unavailable");

  expect(store.keys()).toEqual({ current: first, previous: null });
  expect(await readdir(folder)).toEqual([CURRENT_KEY_FILE]);
});

test("delete removes the key files and temporary files, and the keys held sign nothing more", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);
  await store.create({ kind: "system" });
  const { current, previous } = await store.replace();
  const leftover = `${CURRENT_KEY_FILE}.0123456789abcdef.tmp`;
  await writeFile(path.join(folder, leftover), "partial");
  await writeFile(path.join(folder, "Preferences"), "{}");

  await store.delete();

  expect(await readdir(folder)).toEqual(["Preferences"]);
  expect(store.keys()).toBeNull();
  expect(await store.status()).toEqual({ protection: "none" });
  expect(await store.hasKey()).toBe(false);
  expectRetired(current);
  expectRetired(previous as DeviceKey);
  // A new key pair can be created afterwards.
  await store.create({ kind: "system" });
  expect((await readdir(folder)).sort()).toEqual(
    [CURRENT_KEY_FILE, "Preferences"].sort(),
  );
});

test("delete works without loading the key, for a key that cannot be opened any more", async () => {
  const fake = fakeSafeStorage({ backend: "basic_text" });
  await storeWith(fake, { platform: "linux" }).create({
    kind: "passphrase",
    passphrase: PASSPHRASE,
  });

  const store = storeWith(fake, { platform: "linux" });
  await expectRejection(
    () => store.load({ passphrase: "forgotten" }),
    "wrong_passphrase",
  );
  await store.delete();

  expect(await readdir(folder)).toEqual([]);
  await store.delete();
});

test("a delete that stops halfway leaves the newest key, never the previous one alone", async () => {
  const fake = fakeSafeStorage();
  let unlinks = 0;
  const fileSystem: KeyFileSystem = {
    ...nodeKeyFileSystem,
    unlink: async (file) => {
      unlinks += 1;
      if (unlinks === 2) {
        throw new Error("unlink failed");
      }
      await nodeKeyFileSystem.unlink(file);
    },
  };
  const store = storeWith(fake, { fileSystem });
  await store.create({ kind: "system" });
  const { current } = await store.replace();

  await expect(store.delete()).rejects.toThrow("unlink failed");

  // A lone previous key would become the current key again at the next
  // start; the newest key is what stays.
  expect(await readdir(folder)).toEqual([CURRENT_KEY_FILE]);
  expect(await publicKeyInFile(fake)).toBe(current.publicKey);
  await store.delete();
  expect(await readdir(folder)).toEqual([]);
});

test("load removes temporary files that a stopped write left, and nothing else", async () => {
  const fake = fakeSafeStorage();
  await storeWith(fake).create({ kind: "system" });
  const names = [
    `${CURRENT_KEY_FILE}.0123456789abcdef.tmp`,
    `${PREVIOUS_KEY_FILE}.fedcba9876543210.tmp`,
    `${CURRENT_KEY_FILE}.backup`,
  ];
  for (const name of names) {
    await writeFile(path.join(folder, name), "partial");
  }

  await storeWith(fake).load();

  expect((await readdir(folder)).sort()).toEqual(
    [CURRENT_KEY_FILE, `${CURRENT_KEY_FILE}.backup`].sort(),
  );
});

test("a second key is never created over an existing one", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);
  await store.create({ kind: "system" });

  await expectRejection(() => store.create({ kind: "system" }), "key_exists");
  await expectRejection(
    () => storeWith(fake).create({ kind: "system" }),
    "key_exists",
  );
});

test("a damaged, newer, or undecryptable key file is reported and never replaced on its own", async () => {
  const fake = fakeSafeStorage();
  const file = path.join(folder, CURRENT_KEY_FILE);
  await storeWith(fake).create({ kind: "system" });
  const valid = await readFile(file, "utf8");

  fake.state.failDecrypt = true;
  await expectRejection(() => storeWith(fake).load(), "unreadable");
  fake.state.failDecrypt = false;

  await writeFile(file, "damaged");
  const store = storeWith(fake);
  expect(await store.hasKey()).toBe(true);
  await expectRejection(() => store.status(), "corrupt");
  await expectRejection(() => store.load(), "corrupt");
  await expectRejection(() => store.create({ kind: "system" }), "key_exists");

  await writeFile(
    file,
    JSON.stringify({
      format: "mymandev-device-key",
      version: 2,
      protection: "system",
      ciphertext: "AAAA",
    }),
  );
  await expectRejection(() => storeWith(fake).load(), "newer_format");

  // A file of the right format that does not hold an Ed25519 key.
  const notAKey = await fake.safeStorage.encryptStringAsync(
    Buffer.from("not a key").toString("base64"),
  );
  await writeFile(
    file,
    JSON.stringify({
      ...(JSON.parse(valid) as object),
      ciphertext: notAKey.toString("base64url"),
    }),
  );
  await expectRejection(() => storeWith(fake).load(), "corrupt");
  expect(await readdir(folder)).toEqual([CURRENT_KEY_FILE]);
});

test("operations run one after the other, in the order they were called", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);

  const results = await Promise.allSettled([
    store.create({ kind: "system" }),
    store.create({ kind: "system" }),
    store.replace(),
    store.confirmReplacement(),
  ]);

  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
    "fulfilled",
    "fulfilled",
  ]);
  expect(
    isDeviceKeyError(
      (results[1] as PromiseRejectedResult).reason,
      "key_exists",
    ),
  ).toBe(true);
  expect(await readdir(folder)).toEqual([CURRENT_KEY_FILE]);
});

const moduleFolder = path.dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(moduleFolder)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({
    name,
    text: readFileSync(path.join(moduleFolder, name), "utf8"),
  }));

test("the module never calls the synchronous safeStorage API and never logs", () => {
  expect(sources.map(({ name }) => name).sort()).toEqual([
    "atomic-file.ts",
    "errors.ts",
    "key-file.ts",
    "key-folder.ts",
    "signing-key.ts",
    "store.ts",
    "system.ts",
  ]);
  for (const { name, text } of sources) {
    expect(text, name).not.toMatch(
      /\b(?:encryptString|decryptString|isEncryptionAvailable|setUsePlainTextEncryption)\b/,
    );
    expect(text, name).not.toMatch(/\bconsole\./);
  }
});

test("neither the renderer nor the preload script nor the IPC contract reaches the device key", () => {
  const src = path.resolve(moduleFolder, "..", "..");
  const files = ["preload", "renderer", "shared"].flatMap((side) =>
    readdirSync(path.join(src, side), { recursive: true })
      .map(String)
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => path.join(src, side, name)),
  );

  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(readFileSync(file, "utf8"), file).not.toMatch(/device-key/);
  }
});
