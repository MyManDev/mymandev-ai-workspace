import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../shared/content-security-policy.ts";
import {
  APP_ENTRY_URL,
  APP_SCHEME_PRIVILEGES,
  contentTypeFor,
  createAppProtocolHandler,
  resolveAppFilePath,
  type AppFileSystem,
} from "./app-protocol.ts";

const ROOT = resolve("/app/out/renderer");

test("the scheme is standard and secure, and has no other privilege", () => {
  expect(APP_SCHEME_PRIVILEGES).toEqual({
    scheme: "app",
    privileges: { standard: true, secure: true },
  });
  expect(APP_ENTRY_URL).toBe("app://renderer/index.html");
});

test("an app://renderer URL names a file inside the renderer directory", () => {
  for (const [url, expected] of [
    ["app://renderer/", join(ROOT, "index.html")],
    ["app://renderer", join(ROOT, "index.html")],
    ["app://renderer/index.html", join(ROOT, "index.html")],
    [
      "app://renderer/assets/index-a1.js?v=1#x",
      join(ROOT, "assets", "index-a1.js"),
    ],
    ["app://renderer/a%20b.css", join(ROOT, "a b.css")],
    // The URL parser removes dot segments before the path is resolved.
    ["app://renderer/../secret", join(ROOT, "secret")],
    ["app://renderer/assets/%2e%2e/%2E%2E/secret", join(ROOT, "secret")],
    ["app://renderer/..file", join(ROOT, "..file")],
    // Names that only start like a Windows device name.
    ["app://renderer/conical.js", join(ROOT, "conical.js")],
    ["app://renderer/com10.js", join(ROOT, "com10.js")],
    ["app://renderer/lpt0.txt", join(ROOT, "lpt0.txt")],
  ] as const) {
    expect(resolveAppFilePath(url, ROOT)).toBe(expected);
  }
});

test("traversal, encoded separators, and other hosts and schemes are rejected", () => {
  for (const url of [
    "app://renderer/..%2fsecret",
    "app://renderer/..%2Fsecret",
    "app://renderer/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "app://renderer/..%5csecret",
    "app://renderer/a\\..\\..\\secret",
    "app://renderer/%2fetc%2fpasswd",
    "app://renderer//etc/passwd",
    "app://renderer/C:%5cWindows%5cwin.ini",
    "app://renderer/C:/Windows/win.ini",
    "app://renderer/index.html%00.png",
    "app://renderer/assets/",
    "app://renderer/%E0%A4%A",
    "app://other/index.html",
    "app://RENDERER/index.html",
    "app://renderer:8080/index.html",
    "app://user:secret@renderer/index.html",
    "app:///index.html",
    "file:///app/out/renderer/index.html",
    "https://renderer/index.html",
    "not a url",
  ]) {
    expect(resolveAppFilePath(url, ROOT), url).toBeUndefined();
  }
});

test("names that Windows reads differently are rejected", () => {
  for (const segment of [
    // Windows drops trailing dots and spaces.
    "index.html.",
    "index.html%20",
    "...",
    "%2e%2e%2e",
    "assets./index-a1.js",
    "assets%20/index-a1.js",
    // Device names, with or without an extension, in any case.
    "CON",
    "con.txt",
    "Nul.js",
    "aux.html",
    "prn",
    "COM1",
    "com9.log",
    "LPT1.txt",
    "assets/lpt9",
    // Characters that Windows does not allow in names, and control characters.
    "a*b.js",
    "a%3Fb.js",
    "a%22b.js",
    "a%3Cb.js",
    "a%3Eb.js",
    "a%7Cb.js",
    "a%09b.js",
    "a%7Fb.js",
  ]) {
    expect(
      resolveAppFilePath(`app://renderer/${segment}`, ROOT),
      segment,
    ).toBeUndefined();
  }
});

test("files get their Content-Type, and unknown files are bytes", () => {
  expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
  expect(contentTypeFor("assets/index-a1.js")).toBe(
    "text/javascript; charset=utf-8",
  );
  expect(contentTypeFor("assets/index-a1.CSS")).toBe("text/css; charset=utf-8");
  expect(contentTypeFor("font.woff2")).toBe("font/woff2");
  expect(contentTypeFor("image.svg")).toBe("image/svg+xml");
  expect(contentTypeFor("archive.zip")).toBe("application/octet-stream");
  expect(contentTypeFor("README")).toBe("application/octet-stream");
});

/**
 * Files by real path, symbolic links by path, and the directories that exist.
 * `realpath` follows one link and fails for a path that does not exist.
 */
function fakeFileSystem(
  files: Record<string, string>,
  links: Record<string, string> = {},
  directories: readonly string[] = [ROOT],
): AppFileSystem & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    realpath: (path) => {
      const target = links[path] ?? path;
      return target in files || directories.includes(target)
        ? Promise.resolve(target)
        : Promise.reject(new Error("ENOENT"));
    },
    readFile: (path) => {
      reads.push(path);
      const content = files[path];
      return content === undefined
        ? Promise.reject(new Error("ENOENT"))
        : Promise.resolve(new TextEncoder().encode(content));
    },
  };
}

test("the handler serves a file inside the renderer directory with its type", async () => {
  const fs = fakeFileSystem({ [join(ROOT, "index.html")]: "<!doctype html>" });
  const handle = createAppProtocolHandler(ROOT, fs);

  const response = await handle(new Request("app://renderer/index.html"));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await response.text()).toBe("<!doctype html>");

  const head = await handle(new Request("app://renderer/", { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});

test("the handler answers 404 for a missing file or a rejected URL, and 405 for other methods", async () => {
  const fs = fakeFileSystem({ [join(ROOT, "index.html")]: "x" });
  const handle = createAppProtocolHandler(ROOT, fs);

  expect((await handle(new Request("app://renderer/missing.js"))).status).toBe(
    404,
  );
  expect(
    (await handle(new Request("app://renderer/..%2f..%2fetc%2fpasswd"))).status,
  ).toBe(404);
  expect((await handle(new Request("app://other/index.html"))).status).toBe(
    404,
  );
  expect(
    (
      await handle(
        new Request("app://renderer/index.html", { method: "POST", body: "x" }),
      )
    ).status,
  ).toBe(405);
  expect(fs.reads).toEqual([]);
});

test("every response carries the production Content Security Policy as a header, errors included", async () => {
  const outside = resolve("/etc/passwd");
  const fs = fakeFileSystem(
    { [join(ROOT, "index.html")]: "x", [outside]: "secret" },
    { [join(ROOT, "link.js")]: outside },
  );
  const handle = createAppProtocolHandler(ROOT, fs);

  const responses = [
    await handle(new Request("app://renderer/index.html")),
    await handle(new Request("app://renderer/", { method: "HEAD" })),
    await handle(new Request("app://renderer/missing.js")),
    await handle(new Request("app://renderer/..%2fsecret")),
    await handle(new Request("app://renderer/link.js")),
    await handle(
      new Request("app://renderer/index.html", { method: "POST", body: "x" }),
    ),
  ];
  expect(responses.map((response) => response.status)).toEqual([
    200, 200, 404, 404, 404, 405,
  ]);
  for (const response of responses) {
    expect(response.headers.get("Content-Security-Policy")).toBe(
      CONTENT_SECURITY_POLICY,
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  }
});

test("the handler refuses a symbolic link that leads out of the renderer directory", async () => {
  const outside = resolve("/etc/passwd");
  const fs = fakeFileSystem(
    { [outside]: "root:x:0:0", [join(ROOT, "index.html")]: "x" },
    { [join(ROOT, "assets", "link.js")]: outside },
  );
  const handle = createAppProtocolHandler(ROOT, fs);

  const response = await handle(new Request("app://renderer/assets/link.js"));
  expect(response.status).toBe(404);
  expect(fs.reads).toEqual([]);
});

test("the handler compares real paths when the renderer directory itself is behind a link", async () => {
  const realRoot = resolve("/private/app/out/renderer");
  const fs = fakeFileSystem(
    { [join(realRoot, "index.html")]: "<!doctype html>" },
    {
      [ROOT]: realRoot,
      [join(ROOT, "index.html")]: join(realRoot, "index.html"),
    },
    [realRoot],
  );
  const handle = createAppProtocolHandler(ROOT, fs);

  const response = await handle(new Request("app://renderer/index.html"));
  expect(response.status).toBe(200);
  expect(fs.reads).toEqual([join(realRoot, "index.html")]);
});

test("on the real file system, files inside are served and a linked directory outside is not", async () => {
  const base = await mkdtemp(join(tmpdir(), "mymandev-app-protocol-"));
  try {
    const root = join(base, "renderer");
    const outside = join(base, "outside");
    await mkdir(join(root, "assets"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, "index.html"), "<!doctype html>");
    await writeFile(join(root, "assets", "app.js"), "export {};");
    await writeFile(join(outside, "secret.txt"), "secret");
    // A junction on Windows needs no privilege; elsewhere the type is ignored.
    await symlink(outside, join(root, "linked"), "junction");
    const handle = createAppProtocolHandler(root, { readFile, realpath });

    const index = await handle(new Request("app://renderer/"));
    expect(index.status).toBe(200);
    expect(await index.text()).toBe("<!doctype html>");
    const script = await handle(new Request("app://renderer/assets/app.js"));
    expect(script.status).toBe(200);
    expect(script.headers.get("Content-Type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(
      (await handle(new Request("app://renderer/linked/secret.txt"))).status,
    ).toBe(404);
    expect((await handle(new Request("app://renderer/assets"))).status).toBe(
      404,
    );
    expect(
      (await handle(new Request("app://renderer/missing.js"))).status,
    ).toBe(404);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
