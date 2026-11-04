// Run: pnpm test -- server/mesh/create-cards.test.ts
// Mesh by a Create chat (§chat.create-mode/settings-cards): what `get` reads, and cards that only the person's click
// applies, through the same code the Mesh page's routes run. A peer's answers come over the test wire.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { testApp } from "./app-test-fixtures";
import { fakeWire } from "./peer-wire-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-mesh-cards-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_AUTH = "off";
mkdirSync(join(tmp, "agent", "sessions", "live"), { recursive: true });

const { setIdentity } = await import("./localapi");
setIdentity({
  status: async () => ({
    backendState: "Running",
    self: { nodeId: "nA", name: "a.lab", hostName: "a", os: "linux", online: true, tags: [], login: "me", addresses: ["127.0.0.1"] },
    peers: [{ nodeId: "nC", name: "c.lab", hostName: "c", os: "linux", online: true, tags: [], addresses: ["127.0.0.2"] }],
  }),
  whois: async () => null,
});

const wire = fakeWire();
const app = await testApp();
const { stopMesh } = await import("./index");
const { ownProtocol } = await import("./hello");
const { runCreateSettingsTool } = await import("../create-settings-run");
(await import("./links-transfer")).setTarAvailableForTest(true);

const FAKE = "http://127.0.0.1:47031";
wire.serve(FAKE, () => new Response(JSON.stringify({ mesh: 1, id: "b", label: "B", hostname: "b", version: "0", protocol: ownProtocol(), pi: "x", now: Date.now() }), { status: 200 }));

after(() => {
  stopMesh();
  wire.restore();
  rmSync(tmp, { recursive: true, force: true });
});

const PIN = "ABCDEF0123456789ABCDEF0123456789";
const chat = { sessionId: "c1", projectId: null, noProject: "No project." };
const page = (method: string, path: string, body: unknown) => app.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = async () => (await runCreateSettingsTool(chat, { op: "get" })).content[0]!.text;

describe("what a Create chat reads", () => {
  test("off: it says so", async () => {
    assert.match(await get(), /Mesh: off/);
  });

  test("each host's state and access, shell-level said plainly, and never a pin", async () => {
    const r = await page("PUT", "/api/mesh/peers", { peers: [{ id: "b", name: "b.lab", nodeId: "nB", url: FAKE, label: "Bee" }], grants: { b: "sessions" } });
    assert.equal(r.status, 200, await r.clone().text());
    const paired = await page("POST", "/api/mesh/lan/pairings", { id: "p", role: "accept", pin: PIN, grant: "presence" });
    assert.equal(paired.status, 200, await paired.clone().text());
    const text = await get();
    assert.match(text, /Mesh: on/);
    assert.match(text, /Bee \(b\): up; sessions access \(shell-level: it can run anything here\)/);
    assert.match(text, /\(p\): .*presence access.*paired, this computer is dialled/);
    assert.match(text, /Sync: /);
    assert.ok(!text.toUpperCase().includes(PIN), "the pin stays out");
    assert.ok(!/fingerprint/i.test(text), "so does this host's own");
  });
});
