import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { isDeviceKeyError, type DeviceKeyErrorCode } from "./errors.ts";
import {
  decodeKeyFile,
  DEFAULT_SCRYPT_COST,
  derivePassphraseWrapping,
  encodeKeyFile,
  KEY_FILE_FORMAT,
  type KeyFile,
  NONCE_BYTES,
  openWithPassphrase,
  type PassphraseKeyFile,
  SALT_BYTES,
  sealWithPassphrase,
  TAG_BYTES,
} from "./key-file.ts";

/** A low scrypt cost that keeps the tests fast; the default is tested once. */
const TEST_COST = Object.freeze({ n: 2 ** 14, r: 8, p: 1 });
const PASSPHRASE = "correct horse battery staple";
// 48 bytes, the size of an Ed25519 PKCS#8 key; the content does not matter here.
const PKCS8 = randomBytes(48);

function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectCode(error: unknown, code: DeviceKeyErrorCode): void {
  expect(isDeviceKeyError(error, code), String(error)).toBe(true);
}

function json(file: KeyFile): Record<string, unknown> {
  return JSON.parse(encodeKeyFile(file).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function decodeJson(value: unknown): KeyFile {
  return decodeKeyFile(Buffer.from(JSON.stringify(value), "utf8"));
}

async function passphraseFile(): Promise<PassphraseKeyFile> {
  const wrapping = await derivePassphraseWrapping(PASSPHRASE, {
    cost: TEST_COST,
  });
  return sealWithPassphrase(PKCS8, wrapping);
}

test("a system-protected key file holds the format, the version, the protection, and the ciphertext only", () => {
  const ciphertext = randomBytes(95);
  const bytes = encodeKeyFile({ protection: "system", ciphertext });

  expect(bytes.toString("utf8")).toBe(
    `{"format":"mymandev-device-key","version":1,"protection":"system","ciphertext":"${ciphertext.toString("base64url")}"}\n`,
  );
  expect(decodeKeyFile(bytes)).toEqual({ protection: "system", ciphertext });
});

test("an unprotected key file holds the PKCS#8 key", () => {
  const bytes = encodeKeyFile({ protection: "unprotected", pkcs8: PKCS8 });

  expect(Object.keys(JSON.parse(bytes.toString("utf8")) as object)).toEqual([
    "format",
    "version",
    "protection",
    "pkcs8",
  ]);
  expect(decodeKeyFile(bytes)).toEqual({
    protection: "unprotected",
    pkcs8: PKCS8,
  });
});

test("a passphrase key file round-trips and stores its salt, cost, and nonce next to the ciphertext", async () => {
  const file = await passphraseFile();
  const stored = json(file);

  expect(Object.keys(stored)).toEqual([
    "format",
    "version",
    "protection",
    "kdf",
    "n",
    "r",
    "p",
    "salt",
    "cipher",
    "nonce",
    "tag",
    "ciphertext",
  ]);
  expect(stored).toMatchObject({
    format: KEY_FILE_FORMAT,
    version: 1,
    protection: "passphrase",
    kdf: "scrypt",
    n: TEST_COST.n,
    r: 8,
    p: 1,
    cipher: "aes-256-gcm",
  });
  expect(file.salt).toHaveLength(SALT_BYTES);
  expect(file.nonce).toHaveLength(NONCE_BYTES);
  expect(file.tag).toHaveLength(TAG_BYTES);
  expect(file.ciphertext.equals(PKCS8)).toBe(false);

  const decoded = decodeKeyFile(encodeKeyFile(file)) as PassphraseKeyFile;
  const wrapping = await derivePassphraseWrapping(PASSPHRASE, {
    salt: decoded.salt,
    cost: decoded.cost,
  });
  expect(openWithPassphrase(decoded, wrapping).equals(PKCS8)).toBe(true);
});

test("a wrong passphrase is refused", async () => {
  const file = await passphraseFile();

  for (const wrong of ["Correct horse battery staple", "x", `${PASSPHRASE} `]) {
    const wrapping = await derivePassphraseWrapping(wrong, {
      salt: file.salt,
      cost: file.cost,
    });
    const error = errorOf(() => openWithPassphrase(file, wrapping));
    expectCode(error, "wrong_passphrase");
    expect(String((error as Error).message)).not.toContain(wrong);
  }
});

test("a changed passphrase key file is refused", async () => {
  const file = await passphraseFile();
  const wrapping = await derivePassphraseWrapping(PASSPHRASE, {
    salt: file.salt,
    cost: file.cost,
  });
  const flipped = (bytes: Buffer): Buffer => {
    const copy = Buffer.from(bytes);
    copy[0] = (copy[0] ?? 0) ^ 1;
    return copy;
  };

  for (const changed of [
    { ...file, ciphertext: flipped(file.ciphertext) },
    { ...file, tag: flipped(file.tag) },
    { ...file, nonce: flipped(file.nonce) },
    // The header is authenticated too.
    { ...file, salt: flipped(file.salt) },
    { ...file, cost: { ...file.cost, n: file.cost.n * 2 } },
  ]) {
    expectCode(
      errorOf(() => openWithPassphrase(changed, wrapping)),
      "wrong_passphrase",
    );
  }
});

test("the passphrase is normalized, so the same text typed another way opens the key", async () => {
  const composed = "caf\u00e9 \u00fcber";
  const decomposed = "cafe\u0301 u\u0308ber";
  const wrapping = await derivePassphraseWrapping(composed, {
    cost: TEST_COST,
  });
  const file = sealWithPassphrase(PKCS8, wrapping);

  const other = await derivePassphraseWrapping(decomposed, {
    salt: file.salt,
    cost: file.cost,
  });
  expect(openWithPassphrase(file, other).equals(PKCS8)).toBe(true);
});

test("an empty, too long, or non-string passphrase is refused", async () => {
  for (const passphrase of ["", "a".repeat(1025), undefined, 42]) {
    expectCode(
      await rejectionOf(() =>
        derivePassphraseWrapping(passphrase as string, { cost: TEST_COST }),
      ),
      "passphrase_invalid",
    );
  }
  // 1024 characters, counted as code points, are allowed.
  await derivePassphraseWrapping("\u{1f511}".repeat(1024), {
    cost: TEST_COST,
  });
});

test("a scrypt cost outside the allowed range is not used", async () => {
  for (const cost of [
    { n: 2 ** 13, r: 8, p: 1 },
    { n: 2 ** 19, r: 8, p: 1 },
    { n: 3 * 2 ** 14, r: 8, p: 1 },
    { n: 2 ** 14, r: 16, p: 1 },
    { n: 2 ** 14, r: 8, p: 2 },
  ]) {
    await expect(
      derivePassphraseWrapping(PASSPHRASE, { cost }),
    ).rejects.toThrow(RangeError);
  }
});

test(
  "a new passphrase key uses scrypt with N = 2^17, r = 8, p = 1 and a new 16-byte salt",
  { timeout: 60_000 },
  async () => {
    const first = await derivePassphraseWrapping(PASSPHRASE);
    const second = await derivePassphraseWrapping(PASSPHRASE);

    expect(DEFAULT_SCRYPT_COST).toEqual({ n: 131072, r: 8, p: 1 });
    expect(first.cost).toEqual(DEFAULT_SCRYPT_COST);
    expect(first.salt).toHaveLength(16);
    expect(first.key).toHaveLength(32);
    expect(first.salt.equals(second.salt)).toBe(false);

    const file = decodeKeyFile(
      encodeKeyFile(sealWithPassphrase(PKCS8, first)),
    ) as PassphraseKeyFile;
    expect(file.cost).toEqual(DEFAULT_SCRYPT_COST);
    expect(openWithPassphrase(file, first).equals(PKCS8)).toBe(true);
  },
);

test("each encryption uses a new nonce", async () => {
  const wrapping = await derivePassphraseWrapping(PASSPHRASE, {
    cost: TEST_COST,
  });

  const first = sealWithPassphrase(PKCS8, wrapping);
  const second = sealWithPassphrase(PKCS8, wrapping);
  expect(first.nonce.equals(second.nonce)).toBe(false);
  expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
});

test("a key file of a later version is reported as newer, not as damaged", () => {
  const ciphertext = randomBytes(32).toString("base64url");

  expectCode(
    errorOf(() =>
      decodeJson({
        format: KEY_FILE_FORMAT,
        version: 2,
        protection: "hardware",
        handle: "x",
      }),
    ),
    "newer_format",
  );
  expectCode(
    errorOf(() =>
      decodeJson({
        format: KEY_FILE_FORMAT,
        version: 0,
        protection: "system",
        ciphertext,
      }),
    ),
    "corrupt",
  );
});

test("anything else that is not a key file of this version is refused as corrupt, without quoting it", async () => {
  const passphrase = json(await passphraseFile());
  const system = json({ protection: "system", ciphertext: randomBytes(64) });
  const secretLooking = "c2VjcmV0LWtleS1tYXRlcmlhbA";
  const bad: unknown[] = [
    secretLooking,
    `{"format":"${KEY_FILE_FORMAT}",${secretLooking}`,
    [],
    null,
    {},
    { ...system, format: "other" },
    { ...system, version: "1" },
    { ...system, protection: "none" },
    { ...system, extra: true },
    { ...system, ciphertext: "" },
    { ...system, ciphertext: `${String(system["ciphertext"])}=` },
    { ...system, ciphertext: "AB" },
    { ...system, ciphertext: "a+b/" },
    { ...system, ciphertext: "A".repeat(6000) },
    { ...system, publicKey: "00".repeat(32) },
    { ...passphrase, kdf: "pbkdf2" },
    { ...passphrase, cipher: "aes-128-gcm" },
    { ...passphrase, n: 2 ** 13 },
    { ...passphrase, n: 2 ** 19 },
    { ...passphrase, n: 3 * 2 ** 14 },
    { ...passphrase, n: 2 ** 14 + 0.5 },
    { ...passphrase, r: 16 },
    { ...passphrase, p: 2 },
    { ...passphrase, salt: randomBytes(15).toString("base64url") },
    { ...passphrase, nonce: randomBytes(16).toString("base64url") },
    { ...passphrase, tag: randomBytes(12).toString("base64url") },
    { ...passphrase, salt: undefined },
    { ...passphrase, protection: "system" },
  ];

  for (const value of bad) {
    const bytes =
      typeof value === "string"
        ? Buffer.from(value, "utf8")
        : Buffer.from(JSON.stringify(value), "utf8");
    const error = errorOf(() => decodeKeyFile(bytes));
    expectCode(error, "corrupt");
    expect((error as Error).message).not.toContain(secretLooking);
    expect((error as Error).cause).toBeUndefined();
  }
  expectCode(
    errorOf(() => decodeKeyFile(Buffer.from([0xff, 0xfe, 0x00]))),
    "corrupt",
  );
});
