import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { inspect } from "node:util";
import {
  DEVICE_PUBLIC_KEY_PATTERN,
  DEVICE_SIGNATURE_PATTERN,
  deviceAuthInput,
  type DeviceAuthInput,
  isDevicePublicKey,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import { isDeviceKeyError } from "./errors.ts";
import {
  generateDeviceKey,
  holdDeviceKey,
  importDeviceKey,
} from "./signing-key.ts";

// RFC 8032, section 7.1, test 1.
const RFC8032_SECRET =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC8032_PUBLIC =
  "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";
const SPKI_ED25519_PREFIX = "302a300506032b6570032100";

const AUDIENCE = "https://api.mymandev.example";
const NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const SIGN_IN_CODE = "mmdc_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const OTHER_ID = "0192f2a0-7c3e-7d2e-9f10-112233445566";

/** Verifies the way the API does: from the stored hexadecimal key and the base64url signature. */
function verifies(
  input: DeviceAuthInput,
  publicKeyHex: string,
  signature: string,
): boolean {
  const publicKey = createPublicKey({
    key: Buffer.from(SPKI_ED25519_PREFIX + publicKeyHex, "hex"),
    format: "der",
    type: "spki",
  });
  return verify(
    null,
    Buffer.from(deviceAuthInput(input), "utf8"),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
}

function inputs(publicKey: string): DeviceAuthInput[] {
  return [
    {
      purpose: "ws",
      audience: AUDIENCE,
      nonce: NONCE,
      deviceId: DEVICE_ID,
      connectionId: OTHER_ID,
    },
    {
      purpose: "http",
      audience: AUDIENCE,
      nonce: NONCE,
      deviceId: DEVICE_ID,
      challengeId: OTHER_ID,
    },
    {
      purpose: "sign-in",
      audience: AUDIENCE,
      signInCode: SIGN_IN_CODE,
      deviceId: null,
      newPublicKey: publicKey,
    },
    {
      purpose: "sign-in",
      audience: AUDIENCE,
      signInCode: SIGN_IN_CODE,
      deviceId: DEVICE_ID,
      newPublicKey: publicKey,
    },
  ];
}

test("a new key is an Ed25519 key whose public key is 64 lowercase hexadecimal characters", async () => {
  const first = await generateDeviceKey();
  const second = await generateDeviceKey();

  for (const held of [first, second]) {
    expect(held.key.publicKey).toMatch(DEVICE_PUBLIC_KEY_PATTERN);
    expect(isDevicePublicKey(held.key.publicKey)).toBe(true);
  }
  expect(first.key.publicKey).not.toBe(second.key.publicKey);
});

test("signatures for every input that deviceAuthInput builds verify with node:crypto", async () => {
  const held = await generateDeviceKey();

  for (const input of inputs(held.key.publicKey)) {
    const signature = held.key.sign(input);
    expect(signature).toMatch(DEVICE_SIGNATURE_PATTERN);
    expect(verifies(input, held.key.publicKey, signature)).toBe(true);
  }
});

test("a signature does not verify for another purpose, input, or key", async () => {
  const held = await generateDeviceKey();
  const other = await generateDeviceKey();
  const [ws, http] = inputs(held.key.publicKey) as [
    DeviceAuthInput,
    DeviceAuthInput,
  ];
  const signature = held.key.sign(ws);

  expect(verifies(http, held.key.publicKey, signature)).toBe(false);
  expect(
    verifies(
      { ...ws, connectionId: DEVICE_ID } as DeviceAuthInput,
      held.key.publicKey,
      signature,
    ),
  ).toBe(false);
  expect(verifies(ws, other.key.publicKey, signature)).toBe(false);
});

test("the RFC 8032 key gives the RFC 8032 public key, and its signature matches the protocol's input", () => {
  const held = importDeviceKey(
    Buffer.from(PKCS8_ED25519_PREFIX + RFC8032_SECRET, "hex"),
  );
  expect(held.key.publicKey).toBe(RFC8032_PUBLIC);

  const [, , newDevice] = inputs(RFC8032_PUBLIC) as [
    DeviceAuthInput,
    DeviceAuthInput,
    DeviceAuthInput,
  ];
  const signature = held.key.sign(newDevice);
  // Ed25519 is deterministic: the same key signs the same input the same way.
  expect(held.key.sign(newDevice)).toBe(signature);
  expect(verifies(newDevice, RFC8032_PUBLIC, signature)).toBe(true);
});

test("an input outside the protocol's format is refused before anything is signed", async () => {
  const held = await generateDeviceKey();
  const [ws] = inputs(held.key.publicKey) as [DeviceAuthInput];

  for (const input of [
    { ...ws, audience: "https://api.mymandev.example/" },
    { ...ws, nonce: `${NONCE}\nextra` },
    { ...ws, purpose: "other" },
    {
      purpose: "sign-in",
      audience: AUDIENCE,
      signInCode: SIGN_IN_CODE,
      deviceId: null,
      newPublicKey: held.key.publicKey.toUpperCase(),
    },
  ]) {
    expect(() => held.key.sign(input as DeviceAuthInput)).toThrow(TypeError);
  }
});

test("a retired key signs nothing more", async () => {
  const held = await generateDeviceKey();
  const [ws] = inputs(held.key.publicKey) as [DeviceAuthInput];
  held.key.sign(ws);

  held.retire();

  let thrown: unknown;
  try {
    held.key.sign(ws);
  } catch (error) {
    thrown = error;
  }
  expect(isDeviceKeyError(thrown, "key_retired")).toBe(true);
});

test("the PKCS#8 export reads back as the same key", async () => {
  const held = await generateDeviceKey();
  const pkcs8 = held.exportPkcs8();

  expect(pkcs8.subarray(0, 16).toString("hex")).toBe(PKCS8_ED25519_PREFIX);
  expect(importDeviceKey(pkcs8).key.publicKey).toBe(held.key.publicKey);
});

test("a key file that holds no Ed25519 private key is refused as corrupt", () => {
  const otherKeys = [
    generateKeyPairSync("x25519").privateKey,
    generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
  ].map((key) => key.export({ type: "pkcs8", format: "der" }));

  for (const pkcs8 of [
    ...otherKeys,
    Buffer.alloc(0),
    Buffer.from("not a key"),
    Buffer.from(PKCS8_ED25519_PREFIX + RFC8032_SECRET.slice(2), "hex"),
  ]) {
    let thrown: unknown;
    try {
      importDeviceKey(pkcs8);
    } catch (error) {
      thrown = error;
    }
    expect(isDeviceKeyError(thrown, "corrupt")).toBe(true);
  }
  expect(() =>
    holdDeviceKey(generateKeyPairSync("x25519").privateKey),
  ).toThrow();
});

test("a key shows only its public key when it is logged or serialized", () => {
  const privateKey = createPrivateKey({
    key: Buffer.from(PKCS8_ED25519_PREFIX + RFC8032_SECRET, "hex"),
    format: "der",
    type: "pkcs8",
  });
  const { key } = holdDeviceKey(privateKey);

  expect(Object.keys(key).sort()).toEqual(["publicKey", "sign"]);
  expect(JSON.parse(JSON.stringify(key))).toEqual({
    publicKey: RFC8032_PUBLIC,
  });
  const shown = inspect(key, { depth: 10, showHidden: true });
  expect(shown).not.toContain(RFC8032_SECRET);
  expect(shown).not.toContain(
    Buffer.from(RFC8032_SECRET, "hex").toString("base64url"),
  );
  expect(Object.isFrozen(key)).toBe(true);
});
