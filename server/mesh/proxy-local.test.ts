// Run: pnpm test -- server/mesh/proxy-local.test.ts
// localRequest, the guard of the operator's local routes (outreach, public links, preview links,
// mesh links): the operator's browser behind a generic reverse proxy (tailscale serve sets
// X-Forwarded-Host) is served, and a request another host's /peer/<id>/ proxy relays is refused,
// even when it lands on a main listener (a peer `url` pointing there), where nothing sets meshPeer.
// In-process: the guarded app is called directly, and the relay reaches it over the test wire.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Hono } from "hono";
import type { PeerEntry } from "./peers";
import { fakeWire } from "./peer-wire-test-fixtures";
import { localRequest, proxyPeer } from "./proxy";

const guarded = new Hono();
guarded.get("/api/local", (c) => (localRequest(c) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404)));

// The main listener the peer `url` points at: answered by the guarded app itself.
const base = "http://127.0.0.1:47011";
const wire = fakeWire();
wire.serve(base, (req) => guarded.fetch(req));
after(() => wire.restore());

test("a browser behind a reverse proxy (only X-Forwarded-Host) is served", async () => {
  assert.equal((await guarded.request(`${base}/api/local`, { headers: { "X-Forwarded-Host": "host.example.ts.net:8443" } })).status, 200);
  assert.equal((await guarded.request(`${base}/api/local`)).status, 200);
});

test("the peer listener (meshPeer) is refused", async () => {
  assert.equal((await guarded.request("/api/local", {}, { meshPeer: { id: "p" } })).status, 404);
});

test("a request relayed by proxyPeer is refused, even on a main listener", async () => {
  const relay = new Hono();
  const b: PeerEntry = { id: "b", nodeId: "nB", label: "b", dnsName: "b.invalid", url: base };
  relay.get("/peer/b/*", (c) => proxyPeer(c, b, "/api/local"));
  const res = await relay.request("http://serving.host/peer/b/api/local");
  assert.equal(res.status, 404);
  assert.ok(wire.sent.some((r) => new URL(r.url).pathname === "/api/local"), "it did reach the main listener");
});

test("a browser can't strip the relay's mark: sending its own header only refuses itself", async () => {
  assert.equal((await guarded.request(`${base}/api/local`, { headers: { "X-Sova-Relayed": "1" } })).status, 404);
});

// A tailnet peer's REST answers reach this host's browser origin hardened, as a pairing's do
// (§mesh.remote-sessions/proxy): a peer can't run script, set a cookie, register a worker or redirect here.
test("a tailnet peer's answers through /peer are hardened; JSON and raster images pass unchanged", async () => {
  const origin = "http://127.0.0.1:47012";
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  wire.serve(origin, (req) => {
    const path = new URL(req.url).pathname;
    const evil = { "set-cookie": "sova=x; Path=/", "service-worker-allowed": "/", location: "https://evil.example/", "access-control-allow-origin": "*", "clear-site-data": "\"*\"" };
    if (path === "/api/html") return new Response(new TextEncoder().encode("<script>alert(1)</script>"), { headers: { "content-type": "text/html", ...evil } });
    if (path === "/api/svg") return new Response(new TextEncoder().encode("<svg/>"), { headers: { "content-type": "image/svg+xml" } });
    if (path === "/api/redirect") return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    if (path === "/api/json") return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    if (path === "/api/png") return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
    if (path === "/api/zip") return new Response(new Uint8Array([80, 75]), { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="notes.zip"' } });
    if (path === "/api/lock") return Response.json({ error: "locked" }, { status: 401 });
    if (path === "/api/hidden") return Response.json({ error: "denied" }, { status: 403, headers: { "x-sova-mesh": "denied" } });
    return Response.json({ error: "Not found" }, { status: 404 });
  });
  const b: PeerEntry = { id: "b", nodeId: "nB", label: "b", dnsName: "b.invalid", url: origin };
  const relay = new Hono();
  relay.get("/peer/b/*", (c) => proxyPeer(c, b, new URL(c.req.url).pathname.slice("/peer/b".length)));
  const get = (path: string) => relay.request(`http://serving.host/peer/b${path}`);

  for (const path of ["/api/html", "/api/svg"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("content-type"), "application/octet-stream", path);
    assert.equal(res.headers.get("content-disposition"), "attachment", path);
    assert.equal(res.headers.get("content-security-policy"), "sandbox; default-src 'none'", path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
    for (const h of ["set-cookie", "service-worker-allowed", "location", "access-control-allow-origin", "clear-site-data"]) assert.equal(res.headers.get(h), null, `${path} ${h}`);
  }
  const moved = await get("/api/redirect");
  assert.equal(moved.headers.get("location"), null, "a redirect sends the browser nowhere");

  const json = await get("/api/json");
  assert.match(json.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.equal(json.headers.get("cache-control"), "no-store");
  assert.deepEqual(await json.json(), { ok: true });

  const image = await get("/api/png");
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("content-disposition"), null);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);

  const zip = await get("/api/zip");
  assert.equal(zip.headers.get("content-type"), "application/octet-stream");
  assert.equal(zip.headers.get("content-disposition"), 'attachment; filename="notes.zip"', "the peer's own file name is kept");

  assert.equal((await get("/api/lock")).status, 502, "a peer's 401 is never this page's lock-out");
  const hidden = await get("/api/hidden");
  assert.equal(hidden.status, 403);
  assert.equal(hidden.headers.get("x-sova-mesh"), "denied", "the hidden marker passes");
});
