#!/usr/bin/env node
// bench-session-list: A/B benchmark of the session list's cost on a copy of the real sessions.
//
// A hermetic Sova instance (project verbs: `up` on this checkout) serves <agent dir>/sessions, a
// copy of ~/.pi/agent/sessions. This script plays an agent-like writing load on a fixed, seeded
// set of copied sessions while one headless "tab" holds the sessions feed, and measures per phase:
//   - server CPU seconds (/proc/<pid>/stat utime+stime of the process owning the port, plus the
//     unit's whole cgroup cpu.stat usage_usec) and file reads (/proc/<pid>/io rchar, read_bytes);
//   - bytes the tab received on /ws/watch?feed=sessions[&rows=1] and the GET /api/sessions it made
//     (same 1 s nudge throttle as src/lib/signals.ts createNudgeThrottle).
//
//   node scripts/bench-session-list/run.mjs --prepare           # copy the sessions in (server DOWN)
//   node scripts/bench-session-list/run.mjs --label baseline [--port 4900] [--rows]
//        [--seed 42] [--busy 4] [--warmup 60] [--idle 180] [--load 180] [--cool 20]
//        [--min-gap 0.5] [--max-gap 2] [--out .tmp/bench-<label>.json]
//   node scripts/bench-session-list/run.mjs --compare .tmp/bench-baseline.json .tmp/bench-partA.json
//
// Never touches ~/.pi: it refuses an agent dir inside it, and only ever reads the real sessions
// (--prepare). The busy sessions are snapshotted into .tmp/bench-session-list/ on the first run and
// restored at the start of every run, so each run appends the same lines to the same starting files.
// Builtins only.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const AGENT = resolve(opt("agent-dir", join(ROOT, ".agent")));
const SESSIONS = join(AGENT, "sessions");
const HOME_PI = join(homedir(), ".pi");
const REAL_SESSIONS = join(HOME_PI, "agent", "sessions");
if (AGENT === HOME_PI || AGENT.startsWith(HOME_PI + "/")) throw new Error(`refusing an agent dir inside ~/.pi: ${AGENT}`);

// Per agent dir, so two instances (baseline, feature) each keep their own restore points.
const SNAP = join(ROOT, ".tmp", "bench-session-list", createHash("sha256").update(AGENT).digest("hex").slice(0, 8));
// --prepare --from <sessions dir>: copy another instance's copy instead, so A and B hold identical data.
const FROM = resolve(opt("from", REAL_SESSIONS));

// ── prepare ────────────────────────────────────────────────────────────────────────────────────

function countFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  return n;
}

if (has("prepare")) {
  // Set the dir up for copies first (wake nudges left out, schedules blanked), then copy.
  execFileSync("node", [join(ROOT, "scripts", "hermetic-agent-dir.mjs"), "--copied-sessions"], { stdio: "inherit", env: { ...process.env, HERMETIC_AGENT_DIR: AGENT } });
  mkdirSync(SESSIONS, { recursive: true });
  execFileSync("cp", ["-a", "--reflink=auto", `${FROM}/.`, `${SESSIONS}/`], { stdio: "inherit" });
  const real = countFiles(FROM), copy = countFiles(SESSIONS);
  console.log(`files: source ${real}, copy ${copy}${copy >= real ? "" : "  <-- MISMATCH"}`);
  process.exit(copy >= real ? 0 : 1);
}

// ── compare ────────────────────────────────────────────────────────────────────────────────────

if (has("compare")) {
  const files = args.filter((a) => a.endsWith(".json"));
  const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
  // Instance runs (this script) and in-process runs (feed.ts) share the names they both have.
  const metrics = [
    ["serverCpuSec", "server CPU s (in-process, tab excluded)"],
    ["cpuSec", "process CPU s"],
    ["cgroupCpuSec", "unit cgroup CPU s"],
    ["listCpuSec", "  feed listing CPU s"],
    ["afterCpuSec", "  feed after (attention) CPU s"],
    ["diffRestCpuSec", "  rest of diff CPU s"],
    ["getCpuSec", "  GET /api/sessions CPU s"],
    ["outsideDiffCpuSec", "  outside diffs CPU s"],
    ["diffs", "feed re-diffs"],
    ["rcharMB", "read() MB (rchar)"],
    ["readBytesMB", "disk read MB"],
    ["wsMsgs", "feed messages"],
    ["wsBytes", "feed bytes"],
    ["gets", "GET /api/sessions"],
    ["getMB", "GET bytes MB"],
    ["getMsP50", "GET ms p50"],
    ["linesWritten", "lines appended"],
  ];

  let out = "";
  for (const phase of ["idle", "load", "cool"]) {
    out += `\n### ${phase}\n\n| metric | ${runs.map((r) => `${r.label}${r.commit ? ` (${r.commit})` : ""}`).join(" | ")} |\n|---|${runs.map(() => "---:").join("|")}|\n`;
    for (const [k, name] of metrics) if (runs.some((r) => r.phases[phase]?.[k] != null)) out += `| ${name} | ${runs.map((r) => fmt(r.phases[phase]?.[k])).join(" | ")} |\n`;
  }
  console.log(out);
  process.exit(0);
}
function fmt(x) {
  if (x == null) return "–";
  if (typeof x === "number") return Number.isInteger(x) ? String(x) : x.toFixed(x >= 100 ? 0 : x >= 1 ? 2 : 3);
  return String(x);
}

// ── run config ─────────────────────────────────────────────────────────────────────────────────

const LABEL = opt("label", "run");
const PORT = Number(opt("port", "4900"));
const ROWS = has("rows");
const SEED = Number(opt("seed", "42"));
const BUSY = Number(opt("busy", "4"));
const T = { warmup: Number(opt("warmup", "60")), idle: Number(opt("idle", "180")), load: Number(opt("load", "180")), cool: Number(opt("cool", "20")) };
const GAP = { min: Number(opt("min-gap", "0.5")) * 1000, max: Number(opt("max-gap", "2")) * 1000 };
const OUT = resolve(opt("out", join(ROOT, ".tmp", `bench-${LABEL}.json`)));
const TOKEN = readFileSync(join(AGENT, "sova", "auth-token"), "utf8").trim();
const COOKIE = `sova_token_${createHash("sha256").update(resolve(AGENT)).digest("hex").slice(0, 8)}=${TOKEN}`;
const HEADERS = { Host: `127.0.0.1:${PORT}`, Origin: `http://127.0.0.1:${PORT}`, "x-sova-token": TOKEN, Cookie: COOKIE, "Accept-Encoding": "gzip, deflate, br" };

// mulberry32: one seeded stream for target choice and one per writer, so every run is the same.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── server process ─────────────────────────────────────────────────────────────────────────────

function listenerPid(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length > 9 && c[1].endsWith(`:${hex}`) && c[3] === "0A") inodes.add(c[9]);
    }
  }
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let fds;
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m && inodes.has(m[1])) return Number(pid);
      } catch {}
    }
  }
  throw new Error(`no process listens on ${port}: start the instance (project verbs up)`);
}
const CLK = 100; // getconf CLK_TCK on Linux
function procSample(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const io = Object.fromEntries(readFileSync(`/proc/${pid}/io`, "utf8").trim().split("\n").map((l) => { const [k, v] = l.split(": "); return [k, Number(v)]; }));
  let cg = null;
  try {
    const path = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("\n").find((l) => l.startsWith("0::"))?.slice(3);
    const m = /usage_usec (\d+)/.exec(readFileSync(`/sys/fs/cgroup${path}/cpu.stat`, "utf8"));
    if (m) cg = Number(m[1]) / 1e6;
  } catch {}
  const rss = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) * 1024;
  return { t: Date.now(), cpu: (Number(f[11]) + Number(f[12])) / CLK, rchar: io.rchar, readBytes: io.read_bytes, syscr: io.syscr, cg, rss };
}

// ── HTTP + a raw WebSocket client (byte-exact counts, no permessage-deflate offered) ───────────

function httpGet(path) {
  return new Promise((ok, fail) => {
    const t0 = performance.now();
    const req = request({ host: "127.0.0.1", port: PORT, path, headers: HEADERS, agent: false }, (res) => {
      let wire = 0;
      const chunks = [];
      res.on("data", (c) => { wire += c.length; chunks.push(c); });
      res.on("end", () => ok({ status: res.statusCode, wire, body: Buffer.concat(chunks), headers: res.headers, ms: performance.now() - t0 }));
    });
    req.on("error", fail);
    req.end();
  });
}

function openWs(path, onText, onClose) {
  const key = randomBytes(16).toString("base64");
  const req = request({ host: "127.0.0.1", port: PORT, path, agent: false, headers: { ...HEADERS, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key } });
  return new Promise((ok, fail) => {
    req.on("response", (res) => fail(new Error(`ws upgrade refused: ${res.statusCode}`)));
    req.on("error", fail);
    req.on("upgrade", (_res, socket, head) => {
      let buf = head;
      let frag = [];
      const send = (op, payload = Buffer.alloc(0)) => {
        const mask = randomBytes(4);
        const len = payload.length;
        const hdr = len < 126 ? Buffer.from([0x80 | op, 0x80 | len]) : Buffer.from([0x80 | op, 0x80 | 126, len >> 8, len & 255]);
        const body = Buffer.from(payload);
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        socket.write(Buffer.concat([hdr, mask, body]));
      };
      socket.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) return;
          const fin = buf[0] & 0x80, op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          const wire = off + len;
          buf = buf.subarray(off + len);
          if (op === 9) send(10, payload);
          else if (op === 8) socket.end();
          else if (op === 1 || op === 0) {
            frag.push(payload);
            if (fin) { onText(Buffer.concat(frag).toString("utf8"), wire); frag = []; }
          }
        }
      });
      socket.on("close", onClose);
      ok({ close: () => { try { send(8); } catch {} socket.destroy(); } });
    });
    req.end();
  });
}

// ── the tab ────────────────────────────────────────────────────────────────────────────────────

const stats = { wsBytes: 0, wsMsgs: 0, byType: {}, gets: 0, getWire: 0, getBody: 0, getMs: [], lines: 0 };
let listVersion = null; // rows mode: "<epoch>:<version>" from the snapshot header

async function fetchList(why) {
  const r = await httpGet("/api/sessions");
  stats.gets++;
  stats.getWire += r.wire;
  stats.getBody += r.body.length;
  stats.getMs.push(r.ms);
  if (r.status !== 200) throw new Error(`GET /api/sessions ${r.status}`);
  listVersion = r.headers["x-sova-list-version"] ?? null;
  return r;
}
// src/lib/signals.ts createNudgeThrottle, gap 1000 ms.
function throttle(run, gap = 1000) {
  let last = -Infinity, pending = null;
  const fire = () => { pending = null; last = Date.now(); run(); };
  return () => {
    if (pending) return;
    const wait = last + gap - Date.now();
    if (wait <= 0) fire(); else pending = setTimeout(fire, wait);
  };
}

async function openTab() {
  const nudge = throttle(() => void fetchList("nudge").catch((e) => console.error(e.message)));
  const path = `/ws/watch?feed=sessions${ROWS ? "&rows=1" : ""}`;
  let closed = false;
  const ws = await openWs(path, (text, wire) => {
    stats.wsBytes += wire;
    stats.wsMsgs++;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const ty = msg.type ?? "?";
    stats.byType[ty] = (stats.byType[ty] ?? 0) + 1;
    if (ty === "list_changed" || ty === "groups_changed") nudge();
    else if (ty === "rows") {
      // Apply when contiguous with our snapshot, else refetch (the app's gap rule).
      const [epoch, ver] = (listVersion ?? ":").split(":");
      if (msg.epoch !== epoch || String(msg.from) !== ver) nudge();
      else listVersion = `${msg.epoch}:${msg.to}`;
    } else if (ty === "rows_hello") {
      const [epoch, ver] = (listVersion ?? ":").split(":");
      if (msg.epoch !== epoch || String(msg.version) !== ver) nudge();
    }
  }, () => { if (!closed) console.error("feed socket closed"); });
  await fetchList("open");
  return { close: () => { closed = true; ws.close(); } };
}

// ── load: seeded agent-like appends ────────────────────────────────────────────────────────────

function allSessions(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "live") allSessions(p, out); }
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function chooseTargets() {
  const manifest = join(SNAP, "targets.json");
  if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8"));
  const pick = rng(SEED);
  const pool = allSessions(SESSIONS).sort().filter((p) => {
    const s = statSync(p).size;
    return s > 100_000 && s < 8_000_000;
  });
  const targets = [];
  while (targets.length < BUSY && pool.length) {
    const p = pool.splice(Math.floor(pick() * pool.length), 1)[0];
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const msgs = lines.filter((l) => l.length < 32_000 && l.startsWith('{"type":"message"'));
    if (msgs.length < 40) continue;
    const rel = relative(SESSIONS, p);
    const snap = join(SNAP, "snap", rel);
    mkdirSync(dirname(snap), { recursive: true });
    copyFileSync(p, snap);
    targets.push(rel);
  }
  mkdirSync(SNAP, { recursive: true });
  writeFileSync(manifest, JSON.stringify(targets, null, 2));
  return targets;
}

function restoreTargets(targets) {
  for (const rel of targets) copyFileSync(join(SNAP, "snap", rel), join(SESSIONS, rel));
}

function startWriters(targets, phaseRef) {
  const timers = [];
  let stopped = false;
  targets.forEach((rel, i) => {
    const file = join(SESSIONS, rel);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const tmpl = lines.filter((l) => l.length < 32_000 && l.startsWith('{"type":"message"')).map((l) => JSON.parse(l));
    let leaf = null;
    for (let j = lines.length - 1; j >= 0 && !leaf; j--) { try { leaf = JSON.parse(lines[j]).id ?? null; } catch {} }
    const r = rng(SEED * 1000 + i + 1);
    let k = Math.floor(r() * tmpl.length);
    const tick = () => {
      if (stopped) return;
      const e = structuredClone(tmpl[k++ % tmpl.length]);
      const id = Math.floor(r() * 0xffffffff).toString(16).padStart(8, "0");
      const now = new Date();
      e.id = id;
      e.parentId = leaf;
      e.timestamp = now.toISOString();
      if (e.message && typeof e.message.timestamp === "number") e.message.timestamp = now.getTime();
      leaf = id;
      appendFileSync(file, JSON.stringify(e) + "\n");
      stats.lines++;
      phaseRef.lines[phaseRef.name] = (phaseRef.lines[phaseRef.name] ?? 0) + 1;
      timers[i] = setTimeout(tick, GAP.min + r() * (GAP.max - GAP.min));
    };
    timers[i] = setTimeout(tick, r() * GAP.max);
  });
  return () => { stopped = true; timers.forEach(clearTimeout); };
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; };

async function main() {
  const pid = listenerPid(PORT);
  const health = JSON.parse((await httpGet("/api/health")).body.toString());
  const targets = chooseTargets();
  restoreTargets(targets);
  console.log(`[${LABEL}] server pid ${pid}, head ${health.head ?? "?"}, rows=${ROWS ? 1 : 0}, targets:\n  ${targets.join("\n  ")}`);
  const tab = await openTab();
  const series = [];
  const phaseRef = { name: "warmup", lines: {} };
  let prev = procSample(pid);
  const sampler = setInterval(() => {
    const s = procSample(pid);
    series.push({ phase: phaseRef.name, t: s.t, cpu: +(s.cpu - prev.cpu).toFixed(2), cg: s.cg != null && prev.cg != null ? +(s.cg - prev.cg).toFixed(3) : null, rchar: s.rchar - prev.rchar, rss: s.rss, ws: stats.wsBytes, gets: stats.gets });
    prev = s;
  }, 1000);
  const phases = {};
  const runPhase = async (name, secs, fn) => {
    phaseRef.name = name;
    const a = procSample(pid);
    const st0 = { ...stats, byType: { ...stats.byType }, getMs: stats.getMs.length };
    const stop = fn?.();
    await sleep(secs * 1000);
    stop?.();
    const b = procSample(pid);
    const getMs = stats.getMs.slice(st0.getMs);
    const byType = Object.fromEntries(Object.entries(stats.byType).map(([k, v]) => [k, v - (st0.byType[k] ?? 0)]).filter(([, v]) => v));
    phases[name] = {
      secs,
      cpuSec: b.cpu - a.cpu,
      cgroupCpuSec: a.cg != null ? b.cg - a.cg : null,
      cpuPct: ((b.cpu - a.cpu) / secs) * 100,
      rcharMB: (b.rchar - a.rchar) / 1e6,
      readBytesMB: (b.readBytes - a.readBytes) / 1e6,
      syscr: b.syscr - a.syscr,
      rssMB: b.rss / 1e6,
      wsBytes: stats.wsBytes - st0.wsBytes,
      wsMsgs: stats.wsMsgs - st0.wsMsgs,
      byType,
      gets: stats.gets - st0.gets,
      getMB: (stats.getWire - st0.getWire) / 1e6,
      getBodyMB: (stats.getBody - st0.getBody) / 1e6,
      getMsP50: pct(getMs, 50),
      getMsMax: pct(getMs, 100),
      linesWritten: phaseRef.lines[name] ?? 0,
    };
    console.log(`[${LABEL}] ${name}: ${JSON.stringify(phases[name])}`);
  };
  await runPhase("warmup", T.warmup);
  await runPhase("idle", T.idle);
  await runPhase("load", T.load, () => startWriters(targets, phaseRef));
  await runPhase("cool", T.cool);
  clearInterval(sampler);
  tab.close();
  restoreTargets(targets);
  const head = (() => { try { return execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })();
  const result = { label: LABEL, at: new Date().toISOString(), git: head, serverHead: health.head ?? null, config: { port: PORT, rows: ROWS, seed: SEED, busy: BUSY, T, gapMs: GAP, sessions: allSessions(SESSIONS).length, targets }, pid, phases, series };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`[${LABEL}] wrote ${relative(ROOT, OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
