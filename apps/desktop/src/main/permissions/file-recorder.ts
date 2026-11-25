// The local append-only recorder of the permission enforcement point (#37,
// first slice; decision of the Project Manager of 2026-11-25: local first,
// cloud later). It keeps every record of the enforcement point on this
// device, in JSON Lines files in a folder of its own inside the local data
// folder of the device key and the repository links (Project Manager
// decision of 2026-11-25): `%LOCALAPPDATA%\MyManDev` on Windows, which a
// roaming profile never copies, and the data folder (`userData`) on macOS
// and Linux, which does not roam. The caller gives the folder as a function
// (file-recorder-system.ts): it is resolved whenever a file is opened, and
// a folder that cannot be resolved fails the record. An upload to the
// server comes in a later slice; nothing here leaves the device.
//
// - Format. One record per line, UTF-8, ending with "\n": a JSON object
//   whose first field is `version` (`ENFORCEMENT_RECORD_FORMAT_VERSION`),
//   followed by the fields of the record in a fixed order. A record is
//   validated before it is written, and anything that is not exactly a
//   `DenialRecord` or a `ShellStartRecord` (IDs, closed vocabularies, and
//   times) is refused, an unexpected field included.
// - Append only. A file is opened in append mode and never truncated, and
//   each record is written with one write call. A write that fails or is
//   cut short drops the file; a file that does not end with "\n" is never
//   appended to again, so a torn line is never followed by another line in
//   the same file.
// - Still in place. Before each write, the open file must still be the file
//   at its path: linked (`nlink`), a regular file, and with the same file ID
//   and device as the path (`lstat`). A file that was deleted, with its
//   folder or alone, or renamed and replaced, is dropped, and the record
//   goes to the folder and the file opened again, which are created anew.
//   After the flush of a shell start, the file is checked again, and a file
//   that is no longer in place fails the record (`write_failed`).
// - Durability. The record of an allowed shell start is flushed to disk
//   (`fsync`) before `record` returns, and so are the lines written before
//   it. A denial reaches the operating system with its write call, which a
//   crash of the application does not undo, and reaches the disk with the
//   next shell start, the next rotation, or when the file is dropped or
//   closed. Default until the Project Manager decides: a denial loop of a
//   misbehaving executor then does not flush once for every denial on the
//   main process.
// - Rotation. A file holds at most `maxFileBytes`. A record that does not
//   fit starts the next numbered file, and only the newest `maxFiles` files
//   are kept: the older ones are deleted. A closed file's content is never
//   changed, and a file is never renamed. Defaults until the Project Manager
//   decides: 2 MiB per file and 5 files, at most 10 MiB together.
// - Failure. A record that cannot be written, a denial as well as a shell
//   start, makes `record` throw an `EnforcementRecordError` with a code from
//   a closed list, so that the enforcement point denies an allowed shell
//   start (`record_failed`). The next record opens the folder again; after
//   two failures in a row, a denial within `ENFORCEMENT_RECORD_RETRY_MS` of
//   the last attempt fails at once with the last code, but a shell start
//   always tries to write. A newest file that can never be appended to (a
//   folder, a read-only file, a link, a file of another owner) is left as it
//   is, and the next numbered file is started. It never throws anything
//   else, and nothing it does can stop the main process. A file that cannot
//   be deleted at rotation does not fail the record; it is deleted at a
//   later rotation.
// - Permissions. The folder must be a folder, not a link, and is set to its
//   owner only (0o700) whenever it is opened, and each file is readable and
//   writable by its owner only (0o600) on macOS and Linux, where a file is
//   opened with `O_NOFOLLOW`, so a link at a file's name is never followed.
//   Windows ignores these modes, and has no `O_NOFOLLOW`: the files inherit
//   the access rules of the local data folder in the person's profile, a
//   folder link or junction is refused by its `lstat`, and a file link is
//   refused by the check that the open file is the file at its path.
// - Logs. Fixed text with a failure code at most, once when the recorder
//   starts failing and once when it writes again: never a record, an ID, or
//   a path.
//
// The single-instance lock (data-folder.ts) keeps every other instance of
// the application from writing to the same folder.
import * as fs from "node:fs";
import path from "node:path";
import {
  AgentIdSchema,
  CapabilitySchema,
  ProviderConnectionIdSchema,
  RepositoryIdSchema,
  RunIdSchema,
  UtcTimestampSchema,
} from "@mymandev/protocol";
import * as z from "zod";
import {
  ENFORCEMENT_DENIAL_REASONS,
  type EnforcementRecord,
  type EnforcementRecorder,
} from "./enforcement.ts";

/** The folder of the record files, inside the local data folder. */
export const ENFORCEMENT_RECORD_FOLDER = "enforcement-records";

/** The format version of a line; the first field of every line. */
export const ENFORCEMENT_RECORD_FORMAT_VERSION = 1;

/**
 * The bounds of the records: the bytes of one file, the number of files
 * kept, and the bytes of one line.
 */
export interface EnforcementRecordLimits {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxRecordBytes: number;
}

/**
 * The defaults until the Project Manager decides: a file holds at most
 * 2 MiB, about 6,000 records, and the newest 5 files are kept, so the records
 * take at most 10 MiB. A line holds at most 1 KiB; a valid record is about
 * 300 bytes.
 */
export const ENFORCEMENT_RECORD_LIMITS: EnforcementRecordLimits = Object.freeze(
  {
    maxFileBytes: 2 * 1024 * 1024,
    maxFiles: 5,
    maxRecordBytes: 1024,
  },
);

/** A record file is readable and writable by its owner only. */
export const ENFORCEMENT_RECORD_FILE_MODE = 0o600;

/** The folder is for its owner only. */
export const ENFORCEMENT_RECORD_FOLDER_MODE = 0o700;

/**
 * After two failures in a row, a denial within this many milliseconds of the
 * last attempt fails at once with the last code, without touching the disk;
 * a shell start always tries to write. Default until the Project Manager
 * decides.
 */
export const ENFORCEMENT_RECORD_RETRY_MS = 1000;

/**
 * The name of a record file: its number, exactly 8 digits, so that two names
 * never have the same number.
 */
const FILE_NAME = /^enforcement-(\d{8})\.jsonl$/u;

/** The highest file number; a later file fails with `open_failed`. */
export const ENFORCEMENT_RECORD_MAX_SEQUENCE = 99_999_999;

/** The name of record file number `sequence`, 1 to the highest number. */
export function enforcementRecordFileName(sequence: number): string {
  return `enforcement-${String(sequence).padStart(8, "0")}.jsonl`;
}

/**
 * The errors of opening the newest file that waiting does not cure: it is a
 * folder, read-only, of another owner, a link (`O_NOFOLLOW`: `ELOOP`, or
 * `EMLINK` on FreeBSD), or gone. The next numbered file is started instead.
 */
const LASTING_OPEN_ERRORS: ReadonlySet<string> = new Set([
  "EACCES",
  "EPERM",
  "EISDIR",
  "ELOOP",
  "EMLINK",
  "ENOENT",
]);

function isLastingOpenError(error: unknown): boolean {
  try {
    const code: unknown =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    return typeof code === "string" && LASTING_OPEN_ERRORS.has(code);
  } catch {
    return false;
  }
}

/**
 * The flags of a record file: read and append, and on macOS and Linux
 * `O_NOFOLLOW`, so that a link at its name is never followed. Windows has no
 * `O_NOFOLLOW`. A new file is created exclusively (`O_CREAT | O_EXCL`); an
 * existing file is opened without `O_CREAT`, so a file that vanished is never
 * created again by the reopen.
 */
export function enforcementRecordFileFlags(
  platform: NodeJS.Platform,
  create: boolean,
): number {
  const { O_APPEND, O_RDWR, O_CREAT, O_EXCL } = fs.constants;
  const noFollow = platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  return O_APPEND | O_RDWR | noFollow | (create ? O_CREAT | O_EXCL : 0);
}

/**
 * Why a record was not written, a closed list:
 *
 * - `record_invalid`: the record is not a denial or a shell start of the
 *   enforcement point, or it has another field.
 * - `record_too_large`: its line is longer than `maxRecordBytes`.
 * - `folder_unavailable`: the folder cannot be resolved, created, or
 *   listed.
 * - `open_failed`: no record file can be opened or created.
 * - `write_failed`: the write failed or was cut short.
 * - `sync_failed`: the record was written but could not be flushed to disk.
 * - `recorder_closed`: the recorder was closed at quit.
 */
export const ENFORCEMENT_RECORD_FAILURES = Object.freeze([
  "record_invalid",
  "record_too_large",
  "folder_unavailable",
  "open_failed",
  "write_failed",
  "sync_failed",
  "recorder_closed",
] as const);
export type EnforcementRecordFailure =
  (typeof ENFORCEMENT_RECORD_FAILURES)[number];

/** A record that was not written. Its message names no ID and no path. */
export class EnforcementRecordError extends Error {
  readonly code: EnforcementRecordFailure;

  constructor(code: EnforcementRecordFailure) {
    super(`The enforcement record was not written (${code}).`);
    this.name = "EnforcementRecordError";
    this.code = code;
  }
}

/** The fixed text logged when the recorder starts failing. */
export function recordFailureMessage(code: EnforcementRecordFailure): string {
  return `The enforcement records cannot be written (${code}).`;
}

/** The fixed text logged when the recorder writes again after a failure. */
export const RECORDS_WRITTEN_AGAIN_MESSAGE =
  "The enforcement records are written again.";

/** The fixed text logged when an old record file could not be deleted. */
export const OLD_FILE_NOT_DELETED_MESSAGE =
  "An old enforcement record file could not be deleted; it is deleted at a later rotation.";

/**
 * What the recorder reads of an open file. The file ID and the device are
 * read as `bigint`, so that a 64-bit file ID of Windows is compared exactly.
 */
export interface RecorderFileStat {
  readonly size: number;
  readonly nlink: number;
  readonly ino: bigint;
  readonly dev: bigint;
  readonly isFile: boolean;
}

/** What the recorder reads of a path, without following a link. */
export interface RecorderPathStat {
  readonly ino: bigint;
  readonly dev: bigint;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

/**
 * The synchronous part of `node:fs` that the recorder uses. Tests pass a
 * wrapper that fails at a chosen step.
 */
export interface RecorderFileSystem {
  mkdirSync(
    folder: string,
    options: { recursive: true; mode: number },
  ): unknown;
  readdirSync(folder: string): string[];
  openSync(file: string, flags: string | number, mode?: number): number;
  fstatSync(fd: number): RecorderFileStat;
  lstatSync(target: string): RecorderPathStat;
  chmodSync(target: string, mode: number): void;
  readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  writeSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ): number;
  fsyncSync(fd: number): void;
  fchmodSync(fd: number, mode: number): void;
  closeSync(fd: number): void;
  unlinkSync(file: string): void;
}

export const nodeRecorderFileSystem: RecorderFileSystem = Object.freeze({
  mkdirSync: (folder: string, options: { recursive: true; mode: number }) =>
    fs.mkdirSync(folder, options),
  readdirSync: (folder: string) => fs.readdirSync(folder),
  openSync: (file: string, flags: string | number, mode?: number) =>
    fs.openSync(file, flags, mode),
  fstatSync: (fd: number): RecorderFileStat => {
    const stat = fs.fstatSync(fd, { bigint: true });
    return {
      size: Number(stat.size),
      nlink: Number(stat.nlink),
      ino: stat.ino,
      dev: stat.dev,
      isFile: stat.isFile(),
    };
  },
  lstatSync: (target: string): RecorderPathStat => {
    const stat = fs.lstatSync(target, { bigint: true });
    return {
      ino: stat.ino,
      dev: stat.dev,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      isSymbolicLink: stat.isSymbolicLink(),
    };
  },
  chmodSync: (target: string, mode: number) => fs.chmodSync(target, mode),
  readSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => fs.readSync(fd, buffer, offset, length, position),
  writeSync: (fd: number, buffer: Uint8Array, offset: number, length: number) =>
    fs.writeSync(fd, buffer, offset, length),
  fsyncSync: (fd: number) => fs.fsyncSync(fd),
  fchmodSync: (fd: number, mode: number) => fs.fchmodSync(fd, mode),
  closeSync: (fd: number) => fs.closeSync(fd),
  unlinkSync: (file: string) => fs.unlinkSync(file),
});

export interface FileEnforcementRecorderOptions {
  /**
   * The folder of the record files, resolved whenever a file is opened:
   * `ENFORCEMENT_RECORD_FOLDER` in the local data folder. A throw, or a
   * result that is not an absolute path, fails the record with
   * `folder_unavailable`.
   */
  readonly folder: () => string;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Fixed text only. */
  readonly log: (message: string) => void;
  /** Defaults to `node:fs`. */
  readonly fileSystem?: RecorderFileSystem;
  /** Defaults to `ENFORCEMENT_RECORD_LIMITS`. */
  readonly limits?: EnforcementRecordLimits;
  /**
   * A monotonic clock in milliseconds, for the wait after failures.
   * Defaults to `performance.now`. A clock that throws or gives NaN makes no
   * denial wait: when it does so at a failure, no denial waits until the
   * next failure, and when it does so at a check, that denial does not wait.
   */
  readonly now?: () => number;
}

export interface FileEnforcementRecorder extends EnforcementRecorder {
  /**
   * Flushes and closes the open file. Every later record fails with
   * `recorder_closed`. It never throws.
   */
  readonly close: () => void;
}

const DenialLineSchema = z.strictObject({
  kind: z.literal("denied"),
  reason: z.enum(ENFORCEMENT_DENIAL_REASONS),
  capability: CapabilitySchema.nullable(),
  runId: RunIdSchema.nullable(),
  agentId: AgentIdSchema.nullable(),
  repositoryId: RepositoryIdSchema.nullable(),
  providerConnectionId: ProviderConnectionIdSchema.nullable(),
  at: UtcTimestampSchema.nullable(),
});

const ShellStartLineSchema = z.strictObject({
  kind: z.literal("shell_start_allowed"),
  runId: RunIdSchema,
  agentId: AgentIdSchema,
  repositoryId: RepositoryIdSchema,
  at: UtcTimestampSchema,
});

const RecordLineSchema = z.discriminatedUnion("kind", [
  DenialLineSchema,
  ShellStartLineSchema,
]);

/**
 * A copy of the value's own enumerable data properties in an object without
 * a prototype, or null when it is not a non-array object or has an accessor.
 * It never throws.
 */
function plainCopy(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
        return null;
      }
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return null;
  }
}

/**
 * The line of a record, without its "\n", with `version` first and the
 * fields in a fixed order, and the kind of the validated record, or null
 * when the record is not valid. Only the validated copy is used.
 */
export function enforcementRecordLine(
  entry: unknown,
): { readonly kind: EnforcementRecord["kind"]; readonly line: string } | null {
  const copy = plainCopy(entry);
  if (copy === null) {
    return null;
  }
  const parsed = RecordLineSchema.safeParse(copy);
  if (!parsed.success) {
    return null;
  }
  const record = parsed.data;
  const version = ENFORCEMENT_RECORD_FORMAT_VERSION;
  const line = JSON.stringify(
    record.kind === "denied"
      ? {
          version,
          kind: record.kind,
          reason: record.reason,
          capability: record.capability,
          runId: record.runId,
          agentId: record.agentId,
          repositoryId: record.repositoryId,
          providerConnectionId: record.providerConnectionId,
          at: record.at,
        }
      : {
          version,
          kind: record.kind,
          runId: record.runId,
          agentId: record.agentId,
          repositoryId: record.repositoryId,
          at: record.at,
        },
  );
  return { kind: record.kind, line };
}

/** The open record file. */
interface OpenFile {
  readonly fd: number;
  readonly sequence: number;
  /** Its path, in the folder resolved when it was opened. */
  readonly file: string;
  size: number;
}

/** The failures in a row of the disk, for the wait after them. */
interface Retry {
  readonly code: EnforcementRecordFailure;
  readonly failures: number;
  /** A denial before this time fails at once. */
  readonly notBefore: number;
}

/** The failures that come from the disk, after which a denial may wait. */
const DISK_FAILURES: ReadonlySet<EnforcementRecordFailure> = new Set([
  "folder_unavailable",
  "open_failed",
  "write_failed",
  "sync_failed",
] as const);

const NEWLINE = 0x0a;

/**
 * Creates the recorder. It touches the disk only when the first record
 * arrives, so creating it never fails.
 */
export function createFileEnforcementRecorder(
  options: FileEnforcementRecorderOptions,
): FileEnforcementRecorder {
  const { platform, log } = options;
  const resolveFolder = options.folder;
  /** The folder of the open file, resolved when it was opened. */
  let folder = "";
  const fileSystem = options.fileSystem ?? nodeRecorderFileSystem;
  const limits = options.limits ?? ENFORCEMENT_RECORD_LIMITS;
  const now = options.now ?? (() => performance.now());
  const posix = platform !== "win32";
  const appendFlags = enforcementRecordFileFlags(platform, false);
  const createFlags = enforcementRecordFileFlags(platform, true);

  let current: OpenFile | null = null;
  let closed = false;
  /** The code of the last failure, or null while records are written. */
  let failing: EnforcementRecordFailure | null = null;
  /** The failures of the disk in a row, or null after a write. */
  let retry: Retry | null = null;

  function report(message: string): void {
    try {
      log(message);
    } catch {
      // A failing log changes nothing.
    }
  }

  /**
   * The clock, or NaN when it throws. NaN never makes a denial wait: no
   * comparison with it holds, whether it is read at the failure or at the
   * check.
   */
  function clock(): number {
    try {
      return now();
    } catch {
      return Number.NaN;
    }
  }

  /** `fn()`, or a throw of `EnforcementRecordError(code)` when it throws. */
  function step<T>(code: EnforcementRecordFailure, fn: () => T): T {
    try {
      return fn();
    } catch {
      throw new EnforcementRecordError(code);
    }
  }

  /** Closes a descriptor, ignoring an error: nothing more is written to it. */
  function closeQuietly(fd: number): void {
    try {
      fileSystem.closeSync(fd);
    } catch {
      // The descriptor is dropped either way.
    }
  }

  /**
   * Drops the open file: flushes it, ignoring an error, so that the denials
   * written to it reach the disk when they can, and closes it.
   */
  function dropCurrent(): void {
    if (current !== null) {
      const { fd } = current;
      current = null;
      try {
        fileSystem.fsyncSync(fd);
      } catch {
        // Dropped either way.
      }
      closeQuietly(fd);
    }
  }

  /**
   * Whether the open descriptor is still the file at `file`: linked, a
   * regular file, and the same file ID and device as the path, which is a
   * regular file and not a link. Never throws.
   */
  function inPlace(fd: number, file: string): boolean {
    try {
      const open = fileSystem.fstatSync(fd);
      if (open.nlink < 1 || !open.isFile) {
        return false;
      }
      const named = fileSystem.lstatSync(file);
      return (
        named.isFile &&
        !named.isSymbolicLink &&
        named.ino === open.ino &&
        named.dev === open.dev
      );
    } catch {
      return false;
    }
  }

  /** The numbers of the record files in the folder, ascending. */
  function sequences(): number[] {
    const names = step("folder_unavailable", () =>
      fileSystem.readdirSync(folder),
    );
    const found: number[] = [];
    for (const name of names) {
      const match = FILE_NAME.exec(name);
      const sequence = match === null ? NaN : Number(match[1]);
      if (Number.isSafeInteger(sequence)) {
        found.push(sequence);
      }
    }
    return found.sort((a, b) => a - b);
  }

  /**
   * Creates the folder when it is missing, requires it to be a folder and
   * not a link, and restricts it to its owner on macOS and Linux, also when
   * it already existed.
   */
  function prepareFolder(): void {
    step("folder_unavailable", () =>
      fileSystem.mkdirSync(folder, {
        recursive: true,
        mode: ENFORCEMENT_RECORD_FOLDER_MODE,
      }),
    );
    const stat = step("folder_unavailable", () => fileSystem.lstatSync(folder));
    if (!stat.isDirectory || stat.isSymbolicLink) {
      throw new EnforcementRecordError("folder_unavailable");
    }
    if (posix) {
      step("folder_unavailable", () =>
        fileSystem.chmodSync(folder, ENFORCEMENT_RECORD_FOLDER_MODE),
      );
    }
  }

  /** Makes a new folder entry durable; Windows cannot open a folder. */
  function syncFolder(): void {
    if (!posix) {
      return;
    }
    const fd = step("open_failed", () => fileSystem.openSync(folder, "r"));
    try {
      step("sync_failed", () => fileSystem.fsyncSync(fd));
    } finally {
      closeQuietly(fd);
    }
  }

  /** Restricts an open file to its owner, on macOS and Linux. */
  function restrict(fd: number): void {
    if (posix) {
      fileSystem.fchmodSync(fd, ENFORCEMENT_RECORD_FILE_MODE);
    }
  }

  /** Creates record file number `sequence`, which must not exist. */
  function createFile(sequence: number): OpenFile {
    if (sequence > ENFORCEMENT_RECORD_MAX_SEQUENCE) {
      throw new EnforcementRecordError("open_failed");
    }
    const file = path.join(folder, enforcementRecordFileName(sequence));
    // `O_EXCL`: never append to a file that this recorder did not expect.
    const fd = step("open_failed", () =>
      fileSystem.openSync(file, createFlags, ENFORCEMENT_RECORD_FILE_MODE),
    );
    if (!inPlace(fd, file)) {
      // The path no longer names the new file: it is not deleted by path.
      closeQuietly(fd);
      throw new EnforcementRecordError("open_failed");
    }
    try {
      step("open_failed", () => restrict(fd));
      syncFolder();
    } catch (error) {
      // The new file is empty and was created exclusively: it is deleted,
      // so that a failure that repeats never leaves a file per record. It is
      // checked again first, while it is still open, so that a file that
      // took its name meanwhile is not deleted.
      try {
        if (inPlace(fd, file)) {
          fileSystem.unlinkSync(file);
        }
      } catch {
        // An empty newest file is never moved past (`reopenFile`).
      }
      closeQuietly(fd);
      throw error;
    }
    return { fd, sequence, file, size: 0 };
  }

  /**
   * Opens the newest record file to append to it, or null when it must not
   * be appended to: it is full, it does not end with "\n", or it can never
   * be appended to (a folder, a read-only file, a link, a file of another
   * owner, or gone). Another failure, which may pass, throws `open_failed`.
   */
  function reopenFile(sequence: number): OpenFile | null {
    const file = path.join(folder, enforcementRecordFileName(sequence));
    let fd: number;
    try {
      // No `O_CREAT`: a file that vanished is created by `createFile`.
      fd = fileSystem.openSync(file, appendFlags, ENFORCEMENT_RECORD_FILE_MODE);
    } catch (error) {
      if (isLastingOpenError(error)) {
        return null;
      }
      throw new EnforcementRecordError("open_failed");
    }
    try {
      if (!inPlace(fd, file)) {
        // An empty regular file is not moved past: it may be one that
        // `createFile` left because it was not in place, and moving past it
        // would create a file per record. A file whose descriptor cannot be
        // read is not moved past either. A folder is.
        let empty = true;
        try {
          const stat = fileSystem.fstatSync(fd);
          empty = stat.isFile && stat.size === 0;
        } catch {
          // Not moved past.
        }
        if (empty) {
          // Closed by the catch below.
          throw new EnforcementRecordError("open_failed");
        }
        closeQuietly(fd);
        return null;
      }
      const size = step("open_failed", () => fileSystem.fstatSync(fd).size);
      let usable = size < limits.maxFileBytes;
      if (usable && size > 0) {
        const last = new Uint8Array(1);
        const read = step("open_failed", () =>
          fileSystem.readSync(fd, last, 0, 1, size - 1),
        );
        usable = read === 1 && last[0] === NEWLINE;
      }
      if (!usable) {
        closeQuietly(fd);
        return null;
      }
      try {
        restrict(fd);
      } catch (error) {
        // A file of another owner with records in it. An empty file is not
        // moved past: it may be one that `createFile` could not restrict or
        // delete, and moving past it would create a file per record.
        if (size > 0 && isLastingOpenError(error)) {
          closeQuietly(fd);
          return null;
        }
        throw new EnforcementRecordError("open_failed");
      }
      return { fd, sequence, file, size };
    } catch (error) {
      closeQuietly(fd);
      throw error;
    }
  }

  /** Deletes the oldest record files beyond `maxFiles`. Never throws. */
  function prune(newest: number): void {
    let found: number[];
    try {
      found = sequences().filter((sequence) => sequence <= newest);
    } catch {
      report(OLD_FILE_NOT_DELETED_MESSAGE);
      return;
    }
    const excess = found.length - limits.maxFiles;
    let failed = false;
    for (const sequence of found.slice(0, Math.max(0, excess))) {
      try {
        fileSystem.unlinkSync(
          path.join(folder, enforcementRecordFileName(sequence)),
        );
      } catch {
        failed = true;
      }
    }
    if (failed) {
      report(OLD_FILE_NOT_DELETED_MESSAGE);
    }
  }

  /**
   * The open file, when it is still in place; otherwise the folder is
   * resolved and prepared again, and the newest file is opened, or the next
   * one created. At most one file is created per call.
   */
  function openCurrent(): OpenFile {
    if (current !== null) {
      if (inPlace(current.fd, current.file)) {
        return current;
      }
      // Deleted, or renamed and replaced: what it holds is no longer at its
      // path, so the record goes to the file at the path.
      dropCurrent();
    }
    folder = step("folder_unavailable", () => {
      const resolved: unknown = resolveFolder();
      if (typeof resolved !== "string" || !path.isAbsolute(resolved)) {
        throw new TypeError("The record folder is not an absolute path.");
      }
      return resolved;
    });
    prepareFolder();
    const found = sequences();
    const newest = found.at(-1);
    const opened =
      (newest === undefined ? null : reopenFile(newest)) ??
      createFile((newest ?? 0) + 1);
    current = opened;
    prune(opened.sequence);
    return opened;
  }

  /** Flushes and closes the open file and creates the next one. */
  function rotate(open: OpenFile): OpenFile {
    current = null;
    try {
      step("sync_failed", () => fileSystem.fsyncSync(open.fd));
    } finally {
      closeQuietly(open.fd);
    }
    const next = createFile(open.sequence + 1);
    current = next;
    prune(next.sequence);
    return next;
  }

  function write(entry: EnforcementRecord): void {
    if (closed) {
      throw new EnforcementRecordError("recorder_closed");
    }
    const validated = enforcementRecordLine(entry);
    if (validated === null) {
      throw new EnforcementRecordError("record_invalid");
    }
    const bytes = Buffer.from(`${validated.line}\n`, "utf8");
    if (bytes.length > limits.maxRecordBytes) {
      throw new EnforcementRecordError("record_too_large");
    }
    const shellStart = validated.kind === "shell_start_allowed";
    // A shell start always tries to write; a denial after two failures in a
    // row waits, so that a denial loop does not open the folder each time.
    if (
      !shellStart &&
      retry !== null &&
      retry.failures >= 2 &&
      clock() < retry.notBefore
    ) {
      throw new EnforcementRecordError(retry.code);
    }
    try {
      let open = openCurrent();
      if (open.size > 0 && open.size + bytes.length > limits.maxFileBytes) {
        open = rotate(open);
      }
      // One write call for the whole line.
      const written = step("write_failed", () =>
        fileSystem.writeSync(open.fd, bytes, 0, bytes.length),
      );
      if (written !== bytes.length) {
        throw new EnforcementRecordError("write_failed");
      }
      open.size += written;
      if (shellStart) {
        step("sync_failed", () => fileSystem.fsyncSync(open.fd));
        // Deleted or replaced between the check and the flush: the record
        // is not at the path, so the start is not allowed.
        if (!inPlace(open.fd, open.file)) {
          throw new EnforcementRecordError("write_failed");
        }
      }
    } catch (error) {
      // The file is dropped: the next record opens the folder again, and a
      // file with a torn line is never appended to.
      dropCurrent();
      const failure =
        error instanceof EnforcementRecordError
          ? error
          : new EnforcementRecordError("write_failed");
      if (DISK_FAILURES.has(failure.code)) {
        retry = {
          code: failure.code,
          failures: (retry?.failures ?? 0) + 1,
          notBefore: clock() + ENFORCEMENT_RECORD_RETRY_MS,
        };
      }
      throw failure;
    }
    retry = null;
  }

  return Object.freeze({
    record: (entry: EnforcementRecord): undefined => {
      try {
        write(entry);
      } catch (error) {
        const failure =
          error instanceof EnforcementRecordError
            ? error
            : new EnforcementRecordError("write_failed");
        if (failing !== failure.code) {
          failing = failure.code;
          report(recordFailureMessage(failure.code));
        }
        throw failure;
      }
      if (failing !== null) {
        failing = null;
        report(RECORDS_WRITTEN_AGAIN_MESSAGE);
      }
      return undefined;
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      // Flushed and closed.
      dropCurrent();
    },
  });
}
