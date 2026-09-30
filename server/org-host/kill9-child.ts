// The kill-9 fuzz's child (kill9.test.ts): opens a durable host on the given dirs, answers "write"
// effects (recording each run), and makes random acts until it is killed. Prints "ready <problems>"
// once open, and "acted" once it has committed 5 acts (the parent kills only after that line, so every
// round adds rows whatever the machine's load). The very first round opens with a scripted prologue:
// an effect answered and an act held.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineOptions } from "../org-charts";
import { OrgHost } from "./index";
import { HOST_STATECHARTS } from "./test-chart";

const [root, seedArg] = process.argv.slice(2);
let seed = Number(seedArg) || 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const host = await OrgHost.open({
  orgId: "o1",
  workspaceDir: join(root!, "ws"),
  stateDir: join(root!, "state"),
  charts: HOST_STATECHARTS as unknown as EngineOptions["charts"],
});
host.effects.register("write", async (e) => {
  appendFileSync(join(root!, "effects.log"), `${e.key}\n`);
  return { wrote: e.key };
});
process.stdout.write(`ready ${JSON.stringify(host.problems())}\n`);

if (!host.configuration("p/9")) {
  await host.start("p/9", "host-probe", {}, { by: "operator" });
  await host.act("p/9", "go", {}, { by: "operator" }, { settle: true });
  await host.act("p/9", "gather/start", {}, { by: "overseer", attended: false, holdMs: 5 });
}

const sids = ["p/1", "p/2", "p/3"];
let committed = 0;
const events = ["count", "go", "gather/start", "gather/close", "wait", "count"];
for (;;) {
  const sid = sids[Math.floor(rnd() * sids.length)]!;
  if (!host.configuration(sid)) await host.start(sid, "host-probe", {}, { by: "operator" });
  const ev = events[Math.floor(rnd() * events.length)]!;
  const env = ev === "gather/start" && rnd() < 0.5 ? { by: "overseer", attended: false, holdMs: 5 } : { by: "operator" };
  const r = await host.act(sid, ev, {}, env);
  if (r.taken || r.refusal) committed++;
  if (committed === 5) process.stdout.write("acted\n");
  await new Promise((r) => setTimeout(r, rnd() < 0.3 ? 2 : 0));
}
