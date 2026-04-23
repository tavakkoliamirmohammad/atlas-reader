import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// For the contributor dev loop (`pnpm dev`), the Vite server proxies /api to
// the Docker-published backend. Honor ATLAS_PORT so devs on custom ports
// don't have to edit this file.
const backendPort = process.env.ATLAS_PORT
  ? Number(process.env.ATLAS_PORT)
  : 8765;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${backendPort}`,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  worker: {
    format: "es",
  },
});
