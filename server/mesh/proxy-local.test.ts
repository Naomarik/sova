// Run: pnpm exec tsx --test server/mesh/proxy-local.test.ts. localRequest, the guard of the
// operator's local routes (outreach, public links, preview links, mesh links): the operator's
// browser behind a generic reverse proxy (tailscale serve sets X-Forwarded-Host) is served, and a
// request another host's /peer/<id>/ proxy relays is refused, even when it lands on a main
// listener (a peer `url` pointing there), where nothing sets meshPeer.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import type { PeerEntry } from "./peers";
import { localRequest, proxyPeer } from "./proxy";

const guarded = new Hono();
guarded.get("/api/local", (c) => (localRequest(c) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404)));

let peer: Server;
let base = "";
before(async () => {
  peer = createServer(getRequestListener(guarded.fetch));
  await new Promise<void>((r) => peer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => peer.close(() => r())));

test("a browser behind a reverse proxy (only X-Forwarded-Host) is served", async () => {
  assert.equal((await fetch(`${base}/api/local`, { headers: { "X-Forwarded-Host": "host.example.ts.net:8443" } })).status, 200);
  assert.equal((await fetch(`${base}/api/local`)).status, 200);
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
});

test("a browser can't strip the relay's mark: sending its own header only refuses itself", async () => {
  assert.equal((await fetch(`${base}/api/local`, { headers: { "X-Sova-Relayed": "1" } })).status, 404);
});
