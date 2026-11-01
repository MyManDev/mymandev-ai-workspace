import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { CustomScheme } from "electron";
import { CONTENT_SECURITY_POLICY } from "../shared/content-security-policy.ts";

// A built application loads its renderer from app://renderer/, not from a
// file: URL. The scheme serves only the files inside the built renderer
// directory, so the Content Security Policy's 'self' means exactly those
// files (ADR 0016).

export const APP_SCHEME = "app";
export const APP_HOST = "renderer";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

/**
 * Registered with `protocol.registerSchemesAsPrivileged` before the `ready`
 * event. `standard` gives the scheme an origin and relative URLs, and `secure`
 * treats it like https. Nothing else: no CSP bypass, no service workers, and no
 * CORS or Fetch API access for other origins.
 */
export const APP_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true },
};

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
]);

/** The Content-Type for a file name; unknown extensions are served as bytes. */
export function contentTypeFor(filePath: string): string {
  return (
    CONTENT_TYPES.get(extname(filePath).toLowerCase()) ??
    "application/octet-stream"
  );
}

// A decoded path segment may not contain a separator, a drive or stream
// separator, a control character, or a character that Windows does not allow
// in file names.
const FORBIDDEN_IN_SEGMENT = /[/\\:*?"<>|]/;

function hasControlCharacter(segment: string): boolean {
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

// Windows ignores trailing dots and spaces in a file name, so "index.html."
// would open "index.html", and "..." would be "..".
const TRAILING_DOT_OR_SPACE = /[. ]$/;

// Windows device names, with or without an extension, in any case.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function isInside(rootDir: string, filePath: string): boolean {
  const path = relative(rootDir, filePath);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

/**
 * The file inside `rootDir` that an app:// URL names, or undefined. Only the
 * host `renderer` is served. `/` means `/index.html`. The URL is rejected when
 * it has credentials or a port, and when a segment, after percent-decoding,
 * is empty, ends with a dot or a space (which also rejects `.`, `..`, and
 * `...`), is a Windows device name such as `CON` or `com1.txt`, or contains
 * `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, or a control character. Invalid
 * percent-encoding is rejected, and so is a joined path outside `rootDir`.
 */
export function resolveAppFilePath(
  url: string,
  rootDir: string,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== `${APP_SCHEME}:` ||
    parsed.host !== APP_HOST ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return undefined;
  }
  // A non-empty path always starts with "/".
  const encoded =
    parsed.pathname === "/" || parsed.pathname === ""
      ? ["index.html"]
      : parsed.pathname.slice(1).split("/");
  const segments: string[] = [];
  for (const part of encoded) {
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return undefined;
    }
    if (
      segment === "" ||
      TRAILING_DOT_OR_SPACE.test(segment) ||
      WINDOWS_DEVICE_NAME.test(segment) ||
      FORBIDDEN_IN_SEGMENT.test(segment) ||
      hasControlCharacter(segment)
    ) {
      return undefined;
    }
    segments.push(segment);
  }
  const filePath = join(rootDir, ...segments);
  return isInside(rootDir, filePath) ? filePath : undefined;
}

export interface AppFileSystem {
  /** `fs.promises.realpath`: resolves symbolic links. */
  realpath(path: string): Promise<string>;
  /** `fs.promises.readFile` without an encoding. */
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>;
}

/** Headers of every app:// response, including errors. */
const COMMON_HEADERS = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
};

function emptyResponse(status: number): Response {
  return new Response(null, { status, headers: COMMON_HEADERS });
}

/**
 * The `protocol.handle` handler for app://. It answers GET and HEAD with a
 * file inside `rootDir`, other methods with 405, and anything else with 404,
 * including a file whose real path, after symbolic links, is outside the real
 * path of `rootDir`. Every response carries the production Content Security
 * Policy as a header, and `X-Content-Type-Options: nosniff`.
 */
export function createAppProtocolHandler(
  rootDir: string,
  fs: AppFileSystem,
): (request: Request) => Promise<Response> {
  let realRoot: Promise<string> | undefined;
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return emptyResponse(405);
    }
    const filePath = resolveAppFilePath(request.url, rootDir);
    if (filePath === undefined) {
      return emptyResponse(404);
    }
    try {
      realRoot ??= fs.realpath(rootDir);
      const [root, realFile] = await Promise.all([
        realRoot,
        fs.realpath(filePath),
      ]);
      if (!isInside(root, realFile)) {
        return emptyResponse(404);
      }
      const body = await fs.readFile(realFile);
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: {
          ...COMMON_HEADERS,
          "Content-Type": contentTypeFor(filePath),
        },
      });
    } catch {
      return emptyResponse(404);
    }
  };
}
