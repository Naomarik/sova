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
import { ALPN_ANSWER, ALPN_ASK, type Channel, connectPinned, dialFailure, dialOptions, livePeerPin, pairedPeerOf, relayServerOptions } from "./lan-tls";

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

test("resumption: a connection offering an earlier session is never a resumed, paired one", async () => {
  const r = await relay(relayId, [macPeer]);
  let session: Buffer | undefined;
  const first = tls.connect(dialOptions(mac, "127.0.0.1", r.port, "answer"));
  first.on("session", (s: Buffer) => {
    session = s;
  });
  first.on("error", () => {});
  await once(first, "secureConnect");
  first.resume();
  await sleep(200);
  first.destroy();
  assert.deepEqual(r.accepted, ["dialer/answer"]);
  if (session) {
    const second = tls.connect({ ...dialOptions(mac, "127.0.0.1", r.port, "answer"), session, key: undefined, cert: undefined });
    second.on("error", () => {});
    const reused = await new Promise<boolean>((resolve) => {
      second.once("secureConnect", () => resolve(second.isSessionReused()));
      second.once("close", () => resolve(false));
    });
    if (reused) assert.ok(livePeerPin(second) === null, "a resumed session never yields a pin");
    await sleep(200);
    second.destroy();
  }
  assert.deepEqual(r.accepted, ["dialer/answer"], "the relay paired nothing new");
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

test("pins come from the certificate's key", () => {
  assert.ok(spkiPin(new crypto.X509Certificate(mac.certPem)) === mac.pin);
});
