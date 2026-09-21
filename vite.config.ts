import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// The API server's port. `npm run dev:server` defaults to 4800; a hermetic/experimental server
// runs elsewhere (PORT=4810 with PI_CODING_AGENT_DIR=<worktree>/.agent), so point the dev proxy
// at the same port with PI_WEB_PORT.
const apiPort = process.env.PI_WEB_PORT ?? "4800";

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
