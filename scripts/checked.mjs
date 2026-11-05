#!/usr/bin/env node
// checked: run an output-free check (one that prints nothing when it passes: `tsc --noEmit`) once per
// identical code. Builtins only.
//
//   node scripts/checked.mjs [--report] [--fresh] -- <command> [args...]
//
// It keys the command by this checkout's tree fingerprint (scripts/test-cache.mjs: every file on disk,
// committed or not, spec claims and the manifest aside), the command line, Node's version, the platform
// and the installed packages (the TypeScript version is in the lockfile, which is in the tree). When
// the same command already passed on that key it prints one line and exits 0 without running it;
// otherwise it runs it with this process's stdio and, when it exits 0 and the tree didn't change while
// it ran, records the pass in the test-results store (<git common dir>/sova-test-results/v1).
// --report: on a reuse, also write `{"skipped": "already passed on identical code at 14:02 (…)"}` to
// $SOVA_OUT (a merge check's report file), so the check reads as skipped with that detail; without it
// (Build's first step, whose report belongs to the whole Build check) nothing is written.
// --fresh or SOVA_FRESH=1: always run (and still record a pass). Started from inside a test
// (SOVA_TEST_HOME or SOVA_TEST_RUNNER_PID set), outside a git checkout or with no node_modules, it
// only runs the command. Exit code and terminating signal are passed through.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { contextHash, hitWording, lookup, newRunId, packagesHash, prune, record, reuseRefusal, runBy, storeDir, treeFingerprint } from "./test-cache.mjs";

const ROOT = path.join(import.meta.dirname, "..");

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep < 0 ? [] : argv.slice(0, sep);
const command = sep < 0 ? argv : argv.slice(sep + 1);
const unknown = own.filter((a) => a !== "--report" && a !== "--fresh");
if (!command.length || unknown.length) {
  console.error("usage: node scripts/checked.mjs [--report] [--fresh] -- <command> [args...]");
  process.exit(2);
}
const report = own.includes("--report");
const fresh = own.includes("--fresh") || process.env.SOVA_FRESH === "1";

/** The key's parts, or null when this run may neither reuse nor record. */
function keyOf() {
  if (reuseRefusal({ env: process.env, runtime: "bun", root: ROOT })) return null;
  const store = storeDir(ROOT);
  const packages = packagesHash(ROOT);
  if (!store || !packages) return null;
  const tree = treeFingerprint(ROOT).hash;
  const rel = path.relative(ROOT, process.cwd()) || ".";
  const context = contextHash({
    tier: "checked",
    flags: [rel, ...command],
    tools: { node: process.version, platform: process.platform, arch: process.arch },
    packages,
  });
  return { store, tree, context, file: `checked: ${command.join(" ")}` };
}

let key = null;
try {
  key = keyOf();
} catch {
  key = null; // the store is only speed: any trouble reading it means just run
}

if (key && !fresh) {
  const { hits } = lookup({ store: key.store, context: key.context, tree: key.tree, files: [key.file] });
  const hit = hits.get(key.file);
  if (hit) {
    const words = hitWording(hit);
    console.log(`${command.join(" ")}: ${words} and wasn't run again (--fresh runs it)`);
    if (report && process.env.SOVA_OUT) {
      try {
        fs.writeFileSync(process.env.SOVA_OUT, JSON.stringify({ skipped: words }));
      } catch {}
    }
    process.exit(0);
  }
}

const started = Date.now();
const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
const forward = (sig) => () => child.kill(sig);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, forward(sig));
child.on("error", (e) => {
  console.error(`checked: ${command[0]}: ${e.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (code === 0 && key) {
    try {
      if (treeFingerprint(ROOT).hash === key.tree) {
        record({ store: key.store, context: key.context, tree: key.tree, runId: newRunId(), by: runBy(ROOT), files: { [key.file]: { pass: 1, skip: 0, ms: Date.now() - started } } });
      }
      prune({ store: key.store });
    } catch {}
  }
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
