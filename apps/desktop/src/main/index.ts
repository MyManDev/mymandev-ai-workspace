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
  forgetConfirmationDetail,
  forgetConfirmationMessage,
  forgetConfirmed,
} from "./account.ts";
import { registerAccountIpc } from "./account-ipc.ts";
import { registerAgentIpc } from "./agent-ipc.ts";
import {
  dialogTimeFormat,
  LIFT_REGISTRATION_LOCK_CONFIRMATION,
  liftRegistrationLockConfirmationMessage,
  liftRegistrationLockConfirmed,
  REMOVE_DEVICE_CONFIRMATION,
  removeDeviceConfirmationMessage,
  removeDeviceConfirmed,
  REVOKE_DEVICE_CONFIRMATIONS,
  revokeDeviceConfirmationMessage,
  revokeDeviceConfirmed,
} from "./account-session.ts";
import { createSystemAccountService } from "./account-system.ts";
import {
  createDevAgentSwitch,
  devAgentSwitchSettings,
} from "./agents/dev-switch.ts";
import { createAgentActivityService } from "./agents/service.ts";
import {
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  createAppProtocolHandler,
} from "./app-protocol.ts";
import { registerChatIpc } from "./chat-ipc.ts";
import { createChatService } from "./chat/service.ts";
import {
  createSystemConnectionClient,
  followSystemResume,
} from "./connection/system.ts";
import { registerConnectionIpc } from "./connection-ipc.ts";
import { claimDataFolder } from "./data-folder.ts";
import { registerDeviceIpc } from "./device-ipc.ts";
import { createDeviceListService } from "./devices/service.ts";
import {
  createSessionGuardInstaller,
  installContentsGuards,
} from "./guards.ts";
import { registerRuntimeIpc } from "./ipc.ts";
import { isAppNavigation, resolveRendererUrl } from "./navigation.ts";
import { registerInvitationActionsIpc } from "./invitation-actions-ipc.ts";
import { registerInvitationIpc } from "./invitation-ipc.ts";
import { createInvitationService } from "./invitations/service.ts";
import { registerPeopleActionsIpc } from "./people-actions-ipc.ts";
import { registerPeopleIpc } from "./people-ipc.ts";
import { registerRepositoryIpc } from "./repository-ipc.ts";
import {
  createSystemRepositoryService,
  FOLDER_DIALOG_OPTIONS,
  selectedFolder,
} from "./repository-system.ts";
import { createLocalRuntime } from "./runtime.ts";
import { stopRuntimeOnQuit } from "./runtime-lifecycle.ts";
import { createMainWindowOptions } from "./window.ts";
import { createWorkspaceService } from "./workspace/service.ts";
import {
  askBeforeClosingWithWaitingMessages,
  CLOSE_WITH_WAITING_CONFIRMATION,
  closeProjectWithPage,
  closeWithWaitingConfirmed,
  closeWithWaitingMessage,
  followQuitRequests,
  registerWorkspaceIpc,
} from "./workspace-ipc.ts";

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
    // like the folder dialog of the repositories. Its detail says what
    // happens to the device at the server in this case (#198).
    confirmForget: async (login, removal) => {
      const options = {
        ...FORGET_CONFIRMATION,
        buttons: [...FORGET_CONFIRMATION.buttons],
        message: forgetConfirmationMessage(login),
        detail: forgetConfirmationDetail(removal),
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
    // Revoking another device of the account (#95) is confirmed the same
    // way, with the device's label and platform and, for a lost device, the
    // 7-day registration lock that it starts.
    confirmRevokeDevice: async (login, device, reason) => {
      const confirmation = REVOKE_DEVICE_CONFIRMATIONS[reason];
      const options = {
        ...confirmation,
        buttons: [...confirmation.buttons],
        message: revokeDeviceConfirmationMessage(login, device, reason),
      };
      return revokeDeviceConfirmed(
        mainWindow === undefined
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(mainWindow, options),
      );
    },
    // And lifting the registration lock, with the end of the lock in the
    // application's locale and the system's time zone.
    confirmLiftRegistrationLock: async (login, lockedUntil) => {
      const options = {
        ...LIFT_REGISTRATION_LOCK_CONFIRMATION,
        buttons: [...LIFT_REGISTRATION_LOCK_CONFIRMATION.buttons],
        message: liftRegistrationLockConfirmationMessage(
          login,
          lockedUntil,
          dialogTimeFormat(app.getLocale()),
        ),
      };
      return liftRegistrationLockConfirmed(
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

  // The connection to the cloud API (#26): one WebSocket in the main process
  // while the account reports a signed-in device with a loaded key. The
  // device session signs its challenge, and its close reasons reach the
  // session through the account service, which stops local execution after
  // `device_revoked`. The logs hold fixed text and close codes only, never
  // a frame, a nonce, a signature, or a key. It closes (1000) at quit.
  const connection = createSystemConnectionClient(account, (message) =>
    console.info(message),
  );
  connection.onStatusChange((status) => {
    console.info(
      "reason" in status && status.reason !== undefined
        ? `The connection to the API is ${status.state} (${status.reason}).`
        : `The connection to the API is ${status.state}.`,
    );
  });
  registerConnectionIpc(ipcMain, rendererUrl, connection);
  app.on("will-quit", () => connection.close());

  // The account's devices and the end of a registration lock in force (#95,
  // D4 and D5b), read over HTTP once the Account screen asked for them and
  // again after the account frames, a reconnect, and the person's device
  // actions, with the notices of new devices from the live frame. It
  // revokes another device of its list or of a notice and lifts a lock
  // that its list reported, through the account service, which confirms
  // each in a native dialog, and it keeps the advice after a revocation as
  // lost until the person dismisses it. It
  // reaches the renderer through its own channels, at most one publish every
  // 50 ms. The logs are fixed text with a failure code at most, never a
  // label or an ID.
  const devices = createDeviceListService({
    account,
    connection,
    log: (message) => console.info(message),
  });
  app.on("will-quit", () => devices.close());
  const deviceIpc = registerDeviceIpc(ipcMain, rendererUrl, { devices });
  app.on("will-quit", () => deviceIpc.close());

  // The account's workspaces and the selected one's people and projects
  // (#27, #28), read over HTTP and kept current with the workspace's events.
  // It subscribes to the selected workspace only. The renderer reads its
  // IDs and names and selects a workspace or opens a project over IPC,
  // through the chat service below; the chat and agent services read it in
  // the main process. The logs are fixed text with a failure code at most,
  // never a name or an ID.
  const workspaces = createWorkspaceService({
    account,
    connection,
    log: (message) => console.info(message),
  });
  app.on("will-quit", () => workspaces.close());

  // The agents and runs of the open project (#28), read over HTTP and kept
  // current with the selected workspace's run events through its own resync
  // gate. It never sends an event. It is created right after the workspace
  // service, so that it sees the first `workspace.subscribed`. The logs are
  // fixed text with a failure code at most, never a name or an ID.
  const agents = createAgentActivityService({
    account,
    connection,
    workspaces,
    log: (message) => console.info(message),
  });
  app.on("will-quit", () => agents.close());

  // The agent activity reaches the renderer read-only, with the owners'
  // names resolved in the main process and the newest runs only, at most
  // one publish every 50 ms. Its waiting publish is cancelled at quit.
  const agentIpc = registerAgentIpc(ipcMain, rendererUrl, {
    agents,
    workspaces,
  });
  app.on("will-quit", () => agentIpc.close());
  // The development agent switch (#28): only in an unpackaged build, and
  // only when MYMANDEV_DEV_AGENT_SWITCH holds the agent ID that
  // `db:dev-seed` printed and MYMANDEV_DEV_AGENT_DEVICE the device ID that
  // it was given. It moves that agent's runs as the agent, from its host
  // device, and has no IPC channel, so a packaged build sends nothing. The
  // logs are fixed text with a code at most, never an ID.
  if (!app.isPackaged) {
    const settings = devAgentSwitchSettings(
      app.isPackaged,
      process.env,
      (message) => console.info(message),
    );
    if (settings !== null) {
      const devSwitch = createDevAgentSwitch({
        settings,
        account,
        connection,
        workspaces,
        agents,
        log: (message) => console.info(message),
      });
      app.on("will-quit", () => devSwitch.close());
    }
  }

  // The open project's chat (#27): its history, read over HTTP, its
  // `chat.message.created` events, and the person's messages, sent with the
  // connection's `sendAs`. Messages that wait for the connection stay in
  // memory only. The logs are fixed text with a failure code at most, never
  // a name, an ID, or a message body.
  const chat = createChatService({
    account,
    connection,
    workspaces,
    log: (message) => console.info(message),
  });
  app.on("will-quit", () => chat.close());

  // Every switch of the project or the workspace that the renderer asks for
  // goes through the chat service's `switchProject` and `selectWorkspace`,
  // which answer `waiting` while chat messages wait to be sent, so that the
  // person is asked first.
  registerWorkspaceIpc(ipcMain, rendererUrl, workspaces, chat);

  // The selected workspace's people (#95, D3) reach the renderer read-only:
  // member IDs, names, roles, and logins, never a user ID, at most one
  // publish every 50 ms. Its waiting publish is cancelled at quit.
  const peopleIpc = registerPeopleIpc(ipcMain, rendererUrl, { workspaces });
  app.on("will-quit", () => peopleIpc.close());
  // The people actions (#95, D1) have one strict channel each. Each sends
  // one write of the allowlist with the account service, once, and only for
  // the selected workspace; its membership event then changes the people,
  // and the offer actions reload the workspace.
  registerPeopleActionsIpc(ipcMain, rendererUrl, { account, workspaces });

  // The selected workspace's live invitations (#95, D3), for its owner and
  // admins only, read over HTTP once the screen asked and again after
  // `workspace.subscribed`, a claim, and an invitation action. The API's
  // list holds no invitation code. They reach the renderer with their
  // creators' names resolved in the main process, at most one publish every
  // 50 ms. The logs are fixed text with a failure code at most.
  const invitations = createInvitationService({
    account,
    connection,
    workspaces,
    log: (message) => console.info(message),
  });
  app.on("will-quit", () => invitations.close());
  const invitationIpc = registerInvitationIpc(ipcMain, rendererUrl, {
    invitations,
    workspaces,
  });
  app.on("will-quit", () => invitationIpc.close());
  // The invitation actions (#95, D1 and D2) have one strict channel each,
  // and each is sent once. The code of a new invitation goes to the
  // renderer once, in the answer of the create, and a pasted code goes on
  // in the body of a preview or an accept only: the main process never
  // keeps, logs, or publishes either. An accept loads the workspace list
  // again.
  registerInvitationActionsIpc(ipcMain, rendererUrl, {
    account,
    workspaces,
    invitations,
  });

  // The chat reaches the renderer with the authors' names resolved in the
  // main process, within the view's limits and text budget, at most one
  // publish every 50 ms. Its waiting publish is cancelled at quit.
  const chatIpc = registerChatIpc(ipcMain, rendererUrl, {
    chat,
    workspaces,
  });
  app.on("will-quit", () => chatIpc.close());

  // A quit, for example with Cmd+Q on macOS, closes the window first. When
  // the person confirms closing it with waiting chat messages, the quit is
  // carried out once the window has closed, because the held close ended it.
  const quits = followQuitRequests(app);

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
    // The open project closes with the page that opened it: when a new
    // document commits, also on a reload, when the page fails to load, when
    // the render process is gone, and when the window closes.
    closeProjectWithPage(window, workspaces);
    // Closing the window while chat messages wait to be sent asks first, in
    // a native dialog (the Project Manager's decision of 2026-11-06 on #27).
    askBeforeClosingWithWaitingMessages(
      window,
      () => chat.state().pending.length,
      async (count) =>
        closeWithWaitingConfirmed(
          await dialog.showMessageBox(window, {
            ...CLOSE_WITH_WAITING_CONFIRMATION,
            buttons: [...CLOSE_WITH_WAITING_CONFIRMATION.buttons],
            message: closeWithWaitingMessage(count),
          }),
        ),
      quits,
    );
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
      followSystemResume(connection);
      showMainWindow();
      app.on("activate", showMainWindow);
    })
    .catch((error: unknown) => {
      console.error("The application failed to start.", error);
      app.exit(1);
    });
}
