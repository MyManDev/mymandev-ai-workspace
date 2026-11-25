import {
  CAPABILITY_RISK,
  CAPABILITY_RISKS,
} from "@mymandev/permissions/capabilities";
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
 * The one renderer module that reads the risk labels of `CAPABILITY_RISK`
 * (ADR 0015, #77). Every other module takes a capability's risk, its text,
 * and what the presentation rules make of it (`mayBePreselected`,
 * `mayBeBundled`, `confirmation`) from that module's model, so no other
 * module can read a label from elsewhere or infer a capability from one.
 */
const RISK_LABEL_READER = "./permission-view.ts";

/** The values that hold the risk labels. */
const RISK_LABEL_VALUES = new Set(["CAPABILITY_RISK", "CAPABILITY_RISKS"]);

/**
 * Shared modules that the renderer may import values from. Every other shared
 * module is imported with `import type`, so that zod and the IPC channel
 * names stay out of the renderer bundle.
 */
const SHARED_VALUE_MODULES = new Set([
  `${SHARED_DIRECTORY}product.ts`,
  `${SHARED_DIRECTORY}run-request-refusals.ts`,
  `${SHARED_DIRECTORY}sign-in-timing.ts`,
]);

/**
 * Browser and Node.js APIs that reach the network or the machine. A dynamic
 * `import()` is also forbidden; `dynamicImportsOf` finds it with the
 * TypeScript parser.
 */
const FORBIDDEN_APIS: readonly [string, RegExp][] = [
  ["fetch", /\bfetch\s*\(/],
  ["WebSocket", /\bWebSocket\b/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["EventSource", /\bEventSource\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["RTCPeerConnection", /\bRTCPeerConnection\b/],
  ["Worker", /\b(?:Shared)?Worker\s*\(/],
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

/** A module's syntax tree, from the TypeScript parser. */
function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * The import and re-export declarations of a module, from the TypeScript
 * parser, so that comments and strings never hide or invent one.
 */
function declarationsOf(file: string, source: string): ModuleDeclaration[] {
  const sourceFile = parse(file, source);
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

/**
 * Where a module other than RISK_LABEL_READER reads a risk label: a value
 * import or re-export named `CAPABILITY_RISK` or `CAPABILITY_RISKS` from any
 * module, so that also one that passes them on, such as RISK_LABEL_READER,
 * is no way around the rule; a value import or re-export of the whole of
 * `@mymandev/permissions` under any of its specifiers; and a string or
 * template literal that is a label, such as `"highest"`, found with the
 * TypeScript parser, so that a comment names none.
 */
function riskLabelReads(file: string, source: string): string[] {
  if (file === RISK_LABEL_READER) {
    return [];
  }
  const imports = declarationsOf(file, source)
    .filter(({ typeOnly }) => !typeOnly)
    .flatMap(({ specifier, values, text }) => {
      if (values !== undefined) {
        return values
          .filter((name) => RISK_LABEL_VALUES.has(name))
          .map((name) => `${file}: ${name}`);
      }
      return specifier === "@mymandev/permissions" ||
        specifier.startsWith("@mymandev/permissions/")
        ? [`${file}: ${text}`]
        : [];
    });
  const labels = new Set<string>(["standard", "highest"]);
  const literals: string[] = [];
  const sourceFile = parse(file, source);
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      labels.has(node.text)
    ) {
      literals.push(`${file}: "${node.text}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...imports, ...literals];
}

/** Whether a node is `import.meta`, or `import.<name>` with another name. */
function isImportProperty(node: ts.Node): boolean {
  return (
    ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

/**
 * Whether a call loads a module, or may: `import(...)`; a call of
 * `import.<name>`, such as the proposed `import.defer(...)` and
 * `import.source(...)`; and a call of a member of `import.meta`, such as
 * Vite's `import.meta.glob(...)`, also by its name in brackets.
 */
function isImportCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return (
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    isImportProperty(callee) ||
    ((ts.isPropertyAccessExpression(callee) ||
      ts.isElementAccessExpression(callee)) &&
      isImportProperty(callee.expression))
  );
}

/**
 * The dynamic imports of a module anywhere in it, each by its text on one
 * line: every call that `isImportCall` finds, and every type
 * `import("...")`. They come from the TypeScript parser, as the import
 * declarations do (#285), so that a comment between `import` and `(` hides
 * none, and a comment, a string, or the text of a JSX element invents none.
 * The renderer imports nothing dynamically, whatever the module.
 */
function dynamicImportsOf(file: string, source: string): string[] {
  const sourceFile = parse(file, source);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isCallExpression(node) && isImportCall(node)) ||
      ts.isImportTypeNode(node)
    ) {
      found.push(node.getText(sourceFile).replace(/\s+/g, " "));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function forbiddenApis(file: string, source: string): string[] {
  return [
    ...FORBIDDEN_APIS.filter(([, pattern]) => pattern.test(source)).map(
      ([name]) => `${file}: ${name}`,
    ),
    ...dynamicImportsOf(file, source).map((text) => `${file}: ${text}`),
  ];
}

const FILES = Object.keys(SOURCES);
const IMPORTS = FILES.flatMap((file) => importsOf(file, SOURCES[file] ?? ""));

test("the checks find foreign imports, shared value imports, forbidden APIs, and dynamic imports", () => {
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
    'void import /* a comment */ ("node:fs");',
    "void import(",
    '  "./App.tsx"',
    ");",
    'type Bridge = typeof import("electron");',
    'void import.defer("node:fs");',
    'void import.source("node:os");',
    'const all = import.meta.glob("../main/*.ts", { eager: true });',
    'const one = import.meta["glob"]("../main/ipc.ts");',
    "const note = \"import('node:os')\";",
    '// import("node:net")',
    "const meta = import.meta.url;",
    'const icon = new URL("./icon.svg", import.meta.url);',
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
  // Every dynamic import, also with a comment before its parenthesis, over
  // lines, in a type, as a call of `import.<name>`, or as a call of a member
  // of `import.meta`; none in a string or a comment, and not `import.meta`
  // itself.
  expect(forbiddenApis("./sample.ts", sample)).toEqual([
    "./sample.ts: fetch",
    "./sample.ts: WebSocket",
    "./sample.ts: process",
    './sample.ts: import /* a comment */ ("node:fs")',
    './sample.ts: import( "./App.tsx" )',
    './sample.ts: typeof import("electron")',
    './sample.ts: import.defer("node:fs")',
    './sample.ts: import.source("node:os")',
    './sample.ts: import.meta.glob("../main/*.ts", { eager: true })',
    './sample.ts: import.meta["glob"]("../main/ipc.ts")',
  ]);
});

test("a module whose name ends in x is read as TSX, so that an import in a JSX child is found and the text of an element is not taken for one, and any other module as TS", () => {
  const sample = [
    "export function Note() {",
    "  return (",
    "    <p>",
    '      it\'s {import("node:fs") && null}',
    '      import("node:os")',
    "    </p>",
    "  );",
    "}",
  ].join("\n");
  expect(forbiddenApis("./Note.tsx", sample)).toEqual([
    './Note.tsx: import("node:fs")',
  ]);
  // Any other module is read as TS, where angle brackets are a type
  // assertion, not an element.
  expect(
    forbiddenApis(
      "./note.ts",
      'const note = <Promise<unknown>>import("node:fs");',
    ),
  ).toEqual(['./note.ts: import("node:fs")']);
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

test("the check finds a risk label read outside the presentation model", () => {
  const sample = [
    "import {",
    "  CAPABILITY_RISK as RISK,",
    "  CAPABILITY_SCOPE,",
    "  type CapabilityRisk,",
    '} from "@mymandev/permissions/capabilities";',
    'import { CAPABILITY_RISKS } from "@mymandev/permissions";',
    'import type { CAPABILITY_RISK as Types } from "@mymandev/permissions/capabilities";',
    'import * as permissions from "@mymandev/permissions/capabilities";',
    'export { CAPABILITY_RISK } from "@mymandev/permissions/capabilities";',
    '// A comment that says "highest" names no label.',
    'const shell = RISK["terminal.execute"] === "highest";',
    "const standard = `standard`;",
    'const element = <li data-risk="highest" />;',
    'const text = "Highest risk";',
    // Through another module, the presentation model's own included.
    'import { CAPABILITY_RISK as Passed } from "./permission-view.ts";',
    'export { CAPABILITY_RISKS as Labels } from "./labels.ts";',
    'import type { CAPABILITY_RISK as Typed } from "./permission-view.ts";',
    'import * as view from "./permission-view.ts";',
  ].join("\n");

  expect(riskLabelReads("./sample.tsx", sample)).toEqual([
    "./sample.tsx: CAPABILITY_RISK",
    "./sample.tsx: CAPABILITY_RISKS",
    './sample.tsx: import * as permissions from "@mymandev/permissions/capabilities";',
    "./sample.tsx: CAPABILITY_RISK",
    "./sample.tsx: CAPABILITY_RISK",
    "./sample.tsx: CAPABILITY_RISKS",
    './sample.tsx: "highest"',
    './sample.tsx: "standard"',
    './sample.tsx: "highest"',
  ]);
  // The presentation model itself reads them.
  expect(riskLabelReads(RISK_LABEL_READER, sample)).toEqual([]);
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

test("no renderer module calls a network or Node.js API or imports a module dynamically", () => {
  expect(
    FILES.flatMap((file) => forbiddenApis(file, SOURCES[file] ?? "")),
  ).toEqual([]);
});

test("the renderer imports only the presentation vocabulary of the permissions package", () => {
  expect(
    FILES.flatMap((file) => permissionsValueImports(file, SOURCES[file] ?? "")),
  ).toEqual([]);
});

test("only the presentation model reads the risk labels: no other renderer module imports CAPABILITY_RISK or names a label", () => {
  expect(FILES).toContain(RISK_LABEL_READER);
  // Its source would be found in any other module.
  expect(
    riskLabelReads("./elsewhere.ts", SOURCES[RISK_LABEL_READER] ?? ""),
  ).toEqual(
    expect.arrayContaining([
      "./elsewhere.ts: CAPABILITY_RISK",
      './elsewhere.ts: "highest"',
    ]),
  );
  expect(
    FILES.flatMap((file) => riskLabelReads(file, SOURCES[file] ?? "")),
  ).toEqual([]);
});

test("the presentation model does not pass the risk labels on, under their names or others", async () => {
  const model: Record<string, unknown> = await import("./permission-view.ts");
  for (const name of RISK_LABEL_VALUES) {
    expect(Object.keys(model)).not.toContain(name);
  }
  expect(Object.values(model)).not.toContain(CAPABILITY_RISK);
  expect(Object.values(model)).not.toContain(CAPABILITY_RISKS);
});
