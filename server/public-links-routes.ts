import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { PublicLinksFile, PublicLinksInfo, VerifyResult } from "../shared/public-links";
import { PROXIED_HEADER } from "./mesh/proxy";
import { patchPublicLinks, pinnedByEnv, readPublicLinks, writeServerFields } from "./public-links";
import { frontGuide, verifyPublicUrl } from "./share/front";
import { noteVerify, shareState } from "./share/listener";
import { publicLinksChanged } from "./share/setting-events";

/**
 * Settings → Public links (§mesh.public/setting): GET and PUT /api/public-links and POST
 * /api/public-links/verify (shared/public-links.ts). Main listener only: a request from the peer
 * listener (`meshPeer`) or through a proxy (X-Forwarded-Host) gets the plain 404, like the mesh
 * links' local acts. Works with the mesh off.
 */

const notFound = (c: Context) => c.json({ error: "Not found" }, 404);
const local = (c: Context) => !(c.env as { meshPeer?: unknown } | undefined)?.meshPeer && !c.req.header(PROXIED_HEADER);
const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) });
const NO_STORE = { "Cache-Control": "no-store" };

export function publicLinksInfo(file: PublicLinksFile = readPublicLinks()): PublicLinksInfo {
  return {
    file,
    share: shareState(process.env, file),
    pinnedByEnv: pinnedByEnv(),
    ...(file.route === "self" && file.gateway ? { front: frontGuide(file.gateway) } : {}),
  };
}

export function mountPublicLinks(app: Hono): void {
  app.get("/api/public-links", (c) => (local(c) ? c.json(publicLinksInfo(), 200, NO_STORE) : notFound(c)));

  app.put("/api/public-links", small, async (c) => {
    if (!local(c)) return notFound(c);
    const body = await c.req.json().catch(() => undefined);
    const r = patchPublicLinks(body);
    if ("error" in r) return c.json({ error: r.error }, 400);
    publicLinksChanged(r.file);
    return c.json(publicLinksInfo(r.file), 200, NO_STORE);
  });

  // Checks the effective address as it is now; a pass is kept (verifiedAt), a failure reads as
  // unreachable until a later check passes.
  app.post("/api/public-links/verify", async (c) => {
    if (!local(c)) return notFound(c);
    const url = shareState().publicUrl;
    if (!url) return c.json({ ok: false, error: "No public address is set." } satisfies VerifyResult, 200, NO_STORE);
    const result = await verifyPublicUrl(url);
    noteVerify(url, result.ok);
    if (shareState().publicUrl === url) writeServerFields({ verifiedAt: result.ok ? Date.now() : null });
    return c.json(result satisfies VerifyResult, 200, NO_STORE);
  });
}
