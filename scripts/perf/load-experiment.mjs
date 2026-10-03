#!/usr/bin/env node
// load-experiment: does lowering the priority of Sova's workers keep the server responsive while
// they oversubscribe the machine? (docs/perf/2026-10-03-load-and-freezes.md has the method and the
// numbers.) Each run starts a hermetic server on this tree's .agent (real sessions copied IN by
// --prepare; nothing is ever written to ~/.pi), measures latency and event-loop delay at idle, then
// starts CPU load and measures again, then stops everything.
//
//   node scripts/perf/load-experiment.mjs --prepare          # build .agent and copy the sessions in
//   node scripts/perf/load-experiment.mjs [--variants nice0,nice10,weight] [--reps 3]
//        [--idle 30] [--ramp 20] [--load 60] [--cool 20] [--mix test=2,tsc=2,vite=1]
//        [--nice 10] [--weight 1000] [--port 4867] [--inspect 9267] [--out <dir>]
//        [--agent-dir <dir>] [--transcript <file name part>]
//   node scripts/perf/load-experiment.mjs --summarize <out dir>   # tables from saved samples
//   node scripts/perf/load-experiment.mjs --cleanup               # stop sova-perf-* scopes, free the ports
//
// Variants (load = scripts/perf/load-standin.mjs: node --test suites, tsc and vite builds):
//   nice0       the load starts as the server's child (spawned from inside the server through the
//               inspector, so it sits in the server's process group and cgroup like a real worker) at nice 0
//   nice10      the same, lowered with os.setPriority(child.pid, --nice) right after spawn
//   fixed       the same, lowered by the shipped code (server/process-priority.ts + subagents/priority.ts)
//   weight      the server runs in a `systemd-run --user --scope -p CPUWeight=--weight`, the load
//               as its child (so inside that scope, as real workers are), nice 0
//   ext         the server in a default-weight scope, the load in a sibling scope (other sessions'
//               load, outside the server's cgroup), nice 0
//   weight-ext  the server in a CPUWeight=--weight scope, the load in a sibling default scope, nice 0
// With systemd-run --user every server runs in its own scope (default weight unless a weight
// variant); without it every server is a plain child and the scope variants are refused. Builtins only (the global WebSocket for the inspector).

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { getPriority, homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const AGENT = resolve(opt("agent-dir", join(ROOT, ".agent")));
const HOME_PI = join(homedir(), ".pi");
const PORT = Number(opt("port", "4867"));
const INSPECT = Number(opt("inspect", "9267"));
const NICE = Number(opt("nice", "10"));
const WEIGHT = Number(opt("weight", "1000"));
const MIX = opt("mix", "test=2,tsc=2,vite=1");
const T = { idle: Number(opt("idle", "30")), ramp: Number(opt("ramp", "20")), load: Number(opt("load", "60")), cool: Number(opt("cool", "20")) };

if (AGENT === HOME_PI || AGENT.startsWith(HOME_PI + "/")) throw new Error(`refusing an agent dir inside ~/.pi: ${AGENT}`);

// ── summaries ──────────────────────────────────────────────────────────────────────────────────

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const median = (xs) => pct(xs, 50);
const r = (x) => (x == null ? "–" : x >= 100 ? Math.round(x).toString() : x.toFixed(1));

/** One run's samples → per-phase stats. */
function runStats(samples) {
  const out = {};
  for (const phase of ["idle", "load"]) {
    const of = (kind) => samples.filter((s) => s.phase === phase && s.kind === kind);
    const ms = (kind) => of(kind).filter((s) => s.ok).map((s) => s.ms);
    // A sample without numbers is a lost read (an inspector error), not a measurement.
    const eld = of("eld").filter((s) => Number.isFinite(s.max) && Number.isFinite(s.mean));
    const sys = of("sys");
    out[phase] = {
      sessions: { n: of("sessions").length, p50: median(ms("sessions")), p95: pct(ms("sessions"), 95), max: pct(ms("sessions"), 100), fail: of("sessions").filter((s) => !s.ok).length },
      tail: { n: of("tail").length, p50: median(ms("tail")), p95: pct(ms("tail"), 95), max: pct(ms("tail"), 100) },
      full: { n: of("full").length, p50: median(ms("full")), p95: pct(ms("full"), 95), max: pct(ms("full"), 100) },
      reload: { n: of("reload").length, p50: median(ms("reload")), p95: pct(ms("reload"), 95), max: pct(ms("reload"), 100) },
      eldMean: { p50: median(eld.map((s) => s.mean)), p95: pct(eld.map((s) => s.mean), 95) },
      eldMax: { p50: median(eld.map((s) => s.max)), p95: pct(eld.map((s) => s.max), 95), max: pct(eld.map((s) => s.max), 100) },
      eldLost: of("eld").length - eld.length + of("eld-error").length,
      load1: median(sys.map((s) => s.load1)),
      psi: median(sys.filter((s) => s.psi != null).map((s) => s.psi)),
      mainCpu: median(sys.filter((s) => s.mainCpu != null).map((s) => s.mainCpu)),
    };
  }
  return out;
}

function summarize(dir) {
  const runs = readdirSync(dir)
    .filter((f) => f.endsWith(".samples.jsonl"))
    .map((f) => {
      const meta = JSON.parse(readFileSync(join(dir, f.replace(".samples.jsonl", ".meta.json")), "utf8"));
      const samples = readFileSync(join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return { meta, stats: runStats(samples) };
    });
  const variants = [...new Set(runs.map((x) => x.meta.variant))];
  const lines = [];
  lines.push(`Runs: ${runs.length} in ${dir}. Medians across reps of each run's p50/p95; ms unless noted.`, "");
  lines.push("| variant | phase | reps | /api/sessions p50 | p95 | max | reload p50 | p95 | tail p50 | p95 | full p50 | p95 | ELD mean p50 | ELD max p95 | ELD max | load1 | cpu PSI some % | main thread % |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const agg = {};
  for (const v of variants) {
    for (const phase of ["idle", "load"]) {
      const rs = runs.filter((x) => x.meta.variant === v).map((x) => x.stats[phase]);
      const m = (f) => median(rs.map(f).filter((x) => x != null));
      const row = {
        reps: rs.length,
        sp50: m((s) => s.sessions.p50), sp95: m((s) => s.sessions.p95), smax: Math.max(...rs.map((s) => s.sessions.max ?? 0)),
        rp50: m((s) => s.reload.p50), rp95: m((s) => s.reload.p95),
        tp50: m((s) => s.tail.p50), tp95: m((s) => s.tail.p95),
        fp50: m((s) => s.full.p50), fp95: m((s) => s.full.p95),
        em50: m((s) => s.eldMean.p50), ex95: m((s) => s.eldMax.p95), exmax: Math.max(...rs.map((s) => s.eldMax.max ?? 0)),
        load1: m((s) => s.load1), psi: m((s) => s.psi), main: m((s) => s.mainCpu),
      };
      (agg[v] ??= {})[phase] = row;
      lines.push(`| ${v} | ${phase} | ${row.reps} | ${r(row.sp50)} | ${r(row.sp95)} | ${r(row.smax)} | ${r(row.rp50)} | ${r(row.rp95)} | ${r(row.tp50)} | ${r(row.tp95)} | ${r(row.fp50)} | ${r(row.fp95)} | ${r(row.em50)} | ${r(row.ex95)} | ${r(row.exmax)} | ${r(row.load1)} | ${r(row.psi)} | ${r(row.main)} |`);
    }
  }
  lines.push("", "Per run (load phase): variant rep → /api/sessions p50/p95, reload p50/p95, ELD max p95, load1");
  for (const x of runs) {
    const s = x.stats.load;
    lines.push(`- ${x.meta.variant} #${x.meta.rep}: ${r(s.sessions.p50)}/${r(s.sessions.p95)} ms, reload ${r(s.reload.p50)}/${r(s.reload.p95)} ms, ELD max p95 ${r(s.eldMax.p95)} ms (${s.eldLost} lost reads), load1 ${r(s.load1)}, failures ${s.sessions.fail}`);
  }
  const text = lines.join("\n") + "\n";
  writeFileSync(join(dir, "summary.md"), text);
  writeFileSync(join(dir, "summary.json"), JSON.stringify(agg, null, 1));
  return text;
}

if (has("summarize")) {
  process.stdout.write(summarize(resolve(opt("summarize", "."))));
  process.exit(0);
}

// ── cleanup: everything a run (or an interrupted one) may have left ─────────────────────────────

/** Stop every sova-perf-* scope, and anything still holding the experiment's ports. */
function cleanup() {
  try {
    execFileSync("sh", ["-c", "systemctl --user stop 'sova-perf-*.scope' 2>/dev/null; true"], { stdio: "inherit", timeout: 30_000 });
  } catch {}
  for (const port of [PORT, INSPECT]) {
    try {
      execFileSync("sh", ["-c", `fuser -k -TERM ${port}/tcp 2>/dev/null; true`], { stdio: "inherit", timeout: 10_000 });
    } catch {}
  }
}

if (has("cleanup")) {
  cleanup();
  console.log(`stopped sova-perf-* scopes and whatever held ports ${PORT} and ${INSPECT}`);
  process.exit(0);
}

// ── prepare: the hermetic agent dir with every real session copied in ─────────────────────────

if (has("prepare")) {
  execFileSync(process.execPath, [join(ROOT, "scripts", "hermetic-agent-dir.mjs"), "--unlock-url"], { stdio: "inherit", env: { ...process.env, HERMETIC_AGENT_DIR: AGENT } });
  const src = resolve(opt("sessions", join(HOME_PI, "agent", "sessions")));
  const dst = join(AGENT, "sessions");
  mkdirSync(dst, { recursive: true });
  // Copy IN only: rsync reads src and writes dst; the live registry (sessions/live) is left out, it
  // names the real server's pids.
  execFileSync("rsync", ["-a", "--delete", "--exclude", "/live/", `${src}/`, `${dst}/`], { stdio: "inherit" });
  const n = execFileSync("sh", ["-c", `find ${JSON.stringify(dst)} -name '*.jsonl' | wc -l`]).toString().trim();
  console.log(`prepared ${AGENT}: ${n} session files copied from ${src}`);
  process.exit(0);
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────

const OUT = resolve(opt("out", join(ROOT, "docs", "perf", "data", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19))));
mkdirSync(OUT, { recursive: true });
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`;
  console.log(line);
  appendFileSync(join(OUT, "run.log"), line + "\n");
};

const systemd = (() => {
  try {
    execFileSync("systemd-run", ["--user", "--scope", "--quiet", "--", "true"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();
const VARIANTS = opt("variants", systemd ? "nice0,nice10,weight" : "nice0,nice10").split(",");
for (const v of VARIANTS) {
  if (!["nice0", "nice10", "fixed", "weight", "ext", "weight-ext"].includes(v)) throw new Error(`unknown variant ${v}`);
  if (!systemd && !["nice0", "nice10", "fixed"].includes(v)) throw new Error(`variant ${v} needs systemd-run --user, which is unavailable here`);
}
const REPS = Number(opt("reps", "3"));

const token = () => readFileSync(join(AGENT, "sova", "auth-token"), "utf8").trim();
const base = `http://127.0.0.1:${PORT}`;

/**
 * The transcript probe's subject: --transcript <file name part>, by default the diagnosis's 8.9 MB
 * session (01a0f6e0, a 35.8 MB response) when it was copied in, else the largest session file.
 */
function probeSession() {
  const want = opt("transcript", "_01a0f6e0-");
  let best = { size: 0, path: "" };
  let named = null;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        const size = statSync(p).size;
        if (size > best.size) best = { size, path: p };
        if (e.name.includes(want)) named = { size, path: p };
      }
    }
  };
  walk(join(AGENT, "sessions"));
  return named ?? best;
}

async function inspector() {
  const list = await (await fetch(`http://127.0.0.1:${INSPECT}/json/list`)).json();
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    ws.onopen = ok;
    ws.onerror = no;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  // awaitPromise only where the expression is async: on a plain value V8 still wraps it in a
  // promise, and when that promise is collected first the call fails ("Promise was collected"),
  // which lost ~5% of the 2026-10-03 run's event-loop samples.
  const evaluate = (expression, awaitPromise = false) =>
    new Promise((ok, no) => {
      const i = ++id;
      pending.set(i, (d) =>
        d.error ? no(new Error(`inspector: ${JSON.stringify(d.error)}`))
        : d.result?.exceptionDetails ? no(new Error(JSON.stringify(d.result.exceptionDetails)))
        : ok(d.result?.result?.value),
      );
      ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise } }));
    });
  return { evaluate, close: () => ws.close() };
}

function scopeArgv(unit, weight) {
  return ["systemd-run", "--user", "--scope", "--quiet", "--slice=app.slice", `--unit=${unit}`, ...(weight ? ["-p", `CPUWeight=${weight}`] : []), "--"];
}

function startServer(variant, runId) {
  const node = [process.execPath, `--inspect=127.0.0.1:${INSPECT}`, "--import", "tsx", "server/index.ts"];
    const weight = variant === "weight" || variant === "weight-ext" ? WEIGHT : undefined;
  const argv = systemd ? [...scopeArgv(`sova-perf-srv-${runId}`, weight), ...node] : node;
  const child = spawn(argv[0], argv.slice(1), {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PI_CODING_AGENT_DIR: AGENT, SOVA_PRICES_FETCH: "off" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const logFile = join(OUT, `${runId}.server.log`);
  child.stdout.on("data", (b) => appendFileSync(logFile, b));
  child.stderr.on("data", (b) => appendFileSync(logFile, b));
  return child;
}

async function waitHealth(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("server never became healthy");
}

function killTree(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
}

/** CPU ticks (utime+stime) of one thread, from /proc. */
function threadTicks(pid) {
  try {
    const s = readFileSync(`/proc/${pid}/task/${pid}/stat`, "utf8");
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    return Number(f[11]) + Number(f[12]);
  } catch {
    return null;
  }
}
const psi = () => {
  try {
    return Number(/some avg10=([\d.]+)/.exec(readFileSync("/proc/pressure/cpu", "utf8"))[1]);
  } catch {
    return null;
  }
};

async function oneRun(variant, rep, bigPath) {
  const runId = `${variant}-r${rep}-${Date.now().toString(36)}`;
  const samples = [];
  let phase = "warm";
  const push = (s) => samples.push({ t: Date.now(), phase, ...s });
  const server = startServer(variant, runId);
  current.add(server.pid);
  let cdp;
  let extLoad;
  const stopAll = [];
  try {
    await waitHealth(120_000);
    const headers = { "x-sova-token": token() };
    const get = async (path) => {
      const t0 = performance.now();
      try {
        const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(120_000) });
        const body = await res.arrayBuffer();
        return { ok: res.ok, ms: performance.now() - t0, bytes: body.byteLength, status: res.status };
      } catch (e) {
        return { ok: false, ms: performance.now() - t0, error: String(e) };
      }
    };
    const enc = encodeURIComponent(bigPath);
    const P = { sessions: "/api/sessions", tail: `/api/transcript?path=${enc}&tail=1`, full: `/api/transcript?path=${enc}`, light: `/api/transcript?path=${enc}&view=light` };
    // Warm the caches the way a running server has them warm.
    for (let i = 0; i < 3; i++) await get(P.sessions);
    await get(P.tail);
    await get(P.full);
    cdp = await inspector();
    await cdp.evaluate(`(() => { const { monitorEventLoopDelay } = process.getBuiltinModule('perf_hooks'); const h = globalThis.__perfEld = monitorEventLoopDelay({ resolution: 10 }); h.enable(); return true; })()`);
    const serverPid = await cdp.evaluate("process.pid");
    const mainPid = server.pid; // the same process (systemd-run --scope execs in place); /proc reads use our view of it
    let running = true;
    const loops = [];
    const loop = (kind, path, gapMs) =>
      loops.push(
        (async () => {
          while (running) {
            const x = await get(path);
            if (phase === "idle" || phase === "load") push({ kind, ...x });
            await sleep(gapMs);
          }
        })(),
      );
    loop("sessions", P.sessions, 1000);
    loop("tail", P.tail, 2000);
    loop("full", P.full, 3000);
    // A reload: the page's first requests at once (the list twice, the open chat's tail, the light pane).
    loops.push(
      (async () => {
        while (running) {
          await sleep(10_000);
          if (!running) break;
          const t0 = performance.now();
          const all = await Promise.all([get(P.sessions), get(P.sessions), get(P.tail), get(P.light)]);
          if (phase === "idle" || phase === "load") push({ kind: "reload", ok: all.every((a) => a.ok), ms: performance.now() - t0 });
        }
      })(),
    );
    let lastTicks = threadTicks(mainPid);
    let lastAt = Date.now();
    loops.push(
      (async () => {
        while (running) {
          await sleep(1000);
          try {
            const e = await cdp.evaluate(`(() => { const h = globalThis.__perfEld; const r = { mean: h.mean / 1e6, max: h.max / 1e6, p99: h.percentile(99) / 1e6 }; h.reset(); return r; })()`);
            if (phase === "idle" || phase === "load") push({ kind: "eld", ...e });
          } catch (e) {
            if (phase === "idle" || phase === "load") push({ kind: "eld-error", error: String(e).slice(0, 300) });
          }
          const ticks = threadTicks(mainPid);
          const now = Date.now();
          const mainCpu = ticks != null && lastTicks != null ? ((ticks - lastTicks) / 100 / ((now - lastAt) / 1000)) * 100 : null;
          lastTicks = ticks;
          lastAt = now;
          const load1 = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
          if (phase === "idle" || phase === "load") push({ kind: "sys", load1, psi: psi(), mainCpu });
        }
      })(),
    );
    await sleep(5000);
    log(`${runId}: idle ${T.idle}s (server pid ${serverPid}, load1 ${readFileSync("/proc/loadavg", "utf8").split(" ")[0]})`);
    phase = "idle";
    await sleep(T.idle * 1000);
    phase = "ramp";
    const standin = join(ROOT, "scripts", "perf", "load-standin.mjs");
    const standinArgs = ["--mix", MIX, "--max-secs", String(T.ramp + T.load + 30), "--out", join(homedir(), ".cache", "sova-perf", runId)];
    if (variant === "ext" || variant === "weight-ext") {
      const argv = [...scopeArgv(`sova-perf-load-${runId}`), process.execPath, standin, ...standinArgs];
      extLoad = spawn(argv[0], argv.slice(1), { cwd: ROOT, stdio: "ignore", detached: true });
      current.add(extLoad.pid);
      stopAll.push(() => killTree(extLoad.pid));
    } else {
      // From inside the server, exactly as a worker spawn: its child, its process group, its cgroup.
      // nice0: as master does. nice10: os.setPriority right after spawn. fixed: the shipped code path
      // (server/process-priority.ts's hook read by pi-config/extensions/subagents/priority.ts).
      const nice = variant === "nice10" ? NICE : 0;
      const fixed = variant === "fixed";
      const started = await cdp.evaluate(`(async () => {
        const cp = process.getBuiltinModule('child_process'); const os = process.getBuiltinModule('os');
        // Loaded BEFORE the spawn, as the product has it: compiling it after the spawn (31 ms cold)
        // let the stand-in start its first commands at nice 0 (18 ms), which skewed run fixed #1
        // of 2026-10-03.
        const req = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(ROOT, "package.json"))});
        const priority = ${fixed} ? req(${JSON.stringify(join(ROOT, "pi-config", "extensions", "subagents", "priority.ts"))}) : null;
        const c = cp.spawn(process.execPath, ${JSON.stringify([standin, ...standinArgs])}, { cwd: ${JSON.stringify(ROOT)}, stdio: 'ignore' });
        if (${nice}) os.setPriority(c.pid, ${nice});
        if (${fixed}) {
          // Runtime.evaluate has no dynamic import, and process-priority.ts needs the ESM-only pi
          // package; so until a hosted runtime installs the server's hook, the same reading
          // (readWorkerNice: SOVA_WORKER_NICE, else workerNice in settings, else 10) stands in for it.
          const g = globalThis, key = Symbol.for('sova:worker-nice');
          if (typeof g[key] !== 'function') g[key] = () => {
            const env = process.env.SOVA_WORKER_NICE?.trim();
            if (env && /^\\d+$/.test(env) && Number(env) <= 19) return Number(env);
            try { const n = JSON.parse(process.getBuiltinModule('fs').readFileSync(${JSON.stringify(join(AGENT, "sova", "settings.json"))}, 'utf8')).workerNice; if (Number.isInteger(n) && n >= 0 && n <= 19) return n; } catch {}
            return 10;
          };
          priority.lowerPriority(c.pid);
        }
        globalThis.__perfLoad = c; return { pid: c.pid, nice: os.getPriority(c.pid), server: os.getPriority() };
      })()`, true);
      log(`${runId}: load started as the server's child pid ${started.pid} at nice ${started.nice} (server at ${started.server})`);
      stopAll.push(() => cdp.evaluate(`(() => { try { globalThis.__perfLoad.kill('SIGTERM'); } catch {} return true; })()`).catch(() => {}));
    }
    await sleep(T.ramp * 1000);
    log(`${runId}: measuring load ${T.load}s (load1 ${readFileSync("/proc/loadavg", "utf8").split(" ")[0]})`);
    phase = "load";
    await sleep(T.load * 1000);
    phase = "done";
    for (const s of stopAll.splice(0)) await s();
    running = false;
    await Promise.race([Promise.all(loops), sleep(130_000)]);
  } finally {
    for (const s of stopAll.splice(0)) await s();
    cdp?.close();
    killTree(server.pid);
    await sleep(3000);
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {}
    current.clear();
  }
  writeFileSync(join(OUT, `${runId}.samples.jsonl`), samples.map((s) => JSON.stringify(s)).join("\n") + "\n");
  writeFileSync(join(OUT, `${runId}.meta.json`), JSON.stringify({ runId, variant, rep, nice: variant === "nice10" ? NICE : variant === "fixed" ? "setting" : 0, weight: variant.startsWith("weight") ? WEIGHT : null, mix: MIX, T, systemd, bigPath }, null, 1));
  const s = runStats(samples).load;
  log(`${runId}: load /api/sessions p50 ${r(s.sessions.p50)} p95 ${r(s.sessions.p95)} ms, reload p50 ${r(s.reload.p50)}, ELD max p95 ${r(s.eldMax.p95)} ms, load1 ${r(s.load1)}`);
  log(`${runId}: cooling ${T.cool}s`);
  await sleep(T.cool * 1000);
}

// Ctrl-C (or SIGTERM) mid-run: take the current server and load down with us.
const current = new Set();
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    log(`${sig}: stopping the current run`);
    for (const pid of current) killTree(pid);
    setTimeout(() => {
      for (const pid of current) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
      cleanup();
      process.exit(130);
    }, 3000);
  });

// zsh runs `cmd &` at nice 5 (BG_NICE), and every server and load here would inherit it.
if (getPriority() !== 0) log(`WARNING: this harness runs at nice ${getPriority()}, not 0; its servers inherit it (zsh: setopt NO_BG_NICE, or run in the foreground)`);

if (!existsSync(join(AGENT, "sessions"))) throw new Error(`no sessions in ${AGENT}: run with --prepare first`);
const big = probeSession();
log(`out ${OUT}; agent ${AGENT}; transcript probe ${big.path} (${(big.size / 1e6).toFixed(1)} MB); systemd scopes ${systemd}; variants ${VARIANTS.join(",")} x ${REPS}; mix ${MIX}; phases ${JSON.stringify(T)}`);
// Rotate the order each rep so slow drift in machine load spreads over every variant.
for (let rep = 1; rep <= REPS; rep++) {
  const order = VARIANTS.map((_, i) => VARIANTS[(i + rep - 1) % VARIANTS.length]);
  for (const v of order) await oneRun(v, rep, big.path);
}
process.stdout.write(summarize(OUT));
