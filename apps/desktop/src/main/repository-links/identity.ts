// The identity of a linked repository's folders (#286; the Project
// Manager's decision of 2026-11-17). A link records the device and the file
// number (`lstat`: `dev` and `ino`) of the repository's top-level folder and
// of its common Git folder when it is made, and each resolution reads them
// again and compares: a folder that was deleted and replaced at the same
// path, by another clone or anything else, then fails closed until the
// person links it again.
//
// - The numbers are read with `bigint`, so a 64-bit file number stays exact,
//   and kept as decimal text. On Windows, Node.js reports the volume's
//   serial number as `dev` and the file index as `ino`, the best equivalent
//   that it offers.
// - A symbolic link is refused for both folders, and so is a junction on
//   Windows, which `lstat` reports as a symbolic link: the identity of a link
//   would not change when it is pointed at another folder.
// - A file system may give a new folder the number of a deleted one, so a
//   replacement is noticed in most cases, not in all.
import { lstat } from "node:fs/promises";

/** The device and the file number of one folder, as decimal text. */
export interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
}

/** The identity of a repository's folders when it was linked. */
export interface RepositoryFolderIdentity {
  /** The top-level folder of the working tree. */
  readonly folder: FileIdentity;
  /** The common Git folder; differs from `<folder>/.git` in a linked worktree. */
  readonly commonDir: FileIdentity;
}

/** The folders of a mounted repository, as Git reported them. */
export interface RepositoryFolders {
  readonly topLevel: string;
  readonly commonDir: string;
}

/**
 * The identity of a repository's folders, or why it has none: one of them
 * is a symbolic link or a junction (`symbolic_link`), or it is not a folder
 * or cannot be read (`folder_missing`).
 */
export type FolderIdentityResult =
  | { readonly ok: true; readonly identity: RepositoryFolderIdentity }
  | { readonly ok: false; readonly reason: "symbolic_link" | "folder_missing" };

/** What the identity reads of `lstat` with `bigint`. */
export interface FolderStats {
  readonly dev: bigint;
  readonly ino: bigint;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** `lstat` with `bigint`: it never follows a symbolic link. */
export type LstatFunction = (path: string) => Promise<FolderStats>;

/** The system's `lstat`, with `bigint`. */
export const systemLstat: LstatFunction = (path) =>
  lstat(path, { bigint: true });

type OneIdentity =
  | { readonly ok: true; readonly identity: FileIdentity }
  | { readonly ok: false; readonly reason: "symbolic_link" | "folder_missing" };

async function identityOf(
  read: LstatFunction,
  path: string,
): Promise<OneIdentity> {
  let stats: FolderStats;
  try {
    stats = await read(path);
  } catch {
    return { ok: false, reason: "folder_missing" };
  }
  if (stats.isSymbolicLink()) {
    return { ok: false, reason: "symbolic_link" };
  }
  if (
    !stats.isDirectory() ||
    typeof stats.dev !== "bigint" ||
    typeof stats.ino !== "bigint"
  ) {
    return { ok: false, reason: "folder_missing" };
  }
  return {
    ok: true,
    identity: Object.freeze({
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
    }),
  };
}

/** Reads the identity of a repository's folders. Never rejects. */
export async function readFolderIdentity(
  read: LstatFunction,
  folders: RepositoryFolders,
): Promise<FolderIdentityResult> {
  const folder = await identityOf(read, folders.topLevel);
  if (!folder.ok) {
    return Object.freeze({ ok: false, reason: folder.reason });
  }
  const commonDir = await identityOf(read, folders.commonDir);
  if (!commonDir.ok) {
    return Object.freeze({ ok: false, reason: commonDir.reason });
  }
  return Object.freeze({
    ok: true,
    identity: Object.freeze({
      folder: folder.identity,
      commonDir: commonDir.identity,
    }),
  });
}

/** Whether two identities name the same folders. */
export function sameFolderIdentity(
  a: RepositoryFolderIdentity,
  b: RepositoryFolderIdentity,
): boolean {
  return (
    a.folder.dev === b.folder.dev &&
    a.folder.ino === b.folder.ino &&
    a.commonDir.dev === b.commonDir.dev &&
    a.commonDir.ino === b.commonDir.ino
  );
}
