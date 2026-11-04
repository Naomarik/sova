// feed: one variant of the in-process A/B (run by feed-ab.mjs, one bun child per variant, so the
// process's CPU is the variant's own). Builds the sessions feed the way <src>/server/index.ts wires
// /ws/watch?feed=sessions, attaches one fake subscriber (the tab), and plays a seeded agent-like
// load on the copied sessions in PI_CODING_AGENT_DIR.
//
//   PI_CODING_AGENT_DIR=<copy agent dir> bun scripts/bench-session-list/feed.ts --src <tree> --label x --out f.json
//        [--seed 42] [--busy 4] [--warmup 30] [--idle 180] [--load 180] [--cool 20] [--min-gap 0.5] [--max-gap 2]
//
// Wiring (mirrors <src>/server/index.ts): list = listSessions or, when that index.ts wires it,
// listSessionsTracked (+ trackSessionFiles' note as the watch's `files`); watch = watchFeedInputs +
// onAttentionNotified; after = overseer feedFrames, frameKey = feedFrameKey.
// Stubbed the same way in both (.tmp/cpu-notes.md "Bench stubs"): events.seeList = identity (it is
// asleep without a /ws/events subscriber in the server too); watch checks = [] (checkReadinessInputs
// needs configureReadiness and git); no chats, panes, live records, mesh or model runtime.
// The tab: on list_changed / groups_changed, a GET /api/sessions (listSessions() + JSON, as
// app.ts serves it) with the app's 1 s nudge throttle; on rows-style frames (Part B) see TAB_ROWS.

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
const LABEL = opt("label", "run")!;
const SEED = Number(opt("seed", "42"));
const BUSY = Number(opt("busy", "4"));
const BURST = { n: Number(opt("burst", "20")), gapMs: Number(opt("burst-gap", "3")) * 1000 };
const T = { warmup: Number(opt("warmup", "30")), idle: Number(opt("idle", "180")), load: Number(opt("load", "180")), cool: Number(opt("cool", "20")) };
const GAP = { min: Number(opt("min-gap", "0.5")) * 1000, max: Number(opt("max-gap", "2")) * 1000 };
const S = (m: string) => join(SRC, "server", m);

const indexSrc = readFileSync(S("index.ts"), "utf8");
const TRACKED = /list:\s*\([^)]*\)\s*=>\s*listSessionsTracked\(/.test(indexSrc);
const idx: any = await import(S("sessions-index.ts"));
const feedMod: any = await import(S("session-feed.ts"));
const watchMod: any = await import(S("session-feed-watch.ts"));
const memo: any = await import(S("attention-memo.ts"));
const overseer: any = await import(S("overseer.ts"));

// ── counters ───────────────────────────────────────────────────────────────────────────────────
const st = { diffCpuMs: 0, tabCpuMs: 0, listCalls: 0, listCpuMs: 0, afterCalls: 0, afterCpuMs: 0, msgs: 0, msgBytes: 0, byType: {} as Record<string, number>, bytesByType: {} as Record<string, number>, gets: 0, getBytes: 0, getCpuMs: 0, lines: 0 };
const cpuMs = () => { const c = process.cpuUsage(); return (c.user + c.system) / 1000; };
const io = () => {
  const t = readFileSync("/proc/self/io", "utf8");
  return { rchar: Number(/rchar: (\d+)/.exec(t)![1]), readBytes: Number(/read_bytes: (\d+)/.exec(t)![1]), syscr: Number(/syscr: (\d+)/.exec(t)![1]) };
};

// ── the feed, wired as index.ts wires it ───────────────────────────────────────────────────────
const seeList = <T,>(l: T) => l;
const listFn = TRACKED ? idx.listSessionsTracked : idx.listSessions;
let feedChanged: (() => void) | null = null;
const feed = feedMod.configureSessionFeed({
  stamps: idx.listStamps,
  list: async (opts: unknown) => {
    st.listCalls++;
    const c0 = cpuMs();
    const l = seeList(await listFn(opts));
    st.listCpuMs += cpuMs() - c0;
    return l;
  },
  watch: (changed: () => void) => {
    feedChanged = changed;
    const tracked = TRACKED ? idx.trackSessionFiles() : null;
    const offWatch = watchMod.watchFeedInputs(changed, tracked ? { checks: [], files: tracked.note } : { checks: [] });
    const offAttention = memo.onAttentionNotified(changed);
    return () => {
      feedChanged = null;
      offWatch();
      tracked?.stop();
      offAttention();
    };
  },
  after: async (list: any) => {
    st.afterCalls++;
    const c0 = cpuMs();
    const frames = await overseer.feedFrames(list);
    st.afterCpuMs += cpuMs() - c0;
    return frames;
  },
  frameKey: overseer.feedFrameKey,
});

const samples = { diff: [] as any[], get: [] as any[] };

// The whole re-diff (list + marks + row signatures/deltas + after), timed by wrapping the feed's
// own diff method; CPU outside it is background (readiness, live checks, watch, timers).
{
  const orig = (feed as any).diff.bind(feed);
  (feed as any).diff = async (...a: any[]) => {
    const c0 = cpuMs(), l0 = st.listCpuMs, a0 = st.afterCpuMs, t0 = performance.now();
    try {
      return await orig(...a);
    } finally {
      const d = cpuMs() - c0;
      st.diffCpuMs += d;
      samples.diff.push({ phase, cpuMs: d, listMs: st.listCpuMs - l0, afterMs: st.afterCpuMs - a0, wallMs: performance.now() - t0 });
    }
  };
}

// ── the tab ────────────────────────────────────────────────────────────────────────────────────
function throttle(run: () => void, gap = 1000) {
  let last = -Infinity, pending: any = null;
  const fire = () => { pending = null; last = Date.now(); run(); };
  return () => {
    if (pending) return;
    const wait = last + gap - Date.now();
    if (wait <= 0) fire(); else pending = setTimeout(fire, wait);
  };
}
const ROWS = args.includes("--rows");
// The rows tab is the app's own client logic (src/lib/list-rows.ts ListRows); its CPU is the
// tab's, counted apart (tabCpuSec), never as the server's.
const ListRows: any = ROWS ? (await import(join(SRC, "src", "lib", "list-rows.ts"))).ListRows : null;
const tabCpu = <T,>(fn: () => T): T => {
  const c0 = cpuMs();
  try {
    return fn();
  } finally {
    st.tabCpuMs += cpuMs() - c0;
  }
};
async function getSessions(): Promise<{ body: string; at: { epoch: string; version: number } | null }> {
  const c0 = cpuMs();
  // app.ts as each tree has it: through feed.snapshot (with the list version) when it exists.
  let body: string, at = null;
  if (typeof feed.snapshot === "function") {
    const snap = await feed.snapshot(idx.listSessions);
    body = JSON.stringify(snap.body);
    at = { epoch: snap.epoch, version: snap.version };
  } else body = JSON.stringify(await idx.listSessions());
  st.gets++;
  st.getBytes += Buffer.byteLength(body);
  st.getCpuMs += cpuMs() - c0;
  samples.get.push({ phase, cpuMs: cpuMs() - c0 });
  return { body, at };
}
let lr: any = null;
const read = () => {
  lr?.fetchStarted();
  void getSessions().then(
    (r) => tabCpu(() => lr?.snapshot(JSON.parse(r.body), r.at)),
    (e) => { lr?.fetchFailed(); console.error("[tab] GET failed:", e); },
  );
};
const nudge = throttle(read);
if (ROWS) lr = new ListRows({ refetch: nudge, publish: () => {} });
const onMsg = (msg: any) => {
  const json = JSON.stringify(msg); // ws.ts sendJson
  const ty = msg?.type ?? "?";
  st.msgs++;
  st.msgBytes += Buffer.byteLength(json);
  st.byType[ty] = (st.byType[ty] ?? 0) + 1;
  st.bytesByType[ty] = (st.bytesByType[ty] ?? 0) + Buffer.byteLength(json);
  const handled = lr ? tabCpu(() => lr.message(JSON.parse(json))) : false;
  if (!handled && (ty === "list_changed" || ty === "groups_changed")) nudge();
};
lr?.socketOpened();
const unsubscribe = ROWS ? feed.add(onMsg, { rows: true }) : feed.add(onMsg);
read(); // the page's first GET


// ── load ───────────────────────────────────────────────────────────────────────────────────────
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
const all = sessions(join(AGENT, "sessions")).sort();
const pick = rng(SEED);
const pool = all.filter((p) => { const s = statSync(p).size; return s > 100_000 && s < 8_000_000; });
const targets: { file: string; tmpl: any[]; leaf: string | null }[] = [];
while (targets.length < BUSY && pool.length) {
  const file = pool.splice(Math.floor(pick() * pool.length), 1)[0]!;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const tmpl = lines.filter((l) => l.length < 32_000 && l.startsWith('{"type":"message"')).map((l) => JSON.parse(l));
  if (tmpl.length < 40) continue;
  let leaf: string | null = null;
  for (let j = lines.length - 1; j >= 0 && !leaf; j--) { try { leaf = JSON.parse(lines[j]!).id ?? null; } catch {} }
  targets.push({ file, tmpl, leaf });
}
let phase = "warmup";
const linesBy: Record<string, number> = {};
/** One real-shaped line appended to a target: its own message line k, re-stamped and chained. */
function appendOne(t: { file: string; tmpl: any[]; leaf: string | null }, r: () => number, k: number) {
  const e = structuredClone(t.tmpl[k % t.tmpl.length]);
  const id = Math.floor(r() * 0xffffffff).toString(16).padStart(8, "0");
  const now = new Date();
  e.id = id;
  e.parentId = t.leaf;
  e.timestamp = now.toISOString();
  if (e.message && typeof e.message.timestamp === "number") e.message.timestamp = now.getTime();
  t.leaf = id;
  appendFileSync(t.file, JSON.stringify(e) + "\n");
  linesBy[phase] = (linesBy[phase] ?? 0) + 1;
}

function startWriters() {
  let stopped = false;
  const timers: any[] = [];
  targets.forEach((t, i) => {
    const r = rng(SEED * 1000 + i + 1);
    let k = Math.floor(r() * t.tmpl.length);
    const tick = () => {
      if (stopped) return;
      appendOne(t, r, k++);
      timers[i] = setTimeout(tick, GAP.min + r() * (GAP.max - GAP.min));
    };
    timers[i] = setTimeout(tick, r() * GAP.max);
  });
  return () => { stopped = true; timers.forEach(clearTimeout); };
}

// ── phases ─────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phases: Record<string, any> = {};
const series: any[] = [];
let prevCpu = cpuMs(), prevIo = io();
const sampler = setInterval(() => {
  const c = cpuMs(), i = io();
  series.push({ phase, t: Date.now(), cpuMs: Math.round(c - prevCpu), rcharMB: +((i.rchar - prevIo.rchar) / 1e6).toFixed(2), lists: st.listCalls, gets: st.gets });
  prevCpu = c; prevIo = i;
}, 1000);
async function runPhase(name: string, secs: number, fn?: () => () => void) {
  phase = name;
  const c0 = cpuMs(), i0 = io(), s0 = structuredClone(st), d0 = feed.diffs;
  const ts0 = { ...(idx.trackedStats ?? {}) }, io0 = { ...(idx.listIo ?? {}) };
  const stop = fn?.();
  await sleep(secs * 1000);
  stop?.();
  const c1 = cpuMs(), i1 = io();
  const delta = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v - (b[k] ?? 0)]).filter(([, v]) => v));
  phases[name] = {
    secs,
    cpuSec: (c1 - c0) / 1000,
    cpuPct: ((c1 - c0) / 1000 / secs) * 100,
    rcharMB: (i1.rchar - i0.rchar) / 1e6,
    readBytesMB: (i1.readBytes - i0.readBytes) / 1e6,
    syscr: i1.syscr - i0.syscr,
    rssMB: process.memoryUsage().rss / 1e6,
    diffs: feed.diffs - d0,
    listCalls: st.listCalls - s0.listCalls,
    listCpuSec: (st.listCpuMs - s0.listCpuMs) / 1000,
    afterCpuSec: (st.afterCpuMs - s0.afterCpuMs) / 1000,
    tabCpuSec: (st.tabCpuMs - s0.tabCpuMs) / 1000,
    diffCpuSec: (st.diffCpuMs - s0.diffCpuMs) / 1000,
    diffRestCpuSec: (st.diffCpuMs - s0.diffCpuMs - (st.listCpuMs - s0.listCpuMs) - (st.afterCpuMs - s0.afterCpuMs)) / 1000,
    outsideDiffCpuSec: (c1 - c0 - (st.tabCpuMs - s0.tabCpuMs) - (st.diffCpuMs - s0.diffCpuMs) - (st.getCpuMs - s0.getCpuMs)) / 1000,
    serverCpuSec: (c1 - c0 - (st.tabCpuMs - s0.tabCpuMs)) / 1000,
    otherCpuSec: (c1 - c0 - (st.tabCpuMs - s0.tabCpuMs) - (st.listCpuMs - s0.listCpuMs) - (st.afterCpuMs - s0.afterCpuMs) - (st.getCpuMs - s0.getCpuMs)) / 1000,
    trackedStats: idx.trackedStats ? delta({ ...idx.trackedStats }, ts0) : null,
    listIo: idx.listIo ? delta({ ...idx.listIo }, io0) : null,
    wsMsgs: st.msgs - s0.msgs,
    wsBytes: st.msgBytes - s0.msgBytes,
    byType: delta(st.byType, s0.byType),
    bytesByType: delta(st.bytesByType, s0.bytesByType),
    gets: st.gets - s0.gets,
    getMB: (st.getBytes - s0.getBytes) / 1e6,
    getCpuSec: (st.getCpuMs - s0.getCpuMs) / 1000,
    linesWritten: linesBy[name] ?? 0,
  };
  console.log(`[${LABEL}] ${name}: server cpu ${phases[name].serverCpuSec.toFixed(2)} s (list ${phases[name].listCpuSec.toFixed(2)}, after ${phases[name].afterCpuSec.toFixed(2)}, rest of diff ${phases[name].diffRestCpuSec.toFixed(2)}, GET ${phases[name].getCpuSec.toFixed(2)}, outside diffs ${phases[name].outsideDiffCpuSec.toFixed(2)}), read ${phases[name].rcharMB.toFixed(0)} MB, diffs ${phases[name].diffs}, msgs ${phases[name].wsMsgs} (${phases[name].wsBytes} B), GETs ${phases[name].gets} (${phases[name].getMB.toFixed(2)} MB), lines ${phases[name].linesWritten}`);
}

console.log(`[${LABEL}] tab ${ROWS ? "rows=1" : "list_changed"}, src ${SRC}, wiring ${TRACKED ? "listSessionsTracked" : "listSessions"}, ${all.length} sessions, targets:\n  ${targets.map((t) => t.file.slice(AGENT.length + 1)).join("\n  ")}`);
const t0 = cpuMs(), b0 = performance.now();
await feed.idle(); // the first (full, cold) diff
const cold = { cpuSec: (cpuMs() - t0) / 1000, wallSec: (performance.now() - b0) / 1000 };
console.log(`[${LABEL}] cold first diff: cpu ${cold.cpuSec.toFixed(2)} s, wall ${cold.wallSec.toFixed(2)} s`);
await runPhase("warmup", T.warmup);
await runPhase("idle", T.idle);
await runPhase("load", T.load, startWriters);
await runPhase("cool", T.cool);

// Per-action burst: one busy session, one line, then nothing for burst-gap; the CPU of that window
// (append → quiet: the debounced diff, its frames and the tab's reaction). Each is paired with a
// quiet control window of the same length just before it (background: readiness, live checks), so
// burst − control is the action's own cost.
const bursts: any[] = [];
if (BURST.n > 0) {
  phase = "burst";
  const t = targets[0]!;
  const r = rng(SEED * 1000 + 99);
  let k = Math.floor(r() * t.tmpl.length);
  await sleep(BURST.gapMs);
  for (let i = 0; i < BURST.n; i++) {
    const q0 = cpuMs();
    await sleep(BURST.gapMs);
    const q = cpuMs() - q0;
    const d0 = feed.diffs, g0 = st.gets, m0 = st.msgs, tab0 = st.tabCpuMs;
    const b0 = cpuMs();
    appendOne(t, r, k++);
    await sleep(BURST.gapMs);
    await feed.idle();
    const b = cpuMs() - b0 - (st.tabCpuMs - tab0);
    bursts.push({ cpuMs: b, controlMs: q, netMs: b - q, diffs: feed.diffs - d0, gets: st.gets - g0, msgs: st.msgs - m0 });
  }
}
clearInterval(sampler);
unsubscribe();
const out = opt("out");
const stat = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
  return { n: xs.length, mean: xs.reduce((a, b) => a + b, 0) / xs.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
};
const loadDiffs = samples.diff.filter((d) => d.phase === "load");
const perChange = {
  diffCpuMs: stat(loadDiffs.map((d) => d.cpuMs)),
  listMs: stat(loadDiffs.map((d) => d.listMs)),
  restOfDiffMs: stat(loadDiffs.map((d) => d.cpuMs - d.listMs)),
  afterMs: stat(loadDiffs.map((d) => d.afterMs)),
  getMs: stat(samples.get.filter((g) => g.phase === "load").map((g) => g.cpuMs)),
  idleListMs: stat(samples.diff.filter((d) => d.phase === "idle").map((d) => d.listMs)),
};
const burst = { raw: stat(bursts.map((b) => b.cpuMs)), control: stat(bursts.map((b) => b.controlMs)), net: stat(bursts.map((b) => b.netMs)), each: bursts };
console.log(`[${LABEL}] per change: diff ${perChange.diffCpuMs?.mean.toFixed(1)} ms (list ${perChange.listMs?.mean.toFixed(1)}, rest ${perChange.restOfDiffMs?.mean.toFixed(1)}), GET ${perChange.getMs?.mean.toFixed(1) ?? "-"} ms; burst net mean ${burst.net?.mean.toFixed(1)} p95 ${burst.net?.p95.toFixed(1)} ms`);
const result = { label: LABEL, perChange, burst, at: new Date().toISOString(), src: SRC, wiring: TRACKED ? "tracked" : "full", commit: opt("commit") ?? null, tab: ROWS ? { mode: "rows", refetches: lr.refetches, following: lr.following } : { mode: "list_changed" }, config: { seed: SEED, busy: BUSY, T, gapMs: GAP, sessions: all.length, targets: targets.map((t) => t.file.slice(AGENT.length + 1)) }, cold, phases, series, samples };
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log(`[${LABEL}] wrote ${out}${ROWS ? ` (tab refetches ${lr.refetches}, following ${lr.following})` : ""}`);
process.exit(0);
