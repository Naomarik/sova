// Run: pnpm exec tsx --test server/share-ws-hop.test.ts. The gateway's `/ws/h` hop lifecycle
// (server/share/ws-hop.ts): the page's handshake judged before any dial, cleanup on every path, the
// recheck when the upstream opens, revocation and disposal, and the gateway-wide budget. Ephemeral
// loopback ports, a throwaway PI_CODING_AGENT_DIR; ~/.pi untouched.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-ws-hop-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const edge = await import("./share/edge");
const { createWsHop, validHandshake, WS_HOPS_TOTAL } = await import("./share/ws-hop");
type WsHop = import("./share/ws-hop").WsHop;
type WsHopOptions = import("./share/ws-hop").WsHopOptions;

const TOKEN = "C".repeat(43);
const KEY = "node-1 " + "0".repeat(64);
const GOOD_KEY = Buffer.alloc(16, 7).toString("base64");

async function bound(server: Server): Promise<{ port: number; close: () => void }> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

const until = async (ok: () => boolean, ms = 3000, what = "condition"): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Mode = "accept" | "delay" | "open-then-destroy" | "greet" | { big: number } | { frames: readonly string[] };

/** A routed host's ingress stand-in. `sockets` counts its live upgraded TCP sockets. */
async function upstream(mode: { current: Mode }, delayMs = 300) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 << 20 });
  const live = new Set<Socket>();
  let upgrades = 0;
  const received: string[] = [];
  /** The host's side of each accepted hop, newest last: a test closes it as the origin would. */
  const hosts: WebSocket[] = [];
  const server = createServer((_q, r) => r.writeHead(404).end());
  server.on("upgrade", (req, socket: Socket, head) => {
    upgrades++;
    live.add(socket);
    socket.on("close", () => live.delete(socket));
    const m = mode.current;
    if (m === "open-then-destroy") {
      const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      setImmediate(() => socket.destroy());
      return;
    }
    const go = () =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        hosts.push(ws);
        ws.on("message", (d) => received.push(String(d)));
        // After the page is accepted at the gateway, so the cap ends a live hop.
        if (typeof m === "object" && "big" in m) setTimeout(() => ws.send("x".repeat(m.big)), 100);
        if (typeof m === "object" && "frames" in m) setTimeout(() => m.frames.forEach((f) => ws.send(f)), 100);
        if (m === "greet") ws.send("greeting");
      });
    if (m === "delay") setTimeout(go, delayMs);
    else go();
  });
  const b = await bound(server);
  return {
    port: b.port,
    live,
    received,
    hosts,
    get upgrades() {
      return upgrades;
    },
    close: () => {
      for (const s of live) s.destroy();
      b.close();
    },
  };
}

/** A gateway share server hopping every `/ws/h` to `port`; `authorized` and `key` per test. */
async function gateway(port: number, opts: WsHopOptions & { authorized?: () => boolean | Promise<boolean>; key?: () => string } = {}) {
  const hop: WsHop = createWsHop({ dialMs: 2000, ...opts });
  const s = await bound(
    edge.createShareServer({
      dispatch: (_q, res) => void res.writeHead(404).end(),
      upgrade: (req, socket, head, { url }) =>
        hop.forward(req, socket, head, opts.key?.() ?? KEY, { host: "127.0.0.1", port, path: `/ws/h${url.search}`, headers: {} }, opts.authorized ?? (() => true)),
    }),
  );
  return { hop, ...s };
}

/** A raw upgrade with exactly these headers; resolves with the status line's code (0: none) once
    the gateway answers or closes. `leave`: half-close right after sending. */
function rawUpgrade(port: number, headers: Record<string, string>, { leave = false, destroyAfterMs }: { leave?: boolean; destroyAfterMs?: number } = {}): Promise<number> {
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1");
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0));
    };
    sock.on("data", (d) => {
      data += d;
      if (data.includes("\r\n\r\n")) {
        finish();
        sock.destroy();
      }
    });
    sock.on("close", finish);
    sock.on("error", () => {});
    sock.on("connect", () => {
      const lines = [`GET /ws/h?token=${TOKEN} HTTP/1.1`, "Host: share.example.com", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      sock.write(lines.join("\r\n") + "\r\n\r\n");
      if (leave) sock.end();
      if (destroyAfterMs !== undefined) setTimeout(() => sock.destroy(), destroyAfterMs);
    });
  });
}

const VALID = { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": GOOD_KEY, "Sec-WebSocket-Version": "13" };

function openPage(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/h?token=${TOKEN}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_r, res) => reject(new Error(`status ${res.statusCode}`)));
  });
}
function wsStatus(port: number): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/h?token=${TOKEN}`);
    ws.on("unexpected-response", (_r, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("error", () => resolve(0));
  });
}
const closed = (ws: WebSocket): Promise<number> => new Promise((r) => ws.once("close", (c) => r(c)));

/** The hop is fully gone, and a later valid page still opens (the slots came back). */
async function recovers(gw: { hop: WsHop; port: number }, up: { live: Set<Socket> }, mode?: { current: Mode }): Promise<void> {
  await until(() => gw.hop.count(KEY) === 0, 3000, "slot released");
  await until(() => up.live.size === 0, 3000, "no upstream socket left");
  if (mode) mode.current = "accept";
  const ok = await openPage(gw.port);
  ok.close();
  await until(() => gw.hop.count(KEY) === 0 && up.live.size === 0);
}

// ---- B2: the page's handshake is judged before any dial; cleanup on every path -------------------

for (const [what, headers] of [
  ["an invalid key", { ...VALID, "Sec-WebSocket-Key": "invalid" }],
  ["a key of the wrong length", { ...VALID, "Sec-WebSocket-Key": Buffer.alloc(15).toString("base64") }],
  ["no key", { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13" }],
  ["version 8", { ...VALID, "Sec-WebSocket-Version": "8" }],
  ["no version", { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": GOOD_KEY }],
  ["a malformed subprotocol", { ...VALID, "Sec-WebSocket-Protocol": "a,,b" }],
  ["a duplicate subprotocol", { ...VALID, "Sec-WebSocket-Protocol": "a, a" }],
  ["a malformed extension", { ...VALID, "Sec-WebSocket-Extensions": "permessage-deflate; =1" }],
] as const) {
  test(`B2: ${what} is 400 and never dials; five in a row leave every slot free`, async () => {
    const mode = { current: "accept" as Mode };
    const up = await upstream(mode);
    const gw = await gateway(up.port);
    try {
      for (let i = 0; i < 5; i++) assert.equal(await rawUpgrade(gw.port, headers), 400, `attempt ${i + 1}`);
      assert.equal(up.upgrades, 0, "never dialed");
      await recovers(gw, up);
    } finally {
      gw.close();
      up.close();
    }
  });
}

test("B2: without Connection: upgrade it is no upgrade at all (Node dispatches it: 404), and nothing is dialed", async () => {
  const mode = { current: "accept" as Mode };
  const up = await upstream(mode);
  const gw = await gateway(up.port);
  try {
    for (let i = 0; i < 5; i++) assert.equal(await rawUpgrade(gw.port, { ...VALID, Connection: "keep-alive" }), 404);
    assert.equal(up.upgrades, 0);
    await recovers(gw, up);
  } finally {
    gw.close();
    up.close();
  }
});

test("B2: validHandshake refuses a Connection header without the upgrade token", () => {
  const req = { method: "GET", headers: { upgrade: "websocket", connection: "keep-alive", "sec-websocket-key": GOOD_KEY, "sec-websocket-version": "13" } };
  assert.equal(validHandshake(req as never), false);
  assert.equal(validHandshake({ ...req, headers: { ...req.headers, connection: "keep-alive, Upgrade" } } as never), true);
});

test("B2: well-formed subprotocols and extensions are accepted", async () => {
  const mode = { current: "accept" as Mode };
  const up = await upstream(mode);
  const gw = await gateway(up.port);
  try {
    // The page asked for a subprotocol the gateway doesn't pick: ws still completes the handshake.
    const code = await rawUpgrade(gw.port, { ...VALID, "Sec-WebSocket-Protocol": "a, b", "Sec-WebSocket-Extensions": 'permessage-deflate; client_max_window_bits, x-y; p="q"' });
    assert.equal(code, 101);
    await recovers(gw, up);
  } finally {
    gw.close();
    up.close();
  }
});

test("B2: a page that leaves during the dial releases its slot and the upstream", async () => {
  const mode = { current: "delay" as Mode };
  const up = await upstream(mode, 300);
  const gw = await gateway(up.port);
  try {
    for (let i = 0; i < 5; i++) await rawUpgrade(gw.port, VALID, { destroyAfterMs: 50 });
    await recovers(gw, up, mode);
  } finally {
    gw.close();
    up.close();
  }
});

test("B2: a page that half-closes before acceptance (handleUpgrade never calls back) releases everything", async () => {
  const mode = { current: "delay" as Mode };
  const up = await upstream(mode, 100);
  const gw = await gateway(up.port);
  try {
    for (let i = 0; i < 5; i++) await rawUpgrade(gw.port, VALID, { leave: true });
    await sleep(250);
    await recovers(gw, up, mode);
  } finally {
    gw.close();
    up.close();
  }
});

test("B2: an upstream that closes during setup releases the slot; the page gets 503 or 4503, never a hang", async () => {
  const mode = { current: "open-then-destroy" as Mode };
  const up = await upstream(mode);
  const gw = await gateway(up.port);
  try {
    for (let i = 0; i < 5; i++) {
      const status = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws/h?token=${TOKEN}`);
        ws.on("unexpected-response", (_r, res) => resolve(res.statusCode ?? 0));
        ws.on("close", (c) => resolve(c));
        ws.on("error", () => {});
      });
      assert.ok(status === 503 || status === 4503, `got ${status}`);
    }
    await recovers(gw, up, mode);
  } finally {
    gw.close();
    up.close();
  }
});

// ---- B1: the recheck, revocation, disposal ---------------------------------------------------------

test("B1: authorization withdrawn during the dial: the upstream is terminated and the page gets 404", async () => {
  const mode = { current: "delay" as Mode };
  const up = await upstream(mode, 150);
  let allowed = true;
  const gw = await gateway(up.port, { authorized: () => allowed });
  try {
    const pending = wsStatus(gw.port);
    await until(() => up.upgrades === 1);
    allowed = false;
    assert.equal(await pending, 404);
    assert.deepEqual(up.received, []);
    allowed = true;
    await recovers(gw, up, mode);
  } finally {
    gw.close();
    up.close();
  }
});

test("B1: closeWhere closes both ends, hops still dialing included", async () => {
  const mode = { current: "accept" as Mode };
  const up = await upstream(mode, 400);
  const gw = await gateway(up.port);
  try {
    const open = await openPage(gw.port);
    const openClosed = closed(open);
    mode.current = "delay";
    const dialing = wsStatus(gw.port);
    await until(() => up.upgrades === 2 && gw.hop.count(KEY) === 2);
    gw.hop.closeWhere((k) => k === KEY);
    assert.equal(await openClosed, 4503);
    assert.equal(await dialing, 503);
    await recovers(gw, up, mode);
  } finally {
    gw.close();
    up.close();
  }
});

test("drainWhere: the host's own close within the grace passes through (4410); the page's messages stop going up", async () => {
  const mode = { current: "accept" as Mode };
  const up = await upstream(mode);
  const gw = await gateway(up.port);
  try {
    const page = await openPage(gw.port);
    const got: string[] = [];
    page.on("message", (d) => got.push(String(d)));
    const pageClosed = closed(page);
    page.send("before");
    await until(() => up.received.includes("before"));
    gw.hop.drainWhere((k) => k === KEY, 2000);
    page.send("while draining");
    await sleep(100);
    assert.equal(page.readyState, WebSocket.OPEN, "not cut at once");
    up.hosts.at(-1)!.send('{"type":"error","code":"gone"}');
    up.hosts.at(-1)!.close(4410, "gone");
    assert.equal(await pageClosed, 4410);
    assert.deepEqual(got, ['{"type":"error","code":"gone"}'], "the host's last word reached the page");
    assert.ok(!up.received.includes("while draining"), "nothing from the page went up once draining");
    await recovers(gw, up, mode);
  } finally {
    gw.close();
    up.close();
  }
});

test("drainWhere: no close from the host within the grace is 4503; a second drain doesn't extend it; a dialing hop ends at once", async () => {
  const mode = { current: "accept" as Mode };
  const up = await upstream(mode, 400);
  const gw = await gateway(up.port);
  try {
    const page = await openPage(gw.port);
    const pageClosed = closed(page);
    mode.current = "delay";
    const dialing = wsStatus(gw.port);
    await until(() => up.upgrades === 2 && gw.hop.count(KEY) === 2);
    const t = Date.now();
    gw.hop.drainWhere((k) => k === KEY, 300);
    assert.equal(await dialing, 503);
    await sleep(200);
    gw.hop.drainWhere((k) => k === KEY, 5000);
    assert.equal(await pageClosed, 4503);
    const took = Date.now() - t;
    assert.ok(took >= 280 && took < 1500, `closed after the first grace: ${took} ms`);
    await recovers(gw, up, mode);
  } finally {
    gw.close();
    up.close();
  }
});

test("B1: dispose closes every hop (4503) and refuses later forwards with 503, never dialing", async () => {
  const mode = { current: "accept" as Mode };
  const up = await upstream(mode, 400);
  const gw = await gateway(up.port);
  try {
    const open = await openPage(gw.port);
    const openClosed = closed(open);
    mode.current = "delay";
    const dialing = wsStatus(gw.port);
    await until(() => up.upgrades === 2);
    gw.hop.dispose();
    assert.equal(await openClosed, 4503);
    assert.equal(await dialing, 503);
    await until(() => gw.hop.count(KEY) === 0 && up.live.size === 0);
    const before = up.upgrades;
    assert.equal(await wsStatus(gw.port), 503);
    assert.equal(up.upgrades, before, "no dial after dispose");
  } finally {
    gw.close();
    up.close();
  }
});

const later = <T>(ms: number, v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

test("B1: an async check that resolves false: 404, the upstream terminated, the slot freed, the held message never sent", async () => {
  const mode = { current: "greet" as Mode };
  const up = await upstream(mode);
  const gw = await gateway(up.port, { authorized: () => later(150, false) });
  try {
    const got: string[] = [];
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws/h?token=${TOKEN}`);
      ws.on("message", (d) => got.push(String(d)));
      ws.on("unexpected-response", (_r, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve(101));
      ws.on("error", () => resolve(0));
    });
    assert.equal(status, 404);
    assert.deepEqual(got, []);
    await until(() => gw.hop.count(KEY) === 0 && up.live.size === 0);
  } finally {
    gw.close();
    up.close();
  }
});

test("B1: control: an async check that resolves true accepts the page, and the message held meanwhile arrives", async () => {
  const mode = { current: "greet" as Mode };
  const up = await upstream(mode);
  const gw = await gateway(up.port, { authorized: () => later(150, true) });
  try {
    const first = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws/h?token=${TOKEN}`);
      ws.once("message", (d) => {
        resolve(String(d));
        ws.close();
      });
      ws.on("unexpected-response", (_r, res) => reject(new Error(`status ${res.statusCode}`)));
    });
    assert.equal(first, "greeting");
    await until(() => gw.hop.count(KEY) === 0 && up.live.size === 0);
  } finally {
    gw.close();
    up.close();
  }
});

test("B1: a rejecting async check is a refusal; a late true after dispose or the page leaving never upgrades", async () => {
  const mode = { current: "greet" as Mode };
  const up = await upstream(mode);
  let check: () => Promise<boolean> = () => Promise.reject(new Error("lookup failed"));
  const gw = await gateway(up.port, { authorized: () => check() });
  try {
    assert.equal(await wsStatus(gw.port), 404);
    await until(() => gw.hop.count(KEY) === 0 && up.live.size === 0);

    // The page leaves while the check is pending.
    check = () => later(200, true);
    await rawUpgrade(gw.port, VALID, { destroyAfterMs: 60 });
    await sleep(300);
    await until(() => gw.hop.count(KEY) === 0 && up.live.size === 0, 3000, "left during the check");

    // dispose() while the check is pending: 503, and the late true changes nothing.
    const pending = wsStatus(gw.port);
    await until(() => up.upgrades === 3 && up.live.size === 1);
    await sleep(30);
    gw.hop.dispose();
    assert.equal(await pending, 503);
    await sleep(250);
    assert.equal(gw.hop.count(KEY), 0);
    assert.equal(up.live.size, 0);
  } finally {
    gw.close();
    up.close();
  }
});

// ---- N4: budgets ---------------------------------------------------------------------------------

test("N4: a gateway-wide budget on open hops; one more is 503 and never dialed", async () => {
  assert.ok(WS_HOPS_TOTAL >= 64);
  const mode = { current: "accept" as Mode };
  const up = await upstream(mode);
  let n = 0;
  const gw = await gateway(up.port, { total: 2, key: () => `node-1 ${String(n++).padStart(64, "0")}` });
  try {
    const a = await openPage(gw.port);
    const b = await openPage(gw.port);
    const before = up.upgrades;
    assert.equal(await wsStatus(gw.port), 503);
    assert.equal(up.upgrades, before);
    a.close();
    b.close();
  } finally {
    gw.close();
    up.close();
  }
});

test("N4: the upstream client has its own message cap; a message over it ends the hop with 4503", async () => {
  const mode = { current: { big: 4096 } as Mode };
  const up = await upstream(mode);
  const gw = await gateway(up.port, { upstreamMaxPayload: 2048 });
  try {
    const page = await openPage(gw.port);
    assert.equal(await closed(page), 4503);
    await recovers(gw, up, mode);
  } finally {
    gw.close();
    up.close();
  }
});

// ---- the harness wire (§app.harness/wire, "Hops change nothing") ----------------------------------

test("wire: v1- and wire-2-shaped frames from the origin reach the page byte for byte, whether or not the page asked for wire=2", async () => {
  // Every recorded faux stream's v1 control frames and pinned wire-2 frames (server/harness/pi/golden/wire).
  const wire = join(import.meta.dirname, "harness/pi/golden/wire");
  const read = (dir: string) => readdirSync(join(wire, dir)).sort().flatMap((s) => JSON.parse(readFileSync(join(wire, dir, s, "frames.json"), "utf8")) as string[]);
  const frames = [...read("expected/faux"), ...read("v2/faux")];
  assert.ok(frames.some((f) => f.includes('"v":2')) && frames.some((f) => f.includes('"type":"message_update"')), "both shapes are sent");
  const up = await upstream({ current: { frames } });
  let search = "";
  const hop: WsHop = createWsHop({ dialMs: 2000 });
  const gw = await bound(
    edge.createShareServer({
      dispatch: (_q, res) => void res.writeHead(404).end(),
      upgrade: (req, socket, head, { url }) => {
        search = url.search;
        hop.forward(req, socket, head, KEY, { host: "127.0.0.1", port: up.port, path: `/ws/h${url.search}`, headers: {} }, () => true);
      },
    }),
  );
  try {
    for (const ask of ["", "&wire=2"]) {
      const got: string[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws/h?token=${TOKEN}${ask}`);
      ws.on("message", (d, isBinary) => got.push(isBinary ? "<binary>" : String(d)));
      await until(() => got.length >= frames.length, 5000, `${frames.length} frames${ask}`);
      ws.close();
      assert.equal(search, `?token=${TOKEN}${ask}`, "the gateway hands the hop the query as the page sent it");
      const i = got.findIndex((f, k) => f !== frames[k]);
      assert.equal(i, -1, `frame ${i}${ask} differs: ${got[i]?.slice(0, 120)}`);
      assert.equal(got.length, frames.length);
      await until(() => hop.count(KEY) === 0, 3000, "slot released");
    }
  } finally {
    hop.dispose();
    gw.close();
    up.close();
  }
});
