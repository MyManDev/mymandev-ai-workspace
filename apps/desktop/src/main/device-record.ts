// The device record (ADR 0014, "Sign-in" and "Accounts"): the device ID and
// the account that the last successful sign-in returned. The device ID
// belongs to the device key, so the record lives in the key's folder (on
// Windows the local, non-roaming folder) as a small versioned JSON file,
// written atomically. It holds no secret. A file that is not exactly this
// format is reported as corrupt and never trusted.
import path from "node:path";
import {
  type DeviceId,
  DeviceIdSchema,
  displayText,
  GitHubLoginSchema,
  LIMITS,
  type UserId,
  UserIdSchema,
  UtcTimestampSchema,
} from "@mymandev/protocol";
import * as z from "zod";
import {
  KEY_FOLDER_MODE,
  type KeyFileSystem,
  nodeKeyFileSystem,
  readFileIfPresent,
  removeFile,
  syncFolder,
  writeFileAtomic,
} from "./device-key/atomic-file.ts";

/** The file of the record, next to the device key files. */
export const DEVICE_RECORD_FILE = "device-record.json";

/** The format version that this build writes and reads. */
export const DEVICE_RECORD_VERSION = 1;

/** A record file is far smaller; a larger one is corrupt. */
const MAX_RECORD_BYTES = 4096;

const DeviceRecordFileSchema = z.strictObject({
  version: z.literal(DEVICE_RECORD_VERSION),
  deviceId: DeviceIdSchema,
  userId: UserIdSchema,
  login: GitHubLoginSchema,
  displayName: displayText(LIMITS.displayName),
  signInExpiresAt: UtcTimestampSchema,
});

/** The device and the account of the last successful sign-in. */
export interface DeviceRecord {
  readonly deviceId: DeviceId;
  readonly userId: UserId;
  /** The GitHub login of the account. */
  readonly login: string;
  readonly displayName: string;
  /** 30 days after the last sign-in, as the API answered it. */
  readonly signInExpiresAt: string;
}

/**
 * What the folder holds: no record, a record, or a file that is not a record
 * of this format (unreadable JSON, unknown or missing fields, another
 * version, a value outside the protocol's format, or a file too large).
 */
export type DeviceRecordRead =
  | { readonly kind: "none" }
  | { readonly kind: "record"; readonly record: DeviceRecord }
  | { readonly kind: "corrupt" };

export interface DeviceRecordStore {
  /** Reads the record strictly. Rejects only when the file cannot be read. */
  readonly read: () => Promise<DeviceRecordRead>;
  /**
   * Writes the record atomically. Throws a `TypeError` that names no value
   * for a record outside the format.
   */
  readonly write: (record: DeviceRecord) => Promise<void>;
  /** Deletes the record; a missing one is not an error. */
  readonly delete: () => Promise<void>;
}

export interface DeviceRecordStoreOptions {
  /** The folder of the device key files, from `deviceKeyFolder`. */
  readonly folder: string;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Defaults to `node:fs/promises`. */
  readonly fileSystem?: KeyFileSystem;
}

function frozenRecord(record: DeviceRecord): DeviceRecord {
  return Object.freeze({
    deviceId: record.deviceId,
    userId: record.userId,
    login: record.login,
    displayName: record.displayName,
    signInExpiresAt: record.signInExpiresAt,
  });
}

/** Decodes the bytes of a record file, or returns null when they are not one. */
export function decodeDeviceRecord(bytes: Uint8Array): DeviceRecord | null {
  if (bytes.length > MAX_RECORD_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    return null;
  }
  const parsed = DeviceRecordFileSchema.safeParse(value);
  return parsed.success ? frozenRecord(parsed.data) : null;
}

/** Encodes a record as the bytes of a record file. */
export function encodeDeviceRecord(record: DeviceRecord): Uint8Array {
  const parsed = DeviceRecordFileSchema.safeParse({
    version: DEVICE_RECORD_VERSION,
    ...frozenRecord(record),
  });
  if (!parsed.success) {
    const field =
      parsed.error.issues[0]?.path.map(String).join(".") || "record";
    throw new TypeError(`Invalid device record field ${field}`);
  }
  return Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8");
}

export function createDeviceRecordStore(
  options: DeviceRecordStoreOptions,
): DeviceRecordStore {
  const { folder, platform } = options;
  const fileSystem = options.fileSystem ?? nodeKeyFileSystem;
  const file = path.join(folder, DEVICE_RECORD_FILE);

  return Object.freeze({
    read: async (): Promise<DeviceRecordRead> => {
      const bytes = await readFileIfPresent(fileSystem, file);
      if (bytes === null) {
        return Object.freeze({ kind: "none" });
      }
      const record = decodeDeviceRecord(bytes);
      return record === null
        ? Object.freeze({ kind: "corrupt" })
        : Object.freeze({ kind: "record", record });
    },
    write: async (record: DeviceRecord): Promise<void> => {
      const bytes = encodeDeviceRecord(record);
      await fileSystem.mkdir(folder, {
        recursive: true,
        mode: KEY_FOLDER_MODE,
      });
      await writeFileAtomic(fileSystem, file, bytes, platform);
    },
    delete: async (): Promise<void> => {
      await removeFile(fileSystem, file);
      await syncFolder(fileSystem, folder, platform);
    },
  });
}
