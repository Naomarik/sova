/// <reference types="vite/client" />
// Production builds only: a service worker under the Vite dev server would cache HMR modules.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("[sw] register failed:", err));
  });
}
