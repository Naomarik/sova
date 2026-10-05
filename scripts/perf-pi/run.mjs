#!/usr/bin/env node
// perf-pi: Sova's performance on two trees that differ in their pi (the pi 0.87 → 1.0 bump), measured
// A/B in interleaved rounds on hermetic servers. docs/perf/2026-10-06-pi-1.0.md has the method and the
// numbers; README.md here has how to rerun it.
//
//   node scripts/perf-pi/run.mjs --prepare --base <tree> --after <tree>      # data + agent dirs (once)
//   node scripts/perf-pi/run.mjs --base <tree> --after <tree> [--rounds 8] [--out <dir>]
//        [--phases server,cli] [--turns 5] [--steers 3] [--max-load <load1>] [--label-base x --label-after y]
//   node scripts/perf-pi/run.mjs --summarize <out dir> [--aa <A/A out dir>]
//
// An A/A run (--base and --after the same tree) measures each metric's noise; pass its out dir as --aa
// to a summary (or to the A/B run itself) and each metric is judged against its own floor.
//
// Each <tree> is a checkout with its own `pnpm install` (e.g. a `git archive` copy). Every server runs
// that tree's scripts/start-server.sh (Bun, as `pnpm run dev:hermetic` does) on its own port (base 4870,
// after 4871) with PI_CODING_AGENT_DIR = a fresh copy of that side's hermetic agent dir under --work
// (default <this repo>/.agent/perf-pi), HOME and CLAUDE_CONFIG_DIR under it too, a fake `claude` first
// on PATH, PI_OFFLINE=1 and SOVA_PRICES_FETCH=off. The model is scripts/perf-pi/mock-llm.mjs on
// 127.0.0.1:4879, registered in the agent dir's models.json as `perfmock/mock-1`: no network, no auth.
// Nothing is written to ~/.pi (its sessions are only read, by --prepare) or to either tree.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, homedir, loadavg, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline";
import { ROOT, shown } from "../perf/paths.mjs";
import { compare, table } from "./stats.mjs";
import { MOCK_MODEL, MOCK_PROVIDER, copyRealSession, pickRealSample, writeSynth } from "./sessions.mjs";

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const HOME_PI = join(homedir(), ".pi");
const WORK = resolve(opt("work", join(ROOT, ".agent", "perf-pi")));
const SIDES = ["base", "after"];
const TREE = { base: opt("base") && resolve(opt("base")), after: opt("after") && resolve(opt("after")) };
const PORT = { base: Number(opt("port-base", "4870")), after: Number(opt("port-after", "4871")) };
const MOCK_PORT = Number(opt("mock-port", "4879"));
for (const p of [WORK, ...SIDES.map((s) => TREE[s]).filter(Boolean)]) {
  if (p === HOME_PI || p.startsWith(HOME_PI + "/")) throw new Error(`refusing a path inside ~/.pi: ${p}`);
}

/** Metric descriptions: label, unit, control (pi doesn't touch it), table order. */
const META = {};
let order = 0;
const def = (metric, label, unit = "ms", control = false) => (META[metric] = { label, unit, control, order: order++ });
def("start.health", "1 server cold start: spawn → /api/health 200");
def("start.rss", "1 RSS 10 s after start, idle", "MB");
def("models.first", "6 GET /api/models, first");
def("models", "6 GET /api/models, warm");
def("set_model", "6 set_model round trip (/ws/chat)");
def("open.first", "2 first runtime open (300 entries; pays module/extension load)");
def("open.warm", "2 runtime open, warm (300 entries, median of 9)");
for (const r of ["real-small", "real-medium", "real-large", "synth-50", "synth-500", "synth-2000", "synth-5000"]) def(`open.${r}`, `2 runtime open → hello: ${r}`);
def("mem.k0", "5 RSS before any runtime", "MB");
for (const k of [1, 5, 10]) def(`mem.k${k}`, `5 RSS with ${k} runtimes open`, "MB");
def("mem.per-runtime", "5 RSS per extra runtime ((k10 − k1) / 9)", "MB");
for (const L of [50, 500, 2000, 5000]) {
  def(`turn.${L}.ack`, `3 turn @${L} entries: prompt → send_ack`);
  def(`turn.${L}.request`, `3 turn @${L} entries: prompt → model request arrives`);
  def(`turn.${L}.first`, `3 turn @${L} entries: prompt → first event`);
  def(`turn.${L}.token`, `3 turn @${L} entries: prompt → first text delta`);
  def(`turn.${L}.settle`, `3 turn @${L} entries: prompt → agent_settled`);
}
def("steer.ack", "4 steer mid-stream → send_ack");
def("followup.ack", "4 follow-up mid-stream → send_ack");
def("steer.settle", "4 prompt + steer + follow-up → settled");
def("compact", "7 compaction (500 entries): compact → compacted");
def("rss.end", "5 RSS at the end of a run", "MB");
def("control.sessions", "9 control: GET /api/sessions", "ms", true);
def("control.transcript", "9 control: GET /api/transcript tail=1 (real-medium)", "ms", true);
def("control.transcript-full", "9 control: GET /api/transcript whole (real-large, 10.9 MB)", "ms", true);
def("cli.rpc-runner", "8 pi --mode rpc (runner flags, --no-extensions) → get_state");
def("cli.rpc-ext", "8 pi --mode rpc (extensions discovered) → get_state");
def("cli.layout.rpc-runner", "8 control: global vs scratch install of the SAME 0.87.0 (runner flags)", "ms", true);

// ── summarize ────────────────────────────────────────────────────────────────────────────────────

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** `--aa <dir>`: an A/A run's samples (the same tree as base and after): per-metric noise floors. */
function aaFloors() {
  const dir = opt("aa");
  if (!dir) return null;
  const { rows } = compare(readJsonl(join(resolve(dir), "samples.jsonl")), META);
  return Object.fromEntries(rows.filter((r) => r.deltaPct != null).map((r) => [r.metric, r.deltaPct]));
}

function summarize(out) {
  const samples = readJsonl(join(out, "samples.jsonl"));
  const result = compare(samples, META, aaFloors());
  const text = `${table(result)}\n`;
  writeFileSync(join(out, "summary.md"), text);
  writeFileSync(join(out, "summary.json"), JSON.stringify({ noiseFloor: result.noiseFloor, rows: result.rows.map(({ base, after, ...r }) => ({ ...r, base: { ...base, perRound: Object.fromEntries(base.perRound) }, after: { ...after, perRound: Object.fromEntries(after.perRound) } })) }, null, 1));
  return text;
}

if (has("summarize")) {
  process.stdout.write(summarize(resolve(opt("summarize", "."))));
  process.exit(0);
}

for (const s of SIDES) if (!TREE[s]) throw new Error(`--${s} <tree> is required`);
const piVersion = (tree) => JSON.parse(readFileSync(join(realpathSync(join(tree, "node_modules/@earendil-works/pi-coding-agent")), "package.json"), "utf8")).version;

// ── binaries: real paths, never mise shims (a shim refuses an untrusted tree or a throwaway HOME) ──

function bunPath() {
  if (process.env.SOVA_BUN) return process.env.SOVA_BUN;
  try {
    return execFileSync("mise", ["which", "bun"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return execFileSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  }
}
const NODE = process.execPath;
const BUN = bunPath();
const BIN = join(WORK, "bin");

// ── prepare ──────────────────────────────────────────────────────────────────────────────────────

const DATA = join(WORK, "data");
const MANIFEST = join(DATA, "manifest.json");

function mockModelsJson(tree) {
  const src = join(tree, "pi-config", "models.json");
  const models = existsSync(src) ? JSON.parse(readFileSync(src, "utf8")) : { providers: {} };
  models.providers ??= {};
  // The shape of server/harness/pi/testing/scripted-model.ts's scriptedModelsJson, on a live endpoint.
  models.providers[MOCK_PROVIDER] = {
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    api: "openai-completions",
    apiKey: "perfmock",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [
      { id: MOCK_MODEL, contextWindow: 2_000_000, maxTokens: 4000 },
      { id: "mock-2", contextWindow: 2_000_000, maxTokens: 4000 },
    ],
  };
  return `${JSON.stringify(models, null, 2)}\n`;
}

function prepare() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(join(DATA, "sessions"), { recursive: true });
  const src = resolve(opt("sessions", join(HOME_PI, "agent", "sessions")));
  const sessions = join(DATA, "sessions");
  const manifest = { roles: {}, list: [] };
  // Real sessions: copied in (read-only at the source), each header's cwd moved to a scratch dir.
  const realCwd = join(WORK, "cwd", "real");
  mkdirSync(realCwd, { recursive: true });
  for (const f of pickRealSample(src)) {
    const dest = copyRealSession(f.path, sessions, realCwd);
    const entries = readFileSync(dest, "utf8").split("\n").filter(Boolean).length - 1;
    if (f.role === "list") manifest.list.push(relative(sessions, dest));
    else manifest.roles[f.role] = { path: relative(sessions, dest), bytes: f.size, entries };
  }
  // Synthesized ones: the length series, the memory set, the compaction subject.
  const synthCwd = join(WORK, "cwd", "synth");
  mkdirSync(synthCwd, { recursive: true });
  const put = (role, entries, seed) => {
    const s = writeSynth(entries, sessions, synthCwd, seed);
    manifest.roles[role] = { path: relative(sessions, s.path), entries: s.entries };
  };
  for (const L of [50, 500, 2000, 5000]) put(`synth-${L}`, L, L);
  for (let i = 1; i <= 10; i++) put(`mem-${String(i).padStart(2, "0")}`, 300, 100 + i);
  put("synth-compact", 500, 99);
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));

  // A `claude` that never contacts Anthropic (scripts/fake-claude.mjs), first on every server's PATH.
  mkdirSync(BIN, { recursive: true });
  writeFileSync(join(BIN, "claude"), `#!/bin/sh\nexec ${JSON.stringify(NODE)} ${JSON.stringify(join(ROOT, "scripts", "fake-claude.mjs"))} "$@"\n`, { mode: 0o755 });

  for (const side of SIDES) {
    const tree = TREE[side];
    const template = join(WORK, side, "template");
    // The tree's own hermetic builder, pointed at the template (--copied-sessions: no wake nudge,
    // no copied schedule). Its output names the unlock URL with the token: kept out of the log.
    execFileSync(NODE, [join(tree, "scripts", "hermetic-agent-dir.mjs"), "--unlock-url", "--copied-sessions"], { cwd: tree, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, HERMETIC_AGENT_DIR: template } });
    rmSync(join(template, "models.json"), { force: true });
    writeFileSync(join(template, "models.json"), mockModelsJson(tree));
    cpSync(sessions, join(template, "sessions"), { recursive: true });
    // The pi CLI's agent dir: the same, without the sessions.
    const cli = join(WORK, side, "cli-agent");
    cpSync(template, cli, { recursive: true, verbatimSymlinks: true, filter: (p) => !p.startsWith(join(template, "sessions")) });
    console.log(`${side}: ${shown(tree)} (pi ${piVersion(tree)}), agent dir template ${shown(template)}`);
  }
  console.log(`data: ${shown(DATA)}: ${Object.keys(manifest.roles).length} named sessions, ${manifest.list.length} more for the listing`);
  for (const [role, r] of Object.entries(manifest.roles)) if (!role.startsWith("mem-")) console.log(`  ${role}: ${r.entries} entries${r.bytes ? `, ${(r.bytes / 1e6).toFixed(2)} MB` : ""}`);
}

if (has("prepare")) {
  prepare();
  process.exit(0);
}

if (!existsSync(MANIFEST)) throw new Error(`no data in ${WORK}: run with --prepare first`);
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

// ── output ───────────────────────────────────────────────────────────────────────────────────────

const OUT = resolve(opt("out", join(ROOT, "docs", "perf", "data", "pi-1.0")));
mkdirSync(OUT, { recursive: true });
const LOGS = join(WORK, "logs");
mkdirSync(LOGS, { recursive: true });
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`;
  console.log(line);
  appendFileSync(join(OUT, "run.log"), line + "\n");
};
let round = 0;
let side = "base";
const sample = (metric, value, extra = {}) => {
  if (value == null || !Number.isFinite(value)) return;
  appendFileSync(join(OUT, "samples.jsonl"), JSON.stringify({ metric, side, round, value: Math.round(value * 1000) / 1000, ...extra }) + "\n");
};
const now = () => performance.timeOrigin + performance.now();
const machine = () => {
  const [l1, l5, l15] = loadavg();
  let psi = null;
  try {
    psi = Number(/some avg10=([\d.]+)/.exec(readFileSync("/proc/pressure/cpu", "utf8"))[1]);
  } catch {}
  return { load1: l1, load5: l5, load15: l15, cpuPsiSome10: psi };
};

// ── the mock model ───────────────────────────────────────────────────────────────────────────────

const mockRequests = [];
function startMock() {
  const child = spawn(NODE, [join(ROOT, "scripts", "perf-pi", "mock-llm.mjs"), "--port", String(MOCK_PORT), "--chunks", opt("chunks", "8"), "--gap", opt("gap", "15")], { stdio: ["ignore", "pipe", "inherit"] });
  const ready = new Promise((ok) => {
    createInterface({ input: child.stdout }).on("line", (l) => {
      const m = JSON.parse(l);
      if (m.ready) ok();
      else mockRequests.push(m);
    });
  });
  return { child, ready };
}

// ── one server ───────────────────────────────────────────────────────────────────────────────────

/** An A/A run (the same tree on both sides) gives both sides the base agent dir, and the base CLI. */
const AA = TREE.after === TREE.base;
const templateSide = (s) => (AA ? "base" : s);

function startServer(runId) {
  const tree = TREE[side];
  const agent = join(WORK, side, "agent");
  const home = join(WORK, side, "home");
  // A fresh copy of the template each run: every run starts from the same sessions and Sova state.
  // HOME stays, as a real one does: Bun's and Node's on-disk caches there are warm after the warm-up.
  rmSync(agent, { recursive: true, force: true });
  cpSync(join(WORK, templateSide(side), "template"), agent, { recursive: true, verbatimSymlinks: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  const env = {
    ...process.env,
    PATH: [BIN, dirname(NODE), dirname(BUN), process.env.PATH].join(":"),
    HOME: home,
    PORT: String(PORT[side]),
    PI_CODING_AGENT_DIR: agent,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    SOVA_BUN: BUN,
    SOVA_NODE: NODE,
    SOVA_PRICES_FETCH: "off",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  delete env.SOVA_RUNTIME;
  const t0 = now();
  const child = spawn(join(tree, "scripts", "start-server.sh"), [], { cwd: tree, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const logFile = join(LOGS, `${runId}.server.log`);
  child.stdout.on("data", (b) => appendFileSync(logFile, b));
  child.stderr.on("data", (b) => appendFileSync(logFile, b));
  const exited = new Promise((ok) => child.once("exit", ok));
  return { child, t0, agent, exited, base: `http://127.0.0.1:${PORT[side]}`, token: () => readFileSync(join(agent, "sova", "auth-token"), "utf8").trim() };
}

async function stopServer(srv) {
  try {
    process.kill(-srv.child.pid, "SIGTERM");
  } catch {}
  const t = await Promise.race([srv.exited.then(() => "exited"), sleep(10_000).then(() => "timeout")]);
  if (t === "timeout") {
    log(`  server ${srv.child.pid} ignored SIGTERM for 10 s: SIGKILL`);
    try {
      process.kill(-srv.child.pid, "SIGKILL");
    } catch {}
    await srv.exited;
  }
}

function rssMb(pid) {
  try {
    const kb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]);
    return kb / 1024;
  } catch {
    return null;
  }
}

/** A /ws/chat client on the global WebSocket: every message is kept with its arrival time. */
function chatSocket(srv, path, headers) {
  const url = `${srv.base.replace(/^http/, "ws")}/ws/chat?path=${encodeURIComponent(path)}&force=1&tail=rest`;
  const t0 = now();
  const ws = new WebSocket(url, { headers });
  const got = [];
  const waiters = new Set();
  const check = () => {
    for (const w of [...waiters]) {
      const hit = got.find((m, i) => i >= w.from && w.pred(m.msg));
      if (hit) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.ok(hit);
      }
    }
  };
  ws.onmessage = (e) => {
    got.push({ at: now(), msg: JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(e.data).toString()) });
    check();
  };
  const opened = new Promise((ok, no) => {
    ws.onopen = () => ok(now());
    ws.onerror = (e) => no(new Error(`ws ${path}: ${e.message ?? "error"}`));
  });
  /** The first message from index `from` on that matches. */
  const wait = (pred, ms, what, from = 0) =>
    new Promise((ok, no) => {
      const w = { pred, from, ok, timer: setTimeout(() => (waiters.delete(w), no(new Error(`timed out after ${ms} ms: ${what}`))), ms) };
      waiters.add(w);
      check();
    });
  const send = (m) => ws.send(JSON.stringify(m));
  return { ws, t0, got, opened, wait, send, close: () => ws.close() };
}

const isEvent = (type) => (m) => m.type === "event" && m.event?.type === type;
const isTextDelta = (m) => m.type === "event" && m.event?.type === "message_update" && m.event?.assistantMessageEvent?.type === "text_delta";

/** Open one chat runtime; resolves when its hello arrives. */
async function openChat(srv, headers, role) {
  const path = join(srv.agent, "sessions", manifest.roles[role].path);
  const c = chatSocket(srv, path, headers);
  await c.opened;
  const hello = await c.wait((m) => m.type === "hello" || m.type === "error", 120_000, `${role} hello`);
  if (hello.msg.type === "error") throw new Error(`${role}: ${JSON.stringify(hello.msg).slice(0, 300)}`);
  c.helloMs = hello.at - c.t0;
  return c;
}

/** Wait until the chat is quiet: an agent_settled since `from`, then `quietMs` with no new event. */
async function settled(c, from, ms = 120_000, quietMs = 400) {
  let at = from;
  let hit;
  for (;;) {
    hit = await c.wait(isEvent("agent_settled"), ms, "agent_settled", at);
    const idx = c.got.indexOf(hit);
    await sleep(quietMs);
    const more = c.got.slice(idx + 1).some((m) => m.msg.type === "event");
    if (!more) return hit;
    at = idx + 1;
  }
}

async function turn(c, text) {
  const id = `perf-${Math.random().toString(36).slice(2)}`;
  const from = c.got.length;
  const reqFrom = mockRequests.length;
  const t0 = now();
  c.send({ type: "prompt", text, clientId: id });
  const ack = await c.wait((m) => m.type === "send_ack" && m.clientId === id, 60_000, "send_ack", from);
  const first = await c.wait((m) => m.type === "event", 60_000, "first event", from);
  const token = await c.wait(isTextDelta, 120_000, "first text delta", from);
  const settle = await settled(c, from);
  const req = mockRequests.slice(reqFrom).find((r) => r.at >= t0 - 5);
  return { ack: ack.at - t0, first: first.at - t0, token: token.at - t0, settle: settle.at - t0, request: req ? req.at - t0 : null, reqBytes: req?.bytes };
}

async function timed(fn) {
  const t0 = now();
  await fn();
  return now() - t0;
}

/** Poll /api/health every 10 ms until it answers 200. */
async function healthy(srv, runId) {
  for (;;) {
    if (srv.child.exitCode != null) throw new Error(`server exited (${srv.child.exitCode}) before it was healthy; see ${shown(join(LOGS, `${runId}.server.log`))}`);
    try {
      const res = await fetch(`${srv.base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {}
    if (now() - srv.t0 > 120_000) throw new Error("server not healthy after 120 s");
    await sleep(10);
  }
}

/** Round 0, recorded nowhere: one server start per side and one pi CLI start per variant, so the
    on-disk caches (Bun's transpiler cache, Node's compile cache) are warm for every measured run. */
async function warmUp() {
  for (const s of SIDES) {
    side = s;
    if (PHASES.includes("server")) {
      const runId = `r0-${side}-warmup`;
      const srv = startServer(runId);
      try {
        await healthy(srv, runId);
      } finally {
        await stopServer(srv);
      }
    }
  }
  if (PHASES.includes("cli")) {
    const v = cliVariants();
    for (const k of Object.keys(v)) for (const flags of ["rpc-runner", "rpc-ext"]) await cliStart(v[k].pkg, v[k].agentSide, flags);
  }
  log("warm-up done (round 0, not recorded)");
}

async function serverRun() {
  const runId = `r${round}-${side}-${Date.now().toString(36)}`;
  const before = machine();
  log(`round ${round} ${side}: start (${runId}) load1 ${before.load1.toFixed(1)} psi ${before.cpuPsiSome10}`);
  const srv = startServer(runId);
  const errors = [];
  const sockets = [];
  try {
    // 1. Cold start.
    await healthy(srv, runId);
    sample("start.health", now() - srv.t0);
    await sleep(10_000);
    sample("start.rss", rssMb(srv.child.pid));
    const headers = { "x-sova-token": srv.token() };
    const get = async (p) => {
      const t0 = now();
      const res = await fetch(`${srv.base}${p}`, { headers, signal: AbortSignal.timeout(120_000) });
      await res.arrayBuffer();
      if (!res.ok) throw new Error(`GET ${p}: ${res.status}`);
      return now() - t0;
    };
    // 6 and 9. Model registry and the controls, before any runtime.
    sample("models.first", await get("/api/models"));
    for (let i = 0; i < 9; i++) sample("models", await get("/api/models"));
    const medium = join(srv.agent, "sessions", manifest.roles["real-medium"].path);
    for (let i = 0; i < 10; i++) sample("control.sessions", await get("/api/sessions"));
    for (let i = 0; i < 10; i++) sample("control.transcript", await get(`/api/transcript?path=${encodeURIComponent(medium)}&tail=1`));

    // 5. Memory with K runtimes (and 2: the first open pays the one-time module and extension load).
    await sleep(2000);
    sample("mem.k0", rssMb(srv.child.pid));
    const warm = [];
    for (let i = 1; i <= 10; i++) {
      const c = await openChat(srv, headers, `mem-${String(i).padStart(2, "0")}`);
      sockets.push(c);
      await sleep(500); // let the open's background work finish before the next one
      if (i === 1) sample("open.first", c.helloMs);
      else warm.push(c.helloMs);
      if (i === 1 || i === 5 || i === 10) {
        await sleep(2000);
        sample(`mem.k${i}`, rssMb(srv.child.pid));
      }
    }
    warm.sort((a, b) => a - b);
    sample("open.warm", warm[warm.length >> 1]);
    const per = readJsonl(join(OUT, "samples.jsonl")).filter((s) => s.round === round && s.side === side);
    const k1 = per.find((s) => s.metric === "mem.k1")?.value;
    const k10 = per.find((s) => s.metric === "mem.k10")?.value;
    if (k1 != null && k10 != null) sample("mem.per-runtime", (k10 - k1) / 9);

    // 2. Opens by size.
    const chats = {};
    for (const role of ["real-small", "real-medium", "real-large", "synth-50", "synth-500", "synth-2000", "synth-5000"]) {
      try {
        const c = await openChat(srv, headers, role);
        sockets.push(c);
        await sleep(500);
        chats[role] = c;
        sample(`open.${role}`, c.helloMs);
      } catch (e) {
        errors.push(`open ${role}: ${e.message}`);
        log(`  open ${role} failed: ${e.message}`);
      }
    }

    // 3. Turns by session length.
    const TURNS = Number(opt("turns", "5"));
    for (const L of [50, 500, 2000, 5000]) {
      const c = chats[`synth-${L}`];
      if (!c) continue;
      for (let i = 0; i < TURNS; i++) {
        try {
          const t = await turn(c, `perf turn ${i} on ${L} entries: reply briefly.`);
          for (const k of ["ack", "request", "first", "token", "settle"]) sample(`turn.${L}.${k}`, t[k], { i, reqBytes: t.reqBytes });
        } catch (e) {
          errors.push(`turn ${L}#${i}: ${e.message}`);
          log(`  turn ${L}#${i} failed: ${e.message}`);
        }
        await sleep(200);
      }
    }

    // 4. Steer and follow-up while a reply streams.
    const sc = chats["synth-500"];
    for (let i = 0; sc && i < Number(opt("steers", "3")); i++) {
      try {
        const from = sc.got.length;
        const t0 = now();
        const pid = `perf-p-${i}-${Date.now()}`;
        sc.send({ type: "prompt", text: `perf steer round ${i}: reply at length.`, clientId: pid });
        await sc.wait(isTextDelta, 60_000, "first text delta", from);
        const sid = `perf-s-${i}-${Date.now()}`;
        const ts = now();
        sc.send({ type: "steer", text: `steer ${i}: also mention the weather.`, clientId: sid });
        const sAck = await sc.wait((m) => m.type === "send_ack" && m.clientId === sid, 30_000, "steer ack", from);
        sample("steer.ack", sAck.at - ts, { queued: sAck.msg.queued });
        const fid = `perf-f-${i}-${Date.now()}`;
        const tf = now();
        sc.send({ type: "prompt", text: `follow-up ${i}: one more line.`, clientId: fid });
        const fAck = await sc.wait((m) => m.type === "send_ack" && m.clientId === fid, 30_000, "follow-up ack", from);
        sample("followup.ack", fAck.at - tf, { queued: fAck.msg.queued });
        const done = await settled(sc, from, 120_000, 800);
        sample("steer.settle", done.at - t0);
      } catch (e) {
        errors.push(`steer #${i}: ${e.message}`);
        log(`  steer #${i} failed: ${e.message}`);
      }
      await sleep(300);
    }

    // 6. set_model there and back.
    const mc = chats["synth-50"];
    for (let i = 0; mc && i < 3; i++) {
      for (const ref of [`${MOCK_PROVIDER}/mock-2`, `${MOCK_PROVIDER}/${MOCK_MODEL}`]) {
        const from = mc.got.length;
        const t0 = now();
        mc.send({ type: "set_model", ref });
        const a = await mc.wait((m) => m.type === "model" || m.type === "error", 30_000, "set_model answer", from);
        if (a.msg.type === "model") sample("set_model", a.at - t0);
        else errors.push(`set_model ${ref}: ${JSON.stringify(a.msg).slice(0, 200)}`);
        await sleep(100);
      }
    }

    // 7. Compaction of a 500-entry session.
    try {
      const cc = await openChat(srv, headers, "synth-compact");
      sockets.push(cc);
      const from = cc.got.length;
      const t0 = now();
      const reqFrom = mockRequests.length;
      cc.send({ type: "compact", id: "perf-compact" });
      const a = await cc.wait((m) => (m.type === "compacted" || m.type === "compact_refused" || m.type === "error") && (m.id === "perf-compact" || m.type === "error"), 120_000, "compacted", from);
      // summarized: the mock saw pi's summarization request, so the time includes a model call.
      if (a.msg.type === "compacted") sample("compact", a.at - t0, { summarized: mockRequests.slice(reqFrom).some((r) => r.summary), tokensBefore: a.msg.tokensBefore });
      else errors.push(`compact: ${JSON.stringify(a.msg).slice(0, 300)}`);
    } catch (e) {
      errors.push(`compact: ${e.message}`);
    }
    sample("rss.end", rssMb(srv.child.pid));
    // Last, so its ~40 MB response never inflates an RSS reading: the heavier control.
    const large = join(srv.agent, "sessions", manifest.roles["real-large"].path);
    for (let i = 0; i < 3; i++) sample("control.transcript-full", await get(`/api/transcript?path=${encodeURIComponent(large)}`));
  } catch (e) {
    errors.push(`run: ${e.message}`);
    log(`  run failed: ${e.message}`);
  } finally {
    for (const c of sockets) c.close();
    await stopServer(srv);
  }
  const after = machine();
  appendFileSync(join(OUT, "runs.jsonl"), JSON.stringify({ round, side, runId, pi: piVersion(TREE[side]), before, after, errors }) + "\n");
  log(`round ${round} ${side}: done, ${errors.length} error(s), load1 ${after.load1.toFixed(1)}`);
}

// ── 8. pi CLI startup (rpc mode, as the subagent runner starts a worker) ─────────────────────────

function cliVariants() {
  const scratch = (v) => join(resolve(opt("cli-dir", join(ROOT, ".agent", "pi-cli"))), v, "node_modules", "@earendil-works", "pi-coding-agent");
  const globalPkg = opt("cli-global", join(dirname(dirname(NODE)), "lib", "node_modules", "@earendil-works", "pi-coding-agent"));
  return {
    base: { pkg: globalPkg, agentSide: "base" },
    // A/A: the base CLI on both sides.
    after: AA ? { pkg: globalPkg, agentSide: "base" } : { pkg: scratch(opt("cli-after-version", "1.0.3")), agentSide: "after" },
    layout: { pkg: scratch(opt("cli-base-version", "0.87.0")), agentSide: "base" },
  };
}

async function cliStart(pkg, agentSide, flags) {
  const pj = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  const bin = typeof pj.bin === "string" ? pj.bin : pj.bin.pi;
  const sessDir = join(WORK, "cli", "sessions");
  mkdirSync(sessDir, { recursive: true });
  const home = join(WORK, "cli", "home");
  mkdirSync(home, { recursive: true });
  const argv = ["--mode", "rpc", "--model", `${MOCK_PROVIDER}/${MOCK_MODEL}`, ...(flags === "rpc-runner" ? ["--no-extensions"] : []), "--session-dir", sessDir];
  const t0 = now();
  const child = spawn(NODE, [join(pkg, bin), ...argv], {
    cwd: join(WORK, "cwd", "synth"),
    env: { ...process.env, PATH: [BIN, dirname(NODE), process.env.PATH].join(":"), HOME: home, PI_CODING_AGENT_DIR: join(WORK, agentSide, "cli-agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errText = "";
  child.stderr.on("data", (b) => (errText += b));
  child.stdin.write(`${JSON.stringify({ id: "perf-1", type: "get_state" })}\n`);
  const exited = new Promise((ok) => child.once("exit", ok));
  const got = await Promise.race([
    new Promise((ok) => {
      createInterface({ input: child.stdout }).on("line", (l) => {
        try {
          const m = JSON.parse(l);
          if (m.id === "perf-1") ok({ ms: now() - t0, success: m.success });
        } catch {}
      });
    }),
    exited.then((code) => ({ error: `exited ${code}: ${errText.slice(-300)}` })),
    sleep(60_000).then(() => ({ error: "no get_state answer in 60 s" })),
  ]);
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(5000).then(() => child.kill("SIGKILL"))]);
  return got;
}

async function cliRound() {
  const v = cliVariants();
  const before = machine();
  const errors = [];
  const order = round % 2 ? ["after", "base"] : ["base", "after"];
  for (const flags of ["rpc-runner", "rpc-ext"]) {
    for (const s of order) {
      side = s;
      const r = await cliStart(v[s].pkg, v[s].agentSide, flags);
      if (r.ms != null) sample(`cli.${flags}`, r.ms, { success: r.success });
      else errors.push(`${s} ${flags}: ${r.error}`);
    }
  }
  // The control: the same 0.87.0 from the global install (base) and from a scratch prefix (after).
  for (const s of order) {
    side = s;
    const r = s === "base" ? await cliStart(v.base.pkg, "base", "rpc-runner") : await cliStart(v.layout.pkg, "base", "rpc-runner");
    if (r.ms != null) sample("cli.layout.rpc-runner", r.ms, { success: r.success });
    else errors.push(`layout ${s}: ${r.error}`);
  }
  appendFileSync(join(OUT, "runs.jsonl"), JSON.stringify({ round, phase: "cli", before, after: machine(), errors }) + "\n");
  if (errors.length) log(`  cli round ${round}: ${errors.join(" | ")}`);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

const ROUNDS = Number(opt("rounds", "8"));
const PHASES = opt("phases", "server,cli").split(",");
const MAX_LOAD = opt("max-load") ? Number(opt("max-load")) : null;

async function waitQuiet() {
  if (MAX_LOAD == null) return;
  const until = Date.now() + Number(opt("max-wait-min", "20")) * 60_000;
  while (loadavg()[0] > MAX_LOAD) {
    if (Date.now() > until) {
      log(`  load1 ${loadavg()[0].toFixed(1)} still above ${MAX_LOAD} after the wait: measuring anyway (recorded)`);
      return;
    }
    log(`  load1 ${loadavg()[0].toFixed(1)} > ${MAX_LOAD}: waiting`);
    await sleep(30_000);
  }
}

const mock = startMock();
await mock.ready;
const cleanup = () => {
  try {
    mock.child.kill();
  } catch {}
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

const metaFile = join(OUT, "meta.json");
const meta = {
  startedAt: new Date().toISOString(),
  base: { tree: shown(TREE.base), label: opt("label-base", null), pi: piVersion(TREE.base) },
  after: { tree: shown(TREE.after), label: opt("label-after", null), pi: piVersion(TREE.after) },
  cli: Object.fromEntries(Object.entries(cliVariants()).map(([k, v]) => [k, { pkg: shown(v.pkg), version: existsSync(join(v.pkg, "package.json")) ? JSON.parse(readFileSync(join(v.pkg, "package.json"), "utf8")).version : null }])),
  rounds: ROUNDS,
  phases: PHASES,
  options: { turns: Number(opt("turns", "5")), steers: Number(opt("steers", "3")), chunks: Number(opt("chunks", "8")), gapMs: Number(opt("gap", "15")) },
  machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGb: Math.round(totalmem() / 2 ** 30), kernel: release(), node: process.version, bun: execFileSync(BUN, ["--version"], { encoding: "utf8" }).trim() },
  sessions: Object.fromEntries(Object.entries(manifest.roles).filter(([r]) => !r.startsWith("mem-")).map(([r, v]) => [r, { entries: v.entries, bytes: v.bytes }])),
  listed: manifest.list.length + Object.keys(manifest.roles).length,
};
writeFileSync(metaFile, JSON.stringify(meta, null, 1));
log(`perf-pi: base ${meta.base.tree} (pi ${meta.base.pi}) vs after ${meta.after.tree} (pi ${meta.after.pi}), ${ROUNDS} rounds, phases ${PHASES.join(",")}; out ${shown(OUT)}`);

try {
  await warmUp();
  for (round = 1; round <= ROUNDS; round++) {
    await waitQuiet();
    if (PHASES.includes("server")) {
      for (const s of round % 2 ? ["base", "after"] : ["after", "base"]) {
        side = s;
        await serverRun();
      }
    }
    if (PHASES.includes("cli")) await cliRound();
  }
} finally {
  cleanup();
  meta.endedAt = new Date().toISOString();
  writeFileSync(metaFile, JSON.stringify(meta, null, 1));
}
process.stdout.write(summarize(OUT));
