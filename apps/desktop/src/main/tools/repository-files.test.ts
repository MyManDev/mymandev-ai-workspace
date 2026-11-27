import path from "node:path";
import type {
  MessageId,
  ProjectId,
  RepositoryId,
  WorkspaceId,
} from "@mymandev/protocol";
import { expect, test } from "vitest";
import {
  createRunContextBuilder,
  type RunContextResult,
} from "../agents/run-context.ts";
import type { EnforcementRecord, HeldRun } from "../permissions/enforcement.ts";
import type {
  ReadToolFileSystem,
  ToolFileKind,
  ToolFileStat,
} from "./read-tools.ts";
import {
  createRepositoryWalkLister,
  REPOSITORY_FILE_LIST_LIMITS,
  type RepositoryFileListOutcome,
  SKIPPED_FOLDER_NAMES,
} from "./repository-files.ts";
import {
  MAX_REPOSITORY_PATH_LENGTH,
  parseRepositoryPath,
} from "./repository-path.ts";

// A fake file system with POSIX paths: folders, files, symbolic links, and
// other entries. `realpath` follows links, `lstat` does not, and `readdir`
// lists in the order of creation, as a system may.

type Node =
  | { readonly type: "dir"; readonly ino: bigint }
  | { readonly type: "file"; readonly ino: bigint }
  | { readonly type: "link"; readonly ino: bigint; readonly target: string }
  | { readonly type: "fifo"; readonly ino: bigint };

function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: /work/repo/secret`), { code });
}

class FakeFiles implements ReadToolFileSystem {
  readonly nodes = new Map<string, Node>([["/", { type: "dir", ino: 1n }]]);
  readonly listed: string[] = [];
  /** Runs before each `readdir`, with its folder. */
  beforeReaddir: ((target: string) => void) | null = null;
  /** Runs before each `realpath`, with its path. */
  beforeRealpath: ((target: string) => void) | null = null;
  failReaddir = new Map<string, string>();
  /** Folders whose `readdir` never returns, as on a stalled network share. */
  readonly hangReaddir = new Set<string>();
  readonly devs = new Map<string, bigint>();
  /**
   * Folders that keep changing: their change time moves at every `lstat`.
   * Every other change time is old and never moves.
   */
  readonly busy = new Set<string>();
  private changes = 1n;
  private nextIno = 2n;

  dir(target: string): this {
    this.nodes.set(target, { type: "dir", ino: this.ino() });
    return this;
  }

  file(target: string): this {
    this.nodes.set(target, { type: "file", ino: this.ino() });
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

  remove(target: string): void {
    for (const key of [...this.nodes.keys()]) {
      if (key === target || key.startsWith(`${target}/`)) {
        this.nodes.delete(key);
      }
    }
  }

  private ino(): bigint {
    this.nextIno += 1n;
    return this.nextIno;
  }

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
      nlink: 1n,
      size: 0n,
      ctime: this.busy.has(at) ? (this.changes += 1n) : 1n,
    };
  }

  identity(target: string): { dev: string; ino: string } {
    const real = this.resolve(target, true);
    const stat = this.statOf(this.nodes.get(real) as Node, real);
    return { dev: String(stat.dev), ino: String(stat.ino) };
  }

  async realpath(target: string): Promise<string> {
    this.beforeRealpath?.(target);
    return this.resolve(target, true);
  }

  async lstat(target: string): Promise<ToolFileStat> {
    const real = this.resolve(target, false);
    const node = this.nodes.get(real);
    if (node === undefined) {
      throw fsError("ENOENT");
    }
    return this.statOf(node, real);
  }

  async open(): Promise<never> {
    throw new Error("The walk never opens a file");
  }

  async readdir(target: string, limit: number) {
    this.beforeReaddir?.(target);
    const code = this.failReaddir.get(target);
    if (code !== undefined) {
      throw fsError(code);
    }
    if (this.hangReaddir.has(target)) {
      return new Promise<never>(() => undefined);
    }
    this.listed.push(target);
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

const ROOT = "/home/octocat/secret-web";

function repository(): FakeFiles {
  return new FakeFiles().dir("/home").dir("/home/octocat").dir(ROOT);
}

async function walk(
  files: FakeFiles,
  options: {
    signal?: AbortSignal;
    identity?: { dev: string; ino: string };
  } = {},
): Promise<RepositoryFileListOutcome> {
  const lister = createRepositoryWalkLister({ files, pathApi: path.posix });
  return lister({
    folder: ROOT,
    folderIdentity: options.identity ?? files.identity(ROOT),
    signal: options.signal ?? new AbortController().signal,
  });
}

test("the bounds and the skipped folder names are those of the decision of 2026-11-26", () => {
  expect(REPOSITORY_FILE_LIST_LIMITS).toEqual({
    maxFiles: 1_000,
    maxFolders: 1_000,
    maxDepth: 32,
    deadlineMs: 10_000,
  });
  expect(Object.isFrozen(REPOSITORY_FILE_LIST_LIMITS)).toBe(true);
  expect([...SKIPPED_FOLDER_NAMES].sort()).toEqual([
    "build",
    "dist",
    "node_modules",
    "out",
  ]);
});

test("the walk lists every file, relative and sorted, and skips hidden names, .git, links, other entries, and the skipped folders at any depth", async () => {
  const files = repository()
    .file(`${ROOT}/README.md`)
    .file(`${ROOT}/.env`)
    .dir(`${ROOT}/.git`)
    .file(`${ROOT}/.git/config`)
    .dir(`${ROOT}/.github`)
    .file(`${ROOT}/.github/ci.yml`)
    .dir(`${ROOT}/src`)
    .file(`${ROOT}/src/index.ts`)
    .dir(`${ROOT}/src/lib`)
    .file(`${ROOT}/src/lib/a.ts`)
    .file(`${ROOT}/src/lib/.secret`)
    .dir(`${ROOT}/src/lib/build`)
    .file(`${ROOT}/src/lib/build/generated.ts`)
    .dir(`${ROOT}/node_modules`)
    .file(`${ROOT}/node_modules/dep.js`)
    .dir(`${ROOT}/dist`)
    .file(`${ROOT}/dist/app.js`)
    .dir(`${ROOT}/out`)
    .file(`${ROOT}/out/main.js`)
    .dir(`${ROOT}/build`)
    .file(`${ROOT}/build/x.o`)
    // Other cases than the decision's names are walked.
    .dir(`${ROOT}/Build`)
    .file(`${ROOT}/Build/kept.txt`)
    // A file named like a skipped folder is listed.
    .file(`${ROOT}/src/out`)
    .dir("/home/octocat/outside")
    .file("/home/octocat/outside/secret.txt")
    .link(`${ROOT}/linked`, "/home/octocat/outside")
    .link(`${ROOT}/inside-link`, `${ROOT}/src`)
    .link(`${ROOT}/file-link.txt`, "/home/octocat/outside/secret.txt")
    .fifo(`${ROOT}/pipe`);
  const outcome = await walk(files);
  expect(outcome).toEqual({
    ok: true,
    files: [
      "Build/kept.txt",
      "README.md",
      "src/index.ts",
      "src/lib/a.ts",
      "src/out",
    ],
    // The repository's folder, `Build`, `src`, and `src/lib`.
    folders: 4,
    truncated: false,
  });
  // No skipped folder, hidden folder, or link was ever listed.
  expect(files.listed).toEqual([
    ROOT,
    `${ROOT}/Build`,
    `${ROOT}/src`,
    `${ROOT}/src/lib`,
  ]);
});

test("no listed path is absolute or holds the repository's folder, and each one passes the read tools' path rules", async () => {
  const files = repository()
    .file(`${ROOT}/a.txt`)
    .dir(`${ROOT}/home`)
    .dir(`${ROOT}/home/octocat`)
    .file(`${ROOT}/home/octocat/b.txt`);
  const outcome = await walk(files);
  if (!outcome.ok) {
    throw new Error("the walk failed");
  }
  expect(outcome.files).toEqual(["a.txt", "home/octocat/b.txt"]);
  for (const file of outcome.files) {
    expect(file.startsWith("/")).toBe(false);
    expect(file.includes(ROOT)).toBe(false);
    expect(parseRepositoryPath(file).ok).toBe(true);
  }
});

test("exactly 1,000 files are not cut; one more is cut, says so, and keeps the files nearest the top", async () => {
  const exact = repository().dir(`${ROOT}/deep`);
  for (
    let index = 0;
    index < REPOSITORY_FILE_LIST_LIMITS.maxFiles;
    index += 1
  ) {
    exact.file(`${ROOT}/deep/f${String(index).padStart(4, "0")}.txt`);
  }
  const whole = await walk(exact);
  expect(whole.ok && whole.files.length).toBe(1_000);
  expect(whole.ok && whole.truncated).toBe(false);

  const over = exact.file(`${ROOT}/top.txt`);
  const cut = await walk(over);
  if (!cut.ok) {
    throw new Error("the walk failed");
  }
  expect(cut.files).toHaveLength(1_000);
  expect(cut.truncated).toBe(true);
  // Breadth-first: the top folder's file is kept, the deep folder's last is not.
  expect(cut.files).toContain("top.txt");
  expect(cut.files).not.toContain("deep/f0999.txt");
  expect([...cut.files]).toEqual([...cut.files].sort());
});

test("at most 1,000 folders are listed, and a folder left out for it says so", async () => {
  const exact = repository();
  for (
    let index = 0;
    index < REPOSITORY_FILE_LIST_LIMITS.maxFolders - 1;
    index += 1
  ) {
    exact.dir(`${ROOT}/d${index}`);
  }
  const whole = await walk(exact);
  expect(whole).toEqual({
    ok: true,
    files: [],
    folders: 1_000,
    truncated: false,
  });
  expect(exact.listed).toHaveLength(1_000);

  const over = exact.dir(`${ROOT}/one-more`).file(`${ROOT}/one-more/x.txt`);
  over.listed.length = 0;
  const cut = await walk(over);
  expect(cut).toEqual({ ok: true, files: [], folders: 1_000, truncated: true });
  expect(over.listed).toHaveLength(1_000);
});

test("the walk stops listing once 1,000 files are found and one more is seen", async () => {
  const files = repository().dir(`${ROOT}/a`).dir(`${ROOT}/b`).dir(`${ROOT}/c`);
  for (
    let index = 0;
    index < REPOSITORY_FILE_LIST_LIMITS.maxFiles;
    index += 1
  ) {
    files.file(`${ROOT}/a/f${String(index).padStart(4, "0")}.txt`);
  }
  files.file(`${ROOT}/b/one-more.txt`).file(`${ROOT}/c/never.txt`);
  const outcome = await walk(files);
  expect(outcome.ok && outcome.files.length).toBe(1_000);
  expect(outcome.ok && outcome.truncated).toBe(true);
  expect(outcome.ok && outcome.folders).toBe(3);
  // `c` is never listed.
  expect(files.listed).toEqual([ROOT, `${ROOT}/a`, `${ROOT}/b`]);
});

test("a folder deeper than 32 levels is not entered, and the list says so", async () => {
  const { maxDepth } = REPOSITORY_FILE_LIST_LIMITS;
  // A chain of folders `d/d/.../d`, each with a file.
  function chain(levels: number): FakeFiles {
    const files = repository();
    let current = ROOT;
    for (let level = 1; level <= levels; level += 1) {
      current = `${current}/d`;
      files.dir(current).file(`${current}/f${level}.txt`);
    }
    return files;
  }
  const exact = chain(maxDepth);
  const whole = await walk(exact);
  expect(whole.ok && whole.files.length).toBe(maxDepth);
  expect(whole.ok && whole.truncated).toBe(false);
  expect(whole.ok && whole.folders).toBe(maxDepth + 1);
  expect(exact.listed).toHaveLength(maxDepth + 1);

  const deep = chain(maxDepth + 8);
  const cut = await walk(deep);
  if (!cut.ok) {
    throw new Error("the walk failed");
  }
  expect(cut.truncated).toBe(true);
  expect(cut.folders).toBe(maxDepth + 1);
  expect(cut.files).toHaveLength(maxDepth);
  expect(cut.files).toContain(`${"d/".repeat(maxDepth)}f${maxDepth}.txt`);
  // The repository's folder and 32 levels below it, no more.
  expect(deep.listed).toHaveLength(maxDepth + 1);
  expect(deep.listed.at(-1)).toBe(`${ROOT}${"/d".repeat(maxDepth)}`);
});

test("an abort while a listing does not return answers the files found so far once the repository's folder was listed", async () => {
  const files = repository()
    .file(`${ROOT}/a.txt`)
    .dir(`${ROOT}/share`)
    .file(`${ROOT}/share/b.txt`);
  files.hangReaddir.add(`${ROOT}/share`);
  const controller = new AbortController();
  const walking = walk(files, { signal: controller.signal });
  await new Promise((done) => setTimeout(done, 0));
  controller.abort();
  expect(await walking).toEqual({
    ok: true,
    files: ["a.txt"],
    folders: 1,
    truncated: true,
  });

  // Before the repository's folder was listed: aborted.
  const root = repository().file(`${ROOT}/a.txt`);
  root.hangReaddir.add(ROOT);
  const stopped = new AbortController();
  const hung = walk(root, { signal: stopped.signal });
  await new Promise((done) => setTimeout(done, 0));
  stopped.abort();
  expect(await hung).toEqual({ ok: false, reason: "aborted" });
});

test("a folder with more entries than one listing reads makes the list say that it was cut", async () => {
  const files = repository().dir(`${ROOT}/many`);
  for (let index = 0; index < 1_000; index += 1) {
    files.file(`${ROOT}/many/.hidden${index}`);
  }
  files.file(`${ROOT}/many/visible.txt`);
  expect(await walk(files)).toEqual({
    ok: true,
    files: [],
    folders: 2,
    truncated: true,
  });
});

test("a path longer than the read tools take is left out", async () => {
  const segment = "a".repeat(250);
  let folder = ROOT;
  let relative = "";
  while (relative.length + segment.length + 1 <= MAX_REPOSITORY_PATH_LENGTH) {
    folder = `${folder}/${segment}`;
    relative = relative === "" ? segment : `${relative}/${segment}`;
  }
  const files = repository();
  let current = ROOT;
  for (const part of relative.split("/")) {
    current = `${current}/${part}`;
    files.dir(current);
  }
  files.file(`${folder}/short.txt`);
  files.file(
    `${folder}/${"b".repeat(MAX_REPOSITORY_PATH_LENGTH - relative.length)}`,
  );
  const outcome = await walk(files);
  if (!outcome.ok) {
    throw new Error("the walk failed");
  }
  expect(outcome.files).toEqual([`${relative}/short.txt`]);
  // The list says that a file was left out.
  expect(outcome.truncated).toBe(true);
});

test("a folder that is gone, on another device, unreadable, or changing when its turn comes is skipped; a swapped listing fails the whole list", async () => {
  const gone = repository()
    .file(`${ROOT}/a.txt`)
    .dir(`${ROOT}/gone`)
    .file(`${ROOT}/gone/x.txt`)
    .dir(`${ROOT}/mount`)
    .file(`${ROOT}/mount/y.txt`);
  gone.devs.set(`${ROOT}/mount`, 7n);
  gone.beforeReaddir = (target) => {
    if (target === ROOT) {
      gone.beforeReaddir = null;
      // Removed after the root was resolved but before `gone` is listed.
      queueMicrotask(() => gone.remove(`${ROOT}/gone`));
    }
  };
  expect(await walk(gone)).toEqual({
    ok: true,
    files: ["a.txt"],
    folders: 1,
    truncated: false,
  });

  const failing = repository()
    .file(`${ROOT}/a.txt`)
    .dir(`${ROOT}/src`)
    .file(`${ROOT}/src/b.txt`);
  failing.failReaddir.set(`${ROOT}/src`, "EACCES");
  // An unreadable subfolder is left out, not counted, and the list says
  // that it was cut.
  expect(await walk(failing)).toEqual({
    ok: true,
    files: ["a.txt"],
    folders: 1,
    truncated: true,
  });
  // The repository's folder itself that cannot be read fails the list.
  const unreadable = repository().file(`${ROOT}/a.txt`);
  unreadable.failReaddir.set(ROOT, "EACCES");
  expect(await walk(unreadable)).toEqual({ ok: false, reason: "failed" });

  // A subfolder that keeps changing (`unsettled`) is left out, not counted,
  // and the list says that it was cut; the repository's folder itself fails
  // the list.
  const busy = repository()
    .file(`${ROOT}/a.txt`)
    .dir(`${ROOT}/tmp`)
    .file(`${ROOT}/tmp/c.txt`);
  busy.busy.add(`${ROOT}/tmp`);
  expect(await walk(busy)).toEqual({
    ok: true,
    files: ["a.txt"],
    folders: 1,
    truncated: true,
  });
  const busyRoot = repository().file(`${ROOT}/a.txt`);
  busyRoot.busy.add(ROOT);
  expect(await walk(busyRoot)).toEqual({ ok: false, reason: "failed" });

  // The repository's folder is no longer the one that the link recorded.
  const swapped = repository().file(`${ROOT}/a.txt`);
  expect(await walk(swapped, { identity: { dev: "1", ino: "999" } })).toEqual({
    ok: false,
    reason: "failed",
  });

  // A folder swapped for a link to a folder outside after its parent was listed.
  const linked = repository()
    .dir(`${ROOT}/src`)
    .file(`${ROOT}/src/b.txt`)
    .dir("/home/octocat/outside")
    .file("/home/octocat/outside/secret.txt");
  linked.beforeReaddir = (target) => {
    if (target === ROOT) {
      linked.beforeReaddir = null;
      queueMicrotask(() => {
        linked.remove(`${ROOT}/src`);
        linked.link(`${ROOT}/src`, "/home/octocat/outside");
      });
    }
  };
  expect(await walk(linked)).toEqual({ ok: false, reason: "failed" });
});

test("the repository's folder itself that is gone fails the list", async () => {
  const files = repository().file(`${ROOT}/a.txt`);
  const identity = files.identity(ROOT);
  files.remove(ROOT);
  expect(await walk(files, { identity })).toEqual({
    ok: false,
    reason: "failed",
  });
});

test("a repository folder that disappears after it was listed gives the files found so far, cut; one replaced by another folder fails the list", async () => {
  // The root goes when the walk turns to `b`, after the root and `a` were
  // listed: `b` is gone (skipped), and the listing of `c` cannot read the
  // root (`read_failed`, skipped and marked).
  function tree(): FakeFiles {
    return repository()
      .file(`${ROOT}/top.txt`)
      .dir(`${ROOT}/a`)
      .file(`${ROOT}/a/x.txt`)
      .dir(`${ROOT}/b`)
      .file(`${ROOT}/b/y.txt`)
      .dir(`${ROOT}/c`)
      .file(`${ROOT}/c/z.txt`);
  }
  const gone = tree();
  const identity = gone.identity(ROOT);
  gone.beforeRealpath = (target) => {
    if (target === `${ROOT}/b`) {
      gone.beforeRealpath = null;
      gone.remove(ROOT);
    }
  };
  expect(await walk(gone, { identity })).toEqual({
    ok: true,
    files: ["a/x.txt", "top.txt"],
    folders: 2,
    truncated: true,
  });
  expect(gone.listed).toEqual([ROOT, `${ROOT}/a`]);

  // Replaced by another folder at the same moment: a swap, which fails.
  const replaced = tree();
  replaced.beforeRealpath = (target) => {
    if (target === `${ROOT}/b`) {
      replaced.beforeRealpath = null;
      replaced.remove(ROOT);
      replaced.dir(ROOT).dir(`${ROOT}/c`);
    }
  };
  expect(await walk(replaced, { identity: replaced.identity(ROOT) })).toEqual({
    ok: false,
    reason: "failed",
  });
});

test("an abort stops the walk", async () => {
  const files = repository()
    .file(`${ROOT}/a.txt`)
    .dir(`${ROOT}/src`)
    .file(`${ROOT}/src/b.txt`);
  const controller = new AbortController();
  files.beforeReaddir = () => controller.abort();
  expect(await walk(files, { signal: controller.signal })).toEqual({
    ok: false,
    reason: "aborted",
  });
  const before = new AbortController();
  before.abort();
  expect(await walk(repository(), { signal: before.signal })).toEqual({
    ok: false,
    reason: "aborted",
  });
});

// The walk's record through the context builder (#366): the counts that the
// walk gives, and never a name or a path.

const RUN_ID = "0192f0a0-7b3c-7d4e-8f50-000000000001";
const AGENT_ID = "0192f0a0-7b3c-7d4e-8f50-000000000002";
const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009" as RepositoryId;
const AT = "2026-11-26T12:00:00.000Z";

async function recordedWalk(
  files: FakeFiles,
): Promise<{ records: EnforcementRecord[]; result: RunContextResult }> {
  const records: EnforcementRecord[] = [];
  const builder = createRunContextBuilder({
    account: {
      readWorkspaceData: (async () => ({
        ok: true,
        value: {
          message: {
            id: "0192f0a0-7b3c-7d4e-8f50-00000000000c",
            projectId: "0192f0a0-7b3c-7d4e-8f50-000000000006",
            seq: 1,
            author: {
              kind: "member",
              memberId: "0192f0a0-7b3c-7d4e-8f50-00000000000d",
            },
            body: "List the files.",
            createdAt: "2026-11-26T11:00:00.000Z",
          },
        },
      })) as never,
    },
    resolveFolder: async (repositoryId) => ({
      ok: true,
      repositoryId,
      folder: ROOT,
      identity: files.identity(ROOT),
    }),
    listFiles: createRepositoryWalkLister({ files, pathApi: path.posix }),
    recorder: {
      record: (entry) => {
        records.push(entry);
        return undefined;
      },
    },
    now: () => new Date(AT),
  });
  const result = await builder.build({
    run: {
      runId: RUN_ID,
      agentId: AGENT_ID,
      hostDeviceId: "0192f0a0-7b3c-7d4e-8f50-000000000004",
      repositoryId: REPOSITORY_ID,
      providerConnectionId: null,
    } as HeldRun,
    workspaceId: "0192f0a0-7b3c-7d4e-8f50-000000000007" as WorkspaceId,
    projectId: "0192f0a0-7b3c-7d4e-8f50-000000000006" as ProjectId,
    inputMessageId: "0192f0a0-7b3c-7d4e-8f50-00000000000c" as MessageId,
    check: () => ({
      allowed: true,
      request: {
        agentId: AGENT_ID,
        capability: "repo.read",
        repositoryId: REPOSITORY_ID,
      } as never,
      end: () => undefined,
    }),
    signal: new AbortController().signal,
  });
  return { records, result };
}

function okWalk(files: number, folders: number, truncated: boolean) {
  return {
    kind: "context_walk",
    result: "ok",
    files,
    folders,
    truncated,
    runId: RUN_ID,
    agentId: AGENT_ID,
    repositoryId: REPOSITORY_ID,
    providerConnectionId: null,
    at: AT,
  };
}

test("the walk's record counts the files in the context and the folders listed: an unreadable folder is not counted and cuts the list", async () => {
  const files = repository()
    .file(`${ROOT}/a.txt`)
    .dir(`${ROOT}/src`)
    .file(`${ROOT}/src/b.txt`)
    .dir(`${ROOT}/secret-plans`)
    .file(`${ROOT}/secret-plans/c.txt`);
  files.failReaddir.set(`${ROOT}/secret-plans`, "EACCES");
  const { records, result } = await recordedWalk(files);
  expect(result.ok && result.context.repository).toEqual({
    included: true,
    repositoryId: REPOSITORY_ID,
    files: ["a.txt", "src/b.txt"],
    truncated: true,
  });
  expect(records).toEqual([okWalk(2, 2, true)]);
  const json = JSON.stringify(records);
  for (const name of ["a.txt", "src", "secret-plans", "octocat", ROOT]) {
    expect(json).not.toContain(name);
  }
});

test("the walk's record of a tree deeper than 32 levels counts the 33 folders listed and says that the list was cut", async () => {
  const { maxDepth } = REPOSITORY_FILE_LIST_LIMITS;
  const files = repository();
  let current = ROOT;
  for (let level = 1; level <= maxDepth + 4; level += 1) {
    current = `${current}/d`;
    files.dir(current).file(`${current}/f${level}.txt`);
  }
  const { records } = await recordedWalk(files);
  expect(records).toEqual([okWalk(maxDepth, maxDepth + 1, true)]);

  // A tree within every bound is recorded as whole.
  const whole = repository().file(`${ROOT}/a.txt`);
  expect((await recordedWalk(whole)).records).toEqual([okWalk(1, 1, false)]);
});
