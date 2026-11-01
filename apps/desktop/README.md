# @mymandev/desktop

The desktop application: an Electron shell with a React renderer. It shows the product UI skeleton with placeholder content and the status of the local runtime in the main process, which the renderer reads through a typed IPC contract. The decisions behind it are recorded in [ADR 0016](../../docs/architecture/decisions/0016-desktop-toolchain.md).

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

| Path                      | Contents                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/`               | The main process: the single-instance lock, the application window, the `app://` scheme, the navigation rules, the guards for web contents and the session, the local runtime, and the IPC handlers. |
| `src/preload/`            | The preload script. It exposes `window.desktop` to the renderer.                                                                                                                                     |
| `src/renderer/`           | The renderer: `index.html` with the Content Security Policy, the React entry point, the shell, the screens, the screen state, and the stylesheet. It has its own `tsconfig.json`.                    |
| `src/shared/`             | Code and types that several sides use: the product name, the Content Security Policy, the `window.desktop` interface, the IPC channel names, and the IPC contract.                                   |
| `config/csp.ts`           | The Vite plugin that writes the Content Security Policy into `index.html`, with the development server's additions during `npm run dev`.                                                             |
| `electron.vite.config.ts` | The electron-vite configuration for the three targets.                                                                                                                                               |

## Screens

The renderer shows the product UI skeleton (M0-04): the main screens, so that later work has a defined place for its content. Every screen shows placeholder content only. Nothing runs an agent, connects to the cloud API, or reads a repository.

The screens are a typed state, not routes ([ADR 0016](../../docs/architecture/decisions/0016-desktop-toolchain.md)): [`src/renderer/screens.ts`](src/renderer/screens.ts) lists them, and `shellReducer` switches between them. A workspace contains projects ([ADR 0005](../../docs/architecture/decisions/0005-workspaces-contain-projects.md)), so the shell shows either a workspace screen or a screen of the open project.

| Screen        | Belongs to    | Shows                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `home`        | the workspace | A hint to open a project.                                                                                                                                                                                                                                                                                                                                                                                           |
| `about`       | the workspace | The product name and the Electron version.                                                                                                                                                                                                                                                                                                                                                                          |
| `chat`        | a project     | The message list with two placeholder messages, and the message composer, which is disabled.                                                                                                                                                                                                                                                                                                                        |
| `tasks`       | a project     | A placeholder.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `decisions`   | a project     | A placeholder.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `permissions` | a project     | The permission screen shell after [ADR 0015](../../docs/architecture/decisions/0015-capability-and-permission-contract-v0.md), with a placeholder section each for the agent, the repository files (`repo.read`, `repo.write`), Git (`git.commit`, `git.push`), the terminal (`terminal.execute`), the AI provider (`provider.use`), and the granted permissions. The presentation rules of ADR 0015 follow in #77. |

- The header shows the product name and the local runtime status on every screen.
- The sidebar, a `nav` landmark named "Workspace", lists the workspace screens and the workspace's projects. The projects are placeholders ([`src/renderer/placeholder-projects.ts`](src/renderer/placeholder-projects.ts)) that `main.tsx` passes to the shell; the real ones come from the cloud API later.
- A project screen adds the project navigation, a `nav` landmark named "Project" with chat, tasks, decisions, and permissions, and the side panel, an `aside` landmark with the project's agents or its repositories. The side panel stays as it is when another project screen or another project is shown.
- The shown screen is marked with `aria-current="page"` and the open project with `aria-current="true"`. Every navigation item is a button, so the keyboard reaches all of them, and a control focused with the keyboard shows a focus outline.
- The side panel is chosen with tabs (`role="tablist"`, `aria-selected`). Only the selected tab is in the tab order; the arrow keys, Home, and End select another tab and move the focus to it.
- The actions are `show-screen`, `open-project`, and `show-panel`. The reducer refuses a project screen or a side panel while no project is open, an unknown project, and an unknown screen, panel, or action, and then returns the same state object. A first view that is not valid, for example one whose project does not exist, shows the home screen. Two projects with the same ID are refused. A later action that replaces the projects must refuse them in the same way and validate the shown view again.

The styling is a placeholder. [`src/renderer/styles.css`](src/renderer/styles.css) reads colors, fonts, spacing, radii, borders, and the column widths from custom properties on `:root`; colors are written nowhere else. The theme follows the system setting (`prefers-color-scheme`), and a `data-theme` attribute of `light` or `dark` on the root element overrides it, so that the visual design can add a theme setting. The selected item has a background, a bold label, and a bar in the accent color, and in forced colors an underline. The visual design (#122) replaces these tokens and adds the base components. The Content Security Policy allows no inline styles, so styling stays in the stylesheet and never uses a `style` attribute.

## Local runtime

The local runtime ([`src/main/runtime.ts`](src/main/runtime.ts)) is a service in the main process. It starts when the application is ready and stops before the application quits: the first `will-quit` waits until the stop has settled, and the application then quits again ([`src/main/runtime-lifecycle.ts`](src/main/runtime-lifecycle.ts)). Its state is `stopped`, `starting`, `running`, `stopping`, or `failed`, and its `revision` grows by one with every change. A start or stop hook that rejects, throws, or takes longer than 5 seconds moves it to `failed`, so a quit waits at most about two hook timeouts: a start that is still running, then the stop. `stop` also runs the stop hook of a `failed` runtime, so that a start that failed or timed out can clean up, and the application stops a `failed` runtime before it quits as well. The runtime is a placeholder: its hooks do no work, open no network connection, and touch no file. Later milestones add their work there, for example agent execution (M3). The shell header shows the state, for example "Local runtime: Running".

## IPC contract

The renderer reaches the main process only through the functions of `window.desktop`. There is no `ipcRenderer` in the renderer and no function that takes a channel name.

| Channel                    | Direction                        | Arguments | Result or payload  | Bridge function                    |
| -------------------------- | -------------------------------- | --------- | ------------------ | ---------------------------------- |
| `runtime:get-status`       | renderer to main, `invoke`       | none      | the runtime status | `window.desktop.runtime.getStatus` |
| `runtime:subscribe-status` | renderer to main, `invoke`       | none      | the runtime status | `subscribeStatus`                  |
| `runtime:status-changed`   | main to subscribed frames, event |           | the runtime status | `subscribeStatus`                  |

The runtime status is `{ state, revision }` (`RuntimeStatusSchema`). `subscribeStatus(listener, onError)` delivers the current status and every later one, drops a status older than the last one delivered, and returns a function that ends the subscription.

- [`src/shared/ipc-channels.ts`](src/shared/ipc-channels.ts) names the channels. It imports nothing, so the preload script uses the names without bundling zod.
- [`src/shared/ipc-contract.ts`](src/shared/ipc-contract.ts) holds a zod schema for the arguments and the result of every invoke channel (`INVOKE_CONTRACT`) and for the payload of every event channel (`EVENT_CONTRACT`), and the types derived from them. The preload script and the renderer import only the types, so zod is bundled into the main process alone, and the renderer needs no `jitless` setting ([ADR 0003](../../docs/architecture/decisions/0003-zod-runtime-validation.md)).
- [`src/main/ipc.ts`](src/main/ipc.ts) registers the handlers. Each handler first checks the sender: the main frame, not a subframe, still attached, at the URL the window loaded, by the rules of the navigation guard (`isAppNavigation`): in a build only `app://renderer/index.html`, during development the development server's origin ([ADR 0014](../../docs/architecture/decisions/0014-accounts-devices-and-invitations.md)). It then validates the arguments against the contract, and parses its result with the contract, so unknown keys never reach the renderer. A refused call rejects in the renderer with a message that names the channel and the reason, never the arguments. Events go only to frames that subscribed and still show the application.
- [`src/preload/bridge.ts`](src/preload/bridge.ts) builds the frozen `window.desktop` object. Its functions call fixed channels, pass no argument from the renderer on, and never hand the IPC event object, which holds `ipcRenderer`, to the renderer.

To add a channel:

1. Add its name to `INVOKE_CHANNELS` or `EVENT_CHANNELS` in `ipc-channels.ts`, with a `domain:action` name.
2. Add its schemas to `INVOKE_CONTRACT` or `EVENT_CONTRACT` in `ipc-contract.ts`. Every string and array has a maximum length, and objects use `z.object`, which strips unknown keys (ADR 0003). Never send a secret: the device key, tokens, and sign-in codes stay in the main process (ADR 0014).
3. Register an invoke handler with `createInvokeHandler` in `src/main/ipc.ts`, or send an event through a publisher that checks its receivers like `createStatusPublisher`.
4. Add a function for it to `DesktopBridge` in `src/shared/desktop-bridge.ts` and to `createDesktopBridge`. Never expose `ipcRenderer`, a channel name parameter, or a generic `invoke` or `send`.
5. Add tests: the schemas accept and refuse, the handler refuses a foreign sender and invalid arguments, and the bridge keeps its exact shape (`ipc-contract.test.ts`, `ipc.test.ts`, `bridge.test.ts`).

## Security settings

- Every window runs its renderer sandboxed and with context isolation, without Node.js integration (also in workers and subframes), with web security on, and without webviews ([`src/main/window.ts`](src/main/window.ts)). Tests lock these values.
- Developer tools are available only when the application is not packaged.
- Every web contents gets the same guards ([`src/main/guards.ts`](src/main/guards.ts)): `window.open` is denied; a navigation (`will-navigate`, `will-frame-navigate`) or redirect (`will-redirect`) of any frame to a URL outside the application is prevented ([`src/main/navigation.ts`](src/main/navigation.ts)). With the built files, only `app://renderer/index.html` itself is navigable, not other `app://` paths; with the development server, any URL on its origin; attaching a webview is prevented; and Bluetooth device selection is cancelled.
- Every session, the default session and every session created later (`session-created`), gets the session guards once ([`src/main/guards.ts`](src/main/guards.ts)): permission requests are answered with false, permission checks (for example `Notification.permission`) and device permission checks return false, HID, serial, and USB device selection is cancelled, and every download is prevented.
- The main process takes the single-instance lock before anything else ([ADR 0014](../../docs/architecture/decisions/0014-accounts-devices-and-invitations.md)). A second start brings the existing window to the front.
- A built application loads its renderer from `app://renderer/`, a custom scheme registered as standard and secure before the application is ready, not from a `file:` URL ([`src/main/app-protocol.ts`](src/main/app-protocol.ts)). The scheme serves only files inside `out/renderer/`. It answers methods other than GET and HEAD with 405. It answers 404 for another host, credentials, a port, invalid percent-encoding, and a path segment that after decoding is empty, ends with a dot or a space (so also `.`, `..`, and `...`), is a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, with or without an extension, in any case), or contains `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, or a control character. It also answers 404 for a missing file or a directory, and for a path whose real path, after symbolic links, is outside the real path of `out/renderer/`. Every response, errors included, carries the production Content Security Policy as a header and `X-Content-Type-Options: nosniff`; files also get their Content-Type.
- A packaged application always loads its built files. `ELECTRON_RENDERER_URL`, which electron-vite sets during development, is used only when the application is not packaged, and only for an http URL on `localhost`, `127.0.0.1`, or `[::1]`.
- The renderer reaches the main process only through `window.desktop`, which holds the Electron version and the runtime functions of the [IPC contract](#ipc-contract) ([`src/shared/desktop-bridge.ts`](src/shared/desktop-bridge.ts)). The main process checks the sender and the arguments of every IPC call.
- The Content Security Policy is defined once, in [`src/shared/content-security-policy.ts`](src/shared/content-security-policy.ts). It allows scripts, styles, images, and fonts only from the page's own origin, which in a build is `app://renderer` and serves only the built renderer files, and no network connection: no inline code, no `eval`, and no remote origin. The main process sends it as a header with every `app://` response, and [`config/csp.ts`](config/csp.ts) writes it into the meta element of [`src/renderer/index.html`](src/renderer/index.html), whose own value, `default-src 'none'`, blocks everything if that step is missing. During `npm run dev`, the plugin adds what the development server needs: a nonce for the inline scripts and styles it injects (the React Refresh preamble and reloaded styles), new for each start, and `connect-src 'self'` for its hot reload WebSocket.

## Tests

Vitest runs the tests in the Node.js environment, without DOM emulation. They cover the window options, the renderer URL and the navigation rules, the guards (with fake web contents and a fake session, so that a guard that allows or is missing fails a test), the path resolution and the handler of the `app://` scheme (with a fake file system, and once on the real file system with a temporary directory and a directory link that leads out of it), the screen state (every screen and side panel is reachable, and invalid transitions are refused), the markup of every screen with its landmarks, its placeholder content, and the marked navigation item, and the runtime status indicator (rendered with `react-dom/server`), the action that every navigation item and tab sends when it is clicked and the keys of the tab list (the navigation components are called as functions with a fake `dispatch`), the renderer's imports (no Node.js, Electron, or network module, no file outside the renderer and the shared code, and only types from the shared code, except the product name) and its source (no network or Node.js API), the stylesheet (nothing loaded from another origin, colors only in tokens, the same dark tokens for both theme switches), the Content Security Policy, the IPC schemas, the sender check and the handlers, the preload bridge, and the runtime lifecycle with its quit handling. Code that calls Electron stays thin and is not tested directly; the logic it uses is in plain functions that take fakes of `ipcMain`, `ipcRenderer`, `app`, and the timers.

## Not included yet

- The content of the product screens: the workspace's projects, chat, tasks, decisions, agents, repositories, and granting permissions.
- The visual design (#122).
- Work for the local runtime, such as terminal and process execution and agent execution.
- Repository mounting and Git inspection, sign-in, the device key, and the connection to the cloud API.
- Packaging, code signing, the application name and ID, and Electron fuses (#17).
- Tests that launch Electron.
