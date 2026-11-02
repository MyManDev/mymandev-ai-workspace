import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DATA_FOLDER_NAME, PRODUCT_NAME } from "../shared/product.ts";
import {
  claimDataFolder,
  dataFolderPath,
  type DataFolderHost,
  type MakeFolder,
} from "./data-folder.ts";

const APP_DATA = path.join(path.sep, "home", "ada", ".config");

/**
 * An application that records its calls in order. Like Electron, it names
 * the data folder after the package until `setPath` changes it, and takes
 * the single-instance lock in the data folder of that moment.
 */
function fakeApp(options: { appData?: string; lockFree?: boolean } = {}) {
  const calls: string[] = [];
  const paths = {
    appData: options.appData ?? APP_DATA,
    userData: path.join(options.appData ?? APP_DATA, "@mymandev", "desktop"),
  };
  const record: { lockFolder?: string; madeFolders: string[] } = {
    madeFolders: [],
  };
  const host: DataFolderHost = {
    getPath: (name) => {
      calls.push(`getPath ${name}`);
      return paths[name];
    },
    setPath: (name, folder) => {
      calls.push(`setPath ${name}`);
      paths[name] = folder;
    },
    requestSingleInstanceLock: () => {
      calls.push("requestSingleInstanceLock");
      record.lockFolder = paths.userData;
      return options.lockFree ?? true;
    },
  };
  const makeFolder: MakeFolder = (folder) => {
    calls.push("makeFolder");
    record.madeFolders.push(folder);
  };
  return { host, makeFolder, calls, record };
}

/**
 * Whether `claimDataFolder(app)` is the first use of `app` in the code of a
 * Prettier-formatted module, after its imports and without its comments.
 */
function claimsDataFolderFirst(source: string): boolean {
  const code = source
    .replace(/^import\b[^;]*;/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const claim = code.indexOf("claimDataFolder(app)");
  return (
    claim !== -1 && code.search(/\bapp\b/) === claim + "claimDataFolder(".length
  );
}

test("the data folder is named MyManDev, apart from the product name", () => {
  expect(DATA_FOLDER_NAME).toBe("MyManDev");
  expect(PRODUCT_NAME).toBe("MyManDev AI Workspace");
});

test("the data folder is MyManDev in the application data folder on Windows, macOS, and Linux", () => {
  expect(dataFolderPath("C:\\Users\\ada\\AppData\\Roaming", path.win32)).toBe(
    "C:\\Users\\ada\\AppData\\Roaming\\MyManDev",
  );
  expect(
    dataFolderPath("/Users/ada/Library/Application Support", path.posix),
  ).toBe("/Users/ada/Library/Application Support/MyManDev");
  expect(dataFolderPath("/home/ada/.config", path.posix)).toBe(
    "/home/ada/.config/MyManDev",
  );
});

test("the data folder is created and set before the single-instance lock is taken in it", () => {
  const app = fakeApp();

  expect(claimDataFolder(app.host, app.makeFolder)).toBe(true);

  const folder = path.join(APP_DATA, "MyManDev");
  expect(app.calls).toEqual([
    "getPath appData",
    "makeFolder",
    "setPath userData",
    "requestSingleInstanceLock",
  ]);
  expect(app.record.madeFolders).toEqual([folder]);
  expect(app.record.lockFolder).toBe(folder);
});

test("a second instance looks for the lock in the same data folder and learns that another instance holds it", () => {
  const app = fakeApp({ lockFree: false });

  expect(claimDataFolder(app.host, app.makeFolder)).toBe(false);
  expect(app.record.lockFolder).toBe(path.join(APP_DATA, "MyManDev"));
});

test("a missing data folder is created, for its owner only on Linux and macOS, and an existing one is kept", async () => {
  const appData = await mkdtemp(path.join(tmpdir(), "mymandev-data-folder-"));
  try {
    const folder = path.join(appData, "MyManDev");

    expect(claimDataFolder(fakeApp({ appData }).host)).toBe(true);
    const stats = await stat(folder);
    expect(stats.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(stats.mode & 0o777).toBe(0o700);
    }

    await writeFile(path.join(folder, "kept"), "");
    expect(claimDataFolder(fakeApp({ appData }).host)).toBe(true);
    expect(await readdir(folder)).toEqual(["kept"]);
  } finally {
    await rm(appData, { recursive: true, force: true });
  }
});

test("the check finds a use of app before the data folder is claimed", () => {
  expect(
    claimsDataFolderFirst(
      [
        'import { app } from "electron";',
        "// claimDataFolder(app) in a comment does not count.",
        "const packaged = app.isPackaged;",
        "if (claimDataFolder(app)) {",
        "  start();",
        "}",
      ].join("\n"),
    ),
  ).toBe(false);
  expect(
    claimsDataFolderFirst(
      [
        'import { app } from "electron";',
        "app.requestSingleInstanceLock();",
      ].join("\n"),
    ),
  ).toBe(false);
  expect(
    claimsDataFolderFirst(
      [
        'import { app } from "electron";',
        "// The app starts here.",
        "if (claimDataFolder(app)) {",
        "  start(app.isPackaged);",
        "}",
      ].join("\n"),
    ),
  ).toBe(true);
});

test("the main process claims the data folder before it uses Electron's app for anything else", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  expect(claimsDataFolderFirst(source)).toBe(true);
  expect(source).not.toMatch(
    /\b(?:setPath|requestSingleInstanceLock)\b|getPath\(\s*["']userData/,
  );
});
