#!/usr/bin/env node
// load-standin: stands in for a Sova worker running the CPU bursts seen in the freeze diagnosis
// (docs/perf/2026-10-03-load-and-freezes.md): full unit-tier test runs, `tsc --noEmit` and
// `vite build`, plus (2026-11-16) a disk-heavy worker, each restarted as soon as it exits, until
// SIGTERM or --max-secs.
//
//   node scripts/perf/load-standin.mjs [--mix test=2,tsc=2,vite=1,disk=1] [--max-secs 600] [--out <dir>]
//
// test: package.json's test command (scripts/run-tests.mjs, the unit tier on Bun at half the cores)
// minus its scripts/nice.mjs wrapper, with --fresh and a non-default --timeout so it neither reuses
// nor records passes (a reused file costs no CPU; the result store is shared by every worktree).
// disk: this script again as `--disk-worker <dir>`: writes 256 MB in 1 MB chunks with an fsync
// every 32 MB, reads it back, deletes it, then stats every entry under node_modules (a metadata
// walk, as `git status`, ripgrep or an install does), and loops.
//
// It runs the commands raw, never through package.json (whose scripts are niced), so the priority
// it runs at is only the one it was started with: lowered by whoever spawned it, inherited by every
// command below. Each command gets its own process group (as a worker's bash tool does) and is
// killed by group on exit. Builtins only.

import { spawn } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
// The disk worker: one pass, then exit (launch() restarts it).
if (args[0] === "--disk-worker") {
  const dir = resolve(args[1]);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "blob.bin");
  const chunk = Buffer.alloc(1024 * 1024, 0x5a);
  const fd = openSync(file, "w");
  for (let i = 1; i <= 256; i++) {
    chunk[0] = i & 0xff;
    writeSync(fd, chunk);
    if (i % 32 === 0) fsyncSync(fd);
  }
  closeSync(fd);
  const rfd = openSync(file, "r");
  while (readSync(rfd, chunk, 0, chunk.length, null) > 0);
  closeSync(rfd);
  rmSync(file, { force: true });
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const p = join(d, e.name);
      try {
        statSync(p);
      } catch {}
      if (e.isDirectory()) walk(p);
    }
  };
  walk(join(ROOT, "node_modules", ".pnpm"));
  process.exit(0);
}

const mix = Object.fromEntries(
  opt("mix", "test=2,tsc=2,vite=1")
    .split(",")
    .map((kv) => kv.split("="))
    .map(([k, v]) => [k, Number(v)]),
);
const maxSecs = Number(opt("max-secs", "600"));
const out = resolve(opt("out", join(ROOT, ".cache", "sova-perf", "standin")));
mkdirSync(out, { recursive: true });

// The test command as package.json has it, minus any priority wrapper in front of it: the runner
// (scripts/run-tests.mjs) since 2026-10, `tsx --test` before.
const testScript = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.test;
const testCmd = testScript.includes("run-tests.mjs")
  ? `${testScript.slice(testScript.indexOf("node scripts/run-tests.mjs"))} --fresh -- --timeout=60001`
  : testScript.slice(testScript.indexOf("tsx "));
const COMMANDS = {
  test: () => testCmd,
  tsc: () => "tsc --noEmit",
  vite: (n) => `vite build --logLevel silent --emptyOutDir --outDir ${JSON.stringify(join(out, `vite-${n}`))}`,
  disk: (n) => `${JSON.stringify(process.execPath)} ${JSON.stringify(import.meta.filename)} --disk-worker ${JSON.stringify(join(out, `disk-${n}`))}`,
};
for (const k of Object.keys(mix)) if (!COMMANDS[k]) throw new Error(`unknown mix entry: ${k}`);

const env = { ...process.env, PATH: [join(ROOT, "node_modules", ".bin"), process.env.PATH].join(delimiter) };
const live = new Set();
let stopping = false;
const runs = Object.fromEntries(Object.keys(mix).map((k) => [k, 0]));

function launch(kind, slot) {
  if (stopping) return;
  const child = spawn("sh", ["-c", COMMANDS[kind](slot)], { cwd: ROOT, env, stdio: "ignore", detached: true });
  live.add(child);
  runs[kind]++;
  child.on("exit", () => {
    live.delete(child);
    if (!stopping) setTimeout(() => launch(kind, slot), 200);
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of live) {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {}
  }
  process.stdout.write(`${JSON.stringify({ runs })}\n`);
  setTimeout(() => process.exit(code), 100);
}

process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
setTimeout(() => stop(0), maxSecs * 1000).unref();
// Never outlive whoever started us (the server, or the harness's scope).
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) stop(1);
}, 1000).unref();

let slot = 0;
for (const [kind, n] of Object.entries(mix)) for (let i = 0; i < n; i++) launch(kind, slot++);
// Keep the event loop alive while children run.
setInterval(() => {}, 60_000);
