// The pinning negatives (§mesh.lan/handshake), against the module's own options, on whichever
// runtime runs the suite: pnpm test = Bun's BoringSSL, test:node = OpenSSL. "Before any stream"
// is checked literally: the refused side never got a byte of application data from the other.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import net, { type AddressInfo } from "node:net";
import { test } from "node:test";
import tls, { type TLSSocket } from "node:tls";
import { buildCertDer, type LanIdentity, mintLanIdentity, pem, spkiPin } from "./lan-cert";
import { ALPN_ANSWER, ALPN_ASK, type Channel, connectPinned, dialFailure, dialOptions, livePeerPin, pairedPeerOf, relayServerOptions, relayTarget } from "./lan-tls";

type Peer = { pin: string; label: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A relay that pairs `paired`; records what it accepted and how many bytes refused clients sent. */
async function relay(id: LanIdentity, paired: Peer[], over: Partial<tls.TlsOptions> = {}) {
  const accepted: string[] = [];
  let bytesFromRefused = 0;
  let bytesFromAccepted = 0;
  const server = tls.createServer({ ...relayServerOptions(id), ...over });
  server.on("tlsClientError", (_e, s) => s.destroy());
  server.on("secureConnection", (sock: TLSSocket) => {
    sock.on("error", () => {});
    const hit = pairedPeerOf(sock, paired);
    if (!hit) {
      sock.on("data", (d: Buffer) => (bytesFromRefused += d.length));
      sock.destroy();
      return;
    }
    sock.on("data", (d: Buffer) => (bytesFromAccepted += d.length));
    accepted.push(`${hit.peer.label}/${hit.channel}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    accepted,
    bytes: () => ({ refused: bytesFromRefused, accepted: bytesFromAccepted }),
    close: () => server.close(),
  };
}

/** A raw client with the given options; resolves once it is closed or 400 ms passed. */
async function rawDial(opts: tls.ConnectionOptions, write?: string): Promise<string> {
  return await new Promise((resolve) => {
    const s = tls.connect(opts);
    s.on("error", (e) => resolve(`err:${(e as { code?: string }).code ?? e.message}`));
    s.on("secureConnect", () => {
      if (write) s.write(write);
      s.resume();
      setTimeout(() => {
        resolve(s.destroyed ? "closed" : "ok");
        s.destroy();
      }, 400);
    });
  });
}

const mac = mintLanIdentity();
const relayId = mintLanIdentity();
const other = mintLanIdentity();
const macPeer: Peer = { pin: mac.pin, label: "dialer" };

test("a paired dial-out host and relay accept each other on either channel", async () => {
  const r = await relay(relayId, [macPeer]);
  for (const ch of ["answer", "ask"] as Channel[]) {
    const sock = await connectPinned(mac, relayId.pin, "127.0.0.1", r.port, ch);
    assert.equal(sock.getProtocol(), "TLSv1.3");
    assert.equal(sock.alpnProtocol, ch === "answer" ? ALPN_ANSWER : ALPN_ASK);
    await sleep(100);
    sock.destroy();
  }
  assert.deepEqual(r.accepted, ["dialer/answer", "dialer/ask"]);
  r.close();
});

test("wrong relay pin: the dialer refuses before writing a byte", async () => {
  const r = await relay(other, [macPeer]);
  await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", r.port, "answer"), /relay's pin didn't match/);
  await sleep(100);
  assert.deepEqual(r.bytes(), { refused: 0, accepted: 0 }, "nothing reached the impostor");
  r.close();
});

test("wrong client pin, or no client certificate: the relay refuses before reading a byte", async () => {
  const r = await relay(relayId, [macPeer]);
  const req = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"; // what an h2 client sends first
  const wrong = await rawDial({ ...dialOptions(other, "127.0.0.1", r.port, "ask") }, req);
  const none = await rawDial({ ...dialOptions(mac, "127.0.0.1", r.port, "ask"), key: undefined, cert: undefined }, req);
  assert.notEqual(wrong, "ok");
  assert.notEqual(none, "ok");
  await sleep(100);
  assert.deepEqual(r.accepted, []);
  assert.equal(r.bytes().refused, 0, "no byte of a refused client was ever read");
  r.close();
});

test("chain trick: a leaf the pinned key issued to another key is refused both ways", async () => {
  const cnOf = (certPem: string) => new crypto.X509Certificate(certPem).subject.replace(/^CN=/, "");
  // The dial-out side: a child of the dial-out host's key, sent with the real cert as its issuer.
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const child = pem(buildCertDer(kp.publicKey, crypto.createPrivateKey(mac.keyPem), { subjectCn: "child", issuerCn: cnOf(mac.certPem) }));
  const r = await relay(relayId, [macPeer]);
  await rawDial({ ...dialOptions(mac, "127.0.0.1", r.port, "answer"), key: kp.privateKey.export({ type: "pkcs8", format: "pem" }), cert: child + mac.certPem }, "x");
  await sleep(100);
  assert.deepEqual(r.accepted, []);
  assert.equal(r.bytes().refused, 0);
  r.close();

  // The relay side: it presents a child of its own key.
  const kp2 = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const child2 = pem(buildCertDer(kp2.publicKey, crypto.createPrivateKey(relayId.keyPem), { subjectCn: "child", issuerCn: cnOf(relayId.certPem) }));
  const r2 = await relay(relayId, [macPeer], { key: kp2.privateKey.export({ type: "pkcs8", format: "pem" }), cert: child2 + relayId.certPem });
  await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", r2.port, "answer"), /relay's pin didn't match/);
  await sleep(100);
  assert.deepEqual(r2.bytes(), { refused: 0, accepted: 0 });
  r2.close();
});

test("TLS 1.2 is refused both ways", async () => {
  const r = await relay(relayId, [macPeer]);
  const old = await rawDial({ ...dialOptions(mac, "127.0.0.1", r.port, "answer"), minVersion: "TLSv1.2", maxVersion: "TLSv1.2" });
  assert.match(old, /^err:/);
  r.close();
  const r12 = await relay(relayId, [macPeer], { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" });
  await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", r12.port, "answer"), /TLS version refused/);
  assert.deepEqual(r12.accepted, []);
  r12.close();
});

test("a client offering neither channel is never paired", async () => {
  const r = await relay(relayId, [macPeer]);
  await rawDial({ ...dialOptions(mac, "127.0.0.1", r.port, "answer"), ALPNProtocols: ["h2", "http/1.1"] });
  await sleep(100);
  assert.deepEqual(r.accepted, []);
  r.close();
});

/** A ticket for a session `id`'s key really issued, from an ordinary server with tickets on (both
    runtimes issue one there; the relay itself issues none on Bun and stateful ones on Node). */
async function ticketFrom(server: tls.Server, dialer: LanIdentity): Promise<Buffer> {
  const port = (server.address() as AddressInfo).port;
  let session: Buffer | undefined;
  const c = tls.connect(dialOptions(dialer, "127.0.0.1", port, "answer"));
  c.on("session", (s: Buffer) => (session = s));
  c.on("error", () => {});
  await once(c, "secureConnect");
  c.resume();
  for (let i = 0; i < 20 && !session; i++) await sleep(25);
  c.destroy();
  assert.ok(session, "the ticket server issued a ticket");
  return session;
}

/** Connect presenting `session`; whether it resumed, and the pin livePeerPin gives on our side. */
async function present(port: number, session: Buffer): Promise<{ reused: boolean; pin: string | null }> {
  const c = tls.connect({ ...dialOptions(mac, "127.0.0.1", port, "answer"), session });
  c.on("error", () => {});
  const out = await new Promise<{ reused: boolean; pin: string | null }>((resolve) => {
    c.once("secureConnect", () => resolve({ reused: c.isSessionReused(), pin: livePeerPin(c) }));
    c.once("close", () => resolve({ reused: false, pin: null }));
  });
  await sleep(150);
  c.destroy();
  return out;
}

test("no resumption: a presented ticket never yields a resumed, paired session", async () => {
  // A twin of the relay (same key and certificate) with tickets ON: it resumes, and that is how
  // we prove livePeerPin refuses a resumed session on both sides.
  const o = relayServerOptions(relayId);
  const twin = tls.createServer({ ...o, secureOptions: 0 });
  const twinPins: Array<string | null> = [];
  twin.on("secureConnection", (s: TLSSocket) => {
    s.on("error", () => {});
    if (s.isSessionReused()) twinPins.push(livePeerPin(s));
    s.write("x"); // lets the client's ticket arrive
  });
  twin.listen(0, "127.0.0.1");
  await once(twin, "listening");
  const ticket = await ticketFrom(twin, mac);
  const atTwin = await present((twin.address() as AddressInfo).port, ticket);
  assert.equal(atTwin.reused, true, "the twin resumes: the ticket is real");
  assert.equal(atTwin.pin, null, "a resumed session yields no pin to the dialer");
  assert.deepEqual(twinPins, [null], "nor to the relay side");
  twin.close();

  // The relay itself: the twin's ticket (same key, another server) and, where the runtime issues
  // one, the relay's own ticket. Neither resumes; at most a full handshake pairs, read fresh.
  const r = await relay(relayId, [macPeer]);
  const own: Buffer[] = [];
  const first = tls.connect(dialOptions(mac, "127.0.0.1", r.port, "answer"));
  first.on("session", (s: Buffer) => own.push(s));
  first.on("error", () => {});
  await once(first, "secureConnect");
  first.resume();
  await sleep(200);
  first.destroy();
  for (const t of [ticket, ...own]) {
    const got = await present(r.port, t);
    assert.equal(got.reused, false, "the relay never resumes a session");
    assert.equal(got.pin, relayId.pin, "the relay's pin was read fresh, from a full handshake");
  }
  assert.ok(r.accepted.every((a) => a === "dialer/answer"));
  r.close();
});

test("dial failures are fixed phrases", async () => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", port, "answer"), /^Error: refused$/);

  const mute = net.createServer(() => {}); // accepts TCP, never speaks TLS
  mute.listen(0, "127.0.0.1");
  await once(mute, "listening");
  await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", (mute.address() as AddressInfo).port, "answer", 300), /^Error: timed out$/);
  mute.close();

  for (const [err, want] of [
    [{ code: "ECONNREFUSED" }, "refused"],
    [{ message: "pin mismatch" }, "relay's pin didn't match"],
    [{ code: "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION" }, "TLS version refused"],
    [{ code: "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED" }, "rejected by the relay"],
    [{ message: "secret-ish details 192.0.2.1" }, "closed"],
    [null, "closed"],
  ] as const) assert.equal(dialFailure(err), want, JSON.stringify(err));
});

test("a dial-out host never dials a public relay address, nor a name that resolves only to one", async () => {
  const names: Record<string, string[]> = { "lan.example": ["198.51.100.4", "10.0.0.4"], "public.example": ["198.51.100.4", "2001:db8::4"], "v6.example": ["fd00::4"] };
  const lookup = async (h: string) => {
    if (!names[h]) throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    return names[h]!.map((address) => ({ address }));
  };
  assert.equal(await relayTarget("10.0.0.4", lookup), "10.0.0.4");
  assert.equal(await relayTarget("::ffff:10.0.0.4", lookup), "10.0.0.4");
  assert.equal(await relayTarget("lan.example", lookup), "10.0.0.4", "a name's first local-network address");
  assert.equal(await relayTarget("v6.example", lookup), "fd00::4");
  for (const h of ["198.51.100.4", "2001:db8::4", "0.0.0.0", "0::", "public.example"]) assert.equal(await relayTarget(h, lookup), null, h);
  await assert.rejects(relayTarget("missing.example", lookup), /^Error: closed$/, "a fixed phrase, never the resolver's text");
  // And connectPinned refuses before any socket: nothing listens at that documentation address.
  await assert.rejects(connectPinned(mac, relayId.pin, "192.0.2.1", 9, "answer", 300), /^Error: relay address isn't private$/);
});

test("a pairing marked as on the internet may dial a public relay, or a name's first unicast answer; never every interface or a group address", async () => {
  const names: Record<string, string[]> = { "vps.example": ["0.0.0.0", "224.0.0.9", "203.0.113.10", "10.0.0.4"], "groups.example": ["255.255.255.255", "ff02::1"] };
  const lookup = async (h: string) => {
    if (!names[h]) throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    return names[h]!.map((address) => ({ address }));
  };
  for (const h of ["203.0.113.10", "2001:db8::4", "100.64.0.9", "10.0.0.4"]) assert.equal(await relayTarget(h, lookup, true), h, h);
  assert.equal(await relayTarget("::ffff:203.0.113.10", lookup, true), "203.0.113.10");
  assert.equal(await relayTarget("vps.example", lookup, true), "203.0.113.10", "skips every-interface and multicast answers");
  for (const h of ["0.0.0.0", "::", "224.0.0.1", "255.255.255.255", "ff02::1", "groups.example"]) assert.equal(await relayTarget(h, lookup, true), null, h);
  // Without the mark the very same names and addresses keep the local-network rule.
  assert.equal(await relayTarget("vps.example", lookup), "10.0.0.4");
  assert.equal(await relayTarget("203.0.113.10", lookup), null);
});

test("internet dial: an accept process that ends the connection after the outer handshake reads as 'accept process refused', never as a wrong pin", async () => {
  // A stand-in accept process: completes the outer TLS 1.3 handshake with the dialer's certificate,
  // then closes, as one that doesn't know this pin (or whose relay refused it) does. On Bun the inner
  // client may then report a finished handshake (TLS 1.2, no certificate, no token): that must not
  // be taken for a connection, nor for the relay's pin.
  const outerKey = mintLanIdentity();
  const server = tls.createServer({ ...relayServerOptions(outerKey) }, (s) => s.destroy());
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  for (const channel of ["answer", "ask"] as const) {
    await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", port, channel, 3000, true), /^Error: accept process refused$/, channel);
  }
  server.close();
});

test("internet dial: nothing listening is 'refused', as for any relay", async () => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as AddressInfo).port;
  s.close();
  await once(s, "close");
  await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", port, "answer", 3000, true), /^Error: refused$/);
});

test("pins come from the certificate's key", () => {
  assert.ok(spkiPin(new crypto.X509Certificate(mac.certPem)) === mac.pin);
});
