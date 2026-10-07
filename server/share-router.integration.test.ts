// Run: node scripts/run-tests.mjs server/share-router.integration.test.ts. The gateway's router
// (§mesh.public/routing, /offline) behind the real share edge, with fake routed hosts on loopback
// ports and a throwaway PI_CODING_AGENT_DIR; ~/.pi untouched. Each wait is on the event itself (a
// message arriving, a socket closing, a hop reaching its gate), never a fixed sleep. routeOf in
// process is share-router.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-router-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { createShareServer, REQUESTS_PER_MINUTE } = await import("./share/edge");
const { createGatewayRouter, routeOf } = await import("./share/router");
const { GatewayRegistry } = await import("./share/registry");
const { hashToken, mintLink } = await import("./baton-links");
const { REFUSED_HEADER } = await import("./mesh/hello");
const { clearPeerReach } = await import("./mesh/proxy");
const { HOP_LOST_CLOSE, OFFLINE_PAGE } = await import("../shared/public-links");
const { createWsHop } = await import("./share/ws-hop");
const { FRAME_HOST_CSP, FRAME_HOST_NAME } = await import("../shared/vis-frame-host");
type RegistrySnapshot = import("../shared/public-links").RegistrySnapshot;
type PeerEntry = import("./mesh/peers").PeerEntry;

const T = (c: string) => c.repeat(43);
const GATEWAY = { publicUrl: "https://share.example.com", front: "caddy" as const, sharePort: 4802, acceptFrom: "all" as const };
const passing = (body: unknown) => ({ ok: true as const, snapshot: body as RegistrySnapshot });
/** A stand-in for M2's stripForwarded: forwarding, identity and hop-by-hop headers out. */
const strip = (h: IncomingHttpHeaders): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h))
    if (v !== undefined && !/^(x-forwarded-.*|forwarded|x-real-ip|tailscale-.*|x-sova-.*|connection|upgrade|keep-alive|transfer-encoding|te|trailer|proxy-.*|host)$/.test(k)) out[k] = v;
  return out;
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => {
    server.close();
    server.closeAllConnections();
  });
  return (server.address() as AddressInfo).port;
}

/** Resolves once `cond` holds, checked every 5 ms; throws after 10 s (a hang guard, not a bound). */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (const end = Date.now() + 10_000; !cond(); await new Promise((r) => setTimeout(r, 5)))
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

/** Resolves when `s` has closed: at once if it already has. */
function closedOf(s: { once(event: "close", fn: () => void): unknown; destroyed?: boolean; readyState?: number }): Promise<void> {
  if (s.destroyed === true || s.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((r) => void s.once("close", () => r()));
}

/** A promise and the function that resolves it: a fake's "it got here" signal. */
function signal(): { reached: Promise<void>; reach: () => void } {
  let reach!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  return { reached, reach };
}

/** A routed host's ingress: records what reached it, answers with `handler`. */
async function origin(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  const port = await listen(server);
  return { server, port, seen };
}

/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

let n = 0;
/** A gateway on an ephemeral port whose one peer (StableID `n1`) registered `links` at `port`. */
/** The peer as peers.json names it: a name the hop must never hand to a resolver (B3). */
const PEER: PeerEntry = { id: "b", nodeId: "n1", label: "b", dnsName: "b.unresolvable.invalid" };
/** The test resolver: n1's verified address is loopback, where the fake ingress listens. */
const LOOPBACK = async (p: PeerEntry) => (p.nodeId === "n1" ? "127.0.0.1" : null);

interface GatewayOpts {
  port: number;
  links?: RegistrySnapshot["links"];
  assets?: string[];
  peers?: PeerEntry[];
  setting?: typeof GATEWAY | null;
  hasAsset?: (n: string) => boolean;
  assetMaxBytes?: number;
  imageMaxBytes?: number;
  preflight?: (url: string) => Promise<boolean | "recent">;
  resolve?: (p: PeerEntry) => Promise<string | null>;
  wsHop?: ReturnType<typeof createWsHop>;
}

/** Read on every call: a test changes `o.setting` or `o.peers` to withdraw a host. */
async function gateway(o: GatewayOpts) {
  clearPeerReach();
  const file = join(root, `reg-${++n}.json`);
  const reg = new GatewayRegistry({ file: () => file, validate: passing });
  reg.commit("n1", { v: 1, seq: 1, links: o.links ?? [], assets: o.assets ?? [], ingressPort: o.port }, GATEWAY.publicUrl, { now: Date.now(), local: new Set(), live: () => true });
  const dials: string[] = [];
  const resolved: string[] = [];
  const hooks = createGatewayRouter({
    registry: reg,
    setting: () => (o.setting === undefined ? GATEWAY : o.setting),
    publicUrl: () => GATEWAY.publicUrl,
    peers: () => o.peers ?? [PEER],
    resolve: async (p) => {
      resolved.push(p.dnsName);
      return (o.resolve ?? LOOPBACK)(p);
    },
    sweepMs: 0,
    ...(o.wsHop ? { wsHop: o.wsHop } : {}),
    hasAsset: o.hasAsset ?? (() => false),
    strip,
    preflight: async (url) => {
      dials.push(url);
      return o.preflight ? o.preflight(url) : (await import("./mesh/proxy")).preflight(url);
    },
    assetMaxBytes: o.assetMaxBytes,
    imageMaxBytes: o.imageMaxBytes,
  });
  // The client address as M2's trustedClient gives it for a front on loopback: never a header the
  // client sent (the edge's M0 default still believes the last X-Forwarded-For hop).
  const server = createShareServer({ ...hooks, client: (req) => req.socket.remoteAddress ?? "unknown" });
  const port = await listen(server);
  after(() => hooks.dispose());
  return { base: `http://127.0.0.1:${port}`, port, dials, resolved, reg, hooks };
}

function get(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string; error?: string }> {
  return new Promise((resolve) => {
    const req = request(url, { method: init.method ?? "GET", headers: init.headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", (e) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, error: e.message }));
    });
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: "", error: e.message }));
    req.end(init.body);
  });
}

const row = (token: string, kind: "h" | "i" | "x" = "h") => ({ h: hashToken(token), exp: Date.now() + 86_400_000, kind });

test("an unknown hash is the gateway's own 404 and never dials anyone", async () => {
  const o = await origin((_q, res) => res.end("{}"));
  const g = await gateway({ port: o.port, links: [row(T("k"))] });
  const r = await get(`${g.base}/api/h/${T("u")}`);
  assert.equal(r.status, 404);
  assert.equal((await get(`${g.base}/api/i/${T("u")}`)).status, 404);
  assert.equal(o.seen.length, 0);
  assert.deepEqual(g.dials, []);
});

test("a registered hash hops once to its host, with the gateway's forwarding headers", async () => {
  const o = await origin((_q, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'", Connection: "x-secret", "X-Secret": "1" });
    res.end('{"view":1}');
  });
  const g = await gateway({ port: o.port, links: [row(T("k"))] });
  const r = await get(`${g.base}/api/h/${T("k")}?v=tab`, { headers: { "X-Forwarded-For": "6.6.6.6", Forwarded: "for=6.6.6.6", "X-Sova-Overseer": "x", "Tailscale-User-Login": "x" } });
  assert.equal(r.status, 200);
  assert.equal(r.body, '{"view":1}');
  assert.equal(r.headers["cache-control"], "no-store", "the origin's headers pass back");
  assert.equal(r.headers["x-secret"], undefined, "a header the origin's Connection names does not");
  assert.equal(o.seen.length, 1);
  const h = o.seen[0]!.headers;
  assert.equal(o.seen[0]!.url, `/api/h/${T("k")}?v=tab`);
  assert.equal(h["x-forwarded-for"], "127.0.0.1");
  assert.equal(h["x-forwarded-proto"], "https");
  assert.equal(h["x-forwarded-host"], "share.example.com");
  assert.equal(h.forwarded, undefined);
  assert.equal(h["x-sova-overseer"], undefined);
  assert.equal(h["tailscale-user-login"], undefined);
  // The page shell comes from the minting host too.
  await get(`${g.base}/h/${T("k")}`);
  assert.equal(o.seen[1]!.url, `/h/${T("k")}`);
});

test("a row's kind binds its routes; an x row never routes", async () => {
  const o = await origin((_q, res) => res.end("{}"));
  const g = await gateway({ port: o.port, links: [row(T("h")), row(T("i"), "i"), row(T("x"), "x")] });
  assert.equal((await get(`${g.base}/api/i/${T("h")}`)).status, 404);
  assert.equal((await get(`${g.base}/api/h/${T("i")}`)).status, 404);
  assert.equal((await get(`${g.base}/api/h/${T("x")}`)).status, 404);
  assert.equal((await get(`${g.base}/api/i/${T("x")}`)).status, 404);
  assert.equal(o.seen.length, 0);
  assert.equal((await get(`${g.base}/api/i/${T("i")}`)).status, 200);
  assert.equal(o.seen.length, 1);
});

test("a token this host minted is served in-process, whatever a peer registered", async () => {
  const token = mintLink({ orgId: "o", sessionId: "s", n: 1, personId: "p" });
  const o = await origin((_q, res) => res.end("{}"));
  const g = await gateway({ port: o.port, links: [row(token)] });
  await get(`${g.base}/api/h/${token}`);
  assert.equal(o.seen.length, 0);
  assert.deepEqual(g.dials, []);
});

test("no gateway setting, a removed or unaccepted peer: in-process, no dial", async () => {
  const o = await origin((_q, res) => res.end("{}"));
  for (const opts of [{ setting: null }, { peers: [] }, { setting: { ...GATEWAY, acceptFrom: ["n9"] as unknown as "all" } }]) {
    const g = await gateway({ port: o.port, links: [row(T("k"))], ...opts });
    assert.equal((await get(`${g.base}/api/h/${T("k")}`)).status, 404);
    assert.deepEqual(g.dials, []);
  }
  assert.equal(o.seen.length, 0);
});

test("the edge's limits apply before a hop", async () => {
  const o = await origin((_q, res) => res.end("{}"));
  const g = await gateway({ port: o.port, links: [row(T("k"))] });
  const big = await get(`${g.base}/api/h/${T("k")}/message`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: "x".repeat(20_000) });
  assert.equal(big.status, 413);
  assert.equal(o.seen.length, 0);
  // The per-address limit counts every request at the gateway (the 413 above included), before any hop.
  const statuses: number[] = [];
  for (let i = 0; i < REQUESTS_PER_MINUTE; i++) statuses.push((await get(`${g.base}/api/h/${T("k")}`, { headers: { Connection: "close" } })).status);
  assert.equal(statuses.at(-1), 429);
  assert.equal(o.seen.length, REQUESTS_PER_MINUTE - 1);
});

test("a host that is down: the offline shell, JSON and 503s, exactly", async () => {
  const port = await deadPort();
  const g = await gateway({ port, links: [row(T("k")), row(T("i"), "i")] });
  const page = await get(`${g.base}/h/${T("k")}`);
  assert.equal(page.status, 503);
  assert.equal(page.headers["retry-after"], "60");
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.match(String(page.headers["content-security-policy"]), /default-src 'self'/);
  assert.ok(page.body.includes(OFFLINE_PAGE.heading));
  assert.ok(!page.body.includes(T("k")), "no token in the page");
  for (const path of [`/api/h/${T("k")}`, `/api/i/${T("i")}`]) {
    const api = await get(`${g.base}${path}`);
    assert.equal(api.status, 503);
    assert.deepEqual(JSON.parse(api.body), { error: "offline", retryAfter: 60 });
  }
  const post = await get(`${g.base}/api/h/${T("k")}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"text":"hi"}' });
  assert.equal(post.status, 503);
});

test("502/504 and the gate's refusal are offline; any other answer (410) is the origin's", async () => {
  let status = 502;
  const o = await origin((_q, res) => {
    res.writeHead(status, status === 403 ? { [REFUSED_HEADER]: "refused" } : {});
    res.end(status === 410 ? '{"error":"gone"}' : "");
  });
  const g = await gateway({ port: o.port, links: [row(T("k"))] });
  for (status of [502, 504, 403]) assert.equal((await get(`${g.base}/api/h/${T("k")}`)).status, 503, String(status));
  status = 410;
  const gone = await get(`${g.base}/api/h/${T("k")}`);
  assert.deepEqual([gone.status, gone.body], [410, '{"error":"gone"}'], "a stale row after the origin revoked gets the origin's 410");
});

test("a POST is sent once and never retried when the host drops it", async () => {
  const o = await origin((req) => req.socket.destroy());
  const g = await gateway({ port: o.port, links: [row(T("k"))] });
  const r = await get(`${g.base}/api/h/${T("k")}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"text":"hi"}' });
  assert.equal(r.status, 503);
  assert.deepEqual(JSON.parse(r.body), { error: "offline", retryAfter: 60 });
  assert.equal(o.seen.length, 1);
  assert.equal(o.seen[0]!.body, '{"text":"hi"}');
});

test("a host that takes the connection but never answers is offline after the headers wait", async () => {
  const o = await origin(() => {});
  clearPeerReach();
  const file = join(root, `reg-${++n}.json`);
  const reg = new GatewayRegistry({ file: () => file, validate: passing });
  reg.commit("n1", { v: 1, seq: 1, links: [row(T("k"))], assets: [], ingressPort: o.port }, GATEWAY.publicUrl, { now: Date.now(), local: new Set(), live: () => true });
  const hooks = createGatewayRouter({ registry: reg, setting: () => GATEWAY, publicUrl: () => GATEWAY.publicUrl, peers: () => [PEER], resolve: LOOPBACK, strip, headersMs: 200, sweepMs: 0 });
  const port = await listen(createShareServer(hooks));
  const r = await get(`http://127.0.0.1:${port}/api/h/${T("k")}`);
  assert.equal(r.status, 503);
});

test("assets: own build first, else the listing host's, typed by extension, capped at the limit", async () => {
  const bodies: Record<string, { body: string; type?: string; chunked?: boolean }> = {
    "/h/assets/a.js": { body: "console.log(1)", type: "text/html" },
    "/h/assets/big.js": { body: "x".repeat(64) },
    "/h/assets/stream.js": { body: "y".repeat(64), chunked: true },
  };
  const o = await origin((req, res) => {
    const b = bodies[req.url!];
    if (!b) return void res.writeHead(404).end();
    if (b.chunked) {
      res.writeHead(200);
      res.write(b.body.slice(0, 20));
      setTimeout(() => res.end(b.body.slice(20)), 20);
      return;
    }
    res.writeHead(200, { "Content-Type": b.type ?? "application/octet-stream", "Content-Length": String(b.body.length) });
    res.end(b.body);
  });
  const g = await gateway({ port: o.port, assets: ["a.js", "big.js", "stream.js", "own.js", "a.exe"], hasAsset: (name) => name === "own.js", assetMaxBytes: 32 });
  const a = await get(`${g.base}/h/assets/a.js`);
  assert.deepEqual([a.status, a.body, a.headers["content-type"], a.headers["x-content-type-options"]], [200, "console.log(1)", "text/javascript; charset=utf-8", "nosniff"]);
  assert.equal((await get(`${g.base}/h/assets/big.js`)).status, 503, "declared over the cap");
  const streamed = await get(`${g.base}/h/assets/stream.js`);
  assert.ok(streamed.error || streamed.body.length <= 32, "cut off at the cap while streaming");
  const before = o.seen.length;
  assert.equal((await get(`${g.base}/h/assets/own.js`)).status, 404, "own build wins (in-process; none built here)");
  assert.equal((await get(`${g.base}/h/assets/a.exe`)).status, 404, "an extension outside the list never leaves");
  assert.equal((await get(`${g.base}/h/assets/nobody.js`)).status, 404, "a name nobody listed");
  assert.equal(o.seen.length, before);
  const down = await gateway({ port: await deadPort(), assets: ["a.js"] });
  assert.equal((await get(`${down.base}/h/assets/a.js`)).status, 503, "an asset with no reachable source");
});

test("assets: the frame host is the one html name, passed with its own headers; no other html name ever leaves", async () => {
  const doc = "<!doctype html><p>host</p>";
  const o = await origin((req, res) => {
    // The origin's own headers are never what the gateway answers with.
    if (req.url === `/h/assets/${FRAME_HOST_NAME}` || req.url === "/h/assets/page.html") return void res.writeHead(200, { "Content-Type": "text/plain", "X-Frame-Options": "DENY", "Content-Length": String(doc.length) }).end(doc);
    res.writeHead(404).end();
  });
  const g = await gateway({ port: o.port, assets: [FRAME_HOST_NAME, "page.html", "vis-frame.htm"] });
  const host = await get(`${g.base}/h/assets/${FRAME_HOST_NAME}`);
  assert.equal(host.status, 200);
  assert.equal(host.body, doc);
  assert.equal(host.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(host.headers["content-security-policy"], FRAME_HOST_CSP);
  assert.equal(host.headers["x-frame-options"], "SAMEORIGIN");
  assert.deepEqual([host.headers["cache-control"], host.headers["referrer-policy"], host.headers["x-content-type-options"]], ["no-store", "no-referrer", "nosniff"]);
  const before = o.seen.length;
  for (const name of ["page.html", "vis-frame.htm"]) assert.equal((await get(`${g.base}/h/assets/${name}`)).status, 404, name);
  assert.equal(o.seen.length, before, "never asked of the host");
});

// ---- /ws/h ---------------------------------------------------------------------------------------

async function wsOrigin() {
  const got: string[] = [];
  const sockets: WebSocket[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    headers.push(req.headers);
    sockets.push(ws);
    ws.on("message", (d) => got.push(String(d)));
    ws.send("view");
  });
  const port = await listen(server);
  return { port, got, sockets, headers };
}

function open(url: string): Promise<{ ws: WebSocket; first: string } | { status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.once("message", (d) => resolve({ ws, first: String(d) }));
    ws.once("unexpected-response", (_q, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.once("error", () => resolve({ status: 0 }));
  });
}

test("the gateway's /ws/h upgrade rejects an oversized client message without sending it upstream", async () => {
  const o = await wsOrigin();
  const g = await gateway({ port: o.port, links: [row(T("k"))] });
  const r = await open(`ws://127.0.0.1:${g.port}/ws/h?token=${T("k")}&v=tab`);
  assert.ok("ws" in r);
  assert.equal(r.first, "view");
  assert.equal(o.headers[0]!["x-forwarded-host"], "share.example.com");
  r.ws.send("small");
  await until(() => o.got.length === 1, "the small message upstream");
  const closed = new Promise<number>((res) => r.ws.once("close", (code) => res(code)));
  r.ws.send("z".repeat(2048));
  assert.equal(await closed, 1009);
  // The hop's upstream socket closed too: nothing can reach the host after this.
  await closedOf(o.sockets[0]!);
  assert.deepEqual(o.got, ["small"]);
});

test("/ws/h: unknown is 404 with no dial; a down host is 503; a host lost mid-stream closes 4503", async () => {
  const o = await wsOrigin();
  const g = await gateway({ port: o.port, links: [row(T("k"))] });
  assert.deepEqual(await open(`ws://127.0.0.1:${g.port}/ws/h?token=${T("u")}`), { status: 404 });
  assert.equal(o.headers.length, 0);
  const down = await gateway({ port: await deadPort(), links: [row(T("k"))] });
  assert.deepEqual(await open(`ws://127.0.0.1:${down.port}/ws/h?token=${T("k")}`), { status: 503 });
  const r = await open(`ws://127.0.0.1:${g.port}/ws/h?token=${T("k")}`);
  assert.ok("ws" in r);
  const closed = new Promise<number>((res) => r.ws.once("close", (code) => res(code)));
  o.sockets[0]!.terminate();
  assert.equal(await closed, HOP_LOST_CLOSE);
});

test("/ws/h: a hop closes 4503 when its host leaves acceptFrom or its snapshot withdraws the row", async () => {
  const o = await wsOrigin();
  clearPeerReach();
  const file = join(root, `reg-${++n}.json`);
  const reg = new GatewayRegistry({ file: () => file, validate: passing });
  const ctx = () => ({ now: Date.now(), local: new Set<string>(), live: () => true });
  reg.commit("n1", { v: 1, seq: 1, links: [row(T("a")), row(T("b"))], assets: [], ingressPort: o.port }, GATEWAY.publicUrl, ctx());
  let setting: typeof GATEWAY = GATEWAY;
  const hooks = createGatewayRouter({ registry: reg, setting: () => setting, publicUrl: () => GATEWAY.publicUrl, peers: () => [PEER], resolve: LOOPBACK, strip, sweepMs: 0 });
  const port = await listen(createShareServer({ ...hooks, client: (req) => req.socket.remoteAddress ?? "unknown" }));
  const a = await open(`ws://127.0.0.1:${port}/ws/h?token=${T("a")}`);
  const b = await open(`ws://127.0.0.1:${port}/ws/h?token=${T("b")}`);
  assert.ok("ws" in a && "ws" in b);
  const closedA = new Promise<number>((res) => a.ws.once("close", (code) => res(code)));
  const closedB = new Promise<number>((res) => b.ws.once("close", (code) => res(code)));
  hooks.sweep();
  // Still hopping after the sweep: a message sent through it now reaches the host.
  a.ws.send("after the sweep");
  await until(() => o.got.includes("after the sweep"), "a message through the hop after the sweep");
  assert.equal(a.ws.readyState, WebSocket.OPEN, "a sweep with nothing changed closes nothing");
  // A new snapshot without `a`: its hop closes at the commit, `b`'s stays.
  reg.commit("n1", { v: 1, seq: 2, links: [row(T("b"))], assets: [], ingressPort: o.port }, GATEWAY.publicUrl, ctx());
  assert.equal(await closedA, HOP_LOST_CLOSE);
  assert.equal(b.ws.readyState, WebSocket.OPEN);
  // The host leaves acceptFrom: the next sweep closes `b`.
  setting = { ...GATEWAY, acceptFrom: ["n9"] as unknown as "all" };
  hooks.sweep();
  assert.equal(await closedB, HOP_LOST_CLOSE);
});

// ---- review B1: revocation reaches open and pending hops ------------------------------------------

/** An ingress that answers headers at once and keeps the body open until the test ends. */
async function streamingOrigin() {
  const open: ServerResponse[] = [];
  const o = await origin((_q, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write("{");
    open.push(res);
  });
  after(() => open.forEach((r) => r.destroy()));
  return { ...o, open };
}

/** A GET whose answer started; resolves when the client's side of it ends (cut or complete).
    `text()` is what has arrived so far. */
function streamed(url: string): Promise<{ started: Promise<void>; ended: Promise<"cut" | "end">; text: () => string }> {
  return new Promise((resolve) => {
    let startedRes!: () => void;
    const started = new Promise<void>((r) => (startedRes = r));
    let endedRes!: (v: "cut" | "end") => void;
    const ended = new Promise<"cut" | "end">((r) => (endedRes = r));
    let text = "";
    const req = request(url, (res) => {
      startedRes();
      res.on("data", (d) => void (text += d));
      res.on("end", () => endedRes("end"));
      res.on("aborted", () => endedRes("cut"));
      res.on("error", () => endedRes("cut"));
      res.on("close", () => endedRes("cut"));
    });
    req.on("error", () => endedRes("cut"));
    req.end();
    resolve({ started, ended, text: () => text });
  });
}

for (const [what, withdraw] of [
  ["leaves acceptFrom", (o: GatewayOpts) => (o.setting = { ...GATEWAY, acceptFrom: ["n9"] as unknown as "all" })],
  ["is removed from peers.json", (o: GatewayOpts) => (o.peers = [])],
  ["is no longer served (gateway off)", (o: GatewayOpts) => (o.setting = null)],
] as const)
  test(`an open HTTP hop is cut when its host ${what}`, async () => {
    const o = await streamingOrigin();
    const opts: GatewayOpts = { port: o.port, links: [row(T("k"))] };
    const g = await gateway(opts);
    const s = await streamed(`${g.base}/api/h/${T("k")}`);
    await s.started;
    g.hooks.sweep();
    // Still streaming after the sweep: what the host writes now reaches the client.
    o.open[0]!.write('"after the sweep":1');
    await until(() => s.text().includes("after the sweep"), "a chunk through the hop after the sweep");
    assert.equal(o.open[0]!.destroyed || o.open[0]!.writableEnded, false, "nothing changed: the stream stays");
    withdraw(opts);
    g.hooks.sweep();
    assert.equal(await s.ended, "cut");
    await closedOf(o.open[0]!);
    assert.ok(o.open[0]!.destroyed || o.open[0]!.socket?.destroyed !== false, "the upstream side is closed too");
  });

test("/ws/h: a row its host withdrew, the host still accepted: the host's own 4410 reaches the page, not 4503", async () => {
  const o = await wsOrigin();
  clearPeerReach();
  const file = join(root, `reg-${++n}.json`);
  const reg = new GatewayRegistry({ file: () => file, validate: passing });
  const ctx = () => ({ now: Date.now(), local: new Set<string>(), live: () => true });
  reg.commit("n1", { v: 1, seq: 1, links: [row(T("a"))], assets: [], ingressPort: o.port }, GATEWAY.publicUrl, ctx());
  const hooks = createGatewayRouter({ registry: reg, setting: () => GATEWAY, publicUrl: () => GATEWAY.publicUrl, peers: () => [PEER], resolve: LOOPBACK, strip, sweepMs: 0 });
  after(() => hooks.dispose());
  const port = await listen(createShareServer({ ...hooks, client: (req) => req.socket.remoteAddress ?? "unknown" }));
  const a = await open(`ws://127.0.0.1:${port}/ws/h?token=${T("a")}`);
  assert.ok("ws" in a);
  const closedA = new Promise<number>((res) => a.ws.once("close", (code) => res(code)));
  // A revoke on the host: its snapshot without `a` lands first, its own close right after. A router
  // that cut the hop at the commit would have sent the page 4503 before the host's close arrives.
  reg.commit("n1", { v: 1, seq: 2, links: [], assets: [], ingressPort: o.port }, GATEWAY.publicUrl, ctx());
  o.sockets.at(-1)!.close(4410, "gone");
  assert.equal(await closedA, 4410);
});

test("an open HTTP hop is cut at once when its host's snapshot withdraws the row", async () => {
  const o = await streamingOrigin();
  const g = await gateway({ port: o.port, links: [row(T("k"))] });
  const s = await streamed(`${g.base}/api/h/${T("k")}`);
  await s.started;
  g.reg.commit("n1", { v: 1, seq: 2, links: [], assets: [], ingressPort: o.port }, GATEWAY.publicUrl, { now: Date.now(), local: new Set(), live: () => true });
  assert.equal(await s.ended, "cut");
});

for (const stage of ["resolve", "preflight"] as const)
  test(`a route withdrawn during the hop's ${stage} is never sent (a POST included)`, async () => {
    const o = await origin((_q, res) => res.end("{}"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const parked = signal();
    const opts: GatewayOpts = {
      port: o.port,
      links: [row(T("k"))],
      ...(stage === "resolve"
        ? { resolve: async (p: PeerEntry) => (parked.reach(), await gate, LOOPBACK(p)) }
        : { preflight: async () => (parked.reach(), await gate, true) }),
    };
    const g = await gateway(opts);
    const answer = get(`${g.base}/api/h/${T("k")}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"text":"hi"}' });
    await parked.reached; // the hop is at its ${stage}, waiting on the gate
    g.reg.commit("n1", { v: 1, seq: 2, links: [], assets: [], ingressPort: o.port }, GATEWAY.publicUrl, { now: Date.now(), local: new Set(), live: () => true });
    release();
    assert.equal((await answer).status, 404, "answered as an unknown token");
    assert.equal(o.seen.length, 0, "nothing reached the host");
  });

test("a WS upgrade whose route is withdrawn while its address resolves is never forwarded", async () => {
  const o = await wsOrigin();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const parked = signal();
  const opts: GatewayOpts = { port: o.port, links: [row(T("k"))], resolve: async (p) => (parked.reach(), await gate, LOOPBACK(p)) };
  const g = await gateway(opts);
  const r = open(`ws://127.0.0.1:${g.port}/ws/h?token=${T("k")}`);
  await parked.reached; // the upgrade is resolving its address, waiting on the gate
  opts.setting = { ...GATEWAY, acceptFrom: ["n9"] as unknown as "all" };
  release();
  assert.deepEqual(await r, { status: 404 });
  assert.equal(o.headers.length, 0);
});

test("dispose closes every open hop and routes nothing after", async () => {
  const o = await streamingOrigin();
  const w = await wsOrigin();
  const g = await gateway({ port: o.port, links: [row(T("k"))] });
  const wsGate = await gateway({ port: w.port, links: [row(T("w"))] });
  const s = await streamed(`${g.base}/api/h/${T("k")}`);
  await s.started;
  const ws = await open(`ws://127.0.0.1:${wsGate.port}/ws/h?token=${T("w")}`);
  assert.ok("ws" in ws);
  const closed = new Promise<number>((res) => ws.ws.once("close", (code) => res(code)));
  g.hooks.dispose();
  wsGate.hooks.dispose();
  assert.equal(await s.ended, "cut");
  assert.equal(await closed, HOP_LOST_CLOSE);
  const before = o.seen.length;
  assert.equal((await get(`${g.base}/api/h/${T("k")}`)).status, 404);
  assert.equal(o.seen.length, before);
});

// ---- review B3: the hop dials only the verified address -----------------------------------------------

test("no verified address for the row's node: offline, and nothing is dialed (HTTP and WS)", async () => {
  const o = await origin((_q, res) => res.end("{}"));
  const w = await wsOrigin();
  const g = await gateway({ port: o.port, links: [row(T("k"))], resolve: async () => null });
  assert.equal((await get(`${g.base}/api/h/${T("k")}`)).status, 503);
  assert.deepEqual(g.dials, []);
  assert.equal(o.seen.length, 0);
  const gw = await gateway({ port: w.port, links: [row(T("k"))], resolve: async () => null });
  assert.deepEqual(await open(`ws://127.0.0.1:${gw.port}/ws/h?token=${T("k")}`), { status: 503 });
  assert.equal(w.headers.length, 0);
});

test("the preflight and the dial use the one verified literal, never the peers.json name", async () => {
  const o = await origin((_q, res) => res.end("{}"));
  const g = await gateway({ port: o.port, links: [row(T("k"))] });
  assert.equal((await get(`${g.base}/api/h/${T("k")}`)).status, 200);
  assert.ok(g.resolved.length >= 1 && g.resolved.every((n) => n === PEER.dnsName), "resolved by the node's own entry");
  assert.deepEqual(g.dials, [`http://127.0.0.1:${o.port}`]);
  assert.equal(o.seen[0]!.headers.host, `127.0.0.1:${o.port}`);
});

// ---- review N4: what a hop may pass back ------------------------------------------------------------

test("a hop's answer never carries a cookie and always carries the share privacy headers; a redirect is offline", async () => {
  let redirect = false;
  const o = await origin((_q, res) => {
    if (redirect) return void res.writeHead(302, { Location: "https://elsewhere.example.com/" }).end();
    res.writeHead(200, { "Set-Cookie": "a=b", "Cache-Control": "public, max-age=600", "X-Sova-Internal": "1" });
    res.end("{}");
  });
  const g = await gateway({ port: o.port, links: [row(T("k"))] });
  const r = await get(`${g.base}/api/h/${T("k")}`);
  assert.equal(r.headers["set-cookie"], undefined);
  assert.equal(r.headers["x-sova-internal"], undefined);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  redirect = true;
  const moved = await get(`${g.base}/api/h/${T("k")}`);
  assert.equal(moved.status, 503);
  assert.equal(moved.headers.location, undefined);
});

// ---- re-review B1: authorization binds the hop's target, not only the row ------------------------

const move = (g: { reg: InstanceType<typeof GatewayRegistry> }, seq: number, links: RegistrySnapshot["links"], port: number) =>
  g.reg.commit("n1", { v: 1, seq, links, assets: [], ingressPort: port }, GATEWAY.publicUrl, { now: Date.now(), local: new Set(), live: () => true });

test("a row whose port moves during the preflight is not dialed at the old port, and is retryable", async () => {
  const oldOrigin = await origin((_q, res) => res.end('{"old":1}'));
  const newOrigin = await origin((_q, res) => res.end('{"new":1}'));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let paused = true;
  const parked = signal();
  const g = await gateway({ port: oldOrigin.port, links: [row(T("k"))], preflight: async () => (paused ? (parked.reach(), await gate, true) : true) });
  const answer = get(`${g.base}/api/h/${T("k")}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"text":"hi"}' });
  await parked.reached; // the hop is at its preflight, waiting on the gate
  move(g, 2, [row(T("k"))], newOrigin.port);
  release();
  const r = await answer;
  assert.equal(r.status, 503, "the link still routes, elsewhere: the offline answer, retried by the page");
  assert.equal(oldOrigin.seen.length, 0, "never sent to the old target");
  assert.equal(newOrigin.seen.length, 0, "and not silently re-sent to the new one");
  paused = false;
  assert.equal((await get(`${g.base}/api/h/${T("k")}`)).body, '{"new":1}', "the next request reaches the new target");
});

test("an open HTTP hop and an open /ws/h hop are cut when their row's port moves", async () => {
  const o = await streamingOrigin();
  const w = await wsOrigin();
  const other = await origin((_q, res) => res.end("{}"));
  const g = await gateway({ port: o.port, links: [row(T("k"))] });
  const s = await streamed(`${g.base}/api/h/${T("k")}`);
  await s.started;
  move(g, 2, [row(T("k"))], other.port);
  assert.equal(await s.ended, "cut");
  const gw = await gateway({ port: w.port, links: [row(T("w"))] });
  const ws = await open(`ws://127.0.0.1:${gw.port}/ws/h?token=${T("w")}`);
  assert.ok("ws" in ws);
  const closed = new Promise<number>((res) => ws.ws.once("close", (code) => res(code)));
  move(gw, 2, [row(T("w"))], other.port);
  assert.equal(await closed, HOP_LOST_CLOSE);
});

test("a verified address that changes cuts the open hop, and one that changes during the preflight is not dialed", async () => {
  const o = await streamingOrigin();
  let address = "127.0.0.1";
  const g = await gateway({ port: o.port, links: [row(T("k"))], resolve: async (p) => (p.nodeId === "n1" ? address : null) });
  const s = await streamed(`${g.base}/api/h/${T("k")}`);
  await s.started;
  g.hooks.sweep();
  // Still streaming once the sweep's address check ran (its lookups settle before a chunk can cross
  // the hop): what the host writes now reaches the client.
  o.open[0]!.write('"after the sweep":1');
  await until(() => s.text().includes("after the sweep"), "a chunk through the hop after the sweep");
  assert.equal(o.open[0]!.destroyed, false, "the same address: the stream stays");
  address = "127.0.0.2"; // the node's pinned or status address moved
  g.hooks.sweep();
  assert.equal(await s.ended, "cut");

  const o2 = await origin((_q, res) => res.end("{}"));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let addr2 = "127.0.0.1";
  const parked = signal();
  const g2 = await gateway({ port: o2.port, links: [row(T("k"))], resolve: async (p) => (p.nodeId === "n1" ? addr2 : null), preflight: async () => (parked.reach(), await gate, true) });
  const answer = get(`${g2.base}/api/h/${T("k")}`);
  await parked.reached; // the hop is at its preflight, waiting on the gate
  addr2 = "127.0.0.2";
  release();
  assert.equal((await answer).status, 503);
  assert.equal(o2.seen.length, 0, "the preflighted address is not the one dialed, so nothing is");
});

// ---- final check: the WS upgrade is accepted only for the verified address it dialed ------------

/** A WS ingress whose handshake waits for `release`, then sends `hello` at once. */
async function slowWsOrigin() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const upgraded: WebSocket[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const asked = signal();
  server.on("upgrade", (req, socket, head) => {
    asked.reach();
    void gate.then(() =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        upgraded.push(ws);
        ws.send("hello");
      }),
    );
  });
  const port = await listen(server);
  return { port, release, upgraded, asked: asked.reached };
}

for (const changed of [false, true])
  test(`/ws/h: ${changed ? "an address changed while the host's handshake was pending is refused" : "control: the same address is accepted"}`, async () => {
    const o = await slowWsOrigin();
    let address = "127.0.0.1";
    const hops = createWsHop();
    const g = await gateway({ port: o.port, links: [row(T("k"))], resolve: async (p) => (p.nodeId === "n1" ? address : null), wsHop: hops });
    const page = open(`ws://127.0.0.1:${g.port}/ws/h?token=${T("k")}`);
    await o.asked; // the host has the upgrade request, its handshake pending
    if (changed) address = "127.0.0.2"; // node, hash and port unchanged; no sweep runs
    o.release();
    const r = await page;
    if (!changed) {
      assert.ok("ws" in r && r.first === "hello");
      r.ws.close();
      return;
    }
    assert.deepEqual(r, { status: 404 }, "the page is not upgraded and receives nothing");
    await until(() => o.upgraded.length > 0, "the old target's answer");
    await closedOf(o.upgraded[0]!);
    assert.equal(o.upgraded.length, 1, "the old target did answer");
    assert.notEqual(o.upgraded[0]!.readyState, WebSocket.OPEN, "and its socket is closed");
    await until(() => hops.total() === 0, "the hop's slot released");
    assert.equal(hops.total(), 0, "the slot is released");
  });

// ---- session shares (kind `s`) ---------------------------------------------------------------------
test("kinds bind routes: an s row serves /s, /api/s and its images; an h row never serves /s, an s row never /h", async () => {
  const o = await origin((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end('{"from":"origin"}'));
  const g = await gateway({ port: o.port, links: [row(T("s"), "s" as never), row(T("h"))] });
  for (const p of [`/api/s/${T("s")}`, `/api/s/${T("s")}/img/3`, `/s/${T("s")}`]) {
    const r = await get(`${g.base}${p}`);
    assert.equal(r.body, '{"from":"origin"}', p);
  }
  assert.deepEqual(o.seen.map((s) => s.url), [`/api/s/${T("s")}`, `/api/s/${T("s")}/img/3`, `/s/${T("s")}`]);
  const before = o.seen.length;
  // The h row's token on an /s route, and the s row's on an /h route: this host's own 404, never a hop.
  assert.equal((await get(`${g.base}/api/s/${T("h")}`)).status, 404);
  assert.equal((await get(`${g.base}/api/h/${T("s")}`)).status, 404);
  assert.equal(o.seen.length, before, "nothing reached the routed host");
});

test("/ws/s hops on an s row only; /ws/h never hops on one", async () => {
  const o = await wsOrigin();
  const g = await gateway({ port: o.port, links: [row(T("s"), "s" as never), row(T("h"))] });
  const r = await open(`ws://127.0.0.1:${g.port}/ws/s?token=${T("s")}&v=tab`);
  assert.ok("ws" in r, JSON.stringify(r));
  assert.equal(r.first, "view");
  assert.equal(o.headers.length, 1);
  assert.deepEqual(await open(`ws://127.0.0.1:${g.port}/ws/h?token=${T("s")}`), { status: 404 });
  assert.deepEqual(await open(`ws://127.0.0.1:${g.port}/ws/s?token=${T("h")}`), { status: 404 });
  assert.equal(o.headers.length, 1, "neither mismatch dialed the host");
  // A 1 KB-plus page message never reaches the host.
  const closed = new Promise<number>((res) => r.ws.once("close", (code) => res(code)));
  r.ws.send("z".repeat(2048));
  assert.equal(await closed, 1009);
  assert.deepEqual(o.got, []);
});

test("/ws/s: a down host is 503; a lost host closes 4503; a withdrawn row passes the host's own 4410", async () => {
  const down = await gateway({ port: await deadPort(), links: [row(T("s"), "s" as never)] });
  assert.deepEqual(await open(`ws://127.0.0.1:${down.port}/ws/s?token=${T("s")}`), { status: 503 });
  const o = await wsOrigin();
  const g = await gateway({ port: o.port, links: [row(T("s"), "s" as never)] });
  const r = await open(`ws://127.0.0.1:${g.port}/ws/s?token=${T("s")}`);
  assert.ok("ws" in r);
  const closed = new Promise<number>((res) => r.ws.once("close", (code) => res(code)));
  o.sockets[0]!.terminate();
  assert.equal(await closed, HOP_LOST_CLOSE);
  // Withdrawn by its own host (a newer snapshot without it), the host still accepted: its 4410 passes.
  const a = await open(`ws://127.0.0.1:${g.port}/ws/s?token=${T("s")}`);
  assert.ok("ws" in a);
  const aClosed = new Promise<number>((res) => a.ws.once("close", (code) => res(code)));
  g.reg.commit("n1", { v: 1, seq: 2, links: [], assets: [], ingressPort: o.port }, GATEWAY.publicUrl, { now: Date.now(), local: new Set(), live: () => true });
  g.hooks.sweep();
  o.sockets.at(-1)!.close(4410, "gone");
  assert.equal(await aClosed, 4410);
});

test("a hopped session image over the gateway's cap is refused (declared) or cut (streamed); a small one passes", async () => {
  const o = await origin((req, res) => {
    const body = Buffer.alloc(req.url!.endsWith("/img/1") ? 100 : 10, 1);
    if (req.url!.endsWith("/img/2")) {
      res.writeHead(200, { "Content-Type": "image/png" }); // chunked: no length
      res.write(Buffer.alloc(60, 1));
      res.end(Buffer.alloc(60, 1));
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(body.length) }).end(body);
  });
  const g = await gateway({ port: o.port, links: [row(T("s"), "s" as never)], imageMaxBytes: 50 });
  const small = await get(`${g.base}/api/s/${T("s")}/img/0`);
  assert.deepEqual([small.status, small.body.length], [200, 10]);
  assert.equal((await get(`${g.base}/api/s/${T("s")}/img/1`)).status, 503, "declared over the cap");
  const streamed = await get(`${g.base}/api/s/${T("s")}/img/2`);
  assert.ok(streamed.error || streamed.body.length <= 50, "streamed past the cap: cut, never passed whole");
});

test("a gathering's photos hop as the link's own: the upload's body passes once, a read is capped like a session image", async () => {
  const o = await origin((req, res, body) => {
    if (req.method === "POST") return void res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ got: body.length }));
    const img = Buffer.alloc(req.url!.endsWith("/img/1") ? 100 : 10, 1);
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(img.length) }).end(img);
  });
  const g = await gateway({ port: o.port, links: [row(T("h"))], imageMaxBytes: 50 });
  const up = await get(`${g.base}/api/h/${T("h")}/image`, { method: "POST", headers: { "Content-Type": "image/jpeg", "Content-Length": "4" }, body: "abcd" });
  assert.deepEqual([up.status, JSON.parse(up.body)], [201, { got: 4 }]);
  assert.equal(o.seen.filter((s) => s.method === "POST").length, 1, "a POST is never retried");
  const small = await get(`${g.base}/api/h/${T("h")}/img/0`);
  assert.deepEqual([small.status, small.body.length], [200, 10]);
  assert.equal((await get(`${g.base}/api/h/${T("h")}/img/1`)).status, 503, "declared over the cap");
});
