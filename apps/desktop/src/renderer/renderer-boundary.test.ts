import { expect, test } from "vitest";

// The source files of the renderer and of the shared code, without the
// tests, as text. A screen reaches the main process only through the props
// that main.tsx passes from `window.desktop`.
const SOURCES = import.meta.glob<string>(
  ["./**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "!./**/*.test.*"],
  { query: "?raw", import: "default", eager: true },
);
const SHARED_SOURCES = import.meta.glob<string>(
  ["../shared/*.{ts,mts,cts,js,mjs,cjs}", "!../shared/*.test.*"],
  { query: "?raw", import: "default", eager: true },
);
// Relative specifiers are resolved against these made-up locations, so that
// a path like "./../main/ipc.ts" is judged by the folder it reaches.
const RENDERER_URL = "file:///app/src/renderer/";
const RENDERER_DIRECTORY = "/app/src/renderer/";
const SHARED_DIRECTORY = "/app/src/shared/";

/** Packages that the renderer may import. */
const ALLOWED_PACKAGES = new Set(["react", "react-dom/client"]);

/**
 * Shared modules that the renderer may import values from. Every other shared
 * module is imported with `import type`, so that zod and the IPC channel
 * names stay out of the renderer bundle.
 */
const SHARED_VALUE_MODULES = new Set([`${SHARED_DIRECTORY}product.ts`]);

/** Browser and Node.js APIs that reach the network or the machine. */
const FORBIDDEN_APIS: readonly [string, RegExp][] = [
  ["fetch", /\bfetch\s*\(/],
  ["WebSocket", /\bWebSocket\b/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["EventSource", /\bEventSource\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["RTCPeerConnection", /\bRTCPeerConnection\b/],
  ["Worker", /\b(?:Shared)?Worker\s*\(/],
  ["dynamic import", /\bimport\s*\(/],
  ["require", /\brequire\s*\(/],
  ["process", /\bprocess\.[A-Za-z_$]/],
  ["Buffer", /\bBuffer\b/],
  ["__dirname", /\b__(?:dirname|filename)\b/],
];

/** The path of a renderer or shared file, from its key in a glob result. */
function pathOf(file: string): string {
  return new URL(file, RENDERER_URL).pathname;
}

interface ImportStatement {
  readonly file: string;
  readonly specifier: string;
  /** The resolved path of a relative or absolute specifier, else undefined. */
  readonly path: string | undefined;
  readonly typeOnly: boolean;
}

/** The import and re-export statements of a Prettier-formatted module. */
function importsOf(file: string, source: string): ImportStatement[] {
  const statements: ImportStatement[] = [];
  for (const [statement] of source.matchAll(/^(?:import|export)\b[^;]*;/gm)) {
    const specifier =
      /\bfrom\s*["']([^"']+)["']/.exec(statement)?.[1] ??
      /^import\s*["']([^"']+)["']/.exec(statement)?.[1];
    if (specifier !== undefined) {
      statements.push({
        file,
        specifier,
        path:
          specifier.startsWith(".") || specifier.startsWith("/")
            ? new URL(specifier, new URL(file, RENDERER_URL)).pathname
            : undefined,
        typeOnly: /^(?:import|export)\s+type\b/.test(statement),
      });
    }
  }
  return statements;
}

/**
 * Imports of anything but the allowed packages and files in the renderer or
 * the shared folder.
 */
function foreignImports(imports: readonly ImportStatement[]): string[] {
  return imports
    .filter(({ specifier, path }) =>
      path === undefined
        ? !ALLOWED_PACKAGES.has(specifier)
        : !path.startsWith(RENDERER_DIRECTORY) &&
          !path.startsWith(SHARED_DIRECTORY),
    )
    .map(({ file, specifier }) => `${file}: ${specifier}`);
}

/** Value imports of shared modules other than SHARED_VALUE_MODULES. */
function sharedValueImports(imports: readonly ImportStatement[]): string[] {
  return imports
    .filter(
      ({ path, typeOnly }) =>
        path?.startsWith(SHARED_DIRECTORY) === true &&
        !typeOnly &&
        !SHARED_VALUE_MODULES.has(path),
    )
    .map(({ file, specifier }) => `${file}: ${specifier}`);
}

function forbiddenApis(file: string, source: string): string[] {
  return FORBIDDEN_APIS.filter(([, pattern]) => pattern.test(source)).map(
    ([name]) => `${file}: ${name}`,
  );
}

const FILES = Object.keys(SOURCES);
const IMPORTS = FILES.flatMap((file) => importsOf(file, SOURCES[file] ?? ""));

test("the checks find foreign imports, shared value imports, and forbidden APIs", () => {
  const sample = [
    'import { readFileSync } from "node:fs";',
    'import { ipcRenderer } from "electron";',
    'import { createMainWindow } from "./../main/window.ts";',
    'import { registerIpc } from "../shared/../main/ipc.ts";',
    'import { helper } from "/app/src/preload/bridge.ts";',
    'import "./styles.css";',
    "import {",
    "  INVOKE_CONTRACT,",
    "  type RuntimeStatus,",
    '} from "../shared/ipc-contract.ts";',
    'import type { DesktopBridge } from "../shared/desktop-bridge.ts";',
    'export { PRODUCT_NAME } from "./../shared/product.ts";',
    'const socket = new WebSocket("wss://example.invalid");',
    'void fetch("https://example.invalid");',
    "const home = process.env.HOME;",
  ].join("\n");
  const imports = importsOf("./sample.ts", sample);

  expect(imports.map(({ path, specifier }) => path ?? specifier)).toEqual([
    "node:fs",
    "electron",
    "/app/src/main/window.ts",
    "/app/src/main/ipc.ts",
    "/app/src/preload/bridge.ts",
    "/app/src/renderer/styles.css",
    "/app/src/shared/ipc-contract.ts",
    "/app/src/shared/desktop-bridge.ts",
    "/app/src/shared/product.ts",
  ]);
  expect(foreignImports(imports)).toEqual([
    "./sample.ts: node:fs",
    "./sample.ts: electron",
    "./sample.ts: ./../main/window.ts",
    "./sample.ts: ../shared/../main/ipc.ts",
    "./sample.ts: /app/src/preload/bridge.ts",
  ]);
  expect(sharedValueImports(imports)).toEqual([
    "./sample.ts: ../shared/ipc-contract.ts",
  ]);
  expect(forbiddenApis("./sample.ts", sample)).toEqual([
    "./sample.ts: fetch",
    "./sample.ts: WebSocket",
    "./sample.ts: process",
  ]);
});

test("the checks read every renderer source and no test", () => {
  for (const file of [
    "./AccountPanel.tsx",
    "./account-view.ts",
    "./App.tsx",
    "./connection-status.ts",
    "./main.tsx",
    "./Navigation.tsx",
    "./ProjectPanel.tsx",
    "./ProjectScreens.tsx",
    "./WorkspaceScreens.tsx",
    "./placeholder-projects.ts",
    "./RepositoryPanel.tsx",
    "./repository-view.ts",
    "./runtime-status.ts",
    "./screens.ts",
  ]) {
    expect(FILES).toContain(file);
  }
  expect(FILES.filter((file) => /\.test\./.test(file))).toEqual([]);
  expect(IMPORTS).toContainEqual({
    file: "./main.tsx",
    specifier: "react-dom/client",
    path: undefined,
    typeOnly: false,
  });
  expect(IMPORTS).toContainEqual({
    file: "./App.tsx",
    specifier: "../shared/desktop-bridge.ts",
    path: "/app/src/shared/desktop-bridge.ts",
    typeOnly: true,
  });
});

test("no renderer module imports Node.js, Electron, a network package, or a file outside the renderer and the shared code", () => {
  expect(foreignImports(IMPORTS)).toEqual([]);
});

test("the renderer imports values only from shared modules that import nothing", () => {
  expect(sharedValueImports(IMPORTS)).toEqual([]);
  const sharedByPath = new Map(
    Object.entries(SHARED_SOURCES).map(([file, source]) => [
      pathOf(file),
      { file, source },
    ]),
  );
  for (const path of SHARED_VALUE_MODULES) {
    const shared = sharedByPath.get(path);
    expect(shared).toBeDefined();
    expect(importsOf(shared?.file ?? path, shared?.source ?? "")).toEqual([]);
  }
});

test("no renderer module calls a network or Node.js API", () => {
  expect(
    FILES.flatMap((file) => forbiddenApis(file, SOURCES[file] ?? "")),
  ).toEqual([]);
});
