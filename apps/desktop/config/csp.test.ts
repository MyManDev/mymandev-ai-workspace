import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../src/shared/content-security-policy.ts";
import {
  addDevServerSources,
  contentSecurityPolicy,
  createNonce,
  htmlWithPolicy,
  withPolicy,
} from "./csp.ts";

const INDEX_HTML = readFileSync(
  new URL("../src/renderer/index.html", import.meta.url),
  "utf8",
);

function policyOf(html: string): string {
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(
    html,
  );
  if (match?.[1] === undefined) {
    throw new Error("no policy");
  }
  return match[1];
}

test("the production policy allows only the page's own origin, with no inline code, eval, or network connection", () => {
  expect(CONTENT_SECURITY_POLICY).toBe(
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'",
  );
});

test("index.html blocks everything until the build writes the policy in", () => {
  expect(policyOf(INDEX_HTML)).toBe("default-src 'none'");
});

test("a build writes the shared production policy into index.html and changes nothing else", () => {
  const html = htmlWithPolicy(INDEX_HTML, "build", "unused");

  expect(policyOf(html)).toBe(CONTENT_SECURITY_POLICY);
  expect(html.replace(CONTENT_SECURITY_POLICY, "")).toBe(
    INDEX_HTML.replace("default-src 'none'", ""),
  );
});

test("the development server gets the production policy with its nonce and its own origin, and nothing else", () => {
  expect(policyOf(htmlWithPolicy(INDEX_HTML, "serve", "abc123"))).toBe(
    "default-src 'none'; script-src 'self' 'nonce-abc123'; style-src 'self' 'nonce-abc123'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; connect-src 'self'",
  );
  expect(
    addDevServerSources(
      "script-src 'self'; style-src 'self'; connect-src 'none'",
      "n",
    ),
  ).toBe(
    "script-src 'self' 'nonce-n'; style-src 'self' 'nonce-n'; connect-src 'self'",
  );
  expect(policyOf(htmlWithPolicy(INDEX_HTML, "serve", "abc123"))).not.toMatch(
    /unsafe-/,
  );
});

test("a policy without script-src or style-src, or a page without the meta element, is refused", () => {
  expect(() => addDevServerSources("default-src 'self'", "n")).toThrow(
    /script-src/,
  );
  expect(() => addDevServerSources("script-src 'self'", "n")).toThrow(
    /style-src/,
  );
  expect(() => withPolicy("<html></html>", "default-src 'none'")).toThrow(
    /Content-Security-Policy/,
  );
});

test("the plugin runs for builds and the development server, and each start gets a new nonce", () => {
  const plugin = contentSecurityPolicy();
  expect(plugin.apply).toBeUndefined();
  expect(plugin.name).toBe("mymandev:content-security-policy");

  const nonces = new Set(Array.from({ length: 10 }, () => createNonce()));
  expect(nonces.size).toBe(10);
  for (const nonce of nonces) {
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
  }
});
