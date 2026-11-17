import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  LINK_CONFIRMATION,
  linkConfirmationMessage,
  linkConfirmed,
} from "./confirmation.ts";

test("the confirmation is a question with Link first and Cancel as the default and the cancel button", () => {
  expect(LINK_CONFIRMATION).toMatchObject({
    type: "question",
    buttons: ["Link", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "Link a repository",
  });
  expect(LINK_CONFIRMATION.detail).toContain("never sent to the server");
  expect(LINK_CONFIRMATION.detail).toContain("link it again");
  expect(Object.isFrozen(LINK_CONFIRMATION)).toBe(true);
  expect(Object.isFrozen(LINK_CONFIRMATION.buttons)).toBe(true);
});

test("only the Link button confirms; Cancel, Escape, and a closed dialog do not", () => {
  expect(linkConfirmed({ response: 0 })).toBe(true);
  for (const response of [1, 2, -1, Number.NaN]) {
    expect(linkConfirmed({ response })).toBe(false);
  }
});

test("the message names the registered repository and the folder, with hiding and reordering characters replaced", () => {
  expect(
    linkConfirmationMessage({
      name: "web app",
      folder: "C:\\Users\\ada\\web",
    }),
  ).toBe('Link the repository "web app" to the folder C:\\Users\\ada\\web?');
  const message = linkConfirmationMessage({
    name: "web\u202Eppa",
    folder: "/home/ada/\u200Bweb\n",
  });
  expect(message).toBe(
    'Link the repository "web\uFFFDppa" to the folder /home/ada/\uFFFDweb\uFFFD?',
  );
});

test("the entry point confirms a link with the main process's own dialog on the main window and identifies folders with lstat", () => {
  const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  expect(entry).toMatch(
    /identify: \(folders\) => readFolderIdentity\(systemLstat, folders\),/u,
  );
  expect(entry).toMatch(
    /confirmLink: async \(request\) => \{\s+const options = \{\s+\.\.\.LINK_CONFIRMATION,\s+buttons: \[\.\.\.LINK_CONFIRMATION\.buttons\],\s+message: linkConfirmationMessage\(request\),\s+\};\s+return linkConfirmed\(\s+mainWindow === undefined\s+\? await dialog\.showMessageBox\(options\)\s+: await dialog\.showMessageBox\(mainWindow, options\),\s+\);\s+\},/u,
  );
});
