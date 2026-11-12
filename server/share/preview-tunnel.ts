import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { PREVIEW_LABEL_RE, PREVIEW_LIMITS } from "../../shared/public-links";
import { findPreview, previewState, type PreviewRecord } from "../preview-links";
import { previewAnswer, previewUpgradeAnswer } from "./preview-pages";
import { createPreviewProxy, KEY_COOKIE, type PreviewProxy } from "./preview-proxy";
import { RateLimiter } from "./rate-limit";
import { previewTunnelHosts, tunnelStatus } from "./tunnel/manager";

/**
 * A Free preview tunnel's host on the share listener (§mesh.public/preview-tunnels). Each previewed app
 * (its port) has its own quick tunnel whose address (words under trycloudflare.com) is no secret, so the
 * preview's label rides in the link instead: `https://<tunnel host>/_sova/open/<label>[/<path>]` passes
 * only for an active preview of this tunnel's port, sets `__Host-sova-pk=<label>` and redirects to
 * `/<path>`; every other request on that host needs that cookie, judged against the record each time.
 * `/_sova/` never reaches the app. Wrong or missing keys count per client address (20 a minute, then 429).
 *
 * A request is one of these only when its Host is exactly a running preview tunnel's host (lowercase,
 * an optional `:443`), checked by the share edge before anything else (§mesh.public/preview-address).
 */

export const OPEN_PREFIX = "/_sova/open/";
/** Wrong or missing keys a client address may send a minute on preview tunnel hosts. */
export const KEY_MISSES_PER_MINUTE = 20;
const OPEN_RE = /^\/_sova\/open\/([a-z2-7]{52})(\/[^?#]*)?$/;

/** What the share edge calls on a request whose Host is a preview tunnel's. */
export interface PreviewTunnelHooks {
  /** The app port whose preview tunnel the request's Host names exactly, or null (not a preview tunnel's). */
  match: (req: IncomingMessage) => number | null;
  dispatch: (req: IncomingMessage, res: ServerResponse, port: number, client: string) => void;
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer, port: number, client: string) => void;
  dispose: () => void;
}

export interface PreviewTunnelDeps {
  /** Every running preview tunnel's host (lowercase, no port) -> its app port. Memory only. */
  hosts?: () => ReadonlyMap<string, number>;
  /** A preview tunnel's current origin (`https://<host>`), or null. */
  originOf?: (port: number) => string | null;
  find?: (label: string) => PreviewRecord | null;
  proxy?: PreviewProxy;
  now?: () => number;
}

/** A Host header as the table keys it: trimmed, lowercase, an optional `:443` dropped. Anything else stays as is (and so never matches). */
export function tunnelHostOf(host: string | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase();
  return h.endsWith(":443") ? h.slice(0, -4) : h;
}

/** The key cookie's value when it has a label's shape (the last one, as a browser sends its newest last when paths tie). */
export function keyCookie(cookie: string | undefined): string | null {
  let found: string | null = null;
  for (const part of (cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === KEY_COOKIE) {
      const v = part.slice(i + 1).trim();
      found = PREVIEW_LABEL_RE.test(v) ? v : null;
    }
  }
  return found;
}

/** Where the open hop sends the visitor: `/<path>` with its query, never another host (`//…`, `/\…`). Pure. */
export function openRedirect(rest: string | undefined, query: string): string {
  const path = rest && rest.length > 1 && rest[1] !== "/" && rest[1] !== "\\" ? rest : "/";
  return query ? `${path}?${query}` : path;
}

export function createPreviewTunnelHooks(deps: PreviewTunnelDeps = {}): PreviewTunnelHooks {
  const hosts = deps.hosts ?? previewTunnelHosts;
  const originOf = deps.originOf ?? ((port: number) => tunnelStatus({ kind: "preview", port }).origin);
  const find = deps.find ?? findPreview;
  const now = deps.now ?? Date.now;
  const proxy =
    deps.proxy ??
    createPreviewProxy({
      find,
      // The visitor's origin is the preview's tunnel's current address.
      origin: (label) => {
        const r = find(label);
        return r ? originOf(r.port) : null;
      },
    });
  const misses = new RateLimiter(KEY_MISSES_PER_MINUTE);
  const perPreview = new RateLimiter(PREVIEW_LIMITS.requestsPerMinute);

  /** The record a label names when it is an active preview of this tunnel's port; null otherwise. */
  const activeOf = (label: string | null, port: number): PreviewRecord | null => {
    if (!label) return null;
    const r = find(label);
    return r && r.port === port && previewState(r, now()) === "active" ? r : null;
  };
  /** A wrong or missing key: the unknown-preview 404, or 429 past the client's limit. */
  const missed = (client: string): "unknown" | "tooMany" => (misses.limited(client) ? "tooMany" : "unknown");

  const dispatch = (req: IncomingMessage, res: ServerResponse, port: number, client: string): void => {
    const target = req.url ?? "";
    if (target[0] !== "/" || target[1] === "/") return previewAnswer(req, res, "unknown");
    const q = target.indexOf("?");
    const path = q < 0 ? target : target.slice(0, q);
    const query = q < 0 ? "" : target.slice(q + 1);
    if (path === "/_sova" || path.startsWith("/_sova/")) {
      // Sova's own paths on a preview host: only the open hop exists, and nothing here reaches the app.
      const m = OPEN_RE.exec(path);
      const method = req.method ?? "GET";
      if (!m || (method !== "GET" && method !== "HEAD")) return previewAnswer(req, res, "unknown");
      const record = activeOf(m[1]!, port);
      if (!record) return previewAnswer(req, res, missed(client));
      const maxAge = Math.max(1, Math.ceil((Date.parse(record.expiresAt) - now()) / 1000));
      res.writeHead(302, {
        Location: openRedirect(m[2], query),
        "Set-Cookie": `${KEY_COOKIE}=${m[1]}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Length": "0",
      });
      res.end();
      return;
    }
    const label = keyCookie(req.headers.cookie);
    if (!activeOf(label, port)) return previewAnswer(req, res, missed(client));
    if (perPreview.limited(`${client} ${label}`)) return previewAnswer(req, res, "tooMany");
    proxy.dispatch(req, res, label!, client);
  };

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, port: number, client: string): void => {
    const target = req.url ?? "";
    if (target[0] !== "/" || target[1] === "/" || target.startsWith("/_sova/") || target === "/_sova" || target.startsWith("/_sova?")) return previewUpgradeAnswer(socket, "unknown");
    const label = keyCookie(req.headers.cookie);
    if (!activeOf(label, port)) return previewUpgradeAnswer(socket, missed(client));
    if (perPreview.limited(`${client} ${label}`)) return previewUpgradeAnswer(socket, "tooMany");
    proxy.upgrade(req, socket, head, label!, client);
  };

  return {
    match: (req) => {
      const map = hosts();
      if (!map.size) return null;
      const h = tunnelHostOf(req.headers.host);
      return h ? map.get(h) ?? null : null;
    },
    dispatch,
    upgrade,
    dispose: () => {
      if (!deps.proxy) proxy.dispose();
    },
  };
}

/** The share listener's hooks for preview tunnel hosts (listener.ts passes them to createShareServer). */
export function previewTunnelHooks(): PreviewTunnelHooks {
  return createPreviewTunnelHooks();
}
