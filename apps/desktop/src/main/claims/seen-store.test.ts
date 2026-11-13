import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type MemberId,
  RECENT_CLAIMS,
  type WorkspaceId,
} from "@mymandev/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type KeyFileSystem,
  nodeKeyFileSystem,
} from "../device-key/atomic-file.ts";
import {
  CLAIM_SEEN_FILE,
  CLAIM_SEEN_VERSION,
  type ClaimSeenEntry,
  createClaimSeenStore,
  decodeClaimSeen,
  encodeClaimSeen,
  MAX_CLAIM_SEEN_ENTRIES,
  MAX_SEEN_CLAIMS_PER_ENTRY,
} from "./seen-store.ts";

/** A lowercase UUIDv7 that ends in `n`. */
function id(n: number): string {
  return `0192f0a0-7b3c-7d4e-8f50-${n.toString(16).padStart(12, "0")}`;
}

const WORKSPACE = id(0xa1) as WorkspaceId;
const OTHER_WORKSPACE = id(0xa2) as WorkspaceId;
const OWN = id(0xc1) as MemberId;
const FIRST = id(0xd1) as MemberId;
const SECOND = id(0xd2) as MemberId;

function entry(
  workspaceId: WorkspaceId,
  seenMemberIds: readonly MemberId[],
  ownMemberId: MemberId = OWN,
): ClaimSeenEntry {
  return { workspaceId, ownMemberId, seenMemberIds };
}

/** A full entry: `MAX_SEEN_CLAIMS_PER_ENTRY` seen claims. */
function fullEntry(workspaceId: WorkspaceId): ClaimSeenEntry {
  return entry(
    workspaceId,
    Array.from(
      { length: MAX_SEEN_CLAIMS_PER_ENTRY },
      (_, index) => id(0x20000 + index) as MemberId,
    ),
  );
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
  test("round trip in the data folder, with IDs only, written atomically", async () => {
    const store = createClaimSeenStore({ folder, platform: process.platform });
    expect(await store.read()).toEqual({ kind: "none" });

    const entries = [
      entry(WORKSPACE, [FIRST, SECOND]),
      entry(OTHER_WORKSPACE, []),
    ];
    await store.write(entries);
    const read = await store.read();
    expect(read).toEqual({ kind: "entries", entries });
    if (read.kind === "entries") {
      expect(Object.isFrozen(read.entries)).toBe(true);
      expect(Object.isFrozen(read.entries[0])).toBe(true);
      expect(Object.isFrozen(read.entries[0]?.seenMemberIds)).toBe(true);
    }
    const text = await readFile(path.join(folder, CLAIM_SEEN_FILE), "utf8");
    expect(JSON.parse(text)).toEqual({ version: 2, entries });
    expect(CLAIM_SEEN_VERSION).toBe(2);
    // No temporary file stays behind.
    expect(await readdir(folder)).toEqual([CLAIM_SEEN_FILE]);
    if (process.platform !== "win32") {
      const mode = (await stat(path.join(folder, CLAIM_SEEN_FILE))).mode;
      expect(mode & 0o777).toBe(0o600);
    }

    await store.write([entry(WORKSPACE, [SECOND])]);
    expect(await store.read()).toEqual({
      kind: "entries",
      entries: [entry(WORKSPACE, [SECOND])],
    });
  });

  test("a workspace and person named twice keep the later entry, in its place, and a member ID named twice counts once", () => {
    const decoded = decodeClaimSeen(
      bytes({
        version: 2,
        entries: [
          entry(WORKSPACE, [FIRST]),
          entry(OTHER_WORKSPACE, [FIRST, FIRST]),
          entry(WORKSPACE, [SECOND]),
        ],
      }),
    );
    expect(decoded).toEqual([
      entry(OTHER_WORKSPACE, [FIRST]),
      entry(WORKSPACE, [SECOND]),
    ]);
  });

  test("the limits: one entry holds the claims that the API lists, and a full file fits the size cap", () => {
    expect(MAX_SEEN_CLAIMS_PER_ENTRY).toBe(RECENT_CLAIMS);
    const full = Array.from({ length: MAX_CLAIM_SEEN_ENTRIES }, (_, index) =>
      fullEntry(id(0x10000 + index) as WorkspaceId),
    );
    const encoded = encodeClaimSeen(full);
    expect(encoded.length).toBeLessThan(512 * 1024);
    expect(decodeClaimSeen(encoded)).toHaveLength(MAX_CLAIM_SEEN_ENTRIES);
    expect(() => encodeClaimSeen([...full, entry(WORKSPACE, [])])).toThrow(
      TypeError,
    );
    const over = fullEntry(WORKSPACE);
    expect(() =>
      encodeClaimSeen([entry(WORKSPACE, [...over.seenMemberIds, FIRST])]),
    ).toThrow(TypeError);
  });

  test.each([
    ["not JSON", Buffer.from("{", "utf8")],
    ["not UTF-8", Buffer.from([0xff, 0xfe])],
    [
      "a file of version 1, which kept a time and never shipped",
      bytes({
        version: 1,
        marks: [
          {
            workspaceId: WORKSPACE,
            memberId: OWN,
            seenAt: "2026-11-05T10:00:00.000Z",
          },
        ],
      }),
    ],
    ["another version", bytes({ version: 3, entries: [] })],
    ["no entries", bytes({ version: 2 })],
    ["an extra field", bytes({ version: 2, entries: [], login: "linus" })],
    [
      "an entry with a login",
      bytes({
        version: 2,
        entries: [{ ...entry(WORKSPACE, [FIRST]), login: "linus" }],
      }),
    ],
    [
      "an entry with a time",
      bytes({
        version: 2,
        entries: [
          { ...entry(WORKSPACE, [FIRST]), seenAt: "2026-11-05T10:00:00.000Z" },
        ],
      }),
    ],
    [
      "an entry without its seen claims",
      bytes({
        version: 2,
        entries: [{ workspaceId: WORKSPACE, ownMemberId: OWN }],
      }),
    ],
    [
      "a workspace ID outside the format",
      bytes({
        version: 2,
        entries: [entry("workspace" as WorkspaceId, [FIRST])],
      }),
    ],
    [
      "an own member ID in capitals",
      bytes({
        version: 2,
        entries: [entry(WORKSPACE, [FIRST], OWN.toUpperCase() as MemberId)],
      }),
    ],
    [
      "a seen member ID outside the format",
      bytes({
        version: 2,
        entries: [entry(WORKSPACE, ["linus" as MemberId])],
      }),
    ],
    [
      "too many seen claims in an entry",
      bytes({
        version: 2,
        entries: [
          entry(WORKSPACE, [...fullEntry(WORKSPACE).seenMemberIds, FIRST]),
        ],
      }),
    ],
    [
      "too many entries",
      bytes({
        version: 2,
        entries: Array.from(
          { length: MAX_CLAIM_SEEN_ENTRIES + 1 },
          (_, index) => entry(id(0x10000 + index) as WorkspaceId, []),
        ),
      }),
    ],
    [
      "a file too large, even of valid JSON",
      Buffer.from(
        JSON.stringify({ version: 2, entries: [] }).padEnd(512 * 1024 + 1, " "),
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
    await store.write([entry(WORKSPACE, [FIRST])]);
    expect(await store.read()).toEqual({
      kind: "entries",
      entries: [entry(WORKSPACE, [FIRST])],
    });
  });

  test("a read deletes the temporary files that a stopped write left, and nothing else", async () => {
    await mkdir(folder, { recursive: true });
    const store = createClaimSeenStore({ folder, platform: process.platform });
    await store.write([entry(WORKSPACE, [FIRST])]);
    const left = [
      `${CLAIM_SEEN_FILE}.0123456789abcdef.tmp`,
      `${CLAIM_SEEN_FILE}.fedcba9876543210.tmp`,
    ];
    const kept = [
      // Not a temporary file of this store's form.
      `${CLAIM_SEEN_FILE}.0123.tmp`,
      `${CLAIM_SEEN_FILE}.0123456789abcdeg.tmp`,
      "device-key.json.0123456789abcdef.tmp",
      "Preferences",
    ];
    for (const name of [...left, ...kept]) {
      await writeFile(path.join(folder, name), "x");
    }
    expect(await store.read()).toEqual({
      kind: "entries",
      entries: [entry(WORKSPACE, [FIRST])],
    });
    expect((await readdir(folder)).sort()).toEqual(
      [CLAIM_SEEN_FILE, ...kept].sort(),
    );

    // A folder that cannot be listed leaves the read as it is.
    const missing = createClaimSeenStore({
      folder: path.join(root, "missing"),
      platform: process.platform,
    });
    expect(await missing.read()).toEqual({ kind: "none" });
    const failing = createClaimSeenStore({
      folder,
      platform: process.platform,
      fileSystem: {
        ...nodeKeyFileSystem,
        readdir: () => Promise.reject(new Error("EACCES")),
      },
    });
    expect(await failing.read()).toEqual({
      kind: "entries",
      entries: [entry(WORKSPACE, [FIRST])],
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
    await store.write([entry(WORKSPACE, [FIRST])]);
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
      kind: "entries",
      entries: [entry(WORKSPACE, [FIRST])],
    });
  });

  test("entries outside the format are not written, and the error names no value", async () => {
    const store = createClaimSeenStore({
      folder,
      platform: process.platform,
      fileSystem: nodeKeyFileSystem,
    });
    const value = "not-a-member-id";
    const write = store.write([entry(WORKSPACE, [value as MemberId])]);
    await expect(write).rejects.toThrow(
      /^Invalid seen claims field entries\.0\.seenMemberIds\.0$/,
    );
    await expect(
      store.write([entry(WORKSPACE, [value as MemberId])]),
    ).rejects.not.toThrow(value);
    expect(await store.read()).toEqual({ kind: "none" });
  });
});
