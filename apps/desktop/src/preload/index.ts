import { contextBridge, ipcRenderer } from "electron";
import { createDesktopBridge } from "./bridge.ts";

// A sandboxed preload script runs without Node.js modules; electron-vite
// bundles it as CommonJS. Only the bridge reaches the renderer; ipcRenderer
// stays in the preload script.
contextBridge.exposeInMainWorld(
  "desktop",
  createDesktopBridge(process.versions.electron, ipcRenderer),
);
