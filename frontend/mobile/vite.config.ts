import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  base: "./",
  plugins: [react()],
  publicDir: resolve(__dirname, "public"),
  build: {
    outDir: resolve(__dirname, "../mobile-dist"),
    emptyOutDir: true,
  },
  server: {
    fs: { allow: [resolve(__dirname, "..")] },
  },
});
