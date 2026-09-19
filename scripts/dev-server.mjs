#!/usr/bin/env node
// dev-server: tsx watch, gated on live subagents.
//
// Restarts the server on watched-file changes like `tsx watch`, but HOLDS the restart while
// any hosted session has subagents working or a turn in flight (read from the sessions
// extension's live records for this server's pid). A restart kills spawned workers and wipes
// the in-memory subagent registry (see CLAUDE.md "Dev-server restart pitfall"); this gate
// makes that opt-in again: press `r` (or SIGUSR2) to force.
//
//   node scripts/dev-server.mjs            # npm run dev:server
//   r                                      # force a pending restart now
//   kill -USR2 <watcher pid>               # same, for agents
//
// Watches: server/, shared/, pi-config/extensions/mode/ (the server's import graph).
// Ignores: *.test.ts, dotfiles. Live-record contract: pi-config/extensions/sessions SCHEMA.md.

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";

const ROOT = join(import.meta.dirname, "..");
const WATCH_DIRS = ["server", "shared", join("pi-config", "extensions", "mode")];
const DEBOUNCE_MS = 300;
const BUSY_POLL_MS = 1000;
const HEARTBEAT_FRESH_MS = 30_000;
const TERM_GRACE_MS = 8000;

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const liveDir = join(agentDir, "sessions", "live");

/** Names of live workers shown while a restart is held ("ag_08, ag_09"). */
function busyReasons(pid) {
  let names = [];
  let working = 0;
  let activity = false;
  let stale = false;
  try {
    const now = Date.now();
    for (const name of readdirSync(liveDir)) {
      if (!name.startsWith(`p${pid}-`) || !name.endsWith(".json")) continue;
      let rec;
      try {
        rec = JSON.parse(readFileSync(join(liveDir, name), "utf8"));
      } catch {
        continue; // mid-write
      }
      const beat = typeof rec?.heartbeat === "number" ? rec.heartbeat : 0;
      if (now - beat > HEARTBEAT_FRESH_MS) {
        stale = true;
        continue;
      }
      const wc = rec?.presence?.workerCounts;
      if (typeof wc?.working === "number") {
        working += wc.working;
        for (const w of rec?.presence?.workers ?? [])
          if (typeof w?.name === "string" && !["waiting", "done", "error", "killed"].includes(w.status)) names.push(w.name);
      }
      if (rec?.presence?.activity?.state === "working") activity = true;
    }
  } catch {
    return { busy: false, detail: "live dir unreadable", names: [], working: 0 };
  }
  const busy = working > 0 || activity;
  const bits = [];
  if (working > 0) bits.push(`${working} working${names.length ? ` (${names.join(", ")})` : ""}`);
  if (activity) bits.push("turn in flight");
  if (stale && !busy) bits.push("(stale records ignored)");
  return { busy, detail: bits.join(" · ") || "idle", names, working };
}

let child = null;
let restarting = false; // WE asked the child to exit (planned restart)
let pending = false; // a restart is queued behind busy workers
let pendingFiles = new Set();
let announced = false;
let shuttingDown = false;

function start() {
  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    child = null;
    if (shuttingDown) process.exit(0);
    if (restarting) {
      restarting = false;
      start();
      tryRestart(); // more changes may have queued while we cycled
    } else {
      console.log(`\n[dev-server] server exited (code ${code}, ${signal}); restarting`);
      start();
    }
  });
}

function tryRestart() {
  if (!pending || restarting || !child) return;
  const { busy, detail } = busyReasons(child.pid);
  if (busy) {
    if (!announced) {
      announced = true;
      console.log(`\n⏸ [dev-server] restart pending (${pendingFiles.size} file${pendingFiles.size === 1 ? "" : "s"}) — ${detail} · r=force`);
    }
    setTimeout(tryRestart, BUSY_POLL_MS).unref?.();
    return;
  }
  announced = false;
  pending = false;
  console.log(`\n[dev-server] restarting (${[...pendingFiles].map((f) => relative(ROOT, f)).join(", ")})`);
  pendingFiles = new Set();
  restarting = true;
  child.kill("SIGTERM");
  setTimeout(() => child?.kill("SIGKILL"), TERM_GRACE_MS).unref?.();
}

let timer = null;
for (const dir of WATCH_DIRS) {
  watch(join(ROOT, dir), { recursive: true }, (_event, filename) => {
    const f = String(filename ?? "");
    const base = f.split("/").pop() ?? "";
    if (base.startsWith(".") || base.endsWith(".test.ts")) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      pending = true;
      pendingFiles.add(join(ROOT, dir, f));
      tryRestart();
    }, DEBOUNCE_MS);
  });
}

// Force key (interactive terminals only).
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const rl = createInterface({ input: process.stdin, terminal: true });
  rl.on("line", () => {});
  process.stdin.on("data", (buf) => {
    if (buf.toString("utf8").trim().toLowerCase() === "r") {
      console.log("\n[dev-server] forced restart");
      announced = false;
      pending = true;
      restarting = true;
      pendingFiles = new Set(["(forced)"]);
      child?.kill("SIGTERM");
      setTimeout(() => child?.kill("SIGKILL"), TERM_GRACE_MS).unref?.();
    }
  });
}
process.on("SIGUSR2", () => {
  console.log("\n[dev-server] forced restart (SIGUSR2)");
  announced = false;
  pending = true;
  restarting = true;
  pendingFiles = new Set(["(forced)"]);
  child?.kill("SIGTERM");
  setTimeout(() => child?.kill("SIGKILL"), TERM_GRACE_MS).unref?.();
});

process.on("SIGINT", () => {
  shuttingDown = true;
  child?.kill("SIGINT");
});
process.on("SIGTERM", () => {
  shuttingDown = true;
  child?.kill("SIGTERM");
});

console.log("[dev-server] gated watcher: restarts hold while subagents work · r or SIGUSR2 forces");
start();
