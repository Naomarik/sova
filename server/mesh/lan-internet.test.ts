// Run: pnpm test -- server/mesh/lan-internet.test.ts
// An internet relay's rules that need no connection (§mesh.lan/accept-process, §mesh.lan/pairing):
// Sova's own listener never asks for the internet scope, and a dial pairing names a public relay
// only with the internet mark (this host's app, in-process, with nothing started: no dial happens).
// The accept process, the handoff and both channels end to end: lan-internet.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LanStatus } from "../../shared/mesh-lan";
import { testApp } from "./app-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-lan-net-unit-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { setIdentity } = await import("./localapi");
setIdentity({
  status: async () => {
    throw new Error("no tailscale here");
  },
  whois: async () => null,
});

const app = await testApp();
const { stopMesh } = await import("./index");
const { mintLanIdentity } = await import("./lan-cert");
// The mesh's link transfers probe tar when it starts: answered here, so no tar runs.
(await import("./links-transfer")).setTarAvailableForTest(true);

after(() => {
  stopMesh();
  rmSync(tmp, { recursive: true, force: true });
});

const api = async <T>(method: string, path: string, body?: unknown): Promise<[number, T]> => {
  const res = await app.request(path, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return [res.status, (await res.json()) as T];
};

test("Sova's own listener can't take a public address: lan.ts never asks for the internet scope", () => {
  const src = readFileSync(new URL("./lan.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /scope\s*:/, "only relay-accept/main.ts (through lan-accept.ts) passes it");
  assert.match(readFileSync(new URL("./lan-accept.ts", import.meta.url), "utf8"), /scope: "internet"/);
});

test("a dial pairing may name a public relay only with the internet mark", async () => {
  const stranger = mintLanIdentity();
  const [bad, why] = await api<{ error: string }>("POST", "/api/mesh/lan/pairings", { id: "vps", role: "dial", pin: stranger.pin, host: "203.0.113.10", port: 4803 });
  assert.equal(bad, 400);
  assert.match(why.error, /public address/);
  const [no, r] = await api<{ error: string }>("POST", "/api/mesh/lan/pairings", { id: "vps", role: "accept", pin: stranger.pin, internet: true });
  assert.equal(no, 400, JSON.stringify(r));
  const [ok, st] = await api<LanStatus>("POST", "/api/mesh/lan/pairings", { id: "vps", role: "dial", pin: stranger.pin, host: "203.0.113.10", port: 4803, internet: true });
  assert.equal(ok, 200, JSON.stringify(st));
  assert.equal(st.pairings.find((p) => p.id === "vps")?.internet, true);
  const [gone] = await api("DELETE", "/api/mesh/lan/pairings/vps");
  assert.equal(gone, 200);
});
