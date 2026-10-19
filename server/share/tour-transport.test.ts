import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shareMayReach, TOUR_IMAGE_PATH } from "./edge";
import { routeOf } from "./router";
import { GatewayRegistry, localShareHashes } from "./registry";
import { buildSnapshot } from "./registry-push";
import { refreshGateway, resetGatewayClient, setGatewayDeps } from "./gateway-client";
import { digest } from "../tours/assets";

const token = "a".repeat(43), handle = "tr_" + "b".repeat(16);
test("share edge permits only scoped tour read/progress paths, never owner mutation or escaped paths", () => {
  const bases = [`/api/t/${token}`, `/api/h/${token}/tours/${handle}`, `/api/i/${token}/c/k_abcdefgh/tours/${handle}`];
  for (const base of bases) {
    assert.ok(shareMayReach("GET", base)); assert.ok(shareMayReach("GET", `${base}/assets/desktop.png`)); assert.ok(shareMayReach("HEAD", `${base}/assets/desktop.png`)); assert.ok(TOUR_IMAGE_PATH.test(`${base}/assets/desktop.png`));
    assert.equal(routeOf(`${base}/assets/desktop.png`)?.kind, base.includes("/api/t/") ? "t" : base.includes("/api/h/") ? "h" : "i");
    for (const file of ["../desktop.png", "%2e%2e/desktop.png", "desktop.svg", "desktop.PNG", "desktopXpng", "desktop.png/extra"]) assert.equal(shareMayReach("GET", `${base}/assets/${file}`), false, file);
    assert.equal(shareMayReach("POST", `${base}/shares`), false); assert.equal(shareMayReach("DELETE", base), false);
  }
  assert.ok(shareMayReach("PUT", `${bases[0]}/progress`)); assert.ok(shareMayReach("PUT", `${bases[1]}/progress`));
  assert.equal(shareMayReach("PUT", `${bases[2]}/progress`), false, "owner page is read-only");
  assert.ok(shareMayReach("POST", `${bases[0]}/readers`)); assert.equal(shareMayReach("POST", `${bases[1]}/readers`), false);
  assert.equal(shareMayReach("GET", `/api/tours/private/tour/editions/edition/assets/desktop.png`), false);
  assert.deepEqual(routeOf(`/t/${token}`), { kind: "t", token });
});
test("real t inventory negotiates exact target support without withholding existing h/i rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "tour-registry-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); const state = join(root, "agent", "sova"); mkdirSync(state, { recursive: true });
  const now = Date.now(), tHash = digest("tour-token"), hHash = digest("handoff-token"), iHash = digest("owner-token");
  const row = (hash: string) => ({ hash, expiresAt: new Date(now + 60_000).toISOString() });
  writeFileSync(join(state, "tour-shares.json"), JSON.stringify({ version: 1, links: [row(tHash)] }));
  writeFileSync(join(state, "baton-links.json"), JSON.stringify({ links: [row(hHash)] }));
  writeFileSync(join(state, "person-links.json"), JSON.stringify({ links: [row(iHash)] }));
  let kinds = ["h", "i", "s", "p"], name = "gateway.example.test";
  const undo = setGatewayDeps({ readSetting: () => ({ version: 1, route: { via: { nodeId: "gateway" } } }), peers: () => [{ id: "gateway", nodeId: "gateway", label: "Gateway", dnsName: name }], addressMode: () => false, endpoint: async () => "http://gateway.example.test:4801", call: async url => url.endsWith("/api/peer/hello") ? { status: 200, body: { mesh: 1, shareGateway: { publicUrl: "https://share.example.com" } } } : { status: 200, body: { publicUrl: "https://share.example.com", accepting: true, seq: null, kinds } }, recordUrl: () => {} });
  resetGatewayClient();
  try {
    await refreshGateway(); let snap = buildSnapshot(1, now);
    assert.deepEqual(new Set(snap.links.map(l => l.h)), new Set([hHash, iHash]), "old gateway receives all existing handoff and owner rows, no unsupported t");
    kinds = [...kinds, "t"]; await refreshGateway(); snap = buildSnapshot(2, now);
    assert.ok(snap.links.some(l => l.kind === "t" && l.h === tHash));
    name = "another-entry.example.test";
    assert.equal(buildSnapshot(3, now).links.some(l => l.kind === "t"), false, "another target entry cannot inherit t evidence");
    assert.ok(localShareHashes().has(tHash), "a peer cannot claim a locally minted tour hash");
    const reg = new GatewayRegistry({ file: () => join(root, "gateway-registry.json") });
    const current = { now, local: new Set<string>(), live: () => true };
    assert.ok(reg.commit("host", { v: 1, seq: 1, ingressPort: 4802, assets: [], links: [{ h: tHash, exp: now + 60_000, kind: "t" }] }, "https://share.example.com", current).ok);
    assert.ok(reg.lookup(tHash, "t", now, () => true)); assert.equal(reg.lookup(tHash, "h", now, () => true), null); assert.equal(reg.lookup(tHash, "t", now + 60_000, () => true), null);
  } finally { undo(); resetGatewayClient(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); }
});
