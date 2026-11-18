import { dropScratchAgentDir, scratchAgentDir } from "../../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseTunnels, readTunnels, writeTunnels, type TunnelRecord } from "./state";

after(dropScratchAgentDir);

const rec: TunnelRecord = {
  mode: "quick",
  unit: "sova-tunnel-abc123-share",
  driver: "systemd",
  metricsPort: 41873,
  targetPort: 4802,
  origin: "https://a-b-c-d.trycloudflare.com",
  connectorId: "c1",
  epoch: 1794000000000,
  startedAt: 1794000000000,
  startedBy: "operator",
  previous: { origin: "https://old.trycloudflare.com", endedAt: 1793990000000 },
  autoRestarts: [1793990001000],
};

test("tunnels.json round-trips, 0600 in a 0700 folder, and is removed when no tunnel is left", () => {
  const file = join(scratchAgentDir, "sova", "tunnels", "tunnels.json");
  writeTunnels({ share: rec, "preview:5173": { ...rec, unit: "sova-tunnel-abc123-pv5173" } }, file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(scratchAgentDir, "sova", "tunnels")).mode & 0o777, 0o700);
  const r = readTunnels(file);
  assert.equal(r.kind, "ok");
  assert.deepEqual(r.kind === "ok" && r.file.tunnels.share, rec);
  writeTunnels({}, file);
  assert.equal(existsSync(file), false);
  assert.deepEqual(readTunnels(file), { kind: "missing" });
});

test("strict: one bad field fails the whole file (nothing is adopted from it)", () => {
  const good = JSON.parse(JSON.stringify({ version: 1, tunnels: { share: rec } }));
  assert.equal(parseTunnels(JSON.stringify(good)).ok, true);
  const breaks: [string, (o: any) => void][] = [
    ["not json", () => {}],
    ["version", (o) => (o.version = 2)],
    ["id", (o) => (o.tunnels["preview:abc"] = o.tunnels.share)],
    ["mode", (o) => (o.tunnels.share.mode = "self")],
    ["unit", (o) => (o.tunnels.share.unit = "a b")],
    ["driver", (o) => (o.tunnels.share.driver = "launchd")],
    ["port", (o) => (o.tunnels.share.metricsPort = 0)],
    ["origin", (o) => (o.tunnels.share.origin = "http://x.example")],
    ["restarts", (o) => (o.tunnels.share.autoRestarts = ["x"])],
  ];
  for (const [what, edit] of breaks) {
    const o = JSON.parse(JSON.stringify(good));
    edit(o);
    assert.equal(parseTunnels(what === "not json" ? "{" : JSON.stringify(o)).ok, false, what);
  }
  const file = join(scratchAgentDir, "sova", "tunnels", "bad.json");
  writeFileSync(file, "{");
  assert.equal(readTunnels(file).kind, "broken");
  assert.equal(readFileSync(file, "utf8"), "{", "a read never rewrites");
});
