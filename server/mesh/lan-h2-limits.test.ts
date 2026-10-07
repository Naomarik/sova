// Run: pnpm test -- server/mesh/lan-h2-limits.test.ts
// The reverse channel's limits that need no socket (§mesh.lan/reverse-channel): the header list size
// as RFC 9113 counts it, and the deadlines of the in-process HTTP server streams are fed to (which
// never listens), stepped on test timers: which deadline is armed when, and that it cuts the stream.
// Hostile raw frames over real sockets, and one deadline on real timers: lan-h2-limits.integration.test.ts.
import assert from "node:assert/strict";
import http from "node:http";
import { Duplex } from "node:stream";
import { test } from "node:test";
import { type DeadlineTimers, feedStream, headerListSize, MAX_HEADER_LIST } from "./lan-reverse";

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

/** Test timers: at most one deadline is armed per stream; `armed` is its length, `fire` runs it. */
function steppedTimers() {
  let next: { fire: () => void; ms: number } | null = null;
  const timers: DeadlineTimers = {
    set: (fire, ms) => (next = { fire, ms }),
    clear: (h) => {
      if (h === next) next = null;
    },
  };
  return {
    timers,
    armed: () => next?.ms ?? null,
    fire: () => {
      const n = next;
      next = null;
      n?.fire();
    },
  };
}

const T = { headerMs: 150, requestMs: 300, idleMs: 200 };
/** The server's parse and response run on the event loop: wait for what it wrote, not a time. */
async function until(what: string, ok: () => boolean): Promise<void> {
  const end = Date.now() + 15_000;
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}

test("deadline: a request head that never completes is cut", async () => {
  const s = fakeStream();
  const t = steppedTimers();
  feedStream(innerServer(), s.d, { ...T, timers: t.timers });
  s.d.push("GET / HTTP/1.1\r\nHost: x\r\n"); // no blank line, ever
  await new Promise((r) => setImmediate(r));
  assert.equal(s.d.destroyed, false);
  assert.equal(t.armed(), T.headerMs, "the head deadline is what runs");
  t.fire();
  assert.equal(s.d.destroyed, true);
});

test("deadline: a request is answered; an idle kept-alive stream is then cut", async () => {
  const s = fakeStream();
  const t = steppedTimers();
  feedStream(innerServer(), s.d, { ...T, timers: t.timers });
  s.d.push("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
  await until("the first answer", () => /200 OK[\s\S]*hi/.test(s.said()));
  await until("the idle deadline", () => t.armed() === T.idleMs);
  assert.equal(s.d.destroyed, false, "inside the idle time");
  s.d.push("GET / HTTP/1.1\r\nHost: x\r\n\r\n"); // a second request in time
  await until("the second answer", () => s.said().match(/200 OK/g)?.length === 2);
  await until("the idle deadline again", () => t.armed() === T.idleMs);
  assert.equal(s.d.destroyed, false);
  t.fire();
  assert.equal(s.d.destroyed, true, "idle past the deadline");
});

test("deadline: a request body that trickles is cut", async () => {
  const s = fakeStream();
  const t = steppedTimers();
  feedStream(innerServer(), s.d, { ...T, timers: t.timers });
  s.d.push("POST /body HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nab");
  await until("the body deadline", () => t.armed() === T.requestMs);
  assert.equal(s.d.destroyed, false, "the head arrived: its deadline no longer runs");
  t.fire();
  assert.equal(s.d.destroyed, true);
});

test("deadline: an upgraded stream lives on", async () => {
  const s = fakeStream();
  const t = steppedTimers();
  const server = innerServer();
  let upgraded = false;
  server.on("upgrade", () => (upgraded = true));
  feedStream(server, s.d, { ...T, timers: t.timers });
  s.d.push("GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  await until("the upgrade", () => upgraded);
  assert.equal(t.armed(), null, "no deadline left on it");
  assert.equal(s.d.destroyed, false);
  s.d.destroy();
});
