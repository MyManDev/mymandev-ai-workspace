import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  MemberId,
  ProjectId,
  RepositoryId,
  WorkspaceId,
} from "@mymandev/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { REPOSITORY_LIMITS } from "../../shared/ipc-contract.ts";
import {
  type KeyFileSystem,
  nodeKeyFileSystem,
} from "../device-key/atomic-file.ts";
import {
  createRepositoryLinkStore,
  decodeRepositoryLinks,
  encodeRepositoryLinks,
  MAX_REPOSITORY_LINKS,
  REPOSITORY_LINK_FILE,
  REPOSITORY_LINK_VERSION,
  type RepositoryLink,
} from "./link-store.ts";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OWN = id(0xc1) as MemberId;
const OTHER_OWN = id(0xc2) as MemberId;
const PROJECT = id(0xe1) as ProjectId;
const REPOSITORY = id(0xf1) as RepositoryId;
const OTHER_REPOSITORY = id(0xf2) as RepositoryId;
const FOLDER = path.posix.join("/", "home", "user", "web");

function link(overrides: Partial<RepositoryLink> = {}): RepositoryLink {
  return {
    workspaceId: WORKSPACE,
    ownMemberId: OWN,
    projectId: PROJECT,
    repositoryId: REPOSITORY,
    folder: FOLDER,
    ...overrides,
  };
}

let root: string;
let folder: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mymandev-repository-links-"));
  folder = path.join(root, "MyManDev");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function bytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

/** A store in the test folder that takes POSIX folders, as on Linux. */
function store(fileSystem: KeyFileSystem = nodeKeyFileSystem) {
  return createRepositoryLinkStore({
    folder: () => folder,
    platform: "linux",
    isAbsolute: path.posix.isAbsolute,
    fileSystem,
  });
}

const decode = (value: unknown) =>
  decodeRepositoryLinks(bytes(value), path.posix.isAbsolute);

test("the links round trip through one line of JSON in the folder, with IDs and folders only, written atomically", async () => {
  const links = [link(), link({ repositoryId: OTHER_REPOSITORY })];

  expect(await store().read()).toEqual({ kind: "none" });
  await store().write(links);

  const text = await readFile(path.join(folder, REPOSITORY_LINK_FILE), "utf8");
  expect(text.endsWith("\n")).toBe(true);
  expect(text.trimEnd().includes("\n")).toBe(false);
  expect(JSON.parse(text)).toEqual({
    version: REPOSITORY_LINK_VERSION,
    links,
  });
  expect(await readdir(folder)).toEqual([REPOSITORY_LINK_FILE]);
  const read = await store().read();
  expect(read).toEqual({ kind: "links", links });
  expect(Object.isFrozen(read)).toBe(true);
  if (read.kind === "links") {
    expect(Object.isFrozen(read.links)).toBe(true);
    expect(Object.isFrozen(read.links[0])).toBe(true);
  }
});

test("a file that is not exactly this format is corrupt", () => {
  const valid = { version: REPOSITORY_LINK_VERSION, links: [link()] };
  expect(decode(valid)).toEqual({ kind: "links", links: [link()] });
  const corrupt: unknown[] = [
    null,
    [],
    "links",
    {},
    { version: REPOSITORY_LINK_VERSION },
    { links: [] },
    { version: 0, links: [] },
    { version: "1", links: [] },
    { ...valid, extra: true },
    { version: 1, links: [{ ...link(), extra: true }] },
    { version: 1, links: [{ ...link(), folder: undefined }] },
    { version: 1, links: [{ ...link(), repositoryId: "web" }] },
    { version: 1, links: [{ ...link(), ownMemberId: OWN.toUpperCase() }] },
    { version: 1, links: [{ ...link(), workspaceId: 7 }] },
    // A folder that is relative, empty, too long, or holds NUL.
    { version: 1, links: [{ ...link(), folder: "web" }] },
    { version: 1, links: [{ ...link(), folder: "" }] },
    { version: 1, links: [{ ...link(), folder: "/home/w\0eb" }] },
    {
      version: 1,
      links: [{ ...link(), folder: `/${"a".repeat(REPOSITORY_LIMITS.path)}` }],
    },
    {
      version: 1,
      links: Array.from({ length: MAX_REPOSITORY_LINKS + 1 }, (_, index) =>
        link({ repositoryId: id(0x10000 + index) as RepositoryId }),
      ),
    },
  ];
  for (const value of corrupt) {
    expect(decode(value), JSON.stringify(value)?.slice(0, 80)).toEqual({
      kind: "corrupt",
    });
  }
  expect(decodeRepositoryLinks(Buffer.from("{not json"))).toEqual({
    kind: "corrupt",
  });
  expect(decodeRepositoryLinks(Buffer.from([0xff, 0xfe, 0x7b]))).toEqual({
    kind: "corrupt",
  });
  // More than 8 MiB is not read at all.
  expect(
    decodeRepositoryLinks(new Uint8Array(8 * 1024 * 1024 + 1).fill(0x20)),
  ).toEqual({ kind: "corrupt" });
});

test("a Windows folder is absolute where the store checks with Windows rules", () => {
  const windows = link({ folder: "C:\\Users\\user\\web" });
  expect(
    decodeRepositoryLinks(
      bytes({ version: 1, links: [windows] }),
      path.win32.isAbsolute,
    ),
  ).toEqual({ kind: "links", links: [windows] });
  expect(
    decodeRepositoryLinks(
      bytes({ version: 1, links: [link({ folder: "web\\app" })] }),
      path.win32.isAbsolute,
    ),
  ).toEqual({ kind: "corrupt" });
});

test("a file of a later version is newer: neither used nor called corrupt", () => {
  expect(decode({ version: REPOSITORY_LINK_VERSION + 1, links: [] })).toEqual({
    kind: "newer",
  });
  expect(decode({ version: 7, anything: { else: true } })).toEqual({
    kind: "newer",
  });
});

test("the full file of the longest folders fits the limit of the file", () => {
  // Every character escaped by JSON in six bytes.
  const longest = `/${"\u0001".repeat(REPOSITORY_LIMITS.path - 1)}`;
  const links = Array.from({ length: MAX_REPOSITORY_LINKS }, (_, index) =>
    link({
      repositoryId: id(0x10000 + index) as RepositoryId,
      folder: longest,
    }),
  );
  const encoded = encodeRepositoryLinks(links, path.posix.isAbsolute);
  expect(encoded.length).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(decodeRepositoryLinks(encoded, path.posix.isAbsolute)).toEqual({
    kind: "links",
    links,
  });
});

test("a repository linked twice by the same person keeps the later link, in its place; another person's link stays", () => {
  const first = link();
  const other = link({ ownMemberId: OTHER_OWN });
  const again = link({ folder: "/home/user/web-2" });
  expect(decode({ version: 1, links: [first, other, again] })).toEqual({
    kind: "links",
    links: [other, again],
  });
});

test("a write outside the format throws a TypeError that names no value, and writes nothing", async () => {
  for (const links of [
    [link({ folder: "secret-folder" })],
    [link({ repositoryId: "secret-folder" as RepositoryId })],
    Array.from({ length: MAX_REPOSITORY_LINKS + 1 }, (_, index) =>
      link({ repositoryId: id(0x10000 + index) as RepositoryId }),
    ),
  ]) {
    const error = await store()
      .write(links)
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain("secret");
  }
  await expect(readdir(folder)).rejects.toThrow();
});

test("a read deletes the temporary files that a stopped write left, and nothing else", async () => {
  await mkdir(folder, { recursive: true });
  const leftover = `${REPOSITORY_LINK_FILE}.0123456789abcdef.tmp`;
  const others = [
    "device-key.json",
    "claims-seen.json.0123456789abcdef.tmp",
    `${REPOSITORY_LINK_FILE}.tmp`,
  ];
  for (const name of [leftover, ...others]) {
    await writeFile(path.join(folder, name), "x");
  }

  expect(await store().read()).toEqual({ kind: "none" });
  expect((await readdir(folder)).sort()).toEqual([...others].sort());
});

test("a file that cannot be read, or a folder that is not known, rejects the read and the write; nothing falls back elsewhere", async () => {
  const failing: KeyFileSystem = {
    ...nodeKeyFileSystem,
    readFile: () =>
      Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })),
  };
  await expect(store(failing).read()).rejects.toThrow("EACCES");

  const unknown = createRepositoryLinkStore({
    folder: () => {
      throw new Error("local_data_folder_missing");
    },
    platform: "win32",
  });
  await expect(unknown.read()).rejects.toThrow("local_data_folder_missing");
  await expect(unknown.write([link()])).rejects.toThrow(
    "local_data_folder_missing",
  );
  await expect(readdir(root)).resolves.toEqual([]);
});

test("a failed write keeps the old file and leaves no temporary file", async () => {
  await store().write([link()]);
  const failing: KeyFileSystem = {
    ...nodeKeyFileSystem,
    rename: () => Promise.reject(new Error("rename failed")),
  };

  await expect(
    store(failing).write([link({ repositoryId: OTHER_REPOSITORY })]),
  ).rejects.toThrow("rename failed");
  expect(await store().read()).toEqual({ kind: "links", links: [link()] });
  expect(await readdir(folder)).toEqual([REPOSITORY_LINK_FILE]);
});

test("the system store keeps the file in the device key's local folder, which never roams, and nowhere else", () => {
  const source = readFileSync(new URL("./system.ts", import.meta.url), "utf8");

  expect(source).toMatch(/folder: \(\) =>\s+deviceKeyFolder\(\{/u);
  expect(source).not.toMatch(/getPath\(\s*["']appData/u);
  expect(source.match(/getPath\(/gu)).toHaveLength(1);
});
