// The Ed25519 device key in memory (ADR 0014, "Device key and
// authentication"). The private key stays inside a closure: a `DeviceKey`
// exposes the public key and a function that signs the input built by
// `deviceAuthInput`, so it can sign nothing else, and logging it shows no
// secret.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPair,
  type KeyObject,
  sign,
} from "node:crypto";
import {
  deviceAuthInput,
  type DeviceAuthInput,
  isDevicePublicKey,
} from "@mymandev/protocol";
import { DeviceKeyError } from "./errors.ts";

/** A device key held in memory. */
export interface DeviceKey {
  /**
   * The raw 32-byte Ed25519 public key of RFC 8032, not its SPKI form, as 64
   * lowercase hexadecimal characters: the form in which the API stores it.
   */
  readonly publicKey: string;
  /**
   * Signs the UTF-8 bytes of `deviceAuthInput(input)` and returns the 64-byte
   * signature as 86 base64url characters without padding. Throws the
   * `TypeError` of `deviceAuthInput` for an input outside its format, so
   * nothing is signed that the API would build differently, and a
   * `DeviceKeyError` (`key_retired`) once the store no longer holds the key.
   */
  readonly sign: (input: DeviceAuthInput) => string;
}

/** A device key and what only the store may do with it. */
export interface HeldDeviceKey {
  readonly key: DeviceKey;
  /** The private key as PKCS#8 DER, for the key file. Fill it with zeros after use. */
  readonly exportPkcs8: () => Buffer;
  /** Stops `key.sign` for good. */
  readonly retire: () => void;
}

/** Holds `privateKey`, which must be an Ed25519 private key. */
export function holdDeviceKey(privateKey: KeyObject): HeldDeviceKey {
  const publicKey = rawPublicKey(privateKey);
  let retired = false;
  const key: DeviceKey = Object.freeze({
    publicKey,
    sign: (input: DeviceAuthInput): string => {
      if (retired) {
        throw new DeviceKeyError("key_retired");
      }
      const message = Buffer.from(deviceAuthInput(input), "utf8");
      return sign(null, message, privateKey).toString("base64url");
    },
  });
  return Object.freeze({
    key,
    exportPkcs8: () =>
      privateKey.export({ type: "pkcs8", format: "der" }) as Buffer,
    retire: () => {
      retired = true;
    },
  });
}

/** Generates a new Ed25519 key pair with `node:crypto` and holds its private key. */
export async function generateDeviceKey(): Promise<HeldDeviceKey> {
  const privateKey = await new Promise<KeyObject>((resolve, reject) => {
    generateKeyPair("ed25519", {}, (error, _publicKey, generated) => {
      if (error) {
        reject(error);
      } else {
        resolve(generated);
      }
    });
  });
  return holdDeviceKey(privateKey);
}

/**
 * Reads an Ed25519 private key from PKCS#8 DER. Throws a `DeviceKeyError`
 * (`corrupt`) for anything else, without the parser's message.
 */
export function importDeviceKey(pkcs8: Buffer): HeldDeviceKey {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  } catch {
    throw new DeviceKeyError("corrupt");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new DeviceKeyError("corrupt");
  }
  return holdDeviceKey(privateKey);
}

/** The raw public key of an Ed25519 private key, as 64 lowercase hexadecimal characters. */
function rawPublicKey(privateKey: KeyObject): string {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new DeviceKeyError("corrupt");
  }
  const { x } = createPublicKey(privateKey).export({ format: "jwk" });
  const raw = Buffer.from(x ?? "", "base64url");
  const hex = raw.toString("hex");
  // Every Ed25519 private key passes; the check keeps the promise of the
  // format that the API expects.
  if (raw.length !== 32 || !isDevicePublicKey(hex)) {
    throw new DeviceKeyError("corrupt");
  }
  return hex;
}
