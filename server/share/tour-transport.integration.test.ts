import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createShareServer, REQUESTS_PER_MINUTE, TOUR_IMAGE_REQUESTS_PER_MINUTE } from "./edge";
import { createGatewayRouter } from "./router";
import { GatewayRegistry } from "./registry";
import { digest } from "../tours/assets";
import { TOUR_LIMITS } from "../../shared/tour";

const token = (c: string) => c.repeat(43), handle = "tr_" + "d".repeat(16);
async function listen(server: Server): Promise<number> { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return (server.address() as AddressInfo).port; }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
test("tour images have their own bounded address bucket, independent of page and photo traffic", async () => {
  const edge = createShareServer({ client: () => "fixture-client", dispatch: (_req, res) => { res.writeHead(200); res.end("ok"); } });
  const port = await listen(edge), base = `http://127.0.0.1:${port}`;
  const paths = [`/api/t/${token("a")}/assets/desktop.png`, `/api/h/${token("b")}/tours/${handle}/assets/phone.png`, `/api/i/${token("c")}/c/k_abcdefgh/tours/${handle}/assets/desktop.png`];
  try {
    for (let i = 0; i < REQUESTS_PER_MINUTE + 1; i++) { const r = await fetch(base + paths[i % paths.length]!); await r.arrayBuffer(); assert.equal(r.status, 200, "tour pictures do not exhaust the 60/min page bucket"); }
    for (let i = 0; i < REQUESTS_PER_MINUTE; i++) { const r = await fetch(`${base}/api/t/${token("a")}`); await r.arrayBuffer(); assert.equal(r.status, 200); }
    const limitedPage = await fetch(`${base}/api/t/${token("a")}`); assert.equal(limitedPage.status, 429); await limitedPage.arrayBuffer();
    const photo = await fetch(`${base}/api/h/${token("b")}/img/0`); assert.equal(photo.status, 200); await photo.arrayBuffer();
    for (let i = REQUESTS_PER_MINUTE + 1; i < TOUR_IMAGE_REQUESTS_PER_MINUTE; i++) { const r = await fetch(base + paths[i % paths.length]!); await r.arrayBuffer(); assert.equal(r.status, 200); }
    const limitedImage = await fetch(base + paths[0]!); assert.equal(limitedImage.status, 429); await limitedImage.arrayBuffer();
  } finally { await close(edge); }
});
test("t/h/i tour hops keep their independent 15MiB cap, forward PUT bodies, and never pass a partial picture as whole", async () => {
  const root = mkdtempSync(join(tmpdir(), "tour-hop-"));
  let mode: "picture" | "over-cap" | "partial" = "picture", writes = 0;
  const picture = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
  const origin = createServer((req, res) => {
    if (req.method === "PUT") {
      let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => { writes++; res.setHeader("Content-Type", "application/json"); res.end(body); }); return;
    }
    res.setHeader("Content-Type", "image/png");
    if (mode === "over-cap") { res.writeHead(200, { "Content-Length": TOUR_LIMITS.assetBytes + 1 }); res.flushHeaders(); return; }
    if (mode === "partial") { res.writeHead(200, { "Content-Length": 10000 }); res.write("partial"); setImmediate(() => res.destroy()); return; }
    res.writeHead(200, { "Content-Length": picture.length, "Set-Cookie": "untrusted=1" }); res.end(picture);
  });
  const originPort = await listen(origin), now = Date.now(), reg = new GatewayRegistry({ file: () => join(root, "registry.json") });
  const links = (["t", "h", "i"] as const).map((kind, i) => ({ h: digest(token(["a", "b", "c"][i]!)), kind, exp: now + 60_000 }));
  assert.ok(reg.commit("host", { v: 1, seq: 1, ingressPort: originPort, assets: [], links }, "https://share.example.com", { now, local: new Set(), live: () => true }).ok);
  const router = createGatewayRouter({ registry: reg, setting: () => ({ publicUrl: "https://share.example.com", front: "caddy", sharePort: 4802, acceptFrom: "all" }), peers: () => [{ id: "fixture", nodeId: "host", label: "Fixture", dnsName: "host.invalid" }], resolve: async () => "127.0.0.1", preflight: async () => true, isLocal: () => false, strip: () => ({}), local: { dispatch: (_req, res) => { res.writeHead(404); res.end(); }, upgrade: (_req, socket) => { socket.destroy(); } }, sweepMs: 0 });
  const edge = createShareServer({ dispatch: router.dispatch, upgrade: router.upgrade, client: () => "fixture-client" }), port = await listen(edge), base = `http://127.0.0.1:${port}`;
  const paths = [`/api/t/${token("a")}/assets/desktop.png`, `/api/h/${token("b")}/tours/${handle}/assets/desktop.png`, `/api/i/${token("c")}/c/k_abcdefgh/tours/${handle}/assets/desktop.png`];
  try {
    for (const path of paths) {
      const r = await fetch(base + path); assert.equal(r.status, 200); assert.equal((await r.arrayBuffer()).byteLength, picture.length, "tour image above ordinary 10MiB image cap remains complete"); assert.equal(r.headers.get("set-cookie"), null); assert.equal(r.headers.get("cache-control"), "no-store"); assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    }
    const body = JSON.stringify({ stepId: "draft", viewId: "overview", size: "phone" });
    const put = await fetch(`${base}/api/t/${token("a")}/progress`, { method: "PUT", body }); assert.equal(put.status, 200); assert.equal(await put.text(), body); assert.equal(writes, 1, "PUT body reaches its single authorized hop, never silently dropped");
    mode = "over-cap";
    const capped = await fetch(base + paths[0]!); assert.equal(capped.status, 503); await capped.arrayBuffer();
    mode = "partial";
    let complete = false;
    try { const r = await fetch(base + paths[0]!); const bytes = await r.arrayBuffer(); complete = r.status === 200 && bytes.byteLength > 0; } catch { /* failed load is the required result after headers */ }
    assert.equal(complete, false, "partial hop is never a successful complete picture");
  } finally { router.dispose(); await close(edge); await close(origin); rmSync(root, { recursive: true, force: true }); }
});
