// Pinned mutual TLS for LAN hosts and relays (§mesh.lan/handshake).
//
// Node's TLS client skips checkServerIdentity when chain verification fails and on resumed sessions,
// so a pin there alone accepts anything. Here the peer's own certificate is the ONLY `ca` with
// verification on, the SPKI is compared in checkServerIdentity, and again on the live socket before
// a byte moves. The second compare is what refuses a certificate the pinned key issued to another
// key: Bun's TLS stack accepts that chain under a CA:FALSE anchor.
//
// Builtins only. Never log a key, a pin or a certificate.

import crypto, { X509Certificate } from "node:crypto";
import tls, { type ConnectionOptions, type TLSSocket, type TlsOptions } from "node:tls";
import { type LanIdentity, samePin, spkiPin } from "./lan-cert";

export const LAN_ALPN = "h2";
/** A handshake not done in this long is closed (and counts as failed on a relay). */
export const HANDSHAKE_MS = 5_000;

const VERSIONS = { minVersion: "TLSv1.3", maxVersion: "TLSv1.3" } as const;

export interface PinnedPeer {
  certPem: string;
  pin: string;
}

/** tls.createServer options for a relay: client certs required, verified against the paired hosts. */
export function relayServerOptions(id: LanIdentity, paired: readonly PinnedPeer[]): TlsOptions {
  if (!paired.length) throw new Error("a relay listens only while a host is paired");
  return {
    key: id.keyPem,
    cert: id.certPem,
    ca: paired.map((p) => p.certPem),
    requestCert: true,
    rejectUnauthorized: true,
    ...VERSIONS,
    ALPNProtocols: [LAN_ALPN],
    secureOptions: crypto.constants.SSL_OP_NO_TICKET,
    handshakeTimeout: HANDSHAKE_MS,
  };
}

/** tls.connect options for a LAN host dialing `relay` at host:port. */
export function dialOptions(id: LanIdentity, relay: PinnedPeer, host: string, port: number): ConnectionOptions {
  return {
    host,
    port,
    key: id.keyPem,
    cert: id.certPem,
    ca: [relay.certPem],
    rejectUnauthorized: true,
    ...VERSIONS,
    ALPNProtocols: [LAN_ALPN],
    // The pin IS the identity: this replaces the host-name check, never adds to it.
    checkServerIdentity: (_host, cert) => {
      const raw = (cert as { raw?: Buffer } | undefined)?.raw;
      if (!raw) return new Error("no peer certificate");
      return samePin(spkiPin(new X509Certificate(raw)), relay.pin) ? undefined : new Error("pin mismatch");
    },
    // No SNI: it would put an address or name in the clear for nothing.
    servername: "",
  };
}

/**
 * The pin of the certificate on a live connection, or null: no certificate, a resumed session
 * (whose certificate this side never saw verified), or a protocol other than h2.
 * Read it once, in `secureConnect` / `secureConnection`, and keep the answer: Node's client drops
 * the peer certificate once the server's post-handshake ticket arrives, so a later read is null.
 */
export function livePeerPin(sock: TLSSocket): string | null {
  if (sock.isSessionReused()) return null;
  if (sock.alpnProtocol !== LAN_ALPN) return null;
  if (sock.getProtocol() !== "TLSv1.3") return null;
  const x = sock.getPeerX509Certificate();
  return x ? spkiPin(x) : null;
}

/** The paired host this connection proved to be, or null (and the caller destroys the socket). */
export function pairedPeerOf<T extends { pin: string }>(sock: TLSSocket, paired: Iterable<T>): T | null {
  const pin = livePeerPin(sock);
  if (!pin) return null;
  for (const p of paired) if (samePin(p.pin, pin)) return p;
  return null;
}

export type DialFailure = "refused" | "timed out" | "relay's pin didn't match" | "rejected by the relay" | "TLS version refused" | "closed";

/** A fixed phrase for why a dial or session failed: never raw error text, a pin or an address. */
export function dialFailure(err: unknown): DialFailure {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const msg = typeof e?.message === "string" ? e.message : "";
  if (code === "ECONNREFUSED" || code === "ConnectionRefused" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return "refused";
  if (code === "ETIMEDOUT" || /timed? ?out/i.test(msg)) return "timed out";
  if (/pin mismatch/.test(msg) || code === "ERR_TLS_CERT_ALTNAME_INVALID" || /SELF_SIGNED|UNABLE_TO_VERIFY|CERT_|INVALID_PURPOSE|UNSPECIFIED/.test(code)) return "relay's pin didn't match";
  if (/PROTOCOL_VERSION|VERSION_TOO_LOW|UNSUPPORTED_PROTOCOL/i.test(code + msg)) return "TLS version refused";
  if (/CERTIFICATE_REQUIRED|UNKNOWN_CA|BAD_CERTIFICATE|ALERT_/i.test(code + msg)) return "rejected by the relay";
  return "closed";
}

/**
 * Dial `relay` and resolve with the socket once its pin checked on the live connection. Rejects with
 * an Error whose message is a DialFailure phrase.
 */
export function connectPinned(id: LanIdentity, relay: PinnedPeer, host: string, port: number, timeoutMs = 10_000): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    let done = false;
    const sock = tls.connect(dialOptions(id, relay, host, port));
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
      if (!pin || !samePin(pin, relay.pin)) return fail("relay's pin didn't match");
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
