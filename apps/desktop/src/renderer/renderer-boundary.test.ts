import ts from "typescript";
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

/**
 * Packages that the renderer may import. From `@mymandev/permissions` only
 * the subpath of its capabilities module, which imports no value: the main
 * entry also evaluates the package's schemas and checks, and with them zod
 * and `@mymandev/protocol`, wherever the code is not tree-shaken, as on the
 * development server.
 */
const ALLOWED_PACKAGES = new Set([
  "react",
  "react-dom/client",
  "@mymandev/permissions/capabilities",
]);

/**
 * The values that the renderer may import from `@mymandev/permissions`, under
 * any specifier: the presentation vocabulary. Types may be imported.
 */
const PERMISSIONS_VALUES = new Set([
  "CAPABILITY_RISK",
  "CAPABILITY_RISKS",
  "CAPABILITY_SCOPE",
  "GRANT_SCOPE_KINDS",
]);

/**
 * Shared modules that the renderer may import values from. Every other shared
 * module is imported with `import type`, so that zod and the IPC channel
 * names stay out of the renderer bundle.
 */
const SHARED_VALUE_MODULES = new Set([
  `${SHARED_DIRECTORY}product.ts`,
  `${SHARED_DIRECTORY}sign-in-timing.ts`,
]);

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

interface ModuleDeclaration {
  readonly specifier: string;
  /** `import type` or `export type`, which the build erases. */
  readonly typeOnly: boolean;
  /**
   * The value names that the declaration imports or re-exports, or undefined
   * when it reaches the whole module: the module alone, a namespace, or a
   * star.
   */
  readonly values: readonly string[] | undefined;
  /** The first line of the declaration, for messages. */
  readonly text: string;
}

/**
 * The import and re-export declarations of a module, from the TypeScript
 * parser, so that comments and strings never hide or invent one.
 */
function declarationsOf(file: string, source: string): ModuleDeclaration[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const declarations: ModuleDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    const text = statement.getText(sourceFile).split("\n")[0] ?? "";
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      declarations.push({
        specifier: statement.moduleSpecifier.text,
        typeOnly: clause?.isTypeOnly === true,
        values:
          clause === undefined ||
          (bindings !== undefined && ts.isNamespaceImport(bindings))
            ? undefined
            : [
                ...(clause.name === undefined ? [] : ["default"]),
                ...(bindings === undefined
                  ? []
                  : bindings.elements
                      .filter((element) => !element.isTypeOnly)
                      .map(
                        (element) =>
                          (element.propertyName ?? element.name).text,
                      )),
              ],
        text,
      });
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.exportClause;
      declarations.push({
        specifier: statement.moduleSpecifier.text,
        typeOnly: statement.isTypeOnly,
        values:
          clause === undefined || !ts.isNamedExports(clause)
            ? undefined
            : clause.elements
                .filter((element) => !element.isTypeOnly)
                .map((element) => (element.propertyName ?? element.name).text),
        text,
      });
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      declarations.push({
        specifier: statement.moduleReference.expression.text,
        typeOnly: statement.isTypeOnly,
        values: undefined,
        text,
      });
    }
  }
  return declarations;
}

/** The import and re-export statements of a module. */
function importsOf(file: string, source: string): ImportStatement[] {
  return declarationsOf(file, source).map(({ specifier, typeOnly }) => ({
    file,
    specifier,
    path:
      specifier.startsWith(".") || specifier.startsWith("/")
        ? new URL(specifier, new URL(file, RENDERER_URL)).pathname
        : undefined,
    typeOnly,
  }));
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

/**
 * Imports and re-exports of `@mymandev/permissions`, under any specifier, that
 * reach more than PERMISSIONS_VALUES: another value, a namespace, a star, or
 * the module alone.
 */
function permissionsValueImports(file: string, source: string): string[] {
  return declarationsOf(file, source)
    .filter(
      ({ specifier, typeOnly }) =>
        !typeOnly &&
        (specifier === "@mymandev/permissions" ||
          specifier.startsWith("@mymandev/permissions/")),
    )
    .flatMap(({ values, text }) =>
      values === undefined
        ? [`${file}: ${text}`]
        : values
            .filter((name) => !PERMISSIONS_VALUES.has(name))
            .map((name) => `${file}: ${name}`),
    );
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
    "import {",
    "  spawn, // a child; never in the renderer",
    '} from "node:child_process";',
    'import { /* a; b */ shell } from "electron/main";',
    "const text = \"import { x } from 'node:os';\";",
    "/* import { y } from 'node:net'; */",
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
    "node:child_process",
    "electron/main",
  ]);
  expect(foreignImports(imports)).toEqual([
    "./sample.ts: node:fs",
    "./sample.ts: electron",
    "./sample.ts: ./../main/window.ts",
    "./sample.ts: ../shared/../main/ipc.ts",
    "./sample.ts: /app/src/preload/bridge.ts",
    "./sample.ts: node:child_process",
    "./sample.ts: electron/main",
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

test("the check finds permission imports beyond the presentation vocabulary", () => {
  const sample = [
    "import {",
    "  CAPABILITY_RISK,",
    "  CAPABILITY_SCOPE as SCOPES,",
    "  hasGrant,",
    "  type CapabilityRisk,",
    '} from "@mymandev/permissions";',
    'import type { PermissionGrant } from "@mymandev/permissions";',
    'import * as permissions from "@mymandev/permissions";',
    'import "@mymandev/permissions";',
    'export { PermissionRequestSchema } from "@mymandev/permissions";',
    'export * from "@mymandev/permissions";',
    'import { GRANT_SCOPE_KINDS } from "@mymandev/permissions";',
    "import {",
    "  CAPABILITY_RISK, // labels; presentation only",
    "  isGrantActive,",
    '} from "@mymandev/permissions/capabilities";',
    'import { /* labels; presentation only */ PermissionGrantSchema } from "@mymandev/permissions/capabilities";',
    'import { CAPABILITY_RISKS, type GrantScopeKind } from "@mymandev/permissions/capabilities";',
    'import { CAPABILITY_SCOPE } from "@mymandev/permissions/src/capabilities.ts";',
  ].join("\n");

  expect(permissionsValueImports("./sample.ts", sample)).toEqual([
    "./sample.ts: hasGrant",
    './sample.ts: import * as permissions from "@mymandev/permissions";',
    './sample.ts: import "@mymandev/permissions";',
    "./sample.ts: PermissionRequestSchema",
    './sample.ts: export * from "@mymandev/permissions";',
    "./sample.ts: isGrantActive",
    "./sample.ts: PermissionGrantSchema",
  ]);
  // The comments hide nothing from the foreign-import rule either, and only
  // the capabilities subpath of the package is allowed.
  expect(foreignImports(importsOf("./sample.ts", sample))).toEqual([
    ...Array.from({ length: 7 }, () => "./sample.ts: @mymandev/permissions"),
    "./sample.ts: @mymandev/permissions/src/capabilities.ts",
  ]);
});

test("the checks read every renderer source and no test", () => {
  for (const file of [
    "./AccountPanel.tsx",
    "./AccountScreen.tsx",
    "./account-view.ts",
    "./AgentPanel.tsx",
    "./agent-view.ts",
    "./App.tsx",
    "./ChatScreen.tsx",
    "./chat-view.ts",
    "./connection-status.ts",
    "./device-view.ts",
    "./DevicesSection.tsx",
    "./InvitationActions.tsx",
    "./invitations-view.ts",
    "./JoinScreen.tsx",
    "./main.tsx",
    "./Navigation.tsx",
    "./PeopleScreen.tsx",
    "./people-view.ts",
    "./permission-view.ts",
    "./ProjectPanel.tsx",
    "./ProjectScreens.tsx",
    "./WorkspaceScreens.tsx",
    "./RepositoryPanel.tsx",
    "./repository-view.ts",
    "./runtime-status.ts",
    "./screens.ts",
    "./SwitchQuestion.tsx",
    "./workspace-view.ts",
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
  expect(IMPORTS).toContainEqual({
    file: "./permission-view.ts",
    specifier: "@mymandev/permissions/capabilities",
    path: undefined,
    typeOnly: false,
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

test("the renderer imports only the presentation vocabulary of the permissions package", () => {
  expect(
    FILES.flatMap((file) => permissionsValueImports(file, SOURCES[file] ?? "")),
  ).toEqual([]);
});
