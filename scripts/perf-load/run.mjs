#!/usr/bin/env node
// run.mjs — one command: build a hermetic agent dir for a checkout, seed it, start the server,
// churn the list, probe the sidebar in an isolated headless browser, then report.
//
// Usage: node scripts/perf-load/run.mjs --tree <checkout> --port <n> [--rate 1] [--window 30]
//                                       [--sessions 480] [--live 360] [--open 6] [--big 2] [--skip-build] [--keep]
//
// The harness lives in THIS worktree; --tree may be any checkout (this worktree, or a baseline
// archive). Frontend assets come from <tree>/dist (built on demand with `pnpm run build`); the
// server is <tree>'s own. Everything is written under <tree>/.agent and ports 4840-4859 only.
//
// Exit code: 1 when the probe FAILs, else 0.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const has = (name) => process.argv.includes(`--${name}`);
const tree = args.get("tree") && resolve(args.get("tree"));
if (!tree) {
  console.error("usage: run.mjs --tree <checkout> --port <n> [--rate N] [--window N]");
  process.exit(2);
}
const here = import.meta.dirname;
const skills = resolve(here, "..", "..", ".claude", "skills", "playwright", "scripts");
const agentDir = join(tree, ".agent");
const rate = args.get("rate") ?? "1";
const windowSec = args.get("window") ?? "30";
const sessions = args.get("sessions") ?? "480";
const live = args.get("live") ?? "360";
const openCount = args.get("open") ?? "6";
const bigCount = args.get("big") ?? "2";
const skipBuild = has("skip-build");
const keep = has("keep");
const log = (msg) => console.error(`[run] ${msg}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is this port free to bind on 127.0.0.1? */
function portFree(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(false));
    s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });
}

async function pickPort() {
  const wanted = args.get("port") ? Number(args.get("port")) : null;
  if (wanted !== null) {
    if (wanted < 4840 || wanted > 4859) {
      console.error("[run] --port must be in 4840-4859");
      process.exit(2);
    }
    return wanted;
  }
  for (let p = 4840; p <= 4859; p++) if (await portFree(p)) return p;
  console.error("[run] no free port in 4840-4859");
  process.exit(1);
}

/** Spawn, streaming to a log file, returning the child. */
function spawnLogged(cmd, argv, opts, logFile) {
  const out = logFile ? openSync(logFile, "a") : "ignore";
  return spawn(cmd, argv, { ...opts, stdio: ["ignore", out, out] });
}

async function waitFor(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function stop(child, name) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null) return;
    await sleep(250);
  }
  log(`${name} did not exit; SIGKILL`);
  child.kill("SIGKILL");
}

let server = null;
let churn = null;
const cleanup = () => {
  void stop(churn, "churn");
  void stop(server, "server");
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

try {
  if (!existsSync(tree)) throw new Error(`no such tree: ${tree}`);
  const port = await pickPort();
  const base = `http://127.0.0.1:${port}`;
  mkdirSync(agentDir, { recursive: true });
  const serverLog = join(agentDir, "perf-load-server.log");
  writeFileSync(serverLog, "");

  log(`tree=${tree} port=${port}`);
  log("building hermetic agent dir");
  const hermetic = await new Promise((res) => {
    const p = spawn(process.execPath, [join(tree, "scripts", "hermetic-agent-dir.mjs")], { cwd: tree, stdio: "inherit" });
    p.on("close", res);
  });
  if (hermetic !== 0) throw new Error("hermetic-agent-dir.mjs failed");

  log(`seeding ${sessions} sessions`);
  const seeded = await new Promise((res) => {
    const p = spawn(process.execPath, [join(here, "seed.mjs"), "--agent-dir", agentDir, "--sessions", String(sessions), "--big", String(bigCount)], { stdio: "inherit" });
    p.on("close", res);
  });
  if (seeded !== 0) throw new Error("seed.mjs failed");
  // The two long sessions the probe switches between (none with --big 0: no switch check).
  const big = JSON.parse(readFileSync(join(agentDir, "perf-load-seed.json"), "utf8")).big ?? [];
  const switchArgs = big.length >= 2 ? ["--switch", `${big[0].path},${big[1].path}`] : [];

  if (!skipBuild && !existsSync(join(tree, "dist", "index.html"))) {
    log("building frontend (pnpm run build)");
    const built = await new Promise((res) => {
      const p = spawn("pnpm", ["run", "build"], { cwd: tree, stdio: "inherit" });
      p.on("close", res);
    });
    if (built !== 0) throw new Error("pnpm run build failed");
  }

  log("starting server");
  server = spawnLogged(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: tree,
    env: { ...process.env, PORT: String(port), PI_CODING_AGENT_DIR: agentDir, SOVA_PRICES_FETCH: "off", SOVA_USAGE_POLL: "off" },
  }, serverLog);

  await waitFor(async () => {
    try {
      const r = await fetch(`${base}/api/health`);
      return r.ok;
    } catch {
      return false;
    }
  }, 60_000, "server /api/health");
  log("server healthy");

  log("starting churn");
  churn = spawnLogged(process.execPath, [join(here, "churn.mjs"), "--agent-dir", agentDir, "--rate", String(rate), "--live", String(live)], {}, null);

  log(`probing (${windowSec}s window)`);
  const probeCode = await new Promise((res) => {
    const p = spawn(process.execPath, [join(here, "probe.mjs"), "--url", base, "--window", String(windowSec), "--open", String(openCount), ...switchArgs, "--skills", skills], { stdio: "inherit" });
    p.on("close", res);
  });

  if (!keep) {
    await stop(churn, "churn");
    await stop(server, "server");
    if (existsSync(serverLog)) log(`server log: ${serverLog}`);
  } else {
    log(`--keep: server (pid ${server.pid}) and churn (pid ${churn.pid}) left running on ${base}`);
  }
  process.exit(probeCode === 0 ? 0 : 1);
} catch (err) {
  console.error(`[run] ${err instanceof Error ? err.message : String(err)}`);
  await stop(churn, "churn");
  await stop(server, "server");
  process.exit(1);
}
