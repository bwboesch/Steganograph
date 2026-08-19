import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Fully-offline PWA: Workbox precaches every build asset so the app runs with
// no network. We ship no web fonts or external assets by design — otherwise the
// offline promise would be a lie.
export default defineConfig({
  base: "./",
  // Dev server: bind all interfaces over HTTPS. HTTPS is required so that
  // crypto.subtle (Web Crypto) is available in a secure context when the app is
  // reached over the LAN by IP — plain http://<ip> is NOT a secure context.
  // basic-ssl mints a self-signed cert (browsers will warn once → "proceed").
  server: {
    host: true, // 0.0.0.0 — reachable from other devices on the network
    port: 5178,
  },
  preview: {
    host: true,
    port: 5178,
  },
  plugins: [
    basicSsl(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-192.png", "icon-512.png"],
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
      },
      manifest: {
        id: "./",
        name: "Steganograph",
        short_name: "Stego",
        description: "Hide encrypted messages inside images. Works fully offline.",
        theme_color: "#0b0e14",
        background_color: "#0b0e14",
        display: "standalone",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
});
