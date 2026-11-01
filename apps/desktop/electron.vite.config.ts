import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { contentSecurityPolicy } from "./config/csp.ts";

// electron-vite bundles three targets into out/: the main process
// (src/main, ES module), the preload script (src/preload), and the renderer
// (src/renderer/index.html). Workspace packages that the main process or the
// preload script import are bundled too (ADR 0001).
export default defineConfig({
  main: {},
  preload: {
    build: {
      rolldownOptions: {
        // A sandboxed preload script cannot be an ES module.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react(), contentSecurityPolicy()],
  },
});
