import { contextBridge } from "electron";
import type { DesktopBridge } from "../shared/desktop-bridge.ts";

// A sandboxed preload script runs without Node.js modules; electron-vite
// bundles it as CommonJS. Only the values below reach the renderer.
const bridge: DesktopBridge = {
  electronVersion: process.versions.electron,
};

contextBridge.exposeInMainWorld("desktop", bridge);
