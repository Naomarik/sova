/// <reference types="vite/client" />
import { resyncPush } from "./lib/push";

// Production builds only: a service worker under the Vite dev server would cache HMR modules.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      // Phone notifications: send this browser's subscription again on every load (lib/push.ts).
      .then(() => resyncPush())
      .catch((err) => console.warn("[sw] register failed:", err));
  });
  // A tapped notification in an open window (public/sw.js notificationclick): go where it points,
  // in place, without a reload.
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as { type?: unknown; hash?: unknown } | null;
    if (m?.type === "sova:open" && typeof m.hash === "string" && m.hash.startsWith("#/")) location.hash = m.hash;
  });
}
