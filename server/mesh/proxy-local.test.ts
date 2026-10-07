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
