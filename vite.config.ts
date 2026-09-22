import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The API server this dev server proxies to. `npm run dev:server` defaults to 4800; a second
// checkout (git worktree) or a hermetic/experimental server runs elsewhere (PORT=4810 with
// PI_CODING_AGENT_DIR=<worktree>/.agent), so point the dev proxy at the same port with
// SOVA_PORT: SOVA_PORT=4810 npm run dev:web -- --port 5176. The API server takes its port
// from PORT the same way (server/index.ts). PI_WEB_PORT/PI_WEB_HOST are the pre-rebrand aliases,
// still read as fallbacks.
const apiPort = process.env.SOVA_PORT ?? process.env.PI_WEB_PORT ?? "4800";
// 127.0.0.1, not "localhost": server/index.ts binds 127.0.0.1 by default, and on a host where
// "localhost" resolves to ::1 only (this one) every proxied /api and /ws call dies with
// ECONNREFUSED before it reaches the server.
const apiHost = process.env.SOVA_HOST ?? process.env.PI_WEB_HOST ?? "127.0.0.1";

export default defineConfig({
  plugins: [solid()],
  server: {
    proxy: {
      "/api": `http://${apiHost}:${apiPort}`,
      // Standalone /explain pages: served by the API server, linked and iframed from the app.
      "/explain": `http://${apiHost}:${apiPort}`,
      "/ws": { target: `ws://${apiHost}:${apiPort}`, ws: true },
    },
  },
});
