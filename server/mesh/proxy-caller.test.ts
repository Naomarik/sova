// Run: pnpm test -- server/mesh/proxy-caller.test.ts
// A chat's key never travels to another host (§app.command-audit/keys): a request this host relays
// to a peer loses x-sova-caller as it loses the token. A fake wire stands in for the peer (the
// fixtures of server/mesh/mesh.test.ts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { MeshHello } from "../../shared/protocol";
import { testApp } from "./app-test-fixtures";
import { fakeWire } from "./peer-wire-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-mesh-caller-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { setIdentity } = await import("./localapi");
setIdentity({
  status: async () => ({ backendState: "Running", self: { nodeId: "nA", name: "a.lab", hostName: "a", os: "linux", online: true, tags: [], login: "me", addresses: ["127.0.0.1"] }, peers: [] }),
  whois: async () => null,
});
const wire = fakeWire();
const app = await testApp();
const { stopMesh } = await import("./index");
const { ownProtocol } = await import("./hello");
(await import("./links-transfer")).setTarAvailableForTest(true); // as mesh.test.ts: no tar probe in the unit tier
after(() => {
  stopMesh();
  wire.restore();
  rmSync(tmp, { recursive: true, force: true });
});

const B = "http://127.0.0.1:47011";
let seen: Headers | null = null;
wire.serve(B, async (req) => {
  const url = new URL(req.url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/api/peer/hello") return json({ mesh: 1, id: "b", label: "B", hostname: "b", version: "0", protocol: ownProtocol(), pi: "x", now: 1 } satisfies MeshHello);
  seen = req.headers;
  return json({ ok: true });
});

test("a relayed request carries neither the token nor a chat's key", async () => {
  // No sync with the stand-in peer: only the one relayed request reaches it, and nothing after the test.
  const off = await app.request("/api/mesh/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sync: { settings: false, themes: false, extensions: false, logins: false } }) });
  assert.equal(off.status, 200);
  const put = await app.request("/api/mesh/peers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ peers: [{ id: "b", label: "B", nodeId: "nB", name: "127.0.0.1", url: B }] }) });
  assert.equal(put.status, 200);
  const res = await app.request("/peer/b/api/echo", { headers: { Host: "a.lab:4800", "X-Sova-Token": "t", "X-Sova-Caller": "a-chat-key-a-chat-key-a-chat-key", "X-Other": "kept" } });
  assert.equal(res.status, 200);
  assert.ok(seen, "the peer was reached");
  assert.equal(seen!.get("x-other"), "kept", "other headers pass");
  assert.equal(seen!.get("x-sova-token"), null);
  assert.equal(seen!.get("x-sova-caller"), null);
});
