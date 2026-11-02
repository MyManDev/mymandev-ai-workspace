import { expect, test } from "vitest";
import {
  DATA_FOLDER_NAME,
  LOCAL_DATA_FOLDER_NAME,
} from "../../shared/product.ts";
import { isDeviceKeyError } from "./errors.ts";
import { deviceKeyFolder } from "./key-folder.ts";

const ROAMING_USER_DATA = "C:\\Users\\ada\\AppData\\Roaming\\MyManDev";

function folderError(env: Record<string, string | undefined>): unknown {
  try {
    deviceKeyFolder({ platform: "win32", env, userData: ROAMING_USER_DATA });
  } catch (error) {
    return error;
  }
  return undefined;
}

test("the local data folder is named MyManDev, like the data folder", () => {
  expect(LOCAL_DATA_FOLDER_NAME).toBe("MyManDev");
  expect(DATA_FOLDER_NAME).toBe("MyManDev");
});

test("on Windows the key is stored in the local application data folder, not the roaming data folder", () => {
  const folder = deviceKeyFolder({
    platform: "win32",
    env: {
      APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
    },
    userData: ROAMING_USER_DATA,
  });

  expect(folder).toBe("C:\\Users\\ada\\AppData\\Local\\MyManDev");
  expect(folder.startsWith("C:\\Users\\ada\\AppData\\Roaming")).toBe(false);
});

test("on Windows a local application data folder on a network share is used as it is", () => {
  expect(
    deviceKeyFolder({
      platform: "win32",
      env: { LOCALAPPDATA: "\\\\server\\profiles\\ada\\Local" },
      userData: ROAMING_USER_DATA,
    }),
  ).toBe("\\\\server\\profiles\\ada\\Local\\MyManDev");
});

test("on Windows a missing or relative LOCALAPPDATA is an error, never a fallback to the roaming folder", () => {
  for (const env of [
    {},
    { LOCALAPPDATA: undefined },
    { LOCALAPPDATA: "" },
    { LOCALAPPDATA: "AppData\\Local" },
    { LOCALAPPDATA: "C:" },
    { LOCALAPPDATA: "C:AppData\\Local" },
    { LOCALAPPDATA: "\\Users\\ada\\AppData\\Local" },
    // Another variable is not read in its place.
    { localappdata_fallback: "C:\\Users\\ada\\AppData\\Local" },
  ]) {
    expect(
      isDeviceKeyError(folderError(env), "local_data_folder_missing"),
    ).toBe(true);
  }
});

test("on macOS and Linux the key is stored in the data folder, and LOCALAPPDATA is ignored", () => {
  const env = { LOCALAPPDATA: "/tmp/elsewhere" };

  expect(
    deviceKeyFolder({
      platform: "darwin",
      env,
      userData: "/Users/ada/Library/Application Support/MyManDev",
    }),
  ).toBe("/Users/ada/Library/Application Support/MyManDev");
  expect(
    deviceKeyFolder({
      platform: "linux",
      env,
      userData: "/home/ada/.config/MyManDev",
    }),
  ).toBe("/home/ada/.config/MyManDev");
  expect(
    deviceKeyFolder({
      platform: "linux",
      env: {},
      userData: "/home/ada/.config/MyManDev",
    }),
  ).toBe("/home/ada/.config/MyManDev");
});
