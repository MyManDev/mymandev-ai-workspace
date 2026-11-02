// The sign-out marker (ADR 0014, "Revocation, sign-out, and recovery";
// P-65). After a sign-out the desktop does not use the device key until the
// next GitHub sign-in, and a sign-out made offline is reported to the API
// when it is online again. Both must survive a restart, which is neither a
// sign-in nor a report, so the marker is a file next to the device record
// and the key files (on Windows the local, non-roaming folder), written
// atomically.
//
// It names the public keys that the device held when the person signed
// out. Every GitHub sign-in stores a new key, so a key that the marker does
// not name was made by a sign-in after the sign-out, and the marker no
// longer applies once the device uses that key. The file holds no secret: a
// public key is not one.
import path from "node:path";
import { DevicePublicKeySchema } from "@mymandev/protocol";
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
export const SIGN_OUT_MARKER_FILE = "device-sign-out.json";

/** The format version that this build writes and reads. */
export const SIGN_OUT_MARKER_VERSION = 1;

/** A marker file is far smaller; a larger one is corrupt. */
const MAX_MARKER_BYTES = 4096;

const SignOutMarkerFileSchema = z.strictObject({
  version: z.literal(SIGN_OUT_MARKER_VERSION),
  // The current key, the previous key while a replacement is pending, and
  // the key that the record names.
  publicKeys: z.array(DevicePublicKeySchema).min(1).max(3),
  reported: z.boolean(),
});

/** The person signed out on this device. */
export interface SignOutMarker {
  /** The public keys that the device held when the person signed out. */
  readonly publicKeys: readonly string[];
  /** Whether the API confirmed the sign-out. */
  readonly reported: boolean;
}

/**
 * What the folder holds: no marker, a marker, or a file that is not a marker
 * of this format. A corrupt marker still means that the person signed out.
 */
export type SignOutMarkerRead =
  | { readonly kind: "none" }
  | { readonly kind: "marker"; readonly marker: SignOutMarker }
  | { readonly kind: "corrupt" };

export interface SignOutMarkerStore {
  /** Reads the marker strictly. Rejects only when the file cannot be read. */
  readonly read: () => Promise<SignOutMarkerRead>;
  /**
   * Writes the marker atomically. Throws a `TypeError` that names no value
   * for a marker outside the format.
   */
  readonly write: (marker: SignOutMarker) => Promise<void>;
  /** Deletes the marker; a missing one is not an error. */
  readonly delete: () => Promise<void>;
}

export interface SignOutMarkerStoreOptions {
  /** The folder of the device key files, from `deviceKeyFolder`. */
  readonly folder: string;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Defaults to `node:fs/promises`. */
  readonly fileSystem?: KeyFileSystem;
}

function frozenMarker(marker: SignOutMarker): SignOutMarker {
  return Object.freeze({
    publicKeys: Object.freeze([...marker.publicKeys]),
    reported: marker.reported,
  });
}

/** Decodes the bytes of a marker file, or returns null when they are not one. */
export function decodeSignOutMarker(bytes: Uint8Array): SignOutMarker | null {
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
  const parsed = SignOutMarkerFileSchema.safeParse(value);
  return parsed.success ? frozenMarker(parsed.data) : null;
}

/** Encodes a marker as the bytes of a marker file. */
export function encodeSignOutMarker(marker: SignOutMarker): Uint8Array {
  const parsed = SignOutMarkerFileSchema.safeParse({
    version: SIGN_OUT_MARKER_VERSION,
    publicKeys: [...new Set(marker.publicKeys)],
    reported: marker.reported,
  });
  if (!parsed.success) {
    const field =
      parsed.error.issues[0]?.path.map(String).join(".") || "marker";
    throw new TypeError(`Invalid sign-out marker field ${field}`);
  }
  return Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8");
}

export function createSignOutMarkerStore(
  options: SignOutMarkerStoreOptions,
): SignOutMarkerStore {
  const { folder, platform } = options;
  const fileSystem = options.fileSystem ?? nodeKeyFileSystem;
  const file = path.join(folder, SIGN_OUT_MARKER_FILE);

  return Object.freeze({
    read: async (): Promise<SignOutMarkerRead> => {
      const bytes = await readFileIfPresent(fileSystem, file);
      if (bytes === null) {
        return Object.freeze({ kind: "none" });
      }
      const marker = decodeSignOutMarker(bytes);
      return marker === null
        ? Object.freeze({ kind: "corrupt" })
        : Object.freeze({ kind: "marker", marker });
    },
    write: async (marker: SignOutMarker): Promise<void> => {
      const bytes = encodeSignOutMarker(marker);
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
