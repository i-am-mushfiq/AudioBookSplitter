import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: desktopDirectory,
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(desktopDirectory, "../desktop-app-dist"),
    emptyOutDir: true,
  },
});
