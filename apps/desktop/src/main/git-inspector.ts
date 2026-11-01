// Reads a repository with read-only Git commands (ADR 0016): `rev-parse` to
// locate it, `config --get-regexp` and `remote -v` to read its filter
// drivers and remotes, and `status --porcelain=v2` for its branch and
// changes. No command writes to the repository: `GIT_OPTIONAL_LOCKS=0` keeps
// `git status` from refreshing the index, and no configured program runs
// (git-process.ts, `filterOverrideArgs`).
import type { PlatformPath } from "node:path";
import {
  REPOSITORY_LIMITS,
  type GitBranch,
  type GitRemote,
  type MountRefusal,
  type RepositoryProblem,
  type RepositoryState,
} from "../shared/ipc-contract.ts";
import type { GitLimits, GitOutcome, GitRunner } from "./git-process.ts";
import {
  filterOverrideArgs,
  parseFilterDrivers,
  parsePorcelainV2,
  parseRemotes,
  summarizeChanges,
} from "./git-status.ts";

/** The folders of a mounted repository, all absolute. */
export interface RepositoryLocation {
  /** The top-level folder of the working tree. */
  readonly topLevel: string;
  /** The Git directory, usually `<topLevel>/.git`. */
  readonly gitDir: string;
  /** The common Git directory; differs from `gitDir` in a linked worktree. */
  readonly commonDir: string;
}

export type LocateResult =
  | { readonly kind: "repository"; readonly location: RepositoryLocation }
  | { readonly kind: "refused"; readonly reason: MountRefusal };

export type InspectResult = Exclude<RepositoryState, { kind: "loading" }>;

export const GIT_LIMITS: Readonly<Record<"query" | "status", GitLimits>> =
  Object.freeze({
    query: { timeoutMs: 10_000, maxBytes: 1024 * 1024 },
    status: { timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024 },
  });

/** The arguments of the status command, after the filter overrides. */
export const STATUS_ARGS = Object.freeze([
  "status",
  "--porcelain=v2",
  "--branch",
  "-z",
  "--untracked-files=normal",
  // Submodules are not entered: `git status` would run a second `git status`
  // in each, with the submodule's own configuration.
  "--ignore-submodules=all",
]);

export const FILTER_DRIVER_ARGS = Object.freeze([
  "config",
  "-z",
  "--name-only",
  "--get-regexp",
  "^filter\\.",
]);

export const REMOTE_ARGS = Object.freeze(["remote", "-v"]);

export interface GitInspector {
  /**
   * Checks that `folder` is the top-level folder of a Git working tree.
   * A folder inside a working tree is refused, not widened to the top level,
   * so a mount never covers more than the folder the user selected.
   */
  locate(folder: string, signal?: AbortSignal): Promise<LocateResult>;
  /** Reads the branch, the changes, and the remotes. Never rejects. */
  inspect(
    location: RepositoryLocation,
    signal?: AbortSignal,
  ): Promise<InspectResult>;
}

export interface GitInspectorOptions {
  readonly pathApi: PlatformPath;
  /** True when `path` is an existing folder. */
  readonly isDirectory: (path: string) => Promise<boolean>;
}

const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Text from a repository for display: control, format, and line separator
 * characters, which can hide or reorder text, become U+FFFD, and text longer
 * than `maxLength` is shortened with "...".
 */
export function displayText(text: string, maxLength: number): string {
  const visible = text.replace(INVISIBLE_CHARACTERS, REPLACEMENT_CHARACTER);
  return visible.length <= maxLength
    ? visible
    : `${visible.slice(0, maxLength - 3)}...`;
}

/** Git refuses a repository that belongs to another user (`safe.directory`). */
function isUntrusted(stderr: string): boolean {
  return /dubious ownership/i.test(stderr);
}

function isNotARepository(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

function problemOf(
  outcome: Extract<GitOutcome, { ok: false }>,
): RepositoryProblem {
  switch (outcome.failure) {
    case "git-missing":
      return "git-missing";
    case "git-unsupported":
      return "git-unsupported";
    case "timeout":
      return "timeout";
    case "too-large":
      return "too-large";
    case "exit":
      if (isUntrusted(outcome.stderr)) {
        return "untrusted";
      }
      return isNotARepository(outcome.stderr) ? "missing" : "failed";
    case "aborted":
    case "spawn":
      return "failed";
  }
}

function unavailable(problem: RepositoryProblem): InspectResult {
  return { kind: "unavailable", problem };
}

function refused(reason: MountRefusal): LocateResult {
  return { kind: "refused", reason };
}

function displayBranch(branch: GitBranch): GitBranch {
  return {
    ...branch,
    name:
      branch.name === null
        ? null
        : displayText(branch.name, REPOSITORY_LIMITS.ref),
    upstream:
      branch.upstream === null
        ? null
        : displayText(branch.upstream, REPOSITORY_LIMITS.ref),
  };
}

function displayRemote(remote: GitRemote): GitRemote {
  const url = (value: string | null) =>
    value === null ? null : displayText(value, REPOSITORY_LIMITS.url);
  return {
    name: displayText(remote.name, REPOSITORY_LIMITS.remoteName),
    fetchUrl: url(remote.fetchUrl),
    pushUrl: url(remote.pushUrl),
  };
}

export function createGitInspector(
  runner: GitRunner,
  options: GitInspectorOptions,
): GitInspector {
  const { pathApi, isDirectory } = options;

  const locate = async (
    folder: string,
    signal?: AbortSignal,
  ): Promise<LocateResult> => {
    const probe = await runner.run(
      folder,
      ["rev-parse", "--is-inside-work-tree"],
      GIT_LIMITS.query,
      signal,
    );
    if (!probe.ok) {
      switch (probe.failure) {
        case "git-missing":
        case "git-unsupported":
          return refused(probe.failure);
        case "exit":
          return refused(
            isUntrusted(probe.stderr) ? "untrusted" : "not-a-repository",
          );
        default:
          return refused("failed");
      }
    }
    // "false" inside a Git directory or a bare repository.
    if (probe.stdout.trim() !== "true") {
      return refused("no-work-tree");
    }

    const paths = await runner.run(
      folder,
      [
        "rev-parse",
        "--show-prefix",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
      GIT_LIMITS.query,
      signal,
    );
    if (!paths.ok) {
      return refused(
        paths.failure === "git-missing" || paths.failure === "git-unsupported"
          ? paths.failure
          : "failed",
      );
    }
    const lines = paths.stdout.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    // One line each; a path with a line break would add lines.
    if (lines.length !== 4) {
      return refused("unsupported-path");
    }
    const [prefix = "", topLevel = "", gitDir = "", commonDir = ""] = lines;
    if (prefix !== "") {
      return refused("not-top-level");
    }
    if (topLevel === "" || gitDir === "" || commonDir === "") {
      return refused("failed");
    }
    // Git prints the Git directories relative to the folder or absolute,
    // and on Windows with forward slashes; resolve normalizes both.
    return {
      kind: "repository",
      location: {
        topLevel: pathApi.resolve(folder, topLevel),
        gitDir: pathApi.resolve(folder, gitDir),
        commonDir: pathApi.resolve(folder, commonDir),
      },
    };
  };

  const inspect = async (
    location: RepositoryLocation,
    signal?: AbortSignal,
  ): Promise<InspectResult> => {
    const cwd = location.topLevel;
    if (!(await isDirectory(cwd))) {
      return unavailable("missing");
    }
    const [filters, remotes] = await Promise.all([
      runner.run(cwd, FILTER_DRIVER_ARGS, GIT_LIMITS.query, signal),
      runner.run(cwd, REMOTE_ARGS, GIT_LIMITS.query, signal),
    ]);
    // `git config --get-regexp` exits with 1 when nothing matches.
    let drivers: string[];
    if (filters.ok) {
      drivers = parseFilterDrivers(filters.stdout);
    } else if (filters.failure === "exit" && filters.exitCode === 1) {
      drivers = [];
    } else {
      return unavailable(problemOf(filters));
    }
    const overrides = filterOverrideArgs(drivers);
    if (overrides === undefined) {
      return unavailable("unsupported-config");
    }
    if (!remotes.ok) {
      return unavailable(problemOf(remotes));
    }

    const status = await runner.run(
      cwd,
      [...overrides, ...STATUS_ARGS],
      GIT_LIMITS.status,
      signal,
    );
    if (!status.ok) {
      return unavailable(problemOf(status));
    }
    let parsed;
    try {
      parsed = parsePorcelainV2(status.stdout);
    } catch {
      return unavailable("failed");
    }
    return {
      kind: "ready",
      branch: displayBranch(parsed.branch),
      changes: summarizeChanges(parsed.entries),
      remotes: parseRemotes(remotes.stdout)
        .slice(0, REPOSITORY_LIMITS.remotes)
        .map(displayRemote),
    };
  };

  return Object.freeze({ locate, inspect });
}
