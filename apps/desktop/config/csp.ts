import { randomBytes } from "node:crypto";
import type { Plugin } from "vite";
import { CONTENT_SECURITY_POLICY } from "../src/shared/content-security-policy.ts";

const CSP_META =
  /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)("\s*\/?>)/i;

function parsePolicy(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const directive of policy.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name !== undefined && name !== "") {
      directives.set(name.toLowerCase(), sources);
    }
  }
  return directives;
}

function addSource(
  directives: Map<string, string[]>,
  name: string,
  source: string,
): void {
  const sources = (directives.get(name) ?? []).filter(
    (value) => value !== "'none'",
  );
  directives.set(name, [...sources, source]);
}

/**
 * Adds what the Vite development server needs to the production policy: a
 * nonce for the inline scripts and styles it injects (the React Refresh
 * preamble and the styles it reloads), and its own origin for the hot reload
 * WebSocket. Nothing else is relaxed; `unsafe-inline` and `unsafe-eval` stay
 * off.
 */
export function addDevServerSources(policy: string, nonce: string): string {
  const directives = parsePolicy(policy);
  for (const name of ["script-src", "style-src"]) {
    if (!directives.has(name)) {
      throw new Error(`The Content-Security-Policy has no ${name} directive.`);
    }
    addSource(directives, name, `'nonce-${nonce}'`);
  }
  addSource(directives, "connect-src", "'self'");
  return [...directives]
    .map(([name, sources]) => [name, ...sources].join(" "))
    .join("; ");
}

/**
 * Replaces the policy in the Content-Security-Policy meta element of `html`.
 * Throws when the element is missing, so a build never ships without it.
 */
export function withPolicy(html: string, policy: string): string {
  const match = CSP_META.exec(html);
  if (match === null) {
    throw new Error(
      "index.html has no Content-Security-Policy meta element in the expected form.",
    );
  }
  const [element, start, , end] = match;
  return (
    html.slice(0, match.index) +
    `${start}${policy}${end}` +
    html.slice(match.index + element.length)
  );
}

/**
 * index.html with the policy for a command: the production policy for
 * `build`, and for `serve` the production policy with the development server's
 * additions.
 */
export function htmlWithPolicy(
  html: string,
  command: "build" | "serve",
  nonce: string,
): string {
  return withPolicy(
    html,
    command === "build"
      ? CONTENT_SECURITY_POLICY
      : addDevServerSources(CONTENT_SECURITY_POLICY, nonce),
  );
}

/** A new nonce: 18 random bytes, 24 base64 characters. */
export function createNonce(): string {
  return randomBytes(18).toString("base64");
}

/**
 * The renderer's Vite plugin for the Content Security Policy. It writes
 * CONTENT_SECURITY_POLICY (src/shared/content-security-policy.ts), which the
 * main process also sends as a header, into the meta element of index.html.
 * For `electron-vite dev`, it creates a nonce for each start of the
 * development server, lets Vite add it to the scripts and styles it injects
 * (`html.cspNonce`), and adds the development server's sources.
 */
export function contentSecurityPolicy(nonce: string = createNonce()): Plugin {
  let command: "build" | "serve" = "build";
  return {
    name: "mymandev:content-security-policy",
    config: (_config, env) =>
      env.command === "serve" ? { html: { cspNonce: nonce } } : {},
    configResolved: (config) => {
      command = config.command;
    },
    transformIndexHtml: {
      order: "pre",
      handler: (html) => htmlWithPolicy(html, command, nonce),
    },
  };
}
