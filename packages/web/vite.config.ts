import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backend = `http://127.0.0.1:${process.env.PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  // The TypeScript worker's imports (src/ts-worker/worker.ts) aren't reached by the dependency
  // scan; discovering them at runtime would re-optimise and reload the page on a cold cache.
  optimizeDeps: {
    include: ["monaco-editor/internal/common/initialize", "monaco-editor/languages/features/typescript/tsWorker", "monaco-editor/languages/features/typescript/lib/typescriptServices"],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": backend,
      "/ws": { target: backend.replace("http", "ws"), ws: true },
    },
    fs: { allow: [".."] },
  },
});
