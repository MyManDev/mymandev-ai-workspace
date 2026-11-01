// The guards that every web contents and the default session get. They take
// minimal interfaces instead of Electron's classes, so that tests can pass
// fakes (ADR 0002) and check that each handler denies.

export interface PreventableEvent {
  preventDefault(): void;
}

export interface NavigationEvent extends PreventableEvent {
  /** The URL the frame is navigating or being redirected to. */
  readonly url: string;
}

/** The part of Electron's `WebContents` that the guards use. */
export interface GuardedContents {
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  on(
    event: "will-navigate",
    listener: (event: NavigationEvent) => void,
  ): unknown;
  on(
    event: "will-frame-navigate",
    listener: (event: NavigationEvent) => void,
  ): unknown;
  on(
    event: "will-redirect",
    listener: (event: NavigationEvent) => void,
  ): unknown;
  on(
    event: "will-attach-webview",
    listener: (event: PreventableEvent) => void,
  ): unknown;
  on(
    event: "select-bluetooth-device",
    listener: (
      event: PreventableEvent,
      devices: unknown,
      callback: (deviceId: string) => void,
    ) => void,
  ): unknown;
}

/** The part of Electron's `Session` that the guards use. */
export interface GuardedSession {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (permissionGranted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
  setDevicePermissionHandler(handler: () => boolean): void;
  on(
    event: "select-hid-device",
    listener: (
      event: PreventableEvent,
      details: unknown,
      callback: (deviceId?: string | null) => void,
    ) => void,
  ): unknown;
  on(
    event: "select-serial-port",
    listener: (
      event: PreventableEvent,
      portList: unknown,
      webContents: unknown,
      callback: (portId: string) => void,
    ) => void,
  ): unknown;
  on(
    event: "select-usb-device",
    listener: (
      event: PreventableEvent,
      details: unknown,
      callback: (deviceId?: string) => void,
    ) => void,
  ): unknown;
  on(
    event: "will-download",
    listener: (event: PreventableEvent) => void,
  ): unknown;
}

/**
 * No new windows, no navigation or redirect of any frame to a URL outside the
 * application, no webviews, and no Bluetooth device selection.
 */
export function installContentsGuards(
  contents: GuardedContents,
  isAppUrl: (url: string) => boolean,
): void {
  const blockLeavingApp = (event: NavigationEvent): void => {
    if (!isAppUrl(event.url)) {
      event.preventDefault();
    }
  };
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", blockLeavingApp);
  contents.on("will-frame-navigate", blockLeavingApp);
  contents.on("will-redirect", blockLeavingApp);
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("select-bluetooth-device", (event, _devices, callback) => {
    event.preventDefault();
    callback("");
  });
}

/**
 * The shell needs no web permission, no device, and no download: permission
 * requests are denied, permission checks and device permission checks return
 * false, HID, serial, and USB device selection is cancelled, and every
 * download is prevented.
 */
export function installSessionGuards(session: GuardedSession): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.on("select-hid-device", (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  session.on(
    "select-serial-port",
    (event, _portList, _webContents, callback) => {
      event.preventDefault();
      callback("");
    },
  );
  session.on("select-usb-device", (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  session.on("will-download", (event) => event.preventDefault());
}

/**
 * Returns a function that installs the session guards once per session, for
 * the default session and for every session created later
 * (`app.on("session-created")`), which may also report the default session.
 */
export function createSessionGuardInstaller(
  install: (session: GuardedSession) => void = installSessionGuards,
): (session: GuardedSession) => void {
  const guarded = new WeakSet<GuardedSession>();
  return (session) => {
    if (!guarded.has(session)) {
      guarded.add(session);
      install(session);
    }
  };
}
