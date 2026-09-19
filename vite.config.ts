import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  server: {
    proxy: {
      "/api": "http://localhost:4800",
      "/ws": { target: "ws://localhost:4800", ws: true },
    },
  },
});
