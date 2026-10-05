import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Browser fixtures only. No Electron main process or user environment file. */
export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5187, strictPort: true, open: "/zcode-preview.html" },
});
