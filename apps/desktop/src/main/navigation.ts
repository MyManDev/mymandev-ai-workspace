import { APP_ENTRY_URL } from "./app-protocol.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface RendererUrlInput {
  /** `app.isPackaged`: true in an installed application. */
  readonly isPackaged: boolean;
  /** `ELECTRON_RENDERER_URL`, which electron-vite sets during development. */
  readonly devServerUrl: string | undefined;
}

/**
 * The URL the application window loads. A packaged application always loads
 * its built files from app://renderer/ and ignores `ELECTRON_RENDERER_URL`, so
 * an environment variable cannot point it at other content. During
 * development, the URL of the development server is used when it is an http
 * URL on a loopback host.
 */
export function resolveRendererUrl(input: RendererUrlInput): string {
  if (
    input.isPackaged ||
    input.devServerUrl === undefined ||
    input.devServerUrl === ""
  ) {
    return APP_ENTRY_URL;
  }
  let url: URL;
  try {
    url = new URL(input.devServerUrl);
  } catch {
    throw new Error("ELECTRON_RENDERER_URL is not a valid URL.");
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      "ELECTRON_RENDERER_URL must be an http URL on localhost, 127.0.0.1, or [::1].",
    );
  }
  return url.href;
}

/**
 * True when a navigation stays inside the application. With the development
 * server, any URL on its scheme, host, and port. With the built files, only
 * the document the window loaded, app://renderer/index.html, without a query;
 * other app:// paths are not navigable. Every other navigation, including
 * links to websites and file: URLs, is blocked.
 */
export function isAppNavigation(target: string, appUrl: string): boolean {
  let targetUrl: URL;
  let app: URL;
  try {
    targetUrl = new URL(target);
    app = new URL(appUrl);
  } catch {
    return false;
  }
  // URL.origin is "null" for app://, so compare scheme and host (with port).
  if (
    app.host === "" ||
    targetUrl.protocol !== app.protocol ||
    targetUrl.host !== app.host
  ) {
    return false;
  }
  if (app.protocol === "http:") {
    return true;
  }
  return targetUrl.pathname === app.pathname && targetUrl.search === "";
}
