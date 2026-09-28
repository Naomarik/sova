// sova service worker: offline app shell + runtime cache for static files, and phone
// notifications (Web Push: server/push.ts sends, this shows).
// Hand-rolled, no build step. Bump CACHE to drop every cached response on the next activate.
// Only this app's own `sova-` caches are deleted; anything else on the origin is left alone.
// v3: v2 stored peers' /peer/ answers, so a browser that ran it holds stale peer data.
const CACHE = "sova-v3";

// Live data is never cached: REST under /api, WebSockets under /ws*, and everything a peer
// answers through this host (/peer/<id>/api, /peer/<id>/ws). Nor is anything an
// extension serves (/ext/: its UI, its API, its sockets) or the design CSS extensions link
// (/design/): the network and their own Cache-Control decide, so they are never served stale.
// The share pages (/h/, /i/) are served only by the share listener, on another origin.
const isPassthrough = (url) =>
  url.pathname.startsWith("/api/") ||
  url.pathname.startsWith("/ws") ||
  url.pathname.startsWith("/peer/") ||
  url.pathname.startsWith("/ext/") ||
  url.pathname.startsWith("/design/");

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
      await Promise.all(
        keys
          .filter((k) => k !== CACHE && k.startsWith("sova-"))
          .map((k) => caches.delete(k)),
      );
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

// ---- phone notifications ----------------------------------------------------------------------
// Every push shows a notification, whatever it carries: iOS revokes a subscription whose pushes
// show nothing, so all filtering happens on the server, never here.

const safeHash = (h) => (typeof h === "string" && h.startsWith("#/") ? h : "#/");

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Sova";
  const options = {
    body: typeof data.body === "string" ? data.body : "A session needs you.",
    tag: typeof data.tag === "string" && data.tag ? data.tag : "sova",
    badge: "/icons/badge-96.png",
    timestamp: typeof data.ts === "number" ? data.ts : Date.now(),
    data: { hash: safeHash(data.hash) },
  };
  const jobs = [self.registration.showNotification(title, options)];
  // The app badge: how many sessions need you now (absent on a test: left alone).
  if (typeof data.count === "number" && self.navigator.setAppBadge) {
    jobs.push((data.count > 0 ? self.navigator.setAppBadge(data.count) : self.navigator.clearAppBadge()).catch(() => {}));
  }
  event.waitUntil(Promise.all(jobs));
});

// A tap: focus an open Sova window and tell it where to go (src/sw-register.ts sets the hash, no
// reload); with none open, open one there.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const hash = safeHash(event.notification.data && event.notification.data.hash);
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
      if (win) {
        await win.focus().catch(() => {});
        win.postMessage({ type: "sova:open", hash });
        return;
      }
      await self.clients.openWindow("/" + hash);
    })(),
  );
});

// The browser renewed or dropped the subscription on its own (not every browser fires this; the
// app also re-syncs on each load): subscribe again with the same key and tell the server, which
// carries the old device's label over.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      let sub = event.newSubscription;
      if (!sub) {
        let key = old && old.options ? old.options.applicationServerKey : null;
        if (!key) {
          const res = await fetch("/api/push", { cache: "no-store" });
          if (!res.ok) return;
          key = (await res.json()).publicKey;
        }
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), resync: true, ...(old ? { replaces: old.endpoint } : {}) }),
      });
    })().catch(() => {}),
  );
});
