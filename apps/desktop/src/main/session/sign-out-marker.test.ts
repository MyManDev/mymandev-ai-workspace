import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createSignOutMarkerStore,
  decodeSignOutMarker,
  encodeSignOutMarker,
  SIGN_OUT_MARKER_FILE,
} from "./sign-out-marker.ts";

/** A raw Ed25519 public key as 64 hexadecimal characters. */
function publicKey(): string {
  const { x } = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  });
  return Buffer.from(x ?? "", "base64url").toString("hex");
}

let root: string;
let folder: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mymandev-sign-out-marker-"));
  folder = path.join(root, "MyManDev");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function bytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

describe("the sign-out marker", () => {
  test("round trip in the key folder, then delete", async () => {
    const store = createSignOutMarkerStore({
      folder,
      platform: process.platform,
    });
    const keys = [publicKey(), publicKey()];
    expect(await store.read()).toEqual({ kind: "none" });

    await store.write({ publicKeys: keys, reported: false });
    expect(await store.read()).toEqual({
      kind: "marker",
      marker: { publicKeys: keys, reported: false },
    });
    const text = await readFile(
      path.join(folder, SIGN_OUT_MARKER_FILE),
      "utf8",
    );
    expect(JSON.parse(text)).toEqual({
      version: 1,
      publicKeys: keys,
      reported: false,
    });
    if (process.platform !== "win32") {
      const mode = (await stat(path.join(folder, SIGN_OUT_MARKER_FILE))).mode;
      expect(mode & 0o777).toBe(0o600);
    }

    await store.write({ publicKeys: keys, reported: true });
    expect(await store.read()).toMatchObject({ marker: { reported: true } });

    await store.delete();
    expect(await store.read()).toEqual({ kind: "none" });
    await store.delete();
  });

  test("a key named twice is written once", () => {
    const key = publicKey();
    const decoded = decodeSignOutMarker(
      encodeSignOutMarker({ publicKeys: [key, key], reported: false }),
    );
    expect(decoded?.publicKeys).toEqual([key]);
  });

  test.each([
    ["not JSON", Buffer.from("{", "utf8")],
    ["not UTF-8", Buffer.from([0xff, 0xfe])],
    ["another version", bytes({ version: 2, publicKeys: [], reported: false })],
    [
      "an extra field",
      bytes({
        version: 1,
        publicKeys: ["a".repeat(64)],
        reported: false,
        token: "x",
      }),
    ],
    ["a missing field", bytes({ version: 1, publicKeys: ["a".repeat(64)] })],
    ["no key", bytes({ version: 1, publicKeys: [], reported: false })],
    [
      "a key outside the format",
      bytes({ version: 1, publicKeys: ["A".repeat(64)], reported: false }),
    ],
    [
      "too many keys",
      bytes({
        version: 1,
        publicKeys: ["a", "b", "c", "d"].map((c) => c.repeat(64)),
        reported: false,
      }),
    ],
    ["a file too large", Buffer.alloc(5000, 0x20)],
  ])("%s is corrupt", async (_name, content) => {
    expect(decodeSignOutMarker(content)).toBeNull();
    const store = createSignOutMarkerStore({
      folder: root,
      platform: process.platform,
    });
    await writeFile(path.join(root, SIGN_OUT_MARKER_FILE), content);
    expect(await store.read()).toEqual({ kind: "corrupt" });
  });

  test("a marker outside the format is not written, and the error names no value", async () => {
    const store = createSignOutMarkerStore({
      folder,
      platform: process.platform,
    });
    const secret = "not-a-public-key-value";
    await expect(
      store.write({ publicKeys: [secret], reported: false }),
    ).rejects.toThrow(/^Invalid sign-out marker field publicKeys\.0$/);
    await expect(
      store.write({ publicKeys: [secret], reported: false }),
    ).rejects.not.toThrow(secret);
    expect(await store.read()).toEqual({ kind: "none" });
  });
});
