// Run: pnpm exec tsx --test server/visitor-identity.test.ts. §mesh.public/visitor-log: the host's two
// switches (off by default; an odd file reads as off), preview visits through the minting host's
// proxy behind the real share edge (the visit cookie set once and never passed to the app, page
// loads vs assets, X-Forwarded-For only when asked), a session share open through the real share
// listener, the identity never in a visit log, no secret in either file, the Shares page join, and
// the 120-day prune. Fake apps on loopback, a throwaway PI_CODING_AGENT_DIR; ~/.pi untouched.
// Through real listeners (the share edge, its preview proxy, a fake app, HTTP and WebSockets): visitor-identity.integration.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-visitor-log-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sova"), { recursive: true });
process.env.SOVA_SHARE_DIST = join(root, "dist-share");
mkdirSync(process.env.SOVA_SHARE_DIST, { recursive: true });
writeFileSync(join(process.env.SOVA_SHARE_DIST, "index.html"), "<!doctype html><title>Shared</title>");
after(() => rmSync(root, { recursive: true, force: true }));

const { stateRoot } = await import("./state-root");
const { readVisitorLogging, writeVisitorLogging, VISITOR_LOGGING_FILE } = await import("./visitor-logging");
const identity = await import("./visitor-identity");
const visits = await import("./visits");
const { createShareServer } = await import("./share/edge");
const shareListener = await import("./share/listener");
const { createPreviewProxy, VISIT_COOKIE } = await import("./share/preview-proxy");
const { previewLabelOfHost, previewOrigin } = await import("./share/preview-address");
const store = await import("./preview-links");
const { sharesOverview } = await import("./shares-overview");
const ingress = await import("./share/ingress");
const { setIdentity } = await import("./mesh/localapi");

const ZONE_URL = "http://*.preview.test";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const CLIENT = "198.51.100.23";
const idFile = () => join(stateRoot(), identity.IDENTITY_FILE);
const pvFile = () => join(stateRoot(), visits.PREVIEW_VISITS_FILE);
const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const lines = (f: string) =>
  read(f)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  for (const f of [idFile(), pvFile(), join(stateRoot(), VISITOR_LOGGING_FILE)]) rmSync(f, { force: true });
  identity.resetVisitorIdentity();
  visits.resetVisitState();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => {
    server.close();
    server.closeAllConnections();
  });
  return (server.address() as AddressInfo).port;
}

/** A fake app that records the headers it got, answering 200 (or a redirect to its own localhost). */
async function app() {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    if (req.url === "/go") return void res.writeHead(302, { location: `http://localhost:${port}/next` }).end();
    res.writeHead(200, { "content-type": "text/html" }).end("ok");
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => ws.send(JSON.stringify(req.headers)));
  const port = await listen(server);
  return { port, seen };
}

/** The share edge with the preview split; the client address is CLIENT (as a front would report it). */
async function edge() {
  const proxy = createPreviewProxy({ origin: (l) => previewOrigin(ZONE_URL, l), sweepMs: 0 });
  after(() => proxy.dispose());
  const server = createShareServer({
    client: () => CLIENT,
    preview: {
      match: (req) => previewLabelOfHost(req.headers.host, ZONE_URL),
      dispatch: (req, res, label, client) => proxy.dispatch(req, res, label, client),
      upgrade: (req, socket, head, label, client) => proxy.upgrade(req, socket, head, label, client),
    },
  });
  return listen(server);
}

function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

const NAV = { "sec-fetch-mode": "navigate", accept: "text/html", "user-agent": CHROME, "accept-language": "en-GB,en;q=0.9" };
const cookieOf = (h: IncomingHttpHeaders) => (h["set-cookie"] ?? []).find((c) => c.startsWith(`${VISIT_COOKIE}=`));

// ---- the switches ----------------------------------------------------------------------------------

test("both switches are off by default; anything odd reads as off; a write is 0600", () => {
  assert.deepEqual(readVisitorLogging(), { logVisitors: false, forwardIp: false });
  const f = join(stateRoot(), VISITOR_LOGGING_FILE);
  for (const odd of ["{", "[]", "null", '{"version":2,"logVisitors":true,"forwardIp":true}', '{"version":1,"logVisitors":"yes","forwardIp":true}', '{"version":1,"logVisitors":true,"forwardIp":true,"extra":1}', '{"version":1,"logVisitors":true}']) {
    writeFileSync(f, odd);
    assert.deepEqual(readVisitorLogging(), { logVisitors: false, forwardIp: false }, odd);
  }
  assert.deepEqual(writeVisitorLogging({ logVisitors: true, forwardIp: false }), { logVisitors: true, forwardIp: false });
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { version: 1, logVisitors: true, forwardIp: false });
});

// ---- previews --------------------------------------------------------------------------------------

// ---- share links -----------------------------------------------------------------------------------

test("an org link's identity never reaches the workspace visits.jsonl", () => {
  writeVisitorLogging({ logVisitors: true, forwardIp: false });
  const dir = join(root, "org1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(stateRoot(), "orgs.json"), JSON.stringify({ version: 1, orgs: [{ id: "org1", dir }] }));
  const id = visits.recordOpen({ orgId: "org1", personId: "p1", sessionId: "s1", n: 1 }, { userAgent: CHROME });
  const req = { headers: { "user-agent": CHROME, "accept-language": "de" }, socket: { remoteAddress: "192.0.2.9" } } as unknown as IncomingMessage;
  identity.noteShareClient(req, "192.0.2.77");
  identity.noteShareVisit(id, { incoming: req });
  const ws = readFileSync(join(dir, visits.VISITS_FILE), "utf8");
  assert.ok(ws.includes(id!));
  for (const s of ["192.0.2", "Mozilla", '"ip"', '"ua"', '"lang"']) assert.ok(!ws.includes(s), s);
  assert.deepEqual(
    lines(idFile()).map((l) => [l.id, l.ip]),
    [[id, "192.0.2.77"]],
  );
});

// ---- retention -------------------------------------------------------------------------------------

test("prune drops identity and preview-visit lines older than 120 days, atomically, 0600", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const old = new Date(now - identity.RETENTION_MS - 1000).toISOString();
  const fresh = new Date(now - 1000).toISOString();
  writeFileSync(idFile(), [JSON.stringify({ id: "v_old", at: old, ip: "x", ua: "" }), "torn{", JSON.stringify({ id: "v_new", at: fresh, ip: "y", ua: "" })].join("\n") + "\n");
  writeFileSync(pvFile(), [JSON.stringify({ kind: "visit", id: "v_old", at: old, via: "preview", previewId: "pv_a", device: "Browser" }), JSON.stringify({ kind: "visit", id: "v_new", at: fresh, via: "preview", previewId: "pv_a", device: "Browser" })].join("\n") + "\n");
  assert.equal(identity.pruneVisitorLogs(now), 3);
  assert.deepEqual(lines(idFile()).map((l) => l.id), ["v_new"]);
  assert.deepEqual(lines(pvFile()).map((l) => l.id), ["v_new"]);
  assert.equal(statSync(idFile()).mode & 0o777, 0o600);
  assert.deepEqual(visits.readPreviewVisits("pv_a").map((v) => v.id), ["v_new"], "the fold follows the rewrite");
  assert.equal(identity.pruneVisitorLogs(now), 0);
});
