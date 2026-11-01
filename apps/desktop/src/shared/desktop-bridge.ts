/**
 * What the preload script exposes to the renderer as `window.desktop`.
 *
 * The renderer runs sandboxed, with context isolation and without Node.js. It
 * reaches the main process only through this object. The typed IPC interface
 * of the local runtime is added here later (M1-04).
 */
export interface DesktopBridge {
  /** The Electron version the application runs on, for example "44.9.1". */
  readonly electronVersion: string;
}
