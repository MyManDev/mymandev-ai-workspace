import { expect, test } from "vitest";
import {
  filterOverrideArgs,
  GitOutputError,
  MAX_FILTER_DRIVERS,
  parseFilterDrivers,
  parsePorcelainV2,
  HIDDEN_ADDRESS,
  parseRemotes,
  redactRemoteUrl,
  summarizeChanges,
} from "./git-status.ts";

const OID = "4398e47c585d12a2fa2d3d9f819a353092e8374c";
const HASH_A = "78981922613b2afb6025042ff6bd878ac1994e85";
const HASH_B = "61780798228d17af2d34fce4cfbdf35556832472";
const CAFE = `caf${String.fromCodePoint(0xe9)}.txt`;
const JAPANESE = `${String.fromCodePoint(0x65e5, 0x672c)}/${String.fromCodePoint(0x8a9e)} file.md`;

/** Joins records the way `git status -z` writes them, each ended by NUL. */
function zOutput(...records: string[]): string {
  return records.map((record) => `${record}\0`).join("");
}

const MODES = "100644 100644 100644";

test("a status with every record type is parsed, with paths kept byte for byte", () => {
  const output = zOutput(
    `# branch.oid ${OID}`,
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
    `1 .M N... ${MODES} ${HASH_A} ${HASH_A} with space.txt`,
    `1 A. N... 000000 100644 100644 ${"0".repeat(40)} ${HASH_B} ${CAFE}`,
    `2 R. N... ${MODES} ${HASH_A} ${HASH_A} R100 new name.txt`,
    "old name.txt",
    `2 RM N... ${MODES} ${HASH_A} ${HASH_B} C75 ${JAPANESE}`,
    "copied from.md",
    `u UU N... 100644 100644 100644 100644 ${HASH_A} ${HASH_B} ${HASH_A} conflict file.txt`,
    "? untracked folder/",
    `? line\nbreak.txt`,
    "! ignored.log",
  );

  const { branch, entries } = parsePorcelainV2(output);

  expect(branch).toEqual({
    name: "main",
    commit: OID,
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
  });
  expect(entries).toEqual([
    { kind: "changed", index: ".", worktree: "M", path: "with space.txt" },
    { kind: "changed", index: "A", worktree: ".", path: CAFE },
    {
      kind: "renamed",
      index: "R",
      worktree: ".",
      path: "new name.txt",
      originalPath: "old name.txt",
    },
    {
      kind: "renamed",
      index: "R",
      worktree: "M",
      path: JAPANESE,
      originalPath: "copied from.md",
    },
    { kind: "conflicted", code: "UU", path: "conflict file.txt" },
    { kind: "untracked", path: "untracked folder/" },
    { kind: "untracked", path: "line\nbreak.txt" },
    { kind: "ignored", path: "ignored.log" },
  ]);
  expect(summarizeChanges(entries)).toEqual({
    staged: 3,
    unstaged: 2,
    untracked: 2,
    conflicted: 1,
  });
});

test("a detached HEAD has no branch name", () => {
  const { branch } = parsePorcelainV2(
    zOutput(`# branch.oid ${OID}`, "# branch.head (detached)"),
  );

  expect(branch).toEqual({
    name: null,
    commit: OID,
    upstream: null,
    ahead: null,
    behind: null,
  });
});

test("a branch without commits has no commit", () => {
  const { branch, entries } = parsePorcelainV2(
    zOutput("# branch.oid (initial)", "# branch.head main", "? README.md"),
  );

  expect(branch.commit).toBeNull();
  expect(branch.name).toBe("main");
  expect(entries).toEqual([{ kind: "untracked", path: "README.md" }]);
});

test("ahead and behind are null when Git did not count them or the upstream is gone", () => {
  const counted = (ab: string | undefined) =>
    parsePorcelainV2(
      zOutput(
        `# branch.oid ${OID}`,
        "# branch.head main",
        "# branch.upstream origin/main",
        ...(ab === undefined ? [] : [`# branch.ab ${ab}`]),
      ),
    ).branch;

  expect(counted("+0 -0")).toMatchObject({ ahead: 0, behind: 0 });
  expect(counted("+? -?")).toMatchObject({ ahead: null, behind: null });
  expect(counted(undefined)).toMatchObject({
    upstream: "origin/main",
    ahead: null,
    behind: null,
  });
  expect(counted("+99999999999999999999 -1")).toMatchObject({
    ahead: null,
    behind: 1,
  });
});

test("a SHA-256 repository's commit is accepted", () => {
  const sha256 = "a".repeat(64);

  expect(
    parsePorcelainV2(zOutput(`# branch.oid ${sha256}`)).branch.commit,
  ).toBe(sha256);
});

test("unknown headers and record types are skipped, and empty output is a clean status", () => {
  expect(
    parsePorcelainV2(
      zOutput(`# branch.oid ${OID}`, "# stash 3", "# future.header x", "x new"),
    ).entries,
  ).toEqual([]);
  expect(parsePorcelainV2("")).toEqual({
    branch: {
      name: null,
      commit: null,
      upstream: null,
      ahead: null,
      behind: null,
    },
    entries: [],
  });
});

test("malformed records throw GitOutputError", () => {
  for (const output of [
    zOutput("# branch.oid not-a-commit"),
    zOutput(`1 .M N... ${MODES} ${HASH_A}`),
    zOutput(`1 .M N... ${MODES} ${HASH_A} ${HASH_A} `),
    zOutput(`1 ZZ N... ${MODES} ${HASH_A} ${HASH_A} file`),
    zOutput(`2 R. N... ${MODES} ${HASH_A} ${HASH_A} R100 new.txt`),
    `${zOutput(`2 R. N... ${MODES} ${HASH_A} ${HASH_A} R100 new.txt`)}\0`,
    zOutput(`u UU N... 100644 100644 100644 100644 ${HASH_A} file`),
    zOutput("? "),
    zOutput("? a", "", "? b"),
  ]) {
    expect(() => parsePorcelainV2(output)).toThrow(GitOutputError);
  }
});

test("credentials are removed from URLs with a scheme, and other forms stay", () => {
  expect(redactRemoteUrl("https://user:token@example.com/org/repo.git")).toBe(
    "https://example.com/org/repo.git",
  );
  expect(redactRemoteUrl("https://ghp_secret@github.com/org/repo")).toBe(
    "https://github.com/org/repo",
  );
  expect(redactRemoteUrl("ssh://git@example.com:22/repo.git")).toBe(
    "ssh://example.com:22/repo.git",
  );
  expect(redactRemoteUrl("https://a@b:c@example.com")).toBe(
    "https://example.com",
  );
  expect(redactRemoteUrl("https://example.com/path@with-at")).toBe(
    "https://example.com/path@with-at",
  );
  // A "?" before the "@": Git connects to example.com, so the "@" does not
  // start the host; the address is hidden rather than shown as "b".
  expect(redactRemoteUrl("https://example.com?x=a@b")).toBe(
    `https://${HIDDEN_ADDRESS}`,
  );
  expect(redactRemoteUrl("git@github.com:org/repo.git")).toBe(
    "git@github.com:org/repo.git",
  );
  expect(redactRemoteUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  expect(redactRemoteUrl("C:\\repos\\project")).toBe("C:\\repos\\project");
  expect(redactRemoteUrl("file:///srv/repo.git")).toBe("file:///srv/repo.git");
});

test("the query and the fragment of a URL with a scheme are removed", () => {
  expect(
    redactRemoteUrl("https://gitlab.com/org/repo.git?private_token=abc123"),
  ).toBe("https://gitlab.com/org/repo.git");
  expect(redactRemoteUrl("https://example.com/repo.git#token")).toBe(
    "https://example.com/repo.git",
  );
  expect(redactRemoteUrl("https://user:tok@example.com/repo.git?a=1#b")).toBe(
    "https://example.com/repo.git",
  );
  expect(redactRemoteUrl("https://example.com?token=x")).toBe(
    "https://example.com",
  );
  expect(redactRemoteUrl("https://example.com/x?a=b@c/d")).toBe(
    "https://example.com/x",
  );
  // An unencoded "?" or "#" in a password leaves nothing of it behind.
  expect(redactRemoteUrl("https://user:pa?ss@example.com/repo.git")).toBe(
    `https://${HIDDEN_ADDRESS}`,
  );
  expect(redactRemoteUrl("https://user:pa#ss@example.com/repo.git")).toBe(
    `https://${HIDDEN_ADDRESS}`,
  );
  expect(HIDDEN_ADDRESS).toBe("(address hidden)");
});

test("an address whose host is unclear is hidden, never shown as the part after the @", () => {
  // Git connects to "host"; the "@" belongs to the query or the fragment.
  expect(redactRemoteUrl("https://host?u=a@evil.example")).toBe(
    `https://${HIDDEN_ADDRESS}`,
  );
  expect(redactRemoteUrl("https://host#u=a@evil.example")).toBe(
    `https://${HIDDEN_ADDRESS}`,
  );
  expect(redactRemoteUrl("ssh://host?x@evil.example/repo.git")).toBe(
    `ssh://${HIDDEN_ADDRESS}`,
  );
  // An "@" after the first "/" is part of the path or the query.
  expect(redactRemoteUrl("https://host?x/y@evil.example")).toBe("https://host");
  expect(redactRemoteUrl("https://host/repo.git?u=a@evil.example")).toBe(
    "https://host/repo.git",
  );
  // A "?" after the "@" is a query of the real host.
  expect(redactRemoteUrl("https://user@host?u=a")).toBe("https://host");
  // Forms without a scheme have no query; they stay as they are.
  expect(redactRemoteUrl("git@host:org/repo.git")).toBe(
    "git@host:org/repo.git",
  );
});

test("remotes keep their first fetch and push URL, in order, without credentials", () => {
  const output = [
    "origin\thttps://user:token@example.com/x.git (fetch)",
    "origin\tssh://git@example.com/push.git (push)",
    "origin\tssh://git@example.com/second.git (push)",
    "my.remote\tgit@host:org/r.git (fetch)",
    "my.remote\tgit@host:org/r.git (push)",
    "spaced\t/srv/with space/repo.git (fetch)\r",
    "not a remote line",
    "",
  ].join("\n");

  expect(parseRemotes(output)).toEqual([
    {
      name: "origin",
      fetchUrl: "https://example.com/x.git",
      pushUrl: "ssh://example.com/push.git",
    },
    {
      name: "my.remote",
      fetchUrl: "git@host:org/r.git",
      pushUrl: "git@host:org/r.git",
    },
    { name: "spaced", fetchUrl: "/srv/with space/repo.git", pushUrl: null },
  ]);
  expect(parseRemotes("")).toEqual([]);
});

test("filter driver names are read from config keys, also with dots", () => {
  expect(
    parseFilterDrivers(
      zOutput(
        "filter.lfs.clean",
        "filter.lfs.smudge",
        "filter.lfs.process",
        "filter.lfs.required",
        "filter.my.driver.clean",
        "filter.With Space.process",
        "filter..clean",
        "filter..process",
        "filter.nosubsection",
        "core.fsmonitor",
      ),
    ),
  ).toEqual(["lfs", "my.driver", "With Space", ""]);
  expect(parseFilterDrivers("")).toEqual([]);
});

test("every program of every filter driver is turned off", () => {
  expect(filterOverrideArgs([])).toEqual([]);
  // `[filter ""]`, which the attribute `filter=` selects.
  expect(filterOverrideArgs([""])).toEqual([
    "-c",
    "filter..clean=",
    "-c",
    "filter..smudge=",
    "-c",
    "filter..process=",
    "-c",
    "filter..required=false",
  ]);
  expect(filterOverrideArgs(["lfs", "my.driver"])).toEqual([
    "-c",
    "filter.lfs.clean=",
    "-c",
    "filter.lfs.smudge=",
    "-c",
    "filter.lfs.process=",
    "-c",
    "filter.lfs.required=false",
    "-c",
    "filter.my.driver.clean=",
    "-c",
    "filter.my.driver.smudge=",
    "-c",
    "filter.my.driver.process=",
    "-c",
    "filter.my.driver.required=false",
  ]);
});

test("a driver name that cannot be written as a -c option, or too many, is refused", () => {
  expect(filterOverrideArgs(["a=b"])).toBeUndefined();
  expect(filterOverrideArgs(["ok", "x\0y"])).toBeUndefined();
  expect(
    filterOverrideArgs(
      Array.from({ length: MAX_FILTER_DRIVERS + 1 }, (_, index) => `d${index}`),
    ),
  ).toBeUndefined();
  expect(
    filterOverrideArgs(
      Array.from({ length: MAX_FILTER_DRIVERS }, (_, index) => `d${index}`),
    ),
  ).toHaveLength(MAX_FILTER_DRIVERS * 8);
});
