import { resolve } from "node:path";
import { defineConfig, type ProxyOptions } from "vite";
import solid from "vite-plugin-solid";

// The API server this dev server proxies to. `pnpm run dev:server` defaults to 4800; a second
// checkout (git worktree) or a hermetic/experimental server runs elsewhere (PORT=4810 with
// PI_CODING_AGENT_DIR=<worktree>/.agent), so point the dev proxy at the same port with
// SOVA_PORT: SOVA_PORT=4810 pnpm run dev:web --port 5176. The API server takes its port
// from PORT the same way (server/index.ts).
const apiPort = process.env.SOVA_PORT ?? "4800";
// 127.0.0.1, not "localhost": server/index.ts binds 127.0.0.1 by default, and on a host where
// "localhost" resolves to ::1 only (this one) every proxied /api and /ws call dies with
// ECONNREFUSED before it reaches the server.
const apiHost = process.env.SOVA_HOST ?? "127.0.0.1";

// `vite build --mode share`: the share page (§app.baton/share-listener), its own build from
// src/share/ into dist-share/, served ONLY by the share listener at /h/ (server/share/). It never
// sees the operator app's bundle, and the operator app's build never contains it.
const share = defineConfig({
  plugins: [solid()],
  root: resolve(import.meta.dirname, "src/share"),
  base: "/h/",
  publicDir: false,
  build: { outDir: resolve(import.meta.dirname, "dist-share"), emptyOutDir: true, assetsDir: "assets" },
});

// The API server admits only its own origins, so a request the dev page makes for itself reaches it
// as if the page were the server's own: `changeOrigin` sets Host, and an Origin naming this dev
// server (the page's own) is replaced by the upstream's — on plain requests and socket upgrades
// alike. Only that one origin: a page on another local port is same-site with this one and its
// requests carry the cookie, so its Origin goes through untouched and the server refuses it.
const upstream = `http://${apiHost}:${apiPort}`;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether `origin` is this dev server as the browser addressed it: same host:port as the request's
    Host (which a page on another origin can't set), and a loopback name. */
function isDevOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    const o = new URL(origin);
    return o.protocol === "http:" && o.host === host.toLowerCase() && LOOPBACK.has(o.hostname);
  } catch {
    return false;
  }
}

type OutgoingHeaders = { setHeader(name: string, value: string): unknown };
type Incoming = { headers: Record<string, string | string[] | undefined> };
const relabel = (proxyReq: OutgoingHeaders, req: Incoming) => {
  const { origin, host } = req.headers;
  if (typeof origin === "string" && typeof host === "string" && isDevOrigin(origin, host)) proxyReq.setHeader("origin", upstream);
};

const toApi = (ws = false): ProxyOptions => ({
  target: ws ? `ws://${apiHost}:${apiPort}` : upstream,
  ws,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on("proxyReq", relabel);
    proxy.on("proxyReqWs", relabel);
  },
});

const app = defineConfig({
  plugins: [solid()],
  server: {
    proxy: {
      "/api": toApi(),
      // Standalone /explain pages: served by the API server, linked and iframed from the app.
      "/explain": toApi(),
      "/ws": toApi(true),
      // Extensions (UI, API and sockets alike) and the design CSS they link: all the API server's.
      "/ext/": { ...toApi(), ws: true },
      "/design/": toApi(),
      // A peer's sessions, REST and sockets alike, forwarded by the API server to the host that holds them.
      "/peer/": { ...toApi(), ws: true },
    },
  },
});

export default defineConfig(({ mode }) => (mode === "share" ? share : app));
