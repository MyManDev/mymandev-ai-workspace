import { expect, test } from "vitest";
import {
  MOUNT_REFUSALS,
  REPOSITORY_PROBLEMS,
  type GitBranch,
} from "../shared/ipc-contract.ts";
import {
  describeBranch,
  describeChanges,
  describeUpstream,
  initialRepositoryView,
  MOUNT_REFUSAL_MESSAGES,
  REPOSITORY_PROBLEM_MESSAGES,
} from "./repository-view.ts";

const COMMIT = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

const BRANCH: GitBranch = {
  name: "main",
  commit: COMMIT,
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
};

test("every refusal and every problem has a message", () => {
  expect(Object.keys(MOUNT_REFUSAL_MESSAGES).sort()).toEqual(
    [...MOUNT_REFUSALS].sort(),
  );
  expect(Object.keys(REPOSITORY_PROBLEM_MESSAGES).sort()).toEqual(
    [...REPOSITORY_PROBLEMS].sort(),
  );
  for (const message of [
    ...Object.values(MOUNT_REFUSAL_MESSAGES),
    ...Object.values(REPOSITORY_PROBLEM_MESSAGES),
  ]) {
    expect(message).toMatch(/^[A-Z].*\.$/);
  }
  expect(MOUNT_REFUSAL_MESSAGES["not-a-repository"]).toContain(
    "is not a Git repository",
  );
});

test("the panel waits for the bridge, or says it is unavailable", () => {
  expect(initialRepositoryView(true)).toEqual({ kind: "pending" });
  expect(initialRepositoryView(false)).toEqual({ kind: "unavailable" });
});

test("the branch line names the branch, a detached commit, or a branch without commits", () => {
  expect(describeBranch(BRANCH)).toBe("main");
  expect(describeBranch({ ...BRANCH, name: null })).toBe("Detached at 1a2b3c4");
  expect(describeBranch({ ...BRANCH, commit: null })).toBe(
    "main, no commits yet",
  );
  expect(describeBranch({ ...BRANCH, name: null, commit: null })).toBe(
    "Detached HEAD",
  );
});

test("the upstream line counts commits when Git counted them", () => {
  expect(describeUpstream(BRANCH)).toBe("Up to date with origin/main");
  expect(describeUpstream({ ...BRANCH, ahead: 3, behind: 0 })).toBe(
    "3 ahead of and 0 behind origin/main",
  );
  expect(describeUpstream({ ...BRANCH, ahead: null, behind: null })).toBe(
    "Tracks origin/main",
  );
  expect(describeUpstream({ ...BRANCH, upstream: null })).toBeUndefined();
});

test("the change summary lists the non-zero counts", () => {
  expect(
    describeChanges({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }),
  ).toBe("No changes");
  expect(
    describeChanges({ staged: 1, unstaged: 2, untracked: 3, conflicted: 4 }),
  ).toBe("4 conflicted, 1 staged, 2 not staged, 3 untracked");
  expect(
    describeChanges({ staged: 0, unstaged: 0, untracked: 5, conflicted: 0 }),
  ).toBe("5 untracked");
});
