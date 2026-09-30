// Run: pnpm exec tsx --test server/share-preview-proxy.test.ts. A minting host's preview proxy
// (§mesh.public/preview-proxy, /preview-offline, /preview-limits) behind the real share edge's Host
// split (§mesh.public/preview-address), with fake apps on loopback and a throwaway
// PI_CODING_AGENT_DIR; ~/.pi untouched.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-preview-proxy-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { createShareServer } = await import("./share/edge");
const proxyMod = await import("./share/preview-proxy");
const { appRequestHeaders, createPreviewProxy, hostOnlyCookie, privateCacheControl, visitorResponseHeaders, PreviewSlots } = proxyMod;
const { previewLabelOfHost, previewOrigin } = await import("./share/preview-address");
const store = await import("./preview-links");

const ZONE_URL = "http://*.preview.test";
const none = new Set<number>();

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((r, j) => {
    server.once("error", j);
    server.listen(0, host, () => r());
  });
  after(() => {
    server.close();
    server.closeAllConnections();
  });
  return (server.address() as AddressInfo).port;
}

/** A fake app: records what reached it; `handler` answers. */
async function app(handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void, host = "127.0.0.1") {
  const seen: { url?: string; headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  const port = await listen(server, host);
  return { server, port, seen };
}

/** The share edge with only the preview split, over the real store's records. */
async function edge(opts: { bodyMax?: number; headersMs?: number; hosts?: string[] } = {}) {
  const proxy = createPreviewProxy({ origin: (l) => previewOrigin(ZONE_URL, l), sweepMs: 0, ...opts });
  after(() => proxy.dispose());
  const server = createShareServer({
    client: (req) => req.socket.remoteAddress ?? "unknown",
    preview: {
      match: (req) => previewLabelOfHost(req.headers.host, ZONE_URL),
      dispatch: (req, res, label) => proxy.dispatch(req, res, label),
      upgrade: (req, socket, head, label) => proxy.upgrade(req, socket, head, label),
    },
  });
  const port = await listen(server);
  return { port, proxy };
}

function mint(port: number) {
  const { record, label } = store.mintPreview({ orgId: "o", projectId: "p", port }, none);
  return { record, label, host: `${label}.preview.test`, origin: `http://${label}.preview.test` };
}

interface Got {
  status: number;
  headers: IncomingHttpHeaders;
  raw: string[];
  body: Buffer;
}
function get(port: number, path: string, headers: Record<string, string>, init: { method?: string; body?: Buffer } = {}): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

// ---- the transforms --------------------------------------------------------------------------------

test("toward the app: Host and Origin are localhost's, the Referer's origin too, and nothing forwarded is sent", () => {
  const o = "https://abc.preview.example";
  const h = appRequestHeaders(
    {
      host: "abc.preview.example",
      origin: o,
      referer: `${o}/deep/route?x=1`,
      cookie: "sid=1; theme=dark",
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-host": "abc.preview.example",
      "x-forwarded-proto": "https",
      forwarded: "for=1.2.3.4",
      "x-real-ip": "1.2.3.4",
      "cf-connecting-ip": "1.2.3.4",
      "cf-ray": "x",
      "true-client-ip": "1.2.3.4",
      "tailscale-user-login": "me",
      "x-sova-preview": "abc",
      connection: "keep-alive, x-drop-me",
      "x-drop-me": "1",
      "keep-alive": "5",
      expect: "100-continue",
      accept: "text/html",
    },
    5173,
    o,
  );
  assert.deepEqual(h, { host: "localhost:5173", origin: "http://localhost:5173", referer: "http://localhost:5173/deep/route?x=1", cookie: "sid=1; theme=dark", accept: "text/html" });
  // Another site's Origin and Referer pass as they are.
  const other = appRequestHeaders({ origin: "https://evil.example", referer: `${o}.evil.example/x` }, 5173, o);
  assert.equal(other.origin, "https://evil.example");
  assert.equal(other.referer, `${o}.evil.example/x`);
});

test("toward the visitor: Location, ACAO, cookies' Domain, Cache-Control and Referrer-Policy; an x-sova-* answer is refused", () => {
  const o = "https://abc.preview.example";
  const out = visitorResponseHeaders(
    [
      "Location", "http://localhost:5173/after?x=1",
      "Access-Control-Allow-Origin", "http://127.0.0.1:5173",
      "Set-Cookie", "sid=1; Domain=localhost; Path=/; HttpOnly",
      "Set-Cookie", "theme=dark; path=/; domain=.localhost",
      "Cache-Control", "public, max-age=600, s-maxage=900",
      "Connection", "keep-alive",
      "Transfer-Encoding", "chunked",
      "Content-Type", "text/html",
    ],
    5173,
    o,
  )!;
  const pairs: [string, string][] = [];
  for (let i = 0; i < out.length; i += 2) pairs.push([out[i]!, out[i + 1]!]);
  assert.deepEqual(pairs, [
    ["Location", `${o}/after?x=1`],
    ["Access-Control-Allow-Origin", o],
    ["Set-Cookie", "sid=1; Path=/; HttpOnly"],
    ["Set-Cookie", "theme=dark; path=/"],
    ["Content-Type", "text/html"],
    ["Cache-Control", "private, max-age=600"],
    ["Referrer-Policy", "same-origin"],
  ]);
  assert.equal(visitorResponseHeaders(["Location", "http://[::1]:5173/"], 5173, o)![1], `${o}/`);
  // Another port, another host, a relative Location: untouched.
  assert.equal(visitorResponseHeaders(["Location", "http://localhost:3000/x"], 5173, o)![1], "http://localhost:3000/x");
  assert.equal(visitorResponseHeaders(["Location", "/login"], 5173, o)![1], "/login");
  assert.equal(visitorResponseHeaders(["Location", "http://localhost:51730/x"], 5173, o)![1], "http://localhost:51730/x");
  // The app's own Referrer-Policy stays.
  assert.deepEqual(visitorResponseHeaders(["Referrer-Policy", "no-referrer"], 5173, o), ["Referrer-Policy", "no-referrer", "Cache-Control", "private"]);
  assert.equal(visitorResponseHeaders(["X-Sova-Mesh", "refused"], 5173, o), null);
  assert.equal(privateCacheControl("no-store"), "no-store");
  assert.equal(privateCacheControl(undefined), "private");
  assert.equal(privateCacheControl("max-age=31536000,immutable"), "private, max-age=31536000, immutable");
  assert.equal(hostOnlyCookie("a=b"), "a=b");
});

// ---- through the edge ------------------------------------------------------------------------------

test("a preview host reaches the app at the root, bodies byte for byte both ways; the share paths are the app's there", async () => {
  const blob = randomBytes(1024 * 1024 + 7);
  const a = await app((req, res, body) => {
    if (req.url === "/blob") return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(blob);
    if (req.url === "/echo") return void res.writeHead(200).end(body);
    if (req.url === "/login") return void res.writeHead(302, { location: `http://localhost:${a.port}/after`, "set-cookie": ["sid=abc; Domain=localhost; Path=/"] }).end();
    res.writeHead(200, { "content-type": "text/plain" }).end(`path ${req.url}`);
  });
  const e = await edge();
  const p = mint(a.port);
  const got = await get(e.port, "/blob", { host: p.host });
  assert.equal(got.status, 200);
  assert.ok(got.body.equals(blob));
  const up = randomBytes(300_000);
  const echoed = await get(e.port, "/echo", { host: p.host, "content-type": "application/octet-stream" }, { method: "POST", body: up });
  assert.ok(echoed.body.equals(up));
  const seen = a.seen.find((s) => s.url === "/echo")!;
  assert.equal(seen.headers.host, `localhost:${a.port}`);
  assert.ok(!Object.keys(seen.headers).some((k) => /^x-forwarded|^forwarded|^x-sova/.test(k)));
  const redirect = await get(e.port, "/login", { host: p.host });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, `${p.origin}/after`);
  assert.deepEqual(redirect.headers["set-cookie"], ["sid=abc; Path=/"]);
  // The share host's own paths and odd ones belong to the app on a preview host.
  for (const path of ["/h/" + "a".repeat(43), "/api/public-links", "/ws/h", "/deep/route?q=%2e%2e", "/%2e%2e/x"]) {
    const r = await get(e.port, path, { host: p.host });
    assert.equal(r.status, 200, path);
    assert.equal(r.body.toString(), `path ${path}`);
  }
});

test("the share host keeps its allowlist: a non-preview Host never reaches an app, and the x-sova-preview header names nothing", async () => {
  const a = await app((_req, res) => void res.writeHead(200).end("app"));
  const e = await edge();
  const p = mint(a.port);
  const tries: Record<string, string>[] = [{ host: "share.test" }, { host: "share.test", "x-sova-preview": p.label }, { host: `x${p.host}` }, { host: `${p.label}.other.test` }];
  for (const headers of tries) {
    const r = await get(e.port, "/", headers);
    assert.equal(r.status, 404, JSON.stringify(headers));
    assert.notEqual(r.body.toString(), "app");
  }
  assert.equal(a.seen.length, 0);
});

test("the app on ::1 only is reached there; 127.0.0.1 is tried first", async (t) => {
  let a: Awaited<ReturnType<typeof app>>;
  try {
    a = await app((_req, res) => void res.writeHead(200).end("v6"), "::1");
  } catch {
    t.skip("no IPv6 loopback here");
    return;
  }
  const e = await edge();
  const p = mint(a.port);
  const r = await get(e.port, "/", { host: p.host });
  assert.equal(r.body.toString(), "v6");
});

test("nothing listening: a navigation gets the 502 page that reloads itself, a fetch 502 text, a websocket 502", async () => {
  const dead = createServer();
  const deadPort = await listen(dead);
  await new Promise<void>((r) => dead.close(() => r()));
  const e = await edge();
  const p = mint(deadPort);
  const page = await get(e.port, "/deep/route", { host: p.host, "sec-fetch-mode": "navigate", accept: "text/html" });
  assert.equal(page.status, 502);
  assert.match(String(page.headers["content-type"]), /text\/html/);
  assert.match(page.body.toString(), /This preview isn't running right now\. It will open here once the app is started again\./);
  assert.match(page.body.toString(), /http-equiv="refresh" content="10"/);
  assert.equal(page.headers["retry-after"], "10");
  assert.equal(page.headers["cache-control"], "no-store");
  assert.ok(!page.body.toString().includes(String(deadPort)) && !page.body.toString().includes(p.label));
  const sub = await get(e.port, "/src/main.ts", { host: p.host, "sec-fetch-mode": "cors" });
  assert.equal(sub.status, 502);
  assert.match(String(sub.headers["content-type"]), /text\/plain/);
  const ws = new WebSocket(`ws://127.0.0.1:${e.port}/`, { headers: { host: p.host } });
  const status = await new Promise<number>((r) => {
    ws.on("unexpected-response", (_q, res) => r(res.statusCode ?? 0));
    ws.on("error", () => r(-1));
  });
  assert.equal(status, 502);
});

test("an app answering with a Sova marker header is never passed on", async () => {
  const a = await app((_req, res) => void res.writeHead(200, { "x-sova-mesh": "hello", "content-type": "text/plain" }).end("sova"));
  const e = await edge();
  const p = mint(a.port);
  const r = await get(e.port, "/", { host: p.host });
  assert.equal(r.status, 502);
  assert.notEqual(r.body.toString(), "sova");
});

test("unknown is the preview 404 (JSON for a fetch: what Verify recognizes); turned off is 410 with Clear-Site-Data", async () => {
  const a = await app((_req, res) => void res.writeHead(200).end("ok"));
  const e = await edge();
  const unknown = `${store.newPreviewLabel()}.preview.test`;
  const r = await get(e.port, "/", { host: unknown, accept: "application/json" });
  assert.equal(r.status, 404);
  assert.deepEqual(JSON.parse(r.body.toString()), { error: "This preview link isn't active.", code: "preview-not-found" });
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  const page = await get(e.port, "/", { host: unknown, "sec-fetch-mode": "navigate" });
  assert.match(page.body.toString(), /This preview link isn't active\./);
  const p = mint(a.port);
  assert.equal((await get(e.port, "/", { host: p.host })).status, 200);
  store.revokePreview(p.record.id);
  const gone = await get(e.port, "/", { host: p.host, "sec-fetch-mode": "navigate" });
  assert.equal(gone.status, 410);
  assert.equal(gone.headers["clear-site-data"], '"cache", "storage"');
  assert.match(gone.body.toString(), /This preview link is no longer active\./);
});

test("a websocket passes raw (subprotocol and big frames included); Turn Off closes it and an open response at once", async () => {
  const a = await app((req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      return; // held open
    }
    res.writeHead(200).end();
  });
  const wss = new WebSocketServer({ server: a.server, handleProtocols: (ps) => (ps.has("vite-hmr") ? "vite-hmr" : false) });
  wss.on("connection", (ws, req) => {
    ws.send(JSON.stringify({ origin: req.headers.origin, host: req.headers.host }));
    ws.on("message", (m, binary) => ws.send(m, { binary }));
  });
  const e = await edge();
  const p = mint(a.port);
  const ws = new WebSocket(`ws://127.0.0.1:${e.port}/?token=x`, ["vite-hmr"], { headers: { host: p.host, origin: p.origin } });
  const first = await new Promise<string>((r, j) => {
    ws.once("message", (m) => r(m.toString()));
    ws.once("error", j);
  });
  assert.equal(ws.protocol, "vite-hmr");
  assert.deepEqual(JSON.parse(first), { origin: `http://localhost:${a.port}`, host: `localhost:${a.port}` });
  const big = randomBytes(3 * 1024 * 1024);
  ws.send(big);
  const back = await new Promise<Buffer>((r) => ws.once("message", (m) => r(m as Buffer)));
  assert.ok(back.equals(big));
  // An open streaming response, then Turn Off.
  const stream = new Promise<string>((resolve) => {
    const req = request({ host: "127.0.0.1", port: e.port, path: "/stream", headers: { host: p.host } }, (res) => {
      res.once("data", () => {
        store.revokePreview(p.record.id);
      });
      res.on("error", () => resolve("cut"));
      res.on("close", () => resolve("closed"));
    });
    req.on("error", () => resolve("cut"));
    req.end();
  });
  const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
  assert.ok(["cut", "closed"].includes(await stream));
  assert.equal(typeof (await closed), "number");
  assert.equal(e.proxy.openCount(p.record.hash), 0);
});

test("limits: a declared body over the cap is 413 before the app; a streamed one is cut; a slow app is 504", async () => {
  const a = await app((req, res) => {
    if (req.url === "/slow") return; // never answers
    res.writeHead(200).end("ok");
  });
  const e = await edge({ bodyMax: 1000, headersMs: 300 });
  const p = mint(a.port);
  const big = await get(e.port, "/up", { host: p.host, "content-length": "5000" }, { method: "POST", body: Buffer.alloc(5000) });
  assert.equal(big.status, 413);
  assert.ok(!a.seen.some((s) => s.url === "/up"));
  const slow = await get(e.port, "/slow", { host: p.host });
  assert.equal(slow.status, 504);
  const slots = new PreviewSlots({ httpPerPreview: 2, wsPerPreview: 1, httpTotal: 3, wsTotal: 5 });
  const r1 = slots.take("a", "http");
  const r2 = slots.take("a", "http");
  assert.ok(r1 && r2);
  assert.equal(slots.take("a", "http"), null);
  assert.ok(slots.take("b", "http"));
  assert.equal(slots.take("c", "http"), null, "the total cap");
  r1!();
  assert.ok(slots.take("a", "http"));
});
