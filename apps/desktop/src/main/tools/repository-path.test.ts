import { expect, test } from "vitest";
import {
  MAX_REPOSITORY_PATH_LENGTH,
  MAX_REPOSITORY_PATH_SEGMENT_LENGTH,
  parseRepositoryPath,
  REPOSITORY_PATH_REFUSALS,
  type RepositoryPathRefusal,
  segmentRefusal,
} from "./repository-path.ts";

test("relative POSIX paths are accepted with their segments, and . is the root", () => {
  expect(parseRepositoryPath(".")).toEqual({
    ok: true,
    path: { text: ".", segments: [] },
  });
  for (const [text, segments] of [
    ["README.md", ["README.md"]],
    ["src/main/index.ts", ["src", "main", "index.ts"]],
    ["a b/c-d_e.f", ["a b", "c-d_e.f"]],
    ["docs/über.md", ["docs", "über.md"]],
    ["console.ts", ["console.ts"]],
    ["com10", ["com10"]],
    ["git/x", ["git", "x"]],
    ["a.git/x", ["a.git", "x"]],
  ] as const) {
    expect(parseRepositoryPath(text), text).toEqual({
      ok: true,
      path: { text, segments },
    });
  }
});

/** Each input with the one reason that refuses it first. */
const REFUSED: readonly (readonly [unknown, RepositoryPathRefusal])[] = [
  [7, "not_text"],
  [null, "not_text"],
  [undefined, "not_text"],
  [["a"], "not_text"],
  ["", "empty"],
  ["a".repeat(MAX_REPOSITORY_PATH_LENGTH + 1), "too_long"],
  // Short segments: only the bound of the whole path refuses it.
  [`${"a/".repeat(MAX_REPOSITORY_PATH_LENGTH / 2)}a`, "too_long"],
  [`a/${"b".repeat(MAX_REPOSITORY_PATH_SEGMENT_LENGTH + 1)}`, "too_long"],
  ["a\u0000b", "nul"],
  ["src/a\u0000", "nul"],
  ["a\nb", "control"],
  ["a\u001bb", "control"],
  ["a\u007fb", "control"],
  ["a\u0085b", "control"],
  ["a\\b", "backslash"],
  ["\\\\server\\share\\file", "backslash"],
  ["..\\secret", "backslash"],
  ["//server/share/file", "unc"],
  ["//?/C:/Windows", "unc"],
  ["/etc/passwd", "absolute"],
  ["/", "absolute"],
  ["C:/Windows/win.ini", "drive"],
  ["c:secret", "drive"],
  ["Z:", "drive"],
  ["file.txt:hidden", "stream"],
  ["src/file.txt::$DATA", "stream"],
  ["a<b", "reserved_character"],
  ["a>b", "reserved_character"],
  ['a"b', "reserved_character"],
  ["a|b", "reserved_character"],
  ["a?b", "reserved_character"],
  ["src/*", "reserved_character"],
  ["a//b", "empty_segment"],
  ["src/", "empty_segment"],
  ["./src", "dot_segment"],
  ["src/./a", "dot_segment"],
  ["src/.", "dot_segment"],
  ["..", "dot_dot"],
  ["../outside", "dot_dot"],
  ["src/../../outside", "dot_dot"],
  ["src/..", "dot_dot"],
  ["file.", "trailing_dot_space"],
  ["file ", "trailing_dot_space"],
  [".git.", "trailing_dot_space"],
  [".git ", "trailing_dot_space"],
  ["...", "trailing_dot_space"],
  ["con", "device_name"],
  ["CON", "device_name"],
  ["src/nul.txt", "device_name"],
  ["aux.tar.gz", "device_name"],
  ["prn", "device_name"],
  ["com1", "device_name"],
  ["LPT9.log", "device_name"],
  ["com\u00b9", "device_name"],
  ["lpt\u00b3", "device_name"],
  ["conin$", "device_name"],
  ["CONOUT$", "device_name"],
  ["clock$", "device_name"],
  [".git", "git"],
  [".git/config", "git"],
  [".GIT/HEAD", "git"],
  ["sub/.Git/objects", "git"],
  [".env", "hidden"],
  ["config/.secrets/key", "hidden"],
  [".github/workflows/ci.yml", "hidden"],
];

test("every refused form answers its own reason", () => {
  for (const [value, reason] of REFUSED) {
    expect(parseRepositoryPath(value), JSON.stringify(value)).toEqual({
      ok: false,
      reason,
    });
  }
  // Every lexical reason has a case.
  const lexical = new Set(REFUSED.map(([, reason]) => reason));
  const fileSystemReasons = [
    "outside",
    "alias",
    "hard_link",
    "changed",
    "other_device",
    "unsettled",
  ];
  for (const reason of REPOSITORY_PATH_REFUSALS) {
    if (!fileSystemReasons.includes(reason)) {
      expect(lexical.has(reason), reason).toBe(true);
    }
  }
});

test("the lengths are bounds: a path and a segment of exactly the bound pass", () => {
  const segment = "s".repeat(MAX_REPOSITORY_PATH_SEGMENT_LENGTH);
  expect(parseRepositoryPath(segment).ok).toBe(true);
  const segments: string[] = [];
  while (segments.join("/").length < MAX_REPOSITORY_PATH_LENGTH - 100) {
    segments.push("d".repeat(99));
  }
  const exact = segments.join("/");
  const padded = `${exact}/${"f".repeat(MAX_REPOSITORY_PATH_LENGTH - exact.length - 1)}`;
  expect(padded).toHaveLength(MAX_REPOSITORY_PATH_LENGTH);
  expect(parseRepositoryPath(padded).ok).toBe(true);
});

test("segmentRefusal decides the names that a listing shows by the same rules", () => {
  expect(segmentRefusal("index.ts")).toBeNull();
  expect(segmentRefusal(".git")).toBe("git");
  expect(segmentRefusal(".env")).toBe("hidden");
  expect(segmentRefusal("nul")).toBe("device_name");
  expect(segmentRefusal("a:b")).toBe("stream");
  expect(segmentRefusal("a\\b")).toBe("backslash");
  expect(segmentRefusal("line\nbreak")).toBe("control");
  expect(segmentRefusal("end.")).toBe("trailing_dot_space");
  expect(segmentRefusal("")).toBe("empty_segment");
});

test("a parsed path is frozen", () => {
  const parsed = parseRepositoryPath("src/a.ts");
  expect(Object.isFrozen(parsed)).toBe(true);
  if (parsed.ok) {
    expect(Object.isFrozen(parsed.path)).toBe(true);
    expect(Object.isFrozen(parsed.path.segments)).toBe(true);
  }
});
