import {
  DEVICE_SIGNATURE_PATTERN,
  deviceAuthInput,
  type DeviceAuthInput,
  isDevicePublicKey,
} from "@mymandev/protocol";
import { createPublicKey, verify } from "node:crypto";

/** The DER prefix that turns a raw 32-byte Ed25519 key into its SPKI form. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const signaturePattern = new RegExp(
  DEVICE_SIGNATURE_PATTERN.source,
  DEVICE_SIGNATURE_PATTERN.flags,
);

/**
 * Whether `signature` is a valid Ed25519 signature by `publicKey` over the
 * signed input built from `input` (ADR 0014, "Device key and
 * authentication"). Any malformed value, a key of small order, or an input
 * outside its format gives false, never an exception.
 */
export function verifyDeviceSignature(
  publicKey: string,
  input: DeviceAuthInput,
  signature: string,
): boolean {
  if (!isDevicePublicKey(publicKey) || !signaturePattern.test(signature)) {
    return false;
  }
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKey, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(deviceAuthInput(input), "utf8"),
      key,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}
