// The protection record (#358): the protection that the person last chose for
// the device key on Linux, kept in its own file next to the key files, never
// in a key file. A loaded key file whose protection is lower than the record
// is refused, so that someone who can write the key file cannot quietly put
// a passphrase or unprotected key that they know in place of a better
// protected one.
import * as z from "zod";
import { DeviceKeyError } from "./errors.ts";
import {
  DEVICE_KEY_PROTECTIONS,
  type DeviceKeyProtection,
} from "./key-file.ts";

/** The value of `format`, the first key of the record. */
export const PROTECTION_RECORD_FORMAT = "mymandev-device-key-protection";

/** The format version that this code writes and reads. */
export const PROTECTION_RECORD_VERSION = 1;

/** How strongly each protection protects the key: a higher rank is stronger. */
const RANK: Readonly<Record<DeviceKeyProtection, number>> = Object.freeze({
  unprotected: 0,
  passphrase: 1,
  system: 2,
});

/** Whether `protection` is weaker than `floor`. */
export function isBelow(
  protection: DeviceKeyProtection,
  floor: DeviceKeyProtection,
): boolean {
  return RANK[protection] < RANK[floor];
}

/** The weakest of `protections`, which must not be empty. */
export function weakestOf(
  protections: readonly [DeviceKeyProtection, ...DeviceKeyProtection[]],
): DeviceKeyProtection {
  return protections.reduce((weakest, protection) =>
    isBelow(protection, weakest) ? protection : weakest,
  );
}

const ProtectionRecordSchema = z.strictObject({
  format: z.literal(PROTECTION_RECORD_FORMAT),
  version: z.literal(PROTECTION_RECORD_VERSION),
  protection: z.enum(DEVICE_KEY_PROTECTIONS),
});

/** The bytes of a record: one line of JSON with a final line feed. */
export function encodeProtectionRecord(
  protection: DeviceKeyProtection,
): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      format: PROTECTION_RECORD_FORMAT,
      version: PROTECTION_RECORD_VERSION,
      protection,
    })}\n`,
    "utf8",
  );
}

/**
 * Decodes a record. Throws a `DeviceKeyError`: `newer_format` for a record
 * of a later format version, and `corrupt` for anything else that is not a
 * record of this version. The error never carries the parser's message.
 */
export function decodeProtectionRecord(bytes: Uint8Array): DeviceKeyProtection {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new DeviceKeyError("corrupt");
  }
  const parsed = ProtectionRecordSchema.safeParse(value);
  if (!parsed.success) {
    if (
      typeof value === "object" &&
      value !== null &&
      "format" in value &&
      value.format === PROTECTION_RECORD_FORMAT &&
      "version" in value &&
      typeof value.version === "number" &&
      Number.isSafeInteger(value.version) &&
      value.version > PROTECTION_RECORD_VERSION
    ) {
      throw new DeviceKeyError("newer_format");
    }
    throw new DeviceKeyError("corrupt");
  }
  return parsed.data.protection;
}
