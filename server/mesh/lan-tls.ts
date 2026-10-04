// Pinned mutual TLS between a dial-out host and a relay (§mesh.lan/handshake).
//
// No library verifies a certificate: there is no `ca`, and certificate verification is off on both
// sides. Each side compares the other's SPKI pin itself, at the first moment it has control after
// the handshake: the dialer in its `secureConnect` handler, the relay in `secureConnection`, both
// synchronously, before a byte of HTTP/2 is written or read. A mismatch destroys the socket there.
// (checkServerIdentity is no place for it: without a trusted chain, neither runtime calls it.) The
// pin is read once, then: Node's client no longer has the peer certificate once the server's
// post-handshake ticket arrives.
//
// A certificate chain whose leaf carries another key, even one the pinned key signed, fails the
// compare: only the leaf's key is ever looked at.
//
// INVARIANTS that keep "no application byte before the pin compare" true (reviewed and accepted;
// break one and that guarantee is gone):
// 1. The compare stays synchronous inside those two handlers (`connectPinnedAt`'s secureConnect,
//    RelayListener.onSecure): no await, timer or callback between the event and the decision.
// 2. Nothing reads the socket before it: no `data` listener, no `resume()`, no pipe, no HTTP/2
//    session attached until the compare has passed (lan-dialer.ts and lan.ts attach theirs after).
// 3. The dialer is never given a `session` option (no resumption offered), and a resumed session
//    yields no pin (`livePeerPin`), so it is refused.
//
// No resumption, which is not the same as no tickets: SSL_OP_NO_TICKET stops stateless tickets, but
// Node's OpenSSL still sends stateful TLS 1.3 tickets (Bun sends none). Nothing on either side keeps
// a session store, so a presented ticket never resumes, and if one ever did, livePeerPin refuses it.
//
// Two channels share the port, told apart by ALPN: on `answer` the dial-out host answers the relay's
// requests, on `ask` it makes its own (§mesh.lan/reverse-channel).
//
// Builtins only. Never log a key or a certificate.

import crypto from "node:crypto";
import dns from "node:dns/promises";
import tls, { type ConnectionOptions, type TLSSocket, type TlsOptions } from "node:tls";
import { parseIp, relayAddress } from "../../shared/mesh-lan";
import { type LanIdentity, samePin, spkiPin } from "./lan-cert";

// Neutral tokens: the ClientHello carries them in the clear, so they name no product. They are still
// fixed and rare, so a passive observer can tell this traffic from HTTPS; that residual is accepted
// (§mesh.lan/handshake), as is the client certificate reaching whoever answers at the relay address
// before this side has checked it (TLS 1.3 sends it encrypted, but to the server it is talking to).
export const ALPN_ANSWER = "pa/1";
export const ALPN_ASK = "pq/1";
export type Channel = "answer" | "ask";
const ALPN: Record<Channel, string> = { answer: ALPN_ANSWER, ask: ALPN_ASK };
const CHANNEL_OF = new Map<string, Channel>([
  [ALPN_ANSWER, "answer"],
  [ALPN_ASK, "ask"],
]);

/** A handshake not done in this long is closed (and counts as failed on a relay). */
export const HANDSHAKE_MS = 5_000;

const VERSIONS = { minVersion: "TLSv1.3", maxVersion: "TLSv1.3" } as const;

/** tls.createServer options for a relay: a client certificate is asked for, and judged by its pin alone. */
export function relayServerOptions(id: LanIdentity): TlsOptions {
  return {
    key: id.keyPem,
    cert: id.certPem,
    requestCert: true,
    rejectUnauthorized: false, // the pin decides, in secureConnection; no chain is trusted
    ...VERSIONS,
    ALPNProtocols: [ALPN_ANSWER, ALPN_ASK],
    secureOptions: crypto.constants.SSL_OP_NO_TICKET,
    handshakeTimeout: HANDSHAKE_MS,
  };
}

/** tls.connect options for a dial-out host reaching a relay at host:port on one channel. */
export function dialOptions(id: LanIdentity, host: string, port: number, channel: Channel): ConnectionOptions {
  return {
    host,
    port,
    key: id.keyPem,
    cert: id.certPem,
    rejectUnauthorized: false, // the pin decides, in secureConnect; no chain is trusted
    ...VERSIONS,
    ALPNProtocols: [ALPN[channel]],
    // No SNI: it would put an address or name in the clear for nothing.
    servername: "",
  };
}

/**
 * The pin of the certificate on a just-completed connection, or null: no certificate, a resumed
 * session (whose certificate this side never saw), not TLS 1.3, or not one of our channels. Call it
 * in `secureConnect` / `secureConnection` only, and keep the answer.
 */
export function livePeerPin(sock: TLSSocket): string | null {
  if (sock.isSessionReused()) return null;
  if (!channelOf(sock)) return null;
  if (sock.getProtocol() !== "TLSv1.3") return null;
  const x = sock.getPeerX509Certificate();
  return x ? spkiPin(x) : null;
}

/** Which channel a connection negotiated, or null. */
export function channelOf(sock: TLSSocket): Channel | null {
  return typeof sock.alpnProtocol === "string" ? (CHANNEL_OF.get(sock.alpnProtocol) ?? null) : null;
}

/** The paired host this connection proved to be, and its channel; null and the caller destroys the socket. */
export function pairedPeerOf<T extends { pin: string }>(sock: TLSSocket, paired: Iterable<T>): { peer: T; channel: Channel } | null {
  const pin = livePeerPin(sock);
  const channel = channelOf(sock);
  if (!pin || !channel) return null;
  for (const p of paired) if (samePin(p.pin, pin)) return { peer: p, channel };
  return null;
}

export type DialFailure = "refused" | "timed out" | "relay's pin didn't match" | "rejected by the relay" | "TLS version refused" | "relay address isn't private" | "closed";

/** A fixed phrase for why a dial or session failed: never raw error text, a pin or an address. */
export function dialFailure(err: unknown): DialFailure {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const msg = typeof e?.message === "string" ? e.message : "";
  if (code === "ECONNREFUSED" || code === "ConnectionRefused" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return "refused";
  if (code === "ETIMEDOUT" || /timed? ?out/i.test(msg)) return "timed out";
  if (/pin mismatch/.test(msg)) return "relay's pin didn't match";
  if (/PROTOCOL_VERSION|VERSION_TOO_LOW|UNSUPPORTED_PROTOCOL/i.test(code + msg)) return "TLS version refused";
  if (/CERTIFICATE_REQUIRED|UNKNOWN_CA|BAD_CERTIFICATE|NO_APPLICATION_PROTOCOL|ALERT_/i.test(code + msg)) return "rejected by the relay";
  return "closed";
}

/**
 * Dial the relay pinned as `relayPin` on `channel`, and resolve with the socket once its pin
 * checked, before anything is written. Rejects with an Error whose message is a DialFailure phrase.
 */
export async function connectPinned(id: LanIdentity, relayPin: string, host: string, port: number, channel: Channel, timeoutMs = 10_000): Promise<TLSSocket> {
  const at = await relayTarget(host);
  if (!at) throw new Error("relay address isn't private" satisfies DialFailure);
  return connectPinnedAt(id, relayPin, at, port, channel, timeoutMs);
}

type LookupAll = (host: string) => Promise<Array<{ address: string }>>;
const lookupAll: LookupAll = (host) => dns.lookup(host, { all: true, verbatim: true });

/**
 * Where a dial-out host may dial `host` (§mesh.lan/pairing): itself when it is a loopback, private or
 * link-local IP; for a name, the first such address it resolves to; else null (a public relay is
 * never dialed). A name that doesn't resolve rejects as a DialFailure.
 */
export async function relayTarget(host: string, lookup: LookupAll = lookupAll): Promise<string | null> {
  if (parseIp(host)) {
    const ip = relayAddress(host);
    return "address" in ip ? ip.address : null;
  }
  let found: Array<{ address: string }>;
  try {
    found = await lookup(host);
  } catch (err) {
    throw new Error(dialFailure(err));
  }
  for (const a of found) {
    const ip = relayAddress(a.address);
    if ("address" in ip) return ip.address;
  }
  return null;
}

function connectPinnedAt(id: LanIdentity, relayPin: string, host: string, port: number, channel: Channel, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = tls.connect(dialOptions(id, host, port, channel));
    const fail = (why: DialFailure) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail("timed out"), timeoutMs);
    timer.unref?.();
    const onError = (err: Error) => fail(dialFailure(err));
    const onClose = () => fail("closed");
    sock.on("error", onError);
    sock.once("close", onClose);
    sock.once("secureConnect", () => {
      const pin = livePeerPin(sock);
      if (!pin || !samePin(pin, relayPin) || channelOf(sock) !== channel) return fail("relay's pin didn't match");
      done = true;
      clearTimeout(timer);
      sock.off("error", onError);
      sock.off("close", onClose);
      // A later error must never be uncaught; the caller watches `close`.
      sock.on("error", () => {});
      resolve(sock);
    });
  });
}
