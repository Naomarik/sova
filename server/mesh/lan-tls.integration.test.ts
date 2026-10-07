// Run: node scripts/run-tests.mjs server/mesh/lan-tls.integration.test.ts
// The pinning negatives (§mesh.lan/handshake), against the module's own options, on whichever
// runtime runs the suite: pnpm test = Bun's BoringSSL, test:node = OpenSSL. "Before any stream"
// is checked literally: the refused side never got a byte of application data from the other.
// Each check waits for the relay's own verdict (its connection ending, or the hand-on), never a
// fixed time. The rules that need no handshake: lan-tls.test.ts.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import net, { type AddressInfo } from "node:net";
import { test } from "node:test";
import tls, { type TLSSocket } from "node:tls";
import { buildCertDer, type LanIdentity, mintLanIdentity, pem } from "./lan-cert";
import { ALPN_ANSWER, ALPN_ASK, type Channel, connectPinned, dialOptions, livePeerPin, pairedPeerOf, relayServerOptions } from "./lan-tls";

type Peer = { pin: string; label: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll with a generous hang guard: never a bound on how fast a handshake is. */
async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A relay that pairs `paired`; records what it accepted, how many bytes refused clients sent, and
    how many of its connections have ended. `greet`: an accepted connection gets one byte, so a
    client that read it has also read whatever the relay sent before (a session ticket). */
async function relay(id: LanIdentity, paired: Peer[], over: Partial<tls.TlsOptions> = {}, greet = false) {
  const accepted: string[] = [];
  let bytesFromRefused = 0;
  let bytesFromAccepted = 0;
  let opened = 0;
  let ended = 0;
  const server = tls.createServer({ ...relayServerOptions(id), ...over });
  server.prependListener("connection", (raw: net.Socket) => {
    opened++;
    raw.once("close", () => ended++);
  });
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
    if (greet) sock.write("x");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    accepted,
    bytes: () => ({ refused: bytesFromRefused, accepted: bytesFromAccepted }),
    /** Every connection the relay took has ended: its verdicts are all in. */
    settled: () => until("the relay's connections to end", () => opened > 0 && ended === opened),
    close: () => server.close(),
  };
}

/** A raw client with the given options; resolves with how it ended: an error, or "closed" (the
    relay ended it). One the relay keeps reads as "ok" only at the hang guard: never in a passing run. */
async function rawDial(opts: tls.ConnectionOptions, write?: string): Promise<string> {
  return await new Promise((resolve) => {
    const s = tls.connect(opts);
    s.on("error", (e) => resolve(`err:${(e as { code?: string }).code ?? e.message}`));
    s.once("close", () => resolve("closed"));
    s.on("secureConnect", () => {
      if (write) s.write(write);
      s.resume();
      setTimeout(() => {
        resolve(s.destroyed ? "closed" : "ok");
        s.destroy();
      }, 15_000).unref();
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
    const before = r.accepted.length;
    const sock = await connectPinned(mac, relayId.pin, "127.0.0.1", r.port, ch);
    assert.equal(sock.getProtocol(), "TLSv1.3");
    assert.equal(sock.alpnProtocol, ch === "answer" ? ALPN_ANSWER : ALPN_ASK);
    await until("the relay to accept it", () => r.accepted.length > before);
    sock.destroy();
  }
  assert.deepEqual(r.accepted, ["dialer/answer", "dialer/ask"]);
  r.close();
});

test("wrong relay pin: the dialer refuses before writing a byte", async () => {
  const r = await relay(other, [macPeer]);
  await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", r.port, "answer"), /relay's pin didn't match/);
  await r.settled();
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
  await r.settled();
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
  await r.settled();
  assert.deepEqual(r.accepted, []);
  assert.equal(r.bytes().refused, 0);
  r.close();

  // The relay side: it presents a child of its own key.
  const kp2 = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const child2 = pem(buildCertDer(kp2.publicKey, crypto.createPrivateKey(relayId.keyPem), { subjectCn: "child", issuerCn: cnOf(relayId.certPem) }));
  const r2 = await relay(relayId, [macPeer], { key: kp2.privateKey.export({ type: "pkcs8", format: "pem" }), cert: child2 + relayId.certPem });
  await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", r2.port, "answer"), /relay's pin didn't match/);
  await r2.settled();
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
  await r.settled();
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
  await until("the ticket server's ticket", () => session !== undefined);
  c.destroy();
  assert.ok(session, "the ticket server issued a ticket");
  return session;
}

/** Connect presenting `session`; whether it resumed, and the pin livePeerPin gives on our side.
    `seen`: the server's side has judged this connection. */
async function present(port: number, session: Buffer, seen: () => boolean): Promise<{ reused: boolean; pin: string | null }> {
  const c = tls.connect({ ...dialOptions(mac, "127.0.0.1", port, "answer"), session });
  c.on("error", () => {});
  const out = await new Promise<{ reused: boolean; pin: string | null }>((resolve) => {
    c.once("secureConnect", () => resolve({ reused: c.isSessionReused(), pin: livePeerPin(c) }));
    c.once("close", () => resolve({ reused: false, pin: null }));
  });
  await until("the server's side of it", seen);
  c.destroy();
  return out;
}

test("no resumption: a presented ticket never yields a resumed, paired session", async () => {
  // A twin of the relay (same key and certificate) with tickets ON: it resumes, and that is how
  // we prove livePeerPin refuses a resumed session on both sides.
  const o = relayServerOptions(relayId);
  const twin = tls.createServer({ ...o, secureOptions: 0 });
  const twinPins: Array<string | null> = [];
  let twinSeen = 0;
  twin.on("secureConnection", (s: TLSSocket) => {
    s.on("error", () => {});
    twinSeen++;
    if (s.isSessionReused()) twinPins.push(livePeerPin(s));
    s.write("x"); // lets the client's ticket arrive
  });
  twin.listen(0, "127.0.0.1");
  await once(twin, "listening");
  const ticket = await ticketFrom(twin, mac);
  const atTwin = await present((twin.address() as AddressInfo).port, ticket, () => twinSeen === 2);
  assert.equal(atTwin.reused, true, "the twin resumes: the ticket is real");
  assert.equal(atTwin.pin, null, "a resumed session yields no pin to the dialer");
  assert.deepEqual(twinPins, [null], "nor to the relay side");
  twin.close();

  // The relay itself: the twin's ticket (same key, another server) and, where the runtime issues
  // one, the relay's own ticket. Neither resumes; at most a full handshake pairs, read fresh.
  const r = await relay(relayId, [macPeer], {}, true);
  const own: Buffer[] = [];
  const first = tls.connect(dialOptions(mac, "127.0.0.1", r.port, "answer"));
  first.on("session", (s: Buffer) => own.push(s));
  first.on("error", () => {});
  await once(first, "secureConnect");
  // The relay's greeting follows any ticket it sends: once it is read, so is the ticket.
  await once(first, "data");
  first.destroy();
  for (const t of [ticket, ...own]) {
    const before = r.accepted.length;
    const got = await present(r.port, t, () => r.accepted.length > before);
    assert.equal(got.reused, false, "the relay never resumes a session");
    assert.equal(got.pin, relayId.pin, "the relay's pin was read fresh, from a full handshake");
  }
  assert.ok(r.accepted.every((a) => a === "dialer/answer"));
  r.close();
});

test("dial failures are fixed phrases: refused, and timed out against a relay that never speaks TLS", async () => {
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
  // The phrase table itself: lan-tls.test.ts.
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
    await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", port, channel, 15_000, true), /^Error: accept process refused$/, channel);
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
  await assert.rejects(connectPinned(mac, relayId.pin, "127.0.0.1", port, "answer", 15_000, true), /^Error: refused$/);
});
