// Run: node scripts/run-tests.mjs server/share-offline.test.ts. A gateway's offline answer by route
// family (server/share/offline.ts) and the hello's gateway advertisement (server/mesh/hello.ts), in
// process with a throwaway PI_CODING_AGENT_DIR; ~/.pi untouched. The offline answers, the `/ws/h` hop
// and the advertisement read from peers over loopback are share-offline.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-offline-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const offline = await import("./share/offline");
const hello = await import("./mesh/hello");

const TOKEN = "B".repeat(43);

// ---- offline.ts -----------------------------------------------------------------------------------

test("offlineKind picks the answer by route family", () => {
  assert.equal(offline.offlineKind(`/h/${TOKEN}`), "page");
  assert.equal(offline.offlineKind(`/i/${TOKEN}`), "page");
  assert.equal(offline.offlineKind(`/api/h/${TOKEN}`), "api");
  assert.equal(offline.offlineKind(`/api/h/${TOKEN}/message`), "api");
  assert.equal(offline.offlineKind(`/api/i/${TOKEN}/p/q_abcdefgh`), "api");
  assert.equal(offline.offlineKind("/h/assets/index-abc.js"), "asset");
});

// ---- hello.ts -----------------------------------------------------------------------------------

test("the hello advertises the gateway only while this host is one, outside the fingerprint", () => {
  const self = { id: "a", label: "A" };
  const file = join(root, "agent", "sova", "public-links.json");
  mkdirSync(join(root, "agent", "sova"), { recursive: true });
  const plain = hello.ownHello(self);
  assert.equal("shareGateway" in plain, false, "no setting: nothing advertised");
  const gateway = { publicUrl: "https://share.example.com", front: "caddy", sharePort: 4802, acceptFrom: "all" };
  writeFileSync(file, JSON.stringify({ version: 1, route: "self", gateway }));
  const gw = hello.ownHello(self);
  assert.deepEqual(gw.shareGateway, { publicUrl: "https://share.example.com" });
  assert.equal(gw.protocol, plain.protocol, "the fingerprint is unchanged");
  // Kept but not selected: a routed host (or off) advertises nothing.
  writeFileSync(file, JSON.stringify({ version: 1, route: "off", gateway, pad: 1 }));
  assert.equal("shareGateway" in hello.ownHello(self), false);
  writeFileSync(file, "{ not json");
  assert.equal("shareGateway" in hello.ownHello(self), false, "an unreadable setting advertises nothing");
  rmSync(file);
});
