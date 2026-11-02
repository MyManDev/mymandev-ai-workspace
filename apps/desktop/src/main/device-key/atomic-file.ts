// Atomic writes for the device key files: the data goes to a temporary file
// in the same folder, which is flushed to disk and then renamed over the
// target. A reader sees the old file or the new one, never a part of either,
// and a failure leaves no temporary file behind.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

/** The part of a `node:fs/promises` file handle that the writes use. */
export interface KeyFileHandle {
  writeFile(data: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The part of `node:fs/promises` that the device key store uses. Tests pass
 * a wrapper that fails at a chosen step.
 */
export interface KeyFileSystem {
  mkdir(
    folder: string,
    options: { recursive: true; mode: number },
  ): Promise<unknown>;
  open(file: string, flags: string, mode?: number): Promise<KeyFileHandle>;
  readFile(file: string): Promise<Uint8Array>;
  readdir(folder: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

export const nodeKeyFileSystem: KeyFileSystem = Object.freeze({
  mkdir: (folder: string, options: { recursive: true; mode: number }) =>
    fs.mkdir(folder, options),
  open: (file: string, flags: string, mode?: number) =>
    fs.open(file, flags, mode),
  readFile: (file: string) => fs.readFile(file),
  readdir: (folder: string) => fs.readdir(folder),
  rename: (from: string, to: string) => fs.rename(from, to),
  unlink: (file: string) => fs.unlink(file),
});

/** Key files are readable and writable by their owner only (ignored on Windows). */
export const KEY_FILE_MODE = 0o600;

/** The folder of the key files, for its owner only (ignored on Windows). */
export const KEY_FOLDER_MODE = 0o700;

/** The suffix of a temporary file: `.<16 hexadecimal characters>.tmp`. */
const TEMPORARY_SUFFIX = /\.[0-9a-f]{16}\.tmp$/u;

/** The name of a new temporary file for `file`, in the same folder. */
export function temporaryFileFor(file: string): string {
  return `${file}.${randomBytes(8).toString("hex")}.tmp`;
}

/** Whether `name` is the name of a temporary file for a file named `target`. */
export function isTemporaryFileOf(name: string, target: string): boolean {
  return (
    name.startsWith(`${target}.`) &&
    name.length === target.length + 21 &&
    TEMPORARY_SUFFIX.test(name)
  );
}

export function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Deletes `file`; a missing file is not an error. */
export async function removeFile(
  fileSystem: KeyFileSystem,
  file: string,
): Promise<void> {
  try {
    await fileSystem.unlink(file);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

/** Reads `file`, or returns null when it does not exist. */
export async function readFileIfPresent(
  fileSystem: KeyFileSystem,
  file: string,
): Promise<Uint8Array | null> {
  try {
    return await fileSystem.readFile(file);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

/** Opens `target`, flushes it, and closes it; an error is ignored. */
async function flushQuietly(
  fileSystem: KeyFileSystem,
  target: string,
  flags: string,
): Promise<void> {
  try {
    const handle = await fileSystem.open(target, flags);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Best effort: the change on disk has already happened, and some file
    // systems cannot flush a folder.
  }
}

/**
 * Flushes a folder after a file in it was deleted, so that the deletion
 * survives a power loss. Best effort; an error is ignored. Windows cannot
 * open a folder for this, so it does nothing there.
 */
export async function syncFolder(
  fileSystem: KeyFileSystem,
  folder: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform !== "win32") {
    await flushQuietly(fileSystem, folder, "r");
  }
}

/**
 * Flushes a rename that made `file`, so that it survives a power loss. On
 * Linux and macOS the folder that holds `file` is flushed. Windows cannot
 * flush a folder; there `file` itself is opened again for writing and
 * flushed (`FlushFileBuffers`), which needs write access. Best effort: the
 * rename has already happened, so an error is ignored.
 */
export async function flushRename(
  fileSystem: KeyFileSystem,
  file: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "win32") {
    await flushQuietly(fileSystem, file, "r+");
  } else {
    await flushQuietly(fileSystem, path.dirname(file), "r");
  }
}

/**
 * Writes `data` to `file` atomically, with mode 0600 on Linux and macOS: to a
 * new temporary file in the same folder, created exclusively, flushed and
 * closed, then renamed over `file`, and the rename is flushed. When a step
 * fails, the temporary file is deleted if this call created it, `file` keeps
 * its old content or stays missing, and the error is thrown again.
 */
export async function writeFileAtomic(
  fileSystem: KeyFileSystem,
  file: string,
  data: Uint8Array,
  platform: NodeJS.Platform,
): Promise<void> {
  const temporary = temporaryFileFor(file);
  let handle: KeyFileHandle | undefined;
  let created = false;
  let renamed = false;
  try {
    // "wx" fails if the name exists, also as a symbolic link, so the write
    // never follows a link that someone placed there. A file at that name
    // that this call did not create is left alone.
    handle = await fileSystem.open(temporary, "wx", KEY_FILE_MODE);
    created = true;
    await handle.writeFile(data);
    await handle.sync();
    const closing = handle;
    handle = undefined;
    await closing.close();
    await fileSystem.rename(temporary, file);
    renamed = true;
  } finally {
    if (!renamed) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (created) {
        await removeFile(fileSystem, temporary).catch(() => undefined);
      }
    }
  }
  await flushRename(fileSystem, file, platform);
}
