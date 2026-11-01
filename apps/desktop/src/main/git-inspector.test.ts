import path from "node:path";
import { expect, test } from "vitest";
import { REPOSITORY_LIMITS } from "../shared/ipc-contract.ts";
import {
  createGitInspector,
  displayText,
  FILTER_DRIVER_ARGS,
  GIT_LIMITS,
  REMOTE_ARGS,
  STATUS_ARGS,
  type RepositoryLocation,
} from "./git-inspector.ts";
import {
  createGitRunner,
  GIT_GLOBAL_ARGS,
  type ExecFileError,
  type GitLimits,
  type GitOutcome,
  type GitRunner,
} from "./git-process.ts";

const OID = "4398e47c585d12a2fa2d3d9f819a353092e8374c";

interface RunCall {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly limits: GitLimits;
}

const ok = (stdout: string): GitOutcome => ({ ok: true, stdout });
const exit = (exitCode: number, stderr = ""): GitOutcome => ({
  ok: false,
  failure: "exit",
  exitCode,
  stderr,
});
const failure = (
  kind:
    | "git-missing"
    | "git-unsupported"
    | "timeout"
    | "too-large"
    | "aborted"
    | "spawn",
): GitOutcome => ({ ok: false, failure: kind, exitCode: null, stderr: "" });

/** A runner that answers by the Git subcommand after the -c options. */
function fakeRunner(answers: Record<string, GitOutcome | GitOutcome[]>) {
  const calls: RunCall[] = [];
  const runner: GitRunner = {
    run: async (cwd, args, limits) => {
      calls.push({ cwd, args, limits });
      const subcommand = args.filter(
        (arg, index) => arg !== "-c" && args[index - 1] !== "-c",
      )[0];
      const answer = answers[subcommand ?? ""];
      if (Array.isArray(answer)) {
        const next = answer.shift();
        if (next === undefined) {
          throw new Error(`no more answers for ${subcommand}`);
        }
        return next;
      }
      if (answer === undefined) {
        throw new Error(`unexpected command ${args.join(" ")}`);
      }
      return answer;
    },
  };
  return { runner, calls };
}

function inspectorWith(
  runner: GitRunner,
  options: { pathApi?: typeof path.posix; isDirectory?: boolean } = {},
) {
  return createGitInspector(runner, {
    pathApi: options.pathApi ?? path.posix,
    isDirectory: async () => options.isDirectory ?? true,
  });
}

const LOCATION: RepositoryLocation = {
  topLevel: "/home/user/project",
  gitDir: "/home/user/project/.git",
  commonDir: "/home/user/project/.git",
};

test("the top-level folder of a working tree is located, with its Git directories resolved", async () => {
  const { runner, calls } = fakeRunner({
    "rev-parse": [ok("true\n"), ok("\n/home/user/project\n.git\n.git\n")],
  });

  expect(await inspectorWith(runner).locate("/home/user/project")).toEqual({
    kind: "repository",
    location: LOCATION,
  });
  expect(calls.map(({ cwd, args }) => [cwd, args])).toEqual([
    ["/home/user/project", ["rev-parse", "--is-inside-work-tree"]],
    [
      "/home/user/project",
      [
        "rev-parse",
        "--show-prefix",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
    ],
  ]);
  expect(calls.every(({ limits }) => limits === GIT_LIMITS.query)).toBe(true);
});

test("a linked worktree's Git directories outside the folder are resolved", async () => {
  const { runner } = fakeRunner({
    "rev-parse": [
      ok("true\n"),
      ok(
        "\n/home/user/feature\n/home/user/project/.git/worktrees/feature\n/home/user/project/.git\n",
      ),
    ],
  });

  expect(await inspectorWith(runner).locate("/home/user/feature")).toEqual({
    kind: "repository",
    location: {
      topLevel: "/home/user/feature",
      gitDir: "/home/user/project/.git/worktrees/feature",
      commonDir: "/home/user/project/.git",
    },
  });
});

test("on Windows, Git's forward slashes become Windows paths", async () => {
  const { runner } = fakeRunner({
    "rev-parse": [
      ok("true\n"),
      ok("\nC:/Users/user/My Project\n.git\nC:/Users/user/My Project/.git\n"),
    ],
  });

  expect(
    await inspectorWith(runner, { pathApi: path.win32 }).locate(
      "C:\\Users\\user\\My Project",
    ),
  ).toEqual({
    kind: "repository",
    location: {
      topLevel: "C:\\Users\\user\\My Project",
      gitDir: "C:\\Users\\user\\My Project\\.git",
      commonDir: "C:\\Users\\user\\My Project\\.git",
    },
  });
});

test("a folder inside a working tree is refused, not widened to the top level", async () => {
  const { runner } = fakeRunner({
    "rev-parse": [
      ok("true\n"),
      ok("src/\n/home/user/project\n/home/user/project/.git\n../.git\n"),
    ],
  });

  expect(await inspectorWith(runner).locate("/home/user/project/src")).toEqual({
    kind: "refused",
    reason: "not-top-level",
  });
});

test("a folder that is not a repository, a Git directory, a bare repository, and an untrusted one are refused", async () => {
  const cases: [GitOutcome[], string][] = [
    [
      [
        exit(
          128,
          "fatal: not a git repository (or any of the parent directories): .git",
        ),
      ],
      "not-a-repository",
    ],
    [[ok("false\n")], "no-work-tree"],
    [
      [
        exit(
          128,
          "fatal: detected dubious ownership in repository at '/srv/shared'",
        ),
      ],
      "untrusted",
    ],
    [[failure("git-missing")], "git-missing"],
    [[failure("timeout")], "failed"],
    [[ok("true\n"), failure("timeout")], "failed"],
    [[ok("true\n"), failure("git-missing")], "git-missing"],
    [[failure("git-unsupported")], "git-unsupported"],
    [[ok("true\n"), failure("git-unsupported")], "git-unsupported"],
    // A path with a line break adds a line.
    [[ok("true\n"), ok("\n/home/user/a\nb\n.git\n.git\n")], "unsupported-path"],
    [[ok("true\n"), ok("\n\n.git\n.git\n")], "failed"],
  ];
  for (const [answers, reason] of cases) {
    const { runner } = fakeRunner({ "rev-parse": answers });

    expect(await inspectorWith(runner).locate("/home/user/folder")).toEqual({
      kind: "refused",
      reason,
    });
  }
});

test("with the runner and a fake execFile, a folder that is not a repository is refused", async () => {
  const calls: { file: string; args: readonly string[]; shell: boolean }[] = [];
  const runner = createGitRunner({
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, shell: options.shell });
      if (args.at(-1) === "version") {
        queueMicrotask(() =>
          callback(null, Buffer.from("git version 2.55.0\n"), Buffer.alloc(0)),
        );
        return;
      }
      const error: ExecFileError = Object.assign(new Error("Command failed"), {
        code: 128,
      });
      queueMicrotask(() =>
        callback(
          error,
          Buffer.alloc(0),
          Buffer.from(
            "fatal: not a git repository (or any of the parent directories): .git\n",
          ),
        ),
      );
    },
    environment: { GIT_OPTIONAL_LOCKS: "0" },
    locateGit: async () => "/usr/bin/git",
  });

  expect(await inspectorWith(runner).locate("/home/user/notes")).toEqual({
    kind: "refused",
    reason: "not-a-repository",
  });
  const globalArgs = [...GIT_GLOBAL_ARGS];
  expect(globalArgs).toContain("protocol.ssh.allow=never");
  expect(calls).toEqual([
    { file: "/usr/bin/git", args: [...globalArgs, "version"], shell: false },
    {
      file: "/usr/bin/git",
      args: [...globalArgs, "rev-parse", "--is-inside-work-tree"],
      shell: false,
    },
  ]);
});

const STATUS_OUTPUT = [
  `# branch.oid ${OID}`,
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +1 -0",
  `1 .M N... 100644 100644 100644 ${OID} ${OID} a file.txt`,
  "? new.txt",
  "",
].join("\0");

test("inspect reads the filters, the remotes, and the status, with every filter turned off", async () => {
  const { runner, calls } = fakeRunner({
    config: ok("filter.lfs.clean\0filter.lfs.process\0"),
    remote: ok(
      "origin\thttps://user:token@example.com/project.git (fetch)\norigin\thttps://user:token@example.com/project.git (push)\n",
    ),
    status: ok(STATUS_OUTPUT),
  });

  expect(await inspectorWith(runner).inspect(LOCATION)).toEqual({
    kind: "ready",
    branch: {
      name: "main",
      commit: OID,
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
    },
    changes: { staged: 0, unstaged: 1, untracked: 1, conflicted: 0 },
    remotes: [
      {
        name: "origin",
        fetchUrl: "https://example.com/project.git",
        pushUrl: "https://example.com/project.git",
      },
    ],
  });
  expect(calls.every(({ cwd }) => cwd === LOCATION.topLevel)).toBe(true);
  expect(calls.map(({ args }) => args)).toEqual([
    FILTER_DRIVER_ARGS,
    REMOTE_ARGS,
    [
      "-c",
      "filter.lfs.clean=",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.required=false",
      ...STATUS_ARGS,
    ],
  ]);
  expect(calls[2]?.limits).toBe(GIT_LIMITS.status);
  expect(STATUS_ARGS).toEqual([
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=normal",
    "--ignore-submodules=all",
  ]);
  // Only read-only subcommands.
  for (const { args } of calls) {
    const subcommand = args.filter(
      (arg, index) => arg !== "-c" && args[index - 1] !== "-c",
    )[0];
    expect(["config", "remote", "status"]).toContain(subcommand);
  }
  expect(FILTER_DRIVER_ARGS).toContain("--get-regexp");
});

test("without filter drivers, git config exits with 1 and the status has no overrides", async () => {
  const { runner, calls } = fakeRunner({
    config: exit(1),
    remote: ok(""),
    status: ok(STATUS_OUTPUT),
  });

  const result = await inspectorWith(runner).inspect(LOCATION);

  expect(result).toMatchObject({ kind: "ready", remotes: [] });
  expect(calls[2]?.args).toEqual(STATUS_ARGS);
});

test("a folder that is gone is missing, without running Git", async () => {
  const { runner, calls } = fakeRunner({});

  expect(
    await inspectorWith(runner, { isDirectory: false }).inspect(LOCATION),
  ).toEqual({ kind: "unavailable", problem: "missing" });
  expect(calls).toEqual([]);
});

test("a filter driver that cannot be turned off stops before the status runs", async () => {
  const { runner, calls } = fakeRunner({
    config: ok("filter.a=b.clean\0"),
    remote: ok(""),
  });

  expect(await inspectorWith(runner).inspect(LOCATION)).toEqual({
    kind: "unavailable",
    problem: "unsupported-config",
  });
  expect(calls.map(({ args }) => args[0])).not.toContain("status");
});

test("failures of Git become problems", async () => {
  const cases: [Record<string, GitOutcome>, string][] = [
    [{ config: failure("git-missing"), remote: ok("") }, "git-missing"],
    [{ config: failure("git-unsupported"), remote: ok("") }, "git-unsupported"],
    [
      { config: exit(128, "fatal: not a git repository"), remote: ok("") },
      "missing",
    ],
    [{ config: exit(1), remote: failure("timeout") }, "timeout"],
    [
      {
        config: exit(1),
        remote: ok(""),
        status: exit(128, "fatal: detected dubious ownership in repository"),
      },
      "untrusted",
    ],
    [
      { config: exit(1), remote: ok(""), status: failure("too-large") },
      "too-large",
    ],
    [
      { config: exit(1), remote: ok(""), status: failure("timeout") },
      "timeout",
    ],
    [{ config: exit(1), remote: ok(""), status: exit(129, "usage") }, "failed"],
    [{ config: exit(1), remote: ok(""), status: failure("aborted") }, "failed"],
    [{ config: exit(1), remote: ok(""), status: ok("1 ZZ\0") }, "failed"],
  ];
  for (const [answers, problem] of cases) {
    const { runner } = fakeRunner(answers);

    expect(await inspectorWith(runner).inspect(LOCATION)).toEqual({
      kind: "unavailable",
      problem,
    });
  }
});

test("names and URLs from the repository are made safe to show and fit the contract", async () => {
  const longBranch = "b".repeat(REPOSITORY_LIMITS.ref + 10);
  const bidi = String.fromCodePoint(0x202e);
  const remotes = Array.from(
    { length: REPOSITORY_LIMITS.remotes + 3 },
    (_, index) => `r${index}\thttps://example.com/${index}.git (fetch)`,
  );
  const { runner } = fakeRunner({
    config: exit(1),
    remote: ok(
      [
        `evil${bidi}name\thttps://example.com/x${bidi}y.git (fetch)`,
        ...remotes,
      ].join("\n"),
    ),
    status: ok(
      [`# branch.oid ${OID}`, `# branch.head ${longBranch}`, ""].join("\0"),
    ),
  });

  const result = await inspectorWith(runner).inspect(LOCATION);
  if (result.kind !== "ready") {
    throw new Error("expected a ready state");
  }

  expect(result.branch.name).toHaveLength(REPOSITORY_LIMITS.ref);
  expect(result.branch.name?.endsWith("...")).toBe(true);
  expect(result.remotes).toHaveLength(REPOSITORY_LIMITS.remotes);
  expect(result.remotes[0]?.name).toBe(
    `evil${String.fromCodePoint(0xfffd)}name`,
  );
  expect(result.remotes[0]?.fetchUrl).not.toContain(bidi);
});

test("displayText replaces invisible characters and shortens long text", () => {
  expect(displayText("main", 10)).toBe("main");
  expect(displayText("a\nb\u0000c", 10)).toBe(
    `a${String.fromCodePoint(0xfffd)}b${String.fromCodePoint(0xfffd)}c`,
  );
  expect(displayText(`x${String.fromCodePoint(0x200b)}y`, 10)).toBe(
    `x${String.fromCodePoint(0xfffd)}y`,
  );
  expect(displayText("abcdefghij", 10)).toBe("abcdefghij");
  expect(displayText("abcdefghijk", 10)).toBe("abcdefg...");
  expect(displayText(`caf${String.fromCodePoint(0xe9)}`, 10)).toBe(
    `caf${String.fromCodePoint(0xe9)}`,
  );
});
