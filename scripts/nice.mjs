#!/usr/bin/env node
// nice: run a command at lower CPU priority, portably (package.json's test, typecheck and build).
//
//   node scripts/nice.mjs <command> [args...]
//
// It lowers its own niceness to 10 ($SOVA_SCRIPT_NICE: 0..19, 0 = unchanged) and runs the command,
// which inherits it, so a suite or build that fills every core waits behind the Sova server and
// the browser instead of starving them (docs/perf/2026-10-03-load-and-freezes.md). Where priority
// can't be lowered (Windows, or not permitted) the command runs unchanged. The exit code and a
// terminating signal are passed through. Builtins only.

import { spawn } from "node:child_process";
import { getPriority, setPriority } from "node:os";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/nice.mjs <command> [args...]");
  process.exit(2);
}

const raw = process.env.SOVA_SCRIPT_NICE?.trim();
const wanted = raw ? Number(raw) : 10;
const nice = Number.isInteger(wanted) && wanted >= 0 && wanted <= 19 ? wanted : 10;
if (nice && process.platform !== "win32") {
  try {
    if (getPriority() < nice) setPriority(nice);
  } catch {
    // not permitted: run unchanged
  }
}

// Windows resolves .cmd shims (tsc, vite, tsx in node_modules/.bin) only through a shell.
const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("error", (e) => {
  console.error(`nice.mjs: ${command}: ${e.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
