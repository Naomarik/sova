import type { Context, Hono } from "hono";
import { type GatewayInfo, type RegistryAck, REGISTRY_LINK_KINDS, SNAPSHOT_MAX_BYTES } from "../../shared/public-links";
import type { MeshApi } from "../mesh";
import { acceptsNode, type GatewayRegistry, gatewayPublicUrl, gatewaySetting, localShareHashes, RegistryUnavailable, shareRegistry } from "./registry";

/**
 * A gateway's peer routes (§mesh.public/registry), under /api/peer/share-gateway/* so only the
 * peer listener's verified caller reaches them: GET info[?kinds=1] -> GatewayInfo (`kinds` only
 * when asked), PUT links body
 * RegistrySnapshot -> RegistryAck (shared/public-links.ts). The caller is always
 * `mesh.requestPeer` (its StableID keys the rows), never anything in the body. A host that is no
 * gateway answers 404 `not-gateway` on both.
 */

/** The body, read up to `max` bytes: null when it is larger (declared or streamed), before any parse. */
async function boundedBody(c: Context, max: number): Promise<string | null> {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  const body = c.req.raw.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function mountShareGateway(app: Hono, mesh: MeshApi, registry: GatewayRegistry = shareRegistry): void {
  /** Whether a stored host may still route: in peers.json and accepted now. */
  const live = (nodeId: string): boolean => {
    const g = gatewaySetting();
    return !!g && acceptsNode(g, nodeId) && mesh.peers().some((p) => p.nodeId === nodeId);
  };

  app.get("/api/peer/share-gateway/info", (c) => {
    const peer = mesh.requestPeer(c);
    if (!peer) return c.json({ error: "Not found" }, 404);
    const g = gatewaySetting();
    const publicUrl = gatewayPublicUrl();
    if (!g || !publicUrl) return c.json({ error: "not-gateway" }, 404);
    const accepting = acceptsNode(g, peer.nodeId);
    const info: GatewayInfo = { publicUrl, accepting, seq: accepting ? registry.seqOf(peer.nodeId) : null };
    // Only when asked: an older routed host parses the info strictly and would refuse the key.
    if (c.req.query("kinds") === "1") info.kinds = [...REGISTRY_LINK_KINDS];
    return c.json(info);
  });

  app.put("/api/peer/share-gateway/links", async (c) => {
    const peer = mesh.requestPeer(c);
    if (!peer) return c.json({ error: "Not found" }, 404);
    const g = gatewaySetting();
    const publicUrl = gatewayPublicUrl();
    if (!g || !publicUrl) return c.json({ ok: false, error: "not-gateway" } satisfies RegistryAck, 404);
    if (!acceptsNode(g, peer.nodeId)) return c.json({ ok: false, error: "not-accepted" } satisfies RegistryAck, 403);
    const text = await boundedBody(c, SNAPSHOT_MAX_BYTES);
    if (text === null) return c.json({ ok: false, error: "bad-snapshot" } satisfies RegistryAck, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ ok: false, error: "bad-snapshot" } satisfies RegistryAck, 400);
    }
    // Judged again after the body arrived: the gateway may have been turned off, or the caller's
    // acceptance withdrawn, meanwhile (commit rechecks the caller with `live`).
    const nowUrl = gatewayPublicUrl();
    if (!gatewaySetting() || !nowUrl) return c.json({ ok: false, error: "not-gateway" } satisfies RegistryAck, 404);
    let ack: RegistryAck;
    try {
      ack = registry.commit(peer.nodeId, body, nowUrl, { now: Date.now(), local: localShareHashes(), live });
    } catch (err) {
      if (err instanceof RegistryUnavailable) return c.json({ error: "registry-unavailable" }, 503);
      throw err;
    }
    return c.json(ack, ack.ok ? 200 : ack.error === "not-accepted" ? 403 : 400);
  });
}
