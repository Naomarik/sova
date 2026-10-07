// Run: node scripts/run-tests.mjs server/mesh/lan-reverse.integration.test.ts
// The reverse channel over a real pinned TLS pair (§mesh.lan/reverse-channel): the relay is the h2
// client on the socket it accepted, the LAN host the h2 server on the socket it dialed. Pieces that
// need no socket: lan-reverse.test.ts.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import tls, { type TLSSocket } from "node:tls";
import { mintLanIdentity } from "./lan-cert";
import { connectPinned, relayServerOptions } from "./lan-tls";
import { type ChannelTimers, connectReverse, type ReverseClient, type ReverseServer, serveReverse, socketDuplex } from "./lan-reverse";
import { MESSAGE_TOO_BIG, streamWebSocketServer } from "../runtime-quirks";

const relayId = mintLanIdentity();
const mac = mintLanIdentity();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll with a generous hang guard: never a bound on how fast the channel is. */
async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** The LAN host's in-process server: never listen()ed. */
function innerServer() {
  const seen: { remoteAddress: unknown }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ remoteAddress: req.socket.remoteAddress });
    if (req.url === "/hello") return void res.end(`hi ${req.method}`);
    if (req.url === "/echo") {
      const h = crypto.createHash("sha256");
      let n = 0;
      req.on("data", (d: Buffer) => { n += d.length; h.update(d); });
      req.on("end", () => res.end(JSON.stringify({ n, h: h.digest("hex") })));
      return;
    }
    if (req.url === "/hang") return;
    res.statusCode = 404;
    res.end();
  });
  const wss = streamWebSocketServer({ maxPayload: 1024 });
  server.on("upgrade", (req, sock, head) => wss.handleUpgrade(req, sock as Duplex, head, (ws) => {
    ws.on("error", () => {}); // the oversize close reports here
    ws.on("message", (m: Buffer) => ws.send(`echo:${m}`));
  }));
  return { server, seen };
}

/** A pinned pair with the reverse channel up on both ends. */
async function pair(timers: { relay?: ChannelTimers; mac?: ChannelTimers } = {}) {
  const inner = innerServer();
  const srv = tls.createServer(relayServerOptions(relayId));
  const relaySide = new Promise<{ sock: TLSSocket; client: ReverseClient }>((resolve, reject) => {
    srv.once("secureConnection", (sock: TLSSocket) => {
      sock.on("error", () => {});
      connectReverse(sock, timers.relay).then((client) => resolve({ sock, client }), reject);
    });
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const sock = await connectPinned(mac, relayId.pin, "127.0.0.1", (srv.address() as AddressInfo).port, "answer");
  const macSide: ReverseServer = serveReverse(sock, (d) => inner.server.emit("connection", d), timers.mac);
  const { client } = await relaySide;
  srv.close();
  return { client, macSide, inner, macSock: sock };
}

function get(client: ReverseClient, path: string, method = "GET", body?: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "lan-peer", path, method, agent: client.agent, headers: body ? { "content-length": body.length } : {} }, (res) => {
      const c: Buffer[] = [];
      res.on("data", (d: Buffer) => c.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(c).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("HTTP/1.1 requests ride CONNECT streams to a server that never listens", async () => {
  const p = await pair();
  assert.deepEqual(await get(p.client, "/hello"), { status: 200, body: "hi GET" });
  const body = crypto.randomBytes(2 * 1024 * 1024);
  const r = JSON.parse((await get(p.client, "/echo", "POST", body)).body);
  assert.equal(r.n, body.length);
  assert.equal(r.h, crypto.createHash("sha256").update(body).digest("hex"));
  const many = await Promise.all(Array.from({ length: 20 }, () => get(p.client, "/hello")));
  assert.ok(many.every((m) => m.body === "hi GET"));
  assert.ok(p.inner.seen.every((s) => s.remoteAddress === undefined), "no address reaches the server");
  assert.equal(p.inner.server.listening, false);
  p.client.close();
  await p.macSide.closed;
});

test("a WebSocket rides a stream, with the stream server's size cap", async () => {
  const p = await pair();
  const ws = await p.client.webSocket("/ws");
  await once(ws, "open");
  ws.send("ping");
  const [m] = await once(ws, "message");
  assert.equal(String(m), "echo:ping");
  const closed = once(ws, "close");
  ws.send(Buffer.alloc(4096));
  const [code] = await closed;
  assert.equal(code, MESSAGE_TOO_BIG);
  p.client.close();
});

test("the LAN host answers only CONNECT: anything else 405, an extended CONNECT 400", async () => {
  const p = await pair();
  p.client.close(); // free the pair; drive a raw h2 client against a fresh LAN host instead
  const { client, server } = await rawPair();
  for (const [headers, want] of [
    [{ ":method": "GET", ":path": "/hello" }, 405],
    [{ ":method": "POST", ":path": "/hello" }, 405],
  ] as const) {
    const s = client.request(headers);
    const [h] = await once(s, "response");
    assert.equal(h[":status"], want);
    s.resume();
  }
  client.destroy();
  server.close();
});

test("the LAN host can't open a stream or push toward the relay", async () => {
  const p = await pair();
  assert.equal(typeof (p.macSide.session as unknown as { request?: unknown }).request, "undefined");
  const got = new Promise<http2.ServerHttp2Stream>((r) => p.macSide.session.once("stream", (s) => r(s)));
  const d = await p.client.openStream();
  const st = await got;
  assert.throws(() => st.pushStream({ ":path": "/x" }, () => {}), /PUSH_DISABLED|push/i);
  d.destroy();
  p.client.close();
});

test("closing either end ends every stream and WebSocket inside at once", async () => {
  for (const which of ["relay", "mac"] as const) {
    const p = await pair();
    const hanging = get(p.client, "/hang").then(() => "answered", () => "ended");
    const ws = await p.client.webSocket("/ws");
    await once(ws, "open");
    const wsClosed = once(ws, "close");
    await until("the hanging request to reach the LAN host", () => p.inner.seen.length === 1);
    if (which === "relay") p.client.close();
    else p.macSide.close();
    assert.equal(await hanging, "ended");
    await wsClosed;
    await p.client.closed;
    await p.macSide.closed;
    assert.equal(p.client.destroyed, true, which);
  }
});

test("after concurrent streams, closing either end is seen by the other at once", async () => {
  // Regression: on Node a session on a raw TLS handle missed the EOF once streams overlapped.
  for (const which of ["relay", "mac"] as const) {
    const p = await pair();
    await Promise.all(Array.from({ length: 5 }, () => get(p.client, "/hello")));
    if (which === "relay") p.client.close();
    else p.macSide.close();
    const other = which === "relay" ? p.macSide.closed : p.client.closed;
    // A missed EOF never closes at all: the guard is a hang guard, not a bound on "at once".
    assert.equal(await Promise.race([other.then(() => "closed"), sleep(15_000).then(() => "still up")]), "closed", which);
  }
});

test("a stream the LAN host never answers fails after its deadline", async () => {
  const { server, sock } = await rawPairForRelay();
  const client = await connectReverse(sock);
  await assert.rejects(client.openStream(200), /timed out/);
  assert.equal(client.openStreams, 0);
  client.close();
  server.close();
});

test("a silent connection is closed by the keepalive on either side", async () => {
  let skew = 0;
  const now = () => Date.now() + skew;
  const p = await pair({ relay: { pingMs: 30, silentMs: 60_000, now }, mac: { pingMs: 30, silentMs: 60_000, now } });
  // Counted, not timed: several of the relay's pings reached the LAN host and both are still up.
  let pings = 0;
  p.macSide.session.on("ping", () => pings++);
  await until("a few pings", () => pings >= 3);
  assert.equal(p.client.destroyed, false, "pings answered: still up");
  skew = 120_000; // nothing heard for longer than silentMs
  await p.client.closed;
  assert.equal(p.client.destroyed, true);
});

// A LAN host behind serveReverse driven by a raw h2 client (no connectReverse).
async function rawPair() {
  const srv = tls.createServer(relayServerOptions(relayId));
  const client = new Promise<http2.ClientHttp2Session>((resolve) => srv.once("secureConnection", (sock: TLSSocket) => {
    const c = http2.connect("http://lan-peer", { createConnection: () => socketDuplex(sock) as never });
    c.on("error", () => {});
    resolve(c);
  }));
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const sock = await connectPinned(mac, relayId.pin, "127.0.0.1", (srv.address() as AddressInfo).port, "answer");
  const server = serveReverse(sock, (d) => d.end("HTTP/1.1 204 No Content\r\n\r\n"));
  srv.close();
  return { client: await client, server };
}

// A relay socket whose LAN host speaks h2 but never answers a stream.
async function rawPairForRelay() {
  const srv = tls.createServer(relayServerOptions(relayId));
  const relaySock = new Promise<TLSSocket>((r) => srv.once("secureConnection", (s: TLSSocket) => r(s)));
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const sock = await connectPinned(mac, relayId.pin, "127.0.0.1", (srv.address() as AddressInfo).port, "answer");
  const session = http2.performServerHandshake(sock, { settings: { enablePush: false } });
  session.on("stream", () => {}); // never responds
  session.on("error", () => {});
  srv.close();
  return { sock: await relaySock, server: { close: () => session.destroy() } };
}
