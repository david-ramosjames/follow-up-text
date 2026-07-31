import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development Vite serves the UI on 4173 and proxies everything the server
// owns, so the browser sees one origin and session cookies work normally.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/auth": "http://127.0.0.1:3000",
      "/slack": "http://127.0.0.1:3000",
      "/webhooks": "http://127.0.0.1:3000",
      "/healthz": "http://127.0.0.1:3000",
    },
  },
  build: { outDir: "dist" },
});
