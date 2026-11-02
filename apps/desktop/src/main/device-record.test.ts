import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DeviceId, UserId } from "@mymandev/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createDeviceRecordStore,
  DEVICE_RECORD_FILE,
  type DeviceRecord,
} from "./device-record.ts";

const RECORD: DeviceRecord = Object.freeze({
  deviceId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a3" as DeviceId,
  userId: "0192f2a0-7c3e-7a1b-8c4d-5e6f708192a4" as UserId,
  login: "octocat",
  displayName: "The Octocat",
  signInExpiresAt: "2026-12-02T10:00:00.000Z",
});

let root: string;
let folder: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mymandev-device-record-"));
  folder = path.join(root, "MyManDev");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function store() {
  return createDeviceRecordStore({ folder, platform: process.platform });
}

describe("createDeviceRecordStore", () => {
  test("reads none when no record exists", async () => {
    expect(await store().read()).toEqual({ kind: "none" });
  });

  test("writes a versioned record and reads it back", async () => {
    await store().write(RECORD);
    expect(await store().read()).toEqual({ kind: "record", record: RECORD });
    const file = JSON.parse(
      await readFile(path.join(folder, DEVICE_RECORD_FILE), "utf8"),
    ) as unknown;
    expect(file).toEqual({ version: 1, ...RECORD });
    // The atomic write leaves no temporary file behind.
    expect(await readdir(folder)).toEqual([DEVICE_RECORD_FILE]);
  });

  test("replaces a record", async () => {
    await store().write(RECORD);
    const next = { ...RECORD, displayName: "Mona" };
    await store().write(next);
    expect(await store().read()).toEqual({ kind: "record", record: next });
  });

  test("deletes a record, and a missing one is not an error", async () => {
    await store().write(RECORD);
    await store().delete();
    expect(await store().read()).toEqual({ kind: "none" });
    await store().delete();
  });

  test.each([
    ["not JSON", "{"],
    ["JSON that is not an object", "[]"],
    ["a missing version", JSON.stringify({ ...RECORD })],
    ["another version", JSON.stringify({ version: 2, ...RECORD })],
    ["an unknown field", JSON.stringify({ version: 1, ...RECORD, extra: 1 })],
    [
      "an uppercase device ID",
      JSON.stringify({
        version: 1,
        ...RECORD,
        deviceId: RECORD.deviceId.toUpperCase(),
      }),
    ],
    [
      "a login outside the format",
      JSON.stringify({ version: 1, ...RECORD, login: "octo cat" }),
    ],
    [
      "a timestamp outside the format",
      JSON.stringify({ version: 1, ...RECORD, signInExpiresAt: "tomorrow" }),
    ],
    ["a file that is too large", " ".repeat(5000)],
  ])("reads %s as corrupt", async (_name, content) => {
    await store().write(RECORD);
    await writeFile(path.join(folder, DEVICE_RECORD_FILE), content);
    expect(await store().read()).toEqual({ kind: "corrupt" });
  });

  test("reads invalid UTF-8 as corrupt", async () => {
    await store().write(RECORD);
    await writeFile(
      path.join(folder, DEVICE_RECORD_FILE),
      Buffer.from([0x7b, 0xff, 0x7d]),
    );
    expect(await store().read()).toEqual({ kind: "corrupt" });
  });

  test("refuses to write a record outside the format, without its value", async () => {
    const error = await store()
      .write({ ...RECORD, login: "secret but invalid" })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe("Invalid device record field login");
    expect(await store().read()).toEqual({ kind: "none" });
  });
});
