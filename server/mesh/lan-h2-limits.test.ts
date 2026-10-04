// Run: pnpm test -- server/mesh/lan-h2-limits.test.ts   (Bun)
//      pnpm run test:node -- server/mesh/lan-h2-limits.test.ts   (Node)
// The reverse channel's HTTP/2 caps against a hostile peer writing raw frames (§mesh.lan/reverse-channel),
// on whichever runtime runs the suite: Bun has its own HTTP/2, Node has nghttp2, and they enforce
// differently (Bun closes the session on an oversized header list or SETTINGS frame; Node lets the
// header list through and ignores the SETTINGS frame), so what is asserted is the outcome both must
// give. Plus the deadlines of the in-process HTTP server streams are fed to, which never listens.
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { connectReverse, feedStream, headerListSize, MAX_HEADER_LIST, serveReverse } from "./lan-reverse";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- raw HTTP/2 frames ------------------------------------------------------------------------
const frame = (type: number, flags: number, stream: number, payload: Buffer) => {
  const h = Buffer.alloc(9);
  h.writeUIntBE(payload.length, 0, 3);
  h[3] = type;
  h[4] = flags;
  h.writeUInt32BE(stream, 5);
  return Buffer.concat([h, payload]);
};
const int7 = (n: number) => {
  if (n < 127) return Buffer.from([n]);
  const out = [127];
  let r = n - 127;
  while (r >= 128) {
    out.push((r & 0x7f) | 0x80);
    r >>= 7;
  }
  out.push(r);
  return Buffer.from(out);
};
const str = (s: string) => Buffer.concat([int7(Buffer.byteLength(s)), Buffer.from(s)]);
/** A literal header field without indexing, new name (RFC 7541 §6.2.2). */
const lit = (name: string, value: string) => Buffer.concat([Buffer.from([0]), str(name), str(value)]);
const PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
const SETTINGS = (entries: Array<[number, number]>) => {
  const b = Buffer.alloc(entries.length * 6);
  entries.forEach(([id, v], i) => {
    b.writeUInt16BE(id, i * 6);
    b.writeUInt32BE(v, i * 6 + 2);
  });
  return frame(4, 0, 0, b);
};
/** :method CONNECT and :authority by static-table name (RFC 7541 appendix A: 2 and 1). */
const CONNECT_HEAD = Buffer.concat([Buffer.from([0x02]), str("CONNECT"), Buffer.from([0x01]), str("lan-peer")]);
/** A header block as HEADERS plus CONTINUATION frames of at most 16,000 bytes. */
const headerFrames = (stream: number, block: Buffer, endStream = false): Buffer[] => {
  const chunks: Buffer[] = [];
  for (let i = 0; i < block.length; i += 16_000) chunks.push(block.subarray(i, i + 16_000));
  return chunks.map((c, i) => frame(i === 0 ? 1 : 9, (i === chunks.length - 1 ? 0x4 : 0) | (i === 0 && endStream ? 0x1 : 0), stream, c));
};
const bigHeaders = (kib: number) => Array.from({ length: Math.ceil(kib / 10) }, (_, i) => lit(`x-big-${i}`, "a".repeat(10 * 1024)));

/** A raw TCP pair: `server` gets the accepted socket; the returned socket is the attacker's. */
async function rawPair(server: (s: Socket) => void): Promise<{ attacker: Socket; done: () => void }> {
  const srv = net.createServer((s) => {
    s.on("error", () => {});
    server(s);
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const attacker = net.connect((srv.address() as AddressInfo).port, "127.0.0.1");
  attacker.on("error", () => {});
  await once(attacker, "connect");
  return { attacker, done: () => (attacker.destroy(), srv.close()) };
}

/** The dial-out host's answering session under attack by a hostile asking peer. */
async function answering(write: (w: (b: Buffer) => void) => void, waitMs = 800) {
  let streams = 0;
  let session: ReturnType<typeof serveReverse>["session"] | null = null;
  let closed = false;
  const { attacker, done } = await rawPair((s) => {
    const r = serveReverse(s, (d) => {
      streams++;
      d.destroy();
    });
    session = r.session;
    void r.closed.then(() => (closed = true));
  });
  attacker.pause(); // never reads: a peer that floods
  attacker.write(PREFACE);
  attacker.write(SETTINGS([]));
  write((b) => attacker.write(b));
  await sleep(waitMs);
  const out = { streams, closed, remote: (session as unknown as { remoteSettings?: { initialWindowSize?: number } } | null)?.remoteSettings };
  done();
  return out;
}

test("baseline: one well-formed CONNECT reaches the server", async () => {
  assert.equal((await answering((w) => w(frame(1, 0x4, 1, CONNECT_HEAD)))).streams, 1);
});

test("a request with more than 128 header pairs never reaches the server", async () => {
  const r = await answering((w) => w(frame(1, 0x4, 1, Buffer.concat([CONNECT_HEAD, ...Array.from({ length: 200 }, (_, i) => lit(`x-${i}`, "v"))]))));
  assert.equal(r.streams, 0);
});

test("a header list over 64 KiB never reaches the server (Node lets it through; Sova checks it)", async () => {
  const r = await answering((w) => headerFrames(1, Buffer.concat([CONNECT_HEAD, ...bigHeaders(100)])).forEach(w));
  assert.equal(r.streams, 0);
  // Under the cap, the same shape passes: the check is the size, not the CONTINUATION frames.
  const ok = await answering((w) => headerFrames(1, Buffer.concat([CONNECT_HEAD, ...bigHeaders(30)])).forEach(w));
  assert.equal(ok.streams, 1);
});

test("a SETTINGS frame with more than 32 entries is never applied", async () => {
  const r = await answering((w) => w(SETTINGS(Array.from({ length: 40 }, (_, i) => [4, 1000 + i] as [number, number]))));
  // Bun closes the session; Node drops the frame. Either way its values never take effect.
  assert.ok(r.closed || r.remote?.initialWindowSize !== 1039, JSON.stringify(r));
  const fine = await answering((w) => w(SETTINGS(Array.from({ length: 32 }, (_, i) => [4, 1000 + i] as [number, number]))));
  assert.equal(fine.remote?.initialWindowSize, 1031, "32 entries are taken: the limit is the count");
});

test("a SETTINGS flood from a peer that never reads closes the session", async () => {
  const f = SETTINGS([[3, 100]]);
  const r = await answering((w) => w(Buffer.concat(Array.from({ length: 200_000 }, () => f))), 2000);
  assert.equal(r.closed, true);
  assert.equal(r.streams, 0);
});

test("the relay's asking session: a hostile answering peer's oversized response headers fail the stream", async () => {
  // The relay is the h2 client here. A hostile answering peer: accept the relay's connection and
  // answer its first stream with 100 KiB of response headers.
  const srv = net.createServer((s) => {
    s.on("error", () => {});
    let buf = Buffer.alloc(0);
    s.write(SETTINGS([]));
    s.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      // Once the client's first HEADERS (stream 1) arrived, answer it.
      if (buf.includes(Buffer.from([0x01, 0x05, 0x00, 0x00, 0x00, 0x01])) || buf.includes(Buffer.from([0x01, 0x04, 0x00, 0x00, 0x00, 0x01]))) {
        if ((s as Socket & { answered?: boolean }).answered) return;
        (s as Socket & { answered?: boolean }).answered = true;
        s.write(frame(4, 0x1, 0, Buffer.alloc(0))); // ACK its SETTINGS
        headerFrames(1, Buffer.concat([Buffer.from([0x88]), ...bigHeaders(100)])).forEach((b) => s.write(b)); // :status 200 (static 8)
      }
    });
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const sock = net.connect((srv.address() as AddressInfo).port, "127.0.0.1");
  sock.on("error", () => {});
  await once(sock, "connect");
  const client = await connectReverse(sock, {}, 3000);
  try {
    const got = await client.openStream(3000).then((d) => (d.destroy(), "handed on"), (e: Error) => e.message);
    assert.match(got, /refused|closed/);
  } finally {
    client.close();
    srv.close();
  }
});

test("headerListSize counts as RFC 9113 does", () => {
  assert.equal(headerListSize({ a: "b" }), 34);
  assert.equal(headerListSize({ a: ["b", "cd"] }), 34 + 35);
  assert.equal(MAX_HEADER_LIST, 64 * 1024);
});

// ---- the in-process server's deadlines --------------------------------------------------------

/** A stream as feedStream gets one: a Duplex with no address and no socket timeouts. */
function fakeStream() {
  const out: Buffer[] = [];
  const d = new Duplex({
    read() {},
    write(c, _e, cb) {
      out.push(Buffer.from(c));
      cb();
    },
  });
  Object.assign(d, { remoteAddress: undefined, setTimeout: () => d, setNoDelay: () => d, setKeepAlive: () => d, ref: () => d, unref: () => d });
  return { d, said: () => Buffer.concat(out).toString() };
}

function innerServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/body") {
      req.on("data", () => {});
      req.on("end", () => res.end("got it"));
      return;
    }
    res.end("hi");
  });
  server.on("upgrade", () => {}); // holds the socket, as the WebSocket server does
  return server;
}
const T = { headerMs: 150, requestMs: 300, idleMs: 200 };

test("deadline: a request head that never completes is cut", async () => {
  const s = fakeStream();
  feedStream(innerServer(), s.d, T);
  s.d.push("GET / HTTP/1.1\r\nHost: x\r\n"); // no blank line, ever
  await sleep(100);
  assert.equal(s.d.destroyed, false);
  await sleep(150);
  assert.equal(s.d.destroyed, true);
});

test("deadline: a request is answered; an idle kept-alive stream is then cut", async () => {
  const s = fakeStream();
  feedStream(innerServer(), s.d, T);
  s.d.push("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
  await sleep(50);
  assert.match(s.said(), /200 OK[\s\S]*hi/);
  await sleep(100);
  assert.equal(s.d.destroyed, false, "inside the idle time");
  s.d.push("GET / HTTP/1.1\r\nHost: x\r\n\r\n"); // a second request in time
  await sleep(150);
  assert.equal(s.d.destroyed, false);
  assert.equal(s.said().match(/200 OK/g)?.length, 2);
  await sleep(150);
  assert.equal(s.d.destroyed, true, "idle past the deadline");
});

test("deadline: a request body that trickles is cut", async () => {
  const s = fakeStream();
  feedStream(innerServer(), s.d, T);
  s.d.push("POST /body HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nab");
  await sleep(200);
  assert.equal(s.d.destroyed, false, "past the head deadline: the head arrived");
  await sleep(200);
  assert.equal(s.d.destroyed, true);
});

test("deadline: an upgraded stream lives on", async () => {
  const s = fakeStream();
  feedStream(innerServer(), s.d, T);
  s.d.push("GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  await sleep(500);
  assert.equal(s.d.destroyed, false);
  s.d.destroy();
});
