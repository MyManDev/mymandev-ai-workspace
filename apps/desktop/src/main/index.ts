import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
} from "electron";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  createAppProtocolHandler,
} from "./app-protocol.ts";
import {
  createSessionGuardInstaller,
  installContentsGuards,
} from "./guards.ts";
import { registerRuntimeIpc } from "./ipc.ts";
import { isAppNavigation, resolveRendererUrl } from "./navigation.ts";
import { registerRepositoryIpc } from "./repository-ipc.ts";
import {
  createSystemRepositoryService,
  FOLDER_DIALOG_OPTIONS,
  selectedFolder,
} from "./repository-system.ts";
import { createLocalRuntime } from "./runtime.ts";
import { stopRuntimeOnQuit } from "./runtime-lifecycle.ts";
import { createMainWindowOptions } from "./window.ts";

// ADR 0014: the main process takes the single-instance lock before anything
// touches the device key, so two instances never share one key. A second
// instance quits at once and the first one shows its window.
if (app.requestSingleInstanceLock()) {
  start();
} else {
  app.quit();
}

function start(): void {
  // Custom schemes must be registered before the "ready" event.
  protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);

  const rendererUrl = resolveRendererUrl({
    isPackaged: app.isPackaged,
    devServerUrl: process.env["ELECTRON_RENDERER_URL"],
  });
  const rendererDir = join(import.meta.dirname, "../renderer");
  const preloadPath = join(import.meta.dirname, "../preload/index.cjs");
  let mainWindow: BrowserWindow | undefined;

  // The local runtime starts when the application is ready and stops before
  // it quits. The handlers are registered before the first window loads, so
  // that the renderer's first call finds them.
  const runtime = createLocalRuntime({
    onError: (message, error) => console.error(message, error),
  });
  runtime.onStatusChange((status) => {
    console.info(`The local runtime is ${status.state}.`);
  });
  registerRuntimeIpc(ipcMain, rendererUrl, runtime);
  stopRuntimeOnQuit(app, runtime);

  // Mounted repositories: read with Git and watched, never written. The
  // folder comes from the dialog of the main process, never from the
  // renderer. Watchers stop and Git commands are cancelled at quit.
  const repositories = createSystemRepositoryService((message, error) =>
    console.error(message, error),
  );
  registerRepositoryIpc(ipcMain, rendererUrl, repositories, async () => {
    const options = {
      ...FOLDER_DIALOG_OPTIONS,
      properties: [...FOLDER_DIALOG_OPTIONS.properties],
    };
    return selectedFolder(
      mainWindow === undefined
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(mainWindow, options),
    );
  });
  app.on("will-quit", () => repositories.close());

  function showMainWindow(): void {
    if (mainWindow !== undefined) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
      return;
    }
    const window = new BrowserWindow(
      createMainWindowOptions(preloadPath, app.isPackaged),
    );
    mainWindow = window;
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      mainWindow = undefined;
    });
    window.loadURL(rendererUrl).catch((error: unknown) => {
      console.error("The application window failed to load.", error);
    });
  }

  // Every session, including partitions that later code creates.
  const guardSession = createSessionGuardInstaller();
  app.on("session-created", guardSession);

  // Every web contents, including windows that later code creates.
  app.on("web-contents-created", (_event, contents) => {
    installContentsGuards(contents, (url) => isAppNavigation(url, rendererUrl));
  });

  app.on("second-instance", () => {
    if (app.isReady()) {
      showMainWindow();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app
    .whenReady()
    .then(() => {
      guardSession(session.defaultSession);
      protocol.handle(
        APP_SCHEME,
        createAppProtocolHandler(rendererDir, { readFile, realpath }),
      );
      void runtime.start();
      showMainWindow();
      app.on("activate", showMainWindow);
    })
    .catch((error: unknown) => {
      console.error("The application failed to start.", error);
      app.exit(1);
    });
}
