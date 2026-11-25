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
// checks after the open are what refuse a swap.

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

class FakeFiles implements ReadToolFileSystem {
  readonly nodes = new Map<string, Node>([["/", { type: "dir", ino: 1n }]]);
  readonly calls: [Operation, string][] = [];
  /** Runs before the n-th call (from 1) of an operation. */
  readonly hooks = new Map<string, () => void>();
  closes = 0;
  opens = 0;
  failWith = new Map<string, string>();
  /** Overrides what the open file's `fstat` gives. */
  handleStat: ((stat: ToolFileStat) => ToolFileStat) | null = null;
  readCount: ((wanted: number) => number) | null = null;
  private nextIno = 2n;
  private counts = new Map<Operation, number>();

  dir(target: string): this {
    this.nodes.set(target, { type: "dir", ino: this.ino() });
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
    return this;
  }

  link(target: string, to: string): this {
    this.nodes.set(target, { type: "link", ino: this.ino(), target: to });
    return this;
  }

  fifo(target: string): this {
    this.nodes.set(target, { type: "fifo", ino: this.ino() });
    return this;
  }

  /** Moves a node and everything under it. */
  move(from: string, to: string): void {
    for (const [key, node] of [...this.nodes]) {
      if (key === from || key.startsWith(`${from}/`)) {
        this.nodes.delete(key);
        this.nodes.set(to + key.slice(from.length), node);
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

  private statOf(node: Node): ToolFileStat {
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
      dev: 1n,
      ino: node.ino,
      nlink: node.type === "file" ? node.nlink : 1n,
      size: node.type === "file" ? BigInt(node.content.length) : 0n,
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
    return this.statOf(node);
  }

  async open(target: string): Promise<ToolFileHandle> {
    this.enter("open", target);
    const node = this.nodes.get(this.resolve(target, true));
    if (node === undefined || node.type === "dir") {
      throw fsError("EISDIR");
    }
    this.opens += 1;
    return {
      stat: async () => {
        const stat = this.statOf(node);
        return this.handleStat === null ? stat : this.handleStat(stat);
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
        kind: this.statOf(node).kind,
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

function toolsOf(files: ReadToolFileSystem) {
  const tools = createReadTools({ files, pathApi: path.posix });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools,
    list: byName.get(READ_TOOL_NAMES.listDirectory) as Tool,
    read: byName.get(READ_TOOL_NAMES.readFile) as Tool,
  };
}

async function runTool(
  tool: Tool,
  input: unknown,
  options: { folder?: string; signal?: AbortSignal } = {},
): Promise<ToolRunOutcome> {
  const parsed = tool.parse(input);
  if (!parsed.ok) {
    throw new Error("invalid input");
  }
  return parsed.run({
    folder: options.folder ?? ROOT,
    signal: options.signal ?? new AbortController().signal,
  });
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

test("TOCTOU: a folder swapped for a link to a folder outside between the resolution and the lstat is refused by the resolution after the open", async () => {
  const files = repository();
  const { read } = toolsOf(files);
  // After the two resolutions (the folder and the path), before the lstat.
  files.on("lstat", 1, () => {
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
  files.on("lstat", 1, () => {
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
  const { list } = toolsOf({
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
  });
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
