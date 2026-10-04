// The pinning negatives from the spike, against the module's own options (§mesh.lan/handshake).
// Each runs on whichever runtime runs the suite: pnpm test = Bun's BoringSSL, test:node = OpenSSL.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import net, { type AddressInfo } from "node:net";
import { test } from "node:test";
import tls, { type TLSSocket } from "node:tls";
import { buildCertDer, type LanIdentity, mintLanIdentity, pem, spkiPin } from "./lan-cert";
import { connectPinned, dialFailure, dialOptions, livePeerPin, pairedPeerOf, relayServerOptions } from "./lan-tls";

type Peer = { certPem: string; pin: string; label: string };
const peerOf = (id: LanIdentity, label: string): Peer => ({ certPem: id.certPem, pin: id.pin, label });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A relay presenting `serverCert` (default: its own identity) and pairing `paired`; records what it accepted. */
async function relay(id: LanIdentity, paired: Peer[], over: Partial<tls.TlsOptions> = {}) {
  const accepted: string[] = [];
  let rejectedAfterCa = 0;
  const server = tls.createServer({ ...relayServerOptions(id, paired), ...over });
  server.on("tlsClientError", () => {});
  server.on("secureConnection", (sock: TLSSocket) => {
    sock.on("error", () => {});
    const p = pairedPeerOf(sock, paired);
    if (!p) {
      rejectedAfterCa++;
      sock.destroy();
      return;
    }
    accepted.push(p.label);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return { port, accepted, rejectedAfterCa: () => rejectedAfterCa, close: () => server.close() };
}

/** A raw client: resolves "ok" once the handshake completed and the relay hasn't hung up within 300 ms. */
async function rawDial(opts: tls.ConnectionOptions): Promise<string> {
  return await new Promise((resolve) => {
    const s = tls.connect(opts);
    s.on("error", (e) => resolve(`err:${(e as { code?: string }).code ?? e.message}`));
    s.on("secureConnect", () => {
      s.resume();
      setTimeout(() => {
        resolve(s.destroyed ? "closed" : "ok");
        s.destroy();
      }, 300);
    });
  });
}

const mac = mintLanIdentity();
const relayId = mintLanIdentity();
const other = mintLanIdentity();
const relayPeer = peerOf(relayId, "relay");
const macPeer = peerOf(mac, "mac");

test("a paired host and relay accept each other, and each side sees the other's pin", async () => {
  const r = await relay(relayId, [macPeer]);
  // connectPinned resolves only once the relay's pin checked at secureConnect. It is never re-read
  // afterwards: Node's client drops the peer certificate once the handshake's ticket arrives.
  const sock = await connectPinned(mac, relayPeer, "127.0.0.1", r.port).finally(() => setTimeout(() => r.close(), 1000));
  assert.equal(sock.getProtocol(), "TLSv1.3");
  assert.equal(sock.alpnProtocol, "h2");
  await sleep(150);
  assert.deepEqual(r.accepted, ["mac"]);
  sock.destroy();
  r.close();
});

test("the dialer refuses a relay presenting any other certificate", async () => {
  const r = await relay(other, [macPeer]);
  await assert.rejects(connectPinned(mac, relayPeer, "127.0.0.1", r.port), /relay's pin didn't match/);
  assert.deepEqual(r.accepted, []);
  r.close();
});

test("the relay refuses an unpaired client certificate, and no certificate at all", async () => {
  const r = await relay(relayId, [macPeer]);
  const wrong = await connectPinned(other, relayPeer, "127.0.0.1", r.port).then(
    async (s) => { await sleep(200); const gone = s.destroyed || !s.readable; s.destroy(); return gone ? "closed" : "open"; },
    (e: Error) => e.message,
  );
  assert.notEqual(wrong, "open");
  const none = await rawDial({ ...dialOptions(mac, relayPeer, "127.0.0.1", r.port), key: undefined, cert: undefined });
  assert.notEqual(none, "ok");
  await sleep(100);
  assert.deepEqual(r.accepted, []);
  r.close();
});

test("chain trick: a cert the pinned key issued to another key is refused both ways", async () => {
  // Client side: a child of the Mac's key, presented with the Mac's cert as its issuer.
  const childKp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const macKey = crypto.createPrivateKey(mac.keyPem);
  const cnOf = (certPem: string) => new crypto.X509Certificate(certPem).subject.replace(/^CN=/, "");
  const child = pem(buildCertDer(childKp.publicKey, macKey, { subjectCn: "child", issuerCn: cnOf(mac.certPem) }));
  const childKeyPem = childKp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const r = await relay(relayId, [macPeer]);
  const res = await rawDial({ ...dialOptions(mac, relayPeer, "127.0.0.1", r.port), key: childKeyPem, cert: child + mac.certPem });
  await sleep(100);
  assert.deepEqual(r.accepted, [], `relay accepted a child cert (client saw ${res})`);
  r.close();

  // Server side: the relay presents a child of its own key.
  const relayKey = crypto.createPrivateKey(relayId.keyPem);
  const kp2 = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const child2 = pem(buildCertDer(kp2.publicKey, relayKey, { subjectCn: "child", issuerCn: cnOf(relayId.certPem) }));
  const r2 = await relay(relayId, [macPeer], { key: kp2.privateKey.export({ type: "pkcs8", format: "pem" }), cert: child2 + relayId.certPem });
  await assert.rejects(connectPinned(mac, relayPeer, "127.0.0.1", r2.port), /relay's pin didn't match/);
  r2.close();
});

test("TLS 1.2 is refused both ways", async () => {
  const r = await relay(relayId, [macPeer]);
  const old = await rawDial({ ...dialOptions(mac, relayPeer, "127.0.0.1", r.port), minVersion: "TLSv1.2", maxVersion: "TLSv1.2" });
  assert.match(old, /^err:/);
  r.close();
  const r12 = await relay(relayId, [macPeer], { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" });
  await assert.rejects(connectPinned(mac, relayPeer, "127.0.0.1", r12.port), /TLS version refused/);
  assert.deepEqual(r12.accepted, []);
  r12.close();
});

test("a client that doesn't speak h2 is never paired", async () => {
  const r = await relay(relayId, [macPeer]);
  await rawDial({ ...dialOptions(mac, relayPeer, "127.0.0.1", r.port), ALPNProtocols: ["http/1.1"] });
  await sleep(100);
  assert.deepEqual(r.accepted, []);
  r.close();
});

test("resumption: a second connection offering the first's session is never a resumed, paired one", async () => {
  const r = await relay(relayId, [macPeer]);
  let session: Buffer | undefined;
  const first = tls.connect(dialOptions(mac, relayPeer, "127.0.0.1", r.port));
  first.on("session", (s: Buffer) => { session = s; });
  first.on("error", () => {});
  await once(first, "secureConnect");
  first.resume();
  await sleep(200);
  first.destroy();
  assert.deepEqual(r.accepted, ["mac"]);
  if (!session) {
    r.close();
    return; // no ticket issued at all: nothing to resume (Bun)
  }
  // With the session and NO client cert: if the relay resumed, it would see the first's identity.
  const second = tls.connect({ ...dialOptions(mac, relayPeer, "127.0.0.1", r.port), session, key: undefined, cert: undefined });
  second.on("error", () => {});
  const reused = await new Promise<boolean>((resolve) => {
    second.once("secureConnect", () => resolve(second.isSessionReused()));
    second.once("close", () => resolve(false));
  });
  if (reused) assert.ok(livePeerPin(second) === null, "a resumed session never yields a pin");
  await sleep(200);
  second.destroy();
  assert.deepEqual(r.accepted, ["mac"], "the relay paired nothing new");
  r.close();
});

test("dial failures are fixed phrases", async () => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  await assert.rejects(connectPinned(mac, relayPeer, "127.0.0.1", port), /^Error: refused$/);

  const mute = net.createServer(() => {}); // accepts TCP, never speaks TLS
  mute.listen(0, "127.0.0.1");
  await once(mute, "listening");
  await assert.rejects(connectPinned(mac, relayPeer, "127.0.0.1", (mute.address() as AddressInfo).port, 300), /^Error: timed out$/);
  mute.close();

  for (const [err, want] of [
    [{ code: "ECONNREFUSED" }, "refused"],
    [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "relay's pin didn't match"],
    [{ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }, "relay's pin didn't match"],
    [{ code: "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION" }, "TLS version refused"],
    [{ code: "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED" }, "rejected by the relay"],
    [{ message: "secret-ish details 192.0.2.1" }, "closed"],
    [null, "closed"],
  ] as const) assert.equal(dialFailure(err), want, JSON.stringify(err));
});

test("relayServerOptions refuses to build a listener with nobody paired", () => {
  assert.throws(() => relayServerOptions(relayId, []), /only while a host is paired/);
});

test("pins come from the certificate's key, not its bytes", () => {
  assert.ok(spkiPin(new crypto.X509Certificate(mac.certPem)) === mac.pin);
});
