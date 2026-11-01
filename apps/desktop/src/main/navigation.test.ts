import { expect, test } from "vitest";
import { isAppNavigation, resolveRendererUrl } from "./navigation.ts";

const APP = "app://renderer/index.html";

test("a packaged application always loads its built files from app://renderer", () => {
  for (const devServerUrl of [
    "http://localhost:5173",
    "https://example.com",
    undefined,
  ]) {
    expect(resolveRendererUrl({ isPackaged: true, devServerUrl })).toBe(APP);
  }
});

test("during development the loopback development server is used when it is set", () => {
  for (const devServerUrl of [undefined, ""]) {
    expect(resolveRendererUrl({ isPackaged: false, devServerUrl })).toBe(APP);
  }
  for (const [devServerUrl, expected] of [
    ["http://localhost:5173", "http://localhost:5173/"],
    ["http://127.0.0.1:5173/", "http://127.0.0.1:5173/"],
    ["http://[::1]:5173", "http://[::1]:5173/"],
  ] as const) {
    expect(resolveRendererUrl({ isPackaged: false, devServerUrl })).toBe(
      expected,
    );
  }
});

test("a development server URL that is not http on a loopback host is refused", () => {
  for (const devServerUrl of [
    "https://example.com",
    "http://example.com:5173",
    "http://192.168.1.10:5173",
    "http://localhost.example.com:5173",
    "file:///etc/passwd",
    "app://renderer/",
    "not a url",
  ]) {
    expect(() =>
      resolveRendererUrl({ isPackaged: false, devServerUrl }),
    ).toThrow(/ELECTRON_RENDERER_URL/);
  }
});

test("navigation stays on the development server's origin", () => {
  const app = "http://localhost:5173/";

  expect(isAppNavigation("http://localhost:5173/", app)).toBe(true);
  expect(isAppNavigation("http://localhost:5173/index.html?x=1", app)).toBe(
    true,
  );
  expect(isAppNavigation("http://localhost:5174/", app)).toBe(false);
  expect(isAppNavigation("https://localhost:5173/", app)).toBe(false);
  expect(isAppNavigation("http://127.0.0.1:5173/", app)).toBe(false);
  expect(isAppNavigation("https://github.com/", app)).toBe(false);
  expect(isAppNavigation(APP, app)).toBe(false);
});

test("navigation with built files stays on app://renderer/index.html", () => {
  expect(isAppNavigation(APP, APP)).toBe(true);
  expect(isAppNavigation(`${APP}#about`, APP)).toBe(true);
  expect(isAppNavigation("app://renderer/", APP)).toBe(false);
  expect(isAppNavigation("app://renderer/assets/index-a1.js", APP)).toBe(false);
  expect(isAppNavigation(`${APP}?x=1`, APP)).toBe(false);
  expect(isAppNavigation("app://other/index.html", APP)).toBe(false);
  expect(isAppNavigation("app://renderer:8080/index.html", APP)).toBe(false);
  expect(isAppNavigation("file:///app/out/renderer/index.html", APP)).toBe(
    false,
  );
  expect(isAppNavigation("https://renderer/index.html", APP)).toBe(false);
  expect(isAppNavigation("https://github.com/", APP)).toBe(false);
});

test("an invalid URL or an application URL without a host never allows a navigation", () => {
  expect(isAppNavigation("not a url", APP)).toBe(false);
  expect(isAppNavigation("", "http://localhost:5173/")).toBe(false);
  expect(isAppNavigation(APP, "not a url")).toBe(false);
  expect(isAppNavigation("file:///etc/passwd", "file:///app/index.html")).toBe(
    false,
  );
});
