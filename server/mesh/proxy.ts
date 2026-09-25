import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Context } from "hono";
import { proxy } from "hono/proxy";
import { proxySocket, refuse } from "../extensions";
import { REFUSED_HEADER } from "./hello";
import { type PeerEntry, peerUrl } from "./peers";

// /peer/<id>/api/* and /peer/<id>/ws/* on the main listener: the browser's way to a session that
// lives on another host. Transparent: the query goes verbatim, the answer comes back as the peer
// sent it (bytes, status, headers), WS frames and close codes pass untouched. Only this host's
// own failures are ours: 404 unknown peer, 502 peer down, 403 the peer's gate refused us.

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

const PEER_WS_RE = /^\/peer\/([^/]+)(\/ws\/(?:chat|watch))$/;

/** `/peer/<id>/ws/chat|watch` → [id, `/ws/...`], else null. */
export function peerSocketRoute(pathname: string): [string, string] | null {
  const m = PEER_WS_RE.exec(pathname);
  return m ? [m[1]!, m[2]!] : null;
}

function whyDown(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return e.cause?.code ?? e.cause?.message ?? e.message ?? String(err);
}

export async function proxyPeer(c: Context, peer: PeerEntry, tail: string): Promise<Response> {
  const incoming = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  const host = headers.get("host");
  headers.delete("host");
  for (const h of HOP_BY_HOP) headers.delete(h);
  if (host) headers.set("X-Forwarded-Host", host);
  let res: Response;
  try {
    res = await proxy(`${peerUrl(peer)}${tail}${incoming.search}`, { raw: c.req.raw, headers });
  } catch (err) {
    console.warn(`[mesh] ${peer.id}: ${c.req.method} ${tail} failed: ${whyDown(err)}`);
    return c.json({ error: "peer down", id: peer.id }, 502);
  }
  if (res.status === 403 && res.headers.get(REFUSED_HEADER) === "refused") {
    await res.body?.cancel();
    return c.json({ error: "peer refused", id: peer.id }, 403);
  }
  return res;
}

export function upgradePeerSocket(req: IncomingMessage, socket: Duplex, head: Buffer, peer: PeerEntry | null, tail: string, search: string): void {
  if (!peer) {
    refuse(socket, 404, { error: "Unknown peer" });
    return;
  }
  const headers: Record<string, string> = {};
  if (req.headers.host) headers["X-Forwarded-Host"] = req.headers.host;
  const url = `${peerUrl(peer).replace(/^http/, "ws")}${tail}${search}`;
  proxySocket(req, socket, head, url, headers, {
    onError: (err) => {
      console.warn(`[mesh] ${peer.id}: ws ${tail} failed: ${whyDown(err)}`);
      return [502, { error: "peer down", id: peer.id }];
    },
    onResponse: (res) =>
      res.statusCode === 403 && res.headers[REFUSED_HEADER.toLowerCase()] === "refused"
        ? [403, { error: "peer refused", id: peer.id }]
        : [502, { error: "peer down", id: peer.id }],
  });
}
