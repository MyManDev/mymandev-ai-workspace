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
//   followed by the fields of the record in a fixed order, with U+2028 and
//   U+2029 escaped as well (still the same JSON). A record is validated
//   before it is written, and anything that is not exactly a `DenialRecord`,
//   a `ShellStartRecord`, a `ToolCallRecord` (tool-call-record.ts; IDs,
//   closed vocabularies, times, and a tool call's path relative to the
//   repository), or a `ContextWalkRecord` (context-walk-record.ts; IDs, a
//   result code, counts within the bounds of the file list, a flag, and a
//   time) is refused, an unexpected field included. A tool call's path
//   with a lone surrogate or a Unicode format character (`\p{Cf}`, the bidi
//   overrides and the BOM included) is refused too; the dispatcher records
//   such a path as null.
// - Versions (Project Manager decision of 2026-11-26). The version changes
//   only when a field of an existing kind is added, removed, or changes its
//   meaning. A new kind is added under the same version, and the lines of
//   the kinds before it never change; a reader skips a kind that it does not
//   know. A value may be added to a closed list of an existing kind (the
//   result codes of a tool call, the denial reasons, the capability names)
//   under the same version, and a reader accepts a value that it does not
//   know. So `tool_call_allowed` (#37, Project Manager decision of
//   2026-11-26) and `context_walk` (#366) are lines of version 1, and the
//   lines written before them keep their meaning.
// - Two series (Project Manager decision of 2026-11-26). The denials and the
//   shell starts are written to `enforcement-<8 digits>.jsonl`, and the
//   allowed tool calls and the walks of a run's context (#366) to
//   `enforcement-tool-calls-<8 digits>.jsonl`, in the same folder. Each
//   series has its own open file, numbering, rotation, size tracking, wait
//   after failures, and logs, so that tool calls never rotate a denial or a
//   shell start away.
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
//   it in its file; then the open file of the tool calls is flushed too,
//   ignoring an error, which never fails the start. A denial, an allowed
//   tool call, and a walk reach the operating system with their write call,
//   which a crash of the application does not undo, and reach the disk with
//   the next shell start, the next rotation of their series, or when their
//   file is dropped or closed. Default until the Project Manager decides: a
//   denial loop of a misbehaving executor, or the many reads of an agent,
//   then do not flush once for every record on the main process.
// - Rotation. A file holds at most `maxFileBytes`. A record that does not
//   fit starts the next numbered file of its series, and only the newest
//   `maxFiles` files of each series are kept: the older ones of that series
//   are deleted. A closed file's content is never changed, and a file is
//   never renamed. Defaults until the Project Manager decides: 2 MiB per file
//   and 5 files for each series, so at most 10 MiB for each and 20 MiB
//   together.
// - Failure. A record that cannot be written, of any kind, makes `record`
//   throw an `EnforcementRecordError` with a code from a closed list, so that
//   the enforcement point denies an allowed shell start (`record_failed`),
//   the tool dispatcher refuses an allowed tool call (`record_failed`), and
//   the context builder leaves the repository out of a run's context
//   (`unavailable`). The next record opens the folder again; after two
//   failures of its series in a row, a denial, a tool call, or a walk within
//   `ENFORCEMENT_RECORD_RETRY_MS` of the last attempt fails at once with the
//   last code, but a shell start always tries to write. A newest file that
//   can never be appended to (a folder, a read-only file, a link, a file of
//   another owner) is left as it is, and the next numbered file is started. It never throws anything
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
// - Logs. Fixed text with a failure code at most, for each series once when
//   it starts failing and once when it writes again (a record refused before
//   its series is known counts for the denials and shell starts): never a
//   record, an ID, or a path.
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
import { REPOSITORY_FILE_LIST_LIMITS } from "../tools/repository-files.ts";
import { parseRepositoryPath } from "../tools/repository-path.ts";
import { CONTEXT_WALK_RECORD_RESULTS } from "./context-walk-record.ts";
import {
  ENFORCEMENT_DENIAL_REASONS,
  type EnforcementRecord,
  type EnforcementRecorder,
} from "./enforcement.ts";
import {
  isRecordablePathText,
  TOOL_CALL_RECORD_RESULTS,
  TOOL_NAME_PATTERN,
} from "./tool-call-record.ts";

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
 * The defaults until the Project Manager decides, for each of the two
 * series: a file holds at most 2 MiB, about 6,000 records, and the newest 5
 * files are kept, so each series takes at most 10 MiB, and both at most
 * 20 MiB. A line holds at most 8 KiB, so that a tool call's record holds the
 * longest path that a tool takes (`MAX_REPOSITORY_PATH_LENGTH`, 1,024 UTF-16
 * code units, at most 6 bytes each as the line writes them); a denial or a
 * shell start is about 300 bytes.
 */
export const ENFORCEMENT_RECORD_LIMITS: EnforcementRecordLimits = Object.freeze(
  {
    maxFileBytes: 2 * 1024 * 1024,
    maxFiles: 5,
    maxRecordBytes: 8 * 1024,
  },
);

/** A record file is readable and writable by its owner only. */
export const ENFORCEMENT_RECORD_FILE_MODE = 0o600;

/** The folder is for its owner only. */
export const ENFORCEMENT_RECORD_FOLDER_MODE = 0o700;

/**
 * After two failures of its series in a row, a denial, a tool call, or a
 * walk within this many milliseconds of the last attempt fails at once with
 * the last code, without touching the disk; a shell start always tries to
 * write. Default until the Project Manager decides.
 */
export const ENFORCEMENT_RECORD_RETRY_MS = 1000;

/**
 * The name of a record file of the denials and shell starts: its number,
 * exactly 8 digits, so that two names never have the same number.
 */
const FILE_NAME = /^enforcement-(\d{8})\.jsonl$/u;

/**
 * The name of a record file of the allowed tool calls and the walks of a
 * run's context, a series of its own: its number, exactly 8 digits.
 */
const TOOL_CALL_FILE_NAME = /^enforcement-tool-calls-(\d{8})\.jsonl$/u;

/** The highest file number; a later file fails with `open_failed`. */
export const ENFORCEMENT_RECORD_MAX_SEQUENCE = 99_999_999;

/**
 * The name of record file number `sequence` of the denials and shell starts,
 * 1 to the highest number.
 */
export function enforcementRecordFileName(sequence: number): string {
  return `enforcement-${String(sequence).padStart(8, "0")}.jsonl`;
}

/**
 * The name of record file number `sequence` of the allowed tool calls, 1 to
 * the highest number.
 */
export function enforcementToolCallFileName(sequence: number): string {
  return `enforcement-tool-calls-${String(sequence).padStart(8, "0")}.jsonl`;
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
 *   enforcement point, a tool call of the dispatcher, or a walk of the
 *   context builder, or it has another field.
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

/**
 * A tool call's path: exactly a path that passes the lexical rules of
 * `parseRepositoryPath`, so relative to the repository, in POSIX form, and
 * never absolute, a drive, or a UNC path; and text that may be recorded
 * (`isRecordablePathText`: no lone surrogate, no format character).
 */
const RecordPathSchema = z.string().refine((value) => {
  if (!isRecordablePathText(value)) {
    return false;
  }
  const parsed = parseRepositoryPath(value);
  return parsed.ok && parsed.path.text === value;
});

const ToolCallLineSchema = z.strictObject({
  kind: z.literal("tool_call_allowed"),
  tool: z.string().regex(TOOL_NAME_PATTERN),
  capability: CapabilitySchema,
  path: RecordPathSchema.nullable(),
  result: z.enum(TOOL_CALL_RECORD_RESULTS),
  runId: RunIdSchema,
  agentId: AgentIdSchema,
  repositoryId: RepositoryIdSchema,
  providerConnectionId: ProviderConnectionIdSchema.nullable(),
  at: UtcTimestampSchema,
});

/**
 * A count of a walk: an integer from 0 to its bound in
 * `REPOSITORY_FILE_LIST_LIMITS`, or null for a walk without a list.
 */
function walkCount(max: number) {
  return z.number().int().min(0).max(max).nullable();
}

/**
 * A walk of a run's context: the counts and the flag are given for the
 * result `ok` and null for every other result.
 */
const ContextWalkLineSchema = z
  .strictObject({
    kind: z.literal("context_walk"),
    result: z.enum(CONTEXT_WALK_RECORD_RESULTS),
    files: walkCount(REPOSITORY_FILE_LIST_LIMITS.maxFiles),
    folders: walkCount(REPOSITORY_FILE_LIST_LIMITS.maxFolders),
    truncated: z.boolean().nullable(),
    runId: RunIdSchema,
    agentId: AgentIdSchema,
    repositoryId: RepositoryIdSchema,
    providerConnectionId: ProviderConnectionIdSchema.nullable(),
    at: UtcTimestampSchema,
  })
  .refine((walk) => {
    const listed = walk.result === "ok";
    return (
      (walk.files !== null) === listed &&
      (walk.folders !== null) === listed &&
      (walk.truncated !== null) === listed
    );
  });

const RecordLineSchema = z.discriminatedUnion("kind", [
  DenialLineSchema,
  ShellStartLineSchema,
  ToolCallLineSchema,
  ContextWalkLineSchema,
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
  let fields: Record<string, unknown>;
  switch (record.kind) {
    case "denied":
      fields = {
        version,
        kind: record.kind,
        reason: record.reason,
        capability: record.capability,
        runId: record.runId,
        agentId: record.agentId,
        repositoryId: record.repositoryId,
        providerConnectionId: record.providerConnectionId,
        at: record.at,
      };
      break;
    case "shell_start_allowed":
      fields = {
        version,
        kind: record.kind,
        runId: record.runId,
        agentId: record.agentId,
        repositoryId: record.repositoryId,
        at: record.at,
      };
      break;
    case "tool_call_allowed":
      fields = {
        version,
        kind: record.kind,
        tool: record.tool,
        capability: record.capability,
        path: record.path,
        result: record.result,
        runId: record.runId,
        agentId: record.agentId,
        repositoryId: record.repositoryId,
        providerConnectionId: record.providerConnectionId,
        at: record.at,
      };
      break;
    case "context_walk":
      fields = {
        version,
        kind: record.kind,
        result: record.result,
        files: record.files,
        folders: record.folders,
        truncated: record.truncated,
        runId: record.runId,
        agentId: record.agentId,
        repositoryId: record.repositoryId,
        providerConnectionId: record.providerConnectionId,
        at: record.at,
      };
      break;
    default: {
      // A new kind does not compile until its line is written here.
      const unknownKind: never = record;
      return unknownKind;
    }
  }
  return { kind: record.kind, line: lineText(fields) };
}

/**
 * The JSON text of a line's fields, with U+2028 and U+2029 escaped as well,
 * so that no reader splits a line at them; it is still the same JSON.
 */
function lineText(fields: Record<string, unknown>): string {
  return JSON.stringify(fields).replace(/[\u2028\u2029]/gu, (separator) =>
    separator === "\u2028" ? "\\u2028" : "\\u2029",
  );
}

/** The open record file. */
interface OpenFile {
  readonly fd: number;
  readonly sequence: number;
  /** The folder it is in, resolved when it was opened. */
  readonly folder: string;
  /** Its path, in that folder. */
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

/**
 * A series of record files, with its own names, its own rotation and size
 * tracking, and its own state of failure: one for the denials and shell
 * starts, and one for the allowed tool calls and the walks of a run's
 * context, so that tool calls never rotate a denial or a shell start away.
 */
interface Series {
  /** The name of its file number `sequence`. */
  readonly fileName: (sequence: number) => string;
  /** The names of its files, with the number. */
  readonly pattern: RegExp;
  /** Its open file. */
  current: OpenFile | null;
  /** The code of its last failure, or null while its records are written. */
  failing: EnforcementRecordFailure | null;
  /** Its failures of the disk in a row, or null after a write. */
  retry: Retry | null;
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
  const fileSystem = options.fileSystem ?? nodeRecorderFileSystem;
  const limits = options.limits ?? ENFORCEMENT_RECORD_LIMITS;
  const now = options.now ?? (() => performance.now());
  const posix = platform !== "win32";
  const appendFlags = enforcementRecordFileFlags(platform, false);
  const createFlags = enforcementRecordFileFlags(platform, true);

  /** The denials and the shell starts. */
  const records: Series = {
    fileName: enforcementRecordFileName,
    pattern: FILE_NAME,
    current: null,
    failing: null,
    retry: null,
  };
  /** The allowed tool calls and the walks of a run's context. */
  const toolCalls: Series = {
    fileName: enforcementToolCallFileName,
    pattern: TOOL_CALL_FILE_NAME,
    current: null,
    failing: null,
    retry: null,
  };
  let closed = false;

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
   * Drops the open file of the series: flushes it, ignoring an error, so that
   * the denials written to it reach the disk when they can, and closes it.
   */
  function dropCurrent(series: Series): void {
    if (series.current !== null) {
      const { fd } = series.current;
      series.current = null;
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

  /** The numbers of the series' files in the folder, ascending. */
  function sequences(series: Series, folder: string): number[] {
    const names = step("folder_unavailable", () =>
      fileSystem.readdirSync(folder),
    );
    const found: number[] = [];
    for (const name of names) {
      const match = series.pattern.exec(name);
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
  function prepareFolder(folder: string): void {
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
  function syncFolder(folder: string): void {
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

  /** Creates the series' file number `sequence`, which must not exist. */
  function createFile(
    series: Series,
    folder: string,
    sequence: number,
  ): OpenFile {
    if (sequence > ENFORCEMENT_RECORD_MAX_SEQUENCE) {
      throw new EnforcementRecordError("open_failed");
    }
    const file = path.join(folder, series.fileName(sequence));
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
      syncFolder(folder);
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
    return { fd, sequence, folder, file, size: 0 };
  }

  /**
   * Opens the series' newest file to append to it, or null when it must not
   * be appended to: it is full, it does not end with "\n", or it can never
   * be appended to (a folder, a read-only file, a link, a file of another
   * owner, or gone). Another failure, which may pass, throws `open_failed`.
   */
  function reopenFile(
    series: Series,
    folder: string,
    sequence: number,
  ): OpenFile | null {
    const file = path.join(folder, series.fileName(sequence));
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
      return { fd, sequence, folder, file, size };
    } catch (error) {
      closeQuietly(fd);
      throw error;
    }
  }

  /**
   * Deletes the oldest files of the series beyond `maxFiles`; the files of
   * the other series are never counted or deleted. Never throws.
   */
  function prune(series: Series, folder: string, newest: number): void {
    let found: number[];
    try {
      found = sequences(series, folder).filter(
        (sequence) => sequence <= newest,
      );
    } catch {
      report(OLD_FILE_NOT_DELETED_MESSAGE);
      return;
    }
    const excess = found.length - limits.maxFiles;
    let failed = false;
    for (const sequence of found.slice(0, Math.max(0, excess))) {
      try {
        fileSystem.unlinkSync(path.join(folder, series.fileName(sequence)));
      } catch {
        failed = true;
      }
    }
    if (failed) {
      report(OLD_FILE_NOT_DELETED_MESSAGE);
    }
  }

  /**
   * The series' open file, when it is still in place; otherwise the folder
   * is resolved and prepared again, and the series' newest file is opened,
   * or its next one created. At most one file is created per call.
   */
  function openCurrent(series: Series): OpenFile {
    const { current } = series;
    if (current !== null) {
      if (inPlace(current.fd, current.file)) {
        return current;
      }
      // Deleted, or renamed and replaced: what it holds is no longer at its
      // path, so the record goes to the file at the path.
      dropCurrent(series);
    }
    const folder = step("folder_unavailable", () => {
      const resolved: unknown = resolveFolder();
      if (typeof resolved !== "string" || !path.isAbsolute(resolved)) {
        throw new TypeError("The record folder is not an absolute path.");
      }
      return resolved;
    });
    prepareFolder(folder);
    const found = sequences(series, folder);
    const newest = found.at(-1);
    const opened =
      (newest === undefined ? null : reopenFile(series, folder, newest)) ??
      createFile(series, folder, (newest ?? 0) + 1);
    series.current = opened;
    prune(series, folder, opened.sequence);
    return opened;
  }

  /**
   * Flushes and closes the series' open file and creates its next one, in
   * the same folder.
   */
  function rotate(series: Series, open: OpenFile): OpenFile {
    series.current = null;
    try {
      step("sync_failed", () => fileSystem.fsyncSync(open.fd));
    } finally {
      closeQuietly(open.fd);
    }
    const next = createFile(series, open.folder, open.sequence + 1);
    series.current = next;
    prune(series, open.folder, next.sequence);
    return next;
  }

  /**
   * Flushes the open file of the series, ignoring an error: the tool calls
   * written before a shell start reach the disk with it.
   */
  function flushQuietly(series: Series): void {
    if (series.current !== null) {
      try {
        fileSystem.fsyncSync(series.current.fd);
      } catch {
        // Flushed at its next rotation, drop, or close.
      }
    }
  }

  /** Writes the validated line to its series, or throws. */
  function write(
    series: Series,
    validated: NonNullable<ReturnType<typeof enforcementRecordLine>>,
  ): void {
    const bytes = Buffer.from(`${validated.line}\n`, "utf8");
    if (bytes.length > limits.maxRecordBytes) {
      throw new EnforcementRecordError("record_too_large");
    }
    const shellStart = validated.kind === "shell_start_allowed";
    // A shell start always tries to write; a denial, a tool call, or a walk
    // after two failures of its series in a row waits, so that a loop does
    // not open the folder each time.
    const { retry } = series;
    if (
      !shellStart &&
      retry !== null &&
      retry.failures >= 2 &&
      clock() < retry.notBefore
    ) {
      throw new EnforcementRecordError(retry.code);
    }
    try {
      let open = openCurrent(series);
      if (open.size > 0 && open.size + bytes.length > limits.maxFileBytes) {
        open = rotate(series, open);
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
        flushQuietly(toolCalls);
      }
    } catch (error) {
      // The file is dropped: the next record of the series opens the folder
      // again, and a file with a torn line is never appended to.
      dropCurrent(series);
      const failure =
        error instanceof EnforcementRecordError
          ? error
          : new EnforcementRecordError("write_failed");
      if (DISK_FAILURES.has(failure.code)) {
        series.retry = {
          code: failure.code,
          failures: (retry?.failures ?? 0) + 1,
          notBefore: clock() + ENFORCEMENT_RECORD_RETRY_MS,
        };
      }
      throw failure;
    }
    series.retry = null;
  }

  return Object.freeze({
    record: (entry: EnforcementRecord): undefined => {
      // A record refused before its series is known counts for the series
      // of the denials and shell starts.
      let series = records;
      try {
        if (closed) {
          throw new EnforcementRecordError("recorder_closed");
        }
        const validated = enforcementRecordLine(entry);
        if (validated === null) {
          throw new EnforcementRecordError("record_invalid");
        }
        // A walk of a run's context goes with the tool calls (#366).
        if (
          validated.kind === "tool_call_allowed" ||
          validated.kind === "context_walk"
        ) {
          series = toolCalls;
        }
        write(series, validated);
      } catch (error) {
        const failure =
          error instanceof EnforcementRecordError
            ? error
            : new EnforcementRecordError("write_failed");
        if (series.failing !== failure.code) {
          series.failing = failure.code;
          report(recordFailureMessage(failure.code));
        }
        throw failure;
      }
      if (series.failing !== null) {
        series.failing = null;
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
      dropCurrent(records);
      dropCurrent(toolCalls);
    },
  });
}
