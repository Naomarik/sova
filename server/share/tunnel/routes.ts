import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { REGISTRY_LIMITS } from "../../../shared/public-links";
import { localRequest } from "../../mesh/proxy";
import { yourClickRefusal } from "../../page-only";
import { quickTunnelEnabled, readPublicLinks, readTunnelConsent, recordTunnelConsent } from "../../public-links";
import { liveLinks } from "../registry-push";
import { noteHandouts, tokenHash } from "./handouts";
import { ensureTunnel } from "./manager";

/**
 * The operator's tunnel routes under /api/public-links/ (§mesh/tunnel), main listener only (a
 * peer's or a relayed request gets the plain 404, as the rest of the area):
 *
 * POST /api/public-links/turn-on        the one-time Turn On (§mesh.tunnel/turn-on): your click only;
 *                                       records consentAt, then starts the share tunnel when a live
 *                                       link waits for it. -> PublicLinksInfo
 * POST /api/public-links/handed-out     {links: [{url} | {kind, id}]} (≤ 200): a Copy Link click under
 *                                       Free; `id` is the link's token hash. -> {ok: true, noted}
 * POST /api/public-links/tunnel/start   Try Again on a share tunnel that failed or stopped (after Turn
 *                                       On). -> PublicLinksInfo
 */

const notFound = (c: Context) => c.json({ error: "Not found" }, 404);
const small = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) });
const NO_STORE = { "Cache-Control": "no-store" };
export const HANDED_OUT_MAX = 200;

/** A link's token from its full URL: `/h|i|s|t/<43 base64url>` (the share kinds). */
const LINK_PATH = /\/(h|i|s|t)\/([A-Za-z0-9_-]{43})(?:[/?#]|$)/;

/** The token hashes a handed-out body names; null when it isn't one. Pure. */
export function handedOutHashes(body: unknown): string[] | null {
  const links = (body as { links?: unknown } | null)?.links;
  if (!Array.isArray(links) || links.length > HANDED_OUT_MAX) return null;
  const out: string[] = [];
  for (const l of links) {
    if (!l || typeof l !== "object") return null;
    const { url, id } = l as { url?: unknown; id?: unknown };
    if (typeof url === "string") {
      let path = "";
      try {
        path = new URL(url).pathname;
      } catch {
        return null;
      }
      const m = LINK_PATH.exec(path);
      if (!m) return null;
      out.push(tokenHash(m[2] as string));
    } else if (typeof id === "string" && REGISTRY_LIMITS.hash.test(id)) out.push(id);
    else return null;
  }
  return out;
}

/** Record hand-outs under Free only (an address can change only there), of live links only. */
function noteLive(hashes: string[]): number {
  if (readPublicLinks().route !== "quick" || !hashes.length) return 0;
  const live = new Set(liveLinks(Date.now()).map((l) => l.h));
  const noted = hashes.filter((h) => live.has(h));
  noteHandouts(noted, Date.now(), live);
  return noted.length;
}

/** A link that just left Sova in a send (outreach): recorded as handed out. Never throws. */
export function noteSentLink(url: string): void {
  try {
    const hashes = handedOutHashes({ links: [{ url }] });
    if (hashes) noteLive(hashes);
  } catch {
    // the notice is a convenience: a send never fails for it
  }
}

export interface TunnelRoutesDeps {
  /** GET /api/public-links's answer, as it is now. */
  info: () => Promise<unknown>;
  /** Whether the share tunnel is wanted now (wiring's shareWanted). */
  wanted: () => boolean;
}

export function mountTunnelRoutes(app: Hono, deps: TunnelRoutesDeps): void {
  app.post("/api/public-links/turn-on", async (c) => {
    if (!localRequest(c)) return notFound(c);
    // Never agent-triggered (§mesh.tunnel/turn-on): only the person's own click in the page.
    const refused = yourClickRefusal(c, "turnOn");
    if (refused) return refused;
    if (!quickTunnelEnabled()) return c.json({ error: "Cloudflare Free is turned off on this computer (SOVA_QUICK_TUNNEL=off)." }, 409, NO_STORE);
    recordTunnelConsent();
    if (readPublicLinks().route === "quick" && deps.wanted()) await ensureTunnel({ kind: "share" }, { by: "operator" }).catch(() => null);
    return c.json(await deps.info(), 200, NO_STORE);
  });

  app.post("/api/public-links/handed-out", small, async (c) => {
    if (!localRequest(c)) return notFound(c);
    const hashes = handedOutHashes(await c.req.json().catch(() => undefined));
    if (!hashes) return c.json({ error: `Expected { links: [{ url }] }, at most ${HANDED_OUT_MAX}.` }, 400, NO_STORE);
    // Only Free's address can change under a sent link (§mesh.public/broken-links).
    return c.json({ ok: true, noted: noteLive(hashes) }, 200, NO_STORE);
  });

  app.post("/api/public-links/tunnel/start", async (c) => {
    if (!localRequest(c)) return notFound(c);
    // The page's Try Again: a chat never starts a tunnel by itself.
    const refused = yourClickRefusal(c, "turnOn");
    if (refused) return refused;
    const route = readPublicLinks().route;
    if (route !== "quick" && route !== "account") return c.json({ error: "No Cloudflare tunnel is chosen." }, 409, NO_STORE);
    if (route === "quick" && readTunnelConsent() === null) return c.json({ error: "Turn on public links first." }, 409, NO_STORE);
    // Only a tunnel something waits for: with nothing shared under Free, nothing starts (nothing runs at idle).
    if (deps.wanted()) await ensureTunnel({ kind: "share" }, { by: "operator" }).catch(() => null);
    return c.json(await deps.info(), 200, NO_STORE);
  });
}
