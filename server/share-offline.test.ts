// Run: pnpm exec tsx --test server/share-offline.test.ts. A gateway's offline answers and its `/ws/h`
// hop (server/share/offline.ts, ws-hop.ts), and the hello's gateway advertisement, on ephemeral
// loopback ports with a throwaway PI_CODING_AGENT_DIR; ~/.pi untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-offline-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const edge = await import("./share/edge");
const offline = await import("./share/offline");
const { createWsHop } = await import("./share/ws-hop");
const hello = await import("./mesh/hello");
const { PAGE_CSP } = await import("./share/routes");
const contract = await import("../shared/public-links");

const TOKEN = "B".repeat(43);
const HASH = "0".repeat(64);

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

function get(port: number, path: string, method = "GET", body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {} }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function wsStatus(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    ws.on("open", () => {
      ws.close();
      resolve({ status: 101, body: "" });
    });
    ws.on("error", () => resolve({ status: 0, body: "" }));
  });
}

const until = async (ok: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ---- offline.ts -----------------------------------------------------------------------------------

test("offlineKind picks the answer by route family", () => {
  assert.equal(offline.offlineKind(`/h/${TOKEN}`), "page");
  assert.equal(offline.offlineKind(`/i/${TOKEN}`), "page");
  assert.equal(offline.offlineKind(`/api/h/${TOKEN}`), "api");
  assert.equal(offline.offlineKind(`/api/h/${TOKEN}/message`), "api");
  assert.equal(offline.offlineKind(`/api/i/${TOKEN}/p/q_abcdefgh`), "api");
  assert.equal(offline.offlineKind("/h/assets/index-abc.js"), "asset");
});

test("the offline answers match the contract: shell, JSON (POST included, body dropped), asset", async () => {
  const s = await bound(
    edge.createShareServer({
      dispatch: (req, res, { url }) => offline.offlineResponse(res, offline.offlineKind(url.pathname)),
      upgrade: (_req, socket) => offline.offlineUpgrade(socket),
    }),
  );
  try {
    const page = await get(s.port, `/h/${TOKEN}`);
    assert.equal(page.status, 503);
    assert.equal(page.headers["retry-after"], "60");
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["content-security-policy"], PAGE_CSP);
    assert.match(String(page.headers["content-type"]), /^text\/html/);
    assert.equal(page.body, offline.OFFLINE_HTML);
    for (const text of Object.values(contract.OFFLINE_PAGE)) assert.ok(page.body.includes(text), text);
    assert.ok(!page.body.includes(TOKEN) && !page.body.includes("<script"), "no token, no script");

    const owner = await get(s.port, `/i/${TOKEN}`);
    assert.equal(owner.status, 503);
    assert.equal(owner.body, offline.OFFLINE_HTML);

    for (const [path, method, body] of [
      [`/api/h/${TOKEN}`, "GET", undefined],
      [`/api/i/${TOKEN}`, "GET", undefined],
      [`/api/h/${TOKEN}/message`, "POST", JSON.stringify({ text: "hello" })],
    ] as const) {
      const r = await get(s.port, path, method, body);
      assert.equal(r.status, 503, path);
      assert.equal(r.headers["retry-after"], "60");
      assert.equal(r.headers["cache-control"], "no-store");
      assert.match(String(r.headers["content-type"]), /^application\/json/);
      assert.deepEqual(JSON.parse(r.body), { error: "offline", retryAfter: 60 });
    }

    const asset = await get(s.port, "/h/assets/index-abc.js");
    assert.equal(asset.status, 503);
    assert.equal(asset.headers["retry-after"], "60");

    const ws = await wsStatus(`ws://127.0.0.1:${s.port}/ws/h?token=${TOKEN}`);
    assert.equal(ws.status, 503);
    assert.deepEqual(JSON.parse(ws.body), { error: "offline", retryAfter: 60 });
  } finally {
    s.close();
  }
});

test("offlineResponse after the headers went out destroys the response instead of passing a partial one off", async () => {
  const s = await bound(
    createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("partial");
      offline.offlineResponse(res, "api");
    }),
  );
  try {
    await assert.rejects(get(s.port, "/"));
  } finally {
    s.close();
  }
});

// ---- ws-hop.ts --------------------------------------------------------------------------------------

interface Upstream {
  port: number;
  wss: WebSocketServer;
  received: Buffer[];
  upgrades: number;
  headers: Record<string, string | string[] | undefined>[];
  close: () => void;
}

/** A stand-in for a routed host's ingress: its own `/ws/h`, or an HTTP status for the upgrade. */
async function upstream(answer: number | { status: number; headers?: Record<string, string> } = 101): Promise<Upstream> {
  const received: Buffer[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((_req, res) => res.writeHead(404).end());
  const up: Upstream = { port: 0, wss, received, upgrades: 0, headers, close: () => {} };
  server.on("upgrade", (req, socket, head) => {
    up.upgrades++;
    headers.push(req.headers);
    const a = typeof answer === "number" ? { status: answer } : answer;
    if (a.status !== 101) {
      const extra = Object.entries(a.headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      socket.end(`HTTP/1.1 ${a.status} X\r\n${extra}Content-Length: 2\r\nConnection: close\r\n\r\n{}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (d: Buffer) => received.push(Buffer.from(d)));
      wss.emit("connection", ws);
    });
  });
  const b = await bound(server);
  up.port = b.port;
  up.close = () => {
    for (const c of wss.clients) c.terminate();
    b.close();
  };
  return up;
}

/** A gateway share server whose every `/ws/h` hops to `port` under the key HASH. */
async function gateway(port: number, perKey?: number) {
  const hop = createWsHop({ perKey, dialMs: 1000 });
  const s = await bound(
    edge.createShareServer({
      dispatch: (_req, res) => void res.writeHead(404).end(),
      upgrade: (req, socket, head, { url }) =>
        hop.forward(req, socket, head, HASH, { host: "127.0.0.1", port, path: `/ws/h${url.search}`, headers: { "x-forwarded-for": "203.0.113.9" } }),
    }),
  );
  return { hop, ...s };
}

function openPage(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/h?token=${TOKEN}&v=abc`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_r, res) => reject(new Error(`status ${res.statusCode}`)));
  });
}

const closed = (ws: WebSocket): Promise<number> => new Promise((r) => ws.once("close", (code) => r(code)));

test("a hop relays both ways, with the router's headers, to the target it is given", async () => {
  const up = await upstream();
  const gw = await gateway(up.port);
  try {
    const page = await openPage(gw.port);
    const got = new Promise<string>((r) => page.once("message", (d) => r(String(d))));
    await until(() => up.wss.clients.size === 1);
    [...up.wss.clients][0]!.send(JSON.stringify({ type: "view", big: "x".repeat(4096) }));
    assert.match(await got, /"view"/, "upstream → page is not capped");
    page.send("ping");
    await until(() => up.received.length === 1);
    assert.equal(String(up.received[0]), "ping");
    assert.equal(up.headers[0]!["x-forwarded-for"], "203.0.113.9");
    assert.equal(gw.hop.count(HASH), 1);
    page.close();
    await until(() => gw.hop.count(HASH) === 0 && up.wss.clients.size === 0);
  } finally {
    gw.close();
    up.close();
  }
});

test("required: a client message over SHARE_WS_MAX_PAYLOAD closes the page's socket and never reaches the upstream", async () => {
  const up = await upstream();
  const gw = await gateway(up.port);
  try {
    const page = await openPage(gw.port);
    await until(() => up.wss.clients.size === 1);
    const code = closed(page);
    page.send("y".repeat(edge.SHARE_WS_MAX_PAYLOAD + 1));
    assert.equal(await code, 1009);
    await until(() => up.wss.clients.size === 0);
    assert.equal(up.received.length, 0, "nothing was forwarded");
    // A message at the cap still passes.
    const again = await openPage(gw.port);
    again.send("z".repeat(edge.SHARE_WS_MAX_PAYLOAD));
    await until(() => up.received.length === 1);
    assert.equal(up.received[0]!.length, edge.SHARE_WS_MAX_PAYLOAD);
    again.close();
  } finally {
    gw.close();
    up.close();
  }
});

test("a live hop whose host goes away closes the page with 4503; the origin's own closes pass through", async () => {
  const up = await upstream();
  const gw = await gateway(up.port);
  try {
    const page = await openPage(gw.port);
    await until(() => up.wss.clients.size === 1);
    const code = closed(page);
    [...up.wss.clients][0]!.terminate();
    assert.equal(await code, contract.HOP_LOST_CLOSE);
    await until(() => gw.hop.count(HASH) === 0);

    for (const origin of [4410, 4000]) {
      const p = await openPage(gw.port);
      await until(() => up.wss.clients.size === 1);
      const c = closed(p);
      [...up.wss.clients][0]!.close(origin, "x");
      assert.equal(await c, origin);
      await until(() => up.wss.clients.size === 0);
    }
  } finally {
    gw.close();
    up.close();
  }
});

test("an upstream that is down, refuses the gateway, or answers 502/504 gets the page a 503", async () => {
  // Nothing listens: grab a port and free it.
  const dead = await bound(createServer());
  dead.close();
  for (const port of [dead.port]) {
    const gw = await gateway(port);
    try {
      const r = await wsStatus(`ws://127.0.0.1:${gw.port}/ws/h?token=${TOKEN}`);
      assert.equal(r.status, 503);
      assert.deepEqual(JSON.parse(r.body), { error: "offline", retryAfter: 60 });
      assert.equal(gw.hop.count(HASH), 0);
    } finally {
      gw.close();
    }
  }
  for (const answer of [{ status: 403, headers: { [hello.REFUSED_HEADER]: "refused" } }, { status: 502 }, { status: 504 }]) {
    const up = await upstream(answer);
    const gw = await gateway(up.port);
    try {
      const r = await wsStatus(`ws://127.0.0.1:${gw.port}/ws/h?token=${TOKEN}`);
      assert.equal(r.status, 503, JSON.stringify(answer));
      assert.equal(gw.hop.count(HASH), 0);
    } finally {
      gw.close();
      up.close();
    }
  }
});

test("the origin stays the authority: its 410 and 404 pass through as they are", async () => {
  for (const status of [410, 404]) {
    const up = await upstream(status);
    const gw = await gateway(up.port);
    try {
      const r = await wsStatus(`ws://127.0.0.1:${gw.port}/ws/h?token=${TOKEN}`);
      assert.equal(r.status, status);
    } finally {
      gw.close();
      up.close();
    }
  }
});

test("at most perKey hops per key; one more is 429 and never dialed; closeWhere drops them with 4503", async () => {
  const up = await upstream();
  const gw = await gateway(up.port, 2);
  try {
    const a = await openPage(gw.port);
    const b = await openPage(gw.port);
    assert.equal(gw.hop.count(HASH), 2);
    const dialed = up.upgrades;
    const r = await wsStatus(`ws://127.0.0.1:${gw.port}/ws/h?token=${TOKEN}`);
    assert.equal(r.status, 429);
    assert.equal(up.upgrades, dialed, "the refused hop was never dialed");
    const codes = Promise.all([closed(a), closed(b)]);
    gw.hop.closeWhere((k) => k === HASH);
    assert.deepEqual(await codes, [contract.HOP_LOST_CLOSE, contract.HOP_LOST_CLOSE]);
    await until(() => gw.hop.count(HASH) === 0);
  } finally {
    gw.close();
    up.close();
  }
});

// ---- hello.ts -----------------------------------------------------------------------------------

test("the hello advertises the gateway only while this host is one, outside the fingerprint", () => {
  const self = { id: "a", label: "A" };
  const file = join(root, "agent", "sova", "public-links.json");
  mkdirSync(join(root, "agent", "sova"), { recursive: true });
  const plain = hello.ownHello(self);
  assert.equal("shareGateway" in plain, false, "no setting: nothing advertised");
  const gateway = { publicUrl: "https://share.example.com", front: "caddy", sharePort: 4802, acceptFrom: "all" };
  writeFileSync(file, JSON.stringify({ version: 1, route: "self", gateway }));
  const gw = hello.ownHello(self);
  assert.deepEqual(gw.shareGateway, { publicUrl: "https://share.example.com" });
  assert.equal(gw.protocol, plain.protocol, "the fingerprint is unchanged");
  // Kept but not selected: a routed host (or off) advertises nothing.
  writeFileSync(file, JSON.stringify({ version: 1, route: "off", gateway, pad: 1 }));
  assert.equal("shareGateway" in hello.ownHello(self), false);
  writeFileSync(file, "{ not json");
  assert.equal("shareGateway" in hello.ownHello(self), false, "an unreadable setting advertises nothing");
  rmSync(file);
});
