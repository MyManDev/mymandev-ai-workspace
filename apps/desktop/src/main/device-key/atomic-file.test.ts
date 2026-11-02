import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  isTemporaryFileOf,
  type KeyFileSystem,
  nodeKeyFileSystem,
  temporaryFileFor,
  writeFileAtomic,
} from "./atomic-file.ts";

type Step = "open" | "write" | "sync" | "close" | "rename" | "folder";

let folder: string;
let target: string;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "mymandev-atomic-file-"));
  target = path.join(folder, "device-key.json");
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/**
 * The real file system, recording its calls, that fails at `failAt`. A
 * failing write first writes half of the data, as a full disk would.
 */
function fileSystemFailingAt(failAt: Step | null, calls: string[] = []) {
  const fileSystem: KeyFileSystem = {
    ...nodeKeyFileSystem,
    open: async (file, flags, mode) => {
      const isFolder = flags === "r";
      calls.push(
        isFolder
          ? `open folder ${flags}`
          : `open ${path.basename(file)} ${flags} ${mode?.toString(8)}`,
      );
      if (
        (failAt === "open" && !isFolder) ||
        (failAt === "folder" && isFolder)
      ) {
        throw new Error(`${failAt} failed`);
      }
      const handle = await nodeKeyFileSystem.open(file, flags, mode);
      return {
        writeFile: async (data) => {
          calls.push("write");
          if (failAt === "write") {
            await handle.writeFile(data.subarray(0, data.length / 2));
            throw new Error("write failed");
          }
          await handle.writeFile(data);
        },
        sync: async () => {
          calls.push(isFolder ? "sync folder" : "sync");
          if (failAt === "sync" && !isFolder) {
            throw new Error("sync failed");
          }
          await handle.sync();
        },
        close: async () => {
          calls.push(isFolder ? "close folder" : "close");
          await handle.close();
          if (failAt === "close" && !isFolder) {
            throw new Error("close failed");
          }
        },
      };
    },
    rename: async (from, to) => {
      calls.push(`rename ${path.basename(from)} ${path.basename(to)}`);
      if (failAt === "rename") {
        throw new Error("rename failed");
      }
      await nodeKeyFileSystem.rename(from, to);
    },
  };
  return fileSystem;
}

test("a write creates the file and leaves no temporary file", async () => {
  await writeFileAtomic(
    nodeKeyFileSystem,
    target,
    Buffer.from("new"),
    process.platform,
  );

  expect(await readFile(target, "utf8")).toBe("new");
  expect(await readdir(folder)).toEqual(["device-key.json"]);
});

test("a write replaces an existing file", async () => {
  await writeFile(target, "old");

  await writeFileAtomic(
    nodeKeyFileSystem,
    target,
    Buffer.from("new"),
    process.platform,
  );

  expect(await readFile(target, "utf8")).toBe("new");
  expect(await readdir(folder)).toEqual(["device-key.json"]);
});

test.each(["open", "write", "sync", "close", "rename"] as const)(
  "a failure at %s keeps the old file and leaves no partial or temporary file",
  async (failAt) => {
    await writeFile(target, "old");

    await expect(
      writeFileAtomic(
        fileSystemFailingAt(failAt),
        target,
        Buffer.from("new content"),
        process.platform,
      ),
    ).rejects.toThrow(`${failAt} failed`);

    expect(await readFile(target, "utf8")).toBe("old");
    expect(await readdir(folder)).toEqual(["device-key.json"]);
  },
);

test.each(["open", "write", "sync", "close", "rename"] as const)(
  "a failure at %s of a first write leaves no file at all",
  async (failAt) => {
    await expect(
      writeFileAtomic(
        fileSystemFailingAt(failAt),
        target,
        Buffer.from("new content"),
        process.platform,
      ),
    ).rejects.toThrow(`${failAt} failed`);

    expect(await readdir(folder)).toEqual([]);
  },
);

test("the temporary file is created exclusively, for its owner, in the same folder, and renamed after it was flushed and closed", async () => {
  const calls: string[] = [];

  await writeFileAtomic(
    fileSystemFailingAt(null, calls),
    target,
    Buffer.from("new"),
    "linux",
  );

  const [open, ...rest] = calls as [string, ...string[]];
  const [, temporaryName] = open.split(" ") as [string, string];
  expect(open).toBe(`open ${temporaryName} wx 600`);
  expect(isTemporaryFileOf(temporaryName, "device-key.json")).toBe(true);
  expect(rest).toEqual([
    "write",
    "sync",
    "close",
    `rename ${temporaryName} device-key.json`,
    // The folder is flushed, so that the rename survives a power loss. When
    // this test runs on Windows, the flush fails and is ignored.
    "open folder r",
    "sync folder",
    "close folder",
  ]);
  expect(await readFile(target, "utf8")).toBe("new");
});

test("the folder is not flushed on Windows, and a folder that cannot be flushed does not fail the write", async () => {
  const windowsCalls: string[] = [];
  await writeFileAtomic(
    fileSystemFailingAt(null, windowsCalls),
    target,
    Buffer.from("one"),
    "win32",
  );
  expect(windowsCalls.some((call) => call.includes("folder"))).toBe(false);

  await writeFileAtomic(
    fileSystemFailingAt("folder"),
    target,
    Buffer.from("two"),
    "linux",
  );
  expect(await readFile(target, "utf8")).toBe("two");
});

test.skipIf(process.platform === "win32")(
  "the file has mode 0600 on Linux and macOS",
  async () => {
    await writeFileAtomic(
      nodeKeyFileSystem,
      target,
      Buffer.from("new"),
      process.platform,
    );

    expect((await stat(target)).mode & 0o777).toBe(0o600);
  },
);

test("temporary file names belong to their target only", () => {
  const temporary = path.basename(temporaryFileFor(target));

  expect(isTemporaryFileOf(temporary, "device-key.json")).toBe(true);
  expect(isTemporaryFileOf(temporary, "device-key.previous.json")).toBe(false);
  for (const name of [
    "device-key.json",
    "device-key.json.tmp",
    "device-key.json.0123456789abcdef",
    "device-key.json.0123456789ABCDEF.tmp",
    "device-key.json.0123456789abcde.tmp",
    "device-key.json.x.0123456789abcdef.tmp",
    "other.json.0123456789abcdef.tmp",
  ]) {
    expect(isTemporaryFileOf(name, "device-key.json")).toBe(false);
  }
  expect(
    isTemporaryFileOf(
      "device-key.json.0123456789abcdef.tmp",
      "device-key.json",
    ),
  ).toBe(true);
});
