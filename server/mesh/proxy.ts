import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
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

// Failing fast. A blackholed peer (host asleep, off the tailnet) never answers a SYN, and fetch
// would wait its full ~10 s connect timeout before our 502. So before a hop to a peer not reached
// in the last REACHED_MS, a bare TCP connect with CONNECT_TIMEOUT_MS decides; a peer that just
// failed one is 502 at once for DOWN_MS. There is no read timeout: a slow route or a long stream
// runs as long as the peer keeps it open. The extension proxy is untouched.
const CONNECT_TIMEOUT_MS = 3000;
const REACHED_MS = 15_000;
const DOWN_MS = 3000;
const WS_HANDSHAKE_MS = 5000;
const reach = new Map<string, { ok: boolean; at: number }>();

/** Record what a hop, probe or preflight just learnt about a peer URL. */
export function notePeerReach(url: string, ok: boolean): void {
  reach.set(url, { ok, at: Date.now() });
}

/** Tests: forget what is known. */
export const clearPeerReach = (): void => reach.clear();

function tcpReachable(url: string): Promise<boolean> {
  const u = new URL(url);
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Whether to try the hop at all: recent knowledge first, else a short TCP connect. */
async function preflight(url: string): Promise<boolean> {
  const known = reach.get(url);
  const age = known ? Date.now() - known.at : Infinity;
  if (known && !known.ok && age < DOWN_MS) return false;
  if (known?.ok && age < REACHED_MS) return true;
  const ok = await tcpReachable(url);
  notePeerReach(url, ok);
  return ok;
}

const PEER_WS_RE = /^\/peer\/([^/]+)(\/ws\/(?:chat|watch))$/;

/** `/peer/<id>/ws/chat|watch` → [id, `/ws/...`], else null. */
export function peerSocketRoute(pathname: string): [string, string] | null {
  const m = PEER_WS_RE.exec(pathname);
  return m ? [m[1]!, m[2]!] : null;
}

/**
 * The tail to forward when the browser may reach it through /peer/<id>/, else null. Never
 * /api/peer/* (the peer-only routes: the peer's gate would see THIS host, a legitimate peer, so a
 * browser could read or plant what peers exchange) nor /api/mesh/* (the peer listener refuses it
 * anyway), nor anything outside /api/. The tail is judged exactly as it is forwarded: dot segments
 * resolved the way fetch resolves them, then decoded, slash-collapsed and lower-cased, so no
 * spelling the peer's router would still match gets through. An encoded dot, slash or backslash
 * is refused outright (decoding it would change the segment structure), and so is a tail that
 * can't be decoded. peerFetch (server-side) is the only way to a peer's /api/peer/*.
 */
export function proxyTail(tail: string): string | null {
  if (!tail.startsWith("/") || tail.startsWith("//") || /%(?:2e|2f|5c)/i.test(tail)) return null;
  let resolved: string;
  let path: string;
  try {
    resolved = new URL(tail, "http://x").pathname;
    path = decodeURIComponent(resolved);
  } catch {
    return null;
  }
  path = path.replace(/[\\/]+/g, "/").toLowerCase();
  return path.startsWith("/api/") && !/^\/api\/(?:peer|mesh)(?:\/|$)/.test(path) ? resolved : null;
}

/** Every proxied request and socket carries this, so the peer can tell it from a peerFetch. */
export const PROXIED_HEADER = "X-Forwarded-Host";

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
  headers.set(PROXIED_HEADER, host || "unknown");
  const base = peerUrl(peer);
  if (!(await preflight(base))) return c.json({ error: "peer down", id: peer.id }, 502);
  let res: Response;
  try {
    res = await proxy(`${base}${tail}${incoming.search}`, { raw: c.req.raw, headers });
  } catch (err) {
    notePeerReach(base, false);
    console.warn(`[mesh] ${peer.id}: ${c.req.method} ${tail} failed: ${whyDown(err)}`);
    return c.json({ error: "peer down", id: peer.id }, 502);
  }
  notePeerReach(base, true);
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
  socket.on("error", () => {}); // a reset while we decide; proxySocket takes over from there
  const headers: Record<string, string> = { [PROXIED_HEADER]: req.headers.host || "unknown" };
  const base = peerUrl(peer);
  void preflight(base).then((ok) => {
    if (socket.destroyed) return; // the browser gave up first
    if (!ok) {
      refuse(socket, 502, { error: "peer down", id: peer.id });
      return;
    }
    proxySocket(req, socket, head, `${base.replace(/^http/, "ws")}${tail}${search}`, headers, {
      handshakeTimeout: WS_HANDSHAKE_MS,
      onError: (err) => {
        notePeerReach(base, false);
        console.warn(`[mesh] ${peer.id}: ws ${tail} failed: ${whyDown(err)}`);
        return [502, { error: "peer down", id: peer.id }];
      },
      onResponse: (res) =>
        res.statusCode === 403 && res.headers[REFUSED_HEADER.toLowerCase()] === "refused"
          ? [403, { error: "peer refused", id: peer.id }]
          : [502, { error: "peer down", id: peer.id }],
    });
  });
}
