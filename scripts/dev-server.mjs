#!/usr/bin/env node
// dev-server: tsx watch, on the runtime the launcher would pick.
//
// Restarts the server on watched-file changes like `tsx watch`, after a short debounce. Nothing
// holds it: every chat, worker and team member runs in a process of its own and keeps running
// through a restart (see AGENTS.md "Live server restart" and agents/server/overview.md "Dev watcher").
//
//   node scripts/dev-server.mjs            # pnpm run dev:server
//   r                                      # restart now
//
// Watches: server/, shared/, pi-config/extensions/mode/ (the server's import graph).
// Ignores: *.test.ts, dotfiles.
//
// Runtime: Bun, or Node with SOVA_RUNTIME=node, decided per (re)start exactly as
// scripts/start-server.sh decides (server/runtime-choice.ts). Bun missing: the watcher exits 1.

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";
import { launch } from "../server/runtime-choice.ts";

const ROOT = join(import.meta.dirname, "..");
const WATCH_DIRS = ["server", "shared", join("pi-config", "extensions", "mode")];
const DEBOUNCE_MS = 300;
const TERM_GRACE_MS = 8000;

let child = null;
let restarting = false; // WE asked the child to exit (planned restart)
let pending = false; // changes came while the child was cycling
let pendingFiles = new Set();
let shuttingDown = false;

function start() {
  const runtime = launch();
  if (runtime.runtime === "error") {
    console.error(`[dev-server] ${runtime.error}`);
    process.exit(1);
  }
  // Under Bun this watcher's own execPath is bun, which cannot take node's --import.
  const [cmd, args] = runtime.runtime === "bun"
    ? [runtime.bun, ["server/index.ts"]]
    : [process.versions.bun ? "node" : process.execPath, ["--import", "tsx", "server/index.ts"]];
  child = spawn(cmd, args, {
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
      restart(); // more changes may have queued while we cycled
    } else {
      console.log(`\n[dev-server] server exited (code ${code}, ${signal}); restarting`);
      start();
    }
  });
}

function restart() {
  if (!pending || restarting || !child) return;
  pending = false;
  console.log(`\n[dev-server] restarting (${[...pendingFiles].join(", ")})`);
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
      pendingFiles.add(join(dir, f));
      restart();
    }, DEBOUNCE_MS);
  });
}

// `r`: restart now (interactive terminals only).
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (buf) => {
    if (buf.toString("utf8").trim().toLowerCase() === "r") {
      pending = true;
      pendingFiles.add("(r)");
      restart();
    }
  });
}

process.on("SIGINT", () => {
  shuttingDown = true;
  child?.kill("SIGINT");
});
process.on("SIGTERM", () => {
  shuttingDown = true;
  child?.kill("SIGTERM");
});

console.log("[dev-server] watching the server's import graph · r restarts now");
start();
