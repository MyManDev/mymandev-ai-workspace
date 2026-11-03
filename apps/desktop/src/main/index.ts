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
  FORGET_CONFIRMATION,
  forgetConfirmationMessage,
  forgetConfirmed,
} from "./account.ts";
import { registerAccountIpc } from "./account-ipc.ts";
import {
  REMOVE_DEVICE_CONFIRMATION,
  removeDeviceConfirmationMessage,
  removeDeviceConfirmed,
} from "./account-session.ts";
import { createSystemAccountService } from "./account-system.ts";
import {
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  createAppProtocolHandler,
} from "./app-protocol.ts";
import { claimDataFolder } from "./data-folder.ts";
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

// The data folder is set first, before anything reads it, and the
// single-instance lock is then taken in it (data-folder.ts). ADR 0014: the
// main process takes the single-instance lock before anything touches the
// device key, so two instances never share one key. A second instance quits
// at once and the first one shows its window.
if (claimDataFolder(app)) {
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

  // The account: the device key, the sign-in, and the device session (ADR
  // 0014). This instance holds the single-instance lock, so no other
  // instance touches the key. The key store needs a ready application, so
  // it is opened and the key is loaded once when the application is ready;
  // until then the status says that the key is loading. The device session
  // is created and refreshed after the load. The sign-in, the sign-out, and
  // the removal start only on the person's action in the renderer. The
  // messages are fixed text, and the key store's errors hold no secret.
  const account = createSystemAccountService({
    focusWindow: () => focusMainWindow(),
    // "This is not me" is confirmed in a native dialog of the main process,
    // like the folder dialog of the repositories.
    confirmForget: async (login) => {
      const options = {
        ...FORGET_CONFIRMATION,
        buttons: [...FORGET_CONFIRMATION.buttons],
        message: forgetConfirmationMessage(login),
      };
      return forgetConfirmed(
        mainWindow === undefined
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(mainWindow, options),
      );
    },
    // Removing this device is confirmed the same way.
    confirmRemoveDevice: async (login) => {
      const options = {
        ...REMOVE_DEVICE_CONFIRMATION,
        buttons: [...REMOVE_DEVICE_CONFIRMATION.buttons],
        message: removeDeviceConfirmationMessage(login),
      };
      return removeDeviceConfirmed(
        mainWindow === undefined
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(mainWindow, options),
      );
    },
    // ADR 0014: a revoked device stops local execution. The local runtime
    // is a placeholder that executes nothing yet (runtime.ts), so there is
    // nothing to stop; stopping it would only leave it stopped with no way
    // back after the next sign-in. The local runtime tasks (terminal,
    // process, and agent execution) stop their work here.
    stopLocalExecution: () => undefined,
    onError: (message, error) =>
      error === undefined
        ? console.error(message)
        : console.error(message, error),
  });
  registerAccountIpc(ipcMain, rendererUrl, account);

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

  // ADR 0014, "Sign-in", step 6: after the browser posted to the sign-in
  // listener, the window comes to the front so that the person sees the
  // result. On macOS the application must also become the active one.
  function focusMainWindow(): void {
    if (!app.isReady()) {
      return;
    }
    showMainWindow();
    if (process.platform === "darwin") {
      app.focus({ steal: true });
    }
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
      // The key is loaded before anything uses it; the device session then
      // refreshes, which retries a pending removal or sign-out report.
      void account.initialize();
      showMainWindow();
      app.on("activate", showMainWindow);
    })
    .catch((error: unknown) => {
      console.error("The application failed to start.", error);
      app.exit(1);
    });
}
