// Runs the system `git` for repository inspection (ADR 0016): through
// `execFile`, never a shell, with a fixed executable path, a minimal
// environment, a timeout, and an output limit. Only read-only commands are
// run; git-inspector.ts chooses them.
import path, { type PlatformPath } from "node:path";

/**
 * Variables that Git may need from the application's environment: where Git
 * and its helpers are, and where the user's and the system's Git
 * configuration is. Every other variable is left out, including every `GIT_`
 * variable, so `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_CONFIG_PARAMETERS`, or
 * `GIT_EXTERNAL_DIFF` from the environment cannot redirect or extend a
 * command.
 */
const PASSED_VARIABLES: Readonly<Record<"posix" | "win32", readonly string[]>> =
  Object.freeze({
    posix: ["PATH", "HOME", "XDG_CONFIG_HOME", "TMPDIR"],
    win32: [
      "PATH",
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "XDG_CONFIG_HOME",
      // Git for Windows reads a configuration file in %PROGRAMDATA%\Git.
      "PROGRAMDATA",
      "SYSTEMROOT",
      "WINDIR",
      "TEMP",
      "TMP",
    ],
  });

/** Variables that every Git command gets, whatever the environment says. */
export const FIXED_GIT_VARIABLES = Object.freeze({
  // `git status` neither refreshes nor writes the index.
  GIT_OPTIONAL_LOCKS: "0",
  // A partial clone never fetches a missing object over the network
  // (Git 2.44 and later).
  GIT_NO_LAZY_FETCH: "1",
  // No transport is allowed, on every Git version: an empty list allows no
  // protocol, so a lazy fetch of an older Git fails before it runs
  // `core.sshCommand` or a remote helper, and writes no object.
  GIT_ALLOW_PROTOCOL: "",
  // Git never asks for credentials.
  GIT_TERMINAL_PROMPT: "0",
  // No pager; stdout is a pipe anyway.
  GIT_PAGER: "cat",
  PAGER: "cat",
  // English messages, so a refusal can be recognized.
  LC_ALL: "C",
});

/**
 * The transports that `protocol.<name>.allow=never` turns off one by one. A
 * repository's own `protocol.<name>.allow=always` would beat the general
 * `protocol.allow=never`, but not a command-line setting for the same name.
 */
export const BLOCKED_PROTOCOLS = Object.freeze([
  "ssh",
  "git",
  "file",
  "http",
  "https",
  "ext",
]);

/**
 * Options in front of every command. Command-line settings take precedence
 * over every configuration file, also one that a repository includes.
 * `core.fsmonitor` names a program that `git status` would run (or starts a
 * daemon), and a repository's own configuration can set it: an empty value
 * turns it off on every Git version, where Git before 2.36 would take
 * "false" for the name of a program. Git for Windows 2.33 to 2.35 started
 * its file system monitor with `core.useBuiltinFSMonitor` instead. The
 * protocol settings repeat `GIT_ALLOW_PROTOCOL` as configuration, which Git
 * passes on to the Git processes it starts, so no transport is allowed even
 * where the environment variable did not arrive.
 */
export const GIT_GLOBAL_ARGS = Object.freeze([
  "--no-pager",
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.useBuiltinFSMonitor=false",
  "-c",
  "protocol.allow=never",
  ...BLOCKED_PROTOCOLS.flatMap((name) => [
    "-c",
    `protocol.${name}.allow=never`,
  ]),
]);

/**
 * The oldest Git that the inspection runs: `GIT_OPTIONAL_LOCKS`, which keeps
 * `git status` from writing the index, exists since Git 2.15.
 */
export const MIN_GIT_VERSION = Object.freeze([2, 15] as const);

function variableNames(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? PASSED_VARIABLES.win32 : PASSED_VARIABLES.posix;
}

/**
 * The value of `name` in `source`. Windows treats variable names without
 * regard to case, so `Path` there is `PATH`.
 */
export function readVariable(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") {
    return source[name];
  }
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(source)) {
    if (key.toUpperCase() === upper && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function pathApiOf(platform: NodeJS.Platform): PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Strips the quotes that Windows allows around a `PATH` entry. */
function unquote(entry: string, platform: NodeJS.Platform): string {
  return platform === "win32" && /^".*"$/.test(entry)
    ? entry.slice(1, -1)
    : entry;
}

/**
 * The entries of a `PATH` value that are absolute folders. Empty and
 * relative entries name the current folder, which for Git is the repository.
 */
export function absolutePathEntries(
  value: string,
  platform: NodeJS.Platform,
): string[] {
  const pathApi = pathApiOf(platform);
  return value.split(pathApi.delimiter).filter((entry) => {
    const folder = unquote(entry, platform);
    return folder !== "" && pathApi.isAbsolute(folder);
  });
}

/**
 * The environment of every Git command: the passed variables, with only the
 * absolute folders of `PATH`, and the fixed ones.
 */
export function buildGitEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const name of variableNames(platform)) {
    let value = readVariable(source, name, platform);
    if (name === "PATH" && value !== undefined) {
      value = absolutePathEntries(value, platform).join(
        pathApiOf(platform).delimiter,
      );
    }
    if (value !== undefined && value !== "") {
      environment[name] = value;
    }
  }
  return Object.freeze({ ...environment, ...FIXED_GIT_VARIABLES });
}

/**
 * The major and minor version in the output of `git version`, for example
 * "git version 2.45.1.windows.1" or "git version 2.39.5 (Apple Git-154)".
 */
export function parseGitVersion(
  output: string,
): readonly [number, number] | undefined {
  const match = /^git version (\d+)\.(\d+)/.exec(output.trim());
  if (match === null) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2])];
}

export function isSupportedGitVersion(
  version: readonly [number, number] | undefined,
): boolean {
  if (version === undefined) {
    return false;
  }
  const [major, minor] = version;
  const [minMajor, minMinor] = MIN_GIT_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * The absolute path of the Git executable: the first `git` (`git.exe` on
 * Windows) in an absolute folder of `PATH`. Empty and relative entries are
 * skipped, because they name the current folder. On Windows, a program name
 * without a folder is also looked up in the child's working folder first,
 * which here would be the repository, so Git is always started by its
 * absolute path. A `git.cmd` is never used: a batch file needs a shell.
 */
export async function findGitExecutable(
  source: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  pathApi: PlatformPath,
  isExecutableFile: (file: string) => Promise<boolean>,
): Promise<string | undefined> {
  const searchPath = readVariable(source, "PATH", platform) ?? "";
  const name = platform === "win32" ? "git.exe" : "git";
  for (const entry of searchPath.split(pathApi.delimiter)) {
    const folder = unquote(entry, platform);
    if (folder === "" || !pathApi.isAbsolute(folder)) {
      continue;
    }
    const candidate = pathApi.join(folder, name);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** The options every Git command runs with. */
export interface GitExecOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly encoding: "buffer";
  readonly shell: false;
  readonly windowsHide: true;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly killSignal: "SIGKILL";
  readonly signal?: AbortSignal | undefined;
}

/** The error that Node.js's `execFile` passes to its callback. */
export interface ExecFileError extends Error {
  readonly code?: string | number | null | undefined;
  readonly killed?: boolean | undefined;
  readonly signal?: string | null | undefined;
}

/** The part of Node.js's `execFile` that the runner uses. */
export type ExecFileFunction = (
  file: string,
  args: readonly string[],
  options: GitExecOptions,
  callback: (
    error: ExecFileError | null,
    stdout: Buffer | string,
    stderr: Buffer | string,
  ) => void,
) => unknown;

export interface GitLimits {
  /** Milliseconds until the process is killed. */
  readonly timeoutMs: number;
  /** The most bytes of stdout or stderr; more kills the process. */
  readonly maxBytes: number;
}

export type GitFailure =
  /** No Git executable was found. */
  | "git-missing"
  /** Git is older than `MIN_GIT_VERSION`, or its version is unknown. */
  | "git-unsupported"
  /** The process ran longer than the timeout and was killed. */
  | "timeout"
  /** The output was larger than the limit and the process was killed. */
  | "too-large"
  /** The command was cancelled, for example because the repository was unmounted. */
  | "aborted"
  /** Git exited with a code other than 0. */
  | "exit"
  /** The process could not be started. */
  | "spawn";

export type GitOutcome =
  | { readonly ok: true; readonly stdout: string }
  | {
      readonly ok: false;
      readonly failure: GitFailure;
      readonly exitCode: number | null;
      /** Read by the inspector to recognize a refusal; never sent to the renderer. */
      readonly stderr: string;
    };

export type GitFailureOutcome = Extract<GitOutcome, { ok: false }>;

export interface GitRunner {
  /** Runs `git` with `args` in the folder `cwd`. Never rejects. */
  run(
    cwd: string,
    args: readonly string[],
    limits: GitLimits,
    signal?: AbortSignal,
  ): Promise<GitOutcome>;
}

export interface GitRunnerOptions {
  readonly execFile: ExecFileFunction;
  /** The environment from `buildGitEnvironment`. */
  readonly environment: Readonly<Record<string, string>>;
  /** The absolute path of Git, or undefined when there is none. */
  readonly locateGit: () => Promise<string | undefined>;
}

const decoder = new TextDecoder("utf-8");

function decode(output: Buffer | string): string {
  return typeof output === "string" ? output : decoder.decode(output);
}

function classify(error: ExecFileError): GitFailure {
  if (error.name === "AbortError" || error.code === "ABORT_ERR") {
    return "aborted";
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "too-large";
  }
  if (error.killed === true) {
    return "timeout";
  }
  if (error.code === "ENOENT") {
    return "git-missing";
  }
  return typeof error.code === "number" ? "exit" : "spawn";
}

/** The limits of `git version`. */
const VERSION_LIMITS: GitLimits = Object.freeze({
  timeoutMs: 10_000,
  maxBytes: 64 * 1024,
});

type LocatedGit =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly outcome: GitFailureOutcome };

/**
 * Runs Git commands. Every command gets `GIT_GLOBAL_ARGS` first, runs
 * without a shell and without a console window, and is killed after its
 * timeout or when its output exceeds the limit. Output is decoded as UTF-8.
 * Before the first command, `git version` must report `MIN_GIT_VERSION` or
 * later; `git version` reads no repository.
 */
export function createGitRunner(options: GitRunnerOptions): GitRunner {
  let located: Promise<LocatedGit> | undefined;

  const locate = (cwd: string, signal?: AbortSignal): Promise<LocatedGit> => {
    // A missing or too old Git is checked again on the next command, so
    // installing or updating Git needs no restart.
    located ??= (async (): Promise<LocatedGit> => {
      const git = await options.locateGit();
      if (git === undefined) {
        return { ok: false, outcome: failed("git-missing") };
      }
      const version = await exec(git, cwd, ["version"], VERSION_LIMITS, signal);
      if (!version.ok) {
        return { ok: false, outcome: version };
      }
      return isSupportedGitVersion(parseGitVersion(version.stdout))
        ? { ok: true, path: git }
        : { ok: false, outcome: failed("git-unsupported") };
    })().then((result) => {
      if (!result.ok) {
        located = undefined;
      }
      return result;
    });
    return located;
  };

  const run: GitRunner["run"] = async (cwd, args, limits, signal) => {
    if (signal?.aborted === true) {
      return failed("aborted");
    }
    const git = await locate(cwd, signal);
    if (!git.ok) {
      return git.outcome;
    }
    return exec(git.path, cwd, args, limits, signal);
  };

  const exec = (
    git: string,
    cwd: string,
    args: readonly string[],
    limits: GitLimits,
    signal: AbortSignal | undefined,
  ): Promise<GitOutcome> => {
    if (signal?.aborted === true) {
      return Promise.resolve(failed("aborted"));
    }
    return new Promise<GitOutcome>((resolve) => {
      try {
        options.execFile(
          git,
          [...GIT_GLOBAL_ARGS, ...args],
          {
            cwd,
            env: options.environment,
            encoding: "buffer",
            shell: false,
            windowsHide: true,
            timeout: limits.timeoutMs,
            maxBuffer: limits.maxBytes,
            killSignal: "SIGKILL",
            signal,
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({ ok: true, stdout: decode(stdout) });
              return;
            }
            const failure = classify(error);
            resolve({
              ok: false,
              failure,
              exitCode:
                failure === "exit" && typeof error.code === "number"
                  ? error.code
                  : null,
              stderr: decode(stderr),
            });
          },
        );
      } catch {
        // execFile throws synchronously for invalid arguments.
        resolve(failed("spawn"));
      }
    });
  };

  return Object.freeze({ run });
}

function failed(failure: GitFailure): GitFailureOutcome {
  return { ok: false, failure, exitCode: null, stderr: "" };
}
