// A preview sent to a person on Cloudflare Free carries Free's note from its app's own tunnel (§app.outreach/links,
// q5): "still coming online" while that tunnel's address hasn't answered from outside, then "changes when this
// computer restarts". Real processes: the fake cloudflared, detached driver; the outside check is injected.
import { dropScratchAgentDir } from "../../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";

process.env.SOVA_QUICK_TUNNEL = "on";
process.env.SOVA_CLOUDFLARED = join(import.meta.dirname, "..", "..", "testing", "fake-cloudflared.mjs");
process.env.SOVA_TUNNEL_DRIVER = "detached";
delete process.env.SOVA_TUNNEL_VERIFY;
for (const k of ["SOVA_SHARE_PUBLIC_URL", "SOVA_SHARE_HOST", "SOVA_SHARE_PORT"]) delete process.env[k];

const { LINK_WARNINGS } = await import("../../../shared/public-links");
const store = await import("../../public-links");
const listener = await import("../listener");
const manager = await import("./manager");
const wiring = await import("./wiring");
const { mintPreview } = await import("../../preview-links");
const { RESOLVERS } = await import("../../outreach/links");

const apps: Server[] = [];
const ports: number[] = [];
after(async () => {
  wiring.stopTunnelWiring();
  for (const port of ports) await manager.stopTunnel({ kind: "preview", port }, "test over").catch(() => undefined);
  listener.stopShareListener();
  for (const a of apps) a.close();
  dropScratchAgentDir();
});

async function appPort(): Promise<number> {
  const a = createServer((_q, r) => r.end("the app"));
  await new Promise<void>((ok) => a.listen(0, "127.0.0.1", ok));
  apps.push(a);
  const port = (a.address() as AddressInfo).port;
  ports.push(port);
  return port;
}

test("a Free preview send: the note follows its app's tunnel, coming online then its restart note", async () => {
  await listener.startShareListener(process.env);
  await wiring.startTunnelWiring({ env: process.env });
  store.recordTunnelConsent();
  let answers = false;
  manager.configureTunnels({ verify: async () => (answers ? { ok: true } : { ok: false, error: "Couldn't connect" }) });

  for (const [name, passes, code] of [
    ["its address not yet answering from outside", false, "quick-verifying"],
    ["its address verified", true, "quick"],
  ] as const) {
    answers = passes;
    const port = await appPort();
    const { record } = mintPreview({ projectId: "proj", port, days: 1 }, new Set());
    const got = await RESOLVERS.preview.resolve({ orgId: "o1", personId: "p1", key: `k-${code}` }, { kind: "preview", preview: record.id });
    assert.match(got.url, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/_sova\/open\//, `${name}: a link at the app's own tunnel`);
    assert.equal(got.warning, LINK_WARNINGS[code], `${name}: Free's note`);
  }
});
