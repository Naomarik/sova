import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The API server this dev server proxies to. A second checkout (git worktree) runs its own API
// server on another port: PI_API_PORT=4801 npm run dev:web -- --port 5174. The API server takes
// its port from PORT the same way (server/index.ts).
const apiPort = process.env.PI_API_PORT ?? "4800";

export default defineConfig({
  plugins: [solid()],
  server: {
    proxy: {
      "/api": `http://localhost:${apiPort}`,
      // Standalone /explain pages: served by the API server, linked and iframed from the app.
      "/explain": `http://localhost:${apiPort}`,
      "/ws": { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
});
