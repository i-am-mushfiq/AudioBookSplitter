import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: resolve(mobileDirectory),
  base: "./",
  plugins: [react()],
  publicDir: resolve(mobileDirectory, "public"),
  build: {
    outDir: resolve(mobileDirectory, "../mobile-dist"),
    emptyOutDir: true,
  },
  server: {
    fs: { allow: [resolve(mobileDirectory, "..")] },
  },
});
