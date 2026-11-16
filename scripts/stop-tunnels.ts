#!/usr/bin/env bun
// Stop every Cloudflare tunnel a Sova install left running (§mesh.tunnel/lifetime): for Sova stopped for
// good (a teardown, a removed install), whose tunnels would otherwise keep running, since Sova's own
// shutdown stops none. Through the tunnel records (<state root>/tunnels/tunnels.json) and each one's
// driver (its systemd unit, or the detached session it recorded, checked against its start time), never
// a process found by name. A record file that can't be read: the units of this state root's prefix.
// The downloaded cloudflared (<state root>/bin) is left alone.
//
//   bun scripts/stop-tunnels.ts [--agent-dir <dir>]     (default: $PI_CODING_AGENT_DIR, else ~/.pi/agent)
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const at = process.argv.indexOf("--agent-dir");
if (at !== -1) {
  const dir = process.argv[at + 1];
  if (!dir) {
    console.error("usage: bun scripts/stop-tunnels.ts [--agent-dir <dir>]");
    process.exit(2);
  }
  process.env.PI_CODING_AGENT_DIR = resolve(dir);
}

// After the agent dir is set: the state root and its unit prefix come from it.
const { readTunnels, writeTunnels } = await import("../server/share/tunnel/state");
const { envFileOf, exitFileOf, pidFileOf, tunnelsDir, tunnelsFile, tunnelUnitPrefix } = await import("../server/share/tunnel/units");
const { chooseTunnelDriver, tunnelDriver } = await import("../server/share/tunnel/manager");

const dir = tunnelsDir();
const systemd = (await chooseTunnelDriver({ ...process.env, SOVA_TUNNEL_DRIVER: "" })) === "systemd";
const r = readTunnels(tunnelsFile(dir));
let stopped = 0;
const forget = (unit: string) => {
  for (const f of [pidFileOf(unit, dir), exitFileOf(unit, dir), envFileOf(unit, dir)]) rmSync(f, { force: true });
};

if (r.kind === "ok") {
  for (const [id, rec] of Object.entries(r.file.tunnels)) {
    if (rec.driver === "systemd" && !systemd) {
      console.log(`left ${rec.unit} (${id}): no systemd user manager answers here`);
      continue;
    }
    await tunnelDriver(rec.driver, rec.mode, dir).stop(rec.unit);
    forget(rec.unit);
    console.log(`stopped ${rec.unit} (${id}${rec.origin ? `, ${rec.origin}` : ""})`);
    stopped++;
  }
  writeTunnels({}, tunnelsFile(dir));
} else if (r.kind === "broken") {
  console.log(`tunnels.json can't be read (${r.reason}): stopping the units of this state root's prefix`);
  for (const id of systemd ? (["systemd", "detached"] as const) : (["detached"] as const)) {
    const d = tunnelDriver(id, "quick", dir);
    for (const unit of await d.units(tunnelUnitPrefix())) {
      await d.stop(unit);
      forget(unit);
      console.log(`stopped ${unit}`);
      stopped++;
    }
  }
  writeTunnels({}, tunnelsFile(dir));
}
console.log(stopped ? `${stopped} tunnel${stopped === 1 ? "" : "s"} stopped` : "no tunnel was recorded as running");
