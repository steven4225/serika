import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { createBuildManifest } from "./src/main/build-identity.js";

const build = createBuildManifest(fileURLToPath(new URL(".", import.meta.url)));

export default defineConfig({
  main: {
    // Both entries share import.meta-relative diagnostics; keep their shared
    // code beside build-identity.json, not in a nested chunks directory.
    build: { rollupOptions: { input: { index: fileURLToPath(new URL("./src/main/index.ts", import.meta.url)), "resident-entry": fileURLToPath(new URL("./src/main/resident-entry.ts", import.meta.url)) }, output: { chunkFileNames: "[name]-[hash].js" } } },
    define: { __SERIKA_BUILD__: JSON.stringify(build) },
    // Bundle the imported icon instead of leaving a runtime path outside out/.
    publicDir: "src/main/public",
    plugins: [externalizeDepsPlugin(), {
      name: "serika-build-identity",
      generateBundle() { this.emitFile({ type: "asset", fileName: "build-identity.json", source: JSON.stringify(build, null, 2) }); },
    }],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Electron sandboxed preload scripts must be CommonJS. The package is
        // ESM, so the preload output is named .cjs explicitly.
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    define: { __SERIKA_BUILD__: JSON.stringify(build) },
    plugins: [react(), tailwindcss()],
  },
});
