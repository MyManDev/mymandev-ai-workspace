// The local append-only recorder of the permission enforcement point (#37,
// first slice; decision of the Project Manager of 2026-11-25: local first,
// cloud later). It keeps every record of the enforcement point on this
// device, in JSON Lines files in a folder of its own inside the data folder
// (Electron's `userData` path). An upload to the server comes in a later
// slice; nothing here leaves the device.
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
// - Durability. The record of an allowed shell start is flushed to disk
//   (`fsync`) before `record` returns, and so are the lines written before
//   it. A denial reaches the operating system with its write call, which a
//   crash of the application does not undo, and reaches the disk with the
//   next shell start, the next rotation, or the close at quit. Default until
//   the Project Manager decides: a denial loop of a misbehaving executor
//   then does not flush once for every denial on the main process.
// - Rotation. A file holds at most `maxFileBytes`. A record that does not
//   fit starts the next numbered file, and only the newest `maxFiles` files
//   are kept: the older ones are deleted. A closed file's content is never
//   changed, and a file is never renamed. Defaults until the Project Manager
//   decides: 2 MiB per file and 5 files, at most 10 MiB together.
// - Failure. A record that cannot be written, a denial as well as a shell
//   start, makes `record` throw an `EnforcementRecordError` with a code from
//   a closed list, so that the enforcement point denies an allowed shell
//   start (`record_failed`). The next record opens the folder again. It
//   never throws anything else, and nothing it does can stop the main
//   process. A file that cannot be deleted at rotation does not fail the
//   record; it is deleted at a later rotation.
// - Permissions. The folder is created for its owner only (0o700) and each
//   file is readable and writable by its owner only (0o600) on macOS and
//   Linux. Windows ignores these modes: the files inherit the access rules
//   of the data folder in the person's profile.
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

/** The folder of the record files, inside the data folder. */
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

/** The name of a record file: its number, 8 digits or more. */
const FILE_NAME = /^enforcement-(\d{8,})\.jsonl$/u;

/** The name of record file number `sequence`. */
export function enforcementRecordFileName(sequence: number): string {
  return `enforcement-${String(sequence).padStart(8, "0")}.jsonl`;
}

/**
 * Why a record was not written, a closed list:
 *
 * - `record_invalid`: the record is not a denial or a shell start of the
 *   enforcement point, or it has another field.
 * - `record_too_large`: its line is longer than `maxRecordBytes`.
 * - `folder_unavailable`: the folder cannot be created or listed.
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
 * The synchronous part of `node:fs` that the recorder uses. Tests pass a
 * wrapper that fails at a chosen step.
 */
export interface RecorderFileSystem {
  mkdirSync(
    folder: string,
    options: { recursive: true; mode: number },
  ): unknown;
  readdirSync(folder: string): string[];
  openSync(file: string, flags: string, mode?: number): number;
  fstatSync(fd: number): { size: number };
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
  openSync: (file: string, flags: string, mode?: number) =>
    fs.openSync(file, flags, mode),
  fstatSync: (fd: number) => fs.fstatSync(fd),
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
  /** The folder of the record files: `ENFORCEMENT_RECORD_FOLDER` in `userData`. */
  readonly folder: string;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Fixed text only. */
  readonly log: (message: string) => void;
  /** Defaults to `node:fs`. */
  readonly fileSystem?: RecorderFileSystem;
  /** Defaults to `ENFORCEMENT_RECORD_LIMITS`. */
  readonly limits?: EnforcementRecordLimits;
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
  size: number;
}

const NEWLINE = 0x0a;

/**
 * Creates the recorder. It touches the disk only when the first record
 * arrives, so creating it never fails.
 */
export function createFileEnforcementRecorder(
  options: FileEnforcementRecorderOptions,
): FileEnforcementRecorder {
  const { folder, platform, log } = options;
  const fileSystem = options.fileSystem ?? nodeRecorderFileSystem;
  const limits = options.limits ?? ENFORCEMENT_RECORD_LIMITS;
  const posix = platform !== "win32";

  let current: OpenFile | null = null;
  let closed = false;
  /** The code of the last failure, or null while records are written. */
  let failing: EnforcementRecordFailure | null = null;

  function report(message: string): void {
    try {
      log(message);
    } catch {
      // A failing log changes nothing.
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

  /** Drops the open file after a failure, without flushing it. */
  function dropCurrent(): void {
    if (current !== null) {
      closeQuietly(current.fd);
      current = null;
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
    const file = path.join(folder, enforcementRecordFileName(sequence));
    // `x`: never append to a file that this recorder did not expect.
    const fd = step("open_failed", () =>
      fileSystem.openSync(file, "ax", ENFORCEMENT_RECORD_FILE_MODE),
    );
    try {
      step("open_failed", () => restrict(fd));
      syncFolder();
    } catch (error) {
      closeQuietly(fd);
      throw error;
    }
    return { fd, sequence, size: 0 };
  }

  /**
   * Opens the newest record file to append to it, or null when it must not
   * be appended to: it is full, or it does not end with "\n".
   */
  function reopenFile(sequence: number): OpenFile | null {
    const file = path.join(folder, enforcementRecordFileName(sequence));
    const fd = step("open_failed", () =>
      fileSystem.openSync(file, "a+", ENFORCEMENT_RECORD_FILE_MODE),
    );
    try {
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
      step("open_failed", () => restrict(fd));
      return { fd, sequence, size };
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

  /** The open file, opened or created when there is none. */
  function openCurrent(): OpenFile {
    if (current !== null) {
      return current;
    }
    step("folder_unavailable", () =>
      fileSystem.mkdirSync(folder, {
        recursive: true,
        mode: ENFORCEMENT_RECORD_FOLDER_MODE,
      }),
    );
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
      if (validated.kind === "shell_start_allowed") {
        step("sync_failed", () => fileSystem.fsyncSync(open.fd));
      }
    } catch (error) {
      // The file is dropped: the next record opens the folder again, and a
      // file with a torn line is never appended to.
      dropCurrent();
      throw error instanceof EnforcementRecordError
        ? error
        : new EnforcementRecordError("write_failed");
    }
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
      if (current !== null) {
        try {
          fileSystem.fsyncSync(current.fd);
        } catch {
          // Closed either way.
        }
        dropCurrent();
      }
    },
  });
}
