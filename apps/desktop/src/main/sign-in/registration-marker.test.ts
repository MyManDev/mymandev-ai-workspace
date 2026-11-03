import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createRegistrationMarkerStore,
  decodeRegistrationMarker,
  encodeRegistrationMarker,
  REGISTRATION_MARKER_FILE,
} from "./registration-marker.ts";

/** A raw Ed25519 public key as 64 hexadecimal characters. */
function publicKey(): string {
  const { x } = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  });
  return Buffer.from(x ?? "", "base64url").toString("hex");
}

const AT = "2026-11-03T10:00:00.000Z";

let root: string;
let folder: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mymandev-registration-marker-"));
  folder = path.join(root, "MyManDev");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function bytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

describe("the registration marker", () => {
  test("round trip in the key folder, then delete", async () => {
    const store = createRegistrationMarkerStore({
      folder,
      platform: process.platform,
    });
    const key = publicKey();
    expect(await store.read()).toEqual({ kind: "none" });

    await store.write({ publicKey: key, at: AT });
    expect(await store.read()).toEqual({
      kind: "marker",
      marker: { publicKey: key, at: AT },
    });
    const text = await readFile(
      path.join(folder, REGISTRATION_MARKER_FILE),
      "utf8",
    );
    expect(JSON.parse(text)).toEqual({ version: 1, publicKey: key, at: AT });
    if (process.platform !== "win32") {
      const mode = (await stat(path.join(folder, REGISTRATION_MARKER_FILE)))
        .mode;
      expect(mode & 0o777).toBe(0o600);
    }

    await store.delete();
    expect(await store.read()).toEqual({ kind: "none" });
    await store.delete();
  });

  test("decodes what it encodes", () => {
    const marker = { publicKey: publicKey(), at: AT };
    expect(decodeRegistrationMarker(encodeRegistrationMarker(marker))).toEqual(
      marker,
    );
  });

  test.each([
    ["not JSON", Buffer.from("{", "utf8")],
    ["not UTF-8", Buffer.from([0xff, 0xfe])],
    [
      "another version",
      bytes({ version: 2, publicKey: "a".repeat(64), at: AT }),
    ],
    [
      "an extra field",
      bytes({ version: 1, publicKey: "a".repeat(64), at: AT, deviceId: "x" }),
    ],
    ["a missing time", bytes({ version: 1, publicKey: "a".repeat(64) })],
    ["a missing key", bytes({ version: 1, at: AT })],
    [
      "a key outside the format",
      bytes({ version: 1, publicKey: "A".repeat(64), at: AT }),
    ],
    [
      "a time outside the format",
      bytes({ version: 1, publicKey: "a".repeat(64), at: "2026-11-03" }),
    ],
    ["a file too large", Buffer.alloc(5000, 0x20)],
  ])("%s is corrupt", async (_name, content) => {
    expect(decodeRegistrationMarker(content)).toBeNull();
    const store = createRegistrationMarkerStore({
      folder: root,
      platform: process.platform,
    });
    await writeFile(path.join(root, REGISTRATION_MARKER_FILE), content);
    expect(await store.read()).toEqual({ kind: "corrupt" });
  });

  test("a marker outside the format is not written, and the error names no value", async () => {
    const store = createRegistrationMarkerStore({
      folder,
      platform: process.platform,
    });
    const secret = "not-a-public-key-value";
    await expect(store.write({ publicKey: secret, at: AT })).rejects.toThrow(
      /^Invalid registration marker field publicKey$/,
    );
    await expect(
      store.write({ publicKey: secret, at: AT }),
    ).rejects.not.toThrow(secret);
    expect(await store.read()).toEqual({ kind: "none" });
  });
});
