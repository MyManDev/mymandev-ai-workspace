import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { PROVIDER_KEY_LIMITS } from "../../shared/ipc-contract.ts";
import { nodeKeyFileSystem } from "../device-key/atomic-file.ts";
import { DeviceKeyError } from "../device-key/errors.ts";
import type { SystemKeyProtection } from "../device-key/store.ts";
import {
  isProviderKeyError,
  PROVIDER_KEY_ERROR_CODES,
  ProviderKeyError,
  type ProviderKeyErrorCode,
} from "./errors.ts";
import {
  encodeProviderKeyPayload,
  isProviderKeyShape,
  PROVIDER_KEY_FILE_FORMAT,
  PROVIDER_KEY_FILE_VERSION,
  PROVIDER_KEY_PAYLOAD_FORMAT,
  PROVIDER_KEY_PAYLOAD_VERSION,
  type ProviderKeyBinding,
} from "./key-file.ts";
import type { ClaudeModel } from "./models.ts";
import {
  createProviderKeyStore,
  nodeProviderKeyFileSystem,
  PROVIDER_KEY_FOLDER,
  type ProviderKeyFileSystem,
  type ProviderKeyStoreOptions,
} from "./store.ts";

// The provider key store of #33: one API key per provider connection,
// encrypted with `safeStorage` in the device key's local data folder,
// bound to the device and the connection, with atomic writes, fail-closed
// protection, and errors that never hold a key.

/** An obvious fake key that no file, error, or log may hold in the clear. */
const SENTINEL_KEY = "FAKE-PROVIDER-KEY-SENTINEL-0123456789";
const OTHER_KEY = "FAKE-PROVIDER-KEY-REPLACEMENT-9876543210";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const OTHER_DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000014";
const CONNECTION_1 = "0192f0a0-7b3c-7d4e-8f50-000000000101";
const CONNECTION_2 = "0192f0a0-7b3c-7d4e-8f50-000000000102";

const BINDING_1: ProviderKeyBinding = Object.freeze({
  deviceId: DEVICE_ID,
  providerConnectionId: CONNECTION_1,
});
const BINDING_2: ProviderKeyBinding = Object.freeze({
  deviceId: DEVICE_ID,
  providerConnectionId: CONNECTION_2,
});

let root: string;
let keyFolder: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mymandev-provider-key-"));
  keyFolder = path.join(root, "MyManDev", PROVIDER_KEY_FOLDER);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A fake `safeStorage` with the asynchronous API only, as in the device key
 * tests. It really encrypts, with AES-256-GCM under a key of its own, so a
 * changed ciphertext fails to decrypt and a file never holds the key in the
 * clear.
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
    prefix: "v11",
  };
  const encrypt = (plainText: string): Buffer => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", secret, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(plainText, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([
      Buffer.from(state.prefix, "ascii"),
      nonce,
      ciphertext,
      cipher.getAuthTag(),
    ]);
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
        // A system error could quote what it was given; the store must
        // never pass it on.
        return Promise.reject(new Error(`encryption failed: ${plainText}`));
      }
      return Promise.resolve(encrypt(plainText));
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
  return { safeStorage, calls, state, encrypt, decrypt };
}

type FakeSafeStorage = ReturnType<typeof fakeSafeStorage>;

function storeWith(
  fake: FakeSafeStorage,
  options: Partial<ProviderKeyStoreOptions> = {},
) {
  return createProviderKeyStore({
    folder: () => path.join(root, "MyManDev"),
    platform: "win32",
    systemProtection: fake.safeStorage,
    ...options,
  });
}

function keyFile(connection: string = CONNECTION_1): string {
  return path.join(keyFolder, `${connection}.json`);
}

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Every error of a test, to check at the end that none names the key. */
const seenErrors: unknown[] = [];

async function expectRejection(
  action: () => Promise<unknown>,
  code: ProviderKeyErrorCode,
): Promise<void> {
  const error = await rejectionOf(action);
  seenErrors.push(error);
  expect(isProviderKeyError(error, code), String(error)).toBe(true);
}

/** Everything about an error that a log or a crash report could show. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return [
    String(error),
    error.message,
    error.stack ?? "",
    JSON.stringify(error),
    String(error.cause),
  ].join("\n");
}

test("a key round-trips with its model: the file holds one ciphertext, never the key, the model, or an ID in the clear, and the payload binds the device and the connection", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);
  expect(await store.check(BINDING_1)).toEqual({ key: "missing" });
  await expectRejection(() => store.read(BINDING_1), "missing");

  await store.save(BINDING_1, SENTINEL_KEY, "claude-sonnet-5-5");

  expect(await readdir(keyFolder)).toEqual([`${CONNECTION_1}.json`]);
  const text = await readFile(keyFile(), "utf8");
  expect(text).not.toContain(SENTINEL_KEY);
  expect(text).not.toContain(DEVICE_ID);
  expect(text).not.toContain("claude");
  expect(text.endsWith("}\n")).toBe(true);
  const json = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(json)).toEqual(["format", "version", "ciphertext"]);
  expect(json["format"]).toBe(PROVIDER_KEY_FILE_FORMAT);
  // The file's own format is unchanged; only the payload has a new version.
  expect(json["version"]).toBe(PROVIDER_KEY_FILE_VERSION);
  expect(PROVIDER_KEY_FILE_VERSION).toBe(1);
  expect(PROVIDER_KEY_PAYLOAD_VERSION).toBe(2);
  const payload = JSON.parse(
    fake.decrypt(Buffer.from(json["ciphertext"] as string, "base64url")),
  ) as unknown;
  expect(payload).toEqual({
    format: PROVIDER_KEY_PAYLOAD_FORMAT,
    version: 2,
    deviceId: DEVICE_ID,
    providerConnectionId: CONNECTION_1,
    key: SENTINEL_KEY,
    model: "claude-sonnet-5-5",
  });
  expect(Object.keys(payload as object)).toEqual([
    "format",
    "version",
    "deviceId",
    "providerConnectionId",
    "key",
    "model",
  ]);

  expect(await store.check(BINDING_1)).toEqual({
    key: "ready",
    model: "claude-sonnet-5-5",
  });
  expect(await store.read(BINDING_1)).toEqual({
    key: SENTINEL_KEY,
    model: "claude-sonnet-5-5",
  });
  expect((await store.read(BINDING_1)).key).toBe(SENTINEL_KEY);
  // Each read decrypts again: nothing is cached.
  const decrypts = fake.calls.filter((call) => call === "decryptStringAsync");
  expect((await store.read(BINDING_1)).key).toBe(SENTINEL_KEY);
  expect(
    fake.calls.filter((call) => call === "decryptStringAsync").length,
  ).toBe(decrypts.length + 1);
  // The other connection has no key.
  expect(await store.check(BINDING_2)).toEqual({ key: "missing" });
});

test("on Linux and elsewhere the folders and the file are for their owner only", async () => {
  if (process.platform === "win32") {
    return;
  }
  const store = storeWith(fakeSafeStorage(), { platform: process.platform });
  await store.save(BINDING_1, SENTINEL_KEY, null);
  expect((await stat(keyFolder)).mode & 0o777).toBe(0o700);
  expect((await stat(keyFile())).mode & 0o777).toBe(0o600);
});

test("without the system's protection no key is stored, and nothing is encrypted or written", async () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const fake = fakeSafeStorage({ available: false });
    const store = storeWith(fake, { platform });
    await expectRejection(
      () => store.save(BINDING_1, SENTINEL_KEY, null),
      "system_protection_unavailable",
    );
    expect(await store.protection()).toEqual({
      available: false,
      reason: "encryption_unavailable",
    });
    expect(fake.calls).not.toContain("encryptStringAsync");
    await expect(readdir(keyFolder)).rejects.toThrow();
  }
});

test("on Linux a key is stored only with a confirmed secret service: basic_text, unknown, and other backends are refused (fail closed)", async () => {
  for (const [backend, reason] of [
    ["basic_text", "no_secret_service"],
    ["unknown", "secret_service_unconfirmed"],
    ["", "secret_service_unconfirmed"],
    ["something_new", "secret_service_unconfirmed"],
  ] as const) {
    const fake = fakeSafeStorage({ backend });
    const store = storeWith(fake, { platform: "linux" });
    expect(await store.protection(), backend).toEqual({
      available: false,
      reason,
    });
    await expectRejection(
      () => store.save(BINDING_1, SENTINEL_KEY, null),
      "system_protection_unavailable",
    );
    expect(fake.calls, backend).not.toContain("encryptStringAsync");
    await expect(readdir(keyFolder)).rejects.toThrow();
  }
  for (const backend of [
    "gnome_libsecret",
    "kwallet",
    "kwallet5",
    "kwallet6",
  ]) {
    const store = storeWith(fakeSafeStorage({ backend }), {
      platform: "linux",
    });
    expect(await store.protection(), backend).toEqual({ available: true });
    await store.save(BINDING_1, SENTINEL_KEY, null);
    expect((await store.read(BINDING_1)).key).toBe(SENTINEL_KEY);
  }
  // Windows and macOS never ask for a backend.
  for (const platform of ["win32", "darwin"] as const) {
    const fake = fakeSafeStorage({ backend: "basic_text" });
    const store = storeWith(fake, { platform });
    await store.save(BINDING_1, SENTINEL_KEY, null);
    expect(fake.calls).not.toContain("getSelectedStorageBackend");
  }
});

test("on Linux a ciphertext of Chromium's fixed key (v10) is never written, whatever the backend says", async () => {
  const fake = fakeSafeStorage({ backend: "gnome_libsecret" });
  const store = storeWith(fake, { platform: "linux" });
  await store.save(BINDING_1, OTHER_KEY, null);
  fake.state.prefix = "v10";
  await expectRejection(
    () => store.save(BINDING_1, SENTINEL_KEY, null),
    "system_protection_unavailable",
  );
  // The earlier key stays, and no temporary file is left.
  expect(await readdir(keyFolder)).toEqual([`${CONNECTION_1}.json`]);
  expect((await store.read(BINDING_1)).key).toBe(OTHER_KEY);
});

/** A key file as the store writes it, around `ciphertext`. */
function keyFileText(ciphertext: Buffer): string {
  return `${JSON.stringify({
    format: PROVIDER_KEY_FILE_FORMAT,
    version: 1,
    ciphertext: ciphertext.toString("base64url"),
  })}\n`;
}

test("on Linux a planted file of Chromium's fixed key (v10) is refused as corrupt before it is decrypted", async () => {
  const fake = fakeSafeStorage({ backend: "gnome_libsecret" });
  const store = storeWith(fake, { platform: "linux" });
  await store.save(BINDING_1, OTHER_KEY, null);
  // Whoever can write the file encrypts a key of their choice, bound to
  // this device and this connection, with the key that every Chromium
  // shares (`v10`); the fake decrypts it, as Chromium would.
  fake.state.prefix = "v10";
  await writeFile(
    keyFile(),
    keyFileText(
      fake.encrypt(encodeProviderKeyPayload(BINDING_1, SENTINEL_KEY, null)),
    ),
  );
  const decrypts = () =>
    fake.calls.filter((call) => call === "decryptStringAsync").length;
  const before = decrypts();
  await expectRejection(() => store.check(BINDING_1), "corrupt");
  await expectRejection(() => store.read(BINDING_1), "corrupt");
  // Without any prefix too.
  await writeFile(
    keyFile(),
    keyFileText(
      fake
        .encrypt(encodeProviderKeyPayload(BINDING_1, SENTINEL_KEY, null))
        .subarray(3),
    ),
  );
  await expectRejection(() => store.read(BINDING_1), "corrupt");
  expect(decrypts()).toBe(before);

  // Windows and macOS always protect a key; Chromium writes `v10` there.
  for (const platform of ["win32", "darwin"] as const) {
    const other = storeWith(fake, { platform });
    await other.save(BINDING_1, SENTINEL_KEY, null);
    expect((await other.read(BINDING_1)).key).toBe(SENTINEL_KEY);
  }

  // A key entered again on Linux replaces the planted file.
  fake.state.prefix = "v11";
  await store.save(BINDING_1, OTHER_KEY, null);
  expect((await store.read(BINDING_1)).key).toBe(OTHER_KEY);
});

test("a failing encryption is refused without its error, which could quote the payload", async () => {
  const fake = fakeSafeStorage();
  fake.state.failEncrypt = true;
  const store = storeWith(fake);
  const error = await rejectionOf(() =>
    store.save(BINDING_1, SENTINEL_KEY, null),
  );
  expect(isProviderKeyError(error, "system_protection_unavailable")).toBe(true);
  expect(errorText(error)).not.toContain(SENTINEL_KEY);
  expect((error as Error).cause).toBeUndefined();
});

test("a file of another device or another connection is refused", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);
  await store.save(BINDING_1, SENTINEL_KEY, null);

  // Another device asks for the same connection.
  const otherDevice = { ...BINDING_1, deviceId: OTHER_DEVICE_ID };
  await expectRejection(() => store.check(otherDevice), "bound_elsewhere");
  await expectRejection(() => store.read(otherDevice), "bound_elsewhere");

  // The file of connection 1 copied to the name of connection 2.
  await copyFile(keyFile(CONNECTION_1), keyFile(CONNECTION_2));
  await expectRejection(() => store.check(BINDING_2), "bound_elsewhere");
  await expectRejection(() => store.read(BINDING_2), "bound_elsewhere");

  // A file written on another device, with the same system key, as if the
  // folder had been copied there.
  await writeFile(
    keyFile(CONNECTION_1),
    `${JSON.stringify({
      format: PROVIDER_KEY_FILE_FORMAT,
      version: 1,
      ciphertext: fake
        .encrypt(
          encodeProviderKeyPayload(
            { deviceId: OTHER_DEVICE_ID, providerConnectionId: CONNECTION_1 },
            OTHER_KEY,
            "claude-opus-5-5",
          ),
        )
        .toString("base64url"),
    })}\n`,
  );
  await expectRejection(() => store.read(BINDING_1), "bound_elsewhere");
  // The original binding still opens the original file.
  await store.save(BINDING_1, SENTINEL_KEY, null);
  expect((await store.read(BINDING_1)).key).toBe(SENTINEL_KEY);
});

test("a tampered, damaged, or newer file is refused with a fixed code, and never with its content", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);
  await store.save(BINDING_1, SENTINEL_KEY, null);
  const original = JSON.parse(await readFile(keyFile(), "utf8")) as Record<
    string,
    unknown
  >;
  const ciphertext = Buffer.from(original["ciphertext"] as string, "base64url");
  const write = (value: unknown) =>
    writeFile(keyFile(), `${JSON.stringify(value)}\n`);

  // One flipped bit of the ciphertext fails to decrypt.
  const flipped = Buffer.from(ciphertext);
  flipped[20] = (flipped[20] ?? 0) ^ 0x01;
  await write({ ...original, ciphertext: flipped.toString("base64url") });
  await expectRejection(() => store.check(BINDING_1), "unreadable");

  // A ciphertext that decrypts to something that is not a payload.
  for (const plainText of [
    SENTINEL_KEY,
    "{",
    JSON.stringify({
      format: PROVIDER_KEY_PAYLOAD_FORMAT,
      version: 1,
      deviceId: DEVICE_ID,
      providerConnectionId: CONNECTION_1,
      key: SENTINEL_KEY,
      extra: true,
    }),
    JSON.stringify({
      format: PROVIDER_KEY_PAYLOAD_FORMAT,
      version: 1,
      deviceId: DEVICE_ID,
      providerConnectionId: CONNECTION_1,
      key: `${SENTINEL_KEY} with a space`,
    }),
  ]) {
    await write({
      ...original,
      ciphertext: fake.encrypt(plainText).toString("base64url"),
    });
    await expectRejection(() => store.read(BINDING_1), "corrupt");
  }
  await write({
    ...original,
    ciphertext: fake
      .encrypt(
        JSON.stringify({ format: PROVIDER_KEY_PAYLOAD_FORMAT, version: 3 }),
      )
      .toString("base64url"),
  });
  await expectRejection(() => store.read(BINDING_1), "newer_format");

  // The file itself.
  for (const value of [
    { ...original, extra: "x" },
    { format: PROVIDER_KEY_FILE_FORMAT, version: 1 },
    { ...original, format: "mymandev-device-key" },
    { ...original, ciphertext: "" },
    { ...original, ciphertext: `${original["ciphertext"] as string}=` },
    { ...original, ciphertext: "not base64url!" },
    [original],
    null,
  ]) {
    await write(value);
    await expectRejection(() => store.check(BINDING_1), "corrupt");
  }
  await writeFile(keyFile(), "not json");
  await expectRejection(() => store.check(BINDING_1), "corrupt");
  await writeFile(keyFile(), Buffer.from([0xff, 0xfe, 0x00]));
  await expectRejection(() => store.check(BINDING_1), "corrupt");
  await writeFile(keyFile(), "x".repeat(20_000));
  await expectRejection(() => store.check(BINDING_1), "corrupt");
  await write({ ...original, version: 2, more: "later" });
  await expectRejection(() => store.check(BINDING_1), "newer_format");

  // A damaged file is never replaced or deleted on its own; a new key
  // replaces it.
  expect(await readdir(keyFolder)).toEqual([`${CONNECTION_1}.json`]);
  await store.save(BINDING_1, OTHER_KEY, null);
  expect((await store.read(BINDING_1)).key).toBe(OTHER_KEY);
});

test("a key replaces the previous one atomically: a failed write keeps the previous file whole and leaves no temporary file", async () => {
  const fake = fakeSafeStorage();
  let failAt: "write" | "sync" | "rename" | null = null;
  const fileSystem: ProviderKeyFileSystem = {
    ...nodeProviderKeyFileSystem,
    open: async (file, flags, mode) => {
      const handle = await nodeKeyFileSystem.open(file, flags, mode);
      if (flags !== "wx") {
        return handle;
      }
      return {
        writeFile: async (data: Uint8Array) => {
          if (failAt === "write") {
            // Half of the new file reaches the temporary file.
            await handle.writeFile(data.subarray(0, 10));
            throw new Error("disk full");
          }
          await handle.writeFile(data);
        },
        sync: async () => {
          if (failAt === "sync") {
            throw new Error("I/O error");
          }
          await handle.sync();
        },
        close: () => handle.close(),
      };
    },
    rename: async (from, to) => {
      if (failAt === "rename") {
        throw new Error("rename failed");
      }
      await nodeKeyFileSystem.rename(from, to);
    },
  };
  const store = storeWith(fake, { fileSystem });
  await store.save(BINDING_1, OTHER_KEY, null);
  const before = await readFile(keyFile());

  for (const step of ["write", "sync", "rename"] as const) {
    failAt = step;
    const error = await rejectionOf(() =>
      store.save(BINDING_1, SENTINEL_KEY, null),
    );
    expect(isProviderKeyError(error, "write_failed"), step).toBe(true);
    expect(errorText(error)).not.toContain(SENTINEL_KEY);
    expect((error as Error).cause).toBeUndefined();
    expect(await readdir(keyFolder), step).toEqual([`${CONNECTION_1}.json`]);
    expect((await readFile(keyFile())).equals(before), step).toBe(true);
    expect((await store.read(BINDING_1)).key).toBe(OTHER_KEY);
  }

  failAt = null;
  await store.save(BINDING_1, SENTINEL_KEY, null);
  expect(await readdir(keyFolder)).toEqual([`${CONNECTION_1}.json`]);
  expect((await store.read(BINDING_1)).key).toBe(SENTINEL_KEY);
});

test("a key is rewritten when decryptStringAsync reports shouldReEncrypt, and a failed rewrite keeps the old file and is reported without the key", async () => {
  const fake = fakeSafeStorage();
  const reported: [string, unknown][] = [];
  const store = storeWith(fake, {
    onError: (message, error) => reported.push([message, error]),
  });
  await store.save(BINDING_1, SENTINEL_KEY, null);
  const first = await readFile(keyFile(), "utf8");
  fake.state.reEncrypt = true;
  expect((await store.read(BINDING_1)).key).toBe(SENTINEL_KEY);
  const second = await readFile(keyFile(), "utf8");
  expect(second).not.toBe(first);
  expect(reported).toEqual([]);

  fake.state.failEncrypt = true;
  expect(await store.check(BINDING_1)).toEqual({ key: "ready", model: null });
  expect(await readFile(keyFile(), "utf8")).toBe(second);
  expect(reported).toHaveLength(1);
  expect(reported[0]?.[0]).toBe("A provider key could not be encrypted again.");
  expect(errorText(reported[0]?.[1])).not.toContain(SENTINEL_KEY);
});

test("an unreadable folder or file fails with a fixed code", async () => {
  const fake = fakeSafeStorage();
  // A Windows without LOCALAPPDATA: the folder helper throws.
  const missing = storeWith(fake, {
    folder: () => {
      throw new DeviceKeyError("local_data_folder_missing");
    },
  });
  await expectRejection(
    () => missing.save(BINDING_1, SENTINEL_KEY, null),
    "folder_unavailable",
  );
  await expectRejection(() => missing.check(BINDING_1), "folder_unavailable");
  await expectRejection(
    () => missing.remove(CONNECTION_1),
    "folder_unavailable",
  );
  await expectRejection(() => missing.removeAll(), "folder_unavailable");
  const relative = storeWith(fake, { folder: () => "relative" });
  await expectRejection(() => relative.check(BINDING_1), "folder_unavailable");

  // A folder where the key file belongs.
  const store = storeWith(fake);
  await mkdir(keyFile(), { recursive: true });
  await expectRejection(() => store.check(BINDING_1), "read_failed");
  await expectRejection(
    () => store.save(BINDING_1, SENTINEL_KEY, null),
    "write_failed",
  );
  await rm(keyFile(), { recursive: true });

  // The system cannot decrypt a file that it wrote, for example after the
  // Keychain entry was deleted.
  await store.save(BINDING_1, SENTINEL_KEY, null);
  fake.state.failDecrypt = true;
  await expectRejection(() => store.check(BINDING_1), "unreadable");
  await expectRejection(() => store.read(BINDING_1), "unreadable");
});

test("on Linux and macOS a symbolic link in place of the key folder is refused, and a folder with another mode is set to 0700", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const fake = fakeSafeStorage();
    const calls: string[] = [];
    const folder = { link: true, mode: 0o40755 };
    const name = (target: string) => (target === keyFolder ? "folder" : target);
    const fileSystem: ProviderKeyFileSystem = {
      ...nodeProviderKeyFileSystem,
      lstat: (target) => {
        calls.push(`lstat:${name(target)}`);
        return Promise.resolve({
          mode: folder.mode,
          isDirectory: () => !folder.link,
          isSymbolicLink: () => folder.link,
        });
      },
      chmod: (target, mode) => {
        calls.push(`chmod:${name(target)}:${mode.toString(8)}`);
        return Promise.resolve();
      },
    };
    const store = storeWith(fake, { platform, fileSystem });
    await expectRejection(
      () => store.save(BINDING_1, SENTINEL_KEY, null),
      "folder_unavailable",
    );
    await expectRejection(() => store.check(BINDING_1), "folder_unavailable");
    await expectRejection(() => store.read(BINDING_1), "folder_unavailable");
    await expectRejection(
      () => store.remove(CONNECTION_1),
      "folder_unavailable",
    );
    await expectRejection(() => store.removeAll(), "folder_unavailable");
    // Nothing was written, and a link is never changed.
    await expect(readFile(keyFile())).rejects.toThrow();
    expect(calls).toEqual(Array.from({ length: 5 }, () => "lstat:folder"));

    // A real folder with another mode is set to 0700 before it is used.
    folder.link = false;
    calls.length = 0;
    expect(await store.check(BINDING_1)).toEqual({ key: "missing" });
    expect(calls).toEqual(["lstat:folder", "chmod:folder:700"]);
    folder.mode = 0o40700;
    calls.length = 0;
    expect(await store.check(BINDING_1)).toEqual({ key: "missing" });
    expect(calls).toEqual(["lstat:folder"]);

    // An lstat that fails otherwise, or a chmod that fails, is refused too.
    fileSystem.lstat = () =>
      Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expectRejection(() => store.check(BINDING_1), "folder_unavailable");
    fileSystem.lstat = () =>
      Promise.resolve({
        mode: 0o40777,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      });
    fileSystem.chmod = () => Promise.reject(new Error("denied"));
    await expectRejection(() => store.check(BINDING_1), "folder_unavailable");
    await rm(keyFolder, { recursive: true, force: true });
  }

  // Windows checks nothing of the kind.
  const lstats: string[] = [];
  const windows = storeWith(fakeSafeStorage(), {
    platform: "win32",
    fileSystem: {
      ...nodeProviderKeyFileSystem,
      lstat: (target) => {
        lstats.push(target);
        return nodeProviderKeyFileSystem.lstat(target);
      },
    },
  });
  await windows.save(BINDING_1, SENTINEL_KEY, null);
  expect((await windows.read(BINDING_1)).key).toBe(SENTINEL_KEY);
  expect(lstats).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "on Linux and macOS a real symbolic link to another folder is refused and nothing goes through it; a looser real folder is set to 0700",
  async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await chmod(outside, 0o755);
    await mkdir(path.dirname(keyFolder), { recursive: true });
    await symlink(outside, keyFolder);
    const store = storeWith(fakeSafeStorage(), { platform: process.platform });
    await expectRejection(
      () => store.save(BINDING_1, SENTINEL_KEY, null),
      "folder_unavailable",
    );
    await expectRejection(() => store.check(BINDING_1), "folder_unavailable");
    await expectRejection(
      () => store.remove(CONNECTION_1),
      "folder_unavailable",
    );
    await expectRejection(() => store.removeAll(), "folder_unavailable");
    expect(await readdir(outside)).toEqual([]);
    expect((await stat(outside)).mode & 0o777).toBe(0o755);

    await rm(keyFolder);
    await mkdir(keyFolder);
    await chmod(keyFolder, 0o755);
    expect(await store.check(BINDING_1)).toEqual({ key: "missing" });
    expect((await stat(keyFolder)).mode & 0o777).toBe(0o700);
    await store.save(BINDING_1, SENTINEL_KEY, null);
    expect((await store.read(BINDING_1)).key).toBe(SENTINEL_KEY);
  },
);

test("a key of the wrong shape and an invalid ID are refused before anything is encrypted", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);
  const longest = "k".repeat(PROVIDER_KEY_LIMITS.key);
  expect(isProviderKeyShape(longest)).toBe(true);
  expect(isProviderKeyShape("FAKE-key_value.with~symbols+/=")).toBe(true);
  for (const key of [
    "",
    `${longest}k`,
    ` ${SENTINEL_KEY}`,
    `${SENTINEL_KEY} `,
    `${SENTINEL_KEY}\n`,
    `${SENTINEL_KEY}\tx`,
    `${SENTINEL_KEY}\u0000`,
    `${SENTINEL_KEY}\u007f`,
    `${SENTINEL_KEY}\u00a0`,
    `${SENTINEL_KEY}\u200b`,
    `${SENTINEL_KEY}\u2028`,
    `${SENTINEL_KEY}\ud800`,
    7,
    null,
  ]) {
    expect(isProviderKeyShape(key), JSON.stringify(key)).toBe(false);
    await expectRejection(
      () => store.save(BINDING_1, key as string, null),
      "invalid_key",
    );
  }
  for (const binding of [
    { deviceId: "device", providerConnectionId: CONNECTION_1 },
    { deviceId: DEVICE_ID, providerConnectionId: CONNECTION_1.toUpperCase() },
    { deviceId: DEVICE_ID, providerConnectionId: "../escape" },
  ]) {
    await expectRejection(
      () => store.save(binding, SENTINEL_KEY, null),
      "invalid_binding",
    );
    await expectRejection(() => store.check(binding), "invalid_binding");
  }
  await expectRejection(() => store.remove("../escape"), "invalid_binding");
  expect(fake.calls).not.toContain("encryptStringAsync");
  await expect(readdir(keyFolder)).rejects.toThrow();
});

test("remove deletes one connection's file and its temporary files; removeAll deletes every key file and leaves other names", async () => {
  const store = storeWith(fakeSafeStorage());
  await store.save(BINDING_1, SENTINEL_KEY, null);
  await store.save(BINDING_2, OTHER_KEY, null);
  const stray1 = `${CONNECTION_1}.json.0123456789abcdef.tmp`;
  const stray2 = `${CONNECTION_2}.json.fedcba9876543210.tmp`;
  await writeFile(path.join(keyFolder, stray1), "partial");
  await writeFile(path.join(keyFolder, stray2), "partial");
  await writeFile(path.join(keyFolder, "notes.txt"), "not a key file");

  await store.remove(CONNECTION_1);
  expect((await readdir(keyFolder)).sort()).toEqual(
    [`${CONNECTION_2}.json`, stray2, "notes.txt"].sort(),
  );
  expect(await store.check(BINDING_1)).toEqual({ key: "missing" });
  expect((await store.read(BINDING_2)).key).toBe(OTHER_KEY);
  // A missing file is not an error.
  await store.remove(CONNECTION_1);

  await store.save(BINDING_1, SENTINEL_KEY, null);
  await store.removeAll();
  expect(await readdir(keyFolder)).toEqual(["notes.txt"]);
  // Without a folder there is nothing to delete.
  await rm(keyFolder, { recursive: true });
  await store.removeAll();
  await store.remove(CONNECTION_1);
});

test("a file that cannot be deleted fails the deletion after every other file was tried", async () => {
  const store0 = storeWith(fakeSafeStorage());
  await store0.save(BINDING_1, SENTINEL_KEY, null);
  await store0.save(BINDING_2, OTHER_KEY, null);
  const fileSystem: ProviderKeyFileSystem = {
    ...nodeProviderKeyFileSystem,
    unlink: async (file) => {
      if (file.endsWith(`${CONNECTION_1}.json`)) {
        throw Object.assign(new Error(`EPERM: unlink '${file}'`), {
          code: "EPERM",
        });
      }
      await nodeKeyFileSystem.unlink(file);
    },
  };
  const store = storeWith(fakeSafeStorage(), { fileSystem });
  const error = await rejectionOf(() => store.removeAll());
  expect(isProviderKeyError(error, "delete_failed")).toBe(true);
  expect((error as Error).cause).toBeUndefined();
  expect(await readdir(keyFolder)).toEqual([`${CONNECTION_1}.json`]);
  await expectRejection(() => store.remove(CONNECTION_1), "delete_failed");
});

test("operations run one after the other, so a removal never races a write", async () => {
  const store = storeWith(fakeSafeStorage());
  const order: string[] = [];
  const saving = store.save(BINDING_1, SENTINEL_KEY, null).then(() => {
    order.push("save");
  });
  const removing = store.removeAll().then(() => {
    order.push("removeAll");
  });
  const checking = store.check(BINDING_1).then((found) => {
    order.push(`check:${found.key}`);
  });
  await Promise.all([saving, removing, checking]);
  expect(order).toEqual(["save", "removeAll", "check:missing"]);
});

/** A key file around a payload of `fields`, encrypted by `fake`. */
async function writePayload(
  fake: FakeSafeStorage,
  fields: Record<string, unknown>,
): Promise<void> {
  await mkdir(keyFolder, { recursive: true });
  await writeFile(
    keyFile(),
    `${JSON.stringify({
      format: PROVIDER_KEY_FILE_FORMAT,
      version: PROVIDER_KEY_FILE_VERSION,
      ciphertext: fake.encrypt(JSON.stringify(fields)).toString("base64url"),
    })}\n`,
  );
}

/** The decrypted payload of the key file of `connection`. */
async function payloadOf(
  fake: FakeSafeStorage,
  connection: string = CONNECTION_1,
): Promise<Record<string, unknown>> {
  const json = JSON.parse(await readFile(keyFile(connection), "utf8")) as {
    ciphertext: string;
  };
  return JSON.parse(
    fake.decrypt(Buffer.from(json.ciphertext, "base64url")),
  ) as Record<string, unknown>;
}

const V1_PAYLOAD = Object.freeze({
  format: PROVIDER_KEY_PAYLOAD_FORMAT,
  version: 1,
  deviceId: DEVICE_ID,
  providerConnectionId: CONNECTION_1,
  key: SENTINEL_KEY,
});

test("a key file of the format before models (payload version 1) still opens, with no model, and is never given one on its own", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);
  await writePayload(fake, V1_PAYLOAD);
  const before = await readFile(keyFile(), "utf8");

  expect(await store.check(BINDING_1)).toEqual({ key: "ready", model: null });
  expect(await store.read(BINDING_1)).toEqual({
    key: SENTINEL_KEY,
    model: null,
  });
  // Reading changes nothing: the old file stays as it was.
  expect(await readFile(keyFile(), "utf8")).toBe(before);

  // A model chosen later writes the current version with the same key.
  await store.setModel(BINDING_1, "claude-haiku-5-5");
  expect(await payloadOf(fake)).toEqual({
    ...V1_PAYLOAD,
    version: 2,
    model: "claude-haiku-5-5",
  });
  expect(await store.read(BINDING_1)).toEqual({
    key: SENTINEL_KEY,
    model: "claude-haiku-5-5",
  });
});

test("a payload whose fields do not match its version is corrupt, and a model is only shape-checked on read", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);
  for (const fields of [
    // Version 1 never holds a model, and version 2 always does.
    { ...V1_PAYLOAD, model: "claude-opus-5-5" },
    { ...V1_PAYLOAD, version: 2 },
    // A model that is not a model ID's shape.
    { ...V1_PAYLOAD, version: 2, model: "" },
    { ...V1_PAYLOAD, version: 2, model: "Claude Opus" },
    { ...V1_PAYLOAD, version: 2, model: "claude opus" },
    { ...V1_PAYLOAD, version: 2, model: "-claude" },
    { ...V1_PAYLOAD, version: 2, model: `c${"x".repeat(64)}` },
    { ...V1_PAYLOAD, version: 2, model: 5 },
    { ...V1_PAYLOAD, version: 2, model: ["claude-opus-5-5"] },
  ]) {
    await writePayload(fake, fields);
    await expectRejection(() => store.read(BINDING_1), "corrupt");
  }
  await writePayload(fake, { ...V1_PAYLOAD, version: 3, model: "x" });
  await expectRejection(() => store.check(BINDING_1), "newer_format");

  // A model of the right shape outside the closed list keeps the key
  // readable; models.ts decides whether it counts.
  await writePayload(fake, {
    ...V1_PAYLOAD,
    version: 2,
    model: "claude-opus-9-9",
  });
  expect(await store.check(BINDING_1)).toEqual({
    key: "ready",
    model: "claude-opus-9-9",
  });
  await writePayload(fake, { ...V1_PAYLOAD, version: 2, model: null });
  expect(await store.read(BINDING_1)).toEqual({
    key: SENTINEL_KEY,
    model: null,
  });
});

test("only a model of the closed list, or null, is stored: anything else is refused before anything is encrypted, and the previous file stays", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);
  await store.save(BINDING_1, OTHER_KEY, "claude-opus-5-5");
  const before = await readFile(keyFile(), "utf8");
  const encrypts = fake.calls.filter((call) => call === "encryptStringAsync");
  for (const model of [
    "claude-opus-4-8",
    "claude-opus-5-5-20260401",
    "Claude-Opus-5-5",
    " claude-opus-5-5",
    "claude-fable-5-2",
    "gpt-5",
    "",
    undefined,
    7,
    { id: "claude-opus-5-5" },
  ]) {
    await expectRejection(
      () => store.save(BINDING_1, SENTINEL_KEY, model as ClaudeModel),
      "invalid_model",
    );
    await expectRejection(
      () => store.setModel(BINDING_1, model as ClaudeModel),
      "invalid_model",
    );
  }
  // setModel never takes the model away.
  await expectRejection(
    () => store.setModel(BINDING_1, null as unknown as ClaudeModel),
    "invalid_model",
  );
  expect(
    fake.calls.filter((call) => call === "encryptStringAsync").length,
  ).toBe(encrypts.length);
  expect(await readFile(keyFile(), "utf8")).toBe(before);
  for (const model of [
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    null,
  ] as const) {
    await store.save(BINDING_1, SENTINEL_KEY, model);
    expect(await store.check(BINDING_1)).toEqual({ key: "ready", model });
  }
});

test("setModel changes the model of a stored key without its caller knowing the key, atomically, and fails closed", async () => {
  const fake = fakeSafeStorage();
  const store = storeWith(fake);
  await expectRejection(
    () => store.setModel(BINDING_1, "claude-opus-5-5"),
    "missing",
  );
  await expect(readdir(keyFolder)).rejects.toThrow();

  await store.save(BINDING_1, SENTINEL_KEY, "claude-opus-5-5");
  await store.save(BINDING_2, OTHER_KEY, "claude-haiku-5-5");
  await store.setModel(BINDING_1, "claude-sonnet-5-5");
  expect(await store.read(BINDING_1)).toEqual({
    key: SENTINEL_KEY,
    model: "claude-sonnet-5-5",
  });
  // The other connection is untouched, and no temporary file is left.
  expect(await store.read(BINDING_2)).toEqual({
    key: OTHER_KEY,
    model: "claude-haiku-5-5",
  });
  expect((await readdir(keyFolder)).sort()).toEqual(
    [`${CONNECTION_1}.json`, `${CONNECTION_2}.json`].sort(),
  );

  // Without the system's protection, nothing is written.
  const before = await readFile(keyFile(), "utf8");
  fake.state.available = false;
  await expectRejection(
    () => store.setModel(BINDING_1, "claude-haiku-5-5"),
    "system_protection_unavailable",
  );
  fake.state.available = true;
  expect(await readFile(keyFile(), "utf8")).toBe(before);

  // A file that does not open for this binding is never rewritten.
  const otherDevice = { ...BINDING_1, deviceId: OTHER_DEVICE_ID };
  await expectRejection(
    () => store.setModel(otherDevice, "claude-haiku-5-5"),
    "bound_elsewhere",
  );
  fake.state.failDecrypt = true;
  await expectRejection(
    () => store.setModel(BINDING_1, "claude-haiku-5-5"),
    "unreadable",
  );
  fake.state.failDecrypt = false;
  expect(await readFile(keyFile(), "utf8")).toBe(before);

  // Removing the key removes its model with it.
  await store.remove(CONNECTION_1);
  expect(await store.check(BINDING_1)).toEqual({ key: "missing" });
  await expectRejection(
    () => store.setModel(BINDING_1, "claude-opus-5-5"),
    "missing",
  );
});

test("no error of the store holds the key, a cause, or file content: every message is fixed per code", async () => {
  for (const code of PROVIDER_KEY_ERROR_CODES) {
    const error = new ProviderKeyError(code);
    expect(error.message).not.toMatch(/\{|FAKE|sk-/u);
    expect(error.cause).toBeUndefined();
  }
  expect(seenErrors.length).toBeGreaterThan(0);
  for (const error of seenErrors) {
    expect(error).toBeInstanceOf(ProviderKeyError);
    expect(errorText(error)).not.toContain(SENTINEL_KEY);
    expect(errorText(error)).not.toContain(OTHER_KEY);
    expect((error as Error).cause).toBeUndefined();
  }
});

const moduleFolder = path.dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(moduleFolder)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({
    name,
    text: readFileSync(path.join(moduleFolder, name), "utf8"),
  }));

test("the module never calls the synchronous safeStorage API, never logs, and never sets a cause", () => {
  expect(sources.map(({ name }) => name).sort()).toEqual([
    "credential.ts",
    "device-removal.ts",
    "errors.ts",
    "key-file.ts",
    "models.ts",
    "store.ts",
    "system.ts",
  ]);
  for (const { name, text } of sources) {
    expect(text, name).not.toMatch(
      /\b(?:encryptString|decryptString|isEncryptionAvailable|setUsePlainTextEncryption)\b/,
    );
    expect(text, name).not.toMatch(/\bconsole\./);
    expect(text, name).not.toMatch(/\bcause\s*:/);
  }
});

test("neither the renderer nor the preload script nor the IPC contract reaches the provider key store", () => {
  const src = path.resolve(moduleFolder, "..", "..");
  const files = ["preload", "renderer", "shared"].flatMap((side) =>
    readdirSync(path.join(src, side), { recursive: true })
      .map(String)
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => path.join(src, side, name)),
  );
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(readFileSync(file, "utf8"), file).not.toMatch(/provider-keys\//);
  }
});
