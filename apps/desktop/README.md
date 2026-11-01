# @mymandev/desktop

The desktop application: an Electron shell with a React renderer. It shows the product name and a placeholder screen structure. The decisions behind it are recorded in [ADR 0016](../../docs/architecture/decisions/0016-desktop-toolchain.md).

## Start locally

From the repository root, after `npm ci`:

```sh
npm run dev -w @mymandev/desktop
```

The first start downloads the Electron binary for your platform (about 130 MB on macOS) and checks it against the SHA-256 checksums that the Electron npm package ships. Later starts reuse it. electron-vite then builds the main process and the preload script, starts the Vite development server on `http://localhost:5173`, and opens the application window. A change in the renderer reloads in place. A change in the main process or the preload script takes effect after a restart; electron-vite's `--watch` option (`npm run dev -w @mymandev/desktop -- --watch`) rebuilds and restarts them on change instead. Stop it with Ctrl+C.

Some shells and tools set the environment variable `ELECTRON_RUN_AS_NODE`. With it, Electron runs as plain Node.js, and the start fails with "The requested module 'electron' does not provide an export named". Unset it before `npm run dev`, for example with `unset ELECTRON_RUN_AS_NODE` on Linux and macOS, or `Remove-Item Env:ELECTRON_RUN_AS_NODE` in PowerShell.

## Scripts

| Script      | Runs                                                        |
| ----------- | ----------------------------------------------------------- |
| `dev`       | `install-electron && electron-vite dev`                     |
| `build`     | `electron-vite build`                                       |
| `typecheck` | `tsc -p tsconfig.json && tsc -p src/renderer/tsconfig.json` |
| `test`      | `vitest run`                                                |

Run them from the repository root with `-w @mymandev/desktop`, or from `apps/desktop`. `build` writes the bundles to `out/`: `out/main/index.js` (an ES module), `out/preload/index.cjs`, and `out/renderer/`. The type check, the tests, and the build do not need the Electron binary. `npx --no-install electron-vite preview` builds the application and starts it from `out/` the way a build runs: the renderer loads from `app://renderer/`.

## Layout

| Path                      | Contents                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/`               | The main process: the single-instance lock, the application window, the `app://` scheme, the navigation rules, and the guards for web contents and the session. |
| `src/preload/`            | The preload script. It exposes `window.desktop` to the renderer.                                                                                                |
| `src/renderer/`           | The renderer: `index.html` with the Content Security Policy, the React entry point, the shell, and the screen state. It has its own `tsconfig.json`.            |
| `src/shared/`             | Code and types that both sides use: the product name, the Content Security Policy, and the `window.desktop` interface.                                          |
| `config/csp.ts`           | The Vite plugin that writes the Content Security Policy into `index.html`, with the development server's additions during `npm run dev`.                        |
| `electron.vite.config.ts` | The electron-vite configuration for the three targets.                                                                                                          |

The screens are a typed state, not routes: `src/renderer/screens.ts` lists them, and `shellReducer` switches between them.

## Security settings

- Every window runs its renderer sandboxed and with context isolation, without Node.js integration (also in workers and subframes), with web security on, and without webviews ([`src/main/window.ts`](src/main/window.ts)). Tests lock these values.
- Developer tools are available only when the application is not packaged.
- Every web contents gets the same guards ([`src/main/guards.ts`](src/main/guards.ts)): `window.open` is denied; a navigation (`will-navigate`, `will-frame-navigate`) or redirect (`will-redirect`) of any frame to a URL outside the application is prevented ([`src/main/navigation.ts`](src/main/navigation.ts)). With the built files, only `app://renderer/index.html` itself is navigable, not other `app://` paths; with the development server, any URL on its origin; attaching a webview is prevented; and Bluetooth device selection is cancelled.
- Every session, the default session and every session created later (`session-created`), gets the session guards once ([`src/main/guards.ts`](src/main/guards.ts)): permission requests are answered with false, permission checks (for example `Notification.permission`) and device permission checks return false, HID, serial, and USB device selection is cancelled, and every download is prevented.
- The main process takes the single-instance lock before anything else ([ADR 0014](../../docs/architecture/decisions/0014-accounts-devices-and-invitations.md)). A second start brings the existing window to the front.
- A built application loads its renderer from `app://renderer/`, a custom scheme registered as standard and secure before the application is ready, not from a `file:` URL ([`src/main/app-protocol.ts`](src/main/app-protocol.ts)). The scheme serves only files inside `out/renderer/`. It answers methods other than GET and HEAD with 405. It answers 404 for another host, credentials, a port, invalid percent-encoding, and a path segment that after decoding is empty, ends with a dot or a space (so also `.`, `..`, and `...`), is a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, with or without an extension, in any case), or contains `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, or a control character. It also answers 404 for a missing file or a directory, and for a path whose real path, after symbolic links, is outside the real path of `out/renderer/`. Every response, errors included, carries the production Content Security Policy as a header and `X-Content-Type-Options: nosniff`; files also get their Content-Type.
- A packaged application always loads its built files. `ELECTRON_RENDERER_URL`, which electron-vite sets during development, is used only when the application is not packaged, and only for an http URL on `localhost`, `127.0.0.1`, or `[::1]`.
- The renderer reaches the main process only through `window.desktop`, which holds the Electron version ([`src/shared/desktop-bridge.ts`](src/shared/desktop-bridge.ts)).
- The Content Security Policy is defined once, in [`src/shared/content-security-policy.ts`](src/shared/content-security-policy.ts). It allows scripts, styles, images, and fonts only from the page's own origin, which in a build is `app://renderer` and serves only the built renderer files, and no network connection: no inline code, no `eval`, and no remote origin. The main process sends it as a header with every `app://` response, and [`config/csp.ts`](config/csp.ts) writes it into the meta element of [`src/renderer/index.html`](src/renderer/index.html), whose own value, `default-src 'none'`, blocks everything if that step is missing. During `npm run dev`, the plugin adds what the development server needs: a nonce for the inline scripts and styles it injects (the React Refresh preamble and reloaded styles), new for each start, and `connect-src 'self'` for its hot reload WebSocket.

## Tests

Vitest runs the tests in the Node.js environment, without DOM emulation. They cover the window options, the renderer URL and the navigation rules, the guards (with fake web contents and a fake session, so that a guard that allows or is missing fails a test), the path resolution and the handler of the `app://` scheme (with a fake file system, and once on the real file system with a temporary directory and a directory link that leads out of it), the screen state, the shell markup (rendered with `react-dom/server`), and the Content Security Policy. Code that calls Electron stays thin and is not tested directly; the logic it uses is in plain functions.

## Not included yet

- The product screens (M0-04).
- The local runtime and the typed IPC interface between the renderer and the main process (M1-04).
- Repository mounting and Git inspection, sign-in, the device key, and the connection to the cloud API.
- Packaging, code signing, the application name and ID, and Electron fuses (#17).
- Tests that launch Electron.
