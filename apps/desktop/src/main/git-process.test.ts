import path from "node:path";
import { expect, test } from "vitest";
import {
  absolutePathEntries,
  BLOCKED_PROTOCOLS,
  buildGitEnvironment,
  createGitRunner,
  findGitExecutable,
  FIXED_GIT_VARIABLES,
  GIT_GLOBAL_ARGS,
  isSupportedGitVersion,
  parseGitVersion,
  readVariable,
  type ExecFileError,
  type ExecFileFunction,
  type GitExecOptions,
} from "./git-process.ts";

const LIMITS = { timeoutMs: 1234, maxBytes: 5678 };

test("the environment keeps only the variables Git needs and sets the fixed ones", () => {
  const environment = buildGitEnvironment(
    {
      PATH: ".:/usr/bin::bin:./node_modules/.bin:/bin",
      HOME: "/home/user",
      XDG_CONFIG_HOME: "/home/user/.config",
      GIT_DIR: "/elsewhere/.git",
      GIT_WORK_TREE: "/elsewhere",
      GIT_INDEX_FILE: "/tmp/index",
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=evil'",
      GIT_CONFIG_COUNT: "1",
      GIT_EXTERNAL_DIFF: "evil",
      GIT_OPTIONAL_LOCKS: "1",
      LC_ALL: "de_DE.UTF-8",
      NODE_OPTIONS: "--require evil.js",
      ELECTRON_RUN_AS_NODE: "1",
      API_TOKEN: "secret",
      TMPDIR: "",
    },
    "linux",
  );

  expect(environment).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    XDG_CONFIG_HOME: "/home/user/.config",
    ...FIXED_GIT_VARIABLES,
  });
  expect(environment["GIT_OPTIONAL_LOCKS"]).toBe("0");
  expect(environment["GIT_NO_LAZY_FETCH"]).toBe("1");
  expect(environment["GIT_TERMINAL_PROMPT"]).toBe("0");
  // An empty list allows no transport, on every Git version.
  expect(environment["GIT_ALLOW_PROTOCOL"]).toBe("");
  expect(Object.isFrozen(environment)).toBe(true);
});

test("on Windows, variable names are matched without regard to case", () => {
  const source = {
    Path: '.;C:\\Program Files\\Git\\cmd;;tools;C:relative;"C:\\Quoted Folder";C:\\Windows',
    SystemRoot: "C:\\Windows",
    USERPROFILE: "C:\\Users\\user",
    ProgramData: "C:\\ProgramData",
    git_dir: "C:\\elsewhere",
  };

  expect(readVariable(source, "PATH", "win32")).toBe(source.Path);
  expect(readVariable(source, "PATH", "linux")).toBeUndefined();
  expect(buildGitEnvironment(source, "win32")).toEqual({
    PATH: 'C:\\Program Files\\Git\\cmd;"C:\\Quoted Folder";C:\\Windows',
    SYSTEMROOT: "C:\\Windows",
    USERPROFILE: "C:\\Users\\user",
    PROGRAMDATA: "C:\\ProgramData",
    ...FIXED_GIT_VARIABLES,
  });
});

test("Git is found in an absolute PATH folder, never in an empty or relative one", async () => {
  const checked: string[] = [];
  const found = await findGitExecutable(
    { PATH: ":.:bin:/usr/local/bin:/usr/bin" },
    "darwin",
    path.posix,
    async (file) => {
      checked.push(file);
      return file === "/usr/bin/git";
    },
  );

  expect(found).toBe("/usr/bin/git");
  expect(checked).toEqual(["/usr/local/bin/git", "/usr/bin/git"]);
});

test("on Windows, Git is git.exe in an absolute PATH folder, also a quoted one", async () => {
  const checked: string[] = [];
  const found = await findGitExecutable(
    {
      Path: '.;C:relative;"C:\\Program Files\\Git\\cmd";C:\\Windows',
    },
    "win32",
    path.win32,
    async (file) => {
      checked.push(file);
      return file === "C:\\Program Files\\Git\\cmd\\git.exe";
    },
  );

  expect(found).toBe("C:\\Program Files\\Git\\cmd\\git.exe");
  expect(checked).toEqual(["C:\\Program Files\\Git\\cmd\\git.exe"]);
});

test("without Git on the PATH, nothing is found", async () => {
  expect(
    await findGitExecutable(
      { PATH: "/usr/bin" },
      "linux",
      path.posix,
      async () => false,
    ),
  ).toBeUndefined();
  expect(
    await findGitExecutable({}, "linux", path.posix, async () => true),
  ).toBeUndefined();
});

test("only absolute PATH folders are passed on", () => {
  expect(absolutePathEntries("/a::b:./c:/d", "linux")).toEqual(["/a", "/d"]);
  expect(absolutePathEntries("", "darwin")).toEqual([]);
  expect(
    absolutePathEntries("C:\\a;.;\\\\server\\share;d;C:e", "win32"),
  ).toEqual(["C:\\a", "\\\\server\\share"]);
  const environment = buildGitEnvironment({ PATH: ".:bin" }, "linux");
  expect(environment["PATH"]).toBeUndefined();
});

test("the version of Git is read from git version, also from vendor builds", () => {
  expect(parseGitVersion("git version 2.55.0\n")).toEqual([2, 55]);
  expect(parseGitVersion("git version 2.45.1.windows.1\n")).toEqual([2, 45]);
  expect(parseGitVersion("git version 2.39.5 (Apple Git-154)\n")).toEqual([
    2, 39,
  ]);
  expect(parseGitVersion("hub version 2.14.2")).toBeUndefined();
  expect(parseGitVersion("")).toBeUndefined();
  expect(isSupportedGitVersion([2, 15])).toBe(true);
  expect(isSupportedGitVersion([2, 55])).toBe(true);
  expect(isSupportedGitVersion([3, 0])).toBe(true);
  expect(isSupportedGitVersion([2, 14])).toBe(false);
  expect(isSupportedGitVersion([1, 99])).toBe(false);
  expect(isSupportedGitVersion(undefined)).toBe(false);
});

test("every command turns off the file system monitors and every transport by name", () => {
  const settings = GIT_GLOBAL_ARGS.filter(
    (arg, index) => GIT_GLOBAL_ARGS[index - 1] === "-c",
  );

  expect(GIT_GLOBAL_ARGS[0]).toBe("--no-pager");
  expect(GIT_GLOBAL_ARGS.length).toBe(1 + settings.length * 2);
  expect(settings).toEqual([
    "core.fsmonitor=",
    "core.useBuiltinFSMonitor=false",
    "protocol.allow=never",
    // A repository's protocol.<name>.allow=always would beat protocol.allow.
    ...["ssh", "git", "file", "http", "https", "ext"].map(
      (name) => `protocol.${name}.allow=never`,
    ),
  ]);
  expect(BLOCKED_PROTOCOLS).toEqual([
    "ssh",
    "git",
    "file",
    "http",
    "https",
    "ext",
  ]);
  expect(Object.isFrozen(GIT_GLOBAL_ARGS)).toBe(true);
});

interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: GitExecOptions;
}

const isVersionCall = (args: readonly string[]) => args.at(-1) === "version";

/**
 * An execFile that records its calls, answers `git version` with `version`,
 * and every other command with `answer`.
 */
function fakeExecFile(
  answer: (
    call: ExecCall,
  ) => [ExecFileError | null, Buffer | string, Buffer | string],
  version: () => string = () => "git version 2.55.0\n",
) {
  const calls: ExecCall[] = [];
  const execFile: ExecFileFunction = (file, args, options, callback) => {
    const call = { file, args, options };
    calls.push(call);
    const [error, stdout, stderr] = isVersionCall(args)
      ? [null, Buffer.from(version()), Buffer.alloc(0)]
      : answer(call);
    queueMicrotask(() => callback(error, stdout, stderr));
  };
  return {
    execFile,
    calls,
    commands: () => calls.filter(({ args }) => !isVersionCall(args)),
    versionChecks: () => calls.filter(({ args }) => isVersionCall(args)).length,
  };
}

function execError(fields: Partial<ExecFileError>): ExecFileError {
  return Object.assign(new Error("failed"), fields);
}

const ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin",
  GIT_OPTIONAL_LOCKS: "0",
});

test("the runner runs Git by its absolute path, without a shell, with the fixed options", async () => {
  const fake = fakeExecFile(() => [
    null,
    Buffer.from(`ok caf${String.fromCodePoint(0xe9)}\n`, "utf8"),
    Buffer.alloc(0),
  ]);
  const runner = createGitRunner({
    execFile: fake.execFile,
    environment: ENVIRONMENT,
    locateGit: async () => "/usr/bin/git",
  });
  const controller = new AbortController();

  const outcome = await runner.run(
    "/home/user/project",
    ["status", "--porcelain=v2"],
    LIMITS,
    controller.signal,
  );

  expect(outcome).toEqual({
    ok: true,
    stdout: `ok caf${String.fromCodePoint(0xe9)}\n`,
  });
  expect(fake.calls).toHaveLength(2);
  const [versionCall, call] = fake.calls;
  expect(versionCall?.file).toBe("/usr/bin/git");
  expect(versionCall?.args).toEqual([...GIT_GLOBAL_ARGS, "version"]);
  expect(versionCall?.options).toMatchObject({
    cwd: "/home/user/project",
    shell: false,
    env: ENVIRONMENT,
  });
  expect(call?.file).toBe("/usr/bin/git");
  expect(call?.args).toEqual([
    "--no-pager",
    "-c",
    "core.fsmonitor=",
    "-c",
    "core.useBuiltinFSMonitor=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.ssh.allow=never",
    "-c",
    "protocol.git.allow=never",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.http.allow=never",
    "-c",
    "protocol.https.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "status",
    "--porcelain=v2",
  ]);
  expect(call?.args.slice(0, GIT_GLOBAL_ARGS.length)).toEqual([
    ...GIT_GLOBAL_ARGS,
  ]);
  expect(call?.options).toEqual({
    cwd: "/home/user/project",
    env: ENVIRONMENT,
    encoding: "buffer",
    shell: false,
    windowsHide: true,
    timeout: 1234,
    maxBuffer: 5678,
    killSignal: "SIGKILL",
    signal: controller.signal,
  });
});

test("the runner reports a missing Git without starting a process, and looks again next time", async () => {
  const fake = fakeExecFile(() => [null, "", ""]);
  let lookups = 0;
  let installed = false;
  const runner = createGitRunner({
    execFile: fake.execFile,
    environment: ENVIRONMENT,
    locateGit: async () => {
      lookups += 1;
      return installed ? "/usr/bin/git" : undefined;
    },
  });

  expect(await runner.run("/repo", ["status"], LIMITS)).toEqual({
    ok: false,
    failure: "git-missing",
    exitCode: null,
    stderr: "",
  });
  expect(fake.calls).toEqual([]);
  installed = true;
  expect((await runner.run("/repo", ["status"], LIMITS)).ok).toBe(true);
  expect((await runner.run("/repo", ["status"], LIMITS)).ok).toBe(true);
  expect(lookups).toBe(2);
  // The version is checked once for the Git that was found.
  expect(fake.versionChecks()).toBe(1);
});

test("a Git older than 2.15, or of unknown version, runs no command, and is checked again next time", async () => {
  let version = "git version 2.14.6\n";
  const fake = fakeExecFile(
    () => [null, "", ""],
    () => version,
  );
  const runner = createGitRunner({
    execFile: fake.execFile,
    environment: ENVIRONMENT,
    locateGit: async () => "/usr/bin/git",
  });

  expect(await runner.run("/repo", ["status"], LIMITS)).toEqual({
    ok: false,
    failure: "git-unsupported",
    exitCode: null,
    stderr: "",
  });
  version = "not git\n";
  expect(await runner.run("/repo", ["status"], LIMITS)).toMatchObject({
    ok: false,
    failure: "git-unsupported",
  });
  expect(fake.commands()).toEqual([]);

  version = "git version 2.15.0\n";
  expect((await runner.run("/repo", ["status"], LIMITS)).ok).toBe(true);
  expect(fake.commands()).toHaveLength(1);
  expect(fake.versionChecks()).toBe(3);
});

test("the runner classifies exit codes, timeouts, the output limit, aborts, and spawn errors", async () => {
  const cases: [ExecFileError, string, number | null][] = [
    [execError({ code: 128 }), "exit", 128],
    [execError({ code: 1 }), "exit", 1],
    [
      execError({ code: null, killed: true, signal: "SIGKILL" }),
      "timeout",
      null,
    ],
    [
      execError({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }),
      "too-large",
      null,
    ],
    [
      Object.assign(new Error("aborted"), {
        name: "AbortError",
        code: "ABORT_ERR",
      }),
      "aborted",
      null,
    ],
    [execError({ code: "ENOENT" }), "git-missing", null],
    [execError({ code: "EACCES" }), "spawn", null],
  ];
  for (const [error, failure, exitCode] of cases) {
    const fake = fakeExecFile(() => [
      error,
      Buffer.alloc(0),
      Buffer.from("fatal: not a git repository", "utf8"),
    ]);
    const runner = createGitRunner({
      execFile: fake.execFile,
      environment: ENVIRONMENT,
      locateGit: async () => "/usr/bin/git",
    });

    expect(await runner.run("/repo", ["rev-parse"], LIMITS)).toEqual({
      ok: false,
      failure,
      exitCode,
      stderr: "fatal: not a git repository",
    });
  }
});

test("an aborted signal starts no process, and a throwing execFile is a spawn failure", async () => {
  const fake = fakeExecFile(() => [null, "", ""]);
  const runner = createGitRunner({
    execFile: fake.execFile,
    environment: ENVIRONMENT,
    locateGit: async () => "/usr/bin/git",
  });
  const controller = new AbortController();
  controller.abort();

  expect(
    (await runner.run("/repo", ["status"], LIMITS, controller.signal)).ok,
  ).toBe(false);
  expect(fake.calls).toEqual([]);

  const throwing = createGitRunner({
    execFile: () => {
      throw new TypeError("invalid");
    },
    environment: ENVIRONMENT,
    locateGit: async () => "/usr/bin/git",
  });
  expect(await throwing.run("/repo", ["status"], LIMITS)).toMatchObject({
    ok: false,
    failure: "spawn",
  });
});
