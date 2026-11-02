// The session notes: what the device session must remember across a
// restart besides the sign-out marker (ADR 0014, "Revocation, sign-out, and
// recovery"; #94). One small versioned JSON file next to the device record
// and the key files, written atomically:
//
// - `removal`: the person removed this device, and the API has not
//   confirmed it yet. Until it does, the key is used only for the revoke.
// - `uncertainSignIn`: the new key of a sign-in whose outcome is unknown,
//   and when that outcome arrived. The API may still commit that sign-in,
//   so the new key is not discarded during a grace period.
// - `keysRefused`: both keys of a pending replacement, and when the API
//   first refused both. They count as lost only when a later round, after a
//   wait, refuses both again.
//
// Each note names the device ID or the public keys that it is about, so a
// note about keys or a device that the installation no longer holds is
// dropped. The file holds no secret: public keys and device IDs are not
// secrets.
import path from "node:path";
import {
  DeviceIdSchema,
  DevicePublicKeySchema,
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
} from "../device-key/atomic-file.ts";

/** The file of the notes, next to the device record and the key files. */
export const SESSION_NOTES_FILE = "device-session.json";

/** The format version that this build writes and reads. */
export const SESSION_NOTES_VERSION = 1;

/** A notes file is far smaller; a larger one is corrupt. */
const MAX_NOTES_BYTES = 4096;

const SessionNotesFileSchema = z.strictObject({
  version: z.literal(SESSION_NOTES_VERSION),
  removal: z.strictObject({ deviceId: DeviceIdSchema }).nullable(),
  uncertainSignIn: z
    .strictObject({ publicKey: DevicePublicKeySchema, at: UtcTimestampSchema })
    .nullable(),
  keysRefused: z
    .strictObject({
      publicKeys: z.tuple([DevicePublicKeySchema, DevicePublicKeySchema]),
      at: UtcTimestampSchema,
    })
    .nullable(),
});

export interface SessionNotes {
  /** The device whose removal the API has not confirmed yet. */
  readonly removal: { readonly deviceId: string } | null;
  /** The new key of a sign-in whose outcome is unknown, and when it ended. */
  readonly uncertainSignIn: {
    readonly publicKey: string;
    readonly at: string;
  } | null;
  /** The new and the previous key, and when the API first refused both. */
  readonly keysRefused: {
    readonly publicKeys: readonly [string, string];
    readonly at: string;
  } | null;
}

export const NO_SESSION_NOTES: SessionNotes = Object.freeze({
  removal: null,
  uncertainSignIn: null,
  keysRefused: null,
});

/** What the folder holds: no notes, notes, or a file that is not notes of this format. */
export type SessionNotesRead =
  | { readonly kind: "none" }
  | { readonly kind: "notes"; readonly notes: SessionNotes }
  | { readonly kind: "corrupt" };

export interface SessionNotesStore {
  /** Reads the notes strictly. Rejects only when the file cannot be read. */
  readonly read: () => Promise<SessionNotesRead>;
  /**
   * Writes the notes atomically, or deletes the file when every note is
   * empty. Throws a `TypeError` that names no value for notes outside the
   * format.
   */
  readonly write: (notes: SessionNotes) => Promise<void>;
}

export interface SessionNotesStoreOptions {
  /** The folder of the device key files, from `deviceKeyFolder`. */
  readonly folder: string;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Defaults to `node:fs/promises`. */
  readonly fileSystem?: KeyFileSystem;
}

function frozenNotes(notes: SessionNotes): SessionNotes {
  return Object.freeze({
    removal:
      notes.removal === null
        ? null
        : Object.freeze({ deviceId: notes.removal.deviceId }),
    uncertainSignIn:
      notes.uncertainSignIn === null
        ? null
        : Object.freeze({
            publicKey: notes.uncertainSignIn.publicKey,
            at: notes.uncertainSignIn.at,
          }),
    keysRefused:
      notes.keysRefused === null
        ? null
        : Object.freeze({
            publicKeys: Object.freeze([
              notes.keysRefused.publicKeys[0],
              notes.keysRefused.publicKeys[1],
            ] as const),
            at: notes.keysRefused.at,
          }),
  });
}

/** Whether every note is empty. */
export function sessionNotesEmpty(notes: SessionNotes): boolean {
  return (
    notes.removal === null &&
    notes.uncertainSignIn === null &&
    notes.keysRefused === null
  );
}

/** Decodes the bytes of a notes file, or returns null when they are not one. */
export function decodeSessionNotes(bytes: Uint8Array): SessionNotes | null {
  if (bytes.length > MAX_NOTES_BYTES) {
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
  const parsed = SessionNotesFileSchema.safeParse(value);
  return parsed.success ? frozenNotes(parsed.data) : null;
}

/** Encodes notes as the bytes of a notes file. */
export function encodeSessionNotes(notes: SessionNotes): Uint8Array {
  const parsed = SessionNotesFileSchema.safeParse({
    version: SESSION_NOTES_VERSION,
    ...frozenNotes(notes),
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.map(String).join(".") || "notes";
    throw new TypeError(`Invalid session notes field ${field}`);
  }
  return Buffer.from(`${JSON.stringify(parsed.data)}\n`, "utf8");
}

export function createSessionNotesStore(
  options: SessionNotesStoreOptions,
): SessionNotesStore {
  const { folder, platform } = options;
  const fileSystem = options.fileSystem ?? nodeKeyFileSystem;
  const file = path.join(folder, SESSION_NOTES_FILE);

  return Object.freeze({
    read: async (): Promise<SessionNotesRead> => {
      const bytes = await readFileIfPresent(fileSystem, file);
      if (bytes === null) {
        return Object.freeze({ kind: "none" });
      }
      const notes = decodeSessionNotes(bytes);
      return notes === null
        ? Object.freeze({ kind: "corrupt" })
        : Object.freeze({ kind: "notes", notes });
    },
    write: async (notes: SessionNotes): Promise<void> => {
      if (sessionNotesEmpty(notes)) {
        await removeFile(fileSystem, file);
        await syncFolder(fileSystem, folder, platform);
        return;
      }
      const bytes = encodeSessionNotes(notes);
      await fileSystem.mkdir(folder, {
        recursive: true,
        mode: KEY_FOLDER_MODE,
      });
      await writeFileAtomic(fileSystem, file, bytes, platform);
    },
  });
}
