import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    // Bundle the imported icon instead of leaving a runtime path outside out/.
    publicDir: "src/main/public",
    plugins: [externalizeDepsPlugin()],
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
    plugins: [react()],
  },
});
