// pi-web service worker: offline app shell + runtime cache for static files.
// Hand-rolled, no build step. Bump CACHE to drop every cached response on the next activate.
const CACHE = "pi-web-v1";

// Live data is never cached: REST under /api, WebSockets under /ws*.
const isPassthrough = (url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws");

self.addEventListener("install", (event) => {
  // Seed the shell and the hashed bundles it references: the first page load happens
  // before this worker controls the page, so runtime caching alone would miss them.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch("/", { cache: "no-cache" });
        if (!res.ok) return;
        const html = await res.clone().text();
        await cache.put("/", res);
        const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
        await cache.addAll(assets);
      } catch {
        // Offline during install: runtime caching fills in later.
      }
    })().then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("pi-web-") && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || isPassthrough(url)) return;

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(event, req));
  }
});

// The server answers unknown paths with index.html (SPA fallback); never store that
// under a script/style/image URL.
const cacheable = (req, res) =>
  res.ok && res.type === "basic" && (req.mode === "navigate" || !(res.headers.get("content-type") ?? "").startsWith("text/html"));

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (cacheable(req, res)) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(req, { ignoreSearch: true })) ?? (await cache.match("/"));
    if (hit) return hit;
    throw err;
  }
}

// /assets/* names are content-hashed, so a cached copy never goes stale.
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(req, res)) await cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req).then(async (res) => {
    if (cacheable(req, res)) await cache.put(req, res.clone());
    return res;
  });
  if (hit) {
    event.waitUntil(refresh.catch(() => {}));
    return hit;
  }
  return refresh;
}
