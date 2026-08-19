import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Portable build: inline ALL JS + CSS into one self-contained HTML file that
// the receiver can just open — no server, no install, works offline. No PWA /
// service worker here; a single file is already offline by nature.
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
  build: {
    outDir: "share",
    emptyOutDir: true,
    rollupOptions: {
      input: "share.html",
    },
  },
});
