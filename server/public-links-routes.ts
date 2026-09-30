import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AdvertisedGateway, PublicLinksFile, PublicLinksInfo, RoutedHost, VerifyResult } from "../shared/public-links";
import { advertisedGateways } from "./mesh/hello";
import { localRequest } from "./mesh/proxy";
import { patchPublicLinks, pinnedByEnv, readPublicLinks, writeServerFields } from "./public-links";
import { frontGuide, verifyPreviewUrl, verifyPublicUrl } from "./share/front";
import { previewAddress } from "./share/preview-address";
import { refreshGateway } from "./share/gateway-client";
import { noteVerify, shareListenerSettled, shareState } from "./share/listener";
import { routedHosts } from "./share/registry";
import { publicLinksChanged } from "./share/setting-events";

/**
 * Settings → Public links (§mesh.public/setting): GET and PUT /api/public-links and POST
 * /api/public-links/verify (shared/public-links.ts). Main listener only: a request from the peer
 * listener (`meshPeer`) or relayed by a peer's proxy (X-Sova-Relayed) gets the plain 404, like the mesh
 * links' local acts. Works with the mesh off.
 */

const notFound = (c: Context) => c.json({ error: "Not found" }, 404);
const local = localRequest;
const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) });
const NO_STORE = { "Cache-Control": "no-store" };
/** How long a PUT that routes this host through a gateway waits for that gateway's first answer
    (§mesh.public/via-answer), so the reply shows its address rather than `off`. */
export const VIA_ANSWER_WAIT_MS = 3000;

/** Where GET and PUT learn the gateway's routed hosts (server/share/registry.ts) and the peers
    advertising a gateway (server/mesh/hello.ts); tests pass their own. */
export interface PublicLinksSources {
  routed: () => Promise<RoutedHost[] | null>;
  gateways: () => Promise<AdvertisedGateway[]>;
}
const SOURCES: PublicLinksSources = { routed: () => routedHosts(), gateways: () => advertisedGateways() };

/** The answer of GET and PUT: `routed` only while this host is the gateway (route "self"),
    `gateways` always (none while the mesh is off). */
export async function publicLinksInfo(file: PublicLinksFile = readPublicLinks(), sources: PublicLinksSources = SOURCES): Promise<PublicLinksInfo> {
  const self = file.route === "self" && !!file.gateway;
  const [routed, gateways] = await Promise.all([self ? sources.routed().catch(() => null) : null, sources.gateways().catch(() => [])]);
  return {
    file,
    share: shareState(process.env, file),
    pinnedByEnv: pinnedByEnv(),
    preview: previewAddress(process.env, file),
    ...(self && file.gateway ? { front: frontGuide(file.gateway) } : {}),
    ...(self && routed ? { routed } : {}),
    gateways,
  };
}

export function mountPublicLinks(app: Hono, sources: PublicLinksSources = SOURCES): void {
  app.get("/api/public-links", async (c) => (local(c) ? c.json(await publicLinksInfo(readPublicLinks(), sources), 200, NO_STORE) : notFound(c)));

  app.put("/api/public-links", small, async (c) => {
    if (!local(c)) return notFound(c);
    const body = await c.req.json().catch(() => undefined);
    const r = patchPublicLinks(body);
    if ("error" in r) return c.json({ error: r.error }, 400);
    publicLinksChanged(r.file);
    // The answer carries the bind as it came out (§mesh.public/listener-failure).
    await shareListenerSettled();
    if (typeof r.file.route === "object") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([refreshGateway().catch(() => null), new Promise((res) => (timer = setTimeout(res, VIA_ANSWER_WAIT_MS)))]);
      clearTimeout(timer);
    }
    return c.json(await publicLinksInfo(r.file, sources), 200, NO_STORE);
  });

  // Checks the effective address as it is now; a pass is kept (verifiedAt), a failure reads as
  // unreachable until a later check passes.
  app.post("/api/public-links/verify", async (c) => {
    if (!local(c)) return notFound(c);
    const url = shareState().publicUrl;
    if (!url) return c.json({ ok: false, error: "No public address is set." } satisfies VerifyResult, 200, NO_STORE);
    const result: VerifyResult = await verifyPublicUrl(url);
    // A gateway with a preview address checks a random preview host too (§mesh.public/preview-address).
    const preview = previewAddress();
    if (readPublicLinks().route === "self" && preview.url?.startsWith("https://")) result.preview = await verifyPreviewUrl(preview.url);
    noteVerify(url, result.ok);
    if (shareState().publicUrl === url) writeServerFields({ verifiedAt: result.ok ? Date.now() : null });
    return c.json(result satisfies VerifyResult, 200, NO_STORE);
  });
}
