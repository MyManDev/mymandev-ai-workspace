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
// 2. The repository's folder, as the resolution named it, and its real path
//    must each be a folder, not a link, with the identity (device and file
//    number) that the link recorded (`changed`).
// 3. The path is resolved to its real path, which must lie inside the
//    folder's real path (`outside`) and be exactly the path under it
//    (`alias`): a path through a symbolic link or a junction is refused,
//    also one that stays inside, and so is a path in another case or with a
//    short name, which the real path writes otherwise (defaults until the
//    Project Manager decides).
// 4. Every folder from the repository's folder down to the path's parent is
//    read with `lstat` and recorded with its change time: each must be a
//    folder, not a link (`changed`), on the repository's device
//    (`other_device`), and so must the file or folder itself: a mount of
//    another file system (another device) inside the repository is refused.
//    A bind mount from the same file system keeps its device and is not
//    seen (README, "Mounts").
// 5. The change times of these folders, and of a folder to list, must be
//    settled: older than the start of the call by more than the steps of
//    the file system's clock (`READ_TOOL_SETTLING`). Otherwise the call
//    waits and starts again; after three attempts it is refused
//    (`unsettled`).
// 6. A file is opened read-only (with `O_NOFOLLOW` and `O_NONBLOCK` where
//    the system has them), and checked after the open: its `fstat` must be
//    on the repository's device, a regular file with one link, and the same
//    file as the path's `lstat` before the open; on Linux, its real path
//    through `/proc/self/fd` must be the path; and then the path must still
//    resolve to itself, every recorded folder must still be the same folder
//    and not a link, the path's `lstat` must be the open file, the folders
//    are checked once more, now also with their change times, and the path
//    must resolve to itself again. A swap is refused (`changed`); a change
//    time that moved starts the call again (step 5). A folder is checked
//    the same way before and after it is listed, its own change time
//    included.
//
// Why the change times close the window that checks by path leave (Node.js
// cannot open or list relative to an open folder, and only Linux names an
// open file): a folder's change time moves whenever an entry in it is
// created, removed, renamed, or replaced, and whenever the folder itself
// becomes a link in place (a junction on Windows). A settled change time
// that is the same before the open (or the listing) and after the checks
// that follow it shows that no folder on the path changed in between, so
// the path named, without any link, the folder that was listed or the file
// that the checks after the open saw, which is the open file. An answer is
// given only when the clock did not go back during the attempt. This holds
// against a process that can change entries inside the repository. The one
// case that remains where the system cannot name the open file (Windows,
// macOS): the folders above the repository's folder are not checked this
// way, so a process that can rename them can still switch the path above
// the repository for exactly the open. See the README ("TOCTOU") for that
// case and the assumptions about the file system's clock.
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

/**
 * How the read tools wait for settled change times (defaults until the
 * Project Manager decides):
 *
 * - `marginMs`: a folder's change time must be older than the start of the
 *   call by more than this, which is more than the steps of the clocks that
 *   stamp change times (NTFS and ReFS: one tick of the system clock, at
 *   most 15.625 ms; ext4: one tick of the kernel; APFS: finer).
 * - `coarseMarginMs`: the same for a change time on a whole second, which
 *   may come from a file system that stamps whole seconds (HFS+, ext3) or
 *   two seconds (FAT).
 * - `attempts`: how often a call starts, at most, before it is refused
 *   (`unsettled`); it waits for the change times before each new attempt,
 *   at most `coarseMarginMs + marginMs` each time.
 */
export const READ_TOOL_SETTLING = Object.freeze({
  marginMs: 100,
  coarseMarginMs: 2_000,
  attempts: 3,
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
  /**
   * The change time (`ctime`; on Windows the change time of NTFS, not the
   * creation time), in nanoseconds since 1970, or 0 where the file system
   * has none.
   */
  readonly ctime: bigint;
}

/** A file that the read tools opened, read-only. */
export interface ToolFileHandle {
  /** `fstat` of the open file. */
  stat(): Promise<ToolFileStat>;
  /**
   * The real path of the open file itself, where the system can name it
   * (`/proc/self/fd` on Linux), or undefined where it cannot (Windows,
   * macOS). It rejects when the system could name it but did not.
   */
  realPath(): Promise<string | undefined>;
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

/** A folder on a checked path, and its `lstat` when it was checked. */
interface CheckedFolder {
  readonly path: string;
  readonly stat: ToolFileStat;
}

/** The real path of a checked path, and what it was checked against. */
interface Resolved {
  readonly real: string;
  /** The device of the repository's folder, as the link recorded it. */
  readonly dev: bigint;
  /**
   * The folders from the repository's real folder down to the path's
   * parent, each a folder (not a link) on `dev`; for `.`, the repository's
   * folder alone.
   */
  readonly folders: readonly CheckedFolder[];
}

const DECIMAL = /^(?:0|[1-9][0-9]{0,39})$/;

/** The recorded identity of the repository's folder as numbers, or null. */
function recordedIdentity(
  identity: unknown,
): { readonly dev: bigint; readonly ino: bigint } | null {
  if (typeof identity !== "object" || identity === null) {
    return null;
  }
  const { dev, ino } = identity as { dev?: unknown; ino?: unknown };
  if (
    typeof dev !== "string" ||
    typeof ino !== "string" ||
    !DECIMAL.test(dev) ||
    !DECIMAL.test(ino)
  ) {
    return null;
  }
  return { dev: BigInt(dev), ino: BigInt(ino) };
}

/** Why a folder on a checked path is refused, or null. */
function folderRefusal(stat: ToolFileStat, dev: bigint): Failure | null {
  if (stat.kind !== "directory") {
    // The real path named a folder here: a link now is a swap.
    return failed("path_refused", "changed");
  }
  if (stat.dev !== dev) {
    return failed("path_refused", "other_device");
  }
  return null;
}

/**
 * Resolves a path that passed the lexical rules under the repository's
 * folder:
 *
 * - The folder that the resolution named, and its real path, must each be
 *   a folder, not a link, with the identity that the link recorded
 *   (`changed`), so a folder swapped after the resolution moves nothing.
 * - A real path outside the folder's real path is refused (`outside`), and
 *   so is one that is not exactly the path under it (`alias`).
 * - Every folder from the real folder down to the path's parent is read
 *   with `lstat` and recorded: each must be a folder (`changed`) on the
 *   repository's device (`other_device`).
 */
async function resolveInside(
  files: ReadToolFileSystem,
  pathApi: PlatformPath,
  context: ToolRunContext,
  target: RepositoryPath,
): Promise<Resolved | Failure> {
  const recorded = recordedIdentity(context.folderIdentity);
  if (recorded === null) {
    return failed("path_refused", "changed");
  }
  const isRecorded = (stat: ToolFileStat) =>
    stat.kind === "directory" &&
    stat.dev === recorded.dev &&
    stat.ino === recorded.ino;
  let root: string;
  let rootStat: ToolFileStat;
  try {
    if (!isRecorded(await files.lstat(context.folder))) {
      return failed("path_refused", "changed");
    }
    root = await files.realpath(context.folder);
    rootStat = await files.lstat(root);
  } catch {
    return failed("read_failed");
  }
  if (!isRecorded(rootStat)) {
    return failed("path_refused", "changed");
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
  const folders: CheckedFolder[] = [{ path: root, stat: rootStat }];
  let current = root;
  for (const segment of target.segments.slice(0, -1)) {
    current = pathApi.join(current, segment);
    let stat: ToolFileStat;
    try {
      stat = await files.lstat(current);
    } catch (error) {
      return failed(isMissing(error) ? "not_found" : "read_failed");
    }
    const refusal = folderRefusal(stat, recorded.dev);
    if (refusal !== null) {
      return refusal;
    }
    folders.push({ path: current, stat });
  }
  return { real, dev: recorded.dev, folders };
}

/**
 * What the checks after an open or a listing found: everything in place;
 * everything the same entry, but a change time moved (`moved`, the call
 * starts again); or a swap (`changed`).
 */
type PlaceCheck = "same" | "moved" | "changed";

/**
 * Checks every recorded folder, in order from the repository's folder down:
 * still a folder, not a link, with its device and file number (`changed`
 * otherwise); with `changeTimes`, also with its change time (`moved`
 * otherwise).
 */
async function foldersInPlace(
  files: ReadToolFileSystem,
  folders: readonly CheckedFolder[],
  changeTimes: boolean,
): Promise<PlaceCheck> {
  let moved = false;
  for (const folder of folders) {
    const stat = await files.lstat(folder.path);
    if (!sameEntry(stat, folder.stat)) {
      return "changed";
    }
    if (changeTimes && stat.ctime !== folder.stat.ctime) {
      moved = true;
    }
  }
  return moved ? "moved" : "same";
}

/**
 * Checks after an open or a listing, in this order: the path still
 * resolves to itself, its folders are still in place, its `lstat` is still
 * `expected` (with its change time too, for a listed folder), its folders
 * are still in place with their change times, and the path still resolves
 * to itself. A change time never goes back, so the last check of the
 * folders sees every change since their first `lstat`.
 */
async function stillInPlace(
  files: ReadToolFileSystem,
  resolved: Resolved,
  expected: ToolFileStat,
  listedFolder: boolean,
): Promise<PlaceCheck> {
  const { real, folders } = resolved;
  try {
    if (
      (await files.realpath(real)) !== real ||
      (await foldersInPlace(files, folders, false)) !== "same"
    ) {
      return "changed";
    }
    const stat = await files.lstat(real);
    if (!sameEntry(stat, expected)) {
      return "changed";
    }
    const last = await foldersInPlace(files, folders, true);
    if (last === "changed" || (await files.realpath(real)) !== real) {
      return "changed";
    }
    return last === "moved" || (listedFolder && stat.ctime !== expected.ctime)
      ? "moved"
      : "same";
  } catch {
    return "changed";
  }
}

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const NANOSECONDS_PER_SECOND = 1_000_000_000n;

/** A call to start again once the change times are settled. */
interface Unsettled {
  readonly unsettled: true;
  /** How long to wait first, in milliseconds. */
  readonly waitMs: number;
}

const MOVED: Unsettled = Object.freeze({ unsettled: true, waitMs: 0 });

/**
 * Whether the change times of these folders are settled at `started`, the
 * start of the attempt in nanoseconds since 1970: each must be older by
 * more than the margin of `READ_TOOL_SETTLING`, the coarse one for a change
 * time on a whole second. Then any later change of an entry, which the
 * file system stamps with a later step of its clock, moves the change time.
 * A file system without change times cannot show a change: `read_failed`
 * (fail closed).
 */
function settledAt(
  stats: readonly ToolFileStat[],
  started: bigint,
): Failure | Unsettled | null {
  let wait = 0n;
  for (const stat of stats) {
    if (stat.ctime <= 0n) {
      return failed("read_failed");
    }
    const margin =
      BigInt(
        stat.ctime % NANOSECONDS_PER_SECOND === 0n
          ? READ_TOOL_SETTLING.coarseMarginMs
          : READ_TOOL_SETTLING.marginMs,
      ) * NANOSECONDS_PER_MILLISECOND;
    const left = stat.ctime + margin - started;
    if (left >= 0n && left + 1n > wait) {
      wait = left + 1n;
    }
  }
  if (wait === 0n) {
    return null;
  }
  const most = READ_TOOL_SETTLING.coarseMarginMs + READ_TOOL_SETTLING.marginMs;
  const waitMs =
    (wait + NANOSECONDS_PER_MILLISECOND - 1n) / NANOSECONDS_PER_MILLISECOND;
  return Object.freeze({
    unsettled: true,
    waitMs: waitMs > BigInt(most) ? most : Number(waitMs),
  });
}

/** Waits `ms`, or less once the signal aborts. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
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
  /**
   * The clock that the change times are compared with, in milliseconds
   * since 1970: `Date.now` by default, the clock that stamps them.
   */
  readonly now?: () => number;
  /** Waits for settled change times; a timer by default. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * The read tools: `list_directory` and `read_file`. Each takes
 * `{ path }`, a path relative to the repository's top-level folder in POSIX
 * form, `.` for the folder itself.
 */
export function createReadTools(options: ReadToolOptions): readonly Tool[] {
  const files = options.files;
  const pathApi = options.pathApi ?? path;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepUnlessAborted;
  const nowNs = () => BigInt(Math.floor(now())) * NANOSECONDS_PER_MILLISECOND;

  /**
   * Runs `attempt` until it settles, at most `READ_TOOL_SETTLING.attempts`
   * times, with the start of each attempt; it waits as long as an attempt
   * asks before the next. The last attempt that does not settle is refused
   * (`unsettled`).
   */
  async function settled(
    context: ToolRunContext,
    attempt: (started: bigint) => Promise<ToolRunOutcome | Unsettled>,
  ): Promise<ToolRunOutcome> {
    for (let count = 1; ; count += 1) {
      if (context.signal.aborted) {
        return ABORTED;
      }
      const started = nowNs();
      let outcome = await attempt(started);
      // A clock set back during the attempt could stamp a change with the
      // change time of an earlier one: an answer is given only when the
      // clock did not go back before the attempt's start.
      if ("ok" in outcome && outcome.ok && nowNs() < started) {
        outcome = MOVED;
      }
      if (!("unsettled" in outcome)) {
        return outcome;
      }
      if (count >= READ_TOOL_SETTLING.attempts) {
        return failed("path_refused", "unsettled");
      }
      if (outcome.waitMs > 0) {
        await sleep(outcome.waitMs, context.signal);
      }
    }
  }

  function listDirectory(
    input: { path: string },
    context: ToolRunContext,
  ): Promise<ToolRunOutcome> {
    const parsed = parseRepositoryPath(input.path);
    if (!parsed.ok) {
      return Promise.resolve(failed("path_refused", parsed.reason));
    }
    return settled(context, (started) =>
      listOnce(parsed.path, context, started),
    );
  }

  async function listOnce(
    target: RepositoryPath,
    context: ToolRunContext,
    started: bigint,
  ): Promise<ToolRunOutcome | Unsettled> {
    const resolved = await resolveInside(files, pathApi, context, target);
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
    if (before.dev !== resolved.dev) {
      return failed("path_refused", "other_device");
    }
    // The folder itself counts too: on Windows, an empty folder can become
    // a junction in place, which moves only its own change time.
    const unsettled = settledAt(
      [...resolved.folders.map((folder) => folder.stat), before],
      started,
    );
    if (unsettled !== null) {
      return unsettled;
    }
    if (context.signal.aborted) {
      return ABORTED;
    }
    // The folders on the path are checked again right before the listing,
    // and again after it with the folder itself.
    try {
      if ((await foldersInPlace(files, resolved.folders, false)) !== "same") {
        return failed("path_refused", "changed");
      }
    } catch {
      return failed("path_refused", "changed");
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
    const place = await stillInPlace(files, resolved, before, true);
    if (place !== "same") {
      return place === "moved" ? MOVED : failed("path_refused", "changed");
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
        path: target.text,
        entries,
        omitted: read.length - entries.length,
        truncated:
          listing.more ||
          listing.entries.length > READ_TOOL_LIMITS.maxDirectoryEntries,
      },
    };
  }

  function readFile(
    input: { path: string },
    context: ToolRunContext,
  ): Promise<ToolRunOutcome> {
    const parsed = parseRepositoryPath(input.path);
    if (!parsed.ok) {
      return Promise.resolve(failed("path_refused", parsed.reason));
    }
    return settled(context, (started) =>
      readOnce(parsed.path, context, started),
    );
  }

  async function readOnce(
    target: RepositoryPath,
    context: ToolRunContext,
    started: bigint,
  ): Promise<ToolRunOutcome | Unsettled> {
    const resolved = await resolveInside(files, pathApi, context, target);
    if (!("real" in resolved)) {
      return resolved;
    }
    const unsettled = settledAt(
      resolved.folders.map((folder) => folder.stat),
      started,
    );
    if (unsettled !== null) {
      return unsettled;
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
    if (before.dev !== resolved.dev) {
      return failed("path_refused", "other_device");
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
      // The open file must lie on the repository's device and be the file
      // that was checked, and the path must still name it after the open.
      if (opened.dev !== resolved.dev) {
        return failed("path_refused", "other_device");
      }
      if (!sameEntry(opened, before)) {
        return failed("path_refused", "changed");
      }
      if (opened.nlink !== 1n) {
        return failed("path_refused", "hard_link");
      }
      // Where the system names the open file itself (Linux), that name must
      // be the checked path: this holds whatever a folder on the path was
      // during the open.
      let openedPath: string | undefined;
      try {
        openedPath = await handle.realPath();
      } catch {
        return failed("path_refused", "changed");
      }
      if (openedPath !== undefined && openedPath !== resolved.real) {
        return failed("path_refused", "changed");
      }
      // From here on the content comes from the open file, which the checks
      // tied to the path; a later change of the path changes nothing read.
      const place = await stillInPlace(files, resolved, opened, false);
      if (place !== "same") {
        return place === "moved" ? MOVED : failed("path_refused", "changed");
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
          path: target.text,
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
      recordPath,
      run: listDirectory,
    }),
    defineTool({
      name: READ_TOOL_NAMES.readFile,
      capability: "repo.read",
      input: PathInputSchema,
      recordPath,
      run: readFile,
    }),
  ]);
}

/**
 * The path of a call's record: the path that the tool got, when it passes
 * the lexical rules, so that it is relative to the repository and never
 * absolute; null otherwise. A path that the lexical rules refuse is never
 * recorded, since it may name a folder outside the repository.
 */
function recordPath(input: { path: string }): string | null {
  const parsed = parseRepositoryPath(input.path);
  return parsed.ok ? parsed.path.text : null;
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
    ctime: stats.ctimeNs,
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

/**
 * The real path of an open file through `/proc/self/fd`, on Linux only and
 * where that folder exists; undefined elsewhere. It rejects when the folder
 * exists but does not name the file (a deleted file, for one).
 */
async function realPathOfOpenFile(fd: number): Promise<string | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    return await fs.promises.realpath(`/proc/self/fd/${fd}`);
  } catch (error) {
    const hasProc = await fs.promises
      .stat("/proc/self/fd")
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (!hasProc) {
      return undefined;
    }
    throw error;
  }
}

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
        realPath: () => realPathOfOpenFile(handle.fd),
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
