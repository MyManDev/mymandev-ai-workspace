// The read tools of an agent's run (#36, first slice; Project Manager
// decision of 2026-11-25: read tools first, then write and Git, then the
// shell). Each needs `repo.read` on the run's repository, which the
// dispatcher (`tool-dispatcher.ts`) checks before the tool runs, and works
// only inside the repository's folder that the repository links resolved
// for this call.
//
// Path safety, in this order, for every call:
//
// 1. The path passes the lexical rules of `repository-path.ts`: relative,
//    POSIX form, no `..`, no `.git`, no hidden name, no device name, no
//    stream.
// 2. The repository's folder and the path are resolved to their real paths.
//    The real path must lie inside the folder's real path (`outside`), and
//    must be exactly the path under it (`alias`): a path through a symbolic
//    link or a junction is refused, also one that stays inside, and so is a
//    path in another case or with a short name, which the real path writes
//    otherwise (defaults until the Project Manager decides).
// 3. A file is opened read-only (with `O_NOFOLLOW` and `O_NONBLOCK` where
//    the system has them), and checked after the open: the open file must
//    be a regular file with one link, and the same file (device and file
//    number) as the path's `lstat` before the open; after the open, the
//    path must still resolve to itself and its `lstat` must be the open
//    file. A swap between the check and the open is refused (`changed`). A
//    folder is checked the same way before and after it is listed.
//
// No answer holds an absolute path: an answer names the path that the tool
// got and the names in a folder, never the folder of the repository.
import fs, { constants as fsConstants } from "node:fs";
import path, { type PlatformPath } from "node:path";
import * as z from "zod";
import { relativeInside } from "../repository-watcher.ts";
import {
  parseRepositoryPath,
  type RepositoryPath,
  type RepositoryPathRefusal,
  segmentRefusal,
} from "./repository-path.ts";
import {
  defineTool,
  type Tool,
  type ToolRunContext,
  type ToolRunOutcome,
} from "./tool-dispatcher.ts";

/**
 * The bounds of the read tools (defaults until the Project Manager
 * decides):
 *
 * - `maxFileBytes`: at most this many bytes of a file are read and
 *   answered; a longer file is read up to it and answered with
 *   `truncated: true`.
 * - `maxDirectoryEntries`: at most this many names of a folder are read; a
 *   folder with more is answered with `truncated: true`.
 *
 * With `MAX_TOOL_ANSWER_BYTES` of the dispatcher, they bound what one call
 * gives the agent.
 */
export const READ_TOOL_LIMITS = Object.freeze({
  maxFileBytes: 128 * 1024,
  maxDirectoryEntries: 1_000,
});

/** The names of the read tools (defaults until the Project Manager decides). */
export const READ_TOOL_NAMES = Object.freeze({
  listDirectory: "list_directory",
  readFile: "read_file",
} as const);

/** What a file system entry is, without following a link. */
export type ToolFileKind = "file" | "directory" | "link" | "other";

/** What the read tools read of a file system entry. */
export interface ToolFileStat {
  readonly kind: ToolFileKind;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
}

/** A file that the read tools opened, read-only. */
export interface ToolFileHandle {
  /** `fstat` of the open file. */
  stat(): Promise<ToolFileStat>;
  /** Reads into `buffer` from `position`; the count of bytes read, 0 at the end. */
  read(buffer: Uint8Array, position: number): Promise<number>;
  close(): Promise<void>;
}

export interface ToolDirectoryEntry {
  readonly name: string;
  readonly kind: ToolFileKind;
}

/** The file system of the read tools; `createSystemReadToolFileSystem`. */
export interface ReadToolFileSystem {
  /** The real path, as `fs.promises.realpath` (the system's `realpath`). */
  realpath(target: string): Promise<string>;
  /** `lstat`: a link is not followed. */
  lstat(target: string): Promise<ToolFileStat>;
  /** Opens a file to read only, never to create or write. */
  open(target: string): Promise<ToolFileHandle>;
  /**
   * At most `limit` entries of a folder, in the system's order, and whether
   * it holds more.
   */
  readdir(
    target: string,
    limit: number,
  ): Promise<{
    readonly entries: readonly ToolDirectoryEntry[];
    readonly more: boolean;
  }>;
}

type Failure = Extract<ToolRunOutcome, { ok: false }>;

function failed(
  code: Failure["code"],
  reason?: RepositoryPathRefusal,
): Failure {
  return Object.freeze(
    reason === undefined ? { ok: false, code } : { ok: false, code, reason },
  );
}

const ABORTED = failed("aborted");

/** The code of an error of the file system, or undefined. */
function errorCode(error: unknown): unknown {
  try {
    return typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an error of the file system says that nothing is at the path. */
function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function sameEntry(a: ToolFileStat, b: ToolFileStat): boolean {
  return a.kind === b.kind && a.dev === b.dev && a.ino === b.ino;
}

/** The real path of a checked path, and of the repository's folder. */
interface Resolved {
  readonly root: string;
  readonly real: string;
}

/**
 * Resolves a path that passed the lexical rules under the repository's
 * folder, and refuses a real path outside the folder's real path or not
 * exactly the path under it.
 */
async function resolveInside(
  files: ReadToolFileSystem,
  pathApi: PlatformPath,
  folder: string,
  target: RepositoryPath,
): Promise<Resolved | Failure> {
  let root: string;
  try {
    root = await files.realpath(folder);
  } catch {
    return failed("read_failed");
  }
  const lexical =
    target.segments.length === 0
      ? root
      : pathApi.join(root, ...target.segments);
  let real: string;
  try {
    real = await files.realpath(lexical);
  } catch (error) {
    return failed(isMissing(error) ? "not_found" : "read_failed");
  }
  if (real !== root && relativeInside(root, real, pathApi) === undefined) {
    return failed("path_refused", "outside");
  }
  if (real !== lexical) {
    return failed("path_refused", "alias");
  }
  return { root, real };
}

/**
 * Checks after a read that the path still resolves to itself and that its
 * `lstat` is still `expected`.
 */
async function stillInPlace(
  files: ReadToolFileSystem,
  real: string,
  expected: ToolFileStat,
): Promise<boolean> {
  try {
    if ((await files.realpath(real)) !== real) {
      return false;
    }
    return sameEntry(await files.lstat(real), expected);
  } catch {
    return false;
  }
}

/** Whether the name of a folder's entry may be shown (`segmentRefusal`). */
function shown(name: string): boolean {
  return segmentRefusal(name) === null;
}

/** Text without NUL that is valid UTF-8, or null for binary content. */
function textOf(bytes: Uint8Array, truncated: boolean): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    // A read that stops inside a character leaves it out.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: truncated,
    });
  } catch {
    return null;
  }
}

const PathInputSchema = z.strictObject({ path: z.string() });

export interface ReadToolOptions {
  readonly files: ReadToolFileSystem;
  /** The system's path functions, `node:path` by default. */
  readonly pathApi?: PlatformPath;
}

/**
 * The read tools: `list_directory` and `read_file`. Each takes
 * `{ path }`, a path relative to the repository's top-level folder in POSIX
 * form, `.` for the folder itself.
 */
export function createReadTools(options: ReadToolOptions): readonly Tool[] {
  const files = options.files;
  const pathApi = options.pathApi ?? path;

  async function listDirectory(
    input: { path: string },
    context: ToolRunContext,
  ): Promise<ToolRunOutcome> {
    const parsed = parseRepositoryPath(input.path);
    if (!parsed.ok) {
      return failed("path_refused", parsed.reason);
    }
    const resolved = await resolveInside(
      files,
      pathApi,
      context.folder,
      parsed.path,
    );
    if (!("real" in resolved)) {
      return resolved;
    }
    if (context.signal.aborted) {
      return ABORTED;
    }
    let before: ToolFileStat;
    try {
      before = await files.lstat(resolved.real);
    } catch (error) {
      return failed(isMissing(error) ? "not_found" : "read_failed");
    }
    if (before.kind !== "directory") {
      return failed("not_a_directory");
    }
    if (context.signal.aborted) {
      return ABORTED;
    }
    let listing: Awaited<ReturnType<ReadToolFileSystem["readdir"]>>;
    try {
      listing = await files.readdir(
        resolved.real,
        READ_TOOL_LIMITS.maxDirectoryEntries,
      );
    } catch {
      return failed("read_failed");
    }
    if (!(await stillInPlace(files, resolved.real, before))) {
      return failed("path_refused", "changed");
    }
    if (context.signal.aborted) {
      return ABORTED;
    }
    const read = listing.entries.slice(0, READ_TOOL_LIMITS.maxDirectoryEntries);
    // Hidden names, `.git`, and names that a path could not name again are
    // left out and counted.
    const entries = read
      .filter((entry) => shown(entry.name))
      .map((entry) => ({ name: entry.name, kind: entry.kind }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      ok: true,
      result: {
        path: parsed.path.text,
        entries,
        omitted: read.length - entries.length,
        truncated:
          listing.more ||
          listing.entries.length > READ_TOOL_LIMITS.maxDirectoryEntries,
      },
    };
  }

  async function readFile(
    input: { path: string },
    context: ToolRunContext,
  ): Promise<ToolRunOutcome> {
    const parsed = parseRepositoryPath(input.path);
    if (!parsed.ok) {
      return failed("path_refused", parsed.reason);
    }
    const resolved = await resolveInside(
      files,
      pathApi,
      context.folder,
      parsed.path,
    );
    if (!("real" in resolved)) {
      return resolved;
    }
    if (context.signal.aborted) {
      return ABORTED;
    }
    let before: ToolFileStat;
    try {
      before = await files.lstat(resolved.real);
    } catch (error) {
      return failed(isMissing(error) ? "not_found" : "read_failed");
    }
    if (before.kind !== "file") {
      return failed("not_a_file");
    }
    if (before.nlink !== 1n) {
      return failed("path_refused", "hard_link");
    }
    if (context.signal.aborted) {
      return ABORTED;
    }
    let handle: ToolFileHandle;
    try {
      handle = await files.open(resolved.real);
    } catch (error) {
      // `O_NOFOLLOW` refuses a link that took the file's place.
      if (errorCode(error) === "ELOOP") {
        return failed("path_refused", "changed");
      }
      return failed(isMissing(error) ? "not_found" : "read_failed");
    }
    try {
      let opened: ToolFileStat;
      try {
        opened = await handle.stat();
      } catch {
        return failed("read_failed");
      }
      // The open file must be the file that was checked, and the path must
      // still name it after the open.
      if (!sameEntry(opened, before)) {
        return failed("path_refused", "changed");
      }
      if (opened.nlink !== 1n) {
        return failed("path_refused", "hard_link");
      }
      if (!(await stillInPlace(files, resolved.real, opened))) {
        return failed("path_refused", "changed");
      }

      const limit = READ_TOOL_LIMITS.maxFileBytes;
      // One byte more than the bound tells whether the file is longer.
      const buffer = new Uint8Array(limit + 1);
      let filled = 0;
      while (filled < buffer.length) {
        if (context.signal.aborted) {
          return ABORTED;
        }
        let count: number;
        try {
          count = await handle.read(buffer.subarray(filled), filled);
        } catch {
          return failed("read_failed");
        }
        if (
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > buffer.length - filled
        ) {
          return failed("read_failed");
        }
        if (count === 0) {
          break;
        }
        filled += count;
      }
      const truncated = filled > limit;
      const bytes = buffer.subarray(0, Math.min(filled, limit));
      const content = textOf(bytes, truncated);
      return {
        ok: true,
        result: {
          path: parsed.path.text,
          size: Number(opened.size),
          truncated,
          binary: content === null,
          // Binary content is not answered (default until the Project
          // Manager decides).
          content,
        },
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return Object.freeze([
    defineTool({
      name: READ_TOOL_NAMES.listDirectory,
      capability: "repo.read",
      input: PathInputSchema,
      run: listDirectory,
    }),
    defineTool({
      name: READ_TOOL_NAMES.readFile,
      capability: "repo.read",
      input: PathInputSchema,
      run: readFile,
    }),
  ]);
}

function kindOf(entry: {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
}): ToolFileKind {
  if (entry.isSymbolicLink()) {
    return "link";
  }
  if (entry.isFile()) {
    return "file";
  }
  return entry.isDirectory() ? "directory" : "other";
}

function statOf(stats: fs.BigIntStats): ToolFileStat {
  return Object.freeze({
    kind: kindOf(stats),
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    size: stats.size,
  });
}

/**
 * Read only, never following a link at the last name and never waiting on
 * a named pipe where the system has these flags (Windows has neither; the
 * checks after the open cover it).
 */
const OPEN_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0);

/** The read tools' file system on `node:fs`. */
export function createSystemReadToolFileSystem(): ReadToolFileSystem {
  return Object.freeze({
    realpath: (target: string) => fs.promises.realpath(target),
    lstat: async (target: string) =>
      statOf(await fs.promises.lstat(target, { bigint: true })),
    open: async (target: string): Promise<ToolFileHandle> => {
      const handle = await fs.promises.open(target, OPEN_FLAGS);
      return Object.freeze({
        stat: async () => statOf(await handle.stat({ bigint: true })),
        read: async (buffer: Uint8Array, position: number) =>
          (await handle.read(buffer, 0, buffer.length, position)).bytesRead,
        close: () => handle.close(),
      });
    },
    readdir: async (target: string, limit: number) => {
      const directory = await fs.promises.opendir(target, { bufferSize: 32 });
      const entries: ToolDirectoryEntry[] = [];
      let more = false;
      try {
        for (;;) {
          const entry = await directory.read();
          if (entry === null) {
            break;
          }
          if (entries.length >= limit) {
            more = true;
            break;
          }
          entries.push(
            Object.freeze({ name: entry.name, kind: kindOf(entry) }),
          );
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      return Object.freeze({ entries: Object.freeze(entries), more });
    },
  });
}
