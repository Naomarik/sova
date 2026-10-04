import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { Context } from "hono";
import { proxy } from "hono/proxy";
import { proxySocket, refuse } from "../extensions";
import { streamWebSocket } from "../runtime-quirks";
import { fetchPeerRequest, lanClient } from "./dial";
import { LAN_HOST } from "./lan-fetch";
import { DENIED } from "../../shared/mesh-access";
import { REFUSED_HEADER } from "./hello";
import { isMeshOrPeerApi, judgedPath } from "./paths";
import { type PeerEntry, peerUrl } from "./peers";

// /peer/<id>/api/* and /peer/<id>/ws/* on the main listener: the browser's way to a session that
// lives on another host. Transparent: the query goes verbatim, the answer comes back as the peer
// sent it (bytes, status, headers), WS frames and close codes pass untouched. Only this host's
// own failures are ours: 404 unknown peer, 502 peer down, 504 peer took the connection but sent
// no response headers in time, 403 the peer's gate refused us.

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
/** The Overseer's in-process sender secret (server/overseer-sender.ts OVERSEER_SENDER_HEADER): never
    forwarded, so a peer can't replay it against this host (§mesh.links/delivery). */
const OVERSEER_HEADER = "x-sova-overseer";
/** This host's own credentials (server/auth.ts): never forwarded, so no peer host ever sees the
    token, in a log or otherwise; the peer answers by this host's Tailscale identity. */
const CREDENTIAL_HEADERS = ["cookie", "authorization", "x-sova-token"];
/** What a relayed request would tell a peer this host restricts (§mesh.peers/grants) about this host
    or the browser: dropped, and X-Forwarded-Host carries SCRUBBED_HOST instead of this host's name. */
const IDENTITY_HEADERS = ["origin", "referer", "user-agent", "accept-language", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-port", "x-real-ip", "forwarded", "via"];
export const SCRUBBED_HOST = "peer";

// Failing fast. A blackholed peer (host asleep, off the tailnet, a killed container) never
// answers a SYN, and fetch would wait its full ~10 s connect timeout before our 502 (a kept-alive
// socket to it, longer). So before a hop to a peer not reached in the last REACHED_MS, a bare TCP
// connect with CONNECT_TIMEOUT_MS decides; a peer that just failed one is 502 at once for DOWN_MS.
// A hop to a recently reached peer starts at once, and if it has no answer after STALL_MS the
// same TCP check runs beside it and aborts it when the peer is gone (≈ STALL_MS + 3 s worst case).
// A peer that accepts the connection but never answers (a wedged process) passes both checks, so
// a REST hop gets HEADERS_TIMEOUT_MS overall for its response headers (504 "peer timeout") and a
// WS hop WS_HANDSHAKE_MS for its handshake (502). Once the peer has answered (response headers, or
// the socket is open) nothing times out: a slow body or a long stream runs as long as the peer
// keeps it open. The extension proxy is untouched.
const CONNECT_TIMEOUT_MS = 3000;
const REACHED_MS = 15_000;
const DOWN_MS = 3000;
const WS_HANDSHAKE_MS = 5000;
const STALL_MS = 500;
let headersTimeoutMs = 30_000;
const reach = new Map<string, { ok: boolean; at: number }>();

/** Record what a hop, probe or preflight just learnt about a peer URL. */
export function notePeerReach(url: string, ok: boolean): void {
  reach.set(url, { ok, at: Date.now() });
}

/** Tests: shorten the wait for a REST hop's response headers. */
export function setPeerHeadersTimeout(ms: number): void {
  headersTimeoutMs = ms;
}

/** Tests: forget what is known. */
export const clearPeerReach = (): void => reach.clear();

export function tcpReachable(url: string): Promise<boolean> {
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

/** Whether to try the hop at all: recent knowledge first, else a short TCP connect. "recent"
    means the hop goes ahead without a check, so it needs a stall watch (watchStall). */
export async function preflight(url: string): Promise<boolean | "recent"> {
  const known = reach.get(url);
  const age = known ? Date.now() - known.at : Infinity;
  if (known && !known.ok && age < DOWN_MS) return false;
  if (known?.ok && age < REACHED_MS) return "recent";
  const ok = await tcpReachable(url);
  notePeerReach(url, ok);
  return ok;
}

/**
 * For a hop that went ahead on recent knowledge: after STALL_MS without an answer, check the peer
 * with a bare TCP connect and call `abort` if it is gone. Returns the function that says "it
 * answered" (cancels the watch).
 */
export function watchStall(url: string, abort: () => void): () => void {
  let answered = false;
  const timer = setTimeout(() => {
    void tcpReachable(url).then((ok) => {
      if (ok || answered) return;
      notePeerReach(url, false);
      abort();
    });
  }, STALL_MS);
  return () => {
    answered = true;
    clearTimeout(timer);
  };
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
  if (!tail.startsWith("/") || tail.startsWith("//")) return null;
  let resolved: string;
  try {
    resolved = new URL(tail, "http://x").pathname;
  } catch {
    return null;
  }
  const path = judgedPath(resolved);
  return path && path.startsWith("/api/") && !isMeshOrPeerApi(path) ? resolved : null;
}

/** Every proxied request and socket carries this, so the peer can tell it from a peerFetch. */
export const PROXIED_HEADER = "X-Forwarded-Host";

/**
 * Also on every proxied request and socket, and set by nothing else: a generic reverse proxy in
 * front of the main listener (tailscale serve, Caddy, nginx) sets X-Forwarded-Host too, so only
 * this one tells a relay from the operator's own browser. A browser that sends it only refuses
 * itself; it can't take it off a relay.
 */
export const RELAYED_HEADER = "X-Sova-Relayed";

/** This host's own browser: not on the peer listener (`meshPeer`) and not relayed by a peer's
    /peer/<id>/ proxy. The operator's local routes answer anything else with their 404. */
export const localRequest = (c: Context): boolean => !(c.env as { meshPeer?: unknown } | undefined)?.meshPeer && !c.req.header(RELAYED_HEADER);

function whyDown(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return e.cause?.code ?? e.cause?.message ?? e.message ?? String(err);
}

// A dial-out pairing's answers (§mesh.lan/as-a-peer) reach this host's browser origin from a machine
// that may roam onto any network, so they are cut down to what a page needs: only the headers below,
// never a redirect, cache wipe, service worker scope, CORS grant or preload; a sandbox CSP and
// nosniff on everything; and a type a browser would run or render as a document (HTML, SVG, XML,
// script) only ever as a download.
const PAIRING_HEADERS = new Set(["content-type", "content-length", "content-disposition", "content-encoding", "cache-control", "etag", "last-modified", "date", "vary", REFUSED_HEADER.toLowerCase()]);
const ACTIVE_TYPE = /html|svg|xml|javascript|ecmascript/i;

/** The answer of a dial-out pairing, as the browser may see it. */
export function hardenPairingResponse(res: Response): Response {
  const headers = new Headers();
  res.headers.forEach((v, k) => {
    if (PAIRING_HEADERS.has(k.toLowerCase())) headers.append(k, v);
  });
  const type = headers.get("content-type") ?? "";
  if (ACTIVE_TYPE.test(type)) {
    headers.set("content-type", "application/octet-stream");
    headers.set("content-disposition", "attachment");
  }
  headers.set("content-security-policy", "sandbox; default-src 'none'");
  headers.set("x-content-type-options", "nosniff");
  // 3xx included: a redirect's Location is gone, so it can't send the browser anywhere.
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** A hop to a dial-out pairing: over its connection, failing at once while it has none. */
async function proxyPairing(c: Context, peer: PeerEntry, tail: string, headers: Headers): Promise<Response> {
  const incoming = new URL(c.req.url);
  // As for a tailnet hop: the deadline covers the response headers, never the body.
  const late = new AbortController();
  const deadline = setTimeout(() => late.abort(), headersTimeoutMs);
  let res: Response;
  try {
    res = await proxy(`http://${LAN_HOST}${tail}${incoming.search}`, {
      raw: c.req.raw,
      headers,
      customFetch: (req: Request) => fetchPeerRequest(peer, req),
      signal: AbortSignal.any([c.req.raw.signal, late.signal]),
    });
  } catch (err) {
    clearTimeout(deadline);
    if (late.signal.aborted) return c.json({ error: "peer timeout", id: peer.id }, 504);
    console.warn(`[mesh] ${peer.id}: ${c.req.method} ${tail} failed: ${whyDown(err)}`);
    return c.json({ error: "peer down", id: peer.id }, 502);
  }
  clearTimeout(deadline);
  if (res.status === 403 && res.headers.get(REFUSED_HEADER) === "refused") {
    await res.body?.cancel();
    return c.json({ error: "peer refused", id: peer.id }, 403);
  }
  return hardenPairingResponse(res);
}

/** `scrub`: this host restricts the peer (§mesh.peers/grants), so the request carries nothing of
    this host's name or the browser beyond what the route needs. */
export async function proxyPeer(c: Context, peer: PeerEntry, tail: string, scrub = false): Promise<Response> {
  const incoming = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  const host = headers.get("host");
  headers.delete("host");
  for (const h of HOP_BY_HOP) headers.delete(h);
  headers.delete(OVERSEER_HEADER);
  for (const h of CREDENTIAL_HEADERS) headers.delete(h);
  if (scrub) {
    for (const h of IDENTITY_HEADERS) headers.delete(h);
    headers.set("user-agent", SCRUBBED_HOST); // else the runtime's fetch names itself
  }
  headers.set(PROXIED_HEADER, scrub ? SCRUBBED_HOST : host || "unknown");
  headers.set(RELAYED_HEADER, "1");
  if (peer.lan) return proxyPairing(c, peer, tail, headers);
  const base = peerUrl(peer);
  const go = await preflight(base);
  if (!go) return c.json({ error: "peer down", id: peer.id }, 502);
  const stalled = new AbortController();
  const watched = go === "recent" ? watchStall(base, () => stalled.abort()) : () => {};
  // Not AbortSignal.timeout: the signal also governs the body, which must outlive the deadline.
  const late = new AbortController();
  const deadline = setTimeout(() => late.abort(), headersTimeoutMs);
  const answered = () => {
    watched();
    clearTimeout(deadline);
  };
  let res: Response;
  try {
    res = await proxy(`${base}${tail}${incoming.search}`, {
      raw: c.req.raw,
      headers,
      signal: AbortSignal.any([c.req.raw.signal, stalled.signal, late.signal]),
    });
  } catch (err) {
    answered();
    if (late.signal.aborted) {
      // It took the connection, so it is up but wedged: no down mark, the next hop tries again.
      console.warn(`[mesh] ${peer.id}: ${c.req.method} ${tail}: no response headers within ${headersTimeoutMs} ms`);
      return c.json({ error: "peer timeout", id: peer.id }, 504);
    }
    notePeerReach(base, false);
    console.warn(`[mesh] ${peer.id}: ${c.req.method} ${tail} failed: ${stalled.signal.aborted ? "no answer, and the peer is unreachable" : whyDown(err)}`);
    return c.json({ error: "peer down", id: peer.id }, 502);
  }
  answered();
  notePeerReach(base, true);
  if (res.status === 403 && res.headers.get(REFUSED_HEADER) === "refused") {
    await res.body?.cancel();
    return c.json({ error: "peer refused", id: peer.id }, 403);
  }
  // The peer's grant to this host doesn't cover it (§mesh.peers/grants): passed on as the peer sent
  // it, marker included, so the page can tell "hidden" from "refused".
  // Nor may a peer set or overwrite a cookie on this host's origin.
  res.headers.delete("set-cookie");
  return res;
}

export function upgradePeerSocket(req: IncomingMessage, socket: Duplex, head: Buffer, peer: PeerEntry | null, tail: string, search: string, scrub = false): void {
  if (!peer) {
    refuse(socket, 404, { error: "Unknown peer" });
    return;
  }
  socket.on("error", () => {}); // a reset while we decide; proxySocket takes over from there
  const headers: Record<string, string> = { [PROXIED_HEADER]: scrub ? SCRUBBED_HOST : req.headers.host || "unknown", [RELAYED_HEADER]: "1" };
  if (peer.lan) {
    upgradePairingSocket(req, socket, head, peer, tail, search, headers);
    return;
  }
  const base = peerUrl(peer);
  void preflight(base).then((go) => {
    if (socket.destroyed) return; // the browser gave up first
    if (!go) {
      refuse(socket, 502, { error: "peer down", id: peer.id });
      return;
    }
    const stalled = new AbortController();
    const answered = go === "recent" ? watchStall(base, () => stalled.abort()) : () => {};
    proxySocket(req, socket, head, `${base.replace(/^http/, "ws")}${tail}${search}`, headers, {
      handshakeTimeout: WS_HANDSHAKE_MS,
      signal: stalled.signal,
      onOpen: answered,
      onError: (err) => {
        answered();
        notePeerReach(base, false);
        console.warn(`[mesh] ${peer.id}: ws ${tail} failed: ${stalled.signal.aborted ? "no answer, and the peer is unreachable" : whyDown(err)}`);
        return [502, { error: "peer down", id: peer.id }];
      },
      onResponse: (res) => {
        answered();
        const marker = res.statusCode === 403 ? res.headers[REFUSED_HEADER.toLowerCase()] : undefined;
        if (marker === "refused") return [403, { error: "peer refused", id: peer.id }];
        // The peer's grant to this host doesn't cover the socket (§mesh.peers/grants): not down.
        if (marker === DENIED) return [403, { error: "peer hidden", id: peer.id }];
        return [502, { error: "peer down", id: peer.id }];
      },
    });
  });
}

/** A socket hop to a dial-out pairing: a new stream on its connection, the same proxy above it. */
function upgradePairingSocket(req: IncomingMessage, socket: Duplex, head: Buffer, peer: PeerEntry, tail: string, search: string, headers: Record<string, string>): void {
  const client = lanClient(peer);
  if (!client) {
    refuse(socket, 502, { error: "peer down", id: peer.id });
    return;
  }
  void client.openStream().then(
    (stream) => {
      if (socket.destroyed) {
        stream.destroy();
        return;
      }
      proxySocket(req, socket, head, `ws://${LAN_HOST}${tail}${search}`, headers, {
        handshakeTimeout: WS_HANDSHAKE_MS,
        dial: (url, protocols, opts) => streamWebSocket(url, stream, protocols.length ? protocols : undefined, opts),
        onError: (err) => {
          console.warn(`[mesh] ${peer.id}: ws ${tail} failed: ${whyDown(err)}`);
          return [502, { error: "peer down", id: peer.id }];
        },
        onResponse: (res) => {
          const marker = res.statusCode === 403 ? res.headers[REFUSED_HEADER.toLowerCase()] : undefined;
          if (marker === "refused") return [403, { error: "peer refused", id: peer.id }];
          if (marker === DENIED) return [403, { error: "peer hidden", id: peer.id }];
          return [502, { error: "peer down", id: peer.id }];
        },
      });
    },
    (err) => {
      console.warn(`[mesh] ${peer.id}: ws ${tail} failed: ${whyDown(err)}`);
      if (!socket.destroyed) refuse(socket, 502, { error: "peer down", id: peer.id });
    },
  );
}
