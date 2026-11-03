#!/usr/bin/env node
// prof-window: self and inclusive time per function in the LAST <secs> of a .cpuprofile (the
// measured phase of a feed.ts run started with `bun --cpu-prof`).
//   node scripts/bench-session-list/prof-window.mjs <file.cpuprofile> <secs> [top=40]
import { readFileSync } from "node:fs";
const [file, secs, top = "40"] = process.argv.slice(2);
const p = JSON.parse(readFileSync(file, "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
let t = p.startTime;
const times = p.timeDeltas.map((d) => (t += d));
const from = p.endTime - Number(secs) * 1e6;
const self = new Map(), incl = new Map();
let total = 0, idle = 0;
const key = (n) => `${n.callFrame.functionName || "(anon)"} ${(n.callFrame.url || "").replace(/^.*\/(server|shared|src|node_modules)\//, "$1/")}:${n.callFrame.lineNumber + 1}`;
p.samples.forEach((id, i) => {
  if (times[i] < from) return;
  const dt = (times[i + 1] ?? p.endTime) - times[i];
  const n = byId.get(id);
  total += dt;
  if (/^\((idle|program|garbage collector)\)$/.test(n.callFrame.functionName) && n.callFrame.functionName === "(idle)") { idle += dt; return; }
  self.set(key(n), (self.get(key(n)) ?? 0) + dt);
  const seen = new Set();
  for (let x = id; x !== undefined; x = parent.get(x)) {
    const k = key(byId.get(x));
    if (seen.has(k)) continue;
    seen.add(k);
    incl.set(k, (incl.get(k) ?? 0) + dt);
  }
});
const ms = (x) => (x / 1000).toFixed(0).padStart(7);
console.log(`window ${secs}s: busy ${ms(total - idle)} ms of ${ms(total)} ms`);
console.log("\n-- self --");
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(top))) console.log(ms(v), k);
console.log("\n-- inclusive --");
for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, Number(top) * 2)) console.log(ms(v), k);
