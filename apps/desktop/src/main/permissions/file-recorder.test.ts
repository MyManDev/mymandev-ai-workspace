import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GrantRecordSchema } from "@mymandev/permissions";
import { afterEach, expect, test } from "vitest";
import {
  createPermissionEnforcement,
  type DenialRecord,
  type EnforcementRecord,
  type HeldRun,
  type ShellStartRecord,
} from "./enforcement.ts";
import {
  createFileEnforcementRecorder,
  ENFORCEMENT_RECORD_FAILURES,
  ENFORCEMENT_RECORD_FOLDER,
  ENFORCEMENT_RECORD_FORMAT_VERSION,
  ENFORCEMENT_RECORD_LIMITS,
  type EnforcementRecordFailure,
  EnforcementRecordError,
  type EnforcementRecordLimits,
  enforcementRecordFileName,
  type FileEnforcementRecorder,
  nodeRecorderFileSystem,
  OLD_FILE_NOT_DELETED_MESSAGE,
  RECORDS_WRITTEN_AGAIN_MESSAGE,
  type RecorderFileSystem,
  recordFailureMessage,
} from "./file-recorder.ts";

const RUN_ID = "0192f0a0-7b3c-7d4e-8f50-000000000001";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000002";
const DEVICE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000004";
const PROJECT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000006";
const WORKSPACE_ID = "0192f0a0-7b3c-7d4e-8f50-000000000007";
const USER_ID = "0192f0a0-7b3c-7d4e-8f50-000000000008";
const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009";
const PROVIDER_CONNECTION_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000b";
const GRANT_ID = "0192f0a0-7b3c-7d4e-8f50-00000000000d";
const IDS = [
  RUN_ID,
  AGENT_ID,
  DEVICE_ID,
  REPOSITORY_ID,
  PROVIDER_CONNECTION_ID,
  GRANT_ID,
];

const AT = "2026-11-25T10:00:00.000Z";

const DENIAL: DenialRecord = Object.freeze({
  kind: "denied",
  reason: "no_grant",
  capability: "provider.use",
  runId: RUN_ID,
  agentId: AGENT_ID,
  repositoryId: REPOSITORY_ID,
  providerConnectionId: PROVIDER_CONNECTION_ID,
  at: AT,
}) as DenialRecord;

const MALFORMED_DENIAL: DenialRecord = Object.freeze({
  kind: "denied",
  reason: "run_invalid",
  capability: null,
  runId: null,
  agentId: null,
  repositoryId: null,
  providerConnectionId: null,
  at: null,
});

const START: ShellStartRecord = Object.freeze({
  kind: "shell_start_allowed",
  runId: RUN_ID,
  agentId: AGENT_ID,
  repositoryId: REPOSITORY_ID,
  at: AT,
}) as ShellStartRecord;

const DENIAL_LINE =
  '{"version":1,"kind":"denied","reason":"no_grant","capability":"provider.use",' +
  `"runId":"${RUN_ID}","agentId":"${AGENT_ID}","repositoryId":"${REPOSITORY_ID}",` +
  `"providerConnectionId":"${PROVIDER_CONNECTION_ID}","at":"${AT}"}`;

const START_LINE =
  '{"version":1,"kind":"shell_start_allowed",' +
  `"runId":"${RUN_ID}","agentId":"${AGENT_ID}","repositoryId":"${REPOSITORY_ID}",` +
  `"at":"${AT}"}`;

const temporaryFolders: string[] = [];
const openRecorders: FileEnforcementRecorder[] = [];

afterEach(() => {
  for (const recorder of openRecorders.splice(0)) {
    recorder.close();
  }
  for (const folder of temporaryFolders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

/** A new empty folder; the record folder inside it does not exist yet. */
function dataFolder(): string {
  const folder = mkdtempSync(path.join(tmpdir(), "enforcement-records-test-"));
  temporaryFolders.push(folder);
  return folder;
}

/** One call of the file system, with the file name only, never the folder. */
interface FsCall {
  readonly name: keyof RecorderFileSystem;
  readonly args: readonly unknown[];
}

/**
 * The real `node:fs` with every call noted, and `overrides` in place of the
 * calls that a test makes fail.
 */
function spyFileSystem(overrides: Partial<RecorderFileSystem> = {}) {
  const calls: FsCall[] = [];
  const real: RecorderFileSystem = { ...nodeRecorderFileSystem, ...overrides };
  const fileSystem = Object.fromEntries(
    (Object.keys(nodeRecorderFileSystem) as (keyof RecorderFileSystem)[]).map(
      (name) => [
        name,
        (...args: unknown[]) => {
          calls.push({ name, args });
          return (real[name] as (...a: unknown[]) => unknown)(...args);
        },
      ],
    ),
  ) as unknown as RecorderFileSystem;
  const named = (name: keyof RecorderFileSystem) =>
    calls.filter((call) => call.name === name);
  return { fileSystem, calls, named };
}

function setup(
  options: {
    platform?: NodeJS.Platform;
    fileSystem?: RecorderFileSystem;
    limits?: EnforcementRecordLimits;
    root?: string;
  } = {},
) {
  const root = options.root ?? dataFolder();
  const folder = path.join(root, ENFORCEMENT_RECORD_FOLDER);
  const logs: string[] = [];
  const recorder = createFileEnforcementRecorder({
    folder: () => folder,
    platform: options.platform ?? process.platform,
    log: (message) => logs.push(message),
    ...(options.fileSystem === undefined
      ? {}
      : { fileSystem: options.fileSystem }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  openRecorders.push(recorder);
  const file = (sequence: number) =>
    path.join(folder, enforcementRecordFileName(sequence));
  const read = (sequence: number) => readFileSync(file(sequence), "utf8");
  const files = () => readdirSync(folder).sort();
  return { root, folder, recorder, logs, file, read, files };
}

/** The code of the `EnforcementRecordError` that `fn` throws. */
function failureOf(fn: () => unknown): EnforcementRecordFailure {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EnforcementRecordError);
    const code = (error as EnforcementRecordError).code;
    expect(ENFORCEMENT_RECORD_FAILURES).toContain(code);
    // The message names no ID and no path.
    for (const id of IDS) {
      expect((error as Error).message).not.toContain(id);
    }
    expect((error as Error).message).not.toMatch(/[\\/]/u);
    expect((error as Error).cause).toBeUndefined();
    return code;
  }
  throw new Error("The record did not fail.");
}

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: failed, '/secret/path'`), { code });
}

// Format.

test("each record is one JSON line with the format version first, in the data folder's own record folder", () => {
  const { recorder, read, files, folder, root } = setup();
  expect(recorder.record(DENIAL)).toBeUndefined();
  expect(recorder.record(START)).toBeUndefined();
  expect(recorder.record(MALFORMED_DENIAL)).toBeUndefined();
  expect(ENFORCEMENT_RECORD_FORMAT_VERSION).toBe(1);
  expect(path.dirname(folder)).toBe(root);
  expect(path.basename(folder)).toBe("enforcement-records");
  expect(files()).toEqual(["enforcement-00000001.jsonl"]);
  expect(read(1)).toBe(
    `${DENIAL_LINE}\n${START_LINE}\n` +
      '{"version":1,"kind":"denied","reason":"run_invalid","capability":null,' +
      '"runId":null,"agentId":null,"repositoryId":null,' +
      '"providerConnectionId":null,"at":null}\n',
  );
  for (const line of read(1).trimEnd().split("\n")) {
    expect(JSON.parse(line)).toHaveProperty("version", 1);
  }
});

test("the defaults are 2 MiB per file, 5 files, and 1 KiB per record", () => {
  expect(ENFORCEMENT_RECORD_LIMITS).toEqual({
    maxFileBytes: 2 * 1024 * 1024,
    maxFiles: 5,
    maxRecordBytes: 1024,
  });
  expect(Object.isFrozen(ENFORCEMENT_RECORD_LIMITS)).toBe(true);
});

test("creating the recorder touches nothing; the first record creates the folder and the file", () => {
  const spy = spyFileSystem();
  const { recorder } = setup({ fileSystem: spy.fileSystem });
  expect(spy.calls).toEqual([]);
  recorder.record(DENIAL);
  expect(spy.named("mkdirSync")).toHaveLength(1);
  expect(spy.named("mkdirSync")[0]?.args[1]).toEqual({
    recursive: true,
    mode: 0o700,
  });
});

// Append only.

test("the file is opened in append mode and each record is written with one write call", () => {
  const spy = spyFileSystem();
  const { recorder, root } = setup({ fileSystem: spy.fileSystem });
  recorder.record(DENIAL);
  recorder.record(START);
  recorder.record(DENIAL);
  // A new file is created exclusively, an existing one opened to append.
  expect(
    spy
      .named("openSync")
      .filter((call) => String(call.args[0]).endsWith(".jsonl"))
      .map((call) => [path.basename(String(call.args[0])), call.args[1]]),
  ).toEqual([["enforcement-00000001.jsonl", "ax"]]);
  expect(spy.named("writeSync")).toHaveLength(3);
  recorder.close();

  const again = spyFileSystem();
  const second = setup({ fileSystem: again.fileSystem, root });
  second.recorder.record(START);
  expect(
    again
      .named("openSync")
      .filter((call) => String(call.args[0]).endsWith(".jsonl"))
      .map((call) => [path.basename(String(call.args[0])), call.args[1]]),
  ).toEqual([["enforcement-00000001.jsonl", "a+"]]);
  expect(again.named("writeSync")).toHaveLength(1);
});

test("a later recorder appends to the same file and leaves the earlier lines unchanged", () => {
  const first = setup();
  first.recorder.record(DENIAL);
  first.recorder.record(START);
  first.recorder.close();
  const before = first.read(1);

  const second = setup({ root: first.root });
  second.recorder.record(MALFORMED_DENIAL);
  second.recorder.record(START);
  const after = second.read(1);
  expect(after.startsWith(before)).toBe(true);
  expect(after.slice(before.length).trimEnd().split("\n")).toHaveLength(2);
  expect(second.files()).toEqual(["enforcement-00000001.jsonl"]);
});

test("a file that does not end with a newline is never appended to; the next file is started", () => {
  const { recorder, folder, read, files } = setup();
  recorder.record(DENIAL);
  recorder.close();
  const torn = `${DENIAL_LINE}\n{"version":1,"ki`;
  writeFileSync(path.join(folder, enforcementRecordFileName(1)), torn);

  const second = setup({ root: path.dirname(folder) });
  second.recorder.record(START);
  expect(read(1)).toBe(torn);
  expect(files()).toEqual([
    "enforcement-00000001.jsonl",
    "enforcement-00000002.jsonl",
  ]);
  expect(second.read(2)).toBe(`${START_LINE}\n`);
});

// Rotation.

const SMALL_LIMITS: EnforcementRecordLimits = Object.freeze({
  // Two denial lines fit, a third does not.
  maxFileBytes: (DENIAL_LINE.length + 1) * 2 + 10,
  maxFiles: 3,
  maxRecordBytes: 1024,
});

test("a full file is closed unchanged, the next numbered file is started, and only the newest files are kept", () => {
  const { recorder, read, files } = setup({ limits: SMALL_LIMITS });
  const closedContent = new Map<number, string>();
  for (let index = 0; index < 11; index += 1) {
    recorder.record(DENIAL);
    for (const name of files()) {
      const sequence = Number(/\d+/u.exec(name)?.[0]);
      const content = read(sequence);
      // A closed file is never changed: once a later file exists, it keeps
      // the content that it had.
      if (closedContent.has(sequence)) {
        expect(content).toBe(closedContent.get(sequence));
      } else if (files().some((other) => other > name)) {
        closedContent.set(sequence, content);
      }
    }
    expect(files().length).toBeLessThanOrEqual(SMALL_LIMITS.maxFiles);
  }
  // 11 records, two per file: files 1 to 6, of which 4 to 6 are kept.
  expect(files()).toEqual([
    "enforcement-00000004.jsonl",
    "enforcement-00000005.jsonl",
    "enforcement-00000006.jsonl",
  ]);
  expect(read(4)).toBe(`${DENIAL_LINE}\n${DENIAL_LINE}\n`);
  expect(read(6)).toBe(`${DENIAL_LINE}\n`);
  expect(closedContent.size).toBeGreaterThanOrEqual(5);
});

test("each file stays within the size bound, and a rotation flushes the full file before closing it", () => {
  const spy = spyFileSystem();
  const { recorder, folder, files } = setup({
    limits: SMALL_LIMITS,
    fileSystem: spy.fileSystem,
  });
  for (let index = 0; index < 5; index += 1) {
    recorder.record(DENIAL);
  }
  for (const name of files()) {
    expect(statSync(path.join(folder, name)).size).toBeLessThanOrEqual(
      SMALL_LIMITS.maxFileBytes,
    );
  }
  // Two rotations, each flushing the full file; denials are not flushed.
  expect(spy.named("fsyncSync").length).toBeGreaterThanOrEqual(2);
  const order = spy.calls.map((call) => call.name);
  const firstClose = order.indexOf("closeSync");
  expect(order.slice(0, firstClose)).toContain("fsyncSync");
});

test("a recorder that starts with a full file starts the next one, and deletes files beyond the bound", () => {
  const first = setup({ limits: SMALL_LIMITS });
  for (let index = 0; index < 2; index += 1) {
    first.recorder.record(DENIAL);
  }
  first.recorder.close();
  // Files from an earlier, larger bound.
  for (const sequence of [7, 8, 9]) {
    writeFileSync(
      path.join(first.folder, enforcementRecordFileName(sequence)),
      "",
    );
  }
  writeFileSync(path.join(first.folder, "unrelated.txt"), "kept");
  const second = setup({ root: first.root, limits: SMALL_LIMITS });
  second.recorder.record(START);
  expect(second.files()).toEqual([
    "enforcement-00000007.jsonl",
    "enforcement-00000008.jsonl",
    "enforcement-00000009.jsonl",
    "unrelated.txt",
  ]);
  expect(second.read(9)).toBe(`${START_LINE}\n`);
});

test("an old file that cannot be deleted does not fail the record; it is reported with fixed text", () => {
  const spy = spyFileSystem({
    unlinkSync: () => {
      throw errno("EBUSY");
    },
  });
  const { recorder, logs, files } = setup({
    limits: SMALL_LIMITS,
    fileSystem: spy.fileSystem,
  });
  for (let index = 0; index < 8; index += 1) {
    expect(recorder.record(DENIAL)).toBeUndefined();
  }
  expect(files()).toHaveLength(4);
  expect(logs).toContain(OLD_FILE_NOT_DELETED_MESSAGE);
});

// Failures.

test("the folder is resolved when a file is opened, not when the recorder is created, and again after a failure", () => {
  const root = dataFolder();
  const folder = path.join(root, ENFORCEMENT_RECORD_FOLDER);
  let resolutions = 0;
  let missing = true;
  const logs: string[] = [];
  const recorder = createFileEnforcementRecorder({
    folder: () => {
      resolutions += 1;
      if (missing) {
        // As `deviceKeyFolder` throws on Windows without LOCALAPPDATA.
        throw new Error(`LOCALAPPDATA is missing for ${root}`);
      }
      return folder;
    },
    platform: process.platform,
    log: (message) => logs.push(message),
  });
  openRecorders.push(recorder);
  expect(resolutions).toBe(0);
  expect(failureOf(() => recorder.record(START))).toBe("folder_unavailable");
  expect(failureOf(() => recorder.record(DENIAL))).toBe("folder_unavailable");
  expect(resolutions).toBe(2);
  missing = false;
  recorder.record(DENIAL);
  recorder.record(START);
  // The open file keeps its folder.
  expect(resolutions).toBe(3);
  expect(
    readFileSync(path.join(folder, enforcementRecordFileName(1)), "utf8"),
  ).toBe(`${DENIAL_LINE}\n${START_LINE}\n`);
  expect(logs).toEqual([
    recordFailureMessage("folder_unavailable"),
    RECORDS_WRITTEN_AGAIN_MESSAGE,
  ]);
  for (const message of logs) {
    expect(message).not.toContain(root);
  }
});

test("a folder that is not an absolute path fails the record with folder_unavailable and touches nothing", () => {
  for (const resolved of ["", "enforcement-records", "./records", 42, null]) {
    const spy = spyFileSystem();
    const recorder = createFileEnforcementRecorder({
      folder: () => resolved as string,
      platform: process.platform,
      log: () => undefined,
      fileSystem: spy.fileSystem,
    });
    expect(failureOf(() => recorder.record(START))).toBe("folder_unavailable");
    expect(spy.calls).toEqual([]);
  }
});

test("a folder that cannot be created fails the record with folder_unavailable", () => {
  const root = dataFolder();
  // A file where the folder's parent should be.
  writeFileSync(path.join(root, "blocked"), "");
  const { recorder } = setup({ root: path.join(root, "blocked") });
  expect(failureOf(() => recorder.record(START))).toBe("folder_unavailable");
  expect(failureOf(() => recorder.record(DENIAL))).toBe("folder_unavailable");
});

test("a folder that cannot be listed fails the record with folder_unavailable", () => {
  const spy = spyFileSystem({
    readdirSync: () => {
      throw errno("EACCES");
    },
  });
  const { recorder } = setup({ fileSystem: spy.fileSystem });
  expect(failureOf(() => recorder.record(START))).toBe("folder_unavailable");
});

test("a file that cannot be opened (permission denied) fails the record with open_failed", () => {
  const spy = spyFileSystem({
    openSync: () => {
      throw errno("EACCES");
    },
  });
  const { recorder } = setup({ fileSystem: spy.fileSystem });
  expect(failureOf(() => recorder.record(START))).toBe("open_failed");
  expect(failureOf(() => recorder.record(DENIAL))).toBe("open_failed");
});

test("a full disk fails the record with write_failed, a denial as well as a shell start", () => {
  const spy = spyFileSystem({
    writeSync: () => {
      throw errno("ENOSPC");
    },
  });
  const { recorder } = setup({ fileSystem: spy.fileSystem });
  expect(failureOf(() => recorder.record(START))).toBe("write_failed");
  expect(failureOf(() => recorder.record(DENIAL))).toBe("write_failed");
});

test("a write cut short fails the record, and the torn file is never appended to again", () => {
  let cut = false;
  const spy = spyFileSystem({
    writeSync: (fd, buffer, offset, length) => {
      if (cut) {
        cut = false;
        return nodeRecorderFileSystem.writeSync(fd, buffer, offset, length - 5);
      }
      return nodeRecorderFileSystem.writeSync(fd, buffer, offset, length);
    },
  });
  const { recorder, read, files } = setup({ fileSystem: spy.fileSystem });
  recorder.record(DENIAL);
  cut = true;
  expect(failureOf(() => recorder.record(START))).toBe("write_failed");
  const torn = read(1);
  expect(torn.endsWith("\n")).toBe(false);
  expect(recorder.record(DENIAL)).toBeUndefined();
  expect(read(1)).toBe(torn);
  expect(files()).toHaveLength(2);
  expect(read(2)).toBe(`${DENIAL_LINE}\n`);
});

test("a shell start that cannot be flushed fails with sync_failed; a denial is not flushed", () => {
  let failSync = false;
  const spy = spyFileSystem({
    fsyncSync: (fd) => {
      if (failSync) {
        throw errno("EIO");
      }
      nodeRecorderFileSystem.fsyncSync(fd);
    },
  });
  const { recorder } = setup({ fileSystem: spy.fileSystem, platform: "win32" });
  recorder.record(DENIAL);
  expect(spy.named("fsyncSync")).toHaveLength(0);
  recorder.record(START);
  // The shell start is flushed once, with every line before it.
  expect(spy.named("fsyncSync")).toHaveLength(1);
  failSync = true;
  expect(failureOf(() => recorder.record(START))).toBe("sync_failed");
});

test("a record too large fails with record_too_large and writes nothing", () => {
  const spy = spyFileSystem();
  const { recorder } = setup({
    fileSystem: spy.fileSystem,
    limits: { ...ENFORCEMENT_RECORD_LIMITS, maxRecordBytes: 100 },
  });
  expect(failureOf(() => recorder.record(START))).toBe("record_too_large");
  expect(spy.calls).toEqual([]);
});

test("a file system that throws anything fails the record with an EnforcementRecordError only", () => {
  for (const name of [
    "mkdirSync",
    "readdirSync",
    "openSync",
    "fstatSync",
    "readSync",
    "writeSync",
    "fsyncSync",
    "fchmodSync",
  ] as const) {
    const root = dataFolder();
    // Write once first, so that the second recorder reopens the file.
    const first = setup({ root });
    first.recorder.record(DENIAL);
    first.recorder.close();
    const spy = spyFileSystem({
      [name]: () => {
        // Not even an Error.
        throw "failed";
      },
    });
    const { recorder } = setup({
      root,
      fileSystem: spy.fileSystem,
      platform: "linux",
    });
    expect(ENFORCEMENT_RECORD_FAILURES).toContain(
      failureOf(() => recorder.record(START)),
    );
  }
});

test("the recorder writes again after a failure, and logs the failure and the recovery once each, with fixed text only", () => {
  let full = true;
  const spy = spyFileSystem({
    writeSync: (fd, buffer, offset, length) => {
      if (full) {
        throw errno("ENOSPC");
      }
      return nodeRecorderFileSystem.writeSync(fd, buffer, offset, length);
    },
  });
  const { recorder, logs, read, folder } = setup({
    fileSystem: spy.fileSystem,
  });
  for (let index = 0; index < 3; index += 1) {
    expect(failureOf(() => recorder.record(START))).toBe("write_failed");
  }
  full = false;
  recorder.record(DENIAL);
  recorder.record(DENIAL);
  expect(read(1)).toBe(`${DENIAL_LINE}\n${DENIAL_LINE}\n`);
  expect(logs).toEqual([
    recordFailureMessage("write_failed"),
    RECORDS_WRITTEN_AGAIN_MESSAGE,
  ]);
  for (const message of logs) {
    for (const id of IDS) {
      expect(message).not.toContain(id);
    }
    expect(message).not.toContain(folder);
    expect(message).not.toContain("secret");
  }
});

test("no log names an ID, a path, or the error of the file system, whatever fails", () => {
  const logs: string[] = [];
  const failures: Partial<RecorderFileSystem>[] = [
    {
      openSync: () => {
        throw errno("EACCES");
      },
    },
    {
      writeSync: () => {
        throw errno("ENOSPC");
      },
    },
    {
      fsyncSync: () => {
        throw errno("EIO");
      },
    },
    {
      readdirSync: () => {
        throw errno("EACCES");
      },
    },
    {
      unlinkSync: () => {
        throw errno("EBUSY");
      },
    },
  ];
  for (const overrides of failures) {
    const spy = spyFileSystem(overrides);
    const run = setup({ fileSystem: spy.fileSystem, limits: SMALL_LIMITS });
    for (const entry of [DENIAL, START, DENIAL, START, DENIAL, START]) {
      try {
        run.recorder.record(entry);
      } catch {
        // Expected for most of them.
      }
    }
    try {
      run.recorder.record({ ...START, extra: RUN_ID } as never);
    } catch {
      // Refused.
    }
    logs.push(...run.logs);
    for (const message of run.logs) {
      expect(message).not.toContain(run.folder);
    }
  }
  expect(logs.length).toBeGreaterThan(0);
  const allowed = new Set([
    ...ENFORCEMENT_RECORD_FAILURES.map(recordFailureMessage),
    RECORDS_WRITTEN_AGAIN_MESSAGE,
    OLD_FILE_NOT_DELETED_MESSAGE,
  ]);
  for (const message of logs) {
    expect(allowed.has(message)).toBe(true);
    for (const id of IDS) {
      expect(message).not.toContain(id);
    }
  }
});

test("a log that throws changes nothing", () => {
  const recorder = createFileEnforcementRecorder({
    folder: () => path.join(dataFolder(), "blocked", "x"),
    platform: process.platform,
    log: () => {
      throw new Error("log failed");
    },
    fileSystem: spyFileSystem({
      mkdirSync: () => {
        throw errno("EACCES");
      },
    }).fileSystem,
  });
  expect(failureOf(() => recorder.record(START))).toBe("folder_unavailable");
});

// Validation.

test("a record with an unexpected field is refused and nothing is written", () => {
  const spy = spyFileSystem();
  const { recorder } = setup({ fileSystem: spy.fileSystem });
  const refused: unknown[] = [
    { ...START, command: "rm -rf /" },
    { ...DENIAL, path: "/home/person/repository" },
    { ...DENIAL, message: "hello" },
  ];
  for (const entry of refused) {
    expect(failureOf(() => recorder.record(entry as EnforcementRecord))).toBe(
      "record_invalid",
    );
  }
  expect(spy.calls).toEqual([]);
});

test("a record outside the record types, IDs, closed vocabularies, and times is refused", () => {
  const spy = spyFileSystem();
  const { recorder } = setup({ fileSystem: spy.fileSystem });
  const withAccessor = Object.defineProperty({ ...START }, "runId", {
    get: () => RUN_ID,
    enumerable: true,
  });
  const inherited = Object.create(START) as unknown;
  const refused: unknown[] = [
    null,
    "denied",
    [START],
    { ...START, kind: "shell_start" },
    { ...START, repositoryId: null },
    { ...START, at: null },
    { ...START, at: "yesterday" },
    { ...START, runId: "../../etc/passwd" },
    { ...DENIAL, reason: "because" },
    { ...DENIAL, capability: "terminal.everything" },
    { ...DENIAL, agentId: "secret-token" },
    { ...DENIAL, at: undefined },
    Object.fromEntries(Object.entries(DENIAL).filter(([key]) => key !== "at")),
    withAccessor,
    inherited,
  ];
  for (const entry of refused) {
    expect(failureOf(() => recorder.record(entry as EnforcementRecord))).toBe(
      "record_invalid",
    );
  }
  expect(spy.calls).toEqual([]);
});

// Permissions.

test.skipIf(process.platform === "win32")(
  "on macOS and Linux the folder is for its owner only and each file is readable and writable by its owner only",
  () => {
    const { recorder, folder, file } = setup();
    recorder.record(START);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(file(1)).mode & 0o777).toBe(0o600);
  },
);

test("on macOS and Linux each opened file is restricted to its owner and a new file's folder entry is flushed; on Windows neither", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const spy = spyFileSystem({
      // Windows cannot open a folder; this test runs everywhere.
      openSync: (file, flags, mode) =>
        flags === "r" ? -1 : nodeRecorderFileSystem.openSync(file, flags, mode),
      fsyncSync: (fd) =>
        fd === -1 ? undefined : nodeRecorderFileSystem.fsyncSync(fd),
      closeSync: (fd) =>
        fd === -1 ? undefined : nodeRecorderFileSystem.closeSync(fd),
      fchmodSync: () => undefined,
    });
    const { recorder, root } = setup({ fileSystem: spy.fileSystem, platform });
    recorder.record(START);
    expect(spy.named("fchmodSync").map((call) => call.args[1])).toEqual([
      0o600,
    ]);
    const opened = spy.named("openSync");
    expect(opened.map((call) => call.args[1])).toEqual(["ax", "r"]);
    expect(opened[0]?.args[2]).toBe(0o600);
    expect(spy.named("fsyncSync").map((call) => call.args[0])).toContain(-1);
    recorder.close();

    // A reopened file is restricted again.
    const again = spyFileSystem({ fchmodSync: () => undefined });
    setup({ fileSystem: again.fileSystem, platform, root }).recorder.record(
      DENIAL,
    );
    expect(again.named("fchmodSync").map((call) => call.args[1])).toEqual([
      0o600,
    ]);
  }

  const windows = spyFileSystem();
  setup({ fileSystem: windows.fileSystem, platform: "win32" }).recorder.record(
    START,
  );
  expect(windows.named("fchmodSync")).toEqual([]);
  expect(
    windows.named("openSync").filter((call) => call.args[1] === "r"),
  ).toEqual([]);
});

test("a file that cannot be restricted to its owner fails the record", () => {
  const spy = spyFileSystem({
    fchmodSync: () => {
      throw errno("EPERM");
    },
    openSync: (file, flags, mode) =>
      flags === "r" ? -1 : nodeRecorderFileSystem.openSync(file, flags, mode),
    fsyncSync: (fd) =>
      fd === -1 ? undefined : nodeRecorderFileSystem.fsyncSync(fd),
    closeSync: (fd) =>
      fd === -1 ? undefined : nodeRecorderFileSystem.closeSync(fd),
  });
  const { recorder } = setup({ fileSystem: spy.fileSystem, platform: "linux" });
  expect(failureOf(() => recorder.record(START))).toBe("open_failed");
});

// Closing.

test("close flushes and closes the file, every later record fails with recorder_closed, and a second close does nothing", () => {
  const spy = spyFileSystem();
  const { recorder, read } = setup({
    fileSystem: spy.fileSystem,
    platform: "win32",
  });
  recorder.record(DENIAL);
  expect(spy.named("closeSync")).toHaveLength(0);
  recorder.close();
  expect(spy.named("fsyncSync")).toHaveLength(1);
  expect(spy.named("closeSync")).toHaveLength(1);
  expect(failureOf(() => recorder.record(START))).toBe("recorder_closed");
  expect(failureOf(() => recorder.record(DENIAL))).toBe("recorder_closed");
  recorder.close();
  expect(spy.named("closeSync")).toHaveLength(1);
  expect(read(1)).toBe(`${DENIAL_LINE}\n`);
});

test("close never throws, also when flushing and closing fail, and closes before any record", () => {
  const spy = spyFileSystem({
    fsyncSync: () => {
      throw errno("EIO");
    },
    closeSync: () => {
      throw errno("EBADF");
    },
  });
  const { recorder } = setup({ fileSystem: spy.fileSystem, platform: "win32" });
  recorder.record(DENIAL);
  expect(() => recorder.close()).not.toThrow();
  const unused = setup();
  expect(() => unused.recorder.close()).not.toThrow();
  expect(failureOf(() => unused.recorder.record(START))).toBe(
    "recorder_closed",
  );
});

// Through the real enforcement point.

const HELD_RUN = Object.freeze({
  runId: RUN_ID,
  agentId: AGENT_ID,
  hostDeviceId: DEVICE_ID,
  repositoryId: REPOSITORY_ID,
  providerConnectionId: null,
}) as HeldRun;

const SHELL_REQUEST = Object.freeze({
  agentId: AGENT_ID,
  capability: "terminal.execute",
  repositoryId: REPOSITORY_ID,
});

const TERMINAL_GRANT = GrantRecordSchema.parse({
  grant: {
    id: GRANT_ID,
    projectId: PROJECT_ID,
    granteeAgentId: AGENT_ID,
    capability: "terminal.execute",
    repositoryId: REPOSITORY_ID,
    grantedByUserId: USER_ID,
    createdAt: "2026-11-25T09:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    revokedAt: null,
    revokedByUserId: null,
  },
  facts: {
    agent: { id: AGENT_ID, hostDeviceId: DEVICE_ID, disabledAt: null },
    hostDevice: { id: DEVICE_ID, revokedAt: null },
    project: { id: PROJECT_ID, workspaceId: WORKSPACE_ID },
    grantorMembership: {
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      removedAt: null,
    },
    providerConnection: null,
  },
});

function enforcementWith(recorder: FileEnforcementRecorder) {
  return createPermissionEnforcement({
    now: () => new Date(AT),
    grantStore: { read: () => ({ usable: true, records: [TERMINAL_GRANT] }) },
    sessionState: () =>
      Object.freeze({
        kind: "signed_in",
        account: Object.freeze({
          deviceId: DEVICE_ID,
          userId: USER_ID,
          login: "octocat",
          displayName: "The Octocat",
          signInExpiresAt: "2026-12-25T10:00:00.000Z",
        }),
      }) as never,
    thisDevice: () => DEVICE_ID as never,
    recorder,
  });
}

test("through the enforcement point: a recorded shell start is allowed, and its record is on disk", () => {
  const { recorder, read } = setup();
  const decision = enforcementWith(recorder).check(HELD_RUN, SHELL_REQUEST);
  expect(decision.allowed).toBe(true);
  expect(read(1)).toBe(`${START_LINE}\n`);
});

test("through the enforcement point: every failure of the recorder denies the shell start with record_failed", () => {
  const failing: [string, Partial<RecorderFileSystem>][] = [
    [
      "full disk",
      {
        writeSync: () => {
          throw errno("ENOSPC");
        },
      },
    ],
    [
      "permission denied",
      {
        openSync: () => {
          throw errno("EACCES");
        },
      },
    ],
    [
      "no folder",
      {
        mkdirSync: () => {
          throw errno("ENOENT");
        },
      },
    ],
    [
      "no flush",
      {
        fsyncSync: () => {
          throw errno("EIO");
        },
      },
    ],
    ["cut short", { writeSync: () => 3 }],
  ];
  for (const [, overrides] of failing) {
    const spy = spyFileSystem(overrides);
    const { recorder } = setup({
      fileSystem: spy.fileSystem,
      platform: "win32",
    });
    expect(enforcementWith(recorder).check(HELD_RUN, SHELL_REQUEST)).toEqual({
      allowed: false,
      reason: "record_failed",
    });
  }
  // A too-small record bound, and a closed recorder.
  const tooLarge = setup({
    limits: { ...ENFORCEMENT_RECORD_LIMITS, maxRecordBytes: 50 },
  });
  expect(
    enforcementWith(tooLarge.recorder).check(HELD_RUN, SHELL_REQUEST),
  ).toEqual({ allowed: false, reason: "record_failed" });
  const closed = setup();
  closed.recorder.close();
  expect(
    enforcementWith(closed.recorder).check(HELD_RUN, SHELL_REQUEST),
  ).toEqual({ allowed: false, reason: "record_failed" });
});

test("through the enforcement point: a start written but not flushed leaves the start followed by the record_failed denial", () => {
  let failSync = true;
  const spy = spyFileSystem({
    fsyncSync: (fd) => {
      if (failSync) {
        failSync = false;
        throw errno("EIO");
      }
      nodeRecorderFileSystem.fsyncSync(fd);
    },
  });
  const { recorder, read } = setup({
    fileSystem: spy.fileSystem,
    platform: "win32",
  });
  expect(enforcementWith(recorder).check(HELD_RUN, SHELL_REQUEST)).toEqual({
    allowed: false,
    reason: "record_failed",
  });
  expect(read(1)).toBe(
    `${START_LINE}\n` +
      '{"version":1,"kind":"denied","reason":"record_failed",' +
      `"capability":"terminal.execute","runId":"${RUN_ID}","agentId":"${AGENT_ID}",` +
      `"repositoryId":"${REPOSITORY_ID}","providerConnectionId":null,"at":"${AT}"}\n`,
  );
});
