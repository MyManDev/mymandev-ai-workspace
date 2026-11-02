import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createSessionNotesStore,
  decodeSessionNotes,
  NO_SESSION_NOTES,
  SESSION_NOTES_FILE,
  type SessionNotes,
} from "./session-notes.ts";

const DEVICE_ID = "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3";
const AT = "2026-11-02T10:00:00.000Z";

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
  root = await mkdtemp(path.join(tmpdir(), "mymandev-session-notes-"));
  folder = path.join(root, "MyManDev");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function bytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

test("round trip in the key folder; empty notes delete the file", async () => {
  const store = createSessionNotesStore({ folder, platform: process.platform });
  const keys: [string, string] = [publicKey(), publicKey()];
  const notes: SessionNotes = {
    removal: { deviceId: DEVICE_ID },
    uncertainSignIn: { publicKey: keys[0], at: AT },
    keysRefused: { publicKeys: keys, at: AT },
  };
  expect(await store.read()).toEqual({ kind: "none" });

  await store.write(notes);
  expect(await store.read()).toEqual({ kind: "notes", notes });
  expect(
    JSON.parse(await readFile(path.join(folder, SESSION_NOTES_FILE), "utf8")),
  ).toEqual({ version: 1, ...notes });

  await store.write(NO_SESSION_NOTES);
  expect(await store.read()).toEqual({ kind: "none" });
  await store.write(NO_SESSION_NOTES);
});

const valid = {
  version: 1,
  removal: null,
  uncertainSignIn: null,
  keysRefused: null,
};

test.each([
  ["not JSON", Buffer.from("{", "utf8")],
  ["another version", bytes({ ...valid, version: 2 })],
  ["an extra field", bytes({ ...valid, token: "x" })],
  ["a missing field", bytes({ version: 1, removal: null })],
  [
    "a device ID outside the format",
    bytes({ ...valid, removal: { deviceId: "x" } }),
  ],
  [
    "a time outside the format",
    bytes({
      ...valid,
      uncertainSignIn: { publicKey: "a".repeat(64), at: "yesterday" },
    }),
  ],
  [
    "one refused key only",
    bytes({
      ...valid,
      keysRefused: { publicKeys: ["a".repeat(64)], at: AT },
    }),
  ],
  ["a file too large", Buffer.alloc(5000, 0x20)],
])("%s is corrupt", async (_name, content) => {
  expect(decodeSessionNotes(content)).toBeNull();
  const store = createSessionNotesStore({
    folder: root,
    platform: process.platform,
  });
  await writeFile(path.join(root, SESSION_NOTES_FILE), content);
  expect(await store.read()).toEqual({ kind: "corrupt" });
});

test("notes outside the format are not written, and the error names no value", async () => {
  const store = createSessionNotesStore({ folder, platform: process.platform });
  await expect(
    store.write({ ...NO_SESSION_NOTES, removal: { deviceId: "secret-value" } }),
  ).rejects.toThrow(/^Invalid session notes field removal\.deviceId$/);
  expect(await store.read()).toEqual({ kind: "none" });
});
