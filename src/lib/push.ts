// Phone notifications, this browser's side (§ server/push*.ts has the rest): whether this browser
// can take Web Push, its subscription (made with the server's public key, sent to the server, kept
// in sync on every load), and the app badge. The pure parts run under tsx --test.

import type { AttentionDigest, PushDevice } from "../../shared/protocol";
import { ApiError, deletePushSubscription, getPushInfo, postPushSubscription } from "./api";

// ---- pure ----------------------------------------------------------------------------------------

/** An iPhone or iPad, including an iPad that reports itself as a Mac (it has touch). */
export function isAppleMobile(ua: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

/** "iPhone · Safari", "Android · Chrome", "Linux · Firefox": the label a new device gets. */
export function deviceLabel(ua: string, maxTouchPoints = 0): string {
  const platform = /iPhone|iPod/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Windows/.test(ua)
          ? "Windows"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "Browser";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua)
      ? "Firefox"
      : /CriOS\/|Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return browser ? `${platform} · ${browser}` : platform;
}

/** How many sessions the digest says need you (act tier), once each: the app badge's number. */
export function actSessionCount(digest: Pick<AttentionDigest, "items"> | undefined): number {
  if (!digest) return 0;
  return new Set(digest.items.filter((i) => i.tier === "act").map((i) => i.id)).size;
}

/** The server's key as a browser takes it (`applicationServerKey`). */
export function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const sameBytes = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

/** The server's device id for an endpoint: the first 16 hex of its SHA-256 (server/push-store.ts deviceId). */
export async function deviceIdOf(endpoint: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

// ---- this browser --------------------------------------------------------------------------------

export type PushSupport = "ok" | "insecure" | "unsupported" | "ios-home-screen" | "no-worker";

/** This page is the installed (home-screen) app, not a browser tab. */
export const isInstalledApp = (): boolean =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true;

/** Whether this browser can subscribe, and if not, the one reason to say. */
export function pushSupport(): PushSupport {
  if (isAppleMobile(navigator.userAgent, navigator.maxTouchPoints ?? 0) && !isInstalledApp()) return "ios-home-screen";
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  // The service worker registers in production builds only (sw-register.ts).
  if (!import.meta.env.PROD) return "no-worker";
  return "ok";
}

export const notificationPermission = (): NotificationPermission | "unsupported" => ("Notification" in window ? Notification.permission : "unsupported");

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The service worker isn't running. Reload the page and try again.")), 10_000)),
  ]);
  return reg;
}

/** This browser's subscription right now, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ok") return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

const subscriptionJson = (sub: PushSubscription) => {
  const j = sub.toJSON();
  return { endpoint: j.endpoint ?? sub.endpoint, keys: { p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "" } };
};

const SUBSCRIBE_TIMEOUT_MS = 30_000;

/** Subscribe with the server's key (dropping a subscription made with another), and return it. */
async function subscribeWith(publicKey: string): Promise<PushSubscription> {
  const reg = await registration();
  const key = keyBytes(publicKey);
  const existing = await reg.pushManager.getSubscription();
  if (existing && sameBytes(existing.options.applicationServerKey, key)) return existing;
  if (existing) await existing.unsubscribe().catch(() => false);
  // A browser with no reachable push service can leave this pending for good: say so instead.
  return Promise.race([
    reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("This browser's push service didn't answer in 30 seconds. Nothing was turned on.")), SUBSCRIBE_TIMEOUT_MS),
    ),
  ]);
}


/** Enable on This Device: the permission prompt (from the user's tap), the subscription, the server. */
export async function enableThisDevice(): Promise<PushDevice> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error(permission === "denied" ? "Notifications are blocked for Sova in this browser's settings." : "Notifications weren't allowed. Nothing was turned on.");
  const info = await getPushInfo();
  const sub = await subscribeWith(info.publicKey);
  return postPushSubscription({ subscription: subscriptionJson(sub), label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0) });
}

/** Turn Off on This Device: the browser forgets the subscription, and the server removes the device. */
export async function disableThisDevice(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => false);
  await deletePushSubscription({ endpoint });
}

/**
 * On every app load: a browser that has allowed notifications and holds a subscription sends it
 * again (a push service may have renewed it), subscribing afresh when the server's key changed. A
 * device removed on purpose answers 410, and the browser then drops its subscription.
 */
export async function resyncPush(): Promise<void> {
  if (pushSupport() !== "ok" || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker.getRegistration();
  const existing = await reg?.pushManager.getSubscription();
  if (!existing) return;
  try {
    const info = await getPushInfo();
    const sub = sameBytes(existing.options.applicationServerKey, keyBytes(info.publicKey)) ? existing : await subscribeWith(info.publicKey);
    await postPushSubscription({ subscription: subscriptionJson(sub), resync: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 410) await existing.unsubscribe().catch(() => false);
  }
}

/** The app badge: the sessions that need you, where the browser has badges and notifications are allowed. Zero clears it. */
export function setAppBadge(count: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (!nav.setAppBadge || notificationPermission() !== "granted") return;
  void (count > 0 ? nav.setAppBadge(count) : (nav.clearAppBadge?.() ?? nav.setAppBadge(0))).catch(() => {});
}
