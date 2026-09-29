// The kill-9 fuzz's child (kill9.test.ts): opens a durable host on the given dirs, answers "write"
// effects (recording each run), and makes random acts until it is killed. Prints "ready <problems>"
// once open.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineOptions } from "../org-charts";
import { OrgHost } from "./index";
import { HOST_CHARTS } from "./test-chart";

const [root, seedArg] = process.argv.slice(2);
let seed = Number(seedArg) || 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const host = await OrgHost.open({
  orgId: "o1",
  workspaceDir: join(root!, "ws"),
  stateDir: join(root!, "state"),
  charts: HOST_CHARTS as unknown as EngineOptions["charts"],
});
host.effects.register("write", async (e) => {
  appendFileSync(join(root!, "effects.log"), `${e.key}\n`);
  return { wrote: e.key };
});
process.stdout.write(`ready ${JSON.stringify(host.problems())}\n`);

const sids = ["p/1", "p/2", "p/3"];
const events = ["count", "go", "gather/start", "gather/close", "wait", "count"];
for (;;) {
  const sid = sids[Math.floor(rnd() * sids.length)]!;
  if (!host.configuration(sid)) await host.start(sid, "host-probe", {}, { by: "operator" });
  const ev = events[Math.floor(rnd() * events.length)]!;
  const env = ev === "gather/start" && rnd() < 0.5 ? { by: "overseer", attended: false, holdMs: 5 } : { by: "operator" };
  await host.act(sid, ev, {}, env);
  await new Promise((r) => setTimeout(r, rnd() < 0.3 ? 2 : 0));
}
