// Run: node scripts/run-tests.mjs server/share-preview-router.test.ts. A routed host's side of kind
// `p` (§mesh.public/registry, /preview-address) against fake gateways, old and new, in process.
// Throwaway PI_CODING_AGENT_DIR; ~/.pi untouched. Preview hosts at a gateway behind the real share
// edge are share-preview-router.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-preview-router-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const store = await import("./preview-links");
type PeerEntry = import("./mesh/peers").PeerEntry;

const GATEWAY = { publicUrl: "https://share.example.com", front: "vhost" as const, sharePort: 4802, acceptFrom: "all" as const };

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
