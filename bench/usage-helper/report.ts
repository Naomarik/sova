// Renders the benchmark results (run.ts --out files) as markdown tables: one comparison table and
// the memory-over-time table per phase.
//
//   bun bench/usage-helper/report.ts <results dir>
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "tmp/usage-team/bench-results/v2";
type R = Record<string, any>;
const runs: R[] = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as R);
const ORDER = ["idle", "steady", "x10", "x100", "burst", "rollover", "catchup"];
runs.sort((a, b) => ORDER.indexOf(a.scenario) - ORDER.indexOf(b.scenario) || a.helper.localeCompare(b.helper));

const q = (r: R, k: string) => r.load?.queryMs?.[k];
const ms = (x: R | undefined) => (x ? `${x.p50} / ${x.p95} / ${x.max}` : "–");
const lines: string[] = [];
lines.push("| scenario | helper | records folded | settle after gen (ms) | helper CPU mean / p95 / max % | CPU µs/record | RSS idle → steady → peak MB | costs:30d p50/p95/max ms | session p50/p95/max ms | server ELD p99 / max ms | server append p50 / p99 µs | start (ready ms, records) | verdict |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of runs) {
  const L = r.load ?? {};
  lines.push(
    `| ${r.scenario} | ${r.helper} | ${L.linesFolded ?? "–"} | ${L.settleAfterGenMs ?? "–"} | ${L.helperCpuPct ? `${L.helperCpuPct.mean} / ${L.helperCpuPct.p95} / ${L.helperCpuPct.max}` : `idle ${r.idle?.cpuPct}`} | ${L.cpuUsPerRecord ?? "–"} | ${r.idle?.rssMb} → ${L.rssMb?.steady ?? "–"} → ${Math.max(r.end?.peakRssMb ?? 0, L.rssMb?.peak ?? 0)} | ${ms(q(r, "costs:30d"))} | ${ms(q(r, "session"))} | ${L.serverLoop ? `${L.serverLoop.eldP99Ms} / ${L.serverLoop.eldMaxMs}` : "–"} | ${L.serverLoop ? `${L.serverLoop.appendUsP50} / ${L.serverLoop.appendUsP99}` : "–"} | ${r.start.readyMs}, ${r.start.records} | ${r.verdict === "pass" ? "pass" : `FAIL: ${r.verdict.fail.join("; ")}`} |`,
  );
}
lines.push("", "Cold queries on the settled ledger (first / p50 ms):", "", "| scenario | helper | costs:7d | costs:30d | costs:all | today | session |", "|---|---|---|---|---|---|---|");
for (const r of runs) {
  const c = r.queries;
  const f = (k: string) => (c[k] ? `${c[k].first} / ${c[k].p50}` : "–");
  lines.push(`| ${r.scenario} | ${r.helper} | ${f("costs:7d")} | ${f("costs:30d")} | ${f("costs:all")} | ${f("today")} | ${f("session")} |`);
}
lines.push("", "Memory over time (RSS MB; slope fitted after each phase's first 10 s; series = every 5th second):", "", "| scenario | helper | phase | s | slope MB/min | min–max MB | CPU % | verdict | series |", "|---|---|---|---|---|---|---|---|---|");
for (const r of runs) {
  for (const [name, p] of Object.entries(r.memory ?? {}) as [string, R][]) {
    lines.push(`| ${r.scenario} | ${r.helper} | ${name} | ${p.seconds} | ${p.slopeMbMin} | ${p.minMb}–${p.maxMb} | ${p.cpuPct} | ${p.verdict ?? ""} | ${p.series.join(" ")} |`);
  }
}
process.stdout.write(`${lines.join("\n")}\n`);
