import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type FolderStats,
  type LstatFunction,
  readFolderIdentity,
  sameFolderIdentity,
  systemLstat,
} from "./identity.ts";

const TOP = "/home/user/web";
const COMMON = "/home/user/web/.git";

function stats(
  dev: bigint,
  ino: bigint,
  kind: "folder" | "link" | "file" = "folder",
): FolderStats {
  return {
    dev,
    ino,
    isDirectory: () => kind === "folder",
    isSymbolicLink: () => kind === "link",
  };
}

/** A fake `lstat` over a map; a path that it does not hold rejects. */
function fakeLstat(entries: Record<string, FolderStats>): {
  readonly read: LstatFunction;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    read: (target) => {
      calls.push(target);
      const entry = entries[target];
      return entry === undefined
        ? Promise.reject(
            Object.assign(new Error(`ENOENT ${target}`), { code: "ENOENT" }),
          )
        : Promise.resolve(entry);
    },
  };
}

test("the identity is the device and file number of both folders, as exact decimal text", async () => {
  const big = 2n ** 63n + 5n;
  const { read, calls } = fakeLstat({
    [TOP]: stats(2049n, big),
    [COMMON]: stats(2049n, 42n),
  });

  const result = await readFolderIdentity(read, {
    topLevel: TOP,
    commonDir: COMMON,
  });

  expect(result).toEqual({
    ok: true,
    identity: {
      folder: { dev: "2049", ino: "9223372036854775813" },
      commonDir: { dev: "2049", ino: "42" },
    },
  });
  expect(calls).toEqual([TOP, COMMON]);
  expect(Object.isFrozen(result)).toBe(true);
  if (result.ok) {
    expect(Object.isFrozen(result.identity)).toBe(true);
    expect(Object.isFrozen(result.identity.folder)).toBe(true);
  }
});

test("a symbolic link or junction at the top level or as the common Git folder is refused", async () => {
  for (const entries of [
    { [TOP]: stats(1n, 2n, "link"), [COMMON]: stats(1n, 3n) },
    { [TOP]: stats(1n, 2n), [COMMON]: stats(1n, 3n, "link") },
  ]) {
    const { read } = fakeLstat(entries);
    await expect(
      readFolderIdentity(read, { topLevel: TOP, commonDir: COMMON }),
    ).resolves.toEqual({ ok: false, reason: "symbolic_link" });
  }
});

test("a folder that is missing, a file, or unreadable has no identity", async () => {
  const cases: Record<string, FolderStats>[] = [
    { [COMMON]: stats(1n, 3n) },
    { [TOP]: stats(1n, 2n) },
    { [TOP]: stats(1n, 2n, "file"), [COMMON]: stats(1n, 3n) },
    { [TOP]: stats(1n, 2n), [COMMON]: stats(1n, 3n, "file") },
    {
      [TOP]: { ...stats(1n, 2n), ino: 2 as unknown as bigint },
      [COMMON]: stats(1n, 3n),
    },
  ];
  for (const entries of cases) {
    const { read } = fakeLstat(entries);
    await expect(
      readFolderIdentity(read, { topLevel: TOP, commonDir: COMMON }),
    ).resolves.toEqual({ ok: false, reason: "folder_missing" });
  }
});

test("two identities are the same only when all four numbers are", () => {
  const identity = {
    folder: { dev: "1", ino: "2" },
    commonDir: { dev: "1", ino: "3" },
  };
  expect(sameFolderIdentity(identity, structuredClone(identity))).toBe(true);
  for (const other of [
    { ...identity, folder: { dev: "9", ino: "2" } },
    { ...identity, folder: { dev: "1", ino: "9" } },
    { ...identity, commonDir: { dev: "9", ino: "3" } },
    { ...identity, commonDir: { dev: "1", ino: "9" } },
  ]) {
    expect(sameFolderIdentity(identity, other)).toBe(false);
  }
});

// The system's `lstat`, on a temporary folder.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mymandev-identity-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function repository(name: string): Promise<{
  topLevel: string;
  commonDir: string;
}> {
  const topLevel = path.join(root, name);
  const commonDir = path.join(topLevel, ".git");
  await mkdir(commonDir, { recursive: true });
  return { topLevel, commonDir };
}

test("with the system's lstat, a folder keeps its identity, also when files change inside it, and another folder has another", async () => {
  const web = await repository("web");
  const api = await repository("api");

  const first = await readFolderIdentity(systemLstat, web);
  const again = await readFolderIdentity(systemLstat, web);
  const other = await readFolderIdentity(systemLstat, api);
  expect(first.ok && again.ok && other.ok).toBe(true);
  if (!first.ok || !again.ok || !other.ok) {
    return;
  }
  expect(sameFolderIdentity(first.identity, again.identity)).toBe(true);
  expect(sameFolderIdentity(first.identity, other.identity)).toBe(false);
  // A file added inside changes neither folder's identity.
  await writeFile(path.join(web.topLevel, "README.md"), "x");
  await writeFile(path.join(web.commonDir, "HEAD"), "ref: refs/heads/main\n");
  const after = await readFolderIdentity(systemLstat, web);
  expect(after.ok && sameFolderIdentity(first.identity, after.identity)).toBe(
    true,
  );
  for (const number of [
    first.identity.folder.dev,
    first.identity.folder.ino,
    first.identity.commonDir.ino,
  ]) {
    expect(number).toMatch(/^-?(?:0|[1-9][0-9]{0,19})$/u);
  }
});

test("with the system's lstat, a directory link (a junction on Windows) is refused, and a missing folder or a file has no identity", async () => {
  const web = await repository("web");
  const linked = path.join(root, "linked");
  await symlink(web.topLevel, linked, "junction");
  await expect(
    readFolderIdentity(systemLstat, {
      topLevel: linked,
      commonDir: path.join(linked, ".git"),
    }),
  ).resolves.toEqual({ ok: false, reason: "symbolic_link" });

  const file = path.join(root, "file");
  await writeFile(file, "x");
  for (const folders of [
    { topLevel: path.join(root, "missing"), commonDir: web.commonDir },
    { topLevel: file, commonDir: web.commonDir },
    { topLevel: web.topLevel, commonDir: path.join(root, "missing") },
  ]) {
    await expect(readFolderIdentity(systemLstat, folders)).resolves.toEqual({
      ok: false,
      reason: "folder_missing",
    });
  }
});
