import { expect, test } from "vitest";
import {
  createSessionGuardInstaller,
  installContentsGuards,
  installSessionGuards,
  type GuardedContents,
  type GuardedSession,
  type NavigationEvent,
  type PreventableEvent,
} from "./guards.ts";

class FakeEvent implements NavigationEvent {
  prevented = false;
  readonly url: string;
  constructor(url = "") {
    this.url = url;
  }
  preventDefault(): void {
    this.prevented = true;
  }
}

class FakeEmitter {
  readonly listeners = new Map<string, unknown>();
  on(event: string, listener: unknown): this {
    expect(this.listeners.has(event)).toBe(false);
    this.listeners.set(event, listener);
    return this;
  }
  listener<T>(event: string): T {
    const listener = this.listeners.get(event);
    expect(listener).toBeTypeOf("function");
    return listener as T;
  }
}

class FakeContents extends FakeEmitter implements GuardedContents {
  windowOpenHandler: (() => { action: "deny" }) | undefined;
  setWindowOpenHandler(handler: () => { action: "deny" }): void {
    this.windowOpenHandler = handler;
  }
}

class FakeSession extends FakeEmitter implements GuardedSession {
  requestHandler:
    | ((
        webContents: unknown,
        permission: string,
        callback: (granted: boolean) => void,
      ) => void)
    | undefined;
  checkHandler: (() => boolean) | undefined;
  deviceHandler: (() => boolean) | undefined;
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void {
    this.requestHandler = handler;
  }
  setPermissionCheckHandler(handler: () => boolean): void {
    this.checkHandler = handler;
  }
  setDevicePermissionHandler(handler: () => boolean): void {
    this.deviceHandler = handler;
  }
}

type NavigationListener = (event: NavigationEvent) => void;
type DeviceCallback = (...args: unknown[]) => void;

function guardedContents(appUrls: readonly string[]): {
  contents: FakeContents;
  checked: string[];
} {
  const contents = new FakeContents();
  const checked: string[] = [];
  installContentsGuards(contents, (url) => {
    checked.push(url);
    return appUrls.includes(url);
  });
  return { contents, checked };
}

test("every web contents gets exactly these guards", () => {
  const { contents } = guardedContents([]);

  expect([...contents.listeners.keys()].sort()).toEqual([
    "select-bluetooth-device",
    "will-attach-webview",
    "will-frame-navigate",
    "will-navigate",
    "will-redirect",
  ]);
  expect(contents.windowOpenHandler?.()).toEqual({ action: "deny" });
});

test("navigation and redirects to a URL outside the application are prevented", () => {
  const { contents, checked } = guardedContents(["app://renderer/index.html"]);

  for (const name of [
    "will-navigate",
    "will-frame-navigate",
    "will-redirect",
  ]) {
    const listener = contents.listener<NavigationListener>(name);
    const outside = new FakeEvent("https://example.com/");
    listener(outside);
    expect(outside.prevented).toBe(true);
    const inside = new FakeEvent("app://renderer/index.html");
    listener(inside);
    expect(inside.prevented).toBe(false);
  }
  expect(checked).toEqual([
    "https://example.com/",
    "app://renderer/index.html",
    "https://example.com/",
    "app://renderer/index.html",
    "https://example.com/",
    "app://renderer/index.html",
  ]);
});

test("webviews and Bluetooth device selection are refused", () => {
  const { contents } = guardedContents([]);

  const webview = new FakeEvent();
  contents.listener<(event: PreventableEvent) => void>("will-attach-webview")(
    webview,
  );
  expect(webview.prevented).toBe(true);

  const bluetooth = new FakeEvent();
  const calls: unknown[][] = [];
  contents.listener<
    (
      event: PreventableEvent,
      devices: unknown,
      callback: DeviceCallback,
    ) => void
  >("select-bluetooth-device")(bluetooth, [{ deviceId: "a" }], (...args) =>
    calls.push(args),
  );
  expect(bluetooth.prevented).toBe(true);
  expect(calls).toEqual([[""]]);
});

test("the session denies every permission request, permission check, and device permission", () => {
  const session = new FakeSession();
  installSessionGuards(session);

  for (const permission of [
    "notifications",
    "media",
    "clipboard-read",
    "hid",
  ]) {
    const answers: boolean[] = [];
    session.requestHandler?.({}, permission, (granted) =>
      answers.push(granted),
    );
    expect(answers).toEqual([false]);
  }
  expect(session.checkHandler?.()).toBe(false);
  expect(session.deviceHandler?.()).toBe(false);
});

test("the session cancels HID, serial, and USB device selection", () => {
  const session = new FakeSession();
  installSessionGuards(session);

  expect([...session.listeners.keys()].sort()).toEqual([
    "select-hid-device",
    "select-serial-port",
    "select-usb-device",
    "will-download",
  ]);

  const hid = new FakeEvent();
  const hidCalls: unknown[][] = [];
  session.listener<
    (
      event: PreventableEvent,
      details: unknown,
      callback: DeviceCallback,
    ) => void
  >("select-hid-device")(hid, { deviceList: [{ deviceId: "a" }] }, (...args) =>
    hidCalls.push(args),
  );
  expect(hid.prevented).toBe(true);
  expect(hidCalls).toEqual([[]]);

  const serial = new FakeEvent();
  const serialCalls: unknown[][] = [];
  session.listener<
    (
      event: PreventableEvent,
      portList: unknown,
      webContents: unknown,
      callback: DeviceCallback,
    ) => void
  >("select-serial-port")(serial, [{ portId: "a" }], {}, (...args) =>
    serialCalls.push(args),
  );
  expect(serial.prevented).toBe(true);
  expect(serialCalls).toEqual([[""]]);

  const usb = new FakeEvent();
  const usbCalls: unknown[][] = [];
  session.listener<
    (
      event: PreventableEvent,
      details: unknown,
      callback: DeviceCallback,
    ) => void
  >("select-usb-device")(usb, { deviceList: [{ deviceId: "a" }] }, (...args) =>
    usbCalls.push(args),
  );
  expect(usb.prevented).toBe(true);
  expect(usbCalls).toEqual([[]]);
});

test("the session prevents every download", () => {
  const session = new FakeSession();
  installSessionGuards(session);

  const download = new FakeEvent();
  session.listener<(event: PreventableEvent) => void>("will-download")(
    download,
  );
  expect(download.prevented).toBe(true);
});

test("the installer guards each session once, the default session and every later one", () => {
  const installed: GuardedSession[] = [];
  const guard = createSessionGuardInstaller((session) =>
    installed.push(session),
  );
  const defaultSession = new FakeSession();
  const partition = new FakeSession();

  guard(defaultSession);
  guard(partition);
  guard(defaultSession);
  expect(installed).toHaveLength(2);
  expect(installed[0]).toBe(defaultSession);
  expect(installed[1]).toBe(partition);

  const real = createSessionGuardInstaller();
  const session = new FakeSession();
  real(session);
  real(session);
  expect(session.checkHandler?.()).toBe(false);
  expect(session.listeners.size).toBe(4);
});
