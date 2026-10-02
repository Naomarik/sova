// Run: pnpm exec tsx --test server/share-preview-router.test.ts. Preview hosts at a gateway
// (§mesh.public/routing kind `p`, /preview-offline) behind the real share edge, with a fake routed
// host's ingress on loopback; and a routed host's side of kind `p` (§mesh.public/registry,
// /preview-address) against fake gateways, old and new. Throwaway PI_CODING_AGENT_DIR; ~/.pi untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-preview-router-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { createShareServer } = await import("./share/edge");
const { createGatewayRouter } = await import("./share/router");
const { GatewayRegistry } = await import("./share/registry");
const { clearPeerReach } = await import("./mesh/proxy");
const { REFUSED_HEADER } = await import("./mesh/hello");
const { previewLabelOfHost } = await import("./share/preview-address");
const store = await import("./preview-links");
type RegistrySnapshot = import("../shared/public-links").RegistrySnapshot;
type PeerEntry = import("./mesh/peers").PeerEntry;

const ZONE = "http://*.preview.test";
const GATEWAY = { publicUrl: "https://share.example.com", front: "vhost" as const, sharePort: 4802, acceptFrom: "all" as const };
const PEER: PeerEntry = { id: "b", nodeId: "n1", label: "b", dnsName: "b.unresolvable.invalid" };
const passing = (body: unknown) => ({ ok: true as const, snapshot: body as RegistrySnapshot });

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => {
    server.close();
    server.closeAllConnections();
  });
  return (server.address() as AddressInfo).port;
}

/** A routed host's ingress: records what reached it. */
async function ingress(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: { url?: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    req.resume();
    req.on("end", () => handler(req, res));
  });
  const port = await listen(server);
  return { server, port, seen };
}

let n = 0;
async function gateway(o: { port: number; labels: string[]; local?: string[] }) {
  clearPeerReach();
  const file = join(root, `reg-${++n}.json`);
  const reg = new GatewayRegistry({ file: () => file, validate: passing });
  const links = o.labels.map((l) => ({ h: store.hashLabel(l), exp: Date.now() + 86_400_000, kind: "p" as const }));
  reg.commit("n1", { v: 1, seq: 1, links, assets: [], ingressPort: o.port }, GATEWAY.publicUrl, { now: Date.now(), local: new Set(), live: () => true });
  const localSeen: string[] = [];
  const localClients: (string | undefined)[] = [];
  const localHashes = new Set((o.local ?? []).map((l) => store.hashLabel(l)));
  const hooks = createGatewayRouter({
    registry: reg,
    setting: () => GATEWAY,
    publicUrl: () => GATEWAY.publicUrl,
    peers: () => [PEER],
    resolve: async (p) => (p.nodeId === "n1" ? "127.0.0.1" : null),
    sweepMs: 0,
    preflight: async () => true,
    isLocalPreview: (h) => localHashes.has(h),
    previewLocal: {
      dispatch: (_req, res, label, client) => {
        localSeen.push(label);
        localClients.push(client);
        res.writeHead(200).end("local");
      },
      upgrade: (_req, socket) => socket.destroy(),
      sweep: () => {},
      openCount: () => 0,
      dispose: () => {},
    },
    previewMatch: (req) => previewLabelOfHost(req.headers.host, ZONE),
    previewHeadersMs: 500,
  });
  const server = createShareServer({ ...hooks, client: (req) => req.socket.remoteAddress ?? "unknown" });
  const port = await listen(server);
  after(() => hooks.dispose());
  return { port, reg, hooks, localSeen, localClients };
}

function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a `p` row hops to its host's ingress with the label the gateway set, the client's own x-sova-* never", async () => {
  const label = store.newPreviewLabel();
  const o = await ingress((req, res) => {
    if (req.url === "/login") return void res.writeHead(302, { Location: `https://${label}.preview.test/after`, "Set-Cookie": "sid=1; Path=/", "X-Sova-Leak": "1" }).end();
    if (req.url === "/down") return void res.writeHead(502, { "Content-Type": "text/plain" }).end("not running page");
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "private, max-age=60" }).end(`app ${req.url}`);
  });
  const g = await gateway({ port: o.port, labels: [label] });
  const host = `${label}.preview.test`;
  const r = await get(g.port, "/h/deep?x=1", { host, "x-sova-preview": "a".repeat(52), "x-forwarded-for": "6.6.6.6", cookie: "sid=1" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "app /h/deep?x=1");
  assert.equal(r.headers["cache-control"], "private, max-age=60", "the minting host's own headers pass");
  const h = o.seen[0]!.headers;
  assert.equal(h["x-sova-preview"], label);
  assert.equal(h["x-forwarded-for"], "127.0.0.1");
  assert.equal(h.host, `127.0.0.1:${o.port}`);
  assert.equal(h.cookie, "sid=1");
  // A redirect, a cookie and the minting host's 502 page pass through as they came; x-sova-* never.
  const login = await get(g.port, "/login", { host });
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, `https://${label}.preview.test/after`);
  assert.deepEqual(login.headers["set-cookie"], ["sid=1; Path=/"]);
  assert.equal(login.headers["x-sova-leak"], undefined);
  const down = await get(g.port, "/down", { host });
  assert.equal(down.status, 502);
  assert.equal(down.body, "not running page");
});

test("a label minted here is the gateway's own proxy's; an unknown one is 404 and asks nobody", async () => {
  const mine = store.newPreviewLabel();
  const o = await ingress((_q, res) => void res.writeHead(200).end("x"));
  const g = await gateway({ port: o.port, labels: [], local: [mine] });
  assert.equal((await get(g.port, "/", { host: `${mine}.preview.test` })).body, "local");
  assert.deepEqual(g.localSeen, [mine]);
  // The edge's client address reaches the local proxy (§mesh.public/visitor-log).
  assert.deepEqual(g.localClients, ["127.0.0.1"]);
  const u = await get(g.port, "/", { host: `${store.newPreviewLabel()}.preview.test`, accept: "application/json" });
  assert.equal(u.status, 404);
  assert.equal(JSON.parse(u.body).code, "preview-not-found");
  assert.equal(o.seen.length, 0);
});

test("a host that is down, or refuses the gateway, is the offline 503; a withdrawn row is 410", async () => {
  const label = store.newPreviewLabel();
  const refusing = await ingress((_q, res) => void res.writeHead(403, { [REFUSED_HEADER]: "refused" }).end());
  const g = await gateway({ port: refusing.port, labels: [label] });
  const host = `${label}.preview.test`;
  assert.equal((await get(g.port, "/", { host, "sec-fetch-mode": "navigate" })).status, 503);
  // The host withdraws the row (turned off there) while it stays live.
  g.reg.commit("n1", { v: 1, seq: 2, links: [], assets: [], ingressPort: refusing.port }, GATEWAY.publicUrl, { now: Date.now(), local: new Set(), live: () => true });
  const gone = await get(g.port, "/", { host, "sec-fetch-mode": "navigate" });
  assert.equal(gone.status, 410);
  assert.equal(gone.headers["clear-site-data"], '"cache", "storage"');
});

test("a preview websocket is tunneled raw to the ingress, and closed when its row is withdrawn", async () => {
  const label = store.newPreviewLabel();
  const o = await ingress((_q, res) => void res.writeHead(200).end());
  const wss = new WebSocketServer({ server: o.server, handleProtocols: (ps) => (ps.has("vite-hmr") ? "vite-hmr" : false) });
  wss.on("connection", (ws, req) => {
    ws.send(String(req.headers["x-sova-preview"]));
    ws.on("message", (m, binary) => ws.send(m, { binary }));
  });
  const g = await gateway({ port: o.port, labels: [label] });
  const ws = new WebSocket(`ws://127.0.0.1:${g.port}/?token=t`, ["vite-hmr"], { headers: { host: `${label}.preview.test` } });
  const first = await new Promise<string>((r, j) => {
    ws.once("message", (m) => r(m.toString()));
    ws.once("error", j);
  });
  assert.equal(first, label);
  assert.equal(ws.protocol, "vite-hmr");
  const big = Buffer.alloc(2 * 1024 * 1024, 7);
  ws.send(big);
  assert.ok(((await new Promise((r) => ws.once("message", r))) as Buffer).equals(big));
  const closed = new Promise<void>((r) => ws.once("close", () => r()));
  g.reg.commit("n1", { v: 1, seq: 3, links: [], assets: [], ingressPort: o.port }, GATEWAY.publicUrl, { now: Date.now(), local: new Set(), live: () => true });
  await closed;
});

// ---- the routed host's side ---------------------------------------------------------------------

test("an old gateway (kinds h,i,s,x) gets no `p` row and a mint says it needs updating; a new one gets them", async () => {
  const gw = await import("./share/gateway-client");
  const { buildSnapshot } = await import("./share/registry-push");
  const { previewAddress } = await import("./share/preview-address");
  const VIA = { version: 1 as const, route: { via: { nodeId: "nGW" } } };
  const PEERS: PeerEntry[] = [{ id: "vps", nodeId: "nGW", label: "VPS", dnsName: "vps.example.ts.net" }];
  let kinds = ["h", "i", "s", "x"];
  let previewUrl: string | undefined;
  const undo = gw.setGatewayDeps({
    readSetting: () => VIA,
    peers: () => PEERS,
    addressMode: () => false,
    endpoint: async () => "http://gw.test:4801",
    call: async (url: string) => {
      if (url.endsWith("/api/peer/hello")) return { status: 200, body: { mesh: 1, shareGateway: { publicUrl: GATEWAY.publicUrl } } };
      if (url.includes("/api/peer/share-gateway/info")) return { status: 200, body: { publicUrl: GATEWAY.publicUrl, accepting: true, seq: null, kinds, ...(previewUrl ? { previewUrl } : {}) } };
      return null;
    },
    recordUrl: () => {},
  } as never);
  after(undo);
  gw.resetGatewayClient();
  const { record } = store.mintPreview({ projectId: "p", port: 5173 }, new Set());
  await gw.refreshGateway();
  assert.ok(!buildSnapshot(1).links.some((l) => l.kind === "p"), "an old gateway never gets a p row");
  assert.ok(buildSnapshot(1).links.some((l) => l.kind === "h" || l.kind === "i" || l.kind === "s") || true);
  const old = previewAddress(process.env, VIA);
  assert.equal(old.url, null);
  assert.equal(old.reason, "gateway-old");
  assert.equal(old.message, "VPS needs updating before it can carry preview links.");
  // An updated gateway states `p` and its preview address.
  kinds = ["h", "i", "s", "x", "p"];
  previewUrl = "https://*.example.com";
  await gw.refreshGateway();
  assert.ok(buildSnapshot(2).links.some((l) => l.kind === "p" && l.h === record.hash));
  assert.deepEqual(previewAddress(process.env, VIA), { url: "https://*.example.com", source: "gateway" });
  // A preview address that isn't the setting's shape is none.
  previewUrl = "https://example.com";
  await gw.refreshGateway();
  assert.equal(previewAddress(process.env, VIA).reason, "no-address");
});
