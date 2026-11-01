import type { DesktopBridge } from "../shared/desktop-bridge.ts";

declare global {
  interface Window {
    /** Set by the preload script; absent when the page runs outside Electron. */
    readonly desktop?: DesktopBridge;
  }
}
