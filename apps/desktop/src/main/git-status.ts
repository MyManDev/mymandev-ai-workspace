// Parsers for the output of the read-only Git commands that
// git-inspector.ts runs. They are pure functions, so tests cover them
// without Git.
import type {
  GitBranch,
  GitChangeSummary,
  GitRemote,
} from "../shared/ipc-contract.ts";

/** Output that does not have the documented format. */
export class GitOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitOutputError";
  }
}

/** One path of `git status --porcelain=v2`. */
export type StatusEntry =
  /** A changed tracked path ("1"). */
  | {
      readonly kind: "changed";
      readonly index: string;
      readonly worktree: string;
      readonly path: string;
    }
  /** A renamed or copied path ("2"). */
  | {
      readonly kind: "renamed";
      readonly index: string;
      readonly worktree: string;
      readonly path: string;
      readonly originalPath: string;
    }
  /** An unmerged path ("u"). */
  | {
      readonly kind: "conflicted";
      readonly code: string;
      readonly path: string;
    }
  | { readonly kind: "untracked"; readonly path: string }
  | { readonly kind: "ignored"; readonly path: string };

export interface PorcelainStatus {
  readonly branch: GitBranch;
  readonly entries: readonly StatusEntry[];
}

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const AHEAD_BEHIND = /^\+(\d+) -(\d+)$/;
const STATUS_CODE = /^[.MTADRCU?!]{2}$/;

/**
 * Splits a record into `count` fields separated by single spaces and the
 * rest, which is a path and may itself contain spaces.
 */
function splitRecord(
  record: string,
  count: number,
): { readonly fields: string[]; readonly rest: string } {
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < count; index += 1) {
    const end = record.indexOf(" ", start);
    if (end < 0) {
      throw new GitOutputError("A status record has too few fields.");
    }
    fields.push(record.slice(start, end));
    start = end + 1;
  }
  const rest = record.slice(start);
  if (rest === "") {
    throw new GitOutputError("A status record has no path.");
  }
  return { fields, rest };
}

function statusCode(code: string | undefined): string {
  if (code === undefined || !STATUS_CODE.test(code)) {
    throw new GitOutputError("A status record has an invalid status code.");
  }
  return code;
}

function count(digits: string | undefined): number | null {
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Parses the output of `git status --porcelain=v2 --branch -z`: header lines
 * that start with "#", then one record per path, each ended by a NUL byte.
 * A rename or copy record is followed by its original path as a record of
 * its own. Paths are raw, never quoted, so they may contain spaces, non-ASCII
 * characters, and newlines. Unknown headers and record types are skipped, so
 * a later Git version can add them; a known record that is malformed throws
 * `GitOutputError`.
 */
export function parsePorcelainV2(output: string): PorcelainStatus {
  const records = output.split("\0");
  // The output ends with a NUL, so the last element is empty.
  if (records.at(-1) === "") {
    records.pop();
  }
  const branch: {
    name: string | null;
    commit: string | null;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
  } = { name: null, commit: null, upstream: null, ahead: null, behind: null };
  const entries: StatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.startsWith("# ")) {
      const header = record.slice(2);
      const space = header.indexOf(" ");
      const key = space < 0 ? header : header.slice(0, space);
      const value = space < 0 ? "" : header.slice(space + 1);
      switch (key) {
        case "branch.oid":
          if (value === "(initial)") {
            branch.commit = null;
          } else if (COMMIT_ID.test(value)) {
            branch.commit = value;
          } else {
            throw new GitOutputError(
              "The branch header has an invalid commit.",
            );
          }
          break;
        case "branch.head":
          // Git writes "(detached)" when HEAD is not a branch.
          branch.name = value === "(detached)" || value === "" ? null : value;
          break;
        case "branch.upstream":
          branch.upstream = value === "" ? null : value;
          break;
        case "branch.ab": {
          // "+? -?" or a missing line means that Git did not count them.
          const match = AHEAD_BEHIND.exec(value);
          branch.ahead = match === null ? null : count(match[1]);
          branch.behind = match === null ? null : count(match[2]);
          break;
        }
        default:
          break;
      }
      continue;
    }
    const type = record.slice(0, 2);
    switch (type) {
      case "1 ": {
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        const { fields, rest } = splitRecord(record, 8);
        const code = statusCode(fields[1]);
        entries.push({
          kind: "changed",
          index: code.charAt(0),
          worktree: code.charAt(1),
          path: rest,
        });
        break;
      }
      case "2 ": {
        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>, then
        // the original path as the next record.
        const { fields, rest } = splitRecord(record, 9);
        const code = statusCode(fields[1]);
        const originalPath = records[index + 1];
        if (originalPath === undefined || originalPath === "") {
          throw new GitOutputError("A rename record has no original path.");
        }
        index += 1;
        entries.push({
          kind: "renamed",
          index: code.charAt(0),
          worktree: code.charAt(1),
          path: rest,
          originalPath,
        });
        break;
      }
      case "u ": {
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
        const { fields, rest } = splitRecord(record, 10);
        entries.push({
          kind: "conflicted",
          code: statusCode(fields[1]),
          path: rest,
        });
        break;
      }
      case "? ":
      case "! ": {
        const path = record.slice(2);
        if (path === "") {
          throw new GitOutputError("A status record has no path.");
        }
        entries.push({
          kind: type === "? " ? "untracked" : "ignored",
          path,
        });
        break;
      }
      default:
        if (record === "") {
          throw new GitOutputError("The status output has an empty record.");
        }
        break;
    }
  }
  return { branch: { ...branch }, entries };
}

/** The number of staged, not staged, untracked, and conflicted paths. */
export function summarizeChanges(
  entries: readonly StatusEntry[],
): GitChangeSummary {
  const summary = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  for (const entry of entries) {
    switch (entry.kind) {
      case "changed":
      case "renamed":
        if (entry.index !== ".") {
          summary.staged += 1;
        }
        if (entry.worktree !== ".") {
          summary.unstaged += 1;
        }
        break;
      case "conflicted":
        summary.conflicted += 1;
        break;
      case "untracked":
        summary.untracked += 1;
        break;
      case "ignored":
        break;
    }
  }
  return summary;
}

/** What a URL with a scheme shows when its address cannot be told safely. */
export const HIDDEN_ADDRESS = "(address hidden)";

/**
 * Removes what can hold a password or a token from a URL with a scheme: the
 * user information, the query, and the fragment, so
 * "https://user:token@host/repo.git?private_token=x" becomes
 * "https://host/repo.git". When a "?" or "#" comes before the last "@" of
 * the address, it is unclear which host Git connects to and where a
 * password ends: "https://host?u=a@evil.example" connects to "host", and
 * "https://user:pa?ss@host" holds a password. Then everything after the
 * scheme is replaced with `HIDDEN_ADDRESS`. Other forms, such as
 * "git@host:repo.git" or a local path, are returned unchanged.
 */
export function redactRemoteUrl(url: string): string {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(url);
  if (scheme === null) {
    return url;
  }
  const start = scheme[0].length;
  const pathStart = url.indexOf("/", start);
  const authorityEnd = pathStart < 0 ? url.length : pathStart;
  const at = url.lastIndexOf("@", authorityEnd - 1);
  const firstDelimiter = url.slice(start).search(/[?#]/);
  if (at >= start && firstDelimiter >= 0 && start + firstDelimiter < at) {
    return `${scheme[0]}${HIDDEN_ADDRESS}`;
  }
  const withoutUser =
    at < start ? url : url.slice(0, start) + url.slice(at + 1);
  const queryStart = withoutUser.slice(start).search(/[?#]/);
  return queryStart < 0
    ? withoutUser
    : withoutUser.slice(0, start + queryStart);
}

/**
 * Parses the output of `git remote -v`: "<name>\t<url> (fetch)" and
 * "<name>\t<url> (push)" lines. Keeps the first fetch and push URL of each
 * remote, in the order of the output, with credentials removed.
 */
export function parseRemotes(output: string): GitRemote[] {
  const remotes = new Map<
    string,
    { fetchUrl: string | null; pushUrl: string | null }
  >();
  for (const line of output.split("\n")) {
    const match = /^([^\t]+)\t(.+) \((fetch|push)\)$/.exec(
      line.endsWith("\r") ? line.slice(0, -1) : line,
    );
    if (match === null) {
      continue;
    }
    const [, name = "", url = "", kind] = match;
    const remote = remotes.get(name) ?? { fetchUrl: null, pushUrl: null };
    if (kind === "fetch") {
      remote.fetchUrl ??= redactRemoteUrl(url);
    } else {
      remote.pushUrl ??= redactRemoteUrl(url);
    }
    remotes.set(name, remote);
  }
  return [...remotes].map(([name, urls]) => ({ name, ...urls }));
}

/**
 * The names of the filter drivers in the output of
 * `git config -z --name-only --get-regexp "^filter\."`: keys such as
 * "filter.lfs.clean", each ended by a NUL byte. A driver name may contain
 * dots; the last part of the key is the setting. A driver name may also be
 * empty ("filter..clean" from `[filter ""]`), which the attribute `filter=`
 * selects, so it is kept.
 */
export function parseFilterDrivers(output: string): string[] {
  const names = new Set<string>();
  for (const key of output.split("\0")) {
    if (!key.startsWith("filter.")) {
      continue;
    }
    const last = key.lastIndexOf(".");
    if (last >= "filter.".length) {
      names.add(key.slice("filter.".length, last));
    }
  }
  return [...names];
}

/** The most filter drivers that are turned off; more are refused. */
export const MAX_FILTER_DRIVERS = 64;

/**
 * `-c` options that turn off every program of these filter drivers for one
 * command. `git status` runs a driver's `clean` or `process` program when it
 * compares a file with the index, and a repository's own configuration can
 * name any program there. An empty command means no filter, and
 * `required=false` keeps Git from failing without it. Returns undefined when
 * a name cannot be written as a `-c` option, because it contains "=", which
 * ends the key, or there are too many.
 */
export function filterOverrideArgs(
  drivers: readonly string[],
): string[] | undefined {
  if (drivers.length > MAX_FILTER_DRIVERS) {
    return undefined;
  }
  const args: string[] = [];
  for (const driver of drivers) {
    if (driver.includes("=") || driver.includes("\0")) {
      return undefined;
    }
    for (const setting of ["clean=", "smudge=", "process=", "required=false"]) {
      args.push("-c", `filter.${driver}.${setting}`);
    }
  }
  return args;
}
