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
  const tools = createReadTools({ files, pathApi: path.posix });
  const recorder = fake ?? (files instanceof FakeFiles ? files : undefined);
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
      } else if (operation === "lstat" || operation === "open") {
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
    } else if (operation === "lstat" || operation === "open") {
      srcAs(files, "link");
    }
  };
  const answer = await runTool(read, { path: "src/index.ts" });
  expect(answer).toEqual(refusal("changed"));
  expect(JSON.stringify(answer)).not.toContain("SECRET");
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

test("known limit (README): where the system cannot name the open file, a folder that is a link exactly for the file's lstat and open is not seen", async () => {
  // This pins the remaining window that the README describes, so that the
  // change that closes it, before the write and shell tools, updates it.
  const files = repository().file("/work/outside/index.ts", "SECRET");
  linkOnlyForTheFile(files);
  const { read } = toolsOf(files);
  expect(await runTool(read, { path: "src/index.ts" })).toMatchObject({
    ok: true,
    result: { content: "SECRET" },
  });
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
