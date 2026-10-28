// Fails when a text file in the repository contains characters that are invisible
// or reorder text in editors and diffs: bidirectional controls, zero-width and
// other format characters, control characters other than tab, line feed and
// carriage return, and the Unicode line and paragraph separators. Prettier,
// ESLint and tsc do not report them. Run with: npm run text:check
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { TextDecoder } from "node:util";

// Files that start with a UTF-8 byte order mark on purpose. A byte order mark
// anywhere else, or at the start of another file, is reported.
const BYTE_ORDER_MARK_FILES = new Set([
  ".github/CODEOWNERS",
  ".github/ISSUE_TEMPLATE/task.yml",
  ".github/pull_request_template.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "README.md",
  "docs/process/OWNERSHIP.md",
  "docs/process/ROADMAP.md",
  "docs/process/WORKFLOW.md",
]);

// Format characters (Cf), control characters except tab, line feed and carriage
// return, and the line and paragraph separators. Write such a character as an
// escape (for example \u202e) in source code and tests.
const FORBIDDEN = /[\p{Cf}\p{Zl}\p{Zp}]|[\p{Cc}--[\t\n\r]]/gv;

const listed = spawnSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (listed.status !== 0) {
  process.stderr.write(`git ls-files failed: ${listed.stderr}\n`);
  process.exit(2);
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const problems = [];
let checked = 0;

for (const path of new Set(listed.stdout.split("\0").filter(Boolean))) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    // Deleted in the working tree but still in the index.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  // Binary files contain a NUL byte; text files in this repository do not.
  if (bytes.includes(0)) continue;
  checked += 1;

  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    problems.push(`${path}: not valid UTF-8`);
    continue;
  }

  for (const match of text.matchAll(FORBIDDEN)) {
    const character = match[0];
    const index = match.index;
    if (
      index === 0 &&
      character === "\ufeff" &&
      BYTE_ORDER_MARK_FILES.has(path)
    ) {
      continue;
    }
    const before = text.slice(0, index);
    const line = before.split("\n").length;
    const column = index - before.lastIndexOf("\n");
    const code = character
      .codePointAt(0)
      ?.toString(16)
      .toUpperCase()
      .padStart(4, "0");
    problems.push(`${path}:${line}:${column}: U+${code}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `Invisible, bidirectional or control characters found:\n${problems.join("\n")}\n` +
      "Remove them, or write them as escapes such as \\u202e.\n",
  );
  process.exit(1);
}
process.stdout.write(
  `Checked ${checked} text files: no invisible or bidirectional characters.\n`,
);
