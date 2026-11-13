import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_ANSWER_LIST_ITEMS,
  type MemberId,
  type WorkspaceId,
} from "@mymandev/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type KeyFileSystem,
  nodeKeyFileSystem,
} from "../device-key/atomic-file.ts";
import {
  CLAIM_SEEN_FILE,
  type ClaimSeenMark,
  createClaimSeenStore,
  decodeClaimSeen,
  encodeClaimSeen,
  MAX_CLAIM_SEEN_MARKS,
} from "./seen-store.ts";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OTHER_WORKSPACE = id(0xa2) as WorkspaceId;
const OWN = id(0xc1) as MemberId;
const AT = "2026-11-05T10:00:00.000Z";
const LATER = "2026-11-05T11:00:00.000Z";

function mark(
  workspaceId: WorkspaceId,
  seenAt: string,
  memberId: MemberId = OWN,
): ClaimSeenMark {
  return { workspaceId, memberId, seenAt };
}

let root: string;
let folder: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mymandev-claims-seen-"));
  folder = path.join(root, "MyManDev");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function bytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

describe("the seen claims file", () => {
  test("round trip in the data folder, with IDs and times only, written atomically", async () => {
    const store = createClaimSeenStore({ folder, platform: process.platform });
    expect(await store.read()).toEqual({ kind: "none" });

    const marks = [mark(WORKSPACE, AT), mark(OTHER_WORKSPACE, LATER)];
    await store.write(marks);
    const read = await store.read();
    expect(read).toEqual({ kind: "marks", marks });
    if (read.kind === "marks") {
      expect(Object.isFrozen(read.marks)).toBe(true);
      expect(Object.isFrozen(read.marks[0])).toBe(true);
    }
    const text = await readFile(path.join(folder, CLAIM_SEEN_FILE), "utf8");
    expect(JSON.parse(text)).toEqual({ version: 1, marks });
    // No temporary file stays behind.
    expect(await readdir(folder)).toEqual([CLAIM_SEEN_FILE]);
    if (process.platform !== "win32") {
      const mode = (await stat(path.join(folder, CLAIM_SEEN_FILE))).mode;
      expect(mode & 0o777).toBe(0o600);
    }

    await store.write([mark(WORKSPACE, LATER)]);
    expect(await store.read()).toEqual({
      kind: "marks",
      marks: [mark(WORKSPACE, LATER)],
    });
  });

  test("a workspace and person named twice keep the later mark, in its place", () => {
    const decoded = decodeClaimSeen(
      bytes({
        version: 1,
        marks: [
          mark(WORKSPACE, AT),
          mark(OTHER_WORKSPACE, AT),
          mark(WORKSPACE, LATER),
        ],
      }),
    );
    expect(decoded).toEqual([
      mark(OTHER_WORKSPACE, AT),
      mark(WORKSPACE, LATER),
    ]);
  });

  test("the limit of marks is the most workspaces that one answer lists", () => {
    expect(MAX_CLAIM_SEEN_MARKS).toBe(MAX_ANSWER_LIST_ITEMS);
    const full = Array.from({ length: MAX_CLAIM_SEEN_MARKS }, (_, index) =>
      mark(id(0x10000 + index) as WorkspaceId, AT),
    );
    expect(decodeClaimSeen(encodeClaimSeen(full))).toHaveLength(
      MAX_CLAIM_SEEN_MARKS,
    );
    expect(() => encodeClaimSeen([...full, mark(WORKSPACE, AT)])).toThrow(
      TypeError,
    );
  });

  test.each([
    ["not JSON", Buffer.from("{", "utf8")],
    ["not UTF-8", Buffer.from([0xff, 0xfe])],
    ["another version", bytes({ version: 2, marks: [] })],
    ["no marks", bytes({ version: 1 })],
    ["an extra field", bytes({ version: 1, marks: [], login: "linus" })],
    [
      "a mark with a login",
      bytes({
        version: 1,
        marks: [{ ...mark(WORKSPACE, AT), login: "linus" }],
      }),
    ],
    [
      "a workspace ID outside the format",
      bytes({ version: 1, marks: [mark("workspace" as WorkspaceId, AT)] }),
    ],
    [
      "a person ID in capitals",
      bytes({
        version: 1,
        marks: [mark(WORKSPACE, AT, OWN.toUpperCase() as MemberId)],
      }),
    ],
    [
      "a time without milliseconds",
      bytes({ version: 1, marks: [mark(WORKSPACE, "2026-11-05T10:00:00Z")] }),
    ],
    [
      "a time with an offset",
      bytes({
        version: 1,
        marks: [mark(WORKSPACE, "2026-11-05T10:00:00.000+01:00")],
      }),
    ],
    [
      "too many marks",
      bytes({
        version: 1,
        marks: Array.from({ length: MAX_CLAIM_SEEN_MARKS + 1 }, (_, index) =>
          mark(id(0x10000 + index) as WorkspaceId, AT),
        ),
      }),
    ],
    [
      "a file too large, even of valid JSON",
      Buffer.from(
        JSON.stringify({ version: 1, marks: [] }).padEnd(256 * 1024 + 1, " "),
        "utf8",
      ),
    ],
  ])("%s is corrupt", async (_name, content) => {
    expect(decodeClaimSeen(content)).toBeNull();
    const store = createClaimSeenStore({
      folder: root,
      platform: process.platform,
    });
    await writeFile(path.join(root, CLAIM_SEEN_FILE), content);
    expect(await store.read()).toEqual({ kind: "corrupt" });
  });

  test("a file that cannot be read rejects the read; a write replaces a corrupt file", async () => {
    // A folder in the file's place cannot be read as a file.
    await mkdir(path.join(root, CLAIM_SEEN_FILE));
    const blocked = createClaimSeenStore({
      folder: root,
      platform: process.platform,
    });
    await expect(blocked.read()).rejects.toThrow();

    const store = createClaimSeenStore({ folder, platform: process.platform });
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, CLAIM_SEEN_FILE), "{");
    expect(await store.read()).toEqual({ kind: "corrupt" });
    await store.write([mark(WORKSPACE, AT)]);
    expect(await store.read()).toEqual({
      kind: "marks",
      marks: [mark(WORKSPACE, AT)],
    });
  });

  test("a write goes to a new temporary file, created exclusively, flushed, and renamed over the file", async () => {
    const steps: string[] = [];
    const fileSystem: KeyFileSystem = {
      ...nodeKeyFileSystem,
      open: async (file, flags, mode) => {
        steps.push(`open ${path.basename(file)} ${flags}`);
        const handle = await nodeKeyFileSystem.open(file, flags, mode);
        return {
          writeFile: (data) => {
            steps.push("write");
            return handle.writeFile(data);
          },
          sync: () => {
            steps.push("sync");
            return handle.sync();
          },
          close: () => handle.close(),
        };
      },
      rename: (from, to) => {
        steps.push(`rename ${path.basename(from)} ${path.basename(to)}`);
        return nodeKeyFileSystem.rename(from, to);
      },
    };
    const store = createClaimSeenStore({
      folder,
      platform: "linux",
      fileSystem,
    });
    await store.write([mark(WORKSPACE, AT)]);
    const temporary = steps[0]?.split(" ")[1] ?? "";
    expect(temporary).toMatch(/^claims-seen\.json\.[0-9a-f]{16}\.tmp$/);
    expect(steps.slice(0, 5)).toEqual([
      `open ${temporary} wx`,
      "write",
      "sync",
      `rename ${temporary} ${CLAIM_SEEN_FILE}`,
      // The rename is flushed through the folder.
      "open MyManDev r",
    ]);
    expect(await store.read()).toEqual({
      kind: "marks",
      marks: [mark(WORKSPACE, AT)],
    });
  });

  test("marks outside the format are not written, and the error names no value", async () => {
    const store = createClaimSeenStore({
      folder,
      platform: process.platform,
      fileSystem: nodeKeyFileSystem,
    });
    const value = "not-a-workspace-id";
    const write = store.write([mark(value as WorkspaceId, AT)]);
    await expect(write).rejects.toThrow(
      /^Invalid seen claims field marks\.0\.workspaceId$/,
    );
    await expect(
      store.write([mark(value as WorkspaceId, AT)]),
    ).rejects.not.toThrow(value);
    expect(await store.read()).toEqual({ kind: "none" });
  });
});
