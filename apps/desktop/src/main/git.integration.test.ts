// Runs the real `git` on temporary repositories: the inspection finds a
// repository, reads its branch, changes, and remotes, and leaves every file
// and folder byte for byte unchanged, with the same modification times and
// inodes, although the repository's own configuration names programs that a
// plain `git status` runs, and a partial clone could fetch a missing object.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createGitInspector, type GitInspector } from "./git-inspector.ts";
import { buildGitEnvironment, GIT_GLOBAL_ARGS } from "./git-process.ts";
import { createSystemGitRunner, isDirectory } from "./repository-system.ts";

const CAFE = `caf${String.fromCodePoint(0xe9)}.txt`;
const TIMEOUT = 60_000;

/**
 * The marker files in `.git` that the configured programs of the main test
 * repository write when Git runs them.
 */
const MARKERS = Object.freeze([
  // filter.evil.clean, for a.txt
  "filter-ran",
  // the driver with an empty name, `[filter ""]`, for sub/s.txt
  "empty-filter-ran",
  // a driver from `include.path`, for "new name.txt"
  "include-filter-ran",
  // a driver from `includeIf "gitdir/i:..."`, for the file with the accent
  "includeif-filter-ran",
  // core.fsmonitor from `include.path`
  "fsmonitor-ran",
]);

let root = "";
let home = "";
let repo = "";
let inspector: GitInspector;

/** The environment of the setup commands: no user or system configuration. */
function setupEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^GIT_/i.test(name)) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, "empty.gitconfig"),
  };
}

/** The environment the inspection is built from, with an empty home. */
function inspectionSource(): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: setupEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    // The markers' programs also run in setup commands and complain there.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Runs `git status` with `env` and the options `before` it, without the rest
 * of the inspection's protections; ignores its exit code.
 */
function plainStatus(
  cwd: string,
  env: Record<string, string>,
  before: readonly string[] = [],
): void {
  try {
    execFileSync("git", [...before, "status", "--porcelain=v2"], {
      cwd,
      env,
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    // The markers are what counts.
  }
}

/**
 * Every file under `folder` with its size, modification time, inode, and
 * SHA-256, and every folder, the top one included, with its modification
 * time and inode, sorted by path. A file that was created and deleted again,
 * such as a lock file, changes its folder's modification time.
 */
async function snapshot(folder: string): Promise<[string, string][]> {
  const top = await stat(folder, { bigint: true });
  const entries: [string, string][] = [
    ["./", `folder ${top.mtimeNs} ${top.ino}`],
  ];
  const walk = async (directory: string, relative: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const full = path.join(directory, child.name);
      const key = relative === "" ? child.name : `${relative}/${child.name}`;
      const info = await stat(full, { bigint: true });
      if (child.isDirectory()) {
        entries.push([`${key}/`, `folder ${info.mtimeNs} ${info.ino}`]);
        await walk(full, key);
      } else {
        const hash = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
        entries.push([key, `${info.size} ${info.mtimeNs} ${info.ino} ${hash}`]);
      }
    }
  };
  await walk(folder, "");
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function markerExists(name: string): boolean {
  return existsSync(path.join(repo, ".git", name));
}

beforeAll(async () => {
  // The real path, so that it matches what Git prints (macOS links /var to
  // /private/var, Windows may give a short 8.3 name).
  root = realpathSync.native(
    await mkdtemp(path.join(tmpdir(), "mymandev-git-")),
  );
  home = path.join(root, "home");
  repo = path.join(root, "project");
  await mkdir(home);
  await writeFile(path.join(home, "empty.gitconfig"), "");
  await mkdir(path.join(repo, "sub"), { recursive: true });

  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  // The inspection also reads the system configuration, which on Windows
  // turns on line ending conversion.
  git(repo, "config", "core.autocrlf", "false");
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await writeFile(path.join(repo, "with space.txt"), "b\n");
  await writeFile(path.join(repo, CAFE), "c\n");
  await writeFile(path.join(repo, "old name.txt"), "old\n");
  await writeFile(path.join(repo, "sub", "s.txt"), "s\n");
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "-m", "init");

  // A staged rename, a staged change, a change that is not staged, and an
  // untracked file.
  git(repo, "mv", "old name.txt", "new name.txt");
  await appendFile(path.join(repo, CAFE), "staged\n");
  git(repo, "add", CAFE);
  await appendFile(path.join(repo, "with space.txt"), "more\n");
  await writeFile(path.join(repo, "untracked.txt"), "new\n");
  git(
    repo,
    "remote",
    "add",
    "origin",
    "https://user:secret-token@example.com/project.git?private_token=x",
  );

  // Programs that a plain `git status` runs, each leaving a marker file:
  // filter drivers selected by attributes, one of them with an empty name,
  // two from included files, and a file system monitor from an included
  // file.
  git(repo, "config", "filter.evil.clean", "echo ran > .git/filter-ran; cat");
  git(repo, "config", "filter..clean", "echo ran > .git/empty-filter-ran; cat");
  const included = path.join(repo, ".git", "extra.gitconfig");
  git(
    repo,
    "config",
    "--file",
    included,
    "filter.inc.clean",
    "echo ran > .git/include-filter-ran; cat",
  );
  git(
    repo,
    "config",
    "--file",
    included,
    "core.fsmonitor",
    "echo ran > .git/fsmonitor-ran; exit 1; :",
  );
  git(repo, "config", "include.path", "extra.gitconfig");
  const conditional = path.join(repo, ".git", "extra-if.gitconfig");
  git(
    repo,
    "config",
    "--file",
    conditional,
    "filter.incif.clean",
    "echo ran > .git/includeif-filter-ran; cat",
  );
  git(repo, "config", "includeIf.gitdir/i:project/.path", "extra-if.gitconfig");
  await writeFile(
    path.join(repo, ".git", "info", "attributes"),
    [
      "a.txt filter=evil",
      "sub/s.txt filter=",
      "new*.txt filter=inc",
      "caf*.txt filter=incif",
      "",
    ].join("\n"),
  );
  // An index older than every file makes Git compare the content of every
  // file whose size is unchanged, which runs its filter, and makes any write
  // of the index visible.
  const past = new Date("2001-01-01T00:00:00Z");
  await utimes(path.join(repo, ".git", "index"), past, past);

  inspector = createGitInspector(createSystemGitRunner(inspectionSource()), {
    pathApi: path,
    isDirectory,
  });
}, TIMEOUT);

afterAll(async () => {
  if (root !== "") {
    await rm(root, { recursive: true, force: true });
  }
}, TIMEOUT);

test(
  "the inspection reads the repository, runs no configured program, and changes nothing",
  async () => {
    const indexPath = path.join(repo, ".git", "index");
    const before = await snapshot(repo);
    const indexBefore = await readFile(indexPath);
    const indexTimeBefore = (await stat(indexPath, { bigint: true })).mtimeNs;

    const located = await inspector.locate(repo);
    if (located.kind !== "repository") {
      throw new Error(`expected a repository, got ${located.reason}`);
    }
    expect(path.relative(repo, located.location.topLevel)).toBe("");
    expect(
      path.relative(path.join(repo, ".git"), located.location.gitDir),
    ).toBe("");
    expect(
      path.relative(path.join(repo, ".git"), located.location.commonDir),
    ).toBe("");

    const state = await inspector.inspect(located.location);

    expect(state).toEqual({
      kind: "ready",
      branch: {
        name: "main",
        commit: expect.stringMatching(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        upstream: null,
        ahead: null,
        behind: null,
      },
      changes: { staged: 2, unstaged: 1, untracked: 1, conflicted: 0 },
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://example.com/project.git",
          pushUrl: "https://example.com/project.git",
        },
      ],
    });

    // Every file and folder unchanged, the index with its modification
    // time, and no configured program ran.
    expect(await snapshot(repo)).toEqual(before);
    expect((await readFile(indexPath)).equals(indexBefore)).toBe(true);
    expect((await stat(indexPath, { bigint: true })).mtimeNs).toBe(
      indexTimeBefore,
    );
    for (const marker of MARKERS) {
      expect(markerExists(marker), marker).toBe(false);
    }

    // The control: a plain `git status`, also without optional locks, runs
    // every one of the programs, so the repository above would have run
    // them.
    plainStatus(repo, { ...setupEnvironment(), GIT_OPTIONAL_LOCKS: "0" });
    for (const marker of MARKERS) {
      expect(markerExists(marker), marker).toBe(true);
    }
  },
  TIMEOUT,
);

test(
  "a partial clone with a missing object fetches nothing and writes nothing, also on a Git without GIT_NO_LAZY_FETCH",
  async () => {
    const partial = path.join(root, "partial");
    await mkdir(partial);
    git(partial, "init", "--quiet", "--initial-branch=main");
    git(partial, "config", "user.name", "Test");
    git(partial, "config", "user.email", "test@example.com");
    git(partial, "config", "commit.gpgsign", "false");
    await writeFile(path.join(partial, "a.txt"), "a\n");
    git(partial, "add", "a.txt");
    git(partial, "commit", "--quiet", "-m", "init");
    const head = git(partial, "rev-parse", "HEAD").trim();
    // A partial clone from an SSH remote whose SSH command leaves a marker,
    // with the object of HEAD missing, so `git status` would fetch it.
    git(partial, "config", "core.repositoryformatversion", "1");
    git(partial, "config", "extensions.partialClone", "origin");
    git(partial, "config", "remote.origin.url", "ssh://example.invalid/r.git");
    git(partial, "config", "remote.origin.promisor", "true");
    git(partial, "config", "remote.origin.partialclonefilter", "blob:none");
    git(
      partial,
      "config",
      "core.sshCommand",
      "echo ran > .git/ssh-ran; exit 1; :",
    );
    // Beats a general protocol.allow=never, but not the same setting on the
    // command line.
    git(partial, "config", "protocol.ssh.allow", "always");
    await rm(
      path.join(partial, ".git", "objects", head.slice(0, 2), head.slice(2)),
    );
    const marker = path.join(partial, ".git", "ssh-ran");
    const before = await snapshot(partial);

    const located = await inspector.locate(partial);
    if (located.kind !== "repository") {
      throw new Error(`expected a repository, got ${located.reason}`);
    }
    expect(await inspector.inspect(located.location)).toEqual({
      kind: "unavailable",
      problem: "failed",
    });
    expect(existsSync(marker)).toBe(false);
    expect(await snapshot(partial)).toEqual(before);

    // Git before 2.44 ignores GIT_NO_LAZY_FETCH. The inspection's
    // environment without it still allows no transport.
    const { GIT_NO_LAZY_FETCH, ...olderGit } = buildGitEnvironment(
      inspectionSource(),
      process.platform,
    );
    expect(GIT_NO_LAZY_FETCH).toBe("1");
    plainStatus(partial, olderGit);
    expect(existsSync(marker)).toBe(false);
    expect(await snapshot(partial)).toEqual(before);

    // Without GIT_ALLOW_PROTOCOL as well, the command-line settings alone
    // still allow no transport, despite the repository's
    // protocol.ssh.allow=always.
    const { GIT_ALLOW_PROTOCOL, ...noTransportVariables } = olderGit;
    expect(GIT_ALLOW_PROTOCOL).toBe("");
    plainStatus(partial, noTransportVariables, GIT_GLOBAL_ARGS);
    expect(existsSync(marker)).toBe(false);
    expect(await snapshot(partial)).toEqual(before);

    // The control: without both, `git status` runs the SSH command.
    plainStatus(partial, { ...setupEnvironment(), GIT_OPTIONAL_LOCKS: "0" });
    expect(existsSync(marker)).toBe(true);
  },
  TIMEOUT,
);

test(
  "a subfolder, a plain folder, the Git directory, and a bare repository are refused",
  async () => {
    const plain = path.join(root, "plain");
    const bare = path.join(root, "bare.git");
    await mkdir(plain);
    await mkdir(bare);
    git(bare, "init", "--quiet", "--bare");

    expect(await inspector.locate(path.join(repo, "sub"))).toEqual({
      kind: "refused",
      reason: "not-top-level",
    });
    expect(await inspector.locate(plain)).toEqual({
      kind: "refused",
      reason: "not-a-repository",
    });
    expect(await inspector.locate(path.join(repo, ".git"))).toEqual({
      kind: "refused",
      reason: "no-work-tree",
    });
    expect(await inspector.locate(bare)).toEqual({
      kind: "refused",
      reason: "no-work-tree",
    });
  },
  TIMEOUT,
);

test(
  "a linked worktree is located with its Git directories outside it",
  async () => {
    const feature = path.join(root, "feature");
    git(repo, "worktree", "add", "--quiet", "-b", "feature", feature);

    const located = await inspector.locate(feature);
    if (located.kind !== "repository") {
      throw new Error(`expected a repository, got ${located.reason}`);
    }
    expect(path.relative(feature, located.location.topLevel)).toBe("");
    expect(
      path.relative(
        path.join(repo, ".git", "worktrees", "feature"),
        located.location.gitDir,
      ),
    ).toBe("");
    expect(
      path.relative(path.join(repo, ".git"), located.location.commonDir),
    ).toBe("");

    const state = await inspector.inspect(located.location);
    expect(state).toMatchObject({
      kind: "ready",
      branch: { name: "feature" },
      changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });
  },
  TIMEOUT,
);
