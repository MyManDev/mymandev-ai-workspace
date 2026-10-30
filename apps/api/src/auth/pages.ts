import type { FastifyReply } from "fastify";
import { createHash } from "node:crypto";

// The API's own HTML pages in the sign-in flow (ADR 0014, steps 2 to 5). They
// load nothing from outside, run one fixed script, and may post forms only to
// the API itself or to the desktop's loopback listener of this attempt.

const STYLE = [
  "body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1b2330;background:#fff}",
  "h1{font-size:1.4rem}",
  ".login{font-family:ui-monospace,monospace;font-weight:600}",
  ".code{font-family:ui-monospace,monospace;font-size:2rem;letter-spacing:.3rem}",
  "form{display:inline-block;margin:1rem 1rem 0 0}",
  "button{font-size:1rem;padding:.5rem 1.2rem}",
].join("");

/** Submits the form with the ID "f" on load; the page also shows the button. */
const AUTO_SUBMIT_SCRIPT = 'document.getElementById("f").submit();';

function cspHash(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

const STYLE_HASH = cspHash(STYLE);
const SCRIPT_HASH = cspHash(AUTO_SUBMIT_SCRIPT);

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for HTML content and double-quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ESCAPES[character] ?? "");
}

function document(title: string, body: string, withScript: boolean): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    body,
    withScript ? `<script>${AUTO_SUBMIT_SCRIPT}</script>` : "",
    "</body>",
    "</html>",
  ].join("");
}

/** Sends a page with the security headers; `formAction` lists where forms may post. */
export function sendPage(
  reply: FastifyReply,
  statusCode: number,
  html: string,
  formAction: readonly string[] = [],
): FastifyReply {
  const csp = [
    "default-src 'none'",
    `style-src ${STYLE_HASH}`,
    `script-src ${SCRIPT_HASH}`,
    `form-action ${formAction.length > 0 ? formAction.join(" ") : "'none'"}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
  return reply
    .code(statusCode)
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY")
    .header("cross-origin-opener-policy", "same-origin")
    .header("content-security-policy", csp)
    .send(html);
}

/** A page that explains a failure and posts nothing. */
export function errorPage(title: string, text: string): string {
  return document(
    title,
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p>You can close this tab and start the sign-in again from the MyManDev application.</p>`,
    false,
  );
}

/**
 * The confirmation page of step 4: the GitHub login and the pairing code.
 * Continue and Cancel post to the API with the attempt's state.
 */
export function confirmationPage(
  input: Readonly<{ login: string; pairingCode: string; apiState: string }>,
): string {
  const state = `<input type="hidden" name="state" value="${escapeHtml(input.apiState)}">`;
  return document(
    "Confirm sign-in to MyManDev",
    [
      "<h1>Confirm sign-in to MyManDev</h1>",
      `<p>GitHub account: <span class="login">${escapeHtml(input.login)}</span></p>`,
      `<p class="code">${escapeHtml(input.pairingCode)}</p>`,
      "<p>Continue only if the MyManDev application on this computer shows the same code and you started this sign-in yourself. If you did not start it, choose Cancel.</p>",
      `<form method="post" action="/auth/github/confirm">${state}<input type="hidden" name="decision" value="continue"><button type="submit">Continue</button></form>`,
      `<form method="post" action="/auth/github/confirm">${state}<input type="hidden" name="decision" value="cancel"><button type="submit">Cancel</button></form>`,
    ].join(""),
    false,
  );
}

/**
 * The page of step 5: a form POST to the desktop's loopback listener, sent by
 * a script on load and by a visible button. Nothing of it appears in a URL.
 */
export function listenerPage(
  input: Readonly<{
    redirectUri: string;
    fields: Readonly<Record<string, string>>;
    title: string;
    text: string;
  }>,
): string {
  const hidden = Object.entries(input.fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  return document(
    input.title,
    [
      `<h1>${escapeHtml(input.title)}</h1>`,
      `<p>${escapeHtml(input.text)}</p>`,
      `<form id="f" method="post" action="${escapeHtml(input.redirectUri)}">${hidden}<button type="submit">Return to MyManDev</button></form>`,
    ].join(""),
    true,
  );
}

/** The origin of a loopback redirect URI, for `form-action`. */
export function originOf(redirectUri: string): string {
  return new URL(redirectUri).origin;
}
