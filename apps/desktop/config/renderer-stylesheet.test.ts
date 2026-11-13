// Checks of the renderer's stylesheets. They live here, with the Node.js
// types, because Vitest hands a CSS file to a renderer test as an empty
// string, and the renderer's own tests have no Node.js API to read it.
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  AGENT_RUN_STATES,
  type AgentRunStateView,
} from "../src/shared/ipc-contract.ts";

const RENDERER = new URL("../src/renderer/", import.meta.url);

const STYLESHEETS = readdirSync(RENDERER, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".css"))
  .sort();

const CSS = readFileSync(new URL("styles.css", RENDERER), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/**
 * The url() and @import references of a stylesheet that leave the page's own
 * files: a URL with a scheme, or a protocol-relative URL.
 */
function externalReferences(css: string): string[] {
  const targets = [
    ...[...css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)].map(
      (match) => match[2] ?? "",
    ),
    ...[...css.matchAll(/@import\s+(["'])(.*?)\1/gi)].map(
      (match) => match[2] ?? "",
    ),
  ];
  return targets.filter((target) =>
    /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target),
  );
}

/** The declarations of the first rule with exactly this selector. */
function rule(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return CSS.slice(start, CSS.indexOf("}", start));
}

/** The color tokens of a rule, as "name: value". */
function colorTokens(declarations: string): string[] {
  return [...declarations.matchAll(/^\s*(--color-[\w-]+):\s*([^;]+);/gm)].map(
    ([, name, value]) => `${name ?? ""}: ${value ?? ""}`,
  );
}

function names(tokens: readonly string[]): string[] {
  return tokens.map((token) => token.slice(0, token.indexOf(":")));
}

/**
 * The declarations of every rule whose selector list holds exactly this
 * selector, at the top level or inside an at-rule.
 */
function rulesWith(selector: string): string[] {
  return [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) =>
      (selectors ?? "").split(",").some((item) => item.trim() === selector),
    )
    .map(([, , declarations]) => declarations ?? "");
}

test("the check finds references to other origins and schemes", () => {
  expect(
    externalReferences(
      [
        '@import "https://example.invalid/theme.css";',
        "@import './local.css';",
        '.a { background: url("https://example.invalid/a.png"); }',
        ".b { background: url(//example.invalid/b.png); }",
        ".c { background: url( 'data:image/png;base64,AAAA' ); }",
        '.d { background: url("./d.svg"); }',
        ".e { background: url(e.png); }",
      ].join("\n"),
    ),
  ).toEqual([
    "https://example.invalid/a.png",
    "//example.invalid/b.png",
    "data:image/png;base64,AAAA",
    "https://example.invalid/theme.css",
  ]);
});

test("no renderer stylesheet loads anything from outside the page's own files", () => {
  expect(STYLESHEETS).toEqual(["styles.css"]);
  for (const file of STYLESHEETS) {
    expect(
      externalReferences(readFileSync(new URL(file, RENDERER), "utf8")),
    ).toEqual([]);
  }
});

test("the dark theme sets every color token, the same for the system setting and for data-theme", () => {
  const light = colorTokens(rule(":root"));
  const systemDark = colorTokens(rule(':root:not([data-theme="light"])'));
  const manualDark = colorTokens(rule(':root[data-theme="dark"]'));

  expect(light.length).toBeGreaterThan(0);
  expect(names(systemDark)).toEqual(names(light));
  expect(manualDark).toEqual(systemDark);
  expect(systemDark).not.toEqual(light);
  expect(CSS).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not/);
  expect(rule(':root[data-theme="light"]')).toContain("color-scheme: light;");
  expect(rule(':root[data-theme="dark"]')).toContain("color-scheme: dark;");
});

test("colors are written only in color tokens, so the visual design can replace them there", () => {
  const literals = CSS.split("\n").filter(
    (line) =>
      /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch)\(/i.test(line) &&
      !/^\s*--color-[\w-]+:/.test(line),
  );

  expect(literals).toEqual([]);
});

test("the dot of each of the six run states has the existing status color of its state", () => {
  const tokens: Readonly<Record<AgentRunStateView, string>> = {
    queued: "--color-status-transition",
    running: "--color-status-running",
    awaiting_input: "--color-status-transition",
    completed: "--color-status-neutral",
    failed: "--color-status-failed",
    cancelled: "--color-status-neutral",
  };

  expect(rulesWith(".agent-run-dot")).toEqual([
    expect.stringContaining("background: var(--color-status-neutral);"),
  ]);
  for (const state of AGENT_RUN_STATES) {
    const rules = rulesWith(`.agent-run[data-state="${state}"] .agent-run-dot`);
    expect(rules, state).toHaveLength(1);
    expect(rules[0]?.trim(), state).toBe(`background: var(${tokens[state]});`);
  }
});

test("a chat message body keeps its line breaks and spaces, and a long word wraps", () => {
  const rules = rulesWith(".message-body");
  expect(rules.some((rule) => rule.includes("white-space: pre-wrap;"))).toBe(
    true,
  );
  expect(rules.some((rule) => rule.includes("overflow-wrap: anywhere;"))).toBe(
    true,
  );
  // No rule that names a body sets another white-space.
  const others = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => (selectors ?? "").includes(".message-body"))
    .flatMap(([, , declarations]) => [
      ...(declarations ?? "").matchAll(/white-space:\s*([^;]+);/g),
    ])
    .map(([, value]) => value);
  expect(others).toEqual(["pre-wrap"]);
});

test("a GitHub login on the people screen and a workspace ID on the join screen are shown in the monospace font, and a long name, workspace name, or workspace ID wraps", () => {
  // ADR 0014: the login is shown in a monospace font, so that a display
  // name cannot pass for it.
  expect(rulesWith(".person-login")).toEqual([
    expect.stringContaining("font-family: var(--font-family-mono);"),
  ]);
  expect(rule(".person")).toContain("overflow-wrap: anywhere;");
  // A workspace ID on the join screen, so that similar characters stay
  // apart, and a long one wraps.
  expect(rulesWith(".workspace-id")).toEqual([
    expect.stringContaining("font-family: var(--font-family-mono);"),
  ]);
  expect(rule(".workspace-id")).toContain("overflow-wrap: anywhere;");
  expect(rule(".people-workspace")).toContain("overflow-wrap: anywhere;");
});

test("the selected navigation item and tab keep a mark in forced colors", () => {
  expect(CSS).toMatch(
    /@media \(forced-colors: active\) \{\s*\.nav-item\[aria-current\],\s*\.panel-tab\[aria-selected="true"\] \{\s*text-decoration: underline;/,
  );
});

test("the sidebar's dot of unseen claims has the accent color, and in forced colors the system color of a button's text", () => {
  expect(rulesWith(".nav-marker")).toEqual([
    expect.stringContaining("background: var(--color-accent);"),
    expect.stringMatching(
      /^\s*forced-color-adjust: none;\s*background: ButtonText;\s*$/,
    ),
  ]);
});

/**
 * The elements around a recent claim's row, from the root down to the row
 * itself: html, body, the #root div, the shell's div (also with a project
 * open), its main column, the People screen's section, the recent claims'
 * section, their list, and the row.
 */
const CLAIM_ROW_ANCESTORS = {
  tags: new Set(["html", "body", "div", "main", "section", "ul", "li"]),
  classes: new Set([
    "shell",
    "shell-project",
    "shell-main",
    "recent-claims",
    "people-list",
    "person",
  ]),
  ids: new Set(["root"]),
};

/**
 * Whether the last compound of a selector may match one of the row's
 * ancestors: its type, classes, and ID all fit one of them. Attributes and
 * pseudo-classes are ignored, so that the check errs toward a match.
 */
function mayMatchClaimRowAncestor(selector: string): boolean {
  const compound =
    selector
      .trim()
      .split(/\s*[\s>+~]\s*/)
      .at(-1) ?? "";
  if (compound.includes("::")) {
    return false;
  }
  const tag = /^[a-z][\w-]*|^\*/i.exec(compound)?.[0];
  const classes = [...compound.matchAll(/\.([\w-]+)/g)].map(
    ([, name]) => name ?? "",
  );
  const ids = [...compound.matchAll(/#([\w-]+)/g)].map(
    ([, name]) => name ?? "",
  );
  return (
    (tag === undefined ||
      tag === "*" ||
      CLAIM_ROW_ANCESTORS.tags.has(tag.toLowerCase())) &&
    classes.every((name) => CLAIM_ROW_ANCESTORS.classes.has(name)) &&
    ids.every((name) => CLAIM_ROW_ANCESTORS.ids.has(name))
  );
}

test("no element around a recent claim's row scrolls, clips, or is fixed or sticky, so that the viewport is the visible area that counts a tall row as seen (#276)", () => {
  // isRowInView compares a row's visible part with the observer's
  // rootBounds, the viewport; a scrolling or fixed ancestor would make the
  // visible area smaller than that.
  const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selectors, declarations]) => ({
      selectors: (selectors ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => !item.startsWith("@")),
      declarations: declarations ?? "",
    }))
    .map((found) => ({
      ...found,
      selectors: found.selectors.filter(mayMatchClaimRowAncestor),
    }))
    .filter((found) => found.selectors.length > 0);
  const matched = new Set(rules.flatMap((found) => found.selectors));
  for (const selector of [
    "body",
    ".shell",
    ".shell-project",
    ".shell-main",
    ".recent-claims",
    ".people-list",
    ".person",
  ]) {
    expect(matched, selector).toContain(selector);
  }
  expect(mayMatchClaimRowAncestor(".shell-main h2")).toBe(false);
  expect(mayMatchClaimRowAncestor(".recent-claims .person-meta")).toBe(false);
  expect(mayMatchClaimRowAncestor("main.shell-main")).toBe(true);
  for (const { selectors, declarations } of rules) {
    expect(declarations, selectors.join(", ")).not.toMatch(
      /(^|[;{\s])overflow(-x|-y|-block|-inline)?\s*:/,
    );
    expect(declarations, selectors.join(", ")).not.toMatch(
      /position\s*:\s*(fixed|sticky)/,
    );
  }
});
