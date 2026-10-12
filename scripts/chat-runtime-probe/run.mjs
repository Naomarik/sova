#!/usr/bin/env node
// chat-runtime-probe: what would one chat process cost (al_3 stage 2)? Each run starts host.ts, a
// standalone Bun process hosting one Sova chat through the server's own chat-manager, in a scratch
// agent dir built like dev:hermetic's (scripts/hermetic-agent-dir.mjs). It samples the process tree
// (RSS and PSS from /proc, children such as a claude CLI included) at every phase the host reports,
// and times spawn → ready from out here. Linux only; builtins only; nothing is written under ~/.pi.
//
//   node scripts/chat-runtime-probe/run.mjs prepare [--auth <auth.json>] [--long <session.jsonl>]...
//        build the scratch dir; copy auth and long sessions IN (copies: header cwd rewritten to the
//        scratch project, mtime backdated so the copy reads as nobody's recent write)
//   node scripts/chat-runtime-probe/run.mjs single [--reps 3] [--model zai/glm-5.3] [--prompts 3]
//   node scripts/chat-runtime-probe/run.mjs reopen [--reps 3]          every copied long session
//   node scripts/chat-runtime-probe/run.mjs inproc [--also 14] [--prompts 1]   the baseline: 1 + k
//        chats in ONE process, as the server holds them today
//   node scripts/chat-runtime-probe/run.mjs claude [--model claude-code-cli/<id>] [--prompts 2]
//   node scripts/chat-runtime-probe/run.mjs many --n 5 [--model zai/glm-5.3] [--prompts 1] [--settle 20]
//   node scripts/chat-runtime-probe/run.mjs survive [--slice sova-probe-test.slice]
//        the t8 supervision check on a stand-in unit (never sova-runtime.service), below
//
// --scratch <dir> (default ~/.cache/chat-runtime-probe) holds agent/, proj/ and results/; every
// command appends its raw samples to results/<command>-<time>.json and prints a summary.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(import.meta.dirname, "..", "..");
const HOST = join(import.meta.dirname, "host.ts");
const [cmd, ...args] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const opts = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
const SCRATCH = resolve(opt("scratch", join(homedir(), ".cache", "chat-runtime-probe")));
const AGENT = join(SCRATCH, "agent");
const PROJ = join(SCRATCH, "proj");
const LONG = join(SCRATCH, "long");
const RESULTS = join(SCRATCH, "results");
const HOME_PI = join(homedir(), ".pi");
if (AGENT === HOME_PI || AGENT.startsWith(HOME_PI + "/")) throw new Error(`refusing a scratch dir inside ~/.pi: ${SCRATCH}`);
const BUN = process.env.SOVA_BUN || "bun";
const MB = (b) => Math.round(b / 1048576);

// ── /proc ───────────────────────────────────────────────────────────────────────────────────────

const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const kb = (text, key) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? 0) * 1024;
/** pid and every descendant. */
function tree(pid) {
  const parent = new Map();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const stat = read(`/proc/${d}/stat`);
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (ppid) parent.set(Number(d), ppid);
  }
  const out = [pid];
  for (let i = 0; i < out.length; i++) for (const [c, p] of parent) if (p === out[i]) out.push(c);
  return out;
}
/** RSS and PSS of a process tree, with each member's command name. */
function sample(pid) {
  const members = tree(pid).map((p) => {
    const roll = read(`/proc/${p}/smaps_rollup`);
    return { pid: p, comm: read(`/proc/${p}/comm`).trim(), rss: kb(read(`/proc/${p}/status`), "VmRSS"), pss: kb(roll, "Pss") };
  });
  return { rss: members.reduce((s, m) => s + m.rss, 0), pss: members.reduce((s, m) => s + m.pss, 0), members };
}
const memAvailable = () => kb(read("/proc/meminfo"), "MemAvailable");

/** The host's environment: the scratch agent dir, and nothing a Claude Code session running this
    script passes down (its CLAUDE_CONFIG_DIR names a login dir the server's own chats never see). */
function hostEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
  return { ...env, PI_CODING_AGENT_DIR: AGENT, SOVA_PRICES_FETCH: "off" };
}

// ── one host ────────────────────────────────────────────────────────────────────────────────────

/** Start host.ts; resolves each phase with the host's own report plus a tree sample taken then. */
function startHost(hostArgs, { hold = false } = {}) {
  const t0 = performance.now();
  const child = spawn(BUN, [HOST, ...hostArgs, ...(hold ? ["--hold"] : [])], {
    cwd: ROOT,
    env: hostEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const phases = [];
  const waiters = [];
  let stderr = "";
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.startsWith("PROBE ")) continue;
      const rep = JSON.parse(line.slice(6));
      const s = sample(child.pid);
      phases.push({ ...rep, wallMs: Math.round(performance.now() - t0), treeRss: s.rss, treePss: s.pss, members: s.members.map((m) => `${m.comm}:${MB(m.rss)}`) });
      for (const w of waiters.splice(0)) w();
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  const phase = async (name, timeoutMs = 300000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const hit = phases.find((p) => p.phase === name);
      if (hit) return hit;
      if (child.exitCode !== null || Date.now() > end) throw new Error(`host ${child.pid}: no '${name}' phase (exit ${child.exitCode})\n${stderr.slice(-2000)}`);
      await Promise.race([new Promise((r) => waiters.push(r)), sleep(500)]);
    }
  };
  return { child, phases, phase, exited, stderr: () => stderr };
}

const results = [];
function save(name, data) {
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`raw: ${file}`);
}
const row = (p) => `${p.phase.padEnd(12)} wall ${String(p.wallMs).padStart(6)} ms  self rss ${String(MB(p.rss)).padStart(4)} MB  tree rss ${String(MB(p.treeRss)).padStart(4)} MB  pss ${String(MB(p.treePss)).padStart(4)} MB${p.runtimeMs !== undefined ? `  model runtime ${p.runtimeMs} ms` : ""}${p.openMs !== undefined ? `  open ${p.openMs} ms` : ""}${p.turnMs !== undefined ? `  turn ${p.turnMs} ms` : ""}${p.entries !== undefined ? `  entries ${p.entries}` : ""}${p.members.length > 1 ? `  [${p.members.join(" ")}]` : ""}`;

async function runOnce(label, hostArgs, idleSec = Number(opt("idle", "10"))) {
  const h = startHost(hostArgs, { hold: true });
  await h.phase("idle");
  // RSS a while after the last phase: what the chat sits at while nobody talks to it.
  await sleep(idleSec * 1000);
  const s = sample(h.child.pid);
  h.phases.push({ phase: `idle+${idleSec}s`, wallMs: null, rss: s.members[0]?.rss ?? 0, treeRss: s.rss, treePss: s.pss, members: s.members.map((m) => `${m.comm}:${MB(m.rss)}`) });
  h.child.kill("SIGTERM");
  await h.exited;
  console.log(`\n${label}`);
  for (const p of h.phases) console.log(`  ${row(p).replace("wall   null ms", "            ")}`);
  results.push({ label, hostArgs, phases: h.phases, stderrTail: h.stderr().slice(-1500) });
}

// ── commands ────────────────────────────────────────────────────────────────────────────────────

if (cmd === "prepare") {
  mkdirSync(PROJ, { recursive: true });
  mkdirSync(LONG, { recursive: true });
  execFileSync("node", [join(ROOT, "scripts", "hermetic-agent-dir.mjs"), "--copied-sessions"], { env: { ...process.env, HERMETIC_AGENT_DIR: AGENT }, stdio: "inherit" });
  const auth = opt("auth");
  if (auth) {
    copyFileSync(auth, join(AGENT, "auth.json"));
    console.log(`auth copied from ${auth}`);
  }
  for (const src of opts("long")) {
    // Into the scratch agent's sessions, under the scratch project: a copy, never the file itself.
    const dir = join(AGENT, "sessions", "--probe-long--");
    mkdirSync(dir, { recursive: true });
    const dst = join(dir, basename(src));
    const lines = readFileSync(src, "utf8").split("\n");
    const header = JSON.parse(lines[0]);
    header.cwd = PROJ;
    lines[0] = JSON.stringify(header);
    writeFileSync(dst, lines.join("\n"));
    const old = new Date(Date.now() - 3600_000);
    utimesSync(dst, old, old);
    writeFileSync(join(LONG, basename(src)), dst);
    console.log(`long session copied: ${dst} (${lines.length} lines)`);
  }
} else if (cmd === "single") {
  const reps = Number(opt("reps", "3"));
  const model = opt("model", "zai/glm-5.3");
  for (let i = 1; i <= reps; i++) await runOnce(`new chat, no turns (rep ${i})`, ["--new", PROJ]);
  for (let i = 1; i <= reps; i++) await runOnce(`new chat, ${opt("prompts", "3")} turns on ${model} (rep ${i})`, ["--new", PROJ, "--model", model, "--prompts", opt("prompts", "3")]);
  save("single", results);
} else if (cmd === "reopen") {
  const reps = Number(opt("reps", "3"));
  for (const f of existsSync(LONG) ? readdirSync(LONG) : []) {
    const path = readFileSync(join(LONG, f), "utf8");
    for (let i = 1; i <= reps; i++) await runOnce(`reopen ${f} (rep ${i})`, ["--session", path]);
  }
  save("reopen", results);
} else if (cmd === "inproc") {
  // The baseline: 1 + --also chats in ONE process, as the server holds them today.
  const also = opt("also", "14");
  await runOnce(`1 + ${also} chats in one process, ${opt("prompts", "1")} turn(s) each`, ["--new", PROJ, "--model", opt("model", "zai/glm-5.3"), "--prompts", opt("prompts", "1"), "--also", also], Number(opt("idle", "20")));
  save("inproc", results);
} else if (cmd === "claude") {
  const model = opt("model", "claude-code-cli/claude-haiku-5-5");
  await runOnce(`new chat, ${opt("prompts", "2")} turns on ${model}`, ["--new", PROJ, "--model", model, "--prompts", opt("prompts", "2")]);
  save("claude", results);
} else if (cmd === "many") {
  const n = Number(opt("n", "5"));
  const model = opt("model", "zai/glm-5.3");
  const settle = Number(opt("settle", "20"));
  await sleep(2000);
  const before = memAvailable();
  const t0 = performance.now();
  const hosts = Array.from({ length: n }, () => startHost(["--new", PROJ, "--model", model, "--prompts", opt("prompts", "1")], { hold: true }));
  const ready = await Promise.all(hosts.map((h) => h.phase("ready")));
  await Promise.all(hosts.map((h) => h.phase("idle")));
  const allIdleMs = Math.round(performance.now() - t0);
  await sleep(settle * 1000);
  const samples = hosts.map((h) => sample(h.child.pid));
  const after = memAvailable();
  const out = {
    n,
    model,
    readyWallMs: ready.map((p) => p.wallMs),
    allIdleMs,
    perProcessRssMB: samples.map((s) => MB(s.rss)),
    perProcessPssMB: samples.map((s) => MB(s.pss)),
    sumRssMB: MB(samples.reduce((a, s) => a + s.rss, 0)),
    sumPssMB: MB(samples.reduce((a, s) => a + s.pss, 0)),
    memAvailableDeltaMB: MB(before - after),
    turnErrors: hosts.flatMap((h) => h.phases.flatMap((p) => p.errors ?? [])),
  };
  for (const h of hosts) h.child.kill("SIGTERM");
  await Promise.all(hosts.map((h) => h.exited));
  out.memAvailableRecoveredMB = MB(memAvailable() - after);
  console.log(JSON.stringify(out, null, 2));
  results.push(out);
  save(`many-${n}`, results);
} else if (cmd === "survive") {
  await survive();
} else {
  console.error("usage: run.mjs prepare|single|reopen|claude|many|survive [options] (header comment)");
  process.exit(2);
}

// ── t8: does a chat process launched into its own slice survive its launcher's restart? ─────────
//
// A stand-in transient unit plays the server (sova-probe-standin-<pid>.service, Restart=always). Its
// script launches the probe host as `systemd-run --user --slice=<test slice> --collect
// --property=KillMode=mixed --property=TimeoutStopSec=30` (its own transient unit, outside the
// stand-in's cgroup; its output goes to the marker file, not the journal), then sleeps. We restart
// the stand-in and check the probe's pid is still alive, still in its own unit, and that the
// stand-in came back with a new pid; then stop the probe's unit
// and check the chat disposed on SIGTERM. Everything is stopped after. Needs the user bus: a Sova
// worker's sandbox has none, so run it from a plain shell.
async function survive() {
  const slice = opt("slice", "sova-probe-test.slice");
  const tag = `${process.pid}`;
  const standin = `sova-probe-standin-${tag}`;
  const probeUnit = `sova-probe-chat-${tag}`;
  const marker = join(SCRATCH, `survive-${tag}.txt`);
  const sh = join(SCRATCH, `standin-${tag}.sh`);
  mkdirSync(SCRATCH, { recursive: true });
  // The stand-in starts the probe only on its first run; later runs just record that they started.
  writeFileSync(
    sh,
    `#!/bin/sh
echo "standin start $$" >> '${marker}'
if ! systemctl --user is-active --quiet '${probeUnit}.service'; then
  systemd-run --user --slice='${slice}' --collect --property=KillMode=mixed --property=TimeoutStopSec=30 --unit='${probeUnit}' \\
    --setenv=PI_CODING_AGENT_DIR='${AGENT}' --setenv=SOVA_PRICES_FETCH=off --working-directory='${ROOT}' \\
    --property=StandardOutput=append:'${marker}' --property=StandardError=append:'${marker}' \\
    '${execFileSync("sh", ["-c", `command -v ${BUN}`], { encoding: "utf8" }).trim()}' '${HOST}' --new '${PROJ}' --hold >> '${marker}' 2>&1
fi
exec sleep infinity
`,
    { mode: 0o755 },
  );
  const sc = (...a) => execFileSync("systemctl", ["--user", ...a], { encoding: "utf8" }).trim();
  const show = (unit, prop) => sc("show", "-p", prop, "--value", unit);
  const log = [];
  const note = (s) => {
    log.push(s);
    console.log(s);
  };
  try {
    execFileSync("systemd-run", ["--user", `--unit=${standin}`, "--property=Restart=always", "--property=KillMode=control-group", "/bin/sh", sh], { stdio: "inherit" });
    let probePid = 0;
    for (let i = 0; i < 60 && !probePid; i++) {
      await sleep(1000);
      try {
        probePid = Number(show(`${probeUnit}.service`, "MainPID")) || 0;
      } catch {}
    }
    if (!probePid) throw new Error("probe unit never started");
    const standinPid1 = Number(show(`${standin}.service`, "MainPID"));
    note(`stand-in ${standin}.service pid ${standinPid1}, cgroup ${show(`${standin}.service`, "ControlGroup")}`);
    note(`probe ${probeUnit}.service pid ${probePid}, cgroup ${show(`${probeUnit}.service`, "ControlGroup")}, KillMode ${show(`${probeUnit}.service`, "KillMode")}`);
    // Wait for the chat to be open before the restart, so the restart hits a live chat.
    for (let i = 0; i < 60 && !read(marker).includes('"phase":"idle"'); i++) await sleep(1000);
    note(`probe chat open before restart: ${read(marker).includes('"phase":"idle"')}`);
    sc("restart", `${standin}.service`);
    await sleep(3000);
    const standinPid2 = Number(show(`${standin}.service`, "MainPID"));
    const alive = existsSync(`/proc/${probePid}`);
    const cgroupNow = read(`/proc/${probePid}/cgroup`).trim();
    note(`after stand-in restart: stand-in pid ${standinPid2} (${standinPid2 !== standinPid1 ? "restarted" : "SAME"}), probe pid ${probePid} alive: ${alive}, cgroup ${cgroupNow}`);
    note(`probe unit state: ${show(`${probeUnit}.service`, "ActiveState")}; stand-in starts recorded: ${(read(marker).match(/standin start/g) ?? []).length}`);
    // And the other direction: stopping the probe's own unit (KillMode=mixed) ends the chat cleanly.
    sc("stop", `${probeUnit}.service`);
    await sleep(1000);
    note(`after stopping the probe unit: probe pid alive: ${existsSync(`/proc/${probePid}`)}; chat disposed on SIGTERM: ${read(marker).includes("disposed-on-sigterm")}`);
    save("survive", { slice, standin, probeUnit, log, marker: read(marker) });
  } finally {
    for (const u of [`${standin}.service`, `${probeUnit}.service`]) {
      try {
        sc("stop", u);
      } catch {}
    }
  }
}
