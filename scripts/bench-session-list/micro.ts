// micro: the session list's build cost in process, no server. Times server/sessions-index.ts of a
// given source tree (this checkout, or a `git archive` of the baseline) over a copied agent dir:
//   cold      listSessions() first call (every file stat'ed and read)
//   warm-0    listSessions() again, nothing changed (past the reuse window)
//   warm-4    listSessions() after one line appended to each of 4 seeded files
//   tracked-0 / tracked-4   listSessionsTracked() with a tracker noting 0 / 4 dirty paths (when the
//             tree exports it)
// Each measure: CPU ms (process.cpuUsage user+system), wall ms, read() bytes (/proc/self/io rchar).
//
//   PI_CODING_AGENT_DIR=<copy> bun scripts/bench-session-list/micro.ts --src <tree> [--reps 5] [--label x] [--out f.json]
//
// It appends to files in the agent dir it is given, so it refuses one inside ~/.pi.

import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const AGENT = resolve(process.env.PI_CODING_AGENT_DIR ?? "");
const HOME_PI = join(homedir(), ".pi");
if (!process.env.PI_CODING_AGENT_DIR || AGENT === HOME_PI || AGENT.startsWith(HOME_PI + "/")) {
  console.error(`set PI_CODING_AGENT_DIR to a COPY of the agent dir (never inside ~/.pi): ${AGENT}`);
  process.exit(2);
}
const SRC = resolve(opt("src", ".")!);
const REPS = Number(opt("reps", "5"));
const LABEL = opt("label", SRC)!;
const SEED = 42;

const idx: any = await import(join(SRC, "server", "sessions-index.ts"));

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sessions(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "live") sessions(p, out); }
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}
const files = sessions(join(AGENT, "sessions")).sort();
const pick = rng(SEED);
const pool = files.filter((p) => { const s = statSync(p).size; return s > 100_000 && s < 8_000_000; });
const targets: string[] = [];
while (targets.length < 4 && pool.length) targets.push(pool.splice(Math.floor(pick() * pool.length), 1)[0]!);
const line = (p: string) => {
  // A real message line of that file, re-stamped: the shape the agent writes.
  const ls = readFileSync(p, "utf8").split("\n").filter((l) => l.startsWith('{"type":"message"') && l.length < 32_000);
  const e = JSON.parse(ls[ls.length - 1] ?? '{"type":"message","message":{"role":"user","content":"x"}}');
  e.id = Math.floor(pick() * 0xffffffff).toString(16).padStart(8, "0");
  e.timestamp = new Date().toISOString();
  return JSON.stringify(e) + "\n";
};

const rchar = () => Number(/rchar: (\d+)/.exec(readFileSync("/proc/self/io", "utf8"))![1]);
async function measure(fn: () => Promise<unknown>) {
  const c0 = process.cpuUsage(), t0 = performance.now(), r0 = rchar();
  const rows: any = await fn();
  const c = process.cpuUsage(c0);
  return { cpuMs: (c.user + c.system) / 1000, wallMs: performance.now() - t0, readMB: (rchar() - r0) / 1e6, rows: Array.isArray(rows) ? rows.length : null };
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reuse = (idx.LIST_REUSE_MS ?? 1000) + 100;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const results: Record<string, any[]> = { cold: [], "warm-0": [], "warm-4": [], "tracked-0": [], "tracked-4": [] };
results.cold.push(await measure(() => idx.listSessions()));
for (let i = 0; i < REPS; i++) {
  await pause(reuse);
  results["warm-0"].push(await measure(() => idx.listSessions()));
  for (const t of targets) appendFileSync(t, line(t));
  await pause(reuse);
  results["warm-4"].push(await measure(() => idx.listSessions()));
}
if (typeof idx.listSessionsTracked === "function" && typeof idx.trackSessionFiles === "function") {
  const tr = idx.trackSessionFiles();
  await idx.listSessionsTracked(); // the tracker's first (full) build
  for (let i = 0; i < REPS; i++) {
    results["tracked-0"].push(await measure(() => idx.listSessionsTracked()));
    for (const t of targets) { appendFileSync(t, line(t)); tr.note(t); }
    results["tracked-4"].push(await measure(() => idx.listSessionsTracked()));
  }
  tr.stop();
}

const summary: Record<string, any> = {};
for (const [k, xs] of Object.entries(results)) {
  if (!xs.length) continue;
  summary[k] = { n: xs.length, cpuMs: median(xs.map((x) => x.cpuMs)), wallMs: median(xs.map((x) => x.wallMs)), readMB: median(xs.map((x) => x.readMB)), rows: xs[0].rows };
}
const out = { label: LABEL, at: new Date().toISOString(), files: files.length, targets: targets.map((t) => t.slice(AGENT.length + 1)), reps: REPS, summary, results };
console.log(JSON.stringify({ label: LABEL, files: files.length, summary }, null, 2));
if (opt("out")) writeFileSync(opt("out")!, JSON.stringify(out, null, 2));
process.exit(0);
