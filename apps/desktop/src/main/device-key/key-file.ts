// The device key file: a small versioned JSON object that holds the private
// key as PKCS#8 DER, protected in one of three ways, and nothing else: no
// public key, which is derived from the private key again, and no device ID.
//
// - "system": encrypted with Electron's `safeStorage.encryptStringAsync`
//   (DPAPI on Windows, the Keychain on macOS, kwallet or libsecret on
//   Linux). The string that `safeStorage` encrypts is the base64 of the DER.
// - "passphrase": encrypted with AES-256-GCM under a key derived from a
//   passphrase with scrypt, for Linux without a secret service. The salt,
//   the scrypt cost, and the nonce are stored next to the ciphertext.
// - "unprotected": the DER itself, in a file with mode 0600, only after an
//   explicit choice.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from "node:crypto";
import * as z from "zod";
import { DeviceKeyError } from "./errors.ts";

/** The value of `format`, the first key of every key file. */
export const KEY_FILE_FORMAT = "mymandev-device-key";

/** The format version that this code writes and reads. */
export const KEY_FILE_VERSION = 1;

/** How a stored device key is protected. */
export const DEVICE_KEY_PROTECTIONS = Object.freeze([
  "system",
  "passphrase",
  "unprotected",
] as const);
export type DeviceKeyProtection = (typeof DEVICE_KEY_PROTECTIONS)[number];

/** The scrypt cost parameters. */
export interface ScryptCost {
  readonly n: number;
  readonly r: number;
  readonly p: number;
}

/**
 * The cost of a new passphrase key: N = 2^17, r = 8, p = 1, which needs
 * 128 MiB and about a second on current hardware.
 */
export const DEFAULT_SCRYPT_COST: ScryptCost = Object.freeze({
  n: 2 ** 17,
  r: 8,
  p: 1,
});

/** The range of N that a key file may use; r is always 8 and p always 1. */
export const SCRYPT_N_RANGE = Object.freeze({ min: 2 ** 14, max: 2 ** 18 });

export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
const DERIVED_KEY_BYTES = 32;
const CIPHER = "aes-256-gcm";

/** A passphrase has 1 to 1024 characters (Unicode code points, after NFC normalization). */
export const PASSPHRASE_MAX_CHARACTERS = 1024;

/** The largest ciphertext or key in a key file, decoded. */
const MAX_DATA_BYTES = 4096;

/** A decoded key file. */
export type KeyFile =
  | { readonly protection: "system"; readonly ciphertext: Buffer }
  | {
      readonly protection: "passphrase";
      readonly cost: ScryptCost;
      readonly salt: Buffer;
      readonly nonce: Buffer;
      readonly ciphertext: Buffer;
      readonly tag: Buffer;
    }
  | { readonly protection: "unprotected"; readonly pkcs8: Buffer };

export type PassphraseKeyFile = Extract<KeyFile, { protection: "passphrase" }>;

const Base64urlSchema = z
  .string()
  .max(Math.ceil((MAX_DATA_BYTES * 4) / 3))
  .regex(/^[A-Za-z0-9_-]*$/u);

const KeyFileSchema = z.discriminatedUnion("protection", [
  z.strictObject({
    format: z.literal(KEY_FILE_FORMAT),
    version: z.literal(KEY_FILE_VERSION),
    protection: z.literal("system"),
    ciphertext: Base64urlSchema,
  }),
  z.strictObject({
    format: z.literal(KEY_FILE_FORMAT),
    version: z.literal(KEY_FILE_VERSION),
    protection: z.literal("passphrase"),
    kdf: z.literal("scrypt"),
    n: z.int(),
    r: z.int(),
    p: z.int(),
    salt: Base64urlSchema,
    cipher: z.literal(CIPHER),
    nonce: Base64urlSchema,
    tag: Base64urlSchema,
    ciphertext: Base64urlSchema,
  }),
  z.strictObject({
    format: z.literal(KEY_FILE_FORMAT),
    version: z.literal(KEY_FILE_VERSION),
    protection: z.literal("unprotected"),
    pkcs8: Base64urlSchema,
  }),
]);

/** Whether a key file may use `cost`. */
export function isAllowedScryptCost(cost: ScryptCost): boolean {
  return (
    Number.isSafeInteger(cost.n) &&
    cost.n >= SCRYPT_N_RANGE.min &&
    cost.n <= SCRYPT_N_RANGE.max &&
    (cost.n & (cost.n - 1)) === 0 &&
    cost.r === 8 &&
    cost.p === 1
  );
}

/** Decodes canonical base64url of `min` to `max` bytes, or throws `corrupt`. */
function decodeBytes(value: string, min: number, max: number): Buffer {
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.toString("base64url") !== value ||
    bytes.length < min ||
    bytes.length > max
  ) {
    throw new DeviceKeyError("corrupt");
  }
  return bytes;
}

/** The JSON object of a key file, with its keys in a fixed order. */
function keyFileJson(file: KeyFile): object {
  const header = { format: KEY_FILE_FORMAT, version: KEY_FILE_VERSION };
  switch (file.protection) {
    case "system":
      return {
        ...header,
        protection: file.protection,
        ciphertext: file.ciphertext.toString("base64url"),
      };
    case "passphrase":
      return {
        ...header,
        protection: file.protection,
        kdf: "scrypt",
        n: file.cost.n,
        r: file.cost.r,
        p: file.cost.p,
        salt: file.salt.toString("base64url"),
        cipher: CIPHER,
        nonce: file.nonce.toString("base64url"),
        tag: file.tag.toString("base64url"),
        ciphertext: file.ciphertext.toString("base64url"),
      };
    case "unprotected":
      return {
        ...header,
        protection: file.protection,
        pkcs8: file.pkcs8.toString("base64url"),
      };
  }
}

/** The bytes of a key file: one line of JSON with a final line feed. */
export function encodeKeyFile(file: KeyFile): Buffer {
  return Buffer.from(`${JSON.stringify(keyFileJson(file))}\n`, "utf8");
}

/**
 * Decodes a key file. Throws a `DeviceKeyError`: `newer_format` for a file
 * of a later format version, and `corrupt` for anything else that is not a
 * key file of this version. The error never carries the parser's message,
 * which could quote the file.
 */
export function decodeKeyFile(bytes: Uint8Array): KeyFile {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new DeviceKeyError("corrupt");
  }
  const parsed = KeyFileSchema.safeParse(value);
  if (!parsed.success) {
    if (
      typeof value === "object" &&
      value !== null &&
      "format" in value &&
      value.format === KEY_FILE_FORMAT &&
      "version" in value &&
      typeof value.version === "number" &&
      Number.isSafeInteger(value.version) &&
      value.version > KEY_FILE_VERSION
    ) {
      throw new DeviceKeyError("newer_format");
    }
    throw new DeviceKeyError("corrupt");
  }
  const file = parsed.data;
  switch (file.protection) {
    case "system":
      return Object.freeze({
        protection: file.protection,
        ciphertext: decodeBytes(file.ciphertext, 1, MAX_DATA_BYTES),
      });
    case "passphrase": {
      const cost = Object.freeze({ n: file.n, r: file.r, p: file.p });
      if (!isAllowedScryptCost(cost)) {
        throw new DeviceKeyError("corrupt");
      }
      return Object.freeze({
        protection: file.protection,
        cost,
        salt: decodeBytes(file.salt, SALT_BYTES, SALT_BYTES),
        nonce: decodeBytes(file.nonce, NONCE_BYTES, NONCE_BYTES),
        tag: decodeBytes(file.tag, TAG_BYTES, TAG_BYTES),
        ciphertext: decodeBytes(file.ciphertext, 1, MAX_DATA_BYTES),
      });
    }
    case "unprotected":
      return Object.freeze({
        protection: file.protection,
        pkcs8: decodeBytes(file.pkcs8, 1, MAX_DATA_BYTES),
      });
  }
}

/** The key that a passphrase derives with one salt and cost. */
export interface PassphraseWrapping {
  readonly cost: ScryptCost;
  readonly salt: Buffer;
  /** 32 bytes for AES-256-GCM. Fill it with zeros when it is no longer needed. */
  readonly key: Buffer;
}

/**
 * The passphrase as UTF-8 after NFC normalization, so that the same text
 * typed with another input method opens the key. Throws `passphrase_invalid`
 * unless it has 1 to 1024 characters and is well-formed: UTF-8 turns every
 * lone surrogate into U+FFFD, so different passphrases would derive the same
 * key.
 */
function passphraseBytes(passphrase: unknown): Buffer {
  if (typeof passphrase !== "string" || !passphrase.isWellFormed()) {
    throw new DeviceKeyError("passphrase_invalid");
  }
  const normalized = passphrase.normalize("NFC");
  const characters = [...normalized].length;
  if (characters < 1 || characters > PASSPHRASE_MAX_CHARACTERS) {
    throw new DeviceKeyError("passphrase_invalid");
  }
  return Buffer.from(normalized, "utf8");
}

/**
 * Derives the AES-256-GCM key from a passphrase with scrypt, in the thread
 * pool, so the main process stays responsive. A new salt is drawn when none
 * is given.
 */
export async function derivePassphraseWrapping(
  passphrase: string,
  options: { readonly salt?: Buffer; readonly cost?: ScryptCost } = {},
): Promise<PassphraseWrapping> {
  const cost = options.cost ?? DEFAULT_SCRYPT_COST;
  if (!isAllowedScryptCost(cost)) {
    throw new RangeError("The scrypt cost is outside the allowed range");
  }
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  const secret = passphraseBytes(passphrase);
  try {
    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        secret,
        salt,
        DERIVED_KEY_BYTES,
        {
          N: cost.n,
          r: cost.r,
          p: cost.p,
          // Above the 128 * N * r bytes that scrypt needs.
          maxmem: 256 * cost.n * cost.r * cost.p,
        },
        (error, derived) => (error ? reject(error) : resolve(derived)),
      );
    });
    return Object.freeze({ cost, salt, key });
  } finally {
    secret.fill(0);
  }
}

/**
 * The additional authenticated data of a passphrase key file: its header,
 * so a changed format, version, cost, or salt fails authentication too.
 */
function associatedData(cost: ScryptCost, salt: Buffer): Buffer {
  return Buffer.from(
    [
      KEY_FILE_FORMAT,
      String(KEY_FILE_VERSION),
      "passphrase",
      "scrypt",
      String(cost.n),
      String(cost.r),
      String(cost.p),
      salt.toString("base64url"),
      CIPHER,
    ].join("\n"),
    "utf8",
  );
}

/** Encrypts PKCS#8 DER with a passphrase key and a new random nonce. */
export function sealWithPassphrase(
  pkcs8: Uint8Array,
  wrapping: PassphraseWrapping,
): PassphraseKeyFile {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, wrapping.key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(associatedData(wrapping.cost, wrapping.salt));
  const ciphertext = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
  return Object.freeze({
    protection: "passphrase",
    cost: wrapping.cost,
    salt: wrapping.salt,
    nonce,
    ciphertext,
    tag: cipher.getAuthTag(),
  });
}

/**
 * Decrypts a passphrase key file to PKCS#8 DER. Throws `wrong_passphrase`
 * when authentication fails: a wrong passphrase and a changed file look the
 * same to AES-GCM.
 */
export function openWithPassphrase(
  file: PassphraseKeyFile,
  wrapping: PassphraseWrapping,
): Buffer {
  const decipher = createDecipheriv(CIPHER, wrapping.key, file.nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(associatedData(file.cost, file.salt));
  decipher.setAuthTag(file.tag);
  const plaintext = decipher.update(file.ciphertext);
  try {
    decipher.final();
  } catch {
    // Unauthenticated output is never used.
    plaintext.fill(0);
    throw new DeviceKeyError("wrong_passphrase");
  }
  return plaintext;
}
