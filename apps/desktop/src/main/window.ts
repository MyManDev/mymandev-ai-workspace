import type { BrowserWindowConstructorOptions } from "electron";
import { PRODUCT_NAME } from "../shared/product.ts";

/**
 * The options of the application window. Every renderer runs sandboxed, with
 * context isolation, without Node.js integration, and with web security on.
 * The values are set explicitly, even where they match Electron's defaults, so
 * that a later change is visible in review and in the tests. A packaged
 * application has no developer tools.
 */
export function createMainWindowOptions(
  preloadPath: string,
  isPackaged: boolean,
): BrowserWindowConstructorOptions {
  return {
    title: PRODUCT_NAME,
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    // Shown on "ready-to-show", so the window does not flash empty.
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: !isPackaged,
    },
  };
}
