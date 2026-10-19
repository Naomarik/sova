#!/usr/bin/env bun
// perf-events: the performance gate of Sova's event stream (§app/events). Run with Bun from a
// checkout; it starts its own servers on the ports it is given and never touches ~/.pi.
//
//   bun scripts/perf-events.mjs idle --baseline <tree> --candidate <tree> [--port 4870] [--seconds 300]
//        [--warmup 30] [--rounds 2] [--sessions 480]
//     Per round, the baseline then the candidate: a fresh hermetic agent dir in <tree>/.agent
//     (scripts/hermetic-agent-dir.mjs) seeded with --sessions sessions (scripts/perf-load/seed.mjs),
//     the tree's server on Bun with no subscriber and no browser, --warmup s to settle, then
//     --seconds of sampling the server process's CPU time (/proc/<pid>/stat utime+stime) and RSS
//     (/proc/<pid>/status VmRSS) every 5 s. Then, on the candidate only: 60 s each with one
//     /ws/watch?feed=sessions socket, and with one /ws/events socket (CPU-seconds). Prints JSON; PASS
//     when the candidate's median CPU-seconds and mean RSS are within ±5 % of the baseline's.
//
//   bun scripts/perf-events.mjs reads --tree <tree> [--seconds 60] [--sessions 480]
//     In-process, with the tree's own modules wired as server/index.ts wires them: the real
//     listSessions over a seeded agent dir, the real SessionFeed and the event hub, a counter on the
//     feed's list function. --seconds each: (a) one feed client, (b) one events subscriber, (c) both.
//     PASS when (b) ≤ (a) and (c) ≤ (a) + 1.
//
//   bun scripts/perf-events.mjs latency --tree <tree> [--port 4871] [--turns 40]
//     The tree's server with a local stand-in model (server/stream-stub.ts) in a throwaway agent
//     dir: --turns turns on one hosted chat; per turn, the time from the chat socket's
//     agent_start / agent_settled frame to turn.started / turn.ended on /ws/events, on this
//     process's clock. PASS when the p95 of both is ≤ 500 ms.
//
// Exit 0 on PASS, 1 on FAIL, 2 on a usage or setup problem.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [mode, ...rest] = process.argv.slice(2);
const args = new Map();
for (let i = 0; i < rest.length; i += 2) args.set(rest[i].replace(/^--/, ""), rest[i + 1]);
const num = (k, d) => Number(args.get(k) ?? d);
const here = resolve(import.meta.dir ?? new URL(".", import.meta.url).pathname);
const log = (...a) => console.error("[perf-events]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICK = 100; // CLK_TCK on Linux

function run(cmd, argv, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "inherit", "inherit"], ...opts });
    p.on("close", (c) => (c === 0 ? res() : rej(new Error(`${cmd} ${argv.join(" ")} exited ${c}`))));
  });
}

function cpuSeconds(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (Number(f[11]) + Number(f[12])) / TICK; // utime, stime (fields 14, 15)
}
function rssMb(pid) {
  const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
  return m ? Number(m[1]) / 1024 : NaN;
}

async function waitHealthy(base, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error(`${base} never became healthy`);
}

async function startServer(tree, agentDir, port, extraEnv = {}) {
  // Another server on this port would answer the health check and be measured instead.
  const busy = await fetch(`http://127.0.0.1:${port}/api/health`).then(() => true, () => false);
  if (busy) throw new Error(`port ${port} is already in use`);
  const logFile = join(agentDir, "perf-events-server.log");
  const out = (await import("node:fs")).openSync(logFile, "w");
  const p = spawn(process.env.SOVA_BUN || "bun", ["server/index.ts"], {
    cwd: tree,
    env: { ...process.env, PORT: String(port), PI_CODING_AGENT_DIR: agentDir, SOVA_PRICES_FETCH: "off", SOVA_USAGE_POLL: "off", ...extraEnv },
    stdio: ["ignore", out, out],
  });
  const base = `http://127.0.0.1:${port}`;
  await waitHealthy(base);
  return {
    pid: p.pid,
    base,
    token: () => readFileSync(join(agentDir, "sova", "auth-token"), "utf8").trim(),
    stop: () =>
      new Promise((r) => {
        p.once("close", r);
        p.kill("SIGTERM");
        setTimeout(() => p.kill("SIGKILL"), 10_000).unref();
      }),
  };
}

async function prepareAgent(tree, sessions) {
  const agentDir = join(tree, ".agent");
  await run("node", [join(tree, "scripts", "hermetic-agent-dir.mjs")], { cwd: tree });
  await run("node", [join(here, "perf-load", "seed.mjs"), "--agent-dir", agentDir, "--sessions", String(sessions), "--big", "0"]);
  return agentDir;
}

async function socket(url, token) {
  const { WebSocket } = await import("ws");
  const ws = new WebSocket(url, { headers: { "x-sova-token": token } });
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  return ws;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)];

async function idle() {
  const trees = { baseline: resolve(args.get("baseline") ?? ""), candidate: resolve(args.get("candidate") ?? "") };
  for (const t of Object.values(trees)) if (!existsSync(join(t, "server", "index.ts"))) throw Object.assign(new Error(`not a checkout: ${t}`), { usage: true });
  const port = num("port", 4870);
  const seconds = num("seconds", 300);
  const warmup = num("warmup", 30);
  const rounds = num("rounds", 2);
  const sessions = num("sessions", 480);
  const results = { baseline: [], candidate: [] };
  for (let r = 0; r < rounds; r++) {
    for (const which of ["baseline", "candidate"]) {
      const tree = trees[which];
      const agentDir = await prepareAgent(tree, sessions);
      const s = await startServer(tree, agentDir, port);
      log(`${which} round ${r + 1}: pid ${s.pid}, warming ${warmup} s`);
      await sleep(warmup * 1000);
      const c0 = cpuSeconds(s.pid);
      const rss = [];
      for (let t = 0; t < seconds; t += 5) {
        await sleep(5000);
        rss.push(rssMb(s.pid));
      }
      const cpu = cpuSeconds(s.pid) - c0;
      const one = { cpuSeconds: Number(cpu.toFixed(2)), rssMeanMb: Number(mean(rss).toFixed(1)), rssMaxMb: Number(Math.max(...rss).toFixed(1)) };
      log(which, JSON.stringify(one));
      results[which].push(one);
      if (which === "candidate" && r === rounds - 1) {
        const token = s.token();
        const measure = async (label, open) => {
          const ws = open ? await socket(`ws://127.0.0.1:${port}${open}`, token) : null;
          await sleep(5000);
          const a = cpuSeconds(s.pid);
          await sleep(60_000);
          const cpu60 = cpuSeconds(s.pid) - a;
          ws?.close();
          await sleep(open === "/ws/events" ? 35_000 : 2000); // the hub's linger
          return { [label]: Number(cpu60.toFixed(2)) };
        };
        results.withSubscriber = { ...(await measure("none", null)), ...(await measure("feed", "/ws/watch?feed=sessions")), ...(await measure("events", "/ws/events")) };
        log("cpu-seconds per minute", JSON.stringify(results.withSubscriber));
      }
      await s.stop();
    }
  }
  const b = { cpu: median(results.baseline.map((x) => x.cpuSeconds)), rss: median(results.baseline.map((x) => x.rssMeanMb)) };
  const c = { cpu: median(results.candidate.map((x) => x.cpuSeconds)), rss: median(results.candidate.map((x) => x.rssMeanMb)) };
  const within = (x, y) => Math.abs(x - y) <= 0.05 * y;
  const pass = within(c.cpu, b.cpu) && within(c.rss, b.rss);
  console.log(JSON.stringify({ mode: "idle", seconds, sessions, results, medians: { baseline: b, candidate: c }, deltaPct: { cpu: (100 * (c.cpu - b.cpu)) / b.cpu, rss: (100 * (c.rss - b.rss)) / b.rss } }, null, 2));
  console.log(`RESULT: ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

async function reads() {
  const tree = resolve(args.get("tree") ?? process.cwd());
  const seconds = num("seconds", 60);
  const sessions = num("sessions", 480);
  const scratch = mkdtempSync(join(tmpdir(), "perf-events-reads-"));
  const agentDir = join(scratch, "agent");
  mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
  await run("node", [join(here, "perf-load", "seed.mjs"), "--agent-dir", agentDir, "--sessions", String(sessions), "--big", "0"]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { listSessions, idOf } = await import(join(tree, "server", "sessions-index.ts"));
  const { configureSessionFeed, sessionFeed } = await import(join(tree, "server", "session-feed.ts"));
  const { startEvents } = await import(join(tree, "server", "events.ts"));
  let count = 0;
  const hub = startEvents({ onChatEvent: () => () => {}, onAttention: () => () => {}, holdFeed: () => sessionFeed()?.add(() => {}) ?? null, isHosted: () => false, idOf }, { lingerMs: 0 });
  configureSessionFeed({ list: () => (count++, listSessions().then(hub.seeList)) });
  await listSessions(); // warm the index once, outside every phase
  const phase = async (label, on) => {
    const before = count;
    const off = on();
    await sleep(seconds * 1000);
    off();
    await sleep(500);
    const n = count - before;
    log(label, n, "reads");
    return n;
  };
  const feedOnly = await phase("feed", () => sessionFeed().add(() => {}));
  const eventsOnly = await phase("events", () => {
    const r = hub.subscribe({ deliver: () => {} }, null);
    return r.leave;
  });
  const both = await phase("both", () => {
    const a = sessionFeed().add(() => {});
    const r = hub.subscribe({ deliver: () => {} }, null);
    return () => (a(), r.leave());
  });
  rmSync(scratch, { recursive: true, force: true });
  const perMin = (n) => Number(((n * 60) / seconds).toFixed(2));
  const pass = eventsOnly <= feedOnly && both <= feedOnly + 1;
  console.log(JSON.stringify({ mode: "reads", seconds, sessions, readsPerMinute: { feed: perMin(feedOnly), events: perMin(eventsOnly), both: perMin(both) }, raw: { feedOnly, eventsOnly, both } }, null, 2));
  console.log(`RESULT: ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

async function latency() {
  const tree = resolve(args.get("tree") ?? process.cwd());
  const port = num("port", 4871);
  const turns = num("turns", 40);
  const scratch = mkdtempSync(join(tmpdir(), "perf-events-lat-"));
  const agentDir = join(scratch, "agent");
  mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
  const { startStreamStub, stubModelsJson } = await import(join(tree, "server", "stream-stub.ts"));
  const stub = await startStreamStub({ payload: "letters", perDelta: 16, limit: 64, tool: "no_such_tool" });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(stubModelsJson(stub.port)));
  const cwd = join(scratch, "proj");
  mkdirSync(cwd);
  const dir = join(agentDir, "sessions", "--proj--");
  mkdirSync(dir);
  const id = "01a0dd00-0000-7000-8000-000000000301";
  const file = join(dir, `2026-10-18T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-18T00:00:00.000Z", cwd })}\n`);
  const s = await startServer(tree, agentDir, port);
  const token = s.token();
  const events = await socket(`ws://127.0.0.1:${port}/ws/events`, token);
  const evq = [];
  events.on("message", (d) => {
    const f = JSON.parse(String(d));
    if (f.type === "event" && f.path?.endsWith(`${id}.jsonl`)) evq.push({ name: f.name, t: performance.now() });
  });
  const chat = await socket(`ws://127.0.0.1:${port}/ws/chat?path=${encodeURIComponent(file)}&force=1`, token);
  const chq = [];
  chat.on("message", (d) => {
    const m = JSON.parse(String(d));
    chq.push({ type: m.type === "event" && m.event?.type ? m.event.type : m.type, t: performance.now() });
  });
  const take = async (q, pred, ms = 60_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = q.findIndex(pred);
      if (i >= 0) return q.splice(0, i + 1).at(-1);
      if (Date.now() > end) throw new Error("timed out");
      await sleep(5);
    }
  };
  await take(chq, (x) => x.type === "hello");
  chat.send(JSON.stringify({ type: "set_model", ref: "stub/runaway" }));
  await take(chq, (x) => x.type === "model");
  const start = [];
  const end = [];
  for (let i = 0; i < turns; i++) {
    stub.reset({ payload: "letters", perDelta: 16, limit: 64, tool: "no_such_tool" });
    chq.length = 0;
    chat.send(JSON.stringify({ type: "prompt", text: `turn ${i}`, clientId: `c${i}` }));
    const a = await take(chq, (x) => x.type === "agent_start");
    const ts = await take(evq, (x) => x.name === "turn.started");
    const b = await take(chq, (x) => x.type === "agent_settled");
    const te = await take(evq, (x) => x.name === "turn.ended");
    start.push(ts.t - a.t);
    end.push(te.t - b.t);
  }
  chat.close();
  events.close();
  await s.stop();
  await stub.close();
  rmSync(scratch, { recursive: true, force: true });
  const r = (xs) => ({ p50: Number(median(xs).toFixed(1)), p95: Number(p95(xs).toFixed(1)), max: Number(Math.max(...xs).toFixed(1)), min: Number(Math.min(...xs).toFixed(1)) });
  const out = { mode: "latency", turns, startMs: r(start), endMs: r(end) };
  const pass = out.startMs.p95 <= 500 && out.endMs.p95 <= 500;
  console.log(JSON.stringify(out, null, 2));
  console.log(`RESULT: ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

try {
  const fn = { idle, reads, latency }[mode];
  if (!fn) {
    console.error("usage: bun scripts/perf-events.mjs idle|reads|latency [options] (see the header)");
    process.exit(2);
  }
  const pass = await fn();
  process.exit(pass ? 0 : 1);
} catch (err) {
  console.error(`[perf-events] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
