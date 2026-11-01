import type {
  GitBranch,
  GitChangeSummary,
  MountRefusal,
  RepositoryList,
  RepositoryProblem,
} from "../shared/ipc-contract.ts";

/** What the repository panel knows about the mounted repositories. */
export type RepositoryPanelView =
  /** Outside Electron, or the main process refused the subscription. */
  | { readonly kind: "unavailable" }
  /** Waiting for the first list. */
  | { readonly kind: "pending" }
  | { readonly kind: "known"; readonly list: RepositoryList };

export function initialRepositoryView(
  bridgeAvailable: boolean,
): RepositoryPanelView {
  return bridgeAvailable ? { kind: "pending" } : { kind: "unavailable" };
}

/** The message for a folder that was not mounted. */
export const MOUNT_REFUSAL_MESSAGES: Readonly<Record<MountRefusal, string>> =
  Object.freeze({
    busy: "A folder is already being selected.",
    "not-a-repository":
      "The selected folder is not a Git repository. Select the top-level folder of a Git repository.",
    "not-top-level":
      "The selected folder is inside a Git repository but is not its top-level folder. Select the folder that contains the repository's .git.",
    "no-work-tree":
      "The selected folder is a Git directory or a bare repository, which has no working tree. Select the folder of a working tree.",
    untrusted:
      "Git does not trust the selected folder because it belongs to another user. Git's safe.directory setting decides this.",
    "already-mounted": "This repository is already in the list.",
    limit: "The list is full. Remove a repository first.",
    "git-missing":
      "Git was not found. Install Git, make sure it is on the PATH, and try again.",
    "git-unsupported":
      "The installed Git is too old. Install Git 2.15 or later and try again.",
    "unsupported-path": "The path of the selected folder is not supported.",
    failed: "The selected folder could not be read.",
  });

/** The message for a mounted repository whose state cannot be shown. */
export const REPOSITORY_PROBLEM_MESSAGES: Readonly<
  Record<RepositoryProblem, string>
> = Object.freeze({
  missing: "The repository is no longer at this path.",
  untrusted:
    "Git does not trust this folder because it belongs to another user.",
  "git-missing": "Git was not found.",
  "git-unsupported":
    "The installed Git is too old: Git 2.15 or later is needed.",
  timeout: "Git took too long to read the status.",
  "too-large": "The status is too large to show.",
  "unsupported-config":
    "The status is not shown: the repository's Git configuration names a filter that cannot be turned off.",
  failed: "The status could not be read.",
});

const SHORT_COMMIT_LENGTH = 7;

/** The branch line, for example "main", "Detached at 1a2b3c4", or "main, no commits yet". */
export function describeBranch(branch: GitBranch): string {
  if (branch.name === null) {
    return branch.commit === null
      ? "Detached HEAD"
      : `Detached at ${branch.commit.slice(0, SHORT_COMMIT_LENGTH)}`;
  }
  return branch.commit === null
    ? `${branch.name}, no commits yet`
    : branch.name;
}

/** The upstream line, or undefined without an upstream. */
export function describeUpstream(branch: GitBranch): string | undefined {
  if (branch.upstream === null) {
    return undefined;
  }
  const { ahead, behind, upstream } = branch;
  if (ahead === null || behind === null) {
    return `Tracks ${upstream}`;
  }
  if (ahead === 0 && behind === 0) {
    return `Up to date with ${upstream}`;
  }
  return `${ahead} ahead of and ${behind} behind ${upstream}`;
}

/** The change summary, for example "2 staged, 1 not staged, 3 untracked". */
export function describeChanges(changes: GitChangeSummary): string {
  const parts: string[] = [];
  if (changes.conflicted > 0) {
    parts.push(`${changes.conflicted} conflicted`);
  }
  if (changes.staged > 0) {
    parts.push(`${changes.staged} staged`);
  }
  if (changes.unstaged > 0) {
    parts.push(`${changes.unstaged} not staged`);
  }
  if (changes.untracked > 0) {
    parts.push(`${changes.untracked} untracked`);
  }
  return parts.length === 0 ? "No changes" : parts.join(", ");
}
