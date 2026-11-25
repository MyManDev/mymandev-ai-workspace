// The read tools on the real file system, in a small temporary folder that
// each test removes. Folder links are junctions on Windows, which need no
// privilege, and symbolic links elsewhere. A symbolic link to a file needs
// a privilege on Windows: those cases are skipped there when it is missing,
// and the fake file system of `read-tools.test.ts` covers them.
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RepositoryId } from "@mymandev/protocol";
import { afterEach, expect, test } from "vitest";
import type { RunActionCheck } from "../agents/run-executor.ts";
import type { HeldRun } from "../permissions/enforcement.ts";
import {
  createReadTools,
  createSystemReadToolFileSystem,
  READ_TOOL_NAMES,
  type ReadToolFileSystem,
} from "./read-tools.ts";
import {
  createToolDispatcher,
  createToolRegistry,
  type Tool,
  type ToolCallAnswer,
  type ToolRunOutcome,
} from "./tool-dispatcher.ts";

const REPOSITORY_ID = "0192f0a0-7b3c-7d4e-8f50-000000000009";
const RUN: HeldRun = Object.freeze({
  runId: "0192f0a0-7b3c-7d4e-8f50-000000000001",
  agentId: "0192f0a0-7b3c-7d4e-8f50-000000000002",
  hostDeviceId: "0192f0a0-7b3c-7d4e-8f50-000000000004",
  repositoryId: REPOSITORY_ID,
  providerConnectionId: null,
}) as HeldRun;

const windows = process.platform === "win32";
const bases: string[] = [];

afterEach(async () => {
  for (const base of bases.splice(0)) {
    await rm(base, { recursive: true, force: true });
  }
});

/** A repository and a folder beside it, in a new temporary folder. */
async function layout() {
  const base = await realpath(
    await mkdtemp(path.join(tmpdir(), "mymandev-read-tools-")),
  );
  bases.push(base);
  const repo = path.join(base, "repo");
  const outside = path.join(base, "outside");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(path.join(repo, "src", "sub"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(repo, ".git", "config"), "[core]\n");
  await writeFile(path.join(repo, ".env"), "TOKEN=hidden\n");
  await writeFile(path.join(repo, "README.md"), "# Repo\n");
  await writeFile(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(repo, "src", "sub", "file.txt"), "inside\n");
  await writeFile(path.join(outside, "secret.txt"), "outside secret\n");
  await writeFile(path.join(outside, "file.txt"), "outside file\n");
  return { base, repo, outside };
}

/** A link to a folder: a junction on Windows. */
function folderLink(target: string, at: string): Promise<void> {
  return symlink(target, at, "junction");
}

/** A link to a file, or false where the system does not allow one. */
async function fileLink(target: string, at: string): Promise<boolean> {
  try {
    await symlink(target, at, "file");
    return true;
  } catch (error) {
    if (windows && (error as { code?: unknown }).code === "EPERM") {
      return false;
    }
    throw error;
  }
}

function toolsOf(files: ReadToolFileSystem = createSystemReadToolFileSystem()) {
  const tools = createReadTools({ files });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools,
    list: byName.get(READ_TOOL_NAMES.listDirectory) as Tool,
    read: byName.get(READ_TOOL_NAMES.readFile) as Tool,
  };
}

async function runTool(
  tool: Tool,
  folder: string,
  input: unknown,
): Promise<ToolRunOutcome> {
  const parsed = tool.parse(input);
  if (!parsed.ok) {
    throw new Error("invalid input");
  }
  return parsed.run({ folder, signal: new AbortController().signal });
}

function refusal(reason: string) {
  return { ok: false, code: "path_refused", reason };
}

test("lists and reads inside the repository; .git and hidden names are left out and refused", async () => {
  const { repo } = await layout();
  const { list, read } = toolsOf();
  expect(await runTool(list, repo, { path: "." })).toEqual({
    ok: true,
    result: {
      path: ".",
      entries: [
        { name: "README.md", kind: "file" },
        { name: "src", kind: "directory" },
      ],
      omitted: 2,
      truncated: false,
    },
  });
  expect(await runTool(read, repo, { path: "src/a.ts" })).toEqual({
    ok: true,
    result: {
      path: "src/a.ts",
      size: 20,
      truncated: false,
      binary: false,
      content: "export const a = 1;\n",
    },
  });
  expect(await runTool(read, repo, { path: ".git/config" })).toEqual(
    refusal("git"),
  );
  expect(await runTool(list, repo, { path: ".git" })).toEqual(refusal("git"));
  expect(await runTool(read, repo, { path: ".env" })).toEqual(
    refusal("hidden"),
  );
});

test("a folder link (a junction on Windows) that leaves the repository is refused as outside", async () => {
  const { repo, outside } = await layout();
  await folderLink(outside, path.join(repo, "linked"));
  const { list, read } = toolsOf();
  expect(await runTool(list, repo, { path: "linked" })).toEqual(
    refusal("outside"),
  );
  expect(await runTool(read, repo, { path: "linked/secret.txt" })).toEqual(
    refusal("outside"),
  );
});

test("a folder link that stays inside is refused as an alias, also one to the Git folder", async () => {
  const { repo } = await layout();
  await folderLink(path.join(repo, "src"), path.join(repo, "alias"));
  await folderLink(path.join(repo, ".git"), path.join(repo, "git-link"));
  const { list, read } = toolsOf();
  expect(await runTool(read, repo, { path: "alias/a.ts" })).toEqual(
    refusal("alias"),
  );
  expect(await runTool(read, repo, { path: "git-link/config" })).toEqual(
    refusal("alias"),
  );
  expect(await runTool(list, repo, { path: "git-link" })).toEqual(
    refusal("alias"),
  );
});

test("a file link that leaves the repository is refused as outside", async (context) => {
  const { repo, outside } = await layout();
  if (
    !(await fileLink(
      path.join(outside, "secret.txt"),
      path.join(repo, "secret-link.txt"),
    ))
  ) {
    context.skip("symbolic links to files need a privilege on this Windows");
  }
  const { read } = toolsOf();
  expect(await runTool(read, repo, { path: "secret-link.txt" })).toEqual(
    refusal("outside"),
  );
});

test("a hard link to a file outside the repository is refused", async () => {
  const { repo, outside } = await layout();
  await link(path.join(outside, "secret.txt"), path.join(repo, "hard.txt"));
  const { read } = toolsOf();
  expect(await runTool(read, repo, { path: "hard.txt" })).toEqual(
    refusal("hard_link"),
  );
});

test("on Windows, a path in another case is refused as an alias", async (context) => {
  if (!windows) {
    context.skip("only Windows folds case on every volume by default");
  }
  const { repo } = await layout();
  const { read } = toolsOf();
  expect(await runTool(read, repo, { path: "SRC/a.ts" })).toEqual(
    refusal("alias"),
  );
  expect(await runTool(read, repo, { path: "readme.md" })).toEqual(
    refusal("alias"),
  );
});

/** The system's file system, with a hook before the n-th call of an operation. */
function hooked(
  operation: keyof ReadToolFileSystem,
  nth: number,
  hook: () => Promise<void>,
): ReadToolFileSystem {
  const system = createSystemReadToolFileSystem();
  let count = 0;
  const before = async (name: keyof ReadToolFileSystem) => {
    if (name === operation) {
      count += 1;
      if (count === nth) {
        await hook();
      }
    }
  };
  return {
    realpath: async (target) => {
      await before("realpath");
      return system.realpath(target);
    },
    lstat: async (target) => {
      await before("lstat");
      return system.lstat(target);
    },
    open: async (target) => {
      await before("open");
      return system.open(target);
    },
    readdir: async (target, limit) => {
      await before("readdir");
      return system.readdir(target, limit);
    },
  };
}

test("TOCTOU: a folder swapped for a junction or link to a folder outside before the open is refused", async () => {
  const { repo, outside } = await layout();
  const files = hooked("open", 1, async () => {
    await rename(path.join(repo, "src", "sub"), path.join(repo, "sub-old"));
    await folderLink(outside, path.join(repo, "src", "sub"));
  });
  const { read } = toolsOf(files);
  const answer = await runTool(read, repo, { path: "src/sub/file.txt" });
  expect(answer).toEqual(refusal("changed"));
  expect(JSON.stringify(answer)).not.toContain("outside");
});

test("TOCTOU: a file swapped for a link to a file outside before the open is refused", async (context) => {
  const { repo, outside } = await layout();
  const target = path.join(repo, "src", "sub", "file.txt");
  let linked = true;
  const files = hooked("open", 1, async () => {
    await rm(target);
    linked = await fileLink(path.join(outside, "file.txt"), target);
  });
  const { read } = toolsOf(files);
  const answer = await runTool(read, repo, { path: "src/sub/file.txt" });
  if (!linked) {
    context.skip("symbolic links to files need a privilege on this Windows");
  }
  expect(answer).toEqual(refusal("changed"));
  expect(JSON.stringify(answer)).not.toContain("outside");
});

test("TOCTOU: a folder swapped for a junction or link while it is listed is refused", async () => {
  const { repo, outside } = await layout();
  const files = hooked("readdir", 1, async () => {
    await rename(path.join(repo, "src", "sub"), path.join(repo, "sub-old"));
    await folderLink(outside, path.join(repo, "src", "sub"));
  });
  const { list } = toolsOf(files);
  const answer = await runTool(list, repo, { path: "src/sub" });
  expect(answer).toEqual(refusal("changed"));
});

test("through the dispatcher, no answer holds the temporary folder's path, whatever the outcome", async () => {
  const { base, repo, outside } = await layout();
  await folderLink(outside, path.join(repo, "linked"));
  const dispatcher = createToolDispatcher({
    registry: createToolRegistry(toolsOf().tools),
    resolveFolder: async (repositoryId: RepositoryId) => ({
      ok: true,
      repositoryId,
      folder: repo,
    }),
  });
  const context = {
    run: RUN,
    check: (): RunActionCheck => ({
      allowed: true,
      request: {
        agentId: RUN.agentId,
        capability: "repo.read",
        repositoryId: RUN.repositoryId as RepositoryId,
      },
      end: () => undefined,
    }),
    signal: new AbortController().signal,
  };
  const answers: ToolCallAnswer[] = [];
  for (const value of [
    ".",
    "src",
    "src/a.ts",
    "linked",
    "linked/secret.txt",
    "missing.txt",
    repo,
    path.join(repo, "README.md"),
    `../${path.basename(outside)}/secret.txt`,
  ]) {
    for (const name of [
      READ_TOOL_NAMES.listDirectory,
      READ_TOOL_NAMES.readFile,
    ]) {
      answers.push(await dispatcher.call(context, name, { path: value }));
    }
  }
  expect(answers.filter((answer) => answer.ok)).toHaveLength(3);
  const text = JSON.stringify(answers).toLowerCase();
  for (const form of [base, base.replaceAll("\\", "/"), tmpdir()]) {
    expect(text).not.toContain(JSON.stringify(form.toLowerCase()).slice(1, -1));
  }
  expect(text).not.toContain("secret");
});
