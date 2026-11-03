// The registration marker (#153): the public key of a new device whose
// `POST /auth/sign-in` got no clear answer, and when the flow first sent it.
// Only the answer carries the device ID, so the flow cannot learn whether
// the API registered that key. It keeps the key, and the next sign-in sends
// the same key again instead of a new one: the API answers a key that
// already belongs to an active device of the same account with that device.
//
// It is a small versioned JSON file next to the device record and the key
// files (on Windows the local, non-roaming folder), written atomically, so
// that it survives a restart and lives and goes with the key that it names.
// It is not one of the session notes: the device session reads those once,
// writes them alone, and drops them when no record names the key, which is
// exactly when this marker matters, and the flow cannot use the session.
// The flow and the session both open stores over the key's folder, so both
// can read it. The file holds no secret: a public key is not one.
import path from "node:path";
import { DevicePublicKeySchema, UtcTimestampSchema } from "@mymandev/protocol";
import * as z from "zod";
import {
  KEY_FOLDER_MODE,
  type KeyFileSystem,
  nodeKeyFileSystem,
  readFileIfPresent,
  removeFile,
  syncFolder,
  writeFileAtomic,
} from "../device-key/atomic-file.ts";

/** The file of the marker, next to the device record and the key files. */
export const REGISTRATION_MARKER_FILE = "device-registration.json";

/** The format version that this build writes and reads. */
export const REGISTRATION_MARKER_VERSION = 1;

/** A marker file is far smaller; a larger one is corrupt. */
const MAX_MARKER_BYTES = 4096;

const RegistrationMarkerFileSchema = z.strictObject({
  version: z.literal(REGISTRATION_MARKER_VERSION),
  publicKey: DevicePublicKeySchema,
  at: UtcTimestampSchema,
});

/** A new device's key whose registration got no clear answer. */
export interface RegistrationMarker {
  /** The public key that the registration sent. */
  readonly publicKey: string;
  /** When the flow first sent it; a resend keeps this time. */
  readonly at: string;
}

/**
 * What the folder holds: no marker, a marker, or a file that is not a marker
 * of this format. A corrupt marker names no key, so it is never used.
 */
export type RegistrationMarkerRead =
  | { readonly kind: "none" }
  | { readonly kind: "marker"; readonly marker: RegistrationMarker }
  | { readonly kind: "corrupt" };

export interface RegistrationMarkerStore {
  /** Reads the marker strictly. Rejects only when the file cannot be read. */
  readonly read: () => Promise<RegistrationMarkerRead>;
  /**
   * Writes the marker atomically. Throws a `TypeError` that names no value
   * for a marker outside the format.
   */
  readonly write: (marker: RegistrationMarker) => Promise<void>;
  /** Deletes the marker; a missing one is not an error. */
  readonly delete: () => Promise<void>;
}

export interface RegistrationMarkerStoreOptions {
  /** The folder of the device key files, from `deviceKeyFolder`. */
  readonly folder: string;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Defaults to `node:fs/promises`. */
  readonly fileSystem?: KeyFileSystem;
}

function frozenMarker(marker: RegistrationMarker): RegistrationMarker {
  return Object.freeze({ publicKey: marker.publicKey, at: marker.at });
}

/** Decodes the bytes of a marker file, or returns null when they are not one. */
export function decodeRegistrationMarker(
  bytes: Uint8Array,
): RegistrationMarker | null {
  if (bytes.length > MAX_MARKER_BYTES) {
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
  const parsed = RegistrationMarkerFileSchema.safeParse(value);
  return parsed.success ? frozenMarker(parsed.data) : null;
}

/** Encodes a marker as the bytes of a marker file. */
export function encodeRegistrationMarker(
  marker: RegistrationMarker,
): Uint8Array {
  const parsed = RegistrationMarkerFileSchema.safeParse({
    version: REGISTRATION_MARKER_VERSION,
    ...frozenMarker(marker),
  });
  if (!parsed.success) {
    const field =
      parsed.error.issues[0]?.path.map(String).join(".") || "marker";
    throw new TypeError(`Invalid registration marker field ${field}`);
  }
  return Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8");
}

export function createRegistrationMarkerStore(
  options: RegistrationMarkerStoreOptions,
): RegistrationMarkerStore {
  const { folder, platform } = options;
  const fileSystem = options.fileSystem ?? nodeKeyFileSystem;
  const file = path.join(folder, REGISTRATION_MARKER_FILE);

  return Object.freeze({
    read: async (): Promise<RegistrationMarkerRead> => {
      const bytes = await readFileIfPresent(fileSystem, file);
      if (bytes === null) {
        return Object.freeze({ kind: "none" });
      }
      const marker = decodeRegistrationMarker(bytes);
      return marker === null
        ? Object.freeze({ kind: "corrupt" })
        : Object.freeze({ kind: "marker", marker });
    },
    write: async (marker: RegistrationMarker): Promise<void> => {
      const bytes = encodeRegistrationMarker(marker);
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
