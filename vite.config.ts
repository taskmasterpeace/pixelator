import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite SPA. During dev, /api/* is proxied to the local Node proxy (server/index.mjs),
// which holds the Replicate token and talks to Retro Diffusion. Self-contained, internal.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5178,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
