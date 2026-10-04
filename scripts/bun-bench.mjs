#!/usr/bin/env node
// Node vs Bun benchmark for the Sova server, against a hermetic .agent.
//   node scripts/bun-bench.mjs <node|bun> <port> <runtime-binary>
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const [kind, portArg, bin] = process.argv.slice(2);
const PORT = Number(portArg);
const ROOT = resolve(import.meta.dirname, "..");
const AGENT = join(ROOT, ".agent");
const TOKEN = readFileSync(join(AGENT, "sova/auth-token"), "utf8").trim();
const BASE = `http://127.0.0.1:${PORT}`;
const H = { "x-sova-token": TOKEN, Host: `127.0.0.1:${PORT}` };
const TICK = 100; // USER_HZ

const args = kind === "bun" ? ["server/index.ts"] : ["--import", "tsx", "server/index.ts"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function procStat(pid) {
  const s = readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
  const cpu = (Number(f[11]) + Number(f[12])) / TICK; // utime+stime, seconds
  const rss = Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1]) / 1024;
  const threads = Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/Threads:\s+(\d+)/)[1]);
  return { cpu, rss, threads };
}

function sessions() {
  const out = [];
  const dir = join(AGENT, "sessions");
  for (const d of readdirSync(dir)) {
    if (d === "live") continue;
    const p = join(dir, d);
    if (!statSync(p).isDirectory()) continue;
    for (const f of readdirSync(p)) if (f.endsWith(".jsonl")) out.push({ path: join(p, f), size: statSync(join(p, f)).size });
  }
  return out.sort((a, b) => b.size - a.size);
}

function wsFirst(route, path, want, timeoutMs = 60000) {
  return new Promise((res) => {
    const t0 = performance.now();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${route}?path=${encodeURIComponent(path)}`, { headers: { ...H, Origin: BASE } });
    const timer = setTimeout(() => { res({ ws, ms: null, err: "timeout" }); }, timeoutMs);
    ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.type === want) { clearTimeout(timer); res({ ws, ms: performance.now() - t0, bytes: buf.length }); }
      else if (m.type === "error") { clearTimeout(timer); res({ ws, ms: null, err: m.message ?? m.code }); }
    });
    ws.on("error", (e) => { clearTimeout(timer); res({ ws, ms: null, err: String(e.message) }); });
  });
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function boot() {
  const t0 = performance.now();
  const child = spawn(bin, args, { cwd: ROOT, env: { ...process.env, PORT: String(PORT), PI_CODING_AGENT_DIR: AGENT }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (;;) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch {}
    if (child.exitCode !== null) throw new Error(`exited: ${log.slice(-2000)}`);
    await sleep(20);
  }
  return { child, ms: performance.now() - t0, log: () => log };
}

async function stop(child) {
  child.kill("SIGTERM");
  for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(50);
  if (child.exitCode === null) child.kill("SIGKILL");
  await sleep(500);
}

const R = { kind };

// 1) cold start, 3 boots
const boots = [];
for (let i = 0; i < 3; i++) { const b = await boot(); boots.push(b.ms); await sleep(1500); await stop(b.child); }
R.startMs = boots.map(Math.round);

// main run
const { child, log } = await boot();
const pid = child.pid;
await sleep(5000);
R.rssAfterBootMb = Math.round(procStat(pid).rss);

// 2) idle CPU, nothing open, 30 s
let s0 = procStat(pid); await sleep(30000); let s1 = procStat(pid);
R.idleEmptyCpuPct = +(((s1.cpu - s0.cpu) / 30) * 100).toFixed(1);

// 3) session list
const list = [];
for (let i = 0; i < 5; i++) { const t = performance.now(); const r = await fetch(`${BASE}/api/sessions`, { headers: H }); await r.arrayBuffer(); list.push(performance.now() - t); }
R.listMs = { first: Math.round(list[0]), warmMedian: Math.round(median(list.slice(1))) };

// 4) full transcripts of the 5 largest (watch snapshot, no tail), twice each
const all = sessions();
R.sessions = all.length;
R.largestMb = +(all[0].size / 1e6).toFixed(1);
const tx = [];
for (const s of all.slice(0, 5)) for (let k = 0; k < 2; k++) {
  const r = await wsFirst("/ws/watch", s.path, "snapshot"); r.ws.close();
  tx.push(r.ms ?? NaN);
}
R.transcriptMs = { median: Math.round(median(tx)), max: Math.round(Math.max(...tx)), failed: tx.filter(Number.isNaN).length };

// 5) host every session (chat runtime), sequentially
const c0 = procStat(pid).cpu;
const tOpen = performance.now();
const socks = []; const opens = []; const errs = [];
for (const s of all) {
  const r = await wsFirst("/ws/chat", s.path, "hello", 90000);
  socks.push(r.ws);
  if (r.ms != null) opens.push(r.ms); else errs.push(r.err);
}
R.hostAll = { totalS: +((performance.now() - tOpen) / 1000).toFixed(1), cpuS: +(procStat(pid).cpu - c0).toFixed(1), opened: opens.length, medianMs: Math.round(median(opens)), maxMs: Math.round(Math.max(...opens)), errors: [...new Set(errs)].slice(0, 3) };
await sleep(5000);
R.rssHostedMb = Math.round(procStat(pid).rss);
R.threads = procStat(pid).threads;

// 6) idle CPU with everything hosted and sockets open, 60 s
s0 = procStat(pid); await sleep(60000); s1 = procStat(pid);
R.idleHostedCpuPct = +(((s1.cpu - s0.cpu) / 60) * 100).toFixed(1);
R.rssHostedAfterIdleMb = Math.round(s1.rss);

for (const w of socks) try { w.close(); } catch {}
await stop(child);
const errLines = log().split("\n").filter((l) => /error|Error|ERR|not supported|unimplemented/i.test(l) && !/serveStatic/.test(l));
R.serverErrorLines = errLines.length;
R.sampleErrors = [...new Set(errLines.map((l) => l.slice(0, 200)))].slice(0, 8);
console.log(JSON.stringify(R, null, 2));
