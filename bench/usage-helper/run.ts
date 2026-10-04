// The usage helper benchmark driver. It plays the server: starts a helper (the Bun one, or the Rust
// one on the same files and protocol) through server/usage-helper/client.ts, relays queries to it
// the way the routes do (bytes only), appends the server's own records, and measures its own event
// loop delay; a separate generator process (gen.ts) plays ~50 agents writing records.
//
//   bun bench/usage-helper/run.ts --helper bun|rust --scenario <name> [--out <file.json>]
//
// Scenarios: idle, steady (real peak, ~17 records/s), x10, x100, burst (x10 plus 5000 at once
// every 10 s), rollover (x10 across UTC midnight), catchup (30 days written while the helper was
// down, 40k records a day, then a start). Results: one JSON object (stdout and --out).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { appendUsageRecord } from "../../pi-config/extensions/llm-inflight/usage-record";
import { startUsageHelper, runtimeCommand, type UsageHelper } from "../../server/usage-helper/client";

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};
const which = opt("helper", "bun")!;
const scenario = opt("scenario", "steady")!;
const ROOT = path.join(import.meta.dirname, "..", "..");
const work = path.join(ROOT, "tmp", "bench", `${which}-${scenario}-${process.pid}`);
const agentDir = path.join(work, "agent");
fs.mkdirSync(path.join(agentDir, "sova"), { recursive: true });
// Both helpers start from the same price file (the Bun one would write this starter copy itself).
fs.copyFileSync(path.join(ROOT, "shared", "model-prices", "seed.json"), path.join(agentDir, "sova", "model-prices.json"));

const RUST_BIN = path.join(ROOT, "bench", "usage-helper", "rust", "target", "release", "usage-helper-rs");
const command = which === "rust" ? { exe: RUST_BIN, args: [] } : runtimeCommand(path.join(ROOT, "server", "usage-helper", "main.ts"));
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, SOVA_PRICES_FETCH: "off", SOVA_USAGE_ALIASES: path.join(ROOT, "shared", "model-prices", "aliases.json") };

const CLK_TCK = 100;
function procStat(pid: number): { cpuMs: number; rssKb: number; hwmKb: number } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const cpuMs = ((Number(f[11]) + Number(f[12])) * 1000) / CLK_TCK;
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(status)?.[1] ?? 0);
    return { cpuMs, rssKb: kb("VmRSS"), hwmKb: kb("VmHWM") };
  } catch {
    return null;
  }
}

function gen(extra: string[]): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(import.meta.dirname, "gen.ts"), "--agent-dir", agentDir, ...extra], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out.trim().split("\n").pop()!)) : reject(new Error(`gen exited ${code}`))));
  });
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const r1 = (n: number) => Math.round(n * 10) / 10;

async function ask(h: UsageHelper, op: string, params: Record<string, unknown> = {}) {
  const t = performance.now();
  const a = await h.request(op, params);
  return { ms: performance.now() - t, status: a.status, bytes: a.body.length, body: a.body };
}

async function stats(h: UsageHelper): Promise<{ records: number; duplicates: number }> {
  const a = await h.request("stats");
  return a.status === 200 ? JSON.parse(a.body.toString()) : { records: -1, duplicates: -1 };
}

async function waitReady(h: UsageHelper, ms = 600_000): Promise<number> {
  const t = performance.now();
  while (performance.now() - t < ms) {
    if (h.running() && (await h.request("stats")).status === 200) return performance.now() - t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("helper never answered");
}

const result: Record<string, unknown> = { helper: which, scenario, at: new Date().toISOString(), runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}` };

const live: Record<string, string[]> = {
  idle: [],
  steady: ["--rate", "17", "--seconds", "60"],
  x10: ["--rate", "170", "--seconds", "60"],
  x100: ["--rate", "1700", "--seconds", "60"],
  burst: ["--rate", "170", "--seconds", "60", "--burst", "5000"],
  rollover: ["--rate", "170", "--seconds", "60", "--clock", new Date(Math.floor(Date.now() / 86_400_000 + 1) * 86_400_000 - 30_000).toISOString()],
};

// A history to query against: 30 days of real-peak volume (also the cold catch-up's input).
const historyDays = Number(opt("history-days", scenario === "catchup" ? "30" : "7"));
const perDay = Number(opt("per-day", "40000"));
if (historyDays > 0) result.history = await gen(["--backfill-days", String(historyDays), "--per-day", String(perDay), "--tag", "h"]);

const eld = monitorEventLoopDelay({ resolution: 1 });
const spawnAt = performance.now();
const h = startUsageHelper({ env, command, log: (l) => console.error(l) });
// The leak watch (tmp/usage-team/standing-bench-requirements.md): RSS and CPU every second for the
// whole run, tagged by phase; a hard RSS cap and wall-time cap kill the helper and fail the run.
const RSS_CAP_MB = Number(opt("rss-cap-mb", "3072"));
const WALL_CAP_MS = Number(opt("wall-cap-min", "20")) * 60_000;
let phase = "start";
const series: { t: number; phase: string; rssMb: number; cpuMs: number }[] = [];
const failures: string[] = [];
const kill = (why: string) => {
  failures.push(why);
  const p = h.pid();
  if (p) process.kill(p, "SIGKILL");
  void h.stop();
};
const t00 = performance.now();
const watcher = setInterval(() => {
  const p = h.pid();
  const s = p ? procStat(p) : null;
  if (!s) return;
  series.push({ t: Math.round((performance.now() - t00) / 1000), phase, rssMb: r1(s.rssKb / 1024), cpuMs: s.cpuMs });
  if (s.rssKb / 1024 > RSS_CAP_MB) kill(`RSS ${Math.round(s.rssKb / 1024)} MB over the ${RSS_CAP_MB} MB cap in phase ${phase}`);
}, 1000);
const wall = setTimeout(() => kill(`wall time over ${WALL_CAP_MS / 60_000} min in phase ${phase}`), WALL_CAP_MS);
const readyMs = await waitReady(h);
const pid = h.pid()!;
const afterStart = procStat(pid)!;
result.start = { readyMs: Math.round(readyMs), cpuMs: afterStart.cpuMs, rssMb: r1(afterStart.rssKb / 1024), peakRssMb: r1(afterStart.hwmKb / 1024), records: (await stats(h)).records };
if (scenario === "catchup") result.catchup = { recordsPerSec: Math.round(((result.start as { records: number }).records / readyMs) * 1000), spawnToReadyMs: Math.round(performance.now() - spawnAt) };

// Idle after start: no writes and no queries.
const IDLE_MS = Number(opt("idle-s", "60")) * 1000;
phase = "idle-start";
const idle0 = procStat(pid)!;
await new Promise((r) => setTimeout(r, IDLE_MS));
const idle1 = procStat(pid)!;
result.idle = { cpuPct: r1(((idle1.cpuMs - idle0.cpuMs) / IDLE_MS) * 100), rssMb: r1(idle1.rssKb / 1024) };

if (live[scenario]?.length) {
  phase = "load";
  const before = await stats(h);
  const cpu0 = procStat(pid)!;
  const samples: { cpuMs: number; rssKb: number }[] = [];
  const sampler = setInterval(() => {
    const s = procStat(pid);
    if (s) samples.push(s);
  }, 1000);
  const lat: Record<string, number[]> = {};
  let stop = false;
  const sids = Array.from({ length: 10 }, (_, i) => `0199main-0000-7000-8000-${String(i).padStart(12, "0")}`);
  const queries: [string, Record<string, unknown>][] = [
    ["today", { tz: "Europe/Berlin" }],
    ["session", { sid: sids[0] }],
    ["costs", { range: "7d", tz: "Europe/Berlin" }],
    ["sessions", { sids }],
    ["session", { sid: sids[3] }],
    ["costs", { range: "30d", tz: "Asia/Kolkata" }],
    ["today", { tz: "UTC" }],
    ["costs", { range: "all", tz: "UTC", provider: ["zai"] }],
  ];
  // Four browser panes' worth of polling: a query every 250 ms, round robin.
  const querier = (async () => {
    let i = 0;
    while (!stop) {
      const [op, p] = queries[i++ % queries.length]!;
      const r = await ask(h, op, p);
      if (r.status === 200) (lat[`${op}${p.range ? `:${p.range}` : ""}`] ??= []).push(r.ms);
      await new Promise((res) => setTimeout(res, 250));
    }
  })();
  // The server's own one-shots: 2 appends a second on this loop.
  const appendUs: number[] = [];
  let n = 0;
  const appender = setInterval(() => {
    const t = performance.now();
    appendUsageRecord({ v: 1, key: `server:${++n}`, ts: Date.now(), device: null, producer: "server-bench", src: "pi", provider: "zai", model: "glm-5.3", input: 1200, output: 40, cacheRead: 0, cacheWrite: 0, owner: sids[1]!, parent: null, kind: "oneshot", purpose: "title" }, agentDir);
    appendUs.push((performance.now() - t) * 1000);
  }, 500);
  eld.enable();
  const t0 = performance.now();
  const g = await gen(live[scenario]!);
  const genMs = performance.now() - t0;
  // Until the helper has folded everything the generator wrote.
  const expect = before.records + before.duplicates + g.written + g.dupes;
  let settleMs = 0;
  for (const t1 = performance.now(); performance.now() - t1 < 120_000; ) {
    const s = await stats(h);
    if (s.records + s.duplicates >= expect) {
      settleMs = performance.now() - t1;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  eld.disable();
  stop = true;
  clearInterval(appender);
  clearInterval(sampler);
  await querier;
  const cpu1 = procStat(pid)!;
  const after = await stats(h);
  const folded = after.records + after.duplicates - before.records - before.duplicates;
  const perSec: number[] = [];
  for (let i = 1; i < samples.length; i++) perSec.push(((samples[i]!.cpuMs - samples[i - 1]!.cpuMs) / 1000) * 100);
  result.load = {
    gen: g,
    seconds: r1(genMs / 1000),
    linesFolded: folded,
    settleAfterGenMs: Math.round(settleMs),
    helperCpuPct: { mean: r1(((cpu1.cpuMs - cpu0.cpuMs) / (genMs + settleMs)) * 100), p95: r1(pct(perSec, 95)), max: r1(Math.max(0, ...perSec)) },
    cpuUsPerRecord: r1(((cpu1.cpuMs - cpu0.cpuMs) * 1000) / Math.max(1, folded)),
    rssMb: { steady: r1(pct(samples.map((s) => s.rssKb), 50) / 1024), peak: r1(cpu1.hwmKb / 1024) },
    queryMs: Object.fromEntries(Object.entries(lat).map(([k, xs]) => [k, { n: xs.length, p50: r1(pct(xs, 50)), p95: r1(pct(xs, 95)), max: r1(Math.max(...xs)) }])),
    serverLoop: { eldP50Ms: r1(eld.percentile(50) / 1e6), eldP99Ms: r1(eld.percentile(99) / 1e6), eldMaxMs: r1(eld.max / 1e6), appendUsP50: r1(pct(appendUs, 50)), appendUsP99: r1(pct(appendUs, 99)) },
  };
}

// Idle again after the load: memory must stop growing once the writes stop.
if (live[scenario]?.length) {
  phase = "idle-after";
  await new Promise((r) => setTimeout(r, IDLE_MS));
}

// Nobody reads its answers for 30 s while queries keep coming (a stalled server); then they drain.
phase = "unread";
h.pauseOutput(true);
const unread: Promise<unknown>[] = [];
for (let i = 0; i < 300; i++) {
  unread.push(h.request("costs", { range: "all", tz: "UTC" }));
  await new Promise((r) => setTimeout(r, 100));
}
h.pauseOutput(false);
const drained = await Promise.all(unread);
result.unread = { asked: unread.length, answered: drained.filter((a) => (a as { status: number }).status === 200).length };

// Queries on the settled ledger (no writes), 20 of each.
phase = "queries";
const cold: Record<string, unknown> = {};
for (const [name, op, p] of [
  ["costs:7d", "costs", { range: "7d", tz: "Europe/Berlin" }],
  ["costs:30d", "costs", { range: "30d", tz: "Europe/Berlin" }],
  ["costs:all", "costs", { range: "all", tz: "Asia/Kolkata" }],
  ["today", "today", { tz: "Europe/Berlin" }],
  ["session", "session", { sid: "0199main-0000-7000-8000-000000000002" }],
] as const) {
  const xs: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 20; i++) {
    const r = await ask(h, op, p);
    xs.push(r.ms);
    bytes = r.bytes;
  }
  cold[name] = { first: r1(xs[0]!), p50: r1(pct(xs, 50)), max: r1(Math.max(...xs)), bytes };
}
result.queries = cold;
clearInterval(watcher);
clearTimeout(wall);
// Per phase: RSS slope (least squares, MB/min, the first 10 s of a phase left out as warm-up),
// min/max, CPU %, and a compact series (every 5th second). Growth limits per phase kind.
const LIMIT: Record<string, number> = { "idle-start": 2, "idle-after": 2, unread: 5, load: 30 };
const phases: Record<string, unknown> = {};
for (const name of [...new Set(series.map((s) => s.phase))]) {
  const xs = series.filter((s) => s.phase === name);
  const fit = xs.length > 20 ? xs.slice(10) : xs;
  const n = fit.length;
  let slopeMbMin = 0;
  if (n >= 3) {
    const mx = fit.reduce((a, s) => a + s.t, 0) / n;
    const my = fit.reduce((a, s) => a + s.rssMb, 0) / n;
    const num = fit.reduce((a, s) => a + (s.t - mx) * (s.rssMb - my), 0);
    const den = fit.reduce((a, s) => a + (s.t - mx) ** 2, 0);
    slopeMbMin = den ? (num / den) * 60 : 0;
  }
  const secs = xs.length > 1 ? xs[xs.length - 1]!.t - xs[0]!.t : 0;
  const cpuPct = secs ? ((xs[xs.length - 1]!.cpuMs - xs[0]!.cpuMs) / (secs * 1000)) * 100 : 0;
  const limit = LIMIT[name];
  const grows = limit !== undefined && n >= 20 && slopeMbMin > limit;
  if (grows) failures.push(`${name}: RSS grows ${r1(slopeMbMin)} MB/min (limit ${limit})`);
  phases[name] = { seconds: secs, slopeMbMin: r1(slopeMbMin), minMb: Math.min(...xs.map((s) => s.rssMb)), maxMb: Math.max(...xs.map((s) => s.rssMb)), cpuPct: r1(cpuPct), series: xs.filter((_, i) => i % 5 === 0).map((s) => Math.round(s.rssMb)), ...(limit !== undefined ? { verdict: grows ? "FAIL" : "flat" } : {}) };
}
result.memory = phases;
result.verdict = failures.length ? { fail: failures } : "pass";
const end = procStat(pid)!;
result.end = { rssMb: r1(end.rssKb / 1024), peakRssMb: r1(end.hwmKb / 1024), records: (await stats(h)).records };
await h.stop();
fs.rmSync(work, { recursive: true, force: true });
const text = JSON.stringify(result, null, 1);
process.stdout.write(`${text}\n`);
const out = opt("out");
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${text}\n`);
}
process.exit(0);
