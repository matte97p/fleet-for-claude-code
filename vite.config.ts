import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Builds the webview UI into a single JS + CSS bundle that the extension loads
// into a VS Code Webview. We inline nothing to external CDNs (CSP-safe) and emit
// predictable filenames so the extension can reference them.
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "webview"),
  build: {
    outDir: resolve(__dirname, "dist/webview"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: resolve(__dirname, "webview/index.html"),
      output: {
        entryFileNames: "webview.js",
        assetFileNames: "webview.[ext]",
      },
    },
  },
});
