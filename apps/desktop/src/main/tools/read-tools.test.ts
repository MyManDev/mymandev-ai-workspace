import path from "node:path";
import { expect, test } from "vitest";
import {
  createReadTools,
  READ_TOOL_LIMITS,
  READ_TOOL_NAMES,
  type ReadToolFileSystem,
  type ToolFileHandle,
  type ToolFileKind,
  type ToolFileStat,
} from "./read-tools.ts";
import type { Tool, ToolRunOutcome } from "./tool-dispatcher.ts";

// A fake file system with POSIX paths: folders, files, and symbolic links.
// `open` follows every link, as Windows does without `O_NOFOLLOW`, so the
// checks after the open are what refuse a swap. A folder's change time is
// stamped with the fake clock whenever an entry in it is created, removed,
// or renamed, and a node's own change time when it changes in place, as on
// a real file system; the clock moves only when a test or a wait moves it,
// so changes during a call share one step of the clock.

type Node =
  | { readonly type: "dir"; readonly ino: bigint }
  | {
      readonly type: "file";
      readonly ino: bigint;
      content: Uint8Array;
      nlink: bigint;
    }
  | { readonly type: "link"; readonly ino: bigint; readonly target: string }
  | { readonly type: "fifo"; readonly ino: bigint };

type Operation = "realpath" | "lstat" | "open" | "readdir" | "read";

function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: /work/repo/secret`), { code });
}

function parentOf(target: string): string | null {
  if (target === "/") {
    return null;
  }
  const index = target.lastIndexOf("/");
  return index <= 0 ? "/" : target.slice(0, index);
}

/** The nodes by path; a change of an entry calls `onChange` unless quiet. */
class Tree extends Map<string, Node> {
  onChange: ((target: string) => void) | null = null;
  quiet = false;

  override set(target: string, node: Node): this {
    super.set(target, node);
    if (this.quiet !== true) {
      this.onChange?.(target);
    }
    return this;
  }

  override delete(target: string): boolean {
    const had = super.delete(target);
    if (had && this.quiet !== true) {
      this.onChange?.(target);
    }
    return had;
  }
}

/** The fake clock's start, in milliseconds since 1970. */
const CLOCK_START = 1_700_000_000_000;

class FakeFiles implements ReadToolFileSystem {
  readonly nodes = new Tree([["/", { type: "dir", ino: 1n }]]);
  /** The fake clock, in milliseconds since 1970. */
  now = CLOCK_START;
  /**
   * The step of the clock that stamps change times, in milliseconds: 1,000
   * as HFS+, about 16 as NTFS with the default tick; 1 ns when null.
   */
  stepMs: number | null = null;
  /** Reports no change times (0), as a file system without them. */
  noChangeTimes = false;
  /** Whether a run moves the clock 10 s first, so the setup is settled. */
  settleBeforeRun = true;
  /** The waits of the tools, in milliseconds. */
  readonly sleeps: number[] = [];
  /** Runs after each wait of the tools. */
  onSleep: (() => void) | null = null;
  private readonly ctimes = new Map<bigint, bigint>();
  private readonly origin: bigint;

  constructor() {
    this.origin = this.stamp();
    this.nodes.onChange = (target) => {
      const parent = parentOf(target);
      if (parent !== null) {
        this.touch(parent);
      }
    };
  }

  /** The change time that a change now gets. */
  stamp(): bigint {
    const nanoseconds = BigInt(this.now) * 1_000_000n + 7n;
    if (this.stepMs === null) {
      return nanoseconds;
    }
    const step = BigInt(this.stepMs) * 1_000_000n;
    return nanoseconds - (nanoseconds % step);
  }

  /** Stamps the change time of the node at `target`. */
  touch(target: string): void {
    const node = this.nodes.get(target);
    if (node !== undefined) {
      this.ctimes.set(node.ino, this.stamp());
    }
  }

  /**
   * Changes a folder into a link to `to` in place, or a link back into a
   * folder (`to` null), with the same file number, as a junction set on or
   * removed from an empty folder on Windows: only its own change time
   * moves, not its parent's.
   */
  convert(target: string, to: string | null): void {
    const node = this.nodes.get(target);
    if (node === undefined) {
      throw new Error("nothing to convert");
    }
    this.nodes.quiet = true;
    this.nodes.set(
      target,
      to === null
        ? { type: "dir", ino: node.ino }
        : { type: "link", ino: node.ino, target: to },
    );
    this.nodes.quiet = false;
    this.touch(target);
  }
  readonly calls: [Operation, string][] = [];
  /** Runs before the n-th call (from 1) of an operation. */
  readonly hooks = new Map<string, () => void>();
  closes = 0;
  opens = 0;
  failWith = new Map<string, string>();
  /** Overrides what the open file's `fstat` gives. */
  handleStat: ((stat: ToolFileStat) => ToolFileStat) | null = null;
  readCount: ((wanted: number) => number) | null = null;
  /** The device of a canonical path; 1 for every other. */
  readonly devs = new Map<string, bigint>();
  /** Runs before every call, after the hook of its n-th call. */
  beforeEach: ((operation: Operation, target: string) => void) | null = null;
  /**
   * Whether an open file names its real path, as `/proc/self/fd` does on
   * Linux; and an error code that naming it fails with.
   */
  namesOpenFile = false;
  openFileNameError: string | null = null;
  private nextIno = 2n;
  private counts = new Map<Operation, number>();

  dir(target: string): this {
    this.nodes.set(target, { type: "dir", ino: this.ino() });
    this.touch(target);
    return this;
  }

  file(target: string, content: string | Uint8Array, nlink = 1n): this {
    this.nodes.set(target, {
      type: "file",
      ino: this.ino(),
      content:
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content,
      nlink,
    });
    this.touch(target);
    return this;
  }

  link(target: string, to: string): this {
    this.nodes.set(target, { type: "link", ino: this.ino(), target: to });
    this.touch(target);
    return this;
  }

  fifo(target: string): this {
    this.nodes.set(target, { type: "fifo", ino: this.ino() });
    this.touch(target);
    return this;
  }

  /**
   * Moves a node and everything under it: the change times of the two
   * parents move, not those of the folders that move with it.
   */
  move(from: string, to: string): void {
    this.nodes.quiet = true;
    for (const [key, node] of [...this.nodes]) {
      if (key === from || key.startsWith(`${from}/`)) {
        this.nodes.delete(key);
        this.nodes.set(to + key.slice(from.length), node);
      }
    }
    this.nodes.quiet = false;
    for (const parent of [parentOf(from), parentOf(to)]) {
      if (parent !== null) {
        this.touch(parent);
      }
    }
  }

  on(operation: Operation, nth: number, hook: () => void): void {
    this.hooks.set(`${operation}:${nth}`, hook);
  }

  private ino(): bigint {
    this.nextIno += 1n;
    return this.nextIno;
  }

  private enter(operation: Operation, target: string): void {
    const count = (this.counts.get(operation) ?? 0) + 1;
    this.counts.set(operation, count);
    this.calls.push([operation, target]);
    this.hooks.get(`${operation}:${count}`)?.();
    this.beforeEach?.(operation, target);
    const code = this.failWith.get(`${operation}:${target}`);
    if (code !== undefined) {
      throw fsError(code);
    }
  }

  /** The canonical path, following links; the last one only with `follow`. */
  private resolve(target: string, follow: boolean, depth = 0): string {
    if (depth > 40) {
      throw fsError("ELOOP");
    }
    const parts = target.split("/").filter((part) => part !== "");
    let current = "/";
    for (const [index, part] of parts.entries()) {
      const next = current === "/" ? `/${part}` : `${current}/${part}`;
      const node = this.nodes.get(next);
      if (node === undefined) {
        throw fsError("ENOENT");
      }
      const last = index === parts.length - 1;
      if (node.type === "link" && (!last || follow)) {
        current = this.resolve(node.target, true, depth + 1);
        continue;
      }
      if (!last && node.type !== "dir") {
        throw fsError("ENOTDIR");
      }
      current = next;
    }
    return current;
  }

  /** The identity of a folder as a link records it, without a call. */
  identity(target: string): { dev: string; ino: string } {
    const real = this.resolve(target, true);
    const node = this.nodes.get(real);
    if (node === undefined) {
      throw fsError("ENOENT");
    }
    const stat = this.statOf(node, real);
    return { dev: String(stat.dev), ino: String(stat.ino) };
  }

  private statOf(node: Node, at: string): ToolFileStat {
    const kind: ToolFileKind =
      node.type === "dir"
        ? "directory"
        : node.type === "file"
          ? "file"
          : node.type === "link"
            ? "link"
            : "other";
    return {
      kind,
      dev: this.devs.get(at) ?? 1n,
      ino: node.ino,
      nlink: node.type === "file" ? node.nlink : 1n,
      size: node.type === "file" ? BigInt(node.content.length) : 0n,
      ctime: this.noChangeTimes
        ? 0n
        : (this.ctimes.get(node.ino) ?? this.origin),
    };
  }

  async realpath(target: string): Promise<string> {
    this.enter("realpath", target);
    return this.resolve(target, true);
  }

  async lstat(target: string): Promise<ToolFileStat> {
    this.enter("lstat", target);
    const real = this.resolve(target, false);
    const node = this.nodes.get(real);
    if (node === undefined) {
      throw fsError("ENOENT");
    }
    return this.statOf(node, real);
  }

  async open(target: string): Promise<ToolFileHandle> {
    this.enter("open", target);
    const real = this.resolve(target, true);
    const node = this.nodes.get(real);
    if (node === undefined || node.type === "dir") {
      throw fsError("EISDIR");
    }
    this.opens += 1;
    return {
      stat: async () => {
        const stat = this.statOf(node, real);
        return this.handleStat === null ? stat : this.handleStat(stat);
      },
      realPath: async () => {
        if (this.openFileNameError !== null) {
          throw fsError(this.openFileNameError);
        }
        return this.namesOpenFile ? real : undefined;
      },
      read: async (buffer, position) => {
        this.enter("read", target);
        const content = node.type === "file" ? node.content : new Uint8Array();
        const wanted = Math.min(buffer.length, content.length - position);
        const count = this.readCount === null ? wanted : this.readCount(wanted);
        if (wanted > 0) {
          buffer.set(
            content.subarray(
              position,
              position + Math.max(0, Math.min(count, wanted)),
            ),
          );
        }
        return count;
      },
      close: async () => {
        this.closes += 1;
      },
    };
  }

  async readdir(target: string, limit: number) {
    this.enter("readdir", target);
    const real = this.resolve(target, true);
    const prefix = real === "/" ? "/" : `${real}/`;
    const all = [...this.nodes]
      .filter(
        ([key]) =>
          key !== real &&
          key.startsWith(prefix) &&
          !key.slice(prefix.length).includes("/"),
      )
      .map(([key, node]) => ({
        name: key.slice(prefix.length),
        kind: this.statOf(node, key).kind,
      }));
    return { entries: all.slice(0, limit), more: all.length > limit };
  }
}

const ROOT = "/work/repo";

/** A repository with a Git folder, hidden files, and a folder beside it. */
function repository(): FakeFiles {
  return new FakeFiles()
    .dir("/work")
    .dir(ROOT)
    .dir(`${ROOT}/.git`)
    .file(`${ROOT}/.git/config`, "[core]")
    .file(`${ROOT}/.env`, "TOKEN=secret")
    .dir(`${ROOT}/src`)
    .file(`${ROOT}/src/index.ts`, "export const a = 1;\n")
    .file(`${ROOT}/README.md`, "# Repo\n")
    .dir("/work/outside")
    .file("/work/outside/secret.txt", "outside secret")
    .file("/work/outside/index.ts", "outside index");
}

/** The fake file system of each tool, which records the folder's identity. */
const fakeOf = new WeakMap<Tool, FakeFiles>();

function toolsOf(files: ReadToolFileSystem, fake?: FakeFiles) {
  const recorder = fake ?? (files instanceof FakeFiles ? files : undefined);
  const tools = createReadTools({
    files,
    pathApi: path.posix,
    ...(recorder === undefined
      ? {}
      : {
          now: () => recorder.now,
          sleep: async (ms: number) => {
            recorder.sleeps.push(ms);
            recorder.now += ms;
            recorder.onSleep?.();
          },
        }),
  });
  if (recorder !== undefined) {
    for (const tool of tools) {
      fakeOf.set(tool, recorder);
    }
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools,
    list: byName.get(READ_TOOL_NAMES.listDirectory) as Tool,
    read: byName.get(READ_TOOL_NAMES.readFile) as Tool,
  };
}

type Identity = { dev: string; ino: string };

/**
 * Runs a tool as the dispatcher does. The folder's identity is the one that
 * a link records: read when the tool is run, before any change of a test.
 */
async function runTool(
  tool: Tool,
  input: unknown,
  options: {
    folder?: string;
    signal?: AbortSignal;
    identity?: Identity;
  } = {},
): Promise<ToolRunOutcome> {
  const parsed = tool.parse(input);
  if (!parsed.ok) {
    throw new Error("invalid input");
  }
  const folder = options.folder ?? ROOT;
  const fake = fakeOf.get(tool);
  if (options.identity === undefined && fake === undefined) {
    throw new Error("no identity");
  }
  if (fake?.settleBeforeRun === true) {
    fake.now += 10_000;
  }
  return parsed.run({
    folder,
    folderIdentity: options.identity ?? (fake as FakeFiles).identity(folder),
    signal: options.signal ?? new AbortController().signal,
  });
}

/**
 * Makes `${ROOT}/src` itself (its node, with its file number) or a link to
 * the folder outside, which holds an `index.ts` as `src` does.
 */
function srcAs(files: FakeFiles, state: "folder" | "link"): void {
  const node = files.nodes.get(`${ROOT}/src`);
  if (state === "link" && node?.type === "dir") {
    files.move(`${ROOT}/src`, `${ROOT}/src-held`);
    files.link(`${ROOT}/src`, "/work/outside");
  } else if (state === "folder" && node?.type === "link") {
    files.nodes.delete(`${ROOT}/src`);
    files.move(`${ROOT}/src-held`, `${ROOT}/src`);
  }
}

function refusal(reason: string) {
  return { ok: false, code: "path_refused", reason };
}

test("the read tools need repo.read and take { path } only", () => {
  const { tools } = toolsOf(repository());
  expect(tools.map((tool) => [tool.name, tool.capability])).toEqual([
    ["list_directory", "repo.read"],
    ["read_file", "repo.read"],
  ]);
  for (const tool of tools) {
    expect(tool.parse({ path: "." }).ok).toBe(true);
    for (const input of [{}, { path: 1 }, { path: ".", extra: 1 }, null, "."]) {
      expect(tool.parse(input).ok).toBe(false);
    }
  }
});

test("the path of a call's record is the path when it passes the lexical rules, and null otherwise, so never absolute", () => {
  const { tools } = toolsOf(repository());
  for (const tool of tools) {
    const pathOf = (value: string) => {
      const parsed = tool.parse({ path: value });
      return parsed.ok ? parsed.path : "invalid";
    };
    for (const taken of [".", "src", "src/index.ts", "docs/read me.md"]) {
      expect(pathOf(taken), taken).toBe(taken);
    }
    for (const refused of [
      ROOT,
      `${ROOT}/src/index.ts`,
      "/etc/passwd",
      "C:\\Users\\person\\repository",
      "C:/Users/person/repository",
      "\\\\server\\share",
      "../outside",
      "src/../..",
      ".git/config",
      ".env",
      "",
    ]) {
      expect(pathOf(refused), refused).toBeNull();
    }
  }
});

test("read_file answers a text file with its relative path, size, and content", async () => {
  const { read } = toolsOf(repository());
  expect(await runTool(read, { path: "src/index.ts" })).toEqual({
    ok: true,
    result: {
      path: "src/index.ts",
      size: 20,
      truncated: false,
      binary: false,
      content: "export const a = 1;\n",
    },
  });
});

test("list_directory answers the names sorted, with their kinds, and leaves out .git, hidden names, and names a path could not name", async () => {
  const files = repository()
    .link(`${ROOT}/zz-link`, `${ROOT}/src`)
    .fifo(`${ROOT}/pipe`)
    .file(`${ROOT}/nul.txt`, "")
    .file(`${ROOT}/a:b`, "")
    .file(`${ROOT}/back\\slash`, "")
    .file(`${ROOT}/end.`, "");
  const { list } = toolsOf(files);
  expect(await runTool(list, { path: "." })).toEqual({
    ok: true,
    result: {
      path: ".",
      entries: [
        { name: "README.md", kind: "file" },
        { name: "pipe", kind: "other" },
        { name: "src", kind: "directory" },
        { name: "zz-link", kind: "link" },
      ],
      omitted: 6,
      truncated: false,
    },
  });
  expect(await runTool(list, { path: "src" })).toMatchObject({
    ok: true,
    result: { path: "src", entries: [{ name: "index.ts", kind: "file" }] },
  });
});

test("a refused path touches no file", async () => {
  const files = repository();
  const { list, read } = toolsOf(files);
  for (const [value, reason] of [
    ["/etc/passwd", "absolute"],
    ["//server/share/file", "unc"],
    ["C:/Windows/win.ini", "drive"],
    ["..\\outside", "backslash"],
    ["../outside/secret.txt", "dot_dot"],
    ["src/../../outside/secret.txt", "dot_dot"],
    ["src/index.ts\u0000.png", "nul"],
    ["src/index.ts:stream", "stream"],
    ["con", "device_name"],
    [".git/config", "git"],
    [".GIT/config", "git"],
    [".git", "git"],
    [".git./config", "trailing_dot_space"],
    [".env", "hidden"],
  ] as const) {
    for (const tool of [list, read]) {
      expect(await runTool(tool, { path: value }), value).toEqual(
        refusal(reason),
      );
    }
  }
  expect(files.calls).toEqual([]);
});

test("a path through a link that leaves the repository is refused as outside", async () => {
  const files = repository()
    .link(`${ROOT}/linked`, "/work/outside")
    .link(`${ROOT}/secret-link.txt`, "/work/outside/secret.txt")
    .link(`${ROOT}/up`, "/work");
  const { list, read } = toolsOf(files);
  expect(await runTool(read, { path: "linked/secret.txt" })).toEqual(
    refusal("outside"),
  );
  expect(await runTool(read, { path: "secret-link.txt" })).toEqual(
    refusal("outside"),
  );
  expect(await runTool(list, { path: "linked" })).toEqual(refusal("outside"));
  expect(await runTool(list, { path: "up" })).toEqual(refusal("outside"));
  expect(files.opens).toBe(0);
});

test("a path through a link that stays inside is refused as an alias, and so is a link to the Git folder", async () => {
  const files = repository()
    .link(`${ROOT}/alias`, `${ROOT}/src`)
    .link(`${ROOT}/index-link.ts`, `${ROOT}/src/index.ts`)
    .link(`${ROOT}/git-link`, `${ROOT}/.git`)
    .link(`${ROOT}/self`, ROOT);
  const { list, read } = toolsOf(files);
  expect(await runTool(read, { path: "alias/index.ts" })).toEqual(
    refusal("alias"),
  );
  expect(await runTool(read, { path: "index-link.ts" })).toEqual(
    refusal("alias"),
  );
  expect(await runTool(read, { path: "git-link/config" })).toEqual(
    refusal("alias"),
  );
  expect(await runTool(list, { path: "git-link" })).toEqual(refusal("alias"));
  expect(await runTool(list, { path: "self" })).toEqual(refusal("alias"));
  expect(files.opens).toBe(0);
});

test("a repository folder reached through a link is used by its real path", async () => {
  const files = repository().link("/linked-work", "/work");
  const { read } = toolsOf(files);
  expect(
    await runTool(read, { path: "README.md" }, { folder: "/linked-work/repo" }),
  ).toMatchObject({ ok: true, result: { content: "# Repo\n" } });
});

test("missing paths, other kinds, and failures of the file system answer closed codes", async () => {
  const files = repository().fifo(`${ROOT}/pipe`);
  const { list, read } = toolsOf(files);
  expect(await runTool(read, { path: "missing.ts" })).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await runTool(read, { path: "README.md/x" })).toEqual({
    ok: false,
    code: "not_found",
  });
  expect(await runTool(read, { path: "src" })).toEqual({
    ok: false,
    code: "not_a_file",
  });
  expect(await runTool(read, { path: "." })).toEqual({
    ok: false,
    code: "not_a_file",
  });
  expect(await runTool(read, { path: "pipe" })).toEqual({
    ok: false,
    code: "not_a_file",
  });
  expect(await runTool(list, { path: "README.md" })).toEqual({
    ok: false,
    code: "not_a_directory",
  });
  files.failWith.set(`realpath:${ROOT}/src/index.ts`, "EACCES");
  expect(await runTool(read, { path: "src/index.ts" })).toEqual({
    ok: false,
    code: "read_failed",
  });
  files.failWith.set(`realpath:${ROOT}`, "EACCES");
  expect(await runTool(list, { path: "." })).toEqual({
    ok: false,
    code: "read_failed",
  });
  expect(files.opens).toBe(0);
});

test("a file with another hard link is refused, at the lstat and at the open", async () => {
  const files = repository().file(`${ROOT}/hard.txt`, "linked", 2n);
  const { read } = toolsOf(files);
  expect(await runTool(read, { path: "hard.txt" })).toEqual(
    refusal("hard_link"),
  );
  expect(files.opens).toBe(0);
  // A second link made between the lstat and the open.
  files.handleStat = (stat) => ({ ...stat, nlink: 2n });
  expect(await runTool(read, { path: "README.md" })).toEqual(
    refusal("hard_link"),
  );
  expect(files.closes).toBe(1);
});

test("TOCTOU: a file swapped for a link to a file outside between the check and the open is refused, and nothing of it is answered", async () => {
  const files = repository();
  const { read } = toolsOf(files);
  files.on("open", 1, () => {
    files.nodes.delete(`${ROOT}/README.md`);
    files.link(`${ROOT}/README.md`, "/work/outside/secret.txt");
  });
  const answer = await runTool(read, { path: "README.md" });
  expect(answer).toEqual(refusal("changed"));
  expect(JSON.stringify(answer)).not.toContain("outside secret");
  expect(files.closes).toBe(1);
});

// The calls of `read_file` on `src/index.ts`, in order: lstat 1 of the
// repository's folder, realpath 1 of it, lstat 2 of its real path, realpath
// 2 of the path, lstat 3 of `src`, lstat 4 of the path, the open, then
// realpath 3, lstat 5 and 6 of the folders, lstat 7 of the path, lstat 8 and
// 9 of the folders, and realpath 4.

test("TOCTOU: a folder swapped for a link to a folder outside between the resolution and the lstat is refused by the resolution after the open", async () => {
  const files = repository();
  const { read } = toolsOf(files);
  // After the resolution and the check of the folders, before the lstat.
  files.on("lstat", 4, () => {
    files.move(`${ROOT}/src`, `${ROOT}/src-old`);
    files.link(`${ROOT}/src`, "/work/outside");
  });
  const answer = await runTool(read, { path: "src/index.ts" });
  expect(answer).toEqual(refusal("changed"));
  expect(JSON.stringify(answer)).not.toContain("outside index");
  expect(files.closes).toBe(1);
});

test("TOCTOU: a folder swapped to a link outside for the open and back after it is refused by the lstat after the open", async () => {
  const files = repository();
  const { read } = toolsOf(files);
  files.on("lstat", 4, () => {
    files.move(`${ROOT}/src`, `${ROOT}/src-old`);
    files.link(`${ROOT}/src`, "/work/outside");
  });
  // Back once the file is open, before the checks after the open.
  files.on("realpath", 3, () => {
    files.nodes.delete(`${ROOT}/src`);
    files.move(`${ROOT}/src-old`, `${ROOT}/src`);
  });
  const answer = await runTool(read, { path: "src/index.ts" });
  expect(answer).toEqual(refusal("changed"));
  expect(JSON.stringify(answer)).not.toContain("outside index");
});

test("TOCTOU: a file replaced by another file between the lstat and the open is refused", async () => {
  const files = repository();
  const { read } = toolsOf(files);
  files.on("open", 1, () => {
    files.file(`${ROOT}/README.md`, "replaced");
  });
  expect(await runTool(read, { path: "README.md" })).toEqual(
    refusal("changed"),
  );
});

test("TOCTOU: a folder swapped for a link while it is listed is refused", async () => {
  const files = repository();
  const { list } = toolsOf(files);
  files.on("readdir", 1, () => {
    files.move(`${ROOT}/src`, `${ROOT}/src-old`);
    files.link(`${ROOT}/src`, "/work/outside");
  });
  const answer = await runTool(list, { path: "src" });
  expect(answer).toEqual(refusal("changed"));
  expect(JSON.stringify(answer)).not.toContain("secret.txt");
});

test("TOCTOU (review schedule): a folder on the path that is a folder at every realpath and a link outside at every lstat and open is refused, and nothing outside is answered", async () => {
  const files = repository().file("/work/outside/index.ts", "SECRET");
  const { read } = toolsOf(files);
  files.beforeEach = (operation) => {
    if (operation === "realpath") {
      srcAs(files, "folder");
    } else if (operation === "lstat" || operation === "open") {
      srcAs(files, "link");
    }
  };
  const answer = await runTool(read, { path: "src/index.ts" });
  expect(answer).toEqual(refusal("changed"));
  expect(JSON.stringify(answer)).not.toContain("SECRET");
  expect(files.opens).toBe(0);
});

test("TOCTOU: a folder on the path that is a link only at its check in the resolution is refused before any open", async () => {
  const files = repository().file("/work/outside/index.ts", "SECRET");
  const { read } = toolsOf(files);
  let checks = 0;
  files.beforeEach = (operation, target) => {
    if (operation === "realpath") {
      srcAs(files, "folder");
    } else if (operation === "lstat" && target === `${ROOT}/src`) {
      checks += 1;
      srcAs(files, checks === 1 ? "link" : "folder");
    } else if (operation === "lstat" || operation === "open") {
      srcAs(files, "link");
    }
  };
  const answer = await runTool(read, { path: "src/index.ts" });
  expect(answer).toEqual(refusal("changed"));
  expect(files.opens).toBe(0);
});

test("TOCTOU: a folder on the path that is a folder at its first checks and a link at every lstat and open after them is refused by a check of the folders after the open", async () => {
  // A folder at the resolution only; then also at the first check after the
  // open, so that only the check after the file's lstat sees the link.
  for (const folderChecks of [1, 2]) {
    const files = repository().file("/work/outside/index.ts", "SECRET");
    const { read } = toolsOf(files);
    let checks = 0;
    files.beforeEach = (operation, target) => {
      if (operation === "realpath") {
        srcAs(files, "folder");
      } else if (operation === "lstat" && target === `${ROOT}/src`) {
        checks += 1;
        srcAs(files, checks <= folderChecks ? "folder" : "link");
      } else if (
        (operation === "lstat" && target !== ROOT) ||
        operation === "open"
      ) {
        // Not at the repository's folder's own `lstat`: a swap right before
        // the first one would make the call wait for its change time first.
        srcAs(files, "link");
      }
    };
    const answer = await runTool(read, { path: "src/index.ts" });
    expect(answer, String(folderChecks)).toEqual(refusal("changed"));
    expect(JSON.stringify(answer)).not.toContain("SECRET");
    expect(files.closes).toBe(1);
  }
});

test("TOCTOU: a folder on the path that is a link for the file's calls and for the last realpath is refused by that realpath", async () => {
  const files = repository().file("/work/outside/index.ts", "SECRET");
  const { read } = toolsOf(files);
  let resolutions = 0;
  files.beforeEach = (operation, target) => {
    if (operation === "realpath") {
      resolutions += 1;
      srcAs(files, resolutions <= 3 ? "folder" : "link");
    } else if (operation === "lstat" && target === `${ROOT}/src`) {
      srcAs(files, "folder");
    } else if (
      (operation === "lstat" && target !== ROOT) ||
      operation === "open"
    ) {
      // Not at the repository's folder's own `lstat`, as above.
      srcAs(files, "link");
    }
  };
  const answer = await runTool(read, { path: "src/index.ts" });
  expect(answer).toEqual(refusal("changed"));
  expect(JSON.stringify(answer)).not.toContain("SECRET");
  expect(files.closes).toBe(1);
});

/**
 * `src` is a link outside exactly for the `lstat` calls of the file and its
 * open, and itself for every other call: no check by path sees it.
 */
function linkOnlyForTheFile(files: FakeFiles): void {
  files.beforeEach = (operation, target) => {
    const forTheFile =
      (operation === "lstat" && target === `${ROOT}/src/index.ts`) ||
      operation === "open";
    srcAs(files, forTheFile ? "link" : "folder");
  };
}

test("TOCTOU: where the system names the open file (/proc/self/fd on Linux), a folder that is a link exactly for the file's lstat and open is refused", async () => {
  const files = repository().file("/work/outside/index.ts", "SECRET");
  files.namesOpenFile = true;
  linkOnlyForTheFile(files);
  const { read } = toolsOf(files);
  const answer = await runTool(read, { path: "src/index.ts" });
  expect(answer).toEqual(refusal("changed"));
  expect(JSON.stringify(answer)).not.toContain("SECRET");
  expect(files.closes).toBe(1);
  // A name of the open file that cannot be read refuses as well.
  const failing = repository();
  failing.openFileNameError = "ENOENT";
  expect(await runTool(toolsOf(failing).read, { path: "README.md" })).toEqual(
    refusal("changed"),
  );
  // The checked path itself passes.
  const plain = repository();
  plain.namesOpenFile = true;
  expect(await runTool(toolsOf(plain).read, { path: "src/index.ts" })).toEqual(
    expect.objectContaining({ ok: true }),
  );
});

test("TOCTOU (the former known limit): where the system cannot name the open file, a folder that is a link exactly for the file's lstat and open moves its parent's change time, and the call is refused after three attempts", async () => {
  const files = repository().file("/work/outside/index.ts", "SECRET");
  linkOnlyForTheFile(files);
  const { read } = toolsOf(files);
  const answer = await runTool(read, { path: "src/index.ts" });
  expect(answer).toEqual(refusal("unsettled"));
  expect(JSON.stringify(answer)).not.toContain("SECRET");
  // The first attempt saw the change time move after the open; the second
  // waited for it to settle, without an open; the third saw it move again.
  expect(files.opens).toBe(2);
  expect(files.closes).toBe(2);
  expect(files.sleeps).toEqual([101]);
});

test("TOCTOU: a swap at each step of read_file: before the open, between the open and the checks after it, and during the read after them", async () => {
  // Before the open: `src` is a link for the open only. The open file is
  // not the file that the `lstat` before it saw.
  const before = repository().file("/work/outside/index.ts", "SECRET");
  before.beforeEach = (operation) => {
    srcAs(before, operation === "open" ? "link" : "folder");
  };
  const first = await runTool(toolsOf(before).read, { path: "src/index.ts" });
  expect(first).toEqual(refusal("changed"));
  expect(JSON.stringify(first)).not.toContain("SECRET");

  // Between the open and the checks after it: a link for the open and for
  // the file's `lstat` calls, which then see the open file; only the
  // change time of `src`'s parent shows the swap.
  const between = repository().file("/work/outside/index.ts", "SECRET");
  linkOnlyForTheFile(between);
  const second = await runTool(toolsOf(between).read, { path: "src/index.ts" });
  expect(second).toEqual(refusal("unsettled"));
  expect(JSON.stringify(second)).not.toContain("SECRET");

  // During the read, after the checks: the content comes from the open file,
  // which the checks tied to the path, so nothing outside is read.
  const during = repository().file("/work/outside/index.ts", "SECRET");
  during.on("read", 1, () => srcAs(during, "link"));
  expect(
    await runTool(toolsOf(during).read, { path: "src/index.ts" }),
  ).toMatchObject({ ok: true, result: { content: "export const a = 1;\n" } });
});

test("TOCTOU: a change in the same step of the clock as the call is not trusted: the call waits until the change time is settled", async () => {
  // `src` was swapped and back in the step of the clock in which the call
  // starts, so the swaps during the call give its parent the same change
  // time. Only the wait for a settled change time shows them.
  const files = repository().file("/work/outside/index.ts", "SECRET");
  files.settleBeforeRun = false;
  files.now += 10_000;
  srcAs(files, "link");
  srcAs(files, "folder");
  linkOnlyForTheFile(files);
  const { read } = toolsOf(files);
  const answer = await runTool(read, { path: "src/index.ts" });
  expect(answer).toEqual(refusal("unsettled"));
  expect(JSON.stringify(answer)).not.toContain("SECRET");
  expect(files.sleeps[0]).toBe(101);

  // A folder that changed just before the call, and not since: the call
  // waits once and answers.
  const changed = repository();
  changed.settleBeforeRun = false;
  changed.now += 10_000;
  changed.file(`${ROOT}/src/new.ts`, "new");
  expect(
    await runTool(toolsOf(changed).read, { path: "src/index.ts" }),
  ).toMatchObject({ ok: true, result: { content: "export const a = 1;\n" } });
  expect(changed.sleeps).toEqual([101]);
});

test("TOCTOU: a change time on a whole second, as HFS+ stamps them, must be two seconds old", async () => {
  // The last change and the swaps during the call fall in the same second:
  // with stamps of whole seconds they give the same change time.
  const files = repository().file("/work/outside/index.ts", "SECRET");
  files.stepMs = 1_000;
  files.settleBeforeRun = false;
  files.now += 10_000 + 200;
  srcAs(files, "link");
  srcAs(files, "folder");
  files.now += 300;
  linkOnlyForTheFile(files);
  const { read } = toolsOf(files);
  const answer = await runTool(read, { path: "src/index.ts" });
  expect(answer).toEqual(refusal("unsettled"));
  expect(JSON.stringify(answer)).not.toContain("SECRET");
  // Two seconds from the stamp, 500 ms of which have passed.
  expect(files.sleeps[0]).toBe(1_501);
});

test("TOCTOU: a change time must be older than the margin, not only older than the call, since the clock that stamps it moves in steps", async () => {
  // Stamps in steps of 16 ms, as NTFS with the default tick of Windows. The
  // last change and the swaps during the call fall in the same step, 12 ms
  // after the last change: they give the same change time.
  const files = repository().file("/work/outside/index.ts", "SECRET");
  files.stepMs = 16;
  files.settleBeforeRun = false;
  files.now += 10_000 + 50;
  srcAs(files, "link");
  srcAs(files, "folder");
  files.now += 12;
  linkOnlyForTheFile(files);
  const answer = await runTool(toolsOf(files).read, { path: "src/index.ts" });
  expect(answer).toEqual(refusal("unsettled"));
  expect(JSON.stringify(answer)).not.toContain("SECRET");
  // 100 ms from the stamp, at the start of its step 2 ms before the last
  // change, of which 14 ms have passed.
  expect(files.sleeps[0]).toBe(87);
});

test("a change time exactly the margin older than the call is not settled; one millisecond older is", async () => {
  // Stamps on whole milliseconds, not on a whole second, so the margin is
  // 100 ms. `src` changes 10,050 ms after the clock's start.
  const exact = repository();
  exact.stepMs = 1;
  exact.settleBeforeRun = false;
  exact.now += 10_050;
  exact.file(`${ROOT}/src/new.ts`, "new");
  // The call starts exactly 100 ms after the change: not older by more than
  // the margin, so it waits the one nanosecond left, rounded up to 1 ms.
  exact.now += 100;
  expect(
    await runTool(toolsOf(exact).read, { path: "src/index.ts" }),
  ).toMatchObject({ ok: true, result: { content: "export const a = 1;\n" } });
  expect(exact.sleeps).toEqual([1]);
  expect(exact.opens).toBe(1);

  // One millisecond later, the change time is settled at once.
  const later = repository();
  later.stepMs = 1;
  later.settleBeforeRun = false;
  later.now += 10_050;
  later.file(`${ROOT}/src/new.ts`, "new");
  later.now += 101;
  expect(
    await runTool(toolsOf(later).read, { path: "src/index.ts" }),
  ).toMatchObject({ ok: true, result: { content: "export const a = 1;\n" } });
  expect(later.sleeps).toEqual([]);
});

test("a folder that keeps changing is refused after three attempts, with a bounded wait before each new one", async () => {
  // Another process adds a file to `src` at every open.
  const busy = repository();
  let added = 0;
  busy.beforeEach = (operation) => {
    if (operation === "open") {
      added += 1;
      busy.file(`${ROOT}/src/tmp-${added}.txt`, "");
    }
  };
  expect(await runTool(toolsOf(busy).read, { path: "src/index.ts" })).toEqual(
    refusal("unsettled"),
  );
  expect(busy.sleeps).toEqual([101]);
  expect(busy.closes).toBe(2);

  // A change time ahead of the clock (a clock set back by an hour) is
  // waited for at most 2.1 s at a time.
  const ahead = repository();
  ahead.settleBeforeRun = false;
  ahead.now -= 3_600_000;
  const { list, read } = toolsOf(ahead);
  expect(await runTool(read, { path: "README.md" })).toEqual(
    refusal("unsettled"),
  );
  expect(await runTool(list, { path: "." })).toEqual(refusal("unsettled"));
  expect(ahead.sleeps).toEqual([2_100, 2_100, 2_100, 2_100]);
  expect(ahead.opens).toBe(0);
  expect(ahead.calls.filter(([operation]) => operation === "readdir")).toEqual(
    [],
  );
});

test("a clock set back during a call makes it start again before it answers", async () => {
  const once = repository();
  once.on("open", 1, () => {
    once.now -= 1_000;
  });
  expect(
    await runTool(toolsOf(once).read, { path: "README.md" }),
  ).toMatchObject({ ok: true, result: { content: "# Repo\n" } });
  expect(once.opens).toBe(2);

  const always = repository();
  always.beforeEach = (operation) => {
    if (operation === "readdir") {
      always.now -= 1_000;
    }
  };
  expect(await runTool(toolsOf(always).list, { path: "." })).toEqual(
    refusal("unsettled"),
  );
});

test("an abort during a wait for settled change times answers aborted", async () => {
  const files = repository();
  files.settleBeforeRun = false;
  const controller = new AbortController();
  files.onSleep = () => controller.abort();
  const { read, list } = toolsOf(files);
  expect(
    await runTool(read, { path: "README.md" }, { signal: controller.signal }),
  ).toEqual({ ok: false, code: "aborted" });
  expect(files.opens).toBe(0);
  expect(
    await runTool(list, { path: "." }, { signal: controller.signal }),
  ).toEqual({ ok: false, code: "aborted" });
  expect(files.sleeps).toEqual([101]);
});

test("an abort during the last attempt, which then sees a change time move, answers aborted, not unsettled", async () => {
  // Another process adds a file to `src` at every open; the abort comes
  // with the change of the last attempt. The first attempt opens and sees
  // the change, the second waits for it to settle, and the third opens,
  // sees the change, and was aborted.
  const reading = repository();
  const readAbort = new AbortController();
  let opens = 0;
  reading.beforeEach = (operation) => {
    if (operation === "open") {
      opens += 1;
      reading.file(`${ROOT}/src/tmp-${opens}.txt`, "");
      if (opens === 2) {
        readAbort.abort();
      }
    }
  };
  expect(
    await runTool(
      toolsOf(reading).read,
      { path: "src/index.ts" },
      { signal: readAbort.signal },
    ),
  ).toEqual({ ok: false, code: "aborted" });
  expect(reading.opens).toBe(2);
  expect(reading.closes).toBe(2);
  expect(reading.sleeps).toEqual([101]);

  // The same for a listing: a file is added to the listed folder at every
  // listing.
  const listing = repository();
  const listAbort = new AbortController();
  let listings = 0;
  listing.beforeEach = (operation) => {
    if (operation === "readdir") {
      listings += 1;
      listing.file(`${ROOT}/tmp-${listings}.txt`, "");
      if (listings === 2) {
        listAbort.abort();
      }
    }
  };
  expect(
    await runTool(
      toolsOf(listing).list,
      { path: "." },
      { signal: listAbort.signal },
    ),
  ).toEqual({ ok: false, code: "aborted" });
  expect(listings).toBe(2);
  expect(listing.sleeps).toEqual([101]);
});

test("the wait of the system tools ends at once on an abort", async () => {
  // Change times an hour ahead of the clock make every attempt wait 2.1 s
  // with the default timer, unless the abort ends the wait.
  const files = repository();
  const tools = createReadTools({
    files,
    pathApi: path.posix,
    now: () => files.now - 3_600_000,
  });
  const read = tools.find(
    (tool) => tool.name === READ_TOOL_NAMES.readFile,
  ) as Tool;
  const parsed = read.parse({ path: "README.md" });
  if (!parsed.ok) {
    throw new Error("invalid input");
  }
  const run = (signal: AbortSignal) =>
    parsed.run({ folder: ROOT, folderIdentity: files.identity(ROOT), signal });

  // Aborted during the first attempt: the wait does not start.
  const early = new AbortController();
  files.on("lstat", 1, () => early.abort());
  let started = performance.now();
  expect(await run(early.signal)).toEqual({ ok: false, code: "aborted" });
  expect(performance.now() - started).toBeLessThan(1_000);

  // Aborted during the wait.
  const during = new AbortController();
  setTimeout(() => during.abort(), 20);
  started = performance.now();
  expect(await run(during.signal)).toEqual({ ok: false, code: "aborted" });
  expect(performance.now() - started).toBeLessThan(1_000);
});

test("a file system without change times is refused (fail closed)", async () => {
  const files = repository();
  files.noChangeTimes = true;
  const { list, read } = toolsOf(files);
  expect(await runTool(list, { path: "." })).toEqual({
    ok: false,
    code: "read_failed",
  });
  expect(await runTool(read, { path: "src/index.ts" })).toEqual({
    ok: false,
    code: "read_failed",
  });
  expect(files.opens).toBe(0);
  expect(files.calls.filter(([operation]) => operation === "readdir")).toEqual(
    [],
  );
});

test("TOCTOU (the former listing window): a folder that is a link exactly for its listing is refused, and no name outside is answered", async () => {
  const files = repository();
  files.beforeEach = (operation) => {
    srcAs(files, operation === "readdir" ? "link" : "folder");
  };
  const { list } = toolsOf(files);
  const answer = await runTool(list, { path: "src" });
  expect(answer).toEqual(refusal("unsettled"));
  expect(JSON.stringify(answer)).not.toContain("secret");
});

test("TOCTOU: an empty folder made a link in place for exactly its listing (a junction on Windows) is refused by its own change time", async () => {
  const files = repository().dir(`${ROOT}/src/empty`);
  const target = `${ROOT}/src/empty`;
  files.beforeEach = (operation) => {
    const node = files.nodes.get(target);
    if (operation === "readdir" && node?.type === "dir") {
      files.convert(target, "/work/outside");
    } else if (operation !== "readdir" && node?.type === "link") {
      files.convert(target, null);
    }
  };
  const { list } = toolsOf(files);
  const answer = await runTool(list, { path: "src/empty" });
  expect(answer).toEqual(refusal("unsettled"));
  expect(JSON.stringify(answer)).not.toContain("secret");

  // Made a link and back in the step of the clock in which the call starts:
  // its own change time must be settled too.
  const recent = repository().dir(`${ROOT}/src/empty`);
  recent.settleBeforeRun = false;
  recent.now += 10_000;
  recent.convert(target, "/work/outside");
  recent.convert(target, null);
  recent.beforeEach = (operation) => {
    const node = recent.nodes.get(target);
    if (operation === "readdir" && node?.type === "dir") {
      recent.convert(target, "/work/outside");
    } else if (operation !== "readdir" && node?.type === "link") {
      recent.convert(target, null);
    }
  };
  const again = await runTool(toolsOf(recent).list, { path: "src/empty" });
  expect(again).toEqual(refusal("unsettled"));
  expect(JSON.stringify(again)).not.toContain("secret");
  expect(recent.sleeps[0]).toBe(101);
});

test("TOCTOU: a folder on the path replaced by another folder during the read is refused, although the file is the same", async () => {
  const files = repository();
  const { read } = toolsOf(files);
  files.on("open", 1, () => {
    // The file moves to a new folder, which takes the old folder's place.
    files.dir(`${ROOT}/next`);
    files.move(`${ROOT}/src/index.ts`, `${ROOT}/next/index.ts`);
    files.move(`${ROOT}/src`, `${ROOT}/src-old`);
    files.move(`${ROOT}/next`, `${ROOT}/src`);
  });
  expect(await runTool(read, { path: "src/index.ts" })).toEqual(
    refusal("changed"),
  );
});

test("TOCTOU: list_directory checks the folders on the path again right before the listing", async () => {
  const files = repository().dir(`${ROOT}/src/sub`);
  const { list } = toolsOf(files);
  let checks = 0;
  files.beforeEach = (operation, target) => {
    if (operation === "lstat" && target === `${ROOT}/src`) {
      checks += 1;
      if (checks === 2) {
        srcAs(files, "link");
      }
    }
  };
  expect(await runTool(list, { path: "src/sub" })).toEqual(refusal("changed"));
  expect(files.calls.filter(([operation]) => operation === "readdir")).toEqual(
    [],
  );
});

test("the repository's folder must still be the folder that the link recorded, and not a link", async () => {
  // Another folder at the same path.
  const replaced = repository();
  const { read } = toolsOf(replaced);
  const recorded = replaced.identity(ROOT);
  replaced.move(ROOT, "/work/repo-old");
  replaced.dir(ROOT).file(`${ROOT}/README.md`, "# Other\n");
  expect(
    await runTool(read, { path: "README.md" }, { identity: recorded }),
  ).toEqual(refusal("changed"));
  expect(replaced.opens).toBe(0);

  // A link to the recorded folder, which moved.
  const moved = repository();
  const movedTools = toolsOf(moved);
  const movedIdentity = moved.identity(ROOT);
  moved.move(ROOT, "/work/moved");
  moved.link(ROOT, "/work/moved");
  expect(
    await runTool(
      movedTools.read,
      { path: "README.md" },
      { identity: movedIdentity },
    ),
  ).toEqual(refusal("changed"));
  expect(moved.opens).toBe(0);

  // Swapped for a link to a folder outside after its lstat, before its
  // realpath.
  const swapped = repository().file("/work/outside/README.md", "SECRET");
  const swappedTools = toolsOf(swapped);
  swapped.on("realpath", 1, () => {
    swapped.move(ROOT, "/work/repo-old");
    swapped.link(ROOT, "/work/outside");
  });
  const answer = await runTool(swappedTools.read, { path: "README.md" });
  expect(answer).toEqual(refusal("changed"));
  expect(JSON.stringify(answer)).not.toContain("SECRET");
  expect(swapped.opens).toBe(0);

  // No identity, or one that is not a pair of decimal numbers.
  const files = repository();
  const tools = toolsOf(files);
  for (const identity of [
    undefined,
    null,
    {},
    { dev: 1, ino: 4 },
    { dev: "1", ino: "-4" },
    { dev: "0x1", ino: "4" },
  ]) {
    const parsed = tools.list.parse({ path: "." });
    if (!parsed.ok) {
      throw new Error("invalid input");
    }
    expect(
      await parsed.run({
        folder: ROOT,
        folderIdentity: identity as unknown as Identity,
        signal: new AbortController().signal,
      }),
      JSON.stringify(identity),
    ).toEqual(refusal("changed"));
  }
  expect(files.calls).toEqual([]);
});

test("a mounted volume or bind mount inside the repository (another device) is refused; its name is still listed", async () => {
  const files = repository()
    .dir(`${ROOT}/mnt`)
    .file(`${ROOT}/mnt/file.txt`, "mounted");
  files.devs.set(`${ROOT}/mnt`, 2n);
  files.devs.set(`${ROOT}/mnt/file.txt`, 2n);
  const { list, read } = toolsOf(files);
  expect(await runTool(read, { path: "mnt/file.txt" })).toEqual(
    refusal("other_device"),
  );
  expect(await runTool(list, { path: "mnt" })).toEqual(refusal("other_device"));
  expect(files.opens).toBe(0);
  expect(files.calls.filter(([operation]) => operation === "readdir")).toEqual(
    [],
  );
  expect(await runTool(list, { path: "." })).toMatchObject({
    ok: true,
    result: {
      entries: expect.arrayContaining([{ name: "mnt", kind: "directory" }]),
    },
  });
});

test("another device is refused at each check: a folder on the path, the file's lstat, and the open file's fstat", async () => {
  // Only the folder reports another device.
  const folder = repository()
    .dir(`${ROOT}/mnt`)
    .file(`${ROOT}/mnt/file.txt`, "mounted");
  folder.devs.set(`${ROOT}/mnt`, 2n);
  expect(await runTool(toolsOf(folder).read, { path: "mnt/file.txt" })).toEqual(
    refusal("other_device"),
  );
  expect(folder.opens).toBe(0);

  // A file bind-mounted into the repository.
  const file = repository();
  file.devs.set(`${ROOT}/src/index.ts`, 2n);
  expect(await runTool(toolsOf(file).read, { path: "src/index.ts" })).toEqual(
    refusal("other_device"),
  );
  expect(file.opens).toBe(0);

  // The open file is on another device.
  const opened = repository();
  opened.handleStat = (stat) => ({ ...stat, dev: 2n });
  expect(await runTool(toolsOf(opened).read, { path: "README.md" })).toEqual(
    refusal("other_device"),
  );
  expect(opened.closes).toBe(1);
});

test("a file of exactly the bound is read whole; a longer one is truncated at the bound with a flag", async () => {
  const limit = READ_TOOL_LIMITS.maxFileBytes;
  const files = repository()
    .file(`${ROOT}/exact.txt`, "a".repeat(limit))
    .file(`${ROOT}/long.txt`, "b".repeat(limit + 10));
  const { read } = toolsOf(files);
  const exact = await runTool(read, { path: "exact.txt" });
  expect(exact).toMatchObject({
    ok: true,
    result: { size: limit, truncated: false, binary: false },
  });
  expect(
    exact.ok && (exact.result as { content: string }).content,
  ).toHaveLength(limit);
  const long = await runTool(read, { path: "long.txt" });
  expect(long).toMatchObject({
    ok: true,
    result: { size: limit + 10, truncated: true, binary: false },
  });
  expect(long.ok && (long.result as { content: string }).content).toBe(
    "b".repeat(limit),
  );
});

test("a character cut by the bound is left out, and the text stays text", async () => {
  const limit = READ_TOOL_LIMITS.maxFileBytes;
  // A two-byte character starts at the last byte of the bound.
  const files = repository().file(
    `${ROOT}/cut.txt`,
    `${"a".repeat(limit - 1)}\u00e9tail`,
  );
  const { read } = toolsOf(files);
  const answer = await runTool(read, { path: "cut.txt" });
  expect(answer).toMatchObject({
    ok: true,
    result: { truncated: true, binary: false },
  });
  expect(answer.ok && (answer.result as { content: string }).content).toBe(
    "a".repeat(limit - 1),
  );
});

test("binary content is flagged and not answered: NUL, or invalid UTF-8", async () => {
  const files = repository()
    .file(`${ROOT}/zero.bin`, new Uint8Array([0x61, 0x00, 0x62]))
    .file(`${ROOT}/latin1.txt`, new Uint8Array([0x63, 0x61, 0x66, 0xe9]))
    .file(`${ROOT}/empty.txt`, new Uint8Array());
  const { read } = toolsOf(files);
  for (const name of ["zero.bin", "latin1.txt"]) {
    expect(await runTool(read, { path: name })).toEqual({
      ok: true,
      result: {
        path: name,
        size: name === "zero.bin" ? 3 : 4,
        truncated: false,
        binary: true,
        content: null,
      },
    });
  }
  expect(await runTool(read, { path: "empty.txt" })).toMatchObject({
    ok: true,
    result: { size: 0, binary: false, content: "" },
  });
});

test("a folder of exactly the bound is listed whole; a larger one is truncated with a flag", async () => {
  const limit = READ_TOOL_LIMITS.maxDirectoryEntries;
  const files = repository().dir(`${ROOT}/exact`).dir(`${ROOT}/many`);
  for (let index = 0; index < limit; index += 1) {
    files.file(`${ROOT}/exact/f${index}`, "");
    files.file(`${ROOT}/many/f${index}`, "");
  }
  for (let index = 0; index < 5; index += 1) {
    files.file(`${ROOT}/many/g${index}`, "");
  }
  const { list } = toolsOf(files);
  const exact = await runTool(list, { path: "exact" });
  expect(exact).toMatchObject({ ok: true, result: { truncated: false } });
  expect(
    exact.ok && (exact.result as { entries: unknown[] }).entries,
  ).toHaveLength(limit);
  const many = await runTool(list, { path: "many" });
  expect(many).toMatchObject({ ok: true, result: { truncated: true } });
  expect(
    many.ok && (many.result as { entries: unknown[] }).entries,
  ).toHaveLength(limit);
});

test("a file system that gives more entries than asked is cut to the bound", async () => {
  const limit = READ_TOOL_LIMITS.maxDirectoryEntries;
  const files = repository();
  const { list } = toolsOf(
    {
      realpath: (target) => files.realpath(target),
      lstat: (target) => files.lstat(target),
      open: (target) => files.open(target),
      readdir: async () => ({
        entries: Array.from({ length: limit + 3 }, (_, index) => ({
          name: `n${index}`,
          kind: "file" as const,
        })),
        more: false,
      }),
    },
    files,
  );
  const answer = await runTool(list, { path: "src" });
  expect(answer).toMatchObject({ ok: true, result: { truncated: true } });
  expect(
    answer.ok && (answer.result as { entries: unknown[] }).entries,
  ).toHaveLength(limit);
});

test("a read count that is not a count fails the read", async () => {
  for (const count of [-1, 1.5, Number.NaN, 1_000_000]) {
    const files = repository();
    files.readCount = () => count;
    const { read } = toolsOf(files);
    expect(await runTool(read, { path: "README.md" }), String(count)).toEqual({
      ok: false,
      code: "read_failed",
    });
    expect(files.closes).toBe(1);
  }
});

test("an abort stops the read between steps and closes the file", async () => {
  const files = repository().file(
    `${ROOT}/long.txt`,
    "c".repeat(READ_TOOL_LIMITS.maxFileBytes),
  );
  const controller = new AbortController();
  // One byte per read; the abort comes during the reads.
  files.readCount = (wanted) => Math.min(wanted, 1);
  files.on("read", 3, () => controller.abort());
  const { read, list } = toolsOf(files);
  expect(
    await runTool(read, { path: "long.txt" }, { signal: controller.signal }),
  ).toEqual({ ok: false, code: "aborted" });
  expect(files.closes).toBe(1);
  expect(
    files.calls.filter(([operation]) => operation === "read"),
  ).toHaveLength(3);

  const aborted = new AbortController();
  aborted.abort();
  expect(
    await runTool(list, { path: "src" }, { signal: aborted.signal }),
  ).toEqual({ ok: false, code: "aborted" });
  expect(files.calls.filter(([operation]) => operation === "readdir")).toEqual(
    [],
  );
});

test("no answer holds the repository's folder or any absolute path", async () => {
  const files = repository().link(`${ROOT}/linked`, "/work/outside");
  files.failWith.set(`realpath:${ROOT}/denied`, "EACCES");
  const { list, read } = toolsOf(files);
  const answers: ToolRunOutcome[] = [];
  for (const value of [
    ".",
    "src",
    "src/index.ts",
    "linked",
    "linked/secret.txt",
    "missing",
    "denied",
    "/work/repo/README.md",
  ]) {
    answers.push(await runTool(list, { path: value }));
    answers.push(await runTool(read, { path: value }));
  }
  const text = JSON.stringify(answers);
  expect(text).not.toContain("/work");
  expect(text).not.toContain("secret");
});
