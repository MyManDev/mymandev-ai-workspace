import { expect, test } from "vitest";
import { createMainWindowOptions } from "./window.ts";

test("the window runs its renderer sandboxed, isolated, without Node.js, and with web security on", () => {
  const options = createMainWindowOptions("/app/out/preload/index.cjs", true);

  expect(options.webPreferences).toEqual({
    preload: "/app/out/preload/index.cjs",
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    devTools: false,
  });
});

test("developer tools are available only when the application is not packaged", () => {
  expect(
    createMainWindowOptions("/preload.cjs", false).webPreferences?.devTools,
  ).toBe(true);
  expect(
    createMainWindowOptions("/preload.cjs", true).webPreferences?.devTools,
  ).toBe(false);
});

test("the window starts hidden and carries the product name", () => {
  const options = createMainWindowOptions("/preload.cjs", true);

  expect(options.show).toBe(false);
  expect(options.title).toBe("MyManDev AI Workspace");
});
