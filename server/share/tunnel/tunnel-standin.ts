// A stand-in server for the tunnel integration tests: it runs the tunnel manager as the server would,
// with the fake cloudflared (SOVA_CLOUDFLARED) and no share listener (the target is a fixed port the
// fake never dials). Never run on the live agent dir: PI_CODING_AGENT_DIR must name a scratch dir.
//
//   bun server/share/tunnel/tunnel-standin.ts start   adopt, ensure the share tunnel, print each status as a JSON line, then hold
//   bun server/share/tunnel/tunnel-standin.ts adopt   adopt, print the share tunnel's status, exit
//   bun server/share/tunnel/tunnel-standin.ts stop    adopt, stop the share tunnel, print its status, exit
//
// STANDIN_WANTED=1: the share tunnel is wanted (an ended one starts again). STANDIN_ACCOUNT_TOKEN: run the
// share tunnel as Account (https://share.example.com) from that token. Turn On counts as given. SOVA_TUNNEL_DRIVER and
// SOVA_TUNNEL_SLICE choose the driver and slice, as for the server.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { adoptTunnels, configureTunnels, ensureTunnel, onTunnelChanged, stopTunnel, tunnelStatus } from "./manager";

const [mode] = process.argv.slice(2);
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? "");
if (!process.env.PI_CODING_AGENT_DIR || agentDir.startsWith(join(homedir(), ".pi"))) {
  console.error("tunnel-standin: PI_CODING_AGENT_DIR must name a scratch dir outside ~/.pi");
  process.exit(2);
}
const SHARE = { kind: "share" } as const;
const print = (what: string) => console.log(JSON.stringify({ what, ...tunnelStatus(SHARE) }));

configureTunnels({
  shareTarget: async (recorded) => recorded ?? 4899,
  shareWanted: () => process.env.STANDIN_WANTED === "1",
  shareMode: () => (process.env.STANDIN_ACCOUNT_TOKEN ? "account" : "quick"),
  account: () => (process.env.STANDIN_ACCOUNT_TOKEN ? { token: process.env.STANDIN_ACCOUNT_TOKEN, publicUrl: "https://share.example.com" } : null),
  quickAllowed: () => true,
  log: (l) => console.error(`[standin] ${l}`),
});

if (mode === "start") {
  onTunnelChanged(() => print("changed"));
  await adoptTunnels();
  const s = await ensureTunnel(SHARE, { by: "standin", waitMs: 30_000 });
  console.log(JSON.stringify({ what: "ensured", ...s }));
  // Hold, as a server does, until killed.
  setInterval(() => {}, 1 << 30);
} else if (mode === "adopt") {
  await adoptTunnels();
  print("adopted");
} else if (mode === "stop") {
  await adoptTunnels();
  await stopTunnel(SHARE, "standin");
  print("stopped");
} else throw new Error(`unknown mode ${mode}`);
